//! OpenCode's sign-in file (`opencode auth login` writes it), as a host's `opencode-auth-file`
//! names it: `{ PROVIDER: { "type": "api", "key": KEY }, ... }`. `supertag init` reads only which
//! providers it holds and of what kind; only a sign-in probe reads one provider's entry, to copy it
//! into its private OpenCode home as a Task Attempt does. No key is ever printed.
use std::{
    collections::BTreeMap,
    fs::File,
    io::Read as _,
    os::unix::fs::{MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _},
    path::{Path, PathBuf},
};

use anyhow::{Result, bail, ensure};
use serde_json::Value;

/// The largest file the OpenCode adapter reads.
const MAX_FILE: u64 = 1024 * 1024;

/// The kind of one provider's sign-in in the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Entry {
    /// An API key, which a Task Attempt can use.
    ApiKey,
    /// Another kind, such as an OAuth sign-in, which Task Attempts refuse.
    Other,
}

/// Where OpenCode keeps its sign-ins: `$XDG_DATA_HOME/opencode/auth.json`, by default
/// `~/.local/share/opencode/auth.json`.
pub fn usual_path() -> Option<PathBuf> {
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share"))
        })?;
    Some(data.join("opencode").join("auth.json"))
}

/// The file's JSON object, read the way the OpenCode adapter reads it: a regular file reached
/// without a symlink, no larger than 1 MiB.
fn read(path: &Path) -> Result<serde_json::Map<String, Value>> {
    let mut file = File::options()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|error| match error.raw_os_error() {
            Some(libc::ELOOP) => {
                anyhow::anyhow!("it must be a regular file without a symlink")
            }
            _ if error.kind() == std::io::ErrorKind::NotFound => {
                anyhow::anyhow!("it does not exist")
            }
            _ => anyhow::anyhow!("it cannot be opened"),
        })?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.len() <= MAX_FILE,
        "it must be a regular file no larger than 1 MiB"
    );
    let mut bytes = Vec::new();
    (&mut file).take(MAX_FILE + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= MAX_FILE, "it is larger than 1 MiB");
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(object)) => Ok(object),
        Ok(_) => bail!("it is not a JSON object"),
        Err(_) => bail!("it is not valid JSON"),
    }
}

/// Which providers the file holds a sign-in for, and of what kind. Never the keys.
pub fn providers(path: &Path) -> Result<BTreeMap<String, Entry>> {
    Ok(read(path)?
        .into_iter()
        .map(|(provider, entry)| {
            let api = entry["type"] == "api"
                && entry["key"]
                    .as_str()
                    .is_some_and(|key| !key.trim().is_empty());
            (provider, if api { Entry::ApiKey } else { Entry::Other })
        })
        .collect())
}

/// Why a host would refuse the file as its `opencode-auth-file`: it must be owned by this user
/// and readable only by it.
pub fn private_problem(path: &Path) -> Option<String> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    let owner = unsafe { libc::geteuid() };
    (metadata.uid() != owner || metadata.permissions().mode() & 0o077 != 0).then(|| {
        format!(
            "{} must be owned by you and readable only by you",
            path.display()
        )
    })
}

/// One provider's API-key entry, for a sign-in probe's private OpenCode home.
pub(super) fn api_entry(path: &Path, provider: &str) -> Option<Value> {
    let mut file = read(path).ok()?;
    let entry = file.remove(provider)?;
    (entry["type"] == "api"
        && entry["key"]
            .as_str()
            .is_some_and(|key| !key.trim().is_empty()))
    .then(|| serde_json::json!({ "type": "api", "key": entry["key"] }))
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::{PermissionsExt as _, symlink};

    use super::*;

    fn write(directory: &Path, text: &str, mode: u32) -> PathBuf {
        let path = directory.join("auth.json");
        std::fs::write(&path, text).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        path
    }

    #[test]
    fn reads_which_providers_hold_an_api_key_and_never_a_key() {
        let temporary = tempfile::tempdir().unwrap();
        let path = write(
            temporary.path(),
            r#"{"opencode-go":{"type":"api","key":"fake-go-key"},"anthropic":{"type":"oauth","refresh":"fake"},"empty":{"type":"api","key":" "}}"#,
            0o600,
        );
        let providers = providers(&path).unwrap();
        assert_eq!(
            providers,
            BTreeMap::from([
                ("anthropic".to_owned(), Entry::Other),
                ("empty".to_owned(), Entry::Other),
                ("opencode-go".to_owned(), Entry::ApiKey),
            ])
        );
        assert!(!format!("{providers:?}").contains("fake-go-key"));
        assert_eq!(private_problem(&path), None);
        assert_eq!(
            api_entry(&path, "opencode-go"),
            Some(serde_json::json!({"type": "api", "key": "fake-go-key"}))
        );
        assert_eq!(api_entry(&path, "anthropic"), None);
        assert_eq!(api_entry(&path, "openai"), None);
    }

    #[test]
    fn refuses_a_shared_linked_or_malformed_file_without_echoing_it() {
        let temporary = tempfile::tempdir().unwrap();
        let path = write(
            temporary.path(),
            r#"{"opencode-go":{"type":"api","key":"fake"}}"#,
            0o644,
        );
        assert!(private_problem(&path).is_some());
        let link = temporary.path().join("link.json");
        symlink(&path, &link).unwrap();
        let refused = providers(&link).unwrap_err().to_string();
        assert!(refused.contains("symlink"), "{refused}");
        let path = write(temporary.path(), "not json fake-secret", 0o600);
        let refused = providers(&path).unwrap_err().to_string();
        assert_eq!(refused, "it is not valid JSON");
        let path = write(temporary.path(), "[]", 0o600);
        assert!(providers(&path).is_err());
        let missing = providers(&temporary.path().join("missing.json")).unwrap_err();
        assert_eq!(missing.to_string(), "it does not exist");
    }
}
