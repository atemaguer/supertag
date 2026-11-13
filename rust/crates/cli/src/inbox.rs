use anyhow::Result;
use clap::{Args, Subcommand, ValueEnum};
use serde_json::{Value, json};
use supertag_protocol::{MAX_MESSAGE_BYTES, negotiation::ProtocolChannel, v2::*};
use uuid::Uuid;

use crate::{Connection, connect_operator, request};

#[derive(Clone, Copy, ValueEnum)]
pub enum Kind {
    Question,
    Budget,
    Limit,
    TaskAttention,
    Approval,
    McpLogin,
}

impl From<Kind> for InboxItemKind {
    fn from(kind: Kind) -> Self {
        match kind {
            Kind::Question => Self::Question,
            Kind::Budget => Self::ObjectiveBudget,
            Kind::Limit => Self::ObjectiveLimit,
            Kind::TaskAttention => Self::TaskAttention,
            Kind::Approval => Self::Approval,
            Kind::McpLogin => Self::McpLogin,
        }
    }
}

// Options for `supertag get inbox-items`.
#[derive(Args)]
pub struct ItemListArgs {
    /// Only items for this Objective.
    #[arg(long, default_value = "")]
    objective: String,
    /// Only items of this kind.
    #[arg(long)]
    kind: Option<Kind>,
    /// Most entries to return on one page.
    #[arg(long, default_value_t = 50)]
    limit: u32,
    /// Continue from the cursor the previous page returned.
    #[arg(long, default_value = "")]
    cursor: String,
}

// Options for `supertag get approvals`.
#[derive(Args)]
pub struct ApprovalListArgs {
    /// Only approvals for this Objective.
    #[arg(long, default_value = "", conflicts_with = "id")]
    objective: String,
    /// Only approvals requested by this Task.
    #[arg(long, default_value = "", conflicts_with = "id")]
    task: String,
    /// Only requests that still wait for a decision.
    #[arg(long, conflicts_with = "id")]
    pending: bool,
    /// Most entries to return on one page.
    #[arg(long, default_value_t = 20, conflicts_with = "id")]
    limit: u32,
    /// Continue from the cursor the previous page returned.
    #[arg(long, default_value = "", conflicts_with = "id")]
    cursor: String,
}

/// `supertag question VERB`.
#[derive(Subcommand)]
pub enum QuestionCommand {
    /// Answer an Objective question in the owner's Session.
    Answer {
        /// The Task that asked.
        task_id: String,
        text: String,
        /// Supply the same ID to retry an answer after a lost response.
        #[arg(long)]
        operation_id: Option<String>,
    },
}

/// `supertag approval VERB`.
#[derive(Subcommand)]
pub enum ApprovalCommand {
    /// Approve the exact requested action once or for its Objective.
    Approve {
        approval_id: String,
        /// Allow this Tag's Workstream posts to the same Team for this Objective.
        #[arg(long)]
        objective_scope: bool,
        /// End of the approval, in milliseconds since the Unix epoch. Omit for no end.
        #[arg(long)]
        valid_until_ms: Option<i64>,
        /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
        #[arg(long)]
        operation_id: Option<String>,
    },
    /// Deny a pending approval request.
    Deny {
        approval_id: String,
        /// Why the request is denied; the Tag sees this reason.
        #[arg(long)]
        reason: String,
        /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
        #[arg(long)]
        operation_id: Option<String>,
    },
}

fn client(channel: ProtocolChannel) -> inbox_client::InboxClient<ProtocolChannel> {
    inbox_client::InboxClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

/// The questions and work waiting for an operator.
pub(crate) async fn list_items(connection: Connection, args: ItemListArgs) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let page = client(channel)
        .list_items(request(
            ListInboxItemsRequest {
                objective_id: args.objective,
                kind: args
                    .kind
                    .map_or(InboxItemKind::Unspecified, Into::into)
                    .into(),
                page_size: args.limit,
                cursor: args.cursor,
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
    Ok(json!({
        "as_of_ms": page.as_of_ms,
        "items": page.items.into_iter().map(item_json).collect::<Vec<_>>(),
        "next_cursor": page.next_cursor,
        "truncated_kinds": truncated_kinds,
    }))
}

/// The full question an Objective Task asked.
pub(crate) async fn fetch_question(
    channel: ProtocolChannel,
    token: &str,
    task_id: String,
) -> Result<Value> {
    let question = client(channel)
        .get_question(request(GetQuestionRequest { task_id }, token)?)
        .await?
        .into_inner();
    Ok(json!({
        "task_id": question.task_id,
        "objective_id": question.objective_id,
        "attempt_id": question.attempt_id,
        "text": question.text,
        "asked_at_ms": question.asked_at_ms,
        "published_at_ms": question.published_at_ms,
        "answer_task_id": question.answer_task_id,
    }))
}

/// The action, resource, and exact arguments an approval request names.
pub(crate) async fn fetch_approval(
    channel: ProtocolChannel,
    token: &str,
    approval_id: String,
) -> Result<Value> {
    let approval = client(channel)
        .get_approval(request(GetApprovalRequest { approval_id }, token)?)
        .await?
        .into_inner();
    let arguments: Value = serde_json::from_str(&approval.canonical_arguments_json)?;
    let mut output = approval_json(approval);
    output["arguments"] = arguments;
    Ok(output)
}

/// Approval history, newest first.
pub(crate) async fn list_approvals(
    connection: Connection,
    args: ApprovalListArgs,
) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let state = if args.pending {
        ApprovalState::Pending
    } else {
        ApprovalState::Unspecified
    };
    let page = client(channel)
        .list_approvals(request(
            ListApprovalsRequest {
                objective_id: args.objective,
                task_id: args.task,
                state: state.into(),
                limit: args.limit,
                cursor: args.cursor,
            },
            &token,
        )?)
        .await?
        .into_inner();
    Ok(json!({
        "approvals": page.approvals.into_iter().map(approval_json).collect::<Vec<_>>(),
        "next_cursor": page.next_cursor,
    }))
}

pub async fn run_question(connection: Connection, command: QuestionCommand) -> Result<()> {
    let QuestionCommand::Answer {
        task_id,
        text,
        operation_id,
    } = command;
    let (channel, token) = connect_operator(connection).await?;
    let task = client(channel)
        .answer_question(request(
            AnswerQuestionRequest {
                task_id,
                text,
                operation_id: receipt_id(operation_id),
            },
            &token,
        )?)
        .await?
        .into_inner();
    crate::terminal::print_json(
        &json!({ "task_id": task.task_id, "tag_id": task.tag_id, "session_id": task.session_id }),
    )?;
    Ok(())
}

pub async fn run_approval(connection: Connection, command: ApprovalCommand) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let decision = match command {
        ApprovalCommand::Approve {
            approval_id,
            objective_scope,
            valid_until_ms,
            operation_id,
        } => DecideApprovalRequest {
            approval_id,
            operation_id: receipt_id(operation_id),
            approve: true,
            scope: if objective_scope {
                ApprovalScope::Objective
            } else {
                ApprovalScope::Once
            }
            .into(),
            valid_until_ms,
            reason: String::new(),
        },
        ApprovalCommand::Deny {
            approval_id,
            reason,
            operation_id,
        } => DecideApprovalRequest {
            approval_id,
            operation_id: receipt_id(operation_id),
            approve: false,
            reason,
            ..Default::default()
        },
    };
    let approval = client(channel)
        .decide_approval(request(decision, &token)?)
        .await?
        .into_inner();
    crate::terminal::print_json(&approval_json(approval))?;
    Ok(())
}

fn receipt_id(operation_id: Option<String>) -> String {
    operation_id.unwrap_or_else(|| Uuid::new_v4().to_string())
}

fn approval_json(approval: Approval) -> Value {
    json!({
        "approval_id": approval.approval_id,
        "task_id": approval.task_id,
        "attempt_id": approval.attempt_id,
        "tag_id": approval.tag_id,
        "session_id": approval.session_id,
        "objective_id": approval.objective_id,
        "action": approval.action,
        "resource": approval.resource,
        "arguments_digest": approval.arguments_digest,
        "summary": approval.summary,
        "operator_ids": approval.operator_ids,
        "state": approval.state().as_str_name().trim_start_matches("APPROVAL_STATE_").to_ascii_lowercase(),
        "scope": approval.scope().as_str_name().trim_start_matches("APPROVAL_SCOPE_").to_ascii_lowercase(),
        "requested_at_ms": approval.requested_at_ms,
        "decided_at_ms": approval.decided_at_ms,
        "decided_by": approval.decided_by,
        "reason": approval.reason,
        "valid_until_ms": approval.valid_until_ms,
        "consumed_at_ms": approval.consumed_at_ms,
        "continuation_task_id": approval.continuation_task_id,
        "grant_approval_id": approval.grant_approval_id,
        "covered_at_ms": approval.covered_at_ms,
    })
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
        "approval": item.approval.map(|approval| json!({
            "approval_id": approval.approval_id,
            "tag_id": approval.tag_id,
            "action": approval.action,
            "resource": approval.resource,
            "summary": approval.summary,
        })),
    })
}
