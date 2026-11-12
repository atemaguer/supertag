//! Signed HTTP Linear ingress through separate CP/Gateway/Host processes.
//! Every provider interaction terminates at this test's loopback HTTP server.
use std::{
    fs::File,
    io::{BufRead, BufReader},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicU8, AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use anyhow::{Context, Result, ensure};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use sqlx::Connection;
use supertag_protocol::{
    authenticated_request,
    v2::{
        AcceptLinearEventRequest, GetTaskRequest, LinearEventAction, LinearEventKind,
        PutTagRequest, ReplyState, Task, TaskState, connector_client::ConnectorClient,
        operator_client::OperatorClient,
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Mutex, Semaphore},
    time::sleep,
};
use tonic::Request;
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(20);
const ACCOUNT: &str = "linear-process-test";
const WORKSPACE: &str = "11111111-1111-4111-8111-111111111111";
const TEAM: &str = "22222222-2222-4222-8222-222222222222";
const ISSUE: &str = "33333333-3333-4333-8333-333333333333";
const COMMENT: &str = "44444444-4444-4444-8444-444444444444";
const USER: &str = "55555555-5555-4555-8555-555555555555";
const REPLY: &str = "66666666-6666-4666-8666-666666666666";
const SIGNING: &str = "synthetic-linear-webhook-secret";
const TOKEN: &str = "synthetic-linear-api-token";

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
            Some(&format!("connector:linear/{ACCOUNT}")),
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
    ensure!(headers.starts_with("POST /graphql HTTP/1.1\r\n"));
    let header = |name: &str| {
        headers
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.trim())
    };
    ensure!(header("authorization") == Some(TOKEN));
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

async fn task_count(database: &str) -> Result<i64> {
    let mut connection = sqlx::SqliteConnection::connect(database).await?;
    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_tasks")
        .fetch_one(&mut connection)
        .await?)
}

struct MockLinear {
    endpoint: String,
    requests: Arc<Mutex<Vec<Value>>>,
    responses: Arc<Semaphore>,
    lookups: Arc<AtomicUsize>,
    lookup_mode: Arc<AtomicU8>,
    server: tokio::task::JoinHandle<Result<()>>,
}
impl MockLinear {
    async fn start() -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = format!("http://{}/graphql", listener.local_addr()?);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let observed = requests.clone();
        let responses = Arc::new(Semaphore::new(0));
        let release = responses.clone();
        let lookups = Arc::new(AtomicUsize::new(0));
        let queried = lookups.clone();
        let lookup_mode = Arc::new(AtomicU8::new(0));
        let mode = lookup_mode.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await?;
                let request =
                    tokio::time::timeout(Duration::from_secs(5), mock_request(&mut stream))
                        .await??;
                let body = if request["query"]
                    .as_str()
                    .context("missing GraphQL query")?
                    .starts_with("query SuperTagLinearIssue")
                {
                    ensure!(request["variables"]["id"] == ISSUE);
                    queried.fetch_add(1, Ordering::SeqCst);
                    match mode.load(Ordering::SeqCst) {
                        1 => json!({"data":{"issue":{"id":ISSUE,"team":{"id":WORKSPACE}}}}),
                        2 => json!({"data":{"issue":{"id":COMMENT,"team":{"id":TEAM}}}}),
                        3 => {
                            json!({"errors":[{"message":"synthetic-api-key must not reach logs"}]})
                        }
                        _ => json!({"data":{"issue":{"id":ISSUE,"team":{"id":TEAM}}}}),
                    }
                    .to_string()
                } else {
                    ensure!(
                        request["query"]
                            .as_str()
                            .is_some_and(|query| query.starts_with("mutation SuperTagLinearReply"))
                    );
                    ensure!(request["variables"]["input"]["issueId"] == ISSUE);
                    observed.lock().await.push(request);
                    release.acquire().await?.forget();
                    json!({"data":{"commentCreate":{"success":true,"comment":{"id":REPLY,"issue":{"id":ISSUE}}}}}).to_string()
                };
                // A crashed Gateway may have closed its connection after the server
                // accepted the comment. That does not undo the observed provider write.
                let _=stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await;
                let _ = stream.shutdown().await;
            }
        });
        Ok(Self {
            endpoint,
            requests,
            responses,
            lookups,
            lookup_mode,
            server,
        })
    }
    async fn wait_for(&self, count: usize) -> Result<()> {
        let deadline = Instant::now() + WAIT;
        loop {
            if self.requests.lock().await.len() >= count {
                return Ok(());
            }
            ensure!(!self.server.is_finished(), "mock Linear server exited");
            ensure!(Instant::now() < deadline, "Linear comment was not sent");
            sleep(Duration::from_millis(10)).await;
        }
    }
}
impl Drop for MockLinear {
    fn drop(&mut self) {
        self.server.abort();
    }
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
async fn gateway(
    credentials: &Credentials,
    directory: &Path,
    private: &str,
    state: &str,
    mock: &MockLinear,
) -> Result<(Process, String, String)> {
    let mut command = credentials.command(&[
        "gateway",
        "--control-plane",
        private,
        "--linear-listen",
        "127.0.0.1:0",
        "--linear-state-directory",
    ]);
    command
        .arg(directory.join(state))
        .env("SUPERTAG_LINEAR_ACCOUNT_ID", ACCOUNT)
        .env("SUPERTAG_LINEAR_WORKSPACE_ID", WORKSPACE)
        .env("SUPERTAG_LINEAR_TEAM_ID", TEAM)
        .env("SUPERTAG_LINEAR_TAG_ID", "builder")
        .env("SUPERTAG_LINEAR_ALLOWED_USERS", USER)
        .env("SUPERTAG_LINEAR_WEBHOOK_SECRET", SIGNING)
        .env("SUPERTAG_LINEAR_API_KEY", TOKEN)
        .env("SUPERTAG_TEST_LINEAR_API_URL", &mock.endpoint);
    let mut process = Process::spawn(command, directory, state)?;
    let endpoints = process.endpoints(2).await?;
    Ok((process, endpoints[0].clone(), endpoints[1].clone()))
}
fn payload() -> Value {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    json!({"action":"create","actor":{"id":USER,"type":"user"},"type":"Comment","organizationId":WORKSPACE,"webhookTimestamp":timestamp,"data":{"id":COMMENT,"issueId":ISSUE,"body":"@supertag inspect this issue"}})
}
async fn signed(endpoint: &str, id: &str, payload: &Value) -> Result<reqwest::StatusCode> {
    let body = payload.to_string();
    let mut mac = Hmac::<Sha256>::new_from_slice(SIGNING.as_bytes())?;
    mac.update(body.as_bytes());
    Ok(reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()?
        .post(format!("{endpoint}/linear/events"))
        .header("content-type", "application/json")
        .header("linear-delivery", id)
        .header("linear-event", payload["type"].as_str().unwrap())
        .header(
            "linear-signature",
            format!("{:x}", mac.finalize().into_bytes()),
        )
        .body(body)
        .send()
        .await?
        .status())
}
async fn receipt(
    private: &str,
    credentials: &Credentials,
    id: &str,
    payload: &Value,
) -> Result<Task> {
    ConnectorClient::connect(private.to_owned())
        .await?
        .accept_linear_event(credentials.connector(AcceptLinearEventRequest {
            account_id: format!("linear/{ACCOUNT}"),
            delivery_id: id.into(),
            workspace_id: WORKSPACE.into(),
            team_id: TEAM.into(),
            issue_id: ISSUE.into(),
            source_id: payload["data"]["id"].as_str().unwrap().into(),
            kind: LinearEventKind::IssueComment.into(),
            action: if payload["action"] == "update" {
                LinearEventAction::Update.into()
            } else {
                LinearEventAction::Create.into()
            },
            prompt: payload["data"]["body"].as_str().unwrap().into(),
            tag_id: "builder".into(),
        })?)
        .await?
        .into_inner()
        .task
        .context("Linear event was not accepted")
}
async fn put_tag(public: &str, credentials: &Credentials) -> Result<()> {
    OperatorClient::connect(public.to_owned())
        .await?
        .put_tag(credentials.operator(PutTagRequest {
            name: None,
            execution: None,
            approval_rules: vec![],
            tag_id: "builder".into(),
            instructions: "Linear fixture".into(),
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
    let completed = OperatorClient::connect(public.to_owned())
        .await?
        .get_task(credentials.operator(GetTaskRequest {
            task_id: task.task_id.clone(),
        })?)
        .await?
        .into_inner();
    assert_eq!(completed.state(), TaskState::Succeeded);
    Ok(())
}
async fn settled(database: &str, task: &Task, expected: ReplyState) -> Result<Option<String>> {
    let mut connection = sqlx::SqliteConnection::connect(database).await?;
    let deadline = Instant::now() + WAIT;
    loop {
        let row: Option<(i64, Option<String>)> = sqlx::query_as(
            "SELECT state,provider_receipt FROM supertag_v2_replies WHERE task_id=?",
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
            "Linear reply did not reach expected settlement"
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
            "Linear delivery journal did not reach {stage}"
        );
        sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_linear_gateways_deduplicate_and_replay_saved_receipt_after_restart()
-> Result<()> {
    let directory = tempfile::tempdir()?;
    let database = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("linear.db").display()
    );
    let credentials = Credentials::new();
    let mock = MockLinear::start().await?;
    let (mut cp, private) = control(&credentials, directory.path(), &database, None).await?;
    let (mut first, public, http) =
        gateway(&credentials, directory.path(), &private, "first", &mock).await?;
    let (mut second, _, second_http) =
        gateway(&credentials, directory.path(), &private, "second", &mock).await?;
    put_tag(&public, &credentials).await?;
    for (pointer, value) in [
        ("/actor/type", json!("application")),
        ("/actor/id", json!(TEAM)),
        ("/data/body", json!("without a mention")),
    ] {
        let mut ignored = payload();
        *ignored.pointer_mut(pointer).unwrap() = value;
        assert_eq!(
            signed(&http, "ignored", &ignored).await?,
            reqwest::StatusCode::OK
        );
    }
    let mut wrong = payload();
    wrong["organizationId"] = TEAM.into();
    assert_eq!(
        signed(&http, "wrong-workspace", &wrong).await?,
        reqwest::StatusCode::FORBIDDEN
    );
    assert_eq!(task_count(&database).await?, 0);
    let mut stale = payload();
    stale["webhookTimestamp"] = 0.into();
    assert_eq!(
        signed(&http, "stale", &stale).await?,
        reqwest::StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        mock.lookups.load(Ordering::SeqCst),
        0,
        "invalid or ignored input must not trigger provider lookup"
    );
    for (mode, expected) in [
        (1, reqwest::StatusCode::FORBIDDEN),
        (2, reqwest::StatusCode::SERVICE_UNAVAILABLE),
        (3, reqwest::StatusCode::SERVICE_UNAVAILABLE),
    ] {
        mock.lookup_mode.store(mode, Ordering::SeqCst);
        assert_eq!(
            signed(&http, &format!("invalid-lookup-{mode}"), &payload()).await?,
            expected
        );
        assert_eq!(task_count(&database).await?, 0);
    }
    mock.lookup_mode.store(0, Ordering::SeqCst);
    let input = payload();
    let (left, right) = tokio::join!(
        signed(&http, "delivery-one", &input),
        signed(&second_http, "delivery-one", &input)
    );
    assert_eq!(left?, reqwest::StatusCode::OK);
    assert_eq!(right?, reqwest::StatusCode::OK);
    let task = receipt(&private, &credentials, "delivery-one", &input).await?;
    assert_eq!(task_count(&database).await?, 1);
    execute(&credentials, directory.path(), &public, &task).await?;
    mock.wait_for(1).await?;
    cp.stop().await?;
    mock.responses.add_permits(1);
    let journal = saved_stage(directory.path(), &["first", "second"], "settle").await?;
    assert_eq!(journal["provider"], "linear");
    assert_eq!(journal["account_id"], format!("linear/{ACCOUNT}"));
    assert_eq!(journal["entry"]["outcome"]["provider_receipt"], REPLY);
    first.crash()?;
    second.crash()?;
    let (mut cp, _) = control(&credentials, directory.path(), &database, Some(&private)).await?;
    let (mut first, _, http) =
        gateway(&credentials, directory.path(), &private, "first", &mock).await?;
    let (mut second, _, second_http) =
        gateway(&credentials, directory.path(), &private, "second", &mock).await?;
    assert_eq!(
        settled(&database, &task, ReplyState::Delivered)
            .await?
            .as_deref(),
        Some(REPLY)
    );
    assert_eq!(
        signed(&http, "delivery-one", &input).await?,
        reqwest::StatusCode::OK
    );
    let mut changed = input.clone();
    changed["data"]["body"] = "@supertag changed body".into();
    assert_eq!(
        signed(&second_http, "delivery-one", &changed).await?,
        reqwest::StatusCode::CONFLICT
    );
    changed["action"] = "update".into();
    assert_eq!(
        signed(&second_http, "delivery-edit", &changed).await?,
        reqwest::StatusCode::OK
    );
    assert_eq!(
        receipt(&private, &credentials, "delivery-edit", &changed)
            .await?
            .task_id,
        task.task_id
    );
    assert_eq!(task_count(&database).await?, 1);
    assert_eq!(
        mock.requests.lock().await.len(),
        1,
        "saved provider receipt must never cause another POST"
    );
    first.stop().await?;
    second.stop().await?;
    cp.stop().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn linear_post_interrupted_after_provider_acceptance_stays_uncertain_after_restart()
-> Result<()> {
    let directory = tempfile::tempdir()?;
    let database = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("linear.db").display()
    );
    let credentials = Credentials::new();
    let mock = MockLinear::start().await?;
    let (mut cp, private) = control(&credentials, directory.path(), &database, None).await?;
    let (mut gateway_process, public, http) =
        gateway(&credentials, directory.path(), &private, "gateway", &mock).await?;
    put_tag(&public, &credentials).await?;
    let input = payload();
    assert_eq!(
        signed(&http, "delivery-one", &input).await?,
        reqwest::StatusCode::OK
    );
    let task = receipt(&private, &credentials, "delivery-one", &input).await?;
    execute(&credentials, directory.path(), &public, &task).await?;
    mock.wait_for(1).await?;
    saved_stage(directory.path(), &["gateway"], "sending").await?;
    gateway_process.crash()?;
    let (mut restarted, _, http) =
        gateway(&credentials, directory.path(), &private, "gateway", &mock).await?;
    assert_eq!(
        settled(&database, &task, ReplyState::Uncertain).await?,
        None
    );
    mock.responses.add_permits(1);
    assert_eq!(
        signed(&http, "delivery-one", &input).await?,
        reqwest::StatusCode::OK
    );
    assert_eq!(task_count(&database).await?, 1);
    assert_eq!(mock.requests.lock().await.len(), 1);
    restarted.stop().await?;
    cp.stop().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replacement_gateway_exposes_expired_reply_without_reposting_and_accepts_audit()
-> Result<()> {
    use supertag_protocol::v2::{
        GetReplyDeliveryRequest, ListReplyDeliveriesRequest, ResolveReplyRequest,
    };
    let directory = tempfile::tempdir()?;
    let database = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("replacement.db").display()
    );
    let credentials = Credentials::new();
    let mock = MockLinear::start().await?;
    let (mut cp, private) = control(&credentials, directory.path(), &database, None).await?;
    let (mut first, public, http) = gateway(
        &credentials,
        directory.path(),
        &private,
        "lost-journal",
        &mock,
    )
    .await?;
    put_tag(&public, &credentials).await?;
    let input = payload();
    assert_eq!(
        signed(&http, "replacement", &input).await?,
        reqwest::StatusCode::OK
    );
    let task = receipt(&private, &credentials, "replacement", &input).await?;
    execute(&credentials, directory.path(), &public, &task).await?;
    mock.wait_for(1).await?;
    saved_stage(directory.path(), &["lost-journal"], "sending").await?;
    let mut operator = OperatorClient::connect(public.clone()).await?;
    let page = operator
        .list_reply_deliveries(credentials.operator(ListReplyDeliveriesRequest {
            account_id: format!("linear/{ACCOUNT}"),
            state: 0,
            limit: 10,
            before_order: 0,
        })?)
        .await?
        .into_inner();
    assert_eq!(page.deliveries.len(), 1);
    let first_delivery = &page.deliveries[0];
    let id = first_delivery.reply.as_ref().unwrap().reply_id.clone();
    // A held provider response must not expire a healthy Gateway's claim.
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        let live = operator
            .get_reply_delivery(credentials.operator(GetReplyDeliveryRequest {
                reply_id: id.clone(),
            })?)
            .await?
            .into_inner();
        assert_eq!(live.reply.unwrap().state(), ReplyState::Claimed);
        if live.lease_expires_at_ms.unwrap() > first_delivery.lease_expires_at_ms.unwrap() + 1000 {
            break;
        }
        ensure!(
            Instant::now() < deadline,
            "Gateway did not renew the live provider call"
        );
        sleep(Duration::from_millis(50)).await;
    }
    first.crash()?;
    // The replacement has a different, empty local state directory.
    let (mut replacement, public, _) = gateway(
        &credentials,
        directory.path(),
        &private,
        "fresh-journal",
        &mock,
    )
    .await?;
    let mut operator = OperatorClient::connect(public.clone()).await?;
    // Advance only this disposable fixture's claim clock boundary. Domain tests
    // independently exercise exact real-clock arithmetic and upgrade behavior.
    let mut sql = sqlx::SqliteConnection::connect(&database).await?;
    sqlx::query("UPDATE supertag_v2_replies SET lease_expires_at_ms=0 WHERE reply_id=?")
        .bind(&id)
        .execute(&mut sql)
        .await?;
    sql.close().await?;
    let expired = operator
        .get_reply_delivery(credentials.operator(GetReplyDeliveryRequest {
            reply_id: id.clone(),
        })?)
        .await?
        .into_inner();
    assert_eq!(expired.reply.unwrap().state(), ReplyState::Uncertain);
    assert_eq!(expired.audit[0].kind, "claim-expired");
    let list = operator_cli(
        &credentials,
        &[
            "replies",
            "--gateway",
            &public,
            "list",
            "--account",
            &format!("linear/{ACCOUNT}"),
            "--state",
            "uncertain",
            "--limit",
            "1",
        ],
    )
    .await?;
    assert_eq!(list["deliveries"][0]["reply_id"], id);
    assert_eq!(list["deliveries"][0]["state"], "REPLY_STATE_UNCERTAIN");
    assert_eq!(list["next_before_order"], 0);
    let inspected =
        operator_cli(&credentials, &["replies", "--gateway", &public, "get", &id]).await?;
    assert_eq!(inspected["audit"][0]["kind"], "claim-expired");
    mock.responses.add_permits(1);
    let decision = ResolveReplyRequest {
        reply_id: id.clone(),
        operation_id: "provider-audit".into(),
        state: ReplyState::Delivered.into(),
        provider_receipt: Some(REPLY.into()),
        evidence: "Loopback provider journal confirms this exact comment was accepted.".into(),
    };
    let cli_resolved = operator_cli(
        &credentials,
        &[
            "replies",
            "--gateway",
            &public,
            "resolve",
            &id,
            "--decision",
            "delivered",
            "--provider-receipt",
            REPLY,
            "--evidence",
            &decision.evidence,
            "--operation-id",
            &decision.operation_id,
        ],
    )
    .await?;
    assert_eq!(cli_resolved["state"], "REPLY_STATE_DELIVERED");
    assert_eq!(cli_resolved["provider_receipt"], REPLY);
    assert_eq!(cli_resolved["operation_id"], decision.operation_id);
    let resolved = operator
        .resolve_reply(credentials.operator(decision.clone())?)
        .await?
        .into_inner();
    assert_eq!(
        resolved.reply.as_ref().unwrap().state(),
        ReplyState::Delivered
    );
    assert_eq!(
        resolved,
        operator
            .resolve_reply(credentials.operator(decision)?)
            .await?
            .into_inner()
    );
    // Returning original disk state cannot undo the audited resolution or starve
    // the connector behind its old Sending record.
    let (mut recovered_original, _, _) = gateway(
        &credentials,
        directory.path(),
        &private,
        "lost-journal",
        &mock,
    )
    .await?;
    let deadline = Instant::now() + WAIT;
    loop {
        ensure!(
            recovered_original.child.try_wait()?.is_none(),
            "returning Gateway exited: {}",
            recovered_original.logs()
        );
        let journal = directory.path().join("lost-journal/reply.json");
        let retired = match std::fs::read(journal) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
            Ok(bytes) => serde_json::from_slice::<Value>(&bytes)?["entry"]["stage"] == "claim",
            Err(error) => return Err(error.into()),
        };
        if retired {
            break;
        }
        ensure!(
            Instant::now() < deadline,
            "returning Gateway did not retire its audited old receipt"
        );
        sleep(Duration::from_millis(10)).await;
    }
    let reconciled = operator
        .get_reply_delivery(credentials.operator(GetReplyDeliveryRequest { reply_id: id })?)
        .await?
        .into_inner();
    assert_eq!(reconciled.reply.unwrap().state(), ReplyState::Delivered);
    assert_eq!(
        reconciled.audit.last().unwrap().kind,
        "conflicting-settlement"
    );
    sleep(Duration::from_millis(1100)).await;
    assert_eq!(
        mock.requests.lock().await.len(),
        1,
        "a replacement must never repeat the ambiguous write"
    );
    replacement.stop().await?;
    recovered_original.stop().await?;
    cp.stop().await?;
    Ok(())
}

async fn operator_cli(credentials: &Credentials, args: &[&str]) -> Result<Value> {
    let mut command = credentials.command(args);
    let output = tokio::task::spawn_blocking(move || command.output()).await??;
    ensure!(
        output.status.success(),
        "operator CLI failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}
