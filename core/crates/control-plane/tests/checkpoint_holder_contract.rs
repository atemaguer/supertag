//! A Session's checkpoint stays on the Worker Host that wrote it, so placement leaves the
//! Session's next Task to that host for up to ten minutes while it is ready, explains the wait,
//! and lets any other host start it fresh once the holder is not ready or the wait is over.
mod support;

use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store};
use supertag_protocol::v2::*;
use uuid::Uuid;

const BASE: i64 = 1_893_456_000_000;
const OPERATOR: &str = "operator:checkpoint-holder";

async fn report(store: &Store, host: &HostAuthority, sequence: u64, readiness: HostReadiness) {
    store
        .report_host(
            host,
            &ReportHostRequest {
                sequence,
                capacity: 1,
                // A host that stops claiming has no free slot and says why.
                available_slots: u32::from(readiness == HostReadiness::Ready),
                readiness: readiness.into(),
                reason: if readiness == HostReadiness::Ready {
                    HostReadinessReason::Unspecified
                } else {
                    HostReadinessReason::Stopping
                }
                .into(),
                harness_kind: HarnessKind::Codex.into(),
                execution_profile: Some(HarnessExecutionProfile::default()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

async fn submit(store: &Store, session: &str) -> String {
    store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: "coder".into(),
                session_id: session.into(),
                operation_id: Uuid::new_v4().to_string(),
                prompt: "Continue the change".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .task_id
}

async fn claim(store: &Store, host: &HostAuthority) -> Option<InspectAttemptRequest> {
    let assignment = store
        .claim_task_with_sources(
            host,
            &Uuid::new_v4().to_string(),
            (&[], &[]),
            HarnessKind::Codex,
            &[],
            None,
        )
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

/// Finishes the turn, keeping a checkpoint on `host` when `label` names one.
async fn finish(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    label: Option<&str>,
) {
    let reference = label.map(|label| CheckpointReference {
        harness: "codex".into(),
        format: "codex-session-v1".into(),
        byte_length: label.len() as u64,
        sha256: format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(label)),
    });
    if let Some(reference) = &reference {
        let request = CommitCheckpointRequest {
            attempt: Some(attempt.clone()),
            reference: Some(reference.clone()),
        };
        store.reserve_checkpoint(host, &request).await.unwrap();
        store.commit_checkpoint(host, &request).await.unwrap();
    }
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                result: "Done".into(),
                succeeded: true,
                checkpoint_sha256: reference.map(|reference| reference.sha256),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

async fn exercise(url: &str) {
    let clock = Arc::new(AtomicI64::new(BASE));
    let source = clock.clone();
    let store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || source.load(Ordering::SeqCst));
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "coder".into(),
            instructions: "Change the code".into(),
            harness_kind: HarnessKind::Codex.into(),
            allowed_actions: vec!["files:read".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    let laptop = support::register_host(&store, "laptop").await;
    let server = support::register_host(&store, "server").await;
    report(&store, &laptop, 1, HostReadiness::Ready).await;
    report(&store, &server, 1, HostReadiness::Ready).await;

    // The laptop runs the first turn and keeps its checkpoint.
    let first = submit(&store, "feature").await;
    let attempt = claim(&store, &laptop).await.unwrap();
    assert_eq!(attempt.task_id, first);
    finish(&store, &laptop, &attempt, Some("laptop transcript")).await;

    // The next turn waits for the laptop: the server leaves it, and placement says why.
    let second = submit(&store, "feature").await;
    assert!(claim(&store, &server).await.is_none());
    let waiting = store.diagnose_task_placement(&second).await.unwrap();
    assert_eq!(waiting.requirement, "checkpoint-holder", "{waiting:?}");
    assert!(
        waiting.summary.contains("Worker Host laptop")
            && waiting.summary.contains("starts it from the recap"),
        "{}",
        waiting.summary
    );
    // The holder takes it, and finds its own checkpoint.
    let attempt = claim(&store, &laptop).await.unwrap();
    assert_eq!(attempt.task_id, second);
    let resumed = store.get_checkpoint(&laptop, &attempt).await.unwrap();
    assert_eq!(resumed.holder_host_id, "laptop");
    finish(&store, &laptop, &attempt, Some("laptop transcript, longer")).await;

    // Ten minutes after the turn could start, another host starts it fresh.
    let third = submit(&store, "feature").await;
    assert!(claim(&store, &server).await.is_none());
    clock.fetch_add(10 * 60 * 1000 + 1, Ordering::SeqCst);
    report(&store, &laptop, 2, HostReadiness::Ready).await;
    report(&store, &server, 2, HostReadiness::Ready).await;
    let attempt = claim(&store, &server).await.unwrap();
    assert_eq!(attempt.task_id, third);
    // The server sees the laptop's checkpoint, which it cannot resume, and starts fresh.
    let elsewhere = store.get_checkpoint(&server, &attempt).await.unwrap();
    assert_eq!(elsewhere.holder_host_id, "laptop");
    finish(&store, &server, &attempt, Some("server transcript")).await;

    // A holder that is not ready releases the Session's next turn at once.
    let fourth = submit(&store, "feature").await;
    report(&store, &server, 3, HostReadiness::Suppressed).await;
    let waiting = store.diagnose_task_placement(&fourth).await.unwrap();
    assert_ne!(waiting.requirement, "checkpoint-holder", "{waiting:?}");
    let attempt = claim(&store, &laptop).await.unwrap();
    assert_eq!(attempt.task_id, fourth);
    finish(&store, &laptop, &attempt, None).await;

    // Without a checkpoint, nothing waits.
    let fifth = submit(&store, "feature").await;
    report(&store, &server, 4, HostReadiness::Ready).await;
    let attempt = claim(&store, &server).await.unwrap();
    assert_eq!(attempt.task_id, fifth);
    finish(&store, &server, &attempt, None).await;
    store.close().await;
}

#[tokio::test]
async fn sqlite_checkpoint_holder_contract() {
    let dir = tempfile::tempdir().unwrap();
    exercise(&format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("holder.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_checkpoint_holder_contract() {
    let path =
        std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("test database file");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let database = format!("supertag_checkpoint_holder_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&database);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { exercise(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await
        .unwrap();
    result.unwrap();
}
