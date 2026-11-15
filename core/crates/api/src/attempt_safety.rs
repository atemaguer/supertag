//! Host-facing facades for overlap reports and Worker-managed effect receipts. The Control Plane
//! authorizes each call with the Attempt's execution authority.
use supertag_protocol::{MAX_MESSAGE_BYTES, negotiation::ProtocolChannel, v2::*};
use tonic::{Request, Response, Status};

use crate::Api;

impl Api {
    pub fn attempt_changed_paths_service(
        &self,
    ) -> attempt_changed_paths_server::AttemptChangedPathsServer<Self> {
        attempt_changed_paths_server::AttemptChangedPathsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn attempt_effects_service(&self) -> attempt_effects_server::AttemptEffectsServer<Self> {
        attempt_effects_server::AttemptEffectsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

fn effects(
    channel: ProtocolChannel,
) -> attempt_effects_client::AttemptEffectsClient<ProtocolChannel> {
    attempt_effects_client::AttemptEffectsClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

#[tonic::async_trait]
impl attempt_changed_paths_server::AttemptChangedPaths for Api {
    async fn report(
        &self,
        request: Request<ReportChangedPathsRequest>,
    ) -> Result<Response<ReportChangedPathsResponse>, Status> {
        self.forward_host(request, true, |channel, request| async {
            attempt_changed_paths_client::AttemptChangedPathsClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .report(request)
                .await
        })
        .await
    }
}

#[tonic::async_trait]
impl attempt_effects_server::AttemptEffects for Api {
    async fn begin(
        &self,
        request: Request<BeginEffectRequest>,
    ) -> Result<Response<EffectReceipt>, Status> {
        self.forward_host(request, true, |channel, request| async {
            effects(channel).begin(request).await
        })
        .await
    }

    async fn complete(
        &self,
        request: Request<CompleteEffectRequest>,
    ) -> Result<Response<EffectReceipt>, Status> {
        self.forward_host(request, true, |channel, request| async {
            effects(channel).complete(request).await
        })
        .await
    }

    async fn fail(
        &self,
        request: Request<FailEffectRequest>,
    ) -> Result<Response<EffectReceipt>, Status> {
        self.forward_host(request, true, |channel, request| async {
            effects(channel).fail(request).await
        })
        .await
    }
}
