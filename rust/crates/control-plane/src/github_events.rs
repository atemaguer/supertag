//! A configured GitHub repository route and both receipt identities are durable.
use super::*;
use supertag_protocol::v2::{
    AcceptGithubEventRequest, AcceptGithubEventResponse, GithubEventAction, GithubEventKind,
};

impl Store {
    pub async fn accept_github_event(
        &self,
        principal: &str,
        input: &AcceptGithubEventRequest,
    ) -> Result<AcceptGithubEventResponse> {
        let account = connector_account(principal)?;
        if account != input.account_id {
            return Err(StoreError::PermissionDenied);
        }
        if !account.strip_prefix("github/").is_some_and(|raw| {
            !raw.is_empty()
                && raw.len() <= 128
                && raw
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        }) {
            return Err(invalid(
                "GitHub connector account must use its provider namespace",
            ));
        }
        name("GitHub delivery ID", &input.delivery_id)?;
        name("Tag ID", &input.tag_id)?;
        text("GitHub prompt", &input.prompt, 128 * 1024)?;
        if input.prompt.trim().is_empty()
            || !repository(&input.repository)
            || [input.repository_id, input.number, input.source_id]
                .iter()
                .any(|id| *id == 0 || *id > i64::MAX as u64)
        {
            return Err(invalid("invalid GitHub event coordinates or content"));
        }
        let kind = GithubEventKind::try_from(input.kind)
            .map_err(|_| invalid("invalid GitHub event kind"))?;
        let action = GithubEventAction::try_from(input.action)
            .map_err(|_| invalid("invalid GitHub event action"))?;
        let valid = match kind {
            GithubEventKind::IssueComment => matches!(
                action,
                GithubEventAction::Created | GithubEventAction::Edited
            ),
            GithubEventKind::Issue => {
                !input.is_pull_request
                    && matches!(
                        action,
                        GithubEventAction::Opened | GithubEventAction::Edited
                    )
            }
            GithubEventKind::PullRequest => {
                input.is_pull_request
                    && matches!(
                        action,
                        GithubEventAction::Opened | GithubEventAction::Edited
                    )
            }
            _ => false,
        };
        if !valid {
            return Err(invalid("unsupported GitHub event action"));
        }
        let repository = input.repository.to_ascii_lowercase();
        let route_digest = hash(&(
            &repository,
            input.repository_id,
            input.number,
            input.kind,
            input.source_id,
            input.is_pull_request,
            &input.tag_id,
        ))?;
        let delivery_digest = hash(&(&route_digest, input.action, &input.prompt))?;
        let (mut tx, order) = self.write().await?;
        let prior = sqlx::query("SELECT request_digest,task_id FROM supertag_v2_github_deliveries WHERE account_id=$1 AND delivery_id=$2")
            .bind(account).bind(&input.delivery_id).fetch_optional(&mut *tx).await?;
        if let Some(prior) = prior {
            if prior.try_get::<String, _>("request_digest")? != delivery_digest {
                return Err(StoreError::Conflict(
                    "GitHub delivery ID was used with different content or routing".into(),
                ));
            }
            let task = task_in(&mut tx, &prior.try_get::<String, _>("task_id")?).await?;
            tx.commit().await?;
            return Ok(AcceptGithubEventResponse { task: Some(task) });
        }
        let route = sqlx::query("SELECT repository,tag_id FROM supertag_v2_github_repositories WHERE account_id=$1 AND repository_id=$2")
            .bind(account).bind(input.repository_id as i64).fetch_optional(&mut *tx).await?;
        if let Some(route) = &route
            && (route.try_get::<String, _>("repository")? != repository
                || route.try_get::<String, _>("tag_id")? != input.tag_id)
        {
            return Err(StoreError::Conflict(
                "GitHub repository route is already bound to a different repository name or Tag"
                    .into(),
            ));
        }
        let logical = sqlx::query("SELECT route_digest,task_id FROM supertag_v2_github_sources WHERE account_id=$1 AND repository_id=$2 AND kind=$3 AND source_id=$4")
            .bind(account).bind(input.repository_id as i64).bind(i64::from(input.kind)).bind(input.source_id as i64).fetch_optional(&mut *tx).await?;
        if let Some(logical) = logical {
            if logical.try_get::<String, _>("route_digest")? != route_digest {
                return Err(StoreError::Conflict(
                    "GitHub logical event was used with different routing".into(),
                ));
            }
            // An edit of an already admitted comment/issue/PR never replaces the
            // original Task or silently starts another turn. A new comment can.
            let task = task_in(&mut tx, &logical.try_get::<String, _>("task_id")?).await?;
            record_delivery(
                &mut tx,
                account,
                &input.delivery_id,
                &delivery_digest,
                &task.task_id,
            )
            .await?;
            tx.commit().await?;
            return Ok(AcceptGithubEventResponse { task: Some(task) });
        }
        let collision: Option<String> = sqlx::query_scalar(
            "SELECT task_id FROM supertag_v2_inbound_events WHERE account_id=$1 AND event_id=$2",
        )
        .bind(account)
        .bind(&input.delivery_id)
        .fetch_optional(&mut *tx)
        .await?;
        if collision.is_some() {
            return Err(StoreError::Conflict(
                "delivery ID was already used by another connector route".into(),
            ));
        }
        let thread_kind = if input.is_pull_request {
            "pull"
        } else {
            "issue"
        };
        let session = format!(
            "github:{account}:{}:{thread_kind}:{}",
            input.repository_id, input.number
        );
        crate::objectives::objective_admission_in(
            &mut tx,
            &input.tag_id,
            &session,
            self.execution_now_ms(),
        )
        .await?;
        let task = insert_task(&mut tx, order, &input.tag_id, &session, &input.prompt).await?;
        crate::objectives::objective_link_task_in(&mut tx, &task).await?;
        if route.is_none() {
            sqlx::query("INSERT INTO supertag_v2_github_repositories (account_id,repository_id,repository,tag_id) VALUES ($1,$2,$3,$4)")
                .bind(account).bind(input.repository_id as i64).bind(&repository).bind(&input.tag_id).execute(&mut *tx).await?;
        }
        let thread = Some(input.number.to_string());
        let source_digest = hash(&(&input.tag_id, &session, &input.prompt, &repository, &thread))?;
        sqlx::query("INSERT INTO supertag_v2_inbound_events (account_id,event_id,request_digest,task_id,conversation_id,thread_id) VALUES ($1,$2,$3,$4,$5,$6)")
            .bind(account).bind(&input.delivery_id).bind(source_digest).bind(&task.task_id).bind(&repository).bind(&thread).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO supertag_v2_github_sources (account_id,repository_id,kind,source_id,route_digest,task_id) VALUES ($1,$2,$3,$4,$5,$6)")
            .bind(account).bind(input.repository_id as i64).bind(i64::from(input.kind)).bind(input.source_id as i64).bind(route_digest).bind(&task.task_id).execute(&mut *tx).await?;
        record_delivery(
            &mut tx,
            account,
            &input.delivery_id,
            &delivery_digest,
            &task.task_id,
        )
        .await?;
        tx.commit().await?;
        Ok(AcceptGithubEventResponse { task: Some(task) })
    }
}

fn hash(value: &impl serde::Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}

fn repository(value: &str) -> bool {
    let parts: Vec<_> = value.split('/').collect();
    parts.len() == 2
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 100
                && *part != "."
                && *part != ".."
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        })
}

async fn record_delivery(
    tx: &mut Transaction<'_, Any>,
    account: &str,
    delivery: &str,
    digest: &str,
    task: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO supertag_v2_github_deliveries (account_id,delivery_id,request_digest,task_id) VALUES ($1,$2,$3,$4)")
        .bind(account).bind(delivery).bind(digest).bind(task).execute(&mut **tx).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Executor};
    fn event(delivery: &str) -> AcceptGithubEventRequest {
        AcceptGithubEventRequest {
            account_id: "github/shared".into(),
            delivery_id: delivery.into(),
            repository_id: 123,
            repository: "acme/project".into(),
            number: 7,
            source_id: 456,
            kind: GithubEventKind::IssueComment.into(),
            action: GithubEventAction::Created.into(),
            prompt: "@supertag inspect first input".into(),
            tag_id: "builder".into(),
            is_pull_request: false,
        }
    }
    async fn contract(url: &str) {
        const PRINCIPAL: &str = "connector:github/shared";
        let store = Store::open(url).await.unwrap();
        for tag in ["builder", "other"] {
            store
                .put_tag(tag, "Original instructions", vec!["files:read".into()])
                .await
                .unwrap();
        }
        let first = event("delivery-original");
        let accepted = store
            .accept_github_event(PRINCIPAL, &first)
            .await
            .unwrap()
            .task
            .unwrap();
        assert_eq!(accepted.session_id, "github:github/shared:123:issue:7");
        assert_eq!(accepted.prompt, first.prompt);
        store.close().await;
        let left = Store::open(url).await.unwrap();
        let right = Store::open(url).await.unwrap();
        let (a, b) = tokio::join!(
            left.accept_github_event(PRINCIPAL, &first),
            right.accept_github_event(PRINCIPAL, &first)
        );
        assert_eq!(a.unwrap().task, Some(accepted.clone()));
        assert_eq!(b.unwrap().task, Some(accepted.clone()));
        let mut changed = first.clone();
        changed.prompt = "@supertag changed delivery".into();
        assert!(matches!(
            left.accept_github_event(PRINCIPAL, &changed).await,
            Err(StoreError::Conflict(_))
        ));
        changed.delivery_id = "delivery-edit".into();
        changed.action = GithubEventAction::Edited.into();
        left.put_tag("builder", "New instructions", vec![])
            .await
            .unwrap();
        let replay = right
            .accept_github_event(PRINCIPAL, &changed)
            .await
            .unwrap()
            .task
            .unwrap();
        assert_eq!(
            replay, accepted,
            "an edit is the original logical input, not a new Task"
        );
        changed.prompt = "a changed replay of the edit delivery".into();
        assert!(matches!(
            right.accept_github_event(PRINCIPAL, &changed).await,
            Err(StoreError::Conflict(_))
        ));
        for coordinate in ["number", "tag", "repository"] {
            let mut conflict = event("delivery-route-conflict");
            match coordinate {
                "number" => conflict.number = 8,
                "tag" => conflict.tag_id = "other".into(),
                "repository" => conflict.repository = "acme/other".into(),
                _ => unreachable!(),
            }
            assert!(
                matches!(
                    left.accept_github_event(PRINCIPAL, &conflict).await,
                    Err(StoreError::Conflict(_))
                ),
                "accepted changed {coordinate}"
            );
        }
        let mut next = event("delivery-new-comment");
        next.source_id = 457;
        next.prompt = "@supertag next turn".into();
        let next = right
            .accept_github_event(PRINCIPAL, &next)
            .await
            .unwrap()
            .task
            .unwrap();
        assert_ne!(next.task_id, accepted.task_id);
        assert_eq!(next.session_id, accepted.session_id);
        assert_eq!(next.instructions, "New instructions");
        // A mention added in an edit is valid when that object has never been admitted.
        let mut edited_first = event("delivery-first-seen-edit");
        edited_first.source_id = 458;
        edited_first.action = GithubEventAction::Edited.into();
        assert!(
            left.accept_github_event(PRINCIPAL, &edited_first)
                .await
                .unwrap()
                .task
                .is_some()
        );
        let mut wrong_account = first.clone();
        wrong_account.account_id = "github/other".into();
        assert!(matches!(
            left.accept_github_event(PRINCIPAL, &wrong_account).await,
            Err(StoreError::PermissionDenied)
        ));
        wrong_account.account_id = "shared".into();
        assert!(matches!(
            left.accept_github_event("connector:shared", &wrong_account)
                .await,
            Err(StoreError::InvalidArgument(_))
        ));
        let slack = supertag_protocol::v2::AcceptSlackEventRequest {
            account_id: "shared".into(),
            event_id: "EvSAMEACCOUNT".into(),
            team_id: "TTEAM1".into(),
            channel_id: "CCHANNEL1".into(),
            message_ts: "1794470000.100000".into(),
            thread_ts: "1794470000.100000".into(),
            prompt: "Slack uses the same configured account text".into(),
            mention_tag_id: Some("builder".into()),
        };
        let slack_task = left
            .accept_slack_event("connector:shared", &slack)
            .await
            .unwrap()
            .task
            .unwrap();
        assert_ne!(slack_task.session_id, accepted.session_id);
        let accounts: Vec<String> = sqlx::query_scalar(
            "SELECT DISTINCT account_id FROM supertag_v2_inbound_events ORDER BY account_id",
        )
        .fetch_all(&left.pool)
        .await
        .unwrap();
        assert_eq!(accounts, vec!["github/shared", "shared"]);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_tasks")
            .fetch_one(&left.pool)
            .await
            .unwrap();
        assert_eq!(count, 4);
        left.close().await;
        right.close().await;
    }
    #[tokio::test]
    async fn sqlite_github_delivery_and_logical_replay_survive_restart() {
        let directory = tempfile::tempdir().unwrap();
        contract(&format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("github.db").display()
        ))
        .await;
    }
    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
    async fn postgres_github_delivery_and_logical_replay_survive_restart() {
        let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
            .expect("PostgreSQL test URL file required");
        let admin_url = std::fs::read_to_string(path).unwrap();
        let name = format!("supertag_rust_github_{}", Uuid::new_v4().simple());
        let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
        admin
            .execute(format!("CREATE DATABASE {name}").as_str())
            .await
            .unwrap();
        let mut url = url::Url::parse(admin_url.trim()).unwrap();
        url.set_path(&name);
        let local = tokio::task::LocalSet::new();
        let result = local
            .run_until(async move {
                tokio::task::spawn_local(async move {
                    contract(url.as_str()).await;
                })
                .await
            })
            .await;
        admin
            .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
            .await
            .unwrap();
        admin.close().await.unwrap();
        result.expect("PostgreSQL GitHub contract failed");
    }
}
