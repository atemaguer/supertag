//! Explicit protocol version negotiation between SuperTag services.
//!
//! The Rust release is an incompatible protocol epoch (design §4): there is no
//! translation for older peers. Every service and operator connection
//! negotiates before it registers, claims, forwards work, or makes an operator
//! call, and both sides refuse a peer that shares no version or connects in the
//! wrong role.
//!
//! A negotiated client names its selected version in [`PROTOCOL_HEADER`] on
//! every later call. [`fence`] refuses a call without it, so a peer that skipped
//! negotiation cannot reach any service other than negotiation and health.
use std::{
    task::{Context, Poll},
    time::Duration,
};

use tonic::{
    Code, Request, Response, Status,
    metadata::{Ascii, MetadataValue},
    service::{Interceptor, interceptor::InterceptedService},
    transport::Channel,
};
use tower_layer::Layer;
use tower_service::Service;

use crate::v2::{
    NegotiateProtocolRequest, NegotiateProtocolResponse, ServiceRole,
    protocol_negotiation_client::ProtocolNegotiationClient,
    protocol_negotiation_server::{ProtocolNegotiation, ProtocolNegotiationServer},
};

/// The protocol versions this build speaks, oldest first.
pub const PROTOCOL_VERSIONS: &[u32] = &[2];
const NEGOTIATION_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_OFFERED_VERSIONS: usize = 32;
const MAX_BUILD_VERSION_BYTES: usize = 64;

pub fn build_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

pub fn role_name(role: ServiceRole) -> &'static str {
    match role {
        ServiceRole::ControlPlane => "Control Plane",
        ServiceRole::Gateway => "Gateway",
        ServiceRole::WorkerHost => "Worker Host",
        ServiceRole::Client => "operator client",
        ServiceRole::Unspecified => "unidentified service",
    }
}

fn versions(list: &[u32]) -> String {
    let items = list.iter().map(u32::to_string).collect::<Vec<_>>();
    format!("[{}]", items.join(", "))
}

fn printable(build: &str) -> String {
    let build: String = build
        .chars()
        .filter(|c| c.is_ascii_graphic())
        .take(MAX_BUILD_VERSION_BYTES)
        .collect();
    if build.is_empty() {
        "unknown".into()
    } else {
        build
    }
}

/// The highest version both lists contain.
pub fn select_version(local: &[u32], offered: &[u32]) -> Option<u32> {
    local
        .iter()
        .copied()
        .filter(|version| offered.contains(version))
        .max()
}

/// Serves `Negotiate` for one service role. `accepts` names the roles that may
/// connect to this service directly.
#[derive(Clone)]
pub struct Negotiator {
    role: ServiceRole,
    accepts: &'static [ServiceRole],
    versions: &'static [u32],
}

impl Negotiator {
    pub fn new(role: ServiceRole, accepts: &'static [ServiceRole]) -> Self {
        Self {
            role,
            accepts,
            versions: PROTOCOL_VERSIONS,
        }
    }

    /// Only for tests that need a peer from another protocol epoch.
    #[doc(hidden)]
    pub fn with_versions(mut self, versions: &'static [u32]) -> Self {
        self.versions = versions;
        self
    }

    pub fn service(self) -> ProtocolNegotiationServer<Self> {
        ProtocolNegotiationServer::new(self)
            .max_decoding_message_size(4096)
            .max_encoding_message_size(4096)
    }

    pub fn answer(
        &self,
        request: &NegotiateProtocolRequest,
    ) -> Result<NegotiateProtocolResponse, Status> {
        let local = role_name(self.role);
        let peer_role = ServiceRole::try_from(request.role).unwrap_or(ServiceRole::Unspecified);
        let peer = role_name(peer_role);
        let build = printable(&request.build_version);
        if request.protocol_versions.len() > MAX_OFFERED_VERSIONS {
            return Err(Status::invalid_argument(
                "too many offered SuperTag protocol versions",
            ));
        }
        if !self.accepts.contains(&peer_role) {
            return Err(Status::permission_denied(format!(
                "a {peer} cannot connect directly to the SuperTag {local}"
            )));
        }
        let Some(selected) = select_version(self.versions, &request.protocol_versions) else {
            return Err(Status::failed_precondition(format!(
                "incompatible SuperTag protocol: this {local} (SuperTag {}) speaks protocol versions {}, but the connecting {peer} (SuperTag {build}) offered {}; run the same SuperTag release on both services",
                build_version(),
                versions(self.versions),
                versions(&request.protocol_versions),
            )));
        };
        Ok(NegotiateProtocolResponse {
            role: self.role as i32,
            protocol_version: selected,
            protocol_versions: self.versions.to_vec(),
            build_version: build_version().into(),
        })
    }
}

#[tonic::async_trait]
impl ProtocolNegotiation for Negotiator {
    async fn negotiate(
        &self,
        request: Request<NegotiateProtocolRequest>,
    ) -> Result<Response<NegotiateProtocolResponse>, Status> {
        self.answer(request.get_ref()).map(Response::new)
    }
}

/// Why a client could not establish a compatible session with its peer.
#[derive(Debug)]
pub enum NegotiationError {
    /// The peer was unreachable or timed out; the caller may retry.
    Unavailable(Status),
    /// The peer is not a compatible SuperTag service. Retrying cannot help.
    Incompatible(String),
}

impl std::fmt::Display for NegotiationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(status) => write!(
                f,
                "SuperTag protocol negotiation could not reach its peer: {}",
                status.message()
            ),
            Self::Incompatible(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for NegotiationError {}

/// Negotiates as `role` with a peer that must answer as `expected`.
pub async fn negotiate(
    channel: Channel,
    role: ServiceRole,
    expected: ServiceRole,
) -> Result<u32, NegotiationError> {
    negotiate_versions(channel, role, expected, PROTOCOL_VERSIONS).await
}

#[doc(hidden)]
pub async fn negotiate_versions(
    channel: Channel,
    role: ServiceRole,
    expected: ServiceRole,
    local: &[u32],
) -> Result<u32, NegotiationError> {
    let local_name = role_name(role);
    let expected_name = role_name(expected);
    let mut request = Request::new(NegotiateProtocolRequest {
        role: role as i32,
        protocol_versions: local.to_vec(),
        build_version: build_version().into(),
    });
    request.set_timeout(NEGOTIATION_TIMEOUT);
    let response = ProtocolNegotiationClient::new(channel)
        .max_decoding_message_size(4096)
        .max_encoding_message_size(4096)
        .negotiate(request)
        .await;
    let response = match response {
        Ok(response) => response.into_inner(),
        Err(status)
            if matches!(
                status.code(),
                Code::Unavailable | Code::DeadlineExceeded | Code::Cancelled
            ) || crate::local_transport_failure(&status) =>
        {
            return Err(NegotiationError::Unavailable(status));
        }
        Err(status) if status.code() == Code::Unimplemented => {
            return Err(NegotiationError::Incompatible(format!(
                "incompatible SuperTag protocol: the peer does not offer SuperTag protocol negotiation, so it is not a SuperTag {expected_name} this {local_name} can use"
            )));
        }
        Err(status)
            if matches!(
                status.code(),
                Code::FailedPrecondition | Code::PermissionDenied | Code::InvalidArgument
            ) =>
        {
            return Err(NegotiationError::Incompatible(format!(
                "the SuperTag {expected_name} refused this {local_name}: {}",
                status.message()
            )));
        }
        Err(status) => {
            return Err(NegotiationError::Incompatible(format!(
                "SuperTag protocol negotiation with the {expected_name} failed: {}",
                status.message()
            )));
        }
    };
    let peer_role = ServiceRole::try_from(response.role).unwrap_or(ServiceRole::Unspecified);
    if peer_role != expected {
        return Err(NegotiationError::Incompatible(format!(
            "this {local_name} expected a SuperTag {expected_name} but reached a {}",
            role_name(peer_role)
        )));
    }
    if !local.contains(&response.protocol_version)
        || !response
            .protocol_versions
            .contains(&response.protocol_version)
    {
        return Err(NegotiationError::Incompatible(format!(
            "incompatible SuperTag protocol: this {local_name} (SuperTag {}) speaks protocol versions {}, but the {expected_name} (SuperTag {}) speaks {} and selected {}; run the same SuperTag release on both services",
            build_version(),
            versions(local),
            printable(&response.build_version),
            versions(&response.protocol_versions),
            response.protocol_version,
        )));
    }
    Ok(response.protocol_version)
}

/// The metadata header that carries a negotiated protocol version on each call.
pub const PROTOCOL_HEADER: &str = "x-supertag-protocol";
const NEGOTIATION_PATH: &str = "/supertag.runtime.v2.ProtocolNegotiation/";
const HEALTH_PATH: &str = "/grpc.health.v1.Health/";

/// Adds the negotiated protocol version to every call on a channel.
#[derive(Clone, Debug)]
pub struct ProtocolVersion(MetadataValue<Ascii>);

impl ProtocolVersion {
    pub fn new(version: u32) -> Self {
        Self(MetadataValue::from(version))
    }
}

impl Interceptor for ProtocolVersion {
    fn call(&mut self, mut request: Request<()>) -> Result<Request<()>, Status> {
        request
            .metadata_mut()
            .insert(PROTOCOL_HEADER, self.0.clone());
        Ok(request)
    }
}

/// A channel whose calls carry a negotiated protocol version.
pub type ProtocolChannel = InterceptedService<Channel, ProtocolVersion>;

/// Marks every call on `channel` with a version a negotiation selected.
pub fn bind(channel: Channel, version: u32) -> ProtocolChannel {
    InterceptedService::new(channel, ProtocolVersion::new(version))
}

/// Only for in-process tests whose fake peer does not serve negotiation.
#[doc(hidden)]
pub fn bind_current(channel: Channel) -> ProtocolChannel {
    bind(
        channel,
        *PROTOCOL_VERSIONS
            .last()
            .expect("a supported protocol version"),
    )
}

/// Negotiates as `role` with a peer that must answer as `expected`, then
/// returns the channel bound to the selected version.
pub async fn connect(
    channel: Channel,
    role: ServiceRole,
    expected: ServiceRole,
) -> Result<ProtocolChannel, NegotiationError> {
    let version = negotiate(channel.clone(), role, expected).await?;
    Ok(bind(channel, version))
}

/// Refuses every call that does not name a protocol version this service
/// speaks, except negotiation itself and the standard health service. Apply it
/// to a whole server with `Server::builder().layer(fence(..))`.
pub fn fence(role: ServiceRole) -> ProtocolFence {
    ProtocolFence {
        role,
        versions: PROTOCOL_VERSIONS,
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ProtocolFence {
    role: ServiceRole,
    versions: &'static [u32],
}

impl ProtocolFence {
    /// Only for tests that need a service from another protocol epoch.
    #[doc(hidden)]
    pub fn with_versions(mut self, versions: &'static [u32]) -> Self {
        self.versions = versions;
        self
    }

    /// Why a call with these path and headers is refused, if it is.
    pub fn refusal(&self, path: &str, headers: &http::HeaderMap) -> Option<Status> {
        if path.starts_with(NEGOTIATION_PATH) || path.starts_with(HEALTH_PATH) {
            return None;
        }
        let local = role_name(self.role);
        let mut values = headers.get_all(PROTOCOL_HEADER).iter();
        let Some(value) = values.next() else {
            return Some(Status::failed_precondition(format!(
                "this SuperTag {local} refuses a call that did not negotiate a protocol version: call ProtocolNegotiation.Negotiate first and send the selected version in {PROTOCOL_HEADER} on every call"
            )));
        };
        let version = value
            .to_str()
            .ok()
            .filter(|text| !text.starts_with('0') || *text == "0")
            .and_then(|text| text.parse::<u32>().ok())
            .filter(|_| values.next().is_none());
        match version {
            Some(version) if self.versions.contains(&version) => None,
            Some(version) => Some(Status::failed_precondition(format!(
                "incompatible SuperTag protocol: this {local} (SuperTag {}) speaks protocol versions {}, but the call names protocol {version}; negotiate again",
                build_version(),
                versions(self.versions),
            ))),
            None => Some(Status::failed_precondition(format!(
                "this SuperTag {local} refuses a call with an invalid {PROTOCOL_HEADER} header"
            ))),
        }
    }
}

impl<S> Layer<S> for ProtocolFence {
    type Service = FencedService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        FencedService {
            inner,
            fence: *self,
        }
    }
}

#[derive(Clone, Debug)]
pub struct FencedService<S> {
    inner: S,
    fence: ProtocolFence,
}

type FencedFuture<R, E> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<R, E>> + Send>>;

impl<S, ReqBody, ResBody> Service<http::Request<ReqBody>> for FencedService<S>
where
    S: Service<http::Request<ReqBody>, Response = http::Response<ResBody>>,
    S::Future: Send + 'static,
    ResBody: Default + Send + 'static,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = FencedFuture<S::Response, S::Error>;

    fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(context)
    }

    fn call(&mut self, request: http::Request<ReqBody>) -> Self::Future {
        match self.fence.refusal(request.uri().path(), request.headers()) {
            Some(status) => {
                let response = status.into_http();
                Box::pin(async move { Ok(response) })
            }
            None => Box::pin(self.inner.call(request)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_the_highest_shared_version_and_names_both_sides_on_mismatch() {
        assert_eq!(select_version(&[2, 3], &[1, 2, 3]), Some(3));
        assert_eq!(select_version(&[2], &[1]), None);
        let gateway = Negotiator::new(ServiceRole::Gateway, &[ServiceRole::WorkerHost]);
        let request = |role: ServiceRole, versions: Vec<u32>| NegotiateProtocolRequest {
            role: role as i32,
            protocol_versions: versions,
            build_version: "0.1.0\u{1b}[31m".into(),
        };
        let accepted = gateway
            .answer(&request(ServiceRole::WorkerHost, vec![1, 2]))
            .unwrap();
        assert_eq!(accepted.protocol_version, 2);
        assert_eq!(accepted.role, ServiceRole::Gateway as i32);
        let refused = gateway
            .answer(&request(ServiceRole::WorkerHost, vec![1]))
            .unwrap_err();
        assert_eq!(refused.code(), Code::FailedPrecondition);
        assert!(
            refused.message().starts_with(
                &format!("incompatible SuperTag protocol: this Gateway (SuperTag {}) speaks protocol versions [2], but the connecting Worker Host (SuperTag 0.1.0[31m) offered [1]", build_version())
            ),
            "{}",
            refused.message()
        );
        let wrong = gateway
            .answer(&request(ServiceRole::ControlPlane, vec![2]))
            .unwrap_err();
        assert_eq!(wrong.code(), Code::PermissionDenied);
        assert_eq!(
            wrong.message(),
            "a Control Plane cannot connect directly to the SuperTag Gateway"
        );
        assert_eq!(
            gateway
                .answer(&request(ServiceRole::WorkerHost, vec![2; 33]))
                .unwrap_err()
                .code(),
            Code::InvalidArgument
        );
    }

    #[test]
    fn fence_admits_negotiation_health_and_negotiated_calls_only() {
        let fence = fence(ServiceRole::Gateway);
        let headers = |value: Option<&str>| {
            let mut headers = http::HeaderMap::new();
            if let Some(value) = value {
                headers.insert(PROTOCOL_HEADER, value.parse().unwrap());
            }
            headers
        };
        let operator = "/supertag.runtime.v2.Operator/GetTask";
        assert!(
            fence
                .refusal(
                    "/supertag.runtime.v2.ProtocolNegotiation/Negotiate",
                    &headers(None)
                )
                .is_none()
        );
        assert!(
            fence
                .refusal("/grpc.health.v1.Health/Check", &headers(None))
                .is_none()
        );
        assert!(fence.refusal(operator, &headers(Some("2"))).is_none());
        let skipped = fence.refusal(operator, &headers(None)).unwrap();
        assert_eq!(skipped.code(), Code::FailedPrecondition);
        assert!(
            skipped
                .message()
                .contains("did not negotiate a protocol version"),
            "{}",
            skipped.message()
        );
        let old = fence.refusal(operator, &headers(Some("1"))).unwrap();
        assert!(
            old.message().starts_with(
                &format!("incompatible SuperTag protocol: this Gateway (SuperTag {}) speaks protocol versions [2], but the call names protocol 1", build_version())
            ),
            "{}",
            old.message()
        );
        for invalid in ["02", "two", "", "4294967296"] {
            let refused = fence.refusal(operator, &headers(Some(invalid))).unwrap();
            assert!(refused.message().contains("invalid"), "{invalid}");
        }
        let mut repeated = headers(Some("2"));
        repeated.append(PROTOCOL_HEADER, "2".parse().unwrap());
        assert!(fence.refusal(operator, &repeated).is_some());
    }
}
