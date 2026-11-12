use crate::v2::{
    HarnessKind, SharedExecutionCapability, SharedExecutionTool, Task, TaskPolicySnapshot,
};

pub fn valid_environment_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

pub fn environment(snapshot: Option<&TaskPolicySnapshot>) -> Option<&str> {
    snapshot?
        .execution
        .as_ref()?
        .shared_execution_environment_id
        .as_deref()
}

pub fn normalize(profile: &mut SharedExecutionCapability) -> bool {
    if !valid_environment_id(&profile.environment_id)
        || !uuid::Uuid::parse_str(&profile.incarnation_id)
            .is_ok_and(|id| id.to_string() == profile.incarnation_id)
        || profile.tools.is_empty()
        || profile.tools.len() > 2
        || profile.tools.iter().any(|tool| {
            !matches!(
                SharedExecutionTool::try_from(*tool),
                Ok(SharedExecutionTool::Read | SharedExecutionTool::Write)
            )
        })
    {
        return false;
    }
    profile.tools.sort_unstable();
    profile.tools.dedup();
    true
}

pub fn supports(
    task: &Task,
    harness: HarnessKind,
    capability: Option<&SharedExecutionCapability>,
) -> bool {
    match (environment(task.policy_snapshot.as_ref()), capability) {
        (None, None) => true,
        (Some(environment), Some(capability)) => {
            harness == HarnessKind::Cursor
                && task.workspace.is_none()
                && environment == capability.environment_id
                && task
                    .allowed_actions
                    .iter()
                    .all(|action| match action.as_str() {
                        "files:read" => capability
                            .tools
                            .contains(&(SharedExecutionTool::Read as i32)),
                        "files:write" => capability
                            .tools
                            .contains(&(SharedExecutionTool::Write as i32)),
                        "commands:execute" => false,
                        _ => true,
                    })
        }
        _ => false,
    }
}
