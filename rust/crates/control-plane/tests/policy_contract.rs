use prost::Message;
use sqlx::{Connection, Executor};
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OP: &str = "operator:alice";

fn permission(id: &str, action: &str) -> PutPermissionSetRequest {
    PutPermissionSetRequest {
        operation_id: format!("create-{id}"),
        permission_set: Some(PermissionSet {
            set_id: id.into(),
            name: id.into(),
            permissions: vec![PolicyPermission {
                target: PolicyPermissionTarget::Runtime as i32,
                action: action.into(),
                ..Default::default()
            }],
            ..Default::default()
        }),
        ..Default::default()
    }
}

fn role(id: &str, permissions: &[&str], contexts: &[&str]) -> PutRoleRequest {
    PutRoleRequest {
        operation_id: format!("create-{id}"),
        role: Some(Role {
            role_id: id.into(),
            name: id.into(),
            purpose: "Review a change".into(),
            instructions: "Keep the evidence.".into(),
            permission_set_ids: permissions.iter().map(|s| (*s).into()).collect(),
            context_set_ids: contexts.iter().map(|s| (*s).into()).collect(),
            status: RoleStatus::Active as i32,
            ..Default::default()
        }),
        ..Default::default()
    }
}

async fn contract(url: String) {
    previous_schema(&url).await;
    let store = Store::open(&url).await.unwrap();
    let old = store.get_task("pre-policy-task").await.unwrap();
    assert_eq!(old.instructions, "Accepted before the catalog");
    assert!(old.policy_snapshot.is_none());
    store
        .put_tag("lead", "Base instructions", vec!["files:read".into()])
        .await
        .unwrap();
    let create = permission("edit", "files:write");
    let (a, b) = tokio::join!(
        store.put_permission_set(OP, &create),
        store.put_permission_set(OP, &create)
    );
    let p = a.unwrap();
    assert_eq!(p, b.unwrap());
    assert_eq!(p.revision, 1);
    assert!(!p.permissions[0].permission_id.is_empty());
    let mut conflict = create.clone();
    conflict.permission_set.as_mut().unwrap().name = "changed".into();
    assert!(matches!(
        store.put_permission_set(OP, &conflict).await,
        Err(StoreError::Conflict(_))
    ));
    assert!(matches!(
        store.put_permission_set("host:intruder", &create).await,
        Err(StoreError::PermissionDenied)
    ));
    let context = store
        .put_context_set(
            OP,
            &PutContextSetRequest {
                operation_id: "context".into(),
                context_set: Some(ContextSet {
                    set_id: "knowledge".into(),
                    name: "Knowledge".into(),
                    items: vec![PolicyContextItem {
                        item_key: "style".into(),
                        r#type: "example/style".into(),
                        version: 2,
                        required: false,
                        config_json: r#"{"z":2,"a":{"b":1}}"#.into(),
                        ..Default::default()
                    }],
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(context.items[0].config_json, r#"{"a":{"b":1},"z":2}"#);
    let role_create = role("reviewer", &["edit"], &["knowledge"]);
    let r = store.put_role(OP, &role_create).await.unwrap();
    let assignment = store
        .assign_role(
            OP,
            &AssignRoleRequest {
                operation_id: "assign".into(),
                role: r.name.clone(),
                tag_id: "lead".into(),
            },
        )
        .await
        .unwrap();
    let task = store
        .submit_task(
            OP,
            &SubmitTaskRequest {
                execution_limits: None,
                operation_id: "task-one".into(),
                tag_id: "lead".into(),
                session_id: "one".into(),
                prompt: "Review".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(task.allowed_actions, ["files:read", "files:write"]);
    assert!(
        task.instructions
            .contains("You are acting in the reviewer Role.")
    );
    let frozen = task.policy_snapshot.clone().unwrap();
    assert_eq!(frozen.permission_sets.as_slice(), std::slice::from_ref(&p));
    assert_eq!(
        frozen.context_sets.as_slice(),
        std::slice::from_ref(&context)
    );
    assert_eq!(frozen.roles[0].assignment, Some(assignment.clone()));
    let del = DeletePolicyResourceRequest {
        operation_id: "delete-edit".into(),
        reference: "edit".into(),
        expected_revision: p.revision,
    };
    assert!(matches!(
        store.delete_permission_set(OP, &del).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let mut replacement = create.clone();
    replacement.operation_id = "replace-edit".into();
    replacement.expected_revision = Some(1);
    replacement
        .permission_set
        .as_mut()
        .unwrap()
        .permissions
        .push(PolicyPermission {
            target: PolicyPermissionTarget::Mcp as i32,
            action: "sentry/get_issue".into(),
            resource: "repository:acme/api".into(),
            ..Default::default()
        });
    let replaced = store.put_permission_set(OP, &replacement).await.unwrap();
    assert_eq!(replaced.revision, 2);
    assert_eq!(
        replaced
            .permissions
            .iter()
            .find(|x| x.action == "files:write")
            .unwrap()
            .permission_id,
        p.permissions[0].permission_id
    );
    assert_eq!(store.put_permission_set(OP, &create).await.unwrap(), p);
    let mut stale = replacement.clone();
    stale.operation_id = "stale".into();
    assert!(matches!(
        store.put_permission_set(OP, &stale).await,
        Err(StoreError::Conflict(_))
    ));
    let task2 = store
        .submit_task(
            OP,
            &SubmitTaskRequest {
                execution_limits: None,
                operation_id: "task-two".into(),
                tag_id: "lead".into(),
                session_id: "two".into(),
                prompt: "Review".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        task2.policy_snapshot.unwrap().permission_sets.as_slice(),
        std::slice::from_ref(&replaced)
    );
    assert_eq!(task2.allowed_actions, ["files:read", "files:write"]); // MCP is never promoted to runtime authority.
    let inactive = store
        .deactivate_role_assignment(
            OP,
            &DeactivateRoleAssignmentRequest {
                operation_id: "deactivate".into(),
                assignment_id: assignment.assignment_id.clone(),
                expected_revision: 1,
            },
        )
        .await
        .unwrap();
    assert_eq!(inactive.revision, 2);
    let active = store
        .assign_role(
            OP,
            &AssignRoleRequest {
                operation_id: "reactivate".into(),
                role: "reviewer".into(),
                tag_id: "lead".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(active.assignment_id, assignment.assignment_id);
    assert_eq!(active.revision, 3);
    let mut retired = role_create.clone();
    retired.operation_id = "retire".into();
    retired.expected_revision = Some(1);
    retired.role.as_mut().unwrap().status = RoleStatus::Retired as i32;
    store.put_role(OP, &retired).await.unwrap();
    assert!(matches!(
        store
            .delete_permission_set(
                OP,
                &DeletePolicyResourceRequest {
                    operation_id: "delete-retired-ref".into(),
                    expected_revision: 2,
                    ..del.clone()
                }
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert!(matches!(
        store
            .assign_role(
                OP,
                &AssignRoleRequest {
                    operation_id: "assign-retired".into(),
                    role: "reviewer".into(),
                    tag_id: "lead".into()
                }
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let empty = store
        .submit_task(
            OP,
            &SubmitTaskRequest {
                execution_limits: None,
                operation_id: "task-three".into(),
                tag_id: "lead".into(),
                session_id: "three".into(),
                prompt: "Review".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(empty.allowed_actions, ["files:read"]);
    assert!(empty.policy_snapshot.unwrap().roles.is_empty());
    let mut unref = retired;
    unref.operation_id = "unreference".into();
    unref.expected_revision = Some(2);
    unref.role.as_mut().unwrap().permission_set_ids.clear();
    unref.role.as_mut().unwrap().context_set_ids.clear();
    store.put_role(OP, &unref).await.unwrap();
    let delete = DeletePolicyResourceRequest {
        operation_id: "finally-delete".into(),
        expected_revision: 2,
        ..del
    };
    assert!(
        store
            .delete_permission_set(OP, &delete)
            .await
            .unwrap()
            .deleted
    );
    assert!(
        store
            .delete_permission_set(OP, &delete)
            .await
            .unwrap()
            .deleted
    );
    store.close().await;
    let store = Store::open(&url).await.unwrap();
    assert_eq!(
        store
            .get_task(&task.task_id)
            .await
            .unwrap()
            .policy_snapshot
            .unwrap()
            .encode_to_vec(),
        frozen.encode_to_vec()
    );
    assert_eq!(
        store.put_permission_set(OP, &replacement).await.unwrap(),
        replaced
    );
    assert!(
        store
            .delete_permission_set(OP, &delete)
            .await
            .unwrap()
            .deleted
    );
    assert!(matches!(
        store.get_permission_set(OP, "edit").await,
        Err(StoreError::NotFound(_))
    ));
    validation(&store).await;
    composition(&store).await;
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
        .map(|p| p.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .get(..4)
                .and_then(|v| v.parse::<u32>().ok())
                .is_some_and(|v| v <= 22)
        })
        .collect();
    paths.sort();
    let mut tx = pool.begin().await.unwrap();
    for path in paths {
        sqlx::raw_sql(&std::fs::read_to_string(path).unwrap())
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO supertag_v2_tags (tag_id,instructions,allowed_actions,revision) VALUES ('pre-policy','Current policy','[]',1)").execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO supertag_v2_tasks (task_id,tag_id,session_id,prompt,instructions,allowed_actions,tag_revision,state,accepted_order) VALUES ('pre-policy-task','pre-policy','old-session','Old work','Accepted before the catalog','[]',1,$1,1)").bind(TaskState::Queued as i64).execute(&mut *tx).await.unwrap();
    sqlx::query("UPDATE supertag_v2_write_order SET revision=1")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    pool.close().await;
}

async fn composition(store: &Store) {
    store
        .put_tag("composed", "Base", vec!["files:write".into()])
        .await
        .unwrap();
    // A required grant wins over both direct and other reusable grants.
    let mut gated = permission("gated", "files:write");
    let set = gated.permission_set.as_mut().unwrap();
    set.permissions[0].approval_required = true;
    set.permissions.push(PolicyPermission {
        target: PolicyPermissionTarget::Runtime as i32,
        action: "workstream:post".into(),
        approval_required: true,
        ..Default::default()
    });
    store.put_permission_set(OP, &gated).await.unwrap();
    let mut named = permission("named", "workstream:post");
    let set = named.permission_set.as_mut().unwrap();
    set.permissions[0].approval_required = true;
    set.approvers = vec!["operator:bob".into(), "tag:lead".into()];
    store.put_permission_set(OP, &named).await.unwrap();
    store
        .put_permission_set(OP, &permission("ungated", "files:write"))
        .await
        .unwrap();
    let mut alpha = role("z-alpha", &["named"], &[]);
    let a = alpha.role.as_mut().unwrap();
    a.name = "Alpha".into();
    a.execution = Some(PolicyExecutionSettings {
        harness: Some("claude-code".into()),
        models: vec!["claude-model".into()],
        efforts: vec!["high".into()],
        shared_execution_environment_id: None,
    });
    let mut zulu = role("a-zulu", &["gated", "ungated"], &[]);
    let z = zulu.role.as_mut().unwrap();
    z.name = "Zulu".into();
    z.execution = Some(PolicyExecutionSettings {
        harness: Some("codex".into()),
        models: vec!["codex-model".into()],
        efforts: vec!["low".into()],
        shared_execution_environment_id: None,
    });
    for r in [&alpha, &zulu] {
        store.put_role(OP, r).await.unwrap();
        store
            .assign_role(
                OP,
                &AssignRoleRequest {
                    operation_id: format!("assign-{}", r.role.as_ref().unwrap().role_id),
                    role: r.role.as_ref().unwrap().role_id.clone(),
                    tag_id: "composed".into(),
                },
            )
            .await
            .unwrap();
    }
    let request = SubmitTaskRequest {
        execution_limits: None,
        operation_id: "composed-one".into(),
        tag_id: "composed".into(),
        session_id: "composed-one".into(),
        prompt: "Coordinate".into(),
    };
    let task = store.submit_task(OP, &request).await.unwrap();
    assert_eq!(task.allowed_actions, ["workstream:post"]);
    assert_eq!(
        task.approval_rules,
        [ApprovalRule {
            action: "workstream:post".into(),
            operator_ids: vec!["bob".into()]
        }]
    );
    assert_eq!(task.harness_kind, HarnessKind::ClaudeCode as i32);
    let snapshot = task.policy_snapshot.unwrap();
    assert_eq!(
        snapshot
            .roles
            .iter()
            .map(|r| r.role.as_ref().unwrap().role_id.as_str())
            .collect::<Vec<_>>(),
        ["a-zulu", "z-alpha"]
    );
    let execution = snapshot.execution.unwrap();
    assert_eq!(execution.models, ["claude-model"]);
    assert_eq!(execution.efforts, ["high"]);
    assert!(
        snapshot
            .permission_sets
            .iter()
            .flat_map(|s| &s.permissions)
            .any(|p| p.action == "files:write" && p.approval_required)
    );
    // Tag choice overrides Role harness; models belong to their named harness,
    // while the first Role's effort range remains authoritative.
    store
        .put_tag_configured(
            "composed",
            "Base",
            vec!["files:write".into()],
            None,
            HarnessKind::Codex,
        )
        .await
        .unwrap();
    assert!(matches!(
        store
            .submit_task(
                OP,
                &SubmitTaskRequest {
                    operation_id: "changed-session".into(),
                    ..request.clone()
                }
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let task = store
        .submit_task(
            OP,
            &SubmitTaskRequest {
                operation_id: "composed-two".into(),
                session_id: "composed-two".into(),
                ..request
            },
        )
        .await
        .unwrap();
    assert_eq!(task.harness_kind, HarnessKind::Codex as i32);
    let execution = task.policy_snapshot.unwrap().execution.unwrap();
    assert_eq!(execution.models, ["codex-model"]);
    assert_eq!(execution.efforts, ["high"]);
    let context=store.put_context_set(OP,&PutContextSetRequest{operation_id:"artifact-context".into(),context_set:Some(ContextSet{set_id:"artifact".into(),name:"Artifact".into(),items:vec![PolicyContextItem{item_key:"history".into(),r#type:"supertag/artifacts".into(),version:1,required:false,config_json:r#"{"sourceRouteId":"route","selection":{"match":"shared-resource","maxAgeDays":7,"limit":3}}"#.into(),..Default::default()}],..Default::default()}),..Default::default()}).await.unwrap();
    let mut update = alpha;
    update.operation_id = "add-artifact".into();
    update.expected_revision = Some(1);
    update.role.as_mut().unwrap().context_set_ids = vec![context.set_id];
    store.put_role(OP, &update).await.unwrap();
    assert!(matches!(
        store
            .submit_task(
                OP,
                &SubmitTaskRequest {
                    execution_limits: None,
                    operation_id: "internal-artifact".into(),
                    tag_id: "composed".into(),
                    session_id: "artifact".into(),
                    prompt: "Read history".into()
                }
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    // Delete/recreate cannot alias an older Task's policy identity and revision.
    let old = store
        .put_permission_set(OP, &permission("recreated", "files:read"))
        .await
        .unwrap();
    store
        .delete_permission_set(
            OP,
            &DeletePolicyResourceRequest {
                operation_id: "delete-recreated".into(),
                reference: old.set_id.clone(),
                expected_revision: old.revision,
            },
        )
        .await
        .unwrap();
    let mut create = permission("recreated", "files:write");
    create.operation_id = "recreate".into();
    assert!(
        store
            .put_permission_set(OP, &create)
            .await
            .unwrap()
            .revision
            > old.revision
    );
}

async fn validation(store: &Store) {
    let mut request = permission("invalid", "supertag/tool");
    request.permission_set.as_mut().unwrap().permissions[0].target =
        PolicyPermissionTarget::Mcp as i32;
    assert!(matches!(
        store.put_permission_set(OP, &request).await,
        Err(StoreError::InvalidArgument(_))
    ));
    request.operation_id = "mixed".into();
    request.permission_set.as_mut().unwrap().permissions[0].target =
        PolicyPermissionTarget::Runtime as i32;
    request.permission_set.as_mut().unwrap().permissions[0].resource = "repository:acme/api".into();
    assert!(matches!(
        store.put_permission_set(OP, &request).await,
        Err(StoreError::InvalidArgument(_))
    ));
    assert!(matches!(
        store.put_role(OP, &role("missing", &["absent"], &[])).await,
        Err(StoreError::NotFound(_))
    ));
    for id in ["p1", "p2", "p3"] {
        store
            .put_permission_set(OP, &permission(id, "files:read"))
            .await
            .unwrap();
    }
    let page = store
        .list_permission_sets(
            OP,
            &ListPolicyResourcesRequest {
                limit: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(page.permission_sets.len(), 1);
    assert!(!page.next_cursor.is_empty());
    let next = store
        .list_permission_sets(
            OP,
            &ListPolicyResourcesRequest {
                limit: 1,
                cursor: page.next_cursor.clone(),
            },
        )
        .await
        .unwrap();
    assert_ne!(page.permission_sets, next.permission_sets);
    assert!(matches!(
        store
            .list_context_sets(
                OP,
                &ListPolicyResourcesRequest {
                    limit: 1,
                    cursor: page.next_cursor
                }
            )
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
}

#[tokio::test]
async fn sqlite_policy_contract() {
    let dir = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("policy.db").display()
    ))
    .await;
}
#[tokio::test]
#[ignore = "requires dedicated PostgreSQL"]
async fn postgres_policy_contract() {
    let file = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("URL file");
    let admin_url = std::fs::read_to_string(file).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let db = format!("supertag_policy_{}", Uuid::new_v4().simple());
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
