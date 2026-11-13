//! Objectives started and steered from a Slack thread (TS
//! `tests/objective-surface-safety.test.ts`, `tests/objective-thread-routing.test.ts`,
//! `tests/objective-surface-execution.test.ts`).
mod support;

use sqlx::{Connection, Executor, Row};
use supertag_control_plane::{HostAuthority, Store};
use supertag_protocol::v2::{
    AcceptSlackEventRequest, FinishTaskRequest, ListObjectivesRequest, Objective, ObjectiveSignal,
    ObjectiveStatus, StartTaskRequest, Task, TaskState,
};
use uuid::Uuid;

const PRINCIPAL: &str = "connector:slack-objectives";
const HOME: &str = "1794470000.100000";

fn event(id: &str, ts: &str, thread: &str, mention: bool, text: &str) -> AcceptSlackEventRequest {
    AcceptSlackEventRequest {
        account_id: "slack-objectives".into(),
        event_id: id.into(),
        team_id: "TTEAM1".into(),
        channel_id: "CCHANNEL1".into(),
        message_ts: ts.into(),
        thread_ts: thread.into(),
        prompt: text.into(),
        mention_tag_id: mention.then(|| "builder".into()),
    }
}

async fn accept(store: &Store, input: AcceptSlackEventRequest) -> Task {
    store
        .accept_slack_event(PRINCIPAL, &input)
        .await
        .unwrap()
        .task
        .expect("accepted Slack message")
}

async fn objectives(store: &Store) -> Vec<Objective> {
    store
        .list_objectives(&ListObjectivesRequest::default())
        .await
        .unwrap()
}

async fn reply_route(url: &str, task: &str) -> Option<(String, String, String)> {
    sqlx::any::install_default_drivers();
    let mut connection = sqlx::AnyConnection::connect(url).await.unwrap();
    let row = sqlx::query(
        "SELECT conversation_id, thread_id, text FROM supertag_v2_replies WHERE task_id=$1",
    )
    .bind(task)
    .fetch_optional(&mut connection)
    .await
    .unwrap();
    connection.close().await.unwrap();
    row.map(|row| {
        (
            row.try_get("conversation_id").unwrap(),
            row.try_get::<Option<String>, _>("thread_id")
                .unwrap()
                .unwrap(),
            row.try_get("text").unwrap(),
        )
    })
}

async fn finish(store: &Store, host: &HostAuthority, task: &str, signal: ObjectiveSignal) {
    let assignment = store
        .claim_task(host, &format!("claim-{task}"))
        .await
        .unwrap()
        .expect("queued Task");
    assert_eq!(assignment.task.as_ref().unwrap().task_id, task);
    store
        .start_task(
            host,
            &StartTaskRequest {
                task_id: task.into(),
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
                task_id: task.into(),
                attempt_id: assignment.attempt_id,
                lease_token: assignment.lease_token,
                result: format!("Result of {task}"),
                succeeded: true,
                objective_signal: signal as i32,
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

/// A settled Control Plane answer: no execution, and its reply is queued for the thread.
async fn answered(store: &Store, url: &str, task: &Task, expected: &str) {
    assert_eq!(task.state(), TaskState::Succeeded, "{task:?}");
    assert!(task.allowed_actions.is_empty());
    let stored = store.get_task(&task.task_id).await.unwrap();
    let text = stored.result.unwrap();
    assert!(text.starts_with(expected), "{text}");
    let (channel, thread, reply) = reply_route(url, &task.task_id).await.unwrap();
    assert_eq!((channel.as_str(), thread.as_str()), ("CCHANNEL1", HOME));
    assert_eq!(reply, text);
}

async fn contract(url: String) {
    let store = Store::open(&url).await.unwrap();
    store
        .put_tag(
            "builder",
            "Builder",
            vec!["files:read".into(), "files:write".into()],
        )
        .await
        .unwrap();
    let host = support::register_host(&store, "worker").await;

    // Ordinary, quoted, embedded, or fenced text never starts an Objective.
    for (index, text) in [
        "Help me inspect this scheduling product",
        "> @SuperTag objective Validate scheduling",
        "Someone wrote: @SuperTag objective Validate scheduling",
        "```\n@SuperTag objective Validate scheduling\n```",
    ]
    .into_iter()
    .enumerate()
    {
        let ts = format!("1794460000.10000{index}");
        let task = accept(
            &store,
            event(&format!("EvORD{index}"), &ts, &ts, true, text),
        )
        .await;
        assert!(task.session_id.starts_with("slack:"), "{text}");
        finish(&store, &host, &task.task_id, ObjectiveSignal::Progress).await;
    }
    assert!(objectives(&store).await.is_empty());

    // An explicit invocation starts one Objective whose home is this thread.
    let start = event(
        "EvSTART",
        HOME,
        HOME,
        true,
        "<@UBOT1> objective Validate scheduling; this is not approval to deploy",
    );
    let (left, right) = tokio::join!(
        store.accept_slack_event(PRINCIPAL, &start),
        store.accept_slack_event(PRINCIPAL, &start)
    );
    let starting = left.unwrap().task.unwrap();
    assert_eq!(right.unwrap().task.unwrap(), starting);
    // Slack's message twin of the mention is the same logical input.
    let mut twin = start.clone();
    twin.event_id = "EvSTARTTWIN".into();
    twin.mention_tag_id = None;
    assert_eq!(accept(&store, twin).await, starting);
    let listed = objectives(&store).await;
    assert_eq!(listed.len(), 1);
    let objective = listed[0].clone();
    assert_eq!(objective.owner_tag_id, "builder");
    assert_eq!(
        objective.outcome,
        "Validate scheduling; this is not approval to deploy"
    );
    assert_eq!(objective.status(), ObjectiveStatus::Working);
    assert_eq!(objective.starting_task_id, starting.task_id);
    // Its authority is what this surface grants the Tag, and no more.
    assert_eq!(
        objective.runtime_actions.as_ref().unwrap().actions,
        ["files:read", "files:write"]
    );
    assert!(starting.prompt.contains("Validate scheduling"));
    assert_ne!(starting.session_id, "");
    assert!(!starting.session_id.starts_with("slack:"));

    // The starting turn answers in the home thread.
    finish(&store, &host, &starting.task_id, ObjectiveSignal::Progress).await;
    let (_, thread, _) = reply_route(&url, &starting.task_id).await.unwrap();
    assert_eq!(thread, HOME);

    // A plain reply in the home thread is the Objective's next turn.
    let steer = accept(
        &store,
        event(
            "EvSTEER",
            "1794470001.100000",
            HOME,
            false,
            "Focus on solo practices",
        ),
    )
    .await;
    assert_eq!(steer.session_id, starting.session_id);
    assert_eq!(steer.state(), TaskState::Queued);
    // Survives a Control Plane restart.
    store.close().await;
    let store = Store::open(&url).await.unwrap();
    let mention = accept(
        &store,
        event(
            "EvSTEER2",
            "1794470002.100000",
            HOME,
            true,
            "<@UBOT1> also check pricing",
        ),
    )
    .await;
    assert_eq!(mention.session_id, starting.session_id);

    // One Objective per thread.
    let again = accept(
        &store,
        event(
            "EvAGAIN",
            "1794470003.100000",
            HOME,
            true,
            "@SuperTag objective Another",
        ),
    )
    .await;
    answered(
        &store,
        &url,
        &again,
        "This thread already directs Objective",
    )
    .await;
    assert_eq!(objectives(&store).await.len(), 1);

    // The same thread coordinates in another account or channel do not reach it.
    let mut foreign = event(
        "EvFOREIGN",
        "1794470004.100000",
        HOME,
        false,
        "Cancel everything",
    );
    foreign.channel_id = "COTHER1".into();
    assert!(
        store
            .accept_slack_event(PRINCIPAL, &foreign)
            .await
            .unwrap()
            .task
            .is_none()
    );
    let mut other_account = event("EvOTHER", "1794470005.100000", HOME, false, "Pause");
    other_account.account_id = "slack-other".into();
    assert!(
        store
            .accept_slack_event("connector:slack-other", &other_account)
            .await
            .unwrap()
            .task
            .is_none()
    );

    // Directives act on the home Objective and answer in the thread.
    let approve = accept(
        &store,
        event(
            "EvAPPROVE1",
            "1794470006.100000",
            HOME,
            true,
            "<@UBOT1> approve",
        ),
    )
    .await;
    answered(
        &store,
        &url,
        &approve,
        &format!("Objective {} was not changed", objective.objective_id),
    )
    .await;
    let pause = accept(
        &store,
        event("EvPAUSE", "1794470007.100000", HOME, true, "<@UBOT1> pause"),
    )
    .await;
    answered(&store, &url, &pause, "Paused.").await;
    assert!(
        store
            .get_objective(&objective.objective_id)
            .await
            .unwrap()
            .paused_at_ms
            .is_some()
    );
    let repeated = accept(
        &store,
        event(
            "EvPAUSE2",
            "1794470008.100000",
            HOME,
            true,
            "@SuperTag pause.",
        ),
    )
    .await;
    answered(&store, &url, &repeated, "Objective").await;
    assert!(
        store
            .get_task(&repeated.task_id)
            .await
            .unwrap()
            .result
            .unwrap()
            .contains("already paused")
    );
    let refused = accept(
        &store,
        event("EvPAUSED", "1794470009.100000", HOME, false, "Keep going"),
    )
    .await;
    answered(
        &store,
        &url,
        &refused,
        &format!(
            "Objective {} did not accept this message",
            objective.objective_id
        ),
    )
    .await;
    let resume = accept(
        &store,
        event(
            "EvRESUME",
            "1794470010.100000",
            HOME,
            true,
            "@SuperTag resume",
        ),
    )
    .await;
    answered(&store, &url, &resume, "Resumed.").await;

    // Every queued owner turn runs, including the resume summary turn, which is
    // not itself a surface message. Each answers in the home thread.
    let mut ran = Vec::new();
    while let Some(assignment) = store
        .claim_task(&host, &format!("drain-{}", ran.len()))
        .await
        .unwrap()
    {
        let task = assignment.task.unwrap().task_id;
        store
            .start_task(
                &host,
                &StartTaskRequest {
                    task_id: task.clone(),
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
                    task_id: task.clone(),
                    attempt_id: assignment.attempt_id,
                    lease_token: assignment.lease_token,
                    result: format!("Result of {task}"),
                    succeeded: true,
                    objective_signal: ObjectiveSignal::ReadyForReview as i32,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let (_, thread, text) = reply_route(&url, &task).await.unwrap();
        assert_eq!(thread, HOME);
        assert_eq!(text, format!("Result of {task}"));
        ran.push(task);
    }
    assert!(ran.contains(&steer.task_id) && ran.contains(&mention.task_id));
    assert!(
        ran.len() >= 3,
        "resume queues an owner summary turn: {ran:?}"
    );
    assert_eq!(
        store
            .get_objective(&objective.objective_id)
            .await
            .unwrap()
            .status(),
        ObjectiveStatus::ReadyForReview
    );
    let approve = accept(
        &store,
        event(
            "EvAPPROVE2",
            "1794470011.100000",
            HOME,
            true,
            "@SuperTag approve!",
        ),
    )
    .await;
    answered(&store, &url, &approve, "Approved.").await;
    assert_eq!(
        store
            .get_objective(&objective.objective_id)
            .await
            .unwrap()
            .status(),
        ObjectiveStatus::Completed
    );
    // A closed Objective takes no more turns from its thread.
    let late = accept(
        &store,
        event("EvLATE", "1794470012.100000", HOME, false, "One more thing"),
    )
    .await;
    answered(&store, &url, &late, "Objective").await;
    // An empty invocation fails closed without an Objective.
    let empty_thread = "1794470100.100000";
    let empty = accept(
        &store,
        event(
            "EvEMPTY",
            empty_thread,
            empty_thread,
            true,
            "@SuperTag objective",
        ),
    )
    .await;
    assert_eq!(empty.state(), TaskState::Succeeded);
    assert_eq!(objectives(&store).await.len(), 1);
    store.close().await;
}

#[tokio::test]
async fn sqlite_surface_objectives_contract() {
    let dir = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("state.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_surface_objectives_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("dedicated PostgreSQL URL file is required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!(
        "supertag_rust_surface_objectives_{}",
        Uuid::new_v4().simple()
    );
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    url.set_path(&name);
    let local = tokio::task::LocalSet::new();
    let outcome = local
        .run_until(async move { tokio::task::spawn_local(contract(url.to_string())).await })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL surface Objective contract failed");
}
