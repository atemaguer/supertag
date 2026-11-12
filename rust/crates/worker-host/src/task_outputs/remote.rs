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
        workspace: &PreparedWorkspace,
        archive: TransferArtifact,
        state: &Path,
        attempt: &Attempt,
        cancel: &CancellationToken,
    ) -> Result<Self> {
        let policy = self.policy()?;
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
        let cancel = cancel.clone();
        tokio::task::spawn_blocking(move || {
            let scratch = tempfile::tempdir_in(&state)?;
            let rules = policy.as_ref().map(OutputSelection::new).transpose()?;
            let max_files = policy
                .as_ref()
                .and_then(|value| value.max_files)
                .unwrap_or(MAX_ARTIFACT_FILES as u32) as usize;
            let max_bytes = policy
                .as_ref()
                .and_then(|value| value.max_bytes)
                .unwrap_or(MAX_ARTIFACT_BYTES);
            let prefix = format!("{}/", self.directory);
            let paths = supertag_workspaces::materialize_returned_files(
                &archive,
                scratch.path(),
                (max_files, MAX_ARTIFACT_FILE_BYTES, max_bytes),
                |path| {
                    anyhow::ensure!(
                        path != self.directory
                            && !self
                                .directory
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
                &cancel,
            )?;
            self.freeze_files(scratch.path(), &state, &attempt, policy.as_ref(), paths)?;
            Ok(self)
        })
        .await?
    }
}
