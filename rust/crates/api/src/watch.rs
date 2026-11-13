//! Forward an authenticated Watch without the unary RPC's stream-wide deadline.
use std::pin::Pin;

use supertag_protocol::v2::*;
use tokio_stream::Stream;
use tokio_util::sync::CancellationToken;
use tonic::{Request, Response, Status};

use crate::{
    Api, MAX_MESSAGE_BYTES, TIMEOUT, client_timeout, operator_access::OPERATOR_RECHECK,
    request_budget,
};

type Updates = Pin<Box<dyn Stream<Item = Result<WatchEvent, Status>> + Send>>;

pub struct ApiWatch {
    api: Api,
    shutdown: CancellationToken,
}

impl Api {
    pub fn operator_events_service(
        &self,
        shutdown: CancellationToken,
    ) -> operator_events_server::OperatorEventsServer<ApiWatch> {
        operator_events_server::OperatorEventsServer::new(ApiWatch {
            api: self.clone(),
            shutdown,
        })
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

fn draining() -> Status {
    Status::unavailable("Control Plane is draining")
}

#[tonic::async_trait]
impl operator_events_server::OperatorEvents for ApiWatch {
    type WatchStream = Updates;

    async fn watch(
        &self,
        request: Request<WatchRequest>,
    ) -> Result<Response<Self::WatchStream>, Status> {
        let credentials = &self.api.credentials;
        let caller = self
            .api
            .operator_caller(&request, &credentials.operator)
            .await?;
        let startup = request_budget(&request)?;
        let timeout = request
            .metadata()
            .contains_key(TIMEOUT)
            .then(|| client_timeout(&request))
            .transpose()?;
        let mut outgoing = credentials.authenticated(request.into_inner(), caller.identity.clone());
        if let Some(timeout) = timeout {
            outgoing.set_timeout(timeout);
        }
        let mut client =
            operator_events_client::OperatorEventsClient::new(self.api.control_plane.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES);
        let shutdown = self.shutdown.clone();
        let api = self.api.clone();
        let mut upstream = tokio::select! {
            _ = shutdown.cancelled() => return Err(draining()),
            response = tokio::time::timeout(startup, client.watch(outgoing)) => response
                .map_err(|_| Status::deadline_exceeded("Control Plane Watch did not open"))??
                .into_inner(),
        };
        let output = async_stream::try_stream! {
            // An Operator Token stream ends within a second of its revocation or rotation.
            let mut recheck = tokio::time::interval(OPERATOR_RECHECK);
            recheck.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            recheck.tick().await;
            loop {
                let read = tokio::select! {
                    biased;
                    _ = shutdown.cancelled() => Err(draining()),
                    _ = recheck.tick() => Ok(None),
                    message = upstream.message() => message.map(Some),
                };
                match read {
                    Ok(None) => api.recheck_operator(&caller).await?,
                    Ok(Some(Some(event))) => yield event,
                    Ok(Some(None)) => break,
                    Err(error) => Err(error)?,
                }
            }
        };
        Ok(Response::new(Box::pin(output)))
    }
}

#[cfg(test)]
#[path = "watch_tests.rs"]
mod tests;
