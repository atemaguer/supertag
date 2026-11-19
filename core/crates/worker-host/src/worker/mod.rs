//! The Worker: one Task Attempt on this Worker Host. It runs the harness server (the adapter and
//! its guardian), the Attempt's egress and provider proxies, its Context Items and MCP servers,
//! the data relays its harness calls, and the capture of what the turn produced. It runs as a
//! process of its own, which reaches the Control Plane's lease-bound actions only through its
//! Worklet, over the local contract (`crate::local`).

pub(crate) mod adapter;
pub(crate) mod authority;
pub(crate) mod capture_volumes;
pub(crate) mod changed_paths;
pub(crate) mod codex_exec;
pub mod context;
pub mod egress;
pub(crate) mod guardian;
pub(crate) mod mcp;
pub(crate) mod milestones;
pub(crate) mod native_memory;
pub(crate) mod native_memory_volume;
pub(crate) mod prepared;
pub(crate) mod process;
pub(crate) mod provider_proxy;
pub(crate) mod remote;
pub(crate) mod remote_provider;
pub(crate) mod run;
pub(crate) mod setup;
pub(crate) mod shared_execution;
pub(crate) mod task_artifact_inputs;
pub(crate) mod task_outputs;

use std::{ffi::OsString, path::PathBuf, time::Duration};

use anyhow::{Context, Result};
use prost::Message;
use supertag_protocol::v2::{AttemptExecutionSelection, HarnessExecutionProfile, HarnessKind};

use crate::{
    McpCatalog, ProviderConfig, SharedExecutionConfig, WorkspaceMounts, worklet::journal::Attempt,
};

/// What a Worker reads to run one Task Attempt: its harness and adapter, the execution profile
/// it enforces, where its Workspace runs, and its Context Item catalog. The secrets its Attempt
/// may use come in its `Assign`.
pub struct WorkerOptions {
    pub adapter_guardian: PathBuf,
    pub adapter: PathBuf,
    pub adapter_args: Vec<OsString>,
    pub harness: HarnessKind,
    pub provider_model: Option<String>,
    pub execution_profile: HarnessExecutionProfile,
    pub attempt_timeout: Duration,
    pub remote_provider: Option<ProviderConfig>,
    pub shared_execution: Option<SharedExecutionConfig>,
    pub context_catalog: context::ContextCatalog,
}

/// What a Worker reads: its options, the host state directory the Worklet keeps the Attempt's
/// files under, and what the Worklet lends it of the host's secrets and Volume mounts.
#[derive(Clone, Copy)]
pub(crate) struct Settings<'a> {
    pub(crate) options: &'a WorkerOptions,
    pub(crate) state_directory: &'a PathBuf,
    /// The MCP servers this host offers, with their logins.
    pub(crate) mcp_catalog: &'a McpCatalog,
    /// The credentials the Attempt's egress proxy injects when its network scope names them.
    pub(crate) network_credentials: &'a [egress::HostCredential],
    /// The Volume mounts the Attempt's Workspace copies stage from.
    pub(crate) workspace_mounts: &'a WorkspaceMounts,
}

impl std::ops::Deref for Settings<'_> {
    type Target = WorkerOptions;

    fn deref(&self) -> &WorkerOptions {
        self.options
    }
}

impl Attempt {
    /// Whether this Worker can still run the Attempt: its harness, execution profile, models,
    /// and MCP servers still match what the Attempt was claimed under.
    pub(crate) fn can_launch(&self, options: &WorkerOptions) -> Result<bool> {
        let Some(selection) = &self.execution_selection else {
            return Ok(false);
        };
        let execution = AttemptExecutionSelection::decode(selection.as_slice())
            .context("stored Attempt execution selection is invalid")?;
        let model = execution
            .selection
            .as_ref()
            .and_then(|selection| selection.model.as_ref());
        Ok(execution.harness_kind == options.harness as i32
            && execution.remote_file_workspace == options.execution_profile.remote_file_workspace
            && execution.shared_execution == options.execution_profile.shared_execution
            && (!execution.task_artifact_inputs || options.execution_profile.task_artifact_inputs)
            && execution
                .mcp_servers
                .iter()
                .all(|server| options.execution_profile.mcp_servers.contains(server))
            && model.is_none_or(|model| options.execution_profile.model_ids.contains(model))
            && (!self.requires_unsandboxed_commands
                || options.execution_profile.allow_unsandboxed_commands
                || (options.execution_profile.command_sandbox
                    && options.harness == HarnessKind::ClaudeCode)))
    }
}
