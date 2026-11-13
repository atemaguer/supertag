use super::{Connector, DELIVERY_TIMEOUT, bounded_json, numeric_id, service_url};
use crate::delivery_journal::{
    Claim, Entry, Outcome, claim_call, private_call, settle_call, with_claim_lease,
};
use anyhow::{Result, ensure};
use serde_json::json;
use supertag_protocol::v2::{
    ClaimReplyRequest, GetMicrosoftTeamsReplyRouteRequest, MicrosoftTeamsReplyRoute, Reply,
    ReplyState, SettleReplyRequest,
};
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
                    "claim Microsoft Teams reply",
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
                    "invalid Microsoft Teams reply claim"
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
                        // that Microsoft Teams did not receive the request and must not send it again.
                        let token = match self.access_token().await {
                            Ok(token) => token,
                            Err(_) => return Ok(false),
                        };
                        let request = self.request(
                            GetMicrosoftTeamsReplyRouteRequest {
                                reply_id: target.reply_id.clone(),
                                lease_token: target.lease_token.clone(),
                            },
                            DELIVERY_TIMEOUT,
                        )?;
                        let Some(route) = private_call(
                            self.control_plane
                                .clone()
                                .get_microsoft_teams_reply_route(request),
                            "load Microsoft Teams reply route",
                        )
                        .await?
                        else {
                            return Ok(false);
                        };
                        let route = route.into_inner();
                        self.journal.save(&Entry::Sending {
                            target: target.clone(),
                        })?;
                        let outcome = self.post(&reply, &route, &token).await;
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
                    "settle Microsoft Teams reply",
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

    async fn post(&self, reply: &Reply, route: &MicrosoftTeamsReplyRoute, token: &str) -> Outcome {
        let Some(destination) = &reply.destination else {
            return Outcome::Failed;
        };
        if reply.account_id != self.config.account_id
            || route.app_id != self.config.app_id
            || route.tenant_id != self.config.tenant_id
            || route.team_id != self.config.team_id
            || route.channel_id != self.config.channel_id
            || destination.conversation_id != route.conversation_id
            || destination.thread_id.as_deref() != Some(route.root_activity_id.as_str())
            || !numeric_id(&route.root_activity_id)
            || reply.state() != ReplyState::Claimed
            || reply.text.trim().is_empty()
        {
            return Outcome::Failed;
        }
        let Ok(base) = service_url(&route.service_url) else {
            return Outcome::Failed;
        };
        let mut url = if let Some(origin) = &self.test_origin {
            let mut fixture = origin.clone();
            fixture.set_path(base.path());
            fixture
        } else {
            base
        };
        let conversation = format!(
            "{};messageid={}",
            route.conversation_id.split(';').next().unwrap_or_default(),
            route.root_activity_id
        );
        let Ok(mut segments) = url.path_segments_mut() else {
            return Outcome::Failed;
        };
        segments
            .pop_if_empty()
            .extend(["v3", "conversations", &conversation, "activities"]);
        drop(segments);
        let text = match render(&reply.text) {
            Ok(text) => text,
            Err(_) => return Outcome::Failed,
        };
        let body = json!({"type":"message","textFormat":"markdown","text":text,"from":{"id":self.config.app_id,"role":"bot"},"conversation":{"id":conversation}});
        let response = self
            .http
            .post(url)
            .bearer_auth(token)
            .json(&body)
            .send()
            .await;
        let Ok(response) = response else {
            return Outcome::Uncertain;
        };
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            *self.token.lock().await = None;
            return Outcome::Failed;
        }
        if matches!(
            response.status().as_u16(),
            400 | 403 | 404 | 405 | 410 | 413 | 422 | 429
        ) {
            return Outcome::Failed;
        }
        if !response.status().is_success() {
            return Outcome::Uncertain;
        }
        match bounded_json(response).await {
            Ok(value) => match value["id"].as_str().filter(|v| {
                !v.trim().is_empty() && v.len() <= 4096 && !v.chars().any(char::is_control)
            }) {
                Some(id) => Outcome::Delivered {
                    provider_receipt: id.into(),
                },
                None => Outcome::Uncertain,
            },
            Err(_) => Outcome::Uncertain,
        }
    }
}
fn render(markdown: &str) -> Result<String> {
    // Reuse the same safe heading/table/native-tag adaptation as Lark; Teams
    // receives one Markdown activity, without Lark's card wrapper.
    let card = crate::lark::render::card(markdown)?;
    let text: String = card["elements"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|element| element["text"]["content"].as_str())
        .collect();
    // Keep even supplementary Unicode below the recommended 80 KB UTF-16 envelope.
    if let Some((end, _)) = text.char_indices().nth(15_999) {
        Ok(format!("{}…", &text[..end]))
    } else {
        Ok(text)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn markdown_preserves_content_and_neutralizes_mentions() {
        let text = render("# Done\n\n<at>Everyone</at>\n\n|A|B|\n|-|-|\n|1|2|").unwrap();
        assert!(text.starts_with("**Done**"));
        assert!(!text.contains("<at>"));
        assert!(text.contains("‹at›Everyone‹/at›"));
        assert!(text.contains("```"));
    }
}
