mod support;

use sqlx::{Connection, Executor};
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:tag-execution";
const TAG: &str = "reviewer";
const NOW: i64 = 1_900_000_000_000;

async fn open(url: &str) -> Store {
    Store::open(url).await.unwrap().with_execution_clock(|| NOW)
}

fn settings(harness: Option<&str>, models: &[&str], efforts: &[&str]) -> PolicyExecutionSettings {
    PolicyExecutionSettings {
        harness: harness.map(str::to_owned),
        models: models.iter().map(|model| (*model).into()).collect(),
        efforts: efforts.iter().map(|effort| (*effort).into()).collect(),
    }
}

fn tag(
    tag_id: &str,
    harness: HarnessKind,
    execution: Option<PolicyExecutionSettings>,
) -> PutTagRequest {
    PutTagRequest {
        tag_id: tag_id.into(),
        instructions: "Review the changes".into(),
        harness_kind: harness as i32,
        execution,
        ..Default::default()
    }
}

async fn role(store: &Store, id: &str, name: &str, execution: PolicyExecutionSettings) {
    store
        .put_role(
            OPERATOR,
            &PutRoleRequest {
                operation_id: format!("create-{id}"),
                role: Some(Role {
                    role_id: id.into(),
                    name: name.into(),
                    purpose: "Exercise execution precedence".into(),
                    execution: Some(execution),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

async fn assign(store: &Store, tag_id: &str, role: &str) {
    store
        .assign_role(
            OPERATOR,
            &AssignRoleRequest {
                operation_id: format!("{tag_id}-{role}"),
                tag_id: tag_id.into(),
                role: role.into(),
            },
        )
        .await
        .unwrap();
}

fn turn(tag: &str, operation: &str) -> SubmitTaskRequest {
    SubmitTaskRequest {
        tag_id: tag.into(),
        session_id: "review".into(),
        operation_id: operation.into(),
        prompt: "Review this change".into(),
        ..Default::default()
    }
}

fn assert_execution(task: &Task, harness: HarnessKind, range: PolicyExecutionSettings) {
    assert_eq!(task.harness_kind(), harness);
    assert_eq!(
        task.policy_snapshot.as_ref().unwrap().execution.as_ref(),
        Some(&range)
    );
    assert_eq!(
        task.execution_selection,
        Some(ExecutionSelection {
            model: range.models.first().cloned(),
            effort: range.efforts.first().cloned(),
        })
    );
}

fn profile(model: &str) -> HarnessExecutionProfile {
    HarnessExecutionProfile {
        model_ids: vec![model.into()],
        default_model: Some(model.into()),
        ..Default::default()
    }
}

async fn contract(url: &str) {
    let store = open(url).await;
    let direct = settings(Some("codex"), &["direct-old", "direct-backup"], &[]);
    let original = store
        .put_tag_spec(tag(TAG, HarnessKind::Unspecified, Some(direct.clone())))
        .await
        .unwrap();
    assert_eq!(original.execution.as_ref(), Some(&direct));

    // Role IDs and assignment order disagree with names. Alpha supplies effort
    // even though its model belongs to another harness, and Beta precedes Zulu.
    for (id, name, execution) in [
        (
            "a-zulu",
            "Zulu",
            settings(Some("codex"), &["role-zulu"], &["low"]),
        ),
        (
            "y-beta",
            "Beta",
            settings(Some("codex"), &["role-beta", "role-backup"], &["medium"]),
        ),
        (
            "z-alpha",
            "Alpha",
            settings(Some("claude-code"), &["foreign-model"], &["high", "medium"]),
        ),
    ] {
        role(&store, id, name, execution).await;
        assign(&store, TAG, id).await;
    }
    let first_request = turn(TAG, "original-turn");
    let first = store.submit_task(OPERATOR, &first_request).await.unwrap();
    assert_execution(
        &first,
        HarnessKind::Codex,
        settings(
            Some("codex"),
            &["direct-old", "direct-backup"],
            &["high", "medium"],
        ),
    );

    let updated_range = settings(Some("codex"), &[], &["medium", "low"]);
    let updated = store
        .put_tag_spec(tag(TAG, HarnessKind::Codex, Some(updated_range.clone())))
        .await
        .unwrap();
    assert_eq!(updated.revision, original.revision + 1);
    assert_eq!(updated.execution.as_ref(), Some(&updated_range));
    assert!(matches!(
        store
            .put_tag_spec(tag(
                TAG,
                HarnessKind::Codex,
                Some(settings(Some("claude-code"), &[], &[]))
            ))
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    store.close().await;

    let store = open(url).await;
    let tags = store.list_tags(&ListTagsRequest::default()).await.unwrap();
    assert_eq!(tags.tags, [updated]);
    assert_eq!(store.get_task(&first.task_id).await.unwrap(), first);
    assert_eq!(
        store.submit_task(OPERATOR, &first_request).await.unwrap(),
        first
    );

    let wrong_host = support::register_host(&store, "role-model-host").await;
    let role_profile = profile("role-beta");
    assert!(
        store
            .claim_task_with_profile(
                &wrong_host,
                "new-model-poll",
                &[],
                HarnessKind::Codex,
                &[],
                Some(&role_profile)
            )
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(store.get_task(&first.task_id).await.unwrap(), first);
    let matching_host = support::register_host(&store, "frozen-model-host").await;
    let original_profile = profile("direct-old");
    let claim = store
        .claim_task_with_profile(
            &matching_host,
            "old-model-poll",
            &[],
            HarnessKind::Codex,
            &[],
            Some(&original_profile),
        )
        .await
        .unwrap()
        .unwrap();
    let claimed = claim.task.as_ref().unwrap();
    assert_eq!(claimed.task_id, first.task_id);
    let attempt = claimed.attempt_execution.as_ref().unwrap();
    assert_eq!(attempt.model_source(), ModelSource::Task);
    assert_eq!(attempt.selection, first.execution_selection);

    let next = store
        .submit_task(OPERATOR, &turn(TAG, "revised-turn"))
        .await
        .unwrap();
    assert_execution(
        &next,
        HarnessKind::Codex,
        settings(
            Some("codex"),
            &["role-beta", "role-backup"],
            &["medium", "low"],
        ),
    );

    let cursor = "cursor-reviewer";
    store
        .put_tag_spec(tag(
            cursor,
            HarnessKind::Unspecified,
            Some(settings(Some("cursor"), &[], &[])),
        ))
        .await
        .unwrap();
    assign(&store, cursor, "z-alpha").await;
    let task = store
        .submit_task(OPERATOR, &turn(cursor, "unmatched-role"))
        .await
        .unwrap();
    assert_execution(
        &task,
        HarnessKind::Cursor,
        settings(Some("cursor"), &[], &["high", "medium"]),
    );

    store
        .put_tag_spec(tag("plain", HarnessKind::Unspecified, None))
        .await
        .unwrap();
    let plain = store
        .submit_task(OPERATOR, &turn("plain", "implicit-default"))
        .await
        .unwrap();
    assert_eq!(
        plain.execution_selection,
        Some(ExecutionSelection {
            model: None,
            effort: Some("low".into())
        })
    );
    store.close().await;
}

#[tokio::test]
async fn sqlite_direct_tag_ranges_override_role_fields_and_freeze_tasks() {
    let directory = tempfile::tempdir().unwrap();
    Box::pin(contract(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("tag-execution.db").display()
    )))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_direct_tag_ranges_override_role_fields_and_freeze_tasks() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_tag_execution_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let outcome = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { Box::pin(contract(url.as_str())).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL direct Tag execution contract failed");
}
