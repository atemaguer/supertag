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
            prompt: "Operator message".into(),
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
        work_session_report_id: None,
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
        conversation: "planning".into(),
        live_input: Some(v2::LiveInput {
            text: "Unexpected internal input".into(),
            ..Default::default()
        }),
        work_session_report_id: Some("work/dependency".into()),
    })
    .unwrap();
    let json = serde_json::to_value(message).unwrap();
    assert_eq!(json["workSessionReportId"], "work/dependency");
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

    let summary = Conversation::from(v2::Conversation {
        latest_task: Some(v2::Task {
            prompt: String::new(),
            ..report
        }),
        ..Default::default()
    });
    let json = serde_json::to_value(summary).unwrap();
    assert_eq!(json["latestTask"]["taskId"], "report-task");
    assert!(json["latestTask"].get("prompt").is_none());
}

async fn gateway_fixture(
    database: &std::path::Path,
    tag_id: &str,
    token: &str,
) -> (
    String,
    tokio::task::JoinHandle<std::result::Result<(), tonic::transport::Error>>,
    tokio::task::JoinHandle<std::result::Result<(), tonic::transport::Error>>,
) {
    let cp = ControlPlane::open(
        &format!("sqlite://{}?mode=rwc", database.display()),
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
        token.into(),
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
                    tag_id: tag_id.into(),
                    instructions: "Help with engineering".into(),
                    allowed_actions: vec!["files:read".into()],
                    harness_kind: v2::HarnessKind::Codex as i32,
                    ..Default::default()
                },
                token,
                None,
            )
            .unwrap(),
        )
        .await
        .unwrap();

    (address, gateway_task, cp_task)
}

#[tokio::test]
async fn native_client_uses_authenticated_gateway_and_durable_message_operations() {
    let directory = tempfile::tempdir().unwrap();
    let (address, gateway_task, cp_task) = gateway_fixture(
        &directory.path().join("state.sqlite"),
        "engineer",
        "operator-test-token",
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
        "The Gateway rejected the operator token."
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
    let first = client
        .send(
            id,
            "engineer".into(),
            "planning".into(),
            "Explain the change".into(),
            "desktop-operation".into(),
        )
        .await
        .unwrap();
    let replay = client
        .send(
            id,
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
                id,
                "engineer".into(),
                "planning".into(),
                "Different content".into(),
                "desktop-operation".into()
            )
            .await
            .is_err()
    );
    let conversations = client.conversations(id, "engineer".into()).await.unwrap();
    assert_eq!(conversations.len(), 1);
    assert_eq!(conversations[0].name, "planning");
    let latest_task = conversations[0].latest_task.as_ref().unwrap();
    assert_eq!(latest_task.task_id, first.task.task_id);
    assert_eq!(latest_task.prompt.as_deref(), Some("Explain the change"));
    let page = client
        .messages(id, "engineer".into(), "planning".into(), None)
        .await
        .unwrap();
    assert_eq!(page.messages.len(), 1);
    assert!(page.next_cursor.is_empty());
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
            .events(id, "engineer".into(), first.task.task_id, 0)
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
async fn saved_gateways_switch_rosters_and_scope_late_ipc_requests() {
    let directory = tempfile::tempdir().unwrap();
    let store = directory.path().join("gateways.json");
    let (first, first_gateway, first_plane) = gateway_fixture(
        &directory.path().join("first.sqlite"),
        "first-tag",
        "first-operator",
    )
    .await;
    let (second, second_gateway, second_plane) = gateway_fixture(
        &directory.path().join("second.sqlite"),
        "second-tag",
        "second-operator",
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
                "default".into(),
                "Old workspace".into(),
                "stale".into()
            )
            .await
            .unwrap_err(),
        "The connection changed. Refresh this view."
    );
    assert!(
        state
            .conversations(b.connection_id(), "second-tag".into())
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

#[tokio::test]
async fn artifact_save_checks_authority_and_bytes_and_keeps_existing_files() {
    use sha2::{Digest, Sha256};
    use v2::{
        ArtifactDownload, ArtifactFile, ArtifactUpload, BlobReference, CapturedArtifact,
        DownloadArtifactFileRequest,
        artifact_download::Part,
        artifact_transfers_server::{ArtifactTransfers, ArtifactTransfersServer},
    };

    const BODY: &[u8] = b"artifact fixture";
    const PATH: &str = "outputs/report.txt";

    struct Transfers;
    #[tonic::async_trait]
    impl ArtifactTransfers for Transfers {
        async fn upload_capture(
            &self,
            _: Request<tonic::Streaming<ArtifactUpload>>,
        ) -> std::result::Result<tonic::Response<CapturedArtifact>, Status> {
            Err(Status::unimplemented("unused"))
        }

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
        channel: endpoint(&address).unwrap().connect().await.unwrap(),
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
