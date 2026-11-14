//! Review artifact access is tied to the designated review turn, never a caller's Task ID.
use sqlx::Row;
use supertag_protocol::v2::{GetReviewArtifactRequest, TaskState, WorkspaceDeliveryReference};

use crate::{
    HostAuthority, Store, StoreError,
    store::{Result, invalid, lease_is_live, name, owned, task_row},
};

impl Store {
    pub async fn get_review_artifact(
        &self,
        host: &HostAuthority,
        input: &GetReviewArtifactRequest,
    ) -> Result<WorkspaceDeliveryReference> {
        name("review request ID", &input.review_id)?;
        let attempt = input
            .attempt
            .as_ref()
            .ok_or_else(|| invalid("Attempt identity is required"))?;
        let mut tx = self.pool.begin().await?;
        let row = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        if row.try_get::<i64, _>("state")? != TaskState::Running as i64
            || !lease_is_live(&row, self.execution_now_ms())?
        {
            return Err(StoreError::FailedPrecondition(
                "review artifact access requires a live running Attempt".into(),
            ));
        }
        let delivery =
            crate::commit_reviews::review_delivery_in(&mut tx, &task_row(&row)?, &input.review_id)
                .await?;
        tx.commit().await?;
        Ok(delivery)
    }
}
