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
                        artifact_snapshot: None,
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
                output_policy: None,
                execution_limits: None,
                operation_id: "task-one".into(),
                tag_id: "lead".into(),
                session_id: "one".into(),
                prompt: "Review".into(),
                input_artifacts: vec![],
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
        dry_run: false,
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
                output_policy: None,
                execution_limits: None,
                operation_id: "task-two".into(),
                tag_id: "lead".into(),
                session_id: "two".into(),
                prompt: "Review".into(),
                input_artifacts: vec![],
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
                output_policy: None,
                execution_limits: None,
                operation_id: "task-three".into(),
                tag_id: "lead".into(),
                session_id: "three".into(),
                prompt: "Review".into(),
                input_artifacts: vec![],
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
    // A dry run checks the deletion, deletes nothing, and records no operation.
    let dry_run = DeletePolicyResourceRequest {
        dry_run: true,
        ..delete.clone()
    };
    assert!(
        store
            .delete_permission_set(OP, &dry_run)
            .await
            .unwrap()
            .deleted
    );
    assert_eq!(
        store.get_permission_set(OP, "edit").await.unwrap().revision,
        2
    );
    assert!(matches!(
        store
            .delete_permission_set(
                OP,
                &DeletePolicyResourceRequest {
                    expected_revision: 1,
                    ..dry_run.clone()
                }
            )
            .await,
        Err(StoreError::Conflict(_))
    ));
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
    path_scopes(&store).await;
    store.close().await;
}

fn scoped(
    id: &str,
    action: &str,
    (paths, exclude, extra): (&[&str], &[&str], &[&str]),
) -> PutPermissionSetRequest {
    let strings = |values: &[&str]| values.iter().map(|value| (*value).to_owned()).collect();
    let mut request = permission(id, action);
    let grant = &mut request.permission_set.as_mut().unwrap().permissions[0];
    grant.paths = strings(paths);
    grant.exclude = strings(exclude);
    grant.additional_directories = strings(extra);
    request
}

async fn path_scopes(store: &Store) {
    // Entries are canonical: sorted, deduplicated, `dir/**` written as `dir/`.
    let code = store
        .put_permission_set(
            OP,
            &scoped(
                "scope-code",
                "files:write",
                (
                    &["tests/", "src/**", "src/"],
                    &["src/generated"],
                    &["~/.cache/pip/"],
                ),
            ),
        )
        .await
        .unwrap();
    assert_eq!(code.permissions[0].paths, ["src/", "tests/"]);
    assert_eq!(code.permissions[0].exclude, ["src/generated"]);
    assert_eq!(code.permissions[0].additional_directories, ["~/.cache/pip"]);
    // Two grants of one action with different scopes stay distinct in one set.
    let mut both = scoped("scope-docs", "files:write", (&["docs/"], &[], &[]));
    both.permission_set
        .as_mut()
        .unwrap()
        .permissions
        .push(PolicyPermission {
            target: PolicyPermissionTarget::Runtime as i32,
            action: "files:write".into(),
            paths: vec!["examples/".into()],
            ..Default::default()
        });
    assert_eq!(
        store
            .put_permission_set(OP, &both)
            .await
            .unwrap()
            .permissions
            .len(),
        2
    );
    store
        .put_permission_set(
            OP,
            &scoped(
                "scope-hide",
                "files:read",
                (&[], &["**/.env", "secrets/"], &[]),
            ),
        )
        .await
        .unwrap();
    // A set that grants the whole Workspace but hides one file also narrows the others.
    let mut hide_in_write = scoped("scope-wide", "files:write", (&[], &["Cargo.lock"], &[]));
    hide_in_write
        .permission_set
        .as_mut()
        .unwrap()
        .permissions
        .push(PolicyPermission {
            target: PolicyPermissionTarget::Runtime as i32,
            action: "commands:execute".into(),
            ..Default::default()
        });
    store.put_permission_set(OP, &hide_in_write).await.unwrap();
    let submit = |tag: &str, operation: &str| SubmitTaskRequest {
        output_policy: None,
        execution_limits: None,
        operation_id: operation.into(),
        tag_id: tag.into(),
        session_id: operation.into(),
        prompt: "Change code".into(),
        input_artifacts: vec![],
    };
    let assign = |role: &str, tag: &str| AssignRoleRequest {
        operation_id: format!("assign-{role}-{tag}"),
        role: role.into(),
        tag_id: tag.into(),
    };
    store.put_tag("scoped", "Base", vec![]).await.unwrap();
    store
        .put_role(
            OP,
            &role("scope-builder", &["scope-code", "scope-docs"], &[]),
        )
        .await
        .unwrap();
    store
        .put_role(OP, &role("scope-guard", &["scope-hide"], &[]))
        .await
        .unwrap();
    for name in ["scope-builder", "scope-guard"] {
        store
            .assign_role(OP, &assign(name, "scoped"))
            .await
            .unwrap();
    }
    let task = store
        .submit_task(OP, &submit("scoped", "scoped-one"))
        .await
        .unwrap();
    assert_eq!(task.allowed_actions, ["files:read", "files:write"]);
    let files = task
        .policy_snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.runtime_authority.as_ref())
        .and_then(|authority| authority.files.clone())
        .expect("a composed path scope");
    // The union of the Roles' sets; the hide-only set adds no access of its own.
    assert_eq!(files.write, ["docs/", "examples/", "src/", "tests/"]);
    assert_eq!(files.read_only, ["src/generated"]);
    assert_eq!(files.hidden, ["**/.env", "secrets/"]);
    assert_eq!(files.outside_write, ["~/.cache/pip"]);
    // A grant without paths, here in a third Role, widens writes to the whole Workspace; the
    // exclusions of every set still apply.
    store
        .put_role(OP, &role("scope-widen", &["scope-wide"], &[]))
        .await
        .unwrap();
    store
        .assign_role(OP, &assign("scope-widen", "scoped"))
        .await
        .unwrap();
    let task = store
        .submit_task(OP, &submit("scoped", "scoped-two"))
        .await
        .unwrap();
    let files = task
        .policy_snapshot
        .unwrap()
        .runtime_authority
        .unwrap()
        .files
        .unwrap();
    assert!(files.write.is_empty());
    assert_eq!(files.read_only, ["Cargo.lock", "src/generated"]);
    assert_eq!(files.hidden, ["**/.env", "secrets/"]);
    // A Tag's direct files:write is whole-Workspace too.
    store
        .put_tag("direct", "Base", vec!["files:write".into()])
        .await
        .unwrap();
    store
        .assign_role(OP, &assign("scope-builder", "direct"))
        .await
        .unwrap();
    let task = store
        .submit_task(OP, &submit("direct", "direct-one"))
        .await
        .unwrap();
    let files = task
        .policy_snapshot
        .unwrap()
        .runtime_authority
        .unwrap()
        .files
        .unwrap();
    assert!(files.write.is_empty());
    assert_eq!(files.read_only, ["src/generated"]);
    // Without any path field, a Task keeps no scope at all.
    store
        .put_tag("plain", "Base", vec!["files:write".into()])
        .await
        .unwrap();
    let task = store
        .submit_task(OP, &submit("plain", "plain-one"))
        .await
        .unwrap();
    assert!(task.policy_snapshot.is_none_or(|snapshot| {
        snapshot
            .runtime_authority
            .is_none_or(|authority| authority.files.is_none())
    }));
    // Invalid entries are refused with a reason.
    for (index, (action, fields, needle)) in [
        (
            "commands:execute",
            (&["src/"][..], &[][..], &[][..]),
            "takes no paths",
        ),
        (
            "files:read",
            (&["src/"], &[], &[]),
            "files:read takes no paths",
        ),
        ("files:write", (&["src/*.rs"], &[], &[]), "is a glob"),
        ("files:write", (&["../up"], &[], &[]), ". or .."),
        (
            "files:write",
            (&[".git/hooks"], &[], &[]),
            "stays read-only",
        ),
        ("files:write", (&[".claude/"], &[], &[]), "stays read-only"),
        (
            "files:write",
            (&["~/x"], &[], &[]),
            "only in additionalDirectories",
        ),
        ("files:write", (&[], &[], &["~"]), "whole home"),
        ("files:write", (&[], &[], &["/"]), "whole filesystem"),
        ("files:write", (&[], &[], &["~/.supertag/x"]), "overlaps"),
        ("files:read", (&[], &[], &["~/.codex"]), "overlaps"),
    ]
    .into_iter()
    .enumerate()
    {
        let request = scoped(&format!("bad-scope-{index}"), action, fields);
        match store.put_permission_set(OP, &request).await {
            Err(StoreError::InvalidArgument(reason)) => {
                assert!(reason.contains(needle), "{action} {fields:?}: {reason}")
            }
            other => panic!("{action} {fields:?} was not refused: {other:?}"),
        }
    }
    // A path field on a surface or MCP grant is refused too.
    let mut surface = scoped("bad-surface-scope", "post", (&["src/"], &[], &[]));
    let grant = &mut surface.permission_set.as_mut().unwrap().permissions[0];
    grant.target = PolicyPermissionTarget::Surface as i32;
    grant.surface_account_id = "slack".into();
    grant.scope = "channel".into();
    assert!(matches!(
        store.put_permission_set(OP, &surface).await,
        Err(StoreError::InvalidArgument(_))
    ));
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
    // Tags never decide approval requests, so naming one as an approver is refused.
    set.approvers = vec!["operator:bob".into(), "tag:lead".into()];
    let refused = store.put_permission_set(OP, &named).await;
    assert!(
        matches!(&refused, Err(StoreError::InvalidArgument(reason))
            if reason.contains("Tags never decide approval requests")),
        "{refused:?}"
    );
    named.permission_set.as_mut().unwrap().approvers = vec!["operator:bob".into()];
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
        output_policy: None,
        execution_limits: None,
        operation_id: "composed-one".into(),
        tag_id: "composed".into(),
        session_id: "composed-one".into(),
        prompt: "Coordinate".into(),
        input_artifacts: vec![],
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
    // A Tag keeps its harness, even the none a Role's harness filled in.
    let refused = store
        .put_tag_configured(
            "composed",
            "Base",
            vec!["files:write".into()],
            None,
            HarnessKind::Codex,
        )
        .await;
    assert!(
        matches!(&refused, Err(StoreError::FailedPrecondition(reason))
            if reason.contains("a Tag keeps its harness. Create a new Tag for codex")),
        "{refused:?}"
    );
    // Tag choice overrides Role harness; models belong to their named harness,
    // while the first Role's effort range remains authoritative.
    store
        .put_tag_configured(
            "composed-codex",
            "Base",
            vec!["files:write".into()],
            None,
            HarnessKind::Codex,
        )
        .await
        .unwrap();
    for r in [&alpha, &zulu] {
        store
            .assign_role(
                OP,
                &AssignRoleRequest {
                    operation_id: format!("assign-codex-{}", r.role.as_ref().unwrap().role_id),
                    role: r.role.as_ref().unwrap().role_id.clone(),
                    tag_id: "composed-codex".into(),
                },
            )
            .await
            .unwrap();
    }
    let task = store
        .submit_task(
            OP,
            &SubmitTaskRequest {
                operation_id: "composed-two".into(),
                tag_id: "composed-codex".into(),
                session_id: "composed-two".into(),
                ..request.clone()
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
                    output_policy: None,
                    execution_limits: None,
                    operation_id: "internal-artifact".into(),
                    tag_id: "composed".into(),
                    session_id: "artifact".into(),
                    prompt: "Read history".into(),
                    input_artifacts: vec![],
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
                dry_run: false,
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
