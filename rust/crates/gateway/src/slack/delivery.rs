use super::{Connector, DELIVERY_TIMEOUT, slack_ts};
pub(super) use crate::delivery_journal::Journal;
use crate::delivery_journal::{Claim, Entry, Outcome, private_call, settle_call, with_claim_lease};
use anyhow::{Result, ensure};
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;
use supertag_protocol::v2::{ClaimReplyRequest, Reply, ReplyState, SettleReplyRequest};
use tokio::time;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
const POLL_INTERVAL: Duration = Duration::from_secs(1);
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_MESSAGE_CHARS: usize = 4_000;
impl Connector {
    pub(super) async fn deliver(&self, shutdown: &CancellationToken) -> Result<()> {
        while !shutdown.is_cancelled() {
            let advance = tokio::select! {
                _ = shutdown.cancelled() => break,
                advance = self.advance_delivery() => advance?,
            };
            if !advance {
                tokio::select! {
                    _ = shutdown.cancelled() => break,
                    _ = time::sleep(POLL_INTERVAL) => {}
                }
            }
        }
        Ok(())
    }

    async fn advance_delivery(&self) -> Result<bool> {
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
                let request = self.request(ClaimReplyRequest { operation_id }, DELIVERY_TIMEOUT)?;
                let Some(claim) = private_call(
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
            || reply.text.trim().is_empty()
        {
            return Outcome::Failed;
        }
        let response = self
            .http
            .post(self.post_message.clone())
            .bearer_auth(&config.bot_token)
            .json(&json!({
                "channel": config.channel_id,
                "thread_ts": thread,
                "text": limit_text(&reply.text),
                "unfurl_links": false,
                "unfurl_media": false,
                "mrkdwn": false,
            }))
            .send()
            .await;
        let Ok(mut response) = response else {
            return Outcome::Uncertain;
        };
        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Outcome::Failed;
        }
        if !response.status().is_success() {
            return Outcome::Uncertain;
        }
        let mut bytes = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) if chunk.len() <= MAX_RESPONSE_BYTES - bytes.len() => {
                    bytes.extend_from_slice(&chunk)
                }
                Ok(None) => break,
                _ => return Outcome::Uncertain,
            }
        }
        provider_outcome(&bytes, &config.channel_id)
    }
}

fn limit_text(text: &str) -> std::borrow::Cow<'_, str> {
    let mut end = text.char_indices().skip(MAX_MESSAGE_CHARS - 1);
    if let (Some((byte, _)), Some(_)) = (end.next(), end.next()) {
        format!("{}…", &text[..byte]).into()
    } else {
        text.into()
    }
}

#[derive(Deserialize)]
struct ProviderResponse {
    ok: bool,
    channel: Option<String>,
    ts: Option<String>,
    error: Option<String>,
}

fn provider_outcome(bytes: &[u8], channel: &str) -> Outcome {
    let Ok(response) = serde_json::from_slice::<ProviderResponse>(bytes) else {
        return Outcome::Uncertain;
    };
    if response.ok
        && response.channel.as_deref() == Some(channel)
        && let Some(ts) = response.ts.filter(|ts| slack_ts(ts))
    {
        return Outcome::Delivered {
            provider_receipt: ts,
        };
    }
    if !response.ok
        && matches!(
            response.error.as_deref(),
            Some(
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
                    | "rate_limited"
                    | "ratelimited"
            )
        )
    {
        return Outcome::Failed;
    }
    Outcome::Uncertain
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::slack::tests::connector;

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
        assert!(reopened.0.advance_delivery().await?);
        assert!(matches!(
            reopened.0.journal.load()?,
            Some(Entry::Settle { target, outcome: Outcome::Uncertain }) if target.reply_id == "reply"
        ));
        Ok(())
    }

    #[test]
    fn accepted_receipt_must_prove_destination_and_definitive_rejections_are_distinct() {
        assert!(matches!(
            provider_outcome(br#"{"ok":true,"channel":"C1","ts":"1700000000.123456"}"#, "C1"),
            Outcome::Delivered { provider_receipt } if provider_receipt == "1700000000.123456"
        ));
        for body in [
            br#"{"ok":true,"channel":"C2","ts":"1700000000.123456"}"#.as_slice(),
            br#"{"ok":true,"channel":"C1"}"#,
            br#"{"ok":false,"error":"internal_error"}"#,
        ] {
            assert!(matches!(provider_outcome(body, "C1"), Outcome::Uncertain));
        }
        assert!(matches!(
            provider_outcome(br#"{"ok":false,"error":"invalid_auth"}"#, "C1"),
            Outcome::Failed
        ));
    }
}
