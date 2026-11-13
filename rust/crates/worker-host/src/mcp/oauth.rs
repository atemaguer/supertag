//! `supertag mcp login`: OAuth for catalog servers declared with `"oauth": true`.
//!
//! The login runs the MCP authorization flow (RFC 9728 resource metadata, RFC 8414 server
//! metadata, RFC 7591 client registration, authorization code with PKCE, and a loopback
//! redirect). Each server's login is stored in its own owner-only file in this host's
//! `mcp-logins` directory, holding only what a refresh needs. The Worker Host refreshes it under
//! an exclusive lock, so a rotating refresh token is spent once across every process on the host.
//! Neither the harness nor the Control Plane sees a token.

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use supertag_protocol::mcp;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};

const LOGIN_BYTES: u64 = 64 * 1024;
const TOKEN_TIMEOUT: Duration = Duration::from_secs(10);
const REFRESH_MARGIN_MS: i64 = 60_000;
const CALLBACK_PATH: &str = "/callback";

/// One server's stored login. A different URL needs a new login.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpLogin {
    pub url: String,
    /// Pinned to the server's origin when the login discovered it.
    pub token_endpoint: String,
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    pub refresh_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    /// Epoch milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_token_expires_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token_expires_at: Option<i64>,
    pub logged_in_at: i64,
    /// Set when the authorization server refused the refresh token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lapsed_at: Option<i64>,
}

/// What `supertag mcp list` shows; never a token.
#[derive(Debug, PartialEq, Eq)]
pub enum McpLoginState {
    LoggedIn { expires_at: Option<i64> },
    Lapsed,
    Missing,
}

/// The command that logs a server in, for messages.
pub fn login_command(server: &str) -> String {
    format!("supertag mcp login {server}")
}

/// This host's MCP logins: one owner-only file per server in an owner-only directory.
#[derive(Clone, Debug)]
pub struct McpLoginStore {
    directory: PathBuf,
}

struct Lock(#[allow(dead_code)] File);

impl McpLoginStore {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    /// `mcp-logins` in the SuperTag state directory (`SUPERTAG_STATE_DIR`, else `~/.supertag`).
    pub fn default_location() -> Result<Self> {
        let state = std::env::var_os("SUPERTAG_STATE_DIR")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".supertag")))
            .context("set HOME or SUPERTAG_STATE_DIR for the MCP login store")?;
        Ok(Self::new(state.join("mcp-logins")))
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    fn path(&self, server: &str) -> Result<PathBuf> {
        ensure!(mcp::server_name(server), "invalid MCP server name");
        Ok(self.directory.join(format!("{server}.json")))
    }

    fn prepare_directory(&self, create: bool) -> Result<bool> {
        match fs::symlink_metadata(&self.directory) {
            Ok(metadata) => {
                // SAFETY: geteuid takes no parameters and has no caller invariants.
                let uid = unsafe { libc::geteuid() };
                ensure!(
                    metadata.is_dir() && metadata.uid() == uid && metadata.mode() & 0o077 == 0,
                    "the MCP login directory must be an owner-only directory"
                );
                Ok(true)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {
                fs::create_dir_all(&self.directory)?;
                fs::set_permissions(&self.directory, fs::Permissions::from_mode(0o700))?;
                Ok(true)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error).context("inspect the MCP login directory"),
        }
    }

    /// Blocks until this process holds the store's exclusive lock.
    fn lock(&self) -> Result<Lock> {
        self.prepare_directory(true)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(self.directory.join(".lock"))
            .context("open the MCP login lock")?;
        loop {
            // SAFETY: the descriptor is open for the call's duration.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0 {
                return Ok(Lock(file));
            }
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::Interrupted {
                return Err(error).context("lock the MCP login store");
            }
        }
    }

    async fn lock_async(&self) -> Result<Lock> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || store.lock()).await?
    }

    pub fn read(&self, server: &str) -> Result<Option<McpLogin>> {
        let path = self.path(server)?;
        if !self.prepare_directory(false)? {
            return Ok(None);
        }
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => bail!("MCP login for {server} could not be opened"),
        };
        let metadata = file.metadata()?;
        // SAFETY: geteuid takes no parameters and has no caller invariants.
        let uid = unsafe { libc::geteuid() };
        ensure!(
            metadata.is_file()
                && metadata.nlink() == 1
                && metadata.uid() == uid
                && metadata.mode() & 0o077 == 0
                && metadata.len() <= LOGIN_BYTES,
            "MCP login for {server} must be a bounded, owner-only regular file"
        );
        let mut bytes = Vec::new();
        file.take(LOGIN_BYTES + 1).read_to_end(&mut bytes)?;
        // Parsing errors stay generic because this file holds credentials.
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| anyhow::anyhow!("MCP login for {server} is unreadable; log in again"))
    }

    fn write_locked(&self, _lock: &Lock, server: &str, login: &McpLogin) -> Result<()> {
        let path = self.path(server)?;
        let temporary = self
            .directory
            .join(format!(".{server}.{}.tmp", uuid::Uuid::new_v4().simple()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&temporary)?;
        let written = file
            .write_all(&serde_json::to_vec(login)?)
            .and_then(|()| file.sync_all())
            .and_then(|()| fs::rename(&temporary, &path));
        if written.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        written.context("store the MCP login")
    }

    /// Stores a new login, replacing any earlier login of the server.
    pub fn store(&self, server: &str, login: &McpLogin) -> Result<()> {
        let lock = self.lock()?;
        self.write_locked(&lock, server, login)
    }

    pub fn state(&self, server: &str, url: &str, now: i64) -> McpLoginState {
        login_state(self.read(server).ok().flatten().as_ref(), url, now)
    }

    /// Fails, naming the login command, unless the server is logged in for `url`.
    pub fn check(&self, server: &str, url: &str) -> Result<()> {
        match self.state(server, url, now_ms()) {
            McpLoginState::LoggedIn { .. } => Ok(()),
            McpLoginState::Lapsed => bail!(
                "MCP server {server}: its login lapsed; run {} on this host to log in again",
                login_command(server)
            ),
            McpLoginState::Missing => bail!(
                "MCP server {server} is not logged in on this host; run {}",
                login_command(server)
            ),
        }
    }

    /// The access token for a logged-in server: the stored one while it stays valid, else a
    /// refreshed one. `rejected` is a token the server just refused: a different stored token
    /// was refreshed meanwhile and is used, otherwise this refreshes. A refused refresh marks the
    /// login lapsed. The refresh goes only to the stored token endpoint on the server's origin
    /// and never follows a redirect.
    pub async fn access_token(
        &self,
        client: &Client,
        server: &str,
        url: &str,
        rejected: Option<&str>,
    ) -> Result<String> {
        let lock = self.lock_async().await?;
        let now = now_ms();
        let login = self.read(server)?;
        let login = match (login_state(login.as_ref(), url, now), login) {
            (McpLoginState::LoggedIn { .. }, Some(login)) => login,
            (McpLoginState::Lapsed, _) => bail!(
                "MCP server {server}: its login lapsed; run {} on this host to log in again",
                login_command(server)
            ),
            _ => bail!(
                "MCP server {server} is not logged in on this host; run {}",
                login_command(server)
            ),
        };
        if let (Some(token), Some(expires)) = (&login.access_token, login.access_token_expires_at)
            && expires > now + REFRESH_MARGIN_MS
            && rejected != Some(token.as_str())
        {
            return Ok(token.clone());
        }
        ensure!(
            safe_endpoint(&login.token_endpoint) && same_origin(&login.token_endpoint, url),
            "MCP server {server}: the stored login's token endpoint is not on the server's origin; run {}",
            login_command(server)
        );
        let mut form = vec![
            ("grant_type", "refresh_token"),
            ("refresh_token", login.refresh_token.as_str()),
            ("client_id", login.client_id.as_str()),
            ("resource", url),
        ];
        if let Some(secret) = &login.client_secret {
            form.push(("client_secret", secret));
        }
        let response = token_request(
            client,
            server,
            "token refresh",
            &login.token_endpoint,
            |request| request.form(&form),
        )
        .await?;
        // RFC 6749 section 5.2: a refused grant is 400 invalid_grant; some servers answer 401.
        if matches!(
            response.status(),
            StatusCode::BAD_REQUEST | StatusCode::UNAUTHORIZED
        ) {
            let lapsed = McpLogin {
                lapsed_at: Some(now),
                ..login
            };
            self.write_locked(&lock, server, &lapsed)?;
            bail!(
                "MCP server {server}: its login lapsed; run {} on this host to log in again",
                login_command(server)
            );
        }
        let body = token_response(server, "token refresh", response).await?;
        let token = access_token(server, &body)?;
        let refreshed = McpLogin {
            access_token: Some(token.clone()),
            ..with_tokens(login, &body, now)
        };
        self.write_locked(&lock, server, &refreshed)?;
        Ok(token)
    }
}

pub fn login_state(login: Option<&McpLogin>, url: &str, now: i64) -> McpLoginState {
    let Some(login) = login.filter(|login| login.url == url) else {
        return McpLoginState::Missing;
    };
    if login.lapsed_at.is_some()
        || login
            .refresh_token_expires_at
            .is_some_and(|expires| expires <= now)
    {
        return McpLoginState::Lapsed;
    }
    McpLoginState::LoggedIn {
        expires_at: login.refresh_token_expires_at,
    }
}

fn with_tokens(login: McpLogin, body: &Map<String, Value>, at: i64) -> McpLogin {
    let seconds = |key| {
        body.get(key)
            .and_then(Value::as_i64)
            .filter(|value| *value > 0)
    };
    McpLogin {
        refresh_token: body
            .get("refresh_token")
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty())
            .map_or(login.refresh_token, str::to_owned),
        access_token_expires_at: Some(at + seconds("expires_in").unwrap_or(300) * 1000),
        refresh_token_expires_at: seconds("refresh_token_expires_in")
            .map(|expires| at + expires * 1000)
            .or(login.refresh_token_expires_at),
        lapsed_at: None,
        ..login
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

/// HTTPS, or HTTP to a loopback host.
pub fn safe_endpoint(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
    })
}

fn same_origin(left: &str, right: &str) -> bool {
    match (Url::parse(left), Url::parse(right)) {
        (Ok(left), Ok(right)) => left.origin() == right.origin(),
        _ => false,
    }
}

pub fn token_client() -> Result<Client> {
    Ok(Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(3))
        .timeout(TOKEN_TIMEOUT)
        .build()?)
}

/// Sends one token request without following redirects: it carries a refresh token, code, or
/// client secret, and a redirect would resend it elsewhere.
async fn token_request(
    client: &Client,
    server: &str,
    what: &str,
    endpoint: &str,
    build: impl FnOnce(reqwest::RequestBuilder) -> reqwest::RequestBuilder,
) -> Result<reqwest::Response> {
    let response = build(
        client
            .post(endpoint)
            .header(reqwest::header::ACCEPT, "application/json"),
    )
    .send()
    .await
    .map_err(|_| anyhow::anyhow!("MCP server {server}: the {what} request failed"))?;
    ensure!(
        !response.status().is_redirection(),
        "MCP server {server}: the {what} request was redirected; SuperTag does not follow redirects for token requests"
    );
    Ok(response)
}

async fn token_response(
    server: &str,
    what: &str,
    response: reqwest::Response,
) -> Result<Map<String, Value>> {
    let status = response.status();
    // The body may echo submitted credentials; report the status only.
    ensure!(
        status.is_success(),
        "MCP server {server}: {what} request failed with HTTP {}",
        status.as_u16()
    );
    let bytes = response
        .bytes()
        .await
        .map_err(|_| anyhow::anyhow!("MCP server {server}: {what} response could not be read"))?;
    ensure!(
        bytes.len() <= LOGIN_BYTES as usize,
        "MCP server {server}: {what} response exceeds its limit"
    );
    match serde_json::from_slice(&bytes) {
        Ok(Value::Object(body)) => Ok(body),
        _ => bail!("MCP server {server}: {what} response is not a JSON object"),
    }
}

fn access_token(server: &str, body: &Map<String, Value>) -> Result<String> {
    let token = body
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|token| valid_token(token))
        .ok_or_else(|| {
            anyhow::anyhow!("MCP server {server}: the token response has no access_token")
        })?;
    ensure!(
        body.get("token_type").is_none_or(|kind| kind
            .as_str()
            .is_some_and(|kind| kind.eq_ignore_ascii_case("bearer"))),
        "MCP server {server}: the token response is not a bearer token"
    );
    Ok(token.to_owned())
}

/// Token values become an HTTP header, so they must be visible ASCII.
fn valid_token(token: &str) -> bool {
    !token.is_empty() && token.len() <= 8192 && token.bytes().all(|byte| (33..=126).contains(&byte))
}

/// The OAuth endpoints an MCP server's authorization server publishes.
struct Metadata {
    token_endpoint: String,
    authorization_endpoint: String,
    registration_endpoint: Option<String>,
    scopes: Vec<String>,
}

async fn metadata(client: &Client, url: Url) -> Option<Map<String, Value>> {
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let bytes = response.bytes().await.ok()?;
    if bytes.len() > LOGIN_BYTES as usize {
        return None;
    }
    match serde_json::from_slice(&bytes).ok()? {
        Value::Object(body) => Some(body),
        _ => None,
    }
}

fn well_known(origin: &Url, name: &str, path: &str) -> Option<Url> {
    let path = path.trim_end_matches('/');
    origin.join(&format!("/.well-known/{name}{path}")).ok()
}

/// RFC 9728 then RFC 8414 (or OpenID configuration). The token endpoint must be on the MCP
/// server's own origin, because it receives refresh tokens and client secrets.
async fn discover(client: &Client, server: &str, url: &str) -> Result<Metadata> {
    let resource_url = Url::parse(url)?;
    let resource = match metadata(
        client,
        well_known(
            &resource_url,
            "oauth-protected-resource",
            resource_url.path(),
        )
        .context("invalid MCP server URL")?,
    )
    .await
    {
        Some(resource) => Some(resource),
        None => {
            metadata(
                client,
                well_known(&resource_url, "oauth-protected-resource", "")
                    .context("invalid MCP server URL")?,
            )
            .await
        }
    };
    let issuer = resource
        .as_ref()
        .and_then(|resource| resource.get("authorization_servers"))
        .and_then(Value::as_array)
        .and_then(|servers| servers.iter().find_map(Value::as_str))
        .filter(|issuer| safe_endpoint(issuer))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "MCP server {server} publishes no OAuth protected resource metadata naming an authorization server"
            )
        })?;
    let issuer = Url::parse(issuer)?;
    let mut authorization = None;
    for name in ["oauth-authorization-server", "openid-configuration"] {
        if let Some(url) = well_known(&issuer, name, issuer.path())
            && let Some(found) = metadata(client, url).await
        {
            authorization = Some(found);
            break;
        }
    }
    let endpoint = |key: &str| {
        authorization
            .as_ref()
            .and_then(|metadata| metadata.get(key))
            .and_then(Value::as_str)
            .filter(|value| safe_endpoint(value))
            .map(str::to_owned)
    };
    let token_endpoint = endpoint("token_endpoint").ok_or_else(|| {
        anyhow::anyhow!("MCP server {server}: its authorization server publishes no token endpoint")
    })?;
    ensure!(
        same_origin(&token_endpoint, url),
        "MCP server {server}: its OAuth metadata names a token endpoint on another origin than the server, which SuperTag does not trust with a refresh token"
    );
    let authorization_endpoint = endpoint("authorization_endpoint").ok_or_else(|| {
        anyhow::anyhow!(
            "MCP server {server}: its authorization server publishes no authorization endpoint"
        )
    })?;
    let scopes = resource
        .as_ref()
        .and_then(|resource| resource.get("scopes_supported"))
        .and_then(Value::as_array)
        .map(|scopes| {
            scopes
                .iter()
                .filter_map(Value::as_str)
                .filter(|scope| {
                    !scope.is_empty()
                        && scope.bytes().all(|c| {
                            c == 0x21 || (0x23..=0x5b).contains(&c) || (0x5d..=0x7e).contains(&c)
                        })
                })
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    Ok(Metadata {
        token_endpoint,
        authorization_endpoint,
        registration_endpoint: endpoint("registration_endpoint"),
        scopes,
    })
}

async fn register(
    client: &Client,
    server: &str,
    endpoint: Option<&str>,
    redirect_uri: &str,
) -> Result<(String, Option<String>)> {
    let endpoint = endpoint.ok_or_else(|| {
        anyhow::anyhow!(
            "MCP server {server}: its authorization server offers no dynamic client registration, which supertag mcp login needs"
        )
    })?;
    let response = token_request(client, server, "client registration", endpoint, |request| {
        request.json(&json!({
            "client_name": "SuperTag",
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        }))
    })
    .await?;
    let body = token_response(server, "client registration", response).await?;
    let client_id = body
        .get("client_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 1024)
        .ok_or_else(|| {
            anyhow::anyhow!("MCP server {server}: client registration returned no client_id")
        })?;
    let secret = body
        .get("client_secret")
        .and_then(Value::as_str)
        .filter(|secret| !secret.is_empty())
        .map(str::to_owned);
    Ok((client_id.to_owned(), secret))
}

/// How `supertag mcp login` reaches the operator's browser.
pub struct LoginOptions<'a> {
    /// Opens the authorization URL in the system browser; the URL is printed either way.
    pub open_browser: bool,
    pub write: &'a mut (dyn FnMut(&str) + Send),
    pub timeout: Duration,
}

/// Runs the authorization flow for one server and returns the login; the caller stores it.
pub async fn run_login(server: &str, url: &str, options: LoginOptions<'_>) -> Result<McpLogin> {
    let client = token_client()?;
    let metadata = discover(&client, server, url).await?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let redirect_uri = format!(
        "http://127.0.0.1:{}{CALLBACK_PATH}",
        listener.local_addr()?.port()
    );
    let (client_id, client_secret) = register(
        &client,
        server,
        metadata.registration_endpoint.as_deref(),
        &redirect_uri,
    )
    .await?;
    let random = || {
        let mut bytes = [0u8; 32];
        bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        URL_SAFE_NO_PAD.encode(bytes)
    };
    let verifier = random();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random();
    let mut authorize = Url::parse(&metadata.authorization_endpoint)?;
    {
        let mut query = authorize.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", &client_id)
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state)
            .append_pair("resource", url);
        if !metadata.scopes.is_empty() {
            query.append_pair("scope", &metadata.scopes.join(" "));
        }
    }
    (options.write)(&format!(
        "Log in to MCP server {server} in your browser. If it does not open, visit:\n  {authorize}\n"
    ));
    if options.open_browser {
        open_browser(authorize.as_str());
    }
    let code = tokio::time::timeout(options.timeout, callback(&listener, &state))
        .await
        .map_err(|_| anyhow::anyhow!("The browser login did not finish in time"))??;
    drop(listener);
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
        ("client_id", client_id.as_str()),
        ("code_verifier", verifier.as_str()),
        ("resource", url),
    ];
    if let Some(secret) = &client_secret {
        form.push(("client_secret", secret));
    }
    let response = token_request(
        &client,
        server,
        "token",
        &metadata.token_endpoint,
        |request| request.form(&form),
    )
    .await?;
    let body = token_response(server, "token", response).await?;
    let token = access_token(server, &body)?;
    let refresh_token = body
        .get("refresh_token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "MCP server {server}: its authorization server issued no refresh token, so SuperTag cannot keep the login"
            )
        })?
        .to_owned();
    let at = now_ms();
    Ok(McpLogin {
        access_token: Some(token),
        ..with_tokens(
            McpLogin {
                url: url.to_owned(),
                token_endpoint: metadata.token_endpoint,
                client_id,
                client_secret,
                refresh_token,
                access_token: None,
                access_token_expires_at: None,
                refresh_token_expires_at: None,
                logged_in_at: at,
                lapsed_at: None,
            },
            &body,
            at,
        )
    })
}

/// Receives the authorization redirect. Only the redirect carrying this login's state finishes
/// it; any other request is refused and the wait continues.
async fn callback(listener: &TcpListener, state: &str) -> Result<String> {
    loop {
        let (stream, _) = listener.accept().await?;
        let mut stream = BufReader::new(stream);
        let mut line = String::new();
        let read = tokio::time::timeout(Duration::from_secs(5), async {
            let mut limited = (&mut stream).take(8192);
            limited.read_line(&mut line).await?;
            // Drain headers so the browser sees a complete exchange.
            let mut header = String::new();
            loop {
                header.clear();
                if limited.read_line(&mut header).await? == 0 || header == "\r\n" || header == "\n"
                {
                    break;
                }
            }
            anyhow::Ok(())
        })
        .await;
        if !matches!(read, Ok(Ok(()))) {
            continue;
        }
        let target = line
            .strip_prefix("GET ")
            .and_then(|rest| rest.split(' ').next())
            .and_then(|target| Url::parse(&format!("http://127.0.0.1{target}")).ok());
        let params = target
            .as_ref()
            .filter(|target| target.path() == CALLBACK_PATH)
            .map(|target| {
                target
                    .query_pairs()
                    .map(|(key, value)| (key.into_owned(), value.into_owned()))
                    .collect::<Vec<_>>()
            });
        let get = |params: &[(String, String)], key: &str| {
            params
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.clone())
        };
        let matched = params.as_ref().is_some_and(|params| {
            get(params, "state").is_some_and(|value| {
                Sha256::digest(value.as_bytes()) == Sha256::digest(state.as_bytes())
            })
        });
        let (status, body) = if matched {
            (
                "200 OK",
                "SuperTag received the login. You can close this window.\n",
            )
        } else if target.is_some_and(|target| target.path() == CALLBACK_PATH) {
            ("400 Bad Request", "Unknown login.\n")
        } else {
            ("404 Not Found", "")
        };
        let _ = stream
            .get_mut()
            .write_all(
                format!(
                    "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await;
        if !matched {
            continue;
        }
        let params = params.unwrap_or_default();
        if let Some(error) = get(&params, "error") {
            let error: String = error
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
                .take(64)
                .collect();
            bail!("The authorization server refused the login: {error}");
        }
        return get(&params, "code")
            .filter(|code| !code.is_empty())
            .ok_or_else(|| anyhow::anyhow!("The login redirect carried no authorization code"));
    }
}

fn open_browser(url: &str) {
    let program = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    // Best effort: the URL is already printed.
    let _ = std::process::Command::new(program)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn login(url: &str) -> McpLogin {
        McpLogin {
            url: url.into(),
            token_endpoint: format!("{url}/token"),
            client_id: "client".into(),
            client_secret: None,
            refresh_token: "refresh-1".into(),
            access_token: Some("access-1".into()),
            access_token_expires_at: Some(now_ms() + 3_600_000),
            refresh_token_expires_at: None,
            logged_in_at: now_ms(),
            lapsed_at: None,
        }
    }

    #[test]
    fn stores_each_login_owner_only_and_reports_its_state_for_its_url() {
        let root = tempfile::tempdir().unwrap();
        let store = McpLoginStore::new(root.path().join("mcp-logins"));
        assert_eq!(
            store.state("docs", "https://mcp.example.test/mcp", now_ms()),
            McpLoginState::Missing
        );
        store
            .store("docs", &login("https://mcp.example.test/mcp"))
            .unwrap();
        let mode = |path: &Path| fs::metadata(path).unwrap().mode() & 0o777;
        assert_eq!(mode(store.directory()), 0o700);
        assert_eq!(mode(&store.directory().join("docs.json")), 0o600);
        assert!(matches!(
            store.state("docs", "https://mcp.example.test/mcp", now_ms()),
            McpLoginState::LoggedIn { .. }
        ));
        // A login is for one URL only.
        assert_eq!(
            store.state("docs", "https://other.example.test/mcp", now_ms()),
            McpLoginState::Missing
        );
        let error = store
            .check("absent", "https://mcp.example.test/mcp")
            .unwrap_err();
        assert!(error.to_string().contains("supertag mcp login absent"));
        let mut lapsed = login("https://mcp.example.test/mcp");
        lapsed.lapsed_at = Some(now_ms());
        store.store("docs", &lapsed).unwrap();
        assert_eq!(
            store.state("docs", "https://mcp.example.test/mcp", now_ms()),
            McpLoginState::Lapsed
        );
        fs::set_permissions(
            store.directory().join("docs.json"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert!(store.read("docs").is_err());
    }

    #[tokio::test]
    async fn refreshes_an_expired_token_once_keeps_rotation_and_marks_a_refusal_lapsed() {
        use crate::mcp::test_http::serve;
        let root = tempfile::tempdir().unwrap();
        let store = McpLoginStore::new(root.path().join("mcp-logins"));
        let (address, served) = serve(vec![
            (
                200,
                "application/json",
                json!({"access_token":"access-2","token_type":"Bearer","expires_in":3600,"refresh_token":"refresh-2"}).to_string(),
            ),
            (400, "application/json", json!({"error":"invalid_grant"}).to_string()),
        ])
        .await;
        let url = format!("http://127.0.0.1:{}/mcp", address.port());
        let mut stored = login(&url);
        stored.token_endpoint = format!("http://127.0.0.1:{}/token", address.port());
        store.store("docs", &stored).unwrap();
        let client = token_client().unwrap();
        // A valid token needs no refresh.
        assert_eq!(
            store
                .access_token(&client, "docs", &url, None)
                .await
                .unwrap(),
            "access-1"
        );
        // The server refused it: refresh, and keep the rotated refresh token.
        assert_eq!(
            store
                .access_token(&client, "docs", &url, Some("access-1"))
                .await
                .unwrap(),
            "access-2"
        );
        let rotated = store.read("docs").unwrap().unwrap();
        assert_eq!(rotated.refresh_token, "refresh-2");
        assert_eq!(rotated.access_token.as_deref(), Some("access-2"));
        // Another caller that saw access-1 refused uses the token already refreshed.
        assert_eq!(
            store
                .access_token(&client, "docs", &url, Some("access-1"))
                .await
                .unwrap(),
            "access-2"
        );
        let error = store
            .access_token(&client, "docs", &url, Some("access-2"))
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("login lapsed") && error.contains("supertag mcp login docs"));
        assert_eq!(store.state("docs", &url, now_ms()), McpLoginState::Lapsed);
        let requests = served.await.unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].body.contains("grant_type=refresh_token"));
        assert!(requests[0].body.contains("refresh_token=refresh-1"));
        assert!(requests[1].body.contains("refresh_token=refresh-2"));
    }

    #[tokio::test]
    async fn never_refreshes_at_another_origin_or_follows_a_redirect() {
        use crate::mcp::test_http::serve;
        let root = tempfile::tempdir().unwrap();
        let store = McpLoginStore::new(root.path().join("mcp-logins"));
        let client = token_client().unwrap();
        let mut stored = login("https://mcp.example.test/mcp");
        stored.token_endpoint = "https://auth.example.test/token".into();
        stored.access_token_expires_at = Some(0);
        store.store("docs", &stored).unwrap();
        assert!(
            store
                .access_token(&client, "docs", "https://mcp.example.test/mcp", None)
                .await
                .unwrap_err()
                .to_string()
                .contains("not on the server's origin")
        );
        let (address, served) = serve(vec![(307, "text/plain", String::new())]).await;
        let url = format!("http://127.0.0.1:{}/mcp", address.port());
        let mut stored = login(&url);
        stored.token_endpoint = format!("http://127.0.0.1:{}/token", address.port());
        stored.access_token_expires_at = Some(0);
        store.store("docs", &stored).unwrap();
        assert!(
            store
                .access_token(&client, "docs", &url, None)
                .await
                .unwrap_err()
                .to_string()
                .contains("redirected")
        );
        assert_eq!(served.await.unwrap().len(), 1);
        // A redirect is not a refusal: the login stays usable.
        assert!(matches!(
            store.state("docs", &url, now_ms()),
            McpLoginState::LoggedIn { .. }
        ));
    }

    #[test]
    fn token_endpoints_must_be_safe_and_on_the_server_origin() {
        assert!(safe_endpoint("https://auth.example.test/token"));
        assert!(safe_endpoint("http://127.0.0.1:9/token"));
        assert!(!safe_endpoint("http://auth.example.test/token"));
        assert!(same_origin(
            "https://mcp.example.test/token",
            "https://mcp.example.test/mcp"
        ));
        assert!(!same_origin(
            "https://auth.example.test/token",
            "https://mcp.example.test/mcp"
        ));
    }
}
