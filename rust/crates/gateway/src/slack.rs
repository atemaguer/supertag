//! Slack ingress, over signed Events API webhooks or a Socket Mode connection, and durable
//! thread replies.

mod delivery;
mod progress;
pub(crate) mod render;
mod socket;

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
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    MAX_MESSAGE_BYTES, connector_request,
    v2::{
        AcceptSlackEventRequest, connector_client::ConnectorClient,
        reply_progress_client::ReplyProgressClient,
    },
};
use tokio::{net::TcpListener, time};
use tokio_util::sync::CancellationToken;
use tonic::Request;

const ACCEPT_TIMEOUT: Duration = Duration::from_secs(2);
const WEBHOOK_TIMEOUT: Duration = Duration::from_millis(2500);
const DELIVERY_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_WEBHOOK_BYTES: usize = 128 * 1024;
pub(crate) const POST_MESSAGE: &str = "https://slack.com/api/chat.postMessage";

pub struct SlackConfig {
    pub account_id: String,
    pub team_id: String,
    pub channel_id: String,
    pub tag_id: String,
    pub allowed_users: Vec<String>,
    pub events: SlackEvents,
    pub bot_token: String,
    pub state_directory: PathBuf,
}

/// How Slack delivers events to the connector. Both admit the same messages.
pub enum SlackEvents {
    /// Signed Events API requests on a loopback webhook listener ([`Slack::serve`]).
    Http { signing_secret: String },
    /// Socket Mode: an outbound WebSocket opened with an app-level token ([`Slack::connect`]).
    Socket { app_token: String },
}

#[derive(Clone)]
pub struct Slack(Arc<Connector>);

struct Connector {
    config: SlackConfig,
    control_plane: ConnectorClient<ProtocolChannel>,
    gateway_token: String,
    account: String,
    http: reqwest::Client,
    post_message: reqwest::Url,
    /// Set by test builds whose Slack Web API is a loopback fixture: Socket Mode then connects
    /// to that fixture over plain WebSocket instead of requiring TLS to Slack.
    test_api: bool,
    journal: Journal,
    progress: ReplyProgressClient<ProtocolChannel>,
    progress_journal: Journal,
}

impl Slack {
    pub fn new(
        config: SlackConfig,
        private_channel: ProtocolChannel,
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
            !config.bot_token.trim().is_empty(),
            "Slack bot token is required"
        );
        match &config.events {
            SlackEvents::Http { signing_secret } => ensure!(
                !signing_secret.trim().is_empty(),
                "Slack signing secret is required for HTTP events"
            ),
            SlackEvents::Socket { app_token } => ensure!(
                !app_token.trim().is_empty(),
                "A Slack app-level token is required for Socket Mode"
            ),
        }
        let account = config.account_id.clone();
        connector_request((), &gateway_token, &account)
            .context("invalid private Slack connector credential")?;
        let journal = Journal::open(&config.state_directory, &config.account_id, "slack")?;
        // A separate private journal, so an acknowledgement in flight never blocks a final reply.
        let progress_journal = Journal::open(
            &config.state_directory.join("progress"),
            &config.account_id,
            "slack",
        )?;
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .timeout(DELIVERY_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .build()?;
        Ok(Self(Arc::new(Connector {
            config,
            control_plane: ConnectorClient::new(private_channel.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
            progress: ReplyProgressClient::new(private_channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
            progress_journal,
            gateway_token,
            account,
            http,
            post_message: POST_MESSAGE.parse()?,
            test_api: false,
            journal,
        })))
    }

    #[cfg(any(test, feature = "test-fixtures"))]
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
        let connector =
            Arc::get_mut(&mut self.0).context("set test Slack URL before sharing the connector")?;
        connector.post_message = url;
        connector.test_api = true;
        Ok(self)
    }

    /// Posts top-level operator notifications with this connector's bot token.
    pub fn operator_sender(&self) -> crate::notifications::SlackSender {
        crate::notifications::SlackSender {
            http: self.0.http.clone(),
            post_message: self.0.post_message.clone(),
            bot_token: self.0.config.bot_token.clone(),
            team_id: self.0.config.team_id.clone(),
        }
    }

    /// Serves signed Events API webhooks on `listener` and delivers replies.
    pub async fn serve(self, listener: TcpListener, shutdown: CancellationToken) -> Result<()> {
        ensure!(
            matches!(self.0.config.events, SlackEvents::Http { .. }),
            "this Slack connector uses Socket Mode, not HTTP events"
        );
        ensure!(
            listener.local_addr()?.ip().is_loopback(),
            "Slack webhook listener must bind to loopback"
        );
        let stop = shutdown.child_token();
        let router = Router::new()
            .route("/slack/events", post(webhook))
            .layer(DefaultBodyLimit::max(MAX_WEBHOOK_BYTES))
            .layer(middleware::from_fn(webhook_deadline))
            .layer(middleware::from_fn_with_state(
                stop.clone(),
                crate::ownership::refuse_while_draining,
            ))
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

    /// Receives events over Socket Mode and delivers replies. The connection reopens after
    /// Slack asks for a refresh or the link drops; it ends with an error when Slack refuses the
    /// app-level token or disables Socket Mode for the app.
    pub async fn connect(self, shutdown: CancellationToken) -> Result<()> {
        let SlackEvents::Socket { app_token } = &self.0.config.events else {
            anyhow::bail!("this Slack connector uses HTTP events, not Socket Mode");
        };
        let stop = shutdown.child_token();
        let socket = self.0.socket_mode(app_token, &stop);
        let deliver = self.0.deliver(&stop);
        tokio::pin!(socket, deliver);
        tokio::select! {
            socket_result = &mut socket => {
                stop.cancel();
                socket_result.and(deliver.await)
            }
            delivery_result = &mut deliver => {
                stop.cancel();
                delivery_result.and(socket.await)
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
        let mut request = connector_request(message, &self.gateway_token, &self.account)?;
        request.set_timeout(deadline);
        Ok(request)
    }
}

async fn webhook(State(slack): State<Slack>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let connector = &slack.0;
    let SlackEvents::Http { signing_secret } = &connector.config.events else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !verify_signature(&headers, &body, signing_secret, now.as_secs()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(payload) = serde_json::from_slice(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    match connector.admit(payload).await {
        Ok(Some(challenge)) => Json(json!({ "challenge": challenge })).into_response(),
        Ok(None) => StatusCode::OK.into_response(),
        Err(status) => status.into_response(),
    }
}

impl Connector {
    /// Admits one Events API payload, from either transport. `Ok` means Slack may consider the
    /// event delivered (with the URL verification challenge to echo, if it was one); an error
    /// leaves it for Slack to redeliver.
    async fn admit(&self, payload: Payload) -> Result<Option<String>, StatusCode> {
        let event = match normalize_payload(&self.config, payload)? {
            Ingress::Challenge(challenge) => return Ok(Some(challenge)),
            Ingress::Ignore => return Ok(None),
            Ingress::Accept(event) => event,
        };
        let request = self
            .request(event, ACCEPT_TIMEOUT)
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        let mut control_plane = self.control_plane.clone();
        supertag_protocol::crash_point("gateway.slack-admission", "before-forward");
        match time::timeout(ACCEPT_TIMEOUT, control_plane.accept_slack_event(request)).await {
            Ok(Ok(_)) => {
                supertag_protocol::crash_point("gateway.slack-admission", "after-forward");
                Ok(None)
            }
            Ok(Err(error)) if error.code() == tonic::Code::AlreadyExists => {
                Err(StatusCode::CONFLICT)
            }
            _ => Err(StatusCode::SERVICE_UNAVAILABLE),
        }
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

#[cfg(test)]
fn normalize(config: &SlackConfig, body: &[u8]) -> Result<Ingress, StatusCode> {
    normalize_payload(
        config,
        serde_json::from_slice(body).map_err(|_| StatusCode::BAD_REQUEST)?,
    )
}

fn normalize_payload(config: &SlackConfig, payload: Payload) -> Result<Ingress, StatusCode> {
    match payload {
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
            let Some(user) = event
                .user
                .filter(|user| config.allowed_users.contains(user))
            else {
                return Ok(Ingress::Ignore);
            };
            if (!mention && !reply)
                || event.bot_id.is_some()
                || event.subtype.is_some()
                || event.channel.as_deref() != Some(&config.channel_id)
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
                actor_id: user,
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
