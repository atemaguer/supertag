mod remote;

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Result, ensure};
use prost::Message;
use serde::{Deserialize, Serialize};
use supertag_protocol::{
    artifacts::{
        MAX_ARTIFACT_BYTES, MAX_ARTIFACT_FILE_BYTES, MAX_ARTIFACT_FILES, managed_output_directory,
    },
    authenticated_request,
    git_outputs::{self, MANIFEST_PATH},
    output_policy::{OutputSelection, REQUIRED_OUTPUT_MISSING},
    v2::{
        ArtifactDescription, ArtifactSelection, GitOutputSnapshot, HarnessCaptureArtifactRequest,
        HarnessKind, OutputGitMode, Task, TaskOutputPolicy,
    },
};
use tokio_util::sync::CancellationToken;
use tonic::Status;
use uuid::Uuid;

use crate::{
    Attempt, CoordinationClients,
    adapter::upload_records,
    artifact_snapshots::{Capture, CollectedOutput, Snapshots},
    checkpoints::Transfers,
    workspaces::{PreparedWorkspace, Workspaces},
};

pub(crate) const OUTPUT_DIRECTORY: &str = "SUPERTAG_OUTPUT_DIR";

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct PendingOutputs {
    pub(crate) directory: String,
    operation_id: String,
    paths: Vec<String>,
    artifact_id: Option<String>,
    #[serde(default)]
    pub(crate) frozen: bool,
    #[serde(default)]
    declared_policy: Option<Vec<u8>>,
}

impl PendingOutputs {
    pub(crate) fn prepare(
        task: &Task,
        checkout: Option<&Path>,
        attempt: &Attempt,
        harness: HarnessKind,
    ) -> Result<Option<Self>> {
        let Some(checkout) = checkout.filter(|_| {
            matches!(harness, HarnessKind::Codex | HarnessKind::ClaudeCode)
                && (task.output_policy.is_some()
                    || task
                        .allowed_actions
                        .iter()
                        .any(|action| action == "files:write"))
        }) else {
            return Ok(None);
        };
        let directory = if let Some(policy) = &task.output_policy {
            let directory = policy.directory.as_deref().unwrap_or("outputs");
            supertag_workspaces::prepare_declared_output_directory(checkout, directory)?;
            directory.into()
        } else {
            let directory = managed_output_directory(&attempt.attempt_id);
            supertag_workspaces::create_output_directory(checkout, &directory)?;
            directory
        };
        Ok(Some(Self::intent(directory, task)))
    }

    fn intent(directory: String, task: &Task) -> Self {
        Self {
            directory,
            operation_id: format!("task-outputs:{}", Uuid::new_v4()),
            paths: Vec::new(),
            artifact_id: None,
            frozen: false,
            declared_policy: task.output_policy.as_ref().map(Message::encode_to_vec),
        }
    }

    pub(crate) fn absolute(&self, checkout: &Path) -> PathBuf {
        checkout.join(&self.directory)
    }

    pub(crate) fn cleanup_directory(&self) -> Option<&str> {
        self.declared_policy
            .is_none()
            .then_some(self.directory.as_str())
    }

    fn policy(&self) -> Result<Option<TaskOutputPolicy>> {
        Ok(self
            .declared_policy
            .as_deref()
            .map(TaskOutputPolicy::decode)
            .transpose()?)
    }

    fn select(&self, checkout: &Path, policy: Option<&TaskOutputPolicy>) -> Result<Vec<String>> {
        if let Some(policy) = policy {
            let rules = OutputSelection::new(policy)?;
            return supertag_workspaces::list_selected_output_files(
                checkout,
                &rules.roots(),
                policy.max_files.unwrap_or(MAX_ARTIFACT_FILES as u32) as usize,
                &|path| rules.permits(path),
            );
        }
        supertag_workspaces::list_output_files(checkout, &self.directory, MAX_ARTIFACT_FILES)
    }

    pub(crate) async fn freeze(
        self,
        workspace: &PreparedWorkspace,
        workspaces: &Workspaces,
        state: &Path,
        authority: (&Transfers, &Attempt, &str),
        cancel: &CancellationToken,
    ) -> Result<Self> {
        let (_, attempt, _) = authority;
        let checkout = workspace.checkout.path.clone();
        let state = state.to_owned();
        let recovery_state = state.clone();
        let attempt = attempt.clone();
        let recovery_attempt = attempt.clone();
        let (mut output, policy, mut paths) = tokio::task::spawn_blocking(move || {
            let mut output = self;
            let policy = output.policy()?;
            let maximum = policy
                .as_ref()
                .and_then(|policy| policy.max_bytes)
                .unwrap_or(MAX_ARTIFACT_BYTES);
            let snapshots = Snapshots::open(&recovery_state, &recovery_attempt.attempt_id)?;
            if let Some(paths) = snapshots.staged_output_paths(
                &output.operation_id,
                recovery_attempt.inspect(),
                policy.is_some(),
                maximum,
            )? {
                output.paths = paths;
                output.frozen = true;
                return Ok::<_, anyhow::Error>((output, policy, Vec::new()));
            }
            let paths = output.select(&checkout, policy.as_ref())?;
            Ok((output, policy, paths))
        })
        .await??;
        if output.frozen {
            return Ok(output);
        }
        if let Some(policy) = policy
            .as_ref()
            .filter(|policy| policy.git() != OutputGitMode::Ignore)
        {
            let rules = OutputSelection::new(policy)?;
            rules.validate(&paths)?;
            let limit = policy.max_files.unwrap_or(MAX_ARTIFACT_FILES as u32) as usize;
            let git = supertag_workspaces::git_output_files(
                &workspace.checkout,
                &paths,
                |path| rules.permits(path),
                limit,
                cancel,
            )
            .await?;
            if !git.tracked.is_empty() || !git.deleted.is_empty() {
                let remote = if policy.git() == OutputGitMode::Reference && !git.tracked.is_empty()
                {
                    workspaces
                        .output_remote(workspace, &git.head_commit, authority, cancel)
                        .await
                } else {
                    None
                };
                if cancel.is_cancelled() {
                    return Err(Status::cancelled("Task output capture cancelled").into());
                }
                let checkout = workspace.checkout.clone();
                let maximum = policy.max_bytes.unwrap_or(MAX_ARTIFACT_BYTES);
                return tokio::task::spawn_blocking(move || {
                    let files = collect_git_outputs(
                        &checkout.path,
                        &checkout.start_commit,
                        paths,
                        git,
                        remote,
                        maximum,
                    )?;
                    output.freeze_git_files(&state, &attempt, files, limit, maximum)?;
                    Ok(output)
                })
                .await?;
            }
        }
        if let Some(policy) = policy
            .as_ref()
            .filter(|policy| policy.git() == OutputGitMode::Ignore)
        {
            let tracked =
                supertag_workspaces::tracked_output_paths(&workspace.checkout, &paths, cancel)
                    .await?;
            let rules = OutputSelection::new(policy)?;
            if tracked.iter().any(|path| rules.requires(path)) {
                return Err(Status::failed_precondition(REQUIRED_OUTPUT_MISSING).into());
            }
            paths.retain(|path| !tracked.contains(path));
        }
        let checkout = workspace.checkout.path.clone();
        tokio::task::spawn_blocking(move || {
            output.freeze_files(&checkout, &state, &attempt, policy.as_ref(), paths)?;
            Ok(output)
        })
        .await?
    }

    fn freeze_git_files(
        &mut self,
        state: &Path,
        attempt: &Attempt,
        files: BTreeMap<String, CollectedOutput>,
        limit: usize,
        maximum: u64,
    ) -> Result<()> {
        ensure!(
            files.len() <= limit,
            "Task output including Git manifest exceeds its file limit"
        );
        self.paths = files.keys().cloned().collect();
        Snapshots::open(state, &attempt.attempt_id)?.freeze_collected_outputs(
            files,
            attempt.inspect(),
            self.request(),
            maximum,
        )?;
        self.frozen = true;
        Ok(())
    }

    fn freeze_files(
        &mut self,
        checkout: &Path,
        state: &Path,
        attempt: &Attempt,
        policy: Option<&TaskOutputPolicy>,
        paths: Vec<String>,
    ) -> Result<()> {
        if let Some(policy) = policy {
            OutputSelection::new(policy)?.validate(&paths)?;
        }
        self.paths = paths;
        if !self.paths.is_empty() {
            Snapshots::open(state, &attempt.attempt_id)?.freeze_outputs(
                checkout,
                attempt.inspect(),
                self.request(),
                policy.is_some(),
                policy
                    .and_then(|value| value.max_bytes)
                    .unwrap_or(MAX_ARTIFACT_BYTES),
            )?;
        }
        self.frozen = true;
        Ok(())
    }

    pub(crate) fn pending(&self) -> bool {
        !self.paths.is_empty() && self.artifact_id.is_none()
    }

    pub(crate) fn selection(&self) -> Option<ArtifactSelection> {
        self.artifact_id.as_ref().map(|id| ArtifactSelection {
            artifact_id: id.clone(),
            paths: self.paths.clone(),
        })
    }

    pub(crate) async fn publish(
        &mut self,
        state: &Path,
        attempt: &Attempt,
        coordination: &CoordinationClients,
        token: &str,
    ) -> Result<(), Status> {
        let state = state.to_owned();
        let identity = attempt.inspect();
        let input = self.request();
        let artifact_source = coordination.artifact_source.clone();
        let policy = self
            .policy()
            .map_err(|_| Status::data_loss("accepted output policy could not be restored"))?;
        let (snapshots, capture) = tokio::task::spawn_blocking(move || {
            let snapshots = Snapshots::open(&state, &identity.attempt_id)
                .map_err(|_| Status::data_loss("Task output snapshot is unavailable"))?;
            let mut capture = snapshots.replay_outputs(
                identity,
                input,
                policy.is_some(),
                policy
                    .and_then(|value| value.max_bytes)
                    .unwrap_or(MAX_ARTIFACT_BYTES),
            )?;
            if let Capture::Pending(manifest, selected) = &mut capture {
                snapshots.retain_outputs(manifest, selected, artifact_source.as_ref())?;
            }
            Ok::<_, Status>((snapshots, capture))
        })
        .await
        .map_err(|_| Status::internal("Task output snapshot could not be opened"))??;
        let capture = match capture {
            Capture::Committed(receipt) => receipt,
            Capture::Pending(manifest, selected) => {
                let mut request = authenticated_request(
                    tokio_stream::iter(upload_records(manifest.clone(), selected)),
                    token,
                    None,
                )?;
                request.set_timeout(Duration::from_secs(60));
                let receipt = coordination
                    .artifacts
                    .clone()
                    .upload_capture(request)
                    .await?
                    .into_inner();
                if receipt.files != manifest.files
                    || receipt.summary.as_ref().is_none_or(|summary| {
                        summary.description != manifest.description
                            || summary.declared_task_output != manifest.declared_task_output
                            || summary.producer.as_ref().is_none_or(|producer| {
                                producer.task_id != attempt.task_id
                                    || producer.attempt_id != attempt.attempt_id
                            })
                    })
                {
                    return Err(Status::data_loss(
                        "Task output receipt does not match the snapshot",
                    ));
                }
                let operation = self.operation_id.clone();
                tokio::task::spawn_blocking(move || {
                    snapshots
                        .commit(&operation, &receipt)
                        .map_err(|_| Status::data_loss("Task output receipt could not be saved"))?;
                    Ok::<_, Status>(receipt)
                })
                .await
                .map_err(|_| Status::internal("Task output receipt could not be saved"))??
            }
        };
        self.artifact_id = Some(
            capture
                .summary
                .map(|summary| summary.artifact_id)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| Status::data_loss("Task output receipt has no artifact ID"))?,
        );
        Ok(())
    }

    fn request(&self) -> HarnessCaptureArtifactRequest {
        HarnessCaptureArtifactRequest {
            operation_id: self.operation_id.clone(),
            description: Some(ArtifactDescription {
                title: "Task outputs".into(),
                kind: "task-output".into(),
                summary: None,
            }),
            paths: self.paths.clone(),
            native_session_id: None,
        }
    }
}

fn collect_git_outputs(
    checkout: &Path,
    start_commit: &str,
    paths: Vec<String>,
    git: supertag_workspaces::GitOutputFiles,
    remote: Option<String>,
    maximum: u64,
) -> Result<BTreeMap<String, CollectedOutput>> {
    ensure!(
        !paths.iter().any(|path| path == MANIFEST_PATH),
        "Task output collides with the generated Git manifest"
    );
    let mut files = BTreeMap::new();
    let mut referenced_paths = Vec::new();
    let mut remaining = maximum;
    for path in paths {
        let bytes = supertag_workspaces::capture_artifact_file(
            checkout,
            &path,
            remaining.min(MAX_ARTIFACT_FILE_BYTES) as usize,
        )?;
        remaining -= bytes.len() as u64;
        if remote.is_some() && git.matches_commit(&path, &bytes) {
            referenced_paths.push(path);
        } else {
            files.insert(
                path,
                CollectedOutput {
                    bytes,
                    git_output: None,
                },
            );
        }
    }
    referenced_paths.sort_unstable();
    let snapshot = GitOutputSnapshot {
        start_commit: start_commit.to_owned(),
        head_commit: git.head_commit,
        remote,
        tracked_paths: git.tracked,
        deleted_paths: git.deleted,
        referenced_paths,
    };
    let bytes = git_outputs::render(&snapshot)?;
    files.insert(
        MANIFEST_PATH.into(),
        CollectedOutput {
            bytes,
            git_output: Some(snapshot),
        },
    );
    Ok(files)
}

#[cfg(test)]
mod tests {
    use std::{fs, os::unix::fs::symlink};

    use super::*;
    use tonic::Code;

    #[test]
    fn managed_outputs_replay_after_checkout_cleanup() -> Result<()> {
        let state = tempfile::tempdir()?;
        let owned_checkout = tempfile::tempdir()?;
        let checkout = owned_checkout.path().canonicalize()?;
        let task = Task {
            allowed_actions: vec!["files:write".into()],
            ..Default::default()
        };
        let attempt = Attempt {
            task_id: "task".into(),
            attempt_id: "attempt".into(),
            lease_token: "lease".into(),
            execution_selection: None,
            requires_unsandboxed_commands: false,
        };
        let mut pending =
            PendingOutputs::prepare(&task, Some(&checkout), &attempt, HarnessKind::ClaudeCode)?
                .expect("managed outputs for a writable Task");
        let output = pending.absolute(&checkout);
        fs::write(output.join("report.txt"), b"durable output")?;
        fs::write(output.join(".env"), b"excluded")?;
        symlink(output.join("report.txt"), output.join("link.txt"))?;
        assert!(pending.select(&checkout, None).is_err());
        fs::remove_file(output.join("link.txt"))?;
        let selected = pending.select(&checkout, None)?;
        pending.freeze_files(&checkout, state.path(), &attempt, None, selected)?;
        let saved = serde_json::to_vec(&pending)?;
        supertag_workspaces::remove_output_directory(&checkout, &pending.directory)?;
        supertag_workspaces::remove_output_directory(&checkout, &pending.directory)?;
        owned_checkout.close()?;

        let recovered: PendingOutputs = serde_json::from_slice(&saved)?;
        let snapshots = Snapshots::open(state.path(), &attempt.attempt_id)?;
        assert_eq!(
            snapshots.staged_output_paths(
                &recovered.operation_id,
                attempt.inspect(),
                false,
                MAX_ARTIFACT_BYTES,
            )?,
            Some(recovered.paths.clone()),
        );
        let Capture::Pending(manifest, bytes) = snapshots.replay_outputs(
            attempt.inspect(),
            recovered.request(),
            false,
            MAX_ARTIFACT_BYTES,
        )?
        else {
            anyhow::bail!("expected the unfinished transfer");
        };
        assert!(manifest.managed_task_output);
        assert_eq!(manifest.files.len(), 1);
        assert_eq!(
            manifest.files[0].path,
            format!("{}/report.txt", recovered.directory)
        );
        assert_eq!(bytes, [b"durable output".to_vec()]);
        Snapshots::clear(state.path())?;
        let snapshots = Snapshots::open(state.path(), &attempt.attempt_id)?;
        assert_eq!(
            snapshots
                .replay_outputs(
                    attempt.inspect(),
                    recovered.request(),
                    false,
                    MAX_ARTIFACT_BYTES
                )
                .err()
                .expect("missing snapshot fails closed")
                .code(),
            Code::DataLoss,
        );
        Ok(())
    }
}
