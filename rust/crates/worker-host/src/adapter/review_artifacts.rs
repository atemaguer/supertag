//! Read-only pages of an immutable, explicitly authorized review patch.

use std::time::Duration;

use sha2::{Digest, Sha256};
use supertag_protocol::{
    CHECKPOINT_CHUNK_BYTES, MAX_MESSAGE_BYTES, authenticated_request,
    v2::{transfers_client::TransfersClient, workspace_download, *},
    validate_workspace_delivery,
};
use tokio_stream::{Stream, StreamExt};
use tonic::{Request, Response, Status};

use super::Bridge;

const REVIEW_PAGE_BYTES: usize = 16 * 1024;
const REVIEW_READ_TIMEOUT: Duration = Duration::from_secs(120);

impl Bridge {
    pub(super) async fn review_patch(
        &self,
        request: Request<HarnessReadReviewPatchRequest>,
    ) -> Result<Response<HarnessReviewPatch>, Status> {
        self.authenticate(&request)?;
        self.require_attached()?;
        let state = self.state.lock().await;
        if state.outcome.is_some() {
            return Err(Status::failed_precondition("execution is complete"));
        }
        let deadline = self
            .inputs
            .active_deadline()?
            .min(tokio::time::Instant::now() + REVIEW_READ_TIMEOUT);
        let input = request.into_inner();
        let transfers = &self.coordination.transfers;
        let mut upstream = authenticated_request(
            GetReviewArtifactRequest {
                attempt: Some(self.attempt()),
                review_id: input.review_id.clone(),
            },
            &self.host_token,
            None,
        )?;
        upstream.set_timeout(deadline.saturating_duration_since(tokio::time::Instant::now()));
        let read = async {
            let stream = TransfersClient::with_interceptor(
                transfers.channel.clone(),
                transfers.headers.clone(),
            )
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .download_review_artifact(upstream)
            .await?
            .into_inner();
            verified_page(&input.review_id, input.offset, stream)
                .await
                .map(Response::new)
        };
        self.inputs.forward(deadline, read).await
    }
}

/// Retain only one page, but verify the entire artifact before exposing any byte.
/// A later corrupt chunk or rejected authority check invalidates even a valid prefix.
async fn verified_page<S>(
    review_id: &str,
    offset: u64,
    mut stream: S,
) -> Result<HarnessReviewPatch, Status>
where
    S: Stream<Item = Result<WorkspaceDownload, Status>> + Unpin,
{
    let reference = match stream.next().await.transpose()? {
        Some(WorkspaceDownload {
            part: Some(workspace_download::Part::Reference(reference)),
        }) => reference,
        _ => return Err(Status::data_loss("review patch has no delivery receipt")),
    };
    validate_workspace_delivery(&reference)
        .map_err(|_| Status::data_loss("review patch delivery receipt is invalid"))?;
    let blob = reference.patch.as_ref().expect("validated patch reference");
    if offset > blob.byte_length {
        return Err(Status::invalid_argument(
            "review patch offset exceeds its length",
        ));
    }
    let end = offset
        .saturating_add(REVIEW_PAGE_BYTES as u64)
        .min(blob.byte_length);
    let mut page = Vec::with_capacity((end - offset) as usize);
    let mut length = 0u64;
    let mut digest = Sha256::new();
    while let Some(message) = stream.next().await {
        let Some(workspace_download::Part::Chunk(chunk)) = message?.part else {
            return Err(Status::data_loss("unexpected review patch record"));
        };
        if chunk.is_empty()
            || chunk.len() > CHECKPOINT_CHUNK_BYTES
            || length + chunk.len() as u64 > blob.byte_length
        {
            return Err(Status::data_loss("invalid review patch chunk"));
        }
        let next = length + chunk.len() as u64;
        let begin = offset.max(length);
        let finish = end.min(next);
        if begin < finish {
            page.extend_from_slice(&chunk[(begin - length) as usize..(finish - length) as usize]);
        }
        digest.update(&chunk);
        length = next;
    }
    if length != blob.byte_length || format!("{:x}", digest.finalize()) != blob.sha256 {
        return Err(Status::data_loss(
            "review patch does not match its delivery receipt",
        ));
    }
    Ok(HarnessReviewPatch {
        review_id: review_id.into(),
        offset,
        data: page,
        next_offset: (end < length).then_some(end),
        delivery: Some(reference),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use supertag_protocol::v2::{BlobReference, WorkspaceDeliveryReference};

    fn bridge() -> Bridge {
        let channel = tonic::transport::Endpoint::from_static("http://127.0.0.1:1").connect_lazy();
        let headers = crate::HostHeaders("1".parse().unwrap());
        Bridge {
            token: "execution-token".into(),
            host_token: "host-token".into(),
            harness: supertag_protocol::v2::HarnessKind::Unspecified,
            assignment: Assignment {
                task: Some(Task {
                    task_id: "review-task".into(),
                    ..Default::default()
                }),
                attempt_id: "review-attempt".into(),
                lease_token: "review-lease".into(),
            },
            checkpoint: None,
            resolved_skills: vec![],
            host: worker_host_client::WorkerHostClient::with_interceptor(
                channel.clone(),
                headers.clone(),
            ),
            coordination: crate::CoordinationClients {
                transfers: crate::checkpoints::Transfers::new(channel.clone(), headers.clone()),
                workstreams: attempt_workstreams_client::AttemptWorkstreamsClient::with_interceptor(
                    channel.clone(),
                    headers.clone(),
                ),
                mailbox: attempt_mailbox_client::AttemptMailboxClient::with_interceptor(
                    channel.clone(),
                    headers.clone(),
                ),
                work_sessions:
                    attempt_work_sessions_client::AttemptWorkSessionsClient::with_interceptor(
                        channel.clone(),
                        headers.clone(),
                    ),
            },
            state: Default::default(),
            attached: Default::default(),
            inputs: super::super::inputs::InputLane::new(
                attempt_inputs_client::AttemptInputsClient::with_interceptor(channel, headers),
                tokio::time::Instant::now() + Duration::from_secs(30),
                &tokio_util::sync::CancellationToken::new(),
            ),
        }
    }

    #[tokio::test]
    async fn private_read_requires_attached_active_execution_before_transfer() {
        let bridge = bridge();
        let request = || {
            authenticated_request(
                HarnessReadReviewPatchRequest {
                    review_id: "review".into(),
                    offset: 0,
                },
                "execution-token",
                None,
            )
            .unwrap()
        };
        assert_eq!(
            bridge
                .review_patch(Request::new(HarnessReadReviewPatchRequest::default()))
                .await
                .unwrap_err()
                .code(),
            tonic::Code::Unauthenticated
        );
        assert_eq!(
            bridge.review_patch(request()).await.unwrap_err().code(),
            tonic::Code::FailedPrecondition
        );
        bridge
            .attached
            .store(true, std::sync::atomic::Ordering::Release);
        bridge.state.lock().await.outcome = Some(HarnessCompleteRequest::default());
        assert_eq!(
            bridge.review_patch(request()).await.unwrap_err().code(),
            tonic::Code::FailedPrecondition
        );
        bridge.state.lock().await.outcome = None;
        bridge
            .inputs
            .set_deadline(tokio::time::Instant::now() - Duration::from_millis(1));
        assert_eq!(
            bridge.review_patch(request()).await.unwrap_err().code(),
            tonic::Code::DeadlineExceeded
        );
        bridge.inputs.close();
        assert_eq!(
            bridge.review_patch(request()).await.unwrap_err().code(),
            tonic::Code::FailedPrecondition
        );
    }

    fn reference(bytes: &[u8]) -> WorkspaceDeliveryReference {
        let blob = BlobReference {
            sha256: format!("{:x}", Sha256::digest(bytes)),
            byte_length: bytes.len() as u64,
        };
        WorkspaceDeliveryReference {
            workspace_id: "project".into(),
            delivery_id: "a".repeat(64),
            base_commit: "1".repeat(40),
            start_commit: "1".repeat(40),
            head_commit: if bytes.is_empty() { "1" } else { "2" }.repeat(40),
            committed: !bytes.is_empty(),
            changed_files: u64::from(!bytes.is_empty()),
            patch: Some(blob),
            bundle: Some(BlobReference {
                sha256: format!("{:x}", Sha256::digest(b"bundle")),
                byte_length: 6,
            }),
        }
    }

    fn records(bytes: &[u8]) -> Vec<Result<WorkspaceDownload, Status>> {
        let mut records = vec![Ok(WorkspaceDownload {
            part: Some(workspace_download::Part::Reference(reference(bytes))),
        })];
        records.extend(bytes.chunks(CHECKPOINT_CHUNK_BYTES).map(|chunk| {
            Ok(WorkspaceDownload {
                part: Some(workspace_download::Part::Chunk(chunk.to_vec())),
            })
        }));
        records
    }

    #[tokio::test]
    async fn pages_verified_binary_patch_without_truncation() {
        let bytes: Vec<u8> = (0..REVIEW_PAGE_BYTES * 2 + 17)
            .map(|index| (index % 256) as u8)
            .collect();
        let mut assembled = vec![];
        let mut offset = 0;
        loop {
            let page = verified_page("review", offset, tokio_stream::iter(records(&bytes)))
                .await
                .unwrap();
            assert_eq!(page.review_id, "review");
            assert_eq!(page.offset, offset);
            assert_eq!(page.delivery, Some(reference(&bytes)));
            assert!(page.data.len() <= REVIEW_PAGE_BYTES);
            assembled.extend(page.data);
            let Some(next) = page.next_offset else { break };
            assert_eq!(next, assembled.len() as u64);
            offset = next;
        }
        assert_eq!(assembled, bytes);
        let eof = verified_page(
            "review",
            bytes.len() as u64,
            tokio_stream::iter(records(&bytes)),
        )
        .await
        .unwrap();
        assert!(eof.data.is_empty());
        assert_eq!(eof.next_offset, None);
        assert_eq!(
            verified_page("review", u64::MAX, tokio_stream::iter(records(&bytes)))
                .await
                .unwrap_err()
                .code(),
            tonic::Code::InvalidArgument
        );
    }

    #[tokio::test]
    async fn does_not_release_a_valid_prefix_when_later_bytes_or_authority_fail() {
        let bytes = vec![b'a'; CHECKPOINT_CHUNK_BYTES + 17];
        let mut corrupt = records(&bytes);
        if let Some(workspace_download::Part::Chunk(chunk)) =
            &mut corrupt.last_mut().unwrap().as_mut().unwrap().part
        {
            chunk[0] = b'b';
        }
        assert_eq!(
            verified_page("review", 0, tokio_stream::iter(corrupt))
                .await
                .unwrap_err()
                .code(),
            tonic::Code::DataLoss
        );
        let mut revoked = records(&bytes);
        revoked.push(Err(Status::permission_denied("reviewer authority expired")));
        assert_eq!(
            verified_page("review", 0, tokio_stream::iter(revoked))
                .await
                .unwrap_err()
                .code(),
            tonic::Code::PermissionDenied
        );
        let mut truncated = records(&bytes);
        truncated.pop();
        assert_eq!(
            verified_page("review", 0, tokio_stream::iter(truncated))
                .await
                .unwrap_err()
                .code(),
            tonic::Code::DataLoss
        );
    }

    #[tokio::test]
    async fn rejects_malformed_transfer_records() {
        let mut duplicate_header = records(b"patch");
        duplicate_header.push(duplicate_header[0].clone());
        let mut empty_chunk = records(b"patch");
        empty_chunk.push(Ok(WorkspaceDownload {
            part: Some(workspace_download::Part::Chunk(vec![])),
        }));
        let mut oversized = records(b"patch");
        oversized[1] = Ok(WorkspaceDownload {
            part: Some(workspace_download::Part::Chunk(vec![
                0;
                CHECKPOINT_CHUNK_BYTES
                    + 1
            ])),
        });
        for messages in [
            vec![],
            records(b"patch")[1..].to_vec(),
            duplicate_header,
            empty_chunk,
            oversized,
        ] {
            assert_eq!(
                verified_page("review", 0, tokio_stream::iter(messages))
                    .await
                    .unwrap_err()
                    .code(),
                tonic::Code::DataLoss
            );
        }
        let page = verified_page("review", 0, tokio_stream::iter(records(b"")))
            .await
            .unwrap();
        assert!(page.data.is_empty());
        assert_eq!(page.next_offset, None);
    }
}
