use super::*;
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::State,
    http::{Request, Response, StatusCode},
    routing::any,
};
use std::{
    io::Write,
    os::unix::fs::PermissionsExt,
    sync::atomic::{AtomicUsize, Ordering},
};
use supertag_protocol::v2::GithubWorkspaceSource;
use supertag_workspaces::{PrepareRequest, Workspace, WorkspaceConfig};

#[derive(Clone)]
struct Fixture {
    root: PathBuf,
    commit: String,
    calls: Arc<AtomicUsize>,
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

async fn api(State(fixture): State<Fixture>, request: Request<Body>) -> Response<Body> {
    fixture.calls.fetch_add(1, Ordering::SeqCst);
    assert_eq!(
        request.headers().get("authorization").unwrap(),
        "Bearer fixture-source-token"
    );
    let value = if request.uri().path() == "/repositories/123" {
        serde_json::json!({"id":123,"full_name":"acme/project","default_branch":"main"})
    } else if matches!(
        request.uri().path(),
        "/repos/acme/project/commits/main" | "/repos/acme/project/commits/release%2Fstable"
    ) || request.uri().path() == format!("/repos/acme/project/commits/{}", fixture.commit)
    {
        serde_json::json!({"sha":fixture.commit})
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

#[tokio::test]
async fn loopback_source_fetch_keeps_credentials_at_gateway_and_imports_exact_commit() -> Result<()>
{
    let temporary = tempfile::tempdir()?;
    let repository = temporary.path().join("input");
    fs::create_dir(&repository)?;
    git(&repository, &["init", "--quiet", "--initial-branch=main"]);
    fs::write(
        repository.join("workspace.txt"),
        "exact repository content\n",
    )?;
    git(&repository, &["add", "."]);
    git(&repository, &["commit", "--quiet", "-m", "Pinned"]);
    let commit = git(&repository, &["rev-parse", "HEAD"]);
    let exported = temporary.path().join("export");
    fs::create_dir_all(exported.join("acme"))?;
    git(
        temporary.path(),
        &[
            "clone",
            "--bare",
            "--quiet",
            repository.to_str().unwrap(),
            exported.join("acme/project.git").to_str().unwrap(),
        ],
    );
    let calls = Arc::new(AtomicUsize::new(0));
    let fixture = Fixture {
        root: exported,
        commit: commit.clone(),
        calls: calls.clone(),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let router = Router::new()
        .route("/git/{*path}", any(git_http))
        .fallback(api)
        .with_state(fixture);
    let _server = Server(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));
    let gateway = tempfile::tempdir_in(temporary.path())?;
    fs::set_permissions(gateway.path(), fs::Permissions::from_mode(0o700))?;
    let sources = GithubWorkspaceSources::new(
        GithubWorkspaceAccount {
            account_id: "account".into(),
            repository_id: 123,
            repository: "acme/project".into(),
            authentication: GithubAuthentication::Token("fixture-source-token".into()),
        },
        gateway.path(),
    )?
    .with_test_endpoints(
        format!("http://{address}/").parse()?,
        format!("http://{address}/git/").parse()?,
    )?;
    let request = GithubWorkspace {
        pull_request: None,
        workspace_id: "project".into(),
        revision: 1,
        source: Some(GithubWorkspaceSource {
            account_id: "account".into(),
            repository_id: 123,
            repository: "acme/project".into(),
            commit_sha: commit.clone(),
            ..Default::default()
        }),
    };
    let mut forbidden = request.clone();
    forbidden.source.as_mut().unwrap().repository_id = 124;
    assert!(
        sources
            .fetch(&forbidden, &CancellationToken::new())
            .await
            .is_err()
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "reject scope before credential or network work"
    );
    let cancel = CancellationToken::new();
    assert!(
        sources
            .advertised_output_remote(&forbidden, &commit, &cancel)
            .await
            .is_err()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        sources
            .advertised_output_remote(&request, &commit, &cancel)
            .await?,
        Some("https://github.com/acme/project.git".into())
    );
    assert!(
        sources
            .advertised_output_remote(&request, &"a".repeat(40), &cancel)
            .await?
            .is_none()
    );
    assert!(calls.swap(0, Ordering::SeqCst) >= 4);
    let result = sources.fetch(&request, &CancellationToken::new()).await?;
    let bundle = fs::read(&result.bundle.path)?;
    assert!(
        !bundle
            .windows(b"fixture-source-token".len())
            .any(|bytes| bytes == b"fixture-source-token")
    );
    let source = source::materialize(
        &temporary.path().join("host-source"),
        &result.bundle,
        &commit,
        &CancellationToken::new(),
    )
    .await?;
    let workspace = Workspace::open(WorkspaceConfig {
        state_dir: temporary.path().join("host-state"),
        source,
        base_commit: commit.clone(),
    })?;
    let checkout = workspace
        .prepare(
            PrepareRequest {
                task_id: "task".into(),
                attempt_id: "attempt".into(),
                session_id: "session".into(),
                expected_head: None,
                setup: None,
            },
            &CancellationToken::new(),
        )
        .await?;
    assert_eq!(checkout.start_commit, commit);
    assert_eq!(
        fs::read_to_string(checkout.path.join("workspace.txt"))?,
        "exact repository content\n"
    );
    assert!(calls.load(Ordering::SeqCst) >= 4);
    assert_eq!(git(&repository, &["status", "--porcelain"]), "");
    Ok(())
}

#[tokio::test]
async fn source_metadata_redirect_and_mismatch_fail_before_git() -> Result<()> {
    let directory = tempfile::tempdir()?;
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))?;
    let redirected = Arc::new(AtomicUsize::new(0));
    let mode = Arc::new(AtomicUsize::new(0));
    let (observed, switch) = (redirected.clone(), mode.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}/", listener.local_addr()?);
    let location = format!("{base}redirected");
    let router = Router::new()
        .route(
            "/repositories/123",
            any(move || {
                let location = location.clone();
                let switch = switch.clone();
                async move {
                    if switch.load(Ordering::SeqCst) == 0 {
                        Response::builder()
                            .status(302)
                            .header("location", location)
                            .body(Body::empty())
                            .unwrap()
                    } else {
                        Response::new(Body::from(r#"{"id":124,"full_name":"acme/project"}"#))
                    }
                }
            }),
        )
        .fallback(move || {
            let observed = observed.clone();
            async move {
                observed.fetch_add(1, Ordering::SeqCst);
                Response::new(Body::empty())
            }
        });
    let _server = Server(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));
    let sources = GithubWorkspaceSources::new(
        GithubWorkspaceAccount {
            account_id: "account".into(),
            repository_id: 123,
            repository: "acme/project".into(),
            authentication: GithubAuthentication::Token("fixture-source-token".into()),
        },
        directory.path(),
    )?
    .with_test_endpoints(base.parse()?, format!("{base}git/").parse()?)?;
    let workspace = GithubWorkspace {
        pull_request: None,
        workspace_id: "project".into(),
        revision: 1,
        source: Some(GithubWorkspaceSource {
            account_id: "account".into(),
            repository_id: 123,
            repository: "acme/project".into(),
            commit_sha: "1".repeat(40),
            ..Default::default()
        }),
    };
    assert!(
        sources
            .fetch(&workspace, &CancellationToken::new())
            .await
            .is_err()
    );
    assert_eq!(redirected.load(Ordering::SeqCst), 0);
    mode.store(1, Ordering::SeqCst);
    assert!(
        sources
            .fetch(&workspace, &CancellationToken::new())
            .await
            .is_err()
    );
    assert_eq!(redirected.load(Ordering::SeqCst), 0);
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(sources.fetch(&workspace, &cancelled).await.is_err());
    assert_eq!(fs::read_dir(directory.path())?.count(), 0);
    Ok(())
}

#[tokio::test]
async fn moving_source_refs_are_encoded_and_bound_to_numeric_repository() -> Result<()> {
    let temporary = tempfile::tempdir()?;
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700))?;
    let calls = Arc::new(AtomicUsize::new(0));
    let commit = "a".repeat(40);
    let fixture = Fixture {
        root: temporary.path().to_owned(),
        commit: commit.clone(),
        calls: calls.clone(),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let router = Router::new().fallback(api).with_state(fixture);
    let _server = Server(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap()
    }));
    let source = GithubWorkspaceSources::new(
        GithubWorkspaceAccount {
            account_id: "account".into(),
            repository_id: 123,
            repository: "acme/project".into(),
            authentication: GithubAuthentication::Token("fixture-source-token".into()),
        },
        temporary.path(),
    )?
    .with_test_endpoints(
        format!("http://{address}/").parse()?,
        format!("http://{address}/git/").parse()?,
    )?;
    let mut selected = GithubWorkspace {
        workspace_id: "project".into(),
        source: Some(GithubWorkspaceSource {
            account_id: "account".into(),
            repository_id: 123,
            repository: "acme/project".into(),
            revision: Some("release/stable".into()),
            ..Default::default()
        }),
        ..Default::default()
    };
    assert_eq!(
        source.resolve_selector(&selected).await?,
        ("release/stable".into(), commit.clone())
    );
    selected.source.as_mut().unwrap().revision = None;
    assert_eq!(
        source.resolve_selector(&selected).await?,
        ("main".into(), commit)
    );
    assert_eq!(calls.load(Ordering::SeqCst), 4);
    selected.source.as_mut().unwrap().repository_id = 124;
    assert!(source.resolve_selector(&selected).await.is_err());
    assert_eq!(
        calls.load(Ordering::SeqCst),
        4,
        "wrong account/repository must fail before provider access"
    );
    Ok(())
}
