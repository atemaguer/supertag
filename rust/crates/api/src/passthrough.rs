//! Forwards whole gRPC services from the public listener to the state owner unchanged.
//!
//! Gateways call the Connector, reply progress, and operator notification services. The API tier
//! admits each call with [`GatewayAccess`] and relays it, with its credentials, to the state owner,
//! which reads the principal it names.

use std::{
    convert::Infallible,
    future::{Future, poll_fn},
    marker::PhantomData,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};

use tonic::{body::Body, server::NamedService, transport::Channel};
use tower_service::Service;

use crate::gateway_access::GatewayAccess;

/// Serves the gRPC service named by `S`, a generated server type, by relaying to the state owner.
pub struct Passthrough<S> {
    channel: Channel,
    access: Arc<GatewayAccess>,
    service: PhantomData<fn() -> S>,
}

impl<S> Passthrough<S> {
    pub(crate) fn new(channel: Channel, access: Arc<GatewayAccess>) -> Self {
        Self {
            channel,
            access,
            service: PhantomData,
        }
    }
}

impl<S> Clone for Passthrough<S> {
    fn clone(&self) -> Self {
        Self::new(self.channel.clone(), self.access.clone())
    }
}

impl<S: NamedService> NamedService for Passthrough<S> {
    const NAME: &'static str = S::NAME;
}

impl<S> Service<http::Request<Body>> for Passthrough<S> {
    type Response = http::Response<Body>;
    type Error = Infallible;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Infallible>> + Send>>;

    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Infallible>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: http::Request<Body>) -> Self::Future {
        if let Err(status) = self
            .access
            .authorize(request.headers(), request.extensions())
        {
            return Box::pin(async move { Ok(status.into_http()) });
        }
        let mut channel = self.channel.clone();
        Box::pin(async move {
            let response = async {
                poll_fn(|context| channel.poll_ready(context)).await?;
                channel.call(request).await
            }
            .await;
            Ok(response.unwrap_or_else(|_| {
                tonic::Status::unavailable("Control Plane state owner is unavailable").into_http()
            }))
        })
    }
}
