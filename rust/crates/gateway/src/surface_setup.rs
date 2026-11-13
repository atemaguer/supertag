//! Provider verification for `supertag setup surface`.
//!
//! Matches the TypeScript verifiers (`packages/surfaces/*/src/index.ts`, `verify*Account`): each
//! check calls the provider once with the supplied credentials and returns the verified account
//! identity, non-secret configuration, and the secrets to keep in the credential vault. Secret
//! values never enter errors; provider failures report only the HTTP status or a fixed reason.

use std::{collections::BTreeMap, time::Duration};

use anyhow::{Context, Result, anyhow, bail, ensure};
use reqwest::Client;
pub use reqwest::Url;
use serde_json::{Value, json};

use supertag_credential_vault::CredentialValue;

const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RESPONSE_BYTES: usize = 256 * 1024;

/// The provider endpoints verification calls. Tests replace them with loopback fixtures.
#[derive(Clone)]
pub struct Endpoints {
    /// Any Slack Web API method URL; methods are resolved relative to it.
    pub slack: Url,
    pub github: Url,
    pub linear: Url,
    /// Replaces both Lark and Feishu origins.
    pub lark: Option<Url>,
    pub microsoft_login: Url,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            slack: Url::parse("https://slack.com/api/auth.test").expect("static URL"),
            github: Url::parse("https://api.github.com/").expect("static URL"),
            linear: Url::parse("https://api.linear.app/graphql").expect("static URL"),
            lark: None,
            microsoft_login: Url::parse("https://login.microsoftonline.com/").expect("static URL"),
        }
    }
}

/// A verified provider account. Only `secrets` holds credential values.
pub struct Verified {
    /// `slack`, `github`, `linear`, `lark`, or `teams`, as in `surface/<provider>/<name>`.
    pub provider: &'static str,
    /// The provider's account: Slack team ID, `user-<id>` or `installation-<id>` for GitHub,
    /// Linear workspace ID, Lark App ID, or Microsoft tenant ID.
    pub external_account_id: String,
    pub display_name: String,
    pub auth_method: &'static str,
    /// Non-secret settings learned during verification, keyed as in `supertag.yaml`.
    pub configuration: BTreeMap<String, String>,
    pub secrets: CredentialValue,
}

fn client() -> Result<Client> {
    Ok(Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .build()?)
}

fn required(value: &str, label: &str) -> Result<String> {
    let value = value.trim();
    ensure!(!value.is_empty(), "{label} is required");
    ensure!(
        value.len() <= 64 * 1024 && !value.chars().any(char::is_control),
        "{label} is not valid"
    );
    Ok(value.to_owned())
}

async fn bounded_json(mut response: reqwest::Response, provider: &str) -> Result<Value> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow!("{provider} response was interrupted"))?
    {
        ensure!(
            chunk.len() <= MAX_RESPONSE_BYTES - bytes.len(),
            "{provider} response is too large"
        );
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| anyhow!("{provider} returned invalid JSON"))
}

fn text(value: &Value, pointer: &str) -> Option<String> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 512)
        .map(str::to_owned)
}

/// Slack HTTP events: a bot token and signing secret (`verifySlackAccount`, transport `http`).
pub async fn verify_slack(
    endpoints: &Endpoints,
    bot_token: &str,
    signing_secret: &str,
) -> Result<Verified> {
    let bot_token = required(bot_token, "A Slack bot token")?;
    let signing_secret = required(signing_secret, "A Slack signing secret")?;
    let response = client()?
        .post(endpoints.slack.join("auth.test")?)
        .bearer_auth(&bot_token)
        .send()
        .await
        .map_err(|_| anyhow!("Slack auth.test is unavailable"))?;
    ensure!(
        response.status().is_success(),
        "Slack auth.test failed with HTTP {}",
        response.status().as_u16()
    );
    let body = bounded_json(response, "Slack").await?;
    if body["ok"].as_bool() != Some(true) {
        let error = body["error"]
            .as_str()
            .filter(|e| e.len() <= 64 && e.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'))
            .unwrap_or("unknown_error");
        bail!("Slack auth.test failed: {error}");
    }
    let team_id = text(&body, "/team_id").context("Slack auth.test returned no team_id")?;
    let mut configuration = BTreeMap::new();
    for (key, pointer) in [("bot-id", "/bot_id"), ("bot-user-id", "/user_id")] {
        if let Some(value) = text(&body, pointer) {
            configuration.insert(key.to_owned(), value);
        }
    }
    Ok(Verified {
        provider: "slack",
        display_name: text(&body, "/team").unwrap_or_else(|| team_id.clone()),
        external_account_id: team_id,
        auth_method: "slack-http",
        configuration,
        secrets: BTreeMap::from([
            ("botToken".to_owned(), bot_token),
            ("signingSecret".to_owned(), signing_secret),
        ]),
    })
}

fn github_request(client: &Client, url: Url, authorization: &str) -> reqwest::RequestBuilder {
    client
        .get(url)
        .header("authorization", authorization)
        .header("accept", "application/vnd.github+json")
        .header("user-agent", "supertag-setup")
        .header("x-github-api-version", "2022-11-28")
}

/// GitHub fine-grained token, with an optional repository webhook secret
/// (`verifyGitHubTokenAccount`).
pub async fn verify_github_token(
    endpoints: &Endpoints,
    token: &str,
    webhook_secret: Option<&str>,
) -> Result<Verified> {
    let token = required(token, "A GitHub token")?;
    let webhook_secret = webhook_secret
        .map(|secret| required(secret, "A GitHub webhook secret"))
        .transpose()?;
    let response = github_request(
        &client()?,
        endpoints.github.join("user")?,
        &format!("Bearer {token}"),
    )
    .send()
    .await
    .map_err(|_| anyhow!("GitHub is unavailable"))?;
    ensure!(
        response.status().is_success(),
        "GitHub token verification failed with HTTP {}",
        response.status().as_u16()
    );
    let user = bounded_json(response, "GitHub").await?;
    let id = user["id"]
        .as_u64()
        .filter(|id| *id > 0)
        .context("GitHub returned no user ID")?;
    let login = text(&user, "/login").context("GitHub returned no login")?;
    let mut secrets = BTreeMap::from([("token".to_owned(), token)]);
    if let Some(secret) = webhook_secret {
        secrets.insert("webhookSecret".into(), secret);
    }
    Ok(Verified {
        provider: "github",
        external_account_id: format!("user-{id}"),
        display_name: login,
        auth_method: "github-token",
        configuration: BTreeMap::from([("auth".to_owned(), "token".to_owned())]),
        secrets,
    })
}

/// An advanced GitHub App installation, verified with a signed App JWT
/// (`verifyGitHubAppAccount`).
pub async fn verify_github_app(
    endpoints: &Endpoints,
    app_id: &str,
    installation_id: &str,
    private_key_pem: &str,
    webhook_secret: &str,
) -> Result<Verified> {
    let numeric = |value: &str| {
        let value = value.trim();
        (!value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()))
            .then(|| value.parse::<u64>().ok())
            .flatten()
    };
    let (Some(app), Some(installation)) = (numeric(app_id), numeric(installation_id)) else {
        bail!("GitHub App and installation IDs must be numeric");
    };
    ensure!(
        !private_key_pem.trim().is_empty(),
        "GitHub private key and webhook secret are required"
    );
    let webhook_secret = required(webhook_secret, "A GitHub webhook secret")?;
    let jwt = crate::github::setup_app_jwt(private_key_pem, app)?;
    let response = github_request(
        &client()?,
        endpoints
            .github
            .join(&format!("app/installations/{installation}"))?,
        &format!("Bearer {jwt}"),
    )
    .send()
    .await
    .map_err(|_| anyhow!("GitHub is unavailable"))?;
    ensure!(
        response.status().is_success(),
        "GitHub installation verification failed with HTTP {}",
        response.status().as_u16()
    );
    let body = bounded_json(response, "GitHub").await?;
    ensure!(
        body["id"].as_u64() == Some(installation),
        "GitHub returned a different installation than requested"
    );
    let login = text(&body, "/account/login").context("GitHub returned no account login")?;
    Ok(Verified {
        provider: "github",
        external_account_id: format!("installation-{installation}"),
        display_name: login,
        auth_method: "github-app",
        configuration: BTreeMap::from([
            ("auth".to_owned(), "app".to_owned()),
            ("app-id".to_owned(), app.to_string()),
            ("installation-id".to_owned(), installation.to_string()),
        ]),
        secrets: BTreeMap::from([
            ("privateKey".to_owned(), private_key_pem.to_owned()),
            ("webhookSecret".to_owned(), webhook_secret),
        ]),
    })
}

/// A Linear workspace API key and webhook signing secret (`verifyLinearAccount`).
pub async fn verify_linear(
    endpoints: &Endpoints,
    api_key: &str,
    webhook_secret: &str,
) -> Result<Verified> {
    let api_key = required(api_key, "A Linear API key")?;
    let webhook_secret = required(webhook_secret, "A Linear webhook signing secret")?;
    let response = client()?
        .post(endpoints.linear.clone())
        .header("authorization", &api_key)
        .json(&json!({
            "query": "query SuperTagLinearAccount { workspace: organization { id name urlKey } viewer { id name email } }",
            "variables": {},
        }))
        .send()
        .await
        .map_err(|_| anyhow!("Linear is unavailable"))?;
    ensure!(
        response.status().is_success(),
        "Linear verification failed with HTTP {}",
        response.status().as_u16()
    );
    let body = bounded_json(response, "Linear").await?;
    ensure!(
        body.get("errors").is_none_or(Value::is_null),
        "Linear rejected the API key"
    );
    let workspace = text(&body, "/data/workspace/id").context("Linear returned no workspace ID")?;
    Ok(Verified {
        provider: "linear",
        display_name: text(&body, "/data/workspace/name").unwrap_or_else(|| workspace.clone()),
        external_account_id: workspace,
        auth_method: "linear-api-key",
        configuration: BTreeMap::new(),
        secrets: BTreeMap::from([
            ("apiKey".to_owned(), api_key),
            ("webhookSecret".to_owned(), webhook_secret),
        ]),
    })
}

/// A Lark or Feishu App over the long connection (`verifyLarkAccount`). Rust Surface Account
/// identity also includes the tenant key, which the bot info call does not return, so the
/// operator supplies it.
pub async fn verify_lark(
    endpoints: &Endpoints,
    feishu: bool,
    app_id: &str,
    app_secret: &str,
    tenant_key: &str,
) -> Result<Verified> {
    let app_id = required(app_id, "Lark App ID")?;
    let app_secret = required(app_secret, "Lark App Secret")?;
    let tenant_key = required(tenant_key, "Lark tenant key")?;
    let origin = match &endpoints.lark {
        Some(origin) => origin.clone(),
        None if feishu => Url::parse("https://open.feishu.cn/")?,
        None => Url::parse("https://open.larksuite.com/")?,
    };
    let client = client()?;
    let response = client
        .post(origin.join("open-apis/auth/v3/tenant_access_token/internal")?)
        .json(&json!({"app_id": app_id, "app_secret": app_secret}))
        .send()
        .await
        .map_err(|_| anyhow!("Lark is unavailable"))?;
    ensure!(
        response.status().is_success(),
        "Lark token exchange failed with HTTP {}",
        response.status().as_u16()
    );
    let token = bounded_json(response, "Lark").await?;
    ensure!(
        token["code"].as_i64() == Some(0),
        "Lark credentials could not be verified: the token exchange was rejected"
    );
    let token = text(&token, "/tenant_access_token").context("Lark returned no token")?;
    let response = client
        .get(origin.join("open-apis/bot/v3/info")?)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| anyhow!("Lark is unavailable"))?;
    ensure!(
        response.status().is_success(),
        "Lark bot verification failed with HTTP {}",
        response.status().as_u16()
    );
    let bot = bounded_json(response, "Lark").await?;
    let open_id = text(&bot, "/bot/open_id").context(
        "Lark credentials could not be verified: bot/v3/info did not return bot.open_id",
    )?;
    Ok(Verified {
        provider: "lark",
        display_name: text(&bot, "/bot/app_name")
            .or_else(|| text(&bot, "/bot/name"))
            .unwrap_or_else(|| app_id.clone()),
        external_account_id: app_id,
        auth_method: "lark-long-connection",
        configuration: BTreeMap::from([
            (
                "domain".to_owned(),
                if feishu { "feishu" } else { "lark" }.to_owned(),
            ),
            ("tenant-key".to_owned(), tenant_key),
            ("bot-open-id".to_owned(), open_id),
        ]),
        secrets: BTreeMap::from([("appSecret".to_owned(), app_secret)]),
    })
}

/// The Microsoft Entra application and tenant of a Teams bot (`verifyTeamsAccount`).
pub async fn verify_teams(
    endpoints: &Endpoints,
    app_id: &str,
    app_secret: &str,
    tenant_id: &str,
    tenant_name: Option<&str>,
) -> Result<Verified> {
    let app_id = required(app_id, "Microsoft app ID")?;
    let app_secret = required(app_secret, "Microsoft app secret")?;
    let tenant_id = required(tenant_id, "Microsoft tenant ID")?;
    ensure!(
        tenant_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.')),
        "Microsoft tenant ID is not valid"
    );
    let response = client()?
        .post(
            endpoints
                .microsoft_login
                .join(&format!("{tenant_id}/oauth2/v2.0/token"))?,
        )
        .form(&[
            ("client_id", app_id.as_str()),
            ("client_secret", app_secret.as_str()),
            ("grant_type", "client_credentials"),
            ("scope", "https://api.botframework.com/.default"),
        ])
        .send()
        .await
        .map_err(|_| anyhow!("Microsoft sign-in is unavailable"))?;
    ensure!(
        response.status().is_success(),
        "Microsoft bot credentials failed verification with HTTP {}",
        response.status().as_u16()
    );
    let token = bounded_json(response, "Microsoft").await?;
    ensure!(
        text(&token, "/access_token").is_some(),
        "Microsoft returned no access token"
    );
    Ok(Verified {
        provider: "teams",
        display_name: tenant_name
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or(&tenant_id)
            .to_owned(),
        external_account_id: tenant_id,
        auth_method: "teams-client-secret",
        configuration: BTreeMap::from([("app-id".to_owned(), app_id)]),
        secrets: BTreeMap::from([("appSecret".to_owned(), app_secret)]),
    })
}
