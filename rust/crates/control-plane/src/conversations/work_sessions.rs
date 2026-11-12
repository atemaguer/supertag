use sqlx::any::AnyRow;

use super::*;

const VIEW: &str = "SELECT ws.work_session_id, ws.title, ws.parent_tag_id, ws.parent_session_id,
    ws.tag_id, ws.objective_id, COALESCE(k.starter_task_id, ws.starter_task_id) AS starter_task_id,
    child.task_id AS latest_task_id, child.state AS latest_task_state,
    child.workspace_delivery, child.accepted_order AS created_order,
    report.report_task_id, delivered.state AS report_task_state,
    q.attempt_id AS question_attempt_id, q.text AS question_text,
    q.asked_at_ms, q.published_at_ms, q.answer_task_id
    FROM supertag_v2_work_sessions ws
    JOIN supertag_v2_work_session_tasks k ON k.work_session_id=ws.work_session_id AND k.kind=1
    JOIN supertag_v2_tasks child ON child.task_id=k.task_id
    JOIN supertag_v2_task_audience audience ON audience.task_id=child.task_id
    LEFT JOIN supertag_v2_work_session_reports report ON report.child_task_id=child.task_id
    LEFT JOIN supertag_v2_tasks delivered ON delivered.task_id=report.report_task_id
    LEFT JOIN supertag_v2_work_session_questions q ON q.attempt_id=child.attempt_id
        AND q.task_id=child.task_id AND q.published_at_ms IS NOT NULL";

fn projection(row: &AnyRow) -> Result<WorkSession> {
    let work_session_id: String = row.try_get("work_session_id")?;
    let latest_task_id: String = row.try_get("latest_task_id")?;
    let question = match row.try_get::<Option<String>, _>("question_attempt_id")? {
        Some(attempt_id) => Some(WorkSessionQuestion {
            work_session_id: work_session_id.clone(),
            task_id: latest_task_id.clone(),
            attempt_id,
            text: row.try_get("question_text")?,
            asked_at_ms: row.try_get("asked_at_ms")?,
            published_at_ms: row.try_get("published_at_ms")?,
            answer_task_id: row.try_get("answer_task_id")?,
        }),
        None => None,
    };
    Ok(WorkSession {
        work_session_id,
        title: row.try_get("title")?,
        parent_tag_id: row.try_get("parent_tag_id")?,
        parent_session_id: row.try_get("parent_session_id")?,
        starter_task_id: row.try_get("starter_task_id")?,
        tag_id: row.try_get("tag_id")?,
        latest_task_id,
        latest_task_state: row.try_get::<i64, _>("latest_task_state")? as i32,
        report_task_id: row.try_get("report_task_id")?,
        report_task_state: row
            .try_get::<Option<i64>, _>("report_task_state")?
            .unwrap_or(0) as i32,
        objective_id: row.try_get("objective_id")?,
        workspace_delivery: crate::workspaces::delivery_from_row(row)?,
        created_order: row.try_get::<i64, _>("created_order")? as u64,
        question,
    })
}

async fn read_in(
    tx: &mut Transaction<'_, Any>,
    id: &str,
    principal: Option<&str>,
    report_id: Option<&str>,
) -> Result<WorkSession> {
    let row = sqlx::query(&format!(
        "{VIEW} WHERE ws.work_session_id=$1
         AND (CAST($2 AS TEXT) IS NULL OR audience.owner IN ('',$2))
         AND ((CAST($3 AS TEXT) IS NULL AND child.task_id=ws.latest_task_id) OR report.report_task_id=$3)"
    ))
    .bind(id)
    .bind(principal)
    .bind(report_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| StoreError::NotFound("Work Session was not found".into()))?;
    projection(&row)
}

/// Internal projection used after the child Task and its Work Session relation
/// are both written in the same transaction.
pub(crate) async fn work_session_in(
    tx: &mut Transaction<'_, Any>,
    work_session_id: &str,
) -> Result<WorkSession> {
    read_in(tx, work_session_id, None, None).await
}

pub(crate) async fn work_session_child_in(
    tx: &mut Transaction<'_, Any>,
    child_id: &str,
) -> Result<WorkSession> {
    let row = sqlx::query(&format!("{VIEW} WHERE child.task_id=$1"))
        .bind(child_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| StoreError::NotFound("Work Session child was not found".into()))?;
    projection(&row)
}

impl Store {
    pub async fn get_work_session(&self, principal: &str, id: &str) -> Result<WorkSession> {
        self.get_work_session_report(principal, id, None).await
    }

    pub async fn get_work_session_report(
        &self,
        principal: &str,
        id: &str,
        report_id: Option<&str>,
    ) -> Result<WorkSession> {
        operator(principal)?;
        name("Work Session ID", id)?;
        if let Some(report_id) = report_id {
            name("report Task ID", report_id)?;
        }
        let mut tx = self.pool.begin().await?;
        let value = read_in(&mut tx, id, Some(principal), report_id).await?;
        tx.commit().await?;
        Ok(value)
    }

    pub async fn list_work_sessions(
        &self,
        principal: &str,
        input: &ListWorkSessionsRequest,
    ) -> Result<ListWorkSessionsResponse> {
        operator(principal)?;
        name("parent Tag ID", &input.parent_tag_id)?;
        name("parent Session ID", &input.parent_session_id)?;
        if let Some(id) = &input.starter_task_id {
            name("starter Task ID", id)?;
        }
        let limit = page_size(input.limit);
        let cursor = order_cursor(&input.cursor)?;
        let rows = sqlx::query(&format!(
            "{VIEW} WHERE ws.parent_tag_id=$1 AND ws.parent_session_id=$2
            AND ((CAST($3 AS TEXT) IS NULL AND child.task_id=ws.latest_task_id)
                OR COALESCE(k.starter_task_id, ws.starter_task_id)=$3)
            AND child.accepted_order<$4 AND audience.owner IN ('',$5)
            ORDER BY child.accepted_order DESC LIMIT $6"
        ))
        .bind(&input.parent_tag_id)
        .bind(&input.parent_session_id)
        .bind(input.starter_task_id.as_deref())
        .bind(cursor)
        .bind(principal)
        .bind(limit + 1)
        .fetch_all(&self.pool)
        .await?;
        let mut page = Page::new(limit);
        for row in rows {
            let work = projection(&row)?;
            let cursor = work.created_order.to_string();
            if !page.push(work, cursor)? {
                break;
            }
        }
        let (work_sessions, next_cursor) = page.finish();
        Ok(ListWorkSessionsResponse {
            work_sessions,
            next_cursor,
        })
    }
}

impl ControlPlane {
    pub fn work_sessions_service(&self) -> work_sessions_server::WorkSessionsServer<Self> {
        work_sessions_server::WorkSessionsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl work_sessions_server::WorkSessions for ControlPlane {
    async fn get(
        &self,
        request: Request<GetWorkSessionRequest>,
    ) -> std::result::Result<Response<WorkSession>, Status> {
        let principal = self.principal(&request, "operator:")?;
        let input = request.into_inner();
        Ok(Response::new(
            self.store
                .get_work_session_report(
                    &principal,
                    &input.work_session_id,
                    input.report_task_id.as_deref(),
                )
                .await?,
        ))
    }

    async fn list(
        &self,
        request: Request<ListWorkSessionsRequest>,
    ) -> std::result::Result<Response<ListWorkSessionsResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_work_sessions(&principal, &request.into_inner())
                .await?,
        ))
    }
}
