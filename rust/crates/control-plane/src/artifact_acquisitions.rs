//! Attempt-bound immutable path selections and confirmed input provenance.
use crate::{
    HostAuthority, Store, StoreError,
    policy::decode,
    store::{Result, invalid, name, owned, task_row},
};
use prost::Message;
use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use std::collections::{BTreeMap, BTreeSet};
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    artifacts::{MAX_ARTIFACT_FILES, validate_artifact_path},
    v2::*,
};
use tokio_stream::StreamExt;

fn attempt(input: Option<&InspectAttemptRequest>) -> Result<&InspectAttemptRequest> {
    input.ok_or_else(|| invalid("Attempt identity is required"))
}
async fn owner_in(
    tx: &mut Transaction<'_, Any>,
    host: &HostAuthority,
    input: &InspectAttemptRequest,
) -> Result<AnyRow> {
    owned(
        tx,
        host,
        &input.task_id,
        &input.attempt_id,
        &input.lease_token,
    )
    .await
}
fn receipt(row: &AnyRow) -> Result<ArtifactAcquisition> {
    decode(&row.try_get::<Vec<u8>, _>("payload")?)
}
fn missing() -> StoreError {
    StoreError::NotFound("artifact was not found".into())
}
pub(crate) async fn visible_in(
    tx: &mut Transaction<'_, Any>,
    consumer: &str,
    id: &str,
) -> Result<CapturedArtifact> {
    if let Some(capture) =
        crate::artifact_publications::accepted_capture_in(tx, consumer, id).await?
    {
        return Ok(capture);
    }
    let row=sqlx::query("SELECT c.payload FROM supertag_v2_artifact_captures c JOIN supertag_v2_task_audience source ON source.task_id=c.task_id JOIN supertag_v2_task_audience current ON current.task_id=$1 WHERE c.artifact_id=$2 AND c.committed_order IS NOT NULL AND (source.owner='' OR source.owner=current.owner) AND ((source.tag_id=current.tag_id AND source.session_id=current.session_id) OR (current.objective_id<>'' AND source.objective_id=current.objective_id))")
        .bind(consumer).bind(id).fetch_optional(&mut **tx).await?.ok_or_else(missing)?;
    decode(&row.try_get::<Vec<u8>, _>("payload")?)
}
async fn filtered_in(
    tx: &mut Transaction<'_, Any>,
    consumer: &str,
    mut artifact: CapturedArtifact,
) -> Result<CapturedArtifact> {
    let mut inputs = Vec::new();
    for input in artifact.inputs {
        match visible_in(tx, consumer, &input.artifact_id).await {
            Ok(_) => inputs.push(input),
            Err(StoreError::NotFound(_)) => {}
            Err(error) => return Err(error),
        }
    }
    artifact.inputs = inputs;
    Ok(artifact)
}
pub(crate) async fn operator_lineage_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    artifact: &mut CapturedArtifact,
) -> Result<()> {
    let mut visible = Vec::new();
    for input in std::mem::take(&mut artifact.inputs) {
        let source:Option<String>=sqlx::query_scalar("SELECT task_id FROM supertag_v2_artifact_captures WHERE artifact_id=$1 AND committed_order IS NOT NULL").bind(&input.artifact_id).fetch_optional(&mut **tx).await?;
        if let Some(source) = source
            && crate::conversations::task_access_in(tx, principal, &source).await?
        {
            visible.push(input)
        }
    }
    artifact.inputs = visible;
    Ok(())
}
/// Only inputs confirmed supplied to this Attempt enter a new capture. This is
/// not a claim that the model read or used each file.
pub(crate) async fn lineage_in(
    tx: &mut Transaction<'_, Any>,
    attempt: &str,
) -> Result<Vec<ArtifactSelection>> {
    let mut rows=sqlx::query("SELECT payload FROM supertag_v2_artifact_acquisitions WHERE attempt_id=$1 AND state=$2 ORDER BY created_order")
        .bind(attempt).bind(ArtifactAcquisitionState::Delivered as i64).fetch(&mut **tx);
    let mut inputs: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    while let Some(row) = rows.next().await {
        let acquisition = receipt(&row?)?;
        let paths = inputs.entry(acquisition.artifact_id).or_default();
        paths.extend(acquisition.files.into_iter().map(|file| file.path));
        if inputs.len() > 100 || inputs.values().map(BTreeSet::len).sum::<usize>() > 1000 {
            return Err(invalid(
                "artifact inputs exceed 100 artifacts or 1000 selected paths",
            ));
        }
    }
    Ok(inputs
        .into_iter()
        .map(|(artifact_id, paths)| ArtifactSelection {
            artifact_id,
            paths: paths.into_iter().collect(),
        })
        .collect())
}
impl Store {
    pub async fn inspect_attempt_artifact(
        &self,
        host: &HostAuthority,
        input: &InspectAttemptArtifactRequest,
    ) -> Result<CapturedArtifact> {
        let identity = attempt(input.attempt.as_ref())?;
        let mut tx = self.pool.begin().await?;
        let row = owner_in(&mut tx, host, identity).await?;
        crate::artifact_captures::running(&row, self.execution_now_ms())?;
        let artifact = visible_in(&mut tx, &identity.task_id, &input.artifact_id).await?;
        filtered_in(&mut tx, &identity.task_id, artifact).await
    }
    pub async fn find_attempt_artifacts(
        &self,
        host: &HostAuthority,
        input: &FindAttemptArtifactsRequest,
    ) -> Result<ListCapturedArtifactsResponse> {
        let identity = attempt(input.attempt.as_ref())?;
        let mut tx = self.pool.begin().await?;
        let row = owner_in(&mut tx, host, identity).await?;
        crate::artifact_captures::running(&row, self.execution_now_ms())?;
        if input.query.len() > 1000 || input.kind.len() > 64 {
            return Err(invalid("artifact discovery filter is too long"));
        }
        let limit = match input.limit {
            0 => 30,
            1..=50 => input.limit,
            _ => return Err(invalid("artifact discovery limit must be at most 50")),
        } as usize;
        let mut before =
            i64::try_from(input.before_order).map_err(|_| invalid("invalid artifact cursor"))?;
        let query = input.query.to_lowercase();
        let mut artifacts = Vec::new();
        let mut scanned = 0;
        let mut bytes = 0;
        loop {
            let rows=sqlx::query("SELECT c.payload,c.committed_order FROM supertag_v2_artifact_captures c JOIN supertag_v2_task_audience source ON source.task_id=c.task_id JOIN supertag_v2_task_audience current ON current.task_id=$1 WHERE c.committed_order IS NOT NULL AND ($2=0 OR c.committed_order<$2) AND ($3='' OR c.task_id=$3) AND (source.owner='' OR source.owner=current.owner) AND ((source.tag_id=current.tag_id AND source.session_id=current.session_id) OR (current.objective_id<>'' AND source.objective_id=current.objective_id)) ORDER BY c.committed_order DESC LIMIT 8")
                .bind(&identity.task_id).bind(before).bind(&input.task_id).fetch_all(&mut *tx).await?;
            if rows.is_empty() {
                return Ok(ListCapturedArtifactsResponse {
                    artifacts,
                    next_before_order: 0,
                });
            }
            for row in rows {
                let artifact: CapturedArtifact = decode(&row.try_get::<Vec<u8>, _>("payload")?)?;
                let summary = artifact
                    .summary
                    .ok_or_else(|| invalid("stored artifact summary is missing"))?;
                let matches = summary.description.as_ref().is_some_and(|description| {
                    (input.kind.is_empty() || input.kind == description.kind)
                        && (query.is_empty()
                            || description.title.to_lowercase().contains(&query)
                            || description
                                .summary
                                .as_ref()
                                .is_some_and(|summary| summary.to_lowercase().contains(&query)))
                });
                if matches {
                    if bytes + summary.encoded_len() + 16 > MAX_MESSAGE_BYTES - 4096 {
                        return Ok(ListCapturedArtifactsResponse {
                            artifacts,
                            next_before_order: before as u64,
                        });
                    }
                    bytes += summary.encoded_len() + 16;
                    artifacts.push(summary);
                }
                before = row.try_get("committed_order")?;
                scanned += 1;
                if artifacts.len() == limit || scanned == 256 {
                    return Ok(ListCapturedArtifactsResponse {
                        artifacts,
                        next_before_order: before as u64,
                    });
                }
            }
        }
    }
    pub async fn acquire_artifact(
        &self,
        host: &HostAuthority,
        input: &AcquireArtifactRequest,
    ) -> Result<ArtifactAcquisition> {
        let identity = attempt(input.attempt.as_ref())?;
        name("artifact acquisition operation ID", &input.operation_id)?;
        name("artifact ID", &input.artifact_id)?;
        if !(1..=MAX_ARTIFACT_FILES).contains(&input.paths.len()) {
            return Err(invalid("acquisition requires 1–100 selected paths"));
        }
        let mut canonical = input.clone();
        canonical.attempt = None;
        canonical.paths.sort();
        for path in &canonical.paths {
            validate_artifact_path(path).map_err(|error| invalid(error.message()))?;
        }
        if canonical.paths.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(invalid("acquisition paths must be unique"));
        }
        match input.delivery() {
            ArtifactDelivery::Read if input.destination.is_none() => {}
            ArtifactDelivery::Materialize
                if input.destination.as_deref()
                    == Some(
                        supertag_protocol::artifacts::materialized_artifact_directory(
                            &identity.attempt_id,
                            &input.operation_id,
                        )
                        .as_str(),
                    ) => {}
            _ => return Err(invalid("invalid artifact delivery or destination")),
        }
        let digest = format!("{:x}", Sha256::digest(canonical.encode_to_vec()));
        let (mut tx, order) = self.write().await?;
        let row = owner_in(&mut tx, host, identity).await?;
        let prior=sqlx::query("SELECT payload,request_digest FROM supertag_v2_artifact_acquisitions WHERE attempt_id=$1 AND operation_id=$2")
            .bind(&identity.attempt_id).bind(&input.operation_id).fetch_optional(&mut *tx).await?;
        if let Some(prior) = prior {
            if prior.try_get::<String, _>("request_digest")? != digest {
                return Err(StoreError::Conflict(
                    "artifact acquisition operation has a different selection".into(),
                ));
            }
            return receipt(&prior);
        }
        let now = self.execution_now_ms();
        crate::artifact_captures::running(&row, now)?;
        let task = task_row(&row)?;
        let preselected = input
            .operation_id
            .starts_with(supertag_protocol::task_artifact_inputs::OPERATION_PREFIX);
        if preselected
            && !task
                .attempt_execution
                .as_ref()
                .is_some_and(|attempt| attempt.task_artifact_inputs)
        {
            return Err(StoreError::PermissionDenied);
        }
        if input.delivery() == ArtifactDelivery::Materialize
            && (task.workspace.is_none()
                || (!preselected
                    && task
                        .attempt_execution
                        .as_ref()
                        .is_some_and(|execution| execution.remote_file_workspace))
                || !task
                    .allowed_actions
                    .iter()
                    .any(|action| action == "files:read"))
        {
            return Err(StoreError::PermissionDenied);
        }
        let artifact = visible_in(&mut tx, &identity.task_id, &input.artifact_id).await?;
        let mut files = Vec::with_capacity(canonical.paths.len());
        for path in canonical.paths {
            files.push(
                artifact
                    .files
                    .iter()
                    .find(|file| file.path == path)
                    .cloned()
                    .ok_or_else(missing)?,
            );
        }
        crate::task_artifact_inputs::reserved_acquisition(&task, input, &artifact, &files)?;
        let acquisition = ArtifactAcquisition {
            acquisition_id: uuid::Uuid::new_v4().to_string(),
            operation_id: input.operation_id.clone(),
            task_id: identity.task_id.clone(),
            attempt_id: identity.attempt_id.clone(),
            artifact_id: input.artifact_id.clone(),
            files,
            delivery: input.delivery,
            destination: input.destination.clone(),
            state: ArtifactAcquisitionState::Authorized as i32,
            created_at_ms: now,
            updated_at_ms: now,
        };
        sqlx::query("INSERT INTO supertag_v2_artifact_acquisitions(acquisition_id,task_id,attempt_id,operation_id,artifact_id,request_digest,state,payload,created_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)")
            .bind(&acquisition.acquisition_id).bind(&identity.task_id).bind(&identity.attempt_id).bind(&input.operation_id).bind(&input.artifact_id).bind(digest).bind(acquisition.state as i64).bind(acquisition.encode_to_vec()).bind(order).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(acquisition)
    }
    pub async fn settle_artifact_acquisition(
        &self,
        host: &HostAuthority,
        input: &SettleArtifactAcquisitionRequest,
    ) -> Result<ArtifactAcquisition> {
        let identity = attempt(input.attempt.as_ref())?;
        if !matches!(
            input.state(),
            ArtifactAcquisitionState::Delivered
                | ArtifactAcquisitionState::Failed
                | ArtifactAcquisitionState::Uncertain
        ) {
            return Err(invalid("invalid artifact acquisition settlement"));
        }
        let (mut tx, _) = self.write().await?;
        let owned = owner_in(&mut tx, host, identity).await?;
        let row=sqlx::query("SELECT payload FROM supertag_v2_artifact_acquisitions WHERE acquisition_id=$1 AND attempt_id=$2 AND task_id=$3")
            .bind(&input.acquisition_id).bind(&identity.attempt_id).bind(&identity.task_id).fetch_optional(&mut *tx).await?.ok_or_else(missing)?;
        let mut acquisition = receipt(&row)?;
        let preparing_input = input.state() == ArtifactAcquisitionState::Delivered
            && acquisition
                .operation_id
                .starts_with(supertag_protocol::task_artifact_inputs::OPERATION_PREFIX);
        let now = self.execution_now_ms();
        if preparing_input {
            // The Host may have buffered these bytes while preparing an exclusive
            // Workspace. Recheck the accepted publication before launch, even
            // when an earlier Delivered response was lost.
            crate::artifact_captures::running(&owned, now)?;
            crate::artifact_publications::accepted_capture_in(
                &mut tx,
                &identity.task_id,
                &acquisition.artifact_id,
            )
            .await?;
        }
        if acquisition.state == input.state {
            return Ok(acquisition);
        }
        if matches!(
            acquisition.state(),
            ArtifactAcquisitionState::Delivered | ArtifactAcquisitionState::Failed
        ) {
            return Err(StoreError::Conflict(
                "artifact acquisition is already terminal".into(),
            ));
        }
        if !preparing_input {
            crate::artifact_captures::running(&owned, now)?;
        }
        acquisition.state = input.state;
        acquisition.updated_at_ms = now;
        sqlx::query("UPDATE supertag_v2_artifact_acquisitions SET state=$1,payload=$2 WHERE acquisition_id=$3").bind(input.state as i64).bind(acquisition.encode_to_vec()).bind(&input.acquisition_id).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(acquisition)
    }
    pub async fn get_acquired_artifact_file(
        &self,
        host: &HostAuthority,
        input: &GetAcquiredArtifactFileRequest,
    ) -> Result<ArtifactFile> {
        let identity = attempt(input.attempt.as_ref())?;
        let mut tx = self.pool.begin().await?;
        let owned = owner_in(&mut tx, host, identity).await?;
        crate::artifact_captures::running(&owned, self.execution_now_ms())?;
        let row=sqlx::query("SELECT payload FROM supertag_v2_artifact_acquisitions WHERE acquisition_id=$1 AND attempt_id=$2 AND task_id=$3 AND state<>$4")
            .bind(&input.acquisition_id).bind(&identity.attempt_id).bind(&identity.task_id).bind(ArtifactAcquisitionState::Failed as i64).fetch_optional(&mut *tx).await?.ok_or_else(missing)?;
        let acquisition = receipt(&row)?;
        visible_in(&mut tx, &identity.task_id, &acquisition.artifact_id).await?;
        acquisition
            .files
            .into_iter()
            .find(|file| file.path == input.path)
            .ok_or_else(missing)
    }
}
