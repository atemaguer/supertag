use std::{sync::Arc, time::Duration};

use serde::Serialize;
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tauri::ipc::Channel;
use tokio::{sync::oneshot, time::timeout};
use tonic::{Code, Status};

use super::{ControlPlaneState, Result, Session};

const FIRST_RETRY: Duration = Duration::from_secs(1);
const MAX_RETRY: Duration = Duration::from_secs(30);
const IDLE: Duration = Duration::from_secs(45);

pub(super) struct Registration {
    id: String,
    _stop: oneshot::Sender<()>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WatchUpdate {
    Ready,
    Resync,
    Lost,
    Tag,
    Conversation {
        #[serde(rename = "tagId")]
        tag_id: String,
        conversation: String,
    },
}

impl ControlPlaneState {
    pub async fn start_watch(
        &self,
        connection_id: &str,
        watch_epoch: u64,
        updates: Channel<WatchUpdate>,
    ) -> Result<String> {
        let (id, session, stop) = self.register_watch(connection_id, watch_epoch).await?;
        tauri::async_runtime::spawn(run(session, stop, updates, FIRST_RETRY, IDLE));
        Ok(id)
    }

    async fn register_watch(
        &self,
        connection_id: &str,
        watch_epoch: u64,
    ) -> Result<(String, Arc<Session>, oneshot::Receiver<()>)> {
        let mut state = self.0.write().await;
        let session = state
            .session
            .clone()
            .filter(|_| state.generation.to_string() == connection_id)
            .ok_or("The connection changed. Refresh this view.")?;
        if watch_epoch <= state.watch_epoch {
            return Err("The Watch subscription changed.".into());
        }
        let id = format!("{connection_id}:{watch_epoch}");
        let (sender, receiver) = oneshot::channel();
        state.watch_epoch = watch_epoch;
        state.watch = Some(Registration {
            id: id.clone(),
            _stop: sender,
        });
        Ok((id, session, receiver))
    }

    pub async fn stop_watch(&self, id: &str) {
        let mut state = self.0.write().await;
        if state.watch.as_ref().is_some_and(|watch| watch.id == id) {
            state.watch = None;
        }
    }
}

enum AttemptError {
    Stream(Status),
    Channel,
}

impl From<Status> for AttemptError {
    fn from(value: Status) -> Self {
        Self::Stream(value)
    }
}

async fn run(
    session: Arc<Session>,
    mut stop: oneshot::Receiver<()>,
    updates: Channel<WatchUpdate>,
    first_retry: Duration,
    idle: Duration,
) {
    let mut token = String::new();
    let mut retry = first_retry;
    let mut lost = false;
    loop {
        let mut live = false;
        let outcome = tokio::select! {
            biased;
            _ = &mut stop => return,
            result = read(&session, &updates, &mut token, &mut live, idle) => result,
        };
        let status = match outcome {
            Ok(()) => Status::unavailable("Control Plane Watch closed"),
            Err(AttemptError::Stream(status)) => status,
            Err(AttemptError::Channel) => return,
        };
        if live {
            retry = first_retry;
            lost = false;
        }
        if !lost {
            if updates.send(WatchUpdate::Lost).is_err() {
                return;
            }
            lost = true;
        }
        match status.code() {
            Code::InvalidArgument if !token.is_empty() => {
                token.clear();
                continue;
            }
            Code::Unauthenticated
            | Code::PermissionDenied
            | Code::Unimplemented
            | Code::InvalidArgument => return,
            _ => {}
        }
        tokio::select! {
            _ = &mut stop => return,
            _ = tokio::time::sleep(retry) => {}
        }
        retry = (retry * 2).min(MAX_RETRY);
    }
}

async fn read(
    session: &Session,
    updates: &Channel<WatchUpdate>,
    token: &mut String,
    live: &mut bool,
    idle: Duration,
) -> std::result::Result<(), AttemptError> {
    let mut client = operator_events_client::OperatorEventsClient::new(session.channel.clone())
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    // The channel bounds opening the RPC. A Watch must stay open through
    // quiet intervals, so no unary grpc-timeout is sent with this request.
    let request = session.authenticated(WatchRequest {
        resume_token: token.clone(),
        kinds: vec![
            WatchKind::Tag as i32,
            WatchKind::ConversationMessage as i32,
            WatchKind::Task as i32,
        ],
    });
    let mut stream = client.watch(request).await?.into_inner();
    loop {
        let next = timeout(idle, stream.message())
            .await
            .map_err(|_| Status::unavailable("Control Plane Watch stopped sending heartbeats"))??;
        let Some(frame) = next else {
            return Ok(());
        };
        let Some(update) = frame.update else {
            return Err(
                Status::data_loss("Control Plane Watch returned an incomplete frame").into(),
            );
        };
        let notice = match update {
            watch_event::Update::Heartbeat(_) => None,
            watch_event::Update::Resync(_) => Some(WatchUpdate::Resync),
            watch_event::Update::Change(change) => invalidation(change),
        };
        let send = |event| updates.send(event).map_err(|_| AttemptError::Channel);
        if !*live && notice != Some(WatchUpdate::Resync) {
            send(WatchUpdate::Ready)?;
        }
        if let Some(notice) = notice {
            send(notice)?;
        }
        *live = true;
        if !frame.resume_token.is_empty() {
            *token = frame.resume_token;
        }
    }
}

fn invalidation(change: WatchChange) -> Option<WatchUpdate> {
    match change.kind() {
        WatchKind::Tag => return Some(WatchUpdate::Tag),
        WatchKind::ConversationMessage => {}
        // Message creation has its own notice. Later Task changes carry
        // the result and status invalidation for the private conversation.
        WatchKind::Task if change.reason() != WatchReason::Created => {}
        _ => return None,
    }
    if change.tag_id.is_empty() || change.conversation.is_empty() {
        return None;
    }
    Some(WatchUpdate::Conversation {
        tag_id: change.tag_id,
        conversation: change.conversation,
    })
}

#[cfg(test)]
mod tests;
