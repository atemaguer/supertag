//! Schedules: durable wake-ups for one Tag, once (`at`) or on a cron recurrence in an IANA time
//! zone.
//!
//! A Tag creates one with its `schedule` tool; it is staged against the turn and becomes active
//! only when that turn succeeds, as questions and `report_objective` do. Operators and clients
//! create active ones in their own conversation with the Tag. The maintenance sweep finds due
//! Schedules, advances or completes each with a compare-and-set, and queues an ordinary Task in
//! its Session. It never starts a run: the Session queue, the Objective's pause, limits and budget,
//! and the Tag's current policy decide when and how the turn runs.
use crate::AttemptAccess;
use chrono::{DateTime, LocalResult, NaiveDateTime, TimeZone};
use chrono_tz::Tz;
use croner::{
    Cron,
    parser::{CronParser, Seconds},
};
use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};
use uuid::Uuid;

use crate::{
    ControlPlane, HostAuthority, Store, StoreError,
    store::{Result, insert_task, invalid, lease_is_live, name, next_order, owned, task_row},
};

pub(crate) const STAGED: i64 = ScheduleState::Staged as i64;
pub(crate) const ACTIVE: i64 = ScheduleState::Active as i64;
pub(crate) const PAUSED: i64 = ScheduleState::Paused as i64;
pub(crate) const DONE: i64 = ScheduleState::Done as i64;
pub(crate) const CANCELLED: i64 = ScheduleState::Cancelled as i64;

/// The runtime action that offers a root turn the `schedule` and `cancel_schedule` tools.
pub(crate) const SCHEDULE_CREATE_ACTION: &str = "schedule:create";

const NOTE_MAX_CHARS: usize = 4_000;
const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const DAY_MS: i64 = 24 * HOUR_MS;
/// A one-off is due from one minute to 366 days ahead.
const AT_MIN_MS: i64 = MINUTE_MS;
const AT_MAX_MS: i64 = 366 * DAY_MS;
/// Consecutive occurrences of a recurrence are at least an hour apart, checked over this many.
const MIN_INTERVAL_MS: i64 = HOUR_MS;
const INTERVAL_CHECKS: usize = 48;
/// Staged, active, and paused Schedules one Tag may hold.
const PER_TAG: i64 = 25;
/// Schedules one turn may create.
const PER_TURN: i64 = 3;
/// Due Schedules one sweep fires; the rest fire on the next pass.
const SWEEP_BATCH: i64 = 64;
/// Turns one backfill queues at most.
const BACKFILL_MAX: usize = 24;
/// Missed occurrences counted before a recurrence skips to the next future one.
const MISSED_SCAN: u64 = 100_000;

/// When a Schedule fires.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum When {
    At(i64),
    Every { cron: String, zone: Tz },
}

/// The Control Plane's time zone: `SUPERTAG_TIME_ZONE`, else the machine's, else UTC.
pub(crate) fn default_zone() -> Tz {
    std::env::var("SUPERTAG_TIME_ZONE")
        .ok()
        .or_else(|| iana_time_zone::get_timezone().ok())
        .and_then(|zone| zone.parse().ok())
        .unwrap_or(Tz::UTC)
}

fn zone(value: Option<&str>, default: Tz) -> Result<Tz> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(default),
        Some(value) => value.parse().map_err(|_| {
            invalid(&format!(
                "unknown time zone {value:?}; use an IANA name such as Europe/Berlin"
            ))
        }),
    }
}

fn cron(expression: &str) -> Result<Cron> {
    CronParser::builder()
        .seconds(Seconds::Disallowed)
        .build()
        .parse(expression)
        .map_err(|error| {
            invalid(&format!(
                "every must be a five-field cron expression such as \"0 9 * * MON\", or @hourly, @daily, or @weekly: {error}"
            ))
        })
}

/// The first occurrence of `expression` in `zone` strictly after `after_ms`.
pub(crate) fn next_after(expression: &str, zone: Tz, after_ms: i64) -> Result<Option<i64>> {
    let cron = cron(expression)?;
    let after = zone
        .timestamp_millis_opt(after_ms)
        .single()
        .ok_or_else(|| {
            StoreError::FailedPrecondition("time is outside the supported range".into())
        })?;
    Ok(cron
        .find_next_occurrence(&after, false)
        .ok()
        .map(|next| next.timestamp_millis()))
}

/// A duration such as `90m`, `2h`, `3d`, `1w`, or `1h30m`.
fn duration_ms(value: &str) -> Option<i64> {
    let mut total: i64 = 0;
    let mut digits = String::new();
    let mut parts = 0;
    for character in value.chars().filter(|c| !c.is_whitespace()) {
        if character.is_ascii_digit() {
            digits.push(character);
            continue;
        }
        let unit = match character {
            'm' => MINUTE_MS,
            'h' => HOUR_MS,
            'd' => DAY_MS,
            'w' => 7 * DAY_MS,
            _ => return None,
        };
        let count: i64 = digits.parse().ok()?;
        digits.clear();
        total = total.checked_add(count.checked_mul(unit)?)?;
        parts += 1;
    }
    (digits.is_empty() && parts > 0).then_some(total)
}

/// An RFC 3339 time, or a local date and time read in `zone`.
fn instant_ms(value: &str, zone: Tz) -> Result<Option<i64>> {
    if let Ok(time) = DateTime::parse_from_rfc3339(value) {
        return Ok(Some(time.timestamp_millis()));
    }
    let local = [
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
    ]
    .iter()
    .find_map(|format| NaiveDateTime::parse_from_str(value, format).ok());
    let Some(local) = local else {
        return Ok(None);
    };
    match zone.from_local_datetime(&local) {
        LocalResult::Single(time) => Ok(Some(time.timestamp_millis())),
        // A repeated hour fires on its first occurrence.
        LocalResult::Ambiguous(first, _) => Ok(Some(first.timestamp_millis())),
        LocalResult::None => Err(invalid(&format!(
            "{value} does not exist in {zone}: the clocks skip it"
        ))),
    }
}

/// Reads exactly one of `at` and `every`. `at` is checked against `now_ms`.
pub(crate) fn parse_when(
    at: &str,
    every: &str,
    time_zone: Option<&str>,
    default: Tz,
    now_ms: i64,
) -> Result<When> {
    let (at, every) = (at.trim(), every.trim());
    let zone = zone(time_zone, default)?;
    match (at.is_empty(), every.is_empty()) {
        (false, true) => {
            let due = match duration_ms(at) {
                Some(ahead) => now_ms.saturating_add(ahead),
                None => instant_ms(at, zone)?.ok_or_else(|| {
                    invalid(
                        "at must be a duration such as 90m, 2h, or 3d, or a time such as 2026-11-17T09:00",
                    )
                })?,
            };
            let ahead = due - now_ms;
            if !(AT_MIN_MS..=AT_MAX_MS).contains(&ahead) {
                return Err(invalid("at must be from 1 minute to 366 days ahead"));
            }
            Ok(When::At(due))
        }
        (true, false) => {
            let schedule = cron(every)?;
            let start = zone.timestamp_millis_opt(now_ms).single().ok_or_else(|| {
                StoreError::FailedPrecondition("time is outside the supported range".into())
            })?;
            let occurrences: Vec<i64> = schedule
                .iter_after(start)
                .take(INTERVAL_CHECKS + 1)
                .map(|time| time.timestamp_millis())
                .collect();
            if occurrences.is_empty() {
                return Err(invalid("every never occurs"));
            }
            if occurrences
                .windows(2)
                .any(|pair| pair[1] - pair[0] < MIN_INTERVAL_MS)
            {
                return Err(invalid(
                    "every must be at least one hour between occurrences",
                ));
            }
            Ok(When::Every {
                cron: every.to_owned(),
                zone,
            })
        }
        _ => Err(invalid("give exactly one of at and every")),
    }
}

fn note(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > NOTE_MAX_CHARS || value.contains('\0') {
        return Err(invalid(
            "the note must contain 1–4,000 characters without a NUL",
        ));
    }
    Ok(value.to_owned())
}

fn first_due(when: &When, now_ms: i64) -> Result<i64> {
    match when {
        When::At(due) => Ok(*due),
        When::Every { cron, zone } => {
            next_after(cron, *zone, now_ms)?.ok_or_else(|| invalid("every never occurs"))
        }
    }
}

pub(crate) fn schedule_row(row: &AnyRow) -> Result<Schedule> {
    let cron: Option<String> = row.try_get("cron")?;
    let zone: Option<String> = row.try_get("time_zone")?;
    Ok(Schedule {
        schedule_id: row.try_get("schedule_id")?,
        tag_id: row.try_get("tag_id")?,
        session_id: row.try_get("session_id")?,
        note: row.try_get("note")?,
        at_ms: row.try_get("at_ms")?,
        every: cron.map(|cron| ScheduleRecurrence {
            cron,
            time_zone: zone.unwrap_or_default(),
        }),
        state: row.try_get::<i64, _>("state")? as i32,
        next_due_at_ms: row.try_get("next_due_at_ms")?,
        created_by: row.try_get("created_by")?,
        created_at_ms: row.try_get("created_at_ms")?,
        objective_id: row.try_get("objective_id")?,
        fire_count: row.try_get::<i64, _>("fire_count")? as u64,
        missed_count: row.try_get::<i64, _>("missed_count")? as u64,
        last_task_id: row.try_get("last_task_id")?,
        last_fired_at_ms: row.try_get("last_fired_at_ms")?,
        audience: row.try_get("audience_principal")?,
        revision: row.try_get::<i64, _>("revision")? as u64,
    })
}

async fn schedule_in(tx: &mut Transaction<'_, Any>, id: &str) -> Result<(Schedule, AnyRow)> {
    let row = sqlx::query("SELECT * FROM supertag_v2_schedules WHERE schedule_id=$1")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| StoreError::NotFound("Schedule was not found".into()))?;
    Ok((schedule_row(&row)?, row))
}

/// The Objective whose Session this is.
async fn objective_of_in(
    tx: &mut Transaction<'_, Any>,
    tag: &str,
    session: &str,
) -> Result<Option<String>> {
    Ok(sqlx::query_scalar(
        "SELECT objective_id FROM supertag_v2_objective_sessions WHERE tag_id=$1 AND session_id=$2",
    )
    .bind(tag)
    .bind(session)
    .fetch_optional(&mut **tx)
    .await?)
}

async fn tag_limit_in(tx: &mut Transaction<'_, Any>, tag: &str) -> Result<()> {
    let held: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM supertag_v2_schedules WHERE tag_id=$1 AND state IN ($2,$3,$4)",
    )
    .bind(tag)
    .bind(STAGED)
    .bind(ACTIVE)
    .bind(PAUSED)
    .fetch_one(&mut **tx)
    .await?;
    if held >= PER_TAG {
        return Err(StoreError::FailedPrecondition(format!(
            "this Tag already has {PER_TAG} Schedules; cancel one first"
        )));
    }
    Ok(())
}

struct NewSchedule<'a> {
    tag: &'a str,
    session: &'a str,
    audience: Option<&'a str>,
    note: &'a str,
    when: &'a When,
    state: i64,
    created_by: &'a str,
    origin: Option<(&'a str, &'a str)>,
    /// A chosen ID, as a manifest declares it; otherwise a new one.
    id: Option<&'a str>,
}

async fn insert_in(
    tx: &mut Transaction<'_, Any>,
    value: NewSchedule<'_>,
    now_ms: i64,
) -> Result<Schedule> {
    let id = value
        .id
        .map_or_else(|| format!("sch_{}", Uuid::new_v4().simple()), str::to_owned);
    let objective = objective_of_in(tx, value.tag, value.session).await?;
    let (at, cron, zone) = match value.when {
        When::At(due) => (Some(*due), None, None),
        When::Every { cron, zone } => (None, Some(cron.clone()), Some(zone.name().to_owned())),
    };
    let due = first_due(value.when, now_ms)?;
    sqlx::query("INSERT INTO supertag_v2_schedules (schedule_id,tag_id,session_id,audience_principal,note,at_ms,cron,time_zone,state,next_due_at_ms,created_by,origin_task_id,origin_attempt_id,objective_id,created_at_ms,updated_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)")
        .bind(&id).bind(value.tag).bind(value.session).bind(value.audience).bind(value.note)
        .bind(at).bind(cron).bind(zone).bind(value.state).bind(due).bind(value.created_by)
        .bind(value.origin.map(|(task, _)| task)).bind(value.origin.map(|(_, attempt)| attempt))
        .bind(objective).bind(now_ms)
        .execute(&mut **tx).await?;
    Ok(schedule_in(tx, &id).await?.0)
}

fn digest(value: &impl serde::Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}

/// The prior Schedule of an exact replay, or a conflict for a different request.
async fn receipt_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    operation: &str,
    request_digest: &str,
) -> Result<Option<Schedule>> {
    let Some(prior) = sqlx::query("SELECT request_digest,schedule_id FROM supertag_v2_schedule_receipts WHERE principal=$1 AND operation_id=$2")
        .bind(principal).bind(operation).fetch_optional(&mut **tx).await?
    else {
        return Ok(None);
    };
    if prior.try_get::<String, _>("request_digest")? != request_digest {
        return Err(StoreError::Conflict(
            "operation ID was used with a different Schedule".into(),
        ));
    }
    Ok(Some(
        schedule_in(tx, &prior.try_get::<String, _>("schedule_id")?)
            .await?
            .0,
    ))
}

async fn record_receipt_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    operation: &str,
    request_digest: &str,
    schedule: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO supertag_v2_schedule_receipts (principal,operation_id,request_digest,schedule_id) VALUES ($1,$2,$3,$4)")
        .bind(principal).bind(operation).bind(request_digest).bind(schedule)
        .execute(&mut **tx).await?;
    Ok(())
}

/// Whether the principal sees the Schedule: its own conversation's, or as an operator, any
/// Schedule a client's or no conversation holds.
fn visible(principal: &str, schedule: &Schedule) -> bool {
    crate::store::sees_owner(principal, schedule.audience.as_deref().unwrap_or(""))
}

/// The turn's Task, when it is a live running root turn that may schedule.
async fn scheduling_turn_in(
    tx: &mut Transaction<'_, Any>,
    host: &HostAuthority,
    attempt: Option<&InspectAttemptRequest>,
    now_ms: i64,
) -> Result<(Task, InspectAttemptRequest)> {
    let attempt = attempt.ok_or_else(|| invalid("Attempt identity is required"))?;
    let row = owned(
        tx,
        host,
        &attempt.task_id,
        &attempt.attempt_id,
        &attempt.lease_token,
    )
    .await?;
    if row.try_get::<i64, _>("state")? != TaskState::Running as i64 || !lease_is_live(&row, now_ms)?
    {
        return Err(StoreError::FailedPrecondition(
            "scheduling requires a live running Attempt".into(),
        ));
    }
    let task = task_row(&row)?;
    if !may_schedule_in(tx, &task).await? {
        return Err(StoreError::PermissionDenied);
    }
    Ok((task, attempt.clone()))
}

/// A root turn may schedule when its admitted actions include `schedule:create`: not a Work
/// Session's Task, a report, or a Mailbox delivery.
pub(crate) async fn may_schedule_in(tx: &mut Transaction<'_, Any>, task: &Task) -> Result<bool> {
    if !task
        .allowed_actions
        .iter()
        .any(|action| action == SCHEDULE_CREATE_ACTION)
        || crate::work_sessions::reserved_session(&task.session_id)
        || crate::mailbox::private_session(&task.session_id)
        || crate::memories::review_session(&task.session_id)
    {
        return Ok(false);
    }
    Ok(crate::work_sessions::task_scope_in(tx, &task.task_id)
        .await?
        .is_none())
}

/// The conversation's principal when the Session is a conversation's.
async fn audience_in(
    tx: &mut Transaction<'_, Any>,
    tag: &str,
    session: &str,
) -> Result<Option<String>> {
    if !crate::conversations::private_session(session) {
        return Ok(None);
    }
    Ok(sqlx::query_scalar(
        "SELECT principal FROM supertag_v2_conversation_sessions WHERE session_id=$1 AND tag_id=$2",
    )
    .bind(session)
    .bind(tag)
    .fetch_optional(&mut **tx)
    .await?)
}

/// The Tag's other staged and active Schedules in the turn's Session (or conversation).
async fn pending_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    except: Option<&str>,
) -> Result<Vec<Schedule>> {
    let audience = audience_in(tx, &task.tag_id, &task.session_id).await?;
    let rows = sqlx::query("SELECT * FROM supertag_v2_schedules WHERE tag_id=$1 AND state IN ($2,$3) AND (session_id=$4 OR (audience_principal IS NOT NULL AND audience_principal=$5)) AND schedule_id<>$6 ORDER BY next_due_at_ms,schedule_id LIMIT $7")
        .bind(&task.tag_id).bind(STAGED).bind(ACTIVE).bind(&task.session_id)
        .bind(audience.unwrap_or_default()).bind(except.unwrap_or("")).bind(PER_TAG)
        .fetch_all(&mut **tx).await?;
    rows.iter().map(schedule_row).collect()
}

/// Lines for the turn's context: the Schedules this Session already has.
pub(crate) async fn portfolio_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    zone: Tz,
) -> Result<Option<String>> {
    let pending = pending_in(tx, task, None).await?;
    if pending.is_empty() {
        return Ok(None);
    }
    let mut lines = vec![
        "Schedules this Tag has set in this Session (cancel_schedule cancels one):".to_owned(),
    ];
    for schedule in pending {
        lines.push(format!("- {}", describe(&schedule, zone)));
    }
    Ok(Some(lines.join("\n")))
}

fn local(ms: i64, zone: Tz) -> String {
    zone.timestamp_millis_opt(ms)
        .single()
        .map(|time| time.format("%a %d %b %Y %H:%M %Z").to_string())
        .unwrap_or_else(|| ms.to_string())
}

/// One line: ID, next time, recurrence, and note.
pub(crate) fn describe(schedule: &Schedule, default: Tz) -> String {
    let zone = schedule
        .every
        .as_ref()
        .and_then(|every| every.time_zone.parse().ok())
        .unwrap_or(default);
    let next = schedule
        .next_due_at_ms
        .map(|ms| local(ms, zone))
        .unwrap_or_else(|| "never".into());
    let recurrence = match &schedule.every {
        Some(every) => format!("every {} ({})", every.cron, every.time_zone),
        None => "once".into(),
    };
    let note: String = schedule.note.chars().take(160).collect();
    format!("{} next {next}, {recurrence}: {note}", schedule.schedule_id)
}

impl Store {
    pub async fn create_schedule(
        &self,
        principal: &str,
        input: &CreateScheduleRequest,
    ) -> Result<Schedule> {
        crate::store::actor(principal)?;
        name("operation ID", &input.operation_id)?;
        name("Tag ID", &input.tag_id)?;
        self.ensure_client_tag(principal, &input.tag_id).await?;
        let note = note(&input.note)?;
        let request = digest(&(
            &input.tag_id,
            &note,
            input.at.trim(),
            input.every.trim(),
            &input.time_zone,
        ))?;
        let now = self.execution_now_ms();
        let when = parse_when(
            &input.at,
            &input.every,
            input.time_zone.as_deref(),
            self.time_zone(),
            now,
        )?;
        let (mut tx, _) = self.write().await?;
        if let Some(prior) = receipt_in(&mut tx, principal, &input.operation_id, &request).await? {
            tx.rollback().await?;
            return Ok(prior);
        }
        crate::tags::require_active(&mut tx, &input.tag_id).await?;
        tag_limit_in(&mut tx, &input.tag_id).await?;
        // The conversation's latest Session, or the one its first message will open.
        let session = crate::conversations::session_in(&mut tx, principal, &input.tag_id)
            .await?
            .unwrap_or_else(crate::conversations::new_session_id);
        let schedule = insert_in(
            &mut tx,
            NewSchedule {
                tag: &input.tag_id,
                session: &session,
                audience: Some(principal),
                note: &note,
                when: &when,
                state: ACTIVE,
                created_by: principal,
                origin: None,
                id: None,
            },
            now,
        )
        .await?;
        record_receipt_in(
            &mut tx,
            principal,
            &input.operation_id,
            &request,
            &schedule.schedule_id,
        )
        .await?;
        tx.commit().await?;
        Ok(schedule)
    }

    /// Creates or replaces a recurring Schedule by its ID, as a `kind: Schedule` manifest
    /// declares it. It fires in the operator's conversation with the Tag.
    pub async fn put_schedule(
        &self,
        principal: &str,
        input: &PutScheduleRequest,
    ) -> Result<Schedule> {
        crate::policy::operator(principal)?;
        let id = input.schedule_id.as_str();
        if id.is_empty()
            || id.len() > 63
            || !id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            return Err(invalid(
                "a Schedule ID has 1 to 63 lowercase letters, digits, and hyphens",
            ));
        }
        name("Tag ID", &input.tag_id)?;
        let note = note(&input.note)?;
        if input.every.trim().is_empty() {
            return Err(invalid("a declared Schedule recurs: set every"));
        }
        let now = self.execution_now_ms();
        let when = parse_when(
            "",
            &input.every,
            input.time_zone.as_deref(),
            self.time_zone(),
            now,
        )?;
        let When::Every { cron, zone } = &when else {
            return Err(invalid("a declared Schedule recurs: set every"));
        };
        let (mut tx, _) = self.write().await?;
        crate::tags::require_active(&mut tx, &input.tag_id).await?;
        let prior = sqlx::query("SELECT * FROM supertag_v2_schedules WHERE schedule_id=$1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
        let schedule = match prior {
            None => {
                tag_limit_in(&mut tx, &input.tag_id).await?;
                let session = crate::conversations::session_in(&mut tx, principal, &input.tag_id)
                    .await?
                    .unwrap_or_else(crate::conversations::new_session_id);
                insert_in(
                    &mut tx,
                    NewSchedule {
                        tag: &input.tag_id,
                        session: &session,
                        audience: Some(principal),
                        note: &note,
                        when: &when,
                        state: ACTIVE,
                        created_by: principal,
                        origin: None,
                        id: Some(id),
                    },
                    now,
                )
                .await?
            }
            Some(row) => {
                let prior = schedule_row(&row)?;
                if prior.tag_id != input.tag_id {
                    return Err(StoreError::FailedPrecondition(format!(
                        "Schedule {id} wakes Tag {}; delete it to declare it for another Tag",
                        prior.tag_id
                    )));
                }
                if prior.every.is_none() {
                    return Err(StoreError::FailedPrecondition(format!(
                        "Schedule {id} is a one-off; delete it to declare a recurring one"
                    )));
                }
                // A cancelled or finished one is declared again; a paused one stays paused.
                let state = if prior.state() == ScheduleState::Paused {
                    PAUSED
                } else {
                    ACTIVE
                };
                let next = next_after(cron, *zone, now)?;
                sqlx::query("UPDATE supertag_v2_schedules SET note=$1,cron=$2,time_zone=$3,state=$4,next_due_at_ms=$5,updated_at_ms=$6,revision=revision+1 WHERE schedule_id=$7")
                    .bind(&note).bind(cron).bind(zone.name()).bind(state).bind(next).bind(now).bind(id)
                    .execute(&mut *tx).await?;
                schedule_in(&mut tx, id).await?.0
            }
        };
        tx.commit().await?;
        Ok(schedule)
    }

    /// Replays a recurring Schedule's occurrences from `from_ms` until now that queued no turn.
    pub async fn backfill_schedule(
        &self,
        principal: &str,
        input: &BackfillScheduleRequest,
    ) -> Result<BackfillScheduleResponse> {
        crate::store::actor(principal)?;
        name("Schedule ID", &input.schedule_id)?;
        let now = self.execution_now_ms();
        if input.from_ms >= now || input.from_ms < now - AT_MAX_MS {
            return Err(invalid(
                "backfill from a time in the past, at most 366 days ago",
            ));
        }
        let (mut tx, _) = self.write().await?;
        let (schedule, row) = schedule_in(&mut tx, &input.schedule_id).await?;
        if !visible(principal, &schedule) {
            return Err(StoreError::NotFound("Schedule was not found".into()));
        }
        let Some(every) = schedule.every.clone() else {
            return Err(StoreError::FailedPrecondition(
                "only a recurring Schedule has occurrences to backfill".into(),
            ));
        };
        if !matches!(
            schedule.state(),
            ScheduleState::Active | ScheduleState::Paused
        ) {
            return Err(StoreError::FailedPrecondition(format!(
                "a {} Schedule is not backfilled",
                state_name(schedule.state())
            )));
        }
        let zone = zone(Some(&every.time_zone), self.time_zone())?;
        // Occurrences from `from_ms` (and since the Schedule existed) until now.
        let start = input.from_ms.max(schedule.created_at_ms) - 1;
        let mut occurrences = vec![];
        let mut cursor = next_after(&every.cron, zone, start)?;
        while let Some(due) = cursor
            && due <= now
            && occurrences.len() < MISSED_SCAN as usize
        {
            occurrences.push(due);
            cursor = next_after(&every.cron, zone, due)?;
        }
        let mut missing = vec![];
        for due in occurrences {
            let fired: Option<Option<String>> = sqlx::query_scalar(
                "SELECT task_id FROM supertag_v2_schedule_fires WHERE schedule_id=$1 AND due_at_ms=$2",
            )
            .bind(&schedule.schedule_id)
            .bind(due)
            .fetch_optional(&mut *tx)
            .await?;
            if !matches!(fired, Some(Some(_))) {
                missing.push(due);
            }
        }
        let skipped = missing.len().saturating_sub(BACKFILL_MAX) as u32;
        let mut task_ids = vec![];
        for due in missing.into_iter().take(BACKFILL_MAX) {
            let text = format!(
                "Backfilled wake-up. An operator asked to replay the occurrence of this Schedule due {} (it queued no turn then). The note: \"{}\". It is now {}. This Schedule recurs ({}, {}). Do what the note asks for that occurrence. Your reply is posted as a normal message; if nothing needs attention, call stay_quiet with one line saying why, and nothing is posted.",
                local(due, zone),
                schedule.note,
                local(now, zone),
                every.cron,
                zone.name(),
            );
            let task = queue_turn_in(&mut tx, &schedule, &row, due, &text, now).await?;
            task_ids.push(task.task_id);
        }
        let (schedule, _) = schedule_in(&mut tx, &input.schedule_id).await?;
        tx.commit().await?;
        Ok(BackfillScheduleResponse {
            schedule: Some(schedule),
            task_ids,
            skipped,
        })
    }

    pub async fn get_schedule(&self, principal: &str, id: &str) -> Result<Schedule> {
        crate::store::actor(principal)?;
        name("Schedule ID", id)?;
        let mut tx = self.pool.begin().await?;
        let (schedule, _) = schedule_in(&mut tx, id).await?;
        tx.commit().await?;
        if !visible(principal, &schedule) {
            return Err(StoreError::NotFound("Schedule was not found".into()));
        }
        Ok(schedule)
    }

    pub async fn list_schedules(
        &self,
        principal: &str,
        input: &ListSchedulesRequest,
    ) -> Result<ListSchedulesResponse> {
        crate::store::actor(principal)?;
        if let Some(tag) = &input.tag_id {
            name("Tag ID", tag)?;
        }
        let mut tx = self.pool.begin().await?;
        let rows = sqlx::query("SELECT * FROM supertag_v2_schedules WHERE ($1='' OR tag_id=$1) AND (state IN ($2,$3,$4) OR $5=1) ORDER BY CASE WHEN next_due_at_ms IS NULL THEN 1 ELSE 0 END,next_due_at_ms,created_at_ms,schedule_id LIMIT 1000")
            .bind(input.tag_id.as_deref().unwrap_or("")).bind(STAGED).bind(ACTIVE).bind(PAUSED)
            .bind(i64::from(input.include_finished)).fetch_all(&mut *tx).await?;
        tx.commit().await?;
        let mut schedules = vec![];
        for row in &rows {
            let schedule = schedule_row(row)?;
            if visible(principal, &schedule) {
                schedules.push(schedule);
            }
        }
        Ok(ListSchedulesResponse { schedules })
    }

    /// Pauses, resumes, or cancels a visible Schedule. Repeating a change is a no-op.
    pub async fn change_schedule(
        &self,
        principal: &str,
        id: &str,
        target: ScheduleState,
    ) -> Result<Schedule> {
        crate::store::actor(principal)?;
        name("Schedule ID", id)?;
        let now = self.execution_now_ms();
        let (mut tx, _) = self.write().await?;
        let (schedule, row) = schedule_in(&mut tx, id).await?;
        if !visible(principal, &schedule) {
            return Err(StoreError::NotFound("Schedule was not found".into()));
        }
        let state = schedule.state();
        if state == target {
            tx.rollback().await?;
            return Ok(schedule);
        }
        let next: Option<i64> = match (target, state) {
            (ScheduleState::Paused, ScheduleState::Active) => schedule.next_due_at_ms,
            (ScheduleState::Active, ScheduleState::Paused) => {
                match (row.try_get::<Option<String>, _>("cron")?, &schedule.every) {
                    // A recurrence resumes at its next occurrence; a one-off keeps its time,
                    // firing at once when it passed.
                    (Some(cron), Some(every)) => {
                        next_after(&cron, zone(Some(&every.time_zone), Tz::UTC)?, now)?
                    }
                    _ => schedule.next_due_at_ms,
                }
            }
            (
                ScheduleState::Cancelled,
                ScheduleState::Staged | ScheduleState::Active | ScheduleState::Paused,
            ) => None,
            (ScheduleState::Paused | ScheduleState::Active, _) => {
                return Err(StoreError::FailedPrecondition(format!(
                    "a {} Schedule cannot be {}",
                    state_name(state),
                    if target == ScheduleState::Paused {
                        "paused"
                    } else {
                        "resumed"
                    }
                )));
            }
            (ScheduleState::Cancelled, _) => {
                tx.rollback().await?;
                return Ok(schedule);
            }
            _ => return Err(invalid("unsupported Schedule change")),
        };
        sqlx::query("UPDATE supertag_v2_schedules SET state=$1,next_due_at_ms=$2,updated_at_ms=$3,revision=revision+1 WHERE schedule_id=$4")
            .bind(target as i64).bind(next).bind(now).bind(id).execute(&mut *tx).await?;
        let (schedule, _) = schedule_in(&mut tx, id).await?;
        tx.commit().await?;
        Ok(schedule)
    }

    /// The `schedule` tool: stages a Schedule that takes effect when the turn succeeds.
    pub async fn create_attempt_schedule(
        &self,
        authority: &AttemptAccess,
        input: &CreateAttemptScheduleRequest,
    ) -> Result<AttemptScheduleResponse> {
        let host = authority.host();
        name("operation ID", &input.operation_id)?;
        let note = note(&input.note)?;
        let now = self.execution_now_ms();
        let zone_default = self.time_zone();
        let when = parse_when(
            &input.at,
            &input.every,
            input.time_zone.as_deref(),
            zone_default,
            now,
        )?;
        let (mut tx, _) = self.write().await?;
        let (task, attempt) =
            scheduling_turn_in(&mut tx, host, Some(authority.lease()), now).await?;
        // Replays are per Task: a retried Attempt reuses its call identities.
        let principal = format!("task:{}", task.task_id);
        let request = digest(&(
            &attempt.attempt_id,
            &note,
            input.at.trim(),
            input.every.trim(),
            &input.time_zone,
        ))?;
        let schedule = match receipt_in(&mut tx, &principal, &input.operation_id, &request).await? {
            Some(prior) => prior,
            None => {
                let created: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM supertag_v2_schedules WHERE origin_attempt_id=$1",
                )
                .bind(&attempt.attempt_id)
                .fetch_one(&mut *tx)
                .await?;
                if created >= PER_TURN {
                    return Err(StoreError::FailedPrecondition(format!(
                        "a turn may create at most {PER_TURN} Schedules"
                    )));
                }
                tag_limit_in(&mut tx, &task.tag_id).await?;
                let audience = audience_in(&mut tx, &task.tag_id, &task.session_id).await?;
                let schedule = insert_in(
                    &mut tx,
                    NewSchedule {
                        tag: &task.tag_id,
                        session: &task.session_id,
                        audience: audience.as_deref(),
                        note: &note,
                        when: &when,
                        state: STAGED,
                        created_by: &format!("tag:{}", task.tag_id),
                        origin: Some((&task.task_id, &attempt.attempt_id)),
                        id: None,
                    },
                    now,
                )
                .await?;
                record_receipt_in(
                    &mut tx,
                    &principal,
                    &input.operation_id,
                    &request,
                    &schedule.schedule_id,
                )
                .await?;
                schedule
            }
        };
        let pending = pending_in(&mut tx, &task, Some(&schedule.schedule_id)).await?;
        tx.commit().await?;
        Ok(AttemptScheduleResponse {
            schedule: Some(schedule),
            pending,
            time_zone: zone_default.name().to_owned(),
        })
    }

    /// The `cancel_schedule` tool, for the Tag's own Schedules in the turn's Session.
    pub async fn cancel_attempt_schedule(
        &self,
        authority: &AttemptAccess,
        input: &CancelAttemptScheduleRequest,
    ) -> Result<AttemptScheduleResponse> {
        let host = authority.host();
        name("Schedule ID", &input.schedule_id)?;
        let now = self.execution_now_ms();
        let (mut tx, _) = self.write().await?;
        let (task, _) = scheduling_turn_in(&mut tx, host, Some(authority.lease()), now).await?;
        let (schedule, _) = schedule_in(&mut tx, &input.schedule_id).await?;
        let audience = audience_in(&mut tx, &task.tag_id, &task.session_id).await?;
        if schedule.tag_id != task.tag_id
            || !(schedule.session_id == task.session_id
                || (schedule.audience.is_some() && schedule.audience == audience))
        {
            return Err(StoreError::NotFound(
                "Schedule was not found in this Session".into(),
            ));
        }
        sqlx::query("UPDATE supertag_v2_schedules SET state=$1,next_due_at_ms=NULL,updated_at_ms=$2 WHERE schedule_id=$3 AND state IN ($4,$5,$6)")
            .bind(CANCELLED).bind(now).bind(&schedule.schedule_id).bind(STAGED).bind(ACTIVE).bind(PAUSED)
            .execute(&mut *tx).await?;
        let (schedule, _) = schedule_in(&mut tx, &input.schedule_id).await?;
        let pending = pending_in(&mut tx, &task, Some(&schedule.schedule_id)).await?;
        tx.commit().await?;
        Ok(AttemptScheduleResponse {
            schedule: Some(schedule),
            pending,
            time_zone: self.time_zone().name().to_owned(),
        })
    }

    /// Fires due Schedules. Each fire is a compare-and-set on the Schedule's due time plus a
    /// unique fire row, so replicas sharing a database fire each occurrence once.
    pub async fn sweep_schedules(&self) -> Result<u64> {
        let now = self.execution_now_ms();
        // Most passes find nothing to do; only take the write lock when they might.
        let work: Option<String> = sqlx::query_scalar("SELECT schedule_id FROM supertag_v2_schedules WHERE state=$1 OR (state=$2 AND next_due_at_ms<=$3) LIMIT 1")
            .bind(STAGED).bind(ACTIVE).bind(now).fetch_optional(&self.pool).await?;
        if work.is_none() {
            return Ok(0);
        }
        let (mut tx, _) = self.write().await?;
        // A staged Schedule whose turn no longer runs never takes effect.
        let stale = sqlx::query("DELETE FROM supertag_v2_schedules WHERE state=$1 AND NOT EXISTS (SELECT 1 FROM supertag_v2_tasks t WHERE t.task_id=supertag_v2_schedules.origin_task_id AND t.attempt_id=supertag_v2_schedules.origin_attempt_id AND t.state IN ($2,$3))")
            .bind(STAGED).bind(TaskState::Claimed as i64).bind(TaskState::Running as i64)
            .execute(&mut *tx).await?.rows_affected();
        let due = sqlx::query("SELECT * FROM supertag_v2_schedules WHERE state=$1 AND next_due_at_ms<=$2 ORDER BY next_due_at_ms,schedule_id LIMIT $3")
            .bind(ACTIVE).bind(now).bind(SWEEP_BATCH).fetch_all(&mut *tx).await?;
        let mut fired = 0;
        for row in &due {
            if fire_in(&mut tx, row, now, self.time_zone()).await? {
                fired += 1;
            }
        }
        if stale == 0 && due.is_empty() {
            tx.rollback().await?;
        } else {
            tx.commit().await?;
        }
        if fired > 0 {
            // A fired turn is a new conversation message: wake the open follows.
            drop(self.hint_after_commit());
        }
        Ok(fired)
    }

    pub(crate) fn time_zone(&self) -> Tz {
        self.time_zone
    }

    /// Reads times in `zone` where a request names none, instead of [`default_zone`].
    pub fn with_time_zone(mut self, zone: &str) -> anyhow::Result<Self> {
        self.time_zone = zone
            .parse()
            .map_err(|_| anyhow::anyhow!("unknown time zone {zone:?}"))?;
        Ok(self)
    }
}

fn state_name(state: ScheduleState) -> &'static str {
    match state {
        ScheduleState::Staged => "staged",
        ScheduleState::Active => "active",
        ScheduleState::Paused => "paused",
        ScheduleState::Done => "done",
        ScheduleState::Cancelled => "cancelled",
        ScheduleState::Unspecified => "unknown",
    }
}

/// Advances one due Schedule and queues its turn. `false` when another pass already took this
/// occurrence or it coalesced into a turn still queued.
async fn fire_in(
    tx: &mut Transaction<'_, Any>,
    row: &AnyRow,
    now: i64,
    default: Tz,
) -> Result<bool> {
    let schedule = schedule_row(row)?;
    let due = schedule.next_due_at_ms.ok_or_else(|| {
        StoreError::FailedPrecondition("an active Schedule has no due time".into())
    })?;
    // A one-off is done; a recurrence skips the occurrences it missed to the next future one.
    let (next, state, missed) = match &schedule.every {
        None => (None, DONE, 0u64),
        Some(every) => {
            let zone = zone(Some(&every.time_zone), Tz::UTC)?;
            let mut next = next_after(&every.cron, zone, due)?;
            let mut missed = 0;
            while let Some(time) = next
                && time <= now
                && missed < MISSED_SCAN
            {
                missed += 1;
                next = next_after(&every.cron, zone, time)?;
            }
            if let Some(time) = next
                && time <= now
            {
                next = next_after(&every.cron, zone, now)?;
            }
            (next, if next.is_some() { ACTIVE } else { DONE }, missed)
        }
    };
    let claimed = sqlx::query("UPDATE supertag_v2_schedules SET next_due_at_ms=$1,state=$2,missed_count=missed_count+$3,updated_at_ms=$4 WHERE schedule_id=$5 AND next_due_at_ms=$6 AND state=$7")
        .bind(next).bind(state).bind(missed as i64).bind(now).bind(&schedule.schedule_id).bind(due).bind(ACTIVE)
        .execute(&mut **tx).await?.rows_affected();
    if claimed != 1 {
        return Ok(false);
    }
    // At most one queued turn per Schedule: a slow Session never stacks identical wake-ups.
    if let Some(last) = &schedule.last_task_id {
        let queued: Option<i64> =
            sqlx::query_scalar("SELECT state FROM supertag_v2_tasks WHERE task_id=$1")
                .bind(last)
                .fetch_optional(&mut **tx)
                .await?;
        if queued == Some(TaskState::Queued as i64) {
            sqlx::query(
                "UPDATE supertag_v2_schedules SET missed_count=missed_count+1 WHERE schedule_id=$1",
            )
            .bind(&schedule.schedule_id)
            .execute(&mut **tx)
            .await?;
            sqlx::query("INSERT INTO supertag_v2_schedule_fires (schedule_id,due_at_ms,task_id,fired_at_ms) VALUES ($1,$2,NULL,$3)")
                .bind(&schedule.schedule_id).bind(due).bind(now).execute(&mut **tx).await?;
            return Ok(false);
        }
    }
    let received = crate::attention::schedule_line_in(tx, &schedule.schedule_id).await?;
    let prompt = prompt(
        &schedule,
        row,
        (due, next),
        missed,
        (now, default),
        received.as_deref(),
    )?;
    queue_turn_in(tx, &schedule, row, due, &prompt, now).await?;
    Ok(true)
}

/// Queues one turn of a Schedule for its occurrence `due` and records the fire.
async fn queue_turn_in(
    tx: &mut Transaction<'_, Any>,
    schedule: &Schedule,
    row: &AnyRow,
    due: i64,
    prompt: &str,
    now: i64,
) -> Result<Task> {
    let session = match &schedule.audience {
        // A conversation's next turn goes to its latest Session.
        Some(principal) => {
            match crate::conversations::session_in(tx, principal, &schedule.tag_id).await? {
                Some(session) => session,
                None => {
                    let order = next_order(tx).await?;
                    sqlx::query("INSERT INTO supertag_v2_conversation_sessions (session_id,principal,tag_id,created_order) VALUES ($1,$2,$3,$4)")
                        .bind(&schedule.session_id).bind(principal).bind(&schedule.tag_id).bind(order)
                        .execute(&mut **tx).await?;
                    schedule.session_id.clone()
                }
            }
        }
        None => schedule.session_id.clone(),
    };
    let order = next_order(tx).await?;
    let task = Box::pin(insert_task(tx, order, &schedule.tag_id, &session, prompt)).await?;
    crate::objectives::objective_link_task_in(tx, &task).await?;
    // A planned continuation is a fresh opportunity to make progress, like a person's message.
    sqlx::query("UPDATE supertag_v2_objectives SET idle_wake_count=0, idle_since_ms=NULL WHERE objective_id IN (SELECT objective_id FROM supertag_v2_objective_sessions WHERE tag_id=$1 AND session_id=$2)")
        .bind(&task.tag_id).bind(&task.session_id).execute(&mut **tx).await?;
    let operation = format!("schedule/{}/{due}", schedule.schedule_id);
    match &schedule.audience {
        Some(principal) => {
            sqlx::query("INSERT INTO supertag_v2_conversation_messages (task_id,session_id,principal,operation_id,request_digest,accepted_order) VALUES ($1,$2,$3,$4,'',$5)")
                .bind(&task.task_id).bind(&session).bind(principal).bind(&operation).bind(order)
                .execute(&mut **tx).await?;
        }
        None => {
            // A surface thread's Schedule answers in the thread its turn came from.
            let source = schedule
                .last_task_id
                .clone()
                .or(row.try_get::<Option<String>, _>("origin_task_id")?);
            if let Some(source) = source {
                let route = digest(&operation)?;
                sqlx::query("INSERT INTO supertag_v2_inbound_events (account_id,event_id,request_digest,task_id,conversation_id,thread_id) SELECT account_id,$1,$2,$3,conversation_id,thread_id FROM supertag_v2_inbound_events WHERE task_id=$4")
                    .bind(&operation).bind(route).bind(&task.task_id).bind(source)
                    .execute(&mut **tx).await?;
            }
        }
    }
    // A backfill turns an occurrence that coalesced (a fire without a turn) into one with a turn.
    sqlx::query("INSERT INTO supertag_v2_schedule_fires (schedule_id,due_at_ms,task_id,fired_at_ms) VALUES ($1,$2,$3,$4) ON CONFLICT (schedule_id,due_at_ms) DO UPDATE SET task_id=excluded.task_id, fired_at_ms=excluded.fired_at_ms")
        .bind(&schedule.schedule_id).bind(due).bind(&task.task_id).bind(now).execute(&mut **tx).await?;
    sqlx::query("UPDATE supertag_v2_schedules SET fire_count=fire_count+1,last_task_id=$1,last_fired_at_ms=$2 WHERE schedule_id=$3")
        .bind(&task.task_id).bind(now).bind(&schedule.schedule_id).execute(&mut **tx).await?;
    Ok(task)
}

/// The fired turn's prompt. The conversation hides it; `describe task` shows it.
fn prompt(
    schedule: &Schedule,
    row: &AnyRow,
    (due, next): (i64, Option<i64>),
    missed: u64,
    (now, default): (i64, Tz),
    received: Option<&str>,
) -> Result<String> {
    let zone = match &schedule.every {
        Some(every) => zone(Some(&every.time_zone), default)?,
        None => default,
    };
    let who = if schedule.created_by.starts_with("tag:") {
        "you".to_owned()
    } else {
        schedule.created_by.clone()
    };
    let mut text = format!(
        "Scheduled wake-up. On {} {who} asked for this Tag to be woken at {}: \"{}\". It is now {}.",
        local(schedule.created_at_ms, zone),
        local(due, zone),
        schedule.note,
        local(now, zone),
    );
    if missed > 0 {
        text.push_str(&format!(
            " {missed} earlier occurrence{} passed while SuperTag could not fire {}.",
            if missed == 1 { "" } else { "s" },
            if missed == 1 { "it" } else { "them" }
        ));
    }
    match (row.try_get::<Option<String>, _>("cron")?, next) {
        (Some(cron), Some(next)) => text.push_str(&format!(
            " This Schedule recurs ({cron}, {}); next at {}. cancel_schedule {} stops it.",
            zone.name(),
            local(next, zone),
            schedule.schedule_id
        )),
        (Some(_), None) => text.push_str(" This Schedule does not occur again."),
        (None, _) => text.push_str(" This was a one-off."),
    }
    text.push_str(" Do what the note asks. Your reply is posted as a normal message; if nothing needs attention, call stay_quiet with one line saying why, and nothing is posted.");
    if let Some(line) = received {
        text.push(' ');
        text.push_str(line);
    }
    Ok(text)
}

/// Called when a turn finishes: its staged Schedules take effect if it succeeded and are
/// dropped otherwise.
pub(crate) async fn finish_in(tx: &mut Transaction<'_, Any>, task: &Task, now: i64) -> Result<()> {
    let Some(attempt) = &task.attempt_id else {
        return Ok(());
    };
    if task.state() == TaskState::Succeeded {
        sqlx::query("UPDATE supertag_v2_schedules SET state=$1,updated_at_ms=$2 WHERE origin_attempt_id=$3 AND state=$4")
            .bind(ACTIVE).bind(now).bind(attempt).bind(STAGED).execute(&mut **tx).await?;
    } else {
        sqlx::query("DELETE FROM supertag_v2_schedules WHERE origin_attempt_id=$1 AND state=$2")
            .bind(attempt)
            .bind(STAGED)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

/// Whether an active Schedule will wake the Objective's owner: waiting on it is not idleness.
pub(crate) async fn objective_waits_in(
    tx: &mut Transaction<'_, Any>,
    objective_id: &str,
) -> Result<bool> {
    let waiting: Option<String> = sqlx::query_scalar(
        "SELECT schedule_id FROM supertag_v2_schedules WHERE objective_id=$1 AND state=$2 LIMIT 1",
    )
    .bind(objective_id)
    .bind(ACTIVE)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(waiting.is_some())
}

/// A closed Objective's Schedules stop.
pub(crate) async fn close_objective_in(
    tx: &mut Transaction<'_, Any>,
    objective_id: &str,
    now: i64,
) -> Result<()> {
    sqlx::query("UPDATE supertag_v2_schedules SET state=$1,next_due_at_ms=NULL,updated_at_ms=$2 WHERE objective_id=$3 AND state IN ($4,$5,$6)")
        .bind(CANCELLED).bind(now).bind(objective_id).bind(STAGED).bind(ACTIVE).bind(PAUSED)
        .execute(&mut **tx).await?;
    Ok(())
}

/// An apply set prunes a declared Schedule it left at `expected`: it is cancelled.
pub(crate) async fn prune_in(
    tx: &mut Transaction<'_, Any>,
    id: &str,
    expected: u64,
    now: i64,
) -> Result<()> {
    let revision: Option<i64> =
        sqlx::query_scalar("SELECT revision FROM supertag_v2_schedules WHERE schedule_id=$1")
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?;
    match revision {
        None => Ok(()),
        Some(revision) if revision as u64 != expected => Err(StoreError::Conflict(
            "Schedule changed since it was applied".into(),
        )),
        Some(_) => {
            sqlx::query("UPDATE supertag_v2_schedules SET state=$1,next_due_at_ms=NULL,updated_at_ms=$2,revision=revision+1 WHERE schedule_id=$3 AND state IN ($4,$5,$6)")
                .bind(CANCELLED).bind(now).bind(id).bind(STAGED).bind(ACTIVE).bind(PAUSED)
                .execute(&mut **tx).await?;
            crate::apply_sets::forget(tx, "Schedule", id).await
        }
    }
}

/// A declared Schedule's revision, while it is not cancelled or done.
pub(crate) async fn revision_in(tx: &mut Transaction<'_, Any>, id: &str) -> Result<Option<u64>> {
    let revision: Option<i64> = sqlx::query_scalar(
        "SELECT revision FROM supertag_v2_schedules WHERE schedule_id=$1 AND state IN ($2,$3,$4)",
    )
    .bind(id)
    .bind(STAGED)
    .bind(ACTIVE)
    .bind(PAUSED)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(revision.map(|value| value as u64))
}

/// A retired Tag's Schedules stop.
pub(crate) async fn retire_tag_in(
    tx: &mut Transaction<'_, Any>,
    tag: &str,
    now: i64,
) -> Result<()> {
    sqlx::query("UPDATE supertag_v2_schedules SET state=$1,next_due_at_ms=NULL,updated_at_ms=$2 WHERE tag_id=$3 AND state IN ($4,$5,$6)")
        .bind(CANCELLED).bind(now).bind(tag).bind(STAGED).bind(ACTIVE).bind(PAUSED)
        .execute(&mut **tx).await?;
    Ok(())
}

/// The Schedules that queued these Tasks, by Task.
pub(crate) async fn fired_by_in(
    tx: &mut Transaction<'_, Any>,
    task_ids: &[&str],
) -> Result<std::collections::HashMap<String, String>> {
    let mut fired = std::collections::HashMap::new();
    for chunk in task_ids.chunks(crate::store::ID_BATCH) {
        let sql = format!(
            "SELECT task_id,schedule_id FROM supertag_v2_schedule_fires WHERE task_id IN ({})",
            crate::store::placeholders(1, chunk.len())
        );
        let mut query = sqlx::query(&sql);
        for id in chunk {
            query = query.bind(*id);
        }
        for row in query.fetch_all(&mut **tx).await? {
            fired.insert(row.try_get("task_id")?, row.try_get("schedule_id")?);
        }
    }
    Ok(fired)
}

impl ControlPlane {
    pub fn schedules_service(&self) -> schedules_server::SchedulesServer<Self> {
        schedules_server::SchedulesServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn attempt_schedules_service(
        &self,
    ) -> attempt_schedules_server::AttemptSchedulesServer<Self> {
        attempt_schedules_server::AttemptSchedulesServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl schedules_server::Schedules for ControlPlane {
    async fn create(
        &self,
        request: Request<CreateScheduleRequest>,
    ) -> std::result::Result<Response<Schedule>, Status> {
        let principal = self.actor(&request)?;
        Ok(Response::new(
            self.store
                .create_schedule(&principal, request.get_ref())
                .await?,
        ))
    }

    async fn get(
        &self,
        request: Request<GetScheduleRequest>,
    ) -> std::result::Result<Response<Schedule>, Status> {
        let principal = self.actor(&request)?;
        Ok(Response::new(
            self.store
                .get_schedule(&principal, &request.get_ref().schedule_id)
                .await?,
        ))
    }

    async fn list(
        &self,
        request: Request<ListSchedulesRequest>,
    ) -> std::result::Result<Response<ListSchedulesResponse>, Status> {
        let principal = self.actor(&request)?;
        Ok(Response::new(
            self.store
                .list_schedules(&principal, request.get_ref())
                .await?,
        ))
    }

    async fn pause(
        &self,
        request: Request<GetScheduleRequest>,
    ) -> std::result::Result<Response<Schedule>, Status> {
        self.change(request, ScheduleState::Paused).await
    }

    async fn resume(
        &self,
        request: Request<GetScheduleRequest>,
    ) -> std::result::Result<Response<Schedule>, Status> {
        self.change(request, ScheduleState::Active).await
    }

    async fn delete(
        &self,
        request: Request<GetScheduleRequest>,
    ) -> std::result::Result<Response<Schedule>, Status> {
        self.change(request, ScheduleState::Cancelled).await
    }

    async fn put(
        &self,
        request: Request<PutScheduleRequest>,
    ) -> std::result::Result<Response<Schedule>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .put_schedule(&principal, request.get_ref())
                .await?,
        ))
    }

    async fn backfill(
        &self,
        request: Request<BackfillScheduleRequest>,
    ) -> std::result::Result<Response<BackfillScheduleResponse>, Status> {
        let principal = self.actor(&request)?;
        Ok(Response::new(
            self.store
                .backfill_schedule(&principal, request.get_ref())
                .await?,
        ))
    }
}

impl ControlPlane {
    async fn change(
        &self,
        request: Request<GetScheduleRequest>,
        target: ScheduleState,
    ) -> std::result::Result<Response<Schedule>, Status> {
        let principal = self.actor(&request)?;
        Ok(Response::new(
            self.store
                .change_schedule(&principal, &request.get_ref().schedule_id, target)
                .await?,
        ))
    }
}

#[tonic::async_trait]
impl attempt_schedules_server::AttemptSchedules for ControlPlane {
    async fn create(
        &self,
        request: Request<CreateAttemptScheduleRequest>,
    ) -> std::result::Result<Response<AttemptScheduleResponse>, Status> {
        let host = self.attempt(&request).await?;
        Ok(Response::new(
            self.store
                .create_attempt_schedule(&host, request.get_ref())
                .await?,
        ))
    }

    async fn cancel(
        &self,
        request: Request<CancelAttemptScheduleRequest>,
    ) -> std::result::Result<Response<AttemptScheduleResponse>, Status> {
        let host = self.attempt(&request).await?;
        Ok(Response::new(
            self.store
                .cancel_attempt_schedule(&host, request.get_ref())
                .await?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    const NOW: i64 = 1_900_000_000_000;

    #[test]
    fn reads_durations_and_times() {
        assert_eq!(duration_ms("90m"), Some(90 * MINUTE_MS));
        assert_eq!(duration_ms("1h30m"), Some(90 * MINUTE_MS));
        assert_eq!(duration_ms("3d"), Some(3 * DAY_MS));
        assert_eq!(duration_ms("2 h"), Some(2 * HOUR_MS));
        assert_eq!(duration_ms("h"), None);
        assert_eq!(duration_ms("2x"), None);
        assert_eq!(duration_ms("next tuesday"), None);
        assert_eq!(
            parse_when("2h", "", None, Tz::UTC, NOW).unwrap(),
            When::At(NOW + 2 * HOUR_MS)
        );
        let berlin: Tz = "Europe/Berlin".parse().unwrap();
        let When::At(due) =
            parse_when("2030-04-01T09:00", "", Some("Europe/Berlin"), Tz::UTC, NOW).unwrap()
        else {
            panic!("a one-off")
        };
        assert_eq!(local(due, berlin), "Mon 01 Apr 2030 09:00 CEST");
        assert!(parse_when("30s", "", None, Tz::UTC, NOW).is_err());
        assert!(parse_when("0m", "", None, Tz::UTC, NOW).is_err());
        assert!(parse_when("367d", "", None, Tz::UTC, NOW).is_err());
        assert!(parse_when("next tuesday", "", None, Tz::UTC, NOW).is_err());
        assert!(parse_when("2h", "@daily", None, Tz::UTC, NOW).is_err());
        assert!(parse_when("", "", None, Tz::UTC, NOW).is_err());
        assert!(parse_when("2h", "", Some("Mars/Base"), Tz::UTC, NOW).is_err());
    }

    #[test]
    fn recurrences_are_at_least_an_hour_apart() {
        assert!(parse_when("", "0 9 * * MON", None, Tz::UTC, NOW).is_ok());
        assert!(parse_when("", "@hourly", None, Tz::UTC, NOW).is_ok());
        assert!(parse_when("", "@daily", None, Tz::UTC, NOW).is_ok());
        assert!(parse_when("", "*/30 * * * *", None, Tz::UTC, NOW).is_err());
        assert!(parse_when("", "0,30 9 * * *", None, Tz::UTC, NOW).is_err());
        assert!(parse_when("", "* * * * * *", None, Tz::UTC, NOW).is_err());
        assert!(parse_when("", "not cron", None, Tz::UTC, NOW).is_err());
    }

    #[test]
    fn recurrences_follow_their_zone_across_daylight_saving() {
        let berlin: Tz = "Europe/Berlin".parse().unwrap();
        // Saturday 2030-03-30 12:00 UTC; Berlin moves to summer time on Sunday 2030-03-31.
        let before = Utc
            .with_ymd_and_hms(2030, 3, 30, 12, 0, 0)
            .unwrap()
            .timestamp_millis();
        let sunday = next_after("0 9 * * *", berlin, before).unwrap().unwrap();
        let monday = next_after("0 9 * * *", berlin, sunday).unwrap().unwrap();
        assert_eq!(local(sunday, berlin), "Sun 31 Mar 2030 09:00 CEST");
        assert_eq!(local(monday, berlin), "Mon 01 Apr 2030 09:00 CEST");
        // 02:30 does not exist that Sunday; the job runs right after the gap.
        let gap = next_after("30 2 * * *", berlin, before).unwrap().unwrap();
        assert_eq!(local(gap, berlin), "Sun 31 Mar 2030 03:00 CEST");
        assert!(
            parse_when(
                "2030-03-31T02:30",
                "",
                Some("Europe/Berlin"),
                Tz::UTC,
                before
            )
            .is_err()
        );
    }
}
