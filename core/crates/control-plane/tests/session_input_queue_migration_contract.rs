//! Upgrading to one input queue per Session moves every pending input into it: live inputs in
//! every state (with their recovery receipts), the unfinished Tasks each source admitted, pending
//! and bound wakes, the direct messages a wake limit held, and the inbox Tasks' links, which become
//! reservations. Positions follow each Task's place in the write order; Tag messages continue it.
//! The replaced tables are gone, a live input's change still reaches its watch, and the store
//! reads the migrated rows.
use std::future::Future;

use sqlx::{AnyPool, Connection, Executor, Row};
use supertag_control_plane::Store;
use supertag_protocol::v2::*;
use uuid::Uuid;

/// The schema version just before `0122_session_input_queue`.
const PRIOR: u32 = 121;
const ALICE: &str = "operator:alice";

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
    // Alice talks with `alpha` in conversation `pc`; its turn `run` is running and was offered
    // five of her later messages, one in each live input state, and joined a sixth. Other Tasks
    // wait in other Sessions, one per source. `beta` has a delivered wake, a pending one its
    // waiting inbox Task reserved, and `gamma` a direct message a wake limit held. `delta`'s
    // waiting inbox Task has nothing left to deliver.
    sqlx::raw_sql(
        "INSERT INTO supertag_v2_tags (tag_id,instructions,allowed_actions,revision)
         VALUES ('alpha','x','[]',1),('beta','x','[]',1),('gamma','x','[]',1),('delta','x','[]',1);
         INSERT INTO supertag_v2_conversations (conversation_id,kind,direct_key,next_seq,created_at_ms)
         VALUES ('pc',1,'p:operator:alice\nt:alpha',9,1),
                ('dm-ab',1,'t:alpha\nt:beta',3,1),
                ('dm-ag',1,'t:alpha\nt:gamma',2,1);
         INSERT INTO supertag_v2_conversation_sessions (session_id,principal,tag_id,created_order,conversation_id)
         VALUES ('conversation/pc','operator:alice','alpha',1,'pc');
         INSERT INTO supertag_v2_tasks (task_id,tag_id,session_id,prompt,instructions,allowed_actions,tag_revision,state,accepted_order,accepted_at_ms,attempt_id)
         VALUES ('run','alpha','conversation/pc','Hello','x','[]',1,2,10,100,'a1'),
                ('f-pending','alpha','conversation/pc','pending','x','[]',1,1,11,110,NULL),
                ('f-accepted','alpha','conversation/pc','accepted','x','[]',1,3,12,120,NULL),
                ('f-unknown','alpha','conversation/pc','unknown','x','[]',1,1,13,130,NULL),
                ('f-retried','alpha','conversation/pc','retried','x','[]',1,1,14,140,NULL),
                ('f-joined','alpha','conversation/pc','joined','x','[]',1,3,15,150,NULL),
                ('q-message','alpha','conversation/pc','later','x','[]',1,1,16,160,NULL),
                ('q-fire','alpha','ops','fire','x','[]',1,1,17,170,NULL),
                ('q-approval','alpha','ops','approved','x','[]',1,1,18,180,NULL),
                ('q-budget','alpha','ops','stopped','x','[]',1,1,19,190,NULL),
                ('q-slack','alpha','slack/1','chat','x','[]',1,1,20,200,NULL),
                ('q-github','alpha','gh/1','issue','x','[]',1,1,21,210,NULL),
                ('q-request','alpha','ops','request','x','[]',1,1,22,220,NULL),
                ('q-redelivered','alpha','ops','again','x','[]',1,1,23,230,NULL),
                ('q-none','alpha','ops','none','x','[]',1,1,24,240,NULL),
                ('done','alpha','ops','done','x','[]',1,3,25,250,NULL),
                ('q-notice','alpha','objective/o1','notice','x','[]',1,1,26,260,NULL),
                ('q-review','alpha','objective/o1','review','x','[]',1,1,27,270,NULL),
                ('q-home','alpha','objective/o2','home','x','[]',1,1,28,280,NULL),
                ('inbox-done','beta','inbox:beta','Inbox','x','[]',1,3,30,300,NULL),
                ('inbox-wait','beta','inbox:beta','Inbox','x','[]',1,1,31,310,NULL),
                ('inbox-empty','delta','inbox:delta','Inbox','x','[]',1,1,32,320,NULL);
         INSERT INTO supertag_v2_messages (conversation_id,seq,message_id,sender_kind,sender_id,kind,text,task_id,created_at_ms)
         VALUES ('pc',1,'m1',2,'operator:alice',1,'','run',100),
                ('pc',2,'m2',2,'operator:alice',1,'','f-pending',110),
                ('pc',3,'m3',2,'operator:alice',1,'','f-accepted',120),
                ('pc',4,'m4',2,'operator:alice',1,'','f-unknown',130),
                ('pc',5,'m5',2,'operator:alice',1,'','f-retried',140),
                ('pc',6,'m6',2,'operator:alice',1,'','f-joined',150),
                ('pc',7,'m7',2,'operator:alice',1,'','q-message',160);
         INSERT INTO supertag_v2_message_operations (scope,scope_id,operation_id,request_digest,message_id)
         VALUES (3,'operator:alice','send-7','d7','m7');
         INSERT INTO supertag_v2_claims (principal,operation_id,task_id,attempt_id,lease_token,claimed_at_ms)
         VALUES ('host:h','c1','run','a1','l1',105),('host:h','c2','q-redelivered','a0','l0',500);
         INSERT INTO supertag_v2_live_inputs (input_id,operator_principal,operation_id,task_id,attempt_id,follower_task_id,state,acknowledgement_deadline_ms,joined_at_claim)
         VALUES ('i-pending','operator:alice','conversation/f-pending','run','a1','f-pending',1,NULL,0),
                ('i-accepted','operator:alice','conversation/f-accepted','run','a1','f-accepted',3,NULL,0),
                ('i-unknown','operator:alice','conversation/f-unknown','run','a1','f-unknown',5,900,0),
                ('i-retried','operator:alice','conversation/f-retried','run','a1','f-retried',8,900,0),
                ('i-joined','control-plane:join','join/f-joined','run','a1','f-joined',3,NULL,1);
         INSERT INTO supertag_v2_live_input_resolutions (input_id,operator_principal,operation_id,decision,evidence,resolved_at_ms)
         VALUES ('i-retried','operator:alice','resolve-1',2,'host restarted',950);
         INSERT INTO supertag_v2_schedules (schedule_id,tag_id,session_id,audience_principal,note,at_ms,state,created_by,created_at_ms,updated_at_ms)
         VALUES ('s1','alpha','ops','operator:alice','Daily',1000,1,'operator:alice',1,1);
         INSERT INTO supertag_v2_schedule_fires (schedule_id,due_at_ms,task_id,fired_at_ms)
         VALUES ('s1',1000,'q-fire',1000);
         INSERT INTO supertag_v2_approval_waits (task_id,attempt_id,continuation_task_id)
         VALUES ('run','a1','q-approval');
         INSERT INTO supertag_v2_inbound_events (account_id,event_id,request_digest,task_id,conversation_id,thread_id)
         VALUES ('control','approval-budget-stop:run','db','q-budget','c',NULL),
                ('acct','ev-slack','ds','q-slack','C1','T1'),
                ('gh','ev-gh','dg','q-github','repo',NULL);
         INSERT INTO supertag_v2_slack_messages (account_id,team_id,channel_id,message_ts,request_digest,task_id)
         VALUES ('acct','T','C1','1.0','ds','q-slack');
         INSERT INTO supertag_v2_admissions (principal,operation_id,request_digest,task_id)
         VALUES ('operator:alice','op-r','dr','q-request'),('operator:alice','op-x','dx','q-redelivered'),
                ('operator:alice','op-d','dd','done');
         INSERT INTO supertag_v2_objectives (objective_id,owner_tag_id,session_id,outcome,ongoing,status,revision,limit_state,created_at_ms,updated_at_ms)
         VALUES ('o1','alpha','objective/o1','Ship',0,1,1,'{}',1,1),
                ('o2','alpha','objective/o2','Ship more',0,1,1,'{}',1,1);
         UPDATE supertag_v2_objectives SET created_by='client:bob',starting_task_id='q-home' WHERE objective_id='o2';
         INSERT INTO supertag_v2_objective_tasks (task_id,objective_id,kind)
         VALUES ('q-notice','o1','notice'),('q-review','o1','work');
         INSERT INTO supertag_v2_objective_notices (objective_id,notice_key,task_id)
         VALUES ('o1','budget','q-notice'),('o1','review/1','q-review');
         INSERT INTO supertag_v2_messages (conversation_id,seq,message_id,sender_kind,sender_id,kind,text,hops,origin_task_id,created_at_ms)
         VALUES ('dm-ab',1,'d1',1,'alpha',1,'first',0,'run',700),
                ('dm-ab',2,'d2',1,'alpha',2,'second',0,'run',1000),
                ('dm-ag',1,'g1',1,'alpha',1,'held',1,'run',1100);
         INSERT INTO supertag_v2_message_addressees (conversation_id,seq,tag_id,sender_tag_id,created_at_ms)
         VALUES ('dm-ab',1,'beta','alpha',700),('dm-ab',2,'beta','alpha',1000),
                ('dm-ag',1,'gamma','alpha',1100);
         INSERT INTO supertag_v2_conversation_members (conversation_id,member_kind,member_id,read_seq,delivered_seq,joined_at_ms)
         VALUES ('dm-ab',1,'alpha',2,2,1),('dm-ab',1,'beta',1,1,1),
                ('dm-ag',1,'alpha',1,1,1),('dm-ag',1,'gamma',0,0,1);
         INSERT INTO supertag_v2_mailbox_tasks (task_id,recipient_tag_id,bound)
         VALUES ('inbox-done','beta',1),('inbox-wait','beta',0),('inbox-empty','delta',0);
         INSERT INTO supertag_v2_wakes (wake_id,tag_id,conversation_id,reasons,priority,first_seq,last_seq,hops,origin_task_id,not_before_ms,created_at_ms,task_id,through_seq,bound_at_ms)
         VALUES ('w-bound','beta','dm-ab',1,1,1,1,0,'run',800,800,'inbox-done',1,900),
                ('w-pending','beta','dm-ab',5,2,2,2,0,'run',1500,1000,NULL,NULL,NULL);",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    pool.close().await;
}

type Input = (
    String,
    String,
    String,
    i64,
    i64,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
);

/// input_id, offer_task_id, offer_attempt_id, offer_state, bound_at_claim.
type Offer = (String, Option<String>, Option<String>, Option<i64>, i64);
/// input_id, reasons, priority, first_seq, last_seq, through_seq, not_before_ms (-1: held), hops.
type Wake = (String, i64, i64, i64, Option<i64>, Option<i64>, i64, i64);

async fn inputs(pool: &AnyPool) -> Vec<Input> {
    sqlx::query(
        "SELECT input_id,tag_id,session_id,position,kind,source_key,requester,audience,
                admitted_task_id,task_id
         FROM supertag_v2_session_inputs ORDER BY position",
    )
    .fetch_all(pool)
    .await
    .unwrap()
    .iter()
    .map(|row| {
        (
            row.get(0),
            row.get(1),
            row.get(2),
            row.get(3),
            row.get(4),
            row.get(5),
            row.get(6),
            row.get(7),
            row.get(8),
            row.get(9),
        )
    })
    .collect()
}

fn input(
    id: &str,
    (tag, session, position, kind): (&str, &str, i64, i64),
    (key, requester, audience): (&str, &str, &str),
    (admitted, bound): (Option<&str>, Option<&str>),
) -> Input {
    (
        id.into(),
        tag.into(),
        session.into(),
        position,
        kind,
        key.into(),
        requester.into(),
        audience.into(),
        admitted.map(Into::into),
        bound.map(Into::into),
    )
}

async fn contract(url: String) {
    seed_prior_version(&url).await;
    let store = Store::open(&url).await.unwrap();
    assert_eq!(store.migrated(), Some((121, 123)));
    let pool = AnyPool::connect(&url).await.unwrap();
    let base: i64 = 32;
    let conversation = ("alpha", "conversation/pc");
    let ops = |position, kind| ("alpha", "ops", position, kind);
    let expected = vec![
        // The running turn: a person's message with no send receipt, bound by its claim.
        input(
            "m122-task-run",
            (conversation.0, conversation.1, 10, 2),
            ("task\nrun", ALICE, ALICE),
            (Some("run"), Some("run")),
        ),
        // Live inputs: each its follower's place; Accepted ones bound to the running Task.
        input(
            "i-pending",
            (conversation.0, conversation.1, 11, 2),
            ("live\noperator:alice\nconversation/f-pending", ALICE, ALICE),
            (Some("f-pending"), None),
        ),
        input(
            "i-accepted",
            (conversation.0, conversation.1, 12, 2),
            (
                "live\noperator:alice\nconversation/f-accepted",
                ALICE,
                ALICE,
            ),
            (Some("f-accepted"), Some("run")),
        ),
        input(
            "i-unknown",
            (conversation.0, conversation.1, 13, 2),
            ("live\noperator:alice\nconversation/f-unknown", ALICE, ALICE),
            (Some("f-unknown"), None),
        ),
        input(
            "i-retried",
            (conversation.0, conversation.1, 14, 2),
            ("live\noperator:alice\nconversation/f-retried", ALICE, ALICE),
            (Some("f-retried"), None),
        ),
        input(
            "i-joined",
            (conversation.0, conversation.1, 15, 2),
            ("live\ncontrol-plane:join\njoin/f-joined", ALICE, ALICE),
            (Some("f-joined"), Some("run")),
        ),
        // Unfinished admitted Tasks, by source.
        input(
            "m122-task-q-message",
            (conversation.0, conversation.1, 16, 2),
            ("conversation\noperator:alice\nsend-7", ALICE, ALICE),
            (Some("q-message"), None),
        ),
        input(
            "m122-task-q-fire",
            ops(17, 5),
            ("schedule\ns1\n1000", ALICE, ""),
            (Some("q-fire"), None),
        ),
        input(
            "m122-task-q-approval",
            ops(18, 7),
            ("approval\nrun", "tag:alpha", ""),
            (Some("q-approval"), None),
        ),
        input(
            "m122-task-q-budget",
            ops(19, 8),
            ("approval-budget-stop\nrun", "tag:alpha", ""),
            (Some("q-budget"), None),
        ),
        input(
            "m122-task-q-slack",
            ("alpha", "slack/1", 20, 2),
            ("surface\nacct\nev-slack", "connector:acct", ""),
            (Some("q-slack"), None),
        ),
        input(
            "m122-task-q-github",
            ("alpha", "gh/1", 21, 3),
            ("surface\ngh\nev-gh", "connector:gh", ""),
            (Some("q-github"), None),
        ),
        input(
            "m122-task-q-request",
            ops(22, 1),
            ("request\noperator:alice\nop-r", ALICE, ""),
            (Some("q-request"), None),
        ),
        // Claimed before (a redelivered Task back in the queue): bound to itself.
        input(
            "m122-task-q-redelivered",
            ops(23, 1),
            ("request\noperator:alice\nop-x", ALICE, ""),
            (Some("q-redelivered"), Some("q-redelivered")),
        ),
        input(
            "m122-task-q-notice",
            ("alpha", "objective/o1", 26, 8),
            ("objective\no1\nbudget", "objective:o1", ""),
            (Some("q-notice"), None),
        ),
        input(
            "m122-task-q-review",
            ("alpha", "objective/o1", 27, 7),
            ("objective\no1\nreview/1", "objective:o1", ""),
            (Some("q-review"), None),
        ),
        input(
            "m122-task-q-home",
            ("alpha", "objective/o2", 28, 1),
            ("objective-home\no2", "client:bob", ""),
            (Some("q-home"), None),
        ),
        // Wakes in creation order after every Task, then the held message.
        input(
            "w-bound",
            ("beta", "inbox:beta", base + 1, 4),
            ("wake\nw-bound", "tag:alpha", ""),
            (Some("inbox-done"), Some("inbox-done")),
        ),
        input(
            "w-pending",
            ("beta", "inbox:beta", base + 2, 4),
            ("wake\nw-pending", "tag:alpha", ""),
            (Some("inbox-wait"), None),
        ),
        input(
            "m122-held-dm-ag-gamma",
            ("gamma", "inbox:gamma", base + 3, 4),
            ("wake\nm122-held-dm-ag-gamma", "tag:alpha", ""),
            (None, None),
        ),
    ];
    let migrated = inputs(&pool).await;
    assert_eq!(migrated, expected);
    // `q-none` had no source and `done` had finished: neither has an input.
    let revision: i64 =
        sqlx::query_scalar("SELECT revision FROM supertag_v2_write_order WHERE singleton=1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(revision, base + 3, "the write order continues after them");

    // Offers, joins, recovery receipts, bound times.
    let offers: Vec<Offer> = sqlx::query(
        "SELECT input_id,offer_task_id,offer_attempt_id,offer_state,bound_at_claim
         FROM supertag_v2_session_inputs WHERE kind=2 ORDER BY position",
    )
    .fetch_all(&pool)
    .await
    .unwrap()
    .iter()
    .map(|row| (row.get(0), row.get(1), row.get(2), row.get(3), row.get(4)))
    .collect();
    let offer = |id: &str, state: Option<i64>, joined: i64| {
        (
            id.to_owned(),
            state.map(|_| "run".to_owned()),
            state.map(|_| "a1".to_owned()),
            state,
            joined,
        )
    };
    assert_eq!(
        offers,
        [
            offer("m122-task-run", None, 0),
            offer("i-pending", Some(1), 0),
            offer("i-accepted", Some(3), 0),
            offer("i-unknown", Some(5), 0),
            offer("i-retried", Some(8), 0),
            offer("i-joined", Some(3), 1),
            offer("m122-task-q-message", None, 0),
            offer("m122-task-q-slack", None, 0),
        ]
    );
    let resolution: (String, String, i64, String, i64) = sqlx::query_as(
        "SELECT resolution_principal,resolution_operation_id,resolution_decision,
                resolution_evidence,resolved_at_ms
         FROM supertag_v2_session_inputs WHERE input_id='i-retried'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        resolution,
        (
            ALICE.into(),
            "resolve-1".into(),
            2,
            "host restarted".into(),
            950
        )
    );
    let unknown_deadline: Option<i64> = sqlx::query_scalar(
        "SELECT acknowledgement_deadline_ms FROM supertag_v2_session_inputs WHERE input_id='i-unknown'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(unknown_deadline, Some(900));
    let redelivered_at: Option<i64> = sqlx::query_scalar(
        "SELECT bound_at_ms FROM supertag_v2_session_inputs WHERE admitted_task_id='q-redelivered'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(redelivered_at, Some(500));

    // Tag messages keep their range and due time; the held one has none.
    let wakes: Vec<Wake> = sqlx::query(
        "SELECT input_id,reasons,priority,first_seq,last_seq,through_seq,
                COALESCE(not_before_ms,-1),hops
         FROM supertag_v2_session_inputs WHERE kind=4 ORDER BY position",
    )
    .fetch_all(&pool)
    .await
    .unwrap()
    .iter()
    .map(|row| {
        (
            row.get(0),
            row.get(1),
            row.get(2),
            row.get(3),
            row.get(4),
            row.get(5),
            row.get(6),
            row.get(7),
        )
    })
    .collect();
    assert_eq!(
        wakes,
        [
            ("w-bound".into(), 1, 1, 1, Some(1), Some(1), 800, 0),
            ("w-pending".into(), 5, 2, 2, Some(2), None, 1500, 0),
            (
                "m122-held-dm-ag-gamma".into(),
                1,
                1,
                1,
                Some(1),
                None,
                -1,
                1
            ),
        ]
    );

    // An inbox Task with nothing to deliver is cancelled; the reserving one waits.
    let inbox: Vec<(String, i64, Option<String>)> = sqlx::query(
        "SELECT task_id,state,result FROM supertag_v2_tasks
         WHERE session_id LIKE 'inbox:%' ORDER BY task_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap()
    .iter()
    .map(|row| (row.get(0), row.get(1), row.get(2)))
    .collect();
    assert_eq!(
        inbox,
        [
            ("inbox-done".into(), 3, None),
            (
                "inbox-empty".into(),
                5,
                Some("inbox Task has no waiting messages".into())
            ),
            ("inbox-wait".into(), 1, None),
        ]
    );

    // The replaced tables are gone.
    for table in [
        "supertag_v2_live_inputs",
        "supertag_v2_live_input_resolutions",
        "supertag_v2_wakes",
        "supertag_v2_mailbox_tasks",
    ] {
        assert!(
            sqlx::query(&format!("SELECT 1 FROM {table}"))
                .fetch_optional(&pool)
                .await
                .is_err(),
            "{table} is dropped"
        );
    }

    // The store reads the migrated rows.
    let accepted = store.get_input("i-accepted").await.unwrap();
    assert_eq!(
        (
            accepted.task_id.as_str(),
            accepted.attempt_id.as_str(),
            accepted.follower_task_id.as_str(),
            accepted.text.as_str(),
            accepted.state(),
            accepted.order
        ),
        (
            "run",
            "a1",
            "f-accepted",
            "accepted",
            LiveInputState::Accepted,
            12
        )
    );
    assert!(matches!(
        store.get_input("m122-task-q-message").await,
        Err(supertag_control_plane::StoreError::NotFound(_))
    ));
    // A replayed recovery decision answers from the migrated receipt.
    let replayed = store
        .resolve_input(
            ALICE,
            &ResolveInputRequest {
                input_id: "i-retried".into(),
                operation_id: "resolve-1".into(),
                decision: LiveInputDecision::Retry.into(),
                evidence: "host restarted".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(replayed.state(), LiveInputState::Retried);

    // A live input's change of state reaches its follower's watch; its first offer does not.
    let notices = || async {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM supertag_v2_watch_notices")
            .fetch_one(&pool)
            .await
            .unwrap()
    };
    let before = notices().await;
    sqlx::query(
        "UPDATE supertag_v2_session_inputs SET offer_task_id='run',offer_attempt_id='a1',
            offer_state=1 WHERE input_id='m122-task-q-message'",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(notices().await, before);
    sqlx::query("UPDATE supertag_v2_session_inputs SET offer_state=4 WHERE input_id='i-pending'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(notices().await, before + 1);
    store.close().await;

    // Opening it again migrates nothing.
    let store = Store::open(&url).await.unwrap();
    assert_eq!(store.migrated(), None);
    store.close().await;
    pool.close().await;
}

#[tokio::test]
async fn sqlite_session_input_queue_migration() {
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
        "supertag_rust_session_input_queue_migration_{}",
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
    outcome.expect("PostgreSQL session input queue migration contract failed");
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_session_input_queue_migration() {
    on_postgres(contract).await;
}
