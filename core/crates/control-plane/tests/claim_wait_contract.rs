mod support;

use std::time::{Duration, Instant};

use sqlx::{Connection, Executor};
use supertag_control_plane::Store;
use supertag_protocol::v2::*;
use uuid::Uuid;

fn claim(operation: &str, wait_ms: u32) -> ClaimTaskRequest {
    ClaimTaskRequest {
        operation_id: operation.into(),
        wait_ms,
        ..Default::default()
    }
}

async fn exercise(database: &str) {
    let store = Store::open(database).await.unwrap();
    store
        .put_tag("engineer", "Process this request", vec![])
        .await
        .unwrap();
    let host = support::register_host(&store, "waiting-host").await;

    // Without a wait, an empty claim answers at once, as before.
    let at = Instant::now();
    assert!(
        store
            .claim_task_waiting(&host, &claim("now", 0), Duration::ZERO)
            .await
            .unwrap()
            .is_none()
    );
    assert!(at.elapsed() < Duration::from_secs(1));

    // A held claim takes a Task as soon as one is sent.
    let waiting = claim("held", 6_000);
    let held = store.claim_task_waiting(&host, &waiting, Duration::from_secs(6));
    let send = async {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let sent = Instant::now();
        let message = store
            .send_message(
                "operator:alice",
                &SendMessageRequest {
                    tag_id: "engineer".into(),
                    text: "Wake the host".into(),
                    operation_id: "wake".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        (sent, message.task.unwrap().task_id)
    };
    let (assignment, (sent, task_id)) = tokio::join!(held, send);
    let assignment = assignment.unwrap().expect("the held claim took the Task");
    assert_eq!(assignment.task.unwrap().task_id, task_id);
    assert!(
        sent.elapsed() < Duration::from_millis(900),
        "{:?}",
        sent.elapsed()
    );

    // A held claim that finds nothing answers empty when its wait ends, at most 8 seconds.
    let at = Instant::now();
    assert!(
        store
            .claim_task_waiting(&host, &claim("empty", 700), Duration::from_millis(700))
            .await
            .unwrap()
            .is_none()
    );
    assert!(at.elapsed() >= Duration::from_millis(650) && at.elapsed() < Duration::from_secs(3));

    // A host holds at most 16 claims at once, across its lanes; another answers at once.
    let held: Vec<_> = (0..16)
        .map(|index| {
            let store = store.clone();
            let host = host.clone();
            tokio::task::spawn_local(async move {
                store
                    .claim_task_waiting(
                        &host,
                        &claim(&format!("cap-{index}"), 3_000),
                        Duration::from_secs(3),
                    )
                    .await
            })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let at = Instant::now();
    assert!(
        store
            .claim_task_waiting(&host, &claim("seventeenth", 3_000), Duration::from_secs(3))
            .await
            .unwrap()
            .is_none()
    );
    assert!(at.elapsed() < Duration::from_secs(1), "{:?}", at.elapsed());

    // Draining answers every held claim at once.
    let at = Instant::now();
    store.close_follows();
    for claim in held {
        assert!(claim.await.unwrap().unwrap().is_none());
    }
    assert!(at.elapsed() < Duration::from_secs(1), "{:?}", at.elapsed());
    store.close().await;
}

async fn send(store: &Store, text: &str) -> String {
    send_to(store, "coder", text).await
}

async fn send_to(store: &Store, tag: &str, text: &str) -> String {
    store
        .send_message(
            "operator:alice",
            &SendMessageRequest {
                tag_id: tag.into(),
                text: text.into(),
                operation_id: text.into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .task
        .unwrap()
        .task_id
}

fn codex(operation: &str, wait_ms: u32, harness: HarnessKind) -> ClaimTaskRequest {
    ClaimTaskRequest {
        harness_kind: harness as i32,
        ..claim(operation, wait_ms)
    }
}

/// A Session's next Task goes first to the host its last Task finished on, while that host is
/// waiting and may run it; otherwise any host takes it at once.
async fn exercise_sticky(database: &str) {
    let store = Store::open(database).await.unwrap();
    store
        .put_tag_configured("coder", "Code", vec![], None, HarnessKind::Codex)
        .await
        .unwrap();
    let warm = support::register_host(&store, "warm-host").await;
    let other = support::register_host(&store, "other-host").await;
    let first = send(&store, "First turn").await;
    let assignment = store
        .claim_task_waiting(
            &warm,
            &codex("warm-1", 0, HarnessKind::Codex),
            Duration::ZERO,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(assignment.task.as_ref().unwrap().task_id, first);
    store
        .start_task(
            &warm,
            &StartTaskRequest {
                task_id: first.clone(),
                attempt_id: assignment.attempt_id.clone(),
                lease_token: assignment.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    store
        .finish_task(
            &warm,
            &FinishTaskRequest {
                task_id: first.clone(),
                attempt_id: assignment.attempt_id.clone(),
                lease_token: assignment.lease_token.clone(),
                result: "Done".into(),
                succeeded: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();

    // The warm host waits to claim; the other host is left without the Session's next Task.
    let waiting = codex("warm-2", 6_000, HarnessKind::Codex);
    let held = store.claim_task_waiting(&warm, &waiting, Duration::from_secs(6));
    let race = async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let second = send(&store, "Second turn").await;
        let taken = store
            .claim_task_waiting(
                &other,
                &codex("other-1", 0, HarnessKind::Codex),
                Duration::ZERO,
            )
            .await
            .unwrap();
        (second, taken)
    };
    let (assignment, (second, taken)) = tokio::join!(held, race);
    assert!(taken.is_none(), "another host took the warm Session's Task");
    let assignment = assignment
        .unwrap()
        .expect("the warm host took its Session's Task");
    assert_eq!(assignment.task.as_ref().unwrap().task_id, second);
    let finish = FinishTaskRequest {
        task_id: second.clone(),
        attempt_id: assignment.attempt_id.clone(),
        lease_token: assignment.lease_token.clone(),
        result: "Done".into(),
        succeeded: true,
        ..Default::default()
    };
    store
        .start_task(
            &warm,
            &StartTaskRequest {
                task_id: second.clone(),
                attempt_id: assignment.attempt_id.clone(),
                lease_token: assignment.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    store.finish_task(&warm, &finish).await.unwrap();

    // A warm host whose claim can no longer run the Task is not waited for.
    let waiting = codex("warm-3", 6_000, HarnessKind::Cursor);
    let held = store.claim_task_waiting(&warm, &waiting, Duration::from_millis(1_500));
    let race = async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let third = send(&store, "Third turn").await;
        let taken = store
            .claim_task_waiting(
                &other,
                &codex("other-2", 0, HarnessKind::Codex),
                Duration::ZERO,
            )
            .await
            .unwrap();
        (third, taken)
    };
    let (held, (third, taken)) = tokio::join!(held, race);
    assert!(held.unwrap().is_none());
    assert_eq!(taken.unwrap().task.unwrap().task_id, third);
    store.close().await;
}

fn lane(operation: &str, wait_ms: u32, profile: HarnessExecutionProfile) -> ClaimTaskRequest {
    ClaimTaskRequest {
        harness_kind: HarnessKind::ClaudeCode as i32,
        workspace_ids: vec!["repo".into()],
        execution_profile: Some(profile),
        ..claim(operation, wait_ms)
    }
}

async fn submit(store: &Store, operation: &str) -> String {
    store
        .submit_task(
            "operator:alice",
            &SubmitTaskRequest {
                tag_id: "builder".into(),
                session_id: operation.into(),
                operation_id: operation.into(),
                prompt: "Run the tests".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .task_id
}

/// A Task that runs commands goes to a sandboxed lane, such as a local-vm one, waiting to claim
/// rather than to a lane that runs commands unsandboxed; a busy sandboxed lane leaves it to them.
async fn exercise_sandboxed(database: &str) {
    let store = Store::open(database).await.unwrap();
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "builder".into(),
            instructions: "Build".into(),
            harness_kind: HarnessKind::ClaudeCode.into(),
            allowed_actions: vec![
                "files:read".into(),
                "files:write".into(),
                "commands:execute".into(),
            ],
            workspace: Some(WorkspaceSpec {
                workspace_id: "repo".into(),
                base_commit: "1111111111111111111111111111111111111111".into(),
                ..Default::default()
            }),
            ..Default::default()
        })
        .await
        .unwrap();
    let sandboxed = HarnessExecutionProfile {
        remote_file_workspace: true,
        ..Default::default()
    };
    let unsandboxed = HarnessExecutionProfile {
        allow_unsandboxed_commands: true,
        ..Default::default()
    };
    let vm = support::register_host(&store, "local-vm-host").await;
    let laptop = support::register_host(&store, "unsandboxed-host").await;

    let waiting = lane("vm-1", 6_000, sandboxed.clone());
    let held = store.claim_task_waiting(&vm, &waiting, Duration::from_secs(6));
    let race = async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let task = submit(&store, "first").await;
        let taken = store
            .claim_task_waiting(
                &laptop,
                &lane("laptop-1", 0, unsandboxed.clone()),
                Duration::ZERO,
            )
            .await
            .unwrap();
        (task, taken)
    };
    let (assignment, (task, taken)) = tokio::join!(held, race);
    assert!(taken.is_none(), "the unsandboxed lane took a command Task");
    let assignment = assignment.unwrap().expect("the sandboxed lane took it");
    assert_eq!(assignment.task.unwrap().task_id, task);

    // With no sandboxed lane waiting, the unsandboxed lane runs it at once.
    let task = submit(&store, "second").await;
    let taken = store
        .claim_task_waiting(
            &laptop,
            &lane("laptop-2", 0, unsandboxed.clone()),
            Duration::ZERO,
        )
        .await
        .unwrap();
    assert_eq!(taken.unwrap().task.unwrap().task_id, task);
    store.close().await;
}

async fn ready(
    store: &Store,
    host: &supertag_control_plane::HostAuthority,
    sequence: u64,
    free: u32,
) {
    store
        .report_host(
            host,
            &ReportHostRequest {
                sequence,
                capacity: 1,
                available_slots: free,
                readiness: HostReadiness::Ready as i32,
                reason: HostReadinessReason::Unspecified as i32,
                harness_kind: HarnessKind::Codex as i32,
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

/// Claims and runs the next Task with no wait, on `store`, and finishes it there.
async fn run_one(
    store: &Store,
    host: &supertag_control_plane::HostAuthority,
    operation: &str,
) -> String {
    let assignment = store
        .claim_task_waiting(
            host,
            &codex(operation, 0, HarnessKind::Codex),
            Duration::ZERO,
        )
        .await
        .unwrap()
        .unwrap_or_else(|| panic!("{operation} claimed no Task"));
    let task = assignment.task.as_ref().unwrap().task_id.clone();
    store
        .start_task(
            host,
            &StartTaskRequest {
                task_id: task.clone(),
                attempt_id: assignment.attempt_id.clone(),
                lease_token: assignment.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: task.clone(),
                attempt_id: assignment.attempt_id.clone(),
                lease_token: assignment.lease_token.clone(),
                result: "Done".into(),
                succeeded: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    task
}

/// Warm leases are in the database, so every Control Plane replica honours them and they survive
/// a restart. A replica that does not hold the warm host's waiting claim judges it by its
/// recorded readiness: a ready warm host gets its Session's next Task first for 2 s; a busy one
/// is not waited for; after 5 minutes the Session is no longer warm.
async fn exercise_replicas(database: &str) {
    use std::sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    };
    // Task acceptance is stamped by the wall clock, so the stores' clock runs at wall time plus
    // an offset the test moves.
    let offset = Arc::new(AtomicI64::new(0));
    let clock = |offset: &Arc<AtomicI64>| {
        let offset = offset.clone();
        move || {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64
                + offset.load(Ordering::SeqCst)
        }
    };
    let first = Store::open(database)
        .await
        .unwrap()
        .with_execution_clock(clock(&offset));
    let second = Store::open(database)
        .await
        .unwrap()
        .with_execution_clock(clock(&offset));
    first
        .put_tag_configured("replica-coder", "Code", vec![], None, HarnessKind::Codex)
        .await
        .unwrap();
    let warm = support::register_host(&first, "replica-warm").await;
    let other = support::register_host(&first, "replica-other").await;
    let sequence = std::cell::Cell::new(0);
    let next = || {
        sequence.set(sequence.get() + 1);
        sequence.get()
    };
    let both_ready = |store: &Store| {
        let at = next();
        let (warm, other) = (warm.clone(), other.clone());
        let store = store.clone();
        async move {
            ready(&store, &warm, at, 1).await;
            ready(&store, &other, at, 1).await;
        }
    };
    both_ready(&first).await;

    // The Session finishes on the warm host through the first replica.
    send_to(&first, "replica-coder", "Replica turn one").await;
    run_one(&first, &warm, "replica-warm-1").await;

    // Through the second replica, which holds no claim of the warm host, a ready warm host still
    // gets the next Task first; 2 s after the Task was sent, another host takes it.
    let turn = send_to(&second, "replica-coder", "Replica turn two").await;
    assert!(
        second
            .claim_task_waiting(
                &other,
                &codex("replica-other-1", 0, HarnessKind::Codex),
                Duration::ZERO
            )
            .await
            .unwrap()
            .is_none(),
        "another replica gave a warm Session's Task away at once"
    );
    offset.store(2_001, Ordering::SeqCst);
    assert_eq!(run_one(&second, &other, "replica-other-2").await, turn);
    offset.store(0, Ordering::SeqCst);

    // The Session is now warm on the other host. Busy, it is not waited for.
    let at = next();
    ready(&first, &other, at, 0).await;
    ready(&first, &warm, at, 1).await;
    let turn = send_to(&first, "replica-coder", "Replica turn three").await;
    assert_eq!(run_one(&first, &warm, "replica-warm-2").await, turn);

    // A restarted replica still honours the lease the Session's last finish recorded.
    first.close().await;
    let restarted = Store::open(database)
        .await
        .unwrap()
        .with_execution_clock(clock(&offset));
    both_ready(&restarted).await;
    send_to(&restarted, "replica-coder", "Replica turn four").await;
    assert!(
        restarted
            .claim_task_waiting(
                &other,
                &codex("replica-other-3", 0, HarnessKind::Codex),
                Duration::ZERO
            )
            .await
            .unwrap()
            .is_none(),
        "a restarted replica forgot the warm lease"
    );

    // A lease more than five minutes old is not honoured: the warm host finishes turn four six
    // minutes ago, and turn five, sent now, goes to whichever host claims it.
    offset.store(-6 * 60 * 1000, Ordering::SeqCst);
    both_ready(&restarted).await;
    run_one(&restarted, &warm, "replica-warm-3").await;
    offset.store(0, Ordering::SeqCst);
    both_ready(&restarted).await;
    let turn = send_to(&restarted, "replica-coder", "Replica turn five").await;
    assert_eq!(run_one(&second, &other, "replica-other-4").await, turn);
    second.close().await;
    restarted.close().await;
}

#[tokio::test]
async fn sqlite_claim_wait_contract() {
    let local = tokio::task::LocalSet::new();
    local.run_until(exercise("sqlite::memory:")).await;
    local.run_until(exercise_sticky("sqlite::memory:")).await;
    local.run_until(exercise_sandboxed("sqlite::memory:")).await;
    // Replicas share a file: an in-memory database is private to one Store.
    let directory = tempfile::tempdir().unwrap();
    let file = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("replicas.db").display()
    );
    local.run_until(exercise_replicas(&file)).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_claim_wait_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let database = format!("supertag_rust_claim_wait_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&database);
    let local = tokio::task::LocalSet::new();
    let result = local
        .run_until(async move {
            tokio::task::spawn_local(async move {
                exercise(url.as_str()).await;
                exercise_sticky(url.as_str()).await;
                exercise_sandboxed(url.as_str()).await;
                exercise_replicas(url.as_str()).await;
            })
            .await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await
        .unwrap();
    result.unwrap();
}
