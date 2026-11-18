//! A Tag's Volume keeps every capture beyond its Worker Host: the capturing host writes each copy
//! itself, through its own mapping of a file Volume or a presigned PUT to an S3 Volume, and the
//! Control Plane maps no Volume and carries no Volume bytes.
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
/// A Control Plane with its credential vault in `root`, as `supertag up` gives it one.
fn plane(credentials: &Credentials, root: &Path, database: &str) -> Command {
    let mut c = credentials.command(&["control-plane", "--listen", "127.0.0.1:0"]);
    c.env("SUPERTAG_DATABASE_URL", database)
        .env("SUPERTAG_STATE_DIR", root);
    c
}
fn volume(credentials: &Credentials, public: &str, args: &[&str]) -> Command {
    let mut c = credentials.command(&["volume", "--gateway", public]);
    c.args(args);
    c
}
/// `supertag get` for Volumes and their copies, or `supertag delete` with a leading "delete".
fn resource(credentials: &Credentials, public: &str, args: &[&str]) -> Command {
    let (verb, args) = args.split_first().expect("a verb");
    let mut c = credentials.command(&[verb, "--gateway", public]);
    c.args(args);
    c
}
#[path = "support/s3_artifact_volume.rs"]
mod s3_artifact_volume;

async fn capture(
    credentials: &Credentials,
    public: &str,
    tag_volume: Option<&str>,
    host_volume: Option<&Path>,
) -> Result<(
    String,
    Vec<u8>,
    BlobReference,
    held_artifacts::HeldArtifacts,
)> {
    let channel =
        protocol::negotiated(Channel::from_shared(public.to_owned())?.connect().await?).await?;
    let mut operator = operator_client::OperatorClient::new(channel.clone());
    let mut host = worker_host_client::WorkerHostClient::new(channel.clone());
    operator
        .put_tag(authenticated_request(
            PutTagRequest {
                tag_id: "writer".into(),
                instructions: "Capture evidence".into(),
                allowed_actions: vec!["files:read".into()],
                volume: tag_volume.map(str::to_owned),
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
                // A host that maps the Tag's file Volume says so; only it is placed.
                execution_profile: host_volume.map(|path| HarnessExecutionProfile {
                    volumes: vec![VolumeMapping {
                        volume_id: "durable".into(),
                        source: format!("file://{}", path.display()),
                    }],
                    ..Default::default()
                }),
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
    let held = held_artifacts::HeldArtifacts::register(
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
    let mut file_volumes = std::collections::BTreeMap::new();
    if let Some(path) = host_volume {
        file_volumes.insert(
            "durable".to_owned(),
            supertag_workspaces::artifact_volumes::FileVolume::open(path)?,
        );
    }
    let artifact = held.commit_writing(capture, &file_volumes).await?;
    ensure!(
        artifact.volume_copies.len() == usize::from(tag_volume.is_some())
            && artifact
                .volume_copies
                .iter()
                .all(|copy| copy.state() == ArtifactVolumeCopyState::Verified),
        "{:?}",
        artifact.volume_copies
    );
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
    Ok((artifact.summary.unwrap().artifact_id, bytes, blob, held))
}

/// A private, owner-only directory a Worker Host may map as a file Volume.
fn volume_directory(root: &Path) -> Result<std::path::PathBuf> {
    let path = root.join("volume");
    std::fs::create_dir(&path)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
    Ok(path)
}

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    a_tag_volume_keeps_each_capture_written_by_the_host_that_maps_it;
}

async fn a_tag_volume_keeps_each_capture_written_by_the_host_that_maps_it(
    database: String,
) -> Result<()> {
    let temporary = tempfile::tempdir()?;
    let root = temporary.path().canonicalize()?;
    let volume_path = volume_directory(&root)?;
    let credentials = Credentials::new();
    // The Control Plane maps no Volume: its old flags are refused, naming what replaces them.
    let mut old = plane(&credentials, &root, &database);
    old.arg("--artifact-volume")
        .arg(format!("durable={}", volume_path.display()));
    let refused = timeout(WAIT, old.output()).await??;
    let stderr = String::from_utf8_lossy(&refused.stderr);
    ensure!(
        !refused.status.success() && stderr.contains("supertag worker-host --volume"),
        "{stderr}"
    );
    let (mut control, public) = service(plane(&credentials, &root, &database)).await?;
    // A Tag may name only a registered Volume.
    let mut unknown = credentials.command(&["tag", "--gateway", &public]);
    unknown.args([
        "put",
        "writer",
        "--instructions",
        "Capture evidence",
        "--volume",
        "durable",
    ]);
    let refused = unknown.output().await?;
    let stderr = String::from_utf8_lossy(&refused.stderr);
    ensure!(
        !refused.status.success() && stderr.contains("does not exist"),
        "{stderr}"
    );
    let source = format!("file://{}", volume_path.display());
    json(volume(
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
    // A host that does not map the file Volume is never placed for the Tag.
    let unplaced = capture(&credentials, &public, Some("durable"), None)
        .await
        .err()
        .context("a host without the Volume was placed")?;
    ensure!(
        format!("{unplaced:#}").contains("no assignment"),
        "{unplaced:#}"
    );
    // The host that maps it writes the copy and attests it; the Control Plane never opens it.
    let (_artifact_id, bytes, blob, mut held) =
        capture(&credentials, &public, Some("durable"), Some(&volume_path)).await?;
    let copies = json(resource(
        &credentials,
        &public,
        &["get", "volume-copies", "--volume-id", "durable"],
    ))
    .await?;
    let copies = copies["copies"].as_array().unwrap();
    ensure!(copies.len() == 1, "{copies:?}");
    ensure!(copies[0]["host_attested"] == true, "{copies:?}");
    ensure!(copies[0]["state"] == "ARTIFACT_VOLUME_COPY_STATE_VERIFIED");
    let key = copies[0]["storage_key"].as_str().unwrap();
    ensure!(
        key.starts_with(&format!("tags/{:x}/attempts/", Sha256::digest("writer"))),
        "{key}"
    );
    // The bytes outlive the host: they are on the Volume, for any host that maps it.
    held.disconnect();
    drop(held);
    ensure!(std::fs::read(volume_path.join(key))? == bytes);
    ensure!(format!("{:x}", Sha256::digest(&bytes)) == blob.sha256);
    // A Volume a Tag names cannot be deleted.
    let deletion = resource(
        &credentials,
        &public,
        &[
            "delete",
            "volume",
            "durable",
            "--expected-revision",
            "1",
            "--operation-id",
            "delete",
        ],
    )
    .output()
    .await?;
    ensure!(!deletion.status.success());
    ensure!(String::from_utf8_lossy(&deletion.stderr).contains("a Tag keeps its work"));
    stop(&mut control).await?;
    Ok(())
}
