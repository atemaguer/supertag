use super::*;
use sha2::{Digest, Sha256};
use std::future;
use supertag_protocol::v2::credential_directory_server::{
    CredentialDirectory, CredentialDirectoryServer,
};
use tonic::{
    Code,
    metadata::MetadataMap,
    transport::{Endpoint, Server, server::TcpIncoming},
};

const HOST: &str = "stcr_1111111111111111111111111111111111111111111111111111111111111111";
const CLIENT: &str = "stcr_2222222222222222222222222222222222222222222222222222222222222222";
const GATEWAY: &str = "stcr_3333333333333333333333333333333333333333333333333333333333333333";
const TOKEN: &str = "stop_4444444444444444444444444444444444444444444444444444444444444444";
const KEY: &str = "stak_5555555555555555555555555555555555555555555555555555555555555555";
const REVOKED: &str = "stcr_6666666666666666666666666666666666666666666666666666666666666666";

fn api_at(channel: tonic::transport::Channel) -> Api {
    Api::new(
        supertag_protocol::negotiation::bind_current(channel),
        "service-test-token".into(),
        "operator-test-token".into(),
        "operator:alice".into(),
    )
    .unwrap()
}

fn api() -> Api {
    api_at(Endpoint::from_static("http://127.0.0.1:1").connect_lazy())
}

fn operator_request() -> Request<&'static str> {
    let mut request = Request::new("payload");
    request.metadata_mut().insert(
        AUTHORIZATION,
        MetadataValue::from_static("Bearer operator-test-token"),
    );
    request
}

fn bearer(secret: &str) -> MetadataMap {
    let mut metadata = MetadataMap::new();
    metadata.insert(AUTHORIZATION, format!("Bearer {secret}").parse().unwrap());
    metadata
}

/// The state owner's credential directory as the API tier sees it.
struct Directory;

#[tonic::async_trait]
impl CredentialDirectory for Directory {
    async fn resolve(
        &self,
        request: Request<ResolveCredentialRequest>,
    ) -> Result<Response<ResolvedCredential>, Status> {
        assert_eq!(
            request.metadata().get(AUTHORIZATION).unwrap(),
            "Bearer service-test-token"
        );
        assert_eq!(
            request.metadata().get(PRINCIPAL).unwrap(),
            "control-plane:api"
        );
        let input = request.into_inner();
        let digest = |secret: &str| Sha256::digest(secret).to_vec();
        let resolved = |role: PrincipalRole, name: &str, generation| ResolvedCredential {
            role: role.into(),
            name: name.into(),
            generation,
        };
        let found = if input.kind == PrincipalRole::Operator as i32 {
            (input.token_digest == digest(TOKEN))
                .then(|| resolved(PrincipalRole::Operator, "token:laptop", 0))
        } else if input.token_digest == digest(HOST) {
            Some(resolved(PrincipalRole::Host, "verified", 3))
        } else if input.token_digest == digest(CLIENT) {
            Some(resolved(PrincipalRole::Client, "alice-laptop", 0))
        } else if input.token_digest == digest(GATEWAY) {
            Some(resolved(PrincipalRole::Gateway, "edge", 0))
        } else {
            None
        };
        found
            .map(Response::new)
            .ok_or_else(|| Status::unauthenticated("valid bearer credential required"))
    }
}

async fn with_directory() -> anyhow::Result<(Api, tokio::task::JoinHandle<()>)> {
    let incoming = TcpIncoming::bind("127.0.0.1:0".parse()?)?;
    let address = incoming.local_addr()?;
    let server = tokio::spawn(async move {
        Server::builder()
            .add_service(CredentialDirectoryServer::new(Directory))
            .serve_with_incoming(incoming)
            .await
            .unwrap();
    });
    let channel = Endpoint::from_shared(format!("http://{address}"))?.connect_lazy();
    Ok((api_at(channel), server))
}

#[tokio::test]
async fn strips_public_metadata_and_supplies_the_authenticated_principal() {
    let api = api();
    let mut request = operator_request();
    request.metadata_mut().insert(
        PRINCIPAL,
        MetadataValue::from_static("operator:administrator"),
    );
    request
        .metadata_mut()
        .insert("x-local-admin", MetadataValue::from_static("true"));
    request.extensions_mut().insert("caller extension");

    let response = api
        .forward(request, |_, upstream| async {
            let credential = upstream.metadata().get(AUTHORIZATION).unwrap();
            assert_eq!(credential, "Bearer service-test-token");
            assert!(credential.is_sensitive());
            assert_eq!(
                upstream.metadata().get(PRINCIPAL).unwrap(),
                "operator:alice"
            );
            assert!(!upstream.metadata().contains_key("x-local-admin"));
            assert!(upstream.extensions().get::<&'static str>().is_none());
            Ok(Response::new(upstream.into_inner()))
        })
        .await
        .unwrap();
    assert_eq!(response.into_inner(), "payload");
}

#[tokio::test]
async fn refuses_missing_duplicate_misplaced_and_unknown_credentials() {
    let api = api();
    let mut duplicate = bearer("operator-test-token");
    duplicate.append(
        AUTHORIZATION,
        MetadataValue::from_static("Bearer operator-test-token"),
    );
    for metadata in [
        MetadataMap::new(),
        duplicate,
        // The internal credential is never a caller's.
        bearer("service-test-token"),
        // An Auth Key only enrolls.
        bearer(KEY),
        bearer("stop_short"),
        bearer("bare-hex-or-anything-else"),
    ] {
        assert_eq!(
            api.authenticate(&metadata).await.unwrap_err().code(),
            Code::Unauthenticated
        );
    }
    let admin = api
        .authenticate(&bearer("operator-test-token"))
        .await
        .unwrap();
    assert_eq!(
        (admin.role, admin.principal.as_str(), admin.admin),
        (Role::Operator, "operator:alice", true)
    );
}

#[tokio::test]
async fn resolves_each_credential_kind_to_its_principal() -> anyhow::Result<()> {
    let (api, server) = with_directory().await?;
    for (secret, role, principal, generation) in [
        (TOKEN, Role::Operator, "operator:token:laptop", 0),
        (HOST, Role::Host, "host:verified", 3),
        (CLIENT, Role::Client, "client:alice-laptop", 0),
        (GATEWAY, Role::Gateway, "gateway:edge", 0),
    ] {
        let caller = api.authenticate(&bearer(secret)).await?;
        assert_eq!(
            (
                caller.role,
                caller.principal.as_str(),
                caller.generation,
                caller.admin
            ),
            (role, principal, generation, false)
        );
        api.recheck(&caller).await?;
    }
    assert_eq!(
        api.authenticate(&bearer(REVOKED)).await.unwrap_err().code(),
        Code::Unauthenticated
    );
    server.abort();
    Ok(())
}

#[tokio::test]
async fn routes_only_current_host_generations() -> anyhow::Result<()> {
    let (api, server) = with_directory().await?;
    let host = |generation: u64, secret: &str| {
        let mut request = Request::new("payload");
        *request.metadata_mut() = bearer(secret);
        request
            .metadata_mut()
            .insert(PRINCIPAL, MetadataValue::from_static("host:forged"));
        request
            .metadata_mut()
            .insert(HOST_GENERATION_HEADER, generation.into());
        request
    };
    let result = api
        .forward_host(host(3, HOST), true, |_, request| async move {
            assert_eq!(
                request.metadata().get(AUTHORIZATION).unwrap(),
                "Bearer service-test-token"
            );
            assert_eq!(request.metadata().get(PRINCIPAL).unwrap(), "host:verified");
            assert_eq!(host_generation(&request)?, 3);
            Ok(Response::new(request.into_inner()))
        })
        .await?;
    assert_eq!(result.into_inner(), "payload");
    for refused in [host(2, HOST), host(3, CLIENT), host(3, GATEWAY)] {
        let status = api
            .forward_host(refused, true, |_, _| async { Ok(Response::new(())) })
            .await
            .unwrap_err();
        assert_eq!(status.code(), Code::PermissionDenied);
    }
    server.abort();
    Ok(())
}

#[tokio::test]
async fn the_authorization_layer_admits_each_role_only_where_the_table_allows() -> anyhow::Result<()>
{
    let (api, server) = with_directory().await?;
    let path = |service: &str, method: &str| format!("/supertag.runtime.v2.{service}/{method}");
    let cases = [
        ("Operator", "PutTag", "operator-test-token", true),
        ("Operator", "PutTag", TOKEN, true),
        ("Operator", "PutTag", CLIENT, false),
        ("Operator", "PutTag", HOST, false),
        ("Operator", "PutTag", GATEWAY, false),
        (
            "OperatorAccess",
            "CreateOperatorToken",
            "operator-test-token",
            true,
        ),
        ("OperatorAccess", "CreateOperatorToken", TOKEN, false),
        ("OperatorAccess", "CreateOperatorToken", CLIENT, false),
        ("Operator", "CreateAuthKey", CLIENT, false),
        ("Operator", "SubmitTask", CLIENT, false),
        ("Operator", "ListHosts", CLIENT, false),
        ("Conversations", "SendMessage", CLIENT, true),
        ("Conversations", "SendMessage", HOST, false),
        ("Conversations", "SendMessage", GATEWAY, false),
        ("Objectives", "CreateObjective", CLIENT, true),
        ("Objectives", "SetLimits", CLIENT, false),
        ("Inbox", "DecideApproval", CLIENT, true),
        ("WorkerHost", "ClaimTask", HOST, true),
        ("WorkerHost", "ClaimTask", CLIENT, false),
        ("WorkerHost", "ClaimTask", GATEWAY, false),
        ("WorkerHost", "ClaimTask", "operator-test-token", false),
        ("Connector", "AcceptEvent", GATEWAY, true),
        ("Connector", "AcceptEvent", CLIENT, false),
        ("Connector", "AcceptEvent", "operator-test-token", false),
        ("OperatorNotifications", "Claim", GATEWAY, true),
        ("Inbox", "ListItems", GATEWAY, false),
        ("Enrollments", "WhoAmI", HOST, true),
        ("Enrollments", "RevokeEnrollment", CLIENT, false),
        (
            "CredentialDirectory",
            "Resolve",
            "operator-test-token",
            false,
        ),
        ("Harness", "Attach", HOST, false),
        ("NoSuchService", "Call", "operator-test-token", false),
    ];
    for (service, method, secret, allowed) in cases {
        let result = authorize::admit_for_test(&api, &path(service, method), &bearer(secret)).await;
        match (allowed, result) {
            (true, Ok(())) => {}
            (false, Err(status)) => assert_eq!(
                status.code(),
                Code::PermissionDenied,
                "{service}/{method} with {secret}"
            ),
            (expected, outcome) => {
                panic!("{service}/{method} with {secret}: expected {expected}, got {outcome:?}")
            }
        }
    }
    // Enrollment takes only an Auth Key; an Auth Key takes nothing else.
    assert!(
        authorize::admit_for_test(&api, &path("Enrollments", "Enroll"), &bearer(KEY))
            .await
            .is_ok()
    );
    for (method, secret) in [("Enroll", CLIENT), ("WhoAmI", KEY)] {
        assert_eq!(
            authorize::admit_for_test(&api, &path("Enrollments", method), &bearer(secret))
                .await
                .unwrap_err()
                .code(),
            Code::Unauthenticated
        );
    }
    // Negotiation and health carry no credential.
    for open in [
        "/supertag.runtime.v2.ProtocolNegotiation/Negotiate",
        "/grpc.health.v1.Health/Check",
    ] {
        assert!(
            authorize::admit_for_test(&api, open, &MetadataMap::new())
                .await
                .is_ok()
        );
    }
    server.abort();
    Ok(())
}

#[tokio::test]
async fn propagates_shorter_deadlines_caps_longer_ones_and_rejects_malformed_timeouts() {
    for (timeout, expected) in [("250m", Duration::from_millis(250)), ("2H", CALL_TIMEOUT)] {
        let mut request = operator_request();
        request
            .metadata_mut()
            .insert(TIMEOUT, MetadataValue::from_static(timeout));
        assert_eq!(request_budget(&request).unwrap(), expected);
    }

    for timeout in ["0S", "bogus", "123456789n"] {
        let mut request = operator_request();
        request
            .metadata_mut()
            .insert(TIMEOUT, MetadataValue::from_static(timeout));
        let status = request_budget(&request).unwrap_err();
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
    let api = api();
    let mut request = operator_request();
    request.set_timeout(Duration::from_millis(1));
    let status = api
        .forward(request, |_, _| {
            future::pending::<Result<Response<()>, Status>>()
        })
        .await
        .unwrap_err();
    assert_eq!(status.code(), Code::DeadlineExceeded);
}

#[tokio::test]
async fn the_admin_operator_is_never_an_operator_token_or_an_issued_secret() {
    let channel = || {
        supertag_protocol::negotiation::bind_current(
            Endpoint::from_static("http://127.0.0.1:1").connect_lazy(),
        )
    };
    assert!(
        Api::new(
            channel(),
            "service-test-token".into(),
            "operator-test-token".into(),
            "operator:token:alice".into(),
        )
        .is_err()
    );
    assert!(
        Api::new(
            channel(),
            "service-test-token".into(),
            TOKEN.into(),
            "operator:alice".into(),
        )
        .is_err()
    );
}
