//! Worker Host labels and Tag `runsOn` placement.
//!
//! A Tag's bound hosts decide who may run its Tasks. Labels only narrow that
//! pool: a host is eligible when it carries every label in the Tag's `runsOn`.
//! Labels are self-reported placement hints and never grant access.

use std::collections::{BTreeMap, BTreeSet};

use sqlx::{Any, Transaction};
use supertag_protocol::v2::*;
use tonic::{Request, Response, Status};

use crate::{
    ControlPlane, Store,
    store::{Result, invalid, name},
};

pub(crate) const MAX_LABELS: usize = 64;

/// Where a label list came from. Each source reserves different prefixes.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum LabelField {
    /// Labels a Worker Host reports: operating system, architecture, declared.
    Reported,
    /// Labels an Auth Key grants to the hosts that join with it.
    AuthKey,
    /// A Tag's `runsOn`, which may require `mcp:NAME`.
    RunsOn,
}

impl LabelField {
    fn noun(self) -> &'static str {
        match self {
            Self::Reported => "Worker Host labels",
            Self::AuthKey => "Auth Key labels",
            Self::RunsOn => "Tag runsOn",
        }
    }
}

/// Lowercases and validates one label: 1-63 lowercase letters, digits, dots,
/// colons, hyphens or underscores, starting with a letter or digit.
pub(crate) fn parse_label(value: &str) -> Result<String> {
    let label = value.trim().to_ascii_lowercase();
    let bytes = label.as_bytes();
    let valid = !bytes.is_empty()
        && bytes.len() <= 63
        && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b".:_-".contains(byte)
        });
    if !valid || !value.is_ascii() {
        return Err(invalid(&format!(
            "label {value:?} is invalid: a label is 1-63 lowercase letters, digits, dots, colons, hyphens, or underscores, starting with a letter or digit"
        )));
    }
    Ok(label)
}

/// Normalizes a label list to sorted, unique labels and rejects reserved prefixes.
pub(crate) fn parse_labels(values: &[String], field: LabelField) -> Result<Vec<String>> {
    let mut labels = BTreeSet::new();
    for value in values {
        labels.insert(parse_label(value)?);
    }
    for label in &labels {
        let reserved = if field != LabelField::RunsOn && label.starts_with("mcp:") {
            Some("mcp: labels come from host service configuration")
        } else if label.starts_with("volume-credential:") || label.starts_with("volume:") {
            Some("Volume labels come from host service configuration")
        } else if label.starts_with("mcp-login:") {
            Some("mcp-login: labels come from host MCP logins")
        } else {
            None
        };
        if let Some(reason) = reserved {
            return Err(invalid(&format!("{}: {reason}", field.noun())));
        }
    }
    if labels.len() > MAX_LABELS {
        return Err(invalid(&format!(
            "{} may list at most {MAX_LABELS} labels",
            field.noun()
        )));
    }
    Ok(labels.into_iter().collect())
}

pub(crate) fn harness_label(harness: HarnessKind) -> Option<&'static str> {
    match harness {
        HarnessKind::Unspecified => None,
        HarnessKind::Codex => Some("harness:codex"),
        HarnessKind::ClaudeCode => Some("harness:claude-code"),
        HarnessKind::OpenaiAgents => Some("harness:openai-agents"),
        HarnessKind::Opencode => Some("harness:opencode"),
        HarnessKind::Cursor => Some("harness:cursor"),
    }
}

pub(crate) fn harness_name(harness: HarnessKind) -> &'static str {
    match harness {
        HarnessKind::Unspecified => "A custom harness",
        HarnessKind::Codex => "Codex",
        HarnessKind::ClaudeCode => "Claude Code",
        HarnessKind::OpenaiAgents => "OpenAI Agents",
        HarnessKind::Opencode => "OpenCode",
        HarnessKind::Cursor => "Cursor",
    }
}

/// Why `harness` cannot enforce these execution limits, or `None` when it can. Each built-in
/// harness enforces only some limits, and a lane never claims a Task whose limits it would
/// weaken. Custom harnesses confirm the applied limits on the local bridge before running.
pub(crate) fn unsupported_execution_limits(
    harness: HarnessKind,
    limits: &ExecutionLimits,
) -> Option<String> {
    let tokens = limits.max_reported_tokens.is_some();
    let cost = limits.max_reported_cost.as_ref();
    let agents = limits.max_native_agents;
    let (unsupported, supported): (Vec<&str>, &str) = match harness {
        HarnessKind::Unspecified => return None,
        HarnessKind::Codex => (
            [
                cost.map(|_| "a reported cost limit"),
                agents
                    .filter(|limit| *limit != 0)
                    .map(|_| "a native agent limit above 0"),
            ]
            .into_iter()
            .flatten()
            .collect(),
            "a reported token limit and a native agent limit of 0",
        ),
        HarnessKind::ClaudeCode => (
            [
                tokens.then_some("a reported token limit"),
                agents.map(|_| "a native agent limit"),
                cost.filter(|limit| limit.currency != "USD")
                    .map(|_| "a reported cost limit outside USD"),
            ]
            .into_iter()
            .flatten()
            .collect(),
            "only a reported cost limit in USD",
        ),
        HarnessKind::OpenaiAgents | HarnessKind::Opencode | HarnessKind::Cursor => (
            [
                tokens.then_some("a reported token limit"),
                cost.map(|_| "a reported cost limit"),
                agents.map(|_| "a native agent limit"),
            ]
            .into_iter()
            .flatten()
            .collect(),
            "no execution limits",
        ),
    };
    (!unsupported.is_empty()).then(|| {
        format!(
            "{} cannot enforce {}; it supports {supported}",
            harness_name(harness),
            unsupported.join(" or ")
        )
    })
}

/// Drops the reported token and cost limits `harness` cannot enforce, keeping the rest.
pub(crate) fn enforceable_reported_limits(
    harness: HarnessKind,
    mut limits: ExecutionLimits,
) -> ExecutionLimits {
    let unenforced = |only: ExecutionLimits| unsupported_execution_limits(harness, &only).is_some();
    if limits.max_reported_tokens.is_some()
        && unenforced(ExecutionLimits {
            max_reported_tokens: limits.max_reported_tokens,
            ..Default::default()
        })
    {
        limits.max_reported_tokens = None;
    }
    if limits.max_reported_cost.is_some()
        && unenforced(ExecutionLimits {
            max_reported_cost: limits.max_reported_cost.clone(),
            ..Default::default()
        })
    {
        limits.max_reported_cost = None;
    }
    limits
}

/// Runtime actions the Cursor bridge exposes through its scoped tools.
const CURSOR_ACTIONS: &[&str] = &[
    "files:read",
    "files:write",
    "commands:execute",
    "web:search",
    "workstream:post",
    "mailbox:send",
    "schedule:create",
];

/// Why `harness` cannot run a Task with these accepted actions, or `None` when it can. Cursor's
/// local SDK bridge exposes only scoped tools; work needing another native capability stays
/// queued instead of being claimed with weakened policy.
pub(crate) fn unsupported_runtime_actions(
    harness: HarnessKind,
    actions: &[String],
) -> Option<String> {
    if harness != HarnessKind::Cursor {
        return None;
    }
    let unsupported: Vec<&str> = actions
        .iter()
        .map(String::as_str)
        .filter(|action| !CURSOR_ACTIONS.contains(action))
        .collect();
    if !unsupported.is_empty() {
        return Some(format!(
            "Cursor cannot run accepted actions: {}",
            unsupported.join(", ")
        ));
    }
    let has = |name: &str| actions.iter().any(|action| action == name);
    (has("commands:execute") && !has("files:write"))
        .then(|| "Cursor commands:execute also requires files:write".to_owned())
}

/// What keeps the Task's own harness from claiming it, as `(requirement, summary)`.
/// Why no eligible Worker Host takes a queued Task now, when none of them has a free slot for
/// its harness: `harness` when none runs it, else `capacity`, naming each host's state and every
/// uncertain Attempt that keeps a slot with the command that frees it.
fn waiting_for_capacity(
    harness: HarnessKind,
    hosts: &[WorkerHostStatus],
) -> Option<(String, String)> {
    // A Task without a harness runs on any; its hosts' whole capacity counts.
    let any = harness == HarnessKind::Unspecified;
    let kind = if any {
        String::new()
    } else {
        format!("{} ", harness_name(harness))
    };
    let total = |host: &WorkerHostStatus| HostHarnessCapacity {
        harness_kind: host.harness_kind,
        capacity: host.capacity,
        available_slots: host.available_slots,
        ..Default::default()
    };
    // A host that reports one harness may name it only in its own fields.
    let serving: Vec<(&WorkerHostStatus, HostHarnessCapacity)> = hosts
        .iter()
        .filter_map(|host| {
            if any {
                return Some((host, total(host)));
            }
            let capacity = host
                .harnesses
                .iter()
                .find(|capacity| capacity.harness_kind() == harness)
                .cloned()
                .or_else(|| {
                    (host.harnesses.is_empty() && host.harness_kind() == harness)
                        .then(|| total(host))
                })?;
            Some((host, capacity))
        })
        .collect();
    if serving.is_empty() {
        // A host that has not reported yet names no harness; that is not a mismatch.
        let reported = hosts.iter().any(|host| {
            host.harness_kind() != HarnessKind::Unspecified || !host.harnesses.is_empty()
        });
        return reported.then(|| {
            (
                "harness".to_owned(),
                format!(
                    "Waiting: no eligible Worker Host runs {}",
                    harness_name(harness)
                ),
            )
        });
    }
    if serving
        .iter()
        .any(|(host, capacity)| host.phase() == HostPhase::Ready && capacity.available_slots > 0)
    {
        return None;
    }
    let reasons: Vec<String> = serving
        .iter()
        .map(|(host, capacity)| {
            let held: Vec<&HostUncertainAttempt> = host
                .uncertain_attempts
                .iter()
                .filter(|attempt| any || attempt.harness_kind() == harness)
                .collect();
            let id = &host.host_id;
            if let Some(first) = held.first() {
                let slots = if capacity.capacity <= 1 {
                    format!("Worker Host {id}'s only {kind}slot is")
                } else {
                    format!(
                        "{} of Worker Host {id}'s {} {kind}slots are",
                        held.len(),
                        capacity.capacity
                    )
                };
                let decision = if first.cancelled { "failed" } else { "retry" };
                let confirm = if first.cleanup_observed {
                    ""
                } else {
                    " --confirmed-stopped"
                };
                return format!(
                    "{slots} held by an uncertain Task Attempt that may have executed. Once you confirm its execution stopped: supertag task resolve-attempt {} {} --decision {decision} --evidence TEXT{confirm}",
                    first.task_id, first.attempt_id
                );
            }
            match host.phase() {
                HostPhase::Offline => format!("Worker Host {id} is offline"),
                HostPhase::Draining => format!("Worker Host {id} is draining"),
                HostPhase::Pending => format!("Worker Host {id} has not reported readiness"),
                HostPhase::Suppressed
                    if host.reason() == HostReadinessReason::RecoveryRequired =>
                {
                    format!(
                        "Worker Host {id} needs an operator's recovery decision before it claims work"
                    )
                }
                HostPhase::Suppressed => format!("Worker Host {id} is not claiming work"),
                _ => {
                    // The harnesses share the host's pool: it is full, or this harness is at its
                    // own limit within it.
                    let (capacity, kind) = if host.available_slots == 0 {
                        (total(host), "")
                    } else {
                        (capacity.clone(), kind.as_str())
                    };
                    format!(
                        "Worker Host {id} is running {} of {} {kind}Attempts",
                        capacity.capacity - capacity.available_slots.min(capacity.capacity),
                        capacity.capacity
                    )
                }
            }
        })
        .collect();
    Some((
        "capacity".to_owned(),
        format!("Waiting: {}", reasons.join("; ")),
    ))
}

pub(crate) fn unsupported_by_harness(task: &Task) -> Option<(String, String)> {
    let harness = task.harness_kind();
    if let Some(reason) = task
        .execution_limits
        .as_ref()
        .and_then(|limits| unsupported_execution_limits(harness, limits))
    {
        return Some(("execution-limits".into(), reason));
    }
    if let Some(reason) = unsupported_runtime_actions(harness, &task.allowed_actions) {
        return Some(("runtime-actions".into(), reason));
    }
    if let Some(reason) = supertag_protocol::file_scope::harness_reason(task, harness) {
        return Some(("file-scope".into(), reason));
    }
    if let Some(reason) = supertag_protocol::network_scope::harness_reason(task, harness) {
        return Some(("network-scope".into(), reason));
    }
    // These harnesses load no Skills, so their lanes claim with no context contracts.
    (matches!(
        harness,
        HarnessKind::Opencode | HarnessKind::OpenaiAgents | HarnessKind::Cursor
    ) && !crate::context::task_supported(task, &[]))
    .then(|| {
        (
            "context".into(),
            format!(
                "{} loads no Skills, and the Task requires one",
                harness_name(harness)
            ),
        )
    })
}

/// Labels the Control Plane derives from what a host reports or claims with:
/// `harness:NAME`, `workspace:NAME` for each checkout, and `mcp:NAME` for each
/// MCP server its host service provides. Names that are not valid labels are skipped.
pub(crate) fn derived_labels(
    harness: HarnessKind,
    workspace_ids: &[String],
    profile: Option<&HarnessExecutionProfile>,
) -> BTreeSet<String> {
    let mut labels = BTreeSet::new();
    labels.extend(harness_label(harness).map(str::to_owned));
    let mut add = |label: String| {
        if let Ok(label) = parse_label(&label) {
            labels.insert(label);
        }
    };
    for workspace in workspace_ids {
        add(format!("workspace:{workspace}"));
    }
    for server in profile.map_or(&[][..], |profile| &profile.mcp_servers[..]) {
        add(format!("mcp:{}", server.name));
    }
    // A file Volume the host maps and writes to; the host checks its mapping
    // against the registered source before it writes.
    for volume in profile.map_or(&[][..], |profile| &profile.volumes[..]) {
        add(format!("volume:{}", volume.volume_id));
    }
    labels
}

fn decode(value: &str) -> Result<Vec<String>> {
    Ok(serde_json::from_str(value)?)
}

pub(crate) async fn runs_on_in(
    transaction: &mut Transaction<'_, Any>,
    tag_id: &str,
) -> Result<Vec<String>> {
    let value: Option<String> =
        sqlx::query_scalar("SELECT runs_on FROM supertag_v2_tags WHERE tag_id=$1")
            .bind(tag_id)
            .fetch_optional(&mut **transaction)
            .await?;
    value.as_deref().map_or_else(|| Ok(vec![]), decode)
}

/// The labels a host carries when it claims: its labels reported in this generation, the
/// labels its Auth Key granted, and the labels derived from the claim itself.
pub(crate) async fn claim_labels_in(
    transaction: &mut Transaction<'_, Any>,
    (host_id, generation): (&str, i64),
    harness: HarnessKind,
    workspace_ids: &[String],
    profile: &HarnessExecutionProfile,
) -> Result<BTreeSet<String>> {
    let granted: String =
        sqlx::query_scalar("SELECT granted_labels FROM supertag_v2_hosts WHERE host_id=$1")
            .bind(host_id)
            .fetch_one(&mut **transaction)
            .await?;
    let reported: Option<String> =
        // A restarted host's labels from its previous run no longer apply.
        sqlx::query_scalar(
            "SELECT labels FROM supertag_v2_host_readiness WHERE host_id=$1 AND generation=$2",
        )
        .bind(host_id)
        .bind(generation)
        .fetch_optional(&mut **transaction)
        .await?;
    let mut labels = derived_labels(harness, workspace_ids, Some(profile));
    labels.extend(decode(&granted)?);
    if let Some(reported) = reported {
        labels.extend(decode(&reported)?);
    }
    Ok(labels)
}

/// The labels a host must carry to run a Tag's Tasks: its `runsOn`, and `volume:ID` when
/// the Tag keeps its captures on a file artifact Volume, which only a host mapping that directory
/// can write.
pub(crate) async fn required_labels_in(
    transaction: &mut Transaction<'_, Any>,
    tag_id: &str,
) -> Result<Vec<String>> {
    let mut labels = runs_on_in(transaction, tag_id).await?;
    let file_volume: Option<String> = sqlx::query_scalar(
        "SELECT v.volume_id FROM supertag_v2_tags t
         JOIN supertag_v2_artifact_volumes v ON v.volume_id=t.volume AND v.deleted=0
         WHERE t.tag_id=$1 AND v.source LIKE 'file:%'",
    )
    .bind(tag_id)
    .fetch_optional(&mut **transaction)
    .await?;
    if let Some(volume) = file_volume
        && let Ok(label) = parse_label(&format!("volume:{volume}"))
        && !labels.contains(&label)
    {
        labels.push(label);
    }
    Ok(labels)
}

/// Caches each Tag's `runsOn` for one claim scan.
#[derive(Default)]
pub(crate) struct RunsOnCache(BTreeMap<String, Vec<String>>);

impl RunsOnCache {
    pub(crate) async fn admits(
        &mut self,
        transaction: &mut Transaction<'_, Any>,
        tag_id: &str,
        labels: &BTreeSet<String>,
    ) -> Result<bool> {
        if !self.0.contains_key(tag_id) {
            let runs_on = required_labels_in(transaction, tag_id).await?;
            self.0.insert(tag_id.into(), runs_on);
        }
        Ok(self.0[tag_id].iter().all(|label| labels.contains(label)))
    }
}

/// Names the labels no candidate carries, or every required label when each
/// exists on some candidate but none carries them all.
pub(crate) fn missing_labels(required: &[String], hosts: &[BTreeSet<String>]) -> Vec<String> {
    if required.is_empty()
        || hosts
            .iter()
            .any(|labels| required.iter().all(|label| labels.contains(label)))
    {
        return vec![];
    }
    let absent: Vec<String> = required
        .iter()
        .filter(|label| !hosts.iter().any(|labels| labels.contains(*label)))
        .cloned()
        .collect();
    if absent.is_empty() {
        required.to_vec()
    } else {
        absent
    }
}

fn summary(missing: &[String]) -> String {
    let (servers, labels): (Vec<&String>, Vec<&String>) =
        missing.iter().partition(|label| label.starts_with("mcp:"));
    let mut parts = vec![];
    if !labels.is_empty() {
        parts.push(format!(
            "No bound Worker Host has labels: {}",
            labels
                .iter()
                .map(|label| label.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    for server in servers {
        parts.push(format!(
            "No bound Worker Host provides MCP server {}",
            &server["mcp:".len()..]
        ));
    }
    parts.join(". ")
}

/// Whether a Worker Host bound to the Tag has reported a lane for `harness`, whatever its state
/// now. A Work Session that names a harness no bound host runs would never be claimed.
pub(crate) async fn bound_host_runs_in(
    transaction: &mut Transaction<'_, Any>,
    tag_id: &str,
    harness: HarnessKind,
    now: i64,
) -> Result<bool> {
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT host_id FROM supertag_v2_hosts h WHERE revoked_at_ms IS NULL AND (all_tags=1 OR EXISTS (SELECT 1 FROM supertag_v2_host_tags scope WHERE scope.host_id=h.host_id AND scope.tag_id=$1)) ORDER BY host_id",
    )
    .bind(tag_id)
    .fetch_all(&mut **transaction)
    .await?;
    for id in ids {
        let status = crate::store::host_status_in(transaction, &id, now).await?;
        if status
            .harnesses
            .iter()
            .any(|lane| lane.harness_kind() == harness)
            || (status.harnesses.is_empty() && status.harness_kind() == harness)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

impl Store {
    pub async fn set_tag_runs_on(&self, input: &SetTagRunsOnRequest) -> Result<Tag> {
        name("Tag ID", &input.tag_id)?;
        let runs_on = parse_labels(&input.runs_on, LabelField::RunsOn)?;
        let (mut transaction, _) = self.write().await?;
        crate::tags::require_active(&mut transaction, &input.tag_id).await?;
        crate::manifest_relationships::imperative_runs_on(
            &mut transaction,
            &input.tag_id,
            &runs_on,
        )
        .await?;
        sqlx::query("UPDATE supertag_v2_tags SET runs_on=$1 WHERE tag_id=$2")
            .bind(serde_json::to_string(&runs_on)?)
            .bind(&input.tag_id)
            .execute(&mut *transaction)
            .await?;
        let row = sqlx::query("SELECT * FROM supertag_v2_tags WHERE tag_id=$1")
            .bind(&input.tag_id)
            .fetch_one(&mut *transaction)
            .await?;
        let tag = crate::tags::tag_from_row(&row)?;
        transaction.commit().await?;
        Ok(tag)
    }

    pub async fn diagnose_task_placement(&self, task_id: &str) -> Result<TaskPlacementDiagnosis> {
        name("Task ID", task_id)?;
        let mut transaction = self.pool.begin().await?;
        let task = crate::store::task_in(&mut transaction, task_id).await?;
        let mut required = required_labels_in(&mut transaction, &task.tag_id).await?;
        if let Some(workspace) = &task.workspace
            && let Ok(label) = parse_label(&format!("workspace:{}", workspace.workspace_id))
            && !required.contains(&label)
        {
            required.push(label);
        }
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT host_id FROM supertag_v2_hosts h WHERE revoked_at_ms IS NULL AND (all_tags=1 OR EXISTS (SELECT 1 FROM supertag_v2_host_tags scope WHERE scope.host_id=h.host_id AND scope.tag_id=$1)) ORDER BY host_id",
        )
        .bind(&task.tag_id)
        .fetch_all(&mut *transaction)
        .await?;
        let now = self.execution_now_ms();
        let unsupported = unsupported_by_harness(&task);
        let mut hosts = Vec::with_capacity(ids.len());
        let mut carried = Vec::with_capacity(ids.len());
        let mut eligible = Vec::new();
        // Lanes for the Task's harness, and what keeps each from running it.
        let mut lanes: Vec<Option<(String, String)>> = vec![];
        for id in ids {
            let status = crate::store::host_status_in(&mut transaction, &id, now).await?;
            let mut profiles: Vec<(HarnessKind, Option<&HarnessExecutionProfile>)> = status
                .harnesses
                .iter()
                .map(|lane| (lane.harness_kind(), lane.execution_profile.as_ref()))
                .collect();
            if profiles.is_empty() {
                profiles.push((status.harness_kind(), status.execution_profile.as_ref()));
            }
            let default = HarnessExecutionProfile::default();
            let host_lanes: Vec<Option<(String, String)>> = profiles
                .into_iter()
                .filter(|(harness, _)| *harness == task.harness_kind())
                .map(|(harness, profile)| {
                    crate::store::lane_requirement(&task, harness, profile.unwrap_or(&default))
                })
                .collect();
            // A host whose every lane for the harness is blocked reports the first reason.
            let (requirement, reason) = if host_lanes.is_empty() {
                (
                    "harness".to_owned(),
                    format!(
                        "Worker Host {id} does not run {}",
                        harness_name(task.harness_kind())
                    ),
                )
            } else if host_lanes.iter().all(Option::is_some) {
                host_lanes[0].clone().unwrap_or_default()
            } else {
                Default::default()
            };
            lanes.extend(host_lanes);
            let labels: BTreeSet<String> = status.labels.iter().cloned().collect();
            let missing: Vec<String> = required
                .iter()
                .filter(|label| !labels.contains(*label))
                .cloned()
                .collect();
            if missing.is_empty() {
                eligible.push(status.clone());
            }
            hosts.push(HostPlacement {
                host_id: id,
                phase: status.phase,
                labels: status.labels,
                eligible: missing.is_empty(),
                missing_labels: missing,
                requirement,
                reason,
            });
            carried.push(labels);
        }
        let held = if task.state() == TaskState::Queued {
            crate::start_rates::held_until_in(&mut transaction, &task, now).await?
        } else {
            None
        };
        let holder = if task.state() == TaskState::Queued {
            crate::checkpoints::holder_wait_in(&mut transaction, &task, None, now).await?
        } else {
            None
        };
        let local_holder = if task.state() == TaskState::Queued {
            crate::workspaces::local_holder_wait_in(&mut transaction, &task, None).await?
        } else {
            None
        };
        transaction.commit().await?;
        let missing = missing_labels(&required, &carried);
        let (requirement, summary) = if let Some(holder) =
            task.waiting_for_holder.as_ref().or(local_holder.as_ref())
        {
            (
                "workspace-holder".to_owned(),
                supertag_protocol::waiting_for_holder(holder),
            )
        } else if hosts.is_empty() {
            (
                "worker-host".to_owned(),
                format!("No Worker Host is bound to Tag {}", task.tag_id),
            )
        } else if let Some(unsupported) = unsupported {
            unsupported
        } else if let Some(Some(requirement)) = lanes
            .iter()
            .all(Option::is_some)
            .then(|| lanes.first().cloned().flatten())
        {
            requirement
        } else if let Some((rate, next)) = held {
            (
                "start-rate".to_owned(),
                format!(
                    "Tag {} started {} Task Attempts in the last {}, its start rate; the next can start at {}",
                    task.tag_id,
                    rate.starts,
                    crate::start_rates::describe(&rate)
                        .split_once('/')
                        .map_or("", |(_, per)| per),
                    crate::start_rates::clock(next, self.time_zone()),
                ),
            )
        } else if let Some((holder, until)) = holder {
            (
                "checkpoint-holder".to_owned(),
                format!(
                    "Waiting until {} for Worker Host {holder}, which holds this Session's checkpoint; after that another Worker Host starts it from the recap",
                    crate::start_rates::clock(until, self.time_zone()),
                ),
            )
        } else if missing.is_empty() {
            (task.state() == TaskState::Queued)
                .then(|| waiting_for_capacity(task.harness_kind(), &eligible))
                .flatten()
                .unwrap_or_default()
        } else {
            (format!("labels:{}", missing.join(",")), summary(&missing))
        };
        Ok(TaskPlacementDiagnosis {
            task_id: task.task_id,
            tag_id: task.tag_id,
            state: task.state,
            required_labels: required,
            missing_labels: missing,
            requirement,
            summary,
            hosts,
        })
    }
}

/// Whether `host_id` could take `task` now by its recorded status: ready (connected, with a free
/// slot, not draining), bound to the Task's Tag, and running its harness.
pub(crate) async fn ready_for_in(
    tx: &mut Transaction<'_, Any>,
    host_id: &str,
    task: &Task,
    now: i64,
) -> Result<bool> {
    let bound: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM supertag_v2_hosts h WHERE h.host_id=$1 AND h.revoked_at_ms IS NULL AND (h.all_tags=1 OR EXISTS (SELECT 1 FROM supertag_v2_host_tags scope WHERE scope.host_id=h.host_id AND scope.tag_id=$2))",
    )
    .bind(host_id)
    .bind(&task.tag_id)
    .fetch_one(&mut **tx)
    .await?;
    if bound == 0 {
        return Ok(false);
    }
    let status = crate::store::host_status_in(tx, host_id, now).await?;
    let harness = task.harness_kind();
    let serves = status
        .harnesses
        .iter()
        .any(|lane| harness == HarnessKind::Unspecified || lane.harness_kind() == harness)
        || (status.harnesses.is_empty()
            && (harness == HarnessKind::Unspecified || status.harness_kind() == harness));
    Ok(status.phase() == HostPhase::Ready && serves)
}

#[tonic::async_trait]
impl placement_server::Placement for ControlPlane {
    async fn set_tag_runs_on(
        &self,
        request: Request<SetTagRunsOnRequest>,
    ) -> std::result::Result<Response<Tag>, Status> {
        self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store.set_tag_runs_on(request.get_ref()).await?,
        ))
    }

    async fn diagnose_task(
        &self,
        request: Request<DiagnoseTaskPlacementRequest>,
    ) -> std::result::Result<Response<TaskPlacementDiagnosis>, Status> {
        self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .diagnose_task_placement(&request.get_ref().task_id)
                .await?,
        ))
    }
}

#[tonic::async_trait]
impl auth_keys_server::AuthKeys for ControlPlane {
    async fn revoke_auth_key(
        &self,
        request: Request<RevokeAuthKeyRequest>,
    ) -> std::result::Result<Response<AuthKey>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .revoke_auth_key(&principal, &request.get_ref().name)
                .await?,
        ))
    }

    async fn list_auth_keys(
        &self,
        request: Request<ListAuthKeysRequest>,
    ) -> std::result::Result<Response<ListAuthKeysResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_auth_keys(&principal, request.get_ref())
                .await?,
        ))
    }

    async fn get_auth_key(
        &self,
        request: Request<GetAuthKeyRequest>,
    ) -> std::result::Result<Response<AuthKey>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .get_auth_key(&principal, &request.get_ref().name)
                .await?,
        ))
    }
}

#[tonic::async_trait]
impl users_server::Users for ControlPlane {
    async fn invite_user(
        &self,
        request: Request<InviteUserRequest>,
    ) -> std::result::Result<Response<InviteUserResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .invite_user(&principal, request.get_ref())
                .await?,
        ))
    }

    async fn get_user(
        &self,
        request: Request<GetUserRequest>,
    ) -> std::result::Result<Response<User>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store.get_user(&principal, request.get_ref()).await?,
        ))
    }

    async fn list_users(
        &self,
        request: Request<ListUsersRequest>,
    ) -> std::result::Result<Response<ListUsersResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store.list_users(&principal, request.get_ref()).await?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_waiting_task_names_the_full_pool_or_its_harness_limit() {
        let host = |available: u32, codex: (u32, u32)| WorkerHostStatus {
            host_id: "laptop".into(),
            phase: if available > 0 {
                HostPhase::Ready
            } else {
                HostPhase::Busy
            } as i32,
            capacity: 3,
            available_slots: available,
            active_attempts: 3 - available,
            harnesses: vec![
                HostHarnessCapacity {
                    harness_kind: HarnessKind::Codex as i32,
                    capacity: codex.0,
                    available_slots: codex.1,
                    ..Default::default()
                },
                HostHarnessCapacity {
                    harness_kind: HarnessKind::ClaudeCode as i32,
                    capacity: 3,
                    available_slots: available,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        // Claude Code runs all three slots of the pool, which Codex shares.
        let full = waiting_for_capacity(HarnessKind::Codex, &[host(0, (3, 0))]);
        assert_eq!(
            full.map(|(_, summary)| summary).as_deref(),
            Some("Waiting: Worker Host laptop is running 3 of 3 Attempts")
        );
        // A slot is free, but Codex runs its limit of one.
        let limited = waiting_for_capacity(HarnessKind::Codex, &[host(1, (1, 0))]);
        assert_eq!(
            limited.map(|(_, summary)| summary).as_deref(),
            Some("Waiting: Worker Host laptop is running 1 of 1 Codex Attempts")
        );
        assert_eq!(
            waiting_for_capacity(HarnessKind::ClaudeCode, &[host(1, (1, 0))]),
            None
        );
    }

    fn labels(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn drawn_limits_keep_only_what_the_harness_enforces() {
        let cost = |currency: &str| ReportedCostLimit {
            currency: currency.into(),
            amount_minor: 1000,
        };
        let drawn = |currency: &str| ExecutionLimits {
            max_reported_tokens: Some(5000),
            max_reported_cost: Some(cost(currency)),
            max_native_agents: Some(0),
        };
        let kept = |harness, currency: &str| enforceable_reported_limits(harness, drawn(currency));
        let codex = kept(HarnessKind::Codex, "USD");
        assert_eq!(
            (codex.max_reported_tokens, codex.max_reported_cost),
            (Some(5000), None)
        );
        let claude = kept(HarnessKind::ClaudeCode, "USD");
        assert_eq!(
            (claude.max_reported_tokens, claude.max_reported_cost),
            (None, Some(cost("USD")))
        );
        let claude_eur = kept(HarnessKind::ClaudeCode, "EUR");
        assert_eq!(
            (claude_eur.max_reported_tokens, claude_eur.max_reported_cost),
            (None, None)
        );
        for harness in [
            HarnessKind::Cursor,
            HarnessKind::Opencode,
            HarnessKind::OpenaiAgents,
        ] {
            let limits = kept(harness, "USD");
            assert_eq!(
                (limits.max_reported_tokens, limits.max_reported_cost),
                (None, None)
            );
            // Native agent limits are never drawn from a pool, so they are left for admission.
            assert_eq!(limits.max_native_agents, Some(0));
        }
        assert_eq!(kept(HarnessKind::Unspecified, "EUR"), drawn("EUR"));
    }

    #[test]
    fn normalizes_and_validates_labels() {
        assert_eq!(parse_label(" GPU ").unwrap(), "gpu");
        assert_eq!(
            parse_label("harness:claude-code").unwrap(),
            "harness:claude-code"
        );
        assert_eq!(parse_label("region.us_east-1").unwrap(), "region.us_east-1");
        assert_eq!(parse_label(&"a".repeat(63)).unwrap(), "a".repeat(63));
        for value in [
            "",
            "-gpu",
            ":gpu",
            &"a".repeat(64),
            "gpu large",
            "gpu/1",
            "gpü",
        ] {
            assert!(parse_label(value).is_err(), "{value}");
        }
        assert_eq!(
            parse_labels(
                &labels(&["gpu", "Linux", "GPU", "arm64"]),
                LabelField::Reported
            )
            .unwrap(),
            labels(&["arm64", "gpu", "linux"])
        );
        assert!(parse_labels(&labels(&["MCP:github"]), LabelField::Reported).is_err());
        assert!(parse_labels(&labels(&["mcp:github"]), LabelField::AuthKey).is_err());
        assert_eq!(
            parse_labels(&labels(&["mcp:github"]), LabelField::RunsOn).unwrap(),
            labels(&["mcp:github"])
        );
        for field in [
            LabelField::Reported,
            LabelField::AuthKey,
            LabelField::RunsOn,
        ] {
            assert!(parse_labels(&labels(&["volume-credential:x"]), field).is_err());
            assert!(parse_labels(&labels(&["mcp-login:x"]), field).is_err());
        }
        let many: Vec<String> = (0..65).map(|index| format!("label-{index}")).collect();
        assert!(parse_labels(&many, LabelField::RunsOn).is_err());
    }

    #[test]
    fn names_labels_no_host_has_or_every_label_when_none_has_all() {
        let host = |values: &[&str]| values.iter().map(|value| (*value).to_owned()).collect();
        let hosts: Vec<BTreeSet<String>> = vec![host(&["arm64", "macos"]), host(&["gpu", "linux"])];
        assert!(missing_labels(&[], &hosts).is_empty());
        assert!(missing_labels(&labels(&["gpu"]), &hosts).is_empty());
        assert_eq!(
            missing_labels(&labels(&["macos", "gpu"]), &hosts[1..]),
            labels(&["macos"])
        );
        assert_eq!(
            missing_labels(&labels(&["macos", "gpu"]), &hosts),
            labels(&["macos", "gpu"])
        );
        assert_eq!(
            summary(&labels(&["macos", "gpu", "mcp:sentry"])),
            "No bound Worker Host has labels: macos, gpu. No bound Worker Host provides MCP server sentry"
        );
    }

    #[test]
    fn derives_harness_workspace_and_mcp_labels() {
        let profile = HarnessExecutionProfile {
            mcp_servers: vec![McpServerCapability {
                name: "Sentry".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert_eq!(
            derived_labels(HarnessKind::ClaudeCode, &labels(&["app"]), Some(&profile))
                .into_iter()
                .collect::<Vec<_>>(),
            labels(&["harness:claude-code", "mcp:sentry", "workspace:app"])
        );
    }
}
