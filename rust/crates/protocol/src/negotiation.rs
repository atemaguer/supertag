//! Explicit protocol version negotiation between SuperTag services.
//!
//! The Rust release is an incompatible protocol epoch (design §4): there is no
//! translation for older peers. Every service connection negotiates before it
//! registers, claims, or forwards work, and both sides refuse a peer that shares
//! no version or connects in the wrong role.
use std::time::Duration;

use tonic::{Code, Request, Response, Status, transport::Channel};

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
                "incompatible SuperTag protocol: this Gateway (SuperTag 0.1.0) speaks protocol versions [2], but the connecting Worker Host (SuperTag 0.1.0[31m) offered [1]"
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
}
