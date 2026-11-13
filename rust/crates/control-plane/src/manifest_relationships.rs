//! Declarative Tag relationship ownership and exact reconciliation.
use std::collections::{BTreeMap, BTreeSet};

use sqlx::{Any, Row, Transaction};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};
use uuid::Uuid;

use crate::{
    ControlPlane, Store, StoreError,
    policy::{assignment_row, increment, operator, save_assignment},
    store::{Result, invalid, name},
    tags,
};

const MAX_RELATIONSHIPS: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Kind {
    Role,
    Mailbox,
}

impl Kind {
    fn field(self) -> &'static str {
        match self {
            Self::Role => "roles",
            Self::Mailbox => "acceptsMessagesFrom",
        }
    }
}

pub(crate) async fn imperative_change(
    tx: &mut Transaction<'_, Any>,
    tag: &str,
    kind: &str,
    related: &str,
) -> Result<()> {
    sqlx::query("DELETE FROM supertag_v2_manifest_relationships WHERE tag_id=$1 AND kind=$2 AND related_id=$3")
        .bind(tag).bind(kind).bind(related).execute(&mut **tx).await?;
    Ok(())
}

#[derive(Debug)]
struct Ownership {
    manager: String,
    observed_version: String,
}

#[derive(Debug)]
struct Relationship {
    version: String,
    present: bool,
}

pub(crate) fn manager(value: &str) -> Result<&str> {
    if value.is_empty() {
        return Ok("apply");
    }
    if value.len() > 63
        || matches!(value, "apply" | "cli")
        || !value.as_bytes()[0].is_ascii_lowercase() && !value.as_bytes()[0].is_ascii_digit()
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        })
    {
        return Err(invalid("invalid apply set name"));
    }
    Ok(value)
}

async fn current(
    tx: &mut Transaction<'_, Any>,
    tag: &str,
    kind: Kind,
    related: &str,
) -> Result<Relationship> {
    match kind {
        Kind::Role => {
            let row = sqlx::query(
                "SELECT * FROM supertag_v2_role_assignments WHERE tag_id=$1 AND role_id=$2",
            )
            .bind(tag)
            .bind(related)
            .fetch_optional(&mut **tx)
            .await?;
            let assignment = row.as_ref().map(assignment_row).transpose()?;
            Ok(Relationship {
                version: assignment.as_ref().map_or_else(String::new, |value| {
                    format!("{}:{}", value.assignment_id, value.revision)
                }),
                present: assignment
                    .is_some_and(|value| value.status() == RoleAssignmentStatus::Active),
            })
        }
        Kind::Mailbox => {
            let row = sqlx::query(
                "SELECT granted_by,granted_at_ms FROM supertag_v2_mailbox_grants WHERE recipient_tag_id=$1 AND sender_tag_id=$2",
            )
            .bind(tag)
            .bind(related)
            .fetch_optional(&mut **tx)
            .await?;
            let version = row
                .as_ref()
                .map(|row| -> Result<String> {
                    Ok(format!(
                        "{}:{}",
                        row.try_get::<String, _>("granted_by")?,
                        row.try_get::<i64, _>("granted_at_ms")?
                    ))
                })
                .transpose()?
                .unwrap_or_default();
            Ok(Relationship {
                version,
                present: row.is_some(),
            })
        }
    }
}

async fn apply(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    tag: &str,
    kind: Kind,
    related: &str,
    present: bool,
    now: i64,
) -> Result<()> {
    match kind {
        Kind::Role => {
            let row = sqlx::query(
                "SELECT * FROM supertag_v2_role_assignments WHERE tag_id=$1 AND role_id=$2",
            )
            .bind(tag)
            .bind(related)
            .fetch_optional(&mut **tx)
            .await?;
            let mut assignment = if let Some(row) = row {
                let mut value = assignment_row(&row)?;
                value.revision = increment(value.revision)?;
                value
            } else {
                RoleAssignment {
                    assignment_id: Uuid::new_v4().to_string(),
                    tag_id: tag.into(),
                    role_id: related.into(),
                    revision: 1,
                    ..Default::default()
                }
            };
            assignment.status = if present {
                RoleAssignmentStatus::Active
            } else {
                RoleAssignmentStatus::Inactive
            }
            .into();
            save_assignment(tx, &assignment).await?;
        }
        Kind::Mailbox if present => {
            sqlx::query("INSERT INTO supertag_v2_mailbox_grants (sender_tag_id,recipient_tag_id,granted_by,granted_at_ms) VALUES ($1,$2,$3,$4)")
                .bind(related).bind(tag).bind(principal).bind(now).execute(&mut **tx).await?;
        }
        Kind::Mailbox => {
            sqlx::query("DELETE FROM supertag_v2_mailbox_grants WHERE sender_tag_id=$1 AND recipient_tag_id=$2")
                .bind(related).bind(tag).execute(&mut **tx).await?;
        }
    }
    Ok(())
}

impl Store {
    pub async fn reconcile_tag_relationships(
        &self,
        principal: &str,
        input: &ReconcileTagRelationshipsRequest,
    ) -> Result<ReconcileTagRelationshipsResponse> {
        operator(principal)?;
        let mut tx = if input.preview {
            self.pool.begin().await?
        } else {
            self.write().await?.0
        };
        let response = self.reconcile_in(&mut tx, principal, input).await?;
        tx.commit().await?;
        Ok(response)
    }

    async fn reconcile_in(
        &self,
        tx: &mut Transaction<'_, Any>,
        principal: &str,
        input: &ReconcileTagRelationshipsRequest,
    ) -> Result<ReconcileTagRelationshipsResponse> {
        let owner = manager(&input.manager)?;
        name("Tag ID", &input.tag_id)?;
        if input.role_ids.len() + input.mailbox_senders.len() > MAX_RELATIONSHIPS {
            return Err(invalid("too many manifest Tag relationships"));
        }
        let mut desired = BTreeSet::new();
        for (kind, values) in [
            (Kind::Role, &input.role_ids),
            (Kind::Mailbox, &input.mailbox_senders),
        ] {
            for related in values {
                name("relationship reference", related)?;
                if kind == Kind::Mailbox && related == &input.tag_id {
                    return Err(invalid("a Tag cannot grant itself messaging access"));
                }
                desired.insert((kind, related.clone()));
            }
        }
        tags::require_active(tx, &input.tag_id).await?;
        // A preview may name relationships created earlier in the same manifest.
        // The committing call always validates the final, authoritative identities.
        if !input.preview {
            for (kind, related) in &desired {
                match kind {
                    Kind::Role => {
                        let status: Option<i64> = sqlx::query_scalar(
                            "SELECT status FROM supertag_v2_roles WHERE role_id=$1",
                        )
                        .bind(related)
                        .fetch_optional(&mut **tx)
                        .await?;
                        if status != Some(RoleStatus::Active as i64) {
                            return Err(StoreError::FailedPrecondition(
                                "manifest relationship requires an active Role".into(),
                            ));
                        }
                    }
                    Kind::Mailbox => tags::require_active(tx, related).await?,
                }
            }
        }

        let owned = sqlx::query(
            "SELECT kind,related_id,manager,observed_version FROM supertag_v2_manifest_relationships WHERE tag_id=$1 ORDER BY kind,related_id",
        )
        .bind(&input.tag_id)
        .fetch_all(&mut **tx)
        .await?;
        let mut stored = BTreeMap::new();
        for row in owned {
            let kind = match row.try_get::<String, _>("kind")?.as_str() {
                "roles" => Kind::Role,
                "acceptsMessagesFrom" => Kind::Mailbox,
                _ => {
                    return Err(StoreError::FailedPrecondition(
                        "stored relationship kind is invalid".into(),
                    ));
                }
            };
            stored.insert(
                (kind, row.try_get::<String, _>("related_id")?),
                Ownership {
                    manager: row.try_get("manager")?,
                    observed_version: row.try_get("observed_version")?,
                },
            );
        }
        let keys = desired
            .iter()
            .chain(
                stored
                    .iter()
                    .filter(|(_, value)| value.manager == owner)
                    .map(|(key, _)| key),
            )
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut changes = Vec::new();
        let mut effects = Vec::new();
        for key in keys {
            let (kind, related) = &key;
            let before = current(tx, &input.tag_id, *kind, related).await?;
            let entry = stored.get(&key);
            let same_version = entry.is_some_and(|entry| entry.observed_version == before.version);
            let previous_owner = entry
                .filter(|_| same_version)
                .map(|entry| entry.manager.as_str());
            let present = desired.contains(&key);
            let path = format!("spec.{}[{related}]", kind.field());
            let owned_and_present = before.present && previous_owner == Some(owner);
            if (present && owned_and_present) || (!present && !owned_and_present) {
                continue;
            }
            let ownership_only = before.present == present;
            changes.push(ManifestRelationshipChange {
                path,
                present,
                ownership_only,
            });
            effects.push((key, present, ownership_only));
        }
        if !input.preview {
            let now = self.execution_now_ms();
            for ((kind, related), present, ownership_only) in effects {
                if !ownership_only {
                    apply(tx, principal, &input.tag_id, kind, &related, present, now).await?;
                }
                if present {
                    let after = current(tx, &input.tag_id, kind, &related).await?;
                    sqlx::query("INSERT INTO supertag_v2_manifest_relationships (tag_id,kind,related_id,manager,observed_version) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(tag_id,kind,related_id) DO UPDATE SET manager=excluded.manager,observed_version=excluded.observed_version")
                        .bind(&input.tag_id).bind(kind.field()).bind(related).bind(owner).bind(after.version)
                        .execute(&mut **tx).await?;
                } else {
                    sqlx::query("DELETE FROM supertag_v2_manifest_relationships WHERE tag_id=$1 AND kind=$2 AND related_id=$3 AND manager=$4")
                        .bind(&input.tag_id).bind(kind.field()).bind(related).bind(owner)
                        .execute(&mut **tx).await?;
                }
            }
        }
        Ok(ReconcileTagRelationshipsResponse { changes })
    }

    async fn provision_tags(&self, principal: &str, input: ProvisionTagsRequest) -> Result<()> {
        operator(principal)?;
        if input.tags.len() > MAX_RELATIONSHIPS {
            return Err(invalid("too many provisioned Tags"));
        }
        let (mut tx, _) = self.write().await?;
        let mut seen = BTreeSet::new();
        let mut created = Vec::new();
        for entry in input.tags {
            let mut tag = entry
                .tag
                .ok_or_else(|| invalid("missing provisioned Tag"))?;
            name("Tag ID", &tag.tag_id)?;
            if !seen.insert(tag.tag_id.clone()) {
                return Err(invalid("duplicate provisioned Tag"));
            }
            let exists: Option<i64> =
                sqlx::query_scalar("SELECT revision FROM supertag_v2_tags WHERE tag_id=$1")
                    .bind(&tag.tag_id)
                    .fetch_optional(&mut *tx)
                    .await?;
            if exists.is_some() {
                continue;
            }
            tag.expected_revision = Some(0);
            let tag = Self::put_tag_in(&mut tx, tag).await?;
            created.push(ReconcileTagRelationshipsRequest {
                tag_id: tag.tag_id,
                manager: "provision".into(),
                role_ids: entry.role_ids,
                mailbox_senders: entry.mailbox_senders,
                ..Default::default()
            });
        }
        for relationships in created {
            self.reconcile_in(&mut tx, principal, &relationships)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }
}

impl ControlPlane {
    pub fn manifest_relationships_service(
        &self,
    ) -> manifest_relationships_server::ManifestRelationshipsServer<Self> {
        manifest_relationships_server::ManifestRelationshipsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl manifest_relationships_server::ManifestRelationships for ControlPlane {
    async fn reconcile_tag(
        &self,
        request: Request<ReconcileTagRelationshipsRequest>,
    ) -> std::result::Result<Response<ReconcileTagRelationshipsResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .reconcile_tag_relationships(&principal, request.get_ref())
                .await?,
        ))
    }

    async fn provision_tags(
        &self,
        request: Request<ProvisionTagsRequest>,
    ) -> std::result::Result<Response<ProvisionTagsResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        self.store
            .provision_tags(&principal, request.into_inner())
            .await?;
        Ok(Response::new(ProvisionTagsResponse {}))
    }

    async fn reconcile_apply_set(
        &self,
        request: Request<ReconcileApplySetRequest>,
    ) -> std::result::Result<Response<ReconcileApplySetResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        let reconciled = self
            .store
            .reconcile_apply_set(&principal, request.get_ref())
            .await?;
        // Each member the prune removed is its own audit entry, like `resource.prune Tag/NAME`.
        let changes = if request.get_ref().preview {
            Vec::new()
        } else {
            reconciled
                .pruned
                .iter()
                .filter(|item| item.action() == ApplySetPruneAction::Delete)
                .map(|item| crate::audit::AuditChange {
                    action: "resource.prune".into(),
                    target: format!("{}/{}", item.kind, item.name),
                })
                .collect()
        };
        let mut response = Response::new(reconciled);
        response
            .extensions_mut()
            .insert(crate::audit::AuditChanges(changes));
        Ok(response)
    }
}
