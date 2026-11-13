use super::*;
use supertag_protocol::artifacts::{
    MAX_ARTIFACT_FILE_BYTES, validate_artifact_path, validate_capture_manifest,
};

const ARTIFACT_TRANSFER_TIMEOUT: Duration = Duration::from_secs(60);
const VOLUME_SEARCH_TIMEOUT: Duration = Duration::from_secs(30);
const VOLUME_READ_TIMEOUT: Duration = Duration::from_secs(12);

use locate_artifact_volume_copies_request::Target;

impl GatewayTransfers {
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
            .gateway
            .forward_host(request, true, |channel, request| async move {
                artifact_client(channel).get_acquired_file(request).await
            })
            .await?
            .into_inner())
    }

    async fn operator_file(
        &self,
        metadata: tonic::metadata::MetadataMap,
        input: &DownloadArtifactFileRequest,
    ) -> Result<ArtifactFile, Status> {
        let mut lookup = Request::new(GetCapturedArtifactRequest {
            artifact_id: input.artifact_id.clone(),
        });
        *lookup.metadata_mut() = metadata;
        let capture = artifact_catalog_server::ArtifactCatalog::get(self, lookup)
            .await?
            .into_inner();
        capture
            .files
            .into_iter()
            .find(|file| file.path == input.path)
            .ok_or_else(|| Status::not_found("artifact file was not found"))
    }

    async fn locate_volume_copies(
        &self,
        metadata: tonic::metadata::MetadataMap,
        target: Target,
        ids: &[String],
    ) -> Result<LocateArtifactVolumeCopiesResponse, Status> {
        let attempt = matches!(target, Target::Attempt(_));
        let mut request = Request::new(LocateArtifactVolumeCopiesRequest {
            target: Some(target),
            volume_ids: ids.to_vec(),
        });
        *request.metadata_mut() = metadata;
        let call = |channel, request| async move {
            artifact_client(channel).locate_volume_copies(request).await
        };
        let response = if attempt {
            self.gateway.forward_host(request, true, call).await?
        } else {
            self.gateway
                .forward(request, &self.gateway.credentials.operator, call)
                .await?
        };
        Ok(response.into_inner())
    }

    async fn open_artifact(
        &self,
        metadata: &tonic::metadata::MetadataMap,
        target: Target,
        blob: &BlobReference,
    ) -> Result<tokio::fs::File, Status> {
        if let Some(file) = open_optional_blob(&self.directory()?.join(&blob.sha256)).await? {
            return Ok(file);
        }
        let ids = self.volumes.candidate_ids();
        let search = async {
            for batch in ids.chunks(32) {
                let found = self
                    .locate_volume_copies(metadata.clone(), target.clone(), batch)
                    .await?;
                for location in found.locations {
                    if let Ok(Ok(file)) = timeout(
                        VOLUME_READ_TIMEOUT,
                        self.read_volume_location(&location, blob),
                    )
                    .await
                    {
                        return Ok(Some(file));
                    }
                }
            }
            Ok::<_, Status>(None)
        };
        match timeout(VOLUME_SEARCH_TIMEOUT, search).await {
            Ok(result) => result?.ok_or_else(|| Status::data_loss(
                "artifact bytes are absent from Gateway storage and no usable verified Volume copy was found",
            )),
            Err(_) => Err(Status::deadline_exceeded("artifact Volume lookup timed out")),
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

    async fn capture_artifact(
        &self,
        request: Request<Streaming<ArtifactUpload>>,
    ) -> Result<Response<CapturedArtifact>, Status> {
        let directory = self.directory()?;
        let (metadata, _, mut stream) = request.into_parts();
        let begin = match stream.message().await?.and_then(|message| message.part) {
            Some(artifact_upload::Part::Begin(begin)) => begin,
            _ => {
                return Err(Status::invalid_argument(
                    "artifact upload requires a capture manifest",
                ));
            }
        };
        validate_capture_manifest(&begin)?;
        let mut reserve = Request::new(begin.clone());
        *reserve.metadata_mut() = metadata.clone();
        let reserved = self
            .gateway
            .forward_host(reserve, true, |channel, request| async move {
                artifact_client(channel).reserve_capture(request).await
            })
            .await?
            .into_inner();

        for (index, file) in begin.files.iter().enumerate() {
            let reference = file.blob.clone().expect("validated artifact manifest");
            let mut staged = StagedBlob::new(directory, reference.clone())?;
            while staged.length < reference.byte_length {
                let Some(artifact_upload::Part::Chunk(chunk)) =
                    stream.message().await?.and_then(|message| message.part)
                else {
                    return Err(Status::invalid_argument("artifact file upload ended early"));
                };
                if chunk.file_index as usize != index {
                    return Err(Status::invalid_argument(
                        "artifact file chunks are out of order",
                    ));
                }
                staged.append(&chunk.data).await?;
            }
            staged.verify().await?;
            staged.persist(directory).await?;
        }
        if stream.message().await?.is_some() {
            return Err(Status::invalid_argument(
                "artifact upload has unexpected trailing data",
            ));
        }
        sync_directory(directory).await?;

        let mut commit = Request::new(begin);
        *commit.metadata_mut() = metadata;
        let response = self
            .gateway
            .forward_host(commit, true, |channel, request| async move {
                artifact_client(channel).commit_capture(request).await
            })
            .await?;
        if response.get_ref() != &reserved {
            return Err(Status::data_loss(
                "artifact commit differs from its reservation",
            ));
        }
        Ok(response)
    }
}

#[tonic::async_trait]
impl artifact_catalog_server::ArtifactCatalog for GatewayTransfers {
    async fn get(
        &self,
        request: Request<GetCapturedArtifactRequest>,
    ) -> Result<Response<CapturedArtifact>, Status> {
        self.gateway
            .forward(
                request,
                &self.gateway.credentials.operator,
                |channel, request| async move { artifact_client(channel).get(request).await },
            )
            .await
    }

    async fn list(
        &self,
        request: Request<ListCapturedArtifactsRequest>,
    ) -> Result<Response<ListCapturedArtifactsResponse>, Status> {
        self.gateway
            .forward(
                request,
                &self.gateway.credentials.operator,
                |channel, request| async move { artifact_client(channel).list(request).await },
            )
            .await
    }
}

#[tonic::async_trait]
impl attempt_artifacts_server::AttemptArtifacts for GatewayTransfers {
    async fn find(
        &self,
        request: Request<FindAttemptArtifactsRequest>,
    ) -> Result<Response<ListCapturedArtifactsResponse>, Status> {
        self.gateway
            .forward_host(request, true, |channel, request| async move {
                artifact_client(channel).find_for_attempt(request).await
            })
            .await
    }
    async fn inspect(
        &self,
        request: Request<InspectAttemptArtifactRequest>,
    ) -> Result<Response<CapturedArtifact>, Status> {
        self.gateway
            .forward_host(request, true, |channel, request| async move {
                artifact_client(channel).get_for_attempt(request).await
            })
            .await
    }
    async fn acquire(
        &self,
        request: Request<AcquireArtifactRequest>,
    ) -> Result<Response<ArtifactAcquisition>, Status> {
        self.gateway
            .forward_host(request, true, |channel, request| async move {
                artifact_client(channel).acquire(request).await
            })
            .await
    }
    async fn settle(
        &self,
        request: Request<SettleArtifactAcquisitionRequest>,
    ) -> Result<Response<ArtifactAcquisition>, Status> {
        self.gateway
            .forward_host(request, true, |channel, request| async move {
                artifact_client(channel).settle(request).await
            })
            .await
    }
}

#[tonic::async_trait]
impl artifact_transfers_server::ArtifactTransfers for GatewayTransfers {
    type DownloadAcquiredFileStream = ReceiverStream<Result<ArtifactDownload, Status>>;

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

    async fn upload_capture(
        &self,
        request: Request<Streaming<ArtifactUpload>>,
    ) -> Result<Response<CapturedArtifact>, Status> {
        self.authorize_upload(&request).await?;
        let _permit = self.acquire()?;
        timeout(ARTIFACT_TRANSFER_TIMEOUT, self.capture_artifact(request))
            .await
            .map_err(|_| Status::deadline_exceeded("artifact upload timed out"))?
    }

    type DownloadFileStream = ReceiverStream<Result<ArtifactDownload, Status>>;

    async fn download_file(
        &self,
        request: Request<DownloadArtifactFileRequest>,
    ) -> Result<Response<Self::DownloadFileStream>, Status> {
        let (metadata, _, input) = request.into_parts();
        validate_artifact_path(&input.path)?;
        let entry = self.operator_file(metadata.clone(), &input).await?;
        let blob = entry
            .blob
            .clone()
            .filter(|blob| {
                supertag_protocol::valid_sha256(&blob.sha256)
                    && blob.byte_length <= MAX_ARTIFACT_FILE_BYTES
            })
            .ok_or_else(|| Status::data_loss("artifact file has an invalid blob reference"))?;
        let permit = self.acquire()?;
        let file = self
            .open_artifact(&metadata, Target::Operator(input.clone()), &blob)
            .await?;
        let transfer = self.clone();
        let expected = entry.clone();
        let authorize = move || {
            let transfer = transfer.clone();
            let metadata = metadata.clone();
            let input = input.clone();
            let expected = expected.clone();
            async move {
                if transfer.operator_file(metadata, &input).await? != expected {
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
    channel: Channel,
) -> artifact_directory_client::ArtifactDirectoryClient<Channel> {
    artifact_directory_client::ArtifactDirectoryClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}
