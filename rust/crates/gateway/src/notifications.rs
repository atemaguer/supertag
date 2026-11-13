//! Operator notification delivery: the destinations in `notify`, the Slack, webhook, and desktop
//! senders, the outbox loop that claims messages from the Control Plane, and the operator
//! `SendTestNotification` call behind `supertag test notification`.
//!
//! TypeScript parity: `apps/cli/src/operator-notification-delivery.ts`,
//! `apps/cli/src/notification-command.ts`, `createOperatorNotificationSender` in
//! `apps/cli/src/gateway-surfaces.ts`, and `parseNotificationDestination` in
//! `packages/control-plane/src/operator-channel.ts`. Destination syntax, webhook payloads, and
//! redaction match. The Slack sender posts with this Gateway's Slack connector, so a Slack
//! destination needs `supertag gateway --slack-listen`, and renders the text through the Slack
//! renderer, as TypeScript sends a `status` presentation through `renderSlackPresentation`: text
//! an agent wrote can never post a live mention.
//!
//! A message being delivered when the Gateway shuts down is finished and settled before the
//! loop stops, so a graceful restart never sends it twice. Delivery is at least once: a Gateway
//! that crashes, or cannot settle, after the provider accepted a message sends it again once
//! its lease lapses, up to the message's last attempt. `SendTestNotification` is throttled to
//! one sample per Gateway every few seconds.
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request,
    v2::{
        ClaimOperatorNotificationRequest, ClaimOperatorNotificationResponse,
        NotificationDestination, NotificationProvider, OperatorNotification,
        SendTestNotificationRequest, SendTestNotificationResponse,
        SettleOperatorNotificationRequest, TestNotificationResult,
        operator_notification_test_server::{
            OperatorNotificationTest, OperatorNotificationTestServer,
        },
        operator_notifications_client::OperatorNotificationsClient,
    },
};
use tokio::{process::Command, time};
use tokio_util::sync::CancellationToken;
use tonic::{Request, Response, Status};

use crate::{Gateway, operator_access::OperatorCredential};

const SEND_TIMEOUT: Duration = Duration::from_secs(5);
const CALL_TIMEOUT: Duration = Duration::from_secs(10);
/// Bounds a claimed delivery, which shutdown waits for, inside the Gateway's 15-second budget.
const SETTLE_TIMEOUT: Duration = Duration::from_secs(5);
/// At most one test notification per Gateway in this interval.
const TEST_INTERVAL: Duration = Duration::from_secs(5);
const IDLE: Duration = Duration::from_secs(2);
const MAX_DESTINATIONS: usize = 16;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const TITLE: &str = "SuperTag needs you";

/// One configured place the operator hears about Inbox items.
#[derive(Clone, Debug)]
pub struct Destination {
    /// Stable across restarts and free of webhook URLs: what the Control Plane stores.
    pub key: String,
    pub provider: NotificationProvider,
    target: String,
    workspace_id: Option<String>,
    /// Names the bearer token sent with a webhook.
    pub secret_name: Option<String>,
}

/// Parses one `notify` value without echoing a webhook URL in errors: `desktop`,
/// `webhook:HTTPS_URL[#SECRET_NAME]`, `slack:TARGET`, or `slack:WORKSPACE_ID/TARGET`.
pub fn parse_destination(value: &str) -> Result<Destination> {
    parse(value, false)
}

fn parse(value: &str, loopback_http: bool) -> Result<Destination> {
    let trimmed = value.trim();
    if trimmed == "desktop" {
        return Ok(Destination {
            key: "desktop".into(),
            provider: NotificationProvider::Desktop,
            target: "desktop".into(),
            workspace_id: None,
            secret_name: None,
        });
    }
    if let Some(raw) = trimmed.strip_prefix("webhook:") {
        let (url, secret) = match raw.rsplit_once('#') {
            Some((url, secret)) => (url, Some(secret)),
            None => (raw, None),
        };
        let parsed = reqwest::Url::parse(url)
            .map_err(|_| anyhow::anyhow!("notify webhook must contain a valid HTTPS URL"))?;
        let loopback = loopback_http
            && parsed.scheme() == "http"
            && parsed.host_str().is_some_and(|host| {
                host.trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|address| address.is_loopback())
            });
        ensure!(
            (parsed.scheme() == "https" || loopback)
                && parsed.username().is_empty()
                && parsed.password().is_none()
                && parsed.host_str().is_some_and(|host| !host.is_empty())
                && secret.is_none_or(|name| {
                    !name.is_empty()
                        && name
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                }),
            "notify webhook must contain an HTTPS URL and optional secret name"
        );
        return Ok(Destination {
            key: format!(
                "webhook:{}",
                hex::encode(Sha256::digest(trimmed.as_bytes()))
            ),
            provider: NotificationProvider::Webhook,
            target: url.into(),
            workspace_id: None,
            secret_name: secret.map(Into::into),
        });
    }
    let invalid = || {
        anyhow::anyhow!(
            "notify must be desktop, webhook:HTTPS_URL[#SECRET], slack:CHANNEL_OR_USER_ID, or slack:WORKSPACE_ID/CHANNEL_OR_USER_ID, using a Slack ID beginning with C, G, D, U, or W"
        )
    };
    let rest = trimmed.strip_prefix("slack:").ok_or_else(invalid)?;
    let (workspace, target) = match rest.split_once('/') {
        Some((workspace, target)) => (Some(workspace), target),
        None => (None, rest),
    };
    let upper = |s: &str| {
        !s.is_empty()
            && s.len() <= 32
            && s.bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
    };
    if !workspace.is_none_or(upper)
        || !upper(target)
        || target.len() < 3
        || !matches!(target.as_bytes()[0], b'C' | b'G' | b'D' | b'U' | b'W')
    {
        return Err(invalid());
    }
    Ok(Destination {
        key: format!(
            "slack:{}{target}",
            workspace.map(|w| format!("{w}/")).unwrap_or_default()
        ),
        provider: NotificationProvider::Slack,
        target: target.into(),
        workspace_id: workspace.map(Into::into),
        secret_name: None,
    })
}

/// Parses every `notify` value, keeping the first of any duplicate.
pub fn parse_destinations(values: &[String], loopback_http: bool) -> Result<Vec<Destination>> {
    ensure!(
        values.len() <= MAX_DESTINATIONS,
        "configure at most 16 notification destinations"
    );
    let mut destinations: Vec<Destination> = Vec::new();
    for value in values {
        let destination = parse(value, loopback_http)?;
        if !destinations.iter().any(|d| d.key == destination.key) {
            destinations.push(destination);
        }
    }
    Ok(destinations)
}

/// The Slack connector's bot token and API, for top-level operator messages.
#[derive(Clone)]
pub struct SlackSender {
    pub(crate) http: reqwest::Client,
    pub(crate) post_message: reqwest::Url,
    pub(crate) bot_token: String,
    pub(crate) team_id: String,
}

/// How desktop notifications are shown.
#[derive(Clone)]
pub enum Desktop {
    /// `osascript` on macOS, `notify-send` on Linux.
    Native,
    /// A test notifier run with the title and text as its two arguments.
    Command(PathBuf),
    Unavailable,
}

/// Local senders for each destination kind, holding webhook secrets by name.
#[derive(Clone)]
pub struct Senders {
    slack: Option<SlackSender>,
    secrets: BTreeMap<String, String>,
    desktop: Desktop,
    http: reqwest::Client,
}

impl Senders {
    pub fn new(
        slack: Option<SlackSender>,
        secrets: BTreeMap<String, String>,
        desktop: Desktop,
    ) -> Result<Self> {
        Ok(Self {
            slack,
            secrets,
            desktop,
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(3))
                .timeout(SEND_TIMEOUT)
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .no_proxy()
                .build()?,
        })
    }

    /// Removes configured secrets and URLs, which can carry them.
    fn redact(&self, value: &str) -> String {
        let mut clean = value.to_owned();
        for secret in self.secrets.values().filter(|s| !s.is_empty()) {
            clean = clean.replace(secret.as_str(), "<redacted>");
        }
        redact_urls(&clean)
    }

    /// Sends one message within the send timeout. Returns the provider's message ID when it
    /// has one.
    pub async fn send(
        &self,
        destination: &Destination,
        text: &str,
        notification: &OperatorNotification,
    ) -> Result<Option<String>> {
        time::timeout(
            SEND_TIMEOUT,
            self.send_unbounded(destination, text, notification),
        )
        .await
        .map_err(|_| anyhow::anyhow!("the provider did not answer in time"))?
    }

    async fn send_unbounded(
        &self,
        destination: &Destination,
        text: &str,
        notification: &OperatorNotification,
    ) -> Result<Option<String>> {
        let text = self.redact(text);
        match destination.provider {
            NotificationProvider::Slack => self.slack(destination, &text).await.map(Some),
            NotificationProvider::Desktop => {
                self.desktop(&text).await?;
                Ok(None)
            }
            NotificationProvider::Webhook => {
                self.webhook(destination, &text, notification).await?;
                Ok(None)
            }
            NotificationProvider::Unspecified => bail!("unknown notification destination"),
        }
    }

    async fn slack(&self, destination: &Destination, text: &str) -> Result<String> {
        let slack = self
            .slack
            .as_ref()
            .context("Slack is not configured on this Gateway")?;
        if let Some(workspace) = &destination.workspace_id {
            ensure!(
                *workspace == slack.team_id,
                "No Slack Surface Account is enrolled for {workspace}"
            );
        }
        let response = slack
            .http
            .post(slack.post_message.clone())
            .bearer_auth(&slack.bot_token)
            .json(&json!({
                "channel": destination.target,
                "text": crate::slack::render::markdown(text).context("the message is empty")?,
                "mrkdwn": true,
                "unfurl_links": false,
                "unfurl_media": false,
            }))
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Slack did not answer"))?;
        let status = response.status();
        ensure!(
            status != reqwest::StatusCode::TOO_MANY_REQUESTS,
            "Slack rate limited the message"
        );
        ensure!(
            status.is_success(),
            "Slack returned HTTP {}",
            status.as_u16()
        );
        let bytes = bounded(response).await?;
        #[derive(Deserialize)]
        struct Posted {
            ok: bool,
            ts: Option<String>,
            error: Option<String>,
        }
        let posted: Posted =
            serde_json::from_slice(&bytes).context("Slack returned an unreadable answer")?;
        match (posted.ok, posted.ts) {
            (true, Some(ts)) if !ts.is_empty() && ts.len() <= 64 => Ok(ts),
            _ => bail!(
                "Slack refused the message: {}",
                posted
                    .error
                    .filter(|e| e.len() <= 64 && e.bytes().all(|b| b.is_ascii_graphic()))
                    .unwrap_or_else(|| "unknown_error".into())
            ),
        }
    }

    async fn desktop(&self, text: &str) -> Result<()> {
        let mut command = match &self.desktop {
            Desktop::Unavailable => bail!("Desktop notification unavailable"),
            Desktop::Command(path) => {
                let mut command = Command::new(path);
                command.args([TITLE, text]);
                command
            }
            Desktop::Native if cfg!(target_os = "macos") => {
                let mut command = Command::new("osascript");
                command.args([
                    "-e",
                    "on run argv",
                    "-e",
                    "display notification (item 2 of argv) with title (item 1 of argv)",
                    "-e",
                    "end run",
                    TITLE,
                    text,
                ]);
                command
            }
            Desktop::Native if cfg!(target_os = "linux") => {
                let mut command = Command::new("notify-send");
                command.args([TITLE, text]);
                command
            }
            Desktop::Native => bail!("Desktop notification unavailable"),
        };
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        match time::timeout(SEND_TIMEOUT, async { command.status().await }).await {
            Ok(Ok(status)) if status.success() => Ok(()),
            _ => bail!("Desktop notification unavailable"),
        }
    }

    async fn webhook(
        &self,
        destination: &Destination,
        text: &str,
        notification: &OperatorNotification,
    ) -> Result<()> {
        let secret = match &destination.secret_name {
            Some(name) => Some(
                self.secrets
                    .get(name)
                    .filter(|s| !s.is_empty())
                    .context("Webhook header secret is unavailable")?,
            ),
            None => None,
        };
        let item_keys: Vec<String> = notification
            .item_keys
            .iter()
            .map(|key| self.redact(key))
            .collect();
        let mut request = self.http.post(&destination.target).json(&json!({
            "objectiveId": self.redact(&notification.objective_id),
            "kinds": notification.kinds.iter().map(|kind| self.redact(kind)).collect::<Vec<_>>(),
            "count": item_keys.len(),
            "title": TITLE,
            "text": text,
            "command": self.redact(&notification.command),
            "itemKeys": item_keys,
        }));
        if let Some(secret) = secret {
            request = request.bearer_auth(secret);
        }
        let response = request
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Webhook did not answer"))?;
        ensure!(
            response.status().is_success(),
            "Webhook returned HTTP {}",
            response.status().as_u16()
        );
        Ok(())
    }
}

async fn bounded(mut response: reqwest::Response) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("the provider answer was interrupted"))?
    {
        ensure!(
            chunk.len() <= MAX_RESPONSE_BYTES - bytes.len(),
            "the provider answer is too large"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Removes URLs from operator-visible text.
fn redact_urls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        let lower = rest.to_ascii_lowercase();
        let Some(start) = [lower.find("http://"), lower.find("https://")]
            .into_iter()
            .flatten()
            .min()
        else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let end = tail
            .find(|c: char| c.is_whitespace() || c == ')' || c == '`')
            .unwrap_or(tail.len());
        out.push_str("<redacted URL>");
        rest = &tail[end..];
    }
}

/// Claims due operator notifications for this Gateway's destinations and delivers them.
#[derive(Clone)]
pub struct OperatorNotifier(Arc<Notifier>);

struct Notifier {
    destinations: Vec<Destination>,
    senders: Senders,
    control_plane: OperatorNotificationsClient<ProtocolChannel>,
    gateway_token: String,
    principal: String,
    last_test: tokio::sync::Mutex<Option<Instant>>,
}

impl OperatorNotifier {
    /// `principal` is the operator whose Inbox is read: this Gateway's admin operator.
    pub fn new(
        destinations: Vec<Destination>,
        senders: Senders,
        control_plane: ProtocolChannel,
        gateway_token: String,
        principal: String,
    ) -> Result<Self> {
        authenticated_request((), &gateway_token, Some(&principal))
            .context("invalid operator notification credential")?;
        Ok(Self(Arc::new(Notifier {
            destinations,
            senders,
            control_plane: OperatorNotificationsClient::new(control_plane)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
            gateway_token,
            principal,
            last_test: tokio::sync::Mutex::new(None),
        })))
    }

    pub fn destinations(&self) -> &[Destination] {
        &self.0.destinations
    }

    /// Runs until shutdown. A Control Plane or provider failure never stops the Gateway.
    pub async fn run(self, shutdown: CancellationToken) -> Result<()> {
        if self.0.destinations.is_empty() {
            shutdown.cancelled().await;
            return Ok(());
        }
        loop {
            // Shutdown interrupts a claim, never a claimed delivery: dropping a send the
            // provider may already have accepted would repeat it after restart.
            let claimed = tokio::select! {
                _ = shutdown.cancelled() => return Ok(()),
                result = self.claim() => result,
            };
            let delivered = match claimed {
                Ok(Some(claimed)) => self.deliver(claimed).await.map(|()| true),
                Ok(None) => Ok(false),
                Err(error) => Err(error),
            }
            .unwrap_or_else(|error| {
                supertag_protocol::terminal_text::warn(&format!(
                    "operator notification delivery paused: {error:#}"
                ));
                false
            });
            if !delivered {
                tokio::select! {
                    _ = shutdown.cancelled() => return Ok(()),
                    _ = time::sleep(IDLE) => {}
                }
            }
        }
    }

    fn request<T>(&self, message: T, timeout: Duration) -> Result<Request<T>> {
        let mut request =
            authenticated_request(message, &self.0.gateway_token, Some(&self.0.principal))?;
        request.set_timeout(timeout);
        Ok(request)
    }

    /// Leases the next due message for this Gateway's destinations.
    async fn claim(&self) -> Result<Option<ClaimOperatorNotificationResponse>> {
        let notifier = &self.0;
        let claimed = notifier
            .control_plane
            .clone()
            .claim(
                self.request(
                    ClaimOperatorNotificationRequest {
                        destinations: notifier
                            .destinations
                            .iter()
                            .map(|d| NotificationDestination {
                                key: d.key.clone(),
                                provider: d.provider as i32,
                            })
                            .collect(),
                    },
                    CALL_TIMEOUT,
                )?,
            )
            .await?
            .into_inner();
        Ok(claimed.notification.is_some().then_some(claimed))
    }

    /// Sends one leased message and settles it, within the send and settle timeouts.
    async fn deliver(&self, claimed: ClaimOperatorNotificationResponse) -> Result<()> {
        let notifier = &self.0;
        let notification = claimed
            .notification
            .context("the claimed notification is missing")?;
        let destination = notifier
            .destinations
            .iter()
            .find(|d| d.key == notification.destination_key)
            .context("the Control Plane returned an unconfigured destination")?;
        let outcome = notifier
            .senders
            .send(destination, &notification.text, &notification)
            .await;
        let (delivered, external_message_id, error) = match outcome {
            Ok(id) => (true, id, String::new()),
            Err(error) => (false, None, notifier.senders.redact(&format!("{error:#}"))),
        };
        notifier
            .control_plane
            .clone()
            .settle(self.request(
                SettleOperatorNotificationRequest {
                    notification_id: notification.notification_id,
                    lease_token: claimed.lease_token,
                    delivered,
                    external_message_id,
                    error: error.chars().take(500).collect(),
                },
                SETTLE_TIMEOUT,
            )?)
            .await?;
        Ok(())
    }

    /// The public operator service that sends a sample through every destination.
    pub fn test_service(
        &self,
        gateway: Gateway,
    ) -> OperatorNotificationTestServer<TestNotifications> {
        OperatorNotificationTestServer::new(TestNotifications {
            gateway,
            notifier: self.clone(),
        })
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

pub struct TestNotifications {
    gateway: Gateway,
    notifier: OperatorNotifier,
}

#[tonic::async_trait]
impl OperatorNotificationTest for TestNotifications {
    async fn send_test_notification(
        &self,
        request: Request<SendTestNotificationRequest>,
    ) -> Result<Response<SendTestNotificationResponse>, Status> {
        // Any authenticated operator may send the harmless sample.
        if let OperatorCredential::Token(digest) =
            self.gateway.credentials.presented_operator(&request)?
        {
            self.gateway
                .authenticate_operator(digest, CALL_TIMEOUT)
                .await?;
        }
        let objective = request.into_inner().objective_id.trim().to_owned();
        if objective.len() > 256 || objective.chars().any(char::is_control) {
            return Err(Status::invalid_argument(
                "Objective ID must contain at most 256 bytes without control characters",
            ));
        }
        let command = if objective.is_empty() {
            "supertag get inbox-items".to_owned()
        } else {
            format!("supertag describe objective {objective}")
        };
        let notifier = &self.notifier.0;
        {
            let mut last = notifier.last_test.lock().await;
            if last.is_some_and(|at| at.elapsed() < TEST_INTERVAL) {
                return Err(Status::resource_exhausted(
                    "a test notification was just sent; wait a few seconds and try again",
                ));
            }
            *last = Some(Instant::now());
        }
        let sends = notifier.destinations.iter().map(|destination| {
            let sample = OperatorNotification {
                notification_id: "test-notification".into(),
                destination_key: destination.key.clone(),
                objective_id: objective.clone(),
                text: format!("SuperTag test notification\n`{command}`"),
                item_keys: vec![format!("test:{objective}")],
                kinds: vec!["test".into()],
                command: command.clone(),
                attempt_count: 1,
                max_attempts: 1,
                ..Default::default()
            };
            async move {
                let result = notifier
                    .senders
                    .send(destination, &sample.text, &sample)
                    .await;
                TestNotificationResult {
                    provider: destination.provider as i32,
                    delivered: result.is_ok(),
                    error: result
                        .err()
                        .map(|error| notifier.senders.redact(&format!("{error:#}")))
                        .unwrap_or_default(),
                }
            }
        });
        Ok(Response::new(SendTestNotificationResponse {
            results: futures_util::future::join_all(sends).await,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destinations_match_the_typescript_syntax() {
        let slack = parse_destination("slack:T0TEAM/U0OPERATOR").unwrap();
        assert_eq!(slack.key, "slack:T0TEAM/U0OPERATOR");
        assert_eq!(slack.workspace_id.as_deref(), Some("T0TEAM"));
        assert_eq!(
            parse_destination(" slack:C0CHANNEL ").unwrap().key,
            "slack:C0CHANNEL"
        );
        assert!(parse_destination("slack:X0CHANNEL").is_err());
        assert!(parse_destination("slack:c0channel").is_err());
        assert_eq!(parse_destination("desktop").unwrap().key, "desktop");
        let secret_url = "webhook:https://hooks.example/x?token=private#hook-token";
        let webhook = parse_destination(secret_url).unwrap();
        assert!(webhook.key.starts_with("webhook:") && !webhook.key.contains("hooks.example"));
        assert_eq!(webhook.key.len(), "webhook:".len() + 64);
        assert_eq!(webhook.secret_name.as_deref(), Some("hook-token"));
        for invalid in [
            "webhook:http://hooks.example/x",
            "webhook:https://user:pass@hooks.example/x",
            "webhook:https://hooks.example/x#bad secret",
            "webhook:not a url",
        ] {
            let error = parse_destination(invalid).unwrap_err().to_string();
            assert!(!error.contains("hooks.example"), "{error}");
        }
        assert!(parse_destination("webhook:http://127.0.0.1:9/x").is_err());
        assert!(parse("webhook:http://127.0.0.1:9/x", true).is_ok());
        assert!(parse("webhook:http://hooks.example/x", true).is_err());
        let both = parse_destinations(&["desktop".into(), " desktop".into()], false).unwrap();
        assert_eq!(both.len(), 1);
    }

    #[test]
    fn secrets_and_urls_are_redacted() {
        let senders = Senders::new(
            None,
            BTreeMap::from([("hook".into(), "s3cr3t".into())]),
            Desktop::Unavailable,
        )
        .unwrap();
        assert_eq!(
            senders.redact("token s3cr3t at https://hooks.example/x?token=s3cr3t"),
            "token <redacted> at <redacted URL>"
        );
    }
}
