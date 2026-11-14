mod support;

use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:alice";
const NOW: i64 = 1_893_456_000_000;

fn create_team(id: &str, name: &str, members: &[&str], limit: Option<u32>) -> CreateTeamRequest {
    CreateTeamRequest {
        operation_id: format!("create-{id}"),
        team_id: id.into(),
        name: name.into(),
        member_tag_ids: members.iter().map(|id| (*id).into()).collect(),
        max_concurrency: limit,
    }
}

fn create_objective(id: &str, tag: &str, team: &str) -> CreateObjectiveRequest {
    CreateObjectiveRequest {
        operation_id: format!("objective-{id}"),
        objective_id: id.into(),
        owner_tag_id: tag.into(),
        outcome: "Verify a safe rollout".into(),
        team_id: Some(team.into()),
        ..Default::default()
    }
}

async fn claim(store: &Store, host: &HostAuthority, expected: &str) -> InspectAttemptRequest {
    let claim = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .expect("expected one claim");
    assert_eq!(claim.task.unwrap().task_id, expected);
    InspectAttemptRequest {
        task_id: expected.into(),
        attempt_id: claim.attempt_id,
        lease_token: claim.lease_token,
    }
}

fn start(attempt: &InspectAttemptRequest) -> StartTaskRequest {
    StartTaskRequest {
        task_id: attempt.task_id.clone(),
        attempt_id: attempt.attempt_id.clone(),
        lease_token: attempt.lease_token.clone(),
    }
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
                result: "Verified".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

async fn team_lifecycle(store: &Store) {
    let create = create_team(
        "release",
        " Release team ",
        &["reviewer", "lead", "lead"],
        Some(2),
    );
    let (first, replay) = tokio::join!(
        store.create_team(OPERATOR, &create),
        store.create_team(OPERATOR, &create),
    );
    let team = first.unwrap();
    assert_eq!(team, replay.unwrap());
    assert_eq!(team.name, "Release team");
    assert_eq!(team.member_tag_ids, ["lead", "reviewer"]);
    assert_eq!(team.revision, 1);
    assert_eq!(team.created_at_ms, NOW);
    assert_eq!(
        store.get_team(OPERATOR, "Release team").await.unwrap(),
        team
    );
    assert!(matches!(
        store
            .create_team(
                OPERATOR,
                &create_team("taken", "Release team", &["lead"], None)
            )
            .await,
        Err(StoreError::Conflict(_))
    ));
    assert!(matches!(
        store
            .create_team(
                OPERATOR,
                &create_team("missing", "Missing", &["missing"], None)
            )
            .await,
        Err(StoreError::NotFound(_))
    ));
    assert!(matches!(
        store
            .create_team(OPERATOR, &create_team("empty", "Empty", &[], None))
            .await,
        Err(StoreError::InvalidArgument(_))
    ));

    let another = create_team("checks", "Checks", &["reviewer"], None);
    store.create_team(OPERATOR, &another).await.unwrap();
    let list = ListTeamsRequest {
        member_tag_id: "reviewer".into(),
        limit: 1,
        cursor: String::new(),
    };
    let page = store.list_teams(OPERATOR, &list).await.unwrap();
    assert_eq!(page.teams[0].team_id, "checks");
    assert!(!page.next_cursor.is_empty());
    let last = store
        .list_teams(
            OPERATOR,
            &ListTeamsRequest {
                cursor: page.next_cursor,
                ..list
            },
        )
        .await
        .unwrap();
    assert_eq!(last.teams[0].team_id, "release");
    assert!(last.next_cursor.is_empty());
    assert!(matches!(
        store.get_team("host:worker", "release").await,
        Err(StoreError::PermissionDenied)
    ));

    let update = UpdateTeamRequest {
        operation_id: "rename-release".into(),
        team: "release".into(),
        expected_revision: team.revision,
        name: Some("Release engineers".into()),
        members: Some(TeamMembers {
            tag_ids: vec!["lead".into(), "reviewer".into()],
        }),
        max_concurrency: Some(0),
    };
    let updated = store.update_team(OPERATOR, &update).await.unwrap();
    assert_eq!(updated.name, "Release engineers");
    assert_eq!(updated.max_concurrency, None);
    assert_eq!(updated.revision, 2);
    assert_eq!(store.update_team(OPERATOR, &update).await.unwrap(), updated);
    let refreshed = UpdateTeamRequest {
        expected_revision: updated.revision,
        ..update.clone()
    };
    assert_eq!(
        store.update_team(OPERATOR, &refreshed).await.unwrap(),
        updated
    );
    let mut satisfied = update.clone();
    satisfied.operation_id = "satisfied-replay".into();
    assert_eq!(
        store.update_team(OPERATOR, &satisfied).await.unwrap(),
        updated
    );
    let mut conflicting = satisfied;
    conflicting.operation_id = "stale-update".into();
    conflicting.name = Some("Stale name".into());
    assert!(matches!(
        store.update_team(OPERATOR, &conflicting).await,
        Err(StoreError::FailedPrecondition(_))
    ));
}

async fn team_work(store: &Store, clock: &AtomicI64) {
    let host = support::register_host(store, "worker").await;
    let other_host = support::register_host(store, "another-worker").await;
    let first = store
        .create_objective(OPERATOR, &create_objective("first", "lead", "release"))
        .await
        .unwrap();
    let second = store
        .create_objective(
            OPERATOR,
            &create_objective("second", "reviewer", "Release engineers"),
        )
        .await
        .unwrap();
    assert_eq!(first.team_id.as_deref(), Some("release"));
    assert_eq!(second.team_id, first.team_id);
    let one = claim(store, &host, &first.starting_task_id).await;
    let two = claim(store, &other_host, &second.starting_task_id).await;
    store
        .update_team(
            OPERATOR,
            &UpdateTeamRequest {
                operation_id: "restrict-release".into(),
                team: "release".into(),
                expected_revision: 2,
                max_concurrency: Some(1),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        store.start_task(&other_host, &start(&two)).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    store.start_task(&host, &start(&one)).await.unwrap();

    let unrelated = store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                output_policy: None,
                execution_limits: None,
                operation_id: "outside-op".into(),
                tag_id: "outsider".into(),
                session_id: "ordinary".into(),
                prompt: "Unrelated work".into(),
                input_artifacts: vec![],
            },
        )
        .await
        .unwrap();
    let outside = claim(store, &other_host, &unrelated.task_id).await;
    store
        .start_task(&other_host, &start(&outside))
        .await
        .unwrap();
    assert!(
        store
            .claim_task(&other_host, "at-team-cap")
            .await
            .unwrap()
            .is_none()
    );
    let denied = PostAttemptWorkstreamRequest {
        attempt: Some(outside.clone()),
        operation_id: "outside".into(),
        body: "Not my team".into(),
        ..Default::default()
    };
    assert!(matches!(
        store.post_attempt_workstream(&other_host, &denied).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    finish(store, &other_host, &outside).await;

    let post = PostAttemptWorkstreamRequest {
        attempt: Some(one.clone()),
        operation_id: "progress".into(),
        body: " Reviewed the rollout. ".into(),
        to_tag_ids: vec![],
    };
    assert!(matches!(
        store.post_attempt_workstream(&other_host, &post).await,
        Err(StoreError::PermissionDenied)
    ));
    let mut addressed = post.clone();
    addressed.operation_id = "addressed".into();
    addressed.to_tag_ids = vec!["outsider".into()];
    assert!(matches!(
        store.post_attempt_workstream(&host, &addressed).await,
        Err(StoreError::PermissionDenied)
    ));
    let first_post = store.post_attempt_workstream(&host, &post).await.unwrap();
    assert!(!first_post.duplicate);
    assert_eq!(first_post.post.as_ref().unwrap().sequence, 1);
    let replay = store.post_attempt_workstream(&host, &post).await.unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.post, first_post.post);
    let mut duplicate = post.clone();
    duplicate.operation_id = "duplicate-progress".into();
    assert!(
        store
            .post_attempt_workstream(&host, &duplicate)
            .await
            .unwrap()
            .duplicate
    );
    let mut conflict = post;
    conflict.body = "Changed operation".into();
    assert!(matches!(
        store.post_attempt_workstream(&host, &conflict).await,
        Err(StoreError::Conflict(_))
    ));
    addressed.to_tag_ids = vec!["reviewer".into(), "reviewer".into()];
    let second_post = store
        .post_attempt_workstream(&host, &addressed)
        .await
        .unwrap()
        .post
        .unwrap();
    assert_eq!(second_post.sequence, 2);
    assert_eq!(second_post.to_tag_ids, ["reviewer"]);
    // Addressed posts now enqueue a durable inbox turn. This turn is outside
    // the sender's Objective and does not consume its Team's Objective slots.
    let inbox = store
        .claim_task(&other_host, "addressed-post-inbox")
        .await
        .unwrap()
        .unwrap();
    let inbox_task = inbox.task.unwrap();
    assert_eq!(inbox_task.session_id, "inbox:reviewer");
    let inbox_attempt = InspectAttemptRequest {
        task_id: inbox_task.task_id,
        attempt_id: inbox.attempt_id,
        lease_token: inbox.lease_token,
    };
    store
        .start_task(&other_host, &start(&inbox_attempt))
        .await
        .unwrap();
    finish(store, &other_host, &inbox_attempt).await;
    let read = store
        .read_attempt_workstream(
            &host,
            &ReadAttemptWorkstreamRequest {
                attempt: Some(one.clone()),
                limit: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(read.team.unwrap().team_id, "release");
    assert_eq!(read.page.unwrap().posts, std::slice::from_ref(&second_post));
    let latest = store
        .list_workstream_posts(
            OPERATOR,
            &ListWorkstreamPostsRequest {
                team: "release".into(),
                limit: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(latest.posts, std::slice::from_ref(&second_post));
    assert!(latest.next_cursor.is_empty());
    let beginning = store
        .list_workstream_posts(
            OPERATOR,
            &ListWorkstreamPostsRequest {
                team: "release".into(),
                after_sequence: Some(0),
                limit: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(beginning.posts[0].sequence, 1);
    let remainder = store
        .list_workstream_posts(
            OPERATOR,
            &ListWorkstreamPostsRequest {
                team: "release".into(),
                cursor: beginning.next_cursor,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(remainder.posts, [second_post]);

    // tests/workstream-post-store.test.ts: text, addressees, and read options are validated.
    let invalid_post =
        |operation: &str, body: String, to: Vec<String>| PostAttemptWorkstreamRequest {
            attempt: Some(one.clone()),
            operation_id: operation.into(),
            body,
            to_tag_ids: to,
        };
    for request in [
        invalid_post("blank", "  \n ".into(), vec![]),
        invalid_post("nul", "a\0b".into(), vec![]),
        invalid_post("long", "é".repeat(16_385), vec![]),
        invalid_post(
            "crowded",
            "Too many".into(),
            (0..21).map(|index| format!("tag-{index}")).collect(),
        ),
        invalid_post("empty-recipient", "Hello".into(), vec![String::new()]),
    ] {
        let operation = request.operation_id.clone();
        assert!(
            matches!(
                store.post_attempt_workstream(&host, &request).await,
                Err(StoreError::InvalidArgument(_))
            ),
            "{operation}"
        );
    }
    assert!(
        store
            .post_attempt_workstream(&host, &invalid_post("longest", "é".repeat(16_384), vec![]))
            .await
            .unwrap()
            .post
            .is_some()
    );
    for read in [
        ListWorkstreamPostsRequest {
            team: "release".into(),
            cursor: "not-a-cursor".into(),
            ..Default::default()
        },
        ListWorkstreamPostsRequest {
            team: "release".into(),
            after_sequence: Some(u64::MAX),
            ..Default::default()
        },
    ] {
        assert!(matches!(
            store.list_workstream_posts(OPERATOR, &read).await,
            Err(StoreError::InvalidArgument(_))
        ));
    }

    // Concurrent posts, each sent twice at once, take one gap-free sequence each, and
    // incremental reads return every post once in order.
    const AUTHORS: usize = 24;
    let mut posts = tokio::task::JoinSet::new();
    for index in 0..AUTHORS {
        for _ in 0..2 {
            let (store, host) = (store.clone(), host.clone());
            let request = invalid_post(
                &format!("concurrent-{index}"),
                format!("Finding {index}"),
                vec![],
            );
            posts.spawn(
                async move { (index, store.post_attempt_workstream(&host, &request).await) },
            );
        }
    }
    let mut answers = std::collections::BTreeMap::<usize, Vec<WorkstreamPost>>::new();
    while let Some(joined) = posts.join_next().await {
        let (index, answer) = joined.unwrap();
        answers
            .entry(index)
            .or_default()
            .push(answer.unwrap().post.unwrap());
    }
    let mut sequences = Vec::new();
    for (index, pair) in &answers {
        assert_eq!(pair.len(), 2);
        assert_eq!(pair[0], pair[1], "a retry returns the same post");
        assert_eq!(pair[0].body, format!("Finding {index}"));
        sequences.push(pair[0].sequence);
    }
    sequences.sort_unstable();
    let first = sequences[0];
    assert_eq!(
        sequences,
        (first..first + AUTHORS as u64).collect::<Vec<_>>()
    );
    let mut read = Vec::new();
    let mut page = ListWorkstreamPostsRequest {
        team: "release".into(),
        after_sequence: Some(first - 1),
        limit: 5,
        ..Default::default()
    };
    loop {
        let answer = store.list_workstream_posts(OPERATOR, &page).await.unwrap();
        read.extend(answer.posts.into_iter().map(|post| post.sequence));
        if answer.next_cursor.is_empty() {
            break;
        }
        page = ListWorkstreamPostsRequest {
            team: "release".into(),
            cursor: answer.next_cursor,
            limit: 5,
            ..Default::default()
        };
    }
    assert_eq!(read, sequences);

    let delete = DeleteTeamRequest {
        operation_id: "delete-release".into(),
        team: "release".into(),
    };
    assert!(matches!(
        store.delete_team(OPERATOR, &delete).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    finish(store, &host, &one).await;
    store
        .create_objective(OPERATOR, &create_objective("third", "lead", "release"))
        .await
        .unwrap();
    let (claim_one, claim_two) = tokio::join!(
        store.claim_task(&host, "race-one"),
        store.claim_task(&other_host, "race-two"),
    );
    let (assignment, assigned_host) = match (claim_one.unwrap(), claim_two.unwrap()) {
        (Some(assignment), None) => (assignment, &host),
        (None, Some(assignment)) => (assignment, &other_host),
        _ => panic!("a Team limit of one must reserve just one of the two queued Tasks"),
    };
    let task = assignment.task.unwrap();
    assert_eq!(task.task_id, second.starting_task_id);
    let two = InspectAttemptRequest {
        task_id: task.task_id,
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    };
    store.start_task(assigned_host, &start(&two)).await.unwrap();
    clock.store(NOW + 60_000, Ordering::SeqCst);
    assert!(matches!(
        store
            .post_attempt_workstream(
                assigned_host,
                &PostAttemptWorkstreamRequest {
                    attempt: Some(two.clone()),
                    operation_id: "expired".into(),
                    body: "Expired attempt".into(),
                    ..Default::default()
                }
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    for id in ["first", "second", "third"] {
        store
            .cancel_objective(
                OPERATOR,
                &ObjectiveActionRequest {
                    objective_id: id.into(),
                    operation_id: format!("cancel-{id}"),
                    reason: "Finished checking".into(),
                },
            )
            .await
            .unwrap();
    }
    let deleted = store.delete_team(OPERATOR, &delete).await.unwrap();
    assert_eq!(store.delete_team(OPERATOR, &delete).await.unwrap(), deleted);
    assert_eq!(
        store
            .get_objective("operator:local", "first")
            .await
            .unwrap()
            .team_id,
        None
    );
    assert!(matches!(
        store.get_team(OPERATOR, "release").await,
        Err(StoreError::NotFound(_))
    ));
    let mut recreate = create_team("release", "Release engineers", &["lead"], None);
    recreate.operation_id = "recreate-release".into();
    let recreated = store.create_team(OPERATOR, &recreate).await.unwrap();
    assert!(recreated.revision > deleted.revision);
    assert!(
        store
            .list_workstream_posts(
                OPERATOR,
                &ListWorkstreamPostsRequest {
                    team: "release".into(),
                    ..Default::default()
                }
            )
            .await
            .unwrap()
            .posts
            .is_empty()
    );
}

async fn contract(url: String) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let now = Arc::clone(&clock);
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(move || now.load(Ordering::SeqCst));
    for id in ["lead", "reviewer", "outsider"] {
        store.put_tag(id, "Review changes", vec![]).await.unwrap();
    }
    team_lifecycle(&store).await;
    team_work(&store, &clock).await;
    store.close().await;
}

#[tokio::test]
async fn sqlite_teams_and_workstreams_contract() {
    let dir = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("teams.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_teams_and_workstreams_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("dedicated PostgreSQL URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!("supertag_rust_teams_{}", Uuid::new_v4().simple());
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
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL Team and Workstream contract failed");
}
