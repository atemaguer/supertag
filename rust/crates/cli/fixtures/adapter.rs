use std::{io::Read, time::Duration};

use anyhow::{Context, Result, ensure};
use prost::Message;
use supertag_protocol::{
    authenticated_request,
    v2::{
        AdapterBootstrap, HarnessAskQuestionRequest, HarnessAttachRequest, HarnessCompleteRequest,
        HarnessPublishRequest, HarnessSettleLiveInputRequest, HarnessTakeLiveInputRequest,
        LiveInput, LiveInputReceipt, LiveInputState, harness_client::HarnessClient,
        harness_questions_client::HarnessQuestionsClient,
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
    if std::env::args().any(|arg| arg == "--objective-question")
        && task.prompt.contains("Ask which branch to release")
    {
        let mut questions = HarnessQuestionsClient::connect(bootstrap.endpoint).await?;
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
