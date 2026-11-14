mod support;

use prost::Message;
use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OP: &str = "operator:artifact-reader";

async fn message(store: &Store, operator: &str, conversation: &str, operation: &str) -> Task {
    store
        .send_message(
            operator,
            &SendMessageRequest {
                tag_id: "writer".into(),
                conversation: conversation.into(),
                text: "Use evidence".into(),
                operation_id: operation.into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .task
        .unwrap()
}
async fn claim(store: &Store, host: &HostAuthority, operation: &str) -> InspectAttemptRequest {
    let assignment = store.claim_task(host, operation).await.unwrap().unwrap();
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
    attempt
}
async fn finish(store: &Store, host: &HostAuthority, attempt: &InspectAttemptRequest) {
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                succeeded: true,
                result: "Recorded evidence".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}
fn capture(attempt: &InspectAttemptRequest, operation: &str) -> CommitArtifactCaptureRequest {
    CommitArtifactCaptureRequest {
        attempt: Some(attempt.clone()),
        operation_id: operation.into(),
        description: Some(ArtifactDescription {
            title: "Evidence".into(),
            kind: "report".into(),
            summary: Some("Bounded test evidence".into()),
        }),
        files: vec![
            ArtifactFile {
                git_output: None,
                path: "readme.txt".into(),
                blob: Some(BlobReference {
                    sha256: "a".repeat(64),
                    byte_length: 10,
                }),
            },
            ArtifactFile {
                git_output: None,
                path: "private.txt".into(),
                blob: Some(BlobReference {
                    sha256: "b".repeat(64),
                    byte_length: 20,
                }),
            },
        ],
        ..Default::default()
    }
}
async fn commit(
    store: &Store,
    host: &HostAuthority,
    input: &CommitArtifactCaptureRequest,
) -> CapturedArtifact {
    store.reserve_artifact_capture(host, input).await.unwrap();
    store.commit_artifact_capture(host, input).await.unwrap()
}
async fn session_contract(url: &str) {
    let store = Store::open(url).await.unwrap();
    store
        .put_tag(
            "writer",
            "Use immutable evidence",
            vec!["files:read".into()],
        )
        .await
        .unwrap();
    let host = support::register_host(&store, "artifact-consumer").await;
    let intruder = support::register_host(&store, "artifact-intruder").await;
    let source = message(&store, OP, "same-session", "source").await;
    let producing = claim(&store, &host, "source").await;
    assert_eq!(source.task_id, producing.task_id);
    let artifact = commit(&store, &host, &capture(&producing, "source")).await;
    let id = artifact.summary.as_ref().unwrap().artifact_id.clone();
    finish(&store, &host, &producing).await;
    let consuming = message(&store, OP, "same-session", "consumer").await;
    let attempt = claim(&store, &host, "consumer").await;
    assert_eq!(attempt.task_id, consuming.task_id);
    let inspect = InspectAttemptArtifactRequest {
        attempt: Some(attempt.clone()),
        artifact_id: id.clone(),
    };
    assert_eq!(
        store
            .inspect_attempt_artifact(&host, &inspect)
            .await
            .unwrap(),
        artifact
    );
    let found = store
        .find_attempt_artifacts(
            &host,
            &FindAttemptArtifactsRequest {
                attempt: Some(attempt.clone()),
                query: "evidence".into(),
                limit: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(found.artifacts.len(), 1);
    assert_eq!(found.artifacts[0].artifact_id, id);
    let input = AcquireArtifactRequest {
        attempt: Some(attempt.clone()),
        operation_id: "read-first".into(),
        artifact_id: id.clone(),
        paths: vec!["readme.txt".into()],
        delivery: ArtifactDelivery::Read as i32,
        destination: None,
    };
    assert!(matches!(
        store.acquire_artifact(&intruder, &input).await,
        Err(StoreError::PermissionDenied)
    ));
    let stale = HostAuthority::new("host:artifact-consumer", 9999).unwrap();
    assert!(store.acquire_artifact(&stale, &input).await.is_err());
    let (one, two) = tokio::join!(
        store.acquire_artifact(&host, &input),
        store.acquire_artifact(&host, &input)
    );
    let receipt = one.unwrap();
    assert_eq!(receipt, two.unwrap());
    assert_eq!(receipt.state(), ArtifactAcquisitionState::Authorized);
    assert_eq!(receipt.files.len(), 1);
    assert_eq!(receipt.files[0].path, "readme.txt");
    let mut changed = input.clone();
    changed.paths = vec!["private.txt".into()];
    assert!(matches!(
        store.acquire_artifact(&host, &changed).await,
        Err(StoreError::Conflict(_))
    ));
    changed.operation_id = "missing".into();
    changed.paths = vec!["missing".into()];
    assert!(store.acquire_artifact(&host, &changed).await.is_err());
    let download = GetAcquiredArtifactFileRequest {
        attempt: Some(attempt.clone()),
        acquisition_id: receipt.acquisition_id.clone(),
        path: "readme.txt".into(),
    };
    assert_eq!(
        store
            .get_acquired_artifact_file(&host, &download)
            .await
            .unwrap(),
        receipt.files[0]
    );
    let mut forbidden = download.clone();
    forbidden.path = "private.txt".into();
    assert!(matches!(
        store.get_acquired_artifact_file(&host, &forbidden).await,
        Err(StoreError::NotFound(_))
    ));
    forbidden = download.clone();
    forbidden.attempt.as_mut().unwrap().lease_token = "other".into();
    assert!(
        store
            .get_acquired_artifact_file(&host, &forbidden)
            .await
            .is_err()
    );
    let unconfirmed = commit(&store, &host, &capture(&attempt, "unconfirmed-input")).await;
    assert!(unconfirmed.inputs.is_empty());
    let mut settle = SettleArtifactAcquisitionRequest {
        attempt: Some(attempt.clone()),
        acquisition_id: receipt.acquisition_id.clone(),
        state: ArtifactAcquisitionState::Uncertain as i32,
    };
    store
        .settle_artifact_acquisition(&host, &settle)
        .await
        .unwrap();
    let uncertain = commit(&store, &host, &capture(&attempt, "uncertain-input")).await;
    assert!(uncertain.inputs.is_empty());
    settle.state = ArtifactAcquisitionState::Delivered as i32;
    let delivered = store
        .settle_artifact_acquisition(&host, &settle)
        .await
        .unwrap();
    assert_eq!(
        store.acquire_artifact(&host, &input).await.unwrap(),
        delivered
    );
    let derived_input = capture(&attempt, "derived");
    let derived = commit(&store, &host, &derived_input).await;
    assert_eq!(
        derived.inputs,
        vec![ArtifactSelection {
            artifact_id: id.clone(),
            paths: vec!["readme.txt".into()]
        }]
    );
    let later = AcquireArtifactRequest {
        operation_id: "later".into(),
        paths: vec!["private.txt".into()],
        ..input.clone()
    };
    let later = store.acquire_artifact(&host, &later).await.unwrap();
    store
        .settle_artifact_acquisition(
            &host,
            &SettleArtifactAcquisitionRequest {
                attempt: Some(attempt.clone()),
                acquisition_id: later.acquisition_id,
                state: ArtifactAcquisitionState::Delivered as i32,
            },
        )
        .await
        .unwrap();
    // A capture retry keeps the lineage at reservation even after another input arrives.
    assert_eq!(commit(&store, &host, &derived_input).await, derived);
    let newer = commit(&store, &host, &capture(&attempt, "newer")).await;
    assert_eq!(newer.inputs[0].paths, ["private.txt", "readme.txt"]);
    settle.state = ArtifactAcquisitionState::Failed as i32;
    assert!(matches!(
        store.settle_artifact_acquisition(&host, &settle).await,
        Err(StoreError::Conflict(_))
    ));
    drop(store);
    let store = Store::open(url).await.unwrap();
    assert_eq!(
        store.acquire_artifact(&host, &input).await.unwrap(),
        delivered
    );
    assert_eq!(
        store
            .get_captured_artifact(OP, &derived.summary.unwrap().artifact_id)
            .await
            .unwrap()
            .inputs
            .len(),
        1
    );
    finish(&store, &host, &attempt).await;
    assert!(
        store
            .get_acquired_artifact_file(&host, &download)
            .await
            .is_err()
    );
    assert!(
        store
            .inspect_attempt_artifact(&host, &inspect)
            .await
            .is_err()
    );
    let unrelated = message(&store, OP, "unrelated", "unrelated").await;
    let other = claim(&store, &host, "unrelated").await;
    assert_eq!(other.task_id, unrelated.task_id);
    assert!(matches!(
        store
            .inspect_attempt_artifact(
                &host,
                &InspectAttemptArtifactRequest {
                    attempt: Some(other.clone()),
                    artifact_id: id.clone()
                }
            )
            .await,
        Err(StoreError::NotFound(_))
    ));
    assert!(
        store
            .find_attempt_artifacts(
                &host,
                &FindAttemptArtifactsRequest {
                    attempt: Some(other.clone()),
                    ..Default::default()
                }
            )
            .await
            .unwrap()
            .artifacts
            .is_empty()
    );
    finish(&store, &host, &other).await;
    let private = message(&store, "operator:other", "same-session", "private").await;
    let other = claim(&store, &host, "private").await;
    assert_eq!(other.task_id, private.task_id);
    assert!(matches!(
        store
            .inspect_attempt_artifact(
                &host,
                &InspectAttemptArtifactRequest {
                    attempt: Some(other.clone()),
                    artifact_id: id
                }
            )
            .await,
        Err(StoreError::NotFound(_))
    ));
    finish(&store, &host, &other).await;
}
async fn objective_contract(url: &str) {
    let store = Store::open(url).await.unwrap();
    for id in ["owner", "reviewer"] {
        store
            .put_tag(id, "Review evidence", vec!["files:read".into()])
            .await
            .unwrap();
    }
    let host = support::register_host(&store, "objective-artifacts").await;
    let team = store
        .create_team(
            OP,
            &CreateTeamRequest {
                operation_id: "team".into(),
                team_id: "artifact-team".into(),
                name: "Artifact team".into(),
                member_tag_ids: vec!["owner".into(), "reviewer".into()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let objective = store
        .create_objective(
            OP,
            &CreateObjectiveRequest {
                operation_id: "objective".into(),
                objective_id: "artifact-objective".into(),
                owner_tag_id: "owner".into(),
                outcome: "Review immutable evidence".into(),
                ongoing: true,
                team_id: Some(team.team_id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let owner = claim(&store, &host, "owner").await;
    assert_eq!(owner.task_id, objective.starting_task_id);
    let artifact = commit(&store, &host, &capture(&owner, "objective-source")).await;
    let child = store
        .start_work_session(
            &host,
            &StartWorkSessionRequest {
                attempt: Some(owner.clone()),
                operation_id: "delegate".into(),
                title: "Review".into(),
                instruction: "Read source evidence".into(),
                target_tag_id: Some("reviewer".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let reviewer = claim(&store, &host, "reviewer").await;
    assert_eq!(reviewer.task_id, child.latest_task_id);
    let visible = store
        .inspect_attempt_artifact(
            &host,
            &InspectAttemptArtifactRequest {
                attempt: Some(reviewer.clone()),
                artifact_id: artifact.summary.as_ref().unwrap().artifact_id.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(visible, artifact);
    assert_eq!(
        visible.summary.unwrap().producer.unwrap().objective_id,
        Some(objective.objective_id)
    );
    finish(&store, &host, &reviewer).await;
    finish(&store, &host, &owner).await;
}
async fn upgrade_contract(url: &str) {
    sqlx::any::install_default_drivers();
    let pool = sqlx::AnyPool::connect(url).await.unwrap();
    let dialect = if url.starts_with("sqlite:") {
        "sqlite"
    } else {
        "postgresql"
    };
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("migrations")
        .join(dialect);
    let mut files = std::fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name().unwrap().to_string_lossy()[..4]
                .parse::<u32>()
                .is_ok_and(|version| version <= 45)
        })
        .collect::<Vec<_>>();
    files.sort();
    assert_eq!(files.len(), 45);
    for file in files {
        sqlx::raw_sql(&std::fs::read_to_string(file).unwrap())
            .execute(&pool)
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO supertag_v2_tags(tag_id,instructions,allowed_actions,revision) VALUES('archived-writer','Old instructions','[]',1)").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO supertag_v2_tasks(task_id,tag_id,session_id,prompt,instructions,allowed_actions,tag_revision,state,result,attempt_id,accepted_order) VALUES('archived-task','archived-writer','archived-session','Old prompt','Old instructions','[]',1,3,'Old result','archived-attempt',1)").execute(&pool).await.unwrap();
    let old = CapturedArtifact {
        summary: Some(ArtifactSummary {
            artifact_id: "archived-artifact".into(),
            description: Some(ArtifactDescription {
                title: "Pre-acquisition evidence".into(),
                kind: "report".into(),
                summary: None,
            }),
            producer: Some(ArtifactProducer {
                task_id: "archived-task".into(),
                attempt_id: "archived-attempt".into(),
                tag_id: "archived-writer".into(),
                session_id: "archived-session".into(),
                ..Default::default()
            }),
            ..Default::default()
        }),
        ..Default::default()
    };
    sqlx::query("INSERT INTO supertag_v2_artifact_captures(artifact_id,task_id,attempt_id,operation_id,request_digest,payload,committed_order) VALUES('archived-artifact','archived-task','archived-attempt','archived-op','archived-digest',$1,2)").bind(old.encode_to_vec()).execute(&pool).await.unwrap();
    sqlx::query("UPDATE supertag_v2_write_order SET revision=2 WHERE singleton=1")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let store = Store::open(url).await.unwrap();
    assert_eq!(
        store
            .get_captured_artifact(OP, "archived-artifact")
            .await
            .unwrap(),
        old
    );
}
async fn contract(url: String) {
    Box::pin(upgrade_contract(&url)).await;
    Box::pin(session_contract(&url)).await;
    Box::pin(objective_contract(&url)).await;
}
#[tokio::test]
async fn sqlite_artifact_acquisition() {
    let directory = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("state.db").display()
    ))
    .await;
}
#[tokio::test]
#[ignore = "requires dedicated PostgreSQL server"]
async fn postgres_artifact_acquisition() {
    let base =
        std::fs::read_to_string(std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").unwrap())
            .unwrap();
    let mut url = url::Url::parse(base.trim()).unwrap();
    let database = format!("supertag_acquisition_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(base.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await
        .unwrap();
    url.set_path(&database);
    let result = tokio::task::LocalSet::new()
        .run_until(async move { tokio::task::spawn_local(contract(url.to_string())).await })
        .await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await
        .unwrap();
    result.unwrap();
}
