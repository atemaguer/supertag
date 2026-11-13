mod support;

use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const NOW: i64 = 1_800_000_000_000;

async fn open(url: &str, clock: &Arc<AtomicI64>) -> Store {
    let clock = clock.clone();
    Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || clock.load(Ordering::SeqCst))
}

fn report(sequence: u64) -> ReportHostRequest {
    ReportHostRequest {
        sequence,
        capacity: 1,
        available_slots: 1,
        readiness: HostReadiness::Ready as i32,
        reason: HostReadinessReason::Unspecified as i32,
        harness_kind: HarnessKind::Codex as i32,
        workspace_ids: vec!["project".into()],
        execution_profile: Some(HarnessExecutionProfile {
            workspace_mounts: vec![],
            declared_task_outputs: false,
            model_ids: vec!["codex-alpha".into(), "codex-beta".into()],
            default_model: Some("codex-alpha".into()),
            allow_unsandboxed_commands: false,
            remote_file_workspace: false,
            mcp_servers: vec![],
            shared_execution: None,
            task_artifact_inputs: false,
        }),
        harnesses: vec![],
    }
}

fn shared_report(sequence: u64, codex_ready: u32, agents_ready: u32) -> ReportHostRequest {
    let profile = |model: &str| HarnessExecutionProfile {
        model_ids: vec![model.into()],
        default_model: Some(model.into()),
        ..Default::default()
    };
    ReportHostRequest {
        sequence,
        capacity: 4,
        available_slots: codex_ready + agents_ready,
        readiness: HostReadiness::Ready as i32,
        reason: HostReadinessReason::Unspecified as i32,
        harness_kind: HarnessKind::Unspecified as i32,
        workspace_ids: vec![],
        execution_profile: None,
        // Reported out of order; the stored form is ordered by harness.
        harnesses: vec![
            HostHarnessCapacity {
                harness_kind: HarnessKind::OpenaiAgents as i32,
                execution_profile: Some(profile("agents-model")),
                capacity: 2,
                available_slots: agents_ready,
            },
            HostHarnessCapacity {
                harness_kind: HarnessKind::Codex as i32,
                execution_profile: Some(profile("codex-model")),
                capacity: 2,
                available_slots: codex_ready,
            },
        ],
    }
}

/// One registration advertises several harnesses, each with its own slots, and the totals and
/// summary fields stay consistent with them.
async fn shared_contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let store = open(url, &clock).await;
    let registered = support::register_host(&store, "shared").await;
    let ready = store
        .report_host(&registered, &shared_report(1, 2, 1))
        .await
        .unwrap();
    assert_eq!(ready.phase(), HostPhase::Ready);
    assert_eq!((ready.capacity, ready.available_slots), (4, 3));
    assert_eq!(ready.harness_kind(), HarnessKind::Unspecified);
    let slots = ready
        .harnesses
        .iter()
        .map(|h| (h.harness_kind(), h.capacity, h.available_slots))
        .collect::<Vec<_>>();
    assert_eq!(
        slots,
        [
            (HarnessKind::Codex, 2, 2),
            (HarnessKind::OpenaiAgents, 2, 1)
        ]
    );
    // An exact replay is idempotent; the same sequence with other slots conflicts.
    assert_eq!(
        store
            .report_host(&registered, &shared_report(1, 2, 1))
            .await
            .unwrap(),
        ready
    );
    assert!(matches!(
        store
            .report_host(&registered, &shared_report(1, 1, 1))
            .await,
        Err(StoreError::Conflict(_))
    ));
    for invalid in [
        // Totals differ from the harness entries.
        ReportHostRequest {
            capacity: 5,
            ..shared_report(2, 2, 1)
        },
        ReportHostRequest {
            available_slots: 2,
            ..shared_report(2, 2, 1)
        },
        // Several harnesses never claim one summary harness or profile.
        ReportHostRequest {
            harness_kind: HarnessKind::Codex as i32,
            ..shared_report(2, 2, 1)
        },
        {
            let mut duplicate = shared_report(2, 2, 1);
            duplicate.harnesses[0].harness_kind = HarnessKind::Codex as i32;
            duplicate
        },
        {
            let mut overfull = shared_report(2, 2, 1);
            overfull.harnesses[0].available_slots = 3;
            overfull.available_slots = 4;
            overfull
        },
    ] {
        assert!(matches!(
            store.report_host(&registered, &invalid).await,
            Err(StoreError::InvalidArgument(_))
        ));
    }
    store.close().await;

    // Slots survive a restart and stop being available once presence is not Ready.
    let store = open(url, &clock).await;
    let stored = store.get_host("shared").await.unwrap();
    assert_eq!(stored.harnesses, ready.harnesses);
    store.set_host_draining("shared", true).await.unwrap();
    let drained = store.get_host("shared").await.unwrap();
    assert_eq!(drained.phase(), HostPhase::Draining);
    assert!(drained.harnesses.iter().all(|h| h.available_slots == 0));
    assert_eq!(drained.harnesses.iter().map(|h| h.capacity).sum::<u32>(), 4);
    // A single-harness Host may also report its slots, with a matching summary.
    let single = support::register_host(&store, "single").await;
    let mut one = report(1);
    one.capacity = 3;
    one.available_slots = 2;
    one.harnesses = vec![HostHarnessCapacity {
        harness_kind: HarnessKind::Codex as i32,
        execution_profile: one.execution_profile.clone(),
        capacity: 3,
        available_slots: 2,
    }];
    assert_eq!(
        store
            .report_host(&single, &one)
            .await
            .unwrap()
            .harnesses
            .len(),
        1
    );
    one.sequence = 2;
    one.harness_kind = HarnessKind::ClaudeCode as i32;
    assert!(matches!(
        store.report_host(&single, &one).await,
        Err(StoreError::InvalidArgument(_))
    ));
    store.close().await;
}

#[tokio::test]
async fn sqlite_host_reports_several_harness_slots_under_one_registration() {
    let directory = tempfile::tempdir().unwrap();
    shared_contract(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("shared.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_host_reports_several_harness_slots_under_one_registration() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_shared_slots_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let outcome = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { shared_contract(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL shared Host contract failed");
}

async fn contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let store = open(url, &clock).await;
    store
        .seed_host("host-a", &Sha256::digest(b"synthetic credential a"))
        .await
        .unwrap();
    let pending = store.get_host("host-a").await.unwrap();
    assert_eq!(pending.phase(), HostPhase::Pending);
    assert_eq!(pending.last_seen_at_ms, None);
    assert_eq!(pending.available_slots, 0);
    let registration = store
        .register_host("host-a", "incarnation-a")
        .await
        .unwrap();
    let host = HostAuthority::new("host:host-a", registration.generation).unwrap();
    let ready = store.report_host(&host, &report(1)).await.unwrap();
    assert_eq!(ready.phase(), HostPhase::Ready);
    assert_eq!(ready.available_slots, 1);
    assert_eq!(ready.last_seen_at_ms, Some(NOW));
    assert_eq!(ready.presence_expires_at_ms, Some(NOW + 30_000));
    assert_eq!(ready.execution_profile, report(1).execution_profile);
    clock.store(NOW + 5_000, Ordering::SeqCst);
    let mut replay = report(1);
    replay
        .execution_profile
        .as_mut()
        .unwrap()
        .model_ids
        .reverse();
    assert_eq!(store.report_host(&host, &replay).await.unwrap(), ready);
    replay.execution_profile.as_mut().unwrap().default_model = Some("codex-beta".into());
    assert!(matches!(
        store.report_host(&host, &replay).await,
        Err(StoreError::Conflict(_))
    ));
    let mut conflict = report(1);
    conflict.available_slots = 0;
    assert!(matches!(
        store.report_host(&host, &conflict).await,
        Err(StoreError::Conflict(_))
    ));
    let mut invalid = report(2);
    invalid.available_slots = 2;
    assert!(matches!(
        store.report_host(&host, &invalid).await,
        Err(StoreError::InvalidArgument(_))
    ));
    invalid = report(2);
    invalid.reason = HostReadinessReason::RecoveryRequired as i32;
    assert!(matches!(
        store.report_host(&host, &invalid).await,
        Err(StoreError::InvalidArgument(_))
    ));
    invalid = report(2);
    invalid.workspace_ids = vec!["../private".into()];
    assert!(matches!(
        store.report_host(&host, &invalid).await,
        Err(StoreError::InvalidArgument(_))
    ));

    store.set_host_draining("host-a", true).await.unwrap();
    assert_eq!(
        store.report_host(&host, &report(2)).await.unwrap().phase(),
        HostPhase::Draining
    );
    assert_eq!(store.get_host("host-a").await.unwrap().available_slots, 0);
    store
        .put_tag("engineering", "Review", vec![])
        .await
        .unwrap();
    let task = store
        .submit_task(
            "operator:alice",
            &SubmitTaskRequest {
                output_policy: None,
                execution_limits: None,
                tag_id: "engineering".into(),
                session_id: "session".into(),
                operation_id: "turn".into(),
                prompt: "Review this change".into(),
                input_artifacts: vec![],
            },
        )
        .await
        .unwrap();
    assert!(
        store
            .claim_task(&host, "drained-claim")
            .await
            .unwrap()
            .is_none()
    );
    store.close().await;

    let store = open(url, &clock).await;
    assert!(store.get_host("host-a").await.unwrap().draining);
    store.set_host_draining("host-a", false).await.unwrap();
    let claim = store
        .claim_task(&host, "working-claim")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.task.as_ref().unwrap().task_id, task.task_id);
    let occupied = store.get_host("host-a").await.unwrap();
    assert_eq!(occupied.active_attempts, 1);
    assert_eq!(occupied.available_slots, 0);
    assert_eq!(occupied.phase(), HostPhase::Busy);
    store.set_host_draining("host-a", true).await.unwrap();
    // A drain does not erase the receipt of already accepted work.
    assert_eq!(
        store.claim_task(&host, "working-claim").await.unwrap(),
        Some(claim)
    );
    clock.store(NOW + 35_000, Ordering::SeqCst);
    let offline = store.get_host("host-a").await.unwrap();
    assert_eq!(offline.phase(), HostPhase::Offline);
    assert_eq!(offline.available_slots, 0);
    // A delayed exact replay cannot resurrect an expired presence lease.
    let delayed_replay = store.report_host(&host, &report(2)).await.unwrap();
    assert_eq!(delayed_replay.phase(), HostPhase::Offline);
    assert_eq!(delayed_replay.last_seen_at_ms, offline.last_seen_at_ms);
    assert_eq!(
        delayed_replay.presence_expires_at_ms,
        offline.presence_expires_at_ms
    );
    store.close().await;

    let store = open(url, &clock).await;
    assert_eq!(
        store.get_host("host-a").await.unwrap().phase(),
        HostPhase::Offline
    );
    let mut suppressed = report(3);
    suppressed.readiness = HostReadiness::Suppressed as i32;
    suppressed.reason = HostReadinessReason::RecoveryRequired as i32;
    suppressed.available_slots = 0;
    store.set_host_draining("host-a", false).await.unwrap();
    assert_eq!(
        store.report_host(&host, &suppressed).await.unwrap().phase(),
        HostPhase::Suppressed
    );
    assert!(matches!(
        store.report_host(&host, &report(2)).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let second = store
        .register_host("host-a", "incarnation-b")
        .await
        .unwrap();
    let replacement = HostAuthority::new("host:host-a", second.generation).unwrap();
    let pending = store.get_host("host-a").await.unwrap();
    assert_eq!(pending.phase(), HostPhase::Pending);
    assert!(pending.execution_profile.is_none());
    assert!(matches!(
        store.report_host(&host, &report(4)).await,
        Err(StoreError::PermissionDenied)
    ));
    let ready = store.report_host(&replacement, &report(1)).await.unwrap();
    assert_eq!(ready.execution_profile, report(1).execution_profile);
    let host_b = support::register_host(&store, "host-b").await;
    let page = store
        .list_hosts(&ListHostsRequest {
            limit: 1,
            cursor: String::new(),
        })
        .await
        .unwrap();
    assert_eq!(page.hosts[0].host_id, "host-a");
    assert!(!page.next_cursor.is_empty());
    let next = store
        .list_hosts(&ListHostsRequest {
            limit: 1,
            cursor: page.next_cursor,
        })
        .await
        .unwrap();
    assert_eq!(next.hosts[0].host_id, "host-b");
    assert!(next.next_cursor.is_empty());
    store.revoke_host("host-a").await.unwrap();
    assert_eq!(
        store.get_host("host-a").await.unwrap().phase(),
        HostPhase::Revoked
    );
    assert!(matches!(
        store.report_host(&replacement, &report(2)).await,
        Err(StoreError::PermissionDenied)
    ));
    assert_eq!(
        store
            .list_hosts(&ListHostsRequest::default())
            .await
            .unwrap()
            .hosts
            .len(),
        2
    );
    // Fresh presence cannot extend an Attempt's authority or clear unresolved work.
    let claim = store
        .claim_task(&host_b, "authority-check")
        .await
        .unwrap()
        .unwrap();
    let task_id = claim.task.as_ref().unwrap().task_id.clone();
    store
        .start_task(
            &host_b,
            &StartTaskRequest {
                task_id: task_id.clone(),
                attempt_id: claim.attempt_id.clone(),
                lease_token: claim.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    clock.store(NOW + 60_000, Ordering::SeqCst);
    store.report_host(&host_b, &report(1)).await.unwrap();
    clock.store(NOW + 65_000, Ordering::SeqCst);
    let authority = store
        .renew_attempt(
            &host_b,
            &InspectAttemptRequest {
                task_id: task_id.clone(),
                attempt_id: claim.attempt_id.clone(),
                lease_token: claim.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(authority.valid_for_ms, 0);
    assert_eq!(authority.task.unwrap().state(), TaskState::Uncertain);
    let observed = store.get_host("host-b").await.unwrap();
    assert_eq!(observed.active_attempts, 1);
    assert_eq!(observed.available_slots, 0);
    assert_eq!(observed.phase(), HostPhase::Busy);
    let stopped = store
        .finish_task(
            &host_b,
            &FinishTaskRequest {
                task_id,
                attempt_id: claim.attempt_id,
                lease_token: claim.lease_token,
                succeeded: false,
                result: "Execution stopped after authority expired".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(stopped.state(), TaskState::Uncertain);
    let observed = store.get_host("host-b").await.unwrap();
    assert_eq!(observed.active_attempts, 0);
    assert_eq!(observed.available_slots, 1);
    assert_eq!(observed.phase(), HostPhase::Ready);
    store.close().await;
}

#[tokio::test]
async fn sqlite_host_readiness_is_fenced_and_expires_across_restart() {
    let directory = tempfile::tempdir().unwrap();
    contract(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("hosts.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_host_readiness_is_fenced_and_expires_across_restart() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_readiness_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let outcome = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { contract(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL readiness contract failed");
}
