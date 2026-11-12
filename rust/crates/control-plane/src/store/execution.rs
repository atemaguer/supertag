use prost::Message;
use supertag_protocol::v2::{
    AttemptExecutionSelection, ExecutionSelection, HarnessExecutionProfile, HarnessKind,
    ModelSource, PolicyExecutionSettings, Task, TaskPolicySnapshot,
};

use super::{Result, invalid};

pub(super) fn normalize_profile(
    supplied: Option<&HarnessExecutionProfile>,
) -> Result<HarnessExecutionProfile> {
    let mut profile = supplied.cloned().unwrap_or_default();
    if !supertag_protocol::mcp::normalize_capabilities(&mut profile.mcp_servers) {
        return Err(invalid("invalid Worker Host MCP server capabilities"));
    }
    if let Some(shared) = profile.shared_execution.as_mut()
        && (!supertag_protocol::shared_execution::normalize(shared)
            || profile.remote_file_workspace
            || profile.allow_unsandboxed_commands
            || !profile.mcp_servers.is_empty())
    {
        return Err(invalid("invalid shared execution Worker Host capabilities"));
    }
    if profile.remote_file_workspace && profile.allow_unsandboxed_commands {
        return Err(invalid(
            "remote file workspace cannot run unsandboxed commands",
        ));
    }
    if profile.model_ids.len() > 128
        || profile.model_ids.iter().any(|model| {
            model.is_empty()
                || model.len() > 256
                || model
                    .chars()
                    .any(|value| value.is_whitespace() || value.is_control())
        })
    {
        return Err(invalid("invalid Worker Host model capabilities"));
    }
    profile.model_ids.sort_unstable();
    profile.model_ids.dedup();
    if profile
        .default_model
        .as_ref()
        .is_some_and(|model| profile.model_ids.binary_search(model).is_err())
    {
        return Err(invalid(
            "Worker Host default model must be an advertised model",
        ));
    }
    Ok(profile)
}

pub(super) fn accepted(snapshot: Option<&TaskPolicySnapshot>) -> ExecutionSelection {
    let execution = snapshot.and_then(|snapshot| snapshot.execution.as_ref());
    let model = execution
        .and_then(|execution| execution.models.first())
        .cloned();
    let effort = execution
        .and_then(|execution| execution.efforts.first())
        .cloned()
        .unwrap_or_else(|| "low".into());
    ExecutionSelection {
        model,
        effort: Some(effort),
    }
}

pub(super) fn normalize_request(
    selection: Option<&ExecutionSelection>,
) -> Result<Option<ExecutionSelection>> {
    let Some(selection) = selection else {
        return Ok(None);
    };
    Ok(
        crate::policy::normalize_execution(Some(PolicyExecutionSettings {
            models: selection.model.iter().cloned().collect(),
            efforts: selection.effort.iter().cloned().collect(),
            harness: None,
            shared_execution_environment_id: None,
        }))?
        .map(|range| ExecutionSelection {
            model: range.models.into_iter().next(),
            effort: range.efforts.into_iter().next(),
        }),
    )
}

pub(super) fn select(
    snapshot: &TaskPolicySnapshot,
    requested: Option<&ExecutionSelection>,
) -> Result<ExecutionSelection> {
    let mut selected = accepted(Some(snapshot));
    let Some(requested) = requested else {
        return Ok(selected);
    };
    let range = snapshot.execution.as_ref();
    if let Some(model) = &requested.model {
        if range.is_some_and(|range| !range.models.is_empty() && !range.models.contains(model)) {
            return Err(invalid(
                "requested model is outside the Tag's execution range",
            ));
        }
        selected.model = Some(model.clone());
    }
    if let Some(effort) = &requested.effort {
        if range.is_some_and(|range| !range.efforts.is_empty() && !range.efforts.contains(effort)) {
            return Err(invalid(
                "requested effort is outside the Tag's execution range",
            ));
        }
        selected.effort = Some(effort.clone());
    }
    Ok(selected)
}

pub(super) fn resolve_attempt(
    task: &Task,
    harness: HarnessKind,
    profile: &HarnessExecutionProfile,
) -> Option<AttemptExecutionSelection> {
    if !supertag_protocol::mcp::supports(task, harness, profile)
        || !supertag_protocol::output_policy::supports(task, harness, profile)
    {
        return None;
    }
    if !supertag_protocol::shared_execution::supports(
        task,
        harness,
        profile.shared_execution.as_ref(),
    ) {
        return None;
    }
    if profile.remote_file_workspace && (harness != HarnessKind::Cursor || task.workspace.is_none())
    {
        return None;
    }
    if matches!(harness, HarnessKind::Opencode | HarnessKind::Cursor)
        && !profile.allow_unsandboxed_commands
        && profile.shared_execution.is_none()
        && task
            .allowed_actions
            .iter()
            .any(|action| action == "commands:execute")
    {
        return None;
    }
    let mut selection = task.execution_selection.clone().unwrap_or_default();
    let source = if let Some(required) = &selection.model {
        profile.model_ids.binary_search(required).ok()?;
        ModelSource::Task
    } else if let Some(default) = &profile.default_model {
        selection.model = Some(default.clone());
        ModelSource::HostDefault
    } else {
        ModelSource::HarnessDefault
    };
    let effort_applied = selection
        .effort
        .as_ref()
        .filter(|_| harness != HarnessKind::Unspecified)
        .map(|_| matches!(harness, HarnessKind::Codex | HarnessKind::ClaudeCode));
    Some(AttemptExecutionSelection {
        selection: Some(selection),
        model_source: source as i32,
        harness_kind: harness as i32,
        effort_applied,
        remote_file_workspace: profile.remote_file_workspace,
        shared_execution: profile.shared_execution.clone(),
        mcp_servers: supertag_protocol::mcp::selected_servers(task, profile),
    })
}

pub(super) fn read_attempt(bytes: Option<Vec<u8>>) -> Result<Option<AttemptExecutionSelection>> {
    bytes
        .map(|bytes| {
            AttemptExecutionSelection::decode(bytes.as_slice())
                .map_err(|_| invalid("stored Attempt execution selection is invalid"))
        })
        .transpose()
}

pub(super) fn read_profile(bytes: Option<Vec<u8>>) -> Result<Option<HarnessExecutionProfile>> {
    bytes
        .map(|bytes| {
            HarnessExecutionProfile::decode(bytes.as_slice())
                .map_err(|_| invalid("stored Worker Host execution profile is invalid"))
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use supertag_protocol::v2::WorkspaceSpec;

    #[test]
    fn remote_file_host_only_reserves_cursor_repository_work_without_commands() {
        let profile = HarnessExecutionProfile {
            remote_file_workspace: true,
            ..Default::default()
        };
        let mut task = Task {
            allowed_actions: vec!["files:read".into(), "files:write".into()],
            ..Default::default()
        };
        assert!(resolve_attempt(&task, HarnessKind::Cursor, &profile).is_none());
        task.workspace = Some(WorkspaceSpec::default());
        assert!(resolve_attempt(&task, HarnessKind::Codex, &profile).is_none());
        assert!(
            resolve_attempt(&task, HarnessKind::Cursor, &profile)
                .unwrap()
                .remote_file_workspace
        );
        task.allowed_actions.push("commands:execute".into());
        assert!(resolve_attempt(&task, HarnessKind::Cursor, &profile).is_none());
        let invalid = HarnessExecutionProfile {
            allow_unsandboxed_commands: true,
            ..profile
        };
        assert!(normalize_profile(Some(&invalid)).is_err());
    }
}
