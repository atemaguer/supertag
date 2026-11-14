//! App/tenant identity, activated threads, and message receipts are durable.
use super::*;
use crate::surface_policy::{VerifiedConnectorOrigin, VerifiedScope, admit_connector_task_in};
use supertag_protocol::v2::{AcceptLarkEventRequest, AcceptLarkEventResponse, LarkDomain};

impl Store {
    pub async fn accept_lark_event(
        &self,
        principal: &str,
        input: &AcceptLarkEventRequest,
    ) -> Result<AcceptLarkEventResponse> {
        let account = connector_account(principal)?;
        if account != input.account_id
            || !account
                .strip_prefix("lark/")
                .is_some_and(|id| valid_id(id, ""))
        {
            return Err(StoreError::PermissionDenied);
        }
        if !matches!(
            LarkDomain::try_from(input.domain),
            Ok(LarkDomain::Lark | LarkDomain::Feishu)
        ) || !valid_app(&input.app_id)
            || !valid_id(&input.tenant_key, "")
            || !valid_id(&input.chat_id, "oc_")
            || !valid_id(&input.message_id, "om_")
            || !valid_id(&input.root_message_id, "om_")
            || !valid_id(&input.actor_id, "ou_")
        {
            return Err(invalid("invalid Lark event identity"));
        }
        name("event ID", &input.event_id)?;
        text("Lark prompt", &input.prompt, 128 * 1024)?;
        if input.prompt.trim().is_empty() {
            return Err(invalid("Lark message text is required"));
        }
        if let Some(tag) = &input.mention_tag_id {
            name("Tag ID", tag)?;
        }
        let fingerprint = hash(&(
            input.domain,
            &input.app_id,
            &input.tenant_key,
            &input.chat_id,
            &input.message_id,
            &input.root_message_id,
            &input.actor_id,
            &input.prompt,
            input.direct,
        ))?;
        let (mut tx, order) = self.write().await?;
        let prior=sqlx::query("SELECT request_digest,task_id FROM supertag_v2_lark_events WHERE account_id=$1 AND event_id=$2").bind(account).bind(&input.event_id).fetch_optional(&mut *tx).await?;
        if let Some(prior) = prior {
            let task = replay(&mut tx, &prior, &fingerprint).await?;
            tx.commit().await?;
            return Ok(AcceptLarkEventResponse { task: Some(task) });
        }
        let identity = sqlx::query(
            "SELECT domain,app_id,tenant_key FROM supertag_v2_lark_accounts WHERE account_id=$1",
        )
        .bind(account)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(identity) = &identity
            && (identity.try_get::<i64, _>("domain")? != i64::from(input.domain)
                || identity.try_get::<String, _>("app_id")? != input.app_id
                || identity.try_get::<String, _>("tenant_key")? != input.tenant_key)
        {
            return Err(StoreError::Conflict(
                "Lark account belongs to another domain, app, or tenant".into(),
            ));
        }
        let logical=sqlx::query("SELECT request_digest,task_id FROM supertag_v2_lark_messages WHERE account_id=$1 AND chat_id=$2 AND message_id=$3").bind(account).bind(&input.chat_id).bind(&input.message_id).fetch_optional(&mut *tx).await?;
        if let Some(logical) = logical {
            let task = replay(&mut tx, &logical, &fingerprint).await?;
            record(
                &mut tx,
                account,
                &input.event_id,
                &fingerprint,
                &task.task_id,
            )
            .await?;
            tx.commit().await?;
            return Ok(AcceptLarkEventResponse { task: Some(task) });
        }
        let chat: Option<String> = sqlx::query_scalar(
            "SELECT tag_id FROM supertag_v2_lark_chats WHERE account_id=$1 AND chat_id=$2",
        )
        .bind(account)
        .bind(&input.chat_id)
        .fetch_optional(&mut *tx)
        .await?;
        if let (Some(tag), Some(selected)) = (&chat, &input.mention_tag_id)
            && tag != selected
        {
            return Err(StoreError::Conflict(
                "Lark chat belongs to another Tag".into(),
            ));
        }
        let route=sqlx::query("SELECT tag_id,session_id,direct,actor_id FROM supertag_v2_lark_threads WHERE account_id=$1 AND chat_id=$2 AND root_message_id=$3").bind(account).bind(&input.chat_id).bind(&input.root_message_id).fetch_optional(&mut *tx).await?;
        let activate = route.is_none();
        let (tag, session) = if let Some(route) = route {
            if (route.try_get::<i64, _>("direct")? != 0) != input.direct
                || (input.direct && route.try_get::<String, _>("actor_id")? != input.actor_id)
            {
                return Err(StoreError::PermissionDenied);
            }
            (
                route.try_get::<String, _>("tag_id")?,
                route.try_get::<String, _>("session_id")?,
            )
        } else if let Some(tag) = &input.mention_tag_id {
            (
                tag.clone(),
                format!("lark:{account}:{}:{}", input.chat_id, input.root_message_id),
            )
        } else {
            tx.commit().await?;
            return Ok(AcceptLarkEventResponse { task: None });
        };
        let collision: Option<String> = sqlx::query_scalar(
            "SELECT task_id FROM supertag_v2_inbound_events WHERE account_id=$1 AND event_id=$2",
        )
        .bind(account)
        .bind(&input.event_id)
        .fetch_optional(&mut *tx)
        .await?;
        if collision.is_some() {
            return Err(StoreError::Conflict(
                "event ID belongs to another connector route".into(),
            ));
        }
        let Some(task) = admit_connector_task_in(
            &mut tx,
            order,
            VerifiedConnectorOrigin {
                connector_account_id: account,
                tag_id: &tag,
                scope: VerifiedScope::Lark {
                    feishu: input.domain == LarkDomain::Feishu as i32,
                    app_id: &input.app_id,
                    tenant_key: &input.tenant_key,
                    chat_id: &input.chat_id,
                },
            },
            &session,
            &input.prompt,
            self.execution_now_ms(),
        )
        .await?
        else {
            tx.commit().await?;
            return Ok(AcceptLarkEventResponse { task: None });
        };
        if identity.is_none() {
            sqlx::query("INSERT INTO supertag_v2_lark_accounts (account_id,domain,app_id,tenant_key) VALUES ($1,$2,$3,$4)").bind(account).bind(i64::from(input.domain)).bind(&input.app_id).bind(&input.tenant_key).execute(&mut *tx).await?;
        }
        if chat.is_none() {
            sqlx::query(
                "INSERT INTO supertag_v2_lark_chats (account_id,chat_id,tag_id) VALUES ($1,$2,$3)",
            )
            .bind(account)
            .bind(&input.chat_id)
            .bind(&tag)
            .execute(&mut *tx)
            .await?;
        }
        if activate {
            sqlx::query("INSERT INTO supertag_v2_lark_threads (account_id,chat_id,root_message_id,tag_id,session_id,direct,actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7)").bind(account).bind(&input.chat_id).bind(&input.root_message_id).bind(&tag).bind(&session).bind(i64::from(input.direct)).bind(&input.actor_id).execute(&mut *tx).await?;
        }
        let thread = Some(input.root_message_id.clone());
        let source = hash(&(&tag, &session, &input.prompt, &input.chat_id, &thread))?;
        sqlx::query("INSERT INTO supertag_v2_inbound_events (account_id,event_id,request_digest,task_id,conversation_id,thread_id) VALUES ($1,$2,$3,$4,$5,$6)").bind(account).bind(&input.event_id).bind(source).bind(&task.task_id).bind(&input.chat_id).bind(thread).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO supertag_v2_lark_messages (account_id,chat_id,message_id,request_digest,task_id) VALUES ($1,$2,$3,$4,$5)").bind(account).bind(&input.chat_id).bind(&input.message_id).bind(&fingerprint).bind(&task.task_id).execute(&mut *tx).await?;
        record(
            &mut tx,
            account,
            &input.event_id,
            &fingerprint,
            &task.task_id,
        )
        .await?;
        tx.commit().await?;
        Ok(AcceptLarkEventResponse { task: Some(task) })
    }
}
fn hash(value: &impl serde::Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
fn valid_id(value: &str, prefix: &str) -> bool {
    value.len() > prefix.len()
        && value.len() <= 128
        && value.starts_with(prefix)
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}
fn valid_app(value: &str) -> bool {
    value
        .strip_prefix("cli_")
        .is_some_and(|id| id.len() == 16 && id.bytes().all(|b| b.is_ascii_hexdigit()))
}
async fn replay(tx: &mut Transaction<'_, Any>, row: &AnyRow, digest: &str) -> Result<Task> {
    if row.try_get::<String, _>("request_digest")? != digest {
        return Err(StoreError::Conflict(
            "Lark event or message changed content or identity".into(),
        ));
    }
    task_in(tx, &row.try_get::<String, _>("task_id")?).await
}
async fn record(
    tx: &mut Transaction<'_, Any>,
    account: &str,
    event: &str,
    digest: &str,
    task: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO supertag_v2_lark_events (account_id,event_id,request_digest,task_id) VALUES ($1,$2,$3,$4)").bind(account).bind(event).bind(digest).bind(task).execute(&mut **tx).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Executor};
    fn event(id: &str, message: &str, mention: bool) -> AcceptLarkEventRequest {
        AcceptLarkEventRequest {
            account_id: "lark/shared".into(),
            domain: LarkDomain::Lark.into(),
            app_id: "cli_0123456789abcdef".into(),
            tenant_key: "tenant-one".into(),
            event_id: id.into(),
            chat_id: "oc_engineering".into(),
            message_id: message.into(),
            root_message_id: "om_root".into(),
            actor_id: "ou_alice".into(),
            prompt: "Inspect the issue".into(),
            mention_tag_id: mention.then(|| "builder".into()),
            direct: false,
        }
    }
    async fn contract(url: &str) {
        let store = Store::open(url).await.unwrap();
        store
            .put_tag("builder", "Original", vec!["files:read".into()])
            .await
            .unwrap();
        store.put_tag("other", "Other", vec![]).await.unwrap();
        let orphan = event("orphan", "om_orphan", false);
        assert!(
            store
                .accept_lark_event("connector:lark/shared", &orphan)
                .await
                .unwrap()
                .task
                .is_none()
        );
        let first = event("mention", "om_root", true);
        let task = store
            .accept_lark_event("connector:lark/shared", &first)
            .await
            .unwrap()
            .task
            .unwrap();
        store.close().await;
        let left = Store::open(url).await.unwrap();
        let right = Store::open(url).await.unwrap();
        let (a, b) = tokio::join!(
            left.accept_lark_event("connector:lark/shared", &first),
            right.accept_lark_event("connector:lark/shared", &first)
        );
        assert_eq!(a.unwrap().task, Some(task.clone()));
        assert_eq!(b.unwrap().task, Some(task.clone()));
        let mut replay = first.clone();
        replay.event_id = "other-delivery".into();
        replay.mention_tag_id = None;
        assert_eq!(
            right
                .accept_lark_event("connector:lark/shared", &replay)
                .await
                .unwrap()
                .task,
            Some(task.clone())
        );
        replay.prompt = "different intent".into();
        assert!(matches!(
            left.accept_lark_event("connector:lark/shared", &replay)
                .await,
            Err(StoreError::Conflict(_))
        ));
        left.put_tag("builder", "Updated", vec![]).await.unwrap();
        let follow = event("follow", "om_follow", false);
        let follow = left
            .accept_lark_event("connector:lark/shared", &follow)
            .await
            .unwrap()
            .task
            .unwrap();
        assert_eq!(follow.session_id, task.session_id);
        assert_eq!(follow.instructions, "Updated");
        assert_ne!(follow.task_id, task.task_id);
        for kind in ["tenant", "app", "domain", "tag"] {
            let mut bad = event("bad-route", "om_another", true);
            match kind {
                "tenant" => bad.tenant_key = "tenant-other".into(),
                "app" => bad.app_id = "cli_abcdef0123456789".into(),
                "domain" => bad.domain = LarkDomain::Feishu.into(),
                "tag" => bad.mention_tag_id = Some("other".into()),
                _ => unreachable!(),
            }
            assert!(
                matches!(
                    right.accept_lark_event("connector:lark/shared", &bad).await,
                    Err(StoreError::Conflict(_))
                ),
                "accepted {kind}"
            );
        }
        let mut direct = event("direct", "om_private", true);
        direct.chat_id = "oc_private".into();
        direct.root_message_id = "om_private".into();
        direct.direct = true;
        let private = left
            .accept_lark_event("connector:lark/shared", &direct)
            .await
            .unwrap()
            .task
            .unwrap();
        assert_ne!(private.session_id, task.session_id);
        direct.event_id = "direct-other-user".into();
        direct.message_id = "om_private_reply".into();
        direct.actor_id = "ou_bob".into();
        direct.mention_tag_id = None;
        assert!(matches!(
            right
                .accept_lark_event("connector:lark/shared", &direct)
                .await,
            Err(StoreError::PermissionDenied)
        ));
        assert!(matches!(
            right.accept_lark_event("connector:shared", &first).await,
            Err(StoreError::PermissionDenied)
        ));
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
    async fn sqlite_lark_threads_and_receipts_survive_restart() {
        let dir = tempfile::tempdir().unwrap();
        contract(&format!(
            "sqlite://{}?mode=rwc",
            dir.path().join("lark.db").display()
        ))
        .await;
    }
    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
    async fn postgres_lark_threads_and_receipts_survive_restart() {
        let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
            .expect("test PostgreSQL URL file required");
        let raw = std::fs::read_to_string(path).unwrap();
        let name = format!("supertag_rust_lark_{}", Uuid::new_v4().simple());
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
        result.expect("PostgreSQL Lark contract failed");
    }
}
