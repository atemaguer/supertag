use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use clap::{Subcommand, ValueEnum};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use supertag_protocol::{
    CHECKPOINT_CHUNK_BYTES, MAX_MESSAGE_BYTES,
    artifacts::{MAX_ARTIFACT_FILE_BYTES, validate_artifact_path},
    v2::{
        ArtifactSummary, BlobReference, DownloadArtifactFileRequest, GetCapturedArtifactRequest,
        GetWorkspaceArtifactRequest, ListCapturedArtifactsRequest, WorkspaceArtifactKind,
        WorkspaceDeliveryReference, artifact_catalog_client::ArtifactCatalogClient,
        artifact_download, artifact_transfers_client::ArtifactTransfersClient,
        transfers_client::TransfersClient, workspace_download,
    },
    valid_sha256, validate_workspace_delivery,
};
use tokio::io::AsyncWriteExt;

use crate::{Connection, connect_operator, request};

#[derive(Clone, Copy, ValueEnum)]
pub enum ArtifactKind {
    Patch,
    Bundle,
}

#[derive(Subcommand)]
pub enum CaptureCommand {
    /// List artifacts captured by a Task.
    List {
        #[arg(long)]
        task: String,
        #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
        #[arg(long, default_value_t = 0)]
        before_order: u64,
    },
    /// Read an artifact's provenance and exact file manifest.
    Get { artifact_id: String },
    /// Download one immutable file and verify its digest before publishing it locally.
    Download {
        artifact_id: String,
        #[arg(long)]
        path: String,
        #[arg(long)]
        output: PathBuf,
    },
}

pub async fn run_capture(connection: Connection, command: CaptureCommand) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let mut catalog = ArtifactCatalogClient::new(channel.clone())
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let value = match command {
        CaptureCommand::List {
            task,
            limit,
            before_order,
        } => {
            let page = catalog
                .list(request(
                    ListCapturedArtifactsRequest {
                        task_id: task,
                        limit,
                        before_order,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            json!({
                "artifacts": page.artifacts.iter().map(capture_summary).collect::<Vec<_>>(),
                "next_before_order": page.next_before_order,
            })
        }
        CaptureCommand::Get { artifact_id } => {
            let capture = catalog
                .get(request(GetCapturedArtifactRequest { artifact_id }, &token)?)
                .await?
                .into_inner();
            json!({
                "summary": capture.summary.as_ref().map(capture_summary),
                "inputs": capture.inputs.iter().map(|input| json!({"artifact_id":input.artifact_id,"paths":input.paths})).collect::<Vec<_>>(),
                "files": capture.files.iter().map(|file| json!({
                    "path": file.path,
                    "blob": file.blob.as_ref().map(describe_blob),
                })).collect::<Vec<_>>(),
            })
        }
        CaptureCommand::Download {
            artifact_id,
            path,
            output,
        } => {
            validate_artifact_path(&path)?;
            let mut client = ArtifactTransfersClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES);
            let mut upstream = request(
                DownloadArtifactFileRequest {
                    artifact_id,
                    path: path.clone(),
                },
                &token,
            )?;
            upstream.set_timeout(Duration::from_secs(65));
            let mut stream = client.download_file(upstream).await?.into_inner();
            let file = match stream.message().await?.and_then(|message| message.part) {
                Some(artifact_download::Part::File(file)) if file.path == path => file,
                _ => bail!("artifact download did not include the selected file receipt"),
            };
            let blob = file
                .blob
                .as_ref()
                .filter(|value| {
                    valid_sha256(&value.sha256) && value.byte_length <= MAX_ARTIFACT_FILE_BYTES
                })
                .context("invalid artifact file receipt")?;
            publish_download(&output, blob, stream, |record| match record.part {
                Some(artifact_download::Part::Chunk(chunk)) => Some(chunk),
                _ => None,
            })
            .await?;
            return Ok(());
        }
    };
    println!("{value}");
    Ok(())
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

    publish_download(output, blob, stream, |record| match record.part {
        Some(workspace_download::Part::Chunk(chunk)) => Some(chunk),
        _ => None,
    })
    .await
}

async fn publish_download<M: 'static>(
    output: &Path,
    blob: &BlobReference,
    mut stream: tonic::Streaming<M>,
    chunk: impl Fn(M) -> Option<Vec<u8>>,
) -> Result<()> {
    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let staged = tempfile::NamedTempFile::new_in(parent).context("stage artifact download")?;
    let mut file = tokio::fs::File::from_std(staged.as_file().try_clone()?);
    let mut size = 0u64;
    let mut digest = Sha256::new();
    while let Some(message) = stream.message().await? {
        let Some(chunk) = chunk(message) else {
            bail!("unexpected artifact download record");
        };
        size += chunk.len() as u64;
        ensure!(
            !chunk.is_empty() && chunk.len() <= CHECKPOINT_CHUNK_BYTES && size <= blob.byte_length,
            "artifact chunk exceeds its receipt"
        );
        digest.update(&chunk);
        file.write_all(&chunk).await?;
    }
    ensure!(
        size == blob.byte_length && format!("{:x}", digest.finalize()) == blob.sha256,
        "artifact differs from its receipt"
    );
    file.flush().await?;
    file.sync_all().await?;
    drop(file);
    staged
        .persist_noclobber(output)
        .context("publish artifact download")?;
    tokio::fs::File::open(parent).await?.sync_all().await?;
    println!(
        "{}",
        json!({ "output": output, "sha256": blob.sha256, "byte_length": size })
    );
    Ok(())
}

fn describe_blob(value: &BlobReference) -> Value {
    json!({ "sha256": value.sha256, "byte_length": value.byte_length })
}

fn capture_summary(summary: &ArtifactSummary) -> Value {
    json!({
        "artifact_id": summary.artifact_id,
        "description": summary.description.as_ref().map(|value| json!({
            "title": value.title,
            "kind": value.kind,
            "summary": value.summary,
        })),
        "producer": summary.producer.as_ref().map(|value| json!({
            "task_id": value.task_id,
            "attempt_id": value.attempt_id,
            "tag_id": value.tag_id,
            "session_id": value.session_id,
            "objective_id": value.objective_id,
            "harness": value.harness_kind().as_str_name(),
            "native_session_id": value.native_session_id,
        })),
        "file_count": summary.file_count,
        "byte_length": summary.byte_length,
        "captured_at_ms": summary.captured_at_ms,
    })
}

pub fn describe(reference: &WorkspaceDeliveryReference) -> Value {
    json!({
        "workspace_id": reference.workspace_id,
        "delivery_id": reference.delivery_id,
        "base_commit": reference.base_commit,
        "start_commit": reference.start_commit,
        "head_commit": reference.head_commit,
        "committed": reference.committed,
        "changed_files": reference.changed_files,
        "patch": reference.patch.as_ref().map(describe_blob),
        "bundle": reference.bundle.as_ref().map(describe_blob),
    })
}
