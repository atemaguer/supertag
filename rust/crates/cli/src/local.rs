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
    sync::Arc,
    time::Duration,
};

use crate::{
    lifecycle::{self, ServiceStatus},
    local_config::Environment,
};

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader},
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
/// Non-secret variables every local service inherits from the supervisor.
const BASE_ENVIRONMENT: [&str; 8] = [
    "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE",
];
/// Gateway-owned GitHub credentials, given only when a Host serves a Gateway Workspace.
const GATEWAY_GITHUB_ENVIRONMENT: [&str; 7] = [
    "SUPERTAG_GITHUB_ACCOUNT_ID",
    "SUPERTAG_GITHUB_REPOSITORY_ID",
    "SUPERTAG_GITHUB_REPOSITORY",
    "SUPERTAG_GITHUB_TOKEN",
    "SUPERTAG_GITHUB_APP_ID",
    "SUPERTAG_GITHUB_INSTALLATION_ID",
    "SUPERTAG_GITHUB_PRIVATE_KEY_FILE",
];
/// TLS files a Worker Host uses to reach a remote Gateway. The supervisor's own enrollment reads
/// the same process variables, so these never come from `env_file`.
const HOST_TLS_ENVIRONMENT: [&str; 3] = [
    "SUPERTAG_SERVER_CA_FILE",
    "SUPERTAG_CLIENT_CERT_FILE",
    "SUPERTAG_CLIENT_KEY_FILE",
];
pub const LOCAL_SERVICE_LIFELINE: &str = "SUPERTAG_LOCAL_SERVICE_LIFELINE";

pub struct LocalOptions {
    pub state_directory: PathBuf,
    pub adapter: crate::AdapterOptions,
    pub skill_catalog: Option<PathBuf>,
    pub gateway_listen: SocketAddr,
    /// Identifies these settings so a later `supertag up` can leave an unchanged supervisor alone.
    pub fingerprint: String,
}

/// The Worker Host ID of the host `supertag up` starts from flags.
pub const FLAGS_HOST: &str = "local";

/// Where each managed process writes its timestamped log, and whether its lines also reach this
/// supervisor's terminal, prefixed with the service, as `supertag up --foreground` shows them.
#[derive(Clone)]
struct Logs {
    state: PathBuf,
    echo: bool,
}

impl Logs {
    fn new(state: &Path) -> Result<Self> {
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(state.join("logs").join("hosts"))?;
        Ok(Self {
            state: state.to_owned(),
            echo: lifecycle::SupervisorMode::current() == lifecycle::SupervisorMode::Foreground,
        })
    }
}

pub async fn up(options: LocalOptions, shutdown: impl Future<Output = ()>) -> Result<()> {
    ensure!(
        options.gateway_listen.ip().is_loopback(),
        "local Gateway must listen on loopback"
    );
    ensure!(
        options.adapter.is_selected(),
        "select a harness, an adapter, or a local services file"
    );
    options.adapter.provider_environment()?;
    let mut directories = DirBuilder::new();
    directories
        .recursive(true)
        .mode(0o700)
        .create(&options.state_directory)?;
    let directory = private_directory(&options.state_directory)?;
    let lock = open_private_file(&directory.join(STATE_LOCK), true)?;
    lock.try_lock().context("local state is already in use")?;
    remove_endpoint(&directory)?;
    // A crashed supervisor leaves its status behind; it must not describe a reused PID.
    lifecycle::forget(&directory)?;
    let credentials = Credentials::load_or_create(&directory)?;
    let executable = std::env::current_exe()?;

    let mut children = Children::new(&directory)?;
    tokio::pin!(shutdown);
    let start = tokio::select! {
        result = async {
            let endpoint = children.start(&executable, &options, &directory, &credentials).await?;
            undrain(&directory, &endpoint, &credentials.operator).await?;
            Ok(endpoint)
        } => result.map(Some),
        _ = &mut shutdown => Ok(None),
    };
    let result = match start {
        Ok(Some(endpoint)) => match announce(&directory, &endpoint).and_then(|()| {
            let mut services = children.base_status(&endpoint);
            if let Some(host) = &children.worker_host {
                services.push(ServiceStatus {
                    name: FLAGS_HOST.into(),
                    kind: lifecycle::HOST.into(),
                    pid: host.process.id(),
                    address: Some(endpoint.clone()),
                    host_id: Some(FLAGS_HOST.into()),
                    remote: false,
                });
            }
            lifecycle::record(
                &directory,
                &options.fingerprint,
                lifecycle::DEFAULT_INSTANCE,
                Some(&endpoint),
                services,
            )
        }) {
            Ok(()) => tokio::select! {
                result = children.wait_for_exit() => result,
                _ = &mut shutdown => Ok(()),
            },
            Err(error) => Err(error),
        },
        Ok(None) => Ok(()),
        Err(error) => Err(error),
    };
    let removed = remove_endpoint(&directory).and(lifecycle::forget(&directory));
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

struct Children {
    logs: Logs,
    control_plane: Option<Service>,
    control_plane_address: Option<String>,
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
    fn new(directory: &Path) -> Result<Self> {
        Ok(Self {
            logs: Logs::new(directory)?,
            control_plane: None,
            control_plane_address: None,
            gateway: None,
            worker_host: None,
        })
    }

    async fn start_base(
        &mut self,
        executable: &Path,
        directory: &Path,
        credentials: &Credentials,
        gateway_listen: SocketAddr,
        // Present only when a Host serves a Gateway Workspace: the Gateway's GitHub source.
        gateway_workspace: Option<&Environment>,
        bootstrap_host: bool,
    ) -> Result<String> {
        let database = directory.join("runtime.sqlite3");
        open_private_file(&database, true)?;
        let database_url = sqlite_url(&database)?;
        let mut plane = command(executable, "control-plane");
        plane
            .args(["--listen", "127.0.0.1:0"])
            .env("SUPERTAG_DATABASE_URL", database_url)
            .env("SUPERTAG_GATEWAY_TOKEN", &credentials.gateway);
        if bootstrap_host {
            plane.env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &credentials.host);
        }
        let address = start_child(
            &mut self.control_plane,
            &mut plane,
            "Control Plane",
            &self.logs,
            lifecycle::CONTROL_PLANE,
        )
        .await?;
        let control_plane = format!("http://{}", loopback_address(&address)?);
        self.control_plane_address = Some(control_plane.clone());

        let mut gateway = command(executable, "gateway");
        gateway
            .args([
                "--control-plane",
                &control_plane,
                "--listen",
                &gateway_listen.to_string(),
            ])
            .arg("--checkpoint-directory")
            .arg(directory.join("checkpoints"))
            .env("SUPERTAG_GATEWAY_TOKEN", &credentials.gateway)
            .env("SUPERTAG_OPERATOR_TOKEN", &credentials.operator);
        if let Some(environment) = gateway_workspace {
            gateway
                .arg("--github-workspace-directory")
                .arg(directory.join("github-sources"));
            gateway.envs(environment.selected(GATEWAY_GITHUB_ENVIRONMENT));
            #[cfg(feature = "test-fixtures")]
            for name in [
                "SUPERTAG_TEST_GITHUB_API_URL",
                "SUPERTAG_TEST_GITHUB_GIT_URL",
            ] {
                if let Some(value) = std::env::var_os(name) {
                    gateway.env(name, value);
                }
            }
        }
        let address = start_child(
            &mut self.gateway,
            &mut gateway,
            "Gateway",
            &self.logs,
            lifecycle::GATEWAY,
        )
        .await?;
        let endpoint = format!("http://{}", loopback_address(&address)?);

        Ok(endpoint)
    }

    async fn start(
        &mut self,
        executable: &Path,
        options: &LocalOptions,
        directory: &Path,
        credentials: &Credentials,
    ) -> Result<String> {
        let endpoint = self
            .start_base(
                executable,
                directory,
                credentials,
                options.gateway_listen,
                options
                    .adapter
                    .uses_gateway_workspace()
                    .then_some(&Environment::default()),
                true,
            )
            .await?;
        let mut host = command(executable, "worker-host");
        host.args(["--gateway", &endpoint, "--state-directory"])
            .arg(directory.join("host"))
            .arg("--wait-for-recovery")
            .args(options.adapter.worker_args())
            .env("SUPERTAG_HOST_TOKEN", &credentials.host);
        if let Some(catalog) = &options.skill_catalog {
            host.arg("--skill-catalog").arg(catalog);
        }
        host.envs(
            Environment::default()
                .selected(options.adapter.provider_environment()?.iter().copied()),
        );
        let ready = start_child(
            &mut self.worker_host,
            &mut host,
            "Worker Host",
            &self.logs,
            FLAGS_HOST,
        )
        .await?;
        ensure!(ready == "ready", "invalid Worker Host readiness signal");
        Ok(endpoint)
    }

    /// The Control Plane and Gateway rows of the supervisor status file.
    fn base_status(&self, endpoint: &str) -> Vec<ServiceStatus> {
        let mut services = Vec::new();
        if let Some(service) = &self.control_plane {
            services.push(ServiceStatus {
                name: lifecycle::CONTROL_PLANE.into(),
                kind: lifecycle::CONTROL_PLANE.into(),
                pid: service.process.id(),
                address: self.control_plane_address.clone(),
                host_id: None,
                remote: false,
            });
        }
        if let Some(service) = &self.gateway {
            services.push(ServiceStatus {
                name: lifecycle::GATEWAY.into(),
                kind: lifecycle::GATEWAY.into(),
                pid: service.process.id(),
                address: Some(endpoint.to_owned()),
                host_id: None,
                remote: false,
            });
        }
        services
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
            BASE_ENVIRONMENT
                .into_iter()
                .filter_map(|name| std::env::var_os(name).map(|value| (name, value))),
        )
        .env(LOCAL_SERVICE_LIFELINE, "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    command
}

async fn start_child(
    slot: &mut Option<Service>,
    command: &mut Command,
    name: &str,
    logs: &Logs,
    service: &str,
) -> Result<String> {
    let mut process = command.spawn().with_context(|| format!("start {name}"))?;
    if let Some(stderr) = process.stderr.take() {
        let path = lifecycle::log_path(&logs.state, service);
        let file = OpenOptions::new()
            .append(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
            .with_context(|| format!("open {}", path.display()))?;
        tokio::spawn(copy_log(
            stderr,
            tokio::fs::File::from_std(file),
            logs.echo.then(|| service.to_owned()),
        ));
    }
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

/// Copy a child's stderr into its log, one ISO 8601 timestamp per line, and with `echo` also to
/// this terminal prefixed by the service name.
async fn copy_log(
    stderr: tokio::process::ChildStderr,
    mut file: tokio::fs::File,
    echo: Option<String>,
) {
    let mut reader = BufReader::new(stderr);
    let mut line = Vec::new();
    loop {
        line.clear();
        match (&mut reader)
            .take(64 * 1024)
            .read_until(b'\n', &mut line)
            .await
        {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if !line.ends_with(b"\n") {
            line.push(b'\n');
        }
        let mut stamped = lifecycle::timestamp(std::time::SystemTime::now()).into_bytes();
        stamped.push(b' ');
        stamped.extend_from_slice(&line);
        let _ = file.write_all(&stamped).await;
        if let Some(service) = &echo {
            let mut prefixed = format!("{service} | ").into_bytes();
            prefixed.extend_from_slice(&line);
            let _ = io::stderr().lock().write_all(&prefixed);
        }
    }
    let _ = file.flush().await;
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

pub(crate) struct Credentials {
    gateway: String,
    pub(crate) operator: String,
    host: String,
}

impl Credentials {
    pub(crate) fn load(directory: &Path) -> Result<Self> {
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

pub(crate) fn write_private(directory: &Path, name: &str, bytes: &[u8]) -> Result<()> {
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

pub(crate) fn read_private(path: &Path) -> Result<String> {
    let mut value = String::new();
    open_private_file(path, false)?
        .take(4097)
        .read_to_string(&mut value)?;
    ensure!(value.len() <= 4096, "local state file is too large");
    Ok(value)
}

pub(crate) fn open_private_file(path: &Path, create: bool) -> Result<File> {
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

pub(crate) fn private_directory(path: &Path) -> Result<PathBuf> {
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

struct ManagedHost {
    logs: Logs,
    definition: crate::local_config::Host,
    environment: Arc<Environment>,
    endpoint: String,
    directory: PathBuf,
    service: Option<Service>,
}
impl ManagedHost {
    async fn start(&mut self, executable: &Path) -> Result<()> {
        let mut host = command(executable, "worker-host");
        host.args(["--gateway", &self.endpoint, "--state-directory"])
            .arg(&self.directory)
            .arg("--wait-for-recovery")
            .args(self.definition.adapter.worker_args());
        if let Some(path) = &self.definition.skills {
            host.arg("--skill-catalog").arg(path);
        }
        // Only this harness's provider credentials, from the shell or env_file. Service tokens
        // and other harnesses' credentials never reach the Worker Host or its harness children.
        host.envs(
            self.environment.selected(
                self.definition
                    .adapter
                    .provider_environment()?
                    .iter()
                    .copied(),
            ),
        );
        host.envs(
            HOST_TLS_ENVIRONMENT
                .into_iter()
                .filter_map(|name| std::env::var_os(name).map(|value| (name, value))),
        );
        let ready = start_child(
            &mut self.service,
            &mut host,
            &format!("Worker Host {}", self.definition.name),
            &self.logs,
            &self.definition.name,
        )
        .await?;
        ensure!(ready == "ready", "invalid Worker Host readiness signal");
        Ok(())
    }
}

/// Supervise explicitly configured services. Each named Host owns one credential and journal.
pub async fn configured(
    config: crate::local_config::Config,
    state: PathBuf,
    shutdown: impl Future<Output = ()>,
) -> Result<()> {
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&state)?;
    let directory = private_directory(&state)?;
    let lock = open_private_file(&directory.join(STATE_LOCK), true)?;
    lock.try_lock().context("local state is already in use")?;
    remove_endpoint(&directory)?;
    // A crashed supervisor leaves its status behind; it must not describe a reused PID.
    lifecycle::forget(&directory)?;
    let executable = std::env::current_exe()?;
    let environment = Arc::new(config.environment);
    let mut base = Children::new(&directory)?;
    let logs = base.logs.clone();
    let fingerprint = config.digest.clone();
    let instance = config.name.clone();
    let mut announced: Option<String> = None;
    let mut hosts = Vec::new();
    tokio::pin!(shutdown);
    let startup = async {
        let credentials = config
            .plane
            .as_ref()
            .map(|_| Credentials::load_or_create(&directory))
            .transpose()?;
        let endpoint = if let Some(plane) = config.plane {
            // An enrolled installation pins its Gateway origin. Reuse an initially selected
            // random loopback port on restart instead of silently retargeting credentials.
            let listen = stable_listen(&directory, plane.listen)?;
            let endpoint = base
                .start_base(
                    &executable,
                    &directory,
                    credentials.as_ref().expect("local credentials"),
                    listen,
                    config
                        .hosts
                        .iter()
                        .any(|h| h.adapter.uses_gateway_workspace())
                        .then_some(&*environment),
                    false,
                )
                .await?;
            write_private(
                &directory,
                "gateway-address",
                endpoint
                    .strip_prefix("http://")
                    .expect("loopback origin")
                    .as_bytes(),
            )?;
            if !plane.provision.is_empty() {
                let channel = crate::network::endpoint(endpoint.clone(), false)
                    .await?
                    .connect()
                    .await?;
                crate::manifests::provision(
                    channel,
                    &credentials.as_ref().expect("local credentials").operator,
                    plane.provision,
                )
                .await?;
            }
            Some(endpoint)
        } else {
            None
        };
        for definition in config.hosts {
            let target = definition
                .gateway
                .clone()
                .or_else(|| endpoint.clone())
                .context("host Gateway is unavailable")?;
            let host_directory = directory.join("hosts").join(&definition.name);
            enroll_configured(
                &definition,
                &environment,
                &target,
                &host_directory,
                credentials
                    .as_ref()
                    .filter(|_| definition.gateway.is_none()),
            )
            .await?;
            let index = hosts.len();
            hosts.push(ManagedHost {
                logs: logs.clone(),
                definition,
                environment: environment.clone(),
                endpoint: target,
                directory: host_directory,
                service: None,
            });
            hosts[index].start(&executable).await?;
        }
        if let (Some(endpoint), Some(credentials)) = (&endpoint, &credentials) {
            undrain(&directory, endpoint, &credentials.operator).await?;
        }
        if let Some(endpoint) = &endpoint {
            announce(&directory, endpoint)?;
        } else {
            // Host-only machines hold no operator credential and cannot use --state-directory
            // to impersonate an operator on the remote Gateway.
            let mut stdout = io::stdout().lock();
            stdout.write_all(b"ready\n")?;
            stdout.flush()?;
        }
        announced = endpoint;
        Ok::<_, anyhow::Error>(())
    };
    let started = tokio::select! {result=startup=>result.map(|()|true),_=&mut shutdown=>Ok(false)};
    let status = |base: &Children, hosts: &[ManagedHost]| {
        let mut services = announced
            .as_deref()
            .map(|endpoint| base.base_status(endpoint))
            .unwrap_or_default();
        for host in hosts {
            services.push(ServiceStatus {
                name: host.definition.name.clone(),
                kind: lifecycle::HOST.into(),
                pid: host
                    .service
                    .as_ref()
                    .and_then(|service| service.process.id()),
                address: Some(host.endpoint.clone()),
                host_id: Some(host.definition.name.clone()),
                remote: host.definition.gateway.is_some(),
            });
        }
        lifecycle::record(
            &directory,
            &fingerprint,
            &instance,
            announced.as_deref(),
            services,
        )
    };
    let result = match started.and_then(|started| {
        if started {
            status(&base, &hosts)?;
        }
        Ok(started)
    }) {
        Ok(true) => {
            tokio::select! {result=wait_configured(&mut base,&mut hosts,&executable,&status)=>result,_=&mut shutdown=>Ok(())}
        }
        Ok(false) => Ok(()),
        Err(error) => Err(error),
    };
    let mut failures = Vec::new();
    let mut stops = tokio::task::JoinSet::new();
    for host in &mut hosts {
        if let Some(mut service) = host.service.take() {
            let name = host.definition.name.clone();
            stops.spawn(async move {
                stop_child(&mut service.process)
                    .await
                    .with_context(|| format!("stop Worker Host {name}"))
            });
        }
    }
    while let Some(stopped) = stops.join_next().await {
        if let Err(error) = stopped
            .context("Worker Host shutdown task failed")
            .and_then(|r| r)
        {
            failures.push(format!("{error:#}"));
        }
    }
    if let Err(error) = base.stop().await {
        failures.push(format!("{error:#}"));
    }
    if let Err(error) = remove_endpoint(&directory).and(lifecycle::forget(&directory)) {
        failures.push(format!("{error:#}"));
    }
    drop(lock);
    if !failures.is_empty() {
        return Err(anyhow::anyhow!(
            "local service cleanup failed: {}",
            failures.join("; ")
        ))
        .context(
            result
                .err()
                .map(|e| e.to_string())
                .unwrap_or_else(|| "stopping local services".into()),
        );
    }
    result
}
fn stable_listen(directory: &Path, configured: SocketAddr) -> Result<SocketAddr> {
    let path = directory.join("gateway-address");
    match fs::symlink_metadata(&path) {
        Ok(_) => {
            let address = loopback_address(read_private(&path)?.trim())?;
            ensure!(
                address.ip() == configured.ip()
                    && (configured.port() == 0 || configured.port() == address.port()),
                "stored local Gateway address differs from configured listener"
            );
            Ok(address)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(configured),
        Err(error) => Err(error.into()),
    }
}
async fn enroll_configured(
    definition: &crate::local_config::Host,
    environment: &Environment,
    endpoint: &str,
    state: &Path,
    local: Option<&Credentials>,
) -> Result<()> {
    let gateway = crate::network::endpoint(endpoint.into(), false).await?;
    match supertag_worker_host::enroll(gateway.clone(), state, definition.name.clone(), None).await
    {
        Ok(_) => return Ok(()),
        // The enrollment helper checks any stored receipt before asking for an Auth Key.
        // A consumed key is intentionally not required again after a confirmed enrollment.
        Err(error) if error.to_string() == "Auth Key required" => {}
        Err(error) => return Err(error),
    }
    let key = if let Some(credentials) = local {
        use sha2::{Digest, Sha256};
        use supertag_protocol::v2::{CreateAuthKeyRequest, operator_client::OperatorClient};
        let key = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        OperatorClient::new(gateway.connect_lazy())
            .create_auth_key(crate::request(
                CreateAuthKeyRequest {
                    host_id: definition.name.clone(),
                    operation_id: Uuid::new_v4().to_string(),
                    key_digest: Sha256::digest(key.as_bytes()).to_vec(),
                    expires_in_ms: 600_000,
                    allowed_tag_ids: vec![],
                    all_tags: true,
                },
                &credentials.operator,
            )?)
            .await?;
        key
    } else {
        definition
            .key
            .as_ref()
            .context("remote Worker Host needs an Auth Key secret for its first enrollment")?
            .read(environment)?
    };
    supertag_worker_host::enroll(gateway, state, definition.name.clone(), Some(&key)).await?;
    Ok(())
}
async fn wait_configured(
    base: &mut Children,
    hosts: &mut [ManagedHost],
    executable: &Path,
    status: &impl Fn(&Children, &[ManagedHost]) -> Result<()>,
) -> Result<()> {
    loop {
        let mut restarted = false;
        for (name, service) in [
            ("Control Plane", base.control_plane.as_mut()),
            ("Gateway", base.gateway.as_mut()),
        ] {
            if let Some(service) = service
                && let Some(status) = service.process.try_wait()?
            {
                bail!("{name} exited unexpectedly with {status}");
            }
        }
        for host in hosts.iter_mut() {
            if let Some(status) = host
                .service
                .as_mut()
                .expect("started Host")
                .process
                .try_wait()?
            {
                ensure!(
                    host.definition.restart == crate::local_config::Restart::UnlessStopped,
                    "Worker Host {} exited unexpectedly with {status}",
                    host.definition.name
                );
                host.service.take();
                time::sleep(Duration::from_secs(1)).await;
                host.start(executable).await?;
                restarted = true;
            }
        }
        if restarted {
            status(base, hosts)?;
        }
        time::sleep(Duration::from_millis(100)).await;
    }
}

/// Return Worker Hosts that `supertag down` drained to service. An operator's own drain, made
/// with `supertag host drain`, is not recorded here and survives a restart.
async fn undrain(directory: &Path, endpoint: &str, operator: &str) -> Result<()> {
    let hosts = lifecycle::drained_hosts(directory)?;
    if hosts.is_empty() {
        return Ok(());
    }
    use supertag_protocol::v2::{SetHostDrainingRequest, operator_client::OperatorClient};
    let channel = crate::network::endpoint(endpoint.into(), false)
        .await?
        .connect()
        .await?;
    let mut client = OperatorClient::new(channel);
    for host_id in hosts {
        match client
            .set_host_draining(crate::request(
                SetHostDrainingRequest {
                    host_id: host_id.clone(),
                    draining: false,
                },
                operator,
            )?)
            .await
        {
            Ok(_) => {}
            Err(status) if status.code() == tonic::Code::NotFound => {}
            Err(status) => {
                return Err(status).with_context(|| format!("resume Worker Host {host_id}"));
            }
        }
    }
    lifecycle::clear_drained_hosts(directory)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn enrolled_gateway_origin_cannot_be_retargeted_by_config() {
        let temp = tempfile::tempdir().unwrap();
        write_private(temp.path(), "gateway-address", b"127.0.0.1:19876").unwrap();
        assert_eq!(
            stable_listen(temp.path(), "127.0.0.1:0".parse().unwrap()).unwrap(),
            "127.0.0.1:19876".parse::<SocketAddr>().unwrap()
        );
        assert!(stable_listen(temp.path(), "127.0.0.1:19877".parse().unwrap()).is_err());
        assert_eq!(
            read_private(&temp.path().join("gateway-address")).unwrap(),
            "127.0.0.1:19876"
        );
    }
}
