use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};

use crate::Api;

impl Api {
    pub fn metrics_service(&self) -> metrics_server::MetricsServer<Self> {
        metrics_server::MetricsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl metrics_server::Metrics for Api {
    async fn get_metrics(
        &self,
        request: Request<GetMetricsRequest>,
    ) -> Result<Response<MetricSnapshot>, Status> {
        self.forward(request, |channel, request| async {
            metrics_client::MetricsClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .get_metrics(request)
                .await
        })
        .await
    }
}
