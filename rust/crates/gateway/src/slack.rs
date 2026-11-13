//! Slack Events API ingress and durable thread replies.

mod delivery;

use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, ensure};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Request as HttpRequest, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::post,
};
use delivery::Journal;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::json;
use sha2::Sha256;
use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request,
    v2::{AcceptSlackEventRequest, connector_client::ConnectorClient},
};
use tokio::{net::TcpListener, time};
use tokio_util::sync::CancellationToken;
use tonic::{Request, transport::Channel};

const ACCEPT_TIMEOUT: Duration = Duration::from_secs(2);
const WEBHOOK_TIMEOUT: Duration = Duration::from_millis(2500);
const DELIVERY_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_WEBHOOK_BYTES: usize = 128 * 1024;
const POST_MESSAGE: &str = "https://slack.com/api/chat.postMessage";

pub struct SlackConfig {
    pub account_id: String,
    pub team_id: String,
    pub channel_id: String,
    pub tag_id: String,
    pub allowed_users: Vec<String>,
    pub signing_secret: String,
    pub bot_token: String,
    pub state_directory: PathBuf,
}

#[derive(Clone)]
pub struct Slack(Arc<Connector>);

struct Connector {
    config: SlackConfig,
    control_plane: ConnectorClient<Channel>,
    gateway_token: String,
    principal: String,
    http: reqwest::Client,
    post_message: reqwest::Url,
    journal: Journal,
}

impl Slack {
    pub fn new(
        config: SlackConfig,
        private_channel: Channel,
        gateway_token: String,
    ) -> Result<Self> {
        ensure!(
            !config.account_id.is_empty()
                && config.account_id.len() <= 128
                && config
                    .account_id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)),
            "invalid Slack Surface Account ID"
        );
        ensure!(
            slack_id(&config.team_id, b"T"),
            "invalid Slack workspace ID"
        );
        ensure!(
            slack_id(&config.channel_id, b"CG"),
            "invalid Slack channel ID"
        );
        ensure!(!config.tag_id.trim().is_empty(), "Slack Tag ID is required");
        ensure!(
            !config.allowed_users.is_empty()
                && config
                    .allowed_users
                    .iter()
                    .all(|user| slack_id(user, b"UW")),
            "configure at least one valid Slack user ID"
        );
        ensure!(
            !config.signing_secret.trim().is_empty() && !config.bot_token.trim().is_empty(),
            "Slack signing secret and bot token are required"
        );
        let principal = format!("connector:{}", config.account_id);
        authenticated_request((), &gateway_token, Some(&principal))
            .context("invalid private Slack connector credential")?;
        let journal = Journal::open(&config.state_directory, &config.account_id, "slack")?;
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
            principal,
            http,
            post_message: POST_MESSAGE.parse()?,
            journal,
        })))
    }

    #[cfg(feature = "test-fixtures")]
    pub fn with_test_reply_url(mut self, url: &str) -> Result<Self> {
        let url: reqwest::Url = url.parse().context("invalid test Slack reply URL")?;
        let loopback = url.host_str().is_some_and(|host| {
            host.trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|address| address.is_loopback())
        });
        ensure!(
            loopback
                && url.scheme() == "http"
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none(),
            "test Slack reply URL must use HTTP and a loopback IP"
        );
        Arc::get_mut(&mut self.0)
            .context("set test Slack URL before sharing the connector")?
            .post_message = url;
        Ok(self)
    }

    pub async fn serve(self, listener: TcpListener, shutdown: CancellationToken) -> Result<()> {
        ensure!(
            listener.local_addr()?.ip().is_loopback(),
            "Slack webhook listener must bind to loopback"
        );
        let stop = shutdown.child_token();
        let router = Router::new()
            .route("/slack/events", post(webhook))
            .layer(DefaultBodyLimit::max(MAX_WEBHOOK_BYTES))
            .layer(middleware::from_fn(webhook_deadline))
            .with_state(self.clone());
        let web = async {
            axum::serve(listener, router)
                .with_graceful_shutdown(stop.clone().cancelled_owned())
                .await
                .context("serve Slack webhooks")
        };
        let deliver = self.0.deliver(&stop);
        tokio::pin!(web, deliver);
        tokio::select! {
            web_result = &mut web => {
                stop.cancel();
                web_result.and(deliver.await)
            }
            delivery_result = &mut deliver => {
                stop.cancel();
                delivery_result.and(web.await)
            }
        }
    }
}

async fn webhook_deadline(request: HttpRequest, next: Next) -> Response {
    match time::timeout(WEBHOOK_TIMEOUT, next.run(request)).await {
        Ok(response) => response,
        Err(_) => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}

impl Connector {
    fn request<T>(&self, message: T, deadline: Duration) -> Result<Request<T>> {
        let mut request =
            authenticated_request(message, &self.gateway_token, Some(&self.principal))?;
        request.set_timeout(deadline);
        Ok(request)
    }
}

async fn webhook(State(slack): State<Slack>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let connector = &slack.0;
    if !verify_signature(
        &headers,
        &body,
        &connector.config.signing_secret,
        now.as_secs(),
    ) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match normalize(&connector.config, &body) {
        Ok(Ingress::Challenge(challenge)) => {
            Json(json!({ "challenge": challenge })).into_response()
        }
        Ok(Ingress::Ignore) => StatusCode::OK.into_response(),
        Ok(Ingress::Accept(event)) => {
            let Ok(request) = connector.request(event, ACCEPT_TIMEOUT) else {
                return StatusCode::SERVICE_UNAVAILABLE.into_response();
            };
            let mut control_plane = connector.control_plane.clone();
            supertag_protocol::crash_point("gateway.slack-admission", "before-forward");
            match time::timeout(ACCEPT_TIMEOUT, control_plane.accept_slack_event(request)).await {
                Ok(Ok(_)) => {
                    supertag_protocol::crash_point("gateway.slack-admission", "after-forward");
                    StatusCode::OK.into_response()
                }
                Ok(Err(error)) if error.code() == tonic::Code::AlreadyExists => {
                    StatusCode::CONFLICT.into_response()
                }
                _ => StatusCode::SERVICE_UNAVAILABLE.into_response(),
            }
        }
        Err(status) => status.into_response(),
    }
}

fn verify_signature(headers: &HeaderMap, body: &[u8], secret: &str, now: u64) -> bool {
    fn one_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
        let mut values = headers.get_all(name).iter();
        let value = values.next()?.to_str().ok()?;
        values.next().is_none().then_some(value)
    }
    let Some(timestamp) = one_header(headers, "x-slack-request-timestamp") else {
        return false;
    };
    if timestamp.len() > 20
        || !timestamp.bytes().all(|b| b.is_ascii_digit())
        || !timestamp
            .parse::<u64>()
            .is_ok_and(|timestamp| timestamp.abs_diff(now) <= 300)
    {
        return false;
    }
    let Some(signature) =
        one_header(headers, "x-slack-signature").and_then(|v| v.strip_prefix("v0="))
    else {
        return false;
    };
    let mut digest = [0_u8; 32];
    if hex::decode_to_slice(signature, &mut digest).is_err() {
        return false;
    }
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(b"v0:");
    mac.update(timestamp.as_bytes());
    mac.update(b":");
    mac.update(body);
    mac.verify_slice(&digest).is_ok()
}

enum Ingress {
    Challenge(String),
    Accept(AcceptSlackEventRequest),
    Ignore,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Payload {
    UrlVerification {
        challenge: String,
    },
    EventCallback {
        team_id: String,
        event_id: String,
        event: Box<Event>,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct Event {
    #[serde(rename = "type")]
    kind: String,
    channel: Option<String>,
    user: Option<String>,
    bot_id: Option<String>,
    subtype: Option<String>,
    text: Option<String>,
    ts: Option<String>,
    thread_ts: Option<String>,
}

fn normalize(config: &SlackConfig, body: &[u8]) -> Result<Ingress, StatusCode> {
    match serde_json::from_slice(body).map_err(|_| StatusCode::BAD_REQUEST)? {
        Payload::UrlVerification { challenge }
            if !challenge.is_empty() && challenge.len() <= 1024 =>
        {
            Ok(Ingress::Challenge(challenge))
        }
        Payload::UrlVerification { .. } => Err(StatusCode::BAD_REQUEST),
        Payload::Other => Ok(Ingress::Ignore),
        Payload::EventCallback {
            team_id,
            event_id,
            event,
        } => {
            if team_id != config.team_id {
                return Err(StatusCode::FORBIDDEN);
            }
            let mention = event.kind == "app_mention";
            let reply = event.kind == "message" && event.thread_ts.is_some();
            if (!mention && !reply)
                || event.bot_id.is_some()
                || event.subtype.is_some()
                || event.channel.as_deref() != Some(&config.channel_id)
                || !event
                    .user
                    .is_some_and(|user| config.allowed_users.contains(&user))
            {
                return Ok(Ingress::Ignore);
            }
            let ts = event
                .ts
                .filter(|ts| slack_ts(ts))
                .ok_or(StatusCode::BAD_REQUEST)?;
            let thread = event.thread_ts.unwrap_or_else(|| ts.clone());
            if !slack_ts(&thread)
                || !event_id.starts_with("Ev")
                || !(3..=128).contains(&event_id.len())
                || !event_id.bytes().all(|b| b.is_ascii_alphanumeric())
            {
                return Err(StatusCode::BAD_REQUEST);
            }
            let prompt = event
                .text
                .filter(|text| !text.trim().is_empty())
                .ok_or(StatusCode::BAD_REQUEST)?;
            let channel = config.channel_id.clone();
            Ok(Ingress::Accept(AcceptSlackEventRequest {
                account_id: config.account_id.clone(),
                event_id,
                team_id,
                channel_id: channel,
                message_ts: ts,
                thread_ts: thread,
                mention_tag_id: mention.then(|| config.tag_id.clone()),
                prompt,
            }))
        }
    }
}

fn slack_id(value: &str, prefixes: &[u8]) -> bool {
    (2..=64).contains(&value.len())
        && prefixes.contains(&value.as_bytes()[0])
        && value
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

fn slack_ts(value: &str) -> bool {
    value.split_once('.').is_some_and(|(seconds, micros)| {
        (1..=16).contains(&seconds.len())
            && (1..=9).contains(&micros.len())
            && seconds
                .bytes()
                .chain(micros.bytes())
                .all(|b| b.is_ascii_digit())
    })
}

#[cfg(test)]
mod tests;
