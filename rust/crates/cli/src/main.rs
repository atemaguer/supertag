mod artifacts;
mod github_workspaces;
mod harness;
mod host_status;
mod inbox;
mod inputs;
mod local;
mod mailbox_grants;
mod network;
mod node_bridges;
mod objectives;
mod policy;
mod replies;
mod surface_policy;
mod teams;
mod tui;
mod work_sessions;

use std::{ffi::OsString, net::SocketAddr, path::PathBuf, time::Duration};

use anyhow::{Context, Result, ensure};
use clap::{Args, Parser, Subcommand, ValueEnum};
use harness::{AdapterOptions, CodexAdapterArgs, Harness};
use serde_json::json;
use sha2::{Digest, Sha256};
use supertag_control_plane::{ControlPlane, OperatorWatch};
use supertag_gateway::{
    Gateway, GatewayWatch,
    github::{
        Github, GithubAppConfig, GithubAuthentication, GithubConfig,
        workspaces::{GithubWorkspaceAccount, GithubWorkspaceSources},
    },
    lark::{Lark, LarkConfig},
    linear::{Linear, LinearConfig},
    microsoft_teams::{MicrosoftTeams, MicrosoftTeamsConfig},
    slack::{Slack, SlackConfig},
    transfers::GatewayTransfers,
};
use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request,
    v2::{
        ApprovalRule, AttemptDecision, CancelTaskRequest, CreateAuthKeyRequest, ExecutionLimits,
        GetTagRequest, GetTaskRequest, HarnessKind, LarkDomain, ListEventsRequest,
        ListNativeUsageRequest, ListTagsRequest, PolicyExecutionSettings, PutTagRequest,
        ReportedCostLimit, ResolveAttemptRequest, RetireTagRequest, RevokeHostRequest,
        SubmitTaskRequest, Tag, Task, WorkspaceSpec, attempt_inputs_server::AttemptInputsServer,
        attempt_mailbox_server::AttemptMailboxServer,
        attempt_work_sessions_server::AttemptWorkSessionsServer,
        attempt_workstreams_server::AttemptWorkstreamsServer,
        checkpoint_directory_server::CheckpointDirectoryServer, connector_server::ConnectorServer,
        conversations_server::ConversationsServer, host_directory_server::HostDirectoryServer,
        host_enrollment_server::HostEnrollmentServer, inbox_server::InboxServer,
        live_inputs_server::LiveInputsServer, mailbox_server::MailboxServer,
        objectives_server::ObjectivesServer, operator_client::OperatorClient,
        operator_events_server::OperatorEventsServer, operator_server::OperatorServer,
        policy_catalog_server::PolicyCatalogServer,
        surface_policy_catalog_server::SurfacePolicyCatalogServer, teams_server::TeamsServer,
        transfers_server::TransfersServer, work_sessions_server::WorkSessionsServer,
        worker_host_server::WorkerHostServer, workspace_directory_server::WorkspaceDirectoryServer,
    },
};
use supertag_worker_host::HostOptions;
use tokio::net::TcpListener;
use tokio_stream::wrappers::TcpListenerStream;
use tokio_util::sync::CancellationToken;
use tonic::{Request, transport::Channel};
use uuid::Uuid;

#[derive(Parser)]
#[command(name = "supertag", version)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Args)]
struct Connection {
    #[arg(
        long,
        conflicts_with = "state_directory",
        required_unless_present = "state_directory"
    )]
    gateway: Option<String>,
    #[arg(long)]
    state_directory: Option<PathBuf>,
}

#[derive(Clone, Copy, ValueEnum)]
enum RecoveryDecision {
    Failed,
    Retry,
}

#[derive(Subcommand)]
enum Command {
    /// Manage GitHub Workspace sources pinned to one repository and commit.
    GithubWorkspace {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: github_workspaces::GithubWorkspaceCommand,
    },
    /// Inspect connector deliveries and resolve uncertain replies from provider evidence.
    Replies {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: replies::ReplyCommand,
    },
    /// Manage reusable Permission Sets, Context Sets, and Roles.
    Policy {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: policy::PolicyCommand,
    },
    /// Bind verified connector accounts and locations to Tag policy.
    SurfacePolicy {
        #[command(flatten)]
        connection: Connection,
        #[command(flatten)]
        args: surface_policy::SurfacePolicyArgs,
    },
    /// Read Worker Host readiness and manage draining.
    Host {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: host_status::HostCommand,
    },
    /// Read and answer work waiting on an operator.
    Inbox {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: inbox::InboxCommand,
    },
    /// Read the messages sent to or from a Tag.
    Mailbox {
        #[command(flatten)]
        connection: Connection,
        tag_id: String,
        #[arg(long, default_value_t = 32)]
        limit: u32,
        #[arg(long, default_value = "")]
        cursor: String,
    },
    /// Manage permission to send direct messages between Tags.
    MailboxGrants {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: mailbox_grants::MailboxGrantCommand,
    },
    /// Read the Work Sessions started by a Tag.
    WorkSessions {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: work_sessions::WorkSessionCommand,
    },
    /// Manage Teams and read their Workstream posts.
    Team {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: teams::TeamCommand,
    },
    /// Start the local Control Plane, Gateway, and Worker Host.
    Up {
        #[arg(long)]
        state_directory: PathBuf,
        #[command(flatten)]
        adapter: AdapterOptions,
        /// Private host allowlist of Skill packages.
        #[arg(long)]
        skill_catalog: Option<PathBuf>,
        #[arg(long, default_value = "127.0.0.1:0")]
        gateway_listen: SocketAddr,
    },
    /// Run the private service that stores work and schedules execution.
    ControlPlane {
        #[arg(long, default_value = "127.0.0.1:0")]
        listen: SocketAddr,
    },
    /// Run the public gRPC service for operators and Worker Hosts.
    Gateway {
        #[arg(long, default_value = "127.0.0.1:0")]
        listen: SocketAddr,
        #[arg(long)]
        control_plane: String,
        #[arg(long)]
        checkpoint_directory: Option<PathBuf>,
        #[arg(long, requires = "slack_state_directory")]
        slack_listen: Option<SocketAddr>,
        #[arg(long, requires = "slack_listen")]
        slack_state_directory: Option<PathBuf>,
        #[arg(long, requires = "github_state_directory")]
        github_listen: Option<SocketAddr>,
        #[arg(long, requires = "github_listen")]
        github_state_directory: Option<PathBuf>,
        /// Private scratch for GitHub source bundles, using the configured GitHub account.
        #[arg(long)]
        github_workspace_directory: Option<PathBuf>,
        #[arg(long, requires = "linear_state_directory")]
        linear_listen: Option<SocketAddr>,
        #[arg(long, requires = "linear_listen")]
        linear_state_directory: Option<PathBuf>,
        /// Enable the outbound Lark or Feishu connection and store reply receipts here.
        #[arg(long)]
        lark_state_directory: Option<PathBuf>,
        #[arg(long, requires = "microsoft_teams_state_directory")]
        microsoft_teams_listen: Option<SocketAddr>,
        #[arg(long, requires = "microsoft_teams_listen")]
        microsoft_teams_state_directory: Option<PathBuf>,
    },
    /// Open the Go terminal UI for a running Gateway.
    Tui {
        #[command(flatten)]
        connection: Connection,
        #[arg(long)]
        binary: Option<PathBuf>,
        #[arg(long)]
        workspace: Option<String>,
    },
    /// Connect a Worker Host and run accepted Tasks through an adapter.
    WorkerHost {
        #[arg(long)]
        gateway: String,
        #[arg(long)]
        state_directory: PathBuf,
        #[command(flatten)]
        adapter: AdapterOptions,
        /// Executable for a private E2B workspace provider used by Cursor.
        #[arg(long)]
        e2b_workspace_provider: Option<PathBuf>,
        /// Argument to the E2B provider, such as the compiled helper entrypoint.
        #[arg(long, requires = "e2b_workspace_provider", allow_hyphen_values = true)]
        e2b_workspace_provider_arg: Vec<std::ffi::OsString>,
        /// Executable for a private Modal Workspace provider used by Cursor.
        #[arg(long, conflicts_with = "e2b_workspace_provider")]
        modal_workspace_provider: Option<PathBuf>,
        /// Argument to the Modal provider, such as the compiled helper entrypoint.
        #[arg(
            long,
            requires = "modal_workspace_provider",
            allow_hyphen_values = true
        )]
        modal_workspace_provider_arg: Vec<std::ffi::OsString>,
        /// Owner-only JSON catalog of HTTP MCP tools for Claude Code Tasks.
        #[arg(
            long,
            conflicts_with_all = ["e2b_workspace_provider", "modal_workspace_provider"],
            long_help = r#"Owner-only JSON catalog of HTTP MCP tools for Claude Code Tasks.

Use {"version":1,"servers":[{"name":"catalog","url":"https://example.com/mcp","headerEnv":{"Authorization":"CATALOG_AUTH"}}]}. Set CATALOG_AUTH to the full header value in the Worker Host environment. The optional resources.tools object maps each tool name to a list of rules, for example [{"prefix":"repository:","separator":"/","components":[{"arguments":["owner"]},{"arguments":["repo"]}]}].

Catalog entries expose tools only when the Task's accepted Permission Sets grant them. Calls requiring approval are refused. Endpoints must use HTTPS or literal loopback HTTP."#
        )]
        mcp_catalog: Option<PathBuf>,
        /// Private host allowlist of Skill packages.
        #[arg(long)]
        skill_catalog: Option<PathBuf>,
        #[arg(long, default_value_t = 120)]
        attempt_timeout_seconds: u64,
        #[arg(long)]
        once: bool,
        #[arg(long)]
        wait_for_recovery: bool,
    },
    /// Create a one-time, scoped Auth Key for a Worker Host.
    CreateAuthKey {
        #[command(flatten)]
        connection: Connection,
        host_id: String,
        #[arg(long, default_value_t = 600)]
        expires_in_seconds: u64,
        #[arg(
            long,
            conflicts_with = "all_tags",
            required_unless_present = "all_tags"
        )]
        tag: Vec<String>,
        #[arg(long)]
        all_tags: bool,
    },
    /// Enroll this installation with a one-time Auth Key.
    EnrollHost {
        #[arg(long)]
        gateway: String,
        #[arg(long)]
        state_directory: PathBuf,
        host_id: String,
        /// Auth Key or file:PATH. Also reads SUPERTAG_AUTH_KEY.
        #[arg(long)]
        auth_key: Option<String>,
    },
    /// Revoke a Worker Host and its execution authority.
    RevokeHost {
        #[command(flatten)]
        connection: Connection,
        host_id: String,
    },
    #[command(name = "__codex-adapter", hide = true)]
    CodexAdapter(CodexAdapterArgs),
    #[command(name = "__adapter-guardian", hide = true)]
    AdapterGuardian {
        #[arg(long)]
        adapter: PathBuf,
        #[arg(last = true)]
        adapter_args: Vec<OsString>,
    },
    /// Set the instructions and allowed actions for a Tag.
    PutTag {
        #[command(flatten)]
        connection: Connection,
        tag_id: String,
        /// Display name. Defaults to the Tag ID for a new Tag.
        #[arg(long = "name")]
        display_name: Option<String>,
        #[arg(long)]
        instructions: String,
        #[arg(long)]
        allow: Vec<String>,
        /// Require approval before this Tag posts to a Team Workstream.
        #[arg(long)]
        require_workstream_approval: bool,
        /// Bare operator ID eligible to approve. Omit to allow any eligible operator.
        #[arg(long, requires = "require_workstream_approval")]
        workstream_approver: Vec<String>,
        /// Require approval before this Tag sends a direct message.
        #[arg(long)]
        require_mailbox_approval: bool,
        /// Bare operator ID eligible to approve a direct message.
        #[arg(long, requires = "require_mailbox_approval")]
        mailbox_approver: Vec<String>,
        /// Host-local logical repository binding.
        #[arg(long, requires = "workspace_base")]
        workspace_id: Option<String>,
        /// Full Git object ID from which new Sessions start.
        #[arg(long, requires = "workspace_id")]
        workspace_base: Option<String>,
        /// Required harness for Tasks accepted from this Tag.
        #[arg(long)]
        harness: Option<Harness>,
        /// Allowed model IDs, with the default first. May be repeated.
        #[arg(long = "model", value_delimiter = ',')]
        models: Vec<String>,
        /// Allowed reasoning efforts, with the default first. May be repeated.
        #[arg(long = "effort", value_delimiter = ',')]
        efforts: Vec<String>,
    },
    /// Inspect a Tag by its permanent ID, including after retirement.
    GetTag {
        #[command(flatten)]
        connection: Connection,
        tag_id: String,
    },
    /// List active Tags and optionally include retired identities.
    ListTags {
        #[command(flatten)]
        connection: Connection,
        #[arg(long)]
        include_retired: bool,
        #[arg(long, default_value_t = 100)]
        limit: u32,
        #[arg(long, default_value = "")]
        cursor: String,
    },
    /// Retire a Tag by ID while preserving its work history.
    RetireTag {
        #[command(flatten)]
        connection: Connection,
        tag_id: String,
        /// Show blockers and what retirement would detach.
        #[arg(long)]
        dry_run: bool,
    },
    /// Accept one turn of work in a Tag's Session.
    Submit {
        #[command(flatten)]
        connection: Connection,
        #[arg(long)]
        tag: String,
        #[arg(long)]
        session: String,
        #[arg(long)]
        operation_id: Option<String>,
        /// Stop the turn when its reported token count reaches this limit.
        #[arg(long)]
        max_reported_tokens: Option<u64>,
        /// Apply a provider-reported spending limit in minor currency units.
        #[arg(long, requires = "reported_cost_currency")]
        max_reported_cost_minor: Option<u64>,
        /// Three-letter currency for the reported cost limit.
        #[arg(long, requires = "max_reported_cost_minor")]
        reported_cost_currency: Option<String>,
        /// Limit native agents and Work Sessions started by this turn.
        #[arg(long)]
        max_native_agents: Option<u64>,
        prompt: String,
    },
    /// Read a Task.
    GetTask {
        #[command(flatten)]
        connection: Connection,
        task_id: String,
    },
    /// Download the patch or Git bundle published by a successful workspace Task.
    WorkspaceArtifact {
        #[command(flatten)]
        connection: Connection,
        task_id: String,
        #[arg(long, value_enum)]
        kind: artifacts::ArtifactKind,
        #[arg(long)]
        output: PathBuf,
    },
    /// Read a page of recorded Task events.
    TaskEvents {
        #[command(flatten)]
        connection: Connection,
        task_id: String,
        #[arg(long, default_value_t = 0)]
        after: u64,
    },
    /// Read native token usage recorded for a Task Attempt.
    TaskUsage {
        #[command(flatten)]
        connection: Connection,
        task_id: String,
        attempt_id: String,
        #[arg(long, default_value_t = 0)]
        after: u64,
    },
    /// Cancel a Task.
    Cancel {
        #[command(flatten)]
        connection: Connection,
        task_id: String,
    },
    /// Record an audited decision for a stopped, uncertain Task Attempt.
    ResolveAttempt {
        #[command(flatten)]
        connection: Connection,
        task_id: String,
        attempt_id: String,
        #[arg(long, value_enum)]
        decision: RecoveryDecision,
        #[arg(long)]
        evidence: String,
        #[arg(long)]
        confirmed_stopped: bool,
        #[arg(long)]
        operation_id: Option<String>,
    },
    /// Direct input into an active Task and inspect its delivery.
    Input {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: inputs::InputCommand,
    },
    /// Manage an Objective and inspect its owner's work.
    Objective {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: objectives::ObjectiveCommand,
    },
}

fn main() -> Result<()> {
    let command = match Cli::parse().command {
        Some(command) => command,
        None => Command::Tui {
            connection: tui::default_connection()?,
            binary: None,
            workspace: None,
        },
    };
    match command {
        Command::AdapterGuardian {
            adapter,
            adapter_args,
        } => supertag_worker_host::guard_adapter(&adapter, &adapter_args),
        Command::CodexAdapter(args) => tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(harness::run_codex(args)),
        command => tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()?
            .block_on(run(command)),
    }
}

async fn run(command: Command) -> Result<()> {
    match command {
        Command::Policy {
            connection,
            command,
        } => policy::run(connection, command).await?,
        Command::SurfacePolicy { connection, args } => {
            use supertag_protocol::v2::surface_policy_catalog_client::SurfacePolicyCatalogClient;
            let (channel, token) = connect_operator(connection).await?;
            let client = SurfacePolicyCatalogClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES);
            surface_policy::run(client, &token, args).await?;
        }
        Command::Host {
            connection,
            command,
        } => host_status::run(connection, command).await?,
        Command::Replies {
            connection,
            command,
        } => replies::run(connection, command).await?,
        Command::Inbox {
            connection,
            command,
        } => inbox::run(connection, command).await?,
        Command::MailboxGrants {
            connection,
            command,
        } => mailbox_grants::run(connection, command).await?,
        Command::WorkSessions {
            connection,
            command,
        } => work_sessions::run(connection, command).await?,
        Command::Mailbox {
            connection,
            tag_id,
            limit,
            cursor,
        } => {
            use supertag_protocol::v2::{
                ListMailboxMessagesRequest, mailbox_client::MailboxClient,
            };
            let (channel, token) = connect_operator(connection).await?;
            let page = MailboxClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .list_messages(request(
                    ListMailboxMessagesRequest {
                        tag_id,
                        limit,
                        cursor,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            let messages = page
                .messages
                .into_iter()
                .map(|message| {
                    json!({
                        "message_id": message.message_id,
                        "sender_tag_id": message.sender_tag_id,
                        "recipient_tag_id": message.recipient_tag_id,
                        "source_task_id": message.source_task_id,
                        "origin": message.origin().as_str_name(),
                        "workstream_post_id": message.workstream_post_id,
                        "objective_id": message.objective_id,
                        "text": message.text,
                        "hops": message.hops,
                        "task_id": message.task_id,
                        "state": message.state().as_str_name(),
                        "created_at_ms": message.created_at_ms,
                    })
                })
                .collect::<Vec<_>>();
            println!(
                "{}",
                json!({ "messages": messages, "next_cursor": page.next_cursor })
            );
        }
        Command::GithubWorkspace {
            connection,
            command,
        } => github_workspaces::run(connection, command).await?,
        Command::Team {
            connection,
            command,
        } => teams::run(connection, command).await?,
        Command::Up {
            state_directory,
            adapter,
            skill_catalog,
            gateway_listen,
        } => {
            local::up(
                local::LocalOptions {
                    state_directory,
                    adapter,
                    skill_catalog,
                    gateway_listen,
                },
                termination_signal(),
            )
            .await?;
        }
        Command::ControlPlane { listen } => control_plane(listen).await?,
        Command::Gateway {
            listen,
            control_plane,
            checkpoint_directory,
            slack_listen,
            slack_state_directory,
            github_listen,
            github_state_directory,
            github_workspace_directory,
            linear_listen,
            linear_state_directory,
            lark_state_directory,
            microsoft_teams_listen,
            microsoft_teams_state_directory,
        } => {
            gateway(
                listen,
                control_plane,
                checkpoint_directory,
                GatewayConnectors {
                    slack: slack_listen.zip(slack_state_directory),
                    github: github_listen.zip(github_state_directory),
                    github_workspace: github_workspace_directory,
                    linear: linear_listen.zip(linear_state_directory),
                    lark: lark_state_directory,
                    microsoft_teams: microsoft_teams_listen.zip(microsoft_teams_state_directory),
                },
            )
            .await?
        }
        Command::Tui {
            connection,
            binary,
            workspace,
        } => {
            tui::launch(connection, binary, workspace).await?;
        }
        Command::WorkerHost {
            gateway,
            state_directory,
            adapter,
            e2b_workspace_provider,
            e2b_workspace_provider_arg,
            modal_workspace_provider,
            modal_workspace_provider_arg,
            mcp_catalog,
            skill_catalog,
            attempt_timeout_seconds,
            once,
            wait_for_recovery,
        } => {
            let harness = adapter.harness_kind();
            ensure!(
                skill_catalog.is_none()
                    || !matches!(
                        harness,
                        HarnessKind::OpenaiAgents | HarnessKind::Opencode | HarnessKind::Cursor
                    ),
                "this Worker Host's selected harness does not load Skills"
            );
            let provider_model = adapter.provider_model();
            let mut execution_profile = adapter.execution_profile()?;
            let workspace = adapter.workspace_mapping();
            use supertag_worker_host::{ProviderAuthority, ProviderConfig};
            let remote_provider = if let Some(executable) = e2b_workspace_provider {
                Some(ProviderConfig {
                    executable,
                    arguments: e2b_workspace_provider_arg,
                    authority: ProviderAuthority::E2b {
                        api_key: std::env::var("E2B_API_KEY").ok(),
                        domain: std::env::var("E2B_DOMAIN").ok(),
                        template: std::env::var("SUPERTAG_E2B_TEMPLATE").ok(),
                    },
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
                })
            } else {
                None
            };
            if remote_provider.is_some() {
                ensure!(
                    harness == HarnessKind::Cursor
                        && workspace.is_some()
                        && !execution_profile.allow_unsandboxed_commands,
                    "remote Workspace placement requires Cursor and a named Workspace without unsandboxed commands"
                );
                execution_profile.remote_file_workspace = true;
            }
            let (adapter, adapter_args) = adapter.launch(attempt_timeout_seconds)?;
            let mcp_catalog = supertag_worker_host::McpCatalog::load(mcp_catalog.as_deref())?;
            execution_profile.mcp_servers = mcp_catalog.capabilities();
            let options = HostOptions {
                gateway: network::endpoint(gateway, false).await?,
                token: std::env::var("SUPERTAG_HOST_TOKEN").ok(),
                state_directory,
                adapter_guardian: std::env::current_exe()?,
                adapter,
                adapter_args,
                harness,
                provider_model,
                execution_profile,
                attempt_timeout: Duration::from_secs(attempt_timeout_seconds),
                wait_for_recovery,
                once,
                workspace,
                remote_provider,
                context_catalog: supertag_worker_host::context::ContextCatalog::load(
                    skill_catalog.as_deref(),
                )?,
                mcp_catalog,
            };
            let token = CancellationToken::new();
            let shutdown = token.clone();
            let signal = tokio::spawn(async move {
                termination_signal().await;
                shutdown.cancel();
            });
            let result = supertag_worker_host::run(options, token, || println!("ready")).await;
            signal.abort();
            result?;
        }
        Command::CreateAuthKey {
            connection,
            host_id,
            expires_in_seconds,
            tag,
            all_tags,
        } => {
            let (mut operator, token) = operator(connection).await?;
            let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
            let key = operator
                .create_auth_key(request(
                    CreateAuthKeyRequest {
                        host_id,
                        operation_id: Uuid::new_v4().to_string(),
                        key_digest: Sha256::digest(secret.as_bytes()).to_vec(),
                        expires_in_ms: expires_in_seconds
                            .checked_mul(1000)
                            .context("invalid Auth Key lifetime")?,
                        allowed_tag_ids: tag,
                        all_tags,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            println!(
                "{}",
                json!({
                    "auth_key": secret,
                    "host_id": key.host_id,
                    "expires_at_ms": key.expires_at_ms,
                    "allowed_tag_ids": key.allowed_tag_ids,
                    "all_tags": key.all_tags,
                })
            );
        }
        Command::EnrollHost {
            gateway,
            state_directory,
            host_id,
            auth_key,
        } => {
            let gateway = network::endpoint(gateway, false).await?;
            let auth_key = auth_key.or_else(|| std::env::var("SUPERTAG_AUTH_KEY").ok());
            let auth_key = match auth_key {
                Some(key) if key.starts_with("file:") => {
                    let path = key.strip_prefix("file:").expect("checked prefix");
                    let contents = tokio::fs::read_to_string(path)
                        .await
                        .context("read Auth Key file")?;
                    Some(contents.trim().to_owned())
                }
                other => other,
            };
            let record = supertag_worker_host::enroll(
                gateway,
                &state_directory,
                host_id,
                auth_key.as_deref(),
            )
            .await?;
            println!(
                "{}",
                json!({ "host_id": record.host_id, "generation": record.generation })
            );
        }
        Command::RevokeHost {
            connection,
            host_id,
        } => {
            let (mut operator, token) = operator(connection).await?;
            let record = operator
                .revoke_host(request(RevokeHostRequest { host_id }, &token)?)
                .await?
                .into_inner();
            println!(
                "{}",
                json!({ "host_id": record.host_id, "revoked": record.revoked })
            );
        }
        Command::AdapterGuardian { .. } => unreachable!("guardian runs outside Tokio"),
        Command::CodexAdapter(_) => unreachable!("Codex adapter uses a dedicated runtime"),
        Command::PutTag {
            connection,
            tag_id,
            display_name,
            instructions,
            mut allow,
            require_workstream_approval,
            workstream_approver,
            require_mailbox_approval,
            mailbox_approver,
            workspace_id,
            workspace_base,
            harness,
            models,
            efforts,
        } => {
            let workspace = workspace_id
                .zip(workspace_base)
                .map(|(workspace_id, base_commit)| WorkspaceSpec {
                    workspace_id,
                    base_commit,
                    github_source: None,
                });
            let mut approval_rules = Vec::new();
            for (required, action, operator_ids) in [
                (
                    require_workstream_approval,
                    "workstream:post",
                    workstream_approver,
                ),
                (require_mailbox_approval, "mailbox:send", mailbox_approver),
            ] {
                if !required {
                    continue;
                }
                let action = action.to_string();
                allow.push(action.clone());
                approval_rules.push(ApprovalRule {
                    action,
                    operator_ids,
                });
            }
            let (mut operator, token) = operator(connection).await?;
            let tag = operator
                .put_tag(request(
                    PutTagRequest {
                        tag_id,
                        name: display_name,
                        instructions,
                        allowed_actions: allow,
                        workspace,
                        harness_kind: harness.map_or(HarnessKind::Unspecified, Harness::kind)
                            as i32,
                        approval_rules,
                        execution: (!models.is_empty() || !efforts.is_empty()).then_some(
                            PolicyExecutionSettings {
                                models,
                                efforts,
                                harness: None,
                            },
                        ),
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            println!(
                "{}",
                json!({ "tag_id": tag.tag_id, "name": tag.name, "revision": tag.revision })
            );
        }
        Command::GetTag { connection, tag_id } => {
            let (mut operator, token) = operator(connection).await?;
            let tag = operator
                .get_tag(request(GetTagRequest { tag_id }, &token)?)
                .await?
                .into_inner();
            println!("{}", tag_json(&tag));
        }
        Command::ListTags {
            connection,
            include_retired,
            limit,
            cursor,
        } => {
            let (mut operator, token) = operator(connection).await?;
            let page = operator
                .list_tags(request(
                    ListTagsRequest {
                        limit,
                        cursor,
                        include_retired,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            println!(
                "{}",
                json!({
                    "tags": page.tags.iter().map(tag_json).collect::<Vec<_>>(),
                    "next_cursor": page.next_cursor,
                })
            );
        }
        Command::RetireTag {
            connection,
            tag_id,
            dry_run,
        } => {
            let (mut operator, token) = operator(connection).await?;
            let response = operator
                .retire_tag(request(RetireTagRequest { tag_id, dry_run }, &token)?)
                .await?
                .into_inner();
            println!(
                "{}",
                json!({
                    "tag": response.tag.as_ref().map(tag_json),
                    "dry_run": dry_run,
                    "blockers": response.blockers,
                    "surface_locations": response.surface_locations,
                    "host_bindings": response.host_bindings,
                    "mailbox_grants": response.mailbox_grants,
                    "role_assignments": response.role_assignments,
                })
            );
        }
        Command::Submit {
            connection,
            tag,
            session,
            operation_id,
            max_reported_tokens,
            max_reported_cost_minor,
            reported_cost_currency,
            max_native_agents,
            prompt,
        } => {
            let (mut operator, token) = operator(connection).await?;
            let max_reported_cost = max_reported_cost_minor.zip(reported_cost_currency).map(
                |(amount_minor, currency)| ReportedCostLimit {
                    amount_minor,
                    currency,
                },
            );
            let execution_limits = (max_reported_tokens.is_some()
                || max_reported_cost.is_some()
                || max_native_agents.is_some())
            .then_some(ExecutionLimits {
                max_reported_tokens,
                max_reported_cost,
                max_native_agents,
            });
            let task = operator
                .submit_task(request(
                    SubmitTaskRequest {
                        tag_id: tag,
                        session_id: session,
                        prompt,
                        operation_id: operation_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
                        execution_limits,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            print_task(&task);
        }
        Command::GetTask {
            connection,
            task_id,
        } => {
            let (mut operator, token) = operator(connection).await?;
            let task = operator
                .get_task(request(GetTaskRequest { task_id }, &token)?)
                .await?
                .into_inner();
            print_task(&task);
        }
        Command::WorkspaceArtifact {
            connection,
            task_id,
            kind,
            output,
        } => {
            artifacts::download(connection, task_id, kind, &output).await?;
        }
        Command::TaskEvents {
            connection,
            task_id,
            after,
        } => {
            let (mut operator, token) = operator(connection).await?;
            let events = operator
                .list_events(request(
                    ListEventsRequest {
                        task_id,
                        after_sequence: after,
                        limit: 100,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            for event in events.events {
                println!(
                    "{}",
                    json!({ "sequence": event.sequence, "text": event.text })
                );
            }
        }
        Command::TaskUsage {
            connection,
            task_id,
            attempt_id,
            after,
        } => {
            let (mut operator, token) = operator(connection).await?;
            let response = operator
                .list_native_usage(request(
                    ListNativeUsageRequest {
                        task_id,
                        attempt_id,
                        after_sequence: after,
                        limit: 100,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            for report in response.reports {
                if let Some(usage) = report.native_usage {
                    println!(
                        "{}",
                        json!({
                            "sequence": report.sequence,
                            "input_tokens": usage.input_tokens,
                            "cached_input_tokens": usage.cached_input_tokens,
                            "output_tokens": usage.output_tokens,
                            "total_tokens": usage.total_tokens,
                            "observed_model": usage.observed_model,
                            "reported_cost": report.amount_minor.zip(report.currency).map(|(amount_minor, currency)| json!({
                                "amount_minor": amount_minor, "currency": currency, "estimated": report.estimated,
                            })),
                        })
                    );
                }
            }
        }
        Command::Cancel {
            connection,
            task_id,
        } => {
            let (mut operator, token) = operator(connection).await?;
            let task = operator
                .cancel_task(request(CancelTaskRequest { task_id }, &token)?)
                .await?
                .into_inner();
            print_task(&task);
        }
        Command::ResolveAttempt {
            connection,
            task_id,
            attempt_id,
            decision,
            evidence,
            confirmed_stopped,
            operation_id,
        } => {
            let (mut client, token) = operator(connection).await?;
            let decision = match decision {
                RecoveryDecision::Failed => AttemptDecision::Failed,
                RecoveryDecision::Retry => AttemptDecision::Retry,
            };
            let resolution = client
                .resolve_attempt(request(
                    ResolveAttemptRequest {
                        task_id,
                        attempt_id,
                        decision: decision as i32,
                        evidence,
                        confirmed_stopped,
                        operation_id: operation_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            println!(
                "{}",
                json!({
                    "task_id": resolution.task_id, "attempt_id": resolution.attempt_id,
                    "decision": resolution.decision().as_str_name(),
                    "operator_id": resolution.operator_id, "resolved_at_ms": resolution.resolved_at_ms,
                })
            );
        }
        Command::Input {
            connection,
            command,
        } => inputs::run(connection, command).await?,
        Command::Objective {
            connection,
            command,
        } => objectives::run(connection, command).await?,
    }
    Ok(())
}

async fn control_plane(listen: SocketAddr) -> Result<()> {
    let mut builder = network::server(listen, true).await?;
    let plane = ControlPlane::open(
        &required_env("SUPERTAG_DATABASE_URL")?,
        required_env("SUPERTAG_GATEWAY_TOKEN")?,
    )
    .await?;
    if let Ok(token) = std::env::var("SUPERTAG_BOOTSTRAP_HOST_TOKEN") {
        ensure!(
            token.len() >= 32,
            "invalid bootstrap Worker Host credential"
        );
        plane
            .seed_host("local", &Sha256::digest(token.as_bytes()))
            .await?;
    }
    let (health, health_service) = tonic_health::server::health_reporter();
    health.set_serving::<OperatorServer<ControlPlane>>().await;
    health
        .set_serving::<ConversationsServer<ControlPlane>>()
        .await;
    health.set_serving::<WorkerHostServer<ControlPlane>>().await;
    health
        .set_serving::<HostDirectoryServer<ControlPlane>>()
        .await;
    health
        .set_serving::<CheckpointDirectoryServer<ControlPlane>>()
        .await;
    health
        .set_serving::<WorkspaceDirectoryServer<ControlPlane>>()
        .await;
    health.set_serving::<LiveInputsServer<ControlPlane>>().await;
    health
        .set_serving::<AttemptInputsServer<ControlPlane>>()
        .await;
    health.set_serving::<ConnectorServer<ControlPlane>>().await;
    health.set_serving::<ObjectivesServer<ControlPlane>>().await;
    health.set_serving::<TeamsServer<ControlPlane>>().await;
    health
        .set_serving::<AttemptWorkstreamsServer<ControlPlane>>()
        .await;
    health.set_serving::<MailboxServer<ControlPlane>>().await;
    health.set_serving::<InboxServer<ControlPlane>>().await;
    health
        .set_serving::<PolicyCatalogServer<ControlPlane>>()
        .await;
    health
        .set_serving::<SurfacePolicyCatalogServer<ControlPlane>>()
        .await;
    health
        .set_serving::<WorkSessionsServer<ControlPlane>>()
        .await;
    health
        .set_serving::<AttemptWorkSessionsServer<ControlPlane>>()
        .await;
    health
        .set_serving::<AttemptMailboxServer<ControlPlane>>()
        .await;
    health
        .set_serving::<OperatorEventsServer<OperatorWatch>>()
        .await;
    let listener = TcpListener::bind(listen).await?;
    println!("{}", listener.local_addr()?);
    let maintenance = plane.clone();
    let sweep = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if let Err(error) = maintenance.sweep().await {
                eprintln!("Control Plane maintenance failed: {error}");
            }
        }
    });
    let watch_shutdown = CancellationToken::new();
    let served = builder
        .add_service(health_service)
        .add_service(
            OperatorServer::new(plane.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
        )
        .add_service(
            ConversationsServer::new(plane.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
        )
        .add_service(
            WorkerHostServer::new(plane.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
        )
        .add_service(
            HostDirectoryServer::new(plane.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
        )
        .add_service(
            CheckpointDirectoryServer::new(plane.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
        )
        .add_service(
            WorkspaceDirectoryServer::new(plane.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
        )
        .add_service(
            LiveInputsServer::new(plane.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
        )
        .add_service(
            AttemptInputsServer::new(plane.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
        )
        .add_service(
            ConnectorServer::new(plane.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
        )
        .add_service(plane.teams_service())
        .add_service(plane.attempt_workstreams_service())
        .add_service(plane.mailbox_service())
        .add_service(plane.inbox_service())
        .add_service(plane.github_workspaces_service())
        .add_service(plane.policy_service())
        .add_service(plane.surface_policy_service())
        .add_service(plane.work_sessions_service())
        .add_service(plane.attempt_work_sessions_service())
        .add_service(plane.attempt_mailbox_service())
        .add_service(plane.operator_events_service(watch_shutdown.clone()))
        .add_service(
            ObjectivesServer::new(plane)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
        )
        .serve_with_incoming_shutdown(
            TcpListenerStream::new(listener),
            watch_shutdown.clone().cancelled_owned(),
        );
    tokio::pin!(served);
    let result = tokio::select! {
        result = &mut served => result.map_err(anyhow::Error::from),
        _ = termination_signal() => {
            watch_shutdown.cancel();
            tokio::time::timeout(Duration::from_secs(15), served)
                .await
                .context("Control Plane shutdown timed out")
                .and_then(|result| result.map_err(anyhow::Error::from))
        }
    };
    sweep.abort();
    let _ = sweep.await;
    result
}

struct GatewayConnectors {
    slack: Option<(SocketAddr, PathBuf)>,
    github: Option<(SocketAddr, PathBuf)>,
    github_workspace: Option<PathBuf>,
    linear: Option<(SocketAddr, PathBuf)>,
    lark: Option<PathBuf>,
    microsoft_teams: Option<(SocketAddr, PathBuf)>,
}

async fn gateway(
    listen: SocketAddr,
    control_plane: String,
    checkpoint_directory: Option<PathBuf>,
    connectors: GatewayConnectors,
) -> Result<()> {
    let mut builder = network::server(listen, false).await?;
    let channel = network::endpoint(control_plane, true)
        .await?
        .connect()
        .await?;
    let gateway_token = required_env("SUPERTAG_GATEWAY_TOKEN")?;
    let slack = match connectors.slack {
        Some((address, state_directory)) => {
            ensure!(
                address.ip().is_loopback(),
                "Slack webhook listener must use loopback"
            );
            let connector =
                slack_connector(channel.clone(), gateway_token.clone(), state_directory)?;
            Some((connector, TcpListener::bind(address).await?))
        }
        None => None,
    };
    let github = match connectors.github {
        Some((address, state_directory)) => {
            ensure!(
                address.ip().is_loopback(),
                "GitHub webhook listener must use loopback"
            );
            let connector =
                github_connector(channel.clone(), gateway_token.clone(), state_directory)?;
            Some((connector, TcpListener::bind(address).await?))
        }
        None => None,
    };
    let linear = match connectors.linear {
        Some((address, state_directory)) => {
            ensure!(
                address.ip().is_loopback(),
                "Linear webhook listener must use loopback"
            );
            let connector =
                linear_connector(channel.clone(), gateway_token.clone(), state_directory)?;
            Some((connector, TcpListener::bind(address).await?))
        }
        None => None,
    };
    let microsoft_teams = match connectors.microsoft_teams {
        Some((address, state_directory)) => {
            ensure!(
                address.ip().is_loopback(),
                "Microsoft Teams webhook listener must use loopback"
            );
            let connector =
                microsoft_teams_connector(channel.clone(), gateway_token.clone(), state_directory)?;
            Some((connector, TcpListener::bind(address).await?))
        }
        None => None,
    };
    let lark = connectors
        .lark
        .map(|directory| lark_connector(channel.clone(), gateway_token.clone(), directory))
        .transpose()?;
    let gateway = Gateway::new(
        channel,
        gateway_token,
        required_env("SUPERTAG_OPERATOR_TOKEN")?,
        std::env::var("SUPERTAG_OPERATOR_PRINCIPAL").unwrap_or_else(|_| "operator:local".into()),
    )?;
    let (health, health_service) = tonic_health::server::health_reporter();
    health.set_serving::<OperatorServer<Gateway>>().await;
    health.set_serving::<ConversationsServer<Gateway>>().await;
    health.set_serving::<WorkerHostServer<Gateway>>().await;
    health.set_serving::<HostEnrollmentServer<Gateway>>().await;
    health
        .set_serving::<TransfersServer<GatewayTransfers>>()
        .await;
    let mut transfers = GatewayTransfers::new(gateway.clone(), checkpoint_directory)?;
    if let Some(directory) = connectors.github_workspace {
        transfers = transfers.with_github_sources(github_workspace_sources(directory)?);
    }
    health.set_serving::<ObjectivesServer<Gateway>>().await;
    health.set_serving::<LiveInputsServer<Gateway>>().await;
    health.set_serving::<AttemptInputsServer<Gateway>>().await;
    health.set_serving::<TeamsServer<Gateway>>().await;
    health
        .set_serving::<AttemptWorkstreamsServer<Gateway>>()
        .await;
    health.set_serving::<MailboxServer<Gateway>>().await;
    health.set_serving::<InboxServer<Gateway>>().await;
    health.set_serving::<PolicyCatalogServer<Gateway>>().await;
    health
        .set_serving::<SurfacePolicyCatalogServer<Gateway>>()
        .await;
    health.set_serving::<WorkSessionsServer<Gateway>>().await;
    health
        .set_serving::<AttemptWorkSessionsServer<Gateway>>()
        .await;
    health.set_serving::<AttemptMailboxServer<Gateway>>().await;
    health
        .set_serving::<OperatorEventsServer<GatewayWatch>>()
        .await;
    let listener = TcpListener::bind(listen).await?;
    println!("{}", listener.local_addr()?);
    if let Some((_, listener)) = &slack {
        println!("{}", listener.local_addr()?);
    }
    if let Some((_, listener)) = &github {
        println!("{}", listener.local_addr()?);
    }
    if let Some((_, listener)) = &linear {
        println!("{}", listener.local_addr()?);
    }
    if let Some((_, listener)) = &microsoft_teams {
        println!("{}", listener.local_addr()?);
    }
    let shutdown = CancellationToken::new();
    let router = builder
        .add_service(health_service)
        .add_service(gateway.operator_service())
        .add_service(gateway.conversations_service())
        .add_service(gateway.worker_host_service())
        .add_service(gateway.host_enrollment_service())
        .add_service(transfers.service())
        .add_service(gateway.objectives_service())
        .add_service(gateway.live_inputs_service())
        .add_service(gateway.attempt_inputs_service())
        .add_service(gateway.teams_service())
        .add_service(gateway.attempt_workstreams_service())
        .add_service(gateway.mailbox_service())
        .add_service(gateway.inbox_service())
        .add_service(gateway.github_workspaces_service())
        .add_service(gateway.policy_service())
        .add_service(gateway.surface_policy_service())
        .add_service(gateway.work_sessions_service())
        .add_service(gateway.attempt_work_sessions_service())
        .add_service(gateway.attempt_mailbox_service())
        .add_service(gateway.operator_events_service(shutdown.clone()));
    let grpc = async {
        let result = router
            .serve_with_incoming_shutdown(
                TcpListenerStream::new(listener),
                shutdown.clone().cancelled_owned(),
            )
            .await;
        shutdown.cancel();
        result
    };
    let webhook = async {
        if let Some((slack, listener)) = slack {
            let result = slack.serve(listener, shutdown.clone()).await;
            shutdown.cancel();
            result
        } else {
            shutdown.cancelled().await;
            Ok(())
        }
    };
    let github_webhook = async {
        if let Some((github, listener)) = github {
            let result = github.serve(listener, shutdown.clone()).await;
            shutdown.cancel();
            result
        } else {
            shutdown.cancelled().await;
            Ok(())
        }
    };
    let linear_webhook = async {
        if let Some((linear, listener)) = linear {
            let result = linear.serve(listener, shutdown.clone()).await;
            shutdown.cancel();
            result
        } else {
            shutdown.cancelled().await;
            Ok(())
        }
    };
    let lark_connection = async {
        if let Some(lark) = lark {
            let result = lark.run(shutdown.clone()).await;
            shutdown.cancel();
            result
        } else {
            shutdown.cancelled().await;
            Ok(())
        }
    };
    let microsoft_teams_webhook = async {
        if let Some((teams, listener)) = microsoft_teams {
            let result = teams.serve(listener, shutdown.clone()).await;
            shutdown.cancel();
            result
        } else {
            shutdown.cancelled().await;
            Ok(())
        }
    };
    let services = async {
        let (grpc, slack, github, linear, lark, teams) = tokio::join!(
            grpc,
            webhook,
            github_webhook,
            linear_webhook,
            lark_connection,
            microsoft_teams_webhook
        );
        grpc?;
        slack?;
        github?;
        linear?;
        lark?;
        teams
    };
    tokio::pin!(services);
    tokio::select! {
        result = &mut services => result,
        _ = termination_signal() => {
            shutdown.cancel();
            tokio::time::timeout(Duration::from_secs(15), services)
                .await.context("Gateway shutdown timed out")?
        }
    }
}

fn slack_connector(
    channel: Channel,
    gateway_token: String,
    state_directory: PathBuf,
) -> Result<Slack> {
    let connector = Slack::new(
        SlackConfig {
            account_id: required_env("SUPERTAG_SLACK_ACCOUNT_ID")?,
            team_id: required_env("SUPERTAG_SLACK_TEAM_ID")?,
            channel_id: required_env("SUPERTAG_SLACK_CHANNEL_ID")?,
            tag_id: required_env("SUPERTAG_SLACK_TAG_ID")?,
            allowed_users: required_env("SUPERTAG_SLACK_ALLOWED_USERS")?
                .split(',')
                .map(|user| user.trim().to_owned())
                .collect(),
            signing_secret: required_env("SUPERTAG_SLACK_SIGNING_SECRET")?,
            bot_token: required_env("SUPERTAG_SLACK_BOT_TOKEN")?,
            state_directory,
        },
        channel,
        gateway_token,
    )?;
    #[cfg(feature = "test-fixtures")]
    if let Ok(url) = std::env::var("SUPERTAG_TEST_SLACK_API_URL") {
        return connector.with_test_reply_url(&url);
    }
    Ok(connector)
}

fn github_workspace_sources(directory: PathBuf) -> Result<GithubWorkspaceSources> {
    use std::os::unix::fs::DirBuilderExt as _;
    if !directory.exists() {
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .context("create private GitHub Workspace directory")?;
    }
    let sources = GithubWorkspaceSources::new(
        GithubWorkspaceAccount {
            account_id: required_env("SUPERTAG_GITHUB_ACCOUNT_ID")?,
            repository_id: required_env("SUPERTAG_GITHUB_REPOSITORY_ID")?
                .parse()
                .context("invalid GitHub repository ID")?,
            repository: required_env("SUPERTAG_GITHUB_REPOSITORY")?,
            authentication: github_authentication()?,
        },
        &directory,
    )?;
    #[cfg(feature = "test-fixtures")]
    if let Ok(api) = std::env::var("SUPERTAG_TEST_GITHUB_API_URL") {
        return sources.with_test_endpoints(
            api.parse()?,
            required_env("SUPERTAG_TEST_GITHUB_GIT_URL")?.parse()?,
        );
    }
    Ok(sources)
}

fn github_connector(
    channel: Channel,
    gateway_token: String,
    state_directory: PathBuf,
) -> Result<Github> {
    let connector = Github::new(
        GithubConfig {
            account_id: required_env("SUPERTAG_GITHUB_ACCOUNT_ID")?,
            repository_id: required_env("SUPERTAG_GITHUB_REPOSITORY_ID")?
                .parse()
                .context("invalid GitHub repository ID")?,
            repository: required_env("SUPERTAG_GITHUB_REPOSITORY")?,
            tag_id: required_env("SUPERTAG_GITHUB_TAG_ID")?,
            allowed_users: required_env("SUPERTAG_GITHUB_ALLOWED_USERS")?
                .split(',')
                .map(|user| user.trim().parse())
                .collect::<std::result::Result<Vec<u64>, _>>()
                .context("invalid GitHub user ID")?,
            webhook_secret: required_env("SUPERTAG_GITHUB_WEBHOOK_SECRET")?,
            authentication: github_authentication()?,
            state_directory,
        },
        channel,
        gateway_token,
    )?;
    #[cfg(feature = "test-fixtures")]
    if let Ok(url) = std::env::var("SUPERTAG_TEST_GITHUB_API_URL") {
        return connector.with_test_api_url(&url);
    }
    Ok(connector)
}

fn github_authentication() -> Result<GithubAuthentication> {
    use std::{
        fs::OpenOptions,
        io::Read,
        os::unix::fs::{MetadataExt, OpenOptionsExt},
    };

    let app_settings = [
        "SUPERTAG_GITHUB_APP_ID",
        "SUPERTAG_GITHUB_INSTALLATION_ID",
        "SUPERTAG_GITHUB_PRIVATE_KEY_FILE",
    ];
    if !app_settings
        .iter()
        .any(|name| std::env::var_os(name).is_some())
    {
        return Ok(GithubAuthentication::Token(required_env(
            "SUPERTAG_GITHUB_TOKEN",
        )?));
    }
    ensure!(
        std::env::var_os("SUPERTAG_GITHUB_TOKEN").is_none(),
        "select one GitHub authentication mode"
    );
    let path = std::env::var_os("SUPERTAG_GITHUB_PRIVATE_KEY_FILE")
        .context("set SUPERTAG_GITHUB_PRIVATE_KEY_FILE")?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .context("open GitHub App private key")?;
    let metadata = file.metadata().context("inspect GitHub App private key")?;
    ensure!(
        metadata.is_file()
            && metadata.mode() & 0o077 == 0
            && metadata.uid() == unsafe { libc::geteuid() },
        "GitHub App private key must be an owner-only regular file"
    );
    let mut private_key_pem = String::new();
    file.take(65_537)
        .read_to_string(&mut private_key_pem)
        .context("read GitHub App private key")?;
    ensure!(
        private_key_pem.len() <= 65_536,
        "GitHub App private key is too large"
    );
    Ok(GithubAuthentication::App(GithubAppConfig {
        app_id: required_env("SUPERTAG_GITHUB_APP_ID")?
            .parse()
            .context("invalid GitHub App ID")?,
        installation_id: required_env("SUPERTAG_GITHUB_INSTALLATION_ID")?
            .parse()
            .context("invalid GitHub installation ID")?,
        private_key_pem,
    }))
}

fn linear_connector(
    channel: Channel,
    gateway_token: String,
    state_directory: PathBuf,
) -> Result<Linear> {
    let connector = Linear::new(
        LinearConfig {
            account_id: required_env("SUPERTAG_LINEAR_ACCOUNT_ID")?,
            workspace_id: required_env("SUPERTAG_LINEAR_WORKSPACE_ID")?,
            team_id: required_env("SUPERTAG_LINEAR_TEAM_ID")?,
            tag_id: required_env("SUPERTAG_LINEAR_TAG_ID")?,
            allowed_users: required_env("SUPERTAG_LINEAR_ALLOWED_USERS")?
                .split(',')
                .map(|value| value.trim().to_owned())
                .collect(),
            webhook_secret: required_env("SUPERTAG_LINEAR_WEBHOOK_SECRET")?,
            api_key: required_env("SUPERTAG_LINEAR_API_KEY")?,
            state_directory,
        },
        channel,
        gateway_token,
    )?;
    #[cfg(feature = "test-fixtures")]
    if let Ok(url) = std::env::var("SUPERTAG_TEST_LINEAR_API_URL") {
        return connector.with_test_api_url(&url);
    }
    Ok(connector)
}

fn lark_connector(
    channel: Channel,
    gateway_token: String,
    state_directory: PathBuf,
) -> Result<Lark> {
    let domain = match required_env("SUPERTAG_LARK_DOMAIN")?.as_str() {
        "lark" => LarkDomain::Lark,
        "feishu" => LarkDomain::Feishu,
        _ => anyhow::bail!("SUPERTAG_LARK_DOMAIN must be lark or feishu"),
    };
    let connector = Lark::new(
        LarkConfig {
            account_id: required_env("SUPERTAG_LARK_ACCOUNT_ID")?,
            domain,
            app_id: required_env("SUPERTAG_LARK_APP_ID")?,
            app_secret: required_env("SUPERTAG_LARK_APP_SECRET")?,
            tenant_key: required_env("SUPERTAG_LARK_TENANT_KEY")?,
            bot_open_id: required_env("SUPERTAG_LARK_BOT_OPEN_ID")?,
            chat_id: required_env("SUPERTAG_LARK_CHAT_ID")?,
            tag_id: required_env("SUPERTAG_LARK_TAG_ID")?,
            allowed_users: required_env("SUPERTAG_LARK_ALLOWED_USERS")?
                .split(',')
                .map(|value| value.trim().to_owned())
                .collect(),
            state_directory,
        },
        channel,
        gateway_token,
    )?;
    #[cfg(feature = "test-fixtures")]
    if let Ok(url) = std::env::var("SUPERTAG_TEST_LARK_ORIGIN") {
        return connector.with_test_origin(&url);
    }
    Ok(connector)
}

fn microsoft_teams_connector(
    channel: Channel,
    gateway_token: String,
    state_directory: PathBuf,
) -> Result<MicrosoftTeams> {
    let connector = MicrosoftTeams::new(
        MicrosoftTeamsConfig {
            account_id: required_env("SUPERTAG_MICROSOFT_TEAMS_ACCOUNT_ID")?,
            app_id: required_env("SUPERTAG_MICROSOFT_TEAMS_APP_ID")?,
            app_secret: required_env("SUPERTAG_MICROSOFT_TEAMS_APP_SECRET")?,
            tenant_id: required_env("SUPERTAG_MICROSOFT_TEAMS_TENANT_ID")?,
            team_id: required_env("SUPERTAG_MICROSOFT_TEAMS_TEAM_ID")?,
            channel_id: required_env("SUPERTAG_MICROSOFT_TEAMS_CHANNEL_ID")?,
            tag_id: required_env("SUPERTAG_MICROSOFT_TEAMS_TAG_ID")?,
            allowed_users: required_env("SUPERTAG_MICROSOFT_TEAMS_ALLOWED_USERS")?
                .split(',')
                .map(|value| value.trim().to_owned())
                .collect(),
            state_directory,
        },
        channel,
        gateway_token,
    )?;
    #[cfg(feature = "test-fixtures")]
    if let Ok(url) = std::env::var("SUPERTAG_TEST_MICROSOFT_TEAMS_ORIGIN") {
        return connector.with_test_origin(&url);
    }
    Ok(connector)
}

async fn termination_signal() {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("install SIGTERM handler");
    let lifeline = async {
        if std::env::var_os(local::LOCAL_SERVICE_LIFELINE).as_deref()
            != Some(std::ffi::OsStr::new("1"))
        {
            std::future::pending::<()>().await;
        }
        let (closed, wait) = tokio::sync::oneshot::channel();
        let watcher = std::thread::Builder::new()
            .name("local-supervisor-lifeline".into())
            .spawn(move || {
                use std::io::Read;
                // A managed service receives only EOF on this pipe when its
                // supervisor exits. Standalone services use signal handlers.
                let _ = std::io::stdin().lock().read_exact(&mut [0_u8; 1]);
                let _ = closed.send(());
            });
        if watcher.is_ok() {
            let _ = wait.await;
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
        _ = lifeline => {}
    }
}

async fn operator(connection: Connection) -> Result<(OperatorClient<Channel>, String)> {
    let (channel, token) = connect_operator(connection).await?;
    Ok((
        OperatorClient::new(channel)
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
        token,
    ))
}

async fn connect_operator(connection: Connection) -> Result<(Channel, String)> {
    let (uri, token) = operator_target(connection)?;
    let channel = network::endpoint(uri, false).await?.connect().await?;
    Ok((channel, token))
}

fn operator_target(connection: Connection) -> Result<(String, String)> {
    if let Some(directory) = connection.state_directory {
        local::connection(&directory)
    } else {
        Ok((
            connection.gateway.context("Gateway address required")?,
            required_env("SUPERTAG_OPERATOR_TOKEN")?,
        ))
    }
}

fn required_env(name: &str) -> Result<String> {
    let value = std::env::var(name).with_context(|| format!("set {name}"))?;
    ensure!(!value.trim().is_empty(), "{name} must be nonempty");
    Ok(value)
}

fn request<T>(message: T, token: &str) -> Result<Request<T>> {
    let mut request = authenticated_request(message, token, None)?;
    request.set_timeout(Duration::from_secs(10));
    Ok(request)
}

fn tag_json(tag: &Tag) -> serde_json::Value {
    json!({
        "tag_id": tag.tag_id,
        "name": tag.name,
        "revision": tag.revision,
        "instructions": tag.instructions,
        "allowed_actions": tag.allowed_actions,
        "harness": tag.harness_kind().as_str_name(),
        "retired_at_ms": tag.retired_at_ms,
    })
}

fn print_task(task: &Task) {
    println!(
        "{}",
        json!({
            "task_id": task.task_id, "tag_id": task.tag_id, "session_id": task.session_id,
            "state": task.state().as_str_name(), "result": task.result, "attempt_id": task.attempt_id,
            "harness": task.harness_kind().as_str_name(),
            "workspace": task.workspace.as_ref().map(|spec| json!({
                "workspace_id": spec.workspace_id, "base_commit": spec.base_commit,
                "github_source": spec.github_source.as_ref().map(|value| json!({"workspace_id":value.workspace_id,"revision":value.revision,"source":value.source.as_ref().map(|source|json!({"account_id":source.account_id,"repository_id":source.repository_id,"repository":source.repository,"commit_sha":source.commit_sha}))})),
            })),
            "workspace_delivery": task.workspace_delivery.as_ref().map(artifacts::describe),
            "execution_limits": task.execution_limits.as_ref().map(|limits| json!({
                "max_reported_tokens": limits.max_reported_tokens,
                "max_reported_cost": limits.max_reported_cost.as_ref().map(|limit| json!({
                    "amount_minor": limit.amount_minor, "currency": limit.currency,
                })),
                "max_native_agents": limits.max_native_agents,
            })),
        })
    );
}
