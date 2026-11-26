//! A Tag's open Work Sessions: at its `max_work_sessions`, `start_session` is refused with the
//! open Work Sessions listed; closing one, by the Tag, an operator, a pulled delivery, its
//! Objective closing, or 14 days without activity, makes room. An explicit close is final;
//! continuing an idle-closed one reopens it when there is room.
mod support;

use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OP: &str = "operator:alice";
const NOW: i64 = 1_893_456_000_000;

async fn submit(store: &Store, tag: &str, session: &str) -> Task {
    store
        .submit_task(
            OP,
            &SubmitTaskRequest {
                tag_id: tag.into(),
                session_id: session.into(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: "Plan the work".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
}

async fn run(store: &Store, host: &HostAuthority, expected: &str) -> InspectAttemptRequest {
    let assignment = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .unwrap();
    let task = assignment.task.unwrap();
    assert_eq!(task.task_id, expected);
    let attempt = InspectAttemptRequest {
        task_id: task.task_id,
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    };
    store
        .start_task(
            host,
            &StartTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    attempt
}

fn start(operation: &str, title: &str) -> StartWorkSessionRequest {
    StartWorkSessionRequest {
        operation_id: operation.into(),
        title: title.into(),
        instruction: "Do this part".into(),
        ..Default::default()
    }
}

fn close(session: &str) -> CloseAttemptWorkSessionRequest {
    CloseAttemptWorkSessionRequest {
        work_session_id: session.into(),
    }
}

async fn put(store: &Store, tag: &str, max: Option<u32>) -> Result<Tag, StoreError> {
    store
        .put_tag_spec(PutTagRequest {
            tag_id: tag.into(),
            instructions: "Plan and delegate".into(),
            allowed_actions: vec!["files:read".into()],
            max_work_sessions: max,
            ..Default::default()
        })
        .await
}

async fn contract(url: String) {
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(|| NOW);
    let host = support::register_host(&store, "worker").await;

    // The setting: 8 by default, 1 to 1,024, kept when omitted.
    assert_eq!(
        put(&store, "lead", None).await.unwrap().max_work_sessions,
        8
    );
    for invalid in [0, 1_025] {
        assert!(matches!(
            put(&store, "lead", Some(invalid)).await,
            Err(StoreError::InvalidArgument(_))
        ));
    }
    assert_eq!(
        put(&store, "lead", Some(1_024))
            .await
            .unwrap()
            .max_work_sessions,
        1_024
    );
    assert_eq!(
        put(&store, "lead", Some(2))
            .await
            .unwrap()
            .max_work_sessions,
        2
    );
    assert_eq!(
        put(&store, "lead", None).await.unwrap().max_work_sessions,
        2
    );
    assert_eq!(store.get_tag("lead").await.unwrap().max_work_sessions, 2);

    // Two conversations of one Tag share its limit.
    let first = submit(&store, "lead", "first").await;
    let second = submit(&store, "lead", "second").await;
    let a = run(&store, &host, &first.task_id).await;
    let b = run(&store, &host, &second.task_id).await;
    let capabilities = store
        .attempt_capabilities(&supertag_control_plane::AttemptAccess::new(&host, &a))
        .await
        .unwrap();
    assert!(capabilities.may_start_work_session);
    assert_eq!(
        (
            capabilities.open_work_sessions,
            capabilities.max_work_sessions
        ),
        (0, 2)
    );
    let one = store
        .start_work_session(
            &supertag_control_plane::AttemptAccess::new(&host, &a),
            &start("one", "Draft the plan"),
        )
        .await
        .unwrap();
    let two = store
        .start_work_session(
            &supertag_control_plane::AttemptAccess::new(&host, &a),
            &start("two", "Check the tests"),
        )
        .await
        .unwrap();
    assert_eq!(one.closed_at_ms, None);
    let capabilities = store
        .attempt_capabilities(&supertag_control_plane::AttemptAccess::new(&host, &b))
        .await
        .unwrap();
    assert_eq!(capabilities.open_work_sessions, 2);

    // At the limit, a start is refused with the open Work Sessions, and none starts.
    let refused = store
        .start_work_session(
            &supertag_control_plane::AttemptAccess::new(&host, &a),
            &start("three", "One too many"),
        )
        .await;
    let Err(StoreError::FailedPrecondition(reason)) = refused else {
        panic!("expected the limit refusal: {refused:?}")
    };
    assert!(reason.contains("2 of 2 Work Sessions open"), "{reason}");
    assert!(reason.contains("continue_session") && reason.contains("close_session"));
    assert!(
        reason.contains(&format!(
            "- {} \"Draft the plan\" (queued, this conversation)",
            one.work_session_id
        )),
        "{reason}"
    );
    assert!(reason.contains(&two.work_session_id), "{reason}");
    let elsewhere = store
        .start_work_session(
            &supertag_control_plane::AttemptAccess::new(&host, &b),
            &start("elsewhere", "From the other conversation"),
        )
        .await;
    let Err(StoreError::FailedPrecondition(reason)) = elsewhere else {
        panic!("the limit counts every conversation: {elsewhere:?}")
    };
    // The other conversation is shared, so the turn sees its titles too.
    assert!(reason.contains("\"Draft the plan\" (queued)"), "{reason}");

    // The Tag closes one from its other conversation, and a start fits again.
    let closed = store
        .close_attempt_work_session(
            &supertag_control_plane::AttemptAccess::new(&host, &b),
            &close(&one.work_session_id),
        )
        .await
        .unwrap();
    assert!(closed.closed_at_ms.is_some());
    assert_eq!(closed.close_reason(), WorkSessionCloseReason::Tag);
    // Closing again changes nothing.
    let again = store
        .close_attempt_work_session(
            &supertag_control_plane::AttemptAccess::new(&host, &b),
            &close(&one.work_session_id),
        )
        .await
        .unwrap();
    assert_eq!(again.closed_at_ms, closed.closed_at_ms);
    let three = store
        .start_work_session(
            &supertag_control_plane::AttemptAccess::new(&host, &b),
            &start("three", "The next part"),
        )
        .await
        .unwrap();

    // A Work Session the Tag closed is final.
    let continued = store
        .continue_work_session(
            &supertag_control_plane::AttemptAccess::new(&host, &a),
            &ContinueWorkSessionRequest {
                operation_id: "continue-closed".into(),
                work_session_id: one.work_session_id.clone(),
                message: "Keep going".into(),
            },
        )
        .await;
    assert!(
        matches!(&continued, Err(StoreError::FailedPrecondition(reason)) if reason.contains("this Work Session was closed (the Tag closed it); start a new one")),
        "{continued:?}"
    );

    // Another Tag's Work Session is not this Tag's to close.
    put(&store, "other", None).await.unwrap();
    assert!(matches!(
        store
            .close_attempt_work_session(
                &supertag_control_plane::AttemptAccess::new(&host, &a),
                &close("work/00000000-0000-0000-0000-000000000000")
            )
            .await,
        Err(StoreError::NotFound(_))
    ));

    // An operator closes one, recording a pulled delivery; the list counts what is open.
    let pulled = store
        .close_work_session(
            OP,
            &CloseWorkSessionRequest {
                work_session_id: two.work_session_id.clone(),
                delivery_pulled: true,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        pulled.close_reason(),
        WorkSessionCloseReason::DeliveryPulled
    );
    let listed = store
        .list_work_sessions(
            OP,
            &ListWorkSessionsRequest {
                parent_tag_id: "lead".into(),
                parent_session_id: "first".into(),
                limit: 10,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        (listed.open_work_sessions, listed.max_work_sessions),
        (1, 2)
    );
    assert!(
        listed
            .work_sessions
            .iter()
            .all(|work| work.closed_at_ms.is_some())
    );
    let operator = store
        .close_work_session(
            OP,
            &CloseWorkSessionRequest {
                work_session_id: three.work_session_id.clone(),
                delivery_pulled: false,
            },
        )
        .await
        .unwrap();
    assert_eq!(operator.close_reason(), WorkSessionCloseReason::Operator);
    // A client sees only its own conversations' Work Sessions.
    assert!(matches!(
        store
            .close_work_session(
                "client:laptop",
                &CloseWorkSessionRequest {
                    work_session_id: three.work_session_id.clone(),
                    delivery_pulled: false,
                },
            )
            .await,
        Err(StoreError::NotFound(_))
    ));

    // Closing an Objective closes its Work Sessions. Closing a Work Session leaves its queued
    // turn; cancel them so the Objective's turn is claimed next.
    for work in [&one, &two, &three] {
        store.cancel_task(&work.latest_task_id).await.unwrap();
    }
    let objective = store
        .create_objective(
            OP,
            &CreateObjectiveRequest {
                objective_id: "ship".into(),
                operation_id: "create-ship".into(),
                owner_tag_id: "other".into(),
                outcome: "Ship it".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let owner = run(&store, &host, &objective.starting_task_id).await;
    let delegated = store
        .start_work_session(
            &supertag_control_plane::AttemptAccess::new(&host, &owner),
            &start("objective", "Objective part"),
        )
        .await
        .unwrap();
    assert_eq!(delegated.objective_id.as_deref(), Some("ship"));
    store
        .cancel_objective(
            OP,
            &ObjectiveActionRequest {
                objective_id: "ship".into(),
                operation_id: "cancel-ship".into(),
                reason: String::new(),
            },
        )
        .await
        .unwrap();
    let after = store
        .get_work_session(OP, &delegated.work_session_id)
        .await
        .unwrap();
    assert_eq!(
        after.close_reason(),
        WorkSessionCloseReason::ObjectiveClosed
    );
    store.close().await;
}

async fn finish(store: &Store, host: &HostAuthority, attempt: &InspectAttemptRequest) {
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                succeeded: true,
                result: "Done".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

/// Claims, starts and finishes every queued Task, the turns and their reports.
async fn drain(store: &Store, host: &HostAuthority) {
    while let Some(assignment) = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
    {
        run_claimed(store, host, assignment).await;
    }
}

async fn run_claimed(store: &Store, host: &HostAuthority, assignment: Assignment) {
    let task = assignment.task.unwrap();
    let attempt = InspectAttemptRequest {
        task_id: task.task_id,
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    };
    store
        .start_task(
            host,
            &StartTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    finish(store, host, &attempt).await;
}

/// Fourteen days without activity close a Work Session; continuing it reopens it under the limit
/// and is refused at it, while an explicit close stays final.
async fn reopen_and_idle(url: String) {
    const DAY: i64 = 24 * 3_600_000;
    let clock = Arc::new(AtomicI64::new(NOW));
    let now = Arc::clone(&clock);
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(move || now.load(Ordering::SeqCst));
    let host = support::register_host(&store, "worker").await;
    put(&store, "solo", Some(1)).await.unwrap();
    let say = |text: &str| SendMessageRequest {
        tag_id: "solo".into(),
        text: text.into(),
        operation_id: Uuid::new_v4().to_string(),
        ..Default::default()
    };
    let first = store
        .send_message(OP, &say("Draft it"))
        .await
        .unwrap()
        .task
        .unwrap();
    let a = run(&store, &host, &first.task_id).await;
    let x = store
        .start_work_session(
            &supertag_control_plane::AttemptAccess::new(&host, &a),
            &start("x", "Draft"),
        )
        .await
        .unwrap();
    finish(&store, &host, &a).await;
    drain(&store, &host).await; // the Work Session's turn and its report

    // Thirteen days later it is still open; fifteen days later the sweep closes it as idle.
    clock.store(NOW + 13 * DAY, Ordering::SeqCst);
    store.sweep_work_sessions().await.unwrap();
    let read = |id: String| {
        let store = store.clone();
        async move { store.get_work_session(OP, &id).await.unwrap() }
    };
    assert_eq!(read(x.work_session_id.clone()).await.closed_at_ms, None);
    clock.store(NOW + 15 * DAY, Ordering::SeqCst);
    store.sweep_work_sessions().await.unwrap();
    let idle = read(x.work_session_id.clone()).await;
    assert_eq!(idle.close_reason(), WorkSessionCloseReason::Idle);
    assert_eq!(idle.closed_at_ms, Some(NOW + 15 * DAY));
    // The conversation's report turn says why it closed.
    let page = store
        .list_messages(
            OP,
            &ListMessagesRequest {
                tag_id: "solo".into(),
                limit: 20,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        page.messages
            .iter()
            .any(|message| message.work_session_report_id.as_deref()
                == Some(x.work_session_id.as_str())
                && message.work_session_close_reason() == WorkSessionCloseReason::Idle)
    );

    // At the limit, continuing the idle Work Session is refused with the open ones listed.
    let second = store
        .send_message(OP, &say("Another part"))
        .await
        .unwrap()
        .task
        .unwrap();
    let b = run(&store, &host, &second.task_id).await;
    let y = store
        .start_work_session(
            &supertag_control_plane::AttemptAccess::new(&host, &b),
            &start("y", "Another"),
        )
        .await
        .unwrap();
    let continuing = |session: &str, operation: &str| ContinueWorkSessionRequest {
        operation_id: operation.into(),
        work_session_id: session.into(),
        message: "Revise it".into(),
    };
    let refused = store
        .continue_work_session(
            &supertag_control_plane::AttemptAccess::new(&host, &b),
            &continuing(&x.work_session_id, "at-limit"),
        )
        .await;
    assert!(
        matches!(&refused, Err(StoreError::FailedPrecondition(reason)) if reason.contains("1 of 1 Work Sessions open")),
        "{refused:?}"
    );
    assert!(read(x.work_session_id.clone()).await.closed_at_ms.is_some());
    // An explicit close is final.
    store
        .close_attempt_work_session(
            &supertag_control_plane::AttemptAccess::new(&host, &b),
            &close(&y.work_session_id),
        )
        .await
        .unwrap();
    let final_close = store
        .continue_work_session(
            &supertag_control_plane::AttemptAccess::new(&host, &b),
            &continuing(&y.work_session_id, "closed"),
        )
        .await;
    assert!(
        matches!(&final_close, Err(StoreError::FailedPrecondition(reason)) if reason.contains("was closed (the Tag closed it)")),
        "{final_close:?}"
    );
    // Under the limit, continuing the idle Work Session reopens it.
    let reopened = store
        .continue_work_session(
            &supertag_control_plane::AttemptAccess::new(&host, &b),
            &continuing(&x.work_session_id, "reopen"),
        )
        .await
        .unwrap();
    assert_eq!(reopened.closed_at_ms, None);
    assert_eq!(reopened.close_reason(), WorkSessionCloseReason::Unspecified);
    finish(&store, &host, &b).await;
    store.close().await;
}

/// Upgrading closes the Work Sessions that had finished, except each Tag's four newest and one
/// waiting on an answer, so no Tag starts at its limit and recent work can still be continued.
async fn upgrade(url: String) {
    sqlx::any::install_default_drivers();
    let mut connection = sqlx::AnyConnection::connect(&url).await.unwrap();
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
                .and_then(|name| name.to_str())
                .and_then(|name| name.get(..4))
                .and_then(|number| number.parse::<u32>().ok())
                .is_some_and(|number| number <= 84)
        })
        .collect();
    paths.sort();
    for path in paths {
        sqlx::raw_sql(&std::fs::read_to_string(path).unwrap())
            .execute(&mut connection)
            .await
            .unwrap();
    }
    sqlx::raw_sql(
        "INSERT INTO supertag_v2_tags (tag_id,instructions,allowed_actions,revision) VALUES ('lead','Lead','[]',1);
         INSERT INTO supertag_v2_tasks (task_id,tag_id,session_id,prompt,instructions,allowed_actions,tag_revision,state,accepted_order) VALUES
           ('parent','lead','p','Plan','Lead','[]',1,3,1),
           ('done','lead','work/done','Child','Lead','[]',1,3,2),
           ('asking','lead','work/asking','Child','Lead','[]',1,3,3),
           ('running','lead','work/running','Child','Lead','[]',1,2,4),
           ('n1','lead','work/n1','Child','Lead','[]',1,3,5),
           ('n2','lead','work/n2','Child','Lead','[]',1,4,6),
           ('n3','lead','work/n3','Child','Lead','[]',1,3,7),
           ('n4','lead','work/n4','Child','Lead','[]',1,3,8);
         INSERT INTO supertag_v2_work_sessions (work_session_id,title,parent_tag_id,parent_session_id,starter_task_id,tag_id,latest_task_id,created_order) VALUES
           ('work/done','Done','lead','p','parent','lead','done',2),
           ('work/asking','Asking','lead','p','parent','lead','asking',3),
           ('work/running','Running','lead','p','parent','lead','running',4),
           ('work/n1','Newer','lead','p','parent','lead','n1',5),
           ('work/n2','Newer','lead','p','parent','lead','n2',6),
           ('work/n3','Newer','lead','p','parent','lead','n3',7),
           ('work/n4','Newest','lead','p','parent','lead','n4',8);
         INSERT INTO supertag_v2_work_session_questions (attempt_id,task_id,work_session_id,operation_id,text,asked_at_ms,published_at_ms) VALUES
           ('a','asking','work/asking','o','Which branch?',1,1);
         UPDATE supertag_v2_write_order SET revision=8 WHERE singleton=1;",
    )
    .execute(&mut connection)
    .await
    .unwrap();
    connection.close().await.unwrap();
    let store = Store::open(&url).await.unwrap();
    let mut tx_check = sqlx::AnyConnection::connect(&url).await.unwrap();
    let rows: Vec<(String, Option<i64>, i64)> = sqlx::query_as(
        "SELECT work_session_id, closed_at_ms, close_reason FROM supertag_v2_work_sessions ORDER BY work_session_id",
    )
    .fetch_all(&mut tx_check)
    .await
    .unwrap();
    tx_check.close().await.unwrap();
    let state: Vec<(&str, bool, i64)> = rows
        .iter()
        .map(|(id, closed, reason)| (id.as_str(), closed.is_some(), *reason))
        .collect();
    assert_eq!(
        state,
        [
            ("work/asking", false, 0),
            ("work/done", true, WorkSessionCloseReason::Upgrade as i64),
            ("work/n1", false, 0),
            ("work/n2", false, 0),
            ("work/n3", false, 0),
            ("work/n4", false, 0),
            ("work/running", false, 0),
        ]
    );
    assert_eq!(store.get_tag("lead").await.unwrap().max_work_sessions, 8);
    store.close().await;
}

#[tokio::test]
async fn sqlite_work_session_limit_contract() {
    let directory = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("limit.db").display()
    ))
    .await;
    upgrade(format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("upgrade.db").display()
    ))
    .await;
    reopen_and_idle(format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("idle.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL server"]
async fn postgres_work_session_limit_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    let mut urls = vec![];
    for kind in ["limit", "upgrade", "idle"] {
        let name = format!("supertag_ws_{kind}_{}", Uuid::new_v4().simple());
        admin
            .execute(format!("CREATE DATABASE {name}").as_str())
            .await
            .unwrap();
        let mut url = url::Url::parse(admin_url.trim()).unwrap();
        url.set_path(&name);
        urls.push((name, url.to_string()));
    }
    let (limit, upgrade_url, idle) = (urls[0].1.clone(), urls[1].1.clone(), urls[2].1.clone());
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move {
                contract(limit).await;
                upgrade(upgrade_url).await;
                reopen_and_idle(idle).await;
            })
            .await
        })
        .await;
    for (name, _) in urls {
        admin
            .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
            .await
            .unwrap();
    }
    admin.close().await.unwrap();
    result.expect("PostgreSQL Work Session limit contract failed");
}
