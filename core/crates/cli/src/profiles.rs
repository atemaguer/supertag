//! Resolve a saved Gateway by name from the CLI's store and the desktop app's,
//! save one in the CLI's store for `supertag connect`, and remove one for
//! `supertag disconnect`. Both take an exclusive non-blocking lock on
//! `gateways.json.lock` and rename a private staged file into place. The
//! desktop app owns its own store.
use std::{
    fs::{File, OpenOptions},
    io::Read,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;

const MAX_STORE_BYTES: u64 = 16 * 1024 * 1024;

/// One saved Gateway with its credential (an Operator Token, the admin operator token, or an
/// enrolled client credential) and optional TLS files.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SavedGateway {
    pub url: String,
    pub token: String,
    pub server_ca_file: Option<PathBuf>,
    pub client_cert_file: Option<PathBuf>,
    pub client_key_file: Option<PathBuf>,
}

#[derive(Deserialize)]
struct CliProfiles {
    version: u32,
    #[serde(default)]
    gateways: Vec<CliGateway>,
}

#[derive(Deserialize)]
struct CliGateway {
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
    #[serde(default, rename = "gateways")]
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

/// The per-user configuration directory the CLI and the desktop app use on this platform.
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

/// The private directory this machine keeps for the deployment `name` that `supertag deploy`
/// manages: beside the CLI's saved Gateways, never in a repository.
pub(crate) fn deployment_directory(name: &str) -> Result<PathBuf> {
    ensure!(
        !name.is_empty()
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'),
        "invalid deployment name"
    );
    Ok(config_directory()?.join("supertag/deployments").join(name))
}

pub fn cli_store() -> Result<PathBuf> {
    Ok(config_directory()?.join("supertag/gateways.json"))
}

pub fn desktop_store() -> Result<PathBuf> {
    Ok(config_directory()?.join("ai.supertag.desktop/gateways.json"))
}

/// Group or other permission bits each store's directory must not have: the
/// CLI's must be private, the desktop app's writable only by its owner
/// (`lock_profiles`).
const CLI_DIRECTORY_MASK: u32 = 0o077;
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

fn cli_matches(bytes: &[u8], name: &str) -> Result<Vec<SavedGateway>> {
    let profiles: CliProfiles =
        serde_json::from_slice(bytes).context("saved Gateways are unreadable")?;
    ensure!(
        profiles.version == 1,
        "saved Gateways have an unsupported format"
    );
    Ok(profiles
        .gateways
        .into_iter()
        .filter(|saved| saved.name == name)
        .map(|saved| SavedGateway {
            url: saved.url,
            token: saved.token,
            server_ca_file: optional_path(saved.server_ca_file),
            client_cert_file: optional_path(saved.client_cert_file),
            client_key_file: optional_path(saved.client_key_file),
        })
        .collect())
}

fn desktop_matches(bytes: &[u8], name: &str) -> Result<Vec<SavedGateway>> {
    let profiles: DesktopProfiles =
        serde_json::from_slice(bytes).context("desktop saved Gateways are unreadable")?;
    Ok(profiles
        .gateways
        .into_iter()
        .filter(|saved| saved.profile.name == name)
        .map(|saved| SavedGateway {
            url: saved.profile.origin,
            token: saved.token,
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

/// Finds the one saved Gateway with this name across the CLI and desktop
/// stores. The same name saved for different Gateways is refused
/// rather than guessed.
pub fn resolve(name: &str) -> Result<SavedGateway> {
    ensure!(
        !name.trim().is_empty() && !name.chars().any(char::is_control),
        "enter a saved Gateway name or a Gateway URL"
    );
    let mut found = Vec::new();
    if let Some(bytes) = read_private(&cli_store()?, CLI_DIRECTORY_MASK)? {
        found.extend(cli_matches(&bytes, name)?);
    }
    if let Some(bytes) = read_private(&desktop_store()?, DESKTOP_DIRECTORY_MASK)? {
        found.extend(desktop_matches(&bytes, name)?);
    }
    let Some(first) = found.first().cloned() else {
        bail!(
            "no saved Gateway is named {name:?}; save it with supertag connect or in the desktop app, or pass a Gateway URL"
        );
    };
    ensure!(
        found.iter().all(|other| other.url.trim_end_matches('/')
            == first.url.trim_end_matches('/')
            && other.token == first.token),
        "saved Gateway name {name:?} refers to different connections; save it again with supertag connect --replace or rename it in the desktop app"
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

/// Whether the path of `raw` as typed has no backslash and no `.` or `..` segment, which
/// clients and this parser could resolve differently.
fn plain_path(raw: &str) -> bool {
    let rest = raw.trim().split_once("://").map_or("", |(_, rest)| rest);
    let path = rest.find('/').map_or("", |start| &rest[start..]);
    let path = path.split(['?', '#']).next().unwrap_or_default();
    !rest.contains('\\')
        && path.split('/').all(|segment| {
            let segment = segment.to_ascii_lowercase().replace("%2e", ".");
            segment != "." && segment != ".."
        })
}

/// The form a Gateway URL is saved in: lowercase scheme and host and no default port, plus the
/// path of a `ws://` or `wss://` tunnel URL.
fn gateway_origin(raw: &str) -> Result<String> {
    let url = url::Url::parse(raw.trim()).context("enter a Gateway URL")?;
    let tunnel = matches!(url.scheme(), "ws" | "wss");
    ensure!(
        matches!(url.scheme(), "http" | "https" | "ws" | "wss")
            && url.host_str().is_some_and(|host| !host.is_empty())
            && url.username().is_empty()
            && url.password().is_none()
            && (tunnel || matches!(url.path(), "" | "/"))
            && url.query().is_none()
            && url.fragment().is_none()
            && raw.len() <= 2048,
        "enter a Gateway origin without credentials, path, query or fragment, or a ws or wss tunnel URL without credentials, query or fragment"
    );
    ensure!(
        !tunnel || plain_path(raw),
        "a tunnel URL path must not contain backslashes or . or .. segments"
    );
    let host = url.host().context("enter a Gateway URL")?;
    if matches!(url.scheme(), "http" | "ws") {
        let loopback = match host {
            url::Host::Ipv4(address) => address.is_loopback(),
            url::Host::Ipv6(address) => address.is_loopback(),
            url::Host::Domain(_) => false,
        };
        ensure!(
            loopback,
            "remote Gateways require HTTPS or WSS; HTTP and WS require a loopback IP"
        );
    }
    let host = match host {
        url::Host::Ipv6(address) => format!("[{address}]"),
        other => other.to_string().to_lowercase(),
    };
    let path = if tunnel && url.path() != "/" {
        url.path()
    } else {
        ""
    };
    Ok(match url.port() {
        Some(port) => format!("{}://{host}:{port}{path}", url.scheme()),
        None => format!("{}://{host}{path}", url.scheme()),
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

/// A Gateway connection in the form the CLI saves.
struct Checked {
    url: String,
    server_ca: String,
    client_cert: String,
    client_key: String,
}

fn check(saved: &NewGateway) -> Result<Checked> {
    let name = saved.name.as_str();
    ensure!(
        !name.trim().is_empty() && name.len() <= 64 && !name.chars().any(char::is_control),
        "enter a Gateway name of 1 to 64 characters"
    );
    ensure!(valid_token(&saved.token), "enter a valid operator token");
    let url = gateway_origin(&saved.url)?;
    let [server_ca, client_cert, client_key] = [
        &saved.server_ca_file,
        &saved.client_cert_file,
        &saved.client_key_file,
    ]
    .map(path_text);
    let (server_ca, client_cert, client_key) = (server_ca?, client_cert?, client_key?);
    ensure!(
        client_cert.is_empty() == client_key.is_empty(),
        "provide both the client certificate and key"
    );
    ensure!(
        url.starts_with("https:")
            || url.starts_with("wss:")
            || (server_ca.is_empty() && client_cert.is_empty()),
        "TLS files require an HTTPS or WSS Gateway"
    );
    Ok(Checked {
        url,
        server_ca,
        client_cert,
        client_key,
    })
}

/// The origin `saved` would be saved under, refusing anything `save` refuses about the
/// connection itself, so a token is never sent to a URL that cannot be saved.
pub fn checked_origin(saved: &NewGateway) -> Result<String> {
    Ok(check(saved)?.url)
}

/// Saves `saved` in the CLI's store. A name already saved for this origin is replaced only with
/// `replace`; a name saved for another origin is refused.
pub fn save(saved: &NewGateway, replace: bool) -> Result<PathBuf> {
    let name = saved.name.as_str();
    let Checked {
        url,
        server_ca,
        client_cert,
        client_key,
    } = check(saved)?;
    let mut entry = serde_json::json!({"url": url, "token": saved.token, "name": name});
    for (field, value) in [
        ("server_ca_file", server_ca),
        ("client_cert_file", client_cert),
        ("client_key_file", client_key),
    ] {
        if !value.is_empty() {
            entry[field] = value.into();
        }
    }
    update_store(true, |gateways| {
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
                *saved = entry;
            }
            None => gateways.push(entry),
        }
        Ok(true)
    })
    .map(|(path, _)| path)
}

/// Removes the Gateway saved under `name` from the CLI's store, for `supertag disconnect`.
/// Returns the store and whether a Gateway was saved under that name. The desktop app's store
/// is its own; a name saved only there is not removed.
pub fn remove(name: &str) -> Result<(PathBuf, bool)> {
    ensure!(
        !name.trim().is_empty() && !name.chars().any(char::is_control),
        "enter the name of a saved Gateway"
    );
    update_store(false, |gateways| {
        let before = gateways.len();
        gateways.retain(|saved| saved["name"] != name);
        Ok(gateways.len() != before)
    })
}

/// Changes the CLI's saved Gateways under their lock: reads them, lets `change` edit the list,
/// and when it reports a change, writes a private staged file and renames it into place.
/// `create` makes the store's directory when it is missing; otherwise a missing directory is an
/// empty store and is left alone.
fn update_store(
    create: bool,
    change: impl FnOnce(&mut Vec<serde_json::Value>) -> Result<bool>,
) -> Result<(PathBuf, bool)> {
    let path = cli_store()?;
    let directory = path
        .parent()
        .context("saved Gateway store has no directory")?;
    if create {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(directory)
            .context("could not create the saved Gateway directory")?;
    }
    let metadata = match std::fs::symlink_metadata(directory) {
        Ok(metadata) => metadata,
        Err(error) if !create && error.kind() == std::io::ErrorKind::NotFound => {
            let changed = change(&mut Vec::new())?;
            return Ok((path, changed));
        }
        Err(error) => return Err(error.into()),
    };
    // SAFETY: geteuid takes no arguments and cannot fail.
    let uid = unsafe { libc::geteuid() };
    ensure!(
        metadata.is_dir() && metadata.uid() == uid && metadata.mode() & CLI_DIRECTORY_MASK == 0,
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

    let mut profiles = match read_private(&path, CLI_DIRECTORY_MASK)? {
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
    let gateways = profiles["gateways"]
        .as_array_mut()
        .context("saved Gateway file has an unsupported format")?;
    if !change(gateways)? {
        return Ok((path, false));
    }
    let mut data = serde_json::to_vec(&profiles)?;
    data.push(b'\n');
    ensure!(
        data.len() <= 1 << 20,
        "saved Gateways exceed the storage limit"
    );
    let staged = directory.join(format!(".gateways-{}", uuid::Uuid::new_v4().simple()));
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
    Ok((path, true))
}

/// Replaces the credential of a Gateway saved by name, as after a client credential
/// rotation. The CLI's store is rewritten; the desktop app's is its own.
pub fn replace_token(name: &str, token: &str) -> Result<PathBuf> {
    let saved = resolve(name)?;
    save(
        &NewGateway {
            name: name.to_owned(),
            url: saved.url,
            token: token.to_owned(),
            server_ca_file: saved.server_ca_file,
            client_cert_file: saved.client_cert_file,
            client_key_file: saved.client_key_file,
        },
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_both_store_formats_by_name() {
        let cli = br#"{"version":1,"gateways":[{"url":"https://gw.example","token":"tok","name":"prod","server_ca_file":"/ca.pem"},{"url":"http://127.0.0.1:1","token":"t2","name":"dev"}]}"#;
        let found = cli_matches(cli, "prod").unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].url, "https://gw.example");
        assert_eq!(
            found[0].server_ca_file.as_deref(),
            Some(Path::new("/ca.pem"))
        );
        let desktop = br#"{"active":"https://gw.example","gateways":[{"profile":{"name":"prod","origin":"https://gw.example"},"token":"tok"}]}"#;
        assert_eq!(desktop_matches(desktop, "prod").unwrap()[0].token, "tok");
        assert!(desktop_matches(desktop, "missing").unwrap().is_empty());
        assert!(cli_matches(br#"{"version":2,"gateways":[]}"#, "prod").is_err());
    }

    #[test]
    fn saved_gateways_accept_tunnel_urls_in_their_saved_form() {
        for (raw, saved) in [
            ("WSS://Cp.Example:443/", "wss://cp.example"),
            (
                "wss://cp.example:8443/Supertag",
                "wss://cp.example:8443/Supertag",
            ),
            ("ws://127.0.0.1:80/tunnel/", "ws://127.0.0.1/tunnel/"),
            ("ws://[::1]:7001", "ws://[::1]:7001"),
            ("https://Cp.Example:443/", "https://cp.example"),
        ] {
            assert_eq!(gateway_origin(raw).unwrap(), saved, "{raw}");
        }
        for raw in [
            "wss://cp.example/a/../supertag",
            "wss://cp.example/./supertag",
            "wss://cp.example/a/%2E%2e/supertag",
            "wss://cp.example/a\\supertag",
        ] {
            assert!(gateway_origin(raw).is_err(), "{raw}");
        }
        for raw in [
            "ws://cp.example",
            "ws://localhost:7001",
            "wss://user:secret@cp.example",
            "wss://cp.example/?token=secret",
            "wss://cp.example/#secret",
            "https://cp.example/path",
        ] {
            assert!(gateway_origin(raw).is_err(), "{raw}");
        }
        let saved = |url: &str| NewGateway {
            name: "tunnel".into(),
            url: url.into(),
            token: "token".into(),
            server_ca_file: Some("/ca.pem".into()),
            client_cert_file: None,
            client_key_file: None,
        };
        assert!(check(&saved("wss://cp.example/supertag")).is_ok());
        assert!(check(&saved("ws://127.0.0.1:7001")).is_err());
    }

    #[test]
    fn tokens_are_printable_ascii() {
        assert!(valid_token("abc-123"));
        assert!(!valid_token(""));
        assert!(!valid_token("has space"));
    }
}
