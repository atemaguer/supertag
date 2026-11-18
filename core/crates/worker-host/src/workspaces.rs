//! Host-local repository mappings and independently captured delivery artifacts.
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use supertag_protocol::{
    CHECKPOINT_CHUNK_BYTES, MAX_MESSAGE_BYTES, MAX_WORKSPACE_BLOB_BYTES,
    v2::{transfers_client::TransfersClient, workspace_download, *},
    valid_workspace_id, validate_workspace_delivery,
};
use supertag_workspaces::{
    Checkout, Delivery, FinalizeRequest, Outcome, PrepareRequest, PreparedExport, TransferArtifact,
    Workspace, WorkspaceConfig,
};
use tempfile::NamedTempFile;
use tokio_util::sync::CancellationToken;
use tonic::Status;

use crate::{checkpoints::Transfers, journal::Attempt, request};

/// The only repository path accepted by a Host comes from its local configuration.
#[derive(Clone, Debug)]
pub struct WorkspaceMapping {
    pub workspace_id: String,
    pub source: WorkspaceSource,
    /// Shell command run in each new Task checkout on its base commit.
    pub setup: Option<String>,
}

impl WorkspaceMapping {
    pub(crate) fn local_root(&self) -> Option<&Path> {
        match &self.source {
            WorkspaceSource::Local(path) => Some(path),
            WorkspaceSource::ControlPlane => None,
        }
    }
}

#[derive(Clone, Debug)]
pub enum WorkspaceSource {
    Local(PathBuf),
    /// A remote Workspace whose source the Control Plane relays.
    ControlPlane,
}

/// Passed only to the adapter; it never contains the operator's source path.
pub const WORKSPACE_DIRECTORY: &str = "SUPERTAG_WORKSPACE_DIRECTORY";

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct PreparedWorkspace {
    pub workspace_id: String,
    pub checkout: Checkout,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct PendingWorkspace {
    pub workspace_id: String,
    pub checkout: Checkout,
    pub delivery: Delivery,
    pub uploaded: bool,
}

pub(crate) struct Workspaces {
    directory: PathBuf,
    mappings: Vec<WorkspaceMapping>,
}

/// A Worker Host advertises at most this many Workspaces, as the Control Plane accepts.
const MAX_WORKSPACE_MAPPINGS: usize = 128;

impl Workspaces {
    /// Several IDs may map the same source: each (ID, base commit) pair gets its own private
    /// state directory, and no checkout ever writes a branch or ref into the source repository,
    /// so aliases cannot collide.
    pub fn new(directory: &Path, mappings: Vec<WorkspaceMapping>) -> Result<Self> {
        ensure!(
            mappings.len() <= MAX_WORKSPACE_MAPPINGS,
            "a Worker Host maps at most {MAX_WORKSPACE_MAPPINGS} Workspaces"
        );
        let mut seen = std::collections::BTreeSet::new();
        let mappings = mappings
            .into_iter()
            .map(|mut mapping| -> Result<_> {
                ensure!(
                    valid_workspace_id(&mapping.workspace_id),
                    "invalid hosted workspace identity"
                );
                ensure!(
                    seen.insert(mapping.workspace_id.clone()),
                    "Workspace {} is mapped more than once",
                    mapping.workspace_id
                );
                if let Some(command) = &mapping.setup {
                    supertag_workspaces::setup::validate_command(command)?;
                }
                // An unavailable source cannot be advertised for new work, but
                // must not prevent recovery cleanup from recorded private state.
                if let WorkspaceSource::Local(path) = &mapping.source
                    && let Ok(source) = path.canonicalize()
                {
                    mapping.source = WorkspaceSource::Local(source);
                }
                Ok(mapping)
            })
            .collect::<Result<_>>()?;
        Ok(Self {
            directory: directory.join("workspaces"),
            mappings,
        })
    }

    fn mapping(&self, workspace_id: &str) -> Option<&WorkspaceMapping> {
        self.mappings
            .iter()
            .find(|mapping| mapping.workspace_id == workspace_id)
    }

    pub fn ids(&self) -> Vec<String> {
        self.mappings
            .iter()
            .filter(|mapping| match &mapping.source {
                WorkspaceSource::Local(source) => source.is_dir(),
                WorkspaceSource::ControlPlane => false,
            })
            .map(|mapping| mapping.workspace_id.clone())
            .collect()
    }

    pub fn control_plane_ids(&self) -> Vec<String> {
        self.mappings
            .iter()
            .filter(|mapping| matches!(mapping.source, WorkspaceSource::ControlPlane))
            .map(|mapping| mapping.workspace_id.clone())
            .collect()
    }

    fn open(&self, workspace_id: &str, base_commit: &str) -> Result<Workspace> {
        let mapping = self
            .mapping(workspace_id)
            .context("Task workspace is not configured on this Worker Host")?;
        Workspace::open(WorkspaceConfig {
            state_dir: self.state_directory(workspace_id, base_commit)?,
            source: match &mapping.source {
                WorkspaceSource::Local(source) => source.clone(),
                WorkspaceSource::ControlPlane => self
                    .source_directory(workspace_id, base_commit)
                    .join("repository.git"),
            },
            base_commit: base_commit.to_owned(),
        })
    }

    /// The state directory of one Workspace and base commit on this lane.
    fn state_directory(&self, workspace_id: &str, base_commit: &str) -> Result<PathBuf> {
        Ok(self.directory.join(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(workspace_id, base_commit))?)
        )))
    }

    fn source_directory(&self, workspace_id: &str, base_commit: &str) -> PathBuf {
        self.directory.join("sources").join(format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(workspace_id, base_commit)).expect("string pair serializes")
            )
        ))
    }

    /// The commit the branch a Task's Workspace follows names now in this host's mapped source.
    /// Only a local checkout resolves branches; a remote Workspace pins its own branch.
    pub async fn resolve_ref(
        &self,
        workspace_id: &str,
        branch: &str,
        cancel: &CancellationToken,
    ) -> BranchResolution {
        let source = match self.mapping(workspace_id) {
            None => {
                return BranchResolution::Failed(
                    "Task workspace is not configured on this Worker Host".into(),
                );
            }
            Some(mapping) => match mapping.local_root() {
                Some(source) => source,
                None => {
                    return BranchResolution::Failed(
                        "only a local Workspace follows a branch".into(),
                    );
                }
            },
        };
        if !supertag_protocol::valid_git_branch(branch) {
            return BranchResolution::Failed(format!(
                "Workspace ref {branch} is not a branch name"
            ));
        }
        let resolved = supertag_workspaces::base_ref::resolve(source, branch, cancel).await;
        branch_resolution(branch, resolved, cancel)
    }

    pub async fn prepare(
        &self,
        task: &Task,
        attempt: &Attempt,
        transfers: &Transfers,
        token: &str,
        cancel: &CancellationToken,
    ) -> Result<Option<PreparedWorkspace>> {
        let Some(spec) = &task.workspace else {
            return Ok(None);
        };
        ensure!(
            !spec.base_commit.is_empty(),
            "Task Workspace branch was not resolved before preparation"
        );
        let mapping = self
            .mapping(&spec.workspace_id)
            .context("Task workspace is not configured on this Worker Host")?;
        match (&mapping.source, &spec.remote) {
            (WorkspaceSource::ControlPlane, Some(expected)) => {
                let (reference, bytes) = tokio::select! {
                    result = transfers.download_source(attempt, token, false) => result?,
                    _ = cancel.cancelled() => return Err(Status::cancelled("source download cancelled").into()),
                };
                ensure!(
                    reference.workspace.as_ref() == Some(expected)
                        && expected.workspace_id == spec.workspace_id
                        && expected.commit == spec.base_commit
                        && reference.commit == spec.base_commit,
                    "Control Plane returned a different Workspace source"
                );
                fs::DirBuilder::new()
                    .recursive(true)
                    .mode(0o700)
                    .create(&self.directory)?;
                let mut file = NamedTempFile::new_in(self.directory.canonicalize()?)?;
                file.write_all(&bytes)?;
                file.as_file().sync_all()?;
                let blob = reference.bundle.context("source download has no bundle")?;
                supertag_workspaces::source::materialize(
                    &self.source_directory(&spec.workspace_id, &spec.base_commit),
                    &TransferArtifact {
                        path: file.path().to_owned(),
                        sha256: blob.sha256,
                        byte_length: blob.byte_length,
                    },
                    &spec.base_commit,
                    cancel,
                )
                .await?;
            }
            (WorkspaceSource::Local(_), _) => {}
            _ => {
                anyhow::bail!("Workspace source does not match this Host's configured source mode")
            }
        }
        let workspace = self.open(&spec.workspace_id, &spec.base_commit)?;
        // A continuation this host already holds, such as one it delivered itself, is not
        // downloaded again: only its receipt is read.
        let held = async |reference: &WorkspaceDeliveryReference| {
            reference.workspace_id == spec.workspace_id
                && reference.base_commit == spec.base_commit
                && workspace.holds_commit(&reference.head_commit, cancel).await
        };
        let previous = tokio::select! {
            previous = transfers.download_workspace(attempt, token, held) => previous?,
            _ = cancel.cancelled() => return Err(Status::cancelled("workspace preparation cancelled").into()),
        };
        let expected_head = match previous {
            None => Some(spec.base_commit.clone()),
            Some((reference, None)) => Some(reference.head_commit),
            Some((reference, Some(payload))) => {
                ensure!(
                    reference.workspace_id == spec.workspace_id
                        && reference.base_commit == spec.base_commit,
                    "approved continuation belongs to another workspace"
                );
                // A configured state path may contain a platform alias such as
                // /var on macOS. Import validates every directory component,
                // so use the canonical private parent for this host-owned file.
                let mut temporary = NamedTempFile::new_in(self.directory.canonicalize()?)?;
                temporary.write_all(&payload)?;
                temporary.as_file().sync_all()?;
                let bundle = reference
                    .bundle
                    .clone()
                    .context("approved continuation has no bundle")?;
                let imported = workspace
                    .import_bundle(
                        temporary.path(),
                        &bundle.sha256,
                        &reference.head_commit,
                        Some(&reference.start_commit),
                        cancel,
                    )
                    .await;
                match imported {
                    // The continuation builds on a commit this host never received: take a
                    // complete bundle of it from the host holding it.
                    Err(error) if error.is::<supertag_workspaces::MissingPrerequisite>() => {
                        let complete = tokio::select! {
                            complete = transfers.download_complete_workspace(attempt, token, &reference) => complete?,
                            _ = cancel.cancelled() => return Err(Status::cancelled("workspace preparation cancelled").into()),
                        };
                        let mut temporary = NamedTempFile::new_in(self.directory.canonicalize()?)?;
                        temporary.write_all(&complete)?;
                        temporary.as_file().sync_all()?;
                        workspace
                            .import_bundle(
                                temporary.path(),
                                &format!("{:x}", Sha256::digest(&complete)),
                                &reference.head_commit,
                                Some(&reference.start_commit),
                                cancel,
                            )
                            .await?;
                    }
                    result => result?,
                }
                Some(reference.head_commit)
            }
        };
        // A merge follow-up starts from its Session's work with the target merged in.
        let merge_commit = (!spec.merge_commit.is_empty()).then(|| spec.merge_commit.clone());
        if let Some(commit) = &merge_commit {
            match &mapping.source {
                WorkspaceSource::ControlPlane => {
                    let (reference, bytes) = tokio::select! {
                        result = transfers.download_source(attempt, token, true) => result?,
                        _ = cancel.cancelled() => return Err(Status::cancelled("merge source download cancelled").into()),
                    };
                    ensure!(
                        &reference.commit == commit,
                        "Control Plane returned a different merge commit"
                    );
                    let blob = reference.bundle.context("merge download has no bundle")?;
                    let mut file = NamedTempFile::new_in(self.directory.canonicalize()?)?;
                    file.write_all(&bytes)?;
                    file.as_file().sync_all()?;
                    workspace
                        .import_merge_bundle(file.path(), &blob.sha256, commit, cancel)
                        .await?;
                }
                WorkspaceSource::Local(_) => {
                    workspace.import_source_commit(commit, cancel).await?;
                }
            }
        }
        let author = (!spec.author_name.is_empty()).then(|| supertag_workspaces::CommitAuthor {
            name: spec.author_name.clone(),
            email: spec.author_email.clone(),
            co_author: spec.co_author.clone(),
        });
        let checkout = workspace
            .prepare(
                PrepareRequest {
                    task_id: task.task_id.clone(),
                    attempt_id: attempt.attempt_id.clone(),
                    session_id: task.session_id.clone(),
                    expected_head,
                    setup: mapping.setup.clone(),
                    merge_commit,
                    author,
                },
                cancel,
            )
            .await
            .map_err(
                |error| match error.downcast::<supertag_workspaces::setup::SetupFailed>() {
                    Ok(failed) => Status::failed_precondition(failed.0).into(),
                    Err(error) => error,
                },
            )?;
        Ok(Some(PreparedWorkspace {
            workspace_id: spec.workspace_id.clone(),
            checkout,
        }))
    }

    /// A Worker-owned snapshot of the Task's base commit for its Workspace MCP servers.
    pub(crate) async fn mcp_snapshot(
        &self,
        prepared: &PreparedWorkspace,
        cancel: &CancellationToken,
    ) -> Result<PathBuf> {
        self.open(&prepared.workspace_id, &prepared.checkout.base_commit)?
            .mcp_snapshot(
                &prepared.checkout.task_id,
                &prepared.checkout.attempt_id,
                cancel,
            )
            .await
    }

    /// The remote sandbox translated from the base commit's devcontainer subset, if any.
    /// Refusals name the property, before any provider call.
    pub(crate) async fn remote_environment(
        &self,
        prepared: &PreparedWorkspace,
        cancel: &CancellationToken,
    ) -> Result<Option<supertag_workspaces::devcontainer::RemoteDevcontainer>> {
        self.open(&prepared.workspace_id, &prepared.checkout.base_commit)?
            .trusted_devcontainer(cancel)
            .await?
            .as_ref()
            .map(supertag_workspaces::devcontainer::remote_devcontainer)
            .transpose()
    }

    /// Removes an Attempt's MCP snapshot after its servers stopped; best effort.
    pub(crate) fn remove_mcp_snapshot(&self, prepared: &PreparedWorkspace) {
        if let Ok(workspace) = self.open(&prepared.workspace_id, &prepared.checkout.base_commit) {
            let _ = workspace
                .remove_mcp_snapshot(&prepared.checkout.task_id, &prepared.checkout.attempt_id);
        }
    }

    pub(crate) async fn output_remote(
        &self,
        workspace: &PreparedWorkspace,
        commit: &str,
        authority: (&Transfers, &Attempt, &str),
        cancel: &CancellationToken,
    ) -> Option<String> {
        let mapping = self.mapping(&workspace.workspace_id)?;
        match &mapping.source {
            WorkspaceSource::Local(source) => supertag_workspaces::advertised_output_remote(
                source,
                &self.directory,
                commit,
                cancel,
            )
            .await
            .ok()
            .flatten(),
            WorkspaceSource::ControlPlane => {
                let (transfers, attempt, token) = authority;
                tokio::select! {
                    remote = transfers.verify_output_remote(attempt, token, commit) => remote.ok().flatten(),
                    _ = cancel.cancelled() => None,
                }
            }
        }
    }

    pub async fn finalize(
        &self,
        prepared: &PreparedWorkspace,
        summary: &str,
        (succeeded, file_scope): (bool, Option<supertag_protocol::file_scope::Rules>),
        output_directory: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<PendingWorkspace> {
        let workspace = self.open(&prepared.workspace_id, &prepared.checkout.base_commit)?;
        let delivery = workspace
            .finalize(
                &prepared.checkout,
                FinalizeRequest {
                    summary: summary.to_owned(),
                    output_directory: output_directory.map(str::to_owned),
                    file_scope,
                    outcome: if succeeded {
                        Outcome::Completed
                    } else {
                        Outcome::Failed
                    },
                },
                cancel,
            )
            .await?;
        workspace.verify_delivery(&delivery)?;
        Ok(PendingWorkspace {
            workspace_id: prepared.workspace_id.clone(),
            checkout: prepared.checkout.clone(),
            delivery,
            uploaded: false,
        })
    }

    pub async fn export_remote(
        &self,
        prepared: &PreparedWorkspace,
        cancel: &CancellationToken,
    ) -> Result<PreparedExport> {
        self.open(&prepared.workspace_id, &prepared.checkout.base_commit)?
            .export_prepared(&prepared.checkout, cancel)
            .await
    }

    /// A bundle of the Workspace's trusted base commit alone, for a preparation sandbox.
    pub async fn export_trusted(
        &self,
        prepared: &PreparedWorkspace,
        cancel: &CancellationToken,
    ) -> Result<TransferArtifact> {
        self.open(&prepared.workspace_id, &prepared.checkout.base_commit)?
            .export_trusted(&prepared.checkout, cancel)
            .await
    }

    /// Whether `ancestor` is the Task's base commit or an ancestor of it.
    pub async fn base_descends_from(
        &self,
        prepared: &PreparedWorkspace,
        ancestor: &str,
        cancel: &CancellationToken,
    ) -> bool {
        let descends = match self.open(&prepared.workspace_id, &prepared.checkout.base_commit) {
            Ok(workspace) => workspace.base_descends_from(ancestor, cancel).await,
            Err(error) => Err(error),
        };
        match descends {
            Ok(descends) => descends,
            Err(error) => {
                crate::failures::note(
                    "Workspace could not be opened to find a warm preparation",
                    &error,
                );
                false
            }
        }
    }

    pub async fn restore_remote(
        &self,
        prepared: &PreparedWorkspace,
        tree: &TransferArtifact,
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.open(&prepared.workspace_id, &prepared.checkout.base_commit)?
            .restore_tree(&prepared.checkout, tree, cancel)
            .await
    }

    pub fn verify(&self, pending: &PendingWorkspace) -> Result<WorkspaceDeliveryReference> {
        let delivery = &pending.delivery;
        self.open(&pending.workspace_id, &delivery.base_commit)?
            .verify_delivery(delivery)?;
        let patch = blob(&delivery.patch_path, &delivery.patch_sha256)?;
        let bundle = blob(&delivery.bundle_path, &delivery.bundle_sha256)?;
        let reference = WorkspaceDeliveryReference {
            workspace_id: pending.workspace_id.clone(),
            delivery_id: delivery.delivery_id.clone(),
            base_commit: delivery.base_commit.clone(),
            start_commit: delivery.start_commit.clone(),
            head_commit: delivery.head_commit.clone(),
            committed: delivery.committed,
            changed_files: delivery.changed_files,
            patch: Some(patch),
            bundle: Some(bundle),
        };
        validate_workspace_delivery(&reference)?;
        Ok(reference)
    }

    /// Moves the Attempt's checkout aside and returns the workspace state directory whose
    /// `purge_discarded` deletes it, which the caller may run in the background.
    pub fn discard(&self, prepared: &PreparedWorkspace) -> Result<PathBuf> {
        let identity = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                &prepared.workspace_id,
                &prepared.checkout.base_commit
            ))?)
        );
        let state = self.directory.join(identity);
        Workspace::open_existing(&state)?.discard_checkout(&prepared.checkout)?;
        Ok(state)
    }

    /// Deletes checkouts moved aside in every workspace state directory, as a crash may have
    /// left them. Runs in a background thread; failures go to the Worker Host log.
    pub fn purge_all_discarded_in_background(&self) {
        let directory = self.directory.clone();
        std::thread::spawn(move || {
            let Ok(entries) = std::fs::read_dir(&directory) else {
                return;
            };
            for entry in entries.flatten() {
                if entry.file_type().is_ok_and(|kind| kind.is_dir())
                    && let Err(error) = supertag_workspaces::purge_discarded(&entry.path())
                {
                    crate::failures::note_unrecorded(
                        "Discarded checkouts could not be deleted",
                        &error,
                    );
                }
            }
        });
    }
}

fn blob(path: &Path, digest: &str) -> Result<BlobReference> {
    let bytes = fs::symlink_metadata(path)?.len();
    ensure!(
        bytes <= MAX_WORKSPACE_BLOB_BYTES as u64,
        "workspace artifact exceeds transfer size limit"
    );
    Ok(BlobReference {
        sha256: digest.to_owned(),
        byte_length: bytes,
    })
}

fn read_blob(path: &Path, reference: &BlobReference) -> Result<Vec<u8>, Status> {
    let read = || -> Result<Vec<u8>> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)?;
        ensure!(
            file.metadata()?.is_file() && file.metadata()?.len() == reference.byte_length,
            "workspace artifact changed"
        );
        let mut bytes = Vec::new();
        file.take(MAX_WORKSPACE_BLOB_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 == reference.byte_length
                && format!("{:x}", Sha256::digest(&bytes)) == reference.sha256,
            "workspace artifact digest changed"
        );
        Ok(bytes)
    };
    read().map_err(|error| {
        crate::failures::noted(
            Status::data_loss("staged workspace artifact does not match its receipt"),
            &error,
        )
    })
}

impl Transfers {
    async fn verify_output_remote(
        &self,
        attempt: &Attempt,
        token: &str,
        commit: &str,
    ) -> Result<Option<String>, Status> {
        let mut request = request(
            VerifyWorkspaceOutputRemoteRequest {
                attempt: Some(attempt.inspect()),
                commit: commit.into(),
            },
            token,
        )
        .map_err(|error| {
            crate::failures::noted(
                Status::internal("cannot authenticate Git output verification"),
                &error,
            )
        })?;
        request.set_timeout(Duration::from_secs(32));
        let response =
            TransfersClient::with_interceptor(self.channel.clone(), self.headers.clone())
                .verify_workspace_output_remote(request)
                .await?
                .into_inner();
        Ok(response.remote.filter(|remote| {
            supertag_protocol::git_outputs::remote_url(remote).is_some_and(|url| {
                url.scheme() == "https"
                    && url.host_str() == Some("github.com")
                    && url.as_str() == remote
            })
        }))
    }

    async fn download_source(
        &self,
        attempt: &Attempt,
        token: &str,
        merge: bool,
    ) -> Result<(WorkspaceSourceBundle, Vec<u8>), Status> {
        let input = DownloadWorkspaceSourceRequest {
            attempt: Some(attempt.inspect()),
            merge,
        };
        let mut request = request(input, token).map_err(|error| {
            crate::failures::noted(
                Status::internal("cannot authenticate source download"),
                &error,
            )
        })?;
        request.set_timeout(Duration::from_secs(120));
        let mut stream =
            TransfersClient::with_interceptor(self.channel.clone(), self.headers.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .download_workspace_source(request)
                .await?
                .into_inner();
        let reference = match stream.message().await? {
            Some(WorkspaceSourceDownload {
                part: Some(workspace_source_download::Part::Reference(reference)),
            }) => reference,
            _ => return Err(Status::data_loss("source download has no receipt")),
        };
        let blob = reference
            .bundle
            .as_ref()
            .ok_or_else(|| Status::data_loss("source receipt has no bundle"))?;
        if blob.byte_length == 0 || blob.byte_length > MAX_WORKSPACE_BLOB_BYTES as u64 {
            return Err(Status::data_loss("source bundle size is invalid"));
        }
        let mut bytes = Vec::new();
        while let Some(message) = stream.message().await? {
            let Some(workspace_source_download::Part::Chunk(chunk)) = message.part else {
                return Err(Status::data_loss("unexpected source download record"));
            };
            if chunk.is_empty()
                || chunk.len() > CHECKPOINT_CHUNK_BYTES
                || bytes.len() as u64 + chunk.len() as u64 > blob.byte_length
            {
                return Err(Status::data_loss("invalid source bundle chunk"));
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.len() as u64 != blob.byte_length
            || format!("{:x}", Sha256::digest(&bytes)) != blob.sha256
        {
            return Err(Status::data_loss(
                "source bundle does not match its receipt",
            ));
        }
        Ok((reference, bytes))
    }
    /// Keeps the delivery's patch and bundle in this host's artifact storage, then records the
    /// delivery. The Control Plane stores neither: it relays them from this host to readers.
    pub(crate) async fn upload_workspace(
        &self,
        attempt: &Attempt,
        token: &str,
        pending: &PendingWorkspace,
        reference: WorkspaceDeliveryReference,
    ) -> Result<WorkspaceDeliveryReference, Status> {
        let storage = self.storage.clone().ok_or_else(|| {
            Status::failed_precondition("this Worker Host has no artifact storage for deliveries")
        })?;
        let patch_blob = reference
            .patch
            .clone()
            .ok_or_else(|| Status::data_loss("missing patch receipt"))?;
        let bundle_blob = reference
            .bundle
            .clone()
            .ok_or_else(|| Status::data_loss("missing bundle receipt"))?;
        let patch = read_blob(&pending.delivery.patch_path, &patch_blob)?;
        let bundle = read_blob(&pending.delivery.bundle_path, &bundle_blob)?;
        let attempt_id = attempt.attempt_id.clone();
        // The delivery's files live in its Workspace state directory, `<state>/artifacts/<id>/`.
        let state = pending
            .delivery
            .bundle_path
            .ancestors()
            .nth(3)
            .map(Path::to_path_buf)
            .ok_or_else(|| Status::internal("Workspace delivery has no state directory"))?;
        tokio::task::spawn_blocking(move || {
            storage.retain_blob(&attempt_id, &patch_blob, &patch)?;
            storage.retain_blob(&attempt_id, &bundle_blob, &bundle)?;
            // Any lane of this host can then build a complete bundle of the delivery.
            storage.retain_workspace(&attempt_id, &state)
        })
        .await
        .map_err(|error| {
            crate::failures::noted(
                Status::internal("Workspace delivery storage failed"),
                &error,
            )
        })?
        .map_err(|error| {
            crate::failures::noted(
                Status::data_loss("could not keep the Workspace delivery on this Worker Host"),
                &error,
            )
        })?;
        let mut upstream = request(
            WorkspaceDeliveryRequest {
                attempt: Some(attempt.inspect()),
                delivery: Some(reference.clone()),
            },
            token,
        )
        .map_err(|error| {
            crate::failures::noted(
                Status::internal("cannot authenticate workspace delivery"),
                &error,
            )
        })?;
        upstream.set_timeout(Duration::from_secs(30));
        let received =
            TransfersClient::with_interceptor(self.channel.clone(), self.headers.clone())
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .commit_workspace(upstream)
                .await?
                .into_inner();
        if received != reference {
            return Err(Status::data_loss(
                "Control Plane returned a different workspace receipt",
            ));
        }
        Ok(received)
    }

    /// The Session's approved continuation, if any: its receipt and, unless `held` says this host
    /// already has it, its bundle.
    async fn download_workspace(
        &self,
        attempt: &Attempt,
        token: &str,
        held: impl AsyncFnOnce(&WorkspaceDeliveryReference) -> bool,
    ) -> Result<Option<(WorkspaceDeliveryReference, Option<Vec<u8>>)>, Status> {
        let mut upstream = request(attempt.inspect(), token).map_err(|error| {
            crate::failures::noted(
                Status::internal("cannot authenticate workspace download"),
                &error,
            )
        })?;
        upstream.set_timeout(Duration::from_secs(120));
        let mut stream =
            TransfersClient::with_interceptor(self.channel.clone(), self.headers.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .download_workspace(upstream)
                .await?
                .into_inner();
        let reference = match stream.message().await? {
            None => return Ok(None),
            Some(WorkspaceDownload {
                part: Some(workspace_download::Part::Reference(reference)),
            }) => reference,
            _ => return Err(Status::data_loss("workspace download has no receipt")),
        };
        validate_workspace_delivery(&reference).map_err(|error| {
            crate::failures::noted(
                Status::data_loss("workspace continuation receipt is invalid"),
                &error,
            )
        })?;
        let bundle = reference
            .bundle
            .as_ref()
            .ok_or_else(|| Status::data_loss("workspace receipt has no bundle"))?;
        if bundle.byte_length == 0 || bundle.byte_length > MAX_WORKSPACE_BLOB_BYTES as u64 {
            return Err(Status::data_loss("workspace bundle size is invalid"));
        }
        if held(&reference).await {
            // Dropping the stream stops the transfer.
            return Ok(Some((reference, None)));
        }
        let mut bytes = Vec::new();
        while let Some(message) = stream.message().await? {
            let Some(workspace_download::Part::Chunk(chunk)) = message.part else {
                return Err(Status::data_loss("unexpected workspace download record"));
            };
            if chunk.is_empty()
                || chunk.len() > CHECKPOINT_CHUNK_BYTES
                || bytes.len() as u64 + chunk.len() as u64 > bundle.byte_length
            {
                return Err(Status::data_loss("invalid workspace bundle chunk"));
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.len() as u64 != bundle.byte_length
            || format!("{:x}", Sha256::digest(&bytes)) != bundle.sha256
        {
            return Err(Status::data_loss(
                "workspace bundle does not match its receipt",
            ));
        }
        Ok(Some((reference, Some(bytes))))
    }

    /// A complete bundle of the Session's approved continuation `expected`, which the Worker
    /// Host holding it builds on demand, for this host that lacks the delivery's start commit.
    /// It has no recorded digest; importing it checks it with Git against the delivered commit.
    async fn download_complete_workspace(
        &self,
        attempt: &Attempt,
        token: &str,
        expected: &WorkspaceDeliveryReference,
    ) -> Result<Vec<u8>, Status> {
        let mut upstream = request(attempt.inspect(), token).map_err(|error| {
            crate::failures::noted(
                Status::internal("cannot authenticate workspace download"),
                &error,
            )
        })?;
        upstream.set_timeout(Duration::from_secs(120));
        let mut stream =
            TransfersClient::with_interceptor(self.channel.clone(), self.headers.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .download_complete_workspace(upstream)
                .await?
                .into_inner();
        match stream.message().await? {
            Some(WorkspaceDownload {
                part: Some(workspace_download::Part::Reference(reference)),
            }) if &reference == expected => {}
            _ => {
                return Err(Status::data_loss(
                    "complete workspace bundle belongs to another continuation",
                ));
            }
        }
        let mut bytes = Vec::new();
        while let Some(message) = stream.message().await? {
            let Some(workspace_download::Part::Chunk(chunk)) = message.part else {
                return Err(Status::data_loss("unexpected workspace download record"));
            };
            if chunk.is_empty()
                || chunk.len() > CHECKPOINT_CHUNK_BYTES
                || bytes.len() + chunk.len() > MAX_WORKSPACE_BLOB_BYTES
            {
                return Err(Status::data_loss("invalid workspace bundle chunk"));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
}

/// What a Worker Host decides after resolving the branch a Tag follows.
#[derive(Debug, PartialEq, Eq)]
pub enum BranchResolution {
    /// The branch names this commit now.
    Commit(String),
    /// The Worker Host stopped during the lookup; the Attempt stays for recovery.
    Interrupted,
    /// The Task cannot start from this branch on this host; the text says why.
    Failed(String),
}

fn branch_resolution(
    branch: &str,
    resolved: Result<Option<String>>,
    cancel: &CancellationToken,
) -> BranchResolution {
    match resolved {
        Ok(Some(commit)) => BranchResolution::Commit(commit),
        Ok(None) => BranchResolution::Failed(format!(
            "Workspace branch {branch} does not name a commit on this Worker Host"
        )),
        Err(_) if cancel.is_cancelled() => BranchResolution::Interrupted,
        Err(error) => {
            supertag_protocol::terminal_text::warn(&format!(
                "Workspace branch {branch} could not be resolved: {error:#}"
            ));
            BranchResolution::Failed(format!(
                "Workspace branch {branch} could not be resolved on this Worker Host"
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::{Entry, Journal};
    use std::process::Command;

    #[tokio::test]
    async fn only_a_missing_branch_fails_the_task_and_shutdown_leaves_it_for_recovery() -> Result<()>
    {
        let root = tempfile::tempdir()?;
        let source = root.path().join("source");
        fs::create_dir(&source)?;
        git(&source, &["init", "--quiet", "--initial-branch=main"])?;
        fs::write(source.join("readme"), "original\n")?;
        git(&source, &["add", "readme"])?;
        git(&source, &["commit", "--quiet", "-m", "base"])?;
        let head = git(&source, &["rev-parse", "HEAD"])?;
        let workspaces = Workspaces::new(
            &root.path().join("host"),
            vec![WorkspaceMapping {
                workspace_id: "project".into(),
                source: WorkspaceSource::Local(source),
                setup: None,
            }],
        )?;
        let live = CancellationToken::new();
        assert_eq!(
            workspaces.resolve_ref("project", "main", &live).await,
            BranchResolution::Commit(head)
        );
        assert_eq!(
            workspaces.resolve_ref("project", "missing", &live).await,
            BranchResolution::Failed(
                "Workspace branch missing does not name a commit on this Worker Host".into()
            )
        );
        let stopping = CancellationToken::new();
        stopping.cancel();
        assert_eq!(
            workspaces.resolve_ref("project", "main", &stopping).await,
            BranchResolution::Interrupted
        );
        assert_eq!(
            branch_resolution(
                "main",
                Err(anyhow::anyhow!("Git command exceeded its deadline")),
                &live
            ),
            BranchResolution::Failed(
                "Workspace branch main could not be resolved on this Worker Host".into()
            )
        );
        Ok(())
    }

    fn git(source: &Path, arguments: &[&str]) -> Result<String> {
        let output = Command::new("/usr/bin/git")
            .arg("-C")
            .arg(source)
            .args(arguments)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
            .output()?;
        ensure!(output.status.success(), "fixture Git failed");
        Ok(String::from_utf8(output.stdout)?.trim().into())
    }

    #[tokio::test]
    async fn stopped_execution_resumes_finalization_and_preserves_verified_receipt_after_cleanup()
    -> Result<()> {
        let root = tempfile::tempdir()?;
        let source = root.path().join("source");
        fs::create_dir(&source)?;
        git(&source, &["init", "--quiet"])?;
        fs::write(source.join("readme"), "original\n")?;
        git(&source, &["add", "readme"])?;
        git(&source, &["commit", "--quiet", "-m", "base"])?;
        let base_commit = git(&source, &["rev-parse", "HEAD"])?;
        let state = root.path().join("host");
        let mapping = WorkspaceMapping {
            workspace_id: "project".into(),
            source: WorkspaceSource::Local(source.clone()),
            setup: None,
        };
        let workspaces = Workspaces::new(&state, vec![mapping.clone()])?;
        assert_eq!(workspaces.ids(), ["project"]);
        assert!(workspaces.open("other", &base_commit).is_err());
        let private = workspaces.open("project", &base_commit)?;
        let checkout = private
            .prepare(
                PrepareRequest {
                    task_id: "task".into(),
                    attempt_id: "attempt".into(),
                    session_id: "session".into(),
                    expected_head: Some(base_commit.clone()),
                    setup: None,
                    merge_commit: None,
                    author: None,
                },
                &CancellationToken::new(),
            )
            .await?;
        fs::write(checkout.path.join("readme"), "changed\n")?;
        drop(private);
        let journal = Journal::open(&state)?;
        journal.save(&Entry::Finalizing {
            attempt: Attempt {
                native_memory: None,
                task_id: "task".into(),
                attempt_id: "attempt".into(),
                lease_token: "lease".into(),
                execution_selection: None,
                requires_unsandboxed_commands: false,
                joined: vec![],
                volume: None,
            },
            result: "Change: Capture a checked result".into(),
            succeeded: true,
            objective_signal: 0,
            waiting_approval_ids: vec!["test-approval".into()],
            quiet: false,
            checkpoint: None,
            workspace: Box::new(PreparedWorkspace {
                workspace_id: "project".into(),
                checkout,
            }),
            remote_tree: None,
            outputs: None,
            file_scope: None,
        })?;
        drop(journal);
        drop(workspaces);
        let journal = Journal::open(&state)?;
        let workspaces = Workspaces::new(&state, vec![mapping])?;
        let Some(Entry::Finalizing {
            attempt,
            result,
            succeeded,
            objective_signal,
            waiting_approval_ids,
            quiet,
            checkpoint,
            workspace,
            ..
        }) = journal.load()?
        else {
            anyhow::bail!("missing finalization intent")
        };
        let first = workspaces
            .finalize(
                &workspace,
                &result,
                (succeeded, None),
                None,
                &CancellationToken::new(),
            )
            .await?;
        let repeat = workspaces
            .finalize(
                &workspace,
                &result,
                (succeeded, None),
                None,
                &CancellationToken::new(),
            )
            .await?;
        assert_eq!(first.delivery, repeat.delivery);
        let receipt = workspaces.verify(&first)?;
        assert!(receipt.committed);
        assert_eq!(receipt.start_commit, base_commit);
        journal.save(&Entry::Finish {
            attempt,
            result,
            succeeded,
            objective_signal,
            waiting_approval_ids,
            quiet,
            checkpoint,
            workspace: Some(Box::new(first)),
            prepared: Some(workspace),
            outputs: None,
            failure_detail: vec![],
        })?;
        drop(journal);
        let journal = Journal::open(&state)?;
        let Some(Entry::Finish {
            attempt,
            workspace: Some(pending),
            waiting_approval_ids,
            ..
        }) = journal.load()?
        else {
            anyhow::bail!("missing delivery intent")
        };
        assert!(!pending.uploaded);
        assert_eq!(waiting_approval_ids, ["test-approval"]);
        assert_eq!(workspaces.verify(&pending)?, receipt);
        crate::save_finish(
            &journal,
            attempt.clone(),
            crate::adapter::failed("upload failed"),
        )?;
        let Some(Entry::Finish {
            prepared: Some(prepared),
            workspace: None,
            ..
        }) = journal.load()?
        else {
            anyhow::bail!("failure fallback lost checkout ownership")
        };
        assert!(prepared.checkout.path.exists());
        assert_eq!(fs::read_to_string(source.join("readme"))?, "original\n");
        // Unresolved execution retains its checkout; only the later terminal
        // receipt permits discard, even if the source and mapping disappear.
        journal.save(&Entry::Executing {
            attempt: attempt.clone(),
            prepared: Some(prepared.clone()),
        })?;
        drop(journal);
        fs::remove_dir_all(&source)?;
        let journal = Journal::open(&state)?;
        assert!(matches!(journal.load()?, Some(Entry::Executing { .. })));
        assert!(prepared.checkout.path.exists());
        journal.save(&Entry::Terminal {
            attempt,
            prepared: Some(prepared.clone()),
        })?;
        let recovered = Workspaces::new(&state, vec![])?;
        recovered.discard(&prepared)?;
        // Simulate a crash after deletion but before clearing the Terminal record.
        drop(journal);
        let journal = Journal::open(&state)?;
        let Some(Entry::Terminal { prepared, attempt }) = journal.load()? else {
            anyhow::bail!("terminal receipt lost")
        };
        crate::cleanup_terminal(&journal, &recovered, &state, &attempt, prepared.as_deref())?;
        assert!(!pending.checkout.path.exists());
        assert!(pending.delivery.bundle_path.exists());
        assert!(pending.delivery.patch_path.exists());
        assert!(journal.load()?.is_none());
        Ok(())
    }
}
