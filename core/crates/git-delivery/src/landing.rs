//! Landing verified Session commits on a Workspace's remote, fast-forward only.
//!
//! `branch` pushes the Session's branch `supertag/session/ID`. `merge` also merges the Session
//! into the Workspace's target with a merge commit and pushes the target. `review` pushes the
//! branch and opens or updates its draft pull request through the review adapter. A conflict is
//! never resolved here: it is recorded, and the Control Plane gives the Session a follow-up Task.
use std::{path::Path, sync::Arc, time::Duration};

use anyhow::{Context, Result, ensure};
use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request,
    git_remote::{LANDING_HOLDER_OFFLINE, may_push},
    negotiation::ProtocolChannel,
    v2::{
        ClaimWorkspaceLandingRequest, ClaimWorkspaceLandingResponse, RecordWorkspaceLandingRequest,
        Workspace, WorkspaceCredentialNames, WorkspaceLanding, WorkspaceLandingLease,
        WorkspaceLandingMode, WorkspaceLandingState, WorkspacePullRequest,
        git_delivery_client::GitDeliveryClient,
    },
    valid_git_commit,
};
use supertag_workspaces::{TransferArtifact, source};
use tokio::time::{self, Instant};
use tokio_util::sync::CancellationToken;
use tonic::{Code, Request, Status};
use uuid::Uuid;

use crate::{Access, BundleReader, GitDelivery, Session, git, review::Reviewed, source::list_refs};

const PUSH_TIMEOUT: Duration = Duration::from_secs(120);
const GIT_TIMEOUT: Duration = Duration::from_secs(60);
/// How often a target that moved while it was being merged is merged again.
const MERGE_ATTEMPTS: usize = 3;

/// What a landing ended with, for the Control Plane's record.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Landed(String),
    /// Review mode: the Session's branch names the commit, and the pull request is open.
    Reviewed {
        commit: String,
        pull_request: WorkspacePullRequest,
    },
    Conflict {
        target_commit: String,
        conflicts: Vec<String>,
    },
    Held(String),
    Retry(String),
}

enum Pushed {
    Done,
    Rejected(String),
}

async fn push(
    session: &Session,
    repository: &Path,
    commit: &str,
    branch: &str,
    merge_target: Option<&str>,
    cancel: &CancellationToken,
) -> Result<Pushed> {
    // The ref allowlist holds on every backend, whatever the credential could do.
    ensure!(
        may_push(branch, merge_target),
        "git delivery refuses to push {branch}"
    );
    let mut command = session.command(repository);
    command
        .args(["push", "--porcelain", "--no-verify", "--", &session.url])
        .arg(format!("{commit}:refs/heads/{branch}"));
    let output = git::run(
        command,
        session.directory.path(),
        cancel,
        64 * 1024,
        PUSH_TIMEOUT,
    )
    .await?;
    if output.success {
        return Ok(Pushed::Done);
    }
    let printed = String::from_utf8_lossy(&output.stdout);
    if let Some(line) = printed.lines().find(|line| line.starts_with('!')) {
        let reason = line.rsplit('\t').next().unwrap_or("rejected").to_owned();
        return Ok(Pushed::Rejected(reason));
    }
    anyhow::bail!("pushing {branch} failed: {}", output.explanation())
}

async fn is_ancestor(
    session: &Session,
    repository: &Path,
    ancestor: &str,
    descendant: &str,
    cancel: &CancellationToken,
) -> Result<bool> {
    let mut command = session.command(repository);
    command.args(["merge-base", "--is-ancestor", ancestor, descendant]);
    let output = git::run(command, session.directory.path(), cancel, 1024, GIT_TIMEOUT).await?;
    match output.code {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => anyhow::bail!("comparing commits failed: {}", output.explanation()),
    }
}

fn merge_message(landing: &WorkspaceLanding) -> String {
    let mut message = format!(
        "Merge {} into {}\n\nSuperTag-Session: {}\nSuperTag-Task: {}\n",
        landing.branch, landing.target, landing.session_id, landing.task_id
    );
    if !landing.co_author.is_empty() {
        message.push_str(&format!("Co-authored-by: {}\n", landing.co_author));
    }
    message
}

impl GitDelivery {
    /// Lands `landing`, whose delivered commit is in `repository`, on its remote.
    pub async fn land(
        &self,
        landing: &WorkspaceLanding,
        credential: &str,
        bundle: &Path,
        cancel: &CancellationToken,
    ) -> Result<Outcome> {
        let delivery = landing
            .delivery
            .as_ref()
            .context("landing has no delivery")?;
        let head = delivery.head_commit.clone();
        ensure!(valid_git_commit(&head), "invalid delivered commit");
        let workspace = Workspace {
            remote: landing.remote.clone(),
            credentials: Some(WorkspaceCredentialNames {
                read: String::new(),
                push: credential.to_owned(),
            }),
            ..Default::default()
        };
        let remote = match self.remote(&workspace, Access::Push).await {
            Ok(remote) => remote,
            Err(error) => return Ok(Outcome::Held(format!("{error:#}"))),
        };
        let session = self.session(&remote)?;
        // The relayed bundle has no recorded digest: materializing it verifies it is complete
        // and holds exactly the delivered commit.
        let bytes = std::fs::read(bundle)?;
        let repository = source::materialize(
            &session.directory.path().join("delivered"),
            &TransferArtifact {
                // Every directory on the way is checked, so a platform alias such as macOS's
                // `/var` is resolved first.
                path: bundle.canonicalize()?,
                sha256: {
                    use sha2::Digest as _;
                    format!("{:x}", sha2::Sha256::digest(&bytes))
                },
                byte_length: bytes.len() as u64,
            },
            &head,
            cancel,
        )
        .await?;
        if let Err(error) = crate::source::refuse_lfs(&session, &repository, &head, cancel).await {
            return Ok(Outcome::Held(format!("{error:#}")));
        }
        match push(&session, &repository, &head, &landing.branch, None, cancel).await? {
            Pushed::Done => {}
            Pushed::Rejected(reason) => {
                return Ok(Outcome::Held(format!(
                    "the remote refused {} ({reason}); it was changed outside SuperTag, and SuperTag never force-pushes",
                    landing.branch
                )));
            }
        }
        match landing.mode() {
            WorkspaceLandingMode::Merge => {
                self.merge(landing, &session, &repository, &head, cancel)
                    .await
            }
            WorkspaceLandingMode::Review => {
                Ok(match self.review(landing, credential, &head).await? {
                    Reviewed::Done(pull_request) => Outcome::Reviewed {
                        commit: head,
                        pull_request,
                    },
                    Reviewed::Held(reason) => Outcome::Held(reason),
                })
            }
            _ => Ok(Outcome::Landed(head)),
        }
    }

    async fn merge(
        &self,
        landing: &WorkspaceLanding,
        session: &Session,
        repository: &Path,
        head: &str,
        cancel: &CancellationToken,
    ) -> Result<Outcome> {
        let target = landing.target.as_str();
        let target_ref = format!("refs/heads/{target}");
        for _ in 0..MERGE_ATTEMPTS {
            let refs = list_refs(session, &[target_ref.as_str()], false, cancel).await?;
            let Some(current) = refs
                .into_iter()
                .find(|(name, _)| *name == target_ref)
                .map(|(_, oid)| oid)
            else {
                // The first Session to land creates the target.
                match push(session, repository, head, target, Some(target), cancel).await? {
                    Pushed::Done => return Ok(Outcome::Landed(head.to_owned())),
                    Pushed::Rejected(_) => continue,
                }
            };
            let mut fetch = session.command(repository);
            fetch.args([
                "fetch",
                "--no-tags",
                "--no-auto-maintenance",
                "--no-recurse-submodules",
                "--no-write-fetch-head",
                "--quiet",
                "--",
                &session.url,
                &format!("+{target_ref}:refs/remotes/target"),
            ]);
            git::run(
                fetch,
                session.directory.path(),
                cancel,
                16_384,
                PUSH_TIMEOUT,
            )
            .await?
            .require(&format!("fetching {target}"))?;
            let mut resolve = session.command(repository);
            resolve.args(["rev-parse", "--verify", "refs/remotes/target^{commit}"]);
            let fetched = git::oid(
                &git::run(resolve, session.directory.path(), cancel, 1024, GIT_TIMEOUT)
                    .await?
                    .require("reading the target")?,
            )?;
            if fetched != current {
                continue;
            }
            if is_ancestor(session, repository, head, &current, cancel).await? {
                // Already merged, by an earlier attempt or by a person.
                return Ok(Outcome::Landed(current));
            }
            let mut merge = session.command(repository);
            merge.args([
                "merge-tree",
                "--write-tree",
                "-z",
                "--name-only",
                "--no-messages",
                &current,
                head,
            ]);
            let output = git::run(
                merge,
                session.directory.path(),
                cancel,
                4 * 1024 * 1024,
                GIT_TIMEOUT,
            )
            .await?;
            let mut fields = output.stdout.split(|byte| *byte == 0);
            let tree = fields.next().map(git::oid).transpose()?;
            match output.code {
                Some(0) => {}
                Some(1) => {
                    let conflicts: Vec<String> = fields
                        .map(|name| String::from_utf8_lossy(name).into_owned())
                        .take_while(|name| !name.is_empty())
                        .collect::<std::collections::BTreeSet<_>>()
                        .into_iter()
                        .take(100)
                        .collect();
                    ensure!(
                        !conflicts.is_empty(),
                        "the merge conflicted without naming files"
                    );
                    return Ok(Outcome::Conflict {
                        target_commit: current,
                        conflicts,
                    });
                }
                _ => anyhow::bail!("merging failed: {}", output.explanation()),
            }
            let tree = tree.context("the merge produced no tree")?;
            let mut commit = session.command(repository);
            commit
                .env("GIT_AUTHOR_NAME", &landing.author_name)
                .env("GIT_AUTHOR_EMAIL", &landing.author_email)
                .env("GIT_COMMITTER_NAME", &landing.author_name)
                .env("GIT_COMMITTER_EMAIL", &landing.author_email)
                .args([
                    "commit-tree",
                    &tree,
                    "-p",
                    &current,
                    "-p",
                    head,
                    "-m",
                    &merge_message(landing),
                ]);
            let merged = git::oid(
                &git::run(commit, session.directory.path(), cancel, 1024, GIT_TIMEOUT)
                    .await?
                    .require("recording the merge")?,
            )?;
            match push(session, repository, &merged, target, Some(target), cancel).await? {
                Pushed::Done => return Ok(Outcome::Landed(merged)),
                // The target moved since it was read: merge again.
                Pushed::Rejected(_) => continue,
            }
        }
        Ok(Outcome::Retry(format!(
            "{target} kept moving while the Session was merged into it; trying again later"
        )))
    }

    /// Claims and lands landings until `shutdown`.
    pub async fn run_landings(
        &self,
        channel: ProtocolChannel,
        token: String,
        principal: String,
        bundles: Arc<dyn BundleReader>,
        shutdown: CancellationToken,
    ) -> Result<()> {
        let runner = Runner {
            delivery: self.clone(),
            client: GitDeliveryClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
            token,
            principal,
            bundles,
        };
        let mut interval = time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => return Ok(()),
                _ = interval.tick() => {}
            }
            // Land everything claimable before waiting again.
            loop {
                let claim = match runner
                    .client
                    .clone()
                    .claim(runner.request(ClaimWorkspaceLandingRequest {
                        operation_id: Uuid::new_v4().to_string(),
                    })?)
                    .await
                {
                    Ok(claim) => claim.into_inner(),
                    Err(_) => break,
                };
                if claim.landing.is_none() {
                    break;
                }
                // Errors hold no credentials. The Control Plane keeps the landing until it is
                // recorded, and an expired claim is claimed again.
                let _ = runner.deliver(claim, shutdown.child_token()).await;
                if shutdown.is_cancelled() {
                    return Ok(());
                }
            }
        }
    }
}

struct Runner {
    delivery: GitDelivery,
    client: GitDeliveryClient<ProtocolChannel>,
    token: String,
    principal: String,
    bundles: Arc<dyn BundleReader>,
}

impl Runner {
    fn request<T>(&self, value: T) -> Result<Request<T>, Status> {
        let mut request = authenticated_request(value, &self.token, Some(&self.principal))?;
        request.set_timeout(Duration::from_secs(5));
        Ok(request)
    }

    async fn maintain(&self, lease: &WorkspaceLandingLease, mut until: Instant) -> Result<()> {
        loop {
            time::sleep_until((Instant::now() + Duration::from_secs(10)).min(until)).await;
            ensure!(Instant::now() < until, "landing authority expired");
            let started = Instant::now();
            match time::timeout_at(
                until,
                self.client.clone().renew(self.request(lease.clone())?),
            )
            .await
            {
                Ok(Ok(response)) => {
                    until = started + Duration::from_millis(response.into_inner().valid_for_ms);
                }
                Ok(Err(status))
                    if matches!(
                        status.code(),
                        Code::Unavailable | Code::Cancelled | Code::DeadlineExceeded
                    ) => {}
                Ok(Err(_)) => anyhow::bail!("landing authority revoked"),
                Err(_) => anyhow::bail!("landing authority expired"),
            }
        }
    }

    async fn deliver(
        &self,
        claim: ClaimWorkspaceLandingResponse,
        cancel: CancellationToken,
    ) -> Result<()> {
        let landing = claim.landing.clone().context("claim is empty")?;
        let lease = WorkspaceLandingLease {
            landing_id: landing.landing_id.clone(),
            lease_token: claim.lease_token.clone(),
        };
        let until = Instant::now() + Duration::from_millis(claim.valid_for_ms);
        let operation = self.attempt(&claim, &cancel);
        tokio::pin!(operation);
        let outcome = tokio::select! {
            outcome = &mut operation => outcome,
            result = self.maintain(&lease, until) => {
                cancel.cancel();
                return result;
            }
        };
        let outcome = outcome.unwrap_or_else(|error| Outcome::Retry(format!("{error:#}")));
        let mut record = RecordWorkspaceLandingRequest {
            lease: Some(lease),
            operation_id: Uuid::new_v4().to_string(),
            ..Default::default()
        };
        match outcome {
            Outcome::Landed(commit) => {
                record.state = WorkspaceLandingState::Landed as i32;
                record.landed_commit = commit;
            }
            Outcome::Reviewed {
                commit,
                pull_request,
            } => {
                record.state = WorkspaceLandingState::Landed as i32;
                record.landed_commit = commit;
                record.pull_request = Some(pull_request);
            }
            Outcome::Conflict {
                target_commit,
                conflicts,
            } => {
                record.state = WorkspaceLandingState::Conflict as i32;
                record.reason = format!(
                    "the Session's changes conflict with {} in {} file(s)",
                    landing.target,
                    conflicts.len()
                );
                record.target_commit = target_commit;
                record.conflicts = conflicts;
            }
            Outcome::Held(reason) => {
                record.state = WorkspaceLandingState::Held as i32;
                record.reason = bounded(&reason);
            }
            Outcome::Retry(reason) => {
                record.state = WorkspaceLandingState::Queued as i32;
                record.reason = bounded(&reason);
            }
        }
        self.client.clone().record(self.request(record)?).await?;
        Ok(())
    }

    async fn attempt(
        &self,
        claim: &ClaimWorkspaceLandingResponse,
        cancel: &CancellationToken,
    ) -> Result<Outcome> {
        let landing = claim.landing.as_ref().context("claim is empty")?;
        let delivery = landing
            .delivery
            .as_ref()
            .context("landing has no delivery")?;
        let Some(holder) = &claim.holder else {
            return Ok(Outcome::Retry(LANDING_HOLDER_OFFLINE.into()));
        };
        let scratch = tempfile::Builder::new()
            .prefix(crate::SCRATCH_PREFIX)
            .tempdir_in(&self.delivery.0.directory)?;
        let path = scratch.path().join("delivery.bundle");
        if let Err(error) = self.bundles.read(holder, delivery, &path).await {
            if error
                .downcast_ref::<Status>()
                .is_some_and(|status| status.code() == Code::Unavailable)
            {
                return Ok(Outcome::Retry(LANDING_HOLDER_OFFLINE.into()));
            }
            return Err(error.context("reading the delivered bundle"));
        }
        self.delivery
            .land(landing, &claim.credential, &path, cancel)
            .await
    }
}

fn bounded(reason: &str) -> String {
    reason
        .chars()
        .filter(|c| !c.is_control())
        .take(1900)
        .collect()
}
