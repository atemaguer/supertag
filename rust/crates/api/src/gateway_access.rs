//! Authentication of Gateway calls at the public listener.
//!
//! Gateways call the Connector, reply progress, operator notification and operator directory
//! services with the shared Gateway credential, and name the account or operator they act for in
//! `x-supertag-principal`. That credential can name any principal, so this tier accepts it only
//! from a peer that presented a client certificate the listener verified, or over cleartext, which
//! the Control Plane serves only on loopback. Every other public service refuses it.

use subtle::ConstantTimeEq;
use tonic::{
    Status,
    metadata::{Ascii, MetadataValue},
    transport::server::{TcpConnectInfo, TlsConnectInfo},
};

use crate::AUTHORIZATION;

pub(crate) struct GatewayAccess {
    credential: MetadataValue<Ascii>,
}

impl GatewayAccess {
    pub(crate) fn new(credential: MetadataValue<Ascii>) -> Self {
        Self { credential }
    }

    /// Admits a Gateway call: a verified client certificate when the connection is TLS, and
    /// exactly one bearer credential, the Gateway credential.
    pub(crate) fn authorize(
        &self,
        headers: &http::HeaderMap,
        extensions: &http::Extensions,
    ) -> Result<(), Status> {
        let tls = extensions
            .get::<TlsConnectInfo<TcpConnectInfo>>()
            .map(|tls| tls.peer_certs().is_some_and(|certs| !certs.is_empty()));
        self.admit(tls, headers)
    }

    /// `tls` is `None` for cleartext, otherwise whether the peer presented a verified certificate.
    fn admit(&self, tls: Option<bool>, headers: &http::HeaderMap) -> Result<(), Status> {
        if tls == Some(false) {
            return Err(Status::permission_denied(
                "Gateway calls over TLS require a client certificate",
            ));
        }
        let mut values = headers.get_all(AUTHORIZATION).iter();
        let valid = values.next().is_some_and(|value| {
            bool::from(value.as_bytes().ct_eq(self.credential.as_encoded_bytes()))
        });
        if !valid || values.next().is_some() {
            return Err(Status::unauthenticated("Gateway credential required"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn access() -> GatewayAccess {
        GatewayAccess::new("Bearer gateway-secret".parse().unwrap())
    }

    fn headers(values: &[&str]) -> http::HeaderMap {
        let mut headers = http::HeaderMap::new();
        for value in values {
            headers.append(AUTHORIZATION, value.parse().unwrap());
        }
        headers
    }

    #[test]
    fn cleartext_and_certified_tls_admit_only_the_gateway_credential() {
        let extensions = http::Extensions::new();
        access()
            .authorize(&headers(&["Bearer gateway-secret"]), &extensions)
            .unwrap();
        access()
            .admit(Some(true), &headers(&["Bearer gateway-secret"]))
            .unwrap();
        for presented in [
            &[][..],
            &["Bearer other"][..],
            &["Bearer gateway-secret", "Bearer gateway-secret"][..],
        ] {
            let error = access()
                .authorize(&headers(presented), &extensions)
                .unwrap_err();
            assert_eq!(error.code(), tonic::Code::Unauthenticated);
        }
    }

    #[test]
    fn tls_without_a_client_certificate_refuses_the_gateway_credential() {
        let error = access()
            .admit(Some(false), &headers(&["Bearer gateway-secret"]))
            .unwrap_err();
        assert_eq!(error.code(), tonic::Code::PermissionDenied);
    }
}
