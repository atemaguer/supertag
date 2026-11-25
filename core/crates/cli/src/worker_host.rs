//! `supertag worklet` runs a Worker Host's Worklet; the hidden `supertag __worker` is the
//! process the Worklet starts for each Task Attempt. Both read the same arguments for a harness,
//! so a Worker runs exactly what its Worklet claimed for.

use std::{collections::BTreeMap, ffi::OsString, net::SocketAddr, path::PathBuf, time::Duration};

use anyhow::{Context, Result, ensure};
use clap::{Args, Parser};
use supertag_protocol::v2::HarnessKind;
use supertag_worker_host::{HarnessService, WorkerLaunch, WorkerOptions, WorkletOptions};
use tokio_util::sync::CancellationToken;

use crate::{
    SKILL_CATALOG_HELP,
    harness::{self, AdapterOptions},
    local_config, network, termination_signal, volumes,
};

/// The file in a Worker Host's state directory that holds its pool size, which its supervisor
/// rewrites and signals with SIGUSR1 to resize the pool without a restart.
pub(crate) const CONCURRENCY_FILE: &str = "concurrency";

#[derive(Args)]
pub(crate) struct WorkerHostArgs {
    /// Control Plane URL this Worker Host connects to.
    #[arg(long)]
    pub(crate) control_plane: String,
    /// Private directory for this Worker Host's enrollment and execution journal.
    #[arg(long)]
    pub(crate) state_directory: PathBuf,
    /// Placement label for this host, such as gpu. Repeat for more labels.
    #[arg(long = "label")]
    pub(crate) labels: Vec<String>,
    #[command(flatten)]
    pub(crate) adapter: Box<AdapterOptions>,
    /// Owner-controlled JSON mappings for Workspace Volume copies: each maps a Volume to a
    /// destination root, and an S3 Volume's credential name to an endpoint, region, and key
    /// variables.
    #[arg(long)]
    pub(crate) workspace_mount_mappings: Option<PathBuf>,
    /// A file Volume this host maps, as VOLUME_ID=/absolute/private/directory. A Tag that
    /// keeps its work on it runs only on hosts that map it, and they write there directly.
    #[arg(long = "volume", value_name = "VOLUME_ID=DIRECTORY")]
    pub(crate) host_volumes: Vec<String>,
    /// Listen for authorized artifact reads from other Worker Hosts.
    #[arg(long)]
    pub(crate) artifact_transfer_listen: Option<SocketAddr>,
    /// Owner-only absolute directory holding the artifacts and Workspace deliveries this
    /// host produces (default: STATE_DIRECTORY/artifacts). The Control Plane stores neither.
    #[arg(long)]
    pub(crate) artifact_directory: Option<PathBuf>,
    /// TLS certificate for the artifact transfer listener.
    #[arg(long, requires_all = ["artifact_transfer_listen", "artifact_transfer_tls_key"])]
    pub(crate) artifact_transfer_tls_cert: Option<PathBuf>,
    /// TLS private key for the artifact transfer listener.
    #[arg(long, requires_all = ["artifact_transfer_listen", "artifact_transfer_tls_cert"])]
    pub(crate) artifact_transfer_tls_key: Option<PathBuf>,
    /// Pin a producing Worker Host to an HTTPS origin or literal loopback HTTP.
    #[arg(long = "artifact-peer", value_name = "HOST_ID=ORIGIN")]
    pub(crate) artifact_peers: Vec<String>,
    /// CA certificate for the configured artifact peer endpoints.
    #[arg(long, requires = "artifact_peers")]
    pub(crate) artifact_peer_ca_file: Option<PathBuf>,
    /// Private JSON file of the harness's provider keys and tokens, read and deleted at
    /// start, so they stay out of this process's environment. `supertag up` writes it.
    #[arg(long, value_name = "PATH")]
    pub(crate) provider_credentials_file: Option<PathBuf>,
    /// Executable for a private E2B workspace provider used by Cursor.
    #[arg(long)]
    pub(crate) e2b_workspace_provider: Option<PathBuf>,
    /// Argument to the E2B provider, such as the compiled helper entrypoint.
    #[arg(long, requires = "e2b_workspace_provider", allow_hyphen_values = true)]
    pub(crate) e2b_workspace_provider_arg: Vec<std::ffi::OsString>,
    /// Executable for a private Modal Workspace provider used by Cursor.
    #[arg(long, conflicts_with = "e2b_workspace_provider")]
    pub(crate) modal_workspace_provider: Option<PathBuf>,
    /// Argument to the Modal provider, such as the compiled helper entrypoint.
    #[arg(
        long,
        requires = "modal_workspace_provider",
        allow_hyphen_values = true
    )]
    pub(crate) modal_workspace_provider_arg: Vec<std::ffi::OsString>,
    /// Executable for your own sandbox provider, which must pass the conformance suite in docs/reference/sandbox-providers.md.
    #[arg(
        long,
        conflicts_with_all = ["e2b_workspace_provider", "modal_workspace_provider"]
    )]
    pub(crate) workspace_provider: Option<PathBuf>,
    /// Argument to your own sandbox provider, such as its entrypoint.
    #[arg(long, requires = "workspace_provider", allow_hyphen_values = true)]
    pub(crate) workspace_provider_arg: Vec<std::ffi::OsString>,
    /// A Worker Host variable passed to your own sandbox provider, such as its API key. Repeat for more; no other variable reaches it.
    #[arg(long, requires = "workspace_provider", value_name = "NAME")]
    pub(crate) workspace_provider_env: Vec<String>,
    /// Run each Task's commands and file tools in a container on this machine's Docker, through the installed local-vm provider.
    #[arg(
        long,
        conflicts_with_all = ["e2b_workspace_provider", "modal_workspace_provider", "workspace_provider"]
    )]
    pub(crate) local_vm: bool,
    /// Executable for the local-vm provider instead of the installed one, such as Node from a source checkout.
    #[arg(
        long,
        conflicts_with_all = ["e2b_workspace_provider", "modal_workspace_provider", "workspace_provider", "local_vm"]
    )]
    pub(crate) local_vm_workspace_provider: Option<PathBuf>,
    /// Argument to the local-vm provider executable, such as its entrypoint.
    #[arg(
        long,
        requires = "local_vm_workspace_provider",
        allow_hyphen_values = true
    )]
    pub(crate) local_vm_workspace_provider_arg: Vec<std::ffi::OsString>,
    /// Owner-only JSON catalog of HTTP and stdio MCP tools for Claude Code Tasks.
    #[arg(
        long,
        conflicts_with_all = ["e2b_workspace_provider", "modal_workspace_provider", "workspace_provider", "local_vm", "local_vm_workspace_provider"],
        long_help = r#"Owner-only JSON catalog of HTTP and stdio MCP tools for Claude Code Tasks.

Use {"version":1,"servers":[{"name":"catalog","url":"https://example.com/mcp","headerEnv":{"Authorization":"CATALOG_AUTH"}}]}. Set CATALOG_AUTH to the full header value in the Worker Host environment, or use "headerFile":{"Authorization":"/PATH"} to read it from a file. An HTTP server with "oauth":true instead uses the login `supertag mcp login NAME --mcp-catalog PATH` stores on this host.

An HTTP server may instead mint its credentials for each Task Attempt, with exactly one of: "oauth":{"refreshTokenEnv":"VAR"} (a refresh token, or the JSON `supertag mcp login NAME --export` prints); "clientCredentials":{"clientId":"ID","clientSecretEnv":"VAR"} or {"clientId":"ID","assertionKeyEnv":"VAR"} (a client secret, or an RSA or EC private key for a signed JWT client assertion; also "clientIdEnv", "scope", and "tokenUrl"); "githubApp":{"appId":1,"installationId":2,"privateKeyEnv":"VAR"} (a GitHub App installation token); or "helper":["/path/to/command","arg"] (a host command that prints a JSON object of header names to values). Each VAR names a Worker Host variable; each *Env field may instead be the matching *File field naming a file, such as "clientSecretFile" or "privateKeyFile". Without "tokenUrl", the token endpoint comes from the server's OAuth metadata and must share the server's origin.

A stdio server has a command instead of a url, such as {"name":"db","command":["npx","-y","@acme/db-mcp"],"env":{"DB_TOKEN":"ACME_DB_TOKEN"}}. The Worker launches it for each Task Attempt with only its env, each value read from the named Worker Host variable or, for {"file":"/PATH"}, from that file, plus HOME, PATH, and a few locale variables, and stops its process group when the Attempt ends.

The optional resources.tools object maps each tool name to a list of rules, for example [{"prefix":"repository:","separator":"/","components":[{"arguments":["owner"]},{"arguments":["repo"]}]}].

A preset names an official HTTP server instead of a url, with its URL and resource mapping: {"name":"github","preset":"github","headerEnv":{"Authorization":"GITHUB_MCP_AUTH"}}. Presets are github, slack, linear, and teams; teams also needs "tenantId", the Microsoft Entra tenant ID or domain. The lark preset is a stdio server that runs lark-mcp, from the @larksuiteoapi/lark-mcp npm package, on the Worker Host's PATH: {"name":"lark","preset":"lark","env":{"APP_ID":"LARK_APP_ID","APP_SECRET":"LARK_APP_SECRET"}}.

A file path is absolute or starts with ~/. The file must be a regular file, not a symbolic link, owned by the Worker Host's user and not readable or writable by group or others, holding one value (a private key or refresh token JSON may span lines). The Worklet reads it at start, so a missing file stops it, and the Worker reads it again at each use, so a replaced file takes effect without a restart.

Catalog entries expose tools only when the Task's accepted Permission Sets grant them. Calls requiring approval appear in the operator Inbox. Endpoints must use HTTPS or literal loopback HTTP."#
    )]
    pub(crate) mcp_catalog: Option<PathBuf>,
    /// gRPC origin of a standalone shared execution provider for Cursor.
    #[arg(long, requires = "shared_execution_environment", conflicts_with_all = ["e2b_workspace_provider", "modal_workspace_provider", "workspace_provider", "local_vm", "local_vm_workspace_provider", "mcp_catalog", "workspace_id", "remote_workspace", "allow_unsandboxed_commands", "sandbox_commands"])]
    pub(crate) shared_execution_endpoint: Option<String>,
    /// Environment ID expected from the provider. Set SUPERTAG_EXECUTION_ADMIN_TOKEN separately.
    #[arg(long, requires = "shared_execution_endpoint")]
    pub(crate) shared_execution_environment: Option<String>,
    /// CA certificate for the shared execution provider endpoint.
    #[arg(long, requires = "shared_execution_endpoint")]
    pub(crate) shared_execution_ca_file: Option<PathBuf>,
    /// Enable lease-bound commands on an operator-trusted Linux shared execution provider.
    #[arg(
        long,
        requires = "shared_execution_endpoint",
        long_help = "Enable lease-bound commands on an operator-trusted Linux shared execution provider. Commands start in the fixed root with an empty credential environment and run with the provider's configured workload UID and GID. That identity's OS filesystem and network permissions also apply."
    )]
    pub(crate) shared_execution_commands: bool,
    /// Private host allowlist of Skill packages.
    #[arg(long, long_help = SKILL_CATALOG_HELP)]
    pub(crate) skill_catalog: Option<PathBuf>,
    /// Seconds a Task Attempt may run before this host stops it, from 1 through 86400.
    #[arg(long, default_value_t = local_config::DEFAULT_ATTEMPT_TIMEOUT_SECONDS, value_parser = clap::value_parser!(u64).range(1..=local_config::MAX_ATTEMPT_TIMEOUT_SECONDS))]
    pub(crate) attempt_timeout_seconds: u64,
    /// Task Attempts this host runs at once across all its harnesses: the slots of its Worker
    /// pool, from 1 through 16.
    #[arg(long, default_value_t = 1, value_parser = clap::value_parser!(u32).range(1..=16))]
    pub(crate) concurrency: u32,
    /// At most this many of this harness's Task Attempts at once, within --concurrency, from 1
    /// through 16. Without it, the harness may use every slot.
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..=16))]
    pub(crate) harness_limit: Option<u32>,
    /// A private JSON file naming each harness this host runs, as `supertag worklet`
    /// arguments of its own: `{"harnesses": [[ARG, ...], ...]}`. `supertag up` writes it for a
    /// host service with several harnesses.
    #[arg(long, hide = true, value_name = "PATH")]
    pub(crate) harness_set: Option<PathBuf>,
    /// Exit after running one Task Attempt.
    #[arg(long)]
    pub(crate) once: bool,
    /// Stay connected while an interrupted Attempt waits for an operator decision, instead of exiting.
    #[arg(long)]
    pub(crate) wait_for_recovery: bool,
}

/// One harness's arguments, as a host service's harness set names them.
#[derive(Parser)]
#[command(no_binary_name = true)]
struct HarnessArgs {
    #[command(flatten)]
    args: WorkerHostArgs,
}

#[derive(serde::Deserialize)]
struct HarnessSet {
    harnesses: Vec<Vec<String>>,
}

/// One harness, built from its arguments, and what its Worklet shares with its Workers.
struct Built {
    worker: WorkerOptions,
    /// The Worklet variables this harness's Workers inherit besides the basics.
    environment: Vec<String>,
    provider_credentials: BTreeMap<String, String>,
    network_credentials: Vec<supertag_worker_host::egress::HostCredential>,
    workspaces: Vec<supertag_worker_host::WorkspaceMapping>,
    artifact_source: supertag_worker_host::ArtifactSourceConfig,
    artifact_directory: PathBuf,
    artifact_peers: supertag_worker_host::ArtifactPeers,
    volumes: BTreeMap<String, supertag_workspaces::artifact_volumes::FileVolume>,
    workspace_mounts: supertag_worker_host::WorkspaceMounts,
    mcp_catalog: supertag_worker_host::McpCatalog,
}

/// Builds one harness from its arguments. A Worker (`worker`) reads no credential file and no
/// network credential: its Worklet assigns it the ones its Attempt may use.
async fn build(args: WorkerHostArgs, worker: bool) -> Result<Built> {
    let WorkerHostArgs {
        state_directory,
        adapter,
        workspace_mount_mappings,
        host_volumes,
        artifact_transfer_listen,
        artifact_directory,
        artifact_transfer_tls_cert,
        artifact_transfer_tls_key,
        artifact_peers,
        artifact_peer_ca_file,
        provider_credentials_file,
        e2b_workspace_provider,
        e2b_workspace_provider_arg,
        modal_workspace_provider,
        modal_workspace_provider_arg,
        workspace_provider,
        workspace_provider_arg,
        workspace_provider_env,
        local_vm,
        local_vm_workspace_provider,
        local_vm_workspace_provider_arg,
        mcp_catalog,
        shared_execution_endpoint,
        shared_execution_environment,
        shared_execution_ca_file,
        shared_execution_commands,
        skill_catalog,
        attempt_timeout_seconds,
        ..
    } = args;
    // Keep provider keys out of the process environment: the Worklet reads them from a file, or
    // from its own environment when no file names them, and hands each Worker its own
    // harness's in its Assign. A Worker inherits none of them.
    let mut provider_credentials = match &provider_credentials_file {
        Some(path) if !worker => supertag_worker_host::read_provider_credentials(path)?,
        _ => Default::default(),
    };
    let provider_variables = adapter.provider_environment()?;
    if !worker {
        for &name in provider_variables {
            if supertag_worker_host::is_provider_secret(name)
                && !provider_credentials.contains_key(name)
                && let Some(value) = std::env::var(name).ok().filter(|value| !value.is_empty())
            {
                provider_credentials.insert(name.to_owned(), value);
            }
        }
    }
    let harness = adapter.harness_kind();
    ensure!(
        skill_catalog.is_none() || supertag_worker_host::context::harness_loads_skills(harness),
        "this Worker Host's selected harness does not load Skills"
    );
    let provider_model = adapter.provider_model();
    let mut execution_profile = adapter.execution_profile()?;
    // A Worker gets the values from its Worklet, for its Attempt only.
    let network_names = adapter.network_credentials()?;
    let network_credentials = network_names
        .clone()
        .into_iter()
        .filter(|_| !worker)
        .map(|(name, variable)| {
            let source = supertag_worker_host::egress::credential_source_variable(&name);
            let value = std::env::var(&source).with_context(|| {
                format!("set {source} to the value of network credential {name}")
            })?;
            supertag_worker_host::egress::HostCredential::new(&name, &variable, value)
        })
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        network_names.is_empty()
            || harness == HarnessKind::Codex
            || e2b_workspace_provider.is_some()
            || modal_workspace_provider.is_some()
            || local_vm
            || local_vm_workspace_provider.is_some(),
        "network credentials are injected only for Codex, or through an E2B, Modal, or local-vm Workspace's egress relay, in this release"
    );
    let workspaces = adapter.workspace_mappings()?;
    use supertag_worker_host::{ProviderAuthority, ProviderConfig};
    let mut remote_provider = if let Some(executable) = e2b_workspace_provider {
        Some(ProviderConfig {
            executable,
            arguments: e2b_workspace_provider_arg,
            authority: ProviderAuthority::E2b {
                api_key: std::env::var("E2B_API_KEY").ok(),
                domain: std::env::var("E2B_DOMAIN").ok(),
                template: std::env::var("SUPERTAG_E2B_TEMPLATE").ok(),
            },
            codex_version: None,
        })
    } else if let Some(executable) = modal_workspace_provider {
        let required = |name| {
            let value = std::env::var(name)
                .with_context(|| format!("set {name} for the Modal Workspace provider"))?;
            ensure!(
                !value.trim().is_empty(),
                "set {name} for the Modal Workspace provider"
            );
            Ok::<_, anyhow::Error>(value)
        };
        Some(ProviderConfig {
            executable,
            arguments: modal_workspace_provider_arg,
            authority: ProviderAuthority::Modal {
                token_id: required("MODAL_TOKEN_ID")?,
                token_secret: required("MODAL_TOKEN_SECRET")?,
                app: required("SUPERTAG_MODAL_WORKSPACE_APP")?,
                endpoint: std::env::var("MODAL_SERVER_URL")
                    .unwrap_or_else(|_| "https://api.modal.com:443".into()),
                environment: std::env::var("SUPERTAG_MODAL_WORKSPACE_ENVIRONMENT")
                    .unwrap_or_else(|_| "main".into()),
                image: std::env::var("SUPERTAG_MODAL_WORKSPACE_IMAGE").ok(),
            },
            codex_version: None,
        })
    } else if let Some(executable) = workspace_provider {
        Some(ProviderConfig {
            executable,
            arguments: workspace_provider_arg,
            authority: ProviderAuthority::generic(&workspace_provider_env)?,
            codex_version: None,
        })
    } else if let Some(executable) = local_vm_workspace_provider {
        Some(ProviderConfig {
            executable,
            arguments: local_vm_workspace_provider_arg,
            authority: ProviderAuthority::local_vm(),
            codex_version: None,
        })
    } else if local_vm {
        let (executable, entry) = harness::local_vm_bridge()?;
        Some(ProviderConfig {
            executable,
            arguments: vec![entry.into_os_string()],
            authority: ProviderAuthority::local_vm(),
            codex_version: None,
        })
    } else {
        None
    };
    ensure!(
        (remote_provider.is_none() && shared_execution_endpoint.is_none())
            || workspaces.iter().all(|mapping| mapping.setup.is_none()),
        "Workspace setup prepares local checkouts; remote Workspaces and shared execution cannot use it"
    );
    if let Some(config) = remote_provider.as_mut() {
        ensure!(
            matches!(
                harness,
                HarnessKind::Cursor
                    | HarnessKind::ClaudeCode
                    | HarnessKind::Opencode
                    | HarnessKind::Codex
            ) && !workspaces.is_empty()
                && !execution_profile.allow_unsandboxed_commands,
            "remote Workspace placement requires Cursor, Claude Code, OpenCode, or Codex and a named Workspace without unsandboxed commands"
        );
        // Codex's exec-server in each sandbox must be exactly this host's Codex.
        if harness == HarnessKind::Codex {
            let version = adapter.codex_version()?;
            // local-vm builds its images itself, so it installs that Codex in each.
            if let ProviderAuthority::LocalVm { settings, .. } = &mut config.authority {
                settings.retain(|(name, _)| name != "SUPERTAG_LOCAL_VM_CODEX_VERSION");
                settings.push(("SUPERTAG_LOCAL_VM_CODEX_VERSION".into(), version.clone()));
            }
            config.codex_version = Some(version);
        }
        execution_profile.remote_file_workspace = true;
        execution_profile.declared_task_outputs = true;
        execution_profile.unverified_workspace_provider = remote_provider
            .as_ref()
            .is_some_and(|provider| !provider.verified());
        // E2B, Modal, and local-vm carry the egress relay over their exec stream while
        // the sandbox has no network, DNS included. Modal and local-vm were verified
        // live (2026-11-17). E2B's carrier, a background root command with standard
        // input, was proven only against a test double that runs the real relay program
        // (2026-11-18), not against live E2B: there are no E2B credentials to run it.
        execution_profile.remote_egress_relay = matches!(
            remote_provider.as_ref().map(|config| &config.authority),
            Some(
                ProviderAuthority::E2b { .. }
                    | ProviderAuthority::Modal { .. }
                    | ProviderAuthority::LocalVm { .. }
            )
        );
    }
    let (adapter, adapter_args) = adapter.launch(attempt_timeout_seconds)?;
    let mcp_catalog_path = mcp_catalog;
    let mcp_catalog = supertag_worker_host::McpCatalog::load(
        mcp_catalog_path.as_deref(),
        supertag_worker_host::McpLoginStore::default_location().ok(),
    )?;
    execution_profile.mcp_servers = mcp_catalog.capabilities();
    let shared_execution = if let Some((endpoint, environment)) =
        shared_execution_endpoint.zip(shared_execution_environment)
    {
        ensure!(
            harness == HarnessKind::Cursor,
            "shared execution currently requires --harness cursor"
        );
        let admin = std::env::var("SUPERTAG_EXECUTION_ADMIN_TOKEN")
            .context("set SUPERTAG_EXECUTION_ADMIN_TOKEN for shared execution")?;
        let ca = if let Some(path) = shared_execution_ca_file {
            Some(tokio::fs::read(path).await?)
        } else {
            None
        };
        let config = supertag_worker_host::SharedExecutionConfig::connect(
            endpoint,
            environment,
            admin,
            ca,
            shared_execution_commands,
        )
        .await?;
        execution_profile.shared_execution = Some(config.capability().clone());
        Some(config)
    } else {
        None
    };
    execution_profile.task_artifact_inputs = !workspaces.is_empty()
        && shared_execution.is_none()
        && supertag_protocol::task_artifact_inputs::supports_harness(harness);
    let tls = match artifact_transfer_tls_cert.zip(artifact_transfer_tls_key) {
        Some((cert, key)) => Some(tonic::transport::Identity::from_pem(
            tokio::fs::read(cert)
                .await
                .context("read artifact listener certificate")?,
            tokio::fs::read(key)
                .await
                .context("read artifact listener private key")?,
        )),
        None => None,
    };
    let artifact_directory_root =
        artifact_directory.unwrap_or_else(|| state_directory.join("artifacts"));
    let artifact_source = Some(supertag_worker_host::ArtifactSourceConfig {
        directory: artifact_directory_root.clone(),
        listen: artifact_transfer_listen,
        tls,
    });
    let artifact_peer_ca = match artifact_peer_ca_file {
        Some(path) => Some(
            tokio::fs::read(path)
                .await
                .context("read artifact peer CA")?,
        ),
        None => None,
    };
    let artifact_peers =
        supertag_worker_host::ArtifactPeers::configure(artifact_peers, artifact_peer_ca)?;
    let workspace_mounts = workspace_mount_mappings
        .as_deref()
        .map(supertag_worker_host::WorkspaceMounts::load)
        .transpose()?
        .unwrap_or_default();
    execution_profile.workspace_mounts = workspace_mounts.capabilities();
    let host_volumes = volumes::host_mappings(
        host_volumes,
        &[state_directory.as_path(), artifact_directory_root.as_path()],
    )?;
    execution_profile.volumes = host_volumes
        .iter()
        .map(
            |(volume_id, mapping)| supertag_protocol::v2::VolumeMapping {
                volume_id: volume_id.clone(),
                source: mapping.source.clone(),
            },
        )
        .collect();
    // The Worklet variables this harness's Workers inherit: what its own configuration reads.
    let mut environment: Vec<String> = provider_variables
        .iter()
        .filter(|name| !supertag_worker_host::is_provider_secret(name))
        .map(|&name| name.to_owned())
        .collect();
    if let Some(provider) = &remote_provider {
        environment.extend(provider.authority.variables());
    }
    if shared_execution.is_some() {
        environment.push("SUPERTAG_EXECUTION_ADMIN_TOKEN".into());
    }
    // A GitHub-hosted Skill catalog is fetched with the host's GitHub token, or else the
    // operator's own Git configuration.
    if skill_catalog.is_some() {
        environment.extend(["GITHUB_TOKEN".into(), "GIT_CONFIG_GLOBAL".into()]);
    }
    if let Some(path) = &mcp_catalog_path {
        environment.extend(supertag_worker_host::McpCatalog::variables(path)?);
    }
    // A Workspace's own `.mcp.json` reads only `SUPERTAG_MCP_*` variables, and only the harnesses
    // that run MCP servers read it.
    if matches!(harness, HarnessKind::ClaudeCode | HarnessKind::Cursor) {
        environment.extend(
            std::env::vars_os()
                .filter_map(|(name, _)| name.into_string().ok())
                .filter(|name| name.starts_with(supertag_worker_host::MCP_VARIABLE_PREFIX)),
        );
    }
    environment.extend(workspace_mounts.variables().iter().cloned());
    environment.sort_unstable();
    environment.dedup();
    let worker = WorkerOptions {
        adapter_guardian: std::env::current_exe()?,
        adapter,
        adapter_args,
        harness,
        provider_model,
        execution_profile,
        attempt_timeout: Duration::from_secs(attempt_timeout_seconds),
        remote_provider,
        shared_execution,
        // A harness that loads Skills gets the configured catalog, the Task's repository Skills,
        // and those of the user this host runs as.
        context_catalog: if !supertag_worker_host::context::harness_loads_skills(harness) {
            supertag_worker_host::context::ContextCatalog::without_skills()
        } else {
            supertag_worker_host::context::ContextCatalog::load(
                skill_catalog.as_deref(),
                std::env::var_os("HOME")
                    .filter(|home| !home.is_empty())
                    .map(PathBuf::from)
                    .as_deref(),
            )?
        },
    };
    Ok(Built {
        worker,
        environment,
        provider_credentials,
        network_credentials,
        workspaces,
        artifact_source: artifact_source.context("artifact storage is unset")?,
        artifact_directory: artifact_directory_root,
        artifact_peers,
        volumes: host_volumes,
        workspace_mounts,
        mcp_catalog,
    })
}

/// Keeps other processes of the same user from reading this process's memory or environment
/// through /proc or ptrace, on Linux. It closes accidental leaks; it is not a boundary against
/// commands run without a sandbox.
fn not_dumpable() -> Result<()> {
    #[cfg(target_os = "linux")]
    // SAFETY: prctl(PR_SET_DUMPABLE) takes integer arguments and changes only this
    // process's dumpable flag.
    if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0 {
        return Err(std::io::Error::last_os_error()).context("mark this process non-dumpable");
    }
    Ok(())
}

/// This process's own arguments after its `worklet` command, which its Workers read too.
fn own_arguments() -> Vec<OsString> {
    let mut args = std::env::args_os().skip(1);
    for arg in args.by_ref() {
        if arg == "worklet" {
            break;
        }
    }
    args.collect()
}

/// The pool size a supervisor last wrote for this host, if any.
fn configured_concurrency(state: &std::path::Path) -> Option<u32> {
    let text = supertag_local_state::read_private(&state.join(CONCURRENCY_FILE)).ok()?;
    text.trim()
        .parse()
        .ok()
        .filter(|size| (1..=local_config::MAX_CONCURRENCY).contains(size))
}

/// `supertag worklet`: this Worker Host's Worklet, until a termination signal.
pub(crate) async fn run_worklet(args: WorkerHostArgs) -> Result<()> {
    not_dumpable()?;
    let control_plane = network::endpoint(args.control_plane.clone()).await?;
    let state_directory = args.state_directory.clone();
    let (labels, once, wait_for_recovery, concurrency) = (
        args.labels.clone(),
        args.once,
        args.wait_for_recovery,
        args.concurrency,
    );
    let program = std::env::current_exe()?;
    let mut sets = Vec::new();
    match args.harness_set.clone() {
        None => sets.push((own_arguments(), args)),
        Some(path) => {
            ensure!(
                !args.adapter.is_selected() && args.harness_limit.is_none(),
                "a Worker Host with a harness set takes its harnesses, and their limits, from that file"
            );
            let set: HarnessSet = serde_json::from_slice(
                &supertag_local_state::read_private(&path)
                    .context("read the Worker Host's harness set")?
                    .into_bytes(),
            )
            .context("parse the Worker Host's harness set")?;
            ensure!(
                !set.harnesses.is_empty(),
                "the harness set names no harness"
            );
            for arguments in set.harnesses {
                let arguments: Vec<OsString> = arguments.into_iter().map(OsString::from).collect();
                let parsed = HarnessArgs::try_parse_from(&arguments)
                    .map_err(|error| anyhow::anyhow!("{}", error.render()))?
                    .args;
                ensure!(
                    parsed.state_directory == state_directory
                        && parsed.control_plane == args.control_plane,
                    "every harness of a Worker Host runs under its state directory and Control Plane"
                );
                sets.push((arguments, parsed));
            }
        }
    }
    let mut harnesses = Vec::new();
    #[allow(clippy::type_complexity)]
    let mut shared: Option<(
        Vec<supertag_worker_host::WorkspaceMapping>,
        supertag_worker_host::ArtifactSourceConfig,
        supertag_worker_host::ArtifactPeers,
        BTreeMap<String, supertag_workspaces::artifact_volumes::FileVolume>,
        supertag_worker_host::WorkspaceMounts,
        supertag_worker_host::McpCatalog,
    )> = None;
    for (arguments, args) in sets {
        let limit = args.harness_limit;
        let built = build(args, false).await?;
        let mut worker_args = vec![OsString::from("__worker")];
        worker_args.extend(arguments);
        harnesses.push(HarnessService {
            worker: built.worker,
            launch: WorkerLaunch {
                program: program.clone(),
                args: worker_args,
                environment: built.environment,
            },
            provider_credentials: built.provider_credentials,
            network_credentials: built.network_credentials,
            limit,
        });
        match &shared {
            None => {
                shared = Some((
                    built.workspaces,
                    built.artifact_source,
                    built.artifact_peers,
                    built.volumes,
                    built.workspace_mounts,
                    built.mcp_catalog,
                ))
            }
            Some((workspaces, ..)) => ensure!(
                format!("{workspaces:?}") == format!("{:?}", built.workspaces),
                "every harness of a Worker Host maps the same Workspaces"
            ),
        }
    }
    let (workspaces, artifact_source, artifact_peers, volumes, workspace_mounts, mcp_catalog) =
        shared.context("a Worker Host runs at least one harness")?;
    let disk_space =
        supertag_worker_host::environment::DiskSpaceSource::Directory(state_directory.clone());
    // Test builds never hold a real sleep assertion unless a test supplies a fake one.
    #[cfg(not(feature = "test-fixtures"))]
    let keep_awake = supertag_worker_host::environment::KeepAwakeCommand::for_platform(
        std::env::consts::OS,
        std::process::id(),
    );
    #[cfg(feature = "test-fixtures")]
    let (keep_awake, disk_space) = crate::test_host_environment(disk_space)?;
    let (resize, pool_size) = tokio::sync::watch::channel(
        configured_concurrency(&state_directory).unwrap_or(concurrency),
    );
    let worklet = WorkletOptions {
        control_plane,
        token: std::env::var("SUPERTAG_HOST_TOKEN").ok(),
        state_directory: state_directory.clone(),
        wait_for_recovery,
        once,
        workspaces,
        artifact_source: Some(artifact_source),
        artifact_peers,
        volumes,
        workspace_mounts,
        mcp_catalog,
        disk_space,
        keep_awake,
        labels,
        harnesses,
        concurrency: pool_size,
    };
    let token = CancellationToken::new();
    let shutdown = token.clone();
    let signal = tokio::spawn(async move {
        termination_signal().await;
        shutdown.cancel();
    });
    // A supervisor changing the host's `concurrency` writes the new size and sends SIGUSR1.
    let mut resizing =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::user_defined1())?;
    let resizer = tokio::spawn(async move {
        while resizing.recv().await.is_some() {
            if let Some(size) = configured_concurrency(&state_directory) {
                resize.send_replace(size);
            }
        }
    });
    let result = supertag_worker_host::run(worklet, token, || outln!("ready")).await;
    signal.abort();
    resizer.abort();
    result
}

/// `supertag __worker`: one Task Attempt its Worklet assigns, read from descriptor 3.
pub(crate) async fn run_worker(args: WorkerHostArgs) -> Result<()> {
    // Before anything that can start a process, such as `codex --version` below.
    supertag_worker_host::protect_worker_channel()?;
    not_dumpable()?;
    let built = build(args, true).await?;
    supertag_worker_host::run_worker(supertag_worker_host::WorkerProcessOptions {
        worker: built.worker,
        // The data endpoint its Assign names, dialed as the Worklet dials its Control Plane.
        data_dialer: Box::new(|url| Box::pin(network::endpoint(url))),
        workspaces: built.workspaces,
        artifact_directory: built.artifact_directory,
        artifact_peers: built.artifact_peers,
        volumes: built.volumes,
        workspace_mounts: built.workspace_mounts,
        mcp_catalog: built.mcp_catalog,
    })
    .await
}
