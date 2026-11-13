//! Real split services fetch only the pinned source from a loopback GitHub/Git fixture.
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
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    net::SocketAddr,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
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
const WAIT: Duration = Duration::from_secs(45);
#[derive(Clone)]
struct Fixture {
    root: PathBuf,
    commit: String,
    source_head: Arc<Mutex<String>>,
    source_lookups: Arc<AtomicUsize>,
    calls: Arc<AtomicUsize>,
    publication: Option<Arc<Mutex<Option<Value>>>>,
    creates: Arc<AtomicUsize>,
    updates: Arc<AtomicUsize>,
    pushes: Arc<AtomicUsize>,
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
            "core.hooksPath=/dev/null",
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

async fn api_handler(State(fixture): State<Fixture>, request: Request<Body>) -> Response<Body> {
    fixture.calls.fetch_add(1, Ordering::SeqCst);
    assert_eq!(
        request.headers().get("authorization").unwrap(),
        "Bearer fixture-source-token"
    );
    if fixture.publication.is_some()
        && request.uri().path().starts_with("/repos/acme/project/")
        && !request.uri().path().contains("/commits/")
    {
        return publication_api(fixture, request).await;
    }
    let value = if request.uri().path() == "/repositories/123" {
        serde_json::json!({"id":123,"full_name":"acme/project","default_branch":"main"})
    } else if request.uri().path() == "/repos/acme/project/commits/main" {
        fixture.source_lookups.fetch_add(1, Ordering::SeqCst);
        serde_json::json!({"sha":fixture.source_head.lock().unwrap().clone()})
    } else if request.uri().path() == format!("/repos/acme/project/commits/{}", fixture.commit) {
        serde_json::json!({"sha":fixture.commit})
    } else if request.uri().path()
        == format!(
            "/repos/acme/project/commits/{}",
            fixture.source_head.lock().unwrap()
        )
    {
        serde_json::json!({"sha":fixture.source_head.lock().unwrap().clone()})
    } else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .unwrap();
    };
    Response::new(Body::from(value.to_string()))
}

async fn git_http(State(fixture): State<Fixture>, request: Request<Body>) -> Response<Body> {
    fixture.calls.fetch_add(1, Ordering::SeqCst);
    let expected = format!(
        "Basic {}",
        STANDARD.encode("x-access-token:fixture-source-token")
    );
    assert_eq!(
        request.headers().get("authorization").unwrap(),
        expected.as_str()
    );
    if request.uri().path().ends_with("git-receive-pack") && request.method() == "POST" {
        fixture.pushes.fetch_add(1, Ordering::SeqCst);
    }
    let (parts, body) = request.into_parts();
    let bytes = to_bytes(body, 1_048_576).await.unwrap();
    tokio::task::spawn_blocking(move || {
        let mut command = std::process::Command::new("/usr/bin/git");
        command
            .arg("http-backend")
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_PROJECT_ROOT", fixture.root)
            .env("GIT_HTTP_EXPORT_ALL", "1")
            .env("PATH_INFO", parts.uri.path().strip_prefix("/git").unwrap())
            .env("REQUEST_METHOD", parts.method.as_str())
            .env("QUERY_STRING", parts.uri.query().unwrap_or(""))
            .env(
                "CONTENT_TYPE",
                parts
                    .headers
                    .get("content-type")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or(""),
            )
            .env(
                "HTTP_GIT_PROTOCOL",
                parts
                    .headers
                    .get("git-protocol")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or(""),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().unwrap();
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

async fn service(mut command: Command) -> Result<(Child, String)> {
    let mut child = command.stdout(Stdio::piped()).spawn()?;
    let mut stdout = BufReader::new(child.stdout.take().context("service stdout missing")?);
    let mut line = String::new();
    timeout(WAIT, stdout.read_line(&mut line))
        .await
        .context("service startup timed out")??;
    let address: SocketAddr = line.trim().parse().context("service endpoint missing")?;
    ensure!(address.ip().is_loopback() && address.port() != 0);
    Ok((child, format!("http://{address}")))
}

async fn output(mut command: Command) -> Result<std::process::Output> {
    Ok(timeout(WAIT, command.output())
        .await
        .context("CLI command timed out")??)
}
async fn success(command: Command) -> Result<std::process::Output> {
    let output = output(command).await?;
    ensure!(
        output.status.success(),
        "CLI failed: {}",
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

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    source_and_continuation_cross_hosts_without_provider_credentials;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    publication_approval_then_replacement_proves_lost_create_without_reposting;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    moving_ref_pins_session_before_execution_and_survives_gateway_restart;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires SUPERTAG_RUST_TEST_NODE and a built Claude Code language adapter"]
    github_workspace_output_references_are_verified_by_the_credentialed_gateway;
}

async fn source_and_continuation_cross_hosts_without_provider_credentials(
    database: String,
) -> Result<()> {
    scenario(&database, false, false, false).await
}

async fn publication_approval_then_replacement_proves_lost_create_without_reposting(
    database: String,
) -> Result<()> {
    scenario(&database, true, false, false).await
}

async fn moving_ref_pins_session_before_execution_and_survives_gateway_restart(
    database: String,
) -> Result<()> {
    scenario(&database, false, true, false).await
}

async fn github_workspace_output_references_are_verified_by_the_credentialed_gateway(
    database: String,
) -> Result<()> {
    if crate::prerequisites::env("node", "SUPERTAG_RUST_TEST_NODE")?.is_none() {
        return Ok(());
    }
    scenario(&database, false, false, true).await
}

async fn scenario(
    database: &str,
    publication: bool,
    moving: bool,
    git_outputs: bool,
) -> Result<()> {
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
    git(
        root,
        &[
            "clone",
            "--bare",
            "--quiet",
            repository.to_str().unwrap(),
            exported.join("acme/project.git").to_str().unwrap(),
        ],
    );
    git(
        &exported.join("acme/project.git"),
        &["config", "http.receivepack", "true"],
    );
    fs::write(
        repository.join("workspace.txt"),
        "uncommitted operator work\n",
    )?;
    fs::write(repository.join("operator-only.txt"), "not accepted\n")?;
    let calls = Arc::new(AtomicUsize::new(0));
    let creates = Arc::new(AtomicUsize::new(0));
    let updates = Arc::new(AtomicUsize::new(0));
    let pushes = Arc::new(AtomicUsize::new(0));
    let source_head = Arc::new(Mutex::new(commit.clone()));
    let source_lookups = Arc::new(AtomicUsize::new(0));
    let fixture = Fixture {
        root: exported.clone(),
        source_head: source_head.clone(),
        source_lookups: source_lookups.clone(),
        commit: commit.clone(),
        calls: calls.clone(),
        publication: publication.then(|| Arc::new(Mutex::new(None))),
        creates: creates.clone(),
        updates: updates.clone(),
        pushes: pushes.clone(),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let api = format!("http://{}/", listener.local_addr()?);
    let router = Router::new()
        .route("/git/{*path}", any(git_http))
        .fallback(api_handler)
        .with_state(fixture);
    let _server = Server(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));
    let gateway_token = Uuid::new_v4().to_string();
    let operator_token = Uuid::new_v4().to_string();
    let host_token = Uuid::new_v4().to_string();
    let command = |args: &[&str]| {
        let mut command = Command::new(BINARY);
        command
            .args(args)
            .env_clear()
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
            .env("SUPERTAG_OPERATOR_TOKEN", &operator_token)
            .env("SUPERTAG_HOST_TOKEN", &host_token)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token);
        command
    };
    let mut cp = command(&["control-plane"]);
    cp.env("SUPERTAG_DATABASE_URL", database);
    let (mut plane, private) = service(cp).await?;
    let gateway_command = |listen: &str| {
        let mut gateway = command(&["gateway", "--control-plane", &private, "--listen", listen]);
        gateway
            .arg("--checkpoint-directory")
            .arg(root.join("artifacts"))
            .arg("--github-workspace-directory")
            .arg(root.join("sources"))
            .env("SUPERTAG_GITHUB_ACCOUNT_ID", "github-source")
            .env("SUPERTAG_GITHUB_REPOSITORY_ID", "123")
            .env("SUPERTAG_GITHUB_REPOSITORY", "acme/project")
            .env("SUPERTAG_GITHUB_TOKEN", "fixture-source-token")
            .env("SUPERTAG_TEST_GITHUB_API_URL", &api)
            .env("SUPERTAG_TEST_GITHUB_GIT_URL", format!("{api}git/"));
        gateway
    };
    let (mut gateway, public) = service(gateway_command("127.0.0.1:0")).await?;
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
        json!({"account_id":"github-source","identity":{"provider":"github","external_account_id":"installation:42"},"enabled":true}),
    )?;
    json(cli(&["surface-policy", "put", "account", &account])).await?;
    let mut create_source = cli(&[
        "github-workspace",
        "put",
        "project",
        "--account",
        "github-source",
        "--repository-id",
        "123",
        "--repository",
        "acme/project",
        "--operation-id",
        "source",
    ]);
    if !moving {
        create_source.args(["--commit", &commit]);
    }
    if publication {
        create_source.args(["--pull-request-base", "main"]);
    }
    let source = json(create_source).await?;
    assert_eq!(
        source["source"]["commit_sha"],
        if moving { "" } else { &commit }
    );
    assert_eq!(
        json(cli(&["github-workspace", "list"])).await?["workspaces"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let mut put_tag = cli(&[
        "put-tag",
        "builder",
        "--instructions",
        "Improve repository",
        "--allow",
        "files:read",
        "--allow",
        "files:write",
        "--workspace-id",
        "project",
    ]);
    if !moving {
        put_tag.args(["--workspace-base", &commit]);
    }
    json(put_tag).await?;
    assert!(
        !output(cli(&[
            "submit",
            "--tag",
            "builder",
            "--session",
            "feature",
            "denied"
        ]))
        .await?
        .status
        .success()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let mut permissions = vec![
        json!({"target":"surface","surface_account_id":"github-source","scope":"repository:123","action":"contents:read"}),
    ];
    if publication {
        permissions.push(json!({"target":"surface","surface_account_id":"github-source","scope":"repository:123","action":"pull-requests:create","approval_required":true}));
    }
    let grant = spec(
        "grant.json",
        json!({"set_id":"read-source","name":"read-source","permissions":permissions}),
    )?;
    json(cli(&["policy", "put", "permission-set", &grant])).await?;
    let role = spec(
        "role.json",
        json!({"role_id":"reader","name":"reader","purpose":"Read source","permission_set_ids":["read-source"]}),
    )?;
    json(cli(&["policy", "put", "role", &role])).await?;
    json(cli(&["policy", "assign", "reader", "builder"])).await?;
    if git_outputs {
        let policy = spec(
            "output-policy.json",
            json!({
                "include": [], "required": ["workspace.txt"], "git": "reference",
            }),
        )?;
        verify_github_output(root, &cli, (&public, &host_token, &commit), &policy).await?;
        gateway.kill().await?;
        gateway.wait().await?;
        plane.kill().await?;
        plane.wait().await?;
        return Ok(());
    }
    let adapter = root.join("isolated-adapter");
    fs::write(
        &adapter,
        format!(
            "#!/bin/sh\nset -eu\nfor name in SUPERTAG_GITHUB_TOKEN SUPERTAG_GATEWAY_TOKEN SUPERTAG_OPERATOR_TOKEN SUPERTAG_HOST_TOKEN GIT_CONFIG_VALUE_0; do\n eval 'test -z \"${{'\"$name\"'+x}}\"' || exit 22\ndone\nexec '{}' \"$@\"\n",
            ADAPTER
        ),
    )?;
    fs::set_permissions(&adapter, fs::Permissions::from_mode(0o700))?;
    let worker = |state: &str, mapped: bool| {
        let mut host = command(&["worker-host", "--gateway", &public, "--once"]);
        host.arg("--adapter")
            .arg(&adapter)
            .arg("--adapter-arg=--workspace-fixture")
            .arg("--state-directory")
            .arg(root.join(state));
        // A malicious ambient provider value is not part of the adapter profile.
        host.env("SUPERTAG_GITHUB_TOKEN", "ambient-must-not-reach-adapter");
        if mapped {
            host.args(["--workspace-id", "project", "--workspace-from-gateway"]);
        }
        host
    };
    let first = json(cli(&[
        "submit",
        "--tag",
        "builder",
        "--session",
        "feature",
        "first",
    ]))
    .await?;
    let first_id = field(&first, "task_id")?;
    success(worker("unmapped", false)).await?;
    assert_eq!(
        json(cli(&["get-task", first_id])).await?["state"],
        "TASK_STATE_QUEUED"
    );
    if !moving {
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
    if moving {
        wait_source_pin(&cli, first_id, &commit).await?;
        assert_eq!(source_lookups.load(Ordering::SeqCst), 1);
    }
    success(worker("host-one", true)).await?;
    let first = json(cli(&["get-task", first_id])).await?;
    assert_eq!(first["state"], "TASK_STATE_SUCCEEDED", "{first}");
    assert_eq!(first["result"], "Change: first\nWorkspace before:\nbase\n");
    let first_head = field(&first["workspace_delivery"], "head_commit")?.to_owned();
    let first_publication = if publication {
        let value =
            wait_publication(&cli, first_id, "GITHUB_PUBLICATION_STATE_WAITING_APPROVAL").await?;
        assert_eq!(
            pushes.load(Ordering::SeqCst),
            0,
            "approval must precede Git push"
        );
        assert_eq!(creates.load(Ordering::SeqCst), 0);
        let approval = field(&value, "approval_id")?;
        let inbox = json(cli(&["inbox", "list", "--kind", "approval"])).await?;
        assert!(
            inbox["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["task_id"] == first_id)
        );
        json(cli(&[
            "inbox",
            "approve",
            approval,
            "--operation-id",
            "approve-first-publication",
        ]))
        .await?;
        timeout(WAIT, async {
            while creates.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await?;
        Some(value)
    } else {
        None
    };
    gateway.kill().await?;
    gateway.wait().await?;
    gateway = service(gateway_command(public.strip_prefix("http://").unwrap()))
        .await?
        .0;
    if let Some(waiting) = first_publication {
        let delivered =
            wait_publication(&cli, first_id, "GITHUB_PUBLICATION_STATE_PUBLISHED").await?;
        assert_eq!(delivered["publication_id"], waiting["publication_id"]);
        assert_eq!(delivered["pull_request"]["number"], 7);
        assert_eq!(
            creates.load(Ordering::SeqCst),
            1,
            "replacement must not repeat ambiguous creation"
        );
        assert_eq!(
            pushes.load(Ordering::SeqCst),
            1,
            "replacement must not repeat ambiguous push"
        );
    }
    let next_commit = if moving {
        let upstream = root.join("upstream");
        git(
            root,
            &[
                "clone",
                "--quiet",
                exported.join("acme/project.git").to_str().unwrap(),
                upstream.to_str().unwrap(),
            ],
        );
        fs::write(upstream.join("workspace.txt"), "new upstream\n")?;
        git(&upstream, &["add", "."]);
        git(
            &upstream,
            &["commit", "--quiet", "-m", "Advance source branch"],
        );
        git(&upstream, &["push", "--quiet", "origin", "HEAD:main"]);
        let head = git(&upstream, &["rev-parse", "HEAD"]);
        *source_head.lock().unwrap() = head.clone();
        Some(head)
    } else {
        None
    };
    let second = json(cli(&[
        "submit",
        "--tag",
        "builder",
        "--session",
        "feature",
        "second",
    ]))
    .await?;
    let second_id = field(&second, "task_id")?;
    success(worker("host-two", true)).await?;
    let second = json(cli(&["get-task", second_id])).await?;
    assert_eq!(second["state"], "TASK_STATE_SUCCEEDED", "{second}");
    assert_eq!(second["workspace_delivery"]["start_commit"], first_head);
    if publication {
        let delivered =
            wait_publication(&cli, second_id, "GITHUB_PUBLICATION_STATE_PUBLISHED").await?;
        assert!(
            delivered["approval_id"].is_null(),
            "existing Session PR should not repeat first-publication approval"
        );
        assert_eq!(delivered["pull_request"]["number"], 7);
        assert_eq!(creates.load(Ordering::SeqCst), 1);
        assert_eq!(updates.load(Ordering::SeqCst), 1);
        assert_eq!(pushes.load(Ordering::SeqCst), 2);
    }

    assert_eq!(
        second["result"],
        "Change: second\nWorkspace before:\nbase\nfirst\n"
    );
    if let Some(next_commit) = next_commit {
        assert_eq!(
            source_lookups.load(Ordering::SeqCst),
            1,
            "later Session turns must not re-resolve a moving ref"
        );
        assert_eq!(second["workspace"]["base_commit"], commit);
        let fresh = json(cli(&[
            "submit",
            "--tag",
            "builder",
            "--session",
            "new-source",
            "new session",
        ]))
        .await?;
        let fresh_id = field(&fresh, "task_id")?;
        wait_source_pin(&cli, fresh_id, &next_commit).await?;
        success(worker("host-new-session", true)).await?;
        let fresh = json(cli(&["get-task", fresh_id])).await?;
        assert_eq!(fresh["state"], "TASK_STATE_SUCCEEDED", "{fresh}");
        assert_eq!(
            fresh["result"],
            "Change: new session\nWorkspace before:\nnew upstream\n"
        );
        assert_eq!(fresh["workspace"]["base_commit"], next_commit);
        assert_eq!(source_lookups.load(Ordering::SeqCst), 2);
    }
    assert_eq!(
        fs::read_to_string(repository.join("workspace.txt"))?,
        "uncommitted operator work\n"
    );
    assert_eq!(git(&repository, &["rev-parse", "HEAD"]), commit);
    let patch = root.join("review.patch");
    let mut download = cli(&["workspace-artifact", "--kind", "patch", second_id]);
    download.arg("--output").arg(&patch);
    success(download).await?;
    let bytes = fs::read(&patch)?;
    assert!(String::from_utf8_lossy(&bytes).contains("+second"));
    assert!(!String::from_utf8_lossy(&bytes).contains("fixture-source-token"));
    gateway.kill().await?;
    gateway.wait().await?;
    plane.kill().await?;
    plane.wait().await?;
    // The same explicit mapping works through the normal local supervisor.
    let local = root.join("local");
    let mut up = command(&[
        "up",
        "--workspace-id",
        "project",
        "--workspace-from-gateway",
    ]);
    up.arg("--state-directory")
        .arg(&local)
        .arg("--adapter")
        .arg(&adapter)
        .arg("--adapter-arg=--workspace-fixture")
        .env("SUPERTAG_GITHUB_ACCOUNT_ID", "github-source")
        .env("SUPERTAG_GITHUB_REPOSITORY_ID", "123")
        .env("SUPERTAG_GITHUB_REPOSITORY", "acme/project")
        .env("SUPERTAG_GITHUB_TOKEN", "fixture-source-token")
        .env("SUPERTAG_TEST_GITHUB_API_URL", &api)
        .env("SUPERTAG_TEST_GITHUB_GIT_URL", format!("{api}git/"));
    let mut local_process = up.stdout(Stdio::piped()).spawn()?;
    let mut stdout = BufReader::new(
        local_process
            .stdout
            .take()
            .context("local output missing")?,
    );
    let mut endpoint = String::new();
    timeout(WAIT, stdout.read_line(&mut endpoint)).await??;
    ensure!(
        endpoint.starts_with("http://127.0.0.1:"),
        "local endpoint missing"
    );
    let local_cli = |args: &[&str]| {
        let mut c = command(&[args[0], "--state-directory"]);
        c.arg(&local).args(&args[1..]);
        c
    };
    json(local_cli(&["surface-policy", "put", "account", &account])).await?;
    json(local_cli(&[
        "github-workspace",
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
    ]))
    .await?;
    json(local_cli(&[
        "put-tag",
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
    json(local_cli(&["policy", "put", "permission-set", &grant])).await?;
    json(local_cli(&["policy", "put", "role", &role])).await?;
    json(local_cli(&["policy", "assign", "reader", "builder"])).await?;
    let task = json(local_cli(&[
        "submit",
        "--tag",
        "builder",
        "--session",
        "local",
        "local",
    ]))
    .await?;
    let task_id = field(&task, "task_id")?;
    timeout(WAIT, async {
        loop {
            let task = json(local_cli(&["get-task", task_id])).await?;
            if task["state"] == "TASK_STATE_SUCCEEDED" {
                break Ok::<_, anyhow::Error>(());
            }
            ensure!(task["state"] != "TASK_STATE_FAILED", "{task}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await??;
    unsafe {
        libc::kill(
            local_process.id().context("local process missing")? as i32,
            libc::SIGTERM,
        );
    }
    ensure!(
        timeout(WAIT, local_process.wait()).await??.success(),
        "local services did not stop cleanly"
    );
    Ok(())
}

async fn verify_github_output(
    root: &Path,
    cli: &impl Fn(&[&str]) -> Command,
    (public, host_token, commit): (&str, &str, &str),
    policy: &str,
) -> Result<()> {
    let node =
        std::env::var_os("SUPERTAG_RUST_TEST_NODE").context("Node test executable required")?;
    let harness = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/runtime/harnesses/claude-code")
        .canonicalize()?;
    let native = root.join("native-claude-fixture.mjs");
    fs::copy(harness.join("fixtures/rust-native-claude.mjs"), &native)?;
    fs::set_permissions(&native, fs::Permissions::from_mode(0o700))?;
    json(cli(&[
        "put-tag",
        "git-output",
        "--instructions",
        "Preserve exact Git outputs.",
        "--harness",
        "claude-code",
        "--allow",
        "files:read",
        "--workspace-id",
        "project",
        "--workspace-base",
        commit,
    ]))
    .await?;
    json(cli(&["policy", "assign", "reader", "git-output"])).await?;
    let task = json(cli(&[
        "submit",
        "--tag",
        "git-output",
        "--session",
        "git-output",
        "--outputs",
        policy,
        "Read the source.",
    ]))
    .await?;
    let task_id = field(&task, "task_id")?;
    let mut worker = Command::new(BINARY);
    worker
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("SUPERTAG_HOST_TOKEN", host_token)
        .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", host_token)
        .env("ANTHROPIC_API_KEY", "synthetic-model-token")
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .args([
            "worker-host",
            "--gateway",
            public,
            "--once",
            "--harness",
            "claude-code",
            "--harness-model",
            "fixture-model",
            "--workspace-id",
            "project",
            "--workspace-from-gateway",
            "--harness-runtime",
        ])
        .arg(node)
        .arg("--harness-entrypoint")
        .arg(harness.join("dist/rust-adapter/entry.js"))
        .arg("--claude-path")
        .arg(native)
        .arg("--state-directory")
        .arg(root.join("git-output-host"));
    success(worker).await?;
    let completed = json(cli(&["get-task", task_id])).await?;
    assert_eq!(completed["state"], "TASK_STATE_SUCCEEDED", "{completed}");
    let selection = &completed["artifacts"][0];
    assert_eq!(selection["paths"], json!(["supertag-git-output.json"]));
    let path = root.join("downloaded-git-output.json");
    json(cli(&[
        "artifact",
        "download",
        field(selection, "artifact_id")?,
        "--path",
        "supertag-git-output.json",
        "--output",
        path.to_str().context("fixture destination is not UTF-8")?,
    ]))
    .await?;
    let bytes = fs::read(path)?;
    assert!(!String::from_utf8_lossy(&bytes).contains("fixture-source-token"));
    let manifest: Value = serde_json::from_slice(&bytes)?;
    assert_eq!(manifest["remote"], "https://github.com/acme/project.git");
    assert_eq!(manifest["head"], commit);
    assert_eq!(manifest["referencedPaths"], json!(["workspace.txt"]));
    Ok(())
}

async fn wait_source_pin<F>(cli: &F, task: &str, commit: &str) -> Result<()>
where
    F: Fn(&[&str]) -> Command,
{
    timeout(WAIT, async {
        loop {
            let value = json(cli(&["get-task", task])).await?;
            if value["workspace"]["base_commit"] == commit {
                return Ok::<_, anyhow::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await??;
    Ok(())
}

async fn wait_publication<F>(cli: &F, task: &str, state: &str) -> Result<Value>
where
    F: Fn(&[&str]) -> Command,
{
    timeout(WAIT, async {
        loop {
            let page = json(cli(&["github-publication", "list", "--task-id", task])).await?;
            if let Some(job) = page["publications"]
                .as_array()
                .and_then(|jobs| jobs.first())
            {
                if job["state"] == state {
                    return Ok(job.clone());
                }
                ensure!(
                    job["state"] != "GITHUB_PUBLICATION_STATE_HELD"
                        && job["state"] != "GITHUB_PUBLICATION_STATE_CANCELLED",
                    "publication stopped: {job}"
                );
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .context("publication status timed out")?
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
async fn publication_api(fixture: Fixture, request: Request<Body>) -> Response<Body> {
    let path = request.uri().path().to_owned();
    let method = request.method().clone();
    let state = fixture.publication.as_ref().unwrap();
    if let Some(branch) = path.strip_prefix("/repos/acme/project/git/ref/heads/") {
        return match remote_head(&fixture, branch) {
            Some(head) => Response::new(Body::from(
                json!({"ref":format!("refs/heads/{branch}"),"object":{"type":"commit","sha":head}})
                    .to_string(),
            )),
            None => Response::builder().status(404).body(Body::empty()).unwrap(),
        };
    }
    if path == "/repos/acme/project/pulls" && method == "POST" {
        let body = to_bytes(request.into_body(), 65536).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["draft"], true);
        assert_eq!(body["base"], "main");
        let branch = body["head"].as_str().unwrap();
        let head = remote_head(&fixture, branch).unwrap();
        let value = json!({"number":7,"html_url":"https://github.com/acme/project/pull/7","state":"open","merged":false,"draft":true,"title":body["title"],"body":body["body"],"head":{"ref":branch,"sha":head,"repo":{"id":123,"full_name":"acme/project"}},"base":{"ref":"main","repo":{"id":123,"full_name":"acme/project"}}});
        *state.lock().unwrap() = Some(value.clone());
        fixture.creates.fetch_add(1, Ordering::SeqCst);
        // Provider accepted the POST, but the original Gateway never sees its reply.
        tokio::time::sleep(Duration::from_secs(90)).await;
        return Response::builder()
            .status(201)
            .body(Body::from(value.to_string()))
            .unwrap();
    }
    if path.starts_with("/repos/acme/project/pulls") {
        let mut value = state.lock().unwrap().clone();
        if let Some(value) = &mut value {
            let branch = value["head"]["ref"].as_str().unwrap();
            value["head"]["sha"] = remote_head(&fixture, branch).unwrap().into();
        }
        if method == "PATCH" {
            let bytes = to_bytes(request.into_body(), 65536).await.unwrap();
            let input: Value = serde_json::from_slice(&bytes).unwrap();
            let updated = value.as_mut().unwrap();
            updated["title"] = input["title"].clone();
            updated["body"] = input["body"].clone();
            fixture.updates.fetch_add(1, Ordering::SeqCst);
            *state.lock().unwrap() = value.clone();
        }
        let value = if path == "/repos/acme/project/pulls" {
            json!(value.into_iter().collect::<Vec<_>>())
        } else {
            value.unwrap()
        };
        return Response::new(Body::from(value.to_string()));
    }
    Response::builder().status(404).body(Body::empty()).unwrap()
}
