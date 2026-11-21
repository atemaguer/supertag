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
                            artifact_snapshot: None,
                            item_key: "skill".into(),
                            r#type: "supertag/skill".into(),
                            version: 1,
                            required: true,
                            config_json: r#"{"reference":"review","version":"v1"}"#.into(),
                            ..Default::default()
                        },
                        PolicyContextItem {
                            artifact_snapshot: None,
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
                output_policy: None,
                execution_limits: None,
                operation_id: "required".into(),
                tag_id: "required".into(),
                session_id: "one".into(),
                prompt: "Review".into(),
                input_artifacts: vec![],
            },
        )
        .await
        .unwrap();
    let plain = store
        .submit_task(
            "operator:alice",
            &SubmitTaskRequest {
                output_policy: None,
                execution_limits: None,
                operation_id: "plain".into(),
                tag_id: "plain".into(),
                session_id: "two".into(),
                prompt: "Read".into(),
                input_artifacts: vec![],
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
            source: "catalog".into(),
        }],
        omissions: vec![OmittedContextItem {
            set_id: context.set_id.clone(),
            item_id: optional.item_id.clone(),
            item_key: optional.item_key.clone(),
            r#type: optional.r#type.clone(),
            version: optional.version,
            reason: "No supported Context Resolver is configured".into(),
        }],
        skipped: vec![],
    };
    let request = CommitContextResolutionRequest {
        manifest: Some(manifest.clone()),
    };
    assert!(matches!(
        store
            .commit_context_resolution(
                &supertag_control_plane::AttemptAccess::new(&host, &attempt),
                &request
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    start(&store, &host, &attempt).await;
    assert_eq!(
        store
            .get_context_pins(&supertag_control_plane::AttemptAccess::new(&host, &attempt))
            .await
            .unwrap(),
        ContextResolutionManifest::default()
    );
    assert!(matches!(
        store
            .commit_context_resolution(
                &supertag_control_plane::AttemptAccess::new(&other, &attempt),
                &request
            )
            .await,
        Err(StoreError::PermissionDenied)
    ));
    let mut bad = request.clone();
    bad.manifest.as_mut().unwrap().pins[0].reference = "unadmitted".into();
    assert!(matches!(
        store
            .commit_context_resolution(
                &supertag_control_plane::AttemptAccess::new(&host, &attempt),
                &bad
            )
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    bad = request.clone();
    bad.manifest.as_mut().unwrap().pins.clear();
    assert!(matches!(
        store
            .commit_context_resolution(
                &supertag_control_plane::AttemptAccess::new(&host, &attempt),
                &bad
            )
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    let access = supertag_control_plane::AttemptAccess::new(&host, &attempt);
    let (first, replay) = tokio::join!(
        store.commit_context_resolution(&access, &request),
        store.commit_context_resolution(&access, &request)
    );
    assert_eq!(first.unwrap(), manifest);
    assert_eq!(replay.unwrap(), manifest);
    // Durable omissions cannot silently become newly delivered context on retry.
    bad = request.clone();
    bad.manifest.as_mut().unwrap().omissions[0].reason =
        "Harness does not support Skill inputs".into();
    assert!(matches!(
        store
            .commit_context_resolution(
                &supertag_control_plane::AttemptAccess::new(&host, &attempt),
                &bad
            )
            .await,
        Err(StoreError::Conflict(_))
    ));
    clock.store(NOW + 60_000, Ordering::SeqCst);
    store.sweep_expired_attempts().await.unwrap();
    assert_eq!(
        store
            .commit_context_resolution(
                &supertag_control_plane::AttemptAccess::new(&host, &attempt),
                &request
            )
            .await
            .unwrap(),
        manifest
    );
    assert!(matches!(
        store
            .get_context_pins(&supertag_control_plane::AttemptAccess::new(&host, &attempt))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    store
        .resolve_attempt(
            "operator:alice",
            &ResolveAttemptRequest {
                task_id: task.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
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
        store
            .get_context_pins(&supertag_control_plane::AttemptAccess::new(&other, &retry))
            .await
            .unwrap(),
        manifest
    );
    let retry_request = CommitContextResolutionRequest {
        manifest: Some(manifest.clone()),
    };
    let mut changed = retry_request.clone();
    changed.manifest.as_mut().unwrap().pins[0].digest = format!("sha256:{}", "b".repeat(64));
    assert!(matches!(
        store
            .commit_context_resolution(
                &supertag_control_plane::AttemptAccess::new(&other, &retry),
                &changed
            )
            .await,
        Err(StoreError::Conflict(_))
    ));
    assert_eq!(
        store
            .commit_context_resolution(
                &supertag_control_plane::AttemptAccess::new(&other, &retry),
                &retry_request
            )
            .await
            .unwrap(),
        manifest
    );
    store.cancel_task(&retry.task_id).await.unwrap();
    assert_eq!(
        store
            .commit_context_resolution(
                &supertag_control_plane::AttemptAccess::new(&other, &retry),
                &retry_request
            )
            .await
            .unwrap(),
        manifest
    );
    store.close().await;
}
fn skill_item(key: &str, required: bool, config: &str) -> PolicyContextItem {
    PolicyContextItem {
        item_key: key.into(),
        r#type: "supertag/skill".into(),
        version: 1,
        required,
        config_json: config.into(),
        ..Default::default()
    }
}
async fn put_set(
    store: &Store,
    id: &str,
    items: Vec<PolicyContextItem>,
) -> Result<ContextSet, StoreError> {
    store
        .put_context_set(
            "operator:alice",
            &PutContextSetRequest {
                operation_id: id.into(),
                context_set: Some(ContextSet {
                    set_id: id.into(),
                    name: id.into(),
                    items,
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
}
#[tokio::test]
async fn sqlite_wildcard_skill_items_resolve_to_any_number_of_pins() {
    let dir = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("wildcard.db").display()
    );
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(|| NOW);
    let host = support::register_host(&store, "reader").await;
    // `*` can be neither required nor pinned.
    for (required, config) in [
        (true, r#"{"reference":"*"}"#),
        (false, r#"{"reference":"*","version":"1"}"#),
        (false, r#"{"reference":"*","digest":"sha256:x"}"#),
    ] {
        let error = put_set(&store, "invalid", vec![skill_item("all", required, config)])
            .await
            .unwrap_err();
        assert!(matches!(error, StoreError::InvalidArgument(_)), "{error:?}");
    }
    let set = put_set(
        &store,
        "skills",
        vec![
            skill_item("all", false, r#"{"reference":"*"}"#),
            skill_item("review", true, r#"{"reference":"review","version":"v1"}"#),
        ],
    )
    .await
    .unwrap();
    store
        .put_tag("reader", "Review", vec!["files:read".into()])
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
                    purpose: "Read Skills".into(),
                    context_set_ids: vec![set.set_id.clone()],
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
                tag_id: "reader".into(),
            },
        )
        .await
        .unwrap();
    store
        .submit_task(
            "operator:alice",
            &SubmitTaskRequest {
                output_policy: None,
                execution_limits: None,
                operation_id: "task".into(),
                tag_id: "reader".into(),
                session_id: "one".into(),
                prompt: "Review".into(),
                input_artifacts: vec![],
            },
        )
        .await
        .unwrap();
    let attempt = claim(&store, &host, "claim").await;
    start(&store, &host, &attempt).await;
    let item = |key: &str| set.items.iter().find(|i| i.item_key == key).unwrap();
    let pin = |key: &str, reference: &str, version: &str| ContextPin {
        set_id: set.set_id.clone(),
        item_id: item(key).item_id.clone(),
        item_key: key.into(),
        reference: reference.into(),
        version: version.into(),
        digest: format!("sha256:{}", "a".repeat(64)),
        source: "user:~/.claude/skills".into(),
    };
    let manifest = ContextResolutionManifest {
        pins: vec![
            pin("all", "lint", ""),
            pin("all", "review", "v1"),
            pin("review", "review", "v1"),
        ],
        omissions: vec![],
        skipped: vec![SkippedSkill {
            reference: "lint".into(),
            source: "user:~/.agents/skills".into(),
            reason: "the Skill of this name from user:~/.claude/skills takes precedence".into(),
        }],
    };
    let access = supertag_control_plane::AttemptAccess::new(&host, &attempt);
    let commit = |manifest: ContextResolutionManifest| {
        let access = &access;
        let store = &store;
        async move {
            store
                .commit_context_resolution(
                    access,
                    &CommitContextResolutionRequest {
                        manifest: Some(manifest),
                    },
                )
                .await
        }
    };
    // A named item resolves to exactly one pin; a reference cannot repeat within an item; a `*`
    // item cannot pin `*` itself; only a `*` item may be omitted for having nothing to load.
    let mut bad = manifest.clone();
    bad.pins.push(pin("review", "lint", ""));
    assert!(matches!(
        commit(bad).await,
        Err(StoreError::InvalidArgument(_))
    ));
    let mut bad = manifest.clone();
    bad.pins.push(pin("all", "lint", ""));
    assert!(matches!(
        commit(bad).await,
        Err(StoreError::InvalidArgument(_))
    ));
    let mut bad = manifest.clone();
    bad.pins[0].reference = "*".into();
    assert!(matches!(
        commit(bad).await,
        Err(StoreError::InvalidArgument(_))
    ));
    let mut bad = manifest.clone();
    bad.pins[1].digest = format!("sha256:{}", "b".repeat(64));
    assert!(matches!(
        commit(bad).await,
        Err(StoreError::InvalidArgument(_))
    ));
    let omitted = |key: &str| OmittedContextItem {
        set_id: set.set_id.clone(),
        item_id: item(key).item_id.clone(),
        item_key: key.into(),
        r#type: "supertag/skill".into(),
        version: 1,
        reason: "No Skills are available to this Task".into(),
    };
    let mut bad = manifest.clone();
    bad.omissions.push(omitted("all"));
    assert!(matches!(
        commit(bad).await,
        Err(StoreError::InvalidArgument(_))
    ));
    assert_eq!(commit(manifest.clone()).await.unwrap(), manifest);
    store.close().await;
    // A `*` item with nothing to load records its omission.
    let dir = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("empty.db").display()
    );
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(|| NOW);
    let host = support::register_host(&store, "reader").await;
    let set = put_set(
        &store,
        "skills",
        vec![skill_item("all", false, r#"{"reference":"*"}"#)],
    )
    .await
    .unwrap();
    store
        .put_tag("reader", "Review", vec!["files:read".into()])
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
                    purpose: "Read Skills".into(),
                    context_set_ids: vec![set.set_id.clone()],
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
                tag_id: "reader".into(),
            },
        )
        .await
        .unwrap();
    store
        .submit_task(
            "operator:alice",
            &SubmitTaskRequest {
                output_policy: None,
                execution_limits: None,
                operation_id: "task".into(),
                tag_id: "reader".into(),
                session_id: "one".into(),
                prompt: "Review".into(),
                input_artifacts: vec![],
            },
        )
        .await
        .unwrap();
    let attempt = claim(&store, &host, "claim").await;
    start(&store, &host, &attempt).await;
    let manifest = ContextResolutionManifest {
        omissions: vec![OmittedContextItem {
            set_id: set.set_id.clone(),
            item_id: set.items[0].item_id.clone(),
            item_key: "all".into(),
            r#type: "supertag/skill".into(),
            version: 1,
            reason: "No Skills are available to this Task".into(),
        }],
        ..Default::default()
    };
    assert_eq!(
        store
            .commit_context_resolution(
                &supertag_control_plane::AttemptAccess::new(&host, &attempt),
                &CommitContextResolutionRequest {
                    manifest: Some(manifest.clone()),
                },
            )
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
