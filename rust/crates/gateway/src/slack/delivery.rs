use super::{Connector, DELIVERY_TIMEOUT, render, slack_ts};
pub(super) use crate::delivery_journal::Journal;
use crate::delivery_journal::{Claim, Entry, Outcome, claim_call, settle_call, with_claim_lease};
use anyhow::{Result, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;
use supertag_protocol::v2::{ClaimReplyRequest, Reply, ReplyState, SettleReplyRequest};
use tokio::time;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
/// Rate-limit retries stay well inside a reply claim's 30-second lease.
const RATE_LIMIT_ATTEMPTS: usize = 3;
const RATE_LIMIT_WAIT: Duration = Duration::from_secs(1);
const MAX_RATE_LIMIT_WAIT: Duration = Duration::from_secs(3);
impl Connector {
    pub(super) async fn deliver(&self, shutdown: &CancellationToken) -> Result<()> {
        crate::ownership::Owner {
            control_plane: &self.control_plane,
            gateway_token: &self.gateway_token,
            principal: &self.principal,
            journal: &self.journal,
        }
        .drive(shutdown, |owner| async move {
            let advanced = self.advance_delivery(&owner).await?;
            // Progress runs only while this Gateway owns the account's delivery.
            let progressed = self.progress_step().await?;
            Ok(advanced || progressed)
        })
        .await
    }

    /// Progress is presentation only. A refused progress claim or settlement must never stop
    /// final replies: retire that record and continue. Its lease then expires on its own.
    pub(super) async fn progress_step(&self) -> Result<bool> {
        match self.advance_progress().await {
            Ok(progressed) => Ok(progressed),
            Err(error) => {
                eprintln!("Slack reply progress skipped: {error:#}");
                self.progress_journal.clear()?;
                Ok(false)
            }
        }
    }

    async fn advance_delivery(&self, owner: &str) -> Result<bool> {
        let entry = match self.journal.load()? {
            Some(entry) => entry,
            None => {
                let entry = Entry::Claim {
                    operation_id: Uuid::new_v4().to_string(),
                };
                self.journal.save(&entry)?;
                entry
            }
        };
        match entry {
            Entry::Claim { operation_id } => {
                let request = self.request(
                    ClaimReplyRequest {
                        operation_id,
                        connector_lease_token: owner.into(),
                    },
                    DELIVERY_TIMEOUT,
                )?;
                let Some(claim) = claim_call(
                    self.control_plane.clone().claim_reply(request),
                    "claim Slack reply",
                )
                .await?
                else {
                    return Ok(false);
                };
                let claim = claim.into_inner();
                let Some(reply) = claim.reply else {
                    self.journal.clear()?;
                    return Ok(false);
                };
                ensure!(
                    !reply.reply_id.is_empty() && !claim.lease_token.is_empty(),
                    "invalid Slack reply claim"
                );
                if reply.state() != ReplyState::Claimed {
                    self.journal.clear()?;
                    return Ok(false);
                }
                let target = Claim {
                    reply_id: reply.reply_id.clone(),
                    lease_token: claim.lease_token,
                };
                supertag_protocol::crash_point("gateway.reply", "claimed");
                let result = with_claim_lease(
                    self.control_plane.clone(),
                    &self.gateway_token,
                    &self.principal,
                    &target,
                    async {
                        // Persist the last pre-effect state. A restart in this state cannot prove
                        // that Slack did not receive the request and must not send it again.
                        self.journal.save(&Entry::Sending {
                            target: target.clone(),
                        })?;
                        supertag_protocol::crash_point("gateway.reply", "sending-journaled");
                        let outcome = self.post(&reply).await;
                        supertag_protocol::crash_point("gateway.reply", "provider-answered");
                        self.journal.save(&Entry::Settle {
                            target: target.clone(),
                            outcome,
                        })?;
                        supertag_protocol::crash_point("gateway.reply", "settle-journaled");
                        Ok(true)
                    },
                )
                .await?;
                if let Some(result) = result {
                    return Ok(result);
                }
                self.journal.save(&Entry::Settle {
                    target,
                    outcome: Outcome::Uncertain,
                })?;
            }
            Entry::Sending { target } => {
                self.journal.save(&Entry::Settle {
                    target,
                    outcome: Outcome::Uncertain,
                })?;
            }
            Entry::Settle { target, outcome } => {
                let (state, provider_receipt) = match outcome {
                    Outcome::Delivered { provider_receipt } => {
                        (ReplyState::Delivered, Some(provider_receipt))
                    }
                    Outcome::Failed => (ReplyState::Failed, None),
                    Outcome::Uncertain => (ReplyState::Uncertain, None),
                };
                let request = self.request(
                    SettleReplyRequest {
                        reply_id: target.reply_id,
                        lease_token: target.lease_token,
                        state: state.into(),
                        provider_receipt,
                    },
                    DELIVERY_TIMEOUT,
                )?;
                if !settle_call(
                    self.control_plane.clone().settle_reply(request),
                    "settle Slack reply",
                )
                .await?
                {
                    return Ok(false);
                }
                supertag_protocol::crash_point("gateway.reply", "settled");
                self.journal.clear()?;
                // This connector sends to one channel. Leave time before the next post.
                return Ok(false);
            }
        }
        Ok(true)
    }

    async fn post(&self, reply: &Reply) -> Outcome {
        let config = &self.config;
        let Some(destination) = reply.destination.as_ref() else {
            return Outcome::Failed;
        };
        let Some(thread) = destination
            .thread_id
            .as_deref()
            .filter(|thread| slack_ts(thread))
        else {
            return Outcome::Failed;
        };
        if reply.account_id != config.account_id
            || destination.conversation_id != config.channel_id
            || reply.state() != ReplyState::Claimed
        {
            return Outcome::Failed;
        }
        let Some(text) = render::markdown(&reply.text) else {
            return Outcome::Failed;
        };
        let card = reply.result_card.as_ref().and_then(|card| {
            render::result_card(card.branch.as_deref(), card.pull_request_url.as_deref())
        });
        let replace = reply
            .replace_provider_receipt
            .as_deref()
            .filter(|receipt| slack_ts(receipt));
        if let Some(ts) = replace {
            match self
                .send_with_card(Target::Update(ts), &text, card.as_ref())
                .await
            {
                // Slack definitively left the acknowledgement unchanged. Answer in the thread
                // instead of failing the reply; nothing was written, so this cannot duplicate.
                Outcome::Failed => {}
                outcome => return outcome,
            }
        }
        self.send_with_card(Target::Thread(thread), &text, card.as_ref())
            .await
    }

    /// Retries a write Slack refused for its rate limit, which proves nothing was written,
    /// after the wait Slack asks for. TypeScript retries outbound replies the same way.
    pub(super) async fn send_paced(
        &self,
        target: Target<'_>,
        text: &str,
        attachments: Option<&Value>,
    ) -> Sent {
        let mut attempts = 1;
        loop {
            match self.send(target, text, attachments).await {
                Sent::RateLimited(wait) if attempts < RATE_LIMIT_ATTEMPTS => {
                    attempts += 1;
                    time::sleep(wait).await;
                }
                sent => return sent,
            }
        }
    }

    /// TypeScript parity (`postSlackThreadReply`): the card is an attachment beside an unchanged
    /// text fallback, and a payload Slack explicitly rejects as invalid is resent without it.
    async fn send_with_card(
        &self,
        target: Target<'_>,
        text: &str,
        card: Option<&Value>,
    ) -> Outcome {
        if let Some(blocks) = card {
            match self
                .send_paced(target, text, Some(&json!([{ "blocks": blocks }])))
                .await
            {
                Sent::Rejected(error)
                    if matches!(error.as_str(), "invalid_blocks" | "invalid_attachments") => {}
                sent => return sent.outcome(),
            }
        }
        self.send_paced(target, text, None).await.outcome()
    }

    pub(super) async fn send(
        &self,
        target: Target<'_>,
        text: &str,
        attachments: Option<&Value>,
    ) -> Sent {
        let config = &self.config;
        let mut body = json!({
            "channel": config.channel_id,
            "text": text,
            "mrkdwn": true,
            "unfurl_links": false,
            "unfurl_media": false,
        });
        let (url, expected) = match target {
            Target::Thread(thread) => {
                body["thread_ts"] = json!(thread);
                (self.post_message.clone(), None)
            }
            Target::Update(ts) => {
                body["ts"] = json!(ts);
                let Ok(url) = self.post_message.join("chat.update") else {
                    return Sent::Rejected("invalid_url".into());
                };
                (url, Some(ts))
            }
        };
        if let Some(attachments) = attachments {
            body["attachments"] = attachments.clone();
        }
        let response = self
            .http
            .post(url)
            .bearer_auth(&config.bot_token)
            .json(&body)
            .send()
            .await;
        let Ok(mut response) = response else {
            return Sent::Uncertain;
        };
        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let wait = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok()?.trim().parse::<u64>().ok())
                .map_or(RATE_LIMIT_WAIT, Duration::from_secs);
            return Sent::RateLimited(wait.min(MAX_RATE_LIMIT_WAIT));
        }
        if !response.status().is_success() {
            return Sent::Uncertain;
        }
        let mut bytes = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) if chunk.len() <= MAX_RESPONSE_BYTES - bytes.len() => {
                    bytes.extend_from_slice(&chunk)
                }
                Ok(None) => break,
                _ => return Sent::Uncertain,
            }
        }
        provider_outcome(&bytes, &config.channel_id, expected)
    }
}

#[derive(Clone, Copy)]
pub(super) enum Target<'a> {
    Thread(&'a str),
    Update(&'a str),
}

pub(super) enum Sent {
    Delivered(String),
    Rejected(String),
    /// Slack refused the write for its rate limit; nothing was written.
    RateLimited(Duration),
    Uncertain,
}

impl Sent {
    pub(super) fn outcome(self) -> Outcome {
        match self {
            Self::Delivered(provider_receipt) => Outcome::Delivered { provider_receipt },
            Self::Rejected(_) | Self::RateLimited(_) => Outcome::Failed,
            Self::Uncertain => Outcome::Uncertain,
        }
    }
}

#[derive(Deserialize)]
struct ProviderResponse {
    ok: bool,
    channel: Option<String>,
    ts: Option<String>,
    error: Option<String>,
}

/// A delivery is proven only by Slack's receipt for this channel and, for an update, the same
/// message. Definitive rejections are distinct from anything that may have been written.
fn provider_outcome(bytes: &[u8], channel: &str, replaced: Option<&str>) -> Sent {
    let Ok(response) = serde_json::from_slice::<ProviderResponse>(bytes) else {
        return Sent::Uncertain;
    };
    if response.ok
        && response.channel.as_deref() == Some(channel)
        && let Some(ts) = response.ts.filter(|ts| slack_ts(ts))
        && replaced.is_none_or(|replaced| replaced == ts)
    {
        return Sent::Delivered(ts);
    }
    match response.error {
        Some(error) if !response.ok && matches!(error.as_str(), "rate_limited" | "ratelimited") => {
            Sent::RateLimited(RATE_LIMIT_WAIT)
        }
        Some(error)
            if !response.ok
                && matches!(
                    error.as_str(),
                    "invalid_auth"
                        | "not_authed"
                        | "account_inactive"
                        | "token_revoked"
                        | "missing_scope"
                        | "channel_not_found"
                        | "not_in_channel"
                        | "is_archived"
                        | "cannot_reply_to_message"
                        | "no_text"
                        | "invalid_blocks"
                        | "invalid_attachments"
                        | "message_not_found"
                        | "cant_update_message"
                        | "edit_window_closed"
                        | "msg_too_long"
                ) =>
        {
            Sent::Rejected(error)
        }
        _ => Sent::Uncertain,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::slack::tests::connector;
    use std::sync::{Arc, Mutex};
    use supertag_protocol::v2::{ReplyDestination, ReplyResultCard};

    const TS: &str = "1700000000.123456";
    const THREAD: &str = "1785531750.100000";

    #[tokio::test]
    async fn recovered_send_intent_becomes_uncertain_without_posting_again() -> Result<()> {
        let temporary = tempfile::tempdir()?;
        let directory = temporary.path().join("slack");
        let first = connector(&directory)?;
        let target = Claim {
            reply_id: "reply".into(),
            lease_token: "lease".into(),
        };
        first.0.journal.save(&Entry::Sending { target })?;
        assert!(connector(&directory).is_err());
        drop(first);

        let reopened = connector(&directory)?;
        assert!(reopened.0.advance_delivery("").await?);
        assert!(matches!(
            reopened.0.journal.load()?,
            Some(Entry::Settle { target, outcome: Outcome::Uncertain }) if target.reply_id == "reply"
        ));
        Ok(())
    }

    #[test]
    fn accepted_receipt_must_prove_destination_and_definitive_rejections_are_distinct() {
        let delivered = br#"{"ok":true,"channel":"C1","ts":"1700000000.123456"}"#;
        assert!(matches!(
            provider_outcome(delivered, "C1", None),
            Sent::Delivered(receipt) if receipt == TS
        ));
        assert!(matches!(
            provider_outcome(delivered, "C1", Some(TS)),
            Sent::Delivered(receipt) if receipt == TS
        ));
        // An update receipt must name the message it replaced.
        assert!(matches!(
            provider_outcome(delivered, "C1", Some("1700000000.999999")),
            Sent::Uncertain
        ));
        for body in [
            br#"{"ok":true,"channel":"C2","ts":"1700000000.123456"}"#.as_slice(),
            br#"{"ok":true,"channel":"C1"}"#,
            br#"{"ok":false,"error":"internal_error"}"#,
        ] {
            assert!(matches!(
                provider_outcome(body, "C1", None),
                Sent::Uncertain
            ));
        }
        // A rate limit wrote nothing and may be retried; it is not a final refusal.
        for error in ["ratelimited", "rate_limited"] {
            let body = format!(r#"{{"ok":false,"error":"{error}"}}"#);
            assert!(matches!(
                provider_outcome(body.as_bytes(), "C1", None),
                Sent::RateLimited(wait) if wait == RATE_LIMIT_WAIT
            ));
        }
        for error in ["invalid_auth", "invalid_blocks", "message_not_found"] {
            let body = format!(r#"{{"ok":false,"error":"{error}"}}"#);
            assert!(matches!(
                provider_outcome(body.as_bytes(), "C1", None),
                Sent::Rejected(rejected) if rejected == error
            ));
        }
    }

    type Recorded = Arc<Mutex<Vec<(String, Value)>>>;

    /// A loopback Slack Web API answering each call from a script, recording path and body.
    async fn mock(responses: Vec<Value>) -> Result<(String, Recorded)> {
        use axum::{Json, Router, extract::State, http::Uri, routing::post};
        let recorded: Recorded = Arc::default();
        let script = Arc::new(Mutex::new(responses.into_iter()));
        let router = Router::new()
            .route(
                "/api/{method}",
                post(
                    |State((recorded, script)): State<(
                        Recorded,
                        Arc<Mutex<std::vec::IntoIter<Value>>>,
                    )>,
                     uri: Uri,
                     Json(body): Json<Value>| async move {
                        recorded.lock().unwrap().push((uri.path().into(), body));
                        Json(
                            script
                                .lock()
                                .unwrap()
                                .next()
                                .unwrap_or(json!({"ok": false, "error": "script_exhausted"})),
                        )
                    },
                ),
            )
            .with_state((recorded.clone(), script));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        tokio::spawn(async move { axum::serve(listener, router).await });
        Ok((format!("http://{address}/api/chat.postMessage"), recorded))
    }

    fn reply(text: &str, card: Option<ReplyResultCard>, replace: Option<&str>) -> Reply {
        Reply {
            reply_id: "reply".into(),
            task_id: "task".into(),
            account_id: "slack-fixture".into(),
            destination: Some(ReplyDestination {
                conversation_id: "CCHANNEL1".into(),
                thread_id: Some(THREAD.into()),
            }),
            text: text.into(),
            state: ReplyState::Claimed.into(),
            provider_receipt: None,
            result_card: card,
            replace_provider_receipt: replace.map(str::to_owned),
        }
    }

    fn ok(ts: &str) -> Value {
        json!({"ok": true, "channel": "CCHANNEL1", "ts": ts})
    }

    // TypeScript parity: `tests/slack-result-card.test.ts`, with the exact text-only payload.
    #[tokio::test]
    async fn result_card_is_an_attachment_beside_the_unchanged_text_fallback() -> Result<()> {
        let url = "https://github.com/example/supertag/pull/42";
        let markdown = "Work Session finished. See *results* below.";
        let text_only = json!({
            "channel": "CCHANNEL1", "thread_ts": THREAD,
            "text": "Work Session finished. See _results_ below.",
            "mrkdwn": true, "unfurl_links": false, "unfurl_media": false,
        });
        let card = ReplyResultCard {
            branch: Some("supertag/session/abc".into()),
            pull_request_url: Some(url.into()),
        };
        let temporary = tempfile::tempdir()?;

        let (endpoint, recorded) = mock(vec![ok(TS)]).await?;
        let slack = connector(&temporary.path().join("card"))?.with_test_reply_url(&endpoint)?;
        assert!(matches!(
            slack.0.post(&reply(markdown, Some(card.clone()), None)).await,
            Outcome::Delivered { provider_receipt } if provider_receipt == TS
        ));
        let (path, mut body) = recorded.lock().unwrap().remove(0);
        assert_eq!(path, "/api/chat.postMessage");
        let attachments = body.as_object_mut().unwrap().remove("attachments").unwrap();
        assert_eq!(body, text_only);
        assert_eq!(
            attachments,
            json!([{"blocks": render::result_card(Some("supertag/session/abc"), Some(url))}])
        );
        assert!(attachments.to_string().contains(&format!("\"{url}\"")));

        // Without delivery data the message stays text-only.
        let (endpoint, recorded) = mock(vec![ok(TS)]).await?;
        let slack = connector(&temporary.path().join("text"))?.with_test_reply_url(&endpoint)?;
        slack.0.post(&reply(markdown, None, None)).await;
        assert_eq!(
            recorded.lock().unwrap().clone(),
            [("/api/chat.postMessage".into(), text_only.clone())]
        );

        // An explicit Block Kit rejection falls back to the same text once.
        let (endpoint, recorded) = mock(vec![
            json!({"ok": false, "error": "invalid_blocks"}),
            ok(TS),
        ])
        .await?;
        let slack =
            connector(&temporary.path().join("fallback"))?.with_test_reply_url(&endpoint)?;
        assert!(matches!(
            slack
                .0
                .post(&reply(markdown, Some(card.clone()), None))
                .await,
            Outcome::Delivered { .. }
        ));
        let calls = recorded.lock().unwrap().clone();
        assert_eq!(calls.len(), 2);
        assert!(calls[0].1.get("attachments").is_some());
        assert_eq!(calls[1].1, text_only);

        // An ambiguous card post is never retried as text, which could show the answer twice.
        let (endpoint, recorded) =
            mock(vec![json!({"ok": false, "error": "internal_error"})]).await?;
        let slack =
            connector(&temporary.path().join("ambiguous"))?.with_test_reply_url(&endpoint)?;
        assert!(matches!(
            slack.0.post(&reply(markdown, Some(card), None)).await,
            Outcome::Uncertain
        ));
        assert_eq!(recorded.lock().unwrap().len(), 1);
        Ok(())
    }

    #[tokio::test]
    async fn final_reply_replaces_the_acknowledgement_or_answers_in_thread_when_it_cannot()
    -> Result<()> {
        let temporary = tempfile::tempdir()?;
        let ack = "1785531751.000001";
        let (endpoint, recorded) = mock(vec![ok(ack)]).await?;
        let slack = connector(&temporary.path().join("update"))?.with_test_reply_url(&endpoint)?;
        assert!(matches!(
            slack.0.post(&reply("**Done**", None, Some(ack))).await,
            Outcome::Delivered { provider_receipt } if provider_receipt == ack
        ));
        assert_eq!(
            recorded.lock().unwrap().clone(),
            [(
                "/api/chat.update".into(),
                json!({
                    "channel": "CCHANNEL1", "ts": ack, "text": "*Done*",
                    "mrkdwn": true, "unfurl_links": false, "unfurl_media": false,
                })
            )]
        );

        // Slack definitively refused to edit, so nothing changed: post the answer instead.
        let (endpoint, recorded) = mock(vec![
            json!({"ok": false, "error": "message_not_found"}),
            ok(TS),
        ])
        .await?;
        let slack = connector(&temporary.path().join("gone"))?.with_test_reply_url(&endpoint)?;
        assert!(matches!(
            slack.0.post(&reply("Done", None, Some(ack))).await,
            Outcome::Delivered { provider_receipt } if provider_receipt == TS
        ));
        let calls = recorded.lock().unwrap().clone();
        assert_eq!(
            calls
                .iter()
                .map(|(path, _)| path.as_str())
                .collect::<Vec<_>>(),
            ["/api/chat.update", "/api/chat.postMessage"]
        );
        assert_eq!(calls[1].1["thread_ts"], THREAD);

        // A rate-limited edit is retried in place, never answered beside the acknowledgement.
        let (endpoint, recorded) =
            mock(vec![json!({"ok": false, "error": "ratelimited"}), ok(ack)]).await?;
        let slack = connector(&temporary.path().join("paced"))?.with_test_reply_url(&endpoint)?;
        assert!(matches!(
            slack.0.post(&reply("Done", None, Some(ack))).await,
            Outcome::Delivered { provider_receipt } if provider_receipt == ack
        ));
        assert_eq!(
            recorded
                .lock()
                .unwrap()
                .iter()
                .map(|(path, _)| path.as_str())
                .collect::<Vec<_>>(),
            ["/api/chat.update", "/api/chat.update"]
        );

        // An ambiguous edit is not followed by a second message.
        let (endpoint, recorded) = mock(vec![json!({"ok": true, "channel": "CCHANNEL1"})]).await?;
        let slack = connector(&temporary.path().join("unknown"))?.with_test_reply_url(&endpoint)?;
        assert!(matches!(
            slack.0.post(&reply("Done", None, Some(ack))).await,
            Outcome::Uncertain
        ));
        assert_eq!(recorded.lock().unwrap().len(), 1);
        Ok(())
    }

    /// A Control Plane that refuses every progress call outright.
    struct RefusingProgress;

    #[tonic::async_trait]
    impl supertag_protocol::v2::reply_progress_server::ReplyProgress for RefusingProgress {
        async fn claim(
            &self,
            _: tonic::Request<supertag_protocol::v2::ClaimReplyProgressRequest>,
        ) -> Result<tonic::Response<supertag_protocol::v2::ClaimReplyProgressResponse>, tonic::Status>
        {
            Err(tonic::Status::permission_denied("refused"))
        }

        async fn settle(
            &self,
            _: tonic::Request<supertag_protocol::v2::SettleReplyProgressRequest>,
        ) -> Result<tonic::Response<supertag_protocol::v2::ReplyProgressUpdate>, tonic::Status>
        {
            Err(tonic::Status::invalid_argument("refused"))
        }
    }

    #[tokio::test]
    async fn refused_progress_is_retired_without_stopping_final_delivery() -> Result<()> {
        use tonic::transport::{Endpoint, Server, server::TcpIncoming};
        let incoming = TcpIncoming::bind("127.0.0.1:0".parse()?)?;
        let address = incoming.local_addr()?;
        tokio::spawn(
            Server::builder()
                .add_service(
                    supertag_protocol::v2::reply_progress_server::ReplyProgressServer::new(
                        RefusingProgress,
                    ),
                )
                .serve_with_incoming(incoming),
        );
        let temporary = tempfile::tempdir()?;
        let slack = super::super::Slack::new(
            crate::slack::tests::config(&temporary.path().join("slack")),
            Endpoint::from_shared(format!("http://{address}"))?.connect_lazy(),
            "fixture-gateway-token".into(),
        )?;
        let target = Claim {
            reply_id: "task".into(),
            lease_token: "lease".into(),
        };
        for entry in [
            Entry::Claim {
                operation_id: "claim".into(),
            },
            Entry::Settle {
                target,
                outcome: Outcome::Delivered {
                    provider_receipt: TS.into(),
                },
            },
        ] {
            slack.0.progress_journal.save(&entry)?;
            assert!(slack.0.advance_progress().await.is_err());
            assert!(
                !slack
                    .0
                    .progress_step()
                    .await
                    .is_ok_and(|progressed| progressed)
            );
            assert!(slack.0.progress_journal.load()?.is_none());
        }
        Ok(())
    }

    #[tokio::test]
    async fn rate_limited_first_progress_post_is_retried_and_an_update_is_skipped() -> Result<()> {
        let temporary = tempfile::tempdir()?;
        let update = |receipt: Option<&str>| supertag_protocol::v2::ReplyProgressUpdate {
            task_id: "task".into(),
            account_id: "slack-fixture".into(),
            destination: Some(ReplyDestination {
                conversation_id: "CCHANNEL1".into(),
                thread_id: Some(THREAD.into()),
            }),
            text: "Working".into(),
            revision: 1,
            provider_receipt: receipt.map(str::to_owned),
        };
        let (endpoint, recorded) = mock(vec![
            json!({"ok": false, "error": "ratelimited"}),
            json!({"ok": false, "error": "ratelimited"}),
        ])
        .await?;
        let slack =
            connector(&temporary.path().join("progress"))?.with_test_reply_url(&endpoint)?;
        assert!(slack.0.write_progress(&update(None)).await.is_none());
        assert!(matches!(
            slack.0.write_progress(&update(Some(TS))).await,
            Some(Outcome::Failed)
        ));
        assert_eq!(recorded.lock().unwrap().len(), 2);
        Ok(())
    }
}
