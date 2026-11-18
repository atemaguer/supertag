use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};

use crate::Api;

fn client(
    channel: supertag_protocol::negotiation::ProtocolChannel,
) -> host_landings_client::HostLandingsClient<supertag_protocol::negotiation::ProtocolChannel> {
    host_landings_client::HostLandingsClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

impl Api {
    pub fn host_landings_service(&self) -> host_landings_server::HostLandingsServer<Self> {
        host_landings_server::HostLandingsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

/// Forwards a Worker Host's landing calls to the state owner, as the host.
#[tonic::async_trait]
impl host_landings_server::HostLandings for Api {
    async fn claim(
        &self,
        request: Request<ClaimWorkspaceLandingRequest>,
    ) -> Result<Response<ClaimWorkspaceLandingResponse>, Status> {
        self.forward_host(request, true, |channel, request| async {
            client(channel).claim(request).await
        })
        .await
    }

    async fn renew(
        &self,
        request: Request<WorkspaceLandingLease>,
    ) -> Result<Response<ClaimWorkspaceLandingResponse>, Status> {
        self.forward_host(request, true, |channel, request| async {
            client(channel).renew(request).await
        })
        .await
    }

    async fn record(
        &self,
        request: Request<RecordWorkspaceLandingRequest>,
    ) -> Result<Response<WorkspaceLanding>, Status> {
        self.forward_host(request, true, |channel, request| async {
            client(channel).record(request).await
        })
        .await
    }
}
