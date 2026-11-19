//! One object on a Tag's Volume, moved by this host. The Control Plane names the object and, for an
//! S3 Volume, presigns the request; a file Volume is reached through this host's own mapping. No
//! Volume byte passes through the Control Plane.
//!
//! Captures get their grants from `AttemptArtifacts.ReserveCapture` (see `capture_volumes`); other
//! objects, such as a Session's checkpoint or an acquired file, from `VolumeObjects.Grant`. A host
//! that maps a file Volume also deletes the objects on it that nothing keeps any more.
use std::{collections::BTreeMap, sync::Arc, time::Duration};

use sha2::{Digest, Sha256};
use supertag_protocol::{
    authenticated_request,
    v2::{
        ArtifactVolumeUpload, BlobReference, ForgetVolumeGarbageRequest, InspectAttemptRequest,
        ListVolumeGarbageRequest, VolumeAccess, VolumeObjectGrant, VolumeObjectGrantRequest,
        VolumeObjectPurpose, volume_objects_client::VolumeObjectsClient,
    },
};
use supertag_workspaces::artifact_volumes::FileVolume;
use tonic::{Status, service::interceptor::InterceptedService, transport::Channel};

/// The file Volumes this host maps, by Volume ID.
pub type HostVolumes = Arc<BTreeMap<String, FileVolume>>;

/// The Control Plane's Volume object grants, as this host. In the Worklet it signs with the host
/// credential; a Worker asks its Worklet for its own Attempt's objects through it.
#[derive(Clone)]
pub(crate) struct VolumeObjects {
    client: VolumeObjectsClient<InterceptedService<Channel, crate::HostHeaders>>,
    credential: crate::worklet::HostSigner,
}

impl VolumeObjects {
    pub(crate) fn new(
        client: VolumeObjectsClient<InterceptedService<Channel, crate::HostHeaders>>,
        credential: crate::worklet::HostSigner,
    ) -> Self {
        Self { client, credential }
    }

    /// The grant for one object of a live Attempt of this host, which `request` names by its
    /// lease.
    pub(crate) async fn grant(
        &self,
        request: VolumeObjectGrantRequest,
    ) -> Result<VolumeObjectGrant, Status> {
        match &self.credential {
            crate::worklet::HostSigner::Host(token) => {
                let request = authenticated_request(request, token.secret(), None)?;
                Ok(self.client.clone().grant(request).await?.into_inner())
            }
            crate::worklet::HostSigner::Worklet(link) => {
                link.host_call(
                    crate::local::HostCall::VolumeGrant(crate::local::Proto(request)),
                    crate::local::Answer::of(),
                )
                .await
            }
        }
    }
}

/// How often a host deletes its file Volumes' garbage.
pub(crate) const GARBAGE_INTERVAL: Duration = Duration::from_secs(10 * 60);
/// Objects per listed page, and pages per Volume in one pass.
const GARBAGE_PAGE: u32 = 200;
const GARBAGE_PAGES: usize = 50;

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
                .map_err(|_| refused(grant, "this Worklet could not write it"))
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

/// An acquired file from its producer's verified Volume copy: through a presigned GET for an S3
/// Volume, or this host's own mapping of a file Volume. `None` when there is no such copy, this
/// host cannot reach it, or the bytes there differ, so the caller falls back.
pub(crate) async fn acquired(
    objects: &VolumeObjects,
    attempt: &InspectAttemptRequest,
    (acquisition_id, path): (&str, &str),
    volumes: &HostVolumes,
) -> Option<Vec<u8>> {
    let grant = objects
        .grant(VolumeObjectGrantRequest {
            attempt: Some(attempt.clone()),
            purpose: VolumeObjectPurpose::AcquiredFile as i32,
            access: VolumeAccess::Read as i32,
            acquisition_id: acquisition_id.to_owned(),
            path: path.to_owned(),
            native_memory_blob: None,
        })
        .await
        .ok()?;
    let volume = grant.volume.as_ref()?;
    let blob = grant.blob.as_ref()?;
    let object = ObjectGrant {
        volume_id: &volume.volume_id,
        source: &volume.source,
        key: &grant.key,
        blob,
        presigned: grant.presigned.as_ref(),
    };
    get(&object, volumes).await.ok().flatten()
}

/// Deletes the objects nothing keeps from every file Volume this host maps, then tells the
/// Control Plane which went. Returns how many.
pub(crate) async fn collect_garbage(
    objects: &VolumeObjects,
    volumes: &HostVolumes,
) -> Result<usize, Status> {
    let (client, token) = (&objects.client, objects.credential.host()?.secret());
    let mut deleted = 0;
    for (volume_id, mapping) in volumes.iter() {
        for _ in 0..GARBAGE_PAGES {
            let listed = client
                .clone()
                .list_garbage(authenticated_request(
                    ListVolumeGarbageRequest {
                        volume_id: volume_id.clone(),
                        source: mapping.source.clone(),
                        limit: GARBAGE_PAGE,
                    },
                    token,
                    None,
                )?)
                .await?
                .into_inner()
                .objects;
            if listed.is_empty() {
                break;
            }
            let full = listed.len() as u32 == GARBAGE_PAGE;
            let mapping = mapping.clone();
            let gone = tokio::task::spawn_blocking(move || {
                listed
                    .into_iter()
                    .filter(|object| {
                        object
                            .blob
                            .as_ref()
                            .is_some_and(|blob| mapping.remove(&object.key, blob).is_ok())
                    })
                    .collect::<Vec<_>>()
            })
            .await
            .map_err(|_| Status::internal("Volume garbage deletion stopped"))?;
            if gone.is_empty() {
                break;
            }
            deleted += gone.len();
            client
                .clone()
                .forget_garbage(authenticated_request(
                    ForgetVolumeGarbageRequest {
                        volume_id: volume_id.clone(),
                        source: volumes[volume_id].source.clone(),
                        objects: gone,
                    },
                    token,
                    None,
                )?)
                .await?;
            if !full {
                break;
            }
        }
    }
    Ok(deleted)
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

    /// Lists one page of garbage, then nothing, and records what the host forgot.
    struct FakeGarbage {
        granted: Option<supertag_protocol::v2::VolumeObjectGrant>,
        listed: std::sync::Mutex<Vec<supertag_protocol::v2::VolumeGarbageObject>>,
        forgotten: tokio::sync::mpsc::UnboundedSender<ForgetVolumeGarbageRequest>,
    }

    #[tonic::async_trait]
    impl supertag_protocol::v2::volume_objects_server::VolumeObjects for FakeGarbage {
        async fn grant(
            &self,
            request: tonic::Request<VolumeObjectGrantRequest>,
        ) -> Result<tonic::Response<supertag_protocol::v2::VolumeObjectGrant>, Status> {
            let request = request.into_inner();
            assert_eq!(request.purpose(), VolumeObjectPurpose::AcquiredFile);
            assert_eq!(request.access(), VolumeAccess::Read);
            self.granted
                .clone()
                .map(tonic::Response::new)
                .ok_or_else(|| Status::not_found("no Volume copy"))
        }
        async fn list_garbage(
            &self,
            request: tonic::Request<ListVolumeGarbageRequest>,
        ) -> Result<tonic::Response<supertag_protocol::v2::ListVolumeGarbageResponse>, Status>
        {
            assert_eq!(request.get_ref().volume_id, "vault");
            Ok(tonic::Response::new(
                supertag_protocol::v2::ListVolumeGarbageResponse {
                    objects: std::mem::take(&mut *self.listed.lock().unwrap()),
                },
            ))
        }
        async fn forget_garbage(
            &self,
            request: tonic::Request<ForgetVolumeGarbageRequest>,
        ) -> Result<tonic::Response<supertag_protocol::v2::ForgetVolumeGarbageResponse>, Status>
        {
            let _ = self.forgotten.send(request.into_inner());
            Ok(tonic::Response::new(
                supertag_protocol::v2::ForgetVolumeGarbageResponse {},
            ))
        }
    }

    #[tokio::test]
    async fn an_acquired_file_is_read_from_a_mapped_volume_copy_or_left_to_the_fallback() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().canonicalize().unwrap().join("volume");
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mapping = FileVolume::open(&path).unwrap();
        let bytes = b"captured report";
        let blob = BlobReference {
            sha256: format!("{:x}", Sha256::digest(bytes)),
            byte_length: bytes.len() as u64,
        };
        let key = format!(
            "tags/{}/attempts/producer/sha256/{}",
            "a".repeat(64),
            blob.sha256
        );
        mapping.persist(&key, &blob, Some(bytes), true).unwrap();
        let grant = supertag_protocol::v2::VolumeObjectGrant {
            volume: Some(supertag_protocol::v2::ArtifactVolume {
                volume_id: "vault".into(),
                source: mapping.source.clone(),
                revision: 1,
            }),
            key,
            blob: Some(blob),
            presigned: None,
        };
        let volumes: HostVolumes = Arc::new(BTreeMap::from([("vault".to_owned(), mapping)]));
        let attempt = InspectAttemptRequest::default();
        for (granted, expected) in [
            (Some(grant), Some(bytes.to_vec())),
            // No copy, or a copy this host does not map: the caller falls back.
            (None, None),
        ] {
            let (forgotten, _) = tokio::sync::mpsc::unbounded_channel();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            tokio::spawn(
                tonic::transport::Server::builder()
                    .add_service(
                        supertag_protocol::v2::volume_objects_server::VolumeObjectsServer::new(
                            FakeGarbage {
                                granted,
                                listed: Default::default(),
                                forgotten,
                            },
                        ),
                    )
                    .serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(listener)),
            );
            let channel = tonic::transport::Endpoint::from_shared(format!("http://{address}"))
                .unwrap()
                .connect()
                .await
                .unwrap();
            let client =
                VolumeObjectsClient::with_interceptor(channel, crate::HostHeaders::new(1, 2));
            let credential =
                crate::worklet::HostSigner::Host(crate::worklet::HostToken::new("token".into()));
            let read = acquired(
                &VolumeObjects::new(client, credential.clone()),
                &attempt,
                ("acquisition", "report.txt"),
                &volumes,
            )
            .await;
            assert_eq!(read, expected);
            assert_eq!(
                acquired(
                    &VolumeObjects::new(
                        VolumeObjectsClient::with_interceptor(
                            tonic::transport::Endpoint::from_shared(format!("http://{address}"))
                                .unwrap()
                                .connect()
                                .await
                                .unwrap(),
                            crate::HostHeaders::new(1, 2),
                        ),
                        credential,
                    ),
                    &attempt,
                    ("acquisition", "report.txt"),
                    &HostVolumes::default(),
                )
                .await,
                None,
                "a host without the mapping falls back"
            );
        }
    }

    #[tokio::test]
    async fn a_host_deletes_listed_garbage_from_its_file_volume_and_forgets_it() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().canonicalize().unwrap().join("volume");
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mapping = FileVolume::open(&path).unwrap();
        let source = mapping.source.clone();
        let bytes = b"dropped checkpoint";
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
        mapping.persist(&key, &blob, Some(bytes), true).unwrap();
        let volumes: HostVolumes = Arc::new(BTreeMap::from([("vault".to_owned(), mapping)]));
        let object = supertag_protocol::v2::VolumeGarbageObject {
            key: key.clone(),
            blob: Some(blob),
            queued_at_ms: 7,
        };
        let (forgotten, mut seen) = tokio::sync::mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(
            tonic::transport::Server::builder()
                .add_service(
                    supertag_protocol::v2::volume_objects_server::VolumeObjectsServer::new(
                        FakeGarbage {
                            granted: None,
                            listed: std::sync::Mutex::new(vec![object.clone()]),
                            forgotten,
                        },
                    ),
                )
                .serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(listener)),
        );
        let channel = tonic::transport::Endpoint::from_shared(format!("http://{address}"))
            .unwrap()
            .connect()
            .await
            .unwrap();
        let client = VolumeObjectsClient::with_interceptor(channel, crate::HostHeaders::new(1, 2));
        let objects = VolumeObjects::new(
            client,
            crate::worklet::HostSigner::Host(crate::worklet::HostToken::new("token".into())),
        );
        assert_eq!(collect_garbage(&objects, &volumes).await.unwrap(), 1);
        assert!(!path.join(&key).exists());
        let forget = seen.recv().await.unwrap();
        assert_eq!(
            (
                forget.volume_id.as_str(),
                forget.source.as_str(),
                forget.objects
            ),
            ("vault", source.as_str(), vec![object])
        );
    }
}
