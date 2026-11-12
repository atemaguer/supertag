//! Signed HTTP Slack ingress through separate CP/Gateway/Host processes.
//! Every provider interaction terminates at this test's loopback HTTP server.
use std::{
    fs::File,
    io::{BufRead, BufReader},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, mpsc},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, ensure};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use sqlx::Connection;
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
            gateway: Uuid::new_v4().to_string(),
            operator: Uuid::new_v4().to_string(),
            host: Uuid::new_v4().to_string(),
        }
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(BINARY);
        command
            .args(args)
            .env_clear()
            .stdin(Stdio::null())
            .env("SUPERTAG_GATEWAY_TOKEN", &self.gateway)
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
    let mut request = authenticated_request(input, token, principal)?;
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
    requests: Arc<Mutex<Vec<Value>>>,
    server: tokio::task::JoinHandle<Result<()>>,
}

impl MockSlack {
    async fn start() -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = format!("http://{}/chat.postMessage", listener.local_addr()?);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let observed = requests.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut connection, _) = listener.accept().await?;
                let request =
                    tokio::time::timeout(Duration::from_secs(5), mock_request(&mut connection))
                        .await??;
                let mut requests = observed.lock().await;
                requests.push(request);
                let body = json!({"ok":true,"channel":CHANNEL,"ts":format!("1794470100.{:06}",requests.len())}).to_string();
                drop(requests);
                connection.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await?;
                connection.shutdown().await?;
            }
        });
        Ok(Self {
            endpoint,
            requests,
            server,
        })
    }
}

impl Drop for MockSlack {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn mock_request(stream: &mut TcpStream) -> Result<Value> {
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
    ensure!(headers.starts_with("POST /chat.postMessage HTTP/1.1\r\n"));
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
    Ok(serde_json::from_slice(&bytes[end..end + length])?)
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
    Ok((process, endpoints[0].clone(), endpoints[1].clone()))
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
    client: &mut ConnectorClient<Channel>,
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
    };
    client
        .accept_slack_event(credentials.connector(input)?)
        .await?
        .into_inner()
        .task
        .context("signed event was not accepted")
}

async fn task_count(database: &str) -> Result<i64> {
    let mut connection = sqlx::SqliteConnection::connect(database).await?;
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
        "--gateway",
        gateway,
        "--adapter",
        ADAPTER,
        "--once",
        "--state-directory",
    ]);
    command.arg(directory.join(name));
    Process::spawn(command, directory, name)?.success().await?;
    let mut operator = OperatorClient::connect(gateway.to_owned()).await?;
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
    let mut connection = sqlx::SqliteConnection::connect(database).await?;
    let deadline = Instant::now() + WAIT;
    loop {
        let state: Option<i64> =
            sqlx::query_scalar("SELECT state FROM supertag_v2_replies WHERE task_id=?")
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn signed_thread_replies_survive_restart_and_deduplicate_across_two_gateways() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let database = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("slack.db").display()
    );
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
    let mut operator = OperatorClient::connect(public.clone()).await?;
    for (tag, instructions) in [("builder", "Original Tag"), ("another", "Wrong Tag")] {
        operator
            .put_tag(credentials.operator(PutTagRequest {
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
    let mut connector = ConnectorClient::connect(private.clone()).await?;
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
    assert_eq!(signed(&second_http, &reply).await?, reqwest::StatusCode::OK);
    assert_eq!(task_count(&database).await?, 3);
    restarted.stop().await?;
    second.stop().await?;
    cp.stop().await?;
    let requests = mock.requests.lock().await;
    assert_eq!(
        requests.len(),
        3,
        "one provider response per accepted logical message"
    );
    for request in requests.iter() {
        assert_eq!(request["channel"], CHANNEL);
        assert_eq!(request["thread_ts"], THREAD);
        assert!(
            request["text"]
                .as_str()
                .unwrap()
                .starts_with("Original Tag:")
        );
    }
    Ok(())
}
