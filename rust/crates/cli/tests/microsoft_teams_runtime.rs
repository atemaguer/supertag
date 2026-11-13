//! Microsoft-signed Bot Connector activities through real split runtime processes.
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
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use supertag_protocol::{
    authenticated_request,
    v2::{
        AcceptMicrosoftTeamsActivityRequest, GetTaskRequest, PutTagRequest, ReplyState, Task,
        TaskState, connector_client::ConnectorClient, operator_client::OperatorClient,
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
const ACCOUNT: &str = "microsoft-teams-fixture";
const APP: &str = "11111111-1111-4111-8111-111111111111";
const TENANT: &str = "22222222-2222-4222-8222-222222222222";
const TEAM: &str = "33333333-3333-4333-8333-333333333333";
const USER: &str = "44444444-4444-4444-8444-444444444444";
const CHANNEL: &str = "19:channel@thread.tacv2";
const CONVERSATION: &str = "19:conversation@thread.tacv2";
const ROOT: &str = "1741000000000";
const SERVICE: &str = "https://smba.trafficmanager.net/amer/";
const SECRET: &str = "synthetic-microsoft-client-secret";
const TOKEN: &str = "synthetic-microsoft-bot-token";
use supertag_gateway::microsoft_teams::fixtures;

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
            Some(&format!("connector:teams/{ACCOUNT}")),
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
            instructions: "Teams fixture <at>everyone</at>".into(),
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
            "Microsoft Teams delivery journal did not reach {stage}"
        );
        sleep(Duration::from_millis(10)).await;
    }
}

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    microsoft_signed_activity_and_threaded_reply_survive_split_process_restarts;
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    microsoft_interrupted_post_is_uncertain_without_duplicate_reply;
}

async fn read_request(stream: &mut TcpStream) -> Result<(String, String, Vec<u8>)> {
    let mut bytes = Vec::new();
    let mut buffer = [0; 4096];
    let end = loop {
        if let Some(index) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            break index + 4;
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
            .map(|(_, v)| v.trim())
    };
    let auth = header("authorization").unwrap_or("").to_string();
    let len: usize = header("content-length").unwrap_or("0").parse()?;
    ensure!(len <= 262144);
    while bytes.len() < end + len {
        let n = stream.read(&mut buffer).await?;
        ensure!(n > 0);
        bytes.extend_from_slice(&buffer[..n]);
    }
    Ok((path, auth, bytes[end..end + len].to_vec()))
}
struct MockMicrosoft {
    origin: String,
    requests: Arc<Mutex<Vec<Value>>>,
    responses: Arc<Semaphore>,
    kid: Arc<Mutex<String>>,
    key_fetches: Arc<AtomicUsize>,
    tokens: Arc<AtomicUsize>,
    server: tokio::task::JoinHandle<Result<()>>,
}
impl MockMicrosoft {
    async fn start() -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let origin = format!("http://{}/", listener.local_addr()?);
        let base = origin.clone();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let observed = requests.clone();
        let responses = Arc::new(Semaphore::new(0));
        let release = responses.clone();
        let kid = Arc::new(Mutex::new("first".to_string()));
        let signing = kid.clone();
        let key_fetches = Arc::new(AtomicUsize::new(0));
        let keys = key_fetches.clone();
        let tokens = Arc::new(AtomicUsize::new(0));
        let token_count = tokens.clone();
        let server = tokio::spawn(async move {
            let mut children = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                 accepted=listener.accept()=>{let(mut stream,_)=accepted?;let base=base.clone();let observed=observed.clone();let release=release.clone();let signing=signing.clone();let keys=keys.clone();let token_count=token_count.clone();children.spawn(async move{
                  let(path,auth,body)=tokio::time::timeout(Duration::from_secs(5),read_request(&mut stream)).await??;
                  let value=if path=="/v1/.well-known/openidconfiguration" {json!({"issuer":"https://api.botframework.com","id_token_signing_alg_values_supported":["RS256"],"jwks_uri":format!("{base}v1/.well-known/keys")})}
                  else if path=="/v1/.well-known/keys"{keys.fetch_add(1,Ordering::SeqCst);fixtures::jwks(&signing.lock().await)}
                  else if path==format!("/{TENANT}/oauth2/v2.0/token") {let form=std::str::from_utf8(&body)?;ensure!(form.contains(&format!("client_id={APP}"))&&form.contains(&format!("client_secret={SECRET}"))&&form.contains("grant_type=client_credentials")&&form.contains("scope=https%3A%2F%2Fapi.botframework.com%2F.default"));token_count.fetch_add(1,Ordering::SeqCst);json!({"access_token":TOKEN,"token_type":"Bearer","expires_in":3600})}
                  else {let mut expected=reqwest::Url::parse(&base)?;expected.set_path("/amer/");expected.path_segments_mut().unwrap().pop_if_empty().extend(["v3","conversations",&format!("{CONVERSATION};messageid={ROOT}"),"activities"]);ensure!(path==expected.path(),"unexpected Microsoft endpoint");ensure!(auth==format!("Bearer {TOKEN}"));let value:Value=serde_json::from_slice(&body)?;ensure!(value["conversation"]["id"]==format!("{CONVERSATION};messageid={ROOT}"));ensure!(value["from"]==json!({"id":APP,"role":"bot"}));ensure!(value["type"]=="message"&&value["textFormat"]=="markdown");ensure!(value["text"].as_str().is_some_and(|v|v.contains("Teams fixture ‹at›everyone‹/at›")&&!v.contains("<at>")));observed.lock().await.push(value);release.acquire().await?.forget();json!({"id":"1741000000099"})};
                  let body=value.to_string();let _=stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await;Ok::<_,anyhow::Error>(())
                 });},
                 joined=children.join_next(),if !children.is_empty()=>{joined.context("fixture child missing")???;}
                }
            }
        });
        Ok(Self {
            origin,
            requests,
            responses,
            kid,
            key_fetches,
            tokens,
            server,
        })
    }
    async fn wait_for(&self, count: usize) -> Result<()> {
        let deadline = Instant::now() + WAIT;
        loop {
            if self.requests.lock().await.len() >= count {
                return Ok(());
            }
            ensure!(!self.server.is_finished(), "Microsoft fixture stopped");
            ensure!(Instant::now() < deadline, "Microsoft reply missing");
            sleep(Duration::from_millis(10)).await;
        }
    }
}
impl Drop for MockMicrosoft {
    fn drop(&mut self) {
        self.server.abort();
    }
}
async fn gateway(
    credentials: &Credentials,
    directory: &Path,
    private: &str,
    state: &str,
    mock: &MockMicrosoft,
) -> Result<(Process, String, String)> {
    let mut command = credentials.command(&[
        "gateway",
        "--control-plane",
        private,
        "--microsoft-teams-listen",
        "127.0.0.1:0",
        "--microsoft-teams-state-directory",
    ]);
    command
        .arg(directory.join(state))
        .env("SUPERTAG_MICROSOFT_TEAMS_ACCOUNT_ID", ACCOUNT)
        .env("SUPERTAG_MICROSOFT_TEAMS_APP_ID", APP)
        .env("SUPERTAG_MICROSOFT_TEAMS_APP_SECRET", SECRET)
        .env("SUPERTAG_MICROSOFT_TEAMS_TENANT_ID", TENANT)
        .env("SUPERTAG_MICROSOFT_TEAMS_TEAM_ID", TEAM)
        .env("SUPERTAG_MICROSOFT_TEAMS_CHANNEL_ID", CHANNEL)
        .env("SUPERTAG_MICROSOFT_TEAMS_TAG_ID", "builder")
        .env("SUPERTAG_MICROSOFT_TEAMS_ALLOWED_USERS", USER)
        .env("SUPERTAG_TEST_MICROSOFT_TEAMS_ORIGIN", &mock.origin);
    let mut process = Process::spawn(command, directory, state)?;
    let endpoints = process.endpoints(2).await?;
    Ok((process, endpoints[0].clone(), endpoints[1].clone()))
}
fn payload(id: &str) -> Value {
    json!({"type":"message","id":id,"replyToId":ROOT,"serviceUrl":SERVICE,"channelId":"msteams","from":{"id":"29:alice","aadObjectId":USER},"recipient":{"id":format!("28:{APP}")},"conversation":{"id":CONVERSATION,"conversationType":"channel","tenantId":TENANT},"text":"<at>SuperTag</at> inspect","entities":[{"type":"mention","text":"<at>SuperTag</at>","mentioned":{"id":format!("28:{APP}")}}],"channelData":{"tenant":{"id":TENANT},"team":{"id":"19:internal","aadGroupId":TEAM},"channel":{"id":CHANNEL}}})
}
fn claims() -> Value {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    json!({"iss":"https://api.botframework.com","aud":APP,"exp":now+3600,"nbf":now-60,"serviceurl":SERVICE})
}
async fn signed(
    endpoint: &str,
    body: &Value,
    claims: Value,
    kid: &str,
) -> Result<reqwest::StatusCode> {
    send(endpoint, body, &fixtures::token(claims, kid)).await
}
async fn send(endpoint: &str, body: &Value, token: &str) -> Result<reqwest::StatusCode> {
    Ok(reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()?
        .post(format!("{endpoint}/microsoft-teams/messages"))
        .bearer_auth(token)
        .json(body)
        .send()
        .await?
        .status())
}
async fn receipt(private: &str, credentials: &Credentials, id: &str) -> Result<Task> {
    ConnectorClient::new(protocol::dial(private.to_owned()).await?)
        .accept_microsoft_teams_activity(credentials.connector(
            AcceptMicrosoftTeamsActivityRequest {
                account_id: format!("teams/{ACCOUNT}"),
                app_id: APP.into(),
                tenant_id: TENANT.into(),
                team_id: TEAM.into(),
                channel_id: CHANNEL.into(),
                conversation_id: CONVERSATION.into(),
                activity_id: id.into(),
                root_activity_id: ROOT.into(),
                actor_id: USER.into(),
                service_url: SERVICE.into(),
                prompt: "inspect".into(),
                tag_id: "builder".into(),
            },
        )?)
        .await?
        .into_inner()
        .task
        .context("Microsoft activity missing")
}
async fn microsoft_signed_activity_and_threaded_reply_survive_split_process_restarts(
    database: String,
) -> Result<()> {
    let dir = tempfile::tempdir()?;
    let credentials = Credentials::new();
    let mock = MockMicrosoft::start().await?;
    let (mut cp, private) = control(&credentials, dir.path(), &database, None).await?;
    let (mut first, public, web) =
        gateway(&credentials, dir.path(), &private, "first", &mock).await?;
    put_tag(&public, &credentials).await?;
    let body = payload("1741000000001");
    for (field, value) in [
        ("iss", json!("wrong")),
        ("aud", json!(TENANT)),
        ("exp", json!(1)),
        ("nbf", json!(9999999999_i64)),
        ("serviceurl", json!("https://untrusted.example/")),
    ] {
        let mut c = claims();
        c[field] = value;
        assert_eq!(signed(&web, &body, c, "first").await?, 401, "{field}");
    }
    let mut bad_signature = fixtures::token(claims(), "first").into_bytes();
    let middle = bad_signature.len() - 20;
    bad_signature[middle] = if bad_signature[middle] == b'A' {
        b'B'
    } else {
        b'A'
    };
    assert_eq!(
        send(&web, &body, std::str::from_utf8(&bad_signature)?).await?,
        401
    );
    for field in ["tenant", "recipient"] {
        let mut bad = body.clone();
        if field == "tenant" {
            bad["channelData"]["tenant"]["id"] = APP.into();
        } else {
            bad["recipient"]["id"] = "28:another-app".into();
        }
        assert_eq!(signed(&web, &bad, claims(), "first").await?, 403);
    }
    for field in ["mention", "bot", "user", "channel"] {
        let mut ignored = body.clone();
        match field {
            "mention" => ignored["entities"] = json!([]),
            "bot" => ignored["from"]["role"] = "bot".into(),
            "user" => ignored["from"]["aadObjectId"] = APP.into(),
            _ => ignored["channelData"]["channel"]["id"] = "19:other".into(),
        };
        assert_eq!(signed(&web, &ignored, claims(), "first").await?, 200);
    }
    assert_eq!(task_count(&database).await?, 0);
    cp.stop().await?;
    assert_eq!(signed(&web, &body, claims(), "first").await?, 503);
    let (mut cp, _) = control(&credentials, dir.path(), &database, Some(&private)).await?;
    let (mut second, _, other_web) =
        gateway(&credentials, dir.path(), &private, "second", &mock).await?;
    let (a, b) = tokio::join!(
        signed(&web, &body, claims(), "first"),
        signed(&other_web, &body, claims(), "first")
    );
    assert_eq!(a?, 200);
    assert_eq!(b?, 200);
    second.stop().await?;
    let task = receipt(&private, &credentials, "1741000000001").await?;
    assert_eq!(task_count(&database).await?, 1);
    let mut conflict = body.clone();
    conflict["text"] = "<at>SuperTag</at> changed".into();
    assert_eq!(signed(&web, &conflict, claims(), "first").await?, 409);
    // Unknown kid triggers bounded key rotation refresh, not disabled verification.
    *mock.kid.lock().await = "rotated".into();
    assert_eq!(signed(&web, &body, claims(), "rotated").await?, 200);
    assert!(mock.key_fetches.load(Ordering::SeqCst) >= 3);
    let cached_fetches = mock.key_fetches.load(Ordering::SeqCst);
    assert_eq!(signed(&web, &body, claims(), "untrusted-kid").await?, 401);
    assert_eq!(mock.key_fetches.load(Ordering::SeqCst), cached_fetches);
    execute(&credentials, dir.path(), &public, &task).await?;
    mock.wait_for(1).await?;
    cp.stop().await?;
    mock.responses.add_permits(1);
    saved_stage(dir.path(), &["first"], "settle").await?;
    first.crash()?;
    let (mut cp, _) = control(&credentials, dir.path(), &database, Some(&private)).await?;
    let (mut restarted, public, web) =
        gateway(&credentials, dir.path(), &private, "first", &mock).await?;
    assert_eq!(
        settled(&database, &task, ReplyState::Delivered)
            .await?
            .as_deref(),
        Some("1741000000099")
    );
    assert_eq!(mock.requests.lock().await.len(), 1);
    assert_eq!(signed(&web, &body, claims(), "rotated").await?, 200);
    let follow = payload("1741000000002");
    assert_eq!(signed(&web, &follow, claims(), "rotated").await?, 200);
    let next = receipt(&private, &credentials, "1741000000002").await?;
    assert_eq!(next.session_id, task.session_id);
    mock.responses.add_permits(1);
    execute(&credentials, dir.path(), &public, &next).await?;
    settled(&database, &next, ReplyState::Delivered).await?;
    assert_eq!(task_count(&database).await?, 2);
    assert_eq!(mock.requests.lock().await.len(), 2);
    assert_eq!(mock.tokens.load(Ordering::SeqCst), 2);
    assert!(!restarted.logs().contains(SECRET) && !restarted.logs().contains(TOKEN));
    restarted.stop().await?;
    cp.stop().await?;
    Ok(())
}
async fn microsoft_interrupted_post_is_uncertain_without_duplicate_reply(
    database: String,
) -> Result<()> {
    let dir = tempfile::tempdir()?;
    let credentials = Credentials::new();
    let mock = MockMicrosoft::start().await?;
    let (mut cp, private) = control(&credentials, dir.path(), &database, None).await?;
    let (mut gateway_process, public, web) =
        gateway(&credentials, dir.path(), &private, "gateway", &mock).await?;
    put_tag(&public, &credentials).await?;
    let body = payload("1741000000001");
    assert_eq!(signed(&web, &body, claims(), "first").await?, 200);
    let task = receipt(&private, &credentials, "1741000000001").await?;
    execute(&credentials, dir.path(), &public, &task).await?;
    mock.wait_for(1).await?;
    saved_stage(dir.path(), &["gateway"], "sending").await?;
    gateway_process.crash()?;
    let (mut restarted, _, web) =
        gateway(&credentials, dir.path(), &private, "gateway", &mock).await?;
    assert_eq!(
        settled(&database, &task, ReplyState::Uncertain).await?,
        None
    );
    mock.responses.add_permits(1);
    assert_eq!(signed(&web, &body, claims(), "first").await?, 200);
    assert_eq!(task_count(&database).await?, 1);
    assert_eq!(mock.requests.lock().await.len(), 1);
    restarted.stop().await?;
    cp.stop().await?;
    Ok(())
}
