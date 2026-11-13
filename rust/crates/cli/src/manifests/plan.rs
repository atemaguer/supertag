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
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Code, Response, Status, transport::Channel};
use uuid::Uuid;

use super::{Kind, MAX_REFERENCES, Manifest, Resource, valid_name};
use crate::request;

pub(super) struct Catalog<'a> {
    token: &'a str,
    operator: operator_client::OperatorClient<Channel>,
    policy: policy_catalog_client::PolicyCatalogClient<Channel>,
    surfaces: surface_policy_catalog_client::SurfacePolicyCatalogClient<Channel>,
    volumes: artifact_volumes_client::ArtifactVolumesClient<Channel>,
    workspaces: github_workspaces_client::GithubWorkspacesClient<Channel>,
    teams: teams_client::TeamsClient<Channel>,
    objectives: objectives_client::ObjectivesClient<Channel>,
    mailbox: mailbox_client::MailboxClient<Channel>,
}

enum Write {
    Account(PutSurfaceAccountRequest),
    Volume(PutArtifactVolumeRequest),
    Workspace(PutGithubWorkspaceRequest),
    Context(PutContextSetRequest),
    Permission(PutPermissionSetRequest),
    Role(PutRoleRequest),
    Tag(PutTagRequest),
    Team(CreateTeamRequest),
    UpdateTeam(UpdateTeamRequest),
    Location(PutSurfaceLocationRequest),
    Objective(CreateObjectiveRequest),
    ObjectiveLimits(SetObjectiveLimitsRequest),
    Assignment(AssignRoleRequest),
    MailboxGrant(ChangeMailboxGrantRequest),
}

pub(super) struct Change {
    label: String,
    action: &'static str,
    write: Write,
}

impl Change {
    pub(super) fn preview(&self) -> String {
        format!("{} {}", self.action, self.label)
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
    pub(super) fn new(channel: Channel, token: &'a str) -> Self {
        macro_rules! client {
            ($module:ident, $client:ident) => {
                $module::$client::new(channel.clone())
                    .max_decoding_message_size(MAX_MESSAGE_BYTES)
                    .max_encoding_message_size(MAX_MESSAGE_BYTES)
            };
        }
        Self {
            token,
            operator: client!(operator_client, OperatorClient),
            policy: client!(policy_catalog_client, PolicyCatalogClient),
            surfaces: client!(surface_policy_catalog_client, SurfacePolicyCatalogClient),
            volumes: client!(artifact_volumes_client, ArtifactVolumesClient),
            workspaces: client!(github_workspaces_client, GithubWorkspacesClient),
            teams: client!(teams_client, TeamsClient),
            objectives: client!(objectives_client, ObjectivesClient),
            mailbox: client!(mailbox_client, MailboxClient),
        }
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
            let change = self
                .plan_resource(item.resource, &name, &mut declarations, &mut followups)
                .await
                .with_context(|| format!("{label} from {}", item.source))?;
            if let Some((exists, write)) = change {
                changes.push(Change {
                    label,
                    action: if exists { "update" } else { "create" },
                    write,
                });
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
                let prior = lookup(self.workspaces.get(request(
                    GetGithubWorkspaceRequest {
                        workspace_id: name.into(),
                    },
                    token,
                )?))
                .await?;
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
                let prior = lookup(self.surfaces.get_surface_location(request(
                    GetSurfaceLocationRequest {
                        location_id: name.into(),
                    },
                    token,
                )?))
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
            value.workspace = Some(WorkspaceSpec {
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
            if !self.assigned_role(name, &role, prior.is_some()).await? {
                followups.push(Change {
                    label: format!("Role/{reference} to Tag/{name}"),
                    action: "assign",
                    write: Write::Assignment(AssignRoleRequest {
                        operation_id: id(),
                        role: role.role_id,
                        tag_id: name.into(),
                    }),
                });
            }
        }
        sorted(&mut spec.accepts_messages_from)?;
        let grants = if prior.is_some() && !spec.accepts_messages_from.is_empty() {
            self.grants(name).await?
        } else {
            Default::default()
        };
        for sender in spec.accepts_messages_from {
            ensure!(
                sender != name,
                "a Mailbox grant cannot name its own recipient"
            );
            self.require_tag(declarations, &sender).await?;
            if !grants.contains(&sender) {
                followups.push(Change {
                    label: format!("Mailbox access from Tag/{sender} to Tag/{name}"),
                    action: "grant",
                    write: Write::MailboxGrant(ChangeMailboxGrantRequest {
                        operation_id: id(),
                        sender_tag_id: sender,
                        recipient_tag_id: name.into(),
                        granted: true,
                    }),
                });
            }
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

    async fn assigned_role(&mut self, tag: &str, role: &Role, tag_exists: bool) -> Result<bool> {
        if role.revision == 0 || !tag_exists {
            return Ok(false);
        }
        let assignments = self
            .policy
            .list_role_assignments(request(
                ListRoleAssignmentsRequest {
                    role: role.role_id.clone(),
                    tag_id: tag.into(),
                    status: RoleAssignmentStatus::Active.into(),
                    limit: 1,
                    cursor: String::new(),
                },
                self.token,
            )?)
            .await?
            .into_inner();
        Ok(!assignments.assignments.is_empty())
    }

    async fn grants(&mut self, tag: &str) -> Result<BTreeSet<String>> {
        let mut cursor = String::new();
        let mut result = BTreeSet::new();
        loop {
            let page = self
                .mailbox
                .list_grants(request(
                    ListMailboxGrantsRequest {
                        tag_id: tag.into(),
                        limit: 100,
                        cursor,
                    },
                    self.token,
                )?)
                .await?
                .into_inner();
            result.extend(
                page.grants
                    .into_iter()
                    .filter(|grant| grant.recipient_tag_id == tag)
                    .map(|grant| grant.sender_tag_id),
            );
            cursor = page.next_cursor;
            if cursor.is_empty() {
                return Ok(result);
            }
        }
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
        };
        validate_manifest_objective(&value)?;
        let prior = lookup(self.objectives.get_objective(request(
            GetObjectiveRequest {
                objective_id: name.into(),
            },
            self.token,
        )?))
        .await?;
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

    pub(super) async fn apply(&mut self, change: Change) -> Result<()> {
        let token = self.token;
        let result = match change.write {
            Write::Account(input) => self
                .surfaces
                .put_surface_account(request(input, token)?)
                .await
                .map(|_| ()),
            Write::Volume(input) => self.volumes.put(request(input, token)?).await.map(|_| ()),
            Write::Workspace(input) => self
                .workspaces
                .put(request(input, token)?)
                .await
                .map(|_| ()),
            Write::Context(input) => self
                .policy
                .put_context_set(request(input, token)?)
                .await
                .map(|_| ()),
            Write::Permission(input) => self
                .policy
                .put_permission_set(request(input, token)?)
                .await
                .map(|_| ()),
            Write::Role(input) => self
                .policy
                .put_role(request(input, token)?)
                .await
                .map(|_| ()),
            Write::Tag(input) => self
                .operator
                .put_tag(request(input, token)?)
                .await
                .map(|_| ()),
            Write::Team(input) => self
                .teams
                .create_team(request(input, token)?)
                .await
                .map(|_| ()),
            Write::UpdateTeam(input) => self
                .teams
                .update_team(request(input, token)?)
                .await
                .map(|_| ()),
            Write::Location(input) => self
                .surfaces
                .put_surface_location(request(input, token)?)
                .await
                .map(|_| ()),
            Write::Objective(input) => self
                .objectives
                .create_objective(request(input, token)?)
                .await
                .map(|_| ()),
            Write::ObjectiveLimits(input) => self
                .objectives
                .set_limits(request(input, token)?)
                .await
                .map(|_| ()),
            Write::Assignment(input) => self
                .policy
                .assign_role(request(input, token)?)
                .await
                .map(|_| ()),
            Write::MailboxGrant(input) => self
                .mailbox
                .change_grant(request(input, token)?)
                .await
                .map(|_| ()),
        };
        result.with_context(|| format!("apply {}", change.label))?;
        println!("configured {}", change.label);
        Ok(())
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
