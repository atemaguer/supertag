use subtle::ConstantTimeEq;
use tonic::{Request, Status, metadata::MetadataValue};

pub mod artifacts;
pub mod git_outputs;
pub mod output_policy;
mod workspace_tools;
pub use workspace_tools::{MAX_WORKSPACE_TOOL_OUTPUT_BYTES, validate_workspace_operation};
pub mod mcp;
pub mod shared_execution;

pub mod v2 {
    tonic::include_proto!("supertag.runtime.v2");
}

pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
pub const MAX_CHECKPOINT_BYTES: usize = 16 * 1024 * 1024;
pub const CHECKPOINT_CHUNK_BYTES: usize = 256 * 1024;
pub const HOST_GENERATION_HEADER: &str = "x-supertag-host-generation";
pub const PRINCIPAL_HEADER: &str = "x-supertag-principal";

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
            PRINCIPAL_HEADER,
            principal
                .parse()
                .map_err(|_| Status::internal("invalid service principal configuration"))?,
        );
    }
    Ok(request)
}

pub fn incoming_principal<'a, T>(
    request: &'a Request<T>,
    gateway_token: &str,
) -> Result<&'a str, Status> {
    if !matches_bearer(request, gateway_token) {
        return Err(Status::unauthenticated("Gateway credential required"));
    }
    request
        .metadata()
        .get(PRINCIPAL_HEADER)
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

pub fn valid_git_commit(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
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
