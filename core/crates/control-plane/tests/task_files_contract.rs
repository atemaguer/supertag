//! Task files on the client's own machine: a Worker Host reports a running Attempt's checkout,
//! and Locate gives it to a caller that presents the host's machine identifier. Anyone else is
//! told the files are unreachable, and a Task that isn't running has no checkout to read. Locate
//! returns locations only, never file content.

mod support;

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OP: &str = "operator:alice";
const MACHINE: &str = "0123456789abcdef0123456789abcdef";
const OTHER_MACHINE: &str = "fedcba9876543210fedcba9876543210";

async fn locate(store: &Store, principal: &str, task: &str, machine: &str) -> TaskFileLocation {
    store
        .locate_task_files(
            principal,
            &LocateTaskFilesRequest {
                task_id: task.into(),
                machine_id: machine.into(),
            },
        )
        .await
        .unwrap()
        .locations
        .remove(0)
}

fn local_path(location: &TaskFileLocation) -> Option<&str> {
    match &location.kind {
        Some(task_file_location::Kind::LocalPath(local)) => Some(&local.path),
        None => None,
    }
}

async fn contract(url: &str) {
    let store = Store::open(url).await.unwrap();
    store
        .put_tag("builder", "Build", vec!["files:read".into()])
        .await
        .unwrap();
    let host: HostAuthority = support::register_host(&store, "laptop").await;
    store
        .report_host(
            &host,
            &ReportHostRequest {
                sequence: 1,
                capacity: 1,
                available_slots: 1,
                readiness: HostReadiness::Ready.into(),
                harness_kind: HarnessKind::Codex.into(),
                machine_id: MACHINE.into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let task = store
        .submit_task(
            OP,
            &SubmitTaskRequest {
                tag_id: "builder".into(),
                session_id: "files".into(),
                operation_id: "build".into(),
                prompt: "Build it".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let claim = store
        .claim_task(&host, &Uuid::new_v4().to_string())
        .await
        .unwrap()
        .expect("the queued Task");
    let attempt = InspectAttemptRequest {
        task_id: task.task_id.clone(),
        attempt_id: claim.attempt_id.clone(),
        lease_token: claim.lease_token.clone(),
    };
    store
        .start_task(
            &host,
            &StartTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
            },
        )
        .await
        .unwrap();

    // Before the host says where the checkout is, there is nothing to read.
    let unknown = locate(&store, OP, &task.task_id, MACHINE).await;
    assert!(local_path(&unknown).is_none());
    assert!(
        unknown.unavailable_reason.contains("hasn't said"),
        "{unknown:?}"
    );

    // The host reports only an absolute path, for its own running Attempt.
    let report = |path: &str| ReportTaskFilesLocationRequest {
        local_path: path.into(),
    };
    assert!(matches!(
        store
            .report_task_files_location(
                &supertag_control_plane::AttemptAccess::new(&host, &attempt),
                &report("relative/checkout")
            )
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    let stranger = support::register_host(&store, "stranger").await;
    assert!(
        store
            .report_task_files_location(
                &supertag_control_plane::AttemptAccess::new(&stranger, &attempt),
                &report("/srv/elsewhere")
            )
            .await
            .is_err()
    );
    store
        .report_task_files_location(
            &supertag_control_plane::AttemptAccess::new(&host, &attempt),
            &report("/Users/alice/.supertag/checkouts/build"),
        )
        .await
        .unwrap();

    // The same machine gets the directory and reads it itself.
    let here = locate(&store, OP, &task.task_id, MACHINE).await;
    assert_eq!(
        local_path(&here),
        Some("/Users/alice/.supertag/checkouts/build")
    );
    assert!(here.live && here.unavailable_reason.is_empty());
    assert_eq!(here.host_id, "laptop");
    assert_eq!(here.id, format!("attempt:{}", attempt.attempt_id));

    // Another machine, or one that presents nothing, is told the files are out of reach.
    for machine in [OTHER_MACHINE, ""] {
        let there = locate(&store, OP, &task.task_id, machine).await;
        assert!(local_path(&there).is_none());
        assert_eq!(
            there.unavailable_reason,
            "Files on Worker Host laptop are unreachable from here."
        );
    }
    // A malformed identifier is refused, and a caller who may not read the Task finds nothing.
    assert!(matches!(
        store
            .locate_task_files(
                OP,
                &LocateTaskFilesRequest {
                    task_id: task.task_id.clone(),
                    machine_id: "not-a-machine".into(),
                },
            )
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    assert!(matches!(
        store
            .locate_task_files(
                "client:someone-else",
                &LocateTaskFilesRequest {
                    task_id: task.task_id.clone(),
                    machine_id: MACHINE.into(),
                },
            )
            .await,
        Err(StoreError::NotFound(_))
    ));

    // Once the Task finishes, its checkout is gone.
    store
        .finish_task(
            &host,
            &FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                result: "Built".into(),
                succeeded: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let finished = locate(&store, OP, &task.task_id, MACHINE).await;
    assert!(local_path(&finished).is_none() && !finished.live);
    assert!(
        finished.unavailable_reason.contains("isn't running"),
        "{finished:?}"
    );
    store.close().await;
}

#[tokio::test]
async fn sqlite_task_files_contract() {
    let directory = tempfile::tempdir().unwrap();
    contract(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("files.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_task_files_contract() {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("PostgreSQL test URL file required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let name = format!("supertag_task_files_{}", Uuid::new_v4().simple());
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
    outcome.expect("PostgreSQL task files contract failed");
}
