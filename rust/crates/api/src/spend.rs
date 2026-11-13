use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};

use crate::Api;

impl Api {
    pub fn spend_service(&self) -> spend_server::SpendServer<Self> {
        spend_server::SpendServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl spend_server::Spend for Api {
    async fn get_spend(
        &self,
        request: Request<GetSpendRequest>,
    ) -> Result<Response<SpendReport>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async {
                spend_client::SpendClient::new(channel)
                    .max_decoding_message_size(MAX_MESSAGE_BYTES)
                    .max_encoding_message_size(MAX_MESSAGE_BYTES)
                    .get_spend(request)
                    .await
            },
        )
        .await
    }
}

impl Api {
    pub fn objective_overview_service(
        &self,
    ) -> objective_overviews_server::ObjectiveOverviewsServer<Self> {
        objective_overviews_server::ObjectiveOverviewsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl objective_overviews_server::ObjectiveOverviews for Api {
    async fn get_objective_overview(
        &self,
        request: Request<GetObjectiveOverviewRequest>,
    ) -> Result<Response<ObjectiveOverview>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async {
                objective_overviews_client::ObjectiveOverviewsClient::new(channel)
                    .max_decoding_message_size(MAX_MESSAGE_BYTES)
                    .max_encoding_message_size(MAX_MESSAGE_BYTES)
                    .get_objective_overview(request)
                    .await
            },
        )
        .await
    }
}
