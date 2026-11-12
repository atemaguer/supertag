//! Accepted path receipts are the only authority for fetching artifact bytes.
use super::Bridge;
use crate::{CoordinationClients, artifact_inputs::Inputs};
use sha2::{Digest, Sha256};
use std::time::Duration;
use supertag_protocol::{
    CHECKPOINT_CHUNK_BYTES,
    artifacts::{MAX_ARTIFACT_BYTES, MAX_ARTIFACT_FILE_BYTES, materialized_artifact_directory},
    authenticated_request,
    task_artifact_inputs::OPERATION_PREFIX,
    v2::*,
};
use tokio_stream::{Stream, StreamExt};
use tokio_util::sync::CancellationToken;
use tonic::{Request, Response, Status};

impl Bridge {
    async fn artifact_open(&self) -> Result<(), Status> {
        if self.state.lock().await.outcome.is_some() {
            return Err(Status::failed_precondition("execution is complete"));
        }
        Ok(())
    }

    pub(super) async fn find_artifacts(
        &self,
        request: Request<HarnessFindArtifactsRequest>,
    ) -> Result<Response<ListCapturedArtifactsResponse>, Status> {
        self.authenticate(&request)?;
        self.require_attached()?;
        self.artifact_open().await?;
        let input = request.into_inner();
        let deadline = self.inputs.active_deadline()?;
        let mut upstream = authenticated_request(
            FindAttemptArtifactsRequest {
                attempt: Some(self.attempt()),
                query: input.query,
                kind: input.kind,
                task_id: input.task_id,
                limit: input.limit,
                before_order: input.before_order,
            },
            &self.host_token,
            None,
        )?;
        upstream.set_timeout(Duration::from_secs(5));
        self.inputs
            .forward(
                deadline,
                self.coordination.acquisitions.clone().find(upstream),
            )
            .await
    }
    pub(super) async fn inspect_artifact(
        &self,
        request: Request<GetCapturedArtifactRequest>,
    ) -> Result<Response<CapturedArtifact>, Status> {
        self.authenticate(&request)?;
        self.require_attached()?;
        self.artifact_open().await?;
        let deadline = self.inputs.active_deadline()?;
        let mut upstream = authenticated_request(
            InspectAttemptArtifactRequest {
                attempt: Some(self.attempt()),
                artifact_id: request.into_inner().artifact_id,
            },
            &self.host_token,
            None,
        )?;
        upstream.set_timeout(Duration::from_secs(5));
        self.inputs
            .forward(
                deadline,
                self.coordination.acquisitions.clone().inspect(upstream),
            )
            .await
    }
    fn acquisition_client(&self) -> AcquisitionClient<'_> {
        AcquisitionClient {
            coordination: &self.coordination,
            host_token: &self.host_token,
            attempt: self.attempt(),
        }
    }

    pub(super) async fn read_artifact(
        &self,
        request: Request<HarnessReadArtifactRequest>,
    ) -> Result<Response<HarnessArtifactPage>, Status> {
        self.authenticate(&request)?;
        self.require_attached()?;
        self.artifact_open().await?;
        let input = request.into_inner();
        reject_reserved(&input.operation_id)?;
        let client = self.acquisition_client();
        let deadline = self
            .inputs
            .active_deadline()?
            .min(tokio::time::Instant::now() + Duration::from_secs(120));
        let operation = async {
            let acquisition = client
                .acquire(AcquireArtifactRequest {
                    attempt: Some(self.attempt()),
                    operation_id: input.operation_id,
                    artifact_id: input.artifact_id,
                    paths: vec![input.path.clone()],
                    delivery: ArtifactDelivery::Read as i32,
                    destination: None,
                })
                .await?;
            let bytes = client
                .acquired_bytes(&acquisition, &acquisition.files[0])
                .await?;
            let (text, next) = text_page(&bytes, input.offset, input.limit)?;
            let acquisition = client
                .settle_acquisition(&acquisition, ArtifactAcquisitionState::Delivered)
                .await?;
            Ok(Response::new(HarnessArtifactPage {
                acquisition: Some(acquisition),
                path: input.path,
                text,
                offset: input.offset,
                next_offset: next.unwrap_or(bytes.len() as u64),
                truncated: next.is_some(),
            }))
        };
        self.inputs.forward(deadline, operation).await
    }
    pub(super) async fn attach_artifact(
        &self,
        request: Request<HarnessAttachArtifactRequest>,
    ) -> Result<Response<HarnessAttachedArtifact>, Status> {
        self.authenticate(&request)?;
        self.require_attached()?;
        self.artifact_open().await?;
        let input = request.into_inner();
        reject_reserved(&input.operation_id)?;
        let client = self.acquisition_client();
        let inputs = self.artifact_inputs.clone().ok_or_else(|| {
            Status::failed_precondition("artifact attachment requires a prepared local checkout")
        })?;
        let permit = self
            .artifact_capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| Status::resource_exhausted("another artifact operation is in progress"))?;
        let deadline = self
            .inputs
            .active_deadline()?
            .min(tokio::time::Instant::now() + Duration::from_secs(120));
        let operation = async {
            let destination =
                materialized_artifact_directory(&self.assignment.attempt_id, &input.operation_id);
            let acquisition = client
                .acquire(AcquireArtifactRequest {
                    attempt: Some(self.attempt()),
                    operation_id: input.operation_id,
                    artifact_id: input.artifact_id,
                    paths: input.paths,
                    delivery: ArtifactDelivery::Materialize as i32,
                    destination: Some(destination.clone()),
                })
                .await?;
            let acquisition = materialize(&client, inputs, acquisition, permit, None).await?;
            Ok(Response::new(HarnessAttachedArtifact {
                acquisition: Some(acquisition),
                local_path: destination,
            }))
        };
        self.inputs.forward(deadline, operation).await
    }
}

fn reject_reserved(operation: &str) -> Result<(), Status> {
    if operation.starts_with(OPERATION_PREFIX) {
        return Err(Status::invalid_argument(
            "artifact operation ID uses a reserved prefix",
        ));
    }
    Ok(())
}

pub(crate) struct AcquisitionClient<'a> {
    pub(crate) coordination: &'a CoordinationClients,
    pub(crate) host_token: &'a str,
    pub(crate) attempt: InspectAttemptRequest,
}

impl AcquisitionClient<'_> {
    pub(crate) async fn acquire(
        &self,
        input: AcquireArtifactRequest,
    ) -> Result<ArtifactAcquisition, Status> {
        let expected = input.clone();
        let result = self
            .coordination
            .acquisitions
            .clone()
            .acquire(authenticated_request(input, self.host_token, None)?)
            .await?
            .into_inner();
        let mut paths = expected.paths;
        paths.sort();
        if result.task_id != self.attempt.task_id
            || result.attempt_id != self.attempt.attempt_id
            || result.operation_id != expected.operation_id
            || result.artifact_id != expected.artifact_id
            || result.delivery != expected.delivery
            || result.destination != expected.destination
            || result
                .files
                .iter()
                .map(|file| file.path.clone())
                .collect::<Vec<_>>()
                != paths
        {
            return Err(Status::data_loss(
                "artifact acquisition receipt differs from the request",
            ));
        }
        if result.state() == ArtifactAcquisitionState::Failed {
            return Err(Status::failed_precondition(
                "artifact acquisition previously failed",
            ));
        }
        Ok(result)
    }
    pub(crate) async fn settle_acquisition(
        &self,
        acquisition: &ArtifactAcquisition,
        state: ArtifactAcquisitionState,
    ) -> Result<ArtifactAcquisition, Status> {
        let receipt = self
            .coordination
            .acquisitions
            .clone()
            .settle(authenticated_request(
                SettleArtifactAcquisitionRequest {
                    attempt: Some(self.attempt.clone()),
                    acquisition_id: acquisition.acquisition_id.clone(),
                    state: state as i32,
                },
                self.host_token,
                None,
            )?)
            .await
            .map(Response::into_inner)?;
        if receipt.state() != state
            || receipt.acquisition_id != acquisition.acquisition_id
            || receipt.task_id != acquisition.task_id
            || receipt.attempt_id != acquisition.attempt_id
            || receipt.operation_id != acquisition.operation_id
            || receipt.artifact_id != acquisition.artifact_id
            || receipt.files != acquisition.files
            || receipt.delivery != acquisition.delivery
            || receipt.destination != acquisition.destination
        {
            return Err(Status::data_loss(
                "artifact settlement differs from the acquisition",
            ));
        }
        Ok(receipt)
    }
    pub(crate) async fn acquired_bytes(
        &self,
        acquisition: &ArtifactAcquisition,
        file: &ArtifactFile,
    ) -> Result<Vec<u8>, Status> {
        let stream = self
            .coordination
            .artifacts
            .clone()
            .download_acquired_file(authenticated_request(
                GetAcquiredArtifactFileRequest {
                    attempt: Some(self.attempt.clone()),
                    acquisition_id: acquisition.acquisition_id.clone(),
                    path: file.path.clone(),
                },
                self.host_token,
                None,
            )?)
            .await?
            .into_inner();
        verified_file(file, stream).await
    }
}

pub(crate) async fn materialize(
    client: &AcquisitionClient<'_>,
    inputs: Inputs,
    acquisition: ArtifactAcquisition,
    permit: impl Send + 'static,
    cancel: Option<&CancellationToken>,
) -> Result<ArtifactAcquisition, Status> {
    let replay = inputs.clone();
    let receipt = acquisition.clone();
    let (permit, done) = tokio::task::spawn_blocking(move || {
        let done = replay.replay(&receipt)?;
        Ok::<_, Status>((permit, done))
    })
    .await
    .map_err(|_| Status::internal("artifact input journal failed"))??;
    if !done {
        let mut files = Vec::new();
        let mut total = 0u64;
        for file in &acquisition.files {
            let length = file
                .blob
                .as_ref()
                .ok_or_else(|| Status::data_loss("artifact blob is missing"))?
                .byte_length;
            total = total.saturating_add(length);
            if total > MAX_ARTIFACT_BYTES {
                return Err(Status::resource_exhausted(
                    "artifact attachment exceeds its byte limit",
                ));
            }
            let bytes = tokio::select! {
                result = client.acquired_bytes(&acquisition, file) => result?,
                _ = cancelled(cancel) => return Err(Status::cancelled("artifact transfer cancelled")),
            };
            files.push((file.path.clone(), bytes));
        }
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            return Err(Status::cancelled("artifact attachment cancelled"));
        }
        let receipt = acquisition.clone();
        let materialized = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            inputs.materialize(&receipt, &files)
        })
        .await
        .map_err(|_| Status::internal("artifact attachment failed"))?;
        if let Err(error) = materialized {
            tokio::select! {
                _ = client.settle_acquisition(&acquisition, ArtifactAcquisitionState::Uncertain) => {},
                _ = cancelled(cancel) => {},
            }
            return Err(error);
        }
    }
    tokio::select! {
        result = client.settle_acquisition(&acquisition, ArtifactAcquisitionState::Delivered) => result,
        _ = cancelled(cancel) => Err(Status::cancelled("artifact delivery cancelled")),
    }
}

async fn cancelled(cancel: Option<&CancellationToken>) {
    match cancel {
        Some(cancel) => cancel.cancelled().await,
        None => std::future::pending().await,
    }
}

async fn verified_file<S>(expected: &ArtifactFile, mut stream: S) -> Result<Vec<u8>, Status>
where
    S: Stream<Item = Result<ArtifactDownload, Status>> + Unpin,
{
    let blob = expected
        .blob
        .as_ref()
        .ok_or_else(|| Status::data_loss("artifact blob is missing"))?;
    if blob.byte_length > MAX_ARTIFACT_FILE_BYTES {
        return Err(Status::resource_exhausted(
            "artifact file exceeds its limit",
        ));
    }
    match stream.next().await.transpose()? {
        Some(ArtifactDownload {
            part: Some(artifact_download::Part::File(file)),
        }) if file == *expected => {}
        _ => {
            return Err(Status::data_loss(
                "artifact download receipt differs from selected file",
            ));
        }
    }
    let mut bytes = Vec::with_capacity(blob.byte_length as usize);
    while let Some(record) = stream.next().await {
        let Some(artifact_download::Part::Chunk(chunk)) = record?.part else {
            return Err(Status::data_loss("unexpected artifact download record"));
        };
        if chunk.is_empty()
            || chunk.len() > CHECKPOINT_CHUNK_BYTES
            || bytes.len().saturating_add(chunk.len()) as u64 > blob.byte_length
        {
            return Err(Status::data_loss("invalid artifact download chunk"));
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.len() as u64 != blob.byte_length
        || format!("{:x}", Sha256::digest(&bytes)) != blob.sha256
    {
        return Err(Status::data_loss(
            "artifact bytes do not match the selected receipt",
        ));
    }
    Ok(bytes)
}
fn text_page(bytes: &[u8], offset: u64, limit: u32) -> Result<(String, Option<u64>), Status> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| Status::invalid_argument("artifact is not UTF-8 text"))?;
    if text.contains('\0') {
        return Err(Status::invalid_argument("artifact is not text"));
    }
    let offset = usize::try_from(offset)
        .map_err(|_| Status::invalid_argument("artifact offset is invalid"))?;
    if offset > text.len() || !text.is_char_boundary(offset) {
        return Err(Status::invalid_argument(
            "artifact offset is not a text boundary",
        ));
    }
    let limit = if limit == 0 { 12000 } else { limit };
    if limit > 64000 {
        return Err(Status::invalid_argument(
            "artifact text page limit exceeds 64000",
        ));
    }
    let mut end = (offset + limit as usize).min(text.len());
    while end > offset && !text.is_char_boundary(end) {
        end -= 1;
    }
    if end == offset && offset < text.len() {
        return Err(Status::invalid_argument(
            "artifact page limit is too short for its next character",
        ));
    }
    Ok((
        text[offset..end].to_owned(),
        (end < text.len()).then_some(end as u64),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn file() -> ArtifactFile {
        ArtifactFile {
            git_output: None,
            path: "one.txt".into(),
            blob: Some(BlobReference {
                sha256: format!("{:x}", Sha256::digest(b"hello")),
                byte_length: 5,
            }),
        }
    }
    #[tokio::test]
    async fn bytes_require_complete_exact_authorized_stream() {
        let file = file();
        let records = vec![
            Ok(ArtifactDownload {
                part: Some(artifact_download::Part::File(file.clone())),
            }),
            Ok(ArtifactDownload {
                part: Some(artifact_download::Part::Chunk(b"hello".to_vec())),
            }),
        ];
        assert_eq!(
            verified_file(&file, tokio_stream::iter(records.clone()))
                .await
                .unwrap(),
            b"hello"
        );
        let mut denied = records.clone();
        denied.push(Err(Status::permission_denied("revoked")));
        assert!(
            verified_file(&file, tokio_stream::iter(denied))
                .await
                .is_err()
        );
        let mut corrupt = records;
        corrupt[1] = Ok(ArtifactDownload {
            part: Some(artifact_download::Part::Chunk(b"other".to_vec())),
        });
        assert!(
            verified_file(&file, tokio_stream::iter(corrupt))
                .await
                .is_err()
        );
    }
    #[test]
    fn text_pages_preserve_utf8_and_boundaries() {
        assert_eq!(
            text_page("éabc".as_bytes(), 0, 3).unwrap(),
            ("éa".into(), Some(3))
        );
        assert!(text_page("éabc".as_bytes(), 1, 3).is_err());
        assert!(text_page(b"a\0b", 0, 3).is_err());
        assert!(text_page(&[255], 0, 3).is_err());
    }
}
