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
                let request =
                    self.request(ClaimReplyProgressRequest { operation_id }, DELIVERY_TIMEOUT)?;
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
                let outcome = self.write_progress(&update).await;
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

    async fn write_progress(&self, update: &ReplyProgressUpdate) -> Outcome {
        let config = &self.config;
        let Some(destination) = update.destination.as_ref() else {
            return Outcome::Failed;
        };
        let Some(thread) = destination
            .thread_id
            .as_deref()
            .filter(|thread| slack_ts(thread))
        else {
            return Outcome::Failed;
        };
        if update.account_id != config.account_id
            || destination.conversation_id != config.channel_id
        {
            return Outcome::Failed;
        }
        let Some(text) = render::markdown(&update.text) else {
            return Outcome::Failed;
        };
        let target = match update.provider_receipt.as_deref() {
            Some(ts) if slack_ts(ts) => Target::Update(ts),
            Some(_) => return Outcome::Failed,
            None => Target::Thread(thread),
        };
        match self.send(target, &text, None).await {
            Sent::Delivered(receipt) => Outcome::Delivered {
                provider_receipt: receipt,
            },
            Sent::Rejected(_) => Outcome::Failed,
            Sent::Uncertain => Outcome::Uncertain,
        }
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
