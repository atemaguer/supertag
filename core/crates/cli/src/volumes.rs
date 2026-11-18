use crate::{Connection, connect_operator, request};
use anyhow::{Context, Result, bail};
use clap::{Args, Subcommand};
use serde_json::{Value, json};
use std::path::PathBuf;
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};

#[derive(Subcommand)]
pub enum VolumeCommand {
    /// Register a file or S3-compatible Volume. Existing metadata requires its exact revision.
    Put {
        volume_id: String,
        /// Canonical file:///absolute/path or s3://bucket/prefix. The Control Plane supplies storage endpoints and credentials.
        #[arg(long)]
        source: String,
        /// Idempotency key: a retry with the same key returns the first result instead of acting twice.
        #[arg(long)]
        operation_id: String,
        /// The revision you last read, or 0 to create. The change is refused when it no longer matches.
        #[arg(long, default_value_t = 0)]
        expected_revision: u64,
    },
    /// Store or remove an S3 Volume's signing credential in this machine's credential vault. Run it
    /// on the machine that runs the Control Plane, or with its vault.
    #[command(subcommand)]
    Credential(CredentialCommand),
}

#[derive(Subcommand)]
pub enum CredentialCommand {
    /// Store the credential the Control Plane signs an S3 Volume's object URLs with. The access
    /// key comes from SUPERTAG_VOLUME_ACCESS_KEY_ID, the secret from
    /// SUPERTAG_VOLUME_SECRET_ACCESS_KEY, and an optional session token from
    /// SUPERTAG_VOLUME_SESSION_TOKEN. Worker Hosts never receive it.
    Set {
        volume_id: String,
        /// The S3-compatible service's HTTPS origin, such as https://s3.us-east-1.amazonaws.com.
        #[arg(long)]
        endpoint: String,
        /// The service's region, such as us-east-1, or auto.
        #[arg(long)]
        region: String,
    },
    /// Remove an S3 Volume's signing credential from this machine's credential vault.
    Remove { volume_id: String },
}

// Options for `supertag get volumes`.
#[derive(Args)]
pub struct ListArgs {
    /// Most entries to return on one page.
    #[arg(long, default_value_t = 30, conflicts_with = "id")]
    limit: u32,
    /// Continue after the last ID the previous page returned.
    #[arg(long, default_value = "", conflicts_with = "id")]
    after_id: String,
}

// Options for `supertag get volume-copies`.
#[derive(Args)]
pub struct CopyListArgs {
    /// Only copies made into this Volume.
    #[arg(long, default_value = "", conflicts_with = "id")]
    volume_id: String,
    /// Most entries to return on one page.
    #[arg(long, default_value_t = 30, conflicts_with = "id")]
    limit: u32,
    /// Continue from the next_before_order the previous page returned.
    #[arg(long, default_value_t = 0, conflicts_with = "id")]
    before_order: u64,
}

// Options for `supertag delete volume`. Only metadata is removed, and only when no reserved or
// verified copies depend on it.
#[derive(Args)]
pub struct DeleteArgs {
    /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
    #[arg(long)]
    operation_id: Option<String>,
    /// The revision you last read. The change is refused when the resource has changed since.
    #[arg(long)]
    expected_revision: u64,
    /// Check the deletion and show what it would remove, without deleting anything.
    #[arg(long)]
    pub(crate) dry_run: bool,
}

fn client(
    channel: ProtocolChannel,
) -> artifact_volumes_client::ArtifactVolumesClient<ProtocolChannel> {
    artifact_volumes_client::ArtifactVolumesClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

pub(crate) async fn fetch(
    channel: ProtocolChannel,
    token: &str,
    volume_id: String,
) -> Result<Value> {
    Ok(volume(
        &client(channel)
            .get(request(GetArtifactVolumeRequest { volume_id }, token)?)
            .await?
            .into_inner(),
    ))
}

pub(crate) async fn fetch_copy(
    channel: ProtocolChannel,
    token: &str,
    copy_id: String,
) -> Result<Value> {
    Ok(copy(
        &client(channel)
            .get_copy(request(GetArtifactVolumeCopyRequest { copy_id }, token)?)
            .await?
            .into_inner(),
    ))
}

pub(crate) async fn list(connection: Connection, args: ListArgs) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let page = client(channel)
        .list(request(
            ListArtifactVolumesRequest {
                limit: args.limit,
                after_id: args.after_id,
            },
            &token,
        )?)
        .await?
        .into_inner();
    Ok(
        json!({"volumes":page.volumes.iter().map(volume).collect::<Vec<_>>(),"next_after_id":page.next_after_id}),
    )
}

pub(crate) async fn list_copies(connection: Connection, args: CopyListArgs) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let page = client(channel)
        .list_copies(request(
            ListArtifactVolumeCopiesRequest {
                volume_id: args.volume_id,
                limit: args.limit,
                before_order: args.before_order,
            },
            &token,
        )?)
        .await?
        .into_inner();
    Ok(
        json!({"copies":page.copies.iter().map(copy).collect::<Vec<_>>(),"next_before_order":page.next_before_order}),
    )
}

pub(crate) async fn delete(
    connection: Connection,
    volume_id: String,
    args: DeleteArgs,
) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let deleted = client(channel)
        .delete(request(
            DeleteArtifactVolumeRequest {
                volume_id,
                operation_id: args
                    .operation_id
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                expected_revision: args.expected_revision,
                dry_run: args.dry_run,
            },
            &token,
        )?)
        .await?
        .into_inner()
        .deleted;
    Ok(json!({ "deleted": deleted }))
}

/// A Worker Host's own file Volume mappings, as `ID=/absolute/directory`. None may
/// overlap another, or any directory in `protected`.
pub fn host_mappings(
    values: Vec<String>,
    protected: &[&std::path::Path],
) -> Result<std::collections::BTreeMap<String, supertag_workspaces::artifact_volumes::FileVolume>> {
    let mut mappings = std::collections::BTreeMap::new();
    for value in values {
        let (id, path) = value
            .split_once('=')
            .context("a Volume mapping is VOLUME_ID=/absolute/directory")?;
        let path = PathBuf::from(path);
        if id.is_empty() || !path.is_absolute() {
            bail!("a Volume mapping is VOLUME_ID=/absolute/directory")
        }
        let mapping = supertag_workspaces::artifact_volumes::FileVolume::open(&path)?;
        for other in protected {
            let other = other.canonicalize().unwrap_or_else(|_| other.to_path_buf());
            if mapping.root.starts_with(&other) || other.starts_with(&mapping.root) {
                bail!("Volume {id} overlaps this host's own state")
            }
        }
        if mappings.values().any(
            |prior: &supertag_workspaces::artifact_volumes::FileVolume| prior.overlaps(&mapping),
        ) || mappings.insert(id.to_owned(), mapping).is_some()
        {
            bail!("Volume mappings overlap or repeat")
        }
    }
    Ok(mappings)
}
pub(crate) fn volume(v: &ArtifactVolume) -> Value {
    json!({"volume_id":v.volume_id,"source":v.source,"revision":v.revision})
}
fn copy(v: &ArtifactVolumeCopy) -> Value {
    json!({"copy_id":v.copy_id,"operation_id":v.operation_id,"volume":v.volume.as_ref().map(volume),"artifact_id":v.artifact_id,"file":v.file.as_ref().map(|f|json!({"path":f.path,"blob":f.blob.as_ref().map(|b|json!({"sha256":b.sha256,"byte_length":b.byte_length}))})),"storage_key":v.storage_key,"state":v.state().as_str_name(),"created_at_ms":v.created_at_ms,"verified_at_ms":v.verified_at_ms,"host_attested":v.host_attested})
}
async fn credential(command: CredentialCommand) -> Result<Value> {
    let vault = supertag_credential_vault::CredentialVault::from_process_environment()?;
    Ok(match command {
        CredentialCommand::Set {
            volume_id,
            endpoint,
            region,
        } => {
            let variable = |name: &str| {
                std::env::var(name)
                    .ok()
                    .map(|value| value.trim().to_owned())
                    .filter(|value| !value.is_empty())
            };
            let mut value = supertag_credential_vault::CredentialValue::from([
                ("endpoint".to_owned(), endpoint),
                ("region".to_owned(), region),
                (
                    "access_key_id".to_owned(),
                    variable("SUPERTAG_VOLUME_ACCESS_KEY_ID")
                        .context("set SUPERTAG_VOLUME_ACCESS_KEY_ID to the access key")?,
                ),
                (
                    "secret_access_key".to_owned(),
                    variable("SUPERTAG_VOLUME_SECRET_ACCESS_KEY")
                        .context("set SUPERTAG_VOLUME_SECRET_ACCESS_KEY to the secret key")?,
                ),
            ]);
            if let Some(token) = variable("SUPERTAG_VOLUME_SESSION_TOKEN") {
                value.insert("session_token".to_owned(), token);
            }
            vault
                .store(
                    &supertag_protocol::volumes::credential_vault_id(&volume_id),
                    &value,
                )
                .await
                .context("store the Volume credential in this machine's credential vault")?;
            json!({ "volume_id": volume_id, "credential": "stored" })
        }
        CredentialCommand::Remove { volume_id } => {
            vault
                .delete(&supertag_protocol::volumes::credential_vault_id(&volume_id))
                .await
                .context("remove the Volume credential from this machine's credential vault")?;
            json!({ "volume_id": volume_id, "credential": "removed" })
        }
    })
}

pub async fn run(connection: Connection, command: VolumeCommand) -> Result<()> {
    if let VolumeCommand::Credential(command) = command {
        crate::terminal::print_json(&credential(command).await?)?;
        return Ok(());
    }
    let (channel, token) = connect_operator(connection).await?;
    let mut client = client(channel.clone());
    let value = match command {
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
        VolumeCommand::Credential(_) => unreachable!("handled above"),
    };
    crate::terminal::print_json(&value)?;
    Ok(())
}
