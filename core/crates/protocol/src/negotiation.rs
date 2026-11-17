//! Explicit protocol version negotiation between SuperTag services.
//!
//! The Rust release is an incompatible protocol epoch (design §4): there is no
//! translation for older peers. Every service and operator connection
//! negotiates before it registers, claims, forwards work, or makes an operator
//! call, and both sides refuse a peer that shares no version or connects in the
//! wrong role.
//!
//! [`PROTOCOL_VERSIONS`] changes whenever `proto/` changes incompatibly, and only
//! the current version is accepted before a stable release: a peer from an
//! earlier release is refused with a [`VersionMismatch`] that names both sides
//! and the fix, not left to fail call by call. `proto/protocol.lock` pairs the
//! version with a digest of `proto/`, and a test fails when they drift.
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
pub const PROTOCOL_VERSIONS: &[u32] = &[3];
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
            // Clients read this server's release and versions back out of this text (see
            // `VersionMismatch::from_refusal`), as they do from every earlier release: keep
            // the `(SuperTag BUILD) speaks protocol versions [..]` part.
            let fix = match upgrade(self.versions, &request.protocol_versions) {
                Some(Upgrade::Peer) => format!("upgrade the connecting {peer}"),
                Some(Upgrade::Local) => format!("upgrade this {local}"),
                None => "run the same SuperTag release on both services".into(),
            };
            return Err(Status::failed_precondition(format!(
                "incompatible SuperTag protocol: this {local} (SuperTag {}) speaks protocol versions {}, but the connecting {peer} (SuperTag {build}) offered {}; {fix}",
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
    /// The peer is a SuperTag service from a release that speaks other protocol versions.
    /// Retrying cannot help; one side must be upgraded.
    Mismatch(VersionMismatch),
}

impl NegotiationError {
    /// Names where the peer was reached, such as `http://127.0.0.1:3434`, in a mismatch.
    pub fn at(self, endpoint: impl Into<String>) -> Self {
        match self {
            Self::Mismatch(mismatch) => Self::Mismatch(VersionMismatch {
                endpoint: Some(endpoint.into().trim_end_matches('/').to_owned()),
                ..mismatch
            }),
            other => other,
        }
    }

    /// Names this side in a mismatch, such as `This CLI` or `This app`.
    pub fn speaking_as(self, subject: impl Into<String>) -> Self {
        match self {
            Self::Mismatch(mismatch) => Self::Mismatch(VersionMismatch {
                subject: subject.into(),
                ..mismatch
            }),
            other => other,
        }
    }
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
            Self::Mismatch(mismatch) => mismatch.fmt(f),
        }
    }
}

/// Which side of a version mismatch must be upgraded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Upgrade {
    Local,
    Peer,
}

/// The side whose every version is older than all of the other's, if one is.
fn upgrade(local: &[u32], peer: &[u32]) -> Option<Upgrade> {
    let (local_max, peer_max) = (local.iter().max()?, peer.iter().max()?);
    if peer_max < local.iter().min()? {
        Some(Upgrade::Peer)
    } else if local_max < peer.iter().min()? {
        Some(Upgrade::Local)
    } else {
        None
    }
}

/// `protocol 3`, or `protocols 2, 3`.
fn spoken(list: &[u32]) -> String {
    let items = list.iter().map(u32::to_string).collect::<Vec<_>>();
    match items.len() {
        1 => format!("protocol {}", items[0]),
        _ => format!("protocols {}", items.join(", ")),
    }
}

/// A peer that speaks no protocol version this side speaks, with what is known of its release.
#[derive(Clone, Debug)]
pub struct VersionMismatch {
    subject: String,
    peer: ServiceRole,
    endpoint: Option<String>,
    local_versions: Vec<u32>,
    /// The peer's release and versions, when it named them.
    peer_release: Option<(String, Vec<u32>)>,
    /// The peer's refusal, when it did not name them.
    refusal: Option<String>,
}

impl VersionMismatch {
    fn new(local: ServiceRole, peer: ServiceRole, local_versions: &[u32]) -> Self {
        Self {
            subject: format!("This {}", role_name(local)),
            peer,
            endpoint: None,
            local_versions: local_versions.to_vec(),
            peer_release: None,
            refusal: None,
        }
    }

    /// Reads the peer's release and versions out of its refusal. Every SuperTag release that
    /// negotiates refuses with `... (SuperTag BUILD) speaks protocol versions [V, ...] ...`.
    fn from_refusal(
        local: ServiceRole,
        peer: ServiceRole,
        local_versions: &[u32],
        message: &str,
    ) -> Self {
        let mut mismatch = Self::new(local, peer, local_versions);
        match parse_refusal(message) {
            Some(release) => mismatch.peer_release = Some(release),
            None => mismatch.refusal = Some(printable_message(message)),
        }
        mismatch
    }

    /// The peer's release, when it named it.
    pub fn peer_build(&self) -> Option<&str> {
        self.peer_release.as_ref().map(|(build, _)| build.as_str())
    }

    /// The protocol versions the peer speaks, when it named them.
    pub fn peer_versions(&self) -> Option<&[u32]> {
        self.peer_release
            .as_ref()
            .map(|(_, versions)| versions.as_slice())
    }
}

impl std::fmt::Display for VersionMismatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let peer = role_name(self.peer);
        let at = self
            .endpoint
            .as_deref()
            .map(|endpoint| format!(" at {endpoint}"))
            .unwrap_or_default();
        write!(
            f,
            "{} speaks SuperTag {}, but the {peer}{at} ",
            self.subject,
            spoken(&self.local_versions)
        )?;
        match &self.peer_release {
            Some((build, peer_versions)) => {
                write!(f, "runs SuperTag {build} ({}). ", spoken(peer_versions))?;
                match upgrade(&self.local_versions, peer_versions) {
                    Some(Upgrade::Peer) => write!(f, "Upgrade the {peer}."),
                    Some(Upgrade::Local) => {
                        write!(f, "Upgrade {}.", lowercase_first(&self.subject))
                    }
                    None => f.write_str("Run the same SuperTag release on both."),
                }
            }
            None => write!(
                f,
                "refused it: {}. Run the same SuperTag release on both.",
                self.refusal.as_deref().unwrap_or("no reason given")
            ),
        }
    }
}

fn lowercase_first(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_lowercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn printable_message(message: &str) -> String {
    message
        .chars()
        .filter(|c| !c.is_control())
        .take(512)
        .collect::<String>()
        .trim_end_matches(['.', ' '])
        .to_owned()
}

/// The release and versions in a negotiation refusal, if it names them.
fn parse_refusal(message: &str) -> Option<(String, Vec<u32>)> {
    let (_, rest) = message.split_once("(SuperTag ")?;
    let (build, rest) = rest.split_once(") speaks protocol versions [")?;
    let (list, _) = rest.split_once(']')?;
    let versions = list
        .split(',')
        .map(|item| item.trim().parse::<u32>().ok())
        .collect::<Option<Vec<_>>>()?;
    (!versions.is_empty() && versions.len() <= MAX_OFFERED_VERSIONS)
        .then(|| (printable(build), versions))
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
            if status.code() == Code::FailedPrecondition
                && status
                    .message()
                    .starts_with("incompatible SuperTag protocol") =>
        {
            return Err(NegotiationError::Mismatch(VersionMismatch::from_refusal(
                role,
                expected,
                local,
                status.message(),
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
        let mut mismatch = VersionMismatch::new(role, expected, local);
        let mut peer_versions = response.protocol_versions;
        peer_versions.truncate(MAX_OFFERED_VERSIONS);
        if peer_versions.is_empty() {
            peer_versions.push(response.protocol_version);
        }
        mismatch.peer_release = Some((printable(&response.build_version), peer_versions));
        return Err(NegotiationError::Mismatch(mismatch));
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
        assert_eq!(select_version(&[3], &[2]), None);
        let gateway = Negotiator::new(ServiceRole::Gateway, &[ServiceRole::WorkerHost]);
        let request = |role: ServiceRole, versions: Vec<u32>| NegotiateProtocolRequest {
            role: role as i32,
            protocol_versions: versions,
            build_version: "0.1.0\u{1b}[31m".into(),
        };
        let accepted = gateway
            .answer(&request(ServiceRole::WorkerHost, vec![2, 3]))
            .unwrap();
        assert_eq!(accepted.protocol_version, 3);
        assert_eq!(accepted.role, ServiceRole::Gateway as i32);
        let refused = gateway
            .answer(&request(ServiceRole::WorkerHost, vec![2]))
            .unwrap_err();
        assert_eq!(refused.code(), Code::FailedPrecondition);
        assert_eq!(
            refused.message(),
            format!(
                "incompatible SuperTag protocol: this Gateway (SuperTag {}) speaks protocol versions [3], but the connecting Worker Host (SuperTag 0.1.0[31m) offered [2]; upgrade the connecting Worker Host",
                build_version()
            ),
        );
        let newer = gateway
            .answer(&request(ServiceRole::WorkerHost, vec![4]))
            .unwrap_err();
        assert!(
            newer.message().ends_with("; upgrade this Gateway"),
            "{}",
            newer.message()
        );
        let wrong = gateway
            .answer(&request(ServiceRole::ControlPlane, vec![3]))
            .unwrap_err();
        assert_eq!(wrong.code(), Code::PermissionDenied);
        assert_eq!(
            wrong.message(),
            "a Control Plane cannot connect directly to the SuperTag Gateway"
        );
        assert_eq!(
            gateway
                .answer(&request(ServiceRole::WorkerHost, vec![3; 33]))
                .unwrap_err()
                .code(),
            Code::InvalidArgument
        );
    }

    /// The exact refusal a SuperTag 0.3.0 Control Plane (protocol 2) sends this release.
    const RELEASED_0_3_0_REFUSAL: &str = "incompatible SuperTag protocol: this Control Plane (SuperTag 0.3.0) speaks protocol versions [2], but the connecting operator client (SuperTag 0.3.1) offered [3]; run the same SuperTag release on both services";

    #[test]
    fn a_mismatch_names_both_releases_where_the_peer_runs_and_the_fix() {
        let older = NegotiationError::Mismatch(VersionMismatch::from_refusal(
            ServiceRole::Client,
            ServiceRole::ControlPlane,
            &[3],
            RELEASED_0_3_0_REFUSAL,
        ));
        let NegotiationError::Mismatch(parsed) = &older else {
            unreachable!()
        };
        assert_eq!(parsed.peer_build(), Some("0.3.0"));
        assert_eq!(parsed.peer_versions(), Some(&[2][..]));
        assert_eq!(
            older
                .speaking_as("This app")
                .at("http://127.0.0.1:3434")
                .to_string(),
            "This app speaks SuperTag protocol 3, but the Control Plane at http://127.0.0.1:3434 runs SuperTag 0.3.0 (protocol 2). Upgrade the Control Plane."
        );
        let newer = NegotiationError::Mismatch(VersionMismatch::from_refusal(
            ServiceRole::WorkerHost,
            ServiceRole::ControlPlane,
            &[3],
            "incompatible SuperTag protocol: this Control Plane (SuperTag 0.5.0) speaks protocol versions [4, 5], but ...",
        ));
        assert_eq!(
            newer.to_string(),
            "This Worker Host speaks SuperTag protocol 3, but the Control Plane runs SuperTag 0.5.0 (protocols 4, 5). Upgrade this Worker Host."
        );
        let unnamed = NegotiationError::Mismatch(VersionMismatch::from_refusal(
            ServiceRole::Client,
            ServiceRole::ControlPlane,
            &[3],
            "incompatible SuperTag protocol: no\u{7}pe.",
        ));
        assert_eq!(
            unnamed.speaking_as("This CLI").to_string(),
            "This CLI speaks SuperTag protocol 3, but the Control Plane refused it: incompatible SuperTag protocol: nope. Run the same SuperTag release on both."
        );
    }

    #[test]
    fn this_release_refuses_in_the_form_clients_read() {
        let plane = Negotiator::new(ServiceRole::ControlPlane, &[ServiceRole::Client]);
        let refused = plane
            .answer(&NegotiateProtocolRequest {
                role: ServiceRole::Client as i32,
                protocol_versions: vec![2],
                build_version: "0.3.0".into(),
            })
            .unwrap_err();
        assert_eq!(
            parse_refusal(refused.message()),
            Some((build_version().to_owned(), PROTOCOL_VERSIONS.to_vec()))
        );
        assert_eq!(parse_refusal("speaks protocol versions [x]"), None);
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
        assert!(fence.refusal(operator, &headers(Some("3"))).is_none());
        let skipped = fence.refusal(operator, &headers(None)).unwrap();
        assert_eq!(skipped.code(), Code::FailedPrecondition);
        assert!(
            skipped
                .message()
                .contains("did not negotiate a protocol version"),
            "{}",
            skipped.message()
        );
        let old = fence.refusal(operator, &headers(Some("2"))).unwrap();
        assert!(
            old.message().starts_with(
                &format!("incompatible SuperTag protocol: this Gateway (SuperTag {}) speaks protocol versions [3], but the call names protocol 2", build_version())
            ),
            "{}",
            old.message()
        );
        for invalid in ["02", "two", "", "4294967296"] {
            let refused = fence.refusal(operator, &headers(Some(invalid))).unwrap();
            assert!(refused.message().contains("invalid"), "{invalid}");
        }
        let mut repeated = headers(Some("3"));
        repeated.append(PROTOCOL_HEADER, "3".parse().unwrap());
        assert!(fence.refusal(operator, &repeated).is_some());
    }
}
