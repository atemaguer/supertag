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
    // A host ID enrolled with another key stays taken.
    assert!(matches!(
        store
            .enroll_host(
                &EnrollHostRequest {
                    host_id: "gpu-host".into(),
                    operation_id: "join-again".into(),
                    token_digest: digest("token:other"),
                },
                &plain_key,
            )
            .await,
        Err(StoreError::Conflict(_))
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

async fn ephemeral_contract(url: &str) {
    let clock = Arc::new(AtomicI64::new(NOW));
    let store = open(url, &clock).await;
    store.put_tag("builder", "Build", vec![]).await.unwrap();
    let ci = key(&store, "ci", &["builder"], &["linux-ci"], true).await;
    let laptop_key = key(&store, "laptop", &["builder"], &[], false).await;
    let runner = join(&store, &ci, "runner").await;
    let laptop = join(&store, &laptop_key, "laptop").await;
    report(&store, &runner, 1, &[]).await;
    report(&store, &laptop, 1, &[]).await;
    assert!(store.get_host("runner").await.unwrap().ephemeral);
    let task = submit(&store, "builder", "build").await;
    assert_eq!(
        claim(&store, &runner, "runner-1").await.as_deref(),
        Some(task.as_str())
    );
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
    // Removal fences the claim, unbinds the host, and hides it from the list.
    let queued = store.get_task(&task).await.unwrap();
    assert_eq!(queued.state, TaskState::Queued as i32);
    assert!(queued.attempt_id.is_none());
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
