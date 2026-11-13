//! Outbound Lark WebSocket through separate CP/Gateway/Host processes.
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
    time::{Duration, Instant},
};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use supertag_protocol::{
    authenticated_request,
    v2::{
        AcceptLarkEventRequest, GetTaskRequest, LarkDomain, PutTagRequest, ReplyState, Task,
        TaskState, connector_client::ConnectorClient, operator_client::OperatorClient,
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Mutex, Semaphore, mpsc as channel},
    time::sleep,
};
use tonic::Request;
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(20);
const ACCOUNT: &str = "lark-process-test";
const APP: &str = "cli_0123456789abcdef";
const SECRET: &str = "synthetic-app-secret";
const CHAT: &str = "oc_engineering";
const ROOT: &str = "om_root";
const TOKEN: &str = "synthetic-lark-tenant-token";

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
        request(
            input,
            &self.gateway,
            Some(&format!("connector:lark/{ACCOUNT}")),
        )
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
    async fn rejected(&mut self, expected: &str) -> Result<()> {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(status) = self.child.try_wait()? {
                ensure!(!status.success(), "invalid provider identity was accepted");
                let logs = self.logs();
                ensure!(
                    logs.contains(expected),
                    "expected identity rejection: {logs}"
                );
                ensure!(
                    !logs.contains(SECRET) && !logs.contains(TOKEN),
                    "provider credential was logged"
                );
                return Ok(());
            }
            ensure!(
                Instant::now() < deadline,
                "invalid provider identity did not stop Gateway"
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
    fn crash(&mut self) -> Result<()> {
        if self.child.try_wait()?.is_none() {
            self.child.kill()?;
        }
        self.child.wait()?;
        Ok(())
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

use futures_util::{SinkExt, StreamExt};
use prost::Message;
use supertag_gateway::lark::wire::{Frame, Header};
use tokio_tungstenite::{accept_async, tungstenite::Message as WsMessage};
async fn task_count(database: &str) -> Result<i64> {
    let mut connection = database::connect(database).await?;
    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_tasks")
        .fetch_one(&mut connection)
        .await?)
}

async fn control(
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
async fn put_tag(public: &str, credentials: &Credentials) -> Result<()> {
    OperatorClient::new(protocol::dial(public.to_owned()).await?)
        .put_tag(credentials.operator(PutTagRequest {
            name: None,
            expected_revision: None,
            execution: None,
            approval_rules: vec![],
            tag_id: "builder".into(),
            instructions: "Lark fixture <at id=all>everyone</at>".into(),
            allowed_actions: vec!["files:read".into()],
            workspace: None,
            harness_kind: 0,
        })?)
        .await?;
    Ok(())
}
async fn execute(
    credentials: &Credentials,
    directory: &Path,
    public: &str,
    task: &Task,
) -> Result<()> {
    let mut command = credentials.command(&[
        "worker-host",
        "--gateway",
        public,
        "--adapter",
        ADAPTER,
        "--once",
        "--state-directory",
    ]);
    command.arg(directory.join("host"));
    Process::spawn(command, directory, "host")?
        .success()
        .await?;
    let completed = OperatorClient::new(protocol::dial(public.to_owned()).await?)
        .get_task(credentials.operator(GetTaskRequest {
            task_id: task.task_id.clone(),
        })?)
        .await?
        .into_inner();
    assert_eq!(completed.state(), TaskState::Succeeded);
    Ok(())
}
async fn settled(database: &str, task: &Task, expected: ReplyState) -> Result<Option<String>> {
    let mut connection = database::connect(database).await?;
    let deadline = Instant::now() + WAIT;
    loop {
        let row: Option<(i64, Option<String>)> = sqlx::query_as(
            "SELECT state,provider_receipt FROM supertag_v2_replies WHERE task_id=$1",
        )
        .bind(&task.task_id)
        .fetch_optional(&mut connection)
        .await?;
        if let Some((state, receipt)) = row
            && state == expected as i64
        {
            return Ok(receipt);
        }
        ensure!(
            Instant::now() < deadline,
            "Lark reply did not reach expected settlement"
        );
        sleep(Duration::from_millis(10)).await;
    }
}
async fn saved_stage(directory: &Path, states: &[&str], stage: &str) -> Result<Value> {
    let deadline = Instant::now() + WAIT;
    loop {
        for state in states {
            if let Ok(bytes) = std::fs::read(directory.join(state).join("reply.json")) {
                let value: Value = serde_json::from_slice(&bytes)?;
                if value["entry"]["stage"] == stage {
                    return Ok(value);
                }
            }
        }
        ensure!(
            Instant::now() < deadline,
            "Lark delivery journal did not reach {stage}"
        );
        sleep(Duration::from_millis(10)).await;
    }
}

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    lark_websocket_replays_after_failed_admission_and_keeps_activated_thread_across_restart;
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    lark_interrupted_reply_remains_uncertain_without_reposting;
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    lark_rejects_mismatched_app_bot_before_opening_event_stream;
}

enum CommandFrame {
    Data(Frame),
    Close,
}
struct Connection {
    send: channel::Sender<CommandFrame>,
    acks: Mutex<channel::Receiver<Frame>>,
}
impl Connection {
    async fn event(&self, value: &Value, wire_id: &str) -> Result<u64> {
        let bytes = serde_json::to_vec(value)?;
        let middle = bytes.len() / 2;
        for (seq, payload) in [(1, &bytes[middle..]), (0, &bytes[..middle])] {
            let frame = Frame {
                sequence: 42,
                log_id: 99,
                service: 17,
                method: 1,
                headers: [
                    ("type", "event"),
                    ("message_id", wire_id),
                    ("sum", "2"),
                    ("seq", if seq == 1 { "1" } else { "0" }),
                    ("trace_id", "trace"),
                ]
                .into_iter()
                .map(|(k, v)| Header {
                    key: k.into(),
                    value: v.into(),
                })
                .collect(),
                payload: Some(payload.into()),
                ..Default::default()
            };
            self.send.send(CommandFrame::Data(frame)).await?;
        }
        let frame = tokio::time::timeout(Duration::from_secs(5), self.acks.lock().await.recv())
            .await?
            .context("Lark acknowledgement stream closed")?;
        ensure!(frame.header("message_id")? == wire_id);
        let response: Value =
            serde_json::from_slice(frame.payload.as_deref().context("ACK payload missing")?)?;
        response["code"].as_u64().context("ACK code missing")
    }
}
struct MockLark {
    origin: String,
    connections: Mutex<channel::Receiver<Connection>>,
    requests: Arc<Mutex<Vec<Value>>>,
    responses: Arc<Semaphore>,
    server: tokio::task::JoinHandle<Result<()>>,
}
impl MockLark {
    async fn start() -> Result<Self> {
        Self::with_bot("ou_bot").await
    }
    async fn with_bot(bot: &str) -> Result<Self> {
        let bot = bot.to_owned();
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let origin = format!("http://{address}/");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let observed = requests.clone();
        let responses = Arc::new(Semaphore::new(0));
        let release = responses.clone();
        let (send_connection, connections) = channel::channel(8);
        let server = tokio::spawn(async move {
            let mut children = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                 accepted=listener.accept()=>{let (stream,_)=accepted?;let observed=observed.clone();let release=release.clone();let send_connection=send_connection.clone();let bot=bot.clone();children.spawn(async move{
                  let mut peek=[0;64];let count=tokio::time::timeout(Duration::from_secs(5),async {loop {let count=stream.peek(&mut peek).await?;ensure!(count>0,"provider connection closed");if count>=8 {break Ok::<_,anyhow::Error>(count);}tokio::task::yield_now().await;}}).await??;
                  if peek[..count].starts_with(b"GET /ws?"){
                    let mut ws=accept_async(stream).await?;let (send,mut commands)=channel::channel(8);let (send_ack,acks)=channel::channel(8);send_connection.send(Connection{send,acks:Mutex::new(acks)}).await?;
                    loop{tokio::select!{
                     command=commands.recv()=>match command{Some(CommandFrame::Data(frame))=>ws.send(WsMessage::Binary(frame.encode_to_vec().into())).await?,Some(CommandFrame::Close)|None=>{ws.close(None).await?;break;}},
                     incoming=ws.next()=>match incoming{Some(Ok(WsMessage::Binary(bytes)))=>{let frame=Frame::decode(bytes)?;if frame.header("type")?=="ping"{ensure!(frame.sequence==0&&frame.log_id==0&&frame.method==0&&frame.service==17);let pong=Frame{service:17,headers:vec![Header{key:"type".into(),value:"pong".into()}],payload:Some(json!({"PingInterval":1,"ReconnectCount":-1,"ReconnectInterval":1,"ReconnectNonce":0}).to_string().into_bytes()),..Default::default()};ws.send(WsMessage::Binary(pong.encode_to_vec().into())).await?;}else{send_ack.send(frame).await?;}},Some(Ok(WsMessage::Close(_)))|None=>break,Some(Err(_))=>break,_=>{}}
                    }}
                  }else{
                    let mut stream=stream;let (path,authorization,body)=http_request(&mut stream).await?;
                    let value=match path.as_str(){
                     "/callback/ws/endpoint"=>{ensure!(body==json!({"AppID":APP,"AppSecret":SECRET}));json!({"code":0,"data":{"URL":format!("ws://{address}/ws?service_id=17&device_id=fixture"),"ClientConfig":{"PingInterval":1,"ReconnectCount":-1,"ReconnectInterval":1,"ReconnectNonce":0}}})},
                     "/open-apis/auth/v3/tenant_access_token/internal"=>{ensure!(body==json!({"app_id":APP,"app_secret":SECRET}));json!({"code":0,"tenant_access_token":TOKEN,"expire":7200})},
                     "/open-apis/bot/v3/info"=>{ensure!(authorization==format!("Bearer {TOKEN}"));json!({"code":0,"bot":{"open_id":bot,"app_name":"Fixture"}})},
                     "/open-apis/im/v1/messages/om_root/reply"=>{ensure!(authorization==format!("Bearer {TOKEN}"));ensure!(body["reply_in_thread"]==true);ensure!(body["msg_type"]=="interactive");let card:Value=serde_json::from_str(body["content"].as_str().context("card missing")?)?;let text=card["elements"][0]["text"]["content"].as_str().context("card text missing")?;ensure!(text.contains("Lark fixture ‹at id=all›everyone‹/at›")&&!text.contains("<at"));ensure!(Uuid::parse_str(body["uuid"].as_str().context("reply UUID missing")?).is_ok());observed.lock().await.push(body);release.acquire().await?.forget();json!({"code":0,"data":{"message_id":"om_receipt","chat_id":CHAT,"root_id":ROOT}})},
                     _=>anyhow::bail!("unexpected provider path")
                    };let body=value.to_string();let _=stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await;
                  }
                  Ok::<_,anyhow::Error>(())
                 });},
                 result=children.join_next(),if !children.is_empty()=>{result.context("mock child missing")???;}
                }
            }
        });
        Ok(Self {
            origin,
            connections: Mutex::new(connections),
            requests,
            responses,
            server,
        })
    }
    async fn connection(&self) -> Result<Connection> {
        tokio::time::timeout(WAIT, self.connections.lock().await.recv())
            .await?
            .context("no Lark WebSocket connection")
    }
    async fn wait_for(&self, count: usize) -> Result<()> {
        let deadline = Instant::now() + WAIT;
        loop {
            if self.requests.lock().await.len() >= count {
                return Ok(());
            }
            ensure!(!self.server.is_finished(), "mock provider exited");
            ensure!(Instant::now() < deadline, "Lark reply missing");
            sleep(Duration::from_millis(10)).await;
        }
    }
}
impl Drop for MockLark {
    fn drop(&mut self) {
        self.server.abort();
    }
}
async fn http_request(stream: &mut TcpStream) -> Result<(String, String, Value)> {
    let mut bytes = Vec::new();
    let mut buffer = [0; 4096];
    let end = loop {
        if let Some(i) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        ensure!(bytes.len() < 16384);
        let n = stream.read(&mut buffer).await?;
        ensure!(n > 0);
        bytes.extend_from_slice(&buffer[..n]);
    };
    let headers = std::str::from_utf8(&bytes[..end])?;
    let path = headers
        .lines()
        .next()
        .context("request missing")?
        .split_whitespace()
        .nth(1)
        .context("path missing")?
        .to_string();
    let header = |name: &str| {
        headers
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.trim())
    };
    let authorization = header("authorization").unwrap_or("").to_string();
    let length: usize = header("content-length").unwrap_or("0").parse()?;
    ensure!(length <= 262144);
    while bytes.len() < end + length {
        let n = stream.read(&mut buffer).await?;
        ensure!(n > 0);
        bytes.extend_from_slice(&buffer[..n]);
    }
    let value = if length == 0 {
        Value::Null
    } else {
        serde_json::from_slice(&bytes[end..end + length])?
    };
    Ok((path, authorization, value))
}
async fn gateway(
    credentials: &Credentials,
    directory: &Path,
    private: &str,
    mock: &MockLark,
) -> Result<(Process, String)> {
    let mut command = credentials.command(&[
        "gateway",
        "--control-plane",
        private,
        "--lark-state-directory",
    ]);
    command
        .arg(directory.join("lark"))
        .env("SUPERTAG_LARK_ACCOUNT_ID", ACCOUNT)
        .env("SUPERTAG_LARK_DOMAIN", "lark")
        .env("SUPERTAG_LARK_APP_ID", APP)
        .env("SUPERTAG_LARK_APP_SECRET", SECRET)
        .env("SUPERTAG_LARK_TENANT_KEY", "tenant-one")
        .env("SUPERTAG_LARK_BOT_OPEN_ID", "ou_bot")
        .env("SUPERTAG_LARK_CHAT_ID", CHAT)
        .env("SUPERTAG_LARK_TAG_ID", "builder")
        .env("SUPERTAG_LARK_ALLOWED_USERS", "ou_alice")
        .env("SUPERTAG_TEST_LARK_ORIGIN", &mock.origin);
    let mut child = Process::spawn(command, directory, "gateway")?;
    let public = child.endpoints(1).await?.remove(0);
    Ok((child, public))
}
fn payload(event: &str, message: &str, mention: bool) -> Value {
    let mut message = json!({"message_id":message,"chat_id":CHAT,"chat_type":"group","message_type":"text","content":json!({"text":if mention{"@_user_1 inspect"}else{"follow up"}}).to_string(),"mentions":if mention{json!([{"key":"@_user_1","id":{"open_id":"ou_bot"}}])}else{json!([])}});
    if message["message_id"] != ROOT {
        message["root_id"] = ROOT.into();
    }
    json!({"schema":"2.0","header":{"event_id":event,"event_type":"im.message.receive_v1","app_id":APP,"tenant_key":"tenant-one","create_time":"1800000000000"},"event":{"sender":{"sender_id":{"open_id":"ou_alice"},"sender_type":"user","tenant_key":"tenant-one"},"message":message}})
}
async fn receipt(
    private: &str,
    credentials: &Credentials,
    id: &str,
    message: &str,
    mention: bool,
) -> Result<Task> {
    ConnectorClient::new(protocol::dial(private.to_owned()).await?)
        .accept_lark_event(credentials.connector(AcceptLarkEventRequest {
            account_id: format!("lark/{ACCOUNT}"),
            domain: LarkDomain::Lark.into(),
            app_id: APP.into(),
            tenant_key: "tenant-one".into(),
            event_id: id.into(),
            chat_id: CHAT.into(),
            message_id: message.into(),
            root_message_id: ROOT.into(),
            actor_id: "ou_alice".into(),
            prompt: if mention {
                "inspect".into()
            } else {
                "follow up".into()
            },
            mention_tag_id: mention.then(|| "builder".into()),
            direct: false,
        })?)
        .await?
        .into_inner()
        .task
        .context("Task missing")
}
async fn lark_websocket_replays_after_failed_admission_and_keeps_activated_thread_across_restart(
    database: String,
) -> Result<()> {
    let dir = tempfile::tempdir()?;
    let credentials = Credentials::new();
    let mock = MockLark::start().await?;
    let (mut cp, private) = control(&credentials, dir.path(), &database, None).await?;
    let (mut gateway_process, public) = gateway(&credentials, dir.path(), &private, &mock).await?;
    put_tag(&public, &credentials).await?;
    let connection = mock.connection().await?;
    assert_eq!(
        connection
            .event(&payload("orphan", "om_orphan", false), "orphan")
            .await?,
        200
    );
    let mut bot = payload("bot", ROOT, true);
    bot["event"]["sender"]["sender_type"] = "app".into();
    assert_eq!(connection.event(&bot, "bot").await?, 200);
    assert_eq!(task_count(&database).await?, 0);
    cp.stop().await?;
    let mention = payload("mention", ROOT, true);
    assert_eq!(connection.event(&mention, "failed-admission").await?, 500);
    assert_eq!(task_count(&database).await?, 0);
    let (mut cp, _) = control(&credentials, dir.path(), &database, Some(&private)).await?;
    assert_eq!(connection.event(&mention, "retry-admission").await?, 200);
    assert_eq!(connection.event(&mention, "duplicate").await?, 200);
    let task = receipt(&private, &credentials, "mention", ROOT, true).await?;
    assert_eq!(task_count(&database).await?, 1);
    mock.responses.add_permits(1);
    execute(&credentials, dir.path(), &public, &task).await?;
    assert_eq!(
        settled(&database, &task, ReplyState::Delivered)
            .await?
            .as_deref(),
        Some("om_receipt")
    );
    connection.send.send(CommandFrame::Close).await?;
    let reconnected = mock.connection().await?;
    assert_eq!(reconnected.event(&mention, "rediscovered").await?, 200);
    gateway_process.crash()?;
    let (mut restarted, public) = gateway(&credentials, dir.path(), &private, &mock).await?;
    let connection = mock.connection().await?;
    assert_eq!(connection.event(&mention, "restart-replay").await?, 200);
    let replica_directory = dir.path().join("replica");
    std::fs::create_dir(&replica_directory)?;
    let (mut replica, _) = gateway(&credentials, &replica_directory, &private, &mock).await?;
    let other_connection = mock.connection().await?;
    let follow = payload("follow", "om_follow", false);
    let (left, right) = tokio::join!(
        connection.event(&follow, "follow-left"),
        other_connection.event(&follow, "follow-right")
    );
    assert_eq!(left?, 200);
    assert_eq!(right?, 200);
    let next = receipt(&private, &credentials, "follow", "om_follow", false).await?;
    assert_eq!(next.session_id, task.session_id);
    mock.responses.add_permits(1);
    execute(&credentials, dir.path(), &public, &next).await?;
    settled(&database, &next, ReplyState::Delivered).await?;
    assert_eq!(task_count(&database).await?, 2);
    assert_eq!(mock.requests.lock().await.len(), 2);
    assert!(!restarted.logs().contains(SECRET) && !restarted.logs().contains(TOKEN));
    replica.stop().await?;
    restarted.stop().await?;
    cp.stop().await?;
    Ok(())
}
async fn lark_interrupted_reply_remains_uncertain_without_reposting(
    database: String,
) -> Result<()> {
    let dir = tempfile::tempdir()?;
    let credentials = Credentials::new();
    let mock = MockLark::start().await?;
    let (mut cp, private) = control(&credentials, dir.path(), &database, None).await?;
    let (mut gateway_process, public) = gateway(&credentials, dir.path(), &private, &mock).await?;
    put_tag(&public, &credentials).await?;
    let connection = mock.connection().await?;
    let mention = payload("mention", ROOT, true);
    assert_eq!(connection.event(&mention, "mention").await?, 200);
    let task = receipt(&private, &credentials, "mention", ROOT, true).await?;
    execute(&credentials, dir.path(), &public, &task).await?;
    mock.wait_for(1).await?;
    saved_stage(dir.path(), &["lark"], "sending").await?;
    gateway_process.crash()?;
    let (mut restarted, _) = gateway(&credentials, dir.path(), &private, &mock).await?;
    let connection = mock.connection().await?;
    assert_eq!(
        settled(&database, &task, ReplyState::Uncertain).await?,
        None
    );
    mock.responses.add_permits(1);
    assert_eq!(connection.event(&mention, "duplicate").await?, 200);
    assert_eq!(task_count(&database).await?, 1);
    assert_eq!(mock.requests.lock().await.len(), 1);
    restarted.stop().await?;
    cp.stop().await?;
    Ok(())
}

async fn lark_rejects_mismatched_app_bot_before_opening_event_stream(
    database: String,
) -> Result<()> {
    let dir = tempfile::tempdir()?;
    let credentials = Credentials::new();
    let mock = MockLark::with_bot("ou_another_app").await?;
    let (mut cp, private) = control(&credentials, dir.path(), &database, None).await?;
    let (mut gateway, _) = gateway(&credentials, dir.path(), &private, &mock).await?;
    gateway
        .rejected("Lark bot identity does not match configuration")
        .await?;
    assert!(mock.connections.lock().await.try_recv().is_err());
    assert!(mock.requests.lock().await.is_empty());
    assert_eq!(task_count(&database).await?, 0);
    cp.stop().await?;
    Ok(())
}
