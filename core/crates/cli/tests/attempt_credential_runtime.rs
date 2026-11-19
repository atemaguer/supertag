//! A Task Attempt's credential, through the Control Plane's public listener: it reaches only that
//! Attempt's data calls, never a lease or host operation; the host credential no longer reaches
//! the data calls; and the credential stops working when the Attempt finishes or its host is
//! revoked.
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

use std::{net::SocketAddr, process::Stdio, time::Duration};

use anyhow::{Context, Result, ensure};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{HOST_GENERATION_HEADER, authenticated_request, v2::*};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::timeout,
};
use tonic::{Code, transport::Channel};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const WAIT: Duration = Duration::from_secs(20);

database_tests! {
    #[tokio::test]
    an_attempt_credential_reaches_only_its_attempts_data_calls;
}

async fn service(mut command: Command) -> Result<(Child, String)> {
    let mut child = command.stdout(Stdio::piped()).spawn()?;
    let mut stdout = BufReader::new(child.stdout.take().context("service stdout missing")?);
    let mut line = String::new();
    timeout(WAIT, stdout.read_line(&mut line)).await??;
    let ready = line.trim();
    let address: SocketAddr = ready
        .strip_prefix("http://")
        .unwrap_or(ready)
        .parse()
        .context("service did not report a loopback endpoint")?;
    ensure!(address.ip().is_loopback() && address.port() != 0);
    Ok((child, format!("http://{address}")))
}

async fn channel(address: &str) -> Result<ProtocolChannel> {
    protocol::negotiated(
        Channel::from_shared(address.to_owned())?
            .timeout(WAIT)
            .connect()
            .await?,
    )
    .await
}

/// A call as the registered host.
fn as_host<T>(input: T, token: &str, generation: u64) -> Result<tonic::Request<T>> {
    let mut request = authenticated_request(input, token, None)?;
    request
        .metadata_mut()
        .insert(HOST_GENERATION_HEADER, generation.into());
    Ok(request)
}

/// A call with an Attempt credential. It also names the host's generation, which grants nothing.
fn as_attempt<T>(input: T, credential: &str, generation: u64) -> Result<tonic::Request<T>> {
    as_host(input, credential, generation)
}

fn event(sequence: u64, text: &str) -> AppendEventRequest {
    AppendEventRequest {
        sequence,
        text: text.into(),
        kind: TaskEventKind::Message as i32,
    }
}

fn refused<T: std::fmt::Debug>(result: Result<T, tonic::Status>, code: Code, call: &str) {
    match result {
        Err(status) => assert_eq!(status.code(), code, "{call}: {status:?}"),
        Ok(value) => panic!("{call} was admitted: {value:?}"),
    }
}

async fn an_attempt_credential_reaches_only_its_attempts_data_calls(
    database: String,
) -> Result<()> {
    let token = Uuid::new_v4().to_string();
    let host_token = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
    let gateway = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
    let mut command = reaped(Command::new(BINARY));
    command
        .args(["control-plane"])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &gateway)
        .env("SUPERTAG_GATEWAY_CREDENTIAL", &gateway)
        .env("SUPERTAG_OPERATOR_TOKEN", &token)
        .env("SUPERTAG_OPERATOR_PRINCIPAL", "operator:alice")
        .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
        .env("SUPERTAG_DATABASE_URL", &database)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    let (mut control, endpoint) = service(command).await?;
    let plane = channel(&endpoint).await?;
    operator_client::OperatorClient::new(plane.clone())
        .put_tag(authenticated_request(
            PutTagRequest {
                tag_id: "worker".into(),
                instructions: "Do the work".into(),
                ..Default::default()
            },
            &token,
            None,
        )?)
        .await?;
    let submit = |operation: &str| {
        authenticated_request(
            SubmitTaskRequest {
                tag_id: "worker".into(),
                session_id: operation.into(),
                operation_id: operation.into(),
                prompt: "Change the checkout".into(),
                ..Default::default()
            },
            &token,
            None,
        )
    };
    let mut operator = operator_client::OperatorClient::new(plane.clone());
    let first_task = operator.submit_task(submit("first")?).await?.into_inner();
    let second_task = operator.submit_task(submit("second")?).await?.into_inner();
    let mut host = worker_host_client::WorkerHostClient::new(plane.clone());
    let generation = host
        .register_host(authenticated_request(
            RegisterHostRequest {
                incarnation_id: "fixture".into(),
            },
            &host_token,
            None,
        )?)
        .await?
        .into_inner()
        .generation;
    let mut leases = vec![];
    for operation in ["claim-first", "claim-second"] {
        let assignment = host
            .claim_task(as_host(
                ClaimTaskRequest {
                    operation_id: operation.into(),
                    ..Default::default()
                },
                &host_token,
                generation,
            )?)
            .await?
            .into_inner()
            .assignment
            .context("Attempt missing")?;
        leases.push(InspectAttemptRequest {
            task_id: assignment.task.context("Task missing")?.task_id,
            attempt_id: assignment.attempt_id,
            lease_token: assignment.lease_token,
        });
    }
    let mut credentials = vec![];
    for lease in &leases {
        let started = host
            .start_task(as_host(
                StartTaskRequest {
                    task_id: lease.task_id.clone(),
                    attempt_id: lease.attempt_id.clone(),
                    lease_token: lease.lease_token.clone(),
                },
                &host_token,
                generation,
            )?)
            .await?
            .into_inner();
        ensure!(supertag_protocol::is_secret(
            supertag_protocol::ATTEMPT_CREDENTIAL_SECRET_PREFIX,
            &started.attempt_credential
        ));
        credentials.push(started.attempt_credential);
    }
    let (first, credential) = (&leases[0], credentials[0].as_str());

    // The credential reaches its Attempt's data calls, and they act on that Attempt alone.
    host.append_event(as_attempt(
        event(1, "Working on it"),
        credential,
        generation,
    )?)
    .await?;
    host.get_attempt_history(as_attempt(
        GetAttemptHistoryRequest {},
        credential,
        generation,
    )?)
    .await?;
    attempt_mailbox_client::AttemptMailboxClient::new(plane.clone())
        .read_mailbox(as_attempt(
            ReadMailboxRequest {
                limit: 1,
                ..Default::default()
            },
            credential,
            generation,
        )?)
        .await?;
    let events = |task_id: &str| {
        authenticated_request(
            ListEventsRequest {
                task_id: task_id.into(),
                ..Default::default()
            },
            &token,
            None,
        )
    };
    let listed = operator.list_events(events(&first_task.task_id)?).await?;
    assert_eq!(listed.into_inner().events.len(), 1);
    let listed = operator.list_events(events(&second_task.task_id)?).await?;
    assert!(
        listed.into_inner().events.is_empty(),
        "the first Attempt's credential wrote to the second Task"
    );
    assert_eq!(first.task_id, first_task.task_id);

    // It reaches no lease or host operation.
    let denied = Code::PermissionDenied;
    refused(
        host.register_host(as_attempt(
            RegisterHostRequest {
                incarnation_id: "attempt".into(),
            },
            credential,
            generation,
        )?)
        .await,
        denied,
        "RegisterHost",
    );
    refused(
        host.report_host(as_attempt(
            ReportHostRequest::default(),
            credential,
            generation,
        )?)
        .await,
        denied,
        "ReportHost",
    );
    refused(
        host.claim_task(as_attempt(
            ClaimTaskRequest {
                operation_id: "attempt-claim".into(),
                ..Default::default()
            },
            credential,
            generation,
        )?)
        .await,
        denied,
        "ClaimTask",
    );
    refused(
        host.start_task(as_attempt(
            StartTaskRequest {
                task_id: first.task_id.clone(),
                attempt_id: first.attempt_id.clone(),
                lease_token: first.lease_token.clone(),
            },
            credential,
            generation,
        )?)
        .await,
        denied,
        "StartTask",
    );
    for (name, result) in [
        (
            "InspectAttempt",
            host.inspect_attempt(as_attempt(first.clone(), credential, generation)?)
                .await
                .map(|_| ()),
        ),
        (
            "RenewAttempt",
            host.renew_attempt(as_attempt(first.clone(), credential, generation)?)
                .await
                .map(|_| ()),
        ),
        (
            "GetCheckpoint",
            host.get_checkpoint(as_attempt(first.clone(), credential, generation)?)
                .await
                .map(|_| ()),
        ),
    ] {
        refused(result, denied, name);
    }
    refused(
        host.reclaim_attempt(as_attempt(
            ReclaimAttemptRequest {
                attempt: Some(first.clone()),
                evidence: "gone".into(),
            },
            credential,
            generation,
        )?)
        .await,
        denied,
        "ReclaimAttempt",
    );
    let finish = FinishTaskRequest {
        task_id: first.task_id.clone(),
        attempt_id: first.attempt_id.clone(),
        lease_token: first.lease_token.clone(),
        succeeded: true,
        result: "Done".into(),
        ..Default::default()
    };
    refused(
        host.finish_task(as_attempt(finish.clone(), credential, generation)?)
            .await,
        denied,
        "FinishTask",
    );
    refused(
        transfers_client::TransfersClient::new(plane.clone())
            .get_workspace_continuation(as_attempt(first.clone(), credential, generation)?)
            .await,
        denied,
        "Transfers.GetWorkspaceContinuation",
    );
    refused(
        enrollments_client::EnrollmentsClient::new(plane.clone())
            .who_am_i(as_attempt(
                WhoAmIRequest::default(),
                credential,
                generation,
            )?)
            .await,
        denied,
        "Enrollments.WhoAmI",
    );
    refused(
        operator
            .list_tasks(as_attempt(
                ListTasksRequest::default(),
                credential,
                generation,
            )?)
            .await,
        denied,
        "Operator.ListTasks",
    );

    // The host credential no longer reaches the data calls.
    refused(
        host.append_event(as_host(event(2, "As the host"), &host_token, generation)?)
            .await,
        denied,
        "AppendEvent as the host",
    );
    refused(
        attempt_mailbox_client::AttemptMailboxClient::new(plane.clone())
            .read_mailbox(as_host(
                ReadMailboxRequest::default(),
                &host_token,
                generation,
            )?)
            .await,
        denied,
        "AttemptMailbox.ReadMailbox as the host",
    );

    // A secret of the right shape that names no Attempt is refused.
    let forged = supertag_protocol::new_secret(supertag_protocol::ATTEMPT_CREDENTIAL_SECRET_PREFIX);
    refused(
        host.append_event(as_attempt(event(2, "Forged"), &forged, generation)?)
            .await,
        Code::Unauthenticated,
        "AppendEvent with a forged credential",
    );

    // Finishing the Attempt ends its credential.
    host.finish_task(as_host(finish, &host_token, generation)?)
        .await?;
    refused(
        host.append_event(as_attempt(
            event(2, "After finishing"),
            credential,
            generation,
        )?)
        .await,
        Code::Unauthenticated,
        "AppendEvent after FinishTask",
    );

    // Revoking the host ends the credential of the Attempt it still holds.
    let second_credential = credentials[1].as_str();
    host.append_event(as_attempt(
        event(1, "Second"),
        second_credential,
        generation,
    )?)
    .await?;
    enrollments_client::EnrollmentsClient::new(plane.clone())
        .revoke_enrollment(authenticated_request(
            RevokeEnrollmentRequest {
                role: PrincipalRole::Host as i32,
                name: "local".into(),
            },
            &token,
            None,
        )?)
        .await?;
    refused(
        host.append_event(as_attempt(
            event(2, "After revocation"),
            second_credential,
            generation,
        )?)
        .await,
        Code::Unauthenticated,
        "AppendEvent after the host was revoked",
    );
    control.kill().await?;
    Ok(())
}
