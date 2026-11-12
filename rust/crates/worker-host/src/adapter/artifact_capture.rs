use std::time::Duration;

use supertag_protocol::{
    CHECKPOINT_CHUNK_BYTES, MAX_MESSAGE_BYTES,
    artifacts::validate_capture_request,
    authenticated_request,
    v2::{
        ArtifactChunk, ArtifactUpload, CapturedArtifact, CommitArtifactCaptureRequest,
        HarnessCaptureArtifactRequest, TaskState, artifact_upload,
        harness_artifacts_server::{HarnessArtifacts, HarnessArtifactsServer},
    },
};
use tokio::time::{self, Instant};
use tonic::{Request, Response, Status};

use super::Bridge;
use crate::artifact_snapshots::Capture;

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
    async fn find(
        &self,
        request: Request<supertag_protocol::v2::HarnessFindArtifactsRequest>,
    ) -> Result<Response<supertag_protocol::v2::ListCapturedArtifactsResponse>, Status> {
        self.find_artifacts(request).await
    }
    async fn inspect(
        &self,
        request: Request<supertag_protocol::v2::GetCapturedArtifactRequest>,
    ) -> Result<Response<CapturedArtifact>, Status> {
        self.inspect_artifact(request).await
    }
    async fn read(
        &self,
        request: Request<supertag_protocol::v2::HarnessReadArtifactRequest>,
    ) -> Result<Response<supertag_protocol::v2::HarnessArtifactPage>, Status> {
        self.read_artifact(request).await
    }
    async fn attach(
        &self,
        request: Request<supertag_protocol::v2::HarnessAttachArtifactRequest>,
    ) -> Result<Response<supertag_protocol::v2::HarnessAttachedArtifact>, Status> {
        self.attach_artifact(request).await
    }

    async fn capture(
        &self,
        request: Request<HarnessCaptureArtifactRequest>,
    ) -> Result<Response<CapturedArtifact>, Status> {
        self.authenticate(&request)?;
        self.require_attached()?;
        let input = request.into_inner();
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
        let (checkout, snapshots) = self.artifact_checkout.clone().ok_or_else(|| {
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
            let attempt = self.attempt();
            let (permit, snapshots, capture) = tokio::task::spawn_blocking(move || {
                let capture = snapshots.freeze(&checkout, attempt, input)?;
                Ok::<_, Status>((permit, snapshots, capture))
            })
            .await
            .map_err(|_| Status::internal("artifact snapshot failed"))??;
            let (manifest, selected) = match capture {
                Capture::Pending(manifest, selected) => (manifest, selected),
                Capture::Committed(capture) => return Ok(Response::new(capture)),
            };
            let stream = tokio_stream::iter(upload_records(manifest.clone(), selected));
            let mut upstream = authenticated_request(stream, &self.host_token, None)?;
            upstream.set_timeout(operation_deadline.saturating_duration_since(Instant::now()));
            let capture = self
                .coordination
                .artifacts
                .clone()
                .upload_capture(upstream)
                .await?
                .into_inner();
            if capture.files != manifest.files
                || capture.summary.as_ref().is_none_or(|summary| {
                    summary.artifact_id.is_empty()
                        || summary.description != manifest.description
                        || summary.producer.as_ref().is_none_or(|producer| {
                            producer.task_id != task.task_id
                                || producer.attempt_id != self.assignment.attempt_id
                                || producer.native_session_id != manifest.native_session_id
                        })
                })
            {
                return Err(Status::data_loss(
                    "artifact receipt differs from the selected files or Attempt",
                ));
            }
            let capture = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                snapshots
                    .commit(&manifest.operation_id, &capture)
                    .map_err(|_| Status::data_loss("artifact receipt could not be saved safely"))?;
                Ok::<_, Status>(capture)
            })
            .await
            .map_err(|_| Status::internal("artifact receipt journal failed"))??;
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

pub(crate) fn upload_records(
    manifest: CommitArtifactCaptureRequest,
    selected: Vec<Vec<u8>>,
) -> impl Iterator<Item = ArtifactUpload> + Send + 'static {
    let chunks = selected.into_iter().enumerate().flat_map(|(index, bytes)| {
        (0..bytes.len())
            .step_by(CHECKPOINT_CHUNK_BYTES)
            .map(move |offset| ArtifactUpload {
                part: Some(artifact_upload::Part::Chunk(ArtifactChunk {
                    file_index: index as u32,
                    data: bytes[offset..bytes.len().min(offset + CHECKPOINT_CHUNK_BYTES)].to_vec(),
                })),
            })
    });
    std::iter::once(ArtifactUpload {
        part: Some(artifact_upload::Part::Begin(manifest)),
    })
    .chain(chunks)
}
