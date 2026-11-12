use std::{ffi::OsString, io::Read, path::PathBuf, time::Duration};

use anyhow::{Context, Result, ensure};
use clap::{Args, ValueEnum};
use prost::Message;
use supertag_codex_adapter::CodexOptions;
use supertag_protocol::v2::AdapterBootstrap;
use supertag_worker_host::{CODEX_ATTEMPT_DIRECTORY, CODEX_ENVIRONMENT};

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
    #[arg(long, requires = "harness")]
    codex_workspace: Option<PathBuf>,
}

impl AdapterOptions {
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
        args
    }

    pub fn launch(self, timeout_seconds: u64) -> Result<(PathBuf, Vec<OsString>)> {
        if let Some(path) = self.adapter {
            return Ok((path, self.adapter_arg));
        }
        let mut args = vec![
            OsString::from("__codex-adapter"),
            OsString::from("--executable"),
            self.codex_path
                .unwrap_or_else(|| PathBuf::from("codex"))
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
    let allow_workspace_write = args.workspace.is_none();
    let workspace = match args.workspace {
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
