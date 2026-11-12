use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};

use crate::Gateway;

impl Gateway {
    pub fn work_sessions_service(&self) -> work_sessions_server::WorkSessionsServer<Self> {
        work_sessions_server::WorkSessionsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn attempt_work_sessions_service(
        &self,
    ) -> attempt_work_sessions_server::AttemptWorkSessionsServer<Self> {
        attempt_work_sessions_server::AttemptWorkSessionsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl work_sessions_server::WorkSessions for Gateway {
    async fn get(
        &self,
        request: Request<GetWorkSessionRequest>,
    ) -> Result<Response<WorkSession>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async {
                work_sessions_client::WorkSessionsClient::new(channel)
                    .max_decoding_message_size(MAX_MESSAGE_BYTES)
                    .max_encoding_message_size(MAX_MESSAGE_BYTES)
                    .get(request)
                    .await
            },
        )
        .await
    }

    async fn list(
        &self,
        request: Request<ListWorkSessionsRequest>,
    ) -> Result<Response<ListWorkSessionsResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async {
                work_sessions_client::WorkSessionsClient::new(channel)
                    .max_decoding_message_size(MAX_MESSAGE_BYTES)
                    .max_encoding_message_size(MAX_MESSAGE_BYTES)
                    .list(request)
                    .await
            },
        )
        .await
    }
}

#[tonic::async_trait]
impl attempt_work_sessions_server::AttemptWorkSessions for Gateway {
    async fn start(
        &self,
        request: Request<StartWorkSessionRequest>,
    ) -> Result<Response<WorkSession>, Status> {
        self.forward_host(request, true, |channel, request| async {
            attempt_work_sessions_client::AttemptWorkSessionsClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .start(request)
                .await
        })
        .await
    }
}
