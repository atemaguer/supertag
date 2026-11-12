use std::{ffi::OsString, io::Read, path::PathBuf, time::Duration};

use anyhow::{Context, Result, ensure};
use clap::{Args, ValueEnum};
use prost::Message;
use supertag_codex_adapter::CodexOptions;
use supertag_protocol::v2::AdapterBootstrap;
use supertag_worker_host::{
    CODEX_ATTEMPT_DIRECTORY, CODEX_ENVIRONMENT, WORKSPACE_DIRECTORY, WorkspaceMapping,
};

#[derive(Clone, Copy, ValueEnum)]
enum Harness {
    Codex,
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

    pub fn uses_codex(&self) -> bool {
        matches!(self.harness, Some(Harness::Codex))
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
        let mut args = vec![OsString::from("--harness"), OsString::from("codex")];
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
        let mut args = vec![
            OsString::from("__codex-adapter"),
            OsString::from("--executable"),
            executable_path(self.codex_path.unwrap_or_else(|| PathBuf::from("codex")))?
                .into_os_string(),
            OsString::from("--timeout-seconds"),
            OsString::from(timeout_seconds.to_string()),
        ];
        if let Some(model) = self.codex_model {
            args.extend([OsString::from("--model"), OsString::from(model)]);
        }
        if let Some(workspace) = self.codex_workspace {
            args.extend([OsString::from("--workspace"), workspace.into_os_string()]);
        }
        Ok((std::env::current_exe()?, args))
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
    let state_directory = std::env::var_os(CODEX_ATTEMPT_DIRECTORY)
        .map(PathBuf::from)
        .context("guarded Codex Attempt state is required")?;
    let isolated = std::env::var_os(WORKSPACE_DIRECTORY).map(PathBuf::from);
    ensure!(
        isolated.is_none() || args.workspace.is_none(),
        "a prepared Task workspace cannot be overridden"
    );
    let allow_workspace_write = isolated.is_some() || args.workspace.is_none();
    let workspace = match isolated.or(args.workspace) {
        Some(path) => path,
        None => {
            let path = state_directory.join("workspace");
            std::fs::create_dir(&path)?;
            path
        }
    };
    let environment = CODEX_ENVIRONMENT
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
