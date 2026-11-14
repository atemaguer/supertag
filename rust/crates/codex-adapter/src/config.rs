use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};

#[derive(Clone)]
pub(crate) struct Policy {
    pub(crate) write: bool,
    pub(crate) commands: bool,
    pub(crate) search: bool,
    pub(crate) network: bool,
    /// Read-write Workspace copies outside the checkout the Task may change.
    pub(crate) writable_roots: Vec<PathBuf>,
}

impl Policy {
    pub(crate) fn from_actions(actions: &[String], disposable: bool) -> Result<Self> {
        ensure!(
            actions.iter().all(|action| matches!(
                action.as_str(),
                "files:read"
                    | "files:write"
                    | "commands:execute"
                    | "web:search"
                    | "web:fetch"
                    | "workstream:post"
                    | "mailbox:send"
            )),
            "Codex adapter cannot enforce the requested allowed actions"
        );
        let has = |name| actions.iter().any(|action| action == name);
        ensure!(
            has("files:read"),
            "Codex requires admitted files:read access"
        );
        let policy = Self {
            write: has("files:write"),
            commands: has("commands:execute"),
            search: has("web:search"),
            network: has("web:fetch"),
            writable_roots: vec![],
        };
        ensure!(
            !policy.write || disposable,
            "Codex files:write requires an isolated or explicitly disposable workspace"
        );
        ensure!(
            !policy.network || policy.write,
            "Codex web:fetch requires a writable disposable workspace in this adapter"
        );
        Ok(policy)
    }
}

pub(crate) fn arguments(
    workspace: &Path,
    model: Option<&str>,
    effort: Option<&str>,
    policy: &Policy,
) -> Result<Vec<String>> {
    workspace
        .to_str()
        .context("Codex workspace path must be UTF-8")?;
    let mut args = vec!["app-server".into(), "--listen".into(), "stdio://".into()];
    if let Some(model) = model {
        ensure!(
            !model.is_empty() && model.len() <= 256 && !model.chars().any(char::is_control),
            "invalid Codex model selection"
        );
        args.extend([
            "--config".into(),
            format!("model={}", serde_json::to_string(model)?),
        ]);
    }
    if let Some(effort) = effort {
        ensure!(
            matches!(effort, "low" | "medium" | "high"),
            "invalid Codex reasoning effort"
        );
        args.extend([
            "--config".into(),
            format!("model_reasoning_effort={}", serde_json::to_string(effort)?),
        ]);
    }
    let mut configuration = vec![
        "approval_policy=\"never\"".into(),
        "agents.enabled=false".into(),
        "mcp_servers={}".into(),
        "project_doc_max_bytes=0".into(),
        "analytics.enabled=false".into(),
        // A model may select code-mode-only even when the feature is disabled.
        // Keep the admitted SuperTag namespace directly callable in that mode.
        "features.code_mode.enabled=false".into(),
        "features.code_mode.direct_only_tool_namespaces=[\"supertag\"]".into(),
    ];
    for feature in [
        "multi_agent",
        "multi_agent_v2",
        "enable_fanout",
        "apps",
        "enable_mcp_apps",
        "plugins",
        "plugin_sharing",
        "remote_plugin",
        "skill_mcp_dependency_install",
        "browser_use",
        "browser_use_external",
        "computer_use",
        "in_app_browser",
        "hooks",
        "code_mode_only",
        "code_mode_only_strict_3p_tools",
        // Native code-mode commands reached a non-loopback endpoint under the
        // limited network profile in the Codex 0.163.0 macOS integration probe.
        "code_mode_host",
        "memories",
        "image_generation",
    ] {
        configuration.push(format!("features.{feature}=false"));
    }
    configuration.push(format!("features.shell_tool={}", policy.commands));
    configuration.push(format!("features.unified_exec={}", policy.commands));
    configuration.push(format!(
        "web_search=\"{}\"",
        if policy.search { "live" } else { "disabled" }
    ));
    if policy.network {
        configuration.push("sandbox_mode=\"workspace-write\"".into());
        configuration.push("sandbox_workspace_write.network_access=true".into());
    } else if policy.commands || policy.write {
        // Exact legacy profile: permit loopback only for admitted commands and
        // deny external sockets via the limited network proxy's empty allowlist.
        configuration.push("default_permissions=\"supertag\"".into());
        configuration.push(format!(
            "permissions.supertag.extends=\"{}\"",
            if policy.write {
                ":workspace"
            } else {
                ":read-only"
            }
        ));
        if policy.commands {
            configuration.extend(
                [
                    "permissions.supertag.network.enabled=true",
                    "permissions.supertag.network.mode=\"limited\"",
                    "permissions.supertag.network.allow_local_binding=true",
                    "features.network_proxy.enabled=true",
                ]
                .map(str::to_owned),
            );
        }
        let entries = filesystem(workspace, policy)?;
        if !entries.is_empty() {
            let entries = entries
                .iter()
                .map(|(path, access)| {
                    Ok(format!("{} = \"{access}\"", serde_json::to_string(path)?))
                })
                .collect::<Result<Vec<_>>>()?;
            configuration.push(format!(
                "permissions.supertag.filesystem={{ {} }}",
                entries.join(", ")
            ));
        }
    } else {
        ensure!(
            policy.writable_roots.is_empty(),
            "Codex read-write Workspace copies require files:write"
        );
        configuration.push("sandbox_mode=\"read-only\"".into());
    }
    for value in configuration {
        args.extend(["--config".into(), value]);
    }
    Ok(args)
}

/// Reapply the current Task's policy when resuming a native thread. Native
/// history cannot select the new Attempt's model, tools, or sandbox.
pub(crate) fn thread_parameters(
    workspace: &Path,
    policy: &Policy,
    args: &[String],
) -> Result<serde_json::Value> {
    let mut configuration = serde_json::Map::new();
    for pair in args.windows(2).filter(|pair| pair[0] == "--config") {
        let (key, raw) = pair[1]
            .split_once('=')
            .context("invalid owned Codex configuration")?;
        let value = if key == "permissions.supertag.filesystem" {
            let entries = filesystem(workspace, policy)?;
            ensure!(
                !entries.is_empty(),
                "protected Git directory is unavailable"
            );
            serde_json::Value::Object(
                entries
                    .into_iter()
                    .map(|(path, access)| (path, serde_json::Value::from(access)))
                    .collect(),
            )
        } else {
            serde_json::from_str(raw).context("invalid owned Codex configuration")?
        };
        configuration.insert(key.to_owned(), value);
    }
    let mut params = serde_json::json!({
        "cwd": workspace,
        "approvalPolicy": "never",
        "config": configuration,
    });
    if let Some(model) = configuration.get("model") {
        params["model"] = model.clone();
    }
    if let Some(sandbox) = configuration.get("sandbox_mode") {
        params["sandbox"] = sandbox.clone();
    }
    Ok(params)
}

/// Extra filesystem grants: the Git common directory read-only and each
/// read-write Workspace copy writable.
fn filesystem(workspace: &Path, policy: &Policy) -> Result<Vec<(String, &'static str)>> {
    let mut entries = vec![];
    if let Some(directory) = protected_git_directory(workspace)? {
        entries.push((
            directory
                .to_str()
                .context("common Git path must be UTF-8")?
                .to_owned(),
            "read",
        ));
    }
    for root in &policy.writable_roots {
        ensure!(root.is_absolute(), "Workspace copy path must be absolute");
        entries.push((
            root.to_str()
                .context("Workspace copy path must be UTF-8")?
                .to_owned(),
            "write",
        ));
    }
    Ok(entries)
}

fn protected_git_directory(workspace: &Path) -> Result<Option<PathBuf>> {
    let marker = match std::fs::read_to_string(workspace.join(".git")) {
        Ok(value) => value,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::IsADirectory
            ) =>
        {
            return Ok(None);
        }
        Err(_) => return Err(anyhow::anyhow!("could not inspect workspace Git metadata")),
    };
    let Some(directory) = marker.trim().strip_prefix("gitdir: ") else {
        return Ok(None);
    };
    let directory = Path::new(directory);
    let directory = if directory.is_absolute() {
        directory.to_owned()
    } else {
        workspace.join(directory)
    };
    let common = match std::fs::read_to_string(directory.join("commondir")) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(anyhow::anyhow!("could not inspect common Git directory")),
    };
    Ok(Some(
        directory
            .join(common.trim())
            .canonicalize()
            .context("could not resolve common Git directory")?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actions(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_owned()).collect()
    }

    #[test]
    fn read_write_copies_are_the_only_extra_writable_roots() -> Result<()> {
        let workspace = tempfile::tempdir()?;
        let mut policy = Policy::from_actions(&actions(&["files:read", "files:write"]), true)?;
        policy.writable_roots = vec![PathBuf::from("/mnt/data \"quoted\"")];
        let args = arguments(workspace.path(), None, None, &policy)?;
        assert!(args.contains(
            &"permissions.supertag.filesystem={ \"/mnt/data \\\"quoted\\\"\" = \"write\" }".into()
        ));
        assert!(args.contains(&"permissions.supertag.extends=\":workspace\"".into()));
        let params = thread_parameters(workspace.path(), &policy, &args)?;
        assert_eq!(
            params["config"]["permissions.supertag.filesystem"],
            serde_json::json!({"/mnt/data \"quoted\"": "write"})
        );
        // A read-only Task cannot be given a writable copy.
        let mut read_only = Policy::from_actions(&actions(&["files:read"]), false)?;
        read_only.writable_roots = policy.writable_roots.clone();
        assert!(arguments(workspace.path(), None, None, &read_only).is_err());
        read_only.writable_roots.clear();
        let args = arguments(workspace.path(), None, None, &read_only)?;
        assert!(args.contains(&"sandbox_mode=\"read-only\"".into()));
        assert!(
            !args
                .iter()
                .any(|arg| arg.starts_with("permissions.supertag.filesystem"))
        );
        Ok(())
    }
}
