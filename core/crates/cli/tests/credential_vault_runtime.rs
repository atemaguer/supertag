//! Slack surface credentials resolved by a real Gateway process from the credential vault.
//! The HashiCorp Vault KV v2 endpoint is a loopback fixture; no credential leaves the test.
#[path = "support/children.rs"]
mod children;
use children::reaped;
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
        let gateway_token =
            supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
        let mut command = reaped(Command::new(BINARY));
        command
            .arg("control-plane")
            .env_clear()
            .stdin(Stdio::null())
            .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &gateway_token)
            .env("SUPERTAG_GATEWAY_CREDENTIAL", &gateway_token)
            .env("SUPERTAG_OPERATOR_TOKEN", Uuid::new_v4().to_string())
            .env(
                "SUPERTAG_BOOTSTRAP_HOST_TOKEN",
                supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX),
            )
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
        let mut command = reaped(Command::new(BINARY));
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
            .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &self.gateway_token)
            .env("SUPERTAG_GATEWAY_CREDENTIAL", &self.gateway_token)
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

/// The `KEY=VALUE` lines of a deployment environment file whose key is a credential document
/// variable or the vault selection.
fn credential_settings(path: &Path) -> Result<Vec<(String, String)>> {
    Ok(std::fs::read_to_string(path)?
        .lines()
        .filter_map(|line| line.split_once('='))
        .filter(|(key, _)| key.contains("_CREDENTIALS") || *key == "SUPERTAG_CREDENTIAL_VAULT")
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect())
}

/// A hosted deployment without HashiCorp Vault: the operator stores credentials in the
/// deployment directory's file, exports them into the service files, and the Gateway reads its
/// own from its environment, as a platform's secrets deliver them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gateway_resolves_slack_credentials_from_its_environment_after_an_export() -> Result<()> {
    let services = Services::start().await?;
    let deployment = services.directory.path().join("deployment");
    let cli = |args: &[&str], environment: &[(&str, &str)], input: &str| -> Result<_> {
        let mut child = reaped(Command::new(BINARY))
            .args(args)
            .env_clear()
            .envs(environment.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        child
            .stdin
            .take()
            .context("stdin")?
            .write_all(input.as_bytes())?;
        let output = child.wait_with_output()?;
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        ensure!(!text.contains(SIGNING) && !text.contains(BOT), "{text}");
        Ok((output.status.success(), text))
    };
    let directory = deployment.to_str().context("deployment path")?;
    // Modal has no disk for the file vault; setup needs no Vault address or token.
    let (ok, text) = cli(
        &[
            "setup",
            "deployment",
            "modal",
            "--non-interactive",
            "--output",
            directory,
        ],
        &[(
            "SUPERTAG_DATABASE_URL",
            "postgresql://supertag:synthetic@db.example.com/supertag",
        )],
        "",
    )?;
    ensure!(
        ok && text.contains("supertag gateway credential export"),
        "{text}"
    );
    let file = deployment.join("gateway-credentials.json");
    let file_text = file.to_str().context("file path")?;
    let pointed = [("SUPERTAG_CREDENTIAL_FILE", file_text)];
    let id = format!("surface/slack/{ACCOUNT}");
    let secrets = json!({"botToken": BOT, "signingSecret": SIGNING}).to_string();
    let (ok, text) = cli(&["gateway", "credential", "store", &id], &pointed, &secrets)?;
    ensure!(ok, "{text}");
    let (ok, text) = cli(
        &[
            "gateway",
            "credential",
            "store",
            "workspace-credential/deploy",
        ],
        &pointed,
        r#"{"kind":"https","token":"synthetic-workspace-token"}"#,
    )?;
    ensure!(ok, "{text}");

    // The stored credentials are not in the service files until they are exported.
    let check = ["check", "deployment", "modal", "--directory", directory];
    let (ok, text) = cli(&check, &[], "")?;
    ensure!(
        !ok && text.contains("is out of date")
            && text.contains("supertag gateway credential export --directory"),
        "{text}"
    );
    let (ok, text) = cli(
        &["gateway", "credential", "export", "--directory", directory],
        &[],
        "",
    )?;
    ensure!(ok, "{text}");
    let exported: Value = serde_json::from_str(&text)?;
    ensure!(
        exported["credentials"]
            == json!({
                "gateway.env": [id],
                "control-plane.env": ["workspace-credential/deploy"],
            }),
        "{exported}"
    );
    let (ok, text) = cli(&check, &[], "")?;
    ensure!(ok, "{text}");

    // The Gateway's file carries the Slack secrets and not the Workspace Credential; the
    // Control Plane's file carries neither Slack secret.
    let gateway_settings = credential_settings(&deployment.join("gateway.env"))?;
    let control_settings = credential_settings(&deployment.join("control-plane.env"))?;
    ensure!(
        gateway_settings
            .iter()
            .all(|(key, _)| !key.starts_with("SUPERTAG_CONTROL_PLANE_"))
            && control_settings
                .iter()
                .all(|(key, _)| !key.starts_with("SUPERTAG_GATEWAY_")),
        "{gateway_settings:?} {control_settings:?}"
    );
    use base64::Engine as _;
    let decoded = |settings: &[(String, String)], key: &str| -> Result<String> {
        let value = &settings
            .iter()
            .find(|(name, _)| name == key)
            .with_context(|| format!("{key} is missing"))?
            .1;
        Ok(String::from_utf8(
            base64::engine::general_purpose::STANDARD.decode(value)?,
        )?)
    };
    let gateway_document = decoded(&gateway_settings, "SUPERTAG_GATEWAY_CREDENTIALS")?;
    let control_document = decoded(&control_settings, "SUPERTAG_CONTROL_PLANE_CREDENTIALS")?;
    ensure!(
        gateway_document.contains(SIGNING) && !gateway_document.contains("synthetic-workspace")
    );
    ensure!(
        control_document.contains("synthetic-workspace-token")
            && !control_document.contains(SIGNING)
            && !control_document.contains(BOT)
    );

    // The Gateway reads its secrets from the environment alone: no state directory, no Vault.
    let environment: Vec<(&str, &str)> = gateway_settings
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    let mut gateway = services.gateway(&environment)?;
    let endpoints = gateway.endpoints(2).await?;
    let (status, body) = challenge(&endpoints[1], SIGNING).await?;
    ensure!(status == reqwest::StatusCode::OK, "{status}: {body}");
    let (status, _) = challenge(&endpoints[1], "a-different-signing-key").await?;
    ensure!(status == reqwest::StatusCode::UNAUTHORIZED, "{status}");
    drop(gateway);

    // Given the Control Plane's document instead, or none, the Gateway does not start, and
    // its diagnostics hold no credential.
    let crossed = [
        ("SUPERTAG_CREDENTIAL_VAULT", "env"),
        (
            "SUPERTAG_GATEWAY_CREDENTIALS",
            control_settings
                .iter()
                .find(|(key, _)| key == "SUPERTAG_CONTROL_PLANE_CREDENTIALS")
                .context("control document")?
                .1
                .as_str(),
        ),
    ];
    for (environment, message) in [
        (&crossed[..], "holds a credential the Control Plane reads"),
        (
            &[("SUPERTAG_CREDENTIAL_VAULT", "env")][..],
            "SUPERTAG_GATEWAY_CREDENTIALS is required",
        ),
        (
            &[
                ("SUPERTAG_CREDENTIAL_VAULT", "env"),
                (
                    "SUPERTAG_GATEWAY_CREDENTIALS",
                    "synthetic-malformed-secret!",
                ),
            ][..],
            "is not a credential document",
        ),
    ] {
        let logs = services.gateway(environment)?.failure().await?;
        ensure!(logs.contains(message), "{message}: {logs}");
        ensure!(
            !logs.contains("synthetic-workspace-token") && !logs.contains("synthetic-malformed"),
            "{logs}"
        );
    }

    // The services' backend is read-only: a store against it says how to change a credential.
    let (ok, text) = cli(
        &["gateway", "credential", "store", &id],
        &environment,
        &secrets,
    )?;
    ensure!(
        !ok && text.contains("read-only") && text.contains("SUPERTAG_CREDENTIAL_FILE"),
        "{text}"
    );
    drop(services.control_plane);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn operator_stores_slack_credentials_in_the_file_vault_for_the_gateway() -> Result<()> {
    let services = Services::start().await?;
    let state = services.directory.path().join("state");
    let state_text = state.to_str().context("state path")?;
    let id = format!("surface/slack/{ACCOUNT}");
    let mut store = reaped(Command::new(BINARY))
        .args(["gateway", "credential", "store", &id])
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

    let output = reaped(Command::new(BINARY))
        .args(["gateway", "credential", "delete", &id])
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
    let mut store = reaped(Command::new(BINARY))
        .args(["gateway", "credential", "store", &id])
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
