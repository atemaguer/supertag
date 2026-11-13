//! Resolve a saved Gateway by name from the stores the terminal UI and the
//! desktop app maintain. The CLI only reads them; the clients own saving,
//! switching, and removal.
use std::{
    fs::{File, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;

const MAX_STORE_BYTES: u64 = 16 * 1024 * 1024;

/// One saved Gateway with its operator token and optional TLS files.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SavedGateway {
    pub url: String,
    pub token: String,
    pub server_ca_file: Option<PathBuf>,
    pub client_cert_file: Option<PathBuf>,
    pub client_key_file: Option<PathBuf>,
}

#[derive(Deserialize)]
struct TuiProfiles {
    version: u32,
    #[serde(default)]
    gateways: Vec<TuiGateway>,
}

#[derive(Deserialize)]
struct TuiGateway {
    url: String,
    token: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    server_ca_file: String,
    #[serde(default)]
    client_cert_file: String,
    #[serde(default)]
    client_key_file: String,
}

#[derive(Deserialize)]
struct DesktopProfiles {
    #[serde(default)]
    gateways: Vec<DesktopGateway>,
}

#[derive(Deserialize)]
struct DesktopGateway {
    profile: DesktopProfile,
    token: String,
}

#[derive(Deserialize)]
struct DesktopProfile {
    name: String,
    origin: String,
}

/// The per-user configuration directory used by Go's `os.UserConfigDir` and
/// Tauri's `app_config_dir` on this platform.
fn config_directory() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").filter(|home| !home.is_empty());
    if cfg!(target_os = "macos") {
        let home = home.context("HOME is required to find saved Gateways")?;
        return Ok(PathBuf::from(home).join("Library/Application Support"));
    }
    if let Some(directory) = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        return Ok(directory);
    }
    let home = home.context("HOME or XDG_CONFIG_HOME is required to find saved Gateways")?;
    Ok(PathBuf::from(home).join(".config"))
}

pub fn tui_store() -> Result<PathBuf> {
    Ok(config_directory()?.join("supertag/tui-gateways.json"))
}

pub fn desktop_store() -> Result<PathBuf> {
    Ok(config_directory()?.join("ai.supertag.desktop/gateways.json"))
}

/// Reads an owner-only regular file without following links. A missing store is empty.
fn read_private(path: &Path) -> Result<Option<Vec<u8>>> {
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => bail!("could not safely read saved Gateways at {}", path.display()),
    };
    check_private(&file, path)?;
    let mut bytes = Vec::new();
    file.take(MAX_STORE_BYTES + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("read saved Gateways at {}", path.display()))?;
    ensure!(
        bytes.len() as u64 <= MAX_STORE_BYTES,
        "saved Gateways at {} are too large",
        path.display()
    );
    Ok(Some(bytes))
}

fn check_private(file: &File, path: &Path) -> Result<()> {
    let metadata = file.metadata()?;
    // SAFETY: geteuid takes no arguments and cannot fail.
    let uid = unsafe { libc::geteuid() };
    ensure!(
        metadata.is_file()
            && metadata.nlink() == 1
            && metadata.mode() & 0o077 == 0
            && metadata.uid() == uid,
        "saved Gateways at {} must be a private regular file owned by this user",
        path.display()
    );
    Ok(())
}

fn optional_path(value: String) -> Option<PathBuf> {
    (!value.is_empty()).then(|| PathBuf::from(value))
}

fn valid_token(token: &str) -> bool {
    !token.is_empty() && token.len() <= 8192 && token.bytes().all(|byte| (33..=126).contains(&byte))
}

fn tui_matches(bytes: &[u8], name: &str) -> Result<Vec<SavedGateway>> {
    let profiles: TuiProfiles =
        serde_json::from_slice(bytes).context("terminal UI saved Gateways are unreadable")?;
    ensure!(
        profiles.version == 1,
        "terminal UI saved Gateways have an unsupported format"
    );
    Ok(profiles
        .gateways
        .into_iter()
        .filter(|gateway| gateway.name == name)
        .map(|gateway| SavedGateway {
            url: gateway.url,
            token: gateway.token,
            server_ca_file: optional_path(gateway.server_ca_file),
            client_cert_file: optional_path(gateway.client_cert_file),
            client_key_file: optional_path(gateway.client_key_file),
        })
        .collect())
}

fn desktop_matches(bytes: &[u8], name: &str) -> Result<Vec<SavedGateway>> {
    let profiles: DesktopProfiles =
        serde_json::from_slice(bytes).context("desktop saved Gateways are unreadable")?;
    Ok(profiles
        .gateways
        .into_iter()
        .filter(|gateway| gateway.profile.name == name)
        .map(|gateway| SavedGateway {
            url: gateway.profile.origin,
            token: gateway.token,
            server_ca_file: None,
            client_cert_file: None,
            client_key_file: None,
        })
        .collect())
}

/// A Gateway argument names a saved Gateway unless it is a URL.
pub fn is_url(gateway: &str) -> bool {
    gateway.contains("://")
}

/// Finds the one saved Gateway with this name across the terminal UI and
/// desktop stores. The same name saved for different Gateways is refused
/// rather than guessed.
pub fn resolve(name: &str) -> Result<SavedGateway> {
    ensure!(
        !name.trim().is_empty() && !name.chars().any(char::is_control),
        "enter a saved Gateway name or a Gateway URL"
    );
    let mut found = Vec::new();
    if let Some(bytes) = read_private(&tui_store()?)? {
        found.extend(tui_matches(&bytes, name)?);
    }
    if let Some(bytes) = read_private(&desktop_store()?)? {
        found.extend(desktop_matches(&bytes, name)?);
    }
    let Some(first) = found.first().cloned() else {
        bail!(
            "no saved Gateway is named {name:?}; save it in the terminal UI or desktop app, or pass a Gateway URL"
        );
    };
    ensure!(
        found.iter().all(|other| other.url.trim_end_matches('/')
            == first.url.trim_end_matches('/')
            && other.token == first.token),
        "saved Gateway name {name:?} refers to different connections; rename one in the terminal UI or desktop app"
    );
    ensure!(
        valid_token(&first.token),
        "saved Gateway {name:?} has an invalid operator token"
    );
    ensure!(
        first.client_cert_file.is_some() == first.client_key_file.is_some(),
        "saved Gateway {name:?} must name both the client certificate and key"
    );
    Ok(first)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_both_store_formats_by_name() {
        let tui = br#"{"version":1,"active":"prod","gateways":[{"url":"https://gw.example","token":"tok","name":"prod","server_ca_file":"/ca.pem"},{"url":"http://127.0.0.1:1","token":"t2","name":"dev"}]}"#;
        let found = tui_matches(tui, "prod").unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].url, "https://gw.example");
        assert_eq!(
            found[0].server_ca_file.as_deref(),
            Some(Path::new("/ca.pem"))
        );
        let desktop = br#"{"active":"https://gw.example","gateways":[{"profile":{"name":"prod","origin":"https://gw.example"},"token":"tok"}]}"#;
        assert_eq!(desktop_matches(desktop, "prod").unwrap()[0].token, "tok");
        assert!(desktop_matches(desktop, "missing").unwrap().is_empty());
        assert!(tui_matches(br#"{"version":2,"gateways":[]}"#, "prod").is_err());
    }

    #[test]
    fn tokens_are_printable_ascii() {
        assert!(valid_token("abc-123"));
        assert!(!valid_token(""));
        assert!(!valid_token("has space"));
    }
}
