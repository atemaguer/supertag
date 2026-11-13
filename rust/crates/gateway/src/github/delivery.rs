use super::{Connector, DELIVERY_TIMEOUT, valid_id};
use crate::delivery_journal::{Claim, Entry, Outcome, claim_call, settle_call, with_claim_lease};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use supertag_protocol::v2::{ClaimReplyRequest, Reply, ReplyState, SettleReplyRequest};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
const MAX_RESPONSE_BYTES: usize = 128 * 1024;
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
                    "claim GitHub reply",
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
                    "invalid GitHub reply claim"
                );
                if reply.state() != ReplyState::Claimed {
                    self.journal.clear()?;
                    return Ok(false);
                }
                let target = Claim {
                    reply_id: reply.reply_id.clone(),
                    lease_token: claim.lease_token,
                };
                supertag_protocol::crash_point("gateway.github-reply", "claimed");
                return self.send_claimed_reply(&reply, target).await;
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
                    "settle GitHub reply",
                )
                .await?
                {
                    return Ok(false);
                }
                supertag_protocol::crash_point("gateway.github-reply", "settled");
                self.journal.clear()?;
                // Leave time before claiming another provider write.
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub(in crate::github) async fn send_claimed_reply(
        &self,
        reply: &Reply,
        target: Claim,
    ) -> Result<bool> {
        let result = with_claim_lease(
            self.control_plane.clone(),
            &self.gateway_token,
            &self.principal,
            &target,
            async {
                // Credential minting cannot publish a comment. Keep the durable claim receipt
                // until it succeeds so auth failures/restarts do not become ambiguous sends.
                let Ok(token) = self
                    .authentication
                    .access_token(&self.http, &self.api_base)
                    .await
                else {
                    return Ok(false);
                };
                // Persist the last pre-effect state. A restart in this state cannot prove
                // that GitHub did not receive the request and must not send it again.
                self.journal.save(&Entry::Sending {
                    target: target.clone(),
                })?;
                supertag_protocol::crash_point("gateway.github-reply", "sending-journaled");
                let outcome = self.post(reply, &token).await;
                supertag_protocol::crash_point("gateway.github-reply", "provider-answered");
                self.journal.save(&Entry::Settle {
                    target: target.clone(),
                    outcome,
                })?;
                supertag_protocol::crash_point("gateway.github-reply", "settle-journaled");
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
        Ok(true)
    }

    async fn post(&self, reply: &Reply, token: &super::auth::AccessToken) -> Outcome {
        let Some(destination) = &reply.destination else {
            return Outcome::Failed;
        };
        let Some(number) = destination
            .thread_id
            .as_deref()
            .and_then(|id| id.parse::<u64>().ok())
            .filter(|id| valid_id(*id))
        else {
            return Outcome::Failed;
        };
        if reply.account_id != self.config.account_id
            || destination.conversation_id != self.config.repository
            || reply.state() != ReplyState::Claimed
            || reply.text.trim().is_empty()
        {
            return Outcome::Failed;
        }
        let issue = match self
            .api_base
            .join(&format!("repos/{}/issues/{number}", self.config.repository))
        {
            Ok(url) => url,
            Err(_) => return Outcome::Failed,
        };
        let target = match self.api_base.join(&format!(
            "repos/{}/issues/{number}/comments",
            self.config.repository
        )) {
            Ok(url) => url,
            Err(_) => return Outcome::Failed,
        };
        let text = limit_text(&reply.text);
        let response = self
            .http
            .post(target)
            .bearer_auth(token.expose())
            .header("accept", "application/vnd.github+json")
            .header("user-agent", "supertag-gateway")
            .header("x-github-api-version", "2022-11-28")
            .json(&json!({"body":text}))
            .send()
            .await;
        let Ok(mut response) = response else {
            return Outcome::Uncertain;
        };
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            self.authentication.invalidate().await;
        }
        if matches!(
            response.status().as_u16(),
            400 | 401 | 403 | 404 | 405 | 410 | 422 | 429
        ) {
            return Outcome::Failed;
        }
        if response.status() != reqwest::StatusCode::CREATED {
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
        provider_outcome(&bytes, issue.as_str())
    }
}

fn limit_text(text: &str) -> std::borrow::Cow<'_, str> {
    if let Some((end, _)) = text.char_indices().nth(8000) {
        format!("{}…", &text[..end]).into()
    } else {
        text.into()
    }
}

fn provider_outcome(bytes: &[u8], issue: &str) -> Outcome {
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return Outcome::Uncertain;
    };
    if value.get("issue_url").and_then(Value::as_str) != Some(issue) {
        return Outcome::Uncertain;
    }
    let id = value
        .get("id")
        .and_then(|id| {
            id.as_u64().or_else(|| {
                id.as_str()
                    .filter(|id| id.bytes().all(|byte| byte.is_ascii_digit()))
                    .and_then(|id| id.parse().ok())
            })
        })
        .filter(|id| valid_id(*id));
    match id {
        Some(id) => Outcome::Delivered {
            provider_receipt: id.to_string(),
        },
        None => Outcome::Uncertain,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requires_a_valid_comment_receipt_for_the_expected_issue() {
        let issue = "https://api.github.com/repos/acme/project/issues/7";
        assert!(
            matches!(provider_outcome(json!({"id":123,"issue_url":issue}).to_string().as_bytes(),issue),Outcome::Delivered{provider_receipt} if provider_receipt=="123")
        );
        for payload in [
            json!({"id":123}),
            json!({"id":123,"issue_url":"https://evil.invalid/issues/7"}),
            json!({"id":0,"issue_url":issue}),
            json!({"id":"../123","issue_url":issue}),
        ] {
            assert!(matches!(
                provider_outcome(payload.to_string().as_bytes(), issue),
                Outcome::Uncertain
            ));
        }
    }
    #[tokio::test]
    async fn recovered_comment_intent_becomes_uncertain_without_another_post() -> Result<()> {
        let temporary = tempfile::tempdir()?;
        let first = super::super::tests::connector(temporary.path())?;
        first.0.journal.save(&Entry::Sending {
            target: Claim {
                reply_id: "reply".into(),
                lease_token: "lease".into(),
            },
        })?;
        drop(first);
        let recovered = super::super::tests::connector(temporary.path())?;
        assert!(recovered.0.advance_delivery("").await?);
        assert!(matches!(
            recovered.0.journal.load()?,
            Some(Entry::Settle {
                outcome: Outcome::Uncertain,
                ..
            })
        ));
        Ok(())
    }
}
