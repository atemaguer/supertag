//! The Worker: one Task Attempt on this Worker Host. It runs the harness server (the adapter and
//! its guardian), the Attempt's egress and provider proxies, its Context Items and MCP servers,
//! the data relays its harness calls, and the capture of what the turn produced. It reaches the
//! Control Plane's lease-bound actions only through the Worklet's `Authority` handle.

pub(crate) mod adapter;
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
pub(crate) mod provider_proxy;
pub(crate) mod remote;
pub(crate) mod remote_provider;
pub(crate) mod run;
pub(crate) mod setup;
pub(crate) mod shared_execution;
pub(crate) mod task_artifact_inputs;
pub(crate) mod task_outputs;

use std::{ffi::OsString, path::PathBuf, time::Duration};

use supertag_protocol::v2::{HarnessExecutionProfile, HarnessKind};

use crate::{McpCatalog, ProviderConfig, SharedExecutionConfig, WorkspaceMounts};

/// What a Worker reads to run one Task Attempt: its harness and adapter, the execution profile
/// it enforces, where its Workspace runs, and the catalogs and credentials it may use.
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
    pub mcp_catalog: McpCatalog,
    pub workspace_mounts: WorkspaceMounts,
    /// Credentials the egress proxy injects for Tasks whose network scope names them.
    pub network_credentials: Vec<egress::HostCredential>,
}

/// What a Worker reads: its options, and the host state directory the Worklet keeps the
/// Attempt's files under.
#[derive(Clone, Copy)]
pub(crate) struct Settings<'a> {
    pub(crate) options: &'a WorkerOptions,
    pub(crate) state_directory: &'a PathBuf,
}

impl std::ops::Deref for Settings<'_> {
    type Target = WorkerOptions;

    fn deref(&self) -> &WorkerOptions {
        self.options
    }
}
