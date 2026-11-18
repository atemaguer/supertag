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
    supertag_protocol::workspace_mounts::normalize_capabilities(&mut profile.workspace_mounts)
        .map_err(|error| invalid(error.message()))?;
    if !supertag_protocol::mcp::normalize_capabilities(&mut profile.mcp_servers) {
        return Err(invalid("invalid Worker Host MCP server capabilities"));
    }
    if !supertag_protocol::mcp::normalize_workspace_servers(&mut profile.mcp_login_servers)
        || profile.mcp_login_servers.iter().any(|name| {
            profile
                .mcp_servers
                .iter()
                .any(|server| &server.name == name)
        })
    {
        return Err(invalid("invalid Worker Host MCP login states"));
    }
    if let Some(shared) = profile.shared_execution.as_mut()
        && (!supertag_protocol::shared_execution::normalize(shared)
            || profile.remote_file_workspace
            || profile.allow_unsandboxed_commands
            || !profile.mcp_servers.is_empty()
            || !profile.mcp_login_servers.is_empty())
    {
        return Err(invalid("invalid shared execution Worker Host capabilities"));
    }
    if profile.unverified_workspace_provider && !profile.remote_file_workspace {
        return Err(invalid(
            "an unverified Workspace provider needs a remote file workspace",
        ));
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
        || !supertag_protocol::task_artifact_inputs::supports(task, harness, profile)
        || !supertag_protocol::workspace_mounts::supports(task, harness, profile)
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
    // Cursor, Claude Code, and OpenCode run every Workspace tool in a remote sandbox through
    // split execution; Codex through its own exec-server there.
    if profile.remote_file_workspace
        && (!matches!(
            harness,
            HarnessKind::Cursor
                | HarnessKind::ClaudeCode
                | HarnessKind::Opencode
                | HarnessKind::Codex
        ) || task.workspace.is_none())
    {
        return None;
    }
    if lane_requirement(task, harness, profile).is_some() {
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
        task_artifact_inputs: !task.input_artifacts.is_empty(),
    })
}

/// What keeps a host lane for `harness` with `profile` from running the Task, as
/// `(requirement, summary)`: commands that would run unsandboxed without the host's opt-in, or a
/// path or network scope the lane cannot apply. Both depend on the host, so `placement explain` reports
/// them only when no bound host's lane can run the Task.
pub(crate) fn lane_requirement(
    task: &Task,
    harness: HarnessKind,
    profile: &HarnessExecutionProfile,
) -> Option<(String, String)> {
    if let Some(reason) = supertag_protocol::file_scope::reason(task, harness, profile) {
        return Some(("file-scope".into(), reason));
    }
    if let Some(reason) = supertag_protocol::network_scope::reason(task, harness, profile) {
        return Some(("network-scope".into(), reason));
    }
    // A remote sandbox has no network, and web tools would run on the Worker Host instead.
    if profile.remote_file_workspace
        && let Some(action) = task
            .allowed_actions
            .iter()
            .find(|action| match action.as_str() {
                // A network scope on a relayed lane goes through the sandbox's relay.
                // Only commands use it there, so a scoped web:fetch without them is refused too.
                "web:fetch" => {
                    !(profile.remote_egress_relay
                        && supertag_protocol::network_scope::of_task(task).is_some()
                        && task
                            .allowed_actions
                            .iter()
                            .any(|action| action == "commands:execute"))
                }
                "web:search" | "browser:use" => true,
                _ => false,
            })
    {
        return Some((
            "remote-web".into(),
            format!(
                "a remote Workspace sandbox cannot carry {action} yet; run the Tag on a local Worker Host, or remove {action}"
            ),
        ));
    }
    // Codex in a remote sandbox has no sandbox of its own there to keep a Task without commands
    // from running them, so it runs only Tasks that may.
    if profile.remote_file_workspace
        && harness == HarnessKind::Codex
        && !task
            .allowed_actions
            .iter()
            .any(|action| action == "commands:execute")
    {
        return Some((
            "codex-remote-commands".into(),
            "Codex on a remote Workspace runs only Tasks with commands:execute; run the Tag on a local Codex Worker Host, or add commands:execute".into(),
        ));
    }
    let name = match harness {
        HarnessKind::ClaudeCode => "claude-code",
        HarnessKind::Opencode => "opencode",
        HarnessKind::Cursor => "cursor",
        _ => return None,
    };
    // Shared execution and remote Workspace sandboxes run commands away from the Worker Host.
    (!profile.allow_unsandboxed_commands
        && profile.shared_execution.is_none()
        && !profile.remote_file_workspace
        && task
            .allowed_actions
            .iter()
            .any(|action| action == "commands:execute"))
    .then(|| {
        let label = match harness {
            HarnessKind::ClaudeCode => "Claude Code",
            HarnessKind::Opencode => "OpenCode",
            _ => "Cursor",
        };
        (
            "unsandboxed-commands".into(),
            format!(
                "{label} runs commands without a sandbox, and no bound Worker Host runs them in one; set environment: local-vm on a Worker Host's supertag.yaml service to run them in a container, add {name} to its allow-unsandboxed-commands, or remove commands:execute"
            ),
        )
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
    fn remote_file_host_reserves_split_harness_repository_work_with_sandboxed_commands() {
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
        // Codex runs there only with commands: nothing else keeps it in bounds in the sandbox.
        assert!(resolve_attempt(&task, HarnessKind::Codex, &profile).is_none());
        assert_eq!(
            lane_requirement(&task, HarnessKind::Codex, &profile)
                .unwrap()
                .0,
            "codex-remote-commands"
        );
        assert!(
            resolve_attempt(&task, HarnessKind::Cursor, &profile)
                .unwrap()
                .remote_file_workspace
        );
        // Commands run in the sandbox, so they need no allow-unsandboxed-commands opt-in.
        task.allowed_actions.push("commands:execute".into());
        assert!(lane_requirement(&task, HarnessKind::Cursor, &profile).is_none());
        assert!(
            resolve_attempt(&task, HarnessKind::Cursor, &profile)
                .unwrap()
                .remote_file_workspace
        );
        // Claude Code and OpenCode split the same way, and Codex runs its own exec-server there;
        // other harnesses never take a remote Workspace.
        for harness in [
            HarnessKind::ClaudeCode,
            HarnessKind::Opencode,
            HarnessKind::Codex,
        ] {
            assert!(
                resolve_attempt(&task, harness, &profile)
                    .unwrap()
                    .remote_file_workspace
            );
        }
        assert!(resolve_attempt(&task, HarnessKind::OpenaiAgents, &profile).is_none());
        // Web tools would run on the Worker Host, outside the sandbox: refused there.
        for action in ["web:fetch", "web:search"] {
            let mut web = task.clone();
            web.allowed_actions.push(action.into());
            assert_eq!(
                lane_requirement(&web, HarnessKind::ClaudeCode, &profile)
                    .unwrap()
                    .0,
                "remote-web"
            );
            assert!(resolve_attempt(&web, HarnessKind::Cursor, &profile).is_none());
        }
        // A scoped web:fetch on a lane whose provider relays to the egress proxy is admitted;
        // web:search still is not.
        let relayed = HarnessExecutionProfile {
            remote_egress_relay: true,
            ..profile.clone()
        };
        let mut scoped = task.clone();
        scoped.allowed_actions.push("web:fetch".into());
        scoped.policy_snapshot = Some(supertag_protocol::v2::TaskPolicySnapshot {
            runtime_authority: Some(supertag_protocol::v2::TaskRuntimeAuthority {
                network: Some(
                    supertag_protocol::network_scope::compose(
                        [supertag_protocol::network_scope::Grant {
                            action: "web:fetch",
                            hosts: &["https://pypi.org".to_owned()],
                            methods: &[],
                            credential: "",
                            paths: &[],
                            admitted: true,
                        }],
                        false,
                    )
                    .unwrap(),
                ),
                ..Default::default()
            }),
            ..Default::default()
        });
        assert!(lane_requirement(&scoped, HarnessKind::Cursor, &relayed).is_none());
        // Only commands use it on such a lane: without them a scoped web:fetch is refused.
        let mut fetch_only = scoped.clone();
        fetch_only
            .allowed_actions
            .retain(|action| action != "commands:execute");
        assert_eq!(
            lane_requirement(&fetch_only, HarnessKind::Cursor, &relayed)
                .unwrap()
                .0,
            "remote-web"
        );
        assert_eq!(
            lane_requirement(&scoped, HarnessKind::Cursor, &profile)
                .unwrap()
                .0,
            "network-scope"
        );
        let mut unscoped = task.clone();
        unscoped.allowed_actions.push("web:fetch".into());
        assert_eq!(
            lane_requirement(&unscoped, HarnessKind::Cursor, &relayed)
                .unwrap()
                .0,
            "remote-web"
        );
        // A local lane still needs the opt-in.
        assert_eq!(
            lane_requirement(&task, HarnessKind::Cursor, &Default::default())
                .unwrap()
                .0,
            "unsandboxed-commands"
        );
        let invalid = HarnessExecutionProfile {
            allow_unsandboxed_commands: true,
            ..profile
        };
        assert!(normalize_profile(Some(&invalid)).is_err());
    }
}
