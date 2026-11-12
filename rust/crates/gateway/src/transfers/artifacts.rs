use super::*;
use supertag_protocol::artifacts::{
    MAX_ARTIFACT_FILE_BYTES, validate_artifact_path, validate_capture_manifest,
};

const ARTIFACT_TRANSFER_TIMEOUT: Duration = Duration::from_secs(60);

impl GatewayTransfers {
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
impl artifact_transfers_server::ArtifactTransfers for GatewayTransfers {
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
        let mut lookup = Request::new(GetCapturedArtifactRequest {
            artifact_id: input.artifact_id,
        });
        *lookup.metadata_mut() = metadata;
        let capture = artifact_catalog_server::ArtifactCatalog::get(self, lookup)
            .await?
            .into_inner();
        let entry = capture
            .files
            .into_iter()
            .find(|file| file.path == input.path)
            .ok_or_else(|| Status::not_found("artifact file was not found"))?;
        let blob = entry
            .blob
            .clone()
            .filter(|blob| {
                supertag_protocol::valid_sha256(&blob.sha256)
                    && blob.byte_length <= MAX_ARTIFACT_FILE_BYTES
            })
            .ok_or_else(|| Status::data_loss("artifact file has an invalid blob reference"))?;
        let permit = self.acquire()?;
        let file = open_blob(&self.directory()?.join(&blob.sha256)).await?;
        let header = ArtifactDownload {
            part: Some(artifact_download::Part::File(entry)),
        };
        Ok(Response::new(download_stream(
            file,
            permit,
            blob,
            header,
            |data| ArtifactDownload {
                part: Some(artifact_download::Part::Chunk(data)),
            },
            || async { Ok(()) },
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
