//! Acknowledgement, paced progress, and in-place final replacement for Slack replies.
//! TypeScript parity: the acknowledgement and `progress.updated` replacement flow in
//! `packages/control-plane/src/index.ts` and `outbound-presentation.ts`.
mod support;

use sqlx::{Connection, Executor};
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use supertag_control_plane::{
    HostAuthority, Store, StoreError, reply_progress::UPDATE_INTERVAL_MS,
};
use supertag_protocol::v2::*;
use uuid::Uuid;

const PRINCIPAL: &str = "connector:slack-test";
const BASE: i64 = 1_790_000_000_000;
const ACK: &str = "1794470009.000001";
const ACKNOWLEDGEMENT: &str = "Got it. I’m looking into this now.";

fn mention(id: &str, message: &str) -> AcceptSlackEventRequest {
    AcceptSlackEventRequest {
        account_id: "slack-test".into(),
        event_id: id.into(),
        team_id: "TTEAM1".into(),
        channel_id: "CCHANNEL1".into(),
        message_ts: message.into(),
        thread_ts: message.into(),
        prompt: format!("Message {message}"),
        mention_tag_id: Some("builder".into()),
        actor_id: "UALICE1".into(),
    }
}

fn progress(summary: &str, active: &str) -> String {
    serde_json::json!({
        "type": "progress.updated",
        "progress": {"summary": summary, "items": [{"text": active, "status": "active"}]},
    })
    .to_string()
}

struct Run {
    task_id: String,
    attempt_id: String,
    lease_token: String,
    sequence: u64,
}

impl Run {
    async fn start(store: &Store, host: &HostAuthority, op: &str) -> Self {
        let assignment = store.claim_task(host, op).await.unwrap().unwrap();
        let task_id = assignment.task.unwrap().task_id;
        store
            .start_task(
                host,
                &StartTaskRequest {
                    task_id: task_id.clone(),
                    attempt_id: assignment.attempt_id.clone(),
                    lease_token: assignment.lease_token.clone(),
                },
            )
            .await
            .unwrap();
        Self {
            task_id,
            attempt_id: assignment.attempt_id,
            lease_token: assignment.lease_token,
            sequence: 0,
        }
    }

    async fn event(&mut self, store: &Store, host: &HostAuthority, text: &str) {
        self.sequence += 1;
        store
            .append_event(
                host,
                &AppendEventRequest {
                    task_id: self.task_id.clone(),
                    attempt_id: self.attempt_id.clone(),
                    lease_token: self.lease_token.clone(),
                    sequence: self.sequence,
                    text: text.into(),
                },
            )
            .await
            .unwrap();
    }

    async fn finish(self, store: &Store, host: &HostAuthority, result: &str) {
        self.end(store, host, result, true).await;
    }

    async fn end(self, store: &Store, host: &HostAuthority, result: &str, succeeded: bool) {
        store
            .finish_task(
                host,
                &FinishTaskRequest {
                    task_id: self.task_id,
                    attempt_id: self.attempt_id,
                    lease_token: self.lease_token,
                    result: result.into(),
                    succeeded,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
    }
}

async fn claim(store: &Store, op: &str) -> ClaimReplyProgressResponse {
    store.claim_reply_progress(PRINCIPAL, op).await.unwrap()
}

async fn settle(
    store: &Store,
    task: &str,
    lease: &str,
    state: ReplyState,
    receipt: Option<&str>,
) -> Result<ReplyProgressUpdate, StoreError> {
    store
        .settle_reply_progress(
            PRINCIPAL,
            &SettleReplyProgressRequest {
                task_id: task.into(),
                lease_token: lease.into(),
                state: state.into(),
                provider_receipt: receipt.map(str::to_owned),
            },
        )
        .await
}

async fn contract(url: String) {
    let clock = Arc::new(AtomicI64::new(BASE));
    let now = clock.clone();
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(move || now.load(Ordering::SeqCst));
    store
        .put_tag("builder", "Answer", vec!["files:read".into()])
        .await
        .unwrap();
    let host = support::register_host(&store, "worker").await;

    // The acknowledgement is the first write. A claim replay returns the same lease.
    let task = store
        .accept_slack_event(PRINCIPAL, &mention("EvONE", "1794470000.000001"))
        .await
        .unwrap()
        .task
        .unwrap();
    let first = claim(&store, "p1").await;
    let update = first.update.clone().unwrap();
    assert_eq!(update.task_id, task.task_id);
    assert_eq!(update.text, ACKNOWLEDGEMENT);
    assert_eq!(update.revision, 1);
    assert_eq!(update.provider_receipt, None);
    assert_eq!(
        update.destination,
        Some(ReplyDestination {
            conversation_id: "CCHANNEL1".into(),
            thread_id: Some("1794470000.000001".into()),
        })
    );
    assert_eq!(claim(&store, "p1").await, first);
    assert_eq!(claim(&store, "p2").await.update, None);
    // Another connector cannot settle or see this account's progress.
    assert!(matches!(
        store
            .settle_reply_progress(
                "connector:another",
                &SettleReplyProgressRequest {
                    task_id: task.task_id.clone(),
                    lease_token: first.lease_token.clone(),
                    state: ReplyState::Delivered.into(),
                    provider_receipt: Some(ACK.into()),
                },
            )
            .await,
        Err(StoreError::NotFound(_))
    ));
    assert!(matches!(
        settle(
            &store,
            &task.task_id,
            &first.lease_token,
            ReplyState::Delivered,
            None
        )
        .await,
        Err(StoreError::InvalidArgument(_))
    ));
    let settled = settle(
        &store,
        &task.task_id,
        &first.lease_token,
        ReplyState::Delivered,
        Some(ACK),
    )
    .await
    .unwrap();
    assert_eq!(settled.provider_receipt.as_deref(), Some(ACK));
    assert_eq!(
        settle(
            &store,
            &task.task_id,
            &first.lease_token,
            ReplyState::Delivered,
            Some(ACK)
        )
        .await
        .unwrap(),
        settled
    );
    assert!(matches!(
        settle(
            &store,
            &task.task_id,
            &first.lease_token,
            ReplyState::Delivered,
            Some("1794470009.000002")
        )
        .await,
        Err(StoreError::Conflict(_))
    ));
    assert_eq!(claim(&store, "p3").await.update, None);

    // Only `progress.updated` events change the message, and updates are paced per message.
    let mut run = Run::start(&store, &host, "run-one").await;
    assert_eq!(run.task_id, task.task_id);
    run.event(&store, &host, "Codex started").await;
    assert_eq!(claim(&store, "p4").await.update, None);
    clock.fetch_add(UPDATE_INTERVAL_MS, Ordering::SeqCst);
    assert_eq!(claim(&store, "p5").await.update, None);
    run.event(&store, &host, &progress("Fixing tests", "Patch"))
        .await;
    run.event(&store, &host, &progress("Fixing tests", "Patch"))
        .await;
    let second = claim(&store, "p6").await;
    let update = second.update.clone().unwrap();
    assert_eq!(update.text, "Fixing tests\n\n• Patch");
    assert_eq!(
        update.revision, 2,
        "identical progress is not a new revision"
    );
    assert_eq!(update.provider_receipt.as_deref(), Some(ACK));
    run.event(&store, &host, &progress("Fixing tests", "Run CI"))
        .await;

    // The final reply waits for the in-flight update, then for the pace, then replaces the
    // acknowledgement in place. Stale progress is never sent after it.
    run.finish(&store, &host, "**Done**").await;
    assert_eq!(
        store.claim_reply(PRINCIPAL, "r1").await.unwrap().reply,
        None
    );
    assert_eq!(claim(&store, "p7").await.update, None);
    settle(
        &store,
        &task.task_id,
        &second.lease_token,
        ReplyState::Delivered,
        Some(ACK),
    )
    .await
    .unwrap();
    assert_eq!(
        store.claim_reply(PRINCIPAL, "r2").await.unwrap().reply,
        None
    );
    clock.fetch_add(UPDATE_INTERVAL_MS, Ordering::SeqCst);
    let final_reply = store.claim_reply(PRINCIPAL, "r3").await.unwrap();
    let reply = final_reply.reply.clone().unwrap();
    assert_eq!(reply.task_id, task.task_id);
    assert_eq!(reply.text, "**Done**");
    assert_eq!(reply.replace_provider_receipt.as_deref(), Some(ACK));
    assert_eq!(reply.result_card, None);
    assert_eq!(
        store.claim_reply(PRINCIPAL, "r3").await.unwrap(),
        final_reply
    );
    assert_eq!(claim(&store, "p8").await.update, None);
    store
        .settle_reply(
            PRINCIPAL,
            &SettleReplyRequest {
                reply_id: reply.reply_id,
                lease_token: final_reply.lease_token,
                state: ReplyState::Delivered.into(),
                provider_receipt: Some(ACK.into()),
            },
        )
        .await
        .unwrap();

    // An uncertain first post is never repeated; the final reply then posts on its own.
    let task = store
        .accept_slack_event(PRINCIPAL, &mention("EvTWO", "1794470000.000002"))
        .await
        .unwrap()
        .task
        .unwrap();
    let lease = claim(&store, "q1").await.lease_token;
    settle(&store, &task.task_id, &lease, ReplyState::Uncertain, None)
        .await
        .unwrap();
    let mut run = Run::start(&store, &host, "run-two").await;
    run.event(&store, &host, &progress("Working", "Read")).await;
    clock.fetch_add(UPDATE_INTERVAL_MS, Ordering::SeqCst);
    assert_eq!(claim(&store, "q2").await.update, None);
    run.finish(&store, &host, "Two").await;
    let reply = store
        .claim_reply(PRINCIPAL, "q3")
        .await
        .unwrap()
        .reply
        .unwrap();
    assert_eq!(
        (reply.text.as_str(), reply.replace_provider_receipt),
        ("Two", None)
    );
    settle_final(&store, &reply.reply_id, "q3").await;

    // A first post whose claim expired is treated the same way. A late receipt is accepted
    // without reopening progress, so a restarted Gateway can always clear its journal.
    let task = store
        .accept_slack_event(PRINCIPAL, &mention("EvTHREE", "1794470000.000003"))
        .await
        .unwrap()
        .task
        .unwrap();
    let lease = claim(&store, "s1").await.lease_token;
    clock.fetch_add(30_001, Ordering::SeqCst);
    let run = Run::start(&store, &host, "run-three").await;
    run.finish(&store, &host, "Three").await;
    let reply = store
        .claim_reply(PRINCIPAL, "s2")
        .await
        .unwrap()
        .reply
        .unwrap();
    assert_eq!(reply.replace_provider_receipt, None);
    settle(
        &store,
        &task.task_id,
        &lease,
        ReplyState::Delivered,
        Some(ACK),
    )
    .await
    .unwrap();
    assert_eq!(claim(&store, "s3").await.update, None);
    settle_final(&store, &reply.reply_id, "s2").await;

    // A Task that finishes before its acknowledgement is sent skips it.
    store
        .accept_slack_event(PRINCIPAL, &mention("EvFOUR", "1794470000.000004"))
        .await
        .unwrap();
    Run::start(&store, &host, "run-four")
        .await
        .finish(&store, &host, "Four")
        .await;
    assert_eq!(claim(&store, "t1").await.update, None);
    let reply = store
        .claim_reply(PRINCIPAL, "t2")
        .await
        .unwrap()
        .reply
        .unwrap();
    assert_eq!(
        (reply.text.as_str(), reply.replace_provider_receipt),
        ("Four", None)
    );

    // Restart: a reopened store keeps the pace, lease replay, and stopped state.
    drop(store);
    let now = clock.clone();
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(move || now.load(Ordering::SeqCst));
    // The first claim was settled, so replaying it repeats no write.
    assert_eq!(claim(&store, "p1").await.update, None);
    assert_eq!(claim(&store, "after-restart").await.update, None);

    // A Gateway that lost an update claim's response replays it only while its lease holds.
    // After the lease expired and the final reply replaced the message, the replay is empty,
    // so stale progress can never overwrite the final answer.
    let task = store
        .accept_slack_event(PRINCIPAL, &mention("EvFIVE", "1794470000.000005"))
        .await
        .unwrap()
        .task
        .unwrap();
    let ack = "1794470009.000005";
    let lease = claim(&store, "u1").await.lease_token;
    settle(
        &store,
        &task.task_id,
        &lease,
        ReplyState::Delivered,
        Some(ack),
    )
    .await
    .unwrap();
    let mut run = Run::start(&store, &host, "run-five").await;
    run.event(&store, &host, &progress("Fixing tests", "Patch"))
        .await;
    clock.fetch_add(UPDATE_INTERVAL_MS, Ordering::SeqCst);
    let lost = claim(&store, "u2").await;
    assert_eq!(
        lost.update.as_ref().unwrap().text,
        "Fixing tests\n\n• Patch"
    );
    assert_eq!(claim(&store, "u2").await, lost, "a live lease replays");
    run.finish(&store, &host, "Five").await;
    assert_eq!(
        store.claim_reply(PRINCIPAL, "u3").await.unwrap().reply,
        None,
        "the final waits for the in-flight update"
    );
    clock.fetch_add(30_001, Ordering::SeqCst);
    let reply = store
        .claim_reply(PRINCIPAL, "u4")
        .await
        .unwrap()
        .reply
        .unwrap();
    assert_eq!(
        (
            reply.text.as_str(),
            reply.replace_provider_receipt.as_deref()
        ),
        ("Five", Some(ack))
    );
    settle_final(&store, &reply.reply_id, "u4").await;
    assert_eq!(claim(&store, "u2").await.update, None);

    // The same holds for an acknowledgement whose claim expired before the final posted.
    let task = store
        .accept_slack_event(PRINCIPAL, &mention("EvSIX", "1794470000.000006"))
        .await
        .unwrap()
        .task
        .unwrap();
    let lost = claim(&store, "v1").await;
    assert_eq!(lost.update.as_ref().unwrap().task_id, task.task_id);
    clock.fetch_add(30_001, Ordering::SeqCst);
    Run::start(&store, &host, "run-six")
        .await
        .finish(&store, &host, "Six")
        .await;
    let reply = store
        .claim_reply(PRINCIPAL, "v2")
        .await
        .unwrap()
        .reply
        .unwrap();
    assert_eq!(reply.replace_provider_receipt, None);
    settle_final(&store, &reply.reply_id, "v2").await;
    assert_eq!(claim(&store, "v1").await.update, None);

    // A failed Task replaces its acknowledgement with the error, as TypeScript `failureText`.
    let task = store
        .accept_slack_event(PRINCIPAL, &mention("EvSEVEN", "1794470000.000007"))
        .await
        .unwrap()
        .task
        .unwrap();
    let ack = "1794470009.000007";
    let lease = claim(&store, "w1").await.lease_token;
    settle(
        &store,
        &task.task_id,
        &lease,
        ReplyState::Delivered,
        Some(ack),
    )
    .await
    .unwrap();
    clock.fetch_add(UPDATE_INTERVAL_MS, Ordering::SeqCst);
    Run::start(&store, &host, "run-seven")
        .await
        .end(&store, &host, "Harness exited\n   with code 2", false)
        .await;
    let failed = store.claim_reply(PRINCIPAL, "w2").await.unwrap();
    let reply = failed.reply.clone().unwrap();
    assert_eq!(reply.task_id, task.task_id);
    assert_eq!(
        reply.text,
        "I ran into a problem while working on this: Harness exited with code 2"
    );
    assert_eq!(reply.replace_provider_receipt.as_deref(), Some(ack));
    assert_eq!(store.claim_reply(PRINCIPAL, "w2").await.unwrap(), failed);
    settle_final(&store, &reply.reply_id, "w2").await;
    assert_eq!(
        store.claim_reply(PRINCIPAL, "w3").await.unwrap().reply,
        None
    );

    // A cancelled Task says that it stopped, also in place of its acknowledgement.
    let task = store
        .accept_slack_event(PRINCIPAL, &mention("EvEIGHT", "1794470000.000008"))
        .await
        .unwrap()
        .task
        .unwrap();
    let ack = "1794470009.000008";
    let lease = claim(&store, "x1").await.lease_token;
    settle(
        &store,
        &task.task_id,
        &lease,
        ReplyState::Delivered,
        Some(ack),
    )
    .await
    .unwrap();
    clock.fetch_add(UPDATE_INTERVAL_MS, Ordering::SeqCst);
    store.cancel_task(&task.task_id).await.unwrap();
    let reply = store
        .claim_reply(PRINCIPAL, "x2")
        .await
        .unwrap()
        .reply
        .unwrap();
    assert_eq!(
        (
            reply.text.as_str(),
            reply.replace_provider_receipt.as_deref()
        ),
        (
            "I stopped working on this because it was cancelled.",
            Some(ack)
        )
    );
    assert_eq!(claim(&store, "x3").await.update, None);
    store.close().await;
}

async fn settle_final(store: &Store, reply_id: &str, op: &str) {
    let lease = store.claim_reply(PRINCIPAL, op).await.unwrap().lease_token;
    store
        .settle_reply(
            PRINCIPAL,
            &SettleReplyRequest {
                reply_id: reply_id.into(),
                lease_token: lease,
                state: ReplyState::Delivered.into(),
                provider_receipt: Some("1794470099.000001".into()),
            },
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn sqlite_reply_progress() {
    let dir = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("progress.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires dedicated PostgreSQL server"]
async fn postgres_reply_progress() {
    let path =
        std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("test database file");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!("supertag_reply_progress_{}", Uuid::new_v4().simple());
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
