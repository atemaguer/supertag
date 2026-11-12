mod support;

use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OP: &str = "operator:alice";
const NOW: i64 = 1_893_456_000_000;

async fn submit(store: &Store, session: &str) -> Task {
    store
        .submit_task(
            OP,
            &SubmitTaskRequest {
                execution_limits: None,
                tag_id: "lead".into(),
                session_id: session.into(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: "Continue fixture work".into(),
            },
        )
        .await
        .unwrap()
}
async fn run(store: &Store, host: &HostAuthority, expected: &str) -> InspectAttemptRequest {
    let assignment = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .unwrap();
    let task = assignment.task.unwrap();
    assert_eq!(task.task_id, expected);
    let attempt = InspectAttemptRequest {
        task_id: task.task_id,
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
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
async fn finish(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    checkpoint: Option<&CheckpointReference>,
) {
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                succeeded: true,
                result: "Fixture result".into(),
                checkpoint_sha256: checkpoint.map(|value| value.sha256.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}
fn start(attempt: &InspectAttemptRequest, operation: &str) -> StartWorkSessionRequest {
    StartWorkSessionRequest {
        attempt: Some(attempt.clone()),
        operation_id: operation.into(),
        title: "Review fixture".into(),
        instruction: "Read the fixture".into(),
        ..Default::default()
    }
}
fn next(
    attempt: &InspectAttemptRequest,
    session: &str,
    operation: &str,
) -> ContinueWorkSessionRequest {
    ContinueWorkSessionRequest {
        attempt: Some(attempt.clone()),
        operation_id: operation.into(),
        work_session_id: session.into(),
        message: "Use the accepted answer".into(),
    }
}
async fn report(store: &Store, session: &str) -> String {
    store
        .get_work_session(OP, session)
        .await
        .unwrap()
        .report_task_id
        .unwrap()
}

async fn contract(url: String) {
    terminal_and_role_boundaries(&url).await;
    objective_report_continuation(&url).await;
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(|| NOW);
    let host = support::register_host(&store, "owner").await;
    let other = support::register_host(&store, "other").await;
    store
        .put_tag("lead", "Original instructions", vec!["files:read".into()])
        .await
        .unwrap();
    let parent = submit(&store, "parent").await;
    let first = run(&store, &host, &parent.task_id).await;
    let started_request = start(&first, "start");
    let started = store
        .start_work_session(&host, &started_request)
        .await
        .unwrap();
    assert!(matches!(
        store
            .continue_work_session(&host, &next(&first, &started.work_session_id, "premature"))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    finish(&store, &host, &first, None).await;
    let child = run(&store, &other, &started.latest_task_id).await;
    let checkpoint = CheckpointReference {
        harness: "codex".into(),
        format: "codex-session-v1".into(),
        byte_length: 7,
        sha256: format!("{:x}", Sha256::digest(b"fixture")),
    };
    let checkpoint_request = CommitCheckpointRequest {
        attempt: Some(child.clone()),
        reference: Some(checkpoint.clone()),
    };
    store
        .reserve_checkpoint(&other, &checkpoint_request)
        .await
        .unwrap();
    store
        .commit_checkpoint(&other, &checkpoint_request)
        .await
        .unwrap();
    let early = submit(&store, "parent").await;
    finish(&store, &other, &child, Some(&checkpoint)).await;
    let early = run(&store, &host, &early.task_id).await;
    assert!(matches!(
        store
            .continue_work_session(&host, &next(&early, &started.work_session_id, "unreported"))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    finish(&store, &host, &early, None).await;
    let first_report = report(&store, &started.work_session_id).await;
    let first_report = run(&store, &host, &first_report).await;
    assert!(matches!(
        store
            .continue_work_session(
                &host,
                &next(&first_report, &started.work_session_id, "ordinary-report")
            )
            .await,
        Err(StoreError::PermissionDenied)
    ));
    finish(&store, &host, &first_report, None).await;

    let outsider = submit(&store, "different-parent").await;
    let outsider = run(&store, &host, &outsider.task_id).await;
    assert!(matches!(
        store
            .continue_work_session(
                &host,
                &next(&outsider, &started.work_session_id, "wrong-parent")
            )
            .await,
        Err(StoreError::NotFound(_))
    ));
    finish(&store, &host, &outsider, None).await;
    store
        .put_tag(
            "lead",
            "Broader instructions",
            vec!["files:read".into(), "files:write".into()],
        )
        .await
        .unwrap();
    let changed = submit(&store, "parent").await;
    let changed = run(&store, &host, &changed.task_id).await;
    assert!(matches!(
        store
            .continue_work_session(
                &host,
                &next(&changed, &started.work_session_id, "changed-authority")
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    finish(&store, &host, &changed, None).await;
    store
        .put_tag(
            "lead",
            "New instructions without more authority",
            vec!["files:read".into()],
        )
        .await
        .unwrap();
    let later = submit(&store, "parent").await;
    let later_attempt = run(&store, &host, &later.task_id).await;
    let request = next(&later_attempt, &started.work_session_id, "continue");
    assert!(matches!(
        store.continue_work_session(&other, &request).await,
        Err(StoreError::PermissionDenied)
    ));
    let (one, two) = tokio::join!(
        store.continue_work_session(&host, &request),
        store.continue_work_session(&host, &request)
    );
    let continued = one.unwrap();
    assert_eq!(continued, two.unwrap());
    assert_eq!(continued.work_session_id, started.work_session_id);
    assert_eq!(continued.starter_task_id, later.task_id);
    assert_ne!(continued.latest_task_id, started.latest_task_id);
    let accepted = store.get_task(&continued.latest_task_id).await.unwrap();
    assert_eq!(accepted.instructions, later.instructions);
    assert_eq!(accepted.session_id, started.work_session_id);
    assert_eq!(accepted.workspace, later.workspace);
    let mut conflict = request.clone();
    conflict.message = "Different answer".into();
    assert!(matches!(
        store.continue_work_session(&host, &conflict).await,
        Err(StoreError::Conflict(_))
    ));
    assert!(matches!(
        store
            .start_work_session(&host, &start(&later_attempt, "continue"))
            .await,
        Err(StoreError::Conflict(_))
    ));
    assert!(matches!(
        store
            .continue_work_session(
                &host,
                &next(&later_attempt, &started.work_session_id, "second-operation")
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let replay_start = store
        .start_work_session(&host, &started_request)
        .await
        .unwrap();
    assert_eq!(replay_start.latest_task_id, started.latest_task_id);
    store.close().await;

    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(|| NOW);
    assert_eq!(
        store.continue_work_session(&host, &request).await.unwrap(),
        continued
    );
    finish(&store, &host, &later_attempt, None).await;
    let next_child = run(&store, &other, &continued.latest_task_id).await;
    assert_eq!(
        store.get_checkpoint(&other, &next_child).await.unwrap(),
        Some(checkpoint)
    );
    finish(&store, &other, &next_child, None).await;
    let next_report = report(&store, &started.work_session_id).await;
    let report_task = store.get_task(&next_report).await.unwrap();
    assert_eq!(report_task.instructions, later.instructions);
    let next_report = run(&store, &host, &next_report).await;
    finish(&store, &host, &next_report, None).await;
    // A lost Continue response stays tied to its original child even after settlement.
    assert_eq!(
        store.continue_work_session(&host, &request).await.unwrap(),
        continued
    );
    let last = submit(&store, "parent").await;
    let last = run(&store, &host, &last.task_id).await;
    store
        .continue_work_session(
            &host,
            &next(&last, &started.work_session_id, "budget-continue"),
        )
        .await
        .unwrap();
    for i in 0..3 {
        store
            .start_work_session(&host, &start(&last, &format!("budget-start-{i}")))
            .await
            .unwrap();
    }
    assert!(matches!(
        store
            .start_work_session(&host, &start(&last, "fifth-effect"))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert!(matches!(
        store
            .continue_work_session(
                &host,
                &next(&last, &started.work_session_id, "budget-start-0")
            )
            .await,
        Err(StoreError::Conflict(_))
    ));
    store.close().await;
}

async fn objective_report_continuation(url: &str) {
    let store = Store::open(url).await.unwrap().with_execution_clock(|| NOW);
    let host = support::register_host(&store, "objective-host").await;
    let objective = store
        .create_objective(
            OP,
            &CreateObjectiveRequest {
                objective_id: "continue-objective".into(),
                operation_id: "create-continue-objective".into(),
                owner_tag_id: "lead".into(),
                outcome: "Inspect fixture evidence".into(),
                ongoing: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let owner = run(&store, &host, &objective.starting_task_id).await;
    let first = store
        .start_work_session(&host, &start(&owner, "first"))
        .await
        .unwrap();
    let second = store
        .start_work_session(&host, &start(&owner, "second"))
        .await
        .unwrap();
    finish(&store, &host, &owner, None).await;
    for child in [&first.latest_task_id, &second.latest_task_id] {
        let attempt = run(&store, &host, child).await;
        finish(&store, &host, &attempt, None).await;
    }
    let first_report = run(&store, &host, &report(&store, &first.work_session_id).await).await;
    assert!(
        store
            .continue_work_session(
                &host,
                &next(&first_report, &second.work_session_id, "another-report")
            )
            .await
            .is_err()
    );
    let request = next(&first_report, &first.work_session_id, "own-report");
    let continued = store.continue_work_session(&host, &request).await.unwrap();
    assert_eq!(continued.starter_task_id, first_report.task_id);
    assert_eq!(
        continued.objective_id.as_deref(),
        Some(objective.objective_id.as_str())
    );
    // A direct owner Objective report can start additional work under the
    // current pool and capacity. Derived approval-report turns stay scoped.
    assert!(
        store
            .attempt_capabilities(&host, &first_report)
            .await
            .unwrap()
            .may_start_work_session
    );
    finish(&store, &host, &first_report, None).await;
    let second_report = run(
        &store,
        &host,
        &report(&store, &second.work_session_id).await,
    )
    .await;
    finish(&store, &host, &second_report, None).await;
    let child = run(&store, &host, &continued.latest_task_id).await;
    finish(&store, &host, &child, None).await;
    let last_report = run(&store, &host, &report(&store, &first.work_session_id).await).await;
    finish(&store, &host, &last_report, None).await;
    assert_eq!(
        store.continue_work_session(&host, &request).await.unwrap(),
        continued
    );
    store.close().await;
}

async fn terminal_and_role_boundaries(url: &str) {
    let store = Store::open(url).await.unwrap().with_execution_clock(|| NOW);
    let host = support::register_host(&store, "boundary-host").await;
    store
        .put_tag("lead", "Fixture", vec!["files:read".into()])
        .await
        .unwrap();
    let role = store
        .put_role(
            OP,
            &PutRoleRequest {
                operation_id: "boundary-role".into(),
                role: Some(Role {
                    role_id: "reviewer".into(),
                    name: "Reviewer".into(),
                    purpose: "Inspect".into(),
                    instructions: "Read carefully".into(),
                    status: RoleStatus::Active as i32,
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .assign_role(
            OP,
            &AssignRoleRequest {
                operation_id: "assign-reviewer".into(),
                role: role.role_id.clone(),
                tag_id: "lead".into(),
            },
        )
        .await
        .unwrap();
    let parent = submit(&store, "boundary-parent").await;
    let parent = run(&store, &host, &parent.task_id).await;
    let failed = store
        .start_work_session(&host, &start(&parent, "failed-child"))
        .await
        .unwrap();
    let cancelled = store
        .start_work_session(&host, &start(&parent, "cancelled-child"))
        .await
        .unwrap();
    finish(&store, &host, &parent, None).await;
    let child = run(&store, &host, &failed.latest_task_id).await;
    store
        .finish_task(
            &host,
            &FinishTaskRequest {
                task_id: child.task_id,
                attempt_id: child.attempt_id,
                lease_token: child.lease_token,
                succeeded: false,
                result: "Fixture failure".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let child = run(&store, &host, &cancelled.latest_task_id).await;
    store.cancel_task(&child.task_id).await.unwrap();
    finish(&store, &host, &child, None).await;
    for session in [&failed.work_session_id, &cancelled.work_session_id] {
        let report = run(&store, &host, &report(&store, session).await).await;
        finish(&store, &host, &report, None).await;
    }
    let parent = submit(&store, "boundary-parent").await;
    let parent = run(&store, &host, &parent.task_id).await;
    assert!(matches!(
        store
            .continue_work_session(
                &host,
                &next(&parent, &cancelled.work_session_id, "cancelled")
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let accepted = store
        .continue_work_session(
            &host,
            &next(&parent, &failed.work_session_id, "retry-failed"),
        )
        .await
        .unwrap();
    finish(&store, &host, &parent, None).await;
    let child = run(&store, &host, &accepted.latest_task_id).await;
    finish(&store, &host, &child, None).await;
    let report = run(
        &store,
        &host,
        &report(&store, &failed.work_session_id).await,
    )
    .await;
    finish(&store, &host, &report, None).await;
    let mut changed_role = role.clone();
    changed_role.purpose = "A revised responsibility".into();
    store
        .put_role(
            OP,
            &PutRoleRequest {
                operation_id: "update-reviewer".into(),
                role: Some(changed_role),
                expected_revision: Some(role.revision),
            },
        )
        .await
        .unwrap();
    let parent = submit(&store, "boundary-parent").await;
    let parent = run(&store, &host, &parent.task_id).await;
    let request = next(&parent, &failed.work_session_id, "changed-role");
    assert!(
        matches!(
            store.continue_work_session(&host, &request).await,
            Err(StoreError::FailedPrecondition(_))
        ),
        "a Role revision is part of accepted authority even if native action strings are unchanged"
    );
    store.close().await;
    let store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(|| NOW + 40_000);
    assert!(
        matches!(
            store.continue_work_session(&host, &request).await,
            Err(StoreError::FailedPrecondition(_))
        ),
        "a stale Attempt cannot create a continuation"
    );
    // Observe and settle the expired execution so subsequent contracts start cleanly.
    store
        .finish_task(
            &host,
            &FinishTaskRequest {
                task_id: parent.task_id,
                attempt_id: parent.attempt_id,
                lease_token: parent.lease_token,
                succeeded: false,
                result: "Stopped fixture".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store.close().await;
}

#[tokio::test]
async fn sqlite_work_session_continuation() {
    let directory = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("continue.db").display()
    ))
    .await;
}
#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_work_session_continuation() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("dedicated PostgreSQL URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!("supertag_rust_continue_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    url.set_path(&name);
    let outcome = tokio::task::LocalSet::new()
        .run_until(async move { tokio::task::spawn_local(contract(url.to_string())).await })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL Work Session continuation contract failed");
}
