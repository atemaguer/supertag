mod support;
use sqlx::{Connection, Executor};
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;
const NOW: i64 = 1_893_456_000_000;
fn contracts() -> Vec<ContextContract> {
    vec![ContextContract {
        r#type: "supertag/skill".into(),
        version: 1,
    }]
}
async fn claim(store: &Store, host: &HostAuthority, operation: &str) -> InspectAttemptRequest {
    let assignment = store
        .claim_task_with_context(host, operation, &[], HarnessKind::Unspecified, &contracts())
        .await
        .unwrap()
        .unwrap();
    InspectAttemptRequest {
        task_id: assignment.task.unwrap().task_id,
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    }
}
async fn start(store: &Store, host: &HostAuthority, attempt: &InspectAttemptRequest) {
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
}
async fn contract(url: String) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let observed = clock.clone();
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(move || observed.load(Ordering::SeqCst));
    let host = support::register_host(&store, "reader").await;
    let other = support::register_host(&store, "other").await;
    for tag in ["required", "plain"] {
        store
            .put_tag(tag, "Review", vec!["files:read".into()])
            .await
            .unwrap();
    }
    let context = store
        .put_context_set(
            "operator:alice",
            &PutContextSetRequest {
                operation_id: "context".into(),
                context_set: Some(ContextSet {
                    set_id: "context".into(),
                    name: "Context".into(),
                    items: vec![
                        PolicyContextItem {
                            item_key: "skill".into(),
                            r#type: "supertag/skill".into(),
                            version: 1,
                            required: true,
                            config_json: r#"{"reference":"review","version":"v1"}"#.into(),
                            ..Default::default()
                        },
                        PolicyContextItem {
                            item_key: "optional".into(),
                            r#type: "example/unknown".into(),
                            version: 2,
                            required: false,
                            config_json: "{}".into(),
                            ..Default::default()
                        },
                    ],
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .put_role(
            "operator:alice",
            &PutRoleRequest {
                operation_id: "role".into(),
                role: Some(Role {
                    role_id: "reader".into(),
                    name: "Reader".into(),
                    purpose: "Read approved context".into(),
                    context_set_ids: vec![context.set_id.clone()],
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .assign_role(
            "operator:alice",
            &AssignRoleRequest {
                operation_id: "assign".into(),
                role: "reader".into(),
                tag_id: "required".into(),
            },
        )
        .await
        .unwrap();
    let task = store
        .submit_task(
            "operator:alice",
            &SubmitTaskRequest {
                operation_id: "required".into(),
                tag_id: "required".into(),
                session_id: "one".into(),
                prompt: "Review".into(),
            },
        )
        .await
        .unwrap();
    let plain = store
        .submit_task(
            "operator:alice",
            &SubmitTaskRequest {
                operation_id: "plain".into(),
                tag_id: "plain".into(),
                session_id: "two".into(),
                prompt: "Read".into(),
            },
        )
        .await
        .unwrap();
    let plain_claim = store
        .claim_task(&other, "no-context-support")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(plain_claim.task.unwrap().task_id, plain.task_id);
    let attempt = claim(&store, &host, "with-context").await;
    assert_eq!(attempt.task_id, task.task_id);
    assert!(matches!(
        store.claim_task(&host, "with-context").await,
        Err(StoreError::Conflict(_))
    ));
    let skill = context
        .items
        .iter()
        .find(|i| i.item_key == "skill")
        .unwrap();
    let optional = context
        .items
        .iter()
        .find(|i| i.item_key == "optional")
        .unwrap();
    let manifest = ContextResolutionManifest {
        pins: vec![ContextPin {
            set_id: context.set_id.clone(),
            item_id: skill.item_id.clone(),
            item_key: skill.item_key.clone(),
            reference: "review".into(),
            version: "v1".into(),
            digest: format!("sha256:{}", "a".repeat(64)),
        }],
        omissions: vec![OmittedContextItem {
            set_id: context.set_id.clone(),
            item_id: optional.item_id.clone(),
            item_key: optional.item_key.clone(),
            r#type: optional.r#type.clone(),
            version: optional.version,
            reason: "No supported Context Resolver is configured".into(),
        }],
    };
    let request = CommitContextResolutionRequest {
        attempt: Some(attempt.clone()),
        manifest: Some(manifest.clone()),
    };
    assert!(matches!(
        store.commit_context_resolution(&host, &request).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    start(&store, &host, &attempt).await;
    assert_eq!(
        store.get_context_pins(&host, &attempt).await.unwrap(),
        ContextResolutionManifest::default()
    );
    assert!(matches!(
        store.commit_context_resolution(&other, &request).await,
        Err(StoreError::PermissionDenied)
    ));
    let mut bad = request.clone();
    bad.manifest.as_mut().unwrap().pins[0].reference = "unadmitted".into();
    assert!(matches!(
        store.commit_context_resolution(&host, &bad).await,
        Err(StoreError::InvalidArgument(_))
    ));
    bad = request.clone();
    bad.manifest.as_mut().unwrap().pins.clear();
    assert!(matches!(
        store.commit_context_resolution(&host, &bad).await,
        Err(StoreError::InvalidArgument(_))
    ));
    let (first, replay) = tokio::join!(
        store.commit_context_resolution(&host, &request),
        store.commit_context_resolution(&host, &request)
    );
    assert_eq!(first.unwrap(), manifest);
    assert_eq!(replay.unwrap(), manifest);
    // Durable omissions cannot silently become newly delivered context on retry.
    bad = request.clone();
    bad.manifest.as_mut().unwrap().omissions[0].reason =
        "Harness does not support Skill inputs".into();
    assert!(matches!(
        store.commit_context_resolution(&host, &bad).await,
        Err(StoreError::Conflict(_))
    ));
    clock.store(NOW + 60_000, Ordering::SeqCst);
    store.sweep_expired_attempts().await.unwrap();
    assert_eq!(
        store
            .commit_context_resolution(&host, &request)
            .await
            .unwrap(),
        manifest
    );
    assert!(matches!(
        store.get_context_pins(&host, &attempt).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    store
        .resolve_attempt(
            "operator:alice",
            &ResolveAttemptRequest {
                task_id: task.task_id.clone(),
                attempt_id: attempt.attempt_id,
                operation_id: "audited-retry".into(),
                decision: AttemptDecision::Retry as i32,
                evidence: "Confirmed no native process survives".into(),
                confirmed_stopped: true,
            },
        )
        .await
        .unwrap();
    store.close().await;
    let observed = clock.clone();
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(move || observed.load(Ordering::SeqCst));
    let retry = claim(&store, &other, "retry-context").await;
    assert_eq!(retry.task_id, task.task_id);
    start(&store, &other, &retry).await;
    assert_eq!(
        store.get_context_pins(&other, &retry).await.unwrap(),
        manifest
    );
    let retry_request = CommitContextResolutionRequest {
        attempt: Some(retry.clone()),
        manifest: Some(manifest.clone()),
    };
    let mut changed = retry_request.clone();
    changed.manifest.as_mut().unwrap().pins[0].digest = format!("sha256:{}", "b".repeat(64));
    assert!(matches!(
        store.commit_context_resolution(&other, &changed).await,
        Err(StoreError::Conflict(_))
    ));
    assert_eq!(
        store
            .commit_context_resolution(&other, &retry_request)
            .await
            .unwrap(),
        manifest
    );
    store.cancel_task(&retry.task_id).await.unwrap();
    assert_eq!(
        store
            .commit_context_resolution(&other, &retry_request)
            .await
            .unwrap(),
        manifest
    );
    store.close().await;
}
#[tokio::test]
async fn sqlite_context_resolution_contract() {
    let dir = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("context.db").display()
    ))
    .await;
}
#[tokio::test]
#[ignore = "requires dedicated PostgreSQL"]
async fn postgres_context_resolution_contract() {
    let file = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("URL file");
    let admin_url = std::fs::read_to_string(file).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let db = format!("supertag_context_{}", Uuid::new_v4().simple());
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
    admin.close().await.unwrap();
    result.unwrap();
}
