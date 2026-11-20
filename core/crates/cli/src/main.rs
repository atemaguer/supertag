#[macro_use]
mod terminal;
mod artifact_publications;
mod artifacts;
mod auth_keys;
mod conversation_message;
mod delivery_branches;
mod deployment;
mod enrollments;
mod gateway_credentials;
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
mod local_gateway;
mod local_landing;
mod local_workspaces;
mod mailbox;
mod manifests;
mod mcp;
mod memories;
mod network;
mod node_bridges;
mod notifications;
mod objective_overview;
mod objective_watch;
mod objectives;
mod observe;
mod operator_access;
mod output_policy;
mod placement;
mod policy;
mod power;
mod profiles;
mod remote_workspaces;
mod removed_hosts;
mod replies;
mod resources;
mod schedules;
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
mod worker_host;
mod workspace_landings;
mod workspace_mounts;

const SKILL_CATALOG_HELP: &str = r#"Private host allowlist of Skill packages.

A directory holds one directory per Skill. A JSON file lists them: {"version":1,"skills":[{"id":"review","path":"skills/review","version":"1"}]}. Its "github" list names Skills in a GitHub repository, fetched at an exact commit when a Task needs one: {"repository":"acme/skills","path":"catalog","revision":"main","skills":["review"]}. A new Task pins the revision's current commit and its retries keep it, on this host or another. Git on this host must be able to read the repository."#;

use std::{
    ffi::OsString,
    net::SocketAddr,
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, anyhow, ensure};
use clap::{Args, Parser, Subcommand};
use harness::{AdapterOptions, CodexAdapterArgs};
use serde_json::json;
use sha2::{Digest, Sha256};
use supertag_api::{Api, transfers::ApiTransfers};
use supertag_control_plane::ControlPlane;
use supertag_credential_vault::CredentialVault;
use supertag_gateway::{
    github::{Github, GithubConfig},
    lark::{Lark, LarkConfig},
    linear::{Linear, LinearConfig},
    microsoft_teams::{MicrosoftTeams, MicrosoftTeamsConfig},
    slack::{Slack, SlackConfig, SlackEvents},
};
use supertag_github::{GithubAppConfig, GithubAuthentication};
use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request,
    negotiation::{Negotiator, ProtocolChannel, connect, fence},
    v2::{
        LarkDomain, ServiceRole, Tag, Task, artifact_directory_server::ArtifactDirectoryServer,
        artifact_publications_server::ArtifactPublicationsServer,
        artifact_volume_directory_server::ArtifactVolumeDirectoryServer,
        attempt_inputs_server::AttemptInputsServer, connector_server::ConnectorServer,
        conversations_server::ConversationsServer, live_inputs_server::LiveInputsServer,
        objectives_server::ObjectivesServer, operator_client::OperatorClient,
        operator_server::OperatorServer, worker_host_server::WorkerHostServer,
        workspace_directory_server::WorkspaceDirectoryServer,
    },
};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use tonic::Request;

#[derive(Parser)]
#[command(name = "supertag", version)]
struct Cli {
    /// Gateway URL or the name of a Gateway saved with `supertag connect` or in the desktop app,
    /// for the operator command that follows, or for the terminal UI when no command follows.
    #[arg(long = "gateway", id = "root_gateway", value_name = "URL|NAME")]
    gateway: Option<String>,
    #[command(subcommand)]
    command: Option<Command>,
}

/// The Gateway selected before the command name, if any.
static ROOT_GATEWAY: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Where an operator command connects. Both options are global, so a command group accepts them
/// before or after its subcommand: `supertag get --gateway G tag` or `supertag get tag --gateway G`.
/// Operator commands connect to a Gateway, which forwards them to its Control Plane.
#[derive(Args)]
struct Connection {
    /// Gateway URL or the name of a Gateway saved with `supertag connect` or in the desktop app.
    /// A URL reads the operator token from SUPERTAG_OPERATOR_TOKEN.
    #[arg(
        long,
        global = true,
        value_name = "URL|NAME",
        conflicts_with = "state_directory"
    )]
    gateway: Option<String>,
    /// Use the local services `supertag up` runs from this state directory. Without either
    /// option, SUPERTAG_GATEWAY_URL, else the local services in SUPERTAG_STATE_DIR or ~/.supertag.
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
    /// Set up SuperTag on this machine for the git repository in the current directory.
    Init(init::InitArgs),
    /// Start local services or configured Worker Hosts in the background and return when ready.
    ///
    /// With --foreground, supervise them in this terminal until interrupted. A service with
    /// restart: unless-stopped makes up install a per-user service unit (launchd on macOS,
    /// systemd on Linux) that runs the supervisor and starts it again after a failure or login.
    ///
    /// Running services are left alone when nothing changed. Changed settings restart them; so
    /// does another build of SuperTag, such as the release before an upgrade, which up stops
    /// and starts again with this CLI's executable.
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
        #[arg(long, long_help = SKILL_CATALOG_HELP)]
        skill_catalog: Option<PathBuf>,
        /// Address the local Control Plane listens on. Port 0 picks a free port.
        #[arg(long, default_value = "127.0.0.1:0")]
        control_plane_listen: SocketAddr,
    },
    /// Open the terminal UI; plain supertag opens it too.
    ///
    /// Starts supertag-tui from the directory this command is installed in, after checking that
    /// it is from the same release. The terminal UI connects on its own: to the Gateway named
    /// here, else to the one it used last, else to this machine's local services.
    Tui {
        /// Gateway URL or the name of a saved Gateway. A URL reads the operator token from
        /// SUPERTAG_OPERATOR_TOKEN.
        #[arg(long, value_name = "URL|NAME", conflicts_with = "state_directory")]
        gateway: Option<String>,
        /// Use the local services `supertag up` runs from this state directory.
        #[arg(long)]
        state_directory: Option<PathBuf>,
        /// Terminal UI executable, instead of supertag-tui beside this command. Also reads
        /// SUPERTAG_TUI_BINARY.
        #[arg(long)]
        binary: Option<PathBuf>,
    },
    /// Send a message to your conversation with a Tag and print its reply.
    ///
    /// The conversation is the one the terminal UI and the desktop app show, so a message sent
    /// here appears there, and a message sent there continues here. The command waits for the
    /// reply, printing the Tag's messages as they arrive, and fails when the turn fails.
    Message(conversation_message::MessageArgs),
    /// Show Worker Hosts, Tags, unfinished Objectives, and the operator inbox.
    Status(status::StatusArgs),
    /// List this machine's SuperTag services and the Workers each Worklet runs.
    Ps(lifecycle::PsArgs),
    /// Print this machine's service logs.
    Logs(lifecycle::LogsArgs),
    /// Stop this machine's SuperTag services, draining local Worker Hosts first.
    ///
    /// When the Control Plane cannot be reached or speaks another protocol, as after an
    /// upgrade, down stops the services without draining. Worklets still stop gracefully,
    /// and their running Task Attempts follow the recovery rules.
    Down(lifecycle::DownArgs),
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
    /// Check a running deployment through its public Control Plane endpoint.
    Verify {
        #[command(subcommand)]
        command: deployment::VerifyCommand,
    },
    /// Preview an organization manifest through the Control Plane.
    Diff(manifests::ManifestArgs),
    /// Apply an organization manifest through the Control Plane.
    Apply(manifests::ManifestArgs),
    /// Add local git repositories as Workspaces, declare remote Workspaces on any git server and
    /// their Workspace Credentials, and check them.
    Workspace {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: remote_workspaces::WorkspaceCommand,
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
    /// Check that a harness's Worker Host credentials work, and say how to sign in when not.
    SignIn(harness_checks::SignInArgs),
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
    /// Run the Control Plane: the public API for operator clients, Worker Hosts, and Gateways,
    /// and the service that stores work and schedules execution.
    ControlPlane {
        /// Address this service listens on. Port 0 picks a free port.
        #[arg(long, default_value = "127.0.0.1:0")]
        listen: SocketAddr,
        /// Also accept gRPC carried in a WebSocket on this address, for hosts that only
        /// forward HTTP/1.1. This service's TLS runs inside the tunnel. Its bound address
        /// is reported after the gRPC address.
        #[arg(long)]
        websocket_listen: Option<SocketAddr>,
        /// Removed: the Control Plane maps no Volume. Refused with what replaces it.
        #[arg(long = "artifact-volume", hide = true)]
        removed_artifact_volumes: Vec<String>,
        /// Removed: S3 Volume credentials live in the credential vault. Refused with what replaces it.
        #[arg(long = "artifact-s3-volumes", hide = true)]
        removed_artifact_s3_volumes: Option<PathBuf>,
        /// Private directory of git delivery, which reads remote Workspaces and opens review
        /// pull requests: scratch for each operation and remembered SSH host keys. Default:
        /// git-delivery in SUPERTAG_STATE_DIR or ~/.supertag. Workspace Credentials come from the
        /// credential vault there (SUPERTAG_CREDENTIAL_VAULT).
        #[arg(long)]
        git_delivery_directory: Option<PathBuf>,
        /// Also write each committed audit entry as one JSON line to `stderr` or to this absolute
        /// file path, created owner-only. The database keeps every entry either way.
        #[arg(long, value_name = "stderr|PATH")]
        audit_log: Option<String>,
    },
    /// Run a Gateway: the endpoint clients and operators connect to, which forwards their calls to
    /// the Control Plane, and collaboration surface webhooks and connections, reply delivery, and
    /// operator notifications as gateway:NAME. Or enroll, revoke, and rotate the credentials of
    /// Gateways.
    #[command(args_conflicts_with_subcommands = true, subcommand_negates_reqs = true)]
    Gateway {
        #[command(subcommand)]
        command: Option<enrollments::GatewayCommand>,
        /// Address clients connect to. Port 0 picks a free port. Outside loopback it requires TLS.
        #[arg(long, default_value = "127.0.0.1:0")]
        listen: SocketAddr,
        /// Serve on this inherited listening socket instead of binding --listen. `supertag up`
        /// binds the local Gateway's port itself and hands it over, so the port is never free
        /// between choosing it and serving on it.
        #[arg(long, hide = true, conflicts_with = "listen")]
        listen_fd: Option<std::os::fd::RawFd>,
        /// Also accept gRPC carried in a WebSocket on this address, for hosts that only
        /// forward HTTP/1.1. This service's TLS runs inside the tunnel. Its bound address
        /// is reported after the gRPC address.
        #[arg(long)]
        websocket_listen: Option<SocketAddr>,
        /// Control Plane URL this Gateway connects to.
        #[arg(long, required = true)]
        control_plane: Option<String>,
        /// Private directory holding the credential from `supertag gateway enroll`. Without it
        /// the Gateway reads SUPERTAG_GATEWAY_CREDENTIAL.
        #[arg(long)]
        state_directory: Option<PathBuf>,
        /// Address for Slack HTTP event webhooks. Requires the Slack state directory.
        #[arg(
            long,
            requires = "slack_state_directory",
            conflicts_with = "slack_socket_mode"
        )]
        slack_listen: Option<SocketAddr>,
        /// Receive Slack events over an outbound Socket Mode connection instead of webhooks.
        /// Requires the Slack state directory and SUPERTAG_SLACK_APP_TOKEN or a vault appToken.
        #[arg(long, requires = "slack_state_directory")]
        slack_socket_mode: bool,
        /// Private directory for Slack connector state and reply receipts. Requires
        /// --slack-listen or --slack-socket-mode.
        #[arg(long)]
        slack_state_directory: Option<PathBuf>,
        /// Address for GitHub webhooks. Requires the GitHub state directory.
        #[arg(long, requires = "github_state_directory")]
        github_listen: Option<SocketAddr>,
        /// Private directory for GitHub connector state and reply receipts.
        #[arg(long, requires = "github_listen")]
        github_state_directory: Option<PathBuf>,
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
        /// Tell the operator about Inbox items here: webhook:HTTPS_URL[#SECRET_NAME],
        /// slack:CHANNEL_OR_USER_ID, or slack:WORKSPACE_ID/CHANNEL_OR_USER_ID. Repeatable.
        #[arg(
            long,
            long_help = "Tell the operator about Inbox items here: webhook:HTTPS_URL[#SECRET_NAME], slack:CHANNEL_OR_USER_ID, or slack:WORKSPACE_ID/CHANNEL_OR_USER_ID. Repeatable. A webhook's SECRET_NAME is read from SUPERTAG_NOTIFY_SECRET_<NAME> (uppercase, - as _) and sent as a bearer token. Slack destinations post with this Gateway's Slack connector or, without one, as the Slack workspace in SUPERTAG_NOTIFY_SLACK_TEAM_ID, whose bot token is read from SUPERTAG_NOTIFY_SLACK_BOT_TOKEN or the credential vault entry SUPERTAG_NOTIFY_SLACK_CREDENTIAL_ID."
        )]
        notify: Vec<String>,
    },
    /// Run this Worker Host's Worklet, which connects the host and runs accepted Tasks.
    ///
    /// The Worklet registers the host, claims Tasks, and runs each Task Attempt in a Worker
    /// process of its own, which runs the harness adapter.
    Worklet(Box<worker_host::WorkerHostArgs>),
    /// One Task Attempt, run by the Worklet that starts it.
    #[command(name = "__worker", hide = true)]
    Worker(Box<worker_host::WorkerHostArgs>),
    /// Revoke client devices and rotate their credentials.
    Client {
        #[command(subcommand)]
        command: enrollments::ClientCommand,
    },
    /// Create and revoke Auth Keys that enroll Worker Hosts, Gateways, and clients.
    AuthKey {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: auth_keys::AuthKeyCommand,
    },
    /// Save a Gateway under a name for `--gateway NAME`. Reads one secret from
    /// SUPERTAG_OPERATOR_TOKEN, or from standard input when that is not set, with a masked prompt
    /// in a terminal: an operator token is checked and saved; a client Auth Key (stak_...) enrolls
    /// this device as client:NAME and saves only the resulting credential.
    Connect {
        /// The Gateway origin, such as https://supertag.example.com, or its wss:// tunnel URL.
        url: String,
        /// The name to save it under.
        #[arg(long)]
        name: String,
        /// The client name this device enrolls as with an Auth Key. Defaults to its host name.
        #[arg(long)]
        client_name: Option<String>,
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
    /// Forget a Gateway saved with `supertag connect`: remove it and its credential from this
    /// device. Its enrolled client stays until an operator revokes it. A Gateway saved in the
    /// desktop app is removed there.
    Disconnect {
        /// The name the Gateway is saved under.
        name: String,
    },
    #[command(name = "__codex-adapter", hide = true)]
    CodexAdapter(CodexAdapterArgs),
    /// Codex's executor program on a remote Workspace: carries stdin and stdout to the Attempt's
    /// exec-server socket.
    #[command(name = "__codex-exec-bridge", hide = true)]
    CodexExecBridge {
        #[arg(long)]
        socket: PathBuf,
    },
    /// The local Gateway and its current operator token, as JSON for the desktop app.
    #[command(name = "__local-gateway", hide = true)]
    LocalGateway,
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
    /// Register a Volume whose files Tasks receive as Workspace copies.
    WorkspaceVolume {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: workspace_mounts::VolumeCommand,
    },
    /// Close a Work Session so it no longer counts toward its Tag's limit.
    Session {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: work_sessions::SessionCommand,
    },
    /// Wake a Tag later in your conversation with it, or pause and resume a Schedule.
    Schedule {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: schedules::ScheduleCommand,
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
    /// Read an operational snapshot: resource and Task counts, usage, Worker Host capacity,
    /// Mailbox and reply backlogs, and how Tags' memory is used on this machine's Worker Hosts.
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
    let result = match cli.command {
        // Plain `supertag` opens the terminal UI in a terminal; otherwise it prints the help.
        None => tui::bare(cli.gateway, || {
            let _ = <Cli as clap::CommandFactory>::command().print_help();
        }),
        Some(Command::Tui {
            gateway,
            state_directory,
            binary,
        }) => tui::launch(tui::Launch {
            gateway: gateway.or(cli.gateway),
            state_directory,
            binary,
        }),
        Some(command) => dispatch(cli.gateway, command).map(|()| std::process::ExitCode::SUCCESS),
    };
    match result {
        Ok(code) => code,
        Err(error) => {
            // Errors carry text from services, surfaces and files; filter it for the terminal.
            errln!("Error: {}", error_text(&error));
            std::process::ExitCode::FAILURE
        }
    }
}

/// An error as `{:?}` prints it, except that a gRPC status from a service shows only its
/// message: "code: 'The system is not in a state…', message: …" tells a person nothing more.
fn error_text(error: &anyhow::Error) -> String {
    let causes: Vec<String> = error
        .chain()
        .map(|cause| match cause.downcast_ref::<tonic::Status>() {
            Some(status) if !status.message().is_empty() => status.message().to_owned(),
            _ => cause.to_string(),
        })
        .collect();
    let mut text = causes[0].clone();
    match &causes[1..] {
        [] => {}
        [cause] => text.push_str(&format!("\n\nCaused by:\n    {cause}")),
        causes => {
            text.push_str("\n\nCaused by:");
            for (index, cause) in causes.iter().enumerate() {
                text.push_str(&format!("\n    {index}: {cause}"));
            }
        }
    }
    text
}

/// Help and version text is the CLI's own. A usage error can repeat what was typed, so it is
/// reported for the arguments with their controls replaced: a typed line break cannot add a
/// fake line, and an escape sequence prints as visible text.
fn usage_error(error: clap::Error) -> ! {
    use clap::error::ErrorKind;
    if matches!(
        error.kind(),
        ErrorKind::DisplayHelp
            | ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand
            | ErrorKind::DisplayVersion
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

fn dispatch(gateway: Option<String>, command: Command) -> Result<()> {
    if let Some(gateway) = gateway {
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
                    | Command::Gateway {
                        command: None | Some(enrollments::GatewayCommand::Enroll { .. }),
                        ..
                    }
                    | Command::Worklet(_)
                    | Command::Worker(_)
                    | Command::Host {
                        command: host_status::HostCommand::Enroll { .. },
                        ..
                    }
                    | Command::Test { .. }
                    | Command::CodexAdapter(_)
                    | Command::CodexExecBridge { .. }
                    | Command::AdapterGuardian { .. }
                    | Command::LocalGateway
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
        Command::LocalGateway => local_gateway::print_local_gateway(),
        Command::CodexAdapter(args) => tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(harness::run_codex(args)),
        Command::CodexExecBridge { socket } => supertag_worker_host::run_codex_exec_bridge(&socket),
        // A Worklet runs its pool's slots, and a Worker its Attempt, as tasks on the runtime's
        // threads, whose large futures need more than the default stack in debug builds.
        command => tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_stack_size(16 * 1024 * 1024)
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
        Command::Client { command } => enrollments::run_client(command).await?,
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
        Command::Workspace {
            connection,
            command,
        } => remote_workspaces::run(connection, command).await?,
        Command::Team {
            connection,
            command,
        } => teams::run(connection, command).await?,
        Command::Init(args) => init::init(args).await?,
        Command::SignIn(args) => harness_checks::sign_in(args).await?,
        Command::Down(args) => lifecycle::down(args).await?,
        Command::Logs(args) => lifecycle::logs(args).await?,
        Command::Ps(args) => lifecycle::ps(args).await?,
        Command::Message(args) => conversation_message::run(args).await?,
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
            control_plane_listen,
        } => {
            let state_directory = local_config::state_directory(state_directory)?;
            let config = local_config::load(file, &state_directory)?;
            let args: Vec<OsString> = std::env::args_os().skip(1).collect();
            if config.is_none() {
                ensure!(
                    adapter.is_selected(),
                    "{} Or name a local services file with --file, or a harness with --harness.",
                    supertag_local_state::not_set_up(&state_directory)
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
                        && control_plane_listen == "127.0.0.1:0".parse::<SocketAddr>()?,
                    "configure adapters and listeners in the services file when using local configuration"
                );
                local::configured(config, state_directory, termination_signal()).await?;
            } else {
                local::up(
                    local::LocalOptions {
                        state_directory,
                        adapter,
                        skill_catalog,
                        control_plane_listen,
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
            removed_artifact_volumes,
            removed_artifact_s3_volumes,
            git_delivery_directory,
            audit_log,
        } => {
            if !removed_artifact_volumes.is_empty() {
                anyhow::bail!(
                    "--artifact-volume is removed: the Control Plane maps no Volume. Map a file Volume on each Worker Host that writes it with `supertag worklet --volume ID=DIR` (or `volumes:` on its host service)"
                );
            }
            if removed_artifact_s3_volumes.is_some() {
                anyhow::bail!(
                    "--artifact-s3-volumes is removed: store each S3 Volume's credential with `supertag volume credential set ID --endpoint URL --region REGION` on the Control Plane's machine"
                );
            }
            control_plane(
                listen,
                websocket_listen,
                ControlPlaneOptions {
                    git_delivery: git_delivery_directory,
                    audit_log,
                },
            )
            .await?
        }
        Command::Gateway {
            command: Some(command),
            ..
        } => enrollments::run_gateway(command).await?,
        Command::Gateway {
            command: None,
            listen,
            listen_fd,
            websocket_listen,
            control_plane,
            state_directory,
            slack_listen,
            slack_socket_mode,
            slack_state_directory,
            github_listen,
            github_state_directory,
            linear_listen,
            linear_state_directory,
            lark_state_directory,
            microsoft_teams_listen,
            microsoft_teams_state_directory,
            notify,
        } => {
            let listen = match listen_fd {
                Some(fd) => GatewayListen::Inherited(inherited_listener(fd)?),
                None => GatewayListen::Bind(listen),
            };
            gateway(
                listen,
                websocket_listen,
                control_plane.context("pass --control-plane URL")?,
                state_directory,
                GatewayConnectors {
                    slack: match (slack_listen, slack_socket_mode, slack_state_directory) {
                        (Some(address), false, Some(directory)) => {
                            Some((SlackIngress::Http(address), directory))
                        }
                        (None, true, Some(directory)) => Some((SlackIngress::Socket, directory)),
                        (None, false, None) => None,
                        _ => anyhow::bail!(
                            "--slack-state-directory requires --slack-listen or --slack-socket-mode"
                        ),
                    },
                    github: github_listen.zip(github_state_directory),
                    linear: linear_listen.zip(linear_state_directory),
                    lark: lark_state_directory,
                    microsoft_teams: microsoft_teams_listen.zip(microsoft_teams_state_directory),
                    notify,
                },
            )
            .await?
        }
        Command::Worklet(args) => worker_host::run_worklet(*args).await?,
        Command::Worker(args) => worker_host::run_worker(*args).await?,
        Command::AuthKey {
            connection,
            command,
        } => auth_keys::run(connection, command).await?,
        Command::Connect {
            url,
            name,
            client_name,
            replace,
            server_ca_file,
            client_cert_file,
            client_key_file,
        } => {
            connect_control_plane(
                profiles::NewGateway {
                    name,
                    url,
                    token: String::new(),
                    server_ca_file,
                    client_cert_file,
                    client_key_file,
                },
                client_name,
                replace,
            )
            .await?;
        }
        Command::Disconnect { name } => {
            let (store, removed) = profiles::remove(&name)?;
            ensure!(
                removed,
                "no Gateway is saved under {name:?} with supertag connect; a Gateway saved in the desktop app is removed there"
            );
            crate::terminal::print_json(&json!({
                "name": name,
                "removed_from": store.display().to_string(),
            }))?;
        }
        Command::AdapterGuardian { .. } => unreachable!("guardian runs outside Tokio"),
        Command::LocalGateway => unreachable!("local discovery runs outside Tokio"),
        Command::Tui { .. } => unreachable!("the terminal UI replaces this process before Tokio"),
        Command::CodexAdapter(_) => unreachable!("Codex adapter uses a dedicated runtime"),
        Command::CodexExecBridge { .. } => unreachable!("the Codex bridge runs outside Tokio"),
        Command::Tag {
            connection,
            command,
        } => tags::run(connection, command).await?,
        Command::Task {
            connection,
            command,
        } => tasks::run(connection, command).await?,
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
        Command::Input {
            connection,
            command,
        } => inputs::run(connection, command).await?,
        Command::Schedule {
            connection,
            command,
        } => schedules::run(connection, command).await?,
        Command::Session {
            connection,
            command,
        } => work_sessions::run(connection, command).await?,
        Command::Objective {
            connection,
            command,
        } => objectives::run(connection, command).await?,
    }
    Ok(())
}

/// What the Control Plane serves beyond its listeners.
struct ControlPlaneOptions {
    git_delivery: Option<PathBuf>,
    /// `--audit-log`: also write each committed audit entry to `stderr` or this file.
    audit_log: Option<String>,
}

/// Runs the Control Plane: the state owner and its controllers, and in front of them the public
/// API tier that operator clients, Worker Hosts, and Gateways call. The API tier reaches the state
/// owner over an in-process connection, so only the public listener has a network address.
async fn control_plane(
    listen: SocketAddr,
    websocket: Option<SocketAddr>,
    options: ControlPlaneOptions,
) -> Result<()> {
    let builder = network::server(listen, websocket).await?;
    // The API tier's credential for the state owner, which has no network listener. It is new for
    // every process and never configured.
    let service_token = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
    let operator_principal =
        std::env::var("SUPERTAG_OPERATOR_PRINCIPAL").unwrap_or_else(|_| "operator:local".into());
    let mut plane = ControlPlane::open(
        &required_env("SUPERTAG_DATABASE_URL")?,
        service_token.clone(),
        operator_principal.clone(),
    )
    .await?;
    if let Some((from, to)) = plane.schema_migration() {
        // `supertag up` repeats this line after it starts or upgrades the local services.
        errln!("{} {from} to {to}.", lifecycle::MIGRATED);
    }
    if let Some(audit_log) = &options.audit_log {
        plane = plane.with_audit_sink(supertag_control_plane::AuditSink::parse(audit_log)?);
    }
    // `time-zone` in supertag.yaml reaches the Control Plane as SUPERTAG_TIME_ZONE; refuse a zone
    // it does not know rather than reading Schedules in UTC.
    if let Some(zone) = nonempty_env("SUPERTAG_TIME_ZONE") {
        plane = plane
            .with_time_zone(&zone)
            .map_err(|_| anyhow::anyhow!("SUPERTAG_TIME_ZONE {zone:?} is not an IANA time zone"))?;
    }
    // Tests move the Control Plane's clock forward by the milliseconds this file holds, so a
    // Schedule falls due without waiting.
    #[cfg(feature = "test-fixtures")]
    if let Some(path) = std::env::var_os("SUPERTAG_TEST_CLOCK_OFFSET_FILE") {
        let path = std::path::PathBuf::from(path);
        plane = plane.with_execution_clock(move || {
            let offset = std::fs::read_to_string(&path)
                .ok()
                .and_then(|value| value.trim().parse::<i64>().ok())
                .unwrap_or(0);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_millis() as i64);
            now.saturating_add(offset)
        });
    }
    // The deployment's default thread for Objective notices (TypeScript parity). It is shared
    // by every replica, so a replica started with another value says what it replaced.
    let default_notice_task = nonempty_env("SUPERTAG_OPERATOR_NOTIFICATION_TASK_ID");
    let replaced = plane
        .set_default_notification_task(default_notice_task.as_deref())
        .await?;
    if replaced != default_notice_task {
        errln!(
            "{}",
            notice_default_change(replaced.as_deref(), default_notice_task.as_deref())
        );
    }
    // A single-machine deployment's own Worker Host and Gateway start enrolled.
    for (variable, role) in [
        (
            "SUPERTAG_BOOTSTRAP_HOST_TOKEN",
            supertag_control_plane::Role::Host,
        ),
        (
            "SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL",
            supertag_control_plane::Role::Gateway,
        ),
    ] {
        if let Ok(token) = std::env::var(variable) {
            ensure!(
                supertag_protocol::is_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX, &token),
                "{variable} must be stcr_ and 64 hex digits"
            );
            plane
                .seed_enrollment(role, "local", &Sha256::digest(token.as_bytes()))
                .await?;
        }
    }
    let (connector, incoming) = supertag_api::in_process::pair();
    let owner_shutdown = CancellationToken::new();
    let mut owner = tokio::spawn(state_owner(plane.clone(), incoming, owner_shutdown.clone()));
    let internal = connector.channel();
    let channel = connect(
        internal.clone(),
        ServiceRole::Gateway,
        ServiceRole::ControlPlane,
    )
    .await?;
    let mut api = Api::new(
        channel.clone(),
        service_token.clone(),
        required_env("SUPERTAG_OPERATOR_TOKEN")?,
        operator_principal,
    )?;
    // A Gateway that forwards Task Attempts' data calls here, named to each Worker Host when it
    // registers. It takes the URL forms a Worklet dials.
    if let Some(endpoint) = nonempty_env("SUPERTAG_DATA_ENDPOINT") {
        network::endpoint(endpoint.clone())
            .await
            .with_context(|| format!("SUPERTAG_DATA_ENDPOINT {endpoint:?} is not a Gateway URL"))?;
        api = api.with_data_endpoint(endpoint);
    }
    // The Control Plane signs S3 Volume object URLs with credentials from its vault; it maps no
    // Volume and carries no Volume bytes.
    // Without a state directory there is no vault, and an S3 Volume's capture fails, naming why.
    let signers = CredentialVault::from_process_environment()
        .map(supertag_api::transfers::volumes::VolumeSigners::new)
        .unwrap_or_default();
    let mut transfers = ApiTransfers::new(api.clone()).with_volume_signers(signers);
    let delivery = git_delivery(options.git_delivery)?;
    if let Some(delivery) = &delivery {
        transfers =
            transfers.with_workspace_git(std::sync::Arc::new(WorkspaceGit(delivery.clone())));
    }
    let listener = listen_on(listen).await?;
    outln!("{}", listener.local_addr()?);
    let tunnel = bind_websocket(websocket).await?;
    let maintenance = plane.clone();
    let volume_objects = transfers.clone();
    let sweep = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let garbage = VolumeGarbage(maintenance.clone());
        let mut tick = 0u64;
        loop {
            interval.tick().await;
            if let Err(error) = maintenance.maintain(Duration::from_secs(1)).await {
                errln!("Control Plane maintenance failed: {error}");
            }
            // S3 Volume objects nothing keeps go every 10 seconds; hosts delete file Volumes'.
            tick += 1;
            if tick.is_multiple_of(10)
                && let Err(error) = volume_objects.collect_volume_garbage(&garbage).await
            {
                errln!("Control Plane Volume cleanup failed: {error}");
            }
        }
    });
    let shutdown = CancellationToken::new();
    let routes = api.routes(transfers, internal, shutdown.clone()).await;
    // Refuse every call from a peer that skipped protocol negotiation, then authenticate the
    // caller and check its role against the one authorization table.
    let grpc = async {
        let result = builder
            .layer(fence(ServiceRole::ControlPlane))
            .layer(api.authorize())
            .add_routes(routes)
            .serve_with_incoming_shutdown(
                supertag_transport::incoming(listener, tunnel),
                shutdown.clone().cancelled_owned(),
            )
            .await
            .map_err(anyhow::Error::from);
        shutdown.cancel();
        result
    };
    let landing_loop = async {
        if let Some(delivery) = &delivery {
            let result = delivery
                .run_reviews(
                    channel.clone(),
                    service_token.clone(),
                    supertag_control_plane::GIT_DELIVERY_PRINCIPAL.into(),
                    shutdown.clone(),
                )
                .await;
            shutdown.cancel();
            result
        } else {
            shutdown.cancelled().await;
            Ok(())
        }
    };
    let source_loop = async {
        if let Some(delivery) = &delivery {
            let result = delivery
                .run_resolver(
                    channel.clone(),
                    service_token.clone(),
                    supertag_control_plane::GIT_DELIVERY_PRINCIPAL.into(),
                    shutdown.clone(),
                )
                .await;
            shutdown.cancel();
            result
        } else {
            shutdown.cancelled().await;
            Ok(())
        }
    };
    let services = async {
        let (grpc, landing, source) = tokio::join!(grpc, landing_loop, source_loop);
        grpc?;
        landing?;
        source
    };
    tokio::pin!(services);
    let mut owner_stopped = false;
    let result = tokio::select! {
        result = &mut services => result,
        // The API tier is useless without the state owner, so the process stops with it.
        stopped = &mut owner => {
            owner_stopped = true;
            shutdown.cancel();
            let _ = tokio::time::timeout(Duration::from_secs(15), services).await;
            Err(match stopped {
                Ok(Ok(())) => anyhow!("Control Plane state owner stopped"),
                Ok(Err(error)) => error.context("Control Plane state owner failed"),
                Err(error) => anyhow!(error).context("Control Plane state owner failed"),
            })
        }
        _ = termination_signal() => {
            shutdown.cancel();
            tokio::time::timeout(Duration::from_secs(15), services)
                .await
                .context("Control Plane shutdown timed out")
                .and_then(|result| result)
        }
    };
    owner_shutdown.cancel();
    if !owner_stopped {
        let _ = tokio::time::timeout(Duration::from_secs(5), owner).await;
    }
    sweep.abort();
    let _ = sweep.await;
    result
}

/// The state owner's queue of S3 Volume objects to delete, for the API tier that signs for them.
struct VolumeGarbage(ControlPlane);

#[tonic::async_trait]
impl supertag_api::transfers::volumes::VolumeGarbage for VolumeGarbage {
    async fn take(
        &self,
        limit: u32,
    ) -> Result<Vec<supertag_protocol::v2::ForgetVolumeGarbageRequest>> {
        self.0.take_s3_volume_garbage(limit).await
    }

    async fn forget(
        &self,
        objects: &supertag_protocol::v2::ForgetVolumeGarbageRequest,
    ) -> Result<()> {
        self.0.forget_s3_volume_garbage(objects).await
    }
}

/// Git delivery for the API tier: remote Workspace sources and checks.
struct WorkspaceGit(supertag_git_delivery::GitDelivery);

#[tonic::async_trait]
impl supertag_api::transfers::WorkspaceGit for WorkspaceGit {
    async fn grant(
        &self,
        workspace: &supertag_protocol::v2::Workspace,
        push: bool,
    ) -> Result<(
        Option<supertag_protocol::v2::workspace_git_grant::Credential>,
        i64,
    )> {
        use supertag_git_delivery::Credential;
        use supertag_protocol::v2::{
            HttpsGitCredential, SshGitCredential, workspace_git_grant::Credential as Granted,
        };
        let grant = self
            .0
            .grant(
                workspace,
                if push {
                    supertag_git_delivery::Access::Push
                } else {
                    supertag_git_delivery::Access::Read
                },
            )
            .await?;
        let credential = match grant.credential {
            None => None,
            Some(Credential::HttpsToken { username, token }) => {
                Some(Granted::Https(HttpsGitCredential { username, token }))
            }
            Some(Credential::SshKey {
                private_key,
                known_hosts,
            }) => Some(Granted::Ssh(SshGitCredential {
                private_key,
                known_hosts: known_hosts.unwrap_or_default(),
            })),
            // `grant` never hands these to a Worker Host.
            Some(Credential::Helper { .. } | Credential::GithubApp { .. }) => {
                anyhow::bail!("this Workspace Credential cannot be granted to a Worker Host")
            }
        };
        Ok((credential, grant.expires_at_ms))
    }

    async fn advertised_output_remote(
        &self,
        workspace: &supertag_protocol::v2::Workspace,
        commit: &str,
        cancel: &CancellationToken,
    ) -> Result<Option<String>> {
        self.0
            .advertised_output_remote(workspace, commit, cancel)
            .await
    }

    async fn check(
        &self,
        workspace: &supertag_protocol::v2::Workspace,
        cancel: &CancellationToken,
    ) -> Result<supertag_protocol::v2::WorkspaceCheck> {
        self.0.check(workspace, cancel).await
    }
}

/// Git delivery in `directory`, else in the state directory the credential vault uses. Without
/// either, the Control Plane serves no remote Workspace.
fn git_delivery(directory: Option<PathBuf>) -> Result<Option<supertag_git_delivery::GitDelivery>> {
    let directory = match directory {
        Some(directory) => directory,
        None => match nonempty_env("SUPERTAG_STATE_DIR")
            .map(PathBuf::from)
            .or_else(|| nonempty_env("HOME").map(|home| PathBuf::from(home).join(".supertag")))
        {
            Some(state) => state.join("git-delivery"),
            None => return Ok(None),
        },
    };
    let vault = supertag_credential_vault::CredentialVault::from_process_environment()?;
    Ok(Some(supertag_git_delivery::GitDelivery::new(
        &directory,
        supertag_git_delivery::Credentials::new(vault),
    )?))
}

/// Serves the state owner to the API tier until `shutdown`.
async fn state_owner(
    plane: ControlPlane,
    incoming: supertag_api::in_process::Incoming,
    shutdown: CancellationToken,
) -> Result<()> {
    plane.close_follows_on(shutdown.clone());
    // Refuse every call from a peer that skipped protocol negotiation.
    let mut builder = tonic::transport::Server::builder()
        .layer(fence(ServiceRole::ControlPlane))
        .layer(plane.audit_layer());
    builder
        .add_service(plane.operator_access_service())
        .add_service(plane.credential_directory_service())
        .add_service(plane.enrollments_service())
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
        .add_service(plane.workspaces_service())
        .add_service(plane.workspace_credentials_service())
        .add_service(plane.workspace_landings_service())
        .add_service(plane.git_delivery_service())
        .add_service(plane.host_landings_service())
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
        .add_service(plane.attempt_tag_sessions_service())
        .add_service(plane.schedules_service())
        .add_service(plane.attempt_schedules_service())
        .add_service(plane.memories_service())
        .add_service(plane.network_logs_service())
        .add_service(plane.task_files_service())
        .add_service(plane.attempt_task_files_service())
        .add_service(plane.attempt_memory_service())
        .add_service(plane.attempt_mcp_effects_service())
        .add_service(plane.attempt_changed_paths_service())
        .add_service(plane.attempt_effects_service())
        .add_service(plane.spend_service())
        .add_service(plane.metrics_service())
        .add_service(plane.objective_overview_service())
        .add_service(plane.operator_events_service(shutdown.clone()))
        .add_service(
            ObjectivesServer::new(plane)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
        )
        .serve_with_incoming_shutdown(incoming, shutdown.cancelled_owned())
        .await?;
    Ok(())
}

/// Binds the optional WebSocket tunnel listener and reports its address.
/// A listener on `address`; the error names it, so `supertag up` can say which port is taken.
async fn listen_on(address: SocketAddr) -> Result<TcpListener> {
    // One message, not a context: the supervisor reports only a service's first line.
    TcpListener::bind(address)
        .await
        .map_err(|error| anyhow::anyhow!("could not listen on {address}: {error}"))
}

/// Where a Gateway serves: an address it binds, or a listener `supertag up` bound and handed over.
enum GatewayListen {
    Bind(SocketAddr),
    Inherited(std::net::TcpListener),
}

/// Takes the listening socket a supervisor handed this process as descriptor `fd`.
fn inherited_listener(fd: std::os::fd::RawFd) -> Result<std::net::TcpListener> {
    use std::os::fd::FromRawFd as _;
    ensure!(fd > 2, "--listen-fd {fd} names a standard stream");
    // SAFETY: fstat only writes the buffer it is given; an unopened descriptor fails.
    let mut status: libc::stat = unsafe { std::mem::zeroed() };
    ensure!(
        unsafe { libc::fstat(fd, &mut status) } == 0
            && status.st_mode & libc::S_IFMT == libc::S_IFSOCK,
        "--listen-fd {fd} is not an open socket"
    );
    // SAFETY: the descriptor is open, a socket, and handed to this process alone; nothing else
    // in it owns the descriptor, which the listener now closes.
    let listener = unsafe { std::net::TcpListener::from_raw_fd(fd) };
    listener
        .local_addr()
        .with_context(|| format!("--listen-fd {fd} is not a TCP listener"))?;
    // Child processes of this Gateway must not inherit it in turn.
    // SAFETY: F_SETFD on a descriptor this process owns changes only its flags.
    ensure!(
        unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } == 0,
        "mark --listen-fd {fd} close-on-exec: {}",
        std::io::Error::last_os_error()
    );
    listener.set_nonblocking(true)?;
    Ok(listener)
}

async fn bind_websocket(address: Option<SocketAddr>) -> Result<Option<TcpListener>> {
    let Some(address) = address else {
        return Ok(None);
    };
    let listener = listen_on(address).await?;
    outln!("{}", listener.local_addr()?);
    Ok(Some(listener))
}

/// How the Gateway's Slack connector receives events.
enum SlackIngress {
    Http(SocketAddr),
    Socket,
}

struct GatewayConnectors {
    slack: Option<(SlackIngress, PathBuf)>,
    github: Option<(SocketAddr, PathBuf)>,
    linear: Option<(SocketAddr, PathBuf)>,
    lark: Option<PathBuf>,
    microsoft_teams: Option<(SocketAddr, PathBuf)>,
    notify: Vec<String>,
}

/// Runs a Gateway: surface ingress, delivery, and operator notifications, as a client of the
/// Control Plane at `control_plane`. Its own listener serves only the test notification.
/// Connections a Gateway keeps to the Control Plane for client calls, so one connection's
/// concurrent stream limit cannot cap how many clients follow conversations at once.
const CLIENT_CONNECTIONS: usize = 8;

async fn gateway(
    listen: GatewayListen,
    websocket: Option<SocketAddr>,
    control_plane: String,
    credential_directory: Option<PathBuf>,
    connectors: GatewayConnectors,
) -> Result<()> {
    let control_plane_target = network::endpoint(control_plane).await?;
    // Refuse an incompatible Control Plane before accepting any public traffic,
    // and name the selected version on every call to it. Client calls use their own
    // connections, so they never share this Gateway's credentialed calls' channel.
    let mut channels = Vec::with_capacity(CLIENT_CONNECTIONS + 1);
    for _ in 0..=CLIENT_CONNECTIONS {
        let channel = control_plane_target.connect().await?;
        channels.push(
            connect(channel, ServiceRole::Gateway, ServiceRole::ControlPlane)
                .await
                .map_err(|error| error.at(control_plane_target.url()))?,
        );
    }
    let channel = channels.pop().expect("a Control Plane channel");
    let client_api = supertag_gateway::client_api::ClientApi::new(channels);
    #[cfg(feature = "test-fixtures")]
    let client_api = if std::env::var_os("SUPERTAG_TEST_GATEWAY_FORWARD_EVERY_CALL").is_some() {
        client_api.forwarding_every_call()
    } else {
        client_api
    };
    // Refuse every call from a peer that skipped protocol negotiation, then forward client calls
    // and Task Attempts' data calls to the Control Plane, which authorizes each as its caller.
    let address = match &listen {
        GatewayListen::Bind(address) => *address,
        GatewayListen::Inherited(listener) => listener.local_addr()?,
    };
    let mut builder = network::server(address, websocket)
        .await?
        .layer(fence(ServiceRole::Gateway))
        .layer(client_api);
    let gateway_token = gateway_credential(&control_plane_target, credential_directory)?;
    let slack = match connectors.slack {
        Some((ingress, state_directory)) => {
            if let SlackIngress::Http(address) = &ingress {
                ensure!(
                    address.ip().is_loopback(),
                    "Slack webhook listener must use loopback"
                );
            }
            let connector = slack_connector(
                channel.clone(),
                gateway_token.clone(),
                state_directory,
                matches!(ingress, SlackIngress::Socket),
            )
            .await?;
            let listener = match ingress {
                SlackIngress::Http(address) => Some(listen_on(address).await?),
                SlackIngress::Socket => None,
            };
            Some((connector, listener))
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
            Some((connector, listen_on(address).await?))
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
            Some((connector, listen_on(address).await?))
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
            Some((connector, listen_on(address).await?))
        }
        None => None,
    };
    let lark = match connectors.lark {
        Some(directory) => {
            Some(lark_connector(channel.clone(), gateway_token.clone(), directory).await?)
        }
        None => None,
    };
    let slack_sender = match slack.as_ref() {
        Some((slack, _)) => Some(slack.operator_sender()),
        None => notification_slack_sender().await?,
    };
    let notifier = operator_notifier(
        &connectors.notify,
        slack_sender,
        channel.clone(),
        gateway_token,
    )?;
    let auth = supertag_gateway::operator_auth::OperatorAuth::new(channel);
    let (health, health_service) = tonic_health::server::health_reporter();
    health
        .set_serving::<supertag_protocol::v2::operator_notification_test_server::OperatorNotificationTestServer<supertag_gateway::notifications::TestNotifications>>()
        .await;
    let listener = match listen {
        GatewayListen::Bind(address) => listen_on(address).await?,
        GatewayListen::Inherited(listener) => TcpListener::from_std(listener)?,
    };
    outln!("{}", listener.local_addr()?);
    let tunnel = bind_websocket(websocket).await?;
    if let Some((_, Some(listener))) = &slack {
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
        // Clients, and Worker Hosts' Workers sending a Task Attempt's data calls.
        .add_service(
            Negotiator::new(
                ServiceRole::Gateway,
                &[ServiceRole::Client, ServiceRole::WorkerHost],
            )
            .service(),
        )
        .add_service(notifier.test_service(auth));
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
            let result = match listener {
                Some(listener) => slack.serve(listener, shutdown.clone()).await,
                None => slack.connect(shutdown.clone()).await,
            };
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
    let notification_loop = notifier.run(shutdown.clone());
    let services = async {
        let (grpc, slack, github, linear, lark, teams, notifications) = tokio::join!(
            grpc,
            webhook,
            github_webhook,
            linear_webhook,
            lark_connection,
            microsoft_teams_webhook,
            notification_loop,
        );
        grpc?;
        slack?;
        github?;
        linear?;
        lark?;
        teams?;
        notifications
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

/// The Gateway's enrolled credential: from its `--state-directory`, or from
/// SUPERTAG_GATEWAY_CREDENTIAL for a Gateway whose credential comes from its own secret manager.
fn gateway_credential(
    control_plane: &supertag_transport::Target,
    directory: Option<PathBuf>,
) -> Result<String> {
    let token = match directory {
        Some(directory) => {
            supertag_worker_host::credential(
                &directory,
                control_plane,
                supertag_worker_host::EnrolledRole::Gateway,
            )?
            .1
        }
        None => required_env("SUPERTAG_GATEWAY_CREDENTIAL").context(
            "enroll the Gateway with supertag gateway enroll and pass --state-directory, or set SUPERTAG_GATEWAY_CREDENTIAL",
        )?,
    };
    ensure!(
        supertag_protocol::is_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX, &token),
        "the Gateway credential must be stcr_ and 64 hex digits"
    );
    Ok(token)
}

/// The `--notify` destinations and their senders. Webhook secrets come from
/// `SUPERTAG_NOTIFY_SECRET_<NAME>`, with the name uppercased and `-` written as `_`.
fn operator_notifier(
    values: &[String],
    slack: Option<supertag_gateway::notifications::SlackSender>,
    channel: ProtocolChannel,
    gateway_token: String,
) -> Result<supertag_gateway::notifications::OperatorNotifier> {
    use supertag_gateway::notifications::{OperatorNotifier, Senders, parse_destinations};
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
        Senders::new(slack, secrets)?,
        channel,
        gateway_token,
    )
}

/// The Slack Surface Account a Gateway without a Slack connector posts `slack:` notify
/// destinations as: `SUPERTAG_NOTIFY_SLACK_TEAM_ID`, with its bot token from
/// `SUPERTAG_NOTIFY_SLACK_BOT_TOKEN` or the credential vault entry
/// `SUPERTAG_NOTIFY_SLACK_CREDENTIAL_ID`.
async fn notification_slack_sender() -> Result<Option<supertag_gateway::notifications::SlackSender>>
{
    let Some(team_id) = nonempty_env("SUPERTAG_NOTIFY_SLACK_TEAM_ID") else {
        return Ok(None);
    };
    let bot_token = SurfaceSecrets::new("Slack", "SUPERTAG_NOTIFY_SLACK", "slack", &team_id)
        .get("SUPERTAG_NOTIFY_SLACK_BOT_TOKEN", "botToken")
        .await?;
    let sender = supertag_gateway::notifications::SlackSender::new(bot_token, team_id)?;
    #[cfg(feature = "test-fixtures")]
    if let Ok(url) = std::env::var("SUPERTAG_TEST_SLACK_API_URL") {
        return Ok(Some(sender.with_test_url(&url)?));
    }
    Ok(Some(sender))
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
    vault: Option<Option<supertag_credential_vault::CredentialValue>>,
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

/// What a Control Plane says when its `SUPERTAG_OPERATOR_NOTIFICATION_TASK_ID` replaced the default
/// Objective notice Task that every replica shares.
fn notice_default_change(replaced: Option<&str>, set: Option<&str>) -> String {
    let set = match set {
        Some(task) => format!("is now Task {task}"),
        None => "is now unset".into(),
    };
    match replaced {
        Some(task) => format!(
            "The default Objective notice Task {set}; it was Task {task}. Every Control Plane replica shares it, so start each with the same SUPERTAG_OPERATOR_NOTIFICATION_TASK_ID."
        ),
        None => format!("The default Objective notice Task {set}."),
    }
}

fn nonempty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

/// The Slack event secret (the signing secret for HTTP events, the app-level token for Socket
/// Mode) and bot token come from the environment when both are set, and otherwise from the
/// credential vault.
async fn slack_secrets(account_id: &str, socket_mode: bool) -> Result<(SlackEvents, String)> {
    let (variable, field) = if socket_mode {
        ("SUPERTAG_SLACK_APP_TOKEN", "appToken")
    } else {
        ("SUPERTAG_SLACK_SIGNING_SECRET", "signingSecret")
    };
    let events = |secret: String| {
        if socket_mode {
            SlackEvents::Socket { app_token: secret }
        } else {
            SlackEvents::Http {
                signing_secret: secret,
            }
        }
    };
    match (
        nonempty_env(variable),
        nonempty_env("SUPERTAG_SLACK_BOT_TOKEN"),
    ) {
        (Some(secret), Some(bot)) => return Ok((events(secret), bot)),
        (None, None) => {}
        _ => anyhow::bail!(
            "set both {variable} and SUPERTAG_SLACK_BOT_TOKEN, or neither to use the credential vault"
        ),
    }
    let mut secrets = SurfaceSecrets::new("Slack", "SUPERTAG_SLACK", "slack", account_id);
    Ok((
        events(secrets.get(variable, field).await?),
        secrets.get("SUPERTAG_SLACK_BOT_TOKEN", "botToken").await?,
    ))
}

async fn slack_connector(
    channel: ProtocolChannel,
    gateway_token: String,
    state_directory: PathBuf,
    socket_mode: bool,
) -> Result<Slack> {
    let account_id = required_env("SUPERTAG_SLACK_ACCOUNT_ID")?;
    let (events, bot_token) = slack_secrets(&account_id, socket_mode).await?;
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
            events,
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

/// Connects to the Control Plane as an operator client. It refuses every
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
#[derive(Clone)]
struct OperatorTarget {
    url: String,
    token: String,
    /// Present for a saved Control Plane; otherwise TLS comes from the environment.
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

/// Selects the Gateway for an operator command when no flag names one.
const GATEWAY_ENV: &str = "SUPERTAG_GATEWAY_URL";

/// The Gateway `SUPERTAG_GATEWAY_URL` selects; empty selects none.
pub(crate) fn environment_gateway() -> Option<String> {
    std::env::var(GATEWAY_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

/// The local Gateway that `supertag up` runs from `directory`.
fn local_target(directory: &Path) -> Result<OperatorTarget> {
    let (url, token) = local::gateway_connection(directory).with_context(|| {
        if supertag_local_state::set_up(directory) {
            format!(
                "no local Gateway is running from {}; start one with supertag up, or pass --gateway",
                directory.display()
            )
        } else {
            format!(
                "{} Or pass --gateway to use a shared Gateway.",
                supertag_local_state::not_set_up(directory)
            )
        }
    })?;
    Ok(OperatorTarget {
        url,
        token,
        tls: None,
    })
}

/// The Gateway an operator command talks to: `--gateway` (before or after the
/// command name), else `--state-directory`, else `SUPERTAG_GATEWAY_URL`, else the local
/// services `supertag up` runs from `SUPERTAG_STATE_DIR` or `~/.supertag`.
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
        return local_target(&local_config::state_directory(Some(directory))?);
    }
    let gateway = match gateway.or_else(environment_gateway) {
        Some(gateway) => gateway,
        None => return local_target(&local_config::state_directory(None)?),
    };
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

/// The local services' state directory when `connection` reaches the local Gateway, as
/// [`resolve_target`] decides; `None` for any other Gateway.
fn local_state_of(connection: &Connection) -> Result<Option<PathBuf>> {
    if let Some(directory) = &connection.state_directory {
        return Ok(Some(local_config::state_directory(Some(
            directory.clone(),
        ))?));
    }
    if connection.gateway.is_some()
        || ROOT_GATEWAY.get().is_some()
        || environment_gateway().is_some()
    {
        return Ok(None);
    }
    Ok(Some(local_config::state_directory(None)?))
}

/// Reads one secret and saves the Control Plane by name. An operator token is proven against the
/// Control Plane and saved; a client Auth Key enrolls this device and only the enrolled credential
/// is saved.
async fn connect_control_plane(
    mut saved: profiles::NewGateway,
    client_name: Option<String>,
    replace: bool,
) -> Result<()> {
    saved.token = match std::env::var("SUPERTAG_OPERATOR_TOKEN") {
        Ok(token) => token,
        Err(_) => read_operator_token()?,
    }
    .trim()
    .to_owned();
    ensure!(
        !saved.token.is_empty(),
        "the operator token or Auth Key must not be empty"
    );
    let auth_key =
        supertag_protocol::is_secret(supertag_protocol::AUTH_KEY_SECRET_PREFIX, &saved.token);
    ensure!(
        auth_key || client_name.is_none(),
        "--client-name applies only when connecting with a client Auth Key"
    );
    // The token goes only to the origin that would be saved.
    saved.url = profiles::checked_origin(&saved)?;
    let target = OperatorTarget {
        url: saved.url.clone(),
        token: saved.token.clone(),
        tls: Some(network::TlsFiles {
            server_ca: saved.server_ca_file.clone(),
            client_cert: saved.client_cert_file.clone(),
            client_key: saved.client_key_file.clone(),
        }),
    };
    let channel = network::operator_channel(&target.endpoint(Duration::from_secs(15)).await?)
        .await
        .with_context(|| format!("could not reach the Gateway at {}", saved.url))?;
    if auth_key {
        let name = match client_name {
            Some(name) => name,
            None => enrollments::device_name()?,
        };
        let (credential, _) =
            enrollments::enroll_client(channel.clone(), &saved.token, &name).await?;
        // The Auth Key is used once and never saved.
        saved.token = credential;
    }
    let caller = supertag_protocol::v2::enrollments_client::EnrollmentsClient::new(channel)
        .who_am_i(request(
            supertag_protocol::v2::WhoAmIRequest {},
            &saved.token,
        )?)
        .await
        .context("the Gateway refused the credential")?
        .into_inner();
    ensure!(
        matches!(
            caller.principal.split_once(':'),
            Some(("operator" | "client", _))
        ),
        "connect with an operator token or a client Auth Key, not a {} credential",
        caller
            .principal
            .split_once(':')
            .map_or("", |(role, _)| role)
    );
    let store = profiles::save(&saved, replace)?;
    crate::terminal::print_json(&json!({
        "name": saved.name,
        "saved_in": store.display().to_string(),
        "active": true,
        "connected_as": caller.principal,
    }))?;
    Ok(())
}

/// Reads the operator token from standard input: a masked prompt in a terminal, as TypeScript's
/// `connect control-plane` did, and otherwise one line.
fn read_operator_token() -> Result<String> {
    let terminal = std::io::IsTerminal::is_terminal(&std::io::stdin());
    // Echo is off before the prompt appears, so nothing typed after it is shown.
    let echo = terminal.then(surface_setup::hide_input).flatten();
    if terminal {
        crate::terminal::write_stderr("Operator token or Auth Key: ");
    }
    let mut line = String::new();
    let read = std::io::stdin().read_line(&mut line);
    if let Some(saved) = echo {
        surface_setup::restore_input(saved);
        errln!("");
    }
    read.context("read the operator token or Auth Key from standard input")?;
    Ok(line)
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
        "lead": tag.lead,
        "max_work_sessions": tag.max_work_sessions,
        "open_work_sessions": tag.open_work_sessions,
        "memory": tag.memory,
        "memory_reviewed_at_ms": tag.memory_reviewed_at_ms,
        // At most how many Task Attempts start per period, and how many started in the current
        // window; only `describe tag` reads the count.
        "start_rate": tag.start_rate.as_ref().map(|rate| json!({
            "starts": rate.starts,
            "per": crate::tags::start_rate_text(rate).split_once('/').map(|(_, per)| per.to_owned()),
            "in_window": tag.starts_in_window,
        })),
        // What Worker Hosts hold of the Tag's harness-native memory (such as Claude Code's
        // auto-memory), newest first; only `describe tag` reads it. Counts, never contents.
        "native_memory": tag.native_memory.iter().map(memories::native_store_json).collect::<Vec<_>>(),
        "volume": (!tag.volume.is_empty()).then_some(&tag.volume),
        // How the Tag's unprompted messages were received; only `describe tag` reads it.
        "attention": tag.attention.as_ref().map(|attention| json!({
            "window_days": attention.window_days,
            "posted": attention.posted,
            "read": attention.read,
            "answered": attention.answered,
            "quiet": attention.quiet,
        })),
        "revision": tag.revision,
        "instructions": tag.instructions,
        "allowed_actions": tag.allowed_actions,
        "harness": tag.harness_kind().as_str_name(),
        "workspace": tag.workspace.as_ref().map(|spec| json!({
            "workspace_id": spec.workspace_id,
            "base_commit": (!spec.base_commit.is_empty()).then_some(&spec.base_commit),
            "ref": (!spec.base_ref.is_empty()).then_some(&spec.base_ref),
        })),
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
        "state": task.state().as_str_name(), "result": task.result, "quiet": task.quiet, "attempt_id": task.attempt_id,
        "harness": task.harness_kind().as_str_name(),
        "shared_execution_environment_id": supertag_protocol::shared_execution::environment(task.policy_snapshot.as_ref()),
        "file_scope": supertag_protocol::file_scope::of_task(task).map(|scope| json!({
            "summary": supertag_protocol::file_scope::summary(scope),
            "write": scope.write,
            "read_only": scope.read_only,
            "hidden": scope.hidden,
            "outside_write": scope.outside_write,
            "outside_read": scope.outside_read,
        })),
        "network_scope": supertag_protocol::network_scope::of_task(task).map(|scope| json!({
            "summary": supertag_protocol::network_scope::summary(scope),
            "any_origin": scope.any_origin,
            "rules": scope.rules.iter().map(|rule| json!({
                "origins": rule.origins,
                "methods": rule.methods,
                "credential": (!rule.credential.is_empty()).then_some(&rule.credential),
            })).collect::<Vec<_>>(),
        })),
        "network_log": task.network_logs.iter().map(|attempt| {
            let log = attempt.log.clone().unwrap_or_default();
            json!({
                "attempt_id": attempt.attempt_id,
                "allowed": log.allowed,
                "denied": log.denied,
                "unrecorded": log.unrecorded,
                "requests": log.requests.iter().map(|record| json!({
                    "at_ms": record.at_ms,
                    "method": record.method,
                    "origin": record.origin,
                    "path": record.path,
                    "allowed": record.allowed,
                    "reason": (!record.reason.is_empty()).then_some(&record.reason),
                    "status": (record.status != 0).then_some(record.status),
                    "credential": (!record.credential.is_empty()).then_some(&record.credential),
                })).collect::<Vec<_>>(),
            })
        }).collect::<Vec<_>>(),
        "workspace": task.workspace.as_ref().map(|spec| json!({
            "workspace_id": spec.workspace_id,
            // The commit the Task starts from: pinned by its Tag, or resolved from `ref` when the
            // Session's first Attempt started (empty until then).
            "base_commit": spec.base_commit,
            "ref": (!spec.base_ref.is_empty()).then_some(&spec.base_ref),
            "mounts": workspace_mounts::describe(&spec.mounts),
            "mcp_servers": spec.mcp_servers,
            "remote": spec.remote.clone().map(remote_workspaces::describe),
            "merge_commit": (!spec.merge_commit.is_empty()).then_some(&spec.merge_commit),
        })),
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
        "execution_limits": task.execution_limits.as_ref().map(limits_json),
        "applied_execution_limits": task.applied_execution_limits.as_ref().map(|applied| {
            let method = |value: i32, present: bool| {
                present.then(|| {
                    supertag_protocol::v2::ExecutionLimitEnforcement::try_from(value)
                        .unwrap_or_default()
                        .as_str_name()
                        .trim_start_matches("EXECUTION_LIMIT_ENFORCEMENT_")
                        .to_ascii_lowercase()
                })
            };
            let limits = applied.limits.clone().unwrap_or_default();
            json!({
                "limits": limits_json(&limits),
                "enforcement": {
                    "max_reported_tokens": method(applied.reported_tokens, limits.max_reported_tokens.is_some()),
                    "max_reported_cost": method(applied.reported_cost, limits.max_reported_cost.is_some()),
                    "max_native_agents": method(applied.native_agents, limits.max_native_agents.is_some()),
                },
            })
        }),
        "execution_report": task.execution_report.as_ref().map(execution_report_json),
    })
}

/// The Task execution report's classifications, as lower-case words without their prefixes.
fn execution_report_json(report: &supertag_protocol::v2::TaskExecutionReport) -> serde_json::Value {
    use supertag_protocol::v2::ExecutionThreshold;
    let word = |name: &str, prefix: &str| name.trim_start_matches(prefix).to_ascii_lowercase();
    let threshold = |value: ExecutionThreshold| {
        (value != ExecutionThreshold::Unspecified)
            .then(|| word(value.as_str_name(), "EXECUTION_THRESHOLD_"))
    };
    json!({
        "limits": word(report.limit_outcome().as_str_name(), "EXECUTION_LIMIT_OUTCOME_"),
        "thresholds": {
            "max_reported_tokens": threshold(report.max_reported_tokens()),
            "max_reported_cost": threshold(report.max_reported_cost()),
            "max_native_agents": threshold(report.max_native_agents()),
        },
        "limits_applied": report.limits_applied,
        "usage_complete": report.usage_complete,
        "complete": report.complete,
        "cleanup": word(report.cleanup().as_str_name(), "ATTEMPT_CLEANUP_"),
        "cleanup_failure": report.cleanup_failure,
        // Operator-only: the Control Plane sends it to operators alone.
        "failure_detail": report.failure_detail,
    })
}

fn limits_json(limits: &supertag_protocol::v2::ExecutionLimits) -> serde_json::Value {
    json!({
        "max_reported_tokens": limits.max_reported_tokens,
        "max_reported_cost": limits.max_reported_cost.as_ref().map(|limit| json!({
            "amount_minor": limit.amount_minor, "currency": limit.currency,
        })),
        "max_native_agents": limits.max_native_agents,
    })
}

#[cfg(test)]
mod tests {
    use clap::{CommandFactory, Parser};

    use super::{Cli, error_text, notice_default_change, usage_error_text};
    use crate::{observe::WATCH_EVENT_STREAMS, resources::KINDS};

    #[test]
    fn a_service_status_shows_only_its_message() {
        let error = anyhow::Error::new(tonic::Status::failed_precondition("Tag lead is paused"));
        assert_eq!(error_text(&error), "Tag lead is paused");
        let error =
            anyhow::Error::new(tonic::Status::not_found("no Task t-1")).context("read the Task");
        assert_eq!(
            error_text(&error),
            "read the Task\n\nCaused by:\n    no Task t-1"
        );
        let error = anyhow::anyhow!("innermost")
            .context("middle")
            .context("outer");
        assert_eq!(
            error_text(&error),
            "outer\n\nCaused by:\n    0: middle\n    1: innermost"
        );
    }

    #[test]
    fn a_replica_says_when_it_replaced_the_shared_notice_default() {
        assert_eq!(
            notice_default_change(None, Some("t1")),
            "The default Objective notice Task is now Task t1."
        );
        let cleared = notice_default_change(Some("t1"), None);
        assert!(
            cleared.starts_with("The default Objective notice Task is now unset; it was Task t1.")
                && cleared
                    .contains("start each with the same SUPERTAG_OPERATOR_NOTIFICATION_TASK_ID"),
            "{cleared}"
        );
    }

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
    /// placement rules, this host's MCP catalog, and test sends. Every other group is named after
    /// a kind in `resources::KINDS`.
    const OTHER_GROUPS: [&str; 6] = ["setup", "check", "verify", "placement", "mcp", "test"];

    /// Groups of this machine's local state rather than Control Plane resources, which `get` does
    /// not read: `mcp list` lists the host's MCP catalog.
    const LOCAL_GROUPS: [&str; 1] = ["mcp"];

    /// Top-level commands that act on this machine, a deployment, or a report rather than on one
    /// resource kind. `connect` is the one verb: it saves a Control Plane on this machine.
    const OPERATIONS: [&str; 19] = [
        "message",
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
        "tui",
        "worklet",
        "connect",
        "disconnect",
        "spend",
        "metrics",
        "audit",
    ];

    /// Operations that share a kind's name: `message` sends to the caller's conversation with a
    /// Tag, while `get messages` lists Mailbox messages between Tags.
    const OPERATIONS_NAMED_AFTER_KINDS: [&str; 1] = ["message"];

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
                KINDS.iter().all(|spec| spec.name != *name)
                    || OPERATIONS_NAMED_AFTER_KINDS.contains(name),
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
                "--remote",
                "https://git.example.com/o/r.git",
                "--land",
                "merge",
                "--target",
                "drafts",
            ],
            &["supertag", "workspace", "check", "w"],
            &["supertag", "workspace", "credential", "list"],
            &["supertag", "get", "landings", "--session-id", "s"],
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
        // host enroll names the Control Plane and state directory of the host it enrolls with its own
        // options, which shadow the group's connection options.
        let enroll = Cli::try_parse_from([
            "supertag",
            "host",
            "enroll",
            "laptop",
            "--control-plane",
            "https://control-plane.example",
            "--state-directory",
            "/tmp/host",
        ])
        .expect("host enroll parses");
        match enroll.command {
            Some(super::Command::Host {
                command:
                    crate::host_status::HostCommand::Enroll {
                        control_plane,
                        state_directory,
                        ..
                    },
                ..
            }) => {
                assert_eq!(control_plane, "https://control-plane.example");
                assert_eq!(state_directory, std::path::Path::new("/tmp/host"));
            }
            _ => panic!("host enroll parses as host enroll"),
        }
        assert!(enroll.gateway.is_none(), "no root --gateway was given");
        for arguments in [
            ["supertag", "get", "task", "task-1", "--limit", "5"].as_slice(),
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
