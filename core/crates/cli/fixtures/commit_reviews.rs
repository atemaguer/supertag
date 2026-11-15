use anyhow::{Context, Result, ensure};
use supertag_protocol::{authenticated_request, v2::*};
use tonic::{Code, Request};

pub async fn exercise(
    bootstrap: &AdapterBootstrap,
    task: &Task,
    scope: Option<&AttemptCapabilities>,
) -> Result<()> {
    if let Some(commit) = argument("--request-commit-review=") {
        ensure!(scope.is_some_and(|scope| scope.may_request_commit_review));
        ensure!(
            task.prompt.contains(&commit),
            "report did not expose the verified commit"
        );
        let mut mailbox =
            harness_mailbox_client::HarnessMailboxClient::connect(bootstrap.endpoint.clone())
                .await?;
        let plain = HarnessSendTagMessageRequest {
            operation_id: "report-plain-message".into(),
            recipient_tag_id: "reviewer".into(),
            text: "This report should only be able to request review".into(),
            review: None,
        };
        let denied = mailbox
            .send_message(authenticated_request(plain, &bootstrap.token, None)?)
            .await
            .expect_err("a report cannot send ordinary messages");
        ensure!(denied.code() == Code::PermissionDenied);
        let input = HarnessSendTagMessageRequest {
            operation_id: "request-work-review".into(),
            recipient_tag_id: "reviewer".into(),
            text: "Review the delivered fixture changes.".into(),
            review: Some(CommitReviewSubmission {
                kind: Some(commit_review_submission::Kind::Commit(commit.clone())),
            }),
        };
        let response = mailbox
            .send_message(authenticated_request(
                input.clone(),
                &bootstrap.token,
                None,
            )?)
            .await?
            .into_inner();
        let message = response.message.context("commit review request receipt")?;
        let review = message.review.as_ref().context("commit review metadata")?;
        ensure!(
            review.commit == commit
                && review.request_id == message.message_id
                && review.requester_tag_id == task.tag_id
                && review.reviewer_tag_id == "reviewer"
                && review.verdict.is_none(),
            "the request receipt changed review authority"
        );
        let replay = mailbox
            .send_message(authenticated_request(input, &bootstrap.token, None)?)
            .await?
            .into_inner();
        ensure!(replay.duplicate && replay.message.as_ref() == Some(&message));
    }
    if let Some(review_id) = argument("--record-commit-review=") {
        ensure!(task.tag_id == "reviewer" && task.session_id.starts_with("inbox:"));
        ensure!(scope.is_some_and(|scope| scope.may_read_mailbox && scope.may_send_tag_message));
        let mut mailbox =
            harness_mailbox_client::HarnessMailboxClient::connect(bootstrap.endpoint.clone())
                .await?;
        let delivered = mailbox
            .read(authenticated_request(
                HarnessReadMailboxRequest::default(),
                &bootstrap.token,
                None,
            )?)
            .await?
            .into_inner();
        let review = delivered
            .messages
            .into_iter()
            .filter_map(|message| message.review)
            .find(|review| review.request_id == review_id)
            .context("reviewer Mailbox did not expose the request")?;
        let artifact = HarnessReadReviewPatchRequest {
            review_id: review_id.clone(),
            offset: 0,
        };
        ensure!(
            mailbox
                .read_review_patch(Request::new(artifact.clone()))
                .await
                .expect_err("patch read without Attempt credential")
                .code()
                == Code::Unauthenticated
        );
        let page = mailbox
            .read_review_patch(authenticated_request(artifact, &bootstrap.token, None)?)
            .await?
            .into_inner();
        ensure!(
            page.review_id == review_id
                && page.offset == 0
                && page.next_offset.is_none()
                && page
                    .delivery
                    .is_some_and(|delivery| delivery.head_commit == review.commit),
            "patch receipt differs from the request"
        );
        let patch = std::str::from_utf8(&page.data)?;
        ensure!(patch.contains("workspace.txt") && patch.contains("Inspect child evidence"));
        let input = HarnessSendTagMessageRequest {
            operation_id: "record-work-verdict".into(),
            recipient_tag_id: review.requester_tag_id.clone(),
            text: "The patch contains the expected fixture evidence.".into(),
            review: Some(CommitReviewSubmission {
                kind: Some(commit_review_submission::Kind::Response(
                    CommitReviewResponse {
                        request_id: review_id.clone(),
                        verdict: CommitReviewDecision::Approved.into(),
                    },
                )),
            }),
        };
        let result = mailbox
            .send_message(authenticated_request(
                input.clone(),
                &bootstrap.token,
                None,
            )?)
            .await?
            .into_inner();
        ensure!(result.message.is_none() && result.approval.is_none());
        let recorded = result.review.context("recorded verdict")?;
        ensure!(
            recorded.request_id == review_id
                && recorded.commit == review.commit
                && recorded.verdict.as_ref().is_some_and(|verdict| {
                    verdict.decision() == CommitReviewDecision::Approved
                        && verdict.task_id == task.task_id
                        && verdict.summary == input.text
                })
        );
        let replay = mailbox
            .send_message(authenticated_request(input, &bootstrap.token, None)?)
            .await?
            .into_inner();
        ensure!(replay.review.as_ref() == Some(&recorded));
    }
    if let Some(review_id) = argument("--observe-commit-review=") {
        ensure!(
            task.tag_id == "owner"
                && task.prompt.contains(&review_id)
                && task
                    .prompt
                    .contains("The patch contains the expected fixture evidence."),
            "owner notice did not receive the recorded verdict"
        );
    }
    Ok(())
}

fn argument(prefix: &str) -> Option<String> {
    std::env::args().find_map(|arg| arg.strip_prefix(prefix).map(str::to_owned))
}
