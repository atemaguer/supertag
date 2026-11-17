//! Remote Workspaces, Workspace Credentials, and landings. The state owner keeps the catalog;
//! this tier forwards to it, and checks a Workspace with git delivery, which runs here.
use std::time::Duration;

use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};

use crate::{Api, transfers::ApiTransfers};

/// How long `Check` may spend reading and probing the remote.
const CHECK_TIMEOUT: Duration = Duration::from_secs(60);

impl ApiTransfers {
    pub fn workspaces_service(&self) -> workspaces_server::WorkspacesServer<Self> {
        workspaces_server::WorkspacesServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

impl Api {
    pub fn workspace_credentials_service(
        &self,
    ) -> workspace_credentials_server::WorkspaceCredentialsServer<Self> {
        workspace_credentials_server::WorkspaceCredentialsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn workspace_landings_service(
        &self,
    ) -> workspace_landings_server::WorkspaceLandingsServer<Self> {
        workspace_landings_server::WorkspaceLandingsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl workspaces_server::Workspaces for ApiTransfers {
    async fn put(
        &self,
        request: Request<PutWorkspaceRequest>,
    ) -> Result<Response<Workspace>, Status> {
        self.api()
            .forward(request, |channel, request| async {
                workspaces_client::WorkspacesClient::new(channel)
                    .put(request)
                    .await
            })
            .await
    }
    async fn get(
        &self,
        request: Request<GetWorkspaceRequest>,
    ) -> Result<Response<Workspace>, Status> {
        self.api()
            .forward(request, |channel, request| async {
                workspaces_client::WorkspacesClient::new(channel)
                    .get(request)
                    .await
            })
            .await
    }
    async fn list(
        &self,
        request: Request<ListWorkspacesRequest>,
    ) -> Result<Response<ListWorkspacesResponse>, Status> {
        self.api()
            .forward(request, |channel, request| async {
                workspaces_client::WorkspacesClient::new(channel)
                    .list(request)
                    .await
            })
            .await
    }
    async fn delete(
        &self,
        request: Request<DeleteWorkspaceRequest>,
    ) -> Result<Response<DeleteWorkspaceResponse>, Status> {
        self.api()
            .forward(request, |channel, request| async {
                workspaces_client::WorkspacesClient::new(channel)
                    .delete(request)
                    .await
            })
            .await
    }
    async fn check(
        &self,
        request: Request<CheckWorkspaceRequest>,
    ) -> Result<Response<WorkspaceCheck>, Status> {
        let (metadata, extensions, input) = request.into_parts();
        // The caller must be allowed to read the Workspace before git delivery touches it.
        let workspace = self
            .api()
            .forward(
                Request::from_parts(
                    metadata,
                    extensions,
                    GetWorkspaceRequest {
                        workspace_id: input.workspace_id,
                    },
                ),
                |channel, request| async {
                    workspaces_client::WorkspacesClient::new(channel)
                        .get(request)
                        .await
                },
            )
            .await?
            .into_inner();
        let git = self.workspace_git().ok_or_else(|| {
            Status::failed_precondition("git delivery does not run on this Control Plane")
        })?;
        let cancel = tokio_util::sync::CancellationToken::new();
        let _cancel_on_drop = cancel.clone().drop_guard();
        let check = tokio::time::timeout(CHECK_TIMEOUT, git.check(&workspace, &cancel))
            .await
            .map_err(|_| Status::deadline_exceeded("Workspace check timed out"))?
            .map_err(|error| Status::unavailable(format!("{error:#}")))?;
        Ok(Response::new(check))
    }
}

#[tonic::async_trait]
impl workspace_credentials_server::WorkspaceCredentials for Api {
    async fn put(
        &self,
        request: Request<PutWorkspaceCredentialRequest>,
    ) -> Result<Response<WorkspaceCredential>, Status> {
        self.forward(request, |channel, request| async {
            workspace_credentials_client::WorkspaceCredentialsClient::new(channel)
                .put(request)
                .await
        })
        .await
    }
    async fn get(
        &self,
        request: Request<GetWorkspaceCredentialRequest>,
    ) -> Result<Response<WorkspaceCredential>, Status> {
        self.forward(request, |channel, request| async {
            workspace_credentials_client::WorkspaceCredentialsClient::new(channel)
                .get(request)
                .await
        })
        .await
    }
    async fn list(
        &self,
        request: Request<ListWorkspaceCredentialsRequest>,
    ) -> Result<Response<ListWorkspaceCredentialsResponse>, Status> {
        self.forward(request, |channel, request| async {
            workspace_credentials_client::WorkspaceCredentialsClient::new(channel)
                .list(request)
                .await
        })
        .await
    }
    async fn delete(
        &self,
        request: Request<DeleteWorkspaceCredentialRequest>,
    ) -> Result<Response<DeleteWorkspaceCredentialResponse>, Status> {
        self.forward(request, |channel, request| async {
            workspace_credentials_client::WorkspaceCredentialsClient::new(channel)
                .delete(request)
                .await
        })
        .await
    }
}

#[tonic::async_trait]
impl workspace_landings_server::WorkspaceLandings for Api {
    async fn get(
        &self,
        request: Request<GetWorkspaceLandingRequest>,
    ) -> Result<Response<WorkspaceLanding>, Status> {
        self.forward(request, |channel, request| async {
            workspace_landings_client::WorkspaceLandingsClient::new(channel)
                .get(request)
                .await
        })
        .await
    }
    async fn list(
        &self,
        request: Request<ListWorkspaceLandingsRequest>,
    ) -> Result<Response<ListWorkspaceLandingsResponse>, Status> {
        self.forward(request, |channel, request| async {
            workspace_landings_client::WorkspaceLandingsClient::new(channel)
                .list(request)
                .await
        })
        .await
    }
    async fn return_conflict(
        &self,
        request: Request<ReturnLandingConflictRequest>,
    ) -> Result<Response<Task>, Status> {
        self.forward(request, |channel, request| async {
            workspace_landings_client::WorkspaceLandingsClient::new(channel)
                .return_conflict(request)
                .await
        })
        .await
    }
}
