//! What the app keeps on disk to show at once on launch, before the Gateway answers: the
//! Tag list, recent conversations, and messages not yet sent. Each Gateway and principal
//! has its own directory, named by digests, under the app's data directory. The files hold only
//! what the app read or wrote, never a credential, and only this user can read them.

use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

use super::{GatewayState, Result};

/// The most one entry may take.
const MAX_ENTRY_BYTES: u64 = 4 * 1024 * 1024;
/// How many entries each Gateway and principal keep; the least recently written are
/// removed first.
const MAX_ENTRIES: usize = 64;
const CACHE_ERROR: &str = "Could not use the conversation cache.";

fn digest(parts: &[&str]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

/// Where a Gateway's cached conversations are, for every principal.
fn gateway_directory(root: &Path, gateway: &str) -> PathBuf {
    root.join(digest(&[gateway]))
}

/// What a connection's cache entries are scoped to: the Gateway, and whom it acts as.
#[derive(Clone, Debug)]
pub(super) struct CacheScope {
    pub(super) gateway: String,
    pub(super) principal: String,
}

impl CacheScope {
    fn entry(&self, root: &Path, key: &str) -> PathBuf {
        gateway_directory(root, &self.gateway)
            .join(digest(&[&self.principal]))
            .join(format!("{}.json", digest(&[key])))
    }
}

/// An entry's key: `roster`, `outbox`, or `tag:` and a Tag ID.
fn valid_key(key: &str) -> Result<()> {
    let valid = matches!(key, "roster" | "outbox")
        || key.strip_prefix("tag:").is_some_and(|tag| {
            !tag.is_empty() && tag.len() <= 256 && !tag.chars().any(char::is_control)
        });
    if valid {
        Ok(())
    } else {
        Err(CACHE_ERROR.into())
    }
}

fn private_directory(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt};
        builder.mode(0o700);
        builder.create(path).map_err(|_| CACHE_ERROR)?;
        let metadata = fs::symlink_metadata(path).map_err(|_| CACHE_ERROR)?;
        // SAFETY: geteuid takes no arguments.
        if !metadata.is_dir()
            || metadata.mode() & 0o077 != 0
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            return Err(CACHE_ERROR.into());
        }
    }
    #[cfg(not(unix))]
    builder.create(path).map_err(|_| CACHE_ERROR)?;
    Ok(())
}

fn read_entry(path: &Path) -> Option<serde_json::Value> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid takes no arguments.
        if metadata.mode() & 0o077 != 0 || metadata.uid() != unsafe { libc::geteuid() } {
            return None;
        }
    }
    let mut bytes = Vec::new();
    file.take(MAX_ENTRY_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_ENTRY_BYTES {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn write_entry(path: &Path, value: &serde_json::Value) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| CACHE_ERROR)?;
    if bytes.len() as u64 > MAX_ENTRY_BYTES {
        // Too large to keep; the conversation still loads from the Gateway.
        let _ = fs::remove_file(path);
        return Ok(());
    }
    let parent = path.parent().ok_or(CACHE_ERROR)?;
    private_directory(parent)?;
    // A named temporary file is created owner-only.
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|_| CACHE_ERROR)?;
    staged.write_all(&bytes).map_err(|_| CACHE_ERROR)?;
    staged.persist(path).map_err(|_| CACHE_ERROR)?;
    prune(parent);
    Ok(())
}

/// Keeps the [`MAX_ENTRIES`] most recently written entries of one scope.
fn prune(directory: &Path) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut files: Vec<_> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, entry.path()))
        })
        .filter(|(_, path)| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    if files.len() <= MAX_ENTRIES {
        return;
    }
    files.sort();
    for (_, path) in &files[..files.len() - MAX_ENTRIES] {
        let _ = fs::remove_file(path);
    }
}

/// Removes everything cached for a Gateway, for every principal.
pub fn forget(root: &Path, gateway: &str) {
    let _ = fs::remove_dir_all(gateway_directory(root, gateway));
}

impl GatewayState {
    /// The entry last cached under `key` for the current connection's Gateway and
    /// principal, if there is one.
    pub async fn cached(
        &self,
        connection_id: &str,
        root: PathBuf,
        key: String,
    ) -> Result<Option<serde_json::Value>> {
        valid_key(&key)?;
        let scope = self.cache_scope(connection_id).await?;
        let path = scope.entry(&root, &key);
        tokio::task::spawn_blocking(move || read_entry(&path))
            .await
            .map_err(|_| CACHE_ERROR.into())
    }

    /// Replaces the entry under `key` for the current connection's Gateway and principal.
    pub async fn cache(
        &self,
        connection_id: &str,
        root: PathBuf,
        key: String,
        value: serde_json::Value,
    ) -> Result<()> {
        valid_key(&key)?;
        let scope = self.cache_scope(connection_id).await?;
        let path = scope.entry(&root, &key);
        tokio::task::spawn_blocking(move || write_entry(&path, &value))
            .await
            .map_err(|_| CACHE_ERROR)?
    }

    async fn cache_scope(&self, connection_id: &str) -> Result<CacheScope> {
        let state = self.0.read().await;
        if state.generation.to_string() != connection_id {
            return Err("The connection changed. Refresh this view.".into());
        }
        state
            .cache_scope
            .clone()
            .ok_or_else(|| "Connect to a Gateway first.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_are_scoped_private_bounded_and_forgotten() {
        let root = tempfile::tempdir().unwrap();
        let alice = CacheScope {
            gateway: "https://one.example.com".into(),
            principal: "operator:alice".into(),
        };
        let bob = CacheScope {
            principal: "client:bob".into(),
            ..alice.clone()
        };
        let other = CacheScope {
            gateway: "https://two.example.com".into(),
            ..alice.clone()
        };
        let value = serde_json::json!({ "messages": [{ "task": { "taskId": "one" } }] });
        let path = alice.entry(root.path(), "tag:engineer");
        write_entry(&path, &value).unwrap();
        assert_eq!(read_entry(&path), Some(value));
        for scope in [&bob, &other] {
            assert_ne!(scope.entry(root.path(), "tag:engineer"), path);
            assert!(read_entry(&scope.entry(root.path(), "tag:engineer")).is_none());
        }
        for key in ["roster", "outbox", "tag:engineer"] {
            assert!(valid_key(key).is_ok());
        }
        for key in ["", "tag:", "other", "tag:a\nb", "../roster"] {
            assert!(valid_key(key).is_err(), "{key}");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&path), 0o600);
            assert_eq!(mode(path.parent().unwrap()), 0o700);
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            assert!(read_entry(&path).is_none());
        }

        for index in 0..MAX_ENTRIES + 3 {
            write_entry(
                &alice.entry(root.path(), &format!("tag:t{index}")),
                &serde_json::json!(index),
            )
            .unwrap();
        }
        assert_eq!(
            fs::read_dir(path.parent().unwrap()).unwrap().count(),
            MAX_ENTRIES
        );
        let large = serde_json::json!("x".repeat(MAX_ENTRY_BYTES as usize));
        let latest = alice.entry(root.path(), &format!("tag:t{}", MAX_ENTRIES + 2));
        write_entry(&latest, &large).unwrap();
        assert!(read_entry(&latest).is_none());

        forget(root.path(), &alice.gateway);
        assert!(!gateway_directory(root.path(), &alice.gateway).exists());
    }
}
