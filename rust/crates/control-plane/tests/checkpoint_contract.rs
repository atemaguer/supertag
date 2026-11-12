//! The durable Session pointer changes only with an eligible successful Finish.
//! Native usage is measured evidence with its own per-Attempt sequence.
mod support;

use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const BASE: i64 = 1_893_456_000_000;
const OPERATOR: &str = "operator:checkpoint-test";

async fn claim(store: &Store, host: &HostAuthority, expected: &str) -> InspectAttemptRequest {
    let assigned = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(assigned.task.as_ref().unwrap().task_id, expected);
    let attempt = InspectAttemptRequest {
        task_id: expected.into(),
        attempt_id: assigned.attempt_id,
        lease_token: assigned.lease_token,
    };
    assert!(
        matches!(
            store.get_checkpoint(host, &attempt).await,
            Err(StoreError::FailedPrecondition(_))
        ),
        "reservation alone cannot read a Session checkpoint"
    );
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

async fn turn(
    store: &Store,
    host: &HostAuthority,
    tag: &str,
    session: &str,
) -> InspectAttemptRequest {
    let task = store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                execution_limits: None,
                tag_id: tag.into(),
                session_id: session.into(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: "Continue the Session".into(),
            },
        )
        .await
        .unwrap();
    claim(store, host, &task.task_id).await
}

fn reference(label: &str) -> CheckpointReference {
    CheckpointReference {
        harness: "codex".into(),
        format: "codex-session-v1".into(),
        byte_length: label.len() as u64,
        sha256: format!("{:x}", Sha256::digest(label.as_bytes())),
    }
}

fn commit(
    attempt: &InspectAttemptRequest,
    reference: &CheckpointReference,
) -> CommitCheckpointRequest {
    CommitCheckpointRequest {
        attempt: Some(attempt.clone()),
        reference: Some(reference.clone()),
    }
}

fn finish(
    attempt: &InspectAttemptRequest,
    checkpoint: Option<&CheckpointReference>,
) -> FinishTaskRequest {
    FinishTaskRequest {
        waiting_approval_ids: vec![],
        workspace_delivery: None,
        task_id: attempt.task_id.clone(),
        attempt_id: attempt.attempt_id.clone(),
        lease_token: attempt.lease_token.clone(),
        result: "Native result".into(),
        succeeded: true,
        objective_signal: ObjectiveSignal::Progress.into(),
        checkpoint_sha256: checkpoint.map(|value| value.sha256.clone()),
    }
}

async fn stage(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    reference: &CheckpointReference,
) {
    let request = commit(attempt, reference);
    assert_eq!(
        store.reserve_checkpoint(host, &request).await.unwrap(),
        *reference
    );
    assert_eq!(
        store.commit_checkpoint(host, &request).await.unwrap(),
        *reference
    );
}

async fn checkpoint_contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(BASE));
    let source = clock.clone();
    let store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || source.load(Ordering::SeqCst));
    let host = support::register_host(&store, "checkpoint-owner").await;
    let intruder = support::register_host(&store, "checkpoint-intruder").await;
    for tag in ["owner", "other"] {
        store
            .put_tag(tag, "Inspect carefully", vec!["files:read".into()])
            .await
            .unwrap();
    }
    let accepted = reference("accepted initial transcript");
    let discarded = reference("failed or cancelled transcript");
    let first = turn(&store, &host, "owner", "shared-session").await;
    assert!(store.get_checkpoint(&host, &first).await.unwrap().is_none());
    assert!(matches!(
        store.get_checkpoint(&intruder, &first).await,
        Err(StoreError::PermissionDenied)
    ));
    let request = commit(&first, &accepted);
    assert!(
        matches!(
            store.commit_checkpoint(&host, &request).await,
            Err(StoreError::FailedPrecondition(_))
        ),
        "unreserved content is not eligible"
    );
    store.reserve_checkpoint(&host, &request).await.unwrap();
    store.reserve_checkpoint(&host, &request).await.unwrap();
    assert!(
        matches!(
            store
                .finish_task(&host, &finish(&first, Some(&accepted)))
                .await,
            Err(StoreError::FailedPrecondition(_))
        ),
        "reserved content is not durable content"
    );
    assert_eq!(
        store.get_task(&first.task_id).await.unwrap().state(),
        TaskState::Running
    );
    assert!(matches!(
        store
            .reserve_checkpoint(&host, &commit(&first, &discarded))
            .await,
        Err(StoreError::Conflict(_))
    ));
    store.commit_checkpoint(&host, &request).await.unwrap();
    store.commit_checkpoint(&host, &request).await.unwrap();
    assert!(
        store.get_checkpoint(&host, &first).await.unwrap().is_none(),
        "commit alone does not promote the pointer"
    );
    assert!(matches!(
        store
            .finish_task(&host, &finish(&first, Some(&discarded)))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let completion = finish(&first, Some(&accepted));
    let completed = store.finish_task(&host, &completion).await.unwrap();
    assert_eq!(completed.state(), TaskState::Succeeded);
    assert_eq!(
        store.finish_task(&host, &completion).await.unwrap(),
        completed
    );
    store.commit_checkpoint(&host, &request).await.unwrap(); // Durable operation replay after terminal outcome.
    assert!(matches!(
        store.finish_task(&host, &finish(&first, None)).await,
        Err(StoreError::Conflict(_))
    ));
    assert!(matches!(
        store.get_checkpoint(&host, &first).await,
        Err(StoreError::FailedPrecondition(_))
    ));

    let failed = turn(&store, &host, "owner", "shared-session").await;
    assert_eq!(
        store.get_checkpoint(&host, &failed).await.unwrap(),
        Some(accepted.clone())
    );
    stage(&store, &host, &failed, &discarded).await;
    let mut failure = finish(&failed, Some(&discarded));
    failure.succeeded = false;
    assert!(matches!(
        store.finish_task(&host, &failure).await,
        Err(StoreError::InvalidArgument(_))
    ));
    failure.checkpoint_sha256 = None;
    assert_eq!(
        store.finish_task(&host, &failure).await.unwrap().state(),
        TaskState::Failed
    );

    let cancelled = turn(&store, &host, "owner", "shared-session").await;
    assert_eq!(
        store.get_checkpoint(&host, &cancelled).await.unwrap(),
        Some(accepted.clone())
    );
    stage(&store, &host, &cancelled, &discarded).await;
    store.cancel_task(&cancelled.task_id).await.unwrap();
    assert_eq!(
        store
            .finish_task(&host, &finish(&cancelled, Some(&discarded)))
            .await
            .unwrap()
            .state(),
        TaskState::Cancelled
    );

    // A matching Session string under another Tag cannot expose the first Tag's
    // native history; another Session under the same Tag is also independent.
    for (tag, session) in [("other", "shared-session"), ("owner", "other-session")] {
        let isolated = turn(&store, &host, tag, session).await;
        assert!(
            store
                .get_checkpoint(&host, &isolated)
                .await
                .unwrap()
                .is_none()
        );
        stage(&store, &host, &isolated, &discarded).await;
        store
            .finish_task(&host, &finish(&isolated, Some(&discarded)))
            .await
            .unwrap();
    }

    let expired = turn(&store, &host, "owner", "shared-session").await;
    assert_eq!(
        store.get_checkpoint(&host, &expired).await.unwrap(),
        Some(accepted.clone())
    );
    stage(&store, &host, &expired, &discarded).await;
    clock.store(BASE + 30_001, Ordering::SeqCst);
    assert!(matches!(
        store.get_checkpoint(&host, &expired).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert_eq!(
        store
            .finish_task(&host, &finish(&expired, Some(&discarded)))
            .await
            .unwrap()
            .state(),
        TaskState::Uncertain
    );
    store
        .resolve_attempt(
            OPERATOR,
            &ResolveAttemptRequest {
                task_id: expired.task_id.clone(),
                attempt_id: expired.attempt_id.clone(),
                operation_id: "audited-retry".into(),
                decision: AttemptDecision::Retry.into(),
                evidence: "Fixture execution was stopped and reaped".into(),
                confirmed_stopped: true,
            },
        )
        .await
        .unwrap();
    let retried = claim(&store, &host, &expired.task_id).await;
    assert_ne!(retried.attempt_id, expired.attempt_id);
    assert_eq!(
        store.get_checkpoint(&host, &retried).await.unwrap(),
        Some(accepted.clone())
    );
    assert!(matches!(
        store
            .commit_checkpoint(&host, &commit(&expired, &discarded))
            .await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store
            .finish_task(&host, &finish(&expired, Some(&discarded)))
            .await,
        Err(StoreError::PermissionDenied)
    ));
    // Explicit successful completion without state clears it, preventing a future
    // turn from silently resuming history older than this successful turn.
    store
        .finish_task(&host, &finish(&retried, None))
        .await
        .unwrap();
    let fresh = turn(&store, &host, "owner", "shared-session").await;
    assert!(store.get_checkpoint(&host, &fresh).await.unwrap().is_none());
    store
        .finish_task(&host, &finish(&fresh, None))
        .await
        .unwrap();
    native_usage_contract(&store, &host, &intruder).await;
    store.close().await;
}

fn native(attempt: &InspectAttemptRequest, sequence: u64, input: u64) -> ReportAttemptUsageRequest {
    ReportAttemptUsageRequest {
        attempt: Some(attempt.clone()),
        sequence,
        native_usage: Some(NativeTokenUsage {
            total_tokens: None,
            input_tokens: input,
            cached_input_tokens: 2,
            output_tokens: 3,
            observed_model: None,
        }),
        ..Default::default()
    }
}

async fn native_usage_contract(store: &Store, host: &HostAuthority, intruder: &HostAuthority) {
    let objective = store
        .create_objective(
            OPERATOR,
            &CreateObjectiveRequest {
                objective_id: "usage".into(),
                operation_id: "usage-create".into(),
                owner_tag_id: "owner".into(),
                outcome: "Verify measured usage independently of costs".into(),
                ongoing: false,
                budget_limit_minor: Some(1000),
                budget_currency: Some("USD".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let attempt = claim(store, host, &objective.starting_task_id).await;
    let first = native(&attempt, 1, 10);
    store.report_attempt_usage(host, &first).await.unwrap();
    store.report_attempt_usage(host, &first).await.unwrap();
    assert!(matches!(
        store
            .report_attempt_usage(host, &native(&attempt, 1, 11))
            .await,
        Err(StoreError::Conflict(_))
    ));
    assert!(matches!(
        store.report_attempt_usage(intruder, &first).await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store
            .report_attempt_usage(host, &native(&attempt, 3, 20))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert!(matches!(
        store
            .report_attempt_usage(host, &native(&attempt, 2, 9))
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    let mut impossible = native(&attempt, 2, 1);
    assert!(matches!(
        store.report_attempt_usage(host, &impossible).await,
        Err(StoreError::InvalidArgument(_))
    ));
    impossible.native_usage.as_mut().unwrap().input_tokens = u64::MAX;
    assert!(matches!(
        store.report_attempt_usage(host, &impossible).await,
        Err(StoreError::InvalidArgument(_))
    ));
    // Cost sequence one is separate from native sequence one. Measured tokens
    // alone never invent monetary spend or an observed provider model.
    let objective = store.get_objective("usage").await.unwrap();
    assert_eq!(objective.reported_spend_minor, Some(0));
    let cost = ReportAttemptUsageRequest {
        attempt: Some(attempt.clone()),
        sequence: 1,
        amount_minor: Some(50),
        currency: Some("USD".into()),
        estimated: false,
        native_usage: None,
    };
    store.report_attempt_usage(host, &cost).await.unwrap();
    let mut second = native(&attempt, 2, 20);
    second.amount_minor = Some(50);
    second.currency = Some("USD".into());
    second.native_usage.as_mut().unwrap().observed_model = Some("gpt-observed".into());
    store.report_attempt_usage(host, &second).await.unwrap();
    assert_eq!(
        store
            .get_objective("usage")
            .await
            .unwrap()
            .reported_spend_minor,
        Some(50)
    );
    let list = ListNativeUsageRequest {
        task_id: attempt.task_id.clone(),
        attempt_id: attempt.attempt_id.clone(),
        after_sequence: 0,
        limit: 1,
    };
    let first_page = store.list_native_usage(&list).await.unwrap().reports;
    assert_eq!(first_page.len(), 1);
    assert_eq!(first_page[0].sequence, 1);
    assert_eq!(first_page[0].native_usage, first.native_usage);
    let second_page = store
        .list_native_usage(&ListNativeUsageRequest {
            after_sequence: 1,
            limit: 100,
            ..list.clone()
        })
        .await
        .unwrap()
        .reports;
    assert_eq!(second_page.len(), 1);
    assert_eq!(second_page[0].sequence, 2);
    assert_eq!(second_page[0].native_usage, second.native_usage);
    assert!(
        store
            .list_native_usage(&ListNativeUsageRequest {
                task_id: "different-task".into(),
                ..list.clone()
            })
            .await
            .unwrap()
            .reports
            .is_empty()
    );
    let mut completion = finish(&attempt, None);
    completion.objective_signal = ObjectiveSignal::Completed.into();
    store.finish_task(host, &completion).await.unwrap();
    store.report_attempt_usage(host, &first).await.unwrap();
    store.report_attempt_usage(host, &second).await.unwrap();
    assert!(matches!(
        store
            .report_attempt_usage(host, &native(&attempt, 3, 30))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    // Usage survives terminal settlement and can also be recorded for an ordinary
    // Task without inventing an Objective or a cost report.
    let ordinary = turn(store, host, "owner", "ordinary-usage").await;
    store
        .report_attempt_usage(host, &native(&ordinary, 1, 5))
        .await
        .unwrap();
    store
        .finish_task(host, &finish(&ordinary, None))
        .await
        .unwrap();
    assert_eq!(
        store
            .list_native_usage(&ListNativeUsageRequest { limit: 100, ..list })
            .await
            .unwrap()
            .reports
            .len(),
        2
    );
}

#[tokio::test]
async fn sqlite_checkpoint_and_native_usage_contract() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("checkpoint.db").display()
    );
    checkpoint_contract(&url).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_checkpoint_and_native_usage_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_rust_checkpoint_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let local = tokio::task::LocalSet::new();
    let outcome = local
        .run_until(async move {
            tokio::task::spawn_local(async move {
                checkpoint_contract(url.as_str()).await;
            })
            .await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL checkpoint contract failed");
}
