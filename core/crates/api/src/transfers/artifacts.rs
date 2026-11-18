use super::*;
use supertag_protocol::artifacts::{
    MAX_ARTIFACT_FILE_BYTES, artifact_source_unavailable, validate_artifact_path,
    validate_capture_manifest,
};

const ARTIFACT_TRANSFER_TIMEOUT: Duration = Duration::from_secs(60);
const HOLDER_LOOKUP_TIMEOUT: Duration = Duration::from_secs(30);

use locate_artifact_copies_request::Target;

impl ApiTransfers {
    pub fn attempt_artifacts_service(
        &self,
    ) -> attempt_artifacts_server::AttemptArtifactsServer<Self> {
        attempt_artifacts_server::AttemptArtifactsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    async fn acquired_file(
        &self,
        metadata: tonic::metadata::MetadataMap,
        input: GetAcquiredArtifactFileRequest,
    ) -> Result<ArtifactFile, Status> {
        let mut request = Request::new(input);
        *request.metadata_mut() = metadata;
        Ok(self
            .api
            .forward_host(request, true, |channel, request| async move {
                artifact_client(channel).get_acquired_file(request).await
            })
            .await?
            .into_inner())
    }

    pub(super) async fn locate_copies(
        &self,
        metadata: tonic::metadata::MetadataMap,
        target: Target,
        ids: &[String],
    ) -> Result<LocateArtifactCopiesResponse, Status> {
        let attempt = matches!(target, Target::Attempt(_));
        let mut request = Request::new(LocateArtifactCopiesRequest {
            target: Some(target),
            volume_ids: ids.to_vec(),
        });
        *request.metadata_mut() = metadata;
        let call =
            |channel, request| async move { artifact_client(channel).locate_copies(request).await };
        let response = if attempt {
            self.api.forward_host(request, true, call).await?
        } else {
            self.api.forward(request, call).await?
        };
        Ok(response.into_inner())
    }

    /// Opens the bytes of one authorized artifact file from the Worker Host holding the producing
    /// Attempt's bytes, through the relay. A Volume copy is read by hosts that use the Volume.
    async fn open_artifact(
        &self,
        metadata: &tonic::metadata::MetadataMap,
        target: Target,
        blob: &BlobReference,
    ) -> Result<Source, Status> {
        let holder = timeout(
            HOLDER_LOOKUP_TIMEOUT,
            self.locate_copies(metadata.clone(), target, &[]),
        )
        .await
        .map_err(|_| Status::deadline_exceeded("artifact holder lookup timed out"))??
        .holder;
        let holder = holder.ok_or_else(|| artifact_source_unavailable(None))?;
        match self.relay.open(&holder, blob).await {
            Ok(incoming) => Ok(Source::Relay(incoming)),
            Err(RelayError::Offline) => Err(artifact_source_unavailable(Some(&holder.host_id))),
            Err(RelayError::Failed(status)) => Err(status),
        }
    }

    pub fn artifact_catalog_service(&self) -> artifact_catalog_server::ArtifactCatalogServer<Self> {
        artifact_catalog_server::ArtifactCatalogServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn artifact_transfer_service(
        &self,
    ) -> artifact_transfers_server::ArtifactTransfersServer<Self> {
        artifact_transfers_server::ArtifactTransfersServer::new(self.clone())
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
        validate_capture_manifest(&begin)?;
        if begin.source_storage_id.is_none() {
            return Err(Status::failed_precondition(
                "artifact capture requires the Worker Host's registered artifact storage",
            ));
        }
        let mut reserve = Request::new(begin);
        *reserve.metadata_mut() = metadata;
        Ok(self
            .api
            .forward_host(reserve, true, |channel, request| async move {
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
            .forward_host(commit, true, |channel, request| async move {
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
        self.authorize_upload(&request).await?;
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
        self.authorize_upload(&request).await?;
        timeout(ARTIFACT_TRANSFER_TIMEOUT, self.commit_held_capture(request))
            .await
            .map_err(|_| Status::deadline_exceeded("artifact capture commit timed out"))?
    }

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

    async fn issue_artifact_transfer(
        &self,
        request: Request<GetAcquiredArtifactFileRequest>,
    ) -> std::result::Result<Response<ArtifactTransferGrant>, Status> {
        self.api
            .forward_host(request, true, |channel, request| async move {
                artifact_client(channel)
                    .issue_artifact_transfer(request)
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

    async fn find(
        &self,
        request: Request<FindAttemptArtifactsRequest>,
    ) -> Result<Response<ListCapturedArtifactsResponse>, Status> {
        self.api
            .forward_host(request, true, |channel, request| async move {
                artifact_client(channel).find_for_attempt(request).await
            })
            .await
    }
    async fn inspect(
        &self,
        request: Request<InspectAttemptArtifactRequest>,
    ) -> Result<Response<CapturedArtifact>, Status> {
        self.api
            .forward_host(request, true, |channel, request| async move {
                artifact_client(channel).get_for_attempt(request).await
            })
            .await
    }
    async fn acquire(
        &self,
        request: Request<AcquireArtifactRequest>,
    ) -> Result<Response<ArtifactAcquisition>, Status> {
        self.api
            .forward_host(request, true, |channel, request| async move {
                artifact_client(channel).acquire(request).await
            })
            .await
    }
    async fn settle(
        &self,
        request: Request<SettleArtifactAcquisitionRequest>,
    ) -> Result<Response<ArtifactAcquisition>, Status> {
        self.api
            .forward_host(request, true, |channel, request| async move {
                artifact_client(channel).settle(request).await
            })
            .await
    }
}

#[tonic::async_trait]
impl artifact_transfers_server::ArtifactTransfers for ApiTransfers {
    type DownloadAcquiredFileStream = super::Download<ArtifactDownload>;

    async fn download_acquired_file(
        &self,
        request: Request<GetAcquiredArtifactFileRequest>,
    ) -> Result<Response<Self::DownloadAcquiredFileStream>, Status> {
        let (metadata, _, input) = request.into_parts();
        validate_artifact_path(&input.path)?;
        let entry = self.acquired_file(metadata.clone(), input.clone()).await?;
        let blob = entry
            .blob
            .clone()
            .filter(|blob| {
                supertag_protocol::valid_sha256(&blob.sha256)
                    && blob.byte_length <= MAX_ARTIFACT_FILE_BYTES
            })
            .ok_or_else(|| Status::data_loss("artifact selection has an invalid blob reference"))?;
        let permit = self.acquire()?;
        let file = self
            .open_artifact(&metadata, Target::Attempt(input.clone()), &blob)
            .await?;
        let expected = entry.clone();
        let transfer = self.clone();
        let authorize = move || {
            let transfer = transfer.clone();
            let metadata = metadata.clone();
            let input = input.clone();
            let expected = expected.clone();
            async move {
                if transfer.acquired_file(metadata, input).await? != expected {
                    return Err(Status::data_loss(
                        "artifact selection changed during transfer",
                    ));
                }
                Ok(())
            }
        };
        authorize().await?;
        Ok(Response::new(download_stream(
            file,
            permit,
            blob,
            ArtifactDownload {
                part: Some(artifact_download::Part::File(entry)),
            },
            |data| ArtifactDownload {
                part: Some(artifact_download::Part::Chunk(data)),
            },
            authorize,
            ARTIFACT_TRANSFER_TIMEOUT,
        )))
    }
}

fn artifact_client(
    channel: ProtocolChannel,
) -> artifact_directory_client::ArtifactDirectoryClient<ProtocolChannel> {
    artifact_directory_client::ArtifactDirectoryClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}
