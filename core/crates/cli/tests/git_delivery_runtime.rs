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
}

/// The git server: repositories under `root`, served with `git http-backend`, for one token.
#[derive(Clone)]
struct Server {
    root: PathBuf,
    pushes: Arc<AtomicUsize>,
}

struct Serving(tokio::task::JoinHandle<()>);
impl Drop for Serving {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn git_http(State(server): State<Server>, request: Request<Body>) -> Response<Body> {
    let expected = format!("Basic {}", STANDARD.encode(format!("supertag:{TOKEN}")));
    if request
        .headers()
        .get("authorization")
        .is_none_or(|value| value != expected.as_str())
    {
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
            .env("PATH_INFO", parts.uri.path().strip_prefix("/git").unwrap())
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
        .arg("--checkpoint-directory")
        .arg(root.join("checkpoints"))
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
        "--land",
        "branch",
    ]))
    .await?;
    assert_eq!(workspace["land"], "branch");
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
        .args([
            "--workspace-id",
            "handbook",
            "--workspace-from-control-plane",
        ])
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

    host.kill().await?;
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

async fn service(mut command: Command) -> Result<(Child, String)> {
    let mut child = command.stdout(Stdio::piped()).spawn()?;
    let mut stdout = BufReader::new(child.stdout.take().context("service stdout missing")?);
    let mut line = String::new();
    timeout(WAIT, stdout.read_line(&mut line))
        .await
        .context("service startup timed out")??;
    let address: SocketAddr = line.trim().parse().context("service endpoint missing")?;
    ensure!(address.ip().is_loopback() && address.port() != 0);
    tokio::spawn(async move {
        let mut lines = stdout.lines();
        while let Ok(Some(_)) = lines.next_line().await {}
    });
    Ok((child, format!("http://{address}")))
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
