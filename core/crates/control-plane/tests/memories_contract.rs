//! A Tag's memory is its harness's own. The Control Plane says which turns' changes are the
//! Tag's own (`memory_trusted`), hands the notes Tags kept before to the first such turn on a
//! harness that keeps memory until its host acknowledges them, and queues a daily review turn
//! that reaches no one.
mod support;

use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sqlx::{AnyPool, Connection, Executor};
use supertag_control_plane::{AttemptAccess, HostAuthority, Store};
use supertag_protocol::v2::*;
use uuid::Uuid;

const BASE: i64 = 1_893_456_000_000;
const HOUR: i64 = 60 * 60 * 1000;
const ALICE: &str = "operator:alice";
const BOB: &str = "operator:bob";
const TAG: &str = "keeper";
const LOCAL: &str = "operator:local";

/// Seeds as the upgrade leaves the notes Tags kept: ID, audience, and text.
async fn insert_seeds(url: &str, seeds: &[(&str, &str, &str)]) {
    let pool = AnyPool::connect(url).await.unwrap();
    for (index, (id, audience, text)) in seeds.iter().enumerate() {
        sqlx::query(
            "INSERT INTO supertag_v2_native_memory_seeds (seed_id,tag_id,audience_principal,text,created_at_ms)
             VALUES ($1,$2,$3,$4,$5)",
        )
        .bind(*id)
        .bind(TAG)
        .bind(*audience)
        .bind(*text)
        .bind(index as i64 + 1)
        .execute(&pool)
        .await
        .unwrap();
    }
    pool.close().await;
}

async fn start(
    store: &Store,
    host: &HostAuthority,
    assignment: &Assignment,
) -> InspectAttemptRequest {
    let attempt = InspectAttemptRequest {
        task_id: assignment.task.as_ref().unwrap().task_id.clone(),
        attempt_id: assignment.attempt_id.clone(),
        lease_token: assignment.lease_token.clone(),
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
    attempt
}

/// Claims the next Task as a host running `harness`, and starts it.
async fn claim(
    store: &Store,
    host: &HostAuthority,
    harness: HarnessKind,
) -> (InspectAttemptRequest, Assignment) {
    let assignment = store
        .claim_task_waiting(
            host,
            &ClaimTaskRequest {
                operation_id: Uuid::new_v4().to_string(),
                harness_kind: harness.into(),
                ..Default::default()
            },
            std::time::Duration::ZERO,
        )
        .await
        .unwrap()
        .expect("expected Task");
    (start(store, host, &assignment).await, assignment)
}

async fn finish(store: &Store, host: &HostAuthority, attempt: &InspectAttemptRequest, ok: bool) {
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                succeeded: ok,
                result: "Done".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

/// A turn of `principal`'s conversation with the Tag on `harness`, claimed and running.
async fn say(
    store: &Store,
    host: &HostAuthority,
    principal: &str,
    text: &str,
    harness: HarnessKind,
) -> (InspectAttemptRequest, Assignment) {
    store
        .send_message(
            principal,
            &SendMessageRequest {
                tag_id: TAG.into(),
                text: text.into(),
                operation_id: Uuid::new_v4().to_string(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    claim(store, host, harness).await
}

/// A turn the operator submitted to the Tag's `ops` Session on `harness`, claimed and running.
async fn submit(
    store: &Store,
    host: &HostAuthority,
    text: &str,
    harness: HarnessKind,
) -> (InspectAttemptRequest, Assignment) {
    store
        .submit_task(
            LOCAL,
            &SubmitTaskRequest {
                tag_id: TAG.into(),
                session_id: "ops".into(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: text.into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    claim(store, host, harness).await
}

async fn capabilities(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
) -> AttemptCapabilities {
    store
        .attempt_capabilities(&AttemptAccess::new(host, attempt))
        .await
        .unwrap()
}

fn seeds(assignment: &Assignment) -> Vec<(String, String)> {
    assignment
        .native_memory
        .as_ref()
        .map(|grant| {
            grant
                .seeds
                .iter()
                .map(|seed| (seed.seed_id.clone(), seed.text.clone()))
                .collect()
        })
        .unwrap_or_default()
}

async fn contract(url: &str) {
    let store = Store::open(url).await.unwrap();
    let host = support::register_host(&store, "memory-host").await;
    let tag = store
        .put_tag(TAG, "Keep memory", vec!["files:read".into()])
        .await
        .unwrap();
    assert!(tag.memory, "a new Tag keeps memory");
    // The notes the Tag kept before, as the upgrade left them: Alice's, and the operator's.
    insert_seeds(
        url,
        &[
            ("mem_local", LOCAL, "Releases ship from main."),
            ("mem_alice", ALICE, "Alice prefers squash merges."),
        ],
    )
    .await;

    // A conversation turn's changes are the Tag's own; its context lists no notes any more.
    let (custom, assignment) = say(&store, &host, ALICE, "Hello", HarnessKind::OpenaiAgents).await;
    let caps = capabilities(&store, &host, &custom).await;
    assert!(caps.memory_trusted);
    assert!(
        !caps.tag_portfolio.contains("Notes"),
        "{}",
        caps.tag_portfolio
    );
    // A harness whose Worker Host keeps no memory for it gets no seeds: they wait for one that
    // does.
    assert!(seeds(&assignment).is_empty());
    finish(&store, &host, &custom, true).await;
    // OpenCode and Cursor keep none of their own, but the Worker Host keeps a memory folder for
    // each, so their turns get the seeds too; unacknowledged, they are granted again.
    for harness in [HarnessKind::Opencode, HarnessKind::Cursor] {
        let (turn, assignment) = say(&store, &host, ALICE, "Hello there", harness).await;
        assert!(
            assignment
                .native_memory
                .as_ref()
                .is_some_and(|grant| grant.trusted)
        );
        assert_eq!(
            seeds(&assignment),
            [(
                "mem_alice".to_owned(),
                "Alice prefers squash merges.".to_owned()
            )],
            "{harness:?}"
        );
        finish(&store, &host, &turn, true).await;
    }

    // Alice's turn on Codex gets her note to write into her store, the operator's turn only
    // theirs, and Bob's conversation none.
    let (alice, assignment) = say(&store, &host, ALICE, "Hi again", HarnessKind::Codex).await;
    assert_eq!(
        seeds(&assignment),
        [(
            "mem_alice".to_owned(),
            "Alice prefers squash merges.".to_owned()
        )]
    );
    let (bob, assignment) = say(&store, &host, BOB, "Hi", HarnessKind::Codex).await;
    assert!(seeds(&assignment).is_empty());
    finish(&store, &host, &bob, true).await;
    let (bob, bob_assignment) = submit(&store, &host, "Hi all", HarnessKind::Codex).await;
    assert_eq!(
        seeds(&bob_assignment),
        [(
            "mem_local".to_owned(),
            "Releases ship from main.".to_owned()
        )]
    );
    // An acknowledgement names only its own audience's seeds; another's stay, and repeating
    // one changes nothing.
    for _ in 0..2 {
        store
            .acknowledge_native_memory_seeds(
                &AttemptAccess::new(&host, &alice),
                &AcknowledgeNativeMemorySeedsRequest {
                    seed_ids: vec!["mem_alice".into(), "mem_local".into()],
                },
            )
            .await
            .unwrap();
    }
    finish(&store, &host, &alice, true).await;
    finish(&store, &host, &bob, false).await;
    let (alice, assignment) = say(&store, &host, ALICE, "Once more", HarnessKind::Codex).await;
    assert!(seeds(&assignment).is_empty(), "acknowledged seeds go");
    finish(&store, &host, &alice, true).await;
    let (bob, assignment) = submit(&store, &host, "Again", HarnessKind::ClaudeCode).await;
    assert_eq!(
        seeds(&assignment).len(),
        1,
        "unacknowledged seeds are granted again"
    );

    // An operator's reset of the Tag's memory drops its waiting seeds too.
    store
        .reset_native_memory(
            "operator:local",
            &ResetNativeMemoryRequest { tag_id: TAG.into() },
        )
        .await
        .unwrap();
    finish(&store, &host, &bob, true).await;
    let (bob, assignment) = submit(&store, &host, "After reset", HarnessKind::Codex).await;
    assert!(seeds(&assignment).is_empty());
    finish(&store, &host, &bob, true).await;

    // A Work Session's own turn reads its parent's store but only proposes: its grant says so,
    // and it gets no seeds.
    insert_seeds(url, &[("mem_later", ALICE, "Alice reviews on Fridays.")]).await;
    let (alice, parent) = say(&store, &host, ALICE, "Split this up", HarnessKind::Codex).await;
    let parent = parent
        .native_memory
        .expect("a conversation turn gets its store");
    assert!(parent.trusted);
    store
        .start_work_session(
            &AttemptAccess::new(&host, &alice),
            &StartWorkSessionRequest {
                operation_id: "work".into(),
                title: "Draft".into(),
                instruction: "Draft the plan".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let (work, assignment) = claim(&store, &host, HarnessKind::Codex).await;
    let grant = assignment
        .native_memory
        .expect("a Work Session reads its Tag's memory");
    assert_eq!(grant.scope, parent.scope, "its parent's audience");
    assert!(!grant.trusted && grant.seeds.is_empty(), "{grant:?}");
    assert!(!capabilities(&store, &host, &work).await.memory_trusted);
    store.cancel_task(&work.task_id).await.unwrap();
    finish(&store, &host, &work, false).await;
    finish(&store, &host, &alice, true).await;

    // memory: false: no turn's changes are the Tag's own, and none gets a store.
    let tag = store
        .put_tag_spec(PutTagRequest {
            tag_id: TAG.into(),
            instructions: "No memory".into(),
            allowed_actions: vec!["files:read".into()],
            memory: Some(false),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(!tag.memory);
    let (quiet, assignment) = say(&store, &host, BOB, "Anything?", HarnessKind::Codex).await;
    assert!(!capabilities(&store, &host, &quiet).await.memory_trusted);
    assert!(assignment.native_memory.is_none());
    finish(&store, &host, &quiet, true).await;
    store.close().await;
}

async fn review_contract(url: &str) {
    // The first ten turns finish a day before BASE, so the first review is due at BASE.
    let clock = Arc::new(AtomicI64::new(BASE - 25 * HOUR));
    let source = clock.clone();
    let store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || source.load(Ordering::SeqCst));
    let host = support::register_host(&store, "review-host").await;
    store
        .put_tag(
            TAG,
            "Keep memory",
            vec!["files:read".into(), "schedule:create".into()],
        )
        .await
        .unwrap();
    for index in 0..10 {
        let (turn, _) = say(
            &store,
            &host,
            ALICE,
            &format!("Work {index}"),
            HarnessKind::Codex,
        )
        .await;
        finish(&store, &host, &turn, true).await;
    }
    // A shared note the Tag kept before goes to a turn of a shared Session, such as the review.
    insert_seeds(url, &[("mem_shared", "", "Releases ship from main.")]).await;
    clock.store(BASE, Ordering::SeqCst);
    assert_eq!(store.sweep_memory().await.unwrap(), 1);
    let (review, assignment) = claim(&store, &host, HarnessKind::Codex).await;
    assert_eq!(
        seeds(&assignment),
        [(
            "mem_shared".to_owned(),
            "Releases ship from main.".to_owned()
        )]
    );
    let task = assignment.task.clone().unwrap();
    assert!(
        task.session_id.starts_with("memory:"),
        "{}",
        task.session_id
    );
    // The review keeps the harness's own memory, against the Sessions, and merges proposals.
    for text in ["your own memory", "proposals", "stay_quiet", "read_session"] {
        assert!(task.prompt.contains(text), "{text}: {}", task.prompt);
    }
    assert!(!task.prompt.contains("remember"), "{}", task.prompt);
    // It gets the shared store, and its changes are the Tag's own.
    assert_eq!(assignment.native_memory.unwrap().scope, "shared");
    // The review runs read-only: of the Tag's actions it keeps only reading files.
    assert_eq!(
        store
            .get_task(&review.task_id)
            .await
            .unwrap()
            .allowed_actions,
        ["files:read"]
    );
    let caps = capabilities(&store, &host, &review).await;
    assert!(caps.memory_trusted && caps.may_read_tag_sessions);
    // The review reaches no one: it finishes quietly.
    assert!(caps.may_stay_quiet);
    assert!(
        !caps.may_send_tag_message
            && !caps.may_read_mailbox
            && !caps.may_start_work_session
            && !caps.may_schedule
            && !caps.may_use_workstream
            && !caps.may_ask_objective_question
    );
    // It sees only shared Sessions: Alice's conversation is private to her.
    let listed = store
        .list_tag_sessions(
            &AttemptAccess::new(&host, &review),
            &ListTagSessionsRequest {
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(listed.sessions.is_empty(), "{listed:?}");
    finish(&store, &host, &review, true).await;

    // Within a day, more work queues no review; after a day it does.
    clock.store(BASE + HOUR, Ordering::SeqCst);
    for index in 0..10 {
        let (turn, _) = say(
            &store,
            &host,
            BOB,
            &format!("More {index}"),
            HarnessKind::Codex,
        )
        .await;
        finish(&store, &host, &turn, true).await;
    }
    clock.store(BASE + 23 * HOUR, Ordering::SeqCst);
    assert_eq!(store.sweep_memory().await.unwrap(), 0);
    clock.store(BASE + 25 * HOUR, Ordering::SeqCst);
    assert_eq!(store.sweep_memory().await.unwrap(), 1);
    let (second, assignment) = claim(&store, &host, HarnessKind::Codex).await;
    let prompt = assignment.task.unwrap().prompt;
    assert!(prompt.contains("Review your work since"), "{prompt}");
    finish(&store, &host, &second, true).await;

    // memory: false turns off the review.
    store
        .put_tag_spec(PutTagRequest {
            tag_id: TAG.into(),
            instructions: "No memory".into(),
            allowed_actions: vec!["files:read".into()],
            memory: Some(false),
            ..Default::default()
        })
        .await
        .unwrap();
    for index in 0..10 {
        let (turn, _) = say(
            &store,
            &host,
            BOB,
            &format!("Late {index}"),
            HarnessKind::Codex,
        )
        .await;
        finish(&store, &host, &turn, true).await;
    }
    clock.store(BASE + 60 * HOUR, Ordering::SeqCst);
    assert_eq!(store.sweep_memory().await.unwrap(), 0);
    store.close().await;
}

#[tokio::test]
async fn sqlite_memories_contract() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("memories.db").display()
    );
    contract(&url).await;
}

#[tokio::test]
async fn sqlite_memory_review_contract() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("review.db").display()
    );
    review_contract(&url).await;
}

async fn on_postgres(run: fn(String) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()>>>) {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_rust_memories_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let local = tokio::task::LocalSet::new();
    let outcome = local
        .run_until(async move {
            tokio::task::spawn_local(async move { run(url.to_string()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL memories contract failed");
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_memories_contract() {
    on_postgres(|url| Box::pin(async move { contract(&url).await })).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_memory_review_contract() {
    on_postgres(|url| Box::pin(async move { review_contract(&url).await })).await;
}
