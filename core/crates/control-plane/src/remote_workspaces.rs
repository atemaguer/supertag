//! Remote Workspaces: a git source on any git server and where Session changes land. The
//! catalog holds names, never secrets; a Task receives an immutable copy at admission.
use prost::Message;
use sqlx::{Any, Row, Transaction};
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    git_remote::{self, remote_transport, valid_credential_name, valid_merge_target},
    v2::*,
    valid_git_branch, valid_workspace_id,
};
use tonic::{Request, Response, Status};

use crate::{
    ControlPlane, Store, StoreError, policy,
    store::{HostAuthority, Result, invalid, lease_is_live, name, owned, task_row},
};

pub(crate) mod pins;

const RESOURCE: &str = "workspace";

pub(crate) async fn catalog_in(
    tx: &mut Transaction<'_, Any>,
    id: &str,
) -> Result<Option<Workspace>> {
    let bytes: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT payload FROM supertag_v2_workspaces WHERE workspace_id=$1")
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
        .ok_or_else(|| StoreError::NotFound("Workspace was not found".into()))?;
    if prior.revision != expected_revision {
        return Err(StoreError::Conflict("Workspace revision changed".into()));
    }
    let used: Option<String> = sqlx::query_scalar("SELECT tag_id FROM supertag_v2_tags WHERE workspace_id=$1 AND retired_at_ms IS NULL LIMIT 1")
        .bind(id).fetch_optional(&mut **tx).await?;
    if used.is_some() {
        return Err(StoreError::FailedPrecondition(
            "Workspace is still assigned to a Tag".into(),
        ));
    }
    sqlx::query("DELETE FROM supertag_v2_workspaces WHERE workspace_id=$1")
        .bind(id)
        .execute(&mut **tx)
        .await?;
    crate::apply_sets::forget(tx, "Workspace", id).await
}

/// Validates and normalizes a Workspace as an operator declares it.
pub fn validate_manifest_workspace(value: &mut Workspace) -> Result<()> {
    if !valid_workspace_id(&value.workspace_id) {
        return Err(invalid("valid Workspace ID required"));
    }
    remote_transport(&value.remote).map_err(invalid_owned)?;
    if !value.r#ref.is_empty() && !valid_git_branch(&value.r#ref) {
        return Err(invalid("a Workspace ref is a branch name, such as main"));
    }
    if !value.commit.is_empty() || !value.resolved_ref.is_empty() {
        return Err(invalid(
            "a Workspace selects a branch; SuperTag pins its commit per Session",
        ));
    }
    let credentials = value.credentials.get_or_insert_default();
    for credential in [&credentials.read, &credentials.push] {
        if !credential.is_empty() && !valid_credential_name(credential) {
            return Err(invalid("invalid Workspace Credential name"));
        }
    }
    // github.com is GitHub; any other host is a GitHub forge only when the operator says so.
    if value.forge() == WorkspaceForge::Unspecified && git_remote::on_github_com(&value.remote) {
        value.set_forge(WorkspaceForge::Github);
    }
    if value.forge() == WorkspaceForge::Github && git_remote::github_remote(&value.remote).is_none()
    {
        return Err(invalid(
            "a GitHub Workspace remote names a host and OWNER/NAME, such as https://github.com/acme/app.git",
        ));
    }
    match value.land.as_ref().and_then(|land| land.mode.as_ref()) {
        None => value.land = None,
        Some(workspace_land::Mode::Branch(_)) => {}
        Some(workspace_land::Mode::Review(review)) => {
            if value.forge() != WorkspaceForge::Github {
                return Err(invalid(
                    "review opens pull requests through a forge; a plain git remote offers branch and merge. For a self-hosted GitHub, add --forge github",
                ));
            }
            if !valid_git_branch(&review.base) || review.base.starts_with("supertag/") {
                return Err(invalid(
                    "a review base is a branch name outside supertag/, such as main",
                ));
            }
        }
        Some(workspace_land::Mode::Merge(merge)) => {
            if !valid_merge_target(&merge.target) {
                return Err(invalid(
                    "a merge target is a branch name outside supertag/, such as drafts",
                ));
            }
        }
    }
    Ok(())
}

fn invalid_owned(message: String) -> StoreError {
    StoreError::InvalidArgument(message)
}

/// Every Workspace Credential the Workspace names must exist.
async fn require_credentials_in(tx: &mut Transaction<'_, Any>, value: &Workspace) -> Result<()> {
    let Some(credentials) = &value.credentials else {
        return Ok(());
    };
    for credential in [&credentials.read, &credentials.push] {
        if credential.is_empty() {
            continue;
        }
        let Some(stored) = crate::workspace_credentials::catalog_in(tx, credential).await? else {
            return Err(StoreError::FailedPrecondition(format!(
                "Workspace Credential {credential} was not found; add it with supertag workspace credential add"
            )));
        };
        if stored.kind() == WorkspaceCredentialKind::GithubApp
            && (value.forge() != WorkspaceForge::Github
                || remote_transport(&value.remote) != Ok(git_remote::RemoteTransport::Http))
        {
            return Err(StoreError::FailedPrecondition(format!(
                "Workspace Credential {credential} is a GitHub App, which reaches only https:// GitHub remotes"
            )));
        }
    }
    // The review adapter calls the forge's API with the push credential.
    if let Some(workspace_land::Mode::Review(_)) =
        value.land.as_ref().and_then(|land| land.mode.as_ref())
    {
        let name = if credentials.push.is_empty() {
            &credentials.read
        } else {
            &credentials.push
        };
        let kind = if name.is_empty() {
            None
        } else {
            crate::workspace_credentials::catalog_in(tx, name)
                .await?
                .map(|stored| stored.kind())
        };
        if !matches!(
            kind,
            Some(WorkspaceCredentialKind::GithubApp | WorkspaceCredentialKind::HttpsToken)
        ) {
            return Err(StoreError::FailedPrecondition(
                "review calls the GitHub API with the push credential: use a GitHub App or HTTPS token Workspace Credential".into(),
            ));
        }
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
    if configured && (!spec.base_ref.is_empty() || !spec.base_commit.is_empty()) {
        return Err(invalid(
            "a remote Workspace selects its branch on the Workspace, not on the Tag",
        ));
    }
    if !configured && spec.base_commit.is_empty() && spec.base_ref.is_empty() {
        return Err(invalid(
            "local Workspace requires a full Git base commit or a branch to follow",
        ));
    }
    Ok(())
}

/// Copies the cataloged remote into a Task's Workspace. The commit is pinned per Session later.
pub(crate) async fn admission_in(
    tx: &mut Transaction<'_, Any>,
    workspace: &mut Option<WorkspaceSpec>,
) -> Result<()> {
    let Some(spec) = workspace else {
        return Ok(());
    };
    let Some(value) = catalog_in(tx, &spec.workspace_id).await? else {
        return Ok(());
    };
    if !spec.base_ref.is_empty() || !spec.base_commit.is_empty() {
        return Err(StoreError::FailedPrecondition(
            "a remote Workspace selects its branch on the Workspace, not on the Tag".into(),
        ));
    }
    require_credentials_in(tx, &value).await?;
    spec.remote = Some(value);
    Ok(())
}

impl Store {
    pub async fn put_workspace(
        &self,
        principal: &str,
        input: &PutWorkspaceRequest,
    ) -> Result<Workspace> {
        policy::operator(principal)?;
        name("operation ID", &input.operation_id)?;
        let digest = policy::digest("put-workspace", input);
        let (mut tx, _) = self.write().await?;
        if let Some(prior) =
            policy::replay(&mut tx, principal, &input.operation_id, &digest).await?
        {
            return Ok(prior);
        }
        let mut value = input
            .workspace
            .clone()
            .ok_or_else(|| invalid("Workspace required"))?;
        value.revision = 0;
        validate_manifest_workspace(&mut value)?;
        let prior = catalog_in(&mut tx, &value.workspace_id).await?;
        if input.expected_revision != prior.as_ref().map(|value| value.revision) {
            return Err(StoreError::Conflict("Workspace revision changed".into()));
        }
        require_credentials_in(&mut tx, &value).await?;
        if let Some(prior) = prior.filter(|prior| {
            Workspace {
                revision: 0,
                ..prior.clone()
            } == value
        }) {
            value = prior;
        } else {
            value.revision =
                policy::next_revision_in(&mut tx, RESOURCE, &value.workspace_id).await?;
            sqlx::query("INSERT INTO supertag_v2_workspaces (workspace_id,revision,payload) VALUES ($1,$2,$3) ON CONFLICT(workspace_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload")
                .bind(&value.workspace_id).bind(value.revision as i64).bind(value.encode_to_vec()).execute(&mut *tx).await?;
        }
        policy::receipt(&mut tx, principal, &input.operation_id, &digest, &value).await?;
        tx.commit().await?;
        Ok(value)
    }

    pub async fn get_workspace(
        &self,
        principal: &str,
        input: &GetWorkspaceRequest,
    ) -> Result<Workspace> {
        policy::operator(principal)?;
        name("Workspace ID", &input.workspace_id)?;
        let mut tx = self.pool.begin().await?;
        catalog_in(&mut tx, &input.workspace_id)
            .await?
            .ok_or_else(|| StoreError::NotFound("Workspace was not found".into()))
    }

    pub async fn list_workspaces(
        &self,
        principal: &str,
        input: &ListWorkspacesRequest,
    ) -> Result<ListWorkspacesResponse> {
        policy::operator(principal)?;
        if !input.after_id.is_empty() {
            name("Workspace cursor", &input.after_id)?;
        }
        let limit = if input.limit == 0 {
            50
        } else {
            input.limit.min(100)
        };
        let rows: Vec<Vec<u8>> = sqlx::query_scalar("SELECT payload FROM supertag_v2_workspaces WHERE workspace_id>$1 ORDER BY workspace_id LIMIT $2")
            .bind(&input.after_id).bind(i64::from(limit) + 1).fetch_all(&self.pool).await?;
        let has_more = rows.len() > limit as usize;
        let workspaces = rows
            .into_iter()
            .take(limit as usize)
            .map(|bytes| policy::decode(&bytes))
            .collect::<Result<Vec<Workspace>>>()?;
        let next_cursor = if has_more {
            workspaces.last().unwrap().workspace_id.clone()
        } else {
            String::new()
        };
        Ok(ListWorkspacesResponse {
            workspaces,
            next_cursor,
        })
    }

    pub async fn delete_workspace(
        &self,
        principal: &str,
        input: &DeleteWorkspaceRequest,
    ) -> Result<DeleteWorkspaceResponse> {
        policy::operator(principal)?;
        name("operation ID", &input.operation_id)?;
        name("Workspace ID", &input.workspace_id)?;
        let digest = policy::digest("delete-workspace", input);
        let (mut tx, _) = self.write().await?;
        if !input.dry_run
            && let Some(prior) =
                policy::replay(&mut tx, principal, &input.operation_id, &digest).await?
        {
            return Ok(prior);
        }
        delete_in(&mut tx, &input.workspace_id, input.expected_revision).await?;
        let response = DeleteWorkspaceResponse {};
        if input.dry_run {
            // A dry run makes every check the deletion makes, then rolls it back unrecorded.
            tx.rollback().await?;
            return Ok(response);
        }
        policy::receipt(&mut tx, principal, &input.operation_id, &digest, &response).await?;
        tx.commit().await?;
        Ok(response)
    }

    /// The remote Workspace and commit a live running Attempt downloads: its pinned base commit,
    /// or with `merge` its merge follow-up's target commit.
    pub async fn get_workspace_source(
        &self,
        host: &HostAuthority,
        input: &DownloadWorkspaceSourceRequest,
    ) -> Result<WorkspaceSourceBundle> {
        let attempt = input
            .attempt
            .as_ref()
            .ok_or_else(|| invalid("Attempt is required"))?;
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
                "Workspace source requires a live running Attempt".into(),
            ));
        }
        let spec = task_row(&row)?
            .workspace
            .ok_or_else(|| StoreError::NotFound("Task has no Workspace".into()))?;
        let remote = spec
            .remote
            .filter(|remote| supertag_protocol::valid_git_commit(&remote.commit))
            .ok_or_else(|| StoreError::NotFound("Task has no remote Workspace source".into()))?;
        let commit = if input.merge {
            if !supertag_protocol::valid_git_commit(&spec.merge_commit) {
                return Err(StoreError::NotFound(
                    "Task has no merge commit to download".into(),
                ));
            }
            spec.merge_commit
        } else {
            remote.commit.clone()
        };
        Ok(WorkspaceSourceBundle {
            workspace: Some(remote),
            bundle: None,
            commit,
        })
    }
}

impl ControlPlane {
    pub fn workspaces_service(&self) -> workspaces_server::WorkspacesServer<Self> {
        workspaces_server::WorkspacesServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl workspaces_server::Workspaces for ControlPlane {
    async fn put(
        &self,
        request: Request<PutWorkspaceRequest>,
    ) -> std::result::Result<Response<Workspace>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .put_workspace(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn get(
        &self,
        request: Request<GetWorkspaceRequest>,
    ) -> std::result::Result<Response<Workspace>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .get_workspace(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn list(
        &self,
        request: Request<ListWorkspacesRequest>,
    ) -> std::result::Result<Response<ListWorkspacesResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_workspaces(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn delete(
        &self,
        request: Request<DeleteWorkspaceRequest>,
    ) -> std::result::Result<Response<DeleteWorkspaceResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .delete_workspace(&principal, request.get_ref())
                .await?,
        ))
    }
    /// Served by the API tier, which runs git delivery; the state owner has no git.
    async fn check(
        &self,
        _request: Request<CheckWorkspaceRequest>,
    ) -> std::result::Result<Response<WorkspaceCheck>, Status> {
        Err(Status::unimplemented(
            "the API tier checks Workspaces with git delivery",
        ))
    }
}
