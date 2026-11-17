//! `--checkpoint-fixture`: a harness that keeps a Session checkpoint, so a test sees when a turn
//! resumes one and when it starts from the Session's recap instead. Its result is a JSON summary;
//! a prompt containing `oversized` proposes a checkpoint too big to resume.
use anyhow::Result;
use serde_json::json;
use sha2::{Digest, Sha256};
use supertag_protocol::v2::{HarnessRun, SessionCheckpoint, Task};

pub fn enabled() -> bool {
    std::env::args().any(|arg| arg == "--checkpoint-fixture")
}

/// What this turn started from.
pub fn summary(run: &HarnessRun) -> Result<String> {
    Ok(json!({
        "resumed": run
            .checkpoint
            .as_ref()
            .map(|checkpoint| String::from_utf8_lossy(&checkpoint.payload[..checkpoint.payload.len().min(64)]).trim_end().to_owned()),
        "recap": run.history.iter().map(|entry| json!({
            "taskId": entry.task_id,
            "prompt": entry.prompt,
            "messages": entry.messages,
            "result": entry.result,
        })).collect::<Vec<_>>(),
    })
    .to_string())
}

/// The checkpoint this turn proposes: its prompt, padded past the resume limit when asked.
pub fn checkpoint(task: &Task) -> SessionCheckpoint {
    let mut payload = format!("{:<64}", task.prompt).into_bytes();
    if task.prompt.contains("oversized") {
        payload.resize(supertag_protocol::MAX_RESUMED_CHECKPOINT_BYTES + 1, b' ');
    }
    SessionCheckpoint {
        harness: "fixture".into(),
        format: "fixture-v1".into(),
        sha256: format!("{:x}", Sha256::digest(&payload)),
        payload,
    }
}
