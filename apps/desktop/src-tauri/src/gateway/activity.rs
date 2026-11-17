//! A Tag's activity for the Tag details panel: how its unprompted messages landed over the last
//! days, and its start rate. Both come from GetTag, as `supertag describe tag` shows them.
use serde::Serialize;
use supertag_protocol::v2;

use super::{GatewayState, Result, rpc_error};

/// How the Tag's unprompted messages were received, and how often its work may start.
#[derive(Serialize, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TagActivity {
    pub window_days: u32,
    /// Replies of turns no person asked for (Schedule fires, Objective notices) that reached
    /// someone.
    pub posted: u32,
    /// Of those, read by a person in their conversation.
    pub read: u32,
    /// Of those, answered in the same Session within a day.
    pub answered: u32,
    /// Checks that found nothing and posted nothing.
    pub quiet: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_rate: Option<StartRate>,
}

/// At most `starts` Task Attempts start in any `per_ms`; `in_window` started in the current one.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StartRate {
    pub starts: u32,
    pub per_ms: u64,
    pub in_window: u32,
}

impl From<v2::Tag> for TagActivity {
    fn from(tag: v2::Tag) -> Self {
        let attention = tag.attention.unwrap_or_default();
        Self {
            window_days: attention.window_days,
            posted: attention.posted,
            read: attention.read,
            answered: attention.answered,
            quiet: attention.quiet,
            start_rate: tag
                .start_rate
                .filter(|rate| rate.starts > 0)
                .map(|rate| StartRate {
                    starts: rate.starts,
                    per_ms: rate.per_ms,
                    in_window: tag.starts_in_window,
                }),
        }
    }
}

impl GatewayState {
    /// The Tag's activity, read fresh each time the panel asks.
    pub async fn tag_activity(&self, connection_id: &str, tag_id: String) -> Result<TagActivity> {
        let session = self.session(connection_id).await?;
        let tag = session
            .operator()
            .get_tag(session.request(v2::GetTagRequest { tag_id }))
            .await
            .map_err(rpc_error)?
            .into_inner();
        self.current(&session, TagActivity::from(tag)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activity_carries_attention_and_a_start_rate_only_when_set() {
        let activity = TagActivity::from(v2::Tag {
            attention: Some(v2::AttentionSummary {
                posted: 4,
                read: 2,
                answered: 1,
                quiet: 7,
                window_days: 30,
            }),
            start_rate: Some(v2::StartRate {
                starts: 10,
                per_ms: 3_600_000,
            }),
            starts_in_window: 3,
            ..Default::default()
        });
        let value = serde_json::to_value(&activity).unwrap();
        assert_eq!(value["posted"], 4);
        assert_eq!(value["quiet"], 7);
        assert_eq!(value["windowDays"], 30);
        assert_eq!(value["startRate"]["perMs"], 3_600_000);
        assert_eq!(value["startRate"]["inWindow"], 3);
        let without = serde_json::to_value(TagActivity::from(v2::Tag::default())).unwrap();
        assert!(without.get("startRate").is_none());
    }
}
