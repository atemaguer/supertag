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

/// The checkpoint `attempt` may resume. Its holder is always the host that recorded it, the only
/// host here that records checkpoints.
async fn got(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
) -> Option<CheckpointReference> {
    let response = store.get_checkpoint(host, attempt).await.unwrap();
    if response.reference.is_some() {
        assert_eq!(response.holder_host_id, host.id());
    }
    response.reference
}

/// Every checkpoint digest `host` still holds for a Session, across pages of one.
async fn held(store: &Store, host: &HostAuthority) -> Vec<String> {
    let mut digests = Vec::new();
    let mut after = String::new();
    loop {
        let page = store
            .list_held_checkpoints(
                host,
                &ListHeldCheckpointsRequest {
                    after_sha256: after.clone(),
                    limit: 1,
                },
            )
            .await
            .unwrap();
        digests.extend(page.sha256);
        match page.next_after_sha256 {
            Some(next) => after = next,
            None => return digests,
        }
    }
}

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
                output_policy: None,
                execution_limits: None,
                tag_id: tag.into(),
                session_id: session.into(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: "Continue the Session".into(),
                input_artifacts: vec![],
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
        failure_detail: vec![],
        waiting_approval_ids: vec![],
        artifacts: vec![],
        workspace_delivery: None,
        task_id: attempt.task_id.clone(),
        attempt_id: attempt.attempt_id.clone(),
        lease_token: attempt.lease_token.clone(),
        result: "Native result".into(),
        succeeded: true,
        objective_signal: ObjectiveSignal::Progress.into(),
        checkpoint_sha256: checkpoint.map(|value| value.sha256.clone()),
        quiet: false,
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
    assert!(got(&store, &host, &first).await.is_none());
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
        got(&store, &host, &first).await.is_none(),
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
    assert_eq!(got(&store, &host, &failed).await, Some(accepted.clone()));
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
    assert_eq!(got(&store, &host, &cancelled).await, Some(accepted.clone()));
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
        assert!(got(&store, &host, &isolated).await.is_none());
        stage(&store, &host, &isolated, &discarded).await;
        store
            .finish_task(&host, &finish(&isolated, Some(&discarded)))
            .await
            .unwrap();
    }

    let expired = turn(&store, &host, "owner", "shared-session").await;
    assert_eq!(got(&store, &host, &expired).await, Some(accepted.clone()));
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
    assert_eq!(got(&store, &host, &retried).await, Some(accepted.clone()));
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
    assert!(got(&store, &host, &fresh).await.is_none());
    store
        .finish_task(&host, &finish(&fresh, None))
        .await
        .unwrap();
    native_usage_contract(&store, &host, &intruder).await;
    store.close().await;
}

const DAY: i64 = 24 * 60 * 60 * 1000;

async fn count(url: &str, sql: &str) -> i64 {
    use sqlx::Row;
    let mut connection = sqlx::AnyConnection::connect(url).await.unwrap();
    let value: i64 = sqlx::query(sql)
        .fetch_one(&mut connection)
        .await
        .unwrap()
        .try_get(0)
        .unwrap();
    connection.close().await.unwrap();
    value
}

/// One promoted turn of `session`, with `reference` as its checkpoint, and its Attempt.
async fn promoted(
    store: &Store,
    host: &HostAuthority,
    session: &str,
    reference: &CheckpointReference,
) -> InspectAttemptRequest {
    let attempt = turn(store, host, "owner", session).await;
    stage(store, host, &attempt, reference).await;
    store
        .finish_task(host, &finish(&attempt, Some(reference)))
        .await
        .unwrap();
    attempt
}

/// A Session keeps only its newest checkpoint, and drops it when it is too big, idle, or its
/// Objective ended long ago. Files go only when no row names them.
async fn hygiene_contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(BASE));
    let source = clock.clone();
    let store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || source.load(Ordering::SeqCst));
    let host = support::register_host(&store, "hygiene-owner").await;
    store
        .put_tag("owner", "Inspect carefully", vec!["files:read".into()])
        .await
        .unwrap();
    let rows = |session: &str| {
        format!(
            "SELECT COUNT(*) FROM supertag_v2_checkpoints c JOIN supertag_v2_tasks t ON t.task_id=c.task_id WHERE t.session_id='{session}'"
        )
    };

    // Promoting a checkpoint deletes the Session's older rows, so its holder deletes the file.
    let old = reference("first transcript");
    let new = reference("second transcript, longer");
    promoted(&store, &host, "one", &old).await;
    promoted(&store, &host, "one", &new).await;
    assert_eq!(count(url, &rows("one")).await, 1);
    assert!(held(&store, &host).await.contains(&new.sha256));
    assert!(!held(&store, &host).await.contains(&old.sha256));
    // Another host holds none of them.
    let other = support::register_host(&store, "hygiene-other").await;
    assert!(held(&store, &other).await.is_empty());

    // A file two Sessions share stays while either names it.
    let shared = reference("identical transcript bytes");
    promoted(&store, &host, "left", &shared).await;
    promoted(&store, &host, "right", &shared).await;
    promoted(&store, &host, "left", &reference("left moves on")).await;
    assert!(
        held(&store, &host).await.contains(&shared.sha256),
        "the right Session still names the shared file"
    );

    // A running Attempt's reservation survives the sweep; a failed Attempt's commit does not.
    let running = turn(&store, &host, "owner", "running").await;
    let staged = reference("running transcript");
    stage(&store, &host, &running, &staged).await;
    let failed = turn(&store, &host, "owner", "failed").await;
    let abandoned = reference("failed transcript");
    stage(&store, &host, &failed, &abandoned).await;
    let mut failure = finish(&failed, None);
    failure.succeeded = false;
    store.finish_task(&host, &failure).await.unwrap();
    store.sweep_checkpoints().await.unwrap();
    assert_eq!(count(url, &rows("failed")).await, 0);
    let still = held(&store, &host).await;
    assert!(!still.contains(&abandoned.sha256));
    assert!(
        still.contains(&staged.sha256),
        "a running Attempt's reservation is held"
    );
    store
        .finish_task(&host, &finish(&running, Some(&staged)))
        .await
        .unwrap();
    assert_eq!(count(url, &rows("running")).await, 1);

    // A checkpoint over half the cap is not offered: the next turn starts fresh.
    let mut big = reference("big transcript");
    big.byte_length = supertag_protocol::MAX_RESUMED_CHECKPOINT_BYTES as u64 + 1;
    promoted(&store, &host, "big", &big).await;
    let next = turn(&store, &host, "owner", "big").await;
    assert!(got(&store, &host, &next).await.is_none());
    assert_eq!(count(url, &rows("big")).await, 0);
    store
        .finish_task(&host, &finish(&next, None))
        .await
        .unwrap();

    // A Tag keeps its harness, so a Session's checkpoint is always its own harness's.
    assert!(matches!(
        store
            .put_tag_configured(
                "owner",
                "Inspect carefully",
                vec!["files:read".into()],
                None,
                HarnessKind::ClaudeCode,
            )
            .await,
        Err(StoreError::FailedPrecondition(reason)) if reason.contains("keeps its harness")
    ));

    // An idle Session's checkpoint is not offered after 14 days, and the sweep drops it.
    let idle = reference("idle transcript");
    promoted(&store, &host, "idle", &idle).await;
    let swept = reference("swept transcript");
    promoted(&store, &host, "swept", &swept).await;
    let resumed = turn(&store, &host, "owner", "idle").await;
    assert_eq!(
        got(&store, &host, &resumed).await,
        Some(idle.clone()),
        "a fresh checkpoint resumes"
    );
    store.cancel_task(&resumed.task_id).await.unwrap();
    store
        .finish_task(&host, &finish(&resumed, None))
        .await
        .unwrap();
    clock.store(BASE + 15 * DAY, Ordering::SeqCst);
    let late = turn(&store, &host, "owner", "idle").await;
    assert!(got(&store, &host, &late).await.is_none());
    store
        .finish_task(&host, &finish(&late, None))
        .await
        .unwrap();
    store.sweep_checkpoints().await.unwrap();
    assert_eq!(count(url, &rows("swept")).await, 0);
    let still = held(&store, &host).await;
    assert!(!still.contains(&idle.sha256) && !still.contains(&swept.sha256));

    // An Objective's Sessions lose their checkpoints 3 days after it ends, long before an
    // ordinary Session finished at the same time goes idle.
    let objective = store
        .create_objective(
            OPERATOR,
            &CreateObjectiveRequest {
                objective_id: "ended".into(),
                operation_id: "ended-create".into(),
                owner_tag_id: "owner".into(),
                outcome: "Finish and let go of the transcript".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let attempt = claim(&store, &host, &objective.starting_task_id).await;
    let ended = reference("objective transcript");
    stage(&store, &host, &attempt, &ended).await;
    let mut completion = finish(&attempt, Some(&ended));
    completion.objective_signal = ObjectiveSignal::Completed.into();
    store.finish_task(&host, &completion).await.unwrap();
    store.sweep_checkpoints().await.unwrap();
    assert!(
        held(&store, &host).await.contains(&ended.sha256),
        "a just-ended Objective keeps its checkpoint"
    );
    let ordinary = reference("ordinary transcript");
    promoted(&store, &host, "ordinary", &ordinary).await;
    clock.store(BASE + 17 * DAY, Ordering::SeqCst);
    store.sweep_checkpoints().await.unwrap();
    assert!(
        held(&store, &host).await.contains(&ended.sha256),
        "two days after it ended, the Objective keeps its checkpoint"
    );
    clock.store(BASE + 19 * DAY, Ordering::SeqCst);
    store.sweep_checkpoints().await.unwrap();
    let still = held(&store, &host).await;
    assert!(!still.contains(&ended.sha256));
    assert!(
        still.contains(&ordinary.sha256),
        "an ordinary Session four days idle keeps its checkpoint"
    );
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
    let objective = store
        .get_objective("operator:local", "usage")
        .await
        .unwrap();
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
            .get_objective("operator:local", "usage")
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
async fn sqlite_checkpoint_hygiene_contract() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("hygiene.db").display()
    );
    hygiene_contract(&url).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_checkpoint_hygiene_contract() {
    postgres(hygiene_contract_boxed).await;
}

fn hygiene_contract_boxed(url: String) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()>>> {
    Box::pin(async move { hygiene_contract(&url).await })
}

fn checkpoint_contract_boxed(
    url: String,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()>>> {
    Box::pin(async move { checkpoint_contract(&url).await })
}

/// Runs `contract` against a fresh database on the dedicated PostgreSQL test server.
async fn postgres(
    contract: fn(String) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()>>>,
) {
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
            tokio::task::spawn_local(async move { contract(url.to_string()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL checkpoint contract failed");
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_checkpoint_and_native_usage_contract() {
    postgres(checkpoint_contract_boxed).await;
}
