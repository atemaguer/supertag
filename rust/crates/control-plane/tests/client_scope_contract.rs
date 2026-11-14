//! A client sees and directs only its own work, within its Auth Key's Tags: another principal's
//! Objective questions, its completion, and Teams with members outside the key's Tags stay
//! hidden, on SQLite and PostgreSQL.
mod support;

use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:alice";
const MALLORY: &str = "client:mallory";

/// Enrolls `client:NAME` with a client Auth Key limited to `tags`.
async fn enroll_client(store: &Store, name: &str, tags: &[&str]) {
    let key = Sha256::digest(format!("client key {name}")).to_vec();
    store
        .create_auth_key(
            OPERATOR,
            &CreateAuthKeyRequest {
                name: format!("{name}-key"),
                role: PrincipalRole::Client.into(),
                operation_id: format!("{name}-key"),
                key_digest: key.clone(),
                allowed_tag_ids: tags.iter().map(|tag| (*tag).into()).collect(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .enroll(
            &key,
            &EnrollRequest {
                role: PrincipalRole::Client.into(),
                name: name.into(),
                operation_id: format!("{name}-enroll"),
                token_digest: Sha256::digest(format!("client credential {name}")).to_vec(),
            },
        )
        .await
        .unwrap();
}

fn objective(id: &str, tag: &str, team: Option<&str>) -> CreateObjectiveRequest {
    CreateObjectiveRequest {
        objective_id: id.into(),
        operation_id: format!("create-{id}"),
        owner_tag_id: tag.into(),
        outcome: "Resolve the decision".into(),
        team_id: team.map(str::to_owned),
        ..Default::default()
    }
}

/// Runs the Objective's starting Task to a published question.
async fn ask(store: &Store, host: &HostAuthority, task_id: &str, text: &str) {
    let assignment = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .expect("expected Task");
    let attempt = InspectAttemptRequest {
        task_id: task_id.into(),
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    };
    assert_eq!(assignment.task.unwrap().task_id, task_id);
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
        .ask_question(
            host,
            &AskQuestionRequest {
                attempt: Some(attempt.clone()),
                operation_id: "ask".into(),
                text: text.into(),
            },
        )
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
                result: "Waiting for your answer".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

async fn inbox(store: &Store, principal: &str) -> Vec<String> {
    store
        .list_inbox_items(principal, &ListInboxItemsRequest::default())
        .await
        .unwrap()
        .items
        .into_iter()
        .map(|item| item.objective_id)
        .collect()
}

fn answer(task_id: &str, operation: &str) -> AnswerQuestionRequest {
    AnswerQuestionRequest {
        task_id: task_id.into(),
        operation_id: operation.into(),
        text: "Also push to main".into(),
    }
}

fn complete(id: &str) -> CompleteObjectiveRequest {
    CompleteObjectiveRequest {
        objective_id: id.into(),
        operation_id: format!("complete-{id}"),
        summary: "Done".into(),
        expected_revision: None,
    }
}

async fn contract(url: &str) {
    let store = Store::open(url).await.unwrap();
    for tag in ["owner", "other"] {
        store
            .put_tag(tag, "Answer", vec!["files:read".into()])
            .await
            .unwrap();
    }
    let host = support::register_host(&store, "scope-host").await;
    enroll_client(&store, "mallory", &["other"]).await;

    // An operator's Objective on a Tag the client's key does not allow, waiting on a question.
    let secret = store
        .create_objective(OPERATOR, &objective("op-secret", "owner", None))
        .await
        .unwrap();
    ask(
        &store,
        &host,
        &secret.starting_task_id,
        "Which credentials?",
    )
    .await;
    // Choosing another conversation's thread for an Objective's notices is an operator's call: a
    // client is refused before the thread is even looked up, and nothing is created.
    let chooses = CreateObjectiveRequest {
        notification_task_id: Some("operator-thread".into()),
        ..objective("mine", "other", None)
    };
    let refused = store.create_objective(MALLORY, &chooses).await;
    assert!(
        matches!(refused, Err(StoreError::PermissionDenied)),
        "{refused:?}"
    );
    // The client's own Objective, waiting on a question too.
    let mine = store
        .create_objective(MALLORY, &objective("mine", "other", None))
        .await
        .unwrap();
    ask(&store, &host, &mine.starting_task_id, "Which branch?").await;

    // The operator's Inbox lists both; the client's lists only its own.
    let mut seen = inbox(&store, OPERATOR).await;
    seen.sort();
    assert_eq!(seen, ["mine", "op-secret"]);
    assert_eq!(inbox(&store, MALLORY).await, ["mine"]);
    let scoped = store
        .list_inbox_items(
            MALLORY,
            &ListInboxItemsRequest {
                objective_id: "op-secret".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(scoped.items.is_empty());

    // The client cannot read or answer the operator's question, as if it did not exist.
    assert!(matches!(
        store.get_question(MALLORY, &secret.starting_task_id).await,
        Err(StoreError::NotFound(_))
    ));
    assert!(matches!(
        store
            .answer_question(MALLORY, &answer(&secret.starting_task_id, "inject"))
            .await,
        Err(StoreError::NotFound(_))
    ));
    assert_eq!(
        store
            .get_question(OPERATOR, &secret.starting_task_id)
            .await
            .unwrap()
            .text,
        "Which credentials?"
    );
    // It reads and answers its own.
    assert_eq!(
        store
            .get_question(MALLORY, &mine.starting_task_id)
            .await
            .unwrap()
            .text,
        "Which branch?"
    );
    let answered = store
        .answer_question(MALLORY, &answer(&mine.starting_task_id, "mine"))
        .await
        .unwrap();
    assert_eq!(answered.tag_id, "other");

    // The client cannot complete the operator's Objective; it completes its own.
    assert!(matches!(
        store
            .complete_objective(MALLORY, &complete("op-secret"))
            .await,
        Err(StoreError::NotFound(_))
    ));
    assert_eq!(
        store
            .get_objective(OPERATOR, "op-secret")
            .await
            .unwrap()
            .status,
        ObjectiveStatus::Working as i32
    );
    assert_eq!(
        store
            .complete_objective(MALLORY, &complete("mine"))
            .await
            .unwrap()
            .status,
        ObjectiveStatus::Completed as i32
    );

    // Teams: a client sees a Team only when every member is a Tag its key allows.
    for (team, members) in [("mixed", vec!["other", "owner"]), ("solo", vec!["other"])] {
        store
            .create_team(
                OPERATOR,
                &CreateTeamRequest {
                    operation_id: format!("team-{team}"),
                    team_id: team.into(),
                    name: team.into(),
                    member_tag_ids: members.into_iter().map(str::to_owned).collect(),
                    max_concurrency: None,
                },
            )
            .await
            .unwrap();
    }
    let names = |teams: ListTeamsResponse| -> Vec<String> {
        teams.teams.into_iter().map(|team| team.name).collect()
    };
    assert_eq!(
        names(
            store
                .list_teams(OPERATOR, &ListTeamsRequest::default())
                .await
                .unwrap()
        ),
        ["mixed", "solo"]
    );
    assert_eq!(
        names(
            store
                .list_teams(MALLORY, &ListTeamsRequest::default())
                .await
                .unwrap()
        ),
        ["solo"]
    );
    assert_eq!(
        names(
            store
                .list_teams(
                    MALLORY,
                    &ListTeamsRequest {
                        member_tag_id: "other".into(),
                        limit: 1,
                        cursor: String::new(),
                    },
                )
                .await
                .unwrap()
        ),
        ["solo"]
    );
    assert!(matches!(
        store.get_team(MALLORY, "mixed").await,
        Err(StoreError::NotFound(_))
    ));
    assert_eq!(store.get_team(MALLORY, "solo").await.unwrap().name, "solo");
    assert!(store.get_team(OPERATOR, "mixed").await.is_ok());
    // A Team with a member outside the key cannot carry the client's work to that member.
    assert!(matches!(
        store
            .create_objective(MALLORY, &objective("delegate", "other", Some("mixed")))
            .await,
        Err(StoreError::NotFound(_))
    ));
    assert!(
        store
            .create_objective(MALLORY, &objective("team-work", "other", Some("solo")))
            .await
            .is_ok()
    );

    // A Gateway its Auth Key does not trust with every Tag serves no account that no Surface
    // Account names; the seeded Gateway, trusted with every Tag, does.
    store
        .seed_enrollment(
            supertag_control_plane::Role::Gateway,
            "local",
            &Sha256::digest(b"local gateway"),
        )
        .await
        .unwrap();
    let key = Sha256::digest(b"evil gateway key").to_vec();
    store
        .create_auth_key(
            OPERATOR,
            &CreateAuthKeyRequest {
                name: "evil".into(),
                role: PrincipalRole::Gateway.into(),
                operation_id: "evil-key".into(),
                key_digest: key.clone(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .enroll(
            &key,
            &EnrollRequest {
                role: PrincipalRole::Gateway.into(),
                name: "evil".into(),
                operation_id: "evil-enroll".into(),
                token_digest: Sha256::digest(b"evil credential").to_vec(),
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        store
            .bind_connector_account("evil", "made-up-account")
            .await,
        Err(StoreError::PermissionDenied)
    ));
    store
        .bind_connector_account("local", "made-up-account")
        .await
        .unwrap();
    assert!(matches!(
        store
            .bind_connector_account("evil", "made-up-account")
            .await,
        Err(StoreError::PermissionDenied)
    ));
    store.close().await;
}

#[tokio::test]
async fn sqlite_client_scope_contract() {
    let dir = tempfile::tempdir().unwrap();
    contract(&format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("scope.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_client_scope_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").unwrap();
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!("supertag_rust_client_scope_{}", Uuid::new_v4().simple());
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
