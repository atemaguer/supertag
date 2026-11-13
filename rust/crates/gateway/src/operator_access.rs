//! Operator authentication with the admin operator token or an issued Operator Token, and the
//! public Operator Token and audit API.
//!
//! The admin token is compared in constant time with the Gateway's configuration. An Operator
//! Token is resolved by the Control Plane on every call, never cached, so revocation and rotation
//! take effect on the next call. Open streams recheck their token at least once a second.

use std::time::Duration;

use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        operator_access_client::OperatorAccessClient, operator_access_server,
        operator_directory_client::OperatorDirectoryClient, *,
    },
};
use tonic::{
    Code, Request, Response, Status,
    metadata::{Ascii, MetadataValue},
};

use crate::{AUTHORIZATION, Credentials, Gateway, Principal, request_budget};

/// Every Operator Token secret starts with this prefix.
pub const OPERATOR_TOKEN_SECRET_PREFIX: &str = "stop_";
/// How often an open operator stream rechecks an Operator Token.
pub(crate) const OPERATOR_RECHECK: Duration = Duration::from_secs(1);

/// The credential an operator call presented.
pub(crate) enum OperatorCredential {
    Admin,
    /// SHA-256 of a well-formed Operator Token secret.
    Token(Vec<u8>),
}

/// The private identity an operator call acts as, and how to recheck it.
pub(crate) struct OperatorCaller {
    pub(crate) identity: MetadataValue<Ascii>,
    token_digest: Option<Vec<u8>>,
}

/// True when the text has the shape of an Operator Token secret: `stop_` and 64 lowercase hex.
pub fn is_operator_token_secret(value: &str) -> bool {
    value
        .strip_prefix(OPERATOR_TOKEN_SECRET_PREFIX)
        .is_some_and(|rest| {
            rest.len() == 64
                && rest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        })
}

fn unauthenticated() -> Status {
    Status::unauthenticated("valid bearer credential required")
}

impl Credentials {
    /// Classifies the single bearer credential of an operator call without contacting the
    /// Control Plane. The private Gateway credential and malformed values are refused here.
    pub(crate) fn presented_operator<T>(
        &self,
        request: &Request<T>,
    ) -> Result<OperatorCredential, Status> {
        let mut values = request.metadata().get_all(AUTHORIZATION).iter();
        let value = values.next().ok_or_else(unauthenticated)?;
        if values.next().is_some() {
            return Err(unauthenticated());
        }
        let bytes = value.as_encoded_bytes();
        if bool::from(bytes.ct_eq(self.operator.authorization.as_encoded_bytes())) {
            return Ok(OperatorCredential::Admin);
        }
        if bool::from(bytes.ct_eq(self.service.as_encoded_bytes())) {
            return Err(unauthenticated());
        }
        let secret = value
            .to_str()
            .ok()
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|secret| is_operator_token_secret(secret))
            .ok_or_else(unauthenticated)?;
        Ok(OperatorCredential::Token(
            Sha256::digest(secret.as_bytes()).to_vec(),
        ))
    }
}

impl Gateway {
    pub fn operator_access_service(&self) -> operator_access_server::OperatorAccessServer<Self> {
        operator_access_server::OperatorAccessServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    /// Resolves an Operator Token digest to its private `operator:token:NAME` identity.
    pub(crate) async fn authenticate_operator(
        &self,
        token_digest: Vec<u8>,
        timeout: Duration,
    ) -> Result<MetadataValue<Ascii>, Status> {
        let request = self.credentials.upstream(
            AuthenticateOperatorRequest { token_digest },
            MetadataValue::from_static("service:gateway"),
            timeout,
        );
        let identity = OperatorDirectoryClient::new(self.control_plane.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
            .authenticate(request)
            .await
            .map_err(|error| match error.code() {
                // Revoked and expired tokens name why; anything else stays generic.
                Code::Unauthenticated => Status::unauthenticated(error.message().to_owned()),
                Code::PermissionDenied => unauthenticated(),
                _ => error,
            })?
            .into_inner();
        let valid = identity
            .operator_id
            .strip_prefix("token:")
            .is_some_and(|name| {
                !name.is_empty()
                    && name.len() <= 63
                    && name.bytes().all(|byte| byte.is_ascii_graphic())
            });
        if !valid {
            return Err(Status::internal("invalid Operator Token identity"));
        }
        format!("operator:{}", identity.operator_id)
            .parse()
            .map_err(|_| Status::internal("invalid Operator Token identity"))
    }

    /// Authenticates an operator call that does not go through `forward`, such as a stream.
    pub(crate) async fn operator_caller<T>(
        &self,
        request: &Request<T>,
        principal: &Principal,
    ) -> Result<OperatorCaller, Status> {
        match self.credentials.presented_operator(request)? {
            OperatorCredential::Admin => Ok(OperatorCaller {
                identity: principal.identity.clone(),
                token_digest: None,
            }),
            OperatorCredential::Token(digest) => {
                let timeout = request_budget(request)?;
                let identity = tokio::time::timeout(
                    timeout,
                    self.authenticate_operator(digest.clone(), timeout),
                )
                .await
                .map_err(|_| Status::deadline_exceeded("Control Plane request timed out"))??;
                Ok(OperatorCaller {
                    identity,
                    token_digest: Some(digest),
                })
            }
        }
    }

    /// Confirms that the caller's Operator Token is still valid. The admin token always is.
    pub(crate) async fn recheck_operator(&self, caller: &OperatorCaller) -> Result<(), Status> {
        let Some(digest) = &caller.token_digest else {
            return Ok(());
        };
        let timeout = Duration::from_secs(5);
        let identity =
            tokio::time::timeout(timeout, self.authenticate_operator(digest.clone(), timeout))
                .await
                .map_err(|_| Status::unavailable("could not recheck the Operator Token"))??;
        if identity != caller.identity {
            return Err(unauthenticated());
        }
        Ok(())
    }
}

fn access(channel: ProtocolChannel) -> OperatorAccessClient<ProtocolChannel> {
    OperatorAccessClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

#[tonic::async_trait]
impl operator_access_server::OperatorAccess for Gateway {
    async fn create_operator_token(
        &self,
        request: Request<CreateOperatorTokenRequest>,
    ) -> Result<Response<OperatorToken>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { access(channel).create_operator_token(request).await },
        )
        .await
    }

    async fn get_operator_token(
        &self,
        request: Request<GetOperatorTokenRequest>,
    ) -> Result<Response<OperatorToken>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { access(channel).get_operator_token(request).await },
        )
        .await
    }

    async fn list_operator_tokens(
        &self,
        request: Request<ListOperatorTokensRequest>,
    ) -> Result<Response<ListOperatorTokensResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { access(channel).list_operator_tokens(request).await },
        )
        .await
    }

    async fn rotate_operator_token(
        &self,
        request: Request<RotateOperatorTokenRequest>,
    ) -> Result<Response<OperatorToken>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { access(channel).rotate_operator_token(request).await },
        )
        .await
    }

    async fn revoke_operator_token(
        &self,
        request: Request<RevokeOperatorTokenRequest>,
    ) -> Result<Response<OperatorToken>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { access(channel).revoke_operator_token(request).await },
        )
        .await
    }

    async fn list_audit_entries(
        &self,
        request: Request<ListAuditEntriesRequest>,
    ) -> Result<Response<ListAuditEntriesResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { access(channel).list_audit_entries(request).await },
        )
        .await
    }
}
