//! A Tag's root turns read its other Sessions and its Objectives (TS `tag-sessions.test.ts`):
//! who sees which Session, search and paging, the Work Session refusal, `read_objective`
//! scoping, the portfolio, and the Objective a conversation's `/goal` creates.
mod support;

use std::collections::BTreeSet;

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const ALICE: &str = "operator:alice";
const BOB: &str = "operator:bob";

async fn claim(store: &Store, host: &HostAuthority, id: &str) -> InspectAttemptRequest {
    let assignment = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .expect("expected Task");
    assert_eq!(assignment.task.unwrap().task_id, id);
    let attempt = InspectAttemptRequest {
        task_id: id.into(),
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

async fn finish(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    result: &str,
) {
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                succeeded: true,
                result: result.into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

/// Paused, an Objective starts no idle wake that would take the next claim.
async fn pause(store: &Store, id: &str) {
    store
        .pause_objective(
            ALICE,
            &ObjectiveActionRequest {
                objective_id: id.into(),
                operation_id: format!("pause-{id}"),
                reason: String::new(),
            },
        )
        .await
        .unwrap();
}

async fn run(store: &Store, host: &HostAuthority, task: &Task, result: &str) {
    let attempt = claim(store, host, &task.task_id).await;
    finish(store, host, &attempt, result).await;
}

/// Runs the Task, writing `events` (kind, text) during its turn.
async fn run_with(
    store: &Store,
    host: &HostAuthority,
    task: &Task,
    events: &[(TaskEventKind, &str)],
    result: &str,
) {
    let attempt = claim(store, host, &task.task_id).await;
    for (index, (kind, text)) in events.iter().enumerate() {
        store
            .append_event(
                host,
                &AppendEventRequest {
                    task_id: attempt.task_id.clone(),
                    attempt_id: attempt.attempt_id.clone(),
                    lease_token: attempt.lease_token.clone(),
                    sequence: index as u64 + 1,
                    text: (*text).into(),
                    kind: *kind as i32,
                },
            )
            .await
            .unwrap();
    }
    finish(store, host, &attempt, result).await;
}

async fn turn(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    task: &str,
    limit: u32,
    after: Option<u64>,
) -> Result<ReadTagTurnResponse, StoreError> {
    store
        .read_tag_turn(
            host,
            &ReadTagTurnRequest {
                attempt: Some(attempt.clone()),
                task_id: task.into(),
                limit,
                after,
            },
        )
        .await
}

async fn say(store: &Store, principal: &str, text: &str) -> Task {
    store
        .send_message(
            principal,
            &SendMessageRequest {
                tag_id: "owner".into(),
                text: text.into(),
                operation_id: Uuid::new_v4().to_string(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .task
        .unwrap()
}

async fn submit(store: &Store, tag: &str, session: &str, prompt: &str) -> Task {
    store
        .submit_task(
            ALICE,
            &SubmitTaskRequest {
                tag_id: tag.into(),
                session_id: session.into(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: prompt.into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
}

async fn sessions(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
) -> BTreeSet<String> {
    store
        .list_tag_sessions(
            host,
            &ListTagSessionsRequest {
                attempt: Some(attempt.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .sessions
        .into_iter()
        .map(|session| session.session_id)
        .collect()
}

async fn search(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    query: &str,
) -> Vec<TagSessionSearchHit> {
    store
        .search_tag_sessions(
            host,
            &SearchTagSessionsRequest {
                attempt: Some(attempt.clone()),
                query: query.into(),
                limit: 0,
            },
        )
        .await
        .unwrap()
        .matches
}

async fn read(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    session: &str,
    limit: u32,
    before: Option<u64>,
) -> Result<ReadTagSessionResponse, StoreError> {
    store
        .read_tag_session(
            host,
            &ReadTagSessionRequest {
                attempt: Some(attempt.clone()),
                session_id: session.into(),
                limit,
                before,
            },
        )
        .await
}

async fn objectives(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
) -> Vec<String> {
    store
        .list_tag_objectives(
            host,
            &ListTagObjectivesRequest {
                attempt: Some(attempt.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .objectives
        .into_iter()
        .map(|objective| objective.objective_id)
        .collect()
}

async fn read_objective(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    id: Option<&str>,
) -> Result<TagObjectiveView, StoreError> {
    store
        .read_tag_objective(
            host,
            &ReadTagObjectiveRequest {
                attempt: Some(attempt.clone()),
                objective_id: id.map(str::to_owned),
            },
        )
        .await
}

async fn contract(url: &str) {
    let store = Store::open(url).await.unwrap();
    for tag in ["owner", "other"] {
        store
            .put_tag(tag, "Help the team", vec!["files:read".into()])
            .await
            .unwrap();
    }
    let host = support::register_host(&store, "sessions-host").await;

    // Alice's and Bob's operator conversations are private to each; Alice's ad hoc Session is
    // private to Alice, who admitted it; an operator's Objective is shared.
    let a1 = say(&store, ALICE, "Draft release notes for v2").await;
    run(
        &store,
        &host,
        &a1,
        "Release notes drafted: v2 adds full-text search",
    )
    .await;
    let alice_session = a1.session_id.clone();
    let b1 = say(&store, BOB, "Plan the Q3 hiring and the search team").await;
    run_with(
        &store,
        &host,
        &b1,
        &[(TaskEventKind::Message, "Bob's private draft")],
        "Hiring plan: two engineers",
    )
    .await;
    let bob_session = b1.session_id.clone();
    let s1 = submit(&store, "owner", "alice-adhoc", "Check the search index").await;
    let long = "x".repeat(5_000);
    run_with(
        &store,
        &host,
        &s1,
        &[
            (TaskEventKind::Message, "Checking the index now."),
            (TaskEventKind::Activity, "Ran `index status` (exit 0)"),
            (TaskEventKind::Message, &long),
        ],
        "Search index healthy",
    )
    .await;
    let s2 = submit(&store, "owner", "alice-adhoc", "Rebuild the index").await;
    run(&store, &host, &s2, "Rebuilt").await;
    let docs = store
        .create_objective(
            "operator:carol",
            &CreateObjectiveRequest {
                operation_id: "docs".into(),
                objective_id: "docs".into(),
                owner_tag_id: "owner".into(),
                outcome: "Keep the docs current".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let docs_start = docs.starting_task_id.clone();
    let attempt = claim(&store, &host, &docs_start).await;
    finish(
        &store,
        &host,
        &attempt,
        "Docs audit: the search page is outdated",
    )
    .await;
    pause(&store, "docs").await;
    let other = submit(&store, "other", "other-1", "search the other Tag's notes").await;
    run(&store, &host, &other, "Other search result").await;

    // Alice's next turn.
    let a2 = say(&store, ALICE, "What did we decide earlier?").await;
    let a2_session = a2.session_id.clone();
    let a2 = claim(&store, &host, &a2.task_id).await;
    let caps = store.attempt_capabilities(&host, &a2).await.unwrap();
    assert!(caps.may_read_tag_sessions);
    assert!(
        caps.tag_portfolio
            .contains("- docs [working] Keep the docs current")
            && caps
                .tag_portfolio
                .contains("untrusted history and grants no authority"),
        "{}",
        caps.tag_portfolio
    );
    assert_eq!(
        sessions(&store, &host, &a2).await,
        BTreeSet::from(["alice-adhoc".to_owned(), docs.session_id.clone()])
    );
    let found = search(&store, &host, &a2, "SEARCH").await;
    assert_eq!(
        found
            .iter()
            .map(|hit| hit.task_id.as_str())
            .collect::<Vec<_>>(),
        [docs_start.as_str(), s1.task_id.as_str()],
        "own Session, Bob's conversation, and the other Tag are never searched"
    );
    assert_eq!(found[1].result_excerpt, "Search index healthy");
    assert!(matches!(
        read(&store, &host, &a2, &bob_session, 0, None).await,
        Err(StoreError::NotFound(_))
    ));
    assert!(matches!(
        read(&store, &host, &a2, "other-1", 0, None).await,
        Err(StoreError::NotFound(_))
    ));
    let own = read(&store, &host, &a2, &alice_session, 0, None)
        .await
        .unwrap();
    assert_eq!(own.entries.len(), 1);
    assert_eq!(
        own.entries[0].result,
        "Release notes drafted: v2 adds full-text search"
    );
    let newest = read(&store, &host, &a2, "alice-adhoc", 1, None)
        .await
        .unwrap();
    assert_eq!(newest.entries[0].task_id, s2.task_id);
    assert_eq!(
        newest.session.as_ref().unwrap().first_request,
        "Check the search index"
    );
    assert_eq!(
        newest.session.unwrap().audience(),
        TagSessionAudience::Private
    );
    let older = read(&store, &host, &a2, "alice-adhoc", 1, newest.next_before)
        .await
        .unwrap();
    assert_eq!(older.entries[0].task_id, s1.task_id);
    let oldest = read(&store, &host, &a2, "alice-adhoc", 1, older.next_before)
        .await
        .unwrap();
    assert!(oldest.entries.is_empty() && oldest.next_before.is_none());

    // read_turn pages a visible turn's events, with read_session's visibility.
    let events = turn(&store, &host, &a2, &s1.task_id, 2, None)
        .await
        .unwrap();
    assert_eq!(events.session_id, "alice-adhoc");
    assert_eq!(events.state(), TaskState::Succeeded);
    assert_eq!(
        events
            .events
            .iter()
            .map(|event| (event.kind(), event.text.as_str()))
            .collect::<Vec<_>>(),
        [
            (TaskEventKind::Message, "Checking the index now."),
            (TaskEventKind::Activity, "Ran `index status` (exit 0)"),
        ]
    );
    assert_eq!(events.next_after, Some(2));
    let rest = turn(&store, &host, &a2, &s1.task_id, 0, events.next_after)
        .await
        .unwrap();
    assert_eq!(rest.events.len(), 1);
    assert_eq!(
        rest.events[0].text,
        format!("{}\n[truncated]", "x".repeat(4_000))
    );
    assert!(rest.next_after.is_none());
    assert!(matches!(
        turn(&store, &host, &a2, &b1.task_id, 0, None).await,
        Err(StoreError::NotFound(_))
    ));
    assert!(matches!(
        turn(&store, &host, &a2, &other.task_id, 0, None).await,
        Err(StoreError::NotFound(_))
    ));
    assert!(
        matches!(
            turn(&store, &host, &a2, &a2.task_id, 0, None).await,
            Err(StoreError::NotFound(_))
        ),
        "a running turn is not finished"
    );
    assert!(matches!(
        turn(&store, &host, &a2, &s1.task_id, 101, None).await,
        Err(StoreError::InvalidArgument(_))
    ));
    let own_turn = turn(&store, &host, &a2, &a1.task_id, 0, None)
        .await
        .unwrap();
    assert!(own_turn.events.is_empty() && own_turn.next_after.is_none());
    assert_eq!(objectives(&store, &host, &a2).await, ["docs"]);
    let view = read_objective(&store, &host, &a2, Some("docs"))
        .await
        .unwrap();
    assert_eq!(view.objective.unwrap().outcome, "Keep the docs current");
    assert!(view.sessions[0].owner && view.sessions[0].failure.is_none());
    assert!(matches!(
        read_objective(&store, &host, &a2, None).await,
        Err(StoreError::NotFound(_))
    ));

    // A Work Session rereads only its own Session; its report turn reads like its conversation,
    // and the Work Session has its conversation's audience.
    let work = store
        .start_work_session(
            &host,
            &StartWorkSessionRequest {
                attempt: Some(a2.clone()),
                operation_id: "work".into(),
                title: "Compare notes".into(),
                instruction: "Compare the release notes".into(),
                target_tag_id: None,
                harness: None,
            },
        )
        .await
        .unwrap();
    finish(&store, &host, &a2, "Started a comparison").await;
    let child = claim(&store, &host, &work.latest_task_id).await;
    let caps = store.attempt_capabilities(&host, &child).await.unwrap();
    assert!(!caps.may_read_tag_sessions && caps.tag_portfolio.is_empty());
    assert!(caps.may_read_own_session);
    assert!(
        read(&store, &host, &child, &work.work_session_id, 0, None)
            .await
            .unwrap()
            .entries
            .is_empty()
    );
    assert!(matches!(
        read(&store, &host, &child, &a2_session, 0, None).await,
        Err(StoreError::NotFound(_))
    ));
    assert!(matches!(
        store
            .list_tag_sessions(
                &host,
                &ListTagSessionsRequest {
                    attempt: Some(child.clone()),
                    ..Default::default()
                }
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert!(matches!(
        turn(&store, &host, &child, &s1.task_id, 0, None).await,
        Err(StoreError::NotFound(_))
    ));
    for refused in [
        store
            .search_tag_sessions(
                &host,
                &SearchTagSessionsRequest {
                    attempt: Some(child.clone()),
                    query: "notes".into(),
                    limit: 0,
                },
            )
            .await
            .map(|_| ()),
        store
            .list_tag_objectives(
                &host,
                &ListTagObjectivesRequest {
                    attempt: Some(child.clone()),
                    ..Default::default()
                },
            )
            .await
            .map(|_| ()),
        read_objective(&store, &host, &child, Some("docs"))
            .await
            .map(|_| ()),
    ] {
        assert!(matches!(refused, Err(StoreError::FailedPrecondition(_))));
    }
    let first_child = child.task_id.clone();
    finish(&store, &host, &child, "Notes compared").await;
    let report = store
        .get_work_session(ALICE, &work.work_session_id)
        .await
        .unwrap()
        .report_task_id
        .unwrap();
    let report = claim(&store, &host, &report).await;
    assert!(
        store
            .attempt_capabilities(&host, &report)
            .await
            .unwrap()
            .may_read_tag_sessions
    );
    assert!(
        sessions(&store, &host, &report)
            .await
            .contains(&work.work_session_id)
    );
    finish(&store, &host, &report, "Reported").await;

    // Continued, the Work Session rereads its earlier turn, and still nothing else.
    let again = say(&store, ALICE, "Compare them once more").await;
    let again = claim(&store, &host, &again.task_id).await;
    let continued = store
        .continue_work_session(
            &host,
            &ContinueWorkSessionRequest {
                attempt: Some(again.clone()),
                operation_id: "again".into(),
                work_session_id: work.work_session_id.clone(),
                message: "Compare them once more".into(),
            },
        )
        .await
        .unwrap();
    finish(&store, &host, &again, "Asked for another comparison").await;
    let next = claim(&store, &host, &continued.latest_task_id).await;
    assert!(
        store
            .attempt_capabilities(&host, &next)
            .await
            .unwrap()
            .may_read_own_session
    );
    let earlier = read(&store, &host, &next, &work.work_session_id, 0, None)
        .await
        .unwrap();
    assert_eq!(
        earlier
            .entries
            .iter()
            .map(|entry| entry.task_id.as_str())
            .collect::<Vec<_>>(),
        [first_child.as_str()]
    );
    assert_eq!(earlier.entries[0].result, "Notes compared");
    assert_eq!(
        turn(&store, &host, &next, &first_child, 0, None)
            .await
            .unwrap()
            .session_id,
        work.work_session_id
    );
    assert!(matches!(
        turn(&store, &host, &next, &again.task_id, 0, None).await,
        Err(StoreError::NotFound(_))
    ));
    finish(&store, &host, &next, "Compared again").await;
    let report = store
        .get_work_session(ALICE, &work.work_session_id)
        .await
        .unwrap()
        .report_task_id
        .unwrap();
    let report = claim(&store, &host, &report).await;
    finish(&store, &host, &report, "Reported again").await;

    // Bob sees the shared Objective, never Alice's Sessions or her Work Session.
    let b2 = say(&store, BOB, "Anything on search?").await;
    let b2 = claim(&store, &host, &b2.task_id).await;
    assert_eq!(
        sessions(&store, &host, &b2).await,
        BTreeSet::from([docs.session_id.clone()])
    );
    assert_eq!(
        search(&store, &host, &b2, "search")
            .await
            .iter()
            .map(|hit| hit.task_id.as_str())
            .collect::<Vec<_>>(),
        [docs_start.as_str()]
    );
    assert!(matches!(
        read(&store, &host, &b2, &work.work_session_id, 0, None).await,
        Err(StoreError::NotFound(_))
    ));
    finish(&store, &host, &b2, "Only the docs audit").await;

    // `/goal` creates the Objective in the Control Plane, as Alice, and answers without a turn.
    let goal = SendMessageRequest {
        tag_id: "owner".into(),
        text: "/goal Publish the v2 release notes by Friday".into(),
        operation_id: Uuid::new_v4().to_string(),
        ..Default::default()
    };
    let a3 = store.send_message(ALICE, &goal).await.unwrap();
    let a3 = a3.task.unwrap();
    assert_eq!(a3.state(), TaskState::Succeeded);
    assert_eq!(a3.session_id, alice_session);
    let answer = a3.result.clone().unwrap();
    let id = answer
        .strip_prefix("Created Objective ")
        .and_then(|rest| rest.split(':').next())
        .unwrap_or_else(|| panic!("{answer}"));
    let objective = store.get_objective(ALICE, id).await.unwrap();
    assert!(answer.contains("Publish the v2 release notes by Friday"));
    assert_eq!(objective.created_by, ALICE);
    assert_eq!(objective.owner_tag_id, "owner");
    assert_eq!(objective.outcome, "Publish the v2 release notes by Friday");
    // A retried message replays its answer and creates nothing more.
    let again = store.send_message(ALICE, &goal).await.unwrap();
    assert_eq!(again.task.unwrap().task_id, a3.task_id);
    let mut changed = goal.clone();
    changed.text = "/goal Something else".into();
    assert!(matches!(
        store.send_message(ALICE, &changed).await,
        Err(StoreError::Conflict(_))
    ));
    // `/goal` without an outcome creates nothing.
    let empty = say(&store, ALICE, "/goal").await;
    assert_eq!(empty.state(), TaskState::Succeeded);
    assert!(
        empty
            .result
            .unwrap()
            .starts_with("Say which outcome the Objective should achieve: /goal <outcome>.")
    );
    let created = objective.clone();

    // The new Objective's own turn reads only its own Objective.
    let turn = claim(&store, &host, &created.starting_task_id).await;
    assert!(
        store
            .attempt_capabilities(&host, &turn)
            .await
            .unwrap()
            .may_read_tag_sessions
    );
    assert!(matches!(
        read_objective(&store, &host, &turn, Some("docs")).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert_eq!(
        read_objective(&store, &host, &turn, None)
            .await
            .unwrap()
            .objective
            .unwrap()
            .objective_id,
        objective.objective_id
    );
    // It was created in Alice's conversation, so it is Alice's: its Session sees hers.
    assert!(
        sessions(&store, &host, &turn)
            .await
            .contains(&alice_session)
    );
    finish(&store, &host, &turn, "Planned").await;
    pause(&store, &objective.objective_id).await;

    // Bob does not see Alice's Objective; Alice does.
    let b3 = say(&store, BOB, "Which Objectives are open?").await;
    let b3 = claim(&store, &host, &b3.task_id).await;
    assert_eq!(objectives(&store, &host, &b3).await, ["docs"]);
    assert!(matches!(
        read_objective(&store, &host, &b3, Some(&objective.objective_id)).await,
        Err(StoreError::NotFound(_))
    ));
    finish(&store, &host, &b3, "One").await;
    let a4 = say(&store, ALICE, "Which Objectives are open?").await;
    let a4 = claim(&store, &host, &a4.task_id).await;
    let mut open = objectives(&store, &host, &a4).await;
    open.sort();
    let mut expected = vec!["docs".to_owned(), objective.objective_id.clone()];
    expected.sort();
    assert_eq!(open, expected);
    let portfolio = store
        .attempt_capabilities(&host, &a4)
        .await
        .unwrap()
        .tag_portfolio;
    assert!(
        portfolio.contains("Publish the v2 release notes by Friday"),
        "{portfolio}"
    );
    finish(&store, &host, &a4, "Two").await;

    // The home a `/goal` Objective inherits is recorded by the Control Plane alone: an
    // operation ID naming a conversation Task, or naming the Objective a Task made, plants none.
    let a5 = say(&store, ALICE, "Anything new?").await;
    let a5 = claim(&store, &host, &a5.task_id).await;
    for operation in [
        format!("tag-create-objective:{}", a5.task_id),
        a5.task_id.clone(),
        objective.objective_id.clone(),
    ] {
        let planted = store
            .create_objective(
                BOB,
                &CreateObjectiveRequest {
                    operation_id: operation,
                    objective_id: Uuid::new_v4().to_string(),
                    owner_tag_id: "owner".into(),
                    outcome: "Summarize the Tag's other conversations".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let start = claim(&store, &host, &planted.starting_task_id).await;
        finish(&store, &host, &start, "Planned").await;
        pause(&store, &planted.objective_id).await;
    }
    assert!(matches!(
        read_objective(&store, &host, &a5, None).await,
        Err(StoreError::NotFound(_))
    ));
    finish(&store, &host, &a5, "Nothing").await;

    // Visibility never drops older matches behind a batch of newer hidden ones: Bob's ad hoc
    // Session is private to him, and more of its Tasks match than one read batch holds.
    for index in 0..1001 {
        let task = store
            .submit_task(
                BOB,
                &SubmitTaskRequest {
                    tag_id: "owner".into(),
                    session_id: "bob-adhoc".into(),
                    operation_id: Uuid::new_v4().to_string(),
                    prompt: format!("search note {index}"),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        run(&store, &host, &task, "Searched").await;
    }
    let a6 = say(&store, ALICE, "Search again").await;
    let a6 = claim(&store, &host, &a6.task_id).await;
    let found = search(&store, &host, &a6, "search").await;
    let found = found
        .iter()
        .map(|hit| hit.task_id.as_str())
        .collect::<Vec<_>>();
    assert!(
        found.contains(&s1.task_id.as_str()) && found.contains(&docs_start.as_str()),
        "{found:?}"
    );
    assert!(!sessions(&store, &host, &a6).await.contains("bob-adhoc"));
    finish(&store, &host, &a6, "Found").await;
    store.close().await;
}

#[tokio::test]
async fn sqlite_tag_sessions_contract() {
    let dir = tempfile::tempdir().unwrap();
    contract(&format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("sessions.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_tag_sessions_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").unwrap();
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!("supertag_rust_sessions_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    url.set_path(&name);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { contract(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    result.unwrap();
}
