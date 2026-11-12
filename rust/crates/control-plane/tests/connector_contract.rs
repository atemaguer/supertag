mod support;

use sqlx::{Connection, Executor};
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::{
    AcceptEventRequest, FinishTaskRequest, ReplyDestination, ReplyState, SettleReplyRequest,
    StartTaskRequest, SubmitTaskRequest, TaskState,
};
use uuid::Uuid;

fn event(account: &str, id: &str) -> AcceptEventRequest {
    AcceptEventRequest {
        account_id: account.into(),
        event_id: id.into(),
        tag_id: "reviewer".into(),
        session_id: format!("session-{account}-{id}"),
        prompt: "Review this".into(),
        destination: Some(ReplyDestination {
            conversation_id: "channel".into(),
            thread_id: Some("thread".into()),
        }),
    }
}

async fn finish(store: &Store, task_id: &str, succeeded: bool) -> FinishTaskRequest {
    let host = support::register_host(store, "worker").await;
    let assignment = store
        .claim_task(&host, &format!("claim-{task_id}"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(assignment.task.as_ref().unwrap().task_id, task_id);
    store
        .start_task(
            &host,
            &StartTaskRequest {
                task_id: task_id.into(),
                attempt_id: assignment.attempt_id.clone(),
                lease_token: assignment.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    let finish = FinishTaskRequest {
        waiting_approval_ids: vec![],
        workspace_delivery: None,
        task_id: task_id.into(),
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
        result: "Reviewed".into(),
        succeeded,
        objective_signal: 0,
        checkpoint_sha256: None,
    };
    store.finish_task(&host, &finish).await.unwrap();
    finish
}

async fn seed_previous_schema(url: &str) {
    sqlx::any::install_default_drivers();
    let mut connection = sqlx::AnyConnection::connect(url).await.unwrap();
    let migration = if url.starts_with("sqlite:") {
        include_str!("../migrations/sqlite/0001_initial.sql")
    } else {
        include_str!("../migrations/postgresql/0001_initial.sql")
    };
    sqlx::raw_sql(migration)
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("INSERT INTO supertag_v2_tags (tag_id, instructions, allowed_actions, revision) VALUES ('old-tag', 'Original instructions', '[\"files:read\"]', 1)")
        .execute(&mut connection).await.unwrap();
    sqlx::query("INSERT INTO supertag_v2_tasks (task_id, tag_id, session_id, prompt, instructions, allowed_actions, tag_revision, state, result, accepted_order) VALUES ('old-task', 'old-tag', 'old-session', 'Old work', 'Original instructions', '[\"files:read\"]', 1, $1, 'Old result', 1)")
        .bind(TaskState::Succeeded as i64).execute(&mut connection).await.unwrap();
    sqlx::query("UPDATE supertag_v2_write_order SET revision = 1 WHERE singleton = 1")
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
}

async fn contract(url: String) {
    // Both dialects upgrade a real v1 database without replacing its accepted work.
    seed_previous_schema(&url).await;
    let store = Store::open(&url).await.unwrap();
    let host = support::register_host(&store, "worker").await;
    let previous = store.get_task("old-task").await.unwrap();
    assert_eq!(previous.instructions, "Original instructions");
    assert_eq!(previous.allowed_actions, ["files:read"]);
    assert_eq!(previous.result.as_deref(), Some("Old result"));
    assert_eq!(previous.state, TaskState::Succeeded as i32);
    store
        .put_tag("reviewer", "Instructions", vec!["files:read".into()])
        .await
        .unwrap();
    let input = event("acme", "event-1");
    assert!(matches!(
        store.accept_event("connector:other", &input).await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(
        store
            .claim_task(&host, "before-ingress")
            .await
            .unwrap()
            .is_none()
    );
    let (first, retry) = tokio::join!(
        store.accept_event("connector:acme", &input),
        store.accept_event("connector:acme", &input)
    );
    let task = first.unwrap();
    assert_eq!(task, retry.unwrap());
    let mut changed = input.clone();
    changed.destination.as_mut().unwrap().thread_id = Some("elsewhere".into());
    assert!(matches!(
        store.accept_event("connector:acme", &changed).await,
        Err(StoreError::Conflict(_))
    ));
    store.close().await;

    let store = Store::open(&url).await.unwrap();
    assert_eq!(
        store.accept_event("connector:acme", &input).await.unwrap(),
        task
    );
    assert!(
        store
            .claim_reply("connector:acme", "empty")
            .await
            .unwrap()
            .reply
            .is_none()
    );
    let completion = finish(&store, &task.task_id, true).await;
    // The Task result and its sole reply survive together, even if Finish's response was lost.
    store.close().await;
    let store = Store::open(&url).await.unwrap();
    assert_eq!(
        store.finish_task(&host, &completion).await.unwrap().state,
        TaskState::Succeeded as i32
    );
    assert!(
        store
            .claim_reply("connector:other", "empty")
            .await
            .unwrap()
            .reply
            .is_none()
    );
    let (left, right) = tokio::join!(
        store.claim_reply("connector:acme", "delivery-a"),
        store.claim_reply("connector:acme", "delivery-b")
    );
    let (operation, claim) = match (left.unwrap(), right.unwrap()) {
        (a, b) if a.reply.is_some() && b.reply.is_none() => ("delivery-a", a),
        (a, b) if a.reply.is_none() && b.reply.is_some() => ("delivery-b", b),
        other => panic!("one reply claim must win: {other:?}"),
    };
    let reply = claim.reply.as_ref().unwrap();
    assert_eq!(reply.task_id, task.task_id);
    assert_eq!(reply.account_id, "acme");
    assert_eq!(reply.destination, input.destination);
    assert_eq!(reply.text, "Reviewed");
    assert_eq!(reply.state, ReplyState::Claimed as i32);
    let settle = SettleReplyRequest {
        reply_id: reply.reply_id.clone(),
        lease_token: claim.lease_token.clone(),
        state: ReplyState::Delivered as i32,
        provider_receipt: Some("provider-message-1".into()),
    };
    assert!(matches!(
        store.settle_reply("connector:other", &settle).await,
        Err(StoreError::NotFound(_))
    ));
    let mut forged = settle.clone();
    forged.lease_token = "wrong".into();
    assert!(matches!(
        store.settle_reply("connector:acme", &forged).await,
        Err(StoreError::PermissionDenied)
    ));
    let mut requeue = settle.clone();
    requeue.state = ReplyState::Pending as i32;
    assert!(matches!(
        store.settle_reply("connector:acme", &requeue).await,
        Err(StoreError::InvalidArgument(_))
    ));
    store.close().await;

    let store = Store::open(&url).await.unwrap();
    assert_eq!(
        store
            .claim_reply("connector:acme", operation)
            .await
            .unwrap(),
        claim
    );
    // A process lost after claiming is never blindly replaced by a new delivery operation.
    assert!(
        store
            .claim_reply("connector:acme", "replacement")
            .await
            .unwrap()
            .reply
            .is_none()
    );
    let delivered = store.settle_reply("connector:acme", &settle).await.unwrap();
    assert_eq!(delivered.state, ReplyState::Delivered as i32);
    assert_eq!(
        delivered.provider_receipt.as_deref(),
        Some("provider-message-1")
    );
    assert_eq!(
        store.settle_reply("connector:acme", &settle).await.unwrap(),
        delivered
    );
    let mut conflicting = settle.clone();
    conflicting.provider_receipt = Some("different-effect".into());
    assert!(matches!(
        store.settle_reply("connector:acme", &conflicting).await,
        Err(StoreError::Conflict(_))
    ));
    store.close().await;

    let store = Store::open(&url).await.unwrap();
    assert_eq!(
        store.settle_reply("connector:acme", &settle).await.unwrap(),
        delivered
    );
    assert_eq!(
        store
            .claim_reply("connector:acme", operation)
            .await
            .unwrap()
            .reply
            .unwrap(),
        delivered
    );
    assert!(
        store
            .claim_reply("connector:acme", "after-settlement")
            .await
            .unwrap()
            .reply
            .is_none()
    );
    // Identical provider event IDs belong to their own authenticated accounts.
    let other = store
        .accept_event("connector:other", &event("other", "event-1"))
        .await
        .unwrap();
    assert_ne!(other.task_id, task.task_id);
    finish(&store, &other.task_id, true).await;
    let other_claim = store
        .claim_reply("connector:other", "delivery")
        .await
        .unwrap();
    let uncertain = store
        .settle_reply(
            "connector:other",
            &SettleReplyRequest {
                reply_id: other_claim.reply.unwrap().reply_id,
                lease_token: other_claim.lease_token,
                state: ReplyState::Uncertain as i32,
                provider_receipt: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(uncertain.state, ReplyState::Uncertain as i32);
    assert!(
        store
            .claim_reply("connector:other", "do-not-resend")
            .await
            .unwrap()
            .reply
            .is_none()
    );
    // Failed work and direct operator work have no successful surface reply to deliver.
    let failed = store
        .accept_event("connector:acme", &event("acme", "failed"))
        .await
        .unwrap();
    finish(&store, &failed.task_id, false).await;
    let direct = store
        .submit_task(
            "operator:alice",
            &SubmitTaskRequest {
                tag_id: "reviewer".into(),
                session_id: "direct".into(),
                operation_id: "direct".into(),
                prompt: "direct".into(),
            },
        )
        .await
        .unwrap();
    finish(&store, &direct.task_id, true).await;
    assert!(
        store
            .claim_reply("connector:acme", "no-failed-or-direct")
            .await
            .unwrap()
            .reply
            .is_none()
    );
    store.close().await;
}

#[tokio::test]
async fn sqlite_connector_contract() {
    let dir = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("state.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_connector_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("dedicated PostgreSQL URL file is required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!("supertag_rust_connector_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    url.set_path(&name);
    let local = tokio::task::LocalSet::new();
    let outcome = local
        .run_until(async move { tokio::task::spawn_local(contract(url.to_string())).await })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL connector contract failed");
}
