//! Keeps a SQLite database and its WAL and shared-memory files private to their owner.
//!
//! The database holds Task prompts, results, and coordination history. SQLite creates a missing
//! file with the process umask and gives `-wal` and `-shm` files the database file's permissions,
//! so the Control Plane creates the database owner-only before SQLite opens it, and removes group
//! and other access from an existing database and any live WAL and shared-memory files. A path
//! through a symbolic link changes the files SQLite actually uses, which sit beside the target; a
//! link whose target is missing gets its target created owner-only.

use std::{
    fs::{self, OpenOptions},
    io::ErrorKind,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    str::FromStr,
};

use anyhow::{Context, Result};
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
