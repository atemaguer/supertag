//! `--partition-steps=<base>` makes every adapter-facing call that the Worker
//! Host relays upstream and is allowed to repeat, one at a time. Before each
//! call the fixture writes `<base>.<step>.ready` and waits for
//! `<base>.<step>.go`; the test partitions the host from its Gateway before it
//! writes `go`, so each call starts while the Gateway is unreachable and must be
//! carried across the partition by the Worker Host.

use std::{ffi::OsString, path::Path, time::Duration};

use anyhow::{Context, Result, ensure};
use supertag_protocol::{
    authenticated_request,
    v2::{
        AdapterBootstrap, HarnessAskQuestionRequest, HarnessAskTagRequest,
        HarnessSettleLiveInputRequest, HarnessStartWorkSessionRequest, HarnessUsageRequest,
        LiveInputReceipt, LiveInputState, NativeTokenUsage, Task, harness_client::HarnessClient,
        harness_mailbox_client::HarnessMailboxClient,
        harness_questions_client::HarnessQuestionsClient,
        harness_work_sessions_client::HarnessWorkSessionsClient,
    },
};
use tokio::time::{Instant, sleep};
use tonic::transport::Channel;

/// The steps, in order. `take` is not partitioned: a take is never repeated.
pub const STEPS: [&str; 6] = [
    "usage",
    "ask-tag",
    "question",
    "work-session-start",
    "take",
    "settle",
];

fn marker(base: &Path, name: &str, suffix: &str) -> std::path::PathBuf {
    let mut path = OsString::from(base.as_os_str());
    path.push(format!(".{name}.{suffix}"));
    std::path::PathBuf::from(path)
}

/// `--partition-work-calls=<base>` gates the Work Session `ask` and `continue` calls
/// the same way, and writes `<base>.<step>.done` once the call has returned.
pub fn work_calls() -> Option<std::path::PathBuf> {
    std::env::args().find_map(|arg| {
        arg.strip_prefix("--partition-work-calls=")
            .map(std::path::PathBuf::from)
    })
}

pub fn done(base: &Path, name: &str) -> Result<()> {
    Ok(std::fs::write(marker(base, name, "done"), "")?)
}

pub async fn step(base: &Path, name: &str) -> Result<()> {
    std::fs::write(marker(base, name, "ready"), "")?;
    let go = marker(base, name, "go");
    let deadline = Instant::now() + Duration::from_secs(120);
    while !go.exists() {
        ensure!(Instant::now() < deadline, "step {name} was never released");
        sleep(Duration::from_millis(20)).await;
    }
    Ok(())
}

pub async fn exercise(
    base: &Path,
    bootstrap: &AdapterBootstrap,
    task: &Task,
    harness: &mut HarnessClient<Channel>,
) -> Result<String> {
    let token = bootstrap.token.as_str();
    let endpoint = bootstrap.endpoint.clone();
    let mut mailbox = HarnessMailboxClient::connect(endpoint.clone()).await?;
    let mut questions = HarnessQuestionsClient::connect(endpoint.clone()).await?;
    let mut work = HarnessWorkSessionsClient::connect(endpoint).await?;

    step(base, "usage").await?;
    harness
        .report_usage(authenticated_request(
            HarnessUsageRequest {
                sequence: 1,
                native_usage: Some(NativeTokenUsage {
                    input_tokens: 3,
                    cached_input_tokens: 0,
                    output_tokens: 2,
                    observed_model: None,
                    total_tokens: Some(5),
                }),
                amount_minor: None,
                currency: None,
                estimated: false,
            },
            token,
            None,
        )?)
        .await
        .context("usage report through a Gateway partition")?;

    // An Objective's turn asks its own Tag's inbox Session; it reaches no other Tag.
    step(base, "ask-tag").await?;
    let asked = mailbox
        .ask_tag(authenticated_request(
            HarnessAskTagRequest {
                operation_id: "partition-ask-tag".into(),
                text: "Asked through a partition".into(),
            },
            token,
            None,
        )?)
        .await
        .context("ask_tag through a Gateway partition")?
        .into_inner();
    ensure!(!asked.message_id.is_empty(), "ask_tag stored no message");

    step(base, "question").await?;
    let asked = questions
        .ask_question(authenticated_request(
            HarnessAskQuestionRequest {
                operation_id: "partition-question".into(),
                text: "Which route survives the partition?".into(),
            },
            token,
            None,
        )?)
        .await
        .context("question through a Gateway partition")?
        .into_inner();
    ensure!(asked.task_id == task.task_id, "question staged elsewhere");

    step(base, "work-session-start").await?;
    let started = work
        .start(authenticated_request(
            HarnessStartWorkSessionRequest {
                operation_id: "partition-work".into(),
                title: "Partitioned start".into(),
                instruction: "Started through a partition".into(),
                harness: None,
            },
            token,
            None,
        )?)
        .await
        .context("Work Session start through a Gateway partition")?
        .into_inner();
    ensure!(
        started.starter_task_id == task.task_id && started.tag_id == task.tag_id,
        "Work Session provenance differs"
    );

    // Taken while connected: the next step settles it through a partition.
    step(base, "take").await?;
    let input = super::take_input(harness, token).await?;
    step(base, "settle").await?;
    let receipt = harness
        .settle_live_input(authenticated_request(
            HarnessSettleLiveInputRequest {
                input_id: input.input_id.clone(),
                receipt: LiveInputReceipt::Accepted.into(),
            },
            token,
            None,
        )?)
        .await
        .context("live input settlement through a Gateway partition")?
        .into_inner();
    ensure!(
        receipt.state() == LiveInputState::Accepted,
        "input receipt was not accepted"
    );
    Ok(format!(
        "Relayed through partition: {}; input {}",
        STEPS.join(", "),
        input.text
    ))
}
