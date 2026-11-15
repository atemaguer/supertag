use crate::Api;
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};

impl Api {
    pub fn github_workspaces_service(
        &self,
    ) -> github_workspaces_server::GithubWorkspacesServer<Self> {
        github_workspaces_server::GithubWorkspacesServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl github_workspaces_server::GithubWorkspaces for Api {
    async fn put(
        &self,
        request: Request<PutGithubWorkspaceRequest>,
    ) -> Result<Response<GithubWorkspace>, Status> {
        self.forward(request, |channel, request| async {
            github_workspaces_client::GithubWorkspacesClient::new(channel)
                .put(request)
                .await
        })
        .await
    }
    async fn get(
        &self,
        request: Request<GetGithubWorkspaceRequest>,
    ) -> Result<Response<GithubWorkspace>, Status> {
        self.forward(request, |channel, request| async {
            github_workspaces_client::GithubWorkspacesClient::new(channel)
                .get(request)
                .await
        })
        .await
    }
    async fn list(
        &self,
        request: Request<ListGithubWorkspacesRequest>,
    ) -> Result<Response<ListGithubWorkspacesResponse>, Status> {
        self.forward(request, |channel, request| async {
            github_workspaces_client::GithubWorkspacesClient::new(channel)
                .list(request)
                .await
        })
        .await
    }
    async fn delete(
        &self,
        request: Request<DeleteGithubWorkspaceRequest>,
    ) -> Result<Response<DeleteGithubWorkspaceResponse>, Status> {
        self.forward(request, |channel, request| async {
            github_workspaces_client::GithubWorkspacesClient::new(channel)
                .delete(request)
                .await
        })
        .await
    }
}
