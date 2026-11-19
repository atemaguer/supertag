//! The Control Plane's one authorization layer.
//!
//! Every call to the public listener passes through [`Authorize`], after the protocol fence. It
//! parses exactly one bearer credential, resolves it on every call (so revocation and rotation take
//! effect on the next call), looks the gRPC method up in one static table of the roles allowed to
//! call it, and hands the handler a typed [`Caller`]. A method missing from the table is refused:
//! the table is default-deny, and a unit test fails when any RPC in the compiled descriptors lacks
//! an entry, so a new RPC cannot ship unclassified.
//!
//! Credentials have fixed prefixes, so a misplaced secret is refused before any lookup:
//! `stop_` Operator Tokens, `stak_` Auth Keys (accepted only by `Enrollments.Enroll`), and
//! `stcr_` enrolled host, Gateway and client credentials, and `stat_` Attempt credentials, which
//! the state owner resolves on every call this tier forwards. The admin operator token comes from the
//! Control Plane's configuration. Negotiation carries no credential, so the negotiated role is
//! never trusted. Identity is in the bearer, so native gRPC and the WebSocket tunnel take the same
//! path.

use std::{
    task::{Context, Poll},
    time::Duration,
};

use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
pub use supertag_protocol::authorization::allowed_roles;
use supertag_protocol::authorization::{
    ADMIN, ATTEMPT, CLIENT, ENROLL, GATEWAY, HEALTH_PATH, HOST, NEGOTIATION_PATH, OPERATOR,
    path_access,
};
use supertag_protocol::{
    ATTEMPT_CREDENTIAL_SECRET_PREFIX, ATTEMPT_PRINCIPAL_PREFIX, AUTH_KEY_SECRET_PREFIX,
    CREDENTIAL_SECRET_PREFIX, INTERNAL_PRINCIPAL_HEADER, MAX_MESSAGE_BYTES,
    is_operator_token_secret, is_secret,
    v2::{
        PrincipalRole, ResolveCredentialRequest,
        credential_directory_client::CredentialDirectoryClient,
    },
};
use tonic::{
    Code, Status,
    metadata::{Ascii, MetadataMap, MetadataValue},
};
use tower_layer::Layer;
use tower_service::Service;

use crate::{AUTHORIZATION, Api};

/// How long resolving a presented credential may take.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);

/// Who called, as the authorization layer established it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Operator,
    Host,
    Gateway,
    Client,
    /// An Attempt credential: one Task Attempt's data calls.
    Attempt,
}

impl Role {
    fn bit(self) -> u16 {
        match self {
            Self::Operator => OPERATOR,
            Self::Host => HOST,
            Self::Gateway => GATEWAY,
            Self::Client => CLIENT,
            Self::Attempt => ATTEMPT,
        }
    }

    pub(crate) fn proto(self) -> PrincipalRole {
        match self {
            Self::Attempt => PrincipalRole::Unspecified,
            Self::Operator => PrincipalRole::Operator,
            Self::Host => PrincipalRole::Host,
            Self::Gateway => PrincipalRole::Gateway,
            Self::Client => PrincipalRole::Client,
        }
    }
}

/// The authenticated caller of a public call, in the request's extensions.
#[derive(Clone, Debug)]
pub struct Caller {
    pub role: Role,
    /// `operator:local`, `operator:token:NAME`, `host:NAME`, `gateway:NAME` or `client:NAME`; for
    /// an Attempt credential, `attempt:` and its SHA-256 in hex, which the state owner resolves.
    pub principal: String,
    /// The admin operator, the only one that manages Operator Tokens.
    pub admin: bool,
    /// Hosts: the generation the Control Plane has registered.
    pub generation: u64,
    pub(crate) credential: Credential,
}

#[derive(Clone, Debug)]
pub(crate) enum Credential {
    Admin,
    OperatorToken(Vec<u8>),
    Enrolled(Vec<u8>),
    /// Resolved by the state owner on every call it forwards.
    Attempt,
}

impl Caller {
    pub(crate) fn identity(&self) -> Result<MetadataValue<Ascii>, Status> {
        self.principal
            .parse()
            .map_err(|_| Status::internal("invalid caller identity"))
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The SHA-256 of the Auth Key presented to `Enrollments.Enroll`, in the request's extensions.
#[derive(Clone, Debug)]
pub(crate) struct AuthKeyDigest(pub(crate) Vec<u8>);

fn unauthenticated() -> Status {
    Status::unauthenticated("valid bearer credential required")
}

fn denied() -> Status {
    Status::permission_denied("caller is not allowed to use this method")
}

/// The single bearer secret of a call.
fn bearer(metadata: &MetadataMap) -> Result<(&MetadataValue<Ascii>, &str), Status> {
    let mut values = metadata.get_all(AUTHORIZATION).iter();
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
    Ok((value, secret))
}

impl Api {
    /// Resolves the bearer credential of a call to its caller. Every call resolves it again.
    pub(crate) async fn authenticate(&self, metadata: &MetadataMap) -> Result<Caller, Status> {
        let (value, secret) = bearer(metadata)?;
        if bool::from(
            value
                .as_encoded_bytes()
                .ct_eq(self.credentials.admin.as_encoded_bytes()),
        ) {
            return Ok(Caller {
                role: Role::Operator,
                principal: self.credentials.admin_principal.clone(),
                admin: true,
                generation: 0,
                credential: Credential::Admin,
            });
        }
        let digest = Sha256::digest(secret.as_bytes()).to_vec();
        if is_operator_token_secret(secret) {
            self.resolve(Credential::OperatorToken(digest)).await
        } else if is_secret(CREDENTIAL_SECRET_PREFIX, secret) {
            self.resolve(Credential::Enrolled(digest)).await
        } else if is_secret(ATTEMPT_CREDENTIAL_SECRET_PREFIX, secret) {
            // The state owner resolves the credential on every call this tier forwards, and
            // refuses one whose Attempt, lease, or host generation is no longer live.
            Ok(Caller {
                role: Role::Attempt,
                principal: format!("{ATTEMPT_PRINCIPAL_PREFIX}{}", hex(&digest)),
                admin: false,
                generation: 0,
                credential: Credential::Attempt,
            })
        } else if is_secret(AUTH_KEY_SECRET_PREFIX, secret) {
            Err(Status::unauthenticated(
                "an Auth Key is accepted only to enroll; present the enrolled credential",
            ))
        } else {
            Err(unauthenticated())
        }
    }

    async fn resolve(&self, credential: Credential) -> Result<Caller, Status> {
        let (digest, kind) = match &credential {
            Credential::OperatorToken(digest) => (digest.clone(), PrincipalRole::Operator),
            Credential::Enrolled(digest) => (digest.clone(), PrincipalRole::Unspecified),
            Credential::Admin | Credential::Attempt => {
                unreachable!("the admin token and Attempt credentials are never resolved here")
            }
        };
        let request = self.credentials.upstream(
            ResolveCredentialRequest {
                token_digest: digest,
                kind: kind.into(),
            },
            MetadataValue::from_static("control-plane:api"),
            RESOLVE_TIMEOUT,
        );
        let resolved = tokio::time::timeout(
            RESOLVE_TIMEOUT,
            CredentialDirectoryClient::new(self.control_plane.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .resolve(request),
        )
        .await
        .map_err(|_| Status::unavailable("could not check the credential in time"))?
        .map_err(|error| match error.code() {
            // Revoked and expired Operator Tokens name why; anything else stays generic.
            Code::Unauthenticated => Status::unauthenticated(error.message().to_owned()),
            Code::PermissionDenied | Code::NotFound => unauthenticated(),
            _ => supertag_protocol::upstream_status(error),
        })?
        .into_inner();
        let (role, prefix) = match PrincipalRole::try_from(resolved.role) {
            Ok(PrincipalRole::Operator) => (Role::Operator, "operator"),
            Ok(PrincipalRole::Host) => (Role::Host, "host"),
            Ok(PrincipalRole::Gateway) => (Role::Gateway, "gateway"),
            Ok(PrincipalRole::Client) => (Role::Client, "client"),
            _ => return Err(Status::internal("invalid resolved credential")),
        };
        let valid_name = !resolved.name.is_empty()
            && resolved.name.len() <= 250
            && resolved.name.bytes().all(|byte| byte.is_ascii_graphic());
        let token = matches!(credential, Credential::OperatorToken(_));
        if !valid_name || token != (role == Role::Operator) {
            return Err(Status::internal("invalid resolved credential"));
        }
        Ok(Caller {
            role,
            principal: format!("{prefix}:{}", resolved.name),
            admin: false,
            generation: resolved.generation,
            credential,
        })
    }

    /// Confirms that a caller's credential still resolves to the same principal, as an open
    /// stream does at least once a second. The admin token always does.
    pub(crate) async fn recheck(&self, caller: &Caller) -> Result<(), Status> {
        if matches!(caller.credential, Credential::Admin) {
            return Ok(());
        }
        if matches!(caller.credential, Credential::Attempt) {
            // No stream takes an Attempt credential.
            return Err(unauthenticated());
        }
        let current = self.resolve(caller.credential.clone()).await?;
        if current.principal != caller.principal {
            return Err(unauthenticated());
        }
        Ok(())
    }

    /// The caller a handler acts for: the one the authorization layer established, or, for a
    /// request a handler rebuilt from metadata, the credential resolved again.
    pub(crate) async fn caller<T>(&self, request: &tonic::Request<T>) -> Result<Caller, Status> {
        if let Some(caller) = request.extensions().get::<Caller>() {
            return Ok(caller.clone());
        }
        self.authenticate(request.metadata()).await
    }

    /// The authorization layer for the public listener.
    pub fn authorize(&self) -> Authorize {
        Authorize { api: self.clone() }
    }
}

/// Who a call on the public listener is, and whether its method allows that role.
async fn admit(api: &Api, path: &str, metadata: &MetadataMap) -> Result<Admission, Status> {
    if path.starts_with(NEGOTIATION_PATH) || path.starts_with(HEALTH_PATH) {
        return Ok(Admission::Open);
    }
    let access = path_access(path).unwrap_or(0);
    if access & ENROLL != 0 {
        let (_, secret) = bearer(metadata)?;
        if !is_secret(AUTH_KEY_SECRET_PREFIX, secret) {
            return Err(Status::unauthenticated(
                "enrollment requires an Auth Key (stak_...) as the bearer credential",
            ));
        }
        return Ok(Admission::Enroll(AuthKeyDigest(
            Sha256::digest(secret.as_bytes()).to_vec(),
        )));
    }
    let roles = access & (ADMIN | OPERATOR | GATEWAY | HOST | CLIENT | ATTEMPT);
    if roles == 0 {
        return Err(denied());
    }
    let caller = api.authenticate(metadata).await?;
    let allowed = if access & ADMIN != 0 && caller.admin {
        true
    } else {
        access & caller.role.bit() != 0
    };
    if !allowed {
        return Err(denied());
    }
    Ok(Admission::Caller(caller))
}

enum Admission {
    Open,
    Enroll(AuthKeyDigest),
    Caller(Caller),
}

/// Whether the authorization layer admits a call, for tests of the table against real callers.
#[cfg(test)]
pub(crate) async fn admit_for_test(
    api: &Api,
    path: &str,
    metadata: &MetadataMap,
) -> Result<(), Status> {
    admit(api, path, metadata).await.map(|_| ())
}

/// The layer, placed after the protocol fence on the Control Plane's public listener.
#[derive(Clone)]
pub struct Authorize {
    api: Api,
}

impl<S> Layer<S> for Authorize {
    type Service = AuthorizeService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        AuthorizeService {
            inner,
            api: self.api.clone(),
        }
    }
}

#[derive(Clone)]
pub struct AuthorizeService<S> {
    inner: S,
    api: Api,
}

type BoxFuture<R, E> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<R, E>> + Send>>;

impl<S, ReqBody, ResBody> Service<http::Request<ReqBody>> for AuthorizeService<S>
where
    S: Service<http::Request<ReqBody>, Response = http::Response<ResBody>> + Clone + Send + 'static,
    S::Future: Send + 'static,
    S::Error: Send + 'static,
    ReqBody: Send + 'static,
    ResBody: Default + Send + 'static,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = BoxFuture<S::Response, S::Error>;

    fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(context)
    }

    fn call(&mut self, mut request: http::Request<ReqBody>) -> Self::Future {
        // Take the service that was polled ready and leave a fresh clone in its place.
        let clone = self.inner.clone();
        let mut inner = std::mem::replace(&mut self.inner, clone);
        let api = self.api.clone();
        Box::pin(async move {
            // The internal principal is the state owner's alone; no caller may name one.
            request.headers_mut().remove(INTERNAL_PRINCIPAL_HEADER);
            let path = request.uri().path().to_owned();
            let metadata = MetadataMap::from_headers(request.headers().clone());
            match admit(&api, &path, &metadata).await {
                Ok(Admission::Open) => {}
                Ok(Admission::Enroll(digest)) => {
                    request.extensions_mut().insert(digest);
                }
                Ok(Admission::Caller(caller)) => {
                    request.extensions_mut().insert(caller);
                }
                Err(status) => return Ok(status.into_http()),
            }
            inner.call(request).await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_single_bearer_is_required() {
        let mut metadata = MetadataMap::new();
        assert_eq!(bearer(&metadata).unwrap_err().code(), Code::Unauthenticated);
        metadata.insert(AUTHORIZATION, "Bearer one".parse().unwrap());
        assert_eq!(bearer(&metadata).unwrap().1, "one");
        metadata.append(AUTHORIZATION, "Bearer two".parse().unwrap());
        assert_eq!(bearer(&metadata).unwrap_err().code(), Code::Unauthenticated);
    }
}
