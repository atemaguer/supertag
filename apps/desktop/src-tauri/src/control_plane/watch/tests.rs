use std::pin::Pin;

use serde_json::{Value, json};
use tauri::ipc::InvokeResponseBody;
use tokio::{
    net::TcpListener,
    sync::{mpsc, oneshot::error::TryRecvError},
};
use tokio_stream::{
    Stream,
    wrappers::{ReceiverStream, TcpListenerStream},
};
use tonic::{
    Request, Response,
    transport::{Endpoint, Server},
};

use super::*;
use crate::control_plane::bearer;

const WAIT: Duration = Duration::from_secs(4);

#[tokio::test]
async fn watch_registration_fences_replacement_stop_and_disconnect() {
    let state = ControlPlaneState::default();
    let session = Arc::new(Session {
        channel: supertag_protocol::negotiation::bind_current(
            Endpoint::from_static("http://127.0.0.1:1").connect_lazy(),
        ),
        authorization: bearer("operator-token").unwrap(),
    });
    {
        let mut connection = state.0.write().await;
        connection.generation = 1;
        connection.session = Some(session.clone());
    }
    let (old_id, _, old_stop) = state.register_watch("1", 1).await.unwrap();
    let (current_id, _, mut current_stop) = state.register_watch("1", 3).await.unwrap();
    assert!(timeout(WAIT, old_stop).await.unwrap().is_err());
    assert!(state.register_watch("1", 2).await.is_err());
    state.stop_watch(&old_id).await;
    assert_eq!(current_stop.try_recv(), Err(TryRecvError::Empty));

    state.disconnect().await;
    assert!(timeout(WAIT, current_stop).await.unwrap().is_err());
    {
        let mut connection = state.0.write().await;
        connection.session = Some(session);
    }
    let (_, _, mut replacement_stop) = state.register_watch("2", 1).await.unwrap();
    assert!(state.register_watch("1", 4).await.is_err());
    state.stop_watch(&current_id).await;
    assert_eq!(replacement_stop.try_recv(), Err(TryRecvError::Empty));
}

struct WatchScript {
    tokens: mpsc::UnboundedSender<String>,
    stopped: mpsc::UnboundedSender<()>,
}

#[tonic::async_trait]
impl operator_events_server::OperatorEvents for WatchScript {
    type WatchStream = Pin<Box<dyn Stream<Item = std::result::Result<WatchEvent, Status>> + Send>>;

    async fn watch(
        &self,
        request: Request<WatchRequest>,
    ) -> std::result::Result<Response<Self::WatchStream>, Status> {
        assert_eq!(
            request.metadata().get("authorization").unwrap(),
            "Bearer operator-token"
        );
        assert!(request.metadata().get("grpc-timeout").is_none());
        let request = request.into_inner();
        assert_eq!(
            request.kinds,
            [
                WatchKind::Tag as i32,
                WatchKind::ConversationMessage as i32,
                WatchKind::Task as i32,
            ]
        );
        self.tokens.send(request.resume_token.clone()).unwrap();
        let (send, receive) = mpsc::channel(4);
        let frame = |resume_token: &str, update| {
            Ok(WatchEvent {
                resume_token: resume_token.into(),
                update: Some(update),
            })
        };
        match request.resume_token.as_str() {
            "" => {
                send.send(frame(
                    "start",
                    watch_event::Update::Heartbeat(WatchHeartbeat {}),
                ))
                .await
                .unwrap();
                send.send(frame(
                    "after-tag",
                    watch_event::Update::Change(WatchChange {
                        kind: WatchKind::Tag as i32,
                        id: "engineer".into(),
                        ..Default::default()
                    }),
                ))
                .await
                .unwrap();
                send.send(frame(
                    "after-public-task",
                    watch_event::Update::Change(WatchChange {
                        kind: WatchKind::Task as i32,
                        id: "public-task".into(),
                        tag_id: "engineer".into(),
                        reason: WatchReason::Changed as i32,
                        ..Default::default()
                    }),
                ))
                .await
                .unwrap();
                send.send(Err(Status::unavailable("fixture stream stopped")))
                    .await
                    .unwrap();
            }
            "after-public-task" => {
                send.send(frame(
                    "new-head",
                    watch_event::Update::Resync(WatchResync {}),
                ))
                .await
                .unwrap();
                send.send(frame(
                    "task-created",
                    watch_event::Update::Change(WatchChange {
                        kind: WatchKind::Task as i32,
                        id: "created-task".into(),
                        tag_id: "engineer".into(),
                        conversation: "creation-notice".into(),
                        reason: WatchReason::Created as i32,
                        ..Default::default()
                    }),
                ))
                .await
                .unwrap();
                send.send(frame(
                    "message",
                    watch_event::Update::Change(WatchChange {
                        kind: WatchKind::ConversationMessage as i32,
                        id: "message".into(),
                        tag_id: "engineer".into(),
                        conversation: "planning".into(),
                        reason: WatchReason::Created as i32,
                        ..Default::default()
                    }),
                ))
                .await
                .unwrap();
                send.send(frame(
                    "task-finished",
                    watch_event::Update::Change(WatchChange {
                        kind: WatchKind::Task as i32,
                        id: "message".into(),
                        tag_id: "engineer".into(),
                        conversation: "planning".into(),
                        reason: WatchReason::Changed as i32,
                        ..Default::default()
                    }),
                ))
                .await
                .unwrap();
                let stopped = self.stopped.clone();
                tokio::spawn(async move {
                    send.closed().await;
                    let _ = stopped.send(());
                });
            }
            _ => return Err(Status::invalid_argument("unexpected resume token")),
        }
        Ok(Response::new(Box::pin(ReceiverStream::new(receive))))
    }
}

#[tokio::test]
async fn watch_resumes_and_stops_the_real_stream_without_a_unary_deadline() {
    let (tokens, mut received_tokens) = mpsc::unbounded_channel();
    let (stopped, mut received_stop) = mpsc::unbounded_channel();
    let socket = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint =
        Endpoint::from_shared(format!("http://{}", socket.local_addr().unwrap())).unwrap();
    let server = tokio::spawn(
        Server::builder()
            .add_service(operator_events_server::OperatorEventsServer::new(
                WatchScript { tokens, stopped },
            ))
            .serve_with_incoming(TcpListenerStream::new(socket)),
    );
    let session = Arc::new(Session {
        channel: supertag_protocol::negotiation::bind_current(endpoint.connect().await.unwrap()),
        authorization: bearer("operator-token").unwrap(),
    });
    let (send, mut receive) = mpsc::unbounded_channel::<Value>();
    let updates = Channel::new(move |body| {
        let InvokeResponseBody::Json(value) = body else {
            panic!("expected JSON IPC")
        };
        send.send(serde_json::from_str(&value).unwrap()).unwrap();
        Ok(())
    });
    let (stop, stopped) = oneshot::channel();
    let watch = tokio::spawn(run(
        session,
        stopped,
        updates,
        Duration::from_millis(1),
        WAIT,
    ));
    for expected in [
        json!({"kind":"ready"}),
        json!({"kind":"tag"}),
        json!({"kind":"lost"}),
        json!({"kind":"resync"}),
        json!({"kind":"conversation","tagId":"engineer","conversation":"planning"}),
        json!({"kind":"conversation","tagId":"engineer","conversation":"planning"}),
    ] {
        assert_eq!(timeout(WAIT, receive.recv()).await.unwrap(), Some(expected));
    }
    assert_eq!(
        timeout(WAIT, received_tokens.recv())
            .await
            .unwrap()
            .as_deref(),
        Some("")
    );
    assert_eq!(
        timeout(WAIT, received_tokens.recv())
            .await
            .unwrap()
            .as_deref(),
        Some("after-public-task")
    );
    drop(stop);
    timeout(WAIT, watch).await.unwrap().unwrap();
    assert!(timeout(WAIT, received_stop.recv()).await.unwrap().is_some());
    assert!(receive.recv().await.is_none());
    server.abort();
}
