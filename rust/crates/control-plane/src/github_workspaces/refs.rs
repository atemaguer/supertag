//! Resolve a frozen source selector once per Session, before execution is claimable.
use crate::{
    ControlPlane, Store, StoreError, policy,
    store::{Result, invalid},
};
use prost::Message;
use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};
use uuid::Uuid;

fn account(principal: &str) -> Result<&str> {
    principal
        .strip_prefix("source:github/")
        .filter(|id| !id.is_empty())
        .ok_or(StoreError::PermissionDenied)
}
fn decode(row: &AnyRow) -> Result<GithubSourcePin> {
    Ok(GithubSourcePin {
        pin_id: row.try_get("pin_id")?,
        tag_id: row.try_get("tag_id")?,
        session_id: row.try_get("session_id")?,
        selector: Some(policy::decode(&row.try_get::<Vec<u8>, _>("selector")?)?),
        selector_digest: row.try_get("selector_digest")?,
        resolved: row
            .try_get::<Option<Vec<u8>>, _>("resolved")?
            .as_deref()
            .map(policy::decode)
            .transpose()?,
        created_order: row.try_get::<i64, _>("created_order")? as u64,
    })
}
fn digest(value: &GithubWorkspace) -> String {
    format!("{:x}", Sha256::digest(value.encode_to_vec()))
}
fn selector(value: &GithubWorkspace) -> GithubWorkspace {
    let mut value = value.clone();
    if let Some(source) = &mut value.source
        && source.resolved_revision.is_some()
    {
        source.commit_sha.clear();
        source.resolved_revision = None;
    }
    value
}
/// Current policy may be compared with a child that inherited its parent's pin.
pub(crate) fn inherit(workspace: &mut Option<WorkspaceSpec>, prior: &Option<WorkspaceSpec>) {
    if let (Some(current), Some(prior)) = (workspace, prior)
        && current.workspace_id == prior.workspace_id
        && let (Some(selected), Some(pinned)) = (&current.github_source, &prior.github_source)
        && selector(selected) == selector(pinned)
    {
        *current = prior.clone();
    }
}
/// A Session pin never consults a mutable catalog during resolution or replay.
pub(crate) async fn bind_in(
    tx: &mut Transaction<'_, Any>,
    tag: &str,
    session: &str,
    workspace: &mut Option<WorkspaceSpec>,
) -> Result<()> {
    let Some(spec) = workspace else { return Ok(()) };
    let Some(value) = &spec.github_source else {
        return Ok(());
    };
    let Some(source) = &value.source else {
        return Err(invalid("GitHub source is missing"));
    };
    if !source.commit_sha.is_empty() {
        return Ok(());
    }
    let existing = sqlx::query(
        "SELECT * FROM supertag_v2_github_source_pins WHERE tag_id=$1 AND session_id=$2",
    )
    .bind(tag)
    .bind(session)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(row) = existing {
        let pin = decode(&row)?;
        if pin.selector.as_ref() != Some(value) {
            return Err(StoreError::FailedPrecondition(
                "GitHub source selection changed; start a new Session".into(),
            ));
        }
        if let Some(resolved) = pin.resolved {
            spec.base_commit = resolved
                .source
                .as_ref()
                .ok_or_else(|| invalid("GitHub source pin is incomplete"))?
                .commit_sha
                .clone();
            spec.github_source = Some(resolved);
        }
    } else {
        let order = crate::store::next_order(tx).await?;
        sqlx::query("INSERT INTO supertag_v2_github_source_pins(pin_id,tag_id,session_id,account_id,selector,selector_digest,created_order) VALUES($1,$2,$3,$4,$5,$6,$7)")
            .bind(Uuid::new_v4().to_string()).bind(tag).bind(session).bind(&source.account_id).bind(value.encode_to_vec()).bind(digest(value)).bind(order).execute(&mut **tx).await?;
    }
    Ok(())
}
impl Store {
    pub async fn list_pending_github_sources(
        &self,
        principal: &str,
        input: &ListPendingGithubSourcesRequest,
    ) -> Result<ListPendingGithubSourcesResponse> {
        let account = account(principal)?;
        let after = i64::try_from(input.after_order)
            .map_err(|_| invalid("source cursor is outside its range"))?;
        let limit = if input.limit == 0 {
            50
        } else {
            input.limit.min(100)
        } as usize;
        let rows=sqlx::query("SELECT pin.* FROM supertag_v2_github_source_pins pin WHERE account_id=$1 AND resolved IS NULL AND created_order>$2 AND EXISTS(SELECT 1 FROM supertag_v2_tasks t WHERE t.tag_id=pin.tag_id AND t.session_id=pin.session_id AND t.state=$3) ORDER BY created_order LIMIT $4")
            .bind(account).bind(after).bind(TaskState::Queued as i64).bind((limit+1) as i64).fetch_all(&self.pool).await?;
        let mut pins = Vec::new();
        let mut bytes = 0;
        let mut more = false;
        for row in rows {
            let pin = decode(&row)?;
            bytes += pin.encoded_len() + 16;
            if pins.len() == limit || bytes > MAX_MESSAGE_BYTES - 4096 {
                more = true;
                break;
            }
            pins.push(pin);
        }
        let next_after_order = if more {
            pins.last().map_or(0, |pin| pin.created_order)
        } else {
            0
        };
        Ok(ListPendingGithubSourcesResponse {
            pins,
            next_after_order,
        })
    }
    pub async fn pin_github_source(
        &self,
        principal: &str,
        input: &PinGithubSourceRequest,
    ) -> Result<GithubSourcePin> {
        let account = account(principal)?;
        if !supertag_protocol::valid_git_commit(&input.commit_sha) {
            return Err(invalid("full Git source commit required"));
        }
        super::validate_source_revision(&input.resolved_revision)?;
        let (mut tx, _) = self.write().await?;
        let row = sqlx::query("SELECT * FROM supertag_v2_github_source_pins WHERE pin_id=$1")
            .bind(&input.pin_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| StoreError::NotFound("GitHub source selection was not found".into()))?;
        if row.try_get::<String, _>("account_id")? != account {
            return Err(StoreError::PermissionDenied);
        }
        let mut pin = decode(&row)?;
        if pin.selector_digest != input.selector_digest {
            return Err(StoreError::Conflict(
                "GitHub source selector changed".into(),
            ));
        }
        let mut resolved = pin
            .selector
            .clone()
            .ok_or_else(|| invalid("GitHub source selector is missing"))?;
        let source = resolved
            .source
            .as_mut()
            .ok_or_else(|| invalid("GitHub source selector is missing"))?;
        if source
            .revision
            .as_ref()
            .is_some_and(|requested| requested != &input.resolved_revision)
        {
            return Err(StoreError::Conflict(
                "GitHub source resolution changed the requested revision".into(),
            ));
        }
        // A delayed or competing lookup may observe a new remote head. The
        // committed Session pin wins; it is never silently moved on replay.
        if pin.resolved.is_some() {
            return Ok(pin);
        }
        source.commit_sha = input.commit_sha.clone();
        source.resolved_revision = Some(input.resolved_revision.clone());
        let selector = pin.selector.as_ref().unwrap().encode_to_vec();
        sqlx::query("UPDATE supertag_v2_tasks SET workspace_base_commit=$1,workspace_github_source=$2 WHERE tag_id=$3 AND session_id=$4 AND workspace_github_source=$5 AND state=$6")
            .bind(&input.commit_sha).bind(resolved.encode_to_vec()).bind(&pin.tag_id).bind(&pin.session_id).bind(selector).bind(TaskState::Queued as i64).execute(&mut *tx).await?;
        sqlx::query("UPDATE supertag_v2_github_source_pins SET resolved=$1 WHERE pin_id=$2")
            .bind(resolved.encode_to_vec())
            .bind(&pin.pin_id)
            .execute(&mut *tx)
            .await?;
        pin.resolved = Some(resolved);
        tx.commit().await?;
        Ok(pin)
    }
}
impl ControlPlane {
    pub fn github_source_resolver_service(
        &self,
    ) -> github_source_resolver_server::GithubSourceResolverServer<Self> {
        github_source_resolver_server::GithubSourceResolverServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}
#[tonic::async_trait]
impl github_source_resolver_server::GithubSourceResolver for ControlPlane {
    async fn list_pending(
        &self,
        request: Request<ListPendingGithubSourcesRequest>,
    ) -> std::result::Result<Response<ListPendingGithubSourcesResponse>, Status> {
        let principal = self.principal(&request, "source:github/")?;
        Ok(Response::new(
            self.store
                .list_pending_github_sources(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn pin(
        &self,
        request: Request<PinGithubSourceRequest>,
    ) -> std::result::Result<Response<GithubSourcePin>, Status> {
        let principal = self.principal(&request, "source:github/")?;
        Ok(Response::new(
            self.store
                .pin_github_source(&principal, request.get_ref())
                .await?,
        ))
    }
}
