//! Forwards whole gRPC services from the public listener to the state owner.
//!
//! Gateways call the Connector, reply progress, and operator notification services. The
//! authorization layer admits each call as `gateway:NAME`; this relays its body and metadata to the
//! state owner with the internal credential and that principal in place of the caller's
//! credential. The state owner checks the connector account the call names against the Gateway.

use std::{
    convert::Infallible,
    future::{Future, poll_fn},
    marker::PhantomData,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};

use tonic::{
    body::Body,
    metadata::{Ascii, MetadataValue},
    server::NamedService,
    transport::Channel,
};
use tower_service::Service;

use crate::{AUTHORIZATION, PRINCIPAL, authorize::Caller};

/// Serves the gRPC service named by `S`, a generated server type, by relaying to the state owner.
pub struct Passthrough<S> {
    channel: Channel,
    internal: Arc<MetadataValue<Ascii>>,
    service: PhantomData<fn() -> S>,
}

impl<S> Passthrough<S> {
    pub(crate) fn new(channel: Channel, internal: MetadataValue<Ascii>) -> Self {
        Self {
            channel,
            internal: Arc::new(internal),
            service: PhantomData,
        }
    }
}

impl<S> Clone for Passthrough<S> {
    fn clone(&self) -> Self {
        Self {
            channel: self.channel.clone(),
            internal: self.internal.clone(),
            service: PhantomData,
        }
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

    fn call(&mut self, mut request: http::Request<Body>) -> Self::Future {
        let Some(principal) = request
            .extensions()
            .get::<Caller>()
            .and_then(|caller| caller.principal.parse::<http::HeaderValue>().ok())
        else {
            return Box::pin(async {
                Ok(tonic::Status::unauthenticated("valid bearer credential required").into_http())
            });
        };
        let headers = request.headers_mut();
        headers.remove(AUTHORIZATION);
        headers.insert(
            AUTHORIZATION,
            http::HeaderValue::from_bytes(self.internal.as_encoded_bytes())
                .expect("a valid internal credential"),
        );
        headers.insert(PRINCIPAL, principal);
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
