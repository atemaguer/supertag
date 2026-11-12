mod artifact_acquisition;
mod budget;
mod commit_reviews;

use std::{io::Read, time::Duration};

use anyhow::{Context, Result, ensure};
use prost::Message;
use supertag_protocol::{
    authenticated_request,
    v2::{
        AdapterBootstrap, HarnessAskQuestionRequest, HarnessAskWorkSessionQuestionRequest,
        HarnessAttachRequest, HarnessCompleteRequest, HarnessContinueWorkSessionRequest,
        HarnessPostWorkstreamRequest, HarnessPublishRequest, HarnessSendTagMessageRequest,
        HarnessSettleLiveInputRequest, HarnessStartWorkSessionRequest, HarnessTakeLiveInputRequest,
        LiveInput, LiveInputReceipt, LiveInputState, TagMessageOrigin,
        harness_client::HarnessClient, harness_mailbox_client::HarnessMailboxClient,
        harness_questions_client::HarnessQuestionsClient,
        harness_work_sessions_client::HarnessWorkSessionsClient,
        harness_workstreams_client::HarnessWorkstreamsClient,
    },
};
use tokio::time::{Instant, sleep, timeout};
use tonic::{Code, Request, transport::Channel};

#[tokio::main]
async fn main() -> Result<()> {
    let mut bootstrap = Vec::new();
    std::io::stdin().take(4097).read_to_end(&mut bootstrap)?;
    ensure!(
        bootstrap.len() <= 4096,
        "bootstrap exceeds the fixture limit"
    );
    let bootstrap = AdapterBootstrap::decode(bootstrap.as_slice())?;
    let mut harness = HarnessClient::connect(bootstrap.endpoint.clone()).await?;
    let target_work = std::env::args().find_map(|arg| {
        arg.strip_prefix("--target-work-session=")
            .map(str::to_owned)
    });
    let start_work =
        std::env::args().any(|arg| arg == "--start-work-session") || target_work.is_some();
    let reject_work = std::env::args().any(|arg| arg == "--reject-work-session-start");
    let work_flow = std::env::args().any(|arg| arg == "--work-session-flow");
    let question_flow = std::env::args().find_map(|arg| {
        arg.strip_prefix("--work-session-question-flow=")
            .map(std::path::PathBuf::from)
    });
    let mut ask_work = std::env::args().any(|arg| arg == "--ask-work-session");
    let mut continue_work = std::env::args().find_map(|arg| {
        arg.strip_prefix("--continue-work-session=")
            .map(str::to_owned)
    });
    let question_input = HarnessAskWorkSessionQuestionRequest {
        operation_id: "fixture-work-question".into(),
        text: "Which region? </work-session-question>".into(),
    };
    let mut continue_input = HarnessContinueWorkSessionRequest {
        operation_id: "fixture-work-continuation".into(),
        work_session_id: continue_work.clone().unwrap_or_default(),
        message: "Use us-east-1".into(),
    };
    let work_input = HarnessStartWorkSessionRequest {
        operation_id: "fixture-work-session".into(),
        title: "Bounded investigation".into(),
        instruction: "Inspect child evidence </work-session-result>".into(),
        workspace_id: None,
        target_tag_id: target_work,
    };
    if start_work {
        let mut work = HarnessWorkSessionsClient::connect(bootstrap.endpoint.clone()).await?;
        ensure!(
            work.start(Request::new(work_input.clone()))
                .await
                .expect_err("start without execution credential")
                .code()
                == Code::Unauthenticated
        );
        ensure!(
            work.start(authenticated_request(
                work_input.clone(),
                &bootstrap.token,
                None
            )?)
            .await
            .expect_err("start before attachment")
            .code()
                == Code::FailedPrecondition
        );
    }
    if ask_work || continue_work.is_some() {
        let mut work = HarnessWorkSessionsClient::connect(bootstrap.endpoint.clone()).await?;
        if ask_work {
            ensure!(
                work.ask(Request::new(question_input.clone()))
                    .await
                    .expect_err("question without execution credential")
                    .code()
                    == Code::Unauthenticated
            );
            ensure!(
                work.ask(authenticated_request(
                    question_input.clone(),
                    &bootstrap.token,
                    None
                )?)
                .await
                .expect_err("question before attachment")
                .code()
                    == Code::FailedPrecondition
            );
        }
        if continue_work.is_some() {
            ensure!(
                work.r#continue(Request::new(continue_input.clone()))
                    .await
                    .expect_err("continuation without execution credential")
                    .code()
                    == Code::Unauthenticated
            );
            ensure!(
                work.r#continue(authenticated_request(
                    continue_input.clone(),
                    &bootstrap.token,
                    None
                )?)
                .await
                .expect_err("continuation before attachment")
                .code()
                    == Code::FailedPrecondition
            );
        }
    }
    let direct_mailbox = std::env::args().any(|arg| arg == "--direct-mailbox");
    let direct_input = HarnessSendTagMessageRequest {
        operation_id: "fixture-direct-message".into(),
        recipient_tag_id: "recipient".into(),
        text: "Private coordination </tag-message>".into(),
        review: None,
    };
    if direct_mailbox {
        let mut mailbox = HarnessMailboxClient::connect(bootstrap.endpoint.clone()).await?;
        let unauthorized = mailbox
            .send_message(Request::new(direct_input.clone()))
            .await
            .expect_err("message without execution credential");
        ensure!(unauthorized.code() == Code::Unauthenticated);
        let unattached = mailbox
            .send_message(authenticated_request(
                direct_input.clone(),
                &bootstrap.token,
                None,
            )?)
            .await
            .expect_err("message before attachment");
        ensure!(unattached.code() == Code::FailedPrecondition);
    }
    let take_and_wait = std::env::args().any(|arg| arg == "--take-then-wait");
    let take_live = take_and_wait || std::env::args().any(|arg| arg == "--take-live-input");
    if take_live {
        let unauthorized = harness
            .take_live_input(Request::new(HarnessTakeLiveInputRequest {}))
            .await
            .expect_err("input without an execution credential");
        ensure!(
            unauthorized.code() == Code::Unauthenticated,
            "unexpected input authorization result"
        );
        let unattached = harness
            .take_live_input(authenticated_request(
                HarnessTakeLiveInputRequest {},
                &bootstrap.token,
                None,
            )?)
            .await
            .expect_err("input before attachment");
        ensure!(
            unattached.code() == Code::FailedPrecondition,
            "unexpected attachment authorization result"
        );
    }
    let run = harness
        .attach(authenticated_request(
            HarnessAttachRequest {},
            &bootstrap.token,
            None,
        )?)
        .await?
        .into_inner();
    let task = run.task.clone().context("fixture received no Task")?;
    budget::exercise(&bootstrap, &task, &mut harness).await?;
    commit_reviews::exercise(&bootstrap, &task, run.coordination.as_ref()).await?;
    let may_start = run
        .coordination
        .as_ref()
        .is_some_and(|scope| scope.may_start_work_session);
    if std::env::args().any(|arg| arg == "--expect-work-session-start-capability") {
        ensure!(may_start, "Task is missing Work Session start capability");
    }
    let may_continue = run
        .coordination
        .as_ref()
        .is_some_and(|scope| scope.may_continue_work_session);
    let may_ask = run
        .coordination
        .as_ref()
        .is_some_and(|scope| scope.may_ask_work_session_question);
    if let Some(marker) = &question_flow
        && (task.session_id.starts_with("work/")
            || (may_continue && task.prompt == "Use us-east-1"))
    {
        let started: serde_json::Value = serde_json::from_slice(&std::fs::read(marker)?)?;
        let id = started["work_session_id"]
            .as_str()
            .context("fixture Work Session ID")?;
        if task.session_id.starts_with("work/") {
            ensure!(
                task.session_id == id,
                "question flow switched Work Sessions"
            );
            ask_work = started["child_task_id"].as_str() == Some(task.task_id.as_str());
        } else {
            continue_work = Some(id.to_owned());
            continue_input.work_session_id = id.to_owned();
            continue_input.message = task.prompt.clone();
        }
    }
    if start_work
        || reject_work
        || ((work_flow || question_flow.is_some()) && may_start && continue_work.is_none())
    {
        let mut work = HarnessWorkSessionsClient::connect(bootstrap.endpoint.clone()).await?;
        if reject_work {
            ensure!(!may_start, "child/report received start authority");
            let rejected = work
                .start(authenticated_request(
                    work_input.clone(),
                    &bootstrap.token,
                    None,
                )?)
                .await
                .expect_err("recursive Work Session start");
            ensure!(matches!(
                rejected.code(),
                Code::PermissionDenied | Code::FailedPrecondition
            ));
        } else {
            ensure!(may_start, "root Task is missing start authority");
            let started = work
                .start(authenticated_request(
                    work_input.clone(),
                    &bootstrap.token,
                    None,
                )?)
                .await?
                .into_inner();
            ensure!(
                started.parent_tag_id == task.tag_id
                    && started.parent_session_id == task.session_id
                    && started.starter_task_id == task.task_id
                    && started.tag_id
                        == work_input.target_tag_id.as_deref().unwrap_or(&task.tag_id),
                "Work Session provenance differs from the attached Task"
            );
            if let Some(marker) = &question_flow {
                std::fs::write(
                    marker,
                    serde_json::to_vec(&serde_json::json!({
                        "work_session_id": started.work_session_id,
                        "child_task_id": started.latest_task_id,
                    }))?,
                )?;
            }
            let replay = work
                .start(authenticated_request(
                    work_input.clone(),
                    &bootstrap.token,
                    None,
                )?)
                .await?
                .into_inner();
            ensure!(replay == started, "Work Session replay changed the receipt");
            let mut changed = work_input.clone();
            changed.instruction = "Changed instruction".into();
            ensure!(
                work.start(authenticated_request(changed, &bootstrap.token, None)?)
                    .await
                    .expect_err("conflicting Work Session operation")
                    .code()
                    == Code::AlreadyExists
            );
        }
    }
    if ask_work || continue_work.is_some() {
        let mut work = HarnessWorkSessionsClient::connect(bootstrap.endpoint.clone()).await?;
        if ask_work {
            ensure!(
                may_ask && !may_continue && !may_start,
                "child question capabilities differ"
            );
            let asked = work
                .ask(authenticated_request(
                    question_input.clone(),
                    &bootstrap.token,
                    None,
                )?)
                .await?
                .into_inner();
            ensure!(
                asked.work_session_id == task.session_id
                    && asked.task_id == task.task_id
                    && asked.attempt_id == run.attempt_id
                    && asked.text == question_input.text
                    && asked.published_at_ms.is_none()
            );
            let replay = work
                .ask(authenticated_request(
                    question_input.clone(),
                    &bootstrap.token,
                    None,
                )?)
                .await?
                .into_inner();
            ensure!(replay == asked, "question replay changed its receipt");
            let mut changed = question_input.clone();
            changed.text = "Different question".into();
            ensure!(
                work.ask(authenticated_request(changed, &bootstrap.token, None)?)
                    .await
                    .expect_err("conflicting question operation")
                    .code()
                    == Code::AlreadyExists
            );
            let mut recursive = continue_input.clone();
            recursive.work_session_id = task.session_id.clone();
            let denied = work
                .r#continue(authenticated_request(recursive, &bootstrap.token, None)?)
                .await
                .expect_err("child continuation");
            ensure!(matches!(
                denied.code(),
                Code::PermissionDenied | Code::FailedPrecondition
            ));
        }
        if continue_work.is_some() {
            ensure!(
                may_continue && !may_ask,
                "parent continuation capabilities differ"
            );
            let continued = work
                .r#continue(authenticated_request(
                    continue_input.clone(),
                    &bootstrap.token,
                    None,
                )?)
                .await?
                .into_inner();
            ensure!(
                continued.work_session_id == continue_input.work_session_id
                    && continued.parent_tag_id == task.tag_id
                    && continued.parent_session_id == task.session_id
                    && continued.starter_task_id == task.task_id
            );
            let replay = work
                .r#continue(authenticated_request(
                    continue_input.clone(),
                    &bootstrap.token,
                    None,
                )?)
                .await?
                .into_inner();
            ensure!(
                replay == continued,
                "continuation replay changed its receipt"
            );
            let mut changed = continue_input.clone();
            changed.message = "Different answer".into();
            ensure!(
                work.r#continue(authenticated_request(changed, &bootstrap.token, None)?)
                    .await
                    .expect_err("conflicting continuation operation")
                    .code()
                    == Code::AlreadyExists
            );
            let denied = work
                .ask(authenticated_request(
                    question_input.clone(),
                    &bootstrap.token,
                    None,
                )?)
                .await
                .expect_err("parent child-question authority");
            ensure!(matches!(
                denied.code(),
                Code::PermissionDenied | Code::FailedPrecondition
            ));
        }
    }
    if direct_mailbox {
        let mut mailbox = HarnessMailboxClient::connect(bootstrap.endpoint.clone()).await?;
        let sent = mailbox
            .send_message(authenticated_request(
                direct_input.clone(),
                &bootstrap.token,
                None,
            )?)
            .await?
            .into_inner();
        ensure!(!sent.duplicate && sent.approval.is_none());
        let message = sent.message.context("direct message receipt")?;
        ensure!(
            message.source_task_id == task.task_id
                && message.sender_tag_id == task.tag_id
                && message.origin() == TagMessageOrigin::Direct
                && message.workstream_post_id.is_none(),
            "message authority or private provenance differs"
        );
        let replay = mailbox
            .send_message(authenticated_request(
                direct_input.clone(),
                &bootstrap.token,
                None,
            )?)
            .await?
            .into_inner();
        ensure!(replay.duplicate && replay.message.as_ref() == Some(&message));
        let mut changed = direct_input.clone();
        changed.text = "Different private message".into();
        let conflict = mailbox
            .send_message(authenticated_request(changed, &bootstrap.token, None)?)
            .await
            .expect_err("same operation with different content");
        ensure!(conflict.code() == Code::AlreadyExists);
        let denied = mailbox
            .send_message(authenticated_request(
                HarnessSendTagMessageRequest {
                    operation_id: "fixture-ungranted-message".into(),
                    recipient_tag_id: "observer".into(),
                    text: "Must not be sent".into(),
                    review: None,
                },
                &bootstrap.token,
                None,
            )?)
            .await
            .expect_err("message to an ungranted Tag");
        ensure!(denied.code() == Code::PermissionDenied);
    }
    if std::env::args().any(|arg| arg == "--objective-question")
        && task.prompt.contains("Ask which branch to release")
    {
        let mut questions = HarnessQuestionsClient::connect(bootstrap.endpoint.clone()).await?;
        let input = HarnessAskQuestionRequest {
            operation_id: "fixture-question".into(),
            text: "Which branch should I release?".into(),
        };
        let unauthorized = questions
            .ask_question(Request::new(input.clone()))
            .await
            .expect_err("question without execution credential");
        ensure!(
            unauthorized.code() == Code::Unauthenticated,
            "unexpected question authorization result"
        );
        let staged = questions
            .ask_question(authenticated_request(
                input.clone(),
                &bootstrap.token,
                None,
            )?)
            .await?
            .into_inner();
        ensure!(
            staged.task_id == task.task_id && staged.published_at_ms.is_none(),
            "question was not staged for the attached Task"
        );
        let replay = questions
            .ask_question(authenticated_request(input, &bootstrap.token, None)?)
            .await?
            .into_inner();
        ensure!(replay == staged, "question replay changed its receipt");
    }
    let mut waiting_approval_ids = Vec::new();
    if std::env::args().any(|arg| arg == "--workstream-approval") {
        let mut workstreams = HarnessWorkstreamsClient::connect(bootstrap.endpoint.clone()).await?;
        let input = HarnessPostWorkstreamRequest {
            operation_id: "fixture-release-post".into(),
            body: "The rollout is ready.".into(),
            to_tag_ids: vec![],
        };
        let unauthorized = workstreams
            .post(Request::new(input.clone()))
            .await
            .expect_err("post without an execution credential");
        ensure!(unauthorized.code() == Code::Unauthenticated);
        let pending = workstreams
            .post(authenticated_request(
                input.clone(),
                &bootstrap.token,
                None,
            )?)
            .await?
            .into_inner();
        ensure!(pending.post.is_none(), "the approval request wrote a post");
        let approval = pending.approval.context("pending post had no approval")?;
        ensure!(approval.task_id == task.task_id && approval.attempt_id == run.attempt_id);
        let replay = workstreams
            .post(authenticated_request(input, &bootstrap.token, None)?)
            .await?
            .into_inner();
        ensure!(replay.approval.as_ref() == Some(&approval));
        waiting_approval_ids.push(approval.approval_id);
    }
    harness
        .publish(authenticated_request(
            HarnessPublishRequest {
                sequence: 1,
                text: format!("{} started", run.attempt_id),
            },
            &bootstrap.token,
            None,
        )?)
        .await?;

    let mut result = format!(
        "{}: {} [{}]",
        task.instructions,
        task.prompt,
        task.allowed_actions.join(",")
    );
    if work_flow {
        result = if may_start {
            "Started the investigation.".into()
        } else if task.session_id.starts_with("work/") {
            "Child evidence is ready.".into()
        } else {
            ensure!(
                task.prompt.contains("Child evidence is ready."),
                "the report Task did not receive the child result"
            );
            "The investigation finished.".into()
        };
    }
    if ask_work {
        result = "Waiting for the region before continuing.".into();
    }
    if question_flow.is_some() {
        result = if continue_work.is_some() {
            "Continuing the investigation.".into()
        } else if may_start {
            "Started the investigation.".into()
        } else if ask_work {
            "Waiting for the region before continuing.".into()
        } else if task.session_id.starts_with("work/") {
            ensure!(
                task.prompt.contains("Use us-east-1"),
                "continued child did not receive the answer"
            );
            "Child checked the selected region.".into()
        } else if task.prompt.contains("<work-session-question>") {
            "Which region should I inspect?".into()
        } else {
            ensure!(
                task.prompt.contains("Child checked the selected region."),
                "second report lost the continued child's result"
            );
            "Region us-east-1 is verified.".into()
        };
    }
    if std::env::args().any(|arg| arg == "--artifact-acquisition-fixture") {
        result = artifact_acquisition::exercise(&bootstrap, &run).await?;
        if std::env::args().any(|arg| arg == "--wait-for-cancel") {
            harness
                .publish(authenticated_request(
                    HarnessPublishRequest {
                        sequence: 2,
                        text: "artifact attached".into(),
                    },
                    &bootstrap.token,
                    None,
                )?)
                .await?;
        }
    }
    let workspace_fixture = std::env::args().any(|arg| arg == "--workspace-fixture");
    if workspace_fixture {
        ensure!(
            task.workspace.is_some(),
            "workspace fixture requires a bound repository"
        );
        let workspace = std::env::var_os(supertag_worker_host::WORKSPACE_DIRECTORY)
            .map(std::path::PathBuf::from)
            .context("prepared workspace was not supplied")?;
        ensure!(
            std::env::current_dir()?.canonicalize()? == workspace.canonicalize()?,
            "adapter cwd does not match its isolated workspace"
        );
        ensure!(
            !workspace.join("operator-only.txt").exists(),
            "source working files leaked into isolated checkout"
        );
        let before = std::fs::read_to_string(workspace.join("workspace.txt"))?;
        std::fs::write(
            workspace.join("workspace.txt"),
            format!("{before}{}\n", task.prompt),
        )?;
        std::fs::write(workspace.join("artifact.bin"), [0_u8, 1, 2, 0, 255])?;
        result = format!("Change: {}\nWorkspace before:\n{before}", task.prompt);
    }
    if std::env::args().any(|arg| arg == "--wait-for-cancel") {
        if workspace_fixture {
            harness
                .publish(authenticated_request(
                    HarnessPublishRequest {
                        sequence: 2,
                        text: "workspace edited".into(),
                    },
                    &bootstrap.token,
                    None,
                )?)
                .await?;
        }
        sleep(Duration::from_secs(60)).await;
    }
    if take_live {
        let input = take_input(&mut harness, &bootstrap.token).await?;
        if take_and_wait {
            sleep(Duration::from_secs(60)).await;
        }
        let receipt = harness
            .settle_live_input(authenticated_request(
                HarnessSettleLiveInputRequest {
                    input_id: input.input_id,
                    receipt: LiveInputReceipt::Accepted.into(),
                },
                &bootstrap.token,
                None,
            )?)
            .await?
            .into_inner();
        ensure!(
            receipt.state() == LiveInputState::Accepted,
            "input receipt was not accepted"
        );
        result.push_str("\nLive input: ");
        result.push_str(&input.text);
    }
    harness
        .publish(authenticated_request(
            HarnessPublishRequest {
                sequence: 2,
                text: result.clone(),
            },
            &bootstrap.token,
            None,
        )?)
        .await?;
    harness
        .complete(authenticated_request(
            HarnessCompleteRequest {
                result,
                succeeded: true,
                objective_signal: 0,
                checkpoint: None,
                waiting_approval_ids,
            },
            &bootstrap.token,
            None,
        )?)
        .await?;
    if take_live {
        let closed = harness
            .take_live_input(authenticated_request(
                HarnessTakeLiveInputRequest {},
                &bootstrap.token,
                None,
            )?)
            .await
            .expect_err("input after proposing completion");
        ensure!(
            closed.code() == Code::FailedPrecondition,
            "unexpected input after completion"
        );
    }
    if start_work {
        let mut work = HarnessWorkSessionsClient::connect(bootstrap.endpoint.clone()).await?;
        ensure!(
            work.start(authenticated_request(work_input, &bootstrap.token, None)?)
                .await
                .expect_err("start after completion")
                .code()
                == Code::FailedPrecondition
        );
    }
    if ask_work || continue_work.is_some() {
        let mut work = HarnessWorkSessionsClient::connect(bootstrap.endpoint.clone()).await?;
        if ask_work {
            ensure!(
                work.ask(authenticated_request(
                    question_input,
                    &bootstrap.token,
                    None
                )?)
                .await
                .expect_err("question after completion")
                .code()
                    == Code::FailedPrecondition
            );
        }
        if continue_work.is_some() {
            ensure!(
                work.r#continue(authenticated_request(
                    continue_input,
                    &bootstrap.token,
                    None
                )?)
                .await
                .expect_err("continuation after completion")
                .code()
                    == Code::FailedPrecondition
            );
        }
    }
    Ok(())
}

async fn take_input(harness: &mut HarnessClient<Channel>, token: &str) -> Result<LiveInput> {
    timeout(Duration::from_secs(20), async {
        loop {
            let sent = Instant::now();
            let response = harness
                .take_live_input(authenticated_request(
                    HarnessTakeLiveInputRequest {},
                    token,
                    None,
                )?)
                .await?
                .into_inner();
            if let Some(input) = response.input {
                let deadline = sent
                    .checked_add(Duration::from_millis(response.valid_for_ms))
                    .context("invalid fixture input duration")?;
                ensure!(Instant::now() < deadline, "fixture received expired input");
                return Ok(input);
            }
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .context("fixture did not receive live input")?
}
