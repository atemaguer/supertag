use sqlx::{Connection, Executor};
use supertag_control_plane::{Store, StoreError};
use supertag_protocol::v2::*;
use uuid::Uuid;

fn tag(id: &str, lead: Option<bool>) -> PutTagRequest {
    PutTagRequest {
        tag_id: id.into(),
        instructions: "Own the repository".into(),
        lead,
        ..Default::default()
    }
}

async fn exercise(url: &str) {
    let store = Store::open(url).await.unwrap();
    // A new Tag is not the lead unless asked.
    assert!(!store.put_tag_spec(tag("peer", None)).await.unwrap().lead);
    let lead = store.put_tag_spec(tag("lead", Some(true))).await.unwrap();
    assert!(lead.lead);
    assert!(store.get_tag("lead").await.unwrap().lead);

    // A second lead is refused, naming the current one.
    match store.put_tag_spec(tag("peer", Some(true))).await {
        Err(StoreError::FailedPrecondition(message)) => {
            assert!(
                message.contains("Tag lead is already the lead Tag"),
                "{message}"
            )
        }
        outcome => panic!("a second lead Tag was accepted: {outcome:?}"),
    }
    assert!(!store.get_tag("peer").await.unwrap().lead);

    // Omitting lead keeps it; the lead can be written again and cleared.
    assert!(store.put_tag_spec(tag("lead", None)).await.unwrap().lead);
    assert!(
        store
            .put_tag_spec(tag("lead", Some(true)))
            .await
            .unwrap()
            .lead
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
    assert_eq!(
        listed
            .tags
            .iter()
            .filter(|tag| tag.lead)
            .map(|tag| tag.tag_id.as_str())
            .collect::<Vec<_>>(),
        ["lead"]
    );
    assert!(
        !store
            .put_tag_spec(tag("lead", Some(false)))
            .await
            .unwrap()
            .lead
    );
    assert!(
        store
            .put_tag_spec(tag("peer", Some(true)))
            .await
            .unwrap()
            .lead
    );

    // A retired lead leaves the slot free.
    store.retire_tag("peer", false).await.unwrap();
    assert!(
        store
            .put_tag_spec(tag("lead", Some(true)))
            .await
            .unwrap()
            .lead
    );

    store.close().await;
}

#[tokio::test]
async fn sqlite_lead_tag() {
    let dir = tempfile::tempdir().unwrap();
    exercise(&format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("lead.db").display()
    ))
    .await;
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_lead_tag() {
    let path =
        std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE").expect("test database file");
    let admin_url = std::fs::read_to_string(path).unwrap();
    let database = format!("supertag_rust_lead_tag_{}", Uuid::new_v4().simple());
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
