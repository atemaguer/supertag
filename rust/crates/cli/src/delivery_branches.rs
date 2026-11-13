//! Session branches in the operator's repository: `supertag fetch`, and the local supervisor's
//! automatic import of each delivered Task of a Workspace one of its Worker Hosts maps.
//!
//! A Worker Host never writes the operator's repository. Its delivery is a verified bundle the
//! Control Plane accepted; this machine downloads it through the Gateway, checks it against the
//! accepted receipt, and imports only the delivered commit as `supertag/session/<id>`.

use std::{
    collections::{BTreeMap, HashSet},
    io::Write as _,
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use clap::Args;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    CHECKPOINT_CHUNK_BYTES, MAX_MESSAGE_BYTES, MAX_WORKSPACE_BLOB_BYTES,
    v2::{
        GetSessionDeliveryRequest, GetTaskRequest, GetWorkspaceArtifactRequest, TaskState,
        WatchKind, WatchRequest, WorkspaceArtifactKind, WorkspaceDeliveryReference,
        operator_client::OperatorClient, operator_events_client::OperatorEventsClient,
        transfers_client::TransfersClient, watch_event::Update, workspace_download,
    },
    validate_workspace_delivery,
};
use supertag_workspaces::session_branch::{self, Imported, SessionDelivery};
use tokio_util::sync::CancellationToken;
use tonic::Code;

use crate::{Connection, connect_operator, request};

#[derive(Args)]
pub struct FetchArgs {
    /// A Task ID, or a Session ID to import that Session's latest delivery.
    id: String,
    /// The Tag whose Session to import, when more than one Tag has a Session with this ID.
    #[arg(long)]
    tag: Option<String>,
    /// The Git repository that receives the Session branch.
    #[arg(long, default_value = ".")]
    repository: PathBuf,
}

/// One accepted delivery and the Session it belongs to.
struct Accepted {
    task_id: String,
    tag_id: String,
    session_id: String,
    delivery: WorkspaceDeliveryReference,
}

pub async fn fetch(connection: Connection, args: FetchArgs) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let accepted = resolve(&channel, &token, &args.id, args.tag.as_deref()).await?;
    let repository = args.repository;
    let (branch, imported) = import(&channel, &token, &accepted, &repository).await?;
    println!(
        "{}",
        json!({
            "task_id": accepted.task_id,
            "tag_id": accepted.tag_id,
            "session_id": accepted.session_id,
            "repository": repository,
            "branch": branch,
            "head_commit": accepted.delivery.head_commit,
            "result": imported.as_str(),
        })
    );
    Ok(())
}

/// A Task's accepted delivery, else the named Session's latest one.
async fn resolve(
    channel: &ProtocolChannel,
    token: &str,
    id: &str,
    tag: Option<&str>,
) -> Result<Accepted> {
    let mut operator = OperatorClient::new(channel.clone())
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    if tag.is_none() {
        match operator
            .get_task(request(GetTaskRequest { task_id: id.into() }, token)?)
            .await
        {
            Ok(task) => {
                let task = task.into_inner();
                let succeeded = task.state() == TaskState::Succeeded;
                let delivery = task.workspace_delivery.with_context(|| {
                    if succeeded {
                        format!("Task {id} has no Workspace delivery")
                    } else {
                        format!("Task {id} has not delivered Workspace commits")
                    }
                })?;
                return Ok(Accepted {
                    task_id: task.task_id,
                    tag_id: task.tag_id,
                    session_id: task.session_id,
                    delivery,
                });
            }
            Err(status) if status.code() == Code::NotFound => {}
            Err(status) => return Err(status.into()),
        }
    }
    let found = operator
        .get_session_delivery(request(
            GetSessionDeliveryRequest {
                session_id: id.into(),
                tag_id: tag.unwrap_or_default().into(),
            },
            token,
        )?)
        .await
        .map_err(|status| {
            if status.code() == Code::NotFound {
                anyhow::anyhow!("no Task or Session {id} has delivered Workspace commits")
            } else {
                status.into()
            }
        })?
        .into_inner();
    Ok(Accepted {
        task_id: found.task_id,
        tag_id: found.tag_id,
        session_id: found.session_id,
        delivery: found
            .delivery
            .context("Session delivery has no Workspace delivery")?,
    })
}

/// Download the accepted bundle, verify it against the accepted receipt, and import it.
async fn import(
    channel: &ProtocolChannel,
    token: &str,
    accepted: &Accepted,
    repository: &Path,
) -> Result<(String, Imported)> {
    let delivery = &accepted.delivery;
    validate_workspace_delivery(delivery)?;
    ensure!(
        delivery.head_commit != delivery.base_commit,
        "Task {} delivered no commits",
        accepted.task_id
    );
    let blob = delivery.bundle.as_ref().context("delivery has no bundle")?;
    let staging = tempfile::tempdir()?;
    let path = staging.path().join("delivery.bundle");
    let mut client = TransfersClient::new(channel.clone())
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let mut upstream = request(
        GetWorkspaceArtifactRequest {
            task_id: accepted.task_id.clone(),
            kind: WorkspaceArtifactKind::Bundle as i32,
        },
        token,
    )?;
    upstream.set_timeout(Duration::from_secs(120));
    let mut stream = client
        .download_workspace_artifact(upstream)
        .await?
        .into_inner();
    match stream.message().await?.and_then(|message| message.part) {
        Some(workspace_download::Part::Reference(reference)) if &reference == delivery => {}
        Some(workspace_download::Part::Reference(_)) => {
            bail!("downloaded bundle belongs to a different delivery")
        }
        _ => bail!("workspace download did not include a receipt"),
    }
    let mut file = std::fs::File::create_new(&path)?;
    let mut size = 0u64;
    let mut digest = Sha256::new();
    while let Some(message) = stream.message().await? {
        let Some(workspace_download::Part::Chunk(chunk)) = message.part else {
            bail!("unexpected workspace download record");
        };
        size += chunk.len() as u64;
        ensure!(
            !chunk.is_empty()
                && chunk.len() <= CHECKPOINT_CHUNK_BYTES
                && size <= blob.byte_length
                && size <= MAX_WORKSPACE_BLOB_BYTES as u64,
            "bundle exceeds its receipt"
        );
        digest.update(&chunk);
        file.write_all(&chunk)?;
    }
    ensure!(
        size == blob.byte_length && format!("{:x}", digest.finalize()) == blob.sha256,
        "bundle differs from its receipt"
    );
    file.sync_all()?;
    drop(file);
    let branch = supertag_protocol::session_branch(&accepted.tag_id, &accepted.session_id);
    let imported = session_branch::import(
        repository,
        &SessionDelivery {
            branch: branch.clone(),
            delivery_id: delivery.delivery_id.clone(),
            base_commit: delivery.base_commit.clone(),
            start_commit: delivery.start_commit.clone(),
            head_commit: delivery.head_commit.clone(),
            bundle_sha256: blob.sha256.clone(),
            bundle_byte_length: blob.byte_length,
        },
        &path,
        &CancellationToken::new(),
    )
    .await?;
    Ok((branch, imported))
}

/// Where the local supervisor imports deliveries: each mapped Workspace whose delivery is
/// `branch`, by Workspace ID.
pub type Repositories = BTreeMap<String, PathBuf>;

const STATE: &str = "session-branches.json";

/// Follow Task changes on the local Control Plane and import each succeeded Task's delivery
/// into the repository mapped for its Workspace. The resume token survives restarts, so a
/// delivery made while the supervisor was stopped is imported when it starts again.
pub async fn follow(
    endpoint: String,
    token: String,
    directory: PathBuf,
    repositories: Repositories,
    log: impl Fn(&str) + Send + Sync + 'static,
) {
    let mut resume = read_resume(&directory).unwrap_or_default();
    // Deliveries already in their branch; a Task's later changes need no second download.
    let mut imported = HashSet::new();
    let mut delay = Duration::from_millis(250);
    loop {
        let result: Result<()> = async {
            // The stream is long lived; each call on the channel sets its own deadline.
            let channel = crate::network::operator_channel(
                &crate::network::endpoint_with_timeout(
                    endpoint.clone(),
                    false,
                    Duration::from_secs(u32::MAX as u64),
                )
                .await?,
            )
            .await?;
            let mut stream = OperatorEventsClient::new(channel.clone())
                .watch(supertag_protocol::authenticated_request(
                    WatchRequest {
                        resume_token: resume.clone(),
                        kinds: vec![WatchKind::Task as i32],
                    },
                    &token,
                    None,
                )?)
                .await?
                .into_inner();
            while let Some(event) = stream.message().await? {
                delay = Duration::from_millis(250);
                match event.update {
                    Some(Update::Change(change)) => {
                        if let Err(error) = import_task(
                            &channel,
                            &token,
                            &change.id,
                            &repositories,
                            &mut imported,
                            &log,
                        )
                        .await
                        {
                            log(&format!(
                                "Session branch for Task {} was not imported: {error:#}. Run supertag fetch {} after fixing it",
                                change.id, change.id
                            ));
                        }
                    }
                    Some(Update::Resync(_)) => log(
                        "Session branch import missed Task changes; run supertag fetch for any Task whose branch is missing",
                    ),
                    _ => {}
                }
                if event.resume_token == resume {
                    continue;
                }
                resume = event.resume_token;
                if let Err(error) = write_resume(&directory, &resume) {
                    log(&format!("Session branch import state was not saved: {error:#}"));
                }
            }
            Ok(())
        }
        .await;
        if let Err(error) = result
            && let Some(status) = error.downcast_ref::<tonic::Status>()
            && status.code() == Code::InvalidArgument
        {
            // A resume token from another Control Plane database starts over.
            resume.clear();
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(Duration::from_secs(5));
    }
}

async fn import_task(
    channel: &ProtocolChannel,
    token: &str,
    task_id: &str,
    repositories: &Repositories,
    imported: &mut HashSet<String>,
    log: &(impl Fn(&str) + Send + Sync),
) -> Result<()> {
    let mut operator = OperatorClient::new(channel.clone())
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let task = match operator
        .get_task(request(
            GetTaskRequest {
                task_id: task_id.into(),
            },
            token,
        )?)
        .await
    {
        Ok(task) => task.into_inner(),
        Err(status) if status.code() == Code::NotFound => return Ok(()),
        Err(status) => return Err(status.into()),
    };
    let Some(delivery) = task.workspace_delivery.clone() else {
        return Ok(());
    };
    let Some(repository) = repositories.get(&delivery.workspace_id) else {
        return Ok(());
    };
    // A GitHub Workspace delivers by pull request instead.
    if task.state() != TaskState::Succeeded
        || delivery.head_commit == delivery.base_commit
        || task
            .workspace
            .as_ref()
            .is_some_and(|workspace| workspace.github_source.is_some())
        || imported.contains(&delivery.delivery_id)
    {
        return Ok(());
    }
    let accepted = Accepted {
        task_id: task.task_id,
        tag_id: task.tag_id,
        session_id: task.session_id,
        delivery,
    };
    let (branch, outcome) = import(channel, token, &accepted, repository).await?;
    imported.insert(accepted.delivery.delivery_id.clone());
    if outcome != Imported::Current {
        log(&format!(
            "Task {} delivered {} to branch {branch} in {}",
            accepted.task_id,
            accepted.delivery.head_commit,
            repository.display()
        ));
    }
    Ok(())
}

fn read_resume(directory: &Path) -> Option<String> {
    let bytes = std::fs::read(directory.join(STATE)).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    value["resume_token"].as_str().map(str::to_owned)
}

fn write_resume(directory: &Path, resume: &str) -> Result<()> {
    crate::local::write_private(
        directory,
        STATE,
        json!({ "resume_token": resume }).to_string().as_bytes(),
    )
}
