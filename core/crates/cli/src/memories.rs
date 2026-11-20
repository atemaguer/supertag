//! The Memory rows of `get`, `describe`, and `delete`: a Tag's notes, which it keeps with its
//! `remember` and `forget` tools in the Control Plane, and its harness memory, the files its
//! harness keeps itself (such as Claude Code's auto-memory), which a Worker Host keeps. People
//! read both here and delete any, and tell the Tag to change them.
//!
//! Harness memory never passes through the Control Plane: these commands read it from the
//! memory endpoint of each Worker Host `supertag up` runs on this machine, a socket in the
//! host's state directory. The Control Plane says only who each store is for and which hosts
//! hold one.
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

use anyhow::{Result, bail};
use clap::Args;
use serde_json::{Value, json};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        GetMemoryRequest, GetTagRequest, ListMemoriesRequest, Memory, NativeMemoryStore,
        ResetNativeMemoryRequest, Tag, memories_client::MemoriesClient,
        operator_client::OperatorClient,
    },
};
use supertag_worker_host::memory::{self as native, Record, Reply, Request};

use crate::{Connection, connect_operator, request};

/// Options for `supertag get memories`.
#[derive(Args)]
pub struct ListArgs {
    /// Only this Tag's notes and harness memory.
    #[arg(long, conflicts_with = "id")]
    tag: Option<String>,
    /// Only harness memory: the files a Tag's harness keeps itself, as the Worker Hosts on this
    /// machine keep them. Without it, notes too.
    #[arg(long, conflicts_with = "id")]
    native: bool,
}

/// Options for `supertag delete memory`.
#[derive(Args)]
pub struct DeleteArgs {
    /// Instead of one memory, drop all of this Tag's harness memory (such as Claude Code's
    /// auto-memory): each Worker Host deletes its copies before it next runs one of the Tag's
    /// Tasks, and those on this machine at once. Operators only.
    #[arg(long, value_name = "TAG")]
    pub(crate) native: Option<String>,
    /// Check that the memory exists and show what would be deleted, without deleting it.
    #[arg(long)]
    pub(crate) dry_run: bool,
}

/// Whether `id` names a harness memory rather than a note.
pub(crate) fn is_native(id: &str) -> bool {
    id.starts_with(native::ID_PREFIX)
}

fn client(channel: ProtocolChannel) -> MemoriesClient<ProtocolChannel> {
    MemoriesClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

fn operator(channel: ProtocolChannel) -> OperatorClient<ProtocolChannel> {
    OperatorClient::new(channel)
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

/// A Worker Host `supertag up` runs on this machine, and its memory endpoint.
struct LocalHost {
    host_id: Option<String>,
    socket: PathBuf,
}

/// The Worker Hosts the local services in `state` run whose memory endpoint is listening.
fn local_hosts(state: Option<&Path>) -> Result<Vec<LocalHost>> {
    let Some(state) = state else {
        return Ok(vec![]);
    };
    let crate::lifecycle::Supervisor::Running(status) = crate::lifecycle::inspect(state)? else {
        return Ok(vec![]);
    };
    Ok(status
        .services
        .into_iter()
        .filter(|service| service.kind == crate::lifecycle::HOST)
        .filter_map(|service| {
            let socket = service.state_directory?.join(native::SOCKET);
            socket.exists().then_some(LocalHost {
                host_id: service.host_id,
                socket,
            })
        })
        .collect())
}

/// Why a command finds no harness memory on this machine, when it can't look.
fn no_local_hosts(state: Option<&Path>) -> String {
    match state {
        None => "Harness memory is kept by the Worker Host that ran the Tag's turns and is read only on that machine; this command reaches a shared Gateway, so it lists none.".into(),
        Some(state) => format!(
            "No Worker Host runs from {}, so no harness memory is listed; it is read only on the machine whose Worker Host keeps it.",
            state.display()
        ),
    }
}

/// Who each of a Tag's stores is for, as the Control Plane recorded it, by harness and scope.
type Audiences = BTreeMap<(String, String, String), Option<String>>;

fn audiences_of(tag: &Tag, audiences: &mut Audiences) {
    for store in &tag.native_memory {
        audiences.insert(
            (
                tag.tag_id.clone(),
                store.harness.clone(),
                supertag_protocol::native_memory_scope(store.audience.as_deref()),
            ),
            store.audience.clone(),
        );
    }
}

async fn get_tag(channel: &ProtocolChannel, token: &str, tag_id: String) -> Result<Tag> {
    Ok(operator(channel.clone())
        .get_tag(request(GetTagRequest { tag_id }, token)?)
        .await?
        .into_inner())
}

/// Who each store of the records' Tags is for. A Tag the Control Plane no longer has leaves its
/// records without a person.
async fn audiences(channel: &ProtocolChannel, token: &str, records: &[Record]) -> Audiences {
    let mut audiences = Audiences::new();
    let tags: BTreeSet<&str> = records
        .iter()
        .map(|record| record.tag_id.as_str())
        .collect();
    for tag in tags {
        if let Ok(tag) = get_tag(channel, token, tag.to_owned()).await {
            audiences_of(&tag, &mut audiences);
        }
    }
    audiences
}

fn native_json(record: &Record, host: Option<&str>, audiences: &Audiences) -> Value {
    let audience = audiences
        .get(&(
            record.tag_id.clone(),
            record.harness.clone(),
            record.scope.clone(),
        ))
        .cloned()
        .flatten();
    json!({
        "memory_id": record.memory_id,
        "tag_id": record.tag_id,
        "harness": record.harness,
        "shared": record.scope == "shared",
        "audience": audience,
        "scope": record.scope,
        "kind": record.kind,
        "title": record.title,
        "hook": record.hook,
        "text": record.text,
        "truncated": record.truncated,
        // Whether the turn that last changed it may write the Tag's memory; null when unknown.
        "trust": record.trust,
        "status": record.status,
        "source": {
            "host_id": host,
            "native_id": record.native_id,
            "path": record.path,
            "revision": record.revision,
        },
        "source_task_id": record.provenance.as_ref().map(|turn| &turn.task_id),
        "source_session_id": record.provenance.as_ref().map(|turn| &turn.session_id),
        "content_hash": record.content_hash,
        "created_at": at(record.created_at_ms),
        "updated_at": at(record.updated_at_ms),
    })
}

/// The harness memory of `tag`, or every Tag, on this machine's Worker Hosts: the records, with
/// what the reader should know when some are kept elsewhere or none can be read here.
async fn list_native(
    (channel, token): (&ProtocolChannel, &str),
    state: Option<&Path>,
    tag: Option<&Tag>,
) -> Result<serde_json::Map<String, Value>> {
    let hosts = local_hosts(state)?;
    let mut found = vec![];
    for host in &hosts {
        let reply = native::call(
            &host.socket,
            &Request::List {
                tag_id: tag.map(|tag| tag.tag_id.clone()),
                viewer: None,
            },
        )
        .await?;
        let Reply::Memories { memories } = reply else {
            bail!("the memory endpoint answered a list with something else");
        };
        found.extend(
            memories
                .into_iter()
                .map(|record| (host.host_id.clone(), record)),
        );
    }
    found.sort_by(|(_, a), (_, b)| b.updated_at_ms.cmp(&a.updated_at_ms));
    let records: Vec<Record> = found.iter().map(|(_, record)| record.clone()).collect();
    let mut audiences = audiences(channel, token, &records).await;
    if let Some(tag) = tag {
        audiences_of(tag, &mut audiences);
    }
    let mut out = serde_json::Map::new();
    out.insert(
        "native_memory".into(),
        found
            .iter()
            .map(|(host, record)| native_json(record, host.as_deref(), &audiences))
            .collect(),
    );
    if hosts.is_empty() {
        out.insert(
            "native_memory_unavailable".into(),
            no_local_hosts(state).into(),
        );
    }
    // The hosts the Control Plane says hold some of the Tag's memory that don't run here.
    if let Some(tag) = tag {
        let here: BTreeSet<&str> = hosts
            .iter()
            .filter_map(|host| host.host_id.as_deref())
            .collect();
        let elsewhere: BTreeSet<&str> = tag
            .native_memory
            .iter()
            .map(|store| store.host_id.as_str())
            .filter(|host| !host.is_empty() && !here.contains(host))
            .collect();
        if !elsewhere.is_empty() {
            out.insert("native_memory_kept_on".into(), json!(elsewhere));
        }
    }
    Ok(out)
}

pub(crate) async fn list(connection: Connection, args: ListArgs) -> Result<Value> {
    let state = crate::local_state_of(&connection)?;
    let (channel, token) = connect_operator(connection).await?;
    let tag = match &args.tag {
        Some(tag) => Some(get_tag(&channel, &token, tag.clone()).await?),
        None => None,
    };
    let mut out = list_native((&channel, &token), state.as_deref(), tag.as_ref()).await?;
    if !args.native {
        let listed = client(channel)
            .list(request(
                ListMemoriesRequest {
                    tag_id: tag.map(|tag| tag.tag_id),
                },
                &token,
            )?)
            .await?
            .into_inner();
        out.insert(
            "memories".into(),
            listed.memories.iter().map(memory_json).collect(),
        );
    }
    Ok(Value::Object(out))
}

/// Calls each local Worker Host's memory endpoint about one memory until one has it.
async fn on_local_host(
    state: Option<&Path>,
    memory_id: &str,
    call: impl Fn(String) -> Request,
) -> Result<(Option<String>, Record)> {
    let hosts = local_hosts(state)?;
    if hosts.is_empty() {
        bail!("{}", no_local_hosts(state));
    }
    let mut missing = None;
    for host in hosts {
        match native::call(&host.socket, &call(memory_id.to_owned())).await {
            Ok(Reply::Memory { memory }) => return Ok((host.host_id, *memory)),
            Ok(_) => bail!("the memory endpoint answered with something else"),
            Err(error) => missing = Some(error),
        }
    }
    Err(missing.expect("at least one host was asked"))
}

/// `get memory hmem_…` and `describe memory hmem_…`: one harness memory from this machine.
pub(crate) async fn fetch_native(connection: Connection, memory_id: String) -> Result<Value> {
    let state = crate::local_state_of(&connection)?;
    let (host, record) = on_local_host(state.as_deref(), &memory_id, |memory_id| Request::Get {
        memory_id,
        tag_id: None,
        viewer: None,
    })
    .await?;
    let (channel, token) = connect_operator(connection).await?;
    let audiences = audiences(&channel, &token, std::slice::from_ref(&record)).await;
    Ok(native_json(&record, host.as_deref(), &audiences))
}

/// Deletes a note or a harness memory at once, or with `--native`, all of a Tag's harness memory.
pub(crate) async fn delete(
    connection: Connection,
    id: Option<String>,
    args: DeleteArgs,
) -> Result<Value> {
    let state = crate::local_state_of(&connection)?;
    if let Some(id) = id.as_ref().filter(|id| is_native(id)) {
        let dry_run = args.dry_run;
        let (host, record) = on_local_host(state.as_deref(), id, |memory_id| Request::Delete {
            memory_id,
            tag_id: None,
            viewer: None,
            dry_run,
        })
        .await?;
        let (channel, token) = connect_operator(connection).await?;
        let audiences = audiences(&channel, &token, std::slice::from_ref(&record)).await;
        return Ok(native_json(&record, host.as_deref(), &audiences));
    }
    let (channel, token) = connect_operator(connection).await?;
    if let Some(tag_id) = args.native {
        let tag = get_tag(&channel, &token, tag_id).await?;
        if args.dry_run {
            return Ok(json!({
                "tag_id": tag.tag_id,
                "native_memory": tag.native_memory.iter().map(native_store_json).collect::<Vec<_>>(),
            }));
        }
        let reset = client(channel)
            .reset_native(request(
                ResetNativeMemoryRequest {
                    tag_id: tag.tag_id.clone(),
                },
                &token,
            )?)
            .await?
            .into_inner();
        // The hosts on this machine drop their copies now rather than before the Tag's next turn,
        // so the memory no longer shows here either.
        for host in local_hosts(state.as_deref())? {
            let reset = native::call(
                &host.socket,
                &Request::Reset {
                    tag_id: tag.tag_id.clone(),
                    generation: reset.reset_generation,
                },
            )
            .await;
            if let Err(error) = reset {
                supertag_protocol::terminal_text::warn(&format!(
                    "Worker Host {} keeps its copy until the Tag's next turn there: {error:#}",
                    host.host_id.as_deref().unwrap_or("on this machine")
                ));
            }
        }
        return Ok(json!({
            "tag_id": tag.tag_id,
            "native_memory": reset.stores.iter().map(native_store_json).collect::<Vec<_>>(),
            "reset_generation": reset.reset_generation,
        }));
    }
    let id = id.ok_or_else(|| anyhow::anyhow!("name a memory ID, or --native TAG"))?;
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
        // A host's own copy names the host; the store on the Tag's Volume names the Volume.
        "host_id": (!store.host_id.is_empty()).then_some(&store.host_id),
        "volume_id": (!store.volume_id.is_empty()).then_some(&store.volume_id),
        "revision": store.revision,
        "files": store.files,
        "bytes": store.bytes,
        "digest": store.digest,
        "updated_at": at(store.updated_at_ms),
        "task_id": store.task_id,
    })
}
