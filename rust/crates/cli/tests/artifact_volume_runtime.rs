//! Actual split processes preserve consent and verified-copy recovery across restart.
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
fn gateway(credentials: &Credentials, root: &Path, private: &str, mapped: bool) -> Command {
    let mut c = credentials.command(&["gateway", "--control-plane", private]);
    c.arg("--checkpoint-directory").arg(root.join("cas"));
    if mapped {
        c.arg("--artifact-volume")
            .arg(format!("durable={}", root.join("volume").display()));
    }
    c
}
fn volume(credentials: &Credentials, public: &str, args: &[&str]) -> Command {
    let mut c = credentials.command(&["volume", "--gateway", public]);
    c.args(args);
    c
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mapped_volume_copy_is_exact_durable_and_never_overwrites_divergent_bytes() -> Result<()> {
    let temporary = tempfile::tempdir()?;
    let root = temporary.path().canonicalize()?;
    let volume_path = root.join("volume");
    std::fs::create_dir(&volume_path)?;
    std::fs::set_permissions(&volume_path, std::fs::Permissions::from_mode(0o700))?;
    let credentials = Credentials::new();
    let (mut control, private) = service(plane(&credentials, &root, "127.0.0.1:0")).await?;
    let (mut ingress, public) = service(gateway(&credentials, &root, &private, false)).await?;
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
    let task = operator
        .submit_task(authenticated_request(
            SubmitTaskRequest {
                tag_id: "writer".into(),
                session_id: "source".into(),
                operation_id: "submit".into(),
                prompt: "Evidence".into(),
                ..Default::default()
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
    host.finish_task(credentials.host(
        FinishTaskRequest {
            task_id: attempt.task_id,
            attempt_id: attempt.attempt_id,
            lease_token: attempt.lease_token,
            succeeded: true,
            result: "Captured".into(),
            ..Default::default()
        },
        registered.generation,
    ))
    .await?;
    let artifact_id = artifact.summary.unwrap().artifact_id;
    let source = format!("file://{}", volume_path.display());
    let registered = json(volume(
        &credentials,
        &public,
        &[
            "put",
            "durable",
            "--source",
            &source,
            "--operation-id",
            "register",
        ],
    ))
    .await?;
    assert_eq!(registered["revision"], 1);
    let copy_args = [
        "copy",
        "durable",
        &artifact_id,
        "--path",
        "report.txt",
        "--expected-revision",
        "1",
        "--operation-id",
        "copy",
    ];
    let denied = volume(&credentials, &public, &copy_args).output().await?;
    assert!(!denied.status.success());
    assert!(String::from_utf8_lossy(&denied.stderr).contains("consent"));
    assert!(
        json(volume(&credentials, &public, &["copies"])).await?["copies"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(std::fs::read_dir(&volume_path)?.count(), 0);
    stop(&mut ingress).await?;
    let (next, next_public) = service(gateway(&credentials, &root, &private, true)).await?;
    ingress = next;
    let receipt = json(volume(&credentials, &next_public, &copy_args)).await?;
    assert_eq!(receipt["state"], "ARTIFACT_VOLUME_COPY_STATE_VERIFIED");
    let destination = volume_path.join(receipt["storage_key"].as_str().unwrap());
    assert_eq!(std::fs::read(&destination)?, bytes);
    assert_eq!(
        json(volume(&credentials, &next_public, &copy_args)).await?,
        receipt
    );
    let deletion = volume(
        &credentials,
        &next_public,
        &[
            "delete",
            "durable",
            "--expected-revision",
            "1",
            "--operation-id",
            "delete",
        ],
    )
    .output()
    .await?;
    assert!(!deletion.status.success());
    stop(&mut ingress).await?;
    stop(&mut control).await?;
    // The durable Volume remains usable after both service replacement and CAS loss.
    std::fs::remove_file(root.join("cas").join(&blob.sha256))?;
    let (next, new_private) = service(plane(&credentials, &root, "127.0.0.1:0")).await?;
    control = next;
    let (next, new_public) = service(gateway(&credentials, &root, &new_private, true)).await?;
    ingress = next;
    assert_eq!(
        json(volume(&credentials, &new_public, &copy_args)).await?,
        receipt
    );
    let listed = json(volume(
        &credentials,
        &new_public,
        &["copies", "--volume-id", "durable"],
    ))
    .await?;
    assert_eq!(listed["copies"], serde_json::json!([receipt.clone()]));
    let copy_id = receipt["copy_id"].as_str().unwrap();
    let download = root.join("downloaded.txt");
    let downloaded = json(volume(
        &credentials,
        &new_public,
        &["download", copy_id, "--output", download.to_str().unwrap()],
    ))
    .await?;
    assert_eq!(downloaded["sha256"], blob.sha256);
    assert_eq!(std::fs::read(&download)?, bytes);
    std::fs::write(&destination, b"divergent destination")?;
    let corrupted = volume(&credentials, &new_public, &copy_args)
        .output()
        .await?;
    assert!(!corrupted.status.success());
    assert_eq!(std::fs::read(&destination)?, b"divergent destination");
    let refused = root.join("refused.txt");
    let denied = volume(
        &credentials,
        &new_public,
        &["download", copy_id, "--output", refused.to_str().unwrap()],
    )
    .output()
    .await?;
    assert!(!denied.status.success());
    assert!(!refused.exists());
    let copy_id = receipt["copy_id"].as_str().unwrap();
    assert_eq!(
        json(volume(&credentials, &new_public, &["copy-get", copy_id])).await?,
        receipt
    );
    stop(&mut ingress).await?;
    stop(&mut control).await?;
    Ok(())
}
