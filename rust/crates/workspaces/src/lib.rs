//! Local Git workspaces and immutable delivery evidence.
//!
//! The host state directory must be outside the adapter's writable sandbox. A
//! caller must stop the adapter before finalization. No method promotes a Session
//! head: the Control Plane chooses a verified delivery's commit as the next pin.

pub mod devcontainer;
mod git;
mod lock;
pub mod packages;
mod paths;
pub mod session_branch;
pub mod source;
mod transfer;
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
}

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
            },
        };
        atomic_json(&record_path, &preparation)?;
        if fs::symlink_metadata(&checkout.path).is_ok() {
            paths::remove_owned_directory(&checkout.path)?;
        }
        let entries = repository.tree(&start, cancel).await?;
        for entry in entries.values() {
            paths::validate_repo_path(&entry.path)?;
            ensure!(
                entry.mode != "160000",
                "submodules require an explicit workspace implementation"
            );
        }
        repository
            .checkout(&checkout.path, &start, &entries, cancel)
            .await?;
        paths::sync_tree(&checkout.path)?;
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
        let all_files = paths::scan(&checkout.path, cancel)?;
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
        let mut entries = BTreeMap::new();
        let mut captured_bytes = 0_usize;
        for path in all_files.keys() {
            check_cancelled(cancel)?;
            if ignored.contains(path)
                || (output_prefix
                    .as_ref()
                    .is_some_and(|prefix| path.starts_with(prefix))
                    && !base_tree.contains_key(path))
            {
                continue;
            }
            let file = paths::read_checkout_file(&checkout.path, path)?;
            captured_bytes = captured_bytes
                .checked_add(file.bytes.len())
                .context("workspace size overflow")?;
            ensure!(
                captured_bytes <= 268_435_456,
                "workspace capture exceeds 256 MiB"
            );
            let oid = git::blob_oid(&file.bytes, self.inner.config.base_commit.len());
            if base_tree.get(path).is_none_or(|entry| entry.oid != oid) {
                ensure!(
                    repository.write_blob(&file.bytes, cancel).await? == oid,
                    "Git returned an unexpected blob identity"
                );
            }
            entries.insert(
                path.clone(),
                git::TreeEntry {
                    path: path.clone(),
                    mode: file.mode,
                    oid,
                },
            );
        }
        let tree = repository.write_tree(&entries, cancel).await?;
        let original_tree = repository.tree_oid(&checkout.start_commit, cancel).await?;
        let committed = tree != original_tree;
        let head = if committed {
            repository
                .commit(
                    &tree,
                    &checkout.start_commit,
                    &commit_subject(&request.summary),
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
        repository.bundle(&head, &id, &bundle_file, cancel).await?;
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
    pub async fn import_bundle(
        &self,
        bundle_path: &Path,
        expected_sha256: &str,
        expected_head: &str,
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
            .import_bundle(copy.path(), expected_head, cancel)
            .await?;
        repository
            .assert_ancestor(&self.inner.config.base_commit, expected_head, cancel)
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
        repository.checkout(&path, base, &entries, cancel).await?;
        paths::sync_tree(&path)?;
        Ok(path)
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
        match fs::symlink_metadata(&checkout.path) {
            Ok(_) => {
                paths::remove_owned_directory(&checkout.path)?;
                File::open(checkout.path.parent().expect("checkout parent"))?.sync_all()?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        transfer::discard_staging(&self.inner.root.join("records").join(id))?;
        Ok(())
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

fn commit_subject(summary: &str) -> String {
    let line = summary
        .lines()
        .rev()
        .find_map(|line| line.trim().strip_prefix("Change:"))
        .map(str::trim)
        .or_else(|| summary.lines().map(str::trim).find(|line| !line.is_empty()))
        .unwrap_or("Capture workspace changes");
    line.chars()
        .filter(|ch| !ch.is_control())
        .take(72)
        .collect()
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
    let refs: Vec<_> = lines.filter(|line| !line.starts_with('@')).collect();
    ensure!(
        refs == [expected.as_str()],
        "bundle does not bind the delivered commit to its receipt"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
