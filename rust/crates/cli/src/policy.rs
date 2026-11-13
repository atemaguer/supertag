use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use clap::{Args, Subcommand, ValueEnum};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use uuid::Uuid;

use crate::{Connection, connect_operator, request};

#[derive(Clone, Copy, ValueEnum)]
pub enum Kind {
    PermissionSet,
    ContextSet,
    Role,
}

#[derive(Subcommand)]
pub enum PolicyCommand {
    /// Create or replace a catalog resource from a JSON specification.
    Put {
        kind: Kind,
        file: PathBuf,
        /// The revision you last read. If given, the change is refused when the resource has changed since.
        #[arg(long)]
        expected_revision: Option<u64>,
        /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
        #[arg(long)]
        operation_id: Option<String>,
    },
    /// Assign an active Role to a Tag.
    Assign {
        role: String,
        tag_id: String,
        /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
        #[arg(long)]
        operation_id: Option<String>,
    },
    /// List Role assignments.
    Assignments {
        /// Only assignments of this Role.
        #[arg(long, default_value = "")]
        role: String,
        /// Only assignments to this Tag.
        #[arg(long, default_value = "")]
        tag: String,
        /// Only assignments in effect now.
        #[arg(long)]
        active: bool,
        /// Most entries to return on one page.
        #[arg(long, default_value_t = 20)]
        limit: u32,
        /// Continue from the cursor the previous page returned.
        #[arg(long, default_value = "")]
        cursor: String,
    },
    /// Deactivate a Role assignment.
    Deactivate {
        assignment_id: String,
        /// The revision you last read. The change is refused when the resource has changed since.
        #[arg(long)]
        expected_revision: u64,
        /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
        #[arg(long)]
        operation_id: Option<String>,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PermissionSpec {
    #[serde(default)]
    set_id: String,
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default)]
    approvers: Vec<String>,
    #[serde(default)]
    permissions: Vec<GrantSpec>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Target {
    Runtime,
    Surface,
    Mcp,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GrantSpec {
    target: Target,
    action: String,
    #[serde(default)]
    surface_account_id: String,
    #[serde(default)]
    scope: String,
    #[serde(default)]
    reference: String,
    #[serde(default)]
    resource: String,
    #[serde(default)]
    approval_required: bool,
}

impl From<PermissionSpec> for PermissionSet {
    fn from(spec: PermissionSpec) -> Self {
        Self {
            set_id: spec.set_id,
            name: spec.name,
            approvers: spec.approvers,
            permissions: spec
                .permissions
                .into_iter()
                .map(|grant| PolicyPermission {
                    target: match grant.target {
                        Target::Runtime => PolicyPermissionTarget::Runtime,
                        Target::Surface => PolicyPermissionTarget::Surface,
                        Target::Mcp => PolicyPermissionTarget::Mcp,
                    }
                    .into(),
                    action: grant.action,
                    surface_account_id: grant.surface_account_id,
                    scope: grant.scope,
                    reference: grant.reference,
                    resource: grant.resource,
                    approval_required: grant.approval_required,
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ContextSpec {
    #[serde(default)]
    set_id: String,
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default)]
    items: Vec<ContextItemSpec>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContextItemSpec {
    #[serde(alias = "itemKey")]
    item_key: String,
    #[serde(rename = "type")]
    kind: String,
    version: u32,
    #[serde(default)]
    required: bool,
    config: Value,
}

impl From<ContextSpec> for ContextSet {
    fn from(spec: ContextSpec) -> Self {
        Self {
            set_id: spec.set_id,
            name: spec.name,
            items: spec
                .items
                .into_iter()
                .map(|item| PolicyContextItem {
                    artifact_snapshot: None,
                    item_key: item.item_key,
                    r#type: item.kind,
                    version: item.version,
                    required: item.required,
                    config_json: item.config.to_string(),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RoleState {
    #[default]
    Active,
    Retired,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RoleSpec {
    #[serde(default)]
    role_id: String,
    #[serde(default)]
    pub(crate) name: String,
    purpose: String,
    #[serde(default)]
    instructions: String,
    #[serde(default, alias = "permissionSets")]
    permission_set_ids: Vec<String>,
    #[serde(default, alias = "contextSets")]
    context_set_ids: Vec<String>,
    #[serde(default)]
    status: RoleState,
    execution: Option<ExecutionSpec>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ExecutionSpec {
    harness: Option<String>,
    #[serde(alias = "sharedExecutionEnvironmentId")]
    shared_execution_environment_id: Option<String>,
    #[serde(default)]
    models: Vec<String>,
    #[serde(default)]
    efforts: Vec<String>,
}

impl From<ExecutionSpec> for PolicyExecutionSettings {
    fn from(execution: ExecutionSpec) -> Self {
        Self {
            harness: execution.harness,
            models: execution.models,
            efforts: execution.efforts,
            shared_execution_environment_id: execution.shared_execution_environment_id,
        }
    }
}

impl From<RoleSpec> for Role {
    fn from(spec: RoleSpec) -> Self {
        Self {
            role_id: spec.role_id,
            name: spec.name,
            purpose: spec.purpose,
            instructions: spec.instructions,
            permission_set_ids: spec.permission_set_ids,
            context_set_ids: spec.context_set_ids,
            status: match spec.status {
                RoleState::Active => RoleStatus::Active,
                RoleState::Retired => RoleStatus::Retired,
            }
            .into(),
            execution: spec.execution.map(Into::into),
            ..Default::default()
        }
    }
}

fn spec<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let file = std::fs::File::open(path).context("open policy specification")?;
    if file.metadata()?.len() > MAX_MESSAGE_BYTES as u64 {
        bail!("policy specification exceeds the request limit");
    }
    serde_json::from_reader(file).context("read policy specification")
}

fn operation_id(id: Option<String>) -> String {
    id.unwrap_or_else(|| Uuid::new_v4().to_string())
}

// Options for `supertag get roles`, `permission-sets`, and `context-sets`.
#[derive(Args)]
pub struct ListArgs {
    /// Most entries to return on one page.
    #[arg(long, default_value_t = 20, conflicts_with = "id")]
    limit: u32,
    /// Continue from the cursor the previous page returned.
    #[arg(long, default_value = "", conflicts_with = "id")]
    cursor: String,
}

// Options for `supertag delete permission-set` and `context-set`, which delete an unused set.
#[derive(Args)]
pub struct DeleteArgs {
    /// The revision you last read. The change is refused when the resource has changed since.
    #[arg(long)]
    expected_revision: u64,
    /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
    #[arg(long)]
    operation_id: Option<String>,
}

fn client(channel: ProtocolChannel) -> policy_catalog_client::PolicyCatalogClient<ProtocolChannel> {
    policy_catalog_client::PolicyCatalogClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

/// A catalog resource by ID or name.
pub(crate) async fn fetch(
    channel: ProtocolChannel,
    token: &str,
    kind: Kind,
    reference: String,
) -> Result<Value> {
    let mut client = client(channel);
    let input = request(GetPolicyResourceRequest { reference }, token)?;
    Ok(match kind {
        Kind::PermissionSet => {
            permission_json(client.get_permission_set(input).await?.into_inner())
        }
        Kind::ContextSet => context_json(client.get_context_set(input).await?.into_inner())?,
        Kind::Role => role_json(client.get_role(input).await?.into_inner()),
    })
}

pub(crate) async fn list(connection: Connection, kind: Kind, args: ListArgs) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let mut client = client(channel);
    let input = request(
        ListPolicyResourcesRequest {
            limit: args.limit,
            cursor: args.cursor,
        },
        &token,
    )?;
    Ok(match kind {
        Kind::PermissionSet => {
            let page = client.list_permission_sets(input).await?.into_inner();
            json!({ "permission_sets": page.permission_sets.into_iter().map(permission_json).collect::<Vec<_>>(), "next_cursor":page.next_cursor })
        }
        Kind::ContextSet => {
            let page = client.list_context_sets(input).await?.into_inner();
            json!({ "context_sets": page.context_sets.into_iter().map(context_json).collect::<Result<Vec<_>>>()?, "next_cursor":page.next_cursor })
        }
        Kind::Role => {
            let page = client.list_roles(input).await?.into_inner();
            json!({ "roles": page.roles.into_iter().map(role_json).collect::<Vec<_>>(), "next_cursor":page.next_cursor })
        }
    })
}

/// Deletes an unused Permission Set or Context Set. Roles are retired, not deleted.
pub(crate) async fn delete(
    connection: Connection,
    kind: Kind,
    reference: String,
    args: DeleteArgs,
) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let mut client = client(channel);
    let input = request(
        DeletePolicyResourceRequest {
            reference,
            expected_revision: args.expected_revision,
            operation_id: operation_id(args.operation_id),
        },
        &token,
    )?;
    let deleted = match kind {
        Kind::PermissionSet => client.delete_permission_set(input).await?,
        Kind::ContextSet => client.delete_context_set(input).await?,
        Kind::Role => bail!("Retire a Role by replacing its specification with status retired"),
    }
    .into_inner()
    .deleted;
    Ok(json!({ "deleted": deleted }))
}

pub async fn run(connection: Connection, command: PolicyCommand) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let mut client = client(channel);
    let output = match command {
        PolicyCommand::Put {
            kind,
            file,
            expected_revision,
            operation_id: id,
        } => {
            let operation_id = operation_id(id);
            match kind {
                Kind::PermissionSet => permission_json(
                    client
                        .put_permission_set(request(
                            PutPermissionSetRequest {
                                operation_id,
                                expected_revision,
                                permission_set: Some(spec::<PermissionSpec>(&file)?.into()),
                            },
                            &token,
                        )?)
                        .await?
                        .into_inner(),
                ),
                Kind::ContextSet => context_json(
                    client
                        .put_context_set(request(
                            PutContextSetRequest {
                                operation_id,
                                expected_revision,
                                context_set: Some(spec::<ContextSpec>(&file)?.into()),
                            },
                            &token,
                        )?)
                        .await?
                        .into_inner(),
                )?,
                Kind::Role => role_json(
                    client
                        .put_role(request(
                            PutRoleRequest {
                                operation_id,
                                expected_revision,
                                role: Some(spec::<RoleSpec>(&file)?.into()),
                            },
                            &token,
                        )?)
                        .await?
                        .into_inner(),
                ),
            }
        }
        PolicyCommand::Assign {
            role,
            tag_id,
            operation_id: id,
        } => assignment_json(
            client
                .assign_role(request(
                    AssignRoleRequest {
                        role,
                        tag_id,
                        operation_id: operation_id(id),
                    },
                    &token,
                )?)
                .await?
                .into_inner(),
        ),
        PolicyCommand::Assignments {
            role,
            tag,
            active,
            limit,
            cursor,
        } => {
            let status = if active {
                RoleAssignmentStatus::Active
            } else {
                RoleAssignmentStatus::Unspecified
            };
            let page = client
                .list_role_assignments(request(
                    ListRoleAssignmentsRequest {
                        role,
                        tag_id: tag,
                        status: status.into(),
                        limit,
                        cursor,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            json!({ "assignments": page.assignments.into_iter().map(assignment_json).collect::<Vec<_>>(), "next_cursor":page.next_cursor })
        }
        PolicyCommand::Deactivate {
            assignment_id,
            expected_revision,
            operation_id: id,
        } => assignment_json(
            client
                .deactivate_role_assignment(request(
                    DeactivateRoleAssignmentRequest {
                        assignment_id,
                        expected_revision,
                        operation_id: operation_id(id),
                    },
                    &token,
                )?)
                .await?
                .into_inner(),
        ),
    };
    crate::terminal::print_json(&output)?;
    Ok(())
}

pub(crate) fn permission_json(set: PermissionSet) -> Value {
    let permissions = set.permissions.into_iter().map(|grant| json!({
        "permission_id":grant.permission_id, "target":grant.target().as_str_name().trim_start_matches("POLICY_PERMISSION_TARGET_").to_ascii_lowercase(),
        "action":grant.action, "surface_account_id":grant.surface_account_id, "scope":grant.scope,
        "reference":grant.reference, "resource":grant.resource, "approval_required":grant.approval_required,
    })).collect::<Vec<_>>();
    json!({ "set_id":set.set_id, "name":set.name, "revision":set.revision, "approvers":set.approvers, "permissions":permissions })
}

pub(crate) fn context_json(set: ContextSet) -> Result<Value> {
    let items = set.items.into_iter().map(|item| -> Result<Value> {
        Ok(json!({
            "item_id":item.item_id, "item_key":item.item_key, "type":item.r#type,
            "version":item.version, "required":item.required, "config":serde_json::from_str::<Value>(&item.config_json)?,
        }))
    }).collect::<Result<Vec<_>>>()?;
    Ok(json!({ "set_id":set.set_id, "name":set.name, "revision":set.revision, "items":items }))
}

pub(crate) fn role_json(role: Role) -> Value {
    json!({
        "role_id":role.role_id, "name":role.name, "purpose":role.purpose, "instructions":role.instructions,
        "permission_set_ids":role.permission_set_ids, "context_set_ids":role.context_set_ids,
        "status":role.status().as_str_name().trim_start_matches("ROLE_STATUS_").to_ascii_lowercase(), "revision":role.revision,
        "execution":role.execution.map(|execution| json!({ "harness":execution.harness, "models":execution.models, "efforts":execution.efforts, "shared_execution_environment_id":execution.shared_execution_environment_id })),
    })
}

fn assignment_json(value: RoleAssignment) -> Value {
    json!({
        "assignment_id":value.assignment_id, "role_id":value.role_id, "tag_id":value.tag_id,
        "status":value.status().as_str_name().trim_start_matches("ROLE_ASSIGNMENT_STATUS_").to_ascii_lowercase(), "revision":value.revision,
    })
}
