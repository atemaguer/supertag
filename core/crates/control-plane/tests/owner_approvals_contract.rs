//! A personal Tag's owner decides its approval requests from any of their devices, beside the
//! operators, even when the Permission Set names only operators; another User neither sees nor
//! decides them. On SQLite and PostgreSQL.
use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor};
use supertag_control_plane::{AttemptAccess, HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:local";

async fn invite(store: &Store, name: &str) {
    store
        .invite_user(
            OPERATOR,
            &InviteUserRequest {
                operation_id: format!("invite-{name}"),
                name: name.into(),
                display_name: name.into(),
                key_digest: Sha256::digest(format!("key {name}")).to_vec(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

/// Runs a Task of Alice's Tag that asks to post to its Workstream, and returns the pending
/// approval.
async fn request(store: &Store, host: &HostAuthority, session: &str) -> Approval {
    let task = store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: "alice".into(),
                session_id: session.into(),
                operation_id: session.into(),
                prompt: "Post the update".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let claimed = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claimed.task.unwrap().task_id, task.task_id);
    let attempt = InspectAttemptRequest {
        task_id: task.task_id.clone(),
        attempt_id: claimed.attempt_id,
        lease_token: claimed.lease_token,
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
    store
        .post_attempt_workstream(
            &AttemptAccess::new(host, &attempt),
            &PostAttemptWorkstreamRequest {
                operation_id: format!("post-{session}"),
                body: "An update".into(),
                to_tag_ids: vec![],
            },
        )
        .await
        .unwrap()
        .approval
        .expect("the post waits for approval")
}

fn decide(id: &str, operation: &str, approve: bool) -> DecideApprovalRequest {
    DecideApprovalRequest {
        approval_id: id.into(),
        operation_id: operation.into(),
        approve,
        // A denial grants no scope.
        scope: if approve {
            ApprovalScope::Once as i32
        } else {
            0
        },
        valid_until_ms: None,
        reason: "Reviewed".into(),
    }
}

async fn listed(store: &Store, principal: &str) -> Vec<String> {
    store
        .list_approvals(principal, &ListApprovalsRequest::default())
        .await
        .unwrap()
        .approvals
        .into_iter()
        .map(|approval| approval.approval_id)
        .collect()
}

async fn contract(url: &str) {
    let store = Store::open(url).await.unwrap();
    invite(&store, "alice").await;
    invite(&store, "bob").await;
    // The operator grants Alice's Tag a Workstream post that only an operator is named to approve.
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "alice".into(),
            instructions: "Coordinate".into(),
            allowed_actions: vec!["workstream:post".into()],
            approval_rules: vec![ApprovalRule {
                action: "workstream:post".into(),
                operator_ids: vec!["local".into()],
            }],
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(store.get_tag("alice").await.unwrap().owner, "alice");
    store
        .create_team(
            OPERATOR,
            &CreateTeamRequest {
                operation_id: "team".into(),
                team_id: "people".into(),
                name: "People".into(),
                member_tag_ids: vec!["alice".into()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    // Alice's own Worker Host, enrolled with her invite key, runs her Tag.
    store
        .enroll(
            &Sha256::digest("key alice"),
            &EnrollRequest {
                role: PrincipalRole::Host.into(),
                name: "alice-box".into(),
                operation_id: "alice-box".into(),
                token_digest: Sha256::digest("alice-box credential").to_vec(),
            },
        )
        .await
        .unwrap();
    let record = store
        .register_host("alice-box", "incarnation")
        .await
        .unwrap();
    let host = HostAuthority::new("host:alice-box".to_owned(), record.generation).unwrap();

    // Alice sees and decides her Tag's request; Bob neither sees nor decides it.
    let first = request(&store, &host, "first").await;
    assert_eq!(
        listed(&store, "user:alice").await,
        vec![first.approval_id.clone()]
    );
    assert!(listed(&store, "user:bob").await.is_empty());
    assert!(matches!(
        store.get_approval("user:bob", &first.approval_id).await,
        Err(StoreError::NotFound(_))
    ));
    assert!(matches!(
        store
            .decide_approval("user:bob", &decide(&first.approval_id, "bob", true))
            .await,
        Err(StoreError::NotFound(_))
    ));
    let approved = store
        .decide_approval("user:alice", &decide(&first.approval_id, "alice-1", true))
        .await
        .unwrap();
    assert_eq!(approved.state(), ApprovalState::Approved);

    // She may deny one too, and an operator still decides.
    let second = request(&store, &host, "second").await;
    let denied = store
        .decide_approval("user:alice", &decide(&second.approval_id, "alice-2", false))
        .await
        .unwrap();
    assert_eq!(denied.state(), ApprovalState::Denied);
    assert!(listed(&store, OPERATOR).await.contains(&first.approval_id));
    store.close().await;
}

#[tokio::test]
async fn sqlite_owner_approvals_contract() {
    contract("sqlite::memory:").await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_owner_approvals_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let database = format!("supertag_rust_owner_approvals_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&database);
    let local = tokio::task::LocalSet::new();
    let result = local
        .run_until(async move {
            tokio::task::spawn_local(async move { contract(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await
        .unwrap();
    result.unwrap();
}
