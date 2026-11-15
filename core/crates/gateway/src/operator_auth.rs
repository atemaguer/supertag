//! Operator authentication for the Gateway's one operator call, the test notification.
//!
//! The Gateway holds no operator credential and trusts none on its own. It presents the caller's
//! bearer credential to the Control Plane's public `Enrollments.WhoAmI`, so the Control Plane
//! resolves it exactly as it resolves any call, and admits only an operator.

use std::time::Duration;

use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request,
    negotiation::ProtocolChannel,
    v2::{PrincipalRole, WhoAmIRequest, enrollments_client::EnrollmentsClient},
};
use tonic::{Request, Status};

const AUTHORIZATION: &str = "authorization";

/// Checks that a call presents the admin operator token or a live Operator Token.
#[derive(Clone)]
pub struct OperatorAuth {
    control_plane: ProtocolChannel,
}

fn unauthenticated() -> Status {
    Status::unauthenticated("valid bearer credential required")
}

impl OperatorAuth {
    pub fn new(control_plane: ProtocolChannel) -> Self {
        Self { control_plane }
    }

    /// Accepts exactly one bearer credential that the Control Plane resolves to an operator.
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
        let mut upstream =
            authenticated_request(WhoAmIRequest {}, secret, None).map_err(|_| unauthenticated())?;
        upstream.set_timeout(timeout);
        let caller = EnrollmentsClient::new(self.control_plane.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
            .who_am_i(upstream)
            .await
            .map_err(|error| match error.code() {
                tonic::Code::Unauthenticated => Status::unauthenticated(error.message().to_owned()),
                _ => supertag_protocol::upstream_status(error),
            })?
            .into_inner();
        if caller.role != PrincipalRole::Operator as i32 {
            return Err(Status::permission_denied(
                "only an operator sends a test notification",
            ));
        }
        Ok(())
    }
}
