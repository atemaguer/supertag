//! Landing is a separate durable effect of an accepted Workspace delivery: a Task succeeds
//! whether or not its changes reached the remote. Git delivery claims each landing, pushes
//! fast-forward only, and records what the remote now names.
//!
//! - `branch`: every delivered Task queues a landing of the Session's branch. A newer delivery
//!   of the same Session supersedes one not yet claimed, since its commit contains the older.
//! - `review`: like `branch`, and git delivery then opens or updates the branch's draft pull
//!   request; the landing records it, and its merge closes the Work Session.
//! - `merge`: a Session lands once its work is reported done (its Work Session closes for its
//!   Tag, an operator, or its Objective), and again after a merge follow-up Task succeeds. A
//!   conflict is never resolved here: the landing ends in Conflict and the Session receives a
//!   follow-up Task that merges the target and resolves it.
use crate::{
    ControlPlane, Store, StoreError, policy,
    remote_workspaces::pins::{DELIVERY, delivery},
    store::{Result, invalid, name, next_order, task_in},
};
use prost::Message;
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::{MAX_MESSAGE_BYTES, git_remote, v2::*};
use tonic::{Request, Response, Status};
use uuid::Uuid;

const LEASE_MS: i64 = 60_000;
const DEFAULT_RETRY_MS: i64 = 60_000;
const MIN_RETRY_MS: i64 = 1_000;
const MAX_CONFLICTS: usize = 100;

fn decode(row: &AnyRow) -> Result<WorkspaceLanding> {
    policy::decode(&row.try_get::<Vec<u8>, _>("payload")?)
}

async fn row_in(tx: &mut Transaction<'_, Any>, id: &str) -> Result<AnyRow> {
    sqlx::query("SELECT * FROM supertag_v2_workspace_landings WHERE landing_id=$1")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| StoreError::NotFound("landing was not found".into()))
}

async fn save(tx: &mut Transaction<'_, Any>, value: &WorkspaceLanding) -> Result<()> {
    sqlx::query(
        "UPDATE supertag_v2_workspace_landings SET state=$1,payload=$2 WHERE landing_id=$3",
    )
    .bind(i64::from(value.state))
    .bind(value.encode_to_vec())
    .bind(&value.landing_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// The Tag's name and no-reply address, and the requester as a co-author, for a Task's commits.
pub(crate) async fn author_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
) -> Result<(String, String, String)> {
    let tag_name: Option<String> =
        sqlx::query_scalar("SELECT name FROM supertag_v2_tags WHERE tag_id=$1")
            .bind(&task.tag_id)
            .fetch_optional(&mut **tx)
            .await?
            .flatten();
    // The conversation's person, else whoever submitted this Task or its Session's first one.
    let mut owner = crate::conversations::task_owner_in(tx, &task.task_id)
        .await?
        .unwrap_or_default();
    if owner.is_empty() {
        owner = sqlx::query_scalar("SELECT a.principal FROM supertag_v2_admissions a JOIN supertag_v2_tasks t ON t.task_id=a.task_id WHERE t.tag_id=$1 AND t.session_id=$2 ORDER BY (a.task_id=$3) DESC, t.accepted_order LIMIT 1")
            .bind(&task.tag_id).bind(&task.session_id).bind(&task.task_id)
            .fetch_optional(&mut **tx).await?
            .unwrap_or_default();
    }
    Ok((
        git_remote::author_name(tag_name.as_deref().unwrap_or(&task.tag_id)),
        git_remote::tag_author_email(&task.tag_id),
        git_remote::requester_co_author(&owner),
    ))
}

/// Fills a Task's Workspace commit authorship, which the Control Plane derives and never stores.
pub(crate) async fn with_author_in(tx: &mut Transaction<'_, Any>, task: &mut Task) -> Result<()> {
    if task.workspace.is_none() {
        return Ok(());
    }
    let (name, email, co_author) = author_in(tx, task).await?;
    let spec = task.workspace.as_mut().expect("checked above");
    spec.author_name = name;
    spec.author_email = email;
    spec.co_author = co_author;
    Ok(())
}

async fn insert_in(
    tx: &mut Transaction<'_, Any>,
    task: &Task,
    remote: &Workspace,
    delivery: &WorkspaceDeliveryReference,
    mode: WorkspaceLandingMode,
    target: &str,
) -> Result<()> {
    let (author_name, author_email, co_author) = author_in(tx, task).await?;
    let (title, body) = if mode == WorkspaceLandingMode::Review {
        review_text_in(tx, task).await?
    } else {
        Default::default()
    };
    let value = WorkspaceLanding {
        landing_id: Uuid::new_v4().to_string(),
        task_id: task.task_id.clone(),
        tag_id: task.tag_id.clone(),
        session_id: task.session_id.clone(),
        workspace_id: remote.workspace_id.clone(),
        remote: remote.remote.clone(),
        mode: mode as i32,
        branch: supertag_protocol::session_branch(&task.tag_id, &task.session_id),
        target: target.to_owned(),
        delivery: Some(delivery.clone()),
        state: WorkspaceLandingState::Queued as i32,
        created_order: next_order(tx).await?,
        author_name,
        author_email,
        co_author,
        title,
        body,
        ..Default::default()
    };
    sqlx::query("INSERT INTO supertag_v2_workspace_landings(landing_id,task_id,tag_id,session_id,created_order,state,payload) VALUES($1,$2,$3,$4,$5,$6,$7)")
        .bind(&value.landing_id).bind(&value.task_id).bind(&value.tag_id).bind(&value.session_id)
        .bind(value.created_order).bind(i64::from(value.state)).bind(value.encode_to_vec())
        .execute(&mut **tx).await?;
    Ok(())
}

/// A review landing's pull request title and description: the Work Session's title, else the
/// first line of the Task's prompt, and the Task's result.
async fn review_text_in(tx: &mut Transaction<'_, Any>, task: &Task) -> Result<(String, String)> {
    let session_title: Option<String> = sqlx::query_scalar(
        "SELECT title FROM supertag_v2_work_sessions WHERE work_session_id=$1 AND tag_id=$2",
    )
    .bind(&task.session_id)
    .bind(&task.tag_id)
    .fetch_optional(&mut **tx)
    .await?;
    let title = session_title
        .filter(|title| !title.trim().is_empty())
        .or_else(|| {
            task.prompt
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "Workspace update".into())
        .chars()
        .filter(|c| !c.is_control())
        .take(120)
        .collect::<String>();
    let body = format!(
        "{}\n\nSuperTag Session {} of Tag {}, Task {}.",
        task.result.as_deref().unwrap_or("").trim(),
        task.session_id,
        task.tag_id,
        task.task_id
    )
    .trim()
    .chars()
    .take(16_000)
    .collect::<String>();
    Ok((title, body))
}

/// Called once inside Finish after the Workspace receipt was validated.
pub(crate) async fn finish_in(tx: &mut Transaction<'_, Any>, task: &Task) -> Result<()> {
    let Some(delivery) = task
        .workspace_delivery
        .as_ref()
        .filter(|delivery| delivery.committed && delivery.head_commit != delivery.base_commit)
    else {
        return Ok(());
    };
    let Some(spec) = &task.workspace else {
        return Ok(());
    };
    let Some(remote) = &spec.remote else {
        return Ok(());
    };
    let mode = remote.land.as_ref().and_then(|land| land.mode.as_ref());
    match mode {
        Some(workspace_land::Mode::Branch(_) | workspace_land::Mode::Review(_)) => {
            let (mode, target) = match mode {
                Some(workspace_land::Mode::Review(review)) => {
                    (WorkspaceLandingMode::Review, review.base.as_str())
                }
                _ => (WorkspaceLandingMode::Branch, ""),
            };
            // A newer delivery contains the older one: an unclaimed landing of it is superseded.
            let pending = sqlx::query("SELECT * FROM supertag_v2_workspace_landings WHERE tag_id=$1 AND session_id=$2 AND state=$3 AND lease_token IS NULL")
                .bind(&task.tag_id).bind(&task.session_id).bind(WorkspaceLandingState::Queued as i64)
                .fetch_all(&mut **tx).await?;
            for row in pending {
                let mut prior = decode(&row)?;
                if prior.mode() == mode {
                    prior.state = WorkspaceLandingState::Superseded as i32;
                    prior.reason = format!("Task {} delivered a newer commit", task.task_id);
                    save(tx, &prior).await?;
                }
            }
            insert_in(tx, task, remote, delivery, mode, target).await
        }
        // A merge follow-up resolved its conflicts: the Session lands again at once.
        Some(workspace_land::Mode::Merge(merge)) if !spec.merge_commit.is_empty() => {
            insert_in(
                tx,
                task,
                remote,
                delivery,
                WorkspaceLandingMode::Merge,
                &merge.target,
            )
            .await
        }
        // A turn that finishes after its Work Session was reported done lands it then.
        Some(workspace_land::Mode::Merge(_)) => {
            let done: Option<i64> = sqlx::query_scalar("SELECT close_reason FROM supertag_v2_work_sessions WHERE work_session_id=$1 AND closed_at_ms IS NOT NULL")
                .bind(&task.session_id).fetch_optional(&mut **tx).await?;
            if done.is_some_and(|reason| {
                [
                    WorkSessionCloseReason::Tag,
                    WorkSessionCloseReason::Operator,
                    WorkSessionCloseReason::ObjectiveClosed,
                ]
                .iter()
                .any(|done| *done as i64 == reason)
            }) {
                session_done_in(tx, &task.session_id).await?;
            }
            Ok(())
        }
        None => Ok(()),
    }
}

/// A Work Session's work was reported done: in `merge` mode its latest delivery lands.
pub(crate) async fn session_done_in(
    tx: &mut Transaction<'_, Any>,
    work_session_id: &str,
) -> Result<()> {
    let tag: Option<String> =
        sqlx::query_scalar("SELECT tag_id FROM supertag_v2_work_sessions WHERE work_session_id=$1")
            .bind(work_session_id)
            .fetch_optional(&mut **tx)
            .await?;
    let Some(tag) = tag else {
        return Ok(());
    };
    let head: Option<String> = sqlx::query_scalar("SELECT d.task_id FROM supertag_v2_workspace_heads h JOIN supertag_v2_workspace_deliveries d ON d.attempt_id=h.attempt_id WHERE h.tag_id=$1 AND h.session_id=$2 AND d.committed_at_ms IS NOT NULL")
        .bind(&tag).bind(work_session_id).fetch_optional(&mut **tx).await?;
    let Some(head) = head else {
        return Ok(());
    };
    let task = task_in(tx, &head).await?;
    let (Some(delivery), Some(remote)) = (
        task.workspace_delivery.as_ref(),
        task.workspace
            .as_ref()
            .and_then(|spec| spec.remote.as_ref()),
    ) else {
        return Ok(());
    };
    let Some(workspace_land::Mode::Merge(merge)) =
        remote.land.as_ref().and_then(|land| land.mode.as_ref())
    else {
        return Ok(());
    };
    if task.state() != TaskState::Succeeded || delivery.head_commit == delivery.base_commit {
        return Ok(());
    }
    // Closing twice, or after the same delivery already landed or is landing, changes nothing.
    let rows = sqlx::query("SELECT payload,state FROM supertag_v2_workspace_landings WHERE tag_id=$1 AND session_id=$2 AND state IN (1,2,3)")
        .bind(&task.tag_id).bind(&task.session_id).fetch_all(&mut **tx).await?;
    for row in rows {
        if decode(&row)?.delivery.as_ref() == Some(delivery) {
            return Ok(());
        }
    }
    insert_in(
        tx,
        &task,
        remote,
        delivery,
        WorkspaceLandingMode::Merge,
        &merge.target,
    )
    .await
}

/// Records the pull request a review landing opened for its Session, after checking it is one
/// SuperTag can show and match: `WEB/OWNER/NAME/pull/NUMBER` on the Workspace's own repository.
async fn review_session_in(
    tx: &mut Transaction<'_, Any>,
    landing: &WorkspaceLanding,
    pull_request: &WorkspacePullRequest,
) -> Result<()> {
    let github = git_remote::github_remote(&landing.remote);
    let valid = github.as_ref().is_some_and(|github| {
        pull_request
            .repository
            .eq_ignore_ascii_case(&github.repository)
            && pull_request.url
                == format!(
                    "{}/{}/pull/{}",
                    github.web, github.repository, pull_request.number
                )
    }) && [pull_request.repository_id, pull_request.number]
        .iter()
        .all(|id| *id > 0 && *id <= i64::MAX as u64);
    if !valid {
        return Err(invalid(
            "a pull request names the Workspace's repository, its number, and its link",
        ));
    }
    // A Session reviews in one pull request; a later one replaces the record.
    sqlx::query("INSERT INTO supertag_v2_workspace_review_sessions(tag_id,session_id,repository,repository_id,number) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tag_id,session_id) DO UPDATE SET repository=excluded.repository,repository_id=excluded.repository_id,number=excluded.number")
        .bind(&landing.tag_id).bind(&landing.session_id).bind(pull_request.repository.to_ascii_lowercase())
        .bind(pull_request.repository_id as i64).bind(pull_request.number as i64)
        .execute(&mut **tx).await?;
    Ok(())
}

/// Landings queued while their holding Worker Host was away retry once it reports Ready.
pub(crate) async fn wake_held_by_in(
    tx: &mut Transaction<'_, Any>,
    host_id: &str,
    now: i64,
) -> Result<()> {
    sqlx::query(
        "UPDATE supertag_v2_workspace_landings SET retry_after_ms=$1 WHERE state=$2 AND retry_after_ms>$1
         AND EXISTS (SELECT 1 FROM supertag_v2_workspace_deliveries d
         WHERE d.task_id=supertag_v2_workspace_landings.task_id AND d.holder_host_id=$3 AND d.committed_at_ms IS NOT NULL)",
    )
    .bind(now)
    .bind(WorkspaceLandingState::Queued as i64)
    .bind(host_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// The merge follow-up: a new Task in the conflicting Session whose Worker Host starts the merge
/// of `target_commit`, leaving conflict markers for the Tag to resolve. Returns its ID, or why
/// none was created.
async fn follow_up_in(
    tx: &mut Transaction<'_, Any>,
    value: &WorkspaceLanding,
) -> Result<std::result::Result<String, String>> {
    let source = task_in(tx, &value.task_id).await?;
    let scope = sqlx::query(
        "SELECT k.work_session_id,k.starter_task_id,w.objective_id FROM supertag_v2_work_session_tasks k
         JOIN supertag_v2_work_sessions w ON w.work_session_id=k.work_session_id WHERE k.task_id=$1 AND k.kind=1",
    )
    .bind(&source.task_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(scope) = scope else {
        return Ok(Err("the Session is not a Work Session".into()));
    };
    let session: String = scope.try_get("work_session_id")?;
    let starter_id: Option<String> = scope.try_get("starter_task_id")?;
    let objective: Option<String> = scope.try_get("objective_id")?;
    let starter = match &starter_id {
        Some(id) => task_in(tx, id).await?,
        None => source.clone(),
    };
    let limits = match crate::budget_pool::child_in(
        tx,
        &starter,
        objective.as_deref(),
        source.execution_limits.as_ref(),
    )
    .await
    {
        Ok(limits) => limits,
        Err(StoreError::FailedPrecondition(reason)) => return Ok(Err(reason)),
        Err(error) => return Err(error),
    };
    let listed = value
        .conflicts
        .iter()
        .map(|path| format!("- {path}"))
        .collect::<Vec<_>>()
        .join("\n");
    let prompt = format!(
        "Your Session's changes conflict with the branch {target} on the Workspace's remote, so they were not merged.\n\n\
         The merge of {target} (commit {commit}) into your work has been started in your checkout. These files have conflict markers:\n{listed}\n\n\
         Resolve every conflict, keeping both sides' intent; never discard the other branch's changes to make the merge pass. \
         Remove all conflict markers. When you finish, your work is merged into {target} again.",
        target = value.target,
        commit = value.target_commit,
    );
    let order = next_order(tx).await?;
    let mut next =
        crate::store::insert_task_from_snapshot(tx, order, &source, &source.session_id, &prompt)
            .await?;
    crate::budget_pool::set_in(tx, &mut next, limits).await?;
    sqlx::query("UPDATE supertag_v2_tasks SET workspace_merge_commit=$1 WHERE task_id=$2")
        .bind(&value.target_commit)
        .bind(&next.task_id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("INSERT INTO supertag_v2_work_session_tasks (task_id,work_session_id,kind,starter_task_id) VALUES ($1,$2,1,$3)")
        .bind(&next.task_id).bind(&session).bind(&starter_id).execute(&mut **tx).await?;
    if let Some(id) = objective {
        sqlx::query("INSERT INTO supertag_v2_objective_tasks (task_id,objective_id,kind) VALUES ($1,$2,'work')").bind(&next.task_id).bind(id).execute(&mut **tx).await?;
    }
    sqlx::query("UPDATE supertag_v2_work_sessions SET latest_task_id=$1 WHERE work_session_id=$2")
        .bind(&next.task_id)
        .bind(&session)
        .execute(&mut **tx)
        .await?;
    Ok(Ok(next.task_id))
}

async fn operation_in<T: Message>(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    operation: &str,
    kind: &str,
    input: &T,
) -> Result<(String, Option<Vec<u8>>)> {
    name("landing operation", operation)?;
    let digest = policy::digest(kind, input);
    let row = sqlx::query("SELECT request_digest,response FROM supertag_v2_workspace_landing_operations WHERE principal=$1 AND operation_id=$2")
        .bind(principal).bind(operation).fetch_optional(&mut **tx).await?;
    if let Some(row) = row {
        if row.try_get::<String, _>("request_digest")? != digest {
            return Err(StoreError::Conflict(
                "landing operation changed its request".into(),
            ));
        }
        return Ok((digest, Some(row.try_get("response")?)));
    }
    Ok((digest, None))
}

async fn receipt_in(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    operation: &str,
    digest: &str,
    response: &impl Message,
) -> Result<()> {
    sqlx::query("INSERT INTO supertag_v2_workspace_landing_operations(principal,operation_id,request_digest,response) VALUES($1,$2,$3,$4)")
        .bind(principal).bind(operation).bind(digest).bind(response.encode_to_vec()).execute(&mut **tx).await?;
    Ok(())
}

async fn claim_response_in(
    tx: &mut Transaction<'_, Any>,
    value: WorkspaceLanding,
    token: String,
    valid_for_ms: u64,
) -> Result<ClaimWorkspaceLandingResponse> {
    let task = task_in(tx, &value.task_id).await?;
    let credential = task
        .workspace
        .as_ref()
        .and_then(|spec| spec.remote.as_ref())
        .and_then(|remote| remote.credentials.as_ref())
        .map(|names| names.push.clone())
        .unwrap_or_default();
    let holder = match &value.delivery {
        Some(delivery) => crate::workspaces::delivery_holder_in(tx, delivery)
            .await
            .ok(),
        None => None,
    };
    Ok(ClaimWorkspaceLandingResponse {
        landing: Some(value),
        lease_token: token,
        valid_for_ms,
        holder,
        credential,
    })
}

async fn owned_in(
    tx: &mut Transaction<'_, Any>,
    lease: &WorkspaceLandingLease,
    now: i64,
) -> Result<WorkspaceLanding> {
    let row = row_in(tx, &lease.landing_id).await?;
    if row.try_get::<Option<String>, _>("lease_token")?.as_deref() != Some(&lease.lease_token)
        || row
            .try_get::<Option<i64>, _>("lease_expires_at_ms")?
            .is_none_or(|until| until <= now)
        || row.try_get::<i64, _>("state")? != WorkspaceLandingState::Claimed as i64
    {
        return Err(StoreError::FailedPrecondition(
            "landing lease is no longer live".into(),
        ));
    }
    decode(&row)
}

impl Store {
    pub async fn claim_workspace_landing(
        &self,
        principal: &str,
        input: &ClaimWorkspaceLandingRequest,
    ) -> Result<ClaimWorkspaceLandingResponse> {
        delivery(principal)?;
        let (mut tx, _) = self.write().await?;
        let (digest, prior) =
            operation_in(&mut tx, principal, &input.operation_id, "claim", input).await?;
        if let Some(prior) = prior {
            tx.commit().await?;
            return policy::decode(&prior);
        }
        let now = self.execution_now_ms();
        // One landing per Session at a time, oldest first; an expired claim is claimable again.
        let row = sqlx::query(
            "SELECT l.* FROM supertag_v2_workspace_landings l
             WHERE ((l.state=1 AND l.retry_after_ms<=$1) OR (l.state=2 AND l.lease_expires_at_ms<=$1))
               AND NOT EXISTS (SELECT 1 FROM supertag_v2_workspace_landings older
                   WHERE older.tag_id=l.tag_id AND older.session_id=l.session_id
                     AND older.created_order<l.created_order AND older.state IN (1,2))
             ORDER BY l.created_order LIMIT 1",
        )
        .bind(now)
        .fetch_optional(&mut *tx)
        .await?;
        let response = match row {
            None => ClaimWorkspaceLandingResponse::default(),
            Some(row) => {
                let mut value = decode(&row)?;
                value.state = WorkspaceLandingState::Claimed as i32;
                let token = Uuid::new_v4().to_string();
                save(&mut tx, &value).await?;
                sqlx::query("UPDATE supertag_v2_workspace_landings SET lease_token=$1,lease_expires_at_ms=$2 WHERE landing_id=$3")
                    .bind(&token).bind(now.saturating_add(LEASE_MS)).bind(&value.landing_id).execute(&mut *tx).await?;
                claim_response_in(&mut tx, value, token, LEASE_MS as u64).await?
            }
        };
        receipt_in(&mut tx, principal, &input.operation_id, &digest, &response).await?;
        tx.commit().await?;
        Ok(response)
    }

    pub async fn renew_workspace_landing(
        &self,
        principal: &str,
        input: &WorkspaceLandingLease,
    ) -> Result<ClaimWorkspaceLandingResponse> {
        delivery(principal)?;
        let (mut tx, _) = self.write().await?;
        let now = self.execution_now_ms();
        let value = owned_in(&mut tx, input, now).await?;
        sqlx::query(
            "UPDATE supertag_v2_workspace_landings SET lease_expires_at_ms=$1 WHERE landing_id=$2",
        )
        .bind(now.saturating_add(LEASE_MS))
        .bind(&value.landing_id)
        .execute(&mut *tx)
        .await?;
        let response =
            claim_response_in(&mut tx, value, input.lease_token.clone(), LEASE_MS as u64).await?;
        tx.commit().await?;
        Ok(response)
    }

    pub async fn record_workspace_landing(
        &self,
        principal: &str,
        input: &RecordWorkspaceLandingRequest,
    ) -> Result<WorkspaceLanding> {
        delivery(principal)?;
        let lease = input
            .lease
            .as_ref()
            .ok_or_else(|| invalid("landing lease required"))?;
        if input.reason.len() > 2000 || input.conflicts.len() > MAX_CONFLICTS {
            return Err(invalid("landing record exceeds its limits"));
        }
        let (mut tx, _) = self.write().await?;
        let (digest, prior) =
            operation_in(&mut tx, principal, &input.operation_id, "record", input).await?;
        if let Some(prior) = prior {
            tx.commit().await?;
            return policy::decode(&prior);
        }
        let now = self.execution_now_ms();
        let mut value = owned_in(&mut tx, lease, now).await?;
        let desired = WorkspaceLandingState::try_from(input.state)
            .map_err(|_| invalid("unknown landing state"))?;
        let mut retry_after = 0;
        value.reason = input.reason.trim().to_owned();
        match desired {
            WorkspaceLandingState::Queued => {
                if input.reason.trim().is_empty() {
                    return Err(invalid("a landing put back in the queue needs a reason"));
                }
                let wait = if input.retry_after_ms == 0 {
                    DEFAULT_RETRY_MS
                } else {
                    i64::try_from(input.retry_after_ms)
                        .unwrap_or(DEFAULT_RETRY_MS)
                        .clamp(MIN_RETRY_MS, 3_600_000)
                };
                retry_after = now.saturating_add(wait);
            }
            WorkspaceLandingState::Landed => {
                if !supertag_protocol::valid_git_commit(&input.landed_commit) {
                    return Err(invalid("a landing records the commit the remote now names"));
                }
                value.landed_commit = input.landed_commit.clone();
                match (value.mode(), &input.pull_request) {
                    (WorkspaceLandingMode::Review, Some(pull_request)) => {
                        review_session_in(&mut tx, &value, pull_request).await?;
                        value.pull_request = Some(pull_request.clone());
                    }
                    (WorkspaceLandingMode::Review, None) => {
                        return Err(invalid(
                            "a review landing records the pull request it opened",
                        ));
                    }
                    (_, Some(_)) => {
                        return Err(invalid("only a review landing opens a pull request"));
                    }
                    (_, None) => {}
                }
            }
            WorkspaceLandingState::Conflict => {
                if value.mode() != WorkspaceLandingMode::Merge
                    || !supertag_protocol::valid_git_commit(&input.target_commit)
                    || input.conflicts.is_empty()
                {
                    return Err(invalid(
                        "a conflict names the merge target's commit and the conflicting paths",
                    ));
                }
                value.target_commit = input.target_commit.clone();
                value.conflicts = input
                    .conflicts
                    .iter()
                    .map(|path| {
                        path.chars()
                            .filter(|c| !c.is_control())
                            .take(1024)
                            .collect()
                    })
                    .collect();
                match follow_up_in(&mut tx, &value).await? {
                    Ok(task) => value.follow_up_task_id = Some(task),
                    Err(reason) => {
                        value.reason =
                            format!("{}; no follow-up Task was started: {reason}", value.reason);
                    }
                }
            }
            WorkspaceLandingState::Held => {
                if input.reason.trim().is_empty() {
                    return Err(invalid("a held landing needs a reason"));
                }
            }
            _ => return Err(invalid("invalid landing settlement state")),
        }
        value.state = desired as i32;
        save(&mut tx, &value).await?;
        sqlx::query("UPDATE supertag_v2_workspace_landings SET lease_token=NULL,lease_expires_at_ms=NULL,retry_after_ms=$1 WHERE landing_id=$2")
            .bind(retry_after).bind(&value.landing_id).execute(&mut *tx).await?;
        receipt_in(&mut tx, principal, &input.operation_id, &digest, &value).await?;
        tx.commit().await?;
        Ok(value)
    }

    /// A local Workspace's merge conflicted in the operator's repository: the Session gets the
    /// same merge follow-up a remote Workspace's conflict gives it.
    pub async fn return_landing_conflict(
        &self,
        principal: &str,
        input: &ReturnLandingConflictRequest,
    ) -> Result<Task> {
        policy::operator(principal)?;
        name("operation ID", &input.operation_id)?;
        name("Tag ID", &input.tag_id)?;
        name("Session ID", &input.session_id)?;
        if !git_remote::valid_merge_target(&input.target)
            || !supertag_protocol::valid_git_commit(&input.target_commit)
            || input.conflicts.is_empty()
            || input.conflicts.len() > MAX_CONFLICTS
        {
            return Err(invalid(
                "a conflict names the merge target, its commit, and the conflicting paths",
            ));
        }
        let digest = policy::digest("return-landing-conflict", input);
        let (mut tx, _) = self.write().await?;
        if let Some(prior) =
            policy::replay::<Task>(&mut tx, principal, &input.operation_id, &digest).await?
        {
            return Ok(prior);
        }
        let head: Option<String> = sqlx::query_scalar("SELECT d.task_id FROM supertag_v2_workspace_heads h JOIN supertag_v2_workspace_deliveries d ON d.attempt_id=h.attempt_id WHERE h.tag_id=$1 AND h.session_id=$2 AND d.committed_at_ms IS NOT NULL")
            .bind(&input.tag_id).bind(&input.session_id).fetch_optional(&mut *tx).await?;
        let head = head.ok_or_else(|| {
            StoreError::NotFound("the Session has no delivered Workspace commits".into())
        })?;
        if !crate::conversations::task_access_in(&mut tx, principal, &head).await? {
            return Err(StoreError::NotFound(
                "the Session has no delivered Workspace commits".into(),
            ));
        }
        let value = WorkspaceLanding {
            task_id: head,
            target: input.target.clone(),
            target_commit: input.target_commit.clone(),
            conflicts: input.conflicts.clone(),
            ..Default::default()
        };
        let task = match follow_up_in(&mut tx, &value).await? {
            Ok(task) => task_in(&mut tx, &task).await?,
            Err(reason) => {
                return Err(StoreError::FailedPrecondition(format!(
                    "no follow-up Task was started: {reason}"
                )));
            }
        };
        policy::receipt(&mut tx, principal, &input.operation_id, &digest, &task).await?;
        tx.commit().await?;
        Ok(task)
    }

    pub async fn get_workspace_landing(
        &self,
        principal: &str,
        input: &GetWorkspaceLandingRequest,
    ) -> Result<WorkspaceLanding> {
        policy::operator(principal)?;
        let mut tx = self.pool.begin().await?;
        let value = decode(&row_in(&mut tx, &input.landing_id).await?)?;
        if !crate::conversations::task_access_in(&mut tx, principal, &value.task_id).await? {
            return Err(StoreError::NotFound("landing was not found".into()));
        }
        Ok(value)
    }

    pub async fn list_workspace_landings(
        &self,
        principal: &str,
        input: &ListWorkspaceLandingsRequest,
    ) -> Result<ListWorkspaceLandingsResponse> {
        policy::operator(principal)?;
        if input.limit > 100 || input.before_order < 0 {
            return Err(invalid("invalid landing page"));
        }
        let limit = if input.limit == 0 { 50 } else { input.limit } as usize;
        let mut tx = self.pool.begin().await?;
        let rows = sqlx::query(&format!("SELECT l.* FROM supertag_v2_workspace_landings l WHERE ($1='' OR l.task_id=$1) AND ($5='' OR l.session_id=$5) AND ($2=0 OR l.created_order<$2) AND EXISTS(SELECT 1 FROM supertag_v2_task_audience a WHERE a.task_id=l.task_id AND {}) ORDER BY l.created_order DESC LIMIT $4", crate::store::sees_owner_sql("a.owner", "$3")))
            .bind(&input.task_id).bind(input.before_order).bind(principal).bind((limit+1) as i64).bind(&input.session_id).fetch_all(&mut *tx).await?;
        let mut bytes = 0;
        let mut response = ListWorkspaceLandingsResponse::default();
        for row in rows {
            let value = decode(&row)?;
            bytes += value.encoded_len() + 16;
            if response.landings.len() == limit || bytes > MAX_MESSAGE_BYTES - 1024 {
                response.next_before_order = response
                    .landings
                    .last()
                    .map_or(0, |last| last.created_order);
                break;
            }
            response.landings.push(value);
        }
        Ok(response)
    }
}

impl ControlPlane {
    pub fn workspace_landings_service(
        &self,
    ) -> workspace_landings_server::WorkspaceLandingsServer<Self> {
        workspace_landings_server::WorkspaceLandingsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn git_delivery_service(&self) -> git_delivery_server::GitDeliveryServer<Self> {
        git_delivery_server::GitDeliveryServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl workspace_landings_server::WorkspaceLandings for ControlPlane {
    async fn get(
        &self,
        request: Request<GetWorkspaceLandingRequest>,
    ) -> std::result::Result<Response<WorkspaceLanding>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .get_workspace_landing(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn list(
        &self,
        request: Request<ListWorkspaceLandingsRequest>,
    ) -> std::result::Result<Response<ListWorkspaceLandingsResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_workspace_landings(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn return_conflict(
        &self,
        request: Request<ReturnLandingConflictRequest>,
    ) -> std::result::Result<Response<Task>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .return_landing_conflict(&principal, request.get_ref())
                .await?,
        ))
    }
}

#[tonic::async_trait]
impl git_delivery_server::GitDelivery for ControlPlane {
    async fn list_pending_sources(
        &self,
        request: Request<ListPendingWorkspaceSourcesRequest>,
    ) -> std::result::Result<Response<ListPendingWorkspaceSourcesResponse>, Status> {
        let principal = self.principal(&request, "delivery:")?;
        Ok(Response::new(
            self.store
                .list_pending_workspace_sources(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn pin_source(
        &self,
        request: Request<PinWorkspaceSourceRequest>,
    ) -> std::result::Result<Response<WorkspaceSourcePin>, Status> {
        let principal = self.principal(&request, "delivery:")?;
        Ok(Response::new(
            self.store
                .pin_workspace_source(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn claim(
        &self,
        request: Request<ClaimWorkspaceLandingRequest>,
    ) -> std::result::Result<Response<ClaimWorkspaceLandingResponse>, Status> {
        let principal = self.principal(&request, "delivery:")?;
        Ok(Response::new(
            self.store
                .claim_workspace_landing(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn renew(
        &self,
        request: Request<WorkspaceLandingLease>,
    ) -> std::result::Result<Response<ClaimWorkspaceLandingResponse>, Status> {
        let principal = self.principal(&request, "delivery:")?;
        Ok(Response::new(
            self.store
                .renew_workspace_landing(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn record(
        &self,
        request: Request<RecordWorkspaceLandingRequest>,
    ) -> std::result::Result<Response<WorkspaceLanding>, Status> {
        let principal = self.principal(&request, "delivery:")?;
        Ok(Response::new(
            self.store
                .record_workspace_landing(&principal, request.get_ref())
                .await?,
        ))
    }
}

/// The principal git delivery calls the state owner with.
pub const GIT_DELIVERY_PRINCIPAL: &str = DELIVERY;
