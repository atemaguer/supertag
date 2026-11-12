use sha2::{Digest, Sha256};

use crate::v2::{HarnessExecutionProfile, HarnessKind, Task};

pub const OPERATION_PREFIX: &str = "task-input:";
pub const MAX_INPUTS: usize = 16;
pub const MAX_INPUT_FILES: usize = 100;

pub fn operation_id(artifact_id: &str) -> String {
    format!(
        "{OPERATION_PREFIX}{:x}",
        Sha256::digest(artifact_id.as_bytes())
    )
}

pub fn input_root(attempt_id: &str) -> String {
    format!("inputs/{:x}", Sha256::digest(attempt_id.as_bytes()))
}

pub fn supports_harness(harness: HarnessKind) -> bool {
    matches!(
        harness,
        HarnessKind::Codex
            | HarnessKind::ClaudeCode
            | HarnessKind::OpenaiAgents
            | HarnessKind::Cursor
            | HarnessKind::Opencode
    )
}

pub fn supports(task: &Task, harness: HarnessKind, profile: &HarnessExecutionProfile) -> bool {
    task.input_artifacts.is_empty()
        || (profile.task_artifact_inputs
            && (!profile.remote_file_workspace || harness == HarnessKind::Cursor)
            && profile.shared_execution.is_none()
            && supports_harness(harness)
            && task.workspace.is_some()
            && task
                .allowed_actions
                .iter()
                .any(|action| action == "files:read"))
}
