//! Coordination and safety features through separate Control Plane, Gateway, and Worker Host
//! processes: Objective overlap warnings, Worker-managed effect receipts, and a Slack message
//! that selects an authorized GitHub Workspace.
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[macro_use]
#[path = "support/database.rs"]
mod database;

use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, ensure};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    process::{Child, Command},
    sync::Mutex,
    time::{sleep, timeout},
};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(30);

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
            .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &self.gateway)
            .env("SUPERTAG_GATEWAY_CREDENTIAL", &self.gateway)
            .env("SUPERTAG_OPERATOR_TOKEN", &self.operator)
            .env("SUPERTAG_HOST_TOKEN", &self.host)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &self.host)
            .stdin(Stdio::null())
            .kill_on_drop(true);
        command
    }

    fn worker(&self, public: &str, state: &Path, source: Option<&Path>, modes: &[&str]) -> Command {
        let mut command = self.command(&[
            "worker-host",
            "--control-plane",
            public,
            "--adapter",
            ADAPTER,
            "--once",
        ]);
        for mode in modes {
            command.arg(format!("--adapter-arg={mode}"));
        }
        command.arg("--state-directory").arg(state);
        if let Some(source) = source {
            command
                .args(["--workspace-id", "project", "--workspace-source"])
                .arg(source);
        }
        command
    }
}

/// A Control Plane with optional extra arguments, and a Gateway when a scenario needs surfaces.
struct Services {
    plane: Child,
    gateway: Option<Child>,
    public: String,
    extra: Vec<String>,
}

impl Services {
    async fn start(
        credentials: &Credentials,
        database: &str,
        plane: impl Fn(&mut Command),
    ) -> Result<Self> {
        let mut command = credentials.command(&["control-plane"]);
        command.env("SUPERTAG_DATABASE_URL", database);
        plane(&mut command);
        let (plane, mut public) = service(command, 1).await?;
        Ok(Self {
            plane,
            gateway: None,
            public: public.remove(0),
            extra: Vec::new(),
        })
    }

    /// Also starts a Gateway configured by `gateway`, and keeps the `lines - 1` listener
    /// addresses it reports after its own.
    async fn with_gateway(
        credentials: &Credentials,
        database: &str,
        gateway: impl Fn(&mut Command),
        lines: usize,
    ) -> Result<Self> {
        let mut services = Self::start(credentials, database, |_| {}).await?;
        let mut command = credentials.command(&["gateway", "--control-plane", &services.public]);
        gateway(&mut command);
        let (gateway, mut endpoints) = service(command, lines).await?;
        endpoints.remove(0);
        services.gateway = Some(gateway);
        services.extra = endpoints;
        Ok(services)
    }

    fn cli(&self, credentials: &Credentials, args: &[&str]) -> Command {
        let mut command = credentials.command(&[args[0], "--control-plane", &self.public]);
        command.args(&args[1..]);
        command
    }

    async fn stop(mut self) -> Result<()> {
        if let Some(gateway) = &mut self.gateway {
            gateway.kill().await?;
        }
        self.plane.kill().await?;
        Ok(())
    }
}

async fn service(mut command: Command, lines: usize) -> Result<(Child, Vec<String>)> {
    let mut child = command.stdout(Stdio::piped()).spawn()?;
    let mut stdout = BufReader::new(child.stdout.take().context("service stdout missing")?);
    let mut endpoints = Vec::new();
    for _ in 0..lines {
        let mut line = String::new();
        timeout(WAIT, stdout.read_line(&mut line))
            .await
            .context("service startup timed out")??;
        let address: SocketAddr = line.trim().parse().context("service endpoint missing")?;
        ensure!(address.ip().is_loopback() && address.port() != 0);
        endpoints.push(format!("http://{address}"));
    }
    Ok((child, endpoints))
}

async fn output(mut command: Command) -> Result<std::process::Output> {
    Ok(timeout(WAIT, command.output())
        .await
        .context("command timed out")??)
}

async fn success(command: Command) -> Result<std::process::Output> {
    let output = output(command).await?;
    ensure!(
        output.status.success(),
        "command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(output)
}

async fn json(command: Command) -> Result<Value> {
    Ok(serde_json::from_slice(&success(command).await?.stdout)?)
}

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value[name]
        .as_str()
        .with_context(|| format!("missing {name}: {value}"))
}

fn spec(root: &Path, name: &str, value: Value) -> Result<String> {
    let file = root.join(name);
    std::fs::write(&file, serde_json::to_vec(&value)?)?;
    Ok(file.to_str().context("spec path")?.into())
}

async fn git(source: &Path, arguments: &[&str]) -> Result<String> {
    let mut command = Command::new("/usr/bin/git");
    command
        .arg("-C")
        .arg(source)
        .args(arguments)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid");
    Ok(String::from_utf8(success(command).await?.stdout)?
        .trim()
        .into())
}

async fn repository(root: &Path) -> Result<(PathBuf, String)> {
    let source = root.join("source");
    std::fs::create_dir(&source)?;
    git(&source, &["init", "--quiet"]).await?;
    std::fs::write(source.join("workspace.txt"), "base\n")?;
    git(&source, &["add", "workspace.txt"]).await?;
    git(&source, &["commit", "--quiet", "-m", "Initial source"]).await?;
    let base = git(&source, &["rev-parse", "HEAD"]).await?;
    Ok((source, base))
}

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    overlapping_work_sessions_warn_their_objective_once;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    worker_managed_effects_replay_and_stay_in_doubt_across_restart;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    slack_message_selects_only_an_authorized_github_workspace;
}

/// TypeScript parity: `packages/control-plane/overlap-warnings.test.ts` and
/// `tests/worker-host-changed-paths.test.ts`.
async fn overlapping_work_sessions_warn_their_objective_once(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let (source, base) = repository(root).await?;
    let credentials = Credentials::new();
    let artifacts = root.join("transfers");
    let services = Services::start(&credentials, &database, |plane| {
        plane.arg("--transfer-directory").arg(&artifacts);
    })
    .await?;
    let cli = |args: &[&str]| services.cli(&credentials, args);
    json(cli(&[
        "tag",
        "put",
        "owner",
        "--instructions",
        "Coordinate the release",
        "--allow",
        "files:read",
        "--allow",
        "files:write",
        "--workspace-id",
        "project",
        "--workspace-base",
        &base,
    ]))
    .await?;
    let objective = json(cli(&[
        "objective",
        "create",
        "release",
        "--owner",
        "owner",
        "--ongoing",
        "Ship the release notes",
    ]))
    .await?;
    let session = field(&objective, "session_id")?.to_owned();
    success(credentials.worker(
        &public(&services),
        &root.join("owner"),
        Some(&source),
        &["--start-parallel-work-sessions"],
    ))
    .await?;
    let work = json(cli(&[
        "get",
        "sessions",
        "--parent-tag",
        "owner",
        "--parent-session",
        &session,
    ]))
    .await?;
    let children: Vec<String> = work["work_sessions"]
        .as_array()
        .context("Work Sessions")?
        .iter()
        .map(|work| field(work, "latest_task_id").map(str::to_owned))
        .collect::<Result<_>>()?;
    ensure!(children.len() == 2, "expected two Work Sessions: {work}");
    // Both children edit the same files of their own checkouts and stay running until released.
    let release = root.join("release");
    let wait = format!("--wait-for-file={}", release.display());
    // Two enrolled Worker Hosts, so both children run at once.
    let key = json(cli(&[
        "auth-key",
        "create",
        "children",
        "--role",
        "host",
        "--reusable",
        "--all-tags",
    ]))
    .await?;
    let key = field(&key, "auth_key")?;
    let mut hosts = Vec::new();
    for name in ["child-one", "child-two"] {
        let mut enroll =
            credentials.command(&["host", "enroll", name, "--control-plane", &services.public]);
        enroll
            .arg("--state-directory")
            .arg(root.join(name))
            .env_remove("SUPERTAG_HOST_TOKEN")
            .env("SUPERTAG_AUTH_KEY", key);
        success(enroll).await?;
        let mut host = credentials.worker(
            &public(&services),
            &root.join(name),
            Some(&source),
            &["--workspace-fixture", &wait],
        );
        host.env_remove("SUPERTAG_HOST_TOKEN")
            .env("SUPERTAG_TEST_CHANGED_PATHS_INTERVAL_MS", "100")
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        hosts.push(host.spawn()?);
    }
    let mut db = database::connect(&database).await?;
    let notices = || {
        sqlx::query_scalar::<_, String>(
            "SELECT task_id FROM supertag_v2_objective_notices WHERE objective_id='release' AND notice_key LIKE 'overlap:%'",
        )
    };
    let notice = match timeout(WAIT, async {
        loop {
            let ids = notices().fetch_all(&mut db).await?;
            if let Some(id) = ids.first() {
                return Ok::<_, anyhow::Error>(id.clone());
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    {
        Ok(notice) => notice?,
        Err(_) => {
            let mut logs = String::new();
            for mut host in hosts {
                host.start_kill()?;
                let output = host.wait_with_output().await?;
                logs.push_str(&String::from_utf8_lossy(&output.stderr));
            }
            anyhow::bail!("the Objective was not told about the overlap: {logs}");
        }
    };
    // Later scans of the same paths add nothing.
    sleep(Duration::from_millis(800)).await;
    assert_eq!(
        notices().fetch_all(&mut db).await?,
        std::slice::from_ref(&notice)
    );
    let task = json(cli(&["get", "task", &notice])).await?;
    assert_eq!(task["tag_id"], "owner");
    assert_eq!(task["session_id"], session.as_str());
    let prompt: String =
        sqlx::query_scalar("SELECT prompt FROM supertag_v2_tasks WHERE task_id=$1")
            .bind(&notice)
            .fetch_one(&mut db)
            .await?;
    let (first, second) = if prompt.find(&children[0]) < prompt.find(&children[1]) {
        (&children[0], &children[1])
    } else {
        (&children[1], &children[0])
    };
    assert_eq!(
        prompt,
        format!(
            "Tasks {first} and {second} of this Objective are both changing artifact.bin, workspace.txt in Workspace project. Coordinate them before their changes conflict: continue one work Session with what the other changes, or let one finish first."
        )
    );
    std::fs::write(&release, "")?;
    for host in hosts {
        let output = timeout(WAIT, host.wait_with_output()).await??;
        ensure!(
            output.status.success(),
            "child host failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    for child in &children {
        let task = json(cli(&["get", "task", child])).await?;
        assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
    }
    // Finished Attempts are no longer compared.
    assert_eq!(notices().fetch_all(&mut db).await?.len(), 1);
    services.stop().await
}

fn public(services: &Services) -> String {
    services.public.clone()
}

/// TypeScript parity: `tests/runtime/tool-adapter.test.ts` and `sdks/python/tests/test_tools.py`.
async fn worker_managed_effects_replay_and_stay_in_doubt_across_restart(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let provider = root.join("provider.log");
    let mode = format!("--effect-fixture={}", provider.display());
    let credentials = Credentials::new();
    let services = Services::start(&credentials, &database, |_| {}).await?;
    json(services.cli(
        &credentials,
        &["tag", "put", "integrator", "--instructions", "File tickets"],
    ))
    .await?;
    let first = json(services.cli(
        &credentials,
        &[
            "task",
            "submit",
            "--tag",
            "integrator",
            "--session",
            "tickets",
            "first",
        ],
    ))
    .await?;
    success(credentials.worker(&services.public, &root.join("host-one"), None, &[&mode])).await?;
    let first =
        json(services.cli(&credentials, &["get", "task", field(&first, "task_id")?])).await?;
    assert_eq!(first["state"], "TASK_STATE_SUCCEEDED", "{first}");
    assert_eq!(
        first["result"],
        "ticket/1 created {\"ticket\":\"T-1\"}\nticket/1 replayed {\"ticket\":\"T-1\"}\nticket/1 reuse refused\nticket/2 left in doubt"
    );
    // Receipts are durable in the Control Plane, not on the host that made them.
    services.stop().await?;
    let services = Services::start(&credentials, &database, |_| {}).await?;
    let retry = json(services.cli(
        &credentials,
        &[
            "task",
            "submit",
            "--tag",
            "integrator",
            "--session",
            "later",
            "retry",
        ],
    ))
    .await?;
    success(credentials.worker(&services.public, &root.join("host-two"), None, &[&mode])).await?;
    let retry =
        json(services.cli(&credentials, &["get", "task", field(&retry, "task_id")?])).await?;
    assert_eq!(retry["state"], "TASK_STATE_SUCCEEDED", "{retry}");
    assert_eq!(
        retry["result"],
        "ticket/1 replayed {\"ticket\":\"T-1\"}\nticket/2 in doubt\nticket/2 replayed {\"ticket\":\"T-2\",\"reconciled\":true}\nticket/3 created {\"ticket\":\"T-3\"}"
    );
    // The provider saw each effect exactly once, including the in-doubt one.
    assert_eq!(
        std::fs::read_to_string(&provider)?,
        "ticket/1\nticket/2\nticket/3\n"
    );
    services.stop().await
}

const SLACK_ACCOUNT: &str = "slack-selection-test";
const TEAM: &str = "TTEAM1";
const CHANNEL: &str = "CCHANNEL1";
const SIGNING: &str = "synthetic-slack-selection-signing-key";
const BOT: &str = "xoxb-synthetic-slack-selection-token";

/// Records the text of each Slack post or update.
struct MockSlack {
    endpoint: String,
    texts: Arc<Mutex<Vec<String>>>,
    server: tokio::task::JoinHandle<Result<()>>,
}

impl MockSlack {
    async fn start() -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = format!("http://{}/chat.postMessage", listener.local_addr()?);
        let texts = Arc::new(Mutex::new(Vec::new()));
        let observed = texts.clone();
        let server = tokio::spawn(async move {
            let mut position = 0;
            loop {
                let (mut connection, _) = listener.accept().await?;
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                let body = loop {
                    let count = connection.read(&mut buffer).await?;
                    ensure!(count > 0, "fixture HTTP request ended early");
                    bytes.extend_from_slice(&buffer[..count]);
                    let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") else {
                        continue;
                    };
                    let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                    let length: usize = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .context("fixture HTTP length missing")?
                        .trim()
                        .parse()?;
                    if bytes.len() >= end + 4 + length {
                        break serde_json::from_slice::<Value>(&bytes[end + 4..end + 4 + length])?;
                    }
                };
                observed
                    .lock()
                    .await
                    .push(body["text"].as_str().unwrap_or_default().to_owned());
                position += 1;
                let ts = body["ts"]
                    .as_str()
                    .map_or_else(|| format!("1794470100.{position:06}"), str::to_owned);
                let reply = json!({"ok":true,"channel":CHANNEL,"ts":ts}).to_string();
                connection.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len()).as_bytes()).await?;
                connection.shutdown().await?;
            }
        });
        Ok(Self {
            endpoint,
            texts,
            server,
        })
    }

    async fn wait_for(&self, expected: &str) -> Result<()> {
        timeout(WAIT, async {
            loop {
                if self.texts.lock().await.iter().any(|text| text == expected) {
                    return;
                }
                sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .with_context(|| format!("Slack never received {expected:?}: {:?}", self.texts))
    }
}

impl Drop for MockSlack {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn mention(endpoint: &str, sequence: u64, text: &str) -> Result<()> {
    reply(endpoint, sequence, sequence, text).await
}

/// A mention in the thread that message `thread` started.
async fn reply(endpoint: &str, sequence: u64, thread: u64, text: &str) -> Result<()> {
    let ts = format!("1794470000.{sequence:06}");
    let thread_ts = format!("1794470000.{thread:06}");
    let body = json!({"type":"event_callback","team_id":TEAM,"event_id":format!("Ev{sequence}"),"event":{"type":"app_mention","channel":CHANNEL,"user":"UALICE1","text":text,"ts":ts,"thread_ts":thread_ts}}).to_string();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_secs()
        .to_string();
    let mut mac = Hmac::<Sha256>::new_from_slice(SIGNING.as_bytes())?;
    mac.update(format!("v0:{timestamp}:{body}").as_bytes());
    let status = reqwest::Client::builder()
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
        .status();
    ensure!(status.is_success(), "Slack event was refused: {status}");
    Ok(())
}

/// TypeScript parity: `tests/e2e/permission-target-workspace.test.ts`.
async fn slack_message_selects_only_an_authorized_github_workspace(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let slack = MockSlack::start().await?;
    let credentials = Credentials::new();
    let services = Services::with_gateway(
        &credentials,
        &database,
        |gateway| {
            gateway
                .args(["--slack-listen", "127.0.0.1:0", "--slack-state-directory"])
                .arg(root.join("slack"))
                .env("SUPERTAG_SLACK_ACCOUNT_ID", SLACK_ACCOUNT)
                .env("SUPERTAG_SLACK_TEAM_ID", TEAM)
                .env("SUPERTAG_SLACK_CHANNEL_ID", CHANNEL)
                .env("SUPERTAG_SLACK_TAG_ID", "builder")
                .env("SUPERTAG_SLACK_ALLOWED_USERS", "UALICE1")
                .env("SUPERTAG_SLACK_SIGNING_SECRET", SIGNING)
                .env("SUPERTAG_SLACK_BOT_TOKEN", BOT)
                .env("SUPERTAG_TEST_SLACK_API_URL", &slack.endpoint);
        },
        2,
    )
    .await?;
    let ingress = services.extra[0].clone();
    let cli = |args: &[&str]| services.cli(&credentials, args);
    json(cli(&[
        "tag",
        "put",
        "builder",
        "--instructions",
        "Answer engineering questions",
        "--allow",
        "files:read",
    ]))
    .await?;
    let account = spec(
        root,
        "account.json",
        json!({"account_id":"github-source","identity":{"provider":"github","external_account_id":"installation:42"},"enabled":true,"gateway":"local"}),
    )?;
    json(cli(&["surface-account", "put", &account])).await?;
    json(cli(&[
        "workspace",
        "put",
        "project",
        "--account",
        "github-source",
        "--repository-id",
        "123",
        "--repository",
        "acme/project",
        "--commit",
        "1111111111111111111111111111111111111111",
        "--operation-id",
        "source",
    ]))
    .await?;

    // Without a read grant the request fails before execution, and the thread is told why.
    mention(
        &ingress,
        1,
        "<@U0BOT> In acme/project, why does deployment fail?",
    )
    .await?;
    slack
        .wait_for("I ran into a problem while working on this: Tag builder is not allowed to use GitHub repository acme/project")
        .await?;

    let grant = spec(
        root,
        "grant.json",
        json!({"set_id":"read-source","name":"read-source","permissions":[{"target":"surface","surface_account_id":"github-source","scope":"repository:123","action":"contents:read"}]}),
    )?;
    json(cli(&["permission-set", "put", &grant])).await?;
    let role = spec(
        root,
        "role.json",
        json!({"role_id":"reader","name":"reader","purpose":"Read source","permission_set_ids":["read-source"]}),
    )?;
    json(cli(&["role", "put", &role])).await?;
    json(cli(&["role-assignment", "create", "reader", "builder"])).await?;
    // The granted repository is selected, and the acknowledgement names its Workspace.
    mention(
        &ingress,
        2,
        "<@U0BOT> In acme/project, why does deployment fail?",
    )
    .await?;
    slack
        .wait_for("Got it. I’m looking into this in Workspace project now.")
        .await?;

    // Once a repository is readable, naming another one runs the Task without a Workspace and
    // asks the requester to choose (TypeScript `selection-required`), rather than refusing.
    mention(
        &ingress,
        3,
        "<@U0BOT> In rust-lang/cargo, how is this handled?",
    )
    .await?;
    slack.wait_for("Got it. I’m looking into this now.").await?;

    // A revoked read fails a later turn of the selected Session with a reply, instead of an
    // ingress error that Slack would retry without ever answering.
    let narrowed = spec(
        root,
        "narrowed.json",
        json!({"set_id":"read-source","name":"read-source","permissions":[{"target":"surface","surface_account_id":"github-source","scope":"repository:124","action":"contents:read"}]}),
    )?;
    json(cli(&[
        "permission-set",
        "put",
        &narrowed,
        "--expected-revision",
        "1",
    ]))
    .await?;
    reply(&ingress, 4, 2, "<@U0BOT> One more question").await?;
    slack
        .wait_for("I ran into a problem while working on this: Tag builder is no longer allowed to use the GitHub Workspace project this Session selected")
        .await?;
    services.stop().await
}
