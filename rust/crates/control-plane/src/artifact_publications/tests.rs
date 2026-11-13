use super::*;
use sqlx::{Connection, Executor};
use uuid::Uuid;
async fn exercise(url: &str) {
    let store = Store::open(url).await.unwrap();
    store
        .put_tag("owner", "Work", vec!["files:read".into()])
        .await
        .unwrap();
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "consumer".into(),
            instructions: "Work".into(),
            allowed_actions: vec!["files:read".into()],
            harness_kind: HarnessKind::OpenaiAgents as i32,
            workspace: Some(WorkspaceSpec {
                workspace_id: "repo".into(),
                base_commit: "1".repeat(40),
                ..Default::default()
            }),
            ..Default::default()
        })
        .await
        .unwrap();
    let source = store
        .create_objective(
            "operator:owner",
            &CreateObjectiveRequest {
                operation_id: "source".into(),
                objective_id: "source".into(),
                owner_tag_id: "owner".into(),
                outcome: "Produce evidence".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let destination = store
        .create_objective(
            "operator:owner",
            &CreateObjectiveRequest {
                operation_id: "destination".into(),
                objective_id: "destination".into(),
                owner_tag_id: "consumer".into(),
                outcome: "Consume evidence".into(),
                ongoing: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store.seed_host("host", &[1; 32]).await.unwrap();
    let registration = store.register_host("host", "process").await.unwrap();
    let host = crate::HostAuthority::new("host:host", registration.generation).unwrap();
    let storage = RegisterArtifactSourceRequest {
        storage_id: Uuid::new_v4().to_string(),
    };
    store
        .register_artifact_source(&host, &storage)
        .await
        .unwrap();
    let assignment = store.claim_task(&host, "claim").await.unwrap().unwrap();
    assert_eq!(assignment.task.unwrap().task_id, source.starting_task_id);
    let attempt = InspectAttemptRequest {
        task_id: source.starting_task_id.clone(),
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
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
    let request = CommitArtifactCaptureRequest {
        attempt: Some(attempt.clone()),
        operation_id: "capture".into(),
        description: Some(ArtifactDescription {
            title: "Evidence".into(),
            kind: "report".into(),
            summary: None,
        }),
        files: vec![
            ArtifactFile {
                path: "selected.txt".into(),
                blob: Some(BlobReference {
                    sha256: "a".repeat(64),
                    byte_length: 10,
                }),
                ..Default::default()
            },
            ArtifactFile {
                path: "not-submitted.txt".into(),
                blob: Some(BlobReference {
                    sha256: "b".repeat(64),
                    byte_length: 12,
                }),
                ..Default::default()
            },
        ],
        source_storage_id: Some(storage.storage_id),
        ..Default::default()
    };
    store
        .reserve_artifact_capture(&host, &request)
        .await
        .unwrap();
    let artifact = store
        .commit_artifact_capture(&host, &request)
        .await
        .unwrap()
        .summary
        .unwrap()
        .artifact_id;
    let selected = vec!["selected.txt".into()];
    store
        .finish_task(
            &host,
            &FinishTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
                succeeded: true,
                result: "Ready".into(),
                objective_signal: ObjectiveSignal::ReadyForReview as i32,
                artifacts: vec![ArtifactSelection {
                    artifact_id: artifact.clone(),
                    paths: selected.clone(),
                }],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let (mut tx, _) = store.write().await.unwrap();
    assert!(!accepted_in(&mut tx, &artifact, &selected).await.unwrap());
    tx.commit().await.unwrap();
    let reviewed = store
        .review_objective(
            "operator:owner",
            &ReviewObjectiveRequest {
                objective_id: "source".into(),
                operation_id: "review".into(),
                approved: true,
                feedback: "Accepted exact submitted evidence".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(reviewed.status, ObjectiveStatus::Completed as i32);
    let (mut tx, _) = store.write().await.unwrap();
    assert!(accepted_in(&mut tx, &artifact, &selected).await.unwrap());
    assert!(
        !accepted_in(&mut tx, &artifact, &["not-submitted.txt".into()])
            .await
            .unwrap()
    );
    tx.commit().await.unwrap();
    let publication = store
        .publish_artifact(
            "operator:owner",
            &PublishArtifactRequest {
                publication_id: "publication".into(),
                artifact_id: artifact.clone(),
                paths: selected.clone(),
                audience_objective_ids: vec!["destination".into()],
                supersedes_publication_id: None,
            },
        )
        .await
        .unwrap();
    let (mut tx, _) = store.write().await.unwrap();
    assert!(
        resolve_selection_in(&mut tx, "destination", "publication", &artifact, &selected)
            .await
            .is_err()
    );
    tx.commit().await.unwrap();
    store
        .consume_artifact_publication(
            "operator:owner",
            &ConsumeArtifactPublicationRequest {
                consumption_id: "consent".into(),
                publication_id: "publication".into(),
                objective_id: "destination".into(),
            },
        )
        .await
        .unwrap();
    store
        .cancel_task(&destination.starting_task_id)
        .await
        .unwrap();
    let admission = SubmitTaskRequest {
        tag_id: "consumer".into(),
        session_id: destination.session_id.clone(),
        operation_id: "consume-input".into(),
        prompt: "Use only the selected publication".into(),
        input_artifacts: vec![TaskArtifactInputSelection {
            artifact_id: artifact.clone(),
            paths: selected.clone(),
            require_accepted: false,
            publication_approval_id: Some("publication".into()),
        }],
        ..Default::default()
    };
    let mut unapproved = admission.clone();
    unapproved.input_artifacts[0].publication_approval_id = None;
    assert!(
        store
            .submit_task("operator:owner", &unapproved)
            .await
            .is_err()
    );
    let admitted = store
        .submit_task("operator:owner", &admission)
        .await
        .unwrap();
    assert_eq!(
        admitted.input_artifacts[0].source_attempt_id,
        attempt.attempt_id
    );
    assert_eq!(
        admitted.input_artifacts[0]
            .publication
            .as_ref()
            .unwrap()
            .consumption_id,
        "consent"
    );
    let live = store
        .claim_task_with_profile(
            &host,
            "consume-input",
            &["repo".into()],
            HarnessKind::OpenaiAgents,
            &[],
            Some(&HarnessExecutionProfile {
                task_artifact_inputs: true,
                ..Default::default()
            }),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(live.task.unwrap().task_id, admitted.task_id);
    let live = InspectAttemptRequest {
        task_id: admitted.task_id.clone(),
        attempt_id: live.attempt_id,
        lease_token: live.lease_token,
    };
    store
        .start_task(
            &host,
            &StartTaskRequest {
                task_id: live.task_id.clone(),
                attempt_id: live.attempt_id.clone(),
                lease_token: live.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    let acquired = store
        .acquire_artifact(
            &host,
            &AcquireArtifactRequest {
                attempt: Some(live.clone()),
                operation_id: "read-publication".into(),
                artifact_id: artifact.clone(),
                paths: selected.clone(),
                delivery: ArtifactDelivery::Read as i32,
                destination: None,
            },
        )
        .await
        .unwrap();
    let download = GetAcquiredArtifactFileRequest {
        attempt: Some(live.clone()),
        acquisition_id: acquired.acquisition_id.clone(),
        path: "selected.txt".into(),
    };
    assert_eq!(
        store
            .get_acquired_artifact_file(&host, &download)
            .await
            .unwrap(),
        publication.files[0]
    );
    let grant = store
        .issue_artifact_transfer(&host, &download)
        .await
        .unwrap();
    let redeem = AuthorizeArtifactTransferRequest {
        token: grant.token,
        file: Some(WorkerArtifactDownloadRequest {
            artifact_id: artifact.clone(),
            path: download.path.clone(),
            blob: publication.files[0].blob.clone(),
        }),
    };
    assert!(
        store
            .authorize_artifact_transfer(&host, &redeem)
            .await
            .is_ok()
    );
    let (mut tx, _) = store.write().await.unwrap();
    let (snapshot, pin) =
        resolve_selection_in(&mut tx, "destination", "publication", &artifact, &selected)
            .await
            .unwrap();
    assert_eq!(snapshot.files, publication.files);
    assert!(snapshot.inputs.is_empty());
    assert_eq!(
        snapshot.summary.unwrap().producer.unwrap().attempt_id,
        attempt.attempt_id
    );
    validate_pin_in(&mut tx, &pin).await.unwrap();
    for (objective, id, paths) in [
        ("source", artifact.as_str(), selected.clone()),
        ("destination", "foreign", selected.clone()),
        (
            "destination",
            artifact.as_str(),
            vec!["not-submitted.txt".into()],
        ),
    ] {
        assert!(
            resolve_selection_in(&mut tx, objective, "publication", id, &paths)
                .await
                .is_err()
        );
    }
    tx.commit().await.unwrap();
    store.close().await;
    let store = Store::open(url).await.unwrap();
    let (mut tx, _) = store.write().await.unwrap();
    validate_pin_in(&mut tx, &pin).await.unwrap();
    assert!(accepted_in(&mut tx, &artifact, &selected).await.unwrap());
    tx.commit().await.unwrap();
    store
        .withdraw_artifact_consumption(
            "operator:owner",
            &WithdrawArtifactApprovalRequest {
                approval_id: "consent".into(),
                expected_revision: 1,
            },
        )
        .await
        .unwrap();
    assert!(
        store
            .authorize_artifact_transfer(&host, &redeem)
            .await
            .is_err()
    );
    assert!(
        store
            .issue_artifact_transfer(&host, &download)
            .await
            .is_err()
    );
    let (mut tx, _) = store.write().await.unwrap();
    assert!(validate_pin_in(&mut tx, &pin).await.is_err());
    assert!(
        resolve_selection_in(&mut tx, "destination", "publication", &artifact, &selected)
            .await
            .is_err()
    );
    tx.commit().await.unwrap();
    assert!(
        store
            .get_acquired_artifact_file(&host, &download)
            .await
            .is_err()
    );
    assert!(
        store
            .inspect_attempt_artifact(
                &host,
                &InspectAttemptArtifactRequest {
                    attempt: Some(live),
                    artifact_id: artifact.clone()
                }
            )
            .await
            .is_err()
    );
    let replay = store
        .submit_task("operator:owner", &admission)
        .await
        .unwrap();
    assert_eq!(replay.input_artifacts, admitted.input_artifacts);
    let mut later = admission;
    later.operation_id = "later".into();
    assert!(store.submit_task("operator:owner", &later).await.is_err());
    assert_eq!(pin.consumption_revision, 1);
    store.close().await;
}
#[tokio::test]
async fn sqlite_review_and_consumption_fence() {
    let temp = tempfile::tempdir().unwrap();
    Box::pin(exercise(&format!(
        "sqlite://{}?mode=rwc",
        temp.path().join("store.db").display()
    )))
    .await;
}
#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_review_and_consumption_fence() {
    let admin_url =
        std::fs::read_to_string(std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").unwrap())
            .unwrap();
    let database = format!("supertag_publication_pins_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&database);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { Box::pin(exercise(url.as_str())).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await
        .unwrap();
    result.unwrap();
}
