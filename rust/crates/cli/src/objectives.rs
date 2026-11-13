use anyhow::{Context, Result};
use clap::{Args, Subcommand, ValueEnum};
use serde_json::{Value, json};
use supertag_control_plane::objective_limits::Timestamp;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        CommitReview, CommitReviewDecision, CreateObjectiveRequest, GetObjectiveRequest,
        ListObjectiveCommitReviewsRequest, ListObjectivesRequest, Objective,
        ObjectiveActionRequest, ReviewObjectiveRequest, RuntimeActions, SetObjectiveLimitsRequest,
        SetObjectiveRuntimeActionsRequest, objectives_client::ObjectivesClient,
    },
};
use uuid::Uuid;

use crate::{Connection, connect_operator, request};

#[derive(Subcommand)]
pub enum ObjectiveCommand {
    /// Record an Objective and queue the owner's first Task.
    Create {
        objective_id: String,
        /// Tag that owns the Objective until it is met.
        #[arg(long)]
        owner: String,
        /// Optional Team ID or name.
        #[arg(long)]
        team: Option<String>,
        /// An ongoing responsibility with no finish, instead of an outcome that completes.
        #[arg(long)]
        ongoing: bool,
        /// RFC 3339 time with a time zone by which the outcome is due.
        #[arg(long, value_parser = deadline)]
        deadline: Option<i64>,
        /// Spending limit in minor currency units, such as cents. Requires --currency.
        #[arg(long)]
        budget_minor: Option<u64>,
        /// Three-letter currency of the spending limit.
        #[arg(long)]
        currency: Option<String>,
        /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
        #[arg(long)]
        operation_id: Option<String>,
        /// Narrow runtime actions to this list; repeat for each allowed action.
        #[arg(long = "runtime-action", conflicts_with = "no_runtime_actions")]
        runtime_actions: Vec<String>,
        /// Create the Objective with no runtime actions.
        #[arg(long)]
        no_runtime_actions: bool,
        outcome: String,
    },
    /// Read one Objective.
    Get { objective_id: String },
    /// List Objectives.
    List {
        /// Most entries to return on one page.
        #[arg(long, default_value_t = 20)]
        limit: u32,
        /// Continue after the last ID the previous page returned.
        #[arg(long, default_value = "")]
        after_id: String,
    },
    /// List commit review requests and recorded verdicts for an Objective.
    ListCommitReviews {
        objective_id: String,
        /// Most entries to return on one page.
        #[arg(long, default_value_t = 50)]
        limit: u32,
        /// Continue from the next_before_order the previous page returned.
        #[arg(long, default_value_t = 0)]
        before_order: u64,
    },
    /// Change the deadline or monetary limit.
    SetLimits {
        objective_id: String,
        /// New RFC 3339 deadline with a time zone.
        #[arg(long, value_parser = deadline)]
        deadline: Option<i64>,
        /// Remove the deadline.
        #[arg(long, conflicts_with = "deadline")]
        clear_deadline: bool,
        /// New spending limit in minor currency units, such as cents.
        #[arg(long)]
        budget_minor: Option<u64>,
        /// Three-letter currency of the spending limit.
        #[arg(long)]
        currency: Option<String>,
        /// Remove the spending limit.
        #[arg(long, conflicts_with_all = ["budget_minor", "currency"])]
        clear_budget: bool,
        /// The revision you last read. If given, the change is refused when the resource has changed since.
        #[arg(long)]
        expected_revision: Option<u64>,
        /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
        #[arg(long)]
        operation_id: Option<String>,
    },
    /// Replace the runtime-action ceiling for future Objective turns.
    SetRuntimeActions {
        objective_id: String,
        /// Runtime action future turns may use. Repeat for each action.
        #[arg(
            long = "runtime-action",
            conflicts_with = "no_runtime_actions",
            required_unless_present = "no_runtime_actions"
        )]
        runtime_actions: Vec<String>,
        /// Allow no runtime actions in future turns.
        #[arg(long)]
        no_runtime_actions: bool,
        /// The revision you last read. If given, the change is refused when the resource has changed since.
        #[arg(long)]
        expected_revision: Option<u64>,
        /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
        #[arg(long)]
        operation_id: Option<String>,
    },
    /// Pause the Objective. Resuming it later queues an owner turn that reports what happened.
    Pause(Action),
    /// Resume a paused Objective.
    Resume(Action),
    /// Cancel the Objective and its open Tasks.
    Cancel(Action),
    /// Approve the Objective's result, or reject it with feedback for the owner.
    Review {
        objective_id: String,
        #[arg(value_enum)]
        decision: ReviewDecision,
        /// What the owner should change. Use it when you reject the result.
        #[arg(long, default_value = "")]
        feedback: String,
        /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
        #[arg(long)]
        operation_id: Option<String>,
    },
}

#[derive(Args)]
pub struct Action {
    objective_id: String,
    /// Why, recorded in the Objective history.
    #[arg(long, default_value = "")]
    reason: String,
    /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
    #[arg(long)]
    operation_id: Option<String>,
}

#[derive(Clone, Copy, ValueEnum)]
pub enum ReviewDecision {
    Approve,
    RequestChanges,
}

pub(crate) fn deadline(input: &str) -> Result<i64> {
    Ok(Timestamp::parse(input)
        .context("use an RFC 3339 deadline with a time zone")?
        .as_millis())
}

fn operation_id(value: Option<String>) -> String {
    value.unwrap_or_else(|| Uuid::new_v4().to_string())
}

impl From<Action> for ObjectiveActionRequest {
    fn from(value: Action) -> Self {
        Self {
            objective_id: value.objective_id,
            reason: value.reason,
            operation_id: operation_id(value.operation_id),
        }
    }
}

pub async fn run(connection: Connection, command: ObjectiveCommand) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let mut client = ObjectivesClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let mut requested_actions = None;
    let response = match command {
        ObjectiveCommand::ListCommitReviews {
            objective_id,
            limit,
            before_order,
        } => {
            let page = client
                .list_commit_reviews(request(
                    ListObjectiveCommitReviewsRequest {
                        objective_id,
                        limit,
                        before_order,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            crate::terminal::print_json(&json!({
                "reviews": page.reviews.into_iter().map(commit_review_output).collect::<Vec<_>>(),
                "next_before_order": page.next_before_order,
            }))?;
            return Ok(());
        }
        ObjectiveCommand::Create {
            objective_id,
            owner,
            team,
            outcome,
            ongoing,
            deadline,
            budget_minor,
            currency,
            operation_id: id,
            runtime_actions,
            no_runtime_actions,
        } => {
            if no_runtime_actions || !runtime_actions.is_empty() {
                requested_actions = Some(runtime_actions);
            }
            client
                .create_objective(request(
                    CreateObjectiveRequest {
                        objective_id,
                        owner_tag_id: owner,
                        team_id: team,
                        outcome,
                        ongoing,
                        deadline_ms: deadline,
                        budget_limit_minor: budget_minor,
                        budget_currency: currency,
                        operation_id: operation_id(id),
                        runtime_actions: requested_actions
                            .clone()
                            .map(|actions| RuntimeActions { actions }),
                    },
                    &token,
                )?)
                .await?
        }
        ObjectiveCommand::Get { objective_id } => {
            client
                .get_objective(request(GetObjectiveRequest { objective_id }, &token)?)
                .await?
        }
        ObjectiveCommand::List { limit, after_id } => {
            let page = client
                .list_objectives(request(ListObjectivesRequest { limit, after_id }, &token)?)
                .await?
                .into_inner();
            for objective in page.objectives {
                crate::terminal::print_json(&output(objective))?;
            }
            return Ok(());
        }
        ObjectiveCommand::SetLimits {
            objective_id,
            deadline,
            clear_deadline,
            budget_minor,
            currency,
            clear_budget,
            expected_revision,
            operation_id: id,
        } => {
            client
                .set_limits(request(
                    SetObjectiveLimitsRequest {
                        objective_id,
                        deadline_ms: deadline,
                        clear_deadline,
                        budget_limit_minor: budget_minor,
                        budget_currency: currency,
                        clear_budget,
                        expected_revision,
                        operation_id: operation_id(id),
                    },
                    &token,
                )?)
                .await?
        }
        ObjectiveCommand::SetRuntimeActions {
            objective_id,
            runtime_actions,
            no_runtime_actions: _,
            expected_revision,
            operation_id: id,
        } => {
            let revision = match expected_revision {
                Some(revision) => revision,
                None => {
                    client
                        .get_objective(request(
                            GetObjectiveRequest {
                                objective_id: objective_id.clone(),
                            },
                            &token,
                        )?)
                        .await?
                        .into_inner()
                        .revision
                }
            };
            requested_actions = Some(runtime_actions.clone());
            client
                .set_runtime_actions(request(
                    SetObjectiveRuntimeActionsRequest {
                        objective_id,
                        operation_id: operation_id(id),
                        expected_revision: revision,
                        runtime_actions: Some(RuntimeActions {
                            actions: runtime_actions,
                        }),
                    },
                    &token,
                )?)
                .await?
        }
        ObjectiveCommand::Pause(action) => {
            client
                .pause_objective(request(action.into(), &token)?)
                .await?
        }
        ObjectiveCommand::Resume(action) => {
            client
                .resume_objective(request(action.into(), &token)?)
                .await?
        }
        ObjectiveCommand::Cancel(action) => {
            client
                .cancel_objective(request(action.into(), &token)?)
                .await?
        }
        ObjectiveCommand::Review {
            objective_id,
            decision,
            feedback,
            operation_id: id,
        } => {
            client
                .review_objective(request(
                    ReviewObjectiveRequest {
                        objective_id,
                        approved: matches!(decision, ReviewDecision::Approve),
                        feedback,
                        operation_id: operation_id(id),
                    },
                    &token,
                )?)
                .await?
        }
    };
    let objective = response.into_inner();
    if let Some(requested) = requested_actions {
        let allowed = objective
            .runtime_actions
            .as_ref()
            .map(|scope| scope.actions.as_slice())
            .unwrap_or_default();
        let mut dropped: Vec<_> = requested
            .into_iter()
            .filter(|action| !allowed.contains(action))
            .collect();
        dropped.sort();
        dropped.dedup();
        if !dropped.is_empty() {
            errln!(
                "Warning: Objective omitted actions its owner does not allow: {}.",
                crate::terminal::text(&dropped.join(", "))
            );
        }
    }
    crate::terminal::print_json(&output(objective))?;
    Ok(())
}

fn commit_review_output(review: CommitReview) -> Value {
    json!({
        "request_id": review.request_id,
        "objective_id": review.objective_id,
        "commit": review.commit,
        "workspace_id": review.workspace_id,
        "source_task_id": review.source_task_id,
        "requester_tag_id": review.requester_tag_id,
        "reviewer_tag_id": review.reviewer_tag_id,
        "requested_at_ms": review.requested_at_ms,
        "verdict": review.verdict.map(|verdict| json!({
            "decision": match verdict.decision() {
                CommitReviewDecision::Approved => "approved",
                CommitReviewDecision::ChangesRequested => "changes_requested",
                CommitReviewDecision::Unspecified => "unspecified",
            },
            "summary": verdict.summary,
            "task_id": verdict.task_id,
            "recorded_at_ms": verdict.recorded_at_ms,
        })),
    })
}

pub(crate) fn output(objective: Objective) -> Value {
    json!({
        "objective_id": objective.objective_id,
        "owner_tag_id": objective.owner_tag_id,
        "team_id": objective.team_id,
        "session_id": objective.session_id,
        "outcome": objective.outcome,
        "ongoing": objective.ongoing,
        "starting_task_id": objective.starting_task_id,
        "status": objective.status().as_str_name(),
        "revision": objective.revision,
        "deadline_ms": objective.deadline_ms,
        "budget_limit_minor": objective.budget_limit_minor,
        "budget_currency": objective.budget_currency,
        "paused_at_ms": objective.paused_at_ms,
        "reported_spend_minor": objective.reported_spend_minor,
        "runtime_actions": objective.runtime_actions.as_ref().map(|scope| scope.actions.as_slice()).unwrap_or_default(),
    })
}
