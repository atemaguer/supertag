mod support;
use sqlx::{Connection, Executor};
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use supertag_control_plane::Store;
use supertag_protocol::v2::*;
use uuid::Uuid;
const OP: &str = "operator:contexts";
fn account(id: &str, team: &str) -> PutSurfaceAccountRequest {
    PutSurfaceAccountRequest {
        operation_id: format!("account-{id}"),
        account: Some(SurfaceAccount {
            account_id: id.into(),
            enabled: true,
            identity: Some(SurfaceAccountIdentity {
                provider: Some(surface_account_identity::Provider::Slack(
                    SlackSurfaceIdentity {
                        team_id: team.into(),
                    },
                )),
            }),
            ..Default::default()
        }),
        ..Default::default()
    }
}
fn location(id: &str, account: &str, channel: &str, tag: &str) -> PutSurfaceLocationRequest {
    PutSurfaceLocationRequest {
        operation_id: format!("location-{id}"),
        location: Some(SurfaceLocation {
            location_id: id.into(),
            account_id: account.into(),
            connector_account_id: id.into(),
            scope: Some(SurfaceLocationScope {
                provider: Some(surface_location_scope::Provider::Slack(
                    SlackSurfaceChannel {
                        channel_id: channel.into(),
                    },
                )),
            }),
            tag_id: tag.into(),
            enabled: true,
            ..Default::default()
        }),
        ..Default::default()
    }
}
fn event(
    alias: &str,
    team: &str,
    channel: &str,
    thread: u64,
    tag: &str,
) -> AcceptSlackEventRequest {
    AcceptSlackEventRequest {
        account_id: alias.into(),
        event_id: format!("{alias}-{thread}"),
        team_id: team.into(),
        channel_id: channel.into(),
        message_ts: format!("1721000000.{thread:06}"),
        thread_ts: format!("1721000000.{thread:06}"),
        prompt: "Related work".into(),
        mention_tag_id: Some(tag.into()),
        actor_id: "UALICE1".into(),
    }
}
async fn capture(
    store: &Store,
    host: &supertag_control_plane::HostAuthority,
    task: &Task,
    operation: &str,
) -> CapturedArtifact {
    let claim = store.claim_task(host, operation).await.unwrap().unwrap();
    assert_eq!(claim.task.unwrap().task_id, task.task_id);
    let attempt = InspectAttemptRequest {
        task_id: task.task_id.clone(),
        attempt_id: claim.attempt_id,
        lease_token: claim.lease_token,
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
    let request = CommitArtifactCaptureRequest {
        attempt: Some(attempt.clone()),
        operation_id: operation.into(),
        description: Some(ArtifactDescription {
            title: format!("Evidence {operation}"),
            kind: "report".into(),
            summary: Some("<untrusted> summary".into()),
        }),
        files: vec![ArtifactFile {
            path: "evidence.txt".into(),
            blob: Some(BlobReference {
                sha256: "a".repeat(64),
                byte_length: 5,
            }),
            ..Default::default()
        }],
        ..Default::default()
    };
    store
        .reserve_artifact_capture(host, &request)
        .await
        .unwrap();
    let result = store.commit_artifact_capture(host, &request).await.unwrap();
    store
        .finish_task(
            host,
            &FinishTaskRequest {
                task_id: attempt.task_id,
                attempt_id: attempt.attempt_id,
                lease_token: attempt.lease_token,
                result: "Complete".into(),
                succeeded: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    result
}
async fn seed_pre_context_schema(url: &str) {
    sqlx::any::install_default_drivers();
    let mut connection = sqlx::AnyConnection::connect(url).await.unwrap();
    let dialect = if url.starts_with("sqlite:") {
        "sqlite"
    } else {
        "postgresql"
    };
    let mut paths = std::fs::read_dir(
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
            <= 50
    })
    .collect::<Vec<_>>();
    paths.sort();
    for path in paths {
        sqlx::raw_sql(&std::fs::read_to_string(path).unwrap())
            .execute(&mut connection)
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO supertag_v2_tags(tag_id,instructions,allowed_actions,revision) VALUES('pre-context','preserved','[]',3)").execute(&mut connection).await.unwrap();
    sqlx::query("INSERT INTO supertag_v2_tasks(task_id,tag_id,session_id,prompt,instructions,allowed_actions,tag_revision,state,result,accepted_order) VALUES('pre-context-task','pre-context','history','old work','preserved','[]',3,3,'old result',1)").execute(&mut connection).await.unwrap();
    sqlx::query("UPDATE supertag_v2_write_order SET revision=1 WHERE singleton=1")
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
}
async fn exercise(url: &str) {
    seed_pre_context_schema(url).await;
    let clock = Arc::new(AtomicI64::new(1_800_000_000_000));
    let observed = clock.clone();
    let store = Store::open(url)
        .await
        .unwrap()
        .with_execution_clock(move || observed.load(Ordering::SeqCst));
    assert_eq!(store.get_tag("pre-context").await.unwrap().revision, 3);
    assert_eq!(
        store
            .get_task("pre-context-task")
            .await
            .unwrap()
            .result
            .as_deref(),
        Some("old result")
    );
    // There is no trustworthy pre-migration completion timestamp; do not fabricate an age.
    let mut check = sqlx::AnyConnection::connect(url).await.unwrap();
    let historical: Option<i64> = sqlx::query_scalar(
        "SELECT completed_at_ms FROM supertag_v2_tasks WHERE task_id='pre-context-task'",
    )
    .fetch_one(&mut check)
    .await
    .unwrap();
    assert!(historical.is_none());
    check.close().await.unwrap();
    for tag in ["engineer", "other"] {
        store
            .put_tag(tag, "Work", vec!["files:read".into()])
            .await
            .unwrap();
    }
    store
        .put_surface_account(OP, &account("slack", "T123"))
        .await
        .unwrap();
    store
        .put_surface_account(OP, &account("foreign", "T999"))
        .await
        .unwrap();
    for (id, a, c, t) in [
        ("source", "slack", "C123", "engineer"),
        ("private", "slack", "C999", "engineer"),
        ("other-tag", "slack", "C456", "other"),
        ("foreign", "foreign", "C123", "engineer"),
    ] {
        store
            .put_surface_location(OP, &location(id, a, c, t))
            .await
            .unwrap();
    }
    let host = support::register_host(&store, "host").await;
    let mut artifacts = Vec::new();
    for (alias, team, channel, tag) in [
        ("source", "T123", "C123", "engineer"),
        ("private", "T123", "C999", "engineer"),
        ("other-tag", "T123", "C456", "other"),
        ("foreign", "T999", "C123", "engineer"),
    ] {
        let task = store
            .accept_slack_event(
                &format!("connector:{alias}"),
                &event(alias, team, channel, 1, tag),
            )
            .await
            .unwrap()
            .task
            .unwrap();
        artifacts.push(capture(&store, &host, &task, alias).await);
    }
    let context=store.put_context_set(OP,&PutContextSetRequest{operation_id:"set".into(),context_set:Some(ContextSet{set_id:"research".into(),name:"Research".into(),items:vec![PolicyContextItem{item_key:"prior".into(),r#type:"supertag/artifacts".into(),version:1,required:true,config_json:r#"{"sourceRouteId":"source","selection":{"match":"shared-resource","maxAgeDays":1,"limit":5}}"#.into(),..Default::default()}],..Default::default()}),..Default::default()}).await.unwrap();
    let mut changed = location("source", "slack", "C123", "engineer");
    changed.operation_id = "activate".into();
    changed.expected_revision = Some(1);
    changed.location.as_mut().unwrap().context_set_ids = vec![context.set_id.clone()];
    store.put_surface_location(OP, &changed).await.unwrap();
    clock.fetch_add(1_000, Ordering::SeqCst);
    let request = event("source", "T123", "C123", 2, "engineer");
    let task = store
        .accept_slack_event("connector:source", &request)
        .await
        .unwrap()
        .task
        .unwrap();
    let item = &task.policy_snapshot.as_ref().unwrap().context_sets[0].items[0];
    let snapshot = item.artifact_snapshot.as_ref().unwrap();
    assert_eq!(snapshot.artifacts.len(), 1);
    assert_eq!(
        snapshot.artifacts[0].artifact_id,
        artifacts[0].summary.as_ref().unwrap().artifact_id
    );
    assert!(task.instructions.contains("\\u003cuntrusted>"));
    assert!(!task.instructions.contains("Evidence private"));
    let claim = store.claim_task(&host, "consumer").await.unwrap().unwrap();
    assert_eq!(claim.task.unwrap().task_id, task.task_id);
    let attempt = InspectAttemptRequest {
        task_id: task.task_id.clone(),
        attempt_id: claim.attempt_id,
        lease_token: claim.lease_token,
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
    store
        .commit_context_resolution(
            &host,
            &CommitContextResolutionRequest {
                attempt: Some(attempt.clone()),
                manifest: Some(ContextResolutionManifest::default()),
            },
        )
        .await
        .unwrap();
    let found = store
        .find_attempt_artifacts(
            &host,
            &FindAttemptArtifactsRequest {
                attempt: Some(attempt.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(found.artifacts.len(), 1);
    for (index, artifact) in artifacts.iter().enumerate() {
        let inspect = store
            .inspect_attempt_artifact(
                &host,
                &InspectAttemptArtifactRequest {
                    attempt: Some(attempt.clone()),
                    artifact_id: artifact.summary.as_ref().unwrap().artifact_id.clone(),
                },
            )
            .await;
        assert_eq!(inspect.is_ok(), index == 0);
    }
    let acquired = store
        .acquire_artifact(
            &host,
            &AcquireArtifactRequest {
                attempt: Some(attempt.clone()),
                operation_id: "read".into(),
                artifact_id: snapshot.artifacts[0].artifact_id.clone(),
                paths: vec!["evidence.txt".into()],
                delivery: ArtifactDelivery::Read as i32,
                destination: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(acquired.files, artifacts[0].files);
    // A later turn of the original thread must not receive its own catalog as shared context.
    let mut same_session = event("source", "T123", "C123", 1, "engineer");
    same_session.event_id = "same-session-probe".into();
    same_session.message_ts = "1721000001.000001".into();
    let same = store
        .accept_slack_event("connector:source", &same_session)
        .await
        .unwrap()
        .task
        .unwrap();
    assert!(
        same.policy_snapshot.as_ref().unwrap().context_sets[0].items[0]
            .artifact_snapshot
            .as_ref()
            .unwrap()
            .artifacts
            .is_empty()
    );
    store.cancel_task(&same.task_id).await.unwrap();
    let child = store
        .start_work_session(
            &host,
            &StartWorkSessionRequest {
                attempt: Some(attempt.clone()),
                operation_id: "context-child".into(),
                title: "Read the same evidence".into(),
                instruction: "Inspect selected context".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .finish_task(
            &host,
            &FinishTaskRequest {
                task_id: attempt.task_id,
                attempt_id: attempt.attempt_id,
                lease_token: attempt.lease_token,
                succeeded: true,
                result: "Used context".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let assignment = store
        .claim_task(&host, "context-child-claim")
        .await
        .unwrap()
        .unwrap();
    let child_task = assignment.task.unwrap();
    assert_eq!(child_task.session_id, child.work_session_id);
    assert_eq!(child_task.policy_snapshot, task.policy_snapshot);
    let child_attempt = InspectAttemptRequest {
        task_id: child_task.task_id,
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    };
    store
        .start_task(
            &host,
            &StartTaskRequest {
                task_id: child_attempt.task_id.clone(),
                attempt_id: child_attempt.attempt_id.clone(),
                lease_token: child_attempt.lease_token.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .inspect_attempt_artifact(
                &host,
                &InspectAttemptArtifactRequest {
                    attempt: Some(child_attempt.clone()),
                    artifact_id: snapshot.artifacts[0].artifact_id.clone()
                }
            )
            .await
            .unwrap(),
        artifacts[0]
    );
    store
        .finish_task(
            &host,
            &FinishTaskRequest {
                task_id: child_attempt.task_id,
                attempt_id: child_attempt.attempt_id,
                lease_token: child_attempt.lease_token,
                succeeded: true,
                result: "Read frozen catalog".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    Box::pin(rejected_selection_is_atomic(&store, &context)).await;
    // Neither later source changes nor route edits reselect an accepted Task.
    clock.fetch_add(2 * 86_400_000, Ordering::SeqCst);
    let expired = store
        .accept_slack_event(
            "connector:source",
            &event("source", "T123", "C123", 3, "engineer"),
        )
        .await
        .unwrap()
        .task
        .unwrap();
    assert!(
        expired.policy_snapshot.as_ref().unwrap().context_sets[0].items[0]
            .artifact_snapshot
            .as_ref()
            .unwrap()
            .artifacts
            .is_empty()
    );
    assert!(!expired.instructions.contains("<supertag-artifacts>"));
    assert_eq!(
        store
            .accept_slack_event("connector:source", &request)
            .await
            .unwrap()
            .task
            .unwrap()
            .policy_snapshot,
        task.policy_snapshot
    );
    store.close().await;
    let store = Store::open(url).await.unwrap();
    assert_eq!(
        store.get_task(&task.task_id).await.unwrap().policy_snapshot,
        task.policy_snapshot
    );
    store.close().await;
}
async fn rejected_selection_is_atomic(store: &Store, context: &ContextSet) {
    // Counts apply across all Context Items. A failed admission leaves no event receipt.
    let mut many = context.clone();
    many.set_id = "many".into();
    many.name = "Too much evidence".into();
    many.revision = 0;
    many.items = (0..6)
        .map(|i| {
            let mut item = context.items[0].clone();
            item.item_id.clear();
            item.item_key = format!("item-{i}");
            item
        })
        .collect();
    store
        .put_context_set(
            OP,
            &PutContextSetRequest {
                operation_id: "many".into(),
                context_set: Some(many),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let mut update = location("source", "slack", "C123", "engineer");
    update.operation_id = "activate-many".into();
    update.expected_revision = Some(2);
    update.location.as_mut().unwrap().context_set_ids = vec!["many".into()];
    store.put_surface_location(OP, &update).await.unwrap();
    let event = event("source", "T123", "C123", 4, "engineer");
    assert!(
        store
            .accept_slack_event("connector:source", &event)
            .await
            .is_err()
    );
    // Optional means that an empty valid selection is permitted, not that an invalid source is trusted.
    let mut unavailable = context.clone();
    unavailable.set_id = "unavailable".into();
    unavailable.name = "Unavailable".into();
    unavailable.revision = 0;
    unavailable.items[0].item_id.clear();
    unavailable.items[0].required = false;
    unavailable.items[0].config_json=r#"{"sourceRouteId":"missing","selection":{"match":"shared-resource","maxAgeDays":1,"limit":5}}"#.into();
    store
        .put_context_set(
            OP,
            &PutContextSetRequest {
                operation_id: "unavailable".into(),
                context_set: Some(unavailable),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    update.operation_id = "activate-unavailable".into();
    update.expected_revision = Some(3);
    update.location.as_mut().unwrap().context_set_ids = vec!["unavailable".into()];
    store.put_surface_location(OP, &update).await.unwrap();
    assert!(
        store
            .accept_slack_event("connector:source", &event)
            .await
            .is_err()
    );
    update.operation_id = "restore-valid".into();
    update.expected_revision = Some(4);
    update.location.as_mut().unwrap().context_set_ids = vec![context.set_id.clone()];
    store.put_surface_location(OP, &update).await.unwrap();
    let task = store
        .accept_slack_event("connector:source", &event)
        .await
        .unwrap()
        .task
        .unwrap();
    assert_eq!(
        task.policy_snapshot.as_ref().unwrap().context_sets[0].items[0]
            .artifact_snapshot
            .as_ref()
            .unwrap()
            .artifacts
            .len(),
        1
    );
    assert_eq!(
        store
            .accept_slack_event("connector:source", &event)
            .await
            .unwrap()
            .task
            .unwrap()
            .task_id,
        task.task_id
    );
}
#[tokio::test]
async fn sqlite() {
    let temp = tempfile::tempdir().unwrap();
    Box::pin(exercise(&format!(
        "sqlite://{}?mode=rwc",
        temp.path().join("db").display()
    )))
    .await;
}
#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres() {
    let admin_url =
        std::fs::read_to_string(std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").unwrap())
            .unwrap();
    let database = format!("supertag_artifact_context_{}", Uuid::new_v4().simple());
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

async fn github_resource(url: &str) {
    use sha2::{Digest, Sha256};
    let store = Store::open(url).await.unwrap();
    store
        .put_tag("engineer", "Work", vec!["files:read".into()])
        .await
        .unwrap();
    store
        .put_surface_account(OP, &account("slack", "T123"))
        .await
        .unwrap();
    store
        .put_surface_location(OP, &location("source", "slack", "C123", "engineer"))
        .await
        .unwrap();
    store
        .put_surface_account(
            OP,
            &PutSurfaceAccountRequest {
                operation_id: "github-account".into(),
                account: Some(SurfaceAccount {
                    account_id: "github-account".into(),
                    identity: Some(SurfaceAccountIdentity {
                        provider: Some(surface_account_identity::Provider::Github(
                            GithubSurfaceIdentity {
                                external_account_id: "installation-1".into(),
                            },
                        )),
                    }),
                    enabled: true,
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .put_github_workspace(
            OP,
            &PutGithubWorkspaceRequest {
                operation_id: "workspace".into(),
                workspace: Some(GithubWorkspace {
                    workspace_id: "repo".into(),
                    source: Some(GithubWorkspaceSource {
                        account_id: "github-account".into(),
                        repository_id: 123,
                        repository: "acme/project".into(),
                        commit_sha: "1".repeat(40),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .put_permission_set(
            OP,
            &PutPermissionSetRequest {
                operation_id: "read".into(),
                permission_set: Some(PermissionSet {
                    set_id: "read".into(),
                    name: "Read".into(),
                    permissions: vec![PolicyPermission {
                        target: PolicyPermissionTarget::Surface as i32,
                        action: "contents:read".into(),
                        surface_account_id: "github-account".into(),
                        scope: "repository:123".into(),
                        ..Default::default()
                    }],
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .put_role(
            OP,
            &PutRoleRequest {
                operation_id: "role".into(),
                role: Some(Role {
                    role_id: "reader".into(),
                    name: "Reader".into(),
                    purpose: "Read source".into(),
                    permission_set_ids: vec!["read".into()],
                    status: RoleStatus::Active as i32,
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .assign_role(
            OP,
            &AssignRoleRequest {
                operation_id: "assign-role".into(),
                role: "reader".into(),
                tag_id: "engineer".into(),
            },
        )
        .await
        .unwrap();
    store
        .put_tag_spec(PutTagRequest {
            tag_id: "engineer".into(),
            instructions: "Work".into(),
            allowed_actions: vec!["files:read".into()],
            workspace: Some(WorkspaceSpec {
                workspace_id: "repo".into(),
                ..Default::default()
            }),
            ..Default::default()
        })
        .await
        .unwrap();
    let source = store
        .accept_slack_event(
            "connector:source",
            &event("source", "T123", "C123", 1, "engineer"),
        )
        .await
        .unwrap()
        .task
        .unwrap();
    let host = support::register_host(&store, "source-host").await;
    let claim = store
        .claim_task_with_sources(
            &host,
            "source",
            (&[], &["repo".into()]),
            HarnessKind::Unspecified,
            &[],
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.task.unwrap().task_id, source.task_id);
    let attempt = InspectAttemptRequest {
        task_id: source.task_id,
        attempt_id: claim.attempt_id,
        lease_token: claim.lease_token,
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
            title: "Repository investigation".into(),
            kind: "report".into(),
            summary: None,
        }),
        files: vec![ArtifactFile {
            path: "report.txt".into(),
            blob: Some(BlobReference {
                sha256: "a".repeat(64),
                byte_length: 8,
            }),
            ..Default::default()
        }],
        ..Default::default()
    };
    store
        .reserve_artifact_capture(&host, &request)
        .await
        .unwrap();
    let captured = store
        .commit_artifact_capture(&host, &request)
        .await
        .unwrap();
    let blob = |b: &[u8]| BlobReference {
        sha256: format!("{:x}", Sha256::digest(b)),
        byte_length: b.len() as u64,
    };
    let delivery = WorkspaceDeliveryReference {
        workspace_id: "repo".into(),
        delivery_id: format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(&attempt.task_id, &attempt.attempt_id)).unwrap())
        ),
        base_commit: "1".repeat(40),
        start_commit: "1".repeat(40),
        head_commit: "1".repeat(40),
        patch: Some(blob(b"")),
        bundle: Some(blob(b"bundle")),
        ..Default::default()
    };
    let upload = WorkspaceDeliveryRequest {
        attempt: Some(attempt.clone()),
        delivery: Some(delivery.clone()),
    };
    store
        .reserve_workspace_delivery(&host, &upload)
        .await
        .unwrap();
    store
        .commit_workspace_delivery(&host, &upload)
        .await
        .unwrap();
    store
        .finish_task(
            &host,
            &FinishTaskRequest {
                task_id: attempt.task_id,
                attempt_id: attempt.attempt_id,
                lease_token: attempt.lease_token,
                succeeded: true,
                result: "Inspected repository".into(),
                workspace_delivery: Some(delivery),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    // Runtime-inspected GitHub repository identity must match the incoming GitHub resource.
    store.put_context_set(OP,&PutContextSetRequest{operation_id:"context".into(),context_set:Some(ContextSet{set_id:"source-work".into(),name:"Source work".into(),items:vec![PolicyContextItem{item_key:"prior".into(),r#type:"supertag/artifacts".into(),version:1,required:true,config_json:r#"{"sourceRouteId":"source","selection":{"match":"shared-resource","maxAgeDays":30,"limit":5}}"#.into(),..Default::default()}],..Default::default()}),..Default::default()}).await.unwrap();
    for (id, repository) in [("github-good", 123), ("github-other", 456)] {
        store
            .put_surface_location(
                OP,
                &PutSurfaceLocationRequest {
                    operation_id: id.into(),
                    location: Some(SurfaceLocation {
                        location_id: id.into(),
                        account_id: "github-account".into(),
                        connector_account_id: format!("github/{id}"),
                        scope: Some(SurfaceLocationScope {
                            provider: Some(surface_location_scope::Provider::Github(
                                GithubSurfaceRepository {
                                    repository_id: repository,
                                },
                            )),
                        }),
                        tag_id: "engineer".into(),
                        enabled: true,
                        context_set_ids: vec!["source-work".into()],
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
    }
    // Clear future Workspace selection so the unrelated destination tests only context authority.
    store
        .put_tag("engineer", "Work", vec!["files:read".into()])
        .await
        .unwrap();
    for (id, repository) in [("github-good", 123), ("github-other", 456)] {
        let accepted = store
            .accept_github_event(
                &format!("connector:github/{id}"),
                &AcceptGithubEventRequest {
                    account_id: format!("github/{id}"),
                    delivery_id: format!("event-{id}"),
                    repository_id: repository,
                    repository: if repository == 123 {
                        "acme/project"
                    } else {
                        "acme/other"
                    }
                    .into(),
                    number: 1,
                    source_id: 1,
                    kind: GithubEventKind::IssueComment as i32,
                    action: GithubEventAction::Created as i32,
                    tag_id: "engineer".into(),
                    prompt: "Prior investigation".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .task
            .unwrap();
        let selected = &accepted.policy_snapshot.as_ref().unwrap().context_sets[0].items[0]
            .artifact_snapshot
            .as_ref()
            .unwrap()
            .artifacts;
        if repository == 123 {
            assert_eq!(
                selected[0].artifact_id,
                captured.summary.as_ref().unwrap().artifact_id
            )
        } else {
            assert!(selected.is_empty())
        }
    }
    store.close().await;
}
#[tokio::test]
async fn sqlite_cross_provider() {
    let temp = tempfile::tempdir().unwrap();
    Box::pin(github_resource(&format!(
        "sqlite://{}?mode=rwc",
        temp.path().join("db").display()
    )))
    .await;
}
#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_cross_provider() {
    let admin_url =
        std::fs::read_to_string(std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").unwrap())
            .unwrap();
    let database = format!("supertag_context_cross_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await
        .unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    url.set_path(&database);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { Box::pin(github_resource(url.as_str())).await })
                .await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await
        .unwrap();
    result.unwrap();
}
