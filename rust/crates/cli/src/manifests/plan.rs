use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
};

use anyhow::{Context, Result, bail, ensure};
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
    workspaces: github_workspaces_client::GithubWorkspacesClient<ProtocolChannel>,
    teams: teams_client::TeamsClient<ProtocolChannel>,
    objectives: objectives_client::ObjectivesClient<ProtocolChannel>,
    relationships: manifest_relationships_client::ManifestRelationshipsClient<ProtocolChannel>,
    placement: placement_client::PlacementClient<ProtocolChannel>,
    manager: &'a str,
    create_only: bool,
    /// The revision the current resource was planned against, if it exists.
    observed: Option<u64>,
    declared: BTreeMap<Key, Declared>,
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
    Workspace(PutGithubWorkspaceRequest),
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
            workspaces: client!(github_workspaces_client, GithubWorkspacesClient),
            teams: client!(teams_client, TeamsClient),
            objectives: client!(objectives_client, ObjectivesClient),
            relationships: client!(manifest_relationships_client, ManifestRelationshipsClient),
            placement: client!(placement_client, PlacementClient),
            manager,
            create_only,
            observed: None,
            declared: BTreeMap::new(),
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
            let change = self
                .plan_resource(item.resource, &name, &mut declarations, &mut followups)
                .await
                .with_context(|| format!("{label} from {}", item.source))?;
            let key = (item.kind, name.clone());
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
                    key: prunable(item.kind).then_some(key),
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
        Ok(changes)
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
                    GetGithubWorkspaceRequest {
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
                let account = self
                    .account(
                        declarations,
                        &value
                            .source
                            .as_ref()
                            .expect("validated Workspace")
                            .account_id,
                    )
                    .await?;
                ensure!(
                    account.enabled
                        && matches!(
                            account.identity.and_then(|identity| identity.provider),
                            Some(surface_account_identity::Provider::Github(_))
                        ),
                    "Workspace source requires an enabled GitHub Surface Account"
                );
                let revision = prior.as_ref().map(|value| value.revision);
                value.revision = revision.unwrap_or_default();
                declarations
                    .ids
                    .insert((Kind::Workspace, name.into()), name.into());
                (prior.as_ref() != Some(&value)).then(|| {
                    (
                        prior.is_some(),
                        Write::Workspace(PutGithubWorkspaceRequest {
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
                for grant in &mut value.permissions {
                    grant.permission_id.clear();
                }
                let mut previous = prior;
                if let Some(prior) = &mut previous {
                    for grant in &mut prior.permissions {
                        grant.permission_id.clear();
                    }
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
                    declarations.roles.insert(name.into(), prior);
                    return Ok(None);
                }
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
        sorted(ids)?;
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
        sorted(ids)
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
                GetGithubWorkspaceRequest {
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
            return Ok(None);
        }
        ensure!(
            prior
                .as_ref()
                .is_none_or(|prior| prior.retired_at_ms.is_none()),
            "Tag is retired"
        );
        let mut value = PutTagRequest {
            tag_id: name.into(),
            name: prior.as_ref().map(|prior| prior.name.clone()),
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
                supertag_protocol::valid_workspace_id(&workspace.id),
                "invalid Workspace ID"
            );
            let base_commit = workspace.base_commit.unwrap_or_default();
            if base_commit.is_empty() {
                self.require_workspace(declarations, &workspace.id).await?;
            } else {
                ensure!(
                    supertag_protocol::valid_git_commit(&base_commit),
                    "invalid Workspace commit"
                );
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
                github_source: None,
            });
        }
        if let Some(execution) = spec.execution {
            let (kind, execution) =
                normalize_tag_execution(HarnessKind::Unspecified, Some(execution.into()))?;
            value.harness_kind = kind.into();
            value.execution = execution;
        }
        ensure!(
            value.workspace.is_none()
                || value
                    .execution
                    .as_ref()
                    .is_none_or(|settings| settings.shared_execution_environment_id.is_none()),
            "shared execution cannot use a pinned Git Workspace"
        );
        sorted(&mut spec.roles)?;
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
        sorted(&mut spec.accepts_messages_from)?;
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
        if let Some(runs_on) = spec.runs_on.take() {
            let mut runs_on: Vec<String> = runs_on
                .iter()
                .map(|label| label.trim().to_ascii_lowercase())
                .collect();
            runs_on.sort_unstable();
            runs_on.dedup();
            if prior
                .as_ref()
                .map_or(!runs_on.is_empty(), |prior| prior.runs_on != runs_on)
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
        }
        let mut reconciliation = ReconcileTagRelationshipsRequest {
            tag_id: name.into(),
            manager: self.manager.into(),
            role_ids: role_ids.keys().cloned().collect(),
            mailbox_senders: spec.accepts_messages_from,
            preview: true,
        };
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
        let unchanged = prior.as_ref().is_some_and(|old| {
            old.instructions == value.instructions
                && old.allowed_actions == value.allowed_actions
                && old.workspace == value.workspace
                && old.harness_kind == value.harness_kind
                && old.execution == value.execution
        });
        Ok((!unchanged).then_some((prior.is_some(), Write::Tag(value))))
    }

    async fn plan_team(
        &mut self,
        spec: super::TeamSpec,
        name: &str,
        declarations: &mut Declarations,
    ) -> Result<Option<(bool, Write)>> {
        ensure!(
            name.encode_utf16().count() <= 200
                && !matches!(name, "." | "..")
                && !name.chars().any(char::is_whitespace),
            "invalid Team ID"
        );
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
        sorted(&mut members)?;
        ensure!(
            (1..=100).contains(&members.len()),
            "a Team needs 1–100 distinct members"
        );
        for member in &members {
            self.require_tag(declarations, member).await?;
        }
        let limit = spec.max_concurrency.filter(|limit| *limit != 0);
        ensure!(
            limit.is_none_or(|value| value <= 1000),
            "invalid Team concurrency"
        );
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
        let change = match prior {
            Some(prior)
                if prior.name != display
                    || prior.member_tag_ids != members
                    || spec
                        .max_concurrency
                        .is_some_and(|_| prior.max_concurrency != limit) =>
            {
                Some((
                    true,
                    Write::UpdateTeam(UpdateTeamRequest {
                        operation_id: id(),
                        team: name.into(),
                        expected_revision: prior.revision,
                        name: Some(display),
                        members: Some(TeamMembers { tag_ids: members }),
                        max_concurrency: spec.max_concurrency,
                    }),
                ))
            }
            Some(_) => None,
            None => Some((
                false,
                Write::Team(CreateTeamRequest {
                    operation_id: id(),
                    team_id: name.into(),
                    name: display,
                    member_tag_ids: members,
                    max_concurrency: limit,
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
        let team = if let Some(team) = spec.team {
            Some(
                if let Some(id) = declarations.resource_id(Kind::Team, &team) {
                    id.into()
                } else {
                    lookup(
                        self.teams
                            .get_team(request(GetTeamRequest { team: team.clone() }, self.token)?),
                    )
                    .await?
                    .ok_or_else(|| missing(Kind::Team, &team))?
                    .team_id
                },
            )
        } else {
            None
        };
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
            team_id: team,
            runtime_actions: actions,
            notification_task_id: None,
        };
        validate_manifest_objective(&value)?;
        if let Some(prior) = prior {
            ensure!(
                prior.owner_tag_id == value.owner_tag_id
                    && prior.outcome == value.outcome
                    && prior.ongoing == value.ongoing
                    && prior.team_id == value.team_id
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
        };
        let revision = result.with_context(|| format!("apply {}", change.label))?;
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
    format!("reconcile Tag/{tag} {}", change.path)
}
