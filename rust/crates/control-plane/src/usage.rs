//! Cumulative per-Attempt evidence. Native and cost-only sequences are independent;
//! combined native/cost observations commit atomically and never erase known spend.
use std::collections::BTreeSet;

use prost::Message;
use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::v2::*;

use crate::{
    Store, StoreError,
    store::{HostAuthority, Result, invalid, lease_is_live, name, owned},
};

impl Store {
    pub async fn report_attempt_usage(
        &self,
        host: &HostAuthority,
        input: &ReportAttemptUsageRequest,
    ) -> Result<()> {
        let attempt = input
            .attempt
            .as_ref()
            .ok_or_else(|| invalid("Attempt identity is required"))?;
        let sequence =
            i64::try_from(input.sequence).map_err(|_| invalid("usage sequence is too large"))?;
        if sequence < 1 {
            return Err(invalid("usage sequence starts at one"));
        }
        validate_cost(input)?;
        if let Some(usage) = &input.native_usage {
            validate_native(usage)?;
        }
        let (mut tx, _) = self.write().await?;
        let now_ms = self.execution_now_ms();
        let task = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        // Exact retries remain valid after settlement, but never after owner generation changes.
        let fingerprint = cost_digest(input);
        if let Some(usage) = &input.native_usage {
            let prior = sqlx::query(
                "SELECT * FROM supertag_v2_native_usage WHERE attempt_id=$1 AND sequence=$2",
            )
            .bind(&attempt.attempt_id)
            .bind(sequence)
            .fetch_optional(&mut *tx)
            .await?;
            if let Some(prior) = prior {
                let expected = HarnessUsageRequest {
                    sequence: input.sequence,
                    native_usage: Some(usage.clone()),
                    amount_minor: input.amount_minor,
                    currency: input.currency.clone(),
                    estimated: input.estimated,
                };
                if receipt_row(&prior)? != expected {
                    return Err(StoreError::Conflict(
                        "native usage sequence already recorded different evidence".into(),
                    ));
                }
                tx.commit().await?;
                return Ok(());
            }
        } else {
            let prior: Option<String> = sqlx::query_scalar("SELECT request_digest FROM supertag_v2_attempt_usage_events WHERE attempt_id=$1 AND sequence=$2")
                .bind(&attempt.attempt_id).bind(sequence).fetch_optional(&mut *tx).await?;
            if let Some(prior) = prior {
                if prior != fingerprint {
                    return Err(StoreError::Conflict(
                        "usage sequence was used with different evidence".into(),
                    ));
                }
                tx.commit().await?;
                return Ok(());
            }
        }
        if task.try_get::<i64, _>("state")? != TaskState::Running as i64
            || !lease_is_live(&task, now_ms)?
        {
            return Err(StoreError::FailedPrecondition("Task is not running".into()));
        }
        sqlx::query("INSERT INTO supertag_v2_attempt_usage (attempt_id,task_id) VALUES ($1,$2) ON CONFLICT(attempt_id) DO NOTHING")
            .bind(&attempt.attempt_id).bind(&attempt.task_id).execute(&mut *tx).await?;
        let head = sqlx::query("SELECT * FROM supertag_v2_attempt_usage WHERE attempt_id=$1")
            .bind(&attempt.attempt_id)
            .fetch_one(&mut *tx)
            .await?;
        if let Some(amount) = input.amount_minor {
            if head.try_get::<Option<i64>, _>("amount_minor")?.is_some()
                && input.currency != head.try_get::<Option<String>, _>("currency")?
            {
                return Err(invalid("Attempt cost currency cannot change"));
            }
            if let Some(measured) = head.try_get::<Option<i64>, _>("measured_amount_minor")?
                && amount < measured as u64
            {
                return Err(invalid(
                    "reported cost cannot decrease below measured cumulative spend",
                ));
            }
        }
        if let Some(usage) = &input.native_usage {
            let previous = sqlx::query("SELECT * FROM supertag_v2_native_usage WHERE attempt_id=$1 ORDER BY sequence DESC LIMIT 1")
                .bind(&attempt.attempt_id).fetch_optional(&mut *tx).await?;
            let mut expected = 1;
            if let Some(previous) = previous {
                expected = previous
                    .try_get::<i64, _>("sequence")?
                    .checked_add(1)
                    .ok_or_else(|| invalid("usage sequence exhausted"))?;
                let earlier = usage_row(&previous)?;
                if usage.input_tokens < earlier.input_tokens
                    || usage.cached_input_tokens < earlier.cached_input_tokens
                    || usage.output_tokens < earlier.output_tokens
                    || effective_total(usage)? < effective_total(&earlier)?
                {
                    return Err(invalid("native usage counters must be cumulative"));
                }
            }
            if sequence != expected {
                return Err(StoreError::FailedPrecondition(
                    "native usage sequence has a gap".into(),
                ));
            }
            sqlx::query("INSERT INTO supertag_v2_native_usage (attempt_id,task_id,sequence,input_tokens,cached_input_tokens,output_tokens,observed_model,total_tokens,amount_minor,currency,estimated) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)")
                .bind(&attempt.attempt_id).bind(&attempt.task_id).bind(sequence)
                .bind(usage.input_tokens as i64).bind(usage.cached_input_tokens as i64).bind(usage.output_tokens as i64).bind(&usage.observed_model)
                .bind(usage.total_tokens.map(|v| v as i64)).bind(input.amount_minor.map(|v| v as i64)).bind(&input.currency).bind(i64::from(input.estimated))
                .execute(&mut *tx).await?;
        } else {
            let expected = head
                .try_get::<i64, _>("sequence")?
                .checked_add(1)
                .ok_or_else(|| invalid("usage sequence exhausted"))?;
            if sequence != expected {
                return Err(StoreError::FailedPrecondition(
                    "usage sequence has a gap".into(),
                ));
            }
            sqlx::query("UPDATE supertag_v2_attempt_usage SET sequence=$1 WHERE attempt_id=$2")
                .bind(sequence)
                .bind(&attempt.attempt_id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("INSERT INTO supertag_v2_attempt_usage_events (attempt_id,sequence,request_digest,amount_minor,currency,estimated) VALUES ($1,$2,$3,$4,$5,$6)")
                .bind(&attempt.attempt_id).bind(sequence).bind(fingerprint).bind(input.amount_minor.map(|v| v as i64)).bind(&input.currency).bind(i64::from(input.estimated)).execute(&mut *tx).await?;
        }
        if let Some(amount) = input.amount_minor {
            sqlx::query("UPDATE supertag_v2_attempt_usage SET amount_minor=$1,currency=$2,estimated=$3 WHERE attempt_id=$4")
                .bind(amount as i64).bind(&input.currency).bind(i64::from(input.estimated)).bind(&attempt.attempt_id).execute(&mut *tx).await?;
            if !input.estimated {
                sqlx::query("UPDATE supertag_v2_attempt_usage SET measured_amount_minor=$1 WHERE attempt_id=$2")
                    .bind(amount as i64).bind(&attempt.attempt_id).execute(&mut *tx).await?;
            }
        }
        let objective_id: Option<String> = sqlx::query_scalar(
            "SELECT objective_id FROM supertag_v2_objective_tasks WHERE task_id=$1",
        )
        .bind(&attempt.task_id)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(id) = objective_id {
            Box::pin(crate::objectives::reconcile_in(&mut tx, &id, now_ms)).await?;
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
            .bind(&request.task_id).bind(&request.attempt_id).bind(after).bind(i64::from(limit)).fetch_all(&self.pool).await?;
        Ok(ListNativeUsageResponse {
            reports: rows.iter().map(receipt_row).collect::<Result<_>>()?,
        })
    }
}

/// Pool arithmetic uses recorded token counts and reported or estimated cost,
/// once per Attempt, without treating unknown evidence as an observed zero or
/// converting currencies. Saturation must
/// exceed every accepted budget rather than wrap around and create new capacity.
pub(crate) async fn pool_spend_in(
    tx: &mut Transaction<'_, Any>,
    task_ids: &[String],
    currency: Option<&str>,
) -> Result<crate::budget_pool::PoolSpend> {
    let unique = task_ids
        .iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let mut spent = crate::budget_pool::PoolSpend::default();
    for chunk in unique.chunks(256) {
        // Any's QueryBuilder emits '?' placeholders, which PostgreSQL does not
        // accept. Numbered bind markers work with both supported backends.
        let markers = (1..=chunk.len())
            .map(|n| format!("${n}"))
            .collect::<Vec<_>>()
            .join(",");
        let native_sql = format!(
            "SELECT n.* FROM supertag_v2_native_usage n WHERE n.task_id IN ({markers}) AND NOT EXISTS (SELECT 1 FROM supertag_v2_native_usage newer WHERE newer.attempt_id=n.attempt_id AND newer.sequence>n.sequence)"
        );
        let mut native = sqlx::query(&native_sql);
        for id in chunk {
            native = native.bind(*id);
        }
        for row in native.fetch_all(&mut **tx).await? {
            spent.tokens = spent
                .tokens
                .saturating_add(effective_total(&usage_row(&row)?)?);
        }
        if let Some(unit) = currency {
            let cost_sql = format!(
                "SELECT amount_minor FROM supertag_v2_attempt_usage WHERE task_id IN ({markers}) AND currency=${}",
                chunk.len() + 1
            );
            let mut cost = sqlx::query_scalar::<Any, Option<i64>>(&cost_sql);
            for id in chunk {
                cost = cost.bind(*id);
            }
            for amount in cost
                .bind(unit)
                .fetch_all(&mut **tx)
                .await?
                .into_iter()
                .flatten()
            {
                spent.cost_minor = spent.cost_minor.saturating_add(amount as u64);
            }
        }
    }
    Ok(spent)
}
fn safe_count(value: u64) -> Result<()> {
    if value > 9_007_199_254_740_991 {
        return Err(invalid("usage count must be a nonnegative safe integer"));
    }
    Ok(())
}
fn validate_native(usage: &NativeTokenUsage) -> Result<()> {
    safe_count(usage.input_tokens)?;
    safe_count(usage.cached_input_tokens)?;
    safe_count(usage.output_tokens)?;
    if usage.cached_input_tokens > usage.input_tokens {
        return Err(invalid("cached input tokens exceed input tokens"));
    }
    if let Some(model) = &usage.observed_model {
        name("observed model", model)?;
    }
    let component_total = usage
        .input_tokens
        .checked_add(usage.output_tokens)
        .ok_or_else(|| invalid("native token total overflowed"))?;
    if usage
        .total_tokens
        .is_some_and(|total| total < component_total)
    {
        return Err(invalid(
            "native total tokens cannot be below input plus output",
        ));
    }
    safe_count(effective_total(usage)?)
}
pub(crate) fn effective_total(usage: &NativeTokenUsage) -> Result<u64> {
    usage.total_tokens.map(Ok).unwrap_or_else(|| {
        usage
            .input_tokens
            .checked_add(usage.output_tokens)
            .ok_or_else(|| invalid("native token total overflowed"))
    })
}
fn validate_cost(input: &ReportAttemptUsageRequest) -> Result<()> {
    if input.amount_minor.is_some() != input.currency.is_some() {
        return Err(invalid("reported cost requires both amount and currency"));
    }
    if let Some(amount) = input.amount_minor {
        safe_count(amount)?;
    }
    if let Some(unit) = &input.currency
        && (unit.len() != 3 || !unit.bytes().all(|b| b.is_ascii_uppercase()))
    {
        return Err(invalid(
            "currency must contain three uppercase ASCII letters",
        ));
    }
    if input.estimated && input.amount_minor.is_none() {
        return Err(invalid("an estimated cost requires an amount"));
    }
    Ok(())
}
fn cost_digest(input: &ReportAttemptUsageRequest) -> String {
    // Preserve existing Objective cost-only receipt fingerprints.
    let mut hash = Sha256::new();
    hash.update("usage");
    hash.update([0]);
    hash.update(input.encode_to_vec());
    format!("{:x}", hash.finalize())
}
fn receipt_row(row: &AnyRow) -> Result<HarnessUsageRequest> {
    Ok(HarnessUsageRequest {
        sequence: row.try_get::<i64, _>("sequence")? as u64,
        native_usage: Some(usage_row(row)?),
        amount_minor: row
            .try_get::<Option<i64>, _>("amount_minor")?
            .map(|v| v as u64),
        currency: row.try_get("currency")?,
        estimated: row.try_get::<i64, _>("estimated")? == 1,
    })
}
pub(crate) fn usage_row(row: &AnyRow) -> Result<NativeTokenUsage> {
    Ok(NativeTokenUsage {
        input_tokens: row.try_get::<i64, _>("input_tokens")? as u64,
        cached_input_tokens: row.try_get::<i64, _>("cached_input_tokens")? as u64,
        output_tokens: row.try_get::<i64, _>("output_tokens")? as u64,
        observed_model: row.try_get("observed_model")?,
        total_tokens: row
            .try_get::<Option<i64>, _>("total_tokens")?
            .map(|v| v as u64),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pool_counts_latest_observation_once_per_attempt_and_preserves_currency() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("pool.db").display()
        ))
        .await
        .unwrap();
        store.put_tag("pool", "Measure", vec![]).await.unwrap();
        let mut tasks = vec![];
        for id in ["one", "two"] {
            let task = store
                .submit_task(
                    "operator:test",
                    &SubmitTaskRequest {
                        tag_id: "pool".into(),
                        session_id: id.into(),
                        operation_id: id.into(),
                        prompt: "Measure".into(),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
            tasks.push(task.task_id);
        }
        let (mut tx, _) = store.write().await.unwrap();
        for (attempt, task, seq, input, cached, output, total) in [
            ("a", &tasks[0], 1i64, 10i64, 2i64, 3i64, Some(20i64)),
            ("a", &tasks[0], 2, 20, 4, 5, Some(30)),
            ("b", &tasks[0], 1, 7, 2, 4, None),
            ("c", &tasks[1], 1, 5, 0, 5, None),
        ] {
            sqlx::query("INSERT INTO supertag_v2_native_usage (attempt_id,task_id,sequence,input_tokens,cached_input_tokens,output_tokens,total_tokens) VALUES ($1,$2,$3,$4,$5,$6,$7)")
                .bind(attempt).bind(task).bind(seq).bind(input).bind(cached).bind(output).bind(total).execute(&mut *tx).await.unwrap();
        }
        for (attempt, task, amount, unit) in [
            ("a", &tasks[0], Some(15i64), Some("USD")),
            ("b", &tasks[0], Some(7), Some("EUR")),
            ("c", &tasks[1], None, None),
        ] {
            sqlx::query("INSERT INTO supertag_v2_attempt_usage (attempt_id,task_id,amount_minor,currency) VALUES ($1,$2,$3,$4)")
                .bind(attempt).bind(task).bind(amount).bind(unit).execute(&mut *tx).await.unwrap();
        }
        tasks.push(tasks[0].clone());
        assert_eq!(
            pool_spend_in(&mut tx, &tasks, Some("USD")).await.unwrap(),
            crate::budget_pool::PoolSpend {
                tokens: 51,
                cost_minor: 15
            }
        );
        assert_eq!(
            pool_spend_in(&mut tx, &tasks, Some("EUR")).await.unwrap(),
            crate::budget_pool::PoolSpend {
                tokens: 51,
                cost_minor: 7
            }
        );
        assert_eq!(
            pool_spend_in(&mut tx, &tasks, None).await.unwrap(),
            crate::budget_pool::PoolSpend {
                tokens: 51,
                cost_minor: 0
            }
        );
        assert_eq!(
            pool_spend_in(&mut tx, &[], Some("USD")).await.unwrap(),
            crate::budget_pool::PoolSpend::default()
        );
    }
    #[tokio::test]
    async fn objective_sum_overflow_does_not_reject_new_usage_or_restore_budget() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("overflow.db").display()
        ))
        .await
        .unwrap();
        store.put_tag("overflow", "Measure", vec![]).await.unwrap();
        store
            .seed_host("overflow", &Sha256::digest(b"synthetic overflow host"))
            .await
            .unwrap();
        let registered = store.register_host("overflow", "one").await.unwrap();
        let host = HostAuthority::new("host:overflow", registered.generation).unwrap();
        let objective = store
            .create_objective(
                "operator:test",
                &CreateObjectiveRequest {
                    objective_id: "overflow".into(),
                    operation_id: "create-overflow".into(),
                    owner_tag_id: "overflow".into(),
                    outcome: "Keep cumulative accounting safe".into(),
                    ongoing: true,
                    budget_limit_minor: Some(9_007_199_254_740_991),
                    budget_currency: Some("USD".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let assigned = store
            .claim_task(&host, "overflow-claim")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(assigned.task.unwrap().task_id, objective.starting_task_id);
        let attempt = InspectAttemptRequest {
            task_id: objective.starting_task_id,
            attempt_id: assigned.attempt_id,
            lease_token: assigned.lease_token,
        };
        store
            .start_task(
                &host,
                &StartTaskRequest {
                    task_id: attempt.task_id.clone(),
                    attempt_id: attempt.attempt_id.clone(),
                    lease_token: attempt.lease_token.clone(),
                },
            )
            .await
            .unwrap();
        let (mut tx, _) = store.write().await.unwrap();
        // 2,049 individually valid receipts are enough to exceed u64 in total.
        for n in 0..2049 {
            sqlx::query("INSERT INTO supertag_v2_attempt_usage (attempt_id,task_id,amount_minor,currency,measured_amount_minor) VALUES ($1,$2,$3,'USD',$3)")
                .bind(format!("historical-{n}")).bind(&attempt.task_id).bind(9_007_199_254_740_991i64).execute(&mut *tx).await.unwrap();
        }
        assert_eq!(
            pool_spend_in(&mut tx, std::slice::from_ref(&attempt.task_id), Some("USD"))
                .await
                .unwrap()
                .cost_minor,
            u64::MAX
        );
        tx.commit().await.unwrap();
        store
            .report_attempt_usage(
                &host,
                &ReportAttemptUsageRequest {
                    attempt: Some(attempt),
                    sequence: 1,
                    amount_minor: Some(1),
                    currency: Some("USD".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(
            store
                .get_objective("operator:local", "overflow")
                .await
                .unwrap()
                .reported_spend_minor,
            Some(u64::MAX)
        );
    }
}
