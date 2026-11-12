use std::{ffi::OsString, io::Read, path::PathBuf, time::Duration};

use anyhow::{Context, Result, ensure};
use clap::{Args, ValueEnum};
use prost::Message;
use supertag_codex_adapter::CodexOptions;
use supertag_protocol::v2::{AdapterBootstrap, HarnessKind};
use supertag_worker_host::{
    ADAPTER_STATE_DIRECTORY, WORKSPACE_DIRECTORY, WorkspaceMapping, provider_environment,
};

#[derive(Clone, Copy, ValueEnum)]
pub enum Harness {
    Codex,
    ClaudeCode,
    #[value(name = "openai-agents")]
    OpenaiAgents,
    #[value(name = "opencode")]
    Opencode,
    Cursor,
}

impl Harness {
    fn name(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::ClaudeCode => "claude-code",
            Self::OpenaiAgents => "openai-agents",
            Self::Opencode => "opencode",
            Self::Cursor => "cursor",
        }
    }

    pub fn kind(self) -> HarnessKind {
        match self {
            Self::Codex => HarnessKind::Codex,
            Self::ClaudeCode => HarnessKind::ClaudeCode,
            Self::OpenaiAgents => HarnessKind::OpenaiAgents,
            Self::Opencode => HarnessKind::Opencode,
            Self::Cursor => HarnessKind::Cursor,
        }
    }
}

#[derive(Args)]
pub struct AdapterOptions {
    /// Executable that implements the SuperTag harness protocol.
    #[arg(long, conflicts_with = "harness", required_unless_present = "harness")]
    adapter: Option<PathBuf>,
    #[arg(long, requires = "adapter", allow_hyphen_values = true)]
    adapter_arg: Vec<OsString>,
    /// Built-in harness to use for Tasks on this host.
    #[arg(long)]
    harness: Option<Harness>,
    /// Node or Python interpreter used by a language adapter.
    #[arg(long, requires = "harness")]
    harness_runtime: Option<PathBuf>,
    /// JavaScript or Python application entrypoint.
    #[arg(long, requires = "harness")]
    harness_entrypoint: Option<PathBuf>,
    #[arg(long, requires = "harness")]
    harness_model: Option<String>,
    /// Additional model IDs this Worker Host can run.
    #[arg(long, requires = "harness", value_delimiter = ',')]
    harness_models: Vec<String>,
    /// Node interpreter for the Cursor SDK adapter application.
    #[arg(long, requires = "harness", conflicts_with = "harness_runtime")]
    cursor_node: Option<PathBuf>,
    /// Compiled JavaScript entrypoint for the Cursor SDK adapter.
    #[arg(long, requires = "harness", conflicts_with = "harness_entrypoint")]
    cursor_adapter: Option<PathBuf>,
    /// Node interpreter for the OpenCode adapter application.
    #[arg(long, requires = "harness", conflicts_with = "harness_runtime")]
    opencode_node: Option<PathBuf>,
    /// Compiled JavaScript entrypoint for the OpenCode adapter.
    #[arg(long, requires = "harness", conflicts_with = "harness_entrypoint")]
    opencode_adapter: Option<PathBuf>,
    /// Absolute OpenCode executable path. Otherwise resolve opencode on PATH.
    #[arg(long, requires = "harness")]
    opencode_path: Option<PathBuf>,
    /// Owner-only API credential file. Also accepts SUPERTAG_OPENCODE_AUTH_FILE.
    #[arg(long, requires = "harness")]
    opencode_auth_file: Option<PathBuf>,
    /// Allow OpenCode or Cursor commands without an operating-system sandbox.
    #[arg(long, requires = "harness")]
    allow_unsandboxed_commands: bool,
    /// Claude executable used by the Agent SDK.
    #[arg(long, requires = "harness")]
    claude_path: Option<PathBuf>,
    #[arg(long, requires = "harness")]
    codex_path: Option<PathBuf>,
    #[arg(long, requires = "harness")]
    codex_model: Option<String>,
    /// Existing directory for read-only Tasks. Otherwise each Task gets its own directory.
    #[arg(long, requires = "harness", conflicts_with = "workspace_id")]
    codex_workspace: Option<PathBuf>,
    /// Repository identity that this host can prepare for accepted Tasks.
    #[arg(long, requires = "workspace_source")]
    workspace_id: Option<String>,
    /// Trusted local Git source; Tasks run in separate pinned checkouts.
    #[arg(long, requires = "workspace_id")]
    workspace_source: Option<PathBuf>,
}

impl AdapterOptions {
    pub fn workspace_mapping(&self) -> Option<WorkspaceMapping> {
        self.workspace_id
            .as_ref()
            .zip(self.workspace_source.as_ref())
            .map(|(workspace_id, source)| WorkspaceMapping {
                workspace_id: workspace_id.clone(),
                source: source.clone(),
            })
    }

    pub fn harness_kind(&self) -> HarnessKind {
        self.harness.map_or(HarnessKind::Unspecified, Harness::kind)
    }

    pub fn provider_model(&self) -> Option<String> {
        if matches!(self.harness, Some(Harness::Opencode)) {
            self.harness_model.clone()
        } else {
            None
        }
    }

    pub fn execution_profile(&self) -> Result<supertag_protocol::v2::HarnessExecutionProfile> {
        let default_model = self
            .codex_model
            .clone()
            .or_else(|| self.harness_model.clone());
        let mut model_ids = self.harness_models.clone();
        model_ids.extend(default_model.iter().cloned());
        model_ids.sort_unstable();
        model_ids.dedup();
        ensure!(
            model_ids.len() <= 128
                && model_ids.iter().all(|model| !model.is_empty()
                    && model.len() <= 256
                    && !model
                        .chars()
                        .any(|value| value.is_control() || value.is_whitespace())),
            "Worker Host model IDs must be bounded identifiers"
        );
        if matches!(self.harness, Some(Harness::Opencode)) {
            let provider = supertag_worker_host::validate_opencode_model(
                default_model
                    .as_deref()
                    .context("OpenCode requires --harness-model")?,
            )?;
            for model in &model_ids {
                ensure!(
                    supertag_worker_host::validate_opencode_model(model)? == provider,
                    "OpenCode model IDs must use the Worker Host's selected provider"
                );
            }
        }
        Ok(supertag_protocol::v2::HarnessExecutionProfile {
            model_ids,
            default_model,
            allow_unsandboxed_commands: self.allow_unsandboxed_commands,
            remote_file_workspace: false,
        })
    }
    pub fn provider_environment(&self) -> Result<&'static [&'static str]> {
        supertag_worker_host::provider_environment_for(
            self.harness_kind(),
            self.harness_model.as_deref(),
        )
    }
    fn auth_file(&self) -> Option<PathBuf> {
        self.opencode_auth_file.clone().or_else(|| {
            if matches!(self.harness, Some(Harness::Opencode)) {
                std::env::var_os("SUPERTAG_OPENCODE_AUTH_FILE").map(PathBuf::from)
            } else {
                None
            }
        })
    }
    pub fn worker_args(&self) -> Vec<OsString> {
        if let Some(path) = &self.adapter {
            let mut args = vec![OsString::from("--adapter"), path.as_os_str().to_owned()];
            for value in &self.adapter_arg {
                let mut arg = OsString::from("--adapter-arg=");
                arg.push(value);
                args.push(arg);
            }
            self.mapping_args(&mut args);
            return args;
        }
        let mut args = vec![
            OsString::from("--harness"),
            OsString::from(
                self.harness
                    .expect("Clap requires a harness or adapter")
                    .name(),
            ),
        ];
        for (flag, value) in [
            (
                "--harness-runtime",
                self.harness_runtime
                    .as_deref()
                    .map(std::path::Path::as_os_str),
            ),
            (
                "--harness-entrypoint",
                self.harness_entrypoint
                    .as_deref()
                    .map(std::path::Path::as_os_str),
            ),
            (
                "--harness-model",
                self.harness_model.as_deref().map(std::ffi::OsStr::new),
            ),
            (
                "--claude-path",
                self.claude_path.as_deref().map(std::path::Path::as_os_str),
            ),
        ] {
            if let Some(value) = value {
                args.extend([flag.into(), value.to_owned()]);
            }
        }
        for (flag, value) in [
            ("--cursor-node", self.cursor_node.as_ref()),
            ("--cursor-adapter", self.cursor_adapter.as_ref()),
            ("--opencode-node", self.opencode_node.as_ref()),
            ("--opencode-adapter", self.opencode_adapter.as_ref()),
            ("--opencode-path", self.opencode_path.as_ref()),
            ("--opencode-auth-file", self.auth_file().as_ref()),
        ] {
            if let Some(value) = value {
                args.extend([flag.into(), value.as_os_str().to_owned()]);
            }
        }
        if self.allow_unsandboxed_commands {
            args.push("--allow-unsandboxed-commands".into());
        }
        for model in &self.harness_models {
            args.extend(["--harness-models".into(), model.into()]);
        }
        if let Some(path) = &self.codex_path {
            args.extend([OsString::from("--codex-path"), path.as_os_str().to_owned()]);
        }
        if let Some(model) = &self.codex_model {
            args.extend([OsString::from("--codex-model"), OsString::from(model)]);
        }
        if let Some(workspace) = &self.codex_workspace {
            args.extend([
                OsString::from("--codex-workspace"),
                workspace.as_os_str().to_owned(),
            ]);
        }
        self.mapping_args(&mut args);
        args
    }

    fn mapping_args(&self, args: &mut Vec<OsString>) {
        if let Some(mapping) = self.workspace_mapping() {
            args.extend([
                OsString::from("--workspace-id"),
                mapping.workspace_id.into(),
                OsString::from("--workspace-source"),
                mapping.source.into_os_string(),
            ]);
        }
    }

    pub fn launch(self, timeout_seconds: u64) -> Result<(PathBuf, Vec<OsString>)> {
        self.provider_environment()?;
        let auth_file = self.auth_file();
        ensure!(
            matches!(self.harness, Some(Harness::Opencode))
                || (self.opencode_node.is_none()
                    && self.opencode_adapter.is_none()
                    && self.opencode_path.is_none()
                    && auth_file.is_none()),
            "OpenCode-specific options require --harness opencode"
        );
        ensure!(
            matches!(self.harness, Some(Harness::Cursor))
                || (self.cursor_node.is_none() && self.cursor_adapter.is_none()),
            "Cursor-specific options require --harness cursor"
        );
        ensure!(
            !self.allow_unsandboxed_commands
                || matches!(self.harness, Some(Harness::Opencode | Harness::Cursor)),
            "--allow-unsandboxed-commands requires --harness opencode or cursor"
        );
        if let Some(path) = self.adapter {
            return Ok((executable_path(path)?, self.adapter_arg));
        }
        match self.harness.context("select a harness or an adapter")? {
            Harness::Codex => {
                ensure!(
                    self.harness_runtime.is_none()
                        && self.harness_entrypoint.is_none()
                        && self.claude_path.is_none(),
                    "use --codex-path to configure the Codex executable"
                );
                ensure!(
                    self.codex_model.is_none() || self.harness_model.is_none(),
                    "select one Codex model"
                );
                let mut args = vec![
                    "__codex-adapter".into(),
                    "--executable".into(),
                    executable_path(self.codex_path.unwrap_or_else(|| "codex".into()))?
                        .into_os_string(),
                    "--timeout-seconds".into(),
                    timeout_seconds.to_string().into(),
                ];
                if let Some(model) = self.codex_model.or(self.harness_model) {
                    args.extend(["--model".into(), model.into()]);
                }
                if let Some(workspace) = self.codex_workspace {
                    args.extend([
                        "--workspace".into(),
                        workspace.canonicalize()?.into_os_string(),
                    ]);
                }
                Ok((std::env::current_exe()?, args))
            }
            Harness::Opencode => {
                ensure!(
                    self.codex_path.is_none()
                        && self.codex_model.is_none()
                        && self.codex_workspace.is_none()
                        && self.claude_path.is_none(),
                    "other harness options cannot configure OpenCode"
                );
                let entrypoint = self
                    .opencode_adapter
                    .or(self.harness_entrypoint)
                    .context("--opencode-adapter is required for OpenCode")?;
                ensure!(
                    entrypoint.is_file(),
                    "OpenCode adapter entrypoint is unavailable"
                );
                let executable = opencode_executable(self.opencode_path)?;
                let mut args = vec![
                    entrypoint.canonicalize()?.into_os_string(),
                    "--executable".into(),
                    executable.into_os_string(),
                    "--model".into(),
                    self.harness_model.expect("validated model").into(),
                    "--timeout-seconds".into(),
                    timeout_seconds.to_string().into(),
                ];
                if let Some(path) = auth_file {
                    ensure!(
                        path.is_absolute(),
                        "OpenCode auth file path must be absolute"
                    );
                    ensure!(
                        std::fs::symlink_metadata(&path)?.file_type().is_file(),
                        "OpenCode auth file must be a regular file without a symlink"
                    );
                    args.extend(["--auth-file".into(), path.into_os_string()]);
                }
                if self.allow_unsandboxed_commands {
                    args.push("--allow-unsandboxed-commands".into());
                }
                Ok((
                    interpreter_path(
                        self.opencode_node
                            .or(self.harness_runtime)
                            .unwrap_or_else(|| "node".into()),
                    )?,
                    args,
                ))
            }
            Harness::Cursor => {
                ensure!(
                    self.codex_path.is_none()
                        && self.codex_model.is_none()
                        && self.codex_workspace.is_none()
                        && self.claude_path.is_none(),
                    "other harness options cannot configure Cursor"
                );
                let entrypoint = self
                    .cursor_adapter
                    .or(self.harness_entrypoint)
                    .context("--cursor-adapter is required for Cursor")?;
                ensure!(
                    entrypoint.is_file(),
                    "Cursor adapter entrypoint is unavailable"
                );
                let mut args = vec![entrypoint.canonicalize()?.into_os_string()];
                if let Some(model) = self.harness_model {
                    ensure!(
                        !model.is_empty()
                            && model.len() <= 256
                            && !model.chars().any(|c| c.is_whitespace() || c.is_control()),
                        "Cursor model must be a bounded model identifier"
                    );
                    args.extend(["--model".into(), model.into()]);
                }
                args.extend([
                    "--timeout-seconds".into(),
                    timeout_seconds.to_string().into(),
                ]);
                if self.allow_unsandboxed_commands {
                    args.push("--allow-unsandboxed-commands".into());
                }
                Ok((
                    interpreter_path(
                        self.cursor_node
                            .or(self.harness_runtime)
                            .unwrap_or_else(|| "node".into()),
                    )?,
                    args,
                ))
            }
            harness => {
                ensure!(
                    self.codex_path.is_none()
                        && self.codex_model.is_none()
                        && self.codex_workspace.is_none(),
                    "Codex-specific options require --harness codex"
                );
                let mut args = Vec::new();
                let runtime = match harness {
                    Harness::ClaudeCode => {
                        let entrypoint = self
                            .harness_entrypoint
                            .context("--harness-entrypoint is required for Claude Code")?;
                        args.push(
                            entrypoint
                                .canonicalize()
                                .context("resolve Claude Code adapter entrypoint")?
                                .into_os_string(),
                        );
                        if let Some(path) = self.claude_path {
                            args.extend([
                                "--executable".into(),
                                executable_path(path)?.into_os_string(),
                            ]);
                        }
                        "node"
                    }
                    Harness::OpenaiAgents => {
                        ensure!(
                            self.claude_path.is_none(),
                            "--claude-path requires --harness claude-code"
                        );
                        args.push("-I".into());
                        if let Some(entrypoint) = self.harness_entrypoint {
                            args.push(
                                entrypoint
                                    .canonicalize()
                                    .context("resolve OpenAI Agents adapter entrypoint")?
                                    .into_os_string(),
                            );
                        } else {
                            args.extend(["-m".into(), "supertag.openai_agents_adapter".into()]);
                        }
                        "python3"
                    }
                    Harness::Codex | Harness::Opencode | Harness::Cursor => unreachable!(),
                };
                if let Some(model) = self.harness_model {
                    args.extend(["--model".into(), model.into()]);
                }
                args.extend([
                    "--timeout-seconds".into(),
                    timeout_seconds.to_string().into(),
                ]);
                Ok((
                    interpreter_path(self.harness_runtime.unwrap_or_else(|| runtime.into()))?,
                    args,
                ))
            }
        }
    }
}

fn opencode_executable(configured: Option<PathBuf>) -> Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let path = if let Some(path) = configured {
        ensure!(path.is_absolute(), "--opencode-path must be absolute");
        path
    } else {
        std::env::var_os("PATH")
            .and_then(|paths| {
                std::env::split_paths(&paths)
                    .map(|directory| directory.join("opencode"))
                    .find(|path| {
                        path.is_file()
                            && std::fs::metadata(path)
                                .is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
                    })
            })
            .context("OpenCode executable is unavailable; configure --opencode-path")?
    };
    let metadata = std::fs::metadata(&path).context("OpenCode executable is unavailable")?;
    ensure!(
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0,
        "OpenCode executable must be an executable regular file"
    );
    Ok(path.canonicalize()?)
}

// Task execution changes cwd to its isolated checkout. Resolve explicit local
// executable paths while the CLI still has the operator's original cwd.
fn executable_path(path: PathBuf) -> Result<PathBuf> {
    if path.components().count() > 1 || path.is_absolute() || path.exists() {
        path.canonicalize()
            .context("adapter executable is unavailable")
    } else {
        Ok(path)
    }
}

// Retain the executable leaf for Python virtual environments. Resolving the
// symlink would select the system interpreter and bypass the venv packages.
fn interpreter_path(path: PathBuf) -> Result<PathBuf> {
    if path.components().count() > 1 || path.is_absolute() || path.exists() {
        ensure!(path.is_file(), "adapter interpreter is unavailable");
        Ok(std::path::absolute(path)?)
    } else {
        Ok(path)
    }
}

#[derive(Args)]
pub struct CodexAdapterArgs {
    #[arg(long)]
    executable: PathBuf,
    #[arg(long)]
    workspace: Option<PathBuf>,
    #[arg(long)]
    model: Option<String>,
    #[arg(long)]
    timeout_seconds: u64,
}

pub async fn run_codex(args: CodexAdapterArgs) -> Result<()> {
    const MAX_BOOTSTRAP: usize = 4096;
    let mut bytes = Vec::new();
    std::io::stdin()
        .take((MAX_BOOTSTRAP + 1) as u64)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_BOOTSTRAP,
        "adapter bootstrap exceeds its size limit"
    );
    let bootstrap =
        AdapterBootstrap::decode(bytes.as_slice()).context("decode adapter bootstrap")?;
    let state_directory = std::env::var_os(ADAPTER_STATE_DIRECTORY)
        .map(PathBuf::from)
        .context("guarded Codex Attempt state is required")?;
    let isolated = std::env::var_os(WORKSPACE_DIRECTORY)
        .map(PathBuf::from)
        .context("guarded Codex workspace is required")?;
    ensure!(
        args.workspace.is_none() || isolated == state_directory.join("workspace"),
        "a prepared Task workspace cannot be overridden"
    );
    let allow_workspace_write = args.workspace.is_none();
    let workspace = args.workspace.unwrap_or(isolated);
    let environment = provider_environment(HarnessKind::Codex)
        .iter()
        .copied()
        .chain(["PATH", "TMPDIR", "LANG"])
        .filter_map(|name| std::env::var_os(name).map(|value| (OsString::from(name), value)))
        .collect();
    supertag_codex_adapter::run(
        CodexOptions {
            executable: args.executable,
            workspace,
            model: args.model,
            state_directory,
            timeout: Duration::from_secs(args.timeout_seconds),
            environment,
            allow_workspace_write,
        },
        bootstrap,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use std::os::unix::fs::{PermissionsExt, symlink};
    #[derive(Parser)]
    struct Command {
        #[command(flatten)]
        options: AdapterOptions,
    }
    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let binary = d.path().join("opencode");
        let entry = d.path().join("adapter.js");
        let node = d.path().join("node");
        for file in [&binary, &entry, &node] {
            std::fs::write(file, "fixture").unwrap();
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        (d, binary, entry, node)
    }
    fn args(
        binary: &std::path::Path,
        entry: &std::path::Path,
        node: &std::path::Path,
    ) -> Vec<OsString> {
        vec![
            "test".into(),
            "--harness".into(),
            "opencode".into(),
            "--opencode-path".into(),
            binary.into(),
            "--opencode-adapter".into(),
            entry.into(),
            "--opencode-node".into(),
            node.into(),
            "--harness-model".into(),
            "openai/fixture-model".into(),
        ]
    }
    #[test]
    fn opencode_launch_and_local_host_forward_exact_explicit_configuration() {
        let (_d, binary, entry, node) = fixture();
        let original = args(&binary, &entry, &node);
        let command = Command::try_parse_from(original).unwrap();
        assert_eq!(command.options.harness_kind(), HarnessKind::Opencode);
        assert_eq!(
            command.options.provider_environment().unwrap(),
            ["OPENAI_API_KEY"]
        );
        assert_eq!(
            command.options.provider_model().as_deref(),
            Some("openai/fixture-model")
        );
        let forwarded = command.options.worker_args();
        let mut nested = vec![OsString::from("test")];
        nested.extend(forwarded);
        let next = Command::try_parse_from(nested).unwrap();
        let (runtime, arguments) = next.options.launch(42).unwrap();
        assert_eq!(runtime, node);
        assert_eq!(
            arguments,
            vec![
                entry.canonicalize().unwrap().into_os_string(),
                "--executable".into(),
                binary.canonicalize().unwrap().into_os_string(),
                "--model".into(),
                "openai/fixture-model".into(),
                "--timeout-seconds".into(),
                "42".into()
            ]
        );
    }
    #[test]
    fn opencode_rejects_relative_executable_auth_symlink_and_foreign_options() {
        let (d, binary, entry, node) = fixture();
        let mut invalid = args(&binary, &entry, &node);
        invalid[4] = "relative/opencode".into();
        assert!(
            Command::try_parse_from(invalid)
                .unwrap()
                .options
                .launch(1)
                .is_err()
        );
        let auth = d.path().join("auth.json");
        std::fs::write(&auth, "{}").unwrap();
        let link = d.path().join("auth-link.json");
        symlink(&auth, &link).unwrap();
        let mut invalid = args(&binary, &entry, &node);
        invalid.extend(["--opencode-auth-file".into(), link.into_os_string()]);
        assert!(
            Command::try_parse_from(invalid)
                .unwrap()
                .options
                .launch(1)
                .is_err()
        );
        let mut invalid = args(&binary, &entry, &node);
        invalid.extend(["--claude-path".into(), binary.into_os_string()]);
        assert!(
            Command::try_parse_from(invalid)
                .unwrap()
                .options
                .launch(1)
                .is_err()
        );
        let mut invalid = args(&node, &entry, &node);
        invalid[10] = "invalid-model".into();
        assert!(
            Command::try_parse_from(invalid)
                .unwrap()
                .options
                .launch(1)
                .is_err()
        );
    }
    #[test]
    fn opencode_command_opt_in_is_explicit_and_preserved_for_local_host() {
        let (_d, binary, entry, node) = fixture();
        let mut opted_in = args(&binary, &entry, &node);
        opted_in.push("--allow-unsandboxed-commands".into());
        let command = Command::try_parse_from(opted_in).unwrap();
        let mut forwarded = vec![OsString::from("test")];
        forwarded.extend(command.options.worker_args());
        let command = Command::try_parse_from(forwarded).unwrap();
        let (_, arguments) = command.options.launch(42).unwrap();
        assert_eq!(arguments.last().unwrap(), "--allow-unsandboxed-commands");

        let other =
            Command::try_parse_from(["test", "--harness", "codex", "--allow-unsandboxed-commands"])
                .unwrap();
        assert!(other.options.launch(42).is_err());
    }

    #[test]
    fn cursor_launch_preserves_explicit_configuration_and_only_its_key() {
        let (_d, _binary, entry, node) = fixture();
        let command = Command::try_parse_from(vec![
            OsString::from("test"),
            "--harness".into(),
            "cursor".into(),
            "--cursor-node".into(),
            node.clone().into_os_string(),
            "--cursor-adapter".into(),
            entry.clone().into_os_string(),
            "--harness-model".into(),
            "fixture-model".into(),
            "--allow-unsandboxed-commands".into(),
        ])
        .unwrap();
        assert_eq!(command.options.harness_kind(), HarnessKind::Cursor);
        assert_eq!(
            command.options.provider_environment().unwrap(),
            ["CURSOR_API_KEY"]
        );
        let mut forwarded = vec![OsString::from("test")];
        forwarded.extend(command.options.worker_args());
        let (runtime, arguments) = Command::try_parse_from(forwarded)
            .unwrap()
            .options
            .launch(42)
            .unwrap();
        assert_eq!(runtime, node);
        assert_eq!(
            arguments,
            vec![
                entry.canonicalize().unwrap().into_os_string(),
                "--model".into(),
                "fixture-model".into(),
                "--timeout-seconds".into(),
                "42".into(),
                "--allow-unsandboxed-commands".into()
            ]
        );
    }

    #[test]
    fn cursor_requires_an_entrypoint_and_refuses_foreign_options() {
        assert!(
            Command::try_parse_from(["test", "--harness", "cursor"])
                .unwrap()
                .options
                .launch(1)
                .is_err()
        );
        let (_d, binary, entry, node) = fixture();
        for (flag, value) in [
            ("--opencode-path", &binary),
            ("--claude-path", &binary),
            ("--codex-path", &binary),
        ] {
            let command = Command::try_parse_from(vec![
                OsString::from("test"),
                "--harness".into(),
                "cursor".into(),
                "--cursor-adapter".into(),
                entry.clone().into_os_string(),
                "--cursor-node".into(),
                node.clone().into_os_string(),
                flag.into(),
                value.clone().into_os_string(),
            ])
            .unwrap();
            assert!(command.options.launch(1).is_err(), "{flag}");
        }
        let command = Command::try_parse_from(vec![
            OsString::from("test"),
            "--harness".into(),
            "codex".into(),
            "--cursor-adapter".into(),
            entry.into_os_string(),
        ])
        .unwrap();
        assert!(command.options.launch(1).is_err());
    }
}
