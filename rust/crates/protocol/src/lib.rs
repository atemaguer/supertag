pub mod volumes;
pub mod workspace_mounts;
use subtle::ConstantTimeEq;
use tonic::{Request, Status, metadata::MetadataValue};

pub mod artifacts;
pub mod changed_paths;
mod crash_points;
#[cfg(feature = "crash-points")]
pub use crash_points::crash_now;
pub use crash_points::{CRASH_MARKER_ENV, CRASH_POINT_ENV, crash_point};
pub mod git_outputs;
pub mod output_policy;
pub mod task_artifact_inputs;
pub mod terminal_text;
mod workspace_tools;
pub use workspace_tools::{MAX_WORKSPACE_TOOL_OUTPUT_BYTES, validate_workspace_operation};
pub mod mcp;
pub mod negotiation;
pub mod redaction;
pub mod shared_execution;

pub mod v2 {
    tonic::include_proto!("supertag.runtime.v2");
}

/// The encoded `FileDescriptorSet` of every runtime proto, for checks that must cover each RPC.
pub const FILE_DESCRIPTOR_SET: &[u8] =
    include_bytes!(concat!(env!("OUT_DIR"), "/supertag_descriptors.bin"));

pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
pub const MAX_CHECKPOINT_BYTES: usize = 16 * 1024 * 1024;
pub const CHECKPOINT_CHUNK_BYTES: usize = 256 * 1024;
pub const HOST_GENERATION_HEADER: &str = "x-supertag-host-generation";
/// The principal a call acts as, from the Control Plane's API tier to its state owner only. The
/// state owner has no network listener, and the API tier never forwards this header from a caller.
pub const INTERNAL_PRINCIPAL_HEADER: &str = "x-supertag-internal-principal";
/// The connector account a Gateway call acts for. It selects, and never grants: the Control Plane
/// refuses an account that is not bound to the calling Gateway.
pub const CONNECTOR_ACCOUNT_HEADER: &str = "x-supertag-connector-account";
/// Every Operator Token secret starts with this prefix.
pub const OPERATOR_TOKEN_SECRET_PREFIX: &str = "stop_";
/// Every Auth Key secret starts with this prefix.
pub const AUTH_KEY_SECRET_PREFIX: &str = "stak_";
/// Every enrolled credential (host, Gateway or client) starts with this prefix.
pub const CREDENTIAL_SECRET_PREFIX: &str = "stcr_";

/// True when the text is `prefix` and 64 lowercase hex digits.
pub fn is_secret(prefix: &str, value: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|rest| {
        rest.len() == 64
            && rest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    })
}

/// True when the text has the shape of an Operator Token secret: `stop_` and 64 lowercase hex.
pub fn is_operator_token_secret(value: &str) -> bool {
    is_secret(OPERATOR_TOKEN_SECRET_PREFIX, value)
}

/// A new random secret: `prefix` and 64 lowercase hex digits.
pub fn new_secret(prefix: &str) -> String {
    format!(
        "{prefix}{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

pub fn host_generation<T>(request: &Request<T>) -> Result<u64, Status> {
    let mut values = request.metadata().get_all(HOST_GENERATION_HEADER).iter();
    let value = values
        .next()
        .and_then(|value| value.to_str().ok())
        .and_then(|text| {
            text.parse::<u64>()
                .ok()
                .filter(|n| *n > 0 && n.to_string() == text)
        })
        .filter(|_| values.next().is_none())
        .ok_or_else(|| Status::permission_denied("Worker Host registration required"))?;
    Ok(value)
}

/// A call that failed in the local transport (reset, broken pipe, failed handshake,
/// HTTP/2 connection error) rather than with a status from the peer. Tonic reports
/// these as `Unknown` or `Internal` with the local error attached, sometimes behind
/// its channel buffer. A status decoded from a peer never carries a source. Like
/// `Unavailable`, the outcome is unknown and an idempotent call may be retried.
pub fn local_transport_failure(status: &Status) -> bool {
    matches!(status.code(), tonic::Code::Unknown | tonic::Code::Internal)
        && std::error::Error::source(status).is_some()
}

pub fn matches_bearer<T>(request: &Request<T>, token: &str) -> bool {
    let candidate = request
        .metadata()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    candidate.is_some_and(|candidate| {
        !token.is_empty() && bool::from(candidate.as_bytes().ct_eq(token.as_bytes()))
    })
}

/// Report an interrupted upstream connection as `Unavailable`, so a downstream
/// client applies its existing retry rules instead of failing permanently. The
/// local cause does not cross the wire, so a forwarded `Unknown` would otherwise
/// look like a definitive answer from the peer; this includes a connection that
/// broke while a response body was being read, such as a dropped WebSocket tunnel.
pub fn upstream_status(status: Status) -> Status {
    if local_transport_failure(&status) {
        Status::unavailable("upstream connection was interrupted")
    } else {
        status
    }
}

/// A request that presents `token` as its bearer credential. `principal` is set only on the
/// Control Plane's internal hop from its API tier to its state owner.
pub fn authenticated_request<T>(
    message: T,
    token: &str,
    principal: Option<&str>,
) -> Result<Request<T>, Status> {
    let mut request = Request::new(message);
    let mut header: MetadataValue<_> = format!("Bearer {token}")
        .parse()
        .map_err(|_| Status::internal("invalid service credential configuration"))?;
    header.set_sensitive(true);
    request.metadata_mut().insert("authorization", header);
    if let Some(principal) = principal {
        request.metadata_mut().insert(
            INTERNAL_PRINCIPAL_HEADER,
            principal
                .parse()
                .map_err(|_| Status::internal("invalid service principal configuration"))?,
        );
    }
    Ok(request)
}

/// A Gateway call for one connector account, with the Gateway's enrolled credential.
pub fn connector_request<T>(
    message: T,
    credential: &str,
    account: &str,
) -> Result<Request<T>, Status> {
    let mut request = authenticated_request(message, credential, None)?;
    request.metadata_mut().insert(
        CONNECTOR_ACCOUNT_HEADER,
        account
            .parse()
            .map_err(|_| Status::internal("invalid connector account"))?,
    );
    Ok(request)
}

/// The principal named on the internal hop from the API tier, which presents `internal_token`.
pub fn internal_principal<'a, T>(
    request: &'a Request<T>,
    internal_token: &str,
) -> Result<&'a str, Status> {
    if !matches_bearer(request, internal_token) {
        return Err(Status::unauthenticated(
            "Control Plane API tier credential required",
        ));
    }
    request
        .metadata()
        .get(INTERNAL_PRINCIPAL_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Status::permission_denied("authenticated caller identity required"))
}

pub fn validate_checkpoint_reference(reference: &v2::CheckpointReference) -> Result<(), Status> {
    let name = |value: &str| {
        !value.is_empty()
            && value.len() <= 80
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_'))
    };
    if !name(&reference.harness)
        || !name(&reference.format)
        || reference.byte_length == 0
        || reference.byte_length > MAX_CHECKPOINT_BYTES as u64
        || !valid_sha256(&reference.sha256)
    {
        return Err(Status::invalid_argument("invalid checkpoint reference"));
    }
    Ok(())
}

pub fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

impl v2::SessionCheckpoint {
    pub fn reference(&self) -> v2::CheckpointReference {
        v2::CheckpointReference {
            harness: self.harness.clone(),
            format: self.format.clone(),
            byte_length: self.payload.len() as u64,
            sha256: self.sha256.clone(),
        }
    }
}

pub const MAX_WORKSPACE_BLOB_BYTES: usize = 256 * 1024 * 1024;

pub fn valid_workspace_id(value: &str) -> bool {
    value.len() <= 80
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

/// The one branch a Tag's Session delivers to: `supertag/session/<id>`, where `<id>` is the
/// SHA-256 of the Tag and Session IDs. A pull request and a local import use the same name, and
/// two Sessions, even of different Tags with the same Session ID, never share it.
pub fn session_branch(tag_id: &str, session_id: &str) -> String {
    use sha2::Digest as _;
    format!(
        "supertag/session/{:x}",
        sha2::Sha256::digest(
            serde_json::to_vec(&(tag_id, session_id)).expect("string pairs serialize")
        )
    )
}

pub fn valid_git_commit(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

/// A short branch name a Tag's Workspace may follow, such as `main` or `release/1.2`: what
/// `git check-ref-format --branch` accepts, without a `refs/` prefix, at most 200 bytes, and never
/// a full commit (a commit is pinned with `base_commit` instead).
pub fn valid_git_branch(value: &str) -> bool {
    let components_valid = value.split('/').all(|component| {
        !component.is_empty() && !component.starts_with('.') && !component.ends_with(".lock")
    });
    !value.is_empty()
        && value.len() <= 200
        && components_valid
        && !value.starts_with('-')
        && !value.starts_with("refs/")
        && !value.ends_with('.')
        && value != "@"
        && !value.contains("..")
        && !value.contains("@{")
        && !valid_git_commit(value)
        && value.bytes().all(|byte| {
            byte > b' '
                && byte != 0x7f
                && !matches!(byte, b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\')
        })
}

pub fn validate_workspace_delivery(
    reference: &v2::WorkspaceDeliveryReference,
) -> Result<(), Status> {
    let blob = |value: &v2::BlobReference| {
        valid_sha256(&value.sha256) && value.byte_length <= MAX_WORKSPACE_BLOB_BYTES as u64
    };
    if !valid_workspace_id(&reference.workspace_id)
        || !valid_sha256(&reference.delivery_id)
        || ![
            &reference.base_commit,
            &reference.start_commit,
            &reference.head_commit,
        ]
        .iter()
        .all(|pin| pin.len() == reference.base_commit.len() && valid_git_commit(pin))
        || reference.committed != (reference.start_commit != reference.head_commit)
        || reference.committed != (reference.changed_files > 0)
        || reference
            .patch
            .as_ref()
            .is_none_or(|value| !blob(value) || reference.committed != (value.byte_length > 0))
        || reference
            .bundle
            .as_ref()
            .is_none_or(|value| !blob(value) || value.byte_length == 0)
    {
        return Err(Status::invalid_argument(
            "invalid workspace delivery reference",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod git_branch_tests {
    use super::valid_git_branch;

    #[test]
    fn accepts_branch_names_and_refuses_refs_commits_and_invalid_names() {
        for valid in ["main", "release/1.2", "feature-x", "a_b", "v1.0"] {
            assert!(valid_git_branch(valid), "{valid}");
        }
        for invalid in [
            "",
            "-main",
            "refs/heads/main",
            "main.",
            "main.lock",
            "a//b",
            "/main",
            "main/",
            ".hidden",
            "a/.b",
            "a..b",
            "a@{1}",
            "@",
            "a b",
            "a~1",
            "a^",
            "a:b",
            "a?",
            "a*",
            "a[b",
            "a\\b",
            "0123456789abcdef0123456789abcdef01234567",
        ] {
            assert!(!valid_git_branch(invalid), "{invalid:?}");
        }
        assert!(!valid_git_branch(&"a".repeat(201)));
    }
}
