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
    ObjectiveActionRequest, ObjectiveStatus, ReplyDeliveryAudit, ReplyState,
    ReviewObjectiveRequest, SurfaceAccount, Task, TaskState,
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
    let call = audit_call_id(message.origin.connector_account_id, message.event_id);
    crate::audit::insert_in(tx, Some(&call), now_ms, record, "Objective").await
}

/// Groups the audit entries one provider event records, so they reach the audit log once its
/// transaction commits.
pub(crate) fn audit_call_id(account: &str, event_id: &str) -> String {
    format!("surface-event:{account}:{event_id}")
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
    /// The thread started the Objective; otherwise it is the Objective's chosen notice thread.
    started: bool,
    objective_id: String,
    /// The Tag the thread's surface route addresses.
    tag_id: String,
    owner_tag_id: String,
    session_id: String,
}

/// The Objective a thread directs (TS `findObjectiveByHomeSession`): the Objective the thread
/// started, else the newest open Objective whose operator-chosen notification Task is in it.
async fn home_in(
    tx: &mut Transaction<'_, Any>,
    account: &str,
    conversation: &str,
    thread: &str,
) -> Result<Option<Home>> {
    let started = sqlx::query("SELECT home.objective_id, home.tag_id, o.owner_tag_id, o.session_id FROM supertag_v2_surface_objectives home JOIN supertag_v2_objectives o ON o.objective_id=home.objective_id WHERE home.account_id=$1 AND home.conversation_id=$2 AND home.thread_id=$3")
        .bind(account).bind(conversation).bind(thread).fetch_optional(&mut **tx).await?;
    let (started, row) = match started {
        Some(row) => (true, Some(row)),
        None => (false, sqlx::query("SELECT o.objective_id, t.tag_id, o.owner_tag_id, o.session_id FROM supertag_v2_objectives o JOIN supertag_v2_inbound_events e ON e.task_id=o.notification_task_id JOIN supertag_v2_tasks t ON t.task_id=e.task_id WHERE e.account_id=$1 AND e.conversation_id=$2 AND e.thread_id=$3 AND o.status NOT IN ($4,$5) ORDER BY o.updated_at_ms DESC, o.objective_id DESC LIMIT 1")
            .bind(account).bind(conversation).bind(thread)
            .bind(ObjectiveStatus::Completed as i64).bind(ObjectiveStatus::Cancelled as i64)
            .fetch_optional(&mut **tx).await?),
    };
    row.map(|row| {
        Ok(Home {
            started,
            objective_id: row.try_get("objective_id")?,
            tag_id: row.try_get("tag_id")?,
            owner_tag_id: row.try_get("owner_tag_id")?,
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
    let mut home = home_in(tx, account, message.conversation_id, message.thread_id).await?;
    let command = message.addressed.then(|| parse(message.prompt)).flatten();
    // A thread chosen for an Objective's notices may still start an Objective of its own.
    if matches!(command, Some(Command::Create(_) | Command::Invalid))
        && home.as_ref().is_some_and(|home| !home.started)
    {
        home = None;
    }
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
        // A chosen thread addressed to another Tag keeps that Tag's conversation: the
        // Objective's turns run in its owner's Session, which this route cannot admit to.
        None if !home.started && home.tag_id != home.owner_tag_id => {
            return Ok(Handled::Ordinary);
        }
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

/// Where an Objective's notices post: a surface thread that still verifies.
pub(crate) struct NoticeHome {
    /// `task:ID` for a chosen or default surface Task, `thread` for the start thread.
    pub(crate) id: String,
    account_id: String,
    conversation_id: String,
    thread_id: Option<String>,
}

/// TS `objectiveHome`: the surface Task an operator chose for the Objective, then the thread
/// that started it, then the deployment default (`SUPERTAG_OPERATOR_NOTIFICATION_TASK_ID`); the
/// first whose Tag is active and whose Surface Account is still enabled.
pub(crate) async fn notice_home_in(
    tx: &mut Transaction<'_, Any>,
    objective_id: &str,
) -> Result<Option<NoticeHome>> {
    let chosen: Option<String> = sqlx::query_scalar(
        "SELECT notification_task_id FROM supertag_v2_objectives WHERE objective_id=$1",
    )
    .bind(objective_id)
    .fetch_optional(&mut **tx)
    .await?
    .flatten();
    if let Some(task) = chosen
        && let Some(home) = task_home_in(tx, &task).await?
    {
        return Ok(Some(home));
    }
    if let Some(row) = sqlx::query("SELECT account_id, conversation_id, thread_id, tag_id FROM supertag_v2_surface_objectives WHERE objective_id=$1")
        .bind(objective_id).fetch_optional(&mut **tx).await?
    {
        let account_id: String = row.try_get("account_id")?;
        if route_verified_in(tx, &account_id, &row.try_get::<String, _>("tag_id")?).await? {
            return Ok(Some(NoticeHome {
                id: "thread".into(),
                account_id,
                conversation_id: row.try_get("conversation_id")?,
                thread_id: row.try_get("thread_id")?,
            }));
        }
    }
    let default: Option<String> = sqlx::query_scalar(
        "SELECT task_id FROM supertag_v2_notification_defaults WHERE singleton=1",
    )
    .fetch_optional(&mut **tx)
    .await?;
    match default {
        Some(task) => task_home_in(tx, &task).await,
        None => Ok(None),
    }
}

/// Event ID prefixes of system Tasks that copy a person's thread route to post a notice there.
pub(crate) const SYSTEM_ROUTE_EVENTS: [&str; 3] = [
    "approval-budget-stop:",
    "work-session-approval-stop:",
    "work-session-report:",
];

/// The thread of a surface Task a person's message started, while it verifies (TS
/// `getVerifiedSurfaceTask`).
pub(crate) async fn task_home_in(
    tx: &mut Transaction<'_, Any>,
    task_id: &str,
) -> Result<Option<NoticeHome>> {
    let Some(row) = sqlx::query("SELECT e.event_id, e.account_id, e.conversation_id, e.thread_id, t.tag_id FROM supertag_v2_inbound_events e JOIN supertag_v2_tasks t ON t.task_id=e.task_id WHERE e.task_id=$1")
        .bind(task_id).fetch_optional(&mut **tx).await? else {
        return Ok(None);
    };
    // A person's message started it (TS `notificationSource`, `actor.kind === "user"`), not a
    // system notice or report that copied a person's route.
    let event: String = row.try_get("event_id")?;
    if SYSTEM_ROUTE_EVENTS
        .iter()
        .any(|prefix| event.starts_with(prefix))
    {
        return Ok(None);
    }
    let account_id: String = row.try_get("account_id")?;
    if !route_verified_in(tx, &account_id, &row.try_get::<String, _>("tag_id")?).await? {
        return Ok(None);
    }
    Ok(Some(NoticeHome {
        id: format!("task:{task_id}"),
        account_id,
        conversation_id: row.try_get("conversation_id")?,
        thread_id: row.try_get("thread_id")?,
    }))
}

/// A route verifies while its Tag is active and, for a connector of a managed Surface Account,
/// while that account is enabled.
async fn route_verified_in(
    tx: &mut Transaction<'_, Any>,
    connector_account_id: &str,
    tag_id: &str,
) -> Result<bool> {
    let retired: Option<Option<i64>> =
        sqlx::query_scalar("SELECT retired_at_ms FROM supertag_v2_tags WHERE tag_id=$1")
            .bind(tag_id)
            .fetch_optional(&mut **tx)
            .await?;
    if !matches!(retired, Some(None)) {
        return Ok(false);
    }
    let account: Option<Vec<u8>> = sqlx::query_scalar("SELECT account.payload FROM supertag_v2_managed_connector_aliases alias JOIN supertag_v2_surface_accounts account ON account.account_id=alias.account_id WHERE alias.connector_account_id=$1")
        .bind(connector_account_id).fetch_optional(&mut **tx).await?;
    Ok(match account {
        Some(bytes) => crate::policy::decode::<SurfaceAccount>(&bytes)?.enabled,
        None => true,
    })
}

/// Posts a Control Plane report once to an Objective's notice home, keyed by `key` within the
/// Objective and the home, so a changed home gets the report once more. An Objective without a
/// home posts nothing. A report the home Tag can no longer accept is skipped: the change it
/// reports has already happened and must not be undone by its notice. `limit_key` names the
/// limit event a limit notice reports, which must still hold when it is delivered.
pub(crate) async fn home_report_in(
    tx: &mut Transaction<'_, Any>,
    objective_id: &str,
    tag_id: &str,
    key: &str,
    limit_key: Option<&str>,
    text: &str,
    now_ms: i64,
) -> Result<()> {
    let Some(home) = notice_home_in(tx, objective_id).await? else {
        return Ok(());
    };
    let notice_key = format!("report:{key}@{}", home.id);
    let prior: Option<String> = sqlx::query_scalar(
        "SELECT task_id FROM supertag_v2_objective_notices WHERE objective_id=$1 AND notice_key=$2",
    )
    .bind(objective_id)
    .bind(&notice_key)
    .fetch_optional(&mut **tx)
    .await?;
    if prior.is_some() {
        return Ok(());
    }
    let mut savepoint = tx.begin().await?;
    let order = next_order(&mut savepoint).await?;
    let task = match Box::pin(status_in(
        &mut savepoint,
        order,
        tag_id,
        &format!("Objective {objective_id} report {key}"),
        text,
        now_ms,
    ))
    .await
    {
        Ok(task) => task,
        Err(
            StoreError::FailedPrecondition(_)
            | StoreError::InvalidArgument(_)
            | StoreError::PermissionDenied
            | StoreError::NotFound(_),
        ) => {
            savepoint.rollback().await?;
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    sqlx::query("INSERT INTO supertag_v2_objective_notices (objective_id,notice_key,task_id,home,limit_key) VALUES ($1,$2,$3,$4,$5)")
        .bind(objective_id).bind(&notice_key).bind(&task.task_id).bind(&home.id).bind(limit_key).execute(&mut *savepoint).await?;
    sqlx::query("INSERT INTO supertag_v2_replies (reply_id, task_id, account_id, conversation_id, thread_id, text, state, ready_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)")
        .bind(Uuid::new_v4().to_string()).bind(&task.task_id)
        .bind(&home.account_id).bind(&home.conversation_id)
        .bind(&home.thread_id).bind(text)
        .bind(ReplyState::Pending as i64).bind(order).execute(&mut *savepoint).await?;
    savepoint.commit().await?;
    Ok(())
}

impl crate::Store {
    /// Records the deployment's default notice thread (TypeScript
    /// `SUPERTAG_OPERATOR_NOTIFICATION_TASK_ID`), or clears it. An Objective with no chosen
    /// thread and no start thread posts its notices there while the Task verifies. Every
    /// Control Plane replica of one deployment must be started with the same value.
    pub async fn set_default_notification_task(&self, task_id: Option<&str>) -> Result<()> {
        let (mut tx, _) = self.write().await?;
        sqlx::query("DELETE FROM supertag_v2_notification_defaults")
            .execute(&mut *tx)
            .await?;
        if let Some(task_id) = task_id {
            crate::store::name("notification Task ID", task_id)?;
            // It must name a surface Task; whether its thread still verifies is checked at
            // each use, so a later retired Tag never stops the Control Plane from starting.
            let surface: Option<String> = sqlx::query_scalar(
                "SELECT task_id FROM supertag_v2_inbound_events WHERE task_id=$1",
            )
            .bind(task_id)
            .fetch_optional(&mut *tx)
            .await?;
            if surface.is_none() {
                return Err(StoreError::InvalidArgument(
                    "the default notification Task must be a Task a surface message started".into(),
                ));
            }
            sqlx::query(
                "INSERT INTO supertag_v2_notification_defaults (singleton, task_id) VALUES (1, $1)",
            )
            .bind(task_id)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }
}

/// TS `BudgetNotifications.mayDeliver`: just before a limit notice is delivered, it must still
/// apply. A notice whose Objective closed, whose limit event no longer holds (a raised budget or
/// moved deadline), or whose home changed or no longer verifies (a retired Tag, a disabled
/// Surface Account) is withdrawn: failed with the reason recorded, never posted. Returns whether
/// the reply was withdrawn.
pub(crate) async fn withdraw_stale_notice_in(
    tx: &mut Transaction<'_, Any>,
    reply_id: &str,
    now_ms: i64,
) -> Result<bool> {
    let Some(notice) = sqlx::query("SELECT n.objective_id, n.home, n.limit_key FROM supertag_v2_replies r JOIN supertag_v2_objective_notices n ON n.task_id=r.task_id WHERE r.reply_id=$1 AND n.limit_key IS NOT NULL")
        .bind(reply_id).fetch_optional(&mut **tx).await? else {
        return Ok(false);
    };
    let objective_id: String = notice.try_get("objective_id")?;
    let limit_key: String = notice.try_get("limit_key")?;
    let home: Option<String> = notice.try_get("home")?;
    if objectives::limit_notice_applies_in(tx, &objective_id, &limit_key).await?
        && notice_home_in(tx, &objective_id).await?.map(|home| home.id) == home
    {
        return Ok(false);
    }
    sqlx::query("UPDATE supertag_v2_replies SET state=$1 WHERE reply_id=$2")
        .bind(ReplyState::Failed as i64)
        .bind(reply_id)
        .execute(&mut **tx)
        .await?;
    crate::replies::audit_in(
        tx,
        reply_id,
        ReplyDeliveryAudit {
            kind: "withdrawn".into(),
            principal: "system".into(),
            evidence: "Operator notification was superseded, resolved, or its destination is no longer verified".into(),
            recorded_at_ms: now_ms,
            state: ReplyState::Failed.into(),
            provider_receipt: None,
        },
    )
    .await?;
    Ok(true)
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
