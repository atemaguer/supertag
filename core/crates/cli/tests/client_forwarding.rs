//! Clients reach the Control Plane through a Gateway, and the Gateway never widens what a caller
//! may do: the Control Plane authorizes every forwarded call as the caller's own principal.
#[path = "support/children.rs"]
mod children;
use children::reaped;
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[path = "support/protocol.rs"]
mod protocol;
#[macro_use]
#[path = "support/database.rs"]
mod database;

use std::{
    future::poll_fn,
    net::SocketAddr,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use prost::Message;
use sha2::{Digest, Sha256};
use supertag_protocol::{
    AUTH_KEY_SECRET_PREFIX, CREDENTIAL_SECRET_PREFIX, OPERATOR_TOKEN_SECRET_PREFIX,
    authenticated_request,
    authorization::{CLIENT, OPEN, access},
    negotiation::ProtocolChannel,
    new_secret,
    v2::{
        CreateAuthKeyRequest, CreateOperatorTokenRequest, EnrollRequest, FollowConversationRequest,
        ListAuditEntriesRequest, ListAuthKeysRequest, ListConversationsRequest, ListHostsRequest,
        PrincipalRole, PutTagRequest, ReconcileTagRelationshipsRequest, RevokeEnrollmentRequest,
        WhoAmIRequest, auth_keys_client::AuthKeysClient, conversations_client::ConversationsClient,
        enrollments_client::EnrollmentsClient,
        manifest_relationships_client::ManifestRelationshipsClient,
        operator_access_client::OperatorAccessClient, operator_client::OperatorClient,
    },
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::timeout,
};
use tonic::{Code, Request};
use tower_service::Service as _;
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const WAIT: Duration = Duration::from_secs(30);

fn binary(args: &[&str]) -> Command {
    let mut command = reaped(Command::new(BINARY));
    command
        .args(args)
        .env_clear()
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

/// A running service, and what it wrote to standard error so far.
struct Service {
    child: Child,
    url: String,
    stderr: Arc<Mutex<String>>,
}

async fn service(mut command: Command, name: &str) -> Result<Service> {
    let mut child = command.stdout(Stdio::piped()).spawn()?;
    let stderr = Arc::new(Mutex::new(String::new()));
    let mut errors = BufReader::new(child.stderr.take().context("service stderr missing")?);
    let log = stderr.clone();
    tokio::spawn(async move {
        let mut line = String::new();
        while errors.read_line(&mut line).await.is_ok_and(|read| read > 0) {
            log.lock().unwrap().push_str(&line);
            line.clear();
        }
    });
    let mut stdout = BufReader::new(child.stdout.take().context("service stdout missing")?);
    let mut line = String::new();
    let started = timeout(WAIT, stdout.read_line(&mut line)).await;
    if !matches!(started, Ok(Ok(read)) if read > 0) {
        anyhow::bail!("{name} did not start: {}", stderr.lock().unwrap());
    }
    let address: SocketAddr = line.trim().parse().context("missing service address")?;
    ensure!(address.ip().is_loopback() && address.port() != 0);
    // Keep reading so the service never blocks on a full pipe.
    tokio::spawn(async move {
        let mut sink = String::new();
        while stdout.read_line(&mut sink).await.is_ok_and(|read| read > 0) {
            sink.clear();
        }
    });
    Ok(Service {
        child,
        url: format!("http://{address}"),
        stderr,
    })
}

/// A Control Plane, a Gateway in front of it, and the secrets the test acts with.
struct Stack {
    _control_plane: Service,
    gateway: Service,
    control_plane_url: String,
    gateway_url: String,
    admin: String,
    gateway_credential: String,
}

async fn stack(database: String) -> Result<Stack> {
    let gateway_credential = new_secret(CREDENTIAL_SECRET_PREFIX);
    let admin = Uuid::new_v4().to_string();
    let mut control = binary(&["control-plane"]);
    control
        .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &gateway_credential)
        .env("SUPERTAG_DATABASE_URL", database)
        .env("SUPERTAG_OPERATOR_TOKEN", &admin);
    let control_plane = service(control, "Control Plane").await?;
    let control_plane_url = control_plane.url.clone();
    let gateway = start_gateway(&control_plane_url, &gateway_credential, false).await?;
    let gateway_url = gateway.url.clone();
    Ok(Stack {
        _control_plane: control_plane,
        gateway,
        control_plane_url,
        gateway_url,
        admin,
        gateway_credential,
    })
}

async fn start_gateway(control_plane: &str, credential: &str, every_call: bool) -> Result<Service> {
    let mut gateway = binary(&[
        "gateway",
        "--control-plane",
        control_plane,
        "--listen",
        "127.0.0.1:0",
    ]);
    gateway.env("SUPERTAG_GATEWAY_CREDENTIAL", credential);
    if every_call {
        gateway.env("SUPERTAG_TEST_GATEWAY_FORWARD_EVERY_CALL", "1");
    }
    service(gateway, "Gateway").await
}

fn call<T>(message: T, secret: &str) -> Request<T> {
    authenticated_request(message, secret, None).expect("a valid bearer")
}

fn code<T>(result: Result<T, tonic::Status>) -> Code {
    match result {
        Ok(_) => Code::Ok,
        Err(status) => status.code(),
    }
}

/// Calls `path` with one empty message and the given headers, and returns the gRPC status code.
async fn raw_code(channel: &ProtocolChannel, path: &str, headers: &[(&str, &str)]) -> Result<Code> {
    let mut request = http::Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/grpc")
        .header("te", "trailers");
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let request = request.body(tonic::body::Body::new(Full::new(Bytes::from_static(&[
        0, 0, 0, 0, 0,
    ]))))?;
    let mut channel = channel.clone();
    poll_fn(|context| channel.poll_ready(context)).await?;
    let response = channel.call(request).await?;
    let status = |value: &http::HeaderValue| -> Result<Code> {
        Ok(Code::from_i32(value.to_str()?.parse()?))
    };
    if let Some(value) = response.headers().get("grpc-status") {
        return status(value);
    }
    let collected = timeout(WAIT, response.into_body().collect())
        .await
        .context("response did not end")?
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    let trailers = collected.trailers().context("no gRPC trailers")?;
    status(trailers.get("grpc-status").context("no gRPC status")?)
}

/// Creates a client Auth Key and enrolls `name` with it through the Gateway.
async fn enroll_client(channel: &ProtocolChannel, admin: &str, name: &str) -> Result<String> {
    let key = new_secret(AUTH_KEY_SECRET_PREFIX);
    OperatorClient::new(channel.clone())
        .create_auth_key(call(
            CreateAuthKeyRequest {
                operation_id: Uuid::new_v4().to_string(),
                key_digest: Sha256::digest(key.as_bytes()).to_vec(),
                all_tags: true,
                name: format!("{name}-key"),
                role: PrincipalRole::Client as i32,
                ..Default::default()
            },
            admin,
        ))
        .await?;
    let credential = new_secret(CREDENTIAL_SECRET_PREFIX);
    EnrollmentsClient::new(channel.clone())
        .enroll(call(
            EnrollRequest {
                role: PrincipalRole::Client as i32,
                name: name.into(),
                operation_id: Uuid::new_v4().to_string(),
                token_digest: Sha256::digest(credential.as_bytes()).to_vec(),
            },
            &key,
        ))
        .await?;
    Ok(credential)
}

database_tests! {
    #[tokio::test]
    a_gateway_forwards_calls_as_their_caller_and_never_widens_them;
    #[tokio::test]
    #[ignore = "load test: holds 1,000 conversation follows open through one Gateway"]
    a_gateway_holds_a_thousand_follows_open;
}

/// One Gateway relays 1,000 open follows: its connections to the Control Plane are pooled, so one
/// connection's concurrent stream limit does not cap how many clients follow conversations.
async fn a_gateway_holds_a_thousand_follows_open(database: String) -> Result<()> {
    const FOLLOWS: usize = 1_000;
    const CLIENTS: usize = 20;
    let stack = stack(database).await?;
    let admin = stack.admin.as_str();
    let first = protocol::dial(&stack.gateway_url).await?;
    OperatorClient::new(first.clone())
        .put_tag(call(
            PutTagRequest {
                tag_id: "reviewer".into(),
                instructions: "Review changes".into(),
                ..Default::default()
            },
            admin,
        ))
        .await?;
    // Several client connections, as many clients would open.
    let mut channels = vec![first];
    for _ in 1..CLIENTS {
        channels.push(protocol::dial(&stack.gateway_url).await?);
    }
    let mut opened = tokio::task::JoinSet::new();
    for index in 0..FOLLOWS {
        let channel = channels[index % CLIENTS].clone();
        let admin = admin.to_owned();
        opened.spawn(async move {
            let mut follow = ConversationsClient::new(channel)
                .follow_conversation(call(
                    FollowConversationRequest {
                        tag_id: "reviewer".into(),
                        ..Default::default()
                    },
                    &admin,
                ))
                .await?
                .into_inner();
            follow
                .message()
                .await?
                .context("the follow sent its first response")?;
            anyhow::Ok(follow)
        });
    }
    let mut follows = Vec::with_capacity(FOLLOWS);
    while let Some(follow) = timeout(Duration::from_secs(120), opened.join_next())
        .await
        .context("the follows did not all open")?
    {
        follows.push(follow??);
    }
    assert_eq!(follows.len(), FOLLOWS);
    // Every follow is still open and the Gateway still answers new calls.
    ConversationsClient::new(channels[0].clone())
        .list_conversations(call(ListConversationsRequest {}, admin))
        .await?;
    Ok(())
}

async fn a_gateway_forwards_calls_as_their_caller_and_never_widens_them(
    database: String,
) -> Result<()> {
    let stack = stack(database).await?;
    let gateway = protocol::dial(&stack.gateway_url).await?;
    let admin = stack.admin.as_str();

    // The admin operator sets up a Tag through the Gateway.
    OperatorClient::new(gateway.clone())
        .put_tag(call(
            PutTagRequest {
                tag_id: "reviewer".into(),
                instructions: "Review changes".into(),
                ..Default::default()
            },
            admin,
        ))
        .await?;

    // 1. A client enrolls through the Gateway and is itself there.
    let client = enroll_client(&gateway, admin, "laptop").await?;
    let me = EnrollmentsClient::new(gateway.clone())
        .who_am_i(call(WhoAmIRequest {}, &client))
        .await?
        .into_inner();
    assert_eq!(me.principal, "client:laptop");
    assert_eq!(me.role, PrincipalRole::Client as i32);

    // A Gateway enrolls only clients: a host enrollment is refused before the Control Plane.
    let host_key = new_secret(AUTH_KEY_SECRET_PREFIX);
    let host = EnrollmentsClient::new(gateway.clone())
        .enroll(call(
            EnrollRequest {
                role: PrincipalRole::Host as i32,
                name: "sneaky".into(),
                operation_id: Uuid::new_v4().to_string(),
                token_digest: vec![7; 32],
            },
            &host_key,
        ))
        .await;
    assert_eq!(code(host), Code::PermissionDenied);

    // 2. Operator-only calls are denied to the client.
    let denied = [
        code(
            OperatorClient::new(gateway.clone())
                .put_tag(call(
                    PutTagRequest {
                        tag_id: "takeover".into(),
                        instructions: "x".into(),
                        ..Default::default()
                    },
                    &client,
                ))
                .await,
        ),
        code(
            OperatorClient::new(gateway.clone())
                .list_hosts(call(ListHostsRequest::default(), &client))
                .await,
        ),
        code(
            AuthKeysClient::new(gateway.clone())
                .list_auth_keys(call(ListAuthKeysRequest::default(), &client))
                .await,
        ),
        code(
            OperatorAccessClient::new(gateway.clone())
                .list_audit_entries(call(ListAuditEntriesRequest::default(), &client))
                .await,
        ),
        code(
            ManifestRelationshipsClient::new(gateway.clone())
                .reconcile_tag(call(ReconcileTagRelationshipsRequest::default(), &client))
                .await,
        ),
    ];
    assert_eq!(denied, [Code::PermissionDenied; 5]);
    // A Tag's network log names other people's Tasks' origins and paths: operators only.
    let network_logs = "/supertag.runtime.v2.NetworkLogs/List";
    assert_eq!(
        raw_code(
            &gateway,
            network_logs,
            &[("authorization", &format!("Bearer {client}"))]
        )
        .await?,
        Code::PermissionDenied
    );
    assert_ne!(
        raw_code(
            &gateway,
            network_logs,
            &[("authorization", &format!("Bearer {admin}"))]
        )
        .await?,
        Code::PermissionDenied,
        "the Gateway must forward an operator's network log read"
    );

    // 3. No method the table keeps from clients answers a client through the Gateway.
    let bearer = format!("Bearer {client}");
    let set = prost_types::FileDescriptorSet::decode(supertag_protocol::FILE_DESCRIPTOR_SET)?;
    let mut checked = 0;
    for file in &set.file {
        for service in &file.service {
            for method in &service.method {
                let access = access(service.name(), method.name()).unwrap_or(0);
                if access & (CLIENT | OPEN) != 0 {
                    continue;
                }
                let path = format!("/{}.{}/{}", file.package(), service.name(), method.name());
                let code = raw_code(&gateway, &path, &[("authorization", &bearer)]).await?;
                assert!(
                    matches!(
                        code,
                        Code::PermissionDenied | Code::Unimplemented | Code::Unauthenticated
                    ),
                    "{path} answered a client through the Gateway with {code:?}"
                );
                checked += 1;
            }
        }
    }
    assert!(
        checked > 150,
        "too few non-client methods checked: {checked}"
    );

    // 4. The Gateway never lends its own role: a Gateway-only method is not served to clients,
    // and with the Gateway's allowlist disabled the Control Plane still refuses the client.
    let claim = "/supertag.runtime.v2.Connector/ClaimConnector";
    assert_eq!(
        raw_code(&gateway, claim, &[("authorization", &bearer)]).await?,
        Code::Unimplemented
    );
    let open_gateway =
        start_gateway(&stack.control_plane_url, &stack.gateway_credential, true).await?;
    let open = protocol::dial(&open_gateway.url).await?;
    assert_eq!(
        raw_code(&open, claim, &[("authorization", &bearer)]).await?,
        Code::PermissionDenied
    );
    // The same call with the Gateway's own credential is admitted by the table, so the refusal
    // above was the client's principal, not the method.
    let gateway_bearer = format!("Bearer {}", stack.gateway_credential);
    assert_ne!(
        raw_code(&open, claim, &[("authorization", &gateway_bearer)]).await?,
        Code::PermissionDenied
    );

    // 5. Headers that name a principal are dropped.
    let forged = [
        ("authorization", bearer.as_str()),
        ("x-supertag-internal-principal", "operator:local"),
        ("x-supertag-connector-account", "slack:T1"),
    ];
    assert_eq!(
        raw_code(&gateway, "/supertag.runtime.v2.Operator/ListHosts", &forged).await?,
        Code::PermissionDenied
    );
    let mut whoami = call(WhoAmIRequest {}, &client);
    whoami
        .metadata_mut()
        .insert("x-supertag-internal-principal", "operator:local".parse()?);
    let me = EnrollmentsClient::new(gateway.clone())
        .who_am_i(whoami)
        .await?
        .into_inner();
    assert_eq!(me.principal, "client:laptop");

    // 6. A call needs exactly one bearer.
    let path = "/supertag.runtime.v2.Conversations/ListConversations";
    assert_eq!(raw_code(&gateway, path, &[]).await?, Code::Unauthenticated);
    assert_eq!(
        raw_code(
            &gateway,
            path,
            &[("authorization", &bearer), ("authorization", &bearer)]
        )
        .await?,
        Code::Unauthenticated
    );

    // 7. A client's own calls work, and revoking it ends its open follow.
    ConversationsClient::new(gateway.clone())
        .list_conversations(call(ListConversationsRequest {}, &client))
        .await?;
    let mut follow = ConversationsClient::new(gateway.clone())
        .follow_conversation(call(
            FollowConversationRequest {
                tag_id: "reviewer".into(),
                ..Default::default()
            },
            &client,
        ))
        .await?
        .into_inner();
    follow
        .message()
        .await?
        .context("the follow sent its first response")?;
    EnrollmentsClient::new(gateway.clone())
        .revoke_enrollment(call(
            RevokeEnrollmentRequest {
                role: PrincipalRole::Client as i32,
                name: "laptop".into(),
            },
            admin,
        ))
        .await?;
    let ended = timeout(Duration::from_secs(3), async {
        loop {
            match follow.message().await {
                Ok(Some(_)) => continue,
                Ok(None) => return Code::Ok,
                Err(status) => return status.code(),
            }
        }
    })
    .await
    .context("the revoked client's follow stayed open")?;
    assert_eq!(ended, Code::Unauthenticated);

    // 8. An Operator Token through the Gateway is an operator, not the admin.
    let token = new_secret(OPERATOR_TOKEN_SECRET_PREFIX);
    OperatorAccessClient::new(gateway.clone())
        .create_operator_token(call(
            CreateOperatorTokenRequest {
                name: "teammate".into(),
                operation_id: Uuid::new_v4().to_string(),
                secret_digest: Sha256::digest(token.as_bytes()).to_vec(),
            },
            admin,
        ))
        .await?;
    let escalation = OperatorAccessClient::new(gateway.clone())
        .create_operator_token(call(
            CreateOperatorTokenRequest {
                name: "escalated".into(),
                operation_id: Uuid::new_v4().to_string(),
                secret_digest: vec![9; 32],
            },
            &token,
        ))
        .await;
    assert_eq!(code(escalation), Code::PermissionDenied);
    OperatorClient::new(gateway.clone())
        .list_hosts(call(ListHostsRequest::default(), &token))
        .await?;

    // Nothing the Gateway logged carries a credential.
    let mut gateway_process = stack.gateway;
    gateway_process.child.start_kill()?;
    gateway_process.child.wait().await?;
    let log = gateway_process.stderr.lock().unwrap().clone();
    for secret in [
        client.as_str(),
        token.as_str(),
        admin,
        &stack.gateway_credential,
    ] {
        assert!(!log.contains(secret), "the Gateway logged a credential");
    }
    for prefix in [
        CREDENTIAL_SECRET_PREFIX,
        OPERATOR_TOKEN_SECRET_PREFIX,
        AUTH_KEY_SECRET_PREFIX,
    ] {
        assert!(
            !log.contains(prefix),
            "the Gateway logged a {prefix} credential"
        );
    }
    Ok(())
}
