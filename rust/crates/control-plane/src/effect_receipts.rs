//! Worker-managed effect receipts for harnesses that perform external writes themselves.
//!
//! TypeScript parity: `ReliableToolInvokerRegistry`, `ToolEffectJournal` and
//! `ToolEffectInDoubtError` in `packages/runtime/sdk/src/index.ts`, tested by
//! `tests/runtime/tool-adapter.test.ts` and `sdks/python/tests/test_tools.py`. A completed receipt
//! replays its result; reusing a key for different arguments fails closed; a receipt that was
//! begun and never settled is in doubt and is never acquired again; a failed provider call may be
//! retried. Deliberate differences: the journal is the Control Plane's database rather than a
//! Worker-local file, so receipts survive host loss and are shared by every Attempt and Task of
//! the Tag; and a later Attempt may settle an in-doubt receipt after reconciling it with the
//! provider, which the TypeScript journal left to each integration. A receipt begun by another
//! Attempt that is still running is in flight rather than in doubt, and only that Attempt may
//! settle it, so a parallel Work Session of the Tag cannot fail it and call the provider again.
use sha2::{Digest, Sha256};
use sqlx::{Row, any::AnyRow};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};

use crate::{
    ControlPlane, HostAuthority, Store, StoreError, approvals,
    store::{Result, invalid, lease_is_live, name, owned, task_row},
};

const STARTED: i64 = 1;
const COMPLETED: i64 = 2;
const FAILED: i64 = 3;
const MAX_RESULT_BYTES: usize = 64 * 1024;
const MAX_ERROR_BYTES: usize = 4 * 1024;

struct Effect<'a> {
    key: &'a str,
    operation: &'a str,
    fingerprint: String,
}

fn effect<'a>(key: &'a str, operation: &'a str, arguments_json: &str) -> Result<Effect<'a>> {
    name("idempotency key", key)?;
    if key.trim() != key {
        return Err(invalid("idempotency key must not start or end with spaces"));
    }
    name("effect operation", operation)?;
    let arguments = if arguments_json.is_empty() {
        "{}".to_owned()
    } else {
        approvals::canonical_arguments(arguments_json).map_err(|_| {
            invalid(
                "effect arguments must be a JSON object of at most 128 KiB without duplicate keys",
            )
        })?
    };
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&("effect-v1", operation, arguments))?)
    );
    Ok(Effect {
        key,
        operation,
        fingerprint,
    })
}

fn receipt(row: &AnyRow, state: EffectReceiptState, replayed: bool) -> Result<EffectReceipt> {
    Ok(EffectReceipt {
        idempotency_key: row.try_get("idempotency_key")?,
        fingerprint: row.try_get("fingerprint")?,
        state: state as i32,
        operation: row.try_get("operation")?,
        result_json: row
            .try_get::<Option<String>, _>("result_json")?
            .unwrap_or_default(),
        error: row
            .try_get::<Option<String>, _>("error")?
            .unwrap_or_default(),
        task_id: row.try_get("task_id")?,
        attempt_id: row.try_get("attempt_id")?,
        started_at_ms: row.try_get("started_at_ms")?,
        settled_at_ms: row.try_get("settled_at_ms")?,
        replayed,
    })
}

fn attempt(value: &Option<InspectAttemptRequest>) -> Result<&InspectAttemptRequest> {
    value
        .as_ref()
        .ok_or_else(|| invalid("Attempt identity is required"))
}

/// Whether an unsettled receipt was begun by another Attempt that is still its Task's running
/// Attempt. A late lease renewal does not end it: only recovery or a finish replaces the Attempt.
async fn in_flight_elsewhere(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    prior: &AnyRow,
    attempt_id: &str,
) -> Result<bool> {
    let began: String = prior.try_get("attempt_id")?;
    if began == attempt_id {
        return Ok(false);
    }
    let running: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM supertag_v2_tasks WHERE task_id=$1 AND attempt_id=$2 AND state=$3",
    )
    .bind(prior.try_get::<String, _>("task_id")?)
    .bind(&began)
    .bind(TaskState::Running as i64)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(running.is_some())
}

const SELECT: &str =
    "SELECT * FROM supertag_v2_effect_receipts WHERE tag_id=$1 AND idempotency_key=$2";

impl Store {
    /// Reserves an effect before its provider call, or returns what an earlier call recorded.
    pub async fn begin_effect(
        &self,
        host: &HostAuthority,
        input: &BeginEffectRequest,
    ) -> Result<EffectReceipt> {
        let attempt = attempt(&input.attempt)?;
        let requested = input
            .effect
            .as_ref()
            .ok_or_else(|| invalid("effect is required"))?;
        let effect = effect(
            &requested.idempotency_key,
            &requested.operation,
            &requested.arguments_json,
        )?;
        let (mut tx, _) = self.write().await?;
        let now = self.execution_now_ms();
        let row = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        let task = task_row(&row)?;
        if task.state() != TaskState::Running || !lease_is_live(&row, now)? {
            return Err(StoreError::FailedPrecondition(
                "an effect requires a live running Attempt".into(),
            ));
        }
        let prior = sqlx::query(SELECT)
            .bind(&task.tag_id)
            .bind(effect.key)
            .fetch_optional(&mut *tx)
            .await?;
        let state = if let Some(prior) = &prior {
            if prior.try_get::<String, _>("fingerprint")? != effect.fingerprint {
                return Err(StoreError::Conflict(
                    "idempotency key was used for a different effect".into(),
                ));
            }
            match prior.try_get::<i64, _>("state")? {
                COMPLETED => {
                    let replay = receipt(prior, EffectReceiptState::Completed, true)?;
                    tx.commit().await?;
                    return Ok(replay);
                }
                STARTED => {
                    // Never acquired again: the provider may already have committed it. While
                    // another running Attempt began it, its call may still be in progress.
                    let state = if in_flight_elsewhere(&mut tx, prior, &attempt.attempt_id).await? {
                        EffectReceiptState::InFlight
                    } else {
                        EffectReceiptState::InDoubt
                    };
                    let doubt = receipt(prior, state, false)?;
                    tx.commit().await?;
                    return Ok(doubt);
                }
                FAILED => {
                    sqlx::query("UPDATE supertag_v2_effect_receipts SET state=$1,result_json=NULL,error=NULL,task_id=$2,attempt_id=$3,started_at_ms=$4,settled_at_ms=NULL WHERE tag_id=$5 AND idempotency_key=$6")
                        .bind(STARTED).bind(&task.task_id).bind(&attempt.attempt_id).bind(now)
                        .bind(&task.tag_id).bind(effect.key).execute(&mut *tx).await?;
                    EffectReceiptState::Acquired
                }
                _ => return Err(invalid("stored effect receipt state is invalid")),
            }
        } else {
            sqlx::query("INSERT INTO supertag_v2_effect_receipts (tag_id,idempotency_key,fingerprint,operation,state,task_id,attempt_id,started_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)")
                .bind(&task.tag_id).bind(effect.key).bind(&effect.fingerprint).bind(effect.operation)
                .bind(STARTED).bind(&task.task_id).bind(&attempt.attempt_id).bind(now)
                .execute(&mut *tx).await?;
            EffectReceiptState::Acquired
        };
        let row = sqlx::query(SELECT)
            .bind(&task.tag_id)
            .bind(effect.key)
            .fetch_one(&mut *tx)
            .await?;
        let acquired = receipt(&row, state, false)?;
        tx.commit().await?;
        Ok(acquired)
    }

    /// Records a provider result. Settling an in-doubt receipt begun by an earlier Attempt is
    /// the integration's reconciliation of it.
    pub async fn complete_effect(
        &self,
        host: &HostAuthority,
        input: &CompleteEffectRequest,
    ) -> Result<EffectReceipt> {
        let requested = input
            .effect
            .as_ref()
            .ok_or_else(|| invalid("effect is required"))?;
        if requested.result_json.len() > MAX_RESULT_BYTES
            || serde_json::from_str::<serde_json::Value>(&requested.result_json).is_err()
        {
            return Err(invalid("effect result must be JSON of at most 64 KiB"));
        }
        let effect = effect(
            &requested.idempotency_key,
            &requested.operation,
            &requested.arguments_json,
        )?;
        self.settle_effect(
            host,
            attempt(&input.attempt)?,
            &effect,
            (COMPLETED, &requested.result_json),
        )
        .await
    }

    /// Records a provider call that failed without effect, so a later Begin may retry it.
    pub async fn fail_effect(
        &self,
        host: &HostAuthority,
        input: &FailEffectRequest,
    ) -> Result<EffectReceipt> {
        let requested = input
            .effect
            .as_ref()
            .ok_or_else(|| invalid("effect is required"))?;
        if requested.error.len() > MAX_ERROR_BYTES {
            return Err(invalid("effect error exceeds 4 KiB"));
        }
        let effect = effect(
            &requested.idempotency_key,
            &requested.operation,
            &requested.arguments_json,
        )?;
        self.settle_effect(
            host,
            attempt(&input.attempt)?,
            &effect,
            (FAILED, &requested.error),
        )
        .await
    }

    async fn settle_effect(
        &self,
        host: &HostAuthority,
        attempt: &InspectAttemptRequest,
        effect: &Effect<'_>,
        (state, value): (i64, &str),
    ) -> Result<EffectReceipt> {
        let (mut tx, _) = self.write().await?;
        let now = self.execution_now_ms();
        // A receipt records what already happened, so an Attempt whose lease lapsed during the
        // provider call may still record it.
        let row = owned(
            &mut tx,
            host,
            &attempt.task_id,
            &attempt.attempt_id,
            &attempt.lease_token,
        )
        .await?;
        let task = task_row(&row)?;
        let prior = sqlx::query(SELECT)
            .bind(&task.tag_id)
            .bind(effect.key)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| StoreError::FailedPrecondition("effect was not begun".into()))?;
        if prior.try_get::<String, _>("fingerprint")? != effect.fingerprint {
            return Err(StoreError::Conflict(
                "idempotency key was used for a different effect".into(),
            ));
        }
        let column = if state == COMPLETED {
            "result_json"
        } else {
            "error"
        };
        let current: i64 = prior.try_get("state")?;
        if current == STARTED && in_flight_elsewhere(&mut tx, &prior, &attempt.attempt_id).await? {
            // Reconciling now could see nothing yet, fail the receipt, and let a second provider
            // call race the first one.
            return Err(StoreError::FailedPrecondition(
                "effect is in flight in another running Attempt".into(),
            ));
        }
        if current == STARTED {
            sqlx::query(&format!("UPDATE supertag_v2_effect_receipts SET state=$1,{column}=$2,settled_at_ms=$3 WHERE tag_id=$4 AND idempotency_key=$5 AND state=$6"))
                .bind(state).bind(value).bind(now).bind(&task.tag_id).bind(effect.key).bind(STARTED)
                .execute(&mut *tx).await?;
        } else if current != state
            || prior.try_get::<Option<String>, _>(column)?.as_deref() != Some(value)
        {
            return Err(StoreError::Conflict(
                "effect was already settled with a different outcome".into(),
            ));
        }
        let row = sqlx::query(SELECT)
            .bind(&task.tag_id)
            .bind(effect.key)
            .fetch_one(&mut *tx)
            .await?;
        let settled = receipt(
            &row,
            if state == COMPLETED {
                EffectReceiptState::Completed
            } else {
                EffectReceiptState::Failed
            },
            false,
        )?;
        tx.commit().await?;
        Ok(settled)
    }
}

impl ControlPlane {
    pub fn attempt_effects_service(&self) -> attempt_effects_server::AttemptEffectsServer<Self> {
        attempt_effects_server::AttemptEffectsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl attempt_effects_server::AttemptEffects for ControlPlane {
    async fn begin(
        &self,
        request: Request<BeginEffectRequest>,
    ) -> std::result::Result<Response<EffectReceipt>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store.begin_effect(&host, request.get_ref()).await?,
        ))
    }

    async fn complete(
        &self,
        request: Request<CompleteEffectRequest>,
    ) -> std::result::Result<Response<EffectReceipt>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store.complete_effect(&host, request.get_ref()).await?,
        ))
    }

    async fn fail(
        &self,
        request: Request<FailEffectRequest>,
    ) -> std::result::Result<Response<EffectReceipt>, Status> {
        let host = self.host_authority(&request)?;
        Ok(Response::new(
            self.store.fail_effect(&host, request.get_ref()).await?,
        ))
    }
}
