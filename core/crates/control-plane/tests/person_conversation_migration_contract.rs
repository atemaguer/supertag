//! Upgrading a person's conversations with Tags to the one message model keeps every turn the
//! conversation showed, across all of its Sessions, in its old order: the person's messages, a
//! Schedule's fires and Work Session reports, which the Tag sends. The read mark, operation
//! receipts, and unprompted posts' places carry over, and the conversation takes a new ID.
use std::future::Future;

use sha2::{Digest, Sha256};
use sqlx::{AnyPool, Connection, Executor, Row};
use supertag_control_plane::Store;
use supertag_protocol::v2::*;
use uuid::Uuid;

/// The schema version just before `0118_person_conversations`.
const PRIOR: u32 = 117;
const ALICE: &str = "operator:alice";
const BOB: &str = "operator:bob";

/// The request digest `send_message` records for a message without limits or output policy.
fn digest(tag: &str, text: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(tag, text)).unwrap())
    )
}

async fn seed_prior_version(url: &str) {
    sqlx::any::install_default_drivers();
    let pool = AnyPool::connect(url).await.unwrap();
    let sqlite = url.starts_with("sqlite:");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("migrations")
        .join(if sqlite { "sqlite" } else { "postgresql" });
    let mut paths: Vec<_> = std::fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .get(..4)
                .and_then(|prefix| prefix.parse::<u32>().ok())
                .is_some_and(|version| version <= PRIOR)
        })
        .collect();
    paths.sort();
    assert_eq!(paths.len(), PRIOR as usize);
    let mut tx = pool.begin().await.unwrap();
    for path in paths {
        sqlx::raw_sql(&std::fs::read_to_string(path).unwrap())
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    // Alice wrote twice in Session a and once in Session b of her conversation; a Schedule fired
    // in a, and a Work Session started from her first message reported in a. She read up to the
    // Schedule's fire. Bob has his own conversation with the Tag.
    sqlx::raw_sql(&format!(
        "INSERT INTO supertag_v2_tags (tag_id,instructions,allowed_actions,revision)
         VALUES ('owner','x','[]',1);
         INSERT INTO supertag_v2_tasks (task_id,tag_id,session_id,prompt,instructions,allowed_actions,tag_revision,state,result,accepted_order,accepted_at_ms,completed_at_ms)
         VALUES ('t1','owner','conversation/a','First','x','[]',1,3,'Reply one',1,1000,1100),
                ('t2','owner','conversation/a','Fire','x','[]',1,3,'Scheduled news',3,2000,2100),
                ('t3','owner','conversation/b','Third','x','[]',1,3,'Reply three',5,3000,3100),
                ('child','owner','work/ws','Child','x','[]',1,3,'Done',6,3500,3600),
                ('t4','owner','conversation/a','Report','x','[]',1,3,'Reported',7,4000,4100),
                ('t5','owner','conversation/c','Bob','x','[]',1,3,'Hi Bob',8,5000,5100);
         INSERT INTO supertag_v2_conversation_sessions (session_id,principal,tag_id,created_order)
         VALUES ('conversation/a','{ALICE}','owner',1),
                ('conversation/b','{ALICE}','owner',4),
                ('conversation/c','{BOB}','owner',8);
         INSERT INTO supertag_v2_conversation_messages (task_id,session_id,principal,operation_id,request_digest,accepted_order)
         VALUES ('t1','conversation/a','{ALICE}','o1','{d1}',1),
                ('t2','conversation/a','{ALICE}','schedule/s/2000','',3),
                ('t3','conversation/b','{ALICE}','o3','{d3}',5),
                ('t5','conversation/c','{BOB}','o5','{d5}',8);
         INSERT INTO supertag_v2_schedules (schedule_id,tag_id,session_id,audience_principal,note,at_ms,state,created_by,created_at_ms,updated_at_ms)
         VALUES ('s','owner','conversation/a','{ALICE}','Check',2000,3,'{ALICE}',1,1);
         INSERT INTO supertag_v2_schedule_fires (schedule_id,due_at_ms,task_id,fired_at_ms)
         VALUES ('s',2000,'t2',2000);
         INSERT INTO supertag_v2_work_sessions (work_session_id,title,parent_tag_id,parent_session_id,starter_task_id,tag_id,latest_task_id,created_order)
         VALUES ('ws','Fix','owner','conversation/a','t1','owner','child',6);
         INSERT INTO supertag_v2_work_session_tasks (task_id,work_session_id,kind) VALUES ('child','ws',1),('t4','ws',2);
         INSERT INTO supertag_v2_proactive_posts (task_id,tag_id,session_id,conversation_order,posted_at_ms,quiet,audience,delivered_at_ms)
         VALUES ('t2','owner','conversation/a',3,2100,0,'conversation:{ALICE}',2100);
         INSERT INTO supertag_v2_conversation_reads (principal,tag_id,read_order,read_at_ms)
         VALUES ('{ALICE}','owner',3,2500);
         UPDATE supertag_v2_write_order SET revision=8 WHERE singleton=1;",
        d1 = digest("owner", "First"),
        d3 = digest("owner", "Third"),
        d5 = digest("owner", "Bob"),
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    pool.close().await;
}

async fn head(pool: &AnyPool) -> i64 {
    sqlx::query_scalar("SELECT head FROM supertag_v2_watch_state WHERE singleton=1")
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn contract(url: String) {
    seed_prior_version(&url).await;
    let pool = AnyPool::connect(&url).await.unwrap();
    let before = head(&pool).await;
    let store = Store::open(&url).await.unwrap();
    // The migration announces nothing.
    assert_eq!(head(&pool).await, before);

    // One direct conversation per person and Tag, with a new ID.
    let conversations: Vec<(String, String, i64)> = sqlx::query(
        "SELECT conversation_id,direct_key,next_seq FROM supertag_v2_conversations
         WHERE kind=1 ORDER BY direct_key",
    )
    .fetch_all(&pool)
    .await
    .unwrap()
    .iter()
    .map(|row| {
        (
            row.get("conversation_id"),
            row.get("direct_key"),
            row.get("next_seq"),
        )
    })
    .collect();
    assert_eq!(conversations.len(), 2, "{conversations:?}");
    assert!(
        conversations
            .iter()
            .all(|(id, ..)| id.starts_with("direct/"))
    );
    assert_eq!(conversations[0].1, format!("p:{ALICE}\nt:owner"));
    assert_eq!(conversations[0].2, 5);
    assert_eq!(conversations[1].1, format!("p:{BOB}\nt:owner"));
    assert_eq!(conversations[1].2, 2);
    let alice = conversations[0].0.clone();

    // Every turn, in the order the conversation showed it; the Tag sends fires and reports.
    let messages: Vec<(i64, String, i64, String, String, i64)> = sqlx::query(
        "SELECT seq,task_id,sender_kind,sender_id,text,created_at_ms FROM supertag_v2_messages
         WHERE conversation_id=$1 ORDER BY seq",
    )
    .bind(&alice)
    .fetch_all(&pool)
    .await
    .unwrap()
    .iter()
    .map(|row| {
        (
            row.get("seq"),
            row.get("task_id"),
            row.get("sender_kind"),
            row.get("sender_id"),
            row.get("text"),
            row.get("created_at_ms"),
        )
    })
    .collect();
    assert_eq!(
        messages,
        [
            (1, "t1".into(), 2, ALICE.into(), String::new(), 1000),
            (2, "t2".into(), 1, "owner".into(), String::new(), 2000),
            (3, "t3".into(), 2, ALICE.into(), String::new(), 3000),
            (4, "t4".into(), 1, "owner".into(), String::new(), 4000),
        ]
    );

    // Members: Alice read through the fire; the Tag has seen every turn.
    let members: Vec<(i64, String, i64, i64, Option<i64>)> = sqlx::query(
        "SELECT member_kind,member_id,read_seq,delivered_seq,read_at_ms
         FROM supertag_v2_conversation_members WHERE conversation_id=$1 ORDER BY member_kind",
    )
    .bind(&alice)
    .fetch_all(&pool)
    .await
    .unwrap()
    .iter()
    .map(|row| {
        (
            row.get("member_kind"),
            row.get("member_id"),
            row.get("read_seq"),
            row.get("delivered_seq"),
            row.get("read_at_ms"),
        )
    })
    .collect();
    assert_eq!(
        members,
        [
            (1, "owner".into(), 4, 4, None),
            (2, ALICE.into(), 2, 0, Some(2500)),
        ]
    );
    // Each Session names its conversation, and the fire's post its new place.
    let sessions: Vec<(String, String)> = sqlx::query(
        "SELECT session_id,conversation_id FROM supertag_v2_conversation_sessions
         ORDER BY created_order",
    )
    .fetch_all(&pool)
    .await
    .unwrap()
    .iter()
    .map(|row| (row.get("session_id"), row.get("conversation_id")))
    .collect();
    assert_eq!(sessions[0], ("conversation/a".into(), alice.clone()));
    assert_eq!(sessions[1], ("conversation/b".into(), alice.clone()));
    assert_eq!(sessions[2].1, conversations[1].0);
    let post: Option<i64> = sqlx::query_scalar(
        "SELECT conversation_seq FROM supertag_v2_proactive_posts WHERE task_id='t2'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(post, Some(2));
    let receipts: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_message_operations WHERE scope=3")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(receipts, 4);

    // The conversation reads as before, numbered by its own seq.
    let page = store
        .list_messages(
            ALICE,
            &ListMessagesRequest {
                tag_id: "owner".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(page.conversation_id, alice);
    let shown: Vec<_> = page
        .messages
        .iter()
        .map(|message| {
            (
                message.task.as_ref().unwrap().task_id.as_str(),
                message.order,
            )
        })
        .collect();
    assert_eq!(shown, [("t4", 4), ("t3", 3), ("t2", 2), ("t1", 1)]);
    assert_eq!(
        page.messages[0].work_session_report_id.as_deref(),
        Some("ws")
    );
    assert_eq!(page.messages[2].schedule_id.as_deref(), Some("s"));
    assert_eq!(page.messages[3].sent_at_ms, 1000);
    // A copy from before the upgrade is replaced, since the conversation's ID changed.
    let replaced = store
        .list_messages(
            ALICE,
            &ListMessagesRequest {
                tag_id: "owner".into(),
                after: 5,
                conversation_id: "conversation/a".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(!replaced.incremental);
    assert_eq!(replaced.messages.len(), 4);

    // The list counts what Alice has not read: Session b's reply and the report.
    let listed = store
        .list_conversations(ALICE, &ListConversationsRequest {})
        .await
        .unwrap();
    assert_eq!(listed.conversations.len(), 1);
    let conversation = &listed.conversations[0];
    assert_eq!(conversation.conversation_id, alice);
    assert_eq!(conversation.latest_order, 4);
    assert_eq!(conversation.read_order, 2);
    assert_eq!(conversation.unread_count, 2);
    assert_eq!(
        conversation.latest_work_session_report_id.as_deref(),
        Some("ws")
    );
    assert!(!conversation.working);

    // A replayed send returns its message; another text under the operation is refused.
    let replay = store
        .send_message(
            ALICE,
            &SendMessageRequest {
                tag_id: "owner".into(),
                text: "First".into(),
                operation_id: "o1".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(replay.task.unwrap().task_id, "t1");
    assert_eq!(replay.order, 1);
    assert!(
        store
            .send_message(
                ALICE,
                &SendMessageRequest {
                    tag_id: "owner".into(),
                    text: "Changed".into(),
                    operation_id: "o3".into(),
                    ..Default::default()
                },
            )
            .await
            .is_err()
    );

    // Reading moves the mark and tells Alice's other clients.
    let mark = head(&pool).await;
    let read = store
        .mark_conversation_read(
            ALICE,
            &MarkConversationReadRequest {
                tag_id: "owner".into(),
                order: 4,
            },
        )
        .await
        .unwrap();
    assert_eq!(read.read_order, 4);
    assert_eq!(read.unread_count, 0);
    let notices: Vec<(i64, i64, String, String)> = sqlx::query(
        "SELECT kind,reason,tag_id,owner FROM supertag_v2_watch_notices WHERE position>$1
         ORDER BY position",
    )
    .bind(mark)
    .fetch_all(&pool)
    .await
    .unwrap()
    .iter()
    .map(|row| {
        (
            row.get("kind"),
            row.get("reason"),
            row.get("tag_id"),
            row.get("owner"),
        )
    })
    .collect();
    assert_eq!(notices, [(3, 2, "owner".into(), ALICE.into())]);

    // A new message continues the conversation after its newest turn, and is announced.
    let mark = head(&pool).await;
    let next = store
        .send_message(
            ALICE,
            &SendMessageRequest {
                tag_id: "owner".into(),
                text: "After the upgrade".into(),
                operation_id: "after".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(next.order, 5);
    let next_task = next.task.unwrap();
    assert_eq!(next_task.session_id, "conversation/a");
    let announced: Vec<(i64, String)> = sqlx::query(
        "SELECT kind,owner FROM supertag_v2_watch_notices WHERE position>$1 AND resource_id=$2
         ORDER BY position",
    )
    .bind(mark)
    .bind(&next_task.task_id)
    .fetch_all(&pool)
    .await
    .unwrap()
    .iter()
    .map(|row| (row.get("kind"), row.get("owner")))
    .collect();
    assert_eq!(announced, [(2, ALICE.into()), (3, ALICE.into())]);
    let listed = store
        .list_conversations(ALICE, &ListConversationsRequest {})
        .await
        .unwrap();
    assert_eq!(listed.conversations[0].preview, "After the upgrade");
    assert!(listed.conversations[0].working);

    // Bob's conversation is his own.
    let bobs = store
        .list_messages(
            BOB,
            &ListMessagesRequest {
                tag_id: "owner".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(bobs.messages.len(), 1);
    assert_eq!(bobs.messages[0].order, 1);
    assert!(store.get_message(BOB, "owner", "t1").await.is_err());
    pool.close().await;
    store.close().await;
}

#[tokio::test]
async fn sqlite_person_conversation_migration() {
    let dir = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("state.db").display()
    ))
    .await;
}

async fn on_postgres<F: Future<Output = ()> + 'static>(run: impl FnOnce(String) -> F) {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("dedicated PostgreSQL URL file is required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!(
        "supertag_rust_person_conversation_migration_{}",
        Uuid::new_v4().simple()
    );
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    url.set_path(&name);
    let outcome = tokio::task::LocalSet::new()
        .run_until(async move { tokio::task::spawn_local(run(url.to_string())).await })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL person conversation migration contract failed");
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_person_conversation_migration() {
    on_postgres(contract).await;
}
