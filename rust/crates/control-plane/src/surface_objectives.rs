//! Objectives started and steered from a surface thread.
//!
//! Only the authenticated invocation is parsed: the Gateway forwards a verified,
//! allowlisted human's own message text, never history, quotes, or model output.
//! `@SuperTag objective <outcome>` makes the thread the new Objective's home.
//! In a home thread, `@SuperTag approve`, `pause`, and `resume` act on that
//! Objective, and any other message is the Objective's next turn. Every
//! Objective turn answers in the home thread. Each action on an Objective is
//! audited under the person who wrote the message, in the transaction that
//! accepts the message.
use sqlx::{Acquire, Any, Row, Transaction};
use supertag_protocol::v2::{
    ObjectiveActionRequest, ObjectiveStatus, ReviewObjectiveRequest, Task, TaskState,
};
use uuid::Uuid;

use crate::{
    StoreError, objectives,
    store::{Result, insert_task, insert_task_with_surface, next_order, task_in},
    surface_policy::{
        AdmissionSurface, VerifiedConnectorOrigin, admit_connector_task_in, connector_surface_in,
    },
};

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Command {
    Create(String),
    Invalid,
    Approve,
    Pause,
    Resume,
}

/// Recognize a command only at the start of the message, after a mention of
/// the app. Quotes, code, and embedded or reported commands are ordinary text.
pub(crate) fn parse(text: &str) -> Option<Command> {
    let text = text.trim_start();
    let rest = if let Some(rest) = strip_prefix_ignore_case(text, "@SuperTag") {
        rest
    } else {
        let inner = text.strip_prefix("<@")?;
        let end = inner.find('>')?;
        let id = &inner[..end];
        if id.is_empty()
            || id.len() > 64
            || !id
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        {
            return None;
        }
        &inner[end + 1..]
    };
    // A mention must be followed by whitespace before its command word.
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let body = rest.trim_start();
    let word = |name: &str| {
        let trimmed = body.trim_end();
        let trimmed = trimmed.strip_suffix(['.', '!']).unwrap_or(trimmed);
        trimmed.eq_ignore_ascii_case(name)
    };
    if word("approve") {
        return Some(Command::Approve);
    }
    if word("pause") {
        return Some(Command::Pause);
    }
    if word("resume") {
        return Some(Command::Resume);
    }
    let after = strip_prefix_ignore_case(body, "objective")?;
    if !(after.is_empty() || after.starts_with(char::is_whitespace)) {
        return None;
    }
    let outcome = after.trim();
    if outcome.is_empty() {
        return Some(Command::Invalid);
    }
    Some(Command::Create(outcome.to_owned()))
}

fn strip_prefix_ignore_case<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &text[prefix.len()..])
}

/// A verified surface message in one thread.
pub(crate) struct Message<'a> {
    pub origin: VerifiedConnectorOrigin<'a>,
    pub conversation_id: &'a str,
    pub thread_id: &'a str,
    pub event_id: &'a str,
    pub prompt: &'a str,
    /// Whether the provider says the message addresses the app itself.
    pub addressed: bool,
    /// The verified person who wrote it, as `<provider>:<user ID>`. Objective
    /// actions are recorded and receipted under this principal.
    pub actor: &'a str,
    /// The connector RPC that accepted the message, recorded with its audit entries.
    pub method: &'a str,
}

/// Records a person's action on an Objective in the transaction that accepts it.
async fn audit_in(
    tx: &mut Transaction<'_, Any>,
    message: &Message<'_>,
    action: &str,
    objective_id: &str,
    failure: Option<&str>,
    now_ms: i64,
) -> Result<()> {
    let record = crate::operator_access::AuditRecord {
        actor: message.actor.into(),
        action: format!("objective.{action}"),
        target: format!("Objective/{objective_id}"),
        succeeded: failure.is_none(),
        code: failure.unwrap_or("OK").into(),
        method: message.method.into(),
    };
    crate::audit::insert_in(tx, None, now_ms, record, "Objective").await
}

pub(crate) enum Handled {
    /// Not an Objective message: ordinary thread handling applies.
    Ordinary,
    /// Admitted work, or `None` when the surface admits no new work.
    Work(Option<Task>),
    /// A settled Control Plane answer. Its reply posts in the thread.
    Status(Task),
}

struct Home {
    objective_id: String,
    tag_id: String,
    session_id: String,
}

async fn home_in(
    tx: &mut Transaction<'_, Any>,
    account: &str,
    conversation: &str,
    thread: &str,
) -> Result<Option<Home>> {
    let row = sqlx::query("SELECT home.objective_id, home.tag_id, o.session_id FROM supertag_v2_surface_objectives home JOIN supertag_v2_objectives o ON o.objective_id=home.objective_id WHERE home.account_id=$1 AND home.conversation_id=$2 AND home.thread_id=$3")
        .bind(account).bind(conversation).bind(thread).fetch_optional(&mut **tx).await?;
    row.map(|row| {
        Ok(Home {
            objective_id: row.try_get("objective_id")?,
            tag_id: row.try_get("tag_id")?,
            session_id: row.try_get("session_id")?,
        })
    })
    .transpose()
}

pub(crate) async fn handle_in(
    tx: &mut Transaction<'_, Any>,
    order: i64,
    message: Message<'_>,
    now_ms: i64,
) -> Result<Handled> {
    let account = message.origin.connector_account_id;
    let home = home_in(tx, account, message.conversation_id, message.thread_id).await?;
    let command = message.addressed.then(|| parse(message.prompt)).flatten();
    // Directives outside a home thread are ordinary messages.
    if home.is_none() && !matches!(command, Some(Command::Create(_) | Command::Invalid)) {
        return Ok(Handled::Ordinary);
    }
    // Every Objective action and every Control Plane answer is admitted like
    // ordinary work first: a disabled account or location, an inactive Tag, or a
    // location moved to another Tag stops it before anything changes or replies.
    let origin = VerifiedConnectorOrigin {
        tag_id: home
            .as_ref()
            .map_or(message.origin.tag_id, |home| home.tag_id.as_str()),
        ..message.origin
    };
    let Some(surface) = connector_surface_in(tx, &origin).await? else {
        return Ok(Handled::Work(None));
    };
    let Some(home) = home.as_ref() else {
        return match command {
            Some(Command::Create(outcome)) => {
                create_in(tx, order, &message, surface, &outcome, now_ms).await
            }
            _ => Ok(Handled::Status(
                status_in(
                    tx,
                    order,
                    message.origin.tag_id,
                    message.prompt,
                    "Say which outcome the Objective should achieve: @SuperTag objective <outcome>.",
                    now_ms,
                )
                .await?,
            )),
        };
    };
    let id = home.objective_id.as_str();
    let text = match command {
        Some(Command::Create(_) | Command::Invalid) => format!(
            "This thread already directs Objective {id}. Reply here to steer it, or start another Objective in a new thread."
        ),
        Some(Command::Pause) => directive_in(tx, &message, id, "pause", now_ms).await?,
        Some(Command::Resume) => directive_in(tx, &message, id, "resume", now_ms).await?,
        Some(Command::Approve) => directive_in(tx, &message, id, "approve", now_ms).await?,
        None => {
            // Any other message in the home thread is the Objective's next turn.
            let mut savepoint = tx.begin().await?;
            match admit_connector_task_in(
                &mut savepoint,
                order,
                origin,
                &home.session_id,
                message.prompt,
                now_ms,
            )
            .await
            {
                Ok(task) => {
                    savepoint.commit().await?;
                    if task.is_some() {
                        audit_in(tx, &message, "message", id, None, now_ms).await?;
                    }
                    return Ok(Handled::Work(task));
                }
                Err(StoreError::FailedPrecondition(reason)) => {
                    savepoint.rollback().await?;
                    let code = Some("FAILED_PRECONDITION");
                    audit_in(tx, &message, "message", id, code, now_ms).await?;
                    format!("Objective {id} did not accept this message: {reason}")
                }
                Err(error) => return Err(error),
            }
        }
    };
    Ok(Handled::Status(
        status_in(tx, order, &home.tag_id, message.prompt, &text, now_ms).await?,
    ))
}

async fn create_in(
    tx: &mut Transaction<'_, Any>,
    order: i64,
    message: &Message<'_>,
    surface: Option<AdmissionSurface>,
    outcome: &str,
    now_ms: i64,
) -> Result<Handled> {
    // The Objective's authority is what this surface grants the Tag: the
    // invocation cannot raise it, and later surface changes do not either.
    let tag = message.origin.tag_id;
    let runtime_actions = Box::pin(crate::store::surface_runtime_actions_in(
        tx,
        tag,
        surface.as_ref(),
    ))
    .await?;
    let objective_id = Uuid::new_v4().to_string();
    let session_id = Uuid::new_v4().to_string();
    objectives::insert_surface_objective_in(
        tx,
        &objective_id,
        tag,
        &session_id,
        outcome,
        &runtime_actions,
        now_ms,
    )
    .await?;
    let prompt = format!(
        "The Objective just started: plan the work, then start it.\n\n{outcome}\n\nA person started this Objective from a surface thread. Your replies post in that thread, and their later messages there reach you as new turns.\n\nWhen the outcome is met, report ready_for_review or completed with your result."
    );
    // Admission checks already ran above; the new Objective has no limits yet.
    let mut task = Box::pin(insert_task_with_surface(
        tx,
        order,
        tag,
        &session_id,
        &prompt,
        surface.as_ref(),
    ))
    .await?;
    crate::artifact_context::resolve_in(tx, &mut task, now_ms).await?;
    objectives::objective_link_task_in(tx, &task).await?;
    objectives::set_starting_task_in(tx, &objective_id, &task.task_id).await?;
    sqlx::query("INSERT INTO supertag_v2_surface_objectives (account_id,conversation_id,thread_id,objective_id,tag_id,started_by_event_id) VALUES ($1,$2,$3,$4,$5,$6)")
        .bind(message.origin.connector_account_id).bind(message.conversation_id).bind(message.thread_id)
        .bind(&objective_id).bind(tag).bind(message.event_id).execute(&mut **tx).await?;
    Ok(Handled::Work(Some(task)))
}

/// Anyone who may start Objectives from this thread may steer its Objective.
/// The operation is recorded under the person who wrote the message and is
/// receipted by its provider event.
async fn directive_in(
    tx: &mut Transaction<'_, Any>,
    message: &Message<'_>,
    id: &str,
    action: &str,
    now_ms: i64,
) -> Result<String> {
    let principal = message.actor;
    let operation_id = format!(
        "surface:{}:{}",
        message.origin.connector_account_id, message.event_id
    );
    let mut savepoint = tx.begin().await?;
    let before = objectives::objective_in(&mut savepoint, id).await?;
    let result = if action == "approve" {
        let input = ReviewObjectiveRequest {
            objective_id: id.into(),
            operation_id,
            approved: true,
            feedback: String::new(),
        };
        let fingerprint = objectives::digest("review", &input);
        objectives::review_in(&mut savepoint, principal, &input, &fingerprint, now_ms).await
    } else {
        let input = ObjectiveActionRequest {
            objective_id: id.into(),
            operation_id,
            reason: String::new(),
        };
        let fingerprint = objectives::digest(action, &input);
        objectives::objective_action_in(
            &mut savepoint,
            principal,
            &input,
            action,
            &fingerprint,
            now_ms,
        )
        .await
    };
    let after = match result {
        Ok(after) => after,
        Err(error @ (StoreError::FailedPrecondition(_) | StoreError::InvalidArgument(_))) => {
            savepoint.rollback().await?;
            let code = if matches!(error, StoreError::FailedPrecondition(_)) {
                "FAILED_PRECONDITION"
            } else {
                "INVALID_ARGUMENT"
            };
            let reason = error.to_string();
            audit_in(tx, message, action, id, Some(code), now_ms).await?;
            return Ok(format!("Objective {id} was not changed: {reason}."));
        }
        Err(error) => return Err(error),
    };
    savepoint.commit().await?;
    audit_in(tx, message, action, id, None, now_ms).await?;
    let changed = after.revision != before.revision;
    Ok(match action {
        "pause" if changed => format!(
            "Paused. Objective {id} starts no new work; running Task Attempts finish. Resume with @SuperTag resume."
        ),
        "pause" => format!("Objective {id} is already paused. Resume with @SuperTag resume."),
        "resume" if changed => format!(
            "Resumed. Objective {id} can start work again; the owner received a summary of what changed while it was paused."
        ),
        "resume" => format!("Objective {id} is not paused."),
        _ if after.status == ObjectiveStatus::Completed as i32 => {
            format!("Approved. Objective {id} is completed.")
        }
        _ => format!("Objective {id} was not changed."),
    })
}

/// The Control Plane answered this message itself. Record it as a settled Task
/// in its own Session so the message is deduplicated like any other and its
/// answer reaches the thread through the durable reply outbox.
async fn status_in(
    tx: &mut Transaction<'_, Any>,
    order: i64,
    tag_id: &str,
    prompt: &str,
    answer: &str,
    now_ms: i64,
) -> Result<Task> {
    let session = format!("surface-status:{}", Uuid::new_v4());
    let task = Box::pin(insert_task(tx, order, tag_id, &session, prompt)).await?;
    sqlx::query("UPDATE supertag_v2_tasks SET state=$1, result=$2, allowed_actions='[]', completed_at_ms=$3, cleanup_pending=0, cleanup_observed=1 WHERE task_id=$4")
        .bind(TaskState::Succeeded as i64).bind(answer).bind(now_ms).bind(&task.task_id).execute(&mut **tx).await?;
    task_in(tx, &task.task_id).await
}

/// Queue the status answer once the thread route of its Task is recorded.
pub(crate) async fn reply_in(tx: &mut Transaction<'_, Any>, task: &Task) -> Result<()> {
    let order = next_order(tx).await?;
    crate::store::enqueue_reply(tx, task, order).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_only_an_authenticated_leading_invocation() {
        assert_eq!(
            parse("<@U123> objective Launch product\nwithin $2,000"),
            Some(Command::Create("Launch product\nwithin $2,000".into()))
        );
        assert_eq!(
            parse("@supertag OBJECTIVE  Validate scheduling "),
            Some(Command::Create("Validate scheduling".into()))
        );
        assert_eq!(parse("@SuperTag objective"), Some(Command::Invalid));
        assert_eq!(parse("@SuperTag objective   "), Some(Command::Invalid));
        assert_eq!(parse("<@U1> approve."), Some(Command::Approve));
        assert_eq!(parse("@SuperTag Pause!"), Some(Command::Pause));
        assert_eq!(parse("@SuperTag resume"), Some(Command::Resume));
        for text in [
            "> @SuperTag objective launch",
            "&gt; @SuperTag objective launch",
            "Please say @SuperTag objective launch",
            "```@SuperTag objective launch```",
            "@SuperTag explain objectives",
            "@SuperTag objectives launch",
            "@SuperTagobjective launch",
            "<@u1> objective launch",
            "<@U1|name> objective launch",
            "<#C1> objective launch",
            "@SuperTag pause the deploy",
            "Help me inspect this scheduling product",
        ] {
            assert_eq!(parse(text), None, "{text}");
        }
    }
}
