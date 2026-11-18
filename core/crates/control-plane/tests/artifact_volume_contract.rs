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
    // Captures keep copies on a Tag's Volume (capture_volume_contract); the Control Plane copies
    // nothing into a Volume itself.
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
        dry_run: false,
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
