use crate::{Connection, connect_operator, request};
use anyhow::{Context, Result, bail};
use clap::Subcommand;
use serde_json::{Value, json};
use std::path::PathBuf;
use supertag_gateway::transfers::volumes::ArtifactVolumeMappings;
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
#[derive(Subcommand)]
pub enum VolumeCommand {
    /// Register a file Volume. Existing metadata requires its exact revision.
    Put {
        volume_id: String,
        #[arg(long)]
        source: String,
        #[arg(long)]
        operation_id: String,
        #[arg(long, default_value_t = 0)]
        expected_revision: u64,
    },
    Get {
        volume_id: String,
    },
    List {
        #[arg(long, default_value_t = 30)]
        limit: u32,
        #[arg(long, default_value = "")]
        after_id: String,
    },
    /// Remove metadata only when no reserved or verified copies depend on it.
    Delete {
        volume_id: String,
        #[arg(long)]
        operation_id: String,
        #[arg(long)]
        expected_revision: u64,
    },
    /// Copy one exact artifact file. The Gateway must separately consent to this Volume's path.
    Copy {
        volume_id: String,
        artifact_id: String,
        #[arg(long)]
        path: String,
        #[arg(long)]
        expected_revision: u64,
        #[arg(long)]
        operation_id: String,
    },
    /// Download and re-verify one recorded copy, including after the Gateway cache is lost.
    Download {
        copy_id: String,
        #[arg(long)]
        output: PathBuf,
    },
    CopyGet {
        copy_id: String,
    },
    Copies {
        #[arg(long, default_value = "")]
        volume_id: String,
        #[arg(long, default_value_t = 30)]
        limit: u32,
        #[arg(long, default_value_t = 0)]
        before_order: u64,
    },
}
pub fn mappings(values: Vec<String>) -> Result<ArtifactVolumeMappings> {
    let mut entries = Vec::new();
    for value in values {
        let (id, path) = value
            .split_once('=')
            .context("artifact Volume mapping requires ID=/absolute/directory")?;
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            bail!("artifact Volume mapping must use an absolute path")
        };
        entries.push((id.to_owned(), path));
    }
    ArtifactVolumeMappings::new(entries)
}
fn volume(v: &ArtifactVolume) -> Value {
    json!({"volume_id":v.volume_id,"source":v.source,"revision":v.revision})
}
fn copy(v: &ArtifactVolumeCopy) -> Value {
    json!({"copy_id":v.copy_id,"operation_id":v.operation_id,"volume":v.volume.as_ref().map(volume),"artifact_id":v.artifact_id,"file":v.file.as_ref().map(|f|json!({"path":f.path,"blob":f.blob.as_ref().map(|b|json!({"sha256":b.sha256,"byte_length":b.byte_length}))})),"storage_key":v.storage_key,"state":v.state().as_str_name(),"created_at_ms":v.created_at_ms,"verified_at_ms":v.verified_at_ms})
}
pub async fn run(connection: Connection, command: VolumeCommand) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let mut client = artifact_volumes_client::ArtifactVolumesClient::new(channel.clone())
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let value = match command {
        VolumeCommand::Download { copy_id, output } => {
            let receipt = client
                .get_copy(request(
                    GetArtifactVolumeCopyRequest {
                        copy_id: copy_id.clone(),
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            let expected = receipt.file.context("copy has no file")?;
            let blob = expected
                .blob
                .as_ref()
                .filter(|b| {
                    supertag_protocol::valid_sha256(&b.sha256)
                        && b.byte_length <= supertag_protocol::artifacts::MAX_ARTIFACT_FILE_BYTES
                })
                .context("copy has no valid stored bytes")?;
            let mut stream = client
                .download_copy(request(GetArtifactVolumeCopyRequest { copy_id }, &token)?)
                .await?
                .into_inner();
            match stream.message().await?.and_then(|v| v.part) {
                Some(artifact_download::Part::File(file)) if file == expected => {}
                _ => bail!("Volume download differs from its exact copy receipt"),
            }
            return crate::artifacts::publish_download(&output, blob, stream, |v| match v.part {
                Some(artifact_download::Part::Chunk(bytes)) => Some(bytes),
                _ => None,
            })
            .await;
        }
        VolumeCommand::Put {
            volume_id,
            source,
            operation_id,
            expected_revision,
        } => volume(
            &client
                .put(request(
                    PutArtifactVolumeRequest {
                        volume_id,
                        source,
                        operation_id,
                        expected_revision,
                    },
                    &token,
                )?)
                .await?
                .into_inner(),
        ),
        VolumeCommand::Get { volume_id } => volume(
            &client
                .get(request(GetArtifactVolumeRequest { volume_id }, &token)?)
                .await?
                .into_inner(),
        ),
        VolumeCommand::List { limit, after_id } => {
            let page = client
                .list(request(
                    ListArtifactVolumesRequest { limit, after_id },
                    &token,
                )?)
                .await?
                .into_inner();
            json!({"volumes":page.volumes.iter().map(volume).collect::<Vec<_>>(),"next_after_id":page.next_after_id})
        }
        VolumeCommand::Delete {
            volume_id,
            operation_id,
            expected_revision,
        } => {
            json!({"deleted":client.delete(request(DeleteArtifactVolumeRequest {volume_id,operation_id,expected_revision},&token)?).await?.into_inner().deleted})
        }
        VolumeCommand::Copy {
            volume_id,
            artifact_id,
            path,
            expected_revision,
            operation_id,
        } => {
            let mut catalog = artifact_catalog_client::ArtifactCatalogClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES);
            let artifact = catalog
                .get(request(
                    GetCapturedArtifactRequest {
                        artifact_id: artifact_id.clone(),
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            let expected_blob = artifact
                .files
                .into_iter()
                .find(|f| f.path == path)
                .and_then(|f| f.blob)
                .context("selected artifact file has no stored bytes")?;
            copy(
                &client
                    .copy(request(
                        CopyArtifactToVolumeRequest {
                            volume_id,
                            artifact_id,
                            path,
                            expected_revision,
                            operation_id,
                            expected_blob: Some(expected_blob),
                        },
                        &token,
                    )?)
                    .await?
                    .into_inner(),
            )
        }
        VolumeCommand::CopyGet { copy_id } => copy(
            &client
                .get_copy(request(GetArtifactVolumeCopyRequest { copy_id }, &token)?)
                .await?
                .into_inner(),
        ),
        VolumeCommand::Copies {
            volume_id,
            limit,
            before_order,
        } => {
            let page = client
                .list_copies(request(
                    ListArtifactVolumeCopiesRequest {
                        volume_id,
                        limit,
                        before_order,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            json!({"copies":page.copies.iter().map(copy).collect::<Vec<_>>(),"next_before_order":page.next_before_order})
        }
    };
    println!("{value}");
    Ok(())
}
