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
        // Codex reads the Workspace in every sandbox mode, so it needs file access. Writing a file
        // or running a command already reads it, so either implies read, as in TypeScript.
        ensure!(
            has("files:read") || has("files:write") || has("commands:execute"),
            "Codex requires admitted files:read, files:write, or commands:execute access"
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

/// Whether Codex may start its code-mode host. Code-mode-only models, every current Codex model,
/// run commands only through it. Native code-mode commands reached a non-loopback endpoint under
/// the limited network profile in the Codex 0.163.0 macOS integration probe, so it runs only when
/// the Task also admits web:fetch and the sandbox allows the network anyway.
pub(crate) fn code_mode_host(policy: &Policy) -> bool {
    policy.commands && policy.network
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
        "memories",
        "image_generation",
    ] {
        configuration.push(format!("features.{feature}=false"));
    }
    configuration.push(format!(
        "features.code_mode_host={}",
        code_mode_host(policy)
    ));
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
        let entries = filesystem(workspace, policy)?
            .iter()
            .map(|(path, access)| Ok(format!("{} = \"{access}\"", serde_json::to_string(path)?)))
            .collect::<Result<Vec<_>>>()?;
        configuration.push(format!(
            "permissions.supertag.filesystem={{ {} }}",
            entries.join(", ")
        ));
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
            serde_json::Value::Object(
                filesystem(workspace, policy)?
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

/// Filesystem rules of the `supertag` permission profile. Each Git directory SuperTag or the
/// Worker Host later runs `git` in is read-only: the Workspace's own `.git` (a directory, a
/// linked worktree's `gitdir:` file, or absent), the common Git directory of a linked worktree,
/// and the `.git` of each read-write Workspace copy, which is itself writable.
///
/// Codex 0.163.0 protects `.git` for its built-in profiles, but a profile that `extends`
/// `:workspace` loses that protection when the Workspace lies under another writable root
/// such as `/tmp` or `$TMPDIR` (openai/codex#52620), so the grants are always explicit. A
/// grant for an absent `.git` also keeps a sandboxed command from creating one.
fn filesystem(workspace: &Path, policy: &Policy) -> Result<Vec<(String, &'static str)>> {
    let utf8 = |path: &Path, what: &str| {
        path.to_str()
            .map(str::to_owned)
            .with_context(|| format!("{what} must be UTF-8"))
    };
    let mut entries = vec![(utf8(&workspace.join(".git"), "Workspace path")?, "read")];
    for directory in pointed_git_directories(workspace)? {
        entries.push((utf8(&directory, "Git directory path")?, "read"));
    }
    for root in &policy.writable_roots {
        ensure!(root.is_absolute(), "Workspace copy path must be absolute");
        entries.push((utf8(root, "Workspace copy path")?, "write"));
        entries.push((utf8(&root.join(".git"), "Workspace copy path")?, "read"));
    }
    Ok(entries)
}

/// The Git directories a `gitdir:` pointer at `<workspace>/.git` names: its own Git directory
/// and, for a linked worktree, the common Git directory. A `.git` directory, or no `.git`,
/// names none.
fn pointed_git_directories(workspace: &Path) -> Result<Vec<PathBuf>> {
    let marker = match std::fs::read_to_string(workspace.join(".git")) {
        Ok(value) => value,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::IsADirectory
            ) =>
        {
            return Ok(vec![]);
        }
        Err(_) => return Err(anyhow::anyhow!("could not inspect workspace Git metadata")),
    };
    let directory = marker
        .trim()
        .strip_prefix("gitdir: ")
        .context("workspace Git pointer is invalid")?;
    let directory = workspace
        .join(directory)
        .canonicalize()
        .context("could not resolve workspace Git directory")?;
    let common = match std::fs::read_to_string(directory.join("commondir")) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(vec![directory]);
        }
        Err(_) => return Err(anyhow::anyhow!("could not inspect common Git directory")),
    };
    let common = directory
        .join(common.trim())
        .canonicalize()
        .context("could not resolve common Git directory")?;
    Ok(if directory.starts_with(&common) {
        vec![common]
    } else {
        vec![directory, common]
    })
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
        let git = workspace.path().join(".git");
        let git = git.to_str().unwrap();
        assert!(args.contains(&format!(
            "permissions.supertag.filesystem={{ \"{git}\" = \"read\", \"/mnt/data \\\"quoted\\\"\" = \"write\", \"/mnt/data \\\"quoted\\\"/.git\" = \"read\" }}"
        )));
        assert!(args.contains(&"permissions.supertag.extends=\":workspace\"".into()));
        let params = thread_parameters(workspace.path(), &policy, &args)?;
        assert_eq!(
            params["config"]["permissions.supertag.filesystem"],
            serde_json::json!({
                git: "read",
                "/mnt/data \"quoted\"": "write",
                "/mnt/data \"quoted\"/.git": "read",
            })
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

    fn git(directory: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .current_dir(directory)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .args([
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
            ])
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    fn grants(workspace: &Path, policy: &Policy) -> Result<serde_json::Value> {
        let args = arguments(workspace, None, None, policy)?;
        let resumed = thread_parameters(workspace, policy, &args)?;
        Ok(resumed["config"]["permissions.supertag.filesystem"].clone())
    }

    /// Every supertag profile names the Workspace's `.git` read-only, whatever its shape, and a
    /// resumed thread gets the same grants.
    #[test]
    fn every_supertag_profile_keeps_workspace_git_metadata_read_only() -> Result<()> {
        let root = tempfile::tempdir()?;
        let root = root.path().canonicalize()?;
        let at = |path: &Path| path.to_str().unwrap().to_owned();
        for granted in [&["files:write"][..], &["commands:execute"]] {
            let policy = Policy::from_actions(&actions(granted), true)?;
            // No `.git`: the grant still keeps a command from creating one.
            let plain = root.join("plain");
            std::fs::create_dir_all(&plain)?;
            assert_eq!(
                grants(&plain, &policy)?,
                serde_json::json!({at(&plain.join(".git")): "read"})
            );
            // A full clone: its `.git` directory.
            let clone = root.join("clone");
            if !clone.exists() {
                std::fs::create_dir(&clone)?;
                git(&clone, &["init", "--quiet"]);
                git(
                    &clone,
                    &["commit", "--quiet", "--allow-empty", "-m", "initial"],
                );
                git(&clone, &["worktree", "add", "--quiet", "../linked"]);
                git(
                    &root,
                    &[
                        "init",
                        "--quiet",
                        "--separate-git-dir",
                        "separate.git",
                        "separated",
                    ],
                );
            }
            assert_eq!(
                grants(&clone, &policy)?,
                serde_json::json!({at(&clone.join(".git")): "read"})
            );
            // A linked worktree: the pointer file and the common directory, which holds the
            // worktree's own Git directory.
            let linked = root.join("linked");
            assert_eq!(
                grants(&linked, &policy)?,
                serde_json::json!({
                    at(&linked.join(".git")): "read",
                    at(&clone.join(".git")): "read",
                })
            );
            // A separate Git directory outside the Workspace.
            let separated = root.join("separated");
            assert_eq!(
                grants(&separated, &policy)?,
                serde_json::json!({
                    at(&separated.join(".git")): "read",
                    at(&root.join("separate.git")): "read",
                })
            );
        }
        Ok(())
    }

    #[test]
    fn writing_or_running_commands_implies_reading() -> Result<()> {
        for granted in [
            &["files:write"][..],
            &["commands:execute"],
            &["files:write", "commands:execute"],
        ] {
            let policy = Policy::from_actions(&actions(granted), true)?;
            assert_eq!(policy.write, granted.contains(&"files:write"));
            assert_eq!(policy.commands, granted.contains(&"commands:execute"));
        }
        // Codex cannot run without reading the Workspace, so it refuses a Task with no file access.
        assert!(Policy::from_actions(&actions(&["web:search"]), true).is_err());
        Ok(())
    }
}
