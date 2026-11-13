//! One operator read of an Objective: what it is, what it may spend and when it
//! ends, what needs a person, and the work of every Session beneath it.
//!
//! The read is a projection over durable records in one transaction. It never
//! changes the Objective: limits are shown as the last sweep recorded them.
use sqlx::{Any, Row, Transaction};
use supertag_protocol::v2::*;
use tonic::{Request, Response, Status};

use crate::{
    ControlPlane, Store,
    objective_limits::{self as limits, NoticeKind},
    store::{Result, name},
};

const DEFAULT_PAGE: u32 = 20;
const MAX_PAGE: u32 = 50;
/// Sessions listed in one read; `total_sessions` counts the rest.
const MAX_SESSIONS: i64 = 100;
const CONVERSATION_TURNS: i64 = 20;
const TEAM_POSTS: i64 = 10;
const PROMPT_CHARS: usize = 2_000;
const RESULT_CHARS: usize = 4_000;
const QUESTION_CHARS: usize = 8_000;
const POST_CHARS: usize = 2_000;

/// A bounded excerpt that ends with an ellipsis when it was cut.
fn excerpt(text: &str, chars: usize) -> String {
    if text.chars().count() <= chars {
        return text.to_owned();
    }
    let mut cut: String = text.chars().take(chars.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

fn notice_kind(kind: NoticeKind) -> &'static str {
    match kind {
        NoticeKind::ObjectiveBudgetThreshold => "objective_budget_threshold",
        NoticeKind::ObjectiveBudgetExhausted => "objective_budget_exhausted",
        NoticeKind::ObjectiveDeadlineSet => "objective_deadline_set",
        NoticeKind::ObjectiveDeadlineApproaching => "objective_deadline_approaching",
        NoticeKind::DeadlinePassed => "objective_deadline_passed",
    }
}

fn pool(objective: &Objective, model: &limits::ObjectiveLimits) -> ObjectiveBudgetPool {
    let reported = model
        .state
        .reported_spend
        .as_ref()
        .map(|entry| &entry.spend);
    let unknown = reported.map_or(0, |spend| spend.unknown_attempt_ids.len() as u32);
    let estimated = reported.map_or(0, |spend| spend.estimated_cost_attempts as u32);
    let spent = reported.map(|spend| spend.amount_minor);
    let Some(limit) = objective.budget_limit_minor else {
        return ObjectiveBudgetPool {
            measure: ObjectiveBudgetMeasure::Unlimited as i32,
            currency: objective.budget_currency.clone(),
            spent_minor: spent,
            unknown_cost_attempts: unknown,
            estimated_cost_attempts: estimated,
            ..Default::default()
        };
    };
    if objective.budget_currency.is_none() {
        // A limit without a currency has nothing to count against it.
        return ObjectiveBudgetPool {
            measure: ObjectiveBudgetMeasure::Unmeasured as i32,
            limit_minor: Some(limit),
            ..Default::default()
        };
    }
    // Nothing is spent before the first sweep records reported cost.
    let spent = spent.unwrap_or(0);
    ObjectiveBudgetPool {
        measure: ObjectiveBudgetMeasure::ProviderReportedCost as i32,
        currency: objective.budget_currency.clone(),
        limit_minor: Some(limit),
        spent_minor: Some(spent),
        available_minor: Some(
            (i128::from(limit) - i128::from(spent))
                .clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64,
        ),
        overrun_minor: spent.saturating_sub(limit),
        exhausted: model
            .state
            .budget_exhausted
            .as_ref()
            .is_some_and(|entry| entry.limit_minor == limit),
        unknown_cost_attempts: unknown,
        estimated_cost_attempts: estimated,
    }
}

fn deadline(model: &limits::ObjectiveLimits, now_ms: i64) -> Option<ObjectiveDeadlineView> {
    let at = model.deadline?.as_millis();
    let passed = now_ms >= at;
    Some(ObjectiveDeadlineView {
        at_ms: at,
        passed,
        grace_ends_at_ms: at.saturating_add(limits::deadline_grace_ms(model)),
        remaining: if passed {
            format!(
                "passed {} ago",
                limits::readable_duration(now_ms.saturating_sub(at))
            )
        } else {
            format!(
                "{} left",
                limits::readable_duration(at.saturating_sub(now_ms))
            )
        },
    })
}

fn task_state(row: &sqlx::any::AnyRow) -> Result<TaskState> {
    Ok(TaskState::try_from(row.try_get::<i64, _>("state")? as i32).unwrap_or_default())
}

fn turn(row: &sqlx::any::AnyRow, starting_task_id: &str) -> Result<ObjectiveTurn> {
    let task_id: String = row.try_get("task_id")?;
    let link: Option<String> = row.try_get("link_kind")?;
    let report: Option<i64> = row.try_get("session_kind")?;
    let kind = if task_id == starting_task_id {
        "start"
    } else if report == Some(crate::work_sessions::REPORT) {
        "report"
    } else {
        match link.as_deref() {
            Some("notice") => "notice",
            Some("resume") => "resume",
            Some("idle") => "idle",
            _ if report == Some(crate::work_sessions::CHILD) => "work",
            _ => "message",
        }
    };
    Ok(ObjectiveTurn {
        state: task_state(row)? as i32,
        tag_id: row.try_get("tag_id")?,
        session_id: row.try_get("session_id")?,
        kind: kind.into(),
        prompt: excerpt(&row.try_get::<String, _>("prompt")?, PROMPT_CHARS),
        result: excerpt(
            &row.try_get::<Option<String>, _>("result")?
                .unwrap_or_default(),
            RESULT_CHARS,
        ),
        completed_at_ms: row.try_get("completed_at_ms")?,
        task_id,
    })
}

const TURN_COLUMNS: &str = "t.task_id, t.tag_id, t.session_id, t.state, t.prompt, t.result, t.completed_at_ms, ot.kind AS link_kind, wt.kind AS session_kind";

/// The status of a Session from its latest turn, and the question it waits on.
async fn session_status(
    tx: &mut Transaction<'_, Any>,
    tag_id: &str,
    session_id: &str,
) -> Result<(ObjectiveSessionStatus, String, String, u32)> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM supertag_v2_tasks WHERE tag_id=$1 AND session_id=$2",
    )
    .bind(tag_id)
    .bind(session_id)
    .fetch_one(&mut **tx)
    .await?;
    let Some(latest) = sqlx::query("SELECT task_id, state FROM supertag_v2_tasks WHERE tag_id=$1 AND session_id=$2 ORDER BY accepted_order DESC LIMIT 1")
        .bind(tag_id).bind(session_id).fetch_optional(&mut **tx).await? else {
        return Ok((ObjectiveSessionStatus::NotStarted, String::new(), String::new(), 0));
    };
    let task_id: String = latest.try_get("task_id")?;
    let mut question = String::new();
    let status = match task_state(&latest)? {
        TaskState::Queued | TaskState::Claimed | TaskState::Unspecified => {
            ObjectiveSessionStatus::Queued
        }
        TaskState::Running => ObjectiveSessionStatus::Running,
        TaskState::Failed => ObjectiveSessionStatus::Failed,
        TaskState::Cancelled => ObjectiveSessionStatus::Cancelled,
        TaskState::Uncertain => ObjectiveSessionStatus::Uncertain,
        TaskState::Succeeded => {
            let asked: Option<String> = if crate::inbox::task_waits_in(tx, &task_id).await? {
                sqlx::query_scalar("SELECT q.text FROM supertag_v2_objective_questions q JOIN supertag_v2_tasks t ON t.task_id=q.task_id AND t.attempt_id=q.attempt_id WHERE q.task_id=$1")
                    .bind(&task_id).fetch_optional(&mut **tx).await?
            } else {
                sqlx::query_scalar("SELECT q.text FROM supertag_v2_work_session_questions q JOIN supertag_v2_tasks t ON t.task_id=q.task_id AND t.attempt_id=q.attempt_id WHERE q.task_id=$1 AND q.published_at_ms IS NOT NULL AND q.answer_task_id IS NULL")
                    .bind(&task_id).fetch_optional(&mut **tx).await?
            };
            if let Some(text) = asked {
                question = excerpt(&text, QUESTION_CHARS);
                ObjectiveSessionStatus::Waiting
            } else if crate::approvals::task_waits_in(tx, &task_id).await? {
                ObjectiveSessionStatus::Waiting
            } else {
                ObjectiveSessionStatus::Succeeded
            }
        }
    };
    Ok((status, question, task_id, count as u32))
}

impl Store {
    pub async fn objective_overview(
        &self,
        input: &GetObjectiveOverviewRequest,
    ) -> Result<ObjectiveOverview> {
        name("Objective ID", &input.objective_id)?;
        let limit = match input.limit {
            0 => DEFAULT_PAGE,
            value => value.min(MAX_PAGE),
        };
        let now_ms = self.execution_now_ms();
        let mut tx = self.pool.begin().await?;
        let (objective, model) =
            crate::objectives::objective_limits_in(&mut tx, &input.objective_id).await?;
        let id = objective.objective_id.clone();
        let status = objective.status();
        let closed = matches!(
            status,
            ObjectiveStatus::Completed | ObjectiveStatus::Cancelled
        );

        let team = match &objective.team_id {
            Some(team_id) => {
                let row = sqlx::query(
                    "SELECT name, max_concurrency FROM supertag_v2_teams WHERE team_id=$1",
                )
                .bind(team_id)
                .fetch_optional(&mut *tx)
                .await?;
                match row {
                    Some(row) => {
                        let members: Vec<String> = sqlx::query_scalar("SELECT tag_id FROM supertag_v2_team_members WHERE team_id=$1 ORDER BY tag_id")
                            .bind(team_id).fetch_all(&mut *tx).await?;
                        // The same slots the Team's concurrency limit counts.
                        let running: i64 = sqlx::query_scalar(
                            "SELECT COUNT(*) FROM supertag_v2_tasks active
                            JOIN supertag_v2_objective_tasks link ON link.task_id=active.task_id
                            JOIN supertag_v2_objectives objective ON objective.objective_id=link.objective_id
                            WHERE objective.team_id=$1 AND (objective.status NOT IN ($2,$3) OR active.cleanup_pending=1)
                            AND (active.state=$4 OR active.cleanup_pending=1
                              OR (active.state=$5 AND active.lease_expires_at_ms>$6))",
                        )
                        .bind(team_id)
                        .bind(ObjectiveStatus::Completed as i64)
                        .bind(ObjectiveStatus::Cancelled as i64)
                        .bind(TaskState::Running as i64)
                        .bind(TaskState::Claimed as i64)
                        .bind(now_ms)
                        .fetch_one(&mut *tx)
                        .await?;
                        Some(ObjectiveOverviewTeam {
                            team_id: team_id.clone(),
                            name: row.try_get("name")?,
                            member_tag_ids: members,
                            max_concurrency: row
                                .try_get::<Option<i64>, _>("max_concurrency")?
                                .map(|value| value as u32),
                            running_turns: running as u32,
                        })
                    }
                    None => None,
                }
            }
            None => None,
        };

        // The owner's Session, then each Work Session under the Objective.
        let (owner_status, owner_question, owner_latest, owner_count) =
            session_status(&mut tx, &objective.owner_tag_id, &objective.session_id).await?;
        let mut sessions = vec![ObjectiveSessionView {
            session_id: objective.session_id.clone(),
            tag_id: objective.owner_tag_id.clone(),
            owner: true,
            status: owner_status as i32,
            question: owner_question.clone(),
            task_count: owner_count,
            latest_task_id: owner_latest.clone(),
            ..Default::default()
        }];
        let total_work: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM supertag_v2_work_sessions WHERE objective_id=$1",
        )
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
        let work = sqlx::query("SELECT work_session_id, title, parent_session_id, tag_id FROM supertag_v2_work_sessions WHERE objective_id=$1 ORDER BY created_order LIMIT $2")
            .bind(&id).bind(MAX_SESSIONS - 1).fetch_all(&mut *tx).await?;
        for row in work {
            let session_id: String = row.try_get("work_session_id")?;
            let tag_id: String = row.try_get("tag_id")?;
            let (status, question, latest, count) =
                session_status(&mut tx, &tag_id, &session_id).await?;
            sessions.push(ObjectiveSessionView {
                session_id,
                tag_id,
                owner: false,
                title: row.try_get("title")?,
                parent_session_id: row.try_get("parent_session_id")?,
                status: status as i32,
                question,
                task_count: count,
                latest_task_id: latest,
            });
        }

        let pending_approvals: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM supertag_v2_approvals WHERE objective_id=$1 AND state=$2",
        )
        .bind(&id)
        .bind(ApprovalState::Pending as i64)
        .fetch_one(&mut *tx)
        .await?;

        // What needs a person, each with the command that acts on it.
        let mut attention = vec![];
        if !owner_question.is_empty() {
            attention.push(ObjectiveAttention {
                kind: ObjectiveAttentionKind::Question as i32,
                message: format!("{} asks: \"{owner_question}\"", objective.owner_tag_id),
                next_actions: vec![format!("supertag inbox answer {owner_latest} TEXT")],
                task_id: owner_latest.clone(),
                tag_id: objective.owner_tag_id.clone(),
            });
        }
        match status {
            ObjectiveStatus::ReadyForReview => attention.push(ObjectiveAttention {
                kind: ObjectiveAttentionKind::Review as i32,
                message: "The owner submitted the Objective for review.".into(),
                next_actions: vec![
                    format!("supertag objective review {id} approve"),
                    format!("supertag objective review {id} request-changes --feedback TEXT"),
                ],
                ..Default::default()
            }),
            ObjectiveStatus::Limited => attention.push(ObjectiveAttention {
                kind: ObjectiveAttentionKind::Limited as i32,
                message: "The Objective reached its budget or deadline limit. Raise the budget or move the deadline to resume it.".into(),
                next_actions: vec![
                    format!("supertag objective set-limits {id} --budget-minor AMOUNT"),
                    format!("supertag objective set-limits {id} --deadline RFC3339_TIME"),
                ],
                ..Default::default()
            }),
            ObjectiveStatus::Blocked => attention.push(ObjectiveAttention {
                kind: ObjectiveAttentionKind::Blocked as i32,
                message: "The owner reported the Objective blocked; a message in its Session starts its next turn.".into(),
                next_actions: vec![format!(
                    "supertag task submit --tag {} --session {} TEXT",
                    objective.owner_tag_id, objective.session_id
                )],
                tag_id: objective.owner_tag_id.clone(),
                ..Default::default()
            }),
            ObjectiveStatus::Cancelled => attention.push(ObjectiveAttention {
                kind: ObjectiveAttentionKind::Cancelled as i32,
                message: match objective.cancellation_reason.as_deref() {
                    Some(reason) => format!("The Objective was cancelled: {reason}"),
                    None => "The Objective was cancelled.".into(),
                },
                ..Default::default()
            }),
            _ => {}
        }
        if let (Some(paused_at), false) = (objective.paused_at_ms, closed) {
            attention.push(ObjectiveAttention {
                kind: ObjectiveAttentionKind::Paused as i32,
                message: format!(
                    "Paused since {}: no new turn starts, and running Task Attempts finish.",
                    limits::Timestamp::from_millis(paused_at)
                        .map_or_else(|| paused_at.to_string(), |at| at.to_string())
                ),
                next_actions: vec![format!("supertag objective resume {id}")],
                ..Default::default()
            });
        }
        if pending_approvals > 0 && !closed {
            attention.push(ObjectiveAttention {
                kind: ObjectiveAttentionKind::Approvals as i32,
                message: format!(
                    "{pending_approvals} approval request{} wait{} for a decision.",
                    if pending_approvals == 1 { "" } else { "s" },
                    if pending_approvals == 1 { "s" } else { "" }
                ),
                next_actions: vec![format!("supertag inbox list --objective {id}")],
                ..Default::default()
            });
        }

        // The owner's conversation: its latest turns, oldest first.
        let mut conversation = vec![];
        for row in sqlx::query(&format!("SELECT {TURN_COLUMNS} FROM supertag_v2_tasks t LEFT JOIN supertag_v2_objective_tasks ot ON ot.task_id=t.task_id LEFT JOIN supertag_v2_work_session_tasks wt ON wt.task_id=t.task_id WHERE t.tag_id=$1 AND t.session_id=$2 ORDER BY t.accepted_order DESC LIMIT $3"))
            .bind(&objective.owner_tag_id).bind(&objective.session_id).bind(CONVERSATION_TURNS)
            .fetch_all(&mut *tx).await?
        {
            conversation.push(turn(&row, &objective.starting_task_id)?);
        }
        conversation.reverse();

        // One page of every Task of the Objective's Sessions.
        let total_tasks: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM supertag_v2_objective_tasks WHERE objective_id=$1",
        )
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
        let mut tasks = vec![];
        for row in sqlx::query(&format!("SELECT {TURN_COLUMNS} FROM supertag_v2_objective_tasks ot JOIN supertag_v2_tasks t ON t.task_id=ot.task_id LEFT JOIN supertag_v2_work_session_tasks wt ON wt.task_id=t.task_id WHERE ot.objective_id=$1 ORDER BY t.accepted_order LIMIT $2 OFFSET $3"))
            .bind(&id).bind(i64::from(limit)).bind(i64::from(input.offset))
            .fetch_all(&mut *tx).await?
        {
            tasks.push(turn(&row, &objective.starting_task_id)?);
        }
        let next = u64::from(input.offset) + tasks.len() as u64;
        let next_offset = (next < total_tasks as u64 && !tasks.is_empty()).then_some(next as u32);

        let mut posts = vec![];
        if let Some(team) = &team {
            for row in sqlx::query("SELECT sequence, author_tag_id, to_tag_ids, body, created_at_ms FROM supertag_v2_workstream_posts WHERE team_id=$1 ORDER BY sequence DESC LIMIT $2")
                .bind(&team.team_id).bind(TEAM_POSTS).fetch_all(&mut *tx).await?
            {
                posts.push(ObjectiveTeamPost {
                    sequence: row.try_get::<i64, _>("sequence")? as u64,
                    author_tag_id: row.try_get("author_tag_id")?,
                    to_tag_ids: serde_json::from_str(&row.try_get::<String, _>("to_tag_ids")?)?,
                    body: excerpt(&row.try_get::<String, _>("body")?, POST_CHARS),
                    created_at_ms: row.try_get("created_at_ms")?,
                });
            }
            posts.reverse();
        }
        tx.commit().await?;

        let notices = limits::limit_events(&model)
            .into_iter()
            .map(|notice| ObjectiveLimitNotice {
                key: notice.key,
                kind: notice_kind(notice.kind).into(),
                at_ms: notice.at.as_millis(),
                message: notice.message,
            })
            .collect();
        Ok(ObjectiveOverview {
            pool: Some(pool(&objective, &model)),
            deadline: deadline(&model, now_ms),
            objective: Some(objective),
            as_of_ms: now_ms,
            team,
            attention,
            sessions,
            conversation,
            posts,
            tasks,
            total_tasks: total_tasks as u32,
            next_offset,
            notices,
            pending_approvals: pending_approvals as u32,
            total_sessions: (total_work + 1) as u32,
        })
    }
}

impl ControlPlane {
    pub fn objective_overview_service(
        &self,
    ) -> objective_overviews_server::ObjectiveOverviewsServer<Self> {
        objective_overviews_server::ObjectiveOverviewsServer::new(self.clone())
            .max_decoding_message_size(supertag_protocol::MAX_MESSAGE_BYTES)
            .max_encoding_message_size(supertag_protocol::MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl objective_overviews_server::ObjectiveOverviews for ControlPlane {
    async fn get_objective_overview(
        &self,
        request: Request<GetObjectiveOverviewRequest>,
    ) -> std::result::Result<Response<ObjectiveOverview>, Status> {
        self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store.objective_overview(request.get_ref()).await?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excerpts_are_bounded_by_characters() {
        assert_eq!(excerpt("short", 10), "short");
        let cut = excerpt(&"é".repeat(20), 10);
        assert_eq!(cut.chars().count(), 10);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn a_currencyless_limit_is_unmeasured_and_nothing_counts_against_it() {
        let objective = Objective {
            budget_limit_minor: Some(1000),
            ..Default::default()
        };
        let model = limits::ObjectiveLimits {
            status: limits::ObjectiveStatus::Working,
            created_at: None,
            deadline: None,
            budget_limit_minor: Some(1000),
            budget_currency: None,
            paused_at: None,
            state: limits::LimitState::default(),
        };
        let view = pool(&objective, &model);
        assert_eq!(view.measure(), ObjectiveBudgetMeasure::Unmeasured);
        assert_eq!(view.spent_minor, None);
        assert_eq!(view.available_minor, None);
        let priced = Objective {
            budget_currency: Some("USD".into()),
            ..objective
        };
        let view = pool(&priced, &model);
        // Nothing is spent before the first sweep.
        assert_eq!(view.spent_minor, Some(0));
        assert_eq!(view.available_minor, Some(1000));
    }
}
