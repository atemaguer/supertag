//! Workspace Credentials: names, kinds, and non-secret identifiers of what git delivery uses to
//! read and push remotes. The secrets stay in the credential vault of the machine that runs git
//! delivery; the Control Plane database never holds key material or tokens.
use prost::Message;
use sqlx::{Any, Transaction};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};

use crate::{
    ControlPlane, Store, StoreError, policy,
    store::{Result, invalid, name},
};

const RESOURCE: &str = "workspace-credential";

pub(crate) async fn catalog_in(
    tx: &mut Transaction<'_, Any>,
    name: &str,
) -> Result<Option<WorkspaceCredential>> {
    let bytes: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT payload FROM supertag_v2_workspace_credentials WHERE name=$1")
            .bind(name)
            .fetch_optional(&mut **tx)
            .await?;
    bytes.as_deref().map(policy::decode).transpose()
}

fn validate(value: &WorkspaceCredential) -> Result<()> {
    crate::store::resource_id("Workspace Credential name", &value.name)?;
    if value.kind() == WorkspaceCredentialKind::Unspecified {
        return Err(invalid("a Workspace Credential kind is required"));
    }
    if value.identifier.len() > 512 || value.identifier.chars().any(char::is_control) {
        return Err(invalid("invalid Workspace Credential identifier"));
    }
    Ok(())
}

impl Store {
    pub async fn put_workspace_credential(
        &self,
        principal: &str,
        input: &PutWorkspaceCredentialRequest,
    ) -> Result<WorkspaceCredential> {
        policy::operator(principal)?;
        name("operation ID", &input.operation_id)?;
        let digest = policy::digest("put-workspace-credential", input);
        let (mut tx, _) = self.write().await?;
        if let Some(prior) =
            policy::replay(&mut tx, principal, &input.operation_id, &digest).await?
        {
            return Ok(prior);
        }
        let mut value = input
            .credential
            .clone()
            .ok_or_else(|| invalid("Workspace Credential required"))?;
        value.revision = 0;
        validate(&value)?;
        let prior = catalog_in(&mut tx, &value.name).await?;
        if input
            .expected_revision
            .is_some_and(|expected| Some(expected) != prior.as_ref().map(|value| value.revision))
        {
            return Err(StoreError::Conflict(
                "Workspace Credential revision changed".into(),
            ));
        }
        if let Some(prior) = prior.filter(|prior| {
            WorkspaceCredential {
                revision: 0,
                ..prior.clone()
            } == value
        }) {
            value = prior;
        } else {
            value.revision = policy::next_revision_in(&mut tx, RESOURCE, &value.name).await?;
            sqlx::query("INSERT INTO supertag_v2_workspace_credentials (name,revision,payload) VALUES ($1,$2,$3) ON CONFLICT(name) DO UPDATE SET revision=excluded.revision,payload=excluded.payload")
                .bind(&value.name).bind(value.revision as i64).bind(value.encode_to_vec()).execute(&mut *tx).await?;
        }
        policy::receipt(&mut tx, principal, &input.operation_id, &digest, &value).await?;
        tx.commit().await?;
        Ok(value)
    }

    pub async fn get_workspace_credential(
        &self,
        principal: &str,
        input: &GetWorkspaceCredentialRequest,
    ) -> Result<WorkspaceCredential> {
        policy::operator(principal)?;
        name("Workspace Credential name", &input.name)?;
        let mut tx = self.pool.begin().await?;
        catalog_in(&mut tx, &input.name)
            .await?
            .ok_or_else(|| StoreError::NotFound("Workspace Credential was not found".into()))
    }

    pub async fn list_workspace_credentials(
        &self,
        principal: &str,
        input: &ListWorkspaceCredentialsRequest,
    ) -> Result<ListWorkspaceCredentialsResponse> {
        policy::operator(principal)?;
        if !input.after_name.is_empty() {
            name("Workspace Credential cursor", &input.after_name)?;
        }
        let limit = if input.limit == 0 {
            50
        } else {
            input.limit.min(100)
        };
        let rows: Vec<Vec<u8>> = sqlx::query_scalar("SELECT payload FROM supertag_v2_workspace_credentials WHERE name>$1 ORDER BY name LIMIT $2")
            .bind(&input.after_name).bind(i64::from(limit) + 1).fetch_all(&self.pool).await?;
        let has_more = rows.len() > limit as usize;
        let credentials = rows
            .into_iter()
            .take(limit as usize)
            .map(|bytes| policy::decode(&bytes))
            .collect::<Result<Vec<WorkspaceCredential>>>()?;
        let next_cursor = if has_more {
            credentials.last().unwrap().name.clone()
        } else {
            String::new()
        };
        Ok(ListWorkspaceCredentialsResponse {
            credentials,
            next_cursor,
        })
    }

    /// Deletes a Workspace Credential no Workspace names.
    pub async fn delete_workspace_credential(
        &self,
        principal: &str,
        input: &DeleteWorkspaceCredentialRequest,
    ) -> Result<DeleteWorkspaceCredentialResponse> {
        policy::operator(principal)?;
        name("operation ID", &input.operation_id)?;
        name("Workspace Credential name", &input.name)?;
        let digest = policy::digest("delete-workspace-credential", input);
        let (mut tx, _) = self.write().await?;
        if let Some(prior) =
            policy::replay(&mut tx, principal, &input.operation_id, &digest).await?
        {
            return Ok(prior);
        }
        let prior = catalog_in(&mut tx, &input.name)
            .await?
            .ok_or_else(|| StoreError::NotFound("Workspace Credential was not found".into()))?;
        if prior.revision != input.expected_revision {
            return Err(StoreError::Conflict(
                "Workspace Credential revision changed".into(),
            ));
        }
        let workspaces: Vec<Vec<u8>> =
            sqlx::query_scalar("SELECT payload FROM supertag_v2_workspaces")
                .fetch_all(&mut *tx)
                .await?;
        for bytes in workspaces {
            let workspace: Workspace = policy::decode(&bytes)?;
            if workspace
                .credentials
                .as_ref()
                .is_some_and(|names| names.read == input.name || names.push == input.name)
            {
                return Err(StoreError::FailedPrecondition(format!(
                    "Workspace {} still names this Workspace Credential",
                    workspace.workspace_id
                )));
            }
        }
        sqlx::query("DELETE FROM supertag_v2_workspace_credentials WHERE name=$1")
            .bind(&input.name)
            .execute(&mut *tx)
            .await?;
        let response = DeleteWorkspaceCredentialResponse {};
        policy::receipt(&mut tx, principal, &input.operation_id, &digest, &response).await?;
        tx.commit().await?;
        Ok(response)
    }
}

impl ControlPlane {
    pub fn workspace_credentials_service(
        &self,
    ) -> workspace_credentials_server::WorkspaceCredentialsServer<Self> {
        workspace_credentials_server::WorkspaceCredentialsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl workspace_credentials_server::WorkspaceCredentials for ControlPlane {
    async fn put(
        &self,
        request: Request<PutWorkspaceCredentialRequest>,
    ) -> std::result::Result<Response<WorkspaceCredential>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .put_workspace_credential(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn get(
        &self,
        request: Request<GetWorkspaceCredentialRequest>,
    ) -> std::result::Result<Response<WorkspaceCredential>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .get_workspace_credential(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn list(
        &self,
        request: Request<ListWorkspaceCredentialsRequest>,
    ) -> std::result::Result<Response<ListWorkspaceCredentialsResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_workspace_credentials(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn delete(
        &self,
        request: Request<DeleteWorkspaceCredentialRequest>,
    ) -> std::result::Result<Response<DeleteWorkspaceCredentialResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .delete_workspace_credential(&principal, request.get_ref())
                .await?,
        ))
    }
}
