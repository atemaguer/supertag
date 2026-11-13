#[macro_use]
mod terminal;
mod artifact_publications;
mod artifacts;
mod auth_keys;
mod delivery_branches;
mod deployment;
mod gateway_credentials;
mod github_publications;
mod github_workspaces;
mod harness;
mod harness_checks;
mod health;
mod host_status;
mod inbox;
mod init;
mod inputs;
mod lifecycle;
mod local;
mod local_config;
mod mailbox;
mod manifests;
mod mcp;
mod network;
mod node_bridges;
mod notifications;
mod objective_overview;
mod objectives;
mod observe;
mod operator_access;
mod output_policy;
mod placement;
mod policy;
mod profiles;
mod replies;
mod resources;
mod service_manager;
mod status;
mod surface_policy;
mod surface_setup;
mod tags;
mod task_artifact_inputs;
mod tasks;
mod teams;
mod tui;
mod volumes;
mod work_sessions;
mod workspace_mounts;

use std::{ffi::OsString, net::SocketAddr, path::PathBuf, time::Duration};

use anyhow::{Context, Result, ensure};
use clap::{Args, Parser, Subcommand};
use harness::{AdapterOptions, CodexAdapterArgs};
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
        HarnessKind, LarkDomain, ListTagsRequest, ServiceRole, Tag, Task,
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
use tokio_util::sync::CancellationToken;
use tonic::Request;

#[derive(Parser)]
#[command(name = "supertag", version)]
struct Cli {
    /// Gateway URL or the name of a Gateway saved in the terminal UI or desktop app,
    /// for the operator command that follows.
    #[arg(long = "gateway", id = "root_gateway", value_name = "URL|NAME")]
    gateway: Option<String>,
    #[command(subcommand)]
    command: Option<Command>,
}

/// The Gateway selected before the command name, if any.
static ROOT_GATEWAY: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Where an operator command connects. Both options are global, so a command group accepts them
/// before or after its subcommand: `supertag get --gateway G tag` or `supertag get tag --gateway G`.
#[derive(Args)]
struct Connection {
    /// Gateway URL or the name of a Gateway saved in the terminal UI or desktop app.
    /// A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN.
    #[arg(
        long,
        global = true,
        value_name = "URL|NAME",
        conflicts_with = "state_directory"
    )]
    gateway: Option<String>,
    /// Use the local services in this state directory instead of a Gateway.
    #[arg(long, global = true)]
    state_directory: Option<PathBuf>,
}

/// `supertag setup`: a hosted deployment, or a collaboration surface account.
#[derive(Subcommand)]
enum SetupCommand {
    #[command(flatten)]
    Deployment(deployment::SetupCommand),
    /// Connect a surface account: verify it, save its credentials in the credential vault, and
    /// record it in supertag.yaml.
    #[command(flatten)]
    Surface(surface_setup::SetupCommand),
}

#[derive(Subcommand)]
enum Command {
    /// Check a public or private gRPC service using the configured TLS trust.
    Health(health::HealthArgs),
    /// Prepare a deployment of the Control Plane and Gateway, or connect a collaboration
    /// surface account.
    Setup {
        #[command(subcommand)]
        command: SetupCommand,
    },
    /// Validate a deployment's configuration without connecting.
    Check {
        #[command(subcommand)]
        command: deployment::CheckCommand,
    },
    /// Check a running deployment through its public Gateway.
    Verify {
        #[command(subcommand)]
        command: deployment::VerifyCommand,
    },
    /// Preview an organization manifest through the Gateway.
    Diff(manifests::ManifestArgs),
    /// Apply an organization manifest through the Gateway.
    Apply(manifests::ManifestArgs),
    /// Stop further provider writes of a GitHub publication.
    GithubPublication {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: github_publications::PublicationCommand,
    },
    /// Select GitHub Workspace sources pinned to one repository and commit.
    Workspace {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: github_workspaces::WorkspaceCommand,
    },
    /// Resolve uncertain connector replies from provider evidence.
    Reply {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: replies::ReplyCommand,
    },
    /// Define reusable Roles: purpose, instructions, Permission Sets, and Context Sets.
    Role {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: policy::RoleCommand,
    },
    /// Assign Roles to Tags and deactivate assignments.
    RoleAssignment {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: policy::AssignmentCommand,
    },
    /// Define reusable Permission Sets and apply them at surface locations.
    PermissionSet {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: policy::SetCommand,
    },
    /// Define reusable Context Sets and apply them at surface locations.
    ContextSet {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: policy::SetCommand,
    },
    /// Record verified connector accounts for surface policy.
    SurfaceAccount {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: surface_policy::AccountCommand,
    },
    /// Bind a connector account's locations to a Tag and its policy.
    #[command(after_help = surface_policy::LOCATION_AFTER_HELP)]
    SurfaceLocation {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: surface_policy::LocationCommand,
    },
    /// Store or delete Gateway collaboration credentials in the configured credential vault.
    GatewayCredential {
        #[command(subcommand)]
        command: gateway_credentials::GatewayCredentialCommand,
    },
    /// Enroll, drain, resume, and revoke Worker Hosts, and rotate their credentials.
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
    /// Answer questions Objective Tasks ask the operator.
    Question {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: inbox::QuestionCommand,
    },
    /// Approve or deny actions waiting on an operator.
    Approval {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: inbox::ApprovalCommand,
    },
    /// List this host's catalog MCP servers and log in to OAuth servers.
    Mcp {
        #[command(subcommand)]
        command: mcp::McpCommand,
    },
    /// Manage permission to send direct messages between Tags.
    MailboxGrant {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: mailbox::GrantCommand,
    },
    /// Issue, rotate, and revoke named Operator Tokens. Admin operator token only.
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
    /// Check that a harness's Worker Host credentials work, and say how to sign in when not.
    SignIn(harness_checks::SignInArgs),
    /// Start local services or configured Worker Hosts in the background and return when ready.
    ///
    /// With --foreground, supervise them in this terminal until interrupted. A service with
    /// restart: unless-stopped makes up install a per-user service unit (launchd on macOS,
    /// systemd on Linux) that runs the supervisor and starts it again after a failure or login.
    Up {
        /// Service configuration, otherwise STATE_DIRECTORY/supertag.yaml when present.
        #[arg(short = 'f', long = "file")]
        file: Option<PathBuf>,
        /// Local state directory (default: ~/.supertag or SUPERTAG_STATE_DIR).
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
        /// Address the local Gateway listens on. Port 0 picks a free port.
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
        /// Service configuration, otherwise STATE_DIRECTORY/supertag.yaml when present.
        #[arg(short = 'f', long = "file")]
        file: Option<PathBuf>,
        /// Local state directory (default: ~/.supertag or SUPERTAG_STATE_DIR).
        #[arg(long)]
        state_directory: Option<PathBuf>,
        /// List the service names only.
        #[arg(long)]
        services: bool,
    },
    /// Run the private service that stores work and schedules execution.
    ControlPlane {
        /// Address this service listens on. Port 0 picks a free port.
        #[arg(long, default_value = "127.0.0.1:0")]
        listen: SocketAddr,
        /// Also accept gRPC carried in a WebSocket on this address, for hosts that only
        /// forward HTTP/1.1. This service's TLS runs inside the tunnel. Its bound address
        /// is reported after the gRPC address.
        #[arg(long)]
        websocket_listen: Option<SocketAddr>,
    },
    /// Run the public gRPC service for operators and Worker Hosts.
    Gateway {
        /// Address this service listens on. Port 0 picks a free port.
        #[arg(long, default_value = "127.0.0.1:0")]
        listen: SocketAddr,
        /// Also accept gRPC carried in a WebSocket on this address, for hosts that only
        /// forward HTTP/1.1. This service's TLS runs inside the tunnel. Its bound address
        /// is reported after the gRPC address.
        #[arg(long)]
        websocket_listen: Option<SocketAddr>,
        /// Private Control Plane URL that this Gateway forwards to.
        #[arg(long)]
        control_plane: String,
        /// Private directory for Session checkpoint archives that Worker Hosts transfer through this Gateway.
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
        /// Address for Slack webhooks. Requires the Slack state directory.
        #[arg(long, requires = "slack_state_directory")]
        slack_listen: Option<SocketAddr>,
        /// Private directory for Slack connector state and reply receipts.
        #[arg(long, requires = "slack_listen")]
        slack_state_directory: Option<PathBuf>,
        /// Address for GitHub webhooks. Requires the GitHub state directory.
        #[arg(long, requires = "github_state_directory")]
        github_listen: Option<SocketAddr>,
        /// Private directory for GitHub connector state and reply receipts.
        #[arg(long, requires = "github_listen")]
        github_state_directory: Option<PathBuf>,
        /// Private scratch for GitHub source bundles, using the configured GitHub account.
        /// The GitHub Surface connector reads the same `SUPERTAG_GITHUB_*` variables, so one
        /// Gateway serves either a GitHub Workspace or a GitHub location, not both.
        #[arg(long, conflicts_with = "github_listen")]
        github_workspace_directory: Option<PathBuf>,
        /// Address for Linear webhooks. Requires the Linear state directory.
        #[arg(long, requires = "linear_state_directory")]
        linear_listen: Option<SocketAddr>,
        /// Private directory for Linear connector state and reply receipts.
        #[arg(long, requires = "linear_listen")]
        linear_state_directory: Option<PathBuf>,
        /// Enable the outbound Lark or Feishu connection and store reply receipts here.
        #[arg(long)]
        lark_state_directory: Option<PathBuf>,
        /// Address for Microsoft Teams webhooks. Requires the Microsoft Teams state directory.
        #[arg(long, requires = "microsoft_teams_state_directory")]
        microsoft_teams_listen: Option<SocketAddr>,
        /// Private directory for Microsoft Teams connector state and reply receipts.
        #[arg(long, requires = "microsoft_teams_listen")]
        microsoft_teams_state_directory: Option<PathBuf>,
        /// Tell the operator about Inbox items here: desktop, webhook:HTTPS_URL[#SECRET_NAME],
        /// slack:CHANNEL_OR_USER_ID, or slack:WORKSPACE_ID/CHANNEL_OR_USER_ID. Repeatable.
        #[arg(
            long,
            long_help = "Tell the operator about Inbox items here: desktop, webhook:HTTPS_URL[#SECRET_NAME], slack:CHANNEL_OR_USER_ID, or slack:WORKSPACE_ID/CHANNEL_OR_USER_ID. Repeatable. A webhook's SECRET_NAME is read from SUPERTAG_NOTIFY_SECRET_<NAME> (uppercase, - as _) and sent as a bearer token. Slack destinations post with this Gateway's Slack connector."
        )]
        notify: Vec<String>,
    },
    /// Open the terminal UI for a saved or explicitly configured Gateway.
    Tui {
        /// Gateway URL or the name of a saved Gateway.
        #[arg(long, conflicts_with = "state_directory")]
        gateway: Option<String>,
        /// Use the local services in this state directory instead of a Gateway.
        #[arg(long)]
        state_directory: Option<PathBuf>,
        /// Terminal UI executable. Also reads SUPERTAG_TUI_BINARY.
        #[arg(long)]
        binary: Option<PathBuf>,
        /// Workspace ID the terminal UI starts in.
        #[arg(long)]
        workspace: Option<String>,
    },
    /// Connect a Worker Host and run accepted Tasks through an adapter.
    WorkerHost {
        /// Gateway URL this Worker Host connects to.
        #[arg(long)]
        gateway: String,
        /// Private directory for this Worker Host's enrollment and execution journal.
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
        /// Owner-controlled JSON mappings for Workspace Volume copies: each maps a Volume to a
        /// destination root, and an S3 Volume's credential name to an endpoint, region, and key
        /// variables.
        #[arg(long)]
        workspace_mount_mappings: Option<PathBuf>,
        /// Listen for authorized artifact reads from other Worker Hosts.
        #[arg(long, requires = "artifact_source_directory")]
        artifact_transfer_listen: Option<SocketAddr>,
        /// Dedicated owner-only absolute directory for immutable artifact copies.
        #[arg(long, requires = "artifact_transfer_listen")]
        artifact_source_directory: Option<PathBuf>,
        /// TLS certificate for the artifact transfer listener.
        #[arg(long, requires_all = ["artifact_transfer_listen", "artifact_transfer_tls_key"])]
        artifact_transfer_tls_cert: Option<PathBuf>,
        /// TLS private key for the artifact transfer listener.
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

A preset names an official HTTP server instead of a url, with its URL and resource mapping: {"name":"github","preset":"github","headerEnv":{"Authorization":"GITHUB_MCP_AUTH"}}. Presets are github, slack, linear, and teams; teams also needs "tenantId", the Microsoft Entra tenant ID or domain.

Catalog entries expose tools only when the Task's accepted Permission Sets grant them. Calls requiring approval appear in the operator Inbox. Endpoints must use HTTPS or literal loopback HTTP."#
        )]
        mcp_catalog: Option<PathBuf>,
        /// gRPC origin of a standalone shared execution provider for Cursor.
        #[arg(long, requires = "shared_execution_environment", conflicts_with_all = ["e2b_workspace_provider", "modal_workspace_provider", "mcp_catalog", "workspace_id", "allow_unsandboxed_commands"])]
        shared_execution_endpoint: Option<String>,
        /// Environment ID expected from the provider. Set SUPERTAG_EXECUTION_ADMIN_TOKEN separately.
        #[arg(long, requires = "shared_execution_endpoint")]
        shared_execution_environment: Option<String>,
        /// CA certificate for the shared execution provider endpoint.
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
        /// Seconds a Task Attempt may run before this host stops it.
        #[arg(long, default_value_t = 120)]
        attempt_timeout_seconds: u64,
        /// Exit after running one Task Attempt.
        #[arg(long)]
        once: bool,
        /// Stay connected while an interrupted Attempt waits for an operator decision, instead of exiting.
        #[arg(long)]
        wait_for_recovery: bool,
    },
    /// Create and revoke Auth Keys that enroll Worker Hosts.
    AuthKey {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: auth_keys::AuthKeyCommand,
    },
    /// Check an operator token against a Gateway, then save the Gateway under a name for
    /// `--gateway NAME` and the terminal UI. The token is read from SUPERTAG_OPERATOR_TOKEN, or
    /// from standard input when that is not set.
    Connect {
        /// The Gateway origin, such as https://supertag.example.com.
        url: String,
        /// The name to save it under.
        #[arg(long)]
        name: String,
        /// Replace a Gateway already saved under this name for the same origin.
        #[arg(long)]
        replace: bool,
        /// PEM file of the certificate authority that signed the Gateway's TLS certificate.
        #[arg(long)]
        server_ca_file: Option<PathBuf>,
        /// PEM client certificate for a Gateway that requires mutual TLS.
        #[arg(long, requires = "client_key_file")]
        client_cert_file: Option<PathBuf>,
        /// PEM private key of the client certificate.
        #[arg(long, requires = "client_cert_file")]
        client_key_file: Option<PathBuf>,
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
    /// Set up and retire Tags.
    Tag {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: tags::TagCommand,
    },
    /// Submit, cancel, and steer Tasks, and read their events, usage, and published results.
    Task {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: tasks::TaskCommand,
    },
    /// Publish completed artifact files for named destination Objectives, and withdraw them.
    ArtifactPublication {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: artifact_publications::PublicationCommand,
    },
    /// Approve and withdraw a destination Objective's use of a publication.
    ArtifactConsumption {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: artifact_publications::ConsumptionCommand,
    },
    /// Register Volumes and copy immutable artifact files into explicitly mapped storage.
    Volume {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: volumes::VolumeCommand,
    },
    /// Register a file Volume for read-only Workspace data.
    WorkspaceVolume {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: workspace_mounts::VolumeCommand,
    },
    /// Download files captured by a Task.
    Artifact {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: artifacts::CaptureCommand,
    },
    /// Import a Task's or Session's delivered commits as its Session branch in a repository.
    Fetch {
        #[command(flatten)]
        connection: Connection,
        #[command(flatten)]
        args: delivery_branches::FetchArgs,
    },
    /// Resolve a message whose delivery to a running Task is uncertain.
    Input {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: inputs::InputCommand,
    },
    /// Check operator settings by sending a sample.
    Test {
        #[command(subcommand)]
        command: notifications::TestCommand,
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
    /// Read one resource by kind and ID, or list a kind, as JSON.
    Get {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: resources::GetCommand,
    },
    /// Describe one resource in readable text.
    Describe {
        #[command(flatten)]
        connection: Connection,
        #[command(flatten)]
        args: resources::DescribeArgs,
    },
    /// Delete one resource by kind and ID.
    Delete {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: resources::DeleteCommand,
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

fn main() -> std::process::ExitCode {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error) => usage_error(error),
    };
    match dispatch(cli) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            // Errors carry text from services, surfaces and files; filter it for the terminal.
            errln!("Error: {error:?}");
            std::process::ExitCode::FAILURE
        }
    }
}

/// Help and version text is the CLI's own. A usage error can repeat what was typed, so it is
/// reported for the arguments with their controls replaced: a typed line break cannot add a
/// fake line, and an escape sequence prints as visible text.
fn usage_error(error: clap::Error) -> ! {
    use clap::error::ErrorKind;
    if matches!(
        error.kind(),
        ErrorKind::DisplayHelp | ErrorKind::DisplayVersion
    ) {
        error.exit()
    }
    let filtered = std::env::args_os().map(|arg| terminal::text(&arg.to_string_lossy()));
    let text = usage_error_text(&error, filtered);
    if error.use_stderr() {
        terminal::write_stderr(&text);
    } else {
        terminal::write_stdout(&text);
    }
    std::process::exit(error.exit_code())
}

/// A usage error repeats what was typed, so it is rendered again from the filtered arguments. If
/// those parse differently, only the kind of error is printed: the original rendering still holds
/// the typed text, and a typed line break in it would print as a separate line.
fn usage_error_text(error: &clap::Error, filtered: impl IntoIterator<Item = String>) -> String {
    match Cli::try_parse_from(filtered) {
        Err(filtered) if filtered.kind() == error.kind() => filtered.render().to_string(),
        _ => format!(
            "error: {}\n\nFor more information, try '--help'.\n",
            error
                .kind()
                .as_str()
                .unwrap_or("the arguments could not be read")
        ),
    }
}

fn dispatch(cli: Cli) -> Result<()> {
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
                    | Command::Setup {
                        command: SetupCommand::Deployment(_)
                    }
                    | Command::Check { .. }
                    | Command::Verify { .. }
                    | Command::Up { .. }
                    | Command::ControlPlane { .. }
                    | Command::Gateway { .. }
                    | Command::WorkerHost { .. }
                    | Command::Host {
                        command: host_status::HostCommand::Enroll { .. },
                        ..
                    }
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
        Command::Setup {
            command: SetupCommand::Deployment(command),
        } => deployment::setup(command).await?,
        Command::Check { command } => deployment::check(command)?,
        Command::Verify { command } => deployment::verify(command).await?,
        Command::Spend { connection, args } => observe::spend(connection, args).await?,
        Command::Metrics { connection, args } => observe::metrics(connection, args).await?,
        Command::Test { command } => notifications::run(command).await?,
        Command::Get {
            connection,
            command,
        } => resources::get(connection, command).await?,
        Command::Describe { connection, args } => resources::describe(connection, args).await?,
        Command::Delete {
            connection,
            command,
        } => resources::delete(connection, command).await?,
        Command::Watch { connection, args } => observe::watch(connection, args).await?,
        Command::Diff(args) => manifests::run(args, false).await?,
        Command::Apply(args) => manifests::run(args, true).await?,
        Command::Role {
            connection,
            command: policy::RoleCommand::Put(args),
        } => policy::put(connection, policy::Kind::Role, args).await?,
        Command::RoleAssignment {
            connection,
            command,
        } => policy::run_assignment(connection, command).await?,
        Command::PermissionSet {
            connection,
            command,
        } => {
            policy::run_set(connection, surface_setup::SetKind::PermissionSet, command).await?;
        }
        Command::ContextSet {
            connection,
            command,
        } => policy::run_set(connection, surface_setup::SetKind::ContextSet, command).await?,
        Command::SurfaceAccount {
            connection,
            command,
        } => surface_policy::run_account(connection, command).await?,
        Command::SurfaceLocation {
            connection,
            command,
        } => surface_policy::run_location(connection, command).await?,
        Command::GatewayCredential { command } => gateway_credentials::run(command).await?,
        Command::Setup {
            command: SetupCommand::Surface(command),
        } => surface_setup::setup(command).await?,
        Command::Placement {
            connection,
            command,
        } => placement::run(connection, command).await?,
        Command::Host {
            connection,
            command,
        } => host_status::run(connection, command).await?,
        Command::Reply {
            connection,
            command,
        } => replies::run(connection, command).await?,
        Command::Question {
            connection,
            command,
        } => inbox::run_question(connection, command).await?,
        Command::Approval {
            connection,
            command,
        } => inbox::run_approval(connection, command).await?,
        Command::Mcp { command } => mcp::run(command).await?,
        Command::MailboxGrant {
            connection,
            command,
        } => mailbox::run(connection, command).await?,
        Command::GithubPublication {
            connection,
            command,
        } => github_publications::run(connection, command).await?,
        Command::Workspace {
            connection,
            command,
        } => github_workspaces::run(connection, command).await?,
        Command::Team {
            connection,
            command,
        } => teams::run(connection, command).await?,
        Command::Init(args) => init::init(args).await?,
        Command::SignIn(args) => harness_checks::sign_in(args).await?,
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
            out!(
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
        Command::ControlPlane {
            listen,
            websocket_listen,
        } => control_plane(listen, websocket_listen).await?,
        Command::Gateway {
            listen,
            websocket_listen,
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
            notify,
        } => {
            gateway(
                listen,
                websocket_listen,
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
                    notify,
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
                        outln!("state {}", state.as_str());
                    }),
                }),
            };
            let token = CancellationToken::new();
            let shutdown = token.clone();
            let signal = tokio::spawn(async move {
                termination_signal().await;
                shutdown.cancel();
            });
            let result = supertag_worker_host::run(options, token, || outln!("ready")).await;
            signal.abort();
            result?;
        }
        Command::AuthKey {
            connection,
            command,
        } => auth_keys::run(connection, command).await?,
        Command::Connect {
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
        Command::AdapterGuardian { .. } => unreachable!("guardian runs outside Tokio"),
        Command::CodexAdapter(_) => unreachable!("Codex adapter uses a dedicated runtime"),
        Command::Tag {
            connection,
            command,
        } => tags::run(connection, command).await?,
        Command::Task {
            connection,
            command,
        } => tasks::run(connection, command).await?,
        Command::Fetch { connection, args } => delivery_branches::fetch(connection, args).await?,
        Command::ArtifactPublication {
            connection,
            command,
        } => artifact_publications::run(connection, command).await?,
        Command::ArtifactConsumption {
            connection,
            command,
        } => artifact_publications::run_consumption(connection, command).await?,
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

async fn control_plane(listen: SocketAddr, websocket: Option<SocketAddr>) -> Result<()> {
    let builder = network::server(listen, websocket, true).await?;
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
    health
        .set_serving::<
            supertag_protocol::v2::objective_overviews_server::ObjectiveOverviewsServer<ControlPlane>,
        >()
        .await;
    let listener = TcpListener::bind(listen).await?;
    outln!("{}", listener.local_addr()?);
    let tunnel = bind_websocket(websocket).await?;
    let maintenance = plane.clone();
    let sweep = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if let Err(error) = maintenance.sweep().await {
                errln!("Control Plane maintenance failed: {error}");
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
        .add_service(plane.operator_notifications_service())
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
        .add_service(plane.attempt_changed_paths_service())
        .add_service(plane.attempt_effects_service())
        .add_service(plane.spend_service())
        .add_service(plane.metrics_service())
        .add_service(plane.objective_overview_service())
        .add_service(plane.operator_events_service(watch_shutdown.clone()))
        .add_service(
            ObjectivesServer::new(plane)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
        )
        .serve_with_incoming_shutdown(
            supertag_transport::incoming(listener, tunnel),
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

/// Binds the optional WebSocket tunnel listener and reports its address.
async fn bind_websocket(address: Option<SocketAddr>) -> Result<Option<TcpListener>> {
    let Some(address) = address else {
        return Ok(None);
    };
    let listener = TcpListener::bind(address).await?;
    outln!("{}", listener.local_addr()?);
    Ok(Some(listener))
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
    notify: Vec<String>,
}

async fn gateway(
    listen: SocketAddr,
    websocket: Option<SocketAddr>,
    control_plane: String,
    checkpoint_directory: Option<PathBuf>,
    connectors: GatewayConnectors,
) -> Result<()> {
    // Refuse every call from a peer that skipped protocol negotiation.
    let mut builder = network::server(listen, websocket, false)
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
                github_connector(channel.clone(), gateway_token.clone(), state_directory).await?;
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
                linear_connector(channel.clone(), gateway_token.clone(), state_directory).await?;
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
                microsoft_teams_connector(channel.clone(), gateway_token.clone(), state_directory)
                    .await?;
            Some((connector, TcpListener::bind(address).await?))
        }
        None => None,
    };
    let lark = match connectors.lark {
        Some(directory) => {
            Some(lark_connector(channel.clone(), gateway_token.clone(), directory).await?)
        }
        None => None,
    };
    let publication_channel = channel.clone();
    let publication_token = gateway_token.clone();
    let operator_principal =
        std::env::var("SUPERTAG_OPERATOR_PRINCIPAL").unwrap_or_else(|_| "operator:local".into());
    let notifier = operator_notifier(
        &connectors.notify,
        slack.as_ref().map(|(slack, _)| slack.operator_sender()),
        channel.clone(),
        gateway_token.clone(),
        operator_principal.clone(),
    )?;
    let gateway = Gateway::new(
        channel,
        gateway_token,
        required_env("SUPERTAG_OPERATOR_TOKEN")?,
        operator_principal,
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
        let sources = github_workspace_sources(directory.clone()).await?;
        transfers = transfers.with_github_sources(sources.clone());
        source_reader = Some((
            sources,
            publication_channel.clone(),
            publication_token.clone(),
        ));
        let blobs = checkpoint_directory
            .as_ref()
            .context("GitHub Workspace publication requires Gateway artifact storage")?;
        Some(
            github_workspace_publisher(directory, blobs, publication_channel, publication_token)
                .await?,
        )
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
    health
        .set_serving::<supertag_protocol::v2::operator_notification_test_server::OperatorNotificationTestServer<supertag_gateway::notifications::TestNotifications>>()
        .await;
    health
        .set_serving::<
            supertag_protocol::v2::objective_overviews_server::ObjectiveOverviewsServer<Gateway>,
        >()
        .await;
    let listener = TcpListener::bind(listen).await?;
    outln!("{}", listener.local_addr()?);
    let tunnel = bind_websocket(websocket).await?;
    if let Some((_, listener)) = &slack {
        outln!("{}", listener.local_addr()?);
    }
    if let Some((_, listener)) = &github {
        outln!("{}", listener.local_addr()?);
    }
    if let Some((_, listener)) = &linear {
        outln!("{}", listener.local_addr()?);
    }
    if let Some((_, listener)) = &microsoft_teams {
        outln!("{}", listener.local_addr()?);
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
        .add_service(gateway.attempt_changed_paths_service())
        .add_service(gateway.attempt_effects_service())
        .add_service(gateway.spend_service())
        .add_service(gateway.metrics_service())
        .add_service(notifier.test_service(gateway.clone()))
        .add_service(gateway.objective_overview_service())
        .add_service(gateway.operator_events_service(shutdown.clone()));
    let grpc = async {
        let result = router
            .serve_with_incoming_shutdown(
                supertag_transport::incoming(listener, tunnel),
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
    let notification_loop = notifier.run(shutdown.clone());
    let services = async {
        let (grpc, slack, github, linear, lark, teams, publication, (source, notifications)) = tokio::join!(
            grpc,
            webhook,
            github_webhook,
            linear_webhook,
            lark_connection,
            microsoft_teams_webhook,
            publication_loop,
            async { tokio::join!(source_loop, notification_loop) }
        );
        notifications?;
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

/// The `--notify` destinations and their senders. Webhook secrets come from
/// `SUPERTAG_NOTIFY_SECRET_<NAME>`, with the name uppercased and `-` written as `_`.
fn operator_notifier(
    values: &[String],
    slack: Option<supertag_gateway::notifications::SlackSender>,
    channel: ProtocolChannel,
    gateway_token: String,
    principal: String,
) -> Result<supertag_gateway::notifications::OperatorNotifier> {
    use supertag_gateway::notifications::{Desktop, OperatorNotifier, Senders, parse_destinations};
    // Test builds never show real desktop notifications.
    #[cfg(feature = "test-fixtures")]
    let desktop = std::env::var_os("SUPERTAG_TEST_DESKTOP_NOTIFIER")
        .map_or(Desktop::Unavailable, |path| Desktop::Command(path.into()));
    #[cfg(not(feature = "test-fixtures"))]
    let desktop = Desktop::Native;
    let destinations = parse_destinations(values, notify_loopback_http())?;
    let mut secrets = std::collections::BTreeMap::new();
    for name in destinations.iter().filter_map(|d| d.secret_name.as_ref()) {
        let variable = notify_secret_variable(name);
        // A missing secret fails only its own destination, as TypeScript does.
        if let Some(value) = std::env::var(&variable)
            .ok()
            .filter(|value| !value.trim().is_empty())
        {
            secrets.insert(name.clone(), value.trim().to_owned());
        }
    }
    OperatorNotifier::new(
        destinations,
        Senders::new(slack, secrets, desktop)?,
        channel,
        gateway_token,
        principal,
    )
}

/// Test builds may notify a loopback HTTP webhook; release builds require HTTPS.
pub(crate) fn notify_loopback_http() -> bool {
    cfg!(feature = "test-fixtures")
        && std::env::var_os("SUPERTAG_TEST_NOTIFY_LOOPBACK_HTTP").is_some()
}

pub(crate) fn notify_secret_variable(name: &str) -> String {
    format!(
        "SUPERTAG_NOTIFY_SECRET_{}",
        name.to_ascii_uppercase().replace('-', "_")
    )
}

/// Secrets of one configured surface connector. Each comes from its environment variable when
/// that is set, and otherwise from the credential vault at `SUPERTAG_<SURFACE>_CREDENTIAL_ID`,
/// which defaults to `surface/<provider>/<account>`. The vault is read once, at startup.
struct SurfaceSecrets {
    label: &'static str,
    id: String,
    vault: Option<Option<supertag_gateway::credential_vault::CredentialValue>>,
}

impl SurfaceSecrets {
    fn new(label: &'static str, prefix: &str, provider: &str, account_id: &str) -> Self {
        Self {
            label,
            id: nonempty_env(&format!("{prefix}_CREDENTIAL_ID"))
                .unwrap_or_else(|| format!("surface/{provider}/{account_id}")),
            vault: None,
        }
    }

    async fn get(&mut self, variable: &str, field: &str) -> Result<String> {
        if let Some(value) = nonempty_env(variable) {
            return Ok(value);
        }
        let (label, id) = (self.label, &self.id);
        if self.vault.is_none() {
            let resolved = async {
                CredentialVault::from_process_environment()?
                    .resolve(id)
                    .await
            };
            self.vault = Some(resolved.await.with_context(|| {
                format!("set {variable}, or make {id} readable in the credential vault")
            })?);
        }
        self.vault
            .as_ref()
            .and_then(Option::as_ref)
            .with_context(|| {
                format!(
                    "{label} credentials are missing: store {id} in the credential vault or set {variable}"
                )
            })?
            .get(field)
            .filter(|value| !value.trim().is_empty())
            .cloned()
            .with_context(|| format!("credential {id} has no {field}"))
    }
}

fn nonempty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

/// The Slack signing secret and bot token come from the environment when both are set, and
/// otherwise from the credential vault.
async fn slack_secrets(account_id: &str) -> Result<(String, String)> {
    match (
        nonempty_env("SUPERTAG_SLACK_SIGNING_SECRET"),
        nonempty_env("SUPERTAG_SLACK_BOT_TOKEN"),
    ) {
        (Some(signing), Some(bot)) => return Ok((signing, bot)),
        (None, None) => {}
        _ => anyhow::bail!(
            "set both SUPERTAG_SLACK_SIGNING_SECRET and SUPERTAG_SLACK_BOT_TOKEN, or neither to use the credential vault"
        ),
    }
    let mut secrets = SurfaceSecrets::new("Slack", "SUPERTAG_SLACK", "slack", account_id);
    Ok((
        secrets
            .get("SUPERTAG_SLACK_SIGNING_SECRET", "signingSecret")
            .await?,
        secrets.get("SUPERTAG_SLACK_BOT_TOKEN", "botToken").await?,
    ))
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

async fn github_workspace_account() -> Result<GithubWorkspaceAccount> {
    let account_id = required_env("SUPERTAG_GITHUB_ACCOUNT_ID")?;
    let mut secrets = SurfaceSecrets::new("GitHub", "SUPERTAG_GITHUB", "github", &account_id);
    Ok(GithubWorkspaceAccount {
        account_id,
        repository_id: required_env("SUPERTAG_GITHUB_REPOSITORY_ID")?
            .parse()
            .context("invalid GitHub repository ID")?,
        repository: required_env("SUPERTAG_GITHUB_REPOSITORY")?,
        authentication: github_authentication(&mut secrets).await?,
    })
}
async fn github_workspace_publisher(
    directory: PathBuf,
    blobs: &std::path::Path,
    channel: ProtocolChannel,
    token: String,
) -> Result<supertag_gateway::github::publication::GithubPublisher> {
    let publisher = supertag_gateway::github::publication::GithubPublisher::new(
        github_workspace_account().await?,
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
async fn github_workspace_sources(directory: PathBuf) -> Result<GithubWorkspaceSources> {
    use std::os::unix::fs::DirBuilderExt as _;
    if !directory.exists() {
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .context("create private GitHub Workspace directory")?;
    }
    let sources = GithubWorkspaceSources::new(github_workspace_account().await?, &directory)?;
    #[cfg(feature = "test-fixtures")]
    if let Ok(api) = std::env::var("SUPERTAG_TEST_GITHUB_API_URL") {
        return sources.with_test_endpoints(
            api.parse()?,
            required_env("SUPERTAG_TEST_GITHUB_GIT_URL")?.parse()?,
        );
    }
    Ok(sources)
}

async fn github_connector(
    channel: ProtocolChannel,
    gateway_token: String,
    state_directory: PathBuf,
) -> Result<Github> {
    let account_id = required_env("SUPERTAG_GITHUB_ACCOUNT_ID")?;
    let mut secrets = SurfaceSecrets::new("GitHub", "SUPERTAG_GITHUB", "github", &account_id);
    let connector = Github::new(
        GithubConfig {
            account_id,
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
            webhook_secret: secrets
                .get("SUPERTAG_GITHUB_WEBHOOK_SECRET", "webhookSecret")
                .await?,
            authentication: github_authentication(&mut secrets).await?,
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

/// A token, or an App whose private key comes from `SUPERTAG_GITHUB_PRIVATE_KEY_FILE` or the
/// credential vault's `privateKey`. Setting the App ID or installation ID selects the App.
async fn github_authentication(secrets: &mut SurfaceSecrets) -> Result<GithubAuthentication> {
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
        return Ok(GithubAuthentication::Token(
            secrets.get("SUPERTAG_GITHUB_TOKEN", "token").await?,
        ));
    }
    ensure!(
        std::env::var_os("SUPERTAG_GITHUB_TOKEN").is_none(),
        "select one GitHub authentication mode"
    );
    let private_key_pem = if let Some(path) = std::env::var_os("SUPERTAG_GITHUB_PRIVATE_KEY_FILE") {
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
        private_key_pem
    } else {
        secrets
            .get("SUPERTAG_GITHUB_PRIVATE_KEY_FILE", "privateKey")
            .await?
    };
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

async fn linear_connector(
    channel: ProtocolChannel,
    gateway_token: String,
    state_directory: PathBuf,
) -> Result<Linear> {
    let account_id = required_env("SUPERTAG_LINEAR_ACCOUNT_ID")?;
    let mut secrets = SurfaceSecrets::new("Linear", "SUPERTAG_LINEAR", "linear", &account_id);
    let connector = Linear::new(
        LinearConfig {
            account_id,
            workspace_id: required_env("SUPERTAG_LINEAR_WORKSPACE_ID")?,
            team_id: required_env("SUPERTAG_LINEAR_TEAM_ID")?,
            tag_id: required_env("SUPERTAG_LINEAR_TAG_ID")?,
            allowed_users: required_env("SUPERTAG_LINEAR_ALLOWED_USERS")?
                .split(',')
                .map(|value| value.trim().to_owned())
                .collect(),
            webhook_secret: secrets
                .get("SUPERTAG_LINEAR_WEBHOOK_SECRET", "webhookSecret")
                .await?,
            api_key: secrets.get("SUPERTAG_LINEAR_API_KEY", "apiKey").await?,
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

async fn lark_connector(
    channel: ProtocolChannel,
    gateway_token: String,
    state_directory: PathBuf,
) -> Result<Lark> {
    let account_id = required_env("SUPERTAG_LARK_ACCOUNT_ID")?;
    let mut secrets = SurfaceSecrets::new("Lark", "SUPERTAG_LARK", "lark", &account_id);
    let domain = match required_env("SUPERTAG_LARK_DOMAIN")?.as_str() {
        "lark" => LarkDomain::Lark,
        "feishu" => LarkDomain::Feishu,
        _ => anyhow::bail!("SUPERTAG_LARK_DOMAIN must be lark or feishu"),
    };
    let connector = Lark::new(
        LarkConfig {
            account_id,
            domain,
            app_id: required_env("SUPERTAG_LARK_APP_ID")?,
            app_secret: secrets.get("SUPERTAG_LARK_APP_SECRET", "appSecret").await?,
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

async fn microsoft_teams_connector(
    channel: ProtocolChannel,
    gateway_token: String,
    state_directory: PathBuf,
) -> Result<MicrosoftTeams> {
    let account_id = required_env("SUPERTAG_MICROSOFT_TEAMS_ACCOUNT_ID")?;
    let mut secrets = SurfaceSecrets::new(
        "Microsoft Teams",
        "SUPERTAG_MICROSOFT_TEAMS",
        "teams",
        &account_id,
    );
    let connector = MicrosoftTeams::new(
        MicrosoftTeamsConfig {
            account_id,
            app_id: required_env("SUPERTAG_MICROSOFT_TEAMS_APP_ID")?,
            app_secret: secrets
                .get("SUPERTAG_MICROSOFT_TEAMS_APP_SECRET", "appSecret")
                .await?,
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
    async fn endpoint(&self, timeout: Duration) -> Result<supertag_transport::Target> {
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
    crate::terminal::print_json(
        &json!({"name": gateway.name, "saved_in": store.display().to_string(), "active": true}),
    )?;
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

fn print_task(task: &Task) -> Result<()> {
    Ok(crate::terminal::print_json(&task_json(task))?)
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
        "workspace_selection": task.workspace_selection,
        "workspace_mount_writes": workspace_mounts::describe_writes(&task.workspace_mount_writes),
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

#[cfg(test)]
mod tests {
    use clap::{CommandFactory, Parser};

    use super::{Cli, usage_error_text};
    use crate::{observe::WATCH_EVENT_STREAMS, resources::KINDS};

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn a_usage_error_never_falls_back_to_the_typed_text() {
        let typed = "5\nerror: fake line";
        let error = Cli::try_parse_from(args(&["supertag", "get", "objectives", "--limit", typed]))
            .err()
            .expect("an invalid limit is a usage error");
        assert!(error.render().to_string().contains("\nerror: fake line"));
        // The filtered arguments parse to a different kind of error, so the original rendering,
        // which still holds the typed line break, must not be used.
        let text = usage_error_text(&error, args(&["supertag", "--version"]));
        assert_eq!(
            text,
            "error: invalid value for one of the arguments\n\nFor more information, try '--help'.\n"
        );
        // With the same kind, the filtered rendering keeps the value on one line.
        let filtered = usage_error_text(
            &error,
            args(&[
                "supertag",
                "get",
                "objectives",
                "--limit",
                &crate::terminal::text(typed),
            ]),
        );
        assert!(filtered.contains("'5 error: fake line'"), "{filtered}");
        assert!(!filtered.contains("\nerror: fake line"), "{filtered}");
    }

    /// Verbs that apply to every resource kind. They come first: `supertag get tag ID`.
    const GENERIC_VERBS: [&str; 6] = ["get", "describe", "delete", "watch", "apply", "diff"];

    /// Generic verbs, and their synonyms, that a noun group must leave to `get`, `describe`,
    /// `delete`, and `watch`: no `team list`, `surface-location show`, or `delete-location`.
    const READ_VERBS: [&str; 6] = ["get", "list", "show", "describe", "delete", "watch"];

    /// Verbs that must never start a top-level command, as in the removed `get-task`,
    /// `create-auth-key`, `update tag`, or `activate`: a resource-specific action goes after its
    /// noun, `supertag task cancel`.
    const VERBS: [&str; 33] = [
        "get",
        "list",
        "show",
        "describe",
        "delete",
        "watch",
        "apply",
        "diff",
        "put",
        "create",
        "update",
        "set",
        "remove",
        "revoke",
        "retire",
        "enroll",
        "rotate",
        "connect",
        "resolve",
        "submit",
        "cancel",
        "download",
        "activate",
        "deactivate",
        "assign",
        "approve",
        "deny",
        "answer",
        "consume",
        "withdraw",
        "publish",
        "allow",
        "grant",
    ];

    /// Top-level groups that are not a resource kind: deployment and surface setup and checks,
    /// placement rules, this host's MCP catalog, local vault credentials, and test sends. Every
    /// other group is named after a kind in `resources::KINDS`.
    const OTHER_GROUPS: [&str; 7] = [
        "setup",
        "check",
        "verify",
        "placement",
        "mcp",
        "gateway-credential",
        "test",
    ];

    /// Groups of this machine's local state rather than Control Plane resources, which `get` does
    /// not read: `mcp list` lists the host's MCP catalog, `gateway-credential delete` removes a
    /// vault entry.
    const LOCAL_GROUPS: [&str; 2] = ["mcp", "gateway-credential"];

    /// Top-level commands that act on this machine, a deployment, or a report rather than on one
    /// resource kind. `connect` is the one verb: it saves a Gateway on this machine.
    const OPERATIONS: [&str; 19] = [
        "health",
        "init",
        "sign-in",
        "up",
        "down",
        "logs",
        "ps",
        "status",
        "version",
        "config",
        "control-plane",
        "gateway",
        "tui",
        "worker-host",
        "connect",
        "fetch",
        "spend",
        "metrics",
        "audit",
    ];

    /// RESOURCE VERB actions named after another kind, because they create it: `task input`
    /// sends the Input that `get input` reads.
    const ACTIONS_NAMED_AFTER_KINDS: [[&str; 2]; 1] = [["task", "input"]];

    fn names(command: &clap::Command) -> Vec<String> {
        let mut names = vec![command.get_name().to_owned()];
        names.extend(command.get_all_aliases().map(str::to_owned));
        names
    }

    fn subcommand<'a>(command: &'a clap::Command, name: &str) -> &'a clap::Command {
        command
            .find_subcommand(name)
            .unwrap_or_else(|| panic!("supertag {name} exists"))
    }

    /// Every value a positional kind argument accepts, aliases included.
    fn kind_values(command: &clap::Command, argument: &str) -> Vec<String> {
        let argument = command
            .get_arguments()
            .find(|candidate| candidate.get_id() == argument)
            .unwrap_or_else(|| panic!("{} has a {argument} argument", command.get_name()));
        assert!(argument.is_positional(), "{argument} is positional");
        let mut values = argument
            .get_possible_values()
            .iter()
            .flat_map(|value| value.get_name_and_aliases().map(str::to_owned))
            .collect::<Vec<_>>();
        values.sort();
        values
    }

    fn sorted(mut values: Vec<String>) -> Vec<String> {
        values.sort();
        values
    }

    /// The command grammar: ACTION RESOURCE for the generic verbs, which accept exactly the kinds
    /// in `resources::KINDS`; RESOURCE VERB for every other action, under a group named after its
    /// kind. Every top-level command is a generic verb, a kind's group, or one of the listed
    /// non-resource groups and operations; none starts with a verb; and no group reads, lists,
    /// deletes, or watches a resource itself.
    #[test]
    fn the_command_tree_follows_the_resource_grammar() {
        let cli = Cli::command();
        cli.clone().debug_assert();
        check_grammar(&cli);
    }

    /// The grammar check refuses each shape review found in an earlier command tree, added back to
    /// the real one: a verb taking its resource as a separate word (`update tag`), a verb-first
    /// action (`activate`), a group that is not a kind (`surface-policy`, `github-workspace`),
    /// and reads inside a group, whether named after a kind or not (`surface-location show`,
    /// `team posts`, `placement approval`, `mailbox-grant list`).
    #[test]
    fn the_grammar_check_refuses_the_reviewed_shapes() {
        let leaf = |name: &'static str| clap::Command::new(name);
        let group = |name: &'static str, verb: &'static str| {
            clap::Command::new(name).subcommand(clap::Command::new(verb))
        };
        let mutations: Vec<(&str, clap::Command)> = vec![
            ("update", Cli::command().subcommand(group("update", "tag"))),
            ("activate", Cli::command().subcommand(leaf("activate"))),
            (
                "surface-policy",
                Cli::command().subcommand(group("surface-policy", "put")),
            ),
            (
                "github-workspace",
                Cli::command().subcommand(group("github-workspace", "put")),
            ),
            (
                "surface-location show",
                Cli::command().mut_subcommand("surface-location", |c| c.subcommand(leaf("show"))),
            ),
            (
                "surface-location delete-location",
                Cli::command().mut_subcommand("surface-location", |c| {
                    c.subcommand(leaf("delete-location"))
                }),
            ),
            (
                "team posts",
                Cli::command().mut_subcommand("team", |c| c.subcommand(leaf("posts"))),
            ),
            (
                "placement approval",
                Cli::command().mut_subcommand("placement", |c| c.subcommand(leaf("approval"))),
            ),
            (
                "mailbox-grant list",
                Cli::command().mut_subcommand("mailbox-grant", |c| c.subcommand(leaf("list"))),
            ),
            (
                "role-assignment assignments",
                Cli::command()
                    .mut_subcommand("role-assignment", |c| c.subcommand(leaf("assignments"))),
            ),
        ];
        for (shape, cli) in mutations {
            let refusal =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| check_grammar(&cli)))
                    .expect_err(&format!("the grammar check accepts supertag {shape}"));
            let message = refusal
                .downcast_ref::<String>()
                .expect("the check panics with a formatted message");
            assert!(
                message.starts_with(&format!("supertag {shape} ")),
                "supertag {shape} is refused for itself, not: {message}"
            );
        }
    }

    fn check_grammar(cli: &clap::Command) {
        let kind_names = |filter: fn(&crate::resources::KindSpec) -> bool| {
            sorted(
                KINDS
                    .iter()
                    .filter(|spec| filter(spec))
                    .flat_map(|spec| [spec.name.to_owned(), spec.plural.to_owned()])
                    .collect(),
            )
        };
        for spec in KINDS {
            assert_eq!(
                format!("{:?}", spec.kind)
                    .chars()
                    .enumerate()
                    .flat_map(|(index, letter)| {
                        let dash = (index > 0 && letter.is_uppercase()).then_some('-');
                        dash.into_iter().chain(letter.to_lowercase())
                    })
                    .collect::<String>(),
                spec.name,
                "the table names each kind as clap does"
            );
            assert_eq!(
                crate::resources::spec(spec.kind).name,
                spec.name,
                "one row per kind"
            );
            assert!(
                spec.read || spec.list,
                "get reads {} by ID or lists it",
                spec.name
            );
        }

        // get: one subcommand per kind, named singular with the plural as an alias. A kind read
        // by ID takes one, optional exactly when the kind lists; a listed-only kind takes none.
        let get = subcommand(cli, "get");
        let mut get_names = Vec::new();
        for kind in get.get_subcommands() {
            let spec = KINDS
                .iter()
                .find(|spec| spec.name == kind.get_name())
                .unwrap_or_else(|| panic!("get {} is in KINDS", kind.get_name()));
            assert_eq!(names(kind), [spec.name, spec.plural], "get {}", spec.name);
            let id = kind
                .get_positionals()
                .find(|argument| argument.get_id() == "id");
            assert_eq!(
                id.is_some(),
                spec.read,
                "get {} takes an ID exactly when the table reads it by ID",
                spec.name
            );
            if let Some(id) = id {
                assert_eq!(
                    id.is_required_set(),
                    !spec.list,
                    "get {} lists without an ID exactly when the table says so",
                    spec.name
                );
            }
            get_names.extend(names(kind));
        }
        assert_eq!(
            sorted(get_names),
            kind_names(|_| true),
            "get reads every kind"
        );

        let describe = subcommand(cli, "describe");
        assert_eq!(
            kind_values(describe, "kind"),
            kind_names(|spec| spec.read),
            "describe reads every kind read by ID"
        );

        let delete = subcommand(cli, "delete");
        let mut delete_names = Vec::new();
        for kind in delete.get_subcommands() {
            let spec = KINDS
                .iter()
                .find(|spec| spec.name == kind.get_name())
                .unwrap_or_else(|| panic!("delete {} is in KINDS", kind.get_name()));
            assert_eq!(
                names(kind),
                [spec.name, spec.plural],
                "delete {}",
                spec.name
            );
            delete_names.extend(names(kind));
        }
        assert_eq!(
            sorted(delete_names),
            kind_names(|spec| spec.delete),
            "delete removes exactly the deletable kinds"
        );

        let mut watched = kind_names(|spec| spec.watch);
        watched.extend(
            WATCH_EVENT_STREAMS
                .iter()
                .flatten()
                .map(|name| (*name).to_owned()),
        );
        assert_eq!(
            kind_values(subcommand(cli, "watch"), "kinds"),
            sorted(watched),
            "watch follows the watchable kinds and the event streams"
        );
        for [stream, _] in WATCH_EVENT_STREAMS {
            assert!(
                KINDS.iter().all(|spec| spec.name != *stream),
                "{stream} is a resource kind, so it belongs in KINDS"
            );
        }
        for verb in ["apply", "diff"] {
            subcommand(cli, verb);
        }

        // Names a group's action must not take, because `get` reads them: every kind's singular
        // and plural, and the last word of each plural (`team posts`, `inbox approvals`).
        let mut read_names = kind_names(|_| true);
        read_names.extend(KINDS.iter().filter_map(|spec| {
            spec.plural
                .rsplit_once('-')
                .map(|(_, last)| last.to_owned())
        }));

        // RESOURCE VERB everywhere else.
        for command in cli
            .get_subcommands()
            .filter(|command| !command.is_hide_set())
        {
            let name = command.get_name();
            if GENERIC_VERBS.contains(&name) {
                continue;
            }
            let kind_group = KINDS.iter().any(|spec| spec.name == name);
            assert!(
                kind_group || OTHER_GROUPS.contains(&name) || OPERATIONS.contains(&name),
                "supertag {name} is neither a generic verb, a resource kind's group, nor a listed \
                 operation; read with supertag get KIND and act with supertag KIND VERB"
            );
            assert_eq!(
                command.has_subcommands(),
                !OPERATIONS.contains(&name),
                "supertag {name} is a group exactly when it is not a listed operation"
            );
            let first = name.split('-').next().unwrap_or(name);
            assert!(
                !VERBS.contains(&first) || name == "connect",
                "supertag {name} starts with a verb; use supertag KIND VERB"
            );
            for spec in KINDS {
                assert!(
                    name == spec.name
                        || !name.starts_with(&format!("{}-", spec.name))
                        || KINDS.iter().any(|other| other.name == name),
                    "supertag {name} is a {} action; make it supertag {} {}",
                    spec.name,
                    spec.name,
                    &name[spec.name.len() + 1..]
                );
            }
            if LOCAL_GROUPS.contains(&name) {
                continue;
            }
            for verb in command.get_subcommands().map(clap::Command::get_name) {
                let first = verb.split('-').next().unwrap_or(verb);
                assert!(
                    !READ_VERBS.contains(&first),
                    "supertag {name} {verb} duplicates a generic verb; use supertag {first} KIND"
                );
                assert!(
                    !read_names.iter().any(|read| read == verb)
                        || ACTIONS_NAMED_AFTER_KINDS.contains(&[name, verb]),
                    "supertag {name} {verb} reads a resource; use supertag get KIND"
                );
            }
        }
        for name in OTHER_GROUPS.iter().chain(&OPERATIONS) {
            subcommand(cli, name);
            assert!(
                KINDS.iter().all(|spec| spec.name != *name),
                "{name} is a kind, so its group is not listed separately"
            );
        }
    }

    /// The removed command shapes no longer parse, and their replacements do.
    #[test]
    fn the_removed_command_shapes_are_refused_and_their_replacements_parse() {
        for arguments in [
            [
                "supertag",
                "update",
                "tag",
                "builder",
                "--add-location",
                "slack",
            ]
            .as_slice(),
            &[
                "supertag",
                "activate",
                "permission-set",
                "reviewers",
                "--tag",
                "t",
            ],
            &["supertag", "deactivate", "context-set", "c", "--tag", "t"],
            &["supertag", "surface-policy", "show", "location", "l"],
            &["supertag", "surface-policy", "list", "account"],
            &["supertag", "surface-policy", "delete-location", "l"],
            &["supertag", "policy", "assignments"],
            &["supertag", "policy", "put", "role", "role.json"],
            &["supertag", "mailbox-grants", "list", "builder"],
            &["supertag", "mailbox", "builder"],
            &["supertag", "inbox", "list"],
            &["supertag", "inbox", "approval", "a1"],
            &["supertag", "inbox", "approvals"],
            &["supertag", "team", "posts", "release"],
            &["supertag", "github-workspace", "put", "w"],
            &["supertag", "artifact-publication", "consume", "c", "p", "o"],
            &["supertag", "describe", "mailbox-grant", "g"],
            &["supertag", "get", "workstream-post", "p1", "--team", "t"],
        ] {
            assert!(
                Cli::try_parse_from(arguments).is_err(),
                "{arguments:?} is refused"
            );
        }
        for arguments in [
            [
                "supertag",
                "tag",
                "update",
                "builder",
                "--add-location",
                "slack",
            ]
            .as_slice(),
            &[
                "supertag",
                "permission-set",
                "activate",
                "reviewers",
                "--tag",
                "builder",
                "--provider",
                "slack",
                "--gateway",
                "g",
            ],
            &["supertag", "get", "surface-location", "l", "--gateway", "g"],
            &["supertag", "get", "surface-locations", "--account", "slack"],
            &[
                "supertag",
                "delete",
                "surface-location",
                "l",
                "--expected-revision",
                "2",
            ],
            &["supertag", "get", "role-assignments", "--active"],
            &["supertag", "get", "mailbox-grants", "--tag", "builder"],
            &["supertag", "get", "messages", "--mailbox", "builder"],
            &["supertag", "get", "inbox-items", "--objective", "o"],
            &["supertag", "get", "approvals", "--pending"],
            &["supertag", "describe", "approval", "a1"],
            &["supertag", "get", "question", "task-1"],
            &["supertag", "get", "workstream-posts", "--team", "release"],
            &[
                "supertag",
                "workspace",
                "put",
                "w",
                "--account",
                "a",
                "--repository-id",
                "1",
                "--repository",
                "o/r",
            ],
            &["supertag", "artifact-consumption", "approve", "c", "p", "o"],
            &["supertag", "approval", "deny", "a1", "--reason", "no"],
            &["supertag", "question", "answer", "task-1", "yes"],
            &[
                "supertag",
                "role-assignment",
                "create",
                "reviewer",
                "builder",
            ],
        ] {
            Cli::try_parse_from(arguments).unwrap_or_else(|error| panic!("{arguments:?}: {error}"));
        }
    }

    /// Plurals are accepted wherever the singular is, and a connection option may follow the
    /// subcommand of a group.
    #[test]
    fn kinds_accept_plurals_and_connection_options_follow_the_subcommand() {
        for arguments in [
            ["supertag", "get", "tags", "--state-directory", "/tmp/x"].as_slice(),
            &["supertag", "get", "--gateway", "local", "tag", "builder"],
            &["supertag", "get", "tag", "builder", "--gateway", "local"],
            &["supertag", "describe", "hosts", "laptop"],
            &["supertag", "delete", "teams", "release", "--gateway", "g"],
            &["supertag", "watch", "tasks", "objective"],
            &["supertag", "task", "cancel", "task-1", "--gateway", "g"],
            &["supertag", "host", "drain", "laptop", "--gateway", "g"],
        ] {
            Cli::try_parse_from(arguments).unwrap_or_else(|error| panic!("{arguments:?}: {error}"));
        }
        // host enroll names the Gateway and state directory of the host it enrolls with its own
        // options, which shadow the group's connection options.
        let enroll = Cli::try_parse_from([
            "supertag",
            "host",
            "enroll",
            "laptop",
            "--gateway",
            "https://gateway.example",
            "--state-directory",
            "/tmp/host",
        ])
        .expect("host enroll parses");
        match enroll.command {
            Some(super::Command::Host {
                command:
                    crate::host_status::HostCommand::Enroll {
                        gateway,
                        state_directory,
                        ..
                    },
                ..
            }) => {
                assert_eq!(gateway, "https://gateway.example");
                assert_eq!(state_directory, std::path::Path::new("/tmp/host"));
            }
            _ => panic!("host enroll parses as host enroll"),
        }
        assert!(enroll.gateway.is_none(), "no root --gateway was given");
        for arguments in [
            ["supertag", "get", "task"].as_slice(),
            &["supertag", "get", "tag", "builder", "--include-retired"],
            &["supertag", "get-task", "task-1"],
            &["supertag", "list-tags"],
        ] {
            assert!(
                Cli::try_parse_from(arguments).is_err(),
                "{arguments:?} is refused"
            );
        }
    }
}
