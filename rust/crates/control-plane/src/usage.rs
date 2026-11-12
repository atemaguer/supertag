use sqlx::{Row, any::AnyRow};
use supertag_protocol::v2::*;

use crate::{
    Store, StoreError,
    store::{HostAuthority, Result, invalid, lease_is_live, name, owned},
};

impl Store {
    pub(crate) async fn report_native_usage(
        &self,
        host: &HostAuthority,
        attempt: &InspectAttemptRequest,
        sequence: i64,
        usage: &NativeTokenUsage,
    ) -> Result<()> {
        let input_tokens = token_count(usage.input_tokens)?;
        let cached = token_count(usage.cached_input_tokens)?;
        let output_tokens = token_count(usage.output_tokens)?;
        if cached > input_tokens {
            return Err(invalid("cached input tokens exceed input tokens"));
        }
        if let Some(model) = &usage.observed_model {
            name("observed model", model)?;
        }
        let (mut tx, _) = self.write().await?;
        let task = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        let prior = sqlx::query(
            "SELECT * FROM supertag_v2_native_usage WHERE attempt_id=$1 AND sequence=$2",
        )
        .bind(&attempt.attempt_id)
        .bind(sequence)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(prior) = prior {
            if &usage_row(&prior)? != usage {
                return Err(StoreError::Conflict(
                    "native usage sequence already recorded different evidence".into(),
                ));
            }
        } else {
            if task.try_get::<i64, _>("state")? != TaskState::Running as i64
                || !lease_is_live(&task, self.execution_now_ms())?
            {
                return Err(StoreError::FailedPrecondition("Task is not running".into()));
            }
            let previous = sqlx::query("SELECT * FROM supertag_v2_native_usage WHERE attempt_id=$1 ORDER BY sequence DESC LIMIT 1")
                .bind(&attempt.attempt_id).fetch_optional(&mut *tx).await?;
            let mut expected = 1;
            if let Some(previous) = previous {
                expected = previous.try_get::<i64, _>("sequence")? + 1;
                let earlier = usage_row(&previous)?;
                if usage.input_tokens < earlier.input_tokens
                    || usage.cached_input_tokens < earlier.cached_input_tokens
                    || usage.output_tokens < earlier.output_tokens
                {
                    return Err(invalid("native usage counters must be cumulative"));
                }
            }
            if sequence != expected {
                return Err(StoreError::FailedPrecondition(
                    "native usage sequence has a gap".into(),
                ));
            }
            sqlx::query("INSERT INTO supertag_v2_native_usage (attempt_id,task_id,sequence,input_tokens,cached_input_tokens,output_tokens,observed_model) VALUES ($1,$2,$3,$4,$5,$6,$7)")
                .bind(&attempt.attempt_id).bind(&attempt.task_id).bind(sequence)
                .bind(input_tokens).bind(cached).bind(output_tokens).bind(&usage.observed_model)
                .execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn list_native_usage(
        &self,
        request: &ListNativeUsageRequest,
    ) -> Result<ListNativeUsageResponse> {
        name("Task ID", &request.task_id)?;
        name("Attempt ID", &request.attempt_id)?;
        let after = i64::try_from(request.after_sequence)
            .map_err(|_| invalid("usage sequence is too large"))?;
        let limit = if request.limit == 0 {
            100
        } else {
            request.limit.min(1000)
        };
        let rows = sqlx::query("SELECT * FROM supertag_v2_native_usage WHERE task_id=$1 AND attempt_id=$2 AND sequence>$3 ORDER BY sequence LIMIT $4")
            .bind(&request.task_id).bind(&request.attempt_id).bind(after).bind(i64::from(limit))
            .fetch_all(&self.pool).await?;
        let reports = rows
            .iter()
            .map(|row| {
                Ok(HarnessUsageRequest {
                    sequence: row.try_get::<i64, _>("sequence")? as u64,
                    native_usage: Some(usage_row(row)?),
                })
            })
            .collect::<Result<_>>()?;
        Ok(ListNativeUsageResponse { reports })
    }
}

fn token_count(value: u64) -> Result<i64> {
    // JSON clients can represent these counts without losing precision.
    if value > 9_007_199_254_740_991 {
        return Err(invalid("native token count is too large"));
    }
    Ok(value as i64)
}

fn usage_row(row: &AnyRow) -> Result<NativeTokenUsage> {
    Ok(NativeTokenUsage {
        input_tokens: row.try_get::<i64, _>("input_tokens")? as u64,
        cached_input_tokens: row.try_get::<i64, _>("cached_input_tokens")? as u64,
        output_tokens: row.try_get::<i64, _>("output_tokens")? as u64,
        observed_model: row.try_get("observed_model")?,
    })
}
