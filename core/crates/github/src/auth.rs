//! GitHub App credentials remain in process memory. Tokens are never persisted.
//!
//! Every installation token is minted for one repository with only the permissions one use
//! needs, and the response is checked to be scoped exactly as asked.
use crate::{REQUEST_TIMEOUT, valid_id};
use anyhow::{Result, anyhow, ensure};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::DateTime;
use reqwest::{Client, StatusCode, Url};
use ring::{
    rand::SystemRandom,
    signature::{RSA_PKCS1_SHA256, RsaKeyPair},
};
use rustls_pki_types::{PrivateKeyDer, pem::PemObject as _};
use serde_json::{Value, json};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

#[derive(Clone)]
pub enum GithubAuthentication {
    Token(String),
    App(GithubAppConfig),
}

#[derive(Clone)]
pub struct GithubAppConfig {
    pub app_id: u64,
    pub installation_id: u64,
    /// Already read from the configured private credential file. Never serialized or logged.
    pub private_key_pem: String,
}

enum Credential {
    Token(String),
    App(GithubApp),
}

/// The Gateway's GitHub connector authentication for its one repository.
pub struct Authentication {
    credential: Credential,
    repository_id: u64,
    repository: String,
    cached: Mutex<Option<CachedToken>>,
}

/// What the Gateway's GitHub connector may do: comment on issues and pull requests.
const COMMENTS: &[(&str, &str)] = &[("issues", "write")];

struct CachedToken {
    value: String,
    expires_at: i64,
    refresh_after: Instant,
    api_origin: String,
}

/// Intentionally has neither Debug nor Serialize.
pub struct AccessToken(String);
impl AccessToken {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

const MAX_TOKEN_BYTES: usize = 16 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 128 * 1024;
const REFRESH_MARGIN: i64 = 60;

/// A GitHub App installation that mints tokens for any repository it covers. Intentionally has
/// neither Debug nor Serialize: it holds the App's private key.
pub struct GithubApp {
    app_id: u64,
    installation_id: u64,
    key: RsaKeyPair,
}

/// An installation token for one repository, and that repository's numeric ID as GitHub
/// reported it with the token.
pub struct RepositoryToken {
    pub token: AccessToken,
    pub repository_id: u64,
}

impl GithubApp {
    pub fn new(config: &GithubAppConfig) -> Result<Self> {
        ensure!(
            valid_id(config.app_id) && valid_id(config.installation_id),
            "invalid GitHub App or installation ID"
        );
        Ok(Self {
            app_id: config.app_id,
            installation_id: config.installation_id,
            key: rsa_key(&config.private_key_pem)?,
        })
    }

    /// Mints a token for `repository` (`OWNER/NAME`) with exactly `permissions`, such as
    /// `[("contents", "write")]`. The installation must be this App's, not suspended, and owned by
    /// the repository's owner. The token is never cached: each operation mints its own.
    pub async fn repository_token(
        &self,
        client: &Client,
        api: &Url,
        repository: &str,
        permissions: &[(&str, &str)],
    ) -> Result<RepositoryToken> {
        ensure!(
            crate::valid_repository(repository),
            "invalid GitHub repository {repository}"
        );
        let now = now()?;
        let jwt = app_jwt(&self.key, self.app_id, now)?;
        check_installation(
            client,
            api,
            &jwt,
            self.app_id,
            self.installation_id,
            repository,
        )
        .await?;
        let name = repository.split_once('/').map_or("", |(_, name)| name);
        let value = mint(
            client,
            api,
            &jwt,
            self.installation_id,
            json!({"repositories":[name],"permissions":permission_map(permissions)}),
        )
        .await?;
        let (token, repository_id) =
            validate_scoped_token_response(&value, None, repository, now, permissions)?;
        Ok(RepositoryToken {
            token: AccessToken(token.to_owned()),
            repository_id,
        })
    }
}

impl Authentication {
    pub fn new(
        configuration: &GithubAuthentication,
        repository_id: u64,
        repository: &str,
    ) -> Result<Self> {
        let credential = match configuration {
            GithubAuthentication::Token(value) => {
                ensure!(valid_token(value), "invalid GitHub token");
                Credential::Token(value.clone())
            }
            GithubAuthentication::App(app) => Credential::App(GithubApp::new(app)?),
        };
        Ok(Self {
            credential,
            repository_id,
            repository: repository.into(),
            cached: Mutex::new(None),
        })
    }

    pub async fn access_token(&self, client: &Client, api: &Url) -> Result<AccessToken> {
        self.access_token_at(client, api, now()?).await
    }

    /// A token as at `now`, Unix seconds, for tests of expiry and reuse.
    #[cfg(feature = "test-fixtures")]
    pub async fn access_token_at_for_test(
        &self,
        client: &Client,
        api: &Url,
        now: i64,
    ) -> Result<AccessToken> {
        self.access_token_at(client, api, now).await
    }

    async fn access_token_at(&self, client: &Client, api: &Url, now: i64) -> Result<AccessToken> {
        let app = match &self.credential {
            Credential::Token(value) => return Ok(AccessToken(value.clone())),
            Credential::App(app) => app,
        };
        let mut cached = self.cached.lock().await;
        if let Some(token) = cached.as_ref()
            && token.api_origin == api.as_str()
            && now.saturating_add(REFRESH_MARGIN) < token.expires_at
            && Instant::now() < token.refresh_after
        {
            return Ok(AccessToken(token.value.clone()));
        }
        *cached = None;
        let jwt = app_jwt(&app.key, app.app_id, now)?;
        check_installation(
            client,
            api,
            &jwt,
            app.app_id,
            app.installation_id,
            &self.repository,
        )
        .await?;
        let value = mint(
            client,
            api,
            &jwt,
            app.installation_id,
            json!({"repository_ids":[self.repository_id],"permissions":permission_map(COMMENTS)}),
        )
        .await?;
        let (token, _) = validate_scoped_token_response(
            &value,
            Some(self.repository_id),
            &self.repository,
            now,
            COMMENTS,
        )?;
        let expires_at =
            DateTime::parse_from_rfc3339(value["expires_at"].as_str().unwrap_or_default())
                .map_err(|_| anyhow!("invalid GitHub installation token expiry"))?
                .timestamp();
        let usable_for = expires_at - now - REFRESH_MARGIN;
        let token = CachedToken {
            value: token.into(),
            expires_at,
            refresh_after: Instant::now() + Duration::from_secs(usable_for as u64),
            api_origin: api.as_str().into(),
        };
        let result = AccessToken(token.value.clone());
        *cached = Some(token);
        Ok(result)
    }

    pub async fn invalidate(&self) {
        *self.cached.lock().await = None;
    }
}

fn permission_map(permissions: &[(&str, &str)]) -> serde_json::Map<String, Value> {
    permissions
        .iter()
        .map(|(key, value)| (key.to_string(), Value::String(value.to_string())))
        .collect()
}

/// Asks GitHub which installation covers `repository`, and refuses unless it is this App's
/// configured, unsuspended installation on the repository's owner.
async fn check_installation(
    client: &Client,
    api: &Url,
    jwt: &str,
    app_id: u64,
    installation_id: u64,
    repository: &str,
) -> Result<()> {
    let installation_url = api.join(&format!("repos/{repository}/installation"))?;
    let response = client
        .get(installation_url)
        .bearer_auth(jwt)
        .headers(headers())
        .send()
        .await
        .map_err(|_| anyhow!("GitHub installation validation unavailable"))?;
    let installation = response_json(response, StatusCode::OK).await?;
    ensure!(
        installation.get("id").and_then(Value::as_u64) == Some(installation_id)
            && installation.get("app_id").and_then(Value::as_u64) == Some(app_id)
            && installation.get("suspended_at").is_some_and(Value::is_null),
        "GitHub repository installation does not match the configured App"
    );
    let owner = repository.split('/').next().unwrap_or_default();
    ensure!(
        installation
            .pointer("/account/login")
            .and_then(Value::as_str)
            .is_some_and(|login| login.eq_ignore_ascii_case(owner)),
        "GitHub installation owner does not match the repository"
    );
    Ok(())
}

async fn mint(
    client: &Client,
    api: &Url,
    jwt: &str,
    installation_id: u64,
    body: Value,
) -> Result<Value> {
    let target = api.join(&format!(
        "app/installations/{installation_id}/access_tokens"
    ))?;
    let response = client
        .post(target)
        .bearer_auth(jwt)
        .headers(headers())
        .json(&body)
        .send()
        .await
        .map_err(|_| anyhow!("GitHub installation token acquisition unavailable"))?;
    response_json(response, StatusCode::CREATED).await
}

fn rsa_key(pem: &str) -> Result<RsaKeyPair> {
    ensure!(
        pem.len() <= 32 * 1024,
        "GitHub App private key is too large"
    );
    let key = match PrivateKeyDer::from_pem_slice(pem.as_bytes())
        .map_err(|_| anyhow!("invalid GitHub App private key PEM"))?
    {
        PrivateKeyDer::Pkcs1(key) => RsaKeyPair::from_der(key.secret_pkcs1_der()),
        PrivateKeyDer::Pkcs8(key) => RsaKeyPair::from_pkcs8(key.secret_pkcs8_der()),
        _ => return Err(anyhow!("GitHub App requires an RSA private key")),
    }
    .map_err(|_| anyhow!("GitHub App requires a valid RSA private key of at least 2048 bits"))?;
    ensure!(
        key.public().modulus_len() <= 1024,
        "GitHub App RSA private key is too large"
    );
    Ok(key)
}

/// A short-lived App JWT, for verifying an App's key and installation during setup.
pub fn setup_app_jwt(private_key_pem: &str, app_id: u64) -> Result<String> {
    ensure!(valid_id(app_id), "invalid GitHub App ID");
    app_jwt(&rsa_key(private_key_pem)?, app_id, now()?)
}

fn app_jwt(key: &RsaKeyPair, app_id: u64, now: i64) -> Result<String> {
    ensure!(
        (60..i64::MAX - 600).contains(&now),
        "invalid GitHub App signing time"
    );
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
    let claims = URL_SAFE_NO_PAD.encode(serde_json::to_vec(
        &json!({"iat":now-60,"exp":now+540,"iss":app_id.to_string()}),
    )?);
    let message = format!("{header}.{claims}");
    let mut signature = vec![0; key.public().modulus_len()];
    key.sign(
        &RSA_PKCS1_SHA256,
        &SystemRandom::new(),
        message.as_bytes(),
        &mut signature,
    )
    .map_err(|_| anyhow!("GitHub App signing failed"))?;
    Ok(format!("{message}.{}", URL_SAFE_NO_PAD.encode(signature)))
}

fn valid_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_TOKEN_BYTES
        && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

/// The token of a mint response scoped to exactly one repository (`repository_id` when known)
/// and exactly `required` permissions (plus `metadata: read`, which GitHub always adds), and
/// that repository's ID.
fn validate_scoped_token_response<'a>(
    value: &'a Value,
    repository_id: Option<u64>,
    repository: &str,
    now: i64,
    required: &[(&str, &str)],
) -> Result<(&'a str, u64)> {
    let token = value
        .get("token")
        .and_then(Value::as_str)
        .filter(|token| valid_token(token))
        .ok_or_else(|| anyhow!("invalid GitHub installation token response"))?;
    let expiry = value
        .get("expires_at")
        .and_then(Value::as_str)
        .and_then(|expiry| DateTime::parse_from_rfc3339(expiry).ok())
        .map(|expiry| expiry.timestamp())
        .ok_or_else(|| anyhow!("invalid GitHub installation token expiry"))?;
    ensure!(
        expiry > now.saturating_add(REFRESH_MARGIN + REQUEST_TIMEOUT.as_secs() as i64)
            && expiry <= now.saturating_add(3600 + 60),
        "GitHub installation token expiry is outside its bounds"
    );
    let permissions = value
        .get("permissions")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("GitHub installation token has no permission scope"))?;
    ensure!(
        required
            .iter()
            .all(|(key, access)| permissions.get(*key).and_then(Value::as_str) == Some(*access))
            && permissions.iter().all(|(key, value)| required
                .iter()
                .any(|(required, access)| key == required && value.as_str() == Some(*access))
                || (key == "metadata" && value.as_str() == Some("read"))),
        "GitHub installation token permissions exceed the requested scope"
    );
    let repositories = value
        .get("repositories")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("GitHub installation token has no repository scope"))?;
    let scoped = repositories
        .first()
        .and_then(|entry| entry.get("id"))
        .and_then(Value::as_u64)
        .filter(|id| valid_id(*id));
    ensure!(
        value.get("repository_selection").and_then(Value::as_str) == Some("selected")
            && repositories.len() == 1
            && scoped.is_some()
            && repository_id.is_none_or(|id| scoped == Some(id))
            && repositories[0]
                .get("full_name")
                .and_then(Value::as_str)
                .is_some_and(|name| name.eq_ignore_ascii_case(repository)),
        "GitHub installation token repository scope does not match"
    );
    Ok((token, scoped.unwrap_or_default()))
}

fn headers() -> reqwest::header::HeaderMap {
    use reqwest::header::{ACCEPT, HeaderMap, HeaderValue, USER_AGENT};
    HeaderMap::from_iter([
        (
            ACCEPT,
            HeaderValue::from_static("application/vnd.github+json"),
        ),
        (USER_AGENT, HeaderValue::from_static("supertag")),
        (
            reqwest::header::HeaderName::from_static("x-github-api-version"),
            HeaderValue::from_static("2022-11-28"),
        ),
    ])
}

async fn response_json(mut response: reqwest::Response, expected: StatusCode) -> Result<Value> {
    ensure!(
        response.status() == expected,
        "GitHub authentication request was not accepted (HTTP {})",
        response.status().as_u16()
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow!("GitHub authentication response interrupted"))?
    {
        ensure!(
            chunk.len() <= MAX_RESPONSE_BYTES - bytes.len(),
            "GitHub authentication response is too large"
        );
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| anyhow!("invalid GitHub authentication response"))
}

/// The current time in Unix seconds.
pub fn now() -> Result<i64> {
    i64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
        .map_err(|_| anyhow!("invalid GitHub App clock"))
}
