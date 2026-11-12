//! Authoritative storage for the first Rust execution slice.
//!
//! Writes take a database lock before reading state. This intentionally serializes
//! this first slice's mutations, including across multiple service instances. A
//! socket, Tokio mutex, or response acknowledgement never owns durable work.

mod authority;
pub(crate) use authority::lease_is_live;

use std::{str::FromStr, sync::Arc, time::Duration};

use sha2::{Digest, Sha256};
use sqlx::{
    Any, AnyPool, Row, Transaction,
    any::{AnyConnectOptions, AnyPoolOptions, AnyRow},
};
use supertag_protocol::v2::{
    AcceptEventRequest, AppendEventRequest, Assignment, ClaimReplyResponse, FinishTaskRequest,
    Reply, ReplyDestination, ReplyState, SettleReplyRequest, StartTaskRequest, SubmitTaskRequest,
    Tag, Task, TaskEvent, TaskState,
};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("{0}")]
    InvalidArgument(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    FailedPrecondition(String),
    #[error("execution ownership does not match")]
    PermissionDenied,
    #[error("storage operation failed")]
    Storage(#[from] sqlx::Error),
    #[error("stored data is invalid")]
    Data(#[from] serde_json::Error),
}

pub(crate) type Result<T> = std::result::Result<T, StoreError>;

#[derive(Clone)]
pub struct Store {
    pub(crate) pool: AnyPool,
    execution_clock: Option<Arc<dyn Fn() -> i64 + Send + Sync>>,
}

impl Store {
    pub async fn open(url: &str) -> anyhow::Result<Self> {
        const SCHEMA_VERSION: i64 = 4;
        sqlx::any::install_default_drivers();
        let sqlite = url.starts_with("sqlite:");
        anyhow::ensure!(
            sqlite || url.starts_with("postgres:") || url.starts_with("postgresql:"),
            "expected a SQLite or PostgreSQL database URL"
        );
        let options = AnyConnectOptions::from_str(url)?;
        let pool = AnyPoolOptions::new()
            .max_connections(if sqlite { 1 } else { 8 })
            .acquire_timeout(Duration::from_secs(10))
            .connect_with(options)
            .await?;
        let tables: Vec<String> = if sqlite {
            sqlx::query_scalar(
                "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            )
            .fetch_all(&pool)
            .await?
        } else {
            sqlx::query_scalar("SELECT CAST(table_name AS TEXT) FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'")
                .fetch_all(&pool).await?
        };
        if tables
            .iter()
            .any(|table| !table.starts_with("supertag_v2_"))
        {
            pool.close().await;
            anyhow::bail!(
                "Rust services require a fresh database; existing non-Rust tables were found"
            );
        }
        // Check an existing store before issuing any schema mutation. An unknown
        // newer schema must not be modified by an older executable.
        let version = if tables.iter().any(|table| table == "supertag_v2_schema") {
            let versions: Vec<i64> = sqlx::query_scalar("SELECT version FROM supertag_v2_schema")
                .fetch_all(&pool)
                .await?;
            if !matches!(versions.as_slice(), [version] if (1..=SCHEMA_VERSION).contains(version)) {
                pool.close().await;
                anyhow::bail!("unsupported Rust database schema");
            }
            versions[0]
        } else if !tables.is_empty() {
            pool.close().await;
            anyhow::bail!("Rust schema marker is missing; refusing to initialize existing tables");
        } else {
            0
        };
        let migrations = if sqlite {
            [
                include_str!("../migrations/sqlite/0001_initial.sql"),
                include_str!("../migrations/sqlite/0002_connector_outbox.sql"),
                include_str!("../migrations/sqlite/0003_execution_authority.sql"),
                include_str!("../migrations/sqlite/0004_objectives.sql"),
            ]
        } else {
            [
                include_str!("../migrations/postgresql/0001_initial.sql"),
                include_str!("../migrations/postgresql/0002_connector_outbox.sql"),
                include_str!("../migrations/postgresql/0003_execution_authority.sql"),
                include_str!("../migrations/postgresql/0004_objectives.sql"),
            ]
        };
        if version < SCHEMA_VERSION {
            let mut transaction = pool.begin().await?;
            for migration in &migrations[version as usize..] {
                sqlx::raw_sql(migration).execute(&mut *transaction).await?;
            }
            transaction.commit().await?;
        }
        let versions: Vec<i64> = sqlx::query_scalar("SELECT version FROM supertag_v2_schema")
            .fetch_all(&pool)
            .await?;
        anyhow::ensure!(
            versions == [SCHEMA_VERSION],
            "unsupported Rust database schema"
        );
        Ok(Self {
            pool,
            execution_clock: None,
        })
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub(crate) async fn write(&self) -> Result<(Transaction<'_, Any>, i64)> {
        let mut transaction = self.pool.begin().await?;
        // PostgreSQL takes a row lock; SQLite takes its write lock before any reads.
        let order: i64 = sqlx::query_scalar("UPDATE supertag_v2_write_order SET revision = revision + 1 WHERE singleton = 1 RETURNING revision")
            .fetch_one(&mut *transaction).await?;
        Ok((transaction, order))
    }

    pub async fn put_tag(
        &self,
        tag_id: &str,
        instructions: &str,
        mut allowed_actions: Vec<String>,
    ) -> Result<Tag> {
        name("Tag ID", tag_id)?;
        text("instructions", instructions, 65_536)?;
        if allowed_actions.len() > 256 {
            return Err(invalid("too many allowed actions"));
        }
        for action in &allowed_actions {
            name("allowed action", action)?;
        }
        allowed_actions.sort();
        allowed_actions.dedup();
        let actions = serde_json::to_string(&allowed_actions)?;
        let (mut transaction, _) = self.write().await?;
        let revision: i64 = sqlx::query_scalar("INSERT INTO supertag_v2_tags (tag_id, instructions, allowed_actions, revision) VALUES ($1, $2, $3, 1) ON CONFLICT(tag_id) DO UPDATE SET instructions = excluded.instructions, allowed_actions = excluded.allowed_actions, revision = supertag_v2_tags.revision + 1 RETURNING revision")
            .bind(tag_id).bind(instructions).bind(actions).fetch_one(&mut *transaction).await?;
        transaction.commit().await?;
        Ok(Tag {
            tag_id: tag_id.into(),
            instructions: instructions.into(),
            allowed_actions,
            revision: revision as u64,
        })
    }

    pub async fn submit_task(&self, principal: &str, input: &SubmitTaskRequest) -> Result<Task> {
        name("principal", principal)?;
        name("operation ID", &input.operation_id)?;
        name("Tag ID", &input.tag_id)?;
        name("Session ID", &input.session_id)?;
        text("prompt", &input.prompt, 262_144)?;
        let digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                &input.tag_id,
                &input.session_id,
                &input.prompt
            ))?)
        );
        let (mut transaction, order) = self.write().await?;
        let prior = sqlx::query("SELECT request_digest, task_id FROM supertag_v2_admissions WHERE principal = $1 AND operation_id = $2")
            .bind(principal).bind(&input.operation_id).fetch_optional(&mut *transaction).await?;
        if let Some(prior) = prior {
            if prior.try_get::<String, _>("request_digest")? != digest {
                return Err(StoreError::Conflict(
                    "operation ID was used with different work".into(),
                ));
            }
            let task = task_in(&mut transaction, &prior.try_get::<String, _>("task_id")?).await?;
            transaction.commit().await?;
            return Ok(task);
        }
        crate::objectives::objective_admission_in(
            &mut transaction,
            &input.tag_id,
            &input.session_id,
            self.execution_now_ms(),
        )
        .await?;
        let task = insert_task(
            &mut transaction,
            order,
            &input.tag_id,
            &input.session_id,
            &input.prompt,
        )
        .await?;
        crate::objectives::objective_link_task_in(&mut transaction, &task).await?;
        let id = &task.task_id;
        sqlx::query("INSERT INTO supertag_v2_admissions (principal, operation_id, request_digest, task_id) VALUES ($1,$2,$3,$4)")
            .bind(principal).bind(&input.operation_id).bind(digest).bind(id).execute(&mut *transaction).await?;
        transaction.commit().await?;
        Ok(task)
    }

    pub async fn get_task(&self, task_id: &str) -> Result<Task> {
        name("Task ID", task_id)?;
        let row = sqlx::query("SELECT * FROM supertag_v2_tasks WHERE task_id = $1")
            .bind(task_id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| StoreError::NotFound("Task was not found".into()))?;
        task_row(&row)
    }

    pub async fn cancel_task(&self, task_id: &str) -> Result<Task> {
        name("Task ID", task_id)?;
        let (mut transaction, _) = self.write().await?;
        let task = task_in(&mut transaction, task_id).await?;
        if [
            TaskState::Queued as i32,
            TaskState::Claimed as i32,
            TaskState::Running as i32,
        ]
        .contains(&task.state)
        {
            sqlx::query("UPDATE supertag_v2_tasks SET state = $1 WHERE task_id = $2")
                .bind(TaskState::Cancelled as i64)
                .bind(task_id)
                .execute(&mut *transaction)
                .await?;
        }
        let task = task_in(&mut transaction, task_id).await?;
        transaction.commit().await?;
        Ok(task)
    }

    pub async fn claim_task(
        &self,
        principal: &str,
        operation_id: &str,
    ) -> Result<Option<Assignment>> {
        name("principal", principal)?;
        name("operation ID", operation_id)?;
        let (mut transaction, _) = self.write().await?;
        let now = self.execution_now_ms();
        authority::expire_due_attempts(&mut transaction, now).await?;
        crate::objectives::objective_sweep_in(&mut transaction, now).await?;
        let prior = sqlx::query("SELECT task_id, attempt_id, lease_token FROM supertag_v2_claims WHERE principal = $1 AND operation_id = $2")
            .bind(principal).bind(operation_id).fetch_optional(&mut *transaction).await?;
        if let Some(prior) = prior {
            let id: Option<String> = prior.try_get("task_id")?;
            let assignment = match id {
                Some(id) => {
                    let task = task_in(&mut transaction, &id).await?;
                    let attempt_id: String = prior.try_get("attempt_id")?;
                    if task.attempt_id.as_deref() == Some(attempt_id.as_str())
                        && matches!(task.state(), TaskState::Claimed | TaskState::Running)
                    {
                        Some(Assignment {
                            task: Some(task),
                            attempt_id,
                            lease_token: prior.try_get("lease_token")?,
                        })
                    } else {
                        None
                    }
                }
                None => None,
            };
            transaction.commit().await?;
            return Ok(assignment);
        }
        let Some(id) = authority::claim_candidate(&mut transaction, now).await? else {
            // Commit maintenance transitions. An empty poll retains no claim receipt.
            transaction.commit().await?;
            return Ok(None);
        };
        let attempt = Uuid::new_v4().to_string();
        let lease = Uuid::new_v4().to_string();
        sqlx::query("UPDATE supertag_v2_tasks SET state = $1, attempt_id = $2, host_principal = $3, lease_token = $4, lease_expires_at_ms = $5, event_sequence_base = next_sequence - 1 WHERE task_id = $6")
            .bind(TaskState::Claimed as i64).bind(&attempt).bind(principal).bind(&lease)
            .bind(authority::lease_deadline(now)).bind(&id).execute(&mut *transaction).await?;
        sqlx::query("INSERT INTO supertag_v2_claims (principal, operation_id, task_id, attempt_id, lease_token) VALUES ($1,$2,$3,$4,$5)")
            .bind(principal).bind(operation_id).bind(&id).bind(&attempt).bind(&lease).execute(&mut *transaction).await?;
        let task = task_in(&mut transaction, &id).await?;
        transaction.commit().await?;
        Ok(Some(Assignment {
            task: Some(task),
            attempt_id: attempt,
            lease_token: lease,
        }))
    }

    pub async fn inspect_attempt(
        &self,
        principal: &str,
        task_id: &str,
        attempt_id: &str,
        lease_token: &str,
    ) -> Result<Task> {
        let mut transaction = self.pool.begin().await?;
        let row = owned(
            &mut transaction,
            principal,
            task_id,
            attempt_id,
            lease_token,
        )
        .await?;
        let task = task_row(&row)?;
        transaction.commit().await?;
        Ok(task)
    }

    pub async fn start_task(&self, principal: &str, input: &StartTaskRequest) -> Result<Task> {
        let (mut transaction, _) = self.write().await?;
        let now = self.execution_now_ms();
        crate::objectives::objective_sweep_in(&mut transaction, now).await?;
        let row = owned(
            &mut transaction,
            principal,
            &input.task_id,
            &input.attempt_id,
            &input.lease_token,
        )
        .await?;
        let state = row.try_get::<i64, _>("state")?;
        if state != TaskState::Claimed as i64 && state != TaskState::Running as i64 {
            transaction.commit().await?;
            return Err(StoreError::FailedPrecondition(
                "Task is no longer eligible to start".into(),
            ));
        }
        if !lease_is_live(&row, now)? {
            return Err(StoreError::FailedPrecondition(
                "execution lease expired".into(),
            ));
        }
        if state == TaskState::Claimed as i64 {
            if !crate::objectives::objective_task_can_start_in(
                &mut transaction,
                &task_row(&row)?,
                now,
            )
            .await?
            {
                // This reservation never authorized native execution. Retire it
                // immediately so a paused Objective cannot occupy its host until
                // lease expiry. Its durable claim receipt remains bound to the old
                // Attempt and cannot acquire the replacement reservation.
                sqlx::query("UPDATE supertag_v2_tasks SET state=$1, attempt_id=NULL, host_principal=NULL, lease_token=NULL, lease_expires_at_ms=NULL, event_sequence_base=0 WHERE task_id=$2")
                    .bind(TaskState::Queued as i64).bind(&input.task_id)
                    .execute(&mut *transaction).await?;
                transaction.commit().await?;
                return Err(StoreError::FailedPrecondition(
                    "Objective does not allow this Task to start".into(),
                ));
            }
            let deadline = crate::objectives::objective_lease_deadline_in(
                &mut transaction,
                &task_row(&row)?,
                authority::lease_deadline(now),
            )
            .await?;
            sqlx::query("UPDATE supertag_v2_tasks SET state = $1, cleanup_pending = 1, cleanup_observed = 0, lease_expires_at_ms = $2 WHERE task_id = $3")
                .bind(TaskState::Running as i64).bind(deadline).bind(&input.task_id)
                .execute(&mut *transaction).await?;
        }
        let task = task_in(&mut transaction, &input.task_id).await?;
        if state == TaskState::Claimed as i64 {
            crate::objectives::objective_started_in(&mut transaction, &task).await?;
        }
        transaction.commit().await?;
        Ok(task)
    }

    pub async fn append_event(
        &self,
        principal: &str,
        input: &AppendEventRequest,
    ) -> Result<TaskEvent> {
        let sequence =
            i64::try_from(input.sequence).map_err(|_| invalid("event sequence is too large"))?;
        if sequence == 0 {
            return Err(invalid("event sequence starts at one"));
        }
        text("event", &input.text, 16_384)?;
        let (mut transaction, _) = self.write().await?;
        let row = owned(
            &mut transaction,
            principal,
            &input.task_id,
            &input.attempt_id,
            &input.lease_token,
        )
        .await?;
        let sequence = row
            .try_get::<i64, _>("event_sequence_base")?
            .checked_add(sequence)
            .ok_or_else(|| invalid("event sequence is too large"))?;
        let prior: Option<String> = sqlx::query_scalar(
            "SELECT text FROM supertag_v2_task_events WHERE task_id = $1 AND sequence = $2",
        )
        .bind(&input.task_id)
        .bind(sequence)
        .fetch_optional(&mut *transaction)
        .await?;
        if let Some(prior) = prior {
            if prior != input.text {
                return Err(StoreError::Conflict(
                    "event sequence was used with different content".into(),
                ));
            }
        } else {
            if row.try_get::<i64, _>("state")? != TaskState::Running as i64 {
                return Err(StoreError::FailedPrecondition("Task is not running".into()));
            }
            if !lease_is_live(&row, self.execution_now_ms())? {
                return Err(StoreError::FailedPrecondition(
                    "execution lease expired".into(),
                ));
            }
            if row.try_get::<i64, _>("next_sequence")? != sequence {
                return Err(StoreError::FailedPrecondition(
                    "event sequence has a gap".into(),
                ));
            }
            sqlx::query(
                "INSERT INTO supertag_v2_task_events (task_id, sequence, text) VALUES ($1,$2,$3)",
            )
            .bind(&input.task_id)
            .bind(sequence)
            .bind(&input.text)
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                "UPDATE supertag_v2_tasks SET next_sequence = next_sequence + 1 WHERE task_id = $1",
            )
            .bind(&input.task_id)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(TaskEvent {
            sequence: input.sequence,
            text: input.text.clone(),
        })
    }

    pub async fn finish_task(&self, principal: &str, input: &FinishTaskRequest) -> Result<Task> {
        text("result", &input.result, 262_144)?;
        let (mut transaction, order) = self.write().await?;
        let row = owned(
            &mut transaction,
            principal,
            &input.task_id,
            &input.attempt_id,
            &input.lease_token,
        )
        .await?;
        let now = self.execution_now_ms();
        let mut state = task_row(&row)?.state();
        if state == TaskState::Running {
            crate::objectives::objective_sweep_in(&mut transaction, now).await?;
            state = task_in(&mut transaction, &input.task_id).await?.state();
        }
        if state == TaskState::Running && !lease_is_live(&row, now)? {
            authority::mark_uncertain(&mut transaction, &input.task_id).await?;
            state = TaskState::Uncertain;
        }
        let desired = if input.succeeded {
            TaskState::Succeeded
        } else {
            TaskState::Failed
        };
        if state == TaskState::Cancelled {
            // Finish is also the host's receipt that execution has stopped. Cancellation
            // remains authoritative; a late outcome cannot replace it.
            sqlx::query("UPDATE supertag_v2_tasks SET cleanup_pending = 0, cleanup_observed = 1 WHERE task_id = $1")
                .bind(&input.task_id)
                .execute(&mut *transaction)
                .await?;
        } else if state == TaskState::Uncertain {
            // The host can confirm cleanup after its execution authority expired.
            // The recovery decision remains with the operator.
            sqlx::query("UPDATE supertag_v2_tasks SET cleanup_observed = 1 WHERE task_id = $1")
                .bind(&input.task_id)
                .execute(&mut *transaction)
                .await?;
        } else if matches!(state, TaskState::Succeeded | TaskState::Failed) {
            if state != desired
                || row.try_get::<Option<String>, _>("result")?.as_deref()
                    != Some(input.result.as_str())
                || row.try_get::<i64, _>("finish_objective_signal")?
                    != i64::from(input.objective_signal)
            {
                return Err(StoreError::Conflict(
                    "Task already has a different outcome".into(),
                ));
            }
        } else {
            if state != TaskState::Running {
                return Err(StoreError::FailedPrecondition("Task is not running".into()));
            }
            sqlx::query("UPDATE supertag_v2_tasks SET state = $1, result = $2, cleanup_pending = 0, cleanup_observed = 1, finish_objective_signal = $3 WHERE task_id = $4")
                .bind(desired as i64).bind(&input.result).bind(i64::from(input.objective_signal)).bind(&input.task_id)
                .execute(&mut *transaction).await?;
        }
        let task = task_in(&mut transaction, &input.task_id).await?;
        if state == TaskState::Running && task.state() == TaskState::Succeeded {
            crate::objectives::objective_finish_in(
                &mut transaction,
                &task,
                input.objective_signal,
                now,
            )
            .await?;
        }
        if task.state == TaskState::Succeeded as i32 {
            enqueue_reply(&mut transaction, &task, order).await?;
        }
        crate::objectives::objective_sweep_in(&mut transaction, now).await?;
        transaction.commit().await?;
        Ok(task)
    }

    pub async fn accept_event(&self, principal: &str, input: &AcceptEventRequest) -> Result<Task> {
        let account = connector_account(principal)?;
        if input.account_id != account {
            return Err(StoreError::PermissionDenied);
        }
        name("event ID", &input.event_id)?;
        name("Tag ID", &input.tag_id)?;
        name("Session ID", &input.session_id)?;
        text("prompt", &input.prompt, 262_144)?;
        let destination = input
            .destination
            .as_ref()
            .ok_or_else(|| invalid("reply destination is required"))?;
        name("conversation ID", &destination.conversation_id)?;
        if let Some(thread) = &destination.thread_id {
            name("thread ID", thread)?;
        }
        let digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                &input.tag_id,
                &input.session_id,
                &input.prompt,
                &destination.conversation_id,
                &destination.thread_id,
            ))?)
        );
        let (mut transaction, order) = self.write().await?;
        let prior = sqlx::query("SELECT request_digest, task_id FROM supertag_v2_inbound_events WHERE account_id = $1 AND event_id = $2")
            .bind(account).bind(&input.event_id).fetch_optional(&mut *transaction).await?;
        if let Some(prior) = prior {
            if prior.try_get::<String, _>("request_digest")? != digest {
                return Err(StoreError::Conflict(
                    "event ID was used with different content or routing".into(),
                ));
            }
            let task = task_in(&mut transaction, &prior.try_get::<String, _>("task_id")?).await?;
            transaction.commit().await?;
            return Ok(task);
        }
        crate::objectives::objective_admission_in(
            &mut transaction,
            &input.tag_id,
            &input.session_id,
            self.execution_now_ms(),
        )
        .await?;
        let task = insert_task(
            &mut transaction,
            order,
            &input.tag_id,
            &input.session_id,
            &input.prompt,
        )
        .await?;
        crate::objectives::objective_link_task_in(&mut transaction, &task).await?;
        sqlx::query("INSERT INTO supertag_v2_inbound_events (account_id, event_id, request_digest, task_id, conversation_id, thread_id) VALUES ($1,$2,$3,$4,$5,$6)")
            .bind(account).bind(&input.event_id).bind(digest).bind(&task.task_id).bind(&destination.conversation_id).bind(&destination.thread_id)
            .execute(&mut *transaction).await?;
        transaction.commit().await?;
        Ok(task)
    }

    pub async fn claim_reply(
        &self,
        principal: &str,
        operation_id: &str,
    ) -> Result<ClaimReplyResponse> {
        let account = connector_account(principal)?;
        name("operation ID", operation_id)?;
        let (mut transaction, _) = self.write().await?;
        let prior = sqlx::query("SELECT reply_id, lease_token FROM supertag_v2_reply_claims WHERE account_id = $1 AND operation_id = $2")
            .bind(account).bind(operation_id).fetch_optional(&mut *transaction).await?;
        if let Some(prior) = prior {
            let reply = reply_in(
                &mut transaction,
                account,
                &prior.try_get::<String, _>("reply_id")?,
            )
            .await?;
            let response = ClaimReplyResponse {
                reply: Some(reply_row(&reply)?),
                lease_token: prior.try_get("lease_token")?,
            };
            transaction.commit().await?;
            return Ok(response);
        }
        let id: Option<String> = sqlx::query_scalar("SELECT reply_id FROM supertag_v2_replies WHERE account_id = $1 AND state = $2 ORDER BY ready_order LIMIT 1")
            .bind(account).bind(ReplyState::Pending as i64).fetch_optional(&mut *transaction).await?;
        let Some(id) = id else {
            transaction.rollback().await?;
            return Ok(ClaimReplyResponse {
                reply: None,
                lease_token: String::new(),
            });
        };
        let lease = Uuid::new_v4().to_string();
        sqlx::query(
            "UPDATE supertag_v2_replies SET state = $1, lease_token = $2 WHERE reply_id = $3",
        )
        .bind(ReplyState::Claimed as i64)
        .bind(&lease)
        .bind(&id)
        .execute(&mut *transaction)
        .await?;
        sqlx::query("INSERT INTO supertag_v2_reply_claims (account_id, operation_id, reply_id, lease_token) VALUES ($1,$2,$3,$4)")
            .bind(account).bind(operation_id).bind(&id).bind(&lease).execute(&mut *transaction).await?;
        let row = reply_in(&mut transaction, account, &id).await?;
        let reply = reply_row(&row)?;
        transaction.commit().await?;
        Ok(ClaimReplyResponse {
            reply: Some(reply),
            lease_token: lease,
        })
    }

    pub async fn settle_reply(&self, principal: &str, input: &SettleReplyRequest) -> Result<Reply> {
        let account = connector_account(principal)?;
        name("reply ID", &input.reply_id)?;
        name("lease token", &input.lease_token)?;
        if ![
            ReplyState::Delivered as i32,
            ReplyState::Failed as i32,
            ReplyState::Uncertain as i32,
        ]
        .contains(&input.state)
        {
            return Err(invalid(
                "reply settlement must be delivered, failed, or uncertain",
            ));
        }
        if let Some(receipt) = &input.provider_receipt {
            text("provider receipt", receipt, 4_096)?;
        }
        let (mut transaction, _) = self.write().await?;
        let row = reply_in(&mut transaction, account, &input.reply_id).await?;
        if row.try_get::<Option<String>, _>("lease_token")?.as_deref()
            != Some(input.lease_token.as_str())
        {
            return Err(StoreError::PermissionDenied);
        }
        let state: i64 = row.try_get("state")?;
        if state == ReplyState::Claimed as i64 {
            sqlx::query("UPDATE supertag_v2_replies SET state = $1, provider_receipt = $2 WHERE reply_id = $3")
                .bind(input.state as i64).bind(&input.provider_receipt).bind(&input.reply_id).execute(&mut *transaction).await?;
        } else if state != input.state as i64
            || row.try_get::<Option<String>, _>("provider_receipt")? != input.provider_receipt
        {
            return Err(StoreError::Conflict(
                "reply already has a different settlement".into(),
            ));
        }
        let reply = reply_row(&reply_in(&mut transaction, account, &input.reply_id).await?)?;
        transaction.commit().await?;
        Ok(reply)
    }

    pub async fn list_events(
        &self,
        task_id: &str,
        after_sequence: u64,
        limit: u32,
    ) -> Result<Vec<TaskEvent>> {
        self.get_task(task_id).await?;
        let after =
            i64::try_from(after_sequence).map_err(|_| invalid("event cursor is too large"))?;
        let limit = if limit == 0 { 32 } else { limit.min(32) } as i64;
        sqlx::query("SELECT sequence, text FROM supertag_v2_task_events WHERE task_id = $1 AND sequence > $2 ORDER BY sequence LIMIT $3")
            .bind(task_id).bind(after).bind(limit).fetch_all(&self.pool).await?.into_iter()
            .map(|row| Ok(TaskEvent { sequence: row.try_get::<i64, _>("sequence")? as u64, text: row.try_get("text")? })).collect()
    }
}

pub(crate) async fn insert_task(
    transaction: &mut Transaction<'_, Any>,
    order: i64,
    tag_id: &str,
    session_id: &str,
    prompt: &str,
) -> Result<Task> {
    let tag = sqlx::query(
        "SELECT instructions, allowed_actions, revision FROM supertag_v2_tags WHERE tag_id = $1",
    )
    .bind(tag_id)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or_else(|| StoreError::NotFound("Tag was not found".into()))?;
    let id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO supertag_v2_tasks (task_id, tag_id, session_id, prompt, instructions, allowed_actions, tag_revision, state, accepted_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)")
        .bind(&id).bind(tag_id).bind(session_id).bind(prompt)
        .bind(tag.try_get::<String, _>("instructions")?).bind(tag.try_get::<String, _>("allowed_actions")?)
        .bind(tag.try_get::<i64, _>("revision")?).bind(TaskState::Queued as i64).bind(order)
        .execute(&mut **transaction).await?;
    task_in(transaction, &id).await
}

async fn enqueue_reply(
    transaction: &mut Transaction<'_, Any>,
    task: &Task,
    order: i64,
) -> Result<()> {
    let route = sqlx::query("SELECT account_id, conversation_id, thread_id FROM supertag_v2_inbound_events WHERE task_id = $1")
        .bind(&task.task_id).fetch_optional(&mut **transaction).await?;
    let Some(route) = route else {
        return Ok(());
    };
    let result = task
        .result
        .as_deref()
        .ok_or_else(|| StoreError::FailedPrecondition("succeeded Task has no result".into()))?;
    sqlx::query("INSERT INTO supertag_v2_replies (reply_id, task_id, account_id, conversation_id, thread_id, text, state, ready_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(task_id) DO NOTHING")
        .bind(Uuid::new_v4().to_string()).bind(&task.task_id).bind(route.try_get::<String, _>("account_id")?)
        .bind(route.try_get::<String, _>("conversation_id")?).bind(route.try_get::<Option<String>, _>("thread_id")?)
        .bind(result).bind(ReplyState::Pending as i64).bind(order).execute(&mut **transaction).await?;
    Ok(())
}

fn connector_account(principal: &str) -> Result<&str> {
    name("principal", principal)?;
    let account = principal
        .strip_prefix("connector:")
        .ok_or(StoreError::PermissionDenied)?;
    name("connector account", account)?;
    Ok(account)
}

async fn reply_in(
    transaction: &mut Transaction<'_, Any>,
    account: &str,
    reply_id: &str,
) -> Result<AnyRow> {
    sqlx::query("SELECT * FROM supertag_v2_replies WHERE reply_id = $1 AND account_id = $2")
        .bind(reply_id)
        .bind(account)
        .fetch_optional(&mut **transaction)
        .await?
        .ok_or_else(|| StoreError::NotFound("reply was not found".into()))
}

fn reply_row(row: &AnyRow) -> Result<Reply> {
    Ok(Reply {
        reply_id: row.try_get("reply_id")?,
        task_id: row.try_get("task_id")?,
        account_id: row.try_get("account_id")?,
        destination: Some(ReplyDestination {
            conversation_id: row.try_get("conversation_id")?,
            thread_id: row.try_get("thread_id")?,
        }),
        text: row.try_get("text")?,
        state: row.try_get::<i64, _>("state")? as i32,
        provider_receipt: row.try_get("provider_receipt")?,
    })
}

pub(crate) async fn task_in(transaction: &mut Transaction<'_, Any>, id: &str) -> Result<Task> {
    let row = sqlx::query("SELECT * FROM supertag_v2_tasks WHERE task_id = $1")
        .bind(id)
        .fetch_optional(&mut **transaction)
        .await?
        .ok_or_else(|| StoreError::NotFound("Task was not found".into()))?;
    task_row(&row)
}

pub(crate) async fn owned(
    transaction: &mut Transaction<'_, Any>,
    principal: &str,
    task_id: &str,
    attempt_id: &str,
    lease_token: &str,
) -> Result<AnyRow> {
    name("principal", principal)?;
    name("Task ID", task_id)?;
    name("Task Attempt ID", attempt_id)?;
    name("lease token", lease_token)?;
    let row = sqlx::query("SELECT * FROM supertag_v2_tasks WHERE task_id = $1")
        .bind(task_id)
        .fetch_optional(&mut **transaction)
        .await?
        .ok_or_else(|| StoreError::NotFound("Task was not found".into()))?;
    if row
        .try_get::<Option<String>, _>("host_principal")?
        .as_deref()
        != Some(principal)
        || row.try_get::<Option<String>, _>("attempt_id")?.as_deref() != Some(attempt_id)
        || row.try_get::<Option<String>, _>("lease_token")?.as_deref() != Some(lease_token)
    {
        return Err(StoreError::PermissionDenied);
    }
    Ok(row)
}

fn task_row(row: &AnyRow) -> Result<Task> {
    Ok(Task {
        task_id: row.try_get("task_id")?,
        tag_id: row.try_get("tag_id")?,
        session_id: row.try_get("session_id")?,
        prompt: row.try_get("prompt")?,
        instructions: row.try_get("instructions")?,
        allowed_actions: serde_json::from_str(&row.try_get::<String, _>("allowed_actions")?)?,
        tag_revision: row.try_get::<i64, _>("tag_revision")? as u64,
        state: row.try_get::<i64, _>("state")? as i32,
        result: row.try_get("result")?,
        attempt_id: row.try_get("attempt_id")?,
    })
}

pub(crate) fn invalid(message: &str) -> StoreError {
    StoreError::InvalidArgument(message.into())
}

pub(crate) fn name(kind: &str, value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(invalid(&format!(
            "{kind} must contain 1–256 bytes without control characters"
        )));
    }
    Ok(())
}

pub(crate) fn text(kind: &str, value: &str, maximum: usize) -> Result<()> {
    if value.len() > maximum {
        return Err(invalid(&format!("{kind} exceeds its size limit")));
    }
    Ok(())
}
