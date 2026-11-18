//! The machine-wide local state `supertag up` keeps (`SUPERTAG_STATE_DIR`, else `~/.supertag`), and
//! how a client on this machine finds the local Gateway (and, for supervision, the local Control
//! Plane) in it. The CLI, the desktop app's backend and, through `supertag __local-gateway`, the
//! terminal UI all discover the local services here, so the files' format has one reader.
//!
//! Only state owned by this user is read: the directory and every file must be private to the
//! effective user, files are opened without following links, and endpoints must be loopback.
use std::{
    fs::{self, File, OpenOptions, TryLockError},
    io::{self, Read as _},
    net::SocketAddr,
    os::unix::fs::{DirBuilderExt as _, MetadataExt as _, OpenOptionsExt as _},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, ensure};
use serde_json::Value;

/// The local Control Plane's endpoint, written once it listens and removed when it stops.
pub const ENDPOINT: &str = "endpoint";
/// The local Gateway's endpoint, present while one runs.
pub const GATEWAY_ENDPOINT: &str = "gateway-endpoint";
/// The local services' own credentials.
pub const CREDENTIALS: &str = "credentials.json";
/// The supervisor holds an exclusive lock on this file while the local services run.
pub const STATE_LOCK: &str = ".lock";
/// What to run when no local Control Plane is running.
pub const START_COMMAND: &str = "supertag up";

/// The local state directory: `explicit`, else `SUPERTAG_STATE_DIR`, else `~/.supertag`. A
/// relative directory is resolved from the current directory, so the services `supertag up`
/// starts and every client use the same files.
pub fn state_directory(explicit: Option<PathBuf>) -> Result<PathBuf> {
    resolve_state_directory(
        explicit,
        std::env::var_os("SUPERTAG_STATE_DIR").map(PathBuf::from),
        std::env::var_os("HOME").map(PathBuf::from),
        &std::env::current_dir().context("read the current directory")?,
    )
}

fn resolve_state_directory(
    explicit: Option<PathBuf>,
    configured: Option<PathBuf>,
    home: Option<PathBuf>,
    invocation: &Path,
) -> Result<PathBuf> {
    let directory = explicit
        .or(configured)
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| {
            home.filter(|home| !home.as_os_str().is_empty())
                .map(|home| home.join(".supertag"))
        })
        .context("provide --state-directory or set HOME")?;
    Ok(invocation.join(directory))
}

/// The local Control Plane, or Gateway, and the admin operator token to call it with. The token
/// is read from the state directory at each discovery because `supertag up` may replace it.
#[derive(Clone, PartialEq, Eq)]
pub struct LocalConnection {
    pub url: String,
    pub token: String,
}

impl std::fmt::Debug for LocalConnection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LocalConnection")
            .field("url", &self.url)
            .field("token", &"<redacted>")
            .finish()
    }
}

/// The local Control Plane `supertag up` runs from `state_directory`, or `None` when none is
/// running there: no state directory, no supervisor holding its lock, or no endpoint yet. State
/// that exists but is not private to this user, or is malformed, is an error.
pub fn control_plane(state_directory: &Path) -> Result<Option<LocalConnection>> {
    discover(state_directory, ENDPOINT)
}

/// The local Gateway, as [`control_plane`] finds the Control Plane.
pub fn gateway(state_directory: &Path) -> Result<Option<LocalConnection>> {
    discover(state_directory, GATEWAY_ENDPOINT)
}

/// Why no local Gateway is available from `state_directory`, as one sentence.
pub fn not_running(state_directory: &Path) -> String {
    format!(
        "No local Gateway is running from {}. Start it with {START_COMMAND}.",
        state_directory.display()
    )
}

fn discover(state_directory: &Path, file: &str) -> Result<Option<LocalConnection>> {
    if missing(state_directory)? {
        return Ok(None);
    }
    let directory = private_directory(state_directory)?;
    if missing(&directory.join(STATE_LOCK))? {
        return Ok(None);
    }
    let lock = open_private_file(&directory.join(STATE_LOCK), false)
        .context("inspect local supervisor lock")?;
    match lock.try_lock() {
        Ok(()) => return Ok(None),
        Err(TryLockError::WouldBlock) => {}
        Err(TryLockError::Error(error)) => {
            return Err(error).context("inspect local supervisor lock");
        }
    }
    drop(lock);
    if missing(&directory.join(file))? {
        return Ok(None);
    }
    let endpoint = read_private(&directory.join(file))?;
    let endpoint = endpoint.trim();
    let address = endpoint
        .strip_prefix("http://")
        .context("invalid local endpoint")?;
    loopback_address(address)?;
    Ok(Some(LocalConnection {
        url: endpoint.to_owned(),
        token: Credentials::load(&directory)?.operator,
    }))
}

fn missing(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error).with_context(|| format!("read {}", path.display())),
    }
}

/// The local services' own credentials: the admin operator token, and the enrolled credentials
/// of `gateway:local` and `host:local`, which the Control Plane seeds at startup.
pub struct Credentials {
    pub gateway: String,
    pub operator: String,
    pub host: String,
}

impl Credentials {
    /// Reads and checks the credential bundle in a private state directory.
    pub fn load(directory: &Path) -> Result<Self> {
        let value = read_private(&directory.join(CREDENTIALS))?;
        // Parsing errors stay generic because this file contains credentials.
        let value: Value = serde_json::from_str(&value)
            .map_err(|_| anyhow::anyhow!("invalid local credential bundle"))?;
        let field = |key, valid: fn(&str) -> bool| {
            value
                .get(key)
                .and_then(Value::as_str)
                .filter(|token| valid(token))
                .map(str::to_owned)
                .context(
                    "invalid local credential bundle; remove it with the local services stopped to create a new one",
                )
        };
        let hex =
            |token: &str| token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit());
        let enrolled = |token: &str| {
            supertag_protocol::is_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX, token)
        };
        let credentials = Self {
            gateway: field("gateway_credential", enrolled)?,
            operator: field("operator_token", hex)?,
            host: field("host_credential", enrolled)?,
        };
        ensure!(
            credentials.gateway != credentials.operator
                && credentials.gateway != credentials.host
                && credentials.operator != credentials.host,
            "local credential bundle must contain distinct tokens"
        );
        Ok(credentials)
    }
}

/// Reads a small private regular file owned by this user.
pub fn read_private(path: &Path) -> Result<String> {
    let mut value = String::new();
    open_private_file(path, false)?
        .take(4097)
        .read_to_string(&mut value)?;
    ensure!(value.len() <= 4096, "local state file is too large");
    Ok(value)
}

/// Opens, and with `create` creates, a private regular file owned by this user without following
/// a link.
pub fn open_private_file(path: &Path, create: bool) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(create)
        .create(create)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .with_context(|| format!("open {}", path.display()))?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.nlink() == 1 && private(&metadata),
        "{} must be a private regular file owned by this user",
        path.display()
    );
    Ok(file)
}

/// Checks that `path` is a private directory owned by this user, not a link, and resolves it.
pub fn private_directory(path: &Path) -> Result<PathBuf> {
    let metadata =
        fs::symlink_metadata(path).with_context(|| format!("read {}", path.display()))?;
    ensure!(
        metadata.is_dir() && private(&metadata),
        "{} must be a private directory owned by this user",
        path.display()
    );
    path.canonicalize().context("resolve local state directory")
}

fn private(metadata: &fs::Metadata) -> bool {
    // SAFETY: geteuid returns the calling process's effective user ID.
    let user = unsafe { libc::geteuid() };
    metadata.uid() == user && metadata.mode() & 0o077 == 0
}

/// Parses a local service's address, which must be a loopback IP with a port.
pub fn loopback_address(value: &str) -> Result<SocketAddr> {
    let address: SocketAddr = value.parse().context("invalid local service address")?;
    ensure!(
        address.ip().is_loopback() && address.port() != 0,
        "invalid local service address"
    );
    Ok(address)
}

/// The per-user configuration directory used by Go's `os.UserConfigDir` and Tauri's
/// `app_config_dir` on this platform.
fn user_config_directory() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").filter(|home| !home.is_empty());
    if cfg!(target_os = "macos") {
        let home = home.context("HOME is required to find this machine's identifier")?;
        return Ok(PathBuf::from(home).join("Library/Application Support"));
    }
    if let Some(directory) = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        return Ok(directory);
    }
    let home =
        home.context("HOME or XDG_CONFIG_HOME is required to find this machine's identifier")?;
    Ok(PathBuf::from(home).join(".config"))
}

/// This machine and user's random identifier, created on first use in the per-user
/// configuration directory (`supertag/machine-id`). Every state directory shares it, so a Worker
/// Host and a client on the same machine present the same one. It proves nothing to anyone else:
/// a Control Plane only uses it to tell a client that a host's files are on the client's disk.
pub fn machine_id() -> Result<String> {
    let directory = user_config_directory()?.join("supertag");
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&directory)
        .context("create the per-user SuperTag configuration directory")?;
    let path = directory.join("machine-id");
    let valid =
        |id: &str| id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if let Ok(existing) = read_private(&path) {
        let existing = existing.trim().to_owned();
        ensure!(
            valid(&existing),
            "{} is not a machine identifier",
            path.display()
        );
        return Ok(existing);
    }
    let mut random = [0u8; 16];
    File::open("/dev/urandom")
        .and_then(|mut source| std::io::Read::read_exact(&mut source, &mut random))
        .context("read randomness for the machine identifier")?;
    let id: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
    {
        Ok(mut file) => {
            std::io::Write::write_all(&mut file, format!("{id}\n").as_bytes())?;
            Ok(id)
        }
        // Another process created it first: use theirs.
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let existing = read_private(&path)?.trim().to_owned();
            ensure!(
                valid(&existing),
                "{} is not a machine identifier",
                path.display()
            );
            Ok(existing)
        }
        Err(error) => Err(error).context("create this machine's identifier"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt as _;

    // packages/store/paths.test.ts
    #[test]
    fn state_lives_under_home_or_a_configured_directory_from_the_invocation_directory() {
        let invocation = Path::new("/srv/supertag");
        let home = || Some(PathBuf::from("/tmp/supertag-home"));
        assert_eq!(
            resolve_state_directory(None, None, home(), invocation).unwrap(),
            Path::new("/tmp/supertag-home/.supertag")
        );
        assert_eq!(
            resolve_state_directory(None, Some("state".into()), home(), invocation).unwrap(),
            Path::new("/srv/supertag/state")
        );
        assert_eq!(
            resolve_state_directory(None, Some("".into()), home(), invocation).unwrap(),
            Path::new("/tmp/supertag-home/.supertag")
        );
        assert_eq!(
            resolve_state_directory(
                Some("explicit".into()),
                Some("/var/lib/supertag".into()),
                home(),
                invocation
            )
            .unwrap(),
            Path::new("/srv/supertag/explicit")
        );
        assert_eq!(
            resolve_state_directory(None, Some("/var/lib/supertag".into()), None, invocation)
                .unwrap(),
            Path::new("/var/lib/supertag")
        );
        assert!(resolve_state_directory(None, None, None, invocation).is_err());
    }

    fn write(directory: &Path, name: &str, contents: &str) {
        let path = directory.join(name);
        fs::write(&path, contents).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    }

    fn running_state() -> (tempfile::TempDir, File) {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("state");
        fs::DirBuilder::new().mode(0o700).create(&state).unwrap();
        write(&state, ENDPOINT, "http://127.0.0.1:7001\n");
        let enrolled =
            || supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
        write(
            &state,
            CREDENTIALS,
            &serde_json::json!({
                "gateway_credential": enrolled(),
                "operator_token": "a".repeat(64),
                "host_credential": enrolled(),
            })
            .to_string(),
        );
        let lock = open_private_file(&state.join(STATE_LOCK), true).unwrap();
        lock.try_lock().unwrap();
        (root, lock)
    }

    #[test]
    fn finds_the_running_local_control_plane_and_its_current_token() {
        let (root, lock) = running_state();
        let state = root.path().join("state");
        let found = control_plane(&state).unwrap().unwrap();
        assert_eq!(found.url, "http://127.0.0.1:7001");
        assert_eq!(found.token, "a".repeat(64));
        assert!(!format!("{found:?}").contains(&found.token));
        assert!(gateway(&state).unwrap().is_none());

        // The token is read again at each discovery.
        let credentials = fs::read_to_string(state.join(CREDENTIALS))
            .unwrap()
            .replace(&"a".repeat(64), &"b".repeat(64));
        write(&state, CREDENTIALS, &credentials);
        assert_eq!(
            control_plane(&state).unwrap().unwrap().token,
            "b".repeat(64)
        );

        // Without the supervisor's lock nothing is running, whatever files remain.
        drop(lock);
        assert!(control_plane(&state).unwrap().is_none());
    }

    #[test]
    fn missing_state_is_not_running_and_shared_state_is_refused() {
        let root = tempfile::tempdir().unwrap();
        assert!(
            control_plane(&root.path().join("absent"))
                .unwrap()
                .is_none()
        );
        assert!(not_running(&root.path().join("absent")).contains(START_COMMAND));

        let (root, _lock) = running_state();
        let state = root.path().join("state");
        fs::set_permissions(state.join(CREDENTIALS), fs::Permissions::from_mode(0o640)).unwrap();
        assert!(control_plane(&state).is_err());
        fs::set_permissions(state.join(CREDENTIALS), fs::Permissions::from_mode(0o600)).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o750)).unwrap();
        assert!(control_plane(&state).is_err());
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();

        write(&state, ENDPOINT, "http://192.0.2.1:7001\n");
        assert!(control_plane(&state).is_err());
    }
}
