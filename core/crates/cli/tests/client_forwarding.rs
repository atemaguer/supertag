//! Clients, and a running Task Attempt's data calls, reach the Control Plane through a Gateway,
//! and the Gateway never widens what a caller may do: the Control Plane authorizes every forwarded
//! call as the caller's own principal.
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
    host_token: String,
}

/// The Gateway URL the Control Plane names to registering hosts for Task Attempts' data calls.
const DATA_ENDPOINT: &str = "https://gateway.example.test:8443";

async fn stack(database: String) -> Result<Stack> {
    let gateway_credential = new_secret(CREDENTIAL_SECRET_PREFIX);
    let host_token = new_secret(CREDENTIAL_SECRET_PREFIX);
    let admin = Uuid::new_v4().to_string();
    let mut control = binary(&["control-plane"]);
    control
        .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &gateway_credential)
        .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
        .env("SUPERTAG_DATA_ENDPOINT", DATA_ENDPOINT)
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
        host_token,
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
    a_gateway_forwards_an_attempts_data_calls_and_no_host_call;
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

/// A Worker sends its Task Attempt's data calls through a Gateway with the Attempt credential. The
/// Gateway forwards them as that Attempt and nothing more: no host call crosses it, with either
/// credential, and the Control Plane still refuses a lease call the Gateway is made to forward.
async fn a_gateway_forwards_an_attempts_data_calls_and_no_host_call(
    database: String,
) -> Result<()> {
    use supertag_protocol::{
        ATTEMPT_CREDENTIAL_SECRET_PREFIX, HOST_GENERATION_HEADER,
        authorization::{ENROLL, HOST, OPERATOR, gateway_forwards},
        v2::{
            AppendEventRequest, ClaimTaskRequest, FinishTaskRequest, GetAttemptHistoryRequest,
            InspectAttemptRequest, ListEventsRequest, PublishTaskTextRequest, ReadMailboxRequest,
            RegisterHostRequest, ServiceRole, StartTaskRequest, SubmitTaskRequest, TaskEventKind,
            attempt_mailbox_client::AttemptMailboxClient, worker_host_client::WorkerHostClient,
        },
    };

    let stack = stack(database).await?;
    let admin = stack.admin.as_str();
    let host_token = stack.host_token.as_str();
    let operator = protocol::dial(&stack.gateway_url).await?;
    OperatorClient::new(operator.clone())
        .put_tag(call(
            PutTagRequest {
                tag_id: "worker".into(),
                instructions: "Do the work".into(),
                ..Default::default()
            },
            admin,
        ))
        .await?;
    let mut tasks = vec![];
    for operation in ["first", "second"] {
        tasks.push(
            OperatorClient::new(operator.clone())
                .submit_task(call(
                    SubmitTaskRequest {
                        tag_id: "worker".into(),
                        session_id: operation.into(),
                        operation_id: operation.into(),
                        prompt: "Change the checkout".into(),
                        ..Default::default()
                    },
                    admin,
                ))
                .await?
                .into_inner(),
        );
    }

    // The Worklet registers, claims, and starts on the Control Plane itself.
    let plane = protocol::dial(&stack.control_plane_url).await?;
    let mut host = WorkerHostClient::new(plane.clone());
    let registration = host
        .register_host(call(
            RegisterHostRequest {
                incarnation_id: "fixture".into(),
            },
            host_token,
        ))
        .await?
        .into_inner();
    // Registration names the Gateway the deployment set for Task Attempts' data calls.
    assert_eq!(registration.data_endpoint, DATA_ENDPOINT);
    let generation = registration.generation;
    // A call naming the host's generation, as a Worklet's does.
    let as_host = HostCalls(generation);
    let mut leases = vec![];
    let mut credentials = vec![];
    for operation in ["claim-first", "claim-second"] {
        let assignment = host
            .claim_task(as_host.call(
                ClaimTaskRequest {
                    operation_id: operation.into(),
                    ..Default::default()
                },
                host_token,
            ))
            .await?
            .into_inner()
            .assignment
            .context("Attempt missing")?;
        let lease = InspectAttemptRequest {
            task_id: assignment.task.context("Task missing")?.task_id,
            attempt_id: assignment.attempt_id,
            lease_token: assignment.lease_token,
        };
        let started = host
            .start_task(as_host.call(
                StartTaskRequest {
                    task_id: lease.task_id.clone(),
                    attempt_id: lease.attempt_id.clone(),
                    lease_token: lease.lease_token.clone(),
                },
                host_token,
            ))
            .await?
            .into_inner();
        ensure!(supertag_protocol::is_secret(
            ATTEMPT_CREDENTIAL_SECRET_PREFIX,
            &started.attempt_credential
        ));
        leases.push(lease);
        credentials.push(started.attempt_credential);
    }
    let (first, credential) = (&leases[0], credentials[0].as_str());

    // A Worker reaches the Gateway, negotiating as its Worker Host does.
    let worker = supertag_protocol::negotiation::connect(
        tonic::transport::Endpoint::from_shared(stack.gateway_url.clone())?
            .connect()
            .await?,
        ServiceRole::WorkerHost,
        ServiceRole::Gateway,
    )
    .await
    .map_err(|error| anyhow::anyhow!("{error}"))?;
    let mut data = WorkerHostClient::new(worker.clone());
    let event = |sequence: u64, text: &str| AppendEventRequest {
        sequence,
        text: text.into(),
        kind: TaskEventKind::Message as i32,
    };

    // 1. The Attempt's data calls go through, as that Attempt alone.
    data.append_event(call(event(1, "Working on it"), credential))
        .await?;
    data.publish_text(call(
        PublishTaskTextRequest {
            after_sequence: 1,
            revision: 1,
            text: "Working on it, still".into(),
        },
        credential,
    ))
    .await?;
    data.get_attempt_history(call(GetAttemptHistoryRequest {}, credential))
        .await?;
    AttemptMailboxClient::new(worker.clone())
        .read_mailbox(call(
            ReadMailboxRequest {
                limit: 1,
                ..Default::default()
            },
            credential,
        ))
        .await?;
    let events = |task_id: &str| {
        call(
            ListEventsRequest {
                task_id: task_id.into(),
                ..Default::default()
            },
            admin,
        )
    };
    let listed = OperatorClient::new(operator.clone())
        .list_events(events(&tasks[0].task_id))
        .await?
        .into_inner();
    assert_eq!(listed.events.len(), 1);
    assert_eq!(first.task_id, tasks[0].task_id);
    let listed = OperatorClient::new(operator.clone())
        .list_events(events(&tasks[1].task_id))
        .await?
        .into_inner();
    assert!(
        listed.events.is_empty(),
        "the first Attempt's credential wrote to the second Task through the Gateway"
    );

    // A forged principal or host generation header changes nothing: the call is still the
    // Attempt's, and a forged credential of the right shape is refused.
    let mut forged = call(event(2, "Still the Attempt"), credential);
    forged
        .metadata_mut()
        .insert("x-supertag-internal-principal", "host:local".parse()?);
    forged
        .metadata_mut()
        .insert(HOST_GENERATION_HEADER, generation.into());
    data.append_event(forged).await?;
    let unknown = new_secret(ATTEMPT_CREDENTIAL_SECRET_PREFIX);
    assert_eq!(
        code(data.append_event(call(event(3, "Forged"), &unknown)).await),
        Code::Unauthenticated
    );

    // 2. The host credential on a data call is forwarded, and refused as the host it is.
    assert_eq!(
        code(
            data.append_event(as_host.call(event(3, "As the host"), host_token))
                .await
        ),
        Code::PermissionDenied
    );

    // 3. No method a Worker Host's host credential may call is served by the Gateway, with the
    // host credential or the Attempt credential.
    let set = prost_types::FileDescriptorSet::decode(supertag_protocol::FILE_DESCRIPTOR_SET)?;
    let mut checked = 0;
    for file in &set.file {
        for service in &file.service {
            for method in &service.method {
                let access = access(service.name(), method.name()).unwrap_or(0);
                // `Enrollments.WhoAmI` and `RotateCredential` also serve clients, as their callers.
                if access & HOST == 0 || access & (OPERATOR | CLIENT | ENROLL) != 0 {
                    continue;
                }
                let path = format!("/{}.{}/{}", file.package(), service.name(), method.name());
                assert!(!gateway_forwards(&path), "{path} is forwarded");
                for secret in [host_token, credential] {
                    let bearer = format!("Bearer {secret}");
                    let generation = generation.to_string();
                    let code = raw_code(
                        &worker,
                        &path,
                        &[
                            ("authorization", &bearer),
                            (HOST_GENERATION_HEADER, &generation),
                        ],
                    )
                    .await?;
                    assert_eq!(
                        code,
                        Code::Unimplemented,
                        "{path} answered through the Gateway"
                    );
                }
                checked += 1;
            }
        }
    }
    assert!(checked > 20, "too few host methods checked: {checked}");
    let refused_claim = WorkerHostClient::new(worker.clone())
        .claim_task(as_host.call(
            ClaimTaskRequest {
                operation_id: "through-the-gateway".into(),
                ..Default::default()
            },
            host_token,
        ))
        .await;
    assert_eq!(code(refused_claim), Code::Unimplemented);

    // 4. With the Gateway's allowlist disabled, the Control Plane still refuses the Attempt
    // credential every lease and host call: forwarding lends it nothing.
    let open_gateway =
        start_gateway(&stack.control_plane_url, &stack.gateway_credential, true).await?;
    let open = supertag_protocol::negotiation::connect(
        tonic::transport::Endpoint::from_shared(open_gateway.url.clone())?
            .connect()
            .await?,
        ServiceRole::WorkerHost,
        ServiceRole::Gateway,
    )
    .await
    .map_err(|error| anyhow::anyhow!("{error}"))?;
    let mut open_host = WorkerHostClient::new(open.clone());
    let lease_calls = [
        code(
            open_host
                .claim_task(as_host.call(
                    ClaimTaskRequest {
                        operation_id: "attempt-claim".into(),
                        ..Default::default()
                    },
                    credential,
                ))
                .await,
        ),
        code(
            open_host
                .renew_attempt(as_host.call(first.clone(), credential))
                .await,
        ),
        code(
            open_host
                .start_task(as_host.call(
                    StartTaskRequest {
                        task_id: first.task_id.clone(),
                        attempt_id: first.attempt_id.clone(),
                        lease_token: first.lease_token.clone(),
                    },
                    credential,
                ))
                .await,
        ),
        code(
            open_host
                .finish_task(as_host.call(
                    FinishTaskRequest {
                        task_id: first.task_id.clone(),
                        attempt_id: first.attempt_id.clone(),
                        lease_token: first.lease_token.clone(),
                        succeeded: true,
                        result: "Done".into(),
                        ..Default::default()
                    },
                    credential,
                ))
                .await,
        ),
        code(
            open_host
                .register_host(as_host.call(
                    RegisterHostRequest {
                        incarnation_id: "attempt".into(),
                    },
                    credential,
                ))
                .await,
        ),
    ];
    assert_eq!(lease_calls, [Code::PermissionDenied; 5]);
    // The same credential's data call through that Gateway is admitted, so the refusals above
    // were the Attempt's role, not a dead credential.
    open_host
        .append_event(call(event(3, "Through the open Gateway"), credential))
        .await?;

    // 5. Finishing the Attempt on the Control Plane ends its credential at the Gateway too; the
    // other Attempt's still works.
    host.finish_task(as_host.call(
        FinishTaskRequest {
            task_id: first.task_id.clone(),
            attempt_id: first.attempt_id.clone(),
            lease_token: first.lease_token.clone(),
            succeeded: true,
            result: "Done".into(),
            ..Default::default()
        },
        host_token,
    ))
    .await?;
    assert_eq!(
        code(
            data.append_event(call(event(4, "After finishing"), credential))
                .await
        ),
        Code::Unauthenticated
    );
    data.append_event(call(event(1, "Second"), &credentials[1]))
        .await?;

    // Nothing either Gateway logged carries an Attempt or host credential.
    for mut process in [stack.gateway, open_gateway] {
        process.child.start_kill()?;
        process.child.wait().await?;
        let log = process.stderr.lock().unwrap().clone();
        for secret in [credential, credentials[1].as_str(), host_token] {
            assert!(!log.contains(secret), "the Gateway logged a credential");
        }
        assert!(
            !log.contains(ATTEMPT_CREDENTIAL_SECRET_PREFIX),
            "the Gateway logged an Attempt credential"
        );
    }
    Ok(())
}

/// Builds calls that name one host generation, which only a host call uses.
#[derive(Clone, Copy)]
struct HostCalls(u64);

impl HostCalls {
    fn call<T>(self, message: T, secret: &str) -> Request<T> {
        let mut request = call(message, secret);
        request
            .metadata_mut()
            .insert(supertag_protocol::HOST_GENERATION_HEADER, self.0.into());
        request
    }
}
