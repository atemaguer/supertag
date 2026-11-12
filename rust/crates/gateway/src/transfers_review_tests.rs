use super::*;
use std::{
    os::unix::fs::PermissionsExt,
    sync::atomic::{AtomicUsize, Ordering},
};
use supertag_protocol::{
    authenticated_request,
    v2::{
        host_directory_server::{HostDirectory, HostDirectoryServer},
        transfers_client::TransfersClient,
        workspace_directory_server::{WorkspaceDirectory, WorkspaceDirectoryServer},
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
    deny_after: Arc<AtomicUsize>,
}

#[tonic::async_trait]
impl HostDirectory for Directory {
    async fn authenticate(
        &self,
        request: Request<AuthenticateHostRequest>,
    ) -> Result<Response<HostRecord>, Status> {
        assert_eq!(
            request.metadata().get("authorization").unwrap(),
            "Bearer private-token"
        );
        if request.into_inner().token_digest != Sha256::digest(b"host-token").to_vec() {
            return Err(Status::unauthenticated("unknown host"));
        }
        Ok(Response::new(HostRecord {
            host_id: "reviewer-host".into(),
            generation: 7,
            revoked: false,
        }))
    }
    async fn enroll(
        &self,
        _: Request<PrivateEnrollHostRequest>,
    ) -> Result<Response<HostRecord>, Status> {
        Err(Status::unimplemented("not used"))
    }
}

#[tonic::async_trait]
impl WorkspaceDirectory for Directory {
    async fn get_review_artifact(
        &self,
        request: Request<GetReviewArtifactRequest>,
    ) -> Result<Response<WorkspaceDeliveryReference>, Status> {
        assert_eq!(
            request.metadata().get("authorization").unwrap(),
            "Bearer private-token"
        );
        assert_eq!(
            request.metadata().get("x-supertag-principal").unwrap(),
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
        if self.reads.fetch_add(1, Ordering::SeqCst) >= self.deny_after.load(Ordering::SeqCst) {
            return Err(Status::permission_denied("review authority expired"));
        }
        Ok(Response::new(self.reference.clone()))
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
    async fn get_artifact(
        &self,
        _: Request<GetWorkspaceArtifactRequest>,
    ) -> Result<Response<WorkspaceDeliveryReference>, Status> {
        panic!("review transfer must not use operator Task-ID artifact access")
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
        .insert("x-supertag-principal", "host:forged".parse().unwrap());
    request
        .metadata_mut()
        .insert("x-forged", "true".parse().unwrap());
    request
}

async fn gateway(
    channel: Channel,
    directory: &Path,
) -> anyhow::Result<(ServerTask, TransfersClient<Channel>)> {
    let gateway = Gateway::new(
        channel,
        "private-token".into(),
        "operator-token".into(),
        "operator:alice".into(),
    )?;
    let incoming = TcpIncoming::bind("127.0.0.1:0".parse()?)?;
    let address = incoming.local_addr()?;
    let server = tokio::spawn(
        Server::builder()
            .add_service(GatewayTransfers::new(gateway, Some(directory.into()))?.service())
            .serve_with_incoming(incoming),
    );
    let client = TransfersClient::connect(format!("http://{address}")).await?;
    Ok((ServerTask(server), client))
}

#[tokio::test]
async fn review_transfer_keeps_exact_scope_across_restart_and_rechecks_before_eof()
-> anyhow::Result<()> {
    let directory = tempfile::tempdir()?;
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))?;
    let bytes = b"diff --git a/setup.sh b/setup.sh\n+untrusted patch text\n";
    let blob = BlobReference {
        sha256: format!("{:x}", Sha256::digest(bytes)),
        byte_length: bytes.len() as u64,
    };
    let state = Directory {
        reference: WorkspaceDeliveryReference {
            workspace_id: "project".into(),
            delivery_id: "a".repeat(64),
            base_commit: "1".repeat(40),
            start_commit: "1".repeat(40),
            head_commit: "2".repeat(40),
            committed: true,
            changed_files: 1,
            patch: Some(blob.clone()),
            bundle: Some(blob.clone()),
        },
        reads: Arc::default(),
        deny_after: Arc::new(AtomicUsize::new(usize::MAX)),
    };
    std::fs::write(directory.path().join(&blob.sha256), bytes)?;
    let incoming = TcpIncoming::bind("127.0.0.1:0".parse()?)?;
    let address = incoming.local_addr()?;
    let _private = ServerTask(tokio::spawn(
        Server::builder()
            .add_service(HostDirectoryServer::new(state.clone()))
            .add_service(WorkspaceDirectoryServer::new(state.clone()))
            .serve_with_incoming(incoming),
    ));
    let channel = Endpoint::from_shared(format!("http://{address}"))?
        .connect()
        .await?;

    for _ in 0..2 {
        let (_server, mut client) = gateway(channel.clone(), directory.path()).await?;
        for (token, generation, review, expected) in [
            ("operator-token", 7, "review", Code::Unauthenticated),
            ("host-token", 6, "review", Code::PermissionDenied),
            ("host-token", 7, "another-review", Code::PermissionDenied),
        ] {
            assert_eq!(
                client
                    .download_review_artifact(request(review, token, generation))
                    .await
                    .unwrap_err()
                    .code(),
                expected
            );
        }
        let mut stream = client
            .download_review_artifact(request("review", "host-token", 7))
            .await?
            .into_inner();
        assert_eq!(
            stream.message().await?.unwrap().part,
            Some(workspace_download::Part::Reference(state.reference.clone()))
        );
        let mut received = vec![];
        while let Some(message) = stream.message().await? {
            let Some(workspace_download::Part::Chunk(chunk)) = message.part else {
                panic!("unexpected reference")
            };
            received.extend(chunk);
        }
        assert_eq!(received, bytes);
    }
    assert!(state.reads.load(Ordering::SeqCst) >= 4);

    let (_server, mut client) = gateway(channel, directory.path()).await?;
    state.reads.store(0, Ordering::SeqCst);
    state.deny_after.store(1, Ordering::SeqCst);
    let mut stream = client
        .download_review_artifact(request("review", "host-token", 7))
        .await?
        .into_inner();
    let failure = loop {
        match stream.message().await {
            Ok(Some(_)) => {}
            Ok(None) => panic!("revoked review transfer reported success"),
            Err(error) => break error,
        }
    };
    assert_eq!(failure.code(), Code::PermissionDenied);

    state.deny_after.store(usize::MAX, Ordering::SeqCst);
    std::fs::write(directory.path().join(&blob.sha256), b"corrupt")?;
    let mut stream = client
        .download_review_artifact(request("review", "host-token", 7))
        .await?
        .into_inner();
    let failure = loop {
        match stream.message().await {
            Ok(Some(_)) => {}
            Ok(None) => panic!("corrupt review transfer reported success"),
            Err(error) => break error,
        }
    };
    assert_eq!(failure.code(), Code::DataLoss);
    Ok(())
}
