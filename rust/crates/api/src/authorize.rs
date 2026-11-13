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
//! `stcr_` enrolled host, Gateway and client credentials. The admin operator token comes from the
//! Control Plane's configuration. Negotiation carries no credential, so the negotiated role is
//! never trusted. Identity is in the bearer, so native gRPC and the WebSocket tunnel take the same
//! path.

use std::{
    task::{Context, Poll},
    time::Duration,
};

use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use supertag_protocol::{
    AUTH_KEY_SECRET_PREFIX, CREDENTIAL_SECRET_PREFIX, INTERNAL_PRINCIPAL_HEADER, MAX_MESSAGE_BYTES,
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

const NEGOTIATION_PATH: &str = "/supertag.runtime.v2.ProtocolNegotiation/";
const HEALTH_PATH: &str = "/grpc.health.v1.Health/";
const PACKAGE: &str = "/supertag.runtime.v2.";
/// How long resolving a presented credential may take.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);

/// Who called, as the authorization layer established it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Operator,
    Host,
    Gateway,
    Client,
}

impl Role {
    fn bit(self) -> u16 {
        match self {
            Self::Operator => OPERATOR,
            Self::Host => HOST,
            Self::Gateway => GATEWAY,
            Self::Client => CLIENT,
        }
    }

    pub(crate) fn proto(self) -> PrincipalRole {
        match self {
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
    /// `operator:local`, `operator:token:NAME`, `host:NAME`, `gateway:NAME` or `client:NAME`.
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
}

impl Caller {
    pub(crate) fn identity(&self) -> Result<MetadataValue<Ascii>, Status> {
        self.principal
            .parse()
            .map_err(|_| Status::internal("invalid caller identity"))
    }
}

/// The SHA-256 of the Auth Key presented to `Enrollments.Enroll`, in the request's extensions.
#[derive(Clone, Debug)]
pub(crate) struct AuthKeyDigest(pub(crate) Vec<u8>);

const ADMIN: u16 = 1;
const OPERATOR: u16 = 1 << 1;
const GATEWAY: u16 = 1 << 2;
const HOST: u16 = 1 << 3;
const CLIENT: u16 = 1 << 4;
/// No credential: protocol negotiation.
const OPEN: u16 = 1 << 5;
/// An Auth Key as the bearer: enrollment only.
const ENROLL: u16 = 1 << 6;
/// Served by the state owner to the API tier only; never on the public listener.
const INTERNAL: u16 = 1 << 7;
/// Served by a Worker Host or Gateway on its own listener; never by the Control Plane.
const PEER_LOCAL: u16 = 1 << 8;

const O: u16 = OPERATOR;
const OC: u16 = OPERATOR | CLIENT;
const ANY: u16 = OPERATOR | GATEWAY | HOST | CLIENT;

/// Every RPC of the runtime protocol and who may call it on the Control Plane's public listener.
/// `*` covers every method of a service that has no exact entry. See
/// contributing/auth-key-roles-design.md, section 4.
const TABLE: &[(&str, &str, u16)] = &[
    ("ProtocolNegotiation", "*", OPEN),
    // Operator Tokens and audit.
    ("OperatorAccess", "*", ADMIN),
    ("OperatorAccess", "ListAuditEntries", O),
    // Enrollment.
    ("Enrollments", "Enroll", ENROLL),
    ("Enrollments", "WhoAmI", ANY),
    ("Enrollments", "RotateCredential", ANY),
    ("Enrollments", "*", O),
    ("AuthKeys", "*", O),
    ("CredentialDirectory", "*", INTERNAL),
    // Fleet, configuration, recovery.
    ("Operator", "*", O),
    ("Operator", "GetTag", OC),
    ("Operator", "ListTags", OC),
    ("Operator", "GetTask", OC),
    ("Operator", "GetSessionDelivery", OC),
    ("Operator", "ListNativeUsage", OC),
    ("Operator", "ListEvents", OC),
    ("Operator", "CancelTask", OC),
    ("Placement", "*", O),
    ("PolicyCatalog", "*", O),
    ("SurfacePolicyCatalog", "*", O),
    ("ManifestRelationships", "*", O),
    ("Teams", "*", O),
    ("Teams", "GetTeam", OC),
    ("Teams", "ListTeams", OC),
    ("Mailbox", "*", O),
    ("GithubWorkspaces", "*", O),
    ("GithubPublications", "*", O),
    ("WorkspaceVolumes", "*", O),
    ("ArtifactVolumes", "*", O),
    ("ArtifactPublications", "*", O),
    ("Spend", "*", O),
    ("Metrics", "*", O),
    // Conversations and own work.
    ("Conversations", "*", OC),
    ("Objectives", "*", OC),
    ("Objectives", "SetLimits", O),
    ("Objectives", "SetRuntimeActions", O),
    ("ObjectiveOverviews", "*", OC),
    ("OperatorEvents", "*", OC),
    ("LiveInputs", "*", OC),
    ("WorkSessions", "*", OC),
    ("ArtifactCatalog", "*", OC),
    ("ArtifactTransfers", "DownloadFile", OC),
    ("Inbox", "*", OC),
    // Execution.
    ("WorkerHost", "*", HOST),
    ("AttemptInputs", "*", HOST),
    ("AttemptWorkstreams", "*", HOST),
    ("AttemptMailbox", "*", HOST),
    ("AttemptWorkSessions", "*", HOST),
    ("AttemptMcpEffects", "*", HOST),
    ("AttemptChangedPaths", "*", HOST),
    ("AttemptEffects", "*", HOST),
    ("AttemptWorkspaceMounts", "*", HOST),
    ("AttemptArtifacts", "*", HOST),
    ("ArtifactTransfers", "*", HOST),
    ("Transfers", "*", HOST),
    ("Transfers", "DownloadWorkspaceArtifact", OC),
    // Surfaces.
    ("Connector", "*", GATEWAY),
    ("ReplyProgress", "*", GATEWAY),
    ("OperatorNotifications", "*", GATEWAY),
    // The state owner's directories, behind the API tier.
    ("CheckpointDirectory", "*", INTERNAL),
    ("WorkspaceDirectory", "*", INTERNAL),
    ("ArtifactDirectory", "*", INTERNAL),
    ("ArtifactVolumeDirectory", "*", INTERNAL),
    ("GithubPublisher", "*", INTERNAL),
    ("GithubSourceResolver", "*", INTERNAL),
    // Served by a Worker Host to its harness adapters, or by a Gateway to operators.
    ("Harness", "*", PEER_LOCAL),
    ("HarnessArtifacts", "*", PEER_LOCAL),
    ("HarnessEffects", "*", PEER_LOCAL),
    ("HarnessMailbox", "*", PEER_LOCAL),
    ("HarnessMcp", "*", PEER_LOCAL),
    ("HarnessQuestions", "*", PEER_LOCAL),
    ("HarnessWorkSessions", "*", PEER_LOCAL),
    ("HarnessWorkspace", "*", PEER_LOCAL),
    ("HarnessWorkstreams", "*", PEER_LOCAL),
    ("RemoteWorkspaceProvider", "*", PEER_LOCAL),
    ("WorkerArtifactTransfers", "*", PEER_LOCAL),
    ("OperatorNotificationTest", "*", PEER_LOCAL),
];

/// Who may call `service`/`method`; `None` when the table has no entry.
fn access(service: &str, method: &str) -> Option<u16> {
    let exact = TABLE.iter().find(|(s, m, _)| *s == service && *m == method);
    exact
        .or_else(|| TABLE.iter().find(|(s, m, _)| *s == service && *m == "*"))
        .map(|(_, _, access)| *access)
}

/// The roles allowed to call a gRPC path, by name, for diagnostics and documentation.
pub fn allowed_roles(path: &str) -> Vec<&'static str> {
    let Some((service, method)) = path.strip_prefix(PACKAGE).and_then(|p| p.split_once('/')) else {
        return vec![];
    };
    let access = access(service, method).unwrap_or(0);
    [
        (ADMIN, "admin"),
        (OPERATOR, "operator"),
        (GATEWAY, "gateway"),
        (HOST, "host"),
        (CLIENT, "client"),
        (OPEN, "unauthenticated"),
        (ENROLL, "auth-key"),
    ]
    .into_iter()
    .filter(|(bit, _)| access & bit != 0)
    .map(|(_, name)| name)
    .collect()
}

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
            Credential::Admin => unreachable!("the admin token is never resolved"),
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
    let access = path
        .strip_prefix(PACKAGE)
        .and_then(|path| path.split_once('/'))
        .and_then(|(service, method)| access(service, method))
        .unwrap_or(0);
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
    let roles = access & (ADMIN | OPERATOR | GATEWAY | HOST | CLIENT);
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
    use prost::Message as _;

    /// Every RPC in the compiled protocol descriptors has an entry, so no RPC ships unclassified.
    #[test]
    fn every_rpc_in_the_protocol_is_classified() {
        let set = prost_types::FileDescriptorSet::decode(supertag_protocol::FILE_DESCRIPTOR_SET)
            .expect("compiled descriptors");
        let mut missing = vec![];
        let mut methods = 0;
        for file in &set.file {
            for service in &file.service {
                let name = service.name();
                let explicit = TABLE.iter().any(|(s, _, _)| *s == name);
                for method in &service.method {
                    methods += 1;
                    if !explicit || access(name, method.name()).is_none() {
                        missing.push(format!("{name}/{}", method.name()));
                    }
                }
            }
        }
        assert!(methods > 250, "descriptors list too few methods: {methods}");
        assert!(missing.is_empty(), "unclassified RPCs: {missing:?}");
        // No entry names a service the protocol no longer has.
        for (service, method, _) in TABLE {
            let found = set
                .file
                .iter()
                .flat_map(|file| &file.service)
                .find(|s| s.name() == *service);
            let found = found.unwrap_or_else(|| panic!("stale table entry {service}"));
            assert!(
                *method == "*" || found.method.iter().any(|m| m.name() == *method),
                "stale table entry {service}/{method}"
            );
        }
    }

    #[test]
    fn the_table_matches_the_approved_role_matrix() {
        let roles = |path: &str| allowed_roles(&format!("{PACKAGE}{path}"));
        assert_eq!(roles("OperatorAccess/CreateOperatorToken"), ["admin"]);
        assert_eq!(roles("OperatorAccess/ListAuditEntries"), ["operator"]);
        assert_eq!(roles("Operator/PutTag"), ["operator"]);
        assert_eq!(roles("Operator/SubmitTask"), ["operator"]);
        assert_eq!(roles("Operator/ListHosts"), ["operator"]);
        assert_eq!(roles("Operator/GetTag"), ["operator", "client"]);
        assert_eq!(roles("Conversations/SendMessage"), ["operator", "client"]);
        assert_eq!(roles("Objectives/CreateObjective"), ["operator", "client"]);
        assert_eq!(roles("Objectives/SetLimits"), ["operator"]);
        assert_eq!(roles("Inbox/DecideApproval"), ["operator", "client"]);
        assert_eq!(roles("WorkerHost/ClaimTask"), ["host"]);
        assert_eq!(roles("Transfers/UploadCheckpoint"), ["host"]);
        assert_eq!(
            roles("Transfers/DownloadWorkspaceArtifact"),
            ["operator", "client"]
        );
        assert_eq!(roles("Connector/AcceptEvent"), ["gateway"]);
        assert_eq!(roles("OperatorNotifications/Claim"), ["gateway"]);
        assert_eq!(roles("Enrollments/Enroll"), ["auth-key"]);
        assert_eq!(
            roles("Enrollments/RotateCredential"),
            ["operator", "gateway", "host", "client"]
        );
        assert_eq!(roles("Enrollments/RevokeEnrollment"), ["operator"]);
        assert_eq!(roles("ProtocolNegotiation/Negotiate"), ["unauthenticated"]);
        for internal in [
            "CredentialDirectory/Resolve",
            "CheckpointDirectory/GetCheckpoint",
            "GithubPublisher/Claim",
            "Harness/Attach",
            "NoSuchService/Call",
        ] {
            assert!(roles(internal).is_empty(), "{internal}");
        }
    }

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
