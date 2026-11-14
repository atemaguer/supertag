use sqlx::{Connection, Executor};
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

const OP: &str = "operator:alice";
const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

fn role(current: &str, desired: &str) -> ManifestFieldResource {
    ManifestFieldResource {
        kind: "Role".into(),
        name: "Engineer".into(),
        fields: vec![ManifestField {
            path: "spec.purpose".into(),
            current_digest: current.into(),
            desired_digest: desired.into(),
        }],
    }
}

async fn reconcile(
    store: &Store,
    manager: &str,
    resource: ManifestFieldResource,
    force_conflicts: bool,
    preview: bool,
) -> Vec<String> {
    store
        .reconcile_manifest_fields(
            OP,
            &ReconcileManifestFieldsRequest {
                manager: manager.into(),
                resources: vec![resource],
                force_conflicts,
                preview,
            },
        )
        .await
        .unwrap()
        .conflicts
        .into_iter()
        .map(|conflict| {
            format!(
                "{}/{} {} {}",
                conflict.kind, conflict.name, conflict.path, conflict.manager
            )
        })
        .collect()
}

async fn exercise(url: &str) {
    let store = Store::open(url).await.unwrap();
    let owned_by = |manager: &str| vec![format!("Role/Engineer spec.purpose {manager}")];

    // A value no apply recorded belongs to cli: changing it conflicts, and a
    // conflicting reconcile records nothing.
    assert_eq!(
        reconcile(&store, "", role(A, B), false, false).await,
        owned_by("cli")
    );
    assert_eq!(
        reconcile(&store, "", role(A, B), false, true).await,
        owned_by("cli")
    );
    // Forcing takes it; then the default manager, apply, owns it.
    assert!(
        reconcile(&store, "", role(A, B), true, false)
            .await
            .is_empty()
    );
    assert!(
        reconcile(&store, "", role(B, C), false, true)
            .await
            .is_empty()
    );

    // Another apply set conflicts with apply on a different value, naming it.
    assert_eq!(
        reconcile(&store, "team-a", role(B, C), false, true).await,
        owned_by("apply")
    );
    // The same value is no conflict: ownership simply moves.
    assert!(
        reconcile(&store, "team-a", role(B, B), false, false)
            .await
            .is_empty()
    );
    assert_eq!(
        reconcile(&store, "", role(B, C), false, true).await,
        owned_by("team-a")
    );
    assert!(
        reconcile(&store, "team-a", role(B, C), false, false)
            .await
            .is_empty()
    );

    // A change outside apply since team-a applied makes the field cli's again.
    assert_eq!(
        reconcile(&store, "team-a", role(A, B), false, true).await,
        owned_by("cli")
    );
    // A new resource and an unset field are owned by no one.
    assert!(
        reconcile(&store, "team-b", role("", A), false, true)
            .await
            .is_empty()
    );
    // Clearing a field drops its owner, so any manager may set it next.
    assert!(
        reconcile(&store, "team-a", role(C, ""), false, false)
            .await
            .is_empty()
    );
    assert!(
        reconcile(&store, "team-b", role("", A), false, false)
            .await
            .is_empty()
    );
    assert_eq!(
        reconcile(&store, "team-a", role(A, B), false, true).await,
        owned_by("team-b")
    );

    for invalid in [
        ManifestFieldResource {
            kind: "Objective".into(),
            ..role(A, B)
        },
        ManifestFieldResource {
            fields: vec![ManifestField {
                path: "spec purpose".into(),
                ..Default::default()
            }],
            ..role(A, B)
        },
        role("not-a-digest", B),
    ] {
        assert!(matches!(
            store
                .reconcile_manifest_fields(
                    OP,
                    &ReconcileManifestFieldsRequest {
                        resources: vec![invalid],
                        ..Default::default()
                    },
                )
                .await,
            Err(StoreError::InvalidArgument(_))
        ));
    }
    for manager in ["cli", "apply", "Team"] {
        assert!(
            store
                .reconcile_manifest_fields(
                    OP,
                    &ReconcileManifestFieldsRequest {
                        manager: manager.into(),
                        ..Default::default()
                    },
                )
                .await
                .is_err()
        );
    }
    assert!(
        store
            .reconcile_manifest_fields("host:one", &Default::default())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn sqlite_manifest_field_managers() {
    let dir = tempfile::tempdir().unwrap();
    exercise(&format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("fields.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_manifest_field_managers() {
    let path =
        std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("test database file");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let database = format!("supertag_rust_fields_{}", Uuid::new_v4().simple());
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
