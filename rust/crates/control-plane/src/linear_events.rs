//! Durable Linear routes and first-admitted issue/comment identities.
use super::*;
use supertag_protocol::v2::{
    AcceptLinearEventRequest, AcceptLinearEventResponse, LinearEventAction, LinearEventKind,
};

impl Store {
    pub async fn accept_linear_event(
        &self,
        principal: &str,
        input: &AcceptLinearEventRequest,
    ) -> Result<AcceptLinearEventResponse> {
        let account = connector_account(principal)?;
        if account != input.account_id {
            return Err(StoreError::PermissionDenied);
        }
        if !account.strip_prefix("linear/").is_some_and(|raw| {
            !raw.is_empty()
                && raw.len() <= 128
                && raw
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
        }) {
            return Err(invalid(
                "Linear connector account must use its provider namespace",
            ));
        }
        name("Linear delivery ID", &input.delivery_id)?;
        name("Tag ID", &input.tag_id)?;
        text("Linear prompt", &input.prompt, 128 * 1024)?;
        if input.prompt.trim().is_empty()
            || [
                &input.workspace_id,
                &input.team_id,
                &input.issue_id,
                &input.source_id,
            ]
            .iter()
            .any(|id| !canonical_uuid(id))
        {
            return Err(invalid("invalid Linear event coordinates or content"));
        }
        let kind = LinearEventKind::try_from(input.kind)
            .map_err(|_| invalid("invalid Linear event kind"))?;
        let action = LinearEventAction::try_from(input.action)
            .map_err(|_| invalid("invalid Linear event action"))?;
        if !matches!(kind, LinearEventKind::Issue | LinearEventKind::IssueComment)
            || !matches!(
                action,
                LinearEventAction::Create | LinearEventAction::Update
            )
            || (kind == LinearEventKind::Issue && input.source_id != input.issue_id)
        {
            return Err(invalid("unsupported Linear event kind or action"));
        }
        let route_digest = hash(&(
            &input.workspace_id,
            &input.team_id,
            &input.issue_id,
            &input.source_id,
            input.kind,
            &input.tag_id,
        ))?;
        let digest = hash(&(&route_digest, input.action, &input.prompt))?;
        let (mut tx, order) = self.write().await?;
        let prior = sqlx::query("SELECT request_digest,task_id FROM supertag_v2_linear_deliveries WHERE account_id=$1 AND delivery_id=$2")
            .bind(account).bind(&input.delivery_id).fetch_optional(&mut *tx).await?;
        if let Some(prior) = prior {
            if prior.try_get::<String, _>("request_digest")? != digest {
                return Err(StoreError::Conflict(
                    "Linear delivery ID was used with different content or routing".into(),
                ));
            }
            let task = task_in(&mut tx, &prior.try_get::<String, _>("task_id")?).await?;
            tx.commit().await?;
            return Ok(AcceptLinearEventResponse { task: Some(task) });
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
        let route = sqlx::query(
            "SELECT workspace_id,team_id,tag_id FROM supertag_v2_linear_routes WHERE account_id=$1",
        )
        .bind(account)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(route) = &route
            && (route.try_get::<String, _>("workspace_id")? != input.workspace_id
                || route.try_get::<String, _>("team_id")? != input.team_id
                || route.try_get::<String, _>("tag_id")? != input.tag_id)
        {
            return Err(StoreError::Conflict(
                "Linear account is already bound to a different workspace, team, or Tag".into(),
            ));
        }
        let logical = sqlx::query("SELECT route_digest,task_id FROM supertag_v2_linear_sources WHERE account_id=$1 AND workspace_id=$2 AND kind=$3 AND source_id=$4")
            .bind(account).bind(&input.workspace_id).bind(i64::from(input.kind)).bind(&input.source_id).fetch_optional(&mut *tx).await?;
        if let Some(logical) = logical {
            if logical.try_get::<String, _>("route_digest")? != route_digest {
                return Err(StoreError::Conflict(
                    "Linear logical event was used with different routing".into(),
                ));
            }
            let task = task_in(&mut tx, &logical.try_get::<String, _>("task_id")?).await?;
            record_delivery(&mut tx, account, &input.delivery_id, &digest, &task.task_id).await?;
            tx.commit().await?;
            return Ok(AcceptLinearEventResponse { task: Some(task) });
        }
        let session = format!(
            "linear:{account}:{}:issue:{}",
            input.workspace_id, input.issue_id
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
            sqlx::query("INSERT INTO supertag_v2_linear_routes (account_id,workspace_id,team_id,tag_id) VALUES ($1,$2,$3,$4)")
                .bind(account).bind(&input.workspace_id).bind(&input.team_id).bind(&input.tag_id).execute(&mut *tx).await?;
        }
        let thread: Option<String> = None;
        let source_digest = hash(&(
            &input.tag_id,
            &session,
            &input.prompt,
            &input.issue_id,
            &thread,
        ))?;
        sqlx::query("INSERT INTO supertag_v2_inbound_events (account_id,event_id,request_digest,task_id,conversation_id,thread_id) VALUES ($1,$2,$3,$4,$5,$6)")
            .bind(account).bind(&input.delivery_id).bind(source_digest).bind(&task.task_id).bind(&input.issue_id).bind(thread).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO supertag_v2_linear_sources (account_id,workspace_id,kind,source_id,route_digest,task_id) VALUES ($1,$2,$3,$4,$5,$6)")
            .bind(account).bind(&input.workspace_id).bind(i64::from(input.kind)).bind(&input.source_id).bind(route_digest).bind(&task.task_id).execute(&mut *tx).await?;
        record_delivery(&mut tx, account, &input.delivery_id, &digest, &task.task_id).await?;
        tx.commit().await?;
        Ok(AcceptLinearEventResponse { task: Some(task) })
    }
}
fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| !id.is_nil() && id.hyphenated().to_string() == value)
}
fn hash(value: &impl serde::Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
async fn record_delivery(
    tx: &mut Transaction<'_, Any>,
    account: &str,
    delivery: &str,
    digest: &str,
    task: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO supertag_v2_linear_deliveries (account_id,delivery_id,request_digest,task_id) VALUES ($1,$2,$3,$4)")
        .bind(account).bind(delivery).bind(digest).bind(task).execute(&mut **tx).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Executor};
    const WORKSPACE: &str = "11111111-1111-4111-8111-111111111111";
    const TEAM: &str = "22222222-2222-4222-8222-222222222222";
    const ISSUE: &str = "33333333-3333-4333-8333-333333333333";
    const COMMENT: &str = "44444444-4444-4444-8444-444444444444";
    fn event(delivery: &str) -> AcceptLinearEventRequest {
        AcceptLinearEventRequest {
            account_id: "linear/shared".into(),
            delivery_id: delivery.into(),
            workspace_id: WORKSPACE.into(),
            team_id: TEAM.into(),
            issue_id: ISSUE.into(),
            source_id: COMMENT.into(),
            kind: LinearEventKind::IssueComment.into(),
            action: LinearEventAction::Create.into(),
            prompt: "@supertag inspect this issue".into(),
            tag_id: "builder".into(),
        }
    }
    async fn contract(url: &str) {
        const PRINCIPAL: &str = "connector:linear/shared";
        let store = Store::open(url).await.unwrap();
        for tag in ["builder", "other"] {
            store
                .put_tag(tag, "Original", vec!["files:read".into()])
                .await
                .unwrap();
        }
        let input = event("delivery-original");
        let original = store
            .accept_linear_event(PRINCIPAL, &input)
            .await
            .unwrap()
            .task
            .unwrap();
        assert_eq!(
            original.session_id,
            format!("linear:linear/shared:{WORKSPACE}:issue:{ISSUE}")
        );
        store.close().await;
        let left = Store::open(url).await.unwrap();
        let right = Store::open(url).await.unwrap();
        let (a, b) = tokio::join!(
            left.accept_linear_event(PRINCIPAL, &input),
            right.accept_linear_event(PRINCIPAL, &input)
        );
        assert_eq!(a.unwrap().task, Some(original.clone()));
        assert_eq!(b.unwrap().task, Some(original.clone()));
        let mut changed = input.clone();
        changed.prompt = "changed".into();
        assert!(matches!(
            left.accept_linear_event(PRINCIPAL, &changed).await,
            Err(StoreError::Conflict(_))
        ));
        changed.delivery_id = "delivery-edit".into();
        changed.action = LinearEventAction::Update.into();
        left.put_tag("builder", "New instructions", vec![])
            .await
            .unwrap();
        assert_eq!(
            right
                .accept_linear_event(PRINCIPAL, &changed)
                .await
                .unwrap()
                .task,
            Some(original.clone())
        );
        changed.prompt = "another changed payload".into();
        assert!(matches!(
            left.accept_linear_event(PRINCIPAL, &changed).await,
            Err(StoreError::Conflict(_))
        ));
        for coordinate in ["workspace", "team", "issue", "tag"] {
            let mut changed = event("changed-route");
            match coordinate {
                "workspace" => changed.workspace_id = Uuid::new_v4().to_string(),
                "team" => changed.team_id = Uuid::new_v4().to_string(),
                "issue" => changed.issue_id = Uuid::new_v4().to_string(),
                "tag" => changed.tag_id = "other".into(),
                _ => unreachable!(),
            }
            assert!(
                matches!(
                    right.accept_linear_event(PRINCIPAL, &changed).await,
                    Err(StoreError::Conflict(_))
                ),
                "accepted changed {coordinate}"
            );
        }
        let mut next = event("new-comment");
        next.source_id = Uuid::new_v4().to_string();
        let next = right
            .accept_linear_event(PRINCIPAL, &next)
            .await
            .unwrap()
            .task
            .unwrap();
        assert_ne!(next.task_id, original.task_id);
        assert_eq!(next.session_id, original.session_id);
        assert_eq!(next.instructions, "New instructions");
        let mut issue = event("issue-update-first-seen");
        issue.kind = LinearEventKind::Issue.into();
        issue.action = LinearEventAction::Update.into();
        issue.source_id = issue.issue_id.clone();
        assert!(
            left.accept_linear_event(PRINCIPAL, &issue)
                .await
                .unwrap()
                .task
                .is_some()
        );
        let mut invalid = event("invalid");
        invalid.source_id = "not-a-uuid".into();
        assert!(matches!(
            left.accept_linear_event(PRINCIPAL, &invalid).await,
            Err(StoreError::InvalidArgument(_))
        ));
        invalid = input.clone();
        invalid.account_id = "shared".into();
        assert!(matches!(
            left.accept_linear_event("connector:shared", &invalid).await,
            Err(StoreError::InvalidArgument(_))
        ));
        assert!(matches!(
            left.accept_linear_event("connector:linear/other", &input)
                .await,
            Err(StoreError::PermissionDenied)
        ));
        let github = supertag_protocol::v2::AcceptGithubEventRequest {
            account_id: "github/shared".into(),
            delivery_id: input.delivery_id.clone(),
            repository_id: 123,
            repository: "acme/project".into(),
            number: 7,
            source_id: 456,
            kind: supertag_protocol::v2::GithubEventKind::IssueComment.into(),
            action: supertag_protocol::v2::GithubEventAction::Created.into(),
            prompt: "@supertag separate provider".into(),
            tag_id: "builder".into(),
            is_pull_request: false,
        };
        let github = left
            .accept_github_event("connector:github/shared", &github)
            .await
            .unwrap()
            .task
            .unwrap();
        assert_ne!(github.task_id, original.task_id);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM supertag_v2_tasks")
                .fetch_one(&left.pool)
                .await
                .unwrap(),
            4
        );
        left.close().await;
        right.close().await;
    }
    #[tokio::test]
    async fn sqlite_linear_routes_and_receipts_survive_restart() {
        let dir = tempfile::tempdir().unwrap();
        contract(&format!(
            "sqlite://{}?mode=rwc",
            dir.path().join("linear.db").display()
        ))
        .await;
    }
    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
    async fn postgres_linear_routes_and_receipts_survive_restart() {
        let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
            .expect("PostgreSQL test URL file required");
        let admin_url = std::fs::read_to_string(path).unwrap();
        let name = format!("supertag_rust_linear_{}", Uuid::new_v4().simple());
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
        result.expect("PostgreSQL Linear contract failed");
    }
}
