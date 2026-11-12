use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};

use crate::Gateway;

impl Gateway {
    pub fn attempt_mcp_effects_service(
        &self,
    ) -> attempt_mcp_effects_server::AttemptMcpEffectsServer<Self> {
        attempt_mcp_effects_server::AttemptMcpEffectsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl attempt_mcp_effects_server::AttemptMcpEffects for Gateway {
    async fn reserve(
        &self,
        request: Request<ReserveMcpEffectRequest>,
    ) -> Result<Response<ReserveMcpEffectResponse>, Status> {
        self.forward_host(request, true, |channel, request| async {
            attempt_mcp_effects_client::AttemptMcpEffectsClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .reserve(request)
                .await
        })
        .await
    }

    async fn settle(
        &self,
        request: Request<SettleMcpEffectRequest>,
    ) -> Result<Response<SettleMcpEffectResponse>, Status> {
        self.forward_host(request, true, |channel, request| async {
            attempt_mcp_effects_client::AttemptMcpEffectsClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .settle(request)
                .await
        })
        .await
    }
}
