use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};

use crate::Api;

impl Api {
    pub fn attempt_tag_sessions_service(
        &self,
    ) -> attempt_tag_sessions_server::AttemptTagSessionsServer<Self> {
        attempt_tag_sessions_server::AttemptTagSessionsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl attempt_tag_sessions_server::AttemptTagSessions for Api {
    async fn list_sessions(
        &self,
        request: Request<ListTagSessionsRequest>,
    ) -> Result<Response<ListTagSessionsResponse>, Status> {
        self.forward_host(request, true, |channel, request| async {
            attempt_tag_sessions_client::AttemptTagSessionsClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .list_sessions(request)
                .await
        })
        .await
    }

    async fn search_sessions(
        &self,
        request: Request<SearchTagSessionsRequest>,
    ) -> Result<Response<SearchTagSessionsResponse>, Status> {
        self.forward_host(request, true, |channel, request| async {
            attempt_tag_sessions_client::AttemptTagSessionsClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .search_sessions(request)
                .await
        })
        .await
    }

    async fn read_session(
        &self,
        request: Request<ReadTagSessionRequest>,
    ) -> Result<Response<ReadTagSessionResponse>, Status> {
        self.forward_host(request, true, |channel, request| async {
            attempt_tag_sessions_client::AttemptTagSessionsClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .read_session(request)
                .await
        })
        .await
    }

    async fn list_objectives(
        &self,
        request: Request<ListTagObjectivesRequest>,
    ) -> Result<Response<ListTagObjectivesResponse>, Status> {
        self.forward_host(request, true, |channel, request| async {
            attempt_tag_sessions_client::AttemptTagSessionsClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .list_objectives(request)
                .await
        })
        .await
    }

    async fn read_objective(
        &self,
        request: Request<ReadTagObjectiveRequest>,
    ) -> Result<Response<TagObjectiveView>, Status> {
        self.forward_host(request, true, |channel, request| async {
            attempt_tag_sessions_client::AttemptTagSessionsClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .read_objective(request)
                .await
        })
        .await
    }

    async fn create_objective(
        &self,
        request: Request<CreateTagObjectiveRequest>,
    ) -> Result<Response<CreateTagObjectiveResponse>, Status> {
        self.forward_host(request, true, |channel, request| async {
            attempt_tag_sessions_client::AttemptTagSessionsClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .create_objective(request)
                .await
        })
        .await
    }
}
