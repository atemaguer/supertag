use prost::Message;
use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::{
    artifacts::{MAX_ARTIFACT_BYTES, validate_artifact_path},
    task_artifact_inputs::{MAX_INPUT_FILES, MAX_INPUTS, OPERATION_PREFIX, operation_id},
    v2::*,
};

use crate::{
    StoreError,
    artifact_acquisitions::visible_in,
    artifact_captures::submitted_from_row,
    conversations::task_access_in,
    policy::decode,
    store::{Result, invalid, name},
};

pub(crate) fn normalize(
    input: &[TaskArtifactInputSelection],
) -> Result<Vec<TaskArtifactInputSelection>> {
    if input.len() > MAX_INPUTS
        || input.iter().map(|item| item.paths.len()).sum::<usize>() > MAX_INPUT_FILES
    {
        return Err(invalid("too many selected Task artifact inputs"));
    }
    let mut result = input.to_vec();
    result.sort_unstable_by(|left, right| left.artifact_id.cmp(&right.artifact_id));
    if result
        .windows(2)
        .any(|pair| pair[0].artifact_id == pair[1].artifact_id)
    {
        return Err(invalid(
            "Task artifact inputs must select each artifact once",
        ));
    }
    for input in &mut result {
        name("artifact ID", &input.artifact_id)?;
        if let Some(id) = &input.publication_approval_id {
            name("publication ID", id)?;
        }
        if input.paths.is_empty() {
            return Err(invalid("Task artifact input requires selected file paths"));
        }
        input.paths.sort_unstable();
        for path in &input.paths {
            validate_artifact_path(path).map_err(|error| invalid(error.message()))?;
        }
        if input.paths.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(invalid("Task artifact input paths must be unique"));
        }
    }
    Ok(result)
}

pub(crate) fn digest(previous: String, selections: &[TaskArtifactInputSelection]) -> String {
    if selections.is_empty() {
        return previous;
    }
    let mut hash = Sha256::new();
    hash.update(previous);
    hash.update(b"\0task-artifact-inputs\0");
    for selection in selections {
        let bytes = selection.encode_to_vec();
        hash.update((bytes.len() as u64).to_be_bytes());
        hash.update(bytes);
    }
    format!("{:x}", hash.finalize())
}

pub(crate) fn from_row(row: &AnyRow) -> Result<Vec<AcceptedTaskArtifactInput>> {
    let data: Option<Vec<u8>> = row.try_get("input_artifacts")?;
    Ok(data
        .as_deref()
        .map(decode::<AcceptedTaskArtifactInputs>)
        .transpose()?
        .map_or_else(Vec::new, |data| data.inputs))
}

fn unavailable() -> StoreError {
    StoreError::NotFound("submitted artifact input was not found in this Objective".into())
}

pub(crate) async fn accept_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    task: &mut Task,
    selections: &[TaskArtifactInputSelection],
) -> Result<()> {
    if selections.is_empty() {
        return Ok(());
    }
    if task.workspace.is_none()
        || !task
            .allowed_actions
            .iter()
            .any(|action| action == "files:read")
        || !supertag_protocol::task_artifact_inputs::supports_harness(task.harness_kind())
    {
        return Err(StoreError::FailedPrecondition(
            "Task artifact inputs require a supported Harness, Workspace, and file read access"
                .into(),
        ));
    }
    let objective: String = sqlx::query_scalar(
        "SELECT objective_id FROM supertag_v2_task_audience WHERE task_id=$1 AND objective_id<>''",
    )
    .bind(&task.task_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| {
        StoreError::FailedPrecondition("explicit Task artifact inputs require an Objective".into())
    })?;

    let mut total = 0_u64;
    let mut inputs = Vec::with_capacity(selections.len());
    for selection in selections {
        let (artifact, publication) = if let Some(publication) = &selection.publication_approval_id
        {
            let (capture, pin) = crate::artifact_publications::resolve_selection_in(
                tx,
                &objective,
                publication,
                &selection.artifact_id,
                &selection.paths,
            )
            .await?;
            (capture, Some(pin))
        } else {
            let artifact = visible_in(tx, &task.task_id, &selection.artifact_id).await?;
            let producer = artifact
                .summary
                .as_ref()
                .and_then(|s| s.producer.as_ref())
                .ok_or_else(unavailable)?;
            if producer.objective_id.as_deref() != Some(objective.as_str())
                || !task_access_in(tx, principal, &producer.task_id).await?
            {
                return Err(unavailable());
            }
            let source=sqlx::query("SELECT result_artifacts FROM supertag_v2_tasks WHERE task_id=$1 AND attempt_id=$2 AND state=$3 AND cleanup_pending=0").bind(&producer.task_id).bind(&producer.attempt_id).bind(TaskState::Succeeded as i64).fetch_optional(&mut **tx).await?.ok_or_else(unavailable)?;
            let submitted = submitted_from_row(&source)?;
            if !submitted.iter().any(|s| {
                s.artifact_id == selection.artifact_id
                    && selection.paths.iter().all(|p| s.paths.contains(p))
            }) {
                return Err(unavailable());
            }
            if selection.require_accepted
                && !crate::artifact_publications::accepted_in(
                    tx,
                    &selection.artifact_id,
                    &selection.paths,
                )
                .await?
            {
                return Err(StoreError::FailedPrecondition(
                    "exact artifact review evidence is unavailable".into(),
                ));
            }
            (artifact, None)
        };
        let producer = artifact
            .summary
            .as_ref()
            .and_then(|s| s.producer.as_ref())
            .ok_or_else(unavailable)?;
        let mut files = Vec::with_capacity(selection.paths.len());
        for path in &selection.paths {
            let file = artifact
                .files
                .iter()
                .find(|file| &file.path == path)
                .ok_or_else(unavailable)?;
            let blob = file.blob.clone().ok_or_else(unavailable)?;
            total = total
                .checked_add(blob.byte_length)
                .ok_or_else(|| invalid("Task artifact inputs exceed the byte limit"))?;
            if total > MAX_ARTIFACT_BYTES {
                return Err(invalid("Task artifact inputs exceed the byte limit"));
            }
            files.push(ArtifactInputFile {
                path: path.clone(),
                blob: Some(blob),
            });
        }
        inputs.push(AcceptedTaskArtifactInput {
            artifact_id: selection.artifact_id.clone(),
            source_task_id: producer.task_id.clone(),
            source_attempt_id: producer.attempt_id.clone(),
            publication,
            files,
        });
    }
    sqlx::query("UPDATE supertag_v2_tasks SET input_artifacts=$1 WHERE task_id=$2")
        .bind(
            AcceptedTaskArtifactInputs {
                inputs: inputs.clone(),
            }
            .encode_to_vec(),
        )
        .bind(&task.task_id)
        .execute(&mut **tx)
        .await?;
    task.input_artifacts = inputs;
    if task.encoded_len() > super::store::MAX_TASK_MESSAGE_BYTES {
        return Err(invalid("accepted Task exceeds the transport limit"));
    }
    Ok(())
}

pub(crate) fn reserved_acquisition(
    task: &Task,
    input: &AcquireArtifactRequest,
    artifact: &CapturedArtifact,
    files: &[ArtifactFile],
) -> Result<()> {
    if !input.operation_id.starts_with(OPERATION_PREFIX) {
        return Ok(());
    }
    let pin = task
        .input_artifacts
        .iter()
        .find(|pin| pin.artifact_id == input.artifact_id);
    let producer = artifact
        .summary
        .as_ref()
        .and_then(|summary| summary.producer.as_ref());
    if input.delivery() != ArtifactDelivery::Materialize
        || input.operation_id != operation_id(&input.artifact_id)
        || !pin.zip(producer).is_some_and(|(pin, producer)| {
            pin.source_task_id == producer.task_id
                && pin.source_attempt_id == producer.attempt_id
                && pin.files.len() == files.len()
                && pin
                    .files
                    .iter()
                    .zip(files)
                    .all(|(pin, file)| pin.path == file.path && pin.blob == file.blob)
        })
    {
        return Err(StoreError::PermissionDenied);
    }
    Ok(())
}
