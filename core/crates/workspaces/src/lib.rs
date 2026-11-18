//! Local Git workspaces and immutable delivery evidence.
//!
//! The host state directory must be outside the adapter's writable sandbox. A
//! caller must stop the adapter before finalization. No method promotes a Session
//! head: the Control Plane chooses a verified delivery's commit as the next pin.

pub mod artifact_volumes;
pub mod base_ref;
pub mod devcontainer;
mod git;
mod lock;
pub mod packages;
mod paths;
pub mod session_branch;
pub mod setup;
pub mod source;
mod transfer;
pub use git::MissingPrerequisite;
pub use lock::ExclusiveLock;
pub use transfer::{
    PreparedExport, TransferArtifact, materialize_returned_files, verify_return_excludes,
};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tempfile::NamedTempFile;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

/// Freeze the bytes of one selected regular file in an owned checkout.
pub fn capture_artifact_file(root: &Path, path: &str, maximum: usize) -> Result<Vec<u8>> {
    paths::read_artifact_file(root, path, maximum)
}

pub fn write_acquired_files(root: &Path, path: &str, files: &[(String, Vec<u8>)]) -> Result<()> {
    paths::write_acquired_files(root, path, files)
}

pub fn create_output_directory(root: &Path, path: &str) -> Result<()> {
    paths::create_output_directory(root, path)
}

pub fn list_output_files(root: &Path, path: &str, max_files: usize) -> Result<Vec<String>> {
    paths::list_selected_output_files(root, &[path.to_owned()], max_files, &|_| true)
}

pub fn prepare_declared_output_directory(root: &Path, path: &str) -> Result<()> {
    paths::prepare_declared_output_directory(root, path)
}

pub fn list_selected_output_files(
    root: &Path,
    roots: &[String],
    max_files: usize,
    include: &impl Fn(&str) -> bool,
) -> Result<Vec<String>> {
    paths::list_selected_output_files(root, roots, max_files, include)
}

pub fn remove_output_directory(root: &Path, path: &str) -> Result<()> {
    paths::remove_output_directory(root, path)
}

pub async fn tracked_output_paths(
    checkout: &Checkout,
    selected: &[String],
    cancel: &CancellationToken,
) -> Result<BTreeSet<String>> {
    if selected.is_empty() {
        return Ok(BTreeSet::new());
    }
    git::Repository::tracked_outputs(
        &checkout.path,
        checkout.start_commit.len(),
        selected,
        cancel,
    )
    .await
}

pub struct GitOutputFiles {
    pub head_commit: String,
    pub tracked: Vec<String>,
    pub deleted: Vec<String>,
    committed: BTreeMap<String, String>,
}

impl GitOutputFiles {
    pub fn matches_commit(&self, path: &str, content: &[u8]) -> bool {
        self.committed
            .get(path)
            .is_some_and(|oid| git::blob_oid(content, oid.len()) == *oid)
    }
}

pub async fn git_output_files(
    checkout: &Checkout,
    selected: &[String],
    permits: impl Fn(&str) -> bool,
    maximum: usize,
    cancel: &CancellationToken,
) -> Result<GitOutputFiles> {
    git::Repository::output_files(checkout, selected, permits, maximum, false, cancel).await
}

/// Remote providers return files only. Their starting commit is the only
/// verifiable Git HEAD, and their output bytes come from the returned tree.
pub async fn prepared_git_output_files(
    checkout: &Checkout,
    selected: &[String],
    permits: impl Fn(&str) -> bool,
    maximum: usize,
    cancel: &CancellationToken,
) -> Result<GitOutputFiles> {
    git::Repository::output_files(checkout, selected, permits, maximum, true, cancel).await
}

pub async fn advertised_output_remote(
    source: &Path,
    disposable: &Path,
    commit: &str,
    cancel: &CancellationToken,
) -> Result<Option<String>> {
    git::advertised_output_remote(source, disposable, commit, cancel).await
}

/// Paths the checkout changed since its start commit, sorted, at most `maximum` of them, and
/// whether more were changed. Git metadata and paths `keep` rejects are never counted.
pub async fn changed_paths(
    checkout: &Checkout,
    keep: impl Fn(&str) -> bool,
    maximum: usize,
    cancel: &CancellationToken,
) -> Result<(Vec<String>, bool)> {
    let paths = git::Repository::changed_paths(checkout, keep, cancel).await?;
    let truncated = paths.len() > maximum;
    Ok((paths.into_iter().take(maximum).collect(), truncated))
}

/// The pinned commit identifies the tracked paths the provider received at Stage.
pub async fn prepared_tracked_paths(
    checkout: &Checkout,
    cancel: &CancellationToken,
) -> Result<BTreeSet<String>> {
    git::Repository::prepared_tracked_outputs(checkout, cancel).await
}

#[derive(Clone, Debug)]
pub struct WorkspaceConfig {
    pub state_dir: PathBuf,
    pub source: PathBuf,
    /// A full immutable SHA-1 or SHA-256 commit ID, never a moving branch name.
    pub base_commit: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PrepareRequest {
    pub task_id: String,
    pub attempt_id: String,
    pub session_id: String,
    /// Explicit Control Plane continuation pin. Required after a Session's first Task.
    pub expected_head: Option<String>,
    /// The Workspace's operator-chosen setup command; see [`setup`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup: Option<String>,
    /// A merge follow-up: the commit to merge into the checkout. The checkout starts with the
    /// merge already made, conflict markers left in conflicting files, and the Task's commit gets
    /// this commit as its second parent. The commit must already be in this Workspace's
    /// repository ([`Workspace::import_merge_bundle`] or [`Workspace::import_source_commit`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_commit: Option<String>,
    /// Who the Task's commit names as its author; SuperTag's own identity when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<CommitAuthor>,
}

/// A commit's author and committer, and a person credited with a `Co-authored-by` trailer.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct CommitAuthor {
    pub name: String,
    pub email: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub co_author: String,
}

/// A merge a merge follow-up's checkout starts with.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct PreparedMerge {
    commit: String,
    /// Files the merge left with conflict markers.
    conflicts: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Checkout {
    pub path: PathBuf,
    pub task_id: String,
    pub attempt_id: String,
    pub session_id: String,
    pub base_commit: String,
    pub start_commit: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct FinalizeRequest {
    pub summary: String,
    pub outcome: Outcome,
    #[serde(default)]
    pub output_directory: Option<String>,
    /// The Task's path scope. A completed Attempt that changed a path outside it is not
    /// delivered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_scope: Option<supertag_protocol::file_scope::Rules>,
}

/// A completed Attempt changed Workspace paths its path scope does not allow. The Attempt fails
/// with this message, which names the paths.
#[derive(Debug)]
pub struct ScopeViolation {
    /// Each path and why it is refused, in path order.
    pub paths: Vec<(String, String)>,
}

impl std::fmt::Display for ScopeViolation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        const SHOWN: usize = 20;
        write!(
            formatter,
            "The Task changed files outside its path scope, so its changes were not delivered: "
        )?;
        let named: Vec<String> = self
            .paths
            .iter()
            .take(SHOWN)
            .map(|(path, reason)| format!("{path} ({reason})"))
            .collect();
        write!(formatter, "{}", named.join(", "))?;
        if self.paths.len() > SHOWN {
            write!(formatter, ", and {} more", self.paths.len() - SHOWN)?;
        }
        Ok(())
    }
}

impl std::error::Error for ScopeViolation {}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Delivery {
    pub delivery_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub session_id: String,
    pub base_commit: String,
    pub start_commit: String,
    pub head_commit: String,
    pub committed: bool,
    pub changed_files: u64,
    pub outcome: Outcome,
    pub patch_path: PathBuf,
    pub patch_sha256: String,
    pub bundle_path: PathBuf,
    pub bundle_sha256: String,
}

#[derive(Clone)]
pub struct Workspace {
    inner: Arc<Inner>,
}

struct Inner {
    config: ConfigRecord,
    root: PathBuf,
    _lock: ExclusiveLock,
    gate: Mutex<()>,
}

#[derive(Deserialize, Serialize, PartialEq, Eq)]
struct ConfigRecord {
    source: PathBuf,
    base_commit: String,
}

#[derive(Deserialize, Serialize)]
struct Preparation {
    request: PrepareRequest,
    checkout: Checkout,
    commit_seconds: u64,
    ready: bool,
    /// Setup outputs copied into the checkout. Git ignores them, so finalization skips them.
    #[serde(default)]
    setup_outputs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    merge: Option<PreparedMerge>,
}

/// A Session's last delivered checkout, kept for its next Attempt on this host.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct ParkedCheckout {
    session_id: String,
    /// The delivered head the files hold, which the next Attempt must start from.
    head_commit: String,
    /// The commit the parked Attempt started from: its trusted packs hold everything it reaches.
    start_commit: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    setup: Option<String>,
    #[serde(default)]
    setup_outputs: Vec<String>,
}

#[derive(Deserialize, Serialize)]
struct Finalization {
    request: FinalizeRequest,
    delivery: Delivery,
}

impl Workspace {
    pub fn open(config: WorkspaceConfig) -> Result<Self> {
        git::validate_oid(&config.base_commit)?;
        let source = config
            .source
            .canonicalize()
            .context("find local source repository")?;
        ensure!(source.is_dir(), "source repository is not a directory");
        let root = paths::planned_path(&config.state_dir)?;
        ensure!(
            !root.starts_with(&source) && !source.starts_with(&root),
            "workspace state and source repository must be separate directories"
        );
        paths::create_private_root(&root)?;
        Self::open_recorded(
            root,
            ConfigRecord {
                source,
                base_commit: config.base_commit,
            },
        )
    }

    /// Reopen host-owned state without consulting its original source repository.
    /// This permits terminal cleanup and receipt inspection after source removal.
    pub fn open_existing(state_dir: &Path) -> Result<Self> {
        let root = paths::planned_path(state_dir)?;
        paths::verify_directory(&root)?;
        let record: ConfigRecord = read_json(&root.join("config.json"))?
            .context("workspace state has no configuration")?;
        git::validate_oid(&record.base_commit)?;
        Self::open_recorded(root, record)
    }

    fn open_recorded(root: PathBuf, record: ConfigRecord) -> Result<Self> {
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(root.join("workspace.lock"))?;
        let lock = ExclusiveLock::try_acquire(lock)
            .context("another process owns this workspace state directory")?;
        let config_path = root.join("config.json");
        match read_json::<ConfigRecord>(&config_path)? {
            Some(prior) => ensure!(
                prior == record,
                "workspace state belongs to a different repository or base pin"
            ),
            None => atomic_json(&config_path, &record)?,
        }
        for name in [
            "records",
            "sessions",
            "checkouts",
            "artifacts",
            "temporary",
            "mcp",
            PARKED,
            TRUSTED,
            DISCARDED,
        ] {
            paths::create_private_root(&root.join(name))?;
        }
        Ok(Self {
            inner: Arc::new(Inner {
                config: record,
                root,
                _lock: lock,
                gate: Mutex::new(()),
            }),
        })
    }

    pub async fn prepare(
        &self,
        request: PrepareRequest,
        cancel: &CancellationToken,
    ) -> Result<Checkout> {
        check_cancelled(cancel)?;
        let _guard = self.inner.gate.lock().await;
        check_cancelled(cancel)?;
        for value in [&request.task_id, &request.attempt_id, &request.session_id] {
            validate_identity(value)?;
        }
        if let Some(pin) = &request.expected_head {
            git::validate_oid(pin)?;
            ensure!(
                pin.len() == self.inner.config.base_commit.len(),
                "continuation hash format differs from base"
            );
        }
        let id = identity(&request.task_id, &request.attempt_id);
        let record_dir = self.inner.root.join("records").join(&id);
        paths::create_private_root(&record_dir)?;
        let record_path = record_dir.join("prepare.json");
        if let Some(prior) = read_json::<Preparation>(&record_path)? {
            ensure!(
                prior.request == request,
                "Task Attempt was prepared with a different request"
            );
            if prior.ready {
                transfer::require_restored(&record_dir)?;
                paths::verify_directory(&prior.checkout.path)?;
                return Ok(prior.checkout);
            }
        }
        let session_path = self
            .inner
            .root
            .join("sessions")
            .join(format!("{}.json", sha256(request.session_id.as_bytes())));
        if let Some(first_task) = read_json::<String>(&session_path)? {
            ensure!(
                request.expected_head.is_some() || first_task == request.task_id,
                "a Session continuation requires its explicit accepted head commit"
            );
        }
        let repository = self.repository(cancel).await?;
        let start = request
            .expected_head
            .clone()
            .unwrap_or_else(|| self.inner.config.base_commit.clone());
        repository.verify_commit(&start, cancel).await?;
        repository
            .assert_ancestor(&self.inner.config.base_commit, &start, cancel)
            .await?;
        let checkout = Checkout {
            path: self.inner.root.join("checkouts").join(&id),
            task_id: request.task_id.clone(),
            attempt_id: request.attempt_id.clone(),
            session_id: request.session_id.clone(),
            base_commit: self.inner.config.base_commit.clone(),
            start_commit: start.clone(),
        };
        let mut preparation = match read_json::<Preparation>(&record_path)? {
            Some(value) => value,
            None => Preparation {
                request: request.clone(),
                checkout: checkout.clone(),
                commit_seconds: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
                ready: false,
                setup_outputs: Vec::new(),
                merge: None,
            },
        };
        atomic_json(&record_path, &preparation)?;
        if fs::symlink_metadata(&checkout.path).is_ok() {
            paths::remove_owned_directory(&checkout.path)?;
        }
        let trusted = self.inner.root.join(TRUSTED).join(&id);
        if fs::symlink_metadata(&trusted).is_ok() {
            paths::remove_owned_directory(&trusted)?;
        }
        // A merge follow-up's checkout holds the merge, with conflict markers left in place.
        let (merged_tree, merge) = match &request.merge_commit {
            None => (None, None),
            Some(commit) => {
                git::validate_oid(commit)?;
                repository.verify_commit(commit, cancel).await?;
                let (tree, conflicts) = repository.merge_tree(&start, commit, cancel).await?;
                (
                    Some(tree),
                    Some(PreparedMerge {
                        commit: commit.clone(),
                        conflicts,
                    }),
                )
            }
        };
        let entries = repository
            .tree(merged_tree.as_deref().unwrap_or(&start), cancel)
            .await?;
        for entry in entries.values() {
            paths::validate_repo_path(&entry.path)?;
            ensure!(
                entry.mode != "160000",
                "submodules require an explicit workspace implementation"
            );
        }
        // The Session's previous checkout on this host, if it holds exactly where this Attempt
        // starts, is moved here instead of written again.
        let reused = match &merge {
            None => {
                self.reuse_parked(
                    &repository,
                    &request,
                    (&checkout, &start, &trusted),
                    &entries,
                    cancel,
                )
                .await
            }
            Some(_) => None,
        };
        // Setup runs in this checkout on the base commit, so its outputs keep their paths.
        let held = match &request.setup {
            _ if reused.is_some() => None,
            None => None,
            Some(command) => Some(
                setup::run(
                    &repository,
                    &checkout.path,
                    &self.inner.config.base_commit,
                    command,
                    &record_dir.join("setup"),
                    cancel,
                )
                .await?,
            ),
        };
        if reused.is_none() {
            repository
                .checkout(
                    &checkout.path,
                    (&self.inner.config.base_commit, &start),
                    merged_tree.as_deref(),
                    &entries,
                    cancel,
                )
                .await?;
            // The objects SuperTag wrote, kept before the harness can write the checkout's `.git`,
            // so a next Attempt reusing this checkout need not pack them again.
            paths::create_private_root(&trusted)?;
            git::copy_packs(&checkout.path.join(".git/objects/pack"), &trusted)?;
        }
        preparation.merge = merge;
        preparation.setup_outputs = match held {
            None => reused.unwrap_or_default(),
            Some(held) => {
                let copied = held.restore(&checkout.path, cancel)?;
                // Only what Git ignores at the Task's commit stays, so setup never changes a
                // delivery.
                let ignored = repository
                    .ignored(&checkout.path, &start, &copied, cancel)
                    .await?;
                for output in copied.iter().filter(|output| !ignored.contains(*output)) {
                    let path = checkout.path.join(output);
                    if fs::symlink_metadata(&path)?.is_dir() {
                        paths::remove_owned_directory(&path)?;
                    } else {
                        fs::remove_file(&path)?;
                    }
                }
                ignored.into_iter().collect()
            }
        };
        paths::sync_tree_off_runtime(checkout.path.clone()).await?;
        File::open(checkout.path.parent().expect("checkout parent"))?.sync_all()?;
        check_cancelled(cancel)?;
        preparation.ready = true;
        atomic_json(&record_path, &preparation)?;
        if read_json::<String>(&session_path)?.is_none() {
            atomic_json(&session_path, &request.task_id)?;
        }
        Ok(checkout)
    }

    pub async fn finalize(
        &self,
        checkout: &Checkout,
        request: FinalizeRequest,
        cancel: &CancellationToken,
    ) -> Result<Delivery> {
        check_cancelled(cancel)?;
        let _guard = self.inner.gate.lock().await;
        check_cancelled(cancel)?;
        ensure!(
            request.summary.len() <= 262_144,
            "result summary exceeds its size limit"
        );
        let id = identity(&checkout.task_id, &checkout.attempt_id);
        let record_dir = self.inner.root.join("records").join(&id);
        let prior: Preparation = read_json(&record_dir.join("prepare.json"))?
            .context("Task Attempt has no workspace preparation")?;
        ensure!(
            prior.ready && prior.checkout == *checkout,
            "checkout differs from the accepted preparation"
        );
        if let Some(finalized) = read_json::<Finalization>(&record_dir.join("finalize.json"))? {
            ensure!(
                finalized.request == request,
                "Task Attempt was finalized with a different result"
            );
            self.verify_delivery(&finalized.delivery)?;
            return Ok(finalized.delivery);
        }
        transfer::require_restored(&record_dir)?;
        paths::verify_directory(&checkout.path)?;
        let repository = self.repository(cancel).await?;
        let base_tree = repository.tree(&checkout.start_commit, cancel).await?;
        let all_files = paths::scan_skipping(&checkout.path, &prior.setup_outputs, cancel)?;
        let output_prefix = request
            .output_directory
            .as_ref()
            .map(|directory| format!("{directory}/"));
        let untracked: Vec<_> = all_files
            .keys()
            .filter(|name| !base_tree.contains_key(*name))
            .cloned()
            .collect();
        let ignored = repository
            .ignored(&checkout.path, &checkout.start_commit, &untracked, cancel)
            .await?;
        let scope = request
            .file_scope
            .as_ref()
            .filter(|rules| request.outcome == Outcome::Completed && !rules.is_empty());
        if let Some(rules) = scope {
            // Capture refuses a file with other links, but this names the path and why.
            hidden_links(rules, &checkout.path, &all_files, &ignored)?;
        }
        let captured: Vec<String> = all_files
            .keys()
            .filter(|path| {
                // Ignored files, and new files in the output directory, are not delivered.
                let new_output = output_prefix
                    .as_ref()
                    .is_some_and(|prefix| path.starts_with(prefix))
                    && !base_tree.contains_key(*path);
                !ignored.contains(*path) && !new_output
            })
            .cloned()
            .collect();
        // Every file is read and hashed on several threads; only a changed file's bytes are kept,
        // to be written as a blob. Most of a turn's files are unchanged.
        let hashed = {
            let (root, oid_length, cancel) = (
                checkout.path.clone(),
                self.inner.config.base_commit.len(),
                cancel.clone(),
            );
            let known: BTreeMap<String, String> = base_tree
                .iter()
                .map(|(path, entry)| (path.clone(), entry.oid.clone()))
                .collect();
            tokio::task::spawn_blocking(move || {
                // The capture limit holds across the workers, so a huge Workspace stops early
                // instead of being read whole.
                let total = std::sync::atomic::AtomicUsize::new(0);
                let chunk = captured.len().div_ceil(git::parallelism()).max(1);
                std::thread::scope(|scope| {
                    let workers: Vec<_> = captured
                        .chunks(chunk)
                        .map(|part| {
                            let (root, known, cancel, total) = (&root, &known, &cancel, &total);
                            scope.spawn(move || -> Result<Vec<_>> {
                                let mut out = Vec::with_capacity(part.len());
                                for path in part {
                                    check_cancelled(cancel)?;
                                    let file = paths::read_checkout_file(root, path)?;
                                    let size = file.bytes.len();
                                    ensure!(
                                        total.fetch_add(size, std::sync::atomic::Ordering::Relaxed)
                                            + size
                                            <= CAPTURE_LIMIT,
                                        "workspace capture exceeds 256 MiB"
                                    );
                                    let oid = git::blob_oid(&file.bytes, oid_length);
                                    let changed = known.get(path) != Some(&oid);
                                    out.push((
                                        path.clone(),
                                        file.mode,
                                        oid,
                                        size,
                                        changed.then_some(file.bytes),
                                    ));
                                }
                                Ok(out)
                            })
                        })
                        .collect();
                    workers.into_iter().try_fold(Vec::new(), |mut all, worker| {
                        all.extend(
                            worker
                                .join()
                                .map_err(|_| anyhow::anyhow!("workspace capture stopped"))??,
                        );
                        anyhow::Ok(all)
                    })
                })
            })
            .await
            .context("workspace capture stopped")??
        };
        let mut entries = BTreeMap::new();
        let mut captured_bytes = 0_usize;
        for (path, mode, oid, size, changed) in hashed {
            check_cancelled(cancel)?;
            captured_bytes = captured_bytes
                .checked_add(size)
                .context("workspace size overflow")?;
            ensure!(
                captured_bytes <= CAPTURE_LIMIT,
                "workspace capture exceeds 256 MiB"
            );
            if let Some(bytes) = changed {
                ensure!(
                    repository.write_blob(&bytes, cancel).await? == oid,
                    "Git returned an unexpected blob identity"
                );
            }
            entries.insert(path.clone(), git::TreeEntry { path, mode, oid });
        }
        if let Some(rules) = scope {
            check_scope(rules, (&base_tree, &entries))?;
        }
        if let Some(merge) = prior
            .merge
            .as_ref()
            .filter(|_| request.outcome == Outcome::Completed)
        {
            // Never deliver a merge whose conflicts were left unresolved.
            let unresolved: Vec<&str> = merge
                .conflicts
                .iter()
                .filter(|path| {
                    paths::read_checkout_file(&checkout.path, path).is_ok_and(|file| {
                        file.bytes.split(|byte| *byte == b'\n').any(|line| {
                            line.starts_with(b"<<<<<<< ") || line.starts_with(b">>>>>>> ")
                        })
                    })
                })
                .map(String::as_str)
                .collect();
            ensure!(
                unresolved.is_empty(),
                "conflict markers remain in {}; resolve every conflict before finishing",
                unresolved.join(", ")
            );
        }
        let tree = repository.write_tree(&entries, cancel).await?;
        let original_tree = repository.tree_oid(&checkout.start_commit, cancel).await?;
        let committed = tree != original_tree || prior.merge.is_some();
        let mut parents = vec![checkout.start_commit.as_str()];
        if let Some(merge) = &prior.merge {
            parents.push(merge.commit.as_str());
        }
        let head = if committed {
            repository
                .commit(
                    &tree,
                    &parents,
                    &commit_message(&request.summary, prior.request.author.as_ref()),
                    prior.request.author.as_ref(),
                    prior.commit_seconds,
                    cancel,
                )
                .await?
        } else {
            checkout.start_commit.clone()
        };
        repository
            .assert_ancestor(&checkout.start_commit, &head, cancel)
            .await?;
        ensure!(
            repository.tree_oid(&head, cancel).await? == tree,
            "captured commit does not match the verified tree"
        );
        let patch = repository
            .patch(&checkout.start_commit, &head, cancel)
            .await?;
        let changed_files = base_tree
            .keys()
            .chain(entries.keys())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .filter(|path| base_tree.get(*path) != entries.get(*path))
            .count() as u64;
        let staging = tempfile::Builder::new()
            .prefix("delivery-")
            .tempdir_in(self.inner.root.join("temporary"))?;
        let patch_file = staging.path().join("changes.patch");
        write_synced(&patch_file, &patch)?;
        let bundle_file = staging.path().join("changes.bundle");
        repository
            .delivery_bundle(&checkout.start_commit, &head, &id, &bundle_file, cancel)
            .await?;
        repository.sync()?;
        let bundle_sha256 = hash_file(&bundle_file)?;
        File::open(&bundle_file)?.sync_all()?;
        File::open(staging.path())?.sync_all()?;
        check_cancelled(cancel)?;
        let artifacts = self.inner.root.join("artifacts").join(&id);
        if fs::symlink_metadata(&artifacts).is_ok() {
            paths::remove_owned_directory(&artifacts)?;
        }
        fs::rename(staging.path(), &artifacts)?;
        File::open(artifacts.parent().expect("artifact parent"))?.sync_all()?;
        let delivery = Delivery {
            delivery_id: id,
            task_id: checkout.task_id.clone(),
            attempt_id: checkout.attempt_id.clone(),
            session_id: checkout.session_id.clone(),
            base_commit: checkout.base_commit.clone(),
            start_commit: checkout.start_commit.clone(),
            head_commit: head,
            committed,
            changed_files,
            outcome: request.outcome,
            patch_path: artifacts.join("changes.patch"),
            patch_sha256: sha256(&patch),
            bundle_path: artifacts.join("changes.bundle"),
            bundle_sha256,
        };
        atomic_json(
            &record_dir.join("finalize.json"),
            &Finalization {
                request,
                delivery: delivery.clone(),
            },
        )?;
        Ok(delivery)
    }

    pub fn delivery(&self, task_id: &str, attempt_id: &str) -> Result<Option<Delivery>> {
        validate_identity(task_id)?;
        validate_identity(attempt_id)?;
        let path = self
            .inner
            .root
            .join("records")
            .join(identity(task_id, attempt_id))
            .join("finalize.json");
        read_json::<Finalization>(&path)?
            .map(|record| {
                self.verify_delivery(&record.delivery)?;
                Ok(record.delivery)
            })
            .transpose()
    }

    pub fn verify_delivery(&self, delivery: &Delivery) -> Result<()> {
        let expected = identity(&delivery.task_id, &delivery.attempt_id);
        ensure!(
            delivery.delivery_id == expected,
            "delivery identity differs from Task Attempt"
        );
        let root = self.inner.root.join("artifacts").join(expected);
        ensure!(
            delivery.patch_path == root.join("changes.patch")
                && delivery.bundle_path == root.join("changes.bundle"),
            "delivery paths leave the artifact directory"
        );
        let preparation: Preparation = read_json(
            &self
                .inner
                .root
                .join("records")
                .join(&delivery.delivery_id)
                .join("prepare.json"),
        )?
        .context("delivery has no accepted preparation")?;
        ensure!(
            delivery.session_id == preparation.checkout.session_id
                && delivery.base_commit == preparation.checkout.base_commit
                && delivery.start_commit == preparation.checkout.start_commit,
            "delivery pins differ from the accepted preparation"
        );
        git::validate_oid(&delivery.head_commit)?;
        ensure!(
            hash_file(&delivery.patch_path)? == delivery.patch_sha256,
            "delivery patch digest differs from its receipt"
        );
        let bundle = paths::read_regular(&delivery.bundle_path, 268_435_456)?;
        ensure!(
            sha256(&bundle) == delivery.bundle_sha256,
            "delivery bundle digest differs from its receipt"
        );
        verify_bundle_head(
            &bundle,
            &delivery.head_commit,
            &format!("refs/heads/supertag-deliveries/{}", delivery.delivery_id),
        )?;
        Ok(())
    }

    /// Import only objects from a Control Plane-approved delivery. An imported head
    /// becomes executable only when a later accepted Task explicitly pins it.
    /// Whether this host's repository already holds `head`, a commit that contains the
    /// Workspace's base, so a continuation that ends at it needs no bundle. Git names a commit
    /// by its content, so the commit held is the one approved.
    pub async fn holds_commit(&self, head: &str, cancel: &CancellationToken) -> bool {
        if git::validate_oid(head).is_err() || check_cancelled(cancel).is_err() {
            return false;
        }
        let _guard = self.inner.gate.lock().await;
        let Ok(repository) = self.repository(cancel).await else {
            return false;
        };
        repository
            .assert_ancestor(&self.inner.config.base_commit, head, cancel)
            .await
            .is_ok()
    }

    /// Imports a delivery's bundle. `start` is the delivery's start commit from its approved
    /// receipt: an incremental bundle may build on it when this host holds it, and fails with
    /// [`MissingPrerequisite`] when it does not.
    pub async fn import_bundle(
        &self,
        bundle_path: &Path,
        expected_sha256: &str,
        expected_head: &str,
        start: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<()> {
        check_cancelled(cancel)?;
        let _guard = self.inner.gate.lock().await;
        git::validate_oid(expected_head)?;
        ensure!(
            expected_sha256.len() == 64
                && expected_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "invalid expected bundle digest"
        );
        let bytes = paths::read_regular(bundle_path, 268_435_456)?;
        ensure!(
            sha256(&bytes) == expected_sha256,
            "import bundle digest differs from its approved receipt"
        );
        check_cancelled(cancel)?;
        let mut copy = NamedTempFile::new_in(self.inner.root.join("temporary"))?;
        copy.write_all(&bytes)?;
        copy.flush()?;
        let repository = self.repository(cancel).await?;
        repository
            .import_bundle(copy.path(), expected_head, start, cancel)
            .await?;
        repository
            .assert_ancestor(&self.inner.config.base_commit, expected_head, cancel)
            .await?;
        repository.sync()?;
        Ok(())
    }

    /// Imports a merge follow-up's commit from a verified, complete bundle. Unlike a continuation,
    /// the commit need not descend from the Workspace's base: it is another branch's head.
    pub async fn import_merge_bundle(
        &self,
        bundle_path: &Path,
        expected_sha256: &str,
        expected_head: &str,
        cancel: &CancellationToken,
    ) -> Result<()> {
        check_cancelled(cancel)?;
        let _guard = self.inner.gate.lock().await;
        git::validate_oid(expected_head)?;
        let bytes = paths::read_regular(bundle_path, 268_435_456)?;
        ensure!(
            sha256(&bytes) == expected_sha256,
            "merge bundle digest differs from its receipt"
        );
        let mut copy = NamedTempFile::new_in(self.inner.root.join("temporary"))?;
        copy.write_all(&bytes)?;
        copy.flush()?;
        let repository = self.repository(cancel).await?;
        repository
            .import_bundle(copy.path(), expected_head, None, cancel)
            .await?;
        repository.sync()?;
        Ok(())
    }

    /// Copies a merge follow-up's commit, and only its history, from this Workspace's local
    /// source repository.
    pub async fn import_source_commit(
        &self,
        commit: &str,
        cancel: &CancellationToken,
    ) -> Result<()> {
        check_cancelled(cancel)?;
        let _guard = self.inner.gate.lock().await;
        git::validate_oid(commit)?;
        let repository = self.repository(cancel).await?;
        repository
            .import_from_source(&self.inner.config.source, commit, cancel)
            .await?;
        repository.sync()?;
        Ok(())
    }

    /// Materializes the base commit, exactly as pinned, in a Worker-owned directory outside every
    /// Task checkout, and returns it. A Workspace MCP server is read from and runs in it, so
    /// nothing the harness writes in its checkout changes what the Worker Host launches. Each call
    /// recreates the snapshot from Git objects.
    pub async fn mcp_snapshot(
        &self,
        task_id: &str,
        attempt_id: &str,
        cancel: &CancellationToken,
    ) -> Result<PathBuf> {
        check_cancelled(cancel)?;
        let _guard = self.inner.gate.lock().await;
        validate_identity(task_id)?;
        validate_identity(attempt_id)?;
        let path = self.mcp_snapshot_path(task_id, attempt_id);
        if fs::symlink_metadata(&path).is_ok() {
            paths::remove_owned_directory(&path)?;
        }
        let repository = self.repository(cancel).await?;
        let base = &self.inner.config.base_commit;
        let entries = repository.tree(base, cancel).await?;
        repository
            .checkout(&path, (base, base), None, &entries, cancel)
            .await?;
        paths::sync_tree_off_runtime(path.clone()).await?;
        Ok(path)
    }

    /// The devcontainer subset at the base commit, read as data from the private repository.
    /// Nothing is checked out and no repository command runs on the Worker Host.
    pub async fn trusted_devcontainer(
        &self,
        cancel: &CancellationToken,
    ) -> Result<Option<devcontainer::DevcontainerSubset>> {
        check_cancelled(cancel)?;
        let _guard = self.inner.gate.lock().await;
        let repository = self.repository(cancel).await?.path().to_owned();
        let base = self.inner.config.base_commit.clone();
        tokio::task::spawn_blocking(move || {
            devcontainer::read_trusted_devcontainer(&repository, &base)
        })
        .await
        .context("devcontainer read stopped")?
    }

    /// Removes an Attempt's MCP snapshot, if any.
    pub fn remove_mcp_snapshot(&self, task_id: &str, attempt_id: &str) -> Result<()> {
        let path = self.mcp_snapshot_path(task_id, attempt_id);
        if fs::symlink_metadata(&path).is_ok() {
            paths::remove_owned_directory(&path)?;
        }
        Ok(())
    }

    fn mcp_snapshot_path(&self, task_id: &str, attempt_id: &str) -> PathBuf {
        self.inner
            .root
            .join("mcp")
            .join(identity(task_id, attempt_id))
    }

    /// Remove only a finalized working copy. Immutable delivery artifacts remain available.
    pub fn remove_checkout(&self, checkout: &Checkout) -> Result<()> {
        self.remove_checkout_inner(checkout, true)
    }

    /// Discard an exact prepared checkout after execution has stopped and its
    /// owning Host has obtained terminal settlement or an audited recovery receipt.
    /// The caller owns that authority check; uncertain running work must be retained.
    /// Delivery artifacts and all preparation/finalization records are preserved.
    pub fn discard_checkout(&self, checkout: &Checkout) -> Result<()> {
        self.remove_checkout_inner(checkout, false)
    }

    fn remove_checkout_inner(&self, checkout: &Checkout, require_delivery: bool) -> Result<()> {
        let _guard = self
            .inner
            .gate
            .try_lock()
            .context("workspace operation is in progress")?;
        let id = identity(&checkout.task_id, &checkout.attempt_id);
        ensure!(
            checkout.path == self.inner.root.join("checkouts").join(&id)
                && checkout.base_commit == self.inner.config.base_commit,
            "checkout does not belong to this workspace state"
        );
        let prepared: Preparation = read_json(
            &self
                .inner
                .root
                .join("records")
                .join(&id)
                .join("prepare.json"),
        )?
        .context("Task Attempt has no workspace preparation")?;
        ensure!(
            prepared.checkout == *checkout,
            "checkout differs from the accepted preparation"
        );
        ensure!(
            !require_delivery
                || self
                    .delivery(&checkout.task_id, &checkout.attempt_id)?
                    .is_some(),
            "cannot remove a checkout before its delivery receipt is durable"
        );
        let discarded = self.inner.root.join(DISCARDED);
        match fs::symlink_metadata(&checkout.path) {
            Ok(_) => {
                paths::verify_directory(&checkout.path)?;
                discard(&checkout.path, &discarded)?;
                File::open(checkout.path.parent().expect("checkout parent"))?.sync_all()?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let trusted = self.inner.root.join(TRUSTED).join(&id);
        if fs::symlink_metadata(&trusted).is_ok() {
            paths::verify_directory(&trusted)?;
            discard(&trusted, &discarded)?;
        }
        transfer::discard_staging(&self.inner.root.join("records").join(id), &discarded)?;
        Ok(())
    }

    /// Ends a settled Attempt's checkout as [`Self::discard_checkout`] does, but keeps a completed
    /// Attempt's checkout for its Session's next Attempt on this host, which then starts without
    /// writing its files again. The checkout's `.git`, which the harness could write, is removed
    /// here; the next Attempt rebuilds it from packs SuperTag kept. At most [`MAX_PARKED`]
    /// Sessions keep one; the oldest is discarded.
    pub fn park_checkout(&self, checkout: &Checkout) -> Result<()> {
        if let Err(error) = self.park(checkout) {
            tracing::debug!("checkout was not kept for its Session: {error:#}");
        }
        self.discard_checkout(checkout)
    }

    fn park(&self, checkout: &Checkout) -> Result<()> {
        let _guard = self
            .inner
            .gate
            .try_lock()
            .context("workspace operation is in progress")?;
        let id = identity(&checkout.task_id, &checkout.attempt_id);
        ensure!(
            checkout.path == self.inner.root.join("checkouts").join(&id)
                && checkout.base_commit == self.inner.config.base_commit,
            "checkout does not belong to this workspace state"
        );
        let record_dir = self.inner.root.join("records").join(&id);
        let prepared: Preparation = read_json(&record_dir.join("prepare.json"))?
            .context("Task Attempt has no workspace preparation")?;
        ensure!(
            prepared.ready && prepared.checkout == *checkout,
            "checkout differs from the accepted preparation"
        );
        let finalized: Finalization = read_json(&record_dir.join("finalize.json"))?
            .context("only a delivered checkout is kept")?;
        ensure!(
            finalized.delivery.outcome == Outcome::Completed
                && finalized.delivery.start_commit == checkout.start_commit,
            "only a completed Attempt's checkout is kept"
        );
        let trusted = self.inner.root.join(TRUSTED).join(&id);
        paths::verify_directory(&trusted)?;
        paths::verify_directory(&checkout.path)?;
        let discarded = self.inner.root.join(DISCARDED);
        let parked = self.inner.root.join(PARKED);
        paths::verify_directory(&parked)?;
        let slot = parked.join(sha256(checkout.session_id.as_bytes()));
        if fs::symlink_metadata(&slot).is_ok() {
            paths::verify_directory(&slot)?;
            discard(&slot, &discarded)?;
        }
        let git = checkout.path.join(".git");
        if fs::symlink_metadata(&git).is_ok() {
            match fs::symlink_metadata(&git)?.is_dir() {
                true => discard(&git, &discarded)?,
                false => fs::remove_file(&git)?,
            }
        }
        paths::create_private_root(&slot)?;
        fs::rename(&checkout.path, slot.join("checkout"))?;
        fs::rename(&trusted, slot.join("packs"))?;
        atomic_json(
            &slot.join("parked.json"),
            &ParkedCheckout {
                session_id: checkout.session_id.clone(),
                head_commit: finalized.delivery.head_commit,
                start_commit: checkout.start_commit.clone(),
                setup: prepared.request.setup,
                setup_outputs: prepared.setup_outputs,
            },
        )?;
        File::open(&parked)?.sync_all()?;
        // Keep the most recently parked; a slot a crash left without its record goes first.
        let mut slots = Vec::new();
        for entry in fs::read_dir(&parked)? {
            let path = entry?.path();
            let parked_at = fs::metadata(path.join("parked.json"))
                .and_then(|metadata| metadata.modified())
                .ok();
            slots.push((parked_at, path));
        }
        slots.sort();
        let excess = slots.len().saturating_sub(MAX_PARKED);
        for (_, path) in slots.into_iter().take(excess) {
            paths::verify_directory(&path)?;
            discard(&path, &discarded)?;
        }
        Ok(())
    }

    /// Takes the Session's parked checkout into `checkout` when it holds exactly `start` and was
    /// prepared with the same setup command. Returns its setup outputs, or `None` when there is
    /// none to reuse or it failed verification; the caller then prepares a fresh checkout.
    async fn reuse_parked(
        &self,
        repository: &git::Repository,
        request: &PrepareRequest,
        (checkout, start, trusted): (&Checkout, &str, &Path),
        entries: &BTreeMap<String, git::TreeEntry>,
        cancel: &CancellationToken,
    ) -> Option<Vec<String>> {
        let slot = self
            .inner
            .root
            .join(PARKED)
            .join(sha256(request.session_id.as_bytes()));
        let taken = async {
            let Some(parked) = read_json::<ParkedCheckout>(&slot.join("parked.json"))? else {
                return Ok(None);
            };
            // Each reuse adds a pack; past a few dozen, Git reads slowly and a fresh checkout
            // starts over with one.
            if parked.session_id != request.session_id
                || parked.head_commit != start
                || parked.setup != request.setup
                || fs::read_dir(slot.join("packs"))?.count() > MAX_REUSED_PACK_FILES
            {
                return Ok(None);
            }
            // Taking it is final: a crash from here leaves no record, and the slot is discarded.
            fs::remove_file(slot.join("parked.json"))?;
            paths::verify_directory(&slot.join("checkout"))?;
            paths::verify_directory(&slot.join("packs"))?;
            fs::rename(slot.join("checkout"), &checkout.path)?;
            fs::rename(slot.join("packs"), trusted)?;
            fs::remove_dir(&slot)?;
            repository
                .reuse_checkout(
                    &checkout.path,
                    (&self.inner.config.base_commit, start, &parked.start_commit),
                    (trusted, &parked.setup_outputs),
                    entries,
                    cancel,
                )
                .await?;
            // This Attempt's trusted packs: the parked ones and the one just written.
            git::copy_packs(&checkout.path.join(".git/objects/pack"), trusted)?;
            anyhow::Ok(Some(parked.setup_outputs))
        }
        .await;
        match taken {
            Ok(reused) => reused,
            Err(error) => {
                tracing::debug!("the Session's previous checkout was not reused: {error:#}");
                let discarded = self.inner.root.join(DISCARDED);
                for path in [&slot, &checkout.path, &trusted.to_owned()] {
                    if fs::symlink_metadata(path).is_ok() {
                        let _ =
                            paths::verify_directory(path).and_then(|()| discard(path, &discarded));
                    }
                }
                None
            }
        }
    }

    async fn repository(&self, cancel: &CancellationToken) -> Result<git::Repository> {
        git::Repository::open(
            &self.inner.root,
            &self.inner.config.source,
            &self.inner.config.base_commit,
            cancel,
        )
        .await
    }
}

/// The complete bundle of a delivered commit from the Workspace state directory that holds it,
/// for a reader that lacks the delivery's start commit. Another process may own the state: this
/// only reads its repository. The bundle names the commit as the delivery's own ref, so it reads
/// as the delivery's bundle with its whole history.
pub async fn complete_delivery_bundle(
    state_dir: &Path,
    head: &str,
    delivery_id: &str,
    cancel: &CancellationToken,
) -> Result<Vec<u8>> {
    check_cancelled(cancel)?;
    git::validate_oid(head)?;
    ensure!(
        delivery_id.len() == 64
            && delivery_id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "invalid delivery ID"
    );
    let root = paths::planned_path(state_dir)?;
    paths::verify_directory(&root)?;
    let record: ConfigRecord =
        read_json(&root.join("config.json"))?.context("workspace state has no configuration")?;
    ensure!(
        record.base_commit.len() == head.len(),
        "delivered commit uses a different object format than the Workspace"
    );
    let repository = git::Repository::existing(&root, head.len())?;
    let bundle = repository
        .complete_bundle(
            head,
            &format!("refs/heads/supertag-deliveries/{delivery_id}"),
            cancel,
        )
        .await?;
    ensure!(
        bundle.len() <= 268_435_456,
        "complete delivery bundle exceeds its size limit"
    );
    Ok(bundle)
}

/// Where removed checkouts wait for `purge_discarded`, inside the workspace state directory.
const DISCARDED: &str = "discarded";
/// The most file bytes one delivery captures.
const CAPTURE_LIMIT: usize = 268_435_456;
/// Each Session's last delivered checkout, kept for its next Attempt.
const PARKED: &str = "parked";
/// The packs SuperTag wrote into each prepared checkout's `.git`, where its harness cannot write.
const TRUSTED: &str = "trusted";
/// How many Sessions keep a checkout in one workspace state directory.
const MAX_PARKED: usize = 8;
/// Pack, index and reverse-index files a reused checkout may carry: about 30 reuses.
const MAX_REUSED_PACK_FILES: usize = 96;

/// Moves an owned directory into `discarded` with one rename, so the caller does not wait for
/// its files to be deleted. A checkout of a large repository took seconds to delete, and the
/// Worker Host claimed its next Task only after it.
fn discard(directory: &Path, discarded: &Path) -> Result<()> {
    paths::verify_directory(discarded)?;
    let name = format!(
        "{}-{}",
        directory
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("directory"),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos())
    );
    fs::rename(directory, discarded.join(name))?;
    File::open(discarded)?.sync_all()?;
    Ok(())
}

/// Deletes what checkout removal moved aside in the workspace state directory `state_dir`.
/// Needs no workspace lock: nothing else reads or writes `discarded`, so a Worker Host runs this
/// in the background while it claims and prepares its next Task, and again at start for
/// anything a crash left. Two concurrent purges are harmless.
pub fn purge_discarded(state_dir: &Path) -> Result<()> {
    let discarded = paths::planned_path(state_dir)?.join(DISCARDED);
    let entries = match fs::read_dir(&discarded) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    paths::verify_directory(&discarded)?;
    for entry in entries {
        let path = entry?.path();
        let removed = match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                fs::remove_dir_all(&path)
            }
            Ok(_) => fs::remove_file(&path),
            Err(error) => Err(error),
        };
        match removed {
            Ok(()) => {}
            // Another purge got there first.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn identity(task_id: &str, attempt_id: &str) -> String {
    sha256(&serde_json::to_vec(&(task_id, attempt_id)).expect("string tuple serializes"))
}
fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn validate_identity(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control),
        "identity must contain 1–256 bytes without control characters"
    );
    Ok(())
}
fn check_cancelled(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        bail!("workspace operation cancelled");
    }
    Ok(())
}

/// The commit message: the subject, and the requester as a `Co-authored-by` trailer.
fn commit_message(summary: &str, author: Option<&CommitAuthor>) -> String {
    let subject = commit_subject(summary);
    match author.map(|author| author.co_author.as_str()) {
        Some(co_author) if !co_author.is_empty() && !co_author.chars().any(char::is_control) => {
            format!("{subject}\n\nCo-authored-by: {co_author}\n")
        }
        _ => subject,
    }
}

/// The result's first non-empty line, as the commit's subject.
fn commit_subject(summary: &str) -> String {
    let line = summary
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Capture workspace changes");
    without_link_targets(line)
        .chars()
        .filter(|ch| !ch.is_control())
        .take(72)
        .collect()
}

/// A Markdown link `[text](target)` as its text: harnesses link the files they changed to their
/// checkout's absolute path, which means nothing in the repository's history.
fn without_link_targets(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(open) = rest.find('[') {
        let after = &rest[open + 1..];
        let link = after.find("](").and_then(|close| {
            let target = &after[close + 2..];
            target
                .find(')')
                .map(|end| (&after[..close], &target[end + 1..]))
        });
        match link {
            Some((text, tail)) if !text.contains('[') => {
                out.push_str(&rest[..open]);
                out.push_str(text);
                rest = tail;
            }
            _ => {
                out.push_str(&rest[..=open]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    let bytes = match paths::read_regular(path, 1_048_576) {
        Ok(bytes) => bytes,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    Ok(Some(
        serde_json::from_slice(&bytes).context("invalid workspace journal")?,
    ))
}

fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().context("journal has no parent")?;
    paths::verify_directory(parent)?;
    let mut temporary = NamedTempFile::new_in(parent)?;
    serde_json::to_writer(temporary.as_file_mut(), value)?;
    temporary.flush()?;
    temporary.as_file().sync_all()?;
    temporary.persist(path)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn write_synced(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn hash_file(path: &Path) -> Result<String> {
    Ok(sha256(&paths::read_regular(path, 268_435_456)?))
}

fn verify_bundle_head(bytes: &[u8], head: &str, reference: &str) -> Result<()> {
    let end = bytes
        .windows(2)
        .position(|part| part == b"\n\n")
        .context("bundle has no complete header")?;
    ensure!(end <= 65_536, "bundle header exceeds its size limit");
    let header = std::str::from_utf8(&bytes[..end])?;
    let mut lines = header.lines();
    ensure!(
        matches!(lines.next(), Some("# v2 git bundle" | "# v3 git bundle")),
        "unsupported bundle header"
    );
    let expected = format!("{head} {reference}");
    // Capabilities (`@`) and prerequisites (`-`, checked when the bundle is imported) aside,
    // the header names exactly the delivered commit.
    let refs: Vec<_> = lines
        .filter(|line| !line.starts_with('@') && !line.starts_with('-'))
        .collect();
    ensure!(
        refs == [expected.as_str()],
        "bundle does not bind the delivered commit to its receipt"
    );
    Ok(())
}

/// Every added, modified, or deleted path a completed Attempt delivers must be writable in its
/// path scope.
fn check_scope(
    rules: &supertag_protocol::file_scope::Rules,
    (base, delivered): (
        &BTreeMap<String, git::TreeEntry>,
        &BTreeMap<String, git::TreeEntry>,
    ),
) -> Result<()> {
    let refused: Vec<(String, String)> = base
        .keys()
        .chain(delivered.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|path| base.get(*path) != delivered.get(*path))
        .filter_map(|path| {
            rules
                .write_denial(path)
                .map(|denial| (path.clone(), denial.describe().to_owned()))
        })
        .collect();
    if refused.is_empty() {
        Ok(())
    } else {
        Err(ScopeViolation { paths: refused }.into())
    }
}

/// No file the Attempt would deliver may be a hard link to a hidden file: the link would
/// deliver the hidden file's contents under a name the scope allows. Checkout files start with
/// one link each, so any such link is new.
fn hidden_links(
    rules: &supertag_protocol::file_scope::Rules,
    root: &Path,
    all_files: &BTreeMap<String, String>,
    ignored: &BTreeSet<String>,
) -> Result<()> {
    if rules.hidden.is_empty() {
        return Ok(());
    }
    let mut hidden = BTreeSet::new();
    let mut linked = vec![];
    for path in all_files.keys() {
        let Some((device, inode, links)) = paths::file_identity(root, path)? else {
            continue;
        };
        if rules.hidden(path) {
            hidden.insert((device, inode));
        } else if links > 1 && !ignored.contains(path) {
            linked.push((path, (device, inode)));
        }
    }
    let refused: Vec<(String, String)> = linked
        .into_iter()
        .filter(|(_, identity)| hidden.contains(identity))
        .map(|(path, _)| (path.clone(), "a hard link to a hidden file".to_owned()))
        .collect();
    if refused.is_empty() {
        Ok(())
    } else {
        Err(ScopeViolation { paths: refused }.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_subjects_keep_link_text_and_drop_checkout_paths() {
        assert_eq!(
            commit_subject(
                "Added `farewell(name)` to [app.py](/private/tmp/host/checkouts/9391/app.py), returning it."
            ),
            "Added `farewell(name)` to app.py, returning it."
        );
        assert_eq!(commit_subject("Fix a[0] and [b]"), "Fix a[0] and [b]");
        assert_eq!(commit_subject("[x](y"), "[x](y");
    }

    #[test]
    fn released_workspace_is_immediately_reopenable_while_children_spawn() -> Result<()> {
        let root = tempfile::tempdir()?;
        let source = root.path().join("source");
        fs::create_dir(&source)?;
        let config = || WorkspaceConfig {
            source: source.clone(),
            state_dir: root.path().join("state"),
            base_commit: "0".repeat(40),
        };
        lock::tests::while_children_spawn(|| {
            (0..2_000).try_for_each(|_| Workspace::open(config()).map(drop))
        })
    }
}
