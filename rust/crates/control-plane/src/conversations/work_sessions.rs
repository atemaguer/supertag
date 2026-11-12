use sqlx::any::AnyRow;

use super::*;

const VIEW: &str = "SELECT ws.*, child.state AS latest_task_state, child.workspace_delivery,
    report.report_task_id, delivered.state AS report_task_state
    FROM supertag_v2_work_sessions ws
    JOIN supertag_v2_tasks child ON child.task_id = ws.latest_task_id
    JOIN supertag_v2_task_audience audience ON audience.task_id = child.task_id
    LEFT JOIN supertag_v2_work_session_reports report ON report.child_task_id = child.task_id
    LEFT JOIN supertag_v2_tasks delivered ON delivered.task_id = report.report_task_id";

fn projection(row: &AnyRow) -> Result<WorkSession> {
    Ok(WorkSession {
        work_session_id: row.try_get("work_session_id")?,
        title: row.try_get("title")?,
        parent_tag_id: row.try_get("parent_tag_id")?,
        parent_session_id: row.try_get("parent_session_id")?,
        starter_task_id: row.try_get("starter_task_id")?,
        tag_id: row.try_get("tag_id")?,
        latest_task_id: row.try_get("latest_task_id")?,
        latest_task_state: row.try_get::<i64, _>("latest_task_state")? as i32,
        report_task_id: row.try_get("report_task_id")?,
        report_task_state: row
            .try_get::<Option<i64>, _>("report_task_state")?
            .unwrap_or(0) as i32,
        objective_id: row.try_get("objective_id")?,
        workspace_delivery: crate::workspaces::delivery_from_row(row)?,
        created_order: row.try_get::<i64, _>("created_order")? as u64,
    })
}

async fn read_in(
    tx: &mut Transaction<'_, Any>,
    id: &str,
    principal: Option<&str>,
) -> Result<WorkSession> {
    let row = sqlx::query(&format!(
        "{VIEW} WHERE ws.work_session_id=$1 AND (CAST($2 AS TEXT) IS NULL OR audience.owner IN ('',$2))"
    ))
    .bind(id)
    .bind(principal)
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
    read_in(tx, work_session_id, None).await
}

impl Store {
    pub async fn get_work_session(&self, principal: &str, id: &str) -> Result<WorkSession> {
        operator(principal)?;
        name("Work Session ID", id)?;
        let mut tx = self.pool.begin().await?;
        let value = read_in(&mut tx, id, Some(principal)).await?;
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
            AND (CAST($3 AS TEXT) IS NULL OR ws.starter_task_id=$3) AND ws.created_order<$4
            AND audience.owner IN ('',$5) ORDER BY ws.created_order DESC LIMIT $6"
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
        Ok(Response::new(
            self.store
                .get_work_session(&principal, &request.into_inner().work_session_id)
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
