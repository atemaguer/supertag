//! Field managers for declarative manifests.
//!
//! Each field a manifest sets is owned by the manager that last applied it (an
//! apply set, default `apply`), recorded with a digest of the value it left.
//! A stored value no apply recorded, or one changed since its manager applied
//! it, belongs to `cli`. Changing a field another manager owns is a conflict
//! unless forced; declaring the stored value only moves ownership.
use std::collections::BTreeSet;

use supertag_protocol::v2::*;

use crate::{
    Store,
    policy::operator,
    store::{Result, invalid, name},
};

const KINDS: [&str; 9] = [
    "SurfaceAccount",
    "Volume",
    "Workspace",
    "ContextSet",
    "PermissionSet",
    "Role",
    "Tag",
    "Team",
    "SurfaceLocation",
];
const MAX_RESOURCES: usize = 1024;
const MAX_FIELDS: usize = 32;

fn digest(value: &str) -> bool {
    value.is_empty()
        || (value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
}

fn path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_'))
}

impl Store {
    pub async fn reconcile_manifest_fields(
        &self,
        principal: &str,
        input: &ReconcileManifestFieldsRequest,
    ) -> Result<ReconcileManifestFieldsResponse> {
        operator(principal)?;
        let manager = crate::manifest_relationships::manager(&input.manager)?;
        if input.resources.len() > MAX_RESOURCES {
            return Err(invalid("too many manifest resources"));
        }
        let mut seen = BTreeSet::new();
        for resource in &input.resources {
            if !KINDS.contains(&resource.kind.as_str()) {
                return Err(invalid("unsupported manifest field kind"));
            }
            name("manifest resource name", &resource.name)?;
            if !seen.insert((&resource.kind, &resource.name)) {
                return Err(invalid("duplicate manifest resource"));
            }
            if resource.fields.len() > MAX_FIELDS {
                return Err(invalid("too many manifest fields"));
            }
            let mut paths = BTreeSet::new();
            for field in &resource.fields {
                if !path(&field.path)
                    || !digest(&field.current_digest)
                    || !digest(&field.desired_digest)
                    || !paths.insert(&field.path)
                {
                    return Err(invalid("invalid manifest field"));
                }
            }
        }
        let (mut tx, _) = self.write().await?;
        let mut conflicts = Vec::new();
        for resource in &input.resources {
            for field in &resource.fields {
                if field.current_digest.is_empty() || field.current_digest == field.desired_digest {
                    continue;
                }
                let owner: Option<(String, String)> = sqlx::query_as(
                    "SELECT manager,value_digest FROM supertag_v2_manifest_fields WHERE kind=$1 AND name=$2 AND path=$3",
                )
                .bind(&resource.kind)
                .bind(&resource.name)
                .bind(&field.path)
                .fetch_optional(&mut *tx)
                .await?;
                let owner = match owner {
                    Some((owner, value)) if value == field.current_digest => owner,
                    _ => "cli".into(),
                };
                if owner != manager {
                    conflicts.push(ManifestFieldConflict {
                        kind: resource.kind.clone(),
                        name: resource.name.clone(),
                        path: field.path.clone(),
                        manager: owner,
                    });
                }
            }
        }
        if input.force_conflicts {
            conflicts.clear();
        }
        if input.preview || !conflicts.is_empty() {
            tx.rollback().await?;
            return Ok(ReconcileManifestFieldsResponse { conflicts });
        }
        for resource in &input.resources {
            for field in &resource.fields {
                if field.desired_digest.is_empty() {
                    sqlx::query(
                        "DELETE FROM supertag_v2_manifest_fields WHERE kind=$1 AND name=$2 AND path=$3",
                    )
                    .bind(&resource.kind)
                    .bind(&resource.name)
                    .bind(&field.path)
                    .execute(&mut *tx)
                    .await?;
                } else {
                    sqlx::query(
                        "INSERT INTO supertag_v2_manifest_fields (kind,name,path,manager,value_digest) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(kind,name,path) DO UPDATE SET manager=excluded.manager,value_digest=excluded.value_digest",
                    )
                    .bind(&resource.kind)
                    .bind(&resource.name)
                    .bind(&field.path)
                    .bind(manager)
                    .bind(&field.desired_digest)
                    .execute(&mut *tx)
                    .await?;
                }
            }
        }
        tx.commit().await?;
        Ok(ReconcileManifestFieldsResponse { conflicts })
    }
}
