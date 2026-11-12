//! Durable Microsoft Teams activity routing and authenticated reply destinations.
use super::*;
use crate::surface_policy::{VerifiedConnectorOrigin, VerifiedScope, admit_connector_task_in};
use supertag_protocol::v2::{
    AcceptMicrosoftTeamsActivityRequest, AcceptMicrosoftTeamsActivityResponse,
    GetMicrosoftTeamsReplyRouteRequest, MicrosoftTeamsReplyRoute,
};

impl Store {
    pub async fn accept_microsoft_teams_activity(
        &self,
        principal: &str,
        input: &AcceptMicrosoftTeamsActivityRequest,
    ) -> Result<AcceptMicrosoftTeamsActivityResponse> {
        let account = connector_account(principal)?;
        if account != input.account_id || !account.strip_prefix("teams/").is_some_and(valid_account)
        {
            return Err(StoreError::PermissionDenied);
        }
        for (label, value) in [
            ("Tag", &input.tag_id),
            ("channel", &input.channel_id),
            ("conversation", &input.conversation_id),
            ("activity", &input.activity_id),
            ("actor", &input.actor_id),
        ] {
            name(label, value)?;
        }
        if [&input.app_id, &input.tenant_id, &input.team_id]
            .iter()
            .any(|id| !uuid_id(id))
            || !numeric_id(&input.root_activity_id)
            || !valid_service_url(&input.service_url)
        {
            return Err(invalid("invalid Microsoft Teams activity coordinates"));
        }
        text("Microsoft Teams prompt", &input.prompt, 128 * 1024)?;
        if input.prompt.trim().is_empty() {
            return Err(invalid("Microsoft Teams prompt is required"));
        }
        let digest = hash(&(
            &input.app_id,
            &input.tenant_id,
            &input.team_id,
            &input.channel_id,
            &input.conversation_id,
            &input.activity_id,
            &input.root_activity_id,
            &input.actor_id,
            &input.service_url,
            &input.prompt,
            &input.tag_id,
        ))?;
        let (mut tx, order) = self.write().await?;
        let prior=sqlx::query("SELECT request_digest,task_id FROM supertag_v2_microsoft_teams_activities WHERE account_id=$1 AND conversation_id=$2 AND activity_id=$3").bind(account).bind(&input.conversation_id).bind(&input.activity_id).fetch_optional(&mut *tx).await?;
        if let Some(prior) = prior {
            if prior.try_get::<String, _>("request_digest")? != digest {
                return Err(StoreError::Conflict(
                    "Microsoft Teams activity changed content or routing".into(),
                ));
            }
            let task = task_in(&mut tx, &prior.try_get::<String, _>("task_id")?).await?;
            tx.commit().await?;
            return Ok(AcceptMicrosoftTeamsActivityResponse { task: Some(task) });
        }
        let route=sqlx::query("SELECT app_id,tenant_id,team_id,channel_id,tag_id FROM supertag_v2_microsoft_teams_routes WHERE account_id=$1").bind(account).fetch_optional(&mut *tx).await?;
        if let Some(route) = &route {
            for (column, expected) in [
                ("app_id", &input.app_id),
                ("tenant_id", &input.tenant_id),
                ("team_id", &input.team_id),
                ("channel_id", &input.channel_id),
                ("tag_id", &input.tag_id),
            ] {
                if route.try_get::<String, _>(column)? != *expected {
                    return Err(StoreError::Conflict(
                        "Microsoft Teams account is bound to another app, tenant, channel, or Tag"
                            .into(),
                    ));
                }
            }
        }
        let session = format!(
            "teams:{account}:{}:{}:{}",
            input.tenant_id, input.conversation_id, input.root_activity_id
        );
        let Some(task) = admit_connector_task_in(
            &mut tx,
            order,
            VerifiedConnectorOrigin {
                connector_account_id: account,
                tag_id: &input.tag_id,
                scope: VerifiedScope::MicrosoftTeams {
                    app_id: &input.app_id,
                    tenant_id: &input.tenant_id,
                    team_id: &input.team_id,
                    channel_id: &input.channel_id,
                },
            },
            &session,
            &input.prompt,
            self.execution_now_ms(),
        )
        .await?
        else {
            tx.commit().await?;
            return Ok(AcceptMicrosoftTeamsActivityResponse { task: None });
        };
        if route.is_none() {
            sqlx::query("INSERT INTO supertag_v2_microsoft_teams_routes (account_id,app_id,tenant_id,team_id,channel_id,tag_id) VALUES ($1,$2,$3,$4,$5,$6)").bind(account).bind(&input.app_id).bind(&input.tenant_id).bind(&input.team_id).bind(&input.channel_id).bind(&input.tag_id).execute(&mut *tx).await?;
        }
        let event = hash(&(&input.tenant_id, &input.conversation_id, &input.activity_id))?;
        let thread = Some(input.root_activity_id.clone());
        let source = hash(&(
            &input.tag_id,
            &session,
            &input.prompt,
            &input.conversation_id,
            &thread,
        ))?;
        sqlx::query("INSERT INTO supertag_v2_inbound_events (account_id,event_id,request_digest,task_id,conversation_id,thread_id) VALUES ($1,$2,$3,$4,$5,$6)").bind(account).bind(event).bind(source).bind(&task.task_id).bind(&input.conversation_id).bind(thread).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO supertag_v2_microsoft_teams_activities (account_id,conversation_id,activity_id,root_activity_id,service_url,request_digest,task_id) VALUES ($1,$2,$3,$4,$5,$6,$7)").bind(account).bind(&input.conversation_id).bind(&input.activity_id).bind(&input.root_activity_id).bind(&input.service_url).bind(digest).bind(&task.task_id).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(AcceptMicrosoftTeamsActivityResponse { task: Some(task) })
    }
    pub async fn get_microsoft_teams_reply_route(
        &self,
        principal: &str,
        input: &GetMicrosoftTeamsReplyRouteRequest,
    ) -> Result<MicrosoftTeamsReplyRoute> {
        let account = connector_account(principal)?;
        if !account.strip_prefix("teams/").is_some_and(valid_account) {
            return Err(StoreError::PermissionDenied);
        }
        name("reply ID", &input.reply_id)?;
        name("lease token", &input.lease_token)?;
        let row=sqlx::query("SELECT a.service_url,a.conversation_id,a.root_activity_id,c.app_id,c.tenant_id,c.team_id,c.channel_id FROM supertag_v2_replies r JOIN supertag_v2_microsoft_teams_activities a ON a.task_id=r.task_id AND a.account_id=r.account_id JOIN supertag_v2_microsoft_teams_routes c ON c.account_id=a.account_id WHERE r.reply_id=$1 AND r.account_id=$2 AND r.lease_token=$3 AND r.state=$4").bind(&input.reply_id).bind(account).bind(&input.lease_token).bind(i64::from(ReplyState::Claimed as i32)).fetch_optional(&self.pool).await?.ok_or(StoreError::PermissionDenied)?;
        Ok(MicrosoftTeamsReplyRoute {
            service_url: row.try_get("service_url")?,
            conversation_id: row.try_get("conversation_id")?,
            root_activity_id: row.try_get("root_activity_id")?,
            app_id: row.try_get("app_id")?,
            tenant_id: row.try_get("tenant_id")?,
            team_id: row.try_get("team_id")?,
            channel_id: row.try_get("channel_id")?,
        })
    }
}
fn valid_account(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}
fn uuid_id(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| !id.is_nil() && id.hyphenated().to_string() == value)
}
fn numeric_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value.bytes().all(|b| b.is_ascii_digit())
        && value.bytes().any(|b| b != b'0')
}
fn valid_service_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|u| {
        value.len() <= 2048
            && u.scheme() == "https"
            && u.username().is_empty()
            && u.password().is_none()
            && u.query().is_none()
            && u.fragment().is_none()
            && u.port().is_none()
            && u.host_str()
                .is_some_and(|h| h.contains('.') && h.parse::<std::net::IpAddr>().is_err())
    })
}
fn hash(value: &impl serde::Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Executor};
    const PRINCIPAL: &str = "connector:teams/shared";
    fn event(id: &str) -> AcceptMicrosoftTeamsActivityRequest {
        AcceptMicrosoftTeamsActivityRequest {
            account_id: "teams/shared".into(),
            app_id: "11111111-1111-4111-8111-111111111111".into(),
            tenant_id: "22222222-2222-4222-8222-222222222222".into(),
            team_id: "33333333-3333-4333-8333-333333333333".into(),
            channel_id: "19:channel@thread.tacv2".into(),
            conversation_id: "19:conversation@thread.tacv2".into(),
            activity_id: id.into(),
            root_activity_id: "1741000000000".into(),
            actor_id: "44444444-4444-4444-8444-444444444444".into(),
            service_url: "https://smba.trafficmanager.net/amer/".into(),
            prompt: "Inspect this".into(),
            tag_id: "builder".into(),
        }
    }
    async fn contract(url: &str) {
        let store = Store::open(url).await.unwrap();
        store
            .put_tag("builder", "Original", vec!["files:read".into()])
            .await
            .unwrap();
        store.put_tag("other", "Other", vec![]).await.unwrap();
        let input = event("1741000000001");
        let original = store
            .accept_microsoft_teams_activity(PRINCIPAL, &input)
            .await
            .unwrap()
            .task
            .unwrap();
        store.close().await;
        let left = Store::open(url).await.unwrap();
        let right = Store::open(url).await.unwrap();
        let (a, b) = tokio::join!(
            left.accept_microsoft_teams_activity(PRINCIPAL, &input),
            right.accept_microsoft_teams_activity(PRINCIPAL, &input)
        );
        assert_eq!(a.unwrap().task, Some(original.clone()));
        assert_eq!(b.unwrap().task, Some(original.clone()));
        for field in ["text", "url", "tenant", "app", "actor", "tag", "root"] {
            let mut changed = input.clone();
            match field {
                "text" => changed.prompt = "different".into(),
                "url" => changed.service_url = "https://smba.trafficmanager.net/emea/".into(),
                "tenant" => changed.tenant_id = changed.app_id.clone(),
                "app" => changed.app_id = changed.tenant_id.clone(),
                "actor" => changed.actor_id = changed.app_id.clone(),
                "tag" => changed.tag_id = "other".into(),
                _ => changed.root_activity_id = "1741000000009".into(),
            };
            assert!(
                matches!(
                    left.accept_microsoft_teams_activity(PRINCIPAL, &changed)
                        .await,
                    Err(StoreError::Conflict(_))
                ),
                "{field}"
            );
        }
        left.put_tag("builder", "Updated", vec![]).await.unwrap();
        let next = left
            .accept_microsoft_teams_activity(PRINCIPAL, &event("1741000000002"))
            .await
            .unwrap()
            .task
            .unwrap();
        assert_eq!(next.session_id, original.session_id);
        assert_eq!(next.instructions, "Updated");
        assert_eq!(original.instructions, "Original");
        let mut another = input.clone();
        another.conversation_id = "19:another-conversation".into();
        let distinct = left
            .accept_microsoft_teams_activity(PRINCIPAL, &another)
            .await
            .unwrap()
            .task
            .unwrap();
        assert_ne!(distinct.task_id, original.task_id);
        assert!(matches!(
            left.accept_microsoft_teams_activity("connector:shared", &input)
                .await,
            Err(StoreError::PermissionDenied)
        ));
        // The route is available only to the connector holding this reply's actual claim.
        let reply = Uuid::new_v4().to_string();
        let lease = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO supertag_v2_replies (reply_id,task_id,account_id,conversation_id,thread_id,text,state,lease_token,ready_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1)").bind(&reply).bind(&original.task_id).bind(&input.account_id).bind(&input.conversation_id).bind(&input.root_activity_id).bind("result").bind(i64::from(ReplyState::Claimed as i32)).bind(&lease).execute(&left.pool).await.unwrap();
        let request = GetMicrosoftTeamsReplyRouteRequest {
            reply_id: reply,
            lease_token: lease,
        };
        let route = left
            .get_microsoft_teams_reply_route(PRINCIPAL, &request)
            .await
            .unwrap();
        assert_eq!(route.service_url, input.service_url);
        assert_eq!(route.root_activity_id, input.root_activity_id);
        let mut wrong = request.clone();
        wrong.lease_token = "wrong".into();
        assert!(
            left.get_microsoft_teams_reply_route(PRINCIPAL, &wrong)
                .await
                .is_err()
        );
        assert!(
            left.get_microsoft_teams_reply_route("connector:teams/other", &request)
                .await
                .is_err()
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM supertag_v2_tasks")
                .fetch_one(&left.pool)
                .await
                .unwrap(),
            3
        );
        left.close().await;
        right.close().await;
    }
    #[tokio::test]
    async fn sqlite_microsoft_teams_receipts_and_routes() {
        let dir = tempfile::tempdir().unwrap();
        contract(&format!(
            "sqlite://{}?mode=rwc",
            dir.path().join("teams.db").display()
        ))
        .await;
    }
    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
    async fn postgres_microsoft_teams_receipts_and_routes() {
        let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
            .expect("PostgreSQL file required");
        let raw = std::fs::read_to_string(path).unwrap();
        let name = format!("supertag_rust_ms_teams_{}", Uuid::new_v4().simple());
        let mut admin = sqlx::PgConnection::connect(raw.trim()).await.unwrap();
        admin
            .execute(format!("CREATE DATABASE {name}").as_str())
            .await
            .unwrap();
        let mut url = url::Url::parse(raw.trim()).unwrap();
        url.set_path(&name);
        let result = tokio::task::LocalSet::new()
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
        result.expect("Microsoft Teams PostgreSQL contract failed");
    }
}
