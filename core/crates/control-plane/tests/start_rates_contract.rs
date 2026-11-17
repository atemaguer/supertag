//! Start rates: a Tag over its rate leaves its unprompted turns queued until the window has room,
//! while a person's message always starts and counts, other Tags keep running, and the wait names
//! the next start.
mod support;

use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
/// Sun 17 Mar 2030 17:46:40 UTC.
const NOW: i64 = 1_900_000_000_000;

async fn open(url: &str, clock: &Arc<AtomicI64>) -> Store {
    let clock = Arc::clone(clock);
    Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || clock.load(Ordering::SeqCst))
        .with_time_zone("UTC")
        .unwrap()
}

/// Claims the next Task this host may take, if any, and runs it to success.
async fn claim(store: &Store, host: &HostAuthority) -> Option<Task> {
    let assignment = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()?;
    let task = assignment.task.unwrap();
    store
        .start_task(
            host,
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
            host,
            &FinishTaskRequest {
                task_id: task.task_id.clone(),
                attempt_id: assignment.attempt_id,
                lease_token: assignment.lease_token,
                result: "Checked".into(),
                succeeded: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    Some(task)
}

fn tag(id: &str, start_rate: Option<StartRate>) -> PutTagRequest {
    PutTagRequest {
        tag_id: id.into(),
        instructions: "Watch".into(),
        allowed_actions: vec!["files:read".into()],
        start_rate,
        ..Default::default()
    }
}

async fn contract(url: String) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let store = open(&url, &clock).await;
    let host = support::register_host(&store, "worker").await;
    let rate = StartRate {
        starts: 2,
        per_ms: HOUR as u64,
    };
    let watcher = store
        .put_tag_spec(tag("watcher", Some(rate)))
        .await
        .unwrap();
    assert_eq!(watcher.start_rate, Some(rate));
    store.put_tag_spec(tag("other", None)).await.unwrap();
    // Out of bounds is refused; omitting it keeps it.
    for refused in [
        StartRate {
            starts: 10,
            per_ms: 30_000,
        },
        StartRate {
            starts: 10_001,
            per_ms: HOUR as u64,
        },
        StartRate {
            starts: 1,
            per_ms: 8 * 24 * HOUR as u64,
        },
    ] {
        assert!(matches!(
            store.put_tag_spec(tag("watcher", Some(refused))).await,
            Err(StoreError::InvalidArgument(_))
        ));
    }
    assert_eq!(
        store
            .put_tag_spec(tag("watcher", None))
            .await
            .unwrap()
            .start_rate,
        Some(rate)
    );

    // Three people's Schedules come due at once, each in its own conversation.
    for principal in ["operator:alice", "operator:bob", "operator:carol"] {
        store
            .create_schedule(
                principal,
                &CreateScheduleRequest {
                    operation_id: format!("check-{principal}"),
                    tag_id: "watcher".into(),
                    note: "Check CI".into(),
                    at: "1m".into(),
                    every: String::new(),
                    time_zone: None,
                },
            )
            .await
            .unwrap();
    }
    clock.store(NOW + MINUTE, Ordering::SeqCst);
    assert_eq!(store.sweep_schedules().await.unwrap(), 3);
    let first = claim(&store, &host).await.expect("first start");
    let second = claim(&store, &host).await.expect("second start");
    assert!(first.prompt.starts_with("Scheduled wake-up.") && second.tag_id == "watcher");
    // The third waits: the window holds two starts.
    assert!(claim(&store, &host).await.is_none());
    let mut waiting = None;
    for principal in ["operator:alice", "operator:bob", "operator:carol"] {
        for schedule in store
            .list_schedules(
                principal,
                &ListSchedulesRequest {
                    include_finished: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .schedules
        {
            let task = store
                .get_task(schedule.last_task_id.as_deref().unwrap())
                .await
                .unwrap();
            if task.state() == TaskState::Queued {
                waiting = Some(task);
            }
        }
    }
    let waiting = waiting.expect("the third fire waits");
    let diagnosis = store
        .diagnose_task_placement(&waiting.task_id)
        .await
        .unwrap();
    assert_eq!(diagnosis.requirement, "start-rate", "{diagnosis:?}");
    assert!(
        diagnosis
            .summary
            .contains("started 2 Task Attempts in the last 1h")
            && diagnosis.summary.contains("2030-03-17 18:47 UTC"),
        "{}",
        diagnosis.summary
    );

    // Another Tag keeps running, and a person's message always starts, and counts.
    store
        .submit_task(
            "operator:alice",
            &SubmitTaskRequest {
                tag_id: "other".into(),
                session_id: "other-session".into(),
                operation_id: "other".into(),
                prompt: "Work".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(claim(&store, &host).await.unwrap().tag_id, "other");
    let asked = store
        .send_message(
            "operator:dave",
            &SendMessageRequest {
                tag_id: "watcher".into(),
                text: "Is CI green?".into(),
                operation_id: "ask".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let started = claim(&store, &host).await.expect("a person's turn starts");
    assert_eq!(started.task_id, asked.task.unwrap().task_id);
    assert_eq!(store.get_tag("watcher").await.unwrap().starts_in_window, 3);
    assert!(claim(&store, &host).await.is_none());

    // Once the first starts leave the window, the waiting fire starts.
    clock.store(NOW + MINUTE + HOUR + 1, Ordering::SeqCst);
    assert_eq!(
        claim(&store, &host).await.expect("room again").task_id,
        waiting.task_id
    );

    // Removing the rate lifts it.
    let cleared = store
        .put_tag_spec(tag(
            "watcher",
            Some(StartRate {
                starts: 0,
                per_ms: 0,
            }),
        ))
        .await
        .unwrap();
    assert_eq!(cleared.start_rate, None);
    assert_eq!(store.get_tag("watcher").await.unwrap().starts_in_window, 0);
    store.close().await;
}

#[tokio::test]
async fn sqlite_start_rates_contract() {
    let directory = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("start-rates.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL server"]
async fn postgres_start_rates_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_start_rates_{}", Uuid::new_v4().simple());
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
    result.expect("PostgreSQL start rate contract failed");
}
