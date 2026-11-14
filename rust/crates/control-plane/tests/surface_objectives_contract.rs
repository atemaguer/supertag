//! Objectives started and steered from a Slack thread (TS
//! `tests/objective-surface-safety.test.ts`, `tests/objective-thread-routing.test.ts`,
//! `tests/objective-surface-execution.test.ts`).
mod support;

use sqlx::{Connection, Executor, Row};
use std::future::Future;
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::{
    AcceptSlackEventRequest, AuditOutcome, DeleteSurfaceLocationRequest, FinishTaskRequest,
    GetSurfaceLocationRequest, ListAuditEntriesRequest, ListObjectivesRequest,
    ListSurfaceLocationsRequest, Objective, ObjectiveSignal, ObjectiveStatus,
    PutSurfaceAccountRequest, PutSurfaceLocationRequest, SlackSurfaceChannel, SlackSurfaceIdentity,
    StartTaskRequest, SurfaceAccount, SurfaceAccountIdentity, SurfaceLocation,
    SurfaceLocationScope, Task, TaskState, surface_account_identity, surface_location_scope,
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
        actor_id: "UALICE1".into(),
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
        .list_objectives("operator:local", &ListObjectivesRequest::default())
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

/// Principals of the Objective's operation receipts.
async fn actors(url: &str, objective: &str) -> Vec<String> {
    sqlx::any::install_default_drivers();
    let mut connection = sqlx::AnyConnection::connect(url).await.unwrap();
    let principals = sqlx::query_scalar(
        "SELECT principal FROM supertag_v2_objective_operations WHERE objective_id=$1 ORDER BY operation_id",
    )
    .bind(objective)
    .fetch_all(&mut connection)
    .await
    .unwrap();
    connection.close().await.unwrap();
    principals
}

async fn sql(url: &str, statement: &str) {
    sqlx::any::install_default_drivers();
    let mut connection = sqlx::AnyConnection::connect(url).await.unwrap();
    connection.execute(statement).await.unwrap();
    connection.close().await.unwrap();
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
    // A plain thread message that mentions a colleague never starts an Objective in an active ordinary thread.
    let ordinary_thread = "1794460000.100000";
    let colleague = accept(
        &store,
        event(
            "EvCOLLEAGUESTART",
            "1794460000.200000",
            ordinary_thread,
            false,
            "<@UBOB1> objective Launch the product",
        ),
    )
    .await;
    assert!(colleague.session_id.starts_with("slack:"));
    assert_eq!(colleague.state(), TaskState::Queued);
    finish(&store, &host, &colleague.task_id, ObjectiveSignal::Progress).await;
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
    // Survives a Control Plane restart. The restarted one also writes its entries to a log.
    store.close().await;
    let log_directory = tempfile::tempdir().unwrap();
    let log = log_directory.path().join("audit.jsonl");
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_audit_sink(supertag_control_plane::AuditSink::parse(log.to_str().unwrap()).unwrap());
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

    // Only Slack's app_mention addresses the app. A plain thread message that
    // mentions a colleague is the Objective's next turn, never a directive.
    for (index, text) in ["<@UBOB1> approve.", "<@UBOB1> pause"]
        .into_iter()
        .enumerate()
    {
        let colleague = accept(
            &store,
            event(
                &format!("EvCOLLEAGUE{index}"),
                &format!("1794470002.20000{index}"),
                HOME,
                false,
                text,
            ),
        )
        .await;
        assert_eq!(colleague.session_id, starting.session_id, "{text}");
        assert_eq!(colleague.state(), TaskState::Queued, "{text}");
    }
    let unchanged = store
        .get_objective("operator:local", &objective.objective_id)
        .await
        .unwrap();
    assert_eq!(unchanged.status(), ObjectiveStatus::Working);
    assert!(unchanged.paused_at_ms.is_none());

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
            .get_objective("operator:local", &objective.objective_id)
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
            .get_objective("operator:local", &objective.objective_id)
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
            .get_objective("operator:local", &objective.objective_id)
            .await
            .unwrap()
            .status(),
        ObjectiveStatus::Completed
    );
    // Objective actions are receipted under the Slack person who wrote them.
    assert_eq!(
        actors(&url, &objective.objective_id).await,
        vec!["slack:UALICE1".to_owned(); 4]
    );
    // A closed Objective takes no more turns from its thread.
    let late = accept(
        &store,
        event("EvLATE", "1794470012.100000", HOME, false, "One more thing"),
    )
    .await;
    answered(&store, &url, &late, "Objective").await;
    // Each action on the Objective is audited under the same person, with its outcome.
    let audited = store
        .list_audit_entries(&ListAuditEntriesRequest {
            limit: 100,
            ..Default::default()
        })
        .await
        .unwrap()
        .entries
        .into_iter()
        .rev()
        .filter(|entry| entry.target == format!("Objective/{}", objective.objective_id))
        .map(|entry| {
            assert_eq!(entry.actor, "slack:UALICE1");
            assert_eq!(
                entry.method,
                "/supertag.runtime.v2.Connector/AcceptSlackEvent"
            );
            (entry.outcome(), entry.action, entry.code)
        })
        .collect::<Vec<_>>();
    let ok = |action: &str| (AuditOutcome::Succeeded, action.to_owned(), "OK".to_owned());
    let refused = |action: &str| {
        (
            AuditOutcome::Failed,
            action.to_owned(),
            "FAILED_PRECONDITION".to_owned(),
        )
    };
    assert_eq!(
        audited,
        [
            // The steer, the mention, and the two colleague messages.
            ok("objective.message"),
            ok("objective.message"),
            ok("objective.message"),
            ok("objective.message"),
            refused("objective.approve"),
            ok("objective.pause"),
            ok("objective.pause"),
            refused("objective.message"),
            ok("objective.resume"),
            ok("objective.approve"),
            refused("objective.message"),
        ]
    );
    // Each committed entry after the restart reached the log once, when its event committed.
    let logged = std::fs::read_to_string(&log)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .filter(|line| line["target"] == format!("Objective/{}", objective.objective_id))
        .map(|line| {
            assert_eq!(line["type"], "supertag.audit");
            assert_eq!(line["actor"], "slack:UALICE1");
            let outcome = if line["outcome"] == "succeeded" {
                AuditOutcome::Succeeded
            } else {
                AuditOutcome::Failed
            };
            (
                outcome,
                line["action"].as_str().unwrap().to_owned(),
                line["code"].as_str().unwrap().to_owned(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(logged, audited[1..]);
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

const OPERATOR: &str = "operator:alice";

fn surface_account(step: &str, enabled: bool, revision: Option<u64>) -> PutSurfaceAccountRequest {
    PutSurfaceAccountRequest {
        operation_id: format!("account-{step}"),
        expected_revision: revision,
        account: Some(SurfaceAccount {
            account_id: "workspace".into(),
            identity: Some(SurfaceAccountIdentity {
                provider: Some(surface_account_identity::Provider::Slack(
                    SlackSurfaceIdentity {
                        team_id: "TTEAM1".into(),
                    },
                )),
            }),
            enabled,
            gateway: "local".into(),
            ..Default::default()
        }),
    }
}

async fn put_location(store: &Store, step: &str, location: &str, tag: &str, enabled: bool) {
    let current = store
        .list_surface_locations(OPERATOR, &ListSurfaceLocationsRequest::default())
        .await
        .unwrap()
        .locations
        .into_iter()
        .find(|current| current.location_id == location);
    store
        .put_surface_location(
            OPERATOR,
            &PutSurfaceLocationRequest {
                operation_id: format!("location-{step}"),
                expected_revision: current.as_ref().map(|location| location.revision),
                location: Some(SurfaceLocation {
                    location_id: location.into(),
                    account_id: "workspace".into(),
                    connector_account_id: "slack-objectives".into(),
                    scope: Some(SurfaceLocationScope {
                        provider: Some(surface_location_scope::Provider::Slack(
                            SlackSurfaceChannel {
                                channel_id: "CCHANNEL1".into(),
                            },
                        )),
                    }),
                    tag_id: tag.into(),
                    enabled,
                    ..Default::default()
                }),
            },
        )
        .await
        .unwrap();
}

async fn delete_location(store: &Store, step: &str, location: &str) {
    let current = store
        .get_surface_location(
            OPERATOR,
            &GetSurfaceLocationRequest {
                location_id: location.into(),
            },
        )
        .await
        .unwrap();
    store
        .delete_surface_location(
            OPERATOR,
            &DeleteSurfaceLocationRequest {
                operation_id: step.into(),
                location_id: location.into(),
                expected_revision: current.revision,
            },
        )
        .await
        .unwrap();
}

/// Every directive, answer, and turn from the home thread, and an empty
/// invocation elsewhere, is refused without changing the Objective.
async fn refused(store: &Store, objective: &str, sequence: &mut u32, why: &str) {
    for (thread, text) in [
        (HOME, "<@UBOT1> approve"),
        (HOME, "<@UBOT1> pause"),
        (HOME, "<@UBOT1> resume"),
        (HOME, "<@UBOT1> objective Another"),
        (HOME, "Keep going"),
        ("1794470900.100000", "<@UBOT1> objective"),
    ] {
        *sequence += 1;
        let ts = format!("1794471000.{sequence:06}");
        let mention = text.starts_with("<@");
        let result = store
            .accept_slack_event(
                PRINCIPAL,
                &event(&format!("EvGATED{sequence}"), &ts, thread, mention, text),
            )
            .await;
        assert_eq!(result.unwrap().task, None, "{why} {text}");
    }
    let current = store
        .get_objective("operator:local", objective)
        .await
        .unwrap();
    assert_eq!(current.status(), ObjectiveStatus::ReadyForReview, "{why}");
    assert!(current.paused_at_ms.is_none(), "{why}");
}

/// Every Objective action and every Control Plane answer from a thread is
/// admitted like ordinary work: a disabled account or location, an inactive
/// Tag stops it before anything changes.
async fn gated(url: String) {
    let store = Store::open(&url).await.unwrap();
    for tag in ["builder", "reviewer"] {
        store.put_tag(tag, "Builder", vec![]).await.unwrap();
    }
    let host = support::register_host(&store, "worker").await;
    let account = store
        .put_surface_account(OPERATOR, &surface_account("create", true, None))
        .await
        .unwrap();
    put_location(&store, "bind", "home", "builder", true).await;
    let starting = accept(
        &store,
        event("EvSTART", HOME, HOME, true, "<@UBOT1> objective Ship it"),
    )
    .await;
    let objective = objectives(&store).await.remove(0);
    finish(
        &store,
        &host,
        &starting.task_id,
        ObjectiveSignal::ReadyForReview,
    )
    .await;
    let id = objective.objective_id.as_str();
    assert_eq!(
        store
            .get_objective("operator:local", id)
            .await
            .unwrap()
            .status(),
        ObjectiveStatus::ReadyForReview
    );
    let mut sequence = 0;
    put_location(&store, "disable", "home", "builder", false).await;
    refused(&store, id, &mut sequence, "disabled location").await;
    put_location(&store, "enable", "home", "builder", true).await;
    let account = store
        .put_surface_account(
            OPERATOR,
            &surface_account("disable", false, Some(account.revision)),
        )
        .await
        .unwrap();
    refused(&store, id, &mut sequence, "disabled account").await;
    store
        .put_surface_account(
            OPERATOR,
            &surface_account("enable", true, Some(account.revision)),
        )
        .await
        .unwrap();
    delete_location(&store, "delete-home", "home").await;
    refused(&store, id, &mut sequence, "deleted location").await;
    // The deleted location's connector alias stays reserved for its Tag.
    let moved = store
        .put_surface_location(
            OPERATOR,
            &PutSurfaceLocationRequest {
                operation_id: "retarget".into(),
                expected_revision: None,
                location: Some(SurfaceLocation {
                    location_id: "moved".into(),
                    account_id: "workspace".into(),
                    connector_account_id: "slack-objectives".into(),
                    scope: Some(SurfaceLocationScope {
                        provider: Some(surface_location_scope::Provider::Slack(
                            SlackSurfaceChannel {
                                channel_id: "CCHANNEL1".into(),
                            },
                        )),
                    }),
                    tag_id: "reviewer".into(),
                    enabled: true,
                    ..Default::default()
                }),
            },
        )
        .await;
    assert!(matches!(moved, Err(StoreError::Conflict(_))), "{moved:?}");
    put_location(&store, "restore", "home", "builder", true).await;
    sql(
        &url,
        "UPDATE supertag_v2_tags SET retired_at_ms=1 WHERE tag_id='builder'",
    )
    .await;
    refused(&store, id, &mut sequence, "inactive Tag").await;
    sql(
        &url,
        "UPDATE supertag_v2_tags SET retired_at_ms=NULL WHERE tag_id='builder'",
    )
    .await;

    // With the surface admitted again, the same person approves.
    let approve = accept(
        &store,
        event(
            "EvAPPROVE",
            "1794472000.100000",
            HOME,
            true,
            "<@UBOT1> approve",
        ),
    )
    .await;
    answered(&store, &url, &approve, "Approved.").await;
    assert_eq!(
        store
            .get_objective("operator:local", id)
            .await
            .unwrap()
            .status(),
        ObjectiveStatus::Completed
    );
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
async fn sqlite_surface_objective_actions_are_admitted_like_ordinary_work() {
    let dir = tempfile::tempdir().unwrap();
    gated(format!(
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
        .run_until(async move { tokio::task::spawn_local(run(url.to_string())).await })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL surface Objective contract failed");
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_surface_objectives_contract() {
    on_postgres(contract).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_surface_objective_actions_are_admitted_like_ordinary_work() {
    on_postgres(gated).await;
}
