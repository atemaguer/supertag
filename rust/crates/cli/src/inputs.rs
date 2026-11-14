use anyhow::Result;
use clap::{Subcommand, ValueEnum};
use serde_json::{Value, json};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        GetInputRequest, LiveInput, LiveInputDecision, QueueInputRequest, ResolveInputRequest,
        live_inputs_client::LiveInputsClient,
    },
};
use uuid::Uuid;

use crate::{Connection, connect_operator, request};

#[derive(Subcommand)]
pub enum InputCommand {
    /// Record a decision and evidence for a message whose delivery is uncertain.
    Resolve {
        input_id: String,
        #[arg(value_enum)]
        decision: Decision,
        /// What you checked that shows whether the message arrived.
        #[arg(long)]
        evidence: String,
        /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
        #[arg(long)]
        operation_id: Option<String>,
    },
}

#[derive(Clone, Copy, ValueEnum)]
pub enum Decision {
    Fail,
    Retry,
}

fn client(channel: ProtocolChannel) -> LiveInputsClient<ProtocolChannel> {
    LiveInputsClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

pub async fn run(connection: Connection, command: InputCommand) -> Result<()> {
    let InputCommand::Resolve {
        input_id,
        decision,
        evidence,
        operation_id,
    } = command;
    let (channel, token) = connect_operator(connection).await?;
    let decision = match decision {
        Decision::Fail => LiveInputDecision::Fail,
        Decision::Retry => LiveInputDecision::Retry,
    };
    let input = client(channel)
        .resolve_input(request(
            ResolveInputRequest {
                input_id,
                decision: decision.into(),
                evidence,
                operation_id: operation_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
            },
            &token,
        )?)
        .await?
        .into_inner();
    crate::terminal::print_json(&input_json(&input))?;
    Ok(())
}

/// Sends a message to a running Task, with a queued fallback if it cannot take it.
pub(crate) async fn queue(
    connection: Connection,
    task_id: String,
    text: String,
    operation_id: Option<String>,
) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let input = client(channel)
        .queue_input(request(
            QueueInputRequest {
                task_id,
                text,
                operation_id: operation_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
            },
            &token,
        )?)
        .await?
        .into_inner();
    crate::terminal::print_json(&input_json(&input))?;
    Ok(())
}

/// The delivery status and fallback Task of a message.
pub(crate) async fn fetch(
    channel: ProtocolChannel,
    token: &str,
    input_id: String,
) -> Result<Value> {
    Ok(input_json(
        &client(channel)
            .get_input(request(GetInputRequest { input_id }, token)?)
            .await?
            .into_inner(),
    ))
}

fn input_json(input: &LiveInput) -> Value {
    json!({
        "input_id": input.input_id,
        "task_id": input.task_id,
        "attempt_id": input.attempt_id,
        "follower_task_id": input.follower_task_id,
        "text": input.text,
        "state": input.state().as_str_name(),
        "order": input.order,
    })
}
