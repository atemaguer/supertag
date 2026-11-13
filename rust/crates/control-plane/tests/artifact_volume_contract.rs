mod support;
use sqlx::{Connection, Executor};
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;
const OP: &str = "operator:volume-owner";
async fn exercise(url: &str) {
    // Start from the actual populated schema 47, then let Store apply only 48.
    sqlx::any::install_default_drivers();
    let mut connection = sqlx::AnyConnection::connect(url).await.unwrap();
    let dialect = if url.starts_with("sqlite:") {
        "sqlite"
    } else {
        "postgresql"
    };
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("migrations")
        .join(dialect);
    let mut migrations = std::fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name().unwrap().to_str().unwrap()[..4]
                .parse::<u32>()
                .unwrap()
                <= 47
        })
        .collect::<Vec<_>>();
    migrations.sort();
    for path in migrations {
        sqlx::raw_sql(&std::fs::read_to_string(path).unwrap())
            .execute(&mut connection)
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO supertag_v2_tags(tag_id,instructions,allowed_actions,revision) VALUES ('legacy-volume-owner','preserved before upgrade','[]',7)").execute(&mut connection).await.unwrap();
    connection.close().await.unwrap();
    let store = Store::open(url).await.unwrap();
    let legacy = store.get_tag("legacy-volume-owner").await.unwrap();
    assert_eq!(legacy.instructions, "preserved before upgrade");
    assert_eq!(legacy.revision, 7);
    let input = PutArtifactVolumeRequest {
        operation_id: "register".into(),
        volume_id: "durable".into(),
        source: "file:///srv/artifacts".into(),
        expected_revision: 0,
    };
    let volume = store.put_artifact_volume(OP, &input).await.unwrap();
    assert_eq!(volume.revision, 1);
    assert_eq!(store.put_artifact_volume(OP, &input).await.unwrap(), volume);
    let mut changed = input.clone();
    changed.source = "file:///srv/other".into();
    assert!(matches!(
        store.put_artifact_volume(OP, &changed).await,
        Err(StoreError::Conflict(_))
    ));
    changed.operation_id = "retarget".into();
    assert!(store.put_artifact_volume(OP, &changed).await.is_err());
    changed.expected_revision = 1;
    assert_eq!(
        store
            .put_artifact_volume(OP, &changed)
            .await
            .unwrap()
            .revision,
        2
    );
    let object_input = PutArtifactVolumeRequest {
        operation_id: "register-object".into(),
        volume_id: "object".into(),
        source: "s3://evidence-bucket/organization/archive".into(),
        expected_revision: 0,
    };
    let object = store.put_artifact_volume(OP, &object_input).await.unwrap();
    assert_eq!(object.source, object_input.source);
    assert_eq!(object.revision, 1);
    assert_eq!(
        store.put_artifact_volume(OP, &object_input).await.unwrap(),
        object
    );
    for source in [
        "file://user:secret@host/root",
        "file:///srv/data?secret=bad",
        "s3://bucket/key?credential=bad",
        "s3://wrong%2fbucket/path",
        "s3://bucket/key/../other",
        "file:///srv/../escape",
        "file:///srv/a%00b",
        "file:///srv/data#secret",
    ] {
        let mut invalid = input.clone();
        invalid.volume_id = "invalid".into();
        invalid.operation_id = "invalid".into();
        invalid.source = source.into();
        assert!(store.put_artifact_volume(OP, &invalid).await.is_err());
    }
    store
        .put_tag("writer", "Produce evidence", vec!["files:read".into()])
        .await
        .unwrap();
    let host = support::register_host(&store, "volume-writer").await;
    let task = store
        .send_message(
            OP,
            &SendMessageRequest {
                tag_id: "writer".into(),
                conversation: "private".into(),
                text: "Evidence".into(),
                operation_id: "source".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .task
        .unwrap();
    let assignment = store.claim_task(&host, "source").await.unwrap().unwrap();
    assert_eq!(assignment.task.unwrap().task_id, task.task_id);
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
    let blob = BlobReference {
        sha256: "a".repeat(64),
        byte_length: 10,
    };
    let capture = CommitArtifactCaptureRequest {
        attempt: Some(attempt.clone()),
        operation_id: "capture".into(),
        description: Some(ArtifactDescription {
            title: "Evidence".into(),
            kind: "report".into(),
            summary: None,
        }),
        files: vec![ArtifactFile {
            path: "report.txt".into(),
            blob: Some(blob.clone()),
            ..Default::default()
        }],
        ..Default::default()
    };
    store
        .reserve_artifact_capture(&host, &capture)
        .await
        .unwrap();
    let artifact = store
        .commit_artifact_capture(&host, &capture)
        .await
        .unwrap();
    let copy = CopyArtifactToVolumeRequest {
        operation_id: "copy".into(),
        volume_id: "durable".into(),
        expected_revision: 2,
        artifact_id: artifact.summary.unwrap().artifact_id,
        path: "report.txt".into(),
        expected_blob: Some(blob.clone()),
    };
    assert!(
        store
            .reserve_artifact_volume_copy("operator:other", &copy)
            .await
            .is_err()
    );
    let mut wrong = copy.clone();
    wrong.expected_blob.as_mut().unwrap().sha256 = "b".repeat(64);
    assert!(
        store
            .reserve_artifact_volume_copy(OP, &wrong)
            .await
            .is_err()
    );
    wrong = copy.clone();
    wrong.expected_revision = 1;
    assert!(
        store
            .reserve_artifact_volume_copy(OP, &wrong)
            .await
            .is_err()
    );
    let (a, b) = tokio::join!(
        store.reserve_artifact_volume_copy(OP, &copy),
        store.reserve_artifact_volume_copy(OP, &copy)
    );
    let reserved = a.unwrap();
    assert_eq!(reserved, b.unwrap());
    assert_eq!(reserved.state(), ArtifactVolumeCopyState::Reserved);
    let changed_selection = CopyArtifactToVolumeRequest {
        path: "other.txt".into(),
        ..copy.clone()
    };
    assert!(matches!(
        store
            .reserve_artifact_volume_copy(OP, &changed_selection)
            .await,
        Err(StoreError::Conflict(_))
    ));

    assert_eq!(
        reserved.storage_key,
        format!("attempts/{}/sha256/{}", attempt.attempt_id, blob.sha256)
    );
    changed.operation_id = "blocked-retarget".into();
    changed.expected_revision = 2;
    changed.source = "file:///srv/next".into();
    assert!(matches!(
        store.put_artifact_volume(OP, &changed).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let delete = DeleteArtifactVolumeRequest {
        operation_id: "delete".into(),
        volume_id: "durable".into(),
        expected_revision: 2,
    };
    assert!(matches!(
        store.delete_artifact_volume(OP, &delete).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let commit = CommitArtifactVolumeCopyRequest {
        copy_id: reserved.copy_id.clone(),
        verified_blob: Some(blob),
    };
    let mut bad = commit.clone();
    bad.verified_blob.as_mut().unwrap().byte_length = 11;
    assert!(store.commit_artifact_volume_copy(OP, &bad).await.is_err());
    assert!(
        store
            .commit_artifact_volume_copy("operator:other", &commit)
            .await
            .is_err()
    );
    let verified = store
        .commit_artifact_volume_copy(OP, &commit)
        .await
        .unwrap();
    assert_eq!(verified.state(), ArtifactVolumeCopyState::Verified);
    assert!(verified.verified_at_ms.is_some());
    assert_eq!(
        store
            .commit_artifact_volume_copy(OP, &commit)
            .await
            .unwrap(),
        verified
    );
    assert_eq!(
        store.reserve_artifact_volume_copy(OP, &copy).await.unwrap(),
        verified
    );
    let page = store
        .list_artifact_volume_copies(
            OP,
            &ListArtifactVolumeCopiesRequest {
                volume_id: "durable".into(),
                limit: 1,
                before_order: 0,
            },
        )
        .await
        .unwrap();
    assert_eq!(page.copies, vec![verified.clone()]);
    let second = store
        .reserve_artifact_volume_copy(
            OP,
            &CopyArtifactToVolumeRequest {
                operation_id: "second-copy".into(),
                ..copy.clone()
            },
        )
        .await
        .unwrap();
    let latest = store
        .list_artifact_volume_copies(
            OP,
            &ListArtifactVolumeCopiesRequest {
                volume_id: "durable".into(),
                limit: 1,
                before_order: 0,
            },
        )
        .await
        .unwrap();
    assert_eq!(latest.copies, vec![second]);
    assert_ne!(latest.next_before_order, 0);
    let previous = store
        .list_artifact_volume_copies(
            OP,
            &ListArtifactVolumeCopiesRequest {
                volume_id: "durable".into(),
                limit: 1,
                before_order: latest.next_before_order,
            },
        )
        .await
        .unwrap();
    assert_eq!(previous.copies, vec![verified.clone()]);
    assert_eq!(previous.next_before_order, 0);

    assert!(
        store
            .list_artifact_volume_copies(
                "operator:other",
                &ListArtifactVolumeCopiesRequest::default()
            )
            .await
            .unwrap()
            .copies
            .is_empty()
    );
    drop(store);
    let store = Store::open(url).await.unwrap();
    assert_eq!(
        store.reserve_artifact_volume_copy(OP, &copy).await.unwrap(),
        verified
    );
    assert_eq!(
        store
            .get_artifact_volume_copy(
                OP,
                &GetArtifactVolumeCopyRequest {
                    copy_id: verified.copy_id.clone()
                }
            )
            .await
            .unwrap(),
        verified
    );
    assert!(store.delete_artifact_volume(OP, &delete).await.is_err());
    let unused = PutArtifactVolumeRequest {
        volume_id: "unused".into(),
        operation_id: "unused".into(),
        ..input.clone()
    };
    let old = store.put_artifact_volume(OP, &unused).await.unwrap();
    let remove = DeleteArtifactVolumeRequest {
        volume_id: "unused".into(),
        operation_id: "remove-unused".into(),
        expected_revision: old.revision,
    };
    assert!(
        store
            .delete_artifact_volume(OP, &remove)
            .await
            .unwrap()
            .deleted
    );
    assert!(
        store
            .delete_artifact_volume(OP, &remove)
            .await
            .unwrap()
            .deleted
    );
    let recreated = store
        .put_artifact_volume(
            OP,
            &PutArtifactVolumeRequest {
                operation_id: "recreate".into(),
                ..unused
            },
        )
        .await
        .unwrap();
    assert!(recreated.revision > old.revision);
}
#[tokio::test]
async fn sqlite_volume_copy_contract() {
    let temporary = tempfile::tempdir().unwrap();
    exercise(&format!(
        "sqlite://{}?mode=rwc",
        temporary.path().join("store.db").display()
    ))
    .await;
}
#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_volume_copy_contract() {
    let admin_url =
        std::fs::read_to_string(std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").unwrap())
            .unwrap();
    let database = format!("supertag_volumes_{}", Uuid::new_v4().simple());
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
