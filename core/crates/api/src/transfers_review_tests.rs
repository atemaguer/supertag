use super::*;
use crate::PRINCIPAL;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicUsize, Ordering};
use supertag_protocol::host_generation;
use supertag_protocol::{
    authenticated_request,
    v2::{
        credential_directory_server::{CredentialDirectory, CredentialDirectoryServer},
        transfers_client::TransfersClient,
        workspace_directory_server::{WorkspaceDirectory, WorkspaceDirectoryServer},
        workspace_git_access_client::WorkspaceGitAccessClient,
    },
};
use tonic::{
    Code,
    transport::{Endpoint, Server, server::TcpIncoming},
};

#[derive(Clone)]
struct Directory {
    reference: WorkspaceDeliveryReference,
    reads: Arc<AtomicUsize>,
    /// The reviewed delivery's remote Workspace; None for a local one.
    workspace: Option<Workspace>,
    minted_credentials_only: bool,
    expires_at_ms: i64,
}

const HOST_TOKEN: &str = "stcr_7777777777777777777777777777777777777777777777777777777777777777";

#[tonic::async_trait]
impl CredentialDirectory for Directory {
    async fn resolve(
        &self,
        request: Request<ResolveCredentialRequest>,
    ) -> Result<Response<ResolvedCredential>, Status> {
        assert_eq!(
            request.metadata().get("authorization").unwrap(),
            "Bearer private-token"
        );
        if request.into_inner().token_digest != Sha256::digest(HOST_TOKEN).to_vec() {
            return Err(Status::unauthenticated("unknown host"));
        }
        Ok(Response::new(ResolvedCredential {
            role: PrincipalRole::Host.into(),
            name: "reviewer-host".into(),
            generation: 7,
            ..Default::default()
        }))
    }
}

#[tonic::async_trait]
impl WorkspaceDirectory for Directory {
    async fn get_source(
        &self,
        _: Request<DownloadWorkspaceSourceRequest>,
    ) -> Result<Response<WorkspaceSourceBundle>, Status> {
        Err(Status::unimplemented("review artifact fixture"))
    }
    async fn get_review_artifact(
        &self,
        request: Request<GetReviewArtifactRequest>,
    ) -> Result<Response<HeldWorkspaceDelivery>, Status> {
        assert_eq!(
            request.metadata().get("authorization").unwrap(),
            "Bearer private-token"
        );
        assert_eq!(
            request.metadata().get(PRINCIPAL).unwrap(),
            "host:reviewer-host"
        );
        assert_eq!(host_generation(&request)?, 7);
        assert!(!request.metadata().contains_key("x-forged"));
        let input = request.into_inner();
        let expected = InspectAttemptRequest {
            task_id: "reviewer-task".into(),
            attempt_id: "reviewer-attempt".into(),
            lease_token: "lease".into(),
        };
        if input.review_id != "review" || input.attempt.as_ref() != Some(&expected) {
            return Err(Status::permission_denied("not the intended review Attempt"));
        }
        self.reads.fetch_add(1, Ordering::SeqCst);
        Ok(Response::new(HeldWorkspaceDelivery {
            delivery: Some(self.reference.clone()),
            holder: Some(BlobHolder {
                host_id: "producer-host".into(),
                attempt_id: "producer-attempt".into(),
            }),
            session_branch: if self.workspace.is_some() {
                "supertag/session/producer".into()
            } else {
                String::new()
            },
            workspace: self.workspace.clone(),
            minted_credentials_only: self.minted_credentials_only,
        }))
    }
    async fn get_continuation(
        &self,
        _: Request<InspectAttemptRequest>,
    ) -> Result<Response<WorkspaceContinuation>, Status> {
        Err(Status::unimplemented("not used"))
    }
    async fn reserve_delivery(
        &self,
        _: Request<WorkspaceDeliveryRequest>,
    ) -> Result<Response<WorkspaceDeliveryReference>, Status> {
        Err(Status::unimplemented("not used"))
    }
    async fn commit_delivery(
        &self,
        _: Request<WorkspaceDeliveryRequest>,
    ) -> Result<Response<WorkspaceDeliveryReference>, Status> {
        Err(Status::unimplemented("not used"))
    }
}

struct ServerTask(tokio::task::JoinHandle<Result<(), tonic::transport::Error>>);
impl Drop for ServerTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn request(review_id: &str, token: &str, generation: u64) -> Request<GetReviewArtifactRequest> {
    let mut request = authenticated_request(
        GetReviewArtifactRequest {
            review_id: review_id.into(),
            attempt: Some(InspectAttemptRequest {
                task_id: "reviewer-task".into(),
                attempt_id: "reviewer-attempt".into(),
                lease_token: "lease".into(),
            }),
        },
        token,
        None,
    )
    .unwrap();
    request
        .metadata_mut()
        .insert(supertag_protocol::HOST_GENERATION_HEADER, generation.into());
    request
        .metadata_mut()
        .insert(PRINCIPAL, "host:forged".parse().unwrap());
    request
        .metadata_mut()
        .insert("x-forged", "true".parse().unwrap());
    request
}

struct Git {
    expires_at_ms: i64,
}

#[tonic::async_trait]
impl WorkspaceGit for Git {
    async fn grant(
        &self,
        workspace: &Workspace,
        push: bool,
    ) -> Result<(Option<workspace_git_grant::Credential>, i64)> {
        assert_eq!(workspace.workspace_id, "project");
        assert!(!push, "a review reads, never pushes");
        Ok((
            Some(workspace_git_grant::Credential::Https(HttpsGitCredential {
                username: "x-access-token".into(),
                token: "read-token".into(),
            })),
            self.expires_at_ms,
        ))
    }

    async fn advertised_output_remote(
        &self,
        _: &Workspace,
        _: &str,
        _: &tokio_util::sync::CancellationToken,
    ) -> Result<Option<String>> {
        unreachable!("not used")
    }

    async fn check(
        &self,
        _: &Workspace,
        _: &tokio_util::sync::CancellationToken,
    ) -> Result<WorkspaceCheck> {
        unreachable!("not used")
    }
}

async fn api(
    channel: ProtocolChannel,
    expires_at_ms: i64,
) -> anyhow::Result<(
    ServerTask,
    TransfersClient<tonic::transport::Channel>,
    WorkspaceGitAccessClient<tonic::transport::Channel>,
)> {
    let api = Api::new(
        channel,
        "private-token".into(),
        "operator-token".into(),
        "operator:alice".into(),
    )?;
    let incoming = TcpIncoming::bind("127.0.0.1:0".parse()?)?;
    let address = incoming.local_addr()?;
    let transfers = ApiTransfers::new(api).with_workspace_git(Arc::new(Git { expires_at_ms }));
    let server = tokio::spawn(
        Server::builder()
            .add_service(transfers.workspace_git_access_service())
            .add_service(transfers.service())
            .serve_with_incoming(incoming),
    );
    let channel = Endpoint::from_shared(format!("http://{address}"))?
        .connect()
        .await?;
    Ok((
        ServerTask(server),
        TransfersClient::new(channel.clone()),
        WorkspaceGitAccessClient::new(channel),
    ))
}

fn mint(review_id: &str, token: &str, generation: u64) -> Request<MintWorkspaceGitAccessRequest> {
    let (metadata, extensions, review) = request(review_id, token, generation).into_parts();
    Request::from_parts(
        metadata,
        extensions,
        MintWorkspaceGitAccessRequest {
            attempt: review.attempt,
            review_id: review.review_id,
            permission: WorkspaceGitPermission::Read.into(),
            ..Default::default()
        },
    )
}

async fn private(state: &Directory) -> anyhow::Result<(ServerTask, ProtocolChannel)> {
    let incoming = TcpIncoming::bind("127.0.0.1:0".parse()?)?;
    let address = incoming.local_addr()?;
    let server = ServerTask(tokio::spawn(
        Server::builder()
            .add_service(CredentialDirectoryServer::new(state.clone()))
            .add_service(WorkspaceDirectoryServer::new(state.clone()))
            .serve_with_incoming(incoming),
    ));
    let channel = Endpoint::from_shared(format!("http://{address}"))?
        .connect()
        .await?;
    Ok((
        server,
        supertag_protocol::negotiation::bind_current(channel),
    ))
}

fn reference() -> WorkspaceDeliveryReference {
    let bytes = b"diff --git a/setup.sh b/setup.sh\n+untrusted patch text\n";
    let blob = BlobReference {
        sha256: format!("{:x}", Sha256::digest(bytes)),
        byte_length: bytes.len() as u64,
    };
    WorkspaceDeliveryReference {
        workspace_id: "project".into(),
        delivery_id: "a".repeat(64),
        base_commit: "1".repeat(40),
        start_commit: "1".repeat(40),
        head_commit: "2".repeat(40),
        committed: true,
        changed_files: 1,
        patch: Some(blob.clone()),
        bundle: Some(blob),
    }
}

/// The reviewer's Worker Host learns where the reviewed delivery lives, and for a remote
/// Workspace gets a read credential for its Session branch. No delivery bytes pass through the
/// Control Plane; the state owner checks every request's review scope.
#[tokio::test]
async fn review_delivery_names_its_source_and_grants_only_a_read_of_its_session_branch()
-> anyhow::Result<()> {
    let state = Directory {
        reference: reference(),
        reads: Arc::default(),
        minted_credentials_only: false,
        expires_at_ms: 42,
        workspace: Some(Workspace {
            workspace_id: "project".into(),
            remote: "https://example.com/project.git".into(),
            ..Default::default()
        }),
    };
    let (_private, channel) = private(&state).await?;
    let (_server, mut transfers, mut git) = api(channel, state.expires_at_ms).await?;

    let held = transfers
        .get_review_delivery(request("review", HOST_TOKEN, 7))
        .await?
        .into_inner();
    assert_eq!(held.delivery, Some(state.reference.clone()));
    assert_eq!(held.holder.unwrap().attempt_id, "producer-attempt");
    assert_eq!(held.workspace, state.workspace);
    assert_eq!(held.session_branch, "supertag/session/producer");

    let grant = git.mint(mint("review", HOST_TOKEN, 7)).await?.into_inner();
    assert_eq!(grant.commit, state.reference.head_commit);
    assert_eq!(grant.branch, "supertag/session/producer");
    assert_eq!(grant.workspace, state.workspace);
    assert_eq!(grant.expires_at_ms, 42);
    assert!(matches!(
        grant.credential,
        Some(workspace_git_grant::Credential::Https(_))
    ));

    for (token, generation, review) in [
        ("operator-token", 7, "review"),
        (HOST_TOKEN, 6, "review"),
        (HOST_TOKEN, 7, "another-review"),
    ] {
        assert_eq!(
            transfers
                .get_review_delivery(request(review, token, generation))
                .await
                .unwrap_err()
                .code(),
            Code::PermissionDenied
        );
        assert_eq!(
            git.mint(mint(review, token, generation))
                .await
                .unwrap_err()
                .code(),
            Code::PermissionDenied
        );
    }
    assert!(state.reads.load(Ordering::SeqCst) >= 2);
    Ok(())
}

/// A local Workspace's delivery is readable only on the Worker Host holding it: no credential.
#[tokio::test]
async fn a_local_review_delivery_grants_no_git_read() -> anyhow::Result<()> {
    let state = Directory {
        reference: reference(),
        reads: Arc::default(),
        workspace: None,
        minted_credentials_only: false,
        expires_at_ms: 42,
    };
    let (_private, channel) = private(&state).await?;
    let (_server, mut transfers, mut git) = api(channel, state.expires_at_ms).await?;
    let held = transfers
        .get_review_delivery(request("review", HOST_TOKEN, 7))
        .await?
        .into_inner();
    assert_eq!(held.workspace, None);
    assert_eq!(held.holder.unwrap().host_id, "producer-host");
    let error = git.mint(mint("review", HOST_TOKEN, 7)).await.unwrap_err();
    assert_eq!(error.code(), Code::FailedPrecondition, "{error:?}");
    Ok(())
}

#[tokio::test]
async fn work_only_review_grants_require_expiring_credentials() -> anyhow::Result<()> {
    for (work_only, expires_at_ms, allowed) in [
        (true, 0, false),
        (false, 0, true),
        (true, 42, true),
        (false, 42, true),
    ] {
        let state = Directory {
            reference: reference(),
            reads: Arc::default(),
            workspace: Some(Workspace {
                workspace_id: "project".into(),
                remote: "https://example.com/project.git".into(),
                ..Default::default()
            }),
            minted_credentials_only: work_only,
            expires_at_ms,
        };
        let (_private, channel) = private(&state).await?;
        let (_server, _, mut git) = api(channel, expires_at_ms).await?;
        let result = git.mint(mint("review", HOST_TOKEN, 7)).await;
        if allowed {
            assert_eq!(result?.into_inner().expires_at_ms, expires_at_ms);
        } else {
            let error = result.unwrap_err();
            assert_eq!(error.code(), Code::FailedPrecondition);
            assert!(error.message().contains("GitHub App Workspace Credential"));
        }
    }
    Ok(())
}
