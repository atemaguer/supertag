//! Slack Socket Mode ingress through separate CP/Gateway/Host processes.
//! Every provider interaction terminates at this test's loopback fake Slack: its Web API
//! (`apps.connections.open`, `chat.postMessage`, `chat.update`) and its Socket Mode WebSocket.
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
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use anyhow::{Context, Result, ensure};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
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
    sync::{Mutex, mpsc as channel},
    time::sleep,
};
use tokio_tungstenite::{accept_async, tungstenite::Message as WsMessage};
use tonic::Request;
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(20);
const ACCOUNT: &str = "slack-socket-test";
const TEAM: &str = "TTEAM1";
const CHANNEL: &str = "CCHANNEL1";
const THREAD: &str = "1794470000.100000";
const APP_TOKEN: &str = "xapp-synthetic-socket-mode-token";
const BOT: &str = "xoxb-synthetic-socket-mode-token";
/// Longer than the Gateway's admission deadline, so a missing acknowledgement is final.
const NO_ACK: Duration = Duration::from_secs(4);

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
        let mut request = authenticated_request(input, &self.operator, None)?;
        request.set_timeout(Duration::from_secs(3));
        Ok(request)
    }
    fn connector<T>(&self, input: T) -> Result<Request<T>> {
        let mut request = supertag_protocol::connector_request(input, &self.gateway, ACCOUNT)?;
        request.set_timeout(Duration::from_secs(3));
        Ok(request)
    }
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
    /// Waits for the process to fail with `expected` in its log, without leaking a token.
    async fn failed(&mut self, expected: &str) -> Result<()> {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(status) = self.child.try_wait()? {
                let logs = self.logs();
                ensure!(!status.success(), "process succeeded: {logs}");
                ensure!(logs.contains(expected), "expected {expected}: {logs}");
                ensure!(
                    !logs.contains(APP_TOKEN) && !logs.contains(BOT),
                    "a Slack token was logged"
                );
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

/// What the test tells one fake Socket Mode connection to do.
enum Instruction {
    Send(Value),
    Close,
}

/// One Socket Mode connection the Gateway opened to the fake Slack.
struct Connection {
    send: channel::Sender<Instruction>,
    acks: Mutex<channel::Receiver<String>>,
}

impl Connection {
    /// Delivers `payload` in a new `kind` envelope and returns the envelope ID.
    async fn deliver(&self, kind: &str, payload: Value) -> Result<String> {
        let envelope_id = Uuid::new_v4().to_string();
        self.send
            .send(Instruction::Send(json!({
                "envelope_id": envelope_id, "type": kind, "payload": payload,
                "accepts_response_payload": false, "retry_attempt": 0, "retry_reason": "",
            })))
            .await?;
        Ok(envelope_id)
    }
    /// Delivers an Events API payload and requires its acknowledgement.
    async fn acknowledged(&self, payload: Value) -> Result<()> {
        let envelope_id = self.deliver("events_api", payload).await?;
        let ack = tokio::time::timeout(WAIT, self.acks.lock().await.recv())
            .await
            .context("envelope was not acknowledged")?
            .context("Socket Mode connection closed")?;
        ensure!(ack == envelope_id, "acknowledged another envelope");
        Ok(())
    }
    /// Delivers an Events API payload and requires that it stays unacknowledged.
    async fn unacknowledged(&self, payload: Value) -> Result<()> {
        self.deliver("events_api", payload).await?;
        match tokio::time::timeout(NO_ACK, self.acks.lock().await.recv()).await {
            Err(_) => Ok(()),
            Ok(ack) => anyhow::bail!("envelope was acknowledged: {ack:?}"),
        }
    }
}

struct FakeSlack {
    endpoint: String,
    connections: Mutex<channel::Receiver<Connection>>,
    /// `apps.connections.open` calls answered so far.
    opened: Arc<AtomicUsize>,
    /// Web API calls with a bot token: path and JSON body.
    posts: Arc<Mutex<Vec<(String, Value)>>>,
    server: tokio::task::JoinHandle<Result<()>>,
}

impl FakeSlack {
    async fn start() -> Result<Self> {
        Self::with_app_token(APP_TOKEN).await
    }

    /// A fake Slack that accepts only `accepted` as the app-level token.
    async fn with_app_token(accepted: &'static str) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let (send_connection, connections) = channel::channel(8);
        let opened = Arc::new(AtomicUsize::new(0));
        let posts = Arc::new(Mutex::new(Vec::new()));
        let (counted, recorded) = (opened.clone(), posts.clone());
        let server = tokio::spawn(async move {
            let mut children = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted_stream = listener.accept() => {
                        let (stream, _) = accepted_stream?;
                        let send_connection = send_connection.clone();
                        let counted = counted.clone();
                        let recorded = recorded.clone();
                        children.spawn(async move {
                            let mut peek = [0; 16];
                            let count = tokio::time::timeout(Duration::from_secs(5), async {
                                loop {
                                    let count = stream.peek(&mut peek).await?;
                                    ensure!(count > 0, "client closed the connection");
                                    if count >= 9 {
                                        break anyhow::Ok(count);
                                    }
                                    tokio::task::yield_now().await;
                                }
                            })
                            .await??;
                            if peek[..count].starts_with(b"GET /link") {
                                socket(stream, send_connection).await
                            } else {
                                web_api(stream, address, accepted, &counted, &recorded).await
                            }
                        });
                    }
                    Some(result) = children.join_next(), if !children.is_empty() => {
                        result.context("fake Slack task panicked")??;
                    }
                }
            }
        });
        Ok(Self {
            endpoint: format!("http://{address}/chat.postMessage"),
            connections: Mutex::new(connections),
            opened,
            posts,
            server,
        })
    }

    async fn connection(&self) -> Result<Connection> {
        tokio::time::timeout(WAIT, self.connections.lock().await.recv())
            .await
            .context("the Gateway opened no Socket Mode connection")?
            .context("fake Slack stopped")
    }

    async fn posted(&self, count: usize) -> Result<()> {
        let deadline = Instant::now() + WAIT;
        loop {
            if self.posts.lock().await.len() >= count {
                return Ok(());
            }
            ensure!(!self.server.is_finished(), "fake Slack exited");
            ensure!(Instant::now() < deadline, "Slack reply missing");
            sleep(Duration::from_millis(10)).await;
        }
    }
}

impl Drop for FakeSlack {
    fn drop(&mut self) {
        self.server.abort();
    }
}

/// Serves one Socket Mode connection: `hello` first, then what the test sends; acknowledgements
/// go back to the test.
async fn socket(stream: TcpStream, connections: channel::Sender<Connection>) -> Result<()> {
    let mut socket = accept_async(stream).await?;
    socket
        .send(WsMessage::Text(
            json!({"type": "hello", "num_connections": 1,
                "connection_info": {"app_id": "AFIXTURE1"},
                "debug_info": {"host": "fixture", "approximate_connection_time": 18060}})
            .to_string()
            .into(),
        ))
        .await?;
    let (send, mut commands) = channel::channel(8);
    let (send_ack, acks) = channel::channel(64);
    connections
        .send(Connection {
            send,
            acks: Mutex::new(acks),
        })
        .await?;
    loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(Instruction::Send(value)) => {
                    socket.send(WsMessage::Text(value.to_string().into())).await?
                }
                Some(Instruction::Close) | None => {
                    let _ = socket.close(None).await;
                    return Ok(());
                }
            },
            incoming = socket.next() => match incoming {
                Some(Ok(WsMessage::Text(text))) => {
                    let ack: Value = serde_json::from_str(text.as_str())?;
                    ensure!(
                        ack.as_object().is_some_and(|ack| ack.len() == 1),
                        "an acknowledgement carries only the envelope ID"
                    );
                    let id = ack["envelope_id"].as_str().context("ack without ID")?;
                    let _ = send_ack.send(id.to_owned()).await;
                }
                Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => return Ok(()),
                Some(Ok(_)) => {}
            },
        }
    }
}

/// Answers one Slack Web API call.
async fn web_api(
    mut stream: TcpStream,
    address: SocketAddr,
    app_token: &str,
    opened: &AtomicUsize,
    posts: &Mutex<Vec<(String, Value)>>,
) -> Result<()> {
    let (path, authorization, body) = http_request(&mut stream).await?;
    let response = match path.as_str() {
        "/apps.connections.open" => {
            if authorization == format!("Bearer {app_token}") {
                opened.fetch_add(1, Ordering::SeqCst);
                json!({"ok": true, "url": format!("ws://{address}/link/?ticket={}", Uuid::new_v4())})
            } else {
                json!({"ok": false, "error": "invalid_auth"})
            }
        }
        "/chat.postMessage" | "/chat.update" => {
            ensure!(authorization == format!("Bearer {BOT}"), "wrong bot token");
            let ts = match body["ts"].as_str() {
                Some(ts) if path == "/chat.update" => ts.to_owned(),
                _ => {
                    format!("1794470100.{:06}", posts.lock().await.len() + 1)
                }
            };
            posts.lock().await.push((path.clone(), body));
            json!({"ok": true, "channel": CHANNEL, "ts": ts})
        }
        _ => anyhow::bail!("unexpected Slack API path {path}"),
    };
    let body = response.to_string();
    stream
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await?;
    let _ = stream.shutdown().await;
    Ok(())
}

async fn http_request(stream: &mut TcpStream) -> Result<(String, String, Value)> {
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
    let header = |name: &str| {
        headers
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.trim())
    };
    let authorization = header("authorization").unwrap_or_default().to_owned();
    let length: usize = header("content-length").unwrap_or("0").parse()?;
    ensure!(length <= 262_144);
    while bytes.len() < end + length {
        let count = stream.read(&mut buffer).await?;
        ensure!(count > 0, "fixture HTTP body ended early");
        bytes.extend_from_slice(&buffer[..count]);
    }
    let body = if length == 0 {
        Value::Null
    } else {
        serde_json::from_slice(&bytes[end..end + length])?
    };
    Ok((path, authorization, body))
}

async fn control_plane(
    credentials: &Credentials,
    directory: &Path,
    database: &str,
    address: Option<&str>,
) -> Result<(Process, String)> {
    let mut command = credentials.command(&["control-plane"]);
    command.env("SUPERTAG_DATABASE_URL", database);
    if let Some(address) = address {
        command.args(["--listen", address.trim_start_matches("http://")]);
    }
    let mut process = Process::spawn(command, directory, "control-plane")?;
    let endpoint = process.endpoints(1).await?.remove(0);
    Ok((process, endpoint))
}

/// A started Gateway whose Slack connector uses Socket Mode. It prints only its own gRPC
/// address: Socket Mode opens no webhook listener.
async fn gateway(
    credentials: &Credentials,
    directory: &Path,
    control_plane: &str,
    slack: &FakeSlack,
    app_token: &str,
) -> Result<Process> {
    let mut process = spawn_gateway(credentials, directory, control_plane, slack, app_token)?;
    process.endpoints(1).await?;
    Ok(process)
}

fn spawn_gateway(
    credentials: &Credentials,
    directory: &Path,
    control_plane: &str,
    slack: &FakeSlack,
    app_token: &str,
) -> Result<Process> {
    let mut command = credentials.command(&[
        "gateway",
        "--control-plane",
        control_plane,
        "--slack-socket-mode",
        "--slack-state-directory",
    ]);
    command
        .arg(directory.join("slack"))
        .env("SUPERTAG_SLACK_ACCOUNT_ID", ACCOUNT)
        .env("SUPERTAG_SLACK_TEAM_ID", TEAM)
        .env("SUPERTAG_SLACK_CHANNEL_ID", CHANNEL)
        .env("SUPERTAG_SLACK_TAG_ID", "builder")
        .env("SUPERTAG_SLACK_ALLOWED_USERS", "UALICE1,UBOB1")
        .env("SUPERTAG_SLACK_APP_TOKEN", app_token)
        .env("SUPERTAG_SLACK_BOT_TOKEN", BOT)
        .env("SUPERTAG_TEST_SLACK_API_URL", &slack.endpoint);
    Process::spawn(command, directory, "gateway")
}

async fn put_builder(credentials: &Credentials, control_plane: &str) -> Result<()> {
    OperatorClient::new(protocol::dial(control_plane.to_owned()).await?)
        .put_tag(credentials.operator(PutTagRequest {
            name: None,
            expected_revision: None,
            execution: None,
            approval_rules: vec![],
            tag_id: "builder".into(),
            instructions: "Original Tag".into(),
            allowed_actions: vec!["files:read".into()],
            workspace: None,
            harness_kind: 0,
        })?)
        .await?;
    Ok(())
}

fn payload(id: &str, ts: &str, mention: bool, prompt: &str) -> Value {
    json!({"type": "event_callback", "team_id": TEAM, "event_id": id, "event_time": 1794470000,
        "event": {"type": if mention { "app_mention" } else { "message" }, "channel": CHANNEL,
            "user": "UALICE1", "text": prompt, "ts": ts, "thread_ts": THREAD}})
}

/// The Task the Control Plane admitted for `payload`, by an exact private replay.
async fn receipt(control_plane: &str, credentials: &Credentials, payload: &Value) -> Result<Task> {
    let event = &payload["event"];
    ConnectorClient::new(protocol::dial(control_plane.to_owned()).await?)
        .accept_slack_event(credentials.connector(AcceptSlackEventRequest {
            account_id: ACCOUNT.into(),
            event_id: payload["event_id"].as_str().context("event ID")?.into(),
            team_id: TEAM.into(),
            channel_id: CHANNEL.into(),
            message_ts: event["ts"].as_str().context("ts")?.into(),
            thread_ts: THREAD.into(),
            prompt: event["text"].as_str().context("text")?.into(),
            mention_tag_id: (event["type"] == "app_mention").then(|| "builder".into()),
            actor_id: event["user"].as_str().context("user")?.into(),
        })?)
        .await?
        .into_inner()
        .task
        .context("the event was not admitted")
}

async fn task_count(database: &str) -> Result<i64> {
    let mut connection = database::connect(database).await?;
    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_tasks")
        .fetch_one(&mut connection)
        .await?)
}

/// Runs `task` on a one-shot Worker Host and waits for its Slack reply to settle as delivered.
async fn execute(
    credentials: &Credentials,
    directory: &Path,
    control_plane: &str,
    name: &str,
    task: &Task,
    database: &str,
) -> Result<()> {
    let mut command = credentials.command(&[
        "worker-host",
        "--control-plane",
        control_plane,
        "--adapter",
        ADAPTER,
        "--once",
        "--state-directory",
    ]);
    command.arg(directory.join(name));
    Process::spawn(command, directory, name)?.success().await?;
    let completed = OperatorClient::new(protocol::dial(control_plane.to_owned()).await?)
        .get_task(credentials.operator(GetTaskRequest {
            task_id: task.task_id.clone(),
        })?)
        .await?
        .into_inner();
    assert_eq!(completed.state(), TaskState::Succeeded);
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
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    socket_mode_acknowledges_admitted_events_and_reconnects;
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    socket_mode_stops_on_a_refused_token_or_disabled_link;
}

async fn socket_mode_acknowledges_admitted_events_and_reconnects(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let credentials = Credentials::new();
    let slack = FakeSlack::start().await?;
    let (mut cp, private) = control_plane(&credentials, directory.path(), &database, None).await?;
    let mut gateway = gateway(&credentials, directory.path(), &private, &slack, APP_TOKEN).await?;
    put_builder(&credentials, &private).await?;
    let connection = slack.connection().await?;

    // An ignored event is still delivered: a thread reply before any mention activated it.
    let mut early = payload("EvEARLY1", "1794470001.100000", false, "Continue");
    early["event"]["user"] = "UBOB1".into();
    connection.acknowledged(early.clone()).await?;
    // Envelopes without an Events API payload are acknowledged unread.
    connection
        .deliver("slash_commands", json!({"command": "/supertag"}))
        .await?;
    let ack = tokio::time::timeout(WAIT, connection.acks.lock().await.recv())
        .await?
        .context("slash command was not acknowledged")?;
    ensure!(!ack.is_empty());
    assert_eq!(task_count(&database).await?, 0);

    // An event the Control Plane did not admit stays unacknowledged, so Slack redelivers it.
    cp.stop().await?;
    let mention = payload("EvMENTION1", THREAD, true, "Inspect the fixture");
    connection.unacknowledged(mention.clone()).await?;
    let (restarted, _) =
        control_plane(&credentials, directory.path(), &database, Some(&private)).await?;
    cp = restarted;
    connection.acknowledged(mention.clone()).await?;
    // Slack's redelivery of an admitted event is a replay.
    connection.acknowledged(mention.clone()).await?;
    assert_eq!(task_count(&database).await?, 1);
    // A changed event under the same ID conflicts and is never acknowledged.
    let mut conflict = mention.clone();
    conflict["event"]["text"] = "Changed provider content".into();
    connection.unacknowledged(conflict).await?;

    let initial = receipt(&private, &credentials, &mention).await?;
    execute(
        &credentials,
        directory.path(),
        &private,
        "host-one",
        &initial,
        &database,
    )
    .await?;
    slack.posted(1).await?;
    {
        let posts = slack.posts.lock().await;
        let (path, body) = posts.last().context("no reply")?;
        assert!(matches!(
            path.as_str(),
            "/chat.postMessage" | "/chat.update"
        ));
        assert_eq!(body["channel"], CHANNEL);
        assert!(
            body["text"]
                .as_str()
                .is_some_and(|text| text.starts_with("Original Tag"))
        );
    }

    // Slack asks for a refresh: the Gateway opens a new connection and carries on.
    assert_eq!(slack.opened.load(Ordering::SeqCst), 1);
    connection
        .send
        .send(Instruction::Send(
            json!({"type": "disconnect", "reason": "refresh_requested",
                "debug_info": {"host": "fixture"}}),
        ))
        .await?;
    let refreshed = slack.connection().await?;
    assert_eq!(slack.opened.load(Ordering::SeqCst), 2);
    let reply = payload(
        "EvREPLY1",
        "1794470002.100000",
        false,
        "Continue with option A",
    );
    refreshed.acknowledged(reply.clone()).await?;
    let followup = receipt(&private, &credentials, &reply).await?;
    assert_eq!(followup.session_id, initial.session_id);
    assert_eq!(followup.tag_id, "builder");

    // A dropped link reconnects too.
    refreshed.send.send(Instruction::Close).await?;
    let reconnected = slack.connection().await?;
    let next = payload("EvMENTION2", "1794470003.100000", true, "Verify the result");
    reconnected.acknowledged(next.clone()).await?;
    assert_eq!(
        receipt(&private, &credentials, &next).await?.session_id,
        initial.session_id
    );
    assert_eq!(task_count(&database).await?, 3);
    let logs = gateway.logs();
    assert!(!logs.contains(APP_TOKEN) && !logs.contains(BOT));
    gateway.stop().await?;
    cp.stop().await?;
    Ok(())
}

async fn socket_mode_stops_on_a_refused_token_or_disabled_link(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let credentials = Credentials::new();
    let (mut cp, private) = control_plane(&credentials, directory.path(), &database, None).await?;

    // A refused app-level token stops the Gateway before any connection opens.
    let refusing = FakeSlack::with_app_token("xapp-another-token").await?;
    let mut refused = spawn_gateway(
        &credentials,
        directory.path(),
        &private,
        &refusing,
        APP_TOKEN,
    )?;
    refused
        .failed("Slack refused the Socket Mode connection: invalid_auth")
        .await?;
    assert_eq!(refusing.opened.load(Ordering::SeqCst), 0);

    // Slack disabling Socket Mode for the app stops the Gateway instead of reconnecting.
    let slack = FakeSlack::start().await?;
    let mut disabled = gateway(&credentials, directory.path(), &private, &slack, APP_TOKEN).await?;
    let connection = slack.connection().await?;
    connection
        .send
        .send(Instruction::Send(
            json!({"type": "disconnect", "reason": "link_disabled"}),
        ))
        .await?;
    disabled.failed("link_disabled").await?;
    assert_eq!(slack.opened.load(Ordering::SeqCst), 1);
    cp.stop().await?;
    Ok(())
}
