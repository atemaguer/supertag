//! Combined native receipts and independent cost observations form one cumulative ledger.
mod support;

use sqlx::{Connection, Executor, Row};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

async fn start(store: &Store, host: &HostAuthority) -> InspectAttemptRequest {
    let task = store
        .submit_task(
            "operator:test",
            &SubmitTaskRequest {
                tag_id: "usage".into(),
                session_id: Uuid::new_v4().to_string(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: "Measure actual usage".into(),
                execution_limits: None,
            },
        )
        .await
        .unwrap();
    let claim = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.task.unwrap().task_id, task.task_id);
    let attempt = InspectAttemptRequest {
        task_id: task.task_id,
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
fn native(
    attempt: &InspectAttemptRequest,
    sequence: u64,
    input: u64,
    cost: Option<u64>,
) -> ReportAttemptUsageRequest {
    ReportAttemptUsageRequest {
        attempt: Some(attempt.clone()),
        sequence,
        native_usage: Some(NativeTokenUsage {
            input_tokens: input,
            cached_input_tokens: 2,
            output_tokens: 3,
            total_tokens: Some(input + 7),
            observed_model: Some("observed-model".into()),
        }),
        amount_minor: cost,
        currency: cost.map(|_| "USD".into()),
        estimated: cost.is_some(),
    }
}
async fn contract(url: &str) {
    let store = Store::open(url).await.unwrap();
    store
        .put_tag("usage", "Measure actual usage", vec![])
        .await
        .unwrap();
    let host = support::register_host(&store, "usage-host").await;
    let other = support::register_host(&store, "other-host").await;
    let attempt = start(&store, &host).await;
    let mut invalid_total = native(&attempt, 1, 10, Some(15));
    invalid_total.native_usage.as_mut().unwrap().total_tokens = Some(12);
    assert!(matches!(
        store.report_attempt_usage(&host, &invalid_total).await,
        Err(StoreError::InvalidArgument(_))
    ));
    invalid_total.native_usage.as_mut().unwrap().total_tokens = Some(u64::MAX);
    assert!(matches!(
        store.report_attempt_usage(&host, &invalid_total).await,
        Err(StoreError::InvalidArgument(_))
    ));
    let mut first = native(&attempt, 1, 10, Some(15));
    first.estimated = false;
    // Both writers race on the same durable receipt. Neither duplicates its spend.
    let (one, two) = tokio::join!(
        store.report_attempt_usage(&host, &first),
        store.report_attempt_usage(&host, &first)
    );
    one.unwrap();
    two.unwrap();
    assert!(matches!(
        store.report_attempt_usage(&other, &first).await,
        Err(StoreError::PermissionDenied)
    ));
    let mut conflict = first.clone();
    conflict.amount_minor = Some(16);
    assert!(matches!(
        store.report_attempt_usage(&host, &conflict).await,
        Err(StoreError::Conflict(_))
    ));
    conflict = first.clone();
    conflict.native_usage.as_mut().unwrap().total_tokens = Some(18);
    assert!(matches!(
        store.report_attempt_usage(&host, &conflict).await,
        Err(StoreError::Conflict(_))
    ));
    let mut second = native(&attempt, 2, 20, Some(14));
    assert!(matches!(
        store.report_attempt_usage(&host, &second).await,
        Err(StoreError::InvalidArgument(_))
    ));
    second.amount_minor = Some(20);
    second.currency = Some("EUR".into());
    assert!(matches!(
        store.report_attempt_usage(&host, &second).await,
        Err(StoreError::InvalidArgument(_))
    ));
    // Invalid combined cost cannot consume the native sequence or publish a partial row.
    let list = ListNativeUsageRequest {
        task_id: attempt.task_id.clone(),
        attempt_id: attempt.attempt_id.clone(),
        limit: 100,
        after_sequence: 0,
    };
    assert_eq!(
        store.list_native_usage(&list).await.unwrap().reports.len(),
        1
    );
    let second = native(&attempt, 2, 20, None);
    store.report_attempt_usage(&host, &second).await.unwrap();
    let mut connection = sqlx::AnyConnection::connect(url).await.unwrap();
    let head = sqlx::query("SELECT amount_minor, currency, estimated FROM supertag_v2_attempt_usage WHERE attempt_id=$1").bind(&attempt.attempt_id).fetch_one(&mut connection).await.unwrap();
    assert_eq!(head.get::<Option<i64>, _>("amount_minor"), Some(15));
    assert_eq!(
        head.get::<Option<String>, _>("currency").as_deref(),
        Some("USD")
    );
    assert_eq!(head.get::<i64, _>("estimated"), 0);
    // The independent cost lane starts at one even after two native observations.
    let mut cost = ReportAttemptUsageRequest {
        attempt: Some(attempt.clone()),
        sequence: 1,
        amount_minor: Some(20),
        currency: Some("USD".into()),
        ..Default::default()
    };
    store.report_attempt_usage(&host, &cost).await.unwrap();
    store.report_attempt_usage(&host, &cost).await.unwrap();
    cost.amount_minor = Some(21);
    assert!(matches!(
        store.report_attempt_usage(&host, &cost).await,
        Err(StoreError::Conflict(_))
    ));
    cost.sequence = 3;
    assert!(matches!(
        store.report_attempt_usage(&host, &cost).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    cost.sequence = 2;
    store.report_attempt_usage(&host, &cost).await.unwrap();
    let cost_receipts = sqlx::query("SELECT amount_minor, currency, estimated FROM supertag_v2_attempt_usage_events WHERE attempt_id=$1 ORDER BY sequence").bind(&attempt.attempt_id).fetch_all(&mut connection).await.unwrap();
    assert_eq!(cost_receipts.len(), 2);
    assert_eq!(
        cost_receipts[0].get::<Option<i64>, _>("amount_minor"),
        Some(20)
    );
    assert_eq!(
        cost_receipts[1].get::<Option<i64>, _>("amount_minor"),
        Some(21)
    );
    assert_eq!(
        cost_receipts[0]
            .get::<Option<String>, _>("currency")
            .as_deref(),
        Some("USD")
    );
    assert_eq!(cost_receipts[0].get::<Option<i64>, _>("estimated"), Some(0));
    let reports = store.list_native_usage(&list).await.unwrap().reports;
    assert_eq!(reports[0].native_usage, first.native_usage);
    assert_eq!(reports[0].amount_minor, Some(15));
    assert!(!reports[0].estimated);
    assert_eq!(reports[1].amount_minor, None);
    store
        .finish_task(
            &host,
            &FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                succeeded: true,
                result: "done".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store.report_attempt_usage(&host, &first).await.unwrap();
    store.report_attempt_usage(&host, &cost).await.unwrap();
    assert!(matches!(
        store
            .report_attempt_usage(&host, &native(&attempt, 3, 30, Some(30)))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    // Unknown evidence is not a zero-dollar report, and a measured zero is retained.
    let unknown = start(&store, &host).await;
    store
        .report_attempt_usage(&host, &native(&unknown, 1, 10, None))
        .await
        .unwrap();
    let amount: Option<i64> = sqlx::query_scalar(
        "SELECT amount_minor FROM supertag_v2_attempt_usage WHERE attempt_id=$1",
    )
    .bind(&unknown.attempt_id)
    .fetch_one(&mut connection)
    .await
    .unwrap();
    assert_eq!(amount, None);
    let mut zero = native(&unknown, 2, 11, Some(0));
    zero.estimated = false;
    store.report_attempt_usage(&host, &zero).await.unwrap();
    let amount: Option<i64> = sqlx::query_scalar(
        "SELECT amount_minor FROM supertag_v2_attempt_usage WHERE attempt_id=$1",
    )
    .bind(&unknown.attempt_id)
    .fetch_one(&mut connection)
    .await
    .unwrap();
    assert_eq!(amount, Some(0));
    // Estimates are correctable; only actual provider evidence establishes a floor.
    let mut estimate = native(&unknown, 3, 12, Some(50));
    store.report_attempt_usage(&host, &estimate).await.unwrap();
    estimate = native(&unknown, 4, 13, Some(30));
    store.report_attempt_usage(&host, &estimate).await.unwrap();
    let mut actual = native(&unknown, 5, 14, Some(10));
    actual.estimated = false;
    store.report_attempt_usage(&host, &actual).await.unwrap();
    let mut lower = native(&unknown, 6, 15, Some(9));
    lower.estimated = false;
    assert!(matches!(
        store.report_attempt_usage(&host, &lower).await,
        Err(StoreError::InvalidArgument(_))
    ));
    lower.estimated = true;
    assert!(matches!(
        store.report_attempt_usage(&host, &lower).await,
        Err(StoreError::InvalidArgument(_))
    ));
    let higher_estimate = native(&unknown, 6, 15, Some(12));
    store
        .report_attempt_usage(&host, &higher_estimate)
        .await
        .unwrap();
    let mut correction = native(&unknown, 7, 16, Some(10));
    correction.estimated = false;
    store
        .report_attempt_usage(&host, &correction)
        .await
        .unwrap();
    store
        .register_host("usage-host", "replacement-incarnation")
        .await
        .unwrap();
    assert!(
        matches!(
            store.report_attempt_usage(&host, &first).await,
            Err(StoreError::PermissionDenied)
        ),
        "stale generations cannot replay even durable usage"
    );
    assert!(matches!(
        store.report_attempt_usage(&host, &correction).await,
        Err(StoreError::PermissionDenied)
    ));
    drop(store);
    let reopened = Store::open(url).await.unwrap();
    assert_eq!(
        reopened.list_native_usage(&list).await.unwrap().reports,
        reports
    );
    connection.close().await.unwrap();
}
#[tokio::test]
async fn sqlite_usage_ledger() {
    let directory = tempfile::tempdir().unwrap();
    contract(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("usage.db").display()
    ))
    .await;
}
#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_usage_ledger() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_usage_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { contract(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    result.unwrap();
}
