//! Slack Socket Mode: the connector opens an outbound WebSocket with the app-level token
//! (`apps.connections.open`), receives Events API payloads in envelopes, and acknowledges each
//! envelope once the Control Plane has admitted its event. An envelope left unacknowledged is
//! redelivered by Slack, and the Control Plane's event receipts make the redelivery a replay.
//!
//! Matches the TypeScript `SlackSocketModeSurface` over `@slack/socket-mode`: a `disconnect`
//! message, a closed link, or a silent link opens a fresh connection; `link_disabled` and a
//! refused token stop the connector.

use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use futures_util::{SinkExt, StreamExt, stream::FuturesUnordered};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{net::TcpStream, time};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{Message as WsMessage, protocol::WebSocketConfig},
};
use tokio_util::sync::CancellationToken;

use super::Connector;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const SEND_TIMEOUT: Duration = Duration::from_millis(500);
/// The connector pings Slack this often and reconnects when Slack stays silent for
/// [`SILENCE`], as the Slack SDK's client ping does.
const PING_INTERVAL: Duration = Duration::from_secs(10);
const SILENCE: Duration = Duration::from_secs(30);
const RETRY_INITIAL: Duration = Duration::from_secs(1);
const RETRY_MAX: Duration = Duration::from_secs(30);
/// Envelopes admitted concurrently on one connection; reading pauses beyond this.
const MAX_IN_FLIGHT: usize = 64;
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
/// Bound on acknowledging admitted envelopes after Slack asks for a new connection.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(3);

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Why one Socket Mode connection ended.
enum Ending {
    /// The connector is stopping.
    Stopped,
    /// Slack asked for a new connection, or the link closed; reconnect.
    Reconnect,
    /// Slack disabled Socket Mode for the app.
    Disabled,
}

/// One message from Slack on the Socket Mode connection.
#[derive(Deserialize)]
struct Envelope {
    #[serde(rename = "type")]
    kind: String,
    envelope_id: Option<String>,
    payload: Option<Value>,
    reason: Option<String>,
}

impl Connector {
    pub(super) async fn socket_mode(
        &self,
        app_token: &str,
        stop: &CancellationToken,
    ) -> Result<()> {
        let mut failures = 0_u32;
        loop {
            let opened = tokio::select! {
                _ = stop.cancelled() => return Ok(()),
                opened = self.open_connection(app_token) => opened?,
            };
            if let Some(url) = opened {
                let mut config = WebSocketConfig::default();
                config.max_message_size = Some(MAX_MESSAGE_BYTES);
                config.max_frame_size = Some(MAX_MESSAGE_BYTES);
                let connected = tokio::select! {
                    _ = stop.cancelled() => return Ok(()),
                    connected = time::timeout(
                        CONNECT_TIMEOUT,
                        connect_async_with_config(url.as_str(), Some(config), false),
                    ) => connected,
                };
                if let Ok(Ok((mut socket, _))) = connected {
                    let mut greeted = false;
                    let ending = self.session(&mut socket, stop, &mut greeted).await;
                    let _ = time::timeout(SEND_TIMEOUT, socket.close(None)).await;
                    match ending {
                        Ok(Ending::Stopped) => return Ok(()),
                        Ok(Ending::Disabled) => {
                            bail!("Slack disabled Socket Mode for this app (link_disabled)")
                        }
                        // A refresh Slack requested opens the next connection at once.
                        Ok(Ending::Reconnect) => {
                            failures = 0;
                            continue;
                        }
                        // A link that worked retries from the shortest delay.
                        Err(_) if greeted => failures = 0,
                        Err(_) => {}
                    }
                }
            }
            if stop.is_cancelled() {
                return Ok(());
            }
            let delay = RETRY_INITIAL
                .saturating_mul(1 << failures.min(5))
                .min(RETRY_MAX);
            failures = failures.saturating_add(1);
            tokio::select! {
                _ = stop.cancelled() => return Ok(()),
                _ = time::sleep(delay) => {}
            }
        }
    }

    /// The WebSocket URL from `apps.connections.open`, or `None` when Slack is unavailable,
    /// rate limits the call, or answers with something other than JSON. A refused app-level
    /// token is an error.
    async fn open_connection(&self, app_token: &str) -> Result<Option<reqwest::Url>> {
        let response = self
            .http
            .post(self.post_message.join("apps.connections.open")?)
            .bearer_auth(app_token)
            .header("content-type", "application/x-www-form-urlencoded")
            .send()
            .await;
        let Ok(mut response) = response else {
            return Ok(None);
        };
        let status = response.status();
        if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Ok(None);
        }
        ensure!(
            status == reqwest::StatusCode::OK,
            "Slack apps.connections.open failed with HTTP {}",
            status.as_u16()
        );
        let mut bytes = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) if chunk.len() <= MAX_RESPONSE_BYTES - bytes.len() => {
                    bytes.extend_from_slice(&chunk)
                }
                Ok(None) => break,
                Ok(Some(_)) => bail!("Slack apps.connections.open response is too large"),
                Err(_) => return Ok(None),
            }
        }
        // A body that is not JSON came from something in front of Slack; try again.
        let Ok(body) = serde_json::from_slice::<Value>(&bytes) else {
            return Ok(None);
        };
        if body["ok"].as_bool() != Some(true) {
            let error = body["error"]
                .as_str()
                .filter(|e| e.len() <= 64 && e.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'))
                .unwrap_or("unknown_error");
            if error == "ratelimited" {
                return Ok(None);
            }
            bail!("Slack refused the Socket Mode connection: {error}");
        }
        let url: reqwest::Url = body["url"]
            .as_str()
            .filter(|url| url.len() <= 8192)
            .context("Slack apps.connections.open returned no URL")?
            .parse()
            .map_err(|_| anyhow::anyhow!("Slack returned an invalid Socket Mode URL"))?;
        ensure!(
            url.username().is_empty() && url.password().is_none() && url.fragment().is_none(),
            "Slack returned an invalid Socket Mode URL"
        );
        if self.test_api {
            ensure!(
                url.scheme() == "ws"
                    && url.host_str() == self.post_message.host_str()
                    && url.port_or_known_default() == self.post_message.port_or_known_default(),
                "test Slack Socket Mode URL escaped the loopback Slack API"
            );
        } else {
            ensure!(
                url.scheme() == "wss"
                    && url
                        .host_str()
                        .is_some_and(|host| host == "slack.com" || host.ends_with(".slack.com")),
                "Slack Socket Mode URL must use TLS to slack.com"
            );
        }
        Ok(Some(url))
    }

    async fn session(
        &self,
        socket: &mut Socket,
        stop: &CancellationToken,
        greeted: &mut bool,
    ) -> Result<Ending> {
        let mut pending = FuturesUnordered::new();
        let mut ping_at = time::Instant::now() + PING_INTERVAL;
        let mut heard = time::Instant::now();
        loop {
            tokio::select! {
                _ = stop.cancelled() => return Ok(Ending::Stopped),
                _ = time::sleep_until(ping_at) => {
                    ensure!(heard.elapsed() < SILENCE, "Slack Socket Mode connection went silent");
                    send(socket, WsMessage::Ping(Vec::new().into())).await?;
                    ping_at = time::Instant::now() + PING_INTERVAL;
                }
                Some(acknowledged) = pending.next(), if !pending.is_empty() => {
                    if let Some(envelope_id) = acknowledged {
                        acknowledge(socket, envelope_id).await?;
                    }
                }
                incoming = socket.next(), if pending.len() < MAX_IN_FLIGHT => {
                    let message = incoming
                        .context("Slack Socket Mode connection closed")?
                        .map_err(|_| anyhow::anyhow!("Slack Socket Mode connection failed"))?;
                    heard = time::Instant::now();
                    match message {
                        WsMessage::Text(text) => {
                            let envelope: Envelope = serde_json::from_str(text.as_str())
                                .map_err(|_| anyhow::anyhow!("invalid Slack Socket Mode message"))?;
                            match envelope.kind.as_str() {
                                "hello" => *greeted = true,
                                "disconnect" => {
                                    if envelope.reason.as_deref() == Some("link_disabled") {
                                        return Ok(Ending::Disabled);
                                    }
                                    // Acknowledge what this connection already admitted, then
                                    // open the next one.
                                    let _ = time::timeout(DRAIN_TIMEOUT, async {
                                        while let Some(acknowledged) = pending.next().await {
                                            if let Some(envelope_id) = acknowledged {
                                                acknowledge(socket, envelope_id).await?;
                                            }
                                        }
                                        anyhow::Ok(())
                                    })
                                    .await;
                                    return Ok(Ending::Reconnect);
                                }
                                _ => {
                                    if let Some(envelope_id) = envelope.envelope_id.filter(|id| {
                                        !id.is_empty()
                                            && id.len() <= 256
                                            && !id.chars().any(char::is_control)
                                    }) {
                                        pending.push(self.envelope(
                                            envelope.kind,
                                            envelope_id,
                                            envelope.payload,
                                        ));
                                    }
                                }
                            }
                        }
                        WsMessage::Ping(bytes) => send(socket, WsMessage::Pong(bytes)).await?,
                        WsMessage::Pong(_) => {}
                        WsMessage::Close(_) => return Ok(Ending::Reconnect),
                        _ => bail!("unsupported Slack Socket Mode message"),
                    }
                }
            }
        }
    }

    /// Admits one envelope and returns its ID when Slack may consider it delivered. Envelopes
    /// that carry no Events API payload, such as slash commands, are acknowledged unread, as
    /// the TypeScript surface does.
    async fn envelope(
        &self,
        kind: String,
        envelope_id: String,
        payload: Option<Value>,
    ) -> Option<String> {
        if kind != "events_api" {
            return Some(envelope_id);
        }
        let payload = serde_json::from_value(payload?).ok()?;
        self.admit(payload).await.ok().map(|_| envelope_id)
    }
}

async fn acknowledge(socket: &mut Socket, envelope_id: String) -> Result<()> {
    send(
        socket,
        WsMessage::Text(json!({ "envelope_id": envelope_id }).to_string().into()),
    )
    .await
}

async fn send(socket: &mut Socket, message: WsMessage) -> Result<()> {
    time::timeout(SEND_TIMEOUT, socket.send(message))
        .await
        .context("Slack Socket Mode send timed out")?
        .map_err(|_| anyhow::anyhow!("Slack Socket Mode connection failed"))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::slack::{Slack, SlackEvents, tests::config};

    /// A loopback `apps.connections.open` answering each call from a script. `ORIGIN` in a
    /// scripted body becomes the fixture's own `host:port`.
    async fn api(responses: Vec<(u16, Value)>) -> Result<String> {
        use axum::{
            Json, Router,
            extract::State,
            http::{HeaderMap, StatusCode},
            routing::post,
        };
        type Script = Arc<Mutex<std::vec::IntoIter<(u16, Value)>>>;
        let script: Script = Arc::new(Mutex::new(responses.into_iter()));
        let router = Router::new()
            .route(
                "/api/apps.connections.open",
                post(
                    |State(script): State<Script>, headers: HeaderMap| async move {
                        let (status, body) = script.lock().unwrap().next().unwrap();
                        let origin = headers["host"].to_str().unwrap().to_owned();
                        let body: Value =
                            serde_json::from_str(&body.to_string().replace("ORIGIN", &origin))
                                .unwrap();
                        (StatusCode::from_u16(status).unwrap(), Json(body))
                    },
                ),
            )
            .with_state(script);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        tokio::spawn(async move { axum::serve(listener, router).await });
        Ok(format!("http://{address}/api/chat.postMessage"))
    }

    fn connector(directory: &std::path::Path, endpoint: &str) -> Result<Slack> {
        let mut config = config(&directory.join("slack"));
        config.events = SlackEvents::Socket {
            app_token: "xapp-fixture".into(),
        };
        Slack::new(
            config,
            supertag_protocol::negotiation::bind_current(
                tonic::transport::Endpoint::from_static("http://127.0.0.1:1").connect_lazy(),
            ),
            "fixture-gateway-token".into(),
        )?
        .with_test_reply_url(endpoint)
    }

    #[tokio::test]
    async fn opening_retries_unavailable_slack_and_refuses_tokens_and_foreign_urls() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let endpoint = api(vec![
            (503, json!({})),
            (429, json!({})),
            (200, json!({"ok": false, "error": "ratelimited"})),
            (
                200,
                json!({"ok": true, "url": "ws://ORIGIN/link/?ticket=one"}),
            ),
            (200, json!({"ok": false, "error": "invalid_auth"})),
            (401, json!({})),
            (200, json!({"ok": true, "url": "ws://127.0.0.1:1/link"})),
            (
                200,
                json!({"ok": true, "url": "wss://wss-primary.slack.com/link"}),
            ),
        ])
        .await?;
        let slack = connector(directory.path(), &endpoint)?;
        let connector = &slack.0;
        for _ in 0..3 {
            assert!(connector.open_connection("xapp-fixture").await?.is_none());
        }
        let url = connector.open_connection("xapp-fixture").await?.unwrap();
        assert_eq!(url.path(), "/link/");
        assert_eq!(url.port(), connector.post_message.port());
        let refused = connector.open_connection("xapp-fixture").await.unwrap_err();
        assert_eq!(
            refused.to_string(),
            "Slack refused the Socket Mode connection: invalid_auth"
        );
        let rejected = connector.open_connection("xapp-fixture").await.unwrap_err();
        assert!(rejected.to_string().contains("HTTP 401"));
        // A test build reaches only its loopback Slack: another port, or real Slack, is refused.
        for _ in 0..2 {
            let escaped = connector.open_connection("xapp-fixture").await.unwrap_err();
            assert!(
                escaped
                    .to_string()
                    .contains("escaped the loopback Slack API")
            );
        }
        Ok(())
    }

    #[tokio::test]
    async fn production_requires_tls_to_slack() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let endpoint = api(vec![
            (
                200,
                json!({"ok": true, "url": "ws://wss-primary.slack.com/link"}),
            ),
            (
                200,
                json!({"ok": true, "url": "wss://slack.com.evil.example/link"}),
            ),
            (
                200,
                json!({"ok": true, "url": "wss://user@wss-primary.slack.com/link"}),
            ),
            (
                200,
                json!({"ok": true, "url": "wss://wss-primary.slack.com/link/?ticket=t"}),
            ),
        ])
        .await?;
        let mut slack = connector(directory.path(), &endpoint)?;
        Arc::get_mut(&mut slack.0).unwrap().test_api = false;
        let connector = &slack.0;
        for _ in 0..3 {
            assert!(connector.open_connection("xapp-fixture").await.is_err());
        }
        let url = connector.open_connection("xapp-fixture").await?.unwrap();
        assert_eq!(url.host_str(), Some("wss-primary.slack.com"));
        Ok(())
    }
}
