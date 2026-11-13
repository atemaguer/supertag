//! Opt-in storage and peer transport for exact artifact reads.
use std::{
    collections::BTreeMap,
    fs::{self, DirBuilder, File, OpenOptions},
    io::{Read, Write},
    net::{IpAddr, SocketAddr},
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use supertag_protocol::{
    CHECKPOINT_CHUNK_BYTES, MAX_MESSAGE_BYTES,
    artifacts::MAX_ARTIFACT_FILE_BYTES,
    authenticated_request,
    v2::{
        artifact_download::Part,
        attempt_artifacts_client::AttemptArtifactsClient,
        worker_artifact_transfers_client::WorkerArtifactTransfersClient,
        worker_artifact_transfers_server::{
            WorkerArtifactTransfers, WorkerArtifactTransfersServer,
        },
        *,
    },
    valid_sha256,
};
use tokio::{
    net::TcpListener,
    sync::{Semaphore, mpsc},
    time::{Instant, timeout_at},
};
use tokio_stream::wrappers::{ReceiverStream, TcpListenerStream};
use tokio_util::sync::CancellationToken;
use tonic::{
    Request, Response, Status,
    service::interceptor::InterceptedService,
    transport::{
        Certificate, Channel, ClientTlsConfig, Endpoint, Identity, Server, ServerTlsConfig,
    },
};
use uuid::Uuid;

use crate::HostHeaders;

const GRANT_BUDGET: Duration = Duration::from_secs(10);
const AUTHORIZATION_BUDGET: Duration = Duration::from_secs(4);

type Authority = AttemptArtifactsClient<InterceptedService<Channel, HostHeaders>>;

#[derive(Clone, Default)]
pub struct ArtifactPeers(BTreeMap<String, Endpoint>);

impl ArtifactPeers {
    pub fn configure(peers: Vec<String>, ca: Option<Vec<u8>>) -> Result<Self> {
        ensure!(
            peers.len() <= 64 && (ca.is_none() || !peers.is_empty()),
            "invalid artifact peer configuration"
        );
        let mut mapped = BTreeMap::new();
        for entry in peers {
            let (id, origin) = entry
                .split_once('=')
                .context("artifact peer requires HOST_ID=ORIGIN")?;
            ensure!(
                !id.is_empty()
                    && id.len() <= 250
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
                    && !mapped.contains_key(id),
                "invalid or duplicate artifact peer ID"
            );
            let url = reqwest::Url::parse(origin)
                .map_err(|_| anyhow::anyhow!("invalid artifact peer origin"))?;
            let loopback = url.host_str().is_some_and(|host| {
                host.trim_matches(['[', ']'])
                    .parse::<IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
            });
            ensure!(
                (url.scheme() == "https" || url.scheme() == "http" && loopback)
                    && url.host().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.path() == "/"
                    && url.query().is_none()
                    && url.fragment().is_none()
                    && (url.as_str() == origin || url.as_str().strip_suffix('/') == Some(origin)),
                "artifact peer must be a canonical HTTPS origin or literal loopback HTTP"
            );
            let mut endpoint = Endpoint::from_shared(url.to_string())?
                .connect_timeout(Duration::from_secs(3))
                .timeout(GRANT_BUDGET);
            if url.scheme() == "https" {
                let tls = match &ca {
                    Some(pem) => ClientTlsConfig::new().ca_certificate(Certificate::from_pem(pem)),
                    None => ClientTlsConfig::new().with_native_roots(),
                };
                endpoint = endpoint.tls_config(tls)?;
            }
            mapped.insert(id.to_owned(), endpoint);
        }
        Ok(Self(mapped))
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub(crate) fn peer(&self, id: &str) -> Result<WorkerArtifactTransfersClient<Channel>, Status> {
        let endpoint = self.0.get(id).ok_or_else(|| {
            Status::failed_precondition("producing Worker Host has no configured artifact peer")
        })?;
        Ok(WorkerArtifactTransfersClient::new(endpoint.connect_lazy())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES))
    }
}

pub struct ArtifactSourceConfig {
    pub listen: SocketAddr,
    pub directory: PathBuf,
    pub tls: Option<Identity>,
}

impl ArtifactSourceConfig {
    pub(crate) async fn bind(self, state: &Path, workspaces: &[&Path]) -> Result<BoundSource> {
        ensure!(
            self.listen.ip().is_loopback() || self.tls.is_some(),
            "remote artifact listener requires TLS"
        );
        let directory = self.directory.clone();
        let state = state.canonicalize()?;
        let workspaces = workspaces
            .iter()
            .map(|path| path.canonicalize())
            .collect::<std::io::Result<Vec<_>>>()?;
        let storage = tokio::task::spawn_blocking(move || {
            ensure!(
                directory.is_absolute(),
                "artifact source directory must be absolute"
            );
            private_directory(&directory)?;
            let root = directory.canonicalize()?;
            ensure!(
                !state.starts_with(&root)
                    && !root.starts_with(&state)
                    && workspaces
                        .iter()
                        .all(|path| !root.starts_with(path) && !path.starts_with(&root)),
                "artifact source directory overlaps Worker Host state or the source Workspace"
            );
            SourceStorage::open(&root)
        })
        .await??;
        let mut server = Server::builder();
        if let Some(identity) = self.tls {
            server = server.tls_config(ServerTlsConfig::new().identity(identity))?;
        }
        let listener = TcpListener::bind(self.listen)
            .await
            .context("bind artifact peer listener")?;
        Ok(BoundSource {
            server,
            listener,
            storage,
        })
    }
}

pub(crate) struct BoundSource {
    server: Server,
    listener: TcpListener,
    storage: SourceStorage,
}

impl BoundSource {
    pub(crate) async fn serve(
        mut self,
        mut authority: Authority,
        token: &str,
        shutdown: &CancellationToken,
    ) -> Result<Serving> {
        let mut request = authenticated_request(
            RegisterArtifactSourceRequest {
                storage_id: self.storage.id.clone(),
            },
            token,
            None,
        )?;
        request.set_timeout(AUTHORIZATION_BUDGET);
        let receipt = authority
            .register_artifact_source(request)
            .await?
            .into_inner();
        ensure!(
            receipt.storage_id == self.storage.id,
            "artifact source registration changed"
        );
        let source = SourceServer {
            authority,
            host_token: token.to_owned(),
            storage: self.storage.clone(),
            capacity: Arc::new(Semaphore::new(8)),
        };
        let stop = shutdown.child_token();
        let stopped = stop.clone();
        let task = tokio::spawn(
            self.server
                .add_service(
                    WorkerArtifactTransfersServer::new(source)
                        .max_decoding_message_size(16 * 1024)
                        .max_encoding_message_size(MAX_MESSAGE_BYTES),
                )
                .serve_with_incoming_shutdown(TcpListenerStream::new(self.listener), async move {
                    stopped.cancelled().await;
                }),
        );
        Ok(Serving {
            storage: self.storage,
            stop,
            task,
        })
    }
}

pub(crate) struct Serving {
    pub(crate) storage: SourceStorage,
    stop: CancellationToken,
    task: tokio::task::JoinHandle<Result<(), tonic::transport::Error>>,
}
impl Drop for Serving {
    fn drop(&mut self) {
        self.stop.cancel();
        self.task.abort();
    }
}

#[derive(Clone)]
pub(crate) struct SourceStorage {
    root: PathBuf,
    id: String,
    directory: Arc<File>,
}

impl SourceStorage {
    fn open(path: &Path) -> Result<Self> {
        ensure!(
            path.is_absolute(),
            "artifact source directory must be absolute"
        );
        // The operator selects a dedicated directory. Never follow a final link.
        private_directory(path)?;
        let root = path.canonicalize()?;
        let directory = supertag_workspaces::packages::open_directory(&root)?;
        check_directory(&directory.metadata()?)?;
        // One serving process owns the configured storage directory.
        ensure!(
            unsafe { libc::flock(directory.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
            "artifact source directory is already in use"
        );
        let identity = root.join("storage-id");
        let id = match open_private(&identity)? {
            Some(file) => read_id(file)?,
            None => {
                let proposed = Uuid::new_v4().to_string();
                let mut staged = tempfile::NamedTempFile::new_in(&root)?;
                staged.write_all(proposed.as_bytes())?;
                staged.as_file().sync_all()?;
                match staged.persist_noclobber(&identity) {
                    Ok(_) => proposed,
                    Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                        read_id(
                            open_private(&identity)?
                                .context("artifact storage identity vanished")?,
                        )?
                    }
                    Err(error) => return Err(error.error.into()),
                }
            }
        };
        directory.sync_all()?;
        Ok(Self {
            root,
            id,
            directory: Arc::new(directory),
        })
    }

    fn current(&self) -> Result<()> {
        let opened = supertag_workspaces::packages::open_directory(&self.root)?;
        let metadata = opened.metadata()?;
        check_directory(&metadata)?;
        let expected = self.directory.metadata()?;
        ensure!(
            metadata.dev() == expected.dev()
                && metadata.ino() == expected.ino()
                && read_id(
                    open_private(&self.root.join("storage-id"))?
                        .context("artifact storage identity is missing")?
                )? == self.id,
            "artifact source storage changed"
        );
        Ok(())
    }

    pub(crate) fn has_id(&self, id: &str) -> bool {
        self.id == id
    }

    pub(crate) fn retain(
        &self,
        manifest: &mut CommitArtifactCaptureRequest,
        selected: &[Vec<u8>],
    ) -> Result<(), Status> {
        self.persist(manifest, selected)
            .map_err(|_| Status::data_loss("could not retain exact Worker Host artifact copy"))?;
        manifest.source_storage_id = Some(self.id.clone());
        Ok(())
    }

    fn persist(&self, manifest: &CommitArtifactCaptureRequest, selected: &[Vec<u8>]) -> Result<()> {
        self.current()?;
        let attempt = &manifest
            .attempt
            .as_ref()
            .context("artifact Attempt is missing")?
            .attempt_id;
        let parent = self.root.join(attempt_dir(attempt));
        private_directory(&parent)?;
        self.directory.sync_all()?;
        ensure!(
            manifest.files.len() == selected.len(),
            "artifact selection changed"
        );
        for (entry, content) in manifest.files.iter().zip(selected) {
            let blob = entry.blob.as_ref().context("artifact blob missing")?;
            let path = blob_path(&parent, blob)?;
            ensure!(
                content.len() as u64 == blob.byte_length && digest(content) == blob.sha256,
                "retained artifact bytes differ from the receipt"
            );
            if let Some(file) = open_private(&path)? {
                verify(file, blob)?;
                continue;
            }
            let mut staged = tempfile::NamedTempFile::new_in(&parent)?;
            staged.write_all(content)?;
            staged.as_file().sync_all()?;
            match staged.persist_noclobber(&path) {
                Ok(_) => {}
                Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.error.into()),
            }
            verify(
                open_private(&path)?.context("retained artifact vanished")?,
                blob,
            )?;
        }
        supertag_workspaces::packages::open_directory(&parent)?.sync_all()?;
        self.current()
    }

    fn read(&self, attempt: &str, blob: &BlobReference) -> Result<Vec<u8>> {
        self.current()?;
        let parent = self.root.join(attempt_dir(attempt));
        check_directory(&parent.symlink_metadata()?)?;
        let bytes = verify(
            open_private(&blob_path(&parent, blob)?)?.context("retained artifact is missing")?,
            blob,
        )?;
        self.current()?;
        Ok(bytes)
    }
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn attempt_dir(attempt: &str) -> String {
    format!("attempt-{}", digest(attempt.as_bytes()))
}

fn blob_path(parent: &Path, blob: &BlobReference) -> Result<PathBuf> {
    ensure!(
        valid_sha256(&blob.sha256) && blob.byte_length <= MAX_ARTIFACT_FILE_BYTES,
        "invalid artifact byte reference"
    );
    Ok(parent.join(&blob.sha256))
}

fn private_directory(path: &Path) -> Result<()> {
    match DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    check_directory(&path.symlink_metadata()?)
}

fn check_directory(metadata: &fs::Metadata) -> Result<()> {
    ensure!(
        metadata.is_dir()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o077 == 0,
        "artifact source directory must be owner-only"
    );
    Ok(())
}

fn open_private(path: &Path) -> Result<Option<File>> {
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o077 == 0
            && metadata.nlink() == 1,
        "artifact source entry is not a private regular file"
    );
    Ok(Some(file))
}

fn read_id(file: File) -> Result<String> {
    let mut id = String::new();
    file.take(37).read_to_string(&mut id)?;
    ensure!(
        Uuid::parse_str(&id)
            .is_ok_and(|uuid| uuid.get_version_num() == 4 && uuid.to_string() == id),
        "artifact source storage identity is invalid"
    );
    Ok(id)
}

fn verify(file: File, blob: &BlobReference) -> Result<Vec<u8>> {
    ensure!(
        file.metadata()?.len() == blob.byte_length,
        "retained artifact length differs"
    );
    let mut bytes = Vec::with_capacity(blob.byte_length as usize);
    file.take(blob.byte_length + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 == blob.byte_length && digest(&bytes) == blob.sha256,
        "retained artifact bytes differ from the receipt"
    );
    Ok(bytes)
}

#[derive(Clone)]
struct SourceServer {
    authority: Authority,
    host_token: String,
    storage: SourceStorage,
    capacity: Arc<Semaphore>,
}

impl SourceServer {
    async fn authorize(
        &self,
        request: AuthorizeArtifactTransferRequest,
    ) -> Result<(AuthorizedArtifactTransfer, Instant), Status> {
        let sent = Instant::now();
        let mut request = authenticated_request(request, &self.host_token, None)?;
        request.set_timeout(AUTHORIZATION_BUDGET);
        let response = self
            .authority
            .clone()
            .authorize_artifact_transfer(request)
            .await
            .map_err(|_| Status::permission_denied("direct artifact read is not authorized"))?
            .into_inner();
        let budget = Duration::from_millis(response.valid_for_ms);
        let deadline = sent + budget.min(GRANT_BUDGET);
        if budget > GRANT_BUDGET || deadline <= Instant::now() {
            return Err(Status::permission_denied("direct artifact grant expired"));
        }
        Ok((response, deadline))
    }
}

#[tonic::async_trait]
impl WorkerArtifactTransfers for SourceServer {
    type DownloadStream = ReceiverStream<Result<ArtifactDownload, Status>>;

    async fn download(
        &self,
        request: Request<WorkerArtifactDownloadRequest>,
    ) -> Result<Response<Self::DownloadStream>, Status> {
        let mut headers = request.metadata().get_all("authorization").iter();
        let token = headers
            .next()
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|token| valid_sha256(token) && headers.next().is_none())
            .ok_or_else(|| Status::unauthenticated("artifact transfer grant is required"))?
            .to_owned();
        let file = request.into_inner();
        let blob = file
            .blob
            .clone()
            .filter(|blob| {
                valid_sha256(&blob.sha256) && blob.byte_length <= MAX_ARTIFACT_FILE_BYTES
            })
            .ok_or_else(|| Status::invalid_argument("invalid artifact byte reference"))?;
        let scope = AuthorizeArtifactTransferRequest {
            token,
            file: Some(file),
        };
        let permit = self
            .capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| Status::resource_exhausted("too many direct artifact reads"))?;
        let (authorized, deadline) = self.authorize(scope.clone()).await?;
        let storage = self.storage.clone();
        let producer = authorized.producer_attempt_id.clone();
        let bytes = timeout_at(
            deadline,
            tokio::task::spawn_blocking(move || storage.read(&producer, &blob)),
        )
        .await
        .map_err(|_| Status::deadline_exceeded("direct artifact grant expired"))?
        .map_err(|_| Status::internal("direct artifact read failed"))?
        .map_err(|_| Status::data_loss("producer has no exact verified artifact bytes"))?;
        // A slow local read must not hide a withdrawal or generation takeover.
        let (fresh, fresh_deadline) = self.authorize(scope.clone()).await?;
        if fresh.file != authorized.file
            || fresh.producer_attempt_id != authorized.producer_attempt_id
        {
            return Err(Status::permission_denied(
                "direct artifact authority changed",
            ));
        }
        let deadline = deadline.min(fresh_deadline);
        if Instant::now() >= deadline {
            return Err(Status::permission_denied("direct artifact grant expired"));
        }
        let source = self.clone();
        let (send, receive) = mpsc::channel(2);
        tokio::spawn(async move {
            let _permit = permit;
            let delivery = async {
                if send
                    .send(Ok(ArtifactDownload {
                        part: authorized.file.clone().map(Part::File),
                    }))
                    .await
                    .is_err()
                {
                    return Ok(());
                }
                let mut checked = Instant::now();
                for bytes in bytes.chunks(CHECKPOINT_CHUNK_BYTES) {
                    if checked.elapsed() >= Duration::from_secs(1) {
                        source.authorize(scope.clone()).await?;
                        checked = Instant::now();
                    }
                    if send
                        .send(Ok(ArtifactDownload {
                            part: Some(Part::Chunk(bytes.to_vec())),
                        }))
                        .await
                        .is_err()
                    {
                        return Ok(());
                    }
                }
                source.authorize(scope).await?;
                Ok::<(), Status>(())
            };
            let error = match timeout_at(deadline, delivery).await {
                Ok(Ok(())) => return,
                Ok(Err(error)) => error,
                Err(_) => Status::deadline_exceeded("direct artifact grant expired"),
            };
            let _ = tokio::time::timeout(Duration::from_secs(1), send.send(Err(error))).await;
        });
        Ok(Response::new(ReceiverStream::new(receive)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifact_snapshots::{Capture, Snapshots};

    #[test]
    fn output_retention_replays_exact_bytes_and_survives_attempt_cleanup() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let root = temp.path().canonicalize()?;
        let durable = root.join("durable");
        let state = root.join("state");
        let checkout = root.join("checkout");
        fs::create_dir(&state)?;
        fs::create_dir(&checkout)?;
        fs::write(checkout.join("output.txt"), b"exact output")?;
        let storage = SourceStorage::open(&durable)?;
        let id = storage.id.clone();
        let snapshots = Snapshots::open(&state, "attempt")?;
        let attempt = InspectAttemptRequest {
            task_id: "task".into(),
            attempt_id: "attempt".into(),
            lease_token: "private-lease".into(),
        };
        let output = HarnessCaptureArtifactRequest {
            operation_id: "output".into(),
            description: Some(ArtifactDescription {
                title: "Declared output".into(),
                kind: "report".into(),
                summary: None,
            }),
            paths: vec!["output.txt".into()],
            native_session_id: None,
        };
        snapshots.freeze_outputs(&checkout, attempt.clone(), output.clone(), true, 32)?;
        let Capture::Pending(mut manifest, selected) =
            snapshots.replay_outputs(attempt.clone(), output.clone(), true, 32)?
        else {
            anyhow::bail!("expected pending output");
        };
        snapshots.retain_outputs(&mut manifest, &selected, Some(&storage))?;
        assert_eq!(manifest.source_storage_id.as_deref(), Some(id.as_str()));
        let blob = manifest.files[0].blob.clone().unwrap();
        let Capture::Pending(mut replay, exact) =
            snapshots.replay_outputs(attempt, output, true, 32)?
        else {
            anyhow::bail!("expected pending output replay");
        };
        assert!(snapshots.retain_outputs(&mut replay, &exact, None).is_err());
        assert_eq!(replay, manifest);
        snapshots.retain_outputs(&mut replay, &exact, Some(&storage))?;
        Snapshots::clear(&state)?;
        drop(storage);
        let restarted = SourceStorage::open(&durable)?;
        assert_eq!(restarted.id, id);
        assert_eq!(restarted.read("attempt", &blob)?, b"exact output");
        let object = blob_path(&durable.join(attempt_dir("attempt")), &blob)?;
        fs::write(&object, b"wrong output")?;
        assert!(restarted.read("attempt", &blob).is_err());
        assert!(restarted.retain(&mut replay, &exact).is_err());
        assert_eq!(fs::read(object)?, b"wrong output");
        Ok(())
    }

    #[test]
    fn peer_configuration_requires_exact_origins_and_tls_outside_loopback() {
        assert!(
            ArtifactPeers::configure(vec!["host=https://worker.example.com:7444".into()], None)
                .is_ok()
        );
        assert!(ArtifactPeers::configure(vec!["host=http://127.0.0.1:7444".into()], None).is_ok());
        for rejected in [
            "host=http://worker.example.com:7444",
            "host=http://localhost:7444",
            "host=https://user:secret@worker.example.com",
            "host=https://worker.example.com/files",
            "host=https://worker.example.com?secret",
        ] {
            assert!(ArtifactPeers::configure(vec![rejected.into()], None).is_err());
        }
    }
}
