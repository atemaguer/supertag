//! Forward an authenticated Watch, and other server streams, without the unary RPC's
//! stream-wide deadline.
use std::pin::Pin;

use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::v2::*;
use tokio_stream::Stream;
use tokio_util::sync::CancellationToken;
use tonic::{Request, Response, Status, codec::Streaming};

use crate::{Api, MAX_MESSAGE_BYTES, TIMEOUT, client_timeout, request_budget};

/// How often an open stream rechecks its caller's credential.
const RECHECK: std::time::Duration = std::time::Duration::from_secs(1);

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
        relay(
            &self.api,
            &self.shutdown,
            request,
            |channel, request| async move {
                operator_events_client::OperatorEventsClient::new(channel)
                    .max_decoding_message_size(MAX_MESSAGE_BYTES)
                    .max_encoding_message_size(MAX_MESSAGE_BYTES)
                    .watch(request)
                    .await
            },
        )
        .await
    }
}

/// Opens a server stream on the Control Plane for an authenticated caller and relays it, ending
/// it when `shutdown` is cancelled or within a second of the caller's credential being revoked or
/// rotated. The stream has no deadline unless the caller set one.
pub(crate) async fn relay<T, R, F>(
    api: &Api,
    shutdown: &CancellationToken,
    request: Request<T>,
    open: impl FnOnce(ProtocolChannel, Request<T>) -> F,
) -> Result<Response<Pin<Box<dyn Stream<Item = Result<R, Status>> + Send>>>, Status>
where
    F: Future<Output = Result<Response<Streaming<R>>, Status>>,
    R: Send + 'static,
{
    let caller = api.caller(&request).await?;
    let startup = request_budget(&request)?;
    let timeout = request
        .metadata()
        .contains_key(TIMEOUT)
        .then(|| client_timeout(&request))
        .transpose()?;
    let mut outgoing = api
        .credentials
        .upstream(request.into_inner(), caller.identity()?, startup);
    outgoing.metadata_mut().remove(TIMEOUT);
    if let Some(timeout) = timeout {
        outgoing.set_timeout(timeout);
    }
    let shutdown = shutdown.clone();
    let api = api.clone();
    let mut upstream = tokio::select! {
        _ = shutdown.cancelled() => return Err(draining()),
        response = tokio::time::timeout(startup, open(api.control_plane.clone(), outgoing)) => response
            .map_err(|_| Status::deadline_exceeded("Control Plane stream did not open"))??
            .into_inner(),
    };
    let output = async_stream::try_stream! {
        let mut recheck = tokio::time::interval(RECHECK);
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
                Ok(None) => api.recheck(&caller).await?,
                Ok(Some(Some(event))) => yield event,
                Ok(Some(None)) => break,
                Err(error) => Err(error)?,
            }
        }
    };
    Ok(Response::new(Box::pin(output)))
}

#[cfg(test)]
#[path = "watch_tests.rs"]
mod tests;
