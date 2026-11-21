//! What a Tag may do and how it runs, composed from the Tag, its active Roles, and their
//! Permission Sets, as the Control Plane composes it when it accepts a Task. `describe tag` shows
//! where each permission comes from, and apply and Role assignment report what a Tag gains.
use std::collections::{BTreeMap, BTreeSet};

use anyhow::Result;
use serde_json::{Value, json};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::v2::{
    operator_client::OperatorClient, policy_catalog_client::PolicyCatalogClient, *,
};

use crate::request;

/// One Tag's policy inputs.
#[derive(Clone, Debug, Default)]
pub(crate) struct TagPolicy {
    pub(crate) tag_id: String,
    pub(crate) allowed_actions: Vec<String>,
    pub(crate) harness_kind: i32,
    pub(crate) execution: Option<PolicyExecutionSettings>,
    /// Its active Roles.
    pub(crate) roles: Vec<Role>,
    /// The Permission Sets its Roles name, by ID.
    pub(crate) sets: BTreeMap<String, PermissionSet>,
}

impl TagPolicy {
    pub(crate) fn of(tag: &Tag) -> Self {
        Self {
            tag_id: tag.tag_id.clone(),
            allowed_actions: tag.allowed_actions.clone(),
            harness_kind: tag.harness_kind,
            execution: tag.execution.clone(),
            ..Default::default()
        }
    }

    /// Each permission the Tag holds, and what grants it: the Tag itself, or a Role through one
    /// of its Permission Sets. Several may grant one permission.
    pub(crate) fn grants(&self) -> BTreeMap<String, BTreeSet<String>> {
        let mut grants: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for action in &self.allowed_actions {
            grants
                .entry(action.clone())
                .or_default()
                .insert("Tag".into());
        }
        for role in &self.roles {
            for id in &role.permission_set_ids {
                let Some(set) = self.sets.get(id) else {
                    continue;
                };
                for permission in &set.permissions {
                    grants.entry(label(permission)).or_default().insert(format!(
                        "Role/{} via PermissionSet/{}",
                        role.role_id, set.set_id
                    ));
                }
            }
        }
        grants
    }

    /// The Tag's execution settings, or why its Roles conflict.
    pub(crate) fn execution(&self) -> Result<Option<PolicyExecutionSettings>, String> {
        let roles: Vec<&Role> = self.roles.iter().collect();
        supertag_control_plane::compose_execution(
            &self.tag_id,
            self.harness_kind,
            self.execution.as_ref(),
            &roles,
        )
    }

    /// `describe tag`'s view: each permission with what grants it, and the execution settings or
    /// the conflict that stops the Tag's Tasks.
    pub(crate) fn describe(&self) -> (Value, Value) {
        let permissions = self
            .grants()
            .into_iter()
            .map(|(permission, sources)| json!({ "permission": permission, "granted_by": sources }))
            .collect::<Vec<_>>();
        let execution = match self.execution() {
            Ok(None) => Value::Null,
            Ok(Some(settings)) => json!({
                "harness": settings.harness,
                "models": settings.models,
                "efforts": settings.efforts,
                "shared_execution_environment_id": settings.shared_execution_environment_id,
            }),
            Err(conflict) => json!({ "conflict": conflict }),
        };
        (Value::Array(permissions), execution)
    }
}

/// A permission as people read it: a runtime action with its scopes, or a surface or MCP grant.
pub(crate) fn label(permission: &PolicyPermission) -> String {
    let mut text = match permission.target() {
        PolicyPermissionTarget::Surface => {
            let mut text = format!(
                "surface {} on {}",
                permission.action, permission.surface_account_id
            );
            if !permission.scope.is_empty() {
                text.push_str(&format!(" {}", permission.scope));
            }
            text
        }
        PolicyPermissionTarget::Mcp => {
            let mut text = format!("mcp {} {}", permission.action, permission.reference);
            if !permission.resource.is_empty() {
                text.push_str(&format!(" {}", permission.resource));
            }
            text
        }
        _ => permission.action.clone(),
    };
    for (name, values) in [
        ("paths", &permission.paths),
        ("exclude", &permission.exclude),
        ("additional directories", &permission.additional_directories),
        ("hosts", &permission.hosts),
        ("methods", &permission.methods),
    ] {
        if !values.is_empty() {
            text.push_str(&format!(" {name} {}", values.join(",")));
        }
    }
    text
}

/// What `after` lets the Tag do that `before` did not, one line per permission, such as
/// `Tag/lead gains files:write (Role/builder via PermissionSet/local-tools)`. A new Tag gains
/// everything it holds.
pub(crate) fn gains(before: Option<&TagPolicy>, after: &TagPolicy) -> Vec<String> {
    let held = before.map(TagPolicy::grants).unwrap_or_default();
    after
        .grants()
        .into_iter()
        .filter(|(permission, _)| !held.contains_key(permission))
        .map(|(permission, sources)| {
            format!(
                "Tag/{} gains {permission} ({})",
                after.tag_id,
                sources.into_iter().collect::<Vec<_>>().join(", ")
            )
        })
        .collect()
}

/// The Tag's stored policy, read through the Control Plane's API.
pub(crate) async fn read(
    operator: &mut OperatorClient<ProtocolChannel>,
    policy: &mut PolicyCatalogClient<ProtocolChannel>,
    token: &str,
    tag_id: &str,
) -> Result<TagPolicy> {
    let tag = operator
        .get_tag(request(
            GetTagRequest {
                tag_id: tag_id.into(),
            },
            token,
        )?)
        .await?
        .into_inner();
    let mut value = TagPolicy::of(&tag);
    for role_id in active_roles(policy, token, tag_id).await? {
        let role = policy
            .get_role(request(
                GetPolicyResourceRequest { reference: role_id },
                token,
            )?)
            .await?
            .into_inner();
        if role.status == RoleStatus::Active as i32 {
            value.roles.push(role);
        }
    }
    fill_sets(&mut value, policy, token, &BTreeMap::new()).await?;
    Ok(value)
}

/// The Role IDs of the Tag's active assignments.
pub(crate) async fn active_roles(
    policy: &mut PolicyCatalogClient<ProtocolChannel>,
    token: &str,
    tag_id: &str,
) -> Result<Vec<String>> {
    assignments(policy, token, String::new(), tag_id.into())
        .await
        .map(|found| found.into_iter().map(|a| a.role_id).collect())
}

/// The Tags that hold the Role actively; none for a Role that does not exist yet.
pub(crate) async fn holders(
    policy: &mut PolicyCatalogClient<ProtocolChannel>,
    token: &str,
    role_id: &str,
) -> Result<Vec<String>> {
    match assignments(policy, token, role_id.into(), String::new()).await {
        Ok(found) => Ok(found.into_iter().map(|a| a.tag_id).collect()),
        Err(error)
            if error
                .downcast_ref::<tonic::Status>()
                .is_some_and(|status| status.code() == tonic::Code::NotFound) =>
        {
            Ok(Vec::new())
        }
        Err(error) => Err(error),
    }
}

async fn assignments(
    policy: &mut PolicyCatalogClient<ProtocolChannel>,
    token: &str,
    role: String,
    tag_id: String,
) -> Result<Vec<RoleAssignment>> {
    let mut found = Vec::new();
    let mut cursor = String::new();
    loop {
        let page = policy
            .list_role_assignments(request(
                ListRoleAssignmentsRequest {
                    role: role.clone(),
                    tag_id: tag_id.clone(),
                    status: RoleAssignmentStatus::Active as i32,
                    limit: 100,
                    cursor,
                },
                token,
            )?)
            .await?
            .into_inner();
        found.extend(page.assignments);
        if page.next_cursor.is_empty() {
            break;
        }
        cursor = page.next_cursor;
    }
    Ok(found)
}

/// Reads the Permission Sets the policy's Roles name, preferring `declared` ones.
pub(crate) async fn fill_sets(
    value: &mut TagPolicy,
    policy: &mut PolicyCatalogClient<ProtocolChannel>,
    token: &str,
    declared: &BTreeMap<String, PermissionSet>,
) -> Result<()> {
    let ids: BTreeSet<String> = value
        .roles
        .iter()
        .flat_map(|role| role.permission_set_ids.iter().cloned())
        .collect();
    value.sets.clear();
    for id in ids {
        let set = match declared.get(&id) {
            Some(set) => set.clone(),
            None => policy
                .get_permission_set(request(
                    GetPolicyResourceRequest {
                        reference: id.clone(),
                    },
                    token,
                )?)
                .await?
                .into_inner(),
        };
        value.sets.insert(id, set);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(id: &str, actions: &[&str]) -> PermissionSet {
        PermissionSet {
            set_id: id.into(),
            name: id.into(),
            permissions: actions
                .iter()
                .map(|action| PolicyPermission {
                    target: PolicyPermissionTarget::Runtime as i32,
                    action: (*action).into(),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }
    }

    fn role(id: &str, sets: &[&str]) -> Role {
        Role {
            role_id: id.into(),
            name: id.into(),
            permission_set_ids: sets.iter().map(|s| (*s).into()).collect(),
            status: RoleStatus::Active as i32,
            ..Default::default()
        }
    }

    #[test]
    fn grants_name_every_source_and_gains_list_only_new_permissions() {
        let before = TagPolicy {
            tag_id: "lead".into(),
            allowed_actions: vec!["files:read".into()],
            roles: vec![role("reader", &["read"])],
            sets: [("read".into(), set("read", &["files:read"]))].into(),
            ..Default::default()
        };
        let mut after = before.clone();
        after.roles.push(role("builder", &["write"]));
        after
            .sets
            .insert("write".into(), set("write", &["files:read", "files:write"]));
        let grants = after.grants();
        assert_eq!(
            grants["files:read"],
            BTreeSet::from([
                "Role/builder via PermissionSet/write".to_owned(),
                "Role/reader via PermissionSet/read".to_owned(),
                "Tag".to_owned(),
            ])
        );
        assert_eq!(
            gains(Some(&before), &after),
            ["Tag/lead gains files:write (Role/builder via PermissionSet/write)"]
        );
        assert!(gains(Some(&after), &after).is_empty());
        assert!(gains(Some(&after), &before).is_empty());
    }

    #[test]
    fn roles_that_set_one_field_differently_conflict_unless_the_tag_sets_it() {
        let with = |id: &str, models: &[&str]| Role {
            execution: Some(PolicyExecutionSettings {
                models: models.iter().map(|m| (*m).into()).collect(),
                ..Default::default()
            }),
            ..role(id, &[])
        };
        let mut policy = TagPolicy {
            tag_id: "lead".into(),
            roles: vec![with("builder", &["a"]), with("reviewer", &["b"])],
            ..Default::default()
        };
        assert_eq!(
            policy.execution().unwrap_err(),
            "Tag lead gets execution.models from Roles builder, reviewer with different values; set execution.models on the Tag, or give the Roles the same value"
        );
        policy.roles[1] = with("reviewer", &["a"]);
        assert_eq!(policy.execution().unwrap().unwrap().models, ["a"]);
        policy.roles[1] = with("reviewer", &["b"]);
        policy.execution = Some(PolicyExecutionSettings {
            models: vec!["c".into()],
            ..Default::default()
        });
        assert_eq!(policy.execution().unwrap().unwrap().models, ["c"]);
    }
}
