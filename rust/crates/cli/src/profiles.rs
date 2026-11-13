//! Resolve a saved Gateway by name from the stores the terminal UI and the
//! desktop app maintain, and save one in the terminal UI's store for
//! `supertag connect-gateway`. Saving follows the terminal UI's own protocol
//! (`apps/tui/gateway_store.go`): an exclusive non-blocking lock on
//! `tui-gateways.json.lock`, a private staged file renamed into place, and the
//! saved Gateway made active. The clients own switching and removal.
use std::{
    fs::{File, OpenOptions},
    io::Read,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
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

/// Group or other permission bits each client refuses on its store directory:
/// the terminal UI requires a private directory (`gatewayStore.directory`),
/// the desktop app one that only its owner can write (`lock_profiles`).
const TUI_DIRECTORY_MASK: u32 = 0o077;
const DESKTOP_DIRECTORY_MASK: u32 = 0o022;

/// Reads an owner-only regular file without following links from a directory
/// that is not a link, is owned by this user, and has none of `directory_mask`.
/// A missing store or directory is empty.
fn read_private(path: &Path, directory_mask: u32) -> Result<Option<Vec<u8>>> {
    let directory = path
        .parent()
        .context("saved Gateway store has no directory")?;
    let metadata = match std::fs::symlink_metadata(directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => bail!(
            "could not safely read the saved Gateway directory {}",
            directory.display()
        ),
    };
    // SAFETY: geteuid takes no arguments and cannot fail.
    let uid = unsafe { libc::geteuid() };
    ensure!(
        metadata.is_dir() && metadata.uid() == uid && metadata.mode() & directory_mask == 0,
        "saved Gateway directory {} must be private and owned by this user",
        directory.display()
    );
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
    if let Some(bytes) = read_private(&tui_store()?, TUI_DIRECTORY_MASK)? {
        found.extend(tui_matches(&bytes, name)?);
    }
    if let Some(bytes) = read_private(&desktop_store()?, DESKTOP_DIRECTORY_MASK)? {
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

/// One Gateway to save: a name, an origin, the operator token, and optional TLS files.
pub struct NewGateway {
    pub name: String,
    pub url: String,
    pub token: String,
    pub server_ca_file: Option<PathBuf>,
    pub client_cert_file: Option<PathBuf>,
    pub client_key_file: Option<PathBuf>,
}

/// The origin form the terminal UI stores: lowercase scheme and host, no default port.
fn gateway_origin(raw: &str) -> Result<String> {
    let url = url::Url::parse(raw.trim()).context("enter a Gateway URL")?;
    ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some_and(|host| !host.is_empty())
            && url.username().is_empty()
            && url.password().is_none()
            && matches!(url.path(), "" | "/")
            && url.query().is_none()
            && url.fragment().is_none()
            && raw.len() <= 2048,
        "enter a Gateway origin without credentials, path, query or fragment"
    );
    let host = url.host().context("enter a Gateway URL")?;
    if url.scheme() == "http" {
        let loopback = match host {
            url::Host::Ipv4(address) => address.is_loopback(),
            url::Host::Ipv6(address) => address.is_loopback(),
            url::Host::Domain(_) => false,
        };
        ensure!(
            loopback,
            "remote Gateways require HTTPS; HTTP requires a loopback IP"
        );
    }
    let host = match host {
        url::Host::Ipv6(address) => format!("[{address}]"),
        other => other.to_string().to_lowercase(),
    };
    Ok(match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    })
}

fn path_text(path: &Option<PathBuf>) -> Result<String> {
    let Some(path) = path else {
        return Ok(String::new());
    };
    let text = path.to_str().context("TLS file paths must be UTF-8")?;
    ensure!(
        text.len() <= 4096 && !text.chars().any(char::is_control),
        "invalid TLS file path"
    );
    Ok(text.to_owned())
}

/// A Gateway connection in the form the terminal UI stores.
struct Checked {
    url: String,
    server_ca: String,
    client_cert: String,
    client_key: String,
}

fn check(gateway: &NewGateway) -> Result<Checked> {
    let name = gateway.name.as_str();
    ensure!(
        !name.trim().is_empty() && name.len() <= 64 && !name.chars().any(char::is_control),
        "enter a Gateway name of 1 to 64 characters"
    );
    ensure!(valid_token(&gateway.token), "enter a valid operator token");
    let url = gateway_origin(&gateway.url)?;
    let [server_ca, client_cert, client_key] = [
        &gateway.server_ca_file,
        &gateway.client_cert_file,
        &gateway.client_key_file,
    ]
    .map(path_text);
    let (server_ca, client_cert, client_key) = (server_ca?, client_cert?, client_key?);
    ensure!(
        client_cert.is_empty() == client_key.is_empty(),
        "provide both the client certificate and key"
    );
    ensure!(
        url.starts_with("https:") || (server_ca.is_empty() && client_cert.is_empty()),
        "TLS files require an HTTPS Gateway"
    );
    Ok(Checked {
        url,
        server_ca,
        client_cert,
        client_key,
    })
}

/// The origin `gateway` would be saved under, refusing anything `save` refuses about the
/// connection itself, so a token is never sent to a URL that cannot be saved.
pub fn checked_origin(gateway: &NewGateway) -> Result<String> {
    Ok(check(gateway)?.url)
}

/// Saves `gateway` in the terminal UI's store and makes it active. A name already saved for
/// this origin is replaced only with `replace`, keeping the Workspace the terminal UI chose for
/// it; a name saved for another origin is refused.
pub fn save(gateway: &NewGateway, replace: bool) -> Result<PathBuf> {
    let name = gateway.name.as_str();
    let Checked {
        url,
        server_ca,
        client_cert,
        client_key,
    } = check(gateway)?;
    let path = tui_store()?;
    let directory = path
        .parent()
        .context("saved Gateway store has no directory")?;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(directory)
        .context("could not create the saved Gateway directory")?;
    let metadata = std::fs::symlink_metadata(directory)?;
    // SAFETY: geteuid takes no arguments and cannot fail.
    let uid = unsafe { libc::geteuid() };
    ensure!(
        metadata.is_dir() && metadata.uid() == uid && metadata.mode() & TUI_DIRECTORY_MASK == 0,
        "saved Gateway directory {} must be private and owned by this user",
        directory.display()
    );
    let mut lock_path = path.clone().into_os_string();
    lock_path.push(".lock");
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(&lock_path)
        .context("could not safely lock saved Gateways")?;
    check_private(&lock, Path::new(&lock_path))?;
    lock.try_lock()
        .map_err(|_| anyhow::anyhow!("saved Gateways are busy; try again"))?;

    let mut profiles = match read_private(&path, TUI_DIRECTORY_MASK)? {
        Some(bytes) => {
            let value: serde_json::Value = serde_json::from_slice(&bytes)
                .context("saved Gateway file has an unsupported format")?;
            ensure!(
                value["version"] == 1 && value.is_object(),
                "saved Gateway file has an unsupported format"
            );
            value
        }
        None => serde_json::json!({"version": 1, "gateways": []}),
    };
    let mut entry = serde_json::json!({"url": url, "token": gateway.token, "name": name});
    for (field, value) in [
        ("server_ca_file", server_ca),
        ("client_cert_file", client_cert),
        ("client_key_file", client_key),
    ] {
        if !value.is_empty() {
            entry[field] = value.into();
        }
    }
    let gateways = profiles["gateways"]
        .as_array_mut()
        .context("saved Gateway file has an unsupported format")?;
    match gateways.iter_mut().find(|saved| saved["name"] == name) {
        Some(saved) => {
            let origin = saved["url"].as_str().map(gateway_origin);
            ensure!(
                matches!(origin, Some(Ok(ref origin)) if origin == &url),
                "this name belongs to another Gateway URL"
            );
            ensure!(
                replace,
                "Gateway {name:?} is already saved; pass --replace to replace it"
            );
            if let Some(workspace) = saved.get("workspace").filter(|value| value.is_string()) {
                entry["workspace"] = workspace.clone();
            }
            *saved = entry;
        }
        None => gateways.push(entry),
    }
    profiles["active"] = name.into();
    let mut data = serde_json::to_vec(&profiles)?;
    data.push(b'\n');
    ensure!(
        data.len() <= 1 << 20,
        "saved Gateways exceed the storage limit"
    );
    let staged = directory.join(format!(".tui-gateways-{}", uuid::Uuid::new_v4().simple()));
    let written = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&staged)?;
        std::io::Write::write_all(&mut file, &data)?;
        file.sync_all()?;
        std::fs::rename(&staged, &path)?;
        File::open(directory)?.sync_all()
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&staged);
    }
    written.context("could not save Gateway connections")?;
    drop(lock);
    Ok(path)
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
