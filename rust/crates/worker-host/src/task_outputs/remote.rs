use supertag_protocol::{
    artifacts::{MAX_ARTIFACT_FILE_BYTES, managed_output_directory, validate_artifact_path},
    output_policy::excluded,
};
use supertag_workspaces::TransferArtifact;

use super::*;

impl PendingOutputs {
    pub(crate) fn prepare_remote(
        task: &Task,
        workspace: &PreparedWorkspace,
        attempt: &Attempt,
    ) -> Result<Option<Self>> {
        let checkout = &workspace.checkout.path;
        let directory = if let Some(policy) = &task.output_policy {
            let directory = policy.directory.as_deref().unwrap_or("outputs");
            supertag_workspaces::prepare_declared_output_directory(checkout, directory)?;
            directory.to_owned()
        } else if task
            .allowed_actions
            .iter()
            .any(|action| action == "files:write")
        {
            let directory = managed_output_directory(&attempt.attempt_id);
            // Reject a pre-existing attempt directory in the starting checkout.
            // Remote writes create parents inside their own allocated root.
            supertag_workspaces::create_output_directory(checkout, &directory)?;
            directory
        } else {
            return Ok(None);
        };
        Ok(Some(Self::intent(directory, task)))
    }

    pub(crate) async fn freeze_remote(
        mut self,
        (workspace, workspaces): (&PreparedWorkspace, &Workspaces),
        archive: TransferArtifact,
        state: &Path,
        authority: (&Transfers, &Attempt, &str),
        cancel: &CancellationToken,
    ) -> Result<Self> {
        let (_, attempt, _) = authority;
        let policy = self.policy()?;
        let git_mode = policy.as_ref().map(TaskOutputPolicy::git);
        let tracked = if policy
            .as_ref()
            .is_some_and(|policy| policy.git() == OutputGitMode::Ignore)
        {
            supertag_workspaces::prepared_tracked_paths(&workspace.checkout, cancel).await?
        } else {
            Default::default()
        };
        let state = state.to_owned();
        let attempt = attempt.clone();
        let scratch = tempfile::tempdir_in(&state)?;
        let max_files = policy
            .as_ref()
            .and_then(|value| value.max_files)
            .unwrap_or(MAX_ARTIFACT_FILES as u32) as usize;
        let max_bytes = policy
            .as_ref()
            .and_then(|value| value.max_bytes)
            .unwrap_or(MAX_ARTIFACT_BYTES);
        let directory = self.directory.clone();
        let capture_cancel = cancel.clone();
        let rules = policy.as_ref().map(OutputSelection::new).transpose()?;
        let (scratch, paths, rules) = tokio::task::spawn_blocking(move || {
            let prefix = format!("{directory}/");
            let paths = supertag_workspaces::materialize_returned_files(
                &archive,
                scratch.path(),
                (max_files, MAX_ARTIFACT_FILE_BYTES, max_bytes),
                |path| {
                    anyhow::ensure!(
                        path != directory
                            && !directory
                                .strip_prefix(path)
                                .is_some_and(|suffix| suffix.starts_with('/')),
                        "returned output directory is not a directory"
                    );
                    let selected = if let Some(rules) = &rules {
                        rules.permits(path)
                    } else {
                        let selected = path.starts_with(&prefix) && !excluded(path);
                        if selected {
                            validate_artifact_path(path)?;
                        }
                        selected
                    };
                    if selected && tracked.contains(path) {
                        if rules.as_ref().is_some_and(|rules| rules.requires(path)) {
                            return Err(Status::failed_precondition(REQUIRED_OUTPUT_MISSING).into());
                        }
                        return Ok(false);
                    }
                    Ok(selected)
                },
                &capture_cancel,
            )?;
            if let Some(rules) = &rules {
                rules.validate(&paths)?;
            }
            Ok::<_, anyhow::Error>((scratch, paths, rules))
        })
        .await??;
        let git = if let Some(rules) = &rules
            && git_mode != Some(OutputGitMode::Ignore)
        {
            let files = supertag_workspaces::prepared_git_output_files(
                &workspace.checkout,
                &paths,
                |path| rules.permits(path),
                max_files,
                cancel,
            )
            .await?;
            let remote = if git_mode == Some(OutputGitMode::Reference) && !files.tracked.is_empty()
            {
                workspaces
                    .output_remote(workspace, &files.head_commit, authority, cancel)
                    .await
            } else {
                None
            };
            (!files.tracked.is_empty() || !files.deleted.is_empty()).then_some((files, remote))
        } else {
            None
        };
        let start_commit = workspace.checkout.start_commit.clone();
        let cancel = cancel.clone();
        tokio::task::spawn_blocking(move || {
            if cancel.is_cancelled() {
                return Err(Status::cancelled("Task output capture cancelled").into());
            }
            if let Some((git, remote)) = git {
                let files = collect_git_outputs(
                    scratch.path(),
                    &start_commit,
                    paths,
                    git,
                    remote,
                    max_bytes,
                )?;
                self.freeze_git_files(&state, &attempt, files, max_files, max_bytes)?;
            } else {
                self.freeze_files(scratch.path(), &state, &attempt, policy.as_ref(), paths)?;
            }
            Ok(self)
        })
        .await?
    }
}
