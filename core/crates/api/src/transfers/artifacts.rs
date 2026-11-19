use super::*;
use supertag_protocol::artifacts::validate_capture_manifest;

const ARTIFACT_TRANSFER_TIMEOUT: Duration = Duration::from_secs(60);

impl ApiTransfers {
    pub fn attempt_artifacts_service(
        &self,
    ) -> attempt_artifacts_server::AttemptArtifactsServer<Self> {
        attempt_artifacts_server::AttemptArtifactsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn artifact_sources_service(&self) -> artifact_sources_server::ArtifactSourcesServer<Self> {
        artifact_sources_server::ArtifactSourcesServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn artifact_catalog_service(&self) -> artifact_catalog_server::ArtifactCatalogServer<Self> {
        artifact_catalog_server::ArtifactCatalogServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    /// Reserves a capture whose bytes the calling Worker Host holds in its registered artifact
    /// storage. The reservation lists the copies the producing Tag's artifact Volume keeps.
    async fn reserve_held_capture(
        &self,
        metadata: tonic::metadata::MetadataMap,
        begin: CommitArtifactCaptureRequest,
    ) -> Result<CapturedArtifact, Status> {
        validate_capture_manifest(&begin, None)?;
        if begin.source_storage_id.is_none() {
            return Err(Status::failed_precondition(
                "artifact capture requires the Worker Host's registered artifact storage",
            ));
        }
        let mut reserve = Request::new(begin);
        *reserve.metadata_mut() = metadata;
        Ok(self
            .api
            .forward_attempt(reserve, |channel, request| async move {
                artifact_client(channel).reserve_capture(request).await
            })
            .await?
            .into_inner())
    }

    /// Records a capture whose bytes the calling Worker Host already holds. Each Volume copy its
    /// reservation listed must already be on the Volume, written there by the host; the commit
    /// checks it and records it Verified. No bytes reach the Control Plane.
    async fn commit_held_capture(
        &self,
        request: Request<CommitArtifactCaptureRequest>,
    ) -> Result<Response<CapturedArtifact>, Status> {
        let (metadata, _, begin) = request.into_parts();
        let reserved = self
            .reserve_held_capture(metadata.clone(), begin.clone())
            .await?;
        for copy in &reserved.volume_copies {
            self.check_capture_copy(copy).await?;
        }
        let mut commit = Request::new(begin);
        *commit.metadata_mut() = metadata;
        let response = self
            .api
            .forward_attempt(commit, |channel, request| async move {
                artifact_client(channel).commit_capture(request).await
            })
            .await?;
        let unverified = |artifact: &CapturedArtifact| CapturedArtifact {
            volume_copies: vec![],
            ..artifact.clone()
        };
        if unverified(response.get_ref()) != unverified(&reserved)
            || response.get_ref().volume_copies.len() != reserved.volume_copies.len()
            || response
                .get_ref()
                .volume_copies
                .iter()
                .any(|copy| copy.state() != ArtifactVolumeCopyState::Verified)
        {
            return Err(Status::data_loss(
                "artifact commit differs from its reservation",
            ));
        }
        Ok(response)
    }
}

#[tonic::async_trait]
impl artifact_catalog_server::ArtifactCatalog for ApiTransfers {
    async fn get(
        &self,
        request: Request<GetCapturedArtifactRequest>,
    ) -> Result<Response<CapturedArtifact>, Status> {
        self.api
            .forward(request, |channel, request| async move {
                artifact_client(channel).get(request).await
            })
            .await
    }

    async fn list(
        &self,
        request: Request<ListCapturedArtifactsRequest>,
    ) -> Result<Response<ListCapturedArtifactsResponse>, Status> {
        self.api
            .forward(request, |channel, request| async move {
                artifact_client(channel).list(request).await
            })
            .await
    }
}

#[tonic::async_trait]
impl attempt_artifacts_server::AttemptArtifacts for ApiTransfers {
    async fn reserve_capture(
        &self,
        request: Request<CommitArtifactCaptureRequest>,
    ) -> Result<Response<CapturedArtifact>, Status> {
        self.api.attempt_caller(&request).await?;
        let (metadata, _, begin) = request.into_parts();
        let mut reserved = timeout(
            ARTIFACT_TRANSFER_TIMEOUT,
            self.reserve_held_capture(metadata, begin),
        )
        .await
        .map_err(|_| Status::deadline_exceeded("artifact capture reservation timed out"))??;
        for copy in &mut reserved.volume_copies {
            copy.upload = self.upload_grant(copy).await?;
        }
        Ok(Response::new(reserved))
    }

    async fn commit_capture(
        &self,
        request: Request<CommitArtifactCaptureRequest>,
    ) -> Result<Response<CapturedArtifact>, Status> {
        self.api.attempt_caller(&request).await?;
        timeout(ARTIFACT_TRANSFER_TIMEOUT, self.commit_held_capture(request))
            .await
            .map_err(|_| Status::deadline_exceeded("artifact capture commit timed out"))?
    }

    async fn issue_artifact_transfer(
        &self,
        request: Request<GetAcquiredArtifactFileRequest>,
    ) -> std::result::Result<Response<ArtifactTransferGrant>, Status> {
        self.api
            .forward_attempt(request, |channel, request| async move {
                artifact_client(channel)
                    .issue_artifact_transfer(request)
                    .await
            })
            .await
    }

    async fn find(
        &self,
        request: Request<FindAttemptArtifactsRequest>,
    ) -> Result<Response<ListCapturedArtifactsResponse>, Status> {
        self.api
            .forward_attempt(request, |channel, request| async move {
                artifact_client(channel).find_for_attempt(request).await
            })
            .await
    }
    async fn inspect(
        &self,
        request: Request<InspectAttemptArtifactRequest>,
    ) -> Result<Response<CapturedArtifact>, Status> {
        self.api
            .forward_attempt(request, |channel, request| async move {
                artifact_client(channel).get_for_attempt(request).await
            })
            .await
    }
    async fn acquire(
        &self,
        request: Request<AcquireArtifactRequest>,
    ) -> Result<Response<ArtifactAcquisition>, Status> {
        self.api
            .forward_attempt(request, |channel, request| async move {
                artifact_client(channel).acquire(request).await
            })
            .await
    }
    async fn settle(
        &self,
        request: Request<SettleArtifactAcquisitionRequest>,
    ) -> Result<Response<ArtifactAcquisition>, Status> {
        self.api
            .forward_attempt(request, |channel, request| async move {
                artifact_client(channel).settle(request).await
            })
            .await
    }
}

#[tonic::async_trait]
impl artifact_sources_server::ArtifactSources for ApiTransfers {
    async fn register_artifact_source(
        &self,
        request: Request<RegisterArtifactSourceRequest>,
    ) -> std::result::Result<Response<RegisterArtifactSourceResponse>, Status> {
        self.api
            .forward_host(request, true, |channel, request| async move {
                artifact_client(channel)
                    .register_artifact_source(request)
                    .await
            })
            .await
    }

    async fn authorize_artifact_transfer(
        &self,
        request: Request<AuthorizeArtifactTransferRequest>,
    ) -> std::result::Result<Response<AuthorizedArtifactTransfer>, Status> {
        self.api
            .forward_host(request, true, |channel, request| async move {
                artifact_client(channel)
                    .authorize_artifact_transfer(request)
                    .await
            })
            .await
    }
}

fn artifact_client(
    channel: ProtocolChannel,
) -> artifact_directory_client::ArtifactDirectoryClient<ProtocolChannel> {
    artifact_directory_client::ArtifactDirectoryClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}
