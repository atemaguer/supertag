//! Signed HTTP Slack ingress through separate CP/Gateway/Host processes.
//! Every provider interaction terminates at this test's loopback HTTP server.
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[path = "support/protocol.rs"]
mod protocol;
#[macro_use]
#[path = "support/database.rs"]
mod database;

use std::{
    fs::File,
    io::{BufRead, BufReader},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, mpsc},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use supertag_protocol::negotiation::ProtocolChannel;

use anyhow::{Context, Result, ensure};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use sqlx::Connection as _;
use supertag_protocol::{
    authenticated_request,
    v2::{
        AcceptSlackEventRequest, GetTaskRequest, PutTagRequest, ReplyState, Task, TaskState,
        connector_client::ConnectorClient, operator_client::OperatorClient,
    },
};
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
const WAIT: Duration = Duration::from_secs(20);
const ACCOUNT: &str = "slack-thread-test";
const TEAM: &str = "TTEAM1";
const CHANNEL: &str = "CCHANNEL1";
const THREAD: &str = "1794470000.100000";
const SIGNING: &str = "synthetic-slack-thread-signing-key";
const BOT: &str = "xoxb-synthetic-slack-thread-token";

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
    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(BINARY);
        command
            .args(args)
            .env_clear()
            .stdin(Stdio::null())
            .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &self.gateway)
            .env("SUPERTAG_GATEWAY_CREDENTIAL", &self.gateway)
            .env("SUPERTAG_OPERATOR_TOKEN", &self.operator)
            .env("SUPERTAG_HOST_TOKEN", &self.host)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &self.host);
        command
    }
    fn operator<T>(&self, input: T) -> Result<Request<T>> {
        request(input, &self.operator, None)
    }
    fn connector<T>(&self, input: T) -> Result<Request<T>> {
        request(input, &self.gateway, Some(&format!("connector:{ACCOUNT}")))
    }
}

fn request<T>(input: T, token: &str, principal: Option<&str>) -> Result<Request<T>> {
    // A Gateway names the connector account it acts for; nobody names a principal.
    let mut request = match principal.and_then(|principal| principal.strip_prefix("connector:")) {
        Some(account) => supertag_protocol::connector_request(input, token, account)?,
        None => authenticated_request(input, token, None)?,
    };
    request.set_timeout(Duration::from_secs(3));
    Ok(request)
}

struct Process {
    child: Child,
    log: PathBuf,
}

impl Process {
    fn spawn(mut command: Command, directory: &Path, name: &str) -> Result<Self> {
        let log = directory.join(format!("{name}-{}.log", Uuid::new_v4()));
        Ok(Self {
            child: command
                .stdout(Stdio::piped())
                .stderr(File::create(&log)?)
                .spawn()?,
            log,
        })
    }
    async fn endpoints(&mut self, count: usize) -> Result<Vec<String>> {
        let stdout = self.child.stdout.take().context("missing process stdout")?;
        let (sender, receiver) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let lines: std::io::Result<Vec<_>> = (0..count)
                .map(|_| {
                    let mut line = String::new();
                    reader.read_line(&mut line)?;
                    Ok(line)
                })
                .collect();
            let _ = sender.send(lines);
        });
        let deadline = Instant::now() + WAIT;
        loop {
            match receiver.try_recv() {
                Ok(lines) => {
                    return lines?
                        .into_iter()
                        .map(|line| {
                            let address: SocketAddr =
                                line.trim().parse().with_context(|| self.logs())?;
                            ensure!(address.ip().is_loopback() && address.port() != 0);
                            Ok(format!("http://{address}"))
                        })
                        .collect();
                }
                Err(mpsc::TryRecvError::Empty) => {}
                Err(error) => anyhow::bail!("process output closed: {error}: {}", self.logs()),
            }
            ensure!(
                self.child.try_wait()?.is_none(),
                "process exited during startup: {}",
                self.logs()
            );
            ensure!(
                Instant::now() < deadline,
                "process startup timed out: {}",
                self.logs()
            );
            sleep(Duration::from_millis(10)).await;
        }
    }
    async fn success(&mut self) -> Result<()> {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(status) = self.child.try_wait()? {
                ensure!(status.success(), "process failed: {}", self.logs());
                return Ok(());
            }
            ensure!(
                Instant::now() < deadline,
                "process did not stop: {}",
                self.logs()
            );
            sleep(Duration::from_millis(10)).await;
        }
    }
    async fn stop(&mut self) -> Result<()> {
        if self.child.try_wait()?.is_none() {
            ensure!(unsafe { libc::kill(self.child.id() as i32, libc::SIGTERM) } == 0);
        }
        self.success().await
    }
    fn logs(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        if !matches!(self.child.try_wait(), Ok(Some(_))) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

struct MockSlack {
    endpoint: String,
    requests: Arc<Mutex<Vec<(String, Value)>>>,
    gate: Arc<tokio::sync::Semaphore>,
    server: tokio::task::JoinHandle<Result<()>>,
}

impl MockSlack {
    async fn start() -> Result<Self> {
        Self::start_with(tokio::sync::Semaphore::MAX_PERMITS).await
    }

    /// Record each post at once but answer it only after `release`.
    async fn start_held() -> Result<Self> {
        Self::start_with(0).await
    }

    fn release(&self) {
        self.gate.add_permits(1024);
    }

    async fn start_with(permits: usize) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = format!("http://{}/chat.postMessage", listener.local_addr()?);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let observed = requests.clone();
        let gate = Arc::new(tokio::sync::Semaphore::new(permits));
        let held = gate.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut connection, _) = listener.accept().await?;
                let request =
                    tokio::time::timeout(Duration::from_secs(5), mock_request(&mut connection))
                        .await??;
                // An update answers with the message it replaced; a post with a new message.
                let update = (request.0 == "/chat.update")
                    .then(|| request.1["ts"].as_str().unwrap_or_default().to_owned());
                let position = {
                    let mut requests = observed.lock().await;
                    requests.push(request);
                    requests.len()
                };
                held.acquire().await?.forget();
                let ts = update.unwrap_or_else(|| format!("1794470100.{position:06}"));
                let requests = observed.lock().await;
                let body = json!({"ok":true,"channel":CHANNEL,"ts":ts}).to_string();
                drop(requests);
                connection.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await?;
                connection.shutdown().await?;
            }
        });
        Ok(Self {
            endpoint,
            requests,
            gate,
            server,
        })
    }
}

impl Drop for MockSlack {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn mock_request(stream: &mut TcpStream) -> Result<(String, Value)> {
    let mut bytes = Vec::new();
    let mut buffer = [0; 4096];
    let end = loop {
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
        ensure!(bytes.len() < 16_384, "fixture HTTP headers too large");
        let count = stream.read(&mut buffer).await?;
        ensure!(count > 0, "fixture HTTP headers ended early");
        bytes.extend_from_slice(&buffer[..count]);
    };
    let headers = std::str::from_utf8(&bytes[..end])?;
    let path = headers
        .strip_prefix("POST ")
        .and_then(|line| line.split_once(" HTTP/1.1\r\n"))
        .map(|(path, _)| path.to_owned())
        .context("unexpected fixture HTTP request")?;
    ensure!(matches!(
        path.as_str(),
        "/chat.postMessage" | "/chat.update"
    ));
    let header = |name: &str| {
        headers
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.trim())
    };
    ensure!(header("authorization") == Some(format!("Bearer {BOT}").as_str()));
    let length: usize = header("content-length")
        .context("fixture HTTP length missing")?
        .parse()?;
    ensure!(length <= 262_144);
    while bytes.len() < end + length {
        let count = stream.read(&mut buffer).await?;
        ensure!(count > 0, "fixture HTTP body ended early");
        bytes.extend_from_slice(&buffer[..count]);
    }
    Ok((path, serde_json::from_slice(&bytes[end..end + length])?))
}

const ACKNOWLEDGEMENT: &str = "Got it. I’m looking into this now.";

/// Waits until the fixture Slack received `count` final replies; returns the last one's index.
async fn delivered_final(mock: &MockSlack, count: usize) -> Result<usize> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let finals: Vec<usize> = mock
            .requests
            .lock()
            .await
            .iter()
            .enumerate()
            .filter(|(_, (_, body))| body["text"] != ACKNOWLEDGEMENT)
            .map(|(index, _)| index)
            .collect();
        if finals.len() >= count {
            ensure!(finals.len() == count, "unexpected extra final reply");
            return Ok(finals[count - 1]);
        }
        ensure!(
            tokio::time::Instant::now() < deadline,
            "final reply {count} was not delivered"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn gateway(
    credentials: &Credentials,
    cp: &str,
    directory: &Path,
    state: &str,
    tag: &str,
    mock: &MockSlack,
) -> Result<(Process, String, String)> {
    let mut command = credentials.command(&[
        "gateway",
        "--control-plane",
        cp,
        "--slack-listen",
        "127.0.0.1:0",
        "--slack-state-directory",
    ]);
    command
        .arg(directory.join(state))
        .env("SUPERTAG_SLACK_ACCOUNT_ID", ACCOUNT)
        .env("SUPERTAG_SLACK_TEAM_ID", TEAM)
        .env("SUPERTAG_SLACK_CHANNEL_ID", CHANNEL)
        .env("SUPERTAG_SLACK_TAG_ID", tag)
        .env("SUPERTAG_SLACK_ALLOWED_USERS", "UALICE1,UBOB1")
        .env("SUPERTAG_SLACK_SIGNING_SECRET", SIGNING)
        .env("SUPERTAG_SLACK_BOT_TOKEN", BOT)
        .env("SUPERTAG_TEST_SLACK_API_URL", &mock.endpoint);
    let mut process = Process::spawn(command, directory, state)?;
    let endpoints = process.endpoints(2).await?;
    // Operators and Worker Hosts use the Control Plane; the Gateway serves only its surface.
    Ok((process, cp.to_owned(), endpoints[1].clone()))
}

fn payload(id: &str, ts: &str, mention: bool, prompt: &str) -> Value {
    json!({"type":"event_callback","team_id":TEAM,"event_id":id,"event":{"type":if mention { "app_mention" } else { "message" },"channel":CHANNEL,"user":"UALICE1","text":prompt,"ts":ts,"thread_ts":THREAD}})
}

async fn signed(endpoint: &str, payload: &Value) -> Result<reqwest::StatusCode> {
    let body = payload.to_string();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_secs()
        .to_string();
    let mut mac = Hmac::<Sha256>::new_from_slice(SIGNING.as_bytes())?;
    mac.update(format!("v0:{timestamp}:{body}").as_bytes());
    Ok(reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()?
        .post(format!("{endpoint}/slack/events"))
        .header("content-type", "application/json")
        .header("x-slack-request-timestamp", timestamp)
        .header(
            "x-slack-signature",
            format!("v0={:x}", mac.finalize().into_bytes()),
        )
        .body(body)
        .send()
        .await?
        .status())
}

async fn receipt(
    client: &mut ConnectorClient<ProtocolChannel>,
    credentials: &Credentials,
    payload: &Value,
) -> Result<Task> {
    let event = &payload["event"];
    let input = AcceptSlackEventRequest {
        account_id: ACCOUNT.into(),
        event_id: payload["event_id"].as_str().unwrap().into(),
        team_id: TEAM.into(),
        channel_id: CHANNEL.into(),
        message_ts: event["ts"].as_str().unwrap().into(),
        thread_ts: event["thread_ts"].as_str().unwrap().into(),
        prompt: event["text"].as_str().unwrap().into(),
        mention_tag_id: (event["type"] == "app_mention").then(|| "builder".into()),
        actor_id: event["user"].as_str().unwrap().into(),
    };
    client
        .accept_slack_event(credentials.connector(input)?)
        .await?
        .into_inner()
        .task
        .context("signed event was not accepted")
}

async fn task_count(database: &str) -> Result<i64> {
    let mut connection = database::connect(database).await?;
    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_tasks")
        .fetch_one(&mut connection)
        .await?)
}

async fn execute(
    credentials: &Credentials,
    directory: &Path,
    gateway: &str,
    name: &str,
    task: &Task,
    database: &str,
) -> Result<()> {
    let mut command = credentials.command(&[
        "worker-host",
        "--control-plane",
        gateway,
        "--adapter",
        ADAPTER,
        "--once",
        "--state-directory",
    ]);
    command.arg(directory.join(name));
    Process::spawn(command, directory, name)?.success().await?;
    let mut operator = OperatorClient::new(protocol::dial(gateway.to_owned()).await?);
    let completed = operator
        .get_task(credentials.operator(GetTaskRequest {
            task_id: task.task_id.clone(),
        })?)
        .await?
        .into_inner();
    assert_eq!(completed.state(), TaskState::Succeeded);
    assert_eq!(
        completed.result.as_deref(),
        Some(format!("Original Tag: {} [files:read]", task.prompt).as_str())
    );
    let mut connection = database::connect(database).await?;
    let deadline = Instant::now() + WAIT;
    loop {
        let state: Option<i64> =
            sqlx::query_scalar("SELECT state FROM supertag_v2_replies WHERE task_id=$1")
                .bind(&task.task_id)
                .fetch_optional(&mut connection)
                .await?;
        if state == Some(ReplyState::Delivered as i64) {
            return Ok(());
        }
        ensure!(
            Instant::now() < deadline,
            "Slack reply did not settle as delivered"
        );
        sleep(Duration::from_millis(10)).await;
    }
}

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    signed_thread_replies_survive_restart_and_deduplicate_across_two_gateways;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    signed_slack_artifact_context_pins_catalog_and_bytes_across_threads;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    drain_hands_connector_to_second_gateway;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    slack_thread_starts_and_steers_an_objective;
}

async fn signed_thread_replies_survive_restart_and_deduplicate_across_two_gateways(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let credentials = Credentials::new();
    let mock = MockSlack::start().await?;
    let mut command = credentials.command(&["control-plane"]);
    command.env("SUPERTAG_DATABASE_URL", &database);
    let mut cp = Process::spawn(command, directory.path(), "cp")?;
    let private = cp.endpoints(1).await?.remove(0);
    let (mut first, public, http) = gateway(
        &credentials,
        &private,
        directory.path(),
        "first-gateway",
        "builder",
        &mock,
    )
    .await?;
    let mut operator = OperatorClient::new(protocol::dial(public.clone()).await?);
    for (tag, instructions) in [("builder", "Original Tag"), ("another", "Wrong Tag")] {
        operator
            .put_tag(credentials.operator(PutTagRequest {
                name: None,
                expected_revision: None,
                execution: None,
                approval_rules: vec![],
                tag_id: tag.into(),
                instructions: instructions.into(),
                allowed_actions: vec!["files:read".into()],
                workspace: None,
                harness_kind: 0,
            })?)
            .await?;
    }
    let mut reply = payload(
        "EvREPLY1",
        "1794470001.100000",
        false,
        "Continue with option A",
    );
    reply["event"]["user"] = "UBOB1".into();
    assert_eq!(signed(&http, &reply).await?, reqwest::StatusCode::OK);
    assert_eq!(
        task_count(&database).await?,
        0,
        "pre-activation reply must be ignored"
    );
    let mention = payload("EvMENTION1", THREAD, true, "Inspect the fixture");
    assert_eq!(signed(&http, &mention).await?, reqwest::StatusCode::OK);
    let mut connector = ConnectorClient::new(protocol::dial(private.clone()).await?);
    let initial = receipt(&mut connector, &credentials, &mention).await?;
    execute(
        &credentials,
        directory.path(),
        &public,
        "host-one",
        &initial,
        &database,
    )
    .await?;
    let one = delivered_final(&mock, 1).await?;
    first.stop().await?;
    let (mut restarted, public, http) = gateway(
        &credentials,
        &private,
        directory.path(),
        "first-gateway",
        "builder",
        &mock,
    )
    .await?;
    // The second Gateway has a different default. An unmentioned reply must use
    // the durable thread's original Tag, never this Gateway's default or memory.
    let (mut second, second_public, second_http) = gateway(
        &credentials,
        &private,
        directory.path(),
        "second-gateway",
        "another",
        &mock,
    )
    .await?;
    let (left, right) = tokio::join!(signed(&http, &reply), signed(&second_http, &reply));
    assert_eq!(left?, reqwest::StatusCode::OK);
    assert_eq!(right?, reqwest::StatusCode::OK);
    let followup = receipt(&mut connector, &credentials, &reply).await?;
    assert_eq!(followup.tag_id, initial.tag_id);
    assert_eq!(followup.session_id, initial.session_id);
    assert_ne!(followup.task_id, initial.task_id);
    let mut twin = reply.clone();
    twin["event_id"] = "EvMENTIONTWIN".into();
    twin["event"]["type"] = "app_mention".into();
    assert_eq!(signed(&http, &twin).await?, reqwest::StatusCode::OK);
    assert_eq!(
        receipt(&mut connector, &credentials, &twin).await?.task_id,
        followup.task_id
    );
    let mut conflict = reply.clone();
    conflict["event"]["text"] = "Changed provider content".into();
    assert_eq!(
        signed(&second_http, &conflict).await?,
        reqwest::StatusCode::CONFLICT
    );
    for (field, value) in [
        ("bot_id", json!("BBOT1")),
        ("user", json!("UMALLORY1")),
        ("subtype", json!("message_changed")),
        ("thread_ts", json!("1794470099.100000")),
        ("thread_ts", Value::Null),
    ] {
        let mut ignored = payload(
            "EvIGNORED",
            "1794470009.100000",
            false,
            "Must not create work",
        );
        ignored["event"][field] = value;
        assert_eq!(
            signed(&second_http, &ignored).await?,
            reqwest::StatusCode::OK
        );
    }
    assert_eq!(task_count(&database).await?, 2);
    execute(
        &credentials,
        directory.path(),
        &second_public,
        "host-two",
        &followup,
        &database,
    )
    .await?;
    let two = delivered_final(&mock, 2).await?;
    let next = payload("EvMENTION2", "1794470002.100000", true, "Verify the result");
    assert_eq!(signed(&http, &next).await?, reqwest::StatusCode::OK);
    let next = receipt(&mut connector, &credentials, &next).await?;
    assert_eq!(next.session_id, initial.session_id);
    execute(
        &credentials,
        directory.path(),
        &public,
        "host-three",
        &next,
        &database,
    )
    .await?;
    let three = delivered_final(&mock, 3).await?;
    assert_eq!(signed(&second_http, &reply).await?, reqwest::StatusCode::OK);
    assert_eq!(task_count(&database).await?, 3);
    restarted.stop().await?;
    second.stop().await?;
    cp.stop().await?;
    let requests = mock.requests.lock().await;
    assert_eq!(
        requests.len(),
        three + 1,
        "nothing is sent after the last final reply"
    );
    // Each logical message is one segment: at most one acknowledgement, even when both
    // Gateways received it, then exactly one final answer. Whether the acknowledgement is
    // sent races the fixture Task finishing; when it is, the final replaces it in place.
    for (start, end) in [(0, one), (one + 1, two), (two + 1, three)] {
        let acknowledgements: Vec<_> = (start..end)
            .filter(|index| requests[*index].1["text"] == ACKNOWLEDGEMENT)
            .collect();
        assert_eq!(
            end - start,
            acknowledgements.len(),
            "only acknowledgements precede a final reply"
        );
        assert!(acknowledgements.len() <= 1, "duplicate acknowledgement");
        let (path, request) = &requests[end];
        assert_eq!(request["channel"], CHANNEL);
        assert!(
            request["text"]
                .as_str()
                .unwrap()
                .starts_with("Original Tag:")
        );
        match acknowledgements.first() {
            Some(index) => {
                assert_eq!(requests[*index].0, "/chat.postMessage");
                assert_eq!(requests[*index].1["thread_ts"], THREAD);
                assert_eq!(path, "/chat.update");
                assert_eq!(request["ts"], format!("1794470100.{:06}", index + 1));
            }
            None => {
                assert_eq!(path, "/chat.postMessage");
                assert_eq!(request["thread_ts"], THREAD);
            }
        }
    }
    Ok(())
}

async fn signed_slack_artifact_context_pins_catalog_and_bytes_across_threads(
    database: String,
) -> Result<()> {
    use sha2::Digest;
    use supertag_protocol::{HOST_GENERATION_HEADER, v2::*};
    let directory = tempfile::tempdir()?;
    let credentials = Credentials::new();
    let mock = MockSlack::start().await?;
    let mut command = credentials.command(&["control-plane"]);
    command
        .env("SUPERTAG_DATABASE_URL", &database)
        .arg("--transfer-directory")
        .arg(directory.path().join("cas"));
    let mut cp = Process::spawn(command, directory.path(), "context-cp")?;
    let private = cp.endpoints(1).await?.remove(0);
    let mut command = credentials.command(&[
        "gateway",
        "--control-plane",
        &private,
        "--slack-listen",
        "127.0.0.1:0",
        "--slack-state-directory",
    ]);
    command
        .arg(directory.path().join("slack"))
        .env("SUPERTAG_SLACK_ACCOUNT_ID", ACCOUNT)
        .env("SUPERTAG_SLACK_TEAM_ID", TEAM)
        .env("SUPERTAG_SLACK_CHANNEL_ID", CHANNEL)
        .env("SUPERTAG_SLACK_TAG_ID", "builder")
        .env("SUPERTAG_SLACK_ALLOWED_USERS", "UALICE1")
        .env("SUPERTAG_SLACK_SIGNING_SECRET", SIGNING)
        .env("SUPERTAG_SLACK_BOT_TOKEN", BOT)
        .env("SUPERTAG_TEST_SLACK_API_URL", &mock.endpoint);
    let mut gateway = Process::spawn(command, directory.path(), "context-gateway")?;
    let endpoints = gateway.endpoints(2).await?;
    let (public, http) = (&private, &endpoints[1]);
    let channel =
        protocol::negotiated(Channel::from_shared(public.clone())?.connect().await?).await?;
    let mut operator = OperatorClient::new(channel.clone());
    operator
        .put_tag(credentials.operator(PutTagRequest {
            tag_id: "builder".into(),
            instructions: "Use admitted context".into(),
            allowed_actions: vec!["files:read".into()],
            ..Default::default()
        })?)
        .await?;
    let mut surfaces =
        surface_policy_catalog_client::SurfacePolicyCatalogClient::new(channel.clone());
    surfaces
        .put_surface_account(credentials.operator(PutSurfaceAccountRequest {
            operation_id: "account".into(),
            account: Some(SurfaceAccount {
                account_id: "slack-context".into(),
                identity: Some(SurfaceAccountIdentity {
                    provider: Some(surface_account_identity::Provider::Slack(
                        SlackSurfaceIdentity {
                            team_id: TEAM.into(),
                        },
                    )),
                }),
                enabled: true,
                gateway: "local".into(),
                ..Default::default()
            }),
            ..Default::default()
        })?)
        .await?;
    let location = SurfaceLocation {
        location_id: "context-source".into(),
        account_id: "slack-context".into(),
        connector_account_id: ACCOUNT.into(),
        scope: Some(SurfaceLocationScope {
            provider: Some(surface_location_scope::Provider::Slack(
                SlackSurfaceChannel {
                    channel_id: CHANNEL.into(),
                },
            )),
        }),
        tag_id: "builder".into(),
        enabled: true,
        ..Default::default()
    };
    surfaces
        .put_surface_location(credentials.operator(PutSurfaceLocationRequest {
            operation_id: "location".into(),
            location: Some(location.clone()),
            ..Default::default()
        })?)
        .await?;
    let first = payload("EvCONTEXT1", THREAD, true, "Capture shared evidence");
    assert_eq!(signed(http, &first).await?, reqwest::StatusCode::OK);
    let mut connector = ConnectorClient::new(protocol::dial(private).await?);
    let source = receipt(&mut connector, &credentials, &first).await?;
    let mut host = worker_host_client::WorkerHostClient::new(channel.clone());
    let registered = host
        .register_host(authenticated_request(
            RegisterHostRequest {
                incarnation_id: "context-host".into(),
            },
            &credentials.host,
            None,
        )?)
        .await?
        .into_inner();
    let auth = |value| {
        let mut request = authenticated_request(value, &credentials.host, None).unwrap();
        request.metadata_mut().insert(
            HOST_GENERATION_HEADER,
            registered.generation.to_string().parse().unwrap(),
        );
        request
    };
    let claim = host
        .claim_task(auth(ClaimTaskRequest {
            operation_id: "capture".into(),
            ..Default::default()
        }))
        .await?
        .into_inner()
        .assignment
        .context("missing source claim")?;
    assert_eq!(claim.task.as_ref().unwrap().task_id, source.task_id);
    fn host_request<T>(input: T, credentials: &Credentials, generation: u64) -> Result<Request<T>> {
        let mut request = authenticated_request(input, &credentials.host, None)?;
        request
            .metadata_mut()
            .insert(HOST_GENERATION_HEADER, generation.to_string().parse()?);
        Ok(request)
    }
    let attempt = InspectAttemptRequest {
        task_id: source.task_id.clone(),
        attempt_id: claim.attempt_id,
        lease_token: claim.lease_token,
    };
    host.start_task(host_request(
        StartTaskRequest {
            task_id: attempt.task_id.clone(),
            attempt_id: attempt.attempt_id.clone(),
            lease_token: attempt.lease_token.clone(),
        },
        &credentials,
        registered.generation,
    )?)
    .await?;
    let bytes = b"source evidence\n".to_vec();
    let blob = BlobReference {
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        byte_length: bytes.len() as u64,
    };
    let mut transfers = artifact_transfers_client::ArtifactTransfersClient::new(channel.clone());
    let captured = transfers
        .upload_capture(host_request(
            tokio_stream::iter(vec![
                ArtifactUpload {
                    part: Some(artifact_upload::Part::Begin(CommitArtifactCaptureRequest {
                        attempt: Some(attempt.clone()),
                        operation_id: "capture".into(),
                        description: Some(ArtifactDescription {
                            title: "Prior shared evidence".into(),
                            kind: "report".into(),
                            summary: Some("Frozen source result".into()),
                        }),
                        files: vec![ArtifactFile {
                            path: "report.txt".into(),
                            blob: Some(blob.clone()),
                            ..Default::default()
                        }],
                        ..Default::default()
                    })),
                },
                ArtifactUpload {
                    part: Some(artifact_upload::Part::Chunk(ArtifactChunk {
                        file_index: 0,
                        data: bytes.clone(),
                    })),
                },
            ]),
            &credentials,
            registered.generation,
        )?)
        .await?
        .into_inner();
    let artifact = captured.summary.context("missing summary")?.artifact_id;
    host.finish_task(host_request(
        FinishTaskRequest {
            task_id: attempt.task_id,
            attempt_id: attempt.attempt_id,
            lease_token: attempt.lease_token,
            succeeded: true,
            result: "Captured evidence".into(),
            ..Default::default()
        },
        &credentials,
        registered.generation,
    )?)
    .await?;
    let mut policy = policy_catalog_client::PolicyCatalogClient::new(channel.clone());
    policy.put_context_set(credentials.operator(PutContextSetRequest{operation_id:"context".into(),context_set:Some(ContextSet{set_id:"prior".into(),name:"Prior work".into(),items:vec![PolicyContextItem{item_key:"research".into(),r#type:"supertag/artifacts".into(),version:1,required:true,config_json:r#"{"sourceRouteId":"context-source","selection":{"match":"shared-resource","maxAgeDays":30,"limit":5}}"#.into(),..Default::default()}],..Default::default()}),..Default::default()})?).await?;
    surfaces
        .put_surface_location(credentials.operator(PutSurfaceLocationRequest {
            operation_id: "activate".into(),
            location: Some(SurfaceLocation {
                context_set_ids: vec!["prior".into()],
                ..location
            }),
            expected_revision: Some(1),
        })?)
        .await?;
    let mut next = payload(
        "EvCONTEXT2",
        "1794470001.100001",
        true,
        "Find prior evidence",
    );
    next["event"]["thread_ts"] = "1794470001.100001".into();
    assert_eq!(signed(http, &next).await?, reqwest::StatusCode::OK);
    let consumer = receipt(&mut connector, &credentials, &next).await?;
    assert!(consumer.instructions.contains("<supertag-artifacts>"));
    assert_eq!(
        consumer.policy_snapshot.as_ref().unwrap().context_sets[0].items[0]
            .artifact_snapshot
            .as_ref()
            .unwrap()
            .artifacts[0]
            .artifact_id,
        artifact
    );
    let claim = host
        .claim_task(auth(ClaimTaskRequest {
            operation_id: "consume".into(),
            ..Default::default()
        }))
        .await?
        .into_inner()
        .assignment
        .context("missing consumer claim")?;
    assert_eq!(claim.task.as_ref().unwrap().task_id, consumer.task_id);
    let attempt = InspectAttemptRequest {
        task_id: consumer.task_id,
        attempt_id: claim.attempt_id,
        lease_token: claim.lease_token,
    };
    host.start_task(host_request(
        StartTaskRequest {
            task_id: attempt.task_id.clone(),
            attempt_id: attempt.attempt_id.clone(),
            lease_token: attempt.lease_token.clone(),
        },
        &credentials,
        registered.generation,
    )?)
    .await?;
    let mut acquisitions = attempt_artifacts_client::AttemptArtifactsClient::new(channel);
    let acquired = acquisitions
        .acquire(host_request(
            AcquireArtifactRequest {
                attempt: Some(attempt.clone()),
                operation_id: "read".into(),
                artifact_id: artifact,
                paths: vec!["report.txt".into()],
                delivery: ArtifactDelivery::Read as i32,
                destination: None,
            },
            &credentials,
            registered.generation,
        )?)
        .await?
        .into_inner();
    let mut stream = transfers
        .download_acquired_file(host_request(
            GetAcquiredArtifactFileRequest {
                attempt: Some(attempt),
                acquisition_id: acquired.acquisition_id,
                path: "report.txt".into(),
            },
            &credentials,
            registered.generation,
        )?)
        .await?
        .into_inner();
    let mut received = Vec::new();
    while let Some(part) = stream.message().await? {
        if let Some(artifact_download::Part::Chunk(chunk)) = part.part {
            received.extend(chunk)
        }
    }
    assert_eq!(received, bytes);
    gateway.stop().await?;
    cp.stop().await?;
    Ok(())
}

/// Inspects the Control Plane database of one process test case.
struct Database {
    url: String,
}

impl Database {
    async fn connect(&self) -> Result<sqlx::AnyConnection> {
        database::connect(&self.url).await
    }

    async fn reply(&self, task: &str) -> Result<Option<(i64, Option<String>)>> {
        let mut connection = self.connect().await?;
        let row =
            sqlx::query("SELECT state, provider_receipt FROM supertag_v2_replies WHERE task_id=$1")
                .bind(task)
                .fetch_optional(&mut connection)
                .await?;
        connection.close().await?;
        use sqlx::Row;
        Ok(match row {
            Some(row) => Some((row.try_get("state")?, row.try_get("provider_receipt")?)),
            None => None,
        })
    }

    async fn delivered(&self, task: &str) -> Result<()> {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some((state, receipt)) = self.reply(task).await? {
                if state == ReplyState::Delivered as i64 {
                    ensure!(receipt.is_some(), "delivered reply has no provider receipt");
                    return Ok(());
                }
                ensure!(
                    state == ReplyState::Pending as i64 || state == ReplyState::Claimed as i64,
                    "reply settled as {state}, not delivered"
                );
            }
            ensure!(Instant::now() < deadline, "Slack reply was not delivered");
            sleep(Duration::from_millis(20)).await;
        }
    }

    async fn owner(&self) -> Result<Option<String>> {
        let mut connection = self.connect().await?;
        let owner = sqlx::query_scalar(
            "SELECT owner_id FROM supertag_v2_connector_leases WHERE account_id=$1 AND expires_at_ms>0",
        )
        .bind(ACCOUNT)
        .fetch_optional(&mut connection)
        .await?;
        connection.close().await?;
        Ok(owner)
    }

    async fn await_owner(&self, owner: &str, within: Duration) -> Result<()> {
        let deadline = Instant::now() + within;
        while self.owner().await?.as_deref() != Some(owner) {
            ensure!(
                Instant::now() < deadline,
                "connector ownership did not move to {owner}"
            );
            sleep(Duration::from_millis(20)).await;
        }
        Ok(())
    }
}

fn owner_id(directory: &Path, state: &str) -> Result<String> {
    Ok(
        std::fs::read_to_string(directory.join(state).join("connector-owner"))?
            .trim()
            .to_owned(),
    )
}

async fn put_builder(credentials: &Credentials, public: &str) -> Result<()> {
    OperatorClient::new(protocol::dial(public.to_owned()).await?)
        .put_tag(credentials.operator(PutTagRequest {
            tag_id: "builder".into(),
            instructions: "Original Tag".into(),
            allowed_actions: vec!["files:read".into()],
            ..Default::default()
        })?)
        .await?;
    Ok(())
}

async fn run_host(
    credentials: &Credentials,
    directory: &Path,
    gateway: &str,
    name: &str,
    task: &Task,
) -> Result<Task> {
    // An Objective may queue its own owner turns ahead of this one; run them too.
    for _ in 0..4 {
        let mut command = credentials.command(&[
            "worker-host",
            "--control-plane",
            gateway,
            "--adapter",
            ADAPTER,
            "--once",
            "--state-directory",
        ]);
        command.arg(directory.join(name));
        Process::spawn(command, directory, name)?.success().await?;
        let completed = OperatorClient::new(protocol::dial(gateway.to_owned()).await?)
            .get_task(credentials.operator(GetTaskRequest {
                task_id: task.task_id.clone(),
            })?)
            .await?
            .into_inner();
        if completed.state() == TaskState::Succeeded {
            return Ok(completed);
        }
    }
    anyhow::bail!("Task did not succeed")
}

async fn control_plane(
    credentials: &Credentials,
    directory: &Path,
    database: &Database,
) -> Result<(Process, String)> {
    let mut command = credentials.command(&["control-plane"]);
    command.env("SUPERTAG_DATABASE_URL", &database.url);
    let mut cp = Process::spawn(command, directory, "cp")?;
    let private = cp.endpoints(1).await?.remove(0);
    Ok((cp, private))
}

/// TS `tests/gateway-drain.test.ts`, across processes: a draining Gateway refuses
/// new provider events, finishes the reply it is sending, settles it, and hands
/// connector ownership to a second Gateway, which delivers the next reply. No
/// reply is lost, repeated, or left uncertain.
async fn drain_hands_connector_to_second_gateway(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let directory = directory.path();
    let database = Database { url: database };
    let credentials = Credentials::new();
    let (mut cp, private) = control_plane(&credentials, directory, &database).await?;
    let held = MockSlack::start_held().await?;
    let standby = MockSlack::start().await?;
    let (mut first, first_public, first_http) = gateway(
        &credentials,
        &private,
        directory,
        "gateway-a",
        "builder",
        &held,
    )
    .await?;
    let first_owner = owner_id(directory, "gateway-a")?;
    database.await_owner(&first_owner, WAIT).await?;
    let (mut second, second_public, second_http) = gateway(
        &credentials,
        &private,
        directory,
        "gateway-b",
        "builder",
        &standby,
    )
    .await?;
    let second_owner = owner_id(directory, "gateway-b")?;
    assert_ne!(first_owner, second_owner);
    put_builder(&credentials, &first_public).await?;

    // Ingress is stateless: the standby Gateway accepts the event, and the owner delivers.
    let mention = payload("EvDRAIN1", THREAD, true, "Inspect before the drain");
    assert_eq!(
        signed(&second_http, &mention).await?,
        reqwest::StatusCode::OK
    );
    let mut connector = ConnectorClient::new(protocol::dial(private.clone()).await?);
    let first_task = receipt(&mut connector, &credentials, &mention).await?;
    run_host(
        &credentials,
        directory,
        &second_public,
        "host-one",
        &first_task,
    )
    .await?;
    // The owner acknowledges the mention first; let that through and hold the final reply.
    // Exactly one permit: a permit added on every poll would let the final post through too.
    let deadline = Instant::now() + WAIT;
    let mut acknowledged = false;
    loop {
        let requests = held.requests.lock().await;
        match requests.last() {
            Some((_, body)) if body["text"] != ACKNOWLEDGEMENT => break,
            Some(_) if requests.len() == 1 && !acknowledged => {
                held.gate.add_permits(1);
                acknowledged = true;
            }
            _ => {}
        }
        drop(requests);
        ensure!(Instant::now() < deadline, "owner did not start sending");
        sleep(Duration::from_millis(10)).await;
    }
    // The owner's final post is in flight. Begin draining it.
    ensure!(unsafe { libc::kill(first.child.id() as i32, libc::SIGTERM) } == 0);
    let challenge = json!({"type":"url_verification","challenge":"drain-probe"});
    let deadline = Instant::now() + WAIT;
    loop {
        match signed(&first_http, &challenge).await {
            Ok(status) if status == reqwest::StatusCode::OK => {}
            Ok(status) => {
                assert_eq!(status, reqwest::StatusCode::SERVICE_UNAVAILABLE);
                break;
            }
            // A listener that stopped accepting also refuses new ingress.
            Err(_) => break,
        }
        ensure!(Instant::now() < deadline, "drain did not refuse ingress");
        sleep(Duration::from_millis(10)).await;
    }
    let refused = payload(
        "EvDRAINREFUSED",
        "1794470001.100000",
        true,
        "Arrives while draining",
    );
    ensure!(
        !matches!(
            signed(&first_http, &refused).await,
            Ok(reqwest::StatusCode::OK)
        ),
        "draining Gateway accepted a new provider event"
    );
    // The in-flight post is neither abandoned nor taken over while it is sent.
    sleep(Duration::from_millis(300)).await;
    assert_eq!(
        database
            .reply(&first_task.task_id)
            .await?
            .map(|(state, _)| state),
        Some(ReplyState::Claimed as i64)
    );
    assert!(standby.requests.lock().await.is_empty());
    held.release();
    first.success().await?;
    database.delivered(&first_task.task_id).await?;
    ensure!(
        !directory.join("gateway-a/reply.json").exists(),
        "drained Gateway left an unsettled delivery"
    );
    // Release, not lease expiry, hands the account over.
    database
        .await_owner(&second_owner, Duration::from_secs(5))
        .await?;

    // The provider retries the refused event at the remaining Gateway.
    assert_eq!(
        signed(&second_http, &refused).await?,
        reqwest::StatusCode::OK
    );
    let second_task = receipt(&mut connector, &credentials, &refused).await?;
    assert_eq!(second_task.session_id, first_task.session_id);
    run_host(
        &credentials,
        directory,
        &second_public,
        "host-two",
        &second_task,
    )
    .await?;
    database.delivered(&second_task.task_id).await?;
    second.stop().await?;
    cp.stop().await?;
    // Each Gateway sent one final reply, after at most one acknowledgement it replaced.
    for mock in [&held, &standby] {
        let requests = mock.requests.lock().await;
        let finals = requests
            .iter()
            .filter(|(_, body)| body["text"] != ACKNOWLEDGEMENT)
            .count();
        assert_eq!(finals, 1, "{requests:?}");
        assert!(requests.len() <= 2, "{requests:?}");
        for (path, body) in requests.iter() {
            if path != "/chat.update" {
                assert_eq!(body["thread_ts"], THREAD);
            }
        }
    }
    let mut connection = database.connect().await?;
    let unsettled: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_replies WHERE state<>$1")
            .bind(ReplyState::Delivered as i64)
            .fetch_one(&mut connection)
            .await?;
    connection.close().await?;
    assert_eq!(unsettled, 0);
    Ok(())
}

/// TS `tests/objective-surface-execution.test.ts` over signed Slack webhooks: an
/// explicit invocation starts an Objective whose turns answer in the thread, a
/// plain thread reply is its next turn, and `pause` answers in the thread.
async fn slack_thread_starts_and_steers_an_objective(database: String) -> Result<()> {
    use supertag_protocol::v2::{ListObjectivesRequest, objectives_client::ObjectivesClient};
    let directory = tempfile::tempdir()?;
    let directory = directory.path();
    let database = Database { url: database };
    let credentials = Credentials::new();
    let (mut cp, private) = control_plane(&credentials, directory, &database).await?;
    let mock = MockSlack::start().await?;
    let (mut gateway, public, http) = gateway(
        &credentials,
        &private,
        directory,
        "gateway",
        "builder",
        &mock,
    )
    .await?;
    put_builder(&credentials, &public).await?;
    let mut connector = ConnectorClient::new(protocol::dial(private.clone()).await?);

    let start = payload(
        "EvOBJECTIVE",
        THREAD,
        true,
        "<@UBOT1> objective Validate the fixture",
    );
    assert_eq!(signed(&http, &start).await?, reqwest::StatusCode::OK);
    let starting = receipt(&mut connector, &credentials, &start).await?;
    let objectives = ObjectivesClient::new(protocol::dial(public.clone()).await?)
        .list_objectives(credentials.operator(ListObjectivesRequest::default())?)
        .await?
        .into_inner()
        .objectives;
    assert_eq!(objectives.len(), 1);
    let objective = &objectives[0];
    assert_eq!(objective.outcome, "Validate the fixture");
    assert_eq!(objective.starting_task_id, starting.task_id);
    assert!(!starting.session_id.starts_with("slack:"));
    let completed = run_host(&credentials, directory, &public, "host-start", &starting).await?;
    assert!(
        completed
            .result
            .as_deref()
            .is_some_and(|result| result.contains("Validate the fixture"))
    );
    database.delivered(&starting.task_id).await?;

    let mut steer = payload(
        "EvSTEER",
        "1794470001.100000",
        false,
        "Focus on solo practices instead",
    );
    steer["event"]["user"] = "UBOB1".into();
    assert_eq!(signed(&http, &steer).await?, reqwest::StatusCode::OK);
    let turn = receipt(&mut connector, &credentials, &steer).await?;
    assert_eq!(turn.session_id, starting.session_id);
    run_host(&credentials, directory, &public, "host-steer", &turn).await?;
    database.delivered(&turn.task_id).await?;

    let pause = payload("EvPAUSE", "1794470002.100000", true, "<@UBOT1> pause");
    assert_eq!(signed(&http, &pause).await?, reqwest::StatusCode::OK);
    let answered = receipt(&mut connector, &credentials, &pause).await?;
    assert_eq!(answered.state(), TaskState::Succeeded);
    database.delivered(&answered.task_id).await?;
    gateway.stop().await?;
    cp.stop().await?;
    let requests = mock.requests.lock().await;
    // The starting turn, any owner turns it queued, the steering turn, and the pause.
    assert!(requests.len() >= 3);
    // Posts answer in the thread; updates replace an acknowledgement posted there.
    for (path, body) in requests.iter() {
        if path != "/chat.update" {
            assert_eq!(body["thread_ts"], THREAD);
        }
    }
    let paused = format!("Paused. Objective {}", objective.objective_id);
    assert!(
        requests
            .iter()
            .any(|(_, body)| body["text"].as_str().unwrap().starts_with(&paused)),
        "{requests:?}"
    );
    drop(requests);
    Ok(())
}
