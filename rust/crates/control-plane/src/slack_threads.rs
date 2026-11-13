//! Slack thread activation and message admission share one durable transaction.
//! Gateway memory and its configured default Tag never own an activated route.
use super::*;
use crate::surface_policy::{VerifiedConnectorOrigin, VerifiedScope, admit_connector_task_in};
use supertag_protocol::v2::{AcceptSlackEventRequest, AcceptSlackEventResponse};

impl Store {
    pub async fn accept_slack_event(
        &self,
        principal: &str,
        input: &AcceptSlackEventRequest,
    ) -> Result<AcceptSlackEventResponse> {
        let account = connector_account(principal)?;
        if account.contains('/') || account != input.account_id {
            return Err(StoreError::PermissionDenied);
        }
        name("event ID", &input.event_id)?;
        if !slack_id(&input.team_id, b"T")
            || !slack_id(&input.channel_id, b"CG")
            || !slack_ts(&input.message_ts)
            || !slack_ts(&input.thread_ts)
        {
            return Err(invalid("invalid Slack message coordinates"));
        }
        text("prompt", &input.prompt, 128 * 1024)?;
        if input.prompt.trim().is_empty() {
            return Err(invalid("Slack message text is required"));
        }
        if let Some(tag) = &input.mention_tag_id {
            name("Tag ID", tag)?;
        }
        // Both Slack notifications for one human message are the same logical
        // input. Event kind and a Gateway's current default Tag are not content.
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                &input.team_id,
                &input.channel_id,
                &input.message_ts,
                &input.thread_ts,
                &input.prompt,
            ))?)
        );
        let (mut tx, order) = self.write().await?;
        let prior = sqlx::query("SELECT request_digest,task_id FROM supertag_v2_slack_events WHERE account_id=$1 AND event_id=$2")
            .bind(account).bind(&input.event_id).fetch_optional(&mut *tx).await?;
        if let Some(prior) = prior {
            let task = replay(&mut tx, &prior, &fingerprint).await?;
            tx.commit().await?;
            return Ok(AcceptSlackEventResponse { task: Some(task) });
        }
        let logical = sqlx::query("SELECT request_digest,task_id FROM supertag_v2_slack_messages WHERE account_id=$1 AND team_id=$2 AND channel_id=$3 AND message_ts=$4")
            .bind(account).bind(&input.team_id).bind(&input.channel_id).bind(&input.message_ts)
            .fetch_optional(&mut *tx).await?;
        if let Some(logical) = logical {
            let task = replay(&mut tx, &logical, &fingerprint).await?;
            record_event(
                &mut tx,
                account,
                &input.event_id,
                &fingerprint,
                &task.task_id,
            )
            .await?;
            tx.commit().await?;
            return Ok(AcceptSlackEventResponse { task: Some(task) });
        }
        let route = sqlx::query("SELECT tag_id,session_id FROM supertag_v2_slack_threads WHERE account_id=$1 AND team_id=$2 AND channel_id=$3 AND thread_ts=$4")
            .bind(account).bind(&input.team_id).bind(&input.channel_id).bind(&input.thread_ts)
            .fetch_optional(&mut *tx).await?;
        let activate = route.is_none();
        let (tag, session) = if let Some(route) = route {
            let tag: String = route.try_get("tag_id")?;
            if input
                .mention_tag_id
                .as_ref()
                .is_some_and(|selected| selected != &tag)
            {
                return Err(StoreError::Conflict(
                    "Slack thread already belongs to another Tag".into(),
                ));
            }
            (tag, route.try_get::<String, _>("session_id")?)
        } else if let Some(tag) = &input.mention_tag_id {
            (
                tag.clone(),
                format!(
                    "slack:{:x}",
                    Sha256::digest(serde_json::to_vec(&(
                        account,
                        &input.team_id,
                        &input.channel_id,
                        &input.thread_ts,
                    ))?)
                ),
            )
        } else {
            // No receipt for an ignored, unactivated reply: the same delivery can
            // be retried after a mention activates its thread, as in the old runtime.
            tx.commit().await?;
            return Ok(AcceptSlackEventResponse { task: None });
        };
        let Some(task) = admit_connector_task_in(
            &mut tx,
            order,
            VerifiedConnectorOrigin {
                connector_account_id: account,
                tag_id: &tag,
                scope: VerifiedScope::Slack {
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
            return Ok(AcceptSlackEventResponse { task: None });
        };
        if activate {
            sqlx::query("INSERT INTO supertag_v2_slack_threads (account_id,team_id,channel_id,thread_ts,tag_id,session_id) VALUES ($1,$2,$3,$4,$5,$6)")
                .bind(account).bind(&input.team_id).bind(&input.channel_id).bind(&input.thread_ts).bind(&tag).bind(&session)
                .execute(&mut *tx).await?;
        }
        // Keep the existing outbox's source record. Its digest remains identical
        // to AcceptEvent so private exact receipt lookups still describe the Task.
        let thread = Some(input.thread_ts.clone());
        let source_digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                &tag,
                &session,
                &input.prompt,
                &input.channel_id,
                &thread,
            ))?)
        );
        let source_collision: Option<String> = sqlx::query_scalar(
            "SELECT task_id FROM supertag_v2_inbound_events WHERE account_id=$1 AND event_id=$2",
        )
        .bind(account)
        .bind(&input.event_id)
        .fetch_optional(&mut *tx)
        .await?;
        if source_collision.is_some() {
            return Err(StoreError::Conflict(
                "event ID was already admitted by another connector route".into(),
            ));
        }
        sqlx::query("INSERT INTO supertag_v2_inbound_events (account_id,event_id,request_digest,task_id,conversation_id,thread_id) VALUES ($1,$2,$3,$4,$5,$6)")
            .bind(account).bind(&input.event_id).bind(source_digest).bind(&task.task_id).bind(&input.channel_id).bind(&input.thread_ts)
            .execute(&mut *tx).await?;
        sqlx::query("INSERT INTO supertag_v2_slack_messages (account_id,team_id,channel_id,message_ts,request_digest,task_id) VALUES ($1,$2,$3,$4,$5,$6)")
            .bind(account).bind(&input.team_id).bind(&input.channel_id).bind(&input.message_ts).bind(&fingerprint).bind(&task.task_id)
            .execute(&mut *tx).await?;
        record_event(
            &mut tx,
            account,
            &input.event_id,
            &fingerprint,
            &task.task_id,
        )
        .await?;
        supertag_protocol::crash_point("control-plane.slack-admission", "before-commit");
        tx.commit().await?;
        Ok(AcceptSlackEventResponse { task: Some(task) })
    }
}

async fn replay(tx: &mut Transaction<'_, Any>, prior: &AnyRow, fingerprint: &str) -> Result<Task> {
    if prior.try_get::<String, _>("request_digest")? != fingerprint {
        return Err(StoreError::Conflict(
            "Slack event or message was used with different content or routing".into(),
        ));
    }
    task_in(tx, &prior.try_get::<String, _>("task_id")?).await
}

async fn record_event(
    tx: &mut Transaction<'_, Any>,
    account: &str,
    event: &str,
    fingerprint: &str,
    task: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO supertag_v2_slack_events (account_id,event_id,request_digest,task_id) VALUES ($1,$2,$3,$4)")
        .bind(account).bind(event).bind(fingerprint).bind(task).execute(&mut **tx).await?;
    Ok(())
}

fn slack_id(value: &str, prefixes: &[u8]) -> bool {
    (2..=64).contains(&value.len())
        && prefixes.contains(&value.as_bytes()[0])
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
}

fn slack_ts(value: &str) -> bool {
    value.split_once('.').is_some_and(|(seconds, micros)| {
        (1..=16).contains(&seconds.len())
            && (1..=9).contains(&micros.len())
            && seconds
                .bytes()
                .chain(micros.bytes())
                .all(|byte| byte.is_ascii_digit())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Executor};

    fn event(id: &str, message: &str, mention: bool) -> AcceptSlackEventRequest {
        AcceptSlackEventRequest {
            account_id: "slack-test".into(),
            event_id: id.into(),
            team_id: "TTEAM1".into(),
            channel_id: "CCHANNEL1".into(),
            message_ts: message.into(),
            thread_ts: "1794470000.100000".into(),
            prompt: format!("Message {message}"),
            mention_tag_id: mention.then(|| "builder".into()),
        }
    }

    async fn contract(url: &str) {
        const PRINCIPAL: &str = "connector:slack-test";
        let store = Store::open(url).await.unwrap();
        for tag in ["builder", "another"] {
            store
                .put_tag(tag, "Current Tag instructions", vec!["files:read".into()])
                .await
                .unwrap();
        }
        let reply = event("EvREPLY", "1794470001.100000", false);
        assert!(
            store
                .accept_slack_event(PRINCIPAL, &reply)
                .await
                .unwrap()
                .task
                .is_none()
        );
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_tasks")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
        let mention = event("EvMENTION", "1794470000.100000", true);
        let accepted = store
            .accept_slack_event(PRINCIPAL, &mention)
            .await
            .unwrap()
            .task
            .unwrap();
        assert_eq!(accepted.tag_id, "builder");
        assert!(accepted.session_id.starts_with("slack:"));
        assert_eq!(accepted.session_id.len(), "slack:".len() + 64);
        store.close().await;

        let first = Store::open(url).await.unwrap();
        let second = Store::open(url).await.unwrap();
        let (left, right) = tokio::join!(
            first.accept_slack_event(PRINCIPAL, &reply),
            second.accept_slack_event(PRINCIPAL, &reply)
        );
        let left = left.unwrap().task.unwrap();
        assert_eq!(left, right.unwrap().task.unwrap());
        assert_eq!(left.session_id, accepted.session_id);
        assert_eq!(left.tag_id, accepted.tag_id);
        assert_ne!(left.task_id, accepted.task_id);
        let mut twin = mention.clone();
        twin.event_id = "EvMESSAGETWIN".into();
        twin.mention_tag_id = None;
        assert_eq!(
            first
                .accept_slack_event(PRINCIPAL, &twin)
                .await
                .unwrap()
                .task,
            Some(accepted.clone())
        );
        let mut changed = reply.clone();
        changed.prompt = "different content".into();
        assert!(matches!(
            first.accept_slack_event(PRINCIPAL, &changed).await,
            Err(StoreError::Conflict(_))
        ));
        changed.event_id = "EvLOGICALCONFLICT".into();
        assert!(matches!(
            first.accept_slack_event(PRINCIPAL, &changed).await,
            Err(StoreError::Conflict(_))
        ));
        for field in ["account", "team", "channel", "thread"] {
            let mut unrelated = event("EvUNRELATED", "1794470002.100000", false);
            let principal = if field == "account" {
                unrelated.account_id = "another-account".into();
                "connector:another-account"
            } else {
                PRINCIPAL
            };
            match field {
                "team" => unrelated.team_id = "TOTHER1".into(),
                "channel" => unrelated.channel_id = "COTHER1".into(),
                "thread" => unrelated.thread_ts = "1794470099.100000".into(),
                _ => {}
            }
            assert!(
                second
                    .accept_slack_event(principal, &unrelated)
                    .await
                    .unwrap()
                    .task
                    .is_none(),
                "unrelated {field} continued the Session"
            );
        }
        assert!(matches!(
            first
                .accept_slack_event("connector:another-account", &mention)
                .await,
            Err(StoreError::PermissionDenied)
        ));
        let mut hijack = event("EvHIJACK", "1794470003.100000", true);
        hijack.mention_tag_id = Some("another".into());
        assert!(matches!(
            second.accept_slack_event(PRINCIPAL, &hijack).await,
            Err(StoreError::Conflict(_))
        ));
        let next_mention = event("EvNEXTMENTION", "1794470003.100000", true);
        assert_eq!(
            first
                .accept_slack_event(PRINCIPAL, &next_mention)
                .await
                .unwrap()
                .task
                .unwrap()
                .tag_id,
            "builder"
        );
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_tasks")
            .fetch_one(&first.pool)
            .await
            .unwrap();
        assert_eq!(
            count, 3,
            "provider and logical duplicates never add another Task"
        );

        // Failed admission does not leave an active thread behind.
        let mut missing = event("EvMISSING", "1794470010.100000", true);
        missing.thread_ts = missing.message_ts.clone();
        missing.mention_tag_id = Some("missing-tag".into());
        assert!(matches!(
            first.accept_slack_event(PRINCIPAL, &missing).await,
            Err(StoreError::NotFound(_))
        ));
        missing.mention_tag_id = None;
        assert!(
            second
                .accept_slack_event(PRINCIPAL, &missing)
                .await
                .unwrap()
                .task
                .is_none()
        );
        first.close().await;
        second.close().await;
    }

    #[tokio::test]
    async fn sqlite_slack_threads_survive_restart_and_concurrent_gateways() {
        let directory = tempfile::tempdir().unwrap();
        contract(&format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("slack.db").display()
        ))
        .await;
    }

    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
    async fn postgres_slack_threads_survive_restart_and_concurrent_gateways() {
        let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
            .expect("PostgreSQL test URL file required");
        let admin_url = std::fs::read_to_string(path).unwrap();
        let name = format!("supertag_rust_slack_threads_{}", Uuid::new_v4().simple());
        let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await.unwrap();
        admin
            .execute(format!("CREATE DATABASE {name}").as_str())
            .await
            .unwrap();
        let mut url = url::Url::parse(admin_url.trim()).unwrap();
        url.set_path(&name);
        let local = tokio::task::LocalSet::new();
        let outcome = local
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
        outcome.expect("PostgreSQL Slack thread contract failed");
    }
}
