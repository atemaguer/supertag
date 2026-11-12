use std::time::Duration;

use sha2::{Digest, Sha256};
use supertag_protocol::{
    CHECKPOINT_CHUNK_BYTES, MAX_MESSAGE_BYTES,
    v2::{checkpoint_download, checkpoint_upload, transfers_client::TransfersClient, *},
    validate_checkpoint_reference,
};
use tonic::{Status, transport::Channel};

use crate::{HostHeaders, journal::Attempt, request};

#[derive(Clone)]
pub(crate) struct Transfers {
    pub(crate) channel: Channel,
    pub(crate) headers: HostHeaders,
}

impl Transfers {
    pub fn new(channel: Channel, headers: HostHeaders) -> Self {
        Self { channel, headers }
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
        let mut upstream = request(tokio_stream::iter(messages), token)
            .map_err(|_| Status::internal("cannot authenticate checkpoint upload"))?;
        upstream.set_timeout(Duration::from_secs(20));
        let returned =
            TransfersClient::with_interceptor(self.channel.clone(), self.headers.clone())
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .upload_checkpoint(upstream)
                .await?
                .into_inner();
        if returned != reference {
            return Err(Status::data_loss(
                "Gateway returned a different checkpoint receipt",
            ));
        }
        Ok(returned)
    }

    pub async fn download(
        &self,
        attempt: &Attempt,
        token: &str,
    ) -> Result<Option<SessionCheckpoint>, Status> {
        let mut upstream = request(attempt.inspect(), token)
            .map_err(|_| Status::internal("cannot authenticate checkpoint download"))?;
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
