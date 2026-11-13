//! Signed HTTP GitHub ingress through separate CP/Gateway/Host processes.
//! Every provider interaction terminates at this test's loopback HTTP server.
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[path = "support/protocol.rs"]
mod protocol;
#[macro_use]
#[path = "support/database.rs"]
mod database;

use std::{
    collections::BTreeMap,
    fs::File,
    io::{BufRead, BufReader},
    net::SocketAddr,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, ensure};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use supertag_protocol::{
    authenticated_request,
    v2::{
        AcceptGithubEventRequest, GetTaskRequest, GithubEventAction, GithubEventKind,
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
const ACCOUNT: &str = "github-process-test";
const REPOSITORY: &str = "acme/project";
const SIGNING: &str = "synthetic-github-webhook-secret";
const TOKEN: &str = "synthetic-github-api-token";
const APP_TOKEN: &str = "ghs_synthetic-github-installation-token";
// An intentionally public test credential, never registered with a provider.
const APP_KEY: &str = include_str!("../../gateway/src/github/auth/fixtures/app-test-key.pem");

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
            Some(&format!("connector:github/{ACCOUNT}")),
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
                ensure!(
                    !status.success(),
                    "invalid GitHub App configuration was accepted"
                );
                let logs = self.logs();
                ensure!(
                    logs.contains(expected),
                    "expected configuration error {expected}: {logs}"
                );
                ensure!(
                    !logs.contains(APP_KEY) && !logs.contains(APP_TOKEN),
                    "credential appeared in startup logs"
                );
                return Ok(());
            }
            ensure!(
                Instant::now() < deadline,
                "invalid configuration did not exit: {}",
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

struct HttpRequest {
    start: String,
    headers: BTreeMap<String, String>,
    body: Value,
}

async fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest> {
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
    let raw_headers = std::str::from_utf8(&bytes[..end])?;
    let start = raw_headers
        .lines()
        .next()
        .context("missing HTTP request line")?
        .to_owned();
    let headers: BTreeMap<_, _> = raw_headers
        .lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    let length: usize = headers
        .get("content-length")
        .map(String::as_str)
        .unwrap_or("0")
        .parse()?;
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
    Ok(HttpRequest {
        start,
        headers,
        body,
    })
}

async fn mock_request(stream: &mut TcpStream) -> Result<Value> {
    let request = read_http_request(stream).await?;
    ensure!(request.start == "POST /repos/acme/project/issues/7/comments HTTP/1.1");
    ensure!(request.headers.get("authorization") == Some(&format!("Bearer {TOKEN}")));
    Ok(request.body)
}

async fn task_count(database: &str) -> Result<i64> {
    let mut connection = database::connect(database).await?;
    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_tasks")
        .fetch_one(&mut connection)
        .await?)
}

struct MockGithub {
    endpoint: String,
    requests: Arc<Mutex<Vec<Value>>>,
    responses: Arc<Semaphore>,
    server: tokio::task::JoinHandle<Result<()>>,
}
impl MockGithub {
    async fn start() -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = format!("http://{}/", listener.local_addr()?);
        let issue = format!("{endpoint}repos/{REPOSITORY}/issues/7");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let observed = requests.clone();
        let responses = Arc::new(Semaphore::new(0));
        let release = responses.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await?;
                let request =
                    tokio::time::timeout(Duration::from_secs(5), mock_request(&mut stream))
                        .await??;
                observed.lock().await.push(request);
                release.acquire().await?.forget();
                let body = json!({"id":12345,"issue_url":issue}).to_string();
                // A crashed Gateway may have closed its connection after the server
                // accepted the comment. That does not undo the observed provider write.
                let _=stream.write_all(format!("HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await;
                let _ = stream.shutdown().await;
            }
        });
        Ok(Self {
            endpoint,
            requests,
            responses,
            server,
        })
    }
    async fn wait_for(&self, count: usize) -> Result<()> {
        let deadline = Instant::now() + WAIT;
        loop {
            if self.requests.lock().await.len() >= count {
                return Ok(());
            }
            ensure!(!self.server.is_finished(), "mock GitHub server exited");
            ensure!(Instant::now() < deadline, "GitHub comment was not sent");
            sleep(Duration::from_millis(10)).await;
        }
    }
}
impl Drop for MockGithub {
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
    mock: &MockGithub,
) -> Result<(Process, String, String)> {
    let mut command = credentials.command(&[
        "gateway",
        "--control-plane",
        private,
        "--github-listen",
        "127.0.0.1:0",
        "--github-state-directory",
    ]);
    command
        .arg(directory.join(state))
        .env("SUPERTAG_GITHUB_ACCOUNT_ID", ACCOUNT)
        .env("SUPERTAG_GITHUB_REPOSITORY_ID", "123")
        .env("SUPERTAG_GITHUB_REPOSITORY", REPOSITORY)
        .env("SUPERTAG_GITHUB_TAG_ID", "builder")
        .env("SUPERTAG_GITHUB_ALLOWED_USERS", "42")
        .env("SUPERTAG_GITHUB_WEBHOOK_SECRET", SIGNING)
        .env("SUPERTAG_GITHUB_TOKEN", TOKEN)
        .env("SUPERTAG_TEST_GITHUB_API_URL", &mock.endpoint);
    let mut process = Process::spawn(command, directory, state)?;
    let endpoints = process.endpoints(2).await?;
    // Operators and Worker Hosts use the Control Plane; the Gateway serves only its surface.
    Ok((process, private.to_owned(), endpoints[1].clone()))
}
fn payload() -> Value {
    json!({"action":"created","sender":{"id":42,"type":"User"},"repository":{"id":123,"full_name":REPOSITORY},"issue":{"number":7},"comment":{"id":456,"body":"@supertag inspect the repository"}})
}
async fn signed(endpoint: &str, id: &str, payload: &Value) -> Result<reqwest::StatusCode> {
    let body = payload.to_string();
    let mut mac = Hmac::<Sha256>::new_from_slice(SIGNING.as_bytes())?;
    mac.update(body.as_bytes());
    Ok(reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()?
        .post(format!("{endpoint}/github/events"))
        .header("content-type", "application/json")
        .header("x-github-delivery", id)
        .header("x-github-event", "issue_comment")
        .header(
            "x-hub-signature-256",
            format!("sha256={:x}", mac.finalize().into_bytes()),
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
    ConnectorClient::new(protocol::dial(private.to_owned()).await?)
        .accept_github_event(credentials.connector(AcceptGithubEventRequest {
            account_id: format!("github/{ACCOUNT}"),
            delivery_id: id.into(),
            repository_id: 123,
            repository: REPOSITORY.into(),
            number: 7,
            source_id: payload["comment"]["id"].as_u64().unwrap(),
            kind: GithubEventKind::IssueComment.into(),
            action: if payload["action"] == "edited" {
                GithubEventAction::Edited.into()
            } else {
                GithubEventAction::Created.into()
            },
            prompt: payload["comment"]["body"].as_str().unwrap().into(),
            tag_id: "builder".into(),
            is_pull_request: payload["issue"].get("pull_request").is_some(),
        })?)
        .await?
        .into_inner()
        .task
        .context("GitHub event was not accepted")
}
async fn put_tag(public: &str, credentials: &Credentials) -> Result<()> {
    OperatorClient::new(protocol::dial(public.to_owned()).await?)
        .put_tag(credentials.operator(PutTagRequest {
            name: None,
            expected_revision: None,
            execution: None,
            approval_rules: vec![],
            tag_id: "builder".into(),
            instructions: "GitHub fixture".into(),
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
        "--control-plane",
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
            "GitHub reply did not reach expected settlement"
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
            "GitHub delivery journal did not reach {stage}"
        );
        sleep(Duration::from_millis(10)).await;
    }
}

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    concurrent_github_gateways_deduplicate_and_replay_saved_receipt_after_restart;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    github_post_interrupted_after_provider_acceptance_stays_uncertain_after_restart;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    github_app_cli_authenticates_signed_pr_discussion_and_reuses_scoped_token;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    github_app_cli_rejects_ambiguous_env_and_unsafe_private_key_files;
}

async fn concurrent_github_gateways_deduplicate_and_replay_saved_receipt_after_restart(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let credentials = Credentials::new();
    let mock = MockGithub::start().await?;
    let (mut cp, private) = control(&credentials, directory.path(), &database, None).await?;
    let (mut first, public, http) =
        gateway(&credentials, directory.path(), &private, "first", &mock).await?;
    let (mut second, _, second_http) =
        gateway(&credentials, directory.path(), &private, "second", &mock).await?;
    put_tag(&public, &credentials).await?;
    for (pointer, value) in [
        ("/sender/type", json!("Bot")),
        ("/sender/id", json!(43)),
        ("/comment/body", json!("without a mention")),
    ] {
        let mut ignored = payload();
        *ignored.pointer_mut(pointer).unwrap() = value;
        assert_eq!(
            signed(&http, "ignored", &ignored).await?,
            reqwest::StatusCode::ACCEPTED
        );
    }
    let mut wrong = payload();
    wrong["repository"]["id"] = 124.into();
    assert_eq!(
        signed(&http, "wrong-repository", &wrong).await?,
        reqwest::StatusCode::FORBIDDEN
    );
    assert_eq!(task_count(&database).await?, 0);
    let input = payload();
    let (left, right) = tokio::join!(
        signed(&http, "delivery-one", &input),
        signed(&second_http, "delivery-one", &input)
    );
    assert_eq!(left?, reqwest::StatusCode::ACCEPTED);
    assert_eq!(right?, reqwest::StatusCode::ACCEPTED);
    let task = receipt(&private, &credentials, "delivery-one", &input).await?;
    assert_eq!(task_count(&database).await?, 1);
    execute(&credentials, directory.path(), &public, &task).await?;
    mock.wait_for(1).await?;
    cp.stop().await?;
    mock.responses.add_permits(1);
    let journal = saved_stage(directory.path(), &["first", "second"], "settle").await?;
    assert_eq!(journal["provider"], "github");
    assert_eq!(journal["account_id"], format!("github/{ACCOUNT}"));
    assert_eq!(journal["entry"]["outcome"]["provider_receipt"], "12345");
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
        Some("12345")
    );
    assert_eq!(
        signed(&http, "delivery-one", &input).await?,
        reqwest::StatusCode::ACCEPTED
    );
    let mut changed = input.clone();
    changed["comment"]["body"] = "@supertag changed body".into();
    assert_eq!(
        signed(&second_http, "delivery-one", &changed).await?,
        reqwest::StatusCode::CONFLICT
    );
    changed["action"] = "edited".into();
    assert_eq!(
        signed(&second_http, "delivery-edit", &changed).await?,
        reqwest::StatusCode::ACCEPTED
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

async fn github_post_interrupted_after_provider_acceptance_stays_uncertain_after_restart(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let credentials = Credentials::new();
    let mock = MockGithub::start().await?;
    let (mut cp, private) = control(&credentials, directory.path(), &database, None).await?;
    let (mut gateway_process, public, http) =
        gateway(&credentials, directory.path(), &private, "gateway", &mock).await?;
    put_tag(&public, &credentials).await?;
    let input = payload();
    assert_eq!(
        signed(&http, "delivery-one", &input).await?,
        reqwest::StatusCode::ACCEPTED
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
        reqwest::StatusCode::ACCEPTED
    );
    assert_eq!(task_count(&database).await?, 1);
    assert_eq!(mock.requests.lock().await.len(), 1);
    restarted.stop().await?;
    cp.stop().await?;
    Ok(())
}

struct MockGithubApp {
    endpoint: String,
    observed: Arc<Mutex<Vec<&'static str>>>,
    server: tokio::task::JoinHandle<Result<()>>,
}

impl MockGithubApp {
    async fn start(journal: PathBuf) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = format!("http://{}/", listener.local_addr()?);
        let issue = format!("{endpoint}repos/{REPOSITORY}/issues/7");
        let observed = Arc::new(Mutex::new(Vec::new()));
        let requests = observed.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await?;
                let request =
                    tokio::time::timeout(Duration::from_secs(5), read_http_request(&mut stream))
                        .await??;
                let stored: Value = serde_json::from_slice(&std::fs::read(&journal)?)?;
                let (kind, status, body) = match request.start.as_str() {
                    "GET /repos/acme/project/installation HTTP/1.1" => {
                        ensure!(
                            stored["entry"]["stage"] == "claim",
                            "installation lookup followed Sending"
                        );
                        verify_app_header(&request)?;
                        (
                            "installation",
                            "200 OK",
                            json!({"id":88,"app_id":77,"account":{"login":"acme"},"suspended_at":null}),
                        )
                    }
                    "POST /app/installations/88/access_tokens HTTP/1.1" => {
                        ensure!(
                            stored["entry"]["stage"] == "claim",
                            "token mint followed Sending"
                        );
                        verify_app_header(&request)?;
                        ensure!(
                            request.body
                                == json!({"repository_ids":[123],"permissions":{"issues":"write"}}),
                            "installation token scope was broadened"
                        );
                        let expires =
                            chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now())
                                + chrono::TimeDelta::hours(1);
                        (
                            "mint",
                            "201 Created",
                            json!({"token":APP_TOKEN,"expires_at":expires.to_rfc3339(),"permissions":{"issues":"write","metadata":"read"},"repository_selection":"selected","repositories":[{"id":123,"full_name":REPOSITORY}]}),
                        )
                    }
                    "POST /repos/acme/project/issues/7/comments HTTP/1.1" => {
                        ensure!(
                            stored["entry"]["stage"] == "sending",
                            "comment sent without durable intent"
                        );
                        ensure!(
                            request.headers.get("authorization")
                                == Some(&format!("Bearer {APP_TOKEN}")),
                            "comment did not use installation credentials"
                        );
                        ensure!(
                            request.body["body"]
                                .as_str()
                                .is_some_and(|body| !body.is_empty())
                        );
                        (
                            "comment",
                            "201 Created",
                            json!({"id":67890,"issue_url":issue}),
                        )
                    }
                    _ => anyhow::bail!("unexpected GitHub App API route"),
                };
                let journal_text = stored.to_string();
                ensure!(
                    !journal_text.contains(APP_TOKEN)
                        && !journal_text.contains("PRIVATE KEY")
                        && !journal_text.contains("eyJ"),
                    "provider credentials persisted in journal"
                );
                requests.lock().await.push(kind);
                let body = body.to_string();
                stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await?;
                stream.shutdown().await?;
            }
        });
        Ok(Self {
            endpoint,
            observed,
            server,
        })
    }

    async fn wait_comments(&self, count: usize) -> Result<()> {
        let deadline = Instant::now() + WAIT;
        loop {
            if self
                .observed
                .lock()
                .await
                .iter()
                .filter(|kind| **kind == "comment")
                .count()
                >= count
            {
                return Ok(());
            }
            ensure!(
                !self.server.is_finished(),
                "GitHub App HTTP fixture rejected a request"
            );
            ensure!(Instant::now() < deadline, "GitHub App comment was not sent");
            sleep(Duration::from_millis(10)).await;
        }
    }
}

impl Drop for MockGithubApp {
    fn drop(&mut self) {
        self.server.abort();
    }
}

fn verify_app_header(request: &HttpRequest) -> Result<()> {
    let bearer = request
        .headers
        .get("authorization")
        .context("missing App authorization")?;
    let jwt = bearer
        .strip_prefix("Bearer ")
        .context("invalid App authorization scheme")?;
    // Signature and exact claim bounds are independently verified in Gateway's real HTTP tests.
    ensure!(
        jwt.starts_with("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.") && jwt.split('.').count() == 3,
        "App request did not carry its RS256 JWT"
    );
    ensure!(
        request
            .headers
            .get("x-github-api-version")
            .map(String::as_str)
            == Some("2022-11-28")
    );
    Ok(())
}

fn private_app_key(directory: &Path) -> Result<PathBuf> {
    let path = directory.join("app-key.pem");
    std::fs::write(&path, APP_KEY)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    Ok(path)
}

fn app_gateway_command(
    credentials: &Credentials,
    directory: &Path,
    private: &str,
    state: &str,
    key: &Path,
    api: &str,
) -> Command {
    let mut command = credentials.command(&[
        "gateway",
        "--control-plane",
        private,
        "--github-listen",
        "127.0.0.1:0",
        "--github-state-directory",
    ]);
    command
        .arg(directory.join(state))
        .env("SUPERTAG_GITHUB_ACCOUNT_ID", ACCOUNT)
        .env("SUPERTAG_GITHUB_REPOSITORY_ID", "123")
        .env("SUPERTAG_GITHUB_REPOSITORY", REPOSITORY)
        .env("SUPERTAG_GITHUB_TAG_ID", "builder")
        .env("SUPERTAG_GITHUB_ALLOWED_USERS", "42")
        .env("SUPERTAG_GITHUB_WEBHOOK_SECRET", SIGNING)
        .env("SUPERTAG_GITHUB_APP_ID", "77")
        .env("SUPERTAG_GITHUB_INSTALLATION_ID", "88")
        .env("SUPERTAG_GITHUB_PRIVATE_KEY_FILE", key)
        .env("SUPERTAG_TEST_GITHUB_API_URL", api);
    command
}

async fn github_app_cli_authenticates_signed_pr_discussion_and_reuses_scoped_token(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let credentials = Credentials::new();
    let key = private_app_key(directory.path())?;
    let mock = MockGithubApp::start(directory.path().join("app-gateway/reply.json")).await?;
    let (mut cp, private) = control(&credentials, directory.path(), &database, None).await?;
    let mut gateway = Process::spawn(
        app_gateway_command(
            &credentials,
            directory.path(),
            &private,
            "app-gateway",
            &key,
            &mock.endpoint,
        ),
        directory.path(),
        "app-gateway",
    )?;
    let endpoints = gateway.endpoints(2).await?;
    let public = &private;
    let http = &endpoints[1];
    put_tag(public, &credentials).await?;
    let mut input = payload();
    // General PR discussion uses the issue-comments endpoint and its Issues write scope.
    input["issue"]["pull_request"] = json!({});
    assert_eq!(
        signed(http, "missing-installation", &input).await?,
        reqwest::StatusCode::FORBIDDEN
    );
    input["installation"] = json!({"id":99});
    assert_eq!(
        signed(http, "wrong-installation", &input).await?,
        reqwest::StatusCode::FORBIDDEN
    );
    assert_eq!(task_count(&database).await?, 0);
    input["installation"] = json!({"id":88});
    assert_eq!(
        signed(http, "app-delivery-one", &input).await?,
        reqwest::StatusCode::ACCEPTED
    );
    let first = receipt(&private, &credentials, "app-delivery-one", &input).await?;
    execute(&credentials, directory.path(), public, &first).await?;
    mock.wait_comments(1).await?;
    assert_eq!(
        settled(&database, &first, ReplyState::Delivered)
            .await?
            .as_deref(),
        Some("67890")
    );
    assert_eq!(
        *mock.observed.lock().await,
        vec!["installation", "mint", "comment"]
    );
    input["comment"]["id"] = json!(457);
    input["comment"]["body"] = json!("@supertag follow up on the review");
    assert_eq!(
        signed(http, "app-delivery-two", &input).await?,
        reqwest::StatusCode::ACCEPTED
    );
    let second = receipt(&private, &credentials, "app-delivery-two", &input).await?;
    execute(&credentials, directory.path(), public, &second).await?;
    mock.wait_comments(2).await?;
    assert_eq!(
        settled(&database, &second, ReplyState::Delivered)
            .await?
            .as_deref(),
        Some("67890")
    );
    assert_eq!(
        *mock.observed.lock().await,
        vec!["installation", "mint", "comment", "comment"]
    );
    let logs = gateway.logs();
    ensure!(
        !logs.contains(APP_TOKEN) && !logs.contains(APP_KEY),
        "App credentials appeared in Gateway logs"
    );
    gateway.stop().await?;
    cp.stop().await?;
    Ok(())
}

async fn github_app_cli_rejects_ambiguous_env_and_unsafe_private_key_files(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let credentials = Credentials::new();
    let key = private_app_key(directory.path())?;
    let (mut cp, private) = control(&credentials, directory.path(), &database, None).await?;
    let command = |state: &str, path: &Path| {
        app_gateway_command(
            &credentials,
            directory.path(),
            &private,
            state,
            path,
            "http://127.0.0.1:1/",
        )
    };
    let mut mixed = command("mixed", &key);
    mixed.env("SUPERTAG_GITHUB_TOKEN", TOKEN);
    Process::spawn(mixed, directory.path(), "mixed")?
        .rejected("select one GitHub authentication mode")
        .await?;
    let mut incomplete = command("incomplete", &key);
    incomplete.env_remove("SUPERTAG_GITHUB_INSTALLATION_ID");
    Process::spawn(incomplete, directory.path(), "incomplete")?
        .rejected("SUPERTAG_GITHUB_INSTALLATION_ID")
        .await?;
    let mut missing = command("missing", &key);
    missing.env_remove("SUPERTAG_GITHUB_PRIVATE_KEY_FILE");
    Process::spawn(missing, directory.path(), "missing")?
        .rejected("SUPERTAG_GITHUB_PRIVATE_KEY_FILE")
        .await?;
    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o644))?;
    Process::spawn(command("public-key", &key), directory.path(), "public-key")?
        .rejected("owner-only regular file")
        .await?;
    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600))?;
    let link = directory.path().join("key-link.pem");
    symlink(&key, &link)?;
    Process::spawn(command("linked-key", &link), directory.path(), "linked-key")?
        .rejected("open GitHub App private key")
        .await?;
    Process::spawn(
        command("directory-key", directory.path()),
        directory.path(),
        "directory-key",
    )?
    .rejected("owner-only regular file")
    .await?;
    let fifo = directory.path().join("key-pipe");
    let fifo_name = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes())?;
    ensure!(unsafe { libc::mkfifo(fifo_name.as_ptr(), 0o600) } == 0);
    Process::spawn(command("pipe-key", &fifo), directory.path(), "pipe-key")?
        .rejected("owner-only regular file")
        .await?;
    std::fs::write(&key, "invalid private key")?;
    Process::spawn(
        command("malformed-key", &key),
        directory.path(),
        "malformed-key",
    )?
    .rejected("invalid GitHub App private key PEM")
    .await?;
    cp.stop().await?;
    Ok(())
}
