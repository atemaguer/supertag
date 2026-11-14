//! The public enrollment API. `Enroll` is presented with an Auth Key, which the authorization
//! layer turns into its digest; every other method with the caller's own credential.

use super::*;
use crate::authorize::AuthKeyDigest;
use supertag_protocol::v2::{
    enrollments_client::EnrollmentsClient,
    enrollments_server::{Enrollments, EnrollmentsServer},
};

fn client(channel: ProtocolChannel) -> EnrollmentsClient<ProtocolChannel> {
    EnrollmentsClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

impl Api {
    pub fn enrollments_service(&self) -> EnrollmentsServer<Self> {
        EnrollmentsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl Enrollments for Api {
    async fn enroll(
        &self,
        request: Request<EnrollRequest>,
    ) -> Result<Response<Enrollment>, Status> {
        let digest = request
            .extensions()
            .get::<AuthKeyDigest>()
            .ok_or_else(|| Status::unauthenticated("an Auth Key is required to enroll"))?
            .0
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let timeout = request_budget(&request)?;
        let identity = format!("auth-key-digest:{digest}")
            .parse()
            .map_err(|_| Status::internal("invalid Auth Key digest"))?;
        let upstream = self
            .credentials
            .upstream(request.into_inner(), identity, timeout);
        tokio::time::timeout(timeout, client(self.control_plane.clone()).enroll(upstream))
            .await
            .map_err(|_| Status::deadline_exceeded("Control Plane request timed out"))?
            .map_err(supertag_protocol::upstream_status)
    }

    async fn who_am_i(
        &self,
        request: Request<WhoAmIRequest>,
    ) -> Result<Response<WhoAmIResponse>, Status> {
        let caller = self.caller(&request).await?;
        Ok(Response::new(WhoAmIResponse {
            role: caller.role.proto().into(),
            principal: caller.principal,
            admin: caller.admin,
        }))
    }

    async fn rotate_credential(
        &self,
        request: Request<RotateCredentialRequest>,
    ) -> Result<Response<CredentialRotation>, Status> {
        self.forward(request, |channel, request| async move {
            client(channel).rotate_credential(request).await
        })
        .await
    }

    async fn get_enrollment(
        &self,
        request: Request<GetEnrollmentRequest>,
    ) -> Result<Response<Enrollment>, Status> {
        self.forward(request, |channel, request| async move {
            client(channel).get_enrollment(request).await
        })
        .await
    }

    async fn list_enrollments(
        &self,
        request: Request<ListEnrollmentsRequest>,
    ) -> Result<Response<ListEnrollmentsResponse>, Status> {
        self.forward(request, |channel, request| async move {
            client(channel).list_enrollments(request).await
        })
        .await
    }

    async fn revoke_enrollment(
        &self,
        request: Request<RevokeEnrollmentRequest>,
    ) -> Result<Response<Enrollment>, Status> {
        self.forward(request, |channel, request| async move {
            client(channel).revoke_enrollment(request).await
        })
        .await
    }
}
