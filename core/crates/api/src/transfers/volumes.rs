//! Volumes: the Control Plane signs, the Worker Hosts move the bytes. An S3 Volume's credential
//! lives in the Control Plane's credential vault; the API tier presigns one PUT or GET per object
//! and checks a written object with a HEAD. A file Volume is mapped by Worker Hosts only. No Volume
//! byte passes through here.
use super::*;
use supertag_credential_vault::CredentialVault;

mod s3;

/// How long a presigned Volume URL stays valid.
const PRESIGNED_LIFETIME: Duration = Duration::from_secs(15 * 60);

/// The vault holding each S3 Volume's signing credential, as `volume-credential/<VOLUME_ID>`.
#[derive(Clone, Default)]
pub struct VolumeSigners {
    vault: Option<Arc<CredentialVault>>,
}

impl VolumeSigners {
    pub fn new(vault: CredentialVault) -> Self {
        Self {
            vault: Some(Arc::new(vault)),
        }
    }

    /// The signer for an S3 Volume; `None` for a file Volume, which hosts map themselves.
    async fn signer(&self, volume_id: &str, source: &str) -> Result<Option<s3::S3Mapping>, Status> {
        if !source.starts_with("s3://") {
            return Ok(None);
        }
        let refused =
            |reason: &str| Status::failed_precondition(format!("S3 Volume {volume_id}: {reason}"));
        let vault = self
            .vault
            .as_ref()
            .ok_or_else(|| refused("the Control Plane has no credential vault"))?;
        let value = vault
            .resolve(&supertag_protocol::volumes::credential_vault_id(volume_id))
            .await
            .map_err(|_| refused("its credential could not be read"))?
            .ok_or_else(|| {
                refused(&format!(
                    "the Control Plane holds no credential for it; run supertag volume credential set {volume_id} on the Control Plane's machine"
                ))
            })?;
        s3::S3Mapping::from_vault(source, &value)
            .map(Some)
            .map_err(|_| refused("its credential is unusable"))
    }
}

fn capture_copy_parts(
    copy: &ArtifactVolumeCopy,
) -> Result<(&ArtifactVolume, &BlobReference), Status> {
    let volume = copy
        .volume
        .as_ref()
        .ok_or_else(|| Status::data_loss("capture copy has no Volume"))?;
    let blob = copy
        .file
        .as_ref()
        .and_then(|file| file.blob.as_ref())
        .ok_or_else(|| Status::data_loss("capture copy has no file"))?;
    Ok((volume, blob))
}

fn capture_copy_refused(volume: &ArtifactVolume, reason: &str) -> Status {
    Status::failed_precondition(format!(
        "the capture's copy on Volume {} failed: {reason}",
        volume.volume_id
    ))
}

impl ApiTransfers {
    /// How the capturing Worker Host writes one copy of a new capture: an S3 copy gets a
    /// presigned PUT of exactly its object; a file copy needs none, as only a host that maps the
    /// Volume itself is placed for such a Tag. A copy already verified needs nothing.
    pub(super) async fn upload_grant(
        &self,
        copy: &ArtifactVolumeCopy,
    ) -> Result<Option<ArtifactVolumeUpload>, Status> {
        if copy.state() == ArtifactVolumeCopyState::Verified {
            return Ok(None);
        }
        let (volume, blob) = capture_copy_parts(copy)?;
        match self
            .signers
            .signer(&volume.volume_id, &volume.source)
            .await?
        {
            Some(signer) => signer
                .presign_put(&copy.storage_key, blob, PRESIGNED_LIFETIME)
                .map(Some)
                .map_err(|_| capture_copy_refused(volume, "its upload could not be signed")),
            None => Ok(None),
        }
    }

    /// Checks one copy of a capture before it commits: an S3 object's length and SHA-256 checksum
    /// with a HEAD. A file copy is the capturing host's attestation: it wrote the object through
    /// its own mapping, then reopened and verified it.
    pub(super) async fn check_capture_copy(&self, copy: &ArtifactVolumeCopy) -> Result<(), Status> {
        if copy.state() == ArtifactVolumeCopyState::Verified {
            return Ok(());
        }
        let (volume, blob) = capture_copy_parts(copy)?;
        let Some(signer) = self
            .signers
            .signer(&volume.volume_id, &volume.source)
            .await?
        else {
            return Ok(());
        };
        signer
            .verify_head(&copy.storage_key, blob)
            .await
            .map_err(|_| capture_copy_refused(volume, "it does not hold the captured bytes"))
    }

    /// Checks that an object a host wrote under a Volume grant is exactly `blob`, for an S3
    /// Volume; a file Volume's object is its writing host's attestation.
    pub async fn check_volume_object(
        &self,
        volume: &ArtifactVolume,
        key: &str,
        blob: &BlobReference,
    ) -> Result<(), Status> {
        match self
            .signers
            .signer(&volume.volume_id, &volume.source)
            .await?
        {
            Some(signer) => signer.verify_head(key, blob).await.map_err(|_| {
                Status::failed_precondition(format!(
                    "Volume {} does not hold the object",
                    volume.volume_id
                ))
            }),
            None => Ok(()),
        }
    }

    pub fn with_volume_signers(mut self, signers: VolumeSigners) -> Self {
        self.signers = signers;
        self
    }

    pub fn artifact_volumes_service(&self) -> artifact_volumes_server::ArtifactVolumesServer<Self> {
        artifact_volumes_server::ArtifactVolumesServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn volume_objects_service(&self) -> volume_objects_server::VolumeObjectsServer<Self> {
        volume_objects_server::VolumeObjectsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

fn client(
    channel: ProtocolChannel,
) -> artifact_volume_directory_client::ArtifactVolumeDirectoryClient<ProtocolChannel> {
    artifact_volume_directory_client::ArtifactVolumeDirectoryClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

#[tonic::async_trait]
impl volume_objects_server::VolumeObjects for ApiTransfers {
    async fn grant(
        &self,
        request: Request<VolumeObjectGrantRequest>,
    ) -> Result<Response<VolumeObjectGrant>, Status> {
        self.authorize_upload(&request).await?;
        let access = request.get_ref().access();
        let mut grant = self
            .api
            .forward_host(request, true, |channel, request| async move {
                client(channel).grant_object(request).await
            })
            .await?
            .into_inner();
        let volume = grant
            .volume
            .clone()
            .ok_or_else(|| Status::data_loss("Volume grant has no Volume"))?;
        let blob = grant
            .blob
            .clone()
            .ok_or_else(|| Status::data_loss("Volume grant has no object"))?;
        if let Some(signer) = self
            .signers
            .signer(&volume.volume_id, &volume.source)
            .await?
        {
            let signed = match access {
                VolumeAccess::Write => signer.presign_put(&grant.key, &blob, PRESIGNED_LIFETIME),
                _ => signer.presign_get(&grant.key, &blob, PRESIGNED_LIFETIME),
            };
            grant.presigned = Some(signed.map_err(|_| {
                Status::failed_precondition(format!(
                    "Volume {}: the object could not be signed",
                    volume.volume_id
                ))
            })?);
        }
        Ok(Response::new(grant))
    }
}

#[tonic::async_trait]
impl artifact_volumes_server::ArtifactVolumes for ApiTransfers {
    async fn put(
        &self,
        request: Request<PutArtifactVolumeRequest>,
    ) -> Result<Response<ArtifactVolume>, Status> {
        self.api
            .forward(request, |channel, request| async move {
                client(channel).put(request).await
            })
            .await
    }
    async fn get(
        &self,
        request: Request<GetArtifactVolumeRequest>,
    ) -> Result<Response<ArtifactVolume>, Status> {
        self.api
            .forward(request, |channel, request| async move {
                client(channel).get(request).await
            })
            .await
    }
    async fn list(
        &self,
        request: Request<ListArtifactVolumesRequest>,
    ) -> Result<Response<ListArtifactVolumesResponse>, Status> {
        self.api
            .forward(request, |channel, request| async move {
                client(channel).list(request).await
            })
            .await
    }
    async fn delete(
        &self,
        request: Request<DeleteArtifactVolumeRequest>,
    ) -> Result<Response<DeleteArtifactVolumeResponse>, Status> {
        self.api
            .forward(request, |channel, request| async move {
                client(channel).delete(request).await
            })
            .await
    }
    async fn get_copy(
        &self,
        request: Request<GetArtifactVolumeCopyRequest>,
    ) -> Result<Response<ArtifactVolumeCopy>, Status> {
        self.api
            .forward(request, |channel, request| async move {
                client(channel).get_copy(request).await
            })
            .await
    }
    async fn list_copies(
        &self,
        request: Request<ListArtifactVolumeCopiesRequest>,
    ) -> Result<Response<ListArtifactVolumeCopiesResponse>, Status> {
        self.api
            .forward(request, |channel, request| async move {
                client(channel).list_copies(request).await
            })
            .await
    }
}
