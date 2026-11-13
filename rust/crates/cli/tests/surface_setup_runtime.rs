//! `supertag setup surface`, `update tag --add-location|--remove-location`, and
//! `activate|deactivate permission-set|context-set` through real Control Plane and Gateway
//! processes. Provider APIs are loopback fixtures; no credential leaves the test.
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[macro_use]
#[path = "support/database.rs"]
mod database;

use std::{
    collections::BTreeMap,
    fs::File,
    io::{BufRead, BufReader, Write as _},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, ensure};
use axum::{
    Json, Router,
    extract::{Path as UrlPath, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use supertag_gateway::credential_vault::{CredentialVault, FileCredentialVault};
use supertag_protocol::{
    authenticated_request,
    v2::{
        AcceptSlackEventRequest, ContextSet, PermissionSet, PolicyContextItem, PolicyPermission,
        PolicyPermissionTarget, PutContextSetRequest, PutPermissionSetRequest, PutTagRequest,
        connector_client::ConnectorClient, operator_client::OperatorClient,
        policy_catalog_client::PolicyCatalogClient,
    },
};
use tokio::time::sleep;
use tonic::Request;
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const WAIT: Duration = Duration::from_secs(25);
const SLACK_TEAM: &str = "T0SETUP1";
const SLACK_BOT: &str = "xoxb-synthetic-setup-bot";
const SLACK_SIGNING: &str = "synthetic-setup-signing-secret";
const SLACK_CHANNEL: &str = "C0SETUP1";
const SLACK_USER: &str = "U0ALICE1";
const GITHUB_TOKEN: &str = "github_pat_synthetic_setup";
const GITHUB_WEBHOOK: &str = "synthetic-github-webhook-secret";
const LINEAR_KEY: &str = "lin_api_synthetic_setup";
const LINEAR_WEBHOOK: &str = "synthetic-linear-webhook-secret";
const LINEAR_WORKSPACE: &str = "6f0c1d7e-2b9a-4c3d-8e5f-0a1b2c3d4e5f";
const LINEAR_TEAM: &str = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const LARK_APP: &str = "cli_0123456789abcdef";
const LARK_SECRET: &str = "synthetic-lark-app-secret";
const TEAMS_APP: &str = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const TEAMS_SECRET: &str = "synthetic-teams-client-secret";
const TEAMS_TENANT: &str = "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f";

/// Every request a provider fixture received: path, authorization, and body.
#[derive(Clone, Default)]
struct Provider {
    requests: Arc<Mutex<Vec<(String, String, String)>>>,
}

impl Provider {
    fn record(&self, path: &str, headers: &HeaderMap, body: &str) {
        let authorization = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        self.requests
            .lock()
            .unwrap()
            .push((path.into(), authorization, body.into()));
    }
    fn saw(&self, path: &str, needle: &str) -> bool {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .any(|(p, auth, body)| p == path && (auth.contains(needle) || body.contains(needle)))
    }
}

async fn slack_auth(
    State(provider): State<Provider>,
    headers: HeaderMap,
    body: String,
) -> Response {
    provider.record("/auth.test", &headers, &body);
    let team = match headers.get("authorization").and_then(|v| v.to_str().ok()) {
        Some(value) if value == format!("Bearer {SLACK_BOT}") => SLACK_TEAM,
        Some("Bearer xoxb-other-workspace") => "T0OTHER1",
        _ => return Json(json!({"ok": false, "error": "invalid_auth"})).into_response(),
    };
    Json(
        json!({"ok": true, "team": "Acme", "team_id": team, "user_id": "U0BOT", "bot_id": "B0BOT"}),
    )
    .into_response()
}

async fn slack_post(
    State(provider): State<Provider>,
    headers: HeaderMap,
    body: String,
) -> Response {
    provider.record("/chat.postMessage", &headers, &body);
    Json(json!({"ok": true, "ts": "1794470001.000100"})).into_response()
}

async fn github_user(State(provider): State<Provider>, headers: HeaderMap) -> Response {
    provider.record("/user", &headers, "");
    if headers.get("authorization").and_then(|v| v.to_str().ok())
        != Some(&format!("Bearer {GITHUB_TOKEN}"))
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(json!({"id": 123, "login": "octocat", "type": "User"})).into_response()
}

async fn github_installation(
    State(provider): State<Provider>,
    headers: HeaderMap,
    UrlPath(id): UrlPath<u64>,
) -> Response {
    provider.record(&format!("/app/installations/{id}"), &headers, "");
    let jwt = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default();
    if jwt.split('.').count() != 3 {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(json!({"id": id, "account": {"id": 9, "login": "acme", "type": "Organization"}}))
        .into_response()
}

async fn linear(State(provider): State<Provider>, headers: HeaderMap, body: String) -> Response {
    provider.record("/graphql", &headers, &body);
    if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some(LINEAR_KEY) {
        return Json(json!({"errors": [{"message": "Authentication required"}]})).into_response();
    }
    Json(json!({"data": {
        "workspace": {"id": LINEAR_WORKSPACE, "name": "Acme Linear", "urlKey": "acme"},
        "viewer": {"id": "viewer", "name": "Setup", "email": "setup@example.invalid"}
    }}))
    .into_response()
}

async fn lark_token(
    State(provider): State<Provider>,
    headers: HeaderMap,
    body: String,
) -> Response {
    provider.record("/lark/token", &headers, &body);
    let value: Value = serde_json::from_str(&body).unwrap_or_default();
    if value["app_id"] != LARK_APP || value["app_secret"] != LARK_SECRET {
        return Json(json!({"code": 10014, "msg": "app secret invalid"})).into_response();
    }
    Json(json!({"code": 0, "tenant_access_token": "t-synthetic", "expire": 7200})).into_response()
}

async fn lark_bot(State(provider): State<Provider>, headers: HeaderMap) -> Response {
    provider.record("/lark/bot", &headers, "");
    Json(json!({"code": 0, "bot": {"open_id": "ou_setupbot", "app_name": "Acme Bot"}}))
        .into_response()
}

async fn teams_token(
    State(provider): State<Provider>,
    headers: HeaderMap,
    UrlPath(tenant): UrlPath<String>,
    body: String,
) -> Response {
    provider.record(&format!("/{tenant}/token"), &headers, &body);
    if !body.contains(&format!("client_secret={TEAMS_SECRET}")) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(json!({"access_token": "synthetic", "expires_in": 3600, "token_type": "Bearer"}))
        .into_response()
}

async fn provider_fixture() -> Result<(Provider, String)> {
    let state = Provider::default();
    let app = Router::new()
        .route("/auth.test", post(slack_auth))
        .route("/chat.postMessage", post(slack_post))
        .route("/user", get(github_user))
        .route("/app/installations/{id}", get(github_installation))
        .route("/graphql", post(linear))
        .route(
            "/open-apis/auth/v3/tenant_access_token/internal",
            post(lark_token),
        )
        .route("/open-apis/bot/v3/info", get(lark_bot))
        .route("/{tenant}/oauth2/v2.0/token", post(teams_token))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    tokio::spawn(async move { axum::serve(listener, app).await });
    Ok((state, format!("http://{address}")))
}

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
            let _ = std::io::copy(&mut reader, &mut std::io::sink());
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

/// A Control Plane, an operator Gateway, the provider fixture, and a state directory whose
/// supertag.yaml has a control-plane service.
struct Services {
    directory: tempfile::TempDir,
    state: PathBuf,
    gateway_token: String,
    operator_token: String,
    private: String,
    public: String,
    provider: Provider,
    origin: String,
    _processes: Vec<Process>,
}

impl Services {
    async fn start(database: &str) -> Result<Self> {
        let directory = tempfile::tempdir()?;
        let state = directory.path().join("state");
        std::fs::create_dir(&state)?;
        std::fs::write(
            state.join("supertag.yaml"),
            "# Local services\nservices:\n  control-plane:\n    type: control-plane\n",
        )?;
        let (provider, origin) = provider_fixture().await?;
        let gateway_token = Uuid::new_v4().to_string();
        let operator_token = Uuid::new_v4().to_string();
        let mut command = Command::new(BINARY);
        command
            .arg("control-plane")
            .env_clear()
            .stdin(Stdio::null())
            .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", Uuid::new_v4().to_string())
            .env("SUPERTAG_DATABASE_URL", database);
        let mut control_plane = Process::spawn(command, directory.path())?;
        let private = control_plane.endpoints(1).await?.remove(0);
        let mut command = Command::new(BINARY);
        command
            .args(["gateway", "--control-plane", &private])
            .env_clear()
            .stdin(Stdio::null())
            .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
            .env("SUPERTAG_OPERATOR_TOKEN", &operator_token);
        let mut gateway = Process::spawn(command, directory.path())?;
        let public = gateway.endpoints(1).await?.remove(0);
        let services = Self {
            directory,
            state,
            gateway_token,
            operator_token,
            private,
            public,
            provider,
            origin,
            _processes: vec![control_plane, gateway],
        };
        services.prepare().await?;
        Ok(services)
    }

    fn request<T>(&self, message: T) -> Result<Request<T>> {
        Ok(authenticated_request(message, &self.operator_token, None)?)
    }

    /// The Tag and policy Sets the locations use.
    async fn prepare(&self) -> Result<()> {
        let mut operator = OperatorClient::connect(self.public.clone()).await?;
        operator
            .put_tag(self.request(PutTagRequest {
                tag_id: "builder".into(),
                instructions: "Build carefully".into(),
                allowed_actions: vec!["files:read".into()],
                ..Default::default()
            })?)
            .await?;
        let mut policy = PolicyCatalogClient::connect(self.public.clone()).await?;
        policy
            .put_permission_set(self.request(PutPermissionSetRequest {
                operation_id: "reviewers".into(),
                permission_set: Some(PermissionSet {
                    set_id: "reviewers".into(),
                    name: "Reviewers".into(),
                    permissions: vec![PolicyPermission {
                        target: PolicyPermissionTarget::Runtime as i32,
                        action: "files:read".into(),
                        ..Default::default()
                    }],
                    ..Default::default()
                }),
                ..Default::default()
            })?)
            .await?;
        policy
            .put_context_set(self.request(PutContextSetRequest {
                operation_id: "runbook".into(),
                context_set: Some(ContextSet {
                    set_id: "runbook".into(),
                    name: "Runbook".into(),
                    items: vec![PolicyContextItem {
                        item_key: "release".into(),
                        r#type: "example/runbook".into(),
                        version: 1,
                        config_json: "{}".into(),
                        ..Default::default()
                    }],
                    ..Default::default()
                }),
                ..Default::default()
            })?)
            .await?;
        Ok(())
    }

    /// Runs the CLI against the operator Gateway with only the given environment.
    fn cli(&self, args: &[&str], environment: &[(&str, &str)], input: &str) -> Result<Output> {
        let mut child = Command::new(BINARY)
            .args(args)
            .args(["--gateway", &self.public, "--state-directory"])
            .arg(&self.state)
            .env_clear()
            .env("HOME", self.directory.path())
            .env("SUPERTAG_OPERATOR_TOKEN", &self.operator_token)
            .env(
                "SUPERTAG_TEST_SLACK_API_URL",
                format!("{}/chat.postMessage", self.origin),
            )
            .env("SUPERTAG_TEST_GITHUB_API_URL", format!("{}/", self.origin))
            .env(
                "SUPERTAG_TEST_LINEAR_API_URL",
                format!("{}/graphql", self.origin),
            )
            .env("SUPERTAG_TEST_LARK_ORIGIN", format!("{}/", self.origin))
            .env(
                "SUPERTAG_TEST_MICROSOFT_TEAMS_ORIGIN",
                format!("{}/", self.origin),
            )
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
        Ok(child.wait_with_output()?)
    }

    fn succeed(&self, args: &[&str], environment: &[(&str, &str)], input: &str) -> Result<String> {
        let output = self.cli(args, environment, input)?;
        let stdout = String::from_utf8(output.stdout)?;
        let stderr = String::from_utf8(output.stderr)?;
        ensure!(output.status.success(), "{args:?} failed: {stdout}{stderr}");
        no_secrets(&format!("{stdout}{stderr}"))?;
        Ok(stdout)
    }

    fn fail(&self, args: &[&str], environment: &[(&str, &str)], input: &str) -> Result<String> {
        let output = self.cli(args, environment, input)?;
        let stderr = String::from_utf8(output.stderr)?;
        ensure!(!output.status.success(), "{args:?} unexpectedly succeeded");
        no_secrets(&stderr)?;
        Ok(stderr)
    }

    fn json(&self, args: &[&str]) -> Result<Value> {
        let output = Command::new(BINARY)
            .args(["--gateway", &self.public])
            .args(args)
            .env_clear()
            .env("SUPERTAG_OPERATOR_TOKEN", &self.operator_token)
            .stdin(Stdio::null())
            .output()?;
        ensure!(output.status.success(), "{args:?}: {output:?}");
        Ok(serde_json::from_slice(&output.stdout)?)
    }

    fn surfaces(&self) -> Result<Value> {
        let text = std::fs::read_to_string(self.state.join("supertag.yaml"))?;
        no_secrets(&text)?;
        let value: Value = serde_saphyr::from_str(&text)?;
        Ok(value["surfaces"].clone())
    }

    async fn credential(&self, id: &str) -> Result<BTreeMap<String, String>> {
        CredentialVault::File(FileCredentialVault::new(
            self.state.join("gateway-credentials.json"),
        ))
        .resolve(id)
        .await?
        .with_context(|| format!("{id} is not in the vault"))
    }

    /// A connector Gateway configured from the environment `supertag up` derives from an entry.
    fn connector(&self, flags: &[&str], environment: &[(&str, &str)]) -> Result<Process> {
        let mut command = Command::new(BINARY);
        command
            .args(["gateway", "--control-plane", &self.private])
            .args(flags)
            .env_clear()
            .stdin(Stdio::null())
            .env("SUPERTAG_GATEWAY_TOKEN", &self.gateway_token)
            .env("SUPERTAG_OPERATOR_TOKEN", Uuid::new_v4().to_string())
            .env("SUPERTAG_STATE_DIR", &self.state)
            .env(
                "SUPERTAG_TEST_SLACK_API_URL",
                format!("{}/chat.postMessage", self.origin),
            )
            .env("SUPERTAG_TEST_GITHUB_API_URL", format!("{}/", self.origin))
            .env(
                "SUPERTAG_TEST_LINEAR_API_URL",
                format!("{}/graphql", self.origin),
            )
            .env("SUPERTAG_TEST_LARK_ORIGIN", format!("{}/", self.origin))
            .env(
                "SUPERTAG_TEST_MICROSOFT_TEAMS_ORIGIN",
                format!("{}/", self.origin),
            )
            .envs(environment.iter().copied());
        Process::spawn(command, self.directory.path())
    }

    fn scratch(&self, name: &str) -> String {
        self.directory.path().join(name).display().to_string()
    }
}

fn no_secrets(text: &str) -> Result<()> {
    for secret in [
        SLACK_BOT,
        SLACK_SIGNING,
        GITHUB_TOKEN,
        GITHUB_WEBHOOK,
        LINEAR_KEY,
        LINEAR_WEBHOOK,
        LARK_SECRET,
        TEAMS_SECRET,
        "PRIVATE KEY",
    ] {
        ensure!(!text.contains(secret), "a secret was exposed: {text}");
    }
    Ok(())
}

fn hmac_hex(secret: &str, message: &[u8]) -> Result<String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())?;
    mac.update(message);
    Ok(format!("{:x}", mac.finalize().into_bytes()))
}

fn http() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()?)
}

async fn signed_slack(endpoint: &str, body: &str, secret: &str) -> Result<reqwest::Response> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_secs()
        .to_string();
    let signature = hmac_hex(secret, format!("v0:{timestamp}:{body}").as_bytes())?;
    Ok(http()?
        .post(format!("{endpoint}/slack/events"))
        .header("content-type", "application/json")
        .header("x-slack-request-timestamp", timestamp)
        .header("x-slack-signature", format!("v0={signature}"))
        .body(body.to_owned())
        .send()
        .await?)
}

/// Setup verifies with Slack before saving anything; a bound location with activated Sets
/// admits a signed event through a Gateway that reads the Slack secrets from the vault.
async fn slack_setup_binds_policy_and_admits_through_the_vault(database: String) -> Result<()> {
    let services = Services::start(&database).await?;
    let original = std::fs::read(services.state.join("supertag.yaml"))?;

    // A missing value at the end of input names its variable and saves nothing.
    let stderr = services.fail(&["setup", "surface", "slack", "--name", "acme"], &[], "")?;
    ensure!(
        stderr.contains("Slack bot token (xoxb-…) is required: set SLACK_BOT_TOKEN"),
        "{stderr}"
    );
    // Rejected credentials save nothing.
    let stderr = services.fail(
        &["setup", "surface", "slack", "--name", "acme"],
        &[("SLACK_BOT_TOKEN", "xoxb-rejected")],
        &format!("{SLACK_SIGNING}\n"),
    )?;
    ensure!(
        stderr.contains("Slack auth.test failed: invalid_auth"),
        "{stderr}"
    );
    let stderr = services.fail(
        &["setup", "surface", "slack", "--transport", "socket"],
        &[],
        "",
    )?;
    ensure!(stderr.contains("--transport must be http"), "{stderr}");
    ensure!(std::fs::read(services.state.join("supertag.yaml"))? == original);
    ensure!(!services.state.join("gateway-credentials.json").exists());
    let accounts = services.json(&["surface-policy", "list", "account"])?;
    ensure!(accounts["accounts"] == json!([]), "{accounts}");

    // Interactive setup: each prompt reads a line of standard input.
    let stdout = services.succeed(
        &["setup", "surface", "slack", "--name", "acme"],
        &[],
        &format!("{SLACK_BOT}\n{SLACK_SIGNING}\n"),
    )?;
    ensure!(
        stdout.contains(&format!("Connected slack account Acme ({SLACK_TEAM}).")),
        "{stdout}"
    );
    ensure!(services.provider.saw("/auth.test", SLACK_BOT));
    let account = services.json(&["surface-policy", "show", "account", "acme"])?;
    ensure!(
        account["identity"] == json!({"provider": "slack", "team_id": SLACK_TEAM})
            && account["enabled"] == true,
        "{account}"
    );
    ensure!(
        services.credential("surface/slack/acme").await?
            == BTreeMap::from([
                ("botToken".to_owned(), SLACK_BOT.to_owned()),
                ("signingSecret".to_owned(), SLACK_SIGNING.to_owned()),
            ])
    );
    let text = std::fs::read_to_string(services.state.join("supertag.yaml"))?;
    ensure!(
        text.starts_with("# Local services\nservices:\n  control-plane:\n"),
        "{text}"
    );
    let entry = services.surfaces()?["acme"].clone();
    ensure!(
        entry
            == json!({"provider": "slack", "account": SLACK_TEAM, "display-name": "Acme",
                "listen": "127.0.0.1:3480", "bot-id": "B0BOT", "bot-user-id": "U0BOT"}),
        "{entry}"
    );

    // Another workspace cannot take over an existing account name.
    let stderr = services.fail(
        &["setup", "surface", "slack", "--name", "acme"],
        &[
            ("SLACK_BOT_TOKEN", "xoxb-other-workspace"),
            ("SLACK_SIGNING_SECRET", "other-signing-secret"),
        ],
        "",
    )?;
    ensure!(
        stderr.contains("Surface Account acme is connected to a different slack account"),
        "{stderr}"
    );
    ensure!(services.credential("surface/slack/acme").await?["botToken"] == SLACK_BOT);

    // Bind the Tag to a channel, then apply policy Sets to work started there.
    let listen = free_port()?;
    let stderr = services.fail(
        &[
            "update",
            "tag",
            "builder",
            "--add-location",
            "github",
            "--repo",
            "acme/app",
            "--repo-id",
            "7",
            "--allowed-user",
            "1",
        ],
        &[],
        "",
    )?;
    ensure!(
        stderr.contains("No connected github account exists. Run supertag setup surface github."),
        "{stderr}"
    );
    let stdout = services.succeed(
        &[
            "update",
            "tag",
            "builder",
            "--add-location",
            "slack",
            "--channel-id",
            SLACK_CHANNEL,
            "--allowed-user",
            SLACK_USER,
        ],
        &[],
        "",
    )?;
    ensure!(
        stdout.contains(&format!("Added builder to slack {SLACK_CHANNEL} on Acme.")),
        "{stdout}"
    );
    // Rerunning setup keeps the location and refreshes the credential.
    services.succeed(
        &[
            "setup", "surface", "slack", "--name", "acme", "--listen", &listen,
        ],
        &[
            ("SLACK_BOT_TOKEN", SLACK_BOT),
            ("SLACK_SIGNING_SECRET", SLACK_SIGNING),
        ],
        "",
    )?;
    let entry = services.surfaces()?["acme"].clone();
    ensure!(
        entry["listen"] == listen.as_str()
            && entry["location"]
                == json!({"tag": "builder", "allowed-users": [SLACK_USER], "channel-id": SLACK_CHANNEL}),
        "{entry}"
    );
    let locations = services.json(&["surface-policy", "list", "location", "--account", "acme"])?;
    let location = locations["locations"][0].clone();
    let location_id = location["location_id"]
        .as_str()
        .context("location ID")?
        .to_owned();
    ensure!(
        locations["locations"].as_array().map(Vec::len) == Some(1)
            && location["connector_account_id"] == location_id.as_str()
            && location["tag_id"] == "builder"
            && location["scope"] == json!({"provider": "slack", "channel_id": SLACK_CHANNEL}),
        "{locations}"
    );
    // A second location for the same account is refused: one Gateway connector per account.
    let stderr = services.fail(
        &[
            "update",
            "tag",
            "builder",
            "--add-location",
            "slack",
            "--channel-id",
            "C0OTHER1",
            "--allowed-user",
            SLACK_USER,
        ],
        &[],
        "",
    )?;
    ensure!(
        stderr.contains("already serves builder at slack C0SETUP1"),
        "{stderr}"
    );

    for (action, kind, set) in [
        ("activate", "permission-set", "Reviewers"),
        ("activate", "context-set", "runbook"),
        ("deactivate", "context-set", "runbook"),
        ("activate", "context-set", "runbook"),
    ] {
        let stdout = services.succeed(
            &[action, kind, set, "--tag", "builder", "--provider", "slack"],
            &[],
            "",
        )?;
        let verb = if action == "activate" {
            "Activated"
        } else {
            "Deactivated"
        };
        ensure!(
            stdout.contains(&format!("{verb} {set} for slack {SLACK_CHANNEL}.")),
            "{stdout}"
        );
    }
    let stderr = services.fail(
        &[
            "activate",
            "permission-set",
            "missing-set",
            "--tag",
            "builder",
            "--provider",
            "slack",
        ],
        &[],
        "",
    )?;
    ensure!(stderr.to_lowercase().contains("not found"), "{stderr}");
    let location = services.json(&["surface-policy", "show", "location", &location_id])?;
    ensure!(
        location["permission_set_ids"] == json!(["reviewers"])
            && location["context_set_ids"] == json!(["runbook"]),
        "{location}"
    );

    // The connector reads both Slack secrets from the vault, not the environment.
    let mut gateway = services.connector(
        &[
            "--slack-listen",
            &listen,
            "--slack-state-directory",
            &services.scratch("slack"),
        ],
        &[
            ("SUPERTAG_SLACK_ACCOUNT_ID", &location_id),
            ("SUPERTAG_SLACK_CREDENTIAL_ID", "surface/slack/acme"),
            ("SUPERTAG_SLACK_TEAM_ID", SLACK_TEAM),
            ("SUPERTAG_SLACK_CHANNEL_ID", SLACK_CHANNEL),
            ("SUPERTAG_SLACK_TAG_ID", "builder"),
            ("SUPERTAG_SLACK_ALLOWED_USERS", SLACK_USER),
        ],
    )?;
    let endpoints = gateway.endpoints(2).await?;
    let event = json!({
        "type": "event_callback", "team_id": SLACK_TEAM, "event_id": "EvSETUP1",
        "event": {"type": "app_mention", "channel": SLACK_CHANNEL, "user": SLACK_USER,
            "text": "check the release", "ts": "1794470000.123456", "thread_ts": "1794469999.012345"}
    })
    .to_string();
    let response = signed_slack(&endpoints[1], &event, "wrong-secret").await?;
    ensure!(
        response.status() == StatusCode::UNAUTHORIZED,
        "{response:?}"
    );
    let response = signed_slack(&endpoints[1], &event, SLACK_SIGNING).await?;
    ensure!(response.status() == StatusCode::OK, "{response:?}");
    let mut connector = ConnectorClient::connect(services.private.clone()).await?;
    let mut request = authenticated_request(
        AcceptSlackEventRequest {
            account_id: location_id.clone(),
            event_id: "EvSETUP1".into(),
            mention_tag_id: Some("builder".into()),
            actor_id: SLACK_USER.into(),
            team_id: SLACK_TEAM.into(),
            channel_id: SLACK_CHANNEL.into(),
            message_ts: "1794470000.123456".into(),
            thread_ts: "1794469999.012345".into(),
            prompt: "check the release".into(),
        },
        &services.gateway_token,
        Some(&format!("connector:{location_id}")),
    )?;
    request.set_timeout(Duration::from_secs(5));
    let task = connector
        .accept_slack_event(request)
        .await?
        .into_inner()
        .task
        .context("the signed Slack event was not admitted")?;
    let snapshot = task.policy_snapshot.context("policy snapshot")?;
    ensure!(
        snapshot
            .origin
            .as_ref()
            .map(|origin| origin.location_id.as_str())
            == Some(location_id.as_str())
            && snapshot
                .permission_sets
                .iter()
                .map(|set| set.set_id.as_str())
                .eq(["reviewers"])
            && snapshot
                .context_sets
                .iter()
                .map(|set| set.set_id.as_str())
                .eq(["runbook"]),
        "{snapshot:?}"
    );
    drop(gateway);

    // Removing the location stops new work there and clears it from supertag.yaml.
    let stdout = services.succeed(
        &["update", "tag", "builder", "--remove-location", "slack"],
        &[],
        "",
    )?;
    ensure!(
        stdout.contains(&format!(
            "Removed builder from slack {SLACK_CHANNEL} on Acme."
        )),
        "{stdout}"
    );
    ensure!(services.surfaces()?["acme"].get("location").is_none());
    let locations = services.json(&["surface-policy", "list", "location", "--account", "acme"])?;
    ensure!(locations["locations"] == json!([]), "{locations}");
    let stderr = services.fail(
        &["update", "tag", "builder", "--remove-location", "slack"],
        &[],
        "",
    )?;
    ensure!(
        stderr.contains("builder is not configured on slack"),
        "{stderr}"
    );
    Ok(())
}

fn free_port() -> Result<String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.to_string())
}

fn private_key(directory: &Path) -> Result<PathBuf> {
    let path = directory.join("github-app.pem");
    let output = Command::new("openssl")
        .args(["genrsa", "-out"])
        .arg(&path)
        .arg("2048")
        .output()
        .context("the test requires the openssl CLI")?;
    ensure!(output.status.success(), "{output:?}");
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    Ok(path)
}

/// GitHub (token and App), Linear, Lark, and Teams setup record each provider identity, its
/// secrets in the vault, and its settings in supertag.yaml; Gateway connectors then read those
/// secrets from the vault.
async fn every_provider_setup_reaches_the_gateway_through_the_vault(
    database: String,
) -> Result<()> {
    let services = Services::start(&database).await?;
    // Token setup collects a webhook secret only with --webhook.
    services.succeed(
        &["setup", "surface", "github", "--name", "gh"],
        &[
            ("SUPERTAG_GITHUB_TOKEN", GITHUB_TOKEN),
            ("GITHUB_WEBHOOK_SECRET", GITHUB_WEBHOOK),
        ],
        "",
    )?;
    ensure!(
        services.credential("surface/github/gh").await?
            == BTreeMap::from([("token".to_owned(), GITHUB_TOKEN.to_owned())])
    );
    let stdout = services.succeed(
        &["setup", "surface", "github", "--name", "gh", "--webhook"],
        &[
            ("SUPERTAG_GITHUB_TOKEN", GITHUB_TOKEN),
            ("GITHUB_WEBHOOK_SECRET", GITHUB_WEBHOOK),
        ],
        "",
    )?;
    ensure!(
        stdout.contains("Connected github account octocat (user-123)."),
        "{stdout}"
    );
    // One provider account has one Surface Account name.
    let stderr = services.fail(
        &["setup", "surface", "github", "--name", "gh-token"],
        &[("SUPERTAG_GITHUB_TOKEN", GITHUB_TOKEN)],
        "",
    )?;
    ensure!(
        stderr.contains("Surface Account identity already exists"),
        "{stderr}"
    );
    let key = private_key(services.directory.path())?;
    let key_text = key.display().to_string();
    let stdout = services.succeed(
        &[
            "setup", "surface", "github", "--name", "gh-app", "--auth", "app",
        ],
        &[
            ("GITHUB_APP_ID", "42"),
            ("GITHUB_INSTALLATION_ID", "456"),
            ("GITHUB_PRIVATE_KEY_PATH", &key_text),
            ("GITHUB_WEBHOOK_SECRET", GITHUB_WEBHOOK),
        ],
        "",
    )?;
    ensure!(
        stdout.contains("Connected github account acme (installation-456)."),
        "{stdout}"
    );
    services.succeed(
        &["setup", "surface", "linear"],
        &[
            ("LINEAR_API_KEY", LINEAR_KEY),
            ("LINEAR_WEBHOOK_SECRET", LINEAR_WEBHOOK),
        ],
        "",
    )?;
    services.succeed(
        &["setup", "surface", "lark", "--domain", "feishu"],
        &[
            ("LARK_APP_ID", LARK_APP),
            ("LARK_APP_SECRET", LARK_SECRET),
            ("LARK_TENANT_KEY", "tenant-setup"),
        ],
        "",
    )?;
    let stdout = services.succeed(
        &["setup", "surface", "teams"],
        &[],
        &format!("{TEAMS_APP}\n{TEAMS_SECRET}\n{TEAMS_TENANT}\nAcme Teams\n"),
    )?;
    ensure!(
        stdout.contains(&format!(
            "Connected teams account Acme Teams ({TEAMS_TENANT})."
        )),
        "{stdout}"
    );

    let accounts = services.json(&["surface-policy", "list", "account"])?;
    let identities: BTreeMap<String, Value> = accounts["accounts"]
        .as_array()
        .context("accounts")?
        .iter()
        .map(|account| {
            (
                account["account_id"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                account["identity"].clone(),
            )
        })
        .collect();
    ensure!(
        identities
            == BTreeMap::from([
                (
                    "gh".to_owned(),
                    json!({"provider": "github", "external_account_id": "user-123"})
                ),
                (
                    "gh-app".to_owned(),
                    json!({"provider": "github", "external_account_id": "installation-456"})
                ),
                (
                    "lark".to_owned(),
                    json!({"provider": "lark", "feishu": true, "app_id": LARK_APP, "tenant_key": "tenant-setup"})
                ),
                (
                    "linear".to_owned(),
                    json!({"provider": "linear", "workspace_id": LINEAR_WORKSPACE})
                ),
                (
                    "teams".to_owned(),
                    json!({"provider": "microsoft_teams", "app_id": TEAMS_APP, "tenant_id": TEAMS_TENANT})
                ),
            ]),
        "{identities:?}"
    );
    let surfaces = services.surfaces()?;
    ensure!(
        surfaces["gh"]
            == json!({"provider": "github", "account": "user-123", "display-name": "octocat", "listen": "127.0.0.1:3481", "auth": "token"})
            && surfaces["gh-app"]
                == json!({"provider": "github", "account": "installation-456", "display-name": "acme", "listen": "127.0.0.1:3481", "auth": "app", "app-id": "42", "installation-id": "456"})
            && surfaces["linear"]
                == json!({"provider": "linear", "account": LINEAR_WORKSPACE, "display-name": "Acme Linear", "listen": "127.0.0.1:3482"})
            && surfaces["lark"]
                == json!({"provider": "lark", "account": LARK_APP, "display-name": "Acme Bot", "domain": "feishu", "tenant-key": "tenant-setup", "bot-open-id": "ou_setupbot"})
            && surfaces["teams"]
                == json!({"provider": "teams", "account": TEAMS_TENANT, "display-name": "Acme Teams", "listen": "127.0.0.1:3483", "app-id": TEAMS_APP})
            && surfaces.get("gh-token").is_none(),
        "{surfaces}"
    );
    let field = |pairs: &[(&str, &str)]| -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    };
    ensure!(
        services.credential("surface/github/gh").await?
            == field(&[("token", GITHUB_TOKEN), ("webhookSecret", GITHUB_WEBHOOK)])
    );
    let app = services.credential("surface/github/gh-app").await?;
    ensure!(
        app["webhookSecret"] == GITHUB_WEBHOOK
            && app["privateKey"] == std::fs::read_to_string(&key)?
    );
    ensure!(
        services.credential("surface/linear/linear").await?
            == field(&[("apiKey", LINEAR_KEY), ("webhookSecret", LINEAR_WEBHOOK)])
    );
    ensure!(
        services.credential("surface/lark/lark").await? == field(&[("appSecret", LARK_SECRET)])
    );
    ensure!(
        services.credential("surface/teams/teams").await? == field(&[("appSecret", TEAMS_SECRET)])
    );

    // GitHub: the vault's webhook secret authenticates deliveries; its token is used for replies.
    let mut github = services.connector(
        &[
            "--github-listen",
            "127.0.0.1:0",
            "--github-state-directory",
            &services.scratch("github"),
        ],
        &[
            ("SUPERTAG_GITHUB_ACCOUNT_ID", "gh-route"),
            ("SUPERTAG_GITHUB_CREDENTIAL_ID", "surface/github/gh"),
            ("SUPERTAG_GITHUB_REPOSITORY_ID", "77"),
            ("SUPERTAG_GITHUB_REPOSITORY", "acme/app"),
            ("SUPERTAG_GITHUB_TAG_ID", "builder"),
            ("SUPERTAG_GITHUB_ALLOWED_USERS", "1"),
        ],
    )?;
    let endpoints = github.endpoints(2).await?;
    for (secret, expected) in [
        ("wrong-secret", StatusCode::UNAUTHORIZED),
        (GITHUB_WEBHOOK, StatusCode::ACCEPTED),
    ] {
        let response = http()?
            .post(format!("{}/github/events", endpoints[1]))
            .header("x-github-event", "ping")
            .header("x-github-delivery", "delivery-setup-1")
            .header(
                "x-hub-signature-256",
                format!("sha256={}", hmac_hex(secret, b"{}")?),
            )
            .body("{}")
            .send()
            .await?;
        ensure!(response.status() == expected, "{response:?}");
    }
    drop(github);
    // GitHub App: the vault's private key replaces SUPERTAG_GITHUB_PRIVATE_KEY_FILE.
    let mut app = services.connector(
        &[
            "--github-listen",
            "127.0.0.1:0",
            "--github-state-directory",
            &services.scratch("github-app"),
        ],
        &[
            ("SUPERTAG_GITHUB_ACCOUNT_ID", "gh-app-route"),
            ("SUPERTAG_GITHUB_CREDENTIAL_ID", "surface/github/gh-app"),
            ("SUPERTAG_GITHUB_APP_ID", "42"),
            ("SUPERTAG_GITHUB_INSTALLATION_ID", "456"),
            ("SUPERTAG_GITHUB_REPOSITORY_ID", "77"),
            ("SUPERTAG_GITHUB_REPOSITORY", "acme/app"),
            ("SUPERTAG_GITHUB_TAG_ID", "builder"),
            ("SUPERTAG_GITHUB_ALLOWED_USERS", "1"),
        ],
    )?;
    app.endpoints(2).await?;
    drop(app);

    // Linear: the vault's webhook secret authenticates deliveries.
    let mut linear = services.connector(
        &[
            "--linear-listen",
            "127.0.0.1:0",
            "--linear-state-directory",
            &services.scratch("linear"),
        ],
        &[
            ("SUPERTAG_LINEAR_ACCOUNT_ID", "linear-route"),
            ("SUPERTAG_LINEAR_CREDENTIAL_ID", "surface/linear/linear"),
            ("SUPERTAG_LINEAR_WORKSPACE_ID", LINEAR_WORKSPACE),
            ("SUPERTAG_LINEAR_TEAM_ID", LINEAR_TEAM),
            ("SUPERTAG_LINEAR_TAG_ID", "builder"),
            (
                "SUPERTAG_LINEAR_ALLOWED_USERS",
                "8b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
            ),
        ],
    )?;
    let endpoints = linear.endpoints(2).await?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
    let body = json!({"action": "create", "type": "Comment", "organizationId": LINEAR_WORKSPACE,
        "webhookTimestamp": now as u64, "actor": {"id": "9c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f", "type": "user"}, "data": {}})
    .to_string();
    for (secret, expected) in [
        ("wrong-secret", StatusCode::UNAUTHORIZED),
        (LINEAR_WEBHOOK, StatusCode::OK),
    ] {
        let response = http()?
            .post(format!("{}/linear/events", endpoints[1]))
            .header("linear-delivery", Uuid::new_v4().to_string())
            .header("linear-event", "Comment")
            .header("linear-signature", hmac_hex(secret, body.as_bytes())?)
            .body(body.clone())
            .send()
            .await?;
        ensure!(response.status() == expected, "{response:?}");
    }
    drop(linear);

    // Lark: the Gateway exchanges the vault's App secret for a tenant token at startup.
    let before = services.provider.requests.lock().unwrap().len();
    let lark = services.connector(
        &["--lark-state-directory", &services.scratch("lark")],
        &[
            ("SUPERTAG_LARK_ACCOUNT_ID", "lark-route"),
            ("SUPERTAG_LARK_CREDENTIAL_ID", "surface/lark/lark"),
            ("SUPERTAG_LARK_DOMAIN", "feishu"),
            ("SUPERTAG_LARK_APP_ID", LARK_APP),
            ("SUPERTAG_LARK_TENANT_KEY", "tenant-setup"),
            ("SUPERTAG_LARK_BOT_OPEN_ID", "ou_setupbot"),
            ("SUPERTAG_LARK_CHAT_ID", "oc_setupchat"),
            ("SUPERTAG_LARK_TAG_ID", "builder"),
            ("SUPERTAG_LARK_ALLOWED_USERS", "ou_alice"),
        ],
    )?;
    let deadline = Instant::now() + WAIT;
    while !services.provider.requests.lock().unwrap()[before..]
        .iter()
        .any(|(path, _, _)| path == "/lark/bot")
    {
        ensure!(
            Instant::now() < deadline,
            "Lark bot was not verified: {}",
            lark.logs()
        );
        sleep(Duration::from_millis(20)).await;
    }
    drop(lark);

    // Teams: the connector starts only with its vault secret; a missing entry fails closed.
    let teams_environment = [
        ("SUPERTAG_MICROSOFT_TEAMS_ACCOUNT_ID", "teams-route"),
        ("SUPERTAG_MICROSOFT_TEAMS_APP_ID", TEAMS_APP),
        ("SUPERTAG_MICROSOFT_TEAMS_TENANT_ID", TEAMS_TENANT),
        ("SUPERTAG_MICROSOFT_TEAMS_TEAM_ID", LINEAR_TEAM),
        (
            "SUPERTAG_MICROSOFT_TEAMS_CHANNEL_ID",
            "19:setup@thread.tacv2",
        ),
        ("SUPERTAG_MICROSOFT_TEAMS_TAG_ID", "builder"),
        ("SUPERTAG_MICROSOFT_TEAMS_ALLOWED_USERS", LINEAR_WORKSPACE),
    ];
    let flags = [
        "--microsoft-teams-listen",
        "127.0.0.1:0",
        "--microsoft-teams-state-directory",
    ];
    let scratch = services.scratch("teams");
    let mut missing = services.connector(
        &[&flags[..], &[scratch.as_str()]].concat(),
        &[
            &teams_environment[..],
            &[(
                "SUPERTAG_MICROSOFT_TEAMS_CREDENTIAL_ID",
                "surface/teams/absent",
            )],
        ]
        .concat(),
    )?;
    let logs = missing.failure().await?;
    ensure!(
        logs.contains("Microsoft Teams credentials are missing: store surface/teams/absent in the credential vault"),
        "{logs}"
    );
    let mut teams = services.connector(
        &[&flags[..], &[scratch.as_str()]].concat(),
        &[
            &teams_environment[..],
            &[(
                "SUPERTAG_MICROSOFT_TEAMS_CREDENTIAL_ID",
                "surface/teams/teams",
            )],
        ]
        .concat(),
    )?;
    teams.endpoints(2).await?;
    Ok(())
}

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    slack_setup_binds_policy_and_admits_through_the_vault;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    every_provider_setup_reaches_the_gateway_through_the_vault;
}

/// `supertag up` runs the local Gateway's connector from the `surfaces` section that setup and
/// `--add-location` wrote, with the Slack secrets from this state directory's vault. Local
/// services always use SQLite.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_up_serves_the_configured_surface_from_the_vault() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let state = directory.path().join("state");
    std::fs::create_dir(&state)?;
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o700))?;
    }
    std::fs::write(
        state.join("supertag.yaml"),
        "services:\n  control-plane:\n    type: control-plane\n    ports: [\"127.0.0.1:0\"]\n",
    )?;
    let (_provider, origin) = provider_fixture().await?;
    let slack_api = format!("{origin}/chat.postMessage");
    let environment = [
        ("HOME", directory.path().to_str().context("path")?),
        ("SUPERTAG_TEST_SLACK_API_URL", slack_api.as_str()),
    ];
    let up = || -> Result<(Child, mpsc::Receiver<String>)> {
        let mut child = Command::new(BINARY)
            .args(["up", "--foreground", "--state-directory"])
            .arg(&state)
            .env_clear()
            .envs(environment)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(File::create(directory.path().join("up.log"))?)
            .spawn()?;
        let stdout = child.stdout.take().context("stdout")?;
        let (sender, ready) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            let _ = reader.read_line(&mut line);
            let _ = sender.send(line);
            let _ = std::io::copy(&mut reader, &mut std::io::sink());
        });
        Ok((child, ready))
    };
    let stop = |mut child: Child| -> Result<()> {
        unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
        let deadline = Instant::now() + WAIT;
        while child.try_wait()?.is_none() {
            ensure!(Instant::now() < deadline, "supervisor did not stop");
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(())
    };
    let logs = || std::fs::read_to_string(directory.path().join("up.log")).unwrap_or_default();
    let (supervisor, ready) = up()?;
    let endpoint = ready.recv_timeout(WAIT)?.trim().to_owned();
    ensure!(!endpoint.is_empty(), "up failed: {}", logs());
    let credentials: Value =
        serde_json::from_slice(&std::fs::read(state.join("credentials.json"))?)?;
    let token = credentials["operator_token"].as_str().context("token")?;
    OperatorClient::connect(endpoint.clone())
        .await?
        .put_tag(authenticated_request(
            PutTagRequest {
                tag_id: "builder".into(),
                instructions: "Build carefully".into(),
                ..Default::default()
            },
            token,
            None,
        )?)
        .await?;
    let listen = free_port()?;
    let cli = |args: &[&str]| -> Result<String> {
        let output = Command::new(BINARY)
            .args(args)
            .arg("--state-directory")
            .arg(&state)
            .env_clear()
            .envs(environment)
            .env("SLACK_BOT_TOKEN", SLACK_BOT)
            .env("SLACK_SIGNING_SECRET", SLACK_SIGNING)
            .stdin(Stdio::null())
            .output()?;
        let text = String::from_utf8(output.stdout)? + &String::from_utf8(output.stderr)?;
        ensure!(output.status.success(), "{args:?}: {text}");
        no_secrets(&text)?;
        Ok(text)
    };
    cli(&["setup", "surface", "slack", "--listen", &listen])?;
    cli(&[
        "update",
        "tag",
        "builder",
        "--add-location",
        "slack",
        "--channel-id",
        SLACK_CHANNEL,
        "--allowed-user",
        SLACK_USER,
    ])?;
    let config = cli(&["config"])?;
    ensure!(
        config.contains("surfaces:") && config.contains(SLACK_CHANNEL),
        "{config}"
    );
    stop(supervisor)?;

    let (supervisor, ready) = up()?;
    ensure!(
        !ready.recv_timeout(WAIT)?.trim().is_empty(),
        "up failed: {}",
        logs()
    );
    let body = json!({"type": "url_verification", "challenge": "configured-challenge"}).to_string();
    let deadline = Instant::now() + WAIT;
    let response = loop {
        match signed_slack(&format!("http://{listen}"), &body, SLACK_SIGNING).await {
            Ok(response) => break response,
            Err(error) => {
                ensure!(Instant::now() < deadline, "{error}: {}", logs());
                sleep(Duration::from_millis(50)).await;
            }
        }
    };
    ensure!(response.status() == StatusCode::OK, "{response:?}");
    ensure!(response.text().await?.contains("configured-challenge"));
    let response = signed_slack(&format!("http://{listen}"), &body, "wrong-secret").await?;
    ensure!(
        response.status() == StatusCode::UNAUTHORIZED,
        "{response:?}"
    );
    stop(supervisor)?;
    Ok(())
}
