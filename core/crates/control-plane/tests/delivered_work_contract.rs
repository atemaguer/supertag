//! A Tag finds its own delivered work. Delivery replaces the commits a turn makes in its
//! checkout with one new commit on the Session's branch, so a commit ID the Tag quoted may not
//! exist: the Objective's report records the delivered commit and branch, `read_objective` names
//! them, and every later root turn's portfolio lists them with their state. The Objective's own
//! later turns start from its delivered commit; an unrelated Session still starts from the
//! Workspace's ref.
mod support;

use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor};
use supertag_control_plane::{AttemptAccess, HostAuthority, Store};
use supertag_protocol::{session_branch, v2::*};
use uuid::Uuid;

const OPERATOR: &str = "operator:alice";
const BASE: &str = "1111111111111111111111111111111111111111";
/// The commit delivery made.
const HEAD: &str = "2222222222222222222222222222222222222222";
/// The commit the harness made in its checkout and quoted; delivery replaced it.
const QUOTED: &str = "72f9c1e";

async fn start(store: &Store, host: &HostAuthority, expected: &str) -> InspectAttemptRequest {
    let assignment = store
        .claim_task_with_workspaces(host, &Uuid::new_v4().to_string(), &["repo".into()])
        .await
        .unwrap()
        .expect("expected Task");
    assert_eq!(assignment.task.unwrap().task_id, expected);
    let attempt = InspectAttemptRequest {
        task_id: expected.into(),
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

/// Finishes the Attempt with a delivery whose head is `head`, from wherever its Session starts.
async fn deliver(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    head: &str,
    result: &str,
    signal: ObjectiveSignal,
) {
    let start = store
        .get_workspace_continuation(host, attempt)
        .await
        .unwrap()
        .map_or(BASE.to_owned(), |prior| prior.head_commit);
    let blob = BlobReference {
        sha256: "a".repeat(64),
        byte_length: 10,
    };
    let delivery = WorkspaceDeliveryRequest {
        attempt: Some(attempt.clone()),
        delivery: Some(WorkspaceDeliveryReference {
            workspace_id: "repo".into(),
            delivery_id: format!(
                "{:x}",
                Sha256::digest(
                    serde_json::to_vec(&(&attempt.task_id, &attempt.attempt_id)).unwrap()
                )
            ),
            base_commit: BASE.into(),
            start_commit: start.clone(),
            head_commit: head.into(),
            committed: start != head,
            changed_files: u64::from(start != head),
            patch: Some(BlobReference {
                byte_length: if start == head { 0 } else { 10 },
                ..blob.clone()
            }),
            bundle: Some(blob),
        }),
    };
    store
        .reserve_workspace_delivery(host, &delivery)
        .await
        .unwrap();
    store
        .commit_workspace_delivery(host, &delivery)
        .await
        .unwrap();
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                succeeded: true,
                result: result.into(),
                objective_signal: signal as i32,
                workspace_delivery: delivery.delivery,
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

async fn portfolio(store: &Store, host: &HostAuthority, attempt: &InspectAttemptRequest) -> String {
    store
        .attempt_capabilities(&AttemptAccess::new(host, attempt))
        .await
        .unwrap()
        .tag_portfolio
}

async fn contract(url: &str) {
    let store = Store::open(url).await.unwrap();
    store
        .put_tag_with_workspace(
            "owner",
            "Fix what you are asked to",
            vec!["files:read".into()],
            Some(WorkspaceSpec {
                workspace_id: "repo".into(),
                base_commit: BASE.into(),
                ..Default::default()
            }),
        )
        .await
        .unwrap();
    let host = support::register_host(&store, "delivered-host").await;
    let objective = store
        .create_objective(
            OPERATOR,
            &CreateObjectiveRequest {
                operation_id: "fix".into(),
                objective_id: "fix".into(),
                owner_tag_id: "owner".into(),
                outcome: "Fix slugify for accented input".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let objective_branch = session_branch("owner", &objective.session_id);

    // The Objective's first turn delivers; it is told its branch before it reports.
    let first = start(&store, &host, &objective.starting_task_id).await;
    let told = portfolio(&store, &host, &first).await;
    assert!(
        told.contains(&format!(
            "as one new commit on this Session's branch, {objective_branch}"
        )) && told.contains("name the branch, not a commit ID"),
        "{told}"
    );
    assert!(!told.contains("Delivered work:"), "{told}");
    deliver(
        &store,
        &host,
        &first,
        HEAD,
        "Slugify handles accents; started.",
        ObjectiveSignal::Progress,
    )
    .await;

    // Its next turn continues from the delivered commit and sees it as its own.
    let wake: String = {
        let mut database = sqlx::AnyConnection::connect(url).await.unwrap();
        let task = sqlx::query_scalar(
            "SELECT task_id FROM supertag_v2_tasks WHERE session_id=$1 AND task_id<>$2 AND state=1",
        )
        .bind(&objective.session_id)
        .bind(&objective.starting_task_id)
        .fetch_one(&mut database)
        .await
        .unwrap();
        database.close().await.unwrap();
        task
    };
    let second = start(&store, &host, &wake).await;
    assert_eq!(
        store
            .get_workspace_continuation(&host, &second)
            .await
            .unwrap()
            .unwrap()
            .head_commit,
        HEAD
    );
    let own = portfolio(&store, &host, &second).await;
    assert!(
        own.contains(&format!(
            "- Objective fix [working] (this Session): branch {objective_branch}, commit {HEAD} in Workspace repo"
        )),
        "{own}"
    );
    // The turn quotes the commit its checkout made, which delivery replaced; the report records
    // the delivered commit and branch beside it.
    deliver(
        &store,
        &host,
        &second,
        HEAD,
        &format!("Fixed slugify in {QUOTED}; tests pass."),
        ObjectiveSignal::ReadyForReview,
    )
    .await;
    let reported = store.get_objective(OPERATOR, "fix").await.unwrap();
    assert_eq!(
        reported.completion_summary.as_deref(),
        Some(
            format!(
                "Fixed slugify in {QUOTED}; tests pass.\n\nDelivered by SuperTag as commit {HEAD} on branch {objective_branch}."
            )
            .as_str()
        )
    );

    // A later, unrelated Session starts from the Workspace's ref, not the Objective's branch, and
    // sees the delivered work, its branch and its state.
    let chat = store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: "owner".into(),
                session_id: "chat".into(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: "Did the slugify fix land?".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let later = start(&store, &host, &chat.task_id).await;
    assert!(
        store
            .get_workspace_continuation(&host, &later)
            .await
            .unwrap()
            .is_none()
    );
    let seen = portfolio(&store, &host, &later).await;
    assert!(
        seen.contains("Delivered work:")
            && seen.contains("a commit ID from a checkout or an earlier turn may not exist")
            && seen.contains(&format!(
                "- Objective fix [ready_for_review]: branch {objective_branch}, commit {HEAD} in Workspace repo, delivered "
            ))
            && seen.contains(&format!(
                "this Session's branch, {}",
                session_branch("owner", "chat")
            )),
        "{seen}"
    );
    assert!(!seen.contains(QUOTED), "{seen}");
    let read = store
        .read_tag_objective(
            &AttemptAccess::new(&host, &later),
            &ReadTagObjectiveRequest {
                objective_id: Some("fix".into()),
            },
        )
        .await
        .unwrap();
    let delivery = read.sessions[0].delivery.as_ref().expect("a delivery");
    assert_eq!(
        (delivery.head_commit.as_str(), delivery.branch.as_str()),
        (HEAD, objective_branch.as_str())
    );
    assert!(read.sessions[0].failure.is_none());
    deliver(
        &store,
        &host,
        &later,
        BASE,
        &format!("Yes: commit {HEAD} on {objective_branch}."),
        ObjectiveSignal::Progress,
    )
    .await;

    // A Session whose deliveries changed nothing is not listed as delivered work.
    let next = store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: "owner".into(),
                session_id: "chat".into(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: "Thanks".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let after = start(&store, &host, &next.task_id).await;
    let listed = portfolio(&store, &host, &after).await;
    assert!(!listed.contains("- Session chat"), "{listed}");
    store.close().await;
}

#[tokio::test]
async fn sqlite_delivered_work_contract() {
    let dir = tempfile::tempdir().unwrap();
    contract(&format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("delivered.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_delivered_work_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").unwrap();
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!("supertag_rust_delivered_{}", Uuid::new_v4().simple());
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
