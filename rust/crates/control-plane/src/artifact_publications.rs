//! Explicit, immutable cross-Objective approval and revocable consumption authority.
use crate::{
    ControlPlane, Store, StoreError,
    policy::{decode, operator},
    store::{Result, invalid, name},
};
use prost::Message;
use sqlx::{Any, Row, Transaction};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};

fn missing() -> StoreError {
    StoreError::NotFound("artifact approval was not found".into())
}
fn conflict() -> StoreError {
    StoreError::Conflict("artifact approval identity or revision differs".into())
}
fn refused(message: &str) -> StoreError {
    StoreError::FailedPrecondition(message.into())
}
async fn objective_in(tx: &mut Transaction<'_, Any>, id: &str) -> Result<String> {
    name("Objective ID", id)?;
    sqlx::query_scalar("SELECT owner_tag_id FROM supertag_v2_objectives WHERE objective_id=$1")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(missing)
}
async fn publication_in(tx: &mut Transaction<'_, Any>, id: &str) -> Result<ArtifactPublication> {
    let bytes: Vec<u8> = sqlx::query_scalar(
        "SELECT payload FROM supertag_v2_artifact_publications WHERE publication_id=$1",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(missing)?;
    decode(&bytes)
}
async fn consumption_in(
    tx: &mut Transaction<'_, Any>,
    id: &str,
) -> Result<ArtifactConsumptionApproval> {
    let bytes: Vec<u8> = sqlx::query_scalar(
        "SELECT payload FROM supertag_v2_artifact_consumptions WHERE consumption_id=$1",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(missing)?;
    decode(&bytes)
}
async fn source_access_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    p: &ArtifactPublication,
) -> Result<()> {
    let producer = p.producer.as_ref().ok_or_else(missing)?;
    if !crate::conversations::task_access_in(tx, principal, &producer.task_id).await? {
        return Err(missing());
    }
    Ok(())
}
async fn audit_in(
    tx: &mut Transaction<'_, Any>,
    kind: &str,
    id: &str,
    objective: &str,
    revision: u64,
    actor: &str,
    now: i64,
) -> Result<()> {
    let event = ArtifactApprovalAuditEvent {
        approval_type: kind.into(),
        approval_id: id.into(),
        objective_id: objective.into(),
        revision,
        action: if revision == 1 {
            "approved"
        } else {
            "withdrawn"
        }
        .into(),
        actor: actor.into(),
        recorded_at_ms: now,
    };
    sqlx::query("INSERT INTO supertag_v2_artifact_approval_audit(approval_type,approval_id,revision,payload) VALUES($1,$2,$3,$4)").bind(kind).bind(id).bind(revision as i64).bind(event.encode_to_vec()).execute(&mut **tx).await?;
    Ok(())
}
fn normalized(input: &PublishArtifactRequest) -> Result<PublishArtifactRequest> {
    name("publication ID", &input.publication_id)?;
    let selections = crate::artifact_captures::normalize_submissions(&[ArtifactSelection {
        artifact_id: input.artifact_id.clone(),
        paths: input.paths.clone(),
    }])?;
    let mut value = input.clone();
    value.paths = selections[0].paths.clone();
    value.audience_objective_ids.sort_unstable();
    value.audience_objective_ids.dedup();
    if !(1..=100).contains(&value.audience_objective_ids.len()) {
        return Err(invalid(
            "publication audience must contain 1 to 100 Objectives",
        ));
    }
    for id in &value.audience_objective_ids {
        name("audience Objective ID", id)?;
    }
    if let Some(id) = &value.supersedes_publication_id {
        name("superseded publication ID", id)?;
        if id == &value.publication_id {
            return Err(invalid("a publication cannot supersede itself"));
        }
    }
    Ok(value)
}
fn page(limit: u32, before: u64) -> Result<(i64, i64)> {
    if limit > 100 || before > i64::MAX as u64 {
        return Err(invalid("invalid artifact approval page"));
    }
    Ok((
        if limit == 0 { 30 } else { limit } as i64,
        if before == 0 { i64::MAX } else { before as i64 },
    ))
}
fn view(p: ArtifactPublication) -> ArtifactPublicationView {
    ArtifactPublicationView {
        publication_id: p.publication_id,
        source_objective_id: p.source_objective_id,
        artifact_id: p.artifact_id,
        files: p.files,
        supersedes_publication_id: p.supersedes_publication_id,
        status: p.status,
        revision: p.revision,
    }
}
impl Store {
    pub async fn publish_artifact(
        &self,
        principal: &str,
        input: &PublishArtifactRequest,
    ) -> Result<ArtifactPublication> {
        operator(principal)?;
        let input = normalized(input)?;
        let digest = crate::policy::digest(principal, &input);
        let (mut tx, order) = self.write().await?;
        if let Some(row)=sqlx::query("SELECT request_digest,payload FROM supertag_v2_artifact_publications WHERE publication_id=$1").bind(&input.publication_id).fetch_optional(&mut *tx).await?{
   if row.try_get::<String,_>("request_digest")?!=digest{return Err(conflict())} let prior:ArtifactPublication=decode(&row.try_get::<Vec<u8>,_>("payload")?)?;source_access_in(&mut tx,principal,&prior).await?;tx.commit().await?;return Ok(prior)
  }
        let row=sqlx::query("SELECT c.payload,t.*,o.objective_id AS source_objective FROM supertag_v2_artifact_captures c JOIN supertag_v2_tasks t ON t.task_id=c.task_id JOIN supertag_v2_objective_tasks o ON o.task_id=t.task_id WHERE c.artifact_id=$1 AND c.committed_order IS NOT NULL").bind(&input.artifact_id).fetch_optional(&mut *tx).await?.ok_or_else(missing)?;
        let artifact: CapturedArtifact = decode(&row.try_get::<Vec<u8>, _>("payload")?)?;
        let producer = artifact
            .summary
            .as_ref()
            .and_then(|s| s.producer.as_ref())
            .ok_or_else(missing)?;
        if !crate::conversations::task_access_in(&mut tx, principal, &producer.task_id).await? {
            return Err(missing());
        }
        let task = crate::store::task_row(&row)?;
        if task.state != TaskState::Succeeded as i32
            || row.try_get::<i64, _>("cleanup_pending")? != 0
            || task.attempt_id.as_deref() != Some(&producer.attempt_id)
        {
            return Err(refused(
                "publication requires the successful current producing Attempt",
            ));
        }
        let submitted = task
            .artifacts
            .iter()
            .find(|a| a.artifact_id == input.artifact_id)
            .ok_or_else(|| refused("artifact was not submitted by the completed Task"))?;
        if input.paths.iter().any(|p| !submitted.paths.contains(p)) {
            return Err(invalid(
                "publication paths must be submitted by the completed Task",
            ));
        }
        let source: String = row.try_get("source_objective")?;
        let owner = objective_in(&mut tx, &source).await?;
        for audience in &input.audience_objective_ids {
            if audience == &source {
                return Err(invalid("publication audience must be another Objective"));
            }
            objective_in(&mut tx, audience).await?;
        }
        if let Some(previous) = &input.supersedes_publication_id {
            let previous = publication_in(&mut tx, previous).await?;
            if previous.source_objective_id != source {
                return Err(missing());
            }
            if previous.artifact_id == input.artifact_id
                && previous
                    .files
                    .iter()
                    .map(|f| &f.path)
                    .eq(input.paths.iter())
            {
                return Err(invalid(
                    "replacement must publish different artifact entries",
                ));
            }
        }
        let mut files = Vec::new();
        for path in &input.paths {
            files.push(
                artifact
                    .files
                    .iter()
                    .find(|f| &f.path == path)
                    .ok_or_else(|| invalid("selected artifact path was not captured"))?
                    .clone(),
            )
        }
        let now = self.execution_now_ms();
        let p = ArtifactPublication {
            publication_id: input.publication_id.clone(),
            source_objective_id: source.clone(),
            producer: Some(producer.clone()),
            artifact_id: input.artifact_id.clone(),
            files,
            audience_objective_ids: input.audience_objective_ids.clone(),
            source_owner_tag_id: owner,
            assessment: task.result.unwrap_or_default(),
            approved_by: principal.into(),
            approved_at_ms: now,
            supersedes_publication_id: input.supersedes_publication_id,
            status: ArtifactApprovalStatus::Available as i32,
            revision: 1,
            withdrawn_by: None,
            withdrawn_at_ms: None,
        };
        if p.encoded_len() > MAX_MESSAGE_BYTES / 2 {
            return Err(invalid("artifact publication exceeds its bounded size"));
        }
        sqlx::query("INSERT INTO supertag_v2_artifact_publications(publication_id,source_objective_id,artifact_id,request_digest,payload,created_order) VALUES($1,$2,$3,$4,$5,$6)").bind(&p.publication_id).bind(&source).bind(&p.artifact_id).bind(digest).bind(p.encode_to_vec()).bind(order).execute(&mut *tx).await?;
        for audience in &p.audience_objective_ids {
            sqlx::query("INSERT INTO supertag_v2_artifact_publication_audience(publication_id,objective_id) VALUES($1,$2)").bind(&p.publication_id).bind(audience).execute(&mut *tx).await?;
        }
        audit_in(
            &mut tx,
            "publication",
            &p.publication_id,
            &source,
            1,
            principal,
            now,
        )
        .await?;
        tx.commit().await?;
        Ok(p)
    }
    pub async fn consume_artifact_publication(
        &self,
        principal: &str,
        input: &ConsumeArtifactPublicationRequest,
    ) -> Result<ArtifactConsumptionApproval> {
        operator(principal)?;
        name("consumption ID", &input.consumption_id)?;
        name("publication ID", &input.publication_id)?;
        let digest = crate::policy::digest(principal, input);
        let (mut tx, order) = self.write().await?;
        if let Some(row)=sqlx::query("SELECT request_digest,payload FROM supertag_v2_artifact_consumptions WHERE consumption_id=$1").bind(&input.consumption_id).fetch_optional(&mut *tx).await?{if row.try_get::<String,_>("request_digest")?!=digest{return Err(conflict())}let prior=decode(&row.try_get::<Vec<u8>,_>("payload")?)?;tx.commit().await?;return Ok(prior)}
        objective_in(&mut tx, &input.objective_id).await?;
        let p = publication_in(&mut tx, &input.publication_id).await?;
        if p.status != ArtifactApprovalStatus::Available as i32
            || !p.audience_objective_ids.contains(&input.objective_id)
        {
            return Err(missing());
        }
        let existing:Option<String>=sqlx::query_scalar("SELECT consumption_id FROM supertag_v2_artifact_consumptions WHERE publication_id=$1 AND objective_id=$2").bind(&input.publication_id).bind(&input.objective_id).fetch_optional(&mut *tx).await?;
        if existing.is_some() {
            return Err(conflict());
        }
        let now = self.execution_now_ms();
        let c = ArtifactConsumptionApproval {
            consumption_id: input.consumption_id.clone(),
            publication_id: input.publication_id.clone(),
            objective_id: input.objective_id.clone(),
            approved_by: principal.into(),
            approved_at_ms: now,
            status: ArtifactApprovalStatus::Available as i32,
            revision: 1,
            withdrawn_by: None,
            withdrawn_at_ms: None,
        };
        sqlx::query("INSERT INTO supertag_v2_artifact_consumptions(consumption_id,publication_id,objective_id,request_digest,payload,created_order) VALUES($1,$2,$3,$4,$5,$6)").bind(&c.consumption_id).bind(&c.publication_id).bind(&c.objective_id).bind(digest).bind(c.encode_to_vec()).bind(order).execute(&mut *tx).await?;
        audit_in(
            &mut tx,
            "consumption",
            &c.consumption_id,
            &c.objective_id,
            1,
            principal,
            now,
        )
        .await?;
        tx.commit().await?;
        Ok(c)
    }
    pub async fn get_artifact_publication(
        &self,
        principal: &str,
        id: &str,
    ) -> Result<ArtifactPublication> {
        operator(principal)?;
        name("publication ID", id)?;
        let mut tx = self.pool.begin().await?;
        let p = publication_in(&mut tx, id).await?;
        source_access_in(&mut tx, principal, &p).await?;
        tx.commit().await?;
        Ok(p)
    }
    pub async fn get_artifact_consumption(
        &self,
        principal: &str,
        id: &str,
    ) -> Result<ArtifactConsumptionApproval> {
        operator(principal)?;
        name("consumption ID", id)?;
        let mut tx = self.pool.begin().await?;
        let c = consumption_in(&mut tx, id).await?;
        tx.commit().await?;
        Ok(c)
    }
    pub async fn withdraw_artifact_publication(
        &self,
        principal: &str,
        input: &WithdrawArtifactApprovalRequest,
    ) -> Result<ArtifactPublication> {
        operator(principal)?;
        name("publication ID", &input.approval_id)?;
        let (mut tx, _) = self.write().await?;
        let mut p = publication_in(&mut tx, &input.approval_id).await?;
        source_access_in(&mut tx, principal, &p).await?;
        if p.status == ArtifactApprovalStatus::Withdrawn as i32
            && p.revision == input.expected_revision.saturating_add(1)
            && p.withdrawn_by.as_deref() == Some(principal)
        {
            tx.commit().await?;
            return Ok(p);
        }
        if input.expected_revision == 0
            || p.status != ArtifactApprovalStatus::Available as i32
            || p.revision != input.expected_revision
        {
            return Err(conflict());
        }
        let now = self.execution_now_ms();
        p.status = ArtifactApprovalStatus::Withdrawn as i32;
        p.revision += 1;
        p.withdrawn_by = Some(principal.into());
        p.withdrawn_at_ms = Some(now);
        sqlx::query(
            "UPDATE supertag_v2_artifact_publications SET payload=$1 WHERE publication_id=$2",
        )
        .bind(p.encode_to_vec())
        .bind(&p.publication_id)
        .execute(&mut *tx)
        .await?;
        audit_in(
            &mut tx,
            "publication",
            &p.publication_id,
            &p.source_objective_id,
            p.revision,
            principal,
            now,
        )
        .await?;
        tx.commit().await?;
        Ok(p)
    }
    pub async fn withdraw_artifact_consumption(
        &self,
        principal: &str,
        input: &WithdrawArtifactApprovalRequest,
    ) -> Result<ArtifactConsumptionApproval> {
        operator(principal)?;
        name("consumption ID", &input.approval_id)?;
        let (mut tx, _) = self.write().await?;
        let mut c = consumption_in(&mut tx, &input.approval_id).await?;
        if c.status == ArtifactApprovalStatus::Withdrawn as i32
            && c.revision == input.expected_revision.saturating_add(1)
            && c.withdrawn_by.as_deref() == Some(principal)
        {
            tx.commit().await?;
            return Ok(c);
        }
        if input.expected_revision == 0
            || c.status != ArtifactApprovalStatus::Available as i32
            || c.revision != input.expected_revision
        {
            return Err(conflict());
        }
        let now = self.execution_now_ms();
        c.status = ArtifactApprovalStatus::Withdrawn as i32;
        c.revision += 1;
        c.withdrawn_by = Some(principal.into());
        c.withdrawn_at_ms = Some(now);
        sqlx::query(
            "UPDATE supertag_v2_artifact_consumptions SET payload=$1 WHERE consumption_id=$2",
        )
        .bind(c.encode_to_vec())
        .bind(&c.consumption_id)
        .execute(&mut *tx)
        .await?;
        audit_in(
            &mut tx,
            "consumption",
            &c.consumption_id,
            &c.objective_id,
            c.revision,
            principal,
            now,
        )
        .await?;
        tx.commit().await?;
        Ok(c)
    }
    pub async fn list_artifact_publications(
        &self,
        principal: &str,
        input: &ListObjectiveArtifactApprovalsRequest,
    ) -> Result<ListArtifactPublicationsResponse> {
        operator(principal)?;
        let (limit, before) = page(input.limit, input.before_order)?;
        let mut tx = self.pool.begin().await?;
        objective_in(&mut tx, &input.objective_id).await?;
        let rows=sqlx::query("SELECT p.payload,p.created_order FROM supertag_v2_artifact_publications p WHERE p.created_order<$1 AND (p.source_objective_id=$2 OR EXISTS(SELECT 1 FROM supertag_v2_artifact_publication_audience a WHERE a.publication_id=p.publication_id AND a.objective_id=$2)) ORDER BY p.created_order DESC LIMIT $3").bind(before).bind(&input.objective_id).bind(limit+1).fetch_all(&mut *tx).await?;
        let mut out = ListArtifactPublicationsResponse::default();
        let mut last = 0;
        let mut bytes = 0;
        for row in rows {
            let p = view(decode(&row.try_get::<Vec<u8>, _>("payload")?)?);
            if out.publications.len() == limit as usize
                || bytes + p.encoded_len() + 16 > MAX_MESSAGE_BYTES - 1024
            {
                out.next_before_order = last;
                break;
            }
            bytes += p.encoded_len() + 16;
            last = row.try_get::<i64, _>("created_order")? as u64;
            out.publications.push(p)
        }
        tx.commit().await?;
        Ok(out)
    }
    pub async fn list_artifact_consumptions(
        &self,
        principal: &str,
        input: &ListObjectiveArtifactApprovalsRequest,
    ) -> Result<ListArtifactConsumptionsResponse> {
        operator(principal)?;
        let (limit, before) = page(input.limit, input.before_order)?;
        let mut tx = self.pool.begin().await?;
        objective_in(&mut tx, &input.objective_id).await?;
        let rows=sqlx::query("SELECT payload,created_order FROM supertag_v2_artifact_consumptions WHERE objective_id=$1 AND created_order<$2 ORDER BY created_order DESC LIMIT $3").bind(&input.objective_id).bind(before).bind(limit+1).fetch_all(&mut *tx).await?;
        let mut out = ListArtifactConsumptionsResponse::default();
        let mut last = 0;
        for row in rows {
            if out.consumptions.len() == limit as usize {
                out.next_before_order = last;
                break;
            }
            last = row.try_get::<i64, _>("created_order")? as u64;
            out.consumptions
                .push(decode(&row.try_get::<Vec<u8>, _>("payload")?)?)
        }
        tx.commit().await?;
        Ok(out)
    }
    pub async fn list_artifact_approval_audit(
        &self,
        principal: &str,
        input: &ListArtifactApprovalAuditRequest,
    ) -> Result<ListArtifactApprovalAuditResponse> {
        operator(principal)?;
        name("approval ID", &input.approval_id)?;
        let mut tx = self.pool.begin().await?;
        match input.approval_type.as_str() {
            "publication" => {
                let p = publication_in(&mut tx, &input.approval_id).await?;
                source_access_in(&mut tx, principal, &p).await?;
            }
            "consumption" => {
                consumption_in(&mut tx, &input.approval_id).await?;
            }
            _ => return Err(invalid("approval type must be publication or consumption")),
        }
        let bytes:Vec<Vec<u8>>=sqlx::query_scalar("SELECT payload FROM supertag_v2_artifact_approval_audit WHERE approval_type=$1 AND approval_id=$2 ORDER BY revision").bind(&input.approval_type).bind(&input.approval_id).fetch_all(&mut *tx).await?;
        let events = bytes
            .iter()
            .map(|b| decode(b))
            .collect::<Result<Vec<_>>>()?;
        tx.commit().await?;
        Ok(ListArtifactApprovalAuditResponse { events })
    }
}

/// Resolve only the expressly approved entries. Possession of an approval ID grants nothing.
pub(crate) async fn resolve_selection_in(
    tx: &mut Transaction<'_, Any>,
    objective: &str,
    publication: &str,
    artifact: &str,
    paths: &[String],
) -> Result<(CapturedArtifact, ArtifactPublicationPin)> {
    let p = publication_in(tx, publication).await?;
    if p.status != ArtifactApprovalStatus::Available as i32
        || p.artifact_id != artifact
        || !p.audience_objective_ids.iter().any(|id| id == objective)
    {
        return Err(missing());
    }
    let bytes:Vec<u8>=sqlx::query_scalar("SELECT payload FROM supertag_v2_artifact_consumptions WHERE publication_id=$1 AND objective_id=$2").bind(publication).bind(objective).fetch_optional(&mut **tx).await?.ok_or_else(missing)?;
    let c: ArtifactConsumptionApproval = decode(&bytes)?;
    if c.status != ArtifactApprovalStatus::Available as i32 {
        return Err(missing());
    }
    let mut files = Vec::new();
    for path in paths {
        files.push(
            p.files
                .iter()
                .find(|f| &f.path == path)
                .ok_or_else(missing)?
                .clone(),
        )
    }
    let capture:Vec<u8>=sqlx::query_scalar("SELECT payload FROM supertag_v2_artifact_captures WHERE artifact_id=$1 AND committed_order IS NOT NULL").bind(artifact).fetch_one(&mut **tx).await?;
    let mut capture: CapturedArtifact = decode(&capture)?;
    capture.files = files;
    capture.inputs.clear();
    let pin = ArtifactPublicationPin {
        publication_id: p.publication_id,
        publication_revision: p.revision,
        consumption_id: c.consumption_id,
        consumption_revision: c.revision,
        source_objective_id: p.source_objective_id,
        destination_objective_id: objective.into(),
    };
    Ok((capture, pin))
}
pub(crate) async fn validate_pin_in(
    tx: &mut Transaction<'_, Any>,
    pin: &ArtifactPublicationPin,
) -> Result<()> {
    let p = publication_in(tx, &pin.publication_id).await?;
    let c = consumption_in(tx, &pin.consumption_id).await?;
    if p.status != ArtifactApprovalStatus::Available as i32
        || c.status != ArtifactApprovalStatus::Available as i32
        || p.revision != pin.publication_revision
        || c.revision != pin.consumption_revision
        || p.source_objective_id != pin.source_objective_id
        || c.objective_id != pin.destination_objective_id
        || c.publication_id != p.publication_id
        || !p.audience_objective_ids.contains(&c.objective_id)
    {
        return Err(missing());
    }
    Ok(())
}
/// An accepted publication never becomes a broad catalog grant. Each access
/// rechecks both revisions and returns only the immutable admitted entries.
pub(crate) async fn accepted_capture_in(
    tx: &mut Transaction<'_, Any>,
    consumer: &str,
    id: &str,
) -> Result<Option<CapturedArtifact>> {
    let row=sqlx::query("SELECT t.input_artifacts,a.objective_id FROM supertag_v2_tasks t JOIN supertag_v2_task_audience a ON a.task_id=t.task_id WHERE t.task_id=$1").bind(consumer).fetch_optional(&mut **tx).await?.ok_or_else(missing)?;
    let inputs = crate::task_artifact_inputs::from_row(&row)?;
    let Some(input) = inputs
        .iter()
        .find(|input| input.artifact_id == id && input.publication.is_some())
    else {
        return Ok(None);
    };
    let pin = input.publication.as_ref().ok_or_else(missing)?;
    if row.try_get::<String, _>("objective_id")? != pin.destination_objective_id {
        return Err(missing());
    }
    validate_pin_in(tx, pin).await?;
    let paths = input
        .files
        .iter()
        .map(|f| f.path.clone())
        .collect::<Vec<_>>();
    let (capture, current_pin) = resolve_selection_in(
        tx,
        &pin.destination_objective_id,
        &pin.publication_id,
        id,
        &paths,
    )
    .await?;
    let producer = capture
        .summary
        .as_ref()
        .and_then(|s| s.producer.as_ref())
        .ok_or_else(missing)?;
    if current_pin != *pin
        || input.source_task_id != producer.task_id
        || input.source_attempt_id != producer.attempt_id
        || input.files.len() != capture.files.len()
        || !input
            .files
            .iter()
            .zip(&capture.files)
            .all(|(a, b)| a.path == b.path && a.blob == b.blob)
    {
        return Err(missing());
    }
    Ok(Some(capture))
}

#[derive(Message)]
struct ReviewedSelections {
    #[prost(message, repeated, tag = "1")]
    selections: Vec<ArtifactSelection>,
}
pub(crate) async fn review_in(
    tx: &mut Transaction<'_, Any>,
    objective: &Objective,
    principal: &str,
    approved: bool,
    now: i64,
) -> Result<()> {
    let row=sqlx::query("SELECT t.* FROM supertag_v2_tasks t JOIN supertag_v2_objective_tasks o ON o.task_id=t.task_id WHERE o.objective_id=$1 AND t.tag_id=$2 AND t.session_id=$3 AND o.kind<>'notice' ORDER BY t.accepted_order DESC LIMIT 1").bind(&objective.objective_id).bind(&objective.owner_tag_id).bind(&objective.session_id).fetch_optional(&mut **tx).await?;
    if let Some(row) = row {
        let task = crate::store::task_row(&row)?;
        if task.state == TaskState::Succeeded as i32 && !task.artifacts.is_empty() {
            let attempt = task.attempt_id.ok_or_else(missing)?;
            sqlx::query("INSERT INTO supertag_v2_artifact_review_evidence(task_id,attempt_id,objective_id,objective_revision,approved,actor,recorded_at_ms,selections) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(&task.task_id).bind(attempt).bind(&objective.objective_id).bind(objective.revision as i64).bind(i64::from(approved)).bind(principal).bind(now).bind(ReviewedSelections{selections:task.artifacts}.encode_to_vec()).execute(&mut **tx).await?;
        }
    }
    Ok(())
}
pub(crate) async fn accepted_in(
    tx: &mut Transaction<'_, Any>,
    artifact: &str,
    paths: &[String],
) -> Result<bool> {
    let rows=sqlx::query("SELECT e.approved,e.selections FROM supertag_v2_artifact_review_evidence e JOIN supertag_v2_artifact_captures c ON c.task_id=e.task_id AND c.attempt_id=e.attempt_id WHERE c.artifact_id=$1 ORDER BY e.objective_revision DESC LIMIT 1").bind(artifact).fetch_optional(&mut **tx).await?;
    let Some(row) = rows else { return Ok(false) };
    let reviewed: ReviewedSelections = decode(&row.try_get::<Vec<u8>, _>("selections")?)?;
    Ok(row.try_get::<i64, _>("approved")? == 1
        && reviewed
            .selections
            .iter()
            .any(|s| s.artifact_id == artifact && paths.iter().all(|p| s.paths.contains(p))))
}

#[tonic::async_trait]
impl artifact_publications_server::ArtifactPublications for ControlPlane {
    async fn publish(
        &self,
        request: Request<PublishArtifactRequest>,
    ) -> std::result::Result<Response<ArtifactPublication>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .publish_artifact(&principal, &request.into_inner())
                .await?,
        ))
    }
    async fn consume(
        &self,
        request: Request<ConsumeArtifactPublicationRequest>,
    ) -> std::result::Result<Response<ArtifactConsumptionApproval>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .consume_artifact_publication(&principal, &request.into_inner())
                .await?,
        ))
    }
    async fn withdraw_publication(
        &self,
        request: Request<WithdrawArtifactApprovalRequest>,
    ) -> std::result::Result<Response<ArtifactPublication>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .withdraw_artifact_publication(&principal, &request.into_inner())
                .await?,
        ))
    }
    async fn withdraw_consumption(
        &self,
        request: Request<WithdrawArtifactApprovalRequest>,
    ) -> std::result::Result<Response<ArtifactConsumptionApproval>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .withdraw_artifact_consumption(&principal, &request.into_inner())
                .await?,
        ))
    }
    async fn get_publication(
        &self,
        request: Request<GetArtifactApprovalRequest>,
    ) -> std::result::Result<Response<ArtifactPublication>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .get_artifact_publication(&principal, &request.into_inner().approval_id)
                .await?,
        ))
    }
    async fn get_consumption(
        &self,
        request: Request<GetArtifactApprovalRequest>,
    ) -> std::result::Result<Response<ArtifactConsumptionApproval>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .get_artifact_consumption(&principal, &request.into_inner().approval_id)
                .await?,
        ))
    }
    async fn list_publications(
        &self,
        request: Request<ListObjectiveArtifactApprovalsRequest>,
    ) -> std::result::Result<Response<ListArtifactPublicationsResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_artifact_publications(&principal, &request.into_inner())
                .await?,
        ))
    }
    async fn list_consumptions(
        &self,
        request: Request<ListObjectiveArtifactApprovalsRequest>,
    ) -> std::result::Result<Response<ListArtifactConsumptionsResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_artifact_consumptions(&principal, &request.into_inner())
                .await?,
        ))
    }
    async fn list_audit(
        &self,
        request: Request<ListArtifactApprovalAuditRequest>,
    ) -> std::result::Result<Response<ListArtifactApprovalAuditResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_artifact_approval_audit(&principal, &request.into_inner())
                .await?,
        ))
    }
}

#[cfg(test)]
#[path = "artifact_publications/tests.rs"]
mod tests;
