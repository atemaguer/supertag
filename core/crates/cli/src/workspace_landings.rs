//! `supertag get landings`: where each Session's changes landed on its Workspace's remote,
//! separately from the Task's own result.
use anyhow::Result;
use clap::Args;
use serde_json::{Value, json};
use supertag_protocol::{MAX_MESSAGE_BYTES, negotiation::ProtocolChannel, v2::*};

use crate::{Connection, connect_operator, request};

// Options for `supertag get landings`.
#[derive(Args)]
pub struct ListArgs {
    /// Only landings of this Task's delivery.
    #[arg(long, default_value = "", conflicts_with = "id")]
    task_id: String,
    /// Only landings of this Session.
    #[arg(long, default_value = "", conflicts_with = "id")]
    session_id: String,
    /// Most entries to return on one page.
    #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=100), conflicts_with = "id")]
    limit: u32,
    /// Continue from the next_before_order the previous page returned.
    #[arg(long, default_value_t = 0, value_parser = clap::value_parser!(i64).range(0..), conflicts_with = "id")]
    before_order: i64,
}

fn client(
    channel: ProtocolChannel,
) -> workspace_landings_client::WorkspaceLandingsClient<ProtocolChannel> {
    workspace_landings_client::WorkspaceLandingsClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

pub(crate) async fn fetch(
    channel: ProtocolChannel,
    token: &str,
    landing_id: String,
) -> Result<Value> {
    Ok(describe(
        client(channel)
            .get(request(GetWorkspaceLandingRequest { landing_id }, token)?)
            .await?
            .into_inner(),
    ))
}

pub(crate) async fn list(connection: Connection, args: ListArgs) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let page = client(channel)
        .list(request(
            ListWorkspaceLandingsRequest {
                task_id: args.task_id,
                session_id: args.session_id,
                limit: args.limit,
                before_order: args.before_order,
            },
            &token,
        )?)
        .await?
        .into_inner();
    Ok(json!({
        "landings": page.landings.into_iter().map(describe).collect::<Vec<_>>(),
        "next_before_order": page.next_before_order,
    }))
}

fn name(value: &str, prefix: &str) -> String {
    value.trim_start_matches(prefix).to_ascii_lowercase()
}

fn describe(value: WorkspaceLanding) -> Value {
    json!({
        "landing_id": value.landing_id,
        "task_id": value.task_id,
        "tag_id": value.tag_id,
        "session_id": value.session_id,
        "workspace_id": value.workspace_id,
        "remote": value.remote,
        "mode": name(value.mode().as_str_name(), "WORKSPACE_LANDING_MODE_"),
        "branch": value.branch,
        "target": value.target,
        "head_commit": value.delivery.as_ref().map(|delivery| &delivery.head_commit),
        "state": name(value.state().as_str_name(), "WORKSPACE_LANDING_STATE_"),
        "reason": value.reason,
        "landed_commit": value.landed_commit,
        "target_commit": value.target_commit,
        "conflicts": value.conflicts,
        "follow_up_task_id": value.follow_up_task_id,
        "created_order": value.created_order,
    })
}
