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
    /// The Task's path scope, applied by the `supertag` permission profile.
    pub(crate) scope: Option<Scope>,
}

/// A Task's path scope, resolved on this Worker Host.
#[derive(Clone, Default)]
pub(crate) struct Scope {
    pub(crate) files: supertag_protocol::v2::FileScope,
    /// Canonical outside directories: writable, then readable.
    pub(crate) outside_write: Vec<PathBuf>,
    pub(crate) outside_read: Vec<PathBuf>,
    /// The Attempt's output directory, which stays writable when Workspace writes are narrowed.
    pub(crate) output_directory: Option<PathBuf>,
}

impl Scope {
    fn narrows_writes(&self) -> bool {
        !self.files.write.is_empty()
    }
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
                    | "schedule:create"
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
            scope: None,
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

/// The Worker Host user's home from the password database. The adapter gives Codex a private
/// `HOME`, so `$HOME` does not name the directory a path scope's `~/` means.
pub(crate) fn user_home() -> Result<PathBuf> {
    use std::{ffi::CStr, os::unix::ffi::OsStrExt};
    let mut buffer = vec![0_u8; 16 * 1024];
    let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
    let mut found = std::ptr::null_mut();
    // SAFETY: every pointer is valid for the call and the buffer outlives `entry`'s strings.
    let status = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            &mut entry,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut found,
        )
    };
    ensure!(
        status == 0 && !found.is_null() && !entry.pw_dir.is_null(),
        "could not find the Worker Host user's home directory"
    );
    // SAFETY: getpwuid_r succeeded, so pw_dir is a NUL-terminated string inside `buffer`.
    let home = unsafe { CStr::from_ptr(entry.pw_dir) };
    let home = PathBuf::from(std::ffi::OsStr::from_bytes(home.to_bytes()));
    ensure!(
        home.is_absolute(),
        "the Worker Host user's home is not absolute"
    );
    Ok(home)
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
    if policy.commands || policy.write || policy.scope.is_some() {
        // Every Task that writes, runs commands, or has a path scope uses SuperTag's own
        // `supertag` permission profile, so its filesystem table (protected entries, Workspace
        // copies, the path scope) applies whatever the network access.
        // A path scope that narrows Workspace writes starts from `:read-only` and grants each
        // write path explicitly.
        configuration.push("default_permissions=\"supertag\"".into());
        configuration.push(format!(
            "permissions.supertag.extends=\"{}\"",
            if workspace_writable(policy) {
                ":workspace"
            } else {
                ":read-only"
            }
        ));
        if policy.network {
            // web:fetch: direct, unrestricted outbound network, as Codex's legacy
            // `workspace-write` mode with `network_access`. Without the network proxy the
            // profile's network grant leaves sockets open (probed on Codex 0.163.0); the mode
            // only selects the proxy's policy, so it is stated for when one is configured.
            configuration.extend(
                [
                    "permissions.supertag.network.enabled=true",
                    "permissions.supertag.network.mode=\"full\"",
                    "permissions.supertag.network.allow_local_binding=true",
                    "features.network_proxy.enabled=false",
                ]
                .map(str::to_owned),
            );
        } else if policy.commands {
            // Exact legacy profile: permit loopback only for admitted commands and
            // deny external sockets via the limited network proxy's empty allowlist.
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

/// The entries Codex 0.163.0's built-in `:workspace` profile keeps read-only in each writable
/// root, whether or not they exist (probed with `codex sandbox -P :workspace`).
const PROTECTED_ENTRIES: [&str; 4] = [".git", ".codex", ".agents", ".aws"];

/// Filesystem rules of the `supertag` permission profile. In the Workspace and each read-write
/// Workspace copy, every entry Codex protects by default stays read-only: `.git` (a directory, a
/// linked worktree's `gitdir:` file, or absent), `.codex`, `.agents`, and `.aws`. So do the Git
/// directories a `gitdir:` file names. SuperTag and the Worker Host later run `git` there outside
/// the sandbox.
///
/// Codex 0.163.0 protects these entries for its built-in profiles, but a profile that `extends`
/// `:workspace` loses that protection when the Workspace lies under another writable root such as
/// `/tmp` or `$TMPDIR` (openai/codex#52620), so the grants are always explicit. A grant for an
/// absent entry also keeps a sandboxed command from creating it where the Workspace is writable.
fn filesystem(workspace: &Path, policy: &Policy) -> Result<Vec<(String, &'static str)>> {
    let utf8 = |path: &Path, what: &str| {
        path.to_str()
            .map(str::to_owned)
            .with_context(|| format!("{what} must be UTF-8"))
    };
    let mut entries = PROTECTED_ENTRIES
        .iter()
        .map(|name| Ok((utf8(&workspace.join(name), "Workspace path")?, "read")))
        .collect::<Result<Vec<_>>>()?;
    for directory in pointed_git_directories(workspace)? {
        entries.push((utf8(&directory, "Git directory path")?, "read"));
    }
    for root in &policy.writable_roots {
        ensure!(root.is_absolute(), "Workspace copy path must be absolute");
        entries.push((utf8(root, "Workspace copy path")?, "write"));
        for name in PROTECTED_ENTRIES {
            entries.push((utf8(&root.join(name), "Workspace copy path")?, "read"));
        }
    }
    if let Some(scope) = &policy.scope {
        entries.extend(scoped_entries(workspace, policy, scope)?);
    }
    // One grant per path, the strongest: a path scope never weakens a protected entry.
    let strength = |access: &str| match access {
        "deny" => 2,
        "read" => 1,
        _ => 0,
    };
    let mut unique: Vec<(String, &'static str)> = Vec::with_capacity(entries.len());
    for (path, access) in entries {
        match unique.iter_mut().find(|(existing, _)| *existing == path) {
            Some(entry) if strength(access) > strength(entry.1) => entry.1 = access,
            Some(_) => {}
            None => unique.push((path, access)),
        }
    }
    if policy.scope.is_some() && !workspace_writable(policy) {
        unique = without_absent_mount_points(workspace, unique);
    }
    Ok(unique)
}

/// Whether the profile lets the Task write anywhere in the Workspace: it extends `:workspace`.
fn workspace_writable(policy: &Policy) -> bool {
    policy.write && !policy.scope.as_ref().is_some_and(Scope::narrows_writes)
}

/// Drop `read` and `deny` entries for Workspace paths that do not exist, where a path scope
/// leaves the Workspace itself read-only. On Linux, Codex 0.163.0's bubblewrap sandbox creates a mount point
/// for each such entry and fails to start when its parent is read-only.
///
/// An absent path that no write grant covers cannot be created, so its entry adds nothing. One
/// under a write path can be: its `read` entry stays, since bubblewrap mounts that one. A `deny`
/// entry there is dropped on Linux only. The agent can then create that path and read what it
/// wrote, as with a hidden glob Codex snapshots at start, and the delivery check refuses it.
fn without_absent_mount_points(
    workspace: &Path,
    entries: Vec<(String, &'static str)>,
) -> Vec<(String, &'static str)> {
    let writable: Vec<PathBuf> = entries
        .iter()
        .filter(|(path, access)| *access == "write" && !path.starts_with(':'))
        .map(|(path, _)| PathBuf::from(path))
        .collect();
    entries
        .into_iter()
        .filter(|(path, access)| {
            let candidate = Path::new(path);
            if *access == "write"
                || path.contains(['*', '?'])
                || !candidate.starts_with(workspace)
                || candidate.symlink_metadata().is_ok()
            {
                return true;
            }
            let creatable = writable
                .iter()
                .any(|root| candidate != root && candidate.starts_with(root));
            creatable && (*access == "read" || cfg!(not(target_os = "linux")))
        })
        .collect()
}

/// The profile entries for a Task's path scope. SuperTag's pattern semantics, translated:
/// a write path is an exact path or subtree; a read-only entry stays readable; a hidden entry
/// is denied with its whole subtree. A literal deny covers its subtree already; a glob also gets
/// `<glob>/**`, because Codex matches a deny glob against the path itself only. Outside
/// directories are already canonical.
fn scoped_entries(
    workspace: &Path,
    policy: &Policy,
    scope: &Scope,
) -> Result<Vec<(String, &'static str)>> {
    let utf8 = |path: &Path| {
        path.to_str()
            .map(str::to_owned)
            .context("path scope entry must be UTF-8")
    };
    let inside = |entry: &str| workspace.join(entry.trim_end_matches('/'));
    let mut entries = vec![];
    if policy.write && scope.narrows_writes() {
        // The temporary directory stays writable for tools. The Workspace itself is named
        // read-only, which outranks `:tmpdir` when the Workspace lies inside it.
        entries.push((":tmpdir".to_owned(), "write"));
        entries.push((utf8(workspace)?, "read"));
        for entry in &scope.files.write {
            entries.push((utf8(&inside(entry))?, "write"));
        }
        if let Some(output) = &scope.output_directory {
            entries.push((utf8(output)?, "write"));
        }
    }
    if policy.write {
        for path in &scope.outside_write {
            entries.push((utf8(path)?, "write"));
        }
    }
    for path in scope.outside_read.iter().chain(if policy.write {
        &[][..]
    } else {
        &scope.outside_write[..]
    }) {
        entries.push((utf8(path)?, "read"));
    }
    for entry in &scope.files.read_only {
        entries.push((utf8(&inside(entry))?, "read"));
    }
    for entry in &scope.files.hidden {
        let path = utf8(&inside(entry))?;
        // A literal deny already covers its subtree. Adding `<literal>/**` would make Linux's
        // bubblewrap mask each file inside a directory it has already masked, which fails to
        // start the sandbox (Codex 0.163.0).
        if entry.contains(['*', '?']) {
            entries.push((format!("{path}/**"), "deny"));
        }
        entries.push((path, "deny"));
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
        let copy = "/mnt/data \"quoted\"";
        let mut expected = protected(workspace.path());
        expected.push((copy.into(), "write"));
        expected.extend(protected(Path::new(copy)));
        let listed = expected
            .iter()
            .map(|(path, access)| {
                format!("{} = \"{access}\"", serde_json::to_string(path).unwrap())
            })
            .collect::<Vec<_>>();
        assert!(args.contains(&format!(
            "permissions.supertag.filesystem={{ {} }}",
            listed.join(", ")
        )));
        assert!(args.contains(&"permissions.supertag.extends=\":workspace\"".into()));
        let params = thread_parameters(workspace.path(), &policy, &args)?;
        assert_eq!(
            params["config"]["permissions.supertag.filesystem"],
            object(expected, &[])
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

    /// The entries Codex protects by default in `root`, in grant order.
    fn protected(root: &Path) -> Vec<(String, &'static str)> {
        PROTECTED_ENTRIES
            .iter()
            .map(|name| (root.join(name).to_str().unwrap().to_owned(), "read"))
            .collect()
    }

    /// `entries` and then each of `extra` read-only, as a JSON object.
    fn object(mut entries: Vec<(String, &'static str)>, extra: &[&Path]) -> serde_json::Value {
        entries.extend(
            extra
                .iter()
                .map(|path| (path.to_str().unwrap().to_owned(), "read")),
        );
        serde_json::Value::Object(
            entries
                .into_iter()
                .map(|(path, access)| (path, access.into()))
                .collect(),
        )
    }

    fn grants(workspace: &Path, policy: &Policy) -> Result<serde_json::Value> {
        let args = arguments(workspace, None, None, policy)?;
        let resumed = thread_parameters(workspace, policy, &args)?;
        Ok(resumed["config"]["permissions.supertag.filesystem"].clone())
    }

    /// Every supertag profile names the Workspace's `.git`, whatever its shape, and the other
    /// entries Codex protects by default read-only, and a
    /// resumed thread gets the same grants.
    #[test]
    fn every_supertag_profile_keeps_workspace_git_metadata_read_only() -> Result<()> {
        let root = tempfile::tempdir()?;
        let root = root.path().canonicalize()?;
        for granted in [&["files:write"][..], &["commands:execute"]] {
            let policy = Policy::from_actions(&actions(granted), true)?;
            // No `.git`: the grant still keeps a command from creating one.
            let plain = root.join("plain");
            std::fs::create_dir_all(&plain)?;
            assert_eq!(grants(&plain, &policy)?, object(protected(&plain), &[]));
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
            assert_eq!(grants(&clone, &policy)?, object(protected(&clone), &[]));
            // A linked worktree: the pointer file and the common directory, which holds the
            // worktree's own Git directory.
            let linked = root.join("linked");
            assert_eq!(
                grants(&linked, &policy)?,
                object(protected(&linked), &[&clone.join(".git")])
            );
            // A separate Git directory outside the Workspace.
            let separated = root.join("separated");
            assert_eq!(
                grants(&separated, &policy)?,
                object(protected(&separated), &[&root.join("separate.git")])
            );
        }
        Ok(())
    }

    fn scope(files: supertag_protocol::v2::FileScope) -> Scope {
        Scope {
            files,
            ..Default::default()
        }
    }

    /// A path scope maps onto the profile: narrowed writes start from `:read-only`, read-only
    /// entries stay `read`, hidden globs deny their subtree too, and the protected entries
    /// stay. A resumed thread gets the same table.
    #[test]
    fn a_path_scope_extends_the_supertag_profile() -> Result<()> {
        let workspace = tempfile::tempdir()?;
        let ws = workspace.path().canonicalize()?;
        let at = |entry: &str| ws.join(entry).to_str().unwrap().to_owned();
        // Under a read-only Workspace only existing entries are listed; see the absent case below.
        std::fs::create_dir_all(ws.join(".git"))?;
        std::fs::create_dir_all(ws.join("secrets"))?;
        let existing_protected = || vec![(at(".git"), "read")];
        let mut policy = Policy::from_actions(
            &actions(&["files:read", "files:write", "commands:execute"]),
            true,
        )?;
        let mut narrowed = scope(supertag_protocol::v2::FileScope {
            write: vec!["src/".into(), "package.json".into()],
            read_only: vec!["src/generated/".into(), ".git/".into()],
            hidden: vec!["**/.env".into(), "secrets/".into()],
            ..Default::default()
        });
        narrowed.outside_write = vec![PathBuf::from("/opt/cache")];
        narrowed.outside_read = vec![PathBuf::from("/opt/data")];
        narrowed.output_directory = Some(ws.join(".supertag/outputs/a"));
        policy.scope = Some(narrowed);
        let args = arguments(&ws, None, None, &policy)?;
        assert!(args.contains(&"permissions.supertag.extends=\":read-only\"".into()));
        let mut expected = existing_protected();
        expected.extend([
            (":tmpdir".to_owned(), "write"),
            (ws.to_str().unwrap().to_owned(), "read"),
            (at("src"), "write"),
            (at("package.json"), "write"),
            (at(".supertag/outputs/a"), "write"),
            ("/opt/cache".to_owned(), "write"),
            ("/opt/data".to_owned(), "read"),
            (at("src/generated"), "read"),
            (format!("{}/**", at("**/.env")), "deny"),
            (at("**/.env"), "deny"),
            (at("secrets"), "deny"),
        ]);
        assert_eq!(grants(&ws, &policy)?, object(expected.clone(), &[]));
        // A whole-Workspace write keeps `:workspace` and adds only the narrowing entries.
        policy.scope = Some(scope(supertag_protocol::v2::FileScope {
            read_only: vec!["Cargo.lock".into()],
            ..Default::default()
        }));
        let args = arguments(&ws, None, None, &policy)?;
        assert!(args.contains(&"permissions.supertag.extends=\":workspace\"".into()));
        let mut expected = protected(&ws);
        expected.push((at("Cargo.lock"), "read"));
        assert_eq!(grants(&ws, &policy)?, object(expected, &[]));
        // Hiding `.git` strengthens its protected entry instead of duplicating it.
        policy.scope = Some(scope(supertag_protocol::v2::FileScope {
            hidden: vec![".git/".into()],
            ..Default::default()
        }));
        let table = grants(&ws, &policy)?;
        assert_eq!(table[at(".git")], "deny");
        // A read-only Task with a scope uses the profile too, so hidden entries apply.
        let mut reader = Policy::from_actions(&actions(&["files:read"]), false)?;
        reader.scope = Some(scope(supertag_protocol::v2::FileScope {
            hidden: vec!["secrets/".into()],
            ..Default::default()
        }));
        let args = arguments(&ws, None, None, &reader)?;
        assert!(args.contains(&"permissions.supertag.extends=\":read-only\"".into()));
        assert!(!args.contains(&"sandbox_mode=\"read-only\"".into()));
        // web:fetch keeps the same profile and table and adds direct outbound network.
        let mut fetch = Policy::from_actions(
            &actions(&["files:write", "commands:execute", "web:fetch"]),
            true,
        )?;
        fetch.scope = Some(scope(supertag_protocol::v2::FileScope {
            write: vec!["src/".into()],
            hidden: vec!["secrets/".into()],
            ..Default::default()
        }));
        let args = arguments(&ws, None, None, &fetch)?;
        assert!(args.contains(&"permissions.supertag.extends=\":read-only\"".into()));
        let mut expected = existing_protected();
        expected.extend([
            (":tmpdir".to_owned(), "write"),
            (ws.to_str().unwrap().to_owned(), "read"),
            (at("src"), "write"),
            (at("secrets"), "deny"),
        ]);
        assert_eq!(grants(&ws, &fetch)?, object(expected, &[]));
        Ok(())
    }

    /// web:fetch moves onto the `supertag` profile: direct outbound network without the proxy,
    /// no legacy `sandbox_mode`, and the same filesystem table, including Workspace copies. A
    /// resumed thread reapplies all of it.
    #[test]
    fn web_fetch_grants_network_on_the_supertag_profile() -> Result<()> {
        let workspace = tempfile::tempdir()?;
        let ws = workspace.path().canonicalize()?;
        let copy = PathBuf::from("/mnt/copy");
        for granted in [
            &["files:write", "web:fetch"][..],
            &["files:write", "commands:execute", "web:fetch"],
        ] {
            let mut policy = Policy::from_actions(&actions(granted), true)?;
            policy.writable_roots = vec![copy.clone()];
            let args = arguments(&ws, None, None, &policy)?;
            for expected in [
                "default_permissions=\"supertag\"",
                "permissions.supertag.extends=\":workspace\"",
                "permissions.supertag.network.enabled=true",
                "permissions.supertag.network.mode=\"full\"",
                "features.network_proxy.enabled=false",
            ] {
                assert!(args.contains(&expected.to_owned()), "{expected}: {args:?}");
            }
            assert!(
                !args.iter().any(|arg| arg.starts_with("sandbox_mode")
                    || arg.starts_with("sandbox_workspace_write"))
            );
            let mut expected = protected(&ws);
            expected.push((copy.to_str().unwrap().to_owned(), "write"));
            expected.extend(protected(&copy));
            assert_eq!(grants(&ws, &policy)?, object(expected, &[]));
            let resumed = thread_parameters(&ws, &policy, &args)?;
            assert!(resumed.get("sandbox").is_none());
            assert_eq!(
                resumed["config"]["permissions.supertag.network.enabled"],
                true
            );
            assert_eq!(resumed["config"]["features.network_proxy.enabled"], false);
        }
        Ok(())
    }

    /// Under a read-only Workspace, an entry for an absent path is listed only when a write path
    /// covers it, so it could be created: Codex's Linux sandbox cannot mount over an absent path
    /// in a read-only directory. A covered absent hidden path stays denied except on Linux.
    #[test]
    fn a_read_only_workspace_lists_only_entries_that_exist_or_can_be_created() -> Result<()> {
        let workspace = tempfile::tempdir()?;
        let ws = workspace.path().canonicalize()?;
        let at = |entry: &str| ws.join(entry).to_str().unwrap().to_owned();
        std::fs::create_dir_all(ws.join("src"))?;
        std::fs::write(ws.join(".env"), "KEY=1\n")?;
        let mut policy =
            Policy::from_actions(&actions(&["files:write", "commands:execute"]), true)?;
        policy.scope = Some(scope(supertag_protocol::v2::FileScope {
            write: vec!["src/".into()],
            read_only: vec!["src/generated/".into(), "docs/".into()],
            hidden: vec![
                ".env".into(),
                "secrets/".into(),
                "src/secret".into(),
                "**/.npmrc".into(),
            ],
            ..Default::default()
        }));
        let mut expected = vec![
            (":tmpdir".to_owned(), "write"),
            (ws.to_str().unwrap().to_owned(), "read"),
            (at("src"), "write"),
            (at("src/generated"), "read"),
            (at(".env"), "deny"),
        ];
        if cfg!(not(target_os = "linux")) {
            expected.push((at("src/secret"), "deny"));
        }
        expected.extend([
            (format!("{}/**", at("**/.npmrc")), "deny"),
            (at("**/.npmrc"), "deny"),
        ]);
        assert_eq!(grants(&ws, &policy)?, object(expected, &[]));
        // A whole-Workspace write keeps every entry: Codex mounts over absent paths there.
        policy.scope = Some(scope(supertag_protocol::v2::FileScope {
            hidden: vec!["secrets/".into()],
            ..Default::default()
        }));
        let mut expected = protected(&ws);
        expected.push((at("secrets"), "deny"));
        assert_eq!(grants(&ws, &policy)?, object(expected, &[]));
        Ok(())
    }

    #[test]
    fn finds_the_users_home_in_the_password_database() -> Result<()> {
        assert!(user_home()?.is_absolute());
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

    #[test]
    fn schedule_create_offers_tools_and_changes_no_sandbox_permission() -> Result<()> {
        let plain = Policy::from_actions(&actions(&["files:read"]), false)?;
        let scheduling = Policy::from_actions(&actions(&["files:read", "schedule:create"]), false)?;
        assert_eq!(
            (
                scheduling.write,
                scheduling.commands,
                scheduling.search,
                scheduling.network
            ),
            (plain.write, plain.commands, plain.search, plain.network)
        );
        Ok(())
    }
}
