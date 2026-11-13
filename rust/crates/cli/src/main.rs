mod artifact_publications;
mod artifacts;
mod delivery_branches;
mod gateway_credentials;
mod github_publications;
mod github_workspaces;
mod harness;
mod health;
mod host_status;
mod inbox;
mod init;
mod inputs;
mod lifecycle;
mod local;
mod local_config;
mod mailbox_grants;
mod manifests;
mod mcp;
mod network;
mod node_bridges;
mod objectives;
mod observe;
mod operator_access;
mod output_policy;
mod placement;
mod policy;
mod profiles;
mod replies;
mod service_manager;
mod status;
mod surface_policy;
mod task_artifact_inputs;
mod teams;
mod tui;
mod volumes;
mod work_sessions;
mod workspace_mounts;

use std::{ffi::OsString, net::SocketAddr, path::PathBuf, time::Duration};

use anyhow::{Context, Result, ensure};
use clap::{Args, Parser, Subcommand, ValueEnum};
use harness::{AdapterOptions, CodexAdapterArgs, Harness};
use serde_json::json;
use sha2::{Digest, Sha256};
use supertag_control_plane::{ControlPlane, OperatorWatch};
use supertag_gateway::{
    Gateway, GatewayWatch,
    credential_vault::CredentialVault,
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
    negotiation::{Negotiator, ProtocolChannel, connect, fence},
    v2::{
        ApprovalRule, AttemptDecision, CancelTaskRequest, CreateAuthKeyRequest, ExecutionLimits,
        GetTagRequest, GetTaskRequest, HarnessKind, LarkDomain, ListEventsRequest,
        ListNativeUsageRequest, ListTagsRequest, PolicyExecutionSettings, PutTagRequest,
        ReportedCostLimit, ResolveAttemptRequest, RetireTagRequest, RevokeHostRequest, ServiceRole,
        SubmitTaskRequest, Tag, Task, WorkspaceSpec,
        artifact_directory_server::ArtifactDirectoryServer,
        artifact_publications_server::ArtifactPublicationsServer,
        artifact_volume_directory_server::ArtifactVolumeDirectoryServer,
        attempt_inputs_server::AttemptInputsServer, attempt_mailbox_server::AttemptMailboxServer,
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
use tonic::Request;
use uuid::Uuid;

#[derive(Parser)]
#[command(name = "supertag", version)]
struct Cli {
    /// Gateway URL or the name of a Gateway saved in the terminal UI or desktop app,
    /// for the operator command that follows.
    #[arg(long, value_name = "URL|NAME")]
    gateway: Option<String>,
    #[command(subcommand)]
    command: Option<Command>,
}

/// The Gateway selected before the command name, if any.
static ROOT_GATEWAY: std::sync::OnceLock<String> = std::sync::OnceLock::new();

#[derive(Args)]
struct Connection {
    /// Gateway URL or the name of a Gateway saved in the terminal UI or desktop app.
    /// A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN.
    #[arg(long, value_name = "URL|NAME", conflicts_with = "state_directory")]
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
    /// Check a public or private gRPC service using the configured TLS trust.
    Health(health::HealthArgs),
    /// Preview an organization manifest through the Gateway.
    Diff(manifests::ManifestArgs),
    /// Apply an organization manifest through the Gateway.
    Apply(manifests::ManifestArgs),
    /// Manage GitHub Workspace sources pinned to one repository and commit.
    GithubPublication {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: github_publications::PublicationCommand,
    },
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
    /// Store or delete Gateway collaboration credentials in the configured credential vault.
    GatewayCredential {
        #[command(subcommand)]
        command: gateway_credentials::GatewayCredentialCommand,
    },
    /// Read Worker Host readiness and manage draining.
    Host {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: host_status::HostCommand,
    },
    /// Choose which labelled Worker Hosts run a Tag, and explain waiting Tasks.
    Placement {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: placement::PlacementCommand,
    },
    /// Read and answer work waiting on an operator.
    Inbox {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: inbox::InboxCommand,
    },
    /// List this host's catalog MCP servers and log in to OAuth servers.
    Mcp {
        #[command(subcommand)]
        command: mcp::McpCommand,
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
    /// Issue, list, rotate, and revoke named Operator Tokens. Admin operator token only.
    OperatorToken {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: operator_access::OperatorTokenCommand,
    },
    /// List recorded operator changes, newest first, with actor, action, target, and outcome.
    Audit(operator_access::AuditArgs),
    /// Manage Teams and read their Workstream posts.
    Team {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: teams::TeamCommand,
    },
    /// Set up SuperTag on this machine for the git repository in the current directory.
    Init(init::InitArgs),
    /// Start local services or configured Worker Hosts in the background and return when ready.
    ///
    /// With --foreground, supervise them in this terminal until interrupted. A service with
    /// restart: unless-stopped makes up install a per-user service unit (launchd on macOS,
    /// systemd on Linux) that runs the supervisor and starts it again after a failure or login.
    Up {
        /// Service configuration, otherwise STATE_DIRECTORY/supertag.yaml when present.
        #[arg(short = 'f', long = "file")]
        file: Option<PathBuf>,
        #[arg(long)]
        state_directory: Option<PathBuf>,
        /// Run in this terminal with each service's logs here until interrupted.
        #[arg(long)]
        foreground: bool,
        /// When restarting changed services, do not wait for running Task Attempts.
        #[arg(long, conflicts_with = "foreground")]
        force: bool,
        #[command(flatten)]
        adapter: AdapterOptions,
        /// Private host allowlist of Skill packages.
        #[arg(long)]
        skill_catalog: Option<PathBuf>,
        #[arg(long, default_value = "127.0.0.1:0")]
        gateway_listen: SocketAddr,
    },
    /// Stop this machine's SuperTag services, draining local Worker Hosts first.
    Down(lifecycle::DownArgs),
    /// Print this machine's service logs.
    Logs(lifecycle::LogsArgs),
    /// List this machine's SuperTag services.
    Ps(lifecycle::PsArgs),
    /// Show Worker Hosts, Tags, unfinished Objectives, and the operator inbox.
    Status(status::StatusArgs),
    /// Print this CLI's version and the version of the running local services.
    Version(status::VersionArgs),
    /// Print the resolved supertag.yaml that supertag up runs.
    Config {
        #[arg(short = 'f', long = "file")]
        file: Option<PathBuf>,
        #[arg(long)]
        state_directory: Option<PathBuf>,
        /// List the service names only.
        #[arg(long)]
        services: bool,
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
        /// Explicit storage-host consent: VOLUME_ID=/absolute/private/directory.
        #[arg(long = "artifact-volume")]
        artifact_volumes: Vec<String>,
        /// JSON file with explicit S3-compatible Volume mappings and credential environment names.
        #[arg(
            long,
            long_help = "Path to a JSON array of mappings with volumeId, source (s3://bucket/prefix), endpoint (HTTPS origin), region, and credentialEnvPrefix. The Gateway reads <prefix>_ACCESS_KEY_ID, <prefix>_SECRET_ACCESS_KEY, and optionally <prefix>_SESSION_TOKEN. For Cloudflare R2, use region auto."
        )]
        artifact_s3_volumes: Option<PathBuf>,
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
    /// Open the terminal UI for a saved or explicitly configured Gateway.
    Tui {
        #[arg(long, conflicts_with = "state_directory")]
        gateway: Option<String>,
        #[arg(long)]
        state_directory: Option<PathBuf>,
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
        /// Placement label for this host, such as gpu. Repeat for more labels.
        #[arg(long = "label")]
        labels: Vec<String>,
        /// Run as one execution lane of a supervised Host, replaying the Host's incarnation.
        /// The lane reports its state on stdout; its supervisor reports the Host's presence.
        #[arg(long, hide = true, value_name = "INCARNATION_ID")]
        supervised_lane: Option<String>,
        #[command(flatten)]
        adapter: Box<AdapterOptions>,
        /// Owner-controlled JSON mappings for read-only Workspace Volume copies.
        #[arg(long)]
        workspace_mount_mappings: Option<PathBuf>,
        /// Listen for authorized artifact reads from other Worker Hosts.
        #[arg(long, requires = "artifact_source_directory")]
        artifact_transfer_listen: Option<SocketAddr>,
        /// Dedicated owner-only absolute directory for immutable artifact copies.
        #[arg(long, requires = "artifact_transfer_listen")]
        artifact_source_directory: Option<PathBuf>,
        #[arg(long, requires_all = ["artifact_transfer_listen", "artifact_transfer_tls_key"])]
        artifact_transfer_tls_cert: Option<PathBuf>,
        #[arg(long, requires_all = ["artifact_transfer_listen", "artifact_transfer_tls_cert"])]
        artifact_transfer_tls_key: Option<PathBuf>,
        /// Pin a producing Worker Host to an HTTPS origin or literal loopback HTTP.
        #[arg(long = "artifact-peer", value_name = "HOST_ID=ORIGIN")]
        artifact_peers: Vec<String>,
        /// CA certificate for the configured artifact peer endpoints.
        #[arg(long, requires = "artifact_peers")]
        artifact_peer_ca_file: Option<PathBuf>,
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
        /// Owner-only JSON catalog of HTTP and stdio MCP tools for Claude Code Tasks.
        #[arg(
            long,
            conflicts_with_all = ["e2b_workspace_provider", "modal_workspace_provider"],
            long_help = r#"Owner-only JSON catalog of HTTP and stdio MCP tools for Claude Code Tasks.

Use {"version":1,"servers":[{"name":"catalog","url":"https://example.com/mcp","headerEnv":{"Authorization":"CATALOG_AUTH"}}]}. Set CATALOG_AUTH to the full header value in the Worker Host environment. An HTTP server with "oauth":true instead uses the login `supertag mcp login NAME --mcp-catalog PATH` stores on this host.

A stdio server has a command instead of a url, such as {"name":"db","command":["npx","-y","@acme/db-mcp"],"env":{"DB_TOKEN":"ACME_DB_TOKEN"}}. The Worker Host launches it for each Task Attempt with only its env, each value read from the named Worker Host variable, plus HOME, PATH, and a few locale variables, and stops its process group when the Attempt ends.

The optional resources.tools object maps each tool name to a list of rules, for example [{"prefix":"repository:","separator":"/","components":[{"arguments":["owner"]},{"arguments":["repo"]}]}].

Catalog entries expose tools only when the Task's accepted Permission Sets grant them. Calls requiring approval appear in the operator Inbox. Endpoints must use HTTPS or literal loopback HTTP."#
        )]
        mcp_catalog: Option<PathBuf>,
        /// gRPC origin of a standalone shared execution provider for Cursor.
        #[arg(long, requires = "shared_execution_environment", conflicts_with_all = ["e2b_workspace_provider", "modal_workspace_provider", "mcp_catalog", "workspace_id", "allow_unsandboxed_commands"])]
        shared_execution_endpoint: Option<String>,
        /// Environment ID expected from the provider. Set SUPERTAG_EXECUTION_ADMIN_TOKEN separately.
        #[arg(long, requires = "shared_execution_endpoint")]
        shared_execution_environment: Option<String>,
        #[arg(long, requires = "shared_execution_endpoint")]
        shared_execution_ca_file: Option<PathBuf>,
        /// Enable lease-bound commands on an operator-trusted Linux shared execution provider.
        #[arg(
            long,
            requires = "shared_execution_endpoint",
            long_help = "Enable lease-bound commands on an operator-trusted Linux shared execution provider. Commands start in the fixed root with an empty credential environment and run with the provider's configured workload UID and GID. That identity's OS filesystem and network permissions also apply."
        )]
        shared_execution_commands: bool,
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
    /// Create a named, scoped Auth Key: one-time for a named Worker Host, or reusable.
    CreateAuthKey {
        #[command(flatten)]
        connection: Connection,
        /// The key's name: 1-63 lowercase letters, digits, hyphens or underscores. Never reused.
        name: String,
        /// Worker Host ID a one-time key enrolls. Omit with --reusable.
        #[arg(
            long = "host",
            required_unless_present = "reusable",
            conflicts_with = "reusable"
        )]
        host_id: Option<String>,
        /// Enroll any number of Worker Hosts, each choosing its own ID.
        #[arg(long)]
        reusable: bool,
        /// Remove hosts that join with this key once they go offline.
        #[arg(long)]
        ephemeral: bool,
        /// Label granted to every host that joins. Repeat for more labels.
        #[arg(long = "label")]
        labels: Vec<String>,
        /// Shorter lifetime. Defaults to the maximum: one hour, or 90 days with --reusable.
        #[arg(long)]
        expires_in_seconds: Option<u64>,
        #[arg(
            long,
            conflicts_with = "all_tags",
            required_unless_present = "all_tags"
        )]
        tag: Vec<String>,
        #[arg(long)]
        all_tags: bool,
    },
    /// Check an operator token against a Gateway, then save the Gateway under a name for
    /// `--gateway NAME` and the terminal UI. The token is read from SUPERTAG_OPERATOR_TOKEN, or
    /// from standard input when that is not set.
    ConnectGateway {
        /// The Gateway origin, such as https://supertag.example.com.
        url: String,
        /// The name to save it under.
        #[arg(long)]
        name: String,
        /// Replace a Gateway already saved under this name for the same origin.
        #[arg(long)]
        replace: bool,
        #[arg(long)]
        server_ca_file: Option<PathBuf>,
        #[arg(long, requires = "client_key_file")]
        client_cert_file: Option<PathBuf>,
        #[arg(long, requires = "client_cert_file")]
        client_key_file: Option<PathBuf>,
    },
    /// List Auth Keys, revoked, expired and used ones included, without their secrets.
    ListAuthKeys {
        #[command(flatten)]
        connection: Connection,
        #[arg(long, default_value_t = 100)]
        limit: u32,
        /// The next_cursor of the previous page.
        #[arg(long, default_value = "")]
        cursor: String,
    },
    /// Show one Auth Key without its secret.
    GetAuthKey {
        #[command(flatten)]
        connection: Connection,
        name: String,
    },
    /// Stop an Auth Key from enrolling more Worker Hosts. Hosts that joined stay enrolled.
    RevokeAuthKey {
        #[command(flatten)]
        connection: Connection,
        name: String,
    },
    /// Replace an enrolled Worker Host's credential. The previous one stops working at once.
    RotateHostCredential {
        #[command(flatten)]
        connection: Connection,
        host_id: String,
        /// Write the new credential to this new owner-only file, for a host that reads
        /// SUPERTAG_HOST_TOKEN from its own secret manager.
        #[arg(
            long,
            required_unless_present = "host_state_directory",
            conflicts_with = "host_state_directory"
        )]
        out: Option<PathBuf>,
        /// Install the new credential in the state directory of this machine's stopped,
        /// enrolled Worker Host. It uses the credential when it next starts.
        #[arg(long)]
        host_state_directory: Option<PathBuf>,
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
        /// Logical local or configured GitHub repository binding.
        #[arg(long)]
        workspace_id: Option<String>,
        /// Full local Git base commit. Omit for a configured GitHub source.
        #[arg(long, requires = "workspace_id")]
        workspace_base: Option<String>,
        /// JSON array of {volumeId,destination,maxBytes} for local read-only copy mounts.
        #[arg(long, requires = "workspace_base")]
        workspace_mounts: Option<PathBuf>,
        /// A server the Workspace's `.mcp.json` declares that this Tag's Tasks may use, read
        /// from the Task's base commit. May be repeated.
        #[arg(long = "workspace-mcp", requires = "workspace_id")]
        workspace_mcp: Vec<String>,
        /// Required harness for Tasks accepted from this Tag.
        #[arg(long)]
        harness: Option<Harness>,
        /// Allowed model IDs, with the default first. May be repeated.
        #[arg(long = "model", value_delimiter = ',')]
        models: Vec<String>,
        /// Allowed reasoning efforts, with the default first. May be repeated.
        #[arg(long = "effort", value_delimiter = ',')]
        efforts: Vec<String>,
        /// Require this fixed execution environment for new Cursor Sessions.
        #[arg(long, conflicts_with = "workspace_id")]
        shared_execution_environment: Option<String>,
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
        /// Read declared output requirements from a JSON file.
        #[arg(long)]
        outputs: Option<PathBuf>,
        /// Include one submitted artifact file from the same Objective. Repeat for more files.
        #[arg(long = "artifact-input", value_name = "ARTIFACT_ID:PATH")]
        artifact_inputs: Vec<String>,
        /// Bind selected artifact inputs to this explicit publication approval.
        #[arg(long, requires = "artifact_inputs")]
        artifact_publication: Option<String>,
        prompt: String,
    },
    /// Read a Task.
    GetTask {
        #[command(flatten)]
        connection: Connection,
        task_id: String,
    },
    /// Approve and withdraw explicit cross-Objective artifact reuse.
    ArtifactPublication {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: artifact_publications::PublicationCommand,
    },
    /// Register Volumes and copy immutable artifact files into explicitly mapped storage.
    Volume {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: volumes::VolumeCommand,
    },
    /// Register or inspect a file Volume for read-only Workspace data.
    WorkspaceVolume {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: workspace_mounts::VolumeCommand,
    },
    /// Inspect or download files captured by a Task.
    Artifact {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: artifacts::CaptureCommand,
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
    /// Import a Task's or Session's delivered commits as its Session branch in a repository.
    Fetch {
        #[command(flatten)]
        connection: Connection,
        #[command(flatten)]
        args: delivery_branches::FetchArgs,
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
    /// Report recorded spend by Objective, Tag, or day.
    Spend {
        #[command(flatten)]
        connection: Connection,
        #[command(flatten)]
        args: observe::SpendArgs,
    },
    /// Read an operational snapshot: resource and Task counts, usage, Worker Host capacity, and
    /// Mailbox and reply backlogs.
    Metrics {
        #[command(flatten)]
        connection: Connection,
        #[command(flatten)]
        args: observe::MetricsArgs,
    },
    /// Describe one resource in readable text.
    Describe {
        #[command(flatten)]
        connection: Connection,
        #[command(flatten)]
        args: observe::DescribeArgs,
    },
    /// Stream change notices, reconnecting from the last resume token.
    Watch {
        #[command(flatten)]
        connection: Connection,
        #[command(flatten)]
        args: observe::WatchArgs,
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
    let cli = Cli::parse();
    let command = match cli.command {
        Some(command) => command,
        None => Command::Tui {
            gateway: None,
            state_directory: None,
            binary: None,
            workspace: None,
        },
    };
    if let Some(gateway) = cli.gateway {
        ensure!(
            !matches!(
                command,
                Command::Health(_)
                    | Command::Up { .. }
                    | Command::ControlPlane { .. }
                    | Command::Gateway { .. }
                    | Command::WorkerHost { .. }
                    | Command::EnrollHost { .. }
                    | Command::CodexAdapter(_)
                    | Command::AdapterGuardian { .. }
            ),
            "--gateway before the command applies only to operator commands"
        );
        let _ = ROOT_GATEWAY.set(gateway);
    }
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
        Command::Health(args) => health::run(args).await?,
        Command::Spend { connection, args } => observe::spend(connection, args).await?,
        Command::Metrics { connection, args } => observe::metrics(connection, args).await?,
        Command::Describe { connection, args } => observe::describe(connection, args).await?,
        Command::Watch { connection, args } => observe::watch(connection, args).await?,
        Command::Diff(args) => manifests::run(args, false).await?,
        Command::Apply(args) => manifests::run(args, true).await?,
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
        Command::GatewayCredential { command } => gateway_credentials::run(command).await?,
        Command::Placement {
            connection,
            command,
        } => placement::run(connection, command).await?,
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
        Command::Mcp { command } => mcp::run(command).await?,
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
        Command::GithubPublication {
            connection,
            command,
        } => github_publications::run(connection, command).await?,
        Command::GithubWorkspace {
            connection,
            command,
        } => github_workspaces::run(connection, command).await?,
        Command::Team {
            connection,
            command,
        } => teams::run(connection, command).await?,
        Command::Init(args) => init::init(args).await?,
        Command::Down(args) => lifecycle::down(args).await?,
        Command::Logs(args) => lifecycle::logs(args).await?,
        Command::Ps(args) => lifecycle::ps(args).await?,
        Command::Status(args) => status::status(args).await?,
        Command::Version(args) => status::version(args)?,
        Command::Config {
            file,
            state_directory,
            services,
        } => {
            let state_directory = local_config::state_directory(state_directory)?;
            print!(
                "{}",
                local_config::render(file, &state_directory, services)?
            );
        }
        Command::OperatorToken {
            connection,
            command,
        } => operator_access::run_tokens(connection, command).await?,
        Command::Audit(args) => operator_access::run_audit(args).await?,
        Command::Up {
            file,
            state_directory,
            foreground,
            force,
            adapter,
            skill_catalog,
            gateway_listen,
        } => {
            let state_directory = local_config::state_directory(state_directory)?;
            let config = local_config::load(file, &state_directory)?;
            let args: Vec<OsString> = std::env::args_os().skip(1).collect();
            if config.is_none() {
                ensure!(
                    adapter.is_selected(),
                    "select a harness, an adapter, or a local services file; supertag init writes one"
                );
            }
            if !foreground {
                lifecycle::up(lifecycle::Background {
                    state: state_directory,
                    config,
                    args,
                    force,
                })
                .await?;
            } else if let Some(config) = config {
                ensure!(
                    !adapter.has_options()
                        && skill_catalog.is_none()
                        && gateway_listen == "127.0.0.1:0".parse::<SocketAddr>()?,
                    "configure adapters and listeners in the services file when using local configuration"
                );
                local::configured(config, state_directory, termination_signal()).await?;
            } else {
                local::up(
                    local::LocalOptions {
                        state_directory,
                        adapter,
                        skill_catalog,
                        gateway_listen,
                        fingerprint: lifecycle::flags_fingerprint(&args),
                    },
                    termination_signal(),
                )
                .await?;
            }
        }
        Command::ControlPlane { listen } => control_plane(listen).await?,
        Command::Gateway {
            listen,
            control_plane,
            checkpoint_directory,
            artifact_volumes,
            artifact_s3_volumes,
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
                    artifact_volumes,
                    artifact_s3_volumes,
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
            gateway,
            state_directory,
            binary,
            workspace,
        } => {
            tui::launch(
                Connection {
                    gateway,
                    state_directory,
                },
                binary,
                workspace,
            )
            .await?;
        }
        Command::WorkerHost {
            gateway,
            state_directory,
            labels,
            supervised_lane,
            adapter,
            e2b_workspace_provider,
            e2b_workspace_provider_arg,
            modal_workspace_provider,
            modal_workspace_provider_arg,
            mcp_catalog,
            shared_execution_endpoint,
            shared_execution_environment,
            shared_execution_ca_file,
            shared_execution_commands,
            skill_catalog,
            attempt_timeout_seconds,
            once,
            wait_for_recovery,
            workspace_mount_mappings,
            artifact_transfer_listen,
            artifact_source_directory,
            artifact_transfer_tls_cert,
            artifact_transfer_tls_key,
            artifact_peers,
            artifact_peer_ca_file,
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
            let workspaces = adapter.workspace_mappings()?;
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
                        && !workspaces.is_empty()
                        && !execution_profile.allow_unsandboxed_commands,
                    "remote Workspace placement requires Cursor and a named Workspace without unsandboxed commands"
                );
                execution_profile.remote_file_workspace = true;
                execution_profile.declared_task_outputs = true;
            }
            let (adapter, adapter_args) = adapter.launch(attempt_timeout_seconds)?;
            let mcp_catalog = supertag_worker_host::McpCatalog::load(
                mcp_catalog.as_deref(),
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
            let artifact_source = match artifact_transfer_listen.zip(artifact_source_directory) {
                Some((listen, directory)) => {
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
                    Some(supertag_worker_host::ArtifactSourceConfig {
                        listen,
                        directory,
                        tls,
                    })
                }
                None => None,
            };
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
            let disk_space = supertag_worker_host::environment::DiskSpaceSource::Directory(
                state_directory.clone(),
            );
            // Test builds never hold a real sleep assertion unless a test supplies a fake one.
            #[cfg(not(feature = "test-fixtures"))]
            let keep_awake = supertag_worker_host::environment::KeepAwakeCommand::for_platform(
                std::env::consts::OS,
                std::process::id(),
            );
            #[cfg(feature = "test-fixtures")]
            let (keep_awake, disk_space) = test_host_environment(disk_space)?;
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
                workspaces,
                remote_provider,
                shared_execution,
                context_catalog: supertag_worker_host::context::ContextCatalog::load(
                    skill_catalog.as_deref(),
                )?,
                mcp_catalog,
                artifact_source,
                artifact_peers,
                workspace_mounts,
                disk_space,
                keep_awake,
                labels,
                lane: supervised_lane.map(|incarnation_id| supertag_worker_host::Lane {
                    incarnation_id,
                    observer: std::sync::Arc::new(|state: supertag_worker_host::LaneState| {
                        println!("state {}", state.as_str());
                    }),
                }),
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
            name,
            host_id,
            reusable,
            ephemeral,
            labels,
            expires_in_seconds,
            tag,
            all_tags,
        } => {
            let (mut operator, token) = operator(connection).await?;
            let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
            let key = operator
                .create_auth_key(request(
                    CreateAuthKeyRequest {
                        name,
                        host_id: host_id.unwrap_or_default(),
                        reusable,
                        ephemeral,
                        labels,
                        operation_id: Uuid::new_v4().to_string(),
                        key_digest: Sha256::digest(secret.as_bytes()).to_vec(),
                        expires_in_ms: expires_in_seconds
                            .map_or(Some(0), |seconds| {
                                seconds.checked_mul(1000).filter(|ms| *ms > 0)
                            })
                            .context("invalid Auth Key lifetime")?,
                        allowed_tag_ids: tag,
                        all_tags,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            let mut view = placement::auth_key_view(&key);
            view["auth_key"] = secret.into();
            println!("{view}");
        }
        Command::ConnectGateway {
            url,
            name,
            replace,
            server_ca_file,
            client_cert_file,
            client_key_file,
        } => {
            connect_gateway(
                profiles::NewGateway {
                    name,
                    url,
                    token: String::new(),
                    server_ca_file,
                    client_cert_file,
                    client_key_file,
                },
                replace,
            )
            .await?;
        }
        Command::ListAuthKeys {
            connection,
            limit,
            cursor,
        } => placement::list_auth_keys(connection, limit, cursor).await?,
        Command::GetAuthKey { connection, name } => {
            placement::get_auth_key(connection, name).await?;
        }
        Command::RevokeAuthKey { connection, name } => {
            placement::revoke_auth_key(connection, name).await?;
        }
        Command::RotateHostCredential {
            connection,
            host_id,
            out,
            host_state_directory,
        } => {
            placement::rotate_host_credential(connection, host_id, out, host_state_directory)
                .await?;
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
            workspace_mounts,
            workspace_mcp,
            harness,
            models,
            efforts,
            shared_execution_environment,
        } => {
            let mounts = workspace_mounts
                .as_deref()
                .map(workspace_mounts::read_declarations)
                .transpose()?
                .unwrap_or_default();
            let workspace = workspace_id.map(|workspace_id| WorkspaceSpec {
                mcp_servers: workspace_mcp,
                workspace_id,
                base_commit: workspace_base.unwrap_or_default(),
                github_source: None,
                mounts,
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
                        expected_revision: None,
                        execution: (!models.is_empty()
                            || !efforts.is_empty()
                            || shared_execution_environment.is_some())
                        .then_some(PolicyExecutionSettings {
                            models,
                            efforts,
                            harness: None,
                            shared_execution_environment_id: shared_execution_environment,
                        }),
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
            outputs,
            artifact_inputs,
            artifact_publication,
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
            let output_policy = outputs.as_deref().map(output_policy::read).transpose()?;
            let input_artifacts =
                task_artifact_inputs::parse(artifact_inputs, artifact_publication)?;
            let task = operator
                .submit_task(request(
                    SubmitTaskRequest {
                        tag_id: tag,
                        session_id: session,
                        prompt,
                        operation_id: operation_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
                        execution_limits,
                        output_policy,
                        input_artifacts,
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
        Command::Fetch { connection, args } => delivery_branches::fetch(connection, args).await?,
        Command::ArtifactPublication {
            connection,
            command,
        } => artifact_publications::run(connection, command).await?,
        Command::Volume {
            connection,
            command,
        } => volumes::run(connection, command).await?,
        Command::WorkspaceVolume {
            connection,
            command,
        } => workspace_mounts::run(connection, command).await?,
        Command::Artifact {
            connection,
            command,
        } => {
            artifacts::run_capture(connection, command).await?;
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
    let builder = network::server(listen, true).await?;
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
        .set_serving::<supertag_protocol::v2::operator_access_server::OperatorAccessServer<ControlPlane>>()
        .await;
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
    health
        .set_serving::<ArtifactPublicationsServer<ControlPlane>>()
        .await;
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
    health
        .set_serving::<supertag_protocol::v2::spend_server::SpendServer<ControlPlane>>()
        .await;
    health
        .set_serving::<supertag_protocol::v2::metrics_server::MetricsServer<ControlPlane>>()
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
    // Refuse every call from a peer that skipped protocol negotiation.
    let mut builder = builder
        .layer(fence(ServiceRole::ControlPlane))
        .layer(plane.audit_layer());
    let served = builder
        .add_service(health_service)
        .add_service(plane.operator_access_service())
        .add_service(plane.operator_directory_service())
        .add_service(
            Negotiator::new(ServiceRole::ControlPlane, &[ServiceRole::Gateway]).service(),
        )
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
            ArtifactVolumeDirectoryServer::new(plane.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
        )
        .add_service(supertag_protocol::v2::workspace_volumes_server::WorkspaceVolumesServer::new(plane.clone()))
        .add_service(supertag_protocol::v2::placement_server::PlacementServer::new(plane.clone()))
        .add_service(supertag_protocol::v2::auth_keys_server::AuthKeysServer::new(plane.clone()))
        .add_service(supertag_protocol::v2::host_credentials_server::HostCredentialsServer::new(plane.clone()))
        .add_service(supertag_protocol::v2::attempt_workspace_mounts_server::AttemptWorkspaceMountsServer::new(plane.clone()))
        .add_service(
            ArtifactDirectoryServer::new(plane.clone())
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
        .add_service(plane.github_source_resolver_service())
        .add_service(plane.github_publications_service())
        .add_service(plane.github_publisher_service())
        .add_service(plane.reply_progress_service())
        .add_service(
            ArtifactPublicationsServer::new(plane.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
        )
        .add_service(plane.policy_service())
        .add_service(plane.manifest_relationships_service())
        .add_service(plane.surface_policy_service())
        .add_service(plane.work_sessions_service())
        .add_service(plane.attempt_work_sessions_service())
        .add_service(plane.attempt_mailbox_service())
        .add_service(plane.attempt_mcp_effects_service())
        .add_service(plane.spend_service())
        .add_service(plane.metrics_service())
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
    artifact_volumes: Vec<String>,
    artifact_s3_volumes: Option<PathBuf>,
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
    // Refuse every call from a peer that skipped protocol negotiation.
    let mut builder = network::server(listen, false)
        .await?
        .layer(fence(ServiceRole::Gateway));
    let channel = network::endpoint(control_plane, true)
        .await?
        .connect()
        .await?;
    // Refuse an incompatible Control Plane before accepting any public traffic,
    // and name the selected version on every call to it.
    let channel = connect(channel, ServiceRole::Gateway, ServiceRole::ControlPlane).await?;
    let gateway_token = required_env("SUPERTAG_GATEWAY_TOKEN")?;
    let slack = match connectors.slack {
        Some((address, state_directory)) => {
            ensure!(
                address.ip().is_loopback(),
                "Slack webhook listener must use loopback"
            );
            let connector =
                slack_connector(channel.clone(), gateway_token.clone(), state_directory).await?;
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
    let publication_channel = channel.clone();
    let publication_token = gateway_token.clone();
    let gateway = Gateway::new(
        channel,
        gateway_token,
        required_env("SUPERTAG_OPERATOR_TOKEN")?,
        std::env::var("SUPERTAG_OPERATOR_PRINCIPAL").unwrap_or_else(|_| "operator:local".into()),
    )?;
    let (health, health_service) = tonic_health::server::health_reporter();
    health.set_serving::<OperatorServer<Gateway>>().await;
    health
        .set_serving::<supertag_protocol::v2::operator_access_server::OperatorAccessServer<Gateway>>()
        .await;
    health.set_serving::<ConversationsServer<Gateway>>().await;
    health.set_serving::<WorkerHostServer<Gateway>>().await;
    health.set_serving::<HostEnrollmentServer<Gateway>>().await;
    health
        .set_serving::<TransfersServer<GatewayTransfers>>()
        .await;
    let mut transfers = GatewayTransfers::new(gateway.clone(), checkpoint_directory.clone())?
        .with_artifact_volumes(volumes::mappings(
            connectors.artifact_volumes,
            connectors.artifact_s3_volumes,
        )?)?;
    let mut source_reader = None;
    let publication = if let Some(directory) = connectors.github_workspace {
        let sources = github_workspace_sources(directory.clone())?;
        transfers = transfers.with_github_sources(sources.clone());
        source_reader = Some((
            sources,
            publication_channel.clone(),
            publication_token.clone(),
        ));
        let blobs = checkpoint_directory
            .as_ref()
            .context("GitHub Workspace publication requires Gateway artifact storage")?;
        Some(github_workspace_publisher(
            directory,
            blobs,
            publication_channel,
            publication_token,
        )?)
    } else {
        None
    };
    health.set_serving::<ObjectivesServer<Gateway>>().await;
    health.set_serving::<LiveInputsServer<Gateway>>().await;
    health.set_serving::<AttemptInputsServer<Gateway>>().await;
    health.set_serving::<TeamsServer<Gateway>>().await;
    health
        .set_serving::<AttemptWorkstreamsServer<Gateway>>()
        .await;
    health.set_serving::<MailboxServer<Gateway>>().await;
    health.set_serving::<InboxServer<Gateway>>().await;
    health
        .set_serving::<ArtifactPublicationsServer<Gateway>>()
        .await;
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
    health
        .set_serving::<supertag_protocol::v2::spend_server::SpendServer<Gateway>>()
        .await;
    health
        .set_serving::<supertag_protocol::v2::metrics_server::MetricsServer<Gateway>>()
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
        .add_service(gateway.negotiation_service())
        .add_service(gateway.operator_service())
        .add_service(gateway.operator_access_service())
        .add_service(gateway.conversations_service())
        .add_service(gateway.worker_host_service())
        .add_service(gateway.host_enrollment_service())
        .add_service(transfers.artifact_catalog_service())
        .add_service(transfers.artifact_volumes_service())
        .add_service(gateway.workspace_volumes_service())
        .add_service(gateway.placement_service())
        .add_service(gateway.auth_keys_service())
        .add_service(gateway.host_credentials_service())
        .add_service(gateway.attempt_workspace_mounts_service())
        .add_service(transfers.attempt_artifacts_service())
        .add_service(transfers.artifact_transfer_service())
        .add_service(transfers.service())
        .add_service(gateway.objectives_service())
        .add_service(gateway.live_inputs_service())
        .add_service(gateway.attempt_inputs_service())
        .add_service(gateway.teams_service())
        .add_service(gateway.attempt_workstreams_service())
        .add_service(gateway.mailbox_service())
        .add_service(gateway.inbox_service())
        .add_service(gateway.github_workspaces_service())
        .add_service(gateway.github_publications_service())
        .add_service(gateway.artifact_publications_service())
        .add_service(gateway.policy_service())
        .add_service(gateway.manifest_relationships_service())
        .add_service(gateway.surface_policy_service())
        .add_service(gateway.work_sessions_service())
        .add_service(gateway.attempt_work_sessions_service())
        .add_service(gateway.attempt_mailbox_service())
        .add_service(gateway.attempt_mcp_effects_service())
        .add_service(gateway.spend_service())
        .add_service(gateway.metrics_service())
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
    let publication_loop = async {
        if let Some(publication) = publication {
            let result = publication.run(shutdown.clone()).await;
            shutdown.cancel();
            result
        } else {
            shutdown.cancelled().await;
            Ok(())
        }
    };
    let source_loop = async {
        if let Some((sources, channel, token)) = source_reader {
            let result = sources.run_resolver(channel, token, shutdown.clone()).await;
            shutdown.cancel();
            result
        } else {
            shutdown.cancelled().await;
            Ok(())
        }
    };
    let services = async {
        let (grpc, slack, github, linear, lark, teams, publication, source) = tokio::join!(
            grpc,
            webhook,
            github_webhook,
            linear_webhook,
            lark_connection,
            microsoft_teams_webhook,
            publication_loop,
            source_loop
        );
        grpc?;
        slack?;
        github?;
        linear?;
        lark?;
        teams?;
        publication?;
        source
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

/// The Slack signing secret and bot token come from the environment when both are set, and
/// otherwise from the Gateway credential vault at `surface/slack/<account>`.
async fn slack_secrets(account_id: &str) -> Result<(String, String)> {
    let nonempty = |name| {
        std::env::var(name)
            .ok()
            .filter(|value| !value.trim().is_empty())
    };
    match (
        nonempty("SUPERTAG_SLACK_SIGNING_SECRET"),
        nonempty("SUPERTAG_SLACK_BOT_TOKEN"),
    ) {
        (Some(signing), Some(bot)) => return Ok((signing, bot)),
        (None, None) => {}
        _ => anyhow::bail!(
            "set both SUPERTAG_SLACK_SIGNING_SECRET and SUPERTAG_SLACK_BOT_TOKEN, or neither to use the credential vault"
        ),
    }
    let id = format!("surface/slack/{account_id}");
    let mut credential = CredentialVault::from_process_environment()?
        .resolve(&id)
        .await?
        .with_context(|| format!("Slack credentials are missing: store {id} in the credential vault or set SUPERTAG_SLACK_SIGNING_SECRET and SUPERTAG_SLACK_BOT_TOKEN"))?;
    let mut field = |name: &str| {
        credential
            .remove(name)
            .filter(|value| !value.trim().is_empty())
            .with_context(|| format!("credential {id} has no {name}"))
    };
    Ok((field("signingSecret")?, field("botToken")?))
}

async fn slack_connector(
    channel: ProtocolChannel,
    gateway_token: String,
    state_directory: PathBuf,
) -> Result<Slack> {
    let account_id = required_env("SUPERTAG_SLACK_ACCOUNT_ID")?;
    let (signing_secret, bot_token) = slack_secrets(&account_id).await?;
    let connector = Slack::new(
        SlackConfig {
            account_id,
            team_id: required_env("SUPERTAG_SLACK_TEAM_ID")?,
            channel_id: required_env("SUPERTAG_SLACK_CHANNEL_ID")?,
            tag_id: required_env("SUPERTAG_SLACK_TAG_ID")?,
            allowed_users: required_env("SUPERTAG_SLACK_ALLOWED_USERS")?
                .split(',')
                .map(|user| user.trim().to_owned())
                .collect(),
            signing_secret,
            bot_token,
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

fn github_workspace_account() -> Result<GithubWorkspaceAccount> {
    Ok(GithubWorkspaceAccount {
        account_id: required_env("SUPERTAG_GITHUB_ACCOUNT_ID")?,
        repository_id: required_env("SUPERTAG_GITHUB_REPOSITORY_ID")?
            .parse()
            .context("invalid GitHub repository ID")?,
        repository: required_env("SUPERTAG_GITHUB_REPOSITORY")?,
        authentication: github_authentication()?,
    })
}
fn github_workspace_publisher(
    directory: PathBuf,
    blobs: &std::path::Path,
    channel: ProtocolChannel,
    token: String,
) -> Result<supertag_gateway::github::publication::GithubPublisher> {
    let publisher = supertag_gateway::github::publication::GithubPublisher::new(
        github_workspace_account()?,
        &directory,
        blobs,
        channel,
        token,
    )?;
    #[cfg(feature = "test-fixtures")]
    if let Ok(api) = std::env::var("SUPERTAG_TEST_GITHUB_API_URL") {
        return publisher.with_test_endpoints(
            api.parse()?,
            required_env("SUPERTAG_TEST_GITHUB_GIT_URL")?.parse()?,
        );
    }
    Ok(publisher)
}
fn github_workspace_sources(directory: PathBuf) -> Result<GithubWorkspaceSources> {
    use std::os::unix::fs::DirBuilderExt as _;
    if !directory.exists() {
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .context("create private GitHub Workspace directory")?;
    }
    let sources = GithubWorkspaceSources::new(github_workspace_account()?, &directory)?;
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
    channel: ProtocolChannel,
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
    channel: ProtocolChannel,
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
    channel: ProtocolChannel,
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
    channel: ProtocolChannel,
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

async fn operator(connection: Connection) -> Result<(OperatorClient<ProtocolChannel>, String)> {
    let (channel, token) = connect_operator(connection).await?;
    Ok((
        OperatorClient::new(channel)
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
        token,
    ))
}

/// Connects to the Gateway as an operator client. The Gateway refuses every
/// call from a client that did not negotiate a protocol version first.
async fn connect_operator(connection: Connection) -> Result<(ProtocolChannel, String)> {
    connect_operator_with_timeout(connection, Duration::from_secs(15)).await
}

/// [`connect_operator`] with a per-call timeout for long transfers.
async fn connect_operator_with_timeout(
    connection: Connection,
    timeout: Duration,
) -> Result<(ProtocolChannel, String)> {
    let target = resolve_target(connection)?;
    let channel = network::operator_channel(&target.endpoint(timeout).await?).await?;
    Ok((channel, target.token))
}

/// Where an operator command connects, and with which credentials.
struct OperatorTarget {
    url: String,
    token: String,
    /// Present for a saved Gateway; otherwise TLS comes from the environment.
    tls: Option<network::TlsFiles>,
}

impl OperatorTarget {
    async fn endpoint(&self, timeout: Duration) -> Result<tonic::transport::Endpoint> {
        network::operator_endpoint(self.url.clone(), timeout, self.tls.as_ref()).await
    }
}

/// `SUPERTAG_TEST_KEEP_AWAKE_COMMAND` replaces the OS keep-awake command with a fake that
/// receives the host's platform arguments; `SUPERTAG_TEST_DISK_SPACE=free,total` fixes reports.
#[cfg(feature = "test-fixtures")]
fn test_host_environment(
    disk_space: supertag_worker_host::environment::DiskSpaceSource,
) -> Result<(
    Option<supertag_worker_host::environment::KeepAwakeCommand>,
    supertag_worker_host::environment::DiskSpaceSource,
)> {
    use supertag_worker_host::environment::{DiskSpaceSource, KeepAwakeCommand};
    let keep_awake = std::env::var_os("SUPERTAG_TEST_KEEP_AWAKE_COMMAND").and_then(|program| {
        KeepAwakeCommand::for_platform(std::env::consts::OS, std::process::id()).map(|command| {
            KeepAwakeCommand {
                program: program.into(),
                ..command
            }
        })
    });
    let disk_space = match std::env::var("SUPERTAG_TEST_DISK_SPACE") {
        Ok(value) => {
            let (free, total) = value.split_once(',').context("invalid test disk space")?;
            DiskSpaceSource::Fixed(supertag_protocol::v2::HostDiskSpace {
                free_bytes: free.parse()?,
                total_bytes: total.parse()?,
            })
        }
        Err(_) => disk_space,
    };
    Ok((keep_awake, disk_space))
}

fn resolve_target(connection: Connection) -> Result<OperatorTarget> {
    let root = ROOT_GATEWAY.get().cloned();
    ensure!(
        connection.gateway.is_none() || root.is_none(),
        "pass --gateway once"
    );
    let gateway = connection.gateway.or(root);
    if let Some(directory) = connection.state_directory {
        ensure!(
            gateway.is_none(),
            "--gateway cannot be combined with --state-directory"
        );
        let (url, token) = local::connection(&directory)?;
        return Ok(OperatorTarget {
            url,
            token,
            tls: None,
        });
    }
    let gateway = gateway
        .context("pass --gateway URL, --gateway NAME of a saved Gateway, or --state-directory")?;
    if profiles::is_url(&gateway) {
        return Ok(OperatorTarget {
            url: gateway,
            token: required_env("SUPERTAG_OPERATOR_TOKEN")?,
            tls: None,
        });
    }
    let saved = profiles::resolve(&gateway)?;
    Ok(OperatorTarget {
        url: saved.url,
        token: saved.token,
        tls: Some(network::TlsFiles {
            server_ca: saved.server_ca_file,
            client_cert: saved.client_cert_file,
            client_key: saved.client_key_file,
        }),
    })
}

/// Reads the operator token, proves it against the Gateway, and saves the Gateway by name.
async fn connect_gateway(mut gateway: profiles::NewGateway, replace: bool) -> Result<()> {
    gateway.token = match std::env::var("SUPERTAG_OPERATOR_TOKEN") {
        Ok(token) => token,
        Err(_) => {
            let mut line = String::new();
            std::io::stdin()
                .read_line(&mut line)
                .context("read the operator token from standard input")?;
            line
        }
    }
    .trim()
    .to_owned();
    ensure!(
        !gateway.token.is_empty(),
        "the operator token must not be empty"
    );
    // The token goes only to the origin that would be saved.
    gateway.url = profiles::checked_origin(&gateway)?;
    let target = OperatorTarget {
        url: gateway.url.clone(),
        token: gateway.token.clone(),
        tls: Some(network::TlsFiles {
            server_ca: gateway.server_ca_file.clone(),
            client_cert: gateway.client_cert_file.clone(),
            client_key: gateway.client_key_file.clone(),
        }),
    };
    let channel = network::operator_channel(&target.endpoint(Duration::from_secs(15)).await?)
        .await
        .with_context(|| format!("could not reach the Gateway at {}", gateway.url))?;
    OperatorClient::new(channel)
        .list_tags(request(
            ListTagsRequest {
                limit: 1,
                ..Default::default()
            },
            &target.token,
        )?)
        .await
        .context("the Gateway refused the operator token")?;
    let store = profiles::save(&gateway, replace)?;
    println!(
        "{}",
        json!({"name": gateway.name, "saved_in": store.display().to_string(), "active": true})
    );
    Ok(())
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
        "workspace_mounts": tag.workspace.as_ref().map(|spec| workspace_mounts::describe(&spec.mounts)),
        "workspace_mcp_servers": tag.workspace.as_ref().map(|spec| &spec.mcp_servers),
        "shared_execution_environment_id": tag.execution.as_ref().and_then(|settings| settings.shared_execution_environment_id.as_deref()),
        "retired_at_ms": tag.retired_at_ms,
        "runs_on": tag.runs_on,
    })
}

fn print_task(task: &Task) {
    println!("{}", task_json(task));
}

fn task_json(task: &Task) -> serde_json::Value {
    json!({
        "task_id": task.task_id, "tag_id": task.tag_id, "session_id": task.session_id,
        "state": task.state().as_str_name(), "result": task.result, "attempt_id": task.attempt_id,
        "harness": task.harness_kind().as_str_name(),
        "shared_execution_environment_id": supertag_protocol::shared_execution::environment(task.policy_snapshot.as_ref()),
        "workspace": task.workspace.as_ref().map(|spec| json!({
            "workspace_id": spec.workspace_id, "base_commit": spec.base_commit,
            "mounts": workspace_mounts::describe(&spec.mounts),
            "mcp_servers": spec.mcp_servers,
            "github_source": spec.github_source.as_ref().map(|value| json!({"workspace_id":value.workspace_id,"revision":value.revision,"source":value.source.as_ref().map(|source|json!({"account_id":source.account_id,"repository_id":source.repository_id,"repository":source.repository,"commit_sha":source.commit_sha,"revision":source.revision,"resolved_revision":source.resolved_revision}))})),
        })),
        "workspace_delivery": task.workspace_delivery.as_ref().map(artifacts::describe),
        "artifacts": task.artifacts.iter().map(|selection| json!({
            "artifact_id": selection.artifact_id,
            "paths": selection.paths,
        })).collect::<Vec<_>>(),
        "input_artifacts": task.input_artifacts.iter().map(|input| json!({
            "artifact_id": input.artifact_id,
            "source_task_id": input.source_task_id,
            "source_attempt_id": input.source_attempt_id,
            "publication": input.publication.as_ref().map(|p|json!({"publication_id":p.publication_id,"publication_revision":p.publication_revision,"consumption_id":p.consumption_id,"consumption_revision":p.consumption_revision,"source_objective_id":p.source_objective_id,"destination_objective_id":p.destination_objective_id})),
            "files": input.files.iter().map(|file| json!({
                "path": file.path,
                "blob": file.blob.as_ref().map(|blob| json!({
                    "sha256": blob.sha256,
                    "byte_length": blob.byte_length,
                })),
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "execution_limits": task.execution_limits.as_ref().map(|limits| json!({
            "max_reported_tokens": limits.max_reported_tokens,
            "max_reported_cost": limits.max_reported_cost.as_ref().map(|limit| json!({
                "amount_minor": limit.amount_minor, "currency": limit.currency,
            })),
            "max_native_agents": limits.max_native_agents,
        })),
    })
}
