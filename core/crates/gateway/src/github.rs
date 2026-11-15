//! Signed GitHub events and journaled issue/PR comments. No credentials reach Tasks.
#[cfg(test)]
mod auth_tests;
mod delivery;
#[cfg(test)]
mod tests;

use crate::delivery_journal::Journal;
use anyhow::{Context, Result, ensure};
use axum::{
    Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Request as HttpRequest, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::post,
};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use std::{path::PathBuf, sync::Arc, time::Duration};
pub(crate) use supertag_github::setup_app_jwt;
pub use supertag_github::{GithubAppConfig, GithubAuthentication};
use supertag_github::{REQUEST_TIMEOUT as DELIVERY_TIMEOUT, auth, valid_id, valid_repository};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    MAX_MESSAGE_BYTES, connector_request,
    v2::{
        AcceptGithubEventRequest, GithubEventAction, GithubEventKind,
        connector_client::ConnectorClient,
    },
};
use tokio::{net::TcpListener, time};
use tokio_util::sync::CancellationToken;
use tonic::Request;

const ACCEPT_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_WEBHOOK_BYTES: usize = 128 * 1024;

pub struct GithubConfig {
    /// Configured human-readable ID; qualified internally as github/<ID>.
    pub account_id: String,
    pub repository_id: u64,
    pub repository: String,
    pub tag_id: String,
    pub allowed_users: Vec<u64>,
    pub webhook_secret: String,
    pub authentication: GithubAuthentication,
    pub state_directory: PathBuf,
}

#[derive(Clone)]
pub struct Github(Arc<Connector>);

struct Connector {
    config: GithubConfig,
    control_plane: ConnectorClient<ProtocolChannel>,
    gateway_token: String,
    account: String,
    http: reqwest::Client,
    api_base: reqwest::Url,
    journal: Journal,
    authentication: auth::Authentication,
}

impl Github {
    pub fn new(
        mut config: GithubConfig,
        private_channel: ProtocolChannel,
        gateway_token: String,
    ) -> Result<Self> {
        ensure!(
            !config.account_id.is_empty()
                && config.account_id.len() <= 128
                && config
                    .account_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')),
            "invalid GitHub account ID"
        );
        ensure!(
            valid_id(config.repository_id) && valid_repository(&config.repository),
            "invalid GitHub repository configuration"
        );
        ensure!(
            !config.tag_id.trim().is_empty() && config.tag_id.len() <= 256,
            "GitHub Tag ID is required"
        );
        ensure!(
            !config.allowed_users.is_empty() && config.allowed_users.iter().all(|id| valid_id(*id)),
            "configure valid GitHub user IDs"
        );
        ensure!(
            !config.webhook_secret.trim().is_empty(),
            "GitHub webhook secret is required"
        );
        config.account_id = format!("github/{}", config.account_id);
        config.repository = config.repository.to_ascii_lowercase();
        let authentication = auth::Authentication::new(
            &config.authentication,
            config.repository_id,
            &config.repository,
        )?;
        let account = config.account_id.clone();
        connector_request((), &gateway_token, &account)
            .context("invalid GitHub connector credential")?;
        let journal = Journal::open(&config.state_directory, &config.account_id, "github")?;
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .timeout(DELIVERY_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .build()?;
        Ok(Self(Arc::new(Connector {
            config,
            control_plane: ConnectorClient::new(private_channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
            gateway_token,
            account,
            http,
            api_base: "https://api.github.com/".parse()?,
            journal,
            authentication,
        })))
    }

    #[cfg(any(test, feature = "test-fixtures"))]
    pub fn with_test_api_url(mut self, url: &str) -> Result<Self> {
        let mut url: reqwest::Url = url.parse().context("invalid test GitHub API URL")?;
        ensure!(
            url.scheme() == "http"
                && url.host_str().is_some_and(|host| host
                    .trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback()))
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
                && url.path() == "/",
            "test GitHub API URL must be a loopback HTTP origin"
        );
        url.set_path("/");
        Arc::get_mut(&mut self.0)
            .context("set test GitHub URL before sharing connector")?
            .api_base = url;
        Ok(self)
    }

    pub async fn serve(self, listener: TcpListener, shutdown: CancellationToken) -> Result<()> {
        ensure!(
            listener.local_addr()?.ip().is_loopback(),
            "GitHub webhook listener must bind to loopback"
        );
        let stop = shutdown.child_token();
        let router = Router::new()
            .route("/github/events", post(webhook))
            .layer(DefaultBodyLimit::max(MAX_WEBHOOK_BYTES))
            .layer(middleware::from_fn(deadline))
            .layer(middleware::from_fn_with_state(
                stop.clone(),
                crate::ownership::refuse_while_draining,
            ))
            .with_state(self.clone());
        let web = async {
            axum::serve(listener, router)
                .with_graceful_shutdown(stop.clone().cancelled_owned())
                .await
                .context("serve GitHub webhooks")
        };
        let delivery = self.0.deliver(&stop);
        tokio::pin!(web, delivery);
        tokio::select! {
            result=&mut web => {stop.cancel(); result.and(delivery.await)},
            result=&mut delivery => {stop.cancel(); result.and(web.await)},
        }
    }
}

impl Connector {
    fn request<T>(&self, input: T, deadline: Duration) -> Result<Request<T>> {
        let mut request = connector_request(input, &self.gateway_token, &self.account)?;
        request.set_timeout(deadline);
        Ok(request)
    }
}

async fn deadline(request: HttpRequest, next: Next) -> Response {
    match time::timeout(Duration::from_millis(2500), next.run(request)).await {
        Ok(response) => response,
        Err(_) => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}

async fn webhook(State(github): State<Github>, headers: HeaderMap, body: Bytes) -> Response {
    let connector = &github.0;
    if !verify(&headers, &body, &connector.config.webhook_secret) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(delivery) = one_header(&headers, "x-github-delivery").filter(|id| {
        !id.is_empty()
            && id.len() <= 256
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    }) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Some(event) = one_header(&headers, "x-github-event") else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let input = match normalize(&connector.config, delivery, event, &body) {
        Ok(Some(input)) => input,
        Ok(None) => return StatusCode::ACCEPTED.into_response(),
        Err(status) => return status.into_response(),
    };
    let Ok(request) = connector.request(input, ACCEPT_TIMEOUT) else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    match time::timeout(
        ACCEPT_TIMEOUT,
        connector.control_plane.clone().accept_github_event(request),
    )
    .await
    {
        Ok(Ok(_)) => StatusCode::ACCEPTED.into_response(),
        Ok(Err(status)) if status.code() == tonic::Code::AlreadyExists => {
            StatusCode::CONFLICT.into_response()
        }
        _ => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}

fn one_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let first = values.next()?.to_str().ok()?;
    values.next().is_none().then_some(first)
}

fn verify(headers: &HeaderMap, body: &[u8], secret: &str) -> bool {
    let Some(signature) =
        one_header(headers, "x-hub-signature-256").and_then(|value| value.strip_prefix("sha256="))
    else {
        return false;
    };
    let mut bytes = [0u8; 32];
    if hex::decode_to_slice(signature, &mut bytes).is_err() {
        return false;
    }
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(body);
    mac.verify_slice(&bytes).is_ok()
}

#[derive(Deserialize)]
struct Payload {
    action: String,
    sender: Actor,
    repository: Repository,
    issue: Option<Item>,
    pull_request: Option<Item>,
    comment: Option<Item>,
    installation: Option<Installation>,
}
#[derive(Deserialize)]
struct Installation {
    id: u64,
}
#[derive(Deserialize)]
struct Actor {
    id: u64,
    #[serde(rename = "type")]
    kind: String,
}
#[derive(Deserialize)]
struct Repository {
    id: u64,
    full_name: String,
}
#[derive(Deserialize)]
struct Item {
    id: Option<u64>,
    number: Option<u64>,
    body: Option<String>,
    pull_request: Option<serde_json::Value>,
}

fn normalize(
    config: &GithubConfig,
    delivery: &str,
    event: &str,
    body: &[u8],
) -> Result<Option<AcceptGithubEventRequest>, StatusCode> {
    if !matches!(event, "issue_comment" | "issues" | "pull_request") {
        return Ok(None);
    }
    let payload: Payload = serde_json::from_slice(body).map_err(|_| StatusCode::BAD_REQUEST)?;
    if let GithubAuthentication::App(app) = &config.authentication
        && payload
            .installation
            .as_ref()
            .map(|installation| installation.id)
            != Some(app.installation_id)
    {
        return Err(StatusCode::FORBIDDEN);
    }
    if payload.repository.id != config.repository_id
        || !payload
            .repository
            .full_name
            .eq_ignore_ascii_case(&config.repository)
    {
        return Err(StatusCode::FORBIDDEN);
    }
    if !payload.sender.kind.eq_ignore_ascii_case("User")
        || !config.allowed_users.contains(&payload.sender.id)
    {
        return Ok(None);
    }
    let action = match payload.action.as_str() {
        "created" => GithubEventAction::Created,
        "opened" => GithubEventAction::Opened,
        "edited" => GithubEventAction::Edited,
        _ => return Ok(None),
    };
    let (kind, item, number, is_pull) = match event {
        "issue_comment"
            if matches!(
                action,
                GithubEventAction::Created | GithubEventAction::Edited
            ) =>
        {
            let issue = payload.issue.ok_or(StatusCode::BAD_REQUEST)?;
            (
                GithubEventKind::IssueComment,
                payload.comment.ok_or(StatusCode::BAD_REQUEST)?,
                issue.number,
                issue.pull_request.is_some(),
            )
        }
        "issues"
            if matches!(
                action,
                GithubEventAction::Opened | GithubEventAction::Edited
            ) =>
        {
            let issue = payload.issue.ok_or(StatusCode::BAD_REQUEST)?;
            let number = issue.number;
            (GithubEventKind::Issue, issue, number, false)
        }
        "pull_request"
            if matches!(
                action,
                GithubEventAction::Opened | GithubEventAction::Edited
            ) =>
        {
            let pr = payload.pull_request.ok_or(StatusCode::BAD_REQUEST)?;
            let number = pr.number;
            (GithubEventKind::PullRequest, pr, number, true)
        }
        _ => return Ok(None),
    };
    let number = number
        .filter(|number| valid_id(*number))
        .ok_or(StatusCode::BAD_REQUEST)?;
    let source_id = item
        .id
        .filter(|id| valid_id(*id))
        .ok_or(StatusCode::BAD_REQUEST)?;
    let Some(prompt) = item.body.filter(|body| mentioned(body)) else {
        return Ok(None);
    };
    Ok(Some(AcceptGithubEventRequest {
        account_id: config.account_id.clone(),
        delivery_id: delivery.into(),
        repository_id: config.repository_id,
        repository: config.repository.clone(),
        number,
        source_id,
        kind: kind.into(),
        action: action.into(),
        prompt,
        tag_id: config.tag_id.clone(),
        is_pull_request: is_pull,
    }))
}

fn mentioned(text: &str) -> bool {
    text.split_whitespace().any(|part| {
        part.trim_end_matches([')', ',', '.', ':', ';', '!', '?'])
            .eq_ignore_ascii_case("@supertag")
    })
}
