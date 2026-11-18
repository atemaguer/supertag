//! One object on a Tag's Volume, moved by this host. The Control Plane names the object and, for an
//! S3 Volume, presigns the request; a file Volume is reached through this host's own mapping. No
//! Volume byte passes through the Control Plane.
//!
//! Captures get their grants from `AttemptArtifacts.ReserveCapture` (see `capture_volumes`); other
//! objects, such as a Session's checkpoint, from `VolumeObjects.Grant`.
use std::{collections::BTreeMap, sync::Arc, time::Duration};

use sha2::{Digest, Sha256};
use supertag_protocol::v2::{ArtifactVolumeUpload, BlobReference};
use supertag_workspaces::artifact_volumes::FileVolume;
use tonic::Status;

/// The file Volumes this host maps, by Volume ID.
pub type HostVolumes = Arc<BTreeMap<String, FileVolume>>;

const TRANSFER_TIMEOUT: Duration = Duration::from_secs(120);

/// Where one object lives and how this host reaches it.
pub(crate) struct ObjectGrant<'a> {
    pub volume_id: &'a str,
    pub source: &'a str,
    pub key: &'a str,
    pub blob: &'a BlobReference,
    /// An S3 Volume's presigned request; `None` for a file Volume.
    pub presigned: Option<&'a ArtifactVolumeUpload>,
}

fn refused(grant: &ObjectGrant, reason: &str) -> Status {
    Status::failed_precondition(format!(
        "Volume {} object failed: {reason}",
        grant.volume_id
    ))
}

fn client(grant: &ObjectGrant) -> Result<reqwest::Client, Status> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TRANSFER_TIMEOUT)
        .build()
        .map_err(|_| refused(grant, "no HTTP client"))
}

/// The host's mapping of a file Volume, when it maps that exact source.
fn mapping(grant: &ObjectGrant, volumes: &HostVolumes) -> Result<FileVolume, Status> {
    volumes
        .get(grant.volume_id)
        .filter(|mapping| mapping.source == grant.source)
        .cloned()
        .ok_or_else(|| refused(grant, "this Worker Host does not map the Volume"))
}

/// Writes exactly `bytes`, which must be the grant's blob. For a file Volume the write reopens and
/// verifies the object before it returns: that verification is this host's attestation.
pub(crate) async fn put(
    grant: &ObjectGrant<'_>,
    bytes: &[u8],
    volumes: &HostVolumes,
) -> Result<(), Status> {
    if bytes.len() as u64 != grant.blob.byte_length
        || format!("{:x}", Sha256::digest(bytes)) != grant.blob.sha256
    {
        return Err(Status::data_loss(
            "Volume object bytes differ from their grant",
        ));
    }
    match grant.presigned {
        Some(upload) => {
            let mut request = client(grant)?.put(&upload.url).body(bytes.to_vec());
            for header in &upload.headers {
                request = request.header(&header.name, &header.value);
            }
            let response = request
                .send()
                .await
                .map_err(|_| refused(grant, "the upload did not reach the Volume"))?;
            // 412: the exact key already exists, as from an earlier try. Its length and checksum
            // are checked before anything records it.
            if response.status().is_success()
                || response.status() == reqwest::StatusCode::PRECONDITION_FAILED
            {
                Ok(())
            } else {
                Err(refused(grant, "the Volume refused the upload"))
            }
        }
        None => {
            let mapping = mapping(grant, volumes)?;
            let (key, blob, content) = (grant.key.to_owned(), grant.blob.clone(), bytes.to_vec());
            tokio::task::spawn_blocking(move || mapping.persist(&key, &blob, Some(&content), true))
                .await
                .map_err(|_| Status::internal("Volume write failed"))?
                .map_err(|_| refused(grant, "this Worker Host could not write it"))
        }
    }
}

/// Reads the object and verifies its length and SHA-256. `None` when it is missing or holds other
/// bytes, which a reader treats alike.
pub(crate) async fn get(
    grant: &ObjectGrant<'_>,
    volumes: &HostVolumes,
) -> Result<Option<Vec<u8>>, Status> {
    let bytes = match grant.presigned {
        Some(download) => {
            let response = client(grant)?
                .get(&download.url)
                .send()
                .await
                .map_err(|_| refused(grant, "the download did not reach the Volume"))?;
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                return Ok(None);
            }
            if !response.status().is_success()
                || response
                    .content_length()
                    .is_some_and(|length| length != grant.blob.byte_length)
            {
                return Ok(None);
            }
            response
                .bytes()
                .await
                .map_err(|_| refused(grant, "the download failed"))?
                .to_vec()
        }
        None => {
            let mapping = mapping(grant, volumes)?;
            let (key, blob) = (grant.key.to_owned(), grant.blob.clone());
            match tokio::task::spawn_blocking(move || {
                let mut bytes = Vec::new();
                mapping
                    .read_verified(&key, &blob, &mut bytes)
                    .map(|()| bytes)
            })
            .await
            .map_err(|_| Status::internal("Volume read failed"))?
            {
                Ok(bytes) => bytes,
                Err(_) => return Ok(None),
            }
        }
    };
    Ok((bytes.len() as u64 == grant.blob.byte_length
        && format!("{:x}", Sha256::digest(&bytes)) == grant.blob.sha256)
        .then_some(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    async fn a_mapped_file_volume_is_written_attested_and_read_back() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().canonicalize().unwrap().join("volume");
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mapping = FileVolume::open(&path).unwrap();
        let source = mapping.source.clone();
        let volumes: HostVolumes = Arc::new(BTreeMap::from([("vault".to_owned(), mapping)]));
        let bytes = b"checkpoint bytes";
        let blob = BlobReference {
            sha256: format!("{:x}", Sha256::digest(bytes)),
            byte_length: bytes.len() as u64,
        };
        let key = format!(
            "tags/{}/sessions/{}/checkpoint/{}.bin",
            "a".repeat(64),
            "b".repeat(64),
            blob.sha256
        );
        let grant = ObjectGrant {
            volume_id: "vault",
            source: &source,
            key: &key,
            blob: &blob,
            presigned: None,
        };
        assert_eq!(get(&grant, &volumes).await.unwrap(), None);
        // Bytes that are not the grant's blob are refused before anything is written.
        assert!(put(&grant, b"other bytes", &volumes).await.is_err());
        put(&grant, bytes, &volumes).await.unwrap();
        assert_eq!(
            get(&grant, &volumes).await.unwrap().as_deref(),
            Some(&bytes[..])
        );
        // A host that does not map the exact source refuses.
        let elsewhere = ObjectGrant {
            source: "file:///elsewhere",
            ..grant
        };
        assert!(put(&elsewhere, bytes, &volumes).await.is_err());
    }
}
