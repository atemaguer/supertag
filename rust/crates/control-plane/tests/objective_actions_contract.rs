use sqlx::{Connection, Executor};
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OP: &str = "operator:alice";
const NOW: i64 = 1_893_456_000_000;

fn actions(values: &[&str]) -> RuntimeActions {
    RuntimeActions {
        actions: values.iter().map(|value| (*value).into()).collect(),
    }
}
fn create(id: &str, selected: Option<RuntimeActions>) -> CreateObjectiveRequest {
    CreateObjectiveRequest {
        operation_id: format!("create-{id}"),
        objective_id: id.into(),
        owner_tag_id: "owner".into(),
        outcome: "Inspect fixture work".into(),
        ongoing: true,
        runtime_actions: selected,
        ..Default::default()
    }
}
async fn turn(store: &Store, objective: &Objective, operation: &str) -> Task {
    store
        .submit_task(
            OP,
            &SubmitTaskRequest {
                execution_limits: None,
                tag_id: objective.owner_tag_id.clone(),
                session_id: objective.session_id.clone(),
                operation_id: operation.into(),
                prompt: "Next fixture instruction".into(),
            },
        )
        .await
        .unwrap()
}
fn granted(objective: &Objective) -> &[String] {
    &objective
        .runtime_actions
        .as_ref()
        .expect("resolved Objective action selection")
        .actions
}

async fn contract(url: String) {
    previous_schema(&url).await;
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(|| NOW);
    let legacy = store.get_objective("legacy").await.unwrap();
    assert_eq!(
        granted(&legacy),
        ["files:read"],
        "migration must use accepted starting-Task authority, not the broader current Tag"
    );
    assert_eq!(
        turn(&store, &legacy, "legacy-after-upgrade")
            .await
            .allowed_actions,
        ["files:read"]
    );
    store
        .put_tag("owner", "Fixture identity", vec!["files:read".into()])
        .await
        .unwrap();
    let permissions = store
        .put_permission_set(
            OP,
            &PutPermissionSetRequest {
                operation_id: "initial-permissions".into(),
                permission_set: Some(PermissionSet {
                    set_id: "engineering".into(),
                    name: "Engineering".into(),
                    approvers: vec!["operator:alice".into()],
                    permissions: vec![
                        PolicyPermission {
                            target: PolicyPermissionTarget::Runtime as i32,
                            action: "files:write".into(),
                            ..Default::default()
                        },
                        PolicyPermission {
                            target: PolicyPermissionTarget::Runtime as i32,
                            action: "commands:execute".into(),
                            approval_required: true,
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
    let role = store
        .put_role(
            OP,
            &PutRoleRequest {
                operation_id: "initial-role".into(),
                role: Some(Role {
                    role_id: "engineer".into(),
                    name: "Engineer".into(),
                    purpose: "Inspect".into(),
                    instructions: "Check the evidence".into(),
                    permission_set_ids: vec![permissions.set_id.clone()],
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
                operation_id: "assign-engineer".into(),
                role: role.role_id,
                tag_id: "owner".into(),
            },
        )
        .await
        .unwrap();
    let default_request = create("default", None);
    let (first, replay) = tokio::join!(
        store.create_objective(OP, &default_request),
        store.create_objective(OP, &default_request)
    );
    let default = first.unwrap();
    assert_eq!(default, replay.unwrap());
    assert_eq!(
        granted(&default),
        ["commands:execute", "files:read", "files:write"]
    );
    let original_task = store.get_task(&default.starting_task_id).await.unwrap();
    assert_eq!(
        original_task.allowed_actions,
        ["files:read", "files:write"],
        "a semantic approval-gated grant is not unrestricted native authority"
    );
    let authority = original_task
        .policy_snapshot
        .as_ref()
        .unwrap()
        .runtime_authority
        .as_ref()
        .unwrap();
    assert_eq!(authority.actions, granted(&default));
    assert_eq!(authority.objective_id.as_deref(), Some("default"));
    assert_eq!(authority.objective_revision, Some(default.revision));
    assert!(
        authority
            .approvals
            .iter()
            .any(|requirement| requirement.action == "commands:execute"
                && requirement.approvers == ["operator:alice"])
    );
    let empty = store
        .create_objective(OP, &create("empty", Some(actions(&[]))))
        .await
        .unwrap();
    assert!(granted(&empty).is_empty());
    assert!(
        store
            .get_task(&empty.starting_task_id)
            .await
            .unwrap()
            .allowed_actions
            .is_empty()
    );
    let narrow = store
        .create_objective(
            OP,
            &create(
                "narrow",
                Some(actions(&["files:write", "web:fetch", "files:write"])),
            ),
        )
        .await
        .unwrap();
    assert_eq!(granted(&narrow), ["files:write"]);
    assert_eq!(
        store
            .get_task(&narrow.starting_task_id)
            .await
            .unwrap()
            .allowed_actions,
        ["files:write"]
    );
    let mut changed_create = default_request.clone();
    changed_create.runtime_actions = Some(actions(&[]));
    assert!(
        matches!(
            store.create_objective(OP, &changed_create).await,
            Err(StoreError::Conflict(_))
        ),
        "omitted and explicit empty are different operations"
    );

    let mut expanded = permissions.clone();
    expanded.permissions.push(PolicyPermission {
        target: PolicyPermissionTarget::Runtime as i32,
        action: "web:search".into(),
        ..Default::default()
    });
    let expanded = store
        .put_permission_set(
            OP,
            &PutPermissionSetRequest {
                operation_id: "expand-role-grants".into(),
                permission_set: Some(expanded),
                expected_revision: Some(permissions.revision),
            },
        )
        .await
        .unwrap();
    store
        .put_tag(
            "owner",
            "Expanded direct grants",
            vec!["files:read".into(), "web:fetch".into()],
        )
        .await
        .unwrap();
    assert_eq!(
        granted(&store.get_objective("default").await.unwrap()),
        granted(&default)
    );
    assert_eq!(
        store.create_objective(OP, &default_request).await.unwrap(),
        default
    );
    let frozen = turn(&store, &default, "after-expansion").await;
    assert_eq!(frozen.allowed_actions, ["files:read", "files:write"]);
    assert!(
        turn(&store, &empty, "empty-after-expansion")
            .await
            .allowed_actions
            .is_empty()
    );
    assert_eq!(
        turn(&store, &narrow, "narrow-after-expansion")
            .await
            .allowed_actions,
        ["files:write"]
    );
    let fresh = store
        .create_objective(OP, &create("fresh", None))
        .await
        .unwrap();
    assert_eq!(
        granted(&fresh),
        [
            "commands:execute",
            "files:read",
            "files:write",
            "web:fetch",
            "web:search"
        ]
    );

    let update = SetObjectiveRuntimeActionsRequest {
        objective_id: default.objective_id.clone(),
        operation_id: "replace-actions".into(),
        expected_revision: default.revision,
        runtime_actions: Some(actions(&["web:search", "files:read", "not:granted"])),
    };
    assert!(matches!(
        store
            .set_objective_runtime_actions("tag:owner", &update)
            .await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store
            .set_objective_runtime_actions("host:worker", &update)
            .await,
        Err(StoreError::PermissionDenied)
    ));
    let mut missing = update.clone();
    missing.runtime_actions = None;
    assert!(matches!(
        store.set_objective_runtime_actions(OP, &missing).await,
        Err(StoreError::InvalidArgument(_))
    ));
    let mut no_revision = update.clone();
    no_revision.expected_revision = 0;
    assert!(matches!(
        store.set_objective_runtime_actions(OP, &no_revision).await,
        Err(StoreError::InvalidArgument(_))
    ));
    let (one, two) = tokio::join!(
        store.set_objective_runtime_actions(OP, &update),
        store.set_objective_runtime_actions(OP, &update)
    );
    let updated = one.unwrap();
    assert_eq!(updated, two.unwrap());
    assert_eq!(updated.revision, default.revision + 1);
    assert_eq!(granted(&updated), ["files:read", "web:search"]);
    assert_eq!(
        turn(&store, &updated, "after-update").await.allowed_actions,
        ["files:read", "web:search"]
    );
    assert_eq!(
        store.get_task(&original_task.task_id).await.unwrap(),
        original_task
    );
    assert_eq!(store.get_task(&frozen.task_id).await.unwrap(), frozen);
    let mut stale = update.clone();
    stale.operation_id = "stale-update".into();
    assert!(matches!(
        store.set_objective_runtime_actions(OP, &stale).await,
        Err(StoreError::Conflict(_))
    ));
    let mut conflict = update.clone();
    conflict.runtime_actions = Some(actions(&[]));
    assert!(matches!(
        store.set_objective_runtime_actions(OP, &conflict).await,
        Err(StoreError::Conflict(_))
    ));
    store.close().await;

    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(|| NOW);
    assert_eq!(
        store
            .set_objective_runtime_actions(OP, &update)
            .await
            .unwrap(),
        updated
    );
    let cleared = store
        .set_objective_runtime_actions(
            OP,
            &SetObjectiveRuntimeActionsRequest {
                objective_id: updated.objective_id.clone(),
                operation_id: "clear-actions".into(),
                expected_revision: updated.revision,
                runtime_actions: Some(actions(&[])),
            },
        )
        .await
        .unwrap();
    assert!(granted(&cleared).is_empty());
    assert!(
        turn(&store, &cleared, "after-clear")
            .await
            .allowed_actions
            .is_empty()
    );
    let paused = store
        .pause_objective(
            OP,
            &ObjectiveActionRequest {
                objective_id: cleared.objective_id.clone(),
                operation_id: "pause-before-action-change".into(),
                reason: "Keep execution paused".into(),
            },
        )
        .await
        .unwrap();
    let paused_update = store
        .set_objective_runtime_actions(
            OP,
            &SetObjectiveRuntimeActionsRequest {
                objective_id: paused.objective_id.clone(),
                operation_id: "change-paused-actions".into(),
                expected_revision: paused.revision,
                runtime_actions: Some(actions(&["files:read"])),
            },
        )
        .await
        .unwrap();
    assert_eq!(paused_update.paused_at_ms, paused.paused_at_ms);
    assert_eq!(paused_update.status, paused.status);
    assert!(
        store
            .submit_task(
                OP,
                &SubmitTaskRequest {
                    execution_limits: None,
                    tag_id: "owner".into(),
                    session_id: paused.session_id,
                    operation_id: "paused-after-action-change".into(),
                    prompt: "Still paused".into()
                }
            )
            .await
            .is_err()
    );
    // An existing Objective retains its creation-time selection even when the
    // owner's current grants shrink; only an explicit operator update replaces it.
    let mut reduced = expanded;
    reduced
        .permissions
        .retain(|permission| permission.action != "files:write");
    let revision = reduced.revision;
    store
        .put_permission_set(
            OP,
            &PutPermissionSetRequest {
                operation_id: "remove-write".into(),
                permission_set: Some(reduced),
                expected_revision: Some(revision),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        granted(&store.get_objective("narrow").await.unwrap()),
        ["files:write"]
    );
    assert_eq!(
        turn(&store, &narrow, "after-grant-removal")
            .await
            .allowed_actions,
        ["files:write"]
    );
    let clamped = store
        .set_objective_runtime_actions(
            OP,
            &SetObjectiveRuntimeActionsRequest {
                objective_id: narrow.objective_id.clone(),
                operation_id: "explicit-reselection".into(),
                expected_revision: narrow.revision,
                runtime_actions: Some(actions(&["files:write", "files:read"])),
            },
        )
        .await
        .unwrap();
    assert_eq!(granted(&clamped), ["files:read"]);
    store
        .cancel_objective(
            OP,
            &ObjectiveActionRequest {
                objective_id: clamped.objective_id.clone(),
                operation_id: "close-objective".into(),
                reason: "Finished fixture".into(),
            },
        )
        .await
        .unwrap();
    let closed = store.get_objective(&clamped.objective_id).await.unwrap();
    assert!(matches!(
        store
            .set_objective_runtime_actions(
                OP,
                &SetObjectiveRuntimeActionsRequest {
                    objective_id: closed.objective_id,
                    operation_id: "closed-update".into(),
                    expected_revision: closed.revision,
                    runtime_actions: Some(actions(&[]))
                }
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    store.close().await;
}

async fn previous_schema(url: &str) {
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
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .get(..4)
                .and_then(|prefix| prefix.parse::<u32>().ok())
                .is_some_and(|version| version <= 28)
        })
        .collect();
    paths.sort();
    assert_eq!(paths.len(), 28);
    let mut tx = pool.begin().await.unwrap();
    for path in paths {
        sqlx::raw_sql(&std::fs::read_to_string(path).unwrap())
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    sqlx::raw_sql(
        "INSERT INTO supertag_v2_tags (tag_id,instructions,allowed_actions,revision)
         VALUES ('legacy-owner','Broader current identity','[\"files:read\",\"files:write\"]',2);
         INSERT INTO supertag_v2_tasks (task_id,tag_id,session_id,prompt,instructions,allowed_actions,tag_revision,state,accepted_order)
         VALUES ('legacy-start','legacy-owner','legacy-session','Original task','Original identity','[\"files:read\"]',1,3,1);
         INSERT INTO supertag_v2_objectives (objective_id,owner_tag_id,session_id,outcome,ongoing,status,revision,starting_task_id,limit_state,created_at_ms,updated_at_ms)
         VALUES ('legacy','legacy-owner','legacy-session','Keep accepted authority',1,1,1,'legacy-start','{}',1893456000000,1893456000000);
         INSERT INTO supertag_v2_objective_sessions (tag_id,session_id,objective_id)
         VALUES ('legacy-owner','legacy-session','legacy');
         INSERT INTO supertag_v2_objective_tasks (task_id,objective_id,kind)
         VALUES ('legacy-start','legacy','work');
         UPDATE supertag_v2_write_order SET revision=1 WHERE singleton=1;"
    ).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    pool.close().await;
}

#[tokio::test]
async fn sqlite_objective_runtime_actions() {
    let directory = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("actions.db").display()
    ))
    .await;
}
#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_objective_runtime_actions() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("dedicated PostgreSQL URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!(
        "supertag_rust_objective_actions_{}",
        Uuid::new_v4().simple()
    );
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
    outcome.expect("PostgreSQL Objective runtime action contract failed");
}
