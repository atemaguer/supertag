//! Operator publication and consumption approvals through real split services.
use anyhow::{Context, Result, ensure};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    net::SocketAddr, os::unix::fs::PermissionsExt, path::Path, process::Stdio, time::Duration,
};
use supertag_protocol::{HOST_GENERATION_HEADER, authenticated_request, v2::*};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::timeout,
};
use tonic::{Request, transport::Channel};
const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const WAIT: Duration = Duration::from_secs(30);
struct Credentials {
    gateway: String,
    operator: String,
    host: String,
}
impl Credentials {
    fn new() -> Self {
        Self {
            gateway: uuid::Uuid::new_v4().to_string(),
            operator: uuid::Uuid::new_v4().to_string(),
            host: uuid::Uuid::new_v4().to_string(),
        }
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut c = Command::new(BINARY);
        c.args(args)
            .env_clear()
            .env("SUPERTAG_GATEWAY_TOKEN", &self.gateway)
            .env("SUPERTAG_OPERATOR_TOKEN", &self.operator)
            .env("SUPERTAG_HOST_TOKEN", &self.host)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &self.host)
            .stdin(Stdio::null())
            .kill_on_drop(true);
        c
    }
    fn host<T>(&self, value: T, generation: u64) -> Request<T> {
        let mut r = authenticated_request(value, &self.host, None).unwrap();
        r.metadata_mut().insert(
            HOST_GENERATION_HEADER,
            generation.to_string().parse().unwrap(),
        );
        r
    }
}
async fn service(mut command: Command) -> Result<(Child, String)> {
    let mut child = command.stdout(Stdio::piped()).spawn()?;
    let mut out = BufReader::new(child.stdout.take().context("missing service stdout")?);
    let mut line = String::new();
    timeout(WAIT, out.read_line(&mut line)).await??;
    let address: SocketAddr = line.trim().parse()?;
    ensure!(address.ip().is_loopback());
    Ok((child, format!("http://{address}")))
}
async fn json(mut command: Command) -> Result<Value> {
    let result = timeout(WAIT, command.output()).await??;
    ensure!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    Ok(serde_json::from_slice(&result.stdout)?)
}
async fn stop(child: &mut Child) -> Result<()> {
    child.kill().await?;
    child.wait().await?;
    Ok(())
}
fn plane(credentials: &Credentials, root: &Path, listen: &str) -> Command {
    let mut c = credentials.command(&["control-plane", "--listen", listen]);
    c.env(
        "SUPERTAG_DATABASE_URL",
        format!(
            "sqlite://{}?mode=rwc",
            root.join("control.sqlite").display()
        ),
    );
    c
}
fn gateway(credentials: &Credentials, root: &Path, private: &str) -> Command {
    let mut c = credentials.command(&["gateway", "--control-plane", private]);
    c.arg("--checkpoint-directory")
        .arg(root.join("cas"))
        .arg("--artifact-volume")
        .arg(format!("published={}", root.join("volume").display()));
    c
}
fn publication(credentials: &Credentials, public: &str, args: &[&str]) -> Command {
    let mut c = credentials.command(&["artifact-publication", "--gateway", public]);
    c.args(args);
    c
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cross_objective_publication_is_explicit_and_durable() -> Result<()> {
    let temporary = tempfile::tempdir()?;
    let root = temporary.path().canonicalize()?;
    let volume = root.join("volume");
    std::fs::create_dir(&volume)?;
    std::fs::set_permissions(&volume, std::fs::Permissions::from_mode(0o700))?;
    let credentials = Credentials::new();
    let (mut control, private) = service(plane(&credentials, &root, "127.0.0.1:0")).await?;
    let (mut ingress, public) = service(gateway(&credentials, &root, &private)).await?;
    let channel = Channel::from_shared(public.clone())?.connect().await?;
    let mut operator = operator_client::OperatorClient::new(channel.clone());
    let mut host = worker_host_client::WorkerHostClient::new(channel.clone());
    operator
        .put_tag(authenticated_request(
            PutTagRequest {
                tag_id: "writer".into(),
                instructions: "Capture evidence".into(),
                allowed_actions: vec!["files:read".into()],
                ..Default::default()
            },
            &credentials.operator,
            None,
        )?)
        .await?;
    operator
        .put_tag(authenticated_request(
            PutTagRequest {
                tag_id: "consumer".into(),
                instructions: "Consume selected input".into(),
                allowed_actions: vec!["files:read".into()],
                harness_kind: HarnessKind::OpenaiAgents as i32,
                workspace: Some(WorkspaceSpec {
                    workspace_id: "repo".into(),
                    base_commit: "1".repeat(40),
                    ..Default::default()
                }),
                ..Default::default()
            },
            &credentials.operator,
            None,
        )?)
        .await?;
    let mut objectives = objectives_client::ObjectivesClient::new(channel.clone());
    let source = objectives
        .create_objective(authenticated_request(
            CreateObjectiveRequest {
                operation_id: "source".into(),
                objective_id: "source".into(),
                owner_tag_id: "writer".into(),
                outcome: "Produce evidence".into(),
                ongoing: true,
                ..Default::default()
            },
            &credentials.operator,
            None,
        )?)
        .await?
        .into_inner();
    let destination = objectives
        .create_objective(authenticated_request(
            CreateObjectiveRequest {
                operation_id: "destination".into(),
                objective_id: "destination".into(),
                owner_tag_id: "consumer".into(),
                outcome: "Consume approved evidence".into(),
                ongoing: true,
                ..Default::default()
            },
            &credentials.operator,
            None,
        )?)
        .await?
        .into_inner();
    let task = operator
        .get_task(authenticated_request(
            GetTaskRequest {
                task_id: source.starting_task_id.clone(),
            },
            &credentials.operator,
            None,
        )?)
        .await?
        .into_inner();
    let registered = host
        .register_host(authenticated_request(
            RegisterHostRequest {
                incarnation_id: "volume-fixture".into(),
            },
            &credentials.host,
            None,
        )?)
        .await?
        .into_inner();
    let assignment = host
        .claim_task(credentials.host(
            ClaimTaskRequest {
                operation_id: "claim".into(),
                ..Default::default()
            },
            registered.generation,
        ))
        .await?
        .into_inner()
        .assignment
        .context("no assignment")?;
    assert_eq!(assignment.task.as_ref().unwrap().task_id, task.task_id);
    let attempt = InspectAttemptRequest {
        task_id: task.task_id.clone(),
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    };
    host.start_task(credentials.host(
        StartTaskRequest {
            task_id: attempt.task_id.clone(),
            attempt_id: attempt.attempt_id.clone(),
            lease_token: attempt.lease_token.clone(),
        },
        registered.generation,
    ))
    .await?;
    let bytes = b"exact durable artifact evidence\n".to_vec();
    let blob = BlobReference {
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        byte_length: bytes.len() as u64,
    };
    let capture = CommitArtifactCaptureRequest {
        attempt: Some(attempt.clone()),
        operation_id: "capture".into(),
        description: Some(ArtifactDescription {
            title: "Evidence".into(),
            kind: "report".into(),
            summary: None,
        }),
        files: vec![ArtifactFile {
            path: "report.txt".into(),
            blob: Some(blob.clone()),
            ..Default::default()
        }],
        ..Default::default()
    };
    let mut transfers = artifact_transfers_client::ArtifactTransfersClient::new(channel);
    let artifact = transfers
        .upload_capture(credentials.host(
            tokio_stream::iter(vec![
                ArtifactUpload {
                    part: Some(artifact_upload::Part::Begin(capture)),
                },
                ArtifactUpload {
                    part: Some(artifact_upload::Part::Chunk(ArtifactChunk {
                        file_index: 0,
                        data: bytes.clone(),
                    })),
                },
            ]),
            registered.generation,
        ))
        .await?
        .into_inner();
    let artifact_id = artifact.summary.unwrap().artifact_id;
    host.finish_task(credentials.host(
        FinishTaskRequest {
            task_id: attempt.task_id,
            attempt_id: attempt.attempt_id,
            lease_token: attempt.lease_token,
            succeeded: true,
            result: "Captured".into(),
            artifacts: vec![ArtifactSelection {
                artifact_id: artifact_id.clone(),
                paths: vec!["report.txt".into()],
            }],
            ..Default::default()
        },
        registered.generation,
    ))
    .await?;

    let approved = json(publication(
        &credentials,
        &public,
        &[
            "publish",
            "published",
            &artifact_id,
            "--path",
            "report.txt",
            "--audience",
            &destination.objective_id,
        ],
    ))
    .await?;
    assert_eq!(approved["revision"], 1);
    let consent = json(publication(
        &credentials,
        &public,
        &["consume", "consent", "published", &destination.objective_id],
    ))
    .await?;
    assert_eq!(consent["revision"], 1);
    let audience = json(publication(
        &credentials,
        &public,
        &["list", &destination.objective_id],
    ))
    .await?;
    assert_eq!(audience["publications"][0]["artifact_id"], artifact_id);
    assert!(audience["publications"][0].get("producer").is_none());
    operator
        .cancel_task(authenticated_request(
            CancelTaskRequest {
                task_id: destination.starting_task_id.clone(),
            },
            &credentials.operator,
            None,
        )?)
        .await?;
    let admitted = json(credentials.command(&[
        "submit",
        "--gateway",
        &public,
        "--tag",
        "consumer",
        "--session",
        &destination.session_id,
        "--operation-id",
        "consume-input",
        "--artifact-input",
        &format!("{artifact_id}:report.txt"),
        "--artifact-publication",
        "published",
        "Use the exact published evidence",
    ]))
    .await?;
    assert_eq!(
        admitted["input_artifacts"][0]["publication"]["consumption_id"],
        "consent"
    );
    json(credentials.command(&[
        "volume",
        "--gateway",
        &public,
        "put",
        "published",
        "--source",
        &format!("file://{}", volume.display()),
        "--operation-id",
        "register-volume",
    ]))
    .await?;
    json(credentials.command(&[
        "volume",
        "--gateway",
        &public,
        "copy",
        "published",
        &artifact_id,
        "--path",
        "report.txt",
        "--expected-revision",
        "1",
        "--operation-id",
        "copy-volume",
    ]))
    .await?;
    stop(&mut ingress).await?;
    stop(&mut control).await?;
    std::fs::remove_file(root.join("cas").join(&blob.sha256))?;
    let (mut control, private) = service(plane(&credentials, &root, "127.0.0.1:0")).await?;
    let (mut ingress, public) = service(gateway(&credentials, &root, &private)).await?;
    let replay = json(publication(
        &credentials,
        &public,
        &[
            "publish",
            "published",
            &artifact_id,
            "--path",
            "report.txt",
            "--audience",
            &destination.objective_id,
        ],
    ))
    .await?;
    assert_eq!(approved, replay);
    let channel = Channel::from_shared(public.clone())?.connect().await?;
    let mut host = worker_host_client::WorkerHostClient::new(channel.clone());
    let assignment = host
        .claim_task(credentials.host(
            ClaimTaskRequest {
                operation_id: "consume-input".into(),
                workspace_ids: vec!["repo".into()],
                harness_kind: HarnessKind::OpenaiAgents as i32,
                execution_profile: Some(HarnessExecutionProfile {
                    task_artifact_inputs: true,
                    ..Default::default()
                }),
                ..Default::default()
            },
            registered.generation,
        ))
        .await?
        .into_inner()
        .assignment
        .context("missing consumer assignment")?;
    assert_eq!(
        assignment.task.as_ref().unwrap().task_id,
        admitted["task_id"].as_str().unwrap()
    );
    let live = InspectAttemptRequest {
        task_id: admitted["task_id"].as_str().unwrap().into(),
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    };
    host.start_task(credentials.host(
        StartTaskRequest {
            task_id: live.task_id.clone(),
            attempt_id: live.attempt_id.clone(),
            lease_token: live.lease_token.clone(),
        },
        registered.generation,
    ))
    .await?;
    let mut acquisitions = attempt_artifacts_client::AttemptArtifactsClient::new(channel.clone());
    let operation = supertag_protocol::task_artifact_inputs::operation_id(&artifact_id);
    let acquired = acquisitions
        .acquire(credentials.host(
            AcquireArtifactRequest {
                attempt: Some(live.clone()),
                operation_id: operation.clone(),
                artifact_id: artifact_id.clone(),
                paths: vec!["report.txt".into()],
                delivery: ArtifactDelivery::Materialize as i32,
                destination: Some(
                    supertag_protocol::artifacts::materialized_artifact_directory(
                        &live.attempt_id,
                        &operation,
                    ),
                ),
            },
            registered.generation,
        ))
        .await?
        .into_inner();
    let download = GetAcquiredArtifactFileRequest {
        attempt: Some(live.clone()),
        acquisition_id: acquired.acquisition_id,
        path: "report.txt".into(),
    };
    let mut transfers = artifact_transfers_client::ArtifactTransfersClient::new(channel);
    let mut stream = transfers
        .download_acquired_file(credentials.host(download.clone(), registered.generation))
        .await?
        .into_inner();
    let mut received = Vec::new();
    while let Some(part) = stream.message().await? {
        if let Some(artifact_download::Part::Chunk(chunk)) = part.part {
            received.extend(chunk)
        }
    }
    assert_eq!(received, bytes);
    let delivered = acquisitions
        .settle(credentials.host(
            SettleArtifactAcquisitionRequest {
                attempt: Some(live),
                acquisition_id: download.acquisition_id.clone(),
                state: ArtifactAcquisitionState::Delivered.into(),
            },
            registered.generation,
        ))
        .await?
        .into_inner();
    assert_eq!(delivered.state(), ArtifactAcquisitionState::Delivered);
    assert!(!root.join("cas").join(&blob.sha256).exists());
    let withdrawn = json(publication(
        &credentials,
        &public,
        &[
            "withdraw-consumption",
            "consent",
            "--expected-revision",
            "1",
        ],
    ))
    .await?;
    assert_eq!(withdrawn["revision"], 2);
    assert!(
        transfers
            .download_acquired_file(credentials.host(download, registered.generation))
            .await
            .is_err()
    );
    assert_eq!(
        withdrawn,
        json(publication(
            &credentials,
            &public,
            &[
                "withdraw-consumption",
                "consent",
                "--expected-revision",
                "1"
            ]
        ))
        .await?
    );
    let audit = json(publication(
        &credentials,
        &public,
        &["audit", "consumption", "consent"],
    ))
    .await?;
    assert_eq!(audit["events"].as_array().unwrap().len(), 2);
    stop(&mut ingress).await?;
    stop(&mut control).await?;
    Ok(())
}
