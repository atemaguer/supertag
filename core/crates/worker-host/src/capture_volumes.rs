//! Writes a capture's Volume copies straight from this host before the capture commits, when the
//! producing Tag names an artifact Volume. An S3 copy is uploaded with the presigned PUT its
//! reservation carries; a file copy goes through this host's own mapping of the Volume. The bytes
//! never pass through the Control Plane, which checks each copy when the capture commits.
use std::{collections::BTreeMap, time::Duration};

use supertag_protocol::{
    authenticated_request,
    v2::{ArtifactVolumeCopy, ArtifactVolumeCopyState, CommitArtifactCaptureRequest},
};
use tonic::{Status, codegen::InterceptedService, transport::Channel};

use crate::HostHeaders;

type Client = supertag_protocol::v2::attempt_artifacts_client::AttemptArtifactsClient<
    InterceptedService<Channel, HostHeaders>,
>;

fn refused(copy: &ArtifactVolumeCopy, reason: &str) -> Status {
    Status::failed_precondition(format!(
        "the capture's copy on artifact Volume {} failed: {reason}",
        copy.volume
            .as_ref()
            .map_or("", |volume| volume.volume_id.as_str())
    ))
}

/// Reserves the capture and writes each Volume copy its reservation lists. `selected` holds the
/// bytes of the manifest's files.
pub(crate) async fn write(
    client: &Client,
    token: &str,
    manifest: &CommitArtifactCaptureRequest,
    selected: &[Vec<u8>],
    volumes: &crate::volume_objects::HostVolumes,
    timeout: Duration,
) -> Result<(), Status> {
    let mut request = authenticated_request(manifest.clone(), token, None)?;
    request.set_timeout(timeout);
    let reserved = client.clone().reserve_capture(request).await?.into_inner();
    let bytes: BTreeMap<&str, &[u8]> = manifest
        .files
        .iter()
        .zip(selected)
        .filter_map(|(file, bytes)| Some((file.blob.as_ref()?.sha256.as_str(), bytes.as_slice())))
        .collect();
    for copy in &reserved.volume_copies {
        if copy.state() == ArtifactVolumeCopyState::Verified {
            continue;
        }
        let blob = copy
            .file
            .as_ref()
            .and_then(|file| file.blob.clone())
            .ok_or_else(|| Status::data_loss("capture copy has no file"))?;
        let volume = copy
            .volume
            .as_ref()
            .ok_or_else(|| Status::data_loss("capture copy has no Volume"))?;
        let content = bytes
            .get(blob.sha256.as_str())
            .copied()
            .ok_or_else(|| Status::data_loss("capture copy names bytes this capture lacks"))?;
        let grant = crate::volume_objects::ObjectGrant {
            volume_id: &volume.volume_id,
            source: &volume.source,
            key: &copy.storage_key,
            blob: &blob,
            presigned: copy.upload.as_ref(),
        };
        crate::volume_objects::put(&grant, content, volumes)
            .await
            .map_err(|status| refused(copy, status.message()))?;
    }
    Ok(())
}
