use std::time::Duration;

use sha2::{Digest, Sha256};
use supertag_protocol::{
    CHECKPOINT_CHUNK_BYTES, MAX_MESSAGE_BYTES, MAX_RESUMED_CHECKPOINT_BYTES,
    v2::{checkpoint_download, checkpoint_upload, transfers_client::TransfersClient, *},
    validate_checkpoint_reference,
};
use tonic::{Status, transport::Channel};

use crate::{HostHeaders, journal::Attempt, request};

/// Whether this host's harness resumes the checkpoint. One it cannot (one too big to grow, or
/// another harness's, which only a Tag that names no harness can leave, since any lane claims its
/// Tasks) is left out, and the adapter starts fresh from the Session's recap. A custom adapter's
/// host names no harness, so only its adapter can tell.
pub(crate) fn resumable(harness: HarnessKind, checkpoint: &SessionCheckpoint) -> bool {
    supertag_protocol::checkpoint_harness(harness).is_none_or(|name| name == checkpoint.harness)
        && checkpoint.payload.len() <= MAX_RESUMED_CHECKPOINT_BYTES
}

/// The checkpoint a finished turn keeps. One too big to grow would be dropped before the next
/// turn resumed it, so it is never kept: the turn still succeeds, and the next one starts from
/// the recap.
pub(crate) fn kept(checkpoint: Option<SessionCheckpoint>) -> Option<SessionCheckpoint> {
    checkpoint.filter(|checkpoint| checkpoint.payload.len() <= MAX_RESUMED_CHECKPOINT_BYTES)
}

#[derive(Clone)]
pub(crate) struct Transfers {
    pub(crate) channel: Channel,
    pub(crate) headers: HostHeaders,
    /// Where this host keeps the Workspace deliveries it produces.
    pub(crate) storage: Option<crate::artifact_direct::SourceStorage>,
}

impl Transfers {
    pub fn new(channel: Channel, headers: HostHeaders) -> Self {
        Self {
            channel,
            headers,
            storage: None,
        }
    }

    pub(crate) fn with_storage(mut self, storage: crate::artifact_direct::SourceStorage) -> Self {
        self.storage = Some(storage);
        self
    }

    pub async fn upload(
        &self,
        attempt: &Attempt,
        token: &str,
        checkpoint: SessionCheckpoint,
    ) -> Result<CheckpointReference, Status> {
        let reference = checkpoint.reference();
        validate_checkpoint_reference(&reference)?;
        let begin = CommitCheckpointRequest {
            attempt: Some(attempt.inspect()),
            reference: Some(reference.clone()),
        };
        let payload = checkpoint.payload;
        let offsets = (0..payload.len()).step_by(CHECKPOINT_CHUNK_BYTES);
        let chunks = offsets.map(move |offset| CheckpointUpload {
            part: Some(checkpoint_upload::Part::Chunk(
                payload[offset..payload.len().min(offset + CHECKPOINT_CHUNK_BYTES)].to_vec(),
            )),
        });
        let messages = std::iter::once(CheckpointUpload {
            part: Some(checkpoint_upload::Part::Begin(begin)),
        })
        .chain(chunks);
        let mut upstream = request(tokio_stream::iter(messages), token).map_err(|error| {
            crate::failures::noted(
                Status::internal("cannot authenticate checkpoint upload"),
                &error,
            )
        })?;
        upstream.set_timeout(Duration::from_secs(20));
        let returned =
            TransfersClient::with_interceptor(self.channel.clone(), self.headers.clone())
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .upload_checkpoint(upstream)
                .await?
                .into_inner();
        if returned != reference {
            return Err(Status::data_loss(
                "Control Plane returned a different checkpoint receipt",
            ));
        }
        Ok(returned)
    }

    pub async fn download(
        &self,
        attempt: &Attempt,
        token: &str,
    ) -> Result<Option<SessionCheckpoint>, Status> {
        let mut upstream = request(attempt.inspect(), token).map_err(|error| {
            crate::failures::noted(
                Status::internal("cannot authenticate checkpoint download"),
                &error,
            )
        })?;
        upstream.set_timeout(Duration::from_secs(20));
        let mut stream =
            TransfersClient::with_interceptor(self.channel.clone(), self.headers.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .download_checkpoint(upstream)
                .await?
                .into_inner();
        let reference = match stream.message().await? {
            None => return Ok(None),
            Some(CheckpointDownload {
                part: Some(checkpoint_download::Part::Reference(reference)),
            }) => reference,
            _ => {
                return Err(Status::data_loss(
                    "checkpoint download is missing its receipt",
                ));
            }
        };
        validate_checkpoint_reference(&reference)?;
        let mut payload = Vec::with_capacity(reference.byte_length as usize);
        while let Some(message) = stream.message().await? {
            let Some(checkpoint_download::Part::Chunk(chunk)) = message.part else {
                return Err(Status::data_loss("unexpected checkpoint download record"));
            };
            if chunk.is_empty()
                || chunk.len() > CHECKPOINT_CHUNK_BYTES
                || payload.len() + chunk.len() > reference.byte_length as usize
            {
                return Err(Status::data_loss("invalid checkpoint download chunk"));
            }
            payload.extend_from_slice(&chunk);
        }
        if payload.len() as u64 != reference.byte_length
            || format!("{:x}", Sha256::digest(&payload)) != reference.sha256
        {
            return Err(Status::data_loss(
                "checkpoint bytes do not match their receipt",
            ));
        }
        Ok(Some(SessionCheckpoint {
            harness: reference.harness,
            format: reference.format,
            sha256: reference.sha256,
            payload,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checkpoint(harness: &str, bytes: usize) -> SessionCheckpoint {
        SessionCheckpoint {
            harness: harness.into(),
            format: "fixture-v1".into(),
            sha256: "0".repeat(64),
            payload: vec![b' '; bytes],
        }
    }

    #[test]
    fn a_host_resumes_only_its_own_harness_checkpoints_that_can_still_grow() {
        let limit = MAX_RESUMED_CHECKPOINT_BYTES;
        assert!(resumable(HarnessKind::Codex, &checkpoint("codex", limit)));
        assert!(!resumable(
            HarnessKind::Codex,
            &checkpoint("codex", limit + 1)
        ));
        assert!(!resumable(
            HarnessKind::ClaudeCode,
            &checkpoint("codex", 10)
        ));
        assert!(resumable(
            HarnessKind::ClaudeCode,
            &checkpoint("claude-code", 10)
        ));
        // A custom adapter's host names no harness; its adapter decides.
        assert!(resumable(
            HarnessKind::Unspecified,
            &checkpoint("fixture", 10)
        ));
    }

    #[test]
    fn a_turn_keeps_no_checkpoint_too_big_to_resume() {
        let limit = MAX_RESUMED_CHECKPOINT_BYTES;
        assert!(kept(Some(checkpoint("codex", limit))).is_some());
        assert!(kept(Some(checkpoint("codex", limit + 1))).is_none());
        assert!(kept(None).is_none());
    }
}
