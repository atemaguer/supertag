mod support;

use sqlx::{Connection, Executor};
use supertag_control_plane::Store;
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:shared-placement";

fn tag(id: &str, environment: Option<&str>) -> PutTagRequest {
    PutTagRequest {
        tag_id: id.into(),
        instructions: "Read and write the admitted files.".into(),
        harness_kind: HarnessKind::Cursor as i32,
        allowed_actions: vec!["files:read".into(), "files:write".into()],
        execution: environment.map(|id| PolicyExecutionSettings {
            shared_execution_environment_id: Some(id.into()),
            ..Default::default()
        }),
        ..Default::default()
    }
}

fn profile(environment: &str, tools: &[SharedExecutionTool]) -> HarnessExecutionProfile {
    HarnessExecutionProfile {
        shared_execution: Some(SharedExecutionCapability {
            environment_id: environment.into(),
            tools: tools.iter().map(|tool| *tool as i32).collect(),
            incarnation_id: "00000000-0000-4000-8000-000000000001".into(),
        }),
        ..Default::default()
    }
}

fn submit(tag: &str, session: &str, operation: &str) -> SubmitTaskRequest {
    SubmitTaskRequest {
        tag_id: tag.into(),
        session_id: session.into(),
        operation_id: operation.into(),
        prompt: "Use the fixed root.".into(),
        ..Default::default()
    }
}

async fn contract(url: &str) {
    let store = Store::open(url).await.unwrap();
    store
        .put_tag_spec(tag("shared", Some("root-a")))
        .await
        .unwrap();
    let shared = store
        .submit_task(OPERATOR, &submit("shared", "session", "original"))
        .await
        .unwrap();
    let target = |task: &Task| {
        task.policy_snapshot
            .as_ref()
            .unwrap()
            .execution
            .as_ref()
            .unwrap()
            .shared_execution_environment_id
            .clone()
    };
    assert_eq!(target(&shared).as_deref(), Some("root-a"));
    let host = support::register_host(&store, "shared-host").await;
    let file_tools = [SharedExecutionTool::Read, SharedExecutionTool::Write];
    let wrong = profile("root-b", &file_tools);
    let read_only = profile("root-a", &[SharedExecutionTool::Read]);
    for (operation, execution_profile) in [
        ("local", None),
        ("wrong", Some(&wrong)),
        ("read-only", Some(&read_only)),
    ] {
        assert!(
            store
                .claim_task_with_profile(
                    &host,
                    operation,
                    &[],
                    HarnessKind::Cursor,
                    &[],
                    execution_profile
                )
                .await
                .unwrap()
                .is_none()
        );
    }
    let exact = profile("root-a", &file_tools);
    assert!(
        store
            .claim_task_with_profile(
                &host,
                "wrong-harness",
                &[],
                HarnessKind::ClaudeCode,
                &[],
                Some(&exact)
            )
            .await
            .unwrap()
            .is_none()
    );
    let still_queued = store.get_task(&shared.task_id).await.unwrap();
    assert_eq!(still_queued.state(), TaskState::Queued);
    assert!(still_queued.attempt_id.is_none());

    store
        .put_tag_spec(tag("shared", Some("root-b")))
        .await
        .unwrap();
    assert!(
        store
            .submit_task(OPERATOR, &submit("shared", "session", "conflict"))
            .await
            .is_err()
    );
    let next = store
        .submit_task(OPERATOR, &submit("shared", "new-session", "new-target"))
        .await
        .unwrap();
    assert_eq!(target(&next).as_deref(), Some("root-b"));
    let first = store
        .claim_task_with_profile(&host, "exact", &[], HarnessKind::Cursor, &[], Some(&exact))
        .await
        .unwrap()
        .unwrap();
    let claimed = first.task.as_ref().unwrap();
    assert_eq!(claimed.task_id, shared.task_id);
    assert_eq!(target(claimed).as_deref(), Some("root-a"));
    let execution = claimed.attempt_execution.as_ref().unwrap();
    assert_eq!(execution.shared_execution, exact.shared_execution);
    assert!(!execution.remote_file_workspace);
    let mut replacement = exact.clone();
    replacement
        .shared_execution
        .as_mut()
        .unwrap()
        .incarnation_id = Uuid::new_v4().to_string();
    assert!(
        store
            .claim_task_with_profile(
                &host,
                "exact",
                &[],
                HarnessKind::Cursor,
                &[],
                Some(&replacement)
            )
            .await
            .is_err()
    );
    assert_eq!(
        store
            .claim_task_with_profile(&host, "exact", &[], HarnessKind::Cursor, &[], Some(&exact))
            .await
            .unwrap(),
        Some(first)
    );

    let mut mixed = tag("commands", Some("root-a"));
    mixed.allowed_actions.push("commands:execute".into());
    store.put_tag_spec(mixed).await.unwrap();
    assert!(
        store
            .submit_task(OPERATOR, &submit("commands", "session", "no-commands"))
            .await
            .is_err()
    );
    let mut pinned = tag("git", Some("root-a"));
    pinned.workspace = Some(WorkspaceSpec {
        workspace_id: "repo".into(),
        base_commit: "a".repeat(40),
        ..Default::default()
    });
    assert!(store.put_tag_spec(pinned).await.is_err());

    store.put_tag_spec(tag("ordinary", None)).await.unwrap();
    let ordinary = store
        .submit_task(OPERATOR, &submit("ordinary", "session", "local-turn"))
        .await
        .unwrap();
    let second_host = support::register_host(&store, "another-host").await;
    assert!(
        store
            .claim_task_with_profile(
                &second_host,
                "no-local-fallback",
                &[],
                HarnessKind::Cursor,
                &[],
                Some(&exact)
            )
            .await
            .unwrap()
            .is_none()
    );
    let claimed = store
        .claim_task_with_profile(
            &second_host,
            "local-only",
            &[],
            HarnessKind::Cursor,
            &[],
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claimed.task.unwrap().task_id, ordinary.task_id);
    store.close().await;
}

#[tokio::test]
async fn sqlite_selects_only_the_frozen_shared_execution_environment() {
    let directory = tempfile::tempdir().unwrap();
    Box::pin(contract(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("shared.db").display()
    )))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_selects_only_the_frozen_shared_execution_environment() {
    let url_path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(url_path).unwrap();
    let name = format!("supertag_shared_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { Box::pin(contract(url.as_str())).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    result.expect("PostgreSQL shared execution placement contract failed");
}
