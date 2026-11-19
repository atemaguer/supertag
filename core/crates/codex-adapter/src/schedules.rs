//! `schedule` and `cancel_schedule` as Codex tools: a root turn asks to be woken later in its
//! own Session, once or on a recurrence. A Schedule takes effect only when the turn succeeds.
use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        AttemptScheduleResponse, CancelAttemptScheduleRequest, CreateAttemptScheduleRequest,
        Schedule, harness_schedules_client::HarnessSchedulesClient,
    },
};
use tonic::{Code, Response, Status, transport::Channel};

use crate::coordination::response;

const NOTE_MAX: usize = 4_000;
const WHEN_MAX: usize = 100;

#[derive(Debug, PartialEq)]
pub(crate) enum Call {
    Create(Create),
    Cancel(Cancel),
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Create {
    note: String,
    #[serde(default)]
    at: Option<String>,
    #[serde(default)]
    every: Option<String>,
    #[serde(default)]
    time_zone: Option<String>,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Cancel {
    schedule_id: String,
}

fn bounded(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty() && value.chars().count() <= maximum && !value.contains('\0')
}

/// The tool a Codex call names, when it is one of these.
pub(crate) fn arguments(params: &Value) -> Result<Option<Call>> {
    let tool = params["tool"].as_str();
    if !matches!(tool, Some("schedule" | "cancel_schedule")) {
        return Ok(None);
    }
    let input = params
        .get("arguments")
        .filter(|input| input.is_object())
        .with_context(|| format!("invalid Codex {} arguments", tool.unwrap_or_default()))?
        .clone();
    if tool == Some("schedule") {
        let create: Create =
            serde_json::from_value(input).context("invalid Codex schedule arguments")?;
        ensure!(
            bounded(&create.note, NOTE_MAX),
            "note must be text of 1 to {NOTE_MAX} characters"
        );
        ensure!(
            create.at.is_some() != create.every.is_some(),
            "give exactly one of at and every"
        );
        for value in [&create.at, &create.every, &create.time_zone]
            .into_iter()
            .flatten()
        {
            ensure!(bounded(value, WHEN_MAX), "invalid schedule time");
        }
        return Ok(Some(Call::Create(create)));
    }
    let cancel: Cancel =
        serde_json::from_value(input).context("invalid Codex cancel_schedule arguments")?;
    ensure!(bounded(&cancel.schedule_id, 256), "invalid Schedule ID");
    Ok(Some(Call::Cancel(cancel)))
}

/// The two tool specifications. `zone` is the zone a time without an offset is read in.
pub(crate) fn tool_specs(zone: &str, now: chrono::DateTime<chrono::Utc>) -> Vec<Value> {
    let zone = if zone.is_empty() { "UTC" } else { zone };
    let now = match zone.parse::<chrono_tz::Tz>() {
        Ok(tz) => now
            .with_timezone(&tz)
            .format("%a %Y-%m-%d %H:%M %Z")
            .to_string(),
        Err(_) => now.format("%a %Y-%m-%d %H:%M UTC").to_string(),
    };
    vec![
        json!({
            "type":"function","name":"schedule",
            "description":format!("Ask to be woken later in this Session: once (at) or on a recurrence (every). Use it when someone asks you to check back, follow up, or report on a schedule. When it is due, you get a new turn with the note, and your reply is posted here as a normal message. It takes effect when this turn succeeds. The woken turn may not have this turn's context, so write a note that says exactly what to do and why. It was {now} when this turn started; times without an offset are read in {zone} unless you pass timeZone."),
            "inputSchema":{"type":"object","properties":{
                "note":{"type":"string","minLength":1,"maxLength":NOTE_MAX,"description":"What to do when woken, self-contained."},
                "at":{"type":"string","maxLength":WHEN_MAX,"description":"Once: a duration ahead such as 90m, 2h, or 3d, or a time such as 2026-11-17T09:00. From 1 minute to 366 days ahead."},
                "every":{"type":"string","maxLength":WHEN_MAX,"description":"Recurring: a five-field cron expression such as \"0 9 * * MON\", or @hourly, @daily, or @weekly. At least one hour apart."},
                "timeZone":{"type":"string","maxLength":WHEN_MAX,"description":"An IANA time zone such as Europe/Berlin, when the person named one."}
            },"required":["note"],"additionalProperties":false}
        }),
        json!({
            "type":"function","name":"cancel_schedule",
            "description":"Cancel one of this Tag's Schedules in this Session by its ID. A turn it already queued still runs.",
            "inputSchema":{"type":"object","properties":{
                "scheduleId":{"type":"string","minLength":1,"maxLength":256}
            },"required":["scheduleId"],"additionalProperties":false}
        }),
    ]
}

fn local(ms: i64, zone: &str) -> String {
    let Some(time) = chrono::DateTime::from_timestamp_millis(ms) else {
        return ms.to_string();
    };
    match zone.parse::<chrono_tz::Tz>() {
        Ok(tz) => time
            .with_timezone(&tz)
            .format("%a %d %b %Y %H:%M %Z")
            .to_string(),
        Err(_) => time.format("%a %d %b %Y %H:%M UTC").to_string(),
    }
}

/// One line about a Schedule, in the zone it recurs in or the Control Plane's.
pub(crate) fn line(schedule: &Schedule, zone: &str) -> String {
    let zone = schedule
        .every
        .as_ref()
        .map_or(zone, |every| every.time_zone.as_str());
    let next = schedule
        .next_due_at_ms
        .map_or_else(|| "never".to_owned(), |ms| local(ms, zone));
    let recurrence = schedule.every.as_ref().map_or_else(
        || "once".to_owned(),
        |every| format!("every {} ({})", every.cron, every.time_zone),
    );
    format!(
        "{} next {next}, {recurrence}: {}",
        schedule.schedule_id, schedule.note
    )
}

/// The tool result: what changed, then the Session's other pending Schedules.
pub(crate) fn summary(result: &AttemptScheduleResponse, created: bool) -> String {
    let Some(schedule) = &result.schedule else {
        return "The Schedule was not returned.".into();
    };
    let mut text = if created {
        format!(
            "Scheduled {}. It takes effect when this turn succeeds.",
            line(schedule, &result.time_zone)
        )
    } else {
        format!("Cancelled {}.", schedule.schedule_id)
    };
    if result.pending.is_empty() {
        text.push_str("\nThis Session has no other Schedules.");
    } else {
        text.push_str("\nOther Schedules in this Session:");
        for other in &result.pending {
            text.push_str(&format!("\n- {}", line(other, &result.time_zone)));
        }
    }
    text
}

pub(crate) struct Client {
    client: HarnessSchedulesClient<Channel>,
}

/// A refusal carries the Control Plane's reason; other failures fail the call.
async fn confirm<T>(
    mut call: impl AsyncFnMut() -> Result<Response<T>, Status>,
) -> Result<std::result::Result<T, String>> {
    for retry in 0..3 {
        match call().await {
            Ok(response) => return Ok(Ok(response.into_inner())),
            Err(status)
                if retry < 2
                    && matches!(status.code(), Code::Unavailable | Code::DeadlineExceeded) =>
            {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(status)
                if matches!(
                    status.code(),
                    Code::PermissionDenied
                        | Code::Unauthenticated
                        | Code::FailedPrecondition
                        | Code::AlreadyExists
                        | Code::InvalidArgument
                        | Code::NotFound
                ) =>
            {
                return Ok(Err(status.message().to_owned()));
            }
            Err(_) => break,
        }
    }
    bail!("could not confirm the Schedule")
}

impl Client {
    pub(crate) fn new(channel: Channel) -> Self {
        Self {
            client: HarnessSchedulesClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
        }
    }

    pub(crate) async fn call(
        &mut self,
        call: &Call,
        operation_id: String,
        token: &str,
        secrets: &[String],
    ) -> Result<Value> {
        fn request<T>(message: T, token: &str) -> Result<tonic::Request<T>, Status> {
            crate::request(message, token)
                .map_err(|_| Status::unauthenticated("invalid execution credential"))
        }
        let result = match call {
            Call::Create(create) => {
                let input = CreateAttemptScheduleRequest {
                    operation_id,
                    note: crate::auth::redact(create.note.trim().to_owned(), secrets),
                    at: create.at.clone().unwrap_or_default(),
                    every: create.every.clone().unwrap_or_default(),
                    time_zone: create.time_zone.clone(),
                };
                confirm(async || self.client.create(request(input.clone(), token)?).await)
                    .await?
                    .map(|result| summary(&result, true))
            }
            Call::Cancel(cancel) => {
                let input = CancelAttemptScheduleRequest {
                    schedule_id: cancel.schedule_id.clone(),
                };
                confirm(async || self.client.cancel(request(input.clone(), token)?).await)
                    .await?
                    .map(|result| summary(&result, false))
            }
        };
        Ok(match result {
            Ok(text) => response(crate::auth::redact(text, secrets), true),
            Err(reason) => response(
                crate::auth::redact(format!("Refused: {reason}"), secrets),
                false,
            ),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use supertag_protocol::v2::ScheduleRecurrence;

    fn call(tool: &str, arguments: Value) -> Result<Option<Call>> {
        super::arguments(&json!({"namespace":"supertag","tool":tool,"arguments":arguments}))
    }

    #[test]
    fn arguments_need_a_note_and_exactly_one_time() {
        assert!(matches!(
            call("schedule", json!({"note":"Check PR 412","at":"2h"})).unwrap(),
            Some(Call::Create(_))
        ));
        assert!(matches!(
            call(
                "schedule",
                json!({"note":"Summarize","every":"0 9 * * MON","timeZone":"Europe/Berlin"})
            )
            .unwrap(),
            Some(Call::Create(_))
        ));
        assert!(call("schedule", json!({"note":"x"})).is_err());
        assert!(call("schedule", json!({"note":"x","at":"2h","every":"@daily"})).is_err());
        assert!(call("schedule", json!({"note":" ","at":"2h"})).is_err());
        assert!(call("schedule", json!({"note":"x".repeat(4_001),"at":"2h"})).is_err());
        assert!(call("schedule", json!({"note":"x","at":"2h","tag":"other"})).is_err());
        assert!(matches!(
            call("cancel_schedule", json!({"scheduleId":"sch_1"})).unwrap(),
            Some(Call::Cancel(_))
        ));
        assert!(call("cancel_schedule", json!({})).is_err());
        assert!(call("ask", json!({"text":"x"})).unwrap().is_none());
    }

    #[test]
    fn specs_are_closed_and_name_the_zone() {
        let now = chrono::DateTime::from_timestamp_millis(1_900_000_000_000).unwrap();
        let specs = tool_specs("Europe/Berlin", now);
        assert_eq!(
            specs
                .iter()
                .map(|spec| spec["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["schedule", "cancel_schedule"]
        );
        assert!(
            specs
                .iter()
                .all(|spec| spec["inputSchema"]["additionalProperties"] == false)
        );
        let description = specs[0]["description"].as_str().unwrap();
        assert!(description.contains("Europe/Berlin"), "{description}");
        assert!(description.contains("2030-03-17"), "{description}");
    }

    #[test]
    fn the_result_lists_the_sessions_other_schedules() {
        let schedule = |id: &str, every: Option<&str>| Schedule {
            schedule_id: id.into(),
            note: format!("note {id}"),
            next_due_at_ms: Some(1_900_000_000_000),
            every: every.map(|cron| ScheduleRecurrence {
                cron: cron.into(),
                time_zone: "Europe/Berlin".into(),
            }),
            ..Default::default()
        };
        let text = summary(
            &AttemptScheduleResponse {
                schedule: Some(schedule("sch_new", None)),
                pending: vec![schedule("sch_old", Some("0 9 * * MON"))],
                time_zone: "UTC".into(),
            },
            true,
        );
        assert!(
            text.starts_with(
                "Scheduled sch_new next Sun 17 Mar 2030 17:46 UTC, once: note sch_new."
            ),
            "{text}"
        );
        assert!(
            text.contains(
                "- sch_old next Sun 17 Mar 2030 18:46 CET, every 0 9 * * MON (Europe/Berlin)"
            ),
            "{text}"
        );
    }
}
