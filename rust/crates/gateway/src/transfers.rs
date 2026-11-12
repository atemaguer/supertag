use std::{
    fs::{DirBuilder, File, OpenOptions},
    io::ErrorKind,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use supertag_protocol::{
    CHECKPOINT_CHUNK_BYTES, MAX_MESSAGE_BYTES, host_generation,
    v2::{
        checkpoint_directory_client::CheckpointDirectoryClient,
        checkpoint_download, checkpoint_upload,
        transfers_server::{Transfers, TransfersServer},
        *,
    },
    validate_checkpoint_reference,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{Semaphore, mpsc},
    time::timeout,
};
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status, Streaming, transport::Channel};

use crate::Gateway;

const TRANSFER_TIMEOUT: Duration = Duration::from_secs(25);

#[derive(Clone)]
pub struct CheckpointTransfers {
    gateway: Gateway,
    directory: Option<PathBuf>,
    capacity: Arc<Semaphore>,
}

impl CheckpointTransfers {
    pub fn new(gateway: Gateway, directory: Option<PathBuf>) -> Result<Self> {
        if let Some(directory) = &directory {
            DirBuilder::new()
                .mode(0o700)
                .recursive(true)
                .create(directory)
                .context("create Gateway checkpoint directory")?;
            let metadata = directory.symlink_metadata()?;
            ensure!(
                metadata.is_dir()
                    && metadata.mode() & 0o077 == 0
                    && metadata.uid() == unsafe { libc::geteuid() },
                "Gateway checkpoint directory must be private"
            );
        }
        Ok(Self {
            gateway,
            directory,
            capacity: Arc::new(Semaphore::new(16)),
        })
    }

    pub fn service(self) -> TransfersServer<Self> {
        TransfersServer::new(self)
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    async fn upload(
        &self,
        request: Request<Streaming<CheckpointUpload>>,
    ) -> Result<Response<CheckpointReference>, Status> {
        let directory = self.directory.as_ref().ok_or_else(|| {
            Status::failed_precondition("Gateway checkpoint storage is not configured")
        })?;
        let (metadata, _, mut stream) = request.into_parts();
        let begin = match stream.message().await?.and_then(|message| message.part) {
            Some(checkpoint_upload::Part::Begin(begin)) => begin,
            _ => {
                return Err(Status::invalid_argument(
                    "checkpoint upload requires an opening record",
                ));
            }
        };
        let reference = begin
            .reference
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("checkpoint reference required"))?;
        validate_checkpoint_reference(reference)?;
        let mut reservation = Request::new(begin.clone());
        *reservation.metadata_mut() = metadata.clone();
        let reserved = self
            .gateway
            .forward_host(reservation, true, |channel, request| async move {
                checkpoint_client(channel).reserve_checkpoint(request).await
            })
            .await?
            .into_inner();
        if &reserved != reference {
            return Err(Status::data_loss(
                "Control Plane returned a different checkpoint reservation",
            ));
        }

        let mut file = tempfile::NamedTempFile::new_in(directory).map_err(storage_error)?;
        let mut handle =
            tokio::fs::File::from_std(file.as_file_mut().try_clone().map_err(storage_error)?);
        let mut length = 0u64;
        let mut digest = Sha256::new();
        while let Some(message) = stream.message().await? {
            let Some(checkpoint_upload::Part::Chunk(chunk)) = message.part else {
                return Err(Status::invalid_argument("expected a checkpoint chunk"));
            };
            length += chunk.len() as u64;
            if chunk.is_empty()
                || chunk.len() > CHECKPOINT_CHUNK_BYTES
                || length > reference.byte_length
            {
                return Err(Status::invalid_argument("invalid checkpoint chunk size"));
            }
            digest.update(&chunk);
            handle.write_all(&chunk).await.map_err(storage_error)?;
        }
        if length != reference.byte_length || format!("{:x}", digest.finalize()) != reference.sha256
        {
            return Err(Status::invalid_argument(
                "checkpoint length or digest mismatch",
            ));
        }
        handle.flush().await.map_err(storage_error)?;
        handle.sync_all().await.map_err(storage_error)?;
        drop(handle);
        let path = directory.join(&reference.sha256);
        if let Err(error) = file.persist_noclobber(&path) {
            if error.error.kind() != ErrorKind::AlreadyExists {
                return Err(storage_error(error.error));
            }
            verify_existing(&path, reference).await?;
        }
        let directory = directory.clone();
        tokio::task::spawn_blocking(move || File::open(directory)?.sync_all())
            .await
            .map_err(|_| Status::internal("checkpoint durability check failed"))?
            .map_err(storage_error)?;

        let mut commit = Request::new(begin);
        *commit.metadata_mut() = metadata;
        self.gateway
            .forward_host(commit, true, |channel, request| async move {
                checkpoint_client(channel).commit_checkpoint(request).await
            })
            .await
    }

    async fn get_reference(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<Option<CheckpointReference>, Status> {
        self.gateway
            .forward_host(request, true, |channel, request| async move {
                checkpoint_client(channel).get_checkpoint(request).await
            })
            .await
            .map(|response| response.into_inner().reference)
    }
}

#[tonic::async_trait]
impl Transfers for CheckpointTransfers {
    async fn upload_checkpoint(
        &self,
        request: Request<Streaming<CheckpointUpload>>,
    ) -> Result<Response<CheckpointReference>, Status> {
        let token_digest = self.gateway.credentials.host_credential_digest(&request)?;
        let generation = host_generation(&request)?;
        let host = timeout(
            Duration::from_secs(5),
            self.gateway
                .authenticate_host(token_digest, Duration::from_secs(5)),
        )
        .await
        .map_err(|_| Status::deadline_exceeded("Worker Host authentication timed out"))??;
        if host.revoked || generation != host.generation {
            return Err(Status::permission_denied(
                "Worker Host generation is no longer current",
            ));
        }
        let _permit = self
            .capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| Status::resource_exhausted("too many checkpoint transfers"))?;
        timeout(TRANSFER_TIMEOUT, self.upload(request))
            .await
            .map_err(|_| Status::deadline_exceeded("checkpoint upload timed out"))?
    }

    type DownloadCheckpointStream = ReceiverStream<Result<CheckpointDownload, Status>>;

    async fn download_checkpoint(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<Response<Self::DownloadCheckpointStream>, Status> {
        let mut authorization = Request::new(request.get_ref().clone());
        *authorization.metadata_mut() = request.metadata().clone();
        let reference = self.get_reference(request).await?;
        let permit = self
            .capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| Status::resource_exhausted("too many checkpoint transfers"))?;
        let (send, receive) = mpsc::channel(2);
        if let Some(reference) = reference {
            validate_checkpoint_reference(&reference)?;
            let directory = self.directory.as_ref().ok_or_else(|| {
                Status::failed_precondition("Gateway checkpoint storage is not configured")
            })?;
            let file = open_checkpoint(&directory.join(&reference.sha256)).await?;
            let service = self.clone();
            let result = async move {
                let _permit = permit;
                let authorize = || {
                    let service = service.clone();
                    let mut request = Request::new(authorization.get_ref().clone());
                    *request.metadata_mut() = authorization.metadata().clone();
                    async move { service.get_reference(request).await }
                };
                let result = timeout(
                    TRANSFER_TIMEOUT,
                    download(&send, file, reference, authorize),
                )
                .await;
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        let _ = send.send(Err(error)).await;
                    }
                    Err(_) => {
                        let _ = send.try_send(Err(Status::deadline_exceeded(
                            "checkpoint download timed out",
                        )));
                    }
                }
            };
            tokio::spawn(result);
        }
        Ok(Response::new(ReceiverStream::new(receive)))
    }
}

async fn download<F, Authorization>(
    send: &mpsc::Sender<Result<CheckpointDownload, Status>>,
    mut file: tokio::fs::File,
    reference: CheckpointReference,
    authorize: F,
) -> Result<(), Status>
where
    F: Fn() -> Authorization + Send,
    Authorization: std::future::Future<Output = Result<Option<CheckpointReference>, Status>> + Send,
{
    let expected = reference.byte_length;
    let sha256 = &reference.sha256;
    if send
        .send(Ok(CheckpointDownload {
            part: Some(checkpoint_download::Part::Reference(reference.clone())),
        }))
        .await
        .is_err()
    {
        return Ok(());
    }
    let mut length = 0u64;
    let mut digest = Sha256::new();
    let mut buffer = vec![0u8; CHECKPOINT_CHUNK_BYTES];
    let mut checked = tokio::time::Instant::now();
    loop {
        if checked.elapsed() >= Duration::from_secs(1) {
            if authorize().await?.as_ref() != Some(&reference) {
                return Err(Status::permission_denied(
                    "Session checkpoint is no longer authorized",
                ));
            }
            checked = tokio::time::Instant::now();
        }
        let size = file.read(&mut buffer).await.map_err(storage_error)?;
        if size == 0 {
            break;
        }
        let chunk = &buffer[..size];
        length += size as u64;
        if length > expected {
            return Err(Status::data_loss(
                "checkpoint size does not match its receipt",
            ));
        }
        digest.update(chunk);
        if send
            .send(Ok(CheckpointDownload {
                part: Some(checkpoint_download::Part::Chunk(chunk.to_vec())),
            }))
            .await
            .is_err()
        {
            return Ok(());
        }
    }
    if length != expected || format!("{:x}", digest.finalize()) != *sha256 {
        return Err(Status::data_loss(
            "checkpoint bytes do not match their receipt",
        ));
    }
    Ok(())
}

async fn verify_existing(path: &Path, reference: &CheckpointReference) -> Result<(), Status> {
    let file = open_checkpoint(path).await?;
    let mut buffer = Vec::with_capacity(reference.byte_length as usize);
    file.take(reference.byte_length + 1)
        .read_to_end(&mut buffer)
        .await
        .map_err(storage_error)?;
    if buffer.len() as u64 != reference.byte_length
        || format!("{:x}", Sha256::digest(&buffer)) != reference.sha256
    {
        return Err(Status::data_loss(
            "checkpoint storage conflicts with the upload",
        ));
    }
    Ok(())
}

async fn open_checkpoint(path: &Path) -> Result<tokio::fs::File, Status> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(|error| {
                if error.kind() == ErrorKind::NotFound {
                    Status::data_loss("checkpoint bytes are missing")
                } else {
                    storage_error(error)
                }
            })?;
        if !file.metadata().map_err(storage_error)?.is_file() {
            return Err(Status::data_loss("checkpoint storage entry is not a file"));
        }
        Ok(tokio::fs::File::from_std(file))
    })
    .await
    .map_err(|_| Status::internal("checkpoint file open failed"))?
}

fn checkpoint_client(channel: Channel) -> CheckpointDirectoryClient<Channel> {
    CheckpointDirectoryClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

fn storage_error(error: std::io::Error) -> Status {
    eprintln!("Gateway checkpoint storage error: {}", error.kind());
    Status::internal("checkpoint storage operation failed")
}
