//! `supertag schedule create|pause|resume`, and the Schedule rows of `get`, `describe`, and
//! `delete`. A Schedule wakes a Tag later in a conversation, once or on a recurrence; a Tag
//! usually creates its own with its `schedule` tool.
use anyhow::Result;
use clap::{Args, Subcommand};
use serde_json::{Value, json};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        CreateScheduleRequest, GetScheduleRequest, ListSchedulesRequest, Schedule,
        schedules_client::SchedulesClient,
    },
};
use uuid::Uuid;

use crate::{Connection, connect_operator, request};

#[derive(Subcommand)]
pub enum ScheduleCommand {
    /// Wake a Tag later in your conversation with it, once (--at) or on a recurrence (--every).
    /// The note is what the Tag is asked to do when it wakes.
    Create {
        /// The Tag to wake.
        #[arg(long)]
        tag: String,
        /// Once: a duration ahead such as 90m, 2h, or 3d, or a time such as 2026-11-17T09:00.
        #[arg(long, required_unless_present = "every", conflicts_with = "every")]
        at: Option<String>,
        /// Recurring: a five-field cron expression such as "0 9 * * MON", or @hourly, @daily,
        /// or @weekly, at least an hour apart.
        #[arg(long)]
        every: Option<String>,
        /// The IANA time zone that times and recurrences are read in, such as Europe/Berlin.
        /// Defaults to the Control Plane's.
        #[arg(long)]
        time_zone: Option<String>,
        /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
        #[arg(long)]
        operation_id: Option<String>,
        /// What the Tag should do when it wakes.
        note: String,
    },
    /// Stop a Schedule firing until it is resumed.
    Pause {
        /// Schedule ID.
        schedule_id: String,
    },
    /// Let a paused Schedule fire again. A recurrence continues at its next occurrence; a
    /// one-off whose time passed fires at once.
    Resume {
        /// Schedule ID.
        schedule_id: String,
    },
}

/// Options for `supertag get schedules`.
#[derive(Args)]
pub struct ListArgs {
    /// Only this Tag's Schedules.
    #[arg(long, conflicts_with = "id")]
    tag: Option<String>,
    /// Include Schedules that are done or cancelled.
    #[arg(long, conflicts_with = "id")]
    all: bool,
}

/// Options for `supertag delete schedule`.
#[derive(Args)]
pub struct DeleteArgs {
    /// Check that the Schedule exists and show what would be deleted, without deleting it.
    #[arg(long)]
    pub(crate) dry_run: bool,
}

fn client(channel: ProtocolChannel) -> SchedulesClient<ProtocolChannel> {
    SchedulesClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

pub async fn run(connection: Connection, command: ScheduleCommand) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let mut client = client(channel);
    let schedule = match command {
        ScheduleCommand::Create {
            tag,
            at,
            every,
            time_zone,
            operation_id,
            note,
        } => client
            .create(request(
                CreateScheduleRequest {
                    operation_id: operation_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
                    tag_id: tag,
                    note,
                    at: at.unwrap_or_default(),
                    every: every.unwrap_or_default(),
                    time_zone,
                },
                &token,
            )?)
            .await?
            .into_inner(),
        ScheduleCommand::Pause { schedule_id } => client
            .pause(request(GetScheduleRequest { schedule_id }, &token)?)
            .await?
            .into_inner(),
        ScheduleCommand::Resume { schedule_id } => client
            .resume(request(GetScheduleRequest { schedule_id }, &token)?)
            .await?
            .into_inner(),
    };
    crate::terminal::print_json(&schedule_json(&schedule))?;
    Ok(())
}

pub(crate) async fn fetch(
    channel: ProtocolChannel,
    token: &str,
    schedule_id: String,
) -> Result<Value> {
    Ok(schedule_json(
        &client(channel)
            .get(request(GetScheduleRequest { schedule_id }, token)?)
            .await?
            .into_inner(),
    ))
}

pub(crate) async fn list(connection: Connection, args: ListArgs) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let listed = client(channel)
        .list(request(
            ListSchedulesRequest {
                tag_id: args.tag,
                include_finished: args.all,
            },
            &token,
        )?)
        .await?
        .into_inner();
    Ok(json!({
        "schedules": listed.schedules.iter().map(schedule_json).collect::<Vec<_>>(),
    }))
}

/// Cancels a Schedule. A turn it already queued stays queued.
pub(crate) async fn delete(connection: Connection, id: String, args: DeleteArgs) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let mut client = client(channel);
    let schedule = if args.dry_run {
        client
            .get(request(GetScheduleRequest { schedule_id: id }, &token)?)
            .await?
    } else {
        client
            .delete(request(GetScheduleRequest { schedule_id: id }, &token)?)
            .await?
    };
    Ok(schedule_json(&schedule.into_inner()))
}

fn at(ms: Option<i64>) -> Value {
    ms.and_then(chrono::DateTime::from_timestamp_millis)
        .map_or(Value::Null, |time| {
            json!(time.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        })
}

fn schedule_json(schedule: &Schedule) -> Value {
    json!({
        "schedule_id": schedule.schedule_id,
        "tag_id": schedule.tag_id,
        "session_id": schedule.session_id,
        "audience": schedule.audience,
        "note": schedule.note,
        "state": schedule.state().as_str_name(),
        "at": at(schedule.at_ms),
        "every": schedule.every.as_ref().map(|every| json!({
            "cron": every.cron,
            "time_zone": every.time_zone,
        })),
        "next_due_at": at(schedule.next_due_at_ms),
        "created_by": schedule.created_by,
        "created_at": at(Some(schedule.created_at_ms)),
        "objective_id": schedule.objective_id,
        "fire_count": schedule.fire_count,
        "missed_count": schedule.missed_count,
        "last_task_id": schedule.last_task_id,
        "last_fired_at": at(schedule.last_fired_at_ms),
    })
}
