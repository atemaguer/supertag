//! Recent conversations kept on disk so the app shows one immediately, before the Control Plane
//! answers. Each Control Plane and principal has its own directory, named by digests, under the
//! app's data directory; the files hold only what the Control Plane returned, never a
//! credential, and only this user can read them.

use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

use super::{ControlPlaneState, Result};

/// The most one conversation's cached transcript may take.
const MAX_ENTRY_BYTES: u64 = 4 * 1024 * 1024;
/// How many conversations each Control Plane and principal keep; the least recently written
/// are removed first.
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

/// Where a Control Plane's cached conversations are, for every principal.
fn control_plane_directory(root: &Path, control_plane: &str) -> PathBuf {
    root.join(digest(&[control_plane]))
}

/// What a connection's cache entries are scoped to: the Control Plane, and whom it acts as.
#[derive(Clone, Debug)]
pub(super) struct CacheScope {
    pub(super) control_plane: String,
    pub(super) principal: String,
}

impl CacheScope {
    fn entry(&self, root: &Path, tag_id: &str, conversation: &str) -> PathBuf {
        control_plane_directory(root, &self.control_plane)
            .join(digest(&[&self.principal]))
            .join(format!("{}.json", digest(&[tag_id, conversation])))
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
        // Too large to keep; the conversation still loads from the Control Plane.
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

/// Removes everything cached for a Control Plane, for every principal.
pub fn forget(root: &Path, control_plane: &str) {
    let _ = fs::remove_dir_all(control_plane_directory(root, control_plane));
}

impl ControlPlaneState {
    /// The transcript last cached for this conversation on the current connection's Control
    /// Plane and principal, if there is one.
    pub async fn cached_conversation(
        &self,
        connection_id: &str,
        root: PathBuf,
        tag_id: String,
        conversation: String,
    ) -> Result<Option<serde_json::Value>> {
        let scope = self.cache_scope(connection_id).await?;
        let path = scope.entry(&root, &tag_id, &conversation);
        tokio::task::spawn_blocking(move || read_entry(&path))
            .await
            .map_err(|_| CACHE_ERROR.into())
    }

    /// Replaces this conversation's cached transcript on the current connection's Control Plane
    /// and principal.
    pub async fn cache_conversation(
        &self,
        connection_id: &str,
        root: PathBuf,
        tag_id: String,
        conversation: String,
        value: serde_json::Value,
    ) -> Result<()> {
        let scope = self.cache_scope(connection_id).await?;
        let path = scope.entry(&root, &tag_id, &conversation);
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
            .ok_or_else(|| "Connect to a Control Plane first.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_are_scoped_private_bounded_and_forgotten() {
        let root = tempfile::tempdir().unwrap();
        let alice = CacheScope {
            control_plane: "https://one.example.com".into(),
            principal: "operator:alice".into(),
        };
        let bob = CacheScope {
            principal: "client:bob".into(),
            ..alice.clone()
        };
        let other = CacheScope {
            control_plane: "https://two.example.com".into(),
            ..alice.clone()
        };
        let value = serde_json::json!({ "messages": [{ "task": { "taskId": "one" } }] });
        let path = alice.entry(root.path(), "engineer", "planning");
        write_entry(&path, &value).unwrap();
        assert_eq!(read_entry(&path), Some(value));
        for scope in [&bob, &other] {
            assert_ne!(scope.entry(root.path(), "engineer", "planning"), path);
            assert!(read_entry(&scope.entry(root.path(), "engineer", "planning")).is_none());
        }
        // Names cannot be confused by moving a separator between the Tag and the conversation.
        assert_ne!(
            alice.entry(root.path(), "a", "bc"),
            alice.entry(root.path(), "ab", "c")
        );
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
                &alice.entry(root.path(), "engineer", &format!("c{index}")),
                &serde_json::json!(index),
            )
            .unwrap();
        }
        assert_eq!(
            fs::read_dir(path.parent().unwrap()).unwrap().count(),
            MAX_ENTRIES
        );
        let large = serde_json::json!("x".repeat(MAX_ENTRY_BYTES as usize));
        let latest = alice.entry(root.path(), "engineer", &format!("c{}", MAX_ENTRIES + 2));
        write_entry(&latest, &large).unwrap();
        assert!(read_entry(&latest).is_none());

        forget(root.path(), &alice.control_plane);
        assert!(!control_plane_directory(root.path(), &alice.control_plane).exists());
    }
}
