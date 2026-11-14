//! Immutable GitHub source authority, independent of native file permissions.
use prost::Message;
use sqlx::{Any, Row, Transaction};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*, valid_workspace_id};
use tonic::{Request, Response, Status};

use crate::{
    ControlPlane, Store, StoreError, policy,
    store::{HostAuthority, Result, invalid, lease_is_live, name, owned, task_row},
};

pub(crate) mod refs;
pub(crate) mod selection;

const RESOURCE: &str = "github-workspace";

async fn catalog_in(tx: &mut Transaction<'_, Any>, id: &str) -> Result<Option<GithubWorkspace>> {
    let bytes: Option<Vec<u8>> = sqlx::query_scalar(
        "SELECT payload FROM supertag_v2_github_workspaces WHERE workspace_id=$1",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?;
    bytes.as_deref().map(policy::decode).transpose()
}

/// The revision of a cataloged Workspace.
pub(crate) async fn revision_in(tx: &mut Transaction<'_, Any>, id: &str) -> Result<Option<u64>> {
    Ok(catalog_in(tx, id).await?.map(|value| value.revision))
}

/// Deletes a Workspace no active Tag uses, at `expected_revision`.
pub(crate) async fn delete_in(
    tx: &mut Transaction<'_, Any>,
    id: &str,
    expected_revision: u64,
) -> Result<()> {
    let prior = catalog_in(tx, id)
        .await?
        .ok_or_else(|| StoreError::NotFound("GitHub Workspace was not found".into()))?;
    if prior.revision != expected_revision {
        return Err(StoreError::Conflict(
            "GitHub Workspace revision changed".into(),
        ));
    }
    let used: Option<String> = sqlx::query_scalar("SELECT tag_id FROM supertag_v2_tags WHERE workspace_id=$1 AND retired_at_ms IS NULL LIMIT 1")
        .bind(id).fetch_optional(&mut **tx).await?;
    if used.is_some() {
        return Err(StoreError::FailedPrecondition(
            "GitHub Workspace is still assigned to a Tag".into(),
        ));
    }
    sqlx::query("DELETE FROM supertag_v2_github_workspaces WHERE workspace_id=$1")
        .bind(id)
        .execute(&mut **tx)
        .await?;
    crate::apply_sets::forget(tx, "Workspace", id).await
}

pub fn validate_manifest_workspace(value: &mut GithubWorkspace) -> Result<()> {
    if !valid_workspace_id(&value.workspace_id) {
        return Err(invalid("valid Workspace ID required"));
    }
    let source = value
        .source
        .as_mut()
        .ok_or_else(|| invalid("GitHub source required"))?;
    name("GitHub Surface Account ID", &source.account_id)?;
    if source.repository_id == 0 || source.repository_id > 9_007_199_254_740_991 {
        return Err(invalid(
            "GitHub repository ID is outside its supported range",
        ));
    }
    let parts: Vec<_> = source.repository.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || part.len() > 100
                || matches!(*part, "." | "..")
                || !part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
        })
        || source.repository.ends_with(".git")
    {
        return Err(invalid("GitHub repository must be owner/name"));
    }
    if let Some(delivery) = &value.pull_request {
        validate_base_branch(&delivery.base_branch)?;
    }
    source.repository.make_ascii_lowercase();
    if source.resolved_revision.is_some()
        || (!source.commit_sha.is_empty()
            && (!supertag_protocol::valid_git_commit(&source.commit_sha)
                || source.revision.is_some()))
    {
        return Err(invalid(
            "select a full lowercase commit SHA or a Git revision",
        ));
    }
    if let Some(revision) = &source.revision {
        validate_source_revision(revision)?;
    }
    Ok(())
}

fn validate_source_revision(revision: &str) -> Result<()> {
    // This value is one encoded REST path segment, never a Git command argument.
    // Keep Unicode and slash-bearing refs accepted without interpreting revisions.
    if revision.is_empty()
        || revision.len() > 1024
        || revision.trim() != revision
        || matches!(revision, "." | "..")
        || revision.chars().any(char::is_control)
    {
        return Err(invalid("GitHub source revision must contain 1–1024 bytes"));
    }
    Ok(())
}

pub(crate) fn validate_base_branch(branch: &str) -> Result<()> {
    if branch.is_empty()
        || branch.len() > 200
        || branch.starts_with('-')
        || branch.starts_with('/')
        || branch.ends_with('/')
        || branch.ends_with('.')
        || branch.contains("..")
        || branch.contains("@{")
        || branch.contains("//")
        || branch
            .split('/')
            .any(|part| part.starts_with('.') || part.ends_with(".lock"))
        || !branch
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"/-_.".contains(&byte))
    {
        return Err(invalid(
            "pull request base must be an explicit Git branch name",
        ));
    }
    Ok(())
}

async fn require_account_in(
    tx: &mut Transaction<'_, Any>,
    source: &GithubWorkspaceSource,
) -> Result<()> {
    let bytes: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT payload FROM supertag_v2_surface_accounts WHERE account_id=$1")
            .bind(&source.account_id)
            .fetch_optional(&mut **tx)
            .await?;
    let account: SurfaceAccount = policy::decode(
        &bytes
            .ok_or_else(|| StoreError::NotFound("GitHub Surface Account was not found".into()))?,
    )?;
    if !account.enabled
        || !matches!(
            account.identity.and_then(|identity| identity.provider),
            Some(surface_account_identity::Provider::Github(_))
        )
    {
        return Err(StoreError::FailedPrecondition(
            "an enabled GitHub Surface Account is required".into(),
        ));
    }
    Ok(())
}

fn require_read(snapshot: &TaskPolicySnapshot, source: &GithubWorkspaceSource) -> Result<()> {
    let scope = format!("repository:{}", source.repository_id);
    let matching: Vec<_> = snapshot
        .permission_sets
        .iter()
        .flat_map(|set| &set.permissions)
        .filter(|permission| {
            permission.target() == PolicyPermissionTarget::Surface
                && permission.surface_account_id == source.account_id
                && permission.scope == scope
                && permission.action == "contents:read"
        })
        .collect();
    if matching
        .iter()
        .any(|permission| permission.approval_required)
    {
        // A direct runtime file grant must not silently bypass a gated source read.
        return Err(StoreError::FailedPrecondition(
            "GitHub source reads requiring approval are not supported yet".into(),
        ));
    }
    let from_origin = snapshot.origin.as_ref().is_some_and(|origin| {
        origin.account_id == source.account_id
            && origin.origin_actions.iter().any(|action| action == "contents:read")
            && matches!(origin.scope.as_ref().and_then(|scope| scope.provider.as_ref()), Some(surface_location_scope::Provider::Github(repository)) if repository.repository_id == source.repository_id)
    });
    if matching.is_empty() && !from_origin {
        return Err(StoreError::PermissionDenied);
    }
    Ok(())
}

pub(crate) async fn validate_tag_in(
    tx: &mut Transaction<'_, Any>,
    workspace: Option<&WorkspaceSpec>,
) -> Result<()> {
    let Some(spec) = workspace else {
        return Ok(());
    };
    let configured = catalog_in(tx, &spec.workspace_id).await?.is_some();
    if configured && !spec.base_ref.is_empty() {
        return Err(invalid(
            "a GitHub Workspace selects its revision on the Workspace, not a Tag branch",
        ));
    }
    if !configured && spec.base_commit.is_empty() && spec.base_ref.is_empty() {
        return Err(invalid(
            "local Workspace requires a full Git base commit or a branch to follow",
        ));
    }
    Ok(())
}

pub(crate) async fn admission_in(
    tx: &mut Transaction<'_, Any>,
    workspace: &mut Option<WorkspaceSpec>,
    policy: &TaskPolicySnapshot,
) -> Result<()> {
    let Some(spec) = workspace else {
        return Ok(());
    };
    let Some(value) = catalog_in(tx, &spec.workspace_id).await? else {
        return Ok(());
    };
    if !spec.base_ref.is_empty() {
        return Err(StoreError::FailedPrecondition(
            "a GitHub Workspace selects its revision on the Workspace, not a Tag branch".into(),
        ));
    }
    let source = value
        .source
        .as_ref()
        .ok_or_else(|| invalid("stored GitHub source is incomplete"))?;
    if !spec.base_commit.is_empty() && source.commit_sha != spec.base_commit {
        return Err(StoreError::FailedPrecondition(
            "Workspace base does not match its configured GitHub source".into(),
        ));
    }
    require_account_in(tx, source).await?;
    require_read(policy, source)?;
    if value.pull_request.is_some() {
        crate::external_effects::surface(
            policy,
            &source.account_id,
            &format!("repository:{}", source.repository_id),
            "pull-requests:create",
        )?;
    }
    spec.base_commit = source.commit_sha.clone();
    spec.github_source = Some(value);
    Ok(())
}

impl Store {
    pub async fn put_github_workspace(
        &self,
        principal: &str,
        input: &PutGithubWorkspaceRequest,
    ) -> Result<GithubWorkspace> {
        policy::operator(principal)?;
        name("operation ID", &input.operation_id)?;
        let digest = policy::digest("put-github-workspace", input);
        let (mut tx, _) = self.write().await?;
        if let Some(prior) =
            policy::replay(&mut tx, principal, &input.operation_id, &digest).await?
        {
            return Ok(prior);
        }
        let mut value = input
            .workspace
            .clone()
            .ok_or_else(|| invalid("GitHub Workspace required"))?;
        validate_manifest_workspace(&mut value)?;
        let prior = catalog_in(&mut tx, &value.workspace_id).await?;
        if input.expected_revision != prior.as_ref().map(|value| value.revision) {
            return Err(StoreError::Conflict(
                "GitHub Workspace revision changed".into(),
            ));
        }
        require_account_in(&mut tx, value.source.as_ref().unwrap()).await?;
        if let Some(prior) = prior.filter(|prior| {
            prior.source == value.source && prior.pull_request == value.pull_request
        }) {
            value = prior;
        } else {
            value.revision =
                policy::next_revision_in(&mut tx, RESOURCE, &value.workspace_id).await?;
            sqlx::query("INSERT INTO supertag_v2_github_workspaces (workspace_id,revision,payload) VALUES ($1,$2,$3) ON CONFLICT(workspace_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload")
                .bind(&value.workspace_id).bind(value.revision as i64).bind(value.encode_to_vec()).execute(&mut *tx).await?;
        }
        policy::receipt(&mut tx, principal, &input.operation_id, &digest, &value).await?;
        tx.commit().await?;
        Ok(value)
    }

    pub async fn get_github_workspace(
        &self,
        principal: &str,
        input: &GetGithubWorkspaceRequest,
    ) -> Result<GithubWorkspace> {
        policy::operator(principal)?;
        name("Workspace ID", &input.workspace_id)?;
        let mut tx = self.pool.begin().await?;
        catalog_in(&mut tx, &input.workspace_id)
            .await?
            .ok_or_else(|| StoreError::NotFound("GitHub Workspace was not found".into()))
    }

    pub async fn list_github_workspaces(
        &self,
        principal: &str,
        input: &ListGithubWorkspacesRequest,
    ) -> Result<ListGithubWorkspacesResponse> {
        policy::operator(principal)?;
        if !input.after_id.is_empty() {
            name("Workspace cursor", &input.after_id)?;
        }
        let limit = if input.limit == 0 {
            50
        } else {
            input.limit.min(100)
        };
        let rows: Vec<Vec<u8>> = sqlx::query_scalar("SELECT payload FROM supertag_v2_github_workspaces WHERE workspace_id>$1 ORDER BY workspace_id LIMIT $2")
            .bind(&input.after_id).bind(i64::from(limit) + 1).fetch_all(&self.pool).await?;
        let has_more = rows.len() > limit as usize;
        let workspaces = rows
            .into_iter()
            .take(limit as usize)
            .map(|bytes| policy::decode(&bytes))
            .collect::<Result<Vec<GithubWorkspace>>>()?;
        let next_cursor = if has_more {
            workspaces.last().unwrap().workspace_id.clone()
        } else {
            String::new()
        };
        Ok(ListGithubWorkspacesResponse {
            workspaces,
            next_cursor,
        })
    }

    pub async fn delete_github_workspace(
        &self,
        principal: &str,
        input: &DeleteGithubWorkspaceRequest,
    ) -> Result<DeleteGithubWorkspaceResponse> {
        policy::operator(principal)?;
        name("operation ID", &input.operation_id)?;
        name("Workspace ID", &input.workspace_id)?;
        let digest = policy::digest("delete-github-workspace", input);
        let (mut tx, _) = self.write().await?;
        if let Some(prior) =
            policy::replay(&mut tx, principal, &input.operation_id, &digest).await?
        {
            return Ok(prior);
        }
        delete_in(&mut tx, &input.workspace_id, input.expected_revision).await?;
        let response = DeleteGithubWorkspaceResponse {};
        policy::receipt(&mut tx, principal, &input.operation_id, &digest, &response).await?;
        tx.commit().await?;
        Ok(response)
    }

    pub async fn get_github_workspace_source(
        &self,
        host: &HostAuthority,
        attempt: &InspectAttemptRequest,
    ) -> Result<GithubWorkspace> {
        let mut tx = self.pool.begin().await?;
        let row = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        if row.try_get::<i64, _>("state")? != TaskState::Running as i64
            || !lease_is_live(&row, self.execution_now_ms())?
        {
            return Err(StoreError::FailedPrecondition(
                "GitHub source requires a live running Attempt".into(),
            ));
        }
        let task = task_row(&row)?;
        let value = task
            .workspace
            .and_then(|workspace| workspace.github_source)
            .ok_or_else(|| StoreError::NotFound("Task has no GitHub source".into()))?;
        require_read(
            &task
                .policy_snapshot
                .ok_or_else(|| invalid("Task source policy is missing"))?,
            value
                .source
                .as_ref()
                .ok_or_else(|| invalid("Task source is incomplete"))?,
        )?;
        Ok(value)
    }
}

impl ControlPlane {
    pub fn github_workspaces_service(
        &self,
    ) -> github_workspaces_server::GithubWorkspacesServer<Self> {
        github_workspaces_server::GithubWorkspacesServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl github_workspaces_server::GithubWorkspaces for ControlPlane {
    async fn put(
        &self,
        request: Request<PutGithubWorkspaceRequest>,
    ) -> std::result::Result<Response<GithubWorkspace>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .put_github_workspace(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn get(
        &self,
        request: Request<GetGithubWorkspaceRequest>,
    ) -> std::result::Result<Response<GithubWorkspace>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .get_github_workspace(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn list(
        &self,
        request: Request<ListGithubWorkspacesRequest>,
    ) -> std::result::Result<Response<ListGithubWorkspacesResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_github_workspaces(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn delete(
        &self,
        request: Request<DeleteGithubWorkspaceRequest>,
    ) -> std::result::Result<Response<DeleteGithubWorkspaceResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .delete_github_workspace(&principal, request.get_ref())
                .await?,
        ))
    }
}
