//! A fixture Worker Host's artifact storage. The Control Plane stores no artifact bytes: a test
//! that captures an artifact as a raw Worker Host registers this storage, commits the capture's
//! manifest, and answers the Control Plane's relay requests from memory while it is connected.
#![allow(dead_code)]

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use supertag_protocol::{
    CHECKPOINT_CHUNK_BYTES, HOST_GENERATION_HEADER, authenticated_request,
    negotiation::ProtocolChannel,
    v2::{
        AwaitRelayRequest, BlobReference, CapturedArtifact, CommitArtifactCaptureRequest,
        RegisterArtifactSourceRequest, RelayFrame,
        attempt_artifacts_client::AttemptArtifactsClient, host_relay_client::HostRelayClient,
        relay_frame,
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
    relay: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for HeldArtifacts {
    fn drop(&mut self) {
        if let Some(relay) = self.relay.take() {
            relay.abort();
        }
    }
}

impl HeldArtifacts {
    /// Registers fresh storage for the host with `token` at `generation`, and starts answering
    /// relay requests.
    pub async fn register(channel: ProtocolChannel, token: &str, generation: u64) -> Result<Self> {
        let mut held = Self {
            channel,
            token: token.to_owned(),
            generation,
            storage_id: uuid::Uuid::new_v4().to_string(),
            held: Arc::default(),
            relay: None,
        };
        AttemptArtifactsClient::new(held.channel.clone())
            .register_artifact_source(held.request(RegisterArtifactSourceRequest {
                storage_id: held.storage_id.clone(),
            })?)
            .await
            .context("register fixture artifact storage")?;
        held.connect().await?;
        Ok(held)
    }

    fn request<T>(&self, value: T) -> Result<Request<T>> {
        let mut request = authenticated_request(value, &self.token, None)?;
        request
            .metadata_mut()
            .insert(HOST_GENERATION_HEADER, self.generation.to_string().parse()?);
        Ok(request)
    }

    /// Opens the relay stream, as a running Worker Host keeps it open.
    pub async fn connect(&mut self) -> Result<()> {
        self.disconnect();
        let mut requests = HostRelayClient::new(self.channel.clone())
            .r#await(self.request(AwaitRelayRequest {})?)
            .await
            .context("open the fixture relay stream")?
            .into_inner();
        let channel = self.channel.clone();
        let token = self.token.clone();
        let generation = self.generation;
        let held = self.held.clone();
        self.relay = Some(tokio::spawn(async move {
            while let Ok(Some(request)) = requests.message().await {
                let Some(blob) = request.blob else { continue };
                let bytes = held
                    .lock()
                    .unwrap()
                    .get(&(request.attempt_id.clone(), blob.sha256.clone()))
                    .cloned();
                let mut frames = vec![RelayFrame {
                    part: Some(relay_frame::Part::RelayId(request.relay_id)),
                }];
                match bytes {
                    Some(bytes) => {
                        frames.extend(bytes.chunks(CHECKPOINT_CHUNK_BYTES).map(|chunk| {
                            RelayFrame {
                                part: Some(relay_frame::Part::Chunk(chunk.to_vec())),
                            }
                        }))
                    }
                    None => frames.push(RelayFrame {
                        part: Some(relay_frame::Part::Failure("missing".into())),
                    }),
                }
                let Ok(mut deliver) =
                    authenticated_request(tokio_stream::iter(frames), &token, None)
                else {
                    continue;
                };
                deliver
                    .metadata_mut()
                    .insert(HOST_GENERATION_HEADER, generation.into());
                let channel = channel.clone();
                tokio::spawn(async move {
                    let _ = HostRelayClient::new(channel).deliver(deliver).await;
                });
            }
        }));
        // The Control Plane registers the stream when the call is answered.
        Ok(())
    }

    /// Reconnects to another Control Plane address, as after its restart.
    pub async fn reconnect(&mut self, channel: ProtocolChannel) -> Result<()> {
        self.channel = channel;
        self.connect().await
    }

    /// Closes the relay stream, as when the Worker Host goes offline.
    pub fn disconnect(&mut self) {
        if let Some(relay) = self.relay.take() {
            relay.abort();
        }
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

    /// Replaces held bytes, as when a host's copy is corrupted.
    pub fn corrupt(&self, attempt_id: &str, blob: &BlobReference, bytes: &[u8]) {
        self.held
            .lock()
            .unwrap()
            .insert((attempt_id.to_owned(), blob.sha256.clone()), bytes.to_vec());
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
