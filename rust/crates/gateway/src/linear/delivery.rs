use super::{Connector, DELIVERY_TIMEOUT, GraphqlFailure, canonical_uuid};
use crate::delivery_journal::{Claim, Entry, Outcome, claim_call, settle_call, with_claim_lease};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use supertag_protocol::v2::{ClaimReplyRequest, Reply, ReplyState, SettleReplyRequest};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
impl Connector {
    pub(super) async fn deliver(&self, shutdown: &CancellationToken) -> Result<()> {
        crate::ownership::Owner {
            control_plane: &self.control_plane,
            gateway_token: &self.gateway_token,
            principal: &self.principal,
            journal: &self.journal,
        }
        .drive(shutdown, |owner| async move {
            self.advance_delivery(&owner).await
        })
        .await
    }

    pub(super) async fn advance_delivery(&self, owner: &str) -> Result<bool> {
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
                    "claim Linear reply",
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
                    "invalid Linear reply claim"
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
                        // that Linear did not receive the request and must not send it again.
                        self.journal.save(&Entry::Sending {
                            target: target.clone(),
                        })?;
                        let outcome = self.post(&reply).await;
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
                    "settle Linear reply",
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

    async fn post(&self, reply: &Reply) -> Outcome {
        let Some(destination) = &reply.destination else {
            return Outcome::Failed;
        };
        if reply.account_id != self.config.account_id
            || !canonical_uuid(&destination.conversation_id)
            || destination.thread_id.is_some()
            || reply.state() != ReplyState::Claimed
            || reply.text.trim().is_empty()
        {
            return Outcome::Failed;
        }
        let issue = &destination.conversation_id;
        let result = self.graphql(
            "mutation SuperTagLinearReply($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id issue { id } } } }",
            json!({"input":{"issueId": issue,"body":limit_text(&reply.text)}}),
            DELIVERY_TIMEOUT,
        ).await;
        match result {
            Ok(value) => provider_outcome(&value, issue),
            Err(GraphqlFailure::Rejected) => Outcome::Failed,
            Err(GraphqlFailure::Uncertain) => Outcome::Uncertain,
        }
    }
}
fn limit_text(text: &str) -> std::borrow::Cow<'_, str> {
    if let Some((end, _)) = text.char_indices().nth(8000) {
        format!("{}…", &text[..end]).into()
    } else {
        text.into()
    }
}
fn provider_outcome(value: &Value, issue: &str) -> Outcome {
    if value
        .pointer("/data/commentCreate/success")
        .and_then(Value::as_bool)
        == Some(false)
    {
        return Outcome::Failed;
    }
    if value
        .pointer("/data/commentCreate/success")
        .and_then(Value::as_bool)
        != Some(true)
        || value
            .pointer("/data/commentCreate/comment/issue/id")
            .and_then(Value::as_str)
            != Some(issue)
    {
        return Outcome::Uncertain;
    }
    match value
        .pointer("/data/commentCreate/comment/id")
        .and_then(Value::as_str)
        .filter(|id| canonical_uuid(id))
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
    fn receipt_requires_success_and_the_exact_issue() {
        let issue = "33333333-3333-4333-8333-333333333333";
        let id = "66666666-6666-4666-8666-666666666666";
        let value = json!({"data":{"commentCreate":{"success":true,"comment":{"id":id,"issue":{"id":issue}}}}});
        assert!(
            matches!(provider_outcome(&value,issue),Outcome::Delivered{provider_receipt} if provider_receipt==id)
        );
        assert!(matches!(
            provider_outcome(&value, "another issue"),
            Outcome::Uncertain
        ));
        assert!(matches!(
            provider_outcome(
                &json!({"data":{"commentCreate":{"success":true,"comment":{"id":id}}}}),
                issue
            ),
            Outcome::Uncertain
        ));
        assert!(matches!(
            provider_outcome(&json!({"data":{"commentCreate":{"success":false}}}), issue),
            Outcome::Failed
        ));
    }
}
