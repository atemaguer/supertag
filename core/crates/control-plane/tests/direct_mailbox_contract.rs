mod support;

use sqlx::{Connection, Executor};
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:alice";
const NOW: i64 = 1_900_000_000_000;
const DEBOUNCE_MS: i64 = 3_000;

fn send(operation: &str, recipient: &str, text: &str) -> SendAttemptTagMessageRequest {
    SendAttemptTagMessageRequest {
        kind: 0,
        operation_id: operation.into(),
        recipient_tag_id: recipient.into(),
        text: text.into(),
        review: None,
        recipient_objective_id: String::new(),
    }
}
fn grant(
    operation: &str,
    sender: &str,
    recipient: &str,
    granted: bool,
) -> ChangeMailboxGrantRequest {
    ChangeMailboxGrantRequest {
        operation_id: operation.into(),
        sender_tag_id: sender.into(),
        recipient_tag_id: recipient.into(),
        granted,
    }
}
async fn ordinary(store: &Store, tag: &str) -> Task {
    store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                output_policy: None,
                execution_limits: None,
                tag_id: tag.into(),
                session_id: "ordinary".into(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: "Coordinate".into(),
                input_artifacts: vec![],
            },
        )
        .await
        .unwrap()
}
async fn claim(store: &Store, host: &HostAuthority, tag: &str) -> InspectAttemptRequest {
    let assignment = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .expect("queued task");
    let task = assignment.task.unwrap();
    assert_eq!(task.tag_id, tag);
    InspectAttemptRequest {
        task_id: task.task_id,
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    }
}
/// Claims the Tag's inbox turn once its messages' wake is due: notes wait out the debounce.
async fn claim_inbox(
    store: &Store,
    clock: &AtomicI64,
    host: &HostAuthority,
    tag: &str,
) -> InspectAttemptRequest {
    clock.fetch_add(DEBOUNCE_MS, Ordering::SeqCst);
    store.sweep_mailbox().await.unwrap();
    claim(store, host, tag).await
}
async fn start(store: &Store, host: &HostAuthority, attempt: &InspectAttemptRequest) -> Task {
    store
        .start_task(
            host,
            &StartTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
            },
        )
        .await
        .unwrap()
        .task
        .unwrap()
}
async fn finish(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    waiting: Vec<String>,
) {
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                succeeded: true,
                result: "Handled".into(),
                waiting_approval_ids: waiting,
                ..Default::default()
            },
        )
        .await
        .unwrap();
}
async fn history(store: &Store, tag: &str) -> Vec<TagMessage> {
    store
        .list_mailbox_messages(
            OPERATOR,
            &ListMailboxMessagesRequest {
                tag_id: tag.into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .messages
}
async fn previous_mailbox_schema(url: &str) {
    sqlx::any::install_default_drivers();
    let pool = sqlx::AnyPool::connect(url).await.unwrap();
    let backend = if url.starts_with("sqlite:") {
        "sqlite"
    } else {
        "postgresql"
    };
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("migrations")
        .join(backend);
    let mut paths: Vec<_> = std::fs::read_dir(root)
        .unwrap()
        .map(|p| p.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .get(..4)
                .and_then(|v| v.parse::<u32>().ok())
                .is_some_and(|v| v <= 23)
        })
        .collect();
    paths.sort();
    let mut tx = pool.begin().await.unwrap();
    for path in paths {
        sqlx::raw_sql(&std::fs::read_to_string(path).unwrap())
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    sqlx::raw_sql("INSERT INTO supertag_v2_tags (tag_id,instructions,allowed_actions,revision) VALUES ('legacy-sender','Sender','[]',1),('legacy-recipient','Recipient','[]',1);
    INSERT INTO supertag_v2_tasks (task_id,tag_id,session_id,prompt,instructions,allowed_actions,tag_revision,state,accepted_order) VALUES ('legacy-source','legacy-sender','old','Old source','Sender','[]',1,3,1),('legacy-inbox','legacy-recipient','inbox:legacy-recipient','Old mail','Recipient','[]',1,3,2);
    INSERT INTO supertag_v2_mailbox_messages (message_id,sender_tag_id,recipient_tag_id,source_task_id,workstream_post_id,text,hops,task_id,created_at_ms,delivery_order) VALUES ('legacy-message','legacy-sender','legacy-recipient','legacy-source','legacy-post','Existing addressed post',0,'legacy-inbox',1,3);
    UPDATE supertag_v2_write_order SET revision=3 WHERE singleton=1;").execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    pool.close().await;
}

async fn open_at(url: &str, clock: &Arc<AtomicI64>) -> Store {
    let now = clock.clone();
    Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || now.load(Ordering::SeqCst))
}

async fn direct_contract(url: &str) {
    previous_mailbox_schema(url).await;
    let clock = Arc::new(AtomicI64::new(NOW));
    let store = open_at(url, &clock).await;
    let (sender, receiver, other) = initialize_mailbox(&store).await;
    let delivery = submit_direct_messages(&store, &sender, &receiver, &other, &clock).await;

    // Exact replay across restart while both sending and receiving Attempts are live.
    store.close().await;
    let store = open_at(url, &clock).await;
    verify_restarted_delivery(&store, &sender, &receiver, &other, delivery, &clock).await;
    verify_directional_grants(&store).await;

    store.close().await;
    let store = open_at(url, &clock).await;
    verify_scoped_delivery(&store, &sender, &receiver, &clock).await;
    verify_cross_attempt_replay(&store, &sender, &receiver, &clock).await;
    let continuation = verify_approved_message(&store, &sender).await;
    verify_denial_and_quota(&store, &sender, &receiver, &continuation, &clock).await;
    verify_hop_limit(&store, &sender, &clock).await;
    store.close().await;
}

async fn initialize_mailbox(store: &Store) -> (HostAuthority, HostAuthority, HostAuthority) {
    let upgraded = history(store, "legacy-recipient").await;
    assert_eq!(upgraded.len(), 1);
    assert_eq!(upgraded[0].origin(), TagMessageOrigin::Workstream);
    assert_eq!(
        upgraded[0].workstream_post_id.as_deref(),
        Some("legacy-post")
    );
    assert_eq!(upgraded[0].state(), TagMessageState::Handled);
    for tag in ["alpha", "beta", "quiet", "outsider"] {
        store
            .put_tag(tag, &format!("Identity {tag}"), vec!["files:read".into()])
            .await
            .unwrap();
    }
    store
        .create_team(
            OPERATOR,
            &CreateTeamRequest {
                operation_id: "team".into(),
                team_id: "team".into(),
                name: "Team".into(),
                member_tag_ids: vec!["alpha".into(), "beta".into(), "quiet".into()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let sender = support::register_host(store, "sender").await;
    let receiver = support::register_host(store, "receiver").await;
    let other = support::register_host(store, "other").await;
    (sender, receiver, other)
}

struct PendingDelivery {
    first: SendAttemptTagMessageRequest,
    source: InspectAttemptRequest,
    inbox: InspectAttemptRequest,
    message_id: String,
    post_id: String,
}

async fn submit_direct_messages(
    store: &Store,
    sender: &HostAuthority,
    receiver: &HostAuthority,
    other: &HostAuthority,
    clock: &AtomicI64,
) -> PendingDelivery {
    ordinary(store, "alpha").await;
    let source = claim(store, sender, "alpha").await;
    let first = send("first", "beta", "  Direct secret </tag-message>  ");
    assert!(matches!(
        store
            .send_attempt_tag_message(
                &supertag_control_plane::AttemptAccess::new(sender, &source),
                &first
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    start(store, sender, &source).await;
    assert!(matches!(
        store
            .send_attempt_tag_message(
                &supertag_control_plane::AttemptAccess::new(other, &source),
                &first
            )
            .await,
        Err(StoreError::FailedPrecondition(_) | StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store
            .send_attempt_tag_message(
                &supertag_control_plane::AttemptAccess::new(sender, &source),
                &send("self", "alpha", "No")
            )
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    assert!(matches!(
        store
            .send_attempt_tag_message(
                &supertag_control_plane::AttemptAccess::new(sender, &source),
                &send("missing", "missing", "No")
            )
            .await,
        Err(StoreError::NotFound(_))
    ));
    assert!(matches!(
        store
            .send_attempt_tag_message( &supertag_control_plane::AttemptAccess::new(sender, &source), &send( "outsider", "outsider", "No"))
            .await,
        Err(StoreError::FailedPrecondition(reason)) if reason.contains("acceptsMessagesFrom")
    ));
    assert!(matches!(
        store
            .send_attempt_tag_message(
                &supertag_control_plane::AttemptAccess::new(sender, &source),
                &send("empty", "beta", " \n ")
            )
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    assert!(matches!(
        store
            .send_attempt_tag_message(
                &supertag_control_plane::AttemptAccess::new(sender, &source),
                &send("long", "beta", &"🦀".repeat(4001))
            )
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    let access = supertag_control_plane::AttemptAccess::new(sender, &source);
    let (one, replay) = tokio::join!(
        store.send_attempt_tag_message(&access, &first),
        store.send_attempt_tag_message(&access, &first)
    );
    let (one, replay) = (one.unwrap(), replay.unwrap());
    assert_ne!(one.duplicate, replay.duplicate);
    assert_eq!(one.message, replay.message);
    let message = one.message.unwrap();
    assert_eq!(message.origin(), TagMessageOrigin::Direct);
    assert!(message.workstream_post_id.is_none());
    assert_eq!(message.sender_tag_id, "alpha");
    assert_eq!(message.recipient_tag_id, "beta");
    assert_eq!(message.source_task_id, source.task_id);
    assert_eq!(message.hops, 0);
    assert_eq!(message.text, first.text.trim());
    assert!(message.objective_id.is_none());
    assert!(matches!(
        store
            .send_attempt_tag_message(
                &supertag_control_plane::AttemptAccess::new(sender, &source),
                &send("first", "beta", "changed")
            )
            .await,
        Err(StoreError::Conflict(_))
    ));
    store
        .send_attempt_tag_message(
            &supertag_control_plane::AttemptAccess::new(sender, &source),
            &send("second", "beta", &"🦀".repeat(4000)),
        )
        .await
        .unwrap();
    // The inbox turn is accepted once the debounced wake is due; a later Tag change does not
    // reach it.
    let inbox = claim_inbox(store, clock, receiver, "beta").await;
    store
        .put_tag("beta", "Changed after inbox acceptance", vec![])
        .await
        .unwrap();
    let bound = start(store, receiver, &inbox).await;
    assert_eq!(bound.instructions, "Identity beta");
    assert_eq!(bound.prompt.matches("<tag-message ").count(), 2);
    assert!(bound.prompt.contains("via=\"direct message\""));
    assert!(!bound.prompt.contains("via=\"workstream post\""));
    assert!(bound.prompt.contains("&lt;/tag-message&gt;"));
    let third = send("third", "beta", "Third direct");
    let fourth = send("fourth", "beta", "Fourth direct");
    let access = supertag_control_plane::AttemptAccess::new(sender, &source);
    let (third, fourth) = tokio::join!(
        store.send_attempt_tag_message(&access, &third),
        store.send_attempt_tag_message(&access, &fourth)
    );
    assert_eq!(usize::from(third.is_ok()) + usize::from(fourth.is_ok()), 1);
    let error = third.err().or_else(|| fourth.err()).unwrap();
    assert!(matches!(error, StoreError::FailedPrecondition(_)));
    assert!(
        store
            .send_attempt_tag_message(
                &supertag_control_plane::AttemptAccess::new(sender, &source),
                &first
            )
            .await
            .unwrap()
            .duplicate
    );
    let public = store
        .post_attempt_workstream(
            &supertag_control_plane::AttemptAccess::new(sender, &source),
            &PostAttemptWorkstreamRequest {
                operation_id: "public".into(),
                body: "Public update".into(),
                to_tag_ids: vec!["beta".into()],
            },
        )
        .await
        .unwrap()
        .post
        .unwrap();
    assert_eq!(
        store.get_task(&inbox.task_id).await.unwrap().prompt,
        bound.prompt
    );
    PendingDelivery {
        first,
        source,
        inbox,
        message_id: message.message_id,
        post_id: public.post_id,
    }
}

async fn verify_restarted_delivery(
    store: &Store,
    sender: &HostAuthority,
    receiver: &HostAuthority,
    other: &HostAuthority,
    delivery: PendingDelivery,
    clock: &AtomicI64,
) {
    let PendingDelivery {
        first,
        source,
        inbox,
        message_id,
        post_id,
    } = delivery;
    let replay = store
        .send_attempt_tag_message(
            &supertag_control_plane::AttemptAccess::new(sender, &source),
            &first,
        )
        .await
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.message.unwrap().message_id, message_id);
    let all = history(store, "beta").await;
    assert_eq!(
        all.iter()
            .filter(|m| m.origin() == TagMessageOrigin::Direct)
            .count(),
        3
    );
    assert_eq!(
        all.iter()
            .filter(|m| m.origin() == TagMessageOrigin::Workstream)
            .count(),
        1
    );
    assert_eq!(
        all.iter()
            .find(|m| m.origin() == TagMessageOrigin::Workstream)
            .unwrap()
            .workstream_post_id
            .as_deref(),
        Some(post_id.as_str())
    );
    finish(store, receiver, &inbox, vec![]).await;
    let successor = claim_inbox(store, clock, receiver, "beta").await;
    let next = start(store, receiver, &successor).await;
    // The addressed post comes in the Team's digest, not as a message of its own.
    assert_eq!(next.prompt.matches("<tag-message ").count(), 1);
    assert!(next.prompt.contains("via=\"direct message\""));
    assert!(
        next.prompt
            .contains("from=\"alpha\" to=\"you\">\nPublic update\n</workstream-post>"),
        "{}",
        next.prompt
    );
    finish(store, receiver, &successor, vec![]).await;
    ordinary(store, "quiet").await;
    let quiet = claim(store, other, "quiet").await;
    start(store, other, &quiet).await;
    assert!(
        store
            .read_attempt_mailbox(
                &supertag_control_plane::AttemptAccess::new(other, &quiet),
                &ReadMailboxRequest {
                    ..Default::default()
                }
            )
            .await
            .unwrap()
            .messages
            .is_empty()
    );
    let shared = store
        .read_attempt_workstream(
            &supertag_control_plane::AttemptAccess::new(other, &quiet),
            &ReadAttemptWorkstreamRequest {
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let shared = shared.page.unwrap();
    assert_eq!(shared.posts.len(), 1);
    assert_eq!(shared.posts[0].body, "Public update");
    finish(store, other, &quiet, vec![]).await;
    finish(store, sender, &source, vec![]).await;
    assert!(
        store
            .send_attempt_tag_message(
                &supertag_control_plane::AttemptAccess::new(sender, &source),
                &first
            )
            .await
            .is_err()
    );
}

async fn verify_directional_grants(store: &Store) {
    // Directional recipient grants and durable idempotency survive restart.
    let allow = grant("allow", "alpha", "outsider", true);
    assert!(matches!(
        store.change_mailbox_grant("host:sender", &allow).await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store
            .change_mailbox_grant(OPERATOR, &grant("self-grant", "alpha", "alpha", true))
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    assert!(matches!(
        store
            .change_mailbox_grant(OPERATOR, &grant("bad-grant", "alpha", "missing", true))
            .await,
        Err(StoreError::NotFound(_))
    ));
    let (a, b) = tokio::join!(
        store.change_mailbox_grant(OPERATOR, &allow),
        store.change_mailbox_grant(OPERATOR, &allow)
    );
    assert!(
        a.unwrap().changed && b.unwrap().changed,
        "exact operation replays its original response"
    );
    assert!(
        !store
            .change_mailbox_grant(OPERATOR, &grant("already", "alpha", "outsider", true))
            .await
            .unwrap()
            .changed
    );
    assert!(
        store
            .change_mailbox_grant(OPERATOR, &grant("revoke", "alpha", "outsider", false))
            .await
            .unwrap()
            .changed
    );
    assert!(
        store
            .change_mailbox_grant(OPERATOR, &allow)
            .await
            .unwrap()
            .changed
    );
    assert!(
        store
            .list_mailbox_grants(
                OPERATOR,
                &ListMailboxGrantsRequest {
                    tag_id: "outsider".into(),
                    ..Default::default()
                }
            )
            .await
            .unwrap()
            .grants
            .is_empty(),
        "replay must not undo a later revoke"
    );
    store
        .change_mailbox_grant(OPERATOR, &grant("again", "alpha", "outsider", true))
        .await
        .unwrap();
    store
        .change_mailbox_grant(OPERATOR, &grant("quiet-grant", "quiet", "outsider", true))
        .await
        .unwrap();
    let page = store
        .list_mailbox_grants(
            OPERATOR,
            &ListMailboxGrantsRequest {
                tag_id: "outsider".into(),
                limit: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(page.grants.len(), 1);
    assert!(!page.next_cursor.is_empty());
    let rest = store
        .list_mailbox_grants(
            OPERATOR,
            &ListMailboxGrantsRequest {
                tag_id: "outsider".into(),
                limit: 1,
                cursor: page.next_cursor.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(rest.grants.len(), 1);
    assert_ne!(page.grants, rest.grants);
    assert!(
        store
            .list_mailbox_grants(
                OPERATOR,
                &ListMailboxGrantsRequest {
                    tag_id: "alpha".into(),
                    cursor: page.next_cursor,
                    ..Default::default()
                }
            )
            .await
            .is_err()
    );
}

async fn verify_scoped_delivery(
    store: &Store,
    sender: &HostAuthority,
    receiver: &HostAuthority,
    clock: &AtomicI64,
) {
    assert_eq!(history(store, "beta").await.len(), 4);
    ordinary(store, "alpha").await;
    let source = claim(store, sender, "alpha").await;
    start(store, sender, &source).await;
    let request = send("direct-outsider", "outsider", "Scoped grant");
    store
        .send_attempt_tag_message(
            &supertag_control_plane::AttemptAccess::new(sender, &source),
            &request,
        )
        .await
        .unwrap();
    store
        .change_mailbox_grant(OPERATOR, &grant("revoke-live", "alpha", "outsider", false))
        .await
        .unwrap();
    assert!(matches!(
        store
            .send_attempt_tag_message( &supertag_control_plane::AttemptAccess::new(sender, &source), &send( "revoked", "outsider", "No"))
            .await,
        Err(StoreError::FailedPrecondition(reason)) if reason.contains("acceptsMessagesFrom")
    ));
    finish(store, sender, &source, vec![]).await;
    let inbox = claim_inbox(store, clock, receiver, "outsider").await;
    start(store, receiver, &inbox).await;
    assert!(matches!(
        store
            .send_attempt_tag_message( &supertag_control_plane::AttemptAccess::new(receiver, &inbox),
                &send( "no-reverse", "alpha", "No reverse grant")
            )
            .await,
        Err(StoreError::FailedPrecondition(reason)) if reason.contains("acceptsMessagesFrom")
    ));
    finish(store, receiver, &inbox, vec![]).await;
}

async fn verify_cross_attempt_replay(
    store: &Store,
    sender: &HostAuthority,
    receiver: &HostAuthority,
    clock: &AtomicI64,
) {
    // A confirmed retry gets a new Attempt, but replays the Task's exact send
    // receipt instead of duplicating a message accepted before execution stopped.
    ordinary(store, "alpha").await;
    let before_retry = claim(store, sender, "alpha").await;
    start(store, sender, &before_retry).await;
    let before = store
        .send_attempt_tag_message(
            &supertag_control_plane::AttemptAccess::new(sender, &before_retry),
            &send("cross-attempt", "beta", "Accepted before recovery"),
        )
        .await
        .unwrap()
        .message
        .unwrap();
    clock.fetch_add(30_001, Ordering::SeqCst);
    store.sweep_expired_attempts().await.unwrap();
    assert_eq!(
        store.get_task(&before_retry.task_id).await.unwrap().state(),
        TaskState::Uncertain
    );
    store
        .resolve_attempt(
            OPERATOR,
            &ResolveAttemptRequest {
                task_id: before_retry.task_id.clone(),
                attempt_id: before_retry.attempt_id.clone(),
                operation_id: "confirmed-retry".into(),
                decision: AttemptDecision::Retry.into(),
                evidence: "Synthetic execution stopped before this test's explicit retry".into(),
                confirmed_stopped: true,
            },
        )
        .await
        .unwrap();
    let after_retry = claim(store, sender, "alpha").await;
    assert_eq!(before_retry.task_id, after_retry.task_id);
    assert_ne!(before_retry.attempt_id, after_retry.attempt_id);
    start(store, sender, &after_retry).await;
    let replay = store
        .send_attempt_tag_message(
            &supertag_control_plane::AttemptAccess::new(sender, &after_retry),
            &send("cross-attempt", "beta", "Accepted before recovery"),
        )
        .await
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.message.unwrap().message_id, before.message_id);
    assert!(
        store
            .send_attempt_tag_message(
                &supertag_control_plane::AttemptAccess::new(sender, &before_retry),
                &send("stale-retry", "beta", "No")
            )
            .await
            .is_err()
    );
    finish(store, sender, &after_retry, vec![]).await;
    let inbox = claim_inbox(store, clock, receiver, "beta").await;
    start(store, receiver, &inbox).await;
    finish(store, receiver, &inbox, vec![]).await;
}

async fn verify_approved_message(store: &Store, sender: &HostAuthority) -> InspectAttemptRequest {
    let baseline_mailbox_count = history(store, "beta").await.len();

    // Approval is consumed only in the same transaction as the direct message.
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "alpha".into(),
            instructions: "Sender".into(),
            allowed_actions: vec!["mailbox:send".into()],
            approval_rules: vec![ApprovalRule {
                action: "mailbox:send".into(),
                operator_ids: vec!["alice".into()],
            }],
            ..Default::default()
        })
        .await
        .unwrap();
    ordinary(store, "alpha").await;
    let source = claim(store, sender, "alpha").await;
    start(store, sender, &source).await;
    let request = send("approved-direct", "beta", "Private approved message");
    let pending = store
        .send_attempt_tag_message(
            &supertag_control_plane::AttemptAccess::new(sender, &source),
            &request,
        )
        .await
        .unwrap();
    assert!(pending.message.is_none());
    let approval = pending.approval.unwrap();
    assert_eq!(approval.action, "mailbox:send");
    assert_eq!(approval.resource, "beta");
    assert_eq!(history(store, "beta").await.len(), baseline_mailbox_count);
    finish(store, sender, &source, vec![approval.approval_id.clone()]).await;
    let decided = store
        .decide_approval(
            OPERATOR,
            &DecideApprovalRequest {
                approval_id: approval.approval_id.clone(),
                operation_id: "approve-direct".into(),
                approve: true,
                scope: ApprovalScope::Once.into(),
                reason: "Reviewed recipient and text".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let continuation = claim(store, sender, "alpha").await;
    assert_eq!(
        decided.continuation_task_id.as_deref(),
        Some(continuation.task_id.as_str())
    );
    start(store, sender, &continuation).await;
    let retry = send("retry-direct", "beta", "Private approved message");
    assert!(
        store
            .send_attempt_tag_message(
                &supertag_control_plane::AttemptAccess::new(sender, &continuation),
                &retry
            )
            .await
            .unwrap()
            .message
            .is_some()
    );
    assert!(
        store
            .send_attempt_tag_message(
                &supertag_control_plane::AttemptAccess::new(sender, &continuation),
                &retry
            )
            .await
            .unwrap()
            .duplicate
    );
    assert!(
        store
            .get_approval(OPERATOR, &approval.approval_id)
            .await
            .unwrap()
            .consumed_at_ms
            .is_some()
    );
    continuation
}

async fn verify_denial_and_quota(
    store: &Store,
    sender: &HostAuthority,
    receiver: &HostAuthority,
    continuation: &InspectAttemptRequest,
    clock: &AtomicI64,
) {
    // A denial delivers nothing. A later quota refusal must not consume a
    // separately approved Once grant: consumption belongs to the actual insert.
    let denied_request = send("denied-direct", "beta", "Do not send");
    let denied = store
        .send_attempt_tag_message(
            &supertag_control_plane::AttemptAccess::new(sender, continuation),
            &denied_request,
        )
        .await
        .unwrap()
        .approval
        .unwrap();
    store
        .decide_approval(
            OPERATOR,
            &DecideApprovalRequest {
                approval_id: denied.approval_id,
                operation_id: "deny-direct".into(),
                approve: false,
                reason: "Recipient does not need this".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let refused = store
        .send_attempt_tag_message(
            &supertag_control_plane::AttemptAccess::new(sender, continuation),
            &denied_request,
        )
        .await
        .unwrap();
    assert!(refused.message.is_none());
    assert_eq!(refused.approval.unwrap().state(), ApprovalState::Denied);
    let mut held = vec![];
    for index in 0..3 {
        let request = send(
            &format!("held-{index}"),
            "beta",
            &format!("Approved extra {index}"),
        );
        let approval = store
            .send_attempt_tag_message(
                &supertag_control_plane::AttemptAccess::new(sender, continuation),
                &request,
            )
            .await
            .unwrap()
            .approval
            .unwrap();
        store
            .decide_approval(
                OPERATOR,
                &DecideApprovalRequest {
                    approval_id: approval.approval_id.clone(),
                    operation_id: format!("approve-held-{index}"),
                    approve: true,
                    scope: ApprovalScope::Once.into(),
                    reason: "Explicitly reviewed".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        held.push((request, approval.approval_id));
    }
    for (request, _) in held.iter().take(2) {
        assert!(
            store
                .send_attempt_tag_message(
                    &supertag_control_plane::AttemptAccess::new(sender, continuation),
                    request
                )
                .await
                .unwrap()
                .message
                .is_some()
        );
    }
    assert!(matches!(
        store
            .send_attempt_tag_message(
                &supertag_control_plane::AttemptAccess::new(sender, continuation),
                &held[2].0
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert!(
        store
            .get_approval(OPERATOR, &held[2].1)
            .await
            .unwrap()
            .consumed_at_ms
            .is_none()
    );
    finish(store, sender, continuation, vec![]).await;
    let inbox = claim_inbox(store, clock, receiver, "beta").await;
    start(store, receiver, &inbox).await;
    finish(store, receiver, &inbox, vec![]).await;
}

async fn verify_hop_limit(store: &Store, sender: &HostAuthority, clock: &AtomicI64) {
    // Each new inbox message inherits the bound chain, including approval turns. The chain wakes
    // alpha and beta five times for one originating Task, past the default mutual wake limit, so
    // the Team raises it.
    let team = store.get_team(OPERATOR, "team").await.unwrap();
    store
        .update_team(
            OPERATOR,
            &UpdateTeamRequest {
                operation_id: "hop-wake-limits".into(),
                team: "team".into(),
                expected_revision: team.revision,
                wake_limits: Some(TeamWakeLimits {
                    mutual_per_task: Some(10),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store.put_tag("alpha", "Sender", vec![]).await.unwrap();
    ordinary(store, "alpha").await;
    let mut current = claim(store, sender, "alpha").await;
    start(store, sender, &current).await;
    for hop in 0..=4 {
        let to = if hop % 2 == 0 { "beta" } else { "alpha" };
        if hop == 3 {
            store
                .put_tag_spec(PutTagRequest {
                    tag_id: "alpha".into(),
                    instructions: "Sender".into(),
                    allowed_actions: vec!["mailbox:send".into()],
                    approval_rules: vec![ApprovalRule {
                        action: "mailbox:send".into(),
                        operator_ids: vec!["alice".into()],
                    }],
                    ..Default::default()
                })
                .await
                .unwrap();
        }
        if hop == 4 {
            let pending = store
                .send_attempt_tag_message(
                    &supertag_control_plane::AttemptAccess::new(sender, &current),
                    &send("chain", to, "Forward chain"),
                )
                .await
                .unwrap()
                .approval
                .unwrap();
            finish(store, sender, &current, vec![pending.approval_id.clone()]).await;
            store
                .decide_approval(
                    OPERATOR,
                    &DecideApprovalRequest {
                        approval_id: pending.approval_id,
                        operation_id: "hop-grant".into(),
                        approve: true,
                        scope: ApprovalScope::Once.into(),
                        reason: "Forward once".into(),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
            current = claim(store, sender, "alpha").await;
            start(store, sender, &current).await;
        }
        let sent = store
            .send_attempt_tag_message(
                &supertag_control_plane::AttemptAccess::new(sender, &current),
                &send("chain", to, "Forward chain"),
            )
            .await
            .unwrap()
            .message
            .unwrap();
        assert_eq!(sent.hops, hop);
        finish(store, sender, &current, vec![]).await;
        current = claim_inbox(store, clock, sender, to).await;
        start(store, sender, &current).await;
    }
    let rejected = send("too-far", "alpha", "No sixth inbox");
    assert!(matches!(
        store
            .send_attempt_tag_message(
                &supertag_control_plane::AttemptAccess::new(sender, &current),
                &rejected
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    clock.fetch_add(30_001, Ordering::SeqCst);
    assert!(
        store
            .send_attempt_tag_message(
                &supertag_control_plane::AttemptAccess::new(sender, &current),
                &send("stale", "alpha", "No")
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn sqlite_direct_mailbox_contract() {
    let directory = tempfile::tempdir().unwrap();
    direct_contract(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("direct.db").display()
    ))
    .await;
}
#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL server"]
async fn postgres_direct_mailbox_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_direct_mailbox_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { direct_contract(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    result.expect("PostgreSQL direct Mailbox contract failed");
}
