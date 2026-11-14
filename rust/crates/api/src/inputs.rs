use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        attempt_inputs_client::AttemptInputsClient,
        attempt_inputs_server::{AttemptInputs, AttemptInputsServer},
        live_inputs_client::LiveInputsClient,
        live_inputs_server::{LiveInputs, LiveInputsServer},
        *,
    },
};
use tonic::{Request, Response, Status};

use crate::Api;

impl Api {
    pub fn live_inputs_service(&self) -> LiveInputsServer<Self> {
        LiveInputsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn attempt_inputs_service(&self) -> AttemptInputsServer<Self> {
        AttemptInputsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl LiveInputs for Api {
    async fn queue_input(
        &self,
        request: Request<QueueInputRequest>,
    ) -> Result<Response<LiveInput>, Status> {
        self.forward(request, |channel, request| async move {
            live_client(channel).queue_input(request).await
        })
        .await
    }

    async fn get_input(
        &self,
        request: Request<GetInputRequest>,
    ) -> Result<Response<LiveInput>, Status> {
        self.forward(request, |channel, request| async move {
            live_client(channel).get_input(request).await
        })
        .await
    }

    async fn resolve_input(
        &self,
        request: Request<ResolveInputRequest>,
    ) -> Result<Response<LiveInput>, Status> {
        self.forward(request, |channel, request| async move {
            live_client(channel).resolve_input(request).await
        })
        .await
    }
}

#[tonic::async_trait]
impl AttemptInputs for Api {
    async fn take_input(
        &self,
        request: Request<TakeInputRequest>,
    ) -> Result<Response<TakeInputResponse>, Status> {
        self.forward_host(request, true, |channel, request| async move {
            attempt_client(channel).take_input(request).await
        })
        .await
    }

    async fn settle_input(
        &self,
        request: Request<SettleInputRequest>,
    ) -> Result<Response<LiveInput>, Status> {
        self.forward_host(request, true, |channel, request| async move {
            attempt_client(channel).settle_input(request).await
        })
        .await
    }
}

fn live_client(channel: ProtocolChannel) -> LiveInputsClient<ProtocolChannel> {
    LiveInputsClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

fn attempt_client(channel: ProtocolChannel) -> AttemptInputsClient<ProtocolChannel> {
    AttemptInputsClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}
