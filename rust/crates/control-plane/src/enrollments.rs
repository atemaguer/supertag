//! Enrollment and enrolled credentials, behind the API tier. The API tier authenticates the caller
//! and, for `Enroll`, passes the SHA-256 of the presented Auth Key as the internal principal
//! `auth-key-digest:HEX`.

use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};

use crate::{AuditChange, AuditChanges, ControlPlane, operator_access::is_admin};

impl ControlPlane {
    pub fn enrollments_service(&self) -> enrollments_server::EnrollmentsServer<Self> {
        enrollments_server::EnrollmentsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    /// Any authenticated principal.
    fn caller<T>(&self, request: &Request<T>) -> Result<String, Status> {
        let principal = supertag_protocol::internal_principal(request, &self.internal_token)?;
        let known = ["operator:", "host:", "gateway:", "client:"]
            .iter()
            .any(|prefix| {
                principal
                    .strip_prefix(prefix)
                    .is_some_and(|id| !id.is_empty())
            });
        if !known || principal.len() > 256 {
            return Err(Status::permission_denied(
                "caller is not allowed to use this service",
            ));
        }
        Ok(principal.to_owned())
    }
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    (value.len() == 64)
        .then(|| {
            (0..32)
                .map(|index| u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).ok())
                .collect()
        })
        .flatten()
}

#[tonic::async_trait]
impl enrollments_server::Enrollments for ControlPlane {
    async fn enroll(
        &self,
        request: Request<EnrollRequest>,
    ) -> Result<Response<Enrollment>, Status> {
        let principal = self.principal(&request, "auth-key-digest:")?;
        let digest = decode_hex(&principal["auth-key-digest:".len()..])
            .ok_or_else(|| Status::permission_denied("invalid Auth Key"))?;
        // Every refusal of a key or a replay is the same, so it reveals nothing about the key.
        match self.store.enroll(&digest, request.get_ref()).await {
            Ok(enrollment) => Ok(Response::new(enrollment)),
            Err(crate::StoreError::PermissionDenied) => Err(Status::permission_denied(
                "the Auth Key does not admit this enrollment",
            )),
            Err(error) => Err(error.into()),
        }
    }

    async fn who_am_i(
        &self,
        request: Request<WhoAmIRequest>,
    ) -> Result<Response<WhoAmIResponse>, Status> {
        let principal = self.caller(&request)?;
        let role = match principal.split_once(':').map(|(role, _)| role) {
            Some("operator") => PrincipalRole::Operator,
            Some("host") => PrincipalRole::Host,
            Some("gateway") => PrincipalRole::Gateway,
            _ => PrincipalRole::Client,
        };
        Ok(Response::new(WhoAmIResponse {
            role: role.into(),
            admin: is_admin(&principal),
            principal,
        }))
    }

    async fn rotate_credential(
        &self,
        request: Request<RotateCredentialRequest>,
    ) -> Result<Response<CredentialRotation>, Status> {
        let principal = self.caller(&request)?;
        let rotation = self
            .store
            .rotate_credential(&principal, request.get_ref())
            .await?;
        // A self-rotation names no one in its request; record the enrollee it rotated.
        let target = rotation.principal.split_once(':').and_then(|(role, name)| {
            let kind = match role {
                "host" => "WorkerHost",
                "gateway" => "Gateway",
                _ => "Client",
            };
            (!name.is_empty()).then(|| format!("{kind}/{name}"))
        });
        let mut response = Response::new(rotation);
        if let Some(target) = target {
            response
                .extensions_mut()
                .insert(AuditChanges(vec![AuditChange {
                    action: "credential.rotate".into(),
                    target,
                }]));
        }
        Ok(response)
    }

    async fn get_enrollment(
        &self,
        request: Request<GetEnrollmentRequest>,
    ) -> Result<Response<Enrollment>, Status> {
        let principal = self.principal(&request, "operator:")?;
        let input = request.into_inner();
        Ok(Response::new(
            self.store
                .get_enrollment(&principal, input.role, &input.name)
                .await?,
        ))
    }

    async fn list_enrollments(
        &self,
        request: Request<ListEnrollmentsRequest>,
    ) -> Result<Response<ListEnrollmentsResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_enrollments(&principal, request.get_ref())
                .await?,
        ))
    }

    async fn revoke_enrollment(
        &self,
        request: Request<RevokeEnrollmentRequest>,
    ) -> Result<Response<Enrollment>, Status> {
        let principal = self.principal(&request, "operator:")?;
        let input = request.into_inner();
        Ok(Response::new(
            self.store
                .revoke_enrollment(&principal, input.role, &input.name)
                .await?,
        ))
    }
}
