//! A Tag that names a Volume keeps its native memory there, as immutable objects: the Control
//! Plane holds only each store's head, hands it out with the turn's grant, and moves it by
//! compare-and-set, so a turn that merged onto an old head is told the current one and merges
//! again. A reset drops the heads; a turn of a Tag that keeps no memory moves nothing.
mod support;
use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OP: &str = "operator:native-volume";

/// A turn of the operator's conversation with the keeper Tag on `host`, which maps the vault.
async fn turn(
    store: &Store,
    host: &HostAuthority,
) -> (InspectAttemptRequest, Option<NativeMemoryGrant>) {
    let task = store
        .send_message(
            OP,
            &SendMessageRequest {
                tag_id: "keeper".into(),
                text: "Remember this".into(),
                operation_id: Uuid::new_v4().to_string(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .task
        .unwrap();
    let assignment = store
        .claim_task_waiting(
            host,
            &ClaimTaskRequest {
                operation_id: Uuid::new_v4().to_string(),
                harness_kind: HarnessKind::Codex.into(),
                execution_profile: Some(HarnessExecutionProfile {
                    volumes: vec![VolumeMapping {
                        volume_id: "vault".into(),
                        source: "file:///srv/vault".into(),
                    }],
                    ..Default::default()
                }),
                ..Default::default()
            },
            std::time::Duration::ZERO,
        )
        .await
        .unwrap()
        .expect("a host that maps the Volume takes the turn");
    assert_eq!(assignment.task.as_ref().unwrap().task_id, task.task_id);
    let attempt = InspectAttemptRequest {
        task_id: task.task_id,
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
    (attempt, assignment.native_memory)
}

async fn finish(store: &Store, host: &HostAuthority, attempt: &InspectAttemptRequest) {
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                result: "Done".into(),
                succeeded: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

fn manifest(tag: char) -> BlobReference {
    BlobReference {
        sha256: tag.to_string().repeat(64),
        byte_length: 40,
    }
}

fn advance(
    attempt: &InspectAttemptRequest,
    expected: u64,
    manifest: BlobReference,
    generation: u64,
    objects: &[char],
) -> AdvanceNativeMemoryRequest {
    AdvanceNativeMemoryRequest {
        attempt: Some(attempt.clone()),
        expected_revision: expected,
        manifest: Some(manifest),
        files: objects.len() as u32,
        bytes: 100,
        reset_generation: generation,
        objects: objects.iter().map(|tag| file(*tag)).collect(),
    }
}

fn file(tag: char) -> BlobReference {
    BlobReference {
        sha256: tag.to_string().repeat(64),
        byte_length: 7,
    }
}

/// The objects queued for deletion from the vault, by SHA-256.
async fn garbage(store: &Store, host: &HostAuthority) -> std::collections::BTreeSet<String> {
    store
        .list_volume_garbage(
            host,
            &ListVolumeGarbageRequest {
                volume_id: "vault".into(),
                source: "file:///srv/vault".into(),
                limit: 0,
            },
        )
        .await
        .unwrap()
        .objects
        .into_iter()
        .map(|object| object.blob.unwrap().sha256)
        .collect()
}

fn shas(tags: &[char]) -> std::collections::BTreeSet<String> {
    tags.iter().map(|tag| tag.to_string().repeat(64)).collect()
}

async fn exercise(url: &str) {
    let store = Store::open(url).await.unwrap();
    store
        .put_artifact_volume(
            OP,
            &PutArtifactVolumeRequest {
                operation_id: "register".into(),
                volume_id: "vault".into(),
                source: "file:///srv/vault".into(),
                expected_revision: 0,
            },
        )
        .await
        .unwrap();
    let spec = PutTagRequest {
        tag_id: "keeper".into(),
        instructions: "Keep the work".into(),
        harness_kind: HarnessKind::Codex.into(),
        allowed_actions: vec!["files:read".into()],
        volume: Some("vault".into()),
        ..Default::default()
    };
    store.put_tag_spec(spec.clone()).await.unwrap();
    let laptop = support::register_host(&store, "laptop").await;
    let server = support::register_host(&store, "server").await;

    // The store on the Volume starts empty: the grant names no head.
    let (first, grant) = turn(&store, &laptop).await;
    let grant = grant.expect("a Tag that keeps memory grants native memory");
    assert!(grant.volume_head.is_none());
    // A head that has files but names no objects would let them be deleted: refused.
    let mut unnamed = advance(&first, 0, manifest('a'), 0, &['1']);
    unnamed.objects.clear();
    assert!(matches!(
        store.advance_native_memory(&laptop, &unnamed).await,
        Err(StoreError::InvalidArgument(_))
    ));
    let moved = store
        .advance_native_memory(&laptop, &advance(&first, 0, manifest('a'), 0, &['1', '2']))
        .await
        .unwrap();
    assert!(moved.advanced);
    assert_eq!(moved.head.as_ref().unwrap().revision, 1);

    // A turn that merged onto the empty store after another moved it is told the head, not moved.
    let stale = store
        .advance_native_memory(&laptop, &advance(&first, 0, manifest('b'), 0, &['9']))
        .await
        .unwrap();
    assert!(!stale.advanced);
    assert_eq!(stale.head, moved.head);
    finish(&store, &laptop, &first).await;

    // The next turn, on another host that reaches the Volume, starts from the head.
    let (second, grant) = turn(&store, &server).await;
    let head = grant
        .unwrap()
        .volume_head
        .expect("the head reaches the next turn");
    assert_eq!(head.revision, 1);
    assert_eq!(head.manifest.as_ref().unwrap().sha256, manifest('a').sha256);
    let moved = store
        .advance_native_memory(&server, &advance(&second, 1, manifest('c'), 0, &['2', '3']))
        .await
        .unwrap();
    assert!(moved.advanced);
    assert_eq!(moved.head.as_ref().unwrap().revision, 2);

    // The store no longer names the first manifest or file 1: both go to Volume garbage; file 2,
    // which it still names, stays. A stale turn's objects were never named, so nothing queues them.
    assert_eq!(garbage(&store, &server).await, shas(&['a', '1']));
    // An object a later head names again leaves the queue.
    let again = store
        .advance_native_memory(&server, &advance(&second, 2, manifest('d'), 0, &['1', '3']))
        .await
        .unwrap();
    assert!(again.advanced);
    assert_eq!(garbage(&store, &server).await, shas(&['a', 'c', '2']));

    // The Tag's records list the store on the Volume, with no holding host.
    let stores = store.native_memory_stores(OP, "keeper").await.unwrap();
    let on_volume = stores
        .iter()
        .find(|store| store.volume_id == "vault")
        .expect("the Volume store is listed");
    assert_eq!(on_volume.host_id, "");
    assert_eq!(on_volume.revision, 3);
    assert_eq!(on_volume.digest, manifest('d').sha256);
    assert_eq!(on_volume.audience.as_deref(), Some(OP));
    assert!(
        store
            .native_memory_stores("operator:someone-else", "keeper")
            .await
            .unwrap()
            .is_empty(),
        "another person never sees a private store"
    );

    // A reset drops the head; a turn granted before it moves nothing.
    let reset = store
        .reset_native_memory(
            OP,
            &ResetNativeMemoryRequest {
                tag_id: "keeper".into(),
            },
        )
        .await
        .unwrap();
    assert!(reset.stores.iter().any(|store| store.volume_id == "vault"));
    // A reset sends every object the store named to Volume garbage.
    assert_eq!(
        garbage(&store, &server).await,
        shas(&['a', 'c', '2', 'd', '1', '3'])
    );
    assert!(matches!(
        store
            .advance_native_memory(&server, &advance(&second, 3, manifest('f'), 0, &['3']))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    finish(&store, &server, &second).await;
    let (third, grant) = turn(&store, &laptop).await;
    let grant = grant.unwrap();
    assert!(grant.volume_head.is_none());
    assert_eq!(grant.reset_generation, 1);
    finish(&store, &laptop, &third).await;

    // A Tag that keeps no memory moves no head.
    store
        .put_tag_spec(PutTagRequest {
            memory: Some(false),
            ..spec
        })
        .await
        .unwrap();
    let (off, grant) = turn(&store, &laptop).await;
    assert!(grant.is_none());
    assert!(matches!(
        store
            .advance_native_memory(&laptop, &advance(&off, 0, manifest('e'), 1, &[]))
            .await,
        Err(StoreError::PermissionDenied)
    ));
    store.close().await;
}

fn write(attempt: &InspectAttemptRequest, blob: BlobReference) -> VolumeObjectGrantRequest {
    VolumeObjectGrantRequest {
        attempt: Some(attempt.clone()),
        purpose: VolumeObjectPurpose::NativeMemoryBlob.into(),
        access: VolumeAccess::Write.into(),
        native_memory_blob: Some(blob),
        ..Default::default()
    }
}

/// Ages every pending native memory object by `hours`, as if its grant were that long ago.
async fn age_pending(url: &str, hours: i64) {
    sqlx::any::install_default_drivers();
    let mut connection = sqlx::AnyConnection::connect(url).await.unwrap();
    sqlx::query(&format!(
        "UPDATE supertag_v2_native_memory_pending_objects SET granted_at_ms=granted_at_ms-{}",
        hours * 60 * 60 * 1000
    ))
    .execute(&mut connection)
    .await
    .unwrap();
    connection.close().await.unwrap();
}

/// Objects a host wrote that no store names, such as those of a turn that lost the race for the
/// head or ended before moving it, go to Volume garbage once that turn is over and an hour has
/// passed since their grant; writing the same bytes again takes them back out.
async fn orphans(url: &str) {
    let store = Store::open(url).await.unwrap();
    store
        .put_artifact_volume(
            OP,
            &PutArtifactVolumeRequest {
                operation_id: "register".into(),
                volume_id: "vault".into(),
                source: "file:///srv/vault".into(),
                expected_revision: 0,
            },
        )
        .await
        .unwrap();
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "keeper".into(),
            instructions: "Keep the work".into(),
            harness_kind: HarnessKind::Codex.into(),
            allowed_actions: vec!["files:read".into()],
            volume: Some("vault".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let host = support::register_host(&store, "laptop").await;

    // The turn writes two files but moves the head naming only one.
    let (first, _) = turn(&store, &host).await;
    for tag in ['7', '8'] {
        store
            .grant_volume_object(&host, &write(&first, file(tag)))
            .await
            .unwrap();
    }
    let moved = store
        .advance_native_memory(&host, &advance(&first, 0, manifest('9'), 0, &['8']))
        .await
        .unwrap();
    assert!(moved.advanced);
    // Nothing goes within the hour after the grant, or while the turn may still move the head.
    assert_eq!(store.sweep_native_memory_objects().await.unwrap(), 0);
    age_pending(url, 2).await;
    assert_eq!(store.sweep_native_memory_objects().await.unwrap(), 0);
    assert!(garbage(&store, &host).await.is_empty());
    finish(&store, &host, &first).await;
    assert_eq!(store.sweep_native_memory_objects().await.unwrap(), 1);
    assert_eq!(garbage(&store, &host).await, shas(&['7']));
    assert_eq!(store.sweep_native_memory_objects().await.unwrap(), 0);

    // A later turn that writes the same bytes takes them out of the queue; they stay until that
    // turn is over and an hour has passed again.
    let (second, _) = turn(&store, &host).await;
    store
        .grant_volume_object(&host, &write(&second, file('7')))
        .await
        .unwrap();
    assert!(garbage(&store, &host).await.is_empty());
    finish(&store, &host, &second).await;
    assert_eq!(store.sweep_native_memory_objects().await.unwrap(), 0);
    age_pending(url, 2).await;
    assert_eq!(store.sweep_native_memory_objects().await.unwrap(), 1);
    assert_eq!(garbage(&store, &host).await, shas(&['7']));

    // Deleting the Volume sends everything still on it to garbage: the store's head manifest and
    // the file it names, and an object a turn wrote that no store names yet. The store is gone.
    let (third, _) = turn(&store, &host).await;
    store
        .grant_volume_object(&host, &write(&third, file('6')))
        .await
        .unwrap();
    finish(&store, &host, &third).await;
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "keeper".into(),
            instructions: "Keep the work".into(),
            harness_kind: HarnessKind::Codex.into(),
            allowed_actions: vec!["files:read".into()],
            volume: Some(String::new()),
            ..Default::default()
        })
        .await
        .unwrap();
    store
        .delete_artifact_volume(
            OP,
            &DeleteArtifactVolumeRequest {
                operation_id: "delete".into(),
                volume_id: "vault".into(),
                expected_revision: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(garbage(&store, &host).await, shas(&['6', '7', '8', '9']));
    assert!(
        store
            .native_memory_stores(OP, "keeper")
            .await
            .unwrap()
            .iter()
            .all(|store| store.volume_id.is_empty())
    );
    store.close().await;
}

#[tokio::test]
async fn sqlite_native_memory_orphans_contract() {
    let dir = tempfile::tempdir().unwrap();
    orphans(&format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("native-orphans.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_native_memory_orphans_contract() {
    let path =
        std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("test database file");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let database = format!("supertag_native_orphans_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&database);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { orphans(url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await
        .unwrap();
    result.unwrap();
}

#[tokio::test]
async fn sqlite_native_memory_volume_contract() {
    let dir = tempfile::tempdir().unwrap();
    exercise(&format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("native-volume.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_native_memory_volume_contract() {
    let path =
        std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("test database file");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let database = format!("supertag_native_volume_{}", Uuid::new_v4().simple());
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
