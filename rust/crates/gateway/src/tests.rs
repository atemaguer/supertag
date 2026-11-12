use super::*;
use std::future;
use supertag_protocol::v2::host_directory_server::{HostDirectory, HostDirectoryServer};
use tonic::{
    Code,
    transport::{Endpoint, Server, server::TcpIncoming},
};

fn gateway() -> Gateway {
    Gateway::new(
        Endpoint::from_static("http://127.0.0.1:1").connect_lazy(),
        "gateway-test-token".into(),
        "operator-test-token".into(),
        "operator:alice".into(),
    )
    .unwrap()
}

fn operator_request() -> Request<&'static str> {
    let mut request = Request::new("payload");
    request.metadata_mut().insert(
        AUTHORIZATION,
        MetadataValue::from_static("Bearer operator-test-token"),
    );
    request
}

#[tokio::test]
async fn strips_public_metadata_and_supplies_bound_private_identity() {
    let gateway = gateway();
    let mut request = operator_request();
    request.metadata_mut().insert(
        PRINCIPAL,
        MetadataValue::from_static("operator:administrator"),
    );
    request
        .metadata_mut()
        .insert("x-local-admin", MetadataValue::from_static("true"));
    request.extensions_mut().insert("caller extension");

    let response = gateway
        .forward(
            request,
            &gateway.credentials.operator,
            |_, upstream| async {
                let credential = upstream.metadata().get(AUTHORIZATION).unwrap();
                assert_eq!(credential, "Bearer gateway-test-token");
                assert!(credential.is_sensitive());
                assert_eq!(
                    upstream.metadata().get(PRINCIPAL).unwrap(),
                    "operator:alice"
                );
                assert!(!upstream.metadata().contains_key("x-local-admin"));
                assert!(upstream.extensions().get::<&'static str>().is_none());
                Ok(Response::new(upstream.into_inner()))
            },
        )
        .await
        .unwrap();
    assert_eq!(response.into_inner(), "payload");
}

#[tokio::test]
async fn rejects_other_roles_private_credentials_and_duplicate_credentials() {
    let gateway = gateway();
    for credential in [
        None,
        Some("Bearer operator-test-token"),
        Some("Bearer gateway-test-token"),
    ] {
        let mut request = Request::new(ClaimTaskRequest::default());
        if let Some(credential) = credential {
            request
                .metadata_mut()
                .insert(AUTHORIZATION, MetadataValue::from_static(credential));
        }
        let status = gateway.claim_task(request).await.unwrap_err();
        assert_eq!(status.code(), Code::Unauthenticated);
    }

    let mut request = Request::new(GetTaskRequest::default());
    request.metadata_mut().insert(
        AUTHORIZATION,
        MetadataValue::from_static("Bearer host-test-token"),
    );
    let status = gateway.get_task(request).await.unwrap_err();
    assert_eq!(status.code(), Code::Unauthenticated);

    let mut request = operator_request().map(|_| GetTaskRequest::default());
    request.metadata_mut().append(
        AUTHORIZATION,
        MetadataValue::from_static("Bearer operator-test-token"),
    );
    let status = gateway.get_task(request).await.unwrap_err();
    assert_eq!(status.code(), Code::Unauthenticated);
}

#[tokio::test]
async fn propagates_shorter_deadlines_caps_longer_ones_and_rejects_malformed_timeouts() {
    let gateway = gateway();
    for (timeout, expected) in [("250m", Duration::from_millis(250)), ("2H", CALL_TIMEOUT)] {
        let mut request = operator_request();
        request
            .metadata_mut()
            .insert(TIMEOUT, MetadataValue::from_static(timeout));
        let (upstream, budget) = gateway
            .credentials
            .forwarded(request, &gateway.credentials.operator)
            .unwrap();
        assert_eq!(budget, expected);
        assert_eq!(client_timeout(&upstream).unwrap(), expected);
    }

    for timeout in ["0S", "bogus", "123456789n"] {
        let mut request = operator_request();
        request
            .metadata_mut()
            .insert(TIMEOUT, MetadataValue::from_static(timeout));
        let status = gateway
            .credentials
            .forwarded(request, &gateway.credentials.operator)
            .unwrap_err();
        let expected = if timeout == "0S" {
            Code::DeadlineExceeded
        } else {
            Code::InvalidArgument
        };
        assert_eq!(status.code(), expected);
    }
}

#[tokio::test]
async fn bounds_an_upstream_call_that_never_completes() {
    let gateway = gateway();
    let mut request = operator_request();
    request.set_timeout(Duration::from_millis(1));
    let status = gateway
        .forward(request, &gateway.credentials.operator, |_, _| {
            future::pending::<Result<Response<()>, Status>>()
        })
        .await
        .unwrap_err();
    assert_eq!(status.code(), Code::DeadlineExceeded);
}

struct Directory;

fn assert_private_request<T>(request: &Request<T>) {
    assert_eq!(
        request.metadata().get(AUTHORIZATION).unwrap(),
        "Bearer gateway-test-token"
    );
    assert_eq!(
        request.metadata().get(PRINCIPAL).unwrap(),
        "service:gateway"
    );
    assert!(!request.metadata().contains_key(HOST_GENERATION_HEADER));
    assert!(!request.metadata().contains_key("x-forged"));
}

#[tonic::async_trait]
impl HostDirectory for Directory {
    async fn authenticate(
        &self,
        request: Request<AuthenticateHostRequest>,
    ) -> Result<Response<HostRecord>, Status> {
        assert_private_request(&request);
        if request.into_inner().token_digest != Sha256::digest("enrolled-test-token").to_vec() {
            return Err(Status::permission_denied("unknown credential"));
        }
        Ok(Response::new(HostRecord {
            host_id: "verified".into(),
            generation: 3,
            revoked: false,
        }))
    }

    async fn enroll(
        &self,
        request: Request<PrivateEnrollHostRequest>,
    ) -> Result<Response<HostRecord>, Status> {
        assert_private_request(&request);
        let body = request.into_inner();
        assert_eq!(
            body.key_digest,
            Sha256::digest("one-time-join-key").to_vec()
        );
        assert_eq!(body.enrollment.unwrap().host_id, "join-target");
        Ok(Response::new(HostRecord {
            host_id: "join-target".into(),
            generation: 0,
            revoked: false,
        }))
    }
}

fn forged_request<T>(body: T, bearer: &'static str, generation: u64) -> Request<T> {
    let mut request = Request::new(body);
    let metadata = request.metadata_mut();
    metadata.insert(AUTHORIZATION, MetadataValue::from_static(bearer));
    metadata.insert(PRINCIPAL, MetadataValue::from_static("host:forged"));
    metadata.insert("x-forged", MetadataValue::from_static("true"));
    metadata.insert(HOST_GENERATION_HEADER, generation.into());
    request
}

#[tokio::test]
async fn routes_only_authenticated_worker_generations_and_hashes_enrollment_keys()
-> anyhow::Result<()> {
    let incoming = TcpIncoming::bind("127.0.0.1:0".parse()?)?;
    let address = incoming.local_addr()?;
    let server = tokio::spawn(
        Server::builder()
            .add_service(HostDirectoryServer::new(Directory))
            .serve_with_incoming(incoming),
    );
    let channel = Endpoint::from_shared(format!("http://{address}"))?.connect_lazy();
    let gateway = Gateway::new(
        channel,
        "gateway-test-token".into(),
        "operator-test-token".into(),
        "operator:alice".into(),
    )?;

    let request = forged_request("payload", "Bearer enrolled-test-token", 3);
    let result = gateway
        .forward_host(request, true, |_, request| async move {
            assert_eq!(
                request.metadata().get(AUTHORIZATION).unwrap(),
                "Bearer gateway-test-token"
            );
            assert_eq!(request.metadata().get(PRINCIPAL).unwrap(), "host:verified");
            assert_eq!(host_generation(&request)?, 3);
            assert!(!request.metadata().contains_key("x-forged"));
            Ok(Response::new(request.into_inner()))
        })
        .await?;
    assert_eq!(result.into_inner(), "payload");

    let stale = forged_request((), "Bearer enrolled-test-token", 2);
    let result = gateway
        .forward_host(stale, true, |_, _| async { Ok(Response::new(())) })
        .await;
    assert_eq!(result.unwrap_err().code(), Code::PermissionDenied);

    let mut duplicate = forged_request((), "Bearer enrolled-test-token", 3);
    duplicate
        .metadata_mut()
        .append(HOST_GENERATION_HEADER, 3_u64.into());
    assert_eq!(
        host_generation(&duplicate).unwrap_err().code(),
        Code::PermissionDenied
    );

    let enrollment = forged_request(
        EnrollHostRequest {
            host_id: "join-target".into(),
            ..Default::default()
        },
        "Bearer one-time-join-key",
        30,
    );
    assert_eq!(
        gateway.enroll_host(enrollment).await?.into_inner().host_id,
        "join-target"
    );
    server.abort();
    Ok(())
}
