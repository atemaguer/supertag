use std::{future::Future, path::PathBuf, time::Duration};

use sha2::{Digest, Sha256};
use supertag_protocol::{
    CHECKPOINT_CHUNK_BYTES, MAX_MESSAGE_BYTES,
    artifacts::{MAX_ARTIFACT_FILE_BYTES, validate_artifact_path},
    v2::{
        DownloadArtifactFileRequest, artifact_download::Part,
        artifact_transfers_client::ArtifactTransfersClient,
    },
    valid_sha256,
};
use tokio::{fs, io::AsyncWriteExt, time::timeout};

use super::{GatewayState, Result, rpc_error};

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(65);
const INVALID_DOWNLOAD: &str = "The downloaded file did not match its receipt.";
const SAVE_ERROR: &str = "Could not write the selected file.";

impl GatewayState {
    pub(crate) async fn save_artifact<F>(
        &self,
        connection_id: &str,
        artifact_id: String,
        path: String,
        choose: impl FnOnce(String) -> F,
    ) -> Result<bool>
    where
        F: Future<Output = Result<Option<PathBuf>>>,
    {
        validate_artifact_path(&path).map_err(rpc_error)?;
        let session = self.session(connection_id).await?;
        let basename = path.rsplit('/').next().expect("validated artifact path");
        let Some(destination) = choose(basename.to_owned()).await? else {
            return Ok(false);
        };
        self.current(&session, ()).await?;
        let parent = destination.parent().ok_or(SAVE_ERROR)?;
        let staged = tempfile::NamedTempFile::new_in(parent).map_err(|_| SAVE_ERROR)?;
        let mut writer = fs::File::from_std(staged.as_file().try_clone().map_err(|_| SAVE_ERROR)?);
        let mut request = session.authenticated(DownloadArtifactFileRequest {
            artifact_id,
            path: path.clone(),
        });
        request.set_timeout(DOWNLOAD_TIMEOUT);
        timeout(DOWNLOAD_TIMEOUT, async {
            let mut stream = ArtifactTransfersClient::new(session.channel.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .download_file(request)
                .await
                .map_err(rpc_error)?
                .into_inner();
            let receipt = match stream
                .message()
                .await
                .map_err(rpc_error)?
                .and_then(|row| row.part)
            {
                Some(Part::File(file)) if file.path == path => file.blob,
                _ => None,
            }
            .filter(|blob| {
                blob.byte_length <= MAX_ARTIFACT_FILE_BYTES && valid_sha256(&blob.sha256)
            })
            .ok_or(INVALID_DOWNLOAD)?;
            let mut length = 0_u64;
            let mut digest = Sha256::new();
            while let Some(row) = stream.message().await.map_err(rpc_error)? {
                let Some(Part::Chunk(bytes)) = row.part else {
                    return Err(INVALID_DOWNLOAD.into());
                };
                length += bytes.len() as u64;
                if bytes.is_empty()
                    || bytes.len() > CHECKPOINT_CHUNK_BYTES
                    || length > receipt.byte_length
                {
                    return Err(INVALID_DOWNLOAD.into());
                }
                digest.update(&bytes);
                writer.write_all(&bytes).await.map_err(|_| SAVE_ERROR)?;
            }
            if length != receipt.byte_length || format!("{:x}", digest.finalize()) != receipt.sha256
            {
                return Err(INVALID_DOWNLOAD.into());
            }
            Ok::<(), String>(())
        })
        .await
        .map_err(|_| "The Gateway file download timed out.".to_owned())??;
        writer.flush().await.map_err(|_| SAVE_ERROR)?;
        writer.sync_all().await.map_err(|_| SAVE_ERROR)?;
        drop(writer);

        // A connection change during the stream must not publish a stale file.
        {
            let current = self.0.read().await;
            if !current
                .session
                .as_ref()
                .is_some_and(|value| std::sync::Arc::ptr_eq(value, &session))
            {
                return Err("The connection changed. Refresh this view.".into());
            }
            staged.persist_noclobber(&destination).map_err(|error| {
                if error.error.kind() == std::io::ErrorKind::AlreadyExists {
                    "A file with that name already exists. Choose another name."
                } else {
                    SAVE_ERROR
                }
            })?;
        }
        Ok(true)
    }
}
