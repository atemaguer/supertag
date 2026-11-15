//! Frozen authority for provider effects. This resolver never treats a missing
//! runtime ApprovalRule as permission to invoke a Surface or MCP capability.
use crate::{
    StoreError,
    store::{Result, invalid},
};
use prost::Message;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use supertag_protocol::v2::*;

pub(crate) struct SurfaceAuthority {
    pub approval_required: bool,
    pub operators: Vec<String>,
    pub digest: String,
}

pub(crate) fn surface(
    snapshot: &TaskPolicySnapshot,
    account: &str,
    scope: &str,
    action: &str,
) -> Result<SurfaceAuthority> {
    let mut allowed = false;
    let mut required = false;
    let mut operators = BTreeSet::new();
    let mut frozen = Vec::new();
    for set in &snapshot.permission_sets {
        let matches: Vec<_> = set
            .permissions
            .iter()
            .filter(|grant| {
                grant.target() == PolicyPermissionTarget::Surface
                    && grant.surface_account_id == account
                    && grant.scope == scope
                    && grant.action == action
            })
            .collect();
        if matches.is_empty() {
            continue;
        }
        allowed = true;
        if matches.iter().any(|grant| grant.approval_required) {
            required = true;
            for approver in &set.approvers {
                let id = approver
                    .strip_prefix("operator:")
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| {
                        invalid("external publication currently requires operator approvers")
                    })?;
                operators.insert(id.to_owned());
            }
        }
        frozen.push(set.encode_to_vec());
    }
    let from_origin=snapshot.origin.as_ref().is_some_and(|origin|origin.account_id==account
        && origin.origin_actions.iter().any(|entry|entry==action)
        && matches!(origin.scope.as_ref().and_then(|scope|scope.provider.as_ref()),Some(surface_location_scope::Provider::Github(repository)) if scope==format!("repository:{}",repository.repository_id)));
    if !allowed && !from_origin {
        return Err(StoreError::PermissionDenied);
    }
    frozen.sort();
    let digest = format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(&(
            account,
            scope,
            action,
            &frozen,
            from_origin
        ))?)
    );
    Ok(SurfaceAuthority {
        approval_required: required,
        operators: operators.into_iter().collect(),
        digest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn grant(required: bool) -> PermissionSet {
        PermissionSet {
            set_id: if required { "gated" } else { "ungated" }.into(),
            revision: 1,
            approvers: if required {
                vec!["operator:owner".into()]
            } else {
                vec![]
            },
            permissions: vec![PolicyPermission {
                target: PolicyPermissionTarget::Surface as i32,
                surface_account_id: "account".into(),
                scope: "repository:123".into(),
                action: "pull-requests:create".into(),
                approval_required: required,
                ..Default::default()
            }],
            ..Default::default()
        }
    }
    #[test]
    fn exact_surface_grants_and_all_covering_approvals_are_required() {
        let mut snapshot = TaskPolicySnapshot::default();
        assert!(
            surface(
                &snapshot,
                "account",
                "repository:123",
                "pull-requests:create"
            )
            .is_err()
        );
        snapshot.permission_sets = vec![grant(false)];
        assert!(
            !surface(
                &snapshot,
                "account",
                "repository:123",
                "pull-requests:create"
            )
            .unwrap()
            .approval_required
        );
        assert!(surface(&snapshot, "other", "repository:123", "pull-requests:create").is_err());
        assert!(
            surface(
                &snapshot,
                "account",
                "repository:124",
                "pull-requests:create"
            )
            .is_err()
        );
        snapshot.permission_sets.push(grant(true));
        let authority = surface(
            &snapshot,
            "account",
            "repository:123",
            "pull-requests:create",
        )
        .unwrap();
        assert!(authority.approval_required);
        assert_eq!(authority.operators, ["owner"]);
        snapshot.permission_sets.reverse();
        assert_eq!(
            authority.digest,
            surface(
                &snapshot,
                "account",
                "repository:123",
                "pull-requests:create"
            )
            .unwrap()
            .digest
        );
        snapshot.permission_sets[0].approvers = vec!["tag:reviewer".into()];
        assert!(
            surface(
                &snapshot,
                "account",
                "repository:123",
                "pull-requests:create"
            )
            .is_err()
        );
    }
}
