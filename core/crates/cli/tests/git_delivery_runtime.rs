//! A remote Workspace end to end, through real processes: a local smart-HTTP git server that
//! requires a token, a Control Plane running git delivery with a Workspace Credential from its
//! credential vault, a Worker Host that receives the source relayed (it holds no credential and no
//! clone), and the CLI. A delivered Task lands as the Session's branch on the server.
#[path = "support/children.rs"]
mod children;
use children::reaped;
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[macro_use]
#[path = "support/database.rs"]
mod database;
#[path = "support/holding_host.rs"]
mod holding_host;

use std::{
    io::Write as _,
    net::SocketAddr,
    os::unix::fs::PermissionsExt as _,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::State,
    http::{Request, Response, StatusCode},
    routing::any,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::{sleep, timeout},
};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(90);
const TOKEN: &str = "fixture-workspace-token";

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    a_remote_workspace_lands_through_git_delivery;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    a_review_workspace_opens_a_pull_request_that_closes_its_work_session;
}

/// The git server: repositories under `root` at `prefix`, served with `git http-backend`, for
/// the HTTPS Basic `user:password` values in `readers` (fetch) and `writers` (fetch and push).
#[derive(Clone)]
struct Server {
    root: PathBuf,
    prefix: &'static str,
    readers: Vec<String>,
    writers: Vec<String>,
    pushes: Arc<AtomicUsize>,
}

struct Serving(tokio::task::JoinHandle<()>);
impl Drop for Serving {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn git_http(State(server): State<Server>, request: Request<Body>) -> Response<Body> {
    let pushing = request.uri().path().ends_with("git-receive-pack")
        || request
            .uri()
            .query()
            .is_some_and(|query| query.contains("git-receive-pack"));
    let presented = request
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Basic "))
        .and_then(|value| STANDARD.decode(value).ok())
        .and_then(|value| String::from_utf8(value).ok())
        .unwrap_or_default();
    let allowed =
        server.writers.contains(&presented) || (!pushing && server.readers.contains(&presented));
    if !allowed {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .header("www-authenticate", "Basic realm=\"fixture\"")
            .body(Body::empty())
            .unwrap();
    }
    if request.uri().path().ends_with("git-receive-pack") && request.method() == "POST" {
        server.pushes.fetch_add(1, Ordering::SeqCst);
    }
    let (parts, body) = request.into_parts();
    let bytes = to_bytes(body, 16 * 1_048_576).await.unwrap();
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
            .env("GIT_PROJECT_ROOT", &server.root)
            .env("GIT_HTTP_EXPORT_ALL", "1")
            .env("REMOTE_USER", "supertag")
            .env(
                "PATH_INFO",
                parts.uri.path().strip_prefix(server.prefix).unwrap(),
            )
            .env("REQUEST_METHOD", parts.method.as_str())
            .env("QUERY_STRING", parts.uri.query().unwrap_or(""))
            .env("CONTENT_TYPE", header("content-type"))
            .env("HTTP_CONTENT_ENCODING", header("content-encoding"))
            .env("HTTP_GIT_PROTOCOL", header("git-protocol"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(&bytes).unwrap();
        let output = child.wait_with_output().unwrap();
        let split = output
            .stdout
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .unwrap();
        let mut response = Response::builder();
        for line in std::str::from_utf8(&output.stdout[..split])
            .unwrap()
            .split("\r\n")
        {
            let (name, value) = line.split_once(':').unwrap();
            if name.eq_ignore_ascii_case("status") {
                response = response.status(
                    value
                        .trim()
                        .split(' ')
                        .next()
                        .unwrap()
                        .parse::<u16>()
                        .unwrap(),
                );
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

struct Credentials {
    gateway: String,
    operator: String,
    host: String,
    state: PathBuf,
}

impl Credentials {
    fn command(&self, args: &[&str]) -> Command {
        let mut command = reaped(Command::new(BINARY));
        command
            .args(args)
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &self.gateway)
            .env("SUPERTAG_GATEWAY_CREDENTIAL", &self.gateway)
            .env("SUPERTAG_OPERATOR_TOKEN", &self.operator)
            .env("SUPERTAG_HOST_TOKEN", &self.host)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &self.host)
            .stdin(Stdio::null())
            .kill_on_drop(true);
        command
    }

    /// The operator's CLI on the Control Plane's machine: it shares the Control Plane's vault.
    fn cli(&self, public: &str, args: &[&str]) -> Command {
        let mut command = self.command(&[args[0], "--gateway", public]);
        command
            .args(&args[1..])
            .env("SUPERTAG_STATE_DIR", &self.state);
        command
    }
}

async fn a_remote_workspace_lands_through_git_delivery(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path().canonicalize()?;

    // The git server's repository: one commit on main.
    let served = root.join("served");
    let bare = served.join("acme/handbook.git");
    std::fs::create_dir_all(&bare)?;
    git(
        &bare,
        &["init", "--bare", "--quiet", "--initial-branch=main"],
    )
    .await?;
    git(&bare, &["config", "http.receivepack", "true"]).await?;
    let seed = root.join("seed");
    git(&root, &["init", "--quiet", "--initial-branch=main", "seed"]).await?;
    std::fs::write(seed.join("workspace.txt"), "base\n")?;
    git(&seed, &["add", "workspace.txt"]).await?;
    git(&seed, &["commit", "--quiet", "-m", "Base"]).await?;
    let base = git(&seed, &["rev-parse", "HEAD"]).await?;
    git(
        &seed,
        &["push", "--quiet", bare.to_str().context("path")?, "main"],
    )
    .await?;

    let server = Server {
        root: served.clone(),
        prefix: "/git",
        readers: Vec::new(),
        writers: vec![format!("supertag:{TOKEN}")],
        pushes: Arc::default(),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let remote = format!("http://{}/git/acme/handbook.git", listener.local_addr()?);
    let router = Router::new()
        .route("/git/{*path}", any(git_http))
        .with_state(server.clone());
    let _serving = Serving(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));

    let credentials = Credentials {
        gateway: supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX),
        operator: Uuid::new_v4().to_string(),
        host: supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX),
        state: root.join("state"),
    };
    std::fs::create_dir(&credentials.state)?;
    std::fs::set_permissions(&credentials.state, std::fs::Permissions::from_mode(0o700))?;
    let mut plane = credentials.command(&["control-plane"]);
    plane
        .env("SUPERTAG_DATABASE_URL", &database)
        .env("SUPERTAG_STATE_DIR", &credentials.state)
        .arg("--git-delivery-directory")
        .arg(root.join("git-delivery"));
    let (mut plane, public) = service(plane).await?;
    let cli = |args: &[&str]| credentials.cli(&public, args);

    // The token reaches the vault from the environment, never from a flag or the database.
    let mut add = cli(&[
        "workspace",
        "credential",
        "add",
        "handbook",
        "--https-token",
        "--username",
        "supertag",
    ]);
    add.env("SUPERTAG_WORKSPACE_TOKEN", TOKEN);
    let added = json(add).await?;
    assert_eq!(added["kind"], "https-token");
    assert_eq!(added["identifier"], "supertag");
    let listed = json(cli(&["workspace", "credential", "list"])).await?;
    ensure!(!listed.to_string().contains(TOKEN), "{listed}");

    let workspace = json(cli(&[
        "workspace",
        "put",
        "handbook",
        "--remote",
        &remote,
        "--ref",
        "main",
        "--credential",
        "handbook",
    ]))
    .await?;
    assert!(workspace["land"].is_null(), "{workspace}");
    let check = json(cli(&["workspace", "check", "handbook"])).await?;
    let status = |step: &str| {
        check["steps"]
            .as_array()
            .and_then(|steps| steps.iter().find(|value| value["step"] == step))
            .map(|value| value["status"].as_str().unwrap_or_default().to_owned())
    };
    assert_eq!(status("read").as_deref(), Some("ok"), "{check}");
    assert_eq!(status("push").as_deref(), Some("ok"), "{check}");
    assert_eq!(
        status("review").as_deref(),
        Some("not_applicable"),
        "{check}"
    );
    assert_eq!(
        server.pushes.load(Ordering::SeqCst),
        0,
        "a check never pushes"
    );

    json(cli(&[
        "tag",
        "put",
        "builder",
        "--name",
        "Handbook Writer",
        "--instructions",
        "Improve the handbook",
        "--allow",
        "files:read",
        "--allow",
        "files:write",
        "--workspace-id",
        "handbook",
    ]))
    .await?;

    // The adapter must see none of the credentials, even with them in the host's environment.
    let adapter = root.join("isolated-adapter");
    std::fs::write(
        &adapter,
        format!(
            "#!/bin/sh\nset -eu\nfor name in SUPERTAG_WORKSPACE_TOKEN SUPERTAG_HOST_TOKEN SUPERTAG_OPERATOR_TOKEN GIT_CONFIG_VALUE_0; do\n eval 'test -z \"${{'\"$name\"'+x}}\"' || exit 22\ndone\nexec '{}' \"$@\"\n",
            ADAPTER
        ),
    )?;
    std::fs::set_permissions(&adapter, std::fs::Permissions::from_mode(0o700))?;
    let mut host = credentials.command(&["worker-host", "--control-plane", &public]);
    host.arg("--adapter")
        .arg(&adapter)
        .arg("--adapter-arg=--workspace-fixture")
        .arg("--state-directory")
        .arg(root.join("host"))
        .arg("--artifact-directory")
        .arg(holding_host::artifact_directory(&root))
        .args(["--remote-workspace", "handbook"])
        .env("SUPERTAG_WORKSPACE_TOKEN", "ambient-must-not-reach-adapter");
    let mut host = holding_host::serve(host).await?;

    let task = json(cli(&[
        "task",
        "submit",
        "--tag",
        "builder",
        "--session",
        "notes",
        "first",
    ]))
    .await?;
    let task_id = field(&task, "task_id")?.to_owned();
    let task = wait_for(&cli, &["get", "task", &task_id], |task| {
        matches!(
            task["state"].as_str(),
            Some("TASK_STATE_SUCCEEDED" | "TASK_STATE_FAILED")
        )
    })
    .await?;
    ensure!(task["state"] == "TASK_STATE_SUCCEEDED", "{task}");
    assert_eq!(task["workspace"]["base_commit"], base.as_str());
    let head = field(&task["workspace_delivery"], "head_commit")?.to_owned();

    // Git delivery lands the Session's branch on the server, fast-forward only.
    let landings = wait_for(
        &cli,
        &["get", "landings", "--session-id", "notes"],
        |page| page["landings"][0]["state"] == "landed",
    )
    .await?;
    let landing = &landings["landings"][0];
    let branch = supertag_protocol::session_branch("builder", "notes");
    assert_eq!(landing["branch"], branch.as_str());
    assert_eq!(landing["landed_commit"], head.as_str());
    assert_eq!(
        git(&bare, &["rev-parse", &format!("refs/heads/{branch}")]).await?,
        head
    );
    assert_eq!(
        git(&bare, &["show", &format!("{head}:workspace.txt")]).await?,
        "base\nfirst"
    );
    // The Tag authors the Session's commit; main is untouched.
    assert_eq!(
        git(&bare, &["log", "-1", "--format=%an <%ae>", &head]).await?,
        "Handbook Writer <builder@noreply.supertag.invalid>"
    );
    assert_eq!(git(&bare, &["rev-parse", "refs/heads/main"]).await?, base);
    assert!(server.pushes.load(Ordering::SeqCst) >= 1);

    // The Session continues on a host that holds none of it: its own state and artifact storage.
    // It reads the Session's branch from the server, never through the Control Plane.
    host.kill().await?;
    let mut fresh = credentials.command(&["worker-host", "--control-plane", &public]);
    fresh
        .arg("--adapter")
        .arg(&adapter)
        .arg("--adapter-arg=--workspace-fixture")
        .arg("--state-directory")
        .arg(root.join("fresh-host"))
        .arg("--artifact-directory")
        .arg(root.join("fresh-artifacts"))
        .args(["--remote-workspace", "handbook"]);
    let mut fresh = holding_host::serve(fresh).await?;
    let second = json(cli(&[
        "task",
        "submit",
        "--tag",
        "builder",
        "--session",
        "notes",
        "second",
    ]))
    .await?;
    let second_id = field(&second, "task_id")?.to_owned();
    let second = wait_for(&cli, &["get", "task", &second_id], |task| {
        matches!(
            task["state"].as_str(),
            Some("TASK_STATE_SUCCEEDED" | "TASK_STATE_FAILED")
        )
    })
    .await?;
    ensure!(second["state"] == "TASK_STATE_SUCCEEDED", "{second}");
    assert_eq!(second["workspace_delivery"]["start_commit"], head.as_str());
    assert_eq!(
        second["result"],
        "Change: second\nWorkspace before:\nbase\nfirst\n"
    );

    fresh.kill().await?;
    plane.kill().await?;
    Ok(())
}

/// The fixture GitHub App's key, generated solely for tests and never used with GitHub.
const APP_KEY: &str = include_str!("../../gateway/src/github/fixtures/app-test-key.pem");
const SIGNING: &str = "synthetic-github-webhook-secret";

/// A loopback GitHub Enterprise Server: the REST API at `/api/v3/` for one App installation
/// on `acme/app`, and pull requests numbered from 7 in the order they are opened.
#[derive(Clone)]
struct Forge {
    bare: PathBuf,
    pulls: Arc<std::sync::Mutex<std::collections::BTreeMap<String, Value>>>,
    /// Each minted token, named by its permissions, such as `ghs_contents-write`.
    mints: Arc<std::sync::Mutex<Vec<String>>>,
    creates: Arc<AtomicUsize>,
    updates: Arc<AtomicUsize>,
}

const PULL_REQUEST_TOKEN: &str = "ghs_pull_requests-write";

impl Forge {
    fn head(&self, branch: &str) -> Option<String> {
        let output = std::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(&self.bare)
            .args(["rev-parse", "--verify", &format!("refs/heads/{branch}")])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .output()
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    }

    /// A pull request as GitHub returns it, with its head branch's current commit.
    fn current(&self, pull: &Value) -> Value {
        let mut pull = pull.clone();
        let branch = pull["head"]["ref"].as_str().unwrap_or_default().to_owned();
        pull["head"]["sha"] = self.head(&branch).unwrap_or_default().into();
        pull
    }
}

fn reply(status: StatusCode, value: Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(value.to_string()))
        .unwrap()
}

async fn github_api(State(forge): State<Forge>, request: Request<Body>) -> Response<Body> {
    let path = request
        .uri()
        .path()
        .trim_start_matches("/api/v3")
        .to_owned();
    let query = request.uri().query().unwrap_or("").to_owned();
    let method = request.method().clone();
    let bearer = request
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default()
        .to_owned();
    let body = to_bytes(request.into_body(), 1_048_576).await.unwrap();
    // The App's own calls carry its signed JWT.
    if path == "/repos/acme/app/installation" {
        if bearer.split('.').count() != 3 {
            return reply(StatusCode::UNAUTHORIZED, Value::Null);
        }
        return reply(
            StatusCode::OK,
            serde_json::json!({"id":88,"app_id":77,"account":{"login":"acme"},"suspended_at":null}),
        );
    }
    if path == "/app/installations/88/access_tokens" && method == "POST" {
        let input: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(input["repositories"], serde_json::json!(["app"]), "{input}");
        let permissions = input["permissions"].as_object().unwrap().clone();
        let token = format!(
            "ghs_{}",
            permissions
                .iter()
                .map(|(key, value)| format!("{key}-{}", value.as_str().unwrap()))
                .collect::<Vec<_>>()
                .join("+")
        );
        forge.mints.lock().unwrap().push(token.clone());
        let mut granted = permissions;
        granted.insert("metadata".into(), "read".into());
        let expires = chrono::DateTime::from_timestamp(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64
                + 3600,
            0,
        )
        .unwrap()
        .to_rfc3339();
        return reply(
            StatusCode::CREATED,
            serde_json::json!({"token":token,"expires_at":expires,"permissions":granted,"repository_selection":"selected","repositories":[{"id":123,"full_name":"acme/app"}]}),
        );
    }
    // Everything else is the review adapter, with only its pull request token.
    if bearer != PULL_REQUEST_TOKEN {
        return reply(StatusCode::FORBIDDEN, Value::Null);
    }
    if path == "/repos/acme/app" {
        return reply(
            StatusCode::OK,
            serde_json::json!({"id":123,"full_name":"acme/app"}),
        );
    }
    if path == "/repos/acme/app/pulls" && method == "POST" {
        let input: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(input["draft"], true);
        let branch = input["head"].as_str().unwrap().to_owned();
        let pull = {
            let mut pulls = forge.pulls.lock().unwrap();
            let number = 7 + pulls.len() as u64;
            let pull = serde_json::json!({"number":number,"state":"open","merged":false,"draft":true,"title":input["title"],"body":input["body"],"head":{"ref":branch,"sha":"","repo":{"id":123,"full_name":"acme/app"}},"base":{"ref":input["base"],"repo":{"id":123,"full_name":"acme/app"}}});
            pulls.insert(branch, pull.clone());
            pull
        };
        forge.creates.fetch_add(1, Ordering::SeqCst);
        return reply(StatusCode::CREATED, forge.current(&pull));
    }
    if path == "/repos/acme/app/pulls" {
        let url = reqwest::Url::parse(&format!("http://fixture/?{query}")).unwrap();
        let head = url
            .query_pairs()
            .find(|(key, _)| key == "head")
            .map(|(_, value)| value.into_owned())
            .unwrap_or_default();
        let branch = head.strip_prefix("acme:").unwrap_or_default().to_owned();
        let listed: Vec<Value> = forge
            .pulls
            .lock()
            .unwrap()
            .get(&branch)
            .cloned()
            .into_iter()
            .collect();
        let listed: Vec<Value> = listed.iter().map(|pull| forge.current(pull)).collect();
        return reply(StatusCode::OK, Value::Array(listed));
    }
    if let Some(number) = path.strip_prefix("/repos/acme/app/pulls/") {
        let number: u64 = number.parse().unwrap();
        let pull = {
            let mut pulls = forge.pulls.lock().unwrap();
            let Some(pull) = pulls
                .values_mut()
                .find(|pull| pull["number"].as_u64() == Some(number))
            else {
                return reply(StatusCode::NOT_FOUND, Value::Null);
            };
            if method == "PATCH" {
                let input: Value = serde_json::from_slice(&body).unwrap();
                pull["title"] = input["title"].clone();
                pull["body"] = input["body"].clone();
                forge.updates.fetch_add(1, Ordering::SeqCst);
            }
            pull.clone()
        };
        return reply(StatusCode::OK, forge.current(&pull));
    }
    reply(StatusCode::NOT_FOUND, Value::Null)
}

/// Delivers one signed webhook, redelivering while the Gateway answers 503 as GitHub does.
async fn webhook(endpoint: &str, delivery: &str, event: &str, payload: &Value) -> Result<u16> {
    use hmac::{Hmac, Mac};
    let body = payload.to_string();
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(SIGNING.as_bytes())?;
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
            sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .context("webhook delivery timed out")?
}

async fn a_review_workspace_opens_a_pull_request_that_closes_its_work_session(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path().canonicalize()?;

    let served = root.join("served");
    let bare = served.join("acme/app.git");
    std::fs::create_dir_all(&bare)?;
    git(
        &bare,
        &["init", "--bare", "--quiet", "--initial-branch=main"],
    )
    .await?;
    git(&bare, &["config", "http.receivepack", "true"]).await?;
    let seed = root.join("seed");
    git(&root, &["init", "--quiet", "--initial-branch=main", "seed"]).await?;
    std::fs::write(seed.join("workspace.txt"), "base\n")?;
    git(&seed, &["add", "workspace.txt"]).await?;
    git(&seed, &["commit", "--quiet", "-m", "Base"]).await?;
    let base = git(&seed, &["rev-parse", "HEAD"]).await?;
    git(
        &seed,
        &["push", "--quiet", bare.to_str().context("path")?, "main"],
    )
    .await?;

    // Git accepts only the narrowed App tokens: a read token fetches, a write token pushes.
    let server = Server {
        root: served.clone(),
        prefix: "",
        readers: vec!["x-access-token:ghs_contents-read".into()],
        writers: vec!["x-access-token:ghs_contents-write".into()],
        pushes: Arc::default(),
    };
    let forge = Forge {
        bare: bare.clone(),
        pulls: Arc::default(),
        mints: Arc::default(),
        creates: Arc::default(),
        updates: Arc::default(),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let remote = format!("{origin}/acme/app.git");
    let router = Router::new()
        .route("/api/v3/{*path}", any(github_api).with_state(forge.clone()))
        .fallback(any(git_http).with_state(server.clone()));
    let _serving = Serving(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));

    let credentials = Credentials {
        gateway: supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX),
        operator: Uuid::new_v4().to_string(),
        host: supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX),
        state: root.join("state"),
    };
    std::fs::create_dir(&credentials.state)?;
    std::fs::set_permissions(&credentials.state, std::fs::Permissions::from_mode(0o700))?;
    let mut plane = credentials.command(&["control-plane"]);
    plane
        .env("SUPERTAG_DATABASE_URL", &database)
        .env("SUPERTAG_STATE_DIR", &credentials.state)
        .arg("--git-delivery-directory")
        .arg(root.join("git-delivery"));
    let (mut plane, public) = service(plane).await?;
    let cli = |args: &[&str]| credentials.cli(&public, args);

    // The App's key reaches the vault from an owner-only file.
    let key = root.join("app.pem");
    std::fs::write(&key, APP_KEY)?;
    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600))?;
    let added = json(cli(&[
        "workspace",
        "credential",
        "add",
        "acme",
        "--github-app",
        "--app-id",
        "77",
        "--installation-id",
        "88",
        "--private-key",
        key.to_str().context("path")?,
    ]))
    .await?;
    assert_eq!(added["kind"], "github-app");
    assert_eq!(added["identifier"], "app:77/installation:88");
    // A self-hosted GitHub reviews only when the Workspace says it is GitHub.
    let mut plain = cli(&[
        "workspace",
        "put",
        "app",
        "--remote",
        &remote,
        "--credential",
        "acme",
        "--land",
        "review",
        "--base",
        "main",
    ]);
    let refused = timeout(WAIT, plain.output()).await??;
    ensure!(
        !refused.status.success()
            && String::from_utf8_lossy(&refused.stderr).contains("--forge github"),
        "{}",
        String::from_utf8_lossy(&refused.stderr)
    );
    let workspace = json(cli(&[
        "workspace",
        "put",
        "app",
        "--remote",
        &remote,
        "--ref",
        "main",
        "--credential",
        "acme",
        "--land",
        "review",
        "--base",
        "main",
        "--forge",
        "github",
    ]))
    .await?;
    assert_eq!(workspace["land"]["review"]["base"], "main");
    assert_eq!(workspace["forge"], "github");
    let check = json(cli(&["workspace", "check", "app"])).await?;
    for step in ["read", "push", "review"] {
        let status = check["steps"]
            .as_array()
            .and_then(|steps| steps.iter().find(|value| value["step"] == step))
            .map(|value| value["status"].clone());
        assert_eq!(status, Some("ok".into()), "{step}: {check}");
    }
    assert_eq!(server.pushes.load(Ordering::SeqCst), 0);

    json(cli(&[
        "tag",
        "put",
        "builder",
        "--name",
        "App Builder",
        "--instructions",
        "Improve the app",
        "--allow",
        "files:read",
        "--allow",
        "files:write",
        "--workspace-id",
        "app",
    ]))
    .await?;

    // The Gateway's GitHub connector for the same repository receives the merge webhook.
    let mut gateway = credentials.command(&[
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
        .env("SUPERTAG_GITHUB_REPOSITORY", "acme/app")
        .env("SUPERTAG_GITHUB_TAG_ID", "builder")
        .env("SUPERTAG_GITHUB_ALLOWED_USERS", "42")
        .env("SUPERTAG_GITHUB_WEBHOOK_SECRET", SIGNING)
        .env("SUPERTAG_GITHUB_TOKEN", "surface-token")
        .env("SUPERTAG_TEST_GITHUB_API_URL", format!("{origin}/"));
    let (mut gateway, endpoints) = services(gateway, 2).await?;
    let webhooks = endpoints[1].clone();

    let host = |state: &str, mode: &str, once: bool| {
        let mut host = credentials.command(&["worker-host", "--control-plane", &public]);
        if once {
            host.arg("--once");
        }
        host.arg("--adapter")
            .arg(ADAPTER)
            .arg(format!("--adapter-arg={mode}"))
            .arg("--state-directory")
            .arg(root.join(state))
            .arg("--artifact-directory")
            .arg(holding_host::artifact_directory(&root))
            .args(["--remote-workspace", "app"]);
        host
    };
    // Runs `--once` hosts until `task` succeeds: a remote Workspace's Task is claimable once git
    // delivery pinned its Session's source.
    let run_until = |state: &str, mode: &str, task: Value| {
        let state = state.to_owned();
        let mode = mode.to_owned();
        let host = &host;
        let cli = &cli;
        async move {
            let task = field(&task, "task_id")?.to_owned();
            timeout(WAIT, async {
                loop {
                    let output = host(&state, &mode, true).output().await?;
                    ensure!(
                        output.status.success(),
                        "{}",
                        String::from_utf8_lossy(&output.stderr)
                    );
                    let current = json(cli(&["get", "task", &task])).await?;
                    match current["state"].as_str() {
                        Some("TASK_STATE_SUCCEEDED") => return Ok(()),
                        Some("TASK_STATE_QUEUED") => sleep(Duration::from_millis(250)).await,
                        _ => anyhow::bail!("{current}"),
                    }
                }
            })
            .await
            .context("the Task never ran")?
        }
    };

    // A conversation turn starts a Work Session; a holding host runs its Task, which commits.
    let root = json(cli(&[
        "task",
        "submit",
        "--tag",
        "builder",
        "--session",
        "feature",
        "Split the work",
    ]))
    .await?;
    run_until("host-root", "--start-work-session", root).await?;
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
    let mut holding =
        holding_host::serve(host("host-holding", "--workspace-fixture", false)).await?;
    let landed = |count: usize| {
        let cli = &cli;
        let work = work.clone();
        async move {
            wait_for(cli, &["get", "landings", "--session-id", &work], |page| {
                page["landings"].as_array().is_some_and(|landings| {
                    landings.len() >= count && landings[0]["state"] == "landed"
                })
            })
            .await
        }
    };
    let first = landed(1).await?;
    let first = &first["landings"][0];
    assert_eq!(first["mode"], "review");
    let branch = supertag_protocol::session_branch("builder", &work);
    assert_eq!(first["branch"], branch.as_str());
    let number = first["pull_request"]["number"]
        .as_u64()
        .with_context(|| format!("no pull request: {first}"))?;
    assert_eq!(
        first["pull_request"]["url"],
        format!("{origin}/acme/app/pull/{number}")
    );
    let head = field(first, "landed_commit")?.to_owned();
    assert_eq!(forge.head(&branch).as_deref(), Some(head.as_str()));
    let opened = forge.pulls.lock().unwrap().get(&branch).cloned().unwrap();
    assert_eq!(opened["draft"], true);
    assert_eq!(opened["title"], "Bounded investigation");
    assert_eq!(opened["base"]["ref"], "main");
    assert_eq!(git(&bare, &["rev-parse", "refs/heads/main"]).await?, base);

    // The Work Session's report runs; then a later turn continues the Work Session.
    wait_for(&cli, &["get", "session", &work], |session| {
        session["report_task_state"] == "TASK_STATE_SUCCEEDED"
    })
    .await?;
    holding.kill().await?;
    let next = json(cli(&[
        "task",
        "submit",
        "--tag",
        "builder",
        "--session",
        "feature",
        "Use us-east-1",
    ]))
    .await?;
    run_until(
        "host-continue",
        &format!("--continue-work-session={work}"),
        next,
    )
    .await?;
    let _holding = holding_host::serve(host("host-holding-again", "--workspace-fixture", false))
        .await
        .context("the second holding host")?;

    // The second Task updates the same pull request: one creation, its description updated.
    let second = landed(2).await?;
    let second = &second["landings"][0];
    ensure!(second["landed_commit"] != head.as_str(), "{second}");
    assert_eq!(second["pull_request"]["number"], number);
    let creates_for_branch = forge
        .pulls
        .lock()
        .unwrap()
        .get(&branch)
        .map(|pull| pull["number"].as_u64());
    assert_eq!(creates_for_branch, Some(Some(number)));
    assert!(forge.updates.load(Ordering::SeqCst) >= 1);
    let updated = forge.pulls.lock().unwrap().get(&branch).cloned().unwrap();
    ensure!(updated["body"] != opened["body"], "{updated}");
    assert_eq!(
        forge.head(&branch).as_deref(),
        second["landed_commit"].as_str()
    );
    // Every token was narrowed to its use; none could do everything.
    let mints = forge.mints.lock().unwrap().clone();
    for token in [
        "ghs_contents-read",
        "ghs_contents-write",
        PULL_REQUEST_TOKEN,
    ] {
        ensure!(mints.iter().any(|mint| mint == token), "{mints:?}");
    }
    ensure!(mints.iter().all(|mint| !mint.contains('+')), "{mints:?}");

    // Closing another pull request, or this one unmerged, changes nothing; its merge closes
    // the Work Session.
    let closed = |number: u64, merged: bool| serde_json::json!({"action":"closed","sender":{"id":99,"type":"User"},"repository":{"id":123,"full_name":"acme/app"},"pull_request":{"id":5_000 + number,"number":number,"merged":merged}});
    assert_eq!(
        webhook(
            &webhooks,
            "closed-other",
            "pull_request",
            &closed(number + 50, true)
        )
        .await?,
        202
    );
    assert_eq!(
        webhook(
            &webhooks,
            "closed-unmerged",
            "pull_request",
            &closed(number, false)
        )
        .await?,
        202
    );
    let open = json(cli(&["get", "session", &work])).await?;
    ensure!(open["close_reason"].is_null(), "{open}");
    assert_eq!(
        webhook(&webhooks, "merged", "pull_request", &closed(number, true)).await?,
        202
    );
    let merged = wait_for(&cli, &["get", "session", &work], |session| {
        !session["close_reason"].is_null()
    })
    .await?;
    assert_eq!(merged["close_reason"], "WORK_SESSION_CLOSE_REASON_MERGED");

    gateway.kill().await?;
    plane.kill().await?;
    Ok(())
}

async fn wait_for(
    cli: &impl Fn(&[&str]) -> Command,
    args: &[&str],
    done: impl Fn(&Value) -> bool,
) -> Result<Value> {
    timeout(WAIT, async {
        loop {
            let value = json(cli(args)).await?;
            if done(&value) {
                return Ok::<_, anyhow::Error>(value);
            }
            sleep(Duration::from_millis(250)).await;
        }
    })
    .await
    .with_context(|| format!("{args:?} never reached the expected state"))?
}

async fn service(command: Command) -> Result<(Child, String)> {
    let (child, mut endpoints) = services(command, 1).await?;
    Ok((child, endpoints.remove(0)))
}

/// Starts `command` and reads `count` loopback endpoints from its first lines of output.
async fn services(mut command: Command, count: usize) -> Result<(Child, Vec<String>)> {
    let mut child = command.stdout(Stdio::piped()).spawn()?;
    let mut stdout = BufReader::new(child.stdout.take().context("service stdout missing")?);
    let mut endpoints = Vec::new();
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
        let mut lines = stdout.lines();
        while let Ok(Some(_)) = lines.next_line().await {}
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

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value[name]
        .as_str()
        .with_context(|| format!("missing {name}: {value}"))
}

async fn git(directory: &Path, arguments: &[&str]) -> Result<String> {
    let mut command = Command::new("/usr/bin/git");
    command
        .arg("-C")
        .arg(directory)
        .args(arguments)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid");
    let output = timeout(WAIT, command.output())
        .await
        .context("git timed out")??;
    ensure!(
        output.status.success(),
        "git {arguments:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(String::from_utf8(output.stdout)?.trim().into())
}
