//! Remote Workspace sources: pin a Session's branch to a commit, and fetch a pinned commit as a
//! verified bundle the Control Plane relays to the Worker Host. Hosts never fetch a remote.
use std::{collections::HashMap, path::Path, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request,
    negotiation::ProtocolChannel,
    v2::{
        ListPendingWorkspaceSourcesRequest, PinWorkspaceSourceRequest, Workspace,
        git_delivery_client::GitDeliveryClient, workspace_land,
    },
    valid_git_branch, valid_git_commit,
};
use supertag_workspaces::{TransferArtifact, source};
use tempfile::TempDir;
use tokio::time;
use tokio_util::sync::CancellationToken;
use tonic::Request;

use crate::{Access, GitDelivery, Session, git};

const LS_REMOTE_LIMIT: usize = 4 * 1024 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(90);
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
/// How often a Session's source is read before its Tasks fail, and how long apart.
const READ_ATTEMPTS: u32 = 6;
const RETRY_DELAY: Duration = Duration::from_secs(10);

/// A fetched source bundle and the private state that must outlive its download.
pub struct FetchedSource {
    pub bundle: TransferArtifact,
    pub directory: TempDir,
}

/// The refs a remote advertises, by name.
pub(crate) async fn list_refs(
    session: &Session,
    patterns: &[&str],
    symref: bool,
    cancel: &CancellationToken,
) -> Result<Vec<(String, String)>> {
    let mut command = session.command(session.directory.path());
    command.arg("ls-remote");
    if symref {
        command.arg("--symref");
    }
    command.arg("--").arg(&session.url);
    command.args(patterns);
    let output = git::run(
        command,
        session.directory.path(),
        cancel,
        LS_REMOTE_LIMIT,
        LIST_TIMEOUT,
    )
    .await?
    .require("reading the remote")?;
    let mut refs = Vec::new();
    for line in std::str::from_utf8(&output)?.lines() {
        if let Some(target) = line.strip_prefix("ref: ") {
            // `ref: refs/heads/main\tHEAD`: the default branch.
            if let Some((target, name)) = target.split_once('\t') {
                refs.push((format!("symref:{name}"), target.to_owned()));
            }
            continue;
        }
        if let Some((oid, name)) = line.split_once('\t')
            && valid_git_commit(oid)
        {
            refs.push((name.to_owned(), oid.to_owned()));
        }
    }
    Ok(refs)
}

/// Refuses a tree that stores files with Git LFS: its pointers are not the files.
pub(crate) async fn refuse_lfs(
    session: &Session,
    repository: &Path,
    commit: &str,
    cancel: &CancellationToken,
) -> Result<()> {
    let mut list = session.command(repository);
    list.args(["ls-tree", "-r", "-z", "--name-only", commit]);
    let names = git::run(list, repository, cancel, 64 * 1024 * 1024, LIST_TIMEOUT)
        .await?
        .require("listing the commit's files")?;
    for name in names.split(|byte| *byte == 0) {
        let Ok(name) = std::str::from_utf8(name) else {
            continue;
        };
        if name != ".gitattributes" && !name.ends_with("/.gitattributes") {
            continue;
        }
        let mut show = session.command(repository);
        show.args(["cat-file", "blob", &format!("{commit}:{name}")]);
        let attributes = git::run(show, repository, cancel, 1024 * 1024, LIST_TIMEOUT)
            .await?
            .require("reading .gitattributes")?;
        if String::from_utf8_lossy(&attributes).contains("filter=lfs") {
            bail!(
                "{name} stores files with Git LFS, which SuperTag does not support yet; keep large files in a Volume"
            );
        }
    }
    Ok(())
}

impl GitDelivery {
    /// The branch and commit a new Session of `workspace` starts from: its `ref`, or the
    /// remote's default branch.
    pub async fn resolve(
        &self,
        workspace: &Workspace,
        cancel: &CancellationToken,
    ) -> Result<(String, String)> {
        let remote = self.remote(workspace, Access::Read).await?;
        let session = self.session(&remote)?;
        if workspace.r#ref.is_empty() {
            let refs = list_refs(&session, &["HEAD"], true, cancel).await?;
            let branch = refs
                .iter()
                .find(|(name, _)| name == "symref:HEAD")
                .and_then(|(_, target)| target.strip_prefix("refs/heads/"))
                .context("the remote names no default branch; set the Workspace's ref")?
                .to_owned();
            let commit = refs
                .iter()
                .find(|(name, _)| name == "HEAD")
                .map(|(_, oid)| oid.clone())
                .context("the remote's default branch has no commit")?;
            ensure!(
                valid_git_branch(&branch),
                "the remote's default branch name is invalid"
            );
            return Ok((branch, commit));
        }
        let wanted = format!("refs/heads/{}", workspace.r#ref);
        let refs = list_refs(&session, &[wanted.as_str()], false, cancel).await?;
        let commit = refs
            .into_iter()
            .find(|(name, _)| *name == wanted)
            .map(|(_, oid)| oid)
            .with_context(|| format!("the remote has no branch {}", workspace.r#ref))?;
        Ok((workspace.r#ref.clone(), commit))
    }

    /// Fetches `commit` of `workspace` into private scratch and bundles exactly its history.
    pub async fn fetch(
        &self,
        workspace: &Workspace,
        commit: &str,
        cancel: &CancellationToken,
    ) -> Result<FetchedSource> {
        ensure!(valid_git_commit(commit), "invalid source commit");
        let remote = self.remote(workspace, Access::Read).await?;
        let session = self.session(&remote)?;
        let repository = session.directory.path().join("fetched.git");
        git::init_bare(&repository, cancel).await?;
        // Most servers serve only advertised refs, so fetch the branches the commit came from,
        // and ask for the commit itself only when neither holds it any more.
        let mut branches = Vec::new();
        for branch in [&workspace.resolved_ref, &workspace.r#ref] {
            if !branch.is_empty() && !branches.contains(branch) {
                branches.push(branch.clone());
            }
        }
        if let Some(workspace_land::Mode::Merge(merge)) =
            workspace.land.as_ref().and_then(|land| land.mode.as_ref())
        {
            branches.push(merge.target.clone());
        }
        let mut found = false;
        for branch in &branches {
            let mut fetch = session.command(&repository);
            fetch.args([
                "fetch",
                "--no-tags",
                "--no-auto-maintenance",
                "--no-recurse-submodules",
                "--no-write-fetch-head",
                "--quiet",
                "--",
                &session.url,
                &format!("+refs/heads/{branch}:refs/remotes/source/{branch}"),
            ]);
            // A branch that is gone is not an error: the next one, or the commit itself, may do.
            git::run(
                fetch,
                session.directory.path(),
                cancel,
                16_384,
                FETCH_TIMEOUT,
            )
            .await?;
            if has_commit(&session, &repository, commit, cancel).await? {
                found = true;
                break;
            }
        }
        if !found {
            let mut direct = session.command(&repository);
            direct.args([
                "fetch",
                "--no-tags",
                "--no-auto-maintenance",
                "--no-recurse-submodules",
                "--no-write-fetch-head",
                "--quiet",
                "--",
                &session.url,
                &format!("{commit}:refs/remotes/source/pinned"),
            ]);
            git::run(
                direct,
                session.directory.path(),
                cancel,
                16_384,
                FETCH_TIMEOUT,
            )
            .await?
            .require("fetching the source commit")?;
        }
        ensure!(
            has_commit(&session, &repository, commit, cancel).await?,
            "the remote no longer has commit {commit}"
        );
        refuse_lfs(&session, &repository, commit, cancel).await?;
        let bundle = source::capture(
            &session.directory.path().join("verified"),
            &repository,
            commit,
            cancel,
        )
        .await?;
        Ok(FetchedSource {
            bundle,
            directory: session.directory,
        })
    }

    /// The remote's URL when one of its branches or tags names `commit`.
    pub async fn advertised_output_remote(
        &self,
        workspace: &Workspace,
        commit: &str,
        cancel: &CancellationToken,
    ) -> Result<Option<String>> {
        ensure!(valid_git_commit(commit), "invalid output commit");
        let remote = self.remote(workspace, Access::Read).await?;
        let session = self.session(&remote)?;
        let refs = list_refs(&session, &[], false, cancel).await?;
        Ok(refs
            .iter()
            .any(|(_, oid)| oid == commit)
            .then(|| workspace.remote.clone()))
    }

    /// Pins each Session waiting for its source until `shutdown`. A source that still cannot be
    /// read after [`READ_ATTEMPTS`] tries, [`RETRY_DELAY`] apart, fails the Session's queued Tasks
    /// with the reason.
    pub async fn run_resolver(
        &self,
        channel: ProtocolChannel,
        token: String,
        principal: String,
        shutdown: CancellationToken,
    ) -> Result<()> {
        let client = GitDeliveryClient::new(channel)
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES);
        fn request<T>(value: T, token: &str, principal: &str) -> Result<Request<T>> {
            let mut request = authenticated_request(value, token, Some(principal))?;
            request.set_timeout(Duration::from_secs(5));
            Ok(request)
        }
        // Each failing pin's failures so far and when to try it again.
        let mut failures: HashMap<String, (u32, time::Instant)> = HashMap::new();
        let mut interval = time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => return Ok(()),
                _ = interval.tick() => {}
            }
            let mut after = 0;
            loop {
                let page = match client
                    .clone()
                    .list_pending_sources(request(
                        ListPendingWorkspaceSourcesRequest {
                            after_order: after,
                            limit: 50,
                        },
                        &token,
                        &principal,
                    )?)
                    .await
                {
                    Ok(page) => page.into_inner(),
                    Err(_) => break,
                };
                for pin in page.pins {
                    let Some(selector) = pin.selector.clone() else {
                        continue;
                    };
                    if failures
                        .get(&pin.pin_id)
                        .is_some_and(|(_, next)| *next > time::Instant::now())
                    {
                        continue;
                    }
                    let cancel = shutdown.child_token();
                    let resolved = time::timeout(LIST_TIMEOUT, self.resolve(&selector, &cancel))
                        .await
                        .unwrap_or_else(|_| Err(anyhow::anyhow!("reading the remote timed out")));
                    let input = match resolved {
                        Ok((branch, commit)) => {
                            failures.remove(&pin.pin_id);
                            PinWorkspaceSourceRequest {
                                pin_id: pin.pin_id.clone(),
                                selector_digest: pin.selector_digest.clone(),
                                resolved_ref: branch,
                                commit,
                                error: String::new(),
                            }
                        }
                        Err(error) => {
                            let (count, next) = failures
                                .entry(pin.pin_id.clone())
                                .or_insert((0, time::Instant::now()));
                            *count += 1;
                            *next = time::Instant::now() + RETRY_DELAY;
                            if *count < READ_ATTEMPTS {
                                continue;
                            }
                            failures.remove(&pin.pin_id);
                            PinWorkspaceSourceRequest {
                                pin_id: pin.pin_id.clone(),
                                selector_digest: pin.selector_digest.clone(),
                                error: format!("{error:#}"),
                                ..Default::default()
                            }
                        }
                    };
                    let _ = client
                        .clone()
                        .pin_source(request(input, &token, &principal)?)
                        .await;
                }
                if page.next_after_order == 0 {
                    break;
                }
                after = page.next_after_order;
            }
        }
    }
}

async fn has_commit(
    session: &Session,
    repository: &Path,
    commit: &str,
    cancel: &CancellationToken,
) -> Result<bool> {
    let mut check = session.command(repository);
    check.args(["cat-file", "-e", &format!("{commit}^{{commit}}")]);
    Ok(git::run(check, repository, cancel, 1024, LIST_TIMEOUT)
        .await?
        .success)
}
