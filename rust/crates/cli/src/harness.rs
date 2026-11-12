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
}

impl Harness {
    fn name(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::ClaudeCode => "claude-code",
            Self::OpenaiAgents => "openai-agents",
        }
    }

    pub fn kind(self) -> HarnessKind {
        match self {
            Self::Codex => HarnessKind::Codex,
            Self::ClaudeCode => HarnessKind::ClaudeCode,
            Self::OpenaiAgents => HarnessKind::OpenaiAgents,
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
                    Harness::Codex => unreachable!(),
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
