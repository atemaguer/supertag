//! The connection between the API tier and the state owner when both run in one process.
//!
//! Each connection is an in-memory byte pipe, so the state owner listens on no network address.
//! A separately deployed API tier would dial the state owner over the network instead; the
//! services on both ends are the same.

use std::{
    future::{Ready, ready},
    io,
    task::{Context, Poll},
};

use hyper_util::rt::TokioIo;
use tokio::{io::DuplexStream, sync::mpsc};
use tokio_stream::{Stream, StreamExt as _, wrappers::UnboundedReceiverStream};
use tonic::transport::{Channel, Endpoint, Uri};
use tower_service::Service;

const BUFFER_BYTES: usize = 1024 * 1024;

/// Opens in-process connections to the server fed by the paired [`Incoming`].
#[derive(Clone)]
pub struct Connector(mpsc::UnboundedSender<DuplexStream>);

/// Server-side ends of in-process connections, for `serve_with_incoming`.
pub type Incoming = std::pin::Pin<Box<dyn Stream<Item = io::Result<DuplexStream>> + Send>>;

/// A connector and the incoming connections it produces.
pub fn pair() -> (Connector, Incoming) {
    let (sender, receiver) = mpsc::unbounded_channel();
    (
        Connector(sender),
        Box::pin(UnboundedReceiverStream::new(receiver).map(Ok)),
    )
}

impl Connector {
    /// A channel whose connections reach the paired server.
    pub fn channel(&self) -> Channel {
        Endpoint::from_static("http://control-plane.internal")
            .connect_with_connector_lazy(self.clone())
    }
}

impl Service<Uri> for Connector {
    type Response = TokioIo<DuplexStream>;
    type Error = io::Error;
    type Future = Ready<io::Result<Self::Response>>;

    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, _: Uri) -> Self::Future {
        let (client, server) = tokio::io::duplex(BUFFER_BYTES);
        ready(
            self.0
                .send(server)
                .map(|()| TokioIo::new(client))
                .map_err(|_| {
                    io::Error::new(io::ErrorKind::ConnectionRefused, "state owner stopped")
                }),
        )
    }
}
