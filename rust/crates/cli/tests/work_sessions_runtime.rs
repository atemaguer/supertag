#![cfg(feature = "test-fixtures")]

#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[path = "support/protocol.rs"]
mod protocol;
#[macro_use]
#[path = "support/database.rs"]
mod database;

use std::{net::SocketAddr, path::Path, process::Stdio, time::Duration};
use supertag_protocol::negotiation::ProtocolChannel;

use anyhow::{Context, Result, ensure};
use supertag_protocol::{authenticated_request, v2::*};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::{sleep, timeout},
};
use tonic::{Code, transport::Channel};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
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
    let mut output = BufReader::new(child.stdout.take().context("service stdout")?);
    let mut ready = String::new();
    timeout(WAIT, output.read_line(&mut ready)).await??;
    let address: SocketAddr = ready.trim().parse().context("service bind address")?;
    ensure!(address.ip().is_loopback() && address.port() != 0);
    Ok((child, format!("http://{address}")))
}

fn gateway(private: &str, service_token: &str, token: &str, principal: &str) -> Command {
    let mut command = command(&["gateway", "--control-plane", private]);
    command
        .env("SUPERTAG_GATEWAY_TOKEN", service_token)
        .env("SUPERTAG_OPERATOR_TOKEN", token)
        .env("SUPERTAG_OPERATOR_PRINCIPAL", principal);
    command
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

async fn cli(args: &[&str], token: &str) -> Result<serde_json::Value> {
    let output = timeout(
        WAIT,
        command(args).env("SUPERTAG_OPERATOR_TOKEN", token).output(),
    )
    .await??;
    ensure!(
        output.status.success(),
        "CLI failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}

async fn run_host(public: &str, token: &str, state: &Path, mode: &str) -> Result<()> {
    let argument = format!("--adapter-arg={mode}");
    let output = timeout(
        WAIT,
        command(&[
            "worker-host",
            "--gateway",
            public,
            "--state-directory",
            state.to_str().context("Host state path")?,
            "--adapter",
            ADAPTER,
            &argument,
            "--once",
        ])
        .env("SUPERTAG_HOST_TOKEN", token)
        .output(),
    )
    .await??;
    ensure!(
        output.status.success(),
        "Worker Host failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

async fn wait_for_work(
    client: &mut work_sessions_client::WorkSessionsClient<ProtocolChannel>,
    token: &str,
    id: &str,
    predicate: impl Fn(&WorkSession) -> bool,
) -> Result<WorkSession> {
    timeout(WAIT, async {
        loop {
            let work = client
                .get(authenticated_request(
                    GetWorkSessionRequest {
                        work_session_id: id.into(),
                        report_task_id: None,
                    },
                    token,
                    None,
                )?)
                .await?
                .into_inner();
            if predicate(&work) {
                return Ok(work);
            }
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .context("Work Session did not reach expected state")?
}

database_tests! {
    #[tokio::test]
    private_harness_work_session_reports_once_after_service_restart;
    #[tokio::test]
    private_child_question_continues_once_and_keeps_both_parent_reports;
    #[tokio::test]
    objective_owner_delegates_to_team_tag_with_frozen_action_ceiling;
    #[tokio::test]
    objective_pool_allocates_real_attempt_reports_and_reopens_when_raised;
}

async fn private_harness_work_session_reports_once_after_service_restart(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let service_token = Uuid::new_v4().to_string();
    let alice_token = Uuid::new_v4().to_string();
    let bob_token = Uuid::new_v4().to_string();
    let host_token = Uuid::new_v4().to_string();
    let plane_command = || {
        let mut command = command(&["control-plane"]);
        command
            .env("SUPERTAG_GATEWAY_TOKEN", &service_token)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
            .env("SUPERTAG_DATABASE_URL", &database);
        command
    };
    let (mut plane, private) = service(plane_command()).await?;
    let (mut alice_gateway, public) = service(gateway(
        &private,
        &service_token,
        &alice_token,
        "operator:alice",
    ))
    .await?;
    let (mut bob_gateway, bob_public) = service(gateway(
        &private,
        &service_token,
        &bob_token,
        "operator:bob",
    ))
    .await?;
    let connected = channel(&public).await?;
    let mut operator = operator_client::OperatorClient::new(connected.clone());
    let mut conversations = conversations_client::ConversationsClient::new(connected.clone());
    let mut work = work_sessions_client::WorkSessionsClient::new(connected);
    operator
        .put_tag(authenticated_request(
            PutTagRequest {
                tag_id: "owner".into(),
                instructions: "Keep the accepted policy".into(),
                allowed_actions: vec!["files:read".into()],
                ..Default::default()
            },
            &alice_token,
            None,
        )?)
        .await?;
    let source = conversations
        .send_message(authenticated_request(
            SendMessageRequest {
                output_policy: None,
                execution_limits: None,
                tag_id: "owner".into(),
                conversation: "private".into(),
                text: "Investigate this privately".into(),
                operation_id: "start-parent".into(),
            },
            &alice_token,
            None,
        )?)
        .await?
        .into_inner()
        .task
        .context("root Task")?;
    let host_state = directory.path().join("host");
    run_host(&public, &host_token, &host_state, "--start-work-session").await?;
    let settled = operator
        .get_task(authenticated_request(
            GetTaskRequest {
                task_id: source.task_id.clone(),
            },
            &alice_token,
            None,
        )?)
        .await?
        .into_inner();
    ensure!(
        settled.state() == TaskState::Succeeded,
        "root fixture failed: {:?}",
        settled.result
    );
    let list = ListWorkSessionsRequest {
        parent_tag_id: source.tag_id.clone(),
        parent_session_id: source.session_id.clone(),
        starter_task_id: Some(source.task_id.clone()),
        limit: 10,
        cursor: String::new(),
    };
    assert_eq!(
        work.list(authenticated_request(
            list.clone(),
            &host_token,
            Some("operator:alice")
        )?)
        .await
        .unwrap_err()
        .code(),
        Code::Unauthenticated
    );
    let page = work
        .list(authenticated_request(list.clone(), &alice_token, None)?)
        .await?
        .into_inner();
    assert_eq!(page.work_sessions.len(), 1);
    let started = &page.work_sessions[0];
    assert_eq!(started.parent_session_id, source.session_id);
    assert_eq!(started.starter_task_id, source.task_id);
    assert_eq!(started.tag_id, "owner");
    assert_eq!(started.latest_task_state(), TaskState::Queued);
    assert!(started.report_task_id.is_none());
    let get = GetWorkSessionRequest {
        work_session_id: started.work_session_id.clone(),
        report_task_id: None,
    };
    let mut bob = work_sessions_client::WorkSessionsClient::new(channel(&bob_public).await?);
    let blocked = bob
        .get(authenticated_request(
            get.clone(),
            &bob_token,
            Some("operator:alice"),
        )?)
        .await
        .unwrap_err();
    ensure!(
        matches!(blocked.code(), Code::PermissionDenied | Code::NotFound),
        "other operator read private work: {blocked}"
    );
    match bob
        .list(authenticated_request(
            list.clone(),
            &bob_token,
            Some("operator:alice"),
        )?)
        .await
    {
        Ok(page) => ensure!(
            page.into_inner().work_sessions.is_empty(),
            "other operator listed private work"
        ),
        Err(status) => ensure!(matches!(
            status.code(),
            Code::PermissionDenied | Code::NotFound
        )),
    }
    operator
        .put_tag(authenticated_request(
            PutTagRequest {
                tag_id: "owner".into(),
                instructions: "Edited after child acceptance".into(),
                allowed_actions: vec![],
                ..Default::default()
            },
            &alice_token,
            None,
        )?)
        .await?;
    run_host(
        &public,
        &host_token,
        &host_state,
        "--reject-work-session-start",
    )
    .await?;
    let reported = wait_for_work(&mut work, &alice_token, &started.work_session_id, |w| {
        w.report_task_id.is_some()
    })
    .await?;
    assert_eq!(reported.latest_task_state(), TaskState::Succeeded);
    assert_eq!(reported.report_task_state(), TaskState::Queued);
    let child = operator
        .get_task(authenticated_request(
            GetTaskRequest {
                task_id: started.latest_task_id.clone(),
            },
            &alice_token,
            None,
        )?)
        .await?
        .into_inner();
    assert!(
        child
            .result
            .as_deref()
            .context("child result")?
            .starts_with("Keep the accepted policy:")
    );
    assert_eq!(child.allowed_actions, ["files:read"]);
    let report_id = reported
        .report_task_id
        .clone()
        .context("durable report Task")?;
    // Restart both services after the child settled but before its parent report
    // executes. Neither report delivery nor child execution may be duplicated.
    bob_gateway.kill().await?;
    alice_gateway.kill().await?;
    plane.kill().await?;
    let (new_plane, private) = service(plane_command()).await?;
    plane = new_plane;
    let (new_gateway, public) = service(gateway(
        &private,
        &service_token,
        &alice_token,
        "operator:alice",
    ))
    .await?;
    alice_gateway = new_gateway;
    let connected = channel(&public).await?;
    work = work_sessions_client::WorkSessionsClient::new(connected.clone());
    conversations = conversations_client::ConversationsClient::new(connected.clone());
    operator = operator_client::OperatorClient::new(connected);
    let recovered = work
        .get(authenticated_request(get, &alice_token, None)?)
        .await?
        .into_inner();
    assert_eq!(
        recovered.report_task_id.as_deref(),
        Some(report_id.as_str())
    );
    assert_eq!(recovered.latest_task_id, started.latest_task_id);
    run_host(
        &public,
        &host_token,
        &host_state,
        "--reject-work-session-start",
    )
    .await?;
    let completed = wait_for_work(&mut work, &alice_token, &started.work_session_id, |w| {
        w.report_task_state() == TaskState::Succeeded
    })
    .await?;
    assert_eq!(
        completed.report_task_id.as_deref(),
        Some(report_id.as_str())
    );
    let report = operator
        .get_task(authenticated_request(
            GetTaskRequest {
                task_id: report_id.clone(),
            },
            &alice_token,
            None,
        )?)
        .await?
        .into_inner();
    assert_eq!(report.session_id, source.session_id);
    assert_eq!(report.allowed_actions, ["files:read"]);
    assert!(report.instructions.contains("Keep the accepted policy"));
    assert!(
        !report
            .instructions
            .contains("Edited after child acceptance")
    );
    assert!(report.prompt.contains("Inspect child evidence"));
    assert!(report.prompt.contains("&lt;/work-session-result>"));
    let messages = conversations
        .list_messages(authenticated_request(
            ListMessagesRequest {
                tag_id: "owner".into(),
                conversation: "private".into(),
                limit: 10,
                cursor: String::new(),
            },
            &alice_token,
            None,
        )?)
        .await?
        .into_inner();
    assert_eq!(messages.messages.len(), 2);
    let reports: Vec<_> = messages
        .messages
        .iter()
        .filter(|m| m.work_session_report_id.is_some())
        .collect();
    assert_eq!(reports.len(), 1);
    assert_eq!(
        reports[0].work_session_report_id.as_deref(),
        Some(started.work_session_id.as_str())
    );
    assert_eq!(
        reports[0]
            .task
            .as_ref()
            .context("Conversation report Task")?
            .task_id,
        report_id
    );
    let page = work
        .list(authenticated_request(list, &alice_token, None)?)
        .await?
        .into_inner();
    assert_eq!(page.work_sessions.len(), 1);
    let detail = cli(
        &[
            "work-sessions",
            "--gateway",
            &public,
            "get",
            &started.work_session_id,
        ],
        &alice_token,
    )
    .await?;
    assert_eq!(detail["report_task_id"], report_id);
    assert_eq!(detail["report_task_state"], "TASK_STATE_SUCCEEDED");
    let listed = cli(
        &[
            "work-sessions",
            "--gateway",
            &public,
            "list",
            "--parent-tag",
            "owner",
            "--parent-session",
            &source.session_id,
            "--starter-task",
            &source.task_id,
            "--limit",
            "1",
        ],
        &alice_token,
    )
    .await?;
    assert_eq!(
        listed["work_sessions"]
            .as_array()
            .context("CLI Work Sessions")?
            .len(),
        1
    );
    assert_eq!(listed["work_sessions"][0], detail);
    assert_eq!(listed["next_cursor"], "");
    alice_gateway.kill().await?;
    plane.kill().await?;
    Ok(())
}

async fn private_child_question_continues_once_and_keeps_both_parent_reports(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let service_token = Uuid::new_v4().to_string();
    let operator_token = Uuid::new_v4().to_string();
    let host_token = Uuid::new_v4().to_string();
    let plane_command = || {
        let mut command = command(&["control-plane"]);
        command
            .env("SUPERTAG_GATEWAY_TOKEN", &service_token)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
            .env("SUPERTAG_DATABASE_URL", &database);
        command
    };
    let (mut plane, private) = service(plane_command()).await?;
    let (mut gateway_process, public) = service(gateway(
        &private,
        &service_token,
        &operator_token,
        "operator:alice",
    ))
    .await?;
    let connected = channel(&public).await?;
    let mut operator = operator_client::OperatorClient::new(connected.clone());
    let mut conversations = conversations_client::ConversationsClient::new(connected.clone());
    let mut attempts =
        attempt_work_sessions_client::AttemptWorkSessionsClient::new(connected.clone());
    assert_eq!(
        attempts
            .ask(authenticated_request(
                AskWorkSessionQuestionRequest {
                    attempt: None,
                    operation_id: "operator-cannot-ask-as-child".into(),
                    text: "Unbound question".into(),
                },
                &operator_token,
                None
            )?)
            .await
            .expect_err("operator credential used as a Host")
            .code(),
        Code::Unauthenticated
    );
    assert_eq!(
        attempts
            .r#continue(authenticated_request(
                ContinueWorkSessionRequest {
                    attempt: None,
                    operation_id: "operator-cannot-continue-as-parent".into(),
                    work_session_id: "work/none".into(),
                    message: "Unbound continuation".into(),
                },
                &operator_token,
                None
            )?)
            .await
            .expect_err("operator credential used as a Host")
            .code(),
        Code::Unauthenticated
    );
    let mut work = work_sessions_client::WorkSessionsClient::new(connected);
    operator
        .put_tag(authenticated_request(
            PutTagRequest {
                tag_id: "owner".into(),
                instructions: "Inspect the requested region".into(),
                ..Default::default()
            },
            &operator_token,
            None,
        )?)
        .await?;
    let first_parent = conversations
        .send_message(authenticated_request(
            SendMessageRequest {
                output_policy: None,
                execution_limits: None,
                tag_id: "owner".into(),
                conversation: "private".into(),
                text: "Inspect the region".into(),
                operation_id: "initial-parent".into(),
            },
            &operator_token,
            None,
        )?)
        .await?
        .into_inner()
        .task
        .context("initial parent")?;
    let host_state = directory.path().join("host");
    run_host(&public, &host_token, &host_state, "--start-work-session").await?;
    let list_request = |parent: &Task| ListWorkSessionsRequest {
        parent_tag_id: parent.tag_id.clone(),
        parent_session_id: parent.session_id.clone(),
        starter_task_id: Some(parent.task_id.clone()),
        limit: 4,
        cursor: String::new(),
    };
    let first_page = work
        .list(authenticated_request(
            list_request(&first_parent),
            &operator_token,
            None,
        )?)
        .await?
        .into_inner();
    ensure!(first_page.work_sessions.len() == 1, "initial child missing");
    let initial = first_page.work_sessions[0].clone();
    run_host(&public, &host_token, &host_state, "--ask-work-session").await?;
    let asked = wait_for_work(&mut work, &operator_token, &initial.work_session_id, |w| {
        w.report_task_id.is_some()
    })
    .await?;
    ensure!(
        asked.latest_task_state() == TaskState::Succeeded,
        "child question failed: {asked:?}"
    );
    let question = asked
        .question
        .as_ref()
        .context("published child question")?;
    ensure!(
        question.task_id == initial.latest_task_id
            && question.published_at_ms.is_some()
            && question.answer_task_id.is_none()
    );
    let first_report_id = asked.report_task_id.clone().context("first report")?;
    let first_report = operator
        .get_task(authenticated_request(
            GetTaskRequest {
                task_id: first_report_id.clone(),
            },
            &operator_token,
            None,
        )?)
        .await?
        .into_inner();
    ensure!(
        first_report.prompt.contains("Which region?")
            && first_report.prompt.contains("&lt;/work-session-question>"),
        "question was missing or not escaped in report"
    );
    run_host(
        &public,
        &host_token,
        &host_state,
        "--reject-work-session-start",
    )
    .await?;
    wait_for_work(&mut work, &operator_token, &initial.work_session_id, |w| {
        w.report_task_state() == TaskState::Succeeded
    })
    .await?;

    // A later real parent Task owns the continuation. The first parent report
    // is already complete, so this cannot race it for the parent Session.
    let next_parent = conversations
        .send_message(authenticated_request(
            SendMessageRequest {
                output_policy: None,
                execution_limits: None,
                tag_id: "owner".into(),
                conversation: "private".into(),
                text: "Use us-east-1".into(),
                operation_id: "answer-parent".into(),
            },
            &operator_token,
            None,
        )?)
        .await?
        .into_inner()
        .task
        .context("answer parent")?;
    let mode = format!("--continue-work-session={}", initial.work_session_id);
    run_host(&public, &host_token, &host_state, &mode).await?;
    let continued_page = work
        .list(authenticated_request(
            list_request(&next_parent),
            &operator_token,
            None,
        )?)
        .await?
        .into_inner();
    ensure!(
        continued_page.work_sessions.len() == 1,
        "continuation missing: {continued_page:?}"
    );
    let continued = &continued_page.work_sessions[0];
    ensure!(
        continued.work_session_id == initial.work_session_id
            && continued.latest_task_id != initial.latest_task_id
            && continued.starter_task_id == next_parent.task_id
            && continued.report_task_id.is_none()
    );
    let second_child_id = continued.latest_task_id.clone();
    let first_history = work
        .get(authenticated_request(
            GetWorkSessionRequest {
                work_session_id: initial.work_session_id.clone(),
                report_task_id: Some(first_report_id.clone()),
            },
            &operator_token,
            None,
        )?)
        .await?
        .into_inner();
    ensure!(
        first_history.latest_task_id == initial.latest_task_id
            && first_history.starter_task_id == first_parent.task_id
            && first_history.report_task_id.as_deref() == Some(first_report_id.as_str())
    );
    ensure!(
        first_history
            .question
            .as_ref()
            .and_then(|q| q.answer_task_id.as_deref())
            == Some(second_child_id.as_str())
    );
    run_host(
        &public,
        &host_token,
        &host_state,
        "--reject-work-session-start",
    )
    .await?;
    let second_report = wait_for_work(&mut work, &operator_token, &initial.work_session_id, |w| {
        w.report_task_id.is_some() && w.latest_task_id == second_child_id
    })
    .await?;
    let second_report_id = second_report
        .report_task_id
        .clone()
        .context("second report")?;
    ensure!(second_report_id != first_report_id);

    gateway_process.kill().await?;
    plane.kill().await?;
    let (restarted, private) = service(plane_command()).await?;
    plane = restarted;
    let (restarted, public) = service(gateway(
        &private,
        &service_token,
        &operator_token,
        "operator:alice",
    ))
    .await?;
    gateway_process = restarted;
    let connected = channel(&public).await?;
    work = work_sessions_client::WorkSessionsClient::new(connected.clone());
    conversations = conversations_client::ConversationsClient::new(connected.clone());
    operator = operator_client::OperatorClient::new(connected);
    run_host(
        &public,
        &host_token,
        &host_state,
        "--reject-work-session-start",
    )
    .await?;
    wait_for_work(&mut work, &operator_token, &initial.work_session_id, |w| {
        w.report_task_state() == TaskState::Succeeded
    })
    .await?;
    let second_child = operator
        .get_task(authenticated_request(
            GetTaskRequest {
                task_id: second_child_id.clone(),
            },
            &operator_token,
            None,
        )?)
        .await?
        .into_inner();
    ensure!(
        second_child.state() == TaskState::Succeeded
            && second_child
                .result
                .as_deref()
                .is_some_and(|text| text.contains("Use us-east-1"))
    );
    for (parent, child_id, report_id) in [
        (&first_parent, &initial.latest_task_id, &first_report_id),
        (&next_parent, &second_child_id, &second_report_id),
    ] {
        let historical = work
            .get(authenticated_request(
                GetWorkSessionRequest {
                    work_session_id: initial.work_session_id.clone(),
                    report_task_id: Some(report_id.clone()),
                },
                &operator_token,
                None,
            )?)
            .await?
            .into_inner();
        ensure!(
            historical.latest_task_id == *child_id
                && historical.starter_task_id == parent.task_id
                && historical.report_task_id.as_ref() == Some(report_id)
                && historical.report_task_state() == TaskState::Succeeded
        );
        let scoped = work
            .list(authenticated_request(
                list_request(parent),
                &operator_token,
                None,
            )?)
            .await?
            .into_inner();
        ensure!(
            scoped.work_sessions.len() == 1 && scoped.work_sessions[0] == historical,
            "parent history changed after continuation"
        );
    }
    let unrelated = work
        .get(authenticated_request(
            GetWorkSessionRequest {
                work_session_id: initial.work_session_id.clone(),
                report_task_id: Some(next_parent.task_id.clone()),
            },
            &operator_token,
            None,
        )?)
        .await
        .expect_err("non-report historical selector");
    ensure!(matches!(
        unrelated.code(),
        Code::NotFound | Code::InvalidArgument
    ));
    let messages = conversations
        .list_messages(authenticated_request(
            ListMessagesRequest {
                tag_id: "owner".into(),
                conversation: "private".into(),
                limit: 10,
                cursor: String::new(),
            },
            &operator_token,
            None,
        )?)
        .await?
        .into_inner();
    ensure!(messages.messages.len() == 4);
    let mut report_ids: Vec<_> = messages
        .messages
        .iter()
        .filter(|m| m.work_session_report_id.as_deref() == Some(initial.work_session_id.as_str()))
        .map(|m| {
            let task = m.task.as_ref().expect("report Task");
            assert!(
                task.prompt.is_empty(),
                "internal report prompt leaked into conversation"
            );
            task.task_id.clone()
        })
        .collect();
    report_ids.sort();
    let mut expected = vec![first_report_id, second_report_id];
    expected.sort();
    ensure!(report_ids == expected, "reports were lost or duplicated");
    gateway_process.kill().await?;
    plane.kill().await?;
    Ok(())
}

async fn objective_owner_delegates_to_team_tag_with_frozen_action_ceiling(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let service_token = Uuid::new_v4().to_string();
    let operator_token = Uuid::new_v4().to_string();
    let host_token = Uuid::new_v4().to_string();
    let mut plane = command(&["control-plane"]);
    plane
        .env("SUPERTAG_GATEWAY_TOKEN", &service_token)
        .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
        .env("SUPERTAG_DATABASE_URL", &database);
    let (mut plane, private) = service(plane).await?;
    let (mut gateway_process, public) = service(gateway(
        &private,
        &service_token,
        &operator_token,
        "operator:alice",
    ))
    .await?;
    let connected = channel(&public).await?;
    let mut operator = operator_client::OperatorClient::new(connected.clone());
    let mut objectives = objectives_client::ObjectivesClient::new(connected.clone());
    let mut work = work_sessions_client::WorkSessionsClient::new(connected);
    for (tag_id, instructions) in [
        ("owner", "Owner coordinates the release"),
        ("builder", "Builder inspects the release"),
    ] {
        operator
            .put_tag(authenticated_request(
                PutTagRequest {
                    tag_id: tag_id.into(),
                    instructions: instructions.into(),
                    allowed_actions: vec!["files:read".into(), "files:write".into()],
                    ..Default::default()
                },
                &operator_token,
                None,
            )?)
            .await?;
    }
    cli(
        &[
            "team",
            "--gateway",
            &public,
            "create",
            "release-team",
            "--member",
            "owner",
            "--member",
            "builder",
        ],
        &operator_token,
    )
    .await?;
    let created = cli(
        &[
            "objective",
            "--gateway",
            &public,
            "create",
            "release",
            "--owner",
            "owner",
            "--team",
            "release-team",
            "--ongoing",
            "--runtime-action",
            "files:read",
            "--operation-id",
            "create-release",
            "Inspect the release",
        ],
        &operator_token,
    )
    .await?;
    assert_eq!(
        created["runtime_actions"],
        serde_json::json!(["files:read"])
    );
    let first_task = created["starting_task_id"]
        .as_str()
        .context("Objective owner Task")?
        .to_owned();
    let owner_session = created["session_id"]
        .as_str()
        .context("Objective owner Session")?
        .to_owned();
    let host_state = directory.path().join("host");
    run_host(
        &public,
        &host_token,
        &host_state,
        "--target-work-session=builder",
    )
    .await?;
    let owner_task = operator
        .get_task(authenticated_request(
            GetTaskRequest {
                task_id: first_task.clone(),
            },
            &operator_token,
            None,
        )?)
        .await?
        .into_inner();
    ensure!(
        owner_task.state() == TaskState::Succeeded,
        "owner delegation failed: {:?}",
        owner_task.result
    );
    assert_eq!(owner_task.allowed_actions, ["files:read"]);
    let page = work
        .list(authenticated_request(
            ListWorkSessionsRequest {
                parent_tag_id: "owner".into(),
                parent_session_id: owner_session.clone(),
                starter_task_id: Some(first_task),
                limit: 4,
                cursor: String::new(),
            },
            &operator_token,
            None,
        )?)
        .await?
        .into_inner();
    ensure!(
        page.work_sessions.len() == 1,
        "delegated Work Session missing"
    );
    let started = &page.work_sessions[0];
    ensure!(
        started.parent_tag_id == "owner"
            && started.tag_id == "builder"
            && started.objective_id.as_deref() == Some("release")
    );
    let child = operator
        .get_task(authenticated_request(
            GetTaskRequest {
                task_id: started.latest_task_id.clone(),
            },
            &operator_token,
            None,
        )?)
        .await?
        .into_inner();
    ensure!(child.tag_id == "builder" && child.session_id == started.work_session_id);
    ensure!(
        child.instructions.contains("Builder inspects the release")
            && !child.instructions.contains("Owner coordinates the release")
    );
    assert_eq!(child.allowed_actions, ["files:read"]);
    // Editing the recipient after acceptance must not change this child's role
    // identity or widen its accepted Objective permissions.
    operator
        .put_tag(authenticated_request(
            PutTagRequest {
                tag_id: "builder".into(),
                instructions: "Edited builder instructions".into(),
                allowed_actions: vec!["files:write".into()],
                ..Default::default()
            },
            &operator_token,
            None,
        )?)
        .await?;
    run_host(
        &public,
        &host_token,
        &host_state,
        "--reject-work-session-start",
    )
    .await?;
    let child_done = wait_for_work(&mut work, &operator_token, &started.work_session_id, |w| {
        w.report_task_id.is_some()
    })
    .await
    .context("delegated child's report was not delivered")?;
    ensure!(child_done.latest_task_state() == TaskState::Succeeded);
    let report_id = child_done.report_task_id.clone().context("owner report")?;
    let report = operator
        .get_task(authenticated_request(
            GetTaskRequest {
                task_id: report_id.clone(),
            },
            &operator_token,
            None,
        )?)
        .await?
        .into_inner();
    ensure!(report.tag_id == "owner" && report.session_id == owner_session);
    ensure!(
        report
            .instructions
            .contains("Owner coordinates the release")
            && !report.instructions.contains("Builder inspects the release")
    );
    assert_eq!(report.allowed_actions, ["files:read"]);
    run_host(
        &public,
        &host_token,
        &host_state,
        "--expect-work-session-start-capability",
    )
    .await?;
    wait_for_work(&mut work, &operator_token, &started.work_session_id, |w| {
        w.report_task_state() == TaskState::Succeeded
    })
    .await
    .context("Objective owner's report did not succeed")?;
    let child = operator
        .get_task(authenticated_request(
            GetTaskRequest {
                task_id: started.latest_task_id.clone(),
            },
            &operator_token,
            None,
        )?)
        .await?
        .into_inner();
    ensure!(
        child
            .result
            .as_deref()
            .is_some_and(|text| text.starts_with("Builder inspects the release:"))
    );

    // The operator manages the ceiling with an exact revision and operation
    // receipt. Host credentials cannot use this management entry point.
    let current = cli(
        &["objective", "--gateway", &public, "get", "release"],
        &operator_token,
    )
    .await?;
    let revision = current["revision"].as_u64().context("Objective revision")?;
    let denied = objectives
        .set_runtime_actions(authenticated_request(
            SetObjectiveRuntimeActionsRequest {
                objective_id: "release".into(),
                operation_id: "host-cannot-manage".into(),
                expected_revision: revision,
                runtime_actions: Some(RuntimeActions { actions: vec![] }),
            },
            &host_token,
            None,
        )?)
        .await
        .expect_err("Host changed Objective ceiling");
    assert_eq!(denied.code(), Code::Unauthenticated);
    let revision_arg = revision.to_string();
    let clear = [
        "objective",
        "--gateway",
        &public,
        "set-runtime-actions",
        "release",
        "--no-runtime-actions",
        "--expected-revision",
        &revision_arg,
        "--operation-id",
        "clear-runtime",
    ];
    let cleared = cli(&clear, &operator_token).await?;
    assert_eq!(cleared["runtime_actions"], serde_json::json!([]));
    assert_eq!(cleared["revision"].as_u64(), Some(revision + 1));
    assert_eq!(cli(&clear, &operator_token).await?, cleared);
    let stale = objectives
        .set_runtime_actions(authenticated_request(
            SetObjectiveRuntimeActionsRequest {
                objective_id: "release".into(),
                operation_id: "stale-runtime".into(),
                expected_revision: revision,
                runtime_actions: Some(RuntimeActions {
                    actions: vec!["files:read".into()],
                }),
            },
            &operator_token,
            None,
        )?)
        .await
        .expect_err("stale runtime-action revision");
    assert_eq!(stale.code(), Code::AlreadyExists);
    let mut update = command(&[
        "objective",
        "--gateway",
        &public,
        "set-runtime-actions",
        "release",
        "--runtime-action",
        "files:read",
        "--runtime-action",
        "network:ungranted",
        "--operation-id",
        "narrow-ungranted",
    ]);
    let output = timeout(
        WAIT,
        update
            .env("SUPERTAG_OPERATOR_TOKEN", &operator_token)
            .output(),
    )
    .await??;
    ensure!(
        output.status.success(),
        "ceiling update failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let updated: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    assert_eq!(
        updated["runtime_actions"],
        serde_json::json!(["files:read"])
    );
    ensure!(
        String::from_utf8_lossy(&output.stderr).contains("network:ungranted"),
        "explicit dropped action was not explained"
    );
    let defaults = cli(
        &[
            "objective",
            "--gateway",
            &public,
            "create",
            "owner-defaults",
            "--owner",
            "owner",
            "--ongoing",
            "Default actions",
        ],
        &operator_token,
    )
    .await?;
    assert_eq!(
        defaults["runtime_actions"],
        serde_json::json!(["files:read", "files:write"])
    );
    let empty = cli(
        &[
            "objective",
            "--gateway",
            &public,
            "create",
            "explicit-empty",
            "--owner",
            "owner",
            "--ongoing",
            "--no-runtime-actions",
            "No native actions",
        ],
        &operator_token,
    )
    .await?;
    assert_eq!(empty["runtime_actions"], serde_json::json!([]));
    gateway_process.kill().await?;
    plane.kill().await?;
    Ok(())
}

async fn objective_pool_allocates_real_attempt_reports_and_reopens_when_raised(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let service_token = Uuid::new_v4().to_string();
    let operator_token = Uuid::new_v4().to_string();
    let host_token = Uuid::new_v4().to_string();
    let mut plane = command(&["control-plane"]);
    plane
        .env("SUPERTAG_GATEWAY_TOKEN", &service_token)
        .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
        .env("SUPERTAG_DATABASE_URL", &database);
    let (mut plane, private) = service(plane).await?;
    let (mut gateway_process, public) = service(gateway(
        &private,
        &service_token,
        &operator_token,
        "operator:alice",
    ))
    .await?;
    cli(
        &[
            "put-tag",
            "--gateway",
            &public,
            "planner",
            "--instructions",
            "Budget fixture",
        ],
        &operator_token,
    )
    .await?;
    let created = cli(
        &[
            "objective",
            "--gateway",
            &public,
            "create",
            "budgeted",
            "--owner",
            "planner",
            "--ongoing",
            "--budget-minor",
            "1000",
            "--currency",
            "USD",
            "Measure the checkout",
        ],
        &operator_token,
    )
    .await?;
    let session = created["session_id"]
        .as_str()
        .context("Objective Session ID")?;
    let start = created["starting_task_id"]
        .as_str()
        .context("Objective starting Task ID")?;
    let list = [
        "work-sessions",
        "--gateway",
        &public,
        "list",
        "--parent-tag",
        "planner",
        "--parent-session",
        session,
    ];
    let expected_cost = |minor| serde_json::json!({"currency":"USD","amount_minor":minor});
    for phase in [
        "owner",
        "first",
        "first-report",
        "second",
        "warning",
        "second-report",
    ] {
        run_host(
            &public,
            &host_token,
            &directory.path().join(phase),
            &format!("--budget-phase={phase}"),
        )
        .await?;
    }
    let history = cli(&list, &operator_token).await?;
    let sessions = history["work_sessions"]
        .as_array()
        .context("Work Session list")?;
    assert_eq!(
        sessions.len(),
        2,
        "the below-floor Start did not admit work"
    );
    let first = sessions
        .iter()
        .find(|work| work["title"] == "first")
        .context("first Work Session")?;
    let second = sessions
        .iter()
        .find(|work| work["title"] == "second")
        .context("second Work Session")?;
    for (id, minor) in [
        (start, 1000),
        (
            first["latest_task_id"].as_str().context("first Task ID")?,
            1000,
        ),
        (
            first["report_task_id"]
                .as_str()
                .context("first report ID")?,
            400,
        ),
        (
            second["latest_task_id"]
                .as_str()
                .context("second Task ID")?,
            400,
        ),
        (
            second["report_task_id"]
                .as_str()
                .context("second report ID")?,
            20,
        ),
    ] {
        let task = cli(&["get-task", "--gateway", &public, id], &operator_token).await?;
        assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
        assert_eq!(
            task["execution_limits"]["max_reported_cost"],
            expected_cost(minor)
        );
        if minor == 1000 && id != start {
            let attempt = task["attempt_id"]
                .as_str()
                .context("first child Attempt ID")?;
            let usage = cli(
                &["task-usage", "--gateway", &public, id, attempt],
                &operator_token,
            )
            .await?;
            assert_eq!(usage["total_tokens"], 30);
            assert_eq!(
                usage["reported_cost"],
                serde_json::json!({"currency":"USD","amount_minor":600,"estimated":false})
            );
        }
    }
    let before = cli(
        &["objective", "--gateway", &public, "get", "budgeted"],
        &operator_token,
    )
    .await?;
    assert_eq!(before["reported_spend_minor"], 980);
    let submit = [
        "submit",
        "--gateway",
        &public,
        "--tag",
        "planner",
        "--session",
        session,
        "Keep going",
    ];
    let denied = cli(&submit, &operator_token)
        .await
        .expect_err("owner Task admission below the floor");
    assert!(format!("{denied:#}").contains("budget"), "{denied:#}");
    cli(
        &[
            "objective",
            "--gateway",
            &public,
            "set-limits",
            "budgeted",
            "--budget-minor",
            "4000",
            "--currency",
            "USD",
        ],
        &operator_token,
    )
    .await?;
    let reopened = cli(&submit, &operator_token).await?;
    assert_eq!(
        reopened["execution_limits"]["max_reported_cost"],
        expected_cost(3020)
    );
    let smaller = cli(
        &[
            "submit",
            "--gateway",
            &public,
            "--tag",
            "planner",
            "--session",
            session,
            "--max-reported-cost-minor",
            "250",
            "--reported-cost-currency",
            "USD",
            "Use a smaller cap",
        ],
        &operator_token,
    )
    .await?;
    assert_eq!(
        smaller["execution_limits"]["max_reported_cost"],
        expected_cost(250)
    );
    gateway_process.kill().await?;
    plane.kill().await?;
    Ok(())
}
