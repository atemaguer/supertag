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
    store::{Result, insert_task, invalid, name, task_in, text},
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
            "SELECT * FROM supertag_v2_tags WHERE tag_id > $1 ORDER BY tag_id LIMIT $2",
        )
        .bind(&input.cursor)
        .bind(limit + 1)
        .fetch_all(&self.pool)
        .await?;
        let mut page = Page::new(limit);
        for row in rows {
            let tag = Tag {
                tag_id: row.try_get("tag_id")?,
                instructions: row.try_get("instructions")?,
                allowed_actions: serde_json::from_str(
                    &row.try_get::<String, _>("allowed_actions")?,
                )?,
                revision: row.try_get::<i64, _>("revision")? as u64,
                workspace: crate::workspaces::workspace_from_row(&row)?,
                harness_kind: row.try_get::<i64, _>("harness_kind")? as i32,
            };
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
        operator(principal)?;
        name("Tag ID", &input.tag_id)?;
        conversation_name(&input.conversation)?;
        name("operation ID", &input.operation_id)?;
        text("message", &input.text, 262_144)?;
        if input.text.trim().is_empty() {
            return Err(invalid("message text is required"));
        }
        let digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                &input.tag_id,
                &input.conversation,
                &input.text,
            ))?)
        );
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
            let message = message_in(&mut tx, &input.conversation, &task_id).await?;
            tx.rollback().await?;
            return Ok(message);
        }

        let previous = session_in(&mut tx, principal, &input.tag_id, &input.conversation).await?;
        let session = previous
            .clone()
            .unwrap_or_else(|| format!("{SESSION_PREFIX}{}", Uuid::new_v4()));
        let now = self.execution_now_ms();
        objective_admission_in(&mut tx, &input.tag_id, &session, now).await?;
        let task = insert_task(&mut tx, order, &input.tag_id, &session, &input.text).await?;
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
            sqlx::query("SELECT task_id,attempt_id FROM supertag_v2_tasks WHERE tag_id=$1 AND session_id=$2 AND state=$3 AND lease_expires_at_ms>$4 ORDER BY accepted_order LIMIT 1")
                .bind(&input.tag_id).bind(&session).bind(TaskState::Running as i64).bind(now)
                .fetch_optional(&mut *tx).await?
        } else {
            None
        };
        let live_input = if let Some(active) = active {
            let source: String = active.try_get("task_id")?;
            let attempt: String = active.try_get("attempt_id")?;
            let operation = format!("conversation/{}", task.task_id);
            Some(
                record_live_input_in(
                    &mut tx, principal, &operation, &source, &attempt, &task, order,
                )
                .await?,
            )
        } else {
            None
        };
        tx.commit().await?;
        Ok(ConversationMessage {
            task: Some(task),
            conversation: input.conversation.clone(),
            live_input,
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
        let rows = sqlx::query("SELECT c.name,c.tag_id,c.session_id,c.created_order,(SELECT m.task_id FROM supertag_v2_conversation_messages m WHERE m.session_id=c.session_id ORDER BY m.accepted_order DESC LIMIT 1) AS latest_task_id FROM supertag_v2_conversations c WHERE c.principal=$1 AND c.created_order<$2 AND ($3='' OR c.tag_id=$3) ORDER BY c.created_order DESC LIMIT $4")
            .bind(principal).bind(cursor).bind(&input.tag_id).bind(limit + 1).fetch_all(&mut *tx).await?;
        let mut page = Page::new(limit);
        for row in rows {
            let latest_id: String = row.try_get("latest_task_id")?;
            let conversation = Conversation {
                tag_id: row.try_get("tag_id")?,
                name: row.try_get("name")?,
                session_id: row.try_get("session_id")?,
                latest_task: Some(task_in(&mut tx, &latest_id).await?),
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
            let rows = sqlx::query("SELECT task_id,accepted_order FROM supertag_v2_conversation_messages WHERE session_id=$1 AND accepted_order<$2 ORDER BY accepted_order DESC LIMIT $3")
                .bind(session).bind(cursor).bind(limit + 1).fetch_all(&mut *tx).await?;
            for row in rows {
                let task_id: String = row.try_get("task_id")?;
                let message = message_in(&mut tx, &input.conversation, &task_id).await?;
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
        let conversation: String = sqlx::query_scalar("SELECT c.name FROM supertag_v2_conversation_messages m JOIN supertag_v2_conversations c ON c.session_id=m.session_id WHERE m.task_id=$1 AND c.principal=$2 AND c.tag_id=$3")
            .bind(task_id).bind(principal).bind(tag_id).fetch_optional(&mut *tx).await?
            .ok_or_else(|| StoreError::NotFound("Message was not found".into()))?;
        let message = message_in(&mut tx, &conversation, task_id).await?;
        tx.commit().await?;
        Ok(message)
    }

    pub(crate) async fn ensure_task_access(&self, principal: &str, task_id: &str) -> Result<()> {
        let owner: Option<String> = sqlx::query_scalar(
            "SELECT principal FROM supertag_v2_conversation_messages WHERE task_id=$1",
        )
        .bind(task_id)
        .fetch_optional(&self.pool)
        .await?;
        ensure_owner(principal, owner)
    }

    pub(crate) async fn ensure_input_access(&self, principal: &str, input_id: &str) -> Result<()> {
        let owner: Option<String> = sqlx::query_scalar("SELECT m.principal FROM supertag_v2_live_inputs i JOIN supertag_v2_conversation_messages m ON m.task_id=i.follower_task_id WHERE i.input_id=$1")
            .bind(input_id).fetch_optional(&self.pool).await?;
        ensure_owner(principal, owner)
    }
}

fn ensure_owner(principal: &str, owner: Option<String>) -> Result<()> {
    if owner.is_some_and(|owner| owner != principal) {
        return Err(StoreError::NotFound(
            "Conversation work was not found".into(),
        ));
    }
    Ok(())
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
) -> Result<ConversationMessage> {
    Ok(ConversationMessage {
        task: Some(task_in(tx, task_id).await?),
        conversation: conversation.to_owned(),
        live_input: input_for_follower_in(tx, task_id).await?,
    })
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
