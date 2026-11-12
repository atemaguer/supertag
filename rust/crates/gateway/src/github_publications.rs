use crate::Gateway;
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};
impl Gateway {
    pub fn github_publications_service(
        &self,
    ) -> github_publications_server::GithubPublicationsServer<Self> {
        github_publications_server::GithubPublicationsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}
#[tonic::async_trait]
impl github_publications_server::GithubPublications for Gateway {
    async fn get(
        &self,
        request: Request<GetGithubPublicationRequest>,
    ) -> Result<Response<GithubPublication>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async {
                github_publications_client::GithubPublicationsClient::new(channel)
                    .get(request)
                    .await
            },
        )
        .await
    }
    async fn list(
        &self,
        request: Request<ListGithubPublicationsRequest>,
    ) -> Result<Response<ListGithubPublicationsResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async {
                github_publications_client::GithubPublicationsClient::new(channel)
                    .list(request)
                    .await
            },
        )
        .await
    }
    async fn cancel(
        &self,
        request: Request<CancelGithubPublicationRequest>,
    ) -> Result<Response<GithubPublication>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async {
                github_publications_client::GithubPublicationsClient::new(channel)
                    .cancel(request)
                    .await
            },
        )
        .await
    }
}
