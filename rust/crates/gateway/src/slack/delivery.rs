use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    future::Future,
    io::{self, Read as _, Write as _},
    os::unix::fs::{DirBuilderExt as _, MetadataExt as _, OpenOptionsExt as _},
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::json;
use supertag_protocol::v2::{ClaimReplyRequest, Reply, ReplyState, SettleReplyRequest};
use tempfile::NamedTempFile;
use tokio::time;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{Connector, DELIVERY_TIMEOUT, slack_ts};

const POLL_INTERVAL: Duration = Duration::from_secs(1);
const REPLY_FILE: &str = "reply.json";
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_MESSAGE_CHARS: usize = 4_000;

#[derive(Clone, Deserialize, Serialize)]
struct Claim {
    reply_id: String,
    lease_token: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum Outcome {
    Delivered { provider_receipt: String },
    Failed,
    Uncertain,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "stage", rename_all = "snake_case")]
enum Entry {
    Claim { operation_id: String },
    Sending { target: Claim },
    Settle { target: Claim, outcome: Outcome },
}

#[derive(Deserialize, Serialize)]
struct Record {
    account_id: String,
    entry: Entry,
}

pub(super) struct Journal {
    directory: PathBuf,
    account_id: String,
    _lock: File,
}

impl Journal {
    pub(super) fn open(directory: &Path, account_id: &str) -> Result<Self> {
        DirBuilder::new()
            .mode(0o700)
            .recursive(true)
            .create(directory)?;
        let metadata = fs::symlink_metadata(directory)?;
        ensure!(
            metadata.is_dir() && private(&metadata),
            "Slack state must be an owner-only directory"
        );
        let lock = open_private(&directory.join("slack.lock"), true)?;
        lock.try_lock()
            .context("Slack delivery state is already in use")?;
        let journal = Self {
            directory: directory.canonicalize()?,
            account_id: account_id.into(),
            _lock: lock,
        };
        journal.load()?;
        Ok(journal)
    }

    fn load(&self) -> Result<Option<Entry>> {
        let file = match open_private(&self.directory.join(REPLY_FILE), false) {
            Ok(file) => file,
            Err(error)
                if error
                    .downcast_ref::<io::Error>()
                    .is_some_and(|e| e.kind() == io::ErrorKind::NotFound) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error).context("open Slack delivery journal"),
        };
        let mut bytes = Vec::new();
        file.take(8193).read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= 8192, "Slack delivery journal is too large");
        let record: Record = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("invalid Slack delivery journal"))?;
        ensure!(
            record.account_id == self.account_id,
            "Slack delivery journal belongs to another account"
        );
        Ok(Some(record.entry))
    }

    fn save(&self, entry: &Entry) -> Result<()> {
        let mut staged = NamedTempFile::new_in(&self.directory)?;
        serde_json::to_writer(
            staged.as_file_mut(),
            &Record {
                account_id: self.account_id.clone(),
                entry: entry.clone(),
            },
        )?;
        staged.flush()?;
        staged.as_file().sync_all()?;
        staged.persist(self.directory.join(REPLY_FILE))?;
        File::open(&self.directory)?.sync_all()?;
        Ok(())
    }

    fn clear(&self) -> Result<()> {
        fs::remove_file(self.directory.join(REPLY_FILE))?;
        File::open(&self.directory)?.sync_all()?;
        Ok(())
    }
}

fn open_private(path: &Path, create: bool) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(create)
        .create(create)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.nlink() == 1 && private(&metadata),
        "Slack state file must be private"
    );
    Ok(file)
}

fn private(metadata: &fs::Metadata) -> bool {
    // SAFETY: geteuid reads the current process's effective user ID.
    metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o077 == 0
}

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
                let target = Claim {
                    reply_id: reply.reply_id.clone(),
                    lease_token: claim.lease_token,
                };
                // Persist the last pre-effect state. A restart in this state cannot prove
                // that Slack did not receive the request and must not send it again.
                self.journal.save(&Entry::Sending {
                    target: target.clone(),
                })?;
                let outcome = self.post(&reply).await;
                self.journal.save(&Entry::Settle { target, outcome })?;
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
                if private_call(
                    self.control_plane.clone().settle_reply(request),
                    "settle Slack reply",
                )
                .await?
                .is_none()
                {
                    return Ok(false);
                }
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

async fn private_call<T>(
    call: impl Future<Output = Result<T, tonic::Status>>,
    operation: &str,
) -> Result<Option<T>> {
    match time::timeout(DELIVERY_TIMEOUT, call).await {
        Ok(Ok(value)) => Ok(Some(value)),
        Ok(Err(error))
            if matches!(
                error.code(),
                tonic::Code::Unavailable | tonic::Code::DeadlineExceeded | tonic::Code::Cancelled
            ) =>
        {
            Ok(None)
        }
        Ok(Err(error)) => anyhow::bail!("{operation} rejected by Control Plane ({})", error.code()),
        Err(_) => Ok(None),
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
