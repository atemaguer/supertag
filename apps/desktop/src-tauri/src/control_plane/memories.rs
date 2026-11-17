//! A Tag's notes: the short memory it keeps of what it cannot look up again. The window lists
//! the notes the caller may see and deletes one at once; it never writes notes, as people tell
//! the Tag instead.
use serde::Serialize;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{self, memories_client::MemoriesClient},
};

use super::{ControlPlaneState, Result, rpc_error};

/// One note, as the Tag details panel shows it.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub memory_id: String,
    pub tag_id: String,
    pub text: String,
    /// Private to the person whose conversation wrote it; otherwise every turn sees it.
    pub private: bool,
    pub created_by: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    /// When a turn last had it in its context.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at_ms: Option<i64>,
}

impl From<v2::Memory> for Note {
    fn from(memory: v2::Memory) -> Self {
        Self {
            private: memory.audience.is_some(),
            memory_id: memory.memory_id,
            tag_id: memory.tag_id,
            text: memory.text,
            created_by: memory.created_by,
            created_at_ms: memory.created_at_ms,
            updated_at_ms: memory.updated_at_ms,
            last_seen_at_ms: memory.last_seen_at_ms,
        }
    }
}

impl ControlPlaneState {
    /// The Tag's notes the caller sees, newest first.
    pub async fn notes(&self, connection_id: &str, tag_id: String) -> Result<Vec<Note>> {
        let session = self.session(connection_id).await?;
        let notes = MemoriesClient::new(session.channel.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
            .list(session.request(v2::ListMemoriesRequest {
                tag_id: Some(tag_id),
            }))
            .await
            .map_err(rpc_error)?
            .into_inner()
            .memories
            .into_iter()
            .map(Note::from)
            .collect();
        self.current(&session, notes).await
    }

    /// Deletes a note at once. The Tag no longer sees it from its next turn.
    pub async fn delete_note(&self, connection_id: &str, memory_id: String) -> Result<Note> {
        let session = self.session(connection_id).await?;
        let note = MemoriesClient::new(session.channel.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
            .delete(session.request(v2::GetMemoryRequest { memory_id }))
            .await
            .map_err(rpc_error)?
            .into_inner();
        self.current(&session, Note::from(note)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_reach_the_window_in_camel_case_with_their_audience_and_last_seen() {
        let note = Note::from(v2::Memory {
            memory_id: "mem_1".into(),
            tag_id: "lead".into(),
            text: "Alice prefers squash merges.".into(),
            audience: Some("operator:alice".into()),
            created_by: "tag:lead".into(),
            created_at_ms: 1,
            updated_at_ms: 2,
            last_seen_at_ms: Some(3),
            ..Default::default()
        });
        let json = serde_json::to_value(&note).unwrap();
        assert_eq!(json["memoryId"], "mem_1");
        assert_eq!(json["private"], true);
        assert_eq!(json["lastSeenAtMs"], 3);
        assert!(
            json.get("audience").is_none(),
            "the window never names the person"
        );
        let shared = Note::from(v2::Memory::default());
        let json = serde_json::to_value(&shared).unwrap();
        assert_eq!(json["private"], false);
        assert!(json.get("lastSeenAtMs").is_none());
    }
}
