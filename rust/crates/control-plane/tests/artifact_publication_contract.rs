use sqlx::{Connection, Executor};
use uuid::Uuid;
mod support;
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::*;
const OP: &str = "operator:publication-owner";
async fn exercise(url: &str) {
    // Apply the real populated predecessor schema, then exercise the additive upgrade.
    sqlx::any::install_default_drivers();
    let mut connection = sqlx::AnyConnection::connect(url).await.unwrap();
    let dialect = if url.starts_with("sqlite:") {
        "sqlite"
    } else {
        "postgresql"
    };
    let mut migrations = std::fs::read_dir(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("migrations")
            .join(dialect),
    )
    .unwrap()
    .map(|e| e.unwrap().path())
    .filter(|p| {
        p.file_name().unwrap().to_str().unwrap()[..4]
            .parse::<u32>()
            .unwrap()
            <= 49
    })
    .collect::<Vec<_>>();
    migrations.sort();
    for migration in migrations {
        sqlx::raw_sql(&std::fs::read_to_string(migration).unwrap())
            .execute(&mut connection)
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO supertag_v2_tags(tag_id,instructions,allowed_actions,revision) VALUES('pre-publication','preserved','[]',3)").execute(&mut connection).await.unwrap();
    connection.close().await.unwrap();
    let store = Store::open(url).await.unwrap();
    assert_eq!(store.get_tag("pre-publication").await.unwrap().revision, 3);
    for tag in ["producer", "consumer", "outsider"] {
        store
            .put_tag(tag, "Work", vec!["files:read".into()])
            .await
            .unwrap();
    }
    let mut objectives = Vec::new();
    for tag in ["producer", "consumer", "outsider"] {
        objectives.push(
            store
                .create_objective(
                    OP,
                    &CreateObjectiveRequest {
                        operation_id: format!("create-{tag}"),
                        objective_id: format!("objective-{tag}"),
                        owner_tag_id: tag.into(),
                        outcome: "Produce reviewed evidence".into(),
                        ongoing: true,
                        ..Default::default()
                    },
                )
                .await
                .unwrap(),
        );
    }
    let host = support::register_host(&store, "publisher").await;
    let assignment = store.claim_task(&host, "claim").await.unwrap().unwrap();
    let task = assignment.task.unwrap();
    assert_eq!(task.task_id, objectives[0].starting_task_id);
    let attempt = InspectAttemptRequest {
        task_id: task.task_id.clone(),
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    };
    store
        .start_task(
            &host,
            &StartTaskRequest {
                task_id: task.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    let capture = CommitArtifactCaptureRequest {
        attempt: Some(attempt.clone()),
        operation_id: "capture".into(),
        description: Some(ArtifactDescription {
            title: "Reviewed interface".into(),
            kind: "report".into(),
            summary: None,
        }),
        files: vec![
            ArtifactFile {
                path: "approved.txt".into(),
                blob: Some(BlobReference {
                    sha256: "a".repeat(64),
                    byte_length: 7,
                }),
                ..Default::default()
            },
            ArtifactFile {
                path: "private.txt".into(),
                blob: Some(BlobReference {
                    sha256: "b".repeat(64),
                    byte_length: 9,
                }),
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    store
        .reserve_artifact_capture(&host, &capture)
        .await
        .unwrap();
    let artifact = store
        .commit_artifact_capture(&host, &capture)
        .await
        .unwrap()
        .summary
        .unwrap()
        .artifact_id;
    let request = PublishArtifactRequest {
        publication_id: "published".into(),
        artifact_id: artifact.clone(),
        paths: vec!["approved.txt".into()],
        audience_objective_ids: vec![objectives[1].objective_id.clone()],
        supersedes_publication_id: None,
    };
    assert!(matches!(
        store.publish_artifact(OP, &request).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    store
        .finish_task(
            &host,
            &FinishTaskRequest {
                task_id: task.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                result: "private producer assessment".into(),
                succeeded: true,
                artifacts: vec![ArtifactSelection {
                    artifact_id: artifact.clone(),
                    paths: vec!["approved.txt".into()],
                }],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let (mut a, mut b) = (request.clone(), request.clone());
    a.paths = vec!["private.txt".into()];
    assert!(store.publish_artifact(OP, &a).await.is_err());
    a = request.clone();
    a.audience_objective_ids = vec![objectives[0].objective_id.clone()];
    assert!(store.publish_artifact(OP, &a).await.is_err());
    assert!(
        store
            .publish_artifact("host:publisher", &request)
            .await
            .is_err()
    );
    let (p, q) = tokio::join!(
        store.publish_artifact(OP, &request),
        store.publish_artifact(OP, &request)
    );
    let p = p.unwrap();
    assert_eq!(p, q.unwrap());
    assert_eq!(p.producer.as_ref().unwrap().attempt_id, attempt.attempt_id);
    assert_eq!(p.files.len(), 1);
    assert_eq!(p.assessment, "private producer assessment");
    b.audience_objective_ids
        .push(objectives[2].objective_id.clone());
    assert!(matches!(
        store.publish_artifact(OP, &b).await,
        Err(StoreError::Conflict(_))
    ));
    let consume = ConsumeArtifactPublicationRequest {
        consumption_id: "consent".into(),
        publication_id: p.publication_id.clone(),
        objective_id: objectives[1].objective_id.clone(),
    };
    let mut bad = consume.clone();
    bad.objective_id = objectives[2].objective_id.clone();
    assert!(store.consume_artifact_publication(OP, &bad).await.is_err());
    let c = store
        .consume_artifact_publication(OP, &consume)
        .await
        .unwrap();
    assert_eq!(
        c,
        store
            .consume_artifact_publication(OP, &consume)
            .await
            .unwrap()
    );
    bad = consume.clone();
    bad.consumption_id = "second".into();
    assert!(matches!(
        store.consume_artifact_publication(OP, &bad).await,
        Err(StoreError::Conflict(_))
    ));
    let list = store
        .list_artifact_publications(
            OP,
            &ListObjectiveArtifactApprovalsRequest {
                objective_id: objectives[1].objective_id.clone(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(list.publications.len(), 1);
    let debug = format!("{list:?}");
    assert!(!debug.contains(&task.task_id));
    assert!(!debug.contains("private producer assessment"));
    assert!(!debug.contains(OP));
    store.close().await;
    let store = Store::open(url).await.unwrap();
    assert_eq!(
        store
            .get_artifact_publication(OP, "published")
            .await
            .unwrap(),
        p
    );
    let withdraw = WithdrawArtifactApprovalRequest {
        approval_id: "consent".into(),
        expected_revision: 1,
    };
    let stopped = store
        .withdraw_artifact_consumption(OP, &withdraw)
        .await
        .unwrap();
    assert_eq!(stopped.revision, 2);
    assert_eq!(
        stopped,
        store
            .withdraw_artifact_consumption(OP, &withdraw)
            .await
            .unwrap()
    );
    assert_eq!(
        store
            .list_artifact_approval_audit(
                OP,
                &ListArtifactApprovalAuditRequest {
                    approval_type: "consumption".into(),
                    approval_id: "consent".into()
                }
            )
            .await
            .unwrap()
            .events
            .len(),
        2
    );
    let withdraw = WithdrawArtifactApprovalRequest {
        approval_id: "published".into(),
        expected_revision: 1,
    };
    let stopped = store
        .withdraw_artifact_publication(OP, &withdraw)
        .await
        .unwrap();
    assert_eq!(
        stopped,
        store
            .withdraw_artifact_publication(OP, &withdraw)
            .await
            .unwrap()
    );
    assert_eq!(stopped.status, ArtifactApprovalStatus::Withdrawn as i32);
    assert!(
        store
            .withdraw_artifact_publication(
                OP,
                &WithdrawArtifactApprovalRequest {
                    approval_id: "published".into(),
                    expected_revision: 2
                }
            )
            .await
            .is_err()
    );
    store.close().await;
}
#[tokio::test]
async fn sqlite() {
    let directory = tempfile::tempdir().unwrap();
    exercise(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("test.db").display()
    ))
    .await;
}
#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_publication_contract() {
    let admin_url =
        std::fs::read_to_string(std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").unwrap())
            .unwrap();
    let database = format!("supertag_publications_{}", Uuid::new_v4().simple());
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
