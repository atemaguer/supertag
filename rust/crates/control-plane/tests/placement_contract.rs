//! Worker Host labels, Tag `runsOn`, placement diagnosis, and reusable or
//! ephemeral Auth Keys. Mirrors tests/worker-host-labels.test.ts,
//! tests/label-placement.test.ts, tests/auth-key-store.test.ts and
//! tests/ephemeral-worker-host.test.ts.

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
const OPERATOR: &str = "operator:placement";

fn digest(secret: &str) -> Vec<u8> {
    Sha256::digest(secret).to_vec()
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

async fn open(url: &str, clock: &Arc<AtomicI64>) -> Store {
    let clock = clock.clone();
    Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || clock.load(Ordering::SeqCst))
}

async fn key(
    store: &Store,
    name: &str,
    tags: &[&str],
    labels: &[&str],
    ephemeral: bool,
) -> Vec<u8> {
    let secret = digest(&format!("key:{name}"));
    let issued = store
        .create_auth_key(
            OPERATOR,
            &CreateAuthKeyRequest {
                name: name.into(),
                operation_id: format!("issue-{name}"),
                key_digest: secret.clone(),
                expires_in_ms: 3_600_000,
                allowed_tag_ids: strings(tags),
                reusable: true,
                ephemeral,
                labels: strings(labels),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(issued.reusable);
    assert!(issued.host_id.is_empty());
    secret
}

async fn join(store: &Store, key: &[u8], host: &str) -> HostAuthority {
    let record = store
        .enroll_host(
            &EnrollHostRequest {
                host_id: host.into(),
                operation_id: format!("join-{host}"),
                token_digest: digest(&format!("token:{host}")),
            },
            key,
        )
        .await
        .unwrap();
    assert_eq!(record.generation, 0);
    let record = store
        .register_host(host, &format!("{host}-incarnation"))
        .await
        .unwrap();
    HostAuthority::new(format!("host:{host}"), record.generation).unwrap()
}

async fn report(store: &Store, host: &HostAuthority, sequence: u64, labels: &[&str]) {
    store
        .report_host(
            host,
            &ReportHostRequest {
                sequence,
                capacity: 1,
                available_slots: 1,
                readiness: HostReadiness::Ready as i32,
                reason: HostReadinessReason::Unspecified as i32,
                harness_kind: HarnessKind::Codex as i32,
                labels: strings(labels),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

async fn submit(store: &Store, tag: &str, session: &str) -> String {
    store
        .submit_task(
            OPERATOR,
            &SubmitTaskRequest {
                tag_id: tag.into(),
                session_id: session.into(),
                operation_id: format!("{tag}-{session}"),
                prompt: "Train the model".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .task_id
}

async fn claim(store: &Store, host: &HostAuthority, operation: &str) -> Option<String> {
    store
        .claim_task_for_host(host, operation, &[], HarnessKind::Codex)
        .await
        .unwrap()
        .map(|assignment| assignment.task.unwrap().task_id)
}

async fn runs_on(store: &Store, tag: &str, labels: &[&str]) -> Tag {
    store
        .set_tag_runs_on(&SetTagRunsOnRequest {
            tag_id: tag.into(),
            runs_on: strings(labels),
        })
        .await
        .unwrap()
}

async fn placement_contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let store = open(url, &clock).await;
    for tag in ["trainer", "researcher", "elsewhere"] {
        store.put_tag(tag, "Train models", vec![]).await.unwrap();
    }

    // runsOn is normalized, validated, preserved by PutTag, and readable on the Tag.
    let tag = runs_on(&store, "trainer", &["MacOS", "gpu", "macos"]).await;
    assert_eq!(tag.runs_on, ["gpu", "macos"]);
    let tag = store
        .put_tag("trainer", "Train models carefully", vec![])
        .await
        .unwrap();
    assert_eq!(tag.runs_on, ["gpu", "macos"]);
    assert_eq!(
        store.get_tag("trainer").await.unwrap().runs_on,
        ["gpu", "macos"]
    );
    for invalid in [
        &["not valid"][..],
        &["volume-credential:x"],
        &["mcp-login:x"],
    ] {
        assert!(matches!(
            store
                .set_tag_runs_on(&SetTagRunsOnRequest {
                    tag_id: "trainer".into(),
                    runs_on: strings(invalid),
                })
                .await,
            Err(StoreError::InvalidArgument(_))
        ));
    }
    assert!(matches!(
        store
            .set_tag_runs_on(&SetTagRunsOnRequest {
                tag_id: "missing".into(),
                runs_on: vec![],
            })
            .await,
        Err(StoreError::NotFound(_))
    ));
    assert_eq!(
        runs_on(&store, "trainer", &["mcp:sentry"]).await.runs_on,
        ["mcp:sentry"]
    );
    assert!(runs_on(&store, "trainer", &[]).await.runs_on.is_empty());

    // A reusable key cannot name a host, and keys cannot grant reserved labels.
    for (host_id, labels) in [("named", vec![]), ("", strings(&["mcp:github"]))] {
        assert!(matches!(
            store
                .create_auth_key(
                    OPERATOR,
                    &CreateAuthKeyRequest {
                        name: format!("bad-{}", host_id.len()),
                        host_id: host_id.into(),
                        operation_id: format!("bad-{host_id}"),
                        key_digest: digest(&format!("bad-{host_id}")),
                        expires_in_ms: 60_000,
                        all_tags: true,
                        reusable: true,
                        labels,
                        ..Default::default()
                    },
                )
                .await,
            Err(StoreError::InvalidArgument(_))
        ));
    }

    // One reusable key grants labels to every host that joins with it.
    let gpu_key = key(
        &store,
        "gpu-pool",
        &["trainer", "researcher"],
        &["GPU", "team:infra", "gpu"],
        false,
    )
    .await;
    let plain_key = key(&store, "cpu-pool", &["trainer", "researcher"], &[], false).await;
    let gpu = join(&store, &gpu_key, "gpu-host").await;
    let cpu = join(&store, &plain_key, "cpu-host").await;
    let cpu_2 = join(&store, &plain_key, "cpu-host-2").await;
    // A lost response replays the same enrollment; a different credential cannot.
    let replay = EnrollHostRequest {
        host_id: "cpu-host".into(),
        operation_id: "join-cpu-host".into(),
        token_digest: digest("token:cpu-host"),
    };
    assert_eq!(
        store
            .enroll_host(&replay, &plain_key)
            .await
            .unwrap()
            .host_id,
        "cpu-host"
    );
    assert!(matches!(
        store
            .enroll_host(
                &EnrollHostRequest {
                    token_digest: digest("stolen"),
                    ..replay.clone()
                },
                &plain_key,
            )
            .await,
        Err(StoreError::PermissionDenied)
    ));
    // An unbound host's labels never count.
    let unbound_key = key(&store, "elsewhere", &["elsewhere"], &["gpu", "tpu"], false).await;
    let unbound = join(&store, &unbound_key, "unbound-tpu").await;

    report(&store, &gpu, 1, &["linux", "X64"]).await;
    report(&store, &cpu, 1, &["linux", "cpu"]).await;
    report(&store, &cpu_2, 1, &["linux"]).await;
    report(&store, &unbound, 1, &["linux"]).await;
    assert!(matches!(
        store
            .report_host(
                &cpu,
                &ReportHostRequest {
                    sequence: 2,
                    capacity: 1,
                    available_slots: 1,
                    readiness: HostReadiness::Ready as i32,
                    labels: strings(&["mcp:github"]),
                    ..Default::default()
                },
            )
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    let status = store.get_host("gpu-host").await.unwrap();
    assert_eq!(status.granted_labels, ["gpu", "team:infra"]);
    assert_eq!(
        status.labels,
        ["gpu", "harness:codex", "linux", "team:infra", "x64"]
    );
    assert!(!status.ephemeral);
    assert!(
        store
            .get_host("cpu-host")
            .await
            .unwrap()
            .granted_labels
            .is_empty()
    );

    // Labels place work; they never reject it. Tasks wait for an eligible host.
    runs_on(&store, "trainer", &["gpu"]).await;
    runs_on(&store, "researcher", &["gpu", "tpu"]).await;
    let trainer = submit(&store, "trainer", "train").await;
    let researcher = submit(&store, "researcher", "research").await;
    assert_eq!(claim(&store, &cpu, "cpu-1").await, None);
    assert_eq!(claim(&store, &unbound, "unbound-1").await, None);

    let waiting = store.diagnose_task_placement(&researcher).await.unwrap();
    assert_eq!(waiting.state, TaskState::Queued as i32);
    assert_eq!(waiting.required_labels, ["gpu", "tpu"]);
    assert_eq!(waiting.missing_labels, ["tpu"]);
    assert_eq!(waiting.requirement, "labels:tpu");
    assert_eq!(waiting.summary, "No bound Worker Host has labels: tpu");
    assert_eq!(
        waiting
            .hosts
            .iter()
            .map(|host| (
                host.host_id.as_str(),
                host.eligible,
                host.missing_labels.clone()
            ))
            .collect::<Vec<_>>(),
        [
            ("cpu-host", false, strings(&["gpu", "tpu"])),
            ("cpu-host-2", false, strings(&["gpu", "tpu"])),
            ("gpu-host", false, strings(&["tpu"])),
        ]
    );
    let ready = store.diagnose_task_placement(&trainer).await.unwrap();
    assert!(ready.missing_labels.is_empty() && ready.summary.is_empty());
    assert!(
        ready
            .hosts
            .iter()
            .any(|host| host.host_id == "gpu-host" && host.eligible)
    );

    assert_eq!(
        claim(&store, &gpu, "gpu-1").await.as_deref(),
        Some(trainer.as_str())
    );
    assert_eq!(claim(&store, &gpu, "gpu-2").await, None);
    // Changing runsOn re-places queued work.
    runs_on(&store, "researcher", &["GPU"]).await;
    assert_eq!(
        claim(&store, &gpu, "gpu-3").await.as_deref(),
        Some(researcher.as_str())
    );

    // When each label exists on some host but none carries them all, name every label.
    runs_on(&store, "researcher", &["cpu", "gpu"]).await;
    let split = submit(&store, "researcher", "split").await;
    let diagnosis = store.diagnose_task_placement(&split).await.unwrap();
    assert_eq!(diagnosis.missing_labels, ["cpu", "gpu"]);
    assert_eq!(diagnosis.requirement, "labels:cpu,gpu");
    runs_on(&store, "researcher", &["mcp:sentry", "tpu"]).await;
    let diagnosis = store.diagnose_task_placement(&split).await.unwrap();
    assert_eq!(
        diagnosis.summary,
        "No bound Worker Host has labels: tpu. No bound Worker Host provides MCP server sentry"
    );
    let unhosted = submit(&store, "elsewhere", "nobody").await;
    store.revoke_host("unbound-tpu").await.unwrap();
    let diagnosis = store.diagnose_task_placement(&unhosted).await.unwrap();
    assert_eq!(
        diagnosis.summary,
        "No Worker Host is bound to Tag elsewhere"
    );
    assert!(diagnosis.hosts.is_empty());

    store.close().await;
}

async fn start_running(store: &Store, host: &HostAuthority, operation: &str) -> String {
    let claim = store
        .claim_task_for_host(host, operation, &[], HarnessKind::Codex)
        .await
        .unwrap()
        .unwrap();
    let task = claim.task.unwrap().task_id;
    let running = store
        .start_task(
            host,
            &StartTaskRequest {
                task_id: task.clone(),
                attempt_id: claim.attempt_id,
                lease_token: claim.lease_token,
            },
        )
        .await
        .unwrap();
    assert_eq!(running.state, TaskState::Running as i32);
    task
}

async fn ephemeral_contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let store = open(url, &clock).await;
    // The Control Plane starts watching ephemeral hosts.
    assert!(store.sweep_ephemeral_hosts().await.unwrap().is_empty());
    store.put_tag("builder", "Build", vec![]).await.unwrap();
    let ci = key(&store, "ci", &["builder"], &["linux-ci"], true).await;
    let laptop_key = key(&store, "laptop", &["builder"], &[], false).await;
    let runner = join(&store, &ci, "runner").await;
    let laptop = join(&store, &laptop_key, "laptop").await;
    report(&store, &runner, 1, &[]).await;
    report(&store, &laptop, 1, &[]).await;
    assert!(store.get_host("runner").await.unwrap().ephemeral);
    let task = submit(&store, "builder", "build").await;
    // The removed host's Attempt is running, not just claimed.
    assert_eq!(start_running(&store, &runner, "runner-1").await, task);
    // Joined at the same instant, never came online.
    store
        .enroll_host(
            &EnrollHostRequest {
                host_id: "idle".into(),
                operation_id: "join-idle".into(),
                token_digest: digest("token:idle"),
            },
            &ci,
        )
        .await
        .unwrap();

    // Within the presence window an ephemeral host may still report again.
    clock.store(NOW + 29_999, Ordering::SeqCst);
    report(&store, &laptop, 2, &[]).await;
    assert!(store.sweep_ephemeral_hosts().await.unwrap().is_empty());
    clock.store(NOW + 30_000, Ordering::SeqCst);
    assert_eq!(store.sweep_ephemeral_hosts().await.unwrap(), ["runner"]);
    let removed = store.get_host("runner").await.unwrap();
    assert!(removed.ephemeral);
    assert_eq!(removed.phase, HostPhase::Revoked as i32);
    assert_eq!(removed.removed_at_ms, Some(NOW + 30_000));
    // A removed host cannot report again, so its running Attempt counts as
    // stopped and the Task waits for another host without operator recovery.
    let queued = store.get_task(&task).await.unwrap();
    assert_eq!(queued.state, TaskState::Queued as i32);
    assert!(queued.attempt_id.is_none());
    // The Task records why its Attempt stopped, as TypeScript's event does.
    let events = store.list_events(&task, 0, 0).await.unwrap();
    let [event] = events.as_slice() else {
        panic!("one event expected: {events:?}");
    };
    let mut removed_event: serde_json::Value = serde_json::from_str(&event.text).unwrap();
    assert!(
        removed_event["attemptId"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
    );
    removed_event["attemptId"] = serde_json::Value::Null;
    assert_eq!(
        removed_event,
        serde_json::json!({
            "type": "task.worker-host-removed",
            "version": 1,
            "workerHostId": "runner",
            "attemptId": null,
            "requeued": true,
        })
    );
    let listed = store
        .list_hosts(&ListHostsRequest::default())
        .await
        .unwrap();
    assert_eq!(
        listed
            .hosts
            .iter()
            .map(|host| host.host_id.as_str())
            .collect::<Vec<_>>(),
        ["idle", "laptop"]
    );
    assert!(matches!(
        store.authenticate_host(&digest("token:runner")).await,
        Err(StoreError::PermissionDenied)
    ));
    let diagnosis = store.diagnose_task_placement(&task).await.unwrap();
    assert_eq!(
        diagnosis
            .hosts
            .iter()
            .map(|host| host.host_id.as_str())
            .collect::<Vec<_>>(),
        ["idle", "laptop"]
    );
    assert!(store.sweep_ephemeral_hosts().await.unwrap().is_empty());

    // A host that joined but never came online gets a ten-minute join window.
    clock.store(NOW + 600_000, Ordering::SeqCst);
    report(&store, &laptop, 3, &[]).await;
    assert_eq!(store.sweep_ephemeral_hosts().await.unwrap(), ["idle"]);
    assert_eq!(
        store.get_host("laptop").await.unwrap().phase,
        HostPhase::Ready as i32
    );
    assert_eq!(
        claim(&store, &laptop, "laptop-1").await.as_deref(),
        Some(task.as_str())
    );
    store.close().await;
}

/// Time the Control Plane is down never counts as a host being offline.
/// A removed ephemeral host's cancelled Attempt finishes its cleanup without running again, and
/// its Task records `task.worker-host-removed` with `requeued` false, as
/// tests/uncertain-attempt.test.ts expects.
async fn removed_host_cancelled_attempt_contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let store = open(url, &clock).await;
    assert!(store.sweep_ephemeral_hosts().await.unwrap().is_empty());
    store.put_tag("builder", "Build", vec![]).await.unwrap();
    let ci = key(&store, "ci", &["builder"], &[], true).await;
    let worker = join(&store, &ci, "worker").await;
    report(&store, &worker, 1, &[]).await;
    let task = submit(&store, "builder", "build").await;
    assert_eq!(start_running(&store, &worker, "worker-1").await, task);
    store.cancel_task(&task).await.unwrap();
    clock.store(NOW + 30_000, Ordering::SeqCst);
    assert_eq!(store.sweep_ephemeral_hosts().await.unwrap(), ["worker"]);
    assert_eq!(
        store.get_task(&task).await.unwrap().state,
        TaskState::Cancelled as i32
    );
    let events = store.list_events(&task, 0, 0).await.unwrap();
    let [event] = events.as_slice() else {
        panic!("one event expected: {events:?}");
    };
    let event: serde_json::Value = serde_json::from_str(&event.text).unwrap();
    assert_eq!(event["type"], "task.worker-host-removed");
    assert_eq!(event["workerHostId"], "worker");
    assert_eq!(event["requeued"], false);
}

/// A reusable Auth Key that asks for a taken or reserved Worker Host ID enrolls the first free
/// `NAME-N`, as tests/auth-key-runtime.test.ts "lets reusable keys join hosts under NAME-2"; a
/// lost response replays the same host, and the same operation with another credential is refused.
async fn host_id_suffix_contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let store = open(url, &clock).await;
    store.put_tag("builder", "Build", vec![]).await.unwrap();
    let fleet = key(&store, "fleet", &["builder"], &[], false).await;
    let enroll = |host: &str, operation: &str, token: &str| {
        let request = EnrollHostRequest {
            host_id: host.into(),
            operation_id: operation.into(),
            token_digest: digest(token),
        };
        let store = store.clone();
        let fleet = fleet.clone();
        async move { store.enroll_host(&request, &fleet).await }
    };
    assert_eq!(
        enroll("runner", "one", "t1").await.unwrap().host_id,
        "runner"
    );
    assert_eq!(
        enroll("runner", "two", "t2").await.unwrap().host_id,
        "runner-2"
    );
    assert_eq!(
        enroll("runner", "two", "t2").await.unwrap().host_id,
        "runner-2"
    );
    assert!(matches!(
        enroll("runner", "two", "stolen").await,
        Err(StoreError::PermissionDenied)
    ));
    // A pending one-time key reserves its host ID.
    store
        .create_auth_key(
            OPERATOR,
            &CreateAuthKeyRequest {
                name: "reserve".into(),
                host_id: "runner-3".into(),
                operation_id: "issue-reserve".into(),
                key_digest: digest("key:reserve"),
                expires_in_ms: 600_000,
                allowed_tag_ids: strings(&["builder"]),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        enroll("runner", "three", "t3").await.unwrap().host_id,
        "runner-4"
    );
    // A suffix that would make the ID too long is not tried.
    let long = "h".repeat(250);
    assert_eq!(enroll(&long, "long", "t4").await.unwrap().host_id, long);
    assert!(matches!(
        enroll(&long, "long-again", "t5").await,
        Err(StoreError::Conflict(_))
    ));
    let listed = store
        .list_hosts(&ListHostsRequest::default())
        .await
        .unwrap();
    let mut ids = listed
        .hosts
        .iter()
        .map(|host| host.host_id.as_str())
        .collect::<Vec<_>>();
    ids.sort_unstable();
    assert_eq!(ids, [long.as_str(), "runner", "runner-2", "runner-4"]);
}

async fn ephemeral_restart_contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let store = open(url, &clock).await;
    assert!(store.sweep_ephemeral_hosts().await.unwrap().is_empty());
    store.put_tag("builder", "Build", vec![]).await.unwrap();
    let ci = key(&store, "ci", &["builder"], &[], true).await;
    let runner = join(&store, &ci, "runner").await;
    let silent = join(&store, &ci, "silent").await;
    report(&store, &runner, 1, &[]).await;
    report(&store, &silent, 1, &[]).await;
    store.close().await;

    // Down for two minutes, far past every presence window.
    let restarted = NOW + 120_000;
    clock.store(restarted, Ordering::SeqCst);
    let store = open(url, &clock).await;
    assert!(store.sweep_ephemeral_hosts().await.unwrap().is_empty());
    clock.store(restarted + 5_000, Ordering::SeqCst);
    report(&store, &runner, 2, &[]).await;
    assert!(store.sweep_ephemeral_hosts().await.unwrap().is_empty());
    // A host that stays silent for a full window after the restart is removed.
    clock.store(restarted + 29_999, Ordering::SeqCst);
    assert!(store.sweep_ephemeral_hosts().await.unwrap().is_empty());
    clock.store(restarted + 30_000, Ordering::SeqCst);
    assert_eq!(store.sweep_ephemeral_hosts().await.unwrap(), ["silent"]);
    // The host that reported keeps its full presence window.
    clock.store(restarted + 34_999, Ordering::SeqCst);
    assert!(store.sweep_ephemeral_hosts().await.unwrap().is_empty());
    assert_eq!(
        store.get_host("runner").await.unwrap().phase,
        HostPhase::Ready as i32
    );
    clock.store(restarted + 35_000, Ordering::SeqCst);
    assert_eq!(store.sweep_ephemeral_hosts().await.unwrap(), ["runner"]);
    store.close().await;
}

fn create(
    operation: &str,
    host_id: &str,
    reusable: bool,
    expires_in_ms: u64,
) -> CreateAuthKeyRequest {
    CreateAuthKeyRequest {
        name: operation.into(),
        host_id: host_id.into(),
        operation_id: operation.into(),
        key_digest: digest(&format!("key:{operation}")),
        expires_in_ms,
        all_tags: true,
        reusable,
        ..Default::default()
    }
}

async fn auth_key_lifecycle_contract(url: &str) {
    const HOUR: u64 = 3_600_000;
    const NINETY_DAYS: u64 = 90 * 24 * HOUR;
    let clock = Arc::new(AtomicI64::new(NOW));
    let store = open(url, &clock).await;
    store.put_tag("builder", "Build", vec![]).await.unwrap();

    // Lifetimes are capped: one hour for a one-time key, 90 days for a reusable key.
    for request in [
        create("long-reusable", "", true, NINETY_DAYS + 1),
        create("long-one-time", "named", false, HOUR + 1),
    ] {
        assert!(matches!(
            store.create_auth_key(OPERATOR, &request).await,
            Err(StoreError::InvalidArgument(_))
        ));
    }
    let pool = create("pool", "", true, 0);
    let issued = store.create_auth_key(OPERATOR, &pool).await.unwrap();
    assert_eq!(issued.expires_at_ms, NOW + NINETY_DAYS as i64);
    assert_eq!(issued.name, "pool");
    assert_eq!(issued.created_at_ms, NOW);
    assert!(!issued.revoked);
    assert_eq!(
        store
            .create_auth_key(OPERATOR, &create("one-time", "one-time-host", false, 0))
            .await
            .unwrap()
            .expires_at_ms,
        NOW + HOUR as i64
    );

    // An expired reusable key enrolls nothing.
    let short = create("short", "", true, 1_000);
    store.create_auth_key(OPERATOR, &short).await.unwrap();
    clock.store(NOW + 1_000, Ordering::SeqCst);
    assert!(matches!(
        store
            .enroll_host(
                &EnrollHostRequest {
                    host_id: "late".into(),
                    operation_id: "join-late".into(),
                    token_digest: digest("token:late"),
                },
                &short.key_digest,
            )
            .await,
        Err(StoreError::PermissionDenied)
    ));

    // A pending one-time key reserves its host ID against reusable joins, which take NAME-2.
    let reserved = create("reserved", "reserved-host", false, 0);
    store.create_auth_key(OPERATOR, &reserved).await.unwrap();
    assert_eq!(
        store
            .enroll_host(
                &EnrollHostRequest {
                    host_id: "reserved-host".into(),
                    operation_id: "steal".into(),
                    token_digest: digest("token:steal"),
                },
                &pool.key_digest,
            )
            .await
            .unwrap()
            .host_id,
        "reserved-host-2"
    );
    join(&store, &reserved.key_digest, "reserved-host").await;

    // Revocation blocks new joins and replays; joined hosts stay enrolled.
    join(&store, &pool.key_digest, "first").await;
    assert!(matches!(
        store.revoke_auth_key("host:first", &issued.name).await,
        Err(StoreError::PermissionDenied)
    ));
    for name in ["", "Pool", "-pool", "pool.key", &"a".repeat(64)] {
        assert!(matches!(
            store.revoke_auth_key(OPERATOR, name).await,
            Err(StoreError::InvalidArgument(_))
        ));
    }
    assert!(matches!(
        store.revoke_auth_key(OPERATOR, "missing").await,
        Err(StoreError::NotFound(_))
    ));
    let revoked = store.revoke_auth_key(OPERATOR, &issued.name).await.unwrap();
    assert!(revoked.revoked && revoked.reusable);
    assert_eq!(
        store.revoke_auth_key(OPERATOR, &issued.name).await.unwrap(),
        revoked
    );
    assert_eq!(
        store.create_auth_key(OPERATOR, &pool).await.unwrap(),
        revoked
    );
    for (host, operation) in [("second", "join-second"), ("first", "join-first")] {
        assert!(matches!(
            store
                .enroll_host(
                    &EnrollHostRequest {
                        host_id: host.into(),
                        operation_id: operation.into(),
                        token_digest: digest(&format!("token:{host}")),
                    },
                    &pool.key_digest,
                )
                .await,
            Err(StoreError::PermissionDenied)
        ));
    }
    assert_eq!(
        store
            .authenticate_host(&digest("token:first"))
            .await
            .unwrap()
            .host_id,
        "first"
    );
    store.close().await;
}

/// Operator-chosen Auth Key names, as tests/auth-key-store.test.ts and tests/auth-key-cli.test.ts
/// name them, and Worker Host credential rotation, as packages/store/worker-host.test.ts rotates.
async fn auth_key_names_and_host_credentials_contract(url: &str) {
    const HOUR: i64 = 3_600_000;
    let clock = Arc::new(AtomicI64::new(NOW));
    let store = open(url, &clock).await;
    store.put_tag("builder", "Build", vec![]).await.unwrap();

    // Names are validated, and never reused: not after revocation, expiry or use.
    let mut invalid = create("invalid", "", true, 0);
    for name in ["", "CI", "_ci", "ci key", "ci.key", &"c".repeat(64)] {
        invalid.name = name.into();
        assert!(matches!(
            store.create_auth_key(OPERATOR, &invalid).await,
            Err(StoreError::InvalidArgument(_))
        ));
    }
    let mut longest = create("longest", "", true, 0);
    longest.name = format!("9{}", "_".repeat(62));
    store.create_auth_key(OPERATOR, &longest).await.unwrap();
    let laptop = create("laptop", "laptop-host", false, 0);
    let issued = store.create_auth_key(OPERATOR, &laptop).await.unwrap();
    assert_eq!(
        (issued.name.as_str(), issued.used, issued.revoked),
        ("laptop", false, false)
    );
    let mut reused = create("laptop-again", "", true, 0);
    reused.name = "laptop".into();
    assert!(matches!(
        store.create_auth_key(OPERATOR, &reused).await,
        Err(StoreError::Conflict(_))
    ));
    // The same operation with a different name is a different request.
    let mut renamed = laptop.clone();
    renamed.name = "renamed".into();
    assert!(matches!(
        store.create_auth_key(OPERATOR, &renamed).await,
        Err(StoreError::Conflict(_))
    ));
    clock.store(NOW + 1, Ordering::SeqCst);
    store
        .create_auth_key(OPERATOR, &create("ci", "", true, 0))
        .await
        .unwrap();
    clock.store(NOW + 2, Ordering::SeqCst);
    store
        .create_auth_key(OPERATOR, &create("brief", "brief-host", false, 1))
        .await
        .unwrap();

    // A one-time key's use is visible; the host keeps its credential.
    join(&store, &laptop.key_digest, "laptop-host").await;
    assert!(store.get_auth_key(OPERATOR, "laptop").await.unwrap().used);
    assert!(matches!(
        store.get_auth_key("host:laptop-host", "laptop").await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store.get_auth_key(OPERATOR, "missing").await,
        Err(StoreError::NotFound(_))
    ));
    store.revoke_auth_key(OPERATOR, "ci").await.unwrap();
    clock.store(NOW + HOUR, Ordering::SeqCst);
    let mut again = create("ci-again", "", true, 0);
    again.name = "ci".into();
    assert!(matches!(
        store.create_auth_key(OPERATOR, &again).await,
        Err(StoreError::Conflict(_))
    ));

    // Earliest created first, then by name; revoked, expired and used keys included.
    let names = |page: &ListAuthKeysResponse| {
        page.auth_keys
            .iter()
            .map(|key| key.name.clone())
            .collect::<Vec<_>>()
    };
    let all = store
        .list_auth_keys(OPERATOR, &ListAuthKeysRequest::default())
        .await
        .unwrap();
    assert_eq!(names(&all), [&longest.name, "laptop", "ci", "brief"]);
    assert!(all.next_cursor.is_empty());
    assert!(all.auth_keys[2].revoked);
    let first = store
        .list_auth_keys(
            OPERATOR,
            &ListAuthKeysRequest {
                limit: 2,
                cursor: String::new(),
            },
        )
        .await
        .unwrap();
    assert_eq!(first.next_cursor, "laptop");
    let second = store
        .list_auth_keys(
            OPERATOR,
            &ListAuthKeysRequest {
                limit: 2,
                cursor: first.next_cursor,
            },
        )
        .await
        .unwrap();
    assert_eq!(names(&second), ["ci", "brief"]);
    assert!(second.next_cursor.is_empty());
    for request in [
        ListAuthKeysRequest {
            limit: 501,
            cursor: String::new(),
        },
        ListAuthKeysRequest {
            limit: 1,
            cursor: "missing".into(),
        },
    ] {
        assert!(matches!(
            store.list_auth_keys(OPERATOR, &request).await,
            Err(StoreError::InvalidArgument(_))
        ));
    }

    // Rotation replaces the credential at once and advances the revision from 1.
    assert_eq!(
        store
            .get_host("laptop-host")
            .await
            .unwrap()
            .credential_revision,
        1
    );
    let rotate = |revision: u64, secret: &str| RotateHostCredentialRequest {
        host_id: "laptop-host".into(),
        expected_credential_revision: revision,
        token_digest: digest(secret),
    };
    assert!(matches!(
        store
            .rotate_host_credential("host:laptop-host", &rotate(1, "token:rotated"))
            .await,
        Err(StoreError::PermissionDenied)
    ));
    assert!(matches!(
        store
            .rotate_host_credential(OPERATOR, &rotate(0, "token:rotated"))
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    assert!(matches!(
        store
            .rotate_host_credential(OPERATOR, &rotate(2, "token:rotated"))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    // Neither another host's credential nor an Auth Key becomes this host's credential.
    join(&store, &store_key(&store, "spare").await, "spare-host").await;
    for secret in ["token:spare-host", "key:laptop"] {
        assert!(matches!(
            store
                .rotate_host_credential(OPERATOR, &rotate(1, secret))
                .await,
            Err(StoreError::Conflict(_))
        ));
    }
    let rotated = store
        .rotate_host_credential(OPERATOR, &rotate(1, "token:rotated"))
        .await
        .unwrap();
    assert_eq!(rotated.credential_revision, 2);
    // A repeat of the applied rotation answers the same; a stale one is refused.
    assert_eq!(
        store
            .rotate_host_credential(OPERATOR, &rotate(1, "token:rotated"))
            .await
            .unwrap(),
        rotated
    );
    assert!(matches!(
        store
            .rotate_host_credential(OPERATOR, &rotate(1, "token:other"))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert!(matches!(
        store.authenticate_host(&digest("token:laptop-host")).await,
        Err(StoreError::PermissionDenied)
    ));
    let record = store
        .authenticate_host(&digest("token:rotated"))
        .await
        .unwrap();
    // The registration and its running work are unchanged until the host restarts.
    assert_eq!(
        (record.host_id.as_str(), record.generation),
        ("laptop-host", 1)
    );
    assert_eq!(
        store
            .get_host("laptop-host")
            .await
            .unwrap()
            .credential_revision,
        2
    );

    // A host whose credential comes from Control Plane startup is changed there instead.
    store
        .seed_host("local", &digest("token:local"))
        .await
        .unwrap();
    assert!(matches!(
        store
            .rotate_host_credential(
                OPERATOR,
                &RotateHostCredentialRequest {
                    host_id: "local".into(),
                    expected_credential_revision: 1,
                    token_digest: digest("token:local-rotated"),
                },
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert!(matches!(
        store
            .rotate_host_credential(
                OPERATOR,
                &RotateHostCredentialRequest {
                    host_id: "missing".into(),
                    expected_credential_revision: 1,
                    token_digest: digest("token:missing"),
                },
            )
            .await,
        Err(StoreError::NotFound(_))
    ));
    // A revoked host is enrolled under a new ID instead.
    store.revoke_host("laptop-host").await.unwrap();
    assert!(matches!(
        store
            .rotate_host_credential(OPERATOR, &rotate(2, "token:after-revoke"))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    store.close().await;
}

async fn store_key(store: &Store, name: &str) -> Vec<u8> {
    let request = create(name, "", true, 0);
    store.create_auth_key(OPERATOR, &request).await.unwrap();
    request.key_digest
}

/// A restarted host claims with the labels it reports in its new generation.
async fn restarted_host_labels_contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let store = open(url, &clock).await;
    store.put_tag("trainer", "Train", vec![]).await.unwrap();
    runs_on(&store, "trainer", &["tpu"]).await;
    let pool = key(&store, "pool", &["trainer"], &[], false).await;
    let first = join(&store, &pool, "tpu-host").await;
    report(&store, &first, 1, &["tpu"]).await;
    let record = store
        .register_host("tpu-host", "second-incarnation")
        .await
        .unwrap();
    let second = HostAuthority::new("host:tpu-host", record.generation).unwrap();
    let task = submit(&store, "trainer", "train").await;
    assert_eq!(claim(&store, &second, "before-report").await, None);
    let diagnosis = store.diagnose_task_placement(&task).await.unwrap();
    assert_eq!(diagnosis.missing_labels, ["tpu"]);
    report(&store, &second, 1, &["tpu"]).await;
    assert_eq!(
        claim(&store, &second, "after-report").await.as_deref(),
        Some(task.as_str())
    );
    store.close().await;
}

fn sqlite_url(directory: &tempfile::TempDir) -> String {
    format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("placement.db").display()
    )
}

#[tokio::test]
async fn sqlite_placement_contract() {
    let directory = tempfile::tempdir().unwrap();
    placement_contract(&sqlite_url(&directory)).await;
}

#[tokio::test]
async fn sqlite_ephemeral_host_contract() {
    let directory = tempfile::tempdir().unwrap();
    ephemeral_contract(&sqlite_url(&directory)).await;
}

#[tokio::test]
async fn sqlite_removed_host_cancelled_attempt_contract() {
    let directory = tempfile::tempdir().unwrap();
    removed_host_cancelled_attempt_contract(&sqlite_url(&directory)).await;
}

#[tokio::test]
async fn sqlite_host_id_suffix_contract() {
    let directory = tempfile::tempdir().unwrap();
    host_id_suffix_contract(&sqlite_url(&directory)).await;
}

#[tokio::test]
async fn sqlite_ephemeral_restart_contract() {
    let directory = tempfile::tempdir().unwrap();
    ephemeral_restart_contract(&sqlite_url(&directory)).await;
}

#[tokio::test]
async fn sqlite_auth_key_lifecycle_contract() {
    let directory = tempfile::tempdir().unwrap();
    auth_key_lifecycle_contract(&sqlite_url(&directory)).await;
}

#[tokio::test]
async fn sqlite_auth_key_names_and_host_credentials_contract() {
    let directory = tempfile::tempdir().unwrap();
    auth_key_names_and_host_credentials_contract(&sqlite_url(&directory)).await;
}

#[tokio::test]
async fn sqlite_restarted_host_labels_contract() {
    let directory = tempfile::tempdir().unwrap();
    restarted_host_labels_contract(&sqlite_url(&directory)).await;
}

async fn on_postgres<F, Fut>(run: F)
where
    F: FnOnce(String) -> Fut + 'static,
    Fut: std::future::Future<Output = ()> + 'static,
{
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_rust_placement_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&name);
    let outcome = tokio::task::LocalSet::new()
        .run_until(async move { tokio::task::spawn_local(run(url.to_string())).await })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL placement contract failed");
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_placement_contract() {
    on_postgres(|url| async move { placement_contract(&url).await }).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_ephemeral_host_contract() {
    on_postgres(|url| async move { ephemeral_contract(&url).await }).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_ephemeral_restart_contract() {
    on_postgres(|url| async move { ephemeral_restart_contract(&url).await }).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_auth_key_lifecycle_contract() {
    on_postgres(|url| async move { auth_key_lifecycle_contract(&url).await }).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_restarted_host_labels_contract() {
    on_postgres(|url| async move { restarted_host_labels_contract(&url).await }).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_auth_key_names_and_host_credentials_contract() {
    on_postgres(|url| async move { auth_key_names_and_host_credentials_contract(&url).await })
        .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_host_id_suffix_contract() {
    on_postgres(|url| async move { host_id_suffix_contract(&url).await }).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_removed_host_cancelled_attempt_contract() {
    on_postgres(|url| async move { removed_host_cancelled_attempt_contract(&url).await }).await;
}
