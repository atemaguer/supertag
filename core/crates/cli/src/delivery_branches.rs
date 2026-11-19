//! Local Workspaces' `land` beyond their Session branches: the supervisor follows each delivered
//! Task of a Workspace one of its Worker Hosts maps and runs the Workspace's `land`
//! ([`crate::local_landing`]).
//!
//! The Worker Host writes each Session branch `supertag/session/<id>` into the mapped repository
//! itself as the Task delivers, from its own copy of the commit; no delivery bytes pass through
//! the Control Plane. The supervisor only checks the branch holds the delivered commit.

use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        GetTaskRequest, TaskState, WatchKind, WatchRequest, operator_client::OperatorClient,
        operator_events_client::OperatorEventsClient, watch_event::Update,
    },
};
use tonic::Code;

use crate::request;

/// Whether `repository`'s branch `branch` holds `head`: the Worker Host writes each local
/// Session branch itself as the Task delivers.
async fn holds(repository: &Path, branch: &str, head: &str) -> Result<bool> {
    let output = tokio::process::Command::new("git")
        .current_dir(repository)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "merge-base",
            "--is-ancestor",
            "--",
        ])
        .arg(head)
        .arg(format!("refs/heads/{branch}"))
        .output()
        .await
        .context("run git")?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1 | 128) => Ok(false),
        _ => bail!(
            "git could not read {branch}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ),
    }
}

pub use crate::local_landing::LocalLanding;

/// Where the local supervisor lands deliveries: each mapped Workspace whose `land` is not
/// `patch`, by Workspace ID.
pub type Repositories = BTreeMap<String, LocalLanding>;

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
    let state = read_state(&directory);
    let mut resume = state.resume_token;
    let pending: crate::local_landing::Pending =
        std::sync::Arc::new(tokio::sync::Mutex::new(state.pending_merges));
    let log = std::sync::Arc::new(log);
    // Sessions of `merge` Workspaces whose work finishes later merge on their own schedule.
    let merges = repositories
        .values()
        .any(|landing| landing.merge.is_some())
        .then(|| {
            tokio::spawn(merge_loop(
                endpoint.clone(),
                token.clone(),
                directory.clone(),
                repositories.clone(),
                pending.clone(),
                log.clone(),
            ))
        });
    let _merges = merges.map(AbortOnDrop);
    // Deliveries already in their branch; a Task's later changes need no second download.
    let mut imported = HashSet::new();
    let mut delay = Duration::from_millis(250);
    loop {
        let result: Result<()> = async {
            // The stream is long lived; each call on the channel sets its own deadline.
            let channel = crate::network::operator_channel(
                &crate::network::endpoint_with_timeout(
                    endpoint.clone(),
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
                            (&repositories, &pending),
                            &mut imported,
                            &*log,
                        )
                        .await
                        {
                            log(&format!(
                                "Session branch for Task {} was not landed: {error:#}",
                                change.id
                            ));
                        }
                    }
                    Some(Update::Resync(_)) => log(
                        "Session landing missed Task changes; a Session's next delivery lands it",
                    ),
                    _ => {}
                }
                if event.resume_token == resume {
                    continue;
                }
                resume = event.resume_token;
                if let Err(error) = write_state(&directory, &resume, &*pending.lock().await) {
                    log(&format!(
                        "Session branch import state was not saved: {error:#}"
                    ));
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
    (repositories, pending): (&Repositories, &crate::local_landing::Pending),
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
    let Some(landing) = repositories.get(&delivery.workspace_id) else {
        return Ok(());
    };
    let repository = &landing.path;
    // A remote Workspace lands on its own remote instead.
    if task.state() != TaskState::Succeeded
        || delivery.head_commit == delivery.base_commit
        || task
            .workspace
            .as_ref()
            .is_some_and(|workspace| workspace.remote.is_some())
        || imported.contains(&delivery.delivery_id)
    {
        return Ok(());
    }
    let branch = supertag_protocol::session_branch(&task.tag_id, &task.session_id);
    ensure!(
        holds(repository, &branch, &delivery.head_commit).await?,
        "the Worklet did not write {} to branch {branch} in {}",
        delivery.head_commit,
        repository.display()
    );
    imported.insert(delivery.delivery_id.clone());
    crate::local_landing::imported(&task, &branch, landing, pending, log).await
}

struct AbortOnDrop(tokio::task::JoinHandle<()>);
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Merges each pending Session once its work is done, every few seconds.
async fn merge_loop(
    endpoint: String,
    token: String,
    directory: PathBuf,
    repositories: Repositories,
    pending: crate::local_landing::Pending,
    log: std::sync::Arc<impl Fn(&str) + Send + Sync + 'static>,
) {
    let mut interval = tokio::time::interval(Duration::from_secs(3));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        if pending.lock().await.is_empty() {
            continue;
        }
        let result: Result<bool> = async {
            let channel = crate::network::operator_channel(
                &crate::network::endpoint_with_timeout(endpoint.clone(), Duration::from_secs(30))
                    .await?,
            )
            .await?;
            crate::local_landing::merge_pending(&channel, &token, &repositories, &pending, &*log)
                .await
        }
        .await;
        match result {
            Ok(true) => {
                let resume = read_state(&directory).resume_token;
                if let Err(error) = write_state(&directory, &resume, &*pending.lock().await) {
                    log(&format!("Session merge state was not saved: {error:#}"));
                }
            }
            Ok(false) => {}
            Err(error) => log(&format!("Session merges were not checked: {error:#}")),
        }
    }
}

/// The supervisor's resume token and the Sessions waiting to be merged, across restarts.
#[derive(Default, serde::Deserialize, serde::Serialize)]
struct State {
    #[serde(default)]
    resume_token: String,
    #[serde(default)]
    pending_merges: BTreeMap<String, crate::local_landing::PendingMerge>,
}

fn read_state(directory: &Path) -> State {
    std::fs::read(directory.join(STATE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_state(
    directory: &Path,
    resume: &str,
    pending: &BTreeMap<String, crate::local_landing::PendingMerge>,
) -> Result<()> {
    crate::local::write_private(
        directory,
        STATE,
        &serde_json::to_vec(&State {
            resume_token: resume.to_owned(),
            pending_merges: pending.clone(),
        })?,
    )
}
