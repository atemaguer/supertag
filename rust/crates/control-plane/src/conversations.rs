mod work_sessions;

pub(crate) use work_sessions::{work_session_child_in, work_session_in};

use prost::Message;
use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};
use uuid::Uuid;

use crate::{
    ControlPlane, Store, StoreError,
    inputs::{input_for_follower_in, record_live_input_in},
    objectives::{objective_admission_in, objective_link_task_in},
    store::{Result, insert_task_with_limits, invalid, name, task_in, text},
};

const SESSION_PREFIX: &str = "conversation/";
const PAGE_BYTES: usize = MAX_MESSAGE_BYTES - 1024;

pub(crate) fn private_session(session_id: &str) -> bool {
    session_id.starts_with(SESSION_PREFIX)
}

impl Store {
    pub async fn list_tags(&self, input: &ListTagsRequest) -> Result<ListTagsResponse> {
        if !input.cursor.is_empty() {
            name("Tag cursor", &input.cursor)?;
        }
        let limit = page_size(input.limit);
        let rows = sqlx::query(
            "SELECT * FROM supertag_v2_tags
             WHERE tag_id > $1 AND ($2=1 OR retired_at_ms IS NULL) ORDER BY tag_id LIMIT $3",
        )
        .bind(&input.cursor)
        .bind(i64::from(input.include_retired))
        .bind(limit + 1)
        .fetch_all(&self.pool)
        .await?;
        let mut page = Page::new(limit);
        for row in rows {
            let tag = crate::tags::tag_from_row(&row)?;
            let cursor = tag.tag_id.clone();
            if !page.push(tag, cursor)? {
                break;
            }
        }
        let (tags, next_cursor) = page.finish();
        Ok(ListTagsResponse { tags, next_cursor })
    }

    pub async fn send_message(
        &self,
        principal: &str,
        input: &SendMessageRequest,
    ) -> Result<ConversationMessage> {
        let execution_limits = crate::budget_pool::normalize(input.execution_limits.as_ref())?;
        operator(principal)?;
        name("Tag ID", &input.tag_id)?;
        conversation_name(&input.conversation)?;
        name("operation ID", &input.operation_id)?;
        text("message", &input.text, crate::store::MAX_TASK_PROMPT_BYTES)?;
        if input.text.trim().is_empty() {
            return Err(invalid("message text is required"));
        }
        let mut digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                &input.tag_id,
                &input.conversation,
                &input.text,
            ))?)
        );
        if let Some(limits) = &execution_limits {
            digest = format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&(
                    &digest,
                    prost::Message::encode_to_vec(limits)
                ))?)
            );
        }
        let (mut tx, order) = self.write().await?;
        let prior = sqlx::query("SELECT task_id,request_digest FROM supertag_v2_conversation_messages WHERE principal=$1 AND operation_id=$2")
            .bind(principal).bind(&input.operation_id).fetch_optional(&mut *tx).await?;
        if let Some(prior) = prior {
            if prior.try_get::<String, _>("request_digest")? != digest {
                return Err(StoreError::Conflict(
                    "operation ID was used with a different message".into(),
                ));
            }
            let task_id: String = prior.try_get("task_id")?;
            let message = message_in(&mut tx, &input.conversation, &task_id, None).await?;
            tx.rollback().await?;
            return Ok(message);
        }

        let previous = session_in(&mut tx, principal, &input.tag_id, &input.conversation).await?;
        let session = previous
            .clone()
            .unwrap_or_else(|| format!("{SESSION_PREFIX}{}", Uuid::new_v4()));
        let now = self.execution_now_ms();
        objective_admission_in(&mut tx, &input.tag_id, &session, now).await?;
        let task = insert_task_with_limits(
            &mut tx,
            order,
            &input.tag_id,
            &session,
            &input.text,
            execution_limits.as_ref(),
        )
        .await?;
        objective_link_task_in(&mut tx, &task).await?;
        if previous.is_none() {
            sqlx::query("INSERT INTO supertag_v2_conversations (session_id,principal,tag_id,name,created_order) VALUES ($1,$2,$3,$4,$5)")
                .bind(&session).bind(principal).bind(&input.tag_id).bind(&input.conversation)
                .bind(order).execute(&mut *tx).await?;
        }

        sqlx::query("INSERT INTO supertag_v2_conversation_messages (task_id,session_id,principal,operation_id,request_digest,accepted_order) VALUES ($1,$2,$3,$4,$5,$6)")
            .bind(&task.task_id).bind(&session).bind(principal).bind(&input.operation_id).bind(digest)
            .bind(order).execute(&mut *tx).await?;
        let active = if input.text.len() <= crate::inputs::MAX_INPUT_BYTES {
            sqlx::query("SELECT task_id,attempt_id FROM supertag_v2_tasks t WHERE tag_id=$1 AND session_id=$2 AND state=$3 AND lease_expires_at_ms>$4 AND NOT EXISTS (SELECT 1 FROM supertag_v2_work_session_tasks wt WHERE wt.task_id=t.task_id AND wt.kind=$5) ORDER BY accepted_order LIMIT 1")
                .bind(&input.tag_id).bind(&session).bind(TaskState::Running as i64).bind(now)
                .bind(crate::work_sessions::REPORT).fetch_optional(&mut *tx).await?
        } else {
            None
        };
        let live_input = if let Some(active) = active {
            let source: String = active.try_get("task_id")?;
            let attempt: String = active.try_get("attempt_id")?;
            let operation = format!("conversation/{}", task.task_id);
            record_live_input_in(
                &mut tx, principal, &operation, &source, &attempt, &task, order,
            )
            .await?
        } else {
            None
        };
        tx.commit().await?;
        Ok(ConversationMessage {
            task: Some(task),
            conversation: input.conversation.clone(),
            live_input,
            work_session_report_id: None,
        })
    }

    pub async fn list_conversations(
        &self,
        principal: &str,
        input: &ListConversationsRequest,
    ) -> Result<ListConversationsResponse> {
        operator(principal)?;
        if !input.tag_id.is_empty() {
            name("Tag ID", &input.tag_id)?;
        }
        let limit = page_size(input.limit);
        let cursor = order_cursor(&input.cursor)?;
        let mut tx = self.pool.begin().await?;
        let rows = sqlx::query(
            "SELECT c.name,c.tag_id,c.session_id,c.created_order,latest.task_id,latest.work_session_report_id
             FROM supertag_v2_conversations c JOIN supertag_v2_conversation_history latest
               ON latest.task_id=(SELECT h.task_id FROM supertag_v2_conversation_history h
                                   WHERE h.session_id=c.session_id ORDER BY h.accepted_order DESC LIMIT 1)
             WHERE c.principal=$1 AND c.created_order<$2 AND ($3='' OR c.tag_id=$3)
             ORDER BY c.created_order DESC LIMIT $4",
        )
            .bind(principal).bind(cursor).bind(&input.tag_id).bind(limit + 1).fetch_all(&mut *tx).await?;
        let mut page = Page::new(limit);
        for row in rows {
            let latest_id: String = row.try_get("task_id")?;
            let report_id: Option<String> = row.try_get("work_session_report_id")?;
            let conversation = Conversation {
                tag_id: row.try_get("tag_id")?,
                name: row.try_get("name")?,
                session_id: row.try_get("session_id")?,
                latest_task: Some(
                    conversation_task_in(&mut tx, &latest_id, report_id.is_some()).await?,
                ),
            };
            if !page.push(
                conversation,
                row.try_get::<i64, _>("created_order")?.to_string(),
            )? {
                break;
            }
        }
        tx.commit().await?;
        let (conversations, next_cursor) = page.finish();
        Ok(ListConversationsResponse {
            conversations,
            next_cursor,
        })
    }

    pub async fn list_messages(
        &self,
        principal: &str,
        input: &ListMessagesRequest,
    ) -> Result<ListMessagesResponse> {
        operator(principal)?;
        name("Tag ID", &input.tag_id)?;
        conversation_name(&input.conversation)?;
        let limit = page_size(input.limit);
        let cursor = order_cursor(&input.cursor)?;
        let mut tx = self.pool.begin().await?;
        let mut page = Page::new(limit);
        if let Some(session) =
            session_in(&mut tx, principal, &input.tag_id, &input.conversation).await?
        {
            let rows = sqlx::query("SELECT task_id,accepted_order,work_session_report_id FROM supertag_v2_conversation_history WHERE session_id=$1 AND accepted_order<$2 ORDER BY accepted_order DESC LIMIT $3")
                .bind(session).bind(cursor).bind(limit + 1).fetch_all(&mut *tx).await?;
            for row in rows {
                let task_id: String = row.try_get("task_id")?;
                let message = message_in(
                    &mut tx,
                    &input.conversation,
                    &task_id,
                    row.try_get("work_session_report_id")?,
                )
                .await?;
                if !page.push(
                    message,
                    row.try_get::<i64, _>("accepted_order")?.to_string(),
                )? {
                    break;
                }
            }
        }
        tx.commit().await?;
        let (messages, next_cursor) = page.finish();
        Ok(ListMessagesResponse {
            messages,
            next_cursor,
        })
    }

    pub async fn get_message(
        &self,
        principal: &str,
        tag_id: &str,
        task_id: &str,
    ) -> Result<ConversationMessage> {
        operator(principal)?;
        name("Tag ID", tag_id)?;
        name("Task ID", task_id)?;
        let mut tx = self.pool.begin().await?;
        let entry = sqlx::query("SELECT c.name,h.work_session_report_id FROM supertag_v2_conversation_history h JOIN supertag_v2_conversations c ON c.session_id=h.session_id WHERE h.task_id=$1 AND c.principal=$2 AND c.tag_id=$3")
            .bind(task_id).bind(principal).bind(tag_id).fetch_optional(&mut *tx).await?
            .ok_or_else(|| StoreError::NotFound("Message was not found".into()))?;
        let conversation: String = entry.try_get("name")?;
        let message = message_in(
            &mut tx,
            &conversation,
            task_id,
            entry.try_get("work_session_report_id")?,
        )
        .await?;
        tx.commit().await?;
        Ok(message)
    }

    pub(crate) async fn ensure_task_access(&self, principal: &str, task_id: &str) -> Result<()> {
        name("Task ID", task_id)?;
        let mut tx = self.pool.begin().await?;
        if !task_access_in(&mut tx, principal, task_id).await? {
            return Err(StoreError::NotFound("Task was not found".into()));
        }
        tx.commit().await?;
        Ok(())
    }

    pub(crate) async fn ensure_input_access(&self, principal: &str, input_id: &str) -> Result<()> {
        name("live input ID", input_id)?;
        let allowed: Option<i64> = sqlx::query_scalar(
            "SELECT CAST(1 AS BIGINT) FROM supertag_v2_live_inputs i
             JOIN supertag_v2_task_audience source ON source.task_id=i.task_id
             JOIN supertag_v2_task_audience follower ON follower.task_id=i.follower_task_id
             WHERE i.input_id=$1 AND source.owner IN ('',$2) AND follower.owner IN ('',$2)",
        )
        .bind(input_id)
        .bind(principal)
        .fetch_optional(&self.pool)
        .await?;
        if allowed.is_none() {
            return Err(StoreError::NotFound("live input was not found".into()));
        }
        Ok(())
    }
}

pub(crate) async fn task_owner_in(
    tx: &mut Transaction<'_, Any>,
    task_id: &str,
) -> Result<Option<String>> {
    Ok(
        sqlx::query_scalar("SELECT owner FROM supertag_v2_task_audience WHERE task_id=$1")
            .bind(task_id)
            .fetch_optional(&mut **tx)
            .await?,
    )
}

pub(crate) async fn task_access_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    task_id: &str,
) -> Result<bool> {
    Ok(task_owner_in(tx, task_id)
        .await?
        .is_some_and(|owner| owner.is_empty() || owner == principal))
}

async fn session_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    tag: &str,
    conversation: &str,
) -> Result<Option<String>> {
    Ok(sqlx::query_scalar("SELECT session_id FROM supertag_v2_conversations WHERE principal=$1 AND tag_id=$2 AND name=$3")
        .bind(principal).bind(tag).bind(conversation).fetch_optional(&mut **tx).await?)
}

async fn message_in(
    tx: &mut Transaction<'_, Any>,
    conversation: &str,
    task_id: &str,
    work_session_report_id: Option<String>,
) -> Result<ConversationMessage> {
    let is_report = work_session_report_id.is_some();
    Ok(ConversationMessage {
        task: Some(conversation_task_in(tx, task_id, is_report).await?),
        conversation: conversation.to_owned(),
        live_input: if is_report {
            None
        } else {
            input_for_follower_in(tx, task_id).await?
        },
        work_session_report_id,
    })
}

async fn conversation_task_in(
    tx: &mut Transaction<'_, Any>,
    task_id: &str,
    report: bool,
) -> Result<Task> {
    let mut task = task_in(tx, task_id).await?;
    if report {
        // Report input is execution data. The conversation only presents its reply.
        task.prompt.clear();
    }
    Ok(task)
}

fn operator(principal: &str) -> Result<()> {
    let id = principal
        .strip_prefix("operator:")
        .ok_or(StoreError::PermissionDenied)?;
    name("operator identity", id)
}

fn conversation_name(value: &str) -> Result<()> {
    if value.len() > 64
        || !value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
    {
        return Err(invalid(
            "conversation name must start with a letter or digit and use at most 64 letters, digits, dots, underscores or hyphens",
        ));
    }
    Ok(())
}

fn page_size(limit: u32) -> i64 {
    i64::from(if limit == 0 { 32 } else { limit.min(128) })
}

fn order_cursor(value: &str) -> Result<i64> {
    if value.is_empty() {
        return Ok(i64::MAX);
    }
    value
        .parse::<i64>()
        .ok()
        .filter(|order| *order > 0 && order.to_string() == value)
        .ok_or_else(|| invalid("invalid conversation cursor"))
}

struct Page<T> {
    values: Vec<T>,
    cursor: String,
    remaining: usize,
    bytes: usize,
    more: bool,
}

impl<T: Message> Page<T> {
    fn new(limit: i64) -> Self {
        Self {
            values: Vec::new(),
            cursor: String::new(),
            remaining: limit as usize,
            bytes: PAGE_BYTES,
            more: false,
        }
    }

    fn push(&mut self, value: T, cursor: String) -> Result<bool> {
        let bytes = value.encoded_len() + 8;
        if self.remaining == 0 || bytes > self.bytes {
            if self.values.is_empty() {
                return Err(StoreError::FailedPrecondition(
                    "conversation entry exceeds the page size".into(),
                ));
            }
            self.more = true;
            return Ok(false);
        }
        self.remaining -= 1;
        self.bytes -= bytes;
        self.values.push(value);
        self.cursor = cursor;
        Ok(true)
    }

    fn finish(self) -> (Vec<T>, String) {
        (
            self.values,
            if self.more {
                self.cursor
            } else {
                String::new()
            },
        )
    }
}

#[tonic::async_trait]
impl conversations_server::Conversations for ControlPlane {
    async fn list_conversations(
        &self,
        request: Request<ListConversationsRequest>,
    ) -> std::result::Result<Response<ListConversationsResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_conversations(&principal, &request.into_inner())
                .await?,
        ))
    }

    async fn list_messages(
        &self,
        request: Request<ListMessagesRequest>,
    ) -> std::result::Result<Response<ListMessagesResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_messages(&principal, &request.into_inner())
                .await?,
        ))
    }

    async fn send_message(
        &self,
        request: Request<SendMessageRequest>,
    ) -> std::result::Result<Response<ConversationMessage>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .send_message(&principal, &request.into_inner())
                .await?,
        ))
    }

    async fn get_message(
        &self,
        request: Request<GetMessageRequest>,
    ) -> std::result::Result<Response<ConversationMessage>, Status> {
        let principal = self.principal(&request, "operator:")?;
        let input = request.into_inner();
        Ok(Response::new(
            self.store
                .get_message(&principal, &input.tag_id, &input.task_id)
                .await?,
        ))
    }

    async fn list_message_events(
        &self,
        request: Request<ListMessageEventsRequest>,
    ) -> std::result::Result<Response<ListEventsResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        let input = request.into_inner();
        self.store
            .get_message(&principal, &input.tag_id, &input.task_id)
            .await?;
        Ok(Response::new(ListEventsResponse {
            events: self
                .store
                .list_events(&input.task_id, input.after_sequence, input.limit)
                .await?,
        }))
    }
}
