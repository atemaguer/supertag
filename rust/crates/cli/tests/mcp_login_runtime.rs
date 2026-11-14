//! `supertag mcp login` and `supertag mcp list` against a loopback OAuth authorization server.

use std::{
    collections::HashMap,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use axum::{
    Form, Json, Router,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Redirect},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    net::TcpListener,
    process::Command,
    time::timeout,
};

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ACCESS: &str = "fixture-access-token-0b1c";
const REFRESH: &str = "fixture-refresh-token-9d2e";

#[derive(Default)]
struct Authorization {
    origin: String,
    challenge: Option<String>,
    redirect_uri: Option<String>,
    authorize: Option<HashMap<String, String>>,
    token: Option<HashMap<String, String>>,
}

type Shared = Arc<Mutex<Authorization>>;

async fn authorization_server() -> Result<(String, Shared)> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let state: Shared = Arc::new(Mutex::new(Authorization {
        origin: origin.clone(),
        ..Authorization::default()
    }));
    let app = Router::new()
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(|State(state): State<Shared>| async move {
                let origin = state.lock().unwrap().origin.clone();
                Json(json!({
                    "resource": format!("{origin}/mcp"),
                    "authorization_servers": [origin],
                    "scopes_supported": ["docs.read", "bad scope"],
                }))
            }),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(|State(state): State<Shared>| async move {
                let origin = state.lock().unwrap().origin.clone();
                Json(json!({
                    "issuer": origin,
                    "authorization_endpoint": format!("{origin}/authorize"),
                    "token_endpoint": format!("{origin}/token"),
                    "registration_endpoint": format!("{origin}/register"),
                }))
            }),
        )
        .route(
            "/register",
            post(
                |State(state): State<Shared>, Json(body): Json<Value>| async move {
                    let redirect = body["redirect_uris"][0].as_str().unwrap_or_default();
                    state.lock().unwrap().redirect_uri = Some(redirect.to_owned());
                    (StatusCode::CREATED, Json(json!({"client_id":"fixture-client"})))
                },
            ),
        )
        .route(
            "/authorize",
            get(
                |State(state): State<Shared>,
                 Query(query): Query<HashMap<String, String>>| async move {
                    let mut state = state.lock().unwrap();
                    state.challenge = query.get("code_challenge").cloned();
                    let target = format!(
                        "{}?code=fixture-code&state={}",
                        query.get("redirect_uri").cloned().unwrap_or_default(),
                        query.get("state").cloned().unwrap_or_default()
                    );
                    state.authorize = Some(query);
                    Redirect::to(&target)
                },
            ),
        )
        .route(
            "/token",
            post(
                |State(state): State<Shared>, Form(form): Form<HashMap<String, String>>| async move {
                    let mut state = state.lock().unwrap();
                    let verified = form.get("code_verifier").is_some_and(|verifier| {
                        Some(URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())))
                            == state.challenge
                    });
                    let valid = verified
                        && form.get("grant_type").map(String::as_str) == Some("authorization_code")
                        && form.get("code").map(String::as_str) == Some("fixture-code")
                        && form.get("redirect_uri") == state.redirect_uri.as_ref();
                    state.token = Some(form);
                    if !valid {
                        return (StatusCode::BAD_REQUEST, Json(json!({"error":"invalid_grant"})))
                            .into_response();
                    }
                    Json(json!({
                        "access_token": ACCESS, "token_type": "Bearer", "expires_in": 3600,
                        "refresh_token": REFRESH,
                    }))
                    .into_response()
                },
            ),
        )
        .with_state(state.clone());
    tokio::spawn(async move { axum::serve(listener, app).await });
    Ok((origin, state))
}

fn private_file(path: &Path, contents: &str) -> Result<()> {
    use std::io::Write;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?
        .write_all(contents.as_bytes())?;
    Ok(())
}

fn command(state: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(BINARY);
    command
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("SUPERTAG_STATE_DIR", state)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
}

async fn output(mut command: Command) -> Result<(bool, String, String)> {
    let output = timeout(Duration::from_secs(30), command.output()).await??;
    Ok((
        output.status.success(),
        String::from_utf8(output.stdout)?,
        String::from_utf8(output.stderr)?,
    ))
}

#[tokio::test]
async fn login_runs_pkce_with_registration_and_stores_only_the_login() -> Result<()> {
    let (origin, authorization) = authorization_server().await?;
    let directory = tempfile::tempdir()?;
    let state = directory.path().join("state");
    std::fs::create_dir(&state)?;
    let catalog = directory.path().join("catalog.json");
    let url = format!("{origin}/mcp");
    private_file(
        &catalog,
        &json!({"version":1,"servers":[
            {"name":"docs","url":url,"oauth":true},
            {"name":"plain","url":"https://plain.example.test/mcp","headerEnv":{"Authorization":"PLAIN_AUTH"}},
            {"name":"db","command":["/usr/bin/true"],"env":{"DB_TOKEN":"ACME_DB_TOKEN"}}
        ]})
        .to_string(),
    )?;
    let catalog_arg = catalog.to_str().context("catalog path")?;

    let (ok, listed, _) = output(command(
        &state,
        &["mcp", "list", "--mcp-catalog", catalog_arg],
    ))
    .await?;
    ensure!(ok, "mcp list failed");
    assert!(
        listed.contains("not logged in; run supertag mcp login docs"),
        "{listed}"
    );
    assert!(listed.contains("missing: PLAIN_AUTH"), "{listed}");
    assert!(listed.contains("stdio: /usr/bin/true"), "{listed}");
    assert!(listed.contains("missing: ACME_DB_TOKEN"), "{listed}");

    // A Worker Host refuses to start with an OAuth server this host never logged in to.
    let entry = directory.path().join("entry.js");
    std::fs::write(&entry, "")?;
    let mut host = command(
        &state,
        &[
            "worker-host",
            "--control-plane",
            "http://127.0.0.1:9",
            "--once",
            "--harness",
            "claude-code",
        ],
    );
    host.arg("--harness-entrypoint")
        .arg(&entry)
        .arg("--harness-runtime")
        .arg("/bin/sh")
        .arg("--state-directory")
        .arg(directory.path().join("host"))
        .arg("--mcp-catalog")
        .arg(&catalog)
        .env("PLAIN_AUTH", "Bearer plain-fixture")
        .env("ACME_DB_TOKEN", "db-fixture-token")
        .env("SUPERTAG_HOST_TOKEN", "fixture-host-token");
    let (ok, _, refused) = output(host).await?;
    assert!(
        !ok && refused
            .contains("MCP server docs is not logged in on this host; run supertag mcp login docs"),
        "{refused}"
    );

    for (server, message) in [
        ("plain", "does not use \"oauth\": true"),
        ("db", "is a stdio server, so it has no login"),
        ("absent", "declares no server absent"),
    ] {
        let (ok, _, stderr) = output(command(
            &state,
            &[
                "mcp",
                "login",
                server,
                "--mcp-catalog",
                catalog_arg,
                "--no-browser",
            ],
        ))
        .await?;
        assert!(!ok && stderr.contains(message), "{server}: {stderr}");
    }

    let mut login = command(
        &state,
        &[
            "mcp",
            "login",
            "docs",
            "--mcp-catalog",
            catalog_arg,
            "--no-browser",
        ],
    );
    let mut child = login
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stderr = BufReader::new(child.stderr.take().context("login stderr")?);
    let mut authorize = String::new();
    let mut printed = String::new();
    while authorize.is_empty() {
        let mut line = String::new();
        ensure!(
            timeout(Duration::from_secs(20), stderr.read_line(&mut line)).await?? > 0,
            "login exited before printing the authorization URL: {printed}"
        );
        printed.push_str(&line);
        if let Some(found) = line.trim().strip_prefix(&format!("{origin}/authorize?")) {
            authorize = format!("{origin}/authorize?{found}");
        }
    }
    let callback = authorization
        .lock()
        .unwrap()
        .redirect_uri
        .clone()
        .context("registered redirect")?;
    assert!(callback.starts_with("http://127.0.0.1:") && callback.ends_with("/callback"));
    let http = reqwest::Client::new();
    // A redirect with another state never finishes the login.
    let foreign = http
        .get(format!("{callback}?code=stolen&state=another"))
        .send()
        .await?;
    assert_eq!(foreign.status(), reqwest::StatusCode::BAD_REQUEST);
    let finished = http.get(&authorize).send().await?;
    assert_eq!(finished.status(), reqwest::StatusCode::OK);
    let status = timeout(Duration::from_secs(20), child.wait()).await??;
    let mut stdout = String::new();
    child
        .stdout
        .take()
        .context("login stdout")?
        .read_to_string(&mut stdout)
        .await?;
    stderr.read_to_string(&mut printed).await?;
    ensure!(status.success(), "login failed: {printed}");
    assert!(stdout.contains("Logged in to MCP server docs"), "{stdout}");
    for output in [&stdout, &printed] {
        assert!(!output.contains(ACCESS) && !output.contains(REFRESH));
    }

    let (query, token) = {
        let recorded = authorization.lock().unwrap();
        (recorded.authorize.clone(), recorded.token.clone())
    };
    let query = query.context("authorize request")?;
    assert_eq!(query["response_type"], "code");
    assert_eq!(query["code_challenge_method"], "S256");
    assert_eq!(query["client_id"], "fixture-client");
    assert_eq!(query["resource"], url);
    assert_eq!(query["scope"], "docs.read");
    let token = token.context("token request")?;
    assert_eq!(token["resource"], url);

    let stored = state.join("mcp-logins/docs.json");
    assert_eq!(std::fs::metadata(&stored)?.mode() & 0o777, 0o600);
    assert_eq!(
        std::fs::metadata(state.join("mcp-logins"))?.mode() & 0o777,
        0o700
    );
    let stored: Value = serde_json::from_slice(&std::fs::read(stored)?)?;
    let mut keys: Vec<_> = stored
        .as_object()
        .context("login")?
        .keys()
        .cloned()
        .collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "accessToken",
            "accessTokenExpiresAt",
            "clientId",
            "loggedInAt",
            "refreshToken",
            "tokenEndpoint",
            "url"
        ]
    );
    assert_eq!(stored["refreshToken"], REFRESH);
    assert_eq!(stored["tokenEndpoint"], format!("{origin}/token"));

    let (ok, listed, _) = output(command(
        &state,
        &["mcp", "list", "--mcp-catalog", catalog_arg],
    ))
    .await?;
    ensure!(ok, "mcp list failed");
    let docs = listed
        .lines()
        .find(|line| line.starts_with("docs"))
        .context("docs row")?;
    assert!(
        docs.contains("oauth login") && docs.ends_with("logged in"),
        "{listed}"
    );
    assert!(!listed.contains(ACCESS) && !listed.contains(REFRESH));
    Ok(())
}

/// Follows the authorization URL a running `mcp login` prints, then returns its output.
async fn complete_login(mut login: Command, origin: &str) -> Result<(bool, String, String)> {
    let mut child = login
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stderr = BufReader::new(child.stderr.take().context("login stderr")?);
    let mut printed = String::new();
    let authorize = loop {
        let mut line = String::new();
        ensure!(
            timeout(Duration::from_secs(20), stderr.read_line(&mut line)).await?? > 0,
            "login exited before printing the authorization URL: {printed}"
        );
        printed.push_str(&line);
        if let Some(found) = line.trim().strip_prefix(&format!("{origin}/authorize?")) {
            break format!("{origin}/authorize?{found}");
        }
    };
    let finished = reqwest::Client::new().get(&authorize).send().await?;
    assert_eq!(finished.status(), reqwest::StatusCode::OK);
    let status = timeout(Duration::from_secs(20), child.wait()).await??;
    let mut stdout = String::new();
    child
        .stdout
        .take()
        .context("login stdout")?
        .read_to_string(&mut stdout)
        .await?;
    stderr.read_to_string(&mut printed).await?;
    Ok((status.success(), stdout, printed))
}

#[tokio::test]
async fn export_prints_the_refresh_token_once_and_stores_nothing() -> Result<()> {
    let (origin, _authorization) = authorization_server().await?;
    let directory = tempfile::tempdir()?;
    let state = directory.path().join("state");
    std::fs::create_dir(&state)?;
    let catalog = directory.path().join("catalog.json");
    private_file(
        &catalog,
        &json!({"version":1,"servers":[
            {"name":"docs","url":format!("{origin}/mcp"),"oauth":{"refreshTokenEnv":"DOCS_MCP_REFRESH_TOKEN"}},
            {"name":"plain","url":"https://plain.example.test/mcp","headerEnv":{"Authorization":"PLAIN_AUTH"}}
        ]})
        .to_string(),
    )?;
    let catalog_arg = catalog.to_str().context("catalog path")?;
    let (ok, listed, _) = output(command(
        &state,
        &["mcp", "list", "--mcp-catalog", catalog_arg],
    ))
    .await?;
    ensure!(ok, "mcp list failed");
    let docs = listed
        .lines()
        .find(|line| line.starts_with("docs"))
        .context("docs row")?;
    assert!(
        docs.contains("oauth refresh token") && docs.ends_with("missing: DOCS_MCP_REFRESH_TOKEN"),
        "{listed}"
    );
    // A refresh-token server keeps no login here, and only an OAuth server can be exported.
    for (server, export, message) in [
        ("docs", false, "does not use \"oauth\": true"),
        ("plain", true, "--export needs \"oauth\": true"),
    ] {
        let mut args = vec![
            "mcp",
            "login",
            server,
            "--mcp-catalog",
            catalog_arg,
            "--no-browser",
        ];
        if export {
            args.push("--export");
        }
        let (ok, _, stderr) = output(command(&state, &args)).await?;
        assert!(!ok && stderr.contains(message), "{server}: {stderr}");
    }
    let (ok, stdout, stderr) = complete_login(
        command(
            &state,
            &[
                "mcp",
                "login",
                "docs",
                "--mcp-catalog",
                catalog_arg,
                "--no-browser",
                "--export",
            ],
        ),
        &origin,
    )
    .await?;
    ensure!(ok, "export failed: {stderr}");
    let mut lines = stdout.lines();
    let exported: Value = serde_json::from_str(lines.next().context("exported value")?)?;
    // The value names the client, never the token endpoint, which the remote host pins itself.
    assert_eq!(
        exported,
        json!({"refresh_token": REFRESH, "client_id": "fixture-client"})
    );
    assert!(
        lines
            .next()
            .is_some_and(|line| line.contains("\"refreshTokenEnv\": \"DOCS_MCP_REFRESH_TOKEN\"")),
        "{stdout}"
    );
    assert!(!stdout.contains(ACCESS) && !stderr.contains(ACCESS) && !stderr.contains(REFRESH));
    assert!(!state.join("mcp-logins/docs.json").exists());
    Ok(())
}
