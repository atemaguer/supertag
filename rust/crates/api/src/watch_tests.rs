//! A stalled Watch consumer holds back the API tier's upstream reads: the tier relays
//! with flow control and buffers nothing on the consumer's behalf.
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;

use supertag_protocol::v2::{
    WatchChange, WatchEvent, WatchKind, WatchRequest,
    operator_events_client::OperatorEventsClient,
    operator_events_server::{OperatorEvents, OperatorEventsServer},
    watch_event::Update,
};
use tokio::net::TcpListener;
use tokio_stream::{Stream, StreamExt as _, wrappers::TcpListenerStream};
use tokio_util::sync::CancellationToken;
use tonic::{
    Request, Response, Status,
    transport::{Endpoint, Server},
};

use crate::Api;

const PAYLOAD_BYTES: usize = 256 * 1024;

/// A state owner stand-in whose Watch produces without end. It counts only the events a reader
/// actually pulled from it.
struct EndlessWatch {
    produced: Arc<AtomicU64>,
}

#[tonic::async_trait]
impl OperatorEvents for EndlessWatch {
    type WatchStream = std::pin::Pin<Box<dyn Stream<Item = Result<WatchEvent, Status>> + Send>>;

    async fn watch(
        &self,
        _request: Request<WatchRequest>,
    ) -> Result<Response<Self::WatchStream>, Status> {
        let produced = self.produced.clone();
        let payload = "x".repeat(PAYLOAD_BYTES);
        let events = tokio_stream::iter(1_u64..).map(move |position| {
            produced.fetch_add(1, Ordering::SeqCst);
            Ok(WatchEvent {
                resume_token: format!("v1.{:032x}.{position}", 0),
                update: Some(Update::Change(WatchChange {
                    kind: WatchKind::Task as i32,
                    id: format!("task-{position}"),
                    conversation: payload.clone(),
                    ..Default::default()
                })),
            })
        });
        Ok(Response::new(Box::pin(events)))
    }
}

async fn serve(router: tonic::transport::server::Router) -> std::net::SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(router.serve_with_incoming(TcpListenerStream::new(listener)));
    address
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stalled_watch_consumer_holds_back_upstream_reads() {
    let produced = Arc::new(AtomicU64::new(0));
    let state_owner = serve(
        Server::builder().add_service(
            OperatorEventsServer::new(EndlessWatch {
                produced: produced.clone(),
            })
            .max_encoding_message_size(1024 * 1024),
        ),
    )
    .await;
    let api = Api::new(
        supertag_protocol::negotiation::bind_current(
            Endpoint::from_shared(format!("http://{state_owner}"))
                .unwrap()
                .connect_lazy(),
        ),
        "service-test-token".into(),
        "operator-test-token".into(),
        "operator:alice".into(),
    )
    .unwrap();
    let public =
        serve(Server::builder().add_service(api.operator_events_service(CancellationToken::new())))
            .await;
    let channel = supertag_protocol::negotiation::bind_current(
        Endpoint::from_shared(format!("http://{public}"))
            .unwrap()
            .initial_stream_window_size(16 * 1024)
            .initial_connection_window_size(16 * 1024)
            .connect()
            .await
            .unwrap(),
    );
    let mut watch = OperatorEventsClient::new(channel)
        .max_decoding_message_size(1024 * 1024)
        .watch(
            supertag_protocol::authenticated_request(
                WatchRequest {
                    resume_token: String::new(),
                    kinds: vec![WatchKind::Task as i32],
                },
                "operator-test-token",
                None,
            )
            .unwrap(),
        )
        .await
        .unwrap()
        .into_inner();
    let first = watch.message().await.unwrap().unwrap();
    assert!(matches!(first.update, Some(Update::Change(_))));

    // Stop reading. A tier that buffered for the stalled reader would keep pulling
    // ~256 KiB events from upstream as fast as they were produced.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let stalled = produced.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(
        produced.load(Ordering::SeqCst),
        stalled,
        "the API tier kept reading upstream for a stalled consumer"
    );
    assert!(
        stalled < 64,
        "the API tier pulled {stalled} upstream events for a reader that took one"
    );

    // Reading again resumes the same stream in order: the stall was flow control.
    let mut last = 1;
    for _ in 0..(stalled + 32) {
        let Some(Update::Change(change)) = watch.message().await.unwrap().unwrap().update else {
            panic!("unexpected Watch update");
        };
        let position: u64 = change.id.trim_start_matches("task-").parse().unwrap();
        assert_eq!(position, last + 1);
        last = position;
    }
    assert!(produced.load(Ordering::SeqCst) > stalled);
}
