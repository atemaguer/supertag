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
        AdapterBootstrap, HarnessAskQuestionRequest, HarnessPostWorkstreamRequest,
        HarnessReadMailboxRequest, HarnessReadWorkstreamRequest, HarnessSendTagMessageRequest,
        HarnessSettleLiveInputRequest, HarnessStartWorkSessionRequest, HarnessUsageRequest,
        LiveInputReceipt, LiveInputState, NativeTokenUsage, Task, harness_client::HarnessClient,
        harness_mailbox_client::HarnessMailboxClient,
        harness_questions_client::HarnessQuestionsClient,
        harness_work_sessions_client::HarnessWorkSessionsClient,
        harness_workstreams_client::HarnessWorkstreamsClient,
    },
};
use tokio::time::{Instant, sleep};
use tonic::transport::Channel;

/// The steps, in order. `take` is not partitioned: a take is never repeated.
pub const STEPS: [&str; 9] = [
    "usage",
    "mailbox-read",
    "mailbox-send",
    "workstream-read",
    "workstream-post",
    "question",
    "work-session-start",
    "take",
    "settle",
];

async fn step(base: &Path, name: &str) -> Result<()> {
    let marker = |suffix: &str| {
        let mut path = OsString::from(base.as_os_str());
        path.push(format!(".{name}.{suffix}"));
        std::path::PathBuf::from(path)
    };
    std::fs::write(marker("ready"), "")?;
    let go = marker("go");
    let deadline = Instant::now() + Duration::from_secs(120);
    while !go.exists() {
        ensure!(Instant::now() < deadline, "step {name} was never released");
        sleep(Duration::from_millis(20)).await;
    }
    Ok(())
}

pub async fn exercise(
    base: &Path,
    peer: &str,
    bootstrap: &AdapterBootstrap,
    task: &Task,
    harness: &mut HarnessClient<Channel>,
) -> Result<String> {
    let token = bootstrap.token.as_str();
    let endpoint = bootstrap.endpoint.clone();
    let mut mailbox = HarnessMailboxClient::connect(endpoint.clone()).await?;
    let mut workstreams = HarnessWorkstreamsClient::connect(endpoint.clone()).await?;
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

    step(base, "mailbox-read").await?;
    mailbox
        .read(authenticated_request(
            HarnessReadMailboxRequest {
                limit: 10,
                cursor: String::new(),
            },
            token,
            None,
        )?)
        .await
        .context("Mailbox read through a Gateway partition")?;

    step(base, "mailbox-send").await?;
    let sent = mailbox
        .send_message(authenticated_request(
            HarnessSendTagMessageRequest {
                operation_id: "partition-message".into(),
                recipient_tag_id: peer.into(),
                text: "Sent through a partition".into(),
                review: None,
            },
            token,
            None,
        )?)
        .await
        .context("Mailbox send through a Gateway partition")?
        .into_inner();
    ensure!(
        sent.message.is_some() && sent.approval.is_none(),
        "Mailbox send returned no message"
    );

    step(base, "workstream-read").await?;
    workstreams
        .read(authenticated_request(
            HarnessReadWorkstreamRequest {
                after_sequence: None,
                limit: 10,
                cursor: String::new(),
            },
            token,
            None,
        )?)
        .await
        .context("Workstream read through a Gateway partition")?;

    step(base, "workstream-post").await?;
    let posted = workstreams
        .post(authenticated_request(
            HarnessPostWorkstreamRequest {
                operation_id: "partition-post".into(),
                body: "Posted through a partition".into(),
                to_tag_ids: vec![],
            },
            token,
            None,
        )?)
        .await
        .context("Workstream post through a Gateway partition")?
        .into_inner();
    ensure!(posted.post.is_some(), "Workstream post wrote no post");

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
                workspace_id: None,
                target_tag_id: Some(peer.into()),
            },
            token,
            None,
        )?)
        .await
        .context("Work Session start through a Gateway partition")?
        .into_inner();
    ensure!(
        started.starter_task_id == task.task_id && started.tag_id == peer,
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
