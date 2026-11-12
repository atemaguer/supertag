use sqlx::{Connection, Executor};
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OP: &str = "operator:alice";

fn tag(id: &str, name: &str) -> PutTagRequest {
    PutTagRequest {
        tag_id: id.into(),
        name: Some(name.into()),
        instructions: "Own the release".into(),
        ..Default::default()
    }
}

fn submission(tag: &str) -> SubmitTaskRequest {
    SubmitTaskRequest {
        tag_id: tag.into(),
        session_id: "project".into(),
        operation_id: "submit".into(),
        prompt: "Review the release".into(),
        ..Default::default()
    }
}

fn auth_key(operation_id: &str) -> CreateAuthKeyRequest {
    CreateAuthKeyRequest {
        host_id: "release-host".into(),
        operation_id: operation_id.into(),
        key_digest: vec![7; 32],
        expires_in_ms: 60_000,
        allowed_tag_ids: vec!["first".into()],
        ..Default::default()
    }
}

async fn exercise(url: &str) {
    let store = Store::open(url).await.unwrap();
    store.put_tag_spec(tag("first", "Release")).await.unwrap();
    store.put_tag("peer", "Run checks", vec![]).await.unwrap();
    assert!(matches!(
        store.put_tag_spec(tag("second", "Release")).await,
        Err(StoreError::Conflict(_))
    ));
    store.create_auth_key(OP, &auth_key("key")).await.unwrap();
    let enrolled_key = CreateAuthKeyRequest {
        host_id: "enrolled-host".into(),
        key_digest: vec![9; 32],
        ..auth_key("enroll-key")
    };
    store.create_auth_key(OP, &enrolled_key).await.unwrap();
    store
        .enroll_host(
            &EnrollHostRequest {
                host_id: enrolled_key.host_id,
                operation_id: "enroll".into(),
                token_digest: vec![10; 32],
            },
            &[9; 32],
        )
        .await
        .unwrap();
    store
        .put_role(
            OP,
            &PutRoleRequest {
                operation_id: "put-role".into(),
                role: Some(Role {
                    role_id: "lead".into(),
                    name: "Lead".into(),
                    purpose: "Own release outcomes".into(),
                    status: RoleStatus::Active as i32,
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let role = AssignRoleRequest {
        operation_id: "assign-role".into(),
        role: "lead".into(),
        tag_id: "first".into(),
    };
    store.assign_role(OP, &role).await.unwrap();
    let team = CreateTeamRequest {
        operation_id: "create-team".into(),
        team_id: "review-team".into(),
        name: "Release Team".into(),
        member_tag_ids: vec!["first".into()],
        ..Default::default()
    };
    store.create_team(OP, &team).await.unwrap();
    assert_eq!(
        store.retire_tag("first", true).await.unwrap().blockers,
        ["Team review-team (member)"]
    );
    store
        .delete_team(
            OP,
            &DeleteTeamRequest {
                operation_id: "delete-team".into(),
                team: team.team_id.clone(),
            },
        )
        .await
        .unwrap();
    let grant = ChangeMailboxGrantRequest {
        operation_id: "grant".into(),
        sender_tag_id: "peer".into(),
        recipient_tag_id: "first".into(),
        granted: true,
    };
    store.change_mailbox_grant(OP, &grant).await.unwrap();

    let request = submission("first");
    let task = store.submit_task(OP, &request).await.unwrap();
    let blocked = store.retire_tag("first", true).await.unwrap();
    assert_eq!(blocked.blockers, [format!("open Task {}", task.task_id)]);
    assert_eq!(blocked.mailbox_grants, 1);
    assert_eq!(blocked.host_bindings, 1);
    assert_eq!(blocked.role_assignments, 1);
    assert!(blocked.tag.unwrap().retired_at_ms.is_none());
    assert!(matches!(
        store.retire_tag("first", false).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    store.cancel_task(&task.task_id).await.unwrap();

    let retired = store.retire_tag("first", false).await.unwrap();
    assert_eq!(retired.mailbox_grants, 1);
    assert_eq!(retired.host_bindings, 1);
    assert_eq!(retired.role_assignments, 1);
    let retired = retired.tag.unwrap();
    assert!(retired.retired_at_ms.is_some());
    assert_eq!(store.get_tag("first").await.unwrap(), retired);
    assert_eq!(
        store.retire_tag("first", false).await.unwrap().tag.unwrap(),
        retired
    );
    assert_eq!(store.get_task(&task.task_id).await.unwrap().tag_id, "first");
    assert_eq!(
        store.submit_task(OP, &request).await.unwrap().task_id,
        task.task_id
    );
    assert!(matches!(
        store.submit_task("operator:bob", &request).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert!(matches!(
        store.put_tag_spec(tag("first", "Release")).await,
        Err(StoreError::FailedPrecondition(_))
    ));
    assert!(
        store
            .list_mailbox_grants(
                OP,
                &ListMailboxGrantsRequest {
                    tag_id: "peer".into(),
                    ..Default::default()
                }
            )
            .await
            .unwrap()
            .grants
            .is_empty()
    );
    let grant = ChangeMailboxGrantRequest {
        operation_id: "grant-again".into(),
        ..grant
    };
    assert!(store.change_mailbox_grant(OP, &grant).await.is_err());
    let assignments = store
        .list_role_assignments(
            OP,
            &ListRoleAssignmentsRequest {
                tag_id: "first".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .assignments;
    assert_eq!(assignments.len(), 1);
    assert_eq!(assignments[0].status(), RoleAssignmentStatus::Inactive);
    assert!(
        store
            .assign_role(
                OP,
                &AssignRoleRequest {
                    operation_id: "assign-again".into(),
                    ..role
                }
            )
            .await
            .is_err()
    );
    assert!(
        store
            .create_team(
                OP,
                &CreateTeamRequest {
                    operation_id: "create-team-again".into(),
                    team_id: "second-team".into(),
                    ..team
                }
            )
            .await
            .is_err()
    );
    assert!(
        store
            .create_auth_key(OP, &auth_key("another-key"))
            .await
            .is_err()
    );
    assert!(matches!(
        store
            .enroll_host(
                &EnrollHostRequest {
                    host_id: "release-host".into(),
                    operation_id: "join".into(),
                    token_digest: vec![8; 32],
                },
                &[7; 32]
            )
            .await,
        Err(StoreError::PermissionDenied)
    ));

    let successor = store.put_tag_spec(tag("second", "Release")).await.unwrap();
    assert_eq!(successor.name, retired.name);
    assert_ne!(successor.tag_id, retired.tag_id);
    let active = store.list_tags(&ListTagsRequest::default()).await.unwrap();
    assert_eq!(
        active
            .tags
            .iter()
            .map(|tag| tag.tag_id.as_str())
            .collect::<Vec<_>>(),
        ["peer", "second"]
    );
    let history = store
        .list_tags(&ListTagsRequest {
            include_retired: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(history.tags.len(), 3);
    assert_eq!(history.tags[0], retired);
    store
        .put_tag("racing", "Check for new work", vec![])
        .await
        .unwrap();
    let request = SubmitTaskRequest {
        operation_id: "concurrent-admission".into(),
        ..submission("racing")
    };
    let (retirement, admission) = tokio::join!(
        store.retire_tag("racing", false),
        store.submit_task(OP, &request)
    );
    match (retirement, admission) {
        (Ok(retirement), Err(StoreError::FailedPrecondition(_))) => {
            assert!(retirement.tag.unwrap().retired_at_ms.is_some());
        }
        (Err(StoreError::FailedPrecondition(_)), Ok(task)) => {
            assert_eq!(task.state(), TaskState::Queued);
            assert!(
                store
                    .get_tag("racing")
                    .await
                    .unwrap()
                    .retired_at_ms
                    .is_none()
            );
        }
        outcome => panic!("retirement and admission did not serialize: {outcome:?}"),
    }
    store.close().await;
}

#[tokio::test]
async fn sqlite_tag_retirement() {
    let dir = tempfile::tempdir().unwrap();
    exercise(&format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("tags.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_tag_retirement() {
    let path =
        std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("test database file");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let database = format!("supertag_rust_tag_retirement_{}", Uuid::new_v4().simple());
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
