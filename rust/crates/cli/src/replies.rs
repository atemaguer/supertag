use anyhow::{Result, ensure};
use clap::{Subcommand, ValueEnum};
use serde_json::{Value, json};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use uuid::Uuid;

use crate::{Connection, connect_operator, request};

#[derive(Clone, Copy, ValueEnum)]
pub enum State {
    Pending,
    Claimed,
    Delivered,
    Failed,
    Uncertain,
}

impl From<State> for ReplyState {
    fn from(state: State) -> Self {
        match state {
            State::Pending => Self::Pending,
            State::Claimed => Self::Claimed,
            State::Delivered => Self::Delivered,
            State::Failed => Self::Failed,
            State::Uncertain => Self::Uncertain,
        }
    }
}

#[derive(Clone, Copy, ValueEnum)]
pub enum Decision {
    Delivered,
    Failed,
}

#[derive(Subcommand)]
pub enum ReplyCommand {
    /// List connector replies and their recorded delivery status.
    List {
        #[arg(long, default_value = "")]
        account: String,
        #[arg(long)]
        state: Option<State>,
        #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
        /// Continue with next_before_order from the previous page.
        #[arg(long, default_value_t = 0, value_parser = clap::value_parser!(i64).range(0..))]
        before_order: i64,
    },
    /// Read a reply, its delivery status, and its audit history.
    Get { reply_id: String },
    /// Record verified delivery or failure for an uncertain reply. This never resends it.
    Resolve {
        reply_id: String,
        #[arg(long)]
        decision: Decision,
        #[arg(long)]
        evidence: String,
        /// Required for a delivered decision; identifies the observed provider response.
        #[arg(long)]
        provider_receipt: Option<String>,
        /// Reuse this ID when retrying after a lost response.
        #[arg(long)]
        operation_id: Option<String>,
    },
}

pub async fn run(connection: Connection, command: ReplyCommand) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let mut client = operator_client::OperatorClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let output = match command {
        ReplyCommand::List {
            account,
            state,
            limit,
            before_order,
        } => {
            let page = client
                .list_reply_deliveries(request(
                    ListReplyDeliveriesRequest {
                        account_id: account,
                        state: state.map_or(ReplyState::Unspecified, Into::into).into(),
                        limit,
                        before_order,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            json!({"deliveries": page.deliveries.into_iter().map(describe).collect::<Vec<_>>(), "next_before_order": page.next_before_order})
        }
        ReplyCommand::Get { reply_id } => describe(
            client
                .get_reply_delivery(request(GetReplyDeliveryRequest { reply_id }, &token)?)
                .await?
                .into_inner(),
        ),
        ReplyCommand::Resolve {
            reply_id,
            decision,
            evidence,
            provider_receipt,
            operation_id,
        } => {
            ensure!(
                !evidence.trim().is_empty(),
                "resolution evidence must be nonempty"
            );
            ensure!(
                matches!(decision, Decision::Delivered) == provider_receipt.is_some(),
                "delivered requires a provider receipt; failed must omit it"
            );
            let state = match decision {
                Decision::Delivered => ReplyState::Delivered,
                Decision::Failed => ReplyState::Failed,
            };
            let operation_id = operation_id.unwrap_or_else(|| Uuid::new_v4().to_string());
            let mut value = describe(
                client
                    .resolve_reply(request(
                        ResolveReplyRequest {
                            reply_id,
                            operation_id: operation_id.clone(),
                            state: state.into(),
                            provider_receipt,
                            evidence,
                        },
                        &token,
                    )?)
                    .await?
                    .into_inner(),
            );
            value["operation_id"] = operation_id.into();
            value
        }
    };
    println!("{output}");
    Ok(())
}

fn describe(delivery: ReplyDelivery) -> Value {
    let reply = delivery.reply.unwrap_or_default();
    json!({
        "reply_id": reply.reply_id, "task_id": reply.task_id, "account_id": reply.account_id,
        "destination": reply.destination.as_ref().map(|destination| json!({"conversation_id": destination.conversation_id, "thread_id": destination.thread_id})),
        "text": reply.text, "state": reply.state().as_str_name(), "provider_receipt": reply.provider_receipt,
        "lease_expires_at_ms": delivery.lease_expires_at_ms,
        "audit": delivery.audit.into_iter().map(|entry| json!({"kind": entry.kind, "principal": entry.principal, "evidence": entry.evidence, "recorded_at_ms": entry.recorded_at_ms, "state": entry.state().as_str_name(), "provider_receipt": entry.provider_receipt})).collect::<Vec<_>>()
    })
}
