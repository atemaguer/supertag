//! A Tag's portrait: saved with an expected revision apart from the Tag's own, checked against
//! the art catalog, kept by Tag writes and restarts, read with GetTag and ListTags, and announced
//! on the watch as a Tag change. Upgrading from 0124 leaves every Tag on its default portrait.
use std::future::Future;

use sqlx::{AnyPool, Connection, Executor};
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

/// The schema version just before `0125_tag_appearance`.
const PRIOR: u32 = 124;

fn patch() -> TagAppearance {
    TagAppearance {
        version: 1,
        catalog: "felt-v1".into(),
        head: "pear".into(),
        color: "moss".into(),
        expression: "cheerful".into(),
        hat: "plum-beanie".into(),
        glasses: "round-charcoal".into(),
        headphones: String::new(),
    }
}

fn set(tag_id: &str, appearance: Option<TagAppearance>, expected: u64) -> SetTagAppearanceRequest {
    SetTagAppearanceRequest {
        tag_id: tag_id.into(),
        appearance,
        expected_revision: expected,
    }
}

async fn tag_notices(pool: &AnyPool, tag_id: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM supertag_v2_watch_notices WHERE kind=1 AND reason=2 AND tag_id=$1",
    )
    .bind(tag_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn contract(url: String) {
    let store = Store::open(&url).await.unwrap();
    let pool = AnyPool::connect(&url).await.unwrap();
    let created = store
        .put_tag_spec(PutTagRequest {
            tag_id: "patch".into(),
            instructions: "Review pull requests".into(),
            allowed_actions: vec!["repo:read".into()],
            harness_kind: HarnessKind::Codex as i32,
            name: Some("Patch".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    // A Tag nobody gave a portrait has none stored: clients draw its default.
    assert_eq!(created.appearance, None);
    assert_eq!(created.appearance_revision, 0);

    // Saving the portrait changes only the portrait and its own revision, and is a Tag change
    // on the watch.
    let notices = tag_notices(&pool, "patch").await;
    let saved = store
        .set_tag_appearance(set("patch", Some(patch()), 0))
        .await
        .unwrap();
    assert_eq!(saved.appearance, Some(patch()));
    assert_eq!(saved.appearance_revision, 1);
    assert_eq!(saved.revision, created.revision);
    assert_eq!(saved.instructions, created.instructions);
    assert_eq!(saved.allowed_actions, created.allowed_actions);
    assert_eq!(saved.harness_kind, created.harness_kind);
    assert_eq!(saved.name, "Patch");
    assert_eq!(tag_notices(&pool, "patch").await, notices + 1);

    // GetTag and ListTags return it.
    assert_eq!(
        store.get_tag("patch").await.unwrap().appearance,
        Some(patch())
    );
    let listed = store
        .list_tags(
            "operator:alice",
            &ListTagsRequest {
                limit: 100,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let row = listed
        .tags
        .iter()
        .find(|tag| tag.tag_id == "patch")
        .unwrap();
    assert_eq!(row.appearance, Some(patch()));
    assert_eq!(row.appearance_revision, 1);

    // An ordinary Tag write, such as a rename, keeps the portrait.
    let renamed = store
        .put_tag_spec(PutTagRequest {
            tag_id: "patch".into(),
            instructions: "Review and merge pull requests".into(),
            allowed_actions: vec!["repo:read".into()],
            harness_kind: HarnessKind::Codex as i32,
            name: Some("Patch Adams".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(renamed.revision, created.revision + 1);
    assert_eq!(renamed.appearance, Some(patch()));
    assert_eq!(renamed.appearance_revision, 1);
    assert_eq!(
        store.get_tag("patch").await.unwrap().appearance,
        Some(patch())
    );

    // A stale revision is a conflict and changes nothing.
    let mut beanieless = patch();
    beanieless.hat = String::new();
    match store
        .set_tag_appearance(set("patch", Some(beanieless.clone()), 0))
        .await
    {
        Err(StoreError::Conflict(message)) => assert!(message.contains("revision"), "{message}"),
        outcome => panic!("a stale appearance write was accepted: {outcome:?}"),
    }
    assert_eq!(
        store.get_tag("patch").await.unwrap().appearance,
        Some(patch())
    );

    // Unknown IDs and incompatible accessories are refused.
    let refused = |change: fn(&mut TagAppearance)| {
        let mut appearance = patch();
        change(&mut appearance);
        set("patch", Some(appearance), 1)
    };
    for request in [
        refused(|a| a.catalog = "felt-v0".into()),
        refused(|a| a.version = 2),
        refused(|a| a.head = "square".into()),
        refused(|a| a.color = String::new()),
        refused(|a| a.hat = "bucket".into()),
        refused(|a| a.headphones = "navy-over-ear".into()),
    ] {
        assert!(
            matches!(
                store.set_tag_appearance(request).await,
                Err(StoreError::InvalidArgument(_))
            ),
            "an invalid appearance was accepted"
        );
    }

    // Two edits from the same revision: one is saved, the other is a conflict to recover from.
    let mut listener = patch();
    listener.hat = String::new();
    listener.headphones = "navy-over-ear".into();
    let (first, second) = tokio::join!(
        store.set_tag_appearance(set("patch", Some(beanieless.clone()), 1)),
        store.set_tag_appearance(set("patch", Some(listener.clone()), 1)),
    );
    let (saved, conflict) = match (first, second) {
        (Ok(saved), Err(error)) | (Err(error), Ok(saved)) => (saved, error),
        outcome => panic!("expected one saved write and one conflict: {outcome:?}"),
    };
    assert!(matches!(conflict, StoreError::Conflict(_)), "{conflict:?}");
    assert_eq!(saved.appearance_revision, 2);
    let current = store.get_tag("patch").await.unwrap();
    assert_eq!(current.appearance, saved.appearance);
    // The conflicting editor reads the latest look and saves on top of it.
    let recovered = store
        .set_tag_appearance(set(
            "patch",
            Some(listener.clone()),
            current.appearance_revision,
        ))
        .await
        .unwrap();
    assert_eq!(recovered.appearance, Some(listener.clone()));
    assert_eq!(recovered.appearance_revision, 3);
    assert_eq!(recovered.revision, renamed.revision);

    // A missing Tag is not found.
    assert!(matches!(
        store
            .set_tag_appearance(set("nobody", Some(patch()), 0))
            .await,
        Err(StoreError::NotFound(_))
    ));

    // It survives a restart.
    pool.close().await;
    store.close().await;
    let store = Store::open(&url).await.unwrap();
    let reopened = store.get_tag("patch").await.unwrap();
    assert_eq!(reopened.appearance, Some(listener));
    assert_eq!(reopened.appearance_revision, 3);

    // Saving none returns the Tag to its default portrait.
    let cleared = store
        .set_tag_appearance(set("patch", None, 3))
        .await
        .unwrap();
    assert_eq!(cleared.appearance, None);
    assert_eq!(cleared.appearance_revision, 4);

    // A retired Tag's portrait can't change.
    store.retire_tag("patch", false).await.unwrap();
    assert!(matches!(
        store
            .set_tag_appearance(set("patch", Some(patch()), 4))
            .await,
        Err(StoreError::FailedPrecondition(_))
    ));
    store.close().await;
}

async fn seed_prior_version(url: &str) {
    sqlx::any::install_default_drivers();
    let pool = AnyPool::connect(url).await.unwrap();
    let sqlite = url.starts_with("sqlite:");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("migrations")
        .join(if sqlite { "sqlite" } else { "postgresql" });
    let mut paths: Vec<_> = std::fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .get(..4)
                .and_then(|prefix| prefix.parse::<u32>().ok())
                .is_some_and(|version| version <= PRIOR)
        })
        .collect();
    paths.sort();
    assert_eq!(paths.len(), PRIOR as usize);
    let mut tx = pool.begin().await.unwrap();
    for path in paths {
        sqlx::raw_sql(&std::fs::read_to_string(path).unwrap())
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    sqlx::raw_sql(
        "INSERT INTO supertag_v2_tags (tag_id,instructions,allowed_actions,revision,name)
         VALUES ('legacy','x','[]',3,'Legacy')",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    pool.close().await;
}

async fn migration(url: String) {
    seed_prior_version(&url).await;
    let store = Store::open(&url).await.unwrap();
    let (from, to) = store.migrated().unwrap();
    assert_eq!(from, i64::from(PRIOR));
    assert!(to > i64::from(PRIOR), "migrated to {to}");
    // A Tag from before the upgrade has no portrait stored and keeps its revision.
    let legacy = store.get_tag("legacy").await.unwrap();
    assert_eq!(legacy.appearance, None);
    assert_eq!(legacy.appearance_revision, 0);
    assert_eq!(legacy.revision, 3);
    let saved = store
        .set_tag_appearance(set("legacy", Some(patch()), 0))
        .await
        .unwrap();
    assert_eq!(saved.appearance_revision, 1);
    assert_eq!(saved.revision, 3);
    store.close().await;
}

#[tokio::test]
async fn sqlite_tag_appearance() {
    let dir = tempfile::tempdir().unwrap();
    contract(format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("state.db").display()
    ))
    .await;
}

#[tokio::test]
async fn sqlite_tag_appearance_migration() {
    let dir = tempfile::tempdir().unwrap();
    migration(format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("state.db").display()
    ))
    .await;
}

async fn on_postgres<F: Future<Output = ()> + 'static>(run: impl FnOnce(String) -> F) {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .expect("dedicated PostgreSQL URL file is required");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let mut url = url::Url::parse(admin_url.trim()).unwrap();
    let name = format!("supertag_rust_tag_appearance_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .unwrap();
    url.set_path(&name);
    let outcome = tokio::task::LocalSet::new()
        .run_until(async move { tokio::task::spawn_local(run(url.to_string())).await })
        .await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await
        .unwrap();
    admin.close().await.unwrap();
    outcome.expect("PostgreSQL Tag appearance contract failed");
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_tag_appearance() {
    on_postgres(contract).await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_tag_appearance_migration() {
    on_postgres(migration).await;
}
