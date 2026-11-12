use std::{path::Path, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use clap::ValueEnum;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use supertag_protocol::{
    CHECKPOINT_CHUNK_BYTES, MAX_MESSAGE_BYTES,
    v2::{
        BlobReference, GetWorkspaceArtifactRequest, WorkspaceArtifactKind,
        WorkspaceDeliveryReference, transfers_client::TransfersClient, workspace_download,
    },
    validate_workspace_delivery,
};
use tokio::io::AsyncWriteExt;

use crate::{Connection, connect_operator, request};

#[derive(Clone, Copy, ValueEnum)]
pub enum ArtifactKind {
    Patch,
    Bundle,
}

pub async fn download(
    connection: Connection,
    task_id: String,
    kind: ArtifactKind,
    output: &Path,
) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let mut client = TransfersClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let mut upstream = request(
        GetWorkspaceArtifactRequest {
            task_id,
            kind: match kind {
                ArtifactKind::Patch => WorkspaceArtifactKind::Patch as i32,
                ArtifactKind::Bundle => WorkspaceArtifactKind::Bundle as i32,
            },
        },
        &token,
    )?;
    upstream.set_timeout(Duration::from_secs(120));
    let mut stream = client
        .download_workspace_artifact(upstream)
        .await?
        .into_inner();
    let reference = match stream.message().await?.and_then(|message| message.part) {
        Some(workspace_download::Part::Reference(reference)) => reference,
        _ => bail!("workspace download did not include a receipt"),
    };
    validate_workspace_delivery(&reference)?;
    let blob = match kind {
        ArtifactKind::Patch => reference.patch.as_ref(),
        ArtifactKind::Bundle => reference.bundle.as_ref(),
    }
    .expect("validated blob reference");

    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let staged = tempfile::NamedTempFile::new_in(parent).context("stage workspace artifact")?;
    let mut file = tokio::fs::File::from_std(staged.as_file().try_clone()?);
    let mut size = 0u64;
    let mut digest = Sha256::new();
    while let Some(message) = stream.message().await? {
        let Some(workspace_download::Part::Chunk(chunk)) = message.part else {
            bail!("unexpected workspace download record");
        };
        size += chunk.len() as u64;
        ensure!(
            !chunk.is_empty() && chunk.len() <= CHECKPOINT_CHUNK_BYTES && size <= blob.byte_length,
            "workspace artifact chunk exceeds its receipt"
        );
        digest.update(&chunk);
        file.write_all(&chunk).await?;
    }
    ensure!(
        size == blob.byte_length && format!("{:x}", digest.finalize()) == blob.sha256,
        "workspace artifact differs from its receipt"
    );
    file.flush().await?;
    file.sync_all().await?;
    drop(file);
    staged
        .persist_noclobber(output)
        .context("publish workspace artifact")?;
    tokio::fs::File::open(parent).await?.sync_all().await?;
    println!(
        "{}",
        json!({ "output": output, "sha256": blob.sha256, "byte_length": size })
    );
    Ok(())
}

pub fn describe(reference: &WorkspaceDeliveryReference) -> Value {
    fn blob(value: &BlobReference) -> Value {
        json!({ "sha256": value.sha256, "byte_length": value.byte_length })
    }

    json!({
        "workspace_id": reference.workspace_id,
        "delivery_id": reference.delivery_id,
        "base_commit": reference.base_commit,
        "start_commit": reference.start_commit,
        "head_commit": reference.head_commit,
        "committed": reference.committed,
        "changed_files": reference.changed_files,
        "patch": reference.patch.as_ref().map(blob),
        "bundle": reference.bundle.as_ref().map(blob),
    })
}
