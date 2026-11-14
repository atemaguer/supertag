//! `supertag task submit|cancel|events|usage|input|resolve-attempt|download`, and the Task read
//! behind `supertag get task`.

use std::path::PathBuf;

use anyhow::Result;
use clap::{Subcommand, ValueEnum};
use serde_json::{Value, json};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        AttemptDecision, CancelTaskRequest, ExecutionLimits, GetTaskRequest, ListEventsRequest,
        ListNativeUsageRequest, ReportedCostLimit, ResolveAttemptRequest, SubmitTaskRequest,
        operator_client::OperatorClient,
    },
};
use uuid::Uuid;

use crate::{Connection, artifacts, print_task, request, task_json};

#[derive(Clone, Copy, ValueEnum)]
pub enum RecoveryDecision {
    Failed,
    Retry,
}

#[derive(Subcommand)]
pub enum TaskCommand {
    /// Accept one turn of work in a Tag's Session.
    Submit {
        /// Tag that does the work.
        #[arg(long)]
        tag: String,
        /// Session that the turn belongs to; a new name starts a new Session.
        #[arg(long)]
        session: String,
        /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
        #[arg(long)]
        operation_id: Option<String>,
        /// Stop the turn when its reported token count reaches this limit.
        #[arg(long)]
        max_reported_tokens: Option<u64>,
        /// Apply a provider-reported spending limit in minor currency units.
        #[arg(long, requires = "reported_cost_currency")]
        max_reported_cost_minor: Option<u64>,
        /// Three-letter currency for the reported cost limit.
        #[arg(long, requires = "max_reported_cost_minor")]
        reported_cost_currency: Option<String>,
        /// Limit native agents and Work Sessions started by this turn.
        #[arg(long)]
        max_native_agents: Option<u64>,
        /// Read declared output requirements from a JSON file.
        #[arg(long)]
        outputs: Option<PathBuf>,
        /// Include one submitted artifact file from the same Objective. Repeat for more files.
        #[arg(long = "artifact-input", value_name = "ARTIFACT_ID:PATH")]
        artifact_inputs: Vec<String>,
        /// Bind selected artifact inputs to this explicit publication approval.
        #[arg(long, requires = "artifact_inputs")]
        artifact_publication: Option<String>,
        prompt: String,
    },
    /// Cancel a Task.
    Cancel { task_id: String },
    /// Read a page of recorded Task events.
    Events {
        task_id: String,
        /// Only entries after this sequence number.
        #[arg(long, default_value_t = 0)]
        after: u64,
    },
    /// Read native token usage recorded for a Task Attempt.
    Usage {
        task_id: String,
        attempt_id: String,
        /// Only entries after this sequence number.
        #[arg(long, default_value_t = 0)]
        after: u64,
    },
    /// Send a message to a running Task, with a queued fallback if it cannot take it.
    Input {
        task_id: String,
        text: String,
        /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
        #[arg(long)]
        operation_id: Option<String>,
    },
    /// Record an audited decision for a stopped, uncertain Task Attempt.
    ResolveAttempt {
        task_id: String,
        attempt_id: String,
        /// Mark the Attempt failed, or run the Task again.
        #[arg(long, value_enum)]
        decision: RecoveryDecision,
        /// What you checked that shows the Attempt stopped and what it did.
        #[arg(long)]
        evidence: String,
        /// Confirm that no process of this Attempt is still running.
        #[arg(long)]
        confirmed_stopped: bool,
        /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
        #[arg(long)]
        operation_id: Option<String>,
    },
    /// Download the patch or Git bundle published by a successful workspace Task.
    Download {
        task_id: String,
        /// Which published result to download.
        #[arg(long, value_enum)]
        kind: artifacts::ArtifactKind,
        /// Local file to create with the download. It must not already exist.
        #[arg(long)]
        output: PathBuf,
    },
}

fn client(channel: ProtocolChannel) -> OperatorClient<ProtocolChannel> {
    OperatorClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

pub async fn run(connection: Connection, command: TaskCommand) -> Result<()> {
    match command {
        TaskCommand::Input {
            task_id,
            text,
            operation_id,
        } => crate::inputs::queue(connection, task_id, text, operation_id).await?,
        TaskCommand::Download {
            task_id,
            kind,
            output,
        } => artifacts::download(connection, task_id, kind, &output).await?,
        TaskCommand::Submit {
            tag,
            session,
            operation_id,
            max_reported_tokens,
            max_reported_cost_minor,
            reported_cost_currency,
            max_native_agents,
            outputs,
            artifact_inputs,
            artifact_publication,
            prompt,
        } => {
            let (mut operator, token) = crate::operator(connection).await?;
            let max_reported_cost = max_reported_cost_minor.zip(reported_cost_currency).map(
                |(amount_minor, currency)| ReportedCostLimit {
                    amount_minor,
                    currency,
                },
            );
            let execution_limits = (max_reported_tokens.is_some()
                || max_reported_cost.is_some()
                || max_native_agents.is_some())
            .then_some(ExecutionLimits {
                max_reported_tokens,
                max_reported_cost,
                max_native_agents,
            });
            let output_policy = outputs
                .as_deref()
                .map(crate::output_policy::read)
                .transpose()?;
            let input_artifacts =
                crate::task_artifact_inputs::parse(artifact_inputs, artifact_publication)?;
            let task = operator
                .submit_task(request(
                    SubmitTaskRequest {
                        tag_id: tag,
                        session_id: session,
                        prompt,
                        operation_id: operation_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
                        execution_limits,
                        output_policy,
                        input_artifacts,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            print_task(&task)?;
        }
        TaskCommand::Cancel { task_id } => {
            let (mut operator, token) = crate::operator(connection).await?;
            let task = operator
                .cancel_task(request(CancelTaskRequest { task_id }, &token)?)
                .await?
                .into_inner();
            print_task(&task)?;
        }
        TaskCommand::Events { task_id, after } => {
            let (mut operator, token) = crate::operator(connection).await?;
            let events = operator
                .list_events(request(
                    ListEventsRequest {
                        task_id,
                        after_sequence: after,
                        limit: 100,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            for event in events.events {
                crate::terminal::print_json(
                    &json!({ "sequence": event.sequence, "text": event.text }),
                )?;
            }
        }
        TaskCommand::Usage {
            task_id,
            attempt_id,
            after,
        } => {
            let (mut operator, token) = crate::operator(connection).await?;
            let response = operator
                .list_native_usage(request(
                    ListNativeUsageRequest {
                        task_id,
                        attempt_id,
                        after_sequence: after,
                        limit: 100,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            for report in response.reports {
                if let Some(usage) = report.native_usage {
                    crate::terminal::print_json(&json!({
                        "sequence": report.sequence,
                        "input_tokens": usage.input_tokens,
                        "cached_input_tokens": usage.cached_input_tokens,
                        "output_tokens": usage.output_tokens,
                        "total_tokens": usage.total_tokens,
                        "observed_model": usage.observed_model,
                        "reported_cost": report.amount_minor.zip(report.currency).map(|(amount_minor, currency)| json!({
                            "amount_minor": amount_minor, "currency": currency, "estimated": report.estimated,
                        })),
                    }))?;
                }
            }
        }
        TaskCommand::ResolveAttempt {
            task_id,
            attempt_id,
            decision,
            evidence,
            confirmed_stopped,
            operation_id,
        } => {
            let (mut operator, token) = crate::operator(connection).await?;
            let decision = match decision {
                RecoveryDecision::Failed => AttemptDecision::Failed,
                RecoveryDecision::Retry => AttemptDecision::Retry,
            };
            let resolution = operator
                .resolve_attempt(request(
                    ResolveAttemptRequest {
                        task_id,
                        attempt_id,
                        decision: decision as i32,
                        evidence,
                        confirmed_stopped,
                        operation_id: operation_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            crate::terminal::print_json(&json!({
                "task_id": resolution.task_id, "attempt_id": resolution.attempt_id,
                "decision": resolution.decision().as_str_name(),
                "operator_id": resolution.operator_id, "resolved_at_ms": resolution.resolved_at_ms,
            }))?;
        }
    }
    Ok(())
}

pub(crate) async fn fetch(channel: ProtocolChannel, token: &str, task_id: String) -> Result<Value> {
    Ok(task_json(
        &client(channel)
            .get_task(request(GetTaskRequest { task_id }, token)?)
            .await?
            .into_inner(),
    ))
}
