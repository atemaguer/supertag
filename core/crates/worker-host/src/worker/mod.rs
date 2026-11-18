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
