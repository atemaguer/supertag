//! Operator authentication for the Gateway's one operator call, the test notification.
//!
//! The admin operator token is compared in constant time with the Gateway's configuration. An
//! Operator Token is resolved by the Control Plane on every call.

use std::time::Duration;

use anyhow::{Context, ensure};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request, is_operator_token_secret,
    negotiation::ProtocolChannel,
    v2::{AuthenticateOperatorRequest, operator_directory_client::OperatorDirectoryClient},
};
use tonic::{
    Code, Request, Status,
    metadata::{Ascii, MetadataValue},
};

const AUTHORIZATION: &str = "authorization";

/// Checks that a call presents the admin operator token or a live Operator Token.
#[derive(Clone)]
pub struct OperatorAuth {
    admin: MetadataValue<Ascii>,
    control_plane: ProtocolChannel,
    gateway_token: String,
}

fn unauthenticated() -> Status {
    Status::unauthenticated("valid bearer credential required")
}

impl OperatorAuth {
    pub fn new(
        admin_token: &str,
        control_plane: ProtocolChannel,
        gateway_token: String,
    ) -> anyhow::Result<Self> {
        ensure!(
            admin_token != gateway_token,
            "Gateway and operator tokens must be distinct"
        );
        let mut admin: MetadataValue<Ascii> = format!("Bearer {admin_token}")
            .parse()
            .context("invalid operator token")?;
        admin.set_sensitive(true);
        Ok(Self {
            admin,
            control_plane,
            gateway_token,
        })
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
        if bool::from(
            value
                .as_encoded_bytes()
                .ct_eq(self.admin.as_encoded_bytes()),
        ) {
            return Ok(());
        }
        let secret = value
            .to_str()
            .ok()
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|secret| is_operator_token_secret(secret))
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
                Code::PermissionDenied => unauthenticated(),
                _ => supertag_protocol::upstream_status(error),
            })
    }
}
