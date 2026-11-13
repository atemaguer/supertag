//! Worker-managed effect receipts for the harness adapter, recorded by the Control Plane with
//! this Attempt's execution authority. See `effects.proto`.
use std::time::Duration;

use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request,
    v2::{
        BeginEffectRequest, CompleteEffectRequest, EffectReceipt, FailEffectRequest,
        HarnessBeginEffectRequest, HarnessCompleteEffectRequest, HarnessFailEffectRequest,
        harness_effects_server::{HarnessEffects, HarnessEffectsServer},
    },
};
use tonic::{Request, Response, Status};

use super::Bridge;

impl Bridge {
    pub(super) fn effects_service(&self) -> HarnessEffectsServer<Self> {
        HarnessEffectsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl HarnessEffects for Bridge {
    async fn begin(
        &self,
        request: Request<HarnessBeginEffectRequest>,
    ) -> Result<Response<EffectReceipt>, Status> {
        self.authenticate(&request)?;
        self.require_attached()?;
        // Holding the run state orders a new effect before a proposed outcome.
        let state = self.state.lock().await;
        if state.outcome.is_some() {
            return Err(Status::failed_precondition("execution is complete"));
        }
        let mut upstream = authenticated_request(
            BeginEffectRequest {
                attempt: Some(self.attempt()),
                effect: Some(request.into_inner()),
            },
            &self.host_token,
            None,
        )?;
        upstream.set_timeout(Duration::from_secs(5));
        self.coordination.effects.clone().begin(upstream).await
    }

    async fn complete(
        &self,
        request: Request<HarnessCompleteEffectRequest>,
    ) -> Result<Response<EffectReceipt>, Status> {
        self.authenticate(&request)?;
        self.require_attached()?;
        let mut upstream = authenticated_request(
            CompleteEffectRequest {
                attempt: Some(self.attempt()),
                effect: Some(request.into_inner()),
            },
            &self.host_token,
            None,
        )?;
        upstream.set_timeout(Duration::from_secs(5));
        self.coordination.effects.clone().complete(upstream).await
    }

    async fn fail(
        &self,
        request: Request<HarnessFailEffectRequest>,
    ) -> Result<Response<EffectReceipt>, Status> {
        self.authenticate(&request)?;
        self.require_attached()?;
        let mut upstream = authenticated_request(
            FailEffectRequest {
                attempt: Some(self.attempt()),
                effect: Some(request.into_inner()),
            },
            &self.host_token,
            None,
        )?;
        upstream.set_timeout(Duration::from_secs(5));
        self.coordination.effects.clone().fail(upstream).await
    }
}
