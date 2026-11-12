//! GitHub App credentials remain in Gateway memory. Tokens never enter delivery journals.
use super::{DELIVERY_TIMEOUT, valid_id};
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
    App {
        app_id: u64,
        installation_id: u64,
        key: Box<RsaKeyPair>,
    },
}

pub(super) struct Authentication {
    credential: Credential,
    repository_id: u64,
    repository: String,
    cached: Mutex<Option<CachedToken>>,
    scope: TokenScope,
}

#[derive(Clone, Copy)]
enum TokenScope {
    Comments,
    SourceRead,
}
impl TokenScope {
    fn permission(self) -> (&'static str, &'static str) {
        match self {
            Self::Comments => ("issues", "write"),
            Self::SourceRead => ("contents", "read"),
        }
    }
}

struct CachedToken {
    value: String,
    expires_at: i64,
    refresh_after: Instant,
    api_origin: String,
}

/// Intentionally has neither Debug nor Serialize.
pub(super) struct AccessToken(String);
impl AccessToken {
    pub(super) fn expose(&self) -> &str {
        &self.0
    }
}

const MAX_TOKEN_BYTES: usize = 16 * 1024;
const MAX_RESPONSE_BYTES: usize = 128 * 1024;
const REFRESH_MARGIN: i64 = 60;

impl Authentication {
    pub(super) fn new(
        configuration: &GithubAuthentication,
        repository_id: u64,
        repository: &str,
    ) -> Result<Self> {
        let credential = match configuration {
            GithubAuthentication::Token(value) => {
                ensure!(valid_token(value), "invalid GitHub token");
                Credential::Token(value.clone())
            }
            GithubAuthentication::App(app) => {
                ensure!(
                    valid_id(app.app_id) && valid_id(app.installation_id),
                    "invalid GitHub App or installation ID"
                );
                ensure!(
                    app.private_key_pem.len() <= 32 * 1024,
                    "GitHub App private key is too large"
                );
                let key = match PrivateKeyDer::from_pem_slice(app.private_key_pem.as_bytes())
                    .map_err(|_| anyhow!("invalid GitHub App private key PEM"))?
                {
                    PrivateKeyDer::Pkcs1(key) => RsaKeyPair::from_der(key.secret_pkcs1_der()),
                    PrivateKeyDer::Pkcs8(key) => RsaKeyPair::from_pkcs8(key.secret_pkcs8_der()),
                    _ => return Err(anyhow!("GitHub App requires an RSA private key")),
                }
                .map_err(|_| {
                    anyhow!("GitHub App requires a valid RSA private key of at least 2048 bits")
                })?;
                ensure!(
                    key.public().modulus_len() <= 1024,
                    "GitHub App RSA private key is too large"
                );
                Credential::App {
                    app_id: app.app_id,
                    installation_id: app.installation_id,
                    key: Box::new(key),
                }
            }
        };
        Ok(Self {
            credential,
            repository_id,
            repository: repository.into(),
            cached: Mutex::new(None),
            scope: TokenScope::Comments,
        })
    }

    pub(super) fn source_reader(
        configuration: &GithubAuthentication,
        repository_id: u64,
        repository: &str,
    ) -> Result<Self> {
        let mut value = Self::new(configuration, repository_id, repository)?;
        value.scope = TokenScope::SourceRead;
        Ok(value)
    }

    pub(super) async fn access_token(&self, client: &Client, api: &Url) -> Result<AccessToken> {
        self.access_token_at(client, api, now()?).await
    }

    async fn access_token_at(&self, client: &Client, api: &Url, now: i64) -> Result<AccessToken> {
        let Credential::App {
            app_id,
            installation_id,
            key,
        } = &self.credential
        else {
            let Credential::Token(value) = &self.credential else {
                unreachable!()
            };
            return Ok(AccessToken(value.clone()));
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
        let jwt = app_jwt(key, *app_id, now)?;
        let installation_url = api.join(&format!("repos/{}/installation", self.repository))?;
        let response = client
            .get(installation_url)
            .bearer_auth(&jwt)
            .headers(headers())
            .send()
            .await
            .map_err(|_| anyhow!("GitHub installation validation unavailable"))?;
        let installation = response_json(response, StatusCode::OK).await?;
        ensure!(
            installation.get("id").and_then(Value::as_u64) == Some(*installation_id)
                && installation.get("app_id").and_then(Value::as_u64) == Some(*app_id)
                && installation.get("suspended_at").is_some_and(Value::is_null),
            "GitHub repository installation does not match the configured App"
        );
        let owner = self.repository.split('/').next().unwrap_or_default();
        ensure!(
            installation
                .pointer("/account/login")
                .and_then(Value::as_str)
                .is_some_and(|login| login.eq_ignore_ascii_case(owner)),
            "GitHub installation owner does not match the repository"
        );
        let target = api.join(&format!(
            "app/installations/{installation_id}/access_tokens"
        ))?;
        let (permission, access) = self.scope.permission();
        let response = client
            .post(target)
            .bearer_auth(&jwt)
            .headers(headers())
            .json(&json!({"repository_ids":[self.repository_id],"permissions":{permission:access}}))
            .send()
            .await
            .map_err(|_| anyhow!("GitHub installation token acquisition unavailable"))?;
        let value = response_json(response, StatusCode::CREATED).await?;
        let token = validate_scoped_token_response(
            &value,
            self.repository_id,
            &self.repository,
            now,
            self.scope,
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

    pub(super) async fn invalidate(&self) {
        *self.cached.lock().await = None;
    }
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

fn validate_scoped_token_response<'a>(
    value: &'a Value,
    repository_id: u64,
    repository: &str,
    now: i64,
    scope: TokenScope,
) -> Result<&'a str> {
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
        expiry > now.saturating_add(REFRESH_MARGIN + DELIVERY_TIMEOUT.as_secs() as i64)
            && expiry <= now.saturating_add(3600 + 60),
        "GitHub installation token expiry is outside its bounds"
    );
    let permissions = value
        .get("permissions")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("GitHub installation token has no permission scope"))?;
    let (permission, access) = scope.permission();
    ensure!(
        permissions.get(permission).and_then(Value::as_str) == Some(access)
            && permissions.iter().all(|(key, value)| (key == permission
                && value.as_str() == Some(access))
                || (key == "metadata" && value.as_str() == Some("read"))),
        "GitHub installation token permissions exceed the requested scope"
    );
    let repositories = value
        .get("repositories")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("GitHub installation token has no repository scope"))?;
    ensure!(
        value.get("repository_selection").and_then(Value::as_str) == Some("selected")
            && repositories.len() == 1
            && repositories[0].get("id").and_then(Value::as_u64) == Some(repository_id)
            && repositories[0]
                .get("full_name")
                .and_then(Value::as_str)
                .is_some_and(|name| name.eq_ignore_ascii_case(repository)),
        "GitHub installation token repository scope does not match"
    );
    Ok(token)
}

fn headers() -> reqwest::header::HeaderMap {
    use reqwest::header::{ACCEPT, HeaderMap, HeaderValue, USER_AGENT};
    HeaderMap::from_iter([
        (
            ACCEPT,
            HeaderValue::from_static("application/vnd.github+json"),
        ),
        (USER_AGENT, HeaderValue::from_static("supertag-gateway")),
        (
            reqwest::header::HeaderName::from_static("x-github-api-version"),
            HeaderValue::from_static("2022-11-28"),
        ),
    ])
}

async fn response_json(mut response: reqwest::Response, expected: StatusCode) -> Result<Value> {
    ensure!(
        response.status() == expected,
        "GitHub authentication request was not accepted"
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

fn now() -> Result<i64> {
    i64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
        .map_err(|_| anyhow!("invalid GitHub App clock"))
}

#[cfg(test)]
mod tests;
