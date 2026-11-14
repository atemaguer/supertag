//! The generic resource verbs: `supertag get KIND [ID]`, `supertag describe KIND ID`, and
//! `supertag delete KIND ID`.
//!
//! The CLI grammar is ACTION RESOURCE for verbs that apply to every resource (`get`, `describe`,
//! `watch`, `delete`, `apply`, `diff`), and RESOURCE VERB for actions only one resource has
//! (`tag put`, `task submit`, `host drain`), named by the same noun `get` takes. [`KINDS`] is the
//! one table of resource kinds: every kind is read with `get`, and the table says which kinds
//! `get` and `describe` read by ID, which `get` lists without one, which `delete` removes, and
//! which `watch` follows. A test checks the command tree against it.

use anyhow::{Result, bail};
use clap::builder::{PossibleValue, PossibleValuesParser, TypedValueParser};
use clap::{Args, Subcommand, ValueEnum};
use serde_json::Value;
use supertag_protocol::v2::objective_overviews_client::ObjectiveOverviewsClient;
use supertag_protocol::v2::{GetObjectiveOverviewRequest, PrincipalRole};
use supertag_protocol::{MAX_MESSAGE_BYTES, negotiation::ProtocolChannel};

use crate::observe::{Output, describe_text};
use crate::{
    Connection, artifact_publications, artifacts, auth_keys, connect_operator, enrollments,
    github_publications, github_workspaces, host_status, inbox, inputs, mailbox, objectives,
    operator_access, policy, replies, request, surface_policy, tags, tasks, teams, volumes,
    work_sessions, workspace_mounts,
};

/// A resource kind. The singular is the canonical name; the plural is accepted too.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum Kind {
    #[value(alias = "tags")]
    Tag,
    #[value(alias = "tasks")]
    Task,
    #[value(alias = "objectives")]
    Objective,
    #[value(alias = "teams")]
    Team,
    #[value(alias = "hosts")]
    Host,
    #[value(alias = "gateways")]
    Gateway,
    #[value(alias = "clients")]
    Client,
    #[value(alias = "sessions")]
    Session,
    #[value(alias = "roles")]
    Role,
    #[value(alias = "permission-sets")]
    PermissionSet,
    #[value(alias = "context-sets")]
    ContextSet,
    #[value(alias = "volumes")]
    Volume,
    #[value(alias = "volume-copies")]
    VolumeCopy,
    #[value(alias = "workspace-volumes")]
    WorkspaceVolume,
    #[value(alias = "workspaces")]
    Workspace,
    #[value(alias = "auth-keys")]
    AuthKey,
    #[value(alias = "operator-tokens")]
    OperatorToken,
    #[value(alias = "artifacts")]
    Artifact,
    #[value(alias = "artifact-publications")]
    ArtifactPublication,
    #[value(alias = "artifact-consumptions")]
    ArtifactConsumption,
    #[value(alias = "github-publications")]
    GithubPublication,
    #[value(alias = "replies")]
    Reply,
    #[value(alias = "inputs")]
    Input,
    #[value(alias = "surface-accounts")]
    SurfaceAccount,
    #[value(alias = "surface-locations")]
    SurfaceLocation,
    #[value(alias = "role-assignments")]
    RoleAssignment,
    #[value(alias = "mailbox-grants")]
    MailboxGrant,
    #[value(alias = "messages")]
    Message,
    #[value(alias = "workstream-posts")]
    WorkstreamPost,
    #[value(alias = "approvals")]
    Approval,
    #[value(alias = "questions")]
    Question,
    #[value(alias = "inbox-items")]
    InboxItem,
}

/// One row of the resource kind table. Outside `describe`'s title, the command tree carries these
/// facts itself; the grammar test checks it against the table.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct KindSpec {
    pub kind: Kind,
    /// The canonical singular name, as `get`, `describe`, `delete`, and `watch` accept it.
    pub name: &'static str,
    /// The plural, accepted wherever the singular is.
    pub plural: &'static str,
    /// The heading `describe` prints.
    pub title: &'static str,
    /// `get KIND ID` and `describe KIND ID` read one resource. Without it the kind has no
    /// operator-visible ID and is only listed.
    pub read: bool,
    /// `get KIND` without an ID lists the kind.
    pub list: bool,
    /// `delete KIND ID` exists.
    pub delete: bool,
    /// `watch KIND` follows changes to the kind.
    pub watch: bool,
}

const fn kind(
    kind: Kind,
    name: &'static str,
    plural: &'static str,
    title: &'static str,
    [read, list, delete, watch]: [bool; 4],
) -> KindSpec {
    KindSpec {
        kind,
        name,
        plural,
        title,
        read,
        list,
        delete,
        watch,
    }
}

const READ: [bool; 4] = [true, false, false, false];
const LIST: [bool; 4] = [true, true, false, false];
const LIST_DELETE: [bool; 4] = [true, true, true, false];
const LIST_WATCH: [bool; 4] = [true, true, false, true];
/// Listed only: these resources have no ID of their own to read.
const LIST_ONLY: [bool; 4] = [false, true, false, false];

/// Every resource kind the CLI reads.
pub(crate) const KINDS: &[KindSpec] = &[
    kind(Kind::Tag, "tag", "tags", "Tag", LIST_WATCH),
    kind(
        Kind::Task,
        "task",
        "tasks",
        "Task",
        [true, false, false, true],
    ),
    kind(
        Kind::Objective,
        "objective",
        "objectives",
        "Objective",
        LIST_WATCH,
    ),
    kind(
        Kind::Team,
        "team",
        "teams",
        "Team",
        [true, true, true, true],
    ),
    kind(Kind::Host, "host", "hosts", "Worker Host", LIST),
    kind(Kind::Gateway, "gateway", "gateways", "Gateway", LIST),
    kind(Kind::Client, "client", "clients", "Client", LIST),
    kind(Kind::Session, "session", "sessions", "Work Session", LIST),
    kind(Kind::Role, "role", "roles", "Role", LIST),
    kind(
        Kind::PermissionSet,
        "permission-set",
        "permission-sets",
        "Permission Set",
        LIST_DELETE,
    ),
    kind(
        Kind::ContextSet,
        "context-set",
        "context-sets",
        "Context Set",
        LIST_DELETE,
    ),
    kind(Kind::Volume, "volume", "volumes", "Volume", LIST_DELETE),
    kind(
        Kind::VolumeCopy,
        "volume-copy",
        "volume-copies",
        "Volume Copy",
        LIST,
    ),
    kind(
        Kind::WorkspaceVolume,
        "workspace-volume",
        "workspace-volumes",
        "Workspace Volume",
        READ,
    ),
    kind(
        Kind::Workspace,
        "workspace",
        "workspaces",
        "Workspace",
        LIST_DELETE,
    ),
    kind(Kind::AuthKey, "auth-key", "auth-keys", "Auth Key", LIST),
    kind(
        Kind::OperatorToken,
        "operator-token",
        "operator-tokens",
        "Operator Token",
        LIST,
    ),
    kind(Kind::Artifact, "artifact", "artifacts", "Artifact", LIST),
    kind(
        Kind::ArtifactPublication,
        "artifact-publication",
        "artifact-publications",
        "Artifact Publication",
        LIST,
    ),
    kind(
        Kind::ArtifactConsumption,
        "artifact-consumption",
        "artifact-consumptions",
        "Artifact Consumption",
        LIST,
    ),
    kind(
        Kind::GithubPublication,
        "github-publication",
        "github-publications",
        "GitHub Publication",
        LIST,
    ),
    kind(Kind::Reply, "reply", "replies", "Reply", LIST),
    kind(Kind::Input, "input", "inputs", "Input", READ),
    kind(
        Kind::SurfaceAccount,
        "surface-account",
        "surface-accounts",
        "Surface Account",
        LIST,
    ),
    kind(
        Kind::SurfaceLocation,
        "surface-location",
        "surface-locations",
        "Surface Location",
        LIST_DELETE,
    ),
    kind(
        Kind::RoleAssignment,
        "role-assignment",
        "role-assignments",
        "Role Assignment",
        LIST_ONLY,
    ),
    kind(
        Kind::MailboxGrant,
        "mailbox-grant",
        "mailbox-grants",
        "Mailbox Grant",
        LIST_ONLY,
    ),
    kind(Kind::Message, "message", "messages", "Message", LIST_ONLY),
    kind(
        Kind::WorkstreamPost,
        "workstream-post",
        "workstream-posts",
        "Workstream Post",
        [false, true, false, true],
    ),
    kind(Kind::Approval, "approval", "approvals", "Approval", LIST),
    kind(Kind::Question, "question", "questions", "Question", READ),
    kind(
        Kind::InboxItem,
        "inbox-item",
        "inbox-items",
        "Inbox Item",
        LIST_ONLY,
    ),
];

pub(crate) fn spec(kind: Kind) -> &'static KindSpec {
    KINDS
        .iter()
        .find(|spec| spec.kind == kind)
        .expect("every kind has a row in KINDS")
}

/// `supertag get KIND [ID]`: one resource as JSON, or a page of them when the kind lists and no ID
/// is given.
#[derive(Subcommand)]
pub enum GetCommand {
    /// Read a Tag by its permanent ID, including after retirement, or list active Tags.
    #[command(visible_alias = "tags")]
    Tag {
        /// Tag ID. Omit to list.
        id: Option<String>,
        #[command(flatten)]
        list: tags::ListArgs,
    },
    /// Read a Task.
    #[command(visible_alias = "tasks")]
    Task {
        /// Task ID.
        id: String,
    },
    /// Read one Objective, or list Objectives.
    #[command(visible_alias = "objectives")]
    Objective {
        /// Objective ID. Omit to list.
        id: Option<String>,
        #[command(flatten)]
        list: objectives::ListArgs,
    },
    /// Read one Team by ID or name, or list Teams, optionally for one member Tag.
    #[command(visible_alias = "teams")]
    Team {
        /// Team ID or name. Omit to list.
        id: Option<String>,
        #[command(flatten)]
        list: teams::ListArgs,
    },
    /// Read one Worker Host, or list Worker Hosts and their readiness.
    #[command(visible_alias = "hosts")]
    Host {
        /// Worker Host ID. Omit to list.
        id: Option<String>,
        #[command(flatten)]
        list: host_status::ListArgs,
    },
    /// Read one enrolled Gateway, or list them, revoked ones included.
    #[command(visible_alias = "gateways")]
    Gateway {
        /// Gateway name. Omit to list.
        id: Option<String>,
        #[command(flatten)]
        list: enrollments::ListArgs,
    },
    /// Read one enrolled client device, or list them, revoked ones included.
    #[command(visible_alias = "clients")]
    Client {
        /// Client name. Omit to list.
        id: Option<String>,
        #[command(flatten)]
        list: enrollments::ListArgs,
    },
    /// Read one Work Session, its latest Task, and its report, or list the Work Sessions started
    /// from a parent Session.
    #[command(visible_alias = "sessions")]
    Session {
        /// Work Session ID. Omit to list.
        id: Option<String>,
        /// Show the child Task associated with this report.
        #[arg(long, requires = "id")]
        report_task: Option<String>,
        #[command(flatten)]
        list: work_sessions::ListArgs,
    },
    /// Read a Role by ID or name, or list Roles.
    #[command(visible_alias = "roles")]
    Role {
        /// Role ID or name. Omit to list.
        id: Option<String>,
        #[command(flatten)]
        list: policy::ListArgs,
    },
    /// Read a Permission Set by ID or name, or list Permission Sets.
    #[command(visible_alias = "permission-sets")]
    PermissionSet {
        /// Permission Set ID or name. Omit to list.
        id: Option<String>,
        #[command(flatten)]
        list: policy::ListArgs,
    },
    /// Read a Context Set by ID or name, or list Context Sets.
    #[command(visible_alias = "context-sets")]
    ContextSet {
        /// Context Set ID or name. Omit to list.
        id: Option<String>,
        #[command(flatten)]
        list: policy::ListArgs,
    },
    /// Read one Volume, or list registered Volumes.
    #[command(visible_alias = "volumes")]
    Volume {
        /// Volume ID. Omit to list.
        id: Option<String>,
        #[command(flatten)]
        list: volumes::ListArgs,
    },
    /// Read one recorded artifact copy, or list them newest first, optionally for one Volume.
    #[command(visible_alias = "volume-copies")]
    VolumeCopy {
        /// Copy ID. Omit to list.
        id: Option<String>,
        #[command(flatten)]
        list: volumes::CopyListArgs,
    },
    /// Read one Workspace data Volume.
    #[command(visible_alias = "workspace-volumes")]
    WorkspaceVolume {
        /// Workspace Volume ID.
        id: String,
    },
    /// Read one GitHub Workspace source, or list them.
    #[command(visible_alias = "workspaces")]
    Workspace {
        /// Workspace ID. Omit to list.
        id: Option<String>,
        #[command(flatten)]
        list: github_workspaces::ListArgs,
    },
    /// Read one Auth Key without its secret, or list Auth Keys, revoked, expired and used ones
    /// included.
    #[command(visible_alias = "auth-keys")]
    AuthKey {
        /// Auth Key name. Omit to list.
        id: Option<String>,
        #[command(flatten)]
        list: auth_keys::ListArgs,
    },
    /// Read one Operator Token without its secret, or list them. Admin operator token only.
    #[command(visible_alias = "operator-tokens")]
    OperatorToken {
        /// Operator Token name. Omit to list.
        id: Option<String>,
        #[command(flatten)]
        list: operator_access::ListArgs,
    },
    /// Read an artifact's provenance and exact file manifest, or list the artifacts a Task
    /// captured.
    #[command(visible_alias = "artifacts")]
    Artifact {
        /// Artifact ID. Omit to list with --task.
        id: Option<String>,
        #[command(flatten)]
        list: artifacts::ListArgs,
    },
    /// Read one artifact publication, or list those approved from an Objective.
    #[command(visible_alias = "artifact-publications")]
    ArtifactPublication {
        /// Publication ID. Omit to list with --objective.
        id: Option<String>,
        #[command(flatten)]
        list: artifact_publications::ListArgs,
    },
    /// Read one consumption approval, or list those for a destination Objective.
    #[command(visible_alias = "artifact-consumptions")]
    ArtifactConsumption {
        /// Consumption ID. Omit to list with --objective.
        id: Option<String>,
        #[command(flatten)]
        list: artifact_publications::ListArgs,
    },
    /// Read one GitHub publication, or list verified Workspace results and their publication
    /// status.
    #[command(visible_alias = "github-publications")]
    GithubPublication {
        /// Publication ID. Omit to list.
        id: Option<String>,
        #[command(flatten)]
        list: github_publications::ListArgs,
    },
    /// Read a connector reply, its delivery status, and its audit history, or list replies.
    #[command(visible_alias = "replies")]
    Reply {
        /// Reply ID. Omit to list.
        id: Option<String>,
        #[command(flatten)]
        list: replies::ListArgs,
    },
    /// Read the delivery status and fallback Task of a message sent to a running Task.
    #[command(visible_alias = "inputs")]
    Input {
        /// Input ID, as `task input` printed it.
        id: String,
    },
    /// Read one verified connector account, or list them.
    #[command(visible_alias = "surface-accounts")]
    SurfaceAccount {
        /// Surface Account ID. Omit to list.
        id: Option<String>,
        #[command(flatten)]
        list: surface_policy::AccountListArgs,
    },
    /// Read one surface location's Tag and policy, or list locations.
    #[command(visible_alias = "surface-locations")]
    SurfaceLocation {
        /// Surface Location ID. Omit to list.
        id: Option<String>,
        #[command(flatten)]
        list: surface_policy::LocationListArgs,
    },
    /// List Role assignments.
    #[command(visible_alias = "role-assignments")]
    RoleAssignment {
        #[command(flatten)]
        list: policy::AssignmentListArgs,
    },
    /// List the incoming and outgoing direct message grants of a Tag.
    #[command(visible_alias = "mailbox-grants")]
    MailboxGrant {
        #[command(flatten)]
        list: mailbox::GrantListArgs,
    },
    /// List the messages sent to or from a Tag.
    #[command(visible_alias = "messages")]
    Message {
        #[command(flatten)]
        list: mailbox::MessageListArgs,
    },
    /// List a Team's newest Workstream posts, or those after a sequence.
    #[command(visible_alias = "workstream-posts")]
    WorkstreamPost {
        #[command(flatten)]
        list: teams::PostListArgs,
    },
    /// Read the action, resource, and exact arguments an approval requests, or list approval
    /// history.
    #[command(visible_alias = "approvals")]
    Approval {
        /// Approval ID. Omit to list.
        id: Option<String>,
        #[command(flatten)]
        list: inbox::ApprovalListArgs,
    },
    /// Read the full question an Objective Task asked.
    #[command(visible_alias = "questions")]
    Question {
        /// The ID of the Task that asked.
        id: String,
    },
    /// List the questions and work waiting for an operator.
    #[command(visible_alias = "inbox-items")]
    InboxItem {
        #[command(flatten)]
        list: inbox::ItemListArgs,
    },
}

/// `supertag delete KIND ID`.
#[derive(Subcommand)]
pub enum DeleteCommand {
    /// Delete a Team and its Workstream after its Objectives close.
    #[command(visible_alias = "teams")]
    Team {
        /// Team ID or name.
        id: String,
        #[command(flatten)]
        args: teams::DeleteArgs,
    },
    /// Delete an unused Permission Set.
    #[command(visible_alias = "permission-sets")]
    PermissionSet {
        /// Permission Set ID or name.
        id: String,
        #[command(flatten)]
        args: policy::DeleteArgs,
    },
    /// Delete an unused Context Set.
    #[command(visible_alias = "context-sets")]
    ContextSet {
        /// Context Set ID or name.
        id: String,
        #[command(flatten)]
        args: policy::DeleteArgs,
    },
    /// Remove a Volume's metadata when no reserved or verified copies depend on it.
    #[command(visible_alias = "volumes")]
    Volume {
        /// Volume ID.
        id: String,
        #[command(flatten)]
        args: volumes::DeleteArgs,
    },
    /// Delete a GitHub Workspace source at its exact revision.
    #[command(visible_alias = "workspaces")]
    Workspace {
        /// Workspace ID.
        id: String,
        #[command(flatten)]
        args: github_workspaces::DeleteArgs,
    },
    /// Remove a location's policy and stop new work on its connector alias.
    #[command(visible_alias = "surface-locations")]
    SurfaceLocation {
        /// Surface Location ID.
        id: String,
        #[command(flatten)]
        args: surface_policy::DeleteArgs,
    },
}

#[derive(Args)]
pub struct DescribeArgs {
    /// The kind of resource. Only kinds read by ID can be described.
    #[arg(value_parser = readable_kind())]
    kind: Kind,
    /// The resource's ID or name.
    id: String,
    /// Print readable text, or JSON for scripts.
    #[arg(long, value_enum, default_value = "text")]
    output: Output,
}

/// Parses a kind that `get KIND ID` and `describe KIND ID` read, singular or plural.
fn readable_kind() -> impl TypedValueParser<Value = Kind> {
    PossibleValuesParser::new(
        KINDS
            .iter()
            .filter(|spec| spec.read)
            .map(|spec| PossibleValue::new(spec.name).alias(spec.plural)),
    )
    .map(|name| {
        KINDS
            .iter()
            .find(|spec| spec.name == name || spec.plural == name)
            .expect("the parser accepts only names in KINDS")
            .kind
    })
}

pub async fn get(connection: Connection, command: GetCommand) -> Result<()> {
    let (kind, id) = match command {
        GetCommand::Tag { id: Some(id), .. } => (Kind::Tag, id),
        GetCommand::Tag { id: None, list } => return print(tags::list(connection, list)).await,
        GetCommand::Task { id } => (Kind::Task, id),
        GetCommand::Objective { id: Some(id), .. } => (Kind::Objective, id),
        GetCommand::Objective { id: None, list } => {
            return print(objectives::list(connection, list)).await;
        }
        GetCommand::Team { id: Some(id), .. } => (Kind::Team, id),
        GetCommand::Team { id: None, list } => return print(teams::list(connection, list)).await,
        GetCommand::Host { id: Some(id), .. } => (Kind::Host, id),
        GetCommand::Host { id: None, list } => {
            return print(host_status::list(connection, list)).await;
        }
        GetCommand::Gateway { id: Some(id), .. } => (Kind::Gateway, id),
        GetCommand::Gateway { id: None, list } => {
            return print(enrollments::list(connection, PrincipalRole::Gateway, list)).await;
        }
        GetCommand::Client { id: Some(id), .. } => (Kind::Client, id),
        GetCommand::Client { id: None, list } => {
            return print(enrollments::list(connection, PrincipalRole::Client, list)).await;
        }
        GetCommand::Session {
            id: Some(id),
            report_task,
            ..
        } => {
            let (channel, token) = connect_operator(connection).await?;
            return print(work_sessions::fetch(channel, &token, id, report_task)).await;
        }
        GetCommand::Session { id: None, list, .. } => {
            return print(work_sessions::list(connection, list)).await;
        }
        GetCommand::Role { id: Some(id), .. } => (Kind::Role, id),
        GetCommand::Role { id: None, list } => {
            return print(policy::list(connection, policy::Kind::Role, list)).await;
        }
        GetCommand::PermissionSet { id: Some(id), .. } => (Kind::PermissionSet, id),
        GetCommand::PermissionSet { id: None, list } => {
            return print(policy::list(connection, policy::Kind::PermissionSet, list)).await;
        }
        GetCommand::ContextSet { id: Some(id), .. } => (Kind::ContextSet, id),
        GetCommand::ContextSet { id: None, list } => {
            return print(policy::list(connection, policy::Kind::ContextSet, list)).await;
        }
        GetCommand::Volume { id: Some(id), .. } => (Kind::Volume, id),
        GetCommand::Volume { id: None, list } => {
            return print(volumes::list(connection, list)).await;
        }
        GetCommand::VolumeCopy { id: Some(id), .. } => (Kind::VolumeCopy, id),
        GetCommand::VolumeCopy { id: None, list } => {
            return print(volumes::list_copies(connection, list)).await;
        }
        GetCommand::WorkspaceVolume { id } => (Kind::WorkspaceVolume, id),
        GetCommand::Workspace { id: Some(id), .. } => (Kind::Workspace, id),
        GetCommand::Workspace { id: None, list } => {
            return print(github_workspaces::list(connection, list)).await;
        }
        GetCommand::AuthKey { id: Some(id), .. } => (Kind::AuthKey, id),
        GetCommand::AuthKey { id: None, list } => {
            return print(auth_keys::list(connection, list)).await;
        }
        GetCommand::OperatorToken { id: Some(id), .. } => (Kind::OperatorToken, id),
        GetCommand::OperatorToken { id: None, list } => {
            return print(operator_access::list(connection, list)).await;
        }
        GetCommand::Artifact { id: Some(id), .. } => (Kind::Artifact, id),
        GetCommand::Artifact { id: None, list } => {
            return print(artifacts::list(connection, list)).await;
        }
        GetCommand::ArtifactPublication { id: Some(id), .. } => (Kind::ArtifactPublication, id),
        GetCommand::ArtifactPublication { id: None, list } => {
            return print(artifact_publications::list_publications(connection, list)).await;
        }
        GetCommand::ArtifactConsumption { id: Some(id), .. } => (Kind::ArtifactConsumption, id),
        GetCommand::ArtifactConsumption { id: None, list } => {
            return print(artifact_publications::list_consumptions(connection, list)).await;
        }
        GetCommand::GithubPublication { id: Some(id), .. } => (Kind::GithubPublication, id),
        GetCommand::GithubPublication { id: None, list } => {
            return print(github_publications::list(connection, list)).await;
        }
        GetCommand::Reply { id: Some(id), .. } => (Kind::Reply, id),
        GetCommand::Reply { id: None, list } => {
            return print(replies::list(connection, list)).await;
        }
        GetCommand::Input { id } => (Kind::Input, id),
        GetCommand::SurfaceAccount { id: Some(id), .. } => (Kind::SurfaceAccount, id),
        GetCommand::SurfaceAccount { id: None, list } => {
            return print(surface_policy::list_accounts(connection, list)).await;
        }
        GetCommand::SurfaceLocation { id: Some(id), .. } => (Kind::SurfaceLocation, id),
        GetCommand::SurfaceLocation { id: None, list } => {
            return print(surface_policy::list_locations(connection, list)).await;
        }
        GetCommand::RoleAssignment { list } => {
            return print(policy::list_assignments(connection, list)).await;
        }
        GetCommand::MailboxGrant { list } => {
            return print(mailbox::list_grants(connection, list)).await;
        }
        GetCommand::Message { list } => {
            return print(mailbox::list_messages(connection, list)).await;
        }
        GetCommand::WorkstreamPost { list } => {
            return print(teams::list_posts(connection, list)).await;
        }
        GetCommand::Approval { id: Some(id), .. } => (Kind::Approval, id),
        GetCommand::Approval { id: None, list } => {
            return print(inbox::list_approvals(connection, list)).await;
        }
        GetCommand::Question { id } => (Kind::Question, id),
        GetCommand::InboxItem { list } => return print(inbox::list_items(connection, list)).await,
    };
    let (channel, token) = connect_operator(connection).await?;
    print(fetch(channel, &token, kind, id)).await
}

async fn print(value: impl Future<Output = Result<Value>>) -> Result<()> {
    crate::terminal::print_json(&value.await?)?;
    Ok(())
}

/// One resource as `get KIND ID` prints it.
async fn fetch(channel: ProtocolChannel, token: &str, kind: Kind, id: String) -> Result<Value> {
    match kind {
        Kind::Tag => tags::fetch(channel, token, id).await,
        Kind::Task => tasks::fetch(channel, token, id).await,
        Kind::Objective => objectives::fetch(channel, token, id).await,
        Kind::Team => teams::fetch(channel, token, id).await,
        Kind::Host => host_status::fetch(channel, token, id).await,
        Kind::Gateway => enrollments::fetch(channel, token, PrincipalRole::Gateway, id).await,
        Kind::Client => enrollments::fetch(channel, token, PrincipalRole::Client, id).await,
        Kind::Session => work_sessions::fetch(channel, token, id, None).await,
        Kind::Role => policy::fetch(channel, token, policy::Kind::Role, id).await,
        Kind::PermissionSet => policy::fetch(channel, token, policy::Kind::PermissionSet, id).await,
        Kind::ContextSet => policy::fetch(channel, token, policy::Kind::ContextSet, id).await,
        Kind::Volume => volumes::fetch(channel, token, id).await,
        Kind::VolumeCopy => volumes::fetch_copy(channel, token, id).await,
        Kind::WorkspaceVolume => workspace_mounts::fetch(channel, token, id).await,
        Kind::Workspace => github_workspaces::fetch(channel, token, id).await,
        Kind::AuthKey => auth_keys::fetch(channel, token, id).await,
        Kind::OperatorToken => operator_access::fetch(channel, token, id).await,
        Kind::Artifact => artifacts::fetch(channel, token, id).await,
        Kind::ArtifactPublication => {
            artifact_publications::fetch_publication(channel, token, id).await
        }
        Kind::ArtifactConsumption => {
            artifact_publications::fetch_consumption(channel, token, id).await
        }
        Kind::GithubPublication => github_publications::fetch(channel, token, id).await,
        Kind::Reply => replies::fetch(channel, token, id).await,
        Kind::Input => inputs::fetch(channel, token, id).await,
        Kind::SurfaceAccount => surface_policy::fetch_account(channel, token, id).await,
        Kind::SurfaceLocation => surface_policy::fetch_location(channel, token, id).await,
        Kind::Approval => inbox::fetch_approval(channel, token, id).await,
        Kind::Question => inbox::fetch_question(channel, token, id).await,
        Kind::RoleAssignment
        | Kind::MailboxGrant
        | Kind::Message
        | Kind::WorkstreamPost
        | Kind::InboxItem => bail!("{} is listed, not read by ID", spec(kind).plural),
    }
}

/// Describes one resource in readable text, or as JSON. An Objective is described by its overview:
/// its state, its owner's work, and what needs the operator.
pub async fn describe(connection: Connection, args: DescribeArgs) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    if args.kind == Kind::Objective {
        let view = ObjectiveOverviewsClient::new(channel)
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
            .get_objective_overview(request(
                GetObjectiveOverviewRequest {
                    objective_id: args.id,
                    ..Default::default()
                },
                &token,
            )?)
            .await?
            .into_inner();
        match args.output {
            Output::Json => crate::terminal::print_json(&crate::objective_overview::json(&view))?,
            Output::Text => out!("{}", crate::objective_overview::text(&view)),
        }
        return Ok(());
    }
    let value = fetch(channel, &token, args.kind, args.id).await?;
    match args.output {
        Output::Json => crate::terminal::print_json(&value)?,
        Output::Text => out!("{}", describe_text(spec(args.kind).title, &value)),
    }
    Ok(())
}

pub async fn delete(connection: Connection, command: DeleteCommand) -> Result<()> {
    print(async {
        match command {
            DeleteCommand::Team { id, args } => teams::delete(connection, id, args).await,
            DeleteCommand::PermissionSet { id, args } => {
                policy::delete(connection, policy::Kind::PermissionSet, id, args).await
            }
            DeleteCommand::ContextSet { id, args } => {
                policy::delete(connection, policy::Kind::ContextSet, id, args).await
            }
            DeleteCommand::Volume { id, args } => volumes::delete(connection, id, args).await,
            DeleteCommand::Workspace { id, args } => {
                github_workspaces::delete(connection, id, args).await
            }
            DeleteCommand::SurfaceLocation { id, args } => {
                surface_policy::delete_location(connection, id, args).await
            }
        }
    })
    .await
}
