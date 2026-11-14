//! Microsoft-signed channel activities and durable Bot Connector replies.
mod auth;
mod delivery;
#[cfg(any(test, feature = "test-fixtures"))]
#[doc(hidden)]
pub mod fixtures;
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
use serde_json::Value;
use std::{path::PathBuf, sync::Arc, time::Duration};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    MAX_MESSAGE_BYTES, connector_request,
    v2::{AcceptMicrosoftTeamsActivityRequest, connector_client::ConnectorClient},
};
use tokio::{net::TcpListener, sync::Mutex, time};
use tokio_util::sync::CancellationToken;
use tonic::Request;
use uuid::Uuid;
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(2);
const DELIVERY_TIMEOUT: Duration = Duration::from_secs(5);
pub struct MicrosoftTeamsConfig {
    pub account_id: String,
    pub app_id: String,
    pub app_secret: String,
    pub tenant_id: String,
    pub team_id: String,
    pub channel_id: String,
    pub tag_id: String,
    pub allowed_users: Vec<String>,
    pub state_directory: PathBuf,
}
#[derive(Clone)]
pub struct MicrosoftTeams(Arc<Connector>);
struct Connector {
    config: MicrosoftTeamsConfig,
    control_plane: ConnectorClient<ProtocolChannel>,
    gateway_token: String,
    account: String,
    http: reqwest::Client,
    metadata: reqwest::Url,
    token_url: reqwest::Url,
    test_origin: Option<reqwest::Url>,
    journal: Journal,
    keys: Mutex<Option<auth::Keys>>,
    token: Mutex<Option<auth::Token>>,
}
impl MicrosoftTeams {
    pub fn new(
        mut config: MicrosoftTeamsConfig,
        channel: ProtocolChannel,
        gateway_token: String,
    ) -> Result<Self> {
        ensure!(
            !config.account_id.is_empty()
                && config.account_id.len() <= 128
                && config
                    .account_id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.')),
            "invalid Microsoft Teams account"
        );
        ensure!(
            [&config.app_id, &config.tenant_id, &config.team_id]
                .iter()
                .all(|v| uuid_id(v))
                && identifier(&config.channel_id)
                && identifier(&config.tag_id),
            "invalid Microsoft Teams configured route"
        );
        ensure!(
            !config.app_secret.trim().is_empty()
                && config.app_secret.len() <= 16384
                && !config.allowed_users.is_empty()
                && config.allowed_users.iter().all(|v| uuid_id(v)),
            "Microsoft Teams credentials and allowed users are required"
        );
        config.account_id = format!("teams/{}", config.account_id);
        let account = config.account_id.clone();
        connector_request((), &gateway_token, &account)?;
        let journal = Journal::open(
            &config.state_directory,
            &config.account_id,
            "microsoft-teams",
        )?;
        let token_url = format!(
            "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
            config.tenant_id
        )
        .parse()?;
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(DELIVERY_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .build()?;
        Ok(Self(Arc::new(Connector {
            config,
            control_plane: ConnectorClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
            gateway_token,
            account,
            http,
            metadata: "https://login.botframework.com/v1/.well-known/openidconfiguration"
                .parse()?,
            token_url,
            test_origin: None,
            journal,
            keys: Mutex::new(None),
            token: Mutex::new(None),
        })))
    }
    #[cfg(feature = "test-fixtures")]
    pub fn with_test_origin(mut self, url: &str) -> Result<Self> {
        let url: reqwest::Url = url.parse()?;
        ensure!(
            url.scheme() == "http"
                && url.host_str().is_some_and(|h| h
                    .trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback()))
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
                && url.path() == "/",
            "Microsoft Teams fixture must be loopback HTTP origin"
        );
        let inner = Arc::get_mut(&mut self.0).context("configure fixture before sharing")?;
        inner.metadata = url.join("v1/.well-known/openidconfiguration")?;
        inner.token_url = url.join(&format!("{}/oauth2/v2.0/token", inner.config.tenant_id))?;
        inner.test_origin = Some(url);
        Ok(self)
    }
    pub async fn serve(self, listener: TcpListener, shutdown: CancellationToken) -> Result<()> {
        ensure!(
            listener.local_addr()?.ip().is_loopback(),
            "Microsoft Teams listener must bind loopback"
        );
        let stop = shutdown.child_token();
        let router = Router::new()
            .route("/microsoft-teams/messages", post(webhook))
            .layer(DefaultBodyLimit::max(128 * 1024))
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
                .context("serve Microsoft Teams")
        };
        let delivery = self.0.deliver(&stop);
        tokio::pin!(web, delivery);
        tokio::select! {result=&mut web=>{stop.cancel();result.and(delivery.await)},result=&mut delivery=>{stop.cancel();result.and(web.await)}}
    }
}
impl Connector {
    fn request<T>(&self, value: T, timeout: Duration) -> Result<Request<T>> {
        let mut request = connector_request(value, &self.gateway_token, &self.account)?;
        request.set_timeout(timeout);
        Ok(request)
    }
}
async fn deadline(request: HttpRequest, next: Next) -> Response {
    match time::timeout(Duration::from_secs(9), next.run(request)).await {
        Ok(value) => value,
        Err(_) => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}
async fn webhook(State(teams): State<MicrosoftTeams>, headers: HeaderMap, body: Bytes) -> Response {
    let mut headers = headers.get_all("authorization").iter();
    let Some(token) = headers
        .next()
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if headers.next().is_some() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let body: Value = match serde_json::from_slice(&body) {
        Ok(body) => body,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    let Some(url) = body["serviceUrl"].as_str() else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    match teams.0.authenticate(token, url).await {
        Ok(()) => {}
        Err(auth::AuthFailure::Rejected) => return StatusCode::UNAUTHORIZED.into_response(),
        Err(auth::AuthFailure::Unavailable) => {
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
    }
    let input = match normalize(&teams.0.config, &body) {
        Ok(Some(value)) => value,
        Ok(None) => return StatusCode::OK.into_response(),
        Err(_) => return StatusCode::FORBIDDEN.into_response(),
    };
    let request = match teams.0.request(input, ACCEPT_TIMEOUT) {
        Ok(value) => value,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    match time::timeout(
        ACCEPT_TIMEOUT,
        teams
            .0
            .control_plane
            .clone()
            .accept_microsoft_teams_activity(request),
    )
    .await
    {
        Ok(Ok(_)) => StatusCode::OK,
        Ok(Err(error)) if error.code() == tonic::Code::AlreadyExists => StatusCode::CONFLICT,
        Ok(Err(error)) if error.code() == tonic::Code::PermissionDenied => StatusCode::FORBIDDEN,
        _ => StatusCode::SERVICE_UNAVAILABLE,
    }
    .into_response()
}
fn normalize(
    config: &MicrosoftTeamsConfig,
    body: &Value,
) -> Result<Option<AcceptMicrosoftTeamsActivityRequest>> {
    if body["type"] != "message" || body["channelId"] != "msteams" {
        return Ok(None);
    }
    ensure!(
        body.pointer("/channelData/tenant/id")
            .and_then(Value::as_str)
            == Some(config.tenant_id.as_str())
            && body
                .pointer("/conversation/tenantId")
                .and_then(Value::as_str)
                .is_none_or(|id| id == config.tenant_id),
        "Microsoft Teams tenant mismatch"
    );
    let recipient = body
        .pointer("/recipient/id")
        .and_then(Value::as_str)
        .context("Microsoft recipient missing")?;
    ensure!(
        recipient == format!("28:{}", config.app_id) || recipient == config.app_id,
        "Microsoft Teams recipient mismatch"
    );
    if body
        .pointer("/conversation/conversationType")
        .and_then(Value::as_str)
        != Some("channel")
    {
        return Ok(None);
    }
    let team = body
        .pointer("/channelData/team/aadGroupId")
        .or_else(|| body.pointer("/channelData/team/id"))
        .and_then(Value::as_str);
    if team != Some(config.team_id.as_str())
        || body
            .pointer("/channelData/channel/id")
            .and_then(Value::as_str)
            != Some(config.channel_id.as_str())
    {
        return Ok(None);
    }
    let actor = body
        .pointer("/from/aadObjectId")
        .or_else(|| body.pointer("/from/id"))
        .and_then(Value::as_str)
        .context("Microsoft Teams actor missing")?;
    let sender = required(body, "/from/id")?;
    if body.pointer("/from/role").and_then(Value::as_str) == Some("bot")
        || sender == recipient
        || sender == config.app_id
        || !config.allowed_users.iter().any(|user| user == actor)
    {
        return Ok(None);
    }
    let Some(entities) = body["entities"].as_array() else {
        return Ok(None);
    };
    ensure!(entities.len() <= 128, "too many activity entities");
    let mentions: Vec<_> = entities
        .iter()
        .filter(|e| {
            e["type"] == "mention"
                && e.pointer("/mentioned/id").and_then(Value::as_str) == Some(recipient)
        })
        .collect();
    if mentions.is_empty() {
        return Ok(None);
    }
    let mut prompt = body["text"].as_str().unwrap_or("").to_string();
    for mention in mentions {
        if let Some(text) = mention["text"].as_str().filter(|v| !v.is_empty()) {
            prompt = prompt.replace(text, "");
        }
    }
    let prompt = prompt
        .trim()
        .trim_start_matches([':', ',', ';', '-'])
        .trim();
    if prompt.is_empty() {
        return Ok(None);
    }
    ensure!(
        prompt.len() <= 128 * 1024,
        "Microsoft Teams prompt too large"
    );
    let activity = required(body, "/id")?;
    let root = body["replyToId"].as_str().unwrap_or(activity);
    ensure!(numeric_id(root), "invalid Microsoft Teams root activity");
    let incoming_conversation = required(body, "/conversation/id")?;
    let conversation = if let Some((base, suffix)) = incoming_conversation.split_once(';') {
        ensure!(
            suffix == format!("messageid={root}"),
            "Microsoft Teams thread suffix does not match root activity"
        );
        base
    } else {
        incoming_conversation
    };
    let service = service_url(required(body, "/serviceUrl")?)?;
    Ok(Some(AcceptMicrosoftTeamsActivityRequest {
        account_id: config.account_id.clone(),
        app_id: config.app_id.clone(),
        tenant_id: config.tenant_id.clone(),
        team_id: config.team_id.clone(),
        channel_id: config.channel_id.clone(),
        conversation_id: conversation.into(),
        activity_id: activity.into(),
        root_activity_id: root.into(),
        actor_id: actor.into(),
        service_url: service.to_string(),
        prompt: prompt.into(),
        tag_id: config.tag_id.clone(),
    }))
}
fn required<'a>(body: &'a Value, pointer: &str) -> Result<&'a str> {
    body.pointer(pointer)
        .and_then(Value::as_str)
        .filter(|v| identifier(v))
        .context("invalid Microsoft Teams identifier")
}
fn identifier(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}
fn uuid_id(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| !id.is_nil() && id.hyphenated().to_string() == value)
}
fn numeric_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value.bytes().all(|b| b.is_ascii_digit())
        && value.bytes().any(|b| b != b'0')
}
fn service_url(value: &str) -> Result<reqwest::Url> {
    let mut url: reqwest::Url = value
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid Microsoft service URL"))?;
    ensure!(
        value.len() <= 2048
            && url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.port().is_none()
            && url
                .host_str()
                .is_some_and(|h| h.contains('.') && h.parse::<std::net::IpAddr>().is_err()),
        "invalid Microsoft service URL"
    );
    url.set_path(&format!("{}/", url.path().trim_end_matches('/')));
    Ok(url)
}
async fn bounded_json(mut response: reqwest::Response) -> Result<Value> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("Microsoft response unavailable"))?
    {
        ensure!(
            chunk.len() <= 128 * 1024 - bytes.len(),
            "Microsoft response too large"
        );
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("invalid Microsoft JSON response"))
}
