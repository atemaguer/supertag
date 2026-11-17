//! A Tag's memory: notes it writes with `remember` and `forget`, staged until the turn
//! succeeds, scoped so one person's notes never reach another's conversation, bounded, listed
//! and deleted by people, and tidied by a daily review turn that reaches no one.
mod support;

use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const BASE: i64 = 1_893_456_000_000;
const HOUR: i64 = 60 * 60 * 1000;
const ALICE: &str = "operator:alice";
const BOB: &str = "operator:bob";
const TAG: &str = "keeper";

async fn claim(store: &Store, host: &HostAuthority, id: &str) -> InspectAttemptRequest {
    let assignment = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .expect("expected Task");
    assert_eq!(assignment.task.unwrap().task_id, id);
    let attempt = InspectAttemptRequest {
        task_id: id.into(),
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
    attempt
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

/// A turn of `principal`'s conversation with the Tag, claimed and running.
async fn say(
    store: &Store,
    host: &HostAuthority,
    principal: &str,
    text: &str,
) -> InspectAttemptRequest {
    let task = store
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
        .unwrap()
        .task
        .unwrap();
    claim(store, host, &task.task_id).await
}

async fn remember(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    operation: &str,
    text: &str,
    replaces: Option<&str>,
) -> Result<AttemptMemoryResponse, StoreError> {
    store
        .attempt_remember(
            host,
            &AttemptRememberRequest {
                attempt: Some(attempt.clone()),
                operation_id: operation.into(),
                text: text.into(),
                replaces: replaces.map(str::to_owned),
            },
        )
        .await
}

async fn forget(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    id: &str,
) -> Result<AttemptMemoryResponse, StoreError> {
    store
        .attempt_forget(
            host,
            &AttemptForgetRequest {
                attempt: Some(attempt.clone()),
                operation_id: Uuid::new_v4().to_string(),
                memory_id: id.into(),
            },
        )
        .await
}

async fn texts(store: &Store, principal: &str) -> Vec<String> {
    store
        .list_memories(
            principal,
            &ListMemoriesRequest {
                tag_id: Some(TAG.into()),
            },
        )
        .await
        .unwrap()
        .memories
        .into_iter()
        .map(|memory| memory.text)
        .collect()
}

async fn portfolio(store: &Store, host: &HostAuthority, attempt: &InspectAttemptRequest) -> String {
    store
        .attempt_capabilities(host, attempt)
        .await
        .unwrap()
        .tag_portfolio
}

async fn contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(BASE));
    let source = clock.clone();
    let store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || source.load(Ordering::SeqCst));
    let host = support::register_host(&store, "memory-host").await;
    let tag = store
        .put_tag(TAG, "Keep notes", vec!["files:read".into()])
        .await
        .unwrap();
    assert!(tag.memory, "a new Tag keeps memory");

    // Alice's conversation writes a note private to her; it applies when her turn succeeds.
    let a1 = say(&store, &host, ALICE, "I prefer squash merges").await;
    let caps = store.attempt_capabilities(&host, &a1).await.unwrap();
    assert!(caps.may_remember);
    assert!(
        caps.tag_portfolio
            .contains("Notes: this Tag keeps none yet.")
    );
    let saved = remember(
        &store,
        &host,
        &a1,
        "op-1",
        " Alice prefers squash merges. ",
        None,
    )
    .await
    .unwrap();
    let alice_note = saved.memory.clone().unwrap();
    assert_eq!(alice_note.text, "Alice prefers squash merges.");
    assert_eq!(alice_note.state(), MemoryState::Staged);
    assert_eq!(alice_note.audience.as_deref(), Some(ALICE));
    assert!(
        texts(&store, ALICE).await.is_empty(),
        "staged until the turn succeeds"
    );
    // A replay returns the same note; a different call under the same ID is a conflict.
    let replay = remember(
        &store,
        &host,
        &a1,
        "op-1",
        "Alice prefers squash merges.",
        None,
    )
    .await
    .unwrap();
    assert_eq!(replay.memory.unwrap().memory_id, alice_note.memory_id);
    assert!(matches!(
        remember(&store, &host, &a1, "op-1", "Something else", None).await,
        Err(StoreError::Conflict(_))
    ));
    assert!(matches!(
        remember(&store, &host, &a1, "op-2", &"x".repeat(501), None).await,
        Err(StoreError::InvalidArgument(_))
    ));
    finish(&store, &host, &a1, true).await;
    assert_eq!(texts(&store, ALICE).await, ["Alice prefers squash merges."]);

    // A failed turn's notes never apply.
    let a2 = say(&store, &host, ALICE, "Note this, then fail").await;
    remember(&store, &host, &a2, "op-1", "Never kept", None)
        .await
        .unwrap();
    finish(&store, &host, &a2, false).await;
    assert_eq!(texts(&store, ALICE).await, ["Alice prefers squash merges."]);

    // An operator's Objective is shared: its notes reach every conversation.
    let objective = store
        .create_objective(
            "operator:carol",
            &CreateObjectiveRequest {
                operation_id: "release".into(),
                objective_id: "release".into(),
                owner_tag_id: TAG.into(),
                outcome: "Ship the release".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let o1 = claim(&store, &host, &objective.starting_task_id).await;
    let shared = remember(
        &store,
        &host,
        &o1,
        "op-1",
        "Release checklist lives in docs/operations/release.md.",
        None,
    )
    .await
    .unwrap()
    .memory
    .unwrap();
    assert!(shared.audience.is_none());
    finish(&store, &host, &o1, true).await;
    store
        .pause_objective(
            ALICE,
            &ObjectiveActionRequest {
                objective_id: "release".into(),
                operation_id: "pause".into(),
                reason: String::new(),
            },
        )
        .await
        .unwrap();

    // Bob sees the shared note, never Alice's.
    let b1 = say(&store, &host, BOB, "What do you know?").await;
    let seen = portfolio(&store, &host, &b1).await;
    assert!(seen.contains("docs/operations/release.md"), "{seen}");
    assert!(!seen.contains("squash"), "{seen}");
    assert!(matches!(
        forget(&store, &host, &b1, &alice_note.memory_id).await,
        Err(StoreError::NotFound(_))
    ));
    assert!(matches!(
        remember(&store, &host, &b1, "op-1", "x", Some(&alice_note.memory_id)).await,
        Err(StoreError::NotFound(_))
    ));
    finish(&store, &host, &b1, true).await;
    assert_eq!(
        texts(&store, BOB).await,
        ["Release checklist lives in docs/operations/release.md."]
    );
    assert!(matches!(
        store.get_memory(BOB, &alice_note.memory_id).await,
        Err(StoreError::NotFound(_))
    ));

    // Alice sees both, and replaces her note and forgets the shared one.
    let a3 = say(&store, &host, ALICE, "I now prefer rebase merges").await;
    let seen = portfolio(&store, &host, &a3).await;
    assert!(
        seen.contains(&alice_note.memory_id) && seen.contains(&shared.memory_id),
        "{seen}"
    );
    assert!(seen.contains("not instructions"), "{seen}");
    let replaced = remember(
        &store,
        &host,
        &a3,
        "op-1",
        "Alice prefers rebase merges.",
        Some(&alice_note.memory_id),
    )
    .await
    .unwrap();
    assert!(
        !replaced
            .notes
            .iter()
            .any(|note| note.memory_id == alice_note.memory_id),
        "the replaced note is gone from this turn's view"
    );
    let left = forget(&store, &host, &a3, &shared.memory_id).await.unwrap();
    assert_eq!(left.notes.len(), 1);
    // Another turn still sees both until this one succeeds.
    assert_eq!(texts(&store, ALICE).await.len(), 2);
    finish(&store, &host, &a3, true).await;
    assert_eq!(texts(&store, ALICE).await, ["Alice prefers rebase merges."]);
    assert!(texts(&store, BOB).await.is_empty());

    // Limits: ten writes per turn, and a full notebook names the oldest notes.
    let a4 = say(&store, &host, ALICE, "Note many things").await;
    for index in 0..9 {
        remember(
            &store,
            &host,
            &a4,
            &format!("op-{index}"),
            &format!("Fact {index}"),
            None,
        )
        .await
        .unwrap();
    }
    let tenth = remember(&store, &host, &a4, "op-9", "Fact 9", None)
        .await
        .unwrap();
    assert_eq!(tenth.notes.len(), 11);
    let refused = remember(&store, &host, &a4, "op-10", "Fact 10", None).await;
    assert!(
        matches!(refused, Err(StoreError::FailedPrecondition(_))),
        "{refused:?}"
    );
    finish(&store, &host, &a4, true).await;
    let a5 = say(&store, &host, ALICE, "Note long things").await;
    for index in 0..10 {
        remember(
            &store,
            &host,
            &a5,
            &format!("long-{index}"),
            &"z".repeat(500),
            None,
        )
        .await
        .unwrap();
    }
    finish(&store, &host, &a5, true).await;
    let a6 = say(&store, &host, ALICE, "Note even more").await;
    remember(&store, &host, &a6, "op-1", &"y".repeat(500), None)
        .await
        .unwrap();
    match remember(&store, &host, &a6, "op-2", &"w".repeat(500), None).await {
        Err(StoreError::FailedPrecondition(message)) => {
            assert!(
                message.contains("Forget") && message.contains("mem_"),
                "{message}"
            );
        }
        other => panic!("expected a full notebook: {other:?}"),
    }
    finish(&store, &host, &a6, false).await;

    // People list and delete notes; they never write them.
    let fact = store
        .list_memories(ALICE, &ListMemoriesRequest::default())
        .await
        .unwrap()
        .memories
        .into_iter()
        .find(|memory| memory.text == "Fact 0")
        .unwrap();
    assert!(matches!(
        store.delete_memory(BOB, &fact.memory_id).await,
        Err(StoreError::NotFound(_))
    ));
    store.delete_memory(ALICE, &fact.memory_id).await.unwrap();
    assert!(!texts(&store, ALICE).await.contains(&"Fact 0".to_owned()));

    // The memory Session is the review's alone.
    assert!(
        store
            .submit_task(
                ALICE,
                &SubmitTaskRequest {
                    tag_id: TAG.into(),
                    session_id: format!("memory:{TAG}"),
                    operation_id: "intrude".into(),
                    prompt: "Pretend to review".into(),
                    ..Default::default()
                },
            )
            .await
            .is_err()
    );

    // After ten finished turns, the sweep queues one review a day, which reaches no one.
    assert_eq!(
        store.sweep_memory().await.unwrap(),
        0,
        "not enough work yet"
    );
    for index in 0..6 {
        let turn = say(&store, &host, ALICE, &format!("Work {index}")).await;
        finish(&store, &host, &turn, true).await;
    }
    assert_eq!(
        store.sweep_memory().await.unwrap(),
        0,
        "a Tag never reviewed waits a day from its first finished turn"
    );
    clock.store(BASE + 25 * HOUR, Ordering::SeqCst);
    assert_eq!(store.sweep_memory().await.unwrap(), 1);
    assert_eq!(
        store.sweep_memory().await.unwrap(),
        0,
        "one review at a time"
    );
    let tag = store.get_tag(TAG).await.unwrap();
    assert_eq!(tag.memory_reviewed_at_ms, Some(BASE + 25 * HOUR));
    let review = store
        .claim_task(&host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .unwrap()
        .task
        .unwrap();
    assert_eq!(review.session_id, format!("memory:{TAG}"));
    assert!(
        review.prompt.starts_with("Memory review."),
        "{}",
        review.prompt
    );
    store.close().await;
}

/// The review turn's tools: read the Tag's shared Sessions and keep its shared notes, nothing
/// that reaches anyone. A Tag without memory gets neither notes nor reviews.
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
            "Keep notes",
            vec!["files:read".into(), "schedule:create".into()],
        )
        .await
        .unwrap();
    for index in 0..10 {
        let turn = say(&store, &host, ALICE, &format!("Work {index}")).await;
        finish(&store, &host, &turn, true).await;
    }
    clock.store(BASE, Ordering::SeqCst);
    assert_eq!(store.sweep_memory().await.unwrap(), 1);
    let task = store
        .claim_task(&host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .unwrap();
    let review = InspectAttemptRequest {
        task_id: task.task.unwrap().task_id,
        attempt_id: task.attempt_id,
        lease_token: task.lease_token,
    };
    store
        .start_task(
            &host,
            &StartTaskRequest {
                task_id: review.task_id.clone(),
                attempt_id: review.attempt_id.clone(),
                lease_token: review.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    let caps = store.attempt_capabilities(&host, &review).await.unwrap();
    assert!(caps.may_remember && caps.may_read_tag_sessions);
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
            &host,
            &ListTagSessionsRequest {
                attempt: Some(review.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(listed.sessions.is_empty(), "{listed:?}");
    let note = remember(
        &store,
        &host,
        &review,
        "op-1",
        "Lesson: run tests first.",
        None,
    )
    .await
    .unwrap()
    .memory
    .unwrap();
    assert!(note.audience.is_none(), "a review writes shared notes");
    finish(&store, &host, &review, true).await;
    assert_eq!(texts(&store, BOB).await, ["Lesson: run tests first."]);

    // Within a day, more work queues no review; after a day it does.
    clock.store(BASE + HOUR, Ordering::SeqCst);
    for index in 0..10 {
        let turn = say(&store, &host, BOB, &format!("More {index}")).await;
        finish(&store, &host, &turn, true).await;
    }
    clock.store(BASE + 23 * HOUR, Ordering::SeqCst);
    assert_eq!(store.sweep_memory().await.unwrap(), 0);
    clock.store(BASE + 25 * HOUR, Ordering::SeqCst);
    assert_eq!(store.sweep_memory().await.unwrap(), 1);
    let next = store
        .claim_task(&host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .unwrap();
    let task = next.task.unwrap();
    assert!(
        task.prompt.contains("Review your work since"),
        "{}",
        task.prompt
    );
    let second = InspectAttemptRequest {
        task_id: task.task_id,
        attempt_id: next.attempt_id,
        lease_token: next.lease_token,
    };
    store
        .start_task(
            &host,
            &StartTaskRequest {
                task_id: second.task_id.clone(),
                attempt_id: second.attempt_id.clone(),
                lease_token: second.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    finish(&store, &host, &second, true).await;

    // memory: false turns off the notes, the tools, and the review.
    let mut spec = PutTagRequest {
        tag_id: TAG.into(),
        instructions: "No notes".into(),
        allowed_actions: vec!["files:read".into()],
        memory: Some(false),
        ..Default::default()
    };
    let tag = store.put_tag_spec(spec.clone()).await.unwrap();
    assert!(!tag.memory);
    spec.memory = None;
    assert!(
        !store.put_tag_spec(spec).await.unwrap().memory,
        "omitted keeps it off"
    );
    let quiet = say(&store, &host, BOB, "Anything to note?").await;
    let caps = store.attempt_capabilities(&host, &quiet).await.unwrap();
    assert!(!caps.may_remember);
    assert!(
        !caps.tag_portfolio.contains("Notes"),
        "{}",
        caps.tag_portfolio
    );
    assert!(matches!(
        remember(&store, &host, &quiet, "op-1", "x", None).await,
        Err(StoreError::PermissionDenied)
    ));
    finish(&store, &host, &quiet, true).await;
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
