//! Read-only pages of an immutable, explicitly authorized review patch.

use std::time::Duration;

use sha2::{Digest, Sha256};
use supertag_protocol::{
    authenticated_request,
    v2::{
        transfers_client::TransfersClient, workspace_git_access_client::WorkspaceGitAccessClient, *,
    },
    validate_workspace_delivery,
};
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
        let read = async {
            let (reference, bytes) = self.reviewed_patch(&input.review_id).await?;
            page(&input.review_id, input.offset, reference, &bytes).map(Response::new)
        };
        self.inputs.forward(deadline, read).await
    }

    /// The reviewed delivery's patch, checked against its receipt. The Control Plane names the
    /// delivery and where it is, and passes no bytes: this host reads the patch from its own
    /// artifact storage when it holds it, or rebuilds it from the remote Workspace's Session
    /// branch with a read grant for the review.
    async fn reviewed_patch(
        &self,
        review_id: &str,
    ) -> Result<(WorkspaceDeliveryReference, Vec<u8>), Status> {
        let transfers = &self.coordination.transfers;
        let review = GetReviewArtifactRequest {
            attempt: Some(self.attempt()),
            review_id: review_id.into(),
        };
        let held =
            TransfersClient::with_interceptor(transfers.channel.clone(), transfers.headers.clone())
                .get_review_delivery(authenticated_request(review, &self.host_token, None)?)
                .await?
                .into_inner();
        let reference = held
            .delivery
            .ok_or_else(|| Status::data_loss("review has no delivery receipt"))?;
        validate_workspace_delivery(&reference).map_err(|error| {
            crate::failures::noted(
                Status::data_loss("review patch delivery receipt is invalid"),
                &error,
            )
        })?;
        let blob = reference.patch.clone().expect("validated patch reference");
        if let (Some(storage), Some(holder)) = (&transfers.storage, &held.holder) {
            let storage = storage.clone();
            let attempt = holder.attempt_id.clone();
            let local = blob.clone();
            if let Ok(Ok(bytes)) =
                tokio::task::spawn_blocking(move || storage.read_held(&attempt, &local)).await
            {
                return Ok((reference, bytes));
            }
        }
        if held.workspace.is_none() {
            return Err(Status::failed_precondition(
                "the reviewed delivery is in a local Workspace, readable only on the Worker Host holding it",
            ));
        }
        let git =
            self.coordination.review_git.as_ref().ok_or_else(|| {
                Status::unavailable("this Worker Host cannot read remote Workspaces")
            })?;
        let grant = WorkspaceGitAccessClient::with_interceptor(
            transfers.channel.clone(),
            transfers.headers.clone(),
        )
        .mint(authenticated_request(
            MintWorkspaceGitAccessRequest {
                attempt: Some(self.attempt()),
                permission: WorkspaceGitPermission::Read as i32,
                review_id: review_id.into(),
                ..Default::default()
            },
            &self.host_token,
            None,
        )?)
        .await?
        .into_inner();
        if grant.commit != reference.head_commit || grant.branch.is_empty() {
            return Err(Status::data_loss("the review grant names another delivery"));
        }
        let workspace = grant
            .workspace
            .clone()
            .ok_or_else(|| Status::data_loss("the review grant has no Workspace"))?;
        let unreadable = |error: anyhow::Error| {
            crate::failures::noted(
                Status::unavailable("the reviewed Session branch could not be read"),
                &format!("{error:#}"),
            )
        };
        let cancel = tokio_util::sync::CancellationToken::new();
        let fetched = git
            .fetch_session(
                &workspace,
                &grant.branch,
                &reference.head_commit,
                crate::workspaces::granted_credential(grant.credential),
                &cancel,
            )
            .await
            .map_err(unreadable)?
            .ok_or_else(|| {
                Status::unavailable(
                    "the reviewed Session branch does not hold the delivery yet: its Worker Host has not pushed it",
                )
            })?;
        let bytes = supertag_workspaces::source::delivery_patch(
            &fetched.directory.path().join("review"),
            &fetched.bundle,
            &reference.start_commit,
            &reference.head_commit,
            &cancel,
        )
        .await
        .map_err(unreadable)?;
        if bytes.len() as u64 != blob.byte_length
            || format!("{:x}", Sha256::digest(&bytes)) != blob.sha256
        {
            return Err(Status::data_loss(
                "review patch does not match its delivery receipt",
            ));
        }
        Ok((reference, bytes))
    }
}

/// One page of a review patch whose bytes were checked against its receipt.
fn page(
    review_id: &str,
    offset: u64,
    reference: WorkspaceDeliveryReference,
    bytes: &[u8],
) -> Result<HarnessReviewPatch, Status> {
    let length = bytes.len() as u64;
    if offset > length {
        return Err(Status::invalid_argument(
            "review patch offset exceeds its length",
        ));
    }
    let end = offset.saturating_add(REVIEW_PAGE_BYTES as u64).min(length);
    Ok(HarnessReviewPatch {
        review_id: review_id.into(),
        offset,
        data: bytes[offset as usize..end as usize].to_vec(),
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
        let headers = crate::HostHeaders::new(1, 2);
        Bridge {
            token: "execution-token".into(),
            host_token: "host-token".into(),
            harness: supertag_protocol::v2::HarnessKind::Unspecified,
            assignment: Assignment {
                native_memory: None,
                task: Some(Task {
                    task_id: "review-task".into(),
                    ..Default::default()
                }),
                attempt_id: "review-attempt".into(),
                lease_token: "review-lease".into(),
                joined: vec![],
                volume: None,
            },
            checkpoint: None,
            resolved_skills: vec![],
            host: worker_host_client::WorkerHostClient::with_interceptor(
                channel.clone(),
                headers.clone(),
            ),
            coordination: crate::CoordinationClients {
                acquisitions: attempt_artifacts_client::AttemptArtifactsClient::with_interceptor(channel.clone(), headers.clone()),
                mcp_effects: supertag_protocol::v2::attempt_mcp_effects_client::AttemptMcpEffectsClient::with_interceptor(
                    channel.clone(),
                    headers.clone(),
                ),
                changed_paths: supertag_protocol::v2::attempt_changed_paths_client::AttemptChangedPathsClient::with_interceptor(
                    channel.clone(),
                    headers.clone(),
                ),
                task_files: supertag_protocol::v2::attempt_task_files_client::AttemptTaskFilesClient::with_interceptor(
                    channel.clone(),
                    headers.clone(),
                ),
                effects: supertag_protocol::v2::attempt_effects_client::AttemptEffectsClient::with_interceptor(
                    channel.clone(),
                    headers.clone(),
                ),
                transfers: crate::checkpoints::Transfers::new(channel.clone(), headers.clone()),
                artifact_source: None,
                review_git: None,
                artifact_peers: crate::ArtifactPeers::default(),
                volumes: Default::default(),
                volume_objects: supertag_protocol::v2::volume_objects_client::VolumeObjectsClient::with_interceptor(
                    channel.clone(),
                    headers.clone(),
                ),
                workspace_mounts: supertag_protocol::v2::attempt_workspace_mounts_client::AttemptWorkspaceMountsClient::with_interceptor(channel.clone(), headers.clone()),
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
                tag_sessions: supertag_protocol::v2::attempt_tag_sessions_client::AttemptTagSessionsClient::with_interceptor(
                    channel.clone(),
                    headers.clone(),
                ),
                schedules: supertag_protocol::v2::attempt_schedules_client::AttemptSchedulesClient::with_interceptor(
                    channel.clone(),
                    headers.clone(),
                ),
                memory: supertag_protocol::v2::attempt_memory_client::AttemptMemoryClient::with_interceptor(
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
            workspace: None,
            mcp: None,
            mcp_lane: Default::default(),
            artifact_checkout: None,
            artifact_inputs: None,
            artifact_capacity: std::sync::Arc::new(tokio::sync::Semaphore::new(1)),
            secrets: std::sync::Arc::default(),
            text: Default::default(),
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

    #[test]
    fn pages_a_checked_binary_patch_without_truncation() {
        let bytes: Vec<u8> = (0..REVIEW_PAGE_BYTES * 2 + 17)
            .map(|index| (index % 256) as u8)
            .collect();
        let mut assembled = vec![];
        let mut offset = 0;
        loop {
            let page = page("review", offset, reference(&bytes), &bytes).unwrap();
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
        let eof = page("review", bytes.len() as u64, reference(&bytes), &bytes).unwrap();
        assert!(eof.data.is_empty());
        assert_eq!(eof.next_offset, None);
        assert_eq!(
            page("review", u64::MAX, reference(&bytes), &bytes)
                .unwrap_err()
                .code(),
            tonic::Code::InvalidArgument
        );
        let empty = page("review", 0, reference(b""), b"").unwrap();
        assert!(empty.data.is_empty());
        assert_eq!(empty.next_offset, None);
    }
}
