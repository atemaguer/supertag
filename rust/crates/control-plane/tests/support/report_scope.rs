use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;

pub async fn assert_restricted_report_continuation(
    store: &Store,
    host: &HostAuthority,
    continued: &InspectAttemptRequest,
    report: &Task,
    unrelated_session: &str,
    recipient: &str,
) {
    let task = store.get_task(&continued.task_id).await.unwrap();
    assert_eq!(task.instructions, report.instructions);
    assert_eq!(task.allowed_actions, report.allowed_actions);
    assert_eq!(task.approval_rules, report.approval_rules);
    assert_eq!(task.policy_snapshot, report.policy_snapshot);
    assert_eq!(task.tag_revision, report.tag_revision);
    assert_eq!(task.workspace, report.workspace);
    assert_eq!(task.harness_kind, report.harness_kind);

    let caps = store.attempt_capabilities(host, continued).await.unwrap();
    assert!(caps.may_request_commit_review);
    assert!(caps.may_continue_work_session);
    assert!(!caps.may_start_work_session);
    assert!(!caps.may_send_tag_message);
    assert!(!caps.may_read_mailbox);
    assert!(!caps.may_use_workstream);

    assert!(matches!(
        store
            .start_work_session(
                host,
                &StartWorkSessionRequest {
                    attempt: Some(continued.clone()),
                    operation_id: "start-from-report-continuation".into(),
                    title: "Unrelated assignment".into(),
                    instruction: "Run unrelated work.".into(),
                    ..Default::default()
                }
            )
            .await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store
            .continue_work_session(
                host,
                &ContinueWorkSessionRequest {
                    attempt: Some(continued.clone()),
                    operation_id: "continue-unrelated-child".into(),
                    work_session_id: unrelated_session.into(),
                    message: "Run unrelated work.".into(),
                }
            )
            .await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store
            .send_attempt_tag_message(
                host,
                &SendAttemptTagMessageRequest {
                    attempt: Some(continued.clone()),
                    operation_id: "send-from-report-continuation".into(),
                    recipient_tag_id: recipient.into(),
                    text: "Send unrelated mail.".into(),
                    review: None,
                }
            )
            .await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store
            .read_attempt_mailbox(
                host,
                &ReadMailboxRequest {
                    attempt: Some(continued.clone()),
                    ..Default::default()
                }
            )
            .await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store
            .read_attempt_workstream(
                host,
                &ReadAttemptWorkstreamRequest {
                    attempt: Some(continued.clone()),
                    ..Default::default()
                }
            )
            .await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store
            .post_attempt_workstream(
                host,
                &PostAttemptWorkstreamRequest {
                    attempt: Some(continued.clone()),
                    operation_id: "post-from-report-continuation".into(),
                    body: "Send an unrelated post.".into(),
                    to_tag_ids: vec![],
                }
            )
            .await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store.queue_input("operator:reviews", &QueueInputRequest {
            task_id: continued.task_id.clone(), operation_id: "input-to-report-continuation".into(),
            text: "Try to steer the report.".into(),
        }).await,
        Err(StoreError::FailedPrecondition(reason)) if reason.contains("reports do not accept live input")
    ));
}
