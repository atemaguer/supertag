//! Upgrading to one conversation per principal and Tag keeps every message: a principal's named
//! conversations with a Tag become Sessions of one conversation, which continues the Session
//! its latest message is in.
use std::future::Future;

use sqlx::{Connection, Executor};
use supertag_control_plane::Store;
use supertag_protocol::v2::*;
use uuid::Uuid;

/// The schema version just before `0083_one_conversation_per_tag`.
const PRIOR: u32 = 82;
const ALICE: &str = "operator:alice";

async fn seed_prior_version(url: &str) {
    sqlx::any::install_default_drivers();
    let pool = sqlx::AnyPool::connect(url).await.unwrap();
    let backend = if url.starts_with("sqlite:") {
        "sqlite"
    } else {
        "postgresql"
    };
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("migrations")
        .join(backend);
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
    // Alice's "first" conversation, then "second", then a later message in "first". Bob has his
    // own conversation with the Tag.
    sqlx::raw_sql(
        "INSERT INTO supertag_v2_tags (tag_id,instructions,allowed_actions,revision)
         VALUES ('owner','Accepted before the migration','[]',1);
         INSERT INTO supertag_v2_tasks (task_id,tag_id,session_id,prompt,instructions,allowed_actions,tag_revision,state,accepted_order,accepted_at_ms)
         VALUES ('t1','owner','conversation/a','First','x','[]',1,3,1,1000),
                ('t2','owner','conversation/b','Second','x','[]',1,3,3,2000),
                ('t3','owner','conversation/a','Third','x','[]',1,3,5,3000),
                ('t4','owner','conversation/c','Bob','x','[]',1,3,6,4000);
         INSERT INTO supertag_v2_conversations (session_id,principal,tag_id,name,created_order)
         VALUES ('conversation/a','operator:alice','owner','first',1),
                ('conversation/b','operator:alice','owner','second',3),
                ('conversation/c','operator:bob','owner','first',6);
         INSERT INTO supertag_v2_conversation_messages (task_id,session_id,principal,operation_id,request_digest,accepted_order)
         VALUES ('t1','conversation/a','operator:alice','o1','d',1),
                ('t2','conversation/b','operator:alice','o2','d',3),
                ('t3','conversation/a','operator:alice','o3','d',5),
                ('t4','conversation/c','operator:bob','o4','d',6);
         UPDATE supertag_v2_write_order SET revision=6 WHERE singleton=1;",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    pool.close().await;
}

async fn contract(url: String) {
    seed_prior_version(&url).await;
    let store = Store::open(&url).await.unwrap();
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
    let ids: Vec<_> = page
        .messages
        .iter()
        .map(|message| message.task.as_ref().unwrap().task_id.as_str())
        .collect();
    assert_eq!(ids, ["t3", "t2", "t1"]);
    // The conversation has its own ID now, so a client's copy is replaced.
    assert!(page.conversation_id.starts_with("direct/"), "{page:?}");
    assert_eq!(page.messages[2].sent_at_ms, 1000);
    // Every earlier Task keeps its audience.
    store.get_message(ALICE, "owner", "t2").await.unwrap();
    assert!(
        store
            .get_message("operator:bob", "owner", "t2")
            .await
            .is_err()
    );
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
    assert_eq!(next.task.unwrap().session_id, "conversation/a");
    let listed = store
        .list_conversations(ALICE, &ListConversationsRequest {})
        .await
        .unwrap();
    assert_eq!(listed.conversations.len(), 1);
    assert_eq!(listed.conversations[0].preview, "After the upgrade");
    store.close().await;
}

#[tokio::test]
async fn sqlite_one_conversation_migration() {
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
        "supertag_rust_one_conversation_migration_{}",
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
    outcome.expect("PostgreSQL one-conversation migration contract failed");
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_one_conversation_migration() {
    on_postgres(contract).await;
}
