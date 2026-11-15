//! Immutable per-Task allowances drawn from reported pool spend, without reservations.
use crate::{
    StoreError,
    store::{Result, invalid},
};
use prost::Message;
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::v2::{ExecutionLimits, ReportedCostLimit, Task};

const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct PoolSpend {
    pub(crate) tokens: u64,
    pub(crate) cost_minor: u64,
}

fn floor(limit: u64) -> u64 {
    // Preserve the legacy Number/Math.ceil boundary, including MAX_SAFE_INTEGER.
    ((limit as f64 * 0.05).ceil() as u64).max(1)
}

fn allocate(
    pool: &ExecutionLimits,
    spent: &PoolSpend,
    base: &ExecutionLimits,
    owed: bool,
) -> Option<ExecutionLimits> {
    if !owed
        && (pool
            .max_reported_tokens
            .is_some_and(|limit| limit.saturating_sub(spent.tokens) < floor(limit))
            || pool.max_reported_cost.as_ref().is_some_and(|limit| {
                limit.amount_minor.saturating_sub(spent.cost_minor) < floor(limit.amount_minor)
            }))
    {
        return None;
    }
    let mut value = base.clone();
    if let Some(limit) = pool.max_reported_tokens {
        let remaining = limit.saturating_sub(spent.tokens).max(1);
        value.max_reported_tokens = Some(
            value
                .max_reported_tokens
                .unwrap_or(remaining)
                .min(remaining),
        );
    }
    if let Some(limit) = &pool.max_reported_cost {
        let remaining = limit.amount_minor.saturating_sub(spent.cost_minor);
        let amount_minor = value
            .max_reported_cost
            .as_ref()
            .filter(|own| own.currency == limit.currency)
            .map_or(remaining, |own| own.amount_minor.min(remaining));
        value.max_reported_cost = Some(ReportedCostLimit {
            currency: limit.currency.clone(),
            amount_minor,
        });
    }
    Some(value)
}

pub(crate) fn normalize(value: Option<&ExecutionLimits>) -> Result<Option<ExecutionLimits>> {
    let Some(value) = value else { return Ok(None) };
    if value.max_reported_tokens.is_none()
        && value.max_reported_cost.is_none()
        && value.max_native_agents.is_none()
    {
        return Err(invalid("execution limits must not be empty"));
    }
    if value
        .max_reported_tokens
        .is_some_and(|v| v == 0 || v > MAX_SAFE)
        || value.max_native_agents.is_some_and(|v| v > MAX_SAFE)
    {
        return Err(invalid(
            "execution counts must be safe integers and token limits must be positive",
        ));
    }
    if value.max_reported_cost.as_ref().is_some_and(|v| {
        v.amount_minor > MAX_SAFE
            || v.currency.len() != 3
            || !v.currency.bytes().all(|c| c.is_ascii_uppercase())
    }) {
        return Err(invalid(
            "reported cost limit requires safe minor units and an uppercase three-letter currency",
        ));
    }
    Ok(Some(value.clone()))
}

pub(crate) fn encoded(value: Option<&ExecutionLimits>) -> Vec<u8> {
    value.map(Message::encode_to_vec).unwrap_or_default()
}
pub(crate) fn from_row(row: &AnyRow) -> Result<Option<ExecutionLimits>> {
    let bytes: Vec<u8> = row.try_get("execution_limits")?;
    if bytes.is_empty() {
        return Ok(None);
    }
    let value = ExecutionLimits::decode(bytes.as_slice()).map_err(|_| {
        StoreError::FailedPrecondition("stored execution limits are invalid".into())
    })?;
    normalize(Some(&value))
}
fn optional(value: ExecutionLimits) -> Option<ExecutionLimits> {
    if value.max_reported_tokens.is_none()
        && value.max_reported_cost.is_none()
        && value.max_native_agents.is_none()
    {
        None
    } else {
        Some(value)
    }
}

pub(crate) async fn objective_in(
    tx: &mut Transaction<'_, Any>,
    objective: &str,
    base: Option<&ExecutionLimits>,
    owed: bool,
) -> Result<Option<ExecutionLimits>> {
    let row=sqlx::query("SELECT budget_limit_minor,budget_currency FROM supertag_v2_objectives WHERE objective_id=$1").bind(objective).fetch_one(&mut **tx).await?;
    let amount: Option<i64> = row.try_get("budget_limit_minor")?;
    let currency: Option<String> = row.try_get("budget_currency")?;
    let pool = ExecutionLimits {
        max_reported_cost: amount
            .zip(currency)
            .map(|(amount, currency)| ReportedCostLimit {
                amount_minor: amount as u64,
                currency,
            }),
        ..Default::default()
    };
    if pool.max_reported_cost.is_none() {
        return Ok(base.cloned());
    }
    let ids: Vec<String> =
        sqlx::query_scalar("SELECT task_id FROM supertag_v2_objective_tasks WHERE objective_id=$1")
            .bind(objective)
            .fetch_all(&mut **tx)
            .await?;
    let spent = crate::usage::pool_spend_in(
        tx,
        &ids,
        pool.max_reported_cost.as_ref().map(|v| v.currency.as_str()),
    )
    .await?;
    allocate(&pool, &spent, &base.cloned().unwrap_or_default(), owed)
        .map(optional)
        .ok_or_else(|| {
            StoreError::FailedPrecondition(
                "Objective has too little of its reported budget left for new work".into(),
            )
        })
}

pub(crate) async fn root_in(
    tx: &mut Transaction<'_, Any>,
    tag: &str,
    session: &str,
    base: Option<&ExecutionLimits>,
    owed: bool,
) -> Result<Option<ExecutionLimits>> {
    let objective: Option<String> = sqlx::query_scalar(
        "SELECT objective_id FROM supertag_v2_objective_sessions WHERE tag_id=$1 AND session_id=$2",
    )
    .bind(tag)
    .bind(session)
    .fetch_optional(&mut **tx)
    .await?;
    match objective {
        Some(id) => objective_in(tx, &id, base, owed).await,
        None => Ok(base.cloned()),
    }
}

pub(crate) async fn child_in(
    tx: &mut Transaction<'_, Any>,
    parent: &Task,
    objective: Option<&str>,
    base: Option<&ExecutionLimits>,
) -> Result<Option<ExecutionLimits>> {
    draw_in(tx, parent, objective, base, false).await
}

pub(crate) async fn owed_in(
    tx: &mut Transaction<'_, Any>,
    parent: &Task,
    objective: Option<&str>,
    base: Option<&ExecutionLimits>,
) -> Result<Option<ExecutionLimits>> {
    draw_in(tx, parent, objective, base, true).await
}

async fn draw_in(
    tx: &mut Transaction<'_, Any>,
    parent: &Task,
    objective: Option<&str>,
    base: Option<&ExecutionLimits>,
    owed: bool,
) -> Result<Option<ExecutionLimits>> {
    if let Some(id) = objective {
        return objective_in(tx, id, base, owed).await;
    }
    // Approval-driven root turns remain draws on the same original allowance.
    // A later operator-created parent has no approval ancestor and owns a new pool.
    let anchor:String=sqlx::query_scalar("WITH RECURSIVE lineage(task_id) AS (SELECT CAST($1 AS TEXT) UNION SELECT w.task_id FROM supertag_v2_approval_waits w JOIN lineage l ON l.task_id=w.continuation_task_id) SELECT t.task_id FROM lineage l JOIN supertag_v2_tasks t ON t.task_id=l.task_id WHERE t.tag_id=$2 AND t.session_id=$3 ORDER BY t.accepted_order LIMIT 1")
        .bind(&parent.task_id).bind(&parent.tag_id).bind(&parent.session_id).fetch_one(&mut **tx).await?;
    let anchor = crate::store::task_in(tx, &anchor).await?;
    let Some(pool) = &anchor.execution_limits else {
        return Ok(base.cloned());
    };
    if pool.max_reported_tokens.is_none() && pool.max_reported_cost.is_none() {
        return Ok(base.cloned());
    }
    let ids:Vec<String>=sqlx::query_scalar("WITH RECURSIVE edges(parent_id,child_id) AS (SELECT task_id,continuation_task_id FROM supertag_v2_approval_waits WHERE continuation_task_id IS NOT NULL UNION SELECT starter_task_id,task_id FROM supertag_v2_work_session_tasks WHERE kind=1 AND starter_task_id IS NOT NULL), draws(task_id) AS (SELECT CAST($1 AS TEXT) UNION SELECT e.child_id FROM edges e JOIN draws d ON d.task_id=e.parent_id) SELECT task_id FROM draws")
        .bind(&anchor.task_id).fetch_all(&mut **tx).await?;
    let spent = crate::usage::pool_spend_in(
        tx,
        &ids,
        pool.max_reported_cost.as_ref().map(|v| v.currency.as_str()),
    )
    .await?;
    allocate(pool,&spent,&base.cloned().unwrap_or_default(),owed).map(optional).ok_or_else(||StoreError::FailedPrecondition("this turn and its Work Sessions have too little of their reported limits left for new work".into()))
}

pub(crate) async fn set_in(
    tx: &mut Transaction<'_, Any>,
    task: &mut Task,
    value: Option<ExecutionLimits>,
) -> Result<()> {
    sqlx::query("UPDATE supertag_v2_tasks SET execution_limits=$1 WHERE task_id=$2")
        .bind(encoded(value.as_ref()))
        .bind(&task.task_id)
        .execute(&mut **tx)
        .await?;
    task.execution_limits = value;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn money(amount_minor: u64, currency: &str) -> ReportedCostLimit {
        ReportedCostLimit {
            amount_minor,
            currency: currency.into(),
        }
    }
    fn limited(tokens: Option<u64>, cost: Option<ReportedCostLimit>) -> ExecutionLimits {
        ExecutionLimits {
            max_reported_tokens: tokens,
            max_reported_cost: cost,
            max_native_agents: Some(0),
        }
    }
    #[test]
    fn objective_remainder_floor_currency_and_smaller_own_limits() {
        let pool = limited(None, Some(money(1000, "USD")));
        let base = limited(Some(10_000), None);
        assert_eq!(
            allocate(&pool, &PoolSpend::default(), &base, false).unwrap(),
            limited(Some(10_000), Some(money(1000, "USD")))
        );
        assert_eq!(
            allocate(
                &pool,
                &PoolSpend {
                    cost_minor: 600,
                    ..Default::default()
                },
                &base,
                false
            )
            .unwrap()
            .max_reported_cost,
            Some(money(400, "USD"))
        );
        assert_eq!(
            allocate(
                &pool,
                &PoolSpend {
                    cost_minor: 100,
                    ..Default::default()
                },
                &limited(None, Some(money(250, "USD"))),
                false
            )
            .unwrap()
            .max_reported_cost,
            Some(money(250, "USD"))
        );
        assert_eq!(
            allocate(
                &pool,
                &PoolSpend {
                    cost_minor: 100,
                    ..Default::default()
                },
                &limited(None, Some(money(250, "EUR"))),
                false
            )
            .unwrap()
            .max_reported_cost,
            Some(money(900, "USD"))
        );
        assert!(
            allocate(
                &pool,
                &PoolSpend {
                    cost_minor: 950,
                    ..Default::default()
                },
                &base,
                false
            )
            .is_some()
        );
        assert!(
            allocate(
                &pool,
                &PoolSpend {
                    cost_minor: 951,
                    ..Default::default()
                },
                &base,
                false
            )
            .is_none()
        );
    }
    #[test]
    fn concurrent_draws_reserve_nothing_and_reports_ignore_floor() {
        let pool = limited(Some(10_000), Some(money(500, "USD")));
        let spent = PoolSpend {
            tokens: 2_000,
            cost_minor: 100,
        };
        let first = allocate(&pool, &spent, &pool, false).unwrap();
        assert_eq!(first, limited(Some(8_000), Some(money(400, "USD"))));
        assert_eq!(allocate(&pool, &spent, &pool, false), Some(first));
        assert_eq!(
            allocate(
                &pool,
                &PoolSpend {
                    tokens: 5_000,
                    cost_minor: 250
                },
                &limited(Some(4_000), Some(money(300, "USD"))),
                false
            )
            .unwrap(),
            limited(Some(4_000), Some(money(250, "USD")))
        );
        assert!(
            allocate(
                &pool,
                &PoolSpend {
                    tokens: 9_500,
                    cost_minor: 0
                },
                &pool,
                false
            )
            .is_some()
        );
        assert!(
            allocate(
                &pool,
                &PoolSpend {
                    tokens: 9_501,
                    cost_minor: 0
                },
                &pool,
                false
            )
            .is_none()
        );
        assert!(
            allocate(
                &pool,
                &PoolSpend {
                    tokens: 0,
                    cost_minor: 476
                },
                &pool,
                false
            )
            .is_none()
        );
        assert_eq!(
            allocate(
                &pool,
                &PoolSpend {
                    tokens: 9_900,
                    cost_minor: 400
                },
                &pool,
                true
            )
            .unwrap(),
            limited(Some(100), Some(money(100, "USD")))
        );
        assert_eq!(
            allocate(
                &pool,
                &PoolSpend {
                    tokens: u64::MAX,
                    cost_minor: u64::MAX
                },
                &pool,
                true
            )
            .unwrap(),
            limited(Some(1), Some(money(0, "USD")))
        );
        let empty = limited(None, None);
        assert_eq!(allocate(&empty, &spent, &pool, false), Some(pool));
    }
    #[test]
    fn zero_small_and_safe_integer_limits_preserve_boundaries() {
        for limit in [0, 1, 19, 20, 21, 9_007_199_254_740_991] {
            let pool = limited(None, Some(money(limit, "USD")));
            let minimum = ((limit as f64 * 0.05).ceil() as u64).max(1);
            if limit >= minimum {
                assert!(
                    allocate(
                        &pool,
                        &PoolSpend {
                            cost_minor: limit - minimum,
                            ..Default::default()
                        },
                        &pool,
                        false
                    )
                    .is_some()
                );
                assert!(
                    allocate(
                        &pool,
                        &PoolSpend {
                            cost_minor: limit - minimum + 1,
                            ..Default::default()
                        },
                        &pool,
                        false
                    )
                    .is_none()
                );
            } else {
                assert!(allocate(&pool, &PoolSpend::default(), &pool, false).is_none());
            }
        }
    }
}
