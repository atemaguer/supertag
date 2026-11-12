use std::{net::SocketAddr, process::Stdio, time::Duration};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use supertag_protocol::{HOST_GENERATION_HEADER, authenticated_request, v2::*};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::timeout,
};
use tonic::{Code, Request, transport::Channel};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const WAIT: Duration = Duration::from_secs(15);

fn command(args: &[&str]) -> Command {
    let mut command = Command::new(BINARY);
    command
        .args(args)
        .env_clear()
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
}

async fn service(mut command: Command) -> Result<(Child, String)> {
    let mut child = command.stdout(Stdio::piped()).spawn()?;
    let mut output = BufReader::new(child.stdout.take().context("missing service stdout")?);
    let mut ready = String::new();
    timeout(WAIT, output.read_line(&mut ready)).await??;
    let address: SocketAddr = ready
        .trim()
        .parse()
        .context("service did not report its bind address")?;
    ensure!(address.ip().is_loopback() && address.port() != 0);
    Ok((child, format!("http://{address}")))
}

async fn cli(args: &[&str], token: &str) -> Result<Value> {
    let output = timeout(
        WAIT,
        command(args).env("SUPERTAG_OPERATOR_TOKEN", token).output(),
    )
    .await??;
    ensure!(
        output.status.success(),
        "command {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}

fn host_request<T>(input: T, token: &str, generation: u64) -> Result<Request<T>> {
    let mut request = authenticated_request(input, token, None)?;
    request
        .metadata_mut()
        .insert(HOST_GENERATION_HEADER, generation.into());
    Ok(request)
}

#[tokio::test]
async fn operator_teams_and_attempt_workstreams_run_across_the_gateway() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let service_token = Uuid::new_v4().to_string();
    let operator_token = Uuid::new_v4().to_string();
    let host_token = Uuid::new_v4().to_string();
    let mut plane = command(&["control-plane"]);
    plane
        .env("SUPERTAG_GATEWAY_TOKEN", &service_token)
        .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
        .env(
            "SUPERTAG_DATABASE_URL",
            format!(
                "sqlite://{}?mode=rwc",
                directory.path().join("control.db").display()
            ),
        );
    let (mut plane, private) = service(plane).await?;
    let mut gateway = command(&["gateway", "--control-plane", &private]);
    gateway
        .env("SUPERTAG_GATEWAY_TOKEN", &service_token)
        .env("SUPERTAG_OPERATOR_TOKEN", &operator_token);
    let (mut gateway, public) = service(gateway).await?;

    for tag in ["engineer", "reviewer"] {
        cli(
            &[
                "put-tag",
                "--gateway",
                &public,
                tag,
                "--instructions",
                "Verify changes",
            ],
            &operator_token,
        )
        .await?;
    }
    let team = cli(
        &[
            "team",
            "--gateway",
            &public,
            "create",
            "release",
            "--name",
            "Release review",
            "--member",
            "engineer",
            "--member",
            "reviewer",
            "--max-concurrency",
            "2",
        ],
        &operator_token,
    )
    .await?;
    assert_eq!(team["team_id"], "release");
    assert_eq!(team["max_concurrency"], 2);
    let update = cli(
        &[
            "team",
            "--gateway",
            &public,
            "update",
            "Release review",
            "--clear-concurrency",
        ],
        &operator_token,
    )
    .await?;
    assert!(update["max_concurrency"].is_null());
    assert_eq!(update["revision"], 2);
    let objective = cli(
        &[
            "objective",
            "--gateway",
            &public,
            "create",
            "rollout",
            "--owner",
            "engineer",
            "--team",
            "Release review",
            "Verify the rollout",
        ],
        &operator_token,
    )
    .await?;
    assert_eq!(objective["team_id"], "release");

    let channel = Channel::from_shared(public.clone())?
        .timeout(WAIT)
        .connect()
        .await?;
    let mut worker = worker_host_client::WorkerHostClient::new(channel.clone());
    let mut attempts = attempt_workstreams_client::AttemptWorkstreamsClient::new(channel.clone());
    let mut teams = teams_client::TeamsClient::new(channel.clone());
    let mut mailbox = mailbox_client::MailboxClient::new(channel.clone());
    let mut attempt_mailbox = attempt_mailbox_client::AttemptMailboxClient::new(channel);
    assert_eq!(
        teams
            .list_teams(authenticated_request(
                ListTeamsRequest::default(),
                &host_token,
                Some("operator:local")
            )?)
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated,
    );
    let host = worker
        .register_host(authenticated_request(
            RegisterHostRequest {
                incarnation_id: "team-test-host".into(),
            },
            &host_token,
            None,
        )?)
        .await?
        .into_inner();
    let assignment = worker
        .claim_task(host_request(
            ClaimTaskRequest {
                operation_id: "claim-rollout".into(),
                ..Default::default()
            },
            &host_token,
            host.generation,
        )?)
        .await?
        .into_inner()
        .assignment
        .context("expected Objective's first Task")?;
    let task = assignment.task.context("missing claimed Task")?;
    assert_eq!(task.task_id, objective["starting_task_id"]);
    let attempt = InspectAttemptRequest {
        task_id: task.task_id,
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    };
    let post = PostAttemptWorkstreamRequest {
        attempt: Some(attempt.clone()),
        operation_id: "verified-rollout".into(),
        body: "The rollout checks passed.".into(),
        ..Default::default()
    };
    assert_eq!(
        attempts
            .post_attempt_workstream(host_request(
                post.clone(),
                &operator_token,
                host.generation
            )?)
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated,
    );
    assert_eq!(
        attempts
            .post_attempt_workstream(host_request(post.clone(), &host_token, host.generation)?)
            .await
            .unwrap_err()
            .code(),
        Code::FailedPrecondition,
    );
    worker
        .start_task(host_request(
            StartTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
            },
            &host_token,
            host.generation,
        )?)
        .await?;
    let posted = attempts
        .post_attempt_workstream(host_request(post.clone(), &host_token, host.generation)?)
        .await?
        .into_inner();
    let replay = attempts
        .post_attempt_workstream(host_request(post, &host_token, host.generation)?)
        .await?
        .into_inner();
    assert!(!posted.duplicate && replay.duplicate);
    assert_eq!(posted.post, replay.post);
    let page = cli(
        &["team", "--gateway", &public, "posts", "Release review"],
        &operator_token,
    )
    .await?;
    assert_eq!(page["posts"][0]["body"], "The rollout checks passed.");
    assert_eq!(page["posts"][0]["author_tag_id"], "engineer");
    assert_eq!(page["posts"][0]["sequence"], 1);
    assert_eq!(page["posts"].as_array().context("missing posts")?.len(), 1);

    let addressed_request = PostAttemptWorkstreamRequest {
        attempt: Some(attempt.clone()),
        operation_id: "address-reviewer".into(),
        body: "Please independently verify the rollback steps.".into(),
        to_tag_ids: vec!["reviewer".into()],
    };
    let addressed = attempts
        .post_attempt_workstream(host_request(
            addressed_request.clone(),
            &host_token,
            host.generation,
        )?)
        .await?
        .into_inner();
    assert!(!addressed.duplicate);
    let duplicate = attempts
        .post_attempt_workstream(host_request(
            addressed_request,
            &host_token,
            host.generation,
        )?)
        .await?
        .into_inner();
    assert!(duplicate.duplicate);
    assert_eq!(duplicate.post, addressed.post);
    let list = ListMailboxMessagesRequest {
        tag_id: "reviewer".into(),
        ..Default::default()
    };
    // The public Gateway rejects a host credential even with a forged operator
    // principal. The native Attempt API infers its Tag from owned authority.
    assert_eq!(
        mailbox
            .list_messages(authenticated_request(
                list.clone(),
                &host_token,
                Some("operator:local")
            )?)
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    let pending = mailbox
        .list_messages(authenticated_request(list.clone(), &operator_token, None)?)
        .await?
        .into_inner();
    assert_eq!(pending.messages.len(), 1);
    let message = pending.messages[0].clone();
    assert_eq!(message.state(), TagMessageState::Pending);
    assert_eq!(message.task_id, None);
    assert_eq!(message.source_task_id, attempt.task_id);
    assert_eq!(
        message.workstream_post_id,
        addressed.post.context("addressed post")?.post_id
    );
    assert_eq!(message.objective_id.as_deref(), Some("rollout"));
    let inbox = worker
        .claim_task(host_request(
            ClaimTaskRequest {
                operation_id: "claim-inbox".into(),
                ..Default::default()
            },
            &host_token,
            host.generation,
        )?)
        .await?
        .into_inner()
        .assignment
        .context("addressed post must wake reviewer")?;
    let claimed = inbox.task.context("inbox Task")?;
    assert_eq!(claimed.tag_id, "reviewer");
    assert_eq!(claimed.session_id, "inbox:reviewer");
    let inbox_attempt = InspectAttemptRequest {
        task_id: claimed.task_id,
        attempt_id: inbox.attempt_id,
        lease_token: inbox.lease_token,
    };
    let read = ReadMailboxRequest {
        attempt: Some(inbox_attempt.clone()),
        ..Default::default()
    };
    assert_eq!(
        attempt_mailbox
            .read_mailbox(host_request(read.clone(), &host_token, host.generation)?)
            .await
            .unwrap_err()
            .code(),
        Code::FailedPrecondition
    );
    let running = worker
        .start_task(host_request(
            StartTaskRequest {
                task_id: inbox_attempt.task_id.clone(),
                attempt_id: inbox_attempt.attempt_id.clone(),
                lease_token: inbox_attempt.lease_token.clone(),
            },
            &host_token,
            host.generation,
        )?)
        .await?
        .into_inner();
    assert_eq!(running.instructions, "Verify changes");
    assert!(
        running
            .prompt
            .contains("Please independently verify the rollback steps.")
    );
    assert!(running.prompt.contains("via=\"workstream post\""));
    assert!(running.prompt.contains(&message.message_id));
    let read_result = attempt_mailbox
        .read_mailbox(host_request(read, &host_token, host.generation)?)
        .await?
        .into_inner();
    assert_eq!(read_result.messages.len(), 1);
    assert_eq!(
        read_result.messages[0].task_id.as_deref(),
        Some(inbox_attempt.task_id.as_str())
    );
    let settled = worker
        .finish_task(host_request(
            FinishTaskRequest {
                task_id: inbox_attempt.task_id.clone(),
                attempt_id: inbox_attempt.attempt_id.clone(),
                lease_token: inbox_attempt.lease_token.clone(),
                succeeded: true,
                result: "Rollback steps independently verified".into(),
                ..Default::default()
            },
            &host_token,
            host.generation,
        )?)
        .await?
        .into_inner();
    assert_eq!(settled.state(), TaskState::Succeeded);
    let handled = mailbox
        .list_messages(authenticated_request(list, &operator_token, None)?)
        .await?
        .into_inner();
    assert_eq!(handled.messages.len(), 1);
    assert_eq!(handled.messages[0].message_id, message.message_id);
    assert_eq!(handled.messages[0].state(), TagMessageState::Handled);
    assert!(
        worker
            .claim_task(host_request(
                ClaimTaskRequest {
                    operation_id: "no-duplicate-inbox".into(),
                    ..Default::default()
                },
                &host_token,
                host.generation
            )?)
            .await?
            .into_inner()
            .assignment
            .is_none()
    );

    gateway.kill().await?;
    plane.kill().await?;
    Ok(())
}
