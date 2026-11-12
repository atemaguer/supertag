use crate::v2::{
    HarnessExecutionProfile, HarnessKind, McpServerCapability, PermissionSet, PolicyPermission,
    PolicyPermissionTarget, Task,
};

pub const MAX_SERVERS: usize = 16;
pub const MAX_TOOLS: usize = 128;

/// The MCP grants frozen when the Control Plane accepted this Task.
pub fn grants(task: &Task) -> impl Iterator<Item = (&PermissionSet, &PolicyPermission)> {
    task.policy_snapshot
        .iter()
        .flat_map(|snapshot| &snapshot.permission_sets)
        .flat_map(|set| {
            set.permissions
                .iter()
                .map(move |permission| (set, permission))
        })
        .filter(|(_, permission)| permission.target() == PolicyPermissionTarget::Mcp)
}

pub fn server_name(value: &str) -> bool {
    value.len() <= 59
        && !value.starts_with("supertag")
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'-' | b'_'))
}

fn valid_tool(value: &str, pattern: bool) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-') || (pattern && c == b'*')
        })
}

pub fn tool_name(value: &str) -> bool {
    valid_tool(value, false)
}

pub fn parse_action(action: &str) -> Option<(&str, &str)> {
    let (server, pattern) = action.split_once('/')?;
    (server_name(server) && valid_tool(pattern, true)).then_some((server, pattern))
}

pub fn tool_matches(pattern: &str, tool: &str) -> bool {
    if !valid_tool(pattern, true) || !tool_name(tool) {
        return false;
    }
    let pattern = pattern.as_bytes();
    let tool = tool.as_bytes();
    let (mut p, mut t, mut retry) = (0, 0, None);
    while t < tool.len() {
        match pattern.get(p) {
            Some(b'*') => {
                p += 1;
                retry = Some((p, t));
            }
            Some(&c) if c == tool[t] => {
                p += 1;
                t += 1;
            }
            _ => {
                let Some((after_star, previous)) = retry else {
                    return false;
                };
                p = after_star;
                t = previous + 1;
                retry = Some((p, t));
            }
        }
    }
    pattern[p..].iter().all(|&c| c == b'*')
}

pub fn normalize_capabilities(servers: &mut [McpServerCapability]) -> bool {
    if servers.len() > MAX_SERVERS {
        return false;
    }
    for server in servers.iter_mut() {
        if !server_name(&server.name)
            || server.mapped_tools.len() > MAX_TOOLS
            || server.mapped_tools.iter().any(|name| !tool_name(name))
        {
            return false;
        }
        server.mapped_tools.sort_unstable();
        server.mapped_tools.dedup();
    }
    servers.sort_unstable_by(|left, right| left.name.cmp(&right.name));
    servers.windows(2).all(|pair| pair[0].name != pair[1].name)
}

pub fn supports(task: &Task, harness: HarnessKind, profile: &HarnessExecutionProfile) -> bool {
    grants(task).all(|(_, grant)| {
        if harness != HarnessKind::ClaudeCode || profile.remote_file_workspace {
            return false;
        }
        let Some((server, pattern)) = parse_action(&grant.action) else {
            return false;
        };
        profile.mcp_servers.iter().any(|candidate| {
            candidate.name == server
                && (grant.resource.is_empty()
                    || candidate
                        .mapped_tools
                        .iter()
                        .any(|tool| tool_matches(pattern, tool)))
        })
    })
}
