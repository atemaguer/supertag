use std::{
    fmt::Write as _,
    fs::{self, DirBuilder, File, OpenOptions, TryLockError},
    future::Future,
    io::{self, Read as _, Write as _},
    net::SocketAddr,
    os::unix::{
        fs::{DirBuilderExt as _, MetadataExt as _, OpenOptionsExt as _},
        process::ExitStatusExt as _,
    },
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt as _, AsyncReadExt as _, BufReader},
    process::{Child, ChildStdin, Command},
    time,
};
use uuid::Uuid;

const START_TIMEOUT: Duration = Duration::from_secs(15);
const STOP_TIMEOUT: Duration = Duration::from_secs(12);
const KILL_TIMEOUT: Duration = Duration::from_secs(3);
const ENDPOINT: &str = "endpoint";
const CREDENTIALS: &str = "credentials.json";
const STATE_LOCK: &str = ".lock";
pub const LOCAL_SERVICE_LIFELINE: &str = "SUPERTAG_LOCAL_SERVICE_LIFELINE";

pub struct LocalOptions {
    pub state_directory: PathBuf,
    pub adapter: crate::AdapterOptions,
    pub gateway_listen: SocketAddr,
}

pub async fn up(options: LocalOptions, shutdown: impl Future<Output = ()>) -> Result<()> {
    ensure!(
        options.gateway_listen.ip().is_loopback(),
        "local Gateway must listen on loopback"
    );
    let mut directories = DirBuilder::new();
    directories
        .recursive(true)
        .mode(0o700)
        .create(&options.state_directory)?;
    let directory = private_directory(&options.state_directory)?;
    let lock = open_private_file(&directory.join(STATE_LOCK), true)?;
    lock.try_lock().context("local state is already in use")?;
    remove_endpoint(&directory)?;
    let credentials = Credentials::load_or_create(&directory)?;
    let database = directory.join("runtime.sqlite3");
    open_private_file(&database, true)?;
    let database_url = sqlite_url(&database)?;
    let executable = std::env::current_exe()?;

    let mut children = Children::default();
    tokio::pin!(shutdown);
    let start = tokio::select! {
        result = children.start(&executable, &options, &directory, &credentials, database_url) => result.map(Some),
        _ = &mut shutdown => Ok(None),
    };
    let result = match start {
        Ok(Some(endpoint)) => match announce(&directory, &endpoint) {
            Ok(()) => tokio::select! {
                result = children.wait_for_exit() => result,
                _ = &mut shutdown => Ok(()),
            },
            Err(error) => Err(error),
        },
        Ok(None) => Ok(()),
        Err(error) => Err(error),
    };
    let removed = remove_endpoint(&directory);
    let stopped = children.stop().await;
    drop(lock);
    match (result, removed.and(stopped)) {
        (Err(error), Err(cleanup)) => {
            Err(error.context(format!("local service cleanup failed: {cleanup:#}")))
        }
        (result, cleanup) => result.and(cleanup),
    }
}

/// Read the endpoint and operator credential for a local CLI invocation.
pub fn connection(state_directory: &Path) -> Result<(String, String)> {
    let directory = private_directory(state_directory)?;
    let lock = open_private_file(&directory.join(STATE_LOCK), false)
        .context("inspect local supervisor lock")?;
    match lock.try_lock() {
        Ok(()) => bail!("local SuperTag services are not running"),
        Err(TryLockError::WouldBlock) => {}
        Err(TryLockError::Error(error)) => {
            return Err(error).context("inspect local supervisor lock");
        }
    }
    let endpoint = read_private(&directory.join(ENDPOINT))?;
    let endpoint = endpoint.trim();
    let address = endpoint
        .strip_prefix("http://")
        .context("invalid local Gateway endpoint")?;
    loopback_address(address)?;
    Ok((endpoint.to_owned(), Credentials::load(&directory)?.operator))
}

#[derive(Default)]
struct Children {
    control_plane: Option<Service>,
    gateway: Option<Service>,
    worker_host: Option<Service>,
}

struct Service {
    process: Child,
    // Child::wait closes its own stdin handle. Keep the close-on-exec writer
    // separately so only supervisor exit or drop signals EOF to the service.
    _lifeline: ChildStdin,
}

impl Children {
    async fn start(
        &mut self,
        executable: &Path,
        options: &LocalOptions,
        directory: &Path,
        credentials: &Credentials,
        database_url: String,
    ) -> Result<String> {
        let mut plane = command(executable, "control-plane");
        plane
            .args(["--listen", "127.0.0.1:0"])
            .env("SUPERTAG_DATABASE_URL", database_url)
            .env("SUPERTAG_GATEWAY_TOKEN", &credentials.gateway);
        let address = start_child(&mut self.control_plane, &mut plane, "Control Plane").await?;
        let control_plane = format!("http://{}", loopback_address(&address)?);

        let mut gateway = command(executable, "gateway");
        gateway
            .args([
                "--control-plane",
                &control_plane,
                "--listen",
                &options.gateway_listen.to_string(),
            ])
            .env("SUPERTAG_GATEWAY_TOKEN", &credentials.gateway)
            .env("SUPERTAG_OPERATOR_TOKEN", &credentials.operator)
            .env("SUPERTAG_HOST_TOKEN", &credentials.host);
        let address = start_child(&mut self.gateway, &mut gateway, "Gateway").await?;
        let endpoint = format!("http://{}", loopback_address(&address)?);

        let mut host = command(executable, "worker-host");
        host.args(["--gateway", &endpoint, "--state-directory"])
            .arg(directory.join("host"))
            .arg("--wait-for-recovery")
            .args(options.adapter.worker_args())
            .env("SUPERTAG_HOST_TOKEN", &credentials.host);
        if options.adapter.uses_codex() {
            host.envs(
                supertag_worker_host::CODEX_ENVIRONMENT
                    .iter()
                    .filter_map(|&name| std::env::var_os(name).map(|value| (name, value))),
            );
        }
        let ready = start_child(&mut self.worker_host, &mut host, "Worker Host").await?;
        ensure!(ready == "ready", "invalid Worker Host readiness signal");
        Ok(endpoint)
    }

    async fn wait_for_exit(&mut self) -> Result<()> {
        let plane = self
            .control_plane
            .as_mut()
            .context("Control Plane was not started")?;
        let gateway = self.gateway.as_mut().context("Gateway was not started")?;
        let host = self
            .worker_host
            .as_mut()
            .context("Worker Host was not started")?;
        let (name, exit) = tokio::select! {
            status = plane.process.wait() => ("Control Plane", status),
            status = gateway.process.wait() => ("Gateway", status),
            status = host.process.wait() => ("Worker Host", status),
        };
        bail!(
            "{name} exited unexpectedly with {}",
            exit.with_context(|| format!("wait for {name}"))?
        );
    }

    async fn stop(&mut self) -> Result<()> {
        let mut failures = Vec::new();
        // The Worker Host needs the Gateway and Control Plane while it stops execution.
        for (name, child) in [
            ("Worker Host", self.worker_host.as_mut()),
            ("Gateway", self.gateway.as_mut()),
            ("Control Plane", self.control_plane.as_mut()),
        ] {
            if let Some(child) = child
                && let Err(error) = stop_child(&mut child.process).await
            {
                failures.push(format!("{name}: {error:#}"));
            }
        }
        ensure!(
            failures.is_empty(),
            "failed to stop local services: {}",
            failures.join("; ")
        );
        Ok(())
    }
}

fn command(executable: &Path, mode: &str) -> Command {
    let mut command = Command::new(executable);
    command
        .arg(mode)
        .env_clear()
        .envs(
            [
                "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE",
            ]
            .into_iter()
            .filter_map(|name| std::env::var_os(name).map(|value| (name, value))),
        )
        .env(LOCAL_SERVICE_LIFELINE, "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .process_group(0)
        .kill_on_drop(true);
    command
}

async fn start_child(
    slot: &mut Option<Service>,
    command: &mut Command,
    name: &str,
) -> Result<String> {
    let mut process = command.spawn().with_context(|| format!("start {name}"))?;
    let lifeline = process
        .stdin
        .take()
        .context("child lifeline pipe missing")?;
    let child = &mut slot
        .insert(Service {
            process,
            _lifeline: lifeline,
        })
        .process;
    let stdout = child
        .stdout
        .take()
        .context("child readiness pipe missing")?;
    let mut stdout = BufReader::new(stdout);
    let mut line = String::new();
    time::timeout(START_TIMEOUT, (&mut stdout).take(256).read_line(&mut line))
        .await
        .with_context(|| format!("{name} did not become ready"))??;
    ensure!(line.ends_with('\n'), "{name} did not report readiness");
    tokio::spawn(async move {
        let _ = tokio::io::copy(&mut stdout, &mut tokio::io::sink()).await;
    });
    Ok(line.trim().to_owned())
}

async fn stop_child(child: &mut Child) -> Result<()> {
    if child.try_wait()?.is_some() {
        return Ok(());
    }
    let pid = i32::try_from(child.id().context("child PID missing")?)?;
    // SAFETY: the positive PID comes from a child whose wait handle we hold.
    if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            force_reap(child)
                .await
                .context("kill child after SIGTERM failed")?;
            return Err(error).context("send SIGTERM");
        }
    }
    match time::timeout(STOP_TIMEOUT, child.wait()).await {
        Ok(exit) => successful_exit(exit?),
        Err(_) => {
            force_reap(child)
                .await
                .context("kill child after shutdown timeout")?;
            bail!("child did not stop gracefully before the shutdown deadline");
        }
    }
}

async fn force_reap(child: &mut Child) -> Result<()> {
    child.start_kill()?;
    time::timeout(KILL_TIMEOUT, child.wait())
        .await
        .context("killed child did not exit")??;
    Ok(())
}

fn successful_exit(exit: ExitStatus) -> Result<()> {
    ensure!(
        exit.success() || exit.signal() == Some(libc::SIGTERM),
        "child exited with {exit}"
    );
    Ok(())
}

struct Credentials {
    gateway: String,
    operator: String,
    host: String,
}

impl Credentials {
    fn load(directory: &Path) -> Result<Self> {
        let value = read_private(&directory.join(CREDENTIALS))?;
        // Parsing errors stay generic because this file contains credentials.
        let value: Value = serde_json::from_str(&value)
            .map_err(|_| anyhow::anyhow!("invalid local credential bundle"))?;
        let token = |key| {
            value
                .get(key)
                .and_then(Value::as_str)
                .filter(|token| {
                    token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                .map(str::to_owned)
                .context("invalid local credential bundle")
        };
        let credentials = Self {
            gateway: token("gateway_token")?,
            operator: token("operator_token")?,
            host: token("host_token")?,
        };
        ensure!(
            credentials.gateway != credentials.operator
                && credentials.gateway != credentials.host
                && credentials.operator != credentials.host,
            "local credential bundle must contain distinct tokens"
        );
        Ok(credentials)
    }

    fn load_or_create(directory: &Path) -> Result<Self> {
        let path = directory.join(CREDENTIALS);
        match fs::symlink_metadata(&path) {
            Ok(_) => Self::load(directory),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let token = || format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
                let credentials = Self {
                    gateway: token(),
                    operator: token(),
                    host: token(),
                };
                let bytes = serde_json::to_vec(&json!({
                    "gateway_token": credentials.gateway,
                    "operator_token": credentials.operator,
                    "host_token": credentials.host,
                }))?;
                write_private(directory, CREDENTIALS, &bytes)?;
                Ok(credentials)
            }
            Err(error) => Err(error).context("inspect local credential bundle"),
        }
    }
}

fn announce(directory: &Path, endpoint: &str) -> Result<()> {
    let endpoint = format!("{endpoint}\n");
    write_private(directory, ENDPOINT, endpoint.as_bytes())?;
    let mut stdout = io::stdout().lock();
    stdout.write_all(endpoint.as_bytes())?;
    stdout.flush()?;
    Ok(())
}

fn remove_endpoint(directory: &Path) -> Result<()> {
    match fs::remove_file(directory.join(ENDPOINT)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).context("remove local Gateway endpoint"),
    }
}

fn write_private(directory: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    let temporary = directory.join(format!(".{name}.{}.tmp", Uuid::new_v4().simple()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    let written = (|| -> io::Result<()> {
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, directory.join(name))?;
        File::open(directory)?.sync_all()
    })();
    if written.is_err() {
        let _ = fs::remove_file(temporary);
    }
    written.with_context(|| format!("write local {name}"))
}

fn read_private(path: &Path) -> Result<String> {
    let mut value = String::new();
    open_private_file(path, false)?
        .take(4097)
        .read_to_string(&mut value)?;
    ensure!(value.len() <= 4096, "local state file is too large");
    Ok(value)
}

fn open_private_file(path: &Path, create: bool) -> Result<File> {
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

fn private_directory(path: &Path) -> Result<PathBuf> {
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

fn loopback_address(value: &str) -> Result<SocketAddr> {
    let address: SocketAddr = value.parse().context("invalid local service address")?;
    ensure!(
        address.ip().is_loopback() && address.port() != 0,
        "invalid local service address"
    );
    Ok(address)
}

fn sqlite_url(database: &Path) -> Result<String> {
    let mut url = String::from("sqlite://");
    let path = database
        .to_str()
        .context("local database path must be UTF-8")?;
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"/-._~".contains(&byte) {
            url.push(char::from(byte));
        } else {
            write!(url, "%{byte:02X}")?;
        }
    }
    url.push_str("?mode=rw");
    Ok(url)
}
