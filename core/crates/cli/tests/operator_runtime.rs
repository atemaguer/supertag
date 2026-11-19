#[path = "support/children.rs"]
mod children;
use children::reaped;
#[path = "support/held_artifacts.rs"]
mod held_artifacts;
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[path = "support/protocol.rs"]
mod protocol;
#[macro_use]
#[path = "support/database.rs"]
mod database;

use std::{net::SocketAddr, process::Stdio, time::Duration};
use supertag_protocol::negotiation::ProtocolChannel;

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use supertag_protocol::{HOST_GENERATION_HEADER, authenticated_request, v2::*};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::timeout,
};
use tonic::{Code, transport::Channel};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(20);

fn command(args: &[&str]) -> Command {
    let mut command = reaped(Command::new(BINARY));
    command
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
}

async fn service(mut command: Command) -> Result<(Child, String)> {
    let mut child = command.stdout(Stdio::piped()).spawn()?;
    let mut stdout = BufReader::new(child.stdout.take().context("service stdout missing")?);
    let mut line = String::new();
    timeout(WAIT, stdout.read_line(&mut line)).await??;
    // Individual services print their bind address. The local supervisor
    // publishes and prints the complete URL used by operator commands.
    let ready = line.trim();
    let address: SocketAddr = ready
        .strip_prefix("http://")
        .unwrap_or(ready)
        .parse()
        .context("service did not report a loopback endpoint")?;
    ensure!(address.ip().is_loopback() && address.port() != 0);
    Ok((child, format!("http://{address}")))
}

/// A Control Plane whose admin operator token `token` acts as `identity`.
fn control_plane(secret: &str, token: &str, identity: &str) -> Command {
    let mut command = command(&["control-plane"]);
    command
        .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", secret)
        .env("SUPERTAG_GATEWAY_CREDENTIAL", secret)
        .env("SUPERTAG_OPERATOR_TOKEN", token)
        .env("SUPERTAG_OPERATOR_PRINCIPAL", identity);
    command
}

/// Issues the Operator Token `name` with the admin `token`, for a second operator.
async fn operator_token(endpoint: &str, token: &str, name: &str) -> Result<String> {
    let mut create = command(&["operator-token", "create", name, "--gateway", endpoint]);
    create.env("SUPERTAG_OPERATOR_TOKEN", token);
    let output = timeout(WAIT, create.output()).await??;
    ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let created: Value = serde_json::from_slice(&output.stdout)?;
    Ok(created["secret"].as_str().context("secret")?.to_owned())
}

async fn channel(address: &str) -> Result<ProtocolChannel> {
    protocol::negotiated(
        Channel::from_shared(address.to_owned())?
            .timeout(WAIT)
            .connect()
            .await?,
    )
    .await
}

database_tests! {
    #[tokio::test]
    retirement_removes_tag_from_roster_and_preserves_identity;
    #[tokio::test]
    conversation_scope_survives_api_forwards_and_task_reads;
    #[tokio::test]
    watch_replays_private_conversations_after_services_restart;
    #[tokio::test]
    captured_artifact_survives_control_plane_restart_with_private_metadata;
    #[tokio::test]
    a_followed_conversation_streams_redacted_reply_text_before_the_answer;
}

async fn retirement_removes_tag_from_roster_and_preserves_identity(database: String) -> Result<()> {
    let secret = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
    let token = Uuid::new_v4().to_string();
    let mut control = control_plane(&secret, &token, "operator:alice");
    control.env("SUPERTAG_DATABASE_URL", &database);
    let (mut control, public) = service(control).await?;
    let run = |args: &[&str]| {
        let mut command = command(args);
        command
            .args(["--gateway", &public])
            .env("SUPERTAG_OPERATOR_TOKEN", &token);
        async move {
            let output = timeout(WAIT, command.output()).await??;
            ensure!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            Ok::<Value, anyhow::Error>(serde_json::from_slice(&output.stdout)?)
        }
    };
    let created = run(&[
        "tag",
        "put",
        "review-1",
        "--name",
        "Reviewer",
        "--instructions",
        "Review",
    ])
    .await?;
    assert_eq!(created["name"], "Reviewer");
    let preview = run(&["tag", "retire", "review-1", "--dry-run"]).await?;
    assert_eq!(preview["dry_run"], true);
    assert!(preview["tag"]["retired_at_ms"].is_null());
    assert_eq!(
        run(&["get", "tags"]).await?["tags"][0]["tag_id"],
        "review-1"
    );
    let retired = run(&["tag", "retire", "review-1"]).await?;
    assert!(retired["tag"]["retired_at_ms"].as_i64().is_some());
    assert_eq!(run(&["get", "tags"]).await?["tags"], serde_json::json!([]));
    // Only `get tag` reads how the Tag's messages landed.
    let mut read = run(&["get", "tag", "review-1"]).await?;
    read["attention"] = serde_json::Value::Null;
    assert_eq!(read, retired["tag"]);
    run(&[
        "tag",
        "put",
        "review-2",
        "--name",
        "Reviewer",
        "--instructions",
        "Review",
    ])
    .await?;
    let all = run(&["get", "tags", "--include-retired"]).await?;
    assert_eq!(all["tags"][0], retired["tag"]);
    assert_eq!(all["tags"][1]["tag_id"], "review-2");
    assert_eq!(all["tags"][1]["name"], "Reviewer");
    control.kill().await?;
    Ok(())
}

/// A captured artifact's files are recorded on the Control Plane and stay private to their
/// operator across a restart; the bytes stay on the Worker Host.
async fn captured_artifact_survives_control_plane_restart_with_private_metadata(
    database: String,
) -> Result<()> {
    let secret = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
    let token = Uuid::new_v4().to_string();
    let host_token = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
    let create_control = || {
        let mut control = control_plane(&secret, &token, "operator:alice");
        control
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
            .env("SUPERTAG_DATABASE_URL", &database);
        control
    };
    let (mut control, endpoint) = service(create_control()).await?;
    let alice = channel(&endpoint).await?;
    operator_client::OperatorClient::new(alice.clone())
        .put_tag(authenticated_request(
            PutTagRequest {
                tag_id: "producer".into(),
                instructions: "Save evidence".into(),
                allowed_actions: vec!["files:read".into()],
                ..Default::default()
            },
            &token,
            None,
        )?)
        .await?;
    let task = conversations_client::ConversationsClient::new(alice.clone())
        .send_message(authenticated_request(
            SendMessageRequest {
                tag_id: "producer".into(),
                operation_id: "request-evidence".into(),
                text: "Capture two files".into(),
                ..Default::default()
            },
            &token,
            None,
        )?)
        .await?
        .into_inner()
        .task
        .context("Task missing")?;
    let mut host = worker_host_client::WorkerHostClient::new(alice.clone());
    let generation = host
        .register_host(authenticated_request(
            RegisterHostRequest {
                incarnation_id: "fixture".into(),
            },
            &host_token,
            None,
        )?)
        .await?
        .into_inner()
        .generation;
    let assignment = host
        .claim_task(artifact_host_request(
            ClaimTaskRequest {
                operation_id: "claim".into(),
                ..Default::default()
            },
            &host_token,
            generation,
        )?)
        .await?
        .into_inner()
        .assignment
        .context("Attempt missing")?;
    let attempt = InspectAttemptRequest {
        task_id: task.task_id.clone(),
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    };
    let credential = host
        .start_task(artifact_host_request(
            StartTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
            },
            &host_token,
            generation,
        )?)
        .await?
        .into_inner()
        .attempt_credential;

    let bytes = b"artifact bytes kept on the Worker Host, never on the Control Plane";
    let mut held =
        held_artifacts::HeldArtifacts::register(alice.clone(), &host_token, generation).await?;
    let blob = held.hold(&attempt.attempt_id, bytes);
    let empty = held.hold(&attempt.attempt_id, b"");
    let capture = CommitArtifactCaptureRequest {
        operation_id: "capture".into(),
        description: Some(ArtifactDescription {
            title: "Evidence".into(),
            kind: "report".into(),
            summary: None,
        }),
        files: vec![
            ArtifactFile {
                git_output: None,
                path: "report.txt".into(),
                blob: Some(blob.clone()),
            },
            ArtifactFile {
                git_output: None,
                path: "empty".into(),
                blob: Some(empty),
            },
        ],
        ..Default::default()
    };
    let mut catalog = artifact_catalog_client::ArtifactCatalogClient::new(alice.clone());
    // A capture must name the host's registered storage, which holds the bytes.
    let error = authenticated_request(
        CommitArtifactCaptureRequest {
            source_storage_id: Some(Uuid::new_v4().to_string()),
            ..capture.clone()
        },
        &credential,
        None,
    )?;
    let error = attempt_artifacts_client::AttemptArtifactsClient::new(alice)
        .commit_capture(error)
        .await
        .unwrap_err();
    assert_eq!(error.code(), Code::PermissionDenied);
    let list = ListCapturedArtifactsRequest {
        task_id: task.task_id.clone(),
        ..Default::default()
    };
    assert!(
        catalog
            .list(authenticated_request(list, &token, None)?)
            .await?
            .into_inner()
            .artifacts
            .is_empty()
    );
    let captured = held.commit(&credential, capture.clone()).await?;
    assert_eq!(captured.files.len(), 2);
    control_plane_holds_no_artifact_bytes(&database, bytes).await?;

    control.kill().await?;
    let (mut control, endpoint) = service(create_control()).await?;
    let bob_token = operator_token(&endpoint, &token, "bob").await?;
    let artifact_id = captured
        .summary
        .as_ref()
        .context("artifact summary missing")?
        .artifact_id
        .clone();
    let get = GetCapturedArtifactRequest {
        artifact_id: artifact_id.clone(),
    };
    // Another operator cannot see the artifact; its owner sees its files after the restart.
    let mut alice_catalog =
        artifact_catalog_client::ArtifactCatalogClient::new(channel(&endpoint).await?);
    assert_eq!(
        alice_catalog
            .get(authenticated_request(get.clone(), &bob_token, None)?)
            .await
            .unwrap_err()
            .code(),
        Code::NotFound
    );
    let restored = alice_catalog
        .get(authenticated_request(get, &token, None)?)
        .await?
        .into_inner();
    assert_eq!(restored.files, captured.files);
    // The bytes stay with the Worker Host: a reconnected host's repeated commit is the same capture.
    held.reconnect(channel(&endpoint).await?);
    assert_eq!(held.commit(&credential, capture).await?, captured);
    control.kill().await?;
    Ok(())
}

/// The Control Plane database holds the artifact's metadata but never its bytes. SQLite:
/// the database file and its write-ahead log, which holds commits not yet checkpointed into the
/// file. PostgreSQL: every row of every table, as text, where `bytea`
/// columns (the protobuf payloads) appear as hex. Both scans must find the metadata, so a
/// scan that sees nothing cannot pass.
async fn control_plane_holds_no_artifact_bytes(database: &str, bytes: &[u8]) -> Result<()> {
    let contains = |haystack: &[u8], needle: &[u8]| {
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
    };
    let metadata = b"report.txt";
    if let Some(path) = database.strip_prefix("sqlite://") {
        let path = path.split('?').next().unwrap_or(path);
        let mut file = std::fs::read(path)?;
        match std::fs::read(format!("{path}-wal")) {
            Ok(log) => file.extend(log),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        ensure!(
            contains(&file, metadata),
            "the scan saw no artifact metadata"
        );
        ensure!(
            !contains(&file, bytes),
            "the Control Plane stored artifact bytes"
        );
        return Ok(());
    }
    use sqlx::{Connection, PgConnection};
    let mut connection = PgConnection::connect(database).await?;
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT CAST(table_name AS TEXT) FROM information_schema.tables \
         WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'",
    )
    .fetch_all(&mut connection)
    .await?;
    let hex = |bytes: &[u8]| -> String { bytes.iter().map(|byte| format!("{byte:02x}")).collect() };
    let (bytes_hex, metadata_hex) = (hex(bytes), hex(metadata));
    let mut saw_metadata = false;
    for table in tables {
        let rows: Vec<String> =
            sqlx::query_scalar(&format!("SELECT CAST(t AS TEXT) FROM \"{table}\" AS t"))
                .fetch_all(&mut connection)
                .await?;
        for row in rows {
            saw_metadata |= contains(row.as_bytes(), metadata) || row.contains(&metadata_hex);
            ensure!(
                !contains(row.as_bytes(), bytes) && !row.contains(&bytes_hex),
                "the Control Plane stored artifact bytes in {table}"
            );
        }
    }
    connection.close().await?;
    ensure!(saw_metadata, "the scan saw no artifact metadata");
    Ok(())
}

/// `supertag up` with its local Control Plane on `database`: the state directory's SQLite
/// file for a SQLite URL, else the PostgreSQL database.
fn up_command(database: &str, args: &[&str]) -> Command {
    let mut up = command(args);
    if database.starts_with("postgres") {
        up.env("SUPERTAG_DATABASE_URL", database);
    }
    up
}

fn artifact_host_request<T>(input: T, token: &str, generation: u64) -> Result<tonic::Request<T>> {
    let mut request = authenticated_request(input, token, None)?;
    request
        .metadata_mut()
        .insert(HOST_GENERATION_HEADER, generation.into());
    Ok(request)
}

async fn conversation_scope_survives_api_forwards_and_task_reads(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let secret = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
    let alice_token = Uuid::new_v4().to_string();
    let host_token = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
    let mut control = control_plane(&secret, &alice_token, "operator:alice");
    control
        .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
        .env("SUPERTAG_DATABASE_URL", &database);
    let (mut control, alice_url) = service(control).await?;
    let bob_token = operator_token(&alice_url, &alice_token, "bob").await?;
    let bob_url = alice_url.clone();

    let alice = channel(&alice_url).await?;
    let bob = channel(&bob_url).await?;
    let mut alice_operator = operator_client::OperatorClient::new(alice.clone());
    let mut bob_operator = operator_client::OperatorClient::new(bob.clone());
    let mut alice_conversations = conversations_client::ConversationsClient::new(alice);
    let mut bob_conversations = conversations_client::ConversationsClient::new(bob);
    alice_operator
        .put_tag(authenticated_request(
            PutTagRequest {
                tag_id: "engineer".into(),
                instructions: "Process requests".into(),
                ..Default::default()
            },
            &alice_token,
            None,
        )?)
        .await?;
    let tags = bob_operator
        .list_tags(authenticated_request(
            ListTagsRequest::default(),
            &bob_token,
            None,
        )?)
        .await?
        .into_inner();
    assert_eq!(tags.tags[0].tag_id, "engineer");
    let alice_message = SendMessageRequest {
        output_policy: None,
        execution_limits: None,
        tag_id: "engineer".into(),
        text: "Alice's private message".into(),
        operation_id: "operation".into(),
    };
    let bob_message = SendMessageRequest {
        text: "Bob's private message".into(),
        ..alice_message.clone()
    };
    let sent = alice_conversations
        .send_message(authenticated_request(alice_message, &alice_token, None)?)
        .await?
        .into_inner()
        .task
        .context("Alice's Task missing")?;
    let received = bob_conversations
        .send_message(authenticated_request(bob_message, &bob_token, None)?)
        .await?
        .into_inner()
        .task
        .context("Bob's Task missing")?;
    assert_ne!(sent.session_id, received.session_id);

    let mut host = command(&[
        "worklet",
        "--once",
        "--control-plane",
        &alice_url,
        "--adapter",
        ADAPTER,
    ]);
    host.arg("--state-directory")
        .arg(directory.path().join("host"))
        .env("SUPERTAG_HOST_TOKEN", &host_token);
    assert!(timeout(WAIT, host.status()).await??.success());
    let task_id = sent.task_id;
    let events = ListEventsRequest {
        task_id: task_id.clone(),
        ..Default::default()
    };
    let owned = alice_operator
        .list_events(authenticated_request(events.clone(), &alice_token, None)?)
        .await?
        .into_inner();
    assert!(!owned.events.is_empty());
    // The conversation history carries the turn's events itself, ending at its latest.
    let alice_history = alice_conversations
        .list_messages(authenticated_request(
            ListMessagesRequest {
                tag_id: "engineer".into(),
                ..Default::default()
            },
            &alice_token,
            None,
        )?)
        .await?
        .into_inner();
    assert_eq!(
        alice_history.messages[0]
            .events
            .last()
            .map(|event| event.sequence),
        owned.events.last().map(|event| event.sequence)
    );
    assert_eq!(
        bob_operator
            .list_events(authenticated_request(
                events,
                &bob_token,
                Some("operator:alice")
            )?)
            .await
            .unwrap_err()
            .code(),
        Code::NotFound
    );
    assert_eq!(
        bob_operator
            .get_task(authenticated_request(
                GetTaskRequest {
                    task_id: task_id.clone()
                },
                &bob_token,
                Some("operator:alice")
            )?)
            .await
            .unwrap_err()
            .code(),
        Code::NotFound
    );
    assert_eq!(
        bob_operator
            .cancel_task(authenticated_request(
                CancelTaskRequest {
                    task_id: task_id.clone()
                },
                &bob_token,
                None
            )?)
            .await
            .unwrap_err()
            .code(),
        Code::NotFound
    );
    assert_eq!(
        bob_operator
            .list_events(authenticated_request(
                ListEventsRequest {
                    task_id,
                    ..Default::default()
                },
                &bob_token,
                None
            )?)
            .await
            .unwrap_err()
            .code(),
        Code::NotFound
    );
    let history = bob_conversations
        .list_messages(authenticated_request(
            ListMessagesRequest {
                tag_id: "engineer".into(),
                ..Default::default()
            },
            &bob_token,
            None,
        )?)
        .await?
        .into_inner();
    assert_eq!(history.messages.len(), 1);
    assert_eq!(
        history.messages[0].task.as_ref().unwrap().task_id,
        received.task_id
    );
    control.kill().await?;
    Ok(())
}

/// The fixture adapter writes its answer a few words at a time, quoting its own credential split
/// across two pieces. A client following the conversation sees the text as it is written, each
/// snapshot redacted and never a part of the credential, then the recorded answer.
async fn a_followed_conversation_streams_redacted_reply_text_before_the_answer(
    database: String,
) -> Result<()> {
    let directory = tempfile::Builder::new()
        .prefix("stream-")
        .tempdir_in("/tmp")?;
    let state = directory.path().join("state");
    let mut up = up_command(
        &database,
        &[
            "up",
            "--foreground",
            "--adapter",
            ADAPTER,
            "--adapter-arg=--conversation-fixture=800",
        ],
    );
    up.arg("--state-directory").arg(&state);
    let (mut runtime, endpoint) = service(up).await?;
    let mut put = command(&["tag", "put", "engineer", "--instructions", "Answer"]);
    put.arg("--state-directory").arg(&state);
    ensure!(timeout(WAIT, put.output()).await??.status.success());
    let credentials: Value =
        serde_json::from_slice(&std::fs::read(state.join("credentials.json"))?)?;
    let token = credentials["operator_token"]
        .as_str()
        .context("test operator credential missing")?;
    let mut conversations =
        conversations_client::ConversationsClient::new(channel(&endpoint).await?);
    let mut follow = conversations
        .follow_conversation(authenticated_request(
            FollowConversationRequest {
                tag_id: "engineer".into(),
                ..Default::default()
            },
            token,
            None,
        )?)
        .await?
        .into_inner();
    let sent = conversations
        .send_message(authenticated_request(
            SendMessageRequest {
                tag_id: "engineer".into(),
                operation_id: "stream".into(),
                text: "Stream it".into(),
                ..Default::default()
            },
            token,
            None,
        )?)
        .await?
        .into_inner()
        .task
        .context("sent message has no Task")?;
    let full = "Streaming the answer with [REDACTED] in it, done. ";
    let mut texts = Vec::new();
    let result = loop {
        let response = timeout(WAIT, follow.message())
            .await??
            .context("the follow ended")?;
        for text in response.texts {
            ensure!(text.task_id == sent.task_id);
            texts.push(text.text);
        }
        let finished = response
            .messages
            .into_iter()
            .flat_map(|page| page.messages)
            .find_map(|message| {
                message
                    .task
                    .filter(|task| task.task_id == sent.task_id && task.result.is_some())
            });
        if let Some(task) = finished {
            break task.result.unwrap_or_default();
        }
    };
    ensure!(result.contains("Stream it"), "{result}");
    let shown: Vec<&String> = texts.iter().filter(|text| !text.is_empty()).collect();
    ensure!(!shown.is_empty(), "no text was streamed before the answer");
    for text in &shown {
        ensure!(
            full.starts_with(text.as_str()),
            "a streamed text is not part of the redacted answer: {text:?}"
        );
    }
    ensure!(
        shown.last().map(|text| text.as_str()) == Some(full),
        "{shown:?}"
    );
    if let Some(pid) = runtime.id() {
        // SAFETY: this PID belongs to the supervised disposable runtime.
        unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    }
    assert!(timeout(WAIT, runtime.wait()).await??.success());
    Ok(())
}

async fn watch_replays_private_conversations_after_services_restart(
    database: String,
) -> Result<()> {
    use operator_events_client::OperatorEventsClient;
    use watch_event::Update;

    async fn open(
        address: &str,
        token: &str,
        resume_token: String,
    ) -> Result<tonic::Streaming<WatchEvent>, tonic::Status> {
        let endpoint = channel(address)
            .await
            .map_err(|error| tonic::Status::unavailable(error.to_string()))?;
        let mut client = OperatorEventsClient::new(endpoint);
        Ok(client
            .watch(authenticated_request(
                WatchRequest {
                    resume_token,
                    ..Default::default()
                },
                token,
                Some("operator:alice"),
            )?)
            .await?
            .into_inner())
    }

    async fn until_tag(stream: &mut tonic::Streaming<WatchEvent>) -> Result<Vec<WatchChange>> {
        timeout(WAIT, async {
            let mut changes = Vec::new();
            while let Some(event) = stream.message().await? {
                if let Some(Update::Change(change)) = event.update {
                    let done = change.kind() == WatchKind::Tag && change.id == "finished";
                    changes.push(change);
                    if done {
                        return Ok(changes);
                    }
                }
            }
            anyhow::bail!("watch ended before the final Tag change")
        })
        .await?
    }

    async fn stop(process: &mut Child) -> Result<()> {
        if let Some(pid) = process.id() {
            // SAFETY: this is a live child PID held by the test.
            unsafe { libc::kill(pid as i32, libc::SIGTERM) };
        }
        assert!(
            timeout(Duration::from_secs(5), process.wait())
                .await??
                .success()
        );
        Ok(())
    }

    let secret = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
    let alice_token = Uuid::new_v4().to_string();
    let control_command = || {
        let mut control = control_plane(&secret, &alice_token, "operator:alice");
        control.env("SUPERTAG_DATABASE_URL", &database);
        control
    };
    let (mut plane, alice_url) = service(control_command()).await?;
    let bob_token = operator_token(&alice_url, &alice_token, "bob").await?;
    let bob_url = alice_url.clone();
    assert_eq!(
        open(&bob_url, &bob_token, "broken-cursor".into())
            .await
            .unwrap_err()
            .code(),
        Code::InvalidArgument
    );

    let mut alice_watch = open(&alice_url, &alice_token, String::new()).await?;
    let mut bob_watch = open(&bob_url, &bob_token, String::new()).await?;
    let alice_start = timeout(WAIT, alice_watch.message())
        .await??
        .context("Alice watch handshake")?;
    let bob_start = timeout(WAIT, bob_watch.message())
        .await??
        .context("Bob watch handshake")?;
    assert!(matches!(alice_start.update, Some(Update::Heartbeat(_))));
    assert!(matches!(bob_start.update, Some(Update::Heartbeat(_))));

    // Leave the streams idle beyond the API tier's unary forwarding deadline.
    tokio::time::sleep(Duration::from_secs(11)).await;

    let alice = channel(&alice_url).await?;
    let mut tags = operator_client::OperatorClient::new(alice.clone());
    let put = |name: &str| PutTagRequest {
        tag_id: name.to_owned(),
        instructions: "Test Watch".into(),
        ..Default::default()
    };
    tags.put_tag(authenticated_request(put("engineer"), &alice_token, None)?)
        .await?;
    let send = |text: &str| SendMessageRequest {
        output_policy: None,
        execution_limits: None,
        tag_id: "engineer".into(),
        operation_id: "send-once".into(),
        text: text.to_owned(),
    };
    let mut a = conversations_client::ConversationsClient::new(alice);
    let mut b = conversations_client::ConversationsClient::new(channel(&bob_url).await?);
    let private_a = a
        .send_message(authenticated_request(send("Alice"), &alice_token, None)?)
        .await?
        .into_inner()
        .task
        .context("Alice Task")?;
    let private_b = b
        .send_message(authenticated_request(send("Bob"), &bob_token, None)?)
        .await?
        .into_inner()
        .task
        .context("Bob Task")?;
    a.send_message(authenticated_request(send("Alice"), &alice_token, None)?)
        .await?;
    tags.put_tag(authenticated_request(put("finished"), &alice_token, None)?)
        .await?;

    let check = |changes: Vec<WatchChange>, own: &Task, other: &Task| {
        assert!(
            changes
                .iter()
                .all(|change| change.id != other.task_id && change.session_id != other.session_id)
        );
        assert_eq!(
            changes
                .iter()
                .filter(|change| change.id == own.task_id
                    && change.kind() == WatchKind::ConversationMessage)
                .count(),
            1
        );
        assert!(changes.iter().any(|change| change.kind() == WatchKind::Task
            && change.id == own.task_id
            && change.session_id == own.session_id));
    };
    check(until_tag(&mut alice_watch).await?, &private_a, &private_b);
    check(until_tag(&mut bob_watch).await?, &private_b, &private_a);

    // Open streams must release the Control Plane during graceful shutdown.
    stop(&mut plane).await?;
    assert_eq!(
        timeout(WAIT, alice_watch.message())
            .await?
            .unwrap_err()
            .code(),
        Code::Unavailable
    );

    let (mut plane, address) = service(control_command()).await?;
    let mut resumed = open(&address, &bob_token, bob_start.resume_token).await?;
    check(until_tag(&mut resumed).await?, &private_b, &private_a);
    stop(&mut plane).await?;
    Ok(())
}
