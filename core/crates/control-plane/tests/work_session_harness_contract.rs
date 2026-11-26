//! A Tag keeps one harness; a Work Session may name another and keeps it.
mod support;

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OP: &str = "operator:alice";
const NOW: i64 = 1_893_456_000_000;

async fn report(store: &Store, host: &HostAuthority, harnesses: &[HarnessKind]) {
    store
        .report_host(
            host,
            &ReportHostRequest {
                sequence: 1,
                capacity: 2 * harnesses.len() as u32,
                available_slots: 2 * harnesses.len() as u32,
                readiness: HostReadiness::Ready as i32,
                reason: HostReadinessReason::Unspecified as i32,
                // A host with one harness reports it in its own fields.
                harness_kind: match harnesses {
                    [single] => *single as i32,
                    _ => HarnessKind::Unspecified as i32,
                },
                harnesses: if harnesses.len() == 1 {
                    vec![]
                } else {
                    harnesses
                        .iter()
                        .map(|harness| HostHarnessCapacity {
                            harness_kind: *harness as i32,
                            capacity: 2,
                            available_slots: 2,
                            ..Default::default()
                        })
                        .collect()
                },
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

async fn claim(
    store: &Store,
    host: &HostAuthority,
    harness: HarnessKind,
) -> Option<InspectAttemptRequest> {
    let assignment = store
        .claim_task_for_host(host, &Uuid::new_v4().to_string(), &[], harness)
        .await
        .unwrap()?;
    let attempt = InspectAttemptRequest {
        task_id: assignment.task.unwrap().task_id,
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
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
    Some(attempt)
}

fn start(operation: &str, harness: &str) -> StartWorkSessionRequest {
    StartWorkSessionRequest {
        operation_id: operation.into(),
        title: "Review on another harness".into(),
        instruction: "Read the fixture".into(),
        harness: Some(harness.into()),
    }
}

async fn put(
    store: &Store,
    tag: &str,
    actions: &[&str],
    harness: HarnessKind,
) -> Result<Tag, StoreError> {
    store
        .put_tag_configured(
            tag,
            "Fixture instructions",
            actions.iter().map(|action| (*action).to_owned()).collect(),
            None,
            harness,
        )
        .await
}

async fn submit(store: &Store, tag: &str, session: &str) -> Task {
    store
        .submit_task(
            OP,
            &SubmitTaskRequest {
                tag_id: tag.into(),
                session_id: session.into(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: "Lead the fixture work".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
}

async fn any_harness_contract(url: String) {
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(|| NOW);
    let codex = support::register_host(&store, "codex-host").await;
    let claude = support::register_host(&store, "claude-host").await;
    report(&store, &codex, &[HarnessKind::Codex]).await;
    report(&store, &claude, &[HarnessKind::ClaudeCode]).await;
    put(&store, "lead", &["files:read"], HarnessKind::Codex)
        .await
        .unwrap();
    let mut spec = PutTagRequest {
        tag_id: "lead".into(),
        instructions: "Fixture instructions".into(),
        allowed_actions: vec!["files:read".into()],
        harness_kind: HarnessKind::Codex as i32,
        work_session_harness: Some("any".into()),
        ..Default::default()
    };
    let tag = store.put_tag_spec(spec.clone()).await.unwrap();
    assert_eq!(tag.work_session_harness, "any");
    spec.work_session_harness = Some("cursor".into());
    assert!(matches!(
        store.put_tag_spec(spec).await,
        Err(StoreError::InvalidArgument(reason)) if reason.contains("empty or 'any'")
    ));
    let parent = submit(&store, "lead", "parent").await;
    let lead = claim(&store, &codex, HarnessKind::Codex).await.unwrap();
    assert_eq!(lead.task_id, parent.task_id);
    let started = store
        .start_work_session(
            &supertag_control_plane::AttemptAccess::new(&codex, &lead),
            &StartWorkSessionRequest {
                harness: None,
                ..start("any", "codex")
            },
        )
        .await
        .unwrap();
    let child = store.get_task(&started.latest_task_id).await.unwrap();
    assert_eq!(child.harness_kind(), HarnessKind::Unspecified);
    let claimed = claim(&store, &claude, HarnessKind::ClaudeCode)
        .await
        .unwrap();
    assert_eq!(claimed.task_id, child.task_id);
    let pinned = store.get_task(&child.task_id).await.unwrap();
    assert_eq!(pinned.harness_kind(), HarnessKind::ClaudeCode);
    let explicit = store
        .start_work_session(
            &supertag_control_plane::AttemptAccess::new(&codex, &lead),
            &start("explicit", "codex"),
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .get_task(&explicit.latest_task_id)
            .await
            .unwrap()
            .harness_kind(),
        HarnessKind::Codex
    );
    assert_eq!(
        store.get_tag("lead").await.unwrap().harness_kind(),
        HarnessKind::Codex
    );
}

async fn contract(url: String) {
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(|| NOW);
    let codex = support::register_host(&store, "codex-host").await;
    let claude = support::register_host(&store, "claude-host").await;
    report(&store, &codex, &[HarnessKind::Codex]).await;
    report(
        &store,
        &claude,
        &[HarnessKind::ClaudeCode, HarnessKind::Cursor],
    )
    .await;

    // A Tag keeps the harness it was created with: no other harness, and not none.
    put(&store, "lead", &["files:read"], HarnessKind::Codex)
        .await
        .unwrap();
    put(&store, "lead", &["files:read"], HarnessKind::Codex)
        .await
        .unwrap();
    for other in [HarnessKind::ClaudeCode, HarnessKind::Unspecified] {
        let refused = put(&store, "lead", &["files:read"], other).await;
        assert!(
            matches!(&refused, Err(StoreError::FailedPrecondition(reason))
                if reason.starts_with("Tag lead runs on codex, and a Tag keeps its harness. Create a new Tag")),
            "{refused:?}"
        );
    }
    let tag = store.get_tag("lead").await.unwrap();
    assert_eq!(tag.harness_kind(), HarnessKind::Codex);

    // The lead runs Codex; its Work Session names Claude Code and only that harness claims it.
    let parent = submit(&store, "lead", "parent").await;
    let lead = claim(&store, &codex, HarnessKind::Codex).await.unwrap();
    assert_eq!(lead.task_id, parent.task_id);
    let started = store
        .start_work_session(
            &supertag_control_plane::AttemptAccess::new(&codex, &lead),
            &start("claude", "claude-code"),
        )
        .await
        .unwrap();
    let child = store.get_task(&started.latest_task_id).await.unwrap();
    assert_eq!(child.harness_kind(), HarnessKind::ClaudeCode);
    assert_eq!(child.tag_id, "lead");
    assert!(
        child
            .execution_selection
            .as_ref()
            .is_none_or(|selection| selection.model.is_none()),
        "the Tag's models were for Codex"
    );
    // A retried start returns the same Work Session.
    let retried = store
        .start_work_session(
            &supertag_control_plane::AttemptAccess::new(&codex, &lead),
            &start("claude", "claude-code"),
        )
        .await
        .unwrap();
    assert_eq!(retried.work_session_id, started.work_session_id);
    // The harness is part of the start: the same operation without it, or with another, conflicts.
    for harness in [None, Some("cursor")] {
        let changed = StartWorkSessionRequest {
            harness: harness.map(Into::into),
            ..start("claude", "claude-code")
        };
        assert!(matches!(
            store
                .start_work_session(
                    &supertag_control_plane::AttemptAccess::new(&codex, &lead),
                    &changed
                )
                .await,
            Err(StoreError::Conflict(_))
        ));
    }
    let placement = store
        .diagnose_task_placement(&started.latest_task_id)
        .await
        .unwrap();
    let codex_placement = placement
        .hosts
        .iter()
        .find(|host| host.host_id == "codex-host")
        .unwrap();
    assert_eq!(codex_placement.requirement, "harness", "{placement:?}");
    assert!(claim(&store, &codex, HarnessKind::Codex).await.is_none());
    let placed = claim(&store, &claude, HarnessKind::ClaudeCode)
        .await
        .unwrap();
    assert_eq!(placed.task_id, started.latest_task_id);

    // Refusals: an unknown harness, one no bound Worker Host runs, and the same harness is a
    // plain start.
    assert!(matches!(
        store
            .start_work_session(
                &supertag_control_plane::AttemptAccess::new(&codex, &lead),
                &start("unknown", "gemini")
            )
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    let missing = store
        .start_work_session(
            &supertag_control_plane::AttemptAccess::new(&codex, &lead),
            &start("opencode", "opencode"),
        )
        .await;
    assert!(
        matches!(&missing, Err(StoreError::FailedPrecondition(reason))
            if reason.contains("no Worker Host bound to Tag lead runs OpenCode")),
        "{missing:?}"
    );
    let same = store
        .start_work_session(
            &supertag_control_plane::AttemptAccess::new(&codex, &lead),
            &start("same", "codex"),
        )
        .await
        .unwrap();
    let same = store.get_task(&same.latest_task_id).await.unwrap();
    assert_eq!(same.harness_kind(), HarnessKind::Codex);
    let codex_child = claim(&store, &codex, HarnessKind::Codex).await.unwrap();
    assert_eq!(codex_child.task_id, same.task_id);

    // Permissions are checked against the named harness's capabilities: Cursor runs commands
    // only with file writes, so this Tag's Work Session cannot run there.
    put(
        &store,
        "builder",
        &["commands:execute", "files:read"],
        HarnessKind::Codex,
    )
    .await
    .unwrap();
    let builder = submit(&store, "builder", "parent").await;
    let attempt = claim(&store, &codex, HarnessKind::Codex).await.unwrap();
    assert_eq!(attempt.task_id, builder.task_id);
    let mismatched = store
        .start_work_session(
            &supertag_control_plane::AttemptAccess::new(&codex, &attempt),
            &start("cursor", "cursor"),
        )
        .await;
    assert!(
        matches!(&mismatched, Err(StoreError::FailedPrecondition(reason))
            if reason.starts_with("Cursor commands:execute also requires files:write")),
        "{mismatched:?}"
    );
    let open = store
        .list_work_sessions(
            OP,
            &ListWorkSessionsRequest {
                parent_tag_id: "builder".into(),
                parent_session_id: "parent".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        open.work_sessions.is_empty(),
        "a refused start leaves nothing"
    );
    store.close().await;
}

/// Runs `test` on its own thread with an 8 MiB stack, as the store's largest futures need.
fn on_large_stack<F: std::future::Future<Output = ()>>(test: impl FnOnce() -> F + Send + 'static) {
    std::thread::Builder::new()
        .stack_size(8 << 20)
        .spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(test());
        })
        .unwrap()
        .join()
        .unwrap_or_else(|panic| std::panic::resume_unwind(panic));
}

#[test]
fn sqlite_work_session_harness() {
    on_large_stack(|| async {
        let directory = tempfile::tempdir().unwrap();
        contract(format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("harness.db").display()
        ))
        .await;
    });
}

#[test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
fn postgres_work_session_harness() {
    on_large_stack(postgres_contract);
}

async fn postgres_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("dedicated PostgreSQL URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!("supertag_rust_harness_{}", Uuid::new_v4().simple());
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
    outcome.expect("PostgreSQL Work Session harness contract failed");
}

#[test]
fn sqlite_any_work_session_harness() {
    on_large_stack(|| async {
        let directory = tempfile::tempdir().unwrap();
        any_harness_contract(format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("any.db").display()
        ))
        .await;
    });
}

#[test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
fn postgres_any_work_session_harness() {
    on_large_stack(|| async {
        let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").unwrap();
        let admin_url = std::fs::read_to_string(path).unwrap();
        let mut url = url::Url::parse(admin_url.trim()).unwrap();
        let name = format!("supertag_rust_any_harness_{}", Uuid::new_v4().simple());
        let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
        admin
            .execute(format!("CREATE DATABASE {name}").as_str())
            .await
            .unwrap();
        url.set_path(&name);
        let outcome = tokio::task::LocalSet::new()
            .run_until(async move {
                tokio::task::spawn_local(any_harness_contract(url.to_string())).await
            })
            .await;
        admin
            .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
            .await
            .unwrap();
        admin.close().await.unwrap();
        outcome.expect("PostgreSQL any harness contract failed");
    });
}
