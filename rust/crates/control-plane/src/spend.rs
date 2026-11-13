//! Operator spend report. Each claimed Attempt is counted once, with its
//! latest native usage receipt and its cumulative reported or estimated cost,
//! matching the evidence that Objective budget accounting uses.
use std::collections::BTreeMap;

use prost::Message;
use sqlx::Row;
use supertag_protocol::v2::*;
use tonic::{Request, Response, Status};

use crate::{
    ControlPlane, Store,
    store::{Result, invalid},
    usage::{effective_total, usage_row},
};

const DAY_MS: i64 = 86_400_000;

#[derive(Default)]
struct Totals {
    name: String,
    attempts: u64,
    cost: BTreeMap<String, u64>,
    unknown_cost: u64,
    estimated_cost: u64,
    unpriced: BTreeMap<String, u64>,
    unpriced_tokens: u64,
    tokens: Option<u64>,
    unknown_tokens: u64,
    budget: Option<SpendBudget>,
}

impl Store {
    pub async fn spend_report(&self, request: &GetSpendRequest) -> Result<SpendReport> {
        let by = match SpendGrouping::try_from(request.by)
            .map_err(|_| invalid("unknown spend grouping"))?
        {
            SpendGrouping::Unspecified | SpendGrouping::Objective => SpendGrouping::Objective,
            other => other,
        };
        if let Some(since) = request.since_ms
            && since < 0
        {
            return Err(invalid("since must not precede the Unix epoch"));
        }
        // One row per claimed Attempt. The latest native receipt is a single
        // keyed lookup per Attempt through the native usage primary key.
        let rows = sqlx::query(
            "SELECT c.attempt_id, c.claimed_at_ms, c.attempt_execution, t.tag_id, tag.name AS tag_name, \
             ot.objective_id, o.budget_limit_minor, o.budget_currency, \
             u.amount_minor, u.currency, u.estimated, \
             n.input_tokens, n.cached_input_tokens, n.output_tokens, n.observed_model, n.total_tokens \
             FROM supertag_v2_claims c \
             JOIN supertag_v2_tasks t ON t.task_id=c.task_id \
             JOIN supertag_v2_tags tag ON tag.tag_id=t.tag_id \
             LEFT JOIN supertag_v2_objective_tasks ot ON ot.task_id=c.task_id \
             LEFT JOIN supertag_v2_objectives o ON o.objective_id=ot.objective_id \
             LEFT JOIN supertag_v2_attempt_usage u ON u.attempt_id=c.attempt_id \
             LEFT JOIN supertag_v2_native_usage n ON n.attempt_id=c.attempt_id AND n.sequence=\
               (SELECT MAX(latest.sequence) FROM supertag_v2_native_usage latest WHERE latest.attempt_id=c.attempt_id) \
             WHERE c.attempt_id IS NOT NULL AND ($1 < 0 OR (c.claimed_at_ms IS NOT NULL AND c.claimed_at_ms >= $1)) \
             ORDER BY c.attempt_id",
        )
        .bind(request.since_ms.unwrap_or(-1))
        .fetch_all(&self.pool)
        .await?;
        let mut groups = BTreeMap::<String, Totals>::new();
        for row in rows {
            let key = match by {
                SpendGrouping::Tag => row.try_get::<String, _>("tag_id")?,
                SpendGrouping::Day => match row.try_get::<Option<i64>, _>("claimed_at_ms")? {
                    Some(at) => day(at),
                    None => "undated".into(),
                },
                _ => row
                    .try_get::<Option<String>, _>("objective_id")?
                    .unwrap_or_else(|| "unassigned".into()),
            };
            let group = groups.entry(key).or_default();
            if group.attempts == 0 {
                if by == SpendGrouping::Tag {
                    group.name = row
                        .try_get::<Option<String>, _>("tag_name")?
                        .unwrap_or_else(|| row.try_get("tag_id").unwrap_or_default());
                }
                if by == SpendGrouping::Objective
                    && let Some(limit) = row.try_get::<Option<i64>, _>("budget_limit_minor")?
                {
                    group.budget = Some(SpendBudget {
                        limit_minor: limit as u64,
                        currency: row.try_get("budget_currency")?,
                    });
                }
            }
            group.attempts += 1;
            let native = match row.try_get::<Option<i64>, _>("input_tokens")? {
                Some(_) => Some(usage_row(&row)?),
                None => None,
            };
            let cost = row
                .try_get::<Option<i64>, _>("amount_minor")?
                .zip(row.try_get::<Option<String>, _>("currency")?);
            match cost {
                Some((amount, currency)) => {
                    if row.try_get::<Option<i64>, _>("estimated")? == Some(1) {
                        group.estimated_cost += 1;
                    }
                    let total = group.cost.entry(currency).or_default();
                    *total = total.saturating_add(amount as u64);
                }
                None => {
                    group.unknown_cost += 1;
                    if let Some(usage) = &native {
                        let selected = row
                            .try_get::<Option<Vec<u8>>, _>("attempt_execution")?
                            .and_then(|bytes| {
                                AttemptExecutionSelection::decode(bytes.as_slice()).ok()
                            })
                            .and_then(|execution| execution.selection)
                            .and_then(|selection| selection.model);
                        if let Some(model) = usage.observed_model.clone().or(selected) {
                            *group.unpriced.entry(model).or_default() += 1;
                            group.unpriced_tokens = group
                                .unpriced_tokens
                                .saturating_add(effective_total(usage)?);
                        }
                    }
                }
            }
            match &native {
                Some(usage) => {
                    group.tokens = Some(
                        group
                            .tokens
                            .unwrap_or(0)
                            .saturating_add(effective_total(usage)?),
                    );
                }
                None => group.unknown_tokens += 1,
            }
        }
        Ok(SpendReport {
            by: by as i32,
            since_ms: request.since_ms,
            groups: groups
                .into_iter()
                .map(|(key, totals)| SpendGroup {
                    key,
                    name: totals.name,
                    attempts: totals.attempts,
                    reported_cost: totals
                        .cost
                        .into_iter()
                        .map(|(currency, amount_minor)| SpendAmount {
                            currency,
                            amount_minor,
                        })
                        .collect(),
                    unknown_cost_attempts: totals.unknown_cost,
                    estimated_cost_attempts: totals.estimated_cost,
                    unpriced_models: totals
                        .unpriced
                        .into_iter()
                        .map(|(model, attempts)| SpendUnpricedModel { model, attempts })
                        .collect(),
                    unpriced_tokens: totals.unpriced_tokens,
                    reported_tokens: totals.tokens,
                    unknown_token_attempts: totals.unknown_tokens,
                    budget: totals.budget,
                })
                .collect(),
        })
    }
}

/// UTC calendar day without a date library: civil-from-days (Howard Hinnant).
fn day(at_ms: i64) -> String {
    let days = at_ms.div_euclid(DAY_MS);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

impl ControlPlane {
    pub fn spend_service(&self) -> spend_server::SpendServer<Self> {
        spend_server::SpendServer::new(self.clone())
            .max_decoding_message_size(supertag_protocol::MAX_MESSAGE_BYTES)
            .max_encoding_message_size(supertag_protocol::MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl spend_server::Spend for ControlPlane {
    async fn get_spend(
        &self,
        request: Request<GetSpendRequest>,
    ) -> std::result::Result<Response<SpendReport>, Status> {
        self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store.spend_report(request.get_ref()).await?,
        ))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn utc_days() {
        assert_eq!(super::day(0), "1970-01-01");
        assert_eq!(super::day(951_782_400_000), "2000-02-29");
        assert_eq!(super::day(1_794_441_599_999), "2026-11-11");
        assert_eq!(super::day(-1), "1969-12-31");
    }
}
