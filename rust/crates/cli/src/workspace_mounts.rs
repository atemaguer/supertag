use anyhow::{Context, Result};
use clap::Subcommand;
use serde_json::json;
use supertag_protocol::v2::{
    GetWorkspaceVolumeRequest, PutWorkspaceVolumeRequest,
    workspace_volumes_client::WorkspaceVolumesClient,
};

use crate::{Connection, connect_operator, request};

#[derive(Subcommand)]
pub enum VolumeCommand {
    /// Register a canonical file Volume for Workspace data.
    Put {
        volume_id: String,
        #[arg(long)]
        source: String,
        #[arg(long, default_value_t = 0)]
        expected_revision: u64,
    },
    Get {
        volume_id: String,
    },
}

pub async fn run(connection: Connection, command: VolumeCommand) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let mut client = WorkspaceVolumesClient::new(channel);
    let volume = match command {
        VolumeCommand::Put {
            volume_id,
            source,
            expected_revision,
        } => {
            client
                .put(request(
                    PutWorkspaceVolumeRequest {
                        volume_id,
                        source,
                        expected_revision,
                    },
                    &token,
                )?)
                .await?
        }
        VolumeCommand::Get { volume_id } => {
            client
                .get(request(GetWorkspaceVolumeRequest { volume_id }, &token)?)
                .await?
        }
    }
    .into_inner();
    println!(
        "{}",
        json!({"volume_id":volume.volume_id,"source":volume.source,"revision":volume.revision})
    );
    Ok(())
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
        max_bytes: u64,
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
        })
        .collect())
}
