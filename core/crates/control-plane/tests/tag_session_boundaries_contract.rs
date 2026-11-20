//! Only a Tag's inbox Session reaches other Tags. An Objective's Session has no `send_message`,
//! Mailbox, or Workstream, and nothing about other Tags reaches its instructions; it asks its own
//! Tag's inbox Session with `ask_tag`. The ask wakes the inbox Session, whose answer to the
//! Objective runs as the Objective's next turn, and a turn that asked waits for it instead of
//! being woken as idle. The inbox Session and person conversations keep messaging other Tags.
mod support;

use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sqlx::{Connection, Executor};
use supertag_control_plane::{AttemptAccess, HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:boundaries";
const NOW: i64 = 1_900_000_000_000;

async fn open(url: &str, clock: &Arc<AtomicI64>) -> Store {
    let clock = clock.clone();
    Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || clock.load(Ordering::SeqCst))
}

/// Claims and starts the next Task, which must be in `session`.
async fn start(
    store: &Store,
    host: &HostAuthority,
    session: &str,
) -> (Task, InspectAttemptRequest) {
    let assignment = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .expect("a Task waits");
    let task = assignment.task.unwrap();
    assert_eq!(task.session_id, session, "{}", task.prompt);
    let attempt = InspectAttemptRequest {
        task_id: task.task_id.clone(),
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
    let task = store.get_task(&task.task_id).await.unwrap();
    (task, attempt)
}

async fn finish(store: &Store, host: &HostAuthority, attempt: &InspectAttemptRequest) {
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                result: "Done for now".into(),
                succeeded: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

fn message(operation: &str, to: &str, text: &str) -> SendAttemptTagMessageRequest {
    SendAttemptTagMessageRequest {
        operation_id: operation.into(),
        recipient_tag_id: to.into(),
        text: text.into(),
        ..Default::default()
    }
}

fn answer(operation: &str, objective: &str, text: &str) -> SendAttemptTagMessageRequest {
    SendAttemptTagMessageRequest {
        operation_id: operation.into(),
        recipient_objective_id: objective.into(),
        text: text.into(),
        ..Default::default()
    }
}

async fn contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let store = open(url, &clock).await;
    let host = support::register_host(&store, "boundaries").await;
    for tag in ["lead", "helper"] {
        store
            .put_tag(
                tag,
                "Do the work",
                vec!["mailbox:send".into(), "workstream:post".into()],
            )
            .await
            .unwrap();
    }
    store
        .create_team(
            OPERATOR,
            &CreateTeamRequest {
                operation_id: "crew".into(),
                team_id: "crew".into(),
                name: "crew".into(),
                member_tag_ids: vec!["helper".into(), "lead".into()],
                wake_limits: None,
            },
        )
        .await
        .unwrap();
    let objective = store
        .create_objective(
            OPERATOR,
            &CreateObjectiveRequest {
                operation_id: "goal".into(),
                objective_id: "goal".into(),
                owner_tag_id: "lead".into(),
                outcome: "Ship the exporter".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();

    // The Objective's own turn reaches no other Tag, and its instructions name none.
    let (turn, first) = start(&store, &host, &objective.session_id).await;
    let access = AttemptAccess::new(&host, &first);
    let capabilities = store.attempt_capabilities(&access).await.unwrap();
    assert!(capabilities.may_ask_tag);
    assert!(capabilities.may_start_work_session);
    assert!(capabilities.may_ask_objective_question);
    assert!(!capabilities.may_send_tag_message);
    assert!(!capabilities.may_read_mailbox);
    assert!(!capabilities.may_use_workstream);
    assert!(!capabilities.may_request_commit_review);
    for context in [
        &capabilities.tag_portfolio,
        &turn.prompt,
        &turn.instructions,
    ] {
        assert!(!context.contains("helper"), "{context}");
        assert!(!context.contains("crew"), "{context}");
    }
    assert!(capabilities.tag_portfolio.contains("ask_tag"));
    assert!(matches!(
        store
            .send_attempt_tag_message(&access, &message("direct", "helper", "Review this"))
            .await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store
            .read_attempt_mailbox(&access, &ReadMailboxRequest::default())
            .await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store
            .post_attempt_workstream(
                &access,
                &PostAttemptWorkstreamRequest {
                    operation_id: "post".into(),
                    body: "Progress".into(),
                    to_tag_ids: vec![],
                },
            )
            .await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store
            .read_attempt_workstream(&access, &ReadAttemptWorkstreamRequest::default())
            .await,
        Err(StoreError::PermissionDenied)
    ));
    // Only the inbox Session answers an Objective.
    assert!(matches!(
        store
            .send_attempt_tag_message(&access, &answer("self", "goal", "Answering myself"))
            .await,
        Err(StoreError::PermissionDenied)
    ));

    // It asks its own Tag instead. Asking does not end the turn, and a replay is the same ask.
    let ask = AskAttemptTagRequest {
        operation_id: "ask".into(),
        text: "Have helper review the exporter's schema".into(),
    };
    let asked = store.ask_attempt_tag(&access, &ask).await.unwrap();
    assert!(!asked.duplicate);
    let replay = store.ask_attempt_tag(&access, &ask).await.unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.message_id, asked.message_id);
    assert!(matches!(
        store
            .ask_attempt_tag(
                &access,
                &AskAttemptTagRequest {
                    text: "Something else".into(),
                    ..ask.clone()
                },
            )
            .await,
        Err(StoreError::Conflict(_))
    ));
    // The turn ends with nothing running: it waits for the answer and is not woken as idle.
    finish(&store, &host, &first).await;
    let waiting = store.get_objective(OPERATOR, "goal").await.unwrap();
    assert_eq!(waiting.idle_since_ms, None);
    assert_eq!(waiting.status(), ObjectiveStatus::Working);

    // After the debounce the ask wakes the inbox Session, which sees which Objective asked.
    clock.fetch_add(5_000, Ordering::SeqCst);
    store.sweep_mailbox().await.unwrap();
    let (inbox, inbox_attempt) = start(&store, &host, "inbox:lead").await;
    assert!(
        inbox
            .prompt
            .contains("<objective-message objective=\"goal\""),
        "{}",
        inbox.prompt
    );
    assert!(
        inbox
            .prompt
            .contains("Have helper review the exporter's schema")
    );
    let inbox_access = AttemptAccess::new(&host, &inbox_attempt);
    let inbox_capabilities = store.attempt_capabilities(&inbox_access).await.unwrap();
    assert!(inbox_capabilities.may_send_tag_message);
    assert!(inbox_capabilities.may_read_mailbox);
    assert!(inbox_capabilities.may_use_workstream);
    assert!(!inbox_capabilities.may_ask_tag);
    // The inbox Session still reaches other Tags.
    let sent = store
        .send_attempt_tag_message(
            &inbox_access,
            &message("to-helper", "helper", "Please review the schema"),
        )
        .await
        .unwrap();
    assert_eq!(sent.message.unwrap().recipient_tag_id, "helper");
    // It answers the Objective: the answer names the Objective and no recipient Tag.
    let answered = store
        .send_attempt_tag_message(
            &inbox_access,
            &answer("answer", "goal", "Helper approved it"),
        )
        .await
        .unwrap();
    let answer_message = answered.message.unwrap();
    assert_eq!(answer_message.recipient_tag_id, "");
    assert_eq!(answer_message.objective_id.as_deref(), Some("goal"));
    assert_eq!(answer_message.sender_tag_id, "lead");
    assert!(answer_message.task_id.is_some());
    let replayed = store
        .send_attempt_tag_message(
            &inbox_access,
            &answer("answer", "goal", "Helper approved it"),
        )
        .await
        .unwrap();
    assert!(replayed.duplicate);
    // Nothing else waits for an answer, and another Tag's Objective is not this inbox's to answer.
    assert!(matches!(
        store
            .send_attempt_tag_message(&inbox_access, &answer("again", "goal", "More"))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert!(matches!(
        store
            .send_attempt_tag_message(&inbox_access, &answer("missing", "absent", "Hello"))
            .await,
        Err(StoreError::NotFound(_))
    ));
    finish(&store, &host, &inbox_attempt).await;

    // The answer runs as the Objective's next turn.
    let (next, next_attempt) = start(&store, &host, &objective.session_id).await;
    assert!(next.prompt.contains("<tag-answer>"), "{}", next.prompt);
    assert!(
        next.prompt.contains("Helper approved it"),
        "{}",
        next.prompt
    );
    assert_eq!(Some(next.task_id.clone()), answer_message.task_id);
    // It never reads the inbox Session, where the messages to other Tags are.
    let next_access = AttemptAccess::new(&host, &next_attempt);
    assert!(
        store
            .read_tag_session(
                &next_access,
                &ReadTagSessionRequest {
                    session_id: "inbox:lead".into(),
                    limit: 10,
                    before: None,
                },
            )
            .await
            .is_err()
    );
    let hits = store
        .search_tag_sessions(
            &next_access,
            &SearchTagSessionsRequest {
                query: "schema".into(),
                limit: 0,
            },
        )
        .await
        .unwrap()
        .matches;
    assert!(
        hits.iter().all(|hit| !hit.session_id.starts_with("inbox:")),
        "{hits:?}"
    );
    finish(&store, &host, &next_attempt).await;
    // With the answer in and nothing asked, the next quiet turn is idle again.
    let idle = store.get_objective(OPERATOR, "goal").await.unwrap();
    assert!(idle.idle_since_ms.is_some());
    let (idle_turn, idle_attempt) = start(&store, &host, &objective.session_id).await;
    assert!(
        idle_turn
            .prompt
            .contains("nothing running and nothing asked")
    );
    finish(&store, &host, &idle_attempt).await;

    // A person's turn outside any Objective keeps reaching other Tags.
    let person = store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                operation_id: "person".into(),
                tag_id: "lead".into(),
                session_id: "ops".into(),
                prompt: "Tell helper the release moved".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let (_, person_attempt) = start(&store, &host, &person.session_id).await;
    let person_access = AttemptAccess::new(&host, &person_attempt);
    let person_capabilities = store.attempt_capabilities(&person_access).await.unwrap();
    assert!(person_capabilities.may_send_tag_message);
    assert!(person_capabilities.may_read_mailbox);
    assert!(!person_capabilities.may_ask_tag);
    store
        .send_attempt_tag_message(
            &person_access,
            &message("person-note", "helper", "The release moved"),
        )
        .await
        .unwrap();
    assert!(matches!(
        store
            .ask_attempt_tag(
                &person_access,
                &AskAttemptTagRequest {
                    operation_id: "person-ask".into(),
                    text: "Not an Objective".into(),
                },
            )
            .await,
        Err(StoreError::PermissionDenied)
    ));
    finish(&store, &host, &person_attempt).await;
    store.close().await;
}

#[tokio::test]
async fn sqlite_tag_session_boundaries() {
    let dir = tempfile::tempdir().unwrap();
    contract(&format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("boundaries.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires dedicated PostgreSQL"]
async fn postgres_tag_session_boundaries() {
    let admin_url = std::fs::read_to_string(
        std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("URL file"),
    )
    .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let db = format!("supertag_boundaries_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {db}").as_str())
        .await
        .unwrap();
    url.set_path(&db);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { contract(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {db} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    result.unwrap();
}
