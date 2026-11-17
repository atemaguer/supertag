//! GitHub delivery through real split processes against a loopback GitHub API and Git server:
//! a Work Session's delivery opens a pull request, and the Gateway's signed `pull_request`
//! webhook reporting that pull request merged closes the Work Session; and a publication whose
//! holding Worker Host was offline is published as soon as that host is back.
#[path = "support/children.rs"]
mod children;
use children::reaped;
#[path = "support/holding_host.rs"]
mod holding_host;
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[macro_use]
#[path = "support/database.rs"]
mod database;

use anyhow::{Context, Result, ensure};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::State,
    http::{Request, Response, StatusCode},
    routing::any,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    net::SocketAddr,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::timeout,
};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(90);
const TOKEN: &str = "fixture-source-token";
const SIGNING: &str = "synthetic-github-webhook-secret";

/// A loopback GitHub: one repository, its Git remote, and pull requests numbered from 7 in the
/// order they are opened, one per head branch.
#[derive(Clone)]
struct Fixture {
    root: PathBuf,
    pulls: Arc<Mutex<BTreeMap<String, Value>>>,
    /// Holds the publisher's pull request lookup until the test opens it.
    discovery: Arc<AtomicBool>,
}

struct Server(tokio::task::JoinHandle<()>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn git(path: &Path, arguments: &[&str]) -> String {
    let output = std::process::Command::new("/usr/bin/git")
        .current_dir(path)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .args([
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgSign=false",
        ])
        .args(arguments)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}

fn remote_head(fixture: &Fixture, branch: &str) -> Option<String> {
    let output = std::process::Command::new("/usr/bin/git")
        .current_dir(fixture.root.join("acme/project.git"))
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .args(["rev-parse", "--verify", &format!("refs/heads/{branch}")])
        .output()
        .unwrap();
    output
        .status
        .success()
        .then(|| String::from_utf8(output.stdout).unwrap().trim().into())
}

fn found(value: Value) -> Response<Body> {
    Response::new(Body::from(value.to_string()))
}

fn missing() -> Response<Body> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Body::empty())
        .unwrap()
}

/// A pull request as GitHub returns it, with its head branch's current commit.
fn current(fixture: &Fixture, pull: &Value) -> Value {
    let mut pull = pull.clone();
    let branch = pull["head"]["ref"].as_str().unwrap().to_owned();
    pull["head"]["sha"] = remote_head(fixture, &branch).unwrap().into();
    pull
}

async fn api(State(fixture): State<Fixture>, request: Request<Body>) -> Response<Body> {
    assert_eq!(
        request.headers().get("authorization").unwrap(),
        format!("Bearer {TOKEN}").as_str()
    );
    let path = request.uri().path().to_owned();
    let query = request.uri().query().unwrap_or("").to_owned();
    let method = request.method().clone();
    if path == "/repositories/123" || path == "/repos/acme/project" {
        return found(json!({"id":123,"full_name":"acme/project","default_branch":"main"}));
    }
    if let Some(sha) = path.strip_prefix("/repos/acme/project/commits/") {
        return found(json!({"sha":sha}));
    }
    if let Some(branch) = path.strip_prefix("/repos/acme/project/git/ref/heads/") {
        return match remote_head(&fixture, branch) {
            Some(head) => found(
                json!({"ref":format!("refs/heads/{branch}"),"object":{"type":"commit","sha":head}}),
            ),
            None => missing(),
        };
    }
    if path == "/repos/acme/project/pulls" && method == "POST" {
        let input: Value =
            serde_json::from_slice(&to_bytes(request.into_body(), 65536).await.unwrap()).unwrap();
        let branch = input["head"].as_str().unwrap().to_owned();
        let mut pulls = fixture.pulls.lock().unwrap();
        let number = 7 + pulls.len() as u64;
        let pull = json!({"number":number,"html_url":format!("https://github.com/acme/project/pull/{number}"),"state":"open","merged":false,"draft":true,"title":input["title"],"body":input["body"],"head":{"ref":branch,"sha":"","repo":{"id":123,"full_name":"acme/project"}},"base":{"ref":"main","repo":{"id":123,"full_name":"acme/project"}}});
        pulls.insert(branch, pull.clone());
        drop(pulls);
        return Response::builder()
            .status(201)
            .body(Body::from(current(&fixture, &pull).to_string()))
            .unwrap();
    }
    if path == "/repos/acme/project/pulls" {
        while !fixture.discovery.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let head = query
            .split('&')
            .find_map(|pair| pair.strip_prefix("head=acme%3A"))
            .unwrap_or_default()
            .replace("%2F", "/");
        let pulls = fixture.pulls.lock().unwrap().clone();
        let listed: Vec<Value> = pulls
            .get(&head)
            .map(|pull| current(&fixture, pull))
            .into_iter()
            .collect();
        return found(json!(listed));
    }
    if let Some(number) = path.strip_prefix("/repos/acme/project/pulls/") {
        let number: u64 = number.parse().unwrap();
        let update: Option<Value> = if method == "PATCH" {
            Some(
                serde_json::from_slice(&to_bytes(request.into_body(), 65536).await.unwrap())
                    .unwrap(),
            )
        } else {
            None
        };
        let pull = {
            let mut pulls = fixture.pulls.lock().unwrap();
            let Some(pull) = pulls
                .values_mut()
                .find(|pull| pull["number"].as_u64() == Some(number))
            else {
                return missing();
            };
            if let Some(input) = update {
                pull["title"] = input["title"].clone();
                pull["body"] = input["body"].clone();
            }
            pull.clone()
        };
        return found(current(&fixture, &pull));
    }
    missing()
}

async fn git_http(State(fixture): State<Fixture>, request: Request<Body>) -> Response<Body> {
    let expected = format!(
        "Basic {}",
        STANDARD.encode(format!("x-access-token:{TOKEN}"))
    );
    assert_eq!(
        request.headers().get("authorization").unwrap(),
        expected.as_str()
    );
    let (parts, body) = request.into_parts();
    let bytes = to_bytes(body, 1_048_576).await.unwrap();
    tokio::task::spawn_blocking(move || {
        let header = |name: &str| {
            parts
                .headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("")
                .to_owned()
        };
        let mut child = std::process::Command::new("/usr/bin/git")
            .arg("http-backend")
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_PROJECT_ROOT", &fixture.root)
            .env("GIT_HTTP_EXPORT_ALL", "1")
            .env("PATH_INFO", parts.uri.path().strip_prefix("/git").unwrap())
            .env("REQUEST_METHOD", parts.method.as_str())
            .env("QUERY_STRING", parts.uri.query().unwrap_or(""))
            .env("CONTENT_TYPE", header("content-type"))
            .env("HTTP_GIT_PROTOCOL", header("git-protocol"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(&bytes).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        let split = output
            .stdout
            .windows(4)
            .position(|bytes| bytes == b"\r\n\r\n")
            .unwrap();
        let mut response = Response::builder();
        for line in std::str::from_utf8(&output.stdout[..split])
            .unwrap()
            .split("\r\n")
        {
            let (name, value) = line.split_once(':').unwrap();
            if name.eq_ignore_ascii_case("status") {
                let code = value.trim().split(' ').next().unwrap();
                response = response.status(code.parse::<u16>().unwrap());
            } else {
                response = response.header(name, value.trim());
            }
        }
        response
            .body(Body::from(output.stdout[split + 4..].to_vec()))
            .unwrap()
    })
    .await
    .unwrap()
}

/// Starts `command` and reads `count` loopback endpoints from its first lines of output.
async fn service(mut command: Command, count: usize) -> Result<(Child, Vec<String>)> {
    let mut child = command.stdout(Stdio::piped()).spawn()?;
    let mut stdout = BufReader::new(child.stdout.take().context("service stdout missing")?);
    let mut endpoints = vec![];
    for _ in 0..count {
        let mut line = String::new();
        timeout(WAIT, stdout.read_line(&mut line))
            .await
            .context("service startup timed out")??;
        let address: SocketAddr = line.trim().parse().context("service endpoint missing")?;
        ensure!(address.ip().is_loopback() && address.port() != 0);
        endpoints.push(format!("http://{address}"));
    }
    tokio::spawn(async move {
        let mut line = String::new();
        while stdout.read_line(&mut line).await.is_ok_and(|read| read > 0) {
            line.clear();
        }
    });
    Ok((child, endpoints))
}

async fn json(mut command: Command) -> Result<Value> {
    let output = timeout(WAIT, command.output())
        .await
        .context("CLI command timed out")??;
    ensure!(
        output.status.success(),
        "CLI failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}

async fn eventually<F, Fut>(what: &str, mut check: F) -> Result<Value>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<Option<Value>>>,
{
    timeout(WAIT, async {
        loop {
            if let Some(value) = check().await? {
                return Ok(value);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .with_context(|| format!("{what} timed out"))?
}

/// Delivers one signed webhook, redelivering while the Gateway answers 503 as GitHub does.
async fn webhook(endpoint: &str, delivery: &str, event: &str, payload: &Value) -> Result<u16> {
    let body = payload.to_string();
    let mut mac = Hmac::<Sha256>::new_from_slice(SIGNING.as_bytes())?;
    mac.update(body.as_bytes());
    let signature = format!("sha256={:x}", mac.finalize().into_bytes());
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()?;
    timeout(WAIT, async {
        loop {
            let status = client
                .post(format!("{endpoint}/github/events"))
                .header("content-type", "application/json")
                .header("x-github-delivery", delivery)
                .header("x-github-event", event)
                .header("x-hub-signature-256", &signature)
                .body(body.clone())
                .send()
                .await?
                .status()
                .as_u16();
            if status != 503 {
                return Ok(status);
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .context("webhook delivery timed out")?
}

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    a_merged_pull_request_closes_the_work_session_that_opened_it;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    a_publication_waiting_for_its_holder_is_published_when_the_holder_returns;
}

async fn a_merged_pull_request_closes_the_work_session_that_opened_it(
    database: String,
) -> Result<()> {
    scenario(database, true).await
}

async fn a_publication_waiting_for_its_holder_is_published_when_the_holder_returns(
    database: String,
) -> Result<()> {
    scenario(database, false).await
}

async fn scenario(database: String, merge: bool) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let repository = root.join("input");
    fs::create_dir(&repository)?;
    git(&repository, &["init", "--quiet", "--initial-branch=main"]);
    fs::write(repository.join("workspace.txt"), "base\n")?;
    git(&repository, &["add", "."]);
    git(&repository, &["commit", "--quiet", "-m", "Pinned"]);
    let commit = git(&repository, &["rev-parse", "HEAD"]);
    let exported = root.join("export");
    fs::create_dir_all(exported.join("acme"))?;
    let remote = exported.join("acme/project.git");
    git(
        root,
        &[
            "clone",
            "--bare",
            "--quiet",
            repository.to_str().unwrap(),
            remote.to_str().unwrap(),
        ],
    );
    git(&remote, &["config", "http.receivepack", "true"]);
    let fixture = Fixture {
        root: exported,
        pulls: Arc::default(),
        discovery: Arc::new(AtomicBool::new(merge)),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let github = format!("http://{}/", listener.local_addr()?);
    let router = Router::new()
        .route("/git/{*path}", any(git_http))
        .fallback(api)
        .with_state(fixture.clone());
    let _server = Server(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));

    let gateway_token = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
    let operator_token = Uuid::new_v4().to_string();
    let host_token = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
    let command = |args: &[&str]| {
        let mut command = reaped(Command::new(BINARY));
        command
            .args(args)
            .env_clear()
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &gateway_token)
            .env("SUPERTAG_GATEWAY_CREDENTIAL", &gateway_token)
            .env("SUPERTAG_OPERATOR_TOKEN", &operator_token)
            .env("SUPERTAG_HOST_TOKEN", &host_token)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token);
        command
    };
    let mut plane = command(&["control-plane", "--listen", "127.0.0.1:0"]);
    plane
        .env("SUPERTAG_DATABASE_URL", &database)
        .arg("--checkpoint-directory")
        .arg(root.join("artifacts"))
        .arg("--github-workspace-directory")
        .arg(root.join("sources"))
        .env("SUPERTAG_GITHUB_ACCOUNT_ID", "github-source")
        .env("SUPERTAG_GITHUB_REPOSITORY_ID", "123")
        .env("SUPERTAG_GITHUB_REPOSITORY", "acme/project")
        .env("SUPERTAG_GITHUB_TOKEN", TOKEN)
        .env("SUPERTAG_TEST_GITHUB_API_URL", &github)
        .env("SUPERTAG_TEST_GITHUB_GIT_URL", format!("{github}git/"));
    let (_plane, endpoints) = service(plane, 1).await?;
    let public = endpoints[0].clone();
    let cli = |args: &[&str]| {
        let mut c = command(&[args[0], "--gateway", &public]);
        c.args(&args[1..]);
        c
    };
    let spec = |name: &str, value: Value| -> Result<String> {
        let file = root.join(name);
        fs::write(&file, serde_json::to_vec(&value)?)?;
        Ok(file.to_str().unwrap().into())
    };
    let account = spec(
        "account.json",
        json!({"accountId":"github-source","identity":{"provider":"github","externalAccountId":"installation:42"},"enabled":true,"gateway":"local"}),
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
        &commit,
        "--pull-request-base",
        "main",
    ]))
    .await?;
    json(cli(&[
        "tag",
        "put",
        "builder",
        "--instructions",
        "Improve repository",
        "--allow",
        "files:read",
        "--allow",
        "files:write",
        "--workspace-id",
        "project",
        "--workspace-base",
        &commit,
    ]))
    .await?;
    let surface = |action: &str| json!({"target":"surface","surfaceAccountId":"github-source","scope":"repository:123","action":action});
    let grant = spec(
        "grant.json",
        json!({"setId":"publish","name":"publish","permissions":[surface("contents:read"), surface("pull-requests:create")]}),
    )?;
    json(cli(&["permission-set", "put", &grant])).await?;
    let role = spec(
        "role.json",
        json!({"roleId":"publisher","name":"publisher","purpose":"Open pull requests","permissionSets":["publish"]}),
    )?;
    json(cli(&["role", "put", &role])).await?;
    json(cli(&["role-assignment", "create", "publisher", "builder"])).await?;

    // The Gateway's GitHub connector for the same repository.
    let mut gateway = command(&[
        "gateway",
        "--control-plane",
        &public,
        "--github-listen",
        "127.0.0.1:0",
        "--github-state-directory",
    ]);
    gateway
        .arg(root.join("gateway"))
        .env("SUPERTAG_GITHUB_ACCOUNT_ID", "surface")
        .env("SUPERTAG_GITHUB_REPOSITORY_ID", "123")
        .env("SUPERTAG_GITHUB_REPOSITORY", "acme/project")
        .env("SUPERTAG_GITHUB_TAG_ID", "builder")
        .env("SUPERTAG_GITHUB_ALLOWED_USERS", "42")
        .env("SUPERTAG_GITHUB_WEBHOOK_SECRET", SIGNING)
        .env("SUPERTAG_GITHUB_TOKEN", TOKEN)
        .env("SUPERTAG_TEST_GITHUB_API_URL", &github);
    let (_gateway, endpoints) = service(gateway, 2).await?;
    let webhooks = endpoints[1].clone();

    // The root turn changes nothing and starts a Work Session; a holding host then runs the
    // Work Session's turn, which commits, and keeps its delivery reachable for the publisher.
    let host = |state: &str, fixture_args: &[&str], once: bool| {
        let mut host = command(&["worker-host", "--control-plane", &public]);
        if once {
            host.arg("--once");
        }
        host.arg("--adapter")
            .arg(ADAPTER)
            .args(
                fixture_args
                    .iter()
                    .map(|arg| format!("--adapter-arg={arg}")),
            )
            .arg("--state-directory")
            .arg(root.join(state))
            .arg("--artifact-directory")
            .arg(holding_host::artifact_directory(root))
            .args([
                "--workspace-id",
                "project",
                "--workspace-from-control-plane",
            ]);
        host
    };
    let publication = |task: String| {
        let cli = &cli;
        async move {
            let page = json(cli(&["get", "github-publications", "--task-id", &task])).await?;
            let job = page["publications"][0].clone();
            ensure!(
                job["state"] != "GITHUB_PUBLICATION_STATE_HELD"
                    && job["state"] != "GITHUB_PUBLICATION_STATE_CANCELLED",
                "publication stopped: {job}"
            );
            Ok::<_, anyhow::Error>(job)
        }
    };
    if !merge {
        // The Task's host exits as soon as it finishes. The publisher's lookup waits until then,
        // so it finds no host holding the bundle and puts the publication back for the Queued
        // retry of a minute.
        let task = json(cli(&[
            "task",
            "submit",
            "--tag",
            "builder",
            "--session",
            "feature",
            "first",
        ]))
        .await?;
        let task = task["task_id"].as_str().context("task ID")?.to_owned();
        let output = timeout(
            WAIT,
            host("host-once", &["--workspace-fixture"], true).output(),
        )
        .await??;
        ensure!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        fixture.discovery.store(true, Ordering::SeqCst);
        let queued = eventually("queued publication", || {
            let job = publication(task.clone());
            async move {
                let job = job.await?;
                Ok((job["state"] == "GITHUB_PUBLICATION_STATE_QUEUED"
                    && job["reason"]
                        .as_str()
                        .is_some_and(|reason| reason.contains("not connected")))
                .then_some(job))
            }
        })
        .await?;
        // The holder coming back retries it at once, well before the minute is up.
        let returned = std::time::Instant::now();
        let _holding =
            holding_host::serve(host("host-returned", &["--workspace-fixture"], false)).await?;
        let published = eventually("publication after the holder returned", || {
            let job = publication(task.clone());
            async move {
                let job = job.await?;
                Ok((job["state"] == "GITHUB_PUBLICATION_STATE_PUBLISHED").then_some(job))
            }
        })
        .await?;
        ensure!(
            returned.elapsed() < Duration::from_secs(40),
            "published {:?} after the holder returned: {queued} then {published}",
            returned.elapsed()
        );
        return Ok(());
    }
    json(cli(&[
        "task",
        "submit",
        "--tag",
        "builder",
        "--session",
        "feature",
        "Split the work",
    ]))
    .await?;
    let output = timeout(
        WAIT,
        host("host-root", &["--start-work-session"], true).output(),
    )
    .await??;
    ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let listed = json(cli(&[
        "get",
        "session",
        "--parent-tag",
        "builder",
        "--parent-session",
        "feature",
    ]))
    .await?;
    let work = listed["work_sessions"][0]["work_session_id"]
        .as_str()
        .with_context(|| format!("no Work Session: {listed}"))?
        .to_owned();
    let child = listed["work_sessions"][0]["latest_task_id"]
        .as_str()
        .context("Work Session Task")?
        .to_owned();
    let _holding =
        holding_host::serve(host("host-holding", &["--workspace-fixture"], false)).await?;
    let published = eventually("publication", || {
        let job = publication(child.clone());
        async move {
            let job = job.await?;
            Ok((job["state"] == "GITHUB_PUBLICATION_STATE_PUBLISHED").then_some(job))
        }
    })
    .await?;
    let number = published["pull_request"]["number"]
        .as_u64()
        .context("pull request number")?;
    let open = json(cli(&["get", "session", &work])).await?;
    ensure!(open["close_reason"].is_null(), "{open}");

    let merged = |number: u64, merged: bool| json!({"action":"closed","sender":{"id":99,"type":"User"},"repository":{"id":123,"full_name":"acme/project"},"pull_request":{"id":5_000 + number,"number":number,"merged":merged}});
    // Closing another pull request, or this one without merging, changes nothing.
    assert_eq!(
        webhook(
            &webhooks,
            "closed-other",
            "pull_request",
            &merged(number + 50, true)
        )
        .await?,
        202
    );
    assert_eq!(
        webhook(
            &webhooks,
            "closed-unmerged",
            "pull_request",
            &merged(number, false)
        )
        .await?,
        202
    );
    let still = json(cli(&["get", "session", &work])).await?;
    ensure!(still["close_reason"].is_null(), "{still}");
    // A merge by anyone closes the Work Session that opened the pull request.
    assert_eq!(
        webhook(&webhooks, "merged", "pull_request", &merged(number, true)).await?,
        202
    );
    let closed = json(cli(&["get", "session", &work])).await?;
    ensure!(
        closed["close_reason"] == "WORK_SESSION_CLOSE_REASON_MERGED",
        "{closed}"
    );
    let listed = json(cli(&[
        "get",
        "session",
        "--parent-tag",
        "builder",
        "--parent-session",
        "feature",
    ]))
    .await?;
    ensure!(listed["open_work_sessions"] == 0, "{listed}");
    Ok(())
}
