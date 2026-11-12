use super::{Connector, DELIVERY_TIMEOUT, bounded_json, valid_id};
use crate::delivery_journal::{Claim, Entry, Outcome, private_call, settle_call, with_claim_lease};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use std::time::Duration;
use supertag_protocol::v2::{ClaimReplyRequest, Reply, ReplyState, SettleReplyRequest};
use tokio::time;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
const POLL_INTERVAL: Duration = Duration::from_secs(1);
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

    pub(super) async fn advance_delivery(&self) -> Result<bool> {
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
                    "claim Lark reply",
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
                    "invalid Lark reply claim"
                );
                if reply.state() != ReplyState::Claimed {
                    self.journal.clear()?;
                    return Ok(false);
                }
                let target = Claim {
                    reply_id: reply.reply_id.clone(),
                    lease_token: claim.lease_token,
                };
                let result = with_claim_lease(
                    self.control_plane.clone(),
                    &self.gateway_token,
                    &self.principal,
                    &target,
                    async {
                        // Persist the last pre-effect state. A restart in this state cannot prove
                        // that Lark did not receive the request and must not send it again.
                        let token = match self.access_token().await {
                            Ok(token) => token,
                            Err(_) => return Ok(false),
                        };
                        self.journal.save(&Entry::Sending {
                            target: target.clone(),
                        })?;
                        let outcome = self.post(&reply, &token).await;
                        self.journal.save(&Entry::Settle {
                            target: target.clone(),
                            outcome,
                        })?;
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
                    "settle Lark reply",
                )
                .await?
                {
                    return Ok(false);
                }
                self.journal.clear()?;
                // Leave time before claiming another provider write.
                return Ok(false);
            }
        }
        Ok(true)
    }

    async fn post(&self, reply: &Reply, token: &str) -> Outcome {
        let Some(destination) = &reply.destination else {
            return Outcome::Failed;
        };
        let Some(root) = destination
            .thread_id
            .as_deref()
            .filter(|id| valid_id(id, "om_"))
        else {
            return Outcome::Failed;
        };
        if reply.account_id != self.config.account_id
            || destination.conversation_id != self.config.chat_id
            || reply.state() != ReplyState::Claimed
            || reply.text.trim().is_empty()
        {
            return Outcome::Failed;
        }
        let url = match self
            .origin
            .join(&format!("open-apis/im/v1/messages/{root}/reply"))
        {
            Ok(url) => url,
            Err(_) => return Outcome::Failed,
        };
        let content = match super::render::card(&reply.text) {
            Ok(card) => card.to_string(),
            Err(_) => return Outcome::Failed,
        };
        let response=self.http.post(url).bearer_auth(token).json(&json!({"msg_type":"interactive","content":content,"reply_in_thread":true,"uuid":reply.reply_id})).send().await;
        let Ok(response) = response else {
            return Outcome::Uncertain;
        };
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            *self.token.lock().await = None;
            return Outcome::Failed;
        }
        if matches!(
            response.status().as_u16(),
            400 | 403 | 404 | 405 | 410 | 422 | 429
        ) {
            return Outcome::Failed;
        }
        if response.status() != reqwest::StatusCode::OK {
            return Outcome::Uncertain;
        }
        match bounded_json(response).await {
            Ok(value) => provider_outcome(&value, &self.config.chat_id, root),
            Err(_) => Outcome::Uncertain,
        }
    }
}
fn provider_outcome(value: &Value, chat: &str, root: &str) -> Outcome {
    if value["code"].as_i64() != Some(0) {
        return Outcome::Uncertain;
    }
    if value.pointer("/data/chat_id").and_then(Value::as_str) != Some(chat)
        || value.pointer("/data/root_id").and_then(Value::as_str) != Some(root)
    {
        return Outcome::Uncertain;
    }
    match value
        .pointer("/data/message_id")
        .and_then(Value::as_str)
        .filter(|id| valid_id(id, "om_"))
    {
        Some(id) => Outcome::Delivered {
            provider_receipt: id.into(),
        },
        None => Outcome::Uncertain,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn receipt_is_bound_to_configured_chat_and_root() {
        let value = json!({"code":0,"data":{"message_id":"om_receipt","chat_id":"oc_chat","root_id":"om_root"}});
        assert!(
            matches!(provider_outcome(&value,"oc_chat","om_root"),Outcome::Delivered{provider_receipt}if provider_receipt=="om_receipt")
        );
        assert!(matches!(
            provider_outcome(&value, "oc_other", "om_root"),
            Outcome::Uncertain
        ));
        assert!(matches!(
            provider_outcome(&value, "oc_chat", "om_other"),
            Outcome::Uncertain
        ));
        assert!(matches!(
            provider_outcome(&json!({"code":0}), "oc_chat", "om_root"),
            Outcome::Uncertain
        ));
    }
}
