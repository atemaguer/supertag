//! Workspace Volume catalog, Tag configuration, Task admission pins, Host
//! placement and Attempt preflight on SQLite and PostgreSQL.
mod support;

use sqlx::{Connection, Executor};
use supertag_control_plane::{HostAuthority, Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OPERATOR: &str = "operator:mounts";
const BASE: &str = "1111111111111111111111111111111111111111";
const DATA: &str = "file:///srv/supertag/data";
const RETARGETED: &str = "file:///srv/supertag/data-next";
const ARTIFACTS: &str = "file:///srv/supertag/artifacts";
const ROOT: &str = "/srv/supertag/mounts";

fn mount(destination: &str) -> WorkspaceCopyMount {
    WorkspaceCopyMount {
        volume_id: "data".into(),
        destination: destination.into(),
        max_bytes: 1024 * 1024,
        volume: None,
        read_write: false,
    }
}

fn writable(destination: &str) -> WorkspaceCopyMount {
    WorkspaceCopyMount {
        read_write: true,
        ..mount(destination)
    }
}

fn written(destination: &str) -> WorkspaceMountWrite {
    WorkspaceMountWrite {
        volume_id: "data".into(),
        destination: destination.into(),
        status: WorkspaceMountWriteStatus::Complete.into(),
        files: vec![WorkspaceMountWrittenFile {
            key: "reports/summary.md".into(),
            size: 12,
            sha256: "ab".repeat(32),
        }],
        skipped: 3,
        ..Default::default()
    }
}

fn record(
    assignment: &Assignment,
    writes: Vec<WorkspaceMountWrite>,
) -> RecordWorkspaceMountWritesRequest {
    RecordWorkspaceMountWritesRequest {
        task_id: assignment.task.as_ref().unwrap().task_id.clone(),
        attempt_id: assignment.attempt_id.clone(),
        lease_token: assignment.lease_token.clone(),
        writes,
    }
}

fn tag(
    id: &str,
    harness: HarnessKind,
    actions: &[&str],
    mounts: Vec<WorkspaceCopyMount>,
) -> PutTagRequest {
    PutTagRequest {
        tag_id: id.into(),
        instructions: "Read the mounted data".into(),
        harness_kind: harness.into(),
        allowed_actions: actions.iter().map(|action| (*action).into()).collect(),
        workspace: Some(WorkspaceSpec {
            mcp_servers: vec![],
            workspace_id: "repo".into(),
            base_commit: BASE.into(),
            github_source: None,
            mounts,
        }),
        ..Default::default()
    }
}

fn submit(tag_id: &str, session: &str, operation: &str) -> SubmitTaskRequest {
    SubmitTaskRequest {
        tag_id: tag_id.into(),
        session_id: session.into(),
        operation_id: operation.into(),
        prompt: "Summarize the data".into(),
        ..Default::default()
    }
}

fn profile(source: &str, root: &str) -> HarnessExecutionProfile {
    HarnessExecutionProfile {
        workspace_mounts: vec![WorkspaceMountCapability {
            volume_id: "data".into(),
            source: source.into(),
            destination_root: root.into(),
            credential: String::new(),
        }],
        ..Default::default()
    }
}

async fn claim(
    store: &Store,
    host: &HostAuthority,
    operation: &str,
    harness: HarnessKind,
    profile: &HarnessExecutionProfile,
) -> Option<Assignment> {
    store
        .claim_task_with_profile(
            host,
            operation,
            &["repo".into()],
            harness,
            &[],
            Some(profile),
        )
        .await
        .unwrap()
}

fn start(assignment: &Assignment) -> StartTaskRequest {
    StartTaskRequest {
        task_id: assignment.task.as_ref().unwrap().task_id.clone(),
        attempt_id: assignment.attempt_id.clone(),
        lease_token: assignment.lease_token.clone(),
    }
}

fn inspect(assignment: &Assignment) -> InspectAttemptRequest {
    InspectAttemptRequest {
        task_id: assignment.task.as_ref().unwrap().task_id.clone(),
        attempt_id: assignment.attempt_id.clone(),
        lease_token: assignment.lease_token.clone(),
    }
}

async fn put_volume(
    store: &Store,
    source: &str,
    expected: u64,
) -> Result<WorkspaceVolume, StoreError> {
    store
        .put_workspace_volume(
            OPERATOR,
            &PutWorkspaceVolumeRequest {
                volume_id: "data".into(),
                source: source.into(),
                expected_revision: expected,
                credential: String::new(),
            },
        )
        .await
}

async fn exercise(url: &str) {
    let store = Store::open(url).await.unwrap();
    store
        .put_artifact_volume(
            OPERATOR,
            &PutArtifactVolumeRequest {
                operation_id: "artifacts".into(),
                volume_id: "artifacts".into(),
                source: ARTIFACTS.into(),
                expected_revision: 0,
            },
        )
        .await
        .unwrap();

    // Catalog: operator-only, validated, revisioned, and disjoint from artifact storage.
    let request = PutWorkspaceVolumeRequest {
        volume_id: "data".into(),
        source: DATA.into(),
        expected_revision: 0,
        credential: String::new(),
    };
    for principal in ["host:intruder", "tag:research", "operator:"] {
        assert!(matches!(
            store.put_workspace_volume(principal, &request).await,
            Err(StoreError::PermissionDenied)
        ));
    }
    for (id, source, credential) in [
        ("Data", DATA, ""),
        ("data", "file://host/srv/data", ""),
        ("data", "file:///srv/data?x=1", ""),
        // A file Volume's host mapping is its consent; it names no credential.
        ("data", DATA, "team-data"),
        // An object-store Volume names the credential its hosts map, and nothing else.
        ("data", "s3://bucket/data", ""),
        ("data", "s3://bucket/data", "Team"),
        ("data", "s3://bucket/data?region=us-east-1", "team-data"),
        ("data", "s3://user:secret@bucket/data", "team-data"),
        ("data", "gs://bucket/data", "team-data"),
        ("data", "modal-volume://training", "team-data"),
    ] {
        let request = PutWorkspaceVolumeRequest {
            volume_id: id.into(),
            source: source.into(),
            expected_revision: 0,
            credential: credential.into(),
        };
        assert!(matches!(
            store.put_workspace_volume(OPERATOR, &request).await,
            Err(StoreError::InvalidArgument(_))
        ));
    }
    for overlapping in [
        ARTIFACTS,
        "file:///srv/supertag/artifacts/data",
        "file:///srv/supertag",
    ] {
        assert!(matches!(
            put_volume(&store, overlapping, 0).await,
            Err(StoreError::FailedPrecondition(_))
        ));
    }
    if cfg!(target_os = "macos") {
        // Case and Unicode aliases of artifact storage overlap on macOS.
        assert!(matches!(
            put_volume(&store, "file:///srv/supertag/ARTIFACTS", 0).await,
            Err(StoreError::FailedPrecondition(_))
        ));
    }
    let created = put_volume(&store, DATA, 0).await.unwrap();
    assert_eq!(created.revision, 1);
    assert_eq!(put_volume(&store, DATA, 1).await.unwrap(), created);
    assert!(matches!(
        put_volume(&store, RETARGETED, 0).await,
        Err(StoreError::Conflict(_))
    ));
    assert_eq!(
        store.get_workspace_volume(OPERATOR, "data").await.unwrap(),
        created
    );
    assert!(store.get_workspace_volume("host:x", "data").await.is_err());
    // Artifact storage may not be registered inside Workspace data later.
    for (index, source) in [
        "file:///srv/supertag/data/artifacts",
        "file:///srv/supertag/data",
        "file:///srv",
    ]
    .into_iter()
    .enumerate()
    {
        assert!(matches!(
            store
                .put_artifact_volume(
                    OPERATOR,
                    &PutArtifactVolumeRequest {
                        operation_id: format!("overlap-{index}"),
                        volume_id: format!("overlap-{index}"),
                        source: source.into(),
                        expected_revision: 0,
                    },
                )
                .await,
            Err(StoreError::FailedPrecondition(_))
        ));
    }

    // S3 Workspace data is disjoint from S3 artifact storage by bucket and prefix.
    store
        .put_artifact_volume(
            OPERATOR,
            &PutArtifactVolumeRequest {
                operation_id: "s3-artifacts".into(),
                volume_id: "s3-artifacts".into(),
                source: "s3://shared-bucket/artifacts".into(),
                expected_revision: 0,
            },
        )
        .await
        .unwrap();
    let s3 = |id: &str, source: &str| PutWorkspaceVolumeRequest {
        volume_id: id.into(),
        source: source.into(),
        expected_revision: 0,
        credential: "team-data".into(),
    };
    for source in [
        "s3://shared-bucket/artifacts",
        "s3://shared-bucket/artifacts/inner",
    ] {
        assert!(matches!(
            store
                .put_workspace_volume(OPERATOR, &s3("s3-data", source))
                .await,
            Err(StoreError::FailedPrecondition(_))
        ));
    }
    let bucket = store
        .put_workspace_volume(
            OPERATOR,
            &s3("s3-data", "s3://shared-bucket/artifacts-next"),
        )
        .await
        .unwrap();
    assert_eq!(bucket.credential, "team-data");
    assert_eq!(
        store
            .get_workspace_volume(OPERATOR, "s3-data")
            .await
            .unwrap(),
        bucket
    );
    // Renaming the credential is a new revision; an equal put is a no-op.
    let mut renamed = s3("s3-data", "s3://shared-bucket/artifacts-next");
    renamed.expected_revision = 1;
    assert_eq!(
        store
            .put_workspace_volume(OPERATOR, &renamed)
            .await
            .unwrap(),
        bucket
    );
    renamed.credential = "other-data".into();
    assert_eq!(
        store
            .put_workspace_volume(OPERATOR, &renamed)
            .await
            .unwrap()
            .revision,
        2
    );
    assert!(matches!(
        store
            .put_artifact_volume(
                OPERATOR,
                &PutArtifactVolumeRequest {
                    operation_id: "s3-overlap".into(),
                    volume_id: "s3-overlap".into(),
                    source: "s3://shared-bucket/artifacts-next/copies".into(),
                    expected_revision: 0,
                },
            )
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));

    // Tag configuration validates destinations and never accepts a pin.
    let destination = format!("{ROOT}/data");
    let mut pinned = mount(&destination);
    pinned.volume = Some(created.clone());
    let mut oversized = mount(&destination);
    oversized.max_bytes = supertag_protocol::workspace_mounts::MAX_WORKSPACE_MOUNT_BYTES + 1;
    let mut unknown = mount(&destination);
    unknown.volume_id = "missing".into();
    for (case, mounts) in [
        ("pin", vec![pinned]),
        ("relative", vec![mount("mounts/data")]),
        ("traversal", vec![mount(&format!("{ROOT}/../data"))]),
        ("dot", vec![mount(&format!("{ROOT}/.data"))]),
        ("system", vec![mount("/etc/supertag")]),
        (
            "overlap",
            vec![mount(&destination), mount(&format!("{destination}/inner"))],
        ),
        ("duplicate", vec![mount(&destination), mount(&destination)]),
        ("oversized", vec![oversized]),
        (
            "count",
            (0..9).map(|i| mount(&format!("{ROOT}/d{i}"))).collect(),
        ),
    ] {
        assert!(
            matches!(
                store
                    .put_tag_spec(tag("reader", HarnessKind::Codex, &["files:read"], mounts))
                    .await,
                Err(StoreError::InvalidArgument(_))
            ),
            "{case}"
        );
    }
    if cfg!(target_os = "macos") {
        assert!(
            store
                .put_tag_spec(tag(
                    "reader",
                    HarnessKind::Codex,
                    &["files:read"],
                    vec![
                        mount(&format!("{ROOT}/Café")),
                        mount(&format!("{ROOT}/cafe\u{301}"))
                    ],
                ))
                .await
                .is_err()
        );
    }
    assert!(matches!(
        store
            .put_tag_spec(tag(
                "reader",
                HarnessKind::Codex,
                &["files:read"],
                vec![unknown]
            ))
            .await,
        Err(StoreError::NotFound(_))
    ));
    let mut github = tag(
        "reader",
        HarnessKind::Codex,
        &["files:read"],
        vec![mount(&destination)],
    );
    github.workspace.as_mut().unwrap().base_commit.clear();
    assert!(store.put_tag_spec(github).await.is_err());
    let reader = store
        .put_tag_spec(tag(
            "reader",
            HarnessKind::Codex,
            &["files:read"],
            vec![mount(&destination)],
        ))
        .await
        .unwrap();
    let configured = &reader.workspace.unwrap().mounts;
    assert_eq!(configured.len(), 1);
    assert!(configured[0].volume.is_none());

    // Only local Codex or Claude Code Tasks that read files, write files for
    // every read-write copy, and neither run commands nor fetch may be admitted.
    let mut unwritable = tag(
        "unwritable",
        HarnessKind::Codex,
        &["files:read"],
        vec![writable(&destination)],
    );
    store.put_tag_spec(unwritable.clone()).await.unwrap();
    assert!(matches!(
        store
            .submit_task(OPERATOR, &submit("unwritable", "s", "unwritable"))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    unwritable.allowed_actions.push("files:write".into());
    store.put_tag_spec(unwritable).await.unwrap();
    for id in ["unwritable"] {
        let admitted = store
            .submit_task(OPERATOR, &submit(id, "s", &format!("{id}-ok")))
            .await
            .unwrap();
        assert!(admitted.workspace.unwrap().mounts[0].read_write);
        store.cancel_task(&admitted.task_id).await.unwrap();
    }
    // Cursor and OpenCode confine their file tools to the checkout and granted copies.
    for (id, harness) in [
        ("cursor", HarnessKind::Cursor),
        ("opencode", HarnessKind::Opencode),
    ] {
        store
            .put_tag_spec(tag(id, harness, &["files:read"], vec![mount(&destination)]))
            .await
            .unwrap();
        let admitted = store
            .submit_task(OPERATOR, &submit(id, "s", id))
            .await
            .unwrap();
        assert_eq!(admitted.workspace.unwrap().mounts.len(), 1, "{id}");
        store.cancel_task(&admitted.task_id).await.unwrap();
    }
    for (id, harness, actions) in [
        (
            "runner",
            HarnessKind::Codex,
            &["files:read", "commands:execute"][..],
        ),
        (
            "fetcher",
            HarnessKind::Codex,
            &["files:read", "web:fetch"][..],
        ),
        ("blind", HarnessKind::Codex, &[][..]),
        ("agents", HarnessKind::OpenaiAgents, &["files:read"][..]),
    ] {
        store
            .put_tag_spec(tag(id, harness, actions, vec![mount(&destination)]))
            .await
            .unwrap();
        assert!(
            matches!(
                store.submit_task(OPERATOR, &submit(id, "s", id)).await,
                Err(StoreError::FailedPrecondition(_))
            ),
            "{id}"
        );
    }

    // Admission freezes the current Volume revision.
    let task = store
        .submit_task(OPERATOR, &submit("reader", "first", "first"))
        .await
        .unwrap();
    assert_eq!(
        task.workspace.as_ref().unwrap().mounts[0].volume,
        Some(created.clone())
    );
    assert_eq!(
        store.get_task(&task.task_id).await.unwrap().workspace,
        task.workspace
    );

    // Placement requires a Codex Host advertising the exact mapping.
    let host = support::register_host(&store, "mount-host").await;
    let other = support::register_host(&store, "other-host").await;
    for (operation, harness, profile) in [
        (
            "no-mapping",
            HarnessKind::Codex,
            HarnessExecutionProfile::default(),
        ),
        (
            "wrong-source",
            HarnessKind::Codex,
            profile(RETARGETED, ROOT),
        ),
        (
            "wrong-root",
            HarnessKind::Codex,
            profile(DATA, "/srv/supertag"),
        ),
        ("claude", HarnessKind::ClaudeCode, profile(DATA, ROOT)),
        (
            "remote",
            HarnessKind::Codex,
            HarnessExecutionProfile {
                remote_file_workspace: true,
                ..profile(DATA, ROOT)
            },
        ),
    ] {
        assert!(
            claim(&store, &host, operation, harness, &profile)
                .await
                .is_none(),
            "{operation}"
        );
    }
    let mut invalid = profile(DATA, "/etc/mounts");
    assert!(
        store
            .claim_task_with_profile(
                &host,
                "invalid",
                &["repo".into()],
                HarnessKind::Codex,
                &[],
                Some(&invalid)
            )
            .await
            .is_err()
    );
    invalid = profile("https://example.com/data", ROOT);
    assert!(
        store
            .claim_task_with_profile(
                &host,
                "invalid-source",
                &["repo".into()],
                HarnessKind::Codex,
                &[],
                Some(&invalid)
            )
            .await
            .is_err()
    );
    let first = claim(
        &store,
        &host,
        "first",
        HarnessKind::Codex,
        &profile(DATA, ROOT),
    )
    .await
    .unwrap();
    assert_eq!(first.task.as_ref().unwrap().task_id, task.task_id);
    store.start_task(&host, &start(&first)).await.unwrap();

    // Preflight discloses artifact paths only to the owning Host of a running Attempt.
    let preflight = store
        .workspace_mount_preflight(&host, &inspect(&first))
        .await
        .unwrap();
    assert_eq!(preflight.protected_file_sources, [ARTIFACTS]);
    assert!(
        store
            .workspace_mount_preflight(&other, &inspect(&first))
            .await
            .is_err()
    );
    let mut stale = inspect(&first);
    stale.lease_token = Uuid::new_v4().to_string();
    assert!(
        store
            .workspace_mount_preflight(&host, &stale)
            .await
            .is_err()
    );

    // A read-only copy records no writes.
    assert!(matches!(
        store
            .record_workspace_mount_writes(&host, &record(&first, vec![written(&destination)]))
            .await,
        Err(StoreError::InvalidArgument(_))
    ));

    // A Claude Code Task's read-write copy records its write-back summary once.
    let out = format!("{ROOT}/out");
    store
        .put_tag_spec(tag(
            "editor",
            HarnessKind::ClaudeCode,
            &["files:read", "files:write"],
            vec![writable(&out)],
        ))
        .await
        .unwrap();
    let edit = store
        .submit_task(OPERATOR, &submit("editor", "edit", "edit"))
        .await
        .unwrap();
    let editor_host = support::register_host(&store, "editor-host").await;
    assert!(
        claim(
            &store,
            &editor_host,
            "edit-codex",
            HarnessKind::Codex,
            &profile(DATA, ROOT)
        )
        .await
        .is_none()
    );
    let editing = claim(
        &store,
        &editor_host,
        "edit",
        HarnessKind::ClaudeCode,
        &profile(DATA, ROOT),
    )
    .await
    .unwrap();
    assert_eq!(editing.task.as_ref().unwrap().task_id, edit.task_id);
    let summary = written(&out);
    // Only the owning Host of a running Attempt records writes.
    assert!(
        store
            .record_workspace_mount_writes(&editor_host, &record(&editing, vec![summary.clone()]))
            .await
            .is_err()
    );
    store
        .start_task(&editor_host, &start(&editing))
        .await
        .unwrap();
    assert!(matches!(
        store
            .record_workspace_mount_writes(&other, &record(&editing, vec![summary.clone()]))
            .await,
        Err(StoreError::PermissionDenied)
    ));
    let mut partial = summary.clone();
    partial.status = WorkspaceMountWriteStatus::Partial.into();
    let mut wrong_volume = summary.clone();
    wrong_volume.volume_id = "s3-data".into();
    let mut traversal = summary.clone();
    traversal.files[0].key = "../escape".into();
    for invalid in [
        vec![written(&destination)],
        vec![summary.clone(), summary.clone()],
        vec![partial],
        vec![wrong_volume],
        vec![traversal],
    ] {
        assert!(matches!(
            store
                .record_workspace_mount_writes(&editor_host, &record(&editing, invalid))
                .await,
            Err(StoreError::InvalidArgument(_))
        ));
    }
    store
        .record_workspace_mount_writes(&editor_host, &record(&editing, vec![summary.clone()]))
        .await
        .unwrap();
    // A retry of the same summary succeeds; a different one is refused.
    store
        .record_workspace_mount_writes(&editor_host, &record(&editing, vec![summary.clone()]))
        .await
        .unwrap();
    let mut changed = summary.clone();
    changed.skipped = 4;
    assert!(matches!(
        store
            .record_workspace_mount_writes(&editor_host, &record(&editing, vec![changed]))
            .await,
        Err(StoreError::Conflict(_))
    ));
    assert_eq!(
        store
            .get_task(&edit.task_id)
            .await
            .unwrap()
            .workspace_mount_writes,
        [AttemptWorkspaceMountWrites {
            attempt_id: editing.attempt_id.clone(),
            writes: vec![summary],
        }]
    );
    assert!(
        store
            .get_task(&task.task_id)
            .await
            .unwrap()
            .workspace_mount_writes
            .is_empty()
    );

    // A Task without mounts gets no disclosure.
    store
        .put_tag_spec(tag("plain", HarnessKind::Codex, &["files:read"], vec![]))
        .await
        .unwrap();
    store
        .submit_task(OPERATOR, &submit("plain", "plain", "plain"))
        .await
        .unwrap();
    let plain = claim(
        &store,
        &other,
        "plain",
        HarnessKind::Codex,
        &HarnessExecutionProfile::default(),
    )
    .await
    .unwrap();
    store.start_task(&other, &start(&plain)).await.unwrap();
    assert!(matches!(
        store
            .workspace_mount_preflight(&other, &inspect(&plain))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));

    // Retargeting the Volume invalidates every older pin, even when it returns
    // to the original source, and stops a running Attempt's preflight.
    let retargeted = put_volume(&store, RETARGETED, 1).await.unwrap();
    assert_eq!(retargeted.revision, 2);
    assert!(matches!(
        store
            .workspace_mount_preflight(&host, &inspect(&first))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    let restored = put_volume(&store, DATA, 2).await.unwrap();
    assert_eq!(restored.revision, 3);
    assert!(
        store
            .workspace_mount_preflight(&host, &inspect(&first))
            .await
            .is_err()
    );
    // The Session keeps its frozen pins; changed data needs a new Session.
    assert!(matches!(
        store
            .submit_task(OPERATOR, &submit("reader", "first", "second"))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));

    // A claimed Task whose pin changed before start may not start.
    let queued = store
        .submit_task(OPERATOR, &submit("reader", "second", "queued"))
        .await
        .unwrap();
    assert_eq!(
        queued.workspace.as_ref().unwrap().mounts[0].volume,
        Some(restored.clone())
    );
    let mut host_three = support::register_host(&store, "third-host").await;
    let claimed = claim(
        &store,
        &host_three,
        "queued",
        HarnessKind::Codex,
        &profile(DATA, ROOT),
    )
    .await
    .unwrap();
    assert_eq!(claimed.task.as_ref().unwrap().task_id, queued.task_id);
    put_volume(&store, RETARGETED, 3).await.unwrap();
    assert!(matches!(
        store.start_task(&host_three, &start(&claimed)).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    // The stale Task cannot be placed on a Host advertising either source.
    host_three = support::register_host(&store, "fourth-host").await;
    for (operation, source) in [("stale-old", DATA), ("stale-new", RETARGETED)] {
        assert!(
            claim(
                &store,
                &host_three,
                operation,
                HarnessKind::Codex,
                &profile(source, ROOT)
            )
            .await
            .is_none_or(|assignment| assignment.task.unwrap().task_id != queued.task_id)
        );
    }
}

#[tokio::test]
async fn sqlite_workspace_mounts() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("test.db").display()
    );
    Box::pin(exercise(&url)).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_workspace_mounts() {
    let file =
        std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("test database file");
    let admin_url = std::fs::read_to_string(file).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let database = format!("supertag_mounts_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await
        .unwrap();
    url.set_path(&database);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(Box::pin(async move { exercise(url.as_str()).await })).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await
        .unwrap();
    result.unwrap();
}
