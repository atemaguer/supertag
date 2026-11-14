use prost::Message;
use serde_json::Value;

use crate::v2::{
    AttemptExecutionSelection, HarnessExecutionProfile, HarnessKind, McpResourceRule,
    McpServerCapability, PermissionSet, PolicyPermission, PolicyPermissionTarget, Task,
};

pub const MAX_SERVERS: usize = 16;
pub const MAX_TOOLS: usize = 128;
pub const MAX_ARGUMENT_BYTES: usize = 64 * 1024;
pub const MAX_RESULT_BYTES: usize = 256 * 1024;

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
    if servers.len() > MAX_SERVERS
        || servers.iter().map(Message::encoded_len).sum::<usize>() > 128 * 1024
    {
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
        server
            .resource_bindings
            .sort_unstable_by(|a, b| a.tool.cmp(&b.tool));
        if let Some(binding) = &server.provider_binding {
            if !crate::valid_sha256(binding)
                || !server.mapped_tools.iter().map(String::as_str).eq(server
                    .resource_bindings
                    .iter()
                    .map(|entry| entry.tool.as_str()))
                || server.resource_bindings.iter().any(|entry| {
                    entry.rules.is_empty()
                        || entry.rules.len() > 16
                        || entry.rules.iter().any(|rule| !valid_resource_rule(rule))
                })
            {
                return false;
            }
        } else if !server.resource_bindings.is_empty() {
            return false;
        }
    }
    servers.sort_unstable_by(|left, right| left.name.cmp(&right.name));
    servers.windows(2).all(|pair| pair[0].name != pair[1].name)
}

/// The granted servers a Task's Workspace provides from its `.mcp.json`, by name. A Worker Host
/// that serves the Workspace provides them, so no host catalog needs to declare them.
pub fn workspace_servers(task: &Task) -> std::collections::BTreeSet<&str> {
    let Some(declared) = task.workspace.as_ref().map(|spec| &spec.mcp_servers) else {
        return Default::default();
    };
    grants(task)
        .filter_map(|(_, grant)| parse_action(&grant.action).map(|(server, _)| server))
        .filter(|server| declared.iter().any(|name| name == server))
        .collect()
}

/// Valid Workspace MCP server names: sorted, unique, and within the server bound.
pub fn normalize_workspace_servers(names: &mut Vec<String>) -> bool {
    names.sort_unstable();
    names.dedup();
    names.len() <= MAX_SERVERS && names.iter().all(|name| server_name(name))
}

/// Whether an Attempt's selected execution may use Task MCP tools: a local Claude Code host, or
/// a Cursor host whose remote Workspace runs the Workspace's stdio servers in its sandbox.
pub fn execution_serves_mcp(execution: &AttemptExecutionSelection) -> bool {
    match execution.harness_kind() {
        HarnessKind::ClaudeCode => !execution.remote_file_workspace,
        HarnessKind::Cursor => execution.remote_file_workspace,
        _ => false,
    }
}

/// Whether a host can serve each of a Task's MCP grants. A local Claude Code host serves its
/// catalog and the Workspace's servers. A Cursor host with a remote Workspace serves only the
/// Workspace's servers: its stdio servers run inside the Task's sandbox.
pub fn supports(task: &Task, harness: HarnessKind, profile: &HarnessExecutionProfile) -> bool {
    let workspace = workspace_servers(task);
    let sandboxed = harness == HarnessKind::Cursor && profile.remote_file_workspace;
    grants(task).all(|(_, grant)| {
        if !sandboxed && (harness != HarnessKind::ClaudeCode || profile.remote_file_workspace) {
            return false;
        }
        let Some((server, pattern)) = parse_action(&grant.action) else {
            return false;
        };
        if sandboxed {
            return workspace.contains(server);
        }
        // The Workspace's own server runs on whichever host serves the Workspace. A grant scoped
        // to a resource matches no tool there: `.mcp.json` declares no resource mapping.
        workspace.contains(server)
            || profile.mcp_servers.iter().any(|candidate| {
                candidate.name == server
                    && candidate.provider_binding.is_some()
                    && (grant.resource.is_empty()
                        || candidate
                            .mapped_tools
                            .iter()
                            .any(|tool| tool_matches(pattern, tool)))
            })
    })
}

pub fn selected_servers(
    task: &Task,
    profile: &HarnessExecutionProfile,
) -> Vec<McpServerCapability> {
    let workspace = workspace_servers(task);
    profile
        .mcp_servers
        .iter()
        .filter(|server| {
            !workspace.contains(server.name.as_str())
                && grants(task).any(|(_, grant)| {
                    parse_action(&grant.action).is_some_and(|(name, _)| name == server.name)
                })
        })
        .cloned()
        .collect()
}

pub fn valid_resource_rule(rule: &McpResourceRule) -> bool {
    let ascii =
        |value: &str, max| value.len() <= max && value.bytes().all(|c| (33..=126).contains(&c));
    ascii(&rule.prefix, 64)
        && ascii(&rule.separator, 16)
        && !rule.components.is_empty()
        && rule.components.len() <= 8
        && rule.components.iter().all(|component| {
            !component.arguments.is_empty()
                && component.arguments.len() <= 8
                && component.arguments.iter().all(|path| valid_path(path))
        })
        && rule.when.as_ref().is_none_or(|condition| {
            valid_path(&condition.argument) && ascii(&condition.equals, 200)
        })
}

fn valid_path(path: &str) -> bool {
    path.len() <= 128
        && path.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
        })
}

fn argument_at<'a>(arguments: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.')
        .try_fold(arguments, |current, part| current.as_object()?.get(part))
}

fn resolve(rule: &McpResourceRule, arguments: &Value) -> Result<Option<String>, Denied> {
    if rule.when.as_ref().is_some_and(|condition| {
        argument_at(arguments, &condition.argument).and_then(Value::as_str)
            != Some(&condition.equals)
    }) {
        return Ok(None);
    }
    let mut components = Vec::new();
    for component in &rule.components {
        let mut values = component
            .arguments
            .iter()
            .filter_map(|path| argument_at(arguments, path))
            .filter(|value| !value.is_null());
        let Some(value) = values.next() else {
            return Ok(None);
        };
        let text = value.as_str().ok_or(Denied)?;
        if values.any(|alternative| alternative != value)
            || text.is_empty()
            || text.len() > 400
            || !text.bytes().all(|c| (33..=126).contains(&c))
            || (!rule.separator.is_empty() && text.contains(&rule.separator))
        {
            return Err(Denied);
        }
        components.push(text);
    }
    Ok(Some(format!(
        "{}{}",
        rule.prefix,
        components.join(&rule.separator)
    )))
}

#[derive(Debug)]
pub struct Denied;

pub fn resource(rules: &[McpResourceRule], arguments: &Value) -> Result<Option<String>, Denied> {
    let mut selected = None;
    for rule in rules {
        if let Some(value) = resolve(rule, arguments)? {
            if selected.as_ref().is_some_and(|prior| prior != &value) {
                return Err(Denied);
            }
            selected = Some(value);
        }
    }
    Ok(selected)
}

pub struct Authorization<'a> {
    pub resource: Option<String>,
    pub gates: Vec<(&'a PermissionSet, &'a PolicyPermission)>,
}

pub fn authorize<'a>(
    task: &'a Task,
    server: &str,
    tool: &str,
    mapping: &[McpResourceRule],
    arguments: &Value,
) -> Result<Authorization<'a>, Denied> {
    let resource = resource(mapping, arguments)?;
    let mut allowed = false;
    let mut gates = Vec::new();
    for (set, grant) in grants(task) {
        let Some((name, pattern)) = parse_action(&grant.action) else {
            continue;
        };
        if name != server || !tool_matches(pattern, tool) {
            continue;
        }
        let covers = grant.resource.is_empty() || resource.as_deref() == Some(&grant.resource);
        if grant.approval_required && (covers || resource.is_none()) {
            gates.push((set, grant));
        }
        allowed |= covers;
    }
    if !allowed {
        return Err(Denied);
    }
    Ok(Authorization { resource, gates })
}
