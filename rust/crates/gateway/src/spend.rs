use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};

use crate::Gateway;

impl Gateway {
    pub fn spend_service(&self) -> spend_server::SpendServer<Self> {
        spend_server::SpendServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl spend_server::Spend for Gateway {
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
