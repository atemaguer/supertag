//! Schedules: a one-off fires once, a recurrence catches up once and coalesces, a Tag's
//! Schedule takes effect only when its turn succeeds, limits refuse, Objectives treat an active
//! Schedule as a wait, and replicas fire each occurrence once.
mod support;

use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const ALICE: &str = "operator:alice";
const BOB: &str = "operator:bob";
const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
/// Sun 17 Mar 2030 17:46:40 UTC.
const NOW: i64 = 1_900_000_000_000;
/// 18:00 UTC that day.
const SIX_PM: i64 = NOW + 13 * MINUTE + 20_000;

async fn open(url: &str, clock: &Arc<AtomicI64>) -> Store {
    let clock = Arc::clone(clock);
    Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || clock.load(Ordering::SeqCst))
        .with_time_zone("UTC")
        .unwrap()
}

fn create(tag: &str, operation: &str, note: &str, at: &str, every: &str) -> CreateScheduleRequest {
    CreateScheduleRequest {
        operation_id: operation.into(),
        tag_id: tag.into(),
        note: note.into(),
        at: at.into(),
        every: every.into(),
        time_zone: None,
    }
}

fn staged(
    attempt: &InspectAttemptRequest,
    operation: &str,
    at: &str,
) -> CreateAttemptScheduleRequest {
    CreateAttemptScheduleRequest {
        attempt: Some(attempt.clone()),
        operation_id: operation.into(),
        note: format!("Follow up {operation}"),
        at: at.into(),
        every: String::new(),
        time_zone: None,
    }
}

/// Claims and starts the next queued Task, or `None` when none may start.
async fn next(store: &Store, host: &HostAuthority) -> Option<(Task, InspectAttemptRequest)> {
    let claim = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()?;
    let task = claim.task.unwrap();
    let identity = InspectAttemptRequest {
        task_id: task.task_id.clone(),
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
    Some((task, identity))
}

async fn finish(
    store: &Store,
    host: &HostAuthority,
    identity: &InspectAttemptRequest,
    succeeded: bool,
) {
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: identity.task_id.clone(),
                attempt_id: identity.attempt_id.clone(),
                lease_token: identity.lease_token.clone(),
                result: "Handled".into(),
                succeeded,
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

async fn submit(store: &Store, tag: &str, session: &str) {
    store
        .submit_task(
            ALICE,
            &SubmitTaskRequest {
                tag_id: tag.into(),
                session_id: session.into(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: "Work".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

async fn contract(url: String) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let store = open(&url, &clock).await;
    let host = support::register_host(&store, "worker").await;
    for tag in ["lead", "watcher", "temp", "releaser"] {
        store
            .put_tag(
                tag,
                "Help",
                vec!["files:read".into(), "schedule:create".into()],
            )
            .await
            .unwrap();
    }
    // A Tag without `schedule:create` cannot schedule.
    store
        .put_tag("plain", "Help", vec!["files:read".into()])
        .await
        .unwrap();
    one_off_fires_once_in_the_conversation(&store, &host, &clock).await;
    recurrence_catches_up_once_and_coalesces(&store, &host, &clock).await;
    tag_schedules_take_effect_when_the_turn_succeeds(&store, &host, &clock).await;
    a_tag_without_the_action_cannot_schedule(&store, &host).await;
    limits_refuse(&store, &clock).await;
    objectives_wait_on_schedules(&store, &host, &clock).await;
    retiring_a_tag_cancels_its_schedules(&store).await;
    replicas_fire_each_occurrence_once(&url, &store, &host, &clock).await;
    store.close().await;
}

async fn one_off_fires_once_in_the_conversation(
    store: &Store,
    host: &HostAuthority,
    clock: &Arc<AtomicI64>,
) {
    clock.store(NOW, Ordering::SeqCst);
    let hello = store
        .send_message(
            ALICE,
            &SendMessageRequest {
                tag_id: "lead".into(),
                text: "Hello".into(),
                operation_id: "hello".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let session = hello.task.unwrap().session_id;
    let (_, first) = next(store, host).await.unwrap();
    finish(store, host, &first, true).await;

    let request = create("lead", "follow-up", "Check PR 412", "2h", "");
    let schedule = store.create_schedule(ALICE, &request).await.unwrap();
    assert_eq!(schedule.state(), ScheduleState::Active);
    assert_eq!(schedule.next_due_at_ms, Some(NOW + 2 * HOUR));
    assert_eq!(schedule.at_ms, Some(NOW + 2 * HOUR));
    assert_eq!(schedule.audience.as_deref(), Some(ALICE));
    assert_eq!(schedule.session_id, session);
    assert_eq!(schedule.created_by, ALICE);
    // An exact replay returns it; the same operation with another note conflicts.
    assert_eq!(
        store.create_schedule(ALICE, &request).await.unwrap(),
        schedule
    );
    let mut changed = request.clone();
    changed.note = "Something else".into();
    assert!(matches!(
        store.create_schedule(ALICE, &changed).await,
        Err(StoreError::Conflict(_))
    ));
    // Another operator's conversation does not show it.
    assert!(matches!(
        store.get_schedule(BOB, &schedule.schedule_id).await,
        Err(StoreError::NotFound(_))
    ));

    assert_eq!(store.sweep_schedules().await.unwrap(), 0);
    clock.store(NOW + 2 * HOUR, Ordering::SeqCst);
    assert_eq!(store.sweep_schedules().await.unwrap(), 1);
    assert_eq!(store.sweep_schedules().await.unwrap(), 0);
    let fired = store
        .get_schedule(ALICE, &schedule.schedule_id)
        .await
        .unwrap();
    assert_eq!(fired.state(), ScheduleState::Done);
    assert_eq!(fired.next_due_at_ms, None);
    assert_eq!(fired.fire_count, 1);
    assert_eq!(fired.last_fired_at_ms, Some(NOW + 2 * HOUR));

    // The conversation shows only the Tag's turn, marked with its Schedule.
    let page = store
        .list_messages(
            ALICE,
            &ListMessagesRequest {
                tag_id: "lead".into(),
                limit: 10,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let latest = &page.messages[0];
    assert_eq!(
        latest.schedule_id.as_deref(),
        Some(schedule.schedule_id.as_str())
    );
    let shown = latest.task.as_ref().unwrap();
    assert_eq!(shown.prompt, "");
    assert_eq!(Some(&shown.task_id), fired.last_task_id.as_ref());
    assert_eq!(page.messages[1].schedule_id, None);
    // Until it finishes, the conversation list still shows the previous message, and no work.
    let listed = store
        .list_conversations(ALICE, &ListConversationsRequest {})
        .await
        .unwrap();
    let before = &listed.conversations[0];
    assert_eq!(before.preview, "Handled");
    assert!(!before.working);
    assert_eq!(before.latest_order, page.messages[1].order);

    // The turn runs in the conversation's Session with the wake-up prompt.
    let (task, identity) = next(store, host).await.unwrap();
    assert_eq!(task.session_id, session);
    assert!(
        task.prompt.starts_with("Scheduled wake-up."),
        "{}",
        task.prompt
    );
    assert!(task.prompt.contains("\"Check PR 412\""), "{}", task.prompt);
    assert!(
        task.prompt.contains("operator:alice asked"),
        "{}",
        task.prompt
    );
    assert!(
        task.prompt.contains("This was a one-off."),
        "{}",
        task.prompt
    );
    finish(store, host, &identity, true).await;
    // Once it finishes and posts, it is the latest message.
    let listed = store
        .list_conversations(ALICE, &ListConversationsRequest {})
        .await
        .unwrap();
    let after = &listed.conversations[0];
    assert_eq!(
        (after.preview.as_str(), after.preview_from_tag),
        ("Handled", true)
    );
    assert_eq!(after.latest_order, latest.order);
    assert_eq!((before.unread_count, after.unread_count), (1, 2));
}

async fn recurrence_catches_up_once_and_coalesces(
    store: &Store,
    host: &HostAuthority,
    clock: &Arc<AtomicI64>,
) {
    clock.store(NOW, Ordering::SeqCst);
    let schedule = store
        .create_schedule(
            ALICE,
            &create("lead", "hourly", "Check CI", "", "0 * * * *"),
        )
        .await
        .unwrap();
    assert_eq!(schedule.next_due_at_ms, Some(SIX_PM));
    assert_eq!(
        schedule.every,
        Some(ScheduleRecurrence {
            cron: "0 * * * *".into(),
            time_zone: "UTC".into()
        })
    );
    let id = schedule.schedule_id;
    // Down from 18:00 to 21:30: one turn for the run, the rest counted as missed.
    clock.store(SIX_PM + 3 * HOUR + 30 * MINUTE, Ordering::SeqCst);
    assert_eq!(store.sweep_schedules().await.unwrap(), 1);
    let caught_up = store.get_schedule(ALICE, &id).await.unwrap();
    assert_eq!(caught_up.fire_count, 1);
    assert_eq!(caught_up.missed_count, 3);
    assert_eq!(caught_up.next_due_at_ms, Some(SIX_PM + 4 * HOUR));
    assert_eq!(caught_up.state(), ScheduleState::Active);
    let first = caught_up.last_task_id.clone().unwrap();
    let queued = store.get_task(&first).await.unwrap();
    assert!(
        queued
            .prompt
            .contains("3 earlier occurrences passed while SuperTag could not fire them"),
        "{}",
        queued.prompt
    );
    assert!(
        queued.prompt.contains("recurs (0 * * * *, UTC)"),
        "{}",
        queued.prompt
    );

    // While that turn waits in the queue, the next occurrence coalesces into it.
    clock.store(SIX_PM + 4 * HOUR, Ordering::SeqCst);
    assert_eq!(store.sweep_schedules().await.unwrap(), 0);
    let coalesced = store.get_schedule(ALICE, &id).await.unwrap();
    assert_eq!(coalesced.fire_count, 1);
    assert_eq!(coalesced.missed_count, 4);
    assert_eq!(coalesced.last_task_id.as_deref(), Some(first.as_str()));
    assert_eq!(coalesced.next_due_at_ms, Some(SIX_PM + 5 * HOUR));
    let (task, identity) = next(store, host).await.unwrap();
    assert_eq!(task.task_id, first);
    finish(store, host, &identity, true).await;
    clock.store(SIX_PM + 5 * HOUR, Ordering::SeqCst);
    assert_eq!(store.sweep_schedules().await.unwrap(), 1);
    let (_, identity) = next(store, host).await.unwrap();
    finish(store, host, &identity, true).await;

    // Paused, it does not fire; resumed, it continues at its next occurrence.
    let paused = store
        .change_schedule(ALICE, &id, ScheduleState::Paused)
        .await
        .unwrap();
    assert_eq!(paused.state(), ScheduleState::Paused);
    clock.store(SIX_PM + 6 * HOUR, Ordering::SeqCst);
    assert_eq!(store.sweep_schedules().await.unwrap(), 0);
    clock.store(SIX_PM + 7 * HOUR + 30 * MINUTE, Ordering::SeqCst);
    let resumed = store
        .change_schedule(ALICE, &id, ScheduleState::Active)
        .await
        .unwrap();
    assert_eq!(resumed.next_due_at_ms, Some(SIX_PM + 8 * HOUR));
    assert_eq!(store.sweep_schedules().await.unwrap(), 0);

    // Deleted, it is cancelled and listed only with finished Schedules.
    let deleted = store
        .change_schedule(ALICE, &id, ScheduleState::Cancelled)
        .await
        .unwrap();
    assert_eq!(deleted.state(), ScheduleState::Cancelled);
    assert_eq!(deleted.next_due_at_ms, None);
    assert!(
        store
            .change_schedule(ALICE, &id, ScheduleState::Active)
            .await
            .is_err()
    );
    clock.store(SIX_PM + 8 * HOUR, Ordering::SeqCst);
    assert_eq!(store.sweep_schedules().await.unwrap(), 0);
    let open = store
        .list_schedules(ALICE, &ListSchedulesRequest::default())
        .await
        .unwrap();
    assert!(open.schedules.iter().all(|s| s.schedule_id != id));
    let all = store
        .list_schedules(
            ALICE,
            &ListSchedulesRequest {
                tag_id: Some("lead".into()),
                include_finished: true,
            },
        )
        .await
        .unwrap();
    assert!(all.schedules.iter().any(|s| s.schedule_id == id));
}

async fn tag_schedules_take_effect_when_the_turn_succeeds(
    store: &Store,
    host: &HostAuthority,
    clock: &Arc<AtomicI64>,
) {
    let start = SIX_PM + 9 * HOUR;
    clock.store(start, Ordering::SeqCst);
    submit(store, "lead", "ops").await;
    let (_, turn) = next(store, host).await.unwrap();
    let capabilities = store.attempt_capabilities(host, &turn).await.unwrap();
    assert!(capabilities.may_schedule);
    assert_eq!(capabilities.time_zone, "UTC");

    let first = store
        .create_attempt_schedule(host, &staged(&turn, "a", "30m"))
        .await
        .unwrap();
    let a = first.schedule.unwrap();
    assert_eq!(a.state(), ScheduleState::Staged);
    assert_eq!(a.created_by, "tag:lead");
    assert_eq!(a.session_id, "ops");
    assert_eq!(a.audience, None);
    assert!(first.pending.is_empty());
    assert_eq!(first.time_zone, "UTC");
    // A replay returns the same Schedule; the next one lists the first as pending.
    let replay = store
        .create_attempt_schedule(host, &staged(&turn, "a", "30m"))
        .await
        .unwrap();
    assert_eq!(replay.schedule.unwrap().schedule_id, a.schedule_id);
    let second = store
        .create_attempt_schedule(host, &staged(&turn, "b", "1h"))
        .await
        .unwrap();
    assert_eq!(second.pending.len(), 1);
    assert_eq!(second.pending[0].schedule_id, a.schedule_id);
    let b = second.schedule.unwrap();
    store
        .create_attempt_schedule(host, &staged(&turn, "c", "1h"))
        .await
        .unwrap();
    // At most three per turn.
    assert!(matches!(
        store
            .create_attempt_schedule(host, &staged(&turn, "d", "1h"))
            .await,
        Err(StoreError::FailedPrecondition(reason)) if reason.contains("at most 3")
    ));
    // Invalid times are refused with a reason the model can read.
    assert!(matches!(
        store
            .create_attempt_schedule(host, &staged(&turn, "e", "next tuesday"))
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    let cancelled = store
        .cancel_attempt_schedule(
            host,
            &CancelAttemptScheduleRequest {
                attempt: Some(turn.clone()),
                schedule_id: b.schedule_id.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        cancelled.schedule.unwrap().state(),
        ScheduleState::Cancelled
    );
    // A staged Schedule does not fire before its turn succeeds.
    assert_eq!(store.sweep_schedules().await.unwrap(), 0);
    finish(store, host, &turn, true).await;
    assert_eq!(
        store
            .get_schedule(ALICE, &a.schedule_id)
            .await
            .unwrap()
            .state(),
        ScheduleState::Active
    );
    clock.store(start + 31 * MINUTE, Ordering::SeqCst);
    assert_eq!(store.sweep_schedules().await.unwrap(), 1);
    let (woken, identity) = next(store, host).await.unwrap();
    assert_eq!(woken.session_id, "ops");
    assert!(woken.prompt.contains("you asked"), "{}", woken.prompt);
    assert!(woken.prompt.contains("Follow up a"), "{}", woken.prompt);
    // A woken turn may schedule again and cancel its Session's Schedules.
    let pending = store
        .create_attempt_schedule(host, &staged(&identity, "again", "2h"))
        .await
        .unwrap();
    assert_eq!(
        pending.pending.len(),
        1,
        "the third Schedule is still active"
    );
    finish(store, host, &identity, true).await;

    // A failed turn's Schedules are dropped.
    submit(store, "lead", "failing").await;
    let (_, failing) = next(store, host).await.unwrap();
    let dropped = store
        .create_attempt_schedule(host, &staged(&failing, "lost", "1h"))
        .await
        .unwrap()
        .schedule
        .unwrap();
    finish(store, host, &failing, false).await;
    assert!(matches!(
        store.get_schedule(ALICE, &dropped.schedule_id).await,
        Err(StoreError::NotFound(_))
    ));
    // So are a cancelled turn's, at the next sweep.
    submit(store, "lead", "cancelled").await;
    let (_, stopped) = next(store, host).await.unwrap();
    let orphan = store
        .create_attempt_schedule(host, &staged(&stopped, "orphan", "1h"))
        .await
        .unwrap()
        .schedule
        .unwrap();
    store.cancel_task(&stopped.task_id).await.unwrap();
    store.sweep_schedules().await.unwrap();
    assert!(matches!(
        store.get_schedule(ALICE, &orphan.schedule_id).await,
        Err(StoreError::NotFound(_))
    ));
    // Another Session's Schedule is not this turn's to cancel.
    submit(store, "lead", "elsewhere").await;
    let (_, elsewhere) = next(store, host).await.unwrap();
    assert!(matches!(
        store
            .cancel_attempt_schedule(
                host,
                &CancelAttemptScheduleRequest {
                    attempt: Some(elsewhere.clone()),
                    schedule_id: a.schedule_id.clone(),
                },
            )
            .await,
        Err(StoreError::NotFound(_))
    ));
    finish(store, host, &elsewhere, true).await;
    for schedule in store
        .list_schedules(
            ALICE,
            &ListSchedulesRequest {
                tag_id: Some("lead".into()),
                include_finished: false,
            },
        )
        .await
        .unwrap()
        .schedules
    {
        store
            .change_schedule(ALICE, &schedule.schedule_id, ScheduleState::Cancelled)
            .await
            .unwrap();
    }
}

async fn a_tag_without_the_action_cannot_schedule(store: &Store, host: &HostAuthority) {
    submit(store, "plain", "plain").await;
    let (task, turn) = next(store, host).await.unwrap();
    assert_eq!(task.allowed_actions, ["files:read"]);
    assert!(
        !store
            .attempt_capabilities(host, &turn)
            .await
            .unwrap()
            .may_schedule
    );
    assert!(matches!(
        store
            .create_attempt_schedule(host, &staged(&turn, "plain", "1h"))
            .await,
        Err(StoreError::PermissionDenied)
    ));
    finish(store, host, &turn, true).await;
}

async fn limits_refuse(store: &Store, clock: &Arc<AtomicI64>) {
    clock.store(NOW, Ordering::SeqCst);
    for (at, every) in [
        ("30s", ""),
        ("367d", ""),
        ("tomorrow", ""),
        ("", "*/15 * * * *"),
        ("", "not a cron"),
        ("2h", "@daily"),
        ("", ""),
    ] {
        assert!(
            matches!(
                store
                    .create_schedule(
                        ALICE,
                        &create("watcher", &format!("bad-{at}-{every}"), "x", at, every)
                    )
                    .await,
                Err(StoreError::InvalidArgument(_))
            ),
            "{at} {every}"
        );
    }
    assert!(matches!(
        store
            .create_schedule(
                ALICE,
                &create("watcher", "long", &"x".repeat(4_001), "2h", "")
            )
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    let mut zoned = create("watcher", "zoned", "Standup", "", "0 9 * * MON-FRI");
    zoned.time_zone = Some("Europe/Berlin".into());
    let zoned = store.create_schedule(ALICE, &zoned).await.unwrap();
    // Monday 18 March 2030, 09:00 in Berlin (CET) is 08:00 UTC.
    assert_eq!(zoned.next_due_at_ms, Some(1_900_051_200_000));
    for index in 1..25 {
        store
            .create_schedule(
                ALICE,
                &create("watcher", &format!("cap-{index}"), "x", "1d", ""),
            )
            .await
            .unwrap();
    }
    assert!(matches!(
        store
            .create_schedule(ALICE, &create("watcher", "cap-26", "x", "1d", ""))
            .await,
        Err(StoreError::FailedPrecondition(reason)) if reason.contains("25 Schedules")
    ));
    for schedule in store
        .list_schedules(
            ALICE,
            &ListSchedulesRequest {
                tag_id: Some("watcher".into()),
                include_finished: false,
            },
        )
        .await
        .unwrap()
        .schedules
    {
        store
            .change_schedule(ALICE, &schedule.schedule_id, ScheduleState::Cancelled)
            .await
            .unwrap();
    }
}

async fn objectives_wait_on_schedules(store: &Store, host: &HostAuthority, clock: &Arc<AtomicI64>) {
    let start = NOW + 30 * 24 * HOUR;
    clock.store(start, Ordering::SeqCst);
    let objective = store
        .create_objective(
            ALICE,
            &CreateObjectiveRequest {
                objective_id: "watch".into(),
                operation_id: "create-watch".into(),
                owner_tag_id: "lead".into(),
                outcome: "Land PR 412".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let status = || async { store.get_objective(ALICE, "watch").await.unwrap().status() };
    // A turn that ends with nothing running is woken once.
    let (task, turn) = next(store, host).await.unwrap();
    assert_eq!(task.task_id, objective.starting_task_id);
    finish(store, host, &turn, true).await;
    let (idle, turn) = next(store, host).await.unwrap();
    assert!(
        idle.prompt
            .contains("Your last turn ended with nothing running")
    );
    // Its idle turn schedules a check, so ending again is a wait, not a block.
    let check = store
        .create_attempt_schedule(host, &staged(&turn, "ci", "1h"))
        .await
        .unwrap()
        .schedule
        .unwrap();
    assert_eq!(check.objective_id.as_deref(), Some("watch"));
    finish(store, host, &turn, true).await;
    assert_eq!(status().await, ObjectiveStatus::Working);
    assert!(next(store, host).await.is_none());
    // The wake-up is a fresh opportunity: ending it with nothing scheduled wakes once more
    // instead of blocking.
    clock.store(start + HOUR, Ordering::SeqCst);
    assert_eq!(store.sweep_schedules().await.unwrap(), 1);
    let (woken, turn) = next(store, host).await.unwrap();
    assert!(woken.prompt.starts_with("Scheduled wake-up."));
    // Schedule another check, then pause: the fired turn stays queued.
    store
        .create_attempt_schedule(host, &staged(&turn, "ci-2", "1h"))
        .await
        .unwrap();
    finish(store, host, &turn, true).await;
    assert_eq!(status().await, ObjectiveStatus::Working);
    store
        .pause_objective(
            ALICE,
            &ObjectiveActionRequest {
                objective_id: "watch".into(),
                operation_id: "pause-watch".into(),
                reason: String::new(),
            },
        )
        .await
        .unwrap();
    clock.store(start + 2 * HOUR, Ordering::SeqCst);
    assert_eq!(store.sweep_schedules().await.unwrap(), 1);
    assert!(
        next(store, host).await.is_none(),
        "a paused Objective holds the turn"
    );
    store
        .resume_objective(
            ALICE,
            &ObjectiveActionRequest {
                objective_id: "watch".into(),
                operation_id: "resume-watch".into(),
                reason: String::new(),
            },
        )
        .await
        .unwrap();
    let (_, turn) = next(store, host).await.unwrap();
    let later = store
        .create_attempt_schedule(host, &staged(&turn, "ci-3", "1h"))
        .await
        .unwrap()
        .schedule
        .unwrap();
    finish(store, host, &turn, true).await;
    // Closing the Objective cancels its Schedules.
    store
        .cancel_objective(
            ALICE,
            &ObjectiveActionRequest {
                objective_id: "watch".into(),
                operation_id: "cancel-watch".into(),
                reason: String::new(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .get_schedule(ALICE, &later.schedule_id)
            .await
            .unwrap()
            .state(),
        ScheduleState::Cancelled
    );
    // Without a Schedule, the turn after a wake-up is woken again rather than blocked.
    let start = start + 10 * HOUR;
    clock.store(start, Ordering::SeqCst);
    store
        .create_objective(
            ALICE,
            &CreateObjectiveRequest {
                objective_id: "reset".into(),
                operation_id: "create-reset".into(),
                owner_tag_id: "releaser".into(),
                outcome: "Watch the release".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let (_, turn) = next(store, host).await.unwrap();
    finish(store, host, &turn, true).await;
    let (_, turn) = next(store, host).await.unwrap(); // the idle wake: idle count 1
    store
        .create_attempt_schedule(host, &staged(&turn, "reset-check", "1h"))
        .await
        .unwrap();
    finish(store, host, &turn, true).await;
    clock.store(start + HOUR, Ordering::SeqCst);
    assert_eq!(store.sweep_schedules().await.unwrap(), 1);
    let (_, turn) = next(store, host).await.unwrap();
    finish(store, host, &turn, true).await;
    assert_eq!(
        store.get_objective(ALICE, "reset").await.unwrap().status(),
        ObjectiveStatus::Working,
        "the fired turn reset the idle count"
    );
    let (idle, turn) = next(store, host).await.unwrap();
    assert!(
        idle.prompt
            .contains("Your last turn ended with nothing running")
    );
    finish(store, host, &turn, true).await;
    assert_eq!(
        store.get_objective(ALICE, "reset").await.unwrap().status(),
        ObjectiveStatus::Blocked
    );
}

async fn retiring_a_tag_cancels_its_schedules(store: &Store) {
    let schedule = store
        .create_schedule(ALICE, &create("temp", "temp", "Ping", "", "@daily"))
        .await
        .unwrap();
    store.retire_tag("temp", false).await.unwrap();
    assert_eq!(
        store
            .get_schedule(ALICE, &schedule.schedule_id)
            .await
            .unwrap()
            .state(),
        ScheduleState::Cancelled
    );
}

async fn replicas_fire_each_occurrence_once(
    url: &str,
    store: &Store,
    host: &HostAuthority,
    clock: &Arc<AtomicI64>,
) {
    let start = NOW + 60 * 24 * HOUR;
    clock.store(start, Ordering::SeqCst);
    let mut ids = vec![];
    for index in 0..5 {
        ids.push(
            store
                .create_schedule(
                    ALICE,
                    &create("lead", &format!("replica-{index}"), "Race", "", "@hourly"),
                )
                .await
                .unwrap()
                .schedule_id,
        );
    }
    let other = open(url, clock).await;
    clock.store(start + 2 * HOUR, Ordering::SeqCst);
    let (first, second) = tokio::join!(store.sweep_schedules(), other.sweep_schedules());
    // Each Schedule fires one turn; the other occurrences in the outage are missed.
    assert_eq!(first.unwrap() + second.unwrap(), 5);
    let (first, second) = tokio::join!(store.sweep_schedules(), other.sweep_schedules());
    assert_eq!(first.unwrap() + second.unwrap(), 0);
    for id in &ids {
        let schedule = store.get_schedule(ALICE, id).await.unwrap();
        assert_eq!(schedule.fire_count, 1);
        assert_eq!(schedule.missed_count, 1);
    }
    other.close().await;
    // The five turns queue in the conversation's one Session, one at a time.
    for _ in 0..5 {
        let (task, turn) = next(store, host).await.unwrap();
        assert!(task.prompt.contains("\"Race\""));
        finish(store, host, &turn, true).await;
    }
}

#[tokio::test]
async fn sqlite_schedules_contract() {
    let directory = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("schedules.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL server"]
async fn postgres_schedules_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_schedules_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { contract(url.to_string()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    result.expect("PostgreSQL Schedules contract failed");
}
