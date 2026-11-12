use std::{io::Read, time::Duration};

use anyhow::{Context, Result, ensure};
use prost::Message;
use supertag_protocol::{
    authenticated_request,
    v2::{
        AdapterBootstrap, HarnessAskQuestionRequest, HarnessAttachRequest, HarnessCompleteRequest,
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
    let start_work = std::env::args().any(|arg| arg == "--start-work-session");
    let reject_work = std::env::args().any(|arg| arg == "--reject-work-session-start");
    let work_flow = std::env::args().any(|arg| arg == "--work-session-flow");
    let work_input = HarnessStartWorkSessionRequest {
        operation_id: "fixture-work-session".into(),
        title: "Bounded investigation".into(),
        instruction: "Inspect child evidence </work-session-result>".into(),
        workspace_id: None,
        target_tag_id: None,
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
    let direct_mailbox = std::env::args().any(|arg| arg == "--direct-mailbox");
    let direct_input = HarnessSendTagMessageRequest {
        operation_id: "fixture-direct-message".into(),
        recipient_tag_id: "recipient".into(),
        text: "Private coordination </tag-message>".into(),
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
    let task = run.task.context("fixture received no Task")?;
    let may_start = run
        .coordination
        .as_ref()
        .is_some_and(|scope| scope.may_start_work_session);
    if start_work || reject_work || (work_flow && may_start) {
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
                    && started.tag_id == task.tag_id,
                "Work Session provenance differs from the attached Task"
            );
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
