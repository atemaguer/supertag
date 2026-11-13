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
    local_config::{
        Environment,
        surfaces::{Provider, Surface},
    },
};
use std::collections::BTreeMap;
use supertag_worker_host::LaneState;

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
/// The credential vault selection the Gateway's Surface connectors use.
pub(crate) const CREDENTIAL_VAULT_ENVIRONMENT: [&str; 6] = [
    "SUPERTAG_CREDENTIAL_VAULT",
    "VAULT_ADDR",
    "VAULT_TOKEN",
    "SUPERTAG_VAULT_MOUNT",
    "SUPERTAG_VAULT_PATH_PREFIX",
    "VAULT_NAMESPACE",
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
    // Workspaces mapped from flags deliver to their repositories as Session branches.
    let repositories: crate::delivery_branches::Repositories = options
        .adapter
        .workspace_mappings()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|mapping| match mapping.source {
            supertag_worker_host::WorkspaceSource::Local(path) => {
                Some((mapping.workspace_id, path))
            }
            supertag_worker_host::WorkspaceSource::Gateway => None,
        })
        .collect();
    let importer = match &start {
        Ok(Some(endpoint)) if !repositories.is_empty() => {
            Some(tokio::spawn(crate::delivery_branches::follow(
                endpoint.clone(),
                credentials.operator.clone(),
                directory.clone(),
                repositories,
                supervisor_log,
            )))
        }
        _ => None,
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
                    concurrency: None,
                });
            }
            lifecycle::record(
                &directory,
                &options.fingerprint,
                "",
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
    if let Some(importer) = importer {
        importer.abort();
    }
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

/// One timestamped line in the supervisor's own log, which is its standard error.
fn supervisor_log(line: &str) {
    errln!(
        "{} {line}",
        lifecycle::timestamp(std::time::SystemTime::now())
    );
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

/// What the local Gateway serves beyond its gRPC API.
struct GatewayExtras<'a> {
    /// Present only when a Host serves a Gateway Workspace: the Gateway's GitHub source.
    workspace: Option<&'a Environment>,
    /// Configured Surface connectors and the environment their credential vault comes from.
    surfaces: Option<(&'a BTreeMap<String, Surface>, &'a Environment)>,
}

struct Children {
    logs: Logs,
    control_plane: Option<Service>,
    control_plane_address: Option<String>,
    gateway: Option<Service>,
    worker_host: Option<Service>,
    /// The Gateway's `--notify` values and the environment their webhook secrets reach it in.
    notify: (Vec<String>, Vec<(String, String)>),
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
            notify: crate::local_config::Notifications::default().resolve(&Environment::default()),
        })
    }

    async fn start_base(
        &mut self,
        executable: &Path,
        directory: &Path,
        credentials: &Credentials,
        gateway_listen: SocketAddr,
        extras: GatewayExtras<'_>,
        bootstrap_host: bool,
    ) -> Result<String> {
        let GatewayExtras {
            workspace: gateway_workspace,
            surfaces,
        } = extras;
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
        for destination in &self.notify.0 {
            gateway.arg("--notify").arg(destination);
        }
        gateway.envs(self.notify.1.iter().map(|(name, value)| (name, value)));
        #[cfg(feature = "test-fixtures")]
        for name in [
            "SUPERTAG_TEST_DESKTOP_NOTIFIER",
            "SUPERTAG_TEST_NOTIFY_LOOPBACK_HTTP",
        ] {
            if let Some(value) = std::env::var_os(name) {
                gateway.env(name, value);
            }
        }
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
        // Configured Surface connectors read their secrets from the credential vault that
        // `supertag setup surface` wrote: this state directory's file, unless Vault is selected.
        if let Some((surfaces, environment)) = surfaces {
            // Both read the same SUPERTAG_GITHUB_* variables in one Gateway process.
            ensure!(
                gateway_workspace.is_none()
                    || !surfaces.values().any(|surface| {
                        surface.provider == Provider::Github && surface.location.is_some()
                    }),
                "a GitHub surface location cannot share the local Gateway with a Gateway Workspace; remove the location with supertag tag update TAG --remove-location github"
            );
            let mut connected = false;
            for (name, surface) in surfaces {
                if let Some((args, variables)) = surface.gateway(name, directory)? {
                    gateway.args(args).envs(variables);
                    connected = true;
                }
            }
            if connected {
                gateway
                    .env("SUPERTAG_STATE_DIR", directory)
                    .envs(environment.selected(CREDENTIAL_VAULT_ENVIRONMENT));
                #[cfg(feature = "test-fixtures")]
                for name in [
                    "SUPERTAG_TEST_SLACK_API_URL",
                    "SUPERTAG_TEST_GITHUB_API_URL",
                    "SUPERTAG_TEST_LINEAR_API_URL",
                    "SUPERTAG_TEST_LARK_ORIGIN",
                    "SUPERTAG_TEST_MICROSOFT_TEAMS_ORIGIN",
                ] {
                    if let Some(value) = std::env::var_os(name) {
                        gateway.env(name, value);
                    }
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
                GatewayExtras {
                    workspace: options
                        .adapter
                        .uses_gateway_workspace()
                        .then_some(&Environment::default()),
                    surfaces: None,
                },
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
                concurrency: None,
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
                concurrency: None,
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
    capture_log(&mut process, logs, service)?;
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

/// Append a child's stderr to the named service's log.
fn capture_log(process: &mut tokio::process::Child, logs: &Logs, service: &str) -> Result<()> {
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
    Ok(())
}

/// Append one timestamped line to a service's log, and with `echo` also to this terminal.
fn note_line(logs: &Logs, service: &str, line: &str) -> Result<()> {
    let path = lifecycle::log_path(&logs.state, service);
    let mut file = OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .with_context(|| format!("open {}", path.display()))?;
    let line = line.replace('\n', " ");
    writeln!(
        file,
        "{} {line}",
        lifecycle::timestamp(std::time::SystemTime::now())
    )?;
    if logs.echo {
        errln!("{service} | {}", crate::terminal::text(&line));
    }
    Ok(())
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
            // Service output records text from surfaces and harnesses; filter it for the terminal.
            let text = String::from_utf8_lossy(&line);
            errln!(
                "{service} | {}",
                crate::terminal::text(text.trim_end_matches('\n').trim_end_matches('\r'))
            );
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
    // terminal-safe: the endpoint this process bound, read by the parent as a handshake.
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

/// One configured Worker Host: a single enrollment and registration shared by its lanes.
struct ManagedHost {
    logs: Logs,
    definition: crate::local_config::Host,
    environment: Arc<Environment>,
    endpoint: String,
    directory: PathBuf,
    lanes: Vec<ManagedLane>,
    states: Arc<LaneStates>,
    presence: Option<Presence>,
    /// The registered incarnation and Host credential every lane presents.
    authority: Option<(String, String)>,
}

/// One execution lane: a Worker Host process that runs one Attempt of one harness at a time.
struct ManagedLane {
    harness: usize,
    /// The lane's number among its harness's lanes, which names its state directory.
    slot: u32,
    directory: PathBuf,
    service: Option<Service>,
    /// Lowered `concurrency` asked the lane to stop once it holds no Attempt.
    retiring: bool,
    /// Raised `concurrency` wants the retiring lane back once it stopped.
    respawn: bool,
}

#[derive(Default)]
struct LaneStates {
    states: std::sync::Mutex<Vec<LaneState>>,
    /// Each lane's harness, or `None` for a lane that lowered `concurrency` stopped.
    harness_of: std::sync::Mutex<Vec<Option<usize>>>,
    /// The lanes each harness runs, as presence reports them.
    capacity: std::sync::atomic::AtomicU32,
    changed: tokio::sync::Notify,
    /// Presence reports the Control Plane answered, current or transiently unavailable.
    reports: std::sync::atomic::AtomicU64,
}

impl LaneStates {
    fn set(&self, lane: usize, state: LaneState) {
        let mut states = self.states.lock().expect("lane states");
        if states[lane] != state {
            states[lane] = state;
            drop(states);
            self.changed.notify_one();
        }
    }
}

impl ManagedLane {
    fn new(
        harness: usize,
        slot: u32,
        host: &Path,
        adapter: &crate::harness::AdapterOptions,
    ) -> Self {
        Self {
            harness,
            slot,
            directory: host
                .join("lanes")
                .join(format!("{}-{slot}", lane_name(adapter.harness_kind()))),
            service: None,
            retiring: false,
            respawn: false,
        }
    }
}

struct Presence {
    stop: tokio_util::sync::CancellationToken,
    task: tokio::task::JoinHandle<Result<()>>,
}

impl ManagedHost {
    fn new(
        logs: Logs,
        definition: crate::local_config::Host,
        environment: Arc<Environment>,
        endpoint: String,
        directory: PathBuf,
    ) -> Self {
        let mut lanes = Vec::new();
        for (harness, adapter) in definition.harnesses.iter().enumerate() {
            for slot in 0..definition.concurrency {
                lanes.push(ManagedLane::new(harness, slot, &directory, adapter));
            }
        }
        let states = Arc::new(LaneStates {
            states: std::sync::Mutex::new(vec![LaneState::Pending; lanes.len()]),
            harness_of: std::sync::Mutex::new(
                lanes.iter().map(|lane| Some(lane.harness)).collect(),
            ),
            capacity: std::sync::atomic::AtomicU32::new(definition.concurrency),
            ..Default::default()
        });
        Self {
            logs,
            definition,
            environment,
            endpoint,
            directory,
            lanes,
            states,
            presence: None,
            authority: None,
        }
    }

    /// Attempt journals no configured lane will read: the single-process layout's own journal,
    /// or a lane removed by lowering `concurrency` or dropping a harness.
    fn stranded_journals(&self) -> Result<Vec<PathBuf>> {
        let mut stranded = Vec::new();
        if supertag_worker_host::holds_attempt(&self.directory) {
            stranded.push(self.directory.clone());
        }
        let configured = self
            .lanes
            .iter()
            .map(|lane| lane.directory.clone())
            .collect::<std::collections::HashSet<_>>();
        match std::fs::read_dir(self.directory.join("lanes")) {
            Ok(entries) => {
                for entry in entries {
                    let path = entry?.path();
                    if !configured.contains(&path) && supertag_worker_host::holds_attempt(&path) {
                        stranded.push(path);
                    }
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        stranded.sort();
        Ok(stranded)
    }

    /// Keep a stranded journal for inspection where no lane reads it again. Its Attempt was
    /// fenced when the replacement incarnation registered.
    fn retire(&self, stranded: &[PathBuf]) -> Result<()> {
        if stranded.is_empty() {
            return Ok(());
        }
        let retired = self
            .directory
            .join("retired")
            .join(Uuid::new_v4().simple().to_string());
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&retired)?;
        for path in stranded {
            if *path == self.directory {
                // Single-process layout: its Workspace and Session state stays in place.
                let host = retired.join("host");
                DirBuilder::new().mode(0o700).create(&host)?;
                for name in ["attempt.json", "checkpoint.bin"] {
                    match std::fs::rename(path.join(name), host.join(name)) {
                        Ok(()) => {}
                        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                        Err(error) => return Err(error.into()),
                    }
                }
            } else {
                std::fs::rename(path, retired.join(path.file_name().context("lane name")?))?;
            }
        }
        Ok(())
    }

    /// Register the Host once, report its aggregate presence, then start every lane.
    async fn start(&mut self, executable: &Path) -> Result<()> {
        let gateway = crate::network::endpoint(self.endpoint.clone(), false).await?;
        let stranded = self.stranded_journals()?;
        let shared = supertag_worker_host::SharedHost::register(
            gateway,
            &self.directory,
            !stranded.is_empty(),
            &tokio_util::sync::CancellationToken::new(),
        )
        .await?
        .context("Worker Host registration was cancelled")?;
        self.retire(&stranded)?;
        let incarnation = shared.incarnation_id().to_owned();
        let token = shared.token().to_owned();
        self.authority = Some((incarnation.clone(), token.clone()));
        let mut slots = Vec::new();
        for adapter in &self.definition.harnesses {
            slots.push(supertag_worker_host::HarnessSlots {
                harness: adapter.harness_kind(),
                profile: configured_profile(adapter)?,
                // Reported from the shared lane states, which a concurrency change updates.
                capacity: 0,
            });
        }
        let workspaces = match self.definition.harnesses.first() {
            Some(adapter) => adapter
                .workspace_mappings()?
                .into_iter()
                .filter(|mapping| match &mapping.source {
                    supertag_worker_host::WorkspaceSource::Local(path) => path.is_dir(),
                    supertag_worker_host::WorkspaceSource::Gateway => true,
                })
                .map(|mapping| mapping.workspace_id)
                .collect(),
            None => vec![],
        };
        self.presence = Some(report_presence(
            shared,
            slots,
            workspaces,
            self.states.clone(),
        ));
        for lane in 0..self.lanes.len() {
            self.start_lane(lane, executable, &incarnation, &token)
                .await?;
        }
        Ok(())
    }

    async fn start_lane(
        &mut self,
        index: usize,
        executable: &Path,
        incarnation: &str,
        token: &str,
    ) -> Result<()> {
        let lane = &mut self.lanes[index];
        let adapter = &self.definition.harnesses[lane.harness];
        let mut host = command(executable, "worker-host");
        host.args(["--gateway", &self.endpoint, "--state-directory"])
            .arg(&lane.directory)
            .arg("--wait-for-recovery")
            .args(["--supervised-lane", incarnation])
            .args(adapter.worker_args());
        if let Some(path) = &self.definition.skills
            && loads_skills(adapter.harness_kind())
        {
            host.arg("--skill-catalog").arg(path);
        }
        // Only this lane's harness credentials, from the shell or env_file. Service tokens and
        // other harnesses' credentials never reach the lane or its harness children.
        host.envs(
            self.environment
                .selected(adapter.provider_environment()?.iter().copied()),
        );
        host.envs(
            HOST_TLS_ENVIRONMENT
                .into_iter()
                .filter_map(|name| std::env::var_os(name).map(|value| (name, value))),
        );
        // The lane presents the Host credential; the guardian clears it for harness children.
        host.env("SUPERTAG_HOST_TOKEN", token);
        let name = format!("Worker Host {} lane {index}", self.definition.name);
        let mut process = host.spawn().with_context(|| format!("start {name}"))?;
        // Every lane of a Host writes to the Host's one log.
        capture_log(&mut process, &self.logs, &self.definition.name)?;
        let lifeline = process
            .stdin
            .take()
            .context("child lifeline pipe missing")?;
        let stdout = process
            .stdout
            .take()
            .context("child readiness pipe missing")?;
        lane.service = Some(Service {
            process,
            _lifeline: lifeline,
        });
        let states = self.states.clone();
        states.set(index, LaneState::Pending);
        let (ready, started) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let mut ready = Some(ready);
            let mut lines = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match (&mut lines).take(256).read_line(&mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                match line.trim() {
                    "ready" => {
                        if let Some(ready) = ready.take() {
                            let _ = ready.send(());
                        }
                    }
                    other => {
                        if let Some(state) = other.strip_prefix("state ").and_then(LaneState::parse)
                        {
                            states.set(index, state);
                        }
                    }
                }
            }
            // A stopped lane offers no capacity until its replacement reports.
            states.set(index, LaneState::Pending);
        });
        time::timeout(START_TIMEOUT, started)
            .await
            .with_context(|| format!("{name} did not become ready"))?
            .with_context(|| format!("{name} did not report readiness"))?;
        Ok(())
    }

    /// After a lane exits, report presence once more and wait for the answer, so a replaced or
    /// revoked registration is reported as such instead of as an ordinary lane failure.
    async fn confirm_registration(&mut self) -> Result<()> {
        let Some(presence) = &mut self.presence else {
            bail!("presence reporting stopped");
        };
        let before = self
            .states
            .reports
            .load(std::sync::atomic::Ordering::SeqCst);
        self.states.changed.notify_one();
        let deadline = time::Instant::now() + Duration::from_secs(10);
        while !presence.task.is_finished()
            && self
                .states
                .reports
                .load(std::sync::atomic::Ordering::SeqCst)
                == before
            && time::Instant::now() < deadline
        {
            time::sleep(Duration::from_millis(20)).await;
        }
        if presence.task.is_finished() {
            let presence = self.presence.take().expect("presence task");
            return Err(match presence.task.await {
                Ok(Err(error)) => error,
                Ok(Ok(())) => anyhow::anyhow!("presence reporting stopped"),
                Err(error) => anyhow::anyhow!("presence reporting failed: {error}"),
            });
        }
        Ok(())
    }

    async fn restart_lane(&mut self, index: usize, executable: &Path) -> Result<()> {
        let (incarnation, token) = self
            .authority
            .clone()
            .context("Worker Host was not registered")?;
        self.start_lane(index, executable, &incarnation, &token)
            .await
    }

    /// Start a lane a raised `concurrency` added. A lane that does not start is stopped and left
    /// out, with the reason in the Host's log, so the running lanes and their Attempts go on;
    /// the next `supertag up` that changes `concurrency` tries it again.
    async fn raise_lane(&mut self, index: usize, executable: &Path) -> Result<()> {
        let Err(error) = self.restart_lane(index, executable).await else {
            return Ok(());
        };
        if let Some(mut service) = self.lanes[index].service.take() {
            let _ = service.process.start_kill();
            let _ = service.process.wait().await;
        }
        self.states.harness_of.lock().expect("lane harnesses")[index] = None;
        self.states.set(index, LaneState::Pending);
        note_line(
            &self.logs,
            &self.definition.name,
            &format!(
                "lane {} did not start and stays stopped: {error:#}",
                self.lanes[index].directory.display()
            ),
        )
    }

    /// Run `concurrency` lanes per harness without a restart. Raised lanes start under the
    /// Host's current registration. Lowered lanes are asked to stop once they hold no Attempt,
    /// so a running Attempt finishes and the lane's journal is left empty; presence reports the
    /// new capacity at once, so no new work is admitted beyond it.
    async fn resize(&mut self, concurrency: u32, executable: &Path) -> Result<()> {
        self.states
            .capacity
            .store(concurrency, std::sync::atomic::Ordering::SeqCst);
        for harness in 0..self.definition.harnesses.len() {
            for slot in 0..concurrency {
                let existing = self
                    .lanes
                    .iter()
                    .position(|lane| lane.harness == harness && lane.slot == slot);
                match existing {
                    Some(index) if self.lanes[index].retiring => {
                        // Still stopping: start it again once it has.
                        self.lanes[index].respawn = true;
                    }
                    Some(index) if self.lanes[index].service.is_none() => {
                        self.states.harness_of.lock().expect("lane harnesses")[index] =
                            Some(harness);
                        self.raise_lane(index, executable).await?;
                    }
                    Some(_) => {}
                    None => {
                        let lane = ManagedLane::new(
                            harness,
                            slot,
                            &self.directory,
                            &self.definition.harnesses[harness],
                        );
                        self.lanes.push(lane);
                        self.states
                            .states
                            .lock()
                            .expect("lane states")
                            .push(LaneState::Pending);
                        self.states
                            .harness_of
                            .lock()
                            .expect("lane harnesses")
                            .push(Some(harness));
                        let index = self.lanes.len() - 1;
                        self.raise_lane(index, executable).await?;
                    }
                }
            }
        }
        for lane in self
            .lanes
            .iter_mut()
            .filter(|lane| lane.slot >= concurrency && lane.service.is_some())
        {
            lane.respawn = false;
            if !lane.retiring {
                lane.retiring = true;
                if let Some(pid) = lane
                    .service
                    .as_ref()
                    .and_then(|service| service.process.id())
                {
                    // SAFETY: the PID belongs to a child whose wait handle we hold.
                    unsafe { libc::kill(pid as i32, libc::SIGUSR1) };
                }
            }
        }
        self.definition.concurrency = concurrency;
        self.states.changed.notify_one();
        Ok(())
    }
}

fn lane_name(kind: supertag_protocol::v2::HarnessKind) -> String {
    match kind {
        supertag_protocol::v2::HarnessKind::Unspecified => "adapter".into(),
        kind => kind
            .as_str_name()
            .trim_start_matches("HARNESS_KIND_")
            .to_ascii_lowercase()
            .replace('_', "-"),
    }
}

fn loads_skills(kind: supertag_protocol::v2::HarnessKind) -> bool {
    use supertag_protocol::v2::HarnessKind;
    !matches!(
        kind,
        HarnessKind::OpenaiAgents | HarnessKind::Opencode | HarnessKind::Cursor
    )
}

/// The profile a configured lane claims with. Configured Hosts select no MCP catalog, shared
/// execution, remote Workspace provider, or Volume mounts, so this matches the lane's own.
fn configured_profile(
    adapter: &crate::harness::AdapterOptions,
) -> Result<supertag_protocol::v2::HarnessExecutionProfile> {
    let mut profile = adapter.execution_profile()?;
    profile.task_artifact_inputs = !adapter.workspace_mappings()?.is_empty()
        && supertag_protocol::task_artifact_inputs::supports_harness(adapter.harness_kind());
    Ok(profile)
}

/// Report the Host's presence whenever a lane changes state, and at least every five seconds.
/// A replaced or revoked registration ends the task with an error.
fn report_presence(
    mut shared: supertag_worker_host::SharedHost,
    mut slots: Vec<supertag_worker_host::HarnessSlots>,
    workspaces: Vec<String>,
    states: Arc<LaneStates>,
) -> Presence {
    let stop = tokio_util::sync::CancellationToken::new();
    let cancelled = stop.clone();
    let task = tokio::spawn(async move {
        let mut ticker = time::interval(Duration::from_secs(5));
        ticker.set_missed_tick_behavior(time::MissedTickBehavior::Delay);
        loop {
            let stopping = tokio::select! {
                biased;
                _ = cancelled.cancelled() => true,
                _ = states.changed.notified() => false,
                _ = ticker.tick() => false,
            };
            let lanes = {
                let current = states.states.lock().expect("lane states");
                let harness_of = states.harness_of.lock().expect("lane harnesses");
                harness_of
                    .iter()
                    .zip(current.iter())
                    .filter_map(|(harness, state)| {
                        Some((
                            (*harness)?,
                            if stopping {
                                LaneState::Stopping
                            } else {
                                *state
                            },
                        ))
                    })
                    .collect::<Vec<_>>()
            };
            let capacity = states.capacity.load(std::sync::atomic::Ordering::SeqCst);
            for slot in &mut slots {
                slot.capacity = capacity;
            }
            let reported = shared.report(&slots, &lanes, &workspaces).await;
            if stopping {
                // Best effort: an unreported stop expires with the presence lease.
                return Ok(());
            }
            match reported {
                Ok(_) => {
                    states
                        .reports
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
                Err(error) if supertag_worker_host::presence_retryable(&error) => {
                    states
                        .reports
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
                Err(error) => {
                    return Err(anyhow::anyhow!(
                        "Worker Host registration generation {} is no longer current: {}",
                        shared.generation(),
                        error.message()
                    ));
                }
            }
        }
    });
    Presence { stop, task }
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
    // A request a previous supervisor never applied would resize this one away from the file
    // it starts with.
    lifecycle::clear_concurrency_request(&directory)?;
    let executable = std::env::current_exe()?;
    let environment = Arc::new(config.environment);
    let mut base = Children::new(&directory)?;
    let logs = base.logs.clone();
    let fingerprint = config.digest.clone();
    let shape = config.shape.clone();
    let instance = config.name.clone();
    let mut announced: Option<String> = None;
    let mut hosts = Vec::new();
    let mut importer = None;
    let session_branches: crate::delivery_branches::Repositories = config
        .hosts
        .iter()
        .flat_map(|host| host.session_branches.clone())
        .collect();
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
            base.notify = plane.notify.resolve(&environment);
            let endpoint = base
                .start_base(
                    &executable,
                    &directory,
                    credentials.as_ref().expect("local credentials"),
                    listen,
                    GatewayExtras {
                        workspace: config
                            .hosts
                            .iter()
                            .any(|h| h.harnesses.iter().any(|a| a.uses_gateway_workspace()))
                            .then_some(&*environment),
                        surfaces: Some((&config.surfaces, &*environment)),
                    },
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
                let channel = crate::network::operator_channel(
                    &crate::network::endpoint(endpoint.clone(), false).await?,
                )
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
        // Before any host registers or takes work: a Codex CLI that cannot run Tasks, or a
        // configured model its provider does not offer, stops startup here. Every host's checks
        // run together, so they fit within `up`'s readiness wait however many hosts there are.
        let checks = futures_util::future::join_all(config.hosts.iter().map(async |definition| {
            let host = crate::harness_checks::host_harnesses(definition)?;
            crate::harness_checks::check_host(&host, &environment).await
        }))
        .await;
        let mut host_notes: Vec<Vec<String>> = Vec::new();
        for checked in checks {
            host_notes.push(checked?);
        }
        for (definition, notes) in config.hosts.into_iter().zip(host_notes) {
            let target = definition
                .gateway
                .clone()
                .or_else(|| endpoint.clone())
                .context("host Gateway is unavailable")?;
            for note in notes {
                note_line(&logs, &definition.name, &note)?;
            }
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
            hosts.push(ManagedHost::new(
                logs.clone(),
                definition,
                environment.clone(),
                target,
                host_directory,
            ));
            hosts[index].start(&executable).await?;
        }
        if let (Some(endpoint), Some(credentials)) = (&endpoint, &credentials) {
            undrain(&directory, endpoint, &credentials.operator).await?;
            if !session_branches.is_empty() {
                importer = Some(tokio::spawn(crate::delivery_branches::follow(
                    endpoint.clone(),
                    credentials.operator.clone(),
                    directory.clone(),
                    session_branches,
                    supervisor_log,
                )));
            }
        }
        if let Some(endpoint) = &endpoint {
            announce(&directory, endpoint)?;
        } else {
            // Host-only machines hold no operator credential and cannot use --state-directory
            // to impersonate an operator on the remote Gateway.
            // terminal-safe: a fixed readiness line for the parent.
            let mut stdout = io::stdout().lock();
            stdout.write_all(b"ready\n")?;
            stdout.flush()?;
        }
        announced = endpoint;
        Ok::<_, anyhow::Error>(())
    };
    let started = tokio::select! {result=startup=>result.map(|()|true),_=&mut shutdown=>Ok(false)};
    let status = |base: &Children, hosts: &[ManagedHost], fingerprint: &str| {
        let mut services = announced
            .as_deref()
            .map(|endpoint| base.base_status(endpoint))
            .unwrap_or_default();
        for host in hosts {
            services.push(ServiceStatus {
                name: host.definition.name.clone(),
                kind: lifecycle::HOST.into(),
                // A Host runs one process per lane; report its first running lane.
                pid: host.lanes.iter().find_map(|lane| {
                    lane.service
                        .as_ref()
                        .and_then(|service| service.process.id())
                }),
                address: Some(host.endpoint.clone()),
                host_id: Some(host.definition.name.clone()),
                remote: host.definition.gateway.is_some(),
                concurrency: Some(host.definition.concurrency),
            });
        }
        lifecycle::record(
            &directory,
            fingerprint,
            &shape,
            &instance,
            announced.as_deref(),
            services,
        )
    };
    let result = match started.and_then(|started| {
        if started {
            status(&base, &hosts, &fingerprint)?;
        }
        Ok(started)
    }) {
        Ok(true) => {
            tokio::select! {result=wait_configured(&mut base,&mut hosts,&executable,&directory,fingerprint.clone(),&status)=>result,_=&mut shutdown=>Ok(())}
        }
        Ok(false) => Ok(()),
        Err(error) => Err(error),
    };
    if let Some(importer) = importer.take() {
        importer.abort();
    }
    let mut failures = Vec::new();
    let mut stops = tokio::task::JoinSet::new();
    for host in &mut hosts {
        for (index, lane) in host.lanes.iter_mut().enumerate() {
            if let Some(mut service) = lane.service.take() {
                let name = host.definition.name.clone();
                stops.spawn(async move {
                    stop_child(&mut service.process)
                        .await
                        .with_context(|| format!("stop Worker Host {name} lane {index}"))
                });
            }
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
    // Lanes are stopped; report each Host as stopping under its own registration.
    for host in &mut hosts {
        if let Some(presence) = host.presence.take() {
            presence.stop.cancel();
            let _ = presence.task.await;
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
        OperatorClient::new(crate::network::operator_channel(&gateway).await?)
            .create_auth_key(crate::request(
                CreateAuthKeyRequest {
                    name: join_key_name(&definition.name),
                    host_id: definition.name.clone(),
                    operation_id: Uuid::new_v4().to_string(),
                    key_digest: Sha256::digest(key.as_bytes()).to_vec(),
                    expires_in_ms: 600_000,
                    allowed_tag_ids: vec![],
                    all_tags: true,
                    ..Default::default()
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
/// A fresh name for the one-time key that joins a configured host, since names are never reused.
fn join_key_name(host: &str) -> String {
    let mut name: String = host
        .chars()
        .map(|c| match c.to_ascii_lowercase() {
            c @ ('a'..='z' | '0'..='9' | '-' | '_') => c,
            _ => '-',
        })
        .take(40)
        .collect();
    if !name.starts_with(|c: char| c.is_ascii_alphanumeric()) {
        name.insert(0, 'h');
    }
    format!("{name}-join-{}", &Uuid::new_v4().simple().to_string()[..12])
}
async fn wait_configured(
    base: &mut Children,
    hosts: &mut [ManagedHost],
    executable: &Path,
    directory: &Path,
    mut fingerprint: String,
    status: &impl Fn(&Children, &[ManagedHost], &str) -> Result<()>,
) -> Result<()> {
    loop {
        let mut restarted = false;
        // `supertag up` asks for a different `concurrency` when nothing else changed.
        if let Some(request) = lifecycle::take_concurrency_request(directory) {
            for host in hosts.iter_mut() {
                if let Some(&concurrency) = request.hosts.get(&host.definition.name)
                    && concurrency != host.definition.concurrency
                    && (1..=crate::local_config::MAX_CONCURRENCY).contains(&concurrency)
                {
                    note_line(
                        &host.logs,
                        &host.definition.name,
                        &format!(
                            "concurrency changes from {} to {concurrency} without a restart",
                            host.definition.concurrency
                        ),
                    )?;
                    host.resize(concurrency, executable)
                        .await
                        .with_context(|| format!("Worker Host {}", host.definition.name))?;
                }
            }
            fingerprint = request.fingerprint;
            restarted = true;
        }
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
            if let Some(presence) = &mut host.presence
                && presence.task.is_finished()
            {
                let outcome = (&mut presence.task).await;
                host.presence.take();
                let error = match outcome {
                    Ok(Err(error)) => error,
                    Ok(Ok(())) => anyhow::anyhow!("presence reporting stopped"),
                    Err(error) => anyhow::anyhow!("presence reporting failed: {error}"),
                };
                bail!("Worker Host {}: {error:#}", host.definition.name);
            }
            for index in 0..host.lanes.len() {
                let Some(service) = host.lanes[index].service.as_mut() else {
                    // A lane a lowered `concurrency` stopped.
                    continue;
                };
                let Some(status) = service.process.try_wait()? else {
                    continue;
                };
                host.lanes[index].service.take();
                if host.lanes[index].retiring && status.success() {
                    let lane = &mut host.lanes[index];
                    lane.retiring = false;
                    if std::mem::take(&mut lane.respawn) {
                        host.restart_lane(index, executable).await?;
                    } else {
                        host.states.harness_of.lock().expect("lane harnesses")[index] = None;
                        host.states.changed.notify_one();
                    }
                    restarted = true;
                    continue;
                }
                // A fenced registration stops every lane; report that, not this lane's exit.
                host.confirm_registration()
                    .await
                    .with_context(|| format!("Worker Host {}", host.definition.name))?;
                // A lane runs one Attempt. Its exit leaves sibling lanes, their Attempts, and
                // the Host's shared generation in place.
                ensure!(
                    host.definition.restart == crate::local_config::Restart::UnlessStopped,
                    "Worker Host {} lane {index} exited unexpectedly with {status}",
                    host.definition.name
                );
                time::sleep(Duration::from_secs(1)).await;
                host.restart_lane(index, executable).await?;
                restarted = true;
            }
        }
        if restarted {
            status(base, hosts, &fingerprint)?;
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
    let channel =
        crate::network::operator_channel(&crate::network::endpoint(endpoint.into(), false).await?)
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
