//! Operator publication and consumption approvals through real split services.
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

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    cross_objective_publication_is_explicit_and_durable;
}

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use std::{net::SocketAddr, os::unix::fs::PermissionsExt, process::Stdio, time::Duration};
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
            gateway: supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX),
            operator: uuid::Uuid::new_v4().to_string(),
            host: supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX),
        }
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut c = reaped(Command::new(BINARY));
        c.args(args)
            .env_clear()
            .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &self.gateway)
            .env("SUPERTAG_GATEWAY_CREDENTIAL", &self.gateway)
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
fn plane(credentials: &Credentials, database: &str, listen: &str) -> Command {
    let mut c = credentials.command(&["control-plane", "--listen", listen]);
    c.env("SUPERTAG_DATABASE_URL", database);
    c
}
fn publication(credentials: &Credentials, public: &str, args: &[&str]) -> Command {
    let mut c = credentials.command(&["artifact-publication", "--gateway", public]);
    c.args(args);
    c
}
fn consumption(credentials: &Credentials, public: &str, args: &[&str]) -> Command {
    let mut c = credentials.command(&["artifact-consumption", "--gateway", public]);
    c.args(args);
    c
}
async fn cross_objective_publication_is_explicit_and_durable(database: String) -> Result<()> {
    let temporary = tempfile::tempdir()?;
    let root = temporary.path().canonicalize()?;
    let volume = root.join("volume");
    std::fs::create_dir(&volume)?;
    std::fs::set_permissions(&volume, std::fs::Permissions::from_mode(0o700))?;
    let credentials = Credentials::new();
    let (mut control, public) = service(plane(&credentials, &database, "127.0.0.1:0")).await?;
    let channel =
        protocol::negotiated(Channel::from_shared(public.clone())?.connect().await?).await?;
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
    let mut held = held_artifacts::HeldArtifacts::register(
        channel.clone(),
        &credentials.host,
        registered.generation,
    )
    .await?;
    let blob = held.hold(&attempt.attempt_id, &bytes);
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
    let artifact = held.commit(capture).await?;
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
    let consent = json(consumption(
        &credentials,
        &public,
        &["approve", "consent", "published", &destination.objective_id],
    ))
    .await?;
    assert_eq!(consent["revision"], 1);
    let mut list = credentials.command(&["get", "--gateway", &public, "artifact-publications"]);
    list.args(["--objective", &destination.objective_id]);
    let audience = json(list).await?;
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
        "task",
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
    stop(&mut control).await?;
    // The Control Plane restarts; the producing Worker Host reconnects and still holds the bytes.
    let (mut control, public) = service(plane(&credentials, &database, "127.0.0.1:0")).await?;
    held.reconnect(protocol::dial(public.clone()).await?)
        .await?;
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
    let channel =
        protocol::negotiated(Channel::from_shared(public.clone())?.connect().await?).await?;
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
    // The consumer reads the bytes from the producing Worker Host, never through the Control
    // Plane, under a transfer grant for exactly the acquired file.
    let grant = acquisitions
        .issue_artifact_transfer(credentials.host(download.clone(), registered.generation))
        .await?
        .into_inner();
    assert_eq!(grant.file.as_ref(), acquired.files.first());
    assert_eq!(
        grant.file.as_ref().and_then(|file| file.blob.as_ref()),
        Some(&blob)
    );
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
    let withdrawn = json(consumption(
        &credentials,
        &public,
        &["withdraw", "consent", "--expected-revision", "1"],
    ))
    .await?;
    assert_eq!(withdrawn["revision"], 2);
    assert!(
        acquisitions
            .issue_artifact_transfer(credentials.host(download, registered.generation))
            .await
            .is_err()
    );
    assert_eq!(
        withdrawn,
        json(consumption(
            &credentials,
            &public,
            &["withdraw", "consent", "--expected-revision", "1"]
        ))
        .await?
    );
    let audit = json(consumption(&credentials, &public, &["audit", "consent"])).await?;
    assert_eq!(audit["events"].as_array().unwrap().len(), 2);
    stop(&mut control).await?;
    Ok(())
}
