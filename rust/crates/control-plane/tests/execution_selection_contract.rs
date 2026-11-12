mod support;

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:execution-selection";
const NOW: i64 = 1_900_000_000_000;

async fn open(url: &str) -> Store {
    Store::open(url).await.unwrap().with_execution_clock(|| NOW)
}

fn profile(models: &[&str], default: Option<&str>, commands: bool) -> HarnessExecutionProfile {
    HarnessExecutionProfile {
        model_ids: models.iter().map(|model| (*model).into()).collect(),
        default_model: default.map(str::to_owned),
        allow_unsandboxed_commands: commands,
    }
}

fn role(
    name: &str,
    operation: &str,
    revision: Option<u64>,
    models: [&str; 2],
    efforts: [&str; 2],
) -> PutRoleRequest {
    PutRoleRequest {
        operation_id: format!("{name}-{operation}"),
        expected_revision: revision,
        role: Some(Role {
            role_id: format!("{name}-role"),
            name: format!("{name} model choice"),
            purpose: "Exercise accepted execution settings".into(),
            execution: Some(PolicyExecutionSettings {
                harness: Some(name.into()),
                models: models.map(str::to_owned).into(),
                efforts: efforts.map(str::to_owned).into(),
            }),
            ..Default::default()
        }),
    }
}

async fn submit(store: &Store, tag: &str, turn: &str) -> Task {
    store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: tag.into(),
                session_id: turn.into(),
                operation_id: format!("{tag}-{turn}"),
                prompt: "Review the changes".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
}

async fn claim(
    store: &Store,
    host: &HostAuthority,
    operation: &str,
    harness: HarnessKind,
    profile: Option<&HarnessExecutionProfile>,
) -> Result<Option<Assignment>, StoreError> {
    store
        .claim_task_with_profile(host, operation, &[], harness, &[], profile)
        .await
}

fn assert_selection(selection: &ExecutionSelection, model: Option<&str>, effort: Option<&str>) {
    assert_eq!(selection.model.as_deref(), model);
    assert_eq!(selection.effort.as_deref(), effort);
}

fn assert_attempt(task: &Task, source: ModelSource, model: Option<&str>, effort: Option<&str>) {
    let attempt = task
        .attempt_execution
        .as_ref()
        .expect("resolved Attempt execution missing");
    assert_eq!(attempt.harness_kind(), task.harness_kind());
    assert_eq!(attempt.model_source(), source);
    assert_eq!(
        attempt.effort_applied,
        effort.map(|_| matches!(
            task.harness_kind(),
            HarnessKind::Codex | HarnessKind::ClaudeCode
        ))
    );
    assert_selection(
        attempt
            .selection
            .as_ref()
            .expect("Attempt selection missing"),
        model,
        effort,
    );
}

async fn start(store: &Store, host: &HostAuthority, claim: &Assignment) -> Task {
    store
        .start_task(
            host,
            &StartTaskRequest {
                task_id: claim.task.as_ref().unwrap().task_id.clone(),
                attempt_id: claim.attempt_id.clone(),
                lease_token: claim.lease_token.clone(),
            },
        )
        .await
        .unwrap()
}

async fn finish(store: &Store, host: &HostAuthority, claim: Assignment) {
    let done = store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: claim.task.unwrap().task_id,
                attempt_id: claim.attempt_id,
                lease_token: claim.lease_token,
                succeeded: true,
                result: "Reviewed the changes.".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(done.state(), TaskState::Succeeded);
}

async fn frozen_model_contract(url: &str, name: &str, harness: HarnessKind, models: [&str; 2]) {
    let [accepted, later] = models;
    let store = open(url).await;
    let host_a = support::register_host(&store, "model-host-a").await;
    let host_b = support::register_host(&store, "model-host-b").await;
    store.put_tag(name, "Review", vec![]).await.unwrap();
    let initial = store
        .put_role(
            OPERATOR,
            &role(name, "create", None, models, ["high", "low"]),
        )
        .await
        .unwrap();
    store
        .assign_role(
            OPERATOR,
            &AssignRoleRequest {
                operation_id: format!("{name}-assignment"),
                tag_id: name.into(),
                role: initial.role_id,
            },
        )
        .await
        .unwrap();
    let first = submit(&store, name, "first").await;
    assert_eq!(first.harness_kind(), harness);
    assert_selection(
        first.execution_selection.as_ref().unwrap(),
        Some(accepted),
        Some("high"),
    );
    assert!(first.attempt_execution.is_none());

    store
        .put_role(
            OPERATOR,
            &role(
                name,
                "edit",
                Some(initial.revision),
                [later, accepted],
                ["low", "high"],
            ),
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .get_task(&first.task_id)
            .await
            .unwrap()
            .execution_selection,
        first.execution_selection
    );

    let operation = format!("{name}-claim");
    let wrong = profile(&[later], Some(later), false);
    for offered in [None, Some(&wrong)] {
        assert!(
            claim(&store, &host_a, &operation, harness, offered)
                .await
                .unwrap()
                .is_none()
        );
        let queued = store.get_task(&first.task_id).await.unwrap();
        assert_eq!(queued.state(), TaskState::Queued);
        assert!(queued.attempt_id.is_none() && queued.attempt_execution.is_none());
    }

    // The configured default differs from the Task model. The exact model is still served.
    let serving = profile(&[accepted, later], Some(later), false);
    assert!(
        claim(
            &store,
            &host_a,
            &operation,
            HarnessKind::ClaudeCode,
            Some(&serving)
        )
        .await
        .unwrap()
        .is_none()
    );
    let (a, b) = tokio::join!(
        Box::pin(claim(&store, &host_a, &operation, harness, Some(&serving))),
        Box::pin(claim(&store, &host_b, &operation, harness, Some(&serving)))
    );
    let (winner, reserved) = match (a.unwrap(), b.unwrap()) {
        (Some(reserved), None) => (&host_a, reserved),
        (None, Some(reserved)) => (&host_b, reserved),
        other => panic!("expected a single Attempt reservation, got {other:?}"),
    };
    let assigned = reserved.task.as_ref().unwrap();
    assert_eq!(assigned.task_id, first.task_id);
    assert_attempt(assigned, ModelSource::Task, Some(accepted), Some("high"));
    store.close().await;

    let store = open(url).await;
    let reordered = profile(&[later, accepted], Some(later), false);
    let (a, b) = tokio::join!(
        Box::pin(claim(&store, winner, &operation, harness, Some(&reordered))),
        Box::pin(claim(&store, winner, &operation, harness, Some(&serving)))
    );
    assert_eq!(a.unwrap(), Some(reserved.clone()));
    assert_eq!(b.unwrap(), Some(reserved.clone()));
    let changed = profile(&[accepted, later], Some(accepted), false);
    assert!(matches!(
        claim(&store, winner, &operation, harness, Some(&changed)).await,
        Err(StoreError::Conflict(_))
    ));
    let started = start(&store, winner, &reserved).await;
    assert_attempt(&started, ModelSource::Task, Some(accepted), Some("high"));
    finish(&store, winner, reserved).await;

    let next = submit(&store, name, "next").await;
    assert_selection(
        next.execution_selection.as_ref().unwrap(),
        Some(later),
        Some("low"),
    );
    let assigned = claim(
        &store,
        winner,
        &format!("{name}-next-claim"),
        harness,
        Some(&changed),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(assigned.task.as_ref().unwrap().task_id, next.task_id);
    assert_attempt(
        assigned.task.as_ref().unwrap(),
        ModelSource::Task,
        Some(later),
        Some("low"),
    );
    start(&store, winner, &assigned).await;
    finish(&store, winner, assigned).await;
    store.close().await;
}

async fn put_builtin_tag(store: &Store, tag: &str, harness: HarnessKind, actions: &[&str]) {
    store
        .put_tag_spec(PutTagRequest {
            tag_id: tag.into(),
            instructions: "Review".into(),
            allowed_actions: actions.iter().map(|action| (*action).into()).collect(),
            harness_kind: harness.into(),
            ..Default::default()
        })
        .await
        .unwrap();
}

async fn host_defaults_and_command_opt_in(url: &str) {
    let store = open(url).await;
    let host = support::register_host(&store, "local-command-host").await;
    for (tag, harness, model) in [
        (
            "local-opencode",
            HarnessKind::Opencode,
            "openai/local-fixture",
        ),
        ("local-cursor", HarnessKind::Cursor, "cursor-local-fixture"),
    ] {
        put_builtin_tag(
            &store,
            tag,
            harness,
            &["files:read", "files:write", "commands:execute"],
        )
        .await;
        let task = submit(&store, tag, "command").await;
        assert!(
            task.execution_selection
                .as_ref()
                .and_then(|selection| selection.model.as_ref())
                .is_none()
        );
        let disabled = profile(&[model], Some(model), false);
        let operation = format!("{tag}-claim");
        assert!(
            claim(&store, &host, &operation, harness, Some(&disabled))
                .await
                .unwrap()
                .is_none()
        );
        let queued = store.get_task(&task.task_id).await.unwrap();
        assert_eq!(queued.state(), TaskState::Queued);
        assert!(queued.attempt_id.is_none() && queued.attempt_execution.is_none());

        let enabled = profile(&[model], Some(model), true);
        let assigned = claim(&store, &host, &operation, harness, Some(&enabled))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(assigned.task.as_ref().unwrap().task_id, task.task_id);
        let started = start(&store, &host, &assigned).await;
        assert_attempt(&started, ModelSource::HostDefault, Some(model), Some("low"));
        finish(&store, &host, assigned).await;
    }

    // A Task without a named requirement can still use a native harness default.
    let harness = HarnessKind::ClaudeCode;
    put_builtin_tag(&store, "harness-default", harness, &[]).await;
    let task = submit(&store, "harness-default", "default").await;
    let assigned = claim(&store, &host, "harness-default-claim", harness, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(assigned.task.as_ref().unwrap().task_id, task.task_id);
    assert_attempt(
        assigned.task.as_ref().unwrap(),
        ModelSource::HarnessDefault,
        None,
        Some("low"),
    );
    store.close().await;
}

async fn contract(url: &str) {
    for (name, harness, models) in [
        ("codex", HarnessKind::Codex, ["codex-first", "codex-second"]),
        (
            "opencode",
            HarnessKind::Opencode,
            ["openai/first", "openai/second"],
        ),
    ] {
        Box::pin(frozen_model_contract(url, name, harness, models)).await;
    }
    Box::pin(host_defaults_and_command_opt_in(url)).await;
}

#[tokio::test]
async fn sqlite_claims_match_frozen_models_and_replay_exact_selection() {
    let directory = tempfile::tempdir().unwrap();
    Box::pin(contract(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("models.db").display()
    )))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_claims_match_frozen_models_and_replay_exact_selection() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_execution_selection_{}", Uuid::new_v4().simple());
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
    outcome.expect("PostgreSQL execution selection contract failed");
}
