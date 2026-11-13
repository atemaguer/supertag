//! Local service lifecycle: `up` in the background or under a per-user service unit, `down`,
//! `ps`, and `logs`. One supervisor process per state directory owns the Control Plane, the
//! Gateway, and every configured Worker Host; it records what it runs in `supervisor.json`.
use std::{
    collections::BTreeSet,
    ffi::OsString,
    fs::{self, DirBuilder, File, OpenOptions, TryLockError},
    io::{self, Read as _, Seek as _, SeekFrom},
    os::unix::{
        fs::{DirBuilderExt as _, OpenOptionsExt as _},
        process::CommandExt as _,
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::OnceLock,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail, ensure};
use clap::{Args, ValueEnum};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use supertag_protocol::v2::{
    GetHostRequest, SetHostDrainingRequest, operator_client::OperatorClient,
};

use crate::{
    local::{self, open_private_file, private_directory, write_private},
    local_config,
    service_manager::{ServiceDefinition, ServiceManager, UnitName},
};

pub const CONTROL_PLANE: &str = "control-plane";
pub const GATEWAY: &str = "gateway";
pub const HOST: &str = "host";
pub const SUPERVISOR: &str = "supervisor";
pub const DEFAULT_INSTANCE: &str = "supertag";
const STATUS: &str = "supervisor.json";
const DRAINED: &str = "drained-hosts";
const STATE_LOCK: &str = ".lock";
const MODE_VARIABLE: &str = "SUPERTAG_SUPERVISOR_MODE";
const MAX_STATUS_BYTES: u64 = 256 * 1024;
const READY_TIMEOUT: Duration = Duration::from_secs(120);
const STOP_TIMEOUT: Duration = Duration::from_secs(90);
/// How long `down` waits for a draining host's running Task Attempts, as the TypeScript CLI did.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(300);
const DRAIN_PROGRESS: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SupervisorMode {
    Foreground,
    Background,
    Service,
}

impl SupervisorMode {
    pub fn current() -> Self {
        match std::env::var(MODE_VARIABLE).as_deref() {
            Ok("background") => Self::Background,
            Ok("service") => Self::Service,
            _ => Self::Foreground,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Foreground => "foreground",
            Self::Background => "background",
            Self::Service => "service",
        }
    }
}

/// What a running supervisor runs. Holds no credential.
#[derive(Clone, Serialize, Deserialize)]
pub struct SupervisorStatus {
    pub pid: u32,
    pub mode: String,
    pub version: String,
    pub instance: String,
    pub fingerprint: String,
    pub started_at_ms: u64,
    pub endpoint: Option<String>,
    pub services: Vec<ServiceStatus>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ServiceStatus {
    pub name: String,
    /// `control-plane`, `gateway` or `host`.
    pub kind: String,
    pub pid: Option<u32>,
    /// Control Plane: its private listener. Gateway: its public endpoint. Host: its Gateway.
    pub address: Option<String>,
    pub host_id: Option<String>,
    /// A host connected to a Gateway this supervisor does not run.
    pub remote: bool,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

fn started_at_ms() -> u64 {
    static STARTED: OnceLock<u64> = OnceLock::new();
    *STARTED.get_or_init(now_ms)
}

/// Record what this supervisor runs. Called when it becomes ready and when a host restarts.
pub fn record(
    directory: &Path,
    fingerprint: &str,
    instance: &str,
    endpoint: Option<&str>,
    services: Vec<ServiceStatus>,
) -> Result<()> {
    let status = SupervisorStatus {
        pid: std::process::id(),
        mode: SupervisorMode::current().as_str().into(),
        version: env!("CARGO_PKG_VERSION").into(),
        instance: instance.into(),
        fingerprint: fingerprint.into(),
        started_at_ms: started_at_ms(),
        endpoint: endpoint.map(str::to_owned),
        services,
    };
    write_private(directory, STATUS, &serde_json::to_vec_pretty(&status)?)
}

pub fn forget(directory: &Path) -> Result<()> {
    remove_if_present(&directory.join(STATUS)).context("remove supervisor status")
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// Hosts `supertag down` drained; the next supervisor returns them to service.
pub fn drained_hosts(directory: &Path) -> Result<Vec<String>> {
    let path = directory.join(DRAINED);
    if fs::symlink_metadata(&path).is_err() {
        return Ok(Vec::new());
    }
    Ok(read_bounded(&path)?
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect())
}

pub fn clear_drained_hosts(directory: &Path) -> Result<()> {
    remove_if_present(&directory.join(DRAINED)).context("remove drained host record")
}

fn mark_drained(directory: &Path, hosts: &BTreeSet<String>) -> Result<()> {
    let mut all: BTreeSet<String> = drained_hosts(directory)?.into_iter().collect();
    all.extend(hosts.iter().cloned());
    let text: String = all.iter().map(|host| format!("{host}\n")).collect();
    write_private(directory, DRAINED, text.as_bytes())
}

/// The log file of one service: `logs/NAME.log` for the supervisor, Control Plane and Gateway,
/// `logs/hosts/NAME.log` for a Worker Host.
pub fn log_path(state: &Path, service: &str) -> PathBuf {
    let logs = state.join("logs");
    match service {
        SUPERVISOR | CONTROL_PLANE | GATEWAY => logs.join(format!("{service}.log")),
        host => logs.join("hosts").join(format!("{host}.log")),
    }
}

/// An ISO 8601 UTC time with milliseconds, as every log line starts.
pub fn timestamp(time: SystemTime) -> String {
    let elapsed = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = elapsed.as_secs();
    let (days, rest) = (seconds / 86_400, seconds % 86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60,
        elapsed.subsec_millis()
    )
}

fn read_bounded(path: &Path) -> Result<String> {
    let mut text = String::new();
    open_private_file(path, false)?
        .take(MAX_STATUS_BYTES + 1)
        .read_to_string(&mut text)?;
    ensure!(
        text.len() as u64 <= MAX_STATUS_BYTES,
        "{} is too large",
        path.display()
    );
    Ok(text)
}

/// What is known about the supervisor of one state directory.
pub enum Supervisor {
    Stopped,
    /// Holds the state lock but has not recorded its services yet.
    Starting,
    Running(SupervisorStatus),
}

/// Inspect the supervisor without starting anything. The state lock is authoritative; the
/// status file says what the lock holder runs.
pub fn inspect(state: &Path) -> Result<Supervisor> {
    let Ok(directory) = private_directory(state) else {
        return Ok(Supervisor::Stopped);
    };
    let lock = match open_private_file(&directory.join(STATE_LOCK), false) {
        Ok(lock) => lock,
        Err(_) => return Ok(Supervisor::Stopped),
    };
    match lock.try_lock() {
        Ok(()) => return Ok(Supervisor::Stopped),
        Err(TryLockError::WouldBlock) => {}
        Err(TryLockError::Error(error)) => {
            return Err(error).context("inspect local supervisor lock");
        }
    }
    drop(lock);
    Ok(match read_status(&directory)? {
        Some(status) if alive(status.pid) => Supervisor::Running(status),
        _ => Supervisor::Starting,
    })
}

fn read_status(directory: &Path) -> Result<Option<SupervisorStatus>> {
    let path = directory.join(STATUS);
    if fs::symlink_metadata(&path).is_err() {
        return Ok(None);
    }
    Ok(Some(
        serde_json::from_str(&read_bounded(&path)?).context("invalid supervisor status")?,
    ))
}

fn alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 checks for existence and permission without delivering a signal.
    pid > 0 && unsafe { libc::kill(pid, 0) } == 0
}

/// The `up` arguments that select settings: without `--foreground` and `--force`, which say how
/// to start rather than what runs. A value of `--adapter-arg` is kept even when it looks like one.
pub fn setting_args(args: &[OsString]) -> Vec<OsString> {
    let mut kept: Vec<OsString> = Vec::with_capacity(args.len());
    for arg in args {
        let value = kept
            .last()
            .is_some_and(|previous| previous == "--adapter-arg");
        if !value && (arg == "--foreground" || arg == "--force") {
            continue;
        }
        kept.push(arg.clone());
    }
    kept
}

/// Identify flag-selected settings: everything after `up` except how to start it.
pub fn flags_fingerprint(args: &[OsString]) -> String {
    let mut digest = Sha256::new();
    digest.update(b"flags\0");
    for arg in setting_args(args) {
        digest.update(arg.as_encoded_bytes());
        digest.update(b"\0");
    }
    hex(&digest.finalize())
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `supertag up` without `--foreground`.
pub struct Background {
    pub state: PathBuf,
    pub config: Option<local_config::Config>,
    /// The `up` arguments, re-run with `--foreground` by the background process.
    pub args: Vec<OsString>,
    pub force: bool,
}

/// Start the supervisor in the background, or under a per-user service unit when a service
/// sets `restart: unless-stopped`, and return once it is ready. An unchanged running
/// supervisor is left alone; a changed one is drained, stopped and started again.
pub async fn up(options: Background) -> Result<()> {
    let fingerprint = match &options.config {
        Some(config) => config.digest.clone(),
        None => flags_fingerprint(&options.args),
    };
    let unit = match &options.config {
        Some(config) if config.service_unit => {
            let definition = unit_definition(&options, config)?;
            for warning in local_config::unit_check(config, &definition.environment)? {
                outln!("{}", crate::terminal::text(&warning));
            }
            Some(definition)
        }
        _ => None,
    };
    let manager = ServiceManager::for_platform();
    match inspect(&options.state)? {
        Supervisor::Running(status) => {
            let unit_current = match (&unit, &manager) {
                (Some(definition), Ok(manager)) => manager.current(definition)?,
                (None, _) => true,
                (Some(_), Err(_)) => false,
            };
            if status.fingerprint == fingerprint && unit_current {
                outln!("SuperTag already runs with these settings, so it was left alone.");
                summary(&options.state, &status);
                return Ok(());
            }
            outln!("SuperTag's settings changed, so it restarts.");
            stop(&options.state, Some(&status), options.force).await?;
        }
        Supervisor::Starting => {
            bail!(
                "SuperTag is starting in {}; wait for it, then run supertag up again",
                options.state.display()
            )
        }
        Supervisor::Stopped => {}
    }
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(options.state.join("logs").join("hosts"))?;
    let state = private_directory(&options.state)?;
    let status = if let Some(definition) = unit {
        let manager = manager?;
        if let Some(other) = manager.other_state(&definition)? {
            bail!(
                "service unit {} already runs SuperTag for {other}; set a different name: in supertag.yaml",
                manager.path(&definition.name).display()
            );
        }
        let since = now_ms();
        for line in manager.install(&definition)? {
            outln!("{line}");
        }
        wait_ready(
            &state,
            |status| status.started_at_ms >= since.saturating_sub(1_000),
            None,
        )
        .await?
    } else {
        let log = OpenOptions::new()
            .append(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(log_path(&state, SUPERVISOR))?;
        let mut command = Command::new(std::env::current_exe()?);
        // `--force` only governs this command's restart; the supervisor runs in its foreground.
        command
            .args(setting_args(&options.args))
            .arg("--foreground")
            .env(MODE_VARIABLE, "background")
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log)
            // Leave this terminal's session so its hangup and Ctrl-C do not reach the services.
            .process_group(0);
        let mut child = command.spawn().context("start the SuperTag supervisor")?;
        let pid = child.id();
        let status = wait_ready(&state, |status| status.pid == pid, Some(&mut child)).await?;
        // The supervisor outlives this command; init reaps it after we exit.
        std::mem::forget(child);
        status
    };
    let how = match status.mode.as_str() {
        "service" => "under its service unit",
        _ => "in the background",
    };
    outln!("Started SuperTag {how} (process {}).", status.pid);
    summary(&state, &status);
    outln!(
        "Follow the logs with supertag logs -f, list services with supertag ps, and stop with supertag down."
    );
    Ok(())
}

fn summary(state: &Path, status: &SupervisorStatus) {
    if let Some(endpoint) = &status.endpoint {
        outln!("Gateway: {endpoint}");
    }
    for service in status
        .services
        .iter()
        .filter(|service| service.kind == HOST)
    {
        outln!(
            "Worker Host {}: {}",
            service.name,
            service.address.as_deref().unwrap_or("unknown Gateway")
        );
    }
    outln!("State: {}", state.display());
}

/// The state directory as a service unit records it.
fn unit_state(state: &Path) -> String {
    state
        .canonicalize()
        .unwrap_or_else(|_| state.to_owned())
        .to_string_lossy()
        .into_owned()
}

fn unit_definition(
    options: &Background,
    config: &local_config::Config,
) -> Result<ServiceDefinition> {
    let state = PathBuf::from(unit_state(&options.state));
    let executable = std::env::current_exe()?;
    let command = vec![
        executable.into_os_string(),
        "up".into(),
        "--foreground".into(),
        "--state-directory".into(),
        state.clone().into_os_string(),
        "--file".into(),
        config.path.clone().into_os_string(),
    ];
    let command = command
        .into_iter()
        .map(|arg| {
            arg.into_string()
                .map_err(|_| anyhow::anyhow!("service unit paths must be UTF-8"))
        })
        .collect::<Result<Vec<_>>>()?;
    let mut environment = vec![(MODE_VARIABLE.to_owned(), "service".to_owned())];
    for name in ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR"] {
        if let Ok(value) = std::env::var(name) {
            environment.push((name.into(), value));
        }
    }
    environment.sort();
    Ok(ServiceDefinition {
        name: UnitName::new(&config.name),
        description: format!("SuperTag services for {}", state.display()),
        working_directory: state.to_string_lossy().into_owned(),
        command,
        log_file: log_path(&state, SUPERVISOR).to_string_lossy().into_owned(),
        environment,
        state: state.to_string_lossy().into_owned(),
    })
}

async fn wait_ready(
    state: &Path,
    ours: impl Fn(&SupervisorStatus) -> bool,
    mut child: Option<&mut std::process::Child>,
) -> Result<SupervisorStatus> {
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        if let Some(child) = child.as_deref_mut()
            && let Some(exit) = child.try_wait()?
        {
            bail!(
                "the SuperTag supervisor exited with {exit} before it was ready:\n{}",
                log_tail(state, SUPERVISOR)
            );
        }
        if let Some(status) = read_status(state).ok().flatten()
            && ours(&status)
            && alive(status.pid)
        {
            return Ok(status);
        }
        ensure!(
            Instant::now() < deadline,
            "SuperTag did not become ready within {} seconds:\n{}",
            READY_TIMEOUT.as_secs(),
            log_tail(state, SUPERVISOR)
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn log_tail(state: &Path, service: &str) -> String {
    let text = fs::read(log_path(state, service)).unwrap_or_default();
    let text = String::from_utf8_lossy(&text);
    let lines: Vec<_> = text.lines().collect();
    lines[lines.len().saturating_sub(20)..].join("\n")
}

/// Drain this supervisor's local Worker Hosts, then stop it and wait for its state lock.
/// Returns false when a host still runs work and `force` was not given.
async fn stop(state: &Path, status: Option<&SupervisorStatus>, force: bool) -> Result<()> {
    let directory = private_directory(state)?;
    if let Some(status) = status {
        drain(&directory, status, force).await?;
    }
    let manager = ServiceManager::for_platform().ok();
    let unit = status
        .filter(|status| status.mode == "service")
        .map(|status| UnitName::new(&status.instance));
    match (&manager, &unit) {
        (Some(manager), Some(unit))
            if manager.installed(unit) && manager.serves(unit, &unit_state(state)) =>
        {
            manager.stop(unit)?
        }
        _ => {
            if let Some(status) = status {
                let pid = i32::try_from(status.pid)?;
                // SAFETY: the PID belongs to the process holding this state's lock.
                if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
                    let error = io::Error::last_os_error();
                    ensure!(
                        error.raw_os_error() == Some(libc::ESRCH),
                        "stop SuperTag: {error}"
                    );
                }
            }
        }
    }
    let deadline = Instant::now() + STOP_TIMEOUT;
    loop {
        if matches!(inspect(&directory)?, Supervisor::Stopped) {
            return Ok(());
        }
        ensure!(
            Instant::now() < deadline,
            "SuperTag did not stop within {} seconds; see supertag logs supervisor",
            STOP_TIMEOUT.as_secs()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Take no new Task Attempts on this supervisor's local hosts and wait for running ones.
async fn drain(directory: &Path, status: &SupervisorStatus, force: bool) -> Result<()> {
    let hosts: BTreeSet<String> = status
        .services
        .iter()
        .filter(|service| service.kind == HOST && !service.remote)
        .filter_map(|service| service.host_id.clone())
        .collect();
    if hosts.is_empty() || status.endpoint.is_none() {
        return Ok(());
    }
    let (endpoint, token) = local::connection(directory)?;
    let channel = crate::network::endpoint(endpoint, false)
        .await?
        .connect()
        .await?;
    let mut client = OperatorClient::new(channel);
    for host_id in &hosts {
        match client
            .set_host_draining(crate::request(
                SetHostDrainingRequest {
                    host_id: host_id.clone(),
                    draining: true,
                },
                &token,
            )?)
            .await
        {
            Ok(_) => {}
            Err(error) if error.code() == tonic::Code::NotFound => continue,
            Err(error) => {
                return Err(error).with_context(|| format!("drain Worker Host {host_id}"));
            }
        }
    }
    mark_drained(directory, &hosts)?;
    if force {
        return Ok(());
    }
    let started = Instant::now();
    let mut reported: Option<Instant> = None;
    // Ctrl-C while waiting stops waiting, not the command, as the TypeScript CLI did. The
    // handler exists before the first message, so an interrupt after it is never lost.
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    loop {
        let mut running = Vec::new();
        for host_id in &hosts {
            let attempts = match client
                .get_host(crate::request(
                    GetHostRequest {
                        host_id: host_id.clone(),
                    },
                    &token,
                )?)
                .await
            {
                Ok(host) => host.into_inner().active_attempts,
                Err(error) if error.code() == tonic::Code::NotFound => 0,
                Err(error) => {
                    return Err(error).with_context(|| format!("read Worker Host {host_id}"));
                }
            };
            if attempts > 0 {
                running.push(format!("{host_id} ({attempts} Task Attempts)"));
            }
        }
        if running.is_empty() {
            return Ok(());
        }
        if started.elapsed() >= drain_timeout() {
            bail!(
                "Worker Hosts still run Task Attempts: {}. SuperTag remains running; stop now with supertag down --force",
                running.join(", ")
            );
        }
        if reported.is_none_or(|at| at.elapsed() >= DRAIN_PROGRESS) {
            outln!(
                "Waiting for running Task Attempts before stopping: {}. Press Ctrl-C or pass --force to stop waiting.",
                running.join(", ")
            );
            reported = Some(Instant::now());
        }
        tokio::select! {
            _ = interrupt.recv() => {
                outln!(
                    "Stopped waiting for {}; running Task Attempts follow the recovery rules.",
                    running.join(", ")
                );
                return Ok(());
            }
            _ = tokio::time::sleep(Duration::from_millis(500)) => {}
        }
    }
}

fn drain_timeout() -> Duration {
    #[cfg(feature = "test-fixtures")]
    if let Some(seconds) = std::env::var("SUPERTAG_TEST_DOWN_DRAIN_SECONDS")
        .ok()
        .and_then(|value| value.parse().ok())
    {
        return Duration::from_secs(seconds);
    }
    DRAIN_TIMEOUT
}

#[derive(Args)]
pub struct DownArgs {
    /// Local state directory (default: ~/.supertag or SUPERTAG_STATE_DIR).
    #[arg(long)]
    state_directory: Option<PathBuf>,
    /// supertag.yaml, or a directory that holds one, naming the service unit to remove.
    #[arg(short = 'f', long = "file")]
    file: Option<PathBuf>,
    /// Also uninstall the per-user service unit.
    #[arg(long)]
    remove_services: bool,
    /// Do not wait for running Task Attempts.
    #[arg(long)]
    force: bool,
}

/// `supertag down`: drain local hosts, stop the supervisor, and with `--remove-services`
/// uninstall its service unit.
pub async fn down(args: DownArgs) -> Result<()> {
    let state = local_config::state_directory(args.state_directory)?;
    let status = inspect(&state)?;
    let instance = match &status {
        Supervisor::Running(status) => status.instance.clone(),
        _ => local_config::load(args.file, &state)
            .ok()
            .flatten()
            .map_or_else(|| DEFAULT_INSTANCE.to_owned(), |config| config.name),
    };
    let manager = ServiceManager::for_platform().ok();
    let unit = UnitName::new(&instance);
    let present = manager
        .as_ref()
        .is_some_and(|manager| manager.installed(&unit));
    // A unit of this name may serve another state directory; it is never ours to stop.
    let installed = present
        && manager
            .as_ref()
            .is_some_and(|manager| manager.serves(&unit, &unit_state(&state)));
    if present
        && !installed
        && let Some(manager) = &manager
    {
        outln!(
            "Service unit {} runs SuperTag for another state directory, so it was left alone.",
            manager.path(&unit).display()
        );
    }
    let stopped = match &status {
        Supervisor::Running(status) => {
            stop(&state, Some(status), args.force).await?;
            outln!("Stopped SuperTag (process {}).", status.pid);
            true
        }
        Supervisor::Starting => {
            bail!("SuperTag is starting; wait for it, then run supertag down again")
        }
        Supervisor::Stopped => false,
    };
    if let Some(manager) = manager.as_ref().filter(|_| installed) {
        if args.remove_services {
            manager.uninstall(&unit)?;
            outln!("Removed service unit {}.", manager.path(&unit).display());
        } else {
            if manager.loaded(&unit) {
                manager.stop(&unit)?;
            }
            if stopped {
                outln!(
                    "Its service unit starts it again when you log in; supertag down --remove-services removes it."
                );
            }
        }
    }
    let removed = installed && args.remove_services;
    if !stopped && !removed {
        outln!("SuperTag is not running on this machine.");
    }
    Ok(())
}

#[derive(Clone, Copy, Default, ValueEnum)]
pub enum Output {
    #[default]
    Text,
    Json,
}

#[derive(Args)]
pub struct PsArgs {
    /// Local state directory (default: ~/.supertag or SUPERTAG_STATE_DIR).
    #[arg(long)]
    state_directory: Option<PathBuf>,
    /// supertag.yaml, or a directory that holds one.
    #[arg(short = 'f', long = "file")]
    file: Option<PathBuf>,
    /// Print readable text, or JSON for scripts.
    #[arg(long, value_enum, default_value_t)]
    output: Output,
}

#[derive(Serialize)]
struct Row {
    service: String,
    #[serde(rename = "type")]
    kind: String,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    worker_host_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    connected: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    draining: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attempts: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    capacity: Option<u32>,
}

#[derive(Serialize)]
struct PsReport {
    state_directory: String,
    supervisor: Option<SupervisorRow>,
    services: Vec<Row>,
}

#[derive(Serialize)]
struct SupervisorRow {
    pid: u32,
    mode: String,
    version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    unit: Option<String>,
}

/// `supertag ps`: the supervisor and each service it runs, or the configured services as stopped.
pub async fn ps(args: PsArgs) -> Result<()> {
    let state = local_config::state_directory(args.state_directory)?;
    let supervisor = inspect(&state)?;
    let mut services = Vec::new();
    let mut supervisor_row = None;
    match &supervisor {
        Supervisor::Running(status) => {
            let unit = (status.mode == "service")
                .then(|| ServiceManager::for_platform().ok())
                .flatten()
                .map(|manager| {
                    manager
                        .path(&UnitName::new(&status.instance))
                        .display()
                        .to_string()
                });
            supervisor_row = Some(SupervisorRow {
                pid: status.pid,
                mode: status.mode.clone(),
                version: status.version.clone(),
                unit,
            });
            let hosts = host_states(&state, status).await;
            for service in &status.services {
                let running = service.pid.is_some_and(alive);
                let host = service
                    .host_id
                    .as_ref()
                    .and_then(|id| hosts.iter().find(|(host, _)| host == id))
                    .map(|(_, host)| host);
                let connected = host.map(|host| {
                    use supertag_protocol::v2::HostPhase;
                    matches!(
                        host.phase(),
                        HostPhase::Ready | HostPhase::Busy | HostPhase::Draining
                    )
                });
                services.push(Row {
                    service: service.name.clone(),
                    kind: service.kind.clone(),
                    state: match (running, connected) {
                        (false, _) => "stopped",
                        (true, Some(false)) => "unhealthy",
                        (true, _) => "running",
                    },
                    address: service.address.clone(),
                    pid: service.pid.filter(|_| running),
                    worker_host_id: service.host_id.clone(),
                    connected,
                    draining: host.map(|host| host.draining),
                    attempts: host.map(|host| host.active_attempts),
                    capacity: host.map(|host| host.capacity),
                });
            }
        }
        Supervisor::Starting | Supervisor::Stopped => {
            let starting = matches!(supervisor, Supervisor::Starting);
            let state_label = if starting { "starting" } else { "stopped" };
            if let Ok(Some(config)) = local_config::load(args.file, &state) {
                if config.plane.is_some() {
                    for name in [CONTROL_PLANE, GATEWAY] {
                        services.push(stopped_row(name, name, state_label));
                    }
                }
                for host in &config.hosts {
                    services.push(stopped_row(&host.name, HOST, state_label));
                }
            }
        }
    }
    let report = PsReport {
        state_directory: state.display().to_string(),
        supervisor: supervisor_row,
        services,
    };
    match args.output {
        Output::Json => crate::terminal::print_json_pretty(&report)?,
        Output::Text => out!("{}", format_ps(&report, &supervisor)),
    }
    Ok(())
}

fn stopped_row(name: &str, kind: &str, state: &'static str) -> Row {
    Row {
        service: name.into(),
        kind: kind.into(),
        state,
        address: None,
        pid: None,
        worker_host_id: None,
        connected: None,
        draining: None,
        attempts: None,
        capacity: None,
    }
}

async fn host_states(
    state: &Path,
    status: &SupervisorStatus,
) -> Vec<(String, supertag_protocol::v2::WorkerHostStatus)> {
    let mut hosts = Vec::new();
    if status.endpoint.is_none() {
        return hosts;
    }
    let Ok((endpoint, token)) = local::connection(state) else {
        return hosts;
    };
    let Ok(endpoint) = crate::network::endpoint(endpoint, false).await else {
        return hosts;
    };
    let Ok(channel) = endpoint.connect().await else {
        return hosts;
    };
    let mut client = OperatorClient::new(channel);
    for service in status.services.iter().filter(|service| !service.remote) {
        let Some(host_id) = &service.host_id else {
            continue;
        };
        let Ok(request) = crate::request(
            GetHostRequest {
                host_id: host_id.clone(),
            },
            &token,
        ) else {
            continue;
        };
        if let Ok(host) = client.get_host(request).await {
            hosts.push((host_id.clone(), host.into_inner()));
        }
    }
    hosts
}

/// Each field goes through [`crate::terminal::text`], so a path, name, or address that holds a line
/// break cannot add a line to the table.
fn format_ps(report: &PsReport, supervisor: &Supervisor) -> String {
    use crate::terminal::text;
    let mut out = String::new();
    let state_directory = text(&report.state_directory);
    match (&report.supervisor, supervisor) {
        (Some(row), _) => {
            let how = match (row.mode.as_str(), &row.unit) {
                ("service", Some(unit)) => format!("service unit {}", text(unit)),
                (mode, _) => text(mode),
            };
            out.push_str(&format!(
                "SuperTag {} runs in {state_directory} as process {} ({how}).\n",
                text(&row.version),
                row.pid
            ));
        }
        (None, Supervisor::Starting) => {
            out.push_str(&format!("SuperTag is starting in {state_directory}.\n"));
        }
        _ => out.push_str("SuperTag is not running on this machine.\n"),
    }
    if report.services.is_empty() {
        return out;
    }
    let rows: Vec<[String; 5]> = report
        .services
        .iter()
        .map(|row| {
            let mut detail = Vec::new();
            if let Some(connected) = row.connected {
                detail.push(
                    if connected {
                        "connected"
                    } else {
                        "not connected"
                    }
                    .to_owned(),
                );
            }
            if row.draining == Some(true) {
                detail.push("draining".into());
            }
            if let (Some(attempts), Some(capacity)) = (row.attempts, row.capacity) {
                detail.push(format!("{attempts}/{capacity} Task Attempts"));
            }
            [
                text(&row.service),
                text(&row.kind),
                row.state.to_owned(),
                row.address.as_deref().map_or_else(|| "-".into(), text),
                [
                    row.pid.map_or_else(|| "-".into(), |pid| pid.to_string()),
                    detail.join(", "),
                ]
                .join("  ")
                .trim_end()
                .to_owned(),
            ]
        })
        .collect();
    let header = ["SERVICE", "TYPE", "STATE", "ADDRESS", "PROCESS"];
    let widths: Vec<usize> = (0..4)
        .map(|column| {
            rows.iter()
                .map(|row| row[column].len())
                .chain([header[column].len()])
                .max()
                .unwrap_or(0)
        })
        .collect();
    let line = |cells: [&str; 5]| {
        format!(
            "{:<w0$}  {:<w1$}  {:<w2$}  {:<w3$}  {}\n",
            cells[0],
            cells[1],
            cells[2],
            cells[3],
            cells[4],
            w0 = widths[0],
            w1 = widths[1],
            w2 = widths[2],
            w3 = widths[3]
        )
    };
    out.push_str(&line(header));
    for row in &rows {
        out.push_str(&line([&row[0], &row[1], &row[2], &row[3], &row[4]]));
    }
    out
}

#[derive(Args)]
pub struct LogsArgs {
    /// Local state directory (default: ~/.supertag or SUPERTAG_STATE_DIR).
    #[arg(long)]
    state_directory: Option<PathBuf>,
    /// Keep printing new lines until interrupted.
    #[arg(short = 'f', long)]
    follow: bool,
    /// supertag.yaml, or a directory that holds one.
    #[arg(long = "file")]
    file: Option<PathBuf>,
    /// Services to show: supervisor, control-plane, gateway, or a host (default: all).
    services: Vec<String>,
}

/// `supertag logs`: print each service's log, prefixed with its name when several are shown.
pub async fn logs(args: LogsArgs) -> Result<()> {
    let state = local_config::state_directory(args.state_directory)?;
    let mut known: Vec<String> = [SUPERVISOR, CONTROL_PLANE, GATEWAY]
        .into_iter()
        .map(str::to_owned)
        .collect();
    let mut hosts = BTreeSet::new();
    if let Ok(entries) = fs::read_dir(state.join("logs").join("hosts")) {
        for entry in entries.flatten() {
            if let Some(name) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.strip_suffix(".log"))
            {
                hosts.insert(name.to_owned());
            }
        }
    }
    if let Ok(Some(config)) = local_config::load(args.file, &state) {
        hosts.extend(config.hosts.into_iter().map(|host| host.name));
    }
    known.extend(hosts);
    for name in &args.services {
        ensure!(
            known.contains(name),
            "{name} is not a service in supertag.yaml or on this machine"
        );
    }
    let chosen: Vec<String> = known
        .into_iter()
        .filter(|name| args.services.is_empty() || args.services.contains(name))
        .collect();
    let prefixed = chosen.len() > 1;
    let mut sources: Vec<LogSource> = chosen
        .into_iter()
        .map(|name| LogSource {
            path: log_path(&state, &name),
            name,
            offset: 0,
            partial: Vec::new(),
        })
        .collect();
    if !args.follow && !sources.iter().any(|source| source.path.exists()) {
        outln!("No logs yet in {}.", state.display());
        return Ok(());
    }
    // Handle interruption before printing anything, so a signal never kills a follower
    // between its first line and its loop.
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    // terminal-safe: LogSource::write_line filters each line.
    let mut stdout = io::stdout().lock();
    for source in &mut sources {
        source.drain(&mut stdout, prefixed)?;
    }
    if !args.follow {
        for source in &mut sources {
            source.finish(&mut stdout, prefixed)?;
        }
        return Ok(());
    }
    drop(stdout);
    loop {
        tokio::select! {
            _ = terminate.recv() => return Ok(()),
            _ = interrupt.recv() => return Ok(()),
            _ = tokio::time::sleep(Duration::from_millis(250)) => {}
        }
        // terminal-safe: LogSource::write_line filters each line.
        let mut stdout = io::stdout().lock();
        for source in &mut sources {
            source.drain(&mut stdout, prefixed)?;
        }
    }
}

struct LogSource {
    name: String,
    path: PathBuf,
    offset: u64,
    partial: Vec<u8>,
}

impl LogSource {
    fn drain(&mut self, out: &mut impl io::Write, prefixed: bool) -> Result<()> {
        let Ok(mut file) = File::open(&self.path) else {
            return Ok(());
        };
        let size = file.metadata()?.len();
        if size < self.offset {
            self.offset = 0;
        }
        if size == self.offset {
            return Ok(());
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut bytes = Vec::new();
        (&mut file)
            .take(size - self.offset)
            .read_to_end(&mut bytes)?;
        self.offset += bytes.len() as u64;
        self.partial.extend_from_slice(&bytes);
        while let Some(end) = self.partial.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.partial.drain(..=end).collect();
            self.write_line(out, &line[..end], prefixed)?;
        }
        // A service that never ends its line still shows up in bounded pieces.
        if self.partial.len() >= MAX_PARTIAL_LOG_LINE {
            let line = std::mem::take(&mut self.partial);
            self.write_line(out, &line, prefixed)?;
        }
        Ok(out.flush()?)
    }

    fn finish(&mut self, out: &mut impl io::Write, prefixed: bool) -> Result<()> {
        if !self.partial.is_empty() {
            let line = std::mem::take(&mut self.partial);
            self.write_line(out, &line, prefixed)?;
        }
        Ok(out.flush()?)
    }

    /// Logs record text from surfaces, harnesses and remote services, so filter each line.
    fn write_line(&self, out: &mut impl io::Write, line: &[u8], prefixed: bool) -> Result<()> {
        let line = String::from_utf8_lossy(line);
        let line = crate::terminal::text(line.strip_suffix('\r').unwrap_or(&line));
        if prefixed {
            out.write_all(format!("{} | ", crate::terminal::text(&self.name)).as_bytes())?;
        }
        out.write_all(line.as_bytes())?;
        Ok(out.write_all(b"\n")?)
    }
}

/// Longest unterminated log line held back before it is printed anyway.
const MAX_PARTIAL_LOG_LINE: usize = 64 * 1024;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ps_fields_cannot_add_a_line() {
        let hostile = "x\nfake line\x1b[2J";
        let row = |service: &str| Row {
            service: service.into(),
            kind: hostile.into(),
            state: "running",
            address: Some(hostile.into()),
            pid: Some(7),
            worker_host_id: None,
            connected: Some(true),
            draining: None,
            attempts: None,
            capacity: None,
        };
        let report = PsReport {
            state_directory: format!("/tmp/{hostile}"),
            supervisor: Some(SupervisorRow {
                pid: 1,
                mode: "service".into(),
                version: hostile.into(),
                unit: Some(hostile.into()),
            }),
            services: vec![row(hostile), row("gateway")],
        };
        let text = format_ps(&report, &Supervisor::Stopped);
        assert_eq!(text.lines().count(), 4, "{text}");
        assert!(
            !text.lines().any(|line| line.starts_with("fake line")),
            "{text}"
        );
        assert!(!text.contains('\x1b'), "{text}");
        assert!(text.contains("x fake line [2J"), "{text}");
    }

    #[test]
    fn timestamps_are_iso_8601_utc() {
        let time = UNIX_EPOCH + Duration::from_millis(1_762_905_600_123);
        assert_eq!(timestamp(time), "2025-11-12T00:00:00.123Z");
        assert_eq!(timestamp(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        let leap = UNIX_EPOCH + Duration::from_secs(951_782_400);
        assert_eq!(timestamp(leap), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn flags_fingerprint_ignores_only_how_up_starts() {
        let a = flags_fingerprint(&["up".into(), "--adapter".into(), "x".into()]);
        let b = flags_fingerprint(&[
            "up".into(),
            "--force".into(),
            "--adapter".into(),
            "x".into(),
            "--foreground".into(),
        ]);
        let c = flags_fingerprint(&["up".into(), "--adapter".into(), "y".into()]);
        assert_eq!(a, b);
        assert_ne!(a, c);
        // An adapter argument that looks like a start flag is a setting.
        let args: Vec<OsString> = [
            "up",
            "--adapter",
            "x",
            "--adapter-arg",
            "--force",
            "--force",
        ]
        .into_iter()
        .map(OsString::from)
        .collect();
        assert_eq!(
            setting_args(&args),
            ["up", "--adapter", "x", "--adapter-arg", "--force"]
                .map(OsString::from)
                .to_vec()
        );
        assert_ne!(flags_fingerprint(&args), a);
    }

    #[test]
    fn host_logs_live_apart_from_fixed_service_logs() {
        let state = Path::new("/state");
        assert_eq!(
            log_path(state, GATEWAY),
            Path::new("/state/logs/gateway.log")
        );
        assert_eq!(
            log_path(state, "laptop"),
            Path::new("/state/logs/hosts/laptop.log")
        );
    }
}
