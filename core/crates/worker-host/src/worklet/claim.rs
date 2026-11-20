//! The Claim this Worklet journals before it asks the Control Plane for work.

use std::time::Duration;

use anyhow::{Context, Result, ensure};
use prost::Message;
use supertag_protocol::v2::{Assignment, ClaimTaskRequest, HarnessKind};

use crate::{
    McpCatalog, WorkerOptions, WorkletOptions,
    worklet::{
        journal::{self, Attempt},
        workspaces,
    },
};

pub(crate) fn claim_request(
    options: &WorkletOptions,
    worker: &WorkerOptions,
    workspaces: &workspaces::Workspaces,
    operation_id: String,
) -> ClaimTaskRequest {
    ClaimTaskRequest {
        operation_id,
        workspace_ids: workspaces.ids(),
        gateway_workspace_ids: workspaces.control_plane_ids(),
        harness_kind: worker.harness as i32,
        context_contracts: worker.context_catalog.supported_contracts(),
        execution_profile: Some(McpCatalog::advertised(
            &worker.execution_profile,
            &options.mcp_catalog.lapsed_logins(),
        )),
        // `--once` answers whether there is work now; otherwise the Control Plane holds an empty
        // claim until a Task can be claimed.
        wait_ms: if options.once {
            0
        } else {
            CLAIM_WAIT.as_millis() as u32
        },
    }
}

/// How long the Control Plane may hold an empty claim. Inside the API tier's call budget.
pub(crate) const CLAIM_WAIT: Duration = Duration::from_secs(6);

impl Attempt {
    /// The journal record of an Attempt the Control Plane assigned this host.
    pub(crate) fn from_assignment(assignment: Assignment) -> Result<Self> {
        let task = assignment.task.context("assignment has no Task")?;
        ensure!(
            task.attempt_id.as_deref() == Some(assignment.attempt_id.as_str()),
            "assignment has mismatched Attempt identity"
        );
        let requires_unsandboxed_commands =
            task.attempt_execution.as_ref().is_some_and(|attempt| {
                matches!(
                    attempt.harness_kind(),
                    HarnessKind::ClaudeCode | HarnessKind::Opencode | HarnessKind::Cursor
                ) && attempt.shared_execution.is_none()
                    && !attempt.remote_file_workspace
                    && task
                        .allowed_actions
                        .iter()
                        .any(|action| action == "commands:execute")
            });
        Ok(Self {
            task_id: task.task_id,
            attempt_id: assignment.attempt_id,
            lease_token: assignment.lease_token,
            attempt_credential: String::new(),
            execution_selection: task
                .attempt_execution
                .map(|selection| selection.encode_to_vec()),
            requires_unsandboxed_commands,
            joined: assignment
                .joined
                .into_iter()
                .map(|message| journal::JoinedMessage {
                    task_id: message.task_id,
                    text: message.text,
                    sent_at_ms: message.sent_at_ms,
                })
                .collect(),
            native_memory: assignment
                .native_memory
                .map(|grant| journal::NativeMemoryGrant {
                    scope: grant.scope,
                    reset_generation: grant.reset_generation,
                    volume_head: grant.volume_head.and_then(|head| {
                        head.manifest
                            .map(|manifest| (head.revision, manifest.sha256, manifest.byte_length))
                    }),
                    seeds: grant
                        .seeds
                        .into_iter()
                        .map(|seed| (seed.seed_id, seed.text, seed.created_at_ms))
                        .collect(),
                    trusted: grant.trusted,
                }),
            volume: assignment.volume.map(|volume| journal::AssignedVolume {
                volume_id: volume.volume_id,
                source: volume.source,
                revision: volume.revision,
            }),
            redelivery: assignment.redelivery.map(|redelivery| journal::Redelivery {
                interrupted_attempts: redelivery.interrupted_attempts,
                already_said: redelivery.already_said,
            }),
        })
    }
}
