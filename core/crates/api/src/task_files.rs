use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};

use crate::Api;

impl Api {
    pub fn task_files_service(&self) -> task_files_server::TaskFilesServer<Self> {
        task_files_server::TaskFilesServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn attempt_task_files_service(
        &self,
    ) -> attempt_task_files_server::AttemptTaskFilesServer<Self> {
        attempt_task_files_server::AttemptTaskFilesServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl task_files_server::TaskFiles for Api {
    /// Forwards a client's call to the state owner's TaskFiles service. It returns locations
    /// only; no file content crosses the Control Plane.
    async fn locate(
        &self,
        request: Request<LocateTaskFilesRequest>,
    ) -> Result<Response<TaskFileLocations>, Status> {
        self.forward(request, |channel, request| async {
            task_files_client::TaskFilesClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .locate(request)
                .await
        })
        .await
    }
}

#[tonic::async_trait]
impl attempt_task_files_server::AttemptTaskFiles for Api {
    async fn report_location(
        &self,
        request: Request<ReportTaskFilesLocationRequest>,
    ) -> Result<Response<ReportTaskFilesLocationResponse>, Status> {
        self.forward_attempt(request, |channel, request| async {
            attempt_task_files_client::AttemptTaskFilesClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .report_location(request)
                .await
        })
        .await
    }
}
