use super::*;
use operator_events_server::OperatorEvents;
use sqlx::{Connection, Executor};
use supertag_protocol::authenticated_request;
use tokio_stream::StreamExt;
use watch_event::Update;

#[tokio::test]
async fn sqlite_watch_contract() -> anyhow::Result<()> {
    let directory = tempfile::tempdir()?;
    contract(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("watch.db").display()
    ))
    .await
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_watch_contract() -> anyhow::Result<()> {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .ok_or_else(|| anyhow::anyhow!("set SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"))?;
    let url = std::fs::read_to_string(path)?;
    let mut admin = sqlx::PgConnection::connect(url.trim()).await?;
    let database = format!("supertag_rust_watch_{}", uuid::Uuid::new_v4().simple());
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await?;
    let mut test_url = url::Url::parse(url.trim())?;
    test_url.set_path(&database);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { contract(test_url.as_str()).await }).await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await?;
    result?
}

async fn contract(url: &str) -> anyhow::Result<()> {
    const SECRET: &str = "local-watch-test-secret";
    let plane = ControlPlane::open(url, SECRET.into()).await?;
    let store = &plane.store;
    let initial = store.watch_page(0).await?;
    assert_eq!(initial.head, 0);
    assert!(initial.notices.is_empty());
    assert_eq!(initial.feed_id.len(), 32);

    let (mut tx, _) = store.write().await?;
    sqlx::query("INSERT INTO supertag_v2_tags (tag_id,instructions,allowed_actions,revision) VALUES ('rollback','x','[]',1)")
        .execute(&mut *tx).await?;
    tx.rollback().await?;
    assert_eq!(store.watch_page(0).await?.head, 0);

    store.put_tag("engineer", "Watch changes", vec![]).await?;
    let input = SendMessageRequest {
        tag_id: "engineer".into(),
        conversation: "secret".into(),
        text: "Hello".into(),
        operation_id: "one-send".into(),
    };
    let sent = store.send_message("operator:alice", &input).await?;
    assert_eq!(store.send_message("operator:alice", &input).await?, sent);
    let page = store.watch_page(0).await?;
    assert_eq!(page.head, 3);
    assert_eq!(
        page.notices
            .iter()
            .map(|n| (n.position, n.owner.as_str(), n.change.kind()))
            .collect::<Vec<_>>(),
        [
            (1, "", WatchKind::Tag),
            (2, "operator:alice", WatchKind::Task),
            (3, "operator:alice", WatchKind::ConversationMessage)
        ]
    );
    assert!(
        page.notices
            .iter()
            .all(|notice| notice.change.changed_at_ms > 0)
    );

    let watch = OperatorWatch {
        plane: plane.clone(),
        shutdown: CancellationToken::new(),
    };
    let request = |resume_token: String| {
        authenticated_request(
            WatchRequest {
                resume_token,
                ..Default::default()
            },
            SECRET,
            Some("operator:bob"),
        )
    };
    let resume = format!("v1.{}.1", page.feed_id);
    let mut hidden = watch.watch(request(resume.clone())?).await?.into_inner();
    let event = hidden
        .next()
        .await
        .transpose()?
        .expect("hidden-only replay heartbeat");
    assert!(matches!(event.update, Some(Update::Heartbeat(_))));
    assert!(event.resume_token.ends_with(".3"));

    assert_eq!(
        watch
            .watch(request(format!("v1.{}.999", page.feed_id))?)
            .await
            .err()
            .unwrap()
            .code(),
        tonic::Code::InvalidArgument
    );
    let mut foreign = watch
        .watch(request(format!("v1.{}.1", "b".repeat(32)))?)
        .await?
        .into_inner();
    assert!(matches!(
        foreign.next().await.transpose()?.unwrap().update,
        Some(Update::Resync(_))
    ));

    store.retain_watch(1).await?;
    let retained = store.watch_page(0).await?;
    assert_eq!(
        (retained.floor, retained.head, retained.notices.len()),
        (2, 3, 1)
    );
    let mut stale = watch.watch(request(resume)?).await?.into_inner();
    assert!(matches!(
        stale.next().await.transpose()?.unwrap().update,
        Some(Update::Resync(_))
    ));

    let mut slow = watch
        .watch(authenticated_request(
            WatchRequest {
                kinds: vec![WatchKind::Tag as i32],
                ..Default::default()
            },
            SECRET,
            Some("operator:bob"),
        )?)
        .await?
        .into_inner();
    assert!(matches!(
        slow.next().await.transpose()?.unwrap().update,
        Some(Update::Heartbeat(_))
    ));
    let (mut tx, _) = store.write().await?;
    for number in 0..PAGE_SIZE + 2 {
        sqlx::query("INSERT INTO supertag_v2_tags (tag_id,instructions,allowed_actions,revision) VALUES ($1,'x','[]',1)")
            .bind(format!("bulk-{number}")).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    assert!(matches!(
        slow.next().await.transpose()?.unwrap().update,
        Some(Update::Change(_))
    ));
    store.retain_watch(1).await?;
    let resynced = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = slow.next().await.transpose()? {
            if matches!(event.update, Some(Update::Resync(_))) {
                return Ok::<_, Status>(Some(event.resume_token));
            }
        }
        Ok(None)
    })
    .await??;
    assert_eq!(
        resynced,
        Some(format!("v1.{}.{}", page.feed_id, page.head + PAGE_SIZE + 2))
    );
    Ok(())
}
