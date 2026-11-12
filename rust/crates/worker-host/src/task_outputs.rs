use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use supertag_protocol::{
    artifacts::{MAX_ARTIFACT_FILES, managed_output_directory},
    authenticated_request,
    v2::{
        ArtifactDescription, ArtifactSelection, HarnessCaptureArtifactRequest, HarnessKind, Task,
    },
};
use tonic::Status;
use uuid::Uuid;

use crate::{
    Attempt, CoordinationClients,
    adapter::upload_records,
    artifact_snapshots::{Capture, Snapshots},
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
                && task
                    .allowed_actions
                    .iter()
                    .any(|action| action == "files:write")
        }) else {
            return Ok(None);
        };
        let directory = managed_output_directory(&attempt.attempt_id);
        supertag_workspaces::create_output_directory(checkout, &directory)?;
        Ok(Some(Self {
            directory,
            operation_id: format!("task-outputs:{}", Uuid::new_v4()),
            paths: Vec::new(),
            artifact_id: None,
            frozen: false,
        }))
    }

    pub(crate) fn absolute(&self, checkout: &Path) -> PathBuf {
        checkout.join(&self.directory)
    }

    pub(crate) fn freeze(
        &mut self,
        checkout: &Path,
        state: &Path,
        attempt: &Attempt,
    ) -> Result<()> {
        self.paths =
            supertag_workspaces::list_output_files(checkout, &self.directory, MAX_ARTIFACT_FILES)?;
        if !self.paths.is_empty() {
            Snapshots::open(state, &attempt.attempt_id)?.freeze_managed_outputs(
                checkout,
                attempt.inspect(),
                self.request(),
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
        let (snapshots, capture) = tokio::task::spawn_blocking(move || {
            let snapshots = Snapshots::open(&state, &identity.attempt_id)
                .map_err(|_| Status::data_loss("Task output snapshot is unavailable"))?;
            let capture = snapshots.replay_managed_outputs(identity, input)?;
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
        assert!(pending.freeze(&checkout, state.path(), &attempt).is_err());
        fs::remove_file(output.join("link.txt"))?;
        pending.freeze(&checkout, state.path(), &attempt)?;
        let saved = serde_json::to_vec(&pending)?;
        supertag_workspaces::remove_output_directory(&checkout, &pending.directory)?;
        supertag_workspaces::remove_output_directory(&checkout, &pending.directory)?;
        owned_checkout.close()?;

        let recovered: PendingOutputs = serde_json::from_slice(&saved)?;
        let snapshots = Snapshots::open(state.path(), &attempt.attempt_id)?;
        let Capture::Pending(manifest, bytes) =
            snapshots.replay_managed_outputs(attempt.inspect(), recovered.request())?
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
                .replay_managed_outputs(attempt.inspect(), recovered.request())
                .err()
                .expect("missing snapshot fails closed")
                .code(),
            Code::DataLoss,
        );
        Ok(())
    }
}
