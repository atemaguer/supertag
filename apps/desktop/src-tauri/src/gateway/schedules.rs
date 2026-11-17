//! A Tag's Schedules in the desktop: list them, pause and resume them, and delete them.

use serde::Serialize;
use supertag_protocol::{MAX_MESSAGE_BYTES, v2};

use super::{GatewayState, Result, rpc_error};

/// A recurrence: a cron expression in an IANA time zone.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Recurrence {
    pub cron: String,
    pub time_zone: String,
}

/// A Schedule as the app shows it.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub schedule_id: String,
    pub tag_id: String,
    pub note: String,
    /// `active`, `paused`, `staged`, `done`, or `cancelled`.
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub every: Option<Recurrence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_due_at_ms: Option<i64>,
    pub created_by: String,
    pub fire_count: u64,
    pub missed_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_fired_at_ms: Option<i64>,
}

impl From<v2::Schedule> for Schedule {
    fn from(value: v2::Schedule) -> Self {
        Self {
            state: value
                .state()
                .as_str_name()
                .trim_start_matches("SCHEDULE_STATE_")
                .to_ascii_lowercase(),
            schedule_id: value.schedule_id,
            tag_id: value.tag_id,
            note: value.note,
            at_ms: value.at_ms,
            every: value.every.map(|every| Recurrence {
                cron: every.cron,
                time_zone: every.time_zone,
            }),
            next_due_at_ms: value.next_due_at_ms,
            created_by: value.created_by,
            fire_count: value.fire_count,
            missed_count: value.missed_count,
            last_fired_at_ms: value.last_fired_at_ms,
        }
    }
}

impl GatewayState {
    /// The Tag's Schedules that have not finished, next due first.
    pub async fn schedules(&self, connection_id: &str, tag_id: String) -> Result<Vec<Schedule>> {
        let session = self.session(connection_id).await?;
        let listed = v2::schedules_client::SchedulesClient::new(session.channel.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
            .list(session.request(v2::ListSchedulesRequest {
                tag_id: Some(tag_id),
                include_finished: false,
            }))
            .await
            .map_err(rpc_error)?
            .into_inner();
        self.current(
            &session,
            listed.schedules.into_iter().map(Schedule::from).collect(),
        )
        .await
    }

    /// Pauses, resumes, or deletes (cancels) a Schedule.
    pub async fn change_schedule(
        &self,
        connection_id: &str,
        schedule_id: String,
        action: &str,
    ) -> Result<Schedule> {
        let session = self.session(connection_id).await?;
        let mut client = v2::schedules_client::SchedulesClient::new(session.channel.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES);
        let request = session.request(v2::GetScheduleRequest { schedule_id });
        let changed = match action {
            "pause" => client.pause(request).await,
            "resume" => client.resume(request).await,
            "delete" => client.delete(request).await,
            _ => return Err("Choose pause, resume, or delete.".into()),
        }
        .map_err(rpc_error)?
        .into_inner();
        self.current(&session, Schedule::from(changed)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_schedule_shows_its_state_and_recurrence() {
        let shown = Schedule::from(v2::Schedule {
            schedule_id: "sch_1".into(),
            tag_id: "lead".into(),
            note: "Summarize open work".into(),
            state: v2::ScheduleState::Paused as i32,
            every: Some(v2::ScheduleRecurrence {
                cron: "0 9 * * MON".into(),
                time_zone: "Europe/Berlin".into(),
            }),
            next_due_at_ms: Some(1_900_000_000_000),
            created_by: "tag:lead".into(),
            ..Default::default()
        });
        let json = serde_json::to_value(shown).unwrap();
        assert_eq!(json["state"], "paused");
        assert_eq!(json["every"]["timeZone"], "Europe/Berlin");
        assert_eq!(json["nextDueAtMs"], 1_900_000_000_000_i64);
        assert!(json.get("atMs").is_none());
    }
}
