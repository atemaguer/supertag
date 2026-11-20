//! The input queue's store contract on both databases: inputs keep their Session's order, a
//! source admits one input, a run binds only what shares its requester and audience, and an inbox
//! turn binds Tag messages from several Tags.
use sqlx::{Connection, Executor};
use supertag_protocol::v2::*;
use uuid::Uuid;

use super::*;
use crate::{
    Store,
    messages::{self, Member, NewMessage, wakes},
    store::{increment_order, insert_task, task_in},
};

const ALICE: &str = "operator:alice";

#[tokio::test]
async fn sqlite_session_input_contract() {
    let directory = tempfile::tempdir().unwrap();
    contract(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("inputs.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_session_input_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("dedicated PostgreSQL URL file is required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_rust_session_inputs_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let url = url.to_string();
    let outcome = tokio::task::LocalSet::new()
        .run_until(
            async move { tokio::task::spawn_local(async move { contract(&url).await }).await },
        )
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL session input contract failed");
}

fn submit(session: &str, operation: &str) -> SubmitTaskRequest {
    SubmitTaskRequest {
        tag_id: "alpha".into(),
        session_id: session.into(),
        operation_id: operation.into(),
        prompt: format!("Work for {operation}"),
        ..Default::default()
    }
}

async fn contract(url: &str) {
    let store = Store::open(url).await.unwrap();
    for tag in ["alpha", "beta", "gamma"] {
        store.put_tag(tag, "Coordinate", vec![]).await.unwrap();
    }
    order(&store).await;
    idempotency(&store).await;
    binding(&store).await;
    inbox(&store).await;
}

/// Inputs of a Session keep its order, whatever else is admitted in between.
async fn order(store: &Store) {
    let mut ops = Vec::new();
    for (session, operation) in [
        ("ops", "o1"),
        ("other", "x1"),
        ("ops", "o2"),
        ("other", "x2"),
        ("ops", "o3"),
    ] {
        let task = store
            .submit_task(ALICE, &submit(session, operation))
            .await
            .unwrap();
        if session == "ops" {
            ops.push(task.task_id);
        }
    }
    let (mut tx, _) = store.write().await.unwrap();
    let rows: Vec<(String, i64, i64, String, String)> = sqlx::query_as(
        "SELECT i.admitted_task_id,i.position,t.accepted_order,i.source_key,i.requester
         FROM supertag_v2_session_inputs i JOIN supertag_v2_tasks t ON t.task_id=i.admitted_task_id
         WHERE i.tag_id='alpha' AND i.session_id='ops' AND i.task_id IS NULL ORDER BY i.position",
    )
    .fetch_all(&mut *tx)
    .await
    .unwrap();
    assert_eq!(
        rows.iter().map(|row| row.0.clone()).collect::<Vec<_>>(),
        ops,
        "a Session's inputs wait in the order they were admitted"
    );
    for (_, position, accepted_order, key, requester) in &rows {
        assert_eq!(position, accepted_order);
        assert!(key.starts_with("request\noperator:alice\no"), "{key}");
        assert_eq!(requester, ALICE);
    }
    let own = own_in(&mut tx, &ops[0]).await.unwrap().unwrap();
    assert_eq!(own.kind, InputKind::Request);
    assert_eq!(own.task_id, None);
    tx.rollback().await.unwrap();
}

/// A source admits one input: a replay admits nothing, and another Task cannot reuse the key.
async fn idempotency(store: &Store) {
    let first = store
        .submit_task(ALICE, &submit("idem", "i1"))
        .await
        .unwrap();
    let replay = store
        .submit_task(ALICE, &submit("idem", "i1"))
        .await
        .unwrap();
    assert_eq!(first.task_id, replay.task_id);
    let (mut tx, _) = store.write().await.unwrap();
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM supertag_v2_session_inputs WHERE session_id='idem'",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(count, 1);
    let key = key(&["request", ALICE, "i1"]);
    let found = by_key_in(&mut tx, &key).await.unwrap().unwrap();
    assert_eq!(
        found.admitted_task_id.as_deref(),
        Some(first.task_id.as_str())
    );
    // The same source for the same Task answers with its input.
    let again = admit_in(
        &mut tx,
        &first,
        NewInput {
            kind: InputKind::Request,
            source_key: key.clone(),
            requester: ALICE,
            audience: "",
        },
        1,
    )
    .await
    .unwrap();
    assert_eq!(again, found);
    // The same source for another Task fails loudly instead of duplicating.
    let order = increment_order(&mut tx).await.unwrap();
    let other = insert_task(&mut tx, order, "alpha", "idem", "Other")
        .await
        .unwrap();
    assert!(matches!(
        admit_in(
            &mut tx,
            &other,
            NewInput {
                kind: InputKind::Request,
                source_key: key,
                requester: ALICE,
                audience: "",
            },
            1,
        )
        .await,
        Err(StoreError::Conflict(_))
    ));
    tx.rollback().await.unwrap();
}

async fn person_task(
    tx: &mut Transaction<'_, Any>,
    text: &str,
    requester: &str,
    audience: &str,
) -> Task {
    let order = increment_order(tx).await.unwrap();
    let task = insert_task(tx, order, "alpha", "thread", text)
        .await
        .unwrap();
    admit_in(
        tx,
        &task,
        NewInput {
            kind: InputKind::Person,
            source_key: key(&["surface", requester, &task.task_id]),
            requester,
            audience,
        },
        2_000,
    )
    .await
    .unwrap();
    task
}

/// A run binds only the inputs that share its requester and reply audience. The first one that
/// does not ends the run of joined messages; it and the ones after it wait for their own turns.
async fn binding(store: &Store) {
    let (mut tx, _) = store.write().await.unwrap();
    let head = person_task(&mut tx, "first", "connector:a", "").await;
    let same = person_task(&mut tx, "second", "connector:a", "").await;
    let other = person_task(&mut tx, "from b", "connector:b", "").await;
    let later = person_task(&mut tx, "third", "connector:a", "").await;
    let shown = person_task(&mut tx, "shown", "connector:a", ALICE).await;
    let row = |task: &Task| task.task_id.clone();
    let (head_row, same_row, other_row, shown_row) = (
        own_in(&mut tx, &row(&head)).await.unwrap().unwrap(),
        own_in(&mut tx, &row(&same)).await.unwrap().unwrap(),
        own_in(&mut tx, &row(&other)).await.unwrap().unwrap(),
        own_in(&mut tx, &row(&shown)).await.unwrap().unwrap(),
    );
    assert!(shares_with(&head_row, &same_row));
    assert!(!shares_with(&head_row, &other_row), "another requester");
    assert!(!shares_with(&head_row, &shown_row), "another audience");
    assert_eq!(
        requester_of_in(&mut tx, &head.task_id).await.unwrap(),
        ("connector:a".to_owned(), String::new())
    );

    // The head's first claim binds its own input and joins the next message from the same
    // requester; the one from another requester ends the run.
    sqlx::query("UPDATE supertag_v2_tasks SET state=$1,attempt_id='attempt-1' WHERE task_id=$2")
        .bind(TaskState::Claimed as i64)
        .bind(&head.task_id)
        .execute(&mut *tx)
        .await
        .unwrap();
    bind_own_in(&mut tx, &head.task_id, 3_000).await.unwrap();
    let head = task_in(&mut tx, &head.task_id).await.unwrap();
    let joined = crate::inputs::join_at_claim_in(&mut tx, &head, "attempt-1", 3_000)
        .await
        .unwrap();
    assert_eq!(
        joined
            .iter()
            .map(|m| m.task_id.as_str())
            .collect::<Vec<_>>(),
        [same.task_id.as_str()]
    );
    let bound = bound_in(&mut tx, &head.task_id).await.unwrap();
    assert_eq!(
        bound
            .iter()
            .map(|input| (
                input.admitted_task_id.clone().unwrap(),
                input.bound_at_claim
            ))
            .collect::<Vec<_>>(),
        [(head.task_id.clone(), false), (same.task_id.clone(), true)]
    );
    assert_eq!(
        bound[1].offer_state,
        Some(LiveInputState::Accepted as i64),
        "a joined message reads as live input its run accepted"
    );
    for waiting in [&other, &later, &shown] {
        let own = own_in(&mut tx, &waiting.task_id).await.unwrap().unwrap();
        assert_eq!(
            own.task_id, None,
            "{} waits for its own turn",
            waiting.prompt
        );
        assert_eq!(
            task_in(&mut tx, &waiting.task_id).await.unwrap().state(),
            TaskState::Queued
        );
    }
    assert_eq!(
        task_in(&mut tx, &same.task_id).await.unwrap().state(),
        TaskState::Succeeded
    );
    // Every Attempt of the run is given the same joined message.
    let replayed = replayed_in(&mut tx, &head.task_id, "attempt-2")
        .await
        .unwrap();
    assert_eq!(replayed, joined);
    tx.rollback().await.unwrap();
}

/// An inbox turn is the exception: it binds Tag messages from several Tags. A held message waits
/// for that turn without making one, and is bound after the due ones.
async fn inbox(store: &Store) {
    let (mut tx, _) = store.write().await.unwrap();
    let beta = vec!["beta".to_owned()];
    let mut conversations = Vec::new();
    for sender in ["alpha", "gamma"] {
        let conversation = messages::direct_conversation_in(
            &mut tx,
            Member::Tag(sender),
            Member::Tag("beta"),
            1_000,
        )
        .await
        .unwrap();
        let text = format!("From {sender}");
        let message = messages::insert_message_in(
            &mut tx,
            &NewMessage {
                conversation_id: &conversation,
                sender: Member::Tag(sender),
                kind: MessageKind::Note,
                text: &text,
                hops: 0,
                source_task_id: None,
                origin_task_id: None,
                objective_id: None,
                task_id: None,
                effect_digest: None,
                addressees: &beta,
                now: 1_000,
            },
        )
        .await
        .unwrap();
        let outcome = wakes::wake_in(
            &mut tx,
            &wakes::WakeRequest {
                tag_id: "beta",
                conversation_id: &conversation,
                message_kind: MessageKind::Note,
                sender_tag_id: sender,
                seq: message.seq,
                hops: 0,
                origin_task_id: None,
                objective_id: None,
                team_id: None,
                now: 10_000,
            },
        )
        .await
        .unwrap();
        assert!(outcome.woke);
        conversations.push(conversation);
    }
    // A held message for `gamma`: no due time, so it makes no turn.
    let held = messages::direct_conversation_in(
        &mut tx,
        Member::Tag("alpha"),
        Member::Tag("gamma"),
        1_000,
    )
    .await
    .unwrap();
    let gamma = vec!["gamma".to_owned()];
    let message = messages::insert_message_in(
        &mut tx,
        &NewMessage {
            conversation_id: &held,
            sender: Member::Tag("alpha"),
            kind: MessageKind::Note,
            text: "Held",
            hops: 0,
            source_task_id: None,
            origin_task_id: None,
            objective_id: None,
            task_id: None,
            effect_digest: None,
            addressees: &gamma,
            now: 1_000,
        },
    )
    .await
    .unwrap();
    let position = increment_order(&mut tx).await.unwrap();
    sqlx::query(
        "INSERT INTO supertag_v2_session_inputs
            (input_id,tag_id,session_id,position,kind,source_key,requester,audience,
             conversation_id,reasons,priority,first_seq,last_seq,hops,created_at_ms)
         VALUES ('held-gamma','gamma','inbox:gamma',$1,4,'wake\nheld-gamma','tag:alpha','',
                 $2,1,1,$3,$3,0,1000)",
    )
    .bind(position)
    .bind(&held)
    .bind(message.seq)
    .execute(&mut *tx)
    .await
    .unwrap();
    assert_eq!(
        wakes::due_recipients_in(&mut tx, 20_000, 10).await.unwrap(),
        ["beta"],
        "a held message makes no turn"
    );

    // One inbox turn reserves both Tags' messages and binds them when it starts.
    crate::mailbox::sweep_in(&mut tx, 20_000).await.unwrap();
    let reserved: Vec<(String, String)> = sqlx::query_as(
        "SELECT admitted_task_id,requester FROM supertag_v2_session_inputs
         WHERE tag_id='beta' AND kind=4 ORDER BY requester",
    )
    .fetch_all(&mut *tx)
    .await
    .unwrap();
    assert_eq!(reserved.len(), 2);
    assert_eq!(reserved[0].0, reserved[1].0, "one inbox Task reserved both");
    assert_eq!(
        reserved.iter().map(|r| r.1.as_str()).collect::<Vec<_>>(),
        ["tag:alpha", "tag:gamma"]
    );
    let turn = reserved[0].0.clone();
    assert!(
        wakes::due_recipients_in(&mut tx, 20_000, 10)
            .await
            .unwrap()
            .is_empty(),
        "a waiting inbox Task gets no second one"
    );
    crate::mailbox::started_in(&mut tx, &turn, 20_000)
        .await
        .unwrap();
    let bound = bound_in(&mut tx, &turn).await.unwrap();
    assert_eq!(
        bound
            .iter()
            .map(|input| input.requester.as_str())
            .collect::<Vec<_>>(),
        ["tag:alpha", "tag:gamma"],
        "the inbox turn binds messages from several Tags"
    );
    let prompt = task_in(&mut tx, &turn).await.unwrap().prompt;
    assert!(prompt.contains("From alpha") && prompt.contains("From gamma"));
    // A second start binds nothing new.
    crate::mailbox::started_in(&mut tx, &turn, 21_000)
        .await
        .unwrap();
    assert_eq!(bound_in(&mut tx, &turn).await.unwrap(), bound);

    // `gamma`'s next inbox turn, started by a due message, binds the held one after it.
    let gamma_from_beta =
        messages::direct_conversation_in(&mut tx, Member::Tag("beta"), Member::Tag("gamma"), 1_000)
            .await
            .unwrap();
    let due = messages::insert_message_in(
        &mut tx,
        &NewMessage {
            conversation_id: &gamma_from_beta,
            sender: Member::Tag("beta"),
            kind: MessageKind::Question,
            text: "Due",
            hops: 0,
            source_task_id: None,
            origin_task_id: None,
            objective_id: None,
            task_id: None,
            effect_digest: None,
            addressees: &gamma,
            now: 1_000,
        },
    )
    .await
    .unwrap();
    wakes::wake_in(
        &mut tx,
        &wakes::WakeRequest {
            tag_id: "gamma",
            conversation_id: &gamma_from_beta,
            message_kind: MessageKind::Question,
            sender_tag_id: "beta",
            seq: due.seq,
            hops: 0,
            origin_task_id: None,
            objective_id: None,
            team_id: None,
            now: 30_000,
        },
    )
    .await
    .unwrap();
    crate::mailbox::sweep_in(&mut tx, 40_000).await.unwrap();
    let gamma_turn: String = sqlx::query_scalar(
        "SELECT admitted_task_id FROM supertag_v2_session_inputs
         WHERE tag_id='gamma' AND conversation_id=$1",
    )
    .bind(&gamma_from_beta)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    crate::mailbox::started_in(&mut tx, &gamma_turn, 40_000)
        .await
        .unwrap();
    let bound = bound_in(&mut tx, &gamma_turn).await.unwrap();
    assert_eq!(bound.len(), 2);
    assert!(bound.iter().any(|input| input.input_id == "held-gamma"));
    let prompt = task_in(&mut tx, &gamma_turn).await.unwrap().prompt;
    let (due_at, held_at) = (prompt.find("Due").unwrap(), prompt.find("Held").unwrap());
    assert!(due_at < held_at, "the due message first, then the held one");
    tx.rollback().await.unwrap();
}
