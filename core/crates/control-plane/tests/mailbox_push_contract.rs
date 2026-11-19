//! A Tag follows its Mailbox and Workstream through a held claim: a blocker sent to it, directly
//! or as an addressed post, makes its inbox turn in the send, and the held claim takes that turn
//! at once instead of at the end of its wait.
mod support;

use std::time::{Duration, Instant};

use sqlx::{Connection, Executor};
use supertag_control_plane::{AttemptAccess, HostAuthority, Store};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:alice";

async fn claim(store: &Store, host: &HostAuthority, tag: &str) -> InspectAttemptRequest {
    let assignment = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .expect("queued Task");
    let task = assignment.task.unwrap();
    assert_eq!(task.tag_id, tag);
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

/// Holds a claim for `host` while `send` runs once the claim is held; returns the Task the
/// claim took and how long after the send it took it.
async fn held_while(
    store: &Store,
    host: &HostAuthority,
    send: impl AsyncFnOnce(),
) -> (Option<Assignment>, Duration) {
    let request = ClaimTaskRequest {
        operation_id: Uuid::new_v4().to_string(),
        wait_ms: 6_000,
        ..Default::default()
    };
    let held = store.claim_task_waiting(host, &request, Duration::from_secs(6));
    let sending = async {
        let deadline = Instant::now() + Duration::from_secs(10);
        while store.waiting_claims(host) < 1 {
            assert!(Instant::now() < deadline, "the claim was not held");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let sent = Instant::now();
        send().await;
        sent
    };
    let (assignment, sent) = tokio::join!(held, sending);
    (assignment.unwrap(), sent.elapsed())
}

async fn contract(url: &str) {
    let store = Store::open(url).await.unwrap();
    for tag in ["builder", "reviewer"] {
        store.put_tag(tag, "Coordinate", vec![]).await.unwrap();
    }
    store
        .create_team(
            OPERATOR,
            &CreateTeamRequest {
                operation_id: "crew".into(),
                team_id: "crew".into(),
                name: "Crew".into(),
                member_tag_ids: vec!["builder".into(), "reviewer".into()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let host = support::register_host(&store, "push").await;
    store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: "builder".into(),
                session_id: "build".into(),
                operation_id: "build".into(),
                prompt: "Build the parser".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let builder = claim(&store, &host, "builder").await;
    let access = AttemptAccess::new(&host, &builder);

    // A direct blocker.
    let (assignment, after) = held_while(&store, &host, async || {
        store
            .send_attempt_tag_message(
                &access,
                &SendAttemptTagMessageRequest {
                    kind: MessageKind::Blocker as i32,
                    operation_id: "blocked".into(),
                    recipient_tag_id: "reviewer".into(),
                    text: "Blocked until the parser is reviewed".into(),
                    review: None,
                },
            )
            .await
            .unwrap();
    })
    .await;
    let assignment = assignment.expect("the held claim took the inbox turn");
    let task = assignment.task.clone().unwrap();
    assert_eq!(
        (task.tag_id.as_str(), task.session_id.as_str()),
        ("reviewer", "inbox:reviewer")
    );
    assert!(after < Duration::from_millis(900), "{after:?}");
    let inbox = InspectAttemptRequest {
        task_id: task.task_id,
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    };
    store
        .start_task(
            &host,
            &StartTaskRequest {
                task_id: inbox.task_id.clone(),
                attempt_id: inbox.attempt_id.clone(),
                lease_token: inbox.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    assert!(
        store
            .get_task(&inbox.task_id)
            .await
            .unwrap()
            .prompt
            .contains("Blocked until the parser is reviewed")
    );
    finish(&store, &host, &inbox).await;

    // A Workstream blocker addressed to the reviewer.
    let (assignment, after) = held_while(&store, &host, async || {
        store
            .post_attempt_workstream(
                &access,
                &PostAttemptWorkstreamRequest {
                    kind: MessageKind::Blocker as i32,
                    operation_id: "post-blocked".into(),
                    body: "Still blocked on the parser review".into(),
                    to_tag_ids: vec!["reviewer".into()],
                },
            )
            .await
            .unwrap();
    })
    .await;
    let task = assignment
        .expect("the held claim took the inbox turn")
        .task
        .unwrap();
    assert_eq!(task.session_id, "inbox:reviewer");
    assert!(after < Duration::from_millis(900), "{after:?}");
    store.close().await;
}

#[tokio::test]
async fn sqlite_mailbox_push_contract() {
    let directory = tempfile::tempdir().unwrap();
    contract(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("push.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL server"]
async fn postgres_mailbox_push_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_mailbox_push_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
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
    result.expect("PostgreSQL Mailbox push contract failed");
}
