//! Hard-crash durability matrix (capability ledger gap G2).
//!
//! Every case runs the shipped `supertag` Control Plane, Gateway (with a Slack
//! connector against a mock Slack API), and Worker Host as independent OS processes,
//! plus the fixture adapter beneath the host's guardian. A test-only crash point
//! (`supertag-protocol/crash-points`, enabled by `test-fixtures`) makes exactly one
//! process `SIGKILL` itself immediately before or after one persisted transition:
//! admission, assignment/claim, start receipt, event append, terminal outcome, or
//! outbound delivery. The test restarts only that process, lets the system recover,
//! and asserts the crash invariants:
//!
//! - exactly one Task exists for the accepted request, and a redelivered request
//!   resolves to that Task;
//! - the adapter is launched at most once (no duplicate execution), except that a Task whose
//!   Attempt was lost with its Worker, and did nothing that cannot be repeated, is redelivered
//!   and runs once more on a new Attempt;
//! - a terminal outcome produced by the adapter is never lost;
//! - the provider receives the reply at most once, and the reply is either
//!   delivered with its receipt or visibly uncertain (never silently resent or
//!   dropped).
//!
//! The SQLite cases run by default. The PostgreSQL cases are ignored unless
//! `SUPERTAG_RUST_TEST_POSTGRES_URL_FILE` names an isolated server. The durable
//! lane (`scripts/durable-postgres-crash-lane.sh`, and the `crash-durability`
//! job in `.github/workflows/core.yml`) runs the PostgreSQL cases against a
//! server with `fsync`, `synchronous_commit`, and `full_page_writes` on, and sets
//! `SUPERTAG_RUST_TEST_REQUIRE_DURABLE_POSTGRES=1` so each case refuses a server
//! with test durability settings.
#[path = "support/children.rs"]
mod children;
#[path = "../../../test-support/executables.rs"]
mod executables;
use children::reaped;
#[path = "support/protocol.rs"]
mod protocol;
#[path = "support/provider_delivery_crash.rs"]
mod provider_delivery_crash;
use std::{
    fs::File,
    io::{BufRead, BufReader},
    net::SocketAddr,
    os::unix::process::ExitStatusExt,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    str::FromStr,
    sync::{Arc, mpsc},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use supertag_protocol::negotiation::ProtocolChannel;

use anyhow::{Context, Result, anyhow, bail, ensure};
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;
use sqlx::{
    AnyConnection, ConnectOptions, Connection, Executor, PgConnection, Row,
    postgres::PgConnectOptions,
};
use supertag_protocol::{
    CRASH_MARKER_ENV, CRASH_POINT_ENV, authenticated_request,
    v2::{
        GetTaskRequest, InboxItem, InboxItemKind, ListEventsRequest, ListInboxItemsRequest,
        ListReplyDeliveriesRequest, PutSurfaceAccountRequest, PutSurfaceLocationRequest,
        PutTagRequest, Reply, ReplyState, SlackSurfaceChannel, SlackSurfaceIdentity,
        SubmitTaskRequest, SurfaceAccount, SurfaceAccountIdentity, SurfaceLocation,
        SurfaceLocationScope, Task, TaskState, inbox_client::InboxClient,
        operator_client::OperatorClient, surface_account_identity, surface_location_scope,
        surface_policy_catalog_client::SurfacePolicyCatalogClient,
    },
};
use tempfile::TempDir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Mutex,
    time::sleep,
};
use tonic::{Request, transport::Channel};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(45);
const POLL: Duration = Duration::from_millis(25);

/// Whether a call failed before the Control Plane decided it: a try that missed its short
/// deadline while the parallel run starved the services, a connection a restart refused or cut
/// off, or a channel that could not connect yet. A status the Control Plane sent is not transient.
fn transient(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause.downcast_ref::<tonic::transport::Error>().is_some()
            || cause.downcast_ref::<tonic::Status>().is_some_and(|status| {
                matches!(
                    status.code(),
                    tonic::Code::Unavailable
                        | tonic::Code::DeadlineExceeded
                        | tonic::Code::Cancelled
                ) || supertag_protocol::local_transport_failure(status)
            })
    })
}

/// Repeat an idempotent call until it succeeds, it fails for good, or `WAIT` passes. Each try
/// keeps its own short deadline, so a try against a dead service ends quickly and a later one
/// reaches its replacement; only the whole wait bounds a slow but live service.
async fn retry<T, F, Fut>(what: &str, mut call: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let deadline = Instant::now() + WAIT;
    loop {
        match call().await {
            Ok(value) => return Ok(value),
            Err(error) if transient(&error) && Instant::now() < deadline => sleep(POLL).await,
            Err(error) => return Err(error.context(format!("{what} did not succeed"))),
        }
    }
}

const TAG: &str = "crash-engineer";
const INSTRUCTIONS: &str = "Respond carefully";
const PROMPT: &str = "inspect the crash fixture";
const RESULT: &str = "Respond carefully: inspect the crash fixture [files:read]";
const SLACK_ACCOUNT: &str = "slack-crash-test";
const SLACK_TEAM: &str = "TCRASH1";
const SLACK_CHANNEL: &str = "CCRASH1";
const SLACK_USER: &str = "UCRASH1";
const SLACK_EVENT: &str = "EvCRASH1";
const SLACK_MESSAGE: &str = "1794470000.123456";
const SLACK_THREAD: &str = "1794469999.012345";
const SLACK_RECEIPT: &str = "1794470001.222222";
const SLACK_BOT_TOKEN: &str = "xoxb-synthetic-crash-test";
const SLACK_SIGNING_SECRET: &str = "synthetic-crash-test-signing-secret";
const OPERATION: &str = "crash-submit";

/// The process that kills itself at the selected boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Target {
    ControlPlane,
    Gateway,
    /// The Worker Host's Worklet: its Workers die with it.
    WorkerHost,
    /// The Worker process running the Attempt: its Worklet stays up and recovers it.
    Worker,
    Adapter,
}

/// How the request is admitted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Ingress {
    /// A signed Slack event; the result is delivered back to the Slack thread.
    Slack,
    /// An operator `SubmitTask` with an idempotency key; there is no outbound reply.
    Operator,
}

/// The single acceptable recovered outcome for a case.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Expect {
    /// The Task succeeds and its reply is delivered exactly once with the receipt. A Slack
    /// acknowledgement may precede it, at most once, and the reply then replaces it in place.
    Delivered,
    /// The Task succeeds and has no reply (operator ingress).
    Succeeded,
    /// The Task succeeds and its reply is settled uncertain after this many provider requests
    /// carrying the result, besides at most one acknowledgement.
    ReplyUncertain { provider_requests: usize },
    /// The Task fails with this durable event count. Its only reply is the failure text,
    /// delivered once, besides at most one acknowledgement.
    Failed { events: usize },
    /// The host proves every process it recorded for the interrupted Attempt is gone and
    /// reclaims it, and the lost Attempt did nothing that cannot be repeated: the Control Plane
    /// redelivers the Task, keeping its ID, as one new Attempt that is told the first run was
    /// interrupted, and it succeeds once. The harness launched this many times in all, and the
    /// Task has this many events across both Attempts.
    Redelivered { launches: usize, events: usize },
    /// The host reclaims the interrupted Attempt, which left an effect in doubt: the Task fails
    /// with an unknown outcome, saying why it was not run again, nothing is rerun, the operator
    /// Inbox shows it, and an acknowledgement, if posted, is replaced once by the failure text.
    NotRedelivered { launches: usize, events: usize },
}

#[derive(Clone, Copy, Debug)]
struct Case {
    target: Target,
    point: &'static str,
    ingress: Ingress,
    expect: Expect,
    /// Extra fixture adapter arguments, for every launch.
    adapter_args: &'static [&'static str],
}

const fn case(target: Target, point: &'static str, ingress: Ingress, expect: Expect) -> Case {
    Case {
        target,
        point,
        ingress,
        expect,
        adapter_args: &[],
    }
}

const fn with_adapter(case: Case, adapter_args: &'static [&'static str]) -> Case {
    Case {
        adapter_args,
        ..case
    }
}

struct Credentials {
    gateway: String,
    operator: String,
    host: String,
}

impl Credentials {
    fn new() -> Self {
        Self {
            gateway: supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX),
            operator: Uuid::new_v4().to_string(),
            host: supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX),
        }
    }

    fn command(&self) -> Command {
        let mut command = reaped(Command::new(BINARY));
        // Never inherit an operator's real credentials, TLS settings, or state location.
        command
            .env_clear()
            .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &self.gateway)
            .env("SUPERTAG_GATEWAY_CREDENTIAL", &self.gateway)
            .env("SUPERTAG_OPERATOR_TOKEN", &self.operator)
            .env("SUPERTAG_HOST_TOKEN", &self.host)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &self.host)
            .stdin(Stdio::null());
        command
    }

    fn request<T>(&self, message: T) -> Result<Request<T>> {
        let mut request = authenticated_request(message, &self.operator, None)?;
        request.set_timeout(Duration::from_secs(3));
        Ok(request)
    }
}

/// Owns and reaps each service, including when an assertion or RPC fails.
struct Process {
    child: Child,
    name: String,
    log: PathBuf,
}

impl Process {
    fn spawn(mut command: Command, directory: &Path, name: &str, server: bool) -> Result<Self> {
        let log = directory.join(format!("{name}-{}.log", Uuid::new_v4()));
        command.stderr(File::create(&log)?);
        if server {
            command.stdout(Stdio::piped());
        } else {
            command.stdout(File::create(log.with_extension("stdout"))?);
        }
        Ok(Self {
            child: command.spawn().context("spawn SuperTag process")?,
            name: name.into(),
            log,
        })
    }

    async fn endpoints(&mut self, count: usize) -> Result<Vec<SocketAddr>> {
        let stdout = self.child.stdout.take().context("server stdout missing")?;
        let (send, receive) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut stdout = BufReader::new(stdout);
            let result = (0..count)
                .map(|_| {
                    let mut line = String::new();
                    stdout.read_line(&mut line).map(|_| line)
                })
                .collect::<std::io::Result<Vec<_>>>();
            let _ = send.send(result);
        });
        let deadline = Instant::now() + WAIT;
        loop {
            match receive.try_recv() {
                Ok(lines) => {
                    return lines?
                        .into_iter()
                        .map(|line| {
                            let address: SocketAddr = line
                                .trim()
                                .trim_start_matches("http://")
                                .parse()
                                .with_context(|| {
                                    format!("server did not report an endpoint: {}", self.logs())
                                })?;
                            ensure!(address.ip().is_loopback(), "invalid test endpoint");
                            Ok(address)
                        })
                        .collect();
                }
                Err(mpsc::TryRecvError::Empty) => {}
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err(anyhow!("server output closed: {}", self.logs()));
                }
            }
            if let Some(status) = self.child.try_wait()? {
                return Err(anyhow!("server exited with {status}: {}", self.logs()));
            }
            ensure!(
                Instant::now() < deadline,
                "server startup timed out: {}",
                self.logs()
            );
            sleep(Duration::from_millis(10)).await;
        }
    }

    async fn exited(&mut self) -> Result<ExitStatus> {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(status) = self.child.try_wait()? {
                return Ok(status);
            }
            ensure!(
                Instant::now() < deadline,
                "{} did not exit: {}",
                self.name,
                self.logs()
            );
            sleep(Duration::from_millis(10)).await;
        }
    }

    fn logs(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(Some(_))) {
            return;
        }
        let _ = Command::new("/bin/kill")
            .args(["-TERM", &self.child.id().to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Mock Slack Web API that acknowledges every post with one fixed receipt.
struct MockSlackApi {
    endpoint: String,
    requests: Arc<Mutex<Vec<Value>>>,
    server: tokio::task::JoinHandle<Result<()>>,
}

impl MockSlackApi {
    async fn start() -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = format!("http://{}/chat.postMessage", listener.local_addr()?);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await?;
                let Ok(Ok(body)) =
                    tokio::time::timeout(Duration::from_secs(5), read_body(&mut stream)).await
                else {
                    continue;
                };
                // The request is recorded before the acknowledgement is written, so a
                // Gateway killed after the provider answered is always counted.
                recorded.lock().await.push(body);
                let body =
                    serde_json::json!({"ok": true, "channel": SLACK_CHANNEL, "ts": SLACK_RECEIPT})
                        .to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            }
        });
        Ok(Self {
            endpoint,
            requests,
            server,
        })
    }

    async fn count(&self) -> usize {
        self.requests.lock().await.len()
    }
}

impl Drop for MockSlackApi {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn read_body(stream: &mut TcpStream) -> Result<Value> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    let header_end = loop {
        if let Some(offset) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break offset + 4;
        }
        ensure!(bytes.len() < 16_384, "mock HTTP request headers too large");
        let count = stream.read(&mut buffer).await?;
        ensure!(count != 0, "mock HTTP request ended before its headers");
        bytes.extend_from_slice(&buffer[..count]);
    };
    let headers = std::str::from_utf8(&bytes[..header_end])?;
    let length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())?
        })
        .context("mock JSON request must have Content-Length")?;
    ensure!(length <= 1_048_576, "mock HTTP body too large");
    while bytes.len() < header_end + length {
        let count = stream.read(&mut buffer).await?;
        ensure!(count != 0, "mock HTTP request ended before its body");
        bytes.extend_from_slice(&buffer[..count]);
    }
    Ok(serde_json::from_slice(
        &bytes[header_end..header_end + length],
    )?)
}

/// Sends the one logical Slack mention. `None` means the webhook did not
/// acknowledge (connection lost or unavailable), so Slack would redeliver it.
async fn post_slack_event(http: SocketAddr) -> Result<Option<reqwest::StatusCode>> {
    let body = serde_json::json!({
        "type": "event_callback", "team_id": SLACK_TEAM, "event_id": SLACK_EVENT,
        "event": { "type": "app_mention", "channel": SLACK_CHANNEL, "user": SLACK_USER,
            "text": PROMPT, "ts": SLACK_MESSAGE, "thread_ts": SLACK_THREAD }
    })
    .to_string();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_secs()
        .to_string();
    let mut mac = Hmac::<Sha256>::new_from_slice(SLACK_SIGNING_SECRET.as_bytes())?;
    mac.update(format!("v0:{timestamp}:{body}").as_bytes());
    let signature = format!("v0={:x}", mac.finalize().into_bytes());
    let response = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(8))
        .build()?
        .post(format!("http://{http}/slack/events"))
        .header("content-type", "application/json")
        .header("x-slack-request-timestamp", timestamp)
        .header("x-slack-signature", signature)
        .body(body)
        .send()
        .await;
    Ok(match response {
        Ok(response) if response.status() == reqwest::StatusCode::SERVICE_UNAVAILABLE => None,
        Ok(response) => Some(response.status()),
        Err(_) => None,
    })
}

fn recording_adapter(directory: &Path) -> Result<(PathBuf, PathBuf)> {
    let script = directory.join("recording-adapter");
    let launches = directory.join("adapter-launches");
    let quote = |path: &Path| -> Result<String> {
        Ok(format!(
            "'{}'",
            path.to_str()
                .context("adapter path is not UTF-8")?
                .replace('\'', "'\\''")
        ))
    };
    executables::write_executable(
        &script,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$$\" >> {}\nexec {} \"$@\"\n",
            quote(&launches)?,
            quote(Path::new(ADAPTER))?
        ),
        0o700,
    )?;
    Ok((script, launches))
}

/// The running system for one case. Only the selected target ever receives the
/// crash-point environment, and only for its first incarnation.
struct System<'a> {
    case: Case,
    database: &'a str,
    directory: &'a Path,
    credentials: Credentials,
    mock: MockSlackApi,
    marker: PathBuf,
    adapter: PathBuf,
    launches: PathBuf,
    control_plane: Process,
    gateway: Process,
    host: Option<Process>,
    retired: Vec<Process>,
    private: SocketAddr,
    public: SocketAddr,
    http: SocketAddr,
    /// Keeps the Control Plane's port while it is down after a crash; see [`PortReservation`].
    _private_port: PortReservation,
    crashed: bool,
}

impl<'a> System<'a> {
    async fn start(case: Case, database: &'a str, directory: &'a Path) -> Result<Self> {
        let credentials = Credentials::new();
        let mock = MockSlackApi::start().await?;
        let marker = directory.join("crash-marker");
        let (adapter, launches) = recording_adapter(directory)?;
        let unbound: SocketAddr = "127.0.0.1:0".parse()?;
        let (listen, private_port) = PortReservation::loopback()?;
        let mut control_plane = spawn_control_plane(
            &credentials,
            database,
            directory,
            listen,
            (case.target == Target::ControlPlane).then_some((case.point, marker.as_path())),
        )?;
        let private = control_plane.endpoints(1).await?[0];
        let mut gateway = spawn_gateway(
            &credentials,
            directory,
            &mock,
            (private, unbound, unbound),
            (case.target == Target::Gateway).then_some((case.point, marker.as_path())),
        )?;
        let endpoints = gateway.endpoints(2).await?;
        Ok(Self {
            case,
            database,
            directory,
            credentials,
            mock,
            marker,
            adapter,
            launches,
            control_plane,
            gateway,
            host: None,
            retired: Vec::new(),
            private,
            public: endpoints[0],
            http: endpoints[1],
            _private_port: private_port,
            crashed: false,
        })
    }

    async fn operator(&self) -> Result<OperatorClient<ProtocolChannel>> {
        let channel = protocol::negotiated(
            Channel::from_shared(format!("http://{}", self.private))?
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(3))
                .connect()
                .await?,
        )
        .await?;
        Ok(OperatorClient::new(channel))
    }

    /// Each put sets the same desired state again or repeats its operation ID, so a try whose
    /// answer was lost is safe to repeat.
    async fn configure(&self) -> Result<()> {
        retry("put the Tag", || async {
            self.operator()
                .await?
                .put_tag(self.credentials.request(PutTagRequest {
                    name: None,
                    expected_revision: None,
                    lead: None,
                    max_work_sessions: None,
                    approval_rules: vec![],
                    harness_kind: 0,
                    workspace: None,
                    tag_id: TAG.into(),
                    instructions: INSTRUCTIONS.into(),
                    execution: None,
                    allowed_actions: vec!["files:read".into()],
                    memory: None,
                    start_rate: None,
                    volume: None,
                })?)
                .await?;
            Ok(())
        })
        .await?;
        retry("put the Surface Account and location", || {
            self.put_surface_policy()
        })
        .await
    }

    async fn put_surface_policy(&self) -> Result<()> {
        let mut policy = SurfacePolicyCatalogClient::new(
            protocol::dial(format!("http://{}", self.private)).await?,
        );
        policy
            .put_surface_account(self.credentials.request(PutSurfaceAccountRequest {
                operation_id: "account-fixture".into(),
                account: Some(SurfaceAccount {
                    account_id: "slack-installation".into(),
                    enabled: true,
                    identity: Some(SurfaceAccountIdentity {
                        provider: Some(surface_account_identity::Provider::Slack(
                            SlackSurfaceIdentity {
                                team_id: SLACK_TEAM.into(),
                            },
                        )),
                    }),
                    gateway: "local".into(),
                    ..Default::default()
                }),
                expected_revision: None,
            })?)
            .await?;
        policy
            .put_surface_location(self.credentials.request(PutSurfaceLocationRequest {
                operation_id: "location-fixture".into(),
                location: Some(SurfaceLocation {
                    location_id: "slack-crash".into(),
                    account_id: "slack-installation".into(),
                    connector_account_id: SLACK_ACCOUNT.into(),
                    tag_id: TAG.into(),
                    enabled: true,
                    scope: Some(SurfaceLocationScope {
                        provider: Some(surface_location_scope::Provider::Slack(
                            SlackSurfaceChannel {
                                channel_id: SLACK_CHANNEL.into(),
                            },
                        )),
                    }),
                    ..Default::default()
                }),
                expected_revision: None,
            })?)
            .await?;
        Ok(())
    }

    fn crash_env(&self, target: Target) -> Option<(&'static str, &Path)> {
        (self.case.target == target && !self.crashed)
            .then_some((self.case.point, self.marker.as_path()))
    }

    fn start_host(&mut self) -> Result<()> {
        let mut command = self.credentials.command();
        command
            .args(["worklet", "--control-plane"])
            .arg(format!("http://{}", self.private))
            .args(["--once", "--state-directory"])
            .arg(self.directory.join("host"))
            .arg("--adapter")
            .arg(&self.adapter);
        // A Worker inherits its Worklet's environment, crash point included.
        if let Some((point, marker)) = self
            .crash_env(Target::WorkerHost)
            .or_else(|| self.crash_env(Target::Worker))
        {
            command
                .env(CRASH_POINT_ENV, point)
                .env(CRASH_MARKER_ENV, marker);
        }
        for arg in self.case.adapter_args {
            command.arg(format!("--adapter-arg={arg}"));
        }
        if self.case.target == Target::Adapter {
            let boundary = self
                .case
                .point
                .strip_prefix("adapter.")
                .context("adapter crash point must be adapter.<boundary>")?;
            command
                .arg(format!("--adapter-arg=--crash-at={boundary}"))
                .arg(format!(
                    "--adapter-arg=--crash-marker={}",
                    self.marker.display()
                ));
        }
        let host = Process::spawn(command, self.directory, "worklet", false)?;
        if let Some(previous) = self.host.replace(host) {
            self.retired.push(previous);
        }
        Ok(())
    }

    /// Detect the selected crash once. The killed process must have died from
    /// `SIGKILL` after recording the exact boundary; only it is restarted.
    async fn recover(&mut self) -> Result<()> {
        if self.crashed || !self.marker.exists() {
            return Ok(());
        }
        let recorded = std::fs::read_to_string(&self.marker)?;
        ensure!(
            recorded == self.case.point,
            "crash marker {recorded} differs from {}",
            self.case.point
        );
        self.crashed = true;
        match self.case.target {
            Target::ControlPlane => {
                let status = self.control_plane.exited().await?;
                ensure!(
                    status.signal() == Some(libc::SIGKILL),
                    "Control Plane exited with {status} instead of SIGKILL"
                );
                let mut restarted = spawn_control_plane(
                    &self.credentials,
                    self.database,
                    self.directory,
                    self.private,
                    None,
                )?;
                ensure!(restarted.endpoints(1).await?[0] == self.private);
                self.retired
                    .push(std::mem::replace(&mut self.control_plane, restarted));
            }
            Target::Gateway => {
                let status = self.gateway.exited().await?;
                ensure!(
                    status.signal() == Some(libc::SIGKILL),
                    "Gateway exited with {status} instead of SIGKILL"
                );
                // Only this test reaches the Gateway's listeners, so the restarted Gateway takes
                // new ports rather than racing other processes for the ones the killed one held.
                let unbound: SocketAddr = "127.0.0.1:0".parse()?;
                let mut restarted = spawn_gateway(
                    &self.credentials,
                    self.directory,
                    &self.mock,
                    (self.private, unbound, unbound),
                    None,
                )?;
                let endpoints = restarted.endpoints(2).await?;
                (self.public, self.http) = (endpoints[0], endpoints[1]);
                self.retired
                    .push(std::mem::replace(&mut self.gateway, restarted));
            }
            Target::WorkerHost => {
                let host = self.host.as_mut().context("crashed host was not running")?;
                let status = host.exited().await?;
                ensure!(
                    status.signal() == Some(libc::SIGKILL),
                    "Worker Host exited with {status} instead of SIGKILL"
                );
                self.start_host()?;
            }
            // The guardian observes the adapter's death, and the Worklet its Worker's; the host
            // owns recovery.
            Target::Adapter | Target::Worker => {}
        }
        Ok(())
    }

    async fn admit(&mut self) -> Result<String> {
        let deadline = Instant::now() + WAIT;
        loop {
            self.recover().await?;
            let accepted = match self.case.ingress {
                Ingress::Slack => match post_slack_event(self.http).await? {
                    Some(status) => {
                        ensure!(status.is_success(), "Slack ingress returned {status}");
                        true
                    }
                    None => false,
                },
                Ingress::Operator => self.submit().await.is_ok(),
            };
            if accepted {
                break;
            }
            ensure!(
                Instant::now() < deadline,
                "request was never acknowledged after the crash"
            );
            sleep(POLL).await;
        }
        let ids = self.task_ids().await?;
        ensure!(ids.len() == 1, "accepted request created Tasks {ids:?}");
        Ok(ids[0].clone())
    }

    async fn submit(&self) -> Result<Task> {
        let mut operator = self.operator().await?;
        Ok(operator
            .submit_task(self.credentials.request(SubmitTaskRequest {
                output_policy: None,
                execution_limits: None,
                tag_id: TAG.into(),
                session_id: "crash".into(),
                operation_id: OPERATION.into(),
                prompt: PROMPT.into(),
                input_artifacts: vec![],
            })?)
            .await?
            .into_inner())
    }

    async fn connect_database(&self) -> Result<AnyConnection> {
        sqlx::any::install_default_drivers();
        Ok(AnyConnection::connect(self.database).await?)
    }

    async fn task_ids(&self) -> Result<Vec<String>> {
        let mut connection = self.connect_database().await?;
        let rows = sqlx::query("SELECT task_id FROM supertag_v2_tasks ORDER BY task_id")
            .fetch_all(&mut connection)
            .await?;
        connection.close().await?;
        rows.iter()
            .map(|row| Ok(row.try_get::<String, _>("task_id")?))
            .collect()
    }

    async fn task(&self, id: &str) -> Result<Task> {
        Ok(self
            .operator()
            .await?
            .get_task(
                self.credentials
                    .request(GetTaskRequest { task_id: id.into() })?,
            )
            .await?
            .into_inner())
    }

    async fn replies(&self) -> Result<Vec<Reply>> {
        Ok(self
            .operator()
            .await?
            .list_reply_deliveries(self.credentials.request(ListReplyDeliveriesRequest {
                account_id: SLACK_ACCOUNT.into(),
                state: 0,
                limit: 10,
                before_order: 0,
            })?)
            .await?
            .into_inner()
            .deliveries
            .into_iter()
            .filter_map(|delivery| delivery.reply)
            .collect())
    }

    /// The one recovery decision recorded for the Task's Attempts: its Attempt, and decision.
    async fn resolution(&self, id: &str) -> Result<(String, i64)> {
        let mut connection = self.connect_database().await?;
        let rows = sqlx::query(
            "SELECT attempt_id, decision FROM supertag_v2_attempt_resolutions WHERE task_id = $1",
        )
        .bind(id)
        .fetch_all(&mut connection)
        .await?;
        connection.close().await?;
        ensure!(rows.len() == 1, "{} recovery decisions", rows.len());
        Ok((rows[0].try_get("attempt_id")?, rows[0].try_get("decision")?))
    }

    /// The operator Inbox items for a Task that was not run again after its Worker was lost.
    async fn interrupted_items(&self, id: &str) -> Result<Vec<InboxItem>> {
        let channel = protocol::negotiated(
            Channel::from_shared(format!("http://{}", self.private))?
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(3))
                .connect()
                .await?,
        )
        .await?;
        Ok(InboxClient::new(channel)
            .list_items(self.credentials.request(ListInboxItemsRequest {
                objective_id: String::new(),
                kind: InboxItemKind::TaskAttention as i32,
                page_size: 100,
                cursor: String::new(),
            })?)
            .await?
            .into_inner()
            .items
            .into_iter()
            .filter(|item| item.key == format!("task_interrupted:{id}"))
            .collect())
    }

    fn launches(&self) -> Result<usize> {
        match std::fs::read_to_string(&self.launches) {
            Ok(text) => Ok(text.lines().count()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
            Err(error) => Err(error.into()),
        }
    }

    fn host_exit(&mut self) -> Result<Option<ExitStatus>> {
        match self.host.as_mut() {
            Some(host) => Ok(host.child.try_wait()?),
            None => Ok(None),
        }
    }

    /// Whether the expected recovered state is observable. Transient RPC failures
    /// while a restarted service is still binding are not outcomes.
    async fn settled(&mut self, id: &str) -> Result<bool> {
        let exit = self.host_exit()?;
        let Ok(task) = self.task(id).await else {
            return Ok(false);
        };
        Ok(match self.case.expect {
            Expect::Delivered => {
                exit.is_some()
                    && task.state() == TaskState::Succeeded
                    && self.replies().await.is_ok_and(|replies| {
                        replies
                            .iter()
                            .any(|reply| reply.state() == ReplyState::Delivered)
                    })
            }
            Expect::ReplyUncertain { .. } => {
                exit.is_some()
                    && task.state() == TaskState::Succeeded
                    && self.replies().await.is_ok_and(|replies| {
                        replies
                            .iter()
                            .any(|reply| reply.state() == ReplyState::Uncertain)
                    })
            }
            Expect::Succeeded => exit.is_some() && task.state() == TaskState::Succeeded,
            Expect::Failed { .. } => {
                exit.is_some()
                    && task.state() == TaskState::Failed
                    && (self.case.ingress != Ingress::Slack
                        || self.replies().await.is_ok_and(|replies| {
                            replies
                                .iter()
                                .any(|reply| reply.state() == ReplyState::Delivered)
                        }))
            }
            Expect::Redelivered { .. } => {
                exit.is_some()
                    && task.state() == TaskState::Succeeded
                    && (self.case.ingress != Ingress::Slack
                        || self.replies().await.is_ok_and(|replies| {
                            replies
                                .iter()
                                .any(|reply| reply.state() == ReplyState::Delivered)
                        }))
            }
            Expect::NotRedelivered { .. } => {
                exit.is_some()
                    && task.state() == TaskState::Failed
                    && (self.case.ingress != Ingress::Slack
                        || self.replies().await.is_ok_and(|replies| {
                            replies
                                .iter()
                                .any(|reply| reply.state() == ReplyState::Delivered)
                        }))
            }
        })
    }

    async fn drive(&mut self, id: &str) -> Result<()> {
        let deadline = Instant::now() + WAIT;
        loop {
            self.recover().await?;
            if self.crashed && self.settled(id).await? {
                return Ok(());
            }
            // A `--once` host exits once it reclaimed the Attempt; another runs the redelivered
            // Task after its backoff.
            if self.crashed
                && matches!(self.case.expect, Expect::Redelivered { .. })
                && self.host_exit()?.is_some_and(|status| status.success())
                && self
                    .task(id)
                    .await
                    .is_ok_and(|task| task.state() == TaskState::Queued)
            {
                self.start_host()?;
            }
            // A host that fails is never a recovered outcome. Only the host chosen to crash may
            // die, by SIGKILL at its crash point, before recover() sees the marker.
            let crashing = !self.crashed && self.case.target == Target::WorkerHost;
            if let Some(status) = self.host_exit()?
                && !status.success()
                && !(crashing && status.signal() == Some(libc::SIGKILL))
            {
                bail!(
                    "host exited with {status} (crashed={}) at {}: {}",
                    self.crashed,
                    self.case.point,
                    self.host.as_ref().map(Process::logs).unwrap_or_default()
                );
            }
            if Instant::now() >= deadline {
                let task = self.task(id).await.ok();
                bail!(
                    "{:?} at {} did not reach {:?}; crashed={}, task={:?}, replies={:?}, provider requests={}\nhost: {}\ngateway: {}\ncontrol plane: {}",
                    self.case.target,
                    self.case.point,
                    self.case.expect,
                    self.crashed,
                    task.map(|task| (task.state(), task.result)),
                    self.replies().await.ok(),
                    self.mock.count().await,
                    self.host.as_ref().map(Process::logs).unwrap_or_default(),
                    self.gateway.logs(),
                    self.control_plane.logs(),
                );
            }
            sleep(POLL).await;
        }
    }

    async fn assert_invariants(&mut self, id: &str) -> Result<()> {
        let case = self.case;
        ensure!(self.crashed, "crash point {} was never reached", case.point);
        // Exactly one Task: redelivering the same request resolves to the original.
        match case.ingress {
            // Slack redelivers an event the webhook did not acknowledge, so the test does too.
            Ingress::Slack => {
                let deadline = Instant::now() + WAIT;
                let status = loop {
                    if let Some(status) = post_slack_event(self.http).await? {
                        break status;
                    }
                    ensure!(
                        Instant::now() < deadline,
                        "redelivered Slack event was never acknowledged: {}",
                        self.gateway.logs()
                    );
                    sleep(POLL).await;
                };
                ensure!(
                    status == reqwest::StatusCode::OK,
                    "redelivered Slack event returned {status}"
                );
            }
            Ingress::Operator => ensure!(
                retry("retry the submission", || self.submit())
                    .await?
                    .task_id
                    == id,
                "retried submission created another Task"
            ),
        }
        let ids = self.task_ids().await?;
        ensure!(ids == [id], "expected exactly Task {id}, found {ids:?}");

        let task = retry("get the Task", || self.task(id)).await?;
        let events = retry("list the Task's events", || async {
            Ok(self
                .operator()
                .await?
                .list_events(self.credentials.request(ListEventsRequest {
                    task_id: id.into(),
                    after_sequence: 0,
                    limit: 100,
                })?)
                .await?
                .into_inner()
                .events)
        })
        .await?;
        let sequences = events
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>();
        let replies = retry("list the replies", || self.replies()).await?;
        let posts = self.mock.requests.lock().await.clone();
        let provider_requests = posts.len();
        // Provider posts carrying the Task's result, as opposed to its acknowledgement or
        // failure text.
        let result_posts = posts.iter().filter(|body| body["text"] == RESULT).count();
        let launches = self.launches()?;
        match case.expect {
            Expect::Delivered | Expect::ReplyUncertain { .. } | Expect::Succeeded => {
                ensure!(launches == 1, "adapter launched {launches} times");
                ensure!(task.state() == TaskState::Succeeded);
                ensure!(
                    task.result.as_deref() == Some(RESULT),
                    "lost result {task:?}"
                );
                ensure!(sequences == [1, 2], "events {sequences:?}");
                ensure!(events[1].text == RESULT);
                let exit = self.host_exit()?.context("host still running")?;
                ensure!(exit.success(), "recovered host exited with {exit}");
            }
            Expect::Failed { events } => {
                ensure!(launches == 1, "adapter launched {launches} times");
                ensure!(task.state() == TaskState::Failed, "task {task:?}");
                ensure!(
                    sequences == (1..=events as u64).collect::<Vec<_>>(),
                    "events {sequences:?}"
                );
                ensure!(result_posts == 0, "failed Task posted its result");
                if case.ingress == Ingress::Slack {
                    ensure!(replies.len() == 1, "replies {replies:?}");
                    ensure!(replies[0].state() == ReplyState::Delivered);
                    ensure!(replies[0].task_id == id);
                    let failure_posts = posts
                        .iter()
                        .filter(|body| body["text"] == replies[0].text.as_str())
                        .count();
                    ensure!(
                        failure_posts == 1 && provider_requests <= 2,
                        "provider received {provider_requests} posts, {failure_posts} with the failure"
                    );
                } else {
                    ensure!(replies.is_empty() && provider_requests == 0);
                }
            }
            Expect::Redelivered {
                launches: expected,
                events: count,
            } => {
                ensure!(launches == expected, "adapter launched {launches} times");
                ensure!(task.state() == TaskState::Succeeded, "task {task:?}");
                // The fixture's result repeats its prompt, which says the first run was
                // interrupted and what it had already said.
                let result = task.result.clone().unwrap_or_default();
                ensure!(
                    result.starts_with(&format!(
                        "{INSTRUCTIONS}: {PROMPT}\n\nA previous run of this request was interrupted before finishing."
                    )),
                    "the redelivered Attempt was not told about the interruption: {result}"
                );
                for said in case
                    .adapter_args
                    .iter()
                    .filter_map(|arg| arg.strip_prefix("--say-first="))
                {
                    ensure!(
                        result.contains(&format!("> {said}")),
                        "the redelivered Attempt was not told what was already said: {result}"
                    );
                }
                ensure!(
                    sequences == (1..=count as u64).collect::<Vec<_>>(),
                    "events {sequences:?}"
                );
                ensure!(events.last().is_some_and(|event| event.text == result));
                // The same Task, finished once by a new Attempt.
                let (lost, decision) = self.resolution(id).await?;
                ensure!(
                    decision == supertag_protocol::v2::AttemptDecision::Retry as i64,
                    "the interrupted Attempt was not redelivered"
                );
                ensure!(
                    task.attempt_id
                        .as_deref()
                        .is_some_and(|attempt| attempt != lost)
                );
                let exit = self.host_exit()?.context("host still running")?;
                ensure!(exit.success(), "redelivering host exited with {exit}");
                if case.ingress == Ingress::Slack {
                    let result_posts = posts
                        .iter()
                        .filter(|body| body["text"] == result.as_str())
                        .count();
                    ensure!(replies.len() == 1, "replies {replies:?}");
                    ensure!(replies[0].state() == ReplyState::Delivered);
                    ensure!(
                        result_posts == 1 && provider_requests <= 2,
                        "provider received {provider_requests} posts, {result_posts} with the result"
                    );
                } else {
                    ensure!(replies.is_empty() && provider_requests == 0);
                }
            }
            Expect::NotRedelivered {
                launches: expected,
                events,
            } => {
                ensure!(launches == expected, "adapter launched {launches} times");
                let exit = self.host_exit()?.context("host still running")?;
                ensure!(exit.success(), "reclaiming host exited with {exit}");
                ensure!(
                    task.state() == TaskState::Failed
                        && task.result.as_deref().is_some_and(|result| {
                            result.contains("outcome is unknown")
                                && result.contains("did not run the Task again because an external write it started never reported its outcome")
                        }),
                    "host death was not reclaimed without redelivery: {task:?}"
                );
                let (_, decision) = self.resolution(id).await?;
                ensure!(decision == supertag_protocol::v2::AttemptDecision::Failed as i64);
                let items = self.interrupted_items(id).await?;
                ensure!(
                    items.len() == 1
                        && items[0].reason.contains(&format!("of Tag {TAG}"))
                        && items[0].reason.contains("an external write"),
                    "Inbox items {items:?}"
                );
                ensure!(
                    sequences == (1..=events as u64).collect::<Vec<_>>(),
                    "events {sequences:?}"
                );
                ensure!(result_posts == 0, "reclaimed Task posted a result");
                if case.ingress == Ingress::Slack {
                    ensure!(replies.len() == 1, "replies {replies:?}");
                    ensure!(replies[0].state() == ReplyState::Delivered);
                    let failure_posts = posts
                        .iter()
                        .filter(|body| body["text"] == replies[0].text.as_str())
                        .count();
                    ensure!(
                        failure_posts == 1 && provider_requests <= 2,
                        "provider received {provider_requests} posts, {failure_posts} with the failure"
                    );
                } else {
                    ensure!(replies.is_empty() && provider_requests == 0);
                }
            }
        }
        match (case.ingress, case.expect) {
            (Ingress::Slack, Expect::Delivered) => {
                ensure!(replies.len() == 1, "replies {replies:?}");
                ensure!(replies[0].state() == ReplyState::Delivered);
                ensure!(replies[0].provider_receipt.as_deref() == Some(SLACK_RECEIPT));
                ensure!(replies[0].task_id == id);
                ensure!(
                    result_posts == 1 && provider_requests <= 2,
                    "provider received {provider_requests} posts, {result_posts} with the result"
                );
                // The result is the last post: a new thread reply, or an in-place update of
                // the acknowledgement.
                let body = posts.last().context("no provider post")?;
                ensure!(
                    body["text"] == RESULT
                        && (body["thread_ts"] == SLACK_THREAD || body["ts"] == SLACK_RECEIPT),
                    "unexpected final post {body}"
                );
            }
            (
                Ingress::Slack,
                Expect::ReplyUncertain {
                    provider_requests: expected,
                },
            ) => {
                ensure!(replies.len() == 1, "replies {replies:?}");
                ensure!(replies[0].state() == ReplyState::Uncertain);
                ensure!(replies[0].provider_receipt.is_none());
                ensure!(
                    result_posts == expected && provider_requests <= expected + 1,
                    "provider received {provider_requests} posts, {result_posts} with the result, expected {expected}"
                );
            }
            (Ingress::Operator, Expect::Succeeded) => {
                ensure!(replies.is_empty() && provider_requests == 0);
            }
            (
                _,
                Expect::Failed { .. } | Expect::Redelivered { .. } | Expect::NotRedelivered { .. },
            ) => {}
            (ingress, expect) => bail!("invalid case: {ingress:?} with {expect:?}"),
        }
        // A settled reply is never offered again: no claimable reply remains.
        let mut connection = self.connect_database().await?;
        let claimable: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_replies WHERE state IN ($1, $2)")
                .bind(ReplyState::Pending as i64)
                .bind(ReplyState::Claimed as i64)
                .fetch_one(&mut connection)
                .await?;
        connection.close().await?;
        ensure!(claimable == 0, "{claimable} replies remain claimable");
        Ok(())
    }
}

/// The Gateway and Worker Host keep the Control Plane's address, so a restarted Control Plane
/// must listen on its old port. Between the crash and the restart that port is free, and any
/// process on the machine binding port 0 (another case's service or mock, run in parallel) may
/// be given it. On Linux a socket bound with `SO_REUSEADDR` that never listens holds the port
/// against those binds and against outgoing connections, while a listener that also sets
/// `SO_REUSEADDR`, as the Control Plane's does, can still bind it. Elsewhere the port is chosen
/// by the Control Plane and not held.
struct PortReservation(#[allow(dead_code)] Option<std::os::fd::OwnedFd>);

impl PortReservation {
    #[cfg(target_os = "linux")]
    fn loopback() -> Result<(SocketAddr, Self)> {
        use std::os::fd::{AsRawFd as _, FromRawFd as _, OwnedFd};
        // SAFETY: plain socket calls on a descriptor this function owns, with buffers sized for
        // the structures they hold.
        unsafe {
            let fd = libc::socket(libc::AF_INET, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0);
            ensure!(
                fd >= 0,
                "reserve a port: {}",
                std::io::Error::last_os_error()
            );
            let socket = OwnedFd::from_raw_fd(fd);
            let on: libc::c_int = 1;
            ensure!(
                libc::setsockopt(
                    socket.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_REUSEADDR,
                    (&raw const on).cast(),
                    size_of::<libc::c_int>() as libc::socklen_t,
                ) == 0,
                "reserve a port: {}",
                std::io::Error::last_os_error()
            );
            let mut address: libc::sockaddr_in = std::mem::zeroed();
            address.sin_family = libc::AF_INET as libc::sa_family_t;
            address.sin_addr.s_addr = u32::from(std::net::Ipv4Addr::LOCALHOST).to_be();
            let mut length = size_of::<libc::sockaddr_in>() as libc::socklen_t;
            ensure!(
                libc::bind(socket.as_raw_fd(), (&raw const address).cast(), length) == 0,
                "reserve a port: {}",
                std::io::Error::last_os_error()
            );
            ensure!(
                libc::getsockname(socket.as_raw_fd(), (&raw mut address).cast(), &mut length) == 0,
                "reserve a port: {}",
                std::io::Error::last_os_error()
            );
            let port = u16::from_be(address.sin_port);
            Ok((
                SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port)),
                Self(Some(socket)),
            ))
        }
    }

    #[cfg(not(target_os = "linux"))]
    fn loopback() -> Result<(SocketAddr, Self)> {
        Ok(("127.0.0.1:0".parse()?, Self(None)))
    }
}

fn spawn_control_plane(
    credentials: &Credentials,
    database: &str,
    directory: &Path,
    listen: SocketAddr,
    crash: Option<(&str, &Path)>,
) -> Result<Process> {
    let mut command = credentials.command();
    command
        .args(["control-plane", "--listen", &listen.to_string()])
        .env("SUPERTAG_DATABASE_URL", database);
    if let Some((point, marker)) = crash {
        command
            .env(CRASH_POINT_ENV, point)
            .env(CRASH_MARKER_ENV, marker);
    }
    Process::spawn(command, directory, "control-plane", true)
}

fn spawn_gateway(
    credentials: &Credentials,
    directory: &Path,
    mock: &MockSlackApi,
    (private, public, http): (SocketAddr, SocketAddr, SocketAddr),
    crash: Option<(&str, &Path)>,
) -> Result<Process> {
    let mut command = credentials.command();
    command
        .args(["gateway", "--listen", &public.to_string()])
        .arg("--control-plane")
        .arg(format!("http://{private}"))
        .args([
            "--slack-listen",
            &http.to_string(),
            "--slack-state-directory",
        ])
        .arg(directory.join("slack"))
        .env("SUPERTAG_SLACK_ACCOUNT_ID", SLACK_ACCOUNT)
        .env("SUPERTAG_SLACK_TEAM_ID", SLACK_TEAM)
        .env("SUPERTAG_SLACK_CHANNEL_ID", SLACK_CHANNEL)
        .env("SUPERTAG_SLACK_TAG_ID", TAG)
        .env("SUPERTAG_SLACK_ALLOWED_USERS", SLACK_USER)
        .env("SUPERTAG_SLACK_SIGNING_SECRET", SLACK_SIGNING_SECRET)
        .env("SUPERTAG_SLACK_BOT_TOKEN", SLACK_BOT_TOKEN)
        .env("SUPERTAG_TEST_SLACK_API_URL", &mock.endpoint);
    if let Some((point, marker)) = crash {
        command
            .env(CRASH_POINT_ENV, point)
            .env(CRASH_MARKER_ENV, marker);
    }
    Process::spawn(command, directory, "gateway", true)
}

async fn exercise(case: Case, database: &str, directory: &Path) -> Result<()> {
    let mut system = System::start(case, database, directory).await?;
    system.configure().await?;
    let id = system.admit().await?;
    system.start_host()?;
    system.drive(&id).await?;
    system.assert_invariants(&id).await
}

async fn run_sqlite(case: Case) -> Result<()> {
    let directory = TempDir::new()?;
    let database = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("state.db").display()
    );
    exercise(case, &database, directory.path()).await
}

async fn run_postgres(case: Case) -> Result<()> {
    with_crash_postgres(move |database, directory| async move {
        exercise(case, &database, &directory).await
    })
    .await
}

/// Runs a crash scenario against its own PostgreSQL database and always drops it.
async fn with_crash_postgres<F, Fut>(scenario: F) -> Result<()>
where
    F: FnOnce(String, PathBuf) -> Fut,
    Fut: std::future::Future<Output = Result<()>> + Send + 'static,
{
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .context("PostgreSQL crash cases require SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")?;
    let admin_url = std::fs::read_to_string(path)?;
    let options = PgConnectOptions::from_str(admin_url.trim())?;
    let mut admin = PgConnection::connect_with(&options).await?;
    if std::env::var_os("SUPERTAG_RUST_TEST_REQUIRE_DURABLE_POSTGRES").is_some() {
        for setting in ["fsync", "synchronous_commit", "full_page_writes"] {
            let value: String = sqlx::query_scalar(&format!("SHOW {setting}"))
                .fetch_one(&mut admin)
                .await?;
            ensure!(
                value == "on",
                "durable crash lane requires {setting}=on, server has {value}"
            );
        }
    }
    let name = format!("supertag_rust_crash_{}", Uuid::new_v4().simple());
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await?;
    let database = options.database(&name).to_url_lossy().to_string();
    let directory = TempDir::new()?;
    let path = directory.path().to_owned();
    // Isolate assertion panics so database cleanup also runs when a check fails.
    let result = tokio::spawn(scenario(database, path)).await;
    let cleanup = admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await;
    admin.close().await?;
    cleanup?;
    result.context("PostgreSQL crash case panicked")?
}

macro_rules! crash_matrix {
    ($($name:ident => $case:expr;)*) => {
        mod sqlite {
            use super::*;
            $(
                #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
                async fn $name() -> Result<()> {
                    run_sqlite($case).await
                }
            )*
        }

        mod postgres {
            use super::*;
            $(
                #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
                #[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
                async fn $name() -> Result<()> {
                    run_postgres($case).await
                }
            )*
        }
    };
}

use Expect::*;
use Ingress::{Operator, Slack};
use Target::{Adapter, ControlPlane, Gateway, Worker, WorkerHost};

crash_matrix! {
    // Admission.
    control_plane_operator_admission_before_commit =>
        case(ControlPlane, "control-plane.submit.before-commit", Operator, Succeeded);
    control_plane_operator_admission_after_commit =>
        case(ControlPlane, "control-plane.submit.after-commit", Operator, Succeeded);
    api_operator_admission_before_forward =>
        case(ControlPlane, "api.submit.before-forward", Operator, Succeeded);
    api_operator_admission_after_forward =>
        case(ControlPlane, "api.submit.after-forward", Operator, Succeeded);
    control_plane_slack_admission_before_commit =>
        case(ControlPlane, "control-plane.slack-admission.before-commit", Slack, Delivered);
    control_plane_slack_admission_after_commit =>
        case(ControlPlane, "control-plane.slack-admission.after-commit", Slack, Delivered);
    gateway_slack_admission_before_forward =>
        case(Gateway, "gateway.slack-admission.before-forward", Slack, Delivered);
    gateway_slack_admission_after_forward =>
        case(Gateway, "gateway.slack-admission.after-forward", Slack, Delivered);

    // Assignment and claim.
    control_plane_claim_before_commit =>
        case(ControlPlane, "control-plane.claim.before-commit", Slack, Delivered);
    control_plane_claim_after_commit =>
        case(ControlPlane, "control-plane.claim.after-commit", Slack, Delivered);
    api_claim_before_forward =>
        case(ControlPlane, "api.claim.before-forward", Slack, Delivered);
    api_claim_after_forward =>
        case(ControlPlane, "api.claim.after-forward", Slack, Delivered);
    worker_host_claim_journaled =>
        case(WorkerHost, "worker-host.claim.journaled", Slack, Delivered);
    worker_host_claim_assigned =>
        case(WorkerHost, "worker-host.claim.assigned", Slack, Delivered);

    // Start receipt.
    worker_host_start_journaled =>
        case(WorkerHost, "worker-host.start.journaled", Slack, Delivered);
    control_plane_start_before_commit =>
        case(ControlPlane, "control-plane.start.before-commit", Slack, Delivered);
    control_plane_start_after_commit =>
        case(ControlPlane, "control-plane.start.after-commit", Slack, Delivered);
    api_start_before_forward =>
        case(ControlPlane, "api.start.before-forward", Slack, Delivered);
    api_start_after_forward =>
        case(ControlPlane, "api.start.after-forward", Slack, Delivered);
    worker_host_start_answered =>
        case(WorkerHost, "worker-host.start.answered", Slack, Delivered);
    // The harness never launched, so the redelivered Task runs it once.
    worker_host_execute_journaled =>
        case(WorkerHost, "worker-host.execute.journaled", Slack,
            Redelivered { launches: 1, events: 2 });
    // The Worker dies once it read its Assign: its Worklet starts another for the Attempt.
    worker_assign_received =>
        case(Worker, "worker.assign.received", Slack, Delivered);
    worker_execute_journaled =>
        case(Worker, "worker.execute.journaled", Slack,
            Redelivered { launches: 1, events: 2 });
    adapter_attached =>
        case(Adapter, "adapter.attached", Slack, Failed { events: 0 });

    // Event append. The Worker Host repeats an append whose outcome the transport lost, and
    // the Control Plane deduplicates it by sequence and content, so the Task still succeeds.
    control_plane_event_before_commit =>
        case(ControlPlane, "control-plane.append-event.before-commit", Slack, Delivered);
    control_plane_event_after_commit =>
        case(ControlPlane, "control-plane.append-event.after-commit", Slack, Delivered);
    api_event_before_forward =>
        case(ControlPlane, "api.append-event.before-forward", Slack, Delivered);
    api_event_after_forward =>
        case(ControlPlane, "api.append-event.after-forward", Slack, Delivered);
    // The harness launched and published before its Worker died: it runs once more.
    worker_event_answered =>
        case(Worker, "worker.append-event.answered", Slack,
            Redelivered { launches: 2, events: 3 });
    // What the first run said reaches the second run's prompt.
    worker_message_answered =>
        with_adapter(
            case(Worker, "worker.append-event.answered", Operator,
                Redelivered { launches: 2, events: 3 }),
            &["--say-first=Looking into it."]);
    // An effect begun and never settled: the Task is not run again, and the Inbox shows it.
    worker_effect_begun =>
        with_adapter(
            case(Worker, "worker.append-event.answered", Slack,
                NotRedelivered { launches: 1, events: 1 }),
            &["--begin-effect=ticket/crash"]);
    adapter_published =>
        case(Adapter, "adapter.published", Slack, Failed { events: 1 });

    // Terminal outcome.
    // The host accepts a proposed result only from an adapter that then exits
    // cleanly (worker-host/src/worker/adapter.rs), so a killed adapter settles as failed.
    adapter_completed =>
        case(Adapter, "adapter.completed", Slack, Failed { events: 2 });
    // The Worklet journaled the outcome the Worker handed over, and dies with its Worker.
    worker_host_outcome_journaled =>
        case(WorkerHost, "worker-host.outcome.journaled", Slack, Delivered);
    // The Worker handed its outcome over and dies before it exits.
    worker_outcome_handed =>
        case(Worker, "worker.outcome.handed", Slack, Delivered);
    worker_host_finish_journaled =>
        case(WorkerHost, "worker-host.finish.journaled", Slack, Delivered);
    control_plane_finish_before_commit =>
        case(ControlPlane, "control-plane.finish.before-commit", Slack, Delivered);
    control_plane_finish_after_commit =>
        case(ControlPlane, "control-plane.finish.after-commit", Slack, Delivered);
    api_finish_before_forward =>
        case(ControlPlane, "api.finish.before-forward", Slack, Delivered);
    api_finish_after_forward =>
        case(ControlPlane, "api.finish.after-forward", Slack, Delivered);
    worker_host_finish_answered =>
        case(WorkerHost, "worker-host.finish.answered", Slack, Delivered);
    worker_host_terminal_journaled =>
        case(WorkerHost, "worker-host.terminal.journaled", Slack, Delivered);

    // Outbound delivery.
    control_plane_reply_claim_before_commit =>
        case(ControlPlane, "control-plane.claim-reply.before-commit", Slack, Delivered);
    control_plane_reply_claim_after_commit =>
        case(ControlPlane, "control-plane.claim-reply.after-commit", Slack, Delivered);
    gateway_reply_claimed =>
        case(Gateway, "gateway.reply.claimed", Slack, Delivered);
    gateway_reply_sending_journaled =>
        case(Gateway, "gateway.reply.sending-journaled", Slack,
            ReplyUncertain { provider_requests: 0 });
    gateway_reply_provider_answered =>
        case(Gateway, "gateway.reply.provider-answered", Slack,
            ReplyUncertain { provider_requests: 1 });
    gateway_reply_settle_journaled =>
        case(Gateway, "gateway.reply.settle-journaled", Slack, Delivered);
    control_plane_reply_settle_before_commit =>
        case(ControlPlane, "control-plane.settle-reply.before-commit", Slack, Delivered);
    control_plane_reply_settle_after_commit =>
        case(ControlPlane, "control-plane.settle-reply.after-commit", Slack, Delivered);
    gateway_reply_settled =>
        case(Gateway, "gateway.reply.settled", Slack, Delivered);
}

use provider_delivery_crash::{DeliveryCase, Provider, Settles, delivery, exercise_delivery};

async fn run_delivery_sqlite(case: DeliveryCase) -> Result<()> {
    let directory = TempDir::new()?;
    let database = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("state.db").display()
    );
    exercise_delivery(case, &database, directory.path()).await
}

async fn run_delivery_postgres(case: DeliveryCase) -> Result<()> {
    with_crash_postgres(move |database, directory| async move {
        exercise_delivery(case, &database, &directory).await
    })
    .await
}

/// GitHub, Linear, Lark, and Microsoft Teams reply delivery: the Gateway is killed
/// at each durable boundary and restarted on its delivery journal.
macro_rules! delivery_crash_matrix {
    ($($name:ident => $case:expr;)*) => {
        mod provider_sqlite {
            use super::*;
            $(
                #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
                async fn $name() -> Result<()> {
                    run_delivery_sqlite($case).await
                }
            )*
        }

        mod provider_postgres {
            use super::*;
            $(
                #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
                #[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
                async fn $name() -> Result<()> {
                    run_delivery_postgres($case).await
                }
            )*
        }
    };
}

use Provider::{Github, Lark, Linear, MicrosoftTeams};
use Settles::Uncertain;

delivery_crash_matrix! {
    github_reply_claimed => delivery(Github, "claimed", Settles::Delivered);
    github_reply_sending_journaled =>
        delivery(Github, "sending-journaled", Uncertain { posts: 0 });
    github_reply_provider_answered =>
        delivery(Github, "provider-answered", Uncertain { posts: 1 });
    github_reply_settle_journaled => delivery(Github, "settle-journaled", Settles::Delivered);
    github_reply_settled => delivery(Github, "settled", Settles::Delivered);

    linear_reply_claimed => delivery(Linear, "claimed", Settles::Delivered);
    linear_reply_sending_journaled =>
        delivery(Linear, "sending-journaled", Uncertain { posts: 0 });
    linear_reply_provider_answered =>
        delivery(Linear, "provider-answered", Uncertain { posts: 1 });
    linear_reply_settle_journaled => delivery(Linear, "settle-journaled", Settles::Delivered);
    linear_reply_settled => delivery(Linear, "settled", Settles::Delivered);

    lark_reply_claimed => delivery(Lark, "claimed", Settles::Delivered);
    lark_reply_sending_journaled => delivery(Lark, "sending-journaled", Uncertain { posts: 0 });
    lark_reply_provider_answered => delivery(Lark, "provider-answered", Uncertain { posts: 1 });
    lark_reply_settle_journaled => delivery(Lark, "settle-journaled", Settles::Delivered);
    lark_reply_settled => delivery(Lark, "settled", Settles::Delivered);

    microsoft_teams_reply_claimed => delivery(MicrosoftTeams, "claimed", Settles::Delivered);
    microsoft_teams_reply_sending_journaled =>
        delivery(MicrosoftTeams, "sending-journaled", Uncertain { posts: 0 });
    microsoft_teams_reply_provider_answered =>
        delivery(MicrosoftTeams, "provider-answered", Uncertain { posts: 1 });
    microsoft_teams_reply_settle_journaled =>
        delivery(MicrosoftTeams, "settle-journaled", Settles::Delivered);
    microsoft_teams_reply_settled => delivery(MicrosoftTeams, "settled", Settles::Delivered);
}
