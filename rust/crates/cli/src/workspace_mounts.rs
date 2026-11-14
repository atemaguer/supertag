use anyhow::{Context, Result};
use clap::Subcommand;
use serde_json::{Value, json};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::v2::{
    GetWorkspaceVolumeRequest, PutWorkspaceVolumeRequest, WorkspaceVolume,
    workspace_volumes_client::WorkspaceVolumesClient,
};

use crate::{Connection, connect_operator, request};

#[derive(Subcommand)]
pub enum VolumeCommand {
    /// Register a Volume for Workspace data: a host directory or an S3 bucket and prefix.
    Put {
        volume_id: String,
        /// Canonical file:///absolute/path of the data directory, or s3://bucket/prefix.
        #[arg(long)]
        source: String,
        /// For an s3:// source, the credential name each serving Worker Host maps; never a secret.
        #[arg(long)]
        credential: Option<String>,
        /// The revision you last read, or 0 to create. The change is refused when it no longer matches.
        #[arg(long, default_value_t = 0)]
        expected_revision: u64,
    },
}

pub async fn run(connection: Connection, command: VolumeCommand) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let mut client = WorkspaceVolumesClient::new(channel);
    let volume = match command {
        VolumeCommand::Put {
            volume_id,
            source,
            credential,
            expected_revision,
        } => {
            client
                .put(request(
                    PutWorkspaceVolumeRequest {
                        volume_id,
                        source,
                        expected_revision,
                        credential: credential.unwrap_or_default(),
                    },
                    &token,
                )?)
                .await?
        }
    }
    .into_inner();
    crate::terminal::print_json(&volume_json(&volume))?;
    Ok(())
}

fn volume_json(volume: &WorkspaceVolume) -> Value {
    json!({"volume_id":volume.volume_id,"source":volume.source,"credential":(!volume.credential.is_empty()).then_some(&volume.credential),"revision":volume.revision})
}

pub(crate) async fn fetch(
    channel: ProtocolChannel,
    token: &str,
    volume_id: String,
) -> Result<Value> {
    Ok(volume_json(
        &WorkspaceVolumesClient::new(channel)
            .get(request(GetWorkspaceVolumeRequest { volume_id }, token)?)
            .await?
            .into_inner(),
    ))
}

pub fn read_declarations(
    path: &std::path::Path,
) -> Result<Vec<supertag_protocol::v2::WorkspaceCopyMount>> {
    use std::io::Read;
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields, rename_all = "camelCase")]
    struct Mount {
        volume_id: String,
        destination: String,
        #[serde(default = "default_max_bytes")]
        max_bytes: u64,
        #[serde(default)]
        access: Access,
    }
    fn default_max_bytes() -> u64 {
        supertag_protocol::workspace_mounts::DEFAULT_WORKSPACE_MOUNT_BYTES
    }
    #[derive(serde::Deserialize, Default, PartialEq)]
    #[serde(rename_all = "kebab-case")]
    enum Access {
        #[default]
        ReadOnly,
        ReadWrite,
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(32 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() <= 32 * 1024,
        "Workspace mount declaration exceeds its size limit"
    );
    let declared: Vec<Mount> =
        serde_json::from_slice(&bytes).context("invalid Workspace mount declarations")?;
    Ok(declared
        .into_iter()
        .map(|value| supertag_protocol::v2::WorkspaceCopyMount {
            volume_id: value.volume_id,
            destination: value.destination,
            max_bytes: value.max_bytes,
            volume: None,
            read_write: value.access == Access::ReadWrite,
        })
        .collect())
}

/// Operator JSON for configured mounts and the Volume pins frozen at admission.
pub fn describe(mounts: &[supertag_protocol::v2::WorkspaceCopyMount]) -> serde_json::Value {
    mounts
        .iter()
        .map(|mount| {
            json!({
                "volume_id": mount.volume_id,
                "destination": mount.destination,
                "max_bytes": mount.max_bytes,
                "access": if mount.read_write { "read-write" } else { "read-only" },
                "volume": mount.volume.as_ref().map(|volume| json!({
                    "source": volume.source,
                    "credential": (!volume.credential.is_empty()).then_some(&volume.credential),
                    "revision": volume.revision,
                })),
            })
        })
        .collect()
}

/// Operator JSON for what each Attempt's read-write copies wrote back.
pub fn describe_writes(
    attempts: &[supertag_protocol::v2::AttemptWorkspaceMountWrites],
) -> serde_json::Value {
    use supertag_protocol::v2::WorkspaceMountWriteStatus;
    attempts
        .iter()
        .map(|attempt| {
            json!({
                "attempt_id": attempt.attempt_id,
                "writes": attempt.writes.iter().map(|write| json!({
                    "volume_id": write.volume_id,
                    "destination": write.destination,
                    "status": match WorkspaceMountWriteStatus::try_from(write.status) {
                        Ok(WorkspaceMountWriteStatus::Complete) => "complete",
                        Ok(WorkspaceMountWriteStatus::Partial) => "partial",
                        Ok(WorkspaceMountWriteStatus::Refused) => "refused",
                        _ => "unknown",
                    },
                    "files": write.files.iter().map(|file| json!({
                        "key": file.key, "size": file.size, "sha256": file.sha256,
                    })).collect::<Vec<_>>(),
                    "skipped": write.skipped,
                    "error": (!write.error_key.is_empty() || !write.error_reason.is_empty()).then(|| json!({
                        "key": write.error_key, "reason": write.error_reason,
                    })),
                    "not_attempted": write.not_attempted,
                })).collect::<Vec<_>>(),
            })
        })
        .collect()
}
