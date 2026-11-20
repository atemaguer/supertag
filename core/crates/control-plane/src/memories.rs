//! A Tag's memory and the daily review that keeps it current.
//!
//! A Tag's memory is its harness's own (Claude Code's auto-memory, Codex's memories folder, or
//! for OpenCode and Cursor, which keep none, a folder in Claude Code's format),
//! which Worker Hosts keep, one store per Tag, harness, and audience ([`crate::native_memory`]).
//! The Control Plane never holds it. It decides which turns' changes are the Tag's own
//! ([`trusted_in`]): a root turn or the review, when an outside event did not start it. Any other
//! turn that gets the store, such as a Work Session's own turn, only proposes its changes, which
//! the host keeps beside the store for the review to merge or drop.
//!
//! Each store is reviewed: the maintenance sweep queues a review turn for a store once a day after
//! enough of its turns ([`finish_in`] counts them), never while another review of that store is
//! queued or running. The shared store's review runs in the Tag's reserved Session `memory:TAG`
//! and reads the Tag's shared Sessions; a person's runs in `memory:TAG:SCOPE`, which only that
//! person sees ([`review_audience_in`]), and reads only that person's own Sessions. Either corrects
//! its store against them with the harness's own tools; it has no tool that reaches anyone, and
//! it ends with `stay_quiet` (attention.rs), so it posts nothing. It runs read-only: of the Tag's
//! actions it keeps only reading files, and the harness's memory folder stays writable.
//!
//! The notes Tags kept before (`remember` and `forget`) were moved by migration 121 into seeds,
//! which the next trusted turn on the Tag's harness writes into its store ([`seeds_in`]).
use crate::AttemptAccess;
use sqlx::{Any, Row, Transaction};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};

use crate::{
    ControlPlane, Store, StoreError,
    store::{Result, insert_task, invalid, name, next_order, owned},
    tag_sessions::Audience,
};

/// Turns of a store finished since its last review before the next one, and the least time
/// between.
const REVIEW_AFTER_TURNS: i64 = 10;
const REVIEW_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;
/// Sessions a review turn's prompt names, and the recent Sessions it picks them from.
const REVIEW_SESSIONS: usize = 30;
const REVIEW_CANDIDATES: i64 = 500;
const SWEEP_BATCH: i64 = 32;
/// Seeds one grant carries, and one acknowledgement names.
const MAX_SEEDS: i64 = 200;

const SESSION_PREFIX: &str = supertag_protocol::MEMORY_REVIEW_SESSION_PREFIX;

/// The reserved Session a Tag's review turns run in.
pub(crate) fn review_session(session: &str) -> bool {
    session.starts_with(SESSION_PREFIX)
}

fn review_session_of(tag: &str) -> String {
    format!("{SESSION_PREFIX}{tag}")
}

/// Whether a Tag being written keeps memory: as requested, else as it was. A new Tag does.
pub(crate) async fn enabled_in(
    tx: &mut Transaction<'_, Any>,
    tag_id: &str,
    requested: Option<bool>,
) -> Result<bool> {
    if let Some(memory) = requested {
        return Ok(memory);
    }
    Ok(
        sqlx::query_scalar::<_, i64>("SELECT memory FROM supertag_v2_tags WHERE tag_id=$1")
            .bind(tag_id)
            .fetch_optional(&mut **tx)
            .await?
            .is_none_or(|memory| memory != 0),
    )
}

pub(crate) async fn tag_keeps_memory_in(
    tx: &mut Transaction<'_, Any>,
    tag_id: &str,
) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT memory FROM supertag_v2_tags WHERE tag_id=$1 AND retired_at_ms IS NULL",
    )
    .bind(tag_id)
    .fetch_optional(&mut **tx)
    .await?
        == Some(1))
}

/// A started outside event, such as a GitHub or Linear webhook, never gets memory: its text is
/// whatever someone outside put in an issue or pull request.
pub(crate) fn external_origin(task: &Task) -> bool {
    use surface_location_scope::Provider;
    matches!(
        task.policy_snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.origin.as_ref())
            .and_then(|origin| origin.scope.as_ref())
            .and_then(|scope| scope.provider.as_ref()),
        Some(Provider::Github(_) | Provider::Linear(_))
    )
}

/// The memory a turn uses: `Some(None)` shared, `Some(Some(principal))` private to that person.
/// `None` when its audience is a private Session with no recorded person, which keeps none.
pub(crate) async fn turn_audience_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
) -> Result<Option<Option<String>>> {
    Ok(
        match crate::tag_sessions::audience_in(tx, &task.tag_id, &task.session_id).await? {
            Audience::Shared => Some(None),
            Audience::Private(Some(principal)) => Some(Some(principal)),
            Audience::Private(None) => None,
        },
    )
}

/// The turn-shape half of [`trusted_in`], which reads nothing: a root turn or the review, not a
/// Work Session's own turn, a reserved Session's, a surface status turn, or an outside event's.
fn trusted_shape(task: &Task, kind: Option<i64>) -> bool {
    !(matches!(kind, Some(kind) if kind != crate::work_sessions::REPORT)
        || crate::work_sessions::reserved_session(&task.session_id)
        || task.session_id.starts_with("surface-status:")
        || external_origin(task))
}

/// Whether what the turn changes in its Tag's memory is the Tag's own, rather than a proposal:
/// its Tag keeps memory, it has an audience, and [`trusted_shape`]. `kind` is its Work Session
/// scope, if any.
pub(crate) async fn trusted_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    kind: Option<i64>,
) -> Result<bool> {
    if !trusted_shape(task, kind) || !tag_keeps_memory_in(tx, &task.tag_id).await? {
        return Ok(false);
    }
    Ok(turn_audience_in(tx, task).await?.is_some())
}

/// [`trusted_shape`] for a turn, reading its Work Session scope.
pub(crate) async fn trusted_turn_in(tx: &mut Transaction<'_, Any>, task: &Task) -> Result<bool> {
    let kind = crate::work_sessions::task_scope_in(tx, &task.task_id)
        .await?
        .map(|scope| scope.kind);
    Ok(trusted_shape(task, kind))
}

/// The seeds a trusted turn writes into its store before it starts: the notes its Tag kept for
/// this audience before its harness's memory became its memory, oldest first.
pub(crate) async fn seeds_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    audience: Option<&str>,
) -> Result<Vec<NativeMemorySeed>> {
    let rows = sqlx::query(
        "SELECT seed_id,text,created_at_ms FROM supertag_v2_native_memory_seeds
         WHERE tag_id=$1 AND audience_principal=$2 ORDER BY created_at_ms, seed_id LIMIT $3",
    )
    .bind(&task.tag_id)
    .bind(audience.unwrap_or(""))
    .bind(MAX_SEEDS)
    .fetch_all(&mut **tx)
    .await?;
    rows.iter()
        .map(|row| {
            Ok(NativeMemorySeed {
                seed_id: row.try_get("seed_id")?,
                text: row.try_get("text")?,
                created_at_ms: row.try_get("created_at_ms")?,
            })
        })
        .collect()
}

impl Store {
    /// The host wrote the grant's seeds into the turn's store: they go, and no later turn gets
    /// them. Seeds of another Tag or audience, or already gone, are ignored, so a repeated
    /// acknowledgement changes nothing.
    pub async fn acknowledge_native_memory_seeds(
        &self,
        authority: &AttemptAccess,
        input: &AcknowledgeNativeMemorySeedsRequest,
    ) -> Result<()> {
        if input.seed_ids.len() > MAX_SEEDS as usize {
            return Err(invalid("too many seeds in one acknowledgement"));
        }
        for seed in &input.seed_ids {
            name("seed ID", seed)?;
        }
        let host = authority.host();
        let attempt = authority.lease();
        let (mut tx, _) = self.write().await?;
        let row = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        let task = crate::store::task_row(&row)?;
        let Some(audience) = turn_audience_in(&mut tx, &task).await? else {
            return Err(StoreError::PermissionDenied);
        };
        for seed in &input.seed_ids {
            sqlx::query(
                "DELETE FROM supertag_v2_native_memory_seeds
                 WHERE seed_id=$1 AND tag_id=$2 AND audience_principal=$3",
            )
            .bind(seed)
            .bind(&task.tag_id)
            .bind(audience.as_deref().unwrap_or(""))
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Queues each due review, one for each store that is due.
    pub async fn sweep_memory(&self) -> Result<u64> {
        let now = self.execution_now_ms();
        let due = due_reviews(&self.pool, now).await?;
        if due.is_empty() {
            return Ok(0);
        }
        let (mut tx, _) = self.write().await?;
        let mut queued = 0;
        for (tag, audience) in due {
            if queue_review_in(&mut tx, &tag, &audience, now).await? {
                queued += 1;
            }
        }
        tx.commit().await?;
        Ok(queued)
    }
}

/// The reserved Session a store's reviews run in: `memory:TAG` for the shared store, and for a
/// person's `memory:TAG:SCOPE`, with the scope the Worker Host names that person's store by.
fn review_session_for(tag: &str, audience: Option<&str>) -> String {
    match audience {
        None => review_session_of(tag),
        Some(_) => format!(
            "{}:{}",
            review_session_of(tag),
            supertag_protocol::native_memory_scope(audience)
        ),
    }
}

/// The audience of one of the Tag's review Sessions: shared for `memory:TAG`, the person whose
/// store it reviews for theirs, and no one for a Session no store names.
pub(crate) async fn review_audience_in(
    tx: &mut Transaction<'_, Any>,
    tag: &str,
    session: &str,
) -> Result<Audience> {
    if session == review_session_of(tag) {
        return Ok(Audience::Shared);
    }
    let principal: Option<String> = sqlx::query_scalar(
        "SELECT audience_principal FROM supertag_v2_memory_reviews WHERE tag_id=$1 AND session_id=$2",
    )
    .bind(tag)
    .bind(session)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(Audience::Private(
        principal.filter(|principal| !principal.is_empty()),
    ))
}

/// Counts a finished turn toward its store's next review: a turn whose changes are the Tag's own,
/// other than a review. Its audience is the store's: the shared store for shared work, a person's
/// store for that person's own Sessions.
pub(crate) async fn finish_in(tx: &mut Transaction<'_, Any>, task: &Task, now: i64) -> Result<()> {
    if review_session(&task.session_id) || !trusted_turn_in(tx, task).await? {
        return Ok(());
    }
    if !tag_keeps_memory_in(tx, &task.tag_id).await? {
        return Ok(());
    }
    let Some(audience) = turn_audience_in(tx, task).await? else {
        return Ok(());
    };
    sqlx::query(
        "INSERT INTO supertag_v2_memory_reviews
            (tag_id,audience_principal,session_id,turns,first_turn_at_ms)
         VALUES ($1,$2,$3,1,$4)
         ON CONFLICT (tag_id,audience_principal)
         DO UPDATE SET turns=supertag_v2_memory_reviews.turns+1",
    )
    .bind(&task.tag_id)
    .bind(audience.as_deref().unwrap_or(""))
    .bind(review_session_for(&task.tag_id, audience.as_deref()))
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Stores due a review, by Tag and audience ('' for shared): their Tag keeps memory, enough of
/// their turns finished since their last review, and they were last reviewed long enough ago. A
/// store never reviewed waits the same interval from its first counted turn, so a new Tag's
/// first few quick exchanges don't trigger a review at once.
async fn due_reviews(pool: &sqlx::AnyPool, now: i64) -> Result<Vec<(String, String)>> {
    let rows = sqlx::query(
        "SELECT r.tag_id,r.audience_principal FROM supertag_v2_memory_reviews r
         JOIN supertag_v2_tags g ON g.tag_id=r.tag_id
         WHERE g.memory=1 AND g.retired_at_ms IS NULL AND r.turns>=$1
           AND COALESCE(r.reviewed_at_ms,r.first_turn_at_ms)<=$2
         ORDER BY r.tag_id,r.audience_principal LIMIT $3",
    )
    .bind(REVIEW_AFTER_TURNS)
    .bind(now - REVIEW_INTERVAL_MS)
    .bind(SWEEP_BATCH)
    .fetch_all(pool)
    .await?;
    rows.iter()
        .map(|row| Ok((row.try_get("tag_id")?, row.try_get("audience_principal")?)))
        .collect()
}

/// The Sessions a store's review names: those of its audience with work since `since`, most
/// recent first. A person's review names only that person's own Sessions; the shared review only
/// shared ones.
async fn review_sessions_in(
    tx: &mut Transaction<'_, Any>,
    tag: &str,
    audience: &Audience,
    since: i64,
) -> Result<Vec<String>> {
    let candidates: Vec<String> = sqlx::query_scalar(
        "SELECT session_id FROM supertag_v2_tasks
         WHERE tag_id=$1 AND state=$2 AND completed_at_ms>$3 AND substr(session_id,1,7)<>'memory:'
         GROUP BY session_id ORDER BY MAX(completed_at_ms) DESC LIMIT $4",
    )
    .bind(tag)
    .bind(TaskState::Succeeded as i64)
    .bind(since)
    .bind(REVIEW_CANDIDATES)
    .fetch_all(&mut **tx)
    .await?;
    let mut sessions = vec![];
    for session in candidates {
        if crate::tag_sessions::audience_in(tx, tag, &session).await? == *audience {
            sessions.push(session);
            if sessions.len() == REVIEW_SESSIONS {
                break;
            }
        }
    }
    Ok(sessions)
}

/// Queues the review of the Tag's store for `audience` ('' for shared), unless one of that store
/// is still queued or running.
async fn queue_review_in(
    tx: &mut Transaction<'_, Any>,
    tag: &str,
    audience: &str,
    now: i64,
) -> Result<bool> {
    let row = sqlx::query(
        "SELECT session_id,reviewed_at_ms FROM supertag_v2_memory_reviews
         WHERE tag_id=$1 AND audience_principal=$2",
    )
    .bind(tag)
    .bind(audience)
    .fetch_one(&mut **tx)
    .await?;
    let session: String = row.try_get("session_id")?;
    let since: Option<i64> = row.try_get("reviewed_at_ms")?;
    let open: Option<String> = sqlx::query_scalar(
        "SELECT task_id FROM supertag_v2_tasks WHERE tag_id=$1 AND session_id=$2 AND state IN ($3,$4,$5) LIMIT 1",
    )
    .bind(tag)
    .bind(&session)
    .bind(TaskState::Queued as i64)
    .bind(TaskState::Claimed as i64)
    .bind(TaskState::Running as i64)
    .fetch_optional(&mut **tx)
    .await?;
    if open.is_some() {
        return Ok(false);
    }
    let shared = audience.is_empty();
    let readers = if shared {
        Audience::Shared
    } else {
        Audience::Private(Some(audience.to_owned()))
    };
    let sessions = review_sessions_in(tx, tag, &readers, since.unwrap_or(0)).await?;
    let prompt = review_prompt(since, shared, &sessions);
    let order = next_order(tx).await?;
    let task = Box::pin(insert_task(tx, order, tag, &session, &prompt)).await?;
    // The review reads the Tag's work and keeps its memory; it changes nothing else. It runs
    // read-only in the Tag's Workspace, whatever else the Tag may do; the harness's memory folder
    // stays writable under any allowed actions. Writing or running a command implies reading, as
    // harnesses read the Workspace in every mode.
    let reads = task.allowed_actions.iter().any(|action| {
        matches!(
            action.as_str(),
            "files:read" | "files:write" | "commands:execute"
        )
    });
    sqlx::query("UPDATE supertag_v2_tasks SET allowed_actions=$1 WHERE task_id=$2")
        .bind(if reads { r#"["files:read"]"# } else { "[]" })
        .bind(&task.task_id)
        .execute(&mut **tx)
        .await?;
    sqlx::query(
        "UPDATE supertag_v2_memory_reviews SET turns=0,reviewed_at_ms=$1,review_task_id=$2
         WHERE tag_id=$3 AND audience_principal=$4",
    )
    .bind(now)
    .bind(&task.task_id)
    .bind(tag)
    .bind(audience)
    .execute(&mut **tx)
    .await?;
    sqlx::query("UPDATE supertag_v2_tags SET memory_reviewed_at_ms=$1 WHERE tag_id=$2")
        .bind(now)
        .bind(tag)
        .execute(&mut **tx)
        .await?;
    Ok(true)
}

/// The review turn's request. Its Worker Host adds the proposals waiting for it, which the
/// Control Plane never sees.
fn review_prompt(since: Option<i64>, shared: bool, sessions: &[String]) -> String {
    let since = match since.and_then(chrono::DateTime::from_timestamp_millis) {
        Some(at) => format!(
            "since {}",
            at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        ),
        None => "so far".to_owned(),
    };
    let (memory, readable) = if shared {
        (
            "your own memory, the memory folder your harness keeps for the Tag's shared work",
            "you may see only shared Sessions",
        )
    } else {
        (
            "your own memory of one person, the memory folder your harness keeps private to them",
            "you may see only that person's own Sessions",
        )
    };
    let mut text = format!(
        "Memory review. Review your work {since} and keep {memory}, current. Read the Sessions below with read_session, and read_turn for detail; {readable}, and they are the record. Then, in your memory: correct what the Sessions contradict, merge duplicates, rewrite time-relative facts with their dates, keep only what you can't look up again (drop what the repository or the Sessions already record), and remove what no longer matters. Merge or drop the proposals listed below, if any. Don't contact anyone. Finish by calling stay_quiet with one line saying what you changed."
    );
    if sessions.is_empty() {
        text.push_str("\nSessions: none listed; use list_sessions.");
    } else {
        text.push_str("\nSessions:");
        for session in sessions {
            text.push_str(&format!("\n- {session}"));
        }
    }
    text
}

/// Retiring a Tag drops its review state, and what [`retire_tag_in`] drops.
pub(crate) async fn retire_reviews_in(tx: &mut Transaction<'_, Any>, tag: &str) -> Result<()> {
    sqlx::query("DELETE FROM supertag_v2_memory_reviews WHERE tag_id=$1")
        .bind(tag)
        .execute(&mut **tx)
        .await?;
    retire_tag_in(tx, tag).await
}

/// Retiring a Tag drops its seeds and its native memory records.
pub(crate) async fn retire_tag_in(tx: &mut Transaction<'_, Any>, tag: &str) -> Result<()> {
    sqlx::query("DELETE FROM supertag_v2_native_memory_seeds WHERE tag_id=$1")
        .bind(tag)
        .execute(&mut **tx)
        .await?;
    crate::native_memory::retire_tag_in(tx, tag).await
}

impl ControlPlane {
    pub fn memories_service(&self) -> memories_server::MemoriesServer<Self> {
        memories_server::MemoriesServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn attempt_memory_service(&self) -> attempt_memory_server::AttemptMemoryServer<Self> {
        attempt_memory_server::AttemptMemoryServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl memories_server::Memories for ControlPlane {
    async fn reset_native(
        &self,
        request: Request<ResetNativeMemoryRequest>,
    ) -> std::result::Result<Response<ResetNativeMemoryResponse>, Status> {
        let principal = self.actor(&request)?;
        Ok(Response::new(
            self.store
                .reset_native_memory(&principal, request.get_ref())
                .await?,
        ))
    }
}

#[tonic::async_trait]
impl attempt_memory_server::AttemptMemory for ControlPlane {
    async fn report_native(
        &self,
        request: Request<ReportNativeMemoryRequest>,
    ) -> std::result::Result<Response<ReportNativeMemoryResponse>, Status> {
        let host = self.attempt(&request).await?;
        self.store
            .report_native_memory(&host, request.get_ref())
            .await?;
        Ok(Response::new(ReportNativeMemoryResponse {}))
    }

    async fn advance_native(
        &self,
        request: Request<AdvanceNativeMemoryRequest>,
    ) -> std::result::Result<Response<AdvanceNativeMemoryResponse>, Status> {
        let host = self.attempt(&request).await?;
        Ok(Response::new(
            self.store
                .advance_native_memory(&host, request.get_ref())
                .await?,
        ))
    }

    async fn acknowledge_seeds(
        &self,
        request: Request<AcknowledgeNativeMemorySeedsRequest>,
    ) -> std::result::Result<Response<AcknowledgeNativeMemorySeedsResponse>, Status> {
        let host = self.attempt(&request).await?;
        self.store
            .acknowledge_native_memory_seeds(&host, request.get_ref())
            .await?;
        Ok(Response::new(AcknowledgeNativeMemorySeedsResponse {}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_and_linear_events_never_keep_memory() {
        use surface_location_scope::Provider;
        let task = |provider: Option<Provider>| Task {
            policy_snapshot: Some(TaskPolicySnapshot {
                origin: Some(SurfacePolicyOrigin {
                    scope: Some(SurfaceLocationScope { provider }),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(external_origin(&task(Some(Provider::Github(
            GithubSurfaceRepository::default()
        )))));
        assert!(external_origin(&task(Some(Provider::Linear(
            LinearSurfaceTeam::default()
        )))));
        assert!(!external_origin(&task(Some(Provider::Slack(
            SlackSurfaceChannel::default()
        )))));
        assert!(!external_origin(&task(None)));
        assert!(!external_origin(&Task::default()));
    }

    #[test]
    fn the_review_names_its_sessions_and_its_harness_memory() {
        let prompt = review_prompt(Some(0), true, &["conversation:alice".into()]);
        assert!(prompt.contains("your own memory"), "{prompt}");
        assert!(prompt.contains("only shared Sessions"), "{prompt}");
        let private = review_prompt(None, false, &[]);
        assert!(private.contains("private to them"), "{private}");
        assert!(
            private.contains("only that person's own Sessions"),
            "{private}"
        );
        assert!(prompt.contains("proposals"), "{prompt}");
        assert!(prompt.contains("stay_quiet"), "{prompt}");
        assert!(prompt.ends_with("\n- conversation:alice"), "{prompt}");
        assert!(!prompt.contains("remember"), "{prompt}");
    }
}
