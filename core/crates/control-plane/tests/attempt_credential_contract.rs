//! The Attempt credential `StartTask` mints: it names one Attempt, its lease, and the host
//! generation holding it, and stops resolving when any of them ends.

mod support;

use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor};
use supertag_control_plane::{AttemptAccess, AttemptCall, HostAuthority, Store};
use supertag_protocol::v2::{
    AppendEventRequest, FinishTaskRequest, InspectAttemptRequest, NetworkLog,
    ReclaimAttemptRequest, ReportNetworkLogRequest, StartTaskRequest, SubmitTaskRequest,
    TaskEventKind,
};
use uuid::Uuid;

const BASE: i64 = 1_790_000_000_000;
const LEASE: i64 = 30_000;

/// A started Attempt and the credential its start returned.
struct Started {
    lease: InspectAttemptRequest,
    credential: String,
}

async fn start(store: &Store, host: &HostAuthority, lease: &InspectAttemptRequest) -> String {
    let started = store
        .start_task(
            host,
            &StartTaskRequest {
                task_id: lease.task_id.clone(),
                attempt_id: lease.attempt_id.clone(),
                lease_token: lease.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(started.task.unwrap().task_id, lease.task_id);
    started.attempt_credential
}

async fn started(store: &Store, host: &HostAuthority, operation: &str) -> Started {
    store
        .submit_task(
            "operator:alice",
            &SubmitTaskRequest {
                tag_id: "worker".into(),
                session_id: operation.into(),
                operation_id: operation.into(),
                prompt: "Change the checkout".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let claim = store.claim_task(host, operation).await.unwrap().unwrap();
    let lease = InspectAttemptRequest {
        task_id: claim.task.unwrap().task_id,
        attempt_id: claim.attempt_id,
        lease_token: claim.lease_token,
    };
    let credential = start(store, host, &lease).await;
    Started { lease, credential }
}

async fn resolve(store: &Store, credential: &str) -> Option<AttemptAccess> {
    resolve_for(store, credential, AttemptCall::Data).await
}

async fn resolve_for(store: &Store, credential: &str, call: AttemptCall) -> Option<AttemptAccess> {
    store
        .resolve_attempt_credential(&Sha256::digest(credential.as_bytes()), call)
        .await
        .unwrap()
}

async fn contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(BASE));
    let observed = clock.clone();
    let store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || observed.load(Ordering::SeqCst));
    let host = support::register_host(&store, "laptop").await;
    let other = support::register_host(&store, "other").await;
    store.put_tag("worker", "Edit files", vec![]).await.unwrap();

    // The credential has the recognizable shape and names exactly its own Attempt and host.
    let first = started(&store, &host, "first").await;
    assert!(supertag_protocol::is_secret(
        supertag_protocol::ATTEMPT_CREDENTIAL_SECRET_PREFIX,
        &first.credential
    ));
    let second = started(&store, &host, "second").await;
    let access = resolve(&store, &first.credential).await.expect("resolves");
    assert_eq!(access.lease(), &first.lease);
    assert_eq!(access.host().id(), "laptop");
    let other_access = resolve(&store, &second.credential).await.unwrap();
    assert_eq!(other_access.lease(), &second.lease);
    assert!(resolve(&store, &"0".repeat(64)).await.is_none());
    assert!(
        resolve(&store, "stat_not-a-credential").await.is_none(),
        "an unknown secret names nothing"
    );

    // A data call made with it acts on its Attempt only.
    store
        .append_event(
            &access,
            &AppendEventRequest {
                sequence: 1,
                text: "Working on the first".into(),
                kind: TaskEventKind::Message as i32,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .list_events(&first.lease.task_id, 0, 10)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(
        store
            .list_events(&second.lease.task_id, 0, 10)
            .await
            .unwrap()
            .is_empty()
    );

    // Renewing the lease extends it; a lapsed lease ends it.
    clock.store(BASE + LEASE - 1_000, Ordering::SeqCst);
    store.renew_attempt(&host, &first.lease).await.unwrap();
    clock.store(BASE + LEASE + 1_000, Ordering::SeqCst);
    assert!(resolve(&store, &first.credential).await.is_some());
    assert!(
        resolve(&store, &second.credential).await.is_none(),
        "the unrenewed lease lapsed"
    );

    // A repeated start answers with a new credential and ends the previous one.
    let replaced = start(&store, &host, &first.lease).await;
    assert_ne!(replaced, first.credential);
    assert!(resolve(&store, &first.credential).await.is_none());
    assert!(resolve(&store, &replaced).await.is_some());

    // Finishing ends it.
    store
        .finish_task(
            &host,
            &FinishTaskRequest {
                task_id: first.lease.task_id.clone(),
                attempt_id: first.lease.attempt_id.clone(),
                lease_token: first.lease.lease_token.clone(),
                succeeded: true,
                result: "Done".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(resolve(&store, &replaced).await.is_none());

    // Reclaiming ends it.
    let reclaimed = started(&store, &host, "reclaimed").await;
    assert!(resolve(&store, &reclaimed.credential).await.is_some());
    store
        .reclaim_attempt(
            &host,
            &ReclaimAttemptRequest {
                attempt: Some(reclaimed.lease.clone()),
                evidence: "every recorded process group is gone".into(),
            },
        )
        .await
        .unwrap();
    assert!(resolve(&store, &reclaimed.credential).await.is_none());

    // Cancelling ends its data calls, but its reports still land, after its lease lapses too,
    // until its host's Finish confirms execution stopped.
    let cancelled = started(&store, &host, "cancelled").await;
    assert!(
        resolve_for(&store, &cancelled.credential, AttemptCall::Report)
            .await
            .is_some()
    );
    store.cancel_task(&cancelled.lease.task_id).await.unwrap();
    assert!(resolve(&store, &cancelled.credential).await.is_none());
    clock.store(BASE + 3 * LEASE, Ordering::SeqCst);
    let report = resolve_for(&store, &cancelled.credential, AttemptCall::Report)
        .await
        .expect("a cancelled Attempt still reports");
    store
        .report_network_log(
            &report,
            &ReportNetworkLogRequest {
                log: Some(NetworkLog::default()),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .get_task(&cancelled.lease.task_id)
            .await
            .unwrap()
            .network_logs
            .len(),
        1
    );
    store
        .finish_task(
            &host,
            &FinishTaskRequest {
                task_id: cancelled.lease.task_id.clone(),
                attempt_id: cancelled.lease.attempt_id.clone(),
                lease_token: cancelled.lease.lease_token.clone(),
                succeeded: false,
                result: "Stopped".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        resolve_for(&store, &cancelled.credential, AttemptCall::Report)
            .await
            .is_none(),
        "Finish ends its reports"
    );

    // A new generation of its host ends it.
    let fenced = started(&store, &host, "fenced").await;
    assert!(resolve(&store, &fenced.credential).await.is_some());
    store
        .register_host("laptop", "replacement-incarnation")
        .await
        .unwrap();
    assert!(resolve(&store, &fenced.credential).await.is_none());

    // Revoking its host ends it.
    let revoked = started(&store, &other, "revoked").await;
    assert!(resolve(&store, &revoked.credential).await.is_some());
    store.revoke_host("other").await.unwrap();
    assert!(resolve(&store, &revoked.credential).await.is_none());
    store.close().await;
}

#[tokio::test]
async fn sqlite_attempt_credential_contract() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("credentials.db").display()
    );
    contract(&url).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_attempt_credential_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!(
        "supertag_rust_attempt_credential_{}",
        Uuid::new_v4().simple()
    );
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let local = tokio::task::LocalSet::new();
    let outcome = local
        .run_until(async move {
            tokio::task::spawn_local(async move { contract(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL Attempt credential contract failed");
}
