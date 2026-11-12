//! Signed HTTP GitHub ingress through separate CP/Gateway/Host processes.
//! Every provider interaction terminates at this test's loopback HTTP server.
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
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use sqlx::Connection;
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
    ensure!(headers.starts_with("POST /repos/acme/project/issues/7/comments HTTP/1.1\r\n"));
    let header = |name: &str| {
        headers
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.trim())
    };
    ensure!(header("authorization") == Some(format!("Bearer {TOKEN}").as_str()));
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
    Ok((process, endpoints[0].clone(), endpoints[1].clone()))
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
    ConnectorClient::connect(private.to_owned())
        .await?
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
            is_pull_request: false,
        })?)
        .await?
        .into_inner()
        .task
        .context("GitHub event was not accepted")
}
async fn put_tag(public: &str, credentials: &Credentials) -> Result<()> {
    OperatorClient::connect(public.to_owned())
        .await?
        .put_tag(credentials.operator(PutTagRequest {
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_github_gateways_deduplicate_and_replay_saved_receipt_after_restart()
-> Result<()> {
    let directory = tempfile::tempdir()?;
    let database = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("github.db").display()
    );
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn github_post_interrupted_after_provider_acceptance_stays_uncertain_after_restart()
-> Result<()> {
    let directory = tempfile::tempdir()?;
    let database = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("github.db").display()
    );
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
