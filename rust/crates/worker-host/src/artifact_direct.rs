//! This Worker Host's artifact storage, and the transports that read from it.
//!
//! Every artifact a Task captures and every Workspace delivery's patch and bundle stay here, on the
//! producing Worker Host: the Control Plane stores none of their bytes. It relays them to readers
//! by asking this host over the `HostRelay` stream ([`relay`]). An opt-in peer listener also lets
//! other Worker Hosts read artifacts directly under a Control Plane grant.
use std::{
    collections::BTreeMap,
    fs::{self, DirBuilder, File, OpenOptions},
    io::{Read, Write},
    net::{IpAddr, SocketAddr},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
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
        host_relay_client::HostRelayClient,
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
                .timeout(GRANT_BUDGET)
                .http2_keep_alive_interval(supertag_transport::KEEPALIVE_INTERVAL)
                .keep_alive_timeout(supertag_transport::KEEPALIVE_TIMEOUT)
                .keep_alive_while_idle(true);
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

/// Where this Worker Host keeps the artifact and Workspace delivery bytes it holds, and
/// whether it also serves artifact reads directly to peer Worker Hosts.
pub struct ArtifactSourceConfig {
    /// A dedicated owner-only absolute directory, or exactly `STATE_DIRECTORY/artifacts`. Lanes of
    /// one supervised Host share one directory.
    pub directory: PathBuf,
    pub listen: Option<SocketAddr>,
    pub tls: Option<Identity>,
}

impl ArtifactSourceConfig {
    /// The default storage inside a Worker Host's state directory.
    pub fn in_state(state: &Path) -> Self {
        Self {
            directory: state.join("artifacts"),
            listen: None,
            tls: None,
        }
    }

    pub(crate) async fn bind(self, state: &Path, workspaces: &[&Path]) -> Result<BoundSource> {
        ensure!(
            self.listen
                .is_none_or(|listen| listen.ip().is_loopback() || self.tls.is_some()),
            "remote artifact listener requires TLS"
        );
        let directory = self.directory.clone();
        let state = state.canonicalize()?;
        // A mapped Workspace whose source is missing is not advertised and holds nothing.
        let workspaces = workspaces
            .iter()
            .filter_map(|path| match path.canonicalize() {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                result => Some(result),
            })
            .collect::<std::io::Result<Vec<_>>>()?;
        let storage = tokio::task::spawn_blocking(move || {
            ensure!(
                directory.is_absolute(),
                "artifact source directory must be absolute"
            );
            private_directory(&directory)?;
            let root = directory.canonicalize()?;
            // Inside the state directory, only its own `artifacts` entry, which nothing else uses.
            ensure!(
                !state.starts_with(&root)
                    && (!root.starts_with(&state) || root == state.join("artifacts"))
                    && workspaces
                        .iter()
                        .all(|path| !root.starts_with(path) && !path.starts_with(&root)),
                "artifact source directory overlaps Worker Host state or the source Workspace"
            );
            SourceStorage::open(&root)
        })
        .await??;
        let peers = match self.listen {
            Some(listen) => {
                // Pings every peer connection, as every other SuperTag service does.
                let mut server = Server::builder()
                    .http2_keepalive_interval(Some(supertag_transport::KEEPALIVE_INTERVAL))
                    .http2_keepalive_timeout(Some(supertag_transport::KEEPALIVE_TIMEOUT));
                if let Some(identity) = self.tls {
                    server = server.tls_config(ServerTlsConfig::new().identity(identity))?;
                }
                let listener = TcpListener::bind(listen)
                    .await
                    .context("bind artifact peer listener")?;
                Some((server, listener))
            }
            None => None,
        };
        Ok(BoundSource { peers, storage })
    }
}

pub(crate) struct BoundSource {
    peers: Option<(Server, TcpListener)>,
    storage: SourceStorage,
}

impl BoundSource {
    /// Registers this storage with the Control Plane, then answers its relay requests and, when
    /// configured, direct reads from peer Worker Hosts until `shutdown`.
    pub(crate) async fn serve(
        self,
        mut authority: Authority,
        relay: HostRelayClient<InterceptedService<Channel, HostHeaders>>,
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
        let stop = shutdown.child_token();
        // Open the relay stream before reporting ready, so the host's bytes are reachable as soon
        // as it is; a failure here is retried in the background.
        let first = relay::open(&relay, token).await.ok();
        let mut tasks = vec![tokio::spawn(relay::serve(
            relay,
            token.to_owned(),
            self.storage.clone(),
            stop.clone(),
            first,
        ))];
        if let Some((mut server, listener)) = self.peers {
            let source = SourceServer {
                authority,
                host_token: token.to_owned(),
                storage: self.storage.clone(),
                capacity: Arc::new(Semaphore::new(8)),
            };
            let stopped = stop.clone();
            let peers = server
                .add_service(
                    WorkerArtifactTransfersServer::new(source)
                        .max_decoding_message_size(16 * 1024)
                        .max_encoding_message_size(MAX_MESSAGE_BYTES),
                )
                .serve_with_incoming_shutdown(TcpListenerStream::new(listener), async move {
                    stopped.cancelled().await;
                });
            tasks.push(tokio::spawn(async move {
                if let Err(error) = peers.await {
                    tracing::warn!("artifact peer listener stopped: {error}");
                }
            }));
        }
        Ok(Serving {
            storage: self.storage,
            stop,
            tasks,
        })
    }
}

pub(crate) struct Serving {
    pub(crate) storage: SourceStorage,
    stop: CancellationToken,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}
impl Drop for Serving {
    fn drop(&mut self) {
        self.stop.cancel();
        for task in &self.tasks {
            task.abort();
        }
    }
}

/// The owner-only directory holding this Worker Host's immutable artifact and delivery bytes,
/// as `attempt-<sha256 of the Attempt ID>/<sha256 of the bytes>`. Writes are atomic and
/// content-addressed, so lanes of one Host share the directory and its storage identity.
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

    /// Keeps one Workspace delivery blob of `attempt`, verifying it against its receipt.
    pub(crate) fn retain_blob(
        &self,
        attempt: &str,
        blob: &BlobReference,
        content: &[u8],
    ) -> Result<()> {
        self.current()?;
        ensure!(
            valid_sha256(&blob.sha256)
                && blob.byte_length <= supertag_protocol::MAX_WORKSPACE_BLOB_BYTES as u64
                && content.len() as u64 == blob.byte_length
                && digest(content) == blob.sha256,
            "retained bytes differ from the receipt"
        );
        let parent = self.root.join(attempt_dir(attempt));
        private_directory(&parent)?;
        self.directory.sync_all()?;
        let path = parent.join(&blob.sha256);
        if let Some(file) = open_private(&path)? {
            verify(file, blob)?;
            return Ok(());
        }
        let mut staged = tempfile::NamedTempFile::new_in(&parent)?;
        staged.write_all(content)?;
        staged.as_file().sync_all()?;
        match staged.persist_noclobber(&path) {
            Ok(_) => {}
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        verify(
            open_private(&path)?.context("retained bytes vanished")?,
            blob,
        )?;
        supertag_workspaces::packages::open_directory(&parent)?.sync_all()?;
        self.current()
    }

    /// The verified bytes of one blob this host holds for `attempt`.
    pub(crate) fn read_held(&self, attempt: &str, blob: &BlobReference) -> Result<Vec<u8>> {
        ensure!(
            valid_sha256(&blob.sha256)
                && blob.byte_length <= supertag_protocol::MAX_WORKSPACE_BLOB_BYTES as u64,
            "invalid held byte reference"
        );
        self.current()?;
        let parent = self.root.join(attempt_dir(attempt));
        check_directory(&parent.symlink_metadata()?)?;
        let bytes = verify(
            open_private(&parent.join(&blob.sha256))?.context("held bytes are missing")?,
            blob,
        )?;
        self.current()?;
        Ok(bytes)
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

mod relay {
    //! Answers the Control Plane's relay requests from this host's artifact storage.
    use super::*;
    use supertag_protocol::v2::relay_frame::Part as Frame;

    type Requests = tonic::Streaming<RelayRequest>;

    /// Opens one `HostRelay.Await` stream.
    pub(super) async fn open(
        client: &HostRelayClient<InterceptedService<Channel, HostHeaders>>,
        token: &str,
    ) -> Result<Requests, Status> {
        let request = authenticated_request(AwaitRelayRequest {}, token, None)?;
        Ok(client.clone().r#await(request).await?.into_inner())
    }

    /// Keeps one `HostRelay.Await` stream open, reconnecting after failures, until `stop`.
    pub(super) async fn serve(
        client: HostRelayClient<InterceptedService<Channel, HostHeaders>>,
        token: String,
        storage: SourceStorage,
        stop: CancellationToken,
        mut first: Option<Requests>,
    ) {
        let capacity = Arc::new(Semaphore::new(8));
        loop {
            let session = async {
                let mut requests = match first.take() {
                    Some(requests) => requests,
                    None => open(&client, &token).await?,
                };
                while let Some(request) = requests.message().await? {
                    let Ok(permit) = capacity.clone().try_acquire_owned() else {
                        // The reader times out; the Control Plane bounds waiting requests.
                        continue;
                    };
                    let client = client.clone();
                    let token = token.clone();
                    let storage = storage.clone();
                    tokio::spawn(async move {
                        let _permit = permit;
                        answer(client, &token, storage, request).await;
                    });
                }
                Ok::<_, Status>(())
            };
            tokio::select! {
                _ = stop.cancelled() => return,
                _ = session => {}
            }
            tokio::select! {
                _ = stop.cancelled() => return,
                _ = tokio::time::sleep(Duration::from_secs(1)) => {}
            }
        }
    }

    async fn answer(
        mut client: HostRelayClient<InterceptedService<Channel, HostHeaders>>,
        token: &str,
        storage: SourceStorage,
        request: RelayRequest,
    ) {
        let attempt = request.attempt_id;
        let read = match request.blob {
            Some(blob) => tokio::task::spawn_blocking(move || storage.read_held(&attempt, &blob))
                .await
                .map_err(anyhow::Error::from)
                .and_then(|result| result),
            None => Err(anyhow::anyhow!("relay request names no blob")),
        };
        let mut frames = vec![RelayFrame {
            part: Some(Frame::RelayId(request.relay_id)),
        }];
        match read {
            Ok(bytes) => {
                frames.extend(
                    bytes
                        .chunks(CHECKPOINT_CHUNK_BYTES)
                        .map(|chunk| RelayFrame {
                            part: Some(Frame::Chunk(chunk.to_vec())),
                        }),
                )
            }
            Err(_) => frames.push(RelayFrame {
                part: Some(Frame::Failure("held bytes are missing or changed".into())),
            }),
        }
        let Ok(mut request) = authenticated_request(tokio_stream::iter(frames), token, None) else {
            return;
        };
        request.set_timeout(Duration::from_secs(120));
        if let Err(error) = client.deliver(request).await {
            tracing::debug!("relay delivery ended: {error}");
        }
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
