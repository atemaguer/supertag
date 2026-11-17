//! `land` for local Workspaces, run by the `supertag up` supervisor in the operator's own
//! repository with the machine's own git configuration:
//!
//! - `{push: REMOTE}` pushes each imported Session branch to that remote.
//! - `{merge: BRANCH}` merges a Session into that local branch once its work is reported done
//!   (its Work Session closed by its Tag, an operator, or its Objective), and again after a
//!   merge follow-up Task succeeds; with `push`, it pushes the branch.
//!
//! Like git delivery for remote Workspaces, it never rewrites history: branches move only
//! forward, nothing is force-pushed, and a conflict is never resolved here. The Session gets a
//! follow-up Task that merges the target and resolves it.
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    git_remote::{author_name, tag_author_email, valid_merge_target},
    negotiation::ProtocolChannel,
    v2::{
        GetTagRequest, GetWorkSessionRequest, ReturnLandingConflictRequest, Task,
        WorkSessionCloseReason, operator_client::OperatorClient,
        work_sessions_client::WorkSessionsClient,
        workspace_landings_client::WorkspaceLandingsClient,
    },
};
use tokio::{process::Command, sync::Mutex};

use crate::request;

/// A local Workspace's repository and where its Session changes land beyond it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalLanding {
    pub path: PathBuf,
    /// The local branch finished Sessions merge into.
    pub merge: Option<String>,
    /// The repository's remote that Session branches, or the merge branch, are pushed to.
    pub push: Option<String>,
}

impl LocalLanding {
    /// Session branches imported into `path`, and nothing more.
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            merge: None,
            push: None,
        }
    }
}

/// A Session whose delivery waits to be merged.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct PendingMerge {
    pub workspace_id: String,
    pub task_id: String,
    pub head_commit: String,
    pub branch: String,
    /// A merge follow-up's delivery merges at once; others wait for the Session to finish.
    pub ready: bool,
    /// Why the last attempt stopped, logged once.
    #[serde(default)]
    pub blocked: String,
}

/// Pending merges by `TAG_ID SESSION_ID`.
pub(crate) type Pending = Arc<Mutex<BTreeMap<String, PendingMerge>>>;

/// The user's own git, as their shell finds it, in `repository`: their configuration, remotes,
/// and credentials. Local operations run without hooks.
fn git(repository: &Path, local: bool) -> Command {
    let mut command = Command::new("git");
    command
        .current_dir(repository)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if local {
        command.args(["-c", "core.hooksPath=/dev/null"]);
    }
    command
}

async fn run(mut command: Command) -> Result<(Option<i32>, String, String)> {
    let output = tokio::time::timeout(Duration::from_secs(300), command.output())
        .await
        .context("git timed out")?
        .context("run git")?;
    Ok((
        output.status.code(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).trim().to_owned(),
    ))
}

async fn checked(command: Command, what: &str) -> Result<String> {
    let (code, stdout, stderr) = run(command).await?;
    ensure!(code == Some(0), "{what} failed: {stderr}");
    Ok(stdout.trim().to_owned())
}

/// Pushes `branch` to `remote`, fast-forward only.
async fn push(repository: &Path, remote: &str, branch: &str) -> Result<()> {
    let mut command = git(repository, false);
    command
        .args(["push", "--porcelain", "--", remote])
        .arg(format!("refs/heads/{branch}:refs/heads/{branch}"));
    let (code, stdout, stderr) = run(command).await?;
    if code != Some(0) {
        if stdout.lines().any(|line| line.starts_with('!')) {
            bail!(
                "{remote} refused {branch}: it moved there outside SuperTag, and SuperTag never force-pushes"
            );
        }
        bail!("pushing {branch} to {remote} failed: {stderr}");
    }
    Ok(())
}

/// After a delivered Task's Session branch was imported: push it, or queue its merge.
pub(crate) async fn imported(
    task: &Task,
    branch: &str,
    landing: &LocalLanding,
    pending: &Pending,
    log: &(impl Fn(&str) + Send + Sync),
) -> Result<()> {
    let delivery = task
        .workspace_delivery
        .as_ref()
        .context("Task has no delivery")?;
    if let Some(remote) = &landing.push {
        push(&landing.path, remote, branch).await?;
        log(&format!(
            "Task {} pushed {branch} to {remote} from {}",
            task.task_id,
            landing.path.display()
        ));
    }
    if landing.merge.is_some() {
        let ready = task
            .workspace
            .as_ref()
            .is_some_and(|workspace| !workspace.merge_commit.is_empty());
        pending.lock().await.insert(
            format!("{} {}", task.tag_id, task.session_id),
            PendingMerge {
                workspace_id: delivery.workspace_id.clone(),
                task_id: task.task_id.clone(),
                head_commit: delivery.head_commit.clone(),
                branch: branch.to_owned(),
                ready,
                blocked: String::new(),
            },
        );
    }
    Ok(())
}

/// What one merge attempt ended with.
enum Merged {
    /// Not yet: the Session's work is still going on.
    Waiting,
    Done(String),
    Conflict(String, Vec<String>),
}

/// Tries every pending merge whose Session's work is done.
pub(crate) async fn merge_pending(
    channel: &ProtocolChannel,
    token: &str,
    repositories: &BTreeMap<String, LocalLanding>,
    pending: &Pending,
    log: &(impl Fn(&str) + Send + Sync),
) -> Result<bool> {
    let entries: Vec<(String, PendingMerge)> = pending
        .lock()
        .await
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let mut changed = false;
    for (key, entry) in entries {
        let Some(landing) = repositories.get(&entry.workspace_id) else {
            pending.lock().await.remove(&key);
            changed = true;
            continue;
        };
        let (tag_id, session_id) = key.split_once(' ').context("invalid pending merge")?;
        let outcome = merge_one(channel, token, landing, tag_id, session_id, &entry).await;
        let mut pending = pending.lock().await;
        // A newer delivery replaced this entry while it was being merged.
        if pending.get(&key) != Some(&entry) {
            continue;
        }
        changed = true;
        match outcome {
            Ok(Merged::Waiting) => {
                changed = false;
            }
            Ok(Merged::Done(target)) => {
                pending.remove(&key);
                log(&format!(
                    "Session {session_id} merged into {target} in {}",
                    landing.path.display()
                ));
            }
            Ok(Merged::Conflict(target, conflicts)) => {
                pending.remove(&key);
                log(&format!(
                    "Session {session_id} conflicts with {target} in {}; it received a follow-up Task to resolve them",
                    conflicts.join(", ")
                ));
            }
            Err(error) => {
                let reason = format!("{error:#}");
                let entry = pending.get_mut(&key).expect("present");
                if entry.blocked != reason {
                    log(&format!(
                        "Session {session_id} was not merged in {}: {reason}",
                        landing.path.display()
                    ));
                    entry.blocked = reason;
                } else {
                    changed = false;
                }
            }
        }
    }
    Ok(changed)
}

async fn merge_one(
    channel: &ProtocolChannel,
    token: &str,
    landing: &LocalLanding,
    tag_id: &str,
    session_id: &str,
    entry: &PendingMerge,
) -> Result<Merged> {
    let target = landing.merge.as_deref().context("no merge branch")?;
    ensure!(
        valid_merge_target(target),
        "{target} is not a branch SuperTag may merge into"
    );
    if !entry.ready && !done(channel, token, session_id).await? {
        return Ok(Merged::Waiting);
    }
    let repository = &landing.path;
    let head = &entry.head_commit;
    let target_ref = format!("refs/heads/{target}");
    let mut resolve = git(repository, true);
    resolve.args([
        "rev-parse",
        "--verify",
        "--quiet",
        &format!("{target_ref}^{{commit}}"),
    ]);
    let (code, current, _) = run(resolve).await?;
    let current = current.trim().to_owned();
    if code != Some(0) || current.is_empty() {
        // The first Session to land creates the branch.
        let mut create = git(repository, true);
        create.args(["update-ref", &target_ref, head, ""]);
        checked(create, &format!("creating {target}")).await?;
    } else {
        let mut ancestor = git(repository, true);
        ancestor.args(["merge-base", "--is-ancestor", head, &current]);
        if run(ancestor).await?.0 != Some(0) {
            let mut merge = git(repository, true);
            merge.args([
                "merge-tree",
                "--write-tree",
                "-z",
                "--name-only",
                "--no-messages",
                &current,
                head,
            ]);
            let (code, output, stderr) = run(merge).await?;
            let mut fields = output.split('\0');
            let tree = fields.next().unwrap_or_default().trim().to_owned();
            match code {
                Some(0) => {}
                Some(1) => {
                    let conflicts: Vec<String> = fields
                        .take_while(|name| !name.is_empty())
                        .map(str::to_owned)
                        .collect::<std::collections::BTreeSet<_>>()
                        .into_iter()
                        .take(100)
                        .collect();
                    ensure!(
                        !conflicts.is_empty(),
                        "the merge conflicted without naming files"
                    );
                    let mut client = WorkspaceLandingsClient::new(channel.clone())
                        .max_decoding_message_size(MAX_MESSAGE_BYTES)
                        .max_encoding_message_size(MAX_MESSAGE_BYTES);
                    client
                        .return_conflict(request(
                            ReturnLandingConflictRequest {
                                operation_id: format!("local-merge-{}-{current}", entry.task_id),
                                tag_id: tag_id.into(),
                                session_id: session_id.into(),
                                target: target.into(),
                                target_commit: current.clone(),
                                conflicts: conflicts.clone(),
                            },
                            token,
                        )?)
                        .await?;
                    return Ok(Merged::Conflict(target.into(), conflicts));
                }
                _ => bail!("merging into {target} failed: {stderr}"),
            }
            // The branch the operator has checked out is never moved under their work tree.
            let mut worktrees = git(repository, true);
            worktrees.args(["worktree", "list", "--porcelain"]);
            let listed = checked(worktrees, "listing work trees").await?;
            ensure!(
                !listed
                    .lines()
                    .any(|line| line == format!("branch {target_ref}")),
                "{target} is checked out; merge into a branch you do not have checked out"
            );
            let (name, email) = author(channel, token, tag_id).await?;
            let mut trailers = git(repository, true);
            trailers.args([
                "log",
                "-1",
                "--format=%(trailers:key=Co-authored-by,valueonly,separator=%x0A)",
                head,
            ]);
            let co_authors = checked(trailers, "reading the Session's co-authors").await?;
            let mut message = format!(
                "Merge {} into {target}\n\nSuperTag-Session: {session_id}\nSuperTag-Task: {}\n",
                entry.branch, entry.task_id
            );
            if let Some(co_author) = co_authors
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
            {
                message.push_str(&format!("Co-authored-by: {co_author}\n"));
            }
            let mut commit = git(repository, true);
            commit
                .env("GIT_AUTHOR_NAME", &name)
                .env("GIT_AUTHOR_EMAIL", &email)
                .env("GIT_COMMITTER_NAME", &name)
                .env("GIT_COMMITTER_EMAIL", &email)
                .args([
                    "commit-tree",
                    &tree,
                    "-p",
                    &current,
                    "-p",
                    head,
                    "-m",
                    &message,
                ]);
            let merged = checked(commit, "recording the merge").await?;
            let mut update = git(repository, true);
            update.args(["update-ref", &target_ref, &merged, &current]);
            checked(update, &format!("moving {target}")).await?;
        }
    }
    if let Some(remote) = &landing.push {
        push(repository, remote, &entry.branch).await?;
        push(repository, remote, target).await?;
    }
    Ok(Merged::Done(target.into()))
}

/// Whether the Session's work was reported done: its Work Session closed for its Tag, an
/// operator, or its Objective. A conversation's own Session never is.
async fn done(channel: &ProtocolChannel, token: &str, session_id: &str) -> Result<bool> {
    if !session_id.starts_with("work/") {
        return Ok(false);
    }
    let work = WorkSessionsClient::new(channel.clone())
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .get(request(
            GetWorkSessionRequest {
                work_session_id: session_id.into(),
                report_task_id: None,
            },
            token,
        )?)
        .await?
        .into_inner();
    Ok(work.closed_at_ms.is_some()
        && matches!(
            work.close_reason(),
            WorkSessionCloseReason::Tag
                | WorkSessionCloseReason::Operator
                | WorkSessionCloseReason::ObjectiveClosed
        ))
}

async fn author(channel: &ProtocolChannel, token: &str, tag_id: &str) -> Result<(String, String)> {
    let tag = OperatorClient::new(channel.clone())
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .get_tag(request(
            GetTagRequest {
                tag_id: tag_id.into(),
            },
            token,
        )?)
        .await?
        .into_inner();
    let name = if tag.name.is_empty() {
        tag_id.to_owned()
    } else {
        tag.name
    };
    Ok((author_name(&name), tag_author_email(tag_id)))
}
