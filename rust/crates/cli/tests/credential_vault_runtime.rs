//! Slack surface credentials resolved by a real Gateway process from the credential vault.
//! The HashiCorp Vault KV v2 endpoint is a loopback fixture; no credential leaves the test.
use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader, Write as _},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, ensure};
use axum::{
    Json, Router,
    extract::{Path as UrlPath, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use tokio::time::sleep;
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const WAIT: Duration = Duration::from_secs(20);
const ACCOUNT: &str = "slack-vault-test";
const SIGNING: &str = "synthetic-vault-signing-key";
const BOT: &str = "xoxb-synthetic-vault-bot-token";
const VAULT_TOKEN: &str = "synthetic-vault-root-token";

struct Process {
    child: Child,
    log: PathBuf,
}

impl Process {
    fn spawn(mut command: Command, directory: &Path) -> Result<Self> {
        let log = directory.join(format!("{}.log", Uuid::new_v4()));
        Ok(Self {
            child: command
                .stdout(Stdio::piped())
                .stderr(File::create(&log)?)
                .spawn()?,
            log,
        })
    }
    fn logs(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }
    async fn endpoints(&mut self, count: usize) -> Result<Vec<String>> {
        let stdout = self.child.stdout.take().context("missing stdout")?;
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
                            Ok(format!("http://{address}"))
                        })
                        .collect();
                }
                Err(mpsc::TryRecvError::Empty) => {}
                Err(error) => anyhow::bail!("output closed: {error}: {}", self.logs()),
            }
            ensure!(
                self.child.try_wait()?.is_none(),
                "process exited: {}",
                self.logs()
            );
            ensure!(
                Instant::now() < deadline,
                "startup timed out: {}",
                self.logs()
            );
            sleep(Duration::from_millis(10)).await;
        }
    }
    /// Waits for a startup failure and returns its diagnostics.
    async fn failure(&mut self) -> Result<String> {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(status) = self.child.try_wait()? {
                ensure!(!status.success(), "process unexpectedly succeeded");
                return Ok(self.logs());
            }
            ensure!(
                Instant::now() < deadline,
                "process did not fail: {}",
                self.logs()
            );
            sleep(Duration::from_millis(10)).await;
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Services {
    directory: tempfile::TempDir,
    gateway_token: String,
    control_plane: Process,
    private: String,
}

impl Services {
    async fn start() -> Result<Self> {
        let directory = tempfile::tempdir()?;
        let gateway_token = Uuid::new_v4().to_string();
        let mut command = Command::new(BINARY);
        command
            .arg("control-plane")
            .env_clear()
            .stdin(Stdio::null())
            .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
            .env("SUPERTAG_OPERATOR_TOKEN", Uuid::new_v4().to_string())
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", Uuid::new_v4().to_string())
            .env(
                "SUPERTAG_DATABASE_URL",
                format!(
                    "sqlite://{}?mode=rwc",
                    directory.path().join("control.db").display()
                ),
            );
        let mut control_plane = Process::spawn(command, directory.path())?;
        let private = control_plane.endpoints(1).await?.remove(0);
        Ok(Self {
            directory,
            gateway_token,
            control_plane,
            private,
        })
    }

    fn gateway(&self, environment: &[(&str, &str)]) -> Result<Process> {
        let mut command = Command::new(BINARY);
        command
            .args([
                "gateway",
                "--control-plane",
                &self.private,
                "--slack-listen",
                "127.0.0.1:0",
                "--slack-state-directory",
            ])
            .arg(
                self.directory
                    .path()
                    .join(format!("slack-{}", Uuid::new_v4())),
            )
            .env_clear()
            .stdin(Stdio::null())
            .env("SUPERTAG_GATEWAY_TOKEN", &self.gateway_token)
            .env("SUPERTAG_OPERATOR_TOKEN", Uuid::new_v4().to_string())
            .env("SUPERTAG_SLACK_ACCOUNT_ID", ACCOUNT)
            .env("SUPERTAG_SLACK_TEAM_ID", "TTEAM1")
            .env("SUPERTAG_SLACK_CHANNEL_ID", "CCHANNEL1")
            .env("SUPERTAG_SLACK_TAG_ID", "builder")
            .env("SUPERTAG_SLACK_ALLOWED_USERS", "UALICE1")
            .envs(environment.iter().copied());
        Process::spawn(command, self.directory.path())
    }
}

async fn challenge(endpoint: &str, secret: &str) -> Result<(reqwest::StatusCode, String)> {
    let body = json!({"type":"url_verification","challenge":"vault-challenge"}).to_string();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_secs()
        .to_string();
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())?;
    mac.update(format!("v0:{timestamp}:{body}").as_bytes());
    let response = reqwest::Client::builder()
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
        .await?;
    Ok((response.status(), response.text().await?))
}

type Read = (String, Option<String>);

#[derive(Clone, Default)]
struct FakeVault {
    entries: Arc<Mutex<HashMap<String, Value>>>,
    /// Path and Vault namespace of each read.
    reads: Arc<Mutex<Vec<Read>>>,
}

async fn read_secret(
    State(state): State<FakeVault>,
    headers: HeaderMap,
    UrlPath(path): UrlPath<String>,
) -> Response {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    };
    state
        .reads
        .lock()
        .unwrap()
        .push((format!("/v1/{path}"), header("x-vault-namespace")));
    if header("x-vault-token").as_deref() != Some(VAULT_TOKEN) {
        return StatusCode::FORBIDDEN.into_response();
    }
    match state.entries.lock().unwrap().get(&path) {
        Some(value) => Json(json!({"data":{"data":value}})).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn fake_vault() -> Result<(FakeVault, String)> {
    let state = FakeVault::default();
    let app = Router::new()
        .route("/v1/{*path}", get(read_secret))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    tokio::spawn(async move { axum::serve(listener, app).await });
    Ok((state, format!("http://{address}")))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gateway_resolves_slack_credentials_from_hashicorp_vault_and_fails_closed() -> Result<()> {
    let services = Services::start().await?;
    let (vault, address) = fake_vault().await?;
    let environment = [
        ("SUPERTAG_CREDENTIAL_VAULT", "vault"),
        ("VAULT_ADDR", address.as_str()),
        ("VAULT_TOKEN", VAULT_TOKEN),
        ("SUPERTAG_VAULT_MOUNT", "organization"),
        ("SUPERTAG_VAULT_PATH_PREFIX", "production"),
        ("VAULT_NAMESPACE", "team"),
    ];

    // A missing credential stops the Gateway before it listens.
    let mut missing = services.gateway(&environment)?;
    let logs = missing.failure().await?;
    ensure!(
        logs.contains(&format!(
            "store surface/slack/{ACCOUNT} in the credential vault"
        )),
        "{logs}"
    );
    ensure!(!logs.contains(VAULT_TOKEN), "{logs}");

    vault.entries.lock().unwrap().insert(
        format!("organization/data/production/surface/slack/{ACCOUNT}"),
        json!({"botToken": BOT, "signingSecret": SIGNING}),
    );
    let mut gateway = services.gateway(&environment)?;
    let endpoints = gateway.endpoints(2).await?;
    let slack = &endpoints[1];
    let (status, body) = challenge(slack, SIGNING).await?;
    ensure!(status == reqwest::StatusCode::OK, "{status}: {body}");
    ensure!(body.contains("vault-challenge"), "{body}");
    let (status, _) = challenge(slack, "a-different-signing-key").await?;
    ensure!(status == reqwest::StatusCode::UNAUTHORIZED, "{status}");
    let reads = vault.reads.lock().unwrap().clone();
    ensure!(
        reads.last()
            == Some(&(
                format!("/v1/organization/data/production/surface/slack/{ACCOUNT}"),
                Some("team".to_owned())
            )),
        "{reads:?}"
    );

    // A wrong Vault token fails closed with the HTTP status, never a response body or token.
    let mut denied = services.gateway(&[
        ("SUPERTAG_CREDENTIAL_VAULT", "vault"),
        ("VAULT_ADDR", address.as_str()),
        ("VAULT_TOKEN", "wrong-vault-token"),
        ("SUPERTAG_VAULT_MOUNT", "organization"),
        ("SUPERTAG_VAULT_PATH_PREFIX", "production"),
    ])?;
    let logs = denied.failure().await?;
    ensure!(
        logs.contains("Vault could not resolve Gateway credentials (HTTP 403)"),
        "{logs}"
    );
    ensure!(!logs.contains("wrong-vault-token"), "{logs}");
    drop(gateway);
    drop(services.control_plane);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn operator_stores_slack_credentials_in_the_file_vault_for_the_gateway() -> Result<()> {
    let services = Services::start().await?;
    let state = services.directory.path().join("state");
    let state_text = state.to_str().context("state path")?;
    let id = format!("surface/slack/{ACCOUNT}");
    let mut store = Command::new(BINARY)
        .args(["gateway-credential", "store", &id])
        .env_clear()
        .env("SUPERTAG_STATE_DIR", &state)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    store.stdin.take().context("stdin")?.write_all(
        json!({"botToken": BOT, "signingSecret": SIGNING})
            .to_string()
            .as_bytes(),
    )?;
    let output = store.wait_with_output()?;
    ensure!(output.status.success(), "{output:?}");
    let printed = String::from_utf8(output.stdout)?;
    ensure!(
        !printed.contains(SIGNING) && !printed.contains(BOT),
        "{printed}"
    );
    let file = state.join("gateway-credentials.json");
    use std::os::unix::fs::PermissionsExt as _;
    ensure!(std::fs::metadata(&file)?.permissions().mode() & 0o777 == 0o600);

    // Only one of the two Slack secrets in the environment is a configuration error.
    let mut partial = services.gateway(&[
        ("SUPERTAG_STATE_DIR", state_text),
        ("SUPERTAG_SLACK_BOT_TOKEN", BOT),
    ])?;
    ensure!(
        partial
            .failure()
            .await?
            .contains("set both SUPERTAG_SLACK_SIGNING_SECRET and SUPERTAG_SLACK_BOT_TOKEN")
    );

    let mut gateway = services.gateway(&[("SUPERTAG_STATE_DIR", state_text)])?;
    let endpoints = gateway.endpoints(2).await?;
    let (status, body) = challenge(&endpoints[1], SIGNING).await?;
    ensure!(status == reqwest::StatusCode::OK, "{status}: {body}");
    drop(gateway);

    let output = Command::new(BINARY)
        .args(["gateway-credential", "delete", &id])
        .env_clear()
        .env("SUPERTAG_STATE_DIR", &state)
        .stdin(Stdio::null())
        .output()?;
    ensure!(output.status.success(), "{output:?}");
    let mut deleted = services.gateway(&[("SUPERTAG_STATE_DIR", state_text)])?;
    ensure!(
        deleted
            .failure()
            .await?
            .contains("Slack credentials are missing")
    );

    // Malformed input is refused without echoing it.
    let mut store = Command::new(BINARY)
        .args(["gateway-credential", "store", &id])
        .env_clear()
        .env("SUPERTAG_STATE_DIR", &state)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    store
        .stdin
        .take()
        .context("stdin")?
        .write_all(br#"{"botToken": 7, "leaked": "do-not-echo"}"#)?;
    let output = store.wait_with_output()?;
    let stderr = String::from_utf8(output.stderr)?;
    ensure!(!output.status.success() && stderr.contains("JSON object of string fields"));
    ensure!(!stderr.contains("do-not-echo"), "{stderr}");
    Ok(())
}
