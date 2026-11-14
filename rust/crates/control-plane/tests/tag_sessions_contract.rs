//! A Tag's root turns read its other Sessions and its Objectives (TS `tag-sessions.test.ts`):
//! who sees which Session, search and paging, the Work Session refusal, `read_objective`
//! scoping, the portfolio, and `create_objective` only on an explicit command.
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

async fn say(store: &Store, principal: &str, conversation: &str, text: &str) -> Task {
    store
        .send_message(
            principal,
            &SendMessageRequest {
                tag_id: "owner".into(),
                conversation: conversation.into(),
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

async fn create(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    outcome: &str,
) -> Result<CreateTagObjectiveResponse, StoreError> {
    store
        .create_tag_objective(
            host,
            &CreateTagObjectiveRequest {
                attempt: Some(attempt.clone()),
                outcome: outcome.into(),
                deadline_ms: None,
                budget_limit_minor: Some(500),
                budget_currency: Some("USD".into()),
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
    let a1 = say(&store, ALICE, "alice", "Draft release notes for v2").await;
    run(
        &store,
        &host,
        &a1,
        "Release notes drafted: v2 adds full-text search",
    )
    .await;
    let alice_session = a1.session_id.clone();
    let b1 = say(&store, BOB, "bob", "Plan the Q3 hiring and the search team").await;
    run(&store, &host, &b1, "Hiring plan: two engineers").await;
    let bob_session = b1.session_id.clone();
    let s1 = submit(&store, "owner", "alice-adhoc", "Check the search index").await;
    run(&store, &host, &s1, "Search index healthy").await;
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
    let a2 = say(&store, ALICE, "alice", "What did we decide earlier?").await;
    let a2 = claim(&store, &host, &a2.task_id).await;
    let caps = store.attempt_capabilities(&host, &a2).await.unwrap();
    assert!(caps.may_read_tag_sessions && !caps.may_create_objective);
    assert!(
        caps.tag_portfolio
            .contains("- docs [working] Keep the docs current")
            && caps
                .tag_portfolio
                .contains("search_sessions, list_sessions and read_session"),
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
    assert!(matches!(
        create(&store, &host, &a2, "Ship it").await,
        Err(StoreError::FailedPrecondition(_))
    ));

    // A Work Session sees only its own work; its report turn reads like its conversation, and
    // the Work Session has its conversation's audience.
    let work = store
        .start_work_session(
            &host,
            &StartWorkSessionRequest {
                attempt: Some(a2.clone()),
                operation_id: "work".into(),
                title: "Compare notes".into(),
                instruction: "Compare the release notes".into(),
                workspace_id: None,
                target_tag_id: None,
            },
        )
        .await
        .unwrap();
    finish(&store, &host, &a2, "Started a comparison").await;
    let child = claim(&store, &host, &work.latest_task_id).await;
    let caps = store.attempt_capabilities(&host, &child).await.unwrap();
    assert!(!caps.may_read_tag_sessions && caps.tag_portfolio.is_empty());
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

    // Bob sees the shared Objective, never Alice's Sessions or her Work Session.
    let b2 = say(&store, BOB, "bob", "Anything on search?").await;
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

    // An explicit command lets the turn create the Objective, once, as Alice.
    let a3 = say(
        &store,
        ALICE,
        "alice",
        "@SuperTag objective Publish the v2 release notes",
    )
    .await;
    let a3 = claim(&store, &host, &a3.task_id).await;
    assert!(
        store
            .attempt_capabilities(&host, &a3)
            .await
            .unwrap()
            .may_create_objective
    );
    let created = create(&store, &host, &a3, "Publish the v2 release notes by Friday")
        .await
        .unwrap();
    let objective = created.objective.unwrap();
    assert_eq!(objective.created_by, ALICE);
    assert_eq!(objective.owner_tag_id, "owner");
    assert_eq!(objective.budget_limit_minor, Some(500));
    assert_eq!(objective.starting_task_id, created.started_task_id);
    let again = create(&store, &host, &a3, "Publish the v2 release notes by Friday")
        .await
        .unwrap();
    assert_eq!(
        again.objective.unwrap().objective_id,
        objective.objective_id
    );
    assert!(matches!(
        create(&store, &host, &a3, "Something else").await,
        Err(StoreError::Conflict(_))
    ));
    let bound = read_objective(&store, &host, &a3, None).await.unwrap();
    assert_eq!(
        bound.objective.unwrap().objective_id,
        objective.objective_id
    );
    finish(&store, &host, &a3, "Created the Objective").await;

    // The new Objective's own turn reads only its own Objective, and creates none.
    let turn = claim(&store, &host, &created.started_task_id).await;
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
    assert!(matches!(
        create(&store, &host, &turn, "More").await,
        Err(StoreError::FailedPrecondition(_))
    ));
    // It was created in Alice's conversation, so it is Alice's: its Session sees hers.
    assert!(
        sessions(&store, &host, &turn)
            .await
            .contains(&alice_session)
    );
    finish(&store, &host, &turn, "Planned").await;
    pause(&store, &objective.objective_id).await;

    // Bob does not see Alice's Objective; Alice does.
    let b3 = say(&store, BOB, "bob", "Which Objectives are open?").await;
    let b3 = claim(&store, &host, &b3.task_id).await;
    assert_eq!(objectives(&store, &host, &b3).await, ["docs"]);
    assert!(matches!(
        read_objective(&store, &host, &b3, Some(&objective.objective_id)).await,
        Err(StoreError::NotFound(_))
    ));
    finish(&store, &host, &b3, "One").await;
    let a4 = say(&store, ALICE, "alice", "Which Objectives are open?").await;
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

    // The home a Tag-created Objective inherits is recorded by the Control Plane alone: an
    // operation ID naming a conversation Task, or naming the Objective a Task made, plants none.
    let a5 = say(&store, ALICE, "alice", "Anything new?").await;
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
    let a6 = say(&store, ALICE, "alice", "Search again").await;
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
