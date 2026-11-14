//! The acknowledgement and progress message shown while a Slack Task runs.
//!
//! The Control Plane owns the newest text, its revision, and the pace between writes. This loop
//! journals each provider write before making it, exactly as final replies do, so a restarted
//! Gateway reports an interrupted write as uncertain and never posts a second acknowledgement.
use super::{
    Connector, DELIVERY_TIMEOUT,
    delivery::{Sent, Target},
    render, slack_ts,
};
use crate::delivery_journal::{Claim, Entry, Outcome, private_call};
use anyhow::{Result, ensure};
use std::future::Future;
use supertag_protocol::v2::{
    ClaimReplyProgressRequest, ReplyProgressUpdate, ReplyState, SettleReplyProgressRequest,
};
use tokio::time;
use uuid::Uuid;

impl Connector {
    pub(super) async fn advance_progress(&self) -> Result<bool> {
        let journal = &self.progress_journal;
        let entry = match journal.load()? {
            Some(entry) => entry,
            None => {
                let entry = Entry::Claim {
                    operation_id: Uuid::new_v4().to_string(),
                };
                journal.save(&entry)?;
                entry
            }
        };
        match entry {
            Entry::Claim { operation_id } => {
                let request = self.request(
                    ClaimReplyProgressRequest {
                        operation_id: operation_id.clone(),
                    },
                    DELIVERY_TIMEOUT,
                )?;
                let Some(claim) = private_call(
                    self.progress.clone().claim(request),
                    "claim Slack reply progress",
                )
                .await?
                else {
                    return Ok(false);
                };
                let claim = claim.into_inner();
                let Some(update) = claim.update else {
                    journal.clear()?;
                    return Ok(false);
                };
                ensure!(
                    !update.task_id.is_empty() && !claim.lease_token.is_empty(),
                    "invalid Slack reply progress claim"
                );
                let target = Claim {
                    reply_id: update.task_id.clone(),
                    lease_token: claim.lease_token,
                };
                // The last pre-effect state: a restart here cannot prove Slack saw nothing.
                journal.save(&Entry::Sending {
                    target: target.clone(),
                })?;
                let Some(outcome) = self.write_progress(&update).await else {
                    // Slack rate-limited the first post and wrote nothing. Keep the claim and
                    // replay it after the pause; if its lease expires first, progress stops.
                    journal.save(&Entry::Claim { operation_id })?;
                    return Ok(false);
                };
                journal.save(&Entry::Settle { target, outcome })?;
                Ok(true)
            }
            Entry::Sending { target } => {
                journal.save(&Entry::Settle {
                    target,
                    outcome: Outcome::Uncertain,
                })?;
                Ok(true)
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
                    SettleReplyProgressRequest {
                        task_id: target.reply_id,
                        lease_token: target.lease_token,
                        state: state.into(),
                        provider_receipt,
                    },
                    DELIVERY_TIMEOUT,
                )?;
                if !settle(self.progress.clone().settle(request)).await? {
                    return Ok(false);
                }
                journal.clear()?;
                Ok(true)
            }
        }
    }

    /// `None` when Slack rate-limited a first post, which wrote nothing and can be retried.
    pub(super) async fn write_progress(&self, update: &ReplyProgressUpdate) -> Option<Outcome> {
        let first = update.provider_receipt.is_none();
        match self.write_progress_once(update).await {
            Sent::RateLimited(_) if first => None,
            sent => Some(sent.outcome()),
        }
    }

    async fn write_progress_once(&self, update: &ReplyProgressUpdate) -> Sent {
        let config = &self.config;
        let refused = || Sent::Rejected("invalid_progress".into());
        let Some(destination) = update.destination.as_ref() else {
            return refused();
        };
        let Some(thread) = destination
            .thread_id
            .as_deref()
            .filter(|thread| slack_ts(thread))
        else {
            return refused();
        };
        if update.account_id != config.account_id
            || destination.conversation_id != config.channel_id
        {
            return refused();
        }
        let Some(text) = render::markdown(&update.text) else {
            return refused();
        };
        let target = match update.provider_receipt.as_deref() {
            Some(ts) if slack_ts(ts) => Target::Update(ts),
            Some(_) => return refused(),
            None => Target::Thread(thread),
        };
        self.send(target, &text, None).await
    }
}

/// A conflicting settlement leaves the authoritative state unchanged; retire the local record.
async fn settle(
    call: impl Future<Output = Result<tonic::Response<ReplyProgressUpdate>, tonic::Status>>,
) -> Result<bool> {
    match time::timeout(DELIVERY_TIMEOUT, call).await {
        Ok(Ok(_)) => Ok(true),
        Ok(Err(error))
            if matches!(
                error.code(),
                tonic::Code::AlreadyExists | tonic::Code::NotFound
            ) =>
        {
            Ok(true)
        }
        Ok(Err(error))
            if matches!(
                error.code(),
                tonic::Code::Unavailable | tonic::Code::DeadlineExceeded | tonic::Code::Cancelled
            ) =>
        {
            Ok(false)
        }
        Err(_) => Ok(false),
        Ok(Err(error)) => anyhow::bail!(
            "settle Slack reply progress rejected by Control Plane ({})",
            error.code()
        ),
    }
}
