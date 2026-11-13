//! Transport at scale between the shipped Control Plane, Gateway, and Worker Host
//! processes: injected partitions and reconnects across independently enrolled
//! Worker Hosts, a stalled event consumer, TLS and mTLS between all three service
//! roles, and protocol version negotiation.
//!
//! Ports `tests/worklet-transport-adoption-gates.test.ts` (16 hosts, partition,
//! reconnect, no repeated accepted work) to the Rust services.
#[path = "support/protocol.rs"]
mod protocol;
use std::{
    collections::{BTreeMap, BTreeSet},
    net::SocketAddr,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    str::FromStr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use supertag_protocol::negotiation::ProtocolChannel;

use anyhow::{Context, Result, anyhow, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{ConnectOptions, Connection, Executor, PgConnection, postgres::PgConnectOptions};
use supertag_protocol::{
    authenticated_request,
    negotiation::{NegotiationError, Negotiator, negotiate, negotiate_versions},
    v2::{
        CreateAuthKeyRequest, GetTaskRequest, ListEventsRequest, ListNativeUsageRequest,
        PutTagRequest, ServiceRole, SubmitTaskRequest, TaskState, WatchChange, WatchEvent,
        WatchKind, WatchRequest,
        operator_client::OperatorClient,
        operator_events_client::OperatorEventsClient,
        operator_events_server::{OperatorEvents, OperatorEventsServer},
        watch_event::Update,
    },
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    net::{TcpListener, TcpStream},
    process::{Child, Command},
    task::{AbortHandle, JoinHandle},
    time::{sleep, timeout},
};
use tokio_stream::{Stream, StreamExt, wrappers::TcpListenerStream};
use tonic::{
    Request, Response, Status,
    transport::{Certificate, Channel, ClientTlsConfig, Endpoint, Identity, Server},
};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const STARTUP: Duration = Duration::from_secs(20);

// ---------------------------------------------------------------------------
// Processes

/// A test-owned SuperTag process. Dropping it asks the process to stop, then kills it.
struct Service {
    child: Child,
    log: PathBuf,
}

impl Service {
    fn spawn(mut command: Command, directory: &Path, name: &str) -> Result<Self> {
        let log = directory.join(format!("{name}-{}.log", Uuid::new_v4().simple()));
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(std::fs::File::create(&log)?)
            .kill_on_drop(true);
        Ok(Self {
            child: command.spawn().with_context(|| format!("spawn {name}"))?,
            log,
        })
    }

    /// Reads the bound address a server reports on its first stdout line.
    async fn address(&mut self) -> Result<SocketAddr> {
        let stdout = self.child.stdout.take().context("server stdout missing")?;
        let mut line = String::new();
        let read = timeout(STARTUP, BufReader::new(stdout).read_line(&mut line)).await;
        match read {
            Ok(Ok(bytes)) if bytes > 0 => {}
            _ => return Err(anyhow!("server did not report an address: {}", self.logs())),
        }
        let address: SocketAddr = line
            .trim()
            .parse()
            .with_context(|| format!("invalid address line {line:?}: {}", self.logs()))?;
        ensure!(address.ip().is_loopback() && address.port() != 0);
        Ok(address)
    }

    /// Waits for a process that must fail and returns its diagnostics.
    async fn failure(&mut self) -> Result<String> {
        let status = timeout(STARTUP, self.child.wait())
            .await
            .with_context(|| format!("process did not exit: {}", self.logs()))??;
        ensure!(
            !status.success(),
            "process unexpectedly succeeded: {}",
            self.logs()
        );
        Ok(self.logs())
    }

    fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    fn running(&mut self) -> Result<bool> {
        Ok(self.child.try_wait()?.is_none())
    }

    fn logs(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        let Some(pid) = self.child.id() else {
            return;
        };
        // A Worker Host stops its adapter on SIGTERM; anything still alive is killed.
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = self.child.start_kill();
    }
}

fn binary(args: &[&str]) -> Command {
    let mut command = Command::new(BINARY);
    // Never inherit an operator's credentials, TLS settings, or state location.
    command.args(args).env_clear();
    command
}

async fn run(mut command: Command) -> Result<std::process::Output> {
    command.stdin(Stdio::null()).kill_on_drop(true);
    Ok(timeout(STARTUP, command.output())
        .await
        .context("SuperTag command did not exit")??)
}

async fn run_json(command: Command) -> Result<Value> {
    let output = run(command).await?;
    ensure!(
        output.status.success(),
        "SuperTag command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}

struct Tokens {
    gateway: String,
    operator: String,
}

impl Tokens {
    fn new() -> Self {
        Self {
            gateway: Uuid::new_v4().to_string(),
            operator: Uuid::new_v4().to_string(),
        }
    }

    fn request<T>(&self, message: T) -> Result<Request<T>> {
        let mut request = authenticated_request(message, &self.operator, None)?;
        request.set_timeout(Duration::from_secs(15));
        Ok(request)
    }
}

/// A Control Plane and Gateway in separate processes.
struct Services {
    _control_plane: Service,
    control_plane_address: SocketAddr,
    gateway: Service,
    gateway_address: SocketAddr,
}

impl Services {
    async fn start(database: &str, directory: &Path, tokens: &Tokens) -> Result<Self> {
        let mut command = binary(&["control-plane"]);
        command
            .env("SUPERTAG_GATEWAY_TOKEN", &tokens.gateway)
            .env("SUPERTAG_DATABASE_URL", database);
        let mut control_plane = Service::spawn(command, directory, "control-plane")?;
        let private = control_plane.address().await?;
        let mut command = binary(&["gateway", "--control-plane", &format!("http://{private}")]);
        command
            .env("SUPERTAG_GATEWAY_TOKEN", &tokens.gateway)
            .env("SUPERTAG_OPERATOR_TOKEN", &tokens.operator);
        let mut gateway = Service::spawn(command, directory, "gateway")?;
        let gateway_address = gateway.address().await?;
        Ok(Self {
            _control_plane: control_plane,
            control_plane_address: private,
            gateway,
            gateway_address,
        })
    }

    async fn channel(&self) -> Result<ProtocolChannel> {
        protocol::negotiated(connect(self.gateway_address).await?).await
    }

    /// A Gateway channel that has not negotiated.
    async fn raw_channel(&self) -> Result<Channel> {
        connect(self.gateway_address).await
    }

    /// A Control Plane channel that has not negotiated.
    async fn raw_control_plane_channel(&self) -> Result<Channel> {
        connect(self.control_plane_address).await
    }
}

async fn connect(address: SocketAddr) -> Result<Channel> {
    Ok(Endpoint::from_shared(format!("http://{address}"))?
        .connect_timeout(Duration::from_secs(3))
        .connect()
        .await?)
}

/// Runs a scenario against a disposable PostgreSQL database and always drops it.
async fn with_postgres<F, Fut>(label: &str, scenario: F) -> Result<()>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<()>> + Send + 'static,
{
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .context("PostgreSQL process tests require SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")?;
    let admin_url = std::fs::read_to_string(path)?;
    let options = PgConnectOptions::from_str(admin_url.trim())?;
    let mut admin = PgConnection::connect_with(&options).await?;
    let name = format!("supertag_rust_{label}_{}", Uuid::new_v4().simple());
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await?;
    let database = options.database(&name).to_url_lossy().to_string();
    // Isolate panics so the database is dropped after every process is reaped.
    let result = tokio::spawn(scenario(database)).await;
    let cleanup = admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await;
    admin.close().await?;
    cleanup?;
    result.context("PostgreSQL scenario panicked")?
}

fn sqlite(directory: &Path) -> String {
    format!(
        "sqlite://{}?mode=rwc",
        directory.join("control.db").display()
    )
}

// ---------------------------------------------------------------------------
// Partition proxy

#[derive(Default)]
struct ProxyState {
    partitioned: AtomicBool,
    accepted: AtomicU64,
    refused: AtomicU64,
    links: Mutex<Vec<AbortHandle>>,
}

/// A TCP relay in front of the Gateway for one Worker Host. A partition severs every
/// open connection and refuses new ones until it is restored.
struct Proxy {
    address: SocketAddr,
    state: Arc<ProxyState>,
    task: JoinHandle<()>,
}

impl Proxy {
    async fn start(target: SocketAddr) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let state = Arc::new(ProxyState::default());
        let shared = state.clone();
        let task = tokio::spawn(async move {
            while let Ok((mut downstream, _)) = listener.accept().await {
                let mut links = shared.links.lock().unwrap();
                if shared.partitioned.load(Ordering::SeqCst) {
                    shared.refused.fetch_add(1, Ordering::SeqCst);
                    drop(downstream);
                    continue;
                }
                shared.accepted.fetch_add(1, Ordering::SeqCst);
                let link = tokio::spawn(async move {
                    if let Ok(mut upstream) = TcpStream::connect(target).await {
                        let _ = tokio::io::copy_bidirectional(&mut downstream, &mut upstream).await;
                    }
                });
                links.retain(|link| !link.is_finished());
                links.push(link.abort_handle());
            }
        });
        Ok(Self {
            address,
            state,
            task,
        })
    }

    fn partition(&self) {
        let mut links = self.state.links.lock().unwrap();
        self.state.partitioned.store(true, Ordering::SeqCst);
        for link in links.drain(..) {
            link.abort();
        }
    }

    fn restore(&self) {
        let _links = self.state.links.lock().unwrap();
        self.state.partitioned.store(false, Ordering::SeqCst);
    }

    fn accepted(&self) -> u64 {
        self.state.accepted.load(Ordering::SeqCst)
    }

    fn refused(&self) -> u64 {
        self.state.refused.load(Ordering::SeqCst)
    }

    fn url(&self) -> String {
        format!("http://{}", self.address)
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.partition();
        self.task.abort();
    }
}

// ---------------------------------------------------------------------------
// Seeded fault schedule

/// SplitMix64: a small, reproducible generator for the fault schedule.
struct Seeded(u64);

impl Seeded {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound as u64) as usize
    }

    /// A nonempty random subset of `0..count`.
    fn subset(&mut self, count: usize) -> Vec<usize> {
        let chosen: Vec<_> = (0..count)
            .filter(|_| self.next().is_multiple_of(2))
            .collect();
        if chosen.is_empty() {
            vec![self.below(count)]
        } else {
            chosen
        }
    }
}

#[derive(Clone, Copy)]
struct Workload {
    name: &'static str,
    hosts: usize,
    tags: usize,
    waves: usize,
    /// Extra partitions of a random host subset while each execution wave runs.
    rounds: usize,
    partition: Duration,
    /// Queue latency bound from submission, or from restoring a partitioned host.
    queue_latency: Duration,
    reconnect: Duration,
}

const FAST: Workload = Workload {
    name: "fast",
    hosts: 4,
    tags: 2,
    waves: 2,
    rounds: 0,
    partition: Duration::from_millis(1500),
    queue_latency: Duration::from_secs(10),
    reconnect: Duration::from_secs(5),
};

const HEAVY: Workload = Workload {
    name: "heavy",
    hosts: 16,
    tags: 4,
    waves: 4,
    rounds: 2,
    partition: Duration::from_secs(4),
    queue_latency: Duration::from_secs(10),
    reconnect: Duration::from_secs(5),
};

fn seed() -> Result<u64> {
    match std::env::var("SUPERTAG_TRANSPORT_SEED") {
        Ok(value) => value
            .parse()
            .context("SUPERTAG_TRANSPORT_SEED must be an unsigned integer"),
        Err(_) => Ok(0x5eed_2026_1112),
    }
}

// ---------------------------------------------------------------------------
// Partition and reconnect workload

struct Host {
    id: String,
    proxy: Proxy,
    release: PathBuf,
    launches: PathBuf,
    process: Service,
}

impl Host {
    fn launches(&self) -> Result<usize> {
        Ok(std::fs::read_to_string(&self.launches)
            .unwrap_or_default()
            .lines()
            .count())
    }
}

struct Submitted {
    task_id: String,
    tag: usize,
    instructions: String,
    prompt: String,
    queued_from: Instant,
    attempt_id: Option<String>,
}

#[derive(Default)]
struct Report {
    faults: Vec<Value>,
    queue_latencies: Vec<u128>,
    reconnects: Vec<u128>,
    partitions: usize,
    observed_states: BTreeSet<String>,
}

fn recording_adapter(directory: &Path, host: &str) -> Result<(PathBuf, PathBuf)> {
    let script = directory.join(format!("{host}-adapter"));
    let launches = directory.join(format!("{host}-launches"));
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$$\" >> '{}'\n'{}' \"$@\" 2>> '{2}'\nstatus=$?\nprintf 'adapter %s exited %s at %s\\n' \"$$\" \"$status\" \"$(date +%s)\" >> '{2}'\nexit $status\n",
            launches.display(),
            ADAPTER,
            launches.with_extension("stderr").display()
        ),
    )?;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))?;
    Ok((script, launches))
}

async fn start_host(
    operator: &mut OperatorClient<ProtocolChannel>,
    tokens: &Tokens,
    gateway: SocketAddr,
    directory: &Path,
    index: usize,
    tag: &str,
    adapter_args: &[&str],
) -> Result<Host> {
    let id = format!("scale-host-{index:02}");
    let proxy = Proxy::start(gateway).await?;
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    operator
        .create_auth_key(tokens.request(CreateAuthKeyRequest {
            name: id.clone(),
            host_id: id.clone(),
            operation_id: Uuid::new_v4().to_string(),
            key_digest: Sha256::digest(secret.as_bytes()).to_vec(),
            expires_in_ms: 600_000,
            allowed_tag_ids: vec![tag.into()],
            all_tags: false,
            reusable: false,
            ephemeral: false,
            labels: vec![],
        })?)
        .await?;
    let state = directory.join(&id);
    let key = directory.join(format!("{id}.key"));
    std::fs::write(&key, &secret)?;
    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600))?;
    let mut enroll = binary(&["host", "enroll", &id, "--gateway", &proxy.url()]);
    enroll
        .arg("--state-directory")
        .arg(&state)
        .arg("--auth-key")
        .arg(format!("file:{}", key.display()));
    let enrolled = run_json(enroll).await?;
    ensure!(enrolled["host_id"] == id.as_str(), "unexpected enrollment");
    std::fs::remove_file(key)?;
    let (adapter, launches) = recording_adapter(directory, &id)?;
    let release = directory.join(format!("{id}.release"));
    let mut command = binary(&["worker-host", "--gateway", &proxy.url()]);
    command
        .arg("--state-directory")
        .arg(&state)
        .arg("--adapter")
        .arg(&adapter)
        .arg(format!(
            "--adapter-arg=--wait-for-file={}",
            release.display()
        ));
    for argument in adapter_args {
        command.arg(format!("--adapter-arg={argument}"));
    }
    let process = Service::spawn(command, directory, &id)?;
    Ok(Host {
        id,
        proxy,
        release,
        launches,
        process,
    })
}

async fn task_state(
    operator: &mut OperatorClient<ProtocolChannel>,
    tokens: &Tokens,
    id: &str,
) -> Result<supertag_protocol::v2::Task> {
    let sent = Instant::now();
    let task = operator
        .get_task(tokens.request(GetTaskRequest { task_id: id.into() })?)
        .await
        .with_context(|| format!("read Task {id} after {:?}", sent.elapsed()))?
        .into_inner();
    SLOWEST_READ_MS.fetch_max(sent.elapsed().as_millis() as u64, Ordering::SeqCst);
    Ok(task)
}

/// The slowest operator read during a workload, reported with its invariants.
static SLOWEST_READ_MS: AtomicU64 = AtomicU64::new(0);

/// Polls until every Task reaches `expected`, recording each Task's queue latency
/// when it first leaves the queue.
async fn wait_for_all(
    operator: &mut OperatorClient<ProtocolChannel>,
    tokens: &Tokens,
    tasks: &mut [Submitted],
    expected: TaskState,
    bound: Duration,
    report: &mut Report,
) -> Result<()> {
    let deadline = Instant::now() + bound;
    let mut pending: BTreeSet<usize> = (0..tasks.len()).collect();
    while !pending.is_empty() {
        for index in pending.clone() {
            let task = &mut tasks[index];
            let observed = task_state(operator, tokens, &task.task_id).await?;
            report
                .observed_states
                .insert(observed.state().as_str_name().to_owned());
            ensure!(
                !matches!(
                    observed.state(),
                    TaskState::Uncertain | TaskState::Failed | TaskState::Cancelled
                ),
                "Task {} ({}) entered {:?} under transport faults: {:?}",
                task.task_id,
                task.prompt,
                observed.state(),
                observed.result
            );
            if observed.state() != TaskState::Queued && task.attempt_id.is_none() {
                report
                    .queue_latencies
                    .push(task.queued_from.elapsed().as_millis());
                ensure!(
                    task.queued_from.elapsed() <= bound,
                    "Task {} ({}) waited {:?} in the queue",
                    task.task_id,
                    task.prompt,
                    task.queued_from.elapsed()
                );
                task.attempt_id = Some(observed.attempt_id.clone().context("Attempt missing")?);
            }
            if let Some(attempt) = &task.attempt_id {
                ensure!(
                    observed.attempt_id.as_deref() == Some(attempt.as_str()),
                    "Task {} moved from Attempt {attempt} to {:?}",
                    task.task_id,
                    observed.attempt_id
                );
            }
            if observed.state() == expected {
                pending.remove(&index);
            }
        }
        if pending.is_empty() {
            break;
        }
        ensure!(
            Instant::now() < deadline,
            "{} Tasks did not reach {expected:?} within {bound:?}",
            pending.len()
        );
        sleep(Duration::from_millis(25)).await;
    }
    Ok(())
}

/// Partitions the selected hosts, proves each one noticed by retrying, holds the
/// partition, and restores it while measuring how quickly each host reconnects.
async fn partition_round(
    hosts: &[Host],
    selected: &[usize],
    hold: Duration,
    release_during: &[usize],
    reconnect_bound: Duration,
    report: &mut Report,
) -> Result<()> {
    let refused: Vec<_> = selected
        .iter()
        .map(|index| hosts[*index].proxy.refused())
        .collect();
    for index in selected {
        hosts[*index].proxy.partition();
    }
    report.partitions += selected.len();
    let started = Instant::now();
    let deadline = started + Duration::from_secs(15);
    while selected
        .iter()
        .zip(&refused)
        .any(|(index, before)| hosts[*index].proxy.refused() == *before)
    {
        ensure!(
            Instant::now() < deadline,
            "partitioned Worker Hosts never retried their Gateway connection"
        );
        sleep(Duration::from_millis(20)).await;
    }
    // Completing during the partition forces the host to retry its result report.
    for index in release_during {
        std::fs::write(&hosts[*index].release, b"release")?;
    }
    if let Some(remaining) = hold.checked_sub(started.elapsed()) {
        sleep(remaining).await;
    }
    let accepted: Vec<_> = selected
        .iter()
        .map(|index| hosts[*index].proxy.accepted())
        .collect();
    let restored = Instant::now();
    for index in selected {
        hosts[*index].proxy.restore();
    }
    let mut waiting: BTreeMap<usize, u64> = selected.iter().copied().zip(accepted).collect();
    while !waiting.is_empty() {
        waiting.retain(|index, before| {
            if hosts[*index].proxy.accepted() > *before {
                report.reconnects.push(restored.elapsed().as_millis());
                false
            } else {
                true
            }
        });
        ensure!(
            restored.elapsed() <= reconnect_bound || waiting.is_empty(),
            "Worker Hosts {:?} did not reconnect within {reconnect_bound:?}",
            waiting
                .keys()
                .map(|index| format!("{}: {}", hosts[*index].id, hosts[*index].process.logs()))
                .collect::<Vec<_>>()
        );
        sleep(Duration::from_millis(10)).await;
    }
    Ok(())
}

async fn submit_wave(
    operator: &mut OperatorClient<ProtocolChannel>,
    tokens: &Tokens,
    workload: &Workload,
    wave: usize,
) -> Result<Vec<Submitted>> {
    let mut submitted = Vec::new();
    for index in 0..workload.hosts {
        let tag = index % workload.tags;
        let prompt = format!("wave {wave} item {index}");
        let accepted = operator
            .submit_task(tokens.request(SubmitTaskRequest {
                output_policy: None,
                execution_limits: None,
                tag_id: format!("scale-tag-{tag}"),
                session_id: format!("scale-{wave}-{index}"),
                operation_id: format!("scale-{wave}-{index}"),
                prompt: prompt.clone(),
                input_artifacts: vec![],
            })?)
            .await?
            .into_inner();
        submitted.push(Submitted {
            task_id: accepted.task_id,
            tag,
            instructions: format!("Finish scale item for tag {tag}"),
            prompt,
            queued_from: Instant::now(),
            attempt_id: None,
        });
    }
    Ok(submitted)
}

async fn exercise_workload(workload: Workload, database: String, label: &str) -> Result<Value> {
    let mut directory = tempfile::tempdir()?;
    // Keep process logs and host journals for a failing seed when asked.
    if std::env::var_os("SUPERTAG_TRANSPORT_KEEP").is_some() {
        directory.disable_cleanup(true);
        eprintln!(
            "transport workload directory: {}",
            directory.path().display()
        );
    }
    let root = directory.path();
    let seed = seed()?;
    let mut random = Seeded(seed);
    let started = Instant::now();
    let tokens = Tokens::new();
    let services = Services::start(&database, root, &tokens).await?;
    let channel = services.channel().await?;
    let mut operator = OperatorClient::new(channel.clone());
    for tag in 0..workload.tags {
        operator
            .put_tag(tokens.request(PutTagRequest {
                tag_id: format!("scale-tag-{tag}"),
                instructions: format!("Finish scale item for tag {tag}"),
                allowed_actions: vec![],
                workspace: None,
                harness_kind: 0,
                approval_rules: vec![],
                execution: None,
                name: None,
                expected_revision: None,
            })?)
            .await?;
    }
    // A watcher that never reads must not slow the workload or lose changes.
    let mut stalled_watch = stalled_watch_client(services.gateway_address, &tokens).await?;

    let mut hosts = Vec::new();
    for index in 0..workload.hosts {
        let tag = format!("scale-tag-{}", index % workload.tags);
        hosts.push(
            start_host(
                &mut operator,
                &tokens,
                services.gateway_address,
                root,
                index,
                &tag,
                &[],
            )
            .await?,
        );
    }

    let mut report = Report::default();
    let mut all_tasks = Vec::new();
    for wave in 0..workload.waves {
        for host in &hosts {
            let _ = std::fs::remove_file(&host.release);
        }
        let everyone: Vec<usize> = (0..hosts.len()).collect();
        let mut tasks;
        if wave % 2 == 0 {
            // Execution partition: every Attempt is running when its host loses the Gateway.
            tasks = submit_wave(&mut operator, &tokens, &workload, wave).await?;
            wait_for_all(
                &mut operator,
                &tokens,
                &mut tasks,
                TaskState::Running,
                workload.queue_latency,
                &mut report,
            )
            .await?;
            for round in 0..workload.rounds {
                let selected = random.subset(hosts.len());
                report.faults.push(json!({
                    "wave": wave, "round": round, "kind": "execution",
                    "hosts": selected.iter().map(|index| &hosts[*index].id).collect::<Vec<_>>(),
                }));
                partition_round(
                    &hosts,
                    &selected,
                    workload.partition,
                    &[],
                    workload.reconnect,
                    &mut report,
                )
                .await?;
            }
            let release_during = random.subset(hosts.len());
            report.faults.push(json!({
                "wave": wave, "kind": "execution-all",
                "released_during_partition": release_during
                    .iter()
                    .map(|index| &hosts[*index].id)
                    .collect::<Vec<_>>(),
            }));
            partition_round(
                &hosts,
                &everyone,
                workload.partition,
                &release_during,
                workload.reconnect,
                &mut report,
            )
            .await?;
        } else {
            // Queue partition: work is accepted while no host can reach the Gateway.
            for host in &hosts {
                host.proxy.partition();
            }
            report.partitions += hosts.len();
            tasks = submit_wave(&mut operator, &tokens, &workload, wave).await?;
            report
                .faults
                .push(json!({"wave": wave, "kind": "queued-all"}));
            sleep(workload.partition).await;
            for task in &tasks {
                let observed = task_state(&mut operator, &tokens, &task.task_id).await?;
                ensure!(
                    observed.state() == TaskState::Queued,
                    "a partitioned Worker Host claimed {}",
                    task.task_id
                );
            }
            let accepted: Vec<_> = hosts.iter().map(|host| host.proxy.accepted()).collect();
            let restored = Instant::now();
            for host in &hosts {
                host.proxy.restore();
            }
            for task in &mut tasks {
                task.queued_from = restored;
            }
            wait_for_all(
                &mut operator,
                &tokens,
                &mut tasks,
                TaskState::Running,
                workload.queue_latency,
                &mut report,
            )
            .await?;
            for (host, before) in hosts.iter().zip(accepted) {
                ensure!(
                    host.proxy.accepted() > before,
                    "{} never reconnected",
                    host.id
                );
            }
        }
        for host in &hosts {
            std::fs::write(&host.release, b"release")?;
        }
        wait_for_all(
            &mut operator,
            &tokens,
            &mut tasks,
            TaskState::Succeeded,
            Duration::from_secs(30),
            &mut report,
        )
        .await?;
        for host in &hosts {
            ensure!(
                host.launches()? == wave + 1,
                "{} launched {} adapters after {} waves",
                host.id,
                host.launches()?,
                wave + 1
            );
        }
        all_tasks.extend(tasks);
    }

    // Audit every accepted Task: one Attempt, one execution, one result, no lost events.
    let mut attempts = BTreeSet::new();
    for task in &all_tasks {
        let observed = task_state(&mut operator, &tokens, &task.task_id).await?;
        let attempt = task.attempt_id.clone().context("Task never ran")?;
        ensure!(observed.attempt_id.as_deref() == Some(attempt.as_str()));
        let expected = format!("{}: {} []", task.instructions, task.prompt);
        ensure!(
            observed.result.as_deref() == Some(expected.as_str()),
            "Task {} lost its result: {:?}",
            task.task_id,
            observed.result
        );
        ensure!(observed.tag_id == format!("scale-tag-{}", task.tag));
        let events = operator
            .list_events(tokens.request(ListEventsRequest {
                task_id: task.task_id.clone(),
                after_sequence: 0,
                limit: 100,
            })?)
            .await?
            .into_inner()
            .events;
        let history: Vec<_> = events
            .iter()
            .map(|event| (event.sequence, event.text.as_str()))
            .collect();
        ensure!(
            history == [(1, format!("{attempt} started").as_str()), (2, &expected)],
            "Task {} history was {history:?}",
            task.task_id
        );
        ensure!(attempts.insert(attempt), "Attempt shared between Tasks");
    }
    let launches: usize = hosts
        .iter()
        .map(Host::launches)
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .sum();
    ensure!(
        launches == all_tasks.len(),
        "{launches} adapter launches for {} Tasks",
        all_tasks.len()
    );

    // The stalled watcher resumes from its stream and still sees every Task.
    let watched = drain_task_changes(&mut stalled_watch, &all_tasks).await?;
    ensure!(watched == all_tasks.len());
    for host in &mut hosts {
        ensure!(
            host.process.running()?,
            "{} exited during the workload: {}",
            host.id,
            host.process.logs()
        );
    }

    let mut latencies = report.queue_latencies.clone();
    latencies.sort_unstable();
    let percentile = |p: usize| latencies[(latencies.len() - 1) * p / 100];
    let retries: u64 = hosts.iter().map(|host| host.proxy.refused()).sum();
    let connections: u64 = hosts.iter().map(|host| host.proxy.accepted()).sum();
    let summary = json!({
        "workload": workload.name,
        "database": label,
        "seed": seed,
        "worker_hosts": hosts.len(),
        "tags": workload.tags,
        "tasks": all_tasks.len(),
        "attempts": attempts.len(),
        "attempt_retries": attempts.len() - all_tasks.len(),
        "adapter_launches": launches,
        "duplicate_executions": launches - all_tasks.len(),
        "lost_results": 0,
        "host_partitions": report.partitions,
        "refused_reconnect_attempts": retries,
        "gateway_connections": connections,
        "max_reconnect_ms": report.reconnects.iter().max(),
        "slowest_operator_read_ms": SLOWEST_READ_MS.load(Ordering::SeqCst),
        "queue_latency_ms": {"p50": percentile(50), "p95": percentile(95), "max": percentile(100)},
        "queue_latency_bound_ms": workload.queue_latency.as_millis(),
        "observed_task_states": report.observed_states,
        "faults": report.faults,
        "elapsed_ms": started.elapsed().as_millis(),
    });
    println!("{}", serde_json::to_string_pretty(&summary)?);
    if let Some(path) = std::env::var_os("SUPERTAG_TRANSPORT_REPORT") {
        std::fs::write(path, serde_json::to_vec_pretty(&summary)?)?;
    }
    drop(services);
    Ok(summary)
}

async fn stalled_watch_client(
    gateway: SocketAddr,
    tokens: &Tokens,
) -> Result<tonic::Streaming<WatchEvent>> {
    let channel = protocol::negotiated(
        Endpoint::from_shared(format!("http://{gateway}"))?
            .initial_stream_window_size(16 * 1024)
            .initial_connection_window_size(16 * 1024)
            .connect()
            .await?,
    )
    .await?;
    let request = authenticated_request(
        WatchRequest {
            resume_token: String::new(),
            kinds: vec![WatchKind::Task as i32],
        },
        &tokens.operator,
        None,
    )?;
    Ok(OperatorEventsClient::new(channel)
        .watch(request)
        .await?
        .into_inner())
}

async fn drain_task_changes(
    watch: &mut tonic::Streaming<WatchEvent>,
    tasks: &[Submitted],
) -> Result<usize> {
    let wanted: BTreeSet<&str> = tasks.iter().map(|task| task.task_id.as_str()).collect();
    let mut seen = BTreeSet::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    while seen.len() < wanted.len() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let event = timeout(remaining, watch.message())
            .await
            .context("stalled watcher never caught up")??
            .context("Watch ended")?;
        match event.update {
            Some(Update::Change(WatchChange { id, .. })) if wanted.contains(id.as_str()) => {
                seen.insert(id);
            }
            Some(Update::Resync(_)) => return Err(anyhow!("Watch lost its cursor")),
            _ => {}
        }
    }
    Ok(seen.len())
}

fn check_summary(summary: &Value, workload: &Workload) {
    let tasks = workload.hosts * workload.waves;
    assert_eq!(summary["worker_hosts"], workload.hosts);
    assert_eq!(summary["tasks"], tasks);
    assert_eq!(summary["attempts"], tasks);
    assert_eq!(summary["duplicate_executions"], 0);
    assert!(summary["refused_reconnect_attempts"].as_u64().unwrap() >= workload.hosts as u64);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sqlite_partitioned_worker_hosts_reconnect_without_repeating_work() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let summary = exercise_workload(FAST, sqlite(directory.path()), "sqlite").await?;
    check_summary(&summary, &FAST);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_partitioned_worker_hosts_reconnect_without_repeating_work() -> Result<()> {
    with_postgres("transport_fast", |database| async move {
        let summary = exercise_workload(FAST, database, "postgresql").await?;
        check_summary(&summary, &FAST);
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "heavy 16-host workload; opt in with --ignored (SUPERTAG_TRANSPORT_SEED replays a schedule)"]
async fn sqlite_sixteen_host_partition_storm_preserves_invariants() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let summary = exercise_workload(HEAVY, sqlite(directory.path()), "sqlite").await?;
    check_summary(&summary, &HEAVY);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "heavy 16-host workload on PostgreSQL via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_sixteen_host_partition_storm_preserves_invariants() -> Result<()> {
    with_postgres("transport_heavy", |database| async move {
        let summary = exercise_workload(HEAVY, database, "postgresql").await?;
        check_summary(&summary, &HEAVY);
        Ok(())
    })
    .await
}

// ---------------------------------------------------------------------------
// Adapter calls relayed through a partition

/// The steps `--partition-steps` makes, in order (see the fixture's
/// `partition_calls` module). `take` runs connected: a take is never repeated.
const PARTITION_STEPS: [&str; 9] = [
    "usage",
    "mailbox-read",
    "mailbox-send",
    "workstream-read",
    "workstream-post",
    "question",
    "work-session-start",
    "take",
    "settle",
];

fn step_marker(base: &Path, step: &str, suffix: &str) -> PathBuf {
    let mut path = base.as_os_str().to_owned();
    path.push(format!(".{step}.{suffix}"));
    PathBuf::from(path)
}

async fn wait_for_marker(path: &Path, host: &Host) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(60);
    while !path.exists() {
        ensure!(
            Instant::now() < deadline,
            "{} never appeared\n{}\nadapter: {}",
            path.display(),
            host.process.logs(),
            std::fs::read_to_string(host.launches.with_extension("stderr")).unwrap_or_default()
        );
        sleep(Duration::from_millis(20)).await;
    }
    Ok(())
}

async fn operator_cli(services: &Services, tokens: &Tokens, args: &[&str]) -> Result<Value> {
    let gateway = format!("http://{}", services.gateway_address);
    let mut full = vec![args[0], "--gateway", gateway.as_str()];
    full.extend_from_slice(&args[1..]);
    let mut command = binary(&full);
    command.env("SUPERTAG_OPERATOR_TOKEN", &tokens.operator);
    run_json(command).await
}

/// Every adapter-facing call the Worker Host may repeat starts while its host
/// cannot reach the Gateway: usage, Mailbox read and send, Workstream read and
/// post, an Objective question, a Work Session start, and a live-input
/// settlement. The first partition lasts 18 seconds: longer than a host
/// channel holds one call (15 seconds) and shorter than the 30-second
/// execution lease; the rest last 4 seconds, inside the live input's
/// 10-second acknowledgement window, and the host reconnects and renews its
/// lease between partitions. Each call is still outstanding when its
/// partition heals, the Attempt succeeds, the adapter runs once, and every
/// effect the Control Plane deduplicates is recorded exactly once.
async fn exercise_adapter_calls_through_partition(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let tokens = Tokens::new();
    let services = Services::start(&database, root, &tokens).await?;
    let mut operator = OperatorClient::new(services.channel().await?);
    let tag = "partition-calls";
    let peer = "partition-peer";
    for id in [tag, peer] {
        operator_cli(
            &services,
            &tokens,
            &["tag", "put", id, "--instructions", "Relay calls"],
        )
        .await?;
    }
    operator_cli(
        &services,
        &tokens,
        &[
            "mailbox-grant",
            "allow",
            tag,
            peer,
            "--operation-id",
            "allow-peer",
        ],
    )
    .await?;
    operator_cli(
        &services,
        &tokens,
        &["team", "create", "relay", "--member", tag, "--member", peer],
    )
    .await?;
    let objective = operator_cli(
        &services,
        &tokens,
        &[
            "objective",
            "create",
            "partition-objective",
            "--owner",
            tag,
            "--team",
            "relay",
            "Relay through the partition",
        ],
    )
    .await?;
    let task_id = objective["starting_task_id"]
        .as_str()
        .context("Objective starting Task")?
        .to_owned();
    let steps = root.join("partition-steps");
    let steps_argument = format!("--partition-steps={}", steps.display());
    let peer_argument = format!("--partition-peer={peer}");
    let host = start_host(
        &mut operator,
        &tokens,
        services.gateway_address,
        root,
        0,
        tag,
        &[&steps_argument, &peer_argument],
    )
    .await?;
    // A Work Session may be delegated only to a Tag with a registered Worker
    // Host. This one holds whatever it claims for the peer and is never released.
    let _peer_host = start_host(
        &mut operator,
        &tokens,
        services.gateway_address,
        root,
        1,
        peer,
        &[],
    )
    .await?;
    std::fs::write(&host.release, "")?;
    let mut input_id = String::new();
    for (index, step) in PARTITION_STEPS.iter().enumerate() {
        wait_for_marker(&step_marker(&steps, step, "ready"), &host).await?;
        if *step == "take" {
            let queued = operator_cli(
                &services,
                &tokens,
                &[
                    "task",
                    "input",
                    &task_id,
                    "Check the partition",
                    "--operation-id",
                    "partition-input",
                ],
            )
            .await?;
            input_id = queued["input_id"]
                .as_str()
                .context("live input ID")?
                .to_owned();
            std::fs::write(step_marker(&steps, step, "go"), "")?;
            continue;
        }
        let refused = host.proxy.refused();
        host.proxy.partition();
        std::fs::write(step_marker(&steps, step, "go"), "")?;
        sleep(if index == 0 {
            Duration::from_secs(18)
        } else {
            Duration::from_secs(4)
        })
        .await;
        // The call cannot have finished: the fixture would have moved on.
        if let Some(next) = PARTITION_STEPS.get(index + 1) {
            ensure!(
                !step_marker(&steps, next, "ready").exists(),
                "{step} finished while its Worker Host was partitioned"
            );
        }
        let current = task_state(&mut operator, &tokens, &task_id).await?;
        ensure!(
            current.state() == TaskState::Running,
            "the Attempt did not ride out the {step} partition: {:?} {:?}\n{}\nadapter: {}",
            current.state(),
            current.result,
            host.process.logs(),
            std::fs::read_to_string(host.launches.with_extension("stderr")).unwrap_or_default()
        );
        ensure!(
            host.proxy.refused() > refused,
            "the {step} partition refused no reconnect"
        );
        let accepted = host.proxy.accepted();
        host.proxy.restore();
        // Let the host reconnect and renew its lease before the next partition,
        // so partitions never add up to more than one lease.
        let reconnected = Instant::now() + Duration::from_secs(20);
        while host.proxy.accepted() == accepted {
            ensure!(
                Instant::now() < reconnected,
                "the Worker Host never reconnected after the {step} partition"
            );
            sleep(Duration::from_millis(20)).await;
        }
        sleep(Duration::from_secs(3)).await;
    }
    let deadline = Instant::now() + Duration::from_secs(60);
    let finished = loop {
        let current = task_state(&mut operator, &tokens, &task_id).await?;
        if !matches!(current.state(), TaskState::Queued | TaskState::Running) {
            break current;
        }
        ensure!(Instant::now() < deadline, "Task never finished");
        sleep(Duration::from_millis(50)).await;
    };
    ensure!(
        finished.state() == TaskState::Succeeded,
        "Task ended {:?}: {:?}\n{}",
        finished.state(),
        finished.result,
        host.process.logs()
    );
    ensure!(
        finished
            .result
            .as_deref()
            .is_some_and(|result| result.contains(&format!(
                "Relayed through partition: {}; input Check the partition",
                PARTITION_STEPS.join(", ")
            ))),
        "unexpected result {:?}",
        finished.result
    );
    let usage = operator
        .list_native_usage(tokens.request(ListNativeUsageRequest {
            task_id: task_id.clone(),
            attempt_id: finished.attempt_id.clone().unwrap_or_default(),
            after_sequence: 0,
            limit: 10,
        })?)
        .await?
        .into_inner();
    ensure!(
        usage.reports.len() == 1
            && usage.reports[0]
                .native_usage
                .as_ref()
                .is_some_and(|native| native.total_tokens == Some(5)),
        "usage was not recorded exactly once: {:?}",
        usage.reports
    );
    let mailbox = operator_cli(&services, &tokens, &["get", "messages", "--mailbox", peer]).await?;
    let messages = mailbox["messages"].as_array().context("Mailbox messages")?;
    ensure!(
        messages
            .iter()
            .filter(|message| message["text"] == "Sent through a partition")
            .count()
            == 1,
        "the Mailbox message was not delivered exactly once: {mailbox}"
    );
    let posts = operator_cli(
        &services,
        &tokens,
        &["get", "workstream-posts", "--team", "relay"],
    )
    .await?;
    ensure!(
        posts["posts"]
            .as_array()
            .context("Workstream posts")?
            .iter()
            .filter(|post| post["body"] == "Posted through a partition")
            .count()
            == 1,
        "the Workstream post was not written exactly once: {posts}"
    );
    // The live input's follower Task is newer in the same Session, so the
    // question is not listed as actionable; it is still published once.
    let question = operator_cli(&services, &tokens, &["get", "question", &task_id]).await?;
    ensure!(
        question["text"] == "Which route survives the partition?",
        "the question was not published: {question}"
    );
    let session = finished.session_id.clone();
    let sessions = operator_cli(
        &services,
        &tokens,
        &[
            "get",
            "sessions",
            "--parent-tag",
            tag,
            "--parent-session",
            &session,
        ],
    )
    .await?;
    ensure!(
        sessions["work_sessions"]
            .as_array()
            .context("Work Sessions")?
            .len()
            == 1,
        "the Work Session was not started exactly once: {sessions}"
    );
    let receipt = operator_cli(&services, &tokens, &["get", "input", &input_id]).await?;
    ensure!(
        receipt["state"] == "LIVE_INPUT_STATE_ACCEPTED",
        "live input was not settled: {receipt}"
    );
    ensure!(host.launches()? == 1, "the adapter ran more than once");
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sqlite_adapter_calls_ride_out_a_gateway_partition() -> Result<()> {
    let directory = tempfile::tempdir()?;
    exercise_adapter_calls_through_partition(sqlite(directory.path())).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_adapter_calls_ride_out_a_gateway_partition() -> Result<()> {
    with_postgres("partition_calls", exercise_adapter_calls_through_partition).await
}

// ---------------------------------------------------------------------------
// Backpressure from a stalled event consumer

const WATCH_PAYLOAD_BYTES: usize = 256 * 1024;

/// A Control Plane stand-in whose Watch can produce without end. It counts only
/// the events a reader actually pulled from it.
#[derive(Clone)]
struct EndlessWatch {
    produced: Arc<AtomicU64>,
}

#[tonic::async_trait]
impl OperatorEvents for EndlessWatch {
    type WatchStream = std::pin::Pin<Box<dyn Stream<Item = Result<WatchEvent, Status>> + Send>>;

    async fn watch(
        &self,
        _request: Request<WatchRequest>,
    ) -> Result<Response<Self::WatchStream>, Status> {
        let produced = self.produced.clone();
        let payload = "x".repeat(WATCH_PAYLOAD_BYTES);
        let events = tokio_stream::iter(1_u64..).map(move |position| {
            produced.fetch_add(1, Ordering::SeqCst);
            Ok(WatchEvent {
                resume_token: format!("v1.{:032x}.{position}", 0),
                update: Some(Update::Change(WatchChange {
                    kind: WatchKind::Task as i32,
                    id: format!("task-{position}"),
                    conversation: payload.clone(),
                    ..Default::default()
                })),
            })
        });
        Ok(Response::new(Box::pin(events)))
    }
}

async fn serve_fake(
    router: tonic::transport::server::Router,
) -> Result<(SocketAddr, JoinHandle<()>)> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let task = tokio::spawn(async move {
        let _ = router
            .serve_with_incoming(TcpListenerStream::new(listener))
            .await;
    });
    Ok((address, task))
}

fn resident_kib(pid: u32) -> Result<u64> {
    let output = std::process::Command::new("/bin/ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()?;
    ensure!(output.status.success(), "could not read process memory");
    Ok(String::from_utf8(output.stdout)?.trim().parse()?)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stalled_watch_consumer_keeps_gateway_memory_and_upstream_reads_bounded() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let tokens = Tokens::new();
    let produced = Arc::new(AtomicU64::new(0));
    let control_plane = Server::builder()
        .add_service(Negotiator::new(ServiceRole::ControlPlane, &[ServiceRole::Gateway]).service())
        .add_service(
            OperatorEventsServer::new(EndlessWatch {
                produced: produced.clone(),
            })
            .max_encoding_message_size(1024 * 1024),
        );
    let (upstream, server) = serve_fake(control_plane).await?;
    let mut command = binary(&["gateway", "--control-plane", &format!("http://{upstream}")]);
    command
        .env("SUPERTAG_GATEWAY_TOKEN", &tokens.gateway)
        .env("SUPERTAG_OPERATOR_TOKEN", &tokens.operator);
    let mut gateway = Service::spawn(command, directory.path(), "gateway")?;
    let address = gateway.address().await?;
    let pid = gateway.pid().context("Gateway exited")?;
    let baseline = resident_kib(pid)?;

    let mut watch = stalled_watch_client(address, &tokens).await?;
    let first = timeout(STARTUP, watch.message())
        .await??
        .context("Watch ended")?;
    assert!(matches!(first.update, Some(Update::Change(_))));

    // Stop reading. A Gateway that buffered for the stalled reader would keep
    // pulling ~256 KiB events from the upstream as fast as it could produce them.
    sleep(Duration::from_secs(2)).await;
    let stalled = produced.load(Ordering::SeqCst);
    sleep(Duration::from_secs(2)).await;
    let still = produced.load(Ordering::SeqCst);
    let resident = resident_kib(pid)?;
    assert_eq!(
        still, stalled,
        "the Gateway kept reading upstream for a stalled consumer"
    );
    assert!(
        stalled <= 64,
        "the Gateway pulled {stalled} upstream events (~{} MiB) for a reader that took one",
        stalled * WATCH_PAYLOAD_BYTES as u64 / (1024 * 1024)
    );
    assert!(
        resident.saturating_sub(baseline) < 64 * 1024,
        "Gateway memory grew from {baseline} KiB to {resident} KiB behind a stalled consumer"
    );

    // Other callers are unaffected while the stream is stalled.
    let health = protocol::negotiated(
        Endpoint::from_shared(format!("http://{address}"))?
            .connect()
            .await?,
    )
    .await?;
    let serving = tonic_health::pb::health_client::HealthClient::new(health)
        .check(tonic_health::pb::HealthCheckRequest {
            service: String::new(),
        })
        .await?
        .into_inner();
    assert_eq!(
        serving.status(),
        tonic_health::pb::health_check_response::ServingStatus::Serving
    );

    // Reading again resumes the same stream in order: the stall was flow control.
    let mut last = 1;
    for _ in 0..(stalled + 32) {
        let event = timeout(STARTUP, watch.message())
            .await??
            .context("Watch ended")?;
        let Some(Update::Change(change)) = event.update else {
            return Err(anyhow!("unexpected Watch update"));
        };
        let position: u64 = change.id.trim_start_matches("task-").parse()?;
        assert_eq!(position, last + 1);
        last = position;
    }
    assert!(produced.load(Ordering::SeqCst) > stalled);
    println!(
        "{}",
        json!({
            "event_bytes": WATCH_PAYLOAD_BYTES,
            "upstream_events_pulled_while_stalled": stalled,
            "gateway_rss_baseline_kib": baseline,
            "gateway_rss_stalled_kib": resident,
        })
    );
    drop(watch);
    drop(gateway);
    server.abort();
    Ok(())
}

// ---------------------------------------------------------------------------
// TLS and mTLS between the Control Plane, Gateway, and Worker Host

struct Pki {
    directory: PathBuf,
}

struct Leaf {
    cert: PathBuf,
    key: PathBuf,
}

impl Pki {
    async fn openssl(&self, args: &[&str]) -> Result<()> {
        let output = tokio::process::Command::new("openssl")
            .args(args)
            .current_dir(&self.directory)
            .stdin(Stdio::null())
            .output()
            .await
            .context("openssl is required for TLS process tests")?;
        ensure!(
            output.status.success(),
            "openssl {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(())
    }

    async fn authority(directory: &Path, name: &str) -> Result<Self> {
        let directory = directory.join(name);
        std::fs::create_dir_all(&directory)?;
        let pki = Self { directory };
        pki.openssl(&[
            "req",
            "-x509",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:prime256v1",
            "-nodes",
            "-days",
            "1",
            "-subj",
            &format!("/CN={name}"),
            "-addext",
            "basicConstraints=critical,CA:TRUE",
            "-addext",
            "keyUsage=critical,keyCertSign,cRLSign",
            "-keyout",
            "ca.key",
            "-out",
            "ca.pem",
        ])
        .await?;
        Ok(pki)
    }

    fn ca(&self) -> PathBuf {
        self.directory.join("ca.pem")
    }

    async fn leaf(&self, name: &str) -> Result<Leaf> {
        let extensions = format!("{name}.ext");
        std::fs::write(
            self.directory.join(&extensions),
            "subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth,clientAuth\n",
        )?;
        let (key, request, cert) = (
            format!("{name}.key"),
            format!("{name}.csr"),
            format!("{name}.pem"),
        );
        self.openssl(&[
            "req",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:prime256v1",
            "-nodes",
            "-subj",
            &format!("/CN={name}"),
            "-keyout",
            &key,
            "-out",
            &request,
        ])
        .await?;
        self.openssl(&[
            "x509",
            "-req",
            "-in",
            &request,
            "-CA",
            "ca.pem",
            "-CAkey",
            "ca.key",
            "-CAcreateserial",
            "-days",
            "1",
            "-extfile",
            &extensions,
            "-out",
            &cert,
        ])
        .await?;
        Ok(Leaf {
            cert: self.directory.join(cert),
            key: self.directory.join(key),
        })
    }
}

fn server_tls(command: &mut Command, leaf: &Leaf, client_ca: &Path) {
    command
        .env("SUPERTAG_TLS_CERT_FILE", &leaf.cert)
        .env("SUPERTAG_TLS_KEY_FILE", &leaf.key)
        .env("SUPERTAG_TLS_CLIENT_CA_FILE", client_ca);
}

fn client_tls(command: &mut Command, server_ca: &Path, leaf: Option<&Leaf>) {
    command.env("SUPERTAG_SERVER_CA_FILE", server_ca);
    if let Some(leaf) = leaf {
        command
            .env("SUPERTAG_CLIENT_CERT_FILE", &leaf.cert)
            .env("SUPERTAG_CLIENT_KEY_FILE", &leaf.key);
    }
}

async fn exercise_mutual_tls(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let tokens = Tokens::new();
    let pki = Pki::authority(root, "supertag-test-ca").await?;
    let rogue = Pki::authority(root, "rogue-ca").await?;
    let control_leaf = pki.leaf("control-plane").await?;
    let gateway_leaf = pki.leaf("gateway").await?;
    let host_leaf = pki.leaf("worker-host").await?;
    let operator_leaf = pki.leaf("operator").await?;
    let rogue_gateway = rogue.leaf("gateway").await?;
    let rogue_host = rogue.leaf("worker-host").await?;

    // Control Plane: TLS with required client certificates.
    let mut command = binary(&["control-plane"]);
    command
        .env("SUPERTAG_GATEWAY_TOKEN", &tokens.gateway)
        .env("SUPERTAG_DATABASE_URL", &database);
    server_tls(&mut command, &control_leaf, &pki.ca());
    let mut control_plane = Service::spawn(command, root, "tls-control-plane")?;
    let private = format!("https://{}", control_plane.address().await?);

    let gateway = |leaf: &Leaf, client: Option<&Leaf>, upstream: &str| {
        let mut command = binary(&["gateway", "--control-plane", upstream]);
        command
            .env("SUPERTAG_GATEWAY_TOKEN", &tokens.gateway)
            .env("SUPERTAG_OPERATOR_TOKEN", &tokens.operator);
        server_tls(&mut command, leaf, &pki.ca());
        client_tls(&mut command, &pki.ca(), client);
        command
    };
    // A Gateway whose client certificate another authority issued cannot join.
    let refused = Service::spawn(
        gateway(&gateway_leaf, Some(&rogue_gateway), &private),
        root,
        "rogue-gateway",
    )?
    .failure()
    .await?;
    ensure!(
        refused.contains("SuperTag protocol negotiation"),
        "rogue Gateway failed for an unexpected reason: {refused}"
    );
    // Cleartext to the private TLS listener is refused as well.
    let cleartext = private.replacen("https://", "http://", 1);
    let refused = Service::spawn(
        gateway(&gateway_leaf, Some(&gateway_leaf), &cleartext),
        root,
        "cleartext-gateway",
    )?
    .failure()
    .await?;
    ensure!(
        refused.contains("SuperTag protocol negotiation with the Control Plane failed")
            || refused.contains("SuperTag protocol negotiation could not reach its peer"),
        "cleartext Gateway failed for an unexpected reason: {refused}"
    );

    // Gateway: mTLS client of the Control Plane, mTLS server for hosts and operators.
    let mut gateway = Service::spawn(
        gateway(&gateway_leaf, Some(&gateway_leaf), &private),
        root,
        "tls-gateway",
    )?;
    let public = format!("https://{}", gateway.address().await?);

    let operator = |args: &[&str], leaf: Option<&Leaf>| {
        let mut command = binary(args);
        command
            .args(["--gateway", &public])
            .env("SUPERTAG_OPERATOR_TOKEN", &tokens.operator);
        client_tls(&mut command, &pki.ca(), leaf);
        command
    };
    let unauthenticated = run(operator(&["get", "tags"], None)).await?;
    ensure!(
        !unauthenticated.status.success(),
        "an operator without a client certificate reached the Gateway"
    );
    run_json(operator(
        &["tag", "put", "secure", "--instructions", "Answer over TLS"],
        Some(&operator_leaf),
    ))
    .await?;
    let issued = run_json(operator(
        &[
            "auth-key", "create", "tls", "--host", "tls-host", "--tag", "secure",
        ],
        Some(&operator_leaf),
    ))
    .await?;
    let key = root.join("tls-host.key");
    std::fs::write(&key, issued["auth_key"].as_str().context("Auth Key")?)?;
    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600))?;
    let state = root.join("tls-host");
    let enroll = |leaf: &Leaf, server_ca: &Path| {
        let mut command = binary(&["host", "enroll", "tls-host", "--gateway", &public]);
        command
            .arg("--state-directory")
            .arg(&state)
            .arg("--auth-key")
            .arg(format!("file:{}", key.display()));
        client_tls(&mut command, server_ca, Some(leaf));
        command
    };
    // Both failures happen during the TLS handshake, before the Auth Key is used.
    for (leaf, server_ca, case) in [
        (&rogue_host, pki.ca(), "untrusted client certificate"),
        (&host_leaf, rogue.ca(), "untrusted Gateway certificate"),
    ] {
        let output = run(enroll(leaf, &server_ca)).await?;
        let stderr = String::from_utf8_lossy(&output.stderr);
        ensure!(
            !output.status.success() && stderr.contains("SuperTag protocol negotiation"),
            "{case}: enrollment was not refused at the handshake: {stderr}"
        );
        let _ = std::fs::remove_dir_all(&state);
    }
    let enrolled = run_json(enroll(&host_leaf, &pki.ca())).await?;
    assert_eq!(enrolled["host_id"], "tls-host");

    let submitted = run_json(operator(
        &[
            "task",
            "submit",
            "--tag",
            "secure",
            "--session",
            "tls",
            "Check the chain",
        ],
        Some(&operator_leaf),
    ))
    .await?;
    let task_id = submitted["task_id"].as_str().context("task_id")?.to_owned();
    let mut host = binary(&[
        "worker-host",
        "--gateway",
        &public,
        "--adapter",
        ADAPTER,
        "--once",
    ]);
    host.arg("--state-directory").arg(&state);
    client_tls(&mut host, &pki.ca(), Some(&host_leaf));
    let output = run(host).await?;
    ensure!(
        output.status.success(),
        "TLS Worker Host failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let task = run_json(operator(&["get", "task", &task_id], Some(&operator_leaf))).await?;
    assert_eq!(task["state"], "TASK_STATE_SUCCEEDED");
    assert_eq!(task["result"], "Answer over TLS: Check the chain []");

    // A test client with only the CA cannot reach either private or public services.
    let anonymous = Endpoint::from_shared(private.clone())?
        .tls_config(
            ClientTlsConfig::new().ca_certificate(Certificate::from_pem(std::fs::read(pki.ca())?)),
        )?
        .connect_timeout(Duration::from_secs(3));
    let refused = match anonymous.connect().await {
        Err(_) => true,
        Ok(channel) => matches!(
            negotiate(channel, ServiceRole::Gateway, ServiceRole::ControlPlane).await,
            Err(NegotiationError::Unavailable(_))
        ),
    };
    ensure!(
        refused,
        "the Control Plane accepted a client without a certificate"
    );
    let identified = Endpoint::from_shared(private)?
        .tls_config(
            ClientTlsConfig::new()
                .ca_certificate(Certificate::from_pem(std::fs::read(pki.ca())?))
                .identity(Identity::from_pem(
                    std::fs::read(&gateway_leaf.cert)?,
                    std::fs::read(&gateway_leaf.key)?,
                )),
        )?
        .connect()
        .await?;
    assert_eq!(
        negotiate(identified, ServiceRole::Gateway, ServiceRole::ControlPlane)
            .await
            .map_err(|error| anyhow!("{error}"))?,
        2
    );
    ensure!(gateway.running()? && control_plane.running()?);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_mutual_tls_connects_all_three_service_roles() -> Result<()> {
    let directory = tempfile::tempdir()?;
    exercise_mutual_tls(sqlite(directory.path())).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_mutual_tls_connects_all_three_service_roles() -> Result<()> {
    with_postgres("transport_tls", exercise_mutual_tls).await
}

// ---------------------------------------------------------------------------
// Protocol version negotiation

const OLD_EPOCH: &[u32] = &[1];

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn services_refuse_incompatible_protocol_peers_with_a_clear_error() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let tokens = Tokens::new();

    // A Gateway refuses to start against a Control Plane from another protocol epoch.
    let (old_control_plane, old_server) = serve_fake(
        Server::builder().add_service(
            Negotiator::new(ServiceRole::ControlPlane, &[ServiceRole::Gateway])
                .with_versions(OLD_EPOCH)
                .service(),
        ),
    )
    .await?;
    let mut command = binary(&[
        "gateway",
        "--control-plane",
        &format!("http://{old_control_plane}"),
    ]);
    command
        .env("SUPERTAG_GATEWAY_TOKEN", &tokens.gateway)
        .env("SUPERTAG_OPERATOR_TOKEN", &tokens.operator);
    let mut refused = Service::spawn(command, root, "gateway-old-control-plane")?;
    let failure = refused.failure().await?;
    ensure!(
        failure.contains("Error: the SuperTag Control Plane refused this Gateway: incompatible SuperTag protocol: this Control Plane (SuperTag 0.1.0) speaks protocol versions [1], but the connecting Gateway (SuperTag 0.1.0) offered [2]; run the same SuperTag release on both services"),
        "unclear Gateway failure: {failure}"
    );
    old_server.abort();

    // A Worker Host refuses an old Gateway, and a peer that cannot negotiate at all.
    let (old_gateway, old_gateway_server) = serve_fake(
        Server::builder().add_service(
            Negotiator::new(ServiceRole::Gateway, &[ServiceRole::WorkerHost])
                .with_versions(OLD_EPOCH)
                .service(),
        ),
    )
    .await?;
    let (_health, health_service) = tonic_health::server::health_reporter();
    let (foreign, foreign_server) =
        serve_fake(Server::builder().add_service(health_service)).await?;
    for (target, expected) in [
        (
            old_gateway,
            "the SuperTag Gateway refused this Worker Host: incompatible SuperTag protocol: this Gateway (SuperTag 0.1.0) speaks protocol versions [1], but the connecting Worker Host (SuperTag 0.1.0) offered [2]",
        ),
        (
            foreign,
            "incompatible SuperTag protocol: the peer does not offer SuperTag protocol negotiation, so it is not a SuperTag Gateway this Worker Host can use",
        ),
    ] {
        let mut host = binary(&[
            "worker-host",
            "--gateway",
            &format!("http://{target}"),
            "--adapter",
            ADAPTER,
            "--once",
        ]);
        host.arg("--state-directory")
            .arg(root.join(format!("host-{}", target.port())))
            .env("SUPERTAG_HOST_TOKEN", Uuid::new_v4().to_string());
        let output = run(host).await?;
        let stderr = String::from_utf8_lossy(&output.stderr);
        ensure!(
            !output.status.success() && stderr.contains(expected),
            "unclear Worker Host failure: {stderr}"
        );
        let mut enroll = binary(&[
            "host",
            "enroll",
            "old-host",
            "--gateway",
            &format!("http://{target}"),
            "--auth-key",
            "unused-auth-key",
        ]);
        enroll
            .arg("--state-directory")
            .arg(root.join(format!("enroll-{}", target.port())));
        let output = run(enroll).await?;
        let stderr = String::from_utf8_lossy(&output.stderr);
        ensure!(
            !output.status.success() && stderr.contains(expected),
            "unclear enrollment failure: {stderr}"
        );
    }
    old_gateway_server.abort();
    foreign_server.abort();

    // The real services refuse old peers and peers in the wrong role.
    let services = Services::start(&sqlite(root), root, &tokens).await?;
    let gateway = services.raw_channel().await?;
    assert_eq!(
        negotiate(
            gateway.clone(),
            ServiceRole::WorkerHost,
            ServiceRole::Gateway
        )
        .await
        .map_err(|error| anyhow!("{error}"))?,
        2
    );
    let old_host = negotiate_versions(
        gateway.clone(),
        ServiceRole::WorkerHost,
        ServiceRole::Gateway,
        OLD_EPOCH,
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(
        old_host.starts_with(
            "the SuperTag Gateway refused this Worker Host: incompatible SuperTag protocol: this Gateway (SuperTag 0.1.0) speaks protocol versions [2], but the connecting Worker Host (SuperTag 0.1.0) offered [1]"
        ),
        "{old_host}"
    );
    let wrong_role = negotiate(gateway, ServiceRole::Gateway, ServiceRole::Gateway)
        .await
        .unwrap_err()
        .to_string();
    assert_eq!(
        wrong_role,
        "the SuperTag Gateway refused this Gateway: a Gateway cannot connect directly to the SuperTag Gateway"
    );
    let private = services.raw_control_plane_channel().await?;
    let old_gateway = negotiate_versions(
        private.clone(),
        ServiceRole::Gateway,
        ServiceRole::ControlPlane,
        OLD_EPOCH,
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(
        old_gateway.contains("this Control Plane (SuperTag 0.1.0) speaks protocol versions [2], but the connecting Gateway (SuperTag 0.1.0) offered [1]"),
        "{old_gateway}"
    );
    let direct_host = negotiate(private, ServiceRole::WorkerHost, ServiceRole::ControlPlane)
        .await
        .unwrap_err()
        .to_string();
    assert_eq!(
        direct_host,
        "the SuperTag Control Plane refused this Worker Host: a Worker Host cannot connect directly to the SuperTag Control Plane"
    );
    let mut services = services;
    ensure!(
        services.gateway.running()?,
        "Gateway stopped after refusing peers"
    );
    Ok(())
}

/// The Gateway and Control Plane refuse every call that does not name a
/// negotiated protocol version, so a peer that skipped `Negotiate` reaches only
/// negotiation and health. Operator clients negotiate: the CLI works against
/// the real Gateway and refuses one from another protocol epoch.
async fn exercise_protocol_fence(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let tokens = Tokens::new();
    let services = Services::start(&database, root, &tokens).await?;
    let skipped = |status: Status, service: &str| {
        status.code() == tonic::Code::FailedPrecondition
            && status.message().starts_with(&format!(
                "this SuperTag {service} refuses a call that did not negotiate a protocol version"
            ))
    };

    // A Gateway caller that skipped negotiation is refused before any handler runs.
    let raw = services.raw_channel().await?;
    let refused = OperatorClient::new(raw.clone())
        .get_task(tokens.request(GetTaskRequest {
            task_id: "absent".into(),
        })?)
        .await
        .unwrap_err();
    ensure!(skipped(refused.clone(), "Gateway"), "{refused:?}");
    let refused = supertag_protocol::v2::worker_host_client::WorkerHostClient::new(raw.clone())
        .register_host(authenticated_request(
            supertag_protocol::v2::RegisterHostRequest {
                incarnation_id: Uuid::new_v4().to_string(),
            },
            "unenrolled-host-token",
            None,
        )?)
        .await
        .unwrap_err();
    ensure!(skipped(refused.clone(), "Gateway"), "{refused:?}");
    // A version from another epoch is refused as incompatible.
    let refused = OperatorClient::new(supertag_protocol::negotiation::bind(raw.clone(), 1))
        .get_task(tokens.request(GetTaskRequest {
            task_id: "absent".into(),
        })?)
        .await
        .unwrap_err();
    ensure!(
        refused.code() == tonic::Code::FailedPrecondition
            && refused.message().starts_with(
                "incompatible SuperTag protocol: this Gateway (SuperTag 0.1.0) speaks protocol versions [2], but the call names protocol 1"
            ),
        "{refused:?}"
    );
    // Health stays open to probes that cannot negotiate.
    let health = tonic_health::pb::health_client::HealthClient::new(raw)
        .check(tonic_health::pb::HealthCheckRequest {
            service: String::new(),
        })
        .await?
        .into_inner();
    ensure!(
        health.status == tonic_health::pb::health_check_response::ServingStatus::Serving as i32
    );
    // A negotiated caller reaches the handler.
    let missing = OperatorClient::new(services.channel().await?)
        .get_task(tokens.request(GetTaskRequest {
            task_id: "absent".into(),
        })?)
        .await
        .unwrap_err();
    ensure!(missing.code() == tonic::Code::NotFound, "{missing:?}");

    // The Control Plane fences its private callers the same way.
    let refused = OperatorClient::new(services.raw_control_plane_channel().await?)
        .get_task(authenticated_request(
            GetTaskRequest {
                task_id: "absent".into(),
            },
            &tokens.gateway,
            Some("operator:local"),
        )?)
        .await
        .unwrap_err();
    ensure!(skipped(refused.clone(), "Control Plane"), "{refused:?}");

    // The CLI negotiates as an operator client.
    let gateway = format!("http://{}", services.gateway_address);
    let mut list = binary(&["get", "tags", "--gateway", &gateway]);
    list.env("SUPERTAG_OPERATOR_TOKEN", &tokens.operator);
    let listed = run(list).await?;
    ensure!(
        listed.status.success(),
        "{}",
        String::from_utf8_lossy(&listed.stderr)
    );
    // ...and refuses a Gateway from another protocol epoch before any call.
    let (old_gateway, old_server) = serve_fake(
        Server::builder().add_service(
            Negotiator::new(ServiceRole::Gateway, &[ServiceRole::Operator])
                .with_versions(OLD_EPOCH)
                .service(),
        ),
    )
    .await?;
    let mut list = binary(&["get", "tags", "--gateway", &format!("http://{old_gateway}")]);
    list.env("SUPERTAG_OPERATOR_TOKEN", &tokens.operator);
    let refused = run(list).await?;
    let stderr = String::from_utf8_lossy(&refused.stderr);
    ensure!(
        !refused.status.success()
            && stderr.contains("the SuperTag Gateway refused this operator client: incompatible SuperTag protocol: this Gateway (SuperTag 0.1.0) speaks protocol versions [1], but the connecting operator client (SuperTag 0.1.0) offered [2]"),
        "unclear operator failure: {stderr}"
    );
    old_server.abort();
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_services_refuse_calls_that_skipped_negotiation() -> Result<()> {
    let directory = tempfile::tempdir()?;
    exercise_protocol_fence(sqlite(directory.path())).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_services_refuse_calls_that_skipped_negotiation() -> Result<()> {
    with_postgres("protocol_fence", exercise_protocol_fence).await
}

// ---------------------------------------------------------------------------
// TLS through an idle-closing TCP proxy

/// A TCP relay like an operator's proxy: it closes a link that carried no bytes
/// in either direction for `idle`, and a partition severs every link and
/// refuses new ones until restored.
struct IdleProxy {
    address: SocketAddr,
    partitioned: Arc<AtomicBool>,
    refused: Arc<AtomicU64>,
    links: Arc<Mutex<Vec<AbortHandle>>>,
    task: JoinHandle<()>,
}

impl IdleProxy {
    async fn start(target: SocketAddr, idle: Duration) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let partitioned = Arc::new(AtomicBool::new(false));
        let refused = Arc::new(AtomicU64::new(0));
        let links: Arc<Mutex<Vec<AbortHandle>>> = Arc::default();
        let (state, refusals, open) = (partitioned.clone(), refused.clone(), links.clone());
        let task = tokio::spawn(async move {
            while let Ok((downstream, _)) = listener.accept().await {
                let mut open = open.lock().unwrap();
                if state.load(Ordering::SeqCst) {
                    refusals.fetch_add(1, Ordering::SeqCst);
                    continue;
                }
                let link = tokio::spawn(async move {
                    if let Ok(upstream) = TcpStream::connect(target).await {
                        relay_until_idle(downstream, upstream, idle).await;
                    }
                });
                open.retain(|link| !link.is_finished());
                open.push(link.abort_handle());
            }
        });
        Ok(Self {
            address,
            partitioned,
            refused,
            links,
            task,
        })
    }

    fn partition(&self) {
        let mut links = self.links.lock().unwrap();
        self.partitioned.store(true, Ordering::SeqCst);
        for link in links.drain(..) {
            link.abort();
        }
    }

    fn restore(&self) {
        let _links = self.links.lock().unwrap();
        self.partitioned.store(false, Ordering::SeqCst);
    }
}

impl Drop for IdleProxy {
    fn drop(&mut self) {
        self.partition();
        self.task.abort();
    }
}

/// Copies bytes both ways until either side closes or the link is idle.
async fn relay_until_idle(downstream: TcpStream, upstream: TcpStream, idle: Duration) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (mut down_read, mut down_write) = downstream.into_split();
    let (mut up_read, mut up_write) = upstream.into_split();
    let (mut from_client, mut from_server) = (vec![0; 16 * 1024], vec![0; 16 * 1024]);
    loop {
        tokio::select! {
            read = down_read.read(&mut from_client) => match read {
                Ok(0) | Err(_) => return,
                Ok(count) => if up_write.write_all(&from_client[..count]).await.is_err() {
                    return;
                },
            },
            read = up_read.read(&mut from_server) => match read {
                Ok(0) | Err(_) => return,
                Ok(count) => if down_write.write_all(&from_server[..count]).await.is_err() {
                    return;
                },
            },
            () = sleep(idle) => return,
        }
    }
}

/// Ports `tests/worklet-grpc-proxy-operational.test.ts`: a Worker Host reaches a
/// TLS Gateway through a TCP proxy that closes links idle for 400 ms. The host
/// stays ready through idle time, reconnects after a partition severs every
/// link, and then runs a Task exactly once.
async fn exercise_tls_proxy_traversal(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let tokens = Tokens::new();
    let pki = Pki::authority(root, "supertag-proxy-ca").await?;
    let gateway_leaf = pki.leaf("gateway").await?;
    let host_leaf = pki.leaf("worker-host").await?;
    let operator_leaf = pki.leaf("operator").await?;

    let mut command = binary(&["control-plane"]);
    command
        .env("SUPERTAG_GATEWAY_TOKEN", &tokens.gateway)
        .env("SUPERTAG_DATABASE_URL", &database);
    let mut control_plane = Service::spawn(command, root, "proxy-control-plane")?;
    let private = format!("http://{}", control_plane.address().await?);
    let mut command = binary(&["gateway", "--control-plane", &private]);
    command
        .env("SUPERTAG_GATEWAY_TOKEN", &tokens.gateway)
        .env("SUPERTAG_OPERATOR_TOKEN", &tokens.operator);
    server_tls(&mut command, &gateway_leaf, &pki.ca());
    let mut gateway = Service::spawn(command, root, "proxy-gateway")?;
    let gateway_address = gateway.address().await?;
    let public = format!("https://{gateway_address}");
    let proxy = IdleProxy::start(gateway_address, Duration::from_millis(400)).await?;
    let proxied = format!("https://{}", proxy.address);

    let operator = |args: &[&str]| {
        let mut command = binary(args);
        command
            .args(["--gateway", &public])
            .env("SUPERTAG_OPERATOR_TOKEN", &tokens.operator);
        client_tls(&mut command, &pki.ca(), Some(&operator_leaf));
        command
    };
    run_json(operator(&[
        "tag",
        "put",
        "proxied",
        "--instructions",
        "Answer through the proxy",
    ]))
    .await?;
    let issued = run_json(operator(&[
        "auth-key",
        "create",
        "proxy-host",
        "--host",
        "proxy-host",
        "--tag",
        "proxied",
    ]))
    .await?;
    let key = root.join("proxy-host.key");
    std::fs::write(&key, issued["auth_key"].as_str().context("Auth Key")?)?;
    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600))?;
    let state = root.join("proxy-host");
    let mut enroll = binary(&["host", "enroll", "proxy-host", "--gateway", &proxied]);
    enroll
        .arg("--state-directory")
        .arg(&state)
        .arg("--auth-key")
        .arg(format!("file:{}", key.display()));
    client_tls(&mut enroll, &pki.ca(), Some(&host_leaf));
    assert_eq!(run_json(enroll).await?["host_id"], "proxy-host");

    let (adapter, launches) = recording_adapter(root, "proxy-host")?;
    let mut command = binary(&["worker-host", "--gateway", &proxied]);
    command
        .arg("--state-directory")
        .arg(&state)
        .arg("--adapter")
        .arg(&adapter);
    client_tls(&mut command, &pki.ca(), Some(&host_leaf));
    let mut host = Service::spawn(command, root, "proxy-worker-host")?;

    // Idle time. The host's claim connection carries traffic often enough to stay
    // open; its other Gateway channels sit idle, and when the proxy closes them
    // they reconnect on their next call. Neither stops the host.
    let host_ready = || {
        let mut command = binary(&["get", "--gateway", &public, "host", "proxy-host"]);
        command.env("SUPERTAG_OPERATOR_TOKEN", &tokens.operator);
        client_tls(&mut command, &pki.ca(), Some(&operator_leaf));
        run_json(command)
    };
    let deadline = Instant::now() + STARTUP;
    while !host_ready()
        .await
        .is_ok_and(|host| host["phase"] == "ready")
    {
        ensure!(
            Instant::now() < deadline,
            "Worker Host never connected through the proxy: {}",
            host.logs()
        );
        sleep(Duration::from_millis(100)).await;
    }
    sleep(Duration::from_millis(1500)).await;
    ensure!(
        host.running()?,
        "Worker Host stopped while idle: {}",
        host.logs()
    );
    ensure!(
        host_ready().await?["phase"] == "ready",
        "Worker Host lost readiness while idle behind the proxy"
    );

    // A partition severs the link; the host reconnects once it heals.
    proxy.partition();
    let deadline = Instant::now() + Duration::from_secs(10);
    while proxy.refused.load(Ordering::SeqCst) == 0 {
        ensure!(
            Instant::now() < deadline,
            "Worker Host never tried to reconnect"
        );
        sleep(Duration::from_millis(20)).await;
    }
    proxy.restore();

    let submitted = run_json(operator(&[
        "task",
        "submit",
        "--tag",
        "proxied",
        "--session",
        "proxy",
        "Verify proxy recovery",
    ]))
    .await?;
    let task_id = submitted["task_id"].as_str().context("task_id")?.to_owned();
    let deadline = Instant::now() + Duration::from_secs(30);
    let task = loop {
        let task = run_json(operator(&["get", "task", &task_id])).await?;
        if matches!(
            task["state"].as_str(),
            Some("TASK_STATE_SUCCEEDED" | "TASK_STATE_FAILED" | "TASK_STATE_CANCELLED")
        ) {
            break task;
        }
        ensure!(
            Instant::now() < deadline,
            "Task never finished: {task}\n{}",
            host.logs()
        );
        sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
    assert_eq!(
        task["result"],
        "Answer through the proxy: Verify proxy recovery []"
    );
    let launched = std::fs::read_to_string(&launches)?.lines().count();
    assert_eq!(launched, 1, "the adapter ran {launched} times");
    ensure!(host.running()? && gateway.running()? && control_plane.running()?);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_tls_worker_host_traverses_an_idle_closing_proxy() -> Result<()> {
    let directory = tempfile::tempdir()?;
    exercise_tls_proxy_traversal(sqlite(directory.path())).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_tls_worker_host_traverses_an_idle_closing_proxy() -> Result<()> {
    with_postgres("proxy_traversal", exercise_tls_proxy_traversal).await
}
