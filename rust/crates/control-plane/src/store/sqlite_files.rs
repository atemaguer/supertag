//! Keeps a SQLite database and its WAL and shared-memory files private to their owner.
//!
//! The database holds Task prompts, results, and coordination history. SQLite creates a missing
//! file with the process umask and gives `-wal` and `-shm` files the database file's permissions,
//! so the Control Plane creates the database owner-only before SQLite opens it, and removes group
//! and other access from an existing database and any live WAL and shared-memory files. A path
//! through a symbolic link changes the files SQLite actually uses, which sit beside the target; a
//! link whose target is missing gets its target created owner-only.
//!
//! SQLite serves one Control Plane process. An exclusive lock on a private `.lock` file beside the
//! database refuses a second process; Store handles within one process share that lock.

use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions, TryLockError},
    io::ErrorKind,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    str::FromStr,
    sync::{Arc, LazyLock, Mutex, PoisonError, Weak},
};

use anyhow::{Context, Result, bail};
use sqlx::sqlite::SqliteConnectOptions;

/// The database file a SQLite URL opens, or `None` for an in-memory database.
fn database_file(url: &str) -> Result<Option<(PathBuf, bool)>> {
    let options = SqliteConnectOptions::from_str(url).context("invalid SQLite database URL")?;
    let path = options.get_filename();
    let query = url.split_once('?').map_or("", |(_, query)| query);
    let parameters = url::form_urlencoded::parse(query.as_bytes()).collect::<Vec<_>>();
    let location = url.strip_prefix("sqlite:").unwrap_or(url);
    let memory = location.trim_start_matches('/').starts_with(":memory:")
        || path.as_os_str().is_empty()
        || path == Path::new(":memory:")
        || parameters
            .iter()
            .any(|(name, value)| name == "mode" && value == "memory");
    if memory {
        return Ok(None);
    }
    let create = parameters
        .iter()
        .any(|(name, value)| name == "mode" && value == "rwc");
    Ok(Some((path.to_owned(), create)))
}

/// Removes group and other permissions from `path` when it exists.
fn tighten(path: &Path) -> Result<()> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
    };
    let mode = metadata.permissions().mode() & 0o7777;
    if mode & 0o077 != 0 {
        fs::set_permissions(path, fs::Permissions::from_mode(mode & 0o7700))
            .with_context(|| format!("restrict {} to its owner", path.display()))?;
    }
    Ok(())
}

/// Creates a missing database owner-only when the URL lets SQLite create it, and makes an existing
/// database and its live WAL and shared-memory files owner-only.
pub(crate) fn make_private(url: &str) -> Result<()> {
    let Some((path, create)) = database_file(url)? else {
        return Ok(());
    };
    if create {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
        {
            Ok(_) => {}
            // A dangling symbolic link exists without its target, which SQLite would create
            // with the process umask; create the target owner-only through the link instead.
            Err(error)
                if error.kind() == ErrorKind::AlreadyExists
                    && fs::symlink_metadata(&path).is_ok_and(|link| link.is_symlink())
                    && fs::metadata(&path)
                        .is_err_and(|error| error.kind() == ErrorKind::NotFound) =>
            {
                match OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(false)
                    .mode(0o600)
                    .open(&path)
                {
                    Ok(_) => {}
                    Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
                    Err(error) => {
                        return Err(error).with_context(|| format!("create {}", path.display()));
                    }
                }
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            // A missing directory is reported by SQLite itself when it opens the file.
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(error).with_context(|| format!("create {}", path.display()));
            }
        }
    }
    let target = match fs::canonicalize(&path) {
        Ok(target) => target,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).with_context(|| format!("resolve {}", path.display())),
    };
    tighten(&target)?;
    for suffix in ["-wal", "-shm"] {
        let mut companion = target.clone().into_os_string();
        companion.push(suffix);
        tighten(Path::new(&companion))?;
    }
    Ok(())
}

/// Process-wide holders of each database's lock file, so every Store in this process shares it.
static HELD: LazyLock<Mutex<HashMap<PathBuf, Weak<File>>>> = LazyLock::new(Mutex::default);

/// Takes the exclusive lock that makes this process the only one using a file database. The
/// lock lasts while any returned handle lives. Call it after SQLite has opened the file.
pub(crate) fn lock_single_process(url: &str) -> Result<Option<Arc<File>>> {
    let Some((path, _)) = database_file(url)? else {
        return Ok(None);
    };
    let target = fs::canonicalize(&path).with_context(|| format!("resolve {}", path.display()))?;
    let mut lock = target.clone().into_os_string();
    lock.push(".lock");
    let lock = PathBuf::from(lock);
    let mut held = HELD.lock().unwrap_or_else(PoisonError::into_inner);
    held.retain(|_, file| file.strong_count() > 0);
    if let Some(file) = held.get(&lock).and_then(Weak::upgrade) {
        return Ok(Some(file));
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(&lock)
        .with_context(|| format!("open {}", lock.display()))?;
    tighten(&lock)?;
    match file.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => bail!(
            "another Control Plane process is using the SQLite database {}; SQLite serves one Control Plane process, so use PostgreSQL to run several Control Plane replicas",
            target.display()
        ),
        Err(TryLockError::Error(error)) => {
            return Err(error).with_context(|| format!("lock {}", lock.display()));
        }
    }
    let file = Arc::new(file);
    held.insert(lock, Arc::downgrade(&file));
    Ok(Some(file))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_only_file_databases_and_whether_they_may_be_created() {
        assert!(database_file("sqlite::memory:").unwrap().is_none());
        assert!(
            database_file("sqlite://shared?mode=memory&cache=shared")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            database_file("sqlite:///tmp/a%20b/state.db?mode=rwc").unwrap(),
            Some((PathBuf::from("/tmp/a b/state.db"), true))
        );
        assert_eq!(
            database_file("sqlite:///tmp/state.db?mode=rw").unwrap(),
            Some((PathBuf::from("/tmp/state.db"), false))
        );
    }
}
