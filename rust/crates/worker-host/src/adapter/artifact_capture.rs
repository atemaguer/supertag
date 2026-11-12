use std::time::Duration;

use sha2::{Digest, Sha256};
use supertag_protocol::{
    CHECKPOINT_CHUNK_BYTES, MAX_MESSAGE_BYTES,
    artifacts::{
        MAX_ARTIFACT_BYTES, MAX_ARTIFACT_FILE_BYTES, validate_capture_manifest,
        validate_capture_request,
    },
    authenticated_request,
    v2::{
        ArtifactChunk, ArtifactFile, ArtifactUpload, BlobReference, CapturedArtifact,
        CommitArtifactCaptureRequest, HarnessCaptureArtifactRequest, TaskState, artifact_upload,
        harness_artifacts_server::{HarnessArtifacts, HarnessArtifactsServer},
    },
};
use tokio::time::{self, Instant};
use tonic::{Request, Response, Status};

use super::Bridge;

const CAPTURE_TIMEOUT: Duration = Duration::from_secs(65);

impl Bridge {
    pub(super) fn artifact_capture_service(&self) -> HarnessArtifactsServer<Self> {
        HarnessArtifactsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl HarnessArtifacts for Bridge {
    async fn capture(
        &self,
        request: Request<HarnessCaptureArtifactRequest>,
    ) -> Result<Response<CapturedArtifact>, Status> {
        self.authenticate(&request)?;
        self.require_attached()?;
        let mut input = request.into_inner();
        validate_capture_request(&input)?;
        let accepted = self.assignment.task.as_ref().expect("validated assignment");
        if !accepted
            .allowed_actions
            .iter()
            .any(|action| action == "files:read")
        {
            return Err(Status::permission_denied(
                "artifact capture requires admitted file read access",
            ));
        }
        let checkout = self.artifact_checkout.clone().ok_or_else(|| {
            Status::failed_precondition("artifact capture requires a prepared local checkout")
        })?;
        let permit = self
            .artifact_capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                Status::resource_exhausted("another artifact capture is already in progress")
            })?;
        let (mut authority_deadline, closed) = self.inputs.authority();
        let operation_deadline = Instant::now() + CAPTURE_TIMEOUT;
        let operation = async {
            if self.state.lock().await.outcome.is_some() {
                return Err(Status::failed_precondition("execution is complete"));
            }
            let mut check = authenticated_request(self.attempt(), &self.host_token, None)?;
            check.set_timeout(Duration::from_secs(5));
            let task = self.host.clone().inspect_attempt(check).await?.into_inner();
            if task.state() != TaskState::Running
                || task.task_id != accepted.task_id
                || task.attempt_id.as_deref() != Some(self.assignment.attempt_id.as_str())
            {
                return Err(Status::failed_precondition(
                    "artifact capture authority expired",
                ));
            }
            input.paths.sort_unstable();
            let (_permit, selected) = tokio::task::spawn_blocking(move || {
                let mut selected = Vec::with_capacity(input.paths.len());
                let mut remaining = MAX_ARTIFACT_BYTES;
                for path in input.paths {
                    let limit = remaining.min(MAX_ARTIFACT_FILE_BYTES) as usize;
                    let bytes = supertag_workspaces::capture_artifact_file(&checkout, &path, limit)
                        .map_err(|_| {
                            Status::failed_precondition(
                                "cannot capture the selected workspace file",
                            )
                        })?;
                    let blob = BlobReference {
                        sha256: format!("{:x}", Sha256::digest(&bytes)),
                        byte_length: bytes.len() as u64,
                    };
                    remaining -= blob.byte_length;
                    selected.push((
                        ArtifactFile {
                            path,
                            blob: Some(blob),
                        },
                        bytes,
                    ));
                }
                Ok::<_, Status>((permit, selected))
            })
            .await
            .map_err(|_| Status::internal("artifact snapshot failed"))??;
            let expected: Vec<_> = selected.iter().map(|(file, _)| file.clone()).collect();
            let manifest = CommitArtifactCaptureRequest {
                attempt: Some(self.attempt()),
                operation_id: input.operation_id,
                description: input.description,
                files: expected.clone(),
                native_session_id: input.native_session_id,
            };
            validate_capture_manifest(&manifest)?;
            let stream = tokio_stream::iter(upload_records(manifest, selected));
            let mut upstream = authenticated_request(stream, &self.host_token, None)?;
            upstream.set_timeout(operation_deadline.saturating_duration_since(Instant::now()));
            let capture = self
                .coordination
                .artifacts
                .clone()
                .upload_capture(upstream)
                .await?
                .into_inner();
            if capture.files != expected
                || capture
                    .summary
                    .as_ref()
                    .and_then(|summary| summary.producer.as_ref())
                    .is_none_or(|producer| {
                        producer.task_id != task.task_id
                            || producer.attempt_id != self.assignment.attempt_id
                    })
            {
                return Err(Status::data_loss(
                    "artifact receipt differs from the selected files or Attempt",
                ));
            }
            Ok(Response::new(capture))
        };
        tokio::pin!(operation);
        loop {
            let expires = (*authority_deadline.borrow_and_update()).min(operation_deadline);
            if Instant::now() >= expires {
                return Err(Status::deadline_exceeded(
                    "artifact capture authority expired",
                ));
            }
            tokio::select! {
                biased;
                _ = closed.cancelled() => return Err(Status::failed_precondition("artifact capture is closed")),
                changed = authority_deadline.changed() => changed.map_err(|_| Status::failed_precondition("artifact capture is closed"))?,
                _ = time::sleep_until(expires) => return Err(Status::deadline_exceeded("artifact capture authority expired")),
                result = &mut operation => return result,
            }
        }
    }
}

fn upload_records(
    manifest: CommitArtifactCaptureRequest,
    selected: Vec<(ArtifactFile, Vec<u8>)>,
) -> impl Iterator<Item = ArtifactUpload> + Send + 'static {
    let chunks = selected
        .into_iter()
        .enumerate()
        .flat_map(|(index, (_, bytes))| {
            (0..bytes.len())
                .step_by(CHECKPOINT_CHUNK_BYTES)
                .map(move |offset| ArtifactUpload {
                    part: Some(artifact_upload::Part::Chunk(ArtifactChunk {
                        file_index: index as u32,
                        data: bytes[offset..bytes.len().min(offset + CHECKPOINT_CHUNK_BYTES)]
                            .to_vec(),
                    })),
                })
        });
    std::iter::once(ArtifactUpload {
        part: Some(artifact_upload::Part::Begin(manifest)),
    })
    .chain(chunks)
}
