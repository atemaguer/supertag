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
    v2::{transfers_client::TransfersClient, workspace_download, workspace_upload, *},
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
}

#[derive(Clone, Debug)]
pub enum WorkspaceSource {
    Local(PathBuf),
    Gateway,
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
    mapping: Option<WorkspaceMapping>,
}

impl Workspaces {
    pub fn new(directory: &Path, mapping: Option<WorkspaceMapping>) -> Result<Self> {
        let mapping = mapping
            .map(|mut mapping| -> Result<_> {
                ensure!(
                    valid_workspace_id(&mapping.workspace_id),
                    "invalid hosted workspace identity"
                );
                // An unavailable source cannot be advertised for new work, but
                // must not prevent recovery cleanup from recorded private state.
                if let WorkspaceSource::Local(path) = &mapping.source
                    && let Ok(source) = path.canonicalize()
                {
                    mapping.source = WorkspaceSource::Local(source);
                }
                Ok(mapping)
            })
            .transpose()?;
        Ok(Self {
            directory: directory.join("workspaces"),
            mapping,
        })
    }

    pub fn ids(&self) -> Vec<String> {
        self.mapping
            .iter()
            .filter(|mapping| match &mapping.source {
                WorkspaceSource::Local(source) => source.is_dir(),
                WorkspaceSource::Gateway => false,
            })
            .map(|mapping| mapping.workspace_id.clone())
            .collect()
    }

    pub fn gateway_ids(&self) -> Vec<String> {
        self.mapping
            .iter()
            .filter(|mapping| matches!(mapping.source, WorkspaceSource::Gateway))
            .map(|mapping| mapping.workspace_id.clone())
            .collect()
    }

    fn open(&self, workspace_id: &str, base_commit: &str) -> Result<Workspace> {
        let mapping = self
            .mapping
            .as_ref()
            .filter(|mapping| mapping.workspace_id == workspace_id)
            .context("Task workspace is not configured on this Worker Host")?;
        let identity = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(workspace_id, base_commit))?)
        );
        Workspace::open(WorkspaceConfig {
            state_dir: self.directory.join(identity),
            source: match &mapping.source {
                WorkspaceSource::Local(source) => source.clone(),
                WorkspaceSource::Gateway => self
                    .source_directory(workspace_id, base_commit)
                    .join("repository.git"),
            },
            base_commit: base_commit.to_owned(),
        })
    }

    fn source_directory(&self, workspace_id: &str, base_commit: &str) -> PathBuf {
        self.directory.join("sources").join(format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(workspace_id, base_commit)).expect("string pair serializes")
            )
        ))
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
        let mapping = self
            .mapping
            .as_ref()
            .filter(|mapping| mapping.workspace_id == spec.workspace_id)
            .context("Task workspace is not configured on this Worker Host")?;
        match (&mapping.source, &spec.github_source) {
            (WorkspaceSource::Gateway, Some(expected)) => {
                let (reference, bytes) = tokio::select! {
                    result = transfers.download_source(attempt, token) => result?,
                    _ = cancel.cancelled() => return Err(Status::cancelled("source download cancelled").into()),
                };
                ensure!(
                    reference.workspace.as_ref() == Some(expected)
                        && expected.workspace_id == spec.workspace_id
                        && expected
                            .source
                            .as_ref()
                            .is_some_and(|source| source.commit_sha == spec.base_commit),
                    "Gateway returned a different Workspace source"
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
        let previous = tokio::select! {
            previous = transfers.download_workspace(attempt, token) => previous?,
            _ = cancel.cancelled() => return Err(Status::cancelled("workspace preparation cancelled").into()),
        };
        let expected_head = match previous {
            None => Some(spec.base_commit.clone()),
            Some((reference, payload)) => {
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
                    .context("approved continuation has no bundle")?;
                workspace
                    .import_bundle(
                        temporary.path(),
                        &bundle.sha256,
                        &reference.head_commit,
                        cancel,
                    )
                    .await?;
                Some(reference.head_commit)
            }
        };
        let checkout = workspace
            .prepare(
                PrepareRequest {
                    task_id: task.task_id.clone(),
                    attempt_id: attempt.attempt_id.clone(),
                    session_id: task.session_id.clone(),
                    expected_head,
                },
                cancel,
            )
            .await?;
        Ok(Some(PreparedWorkspace {
            workspace_id: spec.workspace_id.clone(),
            checkout,
        }))
    }

    pub async fn finalize(
        &self,
        prepared: &PreparedWorkspace,
        summary: &str,
        succeeded: bool,
        cancel: &CancellationToken,
    ) -> Result<PendingWorkspace> {
        let workspace = self.open(&prepared.workspace_id, &prepared.checkout.base_commit)?;
        let delivery = workspace
            .finalize(
                &prepared.checkout,
                FinalizeRequest {
                    summary: summary.to_owned(),
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

    pub fn discard(&self, prepared: &PreparedWorkspace) -> Result<()> {
        let identity = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                &prepared.workspace_id,
                &prepared.checkout.base_commit
            ))?)
        );
        Workspace::open_existing(&self.directory.join(identity))?
            .discard_checkout(&prepared.checkout)
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
    read().map_err(|_| Status::data_loss("staged workspace artifact does not match its receipt"))
}

impl Transfers {
    async fn download_source(
        &self,
        attempt: &Attempt,
        token: &str,
    ) -> Result<(GithubWorkspaceBundle, Vec<u8>), Status> {
        let mut request = request(attempt.inspect(), token)
            .map_err(|_| Status::internal("cannot authenticate source download"))?;
        request.set_timeout(Duration::from_secs(120));
        let mut stream =
            TransfersClient::with_interceptor(self.channel.clone(), self.headers.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .download_workspace_source(request)
                .await?
                .into_inner();
        let reference = match stream.message().await? {
            Some(GithubWorkspaceDownload {
                part: Some(github_workspace_download::Part::Reference(reference)),
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
            let Some(github_workspace_download::Part::Chunk(chunk)) = message.part else {
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
    pub(crate) async fn upload_workspace(
        &self,
        attempt: &Attempt,
        token: &str,
        pending: &PendingWorkspace,
        reference: WorkspaceDeliveryReference,
    ) -> Result<WorkspaceDeliveryReference, Status> {
        let patch = read_blob(
            &pending.delivery.patch_path,
            reference
                .patch
                .as_ref()
                .ok_or_else(|| Status::data_loss("missing patch receipt"))?,
        )?;
        let bundle = read_blob(
            &pending.delivery.bundle_path,
            reference
                .bundle
                .as_ref()
                .ok_or_else(|| Status::data_loss("missing bundle receipt"))?,
        )?;
        let begin = WorkspaceUpload {
            part: Some(workspace_upload::Part::Begin(WorkspaceDeliveryRequest {
                attempt: Some(attempt.inspect()),
                delivery: Some(reference.clone()),
            })),
        };
        let patches = (0..patch.len())
            .step_by(CHECKPOINT_CHUNK_BYTES)
            .map(move |offset| WorkspaceUpload {
                part: Some(workspace_upload::Part::PatchChunk(
                    patch[offset..patch.len().min(offset + CHECKPOINT_CHUNK_BYTES)].to_vec(),
                )),
            });
        let bundles = (0..bundle.len())
            .step_by(CHECKPOINT_CHUNK_BYTES)
            .map(move |offset| WorkspaceUpload {
                part: Some(workspace_upload::Part::BundleChunk(
                    bundle[offset..bundle.len().min(offset + CHECKPOINT_CHUNK_BYTES)].to_vec(),
                )),
            });
        let messages = std::iter::once(begin).chain(patches).chain(bundles);
        let mut upstream = request(tokio_stream::iter(messages), token)
            .map_err(|_| Status::internal("cannot authenticate workspace upload"))?;
        upstream.set_timeout(Duration::from_secs(120));
        let received =
            TransfersClient::with_interceptor(self.channel.clone(), self.headers.clone())
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .upload_workspace(upstream)
                .await?
                .into_inner();
        if received != reference {
            return Err(Status::data_loss(
                "Gateway returned a different workspace receipt",
            ));
        }
        Ok(received)
    }

    async fn download_workspace(
        &self,
        attempt: &Attempt,
        token: &str,
    ) -> Result<Option<(WorkspaceDeliveryReference, Vec<u8>)>, Status> {
        let mut upstream = request(attempt.inspect(), token)
            .map_err(|_| Status::internal("cannot authenticate workspace download"))?;
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
        validate_workspace_delivery(&reference)
            .map_err(|_| Status::data_loss("workspace continuation receipt is invalid"))?;
        let bundle = reference
            .bundle
            .as_ref()
            .ok_or_else(|| Status::data_loss("workspace receipt has no bundle"))?;
        if bundle.byte_length == 0 || bundle.byte_length > MAX_WORKSPACE_BLOB_BYTES as u64 {
            return Err(Status::data_loss("workspace bundle size is invalid"));
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
        Ok(Some((reference, bytes)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::{Entry, Journal};
    use std::process::Command;

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
        };
        let workspaces = Workspaces::new(&state, Some(mapping.clone()))?;
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
                },
                &CancellationToken::new(),
            )
            .await?;
        fs::write(checkout.path.join("readme"), "changed\n")?;
        drop(private);
        let journal = Journal::open(&state)?;
        journal.save(&Entry::Finalizing {
            attempt: Attempt {
                task_id: "task".into(),
                attempt_id: "attempt".into(),
                lease_token: "lease".into(),
                execution_selection: None,
                requires_unsandboxed_commands: false,
            },
            result: "Change: Capture a checked result".into(),
            succeeded: true,
            objective_signal: 0,
            waiting_approval_ids: vec!["test-approval".into()],
            checkpoint: None,
            workspace: Box::new(PreparedWorkspace {
                workspace_id: "project".into(),
                checkout,
            }),
            remote_tree: None,
        })?;
        drop(journal);
        drop(workspaces);
        let journal = Journal::open(&state)?;
        let workspaces = Workspaces::new(&state, Some(mapping))?;
        let Some(Entry::Finalizing {
            attempt,
            result,
            succeeded,
            objective_signal,
            waiting_approval_ids,
            checkpoint,
            workspace,
            ..
        }) = journal.load()?
        else {
            anyhow::bail!("missing finalization intent")
        };
        let first = workspaces
            .finalize(&workspace, &result, succeeded, &CancellationToken::new())
            .await?;
        let repeat = workspaces
            .finalize(&workspace, &result, succeeded, &CancellationToken::new())
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
            checkpoint,
            workspace: Some(Box::new(first)),
            prepared: Some(workspace),
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
        let recovered = Workspaces::new(&state, None)?;
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
