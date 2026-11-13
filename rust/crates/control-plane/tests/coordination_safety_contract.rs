//! Overlap warnings and Worker-managed effect receipts through the store contract.
//! TypeScript parity: `packages/control-plane/overlap-warnings.test.ts`,
//! `tests/runtime/tool-adapter.test.ts`, and `sdks/python/tests/test_tools.py`.
mod support;

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:alice";
const BASE: &str = "1111111111111111111111111111111111111111";

async fn tag(store: &Store, id: &str) {
    store
        .put_tag_spec(PutTagRequest {
            tag_id: id.into(),
            instructions: "Coordinate".into(),
            allowed_actions: vec!["files:read".into(), "files:write".into()],
            workspace: Some(WorkspaceSpec {
                workspace_id: "project".into(),
                base_commit: BASE.into(),
                ..Default::default()
            }),
            ..Default::default()
        })
        .await
        .unwrap();
}

async fn objective(store: &Store, id: &str, owner: &str) {
    store
        .create_objective(
            OPERATOR,
            &CreateObjectiveRequest {
                objective_id: id.into(),
                operation_id: format!("create-{id}"),
                owner_tag_id: owner.into(),
                outcome: "Ship the release notes".into(),
                ongoing: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

/// Claims and starts the next queued Task on a fresh Worker Host.
async fn run(store: &Store, host: &str) -> (HostAuthority, InspectAttemptRequest) {
    let authority = support::register_host(store, host).await;
    let assignment = store
        .claim_task_with_workspaces(&authority, host, &["project".into()])
        .await
        .unwrap()
        .unwrap();
    let attempt = InspectAttemptRequest {
        task_id: assignment.task.unwrap().task_id,
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    };
    store
        .start_task(
            &authority,
            &StartTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    (authority, attempt)
}

async fn report(
    store: &Store,
    (host, attempt): &(HostAuthority, InspectAttemptRequest),
    paths: &[&str],
    truncated: bool,
) -> Result<ReportChangedPathsResponse, StoreError> {
    store
        .report_changed_paths(
            host,
            &ReportChangedPathsRequest {
                attempt: Some(attempt.clone()),
                paths: paths.iter().map(|path| (*path).into()).collect(),
                truncated,
            },
        )
        .await
}

async fn notices(pool: &sqlx::AnyPool) -> Vec<String> {
    sqlx::query_scalar("SELECT t.prompt FROM supertag_v2_objective_notices n JOIN supertag_v2_tasks t ON t.task_id=n.task_id WHERE n.objective_id='release' AND n.notice_key LIKE 'overlap:%' ORDER BY t.accepted_order")
        .fetch_all(pool)
        .await
        .unwrap()
}

async fn overlap(url: &str) {
    let store = Store::open(url).await.unwrap();
    sqlx::any::install_default_drivers();
    let pool = sqlx::AnyPool::connect(url).await.unwrap();
    tag(&store, "owner").await;
    tag(&store, "other-owner").await;
    objective(&store, "release", "owner").await;
    let parent = run(&store, "parent").await;
    for index in 1..=3 {
        store
            .start_work_session(
                &parent.0,
                &StartWorkSessionRequest {
                    attempt: Some(parent.1.clone()),
                    operation_id: format!("work-{index}"),
                    title: format!("Change {index}"),
                    instruction: "Edit the notes".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
    }
    let a = run(&store, "child-a").await;
    let b = run(&store, "child-b").await;
    let c = run(&store, "child-c").await;
    objective(&store, "other", "other-owner").await;
    let other = run(&store, "other").await;

    // Different files, a truncated scan, and another Objective never overlap.
    assert_eq!(
        report(&store, &a, &["src/a.ts"], false).await.unwrap(),
        ReportChangedPathsResponse {
            overlapping_attempt_ids: vec![],
            compared: true,
        }
    );
    let quiet = report(&store, &b, &["src/b.ts"], false).await.unwrap();
    assert!(quiet.compared && quiet.overlapping_attempt_ids.is_empty());
    let truncated = report(&store, &c, &["src/a.ts"], true).await.unwrap();
    assert!(truncated.overlapping_attempt_ids.is_empty());
    let elsewhere = report(&store, &other, &["src/a.ts"], false).await.unwrap();
    assert!(elsewhere.overlapping_attempt_ids.is_empty());
    assert!(notices(&pool).await.is_empty());

    // The first shared path is told once, however often it is reported.
    let shared = report(&store, &b, &["src/b.ts", "src/a.ts"], false)
        .await
        .unwrap();
    assert_eq!(
        shared.overlapping_attempt_ids,
        std::slice::from_ref(&a.1.attempt_id)
    );
    report(&store, &b, &["src/a.ts", "src/b.ts"], false)
        .await
        .unwrap();
    report(&store, &a, &["src/a.ts"], false).await.unwrap();
    let told = notices(&pool).await;
    assert_eq!(
        told,
        [format!(
            "Tasks {} and {} of this Objective are both changing src/a.ts in Workspace project. Coordinate them before their changes conflict: continue one work Session with what the other changes, or let one finish first.",
            b.1.task_id, a.1.task_id
        )]
    );
    // A newly shared path of the same pair is told again, without the earlier one.
    report(&store, &a, &["src/a.ts", "src/b.ts"], false)
        .await
        .unwrap();
    let told = notices(&pool).await;
    assert_eq!(told.len(), 2);
    assert!(
        told[1].contains("changing src/b.ts in Workspace project") && !told[1].contains("src/a.ts")
    );

    // More than 20 newly shared paths are counted rather than listed.
    let many: Vec<String> = (0..25).map(|index| format!("docs/{index:02}.md")).collect();
    let many: Vec<&str> = many.iter().map(String::as_str).collect();
    report(&store, &a, &many, false).await.unwrap();
    report(&store, &b, &many, false).await.unwrap();
    let told = notices(&pool).await;
    assert_eq!(told.len(), 3);
    assert!(told[2].contains("docs/19.md and 5 more in Workspace project"));
    assert!(!told[2].contains("docs/20.md"));

    // Invalid reports and stale Attempts are refused.
    for paths in [vec![".git/config"], vec!["/etc/passwd"], vec!["a/../b"]] {
        assert!(matches!(
            report(&store, &a, &paths, false).await,
            Err(StoreError::InvalidArgument(_))
        ));
    }
    let too_many: Vec<String> = (0..501).map(|index| format!("f{index}")).collect();
    let too_many: Vec<&str> = too_many.iter().map(String::as_str).collect();
    assert!(matches!(
        report(&store, &a, &too_many, false).await,
        Err(StoreError::InvalidArgument(_))
    ));
    let mut stale = a.clone();
    stale.1.lease_token = "stale".into();
    assert!(report(&store, &stale, &["src/a.ts"], false).await.is_err());

    // A finished Attempt is no longer compared.
    store
        .finish_task(
            &a.0,
            &FinishTaskRequest {
                task_id: a.1.task_id.clone(),
                attempt_id: a.1.attempt_id.clone(),
                lease_token: a.1.lease_token.clone(),
                result: "Stopped".into(),
                succeeded: false,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let after = report(&store, &b, &["src/a.ts", "src/c.ts"], false)
        .await
        .unwrap();
    assert!(after.overlapping_attempt_ids.is_empty());
    let rows: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM supertag_v2_attempt_changed_paths WHERE attempt_id=$1",
    )
    .bind(&a.1.attempt_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(rows, 0);

    // A running Attempt whose lease renewal is late is still compared: its host does not resend
    // an unchanged scan, so skipping it would lose the warning for good.
    report(&store, &c, &["src/z.ts"], false).await.unwrap();
    sqlx::query("UPDATE supertag_v2_tasks SET lease_expires_at_ms=1 WHERE task_id=$1")
        .bind(&c.1.task_id)
        .execute(&pool)
        .await
        .unwrap();
    let late = report(&store, &b, &["src/a.ts", "src/c.ts", "src/z.ts"], false)
        .await
        .unwrap();
    assert_eq!(
        late.overlapping_attempt_ids,
        std::slice::from_ref(&c.1.attempt_id)
    );
    let told = notices(&pool).await;
    assert_eq!(told.len(), 4);
    assert!(told[3].contains("changing src/z.ts in Workspace project"));

    // An Attempt without an Objective is not compared, so its host stops reporting.
    store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: "owner".into(),
                session_id: "plain".into(),
                operation_id: "plain".into(),
                prompt: "No Objective".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let plain = run(&store, "plain").await;
    assert_eq!(
        report(&store, &plain, &["src/a.ts"], false).await.unwrap(),
        ReportChangedPathsResponse::default()
    );
    pool.close().await;
    store.close().await;
}

fn begin(attempt: &InspectAttemptRequest, key: &str, arguments: &str) -> BeginEffectRequest {
    BeginEffectRequest {
        attempt: Some(attempt.clone()),
        effect: Some(HarnessBeginEffectRequest {
            idempotency_key: key.into(),
            operation: "add_issue_comment".into(),
            arguments_json: arguments.into(),
        }),
    }
}

fn complete(attempt: &InspectAttemptRequest, key: &str, result: &str) -> CompleteEffectRequest {
    CompleteEffectRequest {
        attempt: Some(attempt.clone()),
        effect: Some(HarnessCompleteEffectRequest {
            idempotency_key: key.into(),
            operation: "add_issue_comment".into(),
            arguments_json: r#"{"issue_number":3,"body":"Done"}"#.into(),
            result_json: result.into(),
        }),
    }
}

fn fail(attempt: &InspectAttemptRequest, key: &str, error: &str) -> FailEffectRequest {
    FailEffectRequest {
        attempt: Some(attempt.clone()),
        effect: Some(HarnessFailEffectRequest {
            idempotency_key: key.into(),
            operation: "add_issue_comment".into(),
            arguments_json: r#"{"issue_number":3,"body":"Done"}"#.into(),
            error: error.into(),
        }),
    }
}

const COMMENT: &str = r#"{"issue_number":3,"body":"Done"}"#;

async fn effects(url: &str) {
    let store = Store::open(url).await.unwrap();
    store
        .put_tag("integrator", "File comments", vec![])
        .await
        .unwrap();
    store
        .put_tag("auditor", "Separate effects", vec![])
        .await
        .unwrap();
    let submit = |tag: &str, operation: &str| SubmitTaskRequest {
        tag_id: tag.into(),
        session_id: operation.into(),
        operation_id: operation.into(),
        prompt: "Comment".into(),
        ..Default::default()
    };
    store
        .submit_task(OPERATOR, &submit("integrator", "first"))
        .await
        .unwrap();
    let host = support::register_host(&store, "worker").await;
    let claim = |operation: &'static str| {
        let store = &store;
        let host = &host;
        async move {
            let assignment = store.claim_task(host, operation).await.unwrap().unwrap();
            let attempt = InspectAttemptRequest {
                task_id: assignment.task.unwrap().task_id,
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
    };
    let first = claim("first").await;

    // Begin, provider call, complete; then a replay instead of a second provider call.
    let acquired = store
        .begin_effect(&host, &begin(&first, "task-1/comment/final", COMMENT))
        .await
        .unwrap();
    assert_eq!(acquired.state(), EffectReceiptState::Acquired);
    assert!(!acquired.replayed);
    assert_eq!(acquired.task_id, first.task_id);
    // Completing requires the same effect identity.
    let mut other = complete(&first, "task-1/comment/final", r#"{"commentId":"42"}"#);
    other.effect.as_mut().unwrap().arguments_json = r#"{"issue_number":4}"#.into();
    assert!(matches!(
        store.complete_effect(&host, &other).await,
        Err(StoreError::Conflict(_))
    ));
    let completed = store
        .complete_effect(
            &host,
            &complete(&first, "task-1/comment/final", r#"{"commentId":"42"}"#),
        )
        .await
        .unwrap();
    assert_eq!(completed.state(), EffectReceiptState::Completed);
    // A repeated completion with the same result is idempotent; a different one is refused.
    assert_eq!(
        store
            .complete_effect(
                &host,
                &complete(&first, "task-1/comment/final", r#"{"commentId":"42"}"#),
            )
            .await
            .unwrap(),
        completed
    );
    assert!(matches!(
        store
            .complete_effect(
                &host,
                &complete(&first, "task-1/comment/final", r#"{"commentId":"43"}"#),
            )
            .await,
        Err(StoreError::Conflict(_))
    ));
    let replay = store
        .begin_effect(
            &host,
            &begin(
                &first,
                "task-1/comment/final",
                r#"{"body":"Done","issue_number":3}"#,
            ),
        )
        .await
        .unwrap();
    assert_eq!(replay.state(), EffectReceiptState::Completed);
    assert!(replay.replayed);
    assert_eq!(replay.result_json, r#"{"commentId":"42"}"#);
    // Reusing a key for different arguments fails closed.
    assert!(matches!(
        store
            .begin_effect(
                &host,
                &begin(&first, "task-1/comment/final", r#"{"issue_number":4}"#)
            )
            .await,
        Err(StoreError::Conflict(_))
    ));
    // A begun effect without a durable result is in doubt and never acquired again.
    store
        .begin_effect(&host, &begin(&first, "task-1/comment/ambiguous", COMMENT))
        .await
        .unwrap();
    let doubt = store
        .begin_effect(&host, &begin(&first, "task-1/comment/ambiguous", COMMENT))
        .await
        .unwrap();
    assert_eq!(doubt.state(), EffectReceiptState::InDoubt);
    // A failed provider call may be retried; settling twice differently is refused.
    store
        .begin_effect(&host, &begin(&first, "task-1/comment/failed", COMMENT))
        .await
        .unwrap();
    let failed = store
        .fail_effect(
            &host,
            &fail(&first, "task-1/comment/failed", "rate limited"),
        )
        .await
        .unwrap();
    assert_eq!(failed.state(), EffectReceiptState::Failed);
    assert!(matches!(
        store
            .complete_effect(&host, &complete(&first, "task-1/comment/failed", "{}"))
            .await,
        Err(StoreError::Conflict(_))
    ));
    let retried = store
        .begin_effect(&host, &begin(&first, "task-1/comment/failed", COMMENT))
        .await
        .unwrap();
    assert_eq!(retried.state(), EffectReceiptState::Acquired);
    assert_eq!(retried.error, "");
    // Settling an effect that was never begun, malformed input, and stale authority fail.
    assert!(matches!(
        store
            .complete_effect(&host, &complete(&first, "never-begun", "{}"))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    for (key, arguments) in [
        ("", COMMENT),
        (" padded", COMMENT),
        ("key", "[1]"),
        ("key", "{"),
    ] {
        assert!(matches!(
            store
                .begin_effect(&host, &begin(&first, key, arguments))
                .await,
            Err(StoreError::InvalidArgument(_))
        ));
    }
    assert!(matches!(
        store
            .complete_effect(
                &host,
                &complete(&first, "task-1/comment/failed", "not json")
            )
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    let mut stale = first.clone();
    stale.lease_token = "stale".into();
    assert!(
        store
            .begin_effect(&host, &begin(&stale, "task-1/comment/stale", COMMENT))
            .await
            .is_err()
    );

    // While the Attempt that began an effect still runs, a parallel Task of the same Tag sees it
    // in flight rather than in doubt and cannot settle it, so it cannot fail the receipt and
    // call the provider a second time.
    store
        .submit_task(OPERATOR, &submit("integrator", "parallel"))
        .await
        .unwrap();
    let parallel = claim("parallel").await;
    let busy = store
        .begin_effect(
            &host,
            &begin(&parallel, "task-1/comment/ambiguous", COMMENT),
        )
        .await
        .unwrap();
    assert_eq!(busy.state(), EffectReceiptState::InFlight);
    assert_eq!(busy.attempt_id, first.attempt_id);
    assert!(matches!(
        store
            .fail_effect(
                &host,
                &fail(&parallel, "task-1/comment/ambiguous", "not found")
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert!(matches!(
        store
            .complete_effect(
                &host,
                &complete(&parallel, "task-1/comment/ambiguous", "{}")
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));

    // After the Attempt ends, a later Task of the same Tag sees the same receipts and may
    // settle the in-doubt one after reconciling it with the provider.
    store
        .finish_task(
            &host,
            &FinishTaskRequest {
                task_id: first.task_id.clone(),
                attempt_id: first.attempt_id.clone(),
                lease_token: first.lease_token.clone(),
                result: "Interrupted".into(),
                succeeded: false,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        store
            .begin_effect(&host, &begin(&first, "task-1/comment/late", COMMENT))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    store
        .submit_task(OPERATOR, &submit("integrator", "second"))
        .await
        .unwrap();
    let second = claim("second").await;
    let still = store
        .begin_effect(&host, &begin(&second, "task-1/comment/ambiguous", COMMENT))
        .await
        .unwrap();
    assert_eq!(still.state(), EffectReceiptState::InDoubt);
    assert_eq!(still.attempt_id, first.attempt_id);
    assert_eq!(
        store
            .begin_effect(
                &host,
                &begin(&parallel, "task-1/comment/ambiguous", COMMENT)
            )
            .await
            .unwrap()
            .state(),
        EffectReceiptState::InDoubt
    );
    let reconciled = store
        .complete_effect(
            &host,
            &complete(&second, "task-1/comment/ambiguous", r#"{"commentId":"7"}"#),
        )
        .await
        .unwrap();
    assert_eq!(reconciled.state(), EffectReceiptState::Completed);
    assert!(
        store
            .begin_effect(&host, &begin(&second, "task-1/comment/final", COMMENT))
            .await
            .unwrap()
            .replayed
    );
    // Another Tag's receipts are separate.
    store
        .submit_task(OPERATOR, &submit("auditor", "third"))
        .await
        .unwrap();
    let third = claim("third").await;
    assert_eq!(
        store
            .begin_effect(&host, &begin(&third, "task-1/comment/final", COMMENT))
            .await
            .unwrap()
            .state(),
        EffectReceiptState::Acquired
    );
    store.close().await;
}

async fn contract(url: String) {
    overlap(&url).await;
}

async fn effect_contract(url: String) {
    effects(&url).await;
}

async fn sqlite<F, Fut>(name: &str, test: F)
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let dir = tempfile::tempdir().unwrap();
    test(format!(
        "sqlite://{}?mode=rwc",
        dir.path().join(format!("{name}.db")).display()
    ))
    .await;
}

async fn postgres<F, Fut>(test: F)
where
    F: FnOnce(String) -> Fut + 'static,
    Fut: std::future::Future<Output = ()> + 'static,
{
    let path =
        std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("test database file");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!("supertag_coordination_safety_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    url.set_path(&name);
    let outcome = tokio::task::LocalSet::new()
        .run_until(async move { tokio::task::spawn_local(test(url.to_string())).await })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    outcome.unwrap();
}

#[tokio::test]
async fn sqlite_overlap_warning_contract() {
    sqlite("overlap", contract).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_overlap_warning_contract() {
    postgres(contract).await;
}

#[tokio::test]
async fn sqlite_effect_receipt_contract() {
    sqlite("effects", effect_contract).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_effect_receipt_contract() {
    postgres(effect_contract).await;
}
