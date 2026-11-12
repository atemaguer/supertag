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
#[cfg(feature = "test-fixtures")]
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
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

#[cfg(feature = "test-fixtures")]
#[tokio::test]
async fn direct_mailbox_grants_and_private_harness_delivery_survive_gateway_restart() -> Result<()>
{
    let directory = tempfile::tempdir()?;
    let service_token = Uuid::new_v4().to_string();
    let operator_token = Uuid::new_v4().to_string();
    let host_token = Uuid::new_v4().to_string();
    let mut plane_command = command(&["control-plane"]);
    plane_command
        .env("SUPERTAG_GATEWAY_TOKEN", &service_token)
        .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
        .env(
            "SUPERTAG_DATABASE_URL",
            format!(
                "sqlite://{}?mode=rwc",
                directory.path().join("mailbox.db").display()
            ),
        );
    let (mut plane, private) = service(plane_command).await?;
    let gateway_command = || {
        let mut cmd = command(&["gateway", "--control-plane", &private]);
        cmd.env("SUPERTAG_GATEWAY_TOKEN", &service_token)
            .env("SUPERTAG_OPERATOR_TOKEN", &operator_token);
        cmd
    };
    let (mut gateway, public) = service(gateway_command()).await?;
    for tag in ["sender", "recipient", "observer"] {
        cli(
            &[
                "put-tag",
                "--gateway",
                &public,
                tag,
                "--instructions",
                "Original identity",
            ],
            &operator_token,
        )
        .await?;
    }
    // The sender shares no Team with either recipient. Only the directional
    // grant permits the private effect; the shared Team must see no post.
    cli(
        &[
            "team",
            "--gateway",
            &public,
            "create",
            "readers",
            "--member",
            "recipient",
            "--member",
            "observer",
        ],
        &operator_token,
    )
    .await?;
    let allow = [
        "mailbox-grants",
        "--gateway",
        &public,
        "allow",
        "sender",
        "recipient",
        "--operation-id",
        "allow-recipient",
    ];
    let denied = timeout(
        WAIT,
        command(&allow)
            .env("SUPERTAG_OPERATOR_TOKEN", &host_token)
            .output(),
    )
    .await??;
    ensure!(
        !denied.status.success(),
        "host credential changed operator grants"
    );
    let first = cli(&allow, &operator_token).await?;
    assert_eq!(first["changed"], true);
    assert_eq!(first["action"], "allow");
    assert_eq!(cli(&allow, &operator_token).await?, first);
    cli(
        &[
            "mailbox-grants",
            "--gateway",
            &public,
            "allow",
            "sender",
            "observer",
        ],
        &operator_token,
    )
    .await?;
    let page = cli(
        &[
            "mailbox-grants",
            "--gateway",
            &public,
            "list",
            "sender",
            "--limit",
            "1",
        ],
        &operator_token,
    )
    .await?;
    assert_eq!(page["grants"].as_array().context("grant page")?.len(), 1);
    let cursor = page["next_cursor"].as_str().context("grant cursor")?;
    ensure!(!cursor.is_empty());
    let next = cli(
        &[
            "mailbox-grants",
            "--gateway",
            &public,
            "list",
            "sender",
            "--limit",
            "1",
            "--cursor",
            cursor,
        ],
        &operator_token,
    )
    .await?;
    assert_eq!(
        next["grants"]
            .as_array()
            .context("second grant page")?
            .len(),
        1
    );
    assert_ne!(
        page["grants"][0]["recipient_tag_id"],
        next["grants"][0]["recipient_tag_id"]
    );
    assert_eq!(next["next_cursor"], "");
    let revoked = cli(
        &[
            "mailbox-grants",
            "--gateway",
            &public,
            "revoke",
            "sender",
            "observer",
            "--operation-id",
            "revoke-observer",
        ],
        &operator_token,
    )
    .await?;
    assert_eq!(revoked["action"], "revoke");
    assert_eq!(revoked["changed"], true);

    let submitted = cli(
        &[
            "submit",
            "--gateway",
            &public,
            "--tag",
            "sender",
            "--session",
            "coordination",
            "Send the private coordination message",
        ],
        &operator_token,
    )
    .await?;
    let host_directory = directory.path().join("host");
    let host_path = host_directory.to_str().context("host path")?;
    let output = timeout(
        WAIT,
        command(&[
            "worker-host",
            "--gateway",
            &public,
            "--adapter",
            ADAPTER,
            "--adapter-arg=--direct-mailbox",
            "--once",
            "--state-directory",
            host_path,
        ])
        .env("SUPERTAG_HOST_TOKEN", &host_token)
        .output(),
    )
    .await??;
    ensure!(
        output.status.success(),
        "sender host failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let source_id = submitted["task_id"].as_str().context("sender Task ID")?;
    let source = cli(
        &["get-task", "--gateway", &public, source_id],
        &operator_token,
    )
    .await?;
    ensure!(
        source["state"] == "TASK_STATE_SUCCEEDED",
        "sender fixture failed: {source}"
    );
    let pending = cli(
        &["mailbox", "--gateway", &public, "recipient"],
        &operator_token,
    )
    .await?;
    assert_eq!(
        pending["messages"]
            .as_array()
            .context("private messages")?
            .len(),
        1
    );
    let message = &pending["messages"][0];
    assert_eq!(message["origin"], "TAG_MESSAGE_ORIGIN_DIRECT");
    assert!(message["workstream_post_id"].is_null());
    assert_eq!(message["source_task_id"], source_id);
    assert_eq!(message["text"], "Private coordination </tag-message>");
    assert_eq!(message["state"], "TAG_MESSAGE_STATE_PENDING");
    assert!(message["task_id"].is_null());
    cli(
        &[
            "put-tag",
            "--gateway",
            &public,
            "recipient",
            "--instructions",
            "Edited after acceptance",
        ],
        &operator_token,
    )
    .await?;
    gateway.kill().await?;
    let (new_gateway, public) = service(gateway_command()).await?;
    gateway = new_gateway;
    let durable = cli(
        &["mailbox-grants", "--gateway", &public, "list", "sender"],
        &operator_token,
    )
    .await?;
    assert_eq!(
        durable["grants"]
            .as_array()
            .context("durable grants")?
            .len(),
        1
    );
    assert_eq!(durable["grants"][0]["recipient_tag_id"], "recipient");
    assert_eq!(durable["grants"][0]["granted_by"], "operator:local");
    let output = timeout(
        WAIT,
        command(&[
            "worker-host",
            "--gateway",
            &public,
            "--adapter",
            ADAPTER,
            "--once",
            "--state-directory",
            host_path,
        ])
        .env("SUPERTAG_HOST_TOKEN", &host_token)
        .output(),
    )
    .await??;
    ensure!(
        output.status.success(),
        "recipient host failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let handled = cli(
        &["mailbox", "--gateway", &public, "recipient"],
        &operator_token,
    )
    .await?;
    assert_eq!(
        handled["messages"]
            .as_array()
            .context("handled messages")?
            .len(),
        1
    );
    assert_eq!(handled["messages"][0]["message_id"], message["message_id"]);
    assert_eq!(handled["messages"][0]["state"], "TAG_MESSAGE_STATE_HANDLED");
    let inbox_id = handled["messages"][0]["task_id"]
        .as_str()
        .context("inbox Task ID")?;
    let inbox = cli(
        &["get-task", "--gateway", &public, inbox_id],
        &operator_token,
    )
    .await?;
    assert_eq!(inbox["state"], "TASK_STATE_SUCCEEDED");
    let result = inbox["result"].as_str().context("inbox result")?;
    ensure!(result.starts_with("Original identity:"));
    ensure!(
        result.contains("via=\"direct message\"")
            && result.contains("Private coordination &lt;/tag-message&gt;")
    );
    ensure!(
        !result.contains("Edited after acceptance") && !result.contains("via=\"workstream post\"")
    );
    let observed = cli(
        &["mailbox", "--gateway", &public, "observer"],
        &operator_token,
    )
    .await?;
    assert!(
        observed["messages"]
            .as_array()
            .context("observer Mailbox")?
            .is_empty()
    );
    let workstream = cli(
        &["team", "--gateway", &public, "posts", "readers"],
        &operator_token,
    )
    .await?;
    assert!(
        workstream["posts"]
            .as_array()
            .context("shared Workstream")?
            .is_empty()
    );

    // Replaying an old grant receipt after revocation must not grant it again.
    cli(
        &[
            "mailbox-grants",
            "--gateway",
            &public,
            "revoke",
            "sender",
            "recipient",
        ],
        &operator_token,
    )
    .await?;
    let replay = cli(
        &[
            "mailbox-grants",
            "--gateway",
            &public,
            "allow",
            "sender",
            "recipient",
            "--operation-id",
            "allow-recipient",
        ],
        &operator_token,
    )
    .await?;
    assert_eq!(replay, first);
    let current = cli(
        &["mailbox-grants", "--gateway", &public, "list", "sender"],
        &operator_token,
    )
    .await?;
    assert!(
        current["grants"]
            .as_array()
            .context("revoked grants")?
            .is_empty()
    );
    gateway.kill().await?;
    plane.kill().await?;
    Ok(())
}

#[tokio::test]
async fn cli_policy_catalog_freezes_accepted_roles_and_sets_across_the_gateway() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let gateway_token = Uuid::new_v4().to_string();
    let operator_token = Uuid::new_v4().to_string();
    let host_token = Uuid::new_v4().to_string();
    let mut plane = command(&["control-plane"]);
    plane
        .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
        .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
        .env(
            "SUPERTAG_DATABASE_URL",
            format!(
                "sqlite://{}?mode=rwc",
                directory.path().join("control.db").display()
            ),
        );
    let (_plane, private) = service(plane).await?;
    let mut gateway = command(&["gateway", "--control-plane", &private]);
    gateway
        .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
        .env("SUPERTAG_OPERATOR_TOKEN", &operator_token);
    let (_gateway, public) = service(gateway).await?;
    cli(
        &[
            "put-tag",
            "--gateway",
            &public,
            "engineer",
            "--instructions",
            "Review changes",
            "--allow",
            "files:read",
        ],
        &operator_token,
    )
    .await?;
    let permission = directory.path().join("permission.json");
    let context = directory.path().join("context.json");
    let role = directory.path().join("role.json");
    std::fs::write(
        &permission,
        r#"{"set_id":"edit","name":"edit","permissions":[{"target":"runtime","action":"files:write"}]}"#,
    )?;
    std::fs::write(
        &context,
        r#"{"set_id":"notes","name":"notes","items":[{"item_key":"policy","type":"example/notes","version":1,"config":{"text":"Review the diff"}}]}"#,
    )?;
    std::fs::write(
        &role,
        r#"{"role_id":"review","name":"review","purpose":"Review changes","instructions":"Keep the evidence.","permission_set_ids":["edit"],"context_set_ids":["notes"]}"#,
    )?;
    for (kind, file) in [
        ("permission-set", &permission),
        ("context-set", &context),
        ("role", &role),
    ] {
        let value = cli(
            &[
                "policy",
                "--gateway",
                &public,
                "put",
                kind,
                file.to_str().context("policy fixture path")?,
            ],
            &operator_token,
        )
        .await?;
        assert_eq!(value["revision"], 1);
    }
    let assignment = cli(
        &[
            "policy",
            "--gateway",
            &public,
            "assign",
            "review",
            "engineer",
            "--operation-id",
            "assign-once",
        ],
        &operator_token,
    )
    .await?;
    assert_eq!(assignment["status"], "active");
    let channel = Channel::from_shared(public.clone())?
        .timeout(WAIT)
        .connect()
        .await?;
    let mut catalog = policy_catalog_client::PolicyCatalogClient::new(channel.clone());
    let mut operator = operator_client::OperatorClient::new(channel);
    assert_eq!(
        catalog
            .list_roles(authenticated_request(
                ListPolicyResourcesRequest::default(),
                &host_token,
                Some("operator:local")
            )?)
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    let task = |operation: &str| SubmitTaskRequest {
        tag_id: "engineer".into(),
        session_id: "reviews".into(),
        operation_id: operation.into(),
        prompt: "Review the diff".into(),
    };
    let before = operator
        .submit_task(authenticated_request(
            task("before"),
            &operator_token,
            None,
        )?)
        .await?
        .into_inner();
    let snapshot = before.policy_snapshot.as_ref().context("frozen policy")?;
    assert_eq!(before.allowed_actions, ["files:read", "files:write"]);
    assert!(before.instructions.contains("Keep the evidence."));
    assert_eq!(snapshot.context_sets[0].items[0].item_key, "policy");
    let id = assignment["assignment_id"]
        .as_str()
        .context("assignment ID")?;
    let inactive = cli(
        &[
            "policy",
            "--gateway",
            &public,
            "deactivate",
            id,
            "--expected-revision",
            "1",
        ],
        &operator_token,
    )
    .await?;
    assert_eq!(inactive["status"], "inactive");
    let after = operator
        .submit_task(authenticated_request(task("after"), &operator_token, None)?)
        .await?
        .into_inner();
    assert_eq!(after.allowed_actions, ["files:read"]);
    assert!(!after.instructions.contains("Keep the evidence."));
    let replay = operator
        .submit_task(authenticated_request(
            task("before"),
            &operator_token,
            None,
        )?)
        .await?
        .into_inner();
    assert_eq!(replay, before);
    Ok(())
}

#[cfg(feature = "test-fixtures")]
#[tokio::test]
async fn workstream_approval_reaches_the_same_session_and_is_consumed_by_the_write() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let gateway_token = Uuid::new_v4().to_string();
    let operator_token = Uuid::new_v4().to_string();
    let host_token = Uuid::new_v4().to_string();
    let mut plane = command(&["control-plane"]);
    plane
        .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
        .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
        .env(
            "SUPERTAG_DATABASE_URL",
            format!(
                "sqlite://{}?mode=rwc",
                directory.path().join("control.db").display()
            ),
        );
    let (_plane, private) = service(plane).await?;
    let mut gateway = command(&["gateway", "--control-plane", &private]);
    gateway
        .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
        .env("SUPERTAG_OPERATOR_TOKEN", &operator_token);
    let (_gateway, public) = service(gateway).await?;
    cli(
        &[
            "put-tag",
            "--gateway",
            &public,
            "owner",
            "--instructions",
            "Verify rollout",
            "--require-workstream-approval",
            "--workstream-approver",
            "local",
        ],
        &operator_token,
    )
    .await?;
    cli(
        &[
            "team",
            "--gateway",
            &public,
            "create",
            "release",
            "--name",
            "Release",
            "--member",
            "owner",
        ],
        &operator_token,
    )
    .await?;
    let objective = cli(
        &[
            "objective",
            "--gateway",
            &public,
            "create",
            "rollout",
            "--owner",
            "owner",
            "--team",
            "release",
            "Verify the rollout",
        ],
        &operator_token,
    )
    .await?;

    let output = timeout(
        WAIT,
        command(&[
            "worker-host",
            "--gateway",
            &public,
            "--adapter",
            ADAPTER,
            "--adapter-arg=--workstream-approval",
            "--once",
            "--state-directory",
            directory
                .path()
                .join("host")
                .to_str()
                .context("fixture path")?,
        ])
        .env("SUPERTAG_HOST_TOKEN", &host_token)
        .output(),
    )
    .await??;
    ensure!(
        output.status.success(),
        "Worker Host failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let page = cli(
        &["inbox", "--gateway", &public, "list", "--kind", "approval"],
        &operator_token,
    )
    .await?;
    let source_id = objective["starting_task_id"]
        .as_str()
        .context("Objective Task ID")?;
    let task = cli(
        &["get-task", "--gateway", &public, source_id],
        &operator_token,
    )
    .await?;
    ensure!(
        task["state"] == "TASK_STATE_SUCCEEDED",
        "fixture Task did not finish: {task}"
    );
    let item = &page["items"][0];
    let approval_id = match item["approval"]["approval_id"].as_str() {
        Some(id) => id,
        None => {
            let history = cli(
                &["inbox", "--gateway", &public, "approvals"],
                &operator_token,
            )
            .await?;
            anyhow::bail!(
                "missing approval for fixture Task {task}; Inbox {page}; approval history {history}"
            );
        }
    };
    assert_eq!(item["task_id"], objective["starting_task_id"]);
    assert_eq!(item["operator_eligible"], true);
    assert_eq!(item["approval"]["resource"], "release");
    let detail = cli(
        &["inbox", "--gateway", &public, "approval", approval_id],
        &operator_token,
    )
    .await?;
    let message = "The rollout is ready.";
    assert_eq!(detail["arguments"]["body"], message);
    assert_eq!(detail["action"], "workstream:post");
    assert_eq!(detail["state"], "pending");

    let channel = Channel::from_shared(public.clone())?
        .timeout(WAIT)
        .connect()
        .await?;
    let mut worker = worker_host_client::WorkerHostClient::new(channel.clone());
    let mut workstreams =
        attempt_workstreams_client::AttemptWorkstreamsClient::new(channel.clone());
    let mut inbox = inbox_client::InboxClient::new(channel);
    let host = worker
        .register_host(authenticated_request(
            RegisterHostRequest {
                incarnation_id: "approval-host".into(),
            },
            &host_token,
            None,
        )?)
        .await?
        .into_inner();
    let claim_request = |operation_id: &str| {
        host_request(
            ClaimTaskRequest {
                operation_id: operation_id.into(),
                ..Default::default()
            },
            &host_token,
            host.generation,
        )
    };
    let start_request = |attempt: &InspectAttemptRequest| {
        host_request(
            StartTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
            },
            &host_token,
            host.generation,
        )
    };
    let send = |attempt: &InspectAttemptRequest, operation_id: &str, body: &str| {
        host_request(
            PostAttemptWorkstreamRequest {
                attempt: Some(attempt.clone()),
                operation_id: operation_id.into(),
                body: body.into(),
                to_tag_ids: vec![],
            },
            &host_token,
            host.generation,
        )
    };
    assert_eq!(
        inbox
            .get_approval(authenticated_request(
                GetApprovalRequest {
                    approval_id: approval_id.into(),
                },
                &host_token,
                Some("operator:local")
            )?)
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    let decision_args = [
        "inbox",
        "--gateway",
        &public,
        "approve",
        approval_id,
        "--operation-id",
        "decide-post",
    ];
    let decision = cli(&decision_args, &operator_token).await?;
    let replay = cli(&decision_args, &operator_token).await?;
    assert_eq!(decision, replay);
    assert_eq!(decision["scope"], "once");
    let assignment = worker
        .claim_task(claim_request("continuation")?)
        .await?
        .into_inner()
        .assignment
        .context("approval continuation")?;
    let next = assignment.task.context("continued Task")?;
    assert_eq!(next.session_id, objective["session_id"]);
    assert_eq!(next.task_id, decision["continuation_task_id"]);
    let next = InspectAttemptRequest {
        task_id: next.task_id,
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    };
    worker.start_task(start_request(&next)?).await?;
    let posted = workstreams
        .post_attempt_workstream(send(&next, "post-after-approval", message)?)
        .await?
        .into_inner();
    assert_eq!(
        posted.post.context("approved Workstream effect")?.body,
        message
    );
    let duplicate = workstreams
        .post_attempt_workstream(send(&next, "post-after-approval", message)?)
        .await?
        .into_inner();
    assert!(duplicate.duplicate);
    let different = workstreams
        .post_attempt_workstream(send(&next, "changed", "Different message")?)
        .await?
        .into_inner();
    assert!(different.post.is_none());
    assert_eq!(
        different.approval.context("new request")?.state(),
        ApprovalState::Pending
    );
    assert_eq!(
        workstreams
            .post_attempt_workstream(send(&next, "changed", message)?)
            .await
            .unwrap_err()
            .code(),
        Code::AlreadyExists
    );
    let used = cli(
        &["inbox", "--gateway", &public, "approval", approval_id],
        &operator_token,
    )
    .await?;
    assert!(used["consumed_at_ms"].is_i64());
    let page = cli(
        &["team", "--gateway", &public, "posts", "release"],
        &operator_token,
    )
    .await?;
    assert_eq!(
        page["posts"].as_array().context("Workstream posts")?.len(),
        1
    );
    Ok(())
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
        Some(addressed.post.context("addressed post")?.post_id)
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

#[tokio::test]
async fn objective_questions_survive_gateway_restart_and_answer_once() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let service_token = Uuid::new_v4().to_string();
    let operator_token = Uuid::new_v4().to_string();
    let host_token = Uuid::new_v4().to_string();
    let mut plane_command = command(&["control-plane"]);
    plane_command
        .env("SUPERTAG_GATEWAY_TOKEN", &service_token)
        .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
        .env(
            "SUPERTAG_DATABASE_URL",
            format!(
                "sqlite://{}?mode=rwc",
                directory.path().join("questions.db").display()
            ),
        );
    let (mut plane, private) = service(plane_command).await?;
    let gateway_command = || {
        let mut cmd = command(&["gateway", "--control-plane", &private]);
        cmd.env("SUPERTAG_GATEWAY_TOKEN", &service_token)
            .env("SUPERTAG_OPERATOR_TOKEN", &operator_token);
        cmd
    };
    let (mut gateway, public) = service(gateway_command()).await?;
    cli(
        &[
            "put-tag",
            "--gateway",
            &public,
            "owner",
            "--instructions",
            "Ask before choosing a release route",
        ],
        &operator_token,
    )
    .await?;
    let objective = cli(
        &[
            "objective",
            "--gateway",
            &public,
            "create",
            "question-flow",
            "--owner",
            "owner",
            "Choose a release route",
        ],
        &operator_token,
    )
    .await?;
    let channel = Channel::from_shared(public.clone())?
        .timeout(WAIT)
        .connect()
        .await?;
    let mut worker = worker_host_client::WorkerHostClient::new(channel.clone());
    let mut inbox = inbox_client::InboxClient::new(channel);
    let host = worker
        .register_host(authenticated_request(
            RegisterHostRequest {
                incarnation_id: "inbox-runtime-host".into(),
            },
            &host_token,
            None,
        )?)
        .await?
        .into_inner();
    let assignment = worker
        .claim_task(host_request(
            ClaimTaskRequest {
                operation_id: "claim-question".into(),
                ..Default::default()
            },
            &host_token,
            host.generation,
        )?)
        .await?
        .into_inner()
        .assignment
        .context("Objective starting Task")?;
    let task = assignment.task.context("Task")?;
    assert_eq!(task.task_id, objective["starting_task_id"]);
    let attempt = InspectAttemptRequest {
        task_id: task.task_id,
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    };
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
    let ask = AskQuestionRequest {
        attempt: Some(attempt.clone()),
        operation_id: "ask-route".into(),
        text: "Which release route should I use?".into(),
    };
    assert_eq!(
        worker
            .ask_question(host_request(ask.clone(), &operator_token, host.generation)?)
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    let staged = worker
        .ask_question(host_request(ask.clone(), &host_token, host.generation)?)
        .await?
        .into_inner();
    assert!(staged.published_at_ms.is_none());
    assert!(
        inbox
            .list_items(authenticated_request(
                ListInboxItemsRequest::default(),
                &operator_token,
                None
            )?)
            .await?
            .into_inner()
            .items
            .is_empty()
    );
    worker
        .finish_task(host_request(
            FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                result: "Waiting for the release route".into(),
                succeeded: true,
                ..Default::default()
            },
            &host_token,
            host.generation,
        )?)
        .await?;
    assert!(
        worker
            .ask_question(host_request(ask, &host_token, host.generation)?)
            .await?
            .into_inner()
            .published_at_ms
            .is_some()
    );
    let listed = cli(&["inbox", "--gateway", &public, "list"], &operator_token).await?;
    assert_eq!(listed["items"].as_array().context("Inbox items")?.len(), 1);
    assert_eq!(listed["items"][0]["task_id"], attempt.task_id);
    assert_eq!(
        inbox
            .get_question(authenticated_request(
                GetQuestionRequest {
                    task_id: attempt.task_id.clone()
                },
                &host_token,
                Some("operator:local")
            )?)
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    // The durable question is owned by the Control Plane and remains answerable
    // after the entire public ingress process is replaced.
    gateway.kill().await?;
    let (restarted, public) = service(gateway_command()).await?;
    gateway = restarted;
    let question = cli(
        &["inbox", "--gateway", &public, "question", &attempt.task_id],
        &operator_token,
    )
    .await?;
    assert_eq!(question["text"], "Which release route should I use?");
    let answer_args = [
        "inbox",
        "--gateway",
        &public,
        "answer",
        &attempt.task_id,
        "Use the staged route",
        "--operation-id",
        "answer-route",
    ];
    let answer = cli(&answer_args, &operator_token).await?;
    assert_eq!(answer["tag_id"], "owner");
    let replay = cli(&answer_args, &operator_token).await?;
    assert_eq!(replay["task_id"], answer["task_id"]);
    assert!(
        cli(&["inbox", "--gateway", &public, "list"], &operator_token).await?["items"]
            .as_array()
            .context("Inbox items")?
            .is_empty()
    );
    let channel = Channel::from_shared(public)?
        .timeout(WAIT)
        .connect()
        .await?;
    let mut worker = worker_host_client::WorkerHostClient::new(channel);
    let next = worker
        .claim_task(host_request(
            ClaimTaskRequest {
                operation_id: "claim-answer".into(),
                ..Default::default()
            },
            &host_token,
            host.generation,
        )?)
        .await?
        .into_inner()
        .assignment
        .context("one answer continuation")?;
    let next_task = next.task.context("answer Task")?;
    assert_eq!(next_task.task_id, answer["task_id"]);
    assert_eq!(next_task.session_id, objective["session_id"]);
    assert_eq!(next_task.prompt, "Use the staged route");
    assert!(
        worker
            .claim_task(host_request(
                ClaimTaskRequest {
                    operation_id: "no-second-answer".into(),
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
