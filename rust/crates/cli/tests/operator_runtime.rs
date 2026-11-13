use std::{
    net::SocketAddr, os::unix::fs::PermissionsExt, path::Path, process::Stdio, time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use sha2::{Digest, Sha256};
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
    let mut command = Command::new(BINARY);
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

fn gateway(private: &str, secret: &str, token: &str, identity: &str) -> Command {
    let mut command = command(&["gateway", "--control-plane", private]);
    command
        .env("SUPERTAG_GATEWAY_TOKEN", secret)
        .env("SUPERTAG_OPERATOR_TOKEN", token)
        .env("SUPERTAG_OPERATOR_PRINCIPAL", identity);
    command
}

async fn channel(address: &str) -> Result<Channel> {
    Ok(Channel::from_shared(address.to_owned())?
        .timeout(WAIT)
        .connect()
        .await?)
}

#[tokio::test]
async fn retirement_removes_tag_from_roster_and_preserves_identity() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let secret = Uuid::new_v4().to_string();
    let token = Uuid::new_v4().to_string();
    let mut control = command(&["control-plane"]);
    control.env("SUPERTAG_GATEWAY_TOKEN", &secret).env(
        "SUPERTAG_DATABASE_URL",
        format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("tags.db").display()
        ),
    );
    let (mut control, private) = service(control).await?;
    let (mut gateway, public) =
        service(gateway(&private, &secret, &token, "operator:alice")).await?;
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
        "put-tag",
        "review-1",
        "--name",
        "Reviewer",
        "--instructions",
        "Review",
    ])
    .await?;
    assert_eq!(created["name"], "Reviewer");
    let preview = run(&["retire-tag", "review-1", "--dry-run"]).await?;
    assert_eq!(preview["dry_run"], true);
    assert!(preview["tag"]["retired_at_ms"].is_null());
    assert_eq!(run(&["list-tags"]).await?["tags"][0]["tag_id"], "review-1");
    let retired = run(&["retire-tag", "review-1"]).await?;
    assert!(retired["tag"]["retired_at_ms"].as_i64().is_some());
    assert_eq!(run(&["list-tags"]).await?["tags"], serde_json::json!([]));
    assert_eq!(run(&["get-tag", "review-1"]).await?, retired["tag"]);
    run(&[
        "put-tag",
        "review-2",
        "--name",
        "Reviewer",
        "--instructions",
        "Review",
    ])
    .await?;
    let all = run(&["list-tags", "--include-retired"]).await?;
    assert_eq!(all["tags"][0], retired["tag"]);
    assert_eq!(all["tags"][1]["tag_id"], "review-2");
    assert_eq!(all["tags"][1]["name"], "Reviewer");
    gateway.kill().await?;
    control.kill().await?;
    Ok(())
}

#[tokio::test]
async fn captured_artifact_bytes_survive_gateway_restart_with_private_metadata() -> Result<()> {
    captured_artifact_round_trip(None).await
}

#[tokio::test]
#[ignore = "requires tmux and SUPERTAG_RUST_TEST_TUI pointing to a version-matched Go terminal UI"]
async fn go_tui_lists_and_saves_completed_task_files() -> Result<()> {
    let binary = std::env::var_os("SUPERTAG_RUST_TEST_TUI")
        .context("version-matched terminal UI binary required")?;
    captured_artifact_round_trip(Some(Path::new(&binary))).await
}

async fn captured_artifact_round_trip(tui: Option<&Path>) -> Result<()> {
    let directory = tempfile::Builder::new()
        .prefix("files-tui-")
        .tempdir_in("/tmp")?;
    let database = directory.path().join("control.db");
    let blobs = directory.path().join("blobs");
    let secret = Uuid::new_v4().to_string();
    let token = Uuid::new_v4().to_string();
    let bob_token = Uuid::new_v4().to_string();
    let host_token = Uuid::new_v4().to_string();
    let mut control = command(&["control-plane"]);
    control
        .env("SUPERTAG_GATEWAY_TOKEN", &secret)
        .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
        .env(
            "SUPERTAG_DATABASE_URL",
            format!("sqlite://{}?mode=rwc", database.display()),
        );
    let (mut control, private) = service(control).await?;
    let create_gateway = |token: &str, principal: &str| {
        let mut gateway = gateway(&private, &secret, token, principal);
        gateway.arg("--checkpoint-directory").arg(&blobs);
        gateway
    };
    let (mut public, endpoint) = service(create_gateway(&token, "operator:alice")).await?;
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
                conversation: if tui.is_some() { "default" } else { "private" }.into(),
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
    host.start_task(artifact_host_request(
        StartTaskRequest {
            task_id: attempt.task_id.clone(),
            attempt_id: attempt.attempt_id.clone(),
            lease_token: attempt.lease_token.clone(),
        },
        &host_token,
        generation,
    )?)
    .await?;

    let bytes = b"artifact bytes kept by the Gateway, never the Control Plane";
    let digest = format!("{:x}", Sha256::digest(bytes));
    let capture = CommitArtifactCaptureRequest {
        attempt: Some(attempt.clone()),
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
                blob: Some(BlobReference {
                    sha256: digest.clone(),
                    byte_length: bytes.len() as u64,
                }),
            },
            ArtifactFile {
                git_output: None,
                path: "empty".into(),
                blob: Some(BlobReference {
                    sha256: format!("{:x}", Sha256::digest([])),
                    byte_length: 0,
                }),
            },
        ],
        ..Default::default()
    };
    let stream = |data: Vec<u8>| {
        tokio_stream::iter([
            ArtifactUpload {
                part: Some(artifact_upload::Part::Begin(capture.clone())),
            },
            ArtifactUpload {
                part: Some(artifact_upload::Part::Chunk(ArtifactChunk {
                    file_index: 0,
                    data,
                })),
            },
        ])
    };
    let mut transfers = artifact_transfers_client::ArtifactTransfersClient::new(alice.clone());
    let mut catalog = artifact_catalog_client::ArtifactCatalogClient::new(alice);
    let error = transfers
        .upload_capture(artifact_host_request(
            stream(vec![b'x'; bytes.len()]),
            &host_token,
            generation,
        )?)
        .await
        .unwrap_err();
    assert_eq!(error.code(), Code::InvalidArgument);
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
    let captured = transfers
        .upload_capture(artifact_host_request(
            stream(bytes.to_vec()),
            &host_token,
            generation,
        )?)
        .await?
        .into_inner();
    assert_eq!(captured.files.len(), 2);
    assert_eq!(std::fs::read(blobs.join(digest))?, bytes);
    assert!(
        !std::fs::read(&database)?
            .windows(bytes.len())
            .any(|window| window == bytes)
    );

    public.kill().await?;
    let (mut public, endpoint) = service(create_gateway(&token, "operator:alice")).await?;
    let (mut bob, bob_endpoint) = service(create_gateway(&bob_token, "operator:bob")).await?;
    let mut alice_transfers =
        artifact_transfers_client::ArtifactTransfersClient::new(channel(&endpoint).await?);
    let mut bob_transfers =
        artifact_transfers_client::ArtifactTransfersClient::new(channel(&bob_endpoint).await?);
    let download = DownloadArtifactFileRequest {
        artifact_id: captured
            .summary
            .as_ref()
            .context("artifact summary missing")?
            .artifact_id
            .clone(),
        path: "report.txt".into(),
    };
    assert_eq!(
        bob_transfers
            .download_file(authenticated_request(download.clone(), &bob_token, None)?)
            .await
            .unwrap_err()
            .code(),
        Code::NotFound
    );
    let mut returned = alice_transfers
        .download_file(authenticated_request(download, &token, None)?)
        .await?
        .into_inner();
    assert!(
        matches!(returned.message().await?.and_then(|message| message.part),
        Some(artifact_download::Part::File(file)) if file.path == "report.txt")
    );
    let mut result = Vec::new();
    while let Some(message) = returned.message().await? {
        let Some(artifact_download::Part::Chunk(chunk)) = message.part else {
            anyhow::bail!("expected artifact data");
        };
        result.extend(chunk);
    }
    assert_eq!(result, bytes);
    assert_eq!(
        alice_transfers
            .upload_capture(artifact_host_request(
                stream(bytes.to_vec()),
                &host_token,
                generation
            )?)
            .await?
            .into_inner(),
        captured
    );
    if let Some(binary) = tui {
        let mut host = worker_host_client::WorkerHostClient::new(channel(&endpoint).await?);
        host.finish_task(artifact_host_request(
            FinishTaskRequest {
                task_id: task.task_id,
                attempt_id: attempt.attempt_id,
                lease_token: attempt.lease_token,
                result: "Evidence is ready.".into(),
                succeeded: true,
                artifacts: vec![ArtifactSelection {
                    artifact_id: captured
                        .summary
                        .context("capture summary missing")?
                        .artifact_id,
                    paths: vec!["report.txt".into()],
                }],
                ..Default::default()
            },
            &host_token,
            generation,
        )?)
        .await?;
        tui_save_task_file(directory.path(), binary, &endpoint, &token, bytes).await?;
    }
    bob.kill().await?;
    public.kill().await?;
    control.kill().await?;
    Ok(())
}

async fn tui_save_task_file(
    directory: &Path,
    binary: &Path,
    endpoint: &str,
    token: &str,
    bytes: &[u8],
) -> Result<()> {
    // The synthetic operator token is a provider environment value, never a CLI argument.
    let script = directory.join("launch-tui");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nexport SUPERTAG_OPERATOR_TOKEN='{}'\nexec env HOME={} {} tui --gateway '{}' --binary {}\n",
            token,
            shell_path(directory)?,
            shell_path(Path::new(BINARY))?,
            endpoint,
            shell_path(binary)?
        ),
    )?;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))?;
    let tmux = Tmux {
        socket: directory.join("tmux.sock"),
    };
    tmux.run(&[
        "new-session",
        "-d",
        "-s",
        "runtime",
        "-x",
        "160",
        "-y",
        "45",
        &format!(
            "env -i PATH=/usr/bin:/bin TERM=xterm-256color {}",
            shell_path(&script)?
        ),
    ])
    .await?;
    tmux.wait_for("Evidence is ready.").await?;
    tmux.wait_for("Save from Ctrl+k").await?;
    tmux.run(&["send-keys", "-t", "runtime", "C-k"]).await?;
    tmux.wait_for("Commands").await?;
    tmux.run(&["send-keys", "-t", "runtime", "-l", "Task files"])
        .await?;
    tmux.run(&["send-keys", "-t", "runtime", "Enter"]).await?;
    // The reply already mentions report.txt. Wait for the loaded file row
    // before sending a key that the loading dialog intentionally ignores.
    tmux.wait_for("bytes  ·  Evidence").await?;
    tmux.wait_for("enter chooses").await?;
    tmux.run(&["send-keys", "-t", "runtime", "Enter"]).await?;
    tmux.wait_for("Save to a local path").await?;
    let output = directory.join("saved-report.txt");
    tmux.run(&["send-keys", "-t", "runtime", "C-u"]).await?;
    tmux.run(&[
        "send-keys",
        "-t",
        "runtime",
        "-l",
        output.to_str().context("output path UTF-8")?,
    ])
    .await?;
    tmux.run(&["send-keys", "-t", "runtime", "Enter"]).await?;
    tmux.wait_for("Saved ").await?;
    assert_eq!(std::fs::read(&output)?, bytes);
    assert_eq!(
        std::fs::metadata(&output)?.permissions().mode() & 0o777,
        0o600
    );
    tmux.run(&["send-keys", "-t", "runtime", "Escape"]).await?;
    tmux.wait_for("Evidence is ready.").await?;
    tmux.run(&["send-keys", "-t", "runtime", "C-c"]).await?;
    Ok(())
}

fn artifact_host_request<T>(input: T, token: &str, generation: u64) -> Result<tonic::Request<T>> {
    let mut request = authenticated_request(input, token, None)?;
    request
        .metadata_mut()
        .insert(HOST_GENERATION_HEADER, generation.into());
    Ok(request)
}

#[tokio::test]
async fn conversation_scope_survives_gateway_forwards_and_task_reads() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let secret = Uuid::new_v4().to_string();
    let alice_token = Uuid::new_v4().to_string();
    let bob_token = Uuid::new_v4().to_string();
    let host_token = Uuid::new_v4().to_string();
    let mut control = command(&["control-plane"]);
    control
        .env("SUPERTAG_GATEWAY_TOKEN", &secret)
        .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
        .env(
            "SUPERTAG_DATABASE_URL",
            format!(
                "sqlite://{}?mode=rwc",
                directory.path().join("control.db").display()
            ),
        );
    let (mut control, private) = service(control).await?;
    let (mut alice_gateway, alice_url) =
        service(gateway(&private, &secret, &alice_token, "operator:alice")).await?;
    let (mut bob_gateway, bob_url) =
        service(gateway(&private, &secret, &bob_token, "operator:bob")).await?;

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
        conversation: "personal".into(),
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
        "worker-host",
        "--once",
        "--gateway",
        &alice_url,
        "--adapter",
        ADAPTER,
    ]);
    host.arg("--state-directory")
        .arg(directory.path().join("host"))
        .env("SUPERTAG_HOST_TOKEN", &host_token);
    assert!(timeout(WAIT, host.status()).await??.success());
    let task_id = sent.task_id;
    let events = ListMessageEventsRequest {
        tag_id: "engineer".into(),
        task_id: task_id.clone(),
        ..Default::default()
    };
    let owned = alice_conversations
        .list_message_events(authenticated_request(events.clone(), &alice_token, None)?)
        .await?
        .into_inner();
    assert!(!owned.events.is_empty());
    assert_eq!(
        bob_conversations
            .list_message_events(authenticated_request(
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
                conversation: "personal".into(),
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
    alice_gateway.kill().await?;
    bob_gateway.kill().await?;
    control.kill().await?;
    Ok(())
}

fn fixture(path: &Path, version: &str) -> Result<()> {
    std::fs::write(
        path,
        format!(
            r#"#!/bin/sh
set -eu
test -z "${{SUPERTAG_OPERATOR_TOKEN:-}}${{SUPERTAG_GATEWAY_TOKEN:-}}${{OPENAI_API_KEY:-}}"
if [ "${{1:-}}" = "--version" ]; then
  printf '%s\n' "{version}"
  exit 0
fi
test "$#" = 0
cat <&3
"#
        ),
    )?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[tokio::test]
async fn tui_handover_uses_descriptor_three_and_version_match() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let launcher = directory.path().join("supertag-tui-fixture");
    let token = "fixture-operator-credential";
    let mut command = command(&[
        "tui",
        "--gateway",
        "http://127.0.0.1:1",
        "--workspace",
        "example",
    ]);
    command
        .arg("--binary")
        .arg(&launcher)
        .env("SUPERTAG_OPERATOR_TOKEN", token)
        .env("SUPERTAG_GATEWAY_TOKEN", "never-forward")
        .env("OPENAI_API_KEY", "never-forward");
    fixture(&launcher, env!("CARGO_PKG_VERSION"))?;
    let output = timeout(WAIT, command.output()).await??;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let handover: Value = serde_json::from_slice(&output.stdout)?;
    assert_eq!(handover["protocol"], "runtime.v2");
    assert_eq!(handover["current"], 0);
    assert_eq!(handover["contexts"][0]["token"], token);
    assert_eq!(handover["contexts"][0]["url"], "http://127.0.0.1:1");
    assert_eq!(handover["contexts"][0]["workspace"], "example");

    fixture(&launcher, "unmatched")?;
    let output = timeout(WAIT, command.output()).await??;
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("must match SuperTag"));
    assert!(!error.contains(token));
    Ok(())
}

struct Tmux {
    socket: std::path::PathBuf,
}

impl Tmux {
    async fn run(&self, args: &[&str]) -> Result<String> {
        let output = timeout(
            WAIT,
            Command::new("tmux")
                .args(["-f", "/dev/null", "-S"])
                .arg(&self.socket)
                .args(args)
                .output(),
        )
        .await??;
        ensure!(
            output.status.success(),
            "tmux command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(String::from_utf8(output.stdout)?)
    }

    async fn wait_for(&self, text: &str) -> Result<()> {
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            let pane = self.run(&["capture-pane", "-p", "-t", "runtime"]).await?;
            if pane.contains(text) {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                let history = self
                    .run(&["capture-pane", "-p", "-S", "-", "-t", "runtime"])
                    .await
                    .unwrap_or(pane);
                anyhow::bail!("terminal did not show {text:?}:\n{history}");
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

impl Drop for Tmux {
    fn drop(&mut self) {
        let _ = std::process::Command::new("tmux")
            .arg("-S")
            .arg(&self.socket)
            .arg("kill-server")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

fn shell_path(path: &Path) -> Result<String> {
    let value = path
        .to_str()
        .context("terminal fixture path is not UTF-8")?;
    Ok(format!("'{}'", value.replace('\'', "'\\''")))
}

#[tokio::test]
#[ignore = "requires tmux and SUPERTAG_RUST_TEST_TUI pointing to a version-matched Go terminal UI"]
async fn bare_launcher_saves_and_switches_gateway_rosters() -> Result<()> {
    let binary =
        std::env::var_os("SUPERTAG_RUST_TEST_TUI").context("terminal UI binary required")?;
    let directory = tempfile::Builder::new()
        .prefix("tui-chooser-")
        .tempdir_in("/tmp")?;
    let tmux = Tmux {
        socket: directory.path().join("tmux.sock"),
    };
    let shell = format!(
        "env -i PATH=/usr/bin:/bin TERM=xterm-256color HOME={} SUPERTAG_TUI_BINARY={} {}",
        shell_path(directory.path())?,
        shell_path(Path::new(&binary))?,
        shell_path(Path::new(BINARY))?,
    );

    let mut services = Vec::new();
    let mut addresses = Vec::new();
    for (tag, token) in [
        ("first-tag", "first-fixture-token"),
        ("second-tag", "second-fixture-token"),
    ] {
        let private_token = Uuid::new_v4().to_string();
        let mut control = command(&["control-plane"]);
        control.env("SUPERTAG_GATEWAY_TOKEN", &private_token).env(
            "SUPERTAG_DATABASE_URL",
            format!(
                "sqlite://{}?mode=rwc",
                directory.path().join(format!("{tag}.sqlite")).display()
            ),
        );
        let (plane, private) = service(control).await?;
        let (public, address) =
            service(gateway(&private, &private_token, token, "operator:tui")).await?;
        operator_client::OperatorClient::new(channel(&address).await?)
            .put_tag(authenticated_request(
                PutTagRequest {
                    tag_id: tag.into(),
                    ..Default::default()
                },
                token,
                None,
            )?)
            .await?;
        addresses.push((address, token));
        services.extend([plane, public]);
    }

    tmux.run(&[
        "new-session",
        "-d",
        "-s",
        "runtime",
        "-x",
        "120",
        "-y",
        "35",
        &shell,
        ";",
        "set-option",
        "-t",
        "runtime",
        "remain-on-exit",
        "on",
    ])
    .await?;
    tmux.wait_for("Gateways").await?;
    for (index, (address, token)) in addresses.iter().enumerate() {
        if index > 0 {
            tmux.run(&["send-keys", "-t", "runtime", "C-p"]).await?;
            tmux.wait_for("Gateways").await?;
        }
        tmux.run(&["send-keys", "-t", "runtime", "a"]).await?;
        tmux.wait_for("Save a Gateway").await?;
        let name = if index == 0 { "First" } else { "Second" };
        for (field, value) in [name, address.as_str(), token].into_iter().enumerate() {
            if field > 0 {
                tmux.run(&["send-keys", "-t", "runtime", "Tab"]).await?;
            }
            tmux.run(&["send-keys", "-t", "runtime", "-l", value])
                .await?;
        }
        let form = tmux.run(&["capture-pane", "-p", "-t", "runtime"]).await?;
        ensure!(!form.contains(token), "the Gateway token was visible");
        tmux.run(&["send-keys", "-t", "runtime", "C-s"]).await?;
        let tag = if index == 0 {
            "first-tag"
        } else {
            "second-tag"
        };
        tmux.wait_for(&format!("Say something to {tag}.")).await?;
    }
    let second = tmux.run(&["capture-pane", "-p", "-t", "runtime"]).await?;
    ensure!(
        !second.contains("first-tag"),
        "the previous Gateway roster was visible"
    );

    tmux.run(&["send-keys", "-t", "runtime", "C-p"]).await?;
    tmux.wait_for("Gateways").await?;
    tmux.run(&["send-keys", "-t", "runtime", "Up", "Enter"])
        .await?;
    tmux.wait_for("Say something to first-tag.").await?;
    let first = tmux.run(&["capture-pane", "-p", "-t", "runtime"]).await?;
    ensure!(
        !first.contains("second-tag"),
        "the other Gateway roster was visible"
    );

    tmux.run(&["respawn-pane", "-k", "-t", "runtime", &shell])
        .await?;
    tmux.wait_for("Say something to first-tag.").await?;
    for mut child in services {
        child.kill().await?;
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires tmux and SUPERTAG_RUST_TEST_TUI pointing to a version-matched Go terminal UI"]
async fn rust_launcher_and_go_tui_send_a_real_conversation() -> Result<()> {
    let binary = std::env::var_os("SUPERTAG_RUST_TEST_TUI")
        .context("version-matched terminal UI binary required")?;
    let directory = tempfile::Builder::new()
        .prefix("tui-v2-")
        .tempdir_in("/tmp")?;
    let state = directory.path().join("state");
    let mut up = command(&["up", "--adapter", ADAPTER]);
    up.arg("--state-directory").arg(&state);
    let (mut runtime, endpoint) = service(up).await?;
    assert_eq!(
        std::fs::read_to_string(state.join("endpoint"))?.trim(),
        endpoint
    );
    let mut put = command(&["put-tag", "engineer", "--instructions", "Process requests"]);
    put.arg("--state-directory").arg(&state);
    let output = timeout(WAIT, put.output()).await??;
    ensure!(
        output.status.success(),
        "configure terminal UI fixture Tag: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut team = command(&["team", "--state-directory"]);
    team.arg(&state)
        .args(["create", "maintainers", "--member", "engineer"]);
    let output = timeout(WAIT, team.output()).await??;
    ensure!(
        output.status.success(),
        "configure terminal UI fixture Team: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let tmux = Tmux {
        socket: directory.path().join("tmux.sock"),
    };
    let shell = format!(
        "env -i PATH=/usr/bin:/bin TERM=xterm-256color HOME={} SUPERTAG_STATE_DIR={} SUPERTAG_TUI_BINARY={} {}",
        shell_path(directory.path())?,
        shell_path(&state)?,
        shell_path(Path::new(&binary))?,
        shell_path(Path::new(BINARY))?,
    );
    tmux.run(&[
        "new-session",
        "-d",
        "-s",
        "runtime",
        "-x",
        "160",
        "-y",
        "45",
        &shell,
    ])
    .await?;
    tmux.wait_for("Say something to engineer.").await?;
    tmux.run(&["send-keys", "-t", "runtime", "-l", "Rust UI round trip"])
        .await?;
    tmux.run(&["send-keys", "-t", "runtime", "Enter"]).await?;
    tmux.wait_for("Process requests: Rust UI round trip")
        .await?;
    let credentials: Value =
        serde_json::from_slice(&std::fs::read(state.join("credentials.json"))?)?;
    let token = credentials["operator_token"]
        .as_str()
        .context("test operator credential missing")?;
    let mut messages = conversations_client::ConversationsClient::new(channel(&endpoint).await?);
    let page = messages
        .list_conversations(authenticated_request(
            ListConversationsRequest {
                tag_id: "engineer".into(),
                ..Default::default()
            },
            token,
            None,
        )?)
        .await?
        .into_inner();
    let thread = page
        .conversations
        .first()
        .context("Go TUI conversation missing")?;
    messages
        .send_message(authenticated_request(
            SendMessageRequest {
                output_policy: None,
                execution_limits: None,
                tag_id: "engineer".into(),
                conversation: thread.name.clone(),
                operation_id: "external-client".into(),
                text: "Reply from another client".into(),
            },
            token,
            None,
        )?)
        .await?;
    tmux.wait_for("Process requests: Reply from another client")
        .await?;
    tmux.wait_for("maintainers").await?;
    tmux.run(&["send-keys", "-t", "runtime", "Tab", "Down"])
        .await?;
    tmux.wait_for("Members: engineer").await?;
    tmux.wait_for("No posts yet.").await?;
    tmux.run(&["send-keys", "-t", "runtime", "C-c"]).await?;
    if let Some(pid) = runtime.id() {
        // SAFETY: this PID belongs to the supervised disposable runtime.
        unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    }
    assert!(timeout(WAIT, runtime.wait()).await??.success());
    Ok(())
}

#[tokio::test]
#[ignore = "requires tmux and SUPERTAG_RUST_TEST_TUI pointing to a version-matched Go terminal UI"]
async fn rust_launcher_and_go_tui_follow_one_work_session_report() -> Result<()> {
    let binary = std::env::var_os("SUPERTAG_RUST_TEST_TUI")
        .context("version-matched terminal UI binary required")?;
    let directory = tempfile::Builder::new()
        .prefix("work-tui-")
        .tempdir_in("/tmp")?;
    let state = directory.path().join("state");
    let mut up = command(&[
        "up",
        "--adapter",
        ADAPTER,
        "--adapter-arg=--work-session-flow",
    ]);
    up.arg("--state-directory").arg(&state);
    let (mut runtime, _) = service(up).await?;
    let mut put = command(&["put-tag", "engineer", "--instructions", "Process requests"]);
    put.arg("--state-directory").arg(&state);
    let output = timeout(WAIT, put.output()).await??;
    ensure!(
        output.status.success(),
        "configure fixture Tag: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let tmux = Tmux {
        socket: directory.path().join("tmux.sock"),
    };
    let shell = format!(
        "env -i PATH=/usr/bin:/bin TERM=xterm-256color HOME={} SUPERTAG_STATE_DIR={} SUPERTAG_TUI_BINARY={} {}",
        shell_path(directory.path())?,
        shell_path(&state)?,
        shell_path(Path::new(&binary))?,
        shell_path(Path::new(BINARY))?,
    );
    tmux.run(&[
        "new-session",
        "-d",
        "-s",
        "runtime",
        "-x",
        "160",
        "-y",
        "45",
        &shell,
    ])
    .await?;
    tmux.wait_for("Say something to engineer.").await?;
    tmux.run(&[
        "send-keys",
        "-t",
        "runtime",
        "-l",
        "Investigate the release",
    ])
    .await?;
    tmux.run(&["send-keys", "-t", "runtime", "Enter"]).await?;
    tmux.wait_for("Started the investigation.").await?;
    tmux.wait_for("The investigation finished.").await?;
    let pane = tmux.run(&["capture-pane", "-p", "-t", "runtime"]).await?;
    assert!(pane.contains("Bounded investigation"));
    assert_eq!(
        pane.matches("The investigation finished.").count(),
        1,
        "{pane}"
    );
    assert!(!pane.contains("Inspect child evidence"), "{pane}");
    tmux.run(&["send-keys", "-t", "runtime", "C-c"]).await?;
    if let Some(pid) = runtime.id() {
        // SAFETY: this PID belongs to the disposable runtime started above.
        unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    }
    assert!(timeout(WAIT, runtime.wait()).await??.success());
    Ok(())
}

#[tokio::test]
#[ignore = "requires tmux and SUPERTAG_RUST_TEST_TUI pointing to a version-matched Go terminal UI"]
async fn rust_launcher_and_go_tui_continue_a_questioned_work_session() -> Result<()> {
    let binary = std::env::var_os("SUPERTAG_RUST_TEST_TUI")
        .context("version-matched terminal UI binary required")?;
    let directory = tempfile::Builder::new()
        .prefix("work-question-tui-")
        .tempdir_in("/tmp")?;
    let state = directory.path().join("state");
    let marker = directory.path().join("fixture-work.json");
    let mut up = command(&["up", "--adapter", ADAPTER]);
    up.arg(format!(
        "--adapter-arg=--work-session-question-flow={}",
        marker.display()
    ))
    .arg("--state-directory")
    .arg(&state);
    let (mut runtime, endpoint) = service(up).await?;
    let mut put = command(&["put-tag", "engineer", "--instructions", "Process requests"]);
    put.arg("--state-directory").arg(&state);
    let output = timeout(WAIT, put.output()).await??;
    ensure!(
        output.status.success(),
        "configure fixture Tag: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let tmux = Tmux {
        socket: directory.path().join("tmux.sock"),
    };
    let shell = format!(
        "env -i PATH=/usr/bin:/bin TERM=xterm-256color HOME={} SUPERTAG_STATE_DIR={} SUPERTAG_TUI_BINARY={} {}",
        shell_path(directory.path())?,
        shell_path(&state)?,
        shell_path(Path::new(&binary))?,
        shell_path(Path::new(BINARY))?,
    );
    tmux.run(&[
        "new-session",
        "-d",
        "-s",
        "runtime",
        "-x",
        "160",
        "-y",
        "80",
        &shell,
    ])
    .await?;
    tmux.wait_for("Say something to engineer.").await?;
    tmux.run(&[
        "send-keys",
        "-t",
        "runtime",
        "-l",
        "Investigate the release region",
    ])
    .await?;
    tmux.run(&["send-keys", "-t", "runtime", "Enter"]).await?;
    tmux.wait_for("Which region should I inspect?").await?;
    let waiting = tmux.run(&["capture-pane", "-p", "-t", "runtime"]).await?;
    ensure!(
        waiting.contains("waiting on you"),
        "child question did not show waiting state:\n{waiting}"
    );
    ensure!(
        waiting.matches("Which region should I inspect?").count() == 1,
        "first report repeated:\n{waiting}"
    );
    tmux.run(&["send-keys", "-t", "runtime", "-l", "Use us-east-1"])
        .await?;
    tmux.run(&["send-keys", "-t", "runtime", "Enter"]).await?;
    tmux.wait_for("Continuing the investigation.").await?;
    tmux.wait_for("Region us-east-1 is verified.").await?;
    let check_reports = |pane: &str| -> Result<()> {
        ensure!(
            pane.matches("Which region should I inspect?").count() == 1,
            "first report disappeared or repeated:\n{pane}"
        );
        ensure!(
            pane.matches("Region us-east-1 is verified.").count() == 1,
            "second report disappeared or repeated:\n{pane}"
        );
        ensure!(
            !pane.contains("Inspect child evidence") && !pane.contains("work-session-question>"),
            "internal report prompt was displayed:\n{pane}"
        );
        Ok(())
    };
    check_reports(&tmux.run(&["capture-pane", "-p", "-t", "runtime"]).await?)?;

    let credentials: Value =
        serde_json::from_slice(&std::fs::read(state.join("credentials.json"))?)?;
    let token = credentials["operator_token"]
        .as_str()
        .context("test operator credential")?;
    let original: Value = serde_json::from_slice(&std::fs::read(&marker)?)?;
    let id = original["work_session_id"]
        .as_str()
        .context("original Work Session")?;
    let mut work = work_sessions_client::WorkSessionsClient::new(channel(&endpoint).await?);
    let latest = work
        .get(authenticated_request(
            GetWorkSessionRequest {
                work_session_id: id.into(),
                report_task_id: None,
            },
            token,
            None,
        )?)
        .await?
        .into_inner();
    ensure!(
        latest.latest_task_state() == TaskState::Succeeded
            && latest.report_task_state() == TaskState::Succeeded
    );
    ensure!(
        Some(latest.latest_task_id.as_str()) != original["child_task_id"].as_str(),
        "answer did not create a new child turn"
    );
    let page = work
        .list(authenticated_request(
            ListWorkSessionsRequest {
                parent_tag_id: latest.parent_tag_id.clone(),
                parent_session_id: latest.parent_session_id.clone(),
                starter_task_id: None,
                limit: 4,
                cursor: String::new(),
            },
            token,
            None,
        )?)
        .await?
        .into_inner();
    ensure!(
        page.work_sessions.len() == 1 && page.work_sessions[0].work_session_id == id,
        "answer started a different Work Session"
    );

    // A fresh TUI must reconstruct both historical reports, not just preserve
    // text already rendered by the earlier live follows.
    tmux.run(&["respawn-pane", "-k", "-t", "runtime", &shell])
        .await?;
    tmux.wait_for("Which region should I inspect?").await?;
    tmux.wait_for("Region us-east-1 is verified.").await?;
    check_reports(&tmux.run(&["capture-pane", "-p", "-t", "runtime"]).await?)?;
    tmux.run(&["send-keys", "-t", "runtime", "C-c"]).await?;
    if let Some(pid) = runtime.id() {
        // SAFETY: this PID belongs to the disposable runtime started above.
        unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    }
    ensure!(timeout(WAIT, runtime.wait()).await??.success());
    Ok(())
}

#[tokio::test]
async fn watch_replays_private_conversations_after_services_restart() -> Result<()> {
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

    let directory = tempfile::tempdir()?;
    let secret = Uuid::new_v4().to_string();
    let alice_token = Uuid::new_v4().to_string();
    let bob_token = Uuid::new_v4().to_string();
    let control_command = || {
        let mut control = command(&["control-plane"]);
        control.env("SUPERTAG_GATEWAY_TOKEN", &secret).env(
            "SUPERTAG_DATABASE_URL",
            format!(
                "sqlite://{}?mode=rwc",
                directory.path().join("watch.db").display()
            ),
        );
        control
    };
    let (mut plane, private) = service(control_command()).await?;
    let (mut alice_gateway, alice_url) =
        service(gateway(&private, &secret, &alice_token, "operator:alice")).await?;
    let (mut bob_gateway, bob_url) =
        service(gateway(&private, &secret, &bob_token, "operator:bob")).await?;
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

    // Leave the streams idle beyond the Gateway's unary forwarding deadline.
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
        conversation: "private".into(),
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

    // Open streams must release both services during graceful shutdown.
    stop(&mut alice_gateway).await?;
    assert_eq!(
        timeout(WAIT, alice_watch.message())
            .await?
            .unwrap_err()
            .code(),
        Code::Unavailable
    );
    stop(&mut plane).await?;
    stop(&mut bob_gateway).await?;

    let (mut plane, private) = service(control_command()).await?;
    let (mut gateway, address) =
        service(gateway(&private, &secret, &bob_token, "operator:bob")).await?;
    let mut resumed = open(&address, &bob_token, bob_start.resume_token).await?;
    check(until_tag(&mut resumed).await?, &private_b, &private_a);
    stop(&mut plane).await?;
    stop(&mut gateway).await?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires tmux and SUPERTAG_RUST_TEST_TUI pointing to a version-matched Go terminal UI"]
async fn rust_launcher_and_go_tui_answer_a_harness_question() -> Result<()> {
    let binary = std::env::var_os("SUPERTAG_RUST_TEST_TUI")
        .context("version-matched terminal UI binary required")?;
    let directory = tempfile::Builder::new()
        .prefix("inbox-v2-")
        .tempdir_in("/tmp")?;
    let state = directory.path().join("state");
    let mut up = command(&[
        "up",
        "--adapter",
        ADAPTER,
        "--adapter-arg=--objective-question",
    ]);
    up.arg("--state-directory").arg(&state);
    let (mut runtime, endpoint) = service(up).await?;
    let mut put = command(&[
        "put-tag",
        "engineer",
        "--instructions",
        "Release engineering",
    ]);
    put.arg("--state-directory").arg(&state);
    let output = timeout(WAIT, put.output()).await??;
    ensure!(
        output.status.success(),
        "fixture Tag: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let mut create = command(&["objective", "--state-directory"]);
    create.arg(&state).args([
        "create",
        "release",
        "--owner",
        "engineer",
        "Ask which branch to release",
    ]);
    let output = timeout(WAIT, create.output()).await??;
    ensure!(
        output.status.success(),
        "fixture Objective: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let objective: Value = serde_json::from_slice(&output.stdout)?;
    let initial_task = objective["starting_task_id"]
        .as_str()
        .context("starting Task missing")?
        .to_owned();
    let credentials: Value =
        serde_json::from_slice(&std::fs::read(state.join("credentials.json"))?)?;
    let token = credentials["operator_token"]
        .as_str()
        .context("test operator credential missing")?;
    let channel = channel(&endpoint).await?;
    let mut inbox = inbox_client::InboxClient::new(channel.clone());
    timeout(WAIT, async {
        loop {
            let result = inbox
                .list_items(authenticated_request(
                    ListInboxItemsRequest {
                        kind: InboxItemKind::Question.into(),
                        ..Default::default()
                    },
                    token,
                    None,
                )?)
                .await?
                .into_inner();
            if let Some(item) = result.items.first() {
                ensure!(item.task_id == initial_task);
                ensure!(
                    item.question
                        .as_ref()
                        .is_some_and(|question| question.text == "Which branch should I release?")
                );
                return Ok::<_, anyhow::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await??;

    let mut read = command(&["inbox", "--state-directory"]);
    read.arg(&state).args(["question", &initial_task]);
    let output = timeout(WAIT, read.output()).await??;
    ensure!(
        output.status.success(),
        "read the fixture question: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout)?["text"],
        "Which branch should I release?"
    );

    let tmux = Tmux {
        socket: directory.path().join("tmux.sock"),
    };
    let shell = format!(
        "env -i PATH=/usr/bin:/bin TERM=xterm-256color HOME={} SUPERTAG_STATE_DIR={} SUPERTAG_TUI_BINARY={} {}",
        shell_path(directory.path())?,
        shell_path(&state)?,
        shell_path(Path::new(&binary))?,
        shell_path(Path::new(BINARY))?,
    );
    tmux.run(&[
        "new-session",
        "-d",
        "-s",
        "runtime",
        "-x",
        "160",
        "-y",
        "45",
        &shell,
    ])
    .await?;
    tmux.wait_for("Waiting on you (1)").await?;
    tmux.run(&["send-keys", "-t", "runtime", "Tab", "Down", "Down", "Tab"])
        .await?;
    tmux.wait_for("The owner asks:").await?;
    tmux.wait_for("Which branch should I release?").await?;
    tmux.run(&["send-keys", "-t", "runtime", "-l", "release-main"])
        .await?;
    tmux.run(&["send-keys", "-t", "runtime", "Enter"]).await?;
    tmux.wait_for("takes your answer as its next turn").await?;

    let question = inbox
        .get_question(authenticated_request(
            GetQuestionRequest {
                task_id: initial_task,
            },
            token,
            None,
        )?)
        .await?
        .into_inner();
    let answer_id = question
        .answer_task_id
        .context("answer was not linked to the question")?;
    let mut operator = operator_client::OperatorClient::new(channel);
    timeout(WAIT, async {
        loop {
            let task = operator
                .get_task(authenticated_request(
                    GetTaskRequest {
                        task_id: answer_id.clone(),
                    },
                    token,
                    None,
                )?)
                .await?
                .into_inner();
            if task.state() == TaskState::Succeeded {
                ensure!(
                    task.result
                        .as_deref()
                        .is_some_and(|result| result.contains("release-main"))
                );
                return Ok::<_, anyhow::Error>(());
            }
            ensure!(matches!(
                task.state(),
                TaskState::Queued | TaskState::Claimed | TaskState::Running
            ));
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await??;

    tmux.run(&["send-keys", "-t", "runtime", "C-c"]).await?;
    if let Some(pid) = runtime.id() {
        // SAFETY: this is the disposable supervisor started by this test.
        unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    }
    assert!(timeout(WAIT, runtime.wait()).await??.success());
    Ok(())
}
