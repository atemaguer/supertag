//! Upgrading to one message model keeps every Mailbox message and Workstream post with its ID,
//! numbers each conversation's messages in their old order, carries delivery state into wake rows
//! and member positions, and keeps every operation receipt.
use std::future::Future;

use sqlx::{AnyPool, Connection, Executor, Row};
use supertag_control_plane::Store;
use supertag_protocol::v2::*;
use uuid::Uuid;

/// The schema version just before `0117_unified_messages`.
const PRIOR: u32 = 116;
const OPERATOR: &str = "operator:alice";

async fn seed_prior_version(url: &str) -> i64 {
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
    // The builder works on an Objective; the reviewer's inbox took two turns, so its direct
    // messages from the builder were split across two inbox Tasks. A review request and later
    // notes are still pending. A deleted Team left an addressed copy of its post behind.
    sqlx::raw_sql(
        "INSERT INTO supertag_v2_tags (tag_id,instructions,allowed_actions,revision)
         VALUES ('builder','x','[]',1),('reviewer','x','[]',1),('helper','x','[]',1);
         INSERT INTO supertag_v2_tasks (task_id,tag_id,session_id,prompt,instructions,allowed_actions,tag_revision,state,accepted_order,accepted_at_ms)
         VALUES ('src','builder','ordinary','x','x','[]',1,3,1,1000),
                ('inbox1','reviewer','inbox:reviewer','x','x','[]',1,3,2,1000),
                ('inbox2','reviewer','inbox:reviewer','x','x','[]',1,3,3,1000),
                ('rsrc','reviewer','ordinary','x','x','[]',1,3,4,1000),
                ('hsrc','helper','ordinary','x','x','[]',1,3,5,1000);
         INSERT INTO supertag_v2_objectives (objective_id,owner_tag_id,session_id,outcome,ongoing,status,revision,limit_state,created_at_ms,updated_at_ms)
         VALUES ('obj','builder','objective/obj','Ship',0,1,1,'{}',1,1);
         INSERT INTO supertag_v2_objective_tasks (task_id,objective_id,kind) VALUES ('src','obj','work');
         INSERT INTO supertag_v2_teams (team_id,name,revision,created_at_ms,updated_at_ms,next_post_sequence)
         VALUES ('team','Team',1,500,500,4);
         INSERT INTO supertag_v2_team_members (team_id,tag_id)
         VALUES ('team','builder'),('team','reviewer'),('team','helper');
         INSERT INTO supertag_v2_workstream_posts (post_id,team_id,author_tag_id,source_task_id,to_tag_ids,body,effect_digest,sequence,created_at_ms)
         VALUES ('p1','team','builder','src','[]','Started','e1',1,1100),
                ('p2','team','builder','src','[\"builder\",\"reviewer\"]','Please look','e2',2,1200),
                ('p3','team','helper','hsrc','[\"builder\",\"reviewer\"]','Found a bug','e3',3,1300);
         INSERT INTO supertag_v2_mailbox_messages (message_id,sender_tag_id,recipient_tag_id,source_task_id,origin,workstream_post_id,objective_id,text,hops,task_id,created_at_ms,delivery_order)
         VALUES ('d1','builder','reviewer','src',1,NULL,'obj','First',0,'inbox1',2000,10),
                ('c2','builder','reviewer','src',2,'p2','obj','Please look',0,'inbox1',1200,11),
                ('d2','builder','reviewer','src',1,NULL,'obj','Second',0,'inbox2',2100,12),
                ('c3r','helper','reviewer','hsrc',2,'p3',NULL,'Found a bug',1,NULL,1300,13),
                ('c3b','helper','builder','hsrc',2,'p3',NULL,'Found a bug',1,NULL,1300,14),
                ('d3','reviewer','builder','rsrc',1,NULL,NULL,'Reply',1,NULL,2200,15),
                ('d4','builder','reviewer','src',1,NULL,'obj','Third',0,NULL,2300,16),
                ('d5','builder','reviewer','src',1,NULL,'obj','Review abc',0,NULL,2400,17),
                ('orphan','helper','builder','hsrc',2,'gone-post',NULL,'Old team note',2,NULL,900,18);
         INSERT INTO supertag_v2_mailbox_tasks (task_id,recipient_tag_id,bound)
         VALUES ('inbox1','reviewer',1),('inbox2','reviewer',1);
         INSERT INTO supertag_v2_mailbox_send_operations (source_task_id,operation_id,request_digest,message_id)
         VALUES ('src','send-1','sd1','d1'),('rsrc','verdict','vd','d5');
         INSERT INTO supertag_v2_workstream_operations (source_task_id,operation_id,request_digest,post_id)
         VALUES ('src','post-2','pd2','p2');
         UPDATE supertag_v2_write_order SET revision=30 WHERE singleton=1;",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    let delivery = if sqlite { "X'00'" } else { "'\\x00'::bytea" };
    sqlx::raw_sql(&format!(
        "INSERT INTO supertag_v2_commit_reviews (request_id,objective_id,requester_tag_id,reviewer_tag_id,source_task_id,workspace_id,commit_sha,delivery,requested_at_ms,created_order)
         VALUES ('d5','obj','builder','reviewer','src','ws','abc',{delivery},2400,20);"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    let head: i64 =
        sqlx::query_scalar("SELECT head FROM supertag_v2_watch_state WHERE singleton=1")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    tx.commit().await.unwrap();
    pool.close().await;
    head
}

async fn rows(pool: &AnyPool, sql: &str) -> Vec<Vec<String>> {
    sqlx::query(sql)
        .fetch_all(pool)
        .await
        .unwrap()
        .iter()
        .map(|row| {
            (0..row.len())
                .map(|column| {
                    row.try_get::<Option<String>, _>(column)
                        .map(|value| value.unwrap_or_else(|| "-".into()))
                        .or_else(|_| {
                            row.try_get::<Option<i64>, _>(column)
                                .map(|value| value.map_or_else(|| "-".into(), |v| v.to_string()))
                        })
                        .unwrap()
                })
                .collect()
        })
        .collect()
}

fn table(expected: &[&[&str]]) -> Vec<Vec<String>> {
    expected
        .iter()
        .map(|row| row.iter().map(|value| (*value).to_owned()).collect())
        .collect()
}

async fn contract(url: String) {
    let head = seed_prior_version(&url).await;
    let store = Store::open(&url).await.unwrap();
    assert_eq!(store.migrated(), Some((116, 122)));
    let pool = AnyPool::connect(&url).await.unwrap();

    // Conversations: the Team's channel continues its sequence; the deleted Team's copy lives in
    // one archived channel; the builder and reviewer share one direct conversation.
    let conversations = rows(
        &pool,
        "SELECT kind,COALESCE(team_id,'-'),COALESCE(name,'-'),COALESCE(direct_key,'-'),next_seq,
                CASE WHEN archived_at_ms IS NULL THEN 'live' ELSE 'archived' END
         FROM supertag_v2_conversations ORDER BY kind,COALESCE(team_id,''),conversation_id",
    )
    .await;
    assert_eq!(
        conversations,
        table(&[
            &["1", "-", "-", "t:builder\nt:reviewer", "6", "live"],
            &["2", "-", "deleted teams", "-", "2", "archived"],
            &["2", "team", "-", "-", "4", "live"],
        ])
    );

    // Messages keep their IDs; each conversation numbers them in delivery order.
    let messages = rows(
        &pool,
        "SELECT c.kind,m.seq,m.message_id,m.sender_id,m.kind,m.text,m.hops,
                COALESCE(m.objective_id,'-'),COALESCE(m.origin_task_id,'-'),COALESCE(m.effect_digest,'-')
         FROM supertag_v2_messages m JOIN supertag_v2_conversations c ON c.conversation_id=m.conversation_id
         ORDER BY c.kind,COALESCE(c.team_id,''),m.seq",
    )
    .await;
    assert_eq!(
        messages,
        table(&[
            &[
                "1", "1", "d1", "builder", "1", "First", "0", "obj", "src", "-"
            ],
            &[
                "1", "2", "d2", "builder", "1", "Second", "0", "obj", "src", "-"
            ],
            &[
                "1", "3", "d3", "reviewer", "1", "Reply", "1", "-", "rsrc", "-"
            ],
            &[
                "1", "4", "d4", "builder", "1", "Third", "0", "obj", "src", "-"
            ],
            &[
                "1",
                "5",
                "d5",
                "builder",
                "6",
                "Review abc",
                "0",
                "obj",
                "src",
                "-"
            ],
            &[
                "2",
                "1",
                "gone-post",
                "helper",
                "1",
                "Old team note",
                "2",
                "-",
                "hsrc",
                "-"
            ],
            &[
                "2", "1", "p1", "builder", "1", "Started", "0", "obj", "src", "e1"
            ],
            &[
                "2",
                "2",
                "p2",
                "builder",
                "1",
                "Please look",
                "0",
                "obj",
                "src",
                "e2"
            ],
            &[
                "2",
                "3",
                "p3",
                "helper",
                "1",
                "Found a bug",
                "1",
                "-",
                "hsrc",
                "e3"
            ],
        ])
    );
    let addressees = rows(
        &pool,
        "SELECT m.message_id,a.tag_id,a.sender_tag_id FROM supertag_v2_message_addressees a
         JOIN supertag_v2_messages m ON m.conversation_id=a.conversation_id AND m.seq=a.seq
         ORDER BY m.message_id,a.tag_id",
    )
    .await;
    assert_eq!(
        addressees,
        table(&[
            &["d1", "reviewer", "builder"],
            &["d2", "reviewer", "builder"],
            &["d3", "builder", "reviewer"],
            &["d4", "reviewer", "builder"],
            &["d5", "reviewer", "builder"],
            &["gone-post", "builder", "helper"],
            &["p2", "reviewer", "builder"],
            &["p3", "builder", "helper"],
            &["p3", "reviewer", "helper"],
        ])
    );

    // Delivery state: the split batch is two bound wakes; pending mail is one pending wake per Tag
    // and conversation, due now, and a review request raises its priority. 0119 drops the pending
    // wakes 0117 made for addressed posts, since posts wake nobody; the digest shows them.
    let wakes = rows(
        &pool,
        "SELECT w.tag_id,c.kind,COALESCE(c.name,'-'),w.reasons,w.priority,w.first_seq,w.last_seq,
                COALESCE(CAST(w.through_seq AS TEXT),'-'),w.hops,COALESCE(w.task_id,'-'),
                COALESCE(w.origin_task_id,'-'),w.not_before_ms
         FROM supertag_v2_session_inputs w JOIN supertag_v2_conversations c ON c.conversation_id=w.conversation_id
         ORDER BY w.tag_id,c.kind,COALESCE(c.name,''),w.first_seq",
    )
    .await;
    assert_eq!(
        wakes,
        table(&[
            &[
                "builder", "1", "-", "1", "1", "3", "3", "-", "1", "-", "rsrc", "0"
            ],
            &[
                "reviewer", "1", "-", "1", "1", "1", "1", "1", "0", "inbox1", "src", "0"
            ],
            &[
                "reviewer", "1", "-", "1", "1", "2", "2", "2", "0", "inbox2", "src", "0"
            ],
            &[
                "reviewer", "1", "-", "17", "2", "4", "5", "-", "0", "-", "src", "0"
            ],
            &[
                "reviewer", "2", "-", "2", "1", "2", "2", "2", "0", "inbox1", "src", "0"
            ],
        ])
    );

    // Members: a Tag's direct position stops before its first pending message; channel members
    // start at the latest post and count the pending posts addressed to them, and 0119 moves a
    // member's position back before the first post a dropped wake held, so its digest shows it.
    let members = rows(
        &pool,
        "SELECT c.kind,m.member_kind,m.member_id,m.read_seq,m.delivered_seq,m.mention_count
         FROM supertag_v2_conversation_members m
         JOIN supertag_v2_conversations c ON c.conversation_id=m.conversation_id
         ORDER BY c.kind,m.member_id",
    )
    .await;
    assert_eq!(
        members,
        table(&[
            &["1", "1", "builder", "2", "2", "1"],
            &["1", "1", "reviewer", "3", "3", "2"],
            &["2", "1", "builder", "3", "2", "1"],
            &["2", "1", "helper", "3", "3", "0"],
            &["2", "1", "reviewer", "3", "2", "1"],
        ])
    );

    // Operation receipts, including a verdict's, which names its review request.
    let operations = rows(
        &pool,
        "SELECT scope,scope_id,operation_id,request_digest,message_id
         FROM supertag_v2_message_operations ORDER BY scope,scope_id,operation_id",
    )
    .await;
    assert_eq!(
        operations,
        table(&[
            &["1", "rsrc", "verdict", "vd", "d5"],
            &["1", "src", "send-1", "sd1", "d1"],
            &["2", "src", "post-2", "pd2", "p2"],
        ])
    );

    // Copying announces nothing.
    let after: i64 =
        sqlx::query_scalar("SELECT head FROM supertag_v2_watch_state WHERE singleton=1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(after, head);
    // A person's conversation Sessions keep their rows under their own name.
    let sessions: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_conversation_sessions")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(sessions, 0);
    pool.close().await;

    // The Workstream still reads its posts in sequence.
    let page = store
        .list_workstream_posts(
            OPERATOR,
            &ListWorkstreamPostsRequest {
                team: "team".into(),
                after_sequence: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        page.posts
            .iter()
            .map(|post| post.sequence)
            .collect::<Vec<_>>(),
        [1, 2, 3]
    );
    store.close().await;
}

#[tokio::test]
async fn sqlite_unified_messages_migration() {
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
        "supertag_rust_unified_messages_migration_{}",
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
    outcome.expect("PostgreSQL unified messages migration contract failed");
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_unified_messages_migration() {
    on_postgres(contract).await;
}
