//! Signed Linear events and journaled issue comments. No credentials reach Tasks.
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
use serde_json::{Value, json};
use sha2::Sha256;
use std::{path::PathBuf, sync::Arc, time::Duration};
use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request,
    v2::{
        AcceptLinearEventRequest, LinearEventAction, LinearEventKind,
        connector_client::ConnectorClient,
    },
};
use tokio::{net::TcpListener, time};
use tokio_util::sync::CancellationToken;
use tonic::{Request, transport::Channel};
use uuid::Uuid;

const ACCEPT_TIMEOUT: Duration = Duration::from_secs(2);
const DELIVERY_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_WEBHOOK_BYTES: usize = 128 * 1024;

pub struct LinearConfig {
    /// Configured human-readable ID; qualified internally as linear/<ID>.
    pub account_id: String,
    pub workspace_id: String,
    pub team_id: String,
    pub tag_id: String,
    pub allowed_users: Vec<String>,
    pub webhook_secret: String,
    pub api_key: String,
    pub state_directory: PathBuf,
}

#[derive(Clone)]
pub struct Linear(Arc<Connector>);

struct Connector {
    config: LinearConfig,
    control_plane: ConnectorClient<Channel>,
    gateway_token: String,
    principal: String,
    http: reqwest::Client,
    api_base: reqwest::Url,
    journal: Journal,
}

impl Linear {
    pub fn new(
        mut config: LinearConfig,
        private_channel: Channel,
        gateway_token: String,
    ) -> Result<Self> {
        ensure!(
            !config.account_id.is_empty()
                && config.account_id.len() <= 128
                && config
                    .account_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')),
            "invalid Linear account ID"
        );
        ensure!(
            canonical_uuid(&config.workspace_id) && canonical_uuid(&config.team_id),
            "invalid Linear workspace or team configuration"
        );
        ensure!(
            !config.tag_id.trim().is_empty() && config.tag_id.len() <= 256,
            "Linear Tag ID is required"
        );
        ensure!(
            !config.allowed_users.is_empty()
                && config.allowed_users.iter().all(|id| canonical_uuid(id)),
            "configure valid Linear user IDs"
        );
        ensure!(
            !config.webhook_secret.trim().is_empty() && !config.api_key.trim().is_empty(),
            "Linear webhook secret and API key are required"
        );
        config.account_id = format!("linear/{}", config.account_id);
        let principal = format!("connector:{}", config.account_id);
        authenticated_request((), &gateway_token, Some(&principal))
            .context("invalid Linear connector credential")?;
        let journal = Journal::open(&config.state_directory, &config.account_id, "linear")?;
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
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
            principal,
            http,
            api_base: "https://api.linear.app/graphql".parse()?,
            journal,
        })))
    }

    #[cfg(feature = "test-fixtures")]
    pub fn with_test_api_url(mut self, url: &str) -> Result<Self> {
        let mut url: reqwest::Url = url.parse().context("invalid test Linear API URL")?;
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
                && url.path() == "/graphql",
            "test Linear API URL must be a loopback HTTP origin"
        );
        url.set_path("/graphql");
        Arc::get_mut(&mut self.0)
            .context("set test Linear URL before sharing connector")?
            .api_base = url;
        Ok(self)
    }

    pub async fn serve(self, listener: TcpListener, shutdown: CancellationToken) -> Result<()> {
        ensure!(
            listener.local_addr()?.ip().is_loopback(),
            "Linear webhook listener must bind to loopback"
        );
        let stop = shutdown.child_token();
        let router = Router::new()
            .route("/linear/events", post(webhook))
            .layer(DefaultBodyLimit::max(MAX_WEBHOOK_BYTES))
            .layer(middleware::from_fn(deadline))
            .with_state(self.clone());
        let web = async {
            axum::serve(listener, router)
                .with_graceful_shutdown(stop.clone().cancelled_owned())
                .await
                .context("serve Linear webhooks")
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
        let mut request = authenticated_request(input, &self.gateway_token, Some(&self.principal))?;
        request.set_timeout(deadline);
        Ok(request)
    }
}

async fn deadline(request: HttpRequest, next: Next) -> Response {
    match time::timeout(Duration::from_millis(4500), next.run(request)).await {
        Ok(response) => response,
        Err(_) => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}

async fn webhook(State(linear): State<Linear>, headers: HeaderMap, body: Bytes) -> Response {
    let connector = &linear.0;
    if !verify(&headers, &body, &connector.config.webhook_secret) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(delivery) = one_header(&headers, "linear-delivery").filter(|id| valid_delivery(id))
    else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Some(event) = one_header(&headers, "linear-event") else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let candidate = match normalize(&connector.config, delivery, event, &body, now) {
        Ok(Some(input)) => input,
        Ok(None) => return StatusCode::OK.into_response(),
        Err(status) => return status.into_response(),
    };
    let mut input = candidate.input;
    if candidate.lookup_issue {
        let result = connector
            .graphql(
                "query SuperTagLinearIssue($id: String!) { issue(id: $id) { id team { id } } }",
                json!({"id": input.issue_id}),
                ACCEPT_TIMEOUT,
            )
            .await;
        let Ok(value) = result else {
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        };
        match resolved_issue(&value, &input.issue_id, &connector.config.team_id) {
            Ok(team) => input.team_id = team,
            Err(status) => return status.into_response(),
        }
    }
    let Ok(request) = connector.request(input, ACCEPT_TIMEOUT) else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    match time::timeout(
        ACCEPT_TIMEOUT,
        connector.control_plane.clone().accept_linear_event(request),
    )
    .await
    {
        Ok(Ok(_)) => StatusCode::OK.into_response(),
        Ok(Err(status)) if status.code() == tonic::Code::AlreadyExists => {
            StatusCode::CONFLICT.into_response()
        }
        _ => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}

#[derive(Debug)]
enum GraphqlFailure {
    Rejected,
    Uncertain,
}
impl Connector {
    async fn graphql(
        &self,
        query: &str,
        variables: Value,
        deadline: Duration,
    ) -> Result<Value, GraphqlFailure> {
        let mut response = self
            .http
            .post(self.api_base.clone())
            .timeout(deadline)
            .header("authorization", &self.config.api_key)
            .header("user-agent", "supertag-gateway")
            .json(&json!({"query":query,"variables":variables}))
            .send()
            .await
            .map_err(|_| GraphqlFailure::Uncertain)?;
        if matches!(
            response.status().as_u16(),
            400 | 401 | 403 | 404 | 405 | 410 | 422 | 429
        ) {
            return Err(GraphqlFailure::Rejected);
        }
        if response.status() != reqwest::StatusCode::OK {
            return Err(GraphqlFailure::Uncertain);
        }
        let mut bytes = Vec::new();
        const MAX_RESPONSE: usize = 128 * 1024;
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) if chunk.len() <= MAX_RESPONSE - bytes.len() => {
                    bytes.extend_from_slice(&chunk)
                }
                Ok(None) => break,
                _ => return Err(GraphqlFailure::Uncertain),
            }
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| GraphqlFailure::Uncertain)?;
        // A GraphQL response may contain both data and errors after a side effect.
        // Do not claim a failed write or expose provider errors that may echo a key.
        if value
            .get("errors")
            .is_some_and(|v| !v.is_null() && v.as_array().is_none_or(|e| !e.is_empty()))
        {
            return Err(GraphqlFailure::Uncertain);
        }
        Ok(value)
    }
}
fn resolved_issue(value: &Value, expected: &str, team: &str) -> Result<String, StatusCode> {
    if value.pointer("/data/issue/id").and_then(Value::as_str) != Some(expected) {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    match value.pointer("/data/issue/team/id").and_then(Value::as_str) {
        Some(id) if id == team => Ok(id.into()),
        Some(_) => Err(StatusCode::FORBIDDEN),
        None => Err(StatusCode::SERVICE_UNAVAILABLE),
    }
}
fn one_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let first = values.next()?.to_str().ok()?;
    values.next().is_none().then_some(first)
}
fn verify(headers: &HeaderMap, body: &[u8], secret: &str) -> bool {
    let Some(signature) = one_header(headers, "linear-signature") else {
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
    actor: Actor,
    data: Value,
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "organizationId")]
    workspace_id: String,
    #[serde(rename = "webhookTimestamp")]
    timestamp: u64,
}
#[derive(Deserialize)]
struct Actor {
    id: String,
    #[serde(rename = "type")]
    kind: String,
}
struct Candidate {
    input: AcceptLinearEventRequest,
    lookup_issue: bool,
}
fn normalize(
    config: &LinearConfig,
    delivery: &str,
    event: &str,
    bytes: &[u8],
    now_ms: u128,
) -> Result<Option<Candidate>, StatusCode> {
    let value: Payload = serde_json::from_slice(bytes).map_err(|_| StatusCode::BAD_REQUEST)?;
    if now_ms.abs_diff(u128::from(value.timestamp)) > 60_000 {
        return Err(StatusCode::UNAUTHORIZED);
    }
    if value.workspace_id != config.workspace_id {
        return Err(StatusCode::FORBIDDEN);
    }
    if !event.eq_ignore_ascii_case(&value.kind) {
        return Err(StatusCode::BAD_REQUEST);
    }
    if !value.actor.kind.eq_ignore_ascii_case("user")
        || !config.allowed_users.contains(&value.actor.id)
    {
        return Ok(None);
    }
    let action = match value.action.as_str() {
        "create" => LinearEventAction::Create,
        "update" => LinearEventAction::Update,
        _ => return Ok(None),
    };
    let (kind, issue, source, prompt, lookup_issue) = match value.kind.as_str() {
        "Issue" => {
            if value.data.get("teamId").and_then(Value::as_str) != Some(config.team_id.as_str()) {
                return Err(StatusCode::FORBIDDEN);
            }
            (
                LinearEventKind::Issue,
                value.data.get("id"),
                value.data.get("id"),
                value.data.get("description"),
                false,
            )
        }
        "Comment" => (
            LinearEventKind::IssueComment,
            value.data.get("issueId"),
            value.data.get("id"),
            value.data.get("body"),
            true,
        ),
        _ => return Ok(None),
    };
    let Some(prompt) = prompt
        .and_then(Value::as_str)
        .filter(|text| mentioned(text))
    else {
        return Ok(None);
    };
    let issue = issue
        .and_then(Value::as_str)
        .filter(|id| canonical_uuid(id))
        .ok_or(StatusCode::BAD_REQUEST)?;
    let source = source
        .and_then(Value::as_str)
        .filter(|id| canonical_uuid(id))
        .ok_or(StatusCode::BAD_REQUEST)?;
    Ok(Some(Candidate {
        lookup_issue,
        input: AcceptLinearEventRequest {
            account_id: config.account_id.clone(),
            delivery_id: delivery.into(),
            workspace_id: config.workspace_id.clone(),
            team_id: config.team_id.clone(),
            issue_id: issue.into(),
            source_id: source.into(),
            kind: kind.into(),
            action: action.into(),
            prompt: prompt.into(),
            tag_id: config.tag_id.clone(),
        },
    }))
}
fn mentioned(text: &str) -> bool {
    text.split_whitespace().any(|part| {
        part.trim_end_matches([']', '[', '(', ')', ',', '.', ':', ';', '!', '?', '{', '}'])
            .eq_ignore_ascii_case("@supertag")
    })
}
fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| !id.is_nil() && id.hyphenated().to_string() == value)
}
fn valid_delivery(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
