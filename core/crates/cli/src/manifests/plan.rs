use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
};

use anyhow::{Context, Result, bail, ensure};
use sha2::{Digest, Sha256};
use supertag_control_plane::{
    normalize_manifest_context, normalize_manifest_permission, normalize_manifest_role,
    normalize_tag_execution, validate_manifest_account, validate_manifest_location,
    validate_manifest_objective, validate_manifest_workspace,
};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Code, Response, Status};
use uuid::Uuid;

use super::{Kind, MAX_REFERENCES, Manifest, Resource, valid_name};
use crate::request;

pub(super) struct Catalog<'a> {
    token: &'a str,
    operator: operator_client::OperatorClient<ProtocolChannel>,
    policy: policy_catalog_client::PolicyCatalogClient<ProtocolChannel>,
    surfaces: surface_policy_catalog_client::SurfacePolicyCatalogClient<ProtocolChannel>,
    volumes: artifact_volumes_client::ArtifactVolumesClient<ProtocolChannel>,
    workspaces: workspaces_client::WorkspacesClient<ProtocolChannel>,
    teams: teams_client::TeamsClient<ProtocolChannel>,
    objectives: objectives_client::ObjectivesClient<ProtocolChannel>,
    relationships: manifest_relationships_client::ManifestRelationshipsClient<ProtocolChannel>,
    placement: placement_client::PlacementClient<ProtocolChannel>,
    schedules: schedules_client::SchedulesClient<ProtocolChannel>,
    manager: &'a str,
    create_only: bool,
    /// The revision the current resource was planned against, if it exists.
    observed: Option<u64>,
    declared: BTreeMap<Key, Declared>,
    /// The fields the resource being planned sets, with its stored values.
    planned_fields: Vec<ManifestField>,
    /// Each resource's fields, and whether its planned write (if any) succeeded.
    fields: BTreeMap<Key, (Vec<ManifestField>, bool)>,
    /// Each declared Tag as this plan leaves it.
    tag_plans: BTreeMap<String, TagPlan>,
    /// Each declared Permission Set as this plan leaves it, by ID.
    declared_sets: BTreeMap<String, PermissionSet>,
    /// What the plan lets Tags do that they could not before, one line per permission.
    pub(super) gains: Vec<String>,
    /// Existing Tags whose update keeps every execution field they set: written before Roles, so
    /// a Tag override that resolves a new Role conflict lands first.
    early_tags: BTreeSet<String>,
}

/// A declared Tag's settings after the plan, and its Roles: exactly these, or the stored ones
/// with these added and removed.
struct TagPlan {
    policy: crate::tag_policy::TagPolicy,
    exactly: Option<BTreeSet<String>>,
    add: BTreeSet<String>,
    remove: BTreeSet<String>,
}

/// A declared resource of a prunable kind, as this apply leaves it.
struct Declared {
    revision: u64,
    created: bool,
    /// False until a planned write of the resource succeeds.
    applied: bool,
}

/// Kinds an apply set can prune; Surface Accounts and Objectives are never members.
fn prunable(kind: Kind) -> bool {
    !matches!(kind, Kind::SurfaceAccount | Kind::Objective)
}

enum Write {
    Account(PutSurfaceAccountRequest),
    Volume(PutArtifactVolumeRequest),
    Workspace(PutWorkspaceRequest),
    Context(PutContextSetRequest),
    Permission(PutPermissionSetRequest),
    Role(PutRoleRequest),
    Tag(PutTagRequest),
    ProvisionTag(ProvisionTag),
    ProvisionTags(ProvisionTagsRequest),
    Team(CreateTeamRequest),
    UpdateTeam(UpdateTeamRequest),
    Location(PutSurfaceLocationRequest),
    Objective(CreateObjectiveRequest),
    ObjectiveLimits(SetObjectiveLimitsRequest),
    Relationships(ReconcileTagRelationshipsRequest),
    RunsOn(SetTagRunsOnRequest),
    Schedule(PutScheduleRequest),
    AssignRole(AssignRoleRequest),
}

pub(super) struct Change {
    /// The declared resource this change writes.
    key: Option<Key>,
    label: String,
    action: &'static str,
    write: Write,
    details: Vec<String>,
}

impl Change {
    pub(super) fn preview(&self) -> String {
        if self.details.is_empty() {
            format!("{} {}", self.action, crate::terminal::text(&self.label))
        } else {
            self.details
                .iter()
                .map(|detail| crate::terminal::text(detail))
                .collect::<Vec<_>>()
                .join("\n")
        }
    }
}

type Key = (Kind, String);

#[derive(Default)]
struct Declarations {
    ids: BTreeMap<Key, String>,
    accounts: BTreeMap<String, SurfaceAccount>,
    roles: BTreeMap<String, Role>,
    connector_aliases: BTreeSet<String>,
    /// Roles this provisioning creates, which it also gives the existing Tags that list them.
    created_roles: BTreeSet<String>,
}

impl Declarations {
    fn resource_id(&self, kind: Kind, reference: &str) -> Option<&str> {
        self.ids
            .get(&(kind, reference.to_owned()))
            .map(String::as_str)
    }
}

async fn lookup<T>(result: impl Future<Output = Result<Response<T>, Status>>) -> Result<Option<T>> {
    match result.await {
        Ok(response) => Ok(Some(response.into_inner())),
        Err(error) if error.code() == Code::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn missing(kind: Kind, reference: &str) -> anyhow::Error {
    anyhow::anyhow!("missing {kind:?}/{reference}")
}

fn sorted(values: &mut Vec<String>) -> Result<()> {
    ensure!(
        values.len() <= MAX_REFERENCES,
        "too many resource references"
    );
    ensure!(
        values.iter().all(|value| valid_name(value)),
        "invalid resource reference"
    );
    values.sort_unstable();
    values.dedup();
    Ok(())
}

/// Sorts and deduplicates references to other resources, each a resource ID.
fn references(values: &mut Vec<String>, kind: &str) -> Result<()> {
    ensure!(
        values.len() <= MAX_REFERENCES,
        "too many resource references"
    );
    if let Some(_invalid) = values
        .iter()
        .find(|value| !supertag_protocol::valid_resource_id(value))
    {
        bail!(supertag_protocol::resource_id_error(kind));
    }
    values.sort_unstable();
    values.dedup();
    Ok(())
}

fn id() -> String {
    Uuid::new_v4().to_string()
}

impl<'a> Catalog<'a> {
    pub(super) fn new(
        channel: ProtocolChannel,
        token: &'a str,
        manager: &'a str,
        create_only: bool,
    ) -> Result<Self> {
        macro_rules! client {
            ($module:ident, $client:ident) => {
                $module::$client::new(channel.clone())
                    .max_decoding_message_size(MAX_MESSAGE_BYTES)
                    .max_encoding_message_size(MAX_MESSAGE_BYTES)
            };
        }
        ensure!(
            manager.is_empty()
                || (manager.len() <= 63
                    && !matches!(manager, "cli" | "apply")
                    && manager.as_bytes()[0].is_ascii_alphanumeric()
                    && manager.bytes().all(|byte| byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || matches!(byte, b'-' | b'_'))),
            "invalid apply set name"
        );
        Ok(Self {
            token,
            operator: client!(operator_client, OperatorClient),
            policy: client!(policy_catalog_client, PolicyCatalogClient),
            surfaces: client!(surface_policy_catalog_client, SurfacePolicyCatalogClient),
            volumes: client!(artifact_volumes_client, ArtifactVolumesClient),
            workspaces: client!(workspaces_client, WorkspacesClient),
            teams: client!(teams_client, TeamsClient),
            objectives: client!(objectives_client, ObjectivesClient),
            relationships: client!(manifest_relationships_client, ManifestRelationshipsClient),
            placement: client!(placement_client, PlacementClient),
            schedules: client!(schedules_client, SchedulesClient),
            manager,
            create_only,
            observed: None,
            declared: BTreeMap::new(),
            planned_fields: Vec::new(),
            fields: BTreeMap::new(),
            tag_plans: BTreeMap::new(),
            declared_sets: BTreeMap::new(),
            gains: Vec::new(),
            early_tags: BTreeSet::new(),
        })
    }

    pub(super) async fn plan(&mut self, manifests: Vec<Manifest>) -> Result<Vec<Change>> {
        let mut declarations = Declarations::default();
        let mut changes = Vec::new();
        let mut followups = Vec::new();
        for item in &manifests {
            if item.kind == Kind::Tag {
                declarations
                    .ids
                    .insert((Kind::Tag, item.name.clone()), item.name.clone());
            }
        }
        for item in manifests {
            let name = item.name;
            let label = format!("{:?}/{name}", item.kind);
            self.observed = None;
            self.planned_fields.clear();
            let change = self
                .plan_resource(item.resource, &name, &mut declarations, &mut followups)
                .await
                .with_context(|| format!("{label} from {}", item.source))?;
            let key = (item.kind, name.clone());
            if !self.create_only && !self.planned_fields.is_empty() {
                self.fields.insert(
                    key.clone(),
                    (std::mem::take(&mut self.planned_fields), change.is_none()),
                );
            }
            if prunable(item.kind) {
                self.declared.insert(
                    key.clone(),
                    Declared {
                        revision: self.observed.unwrap_or_default(),
                        created: self.observed.is_none(),
                        applied: change.is_none(),
                    },
                );
            }
            if let Some((exists, write)) = change {
                changes.push(Change {
                    key: Some(key),
                    label,
                    action: if exists { "update" } else { "create" },
                    write,
                    details: vec![],
                });
            }
        }
        if self.create_only {
            let mut tags = Vec::new();
            changes.retain_mut(|change| {
                if let Write::ProvisionTag(tag) = &mut change.write {
                    tags.push(std::mem::take(tag));
                    return false;
                }
                true
            });
            if !tags.is_empty() {
                let insert_at = changes.iter().position(|change| {
                    matches!(
                        change.write,
                        Write::Team(_) | Write::Location(_) | Write::Objective(_)
                    )
                });
                let index = insert_at.unwrap_or(changes.len());
                changes.insert(
                    index,
                    Change {
                        key: None,
                        label: "provisioned Tags".into(),
                        action: "create",
                        write: Write::ProvisionTags(ProvisionTagsRequest { tags }),
                        details: vec![],
                    },
                );
            }
        }
        // Assignments affect the policy frozen on an Objective's first Task.
        let objectives = changes.partition_point(|change| {
            !matches!(
                change.write,
                Write::Objective(_) | Write::ObjectiveLimits(_)
            )
        });
        changes.splice(objectives..objectives, followups);
        if let Some(roles) = changes
            .iter()
            .position(|change| matches!(change.write, Write::Role(_)))
        {
            let mut early = Vec::new();
            let mut index = roles;
            while index < changes.len() {
                if matches!(&changes[index].write, Write::Tag(tag) if self.early_tags.contains(&tag.tag_id))
                {
                    early.push(changes.remove(index));
                } else {
                    index += 1;
                }
            }
            changes.splice(roles..roles, early);
        }
        self.policy_effects(&declarations).await?;
        Ok(changes)
    }

    /// Refuses a plan that leaves a Tag's Roles with conflicting execution settings, and records
    /// what it lets each existing Tag do that the Tag could not before. It looks at the declared
    /// Tags, and the Tags that hold a declared Role or a Role naming a declared Permission Set.
    async fn policy_effects(&mut self, declarations: &Declarations) -> Result<()> {
        use crate::tag_policy::{TagPolicy, fill_sets, gains, holders, read};
        let mut roles: BTreeSet<String> = declarations.roles.keys().cloned().collect();
        if !self.declared_sets.is_empty() {
            let mut cursor = String::new();
            loop {
                let page = self
                    .policy
                    .list_roles(request(
                        ListPolicyResourcesRequest { limit: 100, cursor },
                        self.token,
                    )?)
                    .await?
                    .into_inner();
                roles.extend(
                    page.roles
                        .iter()
                        .filter(|role| {
                            role.permission_set_ids
                                .iter()
                                .any(|id| self.declared_sets.contains_key(id))
                        })
                        .map(|role| role.role_id.clone()),
                );
                if page.next_cursor.is_empty() {
                    break;
                }
                cursor = page.next_cursor;
            }
        }
        let mut tags: BTreeSet<String> = self.tag_plans.keys().cloned().collect();
        for role in &roles {
            tags.extend(holders(&mut self.policy, self.token, role).await?);
        }
        for tag in tags {
            let before = match self.tag(&tag).await? {
                Some(_) => {
                    Some(read(&mut self.operator, &mut self.policy, self.token, &tag).await?)
                }
                None => None,
            };
            let mut after = before.clone().unwrap_or_else(|| TagPolicy {
                tag_id: tag.clone(),
                ..Default::default()
            });
            let plan = self.tag_plans.get(&tag);
            if let Some(plan) = plan {
                after
                    .allowed_actions
                    .clone_from(&plan.policy.allowed_actions);
                after.harness_kind = plan.policy.harness_kind;
                after.execution.clone_from(&plan.policy.execution);
            }
            let ids: BTreeSet<String> = match plan {
                Some(TagPlan {
                    exactly: Some(ids), ..
                }) => ids.clone(),
                _ => {
                    let mut ids: BTreeSet<String> = after
                        .roles
                        .iter()
                        .map(|role| role.role_id.clone())
                        .collect();
                    if let Some(plan) = plan {
                        ids.extend(plan.add.iter().cloned());
                        ids.retain(|id| !plan.remove.contains(id));
                    }
                    ids
                }
            };
            let stored = std::mem::take(&mut after.roles);
            for id in ids {
                let role = match declarations.roles.get(&id) {
                    Some(role) => role.clone(),
                    None => match stored.iter().find(|role| role.role_id == id) {
                        Some(role) => role.clone(),
                        None => self
                            .policy
                            .get_role(request(
                                GetPolicyResourceRequest { reference: id },
                                self.token,
                            )?)
                            .await?
                            .into_inner(),
                    },
                };
                if role.status == RoleStatus::Active as i32 {
                    after.roles.push(role);
                }
            }
            fill_sets(
                &mut after,
                &mut self.policy,
                self.token,
                &self.declared_sets,
            )
            .await?;
            if let Err(conflict) = after.execution() {
                bail!(conflict);
            }
            // A new Tag's permissions show as its creation and Role assignments.
            if before.is_some() {
                self.gains.extend(gains(before.as_ref(), &after));
            }
        }
        Ok(())
    }

    async fn plan_resource(
        &mut self,
        resource: Resource,
        name: &str,
        declarations: &mut Declarations,
        followups: &mut Vec<Change>,
    ) -> Result<Option<(bool, Write)>> {
        let token = self.token;
        let reference = || GetPolicyResourceRequest {
            reference: name.into(),
        };
        let changes = match resource {
            Resource::SurfaceAccount(mut value) => {
                validate_manifest_account(&value)?;
                ensure!(
                    !declarations
                        .accounts
                        .values()
                        .any(|account| account.identity == value.identity),
                    "two manifests declare the same Surface Account identity"
                );
                let prior = lookup(self.surfaces.get_surface_account(request(
                    GetSurfaceAccountRequest {
                        account_id: name.into(),
                    },
                    token,
                )?))
                .await?;
                if self.create_only
                    && let Some(prior) = prior
                {
                    declarations.accounts.insert(name.into(), prior);
                    return Ok(None);
                }
                let revision = prior.as_ref().map(|prior| prior.revision);
                ensure!(
                    prior
                        .as_ref()
                        .is_none_or(|prior| prior.identity == value.identity),
                    "Surface Account identity is immutable"
                );
                declarations.accounts.insert(name.into(), value.clone());
                value.revision = revision.unwrap_or_default();
                self.planned_fields = vec![
                    field(
                        "spec.identity",
                        prior.as_ref().map(|v| message(&v.identity)),
                        message(&value.identity),
                    ),
                    field(
                        "spec.enabled",
                        prior.as_ref().map(|v| flag(v.enabled)),
                        flag(value.enabled),
                    ),
                ];
                (prior.as_ref() != Some(&value)).then(|| {
                    (
                        prior.is_some(),
                        Write::Account(PutSurfaceAccountRequest {
                            operation_id: id(),
                            account: Some(value),
                            expected_revision: revision,
                        }),
                    )
                })
            }
            Resource::Volume(source) => {
                supertag_protocol::volumes::validate_volume_source(&source)?;
                let prior = lookup(self.volumes.get(request(
                    GetArtifactVolumeRequest {
                        volume_id: name.into(),
                    },
                    token,
                )?))
                .await?;
                self.observed = prior.as_ref().map(|value| value.revision);
                if self.create_only && prior.is_some() {
                    return Ok(None);
                }
                self.planned_fields = vec![field(
                    "spec.source",
                    prior.as_ref().map(|v| v.source.as_bytes().to_vec()),
                    source.as_bytes().to_vec(),
                )];
                prior
                    .as_ref()
                    .is_none_or(|value| value.source != source)
                    .then(|| {
                        (
                            prior.is_some(),
                            Write::Volume(PutArtifactVolumeRequest {
                                operation_id: id(),
                                volume_id: name.into(),
                                source,
                                expected_revision: prior.map_or(0, |value| value.revision),
                            }),
                        )
                    })
            }
            Resource::Workspace(mut value) => {
                let prior = lookup(self.workspaces.get(request(
                    GetWorkspaceRequest {
                        workspace_id: name.into(),
                    },
                    token,
                )?))
                .await?;
                self.observed = prior.as_ref().map(|value| value.revision);
                if self.create_only && prior.is_some() {
                    declarations
                        .ids
                        .insert((Kind::Workspace, name.into()), name.into());
                    return Ok(None);
                }
                validate_manifest_workspace(&mut value)?;
                let revision = prior.as_ref().map(|value| value.revision);
                value.revision = revision.unwrap_or_default();
                declarations
                    .ids
                    .insert((Kind::Workspace, name.into()), name.into());
                self.planned_fields = vec![
                    field(
                        "spec.remote",
                        prior.as_ref().map(|v| v.remote.as_bytes().to_vec()),
                        value.remote.as_bytes().to_vec(),
                    ),
                    field(
                        "spec.ref",
                        prior.as_ref().map(|v| v.r#ref.as_bytes().to_vec()),
                        value.r#ref.as_bytes().to_vec(),
                    ),
                    field(
                        "spec.credentials",
                        prior.as_ref().map(|v| message(&v.credentials)),
                        message(&value.credentials),
                    ),
                    field(
                        "spec.land",
                        prior.as_ref().map(|v| message(&v.land)),
                        message(&value.land),
                    ),
                    field(
                        "spec.forge",
                        prior.as_ref().map(|v| v.forge.to_le_bytes().to_vec()),
                        value.forge.to_le_bytes().to_vec(),
                    ),
                ];
                (prior.as_ref() != Some(&value)).then(|| {
                    (
                        prior.is_some(),
                        Write::Workspace(PutWorkspaceRequest {
                            operation_id: id(),
                            workspace: Some(value),
                            expected_revision: revision,
                        }),
                    )
                })
            }
            Resource::ContextSet(mut value) => {
                let prior =
                    lookup(self.policy.get_context_set(request(reference(), token)?)).await?;
                self.observed = prior.as_ref().map(|value| value.revision);
                if self.create_only
                    && let Some(prior) = prior
                {
                    declarations
                        .ids
                        .insert((Kind::ContextSet, name.into()), prior.set_id);
                    return Ok(None);
                }
                let named = display_name(&mut value.name, prior.as_ref().map(|v| &v.name), name);
                normalize_manifest_context(&mut value, prior.as_ref())?;
                let revision = prior.as_ref().map(|value| value.revision);
                preserve_identity(
                    &mut value.set_id,
                    prior.as_ref().map(|value| value.set_id.as_str()),
                )?;
                value.revision = revision.unwrap_or_default();
                declarations
                    .ids
                    .insert((Kind::ContextSet, name.into()), value.set_id.clone());
                clear_context_ids(&mut value);
                let mut previous = prior;
                if let Some(previous) = &mut previous {
                    clear_context_ids(previous);
                }
                self.planned_fields = vec![field(
                    "spec.items",
                    previous.as_ref().map(|v| messages(&v.items)),
                    messages(&value.items),
                )];
                if named {
                    self.planned_fields.push(display_field(
                        previous.as_ref().map(|v| &v.name),
                        &value.name,
                    ));
                }
                (previous.as_ref() != Some(&value)).then(|| {
                    (
                        previous.is_some(),
                        Write::Context(PutContextSetRequest {
                            operation_id: id(),
                            expected_revision: revision,
                            context_set: Some(value),
                        }),
                    )
                })
            }
            Resource::PermissionSet(mut value) => {
                let prior =
                    lookup(self.policy.get_permission_set(request(reference(), token)?)).await?;
                self.observed = prior.as_ref().map(|value| value.revision);
                if self.create_only
                    && let Some(prior) = prior
                {
                    declarations
                        .ids
                        .insert((Kind::PermissionSet, name.into()), prior.set_id);
                    return Ok(None);
                }
                let named = display_name(&mut value.name, prior.as_ref().map(|v| &v.name), name);
                normalize_manifest_permission(&mut value, prior.as_ref())?;
                let revision = prior.as_ref().map(|value| value.revision);
                preserve_identity(
                    &mut value.set_id,
                    prior.as_ref().map(|value| value.set_id.as_str()),
                )?;
                value.revision = revision.unwrap_or_default();
                declarations
                    .ids
                    .insert((Kind::PermissionSet, name.into()), value.set_id.clone());
                self.declared_sets
                    .insert(value.set_id.clone(), value.clone());
                for grant in &mut value.permissions {
                    grant.permission_id.clear();
                }
                let mut previous = prior;
                if let Some(prior) = &mut previous {
                    for grant in &mut prior.permissions {
                        grant.permission_id.clear();
                    }
                }
                self.planned_fields = vec![
                    field(
                        "spec.approvers",
                        previous.as_ref().map(|v| list(&v.approvers)),
                        list(&value.approvers),
                    ),
                    field(
                        "spec.permissions",
                        previous.as_ref().map(|v| messages(&v.permissions)),
                        messages(&value.permissions),
                    ),
                ];
                if named {
                    self.planned_fields.push(display_field(
                        previous.as_ref().map(|v| &v.name),
                        &value.name,
                    ));
                }
                (previous.as_ref() != Some(&value)).then(|| {
                    (
                        previous.is_some(),
                        Write::Permission(PutPermissionSetRequest {
                            operation_id: id(),
                            expected_revision: revision,
                            permission_set: Some(value),
                        }),
                    )
                })
            }
            Resource::Role(mut value) => {
                let prior = lookup(self.policy.get_role(request(reference(), token)?)).await?;
                self.observed = prior.as_ref().map(|value| value.revision);
                if self.create_only
                    && let Some(prior) = prior
                {
                    return self
                        .provision_role_sets(value, prior, name, declarations)
                        .await;
                }
                if self.create_only {
                    declarations.created_roles.insert(name.into());
                }
                let named = display_name(&mut value.name, prior.as_ref().map(|v| &v.name), name);
                normalize_manifest_role(&mut value, prior.as_ref())?;
                self.resolve_sets(
                    declarations,
                    Kind::PermissionSet,
                    &mut value.permission_set_ids,
                )
                .await?;
                self.resolve_sets(declarations, Kind::ContextSet, &mut value.context_set_ids)
                    .await?;
                let revision = prior.as_ref().map(|value| value.revision);
                preserve_identity(
                    &mut value.role_id,
                    prior.as_ref().map(|value| value.role_id.as_str()),
                )?;
                value.revision = revision.unwrap_or_default();
                declarations.roles.insert(name.into(), value.clone());
                let old = prior.as_ref();
                self.planned_fields = vec![
                    field(
                        "spec.purpose",
                        old.map(|v| v.purpose.as_bytes().to_vec()),
                        value.purpose.as_bytes().to_vec(),
                    ),
                    field(
                        "spec.instructions",
                        old.map(|v| v.instructions.as_bytes().to_vec()),
                        value.instructions.as_bytes().to_vec(),
                    ),
                    field(
                        "spec.permissionSets",
                        old.map(|v| list(&v.permission_set_ids)),
                        list(&value.permission_set_ids),
                    ),
                    field(
                        "spec.contextSets",
                        old.map(|v| list(&v.context_set_ids)),
                        list(&value.context_set_ids),
                    ),
                    field(
                        "spec.status",
                        old.map(|v| number(v.status.into())),
                        number(value.status.into()),
                    ),
                    field(
                        "spec.execution",
                        old.map(|v| message(&v.execution)),
                        message(&value.execution),
                    ),
                ];
                if named {
                    self.planned_fields
                        .push(display_field(old.map(|v| &v.name), &value.name));
                }
                (prior.as_ref() != Some(&value)).then(|| {
                    (
                        prior.is_some(),
                        Write::Role(PutRoleRequest {
                            operation_id: id(),
                            expected_revision: revision,
                            role: Some(value),
                        }),
                    )
                })
            }
            Resource::Tag(spec) => return self.plan_tag(spec, name, declarations, followups).await,
            Resource::Team(spec) => return self.plan_team(spec, name, declarations).await,
            Resource::SurfaceLocation(mut value) => {
                let prior = lookup(self.surfaces.get_surface_location(request(
                    GetSurfaceLocationRequest {
                        location_id: name.into(),
                    },
                    token,
                )?))
                .await?;
                self.observed = prior.as_ref().map(|value| value.revision);
                if self.create_only && prior.is_some() {
                    return Ok(None);
                }
                let account = self.account(declarations, &value.account_id).await?;
                validate_manifest_location(&value, &account)?;
                ensure!(
                    declarations
                        .connector_aliases
                        .insert(value.connector_account_id.clone()),
                    "two manifests declare the same connector account alias"
                );
                self.require_tag(declarations, &value.tag_id).await?;
                self.resolve_sets(
                    declarations,
                    Kind::PermissionSet,
                    &mut value.permission_set_ids,
                )
                .await?;
                self.resolve_sets(declarations, Kind::ContextSet, &mut value.context_set_ids)
                    .await?;
                ensure!(
                    prior
                        .as_ref()
                        .is_none_or(|prior| prior.account_id == value.account_id
                            && prior.connector_account_id == value.connector_account_id
                            && prior.scope == value.scope
                            && prior.tag_id == value.tag_id),
                    "Surface location identity and owning Tag are immutable"
                );
                let revision = prior.as_ref().map(|value| value.revision);
                value.revision = revision.unwrap_or_default();
                let old = prior.as_ref();
                self.planned_fields = vec![
                    field(
                        "spec.enabled",
                        old.map(|v| flag(v.enabled)),
                        flag(value.enabled),
                    ),
                    field(
                        "spec.permissionSets",
                        old.map(|v| list(&v.permission_set_ids)),
                        list(&value.permission_set_ids),
                    ),
                    field(
                        "spec.contextSets",
                        old.map(|v| list(&v.context_set_ids)),
                        list(&value.context_set_ids),
                    ),
                ];
                (prior.as_ref() != Some(&value)).then(|| {
                    (
                        prior.is_some(),
                        Write::Location(PutSurfaceLocationRequest {
                            operation_id: id(),
                            expected_revision: revision,
                            location: Some(value),
                        }),
                    )
                })
            }
            Resource::Objective(spec) => {
                return self.plan_objective(spec, name, declarations).await;
            }
            Resource::Schedule(spec) => {
                let prior = lookup(self.schedules.get(request(
                    GetScheduleRequest {
                        schedule_id: name.into(),
                    },
                    token,
                )?))
                .await?;
                self.observed = prior.as_ref().map(|value| value.revision);
                if self.create_only && prior.is_some() {
                    return Ok(None);
                }
                self.require_tag(declarations, &spec.tag).await?;
                let old = prior.as_ref();
                let every = |value: &Schedule| {
                    value
                        .every
                        .as_ref()
                        .map(|every| every.cron.as_bytes().to_vec())
                        .unwrap_or_default()
                };
                let zone = |value: &Schedule| {
                    value
                        .every
                        .as_ref()
                        .map(|every| every.time_zone.as_bytes().to_vec())
                        .unwrap_or_default()
                };
                self.planned_fields = vec![
                    field(
                        "spec.tag",
                        old.map(|v| v.tag_id.as_bytes().to_vec()),
                        spec.tag.as_bytes().to_vec(),
                    ),
                    field("spec.every", old.map(every), spec.every.as_bytes().to_vec()),
                    field(
                        "spec.note",
                        old.map(|v| v.note.as_bytes().to_vec()),
                        spec.note.trim().as_bytes().to_vec(),
                    ),
                ];
                if let Some(time_zone) = &spec.time_zone {
                    self.planned_fields.push(field(
                        "spec.timeZone",
                        old.map(zone),
                        time_zone.as_bytes().to_vec(),
                    ));
                }
                let unchanged = old.is_some_and(|value| {
                    matches!(value.state(), ScheduleState::Active | ScheduleState::Paused)
                        && value.tag_id == spec.tag
                        && value.note == spec.note.trim()
                        && value.every.as_ref().is_some_and(|every| {
                            every.cron == spec.every.trim()
                                && spec
                                    .time_zone
                                    .as_deref()
                                    .is_none_or(|zone| every.time_zone == zone)
                        })
                });
                (!unchanged).then(|| {
                    (
                        prior.is_some(),
                        Write::Schedule(PutScheduleRequest {
                            schedule_id: name.into(),
                            tag_id: spec.tag,
                            note: spec.note,
                            every: spec.every,
                            time_zone: spec.time_zone,
                        }),
                    )
                })
            }
        };
        Ok(changes)
    }

    async fn account(&mut self, declarations: &Declarations, id: &str) -> Result<SurfaceAccount> {
        if let Some(value) = declarations.accounts.get(id) {
            return Ok(value.clone());
        }
        lookup(self.surfaces.get_surface_account(request(
            GetSurfaceAccountRequest {
                account_id: id.into(),
            },
            self.token,
        )?))
        .await?
        .ok_or_else(|| missing(Kind::SurfaceAccount, id))
    }

    async fn resolve_sets(
        &mut self,
        declarations: &Declarations,
        kind: Kind,
        ids: &mut Vec<String>,
    ) -> Result<()> {
        let label = match kind {
            Kind::ContextSet => "a Context Set reference",
            _ => "a Permission Set reference",
        };
        references(ids, label)?;
        for reference in ids.iter_mut() {
            if let Some(value) = declarations.resource_id(kind, reference) {
                *reference = value.into();
                continue;
            }
            let input = request(
                GetPolicyResourceRequest {
                    reference: reference.clone(),
                },
                self.token,
            )?;
            let value = match kind {
                Kind::ContextSet => lookup(self.policy.get_context_set(input))
                    .await?
                    .map(|value| value.set_id),
                Kind::PermissionSet => lookup(self.policy.get_permission_set(input))
                    .await?
                    .map(|value| value.set_id),
                _ => unreachable!("only Set references are resolved"),
            };
            *reference = value.ok_or_else(|| missing(kind, reference))?;
        }
        references(ids, label)
    }

    /// Provisioning leaves an existing Role as it is, except that the Role gains each Permission Set
    /// and Context Set its manifest lists that it lacks, such as the `skills` Context Set a later
    /// `supertag init` adds. It never loses a Set, and a retired Role is left alone.
    async fn provision_role_sets(
        &mut self,
        mut declared: Role,
        mut prior: Role,
        name: &str,
        declarations: &mut Declarations,
    ) -> Result<Option<(bool, Write)>> {
        if prior.status != RoleStatus::Active as i32 {
            declarations.roles.insert(name.into(), prior);
            return Ok(None);
        }
        self.resolve_sets(
            declarations,
            Kind::PermissionSet,
            &mut declared.permission_set_ids,
        )
        .await?;
        self.resolve_sets(
            declarations,
            Kind::ContextSet,
            &mut declared.context_set_ids,
        )
        .await?;
        let mut changed = false;
        for (stored, wanted) in [
            (&mut prior.permission_set_ids, declared.permission_set_ids),
            (&mut prior.context_set_ids, declared.context_set_ids),
        ] {
            for id in wanted {
                if !stored.contains(&id) {
                    stored.push(id);
                    changed = true;
                }
            }
            stored.sort_unstable();
        }
        declarations.roles.insert(name.into(), prior.clone());
        Ok(changed.then(|| {
            (
                true,
                Write::Role(PutRoleRequest {
                    operation_id: id(),
                    expected_revision: Some(prior.revision),
                    role: Some(prior),
                }),
            )
        }))
    }

    async fn tag(&mut self, id: &str) -> Result<Option<Tag>> {
        lookup(
            self.operator
                .get_tag(request(GetTagRequest { tag_id: id.into() }, self.token)?),
        )
        .await
    }

    async fn require_tag(&mut self, declarations: &Declarations, id: &str) -> Result<()> {
        if declarations.resource_id(Kind::Tag, id).is_some() {
            return Ok(());
        }
        let value = self.tag(id).await?.ok_or_else(|| missing(Kind::Tag, id))?;
        ensure!(value.retired_at_ms.is_none(), "Tag/{id} is retired");
        Ok(())
    }

    async fn require_workspace(&mut self, declarations: &Declarations, id: &str) -> Result<()> {
        if declarations.resource_id(Kind::Workspace, id).is_none() {
            lookup(self.workspaces.get(request(
                GetWorkspaceRequest {
                    workspace_id: id.into(),
                },
                self.token,
            )?))
            .await?
            .ok_or_else(|| missing(Kind::Workspace, id))?;
        }
        Ok(())
    }

    async fn plan_tag(
        &mut self,
        mut spec: super::TagSpec,
        name: &str,
        declarations: &Declarations,
        followups: &mut Vec<Change>,
    ) -> Result<Option<(bool, Write)>> {
        let prior = self.tag(name).await?;
        self.observed = prior.as_ref().map(|value| value.revision);
        if self.create_only && prior.is_some() {
            // Provisioning leaves an existing Tag as it is, except that it gives the Tag each
            // Role it lists that this provisioning creates, such as a Role renamed to follow the
            // resource ID rule.
            references(&mut spec.roles, "a Role reference")?;
            let created: BTreeSet<String> = spec
                .roles
                .iter()
                .filter(|role| declarations.created_roles.contains(*role))
                .cloned()
                .collect();
            if let Some(prior) = &prior {
                self.tag_plans.insert(
                    name.into(),
                    TagPlan {
                        policy: crate::tag_policy::TagPolicy::of(prior),
                        exactly: None,
                        add: created.clone(),
                        remove: BTreeSet::new(),
                    },
                );
            }
            for role in &created {
                followups.push(Change {
                    key: None,
                    label: format!("Tag/{name} Role/{role}"),
                    action: "assign",
                    details: vec![format!("assign Role/{role} to Tag/{name}")],
                    write: Write::AssignRole(AssignRoleRequest {
                        operation_id: id(),
                        role: role.clone(),
                        tag_id: name.into(),
                    }),
                });
            }
            return Ok(None);
        }
        ensure!(
            prior
                .as_ref()
                .is_none_or(|prior| prior.retired_at_ms.is_none()),
            "Tag is retired"
        );
        let declared = [
            spec.instructions.is_some(),
            spec.allowed_actions.is_some(),
            spec.workspace.is_some(),
            spec.execution.is_some(),
            spec.lead.is_some(),
            spec.max_work_sessions.is_some(),
            spec.memory.is_some(),
            spec.start_rate.is_some(),
            spec.volume.is_some(),
            spec.display_name.is_some(),
        ];
        let mut value = PutTagRequest {
            tag_id: name.into(),
            name: spec
                .display_name
                .or_else(|| prior.as_ref().map(|prior| prior.name.clone())),
            instructions: spec.instructions.unwrap_or_else(|| {
                prior
                    .as_ref()
                    .map_or_else(String::new, |prior| prior.instructions.clone())
            }),
            allowed_actions: spec.allowed_actions.unwrap_or_else(|| {
                prior
                    .as_ref()
                    .map_or_else(Vec::new, |prior| prior.allowed_actions.clone())
            }),
            workspace: prior.as_ref().and_then(|prior| prior.workspace.clone()),
            harness_kind: prior.as_ref().map_or(0, |prior| prior.harness_kind),
            approval_rules: prior
                .as_ref()
                .map_or_else(Vec::new, |prior| prior.approval_rules.clone()),
            execution: prior.as_ref().and_then(|prior| prior.execution.clone()),
            expected_revision: Some(prior.as_ref().map_or(0, |tag| tag.revision)),
            lead: spec.lead,
            max_work_sessions: spec.max_work_sessions,
            memory: spec.memory,
            start_rate: spec
                .start_rate
                .map(|rate| {
                    if rate.starts == 0 {
                        return Ok(StartRate::default());
                    }
                    crate::tags::parse_start_rate(&format!("{}/{}", rate.starts, rate.per))
                        .map_err(|error| anyhow::anyhow!("spec.startRate: {error}"))
                })
                .transpose()?,
            volume: spec.volume,
        };
        ensure!(
            value.instructions.len() <= 65_536,
            "Tag instructions exceed 64 KiB"
        );
        sorted(&mut value.allowed_actions)?;
        ensure!(
            value.allowed_actions.len() <= 256,
            "too many Tag allowed actions"
        );
        if let Some(workspace) = spec.workspace {
            ensure!(
                supertag_protocol::valid_resource_id(&workspace.id),
                supertag_protocol::resource_id_error("spec.workspace.id")
            );
            let base_commit = workspace.base_commit.unwrap_or_default();
            let base_ref = workspace.base_ref.unwrap_or_default();
            ensure!(
                base_commit.is_empty() || base_ref.is_empty(),
                "a Tag Workspace sets baseCommit or ref, not both"
            );
            if !base_commit.is_empty() {
                ensure!(
                    supertag_protocol::valid_git_commit(&base_commit),
                    "invalid Workspace commit"
                );
            } else if !base_ref.is_empty() {
                ensure!(
                    supertag_protocol::valid_git_branch(&base_ref),
                    "Workspace ref must be a branch name such as main"
                );
            } else {
                self.require_workspace(declarations, &workspace.id).await?;
            }
            let mut mcp_servers = workspace.mcp;
            ensure!(
                supertag_protocol::mcp::normalize_workspace_servers(&mut mcp_servers),
                "invalid Workspace MCP server name"
            );
            value.workspace = Some(WorkspaceSpec {
                mcp_servers,
                mounts: vec![],
                workspace_id: workspace.id,
                base_commit,
                base_ref,
                ..Default::default()
            });
        }
        if let Some(execution) = spec.execution {
            let (kind, execution) =
                normalize_tag_execution(HarnessKind::Unspecified, Some(execution.into()))?;
            value.harness_kind = kind.into();
            value.execution = execution;
        }
        if let Some(reason) = prior.as_ref().and_then(|prior| {
            supertag_protocol::harness_change_refusal(
                name,
                prior.harness_kind(),
                value.harness_kind(),
            )
        }) {
            bail!("{reason}");
        }
        ensure!(
            value.workspace.is_none()
                || value
                    .execution
                    .as_ref()
                    .is_none_or(|settings| settings.shared_execution_environment_id.is_none()),
            "shared execution cannot use a pinned Git Workspace"
        );
        references(&mut spec.roles, "a Role reference")?;
        let mut role_ids = BTreeMap::new();
        for reference in spec.roles {
            let role = if let Some(role) = declarations.roles.get(&reference) {
                role.clone()
            } else {
                lookup(self.policy.get_role(request(
                    GetPolicyResourceRequest {
                        reference: reference.clone(),
                    },
                    self.token,
                )?))
                .await?
                .ok_or_else(|| missing(Kind::Role, &reference))?
            };
            ensure!(
                role.status == RoleStatus::Active as i32,
                "Role/{reference} is retired"
            );
            role_ids.insert(role.role_id, reference);
        }
        references(
            &mut spec.accepts_messages_from,
            "an acceptsMessagesFrom Tag",
        )?;
        ensure!(
            role_ids.len() + spec.accepts_messages_from.len() <= MAX_REFERENCES,
            "too many Tag relationships"
        );
        for sender in &spec.accepts_messages_from {
            ensure!(
                sender != name,
                "a Mailbox grant cannot name its own recipient"
            );
            self.require_tag(declarations, sender).await?;
        }
        let runs_on = spec.runs_on.take().map(|labels| {
            let mut labels: Vec<String> = labels
                .iter()
                .map(|label| label.trim().to_ascii_lowercase())
                .collect();
            labels.sort_unstable();
            labels.dedup();
            labels
        });
        // Provisioning only creates Tags, so it sets their labels outright; an apply merges its
        // labels by value with those other managers and the CLI added.
        if let Some(runs_on) = runs_on
            .clone()
            .filter(|labels| self.create_only && !labels.is_empty())
        {
            followups.push(Change {
                key: None,
                label: format!("Tag/{name} runsOn"),
                action: "set",
                details: vec![format!("set Tag/{name} runsOn to [{}]", runs_on.join(", "))],
                write: Write::RunsOn(SetTagRunsOnRequest {
                    tag_id: name.into(),
                    runs_on,
                }),
            });
        }
        let mut reconciliation = ReconcileTagRelationshipsRequest {
            tag_id: name.into(),
            manager: self.manager.into(),
            role_ids: role_ids.keys().cloned().collect(),
            mailbox_senders: spec.accepts_messages_from,
            preview: true,
            runs_on: runs_on
                .filter(|_| !self.create_only)
                .map(|labels| TagRunsOnLabels { labels }),
        };
        self.tag_plans.insert(
            name.into(),
            TagPlan {
                policy: crate::tag_policy::TagPolicy {
                    tag_id: name.into(),
                    allowed_actions: value.allowed_actions.clone(),
                    harness_kind: value.harness_kind,
                    execution: value.execution.clone(),
                    ..Default::default()
                },
                exactly: prior.is_none().then(|| role_ids.keys().cloned().collect()),
                add: BTreeSet::new(),
                remove: BTreeSet::new(),
            },
        );
        if self.create_only {
            return Ok(Some((
                false,
                Write::ProvisionTag(ProvisionTag {
                    tag: Some(value),
                    role_ids: reconciliation.role_ids,
                    mailbox_senders: reconciliation.mailbox_senders,
                }),
            )));
        }
        let details =
            if prior.is_some() {
                let response = self
                    .relationships
                    .reconcile_tag(request(reconciliation.clone(), self.token)?)
                    .await?
                    .into_inner();
                if let Some(plan) = self.tag_plans.get_mut(name) {
                    for change in response.changes.iter().filter(|c| !c.ownership_only) {
                        if let Some(role) = change
                            .path
                            .strip_prefix("spec.roles[")
                            .and_then(|value| value.strip_suffix(']'))
                        {
                            if change.present {
                                plan.add.insert(role.into());
                            } else {
                                plan.remove.insert(role.into());
                            }
                        }
                    }
                }
                response
                    .changes
                    .into_iter()
                    .map(|change| relationship_preview(name, &role_ids, change))
                    .collect::<Vec<_>>()
            } else {
                role_ids
                    .values()
                    .map(|role| format!("assign Role/{role} to Tag/{name}"))
                    .chain(reconciliation.mailbox_senders.iter().map(|sender| {
                        format!("grant Mailbox access from Tag/{sender} to Tag/{name}")
                    }))
                    .chain(
                        reconciliation
                            .runs_on
                            .iter()
                            .flat_map(|runs_on| &runs_on.labels)
                            .map(|label| format!("add runsOn label {label} to Tag/{name}")),
                    )
                    .collect()
            };
        if !details.is_empty() {
            reconciliation.preview = false;
            followups.push(Change {
                key: None,
                label: format!("Tag/{name} relationships"),
                action: "reconcile",
                write: Write::Relationships(reconciliation),
                details,
            });
        }
        let old = prior.as_ref();
        let execution = |kind: i32, execution: &Option<PolicyExecutionSettings>| {
            let mut bytes = number(kind.into());
            bytes.extend(message(execution));
            bytes
        };
        self.planned_fields = [
            field(
                "spec.instructions",
                old.map(|v| v.instructions.as_bytes().to_vec()),
                value.instructions.as_bytes().to_vec(),
            ),
            field(
                "spec.allowedActions",
                old.map(|v| list(&v.allowed_actions)),
                list(&value.allowed_actions),
            ),
            field(
                "spec.workspace",
                old.map(|v| message(&v.workspace)),
                message(&value.workspace),
            ),
            field(
                "spec.execution",
                old.map(|v| execution(v.harness_kind, &v.execution)),
                execution(value.harness_kind, &value.execution),
            ),
            // Not the lead is the unset value, which no manager owns.
            field(
                "spec.lead",
                old.map(|v| flag(v.lead)),
                flag(value.lead.unwrap_or_default()),
            ),
            // The default, 8, is the unset value, which no manager owns.
            field(
                "spec.maxWorkSessions",
                old.map(|v| work_session_limit(v.max_work_sessions)),
                work_session_limit(value.max_work_sessions.unwrap_or(8)),
            ),
            // Keeping memory is the unset value, which no manager owns.
            field(
                "spec.memory",
                old.map(|v| flag(!v.memory)),
                flag(!value.memory.unwrap_or(true)),
            ),
            // No start rate is the unset value, which no manager owns.
            field(
                "spec.startRate",
                old.map(|v| start_rate(v.start_rate.as_ref())),
                start_rate(value.start_rate.as_ref().filter(|rate| rate.starts > 0)),
            ),
            // No Volume is the unset value, which no manager owns.
            field(
                "spec.volume",
                old.map(|v| v.volume.as_bytes().to_vec()),
                value
                    .volume
                    .as_deref()
                    .unwrap_or_default()
                    .as_bytes()
                    .to_vec(),
            ),
            display_field(old.map(|v| &v.name), value.name.as_deref().unwrap_or(name)),
        ]
        .into_iter()
        .zip(declared)
        .filter_map(|(field, declared)| declared.then_some(field))
        .collect();
        let unchanged = prior.as_ref().is_some_and(|old| {
            old.instructions == value.instructions
                && old.allowed_actions == value.allowed_actions
                && old.workspace == value.workspace
                && old.harness_kind == value.harness_kind
                && old.execution == value.execution
                && value.lead.is_none_or(|lead| lead == old.lead)
                && value
                    .max_work_sessions
                    .is_none_or(|max| max == old.max_work_sessions)
                && value.memory.is_none_or(|memory| memory == old.memory)
                && value.start_rate.as_ref().is_none_or(|rate| {
                    Some(rate).filter(|rate| rate.starts > 0) == old.start_rate.as_ref()
                })
                && value
                    .volume
                    .as_ref()
                    .is_none_or(|volume| *volume == old.volume)
                && value.name.as_ref().is_none_or(|name| *name == old.name)
        });
        if let Some(old) = &prior {
            let set = |e: Option<&PolicyExecutionSettings>| {
                e.map_or([false; 4], |e| {
                    [
                        e.harness.is_some(),
                        !e.models.is_empty(),
                        !e.efforts.is_empty(),
                        e.shared_execution_environment_id.is_some(),
                    ]
                })
            };
            let (before, after) = (set(old.execution.as_ref()), set(value.execution.as_ref()));
            if before.iter().zip(after).all(|(was, is)| !was || is) {
                self.early_tags.insert(name.into());
            }
        }
        Ok((!unchanged).then_some((prior.is_some(), Write::Tag(value))))
    }

    async fn plan_team(
        &mut self,
        spec: super::TeamSpec,
        name: &str,
        declarations: &mut Declarations,
    ) -> Result<Option<(bool, Write)>> {
        let prior = lookup(
            self.teams
                .get_team(request(GetTeamRequest { team: name.into() }, self.token)?),
        )
        .await?;
        self.observed = prior
            .as_ref()
            .filter(|prior| prior.team_id == name)
            .map(|prior| prior.revision);
        if self.create_only
            && let Some(prior) = prior
        {
            declarations
                .ids
                .insert((Kind::Team, name.into()), prior.team_id.clone());
            declarations
                .ids
                .insert((Kind::Team, prior.name), prior.team_id);
            return Ok(None);
        }
        ensure!(
            prior.as_ref().is_none_or(|prior| prior.team_id == name),
            "Team name belongs to a different ID"
        );
        let wakes_declared = spec.wake_limits.is_some();
        let declared = [
            spec.name.is_some(),
            spec.members.is_some(),
            wakes_declared,
            wakes_declared,
            wakes_declared,
        ];
        // Declared limits replace all three; none at all is the defaults.
        let wakes = spec
            .wake_limits
            .map(|limits| TeamWakeLimits {
                mutual_per_task: limits.mutual_per_task,
                per_tag_per_hour: limits.per_tag_per_hour,
                per_objective_per_hour: limits.per_objective_per_hour,
            })
            .unwrap_or_default();
        ensure!(
            [
                wakes.mutual_per_task,
                wakes.per_tag_per_hour,
                wakes.per_objective_per_hour
            ]
            .into_iter()
            .flatten()
            .all(|value| value <= 1000),
            "invalid Team wake limit"
        );
        let desired_wakes = (wakes != TeamWakeLimits::default()).then_some(wakes);
        let display = spec.name.unwrap_or_else(|| {
            prior
                .as_ref()
                .map_or_else(|| name.into(), |prior| prior.name.clone())
        });
        ensure!(
            valid_name(&display) && display.encode_utf16().count() <= 200,
            "invalid Team name"
        );
        let mut members = spec.members.unwrap_or_else(|| {
            prior
                .as_ref()
                .map_or_else(Vec::new, |prior| prior.member_tag_ids.clone())
        });
        references(&mut members, "a Team member")?;
        ensure!(
            (1..=100).contains(&members.len()),
            "a Team needs 1–100 distinct members"
        );
        for member in &members {
            self.require_tag(declarations, member).await?;
        }
        for reference in [name, &display] {
            let key = (Kind::Team, reference.into());
            ensure!(
                declarations.ids.get(&key).is_none_or(|id| id == name),
                "Team declarations have conflicting identities"
            );
            declarations.ids.insert(key, name.into());
        }
        if display != name {
            let existing = lookup(self.teams.get_team(request(
                GetTeamRequest {
                    team: display.clone(),
                },
                self.token,
            )?))
            .await?;
            ensure!(
                existing.as_ref().is_none_or(|value| value.team_id == name),
                "Team display name belongs to another Team"
            );
        }
        let old = prior.as_ref();
        let limit =
            |value: Option<u32>| value.map(|value| number(value.into())).unwrap_or_default();
        self.planned_fields = [
            field(
                "spec.name",
                old.map(|v| v.name.as_bytes().to_vec()),
                display.as_bytes().to_vec(),
            ),
            field(
                "spec.members",
                old.map(|v| list(&v.member_tag_ids)),
                list(&members),
            ),
            field(
                "spec.wakeLimits.mutualPerTask",
                old.map(|v| limit(v.wake_limits.and_then(|w| w.mutual_per_task))),
                limit(wakes.mutual_per_task),
            ),
            field(
                "spec.wakeLimits.perTagPerHour",
                old.map(|v| limit(v.wake_limits.and_then(|w| w.per_tag_per_hour))),
                limit(wakes.per_tag_per_hour),
            ),
            field(
                "spec.wakeLimits.perObjectivePerHour",
                old.map(|v| limit(v.wake_limits.and_then(|w| w.per_objective_per_hour))),
                limit(wakes.per_objective_per_hour),
            ),
        ]
        .into_iter()
        .zip(declared)
        .filter_map(|(field, declared)| declared.then_some(field))
        .collect();
        let change = match prior {
            Some(prior)
                if prior.name != display
                    || prior.member_tag_ids != members
                    || (wakes_declared && prior.wake_limits != desired_wakes) =>
            {
                Some((
                    true,
                    Write::UpdateTeam(UpdateTeamRequest {
                        wake_limits: wakes_declared.then_some(wakes),
                        operation_id: id(),
                        team: name.into(),
                        expected_revision: prior.revision,
                        name: Some(display),
                        members: Some(TeamMembers { tag_ids: members }),
                    }),
                ))
            }
            Some(_) => None,
            None => Some((
                false,
                Write::Team(CreateTeamRequest {
                    wake_limits: desired_wakes,
                    operation_id: id(),
                    team_id: name.into(),
                    name: display,
                    member_tag_ids: members,
                }),
            )),
        };
        Ok(change)
    }

    async fn plan_objective(
        &mut self,
        mut spec: super::ObjectiveSpec,
        name: &str,
        declarations: &Declarations,
    ) -> Result<Option<(bool, Write)>> {
        let prior = lookup(self.objectives.get_objective(request(
            GetObjectiveRequest {
                objective_id: name.into(),
            },
            self.token,
        )?))
        .await?;
        if self.create_only && prior.is_some() {
            return Ok(None);
        }
        self.require_tag(declarations, &spec.owner_tag_id).await?;
        ensure!(
            spec.deadline.is_none() || spec.deadline_ms.is_none(),
            "set either deadline or deadlineMs"
        );
        let deadline_ms = spec.deadline_ms.or(spec
            .deadline
            .as_deref()
            .map(crate::objectives::deadline)
            .transpose()?);
        if let Some(actions) = &mut spec.runtime_actions {
            sorted(actions)?;
        }
        let actions = spec
            .runtime_actions
            .map(|actions| RuntimeActions { actions });
        let value = CreateObjectiveRequest {
            operation_id: id(),
            objective_id: name.into(),
            owner_tag_id: spec.owner_tag_id,
            outcome: spec.outcome,
            ongoing: spec.ongoing,
            deadline_ms,
            budget_limit_minor: spec.budget_limit_minor,
            budget_currency: spec.budget_currency,
            runtime_actions: actions,
            notification_task_id: None,
        };
        validate_manifest_objective(&value)?;
        if let Some(prior) = prior {
            ensure!(
                prior.owner_tag_id == value.owner_tag_id
                    && prior.outcome == value.outcome
                    && prior.ongoing == value.ongoing
                    && value
                        .runtime_actions
                        .as_ref()
                        .is_none_or(|actions| prior.runtime_actions.as_ref() == Some(actions)),
                "existing Objective identity or actions differ"
            );
            let deadline_changed =
                value.deadline_ms.is_some() && prior.deadline_ms != value.deadline_ms;
            let budget_changed = value.budget_limit_minor.is_some()
                && (prior.budget_limit_minor != value.budget_limit_minor
                    || value
                        .budget_currency
                        .as_ref()
                        .is_some_and(|currency| prior.budget_currency.as_ref() != Some(currency)));
            if !deadline_changed && !budget_changed {
                return Ok(None);
            }
            ensure!(
                !matches!(
                    prior.status(),
                    ObjectiveStatus::Completed | ObjectiveStatus::Cancelled
                ),
                "cannot change limits on a closed Objective"
            );
            let limits = SetObjectiveLimitsRequest {
                operation_id: id(),
                objective_id: name.into(),
                deadline_ms: value.deadline_ms.filter(|_| deadline_changed),
                budget_limit_minor: value.budget_limit_minor.filter(|_| budget_changed),
                budget_currency: value.budget_currency.filter(|_| budget_changed),
                expected_revision: Some(prior.revision),
                ..Default::default()
            };
            return Ok(Some((true, Write::ObjectiveLimits(limits))));
        }
        Ok(Some((false, Write::Objective(value))))
    }

    pub(super) async fn apply(&mut self, change: Change, report: bool) -> Result<()> {
        let token = self.token;
        let result: Result<Option<u64>, Status> = match change.write {
            Write::Account(input) => self
                .surfaces
                .put_surface_account(request(input, token)?)
                .await
                .map(|value| Some(value.into_inner().revision)),
            Write::Volume(input) => self
                .volumes
                .put(request(input, token)?)
                .await
                .map(|value| Some(value.into_inner().revision)),
            Write::Workspace(input) => self
                .workspaces
                .put(request(input, token)?)
                .await
                .map(|value| Some(value.into_inner().revision)),
            Write::Context(input) => self
                .policy
                .put_context_set(request(input, token)?)
                .await
                .map(|value| Some(value.into_inner().revision)),
            Write::Permission(input) => self
                .policy
                .put_permission_set(request(input, token)?)
                .await
                .map(|value| Some(value.into_inner().revision)),
            Write::Role(input) => self
                .policy
                .put_role(request(input, token)?)
                .await
                .map(|value| Some(value.into_inner().revision)),
            Write::ProvisionTag(_) => unreachable!("provisioned Tags are grouped in the plan"),
            Write::ProvisionTags(input) => self
                .relationships
                .provision_tags(request(input, token)?)
                .await
                .map(|_| None),
            Write::Tag(input) => self
                .operator
                .put_tag(request(input, token)?)
                .await
                .map(|value| Some(value.into_inner().revision)),
            Write::Team(input) => self
                .teams
                .create_team(request(input, token)?)
                .await
                .map(|value| Some(value.into_inner().revision)),
            Write::UpdateTeam(input) => self
                .teams
                .update_team(request(input, token)?)
                .await
                .map(|value| Some(value.into_inner().revision)),
            Write::Location(input) => self
                .surfaces
                .put_surface_location(request(input, token)?)
                .await
                .map(|value| Some(value.into_inner().revision)),
            Write::Objective(input) => self
                .objectives
                .create_objective(request(input, token)?)
                .await
                .map(|_| None),
            Write::ObjectiveLimits(input) => self
                .objectives
                .set_limits(request(input, token)?)
                .await
                .map(|_| None),
            Write::Relationships(input) => self
                .relationships
                .reconcile_tag(request(input, token)?)
                .await
                .map(|_| None),
            Write::RunsOn(input) => self
                .placement
                .set_tag_runs_on(request(input, token)?)
                .await
                .map(|_| None),
            Write::Schedule(input) => self
                .schedules
                .put(request(input, token)?)
                .await
                .map(|value| Some(value.into_inner().revision)),
            Write::AssignRole(input) => self
                .policy
                .assign_role(request(input, token)?)
                .await
                .map(|_| None),
        };
        let revision = result.with_context(|| format!("apply {}", change.label))?;
        if let Some(key) = &change.key
            && let Some((_, applied)) = self.fields.get_mut(key)
        {
            *applied = true;
        }
        if let (Some(key), Some(revision)) = (&change.key, revision)
            && let Some(declared) = self.declared.get_mut(key)
        {
            declared.revision = revision;
            declared.applied = true;
        }
        if report {
            outln!("configured {}", crate::terminal::text(&change.label));
        }
        Ok(())
    }

    /// Claims for the apply set every resource this apply is about to create,
    /// before any write. A claim outlives an apply that stops after a create,
    /// so the next run of the same apply still records the resource as a member.
    pub(super) async fn claim_apply_set(&mut self) -> Result<()> {
        self.send_apply_set(|value| value.created && !value.applied, false, false)
            .await
            .context("claim apply set")?;
        Ok(())
    }

    /// Records the apply set's members and, with `prune`, removes those the
    /// input no longer declares. Only resources whose planned write succeeded
    /// are declared, so a failed apply records what it created and prunes nothing.
    pub(super) async fn reconcile_apply_set(
        &mut self,
        prune: bool,
        preview: bool,
    ) -> Result<Vec<String>> {
        let pruned = self
            .send_apply_set(|value| preview || value.applied, prune, preview)
            .await
            .context("reconcile apply set")?;
        Ok(pruned
            .iter()
            .map(|item| prune_line(item, preview, self.manager))
            .collect())
    }

    async fn send_apply_set(
        &mut self,
        include: impl Fn(&Declared) -> bool,
        prune: bool,
        preview: bool,
    ) -> Result<Vec<ApplySetPrune>> {
        if self.manager.is_empty() || self.create_only {
            return Ok(Vec::new());
        }
        let declared = self
            .declared
            .iter()
            .filter(|(_, value)| include(value))
            .map(|((kind, name), value)| ApplySetDeclaration {
                kind: format!("{kind:?}"),
                name: name.clone(),
                revision: value.revision,
                created: value.created,
            })
            .collect::<Vec<_>>();
        if declared.is_empty() && !prune {
            return Ok(Vec::new());
        }
        let response = self
            .relationships
            .reconcile_apply_set(request(
                ReconcileApplySetRequest {
                    apply_set: self.manager.into(),
                    declared,
                    prune,
                    preview,
                },
                self.token,
            )?)
            .await?
            .into_inner();
        Ok(response.pruned)
    }
}

impl Catalog<'_> {
    /// The fields this apply would change that another manager owns.
    pub(super) async fn field_conflicts(&self, force: bool) -> Result<Vec<String>> {
        let resources = self
            .fields
            .iter()
            .map(|(key, (fields, _))| resource(key, fields))
            .collect();
        let response = self.send_fields(resources, force, true).await?;
        Ok(response
            .conflicts
            .iter()
            .map(|conflict| {
                format!(
                    "{}/{}: {} is owned by {}",
                    conflict.kind, conflict.name, conflict.path, conflict.manager
                )
            })
            .collect())
    }

    /// Records this manager as the owner of every field it applied.
    pub(super) async fn record_fields(&self) -> Result<()> {
        let resources = self
            .fields
            .iter()
            .filter(|(_, (_, applied))| *applied)
            .map(|(key, (fields, _))| resource(key, fields))
            .collect();
        self.send_fields(resources, true, false).await?;
        Ok(())
    }

    async fn send_fields(
        &self,
        resources: Vec<ManifestFieldResource>,
        force_conflicts: bool,
        preview: bool,
    ) -> Result<ReconcileManifestFieldsResponse> {
        if resources.is_empty() {
            return Ok(ReconcileManifestFieldsResponse::default());
        }
        Ok(self
            .relationships
            .clone()
            .reconcile_manifest_fields(request(
                ReconcileManifestFieldsRequest {
                    manager: self.manager.into(),
                    resources,
                    force_conflicts,
                    preview,
                },
                self.token,
            )?)
            .await
            .context("reconcile field managers")?
            .into_inner())
    }
}

fn resource((kind, name): &Key, fields: &[ManifestField]) -> ManifestFieldResource {
    ManifestFieldResource {
        kind: format!("{kind:?}"),
        name: name.clone(),
        fields: fields.to_vec(),
    }
}

fn prune_line(item: &ApplySetPrune, preview: bool, apply_set: &str) -> String {
    let label = format!("{}/{}", item.kind, item.name);
    let retires = matches!(item.kind.as_str(), "Tag" | "Role");
    let verb = match (item.action(), preview, retires) {
        (ApplySetPruneAction::Delete, true, true) => "retire",
        (ApplySetPruneAction::Delete, true, false) => "delete",
        (ApplySetPruneAction::Delete, false, true) => "retired",
        (ApplySetPruneAction::Delete, false, false) => "deleted",
        (ApplySetPruneAction::Keep, true, _) => "keep",
        (ApplySetPruneAction::Keep, false, _) => "kept",
        (ApplySetPruneAction::Release, true, _) => "release",
        (ApplySetPruneAction::Release, false, _) => "released",
        (ApplySetPruneAction::Forget | ApplySetPruneAction::Unspecified, true, _) => "forget",
        (ApplySetPruneAction::Forget | ApplySetPruneAction::Unspecified, false, _) => "forgot",
    };
    match item.action() {
        ApplySetPruneAction::Delete => format!("{verb} {label}"),
        ApplySetPruneAction::Keep | ApplySetPruneAction::Release => {
            format!("{verb} {label}: {}", item.reason)
        }
        _ => format!("{verb} {label}: no longer exists; it leaves apply set {apply_set}"),
    }
}

/// A field the manifest sets, with digests of its stored value (`None` when the resource does
/// not exist yet) and its declared value. An empty value digests to the empty string.
fn field(path: &str, current: Option<Vec<u8>>, desired: Vec<u8>) -> ManifestField {
    let digest = |bytes: &[u8]| {
        if bytes.is_empty() {
            String::new()
        } else {
            Sha256::digest(bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect()
        }
    };
    ManifestField {
        path: path.into(),
        current_digest: current.as_deref().map(digest).unwrap_or_default(),
        desired_digest: digest(&desired),
    }
}

fn list(values: &[String]) -> Vec<u8> {
    let mut bytes = Vec::new();
    for value in values {
        bytes.extend((value.len() as u64).to_le_bytes());
        bytes.extend(value.as_bytes());
    }
    bytes
}

fn messages<M: prost::Message>(values: &[M]) -> Vec<u8> {
    let mut bytes = Vec::new();
    for value in values {
        bytes.extend(value.encode_length_delimited_to_vec());
    }
    bytes
}

fn message<M: prost::Message>(value: &Option<M>) -> Vec<u8> {
    value.as_ref().map(M::encode_to_vec).unwrap_or_default()
}

/// A Tag's `maxWorkSessions`; the default, 8, is unset.
fn work_session_limit(value: u32) -> Vec<u8> {
    if value == 8 {
        Vec::new()
    } else {
        value.to_le_bytes().to_vec()
    }
}

fn start_rate(value: Option<&StartRate>) -> Vec<u8> {
    value.map_or_else(Vec::new, |rate| {
        [
            u64::from(rate.starts).to_le_bytes(),
            rate.per_ms.to_le_bytes(),
        ]
        .concat()
    })
}

fn flag(value: bool) -> Vec<u8> {
    if value { vec![1] } else { Vec::new() }
}

fn number(value: i64) -> Vec<u8> {
    if value == 0 {
        Vec::new()
    } else {
        value.to_le_bytes().to_vec()
    }
}

/// Fills an omitted `spec.displayName` with the current one, or the ID for a new resource, and
/// says whether the manifest declared it.
fn display_name(value: &mut String, prior: Option<&String>, id: &str) -> bool {
    let declared = !value.is_empty();
    if !declared {
        *value = prior.map_or(id, String::as_str).into();
    }
    declared
}

fn display_field(prior: Option<&String>, value: &str) -> ManifestField {
    field(
        "spec.displayName",
        prior.map(|v| v.as_bytes().to_vec()),
        value.as_bytes().to_vec(),
    )
}

fn preserve_identity(value: &mut String, prior: Option<&str>) -> Result<()> {
    if let Some(prior) = prior {
        if !value.is_empty() && value != prior {
            bail!("spec identity differs from the existing resource");
        }
        *value = prior.into();
    } else if value.is_empty() {
        *value = id();
    } else {
        ensure!(valid_name(value), "invalid resource identity");
    }
    Ok(())
}

fn clear_context_ids(value: &mut ContextSet) {
    for item in &mut value.items {
        item.item_id.clear();
    }
}

fn relationship_preview(
    tag: &str,
    roles: &BTreeMap<String, String>,
    change: ManifestRelationshipChange,
) -> String {
    if change.ownership_only {
        return format!("manage Tag/{tag} {}", change.path);
    }
    if let Some(role) = change
        .path
        .strip_prefix("spec.roles[")
        .and_then(|value| value.strip_suffix(']'))
    {
        let reference = roles.get(role).map_or(role, String::as_str);
        return if change.present {
            format!("assign Role/{reference} to Tag/{tag}")
        } else {
            format!("remove Role/{reference} from Tag/{tag}")
        };
    }
    if let Some(sender) = change
        .path
        .strip_prefix("spec.acceptsMessagesFrom[")
        .and_then(|value| value.strip_suffix(']'))
    {
        return if change.present {
            format!("grant Mailbox access from Tag/{sender} to Tag/{tag}")
        } else {
            format!("revoke Mailbox access from Tag/{sender} to Tag/{tag}")
        };
    }
    if let Some(label) = change
        .path
        .strip_prefix("spec.runsOn[")
        .and_then(|value| value.strip_suffix(']'))
    {
        return if change.present {
            format!("add runsOn label {label} to Tag/{tag}")
        } else {
            format!("remove runsOn label {label} from Tag/{tag}")
        };
    }
    format!("reconcile Tag/{tag} {}", change.path)
}
