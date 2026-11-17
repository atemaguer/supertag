//! Pushes an open conversation's changes to the frontend from `Conversations.FollowConversation`.
use std::{
    collections::{BTreeSet, HashMap},
    sync::Arc,
    time::Duration,
};

use serde::Serialize;
use supertag_protocol::{MAX_MESSAGE_BYTES, v2};
use tauri::ipc::Channel;
use tokio::{sync::oneshot, time::timeout};
use tonic::{Code, Status};

use super::{ControlPlaneState, Message, Messages, ReadMessages, Result, Session};

const FIRST_RETRY: Duration = Duration::from_secs(1);
const MAX_RETRY: Duration = Duration::from_secs(30);
/// How long the stream may go without a response, heartbeats included.
const IDLE: Duration = Duration::from_secs(45);

/// The open follows of the current connection, by ID. Dropping one stops it.
#[derive(Default)]
pub(super) struct Follows {
    next: u64,
    open: HashMap<String, oneshot::Sender<()>>,
}

/// What a follow tells the conversation view.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FollowUpdate {
    /// The stream is open; changes follow as they happen.
    Ready,
    /// The stream dropped; it reopens on its own, and the view reads on a timer meanwhile.
    Lost,
    /// What changed: messages as `list_messages` returns them, and why queued turns wait.
    Changed {
        #[serde(skip_serializing_if = "Option::is_none")]
        messages: Option<Messages>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        waits: Vec<TurnWait>,
    },
}

/// Why a queued turn still waits for a Worker Host; an empty reason clears an earlier one.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnWait {
    pub task_id: String,
    pub reason: String,
}

/// Where a reopened stream resumes: the conversation, its latest order, and its unfinished turns.
struct Cursor {
    tag_id: String,
    conversation_id: String,
    after: u64,
    unfinished: BTreeSet<String>,
}

impl Cursor {
    fn request(&self) -> v2::FollowConversationRequest {
        v2::FollowConversationRequest {
            tag_id: self.tag_id.clone(),
            conversation_id: self.conversation_id.clone(),
            after: if self.conversation_id.is_empty() {
                0
            } else {
                self.after
            },
            refresh_task_ids: self.unfinished.iter().take(128).cloned().collect(),
        }
    }

    fn advance(&mut self, page: &v2::ListMessagesResponse) {
        if !page.incremental {
            self.conversation_id = page.conversation_id.clone();
            self.after = 0;
            self.unfinished.clear();
        }
        for message in &page.messages {
            let Some(task) = &message.task else { continue };
            self.after = self.after.max(message.order);
            if matches!(
                task.state(),
                v2::TaskState::Succeeded | v2::TaskState::Failed | v2::TaskState::Cancelled
            ) {
                self.unfinished.remove(&task.task_id);
            } else {
                self.unfinished.insert(task.task_id.clone());
            }
        }
    }
}

impl ControlPlaneState {
    /// Follows the caller's conversation with `read.tag_id` from the copy `read` describes.
    pub async fn start_follow(
        &self,
        connection_id: &str,
        read: ReadMessages,
        updates: Channel<FollowUpdate>,
    ) -> Result<String> {
        let mut state = self.0.write().await;
        let session = state
            .session
            .clone()
            .filter(|_| state.generation.to_string() == connection_id)
            .ok_or("The connection changed. Refresh this view.")?;
        state.follows.next += 1;
        let id = format!("{connection_id}:follow:{}", state.follows.next);
        let (stop, stopped) = oneshot::channel();
        state.follows.open.insert(id.clone(), stop);
        let cursor = Cursor {
            tag_id: read.tag_id,
            conversation_id: read.conversation_id.unwrap_or_default(),
            after: read.after.unwrap_or_default(),
            unfinished: read.refresh_task_ids.into_iter().collect(),
        };
        tauri::async_runtime::spawn(run(session, cursor, stopped, updates));
        Ok(id)
    }

    pub async fn stop_follow(&self, id: &str) {
        self.0.write().await.follows.open.remove(id);
    }
}

async fn run(
    session: Arc<Session>,
    mut cursor: Cursor,
    mut stop: oneshot::Receiver<()>,
    updates: Channel<FollowUpdate>,
) {
    let mut retry = FIRST_RETRY;
    let mut lost = false;
    loop {
        let mut live = false;
        let outcome = tokio::select! {
            biased;
            _ = &mut stop => return,
            result = read(&session, &mut cursor, &updates, &mut live) => result,
        };
        let status = match outcome {
            Ok(()) => Status::unavailable("Control Plane follow closed"),
            Err(Ended::Stream(status)) => status,
            Err(Ended::Channel) => return,
        };
        if live {
            retry = FIRST_RETRY;
            lost = false;
        }
        if !lost {
            if updates.send(FollowUpdate::Lost).is_err() {
                return;
            }
            lost = true;
        }
        if matches!(
            status.code(),
            Code::Unauthenticated
                | Code::PermissionDenied
                | Code::Unimplemented
                | Code::InvalidArgument
        ) {
            return;
        }
        tokio::select! {
            _ = &mut stop => return,
            _ = tokio::time::sleep(retry) => {}
        }
        retry = (retry * 2).min(MAX_RETRY);
    }
}

enum Ended {
    Stream(Status),
    Channel,
}

impl From<Status> for Ended {
    fn from(value: Status) -> Self {
        Self::Stream(value)
    }
}

async fn read(
    session: &Session,
    cursor: &mut Cursor,
    updates: &Channel<FollowUpdate>,
    live: &mut bool,
) -> std::result::Result<(), Ended> {
    let mut client = v2::conversations_client::ConversationsClient::new(session.channel.clone())
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    // The stream stays open through quiet intervals, so no unary grpc-timeout is sent.
    let mut stream = client
        .follow_conversation(session.authenticated(cursor.request()))
        .await?
        .into_inner();
    let send = |update| updates.send(update).map_err(|_| Ended::Channel);
    loop {
        let next = timeout(IDLE, stream.message()).await.map_err(|_| {
            Status::unavailable("Control Plane follow stopped sending heartbeats")
        })??;
        let Some(response) = next else {
            return Ok(());
        };
        if !*live {
            *live = true;
            send(FollowUpdate::Ready)?;
        }
        let messages = match response.messages {
            Some(page) => {
                cursor.advance(&page);
                if page.messages.iter().any(|message| {
                    message
                        .task
                        .as_ref()
                        .is_none_or(|task| task.tag_id != cursor.tag_id)
                }) {
                    return Err(Status::data_loss(
                        "Control Plane returned a message of another conversation",
                    )
                    .into());
                }
                Some(Messages {
                    messages: page
                        .messages
                        .into_iter()
                        .map(Message::try_from)
                        .collect::<Result<_>>()
                        .map_err(Status::data_loss)?,
                    next_cursor: page.next_cursor,
                    conversation_id: page.conversation_id,
                    incremental: page.incremental,
                })
            }
            None => None,
        };
        let waits: Vec<TurnWait> = response
            .waits
            .into_iter()
            .map(|wait| TurnWait {
                task_id: wait.task_id,
                reason: wait.reason,
            })
            .collect();
        if messages.is_some() || !waits.is_empty() {
            send(FollowUpdate::Changed { messages, waits })?;
        }
    }
}
