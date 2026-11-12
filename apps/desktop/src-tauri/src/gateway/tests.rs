use super::*;
use supertag_control_plane::ControlPlane;
use supertag_gateway::Gateway;
use supertag_protocol::{
    authenticated_request,
    v2::{conversations_server::ConversationsServer, operator_server::OperatorServer},
};
use tokio::net::TcpListener;
use tokio_stream::wrappers::TcpListenerStream;
use tonic::transport::Server;

#[test]
fn only_origin_urls_and_loopback_plaintext_are_accepted() {
    for value in [
        "http://127.0.0.1:4545",
        "http://[::1]:4545/",
        "https://gateway.example.com",
        "https://127.0.0.1:4545",
    ] {
        assert!(endpoint(value).is_ok(), "{value}");
    }
    for value in [
        "http://localhost:4545",
        "http://gateway.example.com",
        "http://192.168.0.1",
        "http://127.0.0.1:0",
        "file:///tmp/socket",
        "https://token@gateway.example.com",
        "https://gateway.example.com/path",
        "https://gateway.example.com/?token=secret",
        "https://gateway.example.com/#secret",
        "http://127.0.0.1\\@example.com",
        "127.0.0.1:4545",
    ] {
        assert!(endpoint(value).is_err(), "{value}");
    }
    for token in ["", "secret\nvalue", "secret value", "secret\tvalue"] {
        assert!(bearer(token).is_err());
    }
    assert!(bearer("operator-test-token").unwrap().is_sensitive());
}

#[test]
fn upstream_diagnostics_are_not_exposed() {
    let secret = "token-that-an-untrusted-server-echoed";
    for code in [
        Code::Unauthenticated,
        Code::Unknown,
        Code::InvalidArgument,
        Code::Internal,
        Code::Unavailable,
    ] {
        assert!(!rpc_error(Status::new(code, secret)).contains(secret));
    }
}

#[test]
fn messages_keep_structured_live_input_state_and_camel_case_fields() {
    let message = Message::try_from(v2::ConversationMessage {
        task: Some(v2::Task {
            task_id: "follower".into(),
            tag_id: "engineer".into(),
            state: v2::TaskState::Queued as i32,
            ..Default::default()
        }),
        conversation: "planning".into(),
        live_input: Some(v2::LiveInput {
            input_id: "input".into(),
            task_id: "running".into(),
            follower_task_id: "follower".into(),
            state: v2::LiveInputState::Dispatching as i32,
            order: 4,
            ..Default::default()
        }),
    })
    .unwrap();
    let json = serde_json::to_value(message).unwrap();
    assert_eq!(json["task"]["taskId"], "follower");
    assert_eq!(json["task"]["state"], "queued");
    assert!(json["task"].get("result").is_none());
    assert_eq!(json["liveInput"]["state"], "dispatching");
    assert_eq!(json["liveInput"]["followerTaskId"], "follower");
}

#[tokio::test]
async fn native_client_uses_authenticated_gateway_and_durable_message_operations() {
    let directory = tempfile::tempdir().unwrap();
    let cp = ControlPlane::open(
        &format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("state.sqlite").display()
        ),
        "private-test-token".into(),
    )
    .await
    .unwrap();
    let cp_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let cp_address = cp_listener.local_addr().unwrap();
    let cp_task = tokio::spawn(
        Server::builder()
            .add_service(OperatorServer::new(cp.clone()))
            .add_service(ConversationsServer::new(cp))
            .serve_with_incoming(TcpListenerStream::new(cp_listener)),
    );
    let channel = Endpoint::from_shared(format!("http://{cp_address}"))
        .unwrap()
        .connect()
        .await
        .unwrap();
    let gateway = Gateway::new(
        channel,
        "private-test-token".into(),
        "operator-test-token".into(),
        "operator:desktop-test".into(),
    )
    .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let gateway_task = tokio::spawn(
        Server::builder()
            .add_service(gateway.operator_service())
            .add_service(gateway.conversations_service())
            .serve_with_incoming(TcpListenerStream::new(listener)),
    );
    let mut operator = OperatorClient::connect(address.clone()).await.unwrap();
    operator
        .put_tag(
            authenticated_request(
                v2::PutTagRequest {
                    tag_id: "engineer".into(),
                    instructions: "Help with engineering".into(),
                    allowed_actions: vec!["files:read".into()],
                    harness_kind: v2::HarnessKind::Codex as i32,
                    ..Default::default()
                },
                "operator-test-token",
                None,
            )
            .unwrap(),
        )
        .await
        .unwrap();

    let client = GatewayState::default();
    assert!(client.tags().await.is_err());
    assert_eq!(
        client
            .connect(address.clone(), "wrong-token".into())
            .await
            .unwrap_err(),
        "The Gateway rejected the operator token."
    );
    assert!(client.tags().await.is_err());
    client
        .connect(address.clone(), "operator-test-token".into())
        .await
        .unwrap();
    let tags = client.tags().await.unwrap();
    assert_eq!(tags.len(), 1);
    assert_eq!(tags[0].tag_id, "engineer");
    assert_eq!(tags[0].harness_kind, "codex");
    let first = client
        .send(
            "engineer".into(),
            "planning".into(),
            "Explain the change".into(),
            "desktop-operation".into(),
        )
        .await
        .unwrap();
    let replay = client
        .send(
            "engineer".into(),
            "planning".into(),
            "Explain the change".into(),
            "desktop-operation".into(),
        )
        .await
        .unwrap();
    assert_eq!(first.task.task_id, replay.task.task_id);
    assert_eq!(first.task.state, "queued");
    assert!(
        client
            .send(
                "engineer".into(),
                "planning".into(),
                "Different content".into(),
                "desktop-operation".into()
            )
            .await
            .is_err()
    );
    let conversations = client.conversations("engineer".into()).await.unwrap();
    assert_eq!(conversations.len(), 1);
    assert_eq!(conversations[0].name, "planning");
    assert_eq!(
        conversations[0].latest_task.as_ref().unwrap().task_id,
        first.task.task_id
    );
    let page = client
        .messages("engineer".into(), "planning".into(), None)
        .await
        .unwrap();
    assert_eq!(page.messages.len(), 1);
    assert!(page.next_cursor.is_empty());
    assert_eq!(
        client
            .message("engineer".into(), first.task.task_id.clone())
            .await
            .unwrap()
            .task
            .prompt,
        "Explain the change"
    );
    assert!(
        client
            .events("engineer".into(), first.task.task_id, 0)
            .await
            .unwrap()
            .is_empty()
    );
    let previous = client.session().await.unwrap();
    client.disconnect().await;
    assert!(client.current(&previous, ()).await.is_err());
    assert!(client.tags().await.is_err());
    client
        .connect(address.clone(), "operator-test-token".into())
        .await
        .unwrap();
    assert!(client.current(&previous, ()).await.is_err());
    // A failed replacement cannot leave the old privileged session connected.
    assert!(client.connect(address, "wrong-token".into()).await.is_err());
    assert!(client.tags().await.is_err());
    gateway_task.abort();
    cp_task.abort();
}
