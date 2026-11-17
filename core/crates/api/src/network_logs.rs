use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};

use crate::Api;

impl Api {
    pub fn network_logs_service(&self) -> network_logs_server::NetworkLogsServer<Self> {
        network_logs_server::NetworkLogsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl network_logs_server::NetworkLogs for Api {
    /// Forwards an operator's call to the state owner's NetworkLogs service.
    async fn list(
        &self,
        request: Request<ListNetworkLogsRequest>,
    ) -> Result<Response<ListNetworkLogsResponse>, Status> {
        self.forward(request, |channel, request| async {
            network_logs_client::NetworkLogsClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .list(request)
                .await
        })
        .await
    }
}
