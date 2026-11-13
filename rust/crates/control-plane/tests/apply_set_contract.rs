use sqlx::{Connection, Executor};
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OP: &str = "operator:alice";

fn op() -> String {
    Uuid::new_v4().to_string()
}

fn declared(kind: &str, name: &str, revision: u64, created: bool) -> ApplySetDeclaration {
    ApplySetDeclaration {
        kind: kind.into(),
        name: name.into(),
        revision,
        created,
    }
}

async fn reconcile(
    store: &Store,
    set: &str,
    declared: Vec<ApplySetDeclaration>,
    prune: bool,
    preview: bool,
) -> Vec<(String, ApplySetPruneAction)> {
    store
        .reconcile_apply_set(
            OP,
            &ReconcileApplySetRequest {
                apply_set: set.into(),
                declared,
                prune,
                preview,
            },
        )
        .await
        .unwrap()
        .pruned
        .into_iter()
        .map(|item| {
            let action = item.action();
            (format!("{}/{}", item.kind, item.name), action)
        })
        .collect()
}

/// Claims resources an apply is about to create, as the CLI does before writing.
async fn claim(store: &Store, set: &str, items: &[(&str, &str)]) {
    let claims = items
        .iter()
        .map(|(kind, name)| declared(kind, name, 0, true))
        .collect();
    assert!(reconcile(store, set, claims, false, false).await.is_empty());
}

async fn volume(store: &Store, id: &str, expected: u64, source: &str) -> ArtifactVolume {
    store
        .put_artifact_volume(
            OP,
            &PutArtifactVolumeRequest {
                operation_id: op(),
                volume_id: id.into(),
                source: source.into(),
                expected_revision: expected,
            },
        )
        .await
        .unwrap()
}

async fn volume_exists(store: &Store, id: &str) -> bool {
    store
        .get_artifact_volume(
            OP,
            &GetArtifactVolumeRequest {
                volume_id: id.into(),
            },
        )
        .await
        .is_ok()
}

async fn team(store: &Store, id: &str, members: &[&str]) -> Team {
    store
        .create_team(
            OP,
            &CreateTeamRequest {
                operation_id: op(),
                team_id: id.into(),
                name: id.into(),
                member_tag_ids: members.iter().map(|value| (*value).into()).collect(),
                max_concurrency: None,
            },
        )
        .await
        .unwrap()
}

async fn exercise(url: &str) {
    let store = Store::open(url).await.unwrap();

    // Resources the set creates, which depend on one another. The set claims
    // them before it creates them.
    claim(
        &store,
        "team-a",
        &[
            ("Tag", "builder"),
            ("ContextSet", "practice"),
            ("Role", "Engineer"),
            ("Team", "crew"),
            ("Volume", "owned"),
            ("Volume", "edited"),
            ("Volume", "shared"),
            ("Team", "replaced"),
        ],
    )
    .await;
    let tag = store
        .put_tag_spec(PutTagRequest {
            tag_id: "builder".into(),
            instructions: "Build releases".into(),
            expected_revision: Some(0),
            ..Default::default()
        })
        .await
        .unwrap();
    let context = store
        .put_context_set(
            OP,
            &PutContextSetRequest {
                operation_id: op(),
                context_set: Some(ContextSet {
                    set_id: "practice-id".into(),
                    name: "practice".into(),
                    ..Default::default()
                }),
                expected_revision: None,
            },
        )
        .await
        .unwrap();
    let role = store
        .put_role(
            OP,
            &PutRoleRequest {
                operation_id: op(),
                role: Some(Role {
                    role_id: "engineer-id".into(),
                    name: "Engineer".into(),
                    purpose: "Ship releases".into(),
                    context_set_ids: vec![context.set_id.clone()],
                    ..Default::default()
                }),
                expected_revision: None,
            },
        )
        .await
        .unwrap();
    store
        .reconcile_tag_relationships(
            OP,
            &ReconcileTagRelationshipsRequest {
                tag_id: "builder".into(),
                manager: "team-a".into(),
                role_ids: vec![role.role_id.clone()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let crew = team(&store, "crew", &["builder"]).await;
    let owned = volume(&store, "owned", 0, "file:///srv/owned").await;
    let edited = volume(&store, "edited", 0, "file:///srv/edited").await;
    let shared = volume(&store, "shared", 0, "file:///srv/shared").await;
    let replaced = team(&store, "replaced", &["builder"]).await;
    // The operator creates these imperatively; the set never created them.
    let imperative = volume(&store, "imperative", 0, "file:///srv/imperative").await;
    volume(&store, "untouched", 0, "file:///srv/untouched").await;

    let first = vec![
        declared("Tag", "builder", tag.revision, true),
        declared("ContextSet", "practice", context.revision, true),
        declared("Role", "Engineer", role.revision, true),
        declared("Team", "crew", crew.revision, true),
        declared("Volume", "owned", owned.revision, true),
        declared("Volume", "edited", edited.revision, true),
        declared("Volume", "shared", shared.revision, true),
        declared("Team", "replaced", replaced.revision, true),
        // Declared by the set but not created by it: never adopted.
        declared("Volume", "imperative", imperative.revision, false),
        // Claiming an existing resource adopts nothing either.
        declared("Volume", "untouched", 1, true),
    ];
    assert!(
        reconcile(&store, "team-a", first.clone(), true, false)
            .await
            .is_empty()
    );

    // Another writer changes a member after the set applied it.
    volume(
        &store,
        "edited",
        edited.revision,
        "file:///srv/edited-by-hand",
    )
    .await;
    // A second apply set declares a member of the first.
    reconcile(
        &store,
        "team-b",
        vec![declared("Volume", "shared", shared.revision, false)],
        false,
        false,
    )
    .await;
    // The operator deletes a member and recreates it under the same name.
    store
        .delete_team(
            OP,
            &DeleteTeamRequest {
                operation_id: op(),
                team: "replaced".into(),
            },
        )
        .await
        .unwrap();
    team(&store, "replaced", &["builder"]).await;
    // An open Objective owned by the Tag keeps it in use.
    let objective = store
        .create_objective(
            OP,
            &CreateObjectiveRequest {
                operation_id: op(),
                objective_id: "release".into(),
                owner_tag_id: "builder".into(),
                outcome: "Ship the release.".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();

    // The preview shows the decisions in removal order and changes nothing.
    let expected = vec![
        ("Team/crew".to_owned(), ApplySetPruneAction::Delete),
        ("Tag/builder".to_owned(), ApplySetPruneAction::Keep),
        ("Role/Engineer".to_owned(), ApplySetPruneAction::Keep),
        ("ContextSet/practice".to_owned(), ApplySetPruneAction::Keep),
        ("Volume/edited".to_owned(), ApplySetPruneAction::Release),
        ("Volume/owned".to_owned(), ApplySetPruneAction::Delete),
    ];
    assert_eq!(
        reconcile(&store, "team-a", vec![], true, true).await,
        expected
    );
    assert!(volume_exists(&store, "owned").await);
    store.get_team(OP, "crew").await.unwrap();

    let applied = reconcile(&store, "team-a", vec![], true, false).await;
    assert_eq!(applied, expected);
    assert!(!volume_exists(&store, "owned").await);
    assert!(matches!(
        store.get_team(OP, "crew").await,
        Err(StoreError::NotFound(_))
    ));
    for kept in ["edited", "shared", "imperative", "untouched"] {
        assert!(volume_exists(&store, kept).await, "{kept}");
    }
    store.get_team(OP, "replaced").await.unwrap();
    assert!(
        store
            .get_tag("builder")
            .await
            .unwrap()
            .retired_at_ms
            .is_none()
    );

    // Once the Objective closes, the kept members are removed together, in dependency order.
    store
        .cancel_objective(
            OP,
            &ObjectiveActionRequest {
                operation_id: op(),
                objective_id: objective.objective_id,
                reason: "Removed from the organization.".into(),
            },
        )
        .await
        .unwrap();
    // The operator's recreated Team still uses the Tag, so nothing it needs goes.
    let kept = store
        .reconcile_apply_set(
            OP,
            &ReconcileApplySetRequest {
                apply_set: "team-a".into(),
                prune: true,
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .pruned;
    assert_eq!(kept.len(), 3);
    assert!(
        kept.iter()
            .all(|item| item.action() == ApplySetPruneAction::Keep),
        "{kept:?}"
    );
    assert_eq!(
        kept[0].reason,
        "Tag builder is in use by Team replaced (member)"
    );
    store
        .delete_team(
            OP,
            &DeleteTeamRequest {
                operation_id: op(),
                team: "replaced".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        reconcile(&store, "team-a", vec![], true, false).await,
        vec![
            ("Tag/builder".to_owned(), ApplySetPruneAction::Delete),
            ("Role/Engineer".to_owned(), ApplySetPruneAction::Delete),
            (
                "ContextSet/practice".to_owned(),
                ApplySetPruneAction::Delete
            ),
        ]
    );
    assert!(
        store
            .get_tag("builder")
            .await
            .unwrap()
            .retired_at_ms
            .is_some()
    );
    assert_eq!(
        store.get_role(OP, "Engineer").await.unwrap().status,
        RoleStatus::Retired as i32
    );
    assert!(matches!(
        store.get_context_set(OP, "practice").await,
        Err(StoreError::NotFound(_))
    ));
    assert!(
        reconcile(&store, "team-a", vec![], true, false)
            .await
            .is_empty()
    );

    // A writer racing a prune is serialized: either the prune sees the edit and
    // releases the member, or the edit loses to the deletion. Never both.
    claim(&store, "team-a", &[("Volume", "raced")]).await;
    let raced = volume(&store, "raced", 0, "file:///srv/raced").await;
    reconcile(
        &store,
        "team-a",
        vec![declared("Volume", "raced", raced.revision, true)],
        false,
        false,
    )
    .await;
    let prune = ReconcileApplySetRequest {
        apply_set: "team-a".into(),
        prune: true,
        ..Default::default()
    };
    let edit = PutArtifactVolumeRequest {
        operation_id: op(),
        volume_id: "raced".into(),
        source: "file:///srv/raced-by-hand".into(),
        expected_revision: raced.revision,
    };
    let (pruned, write) = tokio::join!(
        store.reconcile_apply_set(OP, &prune),
        store.put_artifact_volume(OP, &edit)
    );
    let action = pruned.unwrap().pruned[0].action();
    match (action, write) {
        (ApplySetPruneAction::Release, Ok(_)) => assert!(volume_exists(&store, "raced").await),
        (ApplySetPruneAction::Delete, Err(_)) => assert!(!volume_exists(&store, "raced").await),
        outcome => panic!("prune and write did not serialize: {outcome:?}"),
    }

    resumable(&store).await;
    foreign_tag_bindings(&store).await;

    // Names are validated, and pruning needs a named set.
    for set in ["", "apply", "cli", "Team-A"] {
        assert!(matches!(
            store
                .reconcile_apply_set(
                    OP,
                    &ReconcileApplySetRequest {
                        apply_set: set.into(),
                        prune: true,
                        ..Default::default()
                    },
                )
                .await,
            Err(StoreError::InvalidArgument(_))
        ));
    }
    assert!(matches!(
        store
            .reconcile_apply_set(
                OP,
                &ReconcileApplySetRequest {
                    apply_set: "team-a".into(),
                    declared: vec![declared("Objective", "release", 1, true)],
                    ..Default::default()
                },
            )
            .await,
        Err(StoreError::InvalidArgument(_))
    ));
    store.close().await;
}

/// An apply that stops after a create, before it records membership, still
/// owns what it created: rerunning it records the member.
async fn resumable(store: &Store) {
    claim(
        store,
        "team-c",
        &[
            ("Volume", "resumed"),
            ("Volume", "never"),
            ("Volume", "orphan"),
        ],
    )
    .await;
    // The first run creates two Volumes, then stops before recording them.
    let resumed = volume(store, "resumed", 0, "file:///srv/resumed").await;
    volume(store, "orphan", 0, "file:///srv/orphan").await;
    // The rerun finds the first Volume already there and declares it as existing.
    assert!(
        reconcile(
            store,
            "team-c",
            vec![
                declared("Volume", "resumed", resumed.revision, false),
                declared("Volume", "orphan", 1, true),
                declared("Volume", "never", 0, true),
            ],
            false,
            false,
        )
        .await
        .is_empty()
    );
    // Without a recorded write, a claimed resource is released, never removed;
    // a claim whose resource was never created is forgotten.
    let orphan = store
        .reconcile_apply_set(
            OP,
            &ReconcileApplySetRequest {
                apply_set: "team-c".into(),
                declared: vec![declared("Volume", "resumed", resumed.revision, false)],
                prune: true,
                preview: false,
            },
        )
        .await
        .unwrap()
        .pruned;
    assert_eq!(
        orphan
            .iter()
            .map(|item| (format!("{}/{}", item.kind, item.name), item.action()))
            .collect::<Vec<_>>(),
        vec![
            ("Volume/never".to_owned(), ApplySetPruneAction::Forget),
            ("Volume/orphan".to_owned(), ApplySetPruneAction::Delete),
        ]
    );
    assert!(!volume_exists(store, "orphan").await);

    claim(store, "team-c", &[("Volume", "stray")]).await;
    volume(store, "stray", 0, "file:///srv/stray").await;
    let stray = store
        .reconcile_apply_set(
            OP,
            &ReconcileApplySetRequest {
                apply_set: "team-c".into(),
                declared: vec![declared("Volume", "resumed", resumed.revision, false)],
                prune: true,
                preview: false,
            },
        )
        .await
        .unwrap()
        .pruned;
    assert_eq!(stray.len(), 1);
    assert_eq!(stray[0].action(), ApplySetPruneAction::Release);
    assert_eq!(
        stray[0].reason,
        "apply set team-c claimed it but never recorded creating it"
    );
    assert!(volume_exists(store, "stray").await);

    assert_eq!(
        reconcile(store, "team-c", vec![], true, false).await,
        vec![("Volume/resumed".to_owned(), ApplySetPruneAction::Delete)]
    );
    assert!(!volume_exists(store, "resumed").await);
}

async fn tag(store: &Store, id: &str) -> Tag {
    store
        .put_tag_spec(PutTagRequest {
            tag_id: id.into(),
            instructions: "Review releases".into(),
            expected_revision: Some(0),
            ..Default::default()
        })
        .await
        .unwrap()
}

/// Retiring a Tag removes its grants and Role assignments, so prune keeps a
/// Tag while any of them belongs to someone other than the set.
async fn foreign_tag_bindings(store: &Store) {
    claim(store, "team-d", &[("Tag", "messenger")]).await;
    let messenger = tag(store, "messenger").await;
    // Another set's Tag accepts messages from the set's Tag, the set's Tag
    // accepts messages from it, and the operator assigns a Role imperatively.
    let listener = tag(store, "listener").await;
    store
        .reconcile_tag_relationships(
            OP,
            &ReconcileTagRelationshipsRequest {
                tag_id: listener.tag_id.clone(),
                manager: "team-e".into(),
                mailbox_senders: vec![messenger.tag_id.clone()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .reconcile_tag_relationships(
            OP,
            &ReconcileTagRelationshipsRequest {
                tag_id: messenger.tag_id.clone(),
                manager: "team-d".into(),
                mailbox_senders: vec![listener.tag_id.clone()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let role = store
        .put_role(
            OP,
            &PutRoleRequest {
                operation_id: op(),
                role: Some(Role {
                    role_id: "reviewer-id".into(),
                    name: "Reviewer".into(),
                    purpose: "Review releases".into(),
                    ..Default::default()
                }),
                expected_revision: None,
            },
        )
        .await
        .unwrap();
    let assignment = store
        .assign_role(
            OP,
            &AssignRoleRequest {
                operation_id: op(),
                role: role.role_id.clone(),
                tag_id: messenger.tag_id.clone(),
            },
        )
        .await
        .unwrap();
    let revision = store.get_tag("messenger").await.unwrap().revision;
    reconcile(
        store,
        "team-d",
        vec![declared("Tag", "messenger", revision, true)],
        false,
        false,
    )
    .await;

    let kept = store
        .reconcile_apply_set(
            OP,
            &ReconcileApplySetRequest {
                apply_set: "team-d".into(),
                prune: true,
                preview: true,
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .pruned;
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].action(), ApplySetPruneAction::Keep);
    assert_eq!(
        kept[0].reason,
        "Tag messenger is in use by Tag listener (accepts messages from it), \
         a Role reviewer-id assignment not made by apply set team-d"
    );

    // Once the other set and the operator remove theirs, the set's own grant
    // goes with the Tag.
    store
        .reconcile_tag_relationships(
            OP,
            &ReconcileTagRelationshipsRequest {
                tag_id: listener.tag_id.clone(),
                manager: "team-e".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .deactivate_role_assignment(
            OP,
            &DeactivateRoleAssignmentRequest {
                operation_id: op(),
                assignment_id: assignment.assignment_id,
                expected_revision: assignment.revision,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        reconcile(store, "team-d", vec![], true, false).await,
        vec![("Tag/messenger".to_owned(), ApplySetPruneAction::Delete)]
    );
    assert!(
        store
            .get_tag("messenger")
            .await
            .unwrap()
            .retired_at_ms
            .is_some()
    );
}

#[tokio::test]
async fn sqlite_apply_set_pruning() {
    let dir = tempfile::tempdir().unwrap();
    exercise(&format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("apply-sets.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_apply_set_pruning() {
    let path =
        std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("test database file");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let database = format!("supertag_rust_apply_sets_{}", Uuid::new_v4().simple());
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
