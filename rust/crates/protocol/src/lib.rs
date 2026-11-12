use subtle::ConstantTimeEq;
use tonic::{Request, Status, metadata::MetadataValue};

pub mod v2 {
    tonic::include_proto!("supertag.runtime.v2");
}

pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
pub const PRINCIPAL_HEADER: &str = "x-supertag-principal";

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
