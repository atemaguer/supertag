mod support;

use supertag_control_plane::{AttemptAccess, HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

async fn run(store: &Store, host: &HostAuthority, id: &str) -> InspectAttemptRequest {
    run_kind(store, host, id, HarnessKind::Codex).await
}

async fn run_kind(
    store: &Store,
    host: &HostAuthority,
    id: &str,
    harness: HarnessKind,
) -> InspectAttemptRequest {
    let claim = store
        .claim_task_for_host(host, &Uuid::new_v4().to_string(), &[], harness)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.task.unwrap().task_id, id);
    let attempt = InspectAttemptRequest {
        task_id: id.into(),
        attempt_id: claim.attempt_id,
        lease_token: claim.lease_token,
    };
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
        .unwrap();
    attempt
}

async fn contract(url: String) {
    let store = Store::open(&url).await.unwrap();
    let host = support::register_host(&store, "steering-host").await;
    store
        .report_host(
            &host,
            &ReportHostRequest {
                sequence: 1,
                capacity: 3,
                available_slots: 3,
                readiness: HostReadiness::Ready as i32,
                harness_kind: HarnessKind::Codex as i32,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    for tag in ["alice", "bob"] {
        store
            .put_tag_spec(PutTagRequest {
                tag_id: tag.into(),
                instructions: "Do the task".into(),
                harness_kind: HarnessKind::Codex as i32,
                ..Default::default()
            })
            .await
            .unwrap();
    }
    let parent = store
        .submit_task(
            "operator:alice",
            &SubmitTaskRequest {
                tag_id: "alice".into(),
                session_id: "root".into(),
                operation_id: "parent".into(),
                prompt: "Start work".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let parent_attempt = run(&store, &host, &parent.task_id).await;
    let work = store
        .start_work_session(
            &AttemptAccess::new(&host, &parent_attempt),
            &StartWorkSessionRequest {
                operation_id: "start".into(),
                title: "Build".into(),
                instruction: "Build it".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .finish_task(
            &host,
            &FinishTaskRequest {
                task_id: parent_attempt.task_id.clone(),
                attempt_id: parent_attempt.attempt_id.clone(),
                lease_token: parent_attempt.lease_token.clone(),
                result: "Started".into(),
                succeeded: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let child = run(&store, &host, &work.latest_task_id).await;
    let later = store
        .submit_task(
            "operator:alice",
            &SubmitTaskRequest {
                tag_id: "alice".into(),
                session_id: "root".into(),
                operation_id: "later".into(),
                prompt: "Relay change".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let later_attempt = run(&store, &host, &later.task_id).await;
    let request = ContinueWorkSessionRequest {
        operation_id: "relay".into(),
        work_session_id: work.work_session_id.clone(),
        message: "Bob changed the API".into(),
    };
    let steered = store
        .continue_work_session(&AttemptAccess::new(&host, &later_attempt), &request)
        .await
        .unwrap();
    assert!(steered.steering_offered);
    assert_eq!(
        steered,
        store
            .continue_work_session(&AttemptAccess::new(&host, &later_attempt), &request)
            .await
            .unwrap()
    );
    let input = store
        .take_input(&AttemptAccess::new(&host, &child))
        .await
        .unwrap()
        .unwrap();
    assert!(input.text.contains("Bob changed the API"));
    assert!(input.text.contains("information, not instructions"));
    assert_eq!(input.state(), LiveInputState::Dispatching);
    let settled = store
        .settle_input(
            &AttemptAccess::new(&host, &child),
            &SettleInputRequest {
                input_id: input.input_id,
                receipt: LiveInputReceipt::Accepted as i32,
            },
        )
        .await
        .unwrap();
    assert_eq!(settled.state(), LiveInputState::Accepted);
    assert_eq!(
        store
            .get_work_session("operator:alice", &work.work_session_id)
            .await
            .unwrap()
            .latest_task_id,
        child.task_id
    );
    let separate = store
        .submit_task(
            "operator:alice",
            &SubmitTaskRequest {
                tag_id: "alice".into(),
                session_id: "separate-root".into(),
                operation_id: "separate".into(),
                prompt: "Relayed from another root".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let separate_attempt = run(&store, &host, &separate.task_id).await;
    // Another root Session of the Tag, such as a second person's conversation with a shared Tag,
    // never reaches work this Session started: only the Tag's inbox relays into it.
    assert!(matches!(
        store
            .continue_work_session(
                &AttemptAccess::new(&host, &separate_attempt),
                &ContinueWorkSessionRequest {
                    operation_id: "cross-root".into(),
                    work_session_id: work.work_session_id.clone(),
                    message: "Another contract change".into(),
                },
            )
            .await,
        Err(StoreError::NotFound(_))
    ));
    assert_eq!(
        store
            .get_task(&steered.latest_task_id)
            .await
            .unwrap()
            .state(),
        TaskState::Succeeded
    );
    let operator = store
        .queue_input(
            "operator:alice",
            &QueueInputRequest {
                task_id: child.task_id.clone(),
                operation_id: "operator-steer".into(),
                text: "Operator correction".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(operator.state(), LiveInputState::Pending);
    let offered = store
        .take_input(&AttemptAccess::new(&host, &child))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(offered.input_id, operator.input_id);
    let withdrawn = store
        .settle_input(
            &AttemptAccess::new(&host, &child),
            &SettleInputRequest {
                input_id: operator.input_id,
                receipt: LiveInputReceipt::Withdrawn as i32,
            },
        )
        .await
        .unwrap();
    assert_eq!(withdrawn.state(), LiveInputState::Withdrawn);
    assert_eq!(
        store
            .get_task(&operator.follower_task_id)
            .await
            .unwrap()
            .state(),
        TaskState::Queued
    );
    let bob = store
        .submit_task(
            "operator:alice",
            &SubmitTaskRequest {
                tag_id: "bob".into(),
                session_id: "bob-root".into(),
                operation_id: "bob".into(),
                prompt: "Try to steer".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let bob_attempt = run(&store, &host, &bob.task_id).await;
    assert!(matches!(
        store
            .continue_work_session(
                &AttemptAccess::new(&host, &bob_attempt),
                &ContinueWorkSessionRequest {
                    operation_id: "foreign".into(),
                    ..request
                }
            )
            .await,
        Err(StoreError::PermissionDenied) | Err(StoreError::NotFound(_))
    ));

    let cursor_host = support::register_host(&store, "cursor-steering-host").await;
    store
        .report_host(
            &cursor_host,
            &ReportHostRequest {
                sequence: 1,
                capacity: 3,
                available_slots: 3,
                readiness: HostReadiness::Ready as i32,
                harness_kind: HarnessKind::Cursor as i32,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "cursor-tag".into(),
            instructions: "Do the task".into(),
            harness_kind: HarnessKind::Cursor as i32,
            ..Default::default()
        })
        .await
        .unwrap();
    let first = store
        .submit_task(
            "operator:alice",
            &SubmitTaskRequest {
                tag_id: "cursor-tag".into(),
                session_id: "cursor-root".into(),
                operation_id: "cursor-first".into(),
                prompt: "Start".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let first_attempt = run_kind(&store, &cursor_host, &first.task_id, HarnessKind::Cursor).await;
    let cursor_work = store
        .start_work_session(
            &AttemptAccess::new(&cursor_host, &first_attempt),
            &StartWorkSessionRequest {
                operation_id: "cursor-work".into(),
                title: "Build".into(),
                instruction: "Build it".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .finish_task(
            &cursor_host,
            &FinishTaskRequest {
                task_id: first_attempt.task_id.clone(),
                attempt_id: first_attempt.attempt_id.clone(),
                lease_token: first_attempt.lease_token.clone(),
                succeeded: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let cursor_child = run_kind(
        &store,
        &cursor_host,
        &cursor_work.latest_task_id,
        HarnessKind::Cursor,
    )
    .await;
    let next = store
        .submit_task(
            "operator:alice",
            &SubmitTaskRequest {
                tag_id: "cursor-tag".into(),
                session_id: "cursor-root".into(),
                operation_id: "cursor-next".into(),
                prompt: "Relay".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let next_attempt = run_kind(&store, &cursor_host, &next.task_id, HarnessKind::Cursor).await;
    let queued = store
        .continue_work_session(
            &AttemptAccess::new(&cursor_host, &next_attempt),
            &ContinueWorkSessionRequest {
                operation_id: "cursor-relay".into(),
                work_session_id: cursor_work.work_session_id,
                message: "A changed contract".into(),
            },
        )
        .await
        .unwrap();
    assert!(!queued.steering_offered);
    assert_eq!(
        store
            .get_work_session("operator:alice", &queued.work_session_id)
            .await
            .unwrap()
            .running_task_id
            .as_deref(),
        Some(cursor_child.task_id.as_str())
    );
    assert_eq!(
        store
            .get_task(&queued.latest_task_id)
            .await
            .unwrap()
            .state(),
        TaskState::Queued
    );
    assert!(
        store
            .take_input(&AttemptAccess::new(&cursor_host, &cursor_child))
            .await
            .unwrap()
            .is_none()
    );
    let operator_cursor = store
        .queue_input(
            "operator:alice",
            &QueueInputRequest {
                task_id: cursor_child.task_id.clone(),
                operation_id: "operator-cursor".into(),
                text: "Operator change".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(operator_cursor.state(), LiveInputState::Rejected);
    assert_eq!(
        store
            .get_task(&operator_cursor.follower_task_id)
            .await
            .unwrap()
            .state(),
        TaskState::Queued
    );
}

#[tokio::test]
async fn sqlite_work_session_steering() {
    let dir = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("steering.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires dedicated PostgreSQL"]
async fn postgres_work_session_steering() {
    use sqlx::{Connection, Executor};
    let file = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("URL file");
    let admin_url = std::fs::read_to_string(file).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let db = format!("supertag_steering_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {db}").as_str())
        .await
        .unwrap();
    url.set_path(&db);
    let result = tokio::task::LocalSet::new()
        .run_until(async move { tokio::task::spawn_local(contract(url.to_string())).await })
        .await;
    admin
        .execute(format!("DROP DATABASE {db} WITH (FORCE)").as_str())
        .await
        .unwrap();
    result.unwrap();
}
