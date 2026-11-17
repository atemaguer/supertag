mod follow;
mod texts;
mod work_sessions;

pub(crate) use follow::Live;

pub(crate) use work_sessions::{work_session_child_in, work_session_in};

use prost::Message;
use sha2::{Digest, Sha256};
use sqlx::{Acquire, Any, Row, Transaction};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};
use uuid::Uuid;

use crate::{
    ControlPlane, Store, StoreError,
    inputs::inputs_for_followers_in,
    objectives::{objective_admission_in, objective_link_task_in},
    store::{
        ID_BATCH, Result, insert_task_with_requirements, invalid, name, next_order,
        output_policy_digest, placeholders, tasks_in, text,
    },
    surface_objectives::Command,
};

const SESSION_PREFIX: &str = "conversation/";
const PAGE_BYTES: usize = MAX_MESSAGE_BYTES - 1024;
/// The most a message's events take of a history page. A prompt and a result are each at most
/// 256 KiB, so a message with its events still fits a page.
const MESSAGE_EVENT_BYTES: usize = 128 * 1024;

pub(crate) fn private_session(session_id: &str) -> bool {
    session_id.starts_with(SESSION_PREFIX)
}

/// The outcome of a `/goal` message, or `Some(None)` for `/goal` without one.
fn goal_command(text: &str) -> Option<Option<String>> {
    match crate::surface_objectives::parse(text)? {
        Command::Create(outcome) => Some(Some(outcome)),
        Command::Invalid => Some(None),
        Command::Approve | Command::Pause | Command::Resume => None,
    }
}

/// Creates the Objective a `/goal` message asks for, owned by the conversation's Tag and homed in
/// the message's Task, and returns the Control Plane's answer to the message. A request the
/// Control Plane refuses is answered with the reason, and nothing is created.
async fn goal_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    task: &Task,
    outcome: Option<&str>,
    now_ms: i64,
) -> Result<String> {
    let Some(outcome) = outcome else {
        return Ok(format!(
            "Say which outcome the Objective should achieve: {} <outcome>.",
            crate::surface_objectives::GOAL
        ));
    };
    let request = CreateObjectiveRequest {
        objective_id: crate::surface_objectives::new_objective_id(outcome),
        owner_tag_id: task.tag_id.clone(),
        outcome: outcome.to_owned(),
        ..Default::default()
    };
    let mut savepoint = tx.begin().await?;
    let order = next_order(&mut savepoint).await?;
    let created = Box::pin(crate::objectives::create_objective_in(
        &mut savepoint,
        order,
        now_ms,
        principal,
        &request,
        Some(&task.task_id),
    ))
    .await;
    match created {
        Ok(objective) => {
            savepoint.commit().await?;
            let id = &objective.objective_id;
            Ok(format!(
                "Created Objective {id}: {}\n{} owns it, and its first turn has started. This conversation is its home. Follow it with supertag describe objective {id}.",
                crate::surface_objectives::outcome_headline(&objective.outcome),
                objective.owner_tag_id,
            ))
        }
        Err(
            error @ (StoreError::FailedPrecondition(_)
            | StoreError::InvalidArgument(_)
            | StoreError::PermissionDenied
            | StoreError::Conflict(_)),
        ) => {
            savepoint.rollback().await?;
            Ok(format!(
                "The Objective was not created: {}.",
                error.to_string().trim_end_matches('.')
            ))
        }
        Err(error) => Err(error),
    }
}

impl Store {
    /// A client lists only the Tags its Auth Key lets it talk to.
    pub async fn list_tags(
        &self,
        principal: &str,
        input: &ListTagsRequest,
    ) -> Result<ListTagsResponse> {
        if !input.cursor.is_empty() {
            name("Tag cursor", &input.cursor)?;
        }
        let allowed = self.client_tags(principal).await?;
        let limit = page_size(input.limit);
        let rows = sqlx::query(&format!(
            "SELECT {} WHERE t.tag_id > $1 AND ($2=1 OR t.retired_at_ms IS NULL)
             ORDER BY t.tag_id LIMIT $3",
            crate::tags::READ
        ))
        .bind(&input.cursor)
        .bind(i64::from(input.include_retired))
        // A client's Tags are filtered below, so its page reads past the ones it may not see.
        .bind(if allowed.is_some() {
            i64::MAX
        } else {
            limit + 1
        })
        .fetch_all(&self.pool)
        .await?;
        let mut page = Page::new(limit);
        for row in rows {
            let tag = crate::tags::tag_from_row(&row)?;
            let cursor = tag.tag_id.clone();
            if allowed
                .as_ref()
                .is_some_and(|allowed| !allowed.contains(&tag.tag_id))
            {
                continue;
            }
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
        let _wake = self.wake_follows();
        let execution_limits = crate::budget_pool::normalize(input.execution_limits.as_ref())?;
        let output_policy =
            supertag_protocol::output_policy::normalize(input.output_policy.as_ref())
                .map_err(|error| invalid(error.message()))?;
        operator(principal)?;
        name("Tag ID", &input.tag_id)?;
        self.ensure_client_tag(principal, &input.tag_id).await?;
        name("operation ID", &input.operation_id)?;
        text("message", &input.text, crate::store::MAX_TASK_PROMPT_BYTES)?;
        if input.text.trim().is_empty() {
            return Err(invalid("message text is required"));
        }
        let mut digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(&input.tag_id, &input.text))?)
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
        let digest = output_policy_digest(digest, output_policy.as_ref())?;
        let (mut tx, order) = self.write().await?;
        let prior = sqlx::query("SELECT task_id,request_digest,accepted_order FROM supertag_v2_conversation_messages WHERE principal=$1 AND operation_id=$2")
            .bind(principal).bind(&input.operation_id).fetch_optional(&mut *tx).await?;
        if let Some(prior) = prior {
            if prior.try_get::<String, _>("request_digest")? != digest {
                return Err(StoreError::Conflict(
                    "operation ID was used with a different message".into(),
                ));
            }
            let entry = HistoryEntry {
                task_id: prior.try_get("task_id")?,
                report_id: None,
                order: prior.try_get("accepted_order")?,
            };
            let message = message_in(&mut tx, entry).await?;
            tx.rollback().await?;
            return Ok(message);
        }

        let previous = session_in(&mut tx, principal, &input.tag_id).await?;
        let session = previous
            .clone()
            .unwrap_or_else(|| format!("{SESSION_PREFIX}{}", Uuid::new_v4()));
        let now = self.execution_now_ms();
        objective_admission_in(&mut tx, &input.tag_id, &session, now).await?;
        let task = insert_task_with_requirements(
            &mut tx,
            order,
            &input.tag_id,
            &session,
            &input.text,
            (execution_limits.as_ref(), output_policy.as_ref()),
        )
        .await?;
        objective_link_task_in(&mut tx, &task).await?;
        if previous.is_none() {
            sqlx::query("INSERT INTO supertag_v2_conversations (session_id,principal,tag_id,created_order) VALUES ($1,$2,$3,$4)")
                .bind(&session).bind(principal).bind(&input.tag_id)
                .bind(order).execute(&mut *tx).await?;
        }

        // As recorded, so a replay of this send returns the same message.
        let sent_at: Option<i64> =
            sqlx::query_scalar("SELECT accepted_at_ms FROM supertag_v2_tasks WHERE task_id=$1")
                .bind(&task.task_id)
                .fetch_one(&mut *tx)
                .await?;
        let sent_at = sent_at.unwrap_or_default();
        sqlx::query("INSERT INTO supertag_v2_conversation_messages (task_id,session_id,principal,operation_id,request_digest,accepted_order) VALUES ($1,$2,$3,$4,$5,$6)")
            .bind(&task.task_id).bind(&session).bind(principal).bind(&input.operation_id).bind(digest)
            .bind(order).execute(&mut *tx).await?;
        // `/goal <outcome>` creates the Objective here: the Tag owns it, this conversation is its
        // home, and the Control Plane answers the message itself.
        if let Some(goal) = goal_command(&input.text) {
            let answer = goal_in(&mut tx, principal, &task, goal.as_deref(), now).await?;
            crate::surface_objectives::settle_in(&mut tx, &task.task_id, &answer, now).await?;
            let entry = HistoryEntry {
                task_id: task.task_id,
                report_id: None,
                order,
            };
            let message = message_in(&mut tx, entry).await?;
            tx.commit().await?;
            return Ok(message);
        }
        let operation = format!("conversation/{}", task.task_id);
        let live_input =
            crate::inputs::fold_in(&mut tx, principal, &operation, &task, order, now).await?;
        tx.commit().await?;
        Ok(sent(task, live_input, order, sent_at))
    }

    /// The caller's conversations, the latest active first, in a fixed number of queries.
    pub async fn list_conversations(
        &self,
        principal: &str,
        _input: &ListConversationsRequest,
    ) -> Result<ListConversationsResponse> {
        operator(principal)?;
        let allowed = self.client_tags(principal).await?;
        let mut tx = self.pool.begin().await?;
        let sessions = sqlx::query(
            "SELECT tag_id,session_id,created_order FROM supertag_v2_conversations
             WHERE principal=$1 ORDER BY created_order",
        )
        .bind(principal)
        .fetch_all(&mut *tx)
        .await?;
        let mut conversations: std::collections::BTreeMap<String, Conversation> =
            Default::default();
        for row in sessions {
            let tag_id: String = row.try_get("tag_id")?;
            if allowed
                .as_ref()
                .is_some_and(|allowed| !allowed.contains(&tag_id))
            {
                continue;
            }
            let session_id: String = row.try_get("session_id")?;
            conversations
                .entry(tag_id.clone())
                .or_insert_with(|| Conversation {
                    tag_id,
                    conversation_id: session_id,
                    ..Default::default()
                });
        }
        // Per conversation: its latest message, its unfinished Tasks, and its finished turns
        // after the read mark.
        let rows = sqlx::query(&format!(
            "SELECT c.tag_id,MAX(h.accepted_order) AS latest_order,
                    SUM(CASE WHEN t.state IN ({UNFINISHED}) THEN 1 ELSE 0 END) AS working,
                    SUM(CASE WHEN t.state IN ({FINISHED}) AND h.accepted_order>COALESCE(r.read_order,0)
                        THEN 1 ELSE 0 END) AS unread,
                    COALESCE(MAX(r.read_order),0) AS read_order
             FROM supertag_v2_conversations c
             JOIN supertag_v2_conversation_history h ON h.session_id=c.session_id
             JOIN supertag_v2_tasks t ON t.task_id=h.task_id AND t.quiet=0
             LEFT JOIN supertag_v2_conversation_reads r ON r.principal=c.principal AND r.tag_id=c.tag_id
             WHERE c.principal=$1 GROUP BY c.tag_id"
        ))
        .bind(principal)
        .fetch_all(&mut *tx)
        .await?;
        let mut latest_orders = Vec::with_capacity(rows.len());
        for row in rows {
            let Some(conversation) = conversations.get_mut(&row.try_get::<String, _>("tag_id")?)
            else {
                continue;
            };
            let latest: i64 = row.try_get("latest_order")?;
            conversation.latest_order = latest as u64;
            conversation.read_order = row.try_get::<i64, _>("read_order")? as u64;
            conversation.working = row.try_get::<i64, _>("working")? > 0;
            conversation.unread_count = row.try_get::<i64, _>("unread")?.try_into().unwrap_or(0);
            latest_orders.push(latest);
        }
        let latest = history_at_orders_in(&mut tx, &latest_orders).await?;
        let ids: Vec<&str> = latest.iter().map(|entry| entry.task_id.as_str()).collect();
        let tasks = tasks_in(&mut tx, &ids).await?;
        let fired = crate::schedules::fired_by_in(&mut tx, &ids).await?;
        let asking = open_questions_in(&mut tx, &ids).await?;
        for entry in &latest {
            let Some(row) = tasks.get(&entry.task_id) else {
                continue;
            };
            let Some(conversation) = conversations.get_mut(&row.task.tag_id) else {
                continue;
            };
            conversation.session_id = row.task.session_id.clone();
            let reply = row
                .task
                .result
                .as_deref()
                .filter(|result| !result.is_empty() && finished(row.task.state()));
            let (preview, from_tag) = match reply {
                Some(reply) => (reply, true),
                None if entry.report_id.is_some() || fired.contains_key(&entry.task_id) => {
                    ("", true)
                }
                None => (row.task.prompt.as_str(), false),
            };
            conversation.preview = preview.chars().take(PREVIEW_CHARS).collect();
            conversation.preview_from_tag = from_tag;
            conversation.latest_work_session_report_id = entry.report_id.clone();
            conversation.asking = asking.contains(&entry.task_id);
            conversation.last_activity_at_ms = row
                .completed_at_ms
                .or(row.accepted_at_ms)
                .unwrap_or_default();
        }
        tx.commit().await?;
        let mut conversations: Vec<_> = conversations.into_values().collect();
        conversations.sort_by(|a, b| b.latest_order.cmp(&a.latest_order));
        Ok(ListConversationsResponse { conversations })
    }

    pub async fn list_messages(
        &self,
        principal: &str,
        input: &ListMessagesRequest,
    ) -> Result<ListMessagesResponse> {
        operator(principal)?;
        name("Tag ID", &input.tag_id)?;
        self.ensure_client_tag(principal, &input.tag_id).await?;
        if input.refresh_task_ids.len() > 128 {
            return Err(invalid("at most 128 Tasks can be refreshed"));
        }
        for id in &input.refresh_task_ids {
            name("Task ID", id)?;
        }
        let limit = page_size(input.limit);
        let cursor = order_cursor(&input.cursor)?;
        let after = i64::try_from(input.after).map_err(|_| invalid("invalid message order"))?;
        let mut tx = self.pool.begin().await?;
        let conversation_id = conversation_id_in(&mut tx, principal, &input.tag_id)
            .await?
            .unwrap_or_default();
        if after > 0
            && !conversation_id.is_empty()
            && input.conversation_id == conversation_id
            && let Some(messages) =
                changes_in(&mut tx, principal, &input.tag_id, after, limit, input).await?
        {
            tx.commit().await?;
            return Ok(ListMessagesResponse {
                messages,
                next_cursor: String::new(),
                conversation_id,
                incremental: true,
            });
        }
        let rows = sqlx::query(&format!(
            "{HISTORY} AND h.accepted_order<$3 ORDER BY h.accepted_order DESC LIMIT $4"
        ))
        .bind(principal)
        .bind(&input.tag_id)
        .bind(cursor)
        .bind(limit + 1)
        .fetch_all(&mut *tx)
        .await?;
        let entries = rows.iter().map(history_entry).collect::<Result<Vec<_>>>()?;
        let messages = messages_in(&mut tx, entries).await?;
        tx.commit().await?;
        let mut page = Page::new(limit);
        for message in messages {
            let order = message.order.to_string();
            if !page.push(message, order)? {
                break;
            }
        }
        let (messages, next_cursor) = page.finish();
        Ok(ListMessagesResponse {
            messages,
            next_cursor,
            conversation_id,
            incremental: false,
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
        let row = sqlx::query(&format!("{HISTORY_WITH_QUIET} AND h.task_id=$3"))
            .bind(principal)
            .bind(tag_id)
            .bind(task_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| StoreError::NotFound("Message was not found".into()))?;
        let message = message_in(&mut tx, history_entry(&row)?).await?;
        tx.commit().await?;
        Ok(message)
    }

    /// Records that `principal` read its conversation with a Tag up to a finished turn. The mark
    /// never moves back.
    pub async fn mark_conversation_read(
        &self,
        principal: &str,
        input: &MarkConversationReadRequest,
    ) -> Result<Conversation> {
        operator(principal)?;
        name("Tag ID", &input.tag_id)?;
        self.ensure_client_tag(principal, &input.tag_id).await?;
        let order = i64::try_from(input.order).map_err(|_| invalid("invalid message order"))?;
        let (mut tx, _) = self.write().await?;
        if conversation_id_in(&mut tx, principal, &input.tag_id)
            .await?
            .is_none()
        {
            return Err(StoreError::NotFound("Conversation was not found".into()));
        }
        let now = self.execution_now_ms();
        let prior: Option<i64> = sqlx::query_scalar(
            "SELECT read_order FROM supertag_v2_conversation_reads WHERE principal=$1 AND tag_id=$2",
        )
        .bind(principal)
        .bind(&input.tag_id)
        .fetch_optional(&mut *tx)
        .await?;
        match prior {
            None => {
                sqlx::query("INSERT INTO supertag_v2_conversation_reads (principal,tag_id,read_order,read_at_ms) VALUES ($1,$2,$3,$4)")
                    .bind(principal).bind(&input.tag_id).bind(order).bind(now)
                    .execute(&mut *tx).await?;
            }
            Some(prior) if prior < order => {
                sqlx::query("UPDATE supertag_v2_conversation_reads SET read_order=$1,read_at_ms=$2 WHERE principal=$3 AND tag_id=$4")
                    .bind(order).bind(now).bind(principal).bind(&input.tag_id)
                    .execute(&mut *tx).await?;
            }
            Some(_) => {}
        }
        crate::attention::read_in(&mut tx, principal, &input.tag_id, order, now).await?;
        tx.commit().await?;
        self.list_conversations(principal, &ListConversationsRequest {})
            .await?
            .conversations
            .into_iter()
            .find(|conversation| conversation.tag_id == input.tag_id)
            .ok_or_else(|| StoreError::NotFound("Conversation was not found".into()))
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
        let allowed: Option<i64> = sqlx::query_scalar(&format!(
            "SELECT CAST(1 AS BIGINT) FROM supertag_v2_live_inputs i
             JOIN supertag_v2_task_audience source ON source.task_id=i.task_id
             JOIN supertag_v2_task_audience follower ON follower.task_id=i.follower_task_id
             WHERE i.input_id=$1 AND {} AND {}",
            crate::store::sees_owner_sql("source.owner", "$2"),
            crate::store::sees_owner_sql("follower.owner", "$2"),
        ))
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
        .is_some_and(|owner| crate::store::sees_owner(principal, &owner)))
}

/// The conversation's history: the messages of every Session of `principal`'s conversation with
/// the Tag in `$2`, without quiet turns. Callers add conditions from `$3`.
const HISTORY: &str = "SELECT h.task_id,h.accepted_order,h.work_session_report_id
     FROM supertag_v2_conversation_history h
     WHERE h.session_id IN (SELECT c.session_id FROM supertag_v2_conversations c
                            WHERE c.principal=$1 AND c.tag_id=$2)
       AND NOT EXISTS (SELECT 1 FROM supertag_v2_tasks q WHERE q.task_id=h.task_id AND q.quiet=1)";
/// [`HISTORY`] with its quiet turns, for a client that holds one as unfinished or asks for it: it
/// learns the turn ended quietly (`Task.quiet`) and drops it.
const HISTORY_WITH_QUIET: &str = "SELECT h.task_id,h.accepted_order,h.work_session_report_id
     FROM supertag_v2_conversation_history h
     WHERE h.session_id IN (SELECT c.session_id FROM supertag_v2_conversations c
                            WHERE c.principal=$1 AND c.tag_id=$2)";
const UNFINISHED: &str = "1,2,6";
const FINISHED: &str = "3,4,5";
/// How much of the latest message a conversation list shows.
const PREVIEW_CHARS: usize = 200;

fn finished(state: TaskState) -> bool {
    matches!(
        state,
        TaskState::Succeeded | TaskState::Failed | TaskState::Cancelled
    )
}

/// A conversation history row: its Task, the report it carries, and its order.
struct HistoryEntry {
    task_id: String,
    report_id: Option<String>,
    order: i64,
}

fn history_entry(row: &sqlx::any::AnyRow) -> Result<HistoryEntry> {
    Ok(HistoryEntry {
        task_id: row.try_get("task_id")?,
        report_id: row.try_get("work_session_report_id")?,
        order: row.try_get("accepted_order")?,
    })
}

async fn history_at_orders_in(
    tx: &mut Transaction<'_, Any>,
    orders: &[i64],
) -> Result<Vec<HistoryEntry>> {
    let mut entries = Vec::with_capacity(orders.len());
    for chunk in orders.chunks(ID_BATCH) {
        let sql = format!(
            "SELECT task_id,accepted_order,work_session_report_id FROM supertag_v2_conversation_history
             WHERE accepted_order IN ({})",
            placeholders(1, chunk.len())
        );
        let mut query = sqlx::query(&sql);
        for order in chunk {
            query = query.bind(*order);
        }
        for row in query.fetch_all(&mut **tx).await? {
            entries.push(history_entry(&row)?);
        }
    }
    Ok(entries)
}

/// What changed in the conversation after `after`: its later messages and the current state of
/// the requested ones, newest first. `None` when that is more than a page, so the caller reads the
/// newest page instead.
async fn changes_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    tag_id: &str,
    after: i64,
    limit: i64,
    input: &ListMessagesRequest,
) -> Result<Option<Vec<ConversationMessage>>> {
    let rows = sqlx::query(&format!(
        "{HISTORY} AND h.accepted_order>$3 ORDER BY h.accepted_order LIMIT $4"
    ))
    .bind(principal)
    .bind(tag_id)
    .bind(after)
    .bind(limit + 1)
    .fetch_all(&mut **tx)
    .await?;
    if rows.len() as i64 > limit {
        return Ok(None);
    }
    let mut entries = rows.iter().map(history_entry).collect::<Result<Vec<_>>>()?;
    if !input.refresh_task_ids.is_empty() {
        let sql = format!(
            "{HISTORY_WITH_QUIET} AND h.accepted_order<=$3 AND h.task_id IN ({})",
            placeholders(4, input.refresh_task_ids.len())
        );
        let mut query = sqlx::query(&sql).bind(principal).bind(tag_id).bind(after);
        for id in &input.refresh_task_ids {
            query = query.bind(id);
        }
        for row in query.fetch_all(&mut **tx).await? {
            entries.push(history_entry(&row)?);
        }
    }
    entries.sort_by(|a, b| b.order.cmp(&a.order));
    let messages = messages_in(tx, entries).await?;
    let bytes: usize = messages
        .iter()
        .map(|message| message.encoded_len() + 8)
        .sum();
    Ok((bytes <= PAGE_BYTES).then_some(messages))
}

/// Which of these Tasks asked an Objective question that waits for an answer.
async fn open_questions_in(
    tx: &mut Transaction<'_, Any>,
    task_ids: &[&str],
) -> Result<std::collections::HashSet<String>> {
    let mut open = std::collections::HashSet::new();
    for chunk in task_ids.chunks(ID_BATCH) {
        let sql = format!(
            "SELECT q.task_id FROM supertag_v2_objective_questions q
             JOIN supertag_v2_tasks t ON t.task_id=q.task_id AND t.attempt_id=q.attempt_id
             JOIN supertag_v2_objectives o ON o.objective_id=q.objective_id
             WHERE q.task_id IN ({}) AND q.published_at_ms IS NOT NULL AND q.answer_task_id IS NULL
               AND o.status NOT IN (5,6)",
            placeholders(1, chunk.len())
        );
        let mut query = sqlx::query_scalar::<_, String>(&sql);
        for id in chunk {
            query = query.bind(*id);
        }
        open.extend(query.fetch_all(&mut **tx).await?);
    }
    Ok(open)
}

/// A new conversation Session's ID.
pub(crate) fn new_session_id() -> String {
    format!("{SESSION_PREFIX}{}", Uuid::new_v4())
}

/// The Session the conversation continues: the one its latest message is in.
pub(crate) async fn session_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    tag: &str,
) -> Result<Option<String>> {
    Ok(sqlx::query_scalar(
        "SELECT c.session_id FROM supertag_v2_conversations c
         LEFT JOIN supertag_v2_conversation_messages m ON m.session_id=c.session_id
         WHERE c.principal=$1 AND c.tag_id=$2
         ORDER BY COALESCE(m.accepted_order,c.created_order) DESC LIMIT 1",
    )
    .bind(principal)
    .bind(tag)
    .fetch_optional(&mut **tx)
    .await?)
}

/// The conversation's ID: its first Session's.
async fn conversation_id_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    tag: &str,
) -> Result<Option<String>> {
    Ok(sqlx::query_scalar(
        "SELECT session_id FROM supertag_v2_conversations WHERE principal=$1 AND tag_id=$2
         ORDER BY created_order LIMIT 1",
    )
    .bind(principal)
    .bind(tag)
    .fetch_optional(&mut **tx)
    .await?)
}

/// A message the Control Plane just accepted.
fn sent(
    task: Task,
    live_input: Option<LiveInput>,
    order: i64,
    sent_at_ms: i64,
) -> ConversationMessage {
    ConversationMessage {
        task: Some(task),
        live_input,
        work_session_report_id: None,
        events: Vec::new(),
        events_truncated: false,
        order: order as u64,
        sent_at_ms,
        completed_at_ms: None,
        schedule_id: None,
        work_session_close_reason: 0,
    }
}

async fn message_in(
    tx: &mut Transaction<'_, Any>,
    entry: HistoryEntry,
) -> Result<ConversationMessage> {
    messages_in(tx, vec![entry])
        .await?
        .pop()
        .ok_or_else(|| StoreError::NotFound("Task was not found".into()))
}

/// The messages of these history entries, in their order. It takes the same few queries however
/// many entries there are.
async fn messages_in(
    tx: &mut Transaction<'_, Any>,
    entries: Vec<HistoryEntry>,
) -> Result<Vec<ConversationMessage>> {
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<&str> = entries.iter().map(|entry| entry.task_id.as_str()).collect();
    let tasks = tasks_in(tx, &ids).await?;
    let followers: Vec<&str> = entries
        .iter()
        .filter(|entry| entry.report_id.is_none())
        .map(|entry| entry.task_id.as_str())
        .collect();
    let mut inputs = if followers.is_empty() {
        Default::default()
    } else {
        inputs_for_followers_in(tx, &followers).await?
    };
    let mut events = message_events_in(tx, &ids).await?;
    let mut fired = crate::schedules::fired_by_in(tx, &ids).await?;
    let reports: Vec<&str> = entries
        .iter()
        .filter_map(|entry| entry.report_id.as_deref())
        .collect();
    let closed = crate::work_sessions::closed_reasons_in(tx, &reports).await?;
    entries
        .into_iter()
        .map(|entry| {
            let schedule_id = fired.remove(&entry.task_id);
            let work_session_close_reason = entry
                .report_id
                .as_ref()
                .and_then(|id| closed.get(id).copied())
                .unwrap_or_default();
            // A report or a Schedule's turn has no operator message.
            let is_report = entry.report_id.is_some() || schedule_id.is_some();
            let (events, events_truncated) = events.remove(&entry.task_id).unwrap_or_default();
            let row = tasks
                .get(&entry.task_id)
                .ok_or_else(|| StoreError::NotFound("Task was not found".into()))?;
            let mut task = row.task.clone();
            if is_report {
                // Report and wake-up input is execution data. The conversation only presents
                // its reply.
                task.prompt.clear();
            }
            Ok(ConversationMessage {
                task: Some(task),
                live_input: if is_report {
                    None
                } else {
                    inputs.remove(&entry.task_id)
                },
                work_session_report_id: entry.report_id,
                events,
                events_truncated,
                order: entry.order as u64,
                sent_at_ms: row.accepted_at_ms.unwrap_or_default(),
                completed_at_ms: row.completed_at_ms,
                work_session_close_reason,
                schedule_id,
            })
        })
        .collect()
}

/// What each Task's turn shows from its events, oldest first: every message the Tag wrote and
/// its latest activity or plan event, keeping the latest within [`MESSAGE_EVENT_BYTES`]. The
/// flag says earlier messages were left out.
async fn message_events_in(
    tx: &mut Transaction<'_, Any>,
    task_ids: &[&str],
) -> Result<std::collections::HashMap<String, (Vec<TaskEvent>, bool)>> {
    let mut read: std::collections::HashMap<String, Vec<TaskEvent>> = Default::default();
    for chunk in task_ids.chunks(ID_BATCH) {
        let sql = format!(
            "SELECT e.task_id,e.sequence,e.text,e.kind FROM supertag_v2_task_events e
             WHERE e.task_id IN ({}) AND (e.kind=$1 OR e.sequence=(
                 SELECT MAX(l.sequence) FROM supertag_v2_task_events l WHERE l.task_id=e.task_id AND l.kind<>$1))
             ORDER BY e.task_id,e.sequence",
            placeholders(2, chunk.len())
        );
        let mut query = sqlx::query(&sql).bind(TaskEventKind::Message as i64);
        for id in chunk {
            query = query.bind(*id);
        }
        for row in query.fetch_all(&mut **tx).await? {
            read.entry(row.try_get("task_id")?)
                .or_default()
                .push(TaskEvent {
                    sequence: row.try_get::<i64, _>("sequence")? as u64,
                    text: row.try_get("text")?,
                    kind: row.try_get::<i64, _>("kind")? as i32,
                });
        }
    }
    Ok(read
        .into_iter()
        .map(|(task_id, mut events)| {
            let mut bytes = 0;
            let kept = events
                .iter()
                .rev()
                .take_while(|event| {
                    bytes += event.encoded_len() + 8;
                    bytes <= MESSAGE_EVENT_BYTES
                })
                .count();
            let truncated = kept < events.len();
            events.drain(..events.len() - kept);
            (task_id, (events, truncated))
        })
        .collect())
}

/// Operators and clients converse; each sees only its own conversations.
fn operator(principal: &str) -> Result<()> {
    crate::store::actor(principal)
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
        let principal = self.actor(&request)?;
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
        let principal = self.actor(&request)?;
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
        let principal = self.actor(&request)?;
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
        let principal = self.actor(&request)?;
        let input = request.into_inner();
        Ok(Response::new(
            self.store
                .get_message(&principal, &input.tag_id, &input.task_id)
                .await?,
        ))
    }

    async fn mark_conversation_read(
        &self,
        request: Request<MarkConversationReadRequest>,
    ) -> std::result::Result<Response<Conversation>, Status> {
        let principal = self.actor(&request)?;
        Ok(Response::new(
            self.store
                .mark_conversation_read(&principal, &request.into_inner())
                .await?,
        ))
    }

    type FollowConversationStream = follow::Updates;

    async fn follow_conversation(
        &self,
        request: Request<FollowConversationRequest>,
    ) -> std::result::Result<Response<Self::FollowConversationStream>, Status> {
        let principal = self.actor(&request)?;
        Ok(Response::new(
            self.store
                .follow_conversation(&principal, request.into_inner())
                .await?,
        ))
    }
}
