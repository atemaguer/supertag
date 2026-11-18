//! The Memory rows of `get`, `describe`, and `delete`. A Tag keeps a few short notes with its
//! `remember` and `forget` tools; people read them here and delete any, and tell the Tag to change
//! them.
use anyhow::Result;
use clap::Args;
use serde_json::{Value, json};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        GetMemoryRequest, GetTagRequest, ListMemoriesRequest, Memory, NativeMemoryStore,
        ResetNativeMemoryRequest, memories_client::MemoriesClient, operator_client::OperatorClient,
    },
};

use crate::{Connection, connect_operator, request};

/// Options for `supertag get memories`.
#[derive(Args)]
pub struct ListArgs {
    /// Only this Tag's notes.
    #[arg(long, conflicts_with = "id")]
    tag: Option<String>,
}

/// Options for `supertag delete memory`.
#[derive(Args)]
pub struct DeleteArgs {
    /// Instead of a note, drop this Tag's harness-native memory (such as Claude Code's
    /// auto-memory), which Worker Hosts keep: each host deletes its copies before it next runs
    /// one of the Tag's Tasks. Operators only.
    #[arg(long, value_name = "TAG")]
    pub(crate) native: Option<String>,
    /// Check that the note exists and show what would be deleted, without deleting it.
    #[arg(long)]
    pub(crate) dry_run: bool,
}

fn client(channel: ProtocolChannel) -> MemoriesClient<ProtocolChannel> {
    MemoriesClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

pub(crate) async fn fetch(
    channel: ProtocolChannel,
    token: &str,
    memory_id: String,
) -> Result<Value> {
    Ok(memory_json(
        &client(channel)
            .get(request(GetMemoryRequest { memory_id }, token)?)
            .await?
            .into_inner(),
    ))
}

pub(crate) async fn list(connection: Connection, args: ListArgs) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let listed = client(channel)
        .list(request(ListMemoriesRequest { tag_id: args.tag }, &token)?)
        .await?
        .into_inner();
    Ok(json!({
        "memories": listed.memories.iter().map(memory_json).collect::<Vec<_>>(),
    }))
}

/// Deletes a note at once, or with `--native`, a Tag's harness-native memory.
pub(crate) async fn delete(
    connection: Connection,
    id: Option<String>,
    args: DeleteArgs,
) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    if let Some(tag_id) = args.native {
        if args.dry_run {
            let tag = OperatorClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .get_tag(request(GetTagRequest { tag_id }, &token)?)
                .await?
                .into_inner();
            return Ok(json!({
                "tag_id": tag.tag_id,
                "native_memory": tag.native_memory.iter().map(native_store_json).collect::<Vec<_>>(),
            }));
        }
        let reset = client(channel)
            .reset_native(request(
                ResetNativeMemoryRequest {
                    tag_id: tag_id.clone(),
                },
                &token,
            )?)
            .await?
            .into_inner();
        return Ok(json!({
            "tag_id": tag_id,
            "native_memory": reset.stores.iter().map(native_store_json).collect::<Vec<_>>(),
            "reset_generation": reset.reset_generation,
        }));
    }
    let id = id.ok_or_else(|| anyhow::anyhow!("name a note ID, or --native TAG"))?;
    let mut client = client(channel);
    let memory = if args.dry_run {
        client
            .get(request(GetMemoryRequest { memory_id: id }, &token)?)
            .await?
    } else {
        client
            .delete(request(GetMemoryRequest { memory_id: id }, &token)?)
            .await?
    };
    Ok(memory_json(&memory.into_inner()))
}

fn at(ms: i64) -> Value {
    chrono::DateTime::from_timestamp_millis(ms).map_or(Value::Null, |time| {
        json!(time.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
    })
}

fn memory_json(memory: &Memory) -> Value {
    json!({
        "memory_id": memory.memory_id,
        "tag_id": memory.tag_id,
        "text": memory.text,
        "shared": memory.audience.is_none(),
        "audience": memory.audience,
        "state": memory.state().as_str_name(),
        "created_by": memory.created_by,
        "source_task_id": memory.source_task_id,
        "created_at": at(memory.created_at_ms),
        "updated_at": at(memory.updated_at_ms),
        // When a turn last had it in its context; null until one has.
        "last_seen_at": memory.last_seen_at_ms.map_or(Value::Null, at),
    })
}

/// One Worker Host's copy of a Tag's harness-native memory.
pub(crate) fn native_store_json(store: &NativeMemoryStore) -> Value {
    json!({
        "harness": store.harness,
        "shared": store.audience.is_none(),
        "audience": store.audience,
        "host_id": store.host_id,
        "revision": store.revision,
        "files": store.files,
        "bytes": store.bytes,
        "digest": store.digest,
        "updated_at": at(store.updated_at_ms),
        "task_id": store.task_id,
    })
}
