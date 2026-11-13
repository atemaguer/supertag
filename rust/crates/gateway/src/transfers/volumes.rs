//! Explicit storage-host consent and verified artifact copies.
use super::*;
use std::{
    collections::BTreeMap,
    ffi::CString,
    io::{Read, Seek, Write},
    os::fd::{AsRawFd, FromRawFd},
};
use supertag_protocol::{artifacts::MAX_ARTIFACT_FILE_BYTES, volumes::file_volume_path};
use supertag_workspaces::packages::open_directory;

mod s3;

#[derive(Clone, Default)]
pub struct ArtifactVolumeMappings {
    files: BTreeMap<String, Mapping>,
    objects: BTreeMap<String, s3::S3Mapping>,
}

#[derive(Clone)]
enum Storage {
    File(Mapping),
    S3(s3::S3Mapping),
}
#[derive(Clone)]
struct Mapping {
    source: String,
    root: PathBuf,
    directory: Arc<File>,
}
impl ArtifactVolumeMappings {
    pub fn new(entries: Vec<(String, PathBuf)>) -> Result<Self> {
        let mut mappings = BTreeMap::new();
        for (id, path) in entries {
            ensure!(
                !id.is_empty() && id.len() <= 128 && !mappings.contains_key(&id),
                "invalid or duplicate artifact Volume mapping"
            );
            let metadata = path
                .symlink_metadata()
                .context("open artifact Volume mapping")?;
            ensure!(
                metadata.is_dir() && !metadata.file_type().is_symlink(),
                "artifact Volume mapping must be a directory, not a link"
            );
            // Resolve trusted platform aliases once, before accepting traffic.
            let root = path.canonicalize()?;
            let directory = open_directory(&root)?;
            private_directory(&directory)?;
            let opened = directory.metadata()?;
            ensure!(
                metadata.dev() == opened.dev() && metadata.ino() == opened.ino(),
                "artifact Volume mapping changed during configuration"
            );
            let source = reqwest::Url::from_file_path(&root)
                .map_err(|_| anyhow::anyhow!("invalid artifact Volume path"))?
                .to_string();
            file_volume_path(&source)?;
            for prior in mappings.values() {
                let prior: &Mapping = prior;
                ensure!(
                    !root.starts_with(&prior.root) && !prior.root.starts_with(&root),
                    "artifact Volume mappings overlap"
                );
            }
            mappings.insert(
                id,
                Mapping {
                    source,
                    root,
                    directory: Arc::new(directory),
                },
            );
        }
        Ok(Self {
            files: mappings,
            objects: BTreeMap::new(),
        })
    }

    pub fn with_s3_config(mut self, path: &Path) -> Result<Self> {
        ensure!(
            self.objects.is_empty(),
            "S3 Volume mappings are already configured"
        );
        let objects = s3::load(path)?;
        ensure!(
            objects.keys().all(|id| !self.files.contains_key(id)),
            "duplicate artifact Volume mapping"
        );
        self.objects = objects;
        Ok(self)
    }

    pub(super) fn candidate_ids(&self) -> Vec<String> {
        let mut ids: Vec<_> = self
            .files
            .keys()
            .chain(self.objects.keys())
            .cloned()
            .collect();
        ids.sort_unstable();
        ids
    }

    fn resolve(&self, volume: &ArtifactVolume) -> Result<Storage, Status> {
        if let Some(mapping) = self.files.get(&volume.volume_id)
            && mapping.source == volume.source
        {
            return Ok(Storage::File(mapping.clone()));
        }
        if let Some(mapping) = self.objects.get(&volume.volume_id)
            && mapping.source == volume.source
        {
            return Ok(Storage::S3(mapping.clone()));
        }
        Err(Status::failed_precondition(
            "Gateway has no matching artifact Volume consent",
        ))
    }
}
fn private_directory(file: &File) -> Result<()> {
    let meta = file.metadata()?;
    ensure!(
        meta.is_dir() && meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o077 == 0,
        "artifact Volume directories must be owner-only"
    );
    Ok(())
}
fn current(mapping: &Mapping) -> Result<()> {
    let observed = open_directory(&mapping.root)?;
    private_directory(&observed)?;
    let a = observed.metadata()?;
    let b = mapping.directory.metadata()?;
    ensure!(
        a.dev() == b.dev() && a.ino() == b.ino(),
        "artifact Volume mapping changed"
    );
    Ok(())
}
fn child_directory(parent: &File, name: &str, create: bool) -> Result<File> {
    let name = CString::new(name)?;
    if create {
        let result = unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) };
        if result < 0 && std::io::Error::last_os_error().kind() != ErrorKind::AlreadyExists {
            return Err(std::io::Error::last_os_error().into());
        }
        parent.sync_all()?;
    }
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let file = unsafe { File::from_raw_fd(fd) };
    private_directory(&file)?;
    Ok(file)
}
fn key_parts<'a>(key: &'a str, blob: &BlobReference) -> Result<[&'a str; 4]> {
    let mut parts = key.split('/');
    let (Some("attempts"), Some(attempt), Some("sha256"), Some(hash), None) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        anyhow::bail!("invalid artifact Volume storage key");
    };
    ensure!(
        supertag_protocol::valid_sha256(&blob.sha256)
            && blob.byte_length <= MAX_ARTIFACT_FILE_BYTES
            && hash == blob.sha256
            && !attempt.is_empty()
            && attempt.len() <= 128
            && attempt
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')),
        "invalid artifact Volume storage key"
    );
    Ok(["attempts", attempt, "sha256", hash])
}
fn parent(mapping: &Mapping, key: &str, blob: &BlobReference, create: bool) -> Result<File> {
    let parts = key_parts(key, blob)?;
    let mut directory = mapping.directory.try_clone()?;
    for part in &parts[..3] {
        directory = child_directory(&directory, part, create)?;
    }
    Ok(directory)
}
fn verify_bytes(bytes: &[u8], blob: &BlobReference) -> Result<()> {
    ensure!(
        bytes.len() as u64 == blob.byte_length
            && format!("{:x}", Sha256::digest(bytes)) == blob.sha256,
        "artifact Volume bytes differ from the immutable receipt"
    );
    Ok(())
}
fn verify_at(parent: &File, blob: &BlobReference, mut output: impl Write) -> Result<()> {
    let name = CString::new(blob.sha256.clone())?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let before = file.metadata()?;
    ensure!(
        before.is_file()
            && before.nlink() == 1
            && before.uid() == unsafe { libc::geteuid() }
            && before.mode() & 0o077 == 0
            && before.len() == blob.byte_length,
        "artifact Volume object is not an owned regular file"
    );
    let mut bytes = vec![0; CHECKPOINT_CHUNK_BYTES];
    let mut digest = Sha256::new();
    let mut length = 0u64;
    loop {
        let size = file.read(&mut bytes)?;
        if size == 0 {
            break;
        }
        length += size as u64;
        ensure!(
            length <= blob.byte_length,
            "artifact Volume object exceeds its receipt"
        );
        digest.update(&bytes[..size]);
        output.write_all(&bytes[..size])?;
    }
    ensure!(
        length == blob.byte_length && format!("{:x}", digest.finalize()) == blob.sha256,
        "artifact Volume bytes differ from the immutable receipt"
    );
    let after = file.metadata()?;
    ensure!(
        before.len() == after.len()
            && before.mode() == after.mode()
            && before.mtime() == after.mtime()
            && before.mtime_nsec() == after.mtime_nsec()
            && before.ctime() == after.ctime()
            && before.ctime_nsec() == after.ctime_nsec(),
        "artifact Volume object changed during verification"
    );
    file.sync_all()?;
    parent.sync_all()?;
    Ok(())
}

struct Staged {
    parent: File,
    name: CString,
}
impl Drop for Staged {
    fn drop(&mut self) {
        unsafe { libc::unlinkat(self.parent.as_raw_fd(), self.name.as_ptr(), 0) };
    }
}
fn persist(mapping: Mapping, source: PathBuf, copy: ArtifactVolumeCopy) -> Result<()> {
    let blob = copy
        .file
        .as_ref()
        .and_then(|f| f.blob.as_ref())
        .context("copy has no blob")?;
    current(&mapping)?;
    let destination = parent(&mapping, &copy.storage_key, blob, true)?;
    let final_name = CString::new(blob.sha256.clone())?;
    let exists = unsafe {
        libc::faccessat(
            destination.as_raw_fd(),
            final_name.as_ptr(),
            libc::F_OK,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if exists == 0 {
        verify_at(&destination, blob, std::io::sink())?;
    } else {
        if std::io::Error::last_os_error().kind() != ErrorKind::NotFound {
            return Err(std::io::Error::last_os_error().into());
        }
        // A previously verified receipt never silently repairs a missing copy.
        ensure!(
            copy.state() != ArtifactVolumeCopyState::Verified,
            "verified artifact Volume copy is missing"
        );
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(source.join(&blob.sha256))?;
        let metadata = file.metadata()?;
        ensure!(
            metadata.is_file() && metadata.len() == blob.byte_length,
            "artifact source bytes are unavailable"
        );
        let mut bytes = Vec::new();
        (&mut file)
            .take(blob.byte_length + 1)
            .read_to_end(&mut bytes)?;
        verify_bytes(&bytes, blob)?;
        let staged_parent = destination.try_clone()?;
        let name = CString::new(format!(".copy-{}", uuid::Uuid::new_v4().simple()))?;
        let fd = unsafe {
            libc::openat(
                destination.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let staged = Staged {
            parent: staged_parent,
            name,
        };
        let mut output = unsafe { File::from_raw_fd(fd) };
        output.write_all(&bytes)?;
        output.sync_all()?;
        let result = unsafe {
            libc::linkat(
                destination.as_raw_fd(),
                staged.name.as_ptr(),
                destination.as_raw_fd(),
                final_name.as_ptr(),
                0,
            )
        };
        if result < 0 && std::io::Error::last_os_error().kind() != ErrorKind::AlreadyExists {
            return Err(std::io::Error::last_os_error().into());
        }
        drop(staged);
        destination.sync_all()?;
    }
    // Reopen from the registered root, not only the descriptor used for staging.
    current(&mapping)?;
    let reopened = parent(&mapping, &copy.storage_key, blob, false)?;
    verify_at(&reopened, blob, std::io::sink())?;
    current(&mapping)?;
    Ok(())
}
impl Storage {
    async fn read(
        self,
        scratch: &Path,
        key: &str,
        blob: &BlobReference,
    ) -> Result<tokio::fs::File, Status> {
        match self {
            Self::File(mapping) => {
                let scratch = scratch.to_owned();
                let key = key.to_owned();
                let blob = blob.clone();
                tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
                    current(&mapping)?;
                    let directory = parent(&mapping, &key, &blob, false)?;
                    let mut snapshot = tempfile::tempfile_in(scratch)?;
                    verify_at(&directory, &blob, &mut snapshot)?;
                    current(&mapping)?;
                    snapshot.rewind()?;
                    Ok(tokio::fs::File::from_std(snapshot))
                })
                .await
                .map_err(|_| Status::internal("artifact Volume reader failed"))?
                .map_err(|_| Status::data_loss("artifact Volume copy could not be verified"))
            }
            Self::S3(mapping) => mapping
                .read(scratch, key, blob)
                .await
                .map_err(|_| Status::data_loss("artifact Volume copy could not be verified"))?
                .ok_or_else(|| Status::data_loss("verified artifact Volume copy is missing")),
        }
    }
}

impl GatewayTransfers {
    pub(super) async fn read_volume_location(
        &self,
        location: &ArtifactVolumeLocation,
        blob: &BlobReference,
    ) -> Result<tokio::fs::File, Status> {
        let volume = location
            .volume
            .as_ref()
            .ok_or_else(|| Status::data_loss("copy has no Volume"))?;
        self.volumes
            .resolve(volume)?
            .read(self.directory()?, &location.storage_key, blob)
            .await
    }

    pub fn with_artifact_volumes(mut self, mappings: ArtifactVolumeMappings) -> Result<Self> {
        if !mappings.files.is_empty() || !mappings.objects.is_empty() {
            let directory = self.directory()?.canonicalize()?;
            for mapping in mappings.files.values() {
                ensure!(
                    !mapping.root.starts_with(&directory) && !directory.starts_with(&mapping.root),
                    "artifact Volume must not overlap Gateway state"
                );
            }
        }
        self.volumes = mappings;
        Ok(self)
    }
    pub fn artifact_volumes_service(&self) -> artifact_volumes_server::ArtifactVolumesServer<Self> {
        artifact_volumes_server::ArtifactVolumesServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}
fn client(
    channel: Channel,
) -> artifact_volume_directory_client::ArtifactVolumeDirectoryClient<Channel> {
    artifact_volume_directory_client::ArtifactVolumeDirectoryClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}
#[tonic::async_trait]
impl artifact_volumes_server::ArtifactVolumes for GatewayTransfers {
    type DownloadCopyStream = ReceiverStream<Result<ArtifactDownload, Status>>;
    async fn download_copy(
        &self,
        request: Request<GetArtifactVolumeCopyRequest>,
    ) -> Result<Response<Self::DownloadCopyStream>, Status> {
        let (metadata, _, input) = request.into_parts();
        let mut lookup = Request::new(input.clone());
        *lookup.metadata_mut() = metadata.clone();
        let copy = self.get_copy(lookup).await?.into_inner();
        if copy.state() != ArtifactVolumeCopyState::Verified {
            return Err(Status::failed_precondition(
                "artifact Volume copy is not verified",
            ));
        }
        let volume = copy
            .volume
            .as_ref()
            .ok_or_else(|| Status::data_loss("copy has no Volume"))?;
        let mapping = self.volumes.resolve(volume)?;
        let file = copy
            .file
            .clone()
            .ok_or_else(|| Status::data_loss("copy has no file"))?;
        let blob = file
            .blob
            .clone()
            .filter(|b| {
                supertag_protocol::valid_sha256(&b.sha256)
                    && b.byte_length <= MAX_ARTIFACT_FILE_BYTES
            })
            .ok_or_else(|| Status::data_loss("copy has invalid bytes"))?;
        let permit = self.acquire()?;
        let reader = mapping
            .read(self.directory()?, &copy.storage_key, &blob)
            .await?;
        let gateway = self.clone();
        let authorize = move || {
            let mut request = Request::new(input.clone());
            *request.metadata_mut() = metadata.clone();
            let gateway = gateway.clone();
            let copy = copy.clone();
            async move {
                if gateway.get_copy(request).await?.into_inner() != copy {
                    return Err(Status::data_loss("artifact Volume receipt changed"));
                }
                Ok(())
            }
        };
        authorize().await?;
        Ok(Response::new(download_stream(
            reader,
            permit,
            blob,
            ArtifactDownload {
                part: Some(artifact_download::Part::File(file)),
            },
            |chunk| ArtifactDownload {
                part: Some(artifact_download::Part::Chunk(chunk)),
            },
            authorize,
            Duration::from_secs(60),
        )))
    }
    async fn copy(
        &self,
        request: Request<CopyArtifactToVolumeRequest>,
    ) -> Result<Response<ArtifactVolumeCopy>, Status> {
        let (metadata, _, input) = request.into_parts();
        let mut lookup = Request::new(GetArtifactVolumeRequest {
            volume_id: input.volume_id.clone(),
        });
        *lookup.metadata_mut() = metadata.clone();
        let volume = self.get(lookup).await?.into_inner();
        if volume.revision != input.expected_revision {
            return Err(Status::failed_precondition("Volume revision differs"));
        }
        let mapping = self.volumes.resolve(&volume)?;
        let mut reserve = Request::new(input);
        *reserve.metadata_mut() = metadata.clone();
        let reserved = self
            .gateway
            .forward(
                reserve,
                &self.gateway.credentials.operator,
                |channel, request| async move { client(channel).reserve_copy(request).await },
            )
            .await?
            .into_inner();
        if reserved.volume.as_ref() != Some(&volume) {
            return Err(Status::data_loss("copy reservation has a different Volume"));
        }
        let permit = self.acquire()?;
        let source = self.directory()?.to_path_buf();
        let persisted = match mapping {
            Storage::File(mapping) => {
                let snapshot = reserved.clone();
                tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    persist(mapping, source, snapshot)
                })
                .await
                .map_err(|_| Status::internal("artifact Volume copy worker failed"))?
            }
            Storage::S3(mapping) => {
                let _permit = permit;
                mapping.persist(&source, &reserved).await
            }
        };
        persisted
            .map_err(|_| Status::data_loss("artifact Volume copy could not be durably verified"))?;
        let mut commit = Request::new(CommitArtifactVolumeCopyRequest {
            copy_id: reserved.copy_id,
            verified_blob: reserved.file.and_then(|f| f.blob),
        });
        *commit.metadata_mut() = metadata;
        self.gateway
            .forward(
                commit,
                &self.gateway.credentials.operator,
                |channel, request| async move { client(channel).commit_copy(request).await },
            )
            .await
    }
    async fn put(
        &self,
        request: Request<PutArtifactVolumeRequest>,
    ) -> Result<Response<ArtifactVolume>, Status> {
        self.gateway
            .forward(
                request,
                &self.gateway.credentials.operator,
                |channel, request| async move { client(channel).put(request).await },
            )
            .await
    }
    async fn get(
        &self,
        request: Request<GetArtifactVolumeRequest>,
    ) -> Result<Response<ArtifactVolume>, Status> {
        self.gateway
            .forward(
                request,
                &self.gateway.credentials.operator,
                |channel, request| async move { client(channel).get(request).await },
            )
            .await
    }
    async fn list(
        &self,
        request: Request<ListArtifactVolumesRequest>,
    ) -> Result<Response<ListArtifactVolumesResponse>, Status> {
        self.gateway
            .forward(
                request,
                &self.gateway.credentials.operator,
                |channel, request| async move { client(channel).list(request).await },
            )
            .await
    }
    async fn delete(
        &self,
        request: Request<DeleteArtifactVolumeRequest>,
    ) -> Result<Response<DeleteArtifactVolumeResponse>, Status> {
        self.gateway
            .forward(
                request,
                &self.gateway.credentials.operator,
                |channel, request| async move { client(channel).delete(request).await },
            )
            .await
    }
    async fn get_copy(
        &self,
        request: Request<GetArtifactVolumeCopyRequest>,
    ) -> Result<Response<ArtifactVolumeCopy>, Status> {
        self.gateway
            .forward(
                request,
                &self.gateway.credentials.operator,
                |channel, request| async move { client(channel).get_copy(request).await },
            )
            .await
    }
    async fn list_copies(
        &self,
        request: Request<ListArtifactVolumeCopiesRequest>,
    ) -> Result<Response<ListArtifactVolumeCopiesResponse>, Status> {
        self.gateway
            .forward(
                request,
                &self.gateway.credentials.operator,
                |channel, request| async move { client(channel).list_copies(request).await },
            )
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    fn fixture() -> (tempfile::TempDir, Mapping, PathBuf, ArtifactVolumeCopy) {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let path = root.join("volume");
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let maps = ArtifactVolumeMappings::new(vec![("volume".into(), path)]).unwrap();
        let mapping = maps.files["volume"].clone();
        let source = root.join("cas");
        std::fs::create_dir(&source).unwrap();
        let bytes = b"verified evidence";
        let blob = BlobReference {
            sha256: format!("{:x}", Sha256::digest(bytes)),
            byte_length: bytes.len() as u64,
        };
        std::fs::write(source.join(&blob.sha256), bytes).unwrap();
        let copy = ArtifactVolumeCopy {
            file: Some(ArtifactFile {
                path: "report.txt".into(),
                blob: Some(blob.clone()),
                ..Default::default()
            }),
            storage_key: format!("attempts/producer/sha256/{}", blob.sha256),
            state: ArtifactVolumeCopyState::Reserved as i32,
            ..Default::default()
        };
        (temporary, mapping, source, copy)
    }
    #[test]
    fn copy_reopens_before_receipt_and_reconciles_lost_response_without_source() {
        let (_temporary, mapping, source, mut copy) = fixture();
        persist(mapping.clone(), source.clone(), copy.clone()).unwrap();
        let destination = mapping.root.join(&copy.storage_key);
        let bytes = std::fs::read(&destination).unwrap();
        std::fs::remove_dir_all(&source).unwrap();
        let reopened = ArtifactVolumeMappings::new(vec![("volume".into(), mapping.root.clone())])
            .unwrap()
            .files
            .remove("volume")
            .unwrap();
        persist(reopened.clone(), source.clone(), copy.clone()).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), bytes);
        copy.state = ArtifactVolumeCopyState::Verified as i32;
        persist(reopened.clone(), source.clone(), copy.clone()).unwrap();
        std::fs::write(&destination, b"wrong").unwrap();
        assert!(persist(reopened.clone(), source.clone(), copy.clone()).is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), b"wrong");
        std::fs::remove_file(destination).unwrap();
        assert!(persist(reopened, source, copy).is_err());
    }
    #[test]
    fn links_or_replaced_roots_never_receive_copy_bytes() {
        let (_temporary, mapping, source, copy) = fixture();
        let outside = source.parent().unwrap().join("outside");
        std::fs::create_dir(&outside).unwrap();
        symlink(&outside, mapping.root.join("attempts")).unwrap();
        assert!(persist(mapping.clone(), source.clone(), copy.clone()).is_err());
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
        std::fs::remove_file(mapping.root.join("attempts")).unwrap();
        let moved = mapping.root.with_file_name("moved");
        std::fs::rename(&mapping.root, moved).unwrap();
        std::fs::create_dir(&mapping.root).unwrap();
        std::fs::set_permissions(&mapping.root, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(persist(mapping.clone(), source, copy).is_err());
        assert_eq!(std::fs::read_dir(&mapping.root).unwrap().count(), 0);
    }
    #[test]
    fn corrupt_source_and_overlapping_or_unprivate_mappings_are_refused() {
        let (_temporary, mapping, source, copy) = fixture();
        let blob = copy.file.as_ref().unwrap().blob.as_ref().unwrap();
        std::fs::write(source.join(&blob.sha256), b"wrong").unwrap();
        assert!(persist(mapping.clone(), source, copy.clone()).is_err());
        assert!(!mapping.root.join(&copy.storage_key).exists());
        assert!(
            ArtifactVolumeMappings::new(vec![
                ("a".into(), mapping.root.clone()),
                ("b".into(), mapping.root.clone())
            ])
            .is_err()
        );
        std::fs::set_permissions(&mapping.root, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(ArtifactVolumeMappings::new(vec![("a".into(), mapping.root)]).is_err());
    }
}
