use super::*;
use std::future;
use tonic::{Code, transport::Endpoint};

fn gateway() -> Gateway {
    Gateway::new(
        Endpoint::from_static("http://127.0.0.1:1").connect_lazy(),
        "gateway-test-token".into(),
        "operator-test-token".into(),
        "operator:alice".into(),
        "host-test-token".into(),
        "host:local".into(),
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
