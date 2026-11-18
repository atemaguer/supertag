//! A fixture Worker Host's artifact storage. The Control Plane stores no artifact bytes: a test
//! that captures an artifact as a raw Worker Host registers this storage, commits the capture's
//! manifest, and keeps the bytes in memory to write the capture's Volume copies.
#![allow(dead_code)]

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use supertag_protocol::{
    HOST_GENERATION_HEADER, authenticated_request,
    negotiation::ProtocolChannel,
    v2::{
        BlobReference, CapturedArtifact, CommitArtifactCaptureRequest,
        RegisterArtifactSourceRequest, attempt_artifacts_client::AttemptArtifactsClient,
    },
};
use tonic::Request;

/// Bytes keyed by the producing Attempt and their SHA-256.
type Held = Arc<Mutex<HashMap<(String, String), Vec<u8>>>>;

pub struct HeldArtifacts {
    channel: ProtocolChannel,
    token: String,
    generation: u64,
    pub storage_id: String,
    held: Held,
}

impl HeldArtifacts {
    /// Registers fresh storage for the host with `token` at `generation`.
    pub async fn register(channel: ProtocolChannel, token: &str, generation: u64) -> Result<Self> {
        let held = Self {
            channel,
            token: token.to_owned(),
            generation,
            storage_id: uuid::Uuid::new_v4().to_string(),
            held: Arc::default(),
        };
        AttemptArtifactsClient::new(held.channel.clone())
            .register_artifact_source(held.request(RegisterArtifactSourceRequest {
                storage_id: held.storage_id.clone(),
            })?)
            .await
            .context("register fixture artifact storage")?;
        Ok(held)
    }

    fn request<T>(&self, value: T) -> Result<Request<T>> {
        let mut request = authenticated_request(value, &self.token, None)?;
        request
            .metadata_mut()
            .insert(HOST_GENERATION_HEADER, self.generation.to_string().parse()?);
        Ok(request)
    }

    /// Reconnects to another Control Plane address, as after its restart.
    pub fn reconnect(&mut self, channel: ProtocolChannel) {
        self.channel = channel;
    }

    /// Keeps `bytes` for `attempt_id`, returning their reference.
    pub fn hold(&self, attempt_id: &str, bytes: &[u8]) -> BlobReference {
        let sha256 = format!("{:x}", Sha256::digest(bytes));
        self.held
            .lock()
            .unwrap()
            .insert((attempt_id.to_owned(), sha256.clone()), bytes.to_vec());
        BlobReference {
            sha256,
            byte_length: bytes.len() as u64,
        }
    }

    /// Reserves a capture as a Worker Host does first, writes each Volume copy the reservation
    /// lists (through a presigned upload, or `file_volumes` the host maps), then commits it.
    pub async fn commit_writing(
        &self,
        mut manifest: CommitArtifactCaptureRequest,
        file_volumes: &std::collections::BTreeMap<
            String,
            supertag_workspaces::artifact_volumes::FileVolume,
        >,
    ) -> std::result::Result<CapturedArtifact, tonic::Status> {
        manifest.source_storage_id = Some(self.storage_id.clone());
        let internal = |error: anyhow::Error| tonic::Status::internal(error.to_string());
        let attempt = manifest
            .attempt
            .as_ref()
            .map(|attempt| attempt.attempt_id.clone())
            .unwrap_or_default();
        let reserved = AttemptArtifactsClient::new(self.channel.clone())
            .reserve_capture(self.request(manifest.clone()).map_err(internal)?)
            .await?
            .into_inner();
        for copy in &reserved.volume_copies {
            let blob = copy
                .file
                .as_ref()
                .and_then(|file| file.blob.clone())
                .unwrap();
            let bytes = self
                .held
                .lock()
                .unwrap()
                .get(&(attempt.clone(), blob.sha256.clone()))
                .cloned()
                .ok_or_else(|| tonic::Status::internal("bytes were not held"))?;
            match &copy.upload {
                Some(upload) => {
                    let mut put = reqwest::Client::new().put(&upload.url).body(bytes);
                    for header in &upload.headers {
                        put = put.header(&header.name, &header.value);
                    }
                    put.send()
                        .await
                        .map_err(|error| tonic::Status::internal(error.to_string()))?;
                }
                None => {
                    if let Some(volume) = copy
                        .volume
                        .as_ref()
                        .and_then(|volume| file_volumes.get(&volume.volume_id))
                    {
                        volume
                            .persist(&copy.storage_key, &blob, Some(&bytes), true)
                            .map_err(internal)?;
                    }
                }
            }
        }
        self.commit(manifest).await
    }

    /// Commits a capture whose `files` bytes were given to [`Self::hold`] for its Attempt.
    pub async fn commit(
        &self,
        mut manifest: CommitArtifactCaptureRequest,
    ) -> std::result::Result<CapturedArtifact, tonic::Status> {
        manifest.source_storage_id = Some(self.storage_id.clone());
        let request = self
            .request(manifest)
            .map_err(|error| tonic::Status::internal(error.to_string()))?;
        AttemptArtifactsClient::new(self.channel.clone())
            .commit_capture(request)
            .await
            .map(tonic::Response::into_inner)
    }
}
