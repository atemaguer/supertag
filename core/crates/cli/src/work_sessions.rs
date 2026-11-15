use anyhow::Result;
use clap::Args;
use serde_json::{Value, json};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        GetWorkSessionRequest, ListWorkSessionsRequest, WorkSession,
        work_sessions_client::WorkSessionsClient,
    },
};

use crate::{Connection, connect_operator, request};

// Options for `supertag get sessions`: the Work Sessions started from a parent Session.
#[derive(Args)]
pub struct ListArgs {
    /// Tag that started the Work Sessions.
    #[arg(long, required_unless_present = "id", conflicts_with = "id")]
    parent_tag: Option<String>,
    /// Session that started the Work Sessions.
    #[arg(long, required_unless_present = "id", conflicts_with = "id")]
    parent_session: Option<String>,
    /// Only Work Sessions started by this Task.
    #[arg(long, conflicts_with = "id")]
    starter_task: Option<String>,
    /// Most entries to return on one page.
    #[arg(long, default_value_t = 32, value_parser = clap::value_parser!(u32).range(1..=100), conflicts_with = "id")]
    limit: u32,
    /// Continue from the cursor the previous page returned.
    #[arg(long, default_value = "", conflicts_with = "id")]
    cursor: String,
}

fn client(channel: ProtocolChannel) -> WorkSessionsClient<ProtocolChannel> {
    WorkSessionsClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

/// One Work Session, its latest Task, and its report; with `report_task`, the report of that
/// child Task.
pub(crate) async fn fetch(
    channel: ProtocolChannel,
    token: &str,
    work_session_id: String,
    report_task: Option<String>,
) -> Result<Value> {
    Ok(view(
        &client(channel)
            .get(request(
                GetWorkSessionRequest {
                    work_session_id,
                    report_task_id: report_task,
                },
                token,
            )?)
            .await?
            .into_inner(),
    ))
}

pub(crate) async fn list(connection: Connection, args: ListArgs) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let page = client(channel)
        .list(request(
            ListWorkSessionsRequest {
                parent_tag_id: args.parent_tag.unwrap_or_default(),
                parent_session_id: args.parent_session.unwrap_or_default(),
                starter_task_id: args.starter_task,
                limit: args.limit,
                cursor: args.cursor,
            },
            &token,
        )?)
        .await?
        .into_inner();
    Ok(json!({
        "work_sessions": page.work_sessions.iter().map(view).collect::<Vec<_>>(),
        "next_cursor": page.next_cursor,
    }))
}

pub(crate) fn view(session: &WorkSession) -> Value {
    json!({
        "work_session_id": session.work_session_id,
        "title": session.title,
        "parent_tag_id": session.parent_tag_id,
        "parent_session_id": session.parent_session_id,
        "starter_task_id": session.starter_task_id,
        "tag_id": session.tag_id,
        "latest_task_id": session.latest_task_id,
        "latest_task_state": session.latest_task_state().as_str_name(),
        "report_task_id": session.report_task_id,
        "report_task_state": session.report_task_state().as_str_name(),
        "objective_id": session.objective_id,
        "question": session.question.as_ref().map(|question| json!({
            "text": question.text,
            "task_id": question.task_id,
            "asked_at_ms": question.asked_at_ms,
            "published_at_ms": question.published_at_ms,
            "answer_task_id": question.answer_task_id,
        })),
        "workspace_delivery": session.workspace_delivery.as_ref().map(|delivery| json!({
            "workspace_id": delivery.workspace_id,
            "delivery_id": delivery.delivery_id,
            "base_commit": delivery.base_commit,
            "start_commit": delivery.start_commit,
            "head_commit": delivery.head_commit,
            "committed": delivery.committed,
            "changed_files": delivery.changed_files,
        })),
    })
}
