use super::*;
use supertag_api::Api;
use supertag_control_plane::ControlPlane;
use supertag_protocol::{
    authenticated_request,
    v2::{conversations_server::ConversationsServer, operator_server::OperatorServer},
};
use tokio::net::TcpListener;
use tokio_stream::wrappers::TcpListenerStream;
use tonic::transport::Server;

#[test]
fn only_origin_or_tunnel_urls_and_loopback_plaintext_are_accepted() {
    for value in [
        "http://127.0.0.1:4545",
        "http://[::1]:4545/",
        "https://gateway.example.com",
        "https://127.0.0.1:4545",
        "ws://127.0.0.1:4545",
        "ws://[::1]:4545/supertag",
        "wss://gateway.example.com",
        "wss://gateway.example.com:8443/supertag",
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
        "ws://localhost:4545",
        "ws://gateway.example.com",
        "wss://token@gateway.example.com",
        "wss://gateway.example.com/?token=secret",
        "wss://gateway.example.com/#secret",
        "wss://gateway.example.com:0",
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
        Code::Internal,
        Code::Unavailable,
    ] {
        assert!(!rpc_error(Status::new(code, secret)).contains(secret));
    }
}

#[test]
fn an_invalid_request_shows_the_gateways_reason() {
    assert_eq!(
        rpc_error(Status::invalid_argument(
            "tag_id must be 1 to 64 lowercase letters, digits, or hyphens.\u{1b}[2J"
        )),
        "The Gateway rejected this request: tag_id must be 1 to 64 lowercase letters, digits, or hyphens.[2J."
    );
    assert_eq!(
        rpc_error(Status::invalid_argument("")),
        "The Gateway rejected this request. Check its values."
    );
    assert!(rpc_error(Status::invalid_argument("x".repeat(5_000))).len() < 400);
}

/// A SuperTag 0.3.0 Gateway speaks only protocol 2. The app refuses it when it connects,
/// naming both releases, where the Gateway runs, and which to upgrade.
#[tokio::test]
async fn a_gateway_from_an_older_protocol_is_refused_on_connect_with_the_fix() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(
        Server::builder()
            .add_service(
                supertag_protocol::negotiation::Negotiator::new(
                    v2::ServiceRole::Gateway,
                    &[v2::ServiceRole::Client],
                )
                .with_versions(&[2])
                .service(),
            )
            .serve_with_incoming(TcpListenerStream::new(listener)),
    );
    let refused = Session::connect(endpoint(&address).unwrap(), "operator-test-token")
        .await
        .err()
        .unwrap();
    assert_eq!(
        refused,
        format!(
            "This app speaks SuperTag protocol 3, but the Gateway at {address} runs SuperTag {} (protocol 2). Upgrade the Gateway.",
            supertag_protocol::negotiation::build_version()
        )
    );
    server.abort();
}

#[test]
fn messages_keep_structured_live_input_state_and_camel_case_fields() {
    let message = Message::try_from(v2::ConversationMessage {
        task: Some(v2::Task {
            task_id: "follower".into(),
            tag_id: "engineer".into(),
            prompt: "Operator message".into(),
            state: v2::TaskState::Queued as i32,
            ..Default::default()
        }),
        live_input: Some(v2::LiveInput {
            input_id: "input".into(),
            task_id: "running".into(),
            follower_task_id: "follower".into(),
            state: v2::LiveInputState::Dispatching as i32,
            order: 4,
            ..Default::default()
        }),
        work_session_report_id: None,
        events: vec![v2::TaskEvent {
            sequence: 3,
            text: "Looking at the build.".into(),
            kind: v2::TaskEventKind::Message as i32,
        }],
        events_truncated: true,
        order: 9,
        sent_at_ms: 1_000,
        completed_at_ms: None,
        schedule_id: None,
        work_session_close_reason: 0,
    })
    .unwrap();
    let json = serde_json::to_value(message).unwrap();
    assert_eq!(json["task"]["taskId"], "follower");
    assert_eq!(json["task"]["state"], "queued");
    assert_eq!(json["task"]["prompt"], "Operator message");
    assert!(json["task"].get("result").is_none());
    assert!(json.get("workSessionReportId").is_none());
    assert_eq!(json["liveInput"]["state"], "dispatching");
    assert_eq!(json["liveInput"]["followerTaskId"], "follower");
    assert_eq!(json["events"][0]["sequence"], 3);
    assert_eq!(json["events"][0]["kind"], "message");
    assert_eq!(json["eventsTruncated"], true);
    assert_eq!(json["order"], 9);
    assert_eq!(json["task"]["createdAtMs"], 1_000);
    assert!(json.get("completedAtMs").is_none());
    assert!(json["task"].get("quiet").is_none());
}

#[test]
fn quiet_turns_and_open_questions_reach_the_window() {
    let message = Message::try_from(v2::ConversationMessage {
        task: Some(v2::Task {
            task_id: "check".into(),
            tag_id: "engineer".into(),
            state: v2::TaskState::Succeeded as i32,
            result: Some("CI is green".into()),
            quiet: true,
            ..Default::default()
        }),
        schedule_id: Some("schedule".into()),
        order: 12,
        ..Default::default()
    })
    .unwrap();
    assert_eq!(
        serde_json::to_value(message).unwrap()["task"]["quiet"],
        true
    );
    let asking = Conversation::from(v2::Conversation {
        tag_id: "engineer".into(),
        preview: "Which branch should I release?".into(),
        preview_from_tag: true,
        unread_count: 1,
        asking: true,
        ..Default::default()
    });
    assert_eq!(serde_json::to_value(asking).unwrap()["asking"], true);
}

#[test]
fn work_session_reports_keep_result_and_identity_but_strip_internal_input() {
    let report = v2::Task {
        task_id: "report-task".into(),
        tag_id: "engineer".into(),
        session_id: "conversation/planning".into(),
        state: v2::TaskState::Succeeded as i32,
        prompt: "Internal report instructions with raw child output".into(),
        result: Some("The dependency update passed verification.".into()),
        artifacts: vec![v2::ArtifactSelection {
            artifact_id: "report-capture".into(),
            paths: vec!["outputs/review.md".into()],
        }],
        ..Default::default()
    };
    let message = Message::try_from(v2::ConversationMessage {
        task: Some(report.clone()),
        live_input: Some(v2::LiveInput {
            text: "Unexpected internal input".into(),
            ..Default::default()
        }),
        work_session_report_id: Some("work/dependency".into()),
        work_session_close_reason: v2::WorkSessionCloseReason::Idle as i32,
        events: vec![],
        events_truncated: false,
        order: 10,
        sent_at_ms: 1_000,
        completed_at_ms: Some(2_000),
        schedule_id: None,
    })
    .unwrap();
    let json = serde_json::to_value(message).unwrap();
    assert_eq!(json["workSessionReportId"], "work/dependency");
    assert_eq!(json["workSessionClosed"], "idle");
    assert_eq!(json["task"]["taskId"], "report-task");
    assert_eq!(json["task"]["state"], "succeeded");
    assert_eq!(
        json["task"]["result"],
        "The dependency update passed verification."
    );
    assert_eq!(json["task"]["artifacts"][0]["artifactId"], "report-capture");
    assert_eq!(
        json["task"]["artifacts"][0]["paths"][0],
        "outputs/review.md"
    );
    assert!(json["task"].get("prompt").is_none());
    assert!(json.get("liveInput").is_none());
    assert!(json.get("eventsTruncated").is_none());

    assert_eq!(json["completedAtMs"], 2_000);

    let summary = Conversation::from(v2::Conversation {
        tag_id: "engineer".into(),
        preview: "The dependency update passed verification.".into(),
        preview_from_tag: true,
        unread_count: 2,
        working: true,
        ..Default::default()
    });
    let json = serde_json::to_value(summary).unwrap();
    assert_eq!(json["tagId"], "engineer");
    assert_eq!(json["previewFromTag"], true);
    assert_eq!(json["unreadCount"], 2);
    assert_eq!(json["working"], true);
}

/// A Control Plane (its state owner and API tier) and, in front of it, a Gateway whose client API
/// forwards to it, as `supertag up` runs them. With `tunnel`, the Gateway also accepts WebSocket
/// tunnels, as with `--websocket-listen`, and the returned URL is a `ws://` tunnel URL with a path.
pub(super) async fn gateway_fixture(
    database: &std::path::Path,
    tag_id: &str,
    token: &str,
    tunnel: bool,
) -> (
    String,
    tokio::task::JoinHandle<std::result::Result<(), tonic::transport::Error>>,
    tokio::task::JoinHandle<std::result::Result<(), tonic::transport::Error>>,
) {
    let stack = Stack::start(database, token, None).await;
    stack.put_tag(tag_id).await;
    let url = if tunnel {
        stack.tunnel_url.clone()
    } else {
        stack.url.clone()
    };
    (url, stack.gateway_task, stack.control_plane_task)
}

/// One disposable deployment: a Control Plane on its own database, and its Gateway.
pub(super) struct Stack {
    /// The Gateway's native URL, which clients use.
    pub(super) url: String,
    pub(super) tunnel_url: String,
    /// The Control Plane's API tier, for operator setup that does not go through the Gateway.
    control_plane_url: String,
    token: String,
    pub(super) gateway_task:
        tokio::task::JoinHandle<std::result::Result<(), tonic::transport::Error>>,
    pub(super) control_plane_task:
        tokio::task::JoinHandle<std::result::Result<(), tonic::transport::Error>>,
}

impl Stack {
    /// Starts the stack; `gateway` reuses the Gateway's earlier address, as a restart does.
    pub(super) async fn start(
        database: &std::path::Path,
        token: &str,
        gateway: Option<std::net::SocketAddr>,
    ) -> Self {
        let cp = ControlPlane::open(
            &format!("sqlite://{}?mode=rwc", database.display()),
            "private-test-token".into(),
            "operator:desktop-test".into(),
        )
        .await
        .unwrap();
        let owner_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let owner_address = owner_listener.local_addr().unwrap();
        let owner_task = tokio::spawn(
            Server::builder()
                .add_service(OperatorServer::new(cp.clone()))
                .add_service(cp.credential_directory_service())
                .add_service(cp.enrollments_service())
                .add_service(ConversationsServer::new(cp.clone()))
                .add_service(cp.operator_events_service(tokio_util::sync::CancellationToken::new()))
                .serve_with_incoming(TcpListenerStream::new(owner_listener)),
        );
        let channel = Endpoint::from_shared(format!("http://{owner_address}"))
            .unwrap()
            .connect()
            .await
            .unwrap();
        let api = Api::new(
            supertag_protocol::negotiation::bind_current(channel),
            "private-test-token".into(),
            token.into(),
            "operator:desktop-test".into(),
        )
        .unwrap();
        let api_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let control_plane_url = format!("http://{}", api_listener.local_addr().unwrap());
        let shutdown = tokio_util::sync::CancellationToken::new();
        let api_task = tokio::spawn(
            Server::builder()
                .layer(supertag_protocol::negotiation::fence(
                    v2::ServiceRole::ControlPlane,
                ))
                .layer(api.authorize())
                .add_service(api.negotiation_service())
                .add_service(api.operator_service())
                .add_service(api.enrollments_service())
                .add_service(api.conversations_service(shutdown.clone()))
                .add_service(api.operator_events_service(shutdown))
                .serve_with_incoming(TcpListenerStream::new(api_listener)),
        );
        let control_plane_task = tokio::spawn(async move {
            let (owner, api) = tokio::join!(owner_task, api_task);
            owner.unwrap().and(api.unwrap())
        });

        // The Gateway negotiates with the Control Plane as a Gateway and forwards client calls.
        let upstream = supertag_protocol::negotiation::connect(
            Endpoint::from_shared(control_plane_url.clone())
                .unwrap()
                .connect()
                .await
                .unwrap(),
            v2::ServiceRole::Gateway,
            v2::ServiceRole::ControlPlane,
        )
        .await
        .unwrap();
        let client_api = supertag_gateway::client_api::ClientApi::new(vec![upstream]);
        let listener = bind_again(gateway.unwrap_or(([127, 0, 0, 1], 0).into())).await;
        let url = format!("http://{}", listener.local_addr().unwrap());
        let websocket = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let tunnel_url = format!("ws://{}/supertag", websocket.local_addr().unwrap());
        let gateway_task = tokio::spawn(
            Server::builder()
                .layer(supertag_protocol::negotiation::fence(
                    v2::ServiceRole::Gateway,
                ))
                .layer(client_api)
                .add_service(
                    supertag_protocol::negotiation::Negotiator::new(
                        v2::ServiceRole::Gateway,
                        &[v2::ServiceRole::Client],
                    )
                    .service(),
                )
                .serve_with_incoming(supertag_transport::incoming(listener, Some(websocket))),
        );
        Self {
            url,
            tunnel_url,
            control_plane_url,
            token: token.into(),
            gateway_task,
            control_plane_task,
        }
    }

    /// The Gateway's address, to start it again in the same place.
    pub(super) fn address(&self) -> std::net::SocketAddr {
        self.url.trim_start_matches("http://").parse().unwrap()
    }

    pub(super) async fn put_tag(&self, tag_id: &str) {
        let mut operator = OperatorClient::new(
            supertag_protocol::negotiation::connect(
                Endpoint::from_shared(self.control_plane_url.clone())
                    .unwrap()
                    .connect()
                    .await
                    .unwrap(),
                v2::ServiceRole::Client,
                v2::ServiceRole::ControlPlane,
            )
            .await
            .unwrap(),
        );
        operator
            .put_tag(
                authenticated_request(
                    v2::PutTagRequest {
                        tag_id: tag_id.into(),
                        instructions: "Help with engineering".into(),
                        allowed_actions: vec!["files:read".into()],
                        harness_kind: v2::HarnessKind::Codex as i32,
                        lead: Some(true),
                        ..Default::default()
                    },
                    &self.token,
                    None,
                )
                .unwrap(),
            )
            .await
            .unwrap();
    }

    /// Stops both services, as a machine restart would.
    pub(super) async fn stop(self) {
        self.gateway_task.abort();
        self.control_plane_task.abort();
        let _ = self.gateway_task.await;
        let _ = self.control_plane_task.await;
    }
}

/// Binds `address`, retrying briefly while a just-stopped listener releases it.
async fn bind_again(address: std::net::SocketAddr) -> TcpListener {
    for _ in 0..50 {
        if let Ok(listener) = TcpListener::bind(address).await {
            return listener;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    TcpListener::bind(address).await.unwrap()
}

#[tokio::test]
async fn native_client_uses_authenticated_gateway_and_durable_message_operations() {
    let directory = tempfile::tempdir().unwrap();
    let (address, gateway_task, cp_task) = gateway_fixture(
        &directory.path().join("state.sqlite"),
        "engineer",
        "operator-test-token",
        false,
    )
    .await;
    let client = GatewayState::default();
    let profiles = directory.path().join("gateways.json");
    assert!(client.tags("0").await.is_err());
    assert_eq!(
        client
            .save_gateway(
                &profiles,
                address.clone(),
                "Engineering".into(),
                "wrong-token".into()
            )
            .await
            .unwrap_err(),
        "The Gateway rejected the saved credential."
    );
    assert!(!profiles.exists());
    let first_connection = client
        .save_gateway(
            &profiles,
            address.clone(),
            "Engineering".into(),
            "operator-test-token".into(),
        )
        .await
        .unwrap();
    let id = first_connection.connection_id();
    let tags = client.tags(id).await.unwrap();
    assert_eq!(tags.len(), 1);
    assert_eq!(tags[0].tag_id, "engineer");
    assert_eq!(tags[0].harness_kind, "codex");
    assert!(tags[0].lead);
    let first = client
        .send(
            id,
            "engineer".into(),
            "Explain the change".into(),
            "desktop-operation".into(),
        )
        .await
        .unwrap();
    let replay = client
        .send(
            id,
            "engineer".into(),
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
                id,
                "engineer".into(),
                "Different content".into(),
                "desktop-operation".into()
            )
            .await
            .is_err()
    );
    let conversations = client.conversations(id).await.unwrap();
    assert_eq!(conversations.len(), 1);
    assert_eq!(conversations[0].tag_id, "engineer");
    assert_eq!(conversations[0].preview, "Explain the change");
    assert!(conversations[0].working);
    let page = client
        .messages(
            id,
            ReadMessages {
                tag_id: "engineer".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(page.messages.len(), 1);
    assert!(page.next_cursor.is_empty());
    assert_eq!(page.conversation_id, first.task.session_id);
    // The copy the app keeps is current: nothing changed after its latest message.
    let changes = client
        .messages(
            id,
            ReadMessages {
                tag_id: "engineer".into(),
                after: Some(first.order),
                conversation_id: Some(page.conversation_id.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(changes.incremental);
    assert!(changes.messages.is_empty());
    let read = client
        .mark_read(id, "engineer".into(), first.order)
        .await
        .unwrap();
    assert_eq!(read.read_order, first.order);
    assert_eq!(
        client
            .message(id, "engineer".into(), first.task.task_id.clone())
            .await
            .unwrap()
            .task
            .prompt
            .as_deref(),
        Some("Explain the change")
    );
    assert!(
        client
            .events(id, first.task.task_id, 0)
            .await
            .unwrap()
            .is_empty()
    );
    let previous = client.session(id).await.unwrap();
    client.disconnect().await;
    assert!(client.current(&previous, ()).await.is_err());
    assert!(client.tags(id).await.is_err());
    let replacement = client
        .select_gateway(&profiles, address.clone())
        .await
        .unwrap();
    let replacement_id = replacement.connection_id();
    assert_ne!(id, replacement_id);
    assert!(client.current(&previous, ()).await.is_err());
    assert!(client.tags(id).await.is_err());
    assert!(
        client
            .save_gateway(
                &profiles,
                address,
                "Engineering".into(),
                "wrong-token".into()
            )
            .await
            .is_err()
    );
    assert_eq!(
        client.tags(replacement_id).await.unwrap()[0].tag_id,
        "engineer"
    );
    gateway_task.abort();
    cp_task.abort();
}

#[tokio::test]
/// The second Gateway is saved and reached through a `ws://` tunnel URL, which keeps its
/// path.
async fn saved_gateways_switch_rosters_and_scope_late_ipc_requests() {
    let directory = tempfile::tempdir().unwrap();
    let store = directory.path().join("gateways.json");
    let (first, first_gateway, first_plane) = gateway_fixture(
        &directory.path().join("first.sqlite"),
        "first-tag",
        "first-operator",
        false,
    )
    .await;
    let (second, second_gateway, second_plane) = gateway_fixture(
        &directory.path().join("second.sqlite"),
        "second-tag",
        "second-operator",
        true,
    )
    .await;

    let state = GatewayState::default();
    let a = state
        .save_gateway(
            &store,
            format!("{first}/"),
            "First".into(),
            "first-operator".into(),
        )
        .await
        .unwrap();
    let b = state
        .save_gateway(
            &store,
            second.clone(),
            "Second".into(),
            "second-operator".into(),
        )
        .await
        .unwrap();
    assert_eq!(
        state.tags(b.connection_id()).await.unwrap()[0].tag_id,
        "second-tag"
    );
    assert_eq!(
        state
            .send(
                a.connection_id(),
                "second-tag".into(),
                "Old workspace".into(),
                "stale".into()
            )
            .await
            .unwrap_err(),
        "The connection changed. Refresh this view."
    );
    assert!(
        state
            .conversations(b.connection_id())
            .await
            .unwrap()
            .is_empty()
    );

    let snapshot = serde_json::to_value(state.saved_gateways(&store).await.unwrap()).unwrap();
    assert_eq!(snapshot["active"], second);
    assert_eq!(
        snapshot["profiles"][0],
        serde_json::json!({"origin": first, "name": "First"})
    );
    assert_eq!(
        snapshot["profiles"][1],
        serde_json::json!({"origin": second, "name": "Second"})
    );
    let resumed = GatewayState::default();
    let a = resumed.select_gateway(&store, first.clone()).await.unwrap();
    assert_eq!(
        resumed.tags(a.connection_id()).await.unwrap()[0].tag_id,
        "first-tag"
    );
    let edited = resumed
        .save_gateway(&store, first.clone(), "Renamed".into(), String::new())
        .await
        .unwrap();
    assert_eq!(
        resumed.tags(edited.connection_id()).await.unwrap()[0].tag_id,
        "first-tag"
    );
    let forgotten = resumed
        .clear_gateway(&store, Some(second.clone()))
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(forgotten).unwrap()["active"], first);
    assert!(resumed.select_gateway(&store, second).await.is_err());
    resumed.clear_gateway(&store, None).await.unwrap();
    assert!(resumed.tags(edited.connection_id()).await.is_err());
    assert!(
        serde_json::to_value(resumed.saved_gateways(&store).await.unwrap()).unwrap()["active"]
            .is_null()
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&store).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let alias = directory.path().join("alias");
        std::os::unix::fs::symlink(&store, &alias).unwrap();
        assert!(resumed.saved_gateways(&alias).await.is_err());
    }
    for server in [first_gateway, first_plane, second_gateway, second_plane] {
        server.abort();
    }
}

/// A client Auth Key joins this device once as client:NAME: only the enrolled credential is saved,
/// and the app connects as that client, limited to the Tags its key allows.
#[tokio::test]
async fn an_auth_key_enrolls_this_device_and_only_its_credential_is_saved() {
    use sha2::{Digest, Sha256};
    let directory = tempfile::tempdir().unwrap();
    let store = directory.path().join("gateways.json");
    let (address, gateway, plane) = gateway_fixture(
        &directory.path().join("state.sqlite"),
        "allowed-tag",
        "join-operator",
        false,
    )
    .await;
    let mut operator = OperatorClient::new(
        supertag_protocol::negotiation::connect(
            Endpoint::from_shared(address.clone())
                .unwrap()
                .connect()
                .await
                .unwrap(),
            v2::ServiceRole::Client,
            v2::ServiceRole::Gateway,
        )
        .await
        .unwrap(),
    );
    operator
        .put_tag(
            authenticated_request(
                v2::PutTagRequest {
                    tag_id: "hidden-tag".into(),
                    instructions: "Not for this device".into(),
                    ..Default::default()
                },
                "join-operator",
                None,
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let key = supertag_protocol::new_secret(supertag_protocol::AUTH_KEY_SECRET_PREFIX);
    operator
        .create_auth_key(
            authenticated_request(
                v2::CreateAuthKeyRequest {
                    name: "laptops".into(),
                    role: v2::PrincipalRole::Client.into(),
                    operation_id: "laptops".into(),
                    key_digest: Sha256::digest(key.as_bytes()).to_vec(),
                    allowed_tag_ids: vec!["allowed-tag".into()],
                    ..Default::default()
                },
                "join-operator",
                None,
            )
            .unwrap(),
        )
        .await
        .unwrap();

    let state = GatewayState::default();
    let joined = state
        .save_gateway(&store, address.clone(), "Work".into(), key.clone())
        .await
        .unwrap();
    assert_eq!(joined.principal(), format!("client:{}", device_name()));
    let tags = state.tags(joined.connection_id()).await.unwrap();
    assert_eq!(
        tags.iter()
            .map(|tag| tag.tag_id.as_str())
            .collect::<Vec<_>>(),
        ["allowed-tag"]
    );
    // A client device converses with its Tags but cannot create one or list hosts.
    let refused = state
        .create_tag(
            joined.connection_id(),
            NewTag {
                tag_id: "device-tag".into(),
                name: None,
                harness: "codex".into(),
                workspace_id: None,
                max_work_sessions: None,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(refused, "Only an operator can create Tags.");
    assert!(state.tag_options(joined.connection_id()).await.is_err());
    let saved = std::fs::read_to_string(&store).unwrap();
    assert!(!saved.contains(&key), "the Auth Key was saved");
    assert!(saved.contains(supertag_protocol::CREDENTIAL_SECRET_PREFIX));
    // The one-time key admits no second device.
    let second = GatewayState::default();
    assert!(
        second
            .save_gateway(
                &directory.path().join("other.json"),
                address,
                "Again".into(),
                key,
            )
            .await
            .is_err()
    );
    gateway.abort();
    plane.abort();
}

#[tokio::test]
async fn artifact_save_checks_authority_and_bytes_and_keeps_existing_files() {
    use sha2::{Digest, Sha256};
    use v2::{
        ArtifactDownload, ArtifactFile, BlobReference, DownloadArtifactFileRequest,
        artifact_download::Part,
        artifact_transfers_server::{ArtifactTransfers, ArtifactTransfersServer},
    };

    const BODY: &[u8] = b"artifact fixture";
    const PATH: &str = "outputs/report.txt";

    struct Transfers;
    #[tonic::async_trait]
    impl ArtifactTransfers for Transfers {
        type DownloadFileStream =
            tokio_stream::Iter<std::vec::IntoIter<std::result::Result<ArtifactDownload, Status>>>;

        type DownloadAcquiredFileStream = Self::DownloadFileStream;

        async fn download_acquired_file(
            &self,
            _: Request<v2::GetAcquiredArtifactFileRequest>,
        ) -> std::result::Result<tonic::Response<Self::DownloadAcquiredFileStream>, Status>
        {
            Err(Status::unimplemented("unused"))
        }

        async fn download_file(
            &self,
            request: Request<DownloadArtifactFileRequest>,
        ) -> std::result::Result<tonic::Response<Self::DownloadFileStream>, Status> {
            if request
                .metadata()
                .get("authorization")
                .and_then(|header| header.to_str().ok())
                != Some("Bearer artifact-operator")
            {
                return Err(Status::unauthenticated("unexpected credential"));
            }
            let input = request.into_inner();
            if input.path != PATH {
                return Err(Status::not_found("path missing"));
            }
            let digest = if input.artifact_id == "corrupted" {
                Sha256::digest(b"other bytes")
            } else {
                Sha256::digest(BODY)
            };
            let frames = vec![
                Ok(ArtifactDownload {
                    part: Some(Part::File(ArtifactFile {
                        git_output: None,
                        path: input.path,
                        blob: Some(BlobReference {
                            sha256: format!("{digest:x}"),
                            byte_length: BODY.len() as u64,
                        }),
                    })),
                }),
                Ok(ArtifactDownload {
                    part: Some(Part::Chunk(BODY.to_vec())),
                }),
            ];
            Ok(tonic::Response::new(tokio_stream::iter(frames)))
        }
    }

    let directory = tempfile::tempdir().unwrap();
    let destination = directory.path().join("saved.txt");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(
        Server::builder()
            .add_service(ArtifactTransfersServer::new(Transfers))
            .serve_with_incoming(TcpListenerStream::new(listener)),
    );
    let client = GatewayState::default();
    client.0.write().await.session = Some(Arc::new(Session {
        channel: supertag_protocol::negotiation::bind_current(
            endpoint(&address).unwrap().connect().await.unwrap(),
        ),
        authorization: bearer("artifact-operator").unwrap(),
    }));

    assert!(
        !client
            .save_artifact("0", "valid".into(), PATH.into(), |_| async { Ok(None) })
            .await
            .unwrap()
    );
    assert!(
        client
            .save_artifact("0", "corrupted".into(), PATH.into(), |_| async {
                Ok(Some(destination.clone()))
            })
            .await
            .unwrap_err()
            .contains("did not match")
    );
    assert!(!destination.exists());
    let first_destination = destination.clone();
    assert!(
        client
            .save_artifact("0", "valid".into(), PATH.into(), |name| async move {
                assert_eq!(name, "report.txt");
                Ok(Some(first_destination))
            })
            .await
            .unwrap()
    );
    assert_eq!(std::fs::read(&destination).unwrap(), BODY);

    std::fs::write(&destination, b"operator file").unwrap();
    assert!(
        client
            .save_artifact("0", "valid".into(), PATH.into(), |_| async {
                Ok(Some(destination.clone()))
            })
            .await
            .unwrap_err()
            .contains("already exists")
    );
    assert_eq!(std::fs::read(&destination).unwrap(), b"operator file");

    let obsolete = directory.path().join("obsolete.txt");
    assert!(
        client
            .save_artifact("0", "valid".into(), PATH.into(), |_| async {
                client.disconnect().await;
                Ok(Some(obsolete.clone()))
            })
            .await
            .unwrap_err()
            .contains("connection changed")
    );
    assert!(!obsolete.exists());
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    server.abort();
}

/// The local Gateway connects with the operator token in its state directory, read at each
/// connect, and nothing about it is saved.
#[cfg(unix)]
#[tokio::test]
async fn the_local_gateway_connects_with_its_current_token_and_is_never_saved() {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    let directory = tempfile::tempdir().unwrap();
    let store = directory.path().join("gateways.json");
    let operator = "e".repeat(64);
    let (address, gateway, plane) = gateway_fixture(
        &directory.path().join("state.sqlite"),
        "local-tag",
        &operator,
        false,
    )
    .await;
    let state_directory = directory.path().join("supertag");
    let state = GatewayState::new(Some(state_directory.clone()));
    let listed = serde_json::to_value(state.saved_gateways(&store).await.unwrap()).unwrap();
    assert!(listed["local"]["origin"].is_null());
    assert!(
        listed["local"]["problem"]
            .as_str()
            .unwrap()
            .contains("supertag up")
    );

    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&state_directory)
        .unwrap();
    let private = |name: &str, contents: String| {
        let path = state_directory.join(name);
        std::fs::write(&path, contents).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    };
    let credentials = |token: &str| {
        let enrolled =
            || supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
        serde_json::json!({
            "gateway_credential": enrolled(),
            "operator_token": token,
            "host_credential": enrolled(),
        })
        .to_string()
    };
    private("gateway-endpoint", format!("{address}\n"));
    private("credentials.json", credentials(&operator));
    // Stands in for the supervisor `supertag up` runs, which holds this lock.
    let lock =
        supertag_local_state::open_private_file(&state_directory.join(".lock"), true).unwrap();
    lock.try_lock().unwrap();

    let local = state.connect_local_gateway(&store).await.unwrap();
    assert_eq!(local.principal(), "operator:desktop-test");
    assert_eq!(
        state.tags(local.connection_id()).await.unwrap()[0].tag_id,
        "local-tag"
    );
    let activation = serde_json::to_value(&local).unwrap();
    assert_eq!(activation["origin"], "local");
    assert!(activation["gateways"]["active"].is_null());
    assert_eq!(activation["gateways"]["local"]["origin"], address);
    let saved = std::fs::read_to_string(&store).unwrap();
    assert!(!saved.contains(&operator), "the local token was saved");

    // A replaced token is read at the next connect.
    private("credentials.json", credentials(&"f".repeat(64)));
    assert!(state.connect_local_gateway(&store).await.is_err());
    private("credentials.json", credentials(&operator));
    state.connect_local_gateway(&store).await.unwrap();

    drop(lock);
    let stopped = state.connect_local_gateway(&store).await.unwrap_err();
    assert!(stopped.contains("supertag up"), "{stopped}");
    gateway.abort();
    plane.abort();
}

#[tokio::test]
async fn an_operator_creates_a_tag_once_with_the_lead_tag_defaults() {
    let directory = tempfile::tempdir().unwrap();
    let (address, gateway_task, cp_task) = gateway_fixture(
        &directory.path().join("state.sqlite"),
        "engineer",
        "operator-test-token",
        false,
    )
    .await;
    let client = GatewayState::default();
    let connection = client
        .save_gateway(
            &directory.path().join("gateways.json"),
            address,
            "Engineering".into(),
            "operator-test-token".into(),
        )
        .await
        .unwrap();
    let id = connection.connection_id();
    // No Worker Host has connected, so nothing is offered yet.
    assert_eq!(client.tag_options(id).await.unwrap(), TagOptions::default());
    let new_tag = || NewTag {
        tag_id: "reviewer".into(),
        name: Some("Reviewer".into()),
        harness: "claude_code".into(),
        workspace_id: None,
        max_work_sessions: None,
    };
    let created = client.create_tag(id, new_tag()).await.unwrap();
    assert_eq!(created.tag_id, "reviewer");
    assert_eq!(created.name, "Reviewer");
    assert_eq!(created.harness_kind, "claude_code");
    assert_eq!(created.revision, 1);
    assert!(!created.lead);
    assert_eq!(
        created.allowed_actions,
        ["commands:execute", "files:write", "schedule:create"]
    );
    assert_eq!(
        client.create_tag(id, new_tag()).await.unwrap_err(),
        "A Tag with that ID or name already exists."
    );
    let tags = client.tags(id).await.unwrap();
    assert_eq!(
        tags.iter()
            .map(|tag| tag.tag_id.as_str())
            .collect::<Vec<_>>(),
        ["engineer", "reviewer"]
    );
    gateway_task.abort();
    cp_task.abort();
}

#[tokio::test]
async fn a_conversation_follow_pushes_sent_messages_through_the_api_tier() {
    use tauri::ipc::{Channel, InvokeResponseBody};

    let directory = tempfile::tempdir().unwrap();
    let (address, gateway_task, cp_task) = gateway_fixture(
        &directory.path().join("state.sqlite"),
        "engineer",
        "operator-test-token",
        false,
    )
    .await;
    let client = GatewayState::default();
    let connection = client
        .save_gateway(
            &directory.path().join("gateways.json"),
            address,
            "Engineering".into(),
            "operator-test-token".into(),
        )
        .await
        .unwrap();
    let id = connection.connection_id();
    let (send, mut receive) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();
    let updates = Channel::new(move |body| {
        let InvokeResponseBody::Json(value) = body else {
            panic!("expected JSON IPC")
        };
        send.send(serde_json::from_str(&value).unwrap()).unwrap();
        Ok(())
    });
    let follow = client
        .start_follow(
            id,
            ReadMessages {
                tag_id: "engineer".into(),
                ..Default::default()
            },
            updates,
        )
        .await
        .unwrap();
    let wait = Duration::from_secs(5);
    let next = async |receive: &mut tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>| {
        tokio::time::timeout(wait, receive.recv())
            .await
            .unwrap()
            .unwrap()
    };
    assert_eq!(next(&mut receive).await["kind"], "ready");
    let sent = client
        .send(
            id,
            "engineer".into(),
            "Explain the change".into(),
            "follow-operation".into(),
        )
        .await
        .unwrap();
    let changed = next(&mut receive).await;
    assert_eq!(changed["kind"], "changed");
    assert_eq!(changed["messages"]["incremental"], false);
    assert_eq!(
        changed["messages"]["messages"][0]["task"]["taskId"],
        sent.task.task_id.as_str()
    );
    assert_eq!(
        changed["messages"]["messages"][0]["task"]["state"],
        "queued"
    );
    client.stop_follow(&follow).await;
    gateway_task.abort();
    cp_task.abort();
}

#[test]
fn scheduled_turns_name_their_schedule_and_carry_no_operator_message() {
    let message = Message::try_from(v2::ConversationMessage {
        task: Some(v2::Task {
            task_id: "woken".into(),
            tag_id: "engineer".into(),
            session_id: "conversation/planning".into(),
            state: v2::TaskState::Succeeded as i32,
            prompt: "Scheduled wake-up.".into(),
            result: Some("CI is green.".into()),
            ..Default::default()
        }),
        live_input: Some(v2::LiveInput::default()),
        schedule_id: Some("sch_1".into()),
        order: 11,
        ..Default::default()
    })
    .unwrap();
    let json = serde_json::to_value(message).unwrap();
    assert_eq!(json["scheduleId"], "sch_1");
    assert!(json["task"].get("prompt").is_none());
    assert!(json.get("liveInput").is_none());
    assert_eq!(json["task"]["result"], "CI is green.");
}

/// Watch updates the app received on one subscription, as JSON.
fn watch_updates() -> (
    tauri::ipc::Channel<super::watch::WatchUpdate>,
    tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>,
) {
    let (send, receive) = tokio::sync::mpsc::unbounded_channel();
    let channel = tauri::ipc::Channel::new(move |body| {
        let tauri::ipc::InvokeResponseBody::Json(value) = body else {
            panic!("expected JSON IPC")
        };
        let _ = send.send(serde_json::from_str(&value).unwrap());
        Ok(())
    });
    (channel, receive)
}

/// The next Watch update about a conversation, skipping readiness and resyncs.
async fn next_conversation_update(
    updates: &mut tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>,
) -> Option<serde_json::Value> {
    loop {
        let update = tokio::time::timeout(std::time::Duration::from_secs(5), updates.recv())
            .await
            .ok()??;
        if update["kind"] == "conversation" {
            return Some(update);
        }
    }
}

#[tokio::test]
/// The app keeps two separately deployed Gateways (each with its own Control Plane, database,
/// port, and operator token), switches between them, and sees each one's own Tags and
/// conversations. No cached entry, credential, or Watch stream crosses from one to the other, and
/// after both deployments restart the app reconnects to each.
async fn the_app_switches_between_two_gateways_without_leaking_state_and_reconnects_after_restarts()
{
    let directory = tempfile::tempdir().unwrap();
    let store = directory.path().join("gateways.json");
    let cache = directory.path().join("cache");
    let alpha_database = directory.path().join("alpha.sqlite");
    let beta_database = directory.path().join("beta.sqlite");
    let alpha = Stack::start(&alpha_database, "alpha-operator", None).await;
    alpha.put_tag("alpha-tag").await;
    let beta = Stack::start(&beta_database, "beta-operator", None).await;
    beta.put_tag("beta-tag").await;
    let (alpha_url, beta_url) = (alpha.url.clone(), beta.url.clone());
    assert_ne!(alpha_url, beta_url);

    let state = GatewayState::default();
    let a = state
        .save_gateway(
            &store,
            alpha_url.clone(),
            "Alpha".into(),
            "alpha-operator".into(),
        )
        .await
        .unwrap();
    let tags = state.tags(a.connection_id()).await.unwrap();
    assert_eq!(
        tags.iter()
            .map(|tag| tag.tag_id.as_str())
            .collect::<Vec<_>>(),
        ["alpha-tag"]
    );
    state
        .send(
            a.connection_id(),
            "alpha-tag".into(),
            "Only Alpha hears this".into(),
            "alpha-operation".into(),
        )
        .await
        .unwrap();
    state
        .cache(
            a.connection_id(),
            cache.clone(),
            "roster".into(),
            serde_json::json!(["alpha-tag"]),
        )
        .await
        .unwrap();
    let (alpha_updates, mut alpha_received) = watch_updates();
    state
        .start_watch(a.connection_id(), 1, alpha_updates)
        .await
        .unwrap();

    // Adding the second Gateway switches to it.
    let b = state
        .save_gateway(
            &store,
            beta_url.clone(),
            "Beta".into(),
            "beta-operator".into(),
        )
        .await
        .unwrap();
    assert_ne!(a.connection_id(), b.connection_id());
    let tags = state.tags(b.connection_id()).await.unwrap();
    assert_eq!(
        tags.iter()
            .map(|tag| tag.tag_id.as_str())
            .collect::<Vec<_>>(),
        ["beta-tag"]
    );
    // Beta has no conversation: Alpha's message stayed on Alpha.
    assert!(
        state
            .conversations(b.connection_id())
            .await
            .unwrap()
            .is_empty()
    );
    // Nothing Alpha cached is visible on Beta.
    assert!(
        state
            .cached(b.connection_id(), cache.clone(), "roster".into())
            .await
            .unwrap()
            .is_none()
    );
    // A late request on Alpha's connection is refused instead of reaching Beta.
    assert_eq!(
        state
            .send(
                a.connection_id(),
                "beta-tag".into(),
                "stale".into(),
                "stale-operation".into()
            )
            .await
            .unwrap_err(),
        "The connection changed. Refresh this view."
    );
    assert!(state.tags(a.connection_id()).await.is_err());
    // Switching ended Alpha's Watch: a change on Alpha no longer reaches the app.
    while alpha_received.try_recv().is_ok() {}
    let (beta_updates, mut beta_received) = watch_updates();
    state
        .start_watch(b.connection_id(), 2, beta_updates)
        .await
        .unwrap();
    // The Watch reports changes after it is established.
    loop {
        let update = tokio::time::timeout(std::time::Duration::from_secs(5), beta_received.recv())
            .await
            .expect("Beta's Watch became ready")
            .unwrap();
        if update["kind"] == "ready" {
            break;
        }
    }
    state
        .send(
            b.connection_id(),
            "beta-tag".into(),
            "Only Beta hears this".into(),
            "beta-operation".into(),
        )
        .await
        .unwrap();
    let update = next_conversation_update(&mut beta_received)
        .await
        .expect("Beta's Watch reports Beta's conversation");
    assert_eq!(update["tagId"], "beta-tag");
    assert!(
        next_conversation_update(&mut alpha_received)
            .await
            .is_none(),
        "Alpha's Watch outlived the switch"
    );
    let conversations = state.conversations(b.connection_id()).await.unwrap();
    assert_eq!(
        serde_json::to_value(&conversations).unwrap()[0]["tagId"],
        "beta-tag"
    );
    state
        .cache(
            b.connection_id(),
            cache.clone(),
            "roster".into(),
            serde_json::json!(["beta-tag"]),
        )
        .await
        .unwrap();

    // Switching back shows Alpha's own Tags, conversation, and cache, and nothing of Beta's.
    let a = state
        .select_gateway(&store, alpha_url.clone())
        .await
        .unwrap();
    assert_eq!(
        state.tags(a.connection_id()).await.unwrap()[0].tag_id,
        "alpha-tag"
    );
    let conversations =
        serde_json::to_value(state.conversations(a.connection_id()).await.unwrap()).unwrap();
    assert_eq!(conversations.as_array().unwrap().len(), 1);
    assert_eq!(conversations[0]["tagId"], "alpha-tag");
    assert_eq!(
        state
            .cached(a.connection_id(), cache.clone(), "roster".into())
            .await
            .unwrap(),
        Some(serde_json::json!(["alpha-tag"]))
    );
    // Each saved Gateway keeps only its own credential.
    let saved: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&store).unwrap()).unwrap();
    for entry in saved["gateways"].as_array().unwrap() {
        let origin = entry["profile"]["origin"].as_str().unwrap();
        let token = entry["token"].as_str().unwrap();
        assert_eq!(
            token,
            if origin == alpha_url {
                "alpha-operator"
            } else {
                "beta-operator"
            },
            "{origin}"
        );
    }

    // Both deployments restart on their own databases and at the same Gateway addresses; a fresh
    // app (as after a relaunch) reconnects to each and finds what it left there.
    let (alpha_address, beta_address) = (alpha.address(), beta.address());
    alpha.stop().await;
    beta.stop().await;
    let alpha = Stack::start(&alpha_database, "alpha-operator", Some(alpha_address)).await;
    let beta = Stack::start(&beta_database, "beta-operator", Some(beta_address)).await;
    let relaunched = GatewayState::default();
    for (url, tag) in [(&beta_url, "beta-tag"), (&alpha_url, "alpha-tag")] {
        let activation = relaunched
            .select_gateway(&store, url.clone())
            .await
            .unwrap();
        let id = activation.connection_id();
        assert_eq!(relaunched.tags(id).await.unwrap()[0].tag_id, tag);
        let conversations =
            serde_json::to_value(relaunched.conversations(id).await.unwrap()).unwrap();
        assert_eq!(conversations.as_array().unwrap().len(), 1, "{url}");
        assert_eq!(conversations[0]["tagId"], tag);
        assert_eq!(
            relaunched
                .cached(id, cache.clone(), "roster".into())
                .await
                .unwrap(),
            Some(serde_json::json!([tag]))
        );
    }
    alpha.stop().await;
    beta.stop().await;
}
