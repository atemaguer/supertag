//! Host MCP authentication forms that mint credentials at run time, beside `headerEnv` (fixed
//! headers) and `"oauth": true` (this host's `supertag mcp login`):
//!
//! - `clientCredentials`: an OAuth client-credentials grant, authenticated with a client secret
//!   or a signed JWT client assertion (RFC 7523), for the server as `resource`.
//! - `githubApp`: a GitHub App installation token, minted with an App JWT.
//! - `helper`: a host command that prints a JSON object of header names to values.
//! - `"oauth": {"refreshTokenEnv": VAR}`: a refresh token from a Worker Host variable, such as
//!   the value `supertag mcp login NAME --export` prints on a machine with a browser.
//!
//! Every value is read from a Worker Host variable when the catalog loads, so a missing or
//! malformed credential refuses the start. Tokens are minted for each Task Attempt and again when
//! the server refuses one (401 or 403). Token requests never follow a redirect, and a token
//! endpoint the server's metadata advertises is trusted only on the server's own origin; another
//! origin must be configured as `tokenUrl`. Messages name servers and variables, never values.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use reqwest::{
    Client, Url,
    header::{HeaderMap, HeaderName, HeaderValue},
};
use ring::{
    rand::SystemRandom,
    signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, RSA_PKCS1_SHA256, RsaKeyPair},
};
use rustls_pki_types::{PrivateKeyDer, pem::PemObject as _};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{io::AsyncReadExt, process::Command, sync::Mutex, time};

use super::{
    catalog::{TRACKED_ENV_VALUE_BYTES, valid_header},
    oauth::{
        access_token, discover_token_endpoint, now_ms, safe_endpoint, token_request,
        token_response, valid_token,
    },
};

const HELPER_TIMEOUT: Duration = Duration::from_secs(15);
const HELPER_OUTPUT_BYTES: usize = 64 * 1024;
const KEY_BYTES: usize = 32 * 1024;
const VALUE_BYTES: usize = 8 * 1024;
const REFRESH_MARGIN_MS: i64 = 60_000;
pub(super) const GITHUB_API: &str = "https://api.github.com";

/// `"oauth"`: `true` for this host's `supertag mcp login`, or a refresh token from a variable.
#[derive(Deserialize)]
#[serde(untagged)]
pub(super) enum OAuthConfig {
    Login(bool),
    RefreshToken(RefreshTokenConfig),
}

impl Default for OAuthConfig {
    fn default() -> Self {
        Self::Login(false)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RefreshTokenConfig {
    refresh_token_env: String,
    token_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ClientCredentialsConfig {
    client_id: Option<String>,
    client_id_env: Option<String>,
    client_secret_env: Option<String>,
    assertion_key_env: Option<String>,
    scope: Option<String>,
    token_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct GithubAppConfig {
    app_id: u64,
    installation_id: u64,
    private_key_env: String,
}

/// The authentication fields of one catalog server.
pub(super) struct AuthConfig<'a> {
    pub(super) name: &'a str,
    pub(super) oauth: &'a OAuthConfig,
    pub(super) client_credentials: Option<&'a ClientCredentialsConfig>,
    pub(super) github_app: Option<&'a GithubAppConfig>,
    pub(super) helper: Option<&'a [String]>,
}

impl AuthConfig<'_> {
    fn forms(&self) -> usize {
        usize::from(!matches!(self.oauth, OAuthConfig::Login(false)))
            + usize::from(self.client_credentials.is_some())
            + usize::from(self.github_app.is_some())
            + usize::from(self.helper.is_some())
    }

    pub(super) fn oauth_login(&self) -> bool {
        matches!(self.oauth, OAuthConfig::Login(true))
    }

    /// Whether any form supplies headers itself, so `headerEnv` must not set Authorization.
    pub(super) fn any(&self) -> bool {
        self.forms() > 0
    }

    /// The name `supertag mcp list` shows for a minted form.
    pub(super) fn label(&self) -> Option<&'static str> {
        if self.client_credentials.is_some() {
            Some("clientCredentials")
        } else if self.github_app.is_some() {
            Some("githubApp")
        } else if self.helper.is_some() {
            Some("helper")
        } else if matches!(self.oauth, OAuthConfig::RefreshToken(_)) {
            Some("oauth refresh token")
        } else {
            None
        }
    }

    /// The Worker Host variables a minted form reads.
    pub(super) fn variables(&self) -> Vec<String> {
        let mut variables = Vec::new();
        if let OAuthConfig::RefreshToken(config) = self.oauth {
            variables.push(config.refresh_token_env.clone());
        }
        if let Some(config) = self.client_credentials {
            variables.extend(
                [
                    &config.client_id_env,
                    &config.client_secret_env,
                    &config.assertion_key_env,
                ]
                .into_iter()
                .flatten()
                .cloned(),
            );
        }
        if let Some(config) = self.github_app {
            variables.push(config.private_key_env.clone());
        }
        variables
    }

    /// What the server's provider binding names: the form and its public settings, and a
    /// digest of each credential, so a changed credential is a different binding. A refresh
    /// token rotates, so its binding names only the form.
    pub(super) fn identity(&self, environment: &impl Fn(&str) -> Option<String>) -> Value {
        use sha2::{Digest, Sha256};
        let digest = |variable: &Option<String>| {
            variable
                .as_deref()
                .and_then(environment)
                .map(|value| format!("{:x}", Sha256::digest(value.trim().as_bytes())))
        };
        json!({
            "oauthRefreshToken": match self.oauth {
                OAuthConfig::RefreshToken(config) => Some(json!({"tokenUrl": config.token_url})),
                OAuthConfig::Login(_) => None,
            },
            "clientCredentials": self.client_credentials.map(|config| json!({
                "clientId": config.client_id,
                "clientIdEnv": digest(&config.client_id_env),
                "clientSecret": digest(&config.client_secret_env),
                "assertionKey": digest(&config.assertion_key_env),
                "scope": config.scope,
                "tokenUrl": config.token_url,
            })),
            "githubApp": self.github_app.map(|config| json!({
                "appId": config.app_id,
                "installationId": config.installation_id,
                "privateKey": digest(&Some(config.private_key_env.clone())),
            })),
            "helper": self.helper,
        })
    }
}

/// A minted form, resolved when the catalog loads.
pub(super) struct MintedAuth {
    server: String,
    /// The server's URL as configured: the RFC 8707 resource indicator, sent exactly.
    resource: String,
    form: Form,
    /// The token endpoint discovered from the server's metadata, once.
    discovered: Mutex<Option<String>>,
}

enum Form {
    ClientCredentials {
        client_id: String,
        credential: ClientCredential,
        scope: Option<String>,
        token_url: Option<String>,
    },
    GithubApp {
        app_id: u64,
        installation_id: u64,
        key: SigningKey,
    },
    Helper {
        command: Vec<String>,
    },
    RefreshToken {
        stored: StoredRefreshToken,
        token_url: Option<String>,
        state: Mutex<RefreshState>,
    },
}

enum ClientCredential {
    Secret(String),
    Assertion(Box<SigningKey>),
}

/// A refresh token value: the token itself, or the JSON object `supertag mcp login --export`
/// prints, which also names the client. A token endpoint is never read from it.
struct StoredRefreshToken {
    refresh_token: String,
    client_id: Option<String>,
    client_secret: Option<String>,
}

#[derive(Default)]
struct RefreshState {
    access: Option<(String, i64)>,
    /// A refresh token the authorization server rotated to, kept in memory.
    rotated: Option<String>,
}

/// Headers for one request and every credential they or their minting revealed.
pub(super) struct Minted {
    pub(super) headers: HeaderMap,
    pub(super) secrets: Vec<String>,
}

/// Resolves the server's minted form, if any, adding each credential to `secrets`.
pub(super) fn resolve(
    config: &AuthConfig<'_>,
    resource: &str,
    environment: &impl Fn(&str) -> Option<String>,
    secrets: &mut BTreeSet<String>,
) -> Result<Option<MintedAuth>> {
    let name = config.name;
    ensure!(
        config.forms() <= 1,
        "MCP server {name}: choose one of oauth, clientCredentials, githubApp, or helper"
    );
    // A value shorter than TRACKED_ENV_VALUE_BYTES is too short to recognize: withholding it
    // would drop every tool output that happens to contain it. A client ID is public.
    let mut read = |field: &str, variable: &str, limit: usize, secret: bool| -> Result<String> {
        ensure!(
            valid_variable(variable),
            "MCP server {name}: {field} must name a Worker Host variable not named SUPERTAG_*"
        );
        let value = environment(variable)
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .with_context(|| {
                format!("MCP server {name} {field} reads {variable}, which is not set on this Worker Host")
            })?;
        ensure!(
            value.len() <= limit && !value.contains('\0'),
            "MCP server {name} {field} reads {variable}, whose value is too long"
        );
        if secret && value.len() >= TRACKED_ENV_VALUE_BYTES {
            secrets.insert(value.clone());
        }
        Ok(value)
    };
    let form = if let Some(config) = config.client_credentials {
        let token_url = token_url(name, config.token_url.as_deref())?;
        let client_id = match (&config.client_id, &config.client_id_env) {
            (Some(id), None) if !id.trim().is_empty() && id.len() <= 1024 => id.trim().to_owned(),
            (None, Some(variable)) => read("clientCredentials.clientIdEnv", variable, 1024, false)?,
            _ => bail!(
                "MCP server {name}: clientCredentials needs exactly one of clientId or clientIdEnv"
            ),
        };
        let credential = match (&config.client_secret_env, &config.assertion_key_env) {
            (Some(variable), None) => ClientCredential::Secret(read(
                "clientCredentials.clientSecretEnv",
                variable,
                VALUE_BYTES,
                true,
            )?),
            (None, Some(variable)) => ClientCredential::Assertion(Box::new(signing_key(
                name,
                "clientCredentials.assertionKeyEnv",
                &read(
                    "clientCredentials.assertionKeyEnv",
                    variable,
                    KEY_BYTES,
                    true,
                )?,
            )?)),
            _ => bail!(
                "MCP server {name}: clientCredentials needs exactly one of clientSecretEnv or assertionKeyEnv"
            ),
        };
        let scope = match &config.scope {
            None => None,
            Some(scope) => {
                let scope = scope.trim();
                ensure!(
                    !scope.is_empty()
                        && scope.len() <= 1024
                        && scope
                            .bytes()
                            .all(|byte| byte == b' ' || byte.is_ascii_graphic()),
                    "MCP server {name}: clientCredentials.scope must be a space-separated list of scopes"
                );
                Some(scope.to_owned())
            }
        };
        Form::ClientCredentials {
            client_id,
            credential,
            scope,
            token_url,
        }
    } else if let Some(config) = config.github_app {
        ensure!(
            config.app_id > 0 && config.installation_id > 0,
            "MCP server {name}: githubApp needs the App's numeric appId and the installation's numeric installationId"
        );
        let pem = read(
            "githubApp.privateKeyEnv",
            &config.private_key_env,
            KEY_BYTES,
            true,
        )?;
        Form::GithubApp {
            app_id: config.app_id,
            installation_id: config.installation_id,
            key: signing_key(name, "githubApp.privateKeyEnv", &pem)?,
        }
    } else if let Some(command) = config.helper {
        ensure!(
            !command.is_empty()
                && command.len() <= 64
                && command
                    .iter()
                    .all(|part| !part.is_empty() && part.len() <= 4096 && !part.contains('\0')),
            "MCP server {name}: helper must list a command and its arguments"
        );
        ensure!(
            executable(&command[0]),
            "MCP server {name} helper runs {}, which is not executable",
            command[0]
        );
        Form::Helper {
            command: command.to_vec(),
        }
    } else if let OAuthConfig::RefreshToken(config) = config.oauth {
        let token_url = token_url(name, config.token_url.as_deref())?;
        let value = read(
            "oauth.refreshTokenEnv",
            &config.refresh_token_env,
            VALUE_BYTES,
            true,
        )?;
        let stored = stored_refresh_token(&value);
        ensure!(
            valid_token(&stored.refresh_token),
            "MCP server {name} oauth.refreshTokenEnv reads {}, which holds no refresh token",
            config.refresh_token_env
        );
        secrets.extend(
            [Some(&stored.refresh_token), stored.client_secret.as_ref()]
                .into_iter()
                .flatten()
                .filter(|value| value.len() >= TRACKED_ENV_VALUE_BYTES)
                .cloned(),
        );
        Form::RefreshToken {
            stored,
            token_url,
            state: Mutex::default(),
        }
    } else {
        return Ok(None);
    };
    Ok(Some(MintedAuth {
        server: name.to_owned(),
        resource: resource.to_owned(),
        form,
        discovered: Mutex::default(),
    }))
}

fn valid_variable(value: &str) -> bool {
    !value.starts_with("SUPERTAG_")
        && value.len() <= 128
        && value.as_bytes().first().is_some_and(u8::is_ascii_uppercase)
        && value
            .bytes()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
}

/// A configured token endpoint: HTTPS, or HTTP to a loopback host, without credentials or a
/// fragment.
fn token_url(name: &str, value: Option<&str>) -> Result<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let url = Url::parse(value.trim()).ok().filter(|url| {
        safe_endpoint(url.as_str())
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
    });
    let url = url.with_context(|| {
        format!(
            "MCP server {name}: tokenUrl must be the authorization server's https token endpoint, such as https://auth.example.com/oauth/token"
        )
    })?;
    Ok(Some(url.into()))
}

fn stored_refresh_token(value: &str) -> StoredRefreshToken {
    let raw = || StoredRefreshToken {
        refresh_token: value.to_owned(),
        client_id: None,
        client_secret: None,
    };
    if !value.starts_with('{') {
        return raw();
    }
    let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(value) else {
        return raw();
    };
    let text = |key: &str| parsed.get(key).and_then(Value::as_str).map(str::to_owned);
    let Some(refresh_token) = text("refresh_token") else {
        return raw();
    };
    StoredRefreshToken {
        refresh_token,
        client_id: text("client_id"),
        client_secret: text("client_secret"),
    }
}

/// Whether `program` is an executable file: a path, or a name on the Worker Host's PATH.
fn executable(program: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let runnable = |path: &Path| {
        std::fs::metadata(path)
            .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
    };
    if program.contains('/') {
        return runnable(Path::new(program));
    }
    std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path)
            .filter(|directory| !directory.as_os_str().is_empty())
            .any(|directory| runnable(&directory.join(program)))
    })
}

impl MintedAuth {
    /// Headers for a request to `url`. `rejected` is set when the server refused the previous
    /// credentials: the token or the headers are minted again. A refresh token form reuses its
    /// access token until it nears expiry or the server refuses it.
    pub(super) async fn headers(
        &self,
        client: &Client,
        url: &Url,
        github_api: &Url,
        rejected: Option<&str>,
    ) -> Result<Minted> {
        let server = &self.server;
        let mut secrets = Vec::new();
        let token = match &self.form {
            Form::Helper { command } => {
                let headers = run_helper(server, command).await?;
                secrets.extend(
                    headers
                        .values()
                        .filter_map(|value| value.to_str().ok())
                        .flat_map(credential_parts)
                        .filter(|value| value.len() >= TRACKED_ENV_VALUE_BYTES),
                );
                return Ok(Minted { headers, secrets });
            }
            Form::GithubApp {
                app_id,
                installation_id,
                key,
            } => {
                let issued = now_ms() / 1000 - 60;
                let jwt = sign_jwt(
                    key,
                    &json!({"iat": issued, "exp": issued + 540, "iss": app_id.to_string()}),
                )?;
                secrets.push(jwt.clone());
                let endpoint = github_api
                    .join(&format!(
                        "app/installations/{installation_id}/access_tokens"
                    ))
                    .context("invalid GitHub API URL")?;
                let response = client
                    .post(endpoint)
                    .header(reqwest::header::ACCEPT, "application/vnd.github+json")
                    .header(reqwest::header::AUTHORIZATION, format!("Bearer {jwt}"))
                    .header(reqwest::header::USER_AGENT, "supertag")
                    .header("x-github-api-version", "2022-11-28")
                    .send()
                    .await
                    .map_err(|_| {
                        anyhow::anyhow!(
                            "MCP server {server}: the GitHub App installation token request failed"
                        )
                    })?;
                ensure!(
                    !response.status().is_redirection(),
                    "MCP server {server}: the GitHub App installation token request was redirected; SuperTag does not follow redirects for token requests"
                );
                let body =
                    token_response(server, "GitHub App installation token", response).await?;
                body.get("token")
                    .and_then(Value::as_str)
                    .filter(|token| valid_token(token))
                    .with_context(|| {
                        format!("MCP server {server}: GitHub returned no installation token")
                    })?
                    .to_owned()
            }
            Form::ClientCredentials {
                client_id,
                credential,
                scope,
                token_url,
            } => {
                let endpoint = self.endpoint(client, url, token_url.as_deref()).await?;
                let mut form = vec![
                    ("grant_type", "client_credentials".to_owned()),
                    ("resource", self.resource.clone()),
                ];
                if let Some(scope) = scope {
                    form.push(("scope", scope.clone()));
                }
                let mut basic = None;
                match credential {
                    ClientCredential::Secret(secret) => {
                        basic = Some(format!(
                            "Basic {}",
                            STANDARD.encode(format!("{}:{}", encode(client_id), encode(secret)))
                        ));
                    }
                    ClientCredential::Assertion(key) => {
                        let issued = now_ms() / 1000;
                        let assertion = sign_jwt(
                            key,
                            &json!({
                                "iss": client_id,
                                "sub": client_id,
                                "aud": endpoint,
                                "iat": issued,
                                "exp": issued + 300,
                                "jti": uuid::Uuid::new_v4().to_string(),
                            }),
                        )?;
                        secrets.push(assertion.clone());
                        form.extend([
                            ("client_id", client_id.clone()),
                            (
                                "client_assertion_type",
                                "urn:ietf:params:oauth:client-assertion-type:jwt-bearer".into(),
                            ),
                            ("client_assertion", assertion),
                        ]);
                    }
                }
                let response = token_request(client, server, "token", &endpoint, |request| {
                    let request = request.form(&form);
                    match &basic {
                        Some(basic) => request.header(reqwest::header::AUTHORIZATION, basic),
                        None => request,
                    }
                })
                .await?;
                access_token(server, &token_response(server, "token", response).await?)?
            }
            Form::RefreshToken {
                stored,
                token_url,
                state,
            } => {
                // One refresh at a time, so a rotating refresh token is spent once.
                let mut state = state.lock().await;
                if let Some(rotated) = &state.rotated {
                    secrets.push(rotated.clone());
                }
                if let Some((token, expires)) = &state.access
                    && *expires > now_ms() + REFRESH_MARGIN_MS
                    && rejected != Some(token.as_str())
                {
                    secrets.push(token.clone());
                    return Ok(Minted {
                        headers: bearer(server, token)?,
                        secrets,
                    });
                }
                let endpoint = self.endpoint(client, url, token_url.as_deref()).await?;
                let refresh_token = state
                    .rotated
                    .clone()
                    .unwrap_or_else(|| stored.refresh_token.clone());
                let mut form = vec![
                    ("grant_type", "refresh_token".to_owned()),
                    ("refresh_token", refresh_token),
                    ("resource", self.resource.clone()),
                ];
                form.extend(stored.client_id.clone().map(|id| ("client_id", id)));
                form.extend(
                    stored
                        .client_secret
                        .clone()
                        .map(|secret| ("client_secret", secret)),
                );
                let response =
                    token_request(client, server, "token refresh", &endpoint, |request| {
                        request.form(&form)
                    })
                    .await?;
                let body = token_response(server, "token refresh", response).await?;
                let token = access_token(server, &body)?;
                if let Some(rotated) = body
                    .get("refresh_token")
                    .and_then(Value::as_str)
                    .filter(|token| !token.is_empty())
                {
                    secrets.push(rotated.to_owned());
                    state.rotated = Some(rotated.to_owned());
                }
                let expires_in = body
                    .get("expires_in")
                    .and_then(Value::as_i64)
                    .unwrap_or(300)
                    .clamp(0, 365 * 24 * 3600);
                state.access = Some((token.clone(), now_ms() + expires_in * 1000));
                token
            }
        };
        secrets.push(token.clone());
        Ok(Minted {
            headers: bearer(server, &token)?,
            secrets,
        })
    }

    /// `tokenUrl` when configured; otherwise the endpoint the server's metadata names on its
    /// own origin, discovered once.
    async fn endpoint(
        &self,
        client: &Client,
        url: &Url,
        configured: Option<&str>,
    ) -> Result<String> {
        if let Some(configured) = configured {
            return Ok(configured.to_owned());
        }
        let mut discovered = self.discovered.lock().await;
        if let Some(endpoint) = discovered.as_ref() {
            return Ok(endpoint.clone());
        }
        let endpoint = discover_token_endpoint(client, &self.server, url.as_str())
            .await
            .map_err(|error| {
                anyhow::anyhow!(
                    "{error}; set the authorization server's token endpoint as tokenUrl to trust it"
                )
            })?;
        *discovered = Some(endpoint.clone());
        Ok(endpoint)
    }
}

/// Percent-encodes `value` as JavaScript's `encodeURIComponent` does, for HTTP Basic client
/// authentication (RFC 6749 section 2.3.1).
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
                char::from(byte).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

/// A header value and, for `Bearer` or `Basic` values, the credential after the scheme.
fn credential_parts(value: &str) -> Vec<String> {
    let mut parts = vec![value.to_owned()];
    if let Some((scheme, credential)) = value.split_once(' ')
        && (scheme.eq_ignore_ascii_case("bearer") || scheme.eq_ignore_ascii_case("basic"))
        && !credential.trim().is_empty()
    {
        parts.push(credential.trim().to_owned());
    }
    parts
}

fn bearer(server: &str, token: &str) -> Result<HeaderMap> {
    let mut value = HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| {
        anyhow::anyhow!("MCP server {server}: the token is not a valid header value")
    })?;
    value.set_sensitive(true);
    let mut headers = HeaderMap::new();
    headers.insert(reqwest::header::AUTHORIZATION, value);
    Ok(headers)
}

/// Runs a host-declared headers helper with the Worker Host's environment. It must print one
/// JSON object of header names to string values within 15 seconds; its output is never echoed.
async fn run_helper(server: &str, command: &[String]) -> Result<HeaderMap> {
    let program = &command[0];
    let mut child = Command::new(program)
        .args(&command[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| {
            anyhow::anyhow!("MCP server {server}: auth helper {program} failed to start")
        })?;
    let group = child.id().and_then(|pid| libc::pid_t::try_from(pid).ok());
    let mut stdout = child.stdout.take().context("helper output")?;
    let run = async {
        let mut output = Vec::new();
        (&mut stdout)
            .take(HELPER_OUTPUT_BYTES as u64 + 1)
            .read_to_end(&mut output)
            .await?;
        let status = child.wait().await?;
        anyhow::Ok((output, status))
    };
    let result = time::timeout(HELPER_TIMEOUT, run).await;
    if let Some(group) = group {
        // SAFETY: the group was created for this helper by process_group(0); descendants that
        // outlived it, or a helper that timed out, are stopped with it.
        unsafe {
            libc::killpg(group, libc::SIGKILL);
        }
    }
    let (output, status) = match result {
        Ok(Ok(finished)) => finished,
        Ok(Err(_)) => bail!("MCP server {server}: auth helper {program} failed"),
        Err(_) => bail!("MCP server {server}: auth helper {program} did not finish in 15 seconds"),
    };
    ensure!(
        status.success(),
        "MCP server {server}: auth helper {program} failed{}",
        status
            .code()
            .map(|code| format!(" with exit code {code}"))
            .unwrap_or_default()
    );
    ensure!(
        output.len() <= HELPER_OUTPUT_BYTES,
        "MCP server {server}: auth helper {program} printed more than 64 KiB"
    );
    let parsed: BTreeMap<String, Value> = serde_json::from_slice(&output).map_err(|_| {
        anyhow::anyhow!("MCP server {server}: auth helper {program} must print a JSON object")
    })?;
    ensure!(
        parsed.len() <= 16,
        "MCP server {server}: auth helper {program} printed too many headers"
    );
    let mut headers = HeaderMap::new();
    for (name, value) in parsed {
        let Value::String(value) = value else {
            bail!(
                "MCP server {server}: auth helper {program} must print a JSON object of header names to string values"
            );
        };
        let header = HeaderName::from_bytes(name.as_bytes())
            .ok()
            .filter(valid_header)
            .with_context(|| {
                format!("MCP server {server}: auth helper {program} printed a header name SuperTag does not send")
            })?;
        let mut value = HeaderValue::from_str(&value)
            .ok()
            .filter(|value| value.len() <= VALUE_BYTES)
            .with_context(|| {
                format!("MCP server {server}: auth helper {program} printed an invalid value for header {header}")
            })?;
        value.set_sensitive(true);
        headers.insert(header, value);
    }
    Ok(headers)
}

/// An RSA or P-256 EC private key in PEM form (PKCS#1, PKCS#8, or SEC1).
enum SigningKey {
    Rsa(RsaKeyPair),
    Ec(EcdsaKeyPair),
}

fn signing_key(server: &str, field: &str, pem: &str) -> Result<SigningKey> {
    let refused = || {
        anyhow::anyhow!("MCP server {server} {field} is not an RSA or EC private key in PEM form")
    };
    let rng = SystemRandom::new();
    let ec = |pkcs8: &[u8]| {
        EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8, &rng).map(SigningKey::Ec)
    };
    let key = match PrivateKeyDer::from_pem_slice(pem.as_bytes()).map_err(|_| refused())? {
        PrivateKeyDer::Pkcs1(key) => RsaKeyPair::from_der(key.secret_pkcs1_der())
            .map(SigningKey::Rsa)
            .ok(),
        PrivateKeyDer::Pkcs8(key) => RsaKeyPair::from_pkcs8(key.secret_pkcs8_der())
            .map(SigningKey::Rsa)
            .ok()
            .or_else(|| ec(key.secret_pkcs8_der()).ok()),
        PrivateKeyDer::Sec1(key) => ec(&sec1_to_pkcs8(key.secret_sec1_der())).ok(),
        _ => None,
    };
    key.ok_or_else(refused)
}

/// Wraps a SEC1 P-256 private key in PKCS#8, the only EC form ring reads.
fn sec1_to_pkcs8(sec1: &[u8]) -> Vec<u8> {
    fn tlv(tag: u8, content: &[u8]) -> Vec<u8> {
        let mut out = vec![tag];
        let length = content.len();
        if length < 0x80 {
            out.push(length as u8);
        } else {
            let bytes: Vec<u8> = length
                .to_be_bytes()
                .into_iter()
                .skip_while(|byte| *byte == 0)
                .collect();
            out.push(0x80 | bytes.len() as u8);
            out.extend(bytes);
        }
        out.extend_from_slice(content);
        out
    }
    // AlgorithmIdentifier { id-ecPublicKey, prime256v1 }.
    const ALGORITHM: [u8; 21] = [
        0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86,
        0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
    ];
    let mut body = vec![0x02, 0x01, 0x00];
    body.extend_from_slice(&ALGORITHM);
    body.extend(tlv(0x04, sec1));
    tlv(0x30, &body)
}

fn sign_jwt(key: &SigningKey, claims: &Value) -> Result<String> {
    let algorithm = match key {
        SigningKey::Rsa(_) => "RS256",
        SigningKey::Ec(_) => "ES256",
    };
    let encode = |value: &Value| URL_SAFE_NO_PAD.encode(value.to_string());
    let message = format!(
        "{}.{}",
        encode(&json!({"alg": algorithm, "typ": "JWT"})),
        encode(claims)
    );
    let rng = SystemRandom::new();
    let signature = match key {
        SigningKey::Rsa(key) => {
            let mut signature = vec![0; key.public().modulus_len()];
            key.sign(&RSA_PKCS1_SHA256, &rng, message.as_bytes(), &mut signature)
                .map_err(|_| anyhow::anyhow!("JWT signing failed"))?;
            signature
        }
        SigningKey::Ec(key) => key
            .sign(&rng, message.as_bytes())
            .map_err(|_| anyhow::anyhow!("JWT signing failed"))?
            .as_ref()
            .to_vec(),
    };
    Ok(format!("{message}.{}", URL_SAFE_NO_PAD.encode(signature)))
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, os::unix::fs::PermissionsExt};

    use ring::signature::{
        ECDSA_P256_SHA256_FIXED, KeyPair as _, RSA_PKCS1_2048_8192_SHA256, UnparsedPublicKey,
    };
    use serde_json::{Value, json};

    use super::*;
    use crate::mcp::{
        Failure,
        catalog::{HttpServer, McpCatalog, Transport},
        http::{Session, client},
        test_http::{Request, serve},
    };

    const RSA_KEY: &str = include_str!("fixtures/auth-rsa-key.pem");
    const RSA_PUBLIC: &[u8] = include_bytes!("fixtures/auth-rsa-public.der");
    const EC_KEY: &str = include_str!("fixtures/auth-ec-key.pem");

    fn initialize() -> String {
        json!({"jsonrpc":"2.0","id":1,"result":{
            "protocolVersion":"2025-06-18","capabilities":{"tools":{}}
        }})
        .to_string()
    }

    fn catalog(server: Value, variables: &[(&str, &str)]) -> Result<McpCatalog> {
        let variables: BTreeMap<String, String> = variables
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect();
        McpCatalog::parse(
            json!({"version":1,"servers":[server]})
                .to_string()
                .as_bytes(),
            move |name| variables.get(name).cloned(),
        )
    }

    fn http(catalog: &McpCatalog, name: &str) -> HttpServer {
        let Transport::Http(server) = catalog.servers[name].transport.clone() else {
            panic!("HTTP server expected");
        };
        server
    }

    fn form(request: &Request) -> BTreeMap<String, String> {
        request
            .body
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .map(|(key, value)| {
                let decode = |value: &str| {
                    let value = value.replace('+', " ");
                    let mut bytes = Vec::new();
                    let mut input = value.bytes();
                    while let Some(byte) = input.next() {
                        if byte == b'%' {
                            let hex: String = [input.next().unwrap(), input.next().unwrap()]
                                .iter()
                                .map(|b| char::from(*b))
                                .collect();
                            bytes.push(u8::from_str_radix(&hex, 16).unwrap());
                        } else {
                            bytes.push(byte);
                        }
                    }
                    String::from_utf8(bytes).unwrap()
                };
                (decode(key), decode(value))
            })
            .collect()
    }

    /// The claims of `jwt` once its signature verifies with `verify`.
    fn claims(jwt: &str, verify: impl Fn(&[u8], &[u8]) -> bool) -> (Value, Value) {
        let parts: Vec<_> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let signature = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        assert!(verify(
            format!("{}.{}", parts[0], parts[1]).as_bytes(),
            &signature
        ));
        let decode = |part: &str| -> Value {
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(part).unwrap()).unwrap()
        };
        (decode(parts[0]), decode(parts[1]))
    }

    #[test]
    fn reads_every_form_from_worker_host_variables_and_refuses_missing_or_malformed_ones() {
        let url = "https://mcp.example.test/mcp";
        let ec_pkcs8 = {
            let rng = SystemRandom::new();
            let document =
                EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
            format!(
                "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
                STANDARD.encode(document.as_ref())
            )
        };
        for key in [RSA_KEY, EC_KEY, ec_pkcs8.as_str()] {
            let parsed = catalog(
                json!({"name":"app","url":url,"githubApp":{"appId":1,"installationId":2,"privateKeyEnv":"APP_KEY"}}),
                &[("APP_KEY", key)],
            )
            .unwrap();
            // The key is a credential: it never appears in Task-visible output.
            assert!(parsed.secrets.iter().any(|secret| secret == key.trim()));
        }
        let parsed = catalog(
            json!({"name":"cc","url":url,"clientCredentials":{"clientIdEnv":"CC_ID","clientSecretEnv":"CC_SECRET","scope":" read write ","tokenUrl":"https://auth.example.test/token"}}),
            &[("CC_ID", "client-id-value"), ("CC_SECRET", "client-secret-value")],
        )
        .unwrap();
        assert!(parsed.secrets.contains(&"client-secret-value".to_owned()));
        // A client ID is public: withholding it would drop every output that names it.
        assert!(!parsed.secrets.contains(&"client-id-value".to_owned()));
        let short = catalog(
            json!({"name":"cc","url":url,"clientCredentials":{"clientId":"app","clientSecretEnv":"CC_SECRET"}}),
            &[("CC_SECRET", "12345")],
        )
        .unwrap();
        assert!(!short.secrets.contains(&"12345".to_owned()));
        let entries_label = parsed.servers["cc"].capability.provider_binding.clone();
        // A changed credential is a different provider binding.
        let rotated = catalog(
            json!({"name":"cc","url":url,"clientCredentials":{"clientIdEnv":"CC_ID","clientSecretEnv":"CC_SECRET","scope":" read write ","tokenUrl":"https://auth.example.test/token"}}),
            &[("CC_ID", "client-id-value"), ("CC_SECRET", "client-secret-other")],
        )
        .unwrap();
        assert_ne!(
            rotated.servers["cc"].capability.provider_binding,
            entries_label
        );
        let parsed = catalog(
            json!({"name":"docs","url":url,"oauth":{"refreshTokenEnv":"DOCS_REFRESH"}}),
            &[(
                "DOCS_REFRESH",
                r#"{"refresh_token":"refresh-value","client_id":"client","client_secret":"exported-secret"}"#,
            )],
        )
        .unwrap();
        for secret in ["refresh-value", "exported-secret"] {
            assert!(parsed.secrets.contains(&secret.to_owned()), "{secret}");
        }
        assert!(!http(&parsed, "docs").oauth);
        for (server, variables, message, value) in [
            (
                json!({"name":"cc","url":url,"clientCredentials":{"clientId":"id","clientSecretEnv":"CC_SECRET"}}),
                vec![],
                "clientCredentials.clientSecretEnv reads CC_SECRET, which is not set",
                "",
            ),
            (
                json!({"name":"cc","url":url,"clientCredentials":{"clientId":"id"}}),
                vec![],
                "exactly one of clientSecretEnv or assertionKeyEnv",
                "",
            ),
            (
                json!({"name":"cc","url":url,"clientCredentials":{"clientId":"id","clientIdEnv":"CC_ID","clientSecretEnv":"CC_SECRET"}}),
                vec![("CC_ID", "x"), ("CC_SECRET", "y")],
                "exactly one of clientId or clientIdEnv",
                "",
            ),
            (
                json!({"name":"cc","url":url,"clientCredentials":{"clientId":"id","assertionKeyEnv":"CC_KEY"}}),
                vec![("CC_KEY", "not-a-key-value")],
                "is not an RSA or EC private key in PEM form",
                "not-a-key-value",
            ),
            (
                json!({"name":"cc","url":url,"clientCredentials":{"clientId":"id","clientSecretEnv":"CC_SECRET","tokenUrl":"http://auth.example.test/token"}}),
                vec![("CC_SECRET", "y")],
                "tokenUrl must be the authorization server's https token endpoint",
                "",
            ),
            (
                json!({"name":"cc","url":url,"clientCredentials":{"clientId":"id","clientSecretEnv":"SUPERTAG_TOKEN"}}),
                vec![("SUPERTAG_TOKEN", "y")],
                "not named SUPERTAG_",
                "",
            ),
            (
                json!({"name":"app","url":url,"githubApp":{"appId":0,"installationId":2,"privateKeyEnv":"APP_KEY"}}),
                vec![("APP_KEY", RSA_KEY)],
                "numeric appId",
                "",
            ),
            (
                json!({"name":"x","url":url,"helper":["/nonexistent/supertag-helper"]}),
                vec![],
                "helper runs /nonexistent/supertag-helper, which is not executable",
                "",
            ),
            (
                json!({"name":"x","url":url,"helper":["/bin/sh"],"oauth":true}),
                vec![],
                "choose one of oauth, clientCredentials, githubApp, or helper",
                "",
            ),
            (
                json!({"name":"x","url":url,"helper":["/bin/sh"],"headerEnv":{"Authorization":"X_AUTH"}}),
                vec![("X_AUTH", "Bearer header-value")],
                "supplies the Authorization header",
                "header-value",
            ),
            (
                json!({"name":"x","command":["/bin/cat"],"helper":["/bin/sh"]}),
                vec![],
                "a stdio server has no HTTP authentication",
                "",
            ),
            (
                json!({"name":"docs","url":url,"oauth":{"refreshTokenEnv":"DOCS_REFRESH"}}),
                vec![],
                "oauth.refreshTokenEnv reads DOCS_REFRESH, which is not set",
                "",
            ),
        ] {
            let error = catalog(server.clone(), &variables)
                .err()
                .unwrap()
                .to_string();
            assert!(error.contains(message), "{server}: {error}");
            assert!(value.is_empty() || !error.contains(value), "{error}");
        }
    }

    #[tokio::test]
    async fn client_credentials_send_a_basic_secret_or_a_signed_assertion_for_the_server() {
        // A client secret: HTTP Basic with the encoded ID and secret, the server as resource.
        let (address, served) = serve(vec![
            (
                200,
                "application/json",
                json!({"access_token":"cc-access-1","token_type":"Bearer"}).to_string(),
            ),
            (200, "application/json", initialize()),
            (202, "application/json", String::new()),
        ])
        .await;
        let origin = format!("http://127.0.0.1:{}", address.port());
        let url = format!("{origin}/mcp");
        let parsed = catalog(
            json!({"name":"cc","url":url,"clientCredentials":{"clientId":"id:1","clientSecretEnv":"CC_SECRET","scope":"tools.read","tokenUrl":format!("{origin}/token")}}),
            &[("CC_SECRET", "s3cret/value")],
        )
        .unwrap();
        let mut session = Session::new(client().unwrap(), http(&parsed, "cc"), None);
        session.initialize().await.unwrap();
        assert!(session.tokens.contains(&"cc-access-1".to_owned()));
        let requests = served.await.unwrap();
        assert_eq!(requests[0].line, "POST /token HTTP/1.1");
        let basic = format!(
            "authorization: basic {}",
            STANDARD.encode("id%3A1:s3cret%2Fvalue")
        )
        .to_ascii_lowercase();
        assert!(
            requests[0].headers.contains(&basic),
            "{:?}",
            requests[0].headers
        );
        assert_eq!(
            form(&requests[0]),
            BTreeMap::from([
                ("grant_type".into(), "client_credentials".into()),
                ("resource".into(), url.clone()),
                ("scope".into(), "tools.read".into()),
            ])
        );
        for request in &requests[1..] {
            assert!(
                request
                    .headers
                    .contains(&"authorization: bearer cc-access-1".into())
            );
        }

        // A JWT client assertion signed with the EC key, for the token endpoint as audience.
        // A URL without a path is the resource exactly as configured, with no trailing slash.
        let (address, served) = serve(vec![
            (
                200,
                "application/json",
                json!({"access_token":"cc-access-2"}).to_string(),
            ),
            (200, "application/json", initialize()),
            (202, "application/json", String::new()),
        ])
        .await;
        let origin = format!("http://127.0.0.1:{}", address.port());
        let url = origin.clone();
        let parsed = catalog(
            json!({"name":"cc","url":url,"clientCredentials":{"clientId":"client-1","assertionKeyEnv":"CC_KEY","tokenUrl":format!("{origin}/token")}}),
            &[("CC_KEY", EC_KEY)],
        )
        .unwrap();
        let mut session = Session::new(client().unwrap(), http(&parsed, "cc"), None);
        session.initialize().await.unwrap();
        let requests = served.await.unwrap();
        let body = form(&requests[0]);
        assert!(
            !requests[0]
                .headers
                .iter()
                .any(|header| header.starts_with("authorization:"))
        );
        assert_eq!(body["client_id"], "client-1");
        assert_eq!(body["resource"], origin);
        assert_eq!(
            body["client_assertion_type"],
            "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
        );
        let Ok(SigningKey::Ec(key)) = signing_key("cc", "key", EC_KEY) else {
            panic!("EC key expected");
        };
        let public =
            UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, key.public_key().as_ref().to_vec());
        let (header, claims) = claims(&body["client_assertion"], |message, signature| {
            public.verify(message, signature).is_ok()
        });
        assert_eq!(header["alg"], "ES256");
        assert_eq!(claims["iss"], "client-1");
        assert_eq!(claims["sub"], "client-1");
        assert_eq!(claims["aud"], format!("{origin}/token"));
        assert_eq!(
            claims["exp"].as_i64().unwrap() - claims["iat"].as_i64().unwrap(),
            300
        );
        // The assertion is withheld like the token it bought.
        assert!(session.tokens.contains(&body["client_assertion"]));
    }

    #[tokio::test]
    async fn github_app_mints_an_installation_token_per_attempt_and_after_a_refusal() {
        let (address, served) = serve(vec![
            (
                201,
                "application/json",
                json!({"token":"ghs_first"}).to_string(),
            ),
            (401, "application/json", String::new()),
            (
                201,
                "application/json",
                json!({"token":"ghs_second"}).to_string(),
            ),
            (200, "application/json", initialize()),
            (202, "application/json", String::new()),
        ])
        .await;
        let origin = format!("http://127.0.0.1:{}", address.port());
        let parsed = catalog(
            json!({"name":"gh","url":format!("{origin}/mcp"),"githubApp":{"appId":12,"installationId":34,"privateKeyEnv":"GH_KEY"}}),
            &[("GH_KEY", RSA_KEY)],
        )
        .unwrap();
        let mut server = http(&parsed, "gh");
        *server.github_api = Url::parse(&format!("{origin}/api/")).unwrap();
        let mut session = Session::new(client().unwrap(), server, None);
        session.initialize().await.unwrap();
        let requests = served.await.unwrap();
        for index in [0, 2] {
            assert_eq!(
                requests[index].line,
                "POST /api/app/installations/34/access_tokens HTTP/1.1"
            );
            for header in [
                "accept: application/vnd.github+json",
                "user-agent: supertag",
                "x-github-api-version: 2022-11-28",
            ] {
                assert!(requests[index].headers.contains(&header.into()), "{header}");
            }
        }
        assert!(
            requests[1]
                .headers
                .contains(&"authorization: bearer ghs_first".into())
        );
        assert!(
            requests[3]
                .headers
                .contains(&"authorization: bearer ghs_second".into())
        );
        // Each App JWT is RS256, issued by the App, and valid for nine minutes.
        let public = UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, RSA_PUBLIC);
        let jwts: Vec<_> = session
            .tokens
            .iter()
            .filter(|token| token.split('.').count() == 3)
            .collect();
        // Two JWTs minted in the same second are identical, so one or two are withheld.
        assert!(!jwts.is_empty());
        for jwt in jwts {
            let (header, claims) = claims(jwt, |message, signature| {
                public.verify(message, signature).is_ok()
            });
            assert_eq!(header["alg"], "RS256");
            assert_eq!(claims["iss"], "12");
            assert_eq!(
                claims["exp"].as_i64().unwrap() - claims["iat"].as_i64().unwrap(),
                540
            );
        }
        for token in ["ghs_first", "ghs_second"] {
            assert!(session.tokens.contains(&token.to_owned()));
        }
    }

    #[tokio::test]
    async fn a_refresh_token_from_a_variable_is_refreshed_once_reused_and_rotated() {
        // The metadata names this origin, so the listener binds before the responses exist.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let responses = vec![
            (
                200,
                "application/json",
                json!({"authorization_servers":[origin]}).to_string(),
            ),
            (
                200,
                "application/json",
                json!({"token_endpoint":format!("{origin}/token")}).to_string(),
            ),
            (
                200,
                "application/json",
                json!({"access_token":"access-1","refresh_token":"refresh-2","expires_in":3600})
                    .to_string(),
            ),
            (200, "application/json", initialize()),
            (202, "application/json", String::new()),
            (403, "application/json", String::new()),
            (
                200,
                "application/json",
                json!({"access_token":"access-2","expires_in":3600}).to_string(),
            ),
            (200, "application/json", initialize()),
            (202, "application/json", String::new()),
        ];
        let served = crate::mcp::test_http::serve_on(listener, responses);
        let url = format!("{origin}/mcp");
        let parsed = catalog(
            json!({"name":"docs","url":url,"oauth":{"refreshTokenEnv":"DOCS_REFRESH"}}),
            &[(
                "DOCS_REFRESH",
                r#"{"refresh_token":"refresh-1","client_id":"exported-client","client_secret":"exported-secret"}"#,
            )],
        )
        .unwrap();
        let server = http(&parsed, "docs");
        let mut first = Session::new(client().unwrap(), server.clone(), None);
        first.initialize().await.unwrap();
        let mut second = Session::new(client().unwrap(), server, None);
        second.initialize().await.unwrap();
        assert!(second.tokens.contains(&"refresh-2".to_owned()));
        let requests = served.await.unwrap();
        assert_eq!(
            requests[0].line,
            "GET /.well-known/oauth-protected-resource/mcp HTTP/1.1"
        );
        assert_eq!(
            requests[1].line,
            "GET /.well-known/oauth-authorization-server HTTP/1.1"
        );
        assert_eq!(
            form(&requests[2]),
            BTreeMap::from([
                ("grant_type".into(), "refresh_token".into()),
                ("refresh_token".into(), "refresh-1".into()),
                ("resource".into(), url.clone()),
                ("client_id".into(), "exported-client".into()),
                ("client_secret".into(), "exported-secret".into()),
            ])
        );
        assert!(
            requests[5]
                .headers
                .contains(&"authorization: bearer access-1".into())
        );
        // The discovered endpoint is kept; the rotated refresh token is spent.
        assert_eq!(requests[6].line, "POST /token HTTP/1.1");
        assert_eq!(form(&requests[6])["refresh_token"], "refresh-2");
        assert!(
            requests[7]
                .headers
                .contains(&"authorization: bearer access-2".into())
        );
    }

    #[tokio::test]
    async fn token_endpoints_are_pinned_and_token_requests_never_follow_a_redirect() {
        // Metadata naming a token endpoint on another origin is refused before any secret
        // leaves the host; the error suggests tokenUrl and never repeats the advertised URL.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let served = crate::mcp::test_http::serve_on(
            listener,
            vec![
                (
                    200,
                    "application/json",
                    json!({"authorization_servers":[origin]}).to_string(),
                ),
                (
                    200,
                    "application/json",
                    json!({"token_endpoint":"https://elsewhere.example.test/token"}).to_string(),
                ),
            ],
        );
        let parsed = catalog(
            json!({"name":"cc","url":format!("{origin}/mcp"),"clientCredentials":{"clientId":"id","clientSecretEnv":"CC_SECRET"}}),
            &[("CC_SECRET", "secret-value")],
        )
        .unwrap();
        let server = http(&parsed, "cc");
        let error = server
            .minted
            .as_ref()
            .unwrap()
            .headers(
                &client().unwrap(),
                &server.endpoint,
                &server.github_api,
                None,
            )
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(
            error.contains("another origin") && error.contains("tokenUrl"),
            "{error}"
        );
        assert!(!error.contains("elsewhere"), "{error}");
        assert_eq!(served.await.unwrap().len(), 2);

        // A configured tokenUrl that redirects is refused for every minted form.
        for form in ["clientCredentials", "oauth", "githubApp"] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
            let served = crate::mcp::test_http::serve_on(
                listener,
                vec![(307, "application/json", String::new())],
            );
            let config = match form {
                "clientCredentials" => {
                    json!({"clientCredentials":{"clientId":"id","clientSecretEnv":"SECRET","tokenUrl":format!("{origin}/token")}})
                }
                "oauth" => {
                    json!({"oauth":{"refreshTokenEnv":"SECRET","tokenUrl":format!("{origin}/token")}})
                }
                _ => json!({"githubApp":{"appId":1,"installationId":2,"privateKeyEnv":"KEY"}}),
            };
            let mut server_config = json!({"name":"x","url":"https://mcp.example.test/mcp"});
            server_config
                .as_object_mut()
                .unwrap()
                .extend(config.as_object().unwrap().clone());
            let parsed = catalog(
                server_config,
                &[("SECRET", "secret-value"), ("KEY", RSA_KEY)],
            )
            .unwrap();
            let mut server = http(&parsed, "x");
            *server.github_api = Url::parse(&format!("{origin}/")).unwrap();
            let error = server
                .minted
                .as_ref()
                .unwrap()
                .headers(
                    &client().unwrap(),
                    &server.endpoint,
                    &server.github_api,
                    None,
                )
                .await
                .err()
                .unwrap()
                .to_string();
            assert!(error.contains("redirected"), "{form}: {error}");
            assert_eq!(served.await.unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn a_helper_supplies_headers_and_its_output_is_never_echoed() {
        let root = tempfile::tempdir().unwrap();
        let helper = |name: &str, body: &str| {
            let path = root.path().join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path.to_string_lossy().into_owned()
        };
        let good = helper(
            "good",
            r#"printf '{"X-Api-Key":"helper-key-value","Authorization":"Bearer helper-token","X-Tenant":"acme"}'"#,
        );
        let parsed = catalog(
            json!({"name":"x","url":"https://mcp.example.test/mcp","helper":[good]}),
            &[],
        )
        .unwrap();
        let server = http(&parsed, "x");
        let minted = server
            .minted
            .as_ref()
            .unwrap()
            .headers(
                &client().unwrap(),
                &server.endpoint,
                &server.github_api,
                None,
            )
            .await
            .unwrap();
        assert_eq!(minted.headers["x-api-key"], "helper-key-value");
        assert_eq!(minted.headers["authorization"], "Bearer helper-token");
        for secret in ["helper-key-value", "Bearer helper-token", "helper-token"] {
            assert!(minted.secrets.contains(&secret.to_owned()), "{secret}");
        }
        // A value too short to recognize is not withheld, so it cannot drop unrelated output.
        assert_eq!(minted.headers["x-tenant"], "acme");
        assert!(!minted.secrets.contains(&"acme".to_owned()));
        for (body, message) in [
            ("printf 'leaked-output-value'", "must print a JSON object"),
            (
                r#"printf '{"X-Key":["leaked-output-value"]}'"#,
                "JSON object of header names to string values",
            ),
            (
                r#"printf '{"Host":"leaked-output-value"}'"#,
                "header name SuperTag does not send",
            ),
            (
                "echo leaked-output-value; exit 3",
                "failed with exit code 3",
            ),
        ] {
            let path = helper("bad", body);
            let parsed = catalog(
                json!({"name":"x","url":"https://mcp.example.test/mcp","helper":[path]}),
                &[],
            )
            .unwrap();
            let server = http(&parsed, "x");
            let error = server
                .minted
                .as_ref()
                .unwrap()
                .headers(
                    &client().unwrap(),
                    &server.endpoint,
                    &server.github_api,
                    None,
                )
                .await
                .err()
                .unwrap()
                .to_string();
            assert!(error.contains(message), "{body}: {error}");
            assert!(!error.contains("leaked-output-value"), "{error}");
            std::fs::remove_file(root.path().join("bad")).unwrap();
        }
        // A refused helper makes the server unavailable for the Attempt.
        let path = helper("bad", "exit 1");
        let parsed = catalog(
            json!({"name":"x","url":"https://mcp.example.test/mcp","helper":[path]}),
            &[],
        )
        .unwrap();
        let mut session = Session::new(client().unwrap(), http(&parsed, "x"), None);
        assert_eq!(session.initialize().await, Err(Failure::Unavailable));
    }
}
