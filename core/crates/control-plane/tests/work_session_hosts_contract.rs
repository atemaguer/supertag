//! Helper pools: a Worker Host enrolled with a host Auth Key's `work_session_tag_ids` runs a
//! Tag's Work Sessions and nothing else of it. The lead's own conversation stays on the hosts
//! that run the Tag in full, and a Work Session it starts is claimed by the helper host.

use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor};
use supertag_control_plane::{AttemptAccess, HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:alice";

fn digest(secret: &str) -> Vec<u8> {
    Sha256::digest(secret).to_vec()
}

fn key_request(name: &str, tags: &[&str], work: &[&str]) -> CreateAuthKeyRequest {
    CreateAuthKeyRequest {
        name: name.into(),
        role: PrincipalRole::Host.into(),
        operation_id: format!("issue-{name}"),
        key_digest: digest(&format!("key:{name}")),
        expires_in_ms: 3_600_000,
        allowed_tag_ids: tags.iter().map(|tag| (*tag).to_owned()).collect(),
        work_session_tag_ids: work.iter().map(|tag| (*tag).to_owned()).collect(),
        ..Default::default()
    }
}

/// Enrolls and registers `host` with a new key, and reports it ready for one Codex Task.
async fn host(store: &Store, name: &str, tags: &[&str], work: &[&str]) -> HostAuthority {
    let key = store
        .create_auth_key(OPERATOR, &key_request(&format!("{name}-key"), tags, work))
        .await
        .unwrap();
    assert_eq!(
        key.work_session_tag_ids,
        work.iter().map(|tag| (*tag).to_owned()).collect::<Vec<_>>()
    );
    store
        .enroll(
            &digest(&format!("key:{name}-key")),
            &EnrollRequest {
                role: PrincipalRole::Host.into(),
                name: name.into(),
                operation_id: format!("join-{name}"),
                token_digest: digest(&format!("token:{name}")),
            },
        )
        .await
        .unwrap();
    let record = store
        .register_host(name, &format!("{name}-incarnation"))
        .await
        .unwrap();
    let authority = HostAuthority::new(format!("host:{name}"), record.generation).unwrap();
    store
        .report_host(
            &authority,
            &ReportHostRequest {
                sequence: 1,
                capacity: 1,
                available_slots: 1,
                readiness: HostReadiness::Ready as i32,
                reason: HostReadinessReason::Unspecified as i32,
                harness_kind: HarnessKind::Codex as i32,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    authority
}

async fn claim(store: &Store, host: &HostAuthority) -> Option<InspectAttemptRequest> {
    let assignment = store
        .claim_task(host, &Uuid::new_v4().to_string())
        .await
        .unwrap()?;
    let attempt = InspectAttemptRequest {
        task_id: assignment.task.unwrap().task_id,
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
    Some(attempt)
}

async fn contract(url: &str) {
    let store = Store::open(url).await.unwrap();
    store
        .put_tag("lead", "Lead the mission", vec!["files:read".into()])
        .await
        .unwrap();

    // A key names each Tag once, and only a host key runs Work Sessions.
    for (request, refused) in [
        (key_request("both", &["lead"], &["lead"]), "not both"),
        (
            CreateAuthKeyRequest {
                all_tags: true,
                ..key_request("every", &[], &["lead"])
            },
            "choose all Tags",
        ),
        (
            CreateAuthKeyRequest {
                role: PrincipalRole::Gateway.into(),
                ..key_request("gateway", &[], &["lead"])
            },
            "only host Auth Keys",
        ),
    ] {
        match store.create_auth_key(OPERATOR, &request).await {
            Err(StoreError::InvalidArgument(message)) => {
                assert!(message.contains(refused), "{message}")
            }
            other => panic!("expected a refusal naming {refused:?}, got {other:?}"),
        }
    }
    assert!(matches!(
        store
            .create_auth_key(OPERATOR, &key_request("missing", &[], &["nobody"]))
            .await,
        Err(StoreError::NotFound(_) | StoreError::FailedPrecondition(_))
    ));

    let helper = host(&store, "helper", &[], &["lead"]).await;
    let lead = host(&store, "lead-host", &["lead"], &[]).await;

    // The lead's conversation is not the helper's to run.
    let chat = store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: "lead".into(),
                session_id: "chat".into(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: "Prove the goal".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(claim(&store, &helper).await.is_none());
    let turn = claim(&store, &lead).await.expect("the lead's host runs it");
    assert_eq!(turn.task_id, chat.task_id);

    // The Work Session it starts is: the helper claims it, and the lead's host need not.
    let work = store
        .start_work_session(
            &AttemptAccess::new(&lead, &turn),
            &StartWorkSessionRequest {
                operation_id: "milestone".into(),
                title: "Prove the milestone".into(),
                instruction: "Prove the milestone".into(),
                harness: None,
            },
        )
        .await
        .unwrap();
    let helping = claim(&store, &helper).await.expect("the helper runs it");
    assert_eq!(helping.task_id, work.latest_task_id);
    store
        .finish_task(
            &helper,
            &FinishTaskRequest {
                task_id: helping.task_id.clone(),
                attempt_id: helping.attempt_id.clone(),
                lease_token: helping.lease_token.clone(),
                succeeded: true,
                result: "Proved it".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .finish_task(
            &lead,
            &FinishTaskRequest {
                task_id: turn.task_id.clone(),
                attempt_id: turn.attempt_id.clone(),
                lease_token: turn.lease_token.clone(),
                succeeded: true,
                result: "Started the milestone".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();

    // The Work Session's report to its parent conversation runs where the lead runs.
    assert!(claim(&store, &helper).await.is_none());
    store.close().await;
}

#[tokio::test]
async fn sqlite_work_session_hosts_contract() {
    let dir = tempfile::tempdir().unwrap();
    contract(&format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("work-hosts.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_work_session_hosts_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").unwrap();
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!("supertag_rust_work_hosts_{}", Uuid::new_v4().simple());
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
