//! A turn's reply is shown as soon as its harness finishes: the Worker Host reports it with the
//! harness-finished milestone, and the still-running Task's result is that reply while the host
//! captures and delivers the Workspace. A failed finalization keeps the reply in the
//! conversation, beside the error, and the quiet decision made at harness done is never
//! reversed by FinishTask.
mod support;

use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store};
use supertag_protocol::v2::*;
use uuid::Uuid;

const ALICE: &str = "operator:alice";
const HOUR: i64 = 60 * 60_000;
/// Sun 17 Mar 2030 17:46:40 UTC.
const NOW: i64 = 1_900_000_000_000;

async fn next(store: &Store, host: &HostAuthority) -> InspectAttemptRequest {
    let claim = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .expect("a queued Task");
    let identity = InspectAttemptRequest {
        task_id: claim.task.unwrap().task_id,
        attempt_id: claim.attempt_id,
        lease_token: claim.lease_token,
    };
    store
        .start_task(
            host,
            &StartTaskRequest {
                task_id: identity.task_id.clone(),
                attempt_id: identity.attempt_id.clone(),
                lease_token: identity.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    identity
}

async fn say(store: &Store, text: &str) {
    store
        .send_message(
            ALICE,
            &SendMessageRequest {
                tag_id: "lead".into(),
                text: text.into(),
                operation_id: Uuid::new_v4().to_string(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

/// The Tag's message, as the harness wrote it while the turn ran.
async fn wrote(store: &Store, host: &HostAuthority, turn: &InspectAttemptRequest, text: &str) {
    store
        .append_event(
            &supertag_control_plane::AttemptAccess::new(
                host,
                &supertag_protocol::v2::InspectAttemptRequest {
                    task_id: turn.task_id.clone(),
                    attempt_id: turn.attempt_id.clone(),
                    lease_token: turn.lease_token.clone(),
                },
            ),
            &AppendEventRequest {
                sequence: 1,
                text: text.into(),
                kind: TaskEventKind::Message as i32,
            },
        )
        .await
        .unwrap();
}

fn harness_finished(reply: Option<&str>, quiet: bool) -> ReportAttemptMilestoneRequest {
    ReportAttemptMilestoneRequest {
        milestone: AttemptMilestone::HarnessFinished as i32,
        reply: reply.map(str::to_owned),
        quiet,
        objective_signal: ObjectiveSignal::Progress as i32,
    }
}

fn finish(
    turn: &InspectAttemptRequest,
    result: &str,
    succeeded: bool,
    quiet: bool,
) -> FinishTaskRequest {
    FinishTaskRequest {
        task_id: turn.task_id.clone(),
        attempt_id: turn.attempt_id.clone(),
        lease_token: turn.lease_token.clone(),
        result: result.into(),
        succeeded,
        quiet,
        ..Default::default()
    }
}

/// What the person's conversation shows of a turn: its state, result, and the Tag's messages.
async fn shown(store: &Store, task_id: &str) -> Option<(TaskState, Option<String>, Vec<String>)> {
    store
        .list_messages(
            ALICE,
            &ListMessagesRequest {
                tag_id: "lead".into(),
                limit: 50,
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .messages
        .into_iter()
        .find(|message| message.task.as_ref().unwrap().task_id == task_id)
        .map(|message| {
            let task = message.task.unwrap();
            (
                task.state(),
                task.result,
                message.events.into_iter().map(|event| event.text).collect(),
            )
        })
}

async fn contract(url: String) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let tick = Arc::clone(&clock);
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(move || tick.load(Ordering::SeqCst))
        .with_time_zone("UTC")
        .unwrap();
    let host = support::register_host(&store, "worker").await;
    store
        .put_tag(
            "lead",
            "Help",
            vec!["files:read".into(), "schedule:create".into()],
        )
        .await
        .unwrap();

    // The reply shows when the harness finishes, while the Task still runs and finalizes.
    say(&store, "Hello").await;
    let turn = next(&store, &host).await;
    wrote(&store, &host, &turn, "Hi there").await;
    store
        .report_attempt_milestone(
            &supertag_control_plane::AttemptAccess::new(&host, &turn),
            &harness_finished(Some("Hi there"), false),
        )
        .await
        .unwrap();
    assert_eq!(
        shown(&store, &turn.task_id).await,
        Some((
            TaskState::Running,
            Some("Hi there".into()),
            vec!["Hi there".into()]
        ))
    );
    let task = store.get_task(&turn.task_id).await.unwrap();
    assert_eq!(
        (task.state(), task.result.as_deref()),
        (TaskState::Running, Some("Hi there"))
    );
    // The conversation list shows the reply too, unread and no longer working.
    let listed = store
        .list_conversations(ALICE, &ListConversationsRequest {})
        .await
        .unwrap()
        .conversations
        .into_iter()
        .find(|conversation| conversation.tag_id == "lead")
        .unwrap();
    assert_eq!(
        (listed.working, listed.unread_count, listed.preview.as_str()),
        (false, 1, "Hi there")
    );
    // A repeated milestone changes nothing; a reply on another milestone is refused.
    store
        .report_attempt_milestone(
            &supertag_control_plane::AttemptAccess::new(&host, &turn),
            &harness_finished(Some("Changed"), false),
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .get_task(&turn.task_id)
            .await
            .unwrap()
            .result
            .as_deref(),
        Some("Hi there")
    );
    let mut misplaced = harness_finished(Some("Early"), false);
    misplaced.milestone = AttemptMilestone::AdapterAttached as i32;
    assert!(
        store
            .report_attempt_milestone(
                &supertag_control_plane::AttemptAccess::new(&host, &turn),
                &misplaced
            )
            .await
            .is_err()
    );
    let finished = store
        .finish_task(&host, &finish(&turn, "Hi there", true, false))
        .await
        .unwrap();
    assert_eq!(
        (finished.state(), finished.result.as_deref(), finished.quiet),
        (TaskState::Succeeded, Some("Hi there"), false)
    );

    // A finalization that fails after the reply showed keeps the Tag's message in the
    // conversation; the error is the result beside it.
    say(&store, "Deliver it").await;
    let turn = next(&store, &host).await;
    wrote(&store, &host, &turn, "Done, delivering").await;
    store
        .report_attempt_milestone(
            &supertag_control_plane::AttemptAccess::new(&host, &turn),
            &harness_finished(Some("Done, delivering"), false),
        )
        .await
        .unwrap();
    store
        .finish_task(
            &host,
            &finish(
                &turn,
                "Workspace delivery could not be committed",
                false,
                false,
            ),
        )
        .await
        .unwrap();
    assert_eq!(
        shown(&store, &turn.task_id).await,
        Some((
            TaskState::Failed,
            Some("Workspace delivery could not be committed".into()),
            vec!["Done, delivering".into()]
        ))
    );

    // A person's turn always posts, even when the harness asks to stay quiet, and FinishTask
    // keeps that decision.
    say(&store, "Anything?").await;
    let turn = next(&store, &host).await;
    store
        .report_attempt_milestone(
            &supertag_control_plane::AttemptAccess::new(&host, &turn),
            &harness_finished(Some("Nothing new"), true),
        )
        .await
        .unwrap();
    let finished = store
        .finish_task(&host, &finish(&turn, "Nothing new", true, true))
        .await
        .unwrap();
    assert!(!finished.quiet);
    assert!(shown(&store, &turn.task_id).await.is_some());

    // A turn no person waits on, which may stay quiet or be held, shows its reply only when it
    // finishes: nothing early, and a quiet finish never posts.
    store
        .create_schedule(
            ALICE,
            &CreateScheduleRequest {
                operation_id: "check-ci".into(),
                tag_id: "lead".into(),
                note: "Check CI".into(),
                at: String::new(),
                every: "@hourly".into(),
                time_zone: None,
            },
        )
        .await
        .unwrap();
    clock.store(NOW + HOUR, Ordering::SeqCst);
    assert_eq!(store.sweep_schedules().await.unwrap(), 1);
    let turn = next(&store, &host).await;
    store
        .report_attempt_milestone(
            &supertag_control_plane::AttemptAccess::new(&host, &turn),
            &harness_finished(Some("All green"), true),
        )
        .await
        .unwrap();
    let task = store.get_task(&turn.task_id).await.unwrap();
    assert_eq!((task.state(), task.result), (TaskState::Running, None));
    let finished = store
        .finish_task(&host, &finish(&turn, "All green", true, true))
        .await
        .unwrap();
    assert!(finished.quiet);
    assert!(shown(&store, &turn.task_id).await.is_none());

    // A turn that reports no reply, such as one that failed, shows nothing early.
    say(&store, "Try again").await;
    let turn = next(&store, &host).await;
    store
        .report_attempt_milestone(
            &supertag_control_plane::AttemptAccess::new(&host, &turn),
            &harness_finished(None, false),
        )
        .await
        .unwrap();
    let task = store.get_task(&turn.task_id).await.unwrap();
    assert_eq!((task.state(), task.result), (TaskState::Running, None));
    store.close().await;
}

const CONNECTOR: &str = "connector:slack-test";

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

/// Posts the acknowledgement of a mention, as the Slack Gateway does, and returns its receipt.
async fn acknowledge(store: &Store, operation: &str, receipt: &str) {
    let claimed = store
        .claim_reply_progress(CONNECTOR, operation)
        .await
        .unwrap();
    let update = claimed.update.expect("an acknowledgement");
    store
        .settle_reply_progress(
            CONNECTOR,
            &SettleReplyProgressRequest {
                task_id: update.task_id,
                lease_token: claimed.lease_token,
                state: ReplyState::Delivered.into(),
                provider_receipt: Some(receipt.into()),
            },
        )
        .await
        .unwrap();
}

/// The next reply the Slack Gateway would send, delivered.
async fn delivered(store: &Store, operation: &str) -> Option<Reply> {
    let claimed = store.claim_reply(CONNECTOR, operation).await.unwrap();
    let reply = claimed.reply?;
    store
        .settle_reply(
            CONNECTOR,
            &SettleReplyRequest {
                reply_id: reply.reply_id.clone(),
                lease_token: claimed.lease_token,
                state: ReplyState::Delivered.into(),
                provider_receipt: Some(format!("{operation}.000001")),
            },
        )
        .await
        .unwrap();
    Some(reply)
}

/// A surface thread gets a person's turn's reply when its harness finishes, replacing the
/// acknowledgement; FinishTask sends no second reply, and a failure to deliver the turn's changes
/// follows the reply as a message of its own.
async fn surface(url: String) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let tick = Arc::clone(&clock);
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(move || tick.load(Ordering::SeqCst));
    store
        .put_tag("builder", "Answer", vec!["files:read".into()])
        .await
        .unwrap();
    let host = support::register_host(&store, "slack-worker").await;

    for (event, thread, ack, succeeded) in [
        ("EvONE", "1794470000.000001", "1794470009.000001", true),
        ("EvTWO", "1794470000.000002", "1794470009.000002", false),
    ] {
        store
            .accept_slack_event(CONNECTOR, &mention(event, thread))
            .await
            .unwrap();
        acknowledge(&store, &format!("{event}-ack"), ack).await;
        let turn = next(&store, &host).await;
        store
            .report_attempt_milestone(
                &supertag_control_plane::AttemptAccess::new(&host, &turn),
                &harness_finished(Some("Fixed it."), false),
            )
            .await
            .unwrap();
        clock.fetch_add(
            supertag_control_plane::reply_progress::UPDATE_INTERVAL_MS,
            Ordering::SeqCst,
        );
        let reply = delivered(&store, &format!("{event}-reply"))
            .await
            .expect("the reply goes out when the harness finishes");
        assert_eq!(reply.task_id, turn.task_id);
        assert_eq!(reply.text, "Fixed it.");
        assert_eq!(reply.replace_provider_receipt.as_deref(), Some(ack));
        let result = if succeeded {
            "Fixed it."
        } else {
            "Workspace delivery could not be committed"
        };
        store
            .finish_task(&host, &finish(&turn, result, succeeded, false))
            .await
            .unwrap();
        clock.fetch_add(
            supertag_control_plane::reply_progress::UPDATE_INTERVAL_MS,
            Ordering::SeqCst,
        );
        let after = delivered(&store, &format!("{event}-after")).await;
        if succeeded {
            assert_eq!(after, None, "a delivered turn sent its reply twice");
        } else {
            let after = after.expect("the failure follows the reply");
            assert_eq!(
                after.text,
                "I ran into a problem while working on this: Workspace delivery could not be committed"
            );
            assert_eq!(
                after.replace_provider_receipt, None,
                "the failure replaced the reply"
            );
            assert_eq!(
                after.destination,
                Some(ReplyDestination {
                    conversation_id: "CCHANNEL1".into(),
                    thread_id: Some(thread.into()),
                })
            );
            assert_eq!(delivered(&store, &format!("{event}-again")).await, None);
        }
    }
    store.close().await;
}

#[tokio::test]
async fn sqlite_reply_at_harness_done_contract() {
    let directory = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("store.db").display()
    ))
    .await;
    surface(format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("surface.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_reply_at_harness_done_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let database = format!("supertag_rust_reply_ready_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {database} TEMPLATE template0").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&database);
    let local = tokio::task::LocalSet::new();
    let result = local
        .run_until(async move {
            tokio::task::spawn_local(async move {
                contract(url.to_string()).await;
                surface(url.to_string()).await;
            })
            .await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await
        .unwrap();
    result.unwrap();
}
