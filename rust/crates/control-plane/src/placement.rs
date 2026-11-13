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
        } else if label.starts_with("volume-credential:") || label.starts_with("artifact-volume:") {
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
            let runs_on = runs_on_in(transaction, tag_id).await?;
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

impl Store {
    pub async fn set_tag_runs_on(&self, input: &SetTagRunsOnRequest) -> Result<Tag> {
        name("Tag ID", &input.tag_id)?;
        let runs_on = parse_labels(&input.runs_on, LabelField::RunsOn)?;
        let (mut transaction, _) = self.write().await?;
        crate::tags::require_active(&mut transaction, &input.tag_id).await?;
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
        let mut required = runs_on_in(&mut transaction, &task.tag_id).await?;
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
        let mut hosts = Vec::with_capacity(ids.len());
        let mut carried = Vec::with_capacity(ids.len());
        for id in ids {
            let status = crate::store::host_status_in(&mut transaction, &id, now).await?;
            let labels: BTreeSet<String> = status.labels.iter().cloned().collect();
            let missing: Vec<String> = required
                .iter()
                .filter(|label| !labels.contains(*label))
                .cloned()
                .collect();
            hosts.push(HostPlacement {
                host_id: id,
                phase: status.phase,
                labels: status.labels,
                eligible: missing.is_empty(),
                missing_labels: missing,
            });
            carried.push(labels);
        }
        transaction.commit().await?;
        let missing = missing_labels(&required, &carried);
        let (requirement, summary) = if hosts.is_empty() {
            (
                "worker-host".to_owned(),
                format!("No Worker Host is bound to Tag {}", task.tag_id),
            )
        } else if missing.is_empty() {
            (String::new(), String::new())
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
                .revoke_auth_key(&principal, &request.get_ref().key_id)
                .await?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
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
