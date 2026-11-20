//! The client API a Gateway serves: every operator and client call, client enrollment, and a
//! running Task Attempt's data calls, forwarded to the Control Plane.
//!
//! Clients (the desktop app, the CLI and the SDKs) connect to a Gateway, and a
//! Worker may send its Task Attempt's data calls through one with its Attempt credential. The
//! Gateway authorizes nothing itself and adds no authority: it passes the caller's own bearer
//! credential through unchanged, and the Control Plane resolves it and checks the method against
//! its one authorization table on every call, exactly as for a direct call. No header naming a
//! principal crosses the hop, and the forwarder never holds this Gateway's own credential, so a
//! client call can neither claim another principal nor borrow the Gateway's `gateway` role.
//!
//! Only methods that an operator, a client, an Auth Key or an Attempt credential may call are
//! forwarded ([`supertag_protocol::authorization::gateway_forwards`]); Worker Host registration,
//! claim, lease and transfer methods, and Gateway, internal and peer-local methods, fall through
//! to this Gateway's own router, which does not serve them. A Worker Host's host credential
//! therefore never crosses a Gateway, and no host generation header does either.
//! Request metadata is rebuilt from an allowlist, and streams and downloads are relayed as they
//! arrive, with no deadline added and nothing written to disk. When the Gateway shuts down, a
//! relayed stream still open, such as a client's Watch, ends with UNAVAILABLE, so the client
//! reconnects and the Gateway's graceful shutdown does not wait on it.

use std::{
    future::{Future, poll_fn},
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context, Poll},
};

use bytes::Bytes;
use http::{HeaderMap, HeaderName, HeaderValue, header};
use http_body_util::{BodyExt, Full, Limited};
use prost::Message;
use supertag_protocol::{
    authorization::{HEALTH_PATH, NEGOTIATION_PATH, gateway_forwards},
    negotiation::ProtocolChannel,
    v2::{EnrollRequest, PrincipalRole},
};
use tokio_util::sync::{CancellationToken, WaitForCancellationFutureOwned};
use tonic::{Status, body::Body};
use tower_layer::Layer;
use tower_service::Service;

const ENROLL_PATH: &str = "/supertag.runtime.v2.Enrollments/Enroll";
/// The most an enrollment request may hold; it is a name, an operation ID and a digest.
const MAX_ENROLL_BYTES: usize = 16 * 1024;
/// The longest bearer value accepted, as on the Control Plane.
const MAX_BEARER_BYTES: usize = 512;
/// Request headers copied to the Control Plane. Everything else a caller sends is dropped,
/// including the Control Plane's internal principal, host generation and connector account
/// headers. The protocol version is set by the channel this Gateway negotiated.
const FORWARDED_HEADERS: [HeaderName; 5] = [
    header::CONTENT_TYPE,
    header::TE,
    HeaderName::from_static("grpc-timeout"),
    HeaderName::from_static("grpc-encoding"),
    HeaderName::from_static("grpc-accept-encoding"),
];

/// Forwards client calls over a small pool of connections to the Control Plane, so one
/// connection's concurrent stream limit cannot cap how many clients follow conversations.
#[derive(Clone)]
pub struct ClientApi {
    channels: Arc<[ProtocolChannel]>,
    next: Arc<AtomicUsize>,
    every_call: bool,
    /// Ends every relayed response when cancelled.
    stopping: CancellationToken,
}

impl ClientApi {
    /// `channels` reach the Control Plane, each negotiated by this Gateway. They must not attach
    /// this Gateway's credential: each forwarded call carries only its caller's.
    pub fn new(channels: Vec<ProtocolChannel>) -> Self {
        assert!(!channels.is_empty(), "a Control Plane channel is required");
        Self {
            channels: channels.into(),
            next: Arc::new(AtomicUsize::new(0)),
            every_call: false,
            stopping: CancellationToken::new(),
        }
    }

    /// Ends the calls still relayed when `shutdown` is cancelled, with UNAVAILABLE, so a client's
    /// open stream cannot hold this Gateway's graceful shutdown past its deadline.
    pub fn ending_calls_on(mut self, shutdown: CancellationToken) -> Self {
        self.stopping = shutdown;
        self
    }

    /// Only for tests that prove the Control Plane, not this allowlist, refuses a call: forwards
    /// every runtime method, including ones a Gateway never serves to clients.
    #[doc(hidden)]
    pub fn forwarding_every_call(mut self) -> Self {
        self.every_call = true;
        self
    }

    fn forwards(&self, path: &str) -> bool {
        if path.starts_with(NEGOTIATION_PATH) || path.starts_with(HEALTH_PATH) {
            return false;
        }
        gateway_forwards(path)
            || (self.every_call && path.starts_with(supertag_protocol::authorization::PACKAGE))
    }

    fn channel(&self) -> ProtocolChannel {
        let index = self.next.fetch_add(1, Ordering::Relaxed) % self.channels.len();
        self.channels[index].clone()
    }
}

impl<S> Layer<S> for ClientApi {
    type Service = ClientApiService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        ClientApiService {
            inner,
            api: self.clone(),
        }
    }
}

/// This Gateway's own services, behind the client forwarder.
#[derive(Clone)]
pub struct ClientApiService<S> {
    inner: S,
    api: ClientApi,
}

type BoxFuture<R, E> = Pin<Box<dyn Future<Output = Result<R, E>> + Send>>;

impl<S> Service<http::Request<Body>> for ClientApiService<S>
where
    S: Service<http::Request<Body>, Response = http::Response<Body>> + Clone + Send + 'static,
    S::Future: Send + 'static,
    S::Error: Send + 'static,
{
    type Response = http::Response<Body>;
    type Error = S::Error;
    type Future = BoxFuture<Self::Response, S::Error>;

    fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(context)
    }

    fn call(&mut self, request: http::Request<Body>) -> Self::Future {
        if !self.api.forwards(request.uri().path()) {
            let clone = self.inner.clone();
            let mut inner = std::mem::replace(&mut self.inner, clone);
            return Box::pin(async move { inner.call(request).await });
        }
        let channel = self.api.channel();
        let stopping = self.api.stopping.clone();
        Box::pin(async move {
            let response = forward(channel, request).await;
            Ok(response.map(|body| Body::new(UntilShutdown::new(body, stopping))))
        })
    }
}

/// A relayed response body that ends with UNAVAILABLE once the Gateway shuts down.
struct UntilShutdown {
    inner: Body,
    stopping: Pin<Box<WaitForCancellationFutureOwned>>,
    ended: bool,
}

impl UntilShutdown {
    fn new(inner: Body, stopping: CancellationToken) -> Self {
        Self {
            inner,
            stopping: Box::pin(stopping.cancelled_owned()),
            ended: false,
        }
    }
}

impl http_body::Body for UntilShutdown {
    type Data = Bytes;
    type Error = Status;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Bytes>, Status>>> {
        let this = &mut *self;
        if this.ended {
            return Poll::Ready(None);
        }
        // What the Control Plane already sent goes first, its own end included.
        if let Poll::Ready(frame) = Pin::new(&mut this.inner).poll_frame(context) {
            this.ended = frame.is_none();
            return Poll::Ready(frame);
        }
        if this.stopping.as_mut().poll(context).is_ready() {
            this.ended = true;
            let mut trailers = HeaderMap::new();
            trailers.insert(
                "grpc-status",
                HeaderValue::from(tonic::Code::Unavailable as i32),
            );
            trailers.insert(
                "grpc-message",
                HeaderValue::from_static("this%20Gateway%20is%20shutting%20down"),
            );
            return Poll::Ready(Some(Ok(http_body::Frame::trailers(trailers))));
        }
        Poll::Pending
    }

    fn is_end_stream(&self) -> bool {
        self.ended || self.inner.is_end_stream()
    }

    fn size_hint(&self) -> http_body::SizeHint {
        if self.ended {
            http_body::SizeHint::with_exact(0)
        } else {
            self.inner.size_hint()
        }
    }
}

/// Relays one call to the Control Plane as its caller, or answers why it cannot.
async fn forward(
    mut channel: ProtocolChannel,
    request: http::Request<Body>,
) -> http::Response<Body> {
    let (parts, body) = request.into_parts();
    let headers = match upstream_headers(&parts.headers) {
        Ok(headers) => headers,
        Err(status) => return status.into_http(),
    };
    let body = if parts.uri.path() == ENROLL_PATH {
        match client_enrollment(body).await {
            Ok(bytes) => Body::new(Full::new(bytes)),
            Err(status) => return status.into_http(),
        }
    } else {
        body
    };
    let mut upstream = http::Request::new(body);
    *upstream.method_mut() = parts.method;
    *upstream.uri_mut() = parts.uri;
    *upstream.version_mut() = parts.version;
    *upstream.headers_mut() = headers;
    let response = async {
        poll_fn(|context| channel.poll_ready(context)).await?;
        channel.call(upstream).await
    }
    .await;
    match response {
        Ok(response) => response.map(Body::new),
        Err(_) => Status::unavailable("this Gateway can't reach its Control Plane").into_http(),
    }
}

/// The metadata a forwarded call carries: the caller's single bearer credential, unchanged, and
/// the allowlisted call headers.
fn upstream_headers(incoming: &HeaderMap) -> Result<HeaderMap, Status> {
    let unauthenticated = || Status::unauthenticated("valid bearer credential required");
    let mut values = incoming.get_all(header::AUTHORIZATION).iter();
    let bearer = values.next().ok_or_else(unauthenticated)?;
    if values.next().is_some() {
        return Err(unauthenticated());
    }
    let valid = bearer
        .to_str()
        .ok()
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|secret| !secret.is_empty() && secret.len() <= MAX_BEARER_BYTES);
    if !valid {
        return Err(unauthenticated());
    }
    let mut headers = HeaderMap::new();
    let mut bearer = bearer.clone();
    bearer.set_sensitive(true);
    headers.insert(header::AUTHORIZATION, bearer);
    for name in FORWARDED_HEADERS {
        let mut values = incoming.get_all(&name).iter();
        if let Some(value) = values.next() {
            if values.next().is_some() {
                return Err(Status::invalid_argument(format!("repeated {name} header")));
            }
            headers.insert(name, value.clone());
        }
    }
    if !headers.contains_key(header::CONTENT_TYPE) {
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/grpc"),
        );
    }
    Ok(headers)
}

/// Reads an enrollment request and admits only a client's: Worker Hosts and Gateways enroll with
/// the Control Plane itself.
async fn client_enrollment(body: Body) -> Result<Bytes, Status> {
    let bytes = Limited::new(body, MAX_ENROLL_BYTES)
        .collect()
        .await
        .map_err(|_| Status::invalid_argument("enrollment request is too large"))?
        .to_bytes();
    let message = single_frame(&bytes)?;
    let request = EnrollRequest::decode(message)
        .map_err(|_| Status::invalid_argument("invalid enrollment request"))?;
    if request.role != PrincipalRole::Client as i32 {
        return Err(Status::permission_denied(
            "a Gateway enrolls clients only; enroll Worker Hosts and Gateways with the Control Plane",
        ));
    }
    Ok(bytes)
}

/// The message of a body holding exactly one uncompressed gRPC frame.
fn single_frame(bytes: &[u8]) -> Result<&[u8], Status> {
    let invalid = || Status::invalid_argument("invalid enrollment request");
    let (prefix, rest) = bytes.split_at_checked(5).ok_or_else(invalid)?;
    if prefix[0] != 0 {
        return Err(Status::invalid_argument(
            "a compressed enrollment request is not accepted",
        ));
    }
    let length = u32::from_be_bytes([prefix[1], prefix[2], prefix[3], prefix[4]]) as usize;
    if rest.len() != length {
        return Err(invalid());
    }
    Ok(rest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(
                HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    }

    #[test]
    fn forwarded_metadata_keeps_only_the_callers_bearer_and_call_headers() {
        let forwarded = upstream_headers(&headers(&[
            ("authorization", "Bearer stcr_client"),
            ("content-type", "application/grpc"),
            ("te", "trailers"),
            ("grpc-timeout", "5S"),
            ("x-supertag-internal-principal", "operator:local"),
            ("x-supertag-host-generation", "7"),
            ("x-supertag-connector-account", "slack:T1"),
            ("x-supertag-protocol", "99"),
            ("cookie", "session"),
        ]))
        .unwrap();
        let mut names: Vec<_> = forwarded.keys().map(HeaderName::as_str).collect();
        names.sort_unstable();
        assert_eq!(
            names,
            ["authorization", "content-type", "grpc-timeout", "te"]
        );
        assert_eq!(forwarded["authorization"], "Bearer stcr_client");
        assert!(forwarded["authorization"].is_sensitive());
    }

    #[test]
    fn a_call_needs_exactly_one_bearer() {
        for pairs in [
            vec![],
            vec![("authorization", "Basic abc")],
            vec![("authorization", "Bearer ")],
            vec![("authorization", "Bearer a"), ("authorization", "Bearer b")],
        ] {
            let status = upstream_headers(&headers(&pairs)).unwrap_err();
            assert_eq!(status.code(), tonic::Code::Unauthenticated, "{pairs:?}");
        }
        let long = format!("Bearer {}", "a".repeat(MAX_BEARER_BYTES + 1));
        let status = upstream_headers(&headers(&[("authorization", &long)])).unwrap_err();
        assert_eq!(status.code(), tonic::Code::Unauthenticated);
    }

    fn frame(message: &impl Message) -> Bytes {
        let body = message.encode_to_vec();
        let mut bytes = vec![0];
        bytes.extend_from_slice(&(body.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&body);
        bytes.into()
    }

    #[tokio::test]
    async fn only_client_enrollment_is_forwarded() {
        let enroll = |role: PrincipalRole| EnrollRequest {
            role: role as i32,
            name: "laptop".into(),
            operation_id: "op".into(),
            token_digest: vec![1; 32],
        };
        let client = frame(&enroll(PrincipalRole::Client));
        assert_eq!(
            client_enrollment(Body::new(Full::new(client.clone())))
                .await
                .unwrap(),
            client
        );
        for role in [
            PrincipalRole::Host,
            PrincipalRole::Gateway,
            PrincipalRole::Operator,
            PrincipalRole::Unspecified,
        ] {
            let status = client_enrollment(Body::new(Full::new(frame(&enroll(role)))))
                .await
                .unwrap_err();
            assert_eq!(status.code(), tonic::Code::PermissionDenied, "{role:?}");
        }
        let mut compressed = client.to_vec();
        compressed[0] = 1;
        assert!(
            client_enrollment(Body::new(Full::new(Bytes::from(compressed))))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn negotiation_health_and_host_and_gateway_methods_stay_with_the_gateway() {
        let channel = tonic::transport::Endpoint::from_static("http://127.0.0.1:1").connect_lazy();
        let api = ClientApi::new(vec![supertag_protocol::negotiation::bind_current(channel)]);
        let path = |rpc: &str| format!("/supertag.runtime.v2.{rpc}");
        assert!(api.forwards(&path("Conversations/ListConversations")));
        assert!(api.forwards(&path("Operator/PutTag")));
        assert!(api.forwards(ENROLL_PATH));
        assert!(api.forwards(&path("WorkerHost/AppendEvent")));
        assert!(api.forwards(&path("AttemptMailbox/ReadMailbox")));
        assert!(!api.forwards(&path("ProtocolNegotiation/Negotiate")));
        assert!(!api.forwards("/grpc.health.v1.Health/Check"));
        assert!(!api.forwards(&path("WorkerHost/ClaimTask")));
        assert!(!api.forwards(&path("WorkerHost/StartTask")));
        assert!(!api.forwards(&path("WorkerHost/FinishTask")));
        assert!(!api.forwards(&path("Connector/ClaimConnector")));
        assert!(!api.forwards(&path("OperatorNotificationTest/SendTestNotification")));
        let every = api.forwarding_every_call();
        assert!(every.forwards(&path("Connector/ClaimConnector")));
        assert!(!every.forwards(&path("ProtocolNegotiation/Negotiate")));
    }

    #[tokio::test]
    async fn a_relayed_stream_ends_unavailable_when_the_gateway_shuts_down() {
        // A Watch the Control Plane keeps open: one message, then nothing until it is dropped.
        let (sender, receiver) =
            tokio::sync::mpsc::channel::<Result<http_body::Frame<Bytes>, Status>>(1);
        let stream =
            http_body_util::StreamBody::new(tokio_stream::wrappers::ReceiverStream::new(receiver));
        sender
            .send(Ok(http_body::Frame::data(Bytes::from_static(b"event"))))
            .await
            .unwrap();
        let shutdown = CancellationToken::new();
        let mut body = UntilShutdown::new(Body::new(stream), shutdown.clone());
        let first = body.frame().await.unwrap().unwrap();
        assert_eq!(first.into_data().unwrap(), Bytes::from_static(b"event"));
        let pending =
            tokio::time::timeout(std::time::Duration::from_millis(50), body.frame()).await;
        assert!(pending.is_err(), "the open stream ended before shutdown");
        shutdown.cancel();
        let trailers = body
            .frame()
            .await
            .unwrap()
            .unwrap()
            .into_trailers()
            .unwrap();
        assert_eq!(trailers["grpc-status"], "14");
        assert!(body.frame().await.is_none());
        assert!(http_body::Body::is_end_stream(&body));
        drop(sender);

        // A call the Control Plane already finished keeps its own end, even after shutdown.
        let mut finished =
            UntilShutdown::new(Body::new(Full::new(Bytes::from_static(b"reply"))), shutdown);
        let reply = finished.frame().await.unwrap().unwrap();
        assert_eq!(reply.into_data().unwrap(), Bytes::from_static(b"reply"));
        assert!(finished.frame().await.is_none());
    }
}
