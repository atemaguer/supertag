//! A Team's Workstream is its channel and shared record: posts have no type and wake nobody, and
//! every inbox turn of a member opens with the digest of the posts it has not seen.
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

fn post(operation: &str, body: &str, to: &[&str]) -> PostAttemptWorkstreamRequest {
    PostAttemptWorkstreamRequest {
        operation_id: operation.into(),
        body: body.into(),
        to_tag_ids: to.iter().map(|id| (*id).into()).collect(),
    }
}

fn message(
    operation: &str,
    to: &str,
    text: &str,
    kind: MessageKind,
) -> SendAttemptTagMessageRequest {
    SendAttemptTagMessageRequest {
        operation_id: operation.into(),
        recipient_tag_id: to.into(),
        text: text.into(),
        kind: kind.into(),
        review: None,
        recipient_objective_id: String::new(),
    }
}

async fn pending_wakes(store: &Store) -> i64 {
    store.metrics().await.unwrap().mailbox.unwrap().pending
}

async fn mailbox(store: &Store, tag: &str) -> Vec<TagMessage> {
    store
        .list_mailbox_messages(
            OPERATOR,
            &ListMailboxMessagesRequest {
                tag_id: tag.into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .messages
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
    // Only the inbox Session and person conversations reach other Tags: the lead posts from a
    // root Session that is not an Objective's.
    let shipping = store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                operation_id: "ship".into(),
                tag_id: "lead".into(),
                session_id: "ship".into(),
                prompt: "Ship the release".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let host = support::register_host(&store, "worker").await;
    let lead = claim(&store, &host).await;
    assert_eq!(lead.task_id, shipping.task_id);
    start(&store, &host, &lead).await;
    let as_lead = AttemptAccess::new(&host, &lead);

    // Posts have no type and wake nobody, addressed or not.
    let asked = store
        .post_attempt_workstream(&as_lead, &post("ask", "Which branch ships?", &[]))
        .await
        .unwrap()
        .post
        .unwrap();
    assert!(asked.to_tag_ids.is_empty());
    assert_eq!(asked.sequence, 1);
    let noted = store
        .post_attempt_workstream(
            &as_lead,
            &post("note", "Please check the changelog.", &["reviewer"]),
        )
        .await
        .unwrap()
        .post
        .unwrap();
    assert_eq!(noted.to_tag_ids, ["reviewer"]);
    let replay = store
        .post_attempt_workstream(
            &as_lead,
            &post("note", "Please check the changelog.", &["reviewer"]),
        )
        .await
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.post.as_ref(), Some(&noted));
    assert!(matches!(
        store
            .post_attempt_workstream(
                &as_lead,
                &post("note", "Please check the changelog.", &["builder"]),
            )
            .await,
        Err(StoreError::Conflict(_))
    ));
    clock.fetch_add(10_000, Ordering::SeqCst);
    store.sweep_mailbox().await.unwrap();
    assert_eq!(pending_wakes(&store).await, 0, "a post writes no wake");
    let addressed = mailbox(&store, "reviewer").await;
    assert_eq!(addressed.len(), 1);
    assert_eq!(addressed[0].state(), TagMessageState::Pending);
    assert_eq!(addressed[0].task_id, None);

    // A direct message wakes its recipient, and the turn opens with the Team's digest: the post
    // addressed to the reviewer first, then the rest, then the message.
    store
        .send_attempt_tag_message(
            &as_lead,
            &message(
                "review",
                "reviewer",
                "Can you review today?",
                MessageKind::Question,
            ),
        )
        .await
        .unwrap();
    finish(&store, &host, &lead).await;
    clock.fetch_add(10_000, Ordering::SeqCst);
    store.sweep_mailbox().await.unwrap();
    let reviewer = claim_inbox(&store, &host, "reviewer").await;
    start(&store, &host, &reviewer).await;
    let prompt = store.get_task(&reviewer.task_id).await.unwrap().prompt;
    let positions: Vec<usize> = [
        "Please check the changelog.",
        "Which branch ships?",
        "Can you review today?",
    ]
    .iter()
    .map(|text| {
        prompt
            .find(text)
            .unwrap_or_else(|| panic!("{text}: {prompt}"))
    })
    .collect();
    assert!(
        positions.windows(2).all(|pair| pair[0] < pair[1]),
        "{prompt}"
    );
    assert!(prompt.contains("to=\"you\""), "{prompt}");
    assert!(!prompt.contains("via=\"workstream post\""), "{prompt}");
    assert!(
        prompt.contains("3 unread messages, 2 address you."),
        "{prompt}"
    );
    assert_eq!(
        mailbox(&store, "reviewer")
            .await
            .iter()
            .find(|message| message.workstream_post_id.is_some())
            .unwrap()
            .state(),
        TagMessageState::Handled,
        "a digest showed the addressed post"
    );
    let as_reviewer = AttemptAccess::new(&host, &reviewer);

    // An unaddressed post from an inbox turn goes to nobody: no Objective owner is woken.
    let evidence = store
        .post_attempt_workstream(
            &as_reviewer,
            &post("evidence", "The release notes are missing.", &[]),
        )
        .await
        .unwrap()
        .post
        .unwrap();
    assert!(evidence.to_tag_ids.is_empty());
    store
        .send_attempt_tag_message(
            &as_reviewer,
            &message(
                "blocked",
                "lead",
                "Blocked on the release notes.",
                MessageKind::Blocker,
            ),
        )
        .await
        .unwrap();
    finish(&store, &host, &reviewer).await;

    // The owner's next inbox turn shows only what it has not seen: not its own posts.
    store.sweep_mailbox().await.unwrap();
    let owner = claim_inbox(&store, &host, "lead").await;
    start(&store, &host, &owner).await;
    let prompt = store.get_task(&owner.task_id).await.unwrap().prompt;
    assert!(
        prompt.contains("The release notes are missing."),
        "{prompt}"
    );
    assert!(prompt.contains("Blocked on the release notes."), "{prompt}");
    assert!(prompt.contains("type=\"blocker\""), "{prompt}");
    assert!(!prompt.contains("Which branch ships?"), "{prompt}");
    let as_owner = AttemptAccess::new(&host, &owner);
    store
        .send_attempt_tag_message(
            &as_owner,
            &message("thanks", "reviewer", "Writing them now.", MessageKind::Note),
        )
        .await
        .unwrap();
    finish(&store, &host, &owner).await;

    // Every inbox turn has a digest of what is new since the last one, even when no post woke it.
    clock.fetch_add(10_000, Ordering::SeqCst);
    store.sweep_mailbox().await.unwrap();
    let again = claim_inbox(&store, &host, "reviewer").await;
    start(&store, &host, &again).await;
    let prompt = store.get_task(&again.task_id).await.unwrap().prompt;
    assert!(prompt.contains("Writing them now."), "{prompt}");
    assert!(!prompt.contains("Please check the changelog."), "{prompt}");
    assert!(!prompt.contains("<workstream-post"), "{prompt}");
    finish(&store, &host, &again).await;

    // Reads show each post's addressees.
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
            .map(|post| (post.sequence, post.to_tag_ids.clone()))
            .collect::<Vec<_>>(),
        [(1, vec![]), (2, vec!["reviewer".to_owned()]), (3, vec![]),]
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
