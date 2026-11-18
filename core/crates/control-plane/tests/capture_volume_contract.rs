//! A Tag that names an artifact Volume keeps a copy of every capture there: the capture's
//! reservation reserves one copy per file, and its commit records them Verified.
mod support;
use sha2::Digest;
use sqlx::{Connection, Executor};
use supertag_control_plane::{ControlPlane, Store, StoreError};
use supertag_protocol::{
    authenticated_request,
    v2::{artifact_directory_server::ArtifactDirectory, *},
};
use uuid::Uuid;

const OP: &str = "operator:capture-owner";

fn volume(id: &str, operation: &str, revision: u64) -> PutArtifactVolumeRequest {
    PutArtifactVolumeRequest {
        operation_id: operation.into(),
        volume_id: id.into(),
        source: format!("file:///srv/{id}"),
        expected_revision: revision,
    }
}

fn tag(volume: Option<&str>) -> PutTagRequest {
    PutTagRequest {
        tag_id: "keeper".into(),
        instructions: "Keep evidence".into(),
        allowed_actions: vec!["files:read".into()],
        volume: volume.map(str::to_owned),
        ..Default::default()
    }
}

/// Starts one Attempt of the keeper Tag and returns what a capture names it by.
async fn attempt(
    store: &Store,
    host: &supertag_control_plane::HostAuthority,
    operation: &str,
) -> InspectAttemptRequest {
    let task = store
        .send_message(
            OP,
            &SendMessageRequest {
                tag_id: "keeper".into(),
                text: format!("Capture {operation}"),
                operation_id: operation.into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .task
        .unwrap();
    // A Tag that keeps its captures on a file Volume is placed only on a host that maps it.
    assert!(
        store
            .claim_task(host, &format!("{operation}-plain"))
            .await
            .unwrap()
            .is_none()
    );
    let placement = store.diagnose_task_placement(&task.task_id).await.unwrap();
    assert!(
        placement
            .required_labels
            .contains(&"volume:vault".to_owned()),
        "{placement:?}"
    );
    let assignment = store
        .claim_task_waiting(
            host,
            &ClaimTaskRequest {
                operation_id: operation.into(),
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
        .unwrap();
    let attempt = InspectAttemptRequest {
        task_id: task.task_id.clone(),
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    };
    store
        .start_task(
            host,
            &StartTaskRequest {
                task_id: task.task_id,
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    attempt
}

fn capture(
    attempt: &InspectAttemptRequest,
    operation: &str,
    digit: char,
) -> CommitArtifactCaptureRequest {
    CommitArtifactCaptureRequest {
        source_storage_id: Some(support::ARTIFACT_STORAGE.into()),
        attempt: Some(attempt.clone()),
        operation_id: operation.into(),
        description: Some(ArtifactDescription {
            title: "Evidence".into(),
            kind: "report".into(),
            summary: None,
        }),
        files: ["a.txt", "b.txt"]
            .iter()
            .enumerate()
            .map(|(index, path)| ArtifactFile {
                path: (*path).into(),
                blob: Some(BlobReference {
                    sha256: format!("{digit}{index}").repeat(32),
                    byte_length: 10 + index as u64,
                }),
                ..Default::default()
            })
            .collect(),
        ..Default::default()
    }
}

async fn located(
    plane: &ControlPlane,
    artifact_id: &str,
    path: &str,
) -> Vec<ArtifactVolumeLocation> {
    plane
        .locate_copies(
            authenticated_request(
                LocateArtifactCopiesRequest {
                    target: Some(locate_artifact_copies_request::Target::Operator(
                        DownloadArtifactFileRequest {
                            artifact_id: artifact_id.into(),
                            path: path.into(),
                        },
                    )),
                    volume_ids: vec!["vault".into()],
                },
                "private-key",
                Some(OP),
            )
            .unwrap(),
        )
        .await
        .unwrap()
        .into_inner()
        .locations
}

async fn exercise(url: &str) {
    let store = Store::open(url).await.unwrap();
    // A Tag may name only a registered Volume.
    assert!(matches!(
        store.put_tag_spec(tag(Some("vault"))).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let vault = store
        .put_artifact_volume(OP, &volume("vault", "register", 0))
        .await
        .unwrap();
    let keeper = store.put_tag_spec(tag(Some("vault"))).await.unwrap();
    assert_eq!(keeper.volume, "vault");
    // Omitted keeps the Volume.
    assert_eq!(store.put_tag_spec(tag(None)).await.unwrap().volume, "vault");
    assert_eq!(store.get_tag("keeper").await.unwrap().volume, "vault");

    let host = support::register_host(&store, "capture-writer").await;
    support::hold_artifacts(&store, &host).await;
    let first = attempt(&store, &host, "first").await;
    let request = capture(&first, "capture", 'a');
    let reserved = store
        .reserve_artifact_capture(&host, &request)
        .await
        .unwrap();
    let artifact_id = reserved.summary.as_ref().unwrap().artifact_id.clone();
    assert_eq!(reserved.volume_copies.len(), 2);
    for (copy, file) in reserved.volume_copies.iter().zip(&reserved.files) {
        assert_eq!(copy.state(), ArtifactVolumeCopyState::Reserved);
        assert_eq!(copy.volume.as_ref(), Some(&vault));
        assert_eq!(copy.file.as_ref(), Some(file));
        assert_eq!(
            copy.storage_key,
            format!(
                "tags/{:x}/attempts/{}/sha256/{}",
                sha2::Sha256::digest("keeper"),
                first.attempt_id,
                file.blob.as_ref().unwrap().sha256
            )
        );
    }
    // A retried reservation returns the same copies.
    assert_eq!(
        store
            .reserve_artifact_capture(&host, &request)
            .await
            .unwrap(),
        reserved
    );
    let plane = ControlPlane::open(url, "private-key".into(), "operator:local".into())
        .await
        .unwrap();
    let committed = store
        .commit_artifact_capture(&host, &request)
        .await
        .unwrap();
    assert_eq!(committed.volume_copies.len(), 2);
    assert!(committed.volume_copies.iter().all(|copy| {
        copy.state() == ArtifactVolumeCopyState::Verified && copy.verified_at_ms.is_some()
    }));
    // Readers find the Verified copy, so the bytes outlive the capturing host.
    for file in ["a.txt", "b.txt"] {
        let locations = located(&plane, &artifact_id, file).await;
        assert_eq!(locations.len(), 1, "{file}");
        assert_eq!(locations[0].volume.as_ref(), Some(&vault));
    }
    // A repeated commit returns the copies as they are.
    assert_eq!(
        store
            .commit_artifact_capture(&host, &request)
            .await
            .unwrap(),
        committed
    );
    // Operators who see the capture see its copies.
    let listed = store
        .list_artifact_volume_copies(
            OP,
            &ListArtifactVolumeCopiesRequest {
                volume_id: "vault".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(listed.copies.len(), 2);
    // The Control Plane maps no file Volume: the capturing host's own check stands for it.
    assert!(listed.copies.iter().all(|copy| copy.host_attested));

    // The Volume cannot be moved while a Tag names it, even with a capture in flight.
    let changed = capture(&first, "changed", 'c');
    store
        .reserve_artifact_capture(&host, &changed)
        .await
        .unwrap();
    assert!(matches!(
        store
            .put_artifact_volume(
                OP,
                &PutArtifactVolumeRequest {
                    source: "file:///srv/vault-moved".into(),
                    ..volume("vault", "move", vault.revision)
                },
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert_eq!(
        store
            .commit_artifact_capture(&host, &changed)
            .await
            .unwrap()
            .volume_copies
            .len(),
        2
    );

    // The Volume cannot be deleted while a Tag names it, and a Tag without one copies nothing.
    let delete = DeleteArtifactVolumeRequest {
        operation_id: "delete".into(),
        volume_id: "vault".into(),
        expected_revision: vault.revision,
        ..Default::default()
    };
    match store.delete_artifact_volume(OP, &delete).await {
        Err(StoreError::FailedPrecondition(message)) => {
            assert!(message.contains("a Tag keeps its work"), "{message}")
        }
        other => panic!("deleted a Volume a Tag names: {other:?}"),
    }
    assert_eq!(store.put_tag_spec(tag(Some(""))).await.unwrap().volume, "");
    // A Volume grant names the object from the Attempt's own Tag, Session and checkpoint rows; the
    // host never names a digest.
    let grant_request =
        |attempt: &InspectAttemptRequest, access: VolumeAccess| VolumeObjectGrantRequest {
            attempt: Some(attempt.clone()),
            purpose: VolumeObjectPurpose::SessionCheckpoint as i32,
            access: access as i32,
        };
    let write = grant_request(&first, VolumeAccess::Write);
    let checkpoint = CheckpointReference {
        harness: "codex".into(),
        format: "codex-session-v1".into(),
        byte_length: 1024,
        sha256: "f".repeat(64),
    };
    let reserve = CommitCheckpointRequest {
        attempt: Some(first.clone()),
        reference: Some(checkpoint.clone()),
    };
    // Without a Volume there is nothing to grant.
    assert!(matches!(
        store.grant_volume_object(&host, &write).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    store.put_tag_spec(tag(Some("vault"))).await.unwrap();
    // A write grant follows the checkpoint's reservation.
    assert!(matches!(
        store.grant_volume_object(&host, &write).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    // Before the Session points at a checkpoint, a read finds none: the turn starts fresh.
    assert!(matches!(
        store
            .grant_volume_object(&host, &grant_request(&first, VolumeAccess::Read))
            .await,
        Err(StoreError::NotFound(_))
    ));
    store.reserve_checkpoint(&host, &reserve).await.unwrap();
    let grant = store.grant_volume_object(&host, &write).await.unwrap();
    let task = store.get_task(&first.task_id).await.unwrap();
    let key = format!(
        "tags/{:x}/sessions/{:x}/checkpoint/{}.bin",
        sha2::Sha256::digest("keeper"),
        sha2::Sha256::digest(task.session_id.as_bytes()),
        checkpoint.sha256
    );
    assert_eq!(grant.key, key);
    let blob = BlobReference {
        sha256: checkpoint.sha256.clone(),
        byte_length: checkpoint.byte_length,
    };
    assert_eq!(grant.blob.as_ref(), Some(&blob));
    assert_eq!(
        grant.volume.as_ref().map(|v| v.volume_id.as_str()),
        Some("vault")
    );
    // Another host gets no grant, nor does a request without a purpose.
    let other = support::register_host(&store, "someone-else").await;
    assert!(store.grant_volume_object(&other, &write).await.is_err());
    assert!(
        store
            .grant_volume_object(
                &host,
                &VolumeObjectGrantRequest {
                    purpose: 0,
                    ..write.clone()
                }
            )
            .await
            .is_err()
    );
    store.commit_checkpoint(&host, &reserve).await.unwrap();
    store
        .finish_task(
            &host,
            &FinishTaskRequest {
                task_id: first.task_id.clone(),
                attempt_id: first.attempt_id.clone(),
                lease_token: first.lease_token.clone(),
                result: "Kept".into(),
                succeeded: true,
                objective_signal: ObjectiveSignal::Progress.into(),
                checkpoint_sha256: Some(checkpoint.sha256.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    // The Session's next turn reads the checkpoint back from the Volume.
    let next = attempt(&store, &host, "next").await;
    assert_eq!(
        store.get_task(&next.task_id).await.unwrap().session_id,
        task.session_id
    );
    let read = store
        .grant_volume_object(&host, &grant_request(&next, VolumeAccess::Read))
        .await
        .unwrap();
    assert_eq!(
        (read.key.as_str(), read.blob.as_ref()),
        (key.as_str(), Some(&blob))
    );
    store.put_tag_spec(tag(Some(""))).await.unwrap();
    let plain = capture(&next, "plain", 'e');
    assert!(
        store
            .reserve_artifact_capture(&host, &plain)
            .await
            .unwrap()
            .volume_copies
            .is_empty()
    );
    assert!(
        store
            .commit_artifact_capture(&host, &plain)
            .await
            .unwrap()
            .volume_copies
            .is_empty()
    );
}

#[tokio::test]
async fn sqlite_capture_volume_contract() {
    let temporary = tempfile::tempdir().unwrap();
    exercise(&format!(
        "sqlite://{}?mode=rwc",
        temporary.path().join("store.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_capture_volume_contract() {
    let admin_url =
        std::fs::read_to_string(std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").unwrap())
            .unwrap();
    let database = format!("supertag_capture_volumes_{}", Uuid::new_v4().simple());
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
