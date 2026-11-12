use anyhow::Result;
use clap::{Subcommand, ValueEnum};
use serde_json::{Value, json};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use uuid::Uuid;

use crate::{Connection, connect_operator, request};

#[derive(Clone, Copy, ValueEnum)]
pub enum Kind {
    Question,
    Budget,
    Limit,
    TaskAttention,
}

impl From<Kind> for InboxItemKind {
    fn from(kind: Kind) -> Self {
        match kind {
            Kind::Question => Self::Question,
            Kind::Budget => Self::ObjectiveBudget,
            Kind::Limit => Self::ObjectiveLimit,
            Kind::TaskAttention => Self::TaskAttention,
        }
    }
}

#[derive(Subcommand)]
pub enum InboxCommand {
    /// List questions and work waiting for an operator.
    List {
        #[arg(long, default_value = "")]
        objective: String,
        #[arg(long)]
        kind: Option<Kind>,
        #[arg(long, default_value_t = 50)]
        limit: u32,
        #[arg(long, default_value = "")]
        cursor: String,
    },
    /// Read the full question from an Objective Task.
    Question { task_id: String },
    /// Answer an Objective question in the owner's Session.
    Answer {
        task_id: String,
        text: String,
        /// Supply the same ID to retry an answer after a lost response.
        #[arg(long)]
        operation_id: Option<String>,
    },
}

pub async fn run(connection: Connection, command: InboxCommand) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let mut client = inbox_client::InboxClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let output = match command {
        InboxCommand::List {
            objective,
            kind,
            limit,
            cursor,
        } => {
            let page = client
                .list_items(request(
                    ListInboxItemsRequest {
                        objective_id: objective,
                        kind: kind.map_or(InboxItemKind::Unspecified, Into::into).into(),
                        page_size: limit,
                        cursor,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            let truncated_kinds = page
                .truncated_kinds
                .into_iter()
                .map(|kind| kind_name(InboxItemKind::try_from(kind).unwrap_or_default()))
                .collect::<Vec<_>>();
            json!({
                "as_of_ms": page.as_of_ms,
                "items": page.items.into_iter().map(item_json).collect::<Vec<_>>(),
                "next_cursor": page.next_cursor,
                "truncated_kinds": truncated_kinds,
            })
        }
        InboxCommand::Question { task_id } => {
            let question = client
                .get_question(request(GetQuestionRequest { task_id }, &token)?)
                .await?
                .into_inner();
            json!({
                "task_id": question.task_id,
                "objective_id": question.objective_id,
                "attempt_id": question.attempt_id,
                "text": question.text,
                "asked_at_ms": question.asked_at_ms,
                "published_at_ms": question.published_at_ms,
                "answer_task_id": question.answer_task_id,
            })
        }
        InboxCommand::Answer {
            task_id,
            text,
            operation_id,
        } => {
            let operation_id = operation_id.unwrap_or_else(|| Uuid::new_v4().to_string());
            let task = client
                .answer_question(request(
                    AnswerQuestionRequest {
                        task_id,
                        text,
                        operation_id,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            json!({ "task_id": task.task_id, "tag_id": task.tag_id, "session_id": task.session_id })
        }
    };
    println!("{output}");
    Ok(())
}

fn kind_name(kind: InboxItemKind) -> String {
    kind.as_str_name()
        .trim_start_matches("INBOX_ITEM_KIND_")
        .to_ascii_lowercase()
}

fn item_json(item: InboxItem) -> Value {
    let kind = kind_name(item.kind());
    json!({
        "key": item.key,
        "occurrence": item.occurrence,
        "kind": kind,
        "objective_id": item.objective_id,
        "task_id": item.task_id,
        "attempt_id": item.attempt_id,
        "operator_eligible": item.operator_eligible,
        "actionable_since_ms": item.actionable_since_ms,
        "reason": item.reason,
        "question": item.question.map(|question| json!({
            "text": question.text,
            "asked_at_ms": question.asked_at_ms,
            "truncated": question.truncated,
        })),
    })
}
