//! A Tag that names a Volume keeps its Session checkpoints there, not on the Worker Host that ran
//! the turn: once the writing host's grant marks the checkpoint as on the Volume, it has no holder,
//! so any host that reaches the Volume resumes it and none is waited for. Native memory objects
//! get Volume grants, content-addressed in the store the turn was granted.
mod support;
use sha2::Digest;
use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OP: &str = "operator:volume-checkpoints";

/// Sends the keeper Tag a message in the operator's conversation and runs it on `host`, which
/// maps the vault Volume.
async fn turn(store: &Store, host: &HostAuthority, text: &str) -> InspectAttemptRequest {
    let task = store
        .send_message(
            OP,
            &SendMessageRequest {
                tag_id: "keeper".into(),
                text: text.into(),
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
        .expect("a host that maps the Volume takes the turn at once");
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
    attempt
}

fn grant(attempt: &InspectAttemptRequest, access: VolumeAccess) -> VolumeObjectGrantRequest {
    VolumeObjectGrantRequest {
        attempt: Some(attempt.clone()),
        purpose: VolumeObjectPurpose::SessionCheckpoint.into(),
        access: access.into(),
        native_memory_blob: None,
        ..Default::default()
    }
}

async fn finish(
    store: &Store,
    host: &HostAuthority,
    attempt: &InspectAttemptRequest,
    checkpoint: Option<&CheckpointReference>,
) {
    if let Some(reference) = checkpoint {
        let request = CommitCheckpointRequest {
            attempt: Some(attempt.clone()),
            reference: Some(reference.clone()),
        };
        store.reserve_checkpoint(host, &request).await.unwrap();
        // The host writes the reserved checkpoint to the Volume under its grant.
        let written = store
            .grant_volume_object(host, &grant(attempt, VolumeAccess::Write))
            .await
            .unwrap();
        assert_eq!(written.blob.as_ref().unwrap().sha256, reference.sha256);
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
                checkpoint_sha256: checkpoint.map(|reference| reference.sha256.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
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
    let laptop = support::register_host(&store, "laptop").await;
    let server = support::register_host(&store, "server").await;

    // The laptop writes the turn's checkpoint to the Volume, and the row names the Volume, not
    // the laptop.
    let first = turn(&store, &laptop, "Start the change").await;
    let checkpoint = CheckpointReference {
        harness: "codex".into(),
        format: "codex-session-v1".into(),
        byte_length: 17,
        sha256: format!("{:x}", sha2::Sha256::digest(b"laptop transcript")),
    };
    finish(&store, &laptop, &first, Some(&checkpoint)).await;
    assert!(
        store
            .list_held_checkpoints(&laptop, &ListHeldCheckpointsRequest::default())
            .await
            .unwrap()
            .sha256
            .is_empty(),
        "a Volume-held checkpoint is no host's to delete"
    );

    // Another host takes the next turn at once, with no wait for the laptop, and resumes from the
    // Volume.
    let second = turn(&store, &server, "Continue the change").await;
    let resumed = store.get_checkpoint(&server, &second).await.unwrap();
    assert_eq!(resumed.reference.as_ref(), Some(&checkpoint));
    assert_eq!(resumed.volume_id, "vault");
    assert_eq!(resumed.holder_host_id, "");
    let read = store
        .grant_volume_object(&server, &grant(&second, VolumeAccess::Read))
        .await
        .unwrap();
    assert_eq!(read.blob.as_ref().unwrap().sha256, checkpoint.sha256);
    let task = store.get_task(&second.task_id).await.unwrap();
    assert_eq!(
        read.key,
        format!(
            "tags/{:x}/sessions/{:x}/checkpoint/{}.bin",
            sha2::Sha256::digest("keeper"),
            sha2::Sha256::digest(task.session_id.as_bytes()),
            checkpoint.sha256
        )
    );

    // Native memory: one immutable object of the store this turn was granted, keyed by its own
    // SHA-256 under the store the Control Plane derives from the turn.
    let memory = |sha256: &str| VolumeObjectGrantRequest {
        attempt: Some(second.clone()),
        purpose: VolumeObjectPurpose::NativeMemoryBlob.into(),
        access: VolumeAccess::Write.into(),
        native_memory_blob: Some(BlobReference {
            sha256: sha256.into(),
            byte_length: 12,
        }),
        ..Default::default()
    };
    let object = store
        .grant_volume_object(&server, &memory(&"d".repeat(64)))
        .await
        .unwrap();
    let root = format!(
        "tags/{:x}/native-memory/codex/",
        sha2::Sha256::digest("keeper")
    );
    assert!(
        object.key.starts_with(&root)
            && object
                .key
                .ends_with(&format!("/objects/{}", "d".repeat(64))),
        "{}",
        object.key
    );
    // The object must fit Volume key rules: at most 8 segments, ending in its own digest.
    assert!(object.key.split('/').count() <= 8, "{}", object.key);
    assert!(matches!(
        store
            .grant_volume_object(&server, &memory("not-a-digest"))
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    finish(&store, &server, &second, None).await;

    // A Tag that keeps no memory gets no native memory grant.
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "keeper".into(),
            instructions: "Keep the work".into(),
            harness_kind: HarnessKind::Codex.into(),
            allowed_actions: vec!["files:read".into()],
            volume: Some("vault".into()),
            memory: Some(false),
            ..Default::default()
        })
        .await
        .unwrap();
    let third = turn(&store, &server, "No memory now").await;
    let refused = VolumeObjectGrantRequest {
        attempt: Some(third.clone()),
        ..memory(&"d".repeat(64))
    };
    assert!(matches!(
        store.grant_volume_object(&server, &refused).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    finish(&store, &server, &third, None).await;
    store.close().await;
}

#[tokio::test]
async fn sqlite_volume_checkpoint_contract() {
    let dir = tempfile::tempdir().unwrap();
    exercise(&format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("volume-checkpoints.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_volume_checkpoint_contract() {
    let path =
        std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("test database file");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let database = format!("supertag_volume_checkpoints_{}", Uuid::new_v4().simple());
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
