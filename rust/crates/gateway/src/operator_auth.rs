//! Operator authentication for the Gateway's one operator call, the test notification.
//!
//! The Gateway holds no operator credential. It sends the digest of the presented bearer
//! credential to the Control Plane, which resolves the admin operator token or an Operator Token
//! on every call.

use std::time::Duration;

use sha2::{Digest, Sha256};
use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request,
    negotiation::ProtocolChannel,
    v2::{AuthenticateOperatorRequest, operator_directory_client::OperatorDirectoryClient},
};
use tonic::{Code, Request, Status};

const AUTHORIZATION: &str = "authorization";

/// Checks that a call presents the admin operator token or a live Operator Token.
#[derive(Clone)]
pub struct OperatorAuth {
    control_plane: ProtocolChannel,
    gateway_token: String,
}

fn unauthenticated() -> Status {
    Status::unauthenticated("valid bearer credential required")
}

impl OperatorAuth {
    pub fn new(control_plane: ProtocolChannel, gateway_token: String) -> Self {
        Self {
            control_plane,
            gateway_token,
        }
    }

    /// Accepts exactly one bearer credential: the admin token or an unrevoked Operator Token.
    pub async fn authenticate<T>(
        &self,
        request: &Request<T>,
        timeout: Duration,
    ) -> Result<(), Status> {
        let mut values = request.metadata().get_all(AUTHORIZATION).iter();
        let value = values.next().ok_or_else(unauthenticated)?;
        if values.next().is_some() {
            return Err(unauthenticated());
        }
        let secret = value
            .to_str()
            .ok()
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|secret| !secret.is_empty() && secret.len() <= 512)
            .ok_or_else(unauthenticated)?;
        let mut upstream = authenticated_request(
            AuthenticateOperatorRequest {
                token_digest: Sha256::digest(secret.as_bytes()).to_vec(),
            },
            &self.gateway_token,
            Some("service:gateway"),
        )
        .map_err(|_| Status::internal("invalid Gateway credential"))?;
        upstream.set_timeout(timeout);
        OperatorDirectoryClient::new(self.control_plane.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
            .authenticate(upstream)
            .await
            .map(|_| ())
            .map_err(|error| match error.code() {
                Code::Unauthenticated => Status::unauthenticated(error.message().to_owned()),
                // The Control Plane refused this Gateway, not the operator's credential.
                Code::PermissionDenied => Status::failed_precondition(format!(
                    "the Control Plane refused this Gateway: {}",
                    error.message()
                )),
                _ => supertag_protocol::upstream_status(error),
            })
    }
}
