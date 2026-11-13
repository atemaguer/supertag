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
    let plane = ControlPlane::open(url, SECRET.into(), "operator:local".into()).await?;
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
        output_policy: None,
        execution_limits: None,
        tag_id: "engineer".into(),
        conversation: "secret".into(),
        text: "Hello".into(),
        operation_id: "one-send".into(),
    };
    let sent = store.send_message("operator:alice", &input).await?;
    assert_eq!(store.send_message("operator:alice", &input).await?, sent);
    let parent = sent.task.unwrap();
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
    private_work_sessions(&watch, SECRET, parent).await?;
    Ok(())
}

async fn private_work_sessions(
    watch: &OperatorWatch,
    secret: &str,
    parent: Task,
) -> anyhow::Result<()> {
    use conversations_server::Conversations;
    use live_inputs_server::LiveInputs;
    use operator_server::Operator;
    use work_sessions_server::WorkSessions;

    const ALICE: &str = "operator:alice";
    const BOB: &str = "operator:bob";
    let plane = &watch.plane;
    let store = &plane.store;
    let before = store.watch_page(i64::MAX).await?;
    let work_session_id = "work/private";
    let (mut tx, order) = store.write().await?;
    let child = crate::store::insert_task_from_snapshot(
        &mut tx,
        order,
        &parent,
        work_session_id,
        "Private child request",
    )
    .await?;
    tx.commit().await?;
    assert_eq!(store.watch_page(before.head).await?.head, before.head);
    assert!(matches!(
        store.ensure_task_access(ALICE, &child.task_id).await,
        Err(crate::StoreError::NotFound(_))
    ));

    let (mut tx, _) = store.write().await?;
    sqlx::query("INSERT INTO supertag_v2_work_sessions (work_session_id,title,parent_tag_id,parent_session_id,starter_task_id,tag_id,latest_task_id,objective_id,created_order) VALUES ($1,'Private work',$2,$3,$4,$2,$5,NULL,$6)")
        .bind(work_session_id).bind(&parent.tag_id).bind(&parent.session_id)
        .bind(&parent.task_id).bind(&child.task_id).bind(order).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO supertag_v2_work_session_tasks (task_id,work_session_id,kind) VALUES ($1,$2,1)")
        .bind(&child.task_id).bind(work_session_id).execute(&mut *tx).await?;
    sqlx::query("UPDATE supertag_v2_tasks SET state=$1,attempt_id='attempt',lease_expires_at_ms=$2 WHERE task_id=$3")
        .bind(TaskState::Running as i64).bind(i64::MAX).bind(&child.task_id).execute(&mut *tx).await?;
    tx.commit().await?;

    let (mut tx, order) = store.write().await?;
    let report = crate::store::insert_task(
        &mut tx,
        order,
        &parent.tag_id,
        &parent.session_id,
        "Internal report input",
    )
    .await?;
    sqlx::query("INSERT INTO supertag_v2_work_session_reports (child_task_id,work_session_id,report_task_id,created_order) VALUES ($1,$2,$3,$4)")
        .bind(&child.task_id).bind(work_session_id).bind(&report.task_id).bind(order).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO supertag_v2_work_session_tasks (task_id,work_session_id,kind) VALUES ($1,$2,2)")
        .bind(&report.task_id).bind(work_session_id).execute(&mut *tx).await?;
    tx.commit().await?;

    for task in [&child, &report] {
        let read = GetTaskRequest {
            task_id: task.task_id.clone(),
        };
        assert_eq!(
            plane
                .get_task(authenticated_request(read.clone(), secret, Some(BOB))?)
                .await
                .unwrap_err()
                .code(),
            tonic::Code::NotFound
        );
        assert_eq!(
            plane
                .get_task(authenticated_request(read, secret, Some(ALICE))?)
                .await?
                .into_inner()
                .task_id,
            task.task_id
        );
    }
    let queue = QueueInputRequest {
        task_id: child.task_id.clone(),
        operation_id: "direct-child-input".into(),
        text: "Do not inject".into(),
    };
    assert_eq!(
        plane
            .queue_input(authenticated_request(queue.clone(), secret, Some(BOB))?)
            .await
            .unwrap_err()
            .code(),
        tonic::Code::NotFound
    );
    assert_eq!(
        plane
            .queue_input(authenticated_request(queue, secret, Some(ALICE))?)
            .await
            .unwrap_err()
            .code(),
        tonic::Code::FailedPrecondition
    );

    let get = GetWorkSessionRequest {
        work_session_id: work_session_id.into(),
        report_task_id: None,
    };
    assert_eq!(
        WorkSessions::get(
            plane,
            authenticated_request(get.clone(), secret, Some(BOB))?
        )
        .await
        .unwrap_err()
        .code(),
        tonic::Code::NotFound
    );
    let work = WorkSessions::get(plane, authenticated_request(get, secret, Some(ALICE))?)
        .await?
        .into_inner();
    assert_eq!(
        work.report_task_id.as_deref(),
        Some(report.task_id.as_str())
    );
    assert_eq!(work.latest_task_id, child.task_id);
    let list = ListWorkSessionsRequest {
        parent_tag_id: parent.tag_id.clone(),
        parent_session_id: parent.session_id.clone(),
        ..Default::default()
    };
    assert!(
        WorkSessions::list(
            plane,
            authenticated_request(list.clone(), secret, Some(BOB))?
        )
        .await?
        .into_inner()
        .work_sessions
        .is_empty()
    );
    assert_eq!(
        WorkSessions::list(plane, authenticated_request(list, secret, Some(ALICE))?)
            .await?
            .into_inner()
            .work_sessions,
        vec![work]
    );

    let message = GetMessageRequest {
        tag_id: parent.tag_id.clone(),
        task_id: report.task_id.clone(),
    };
    let response = plane
        .get_message(authenticated_request(message.clone(), secret, Some(ALICE))?)
        .await?
        .into_inner();
    assert_eq!(
        response.work_session_report_id.as_deref(),
        Some(work_session_id)
    );
    assert!(response.task.as_ref().unwrap().prompt.is_empty());
    let summaries = store
        .list_conversations(
            ALICE,
            &ListConversationsRequest {
                tag_id: parent.tag_id.clone(),
                ..Default::default()
            },
        )
        .await?;
    let latest = summaries.conversations[0].latest_task.as_ref().unwrap();
    assert_eq!(latest.task_id, report.task_id);
    assert!(latest.prompt.is_empty());
    assert_eq!(
        store.get_task(&report.task_id).await?.prompt,
        "Internal report input"
    );
    assert_eq!(
        plane
            .get_message(authenticated_request(message, secret, Some(BOB))?)
            .await
            .unwrap_err()
            .code(),
        tonic::Code::NotFound
    );

    let history = ListMessagesRequest {
        tag_id: parent.tag_id.clone(),
        conversation: "secret".into(),
        limit: 1,
        ..Default::default()
    };
    let first = store.list_messages(ALICE, &history).await?;
    assert_eq!(first.messages, vec![response]);
    let next = store
        .list_messages(
            ALICE,
            &ListMessagesRequest {
                cursor: first.next_cursor,
                ..history.clone()
            },
        )
        .await?;
    assert_eq!(
        next.messages[0].task.as_ref().unwrap().task_id,
        parent.task_id
    );
    assert_eq!(
        next.messages[0].task.as_ref().unwrap().prompt,
        parent.prompt
    );
    assert!(next.next_cursor.is_empty());
    assert!(
        store
            .list_messages(BOB, &history)
            .await?
            .messages
            .is_empty()
    );

    let page = store.watch_page(before.head).await?;
    assert_eq!(
        page.notices
            .iter()
            .map(|notice| (
                notice.owner.as_str(),
                notice.change.kind(),
                notice.change.id.as_str(),
                notice.change.conversation.as_str(),
            ))
            .collect::<Vec<_>>(),
        [
            (ALICE, WatchKind::Task, child.task_id.as_str(), "secret"),
            (ALICE, WatchKind::Task, child.task_id.as_str(), "secret"),
            (ALICE, WatchKind::Task, report.task_id.as_str(), "secret"),
            (
                ALICE,
                WatchKind::ConversationMessage,
                report.task_id.as_str(),
                "secret"
            ),
        ]
    );
    let request = |principal| {
        authenticated_request(
            WatchRequest {
                resume_token: format!("v1.{}.{}", before.feed_id, before.head),
                ..Default::default()
            },
            secret,
            Some(principal),
        )
    };
    let mut hidden = watch.watch(request(BOB)?).await?.into_inner();
    assert!(matches!(
        hidden.next().await.transpose()?.unwrap().update,
        Some(Update::Heartbeat(_))
    ));
    let mut visible = watch.watch(request(ALICE)?).await?.into_inner();
    assert!(matches!(
        visible.next().await.transpose()?.unwrap().update,
        Some(Update::Change(change)) if change.id == child.task_id
    ));
    let (mut tx, _) = store.write().await?;
    sqlx::query("UPDATE supertag_v2_tasks SET state=$1,attempt_id='report-attempt',lease_expires_at_ms=$2 WHERE task_id=$3")
        .bind(TaskState::Running as i64).bind(i64::MAX).bind(&report.task_id).execute(&mut *tx).await?;
    // Even if a legacy or inconsistent row names private work, another
    // operator must not obtain the input by guessing its ID.
    sqlx::query("INSERT INTO supertag_v2_live_inputs (input_id,operator_principal,operation_id,task_id,attempt_id,follower_task_id,state) VALUES ('private-input',$1,'stale-private-input',$2,'attempt',$3,$4)")
        .bind(ALICE).bind(&child.task_id).bind(&report.task_id).bind(LiveInputState::Accepted as i64)
        .execute(&mut *tx).await?;
    tx.commit().await?;
    let get = GetInputRequest {
        input_id: "private-input".into(),
    };
    assert_eq!(
        plane
            .get_input(authenticated_request(get.clone(), secret, Some(BOB))?)
            .await
            .unwrap_err()
            .code(),
        tonic::Code::NotFound
    );
    assert_eq!(
        plane
            .get_input(authenticated_request(get, secret, Some(ALICE))?)
            .await?
            .into_inner()
            .task_id,
        child.task_id
    );
    let followup = store
        .send_message(
            ALICE,
            &SendMessageRequest {
                output_policy: None,
                execution_limits: None,
                tag_id: parent.tag_id,
                conversation: "secret".into(),
                text: "Keep going separately".into(),
                operation_id: "report-follow-up".into(),
            },
        )
        .await?;
    assert!(followup.live_input.is_none());
    Ok(())
}

#[tokio::test]
async fn sqlite_client_team_notices() -> anyhow::Result<()> {
    let directory = tempfile::tempdir()?;
    client_team_notices(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("teams.db").display()
    ))
    .await
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_client_team_notices() -> anyhow::Result<()> {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .ok_or_else(|| anyhow::anyhow!("set SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"))?;
    let url = std::fs::read_to_string(path)?;
    let mut admin = sqlx::PgConnection::connect(url.trim()).await?;
    let database = format!(
        "supertag_rust_watch_teams_{}",
        uuid::Uuid::new_v4().simple()
    );
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await?;
    let mut test_url = url::Url::parse(url.trim())?;
    test_url.set_path(&database);
    let result = tokio::task::LocalSet::new()
        .run_until(async move {
            tokio::task::spawn_local(async move { client_team_notices(test_url.as_str()).await })
                .await
        })
        .await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await?;
    result?
}

/// A client watching Teams hears about a Team only when every member is a Tag its key allows.
async fn client_team_notices(url: &str) -> anyhow::Result<()> {
    use sha2::{Digest, Sha256};
    const SECRET: &str = "local-watch-test-secret";
    let plane = ControlPlane::open(url, SECRET.into(), "operator:local".into()).await?;
    let store = &plane.store;
    for tag in ["owner", "other"] {
        store.put_tag(tag, "Watch Teams", vec![]).await?;
    }
    let key = Sha256::digest(b"watching client key").to_vec();
    store
        .create_auth_key(
            "operator:local",
            &CreateAuthKeyRequest {
                name: "watcher".into(),
                role: PrincipalRole::Client.into(),
                operation_id: "watcher-key".into(),
                key_digest: key.clone(),
                allowed_tag_ids: vec!["other".into()],
                ..Default::default()
            },
        )
        .await?;
    store
        .enroll(
            &key,
            &EnrollRequest {
                role: PrincipalRole::Client.into(),
                name: "watcher".into(),
                operation_id: "watcher-enroll".into(),
                token_digest: Sha256::digest(b"watching client credential").to_vec(),
            },
        )
        .await?;
    let start = store.watch_page(0).await?;
    for (team, members) in [("mixed", vec!["other", "owner"]), ("solo", vec!["other"])] {
        store
            .create_team(
                "operator:local",
                &CreateTeamRequest {
                    operation_id: format!("team-{team}"),
                    team_id: team.into(),
                    name: team.into(),
                    member_tag_ids: members.into_iter().map(str::to_owned).collect(),
                    max_concurrency: None,
                },
            )
            .await?;
    }
    let watch = OperatorWatch {
        plane: plane.clone(),
        shutdown: CancellationToken::new(),
    };
    let teams = |principal: &str| {
        authenticated_request(
            WatchRequest {
                kinds: vec![WatchKind::Team as i32],
                resume_token: format!("v1.{}.{}", start.feed_id, start.head),
            },
            SECRET,
            Some(principal),
        )
    };
    let first_team = |mut stream: <OperatorWatch as OperatorEvents>::WatchStream| async move {
        let event = tokio::time::timeout(Duration::from_secs(5), stream.next())
            .await?
            .transpose()?;
        match event.and_then(|event| event.update) {
            Some(Update::Change(change)) => anyhow::Ok(change.team_id),
            other => anyhow::bail!("expected a Team change, got {other:?}"),
        }
    };
    let operator = watch.watch(teams("operator:bob")?).await?.into_inner();
    assert_eq!(first_team(operator).await?, "mixed");
    let client = watch.watch(teams("client:watcher")?).await?.into_inner();
    assert_eq!(first_team(client).await?, "solo");
    Ok(())
}
