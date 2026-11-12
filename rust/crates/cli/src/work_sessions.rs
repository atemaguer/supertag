use anyhow::Result;
use clap::Subcommand;
use serde_json::{Value, json};
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        GetWorkSessionRequest, ListWorkSessionsRequest, WorkSession,
        work_sessions_client::WorkSessionsClient,
    },
};

use crate::{Connection, connect_operator, request};

#[derive(Subcommand)]
pub enum WorkSessionCommand {
    /// Show one Work Session, its latest Task, and its report.
    Get {
        work_session_id: String,
        /// Show the child Task associated with this report.
        #[arg(long)]
        report_task: Option<String>,
    },
    /// List the Work Sessions started from a parent Session.
    List {
        #[arg(long)]
        parent_tag: String,
        #[arg(long)]
        parent_session: String,
        #[arg(long)]
        starter_task: Option<String>,
        #[arg(long, default_value_t = 32, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
        #[arg(long, default_value = "")]
        cursor: String,
    },
}

pub async fn run(connection: Connection, command: WorkSessionCommand) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let mut client = WorkSessionsClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let output = match command {
        WorkSessionCommand::Get {
            work_session_id,
            report_task,
        } => view(
            &client
                .get(request(
                    GetWorkSessionRequest {
                        work_session_id,
                        report_task_id: report_task,
                    },
                    &token,
                )?)
                .await?
                .into_inner(),
        ),
        WorkSessionCommand::List {
            parent_tag,
            parent_session,
            starter_task,
            limit,
            cursor,
        } => {
            let page = client
                .list(request(
                    ListWorkSessionsRequest {
                        parent_tag_id: parent_tag,
                        parent_session_id: parent_session,
                        starter_task_id: starter_task,
                        limit,
                        cursor,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            json!({
                "work_sessions": page.work_sessions.iter().map(view).collect::<Vec<_>>(),
                "next_cursor": page.next_cursor,
            })
        }
    };
    println!("{}", serde_json::to_string(&output)?);
    Ok(())
}

fn view(session: &WorkSession) -> Value {
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
