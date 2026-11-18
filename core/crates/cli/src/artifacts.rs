use anyhow::Result;
use clap::Args;
use serde_json::{Value, json};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        ArtifactSummary, BlobReference, GetCapturedArtifactRequest, ListCapturedArtifactsRequest,
        WorkspaceDeliveryReference, artifact_catalog_client::ArtifactCatalogClient,
    },
};

use crate::{Connection, connect_operator, request};

// Options for `supertag get artifacts`: the artifacts captured by a Task.
#[derive(Args)]
pub struct ListArgs {
    /// Task whose artifacts to list.
    #[arg(long, required_unless_present = "id", conflicts_with = "id")]
    task: Option<String>,
    /// Most entries to return on one page.
    #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=100), conflicts_with = "id")]
    limit: u32,
    /// Continue from the next_before_order the previous page returned.
    #[arg(long, default_value_t = 0, conflicts_with = "id")]
    before_order: u64,
}

fn catalog(channel: ProtocolChannel) -> ArtifactCatalogClient<ProtocolChannel> {
    ArtifactCatalogClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

pub(crate) async fn list(connection: Connection, args: ListArgs) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let page = catalog(channel)
        .list(request(
            ListCapturedArtifactsRequest {
                task_id: args.task.unwrap_or_default(),
                limit: args.limit,
                before_order: args.before_order,
            },
            &token,
        )?)
        .await?
        .into_inner();
    Ok(json!({
        "artifacts": page.artifacts.iter().map(capture_summary).collect::<Vec<_>>(),
        "next_before_order": page.next_before_order,
    }))
}

/// An artifact's provenance and exact file manifest.
pub(crate) async fn fetch(
    channel: ProtocolChannel,
    token: &str,
    artifact_id: String,
) -> Result<Value> {
    let capture = catalog(channel)
        .get(request(GetCapturedArtifactRequest { artifact_id }, token)?)
        .await?
        .into_inner();
    Ok(json!({
        "summary": capture.summary.as_ref().map(capture_summary),
        "inputs": capture.inputs.iter().map(|input| json!({"artifact_id":input.artifact_id,"paths":input.paths})).collect::<Vec<_>>(),
        "files": capture.files.iter().map(|file| json!({
            "path": file.path,
            "blob": file.blob.as_ref().map(describe_blob),
        })).collect::<Vec<_>>(),
    }))
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
