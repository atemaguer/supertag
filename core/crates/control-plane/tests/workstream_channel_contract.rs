//! A Team's Workstream is its channel: typed posts, the default addressee of an unaddressed
//! question or blocker, and the digest an inbox turn opens with.
mod support;

use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sqlx::{Connection, Executor};
use supertag_control_plane::{AttemptAccess, HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:alice";
const NOW: i64 = 1_893_456_000_000;

async fn claim(store: &Store, host: &HostAuthority) -> InspectAttemptRequest {
    let claim = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .expect("expected one claim");
    let task = claim.task.unwrap();
    InspectAttemptRequest {
        task_id: task.task_id,
        attempt_id: claim.attempt_id,
        lease_token: claim.lease_token,
    }
}

/// Claims the Tag's inbox turn, finishing any other turn the Objective queued first.
async fn claim_inbox(store: &Store, host: &HostAuthority, tag: &str) -> InspectAttemptRequest {
    for _ in 0..4 {
        let attempt = claim(store, host).await;
        if store.get_task(&attempt.task_id).await.unwrap().session_id == format!("inbox:{tag}") {
            return attempt;
        }
        start(store, host, &attempt).await;
        finish(store, host, &attempt).await;
        store.sweep_mailbox().await.unwrap();
    }
    panic!("no inbox turn for {tag}");
}

async fn start(store: &Store, host: &HostAuthority, attempt: &InspectAttemptRequest) {
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

fn post(
    operation: &str,
    body: &str,
    kind: MessageKind,
    to: &[&str],
) -> PostAttemptWorkstreamRequest {
    PostAttemptWorkstreamRequest {
        operation_id: operation.into(),
        body: body.into(),
        to_tag_ids: to.iter().map(|id| (*id).into()).collect(),
        kind: kind.into(),
    }
}

async fn contract(url: String) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let now = Arc::clone(&clock);
    let store = Store::open(&url)
        .await
        .unwrap()
        .with_execution_clock(move || now.load(Ordering::SeqCst));
    for id in ["lead", "reviewer", "builder"] {
        store.put_tag(id, "Ship the release", vec![]).await.unwrap();
    }
    store
        .create_team(
            OPERATOR,
            &CreateTeamRequest {
                operation_id: "create-release".into(),
                team_id: "release".into(),
                name: "Release".into(),
                member_tag_ids: vec!["lead".into(), "reviewer".into(), "builder".into()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let objective = store
        .create_objective(
            OPERATOR,
            &CreateObjectiveRequest {
                operation_id: "objective-ship".into(),
                objective_id: "ship".into(),
                owner_tag_id: "lead".into(),
                outcome: "Ship the release".into(),
                team_id: Some("release".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let host = support::register_host(&store, "worker").await;
    let lead = claim(&store, &host).await;
    assert_eq!(lead.task_id, objective.starting_task_id);
    start(&store, &host, &lead).await;
    let as_lead = AttemptAccess::new(&host, &lead);

    // The owner's own unaddressed question names nobody.
    let asked = store
        .post_attempt_workstream(
            &as_lead,
            &post("ask", "Which branch ships?", MessageKind::Question, &[]),
        )
        .await
        .unwrap();
    let asked = asked.post.unwrap();
    assert_eq!(asked.kind(), MessageKind::Question);
    assert!(asked.to_tag_ids.is_empty());
    assert_eq!(asked.sequence, 1);

    // An unspecified kind is a note; Tags cannot mark a review request or invent a kind.
    let noted = store
        .post_attempt_workstream(
            &as_lead,
            &post(
                "note",
                "Please check the changelog.",
                MessageKind::Unspecified,
                &["reviewer"],
            ),
        )
        .await
        .unwrap();
    assert!(noted.wake_deferred.is_empty());
    let noted = noted.post.unwrap();
    assert_eq!(noted.kind(), MessageKind::Note);
    assert_eq!(noted.to_tag_ids, ["reviewer"]);
    for (operation, kind) in [("review", MessageKind::Review as i32), ("unknown", 99)] {
        let mut request = post(operation, "Not allowed", MessageKind::Note, &[]);
        request.kind = kind;
        assert!(
            matches!(
                store.post_attempt_workstream(&as_lead, &request).await,
                Err(StoreError::InvalidArgument(_))
            ),
            "{operation}"
        );
    }

    // The kind is part of the operation and of the effect.
    assert!(matches!(
        store
            .post_attempt_workstream(
                &as_lead,
                &post(
                    "note",
                    "Please check the changelog.",
                    MessageKind::Decision,
                    &["reviewer"]
                ),
            )
            .await,
        Err(StoreError::Conflict(_))
    ));
    let replay = store
        .post_attempt_workstream(
            &as_lead,
            &post(
                "note",
                "Please check the changelog.",
                MessageKind::Note,
                &["reviewer"],
            ),
        )
        .await
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.post.as_ref(), Some(&noted));
    let same_effect = store
        .post_attempt_workstream(
            &as_lead,
            &post(
                "note-again",
                "Please check the changelog.",
                MessageKind::Note,
                &["reviewer"],
            ),
        )
        .await
        .unwrap();
    assert!(same_effect.duplicate);
    assert_eq!(same_effect.post.as_ref(), Some(&noted));
    let decided = store
        .post_attempt_workstream(
            &as_lead,
            &post(
                "decide",
                "Please check the changelog.",
                MessageKind::Decision,
                &["reviewer"],
            ),
        )
        .await
        .unwrap();
    assert!(!decided.duplicate);
    let decided = decided.post.unwrap();
    assert_eq!(
        (decided.kind(), decided.sequence),
        (MessageKind::Decision, 3)
    );
    finish(&store, &host, &lead).await;

    // The reviewer's inbox turn takes the posts addressed to it.
    clock.fetch_add(10_000, Ordering::SeqCst);
    store.sweep_mailbox().await.unwrap();
    let reviewer = claim_inbox(&store, &host, "reviewer").await;
    start(&store, &host, &reviewer).await;
    let prompt = store.get_task(&reviewer.task_id).await.unwrap().prompt;
    assert!(prompt.contains("Please check the changelog."), "{prompt}");
    let as_reviewer = AttemptAccess::new(&host, &reviewer);

    // From an inbox turn, an unaddressed note goes nowhere, and an unaddressed blocker goes to the
    // owner of the Objective the turn's messages came from.
    let evidence = store
        .post_attempt_workstream(
            &as_reviewer,
            &post(
                "evidence",
                "The changelog lists every fix.",
                MessageKind::Evidence,
                &[],
            ),
        )
        .await
        .unwrap()
        .post
        .unwrap();
    assert_eq!(evidence.kind(), MessageKind::Evidence);
    assert!(evidence.to_tag_ids.is_empty());
    let blocked = store
        .post_attempt_workstream(
            &as_reviewer,
            &post(
                "blocked",
                "The release notes are missing.",
                MessageKind::Blocker,
                &[],
            ),
        )
        .await
        .unwrap()
        .post
        .unwrap();
    assert_eq!(blocked.kind(), MessageKind::Blocker);
    assert_eq!(blocked.to_tag_ids, ["lead"]);
    finish(&store, &host, &reviewer).await;

    // The owner's inbox turn shows the blocker that woke it, and a digest of the other unread
    // posts, without its own.
    clock.fetch_add(10_000, Ordering::SeqCst);
    store.sweep_mailbox().await.unwrap();
    let owner = claim_inbox(&store, &host, "lead").await;
    start(&store, &host, &owner).await;
    let prompt = store.get_task(&owner.task_id).await.unwrap().prompt;
    assert!(
        prompt.contains("The release notes are missing."),
        "{prompt}"
    );
    assert!(
        prompt.contains("The changelog lists every fix."),
        "{prompt}"
    );
    assert!(prompt.contains("type=\"evidence\""), "{prompt}");
    assert!(!prompt.contains("Which branch ships?"), "{prompt}");
    finish(&store, &host, &owner).await;

    // Reads and the Objective overview carry each post's kind.
    let page = store
        .list_workstream_posts(
            OPERATOR,
            &ListWorkstreamPostsRequest {
                team: "release".into(),
                after_sequence: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        page.posts
            .iter()
            .map(|post| (post.sequence, post.kind()))
            .collect::<Vec<_>>(),
        [
            (1, MessageKind::Question),
            (2, MessageKind::Note),
            (3, MessageKind::Decision),
            (4, MessageKind::Evidence),
            (5, MessageKind::Blocker),
        ]
    );
    let overview = store
        .objective_overview(
            OPERATOR,
            &GetObjectiveOverviewRequest {
                objective_id: "ship".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        overview
            .posts
            .iter()
            .map(|post| (post.sequence, post.kind(), post.to_tag_ids.clone()))
            .collect::<Vec<_>>(),
        [
            (1, MessageKind::Question, vec![]),
            (2, MessageKind::Note, vec!["reviewer".to_owned()]),
            (3, MessageKind::Decision, vec!["reviewer".to_owned()]),
            (4, MessageKind::Evidence, vec![]),
            (5, MessageKind::Blocker, vec!["lead".to_owned()]),
        ]
    );
    store.close().await;
}

#[tokio::test]
async fn sqlite_workstream_channel_contract() {
    let dir = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("workstream.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_workstream_channel_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("dedicated PostgreSQL URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!("supertag_rust_workstream_{}", Uuid::new_v4().simple());
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
    outcome.expect("PostgreSQL Workstream channel contract failed");
}
