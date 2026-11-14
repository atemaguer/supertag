mod support;

use prost::Message;
use sqlx::{Connection, Executor};
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const BASE: i64 = 1_790_000_000_000;
const LEASE: i64 = 30_000;

async fn open(url: &str, clock: &Arc<AtomicI64>) -> Store {
    let clock = clock.clone();
    Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || clock.load(Ordering::SeqCst))
}

async fn reply(store: &Store, id: &str) -> String {
    reply_with_result(store, id, "Reviewed").await
}

async fn reply_with_result(store: &Store, id: &str, result: &str) -> String {
    store.put_tag("reviewer", "Review", vec![]).await.unwrap();
    let task = store
        .accept_event(
            "connector:acme",
            &AcceptEventRequest {
                account_id: "acme".into(),
                event_id: id.into(),
                tag_id: "reviewer".into(),
                session_id: id.into(),
                prompt: "Review".into(),
                requested_execution: None,
                destination: Some(ReplyDestination {
                    conversation_id: "channel".into(),
                    thread_id: None,
                }),
            },
        )
        .await
        .unwrap();
    let host = support::register_host(store, "worker").await;
    let assignment = store.claim_task(&host, id).await.unwrap().unwrap();
    assert_eq!(assignment.task.as_ref().unwrap().task_id, task.task_id);
    store
        .start_task(
            &host,
            &StartTaskRequest {
                task_id: task.task_id.clone(),
                attempt_id: assignment.attempt_id.clone(),
                lease_token: assignment.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    store
        .finish_task(
            &host,
            &FinishTaskRequest {
                task_id: task.task_id.clone(),
                attempt_id: assignment.attempt_id,
                lease_token: assignment.lease_token,
                result: result.into(),
                succeeded: true,
                objective_signal: 0,
                checkpoint_sha256: None,
                workspace_delivery: None,
                waiting_approval_ids: vec![],
                artifacts: vec![],
            },
        )
        .await
        .unwrap();
    task.task_id
}

async fn contract(url: String) {
    let clock = Arc::new(AtomicI64::new(BASE));
    // Upgrade a real populated v37 schema. Old claims have no deadline and must
    // become uncertain, preserving their exact token for late receipt recovery.
    sqlx::any::install_default_drivers();
    let mut old = sqlx::AnyConnection::connect(&url).await.unwrap();
    let dialect = if url.starts_with("sqlite:") {
        "sqlite"
    } else {
        "postgresql"
    };
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("migrations")
        .join(dialect);
    let mut migrations: Vec<_> = std::fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name().unwrap().to_str().unwrap()[..4]
                .parse::<u32>()
                .unwrap()
                <= 37
        })
        .collect();
    migrations.sort();
    for path in migrations {
        sqlx::raw_sql(&std::fs::read_to_string(path).unwrap())
            .execute(&mut old)
            .await
            .unwrap();
    }
    sqlx::raw_sql("INSERT INTO supertag_v2_tags(tag_id,instructions,allowed_actions,revision) VALUES('old','old','[]',1);
      INSERT INTO supertag_v2_tasks(task_id,tag_id,session_id,prompt,instructions,allowed_actions,tag_revision,state,result,accepted_order) VALUES('old','old','old','old','old','[]',1,3,'old',1);
      INSERT INTO supertag_v2_replies(reply_id,task_id,account_id,conversation_id,text,state,lease_token,ready_order) VALUES('old','old','old','old','old',2,'old-lease',1);
      INSERT INTO supertag_v2_reply_claims(account_id,operation_id,reply_id,lease_token) VALUES('old','old','old','old-lease');
      UPDATE supertag_v2_write_order SET revision=1 WHERE singleton=1;").execute(&mut old).await.unwrap();
    old.close().await.unwrap();
    let store = open(&url, &clock).await;
    let migrated = store.claim_reply("connector:old", "old").await.unwrap();
    assert_eq!(migrated.lease_token, "old-lease");
    assert_eq!(migrated.reply.unwrap().state(), ReplyState::Uncertain);
    assert_eq!(
        store
            .get_reply_delivery("operator:alice", "old")
            .await
            .unwrap()
            .audit
            .len(),
        1
    );
    reply(&store, "first").await;
    let claim = store
        .claim_reply("connector:acme", "original-claim")
        .await
        .unwrap();
    let id = claim.reply.as_ref().unwrap().reply_id.clone();
    let renew = RenewReplyRequest {
        reply_id: id.clone(),
        lease_token: claim.lease_token.clone(),
    };
    assert!(matches!(
        store.renew_reply("connector:other", &renew).await,
        Err(StoreError::NotFound(_))
    ));
    let mut forged = renew.clone();
    forged.lease_token = "forged".into();
    assert!(matches!(
        store.renew_reply("connector:acme", &forged).await,
        Err(StoreError::PermissionDenied)
    ));
    clock.store(BASE + LEASE - 1, Ordering::SeqCst);
    let lease = store.renew_reply("connector:acme", &renew).await.unwrap();
    assert_eq!(lease.valid_for_ms, LEASE as u64);
    clock.store(BASE + LEASE, Ordering::SeqCst);
    store.sweep_replies().await.unwrap();
    assert_eq!(
        store
            .get_reply_delivery("operator:alice", &id)
            .await
            .unwrap()
            .reply
            .unwrap()
            .state(),
        ReplyState::Claimed
    );
    assert!(
        store
            .claim_reply("connector:acme", "replacement-live")
            .await
            .unwrap()
            .reply
            .is_none()
    );
    store.close().await;

    let store = open(&url, &clock).await;
    clock.store(BASE + 2 * LEASE - 1, Ordering::SeqCst);
    store.sweep_replies().await.unwrap();
    let expired = store
        .get_reply_delivery("operator:alice", &id)
        .await
        .unwrap();
    assert_eq!(expired.reply.unwrap().state(), ReplyState::Uncertain);
    assert_eq!(expired.audit.len(), 1);
    assert_eq!(expired.audit[0].kind, "claim-expired");
    store.sweep_replies().await.unwrap();
    assert_eq!(
        store
            .get_reply_delivery("operator:alice", &id)
            .await
            .unwrap()
            .audit
            .len(),
        1
    );
    assert!(store.renew_reply("connector:acme", &renew).await.is_err());
    assert!(
        store
            .claim_reply("connector:acme", "replacement-expired")
            .await
            .unwrap()
            .reply
            .is_none()
    );
    let original = store
        .claim_reply("connector:acme", "original-claim")
        .await
        .unwrap();
    assert_eq!(original.lease_token, claim.lease_token);
    assert_eq!(original.reply.unwrap().state(), ReplyState::Uncertain);
    // A saved definitive receipt is evidence; expiry must not discard it or cause another send.
    let settle = SettleReplyRequest {
        reply_id: id.clone(),
        lease_token: claim.lease_token,
        state: ReplyState::Delivered.into(),
        provider_receipt: Some("provider-receipt".into()),
    };
    let settled = store.settle_reply("connector:acme", &settle).await.unwrap();
    assert_eq!(settled.state(), ReplyState::Delivered);
    assert_eq!(
        settled,
        store.settle_reply("connector:acme", &settle).await.unwrap()
    );
    assert_eq!(
        store
            .get_reply_delivery("operator:alice", &id)
            .await
            .unwrap()
            .audit
            .len(),
        2
    );

    reply(&store, "second").await;
    let second = store
        .claim_reply("connector:acme", "second-claim")
        .await
        .unwrap();
    let second_id = second.reply.unwrap().reply_id;
    clock.fetch_add(LEASE, Ordering::SeqCst);
    store.sweep_replies().await.unwrap();
    let resolve = ResolveReplyRequest {
        reply_id: second_id.clone(),
        operation_id: "audit-provider".into(),
        state: ReplyState::Failed.into(),
        provider_receipt: None,
        evidence: "Provider audit confirms no delivery. Do not resend.".into(),
    };
    assert!(
        store
            .resolve_reply("connector:acme", &resolve)
            .await
            .is_err()
    );
    let resolved = store
        .resolve_reply("operator:alice", &resolve)
        .await
        .unwrap();
    assert_eq!(resolved.reply.as_ref().unwrap().state(), ReplyState::Failed);
    assert_eq!(
        resolved,
        store
            .resolve_reply("operator:alice", &resolve)
            .await
            .unwrap()
    );
    let mut conflict = resolve.clone();
    conflict.state = ReplyState::Delivered.into();
    conflict.provider_receipt = Some("different".into());
    assert!(matches!(
        store.resolve_reply("operator:alice", &conflict).await,
        Err(StoreError::Conflict(_))
    ));
    let late = SettleReplyRequest {
        reply_id: second_id.clone(),
        lease_token: second.lease_token,
        state: ReplyState::Delivered.into(),
        provider_receipt: Some("late".into()),
    };
    for _ in 0..2 {
        assert!(matches!(
            store.settle_reply("connector:acme", &late).await,
            Err(StoreError::Conflict(_))
        ));
    }
    let audited = store
        .get_reply_delivery("operator:alice", &second_id)
        .await
        .unwrap();
    assert_eq!(audited.audit.len(), 3);
    assert_eq!(audited.audit.last().unwrap().kind, "conflicting-settlement");
    assert!(
        store
            .get_reply_delivery("connector:acme", &second_id)
            .await
            .is_err()
    );
    assert!(
        store
            .claim_reply("connector:acme", "never-repost")
            .await
            .unwrap()
            .reply
            .is_none()
    );
    let page = store
        .list_reply_deliveries(
            "operator:alice",
            &ListReplyDeliveriesRequest {
                account_id: "acme".into(),
                state: 0,
                limit: 1,
                before_order: 0,
            },
        )
        .await
        .unwrap();
    assert_eq!(page.deliveries.len(), 1);
    assert!(page.next_before_order > 0);
    let next = store
        .list_reply_deliveries(
            "operator:alice",
            &ListReplyDeliveriesRequest {
                account_id: "acme".into(),
                state: 0,
                limit: 1,
                before_order: page.next_before_order,
            },
        )
        .await
        .unwrap();
    assert_eq!(next.deliveries[0].reply.as_ref().unwrap().reply_id, id);
    assert_eq!(next.next_before_order, 0);
    // A valid single Task result must remain readable when a count-only page
    // would exceed the Gateway's 1 MiB message bound. Follow every cursor once.
    for id in ["large-a", "large-b", "large-c", "large-d"] {
        reply_with_result(&store, id, &"🦀".repeat(60_000)).await;
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut before = 0;
    loop {
        let page = store
            .list_reply_deliveries(
                "operator:alice",
                &ListReplyDeliveriesRequest {
                    account_id: "acme".into(),
                    state: 0,
                    limit: 100,
                    before_order: before,
                },
            )
            .await
            .unwrap();
        assert!(page.encoded_len() < 1024 * 1024);
        assert!(!page.deliveries.is_empty());
        for delivery in page.deliveries {
            assert!(seen.insert(delivery.reply.unwrap().reply_id));
        }
        before = page.next_before_order;
        if before == 0 {
            break;
        }
    }
    assert_eq!(seen.len(), 6);
    store.close().await;
    let store = open(&url, &clock).await;
    assert_eq!(
        resolved,
        store
            .resolve_reply("operator:alice", &resolve)
            .await
            .unwrap()
    );
    store.close().await;
}

#[tokio::test]
async fn sqlite_reply_recovery() {
    let dir = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("reply.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires dedicated PostgreSQL server"]
async fn postgres_reply_recovery() {
    let path =
        std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("test database file");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!("supertag_reply_recovery_{}", Uuid::new_v4().simple());
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
    outcome.unwrap();
}
