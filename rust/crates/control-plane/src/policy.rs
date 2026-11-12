//! Reusable policy catalog and immutable, resolved admission snapshots.
use std::collections::{BTreeMap, BTreeSet};

use prost::Message;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction, any::AnyRow};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};
use uuid::Uuid;

use crate::{
    ControlPlane, Store, StoreError,
    store::{MAILBOX_SEND_ACTION, Result, WORKSTREAM_POST_ACTION, invalid, name},
    surface_policy::AdmissionSurface,
};

const RESOURCE_BYTES: usize = 192 * 1024;
const SNAPSHOT_BYTES: usize = 384 * 1024;
pub(crate) const PAGE_BYTES: usize = 768 * 1024;

pub(crate) fn operator(principal: &str) -> Result<()> {
    if principal
        .strip_prefix("operator:")
        .is_none_or(str::is_empty)
    {
        return Err(StoreError::PermissionDenied);
    }
    name("operator principal", principal)
}
fn bounded(value: &str, label: &str, maximum: usize, empty: bool) -> Result<String> {
    let value = value.trim();
    if (!empty && value.is_empty())
        || value.encode_utf16().count() > maximum
        || value.chars().any(|c| c == '\0')
    {
        return Err(invalid(&format!(
            "{label} is empty or exceeds its supported length"
        )));
    }
    Ok(value.into())
}
fn identity(value: &str, label: &str) -> Result<String> {
    let value = value.trim();
    name(label, value)?;
    Ok(value.into())
}
fn size<M: Message>(value: &M, maximum: usize) -> Result<()> {
    if value.encoded_len() > maximum {
        return Err(invalid("policy exceeds its supported encoded size"));
    }
    Ok(())
}
pub(crate) fn decode<M: Message + Default>(bytes: &[u8]) -> Result<M> {
    M::decode(bytes).map_err(|_| StoreError::FailedPrecondition("stored policy is invalid".into()))
}
pub(crate) fn snapshot_from_row(row: &AnyRow) -> Result<Option<TaskPolicySnapshot>> {
    let bytes: Vec<u8> = row.try_get("policy_snapshot")?;
    if bytes.is_empty() {
        Ok(None)
    } else {
        Ok(Some(decode(&bytes)?))
    }
}
pub(crate) fn digest<M: Message>(method: &str, input: &M) -> String {
    let mut hash = Sha256::new();
    hash.update(method.as_bytes());
    hash.update([0]);
    hash.update(input.encode_to_vec());
    format!("{:x}", hash.finalize())
}
pub(crate) async fn replay<M: Message + Default>(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    operation: &str,
    request_digest: &str,
) -> Result<Option<M>> {
    let row=sqlx::query("SELECT request_digest,response FROM supertag_v2_policy_operations WHERE principal=$1 AND operation_id=$2").bind(principal).bind(operation).fetch_optional(&mut **tx).await?;
    if let Some(row) = row {
        if row.try_get::<String, _>("request_digest")? != request_digest {
            return Err(StoreError::Conflict(
                "operation ID was already used for different policy input".into(),
            ));
        }
        return Ok(Some(decode(&row.try_get::<Vec<u8>, _>("response")?)?));
    }
    Ok(None)
}
pub(crate) async fn receipt<M: Message>(
    tx: &mut Transaction<'_, Any>,
    principal: &str,
    operation: &str,
    request_digest: &str,
    response: &M,
) -> Result<()> {
    sqlx::query("INSERT INTO supertag_v2_policy_operations (principal,operation_id,request_digest,response) VALUES ($1,$2,$3,$4)").bind(principal).bind(operation).bind(request_digest).bind(response.encode_to_vec()).execute(&mut **tx).await?;
    Ok(())
}

trait Resource: Message + Default + Clone {
    const TABLE: &'static str;
    const KEY: &'static str;
    const KIND: &'static str;
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn revision(&self) -> u64;
    fn set_identity(&mut self, id: String, revision: u64);
    fn normalize(&mut self, prior: Option<&Self>) -> Result<()>;
}
macro_rules! resource_fields {
    ($ty:ty,$table:literal,$key:ident,$kind:literal) => {
        const TABLE: &'static str = $table;
        const KEY: &'static str = stringify!($key);
        const KIND: &'static str = $kind;
        fn id(&self) -> &str {
            &self.$key
        }
        fn name(&self) -> &str {
            &self.name
        }
        fn revision(&self) -> u64 {
            self.revision
        }
        fn set_identity(&mut self, id: String, revision: u64) {
            self.$key = id;
            self.revision = revision;
        }
    };
}
impl Resource for PermissionSet {
    resource_fields!(
        PermissionSet,
        "supertag_v2_permission_sets",
        set_id,
        "permission-set"
    );
    fn normalize(&mut self, prior: Option<&Self>) -> Result<()> {
        self.name = identity(&self.name, "Permission Set name")?;
        if self.approvers.len() > 50 || self.permissions.len() > 256 {
            return Err(invalid(
                "Permission Set has too many approvers or permissions",
            ));
        }
        let mut approvers = BTreeSet::new();
        for value in &self.approvers {
            let Some((kind, id)) = value.trim().split_once(':') else {
                return Err(invalid("approvers must be operator:<id> or tag:<id>"));
            };
            if !matches!(kind, "operator" | "tag") {
                return Err(invalid("approvers must be operator:<id> or tag:<id>"));
            }
            let id = bounded(id, "approver identity", 200, false)?;
            name("approver identity", &id)?;
            approvers.insert(format!("{kind}:{id}"));
        }
        self.approvers = approvers.into_iter().collect();
        let previous: BTreeMap<_, _> = prior
            .into_iter()
            .flat_map(|p| p.permissions.iter())
            .map(|p| (permission_key(p), p.permission_id.clone()))
            .collect();
        let mut permissions = BTreeMap::new();
        for mut p in std::mem::take(&mut self.permissions) {
            p.action = identity(&p.action, "permission action")?;
            p.surface_account_id = p.surface_account_id.trim().into();
            p.scope = p.scope.trim().into();
            p.reference = p.reference.trim().into();
            p.resource = p.resource.trim().into();
            match PolicyPermissionTarget::try_from(p.target).ok() {
                Some(PolicyPermissionTarget::Runtime) => {
                    if !p.surface_account_id.is_empty()
                        || !p.scope.is_empty()
                        || !p.reference.is_empty()
                        || !p.resource.is_empty()
                    {
                        return Err(invalid(
                            "runtime permission cannot carry surface or MCP resource fields",
                        ));
                    }
                }
                Some(PolicyPermissionTarget::Surface) => {
                    name("surface account", &p.surface_account_id)?;
                    name("surface scope", &p.scope)?;
                    if p.reference.len() > 2048 || !p.resource.is_empty() {
                        return Err(invalid("invalid surface permission reference or resource"));
                    }
                }
                Some(PolicyPermissionTarget::Mcp) => {
                    if !p.surface_account_id.is_empty()
                        || !p.scope.is_empty()
                        || !p.reference.is_empty()
                    {
                        return Err(invalid("MCP permission cannot carry surface fields"));
                    }
                    validate_mcp(&p.action, &p.resource)?;
                }
                _ => return Err(invalid("permission target is required")),
            }
            let key = permission_key(&p);
            p.permission_id = element_id(&p.permission_id, previous.get(&key))?;
            if let Some(old) = permissions.insert(key, p.clone())
                && old.approval_required != p.approval_required
            {
                return Err(invalid(
                    "duplicate permission has conflicting approval requirements",
                ));
            }
        }
        self.permissions = permissions.into_values().collect();
        Ok(())
    }
}
fn permission_key(p: &PolicyPermission) -> String {
    serde_json::to_string(&(
        p.target,
        &p.action,
        &p.surface_account_id,
        &p.scope,
        &p.resource,
    ))
    .expect("strings serialize")
}
fn element_id(input: &str, prior: Option<&String>) -> Result<String> {
    if !input.is_empty() && prior.is_none_or(|old| old != input) {
        return Err(invalid(
            "policy element identity must match its existing grant or item",
        ));
    }
    Ok(prior.cloned().unwrap_or_else(|| Uuid::new_v4().to_string()))
}
fn validate_mcp(action: &str, resource: &str) -> Result<()> {
    let Some((server, tool)) = action.split_once('/') else {
        return Err(invalid("MCP action must be server/tool"));
    };
    if server.is_empty()
        || server.len() > 59
        || server.starts_with("supertag")
        || !server
            .bytes()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        || !server
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'-' | b'_'))
        || tool.is_empty()
        || tool.len() > 128
        || !tool
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-' | b'*'))
    {
        return Err(invalid("invalid or reserved MCP server/tool permission"));
    }
    if !resource.is_empty() {
        let Some((kind, value)) = resource.split_once(':') else {
            return Err(invalid("MCP resource must be kind:value"));
        };
        if kind.is_empty()
            || kind.len() > 40
            || !kind.bytes().next().is_some_and(|c| c.is_ascii_lowercase())
            || !kind
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
            || value.is_empty()
            || value.len() > 400
            || !value.bytes().all(|c| (33..=126).contains(&c) && c != b'*')
        {
            return Err(invalid("invalid MCP resource"));
        }
    }
    Ok(())
}
impl Resource for ContextSet {
    resource_fields!(
        ContextSet,
        "supertag_v2_context_sets",
        set_id,
        "context-set"
    );
    fn normalize(&mut self, prior: Option<&Self>) -> Result<()> {
        self.name = identity(&self.name, "Context Set name")?;
        if self.items.len() > 256 {
            return Err(invalid("Context Set has too many items"));
        }
        let previous: BTreeMap<_, _> = prior
            .into_iter()
            .flat_map(|p| p.items.iter())
            .map(|p| (p.item_key.clone(), p.item_id.clone()))
            .collect();
        let mut items = BTreeMap::new();
        for mut item in std::mem::take(&mut self.items) {
            item.item_key = identity(&item.item_key, "context item key")?;
            item.r#type = identity(&item.r#type, "context type")?;
            if item.version == 0 || item.config_json.len() > 64 * 1024 {
                return Err(invalid("context version or configuration is invalid"));
            }
            let mut config: serde_json::Value = serde_json::from_str(&item.config_json)
                .map_err(|_| invalid("context configuration must be a JSON object"))?;
            if !config.is_object() {
                return Err(invalid("context configuration must be a JSON object"));
            }
            validate_context(&item, &mut config)?;
            item.config_json = serde_json::to_string(&config)?;
            item.item_id = element_id(&item.item_id, previous.get(&item.item_key))?;
            if items.insert(item.item_key.clone(), item).is_some() {
                return Err(invalid("Context Set item keys must be unique"));
            }
        }
        self.items = items.into_values().collect();
        Ok(())
    }
}
fn validate_context(item: &PolicyContextItem, config: &mut serde_json::Value) -> Result<()> {
    if matches!(
        item.r#type.as_str(),
        "supertag/skill" | "supertag/artifacts"
    ) && item.version != 1
    {
        return Err(invalid("unsupported built-in Context version"));
    }
    if item.r#type == "supertag/skill" {
        if config
            .as_object()
            .expect("validated object")
            .keys()
            .any(|key| !matches!(key.as_str(), "reference" | "version" | "digest"))
        {
            return Err(invalid("unsupported Skill Context configuration field"));
        }
        if config
            .get("reference")
            .and_then(serde_json::Value::as_str)
            .is_none_or(|v| v.trim().is_empty())
        {
            return Err(invalid("skill context requires a reference"));
        }
        for key in ["version", "digest"] {
            if config
                .get(key)
                .is_some_and(|v| v.as_str().is_none_or(|s| s.trim().is_empty()))
            {
                return Err(invalid(
                    "skill context version and digest must be nonempty strings",
                ));
            }
        }
        for value in config
            .as_object_mut()
            .expect("validated object")
            .values_mut()
        {
            *value =
                serde_json::Value::String(value.as_str().expect("validated string").trim().into());
        }
    }
    if item.r#type == "supertag/artifacts" {
        if config
            .get("sourceRouteId")
            .and_then(serde_json::Value::as_str)
            .is_none_or(|v| v.trim().is_empty())
            || config
                .pointer("/selection/match")
                .and_then(serde_json::Value::as_str)
                != Some("shared-resource")
        {
            return Err(invalid(
                "artifact context requires a source Route and shared-resource selection",
            ));
        }
        if config
            .get("selection")
            .and_then(serde_json::Value::as_object)
            .is_none_or(|selection| {
                selection
                    .keys()
                    .any(|key| !matches!(key.as_str(), "match" | "maxAgeDays" | "limit"))
            })
        {
            return Err(invalid("unsupported artifact selection field"));
        }
        for (key, maximum) in [("maxAgeDays", 3650), ("limit", 5)] {
            if config
                .pointer(&format!("/selection/{key}"))
                .and_then(serde_json::Value::as_u64)
                .is_none_or(|n| n == 0 || n > maximum)
            {
                return Err(invalid(
                    "artifact context selection requires positive bounds",
                ));
            }
        }
        // Legacy artifact configuration retains only these versioned fields.
        *config = serde_json::json!({"sourceRouteId":config["sourceRouteId"].as_str().expect("validated Route").trim(),"selection":config["selection"]});
    }
    Ok(())
}
impl Resource for Role {
    resource_fields!(Role, "supertag_v2_roles", role_id, "role");
    fn normalize(&mut self, _prior: Option<&Self>) -> Result<()> {
        self.name = bounded(&self.name, "Role name", 100, false)?;
        name("Role name", &self.name)?;
        self.purpose = bounded(&self.purpose, "Role purpose", 1000, false)?;
        self.instructions = self.instructions.trim().into();
        if self.instructions.len() > 32768 || self.instructions.contains('\0') {
            return Err(invalid("Role instructions exceed 32 KiB or contain NUL"));
        }
        if self.status == 0 {
            self.status = RoleStatus::Active as i32;
        }
        if !matches!(
            RoleStatus::try_from(self.status),
            Ok(RoleStatus::Active | RoleStatus::Retired)
        ) {
            return Err(invalid("invalid Role status"));
        }
        self.permission_set_ids = references(&self.permission_set_ids)?;
        self.context_set_ids = references(&self.context_set_ids)?;
        self.execution = normalize_execution(self.execution.take())?;
        Ok(())
    }
}
fn references(input: &[String]) -> Result<Vec<String>> {
    if input.len() > 64 {
        return Err(invalid("a Role may reference at most 64 of each Set"));
    }
    input
        .iter()
        .map(|id| identity(id, "Set identity"))
        .collect::<Result<BTreeSet<_>>>()
        .map(|s| s.into_iter().collect())
}
fn normalize_execution(
    input: Option<PolicyExecutionSettings>,
) -> Result<Option<PolicyExecutionSettings>> {
    let Some(mut execution) = input else {
        return Ok(None);
    };
    if let Some(harness) = execution.harness.as_mut() {
        *harness = harness.trim().to_lowercase();
        if harness.is_empty()
            || harness.len() > 63
            || !harness
                .bytes()
                .next()
                .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            || !harness.bytes().all(|c| {
                c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
            })
        {
            return Err(invalid("invalid execution harness"));
        }
    }
    if execution.models.len() > 32 || execution.efforts.len() > 3 {
        return Err(invalid("too many execution models or efforts"));
    }
    let mut seen = BTreeSet::new();
    let mut models = vec![];
    for model in execution.models {
        let model = bounded(&model, "model name", 200, false)?;
        if !seen.insert(model.clone()) {
            return Err(invalid("execution models must not repeat"));
        }
        models.push(model);
    }
    execution.models = models;
    seen.clear();
    let mut efforts = vec![];
    for effort in execution.efforts {
        if !matches!(effort.as_str(), "low" | "medium" | "high") {
            return Err(invalid("effort must be low, medium, or high"));
        }
        if !seen.insert(effort.clone()) {
            return Err(invalid("execution efforts must not repeat"));
        }
        efforts.push(effort);
    }
    execution.efforts = efforts;
    if execution.harness.is_none() && execution.models.is_empty() && execution.efforts.is_empty() {
        Ok(None)
    } else {
        Ok(Some(execution))
    }
}

async fn optional_resource<M: Resource>(
    tx: &mut Transaction<'_, Any>,
    reference: &str,
) -> Result<Option<M>> {
    let query = format!(
        "SELECT payload FROM {} WHERE {}=$1 OR name=$1 ORDER BY {} LIMIT 2",
        M::TABLE,
        M::KEY,
        M::KEY
    );
    let rows = sqlx::query(&query)
        .bind(reference)
        .fetch_all(&mut **tx)
        .await?;
    if rows.len() > 1 {
        return Err(StoreError::Conflict("policy reference is ambiguous".into()));
    }
    rows.first()
        .map(|r| decode(&r.try_get::<Vec<u8>, _>("payload")?))
        .transpose()
}
async fn resource<M: Resource>(tx: &mut Transaction<'_, Any>, reference: &str) -> Result<M> {
    optional_resource(tx, reference)
        .await?
        .ok_or_else(|| StoreError::NotFound(format!("{} was not found", M::KIND)))
}
async fn prepare_resource<M: Resource>(
    tx: &mut Transaction<'_, Any>,
    mut value: M,
    expected: Option<u64>,
) -> Result<M> {
    if !value.id().is_empty() {
        value.set_identity(identity(value.id(), "policy identity")?, value.revision());
    }
    let prior = if value.id().is_empty() {
        optional_resource::<M>(tx, value.name().trim()).await?
    } else {
        optional_resource::<M>(tx, value.id()).await?
    };
    if let Some(prior) = &prior {
        if expected != Some(prior.revision()) {
            return Err(StoreError::Conflict(
                "policy revision changed or expected revision is missing".into(),
            ));
        }
        if value.name().trim() != prior.name() {
            return Err(invalid("policy resource names are immutable"));
        }
        if !value.id().is_empty() && value.id() != prior.id() {
            return Err(StoreError::Conflict(
                "policy identity belongs to another resource".into(),
            ));
        }
    } else if expected.is_some() {
        return Err(StoreError::Conflict(
            "new policy resource cannot have an expected revision".into(),
        ));
    }
    value.normalize(prior.as_ref())?;
    let id = if let Some(prior) = &prior {
        prior.id().into()
    } else if value.id().is_empty() {
        Uuid::new_v4().to_string()
    } else {
        identity(value.id(), "policy identity")?
    };
    for reference in [&id, value.name()] {
        if let Some(existing) = optional_resource::<M>(tx, reference).await?
            && existing.id() != id
        {
            return Err(StoreError::Conflict(
                "policy name or identity already exists".into(),
            ));
        }
    }
    // Deleting a Set never reuses its historical (identity, revision) pair.
    let revision = next_revision_in(tx, M::KIND, &id).await?;
    value.set_identity(id, revision);
    size(&value, RESOURCE_BYTES)?;
    Ok(value)
}

pub(crate) async fn next_revision_in(
    tx: &mut Transaction<'_, Any>,
    kind: &str,
    id: &str,
) -> Result<u64> {
    let historical: Option<i64> = sqlx::query_scalar(
        "SELECT revision FROM supertag_v2_policy_revisions WHERE kind=$1 AND resource_id=$2",
    )
    .bind(kind)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?;
    let revision = increment(historical.unwrap_or(0) as u64)?;
    sqlx::query("INSERT INTO supertag_v2_policy_revisions (kind,resource_id,revision) VALUES ($1,$2,$3) ON CONFLICT(kind,resource_id) DO UPDATE SET revision=excluded.revision")
        .bind(kind).bind(id).bind(revision as i64).execute(&mut **tx).await?;
    Ok(revision)
}
async fn save_resource<M: Resource>(tx: &mut Transaction<'_, Any>, value: &M) -> Result<()> {
    let query = format!(
        "INSERT INTO {} ({},name,revision,payload) VALUES ($1,$2,$3,$4) ON CONFLICT({}) DO UPDATE SET revision=excluded.revision,payload=excluded.payload",
        M::TABLE,
        M::KEY,
        M::KEY
    );
    sqlx::query(&query)
        .bind(value.id())
        .bind(value.name())
        .bind(value.revision() as i64)
        .bind(value.encode_to_vec())
        .execute(&mut **tx)
        .await?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    kind: String,
    scope: String,
    after: String,
}
pub(crate) fn page(
    input: &ListPolicyResourcesRequest,
    kind: &str,
    scope: &str,
) -> Result<(usize, String)> {
    let limit = if input.limit == 0 {
        50
    } else {
        input.limit.min(100)
    } as usize;
    if input.cursor.is_empty() {
        return Ok((limit, String::new()));
    }
    if input.cursor.len() > 4096 {
        return Err(invalid("invalid policy cursor"));
    }
    let cursor: Cursor =
        serde_json::from_str(&input.cursor).map_err(|_| invalid("invalid policy cursor"))?;
    if cursor.version != 1 || cursor.kind != kind || cursor.scope != scope {
        return Err(invalid("policy cursor does not match this list"));
    }
    Ok((limit, cursor.after))
}
pub(crate) fn next_cursor(kind: &str, scope: &str, after: &str) -> Result<String> {
    Ok(serde_json::to_string(&Cursor {
        version: 1,
        kind: kind.into(),
        scope: scope.into(),
        after: after.into(),
    })?)
}
async fn list<M: Resource>(
    tx: &mut Transaction<'_, Any>,
    input: &ListPolicyResourcesRequest,
) -> Result<(Vec<M>, String)> {
    let (limit, after) = page(input, M::KIND, "")?;
    let query = format!(
        "SELECT payload FROM {} WHERE {}>$1 ORDER BY {} LIMIT $2",
        M::TABLE,
        M::KEY,
        M::KEY
    );
    let rows = sqlx::query(&query)
        .bind(after)
        .bind((limit + 1) as i64)
        .fetch_all(&mut **tx)
        .await?;
    let mut output = vec![];
    let mut bytes = 0;
    let mut more = false;
    for row in rows {
        let item: M = decode(&row.try_get::<Vec<u8>, _>("payload")?)?;
        if output.len() == limit || bytes + item.encoded_len() + 16 > PAGE_BYTES {
            more = true;
            break;
        }
        bytes += item.encoded_len() + 16;
        output.push(item);
    }
    let cursor = if more {
        next_cursor(M::KIND, "", output.last().expect("resource fits page").id())?
    } else {
        String::new()
    };
    Ok((output, cursor))
}

impl Store {
    pub async fn put_permission_set(
        &self,
        principal: &str,
        input: &PutPermissionSetRequest,
    ) -> Result<PermissionSet> {
        operator(principal)?;
        name("operation ID", &input.operation_id)?;
        let hash = digest("put-permission", input);
        let (mut tx, _) = self.write().await?;
        if let Some(value) = replay(&mut tx, principal, &input.operation_id, &hash).await? {
            return Ok(value);
        }
        let value = prepare_resource(
            &mut tx,
            input
                .permission_set
                .clone()
                .ok_or_else(|| invalid("Permission Set is required"))?,
            input.expected_revision,
        )
        .await?;
        save_resource(&mut tx, &value).await?;
        receipt(&mut tx, principal, &input.operation_id, &hash, &value).await?;
        tx.commit().await?;
        Ok(value)
    }
    pub async fn put_context_set(
        &self,
        principal: &str,
        input: &PutContextSetRequest,
    ) -> Result<ContextSet> {
        operator(principal)?;
        name("operation ID", &input.operation_id)?;
        let hash = digest("put-context", input);
        let (mut tx, _) = self.write().await?;
        if let Some(value) = replay(&mut tx, principal, &input.operation_id, &hash).await? {
            return Ok(value);
        }
        let value = prepare_resource(
            &mut tx,
            input
                .context_set
                .clone()
                .ok_or_else(|| invalid("Context Set is required"))?,
            input.expected_revision,
        )
        .await?;
        save_resource(&mut tx, &value).await?;
        receipt(&mut tx, principal, &input.operation_id, &hash, &value).await?;
        tx.commit().await?;
        Ok(value)
    }
    pub async fn put_role(&self, principal: &str, input: &PutRoleRequest) -> Result<Role> {
        operator(principal)?;
        name("operation ID", &input.operation_id)?;
        let hash = digest("put-role", input);
        let (mut tx, _) = self.write().await?;
        if let Some(value) = replay(&mut tx, principal, &input.operation_id, &hash).await? {
            return Ok(value);
        }
        let mut value: Role = prepare_resource(
            &mut tx,
            input
                .role
                .clone()
                .ok_or_else(|| invalid("Role is required"))?,
            input.expected_revision,
        )
        .await?;
        let mut permissions = BTreeSet::new();
        for id in &value.permission_set_ids {
            permissions.insert(resource::<PermissionSet>(&mut tx, id).await?.set_id);
        }
        value.permission_set_ids = permissions.into_iter().collect();
        let mut contexts = BTreeSet::new();
        for id in &value.context_set_ids {
            contexts.insert(resource::<ContextSet>(&mut tx, id).await?.set_id);
        }
        value.context_set_ids = contexts.into_iter().collect();
        sqlx::query("INSERT INTO supertag_v2_roles (role_id,name,revision,status,payload) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(role_id) DO UPDATE SET revision=excluded.revision,status=excluded.status,payload=excluded.payload").bind(&value.role_id).bind(&value.name).bind(value.revision as i64).bind(value.status as i64).bind(value.encode_to_vec()).execute(&mut *tx).await?;
        for table in [
            "supertag_v2_role_permission_sets",
            "supertag_v2_role_context_sets",
        ] {
            sqlx::query(&format!("DELETE FROM {table} WHERE role_id=$1"))
                .bind(&value.role_id)
                .execute(&mut *tx)
                .await?;
        }
        for (table, ids) in [
            (
                "supertag_v2_role_permission_sets",
                &value.permission_set_ids,
            ),
            ("supertag_v2_role_context_sets", &value.context_set_ids),
        ] {
            for id in ids {
                sqlx::query(&format!(
                    "INSERT INTO {table} (role_id,set_id) VALUES ($1,$2)"
                ))
                .bind(&value.role_id)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            }
        }
        receipt(&mut tx, principal, &input.operation_id, &hash, &value).await?;
        tx.commit().await?;
        Ok(value)
    }
    pub async fn get_permission_set(
        &self,
        principal: &str,
        reference: &str,
    ) -> Result<PermissionSet> {
        operator(principal)?;
        name("policy reference", reference)?;
        resource(&mut self.pool.begin().await?, reference).await
    }
    pub async fn get_context_set(&self, principal: &str, reference: &str) -> Result<ContextSet> {
        operator(principal)?;
        name("policy reference", reference)?;
        resource(&mut self.pool.begin().await?, reference).await
    }
    pub async fn get_role(&self, principal: &str, reference: &str) -> Result<Role> {
        operator(principal)?;
        name("policy reference", reference)?;
        resource(&mut self.pool.begin().await?, reference).await
    }
    pub async fn list_permission_sets(
        &self,
        principal: &str,
        input: &ListPolicyResourcesRequest,
    ) -> Result<ListPermissionSetsResponse> {
        operator(principal)?;
        let (permission_sets, next_cursor) = list(&mut self.pool.begin().await?, input).await?;
        Ok(ListPermissionSetsResponse {
            permission_sets,
            next_cursor,
        })
    }
    pub async fn list_context_sets(
        &self,
        principal: &str,
        input: &ListPolicyResourcesRequest,
    ) -> Result<ListContextSetsResponse> {
        operator(principal)?;
        let (context_sets, next_cursor) = list(&mut self.pool.begin().await?, input).await?;
        Ok(ListContextSetsResponse {
            context_sets,
            next_cursor,
        })
    }
    pub async fn list_roles(
        &self,
        principal: &str,
        input: &ListPolicyResourcesRequest,
    ) -> Result<ListRolesResponse> {
        operator(principal)?;
        let (roles, next_cursor) = list(&mut self.pool.begin().await?, input).await?;
        Ok(ListRolesResponse { roles, next_cursor })
    }
    pub async fn delete_permission_set(
        &self,
        principal: &str,
        input: &DeletePolicyResourceRequest,
    ) -> Result<DeletePolicyResourceResponse> {
        self.delete_policy::<PermissionSet>(
            principal,
            input,
            "supertag_v2_role_permission_sets",
            "supertag_v2_surface_location_permission_sets",
        )
        .await
    }
    pub async fn delete_context_set(
        &self,
        principal: &str,
        input: &DeletePolicyResourceRequest,
    ) -> Result<DeletePolicyResourceResponse> {
        self.delete_policy::<ContextSet>(
            principal,
            input,
            "supertag_v2_role_context_sets",
            "supertag_v2_surface_location_context_sets",
        )
        .await
    }
    async fn delete_policy<M: Resource>(
        &self,
        principal: &str,
        input: &DeletePolicyResourceRequest,
        references: &str,
        locations: &str,
    ) -> Result<DeletePolicyResourceResponse> {
        operator(principal)?;
        name("operation ID", &input.operation_id)?;
        name("policy reference", &input.reference)?;
        let hash = digest(&format!("delete-{}", M::KIND), input);
        let (mut tx, _) = self.write().await?;
        if let Some(value) = replay(&mut tx, principal, &input.operation_id, &hash).await? {
            return Ok(value);
        }
        let value = resource::<M>(&mut tx, &input.reference).await?;
        if input.expected_revision != value.revision() {
            return Err(StoreError::Conflict("policy revision changed".into()));
        }
        let reference: Option<String> = sqlx::query_scalar(&format!(
            "SELECT role_id FROM {references} WHERE set_id=$1 LIMIT 1"
        ))
        .bind(value.id())
        .fetch_optional(&mut *tx)
        .await?;
        if reference.is_some() {
            return Err(StoreError::FailedPrecondition(
                "policy Set is still referenced by a Role".into(),
            ));
        }
        let location: Option<String> = sqlx::query_scalar(&format!(
            "SELECT location_id FROM {locations} WHERE set_id=$1 LIMIT 1"
        ))
        .bind(value.id())
        .fetch_optional(&mut *tx)
        .await?;
        if location.is_some() {
            return Err(StoreError::FailedPrecondition(
                "policy Set is still referenced by a Surface location".into(),
            ));
        }
        sqlx::query(&format!("DELETE FROM {} WHERE {}=$1", M::TABLE, M::KEY))
            .bind(value.id())
            .execute(&mut *tx)
            .await?;
        let response = DeletePolicyResourceResponse { deleted: true };
        receipt(&mut tx, principal, &input.operation_id, &hash, &response).await?;
        tx.commit().await?;
        Ok(response)
    }
    pub async fn assign_role(
        &self,
        principal: &str,
        input: &AssignRoleRequest,
    ) -> Result<RoleAssignment> {
        operator(principal)?;
        name("operation ID", &input.operation_id)?;
        name("Tag ID", &input.tag_id)?;
        name("Role reference", &input.role)?;
        let hash = digest("assign-role", input);
        let (mut tx, _) = self.write().await?;
        if let Some(value) = replay(&mut tx, principal, &input.operation_id, &hash).await? {
            return Ok(value);
        }
        let role = resource::<Role>(&mut tx, &input.role).await?;
        if role.status != RoleStatus::Active as i32 {
            return Err(StoreError::FailedPrecondition(
                "only active Roles can be assigned".into(),
            ));
        }
        let tag: Option<String> =
            sqlx::query_scalar("SELECT tag_id FROM supertag_v2_tags WHERE tag_id=$1")
                .bind(&input.tag_id)
                .fetch_optional(&mut *tx)
                .await?;
        if tag.is_none() {
            return Err(StoreError::NotFound("Tag was not found".into()));
        }
        let prior = sqlx::query(
            "SELECT * FROM supertag_v2_role_assignments WHERE role_id=$1 AND tag_id=$2",
        )
        .bind(&role.role_id)
        .bind(&input.tag_id)
        .fetch_optional(&mut *tx)
        .await?;
        let mut assignment = if let Some(row) = prior {
            assignment_row(&row)?
        } else {
            RoleAssignment {
                assignment_id: Uuid::new_v4().to_string(),
                role_id: role.role_id,
                tag_id: input.tag_id.clone(),
                status: RoleAssignmentStatus::Active as i32,
                revision: 1,
            }
        };
        if assignment.status == RoleAssignmentStatus::Inactive as i32 {
            assignment.status = RoleAssignmentStatus::Active as i32;
            assignment.revision = increment(assignment.revision)?;
        }
        save_assignment(&mut tx, &assignment).await?;
        receipt(&mut tx, principal, &input.operation_id, &hash, &assignment).await?;
        tx.commit().await?;
        Ok(assignment)
    }
    pub async fn deactivate_role_assignment(
        &self,
        principal: &str,
        input: &DeactivateRoleAssignmentRequest,
    ) -> Result<RoleAssignment> {
        operator(principal)?;
        name("operation ID", &input.operation_id)?;
        name("assignment ID", &input.assignment_id)?;
        let hash = digest("deactivate-role", input);
        let (mut tx, _) = self.write().await?;
        if let Some(value) = replay(&mut tx, principal, &input.operation_id, &hash).await? {
            return Ok(value);
        }
        let row = sqlx::query("SELECT * FROM supertag_v2_role_assignments WHERE assignment_id=$1")
            .bind(&input.assignment_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| StoreError::NotFound("Role assignment was not found".into()))?;
        let mut assignment = assignment_row(&row)?;
        if input.expected_revision != assignment.revision {
            return Err(StoreError::Conflict(
                "Role assignment revision changed".into(),
            ));
        }
        if assignment.status != RoleAssignmentStatus::Inactive as i32 {
            assignment.status = RoleAssignmentStatus::Inactive as i32;
            assignment.revision = increment(assignment.revision)?;
            save_assignment(&mut tx, &assignment).await?;
        }
        receipt(&mut tx, principal, &input.operation_id, &hash, &assignment).await?;
        tx.commit().await?;
        Ok(assignment)
    }
    pub async fn list_role_assignments(
        &self,
        principal: &str,
        input: &ListRoleAssignmentsRequest,
    ) -> Result<ListRoleAssignmentsResponse> {
        operator(principal)?;
        if !matches!(input.status, 0..=2) {
            return Err(invalid("invalid Role assignment status"));
        }
        let mut tx = self.pool.begin().await?;
        let role = if input.role.is_empty() {
            String::new()
        } else {
            resource::<Role>(&mut tx, &input.role).await?.role_id
        };
        let scope = serde_json::to_string(&(&role, &input.tag_id, input.status))?;
        let (limit, after) = page(
            &ListPolicyResourcesRequest {
                limit: input.limit,
                cursor: input.cursor.clone(),
            },
            "assignments",
            &scope,
        )?;
        let rows=sqlx::query("SELECT * FROM supertag_v2_role_assignments WHERE ($1='' OR role_id=$1) AND ($2='' OR tag_id=$2) AND ($3=0 OR status=$3) AND assignment_id>$4 ORDER BY assignment_id LIMIT $5").bind(role).bind(&input.tag_id).bind(input.status as i64).bind(after).bind((limit+1) as i64).fetch_all(&mut *tx).await?;
        let more = rows.len() > limit;
        let assignments = rows
            .iter()
            .take(limit)
            .map(assignment_row)
            .collect::<Result<Vec<_>>>()?;
        let cursor = if more {
            next_cursor(
                "assignments",
                &scope,
                &assignments.last().expect("nonempty page").assignment_id,
            )?
        } else {
            String::new()
        };
        Ok(ListRoleAssignmentsResponse {
            assignments,
            next_cursor: cursor,
        })
    }
}
fn increment(revision: u64) -> Result<u64> {
    revision
        .checked_add(1)
        .filter(|n| *n <= i64::MAX as u64)
        .ok_or_else(|| invalid("policy revision exhausted"))
}
fn assignment_row(row: &AnyRow) -> Result<RoleAssignment> {
    Ok(RoleAssignment {
        assignment_id: row.try_get("assignment_id")?,
        role_id: row.try_get("role_id")?,
        tag_id: row.try_get("tag_id")?,
        status: row.try_get::<i64, _>("status")? as i32,
        revision: row.try_get::<i64, _>("revision")? as u64,
    })
}
async fn save_assignment(tx: &mut Transaction<'_, Any>, a: &RoleAssignment) -> Result<()> {
    sqlx::query("INSERT INTO supertag_v2_role_assignments (assignment_id,role_id,tag_id,status,revision) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(assignment_id) DO UPDATE SET status=excluded.status,revision=excluded.revision").bind(&a.assignment_id).bind(&a.role_id).bind(&a.tag_id).bind(a.status as i64).bind(a.revision as i64).execute(&mut **tx).await?;
    Ok(())
}

pub(crate) struct AdmissionBase<'a> {
    pub instructions: &'a str,
    pub allowed_actions: &'a [String],
    pub harness_kind: i32,
    pub approval_rules: &'a [ApprovalRule],
}
pub(crate) struct AdmissionPolicy {
    pub instructions: String,
    pub allowed_actions: Vec<String>,
    pub harness_kind: i32,
    pub approval_rules: Vec<ApprovalRule>,
    pub snapshot: TaskPolicySnapshot,
    pub effective_digest: String,
}

pub(crate) async fn admission_in(
    tx: &mut Transaction<'_, Any>,
    tag_id: &str,
    base: AdmissionBase<'_>,
    surface: Option<&AdmissionSurface>,
) -> Result<AdmissionPolicy> {
    let rows=sqlx::query("SELECT a.* FROM supertag_v2_role_assignments a JOIN supertag_v2_roles r ON a.role_id=r.role_id WHERE a.tag_id=$1 AND a.status=1 AND r.status=1 ORDER BY a.role_id,a.assignment_id").bind(tag_id).fetch_all(&mut **tx).await?;
    if rows.len() > 128 {
        return Err(StoreError::FailedPrecondition(
            "too many active Role assignments to admit a Task".into(),
        ));
    }
    let mut snapshot = TaskPolicySnapshot {
        version: 1,
        origin: surface.map(|surface| surface.origin.clone()),
        ..Default::default()
    };
    let mut permission_ids = BTreeSet::new();
    let mut context_ids = BTreeSet::new();
    if let Some(surface) = surface {
        permission_ids.extend(surface.permission_set_ids.iter().cloned());
        context_ids.extend(surface.context_set_ids.iter().cloned());
    }
    let mut instructions = base.instructions.to_owned();
    for row in rows {
        let assignment = assignment_row(&row)?;
        let role = resource::<Role>(tx, &assignment.role_id).await?;
        permission_ids.extend(role.permission_set_ids.clone());
        context_ids.extend(role.context_set_ids.clone());
        instructions.push_str(&format!(
            "\n\nYou are acting in the {} Role.\nPurpose: {}\n{}",
            role.name, role.purpose, role.instructions
        ));
        snapshot.roles.push(PolicyRoleSnapshot {
            assignment: Some(assignment),
            role: Some(role),
        });
    }
    if instructions.len() > 256 * 1024 {
        return Err(invalid("composed Task instructions exceed 256 KiB"));
    }
    for id in permission_ids {
        snapshot
            .permission_sets
            .push(resource::<PermissionSet>(tx, &id).await?);
    }
    snapshot
        .permission_sets
        .sort_by(|a, b| a.name.cmp(&b.name).then(a.set_id.cmp(&b.set_id)));
    for id in context_ids {
        snapshot
            .context_sets
            .push(resource::<ContextSet>(tx, &id).await?);
    }
    snapshot
        .context_sets
        .sort_by(|a, b| a.name.cmp(&b.name).then(a.set_id.cmp(&b.set_id)));
    // A location can select a Set, but artifact selection still needs its own
    // admission-time resolver. An unresolved item must never grant access.
    if snapshot
        .context_sets
        .iter()
        .flat_map(|s| &s.items)
        .any(|i| i.r#type == "supertag/artifacts")
    {
        return Err(StoreError::FailedPrecondition(
            "artifact context requires a supported surface selection resolver".into(),
        ));
    }
    let mut actions: BTreeSet<String> = base.allowed_actions.iter().cloned().collect();
    let mut approvals = BTreeMap::new();
    for rule in base.approval_rules {
        merge_runtime_requirement(&mut approvals, base_runtime_requirement(rule));
    }
    for set in &snapshot.permission_sets {
        for permission in &set.permissions {
            if permission.target != PolicyPermissionTarget::Runtime as i32 {
                continue;
            }
            actions.insert(permission.action.clone());
            if permission.approval_required {
                merge_runtime_requirement(
                    &mut approvals,
                    RuntimeApprovalRequirement {
                        action: permission.action.clone(),
                        permission_set_ids: vec![set.set_id.clone()],
                        approvers: set.approvers.clone(),
                    },
                );
            }
        }
    }
    let mut execution_roles: Vec<&Role> = snapshot
        .roles
        .iter()
        .filter_map(|r| r.role.as_ref())
        .collect();
    execution_roles.sort_by(|a, b| a.name.cmp(&b.name).then(a.role_id.cmp(&b.role_id)));
    let base_harness = match HarnessKind::try_from(base.harness_kind) {
        Ok(HarnessKind::Codex) => Some("codex"),
        Ok(HarnessKind::ClaudeCode) => Some("claude-code"),
        Ok(HarnessKind::OpenaiAgents) => Some("openai-agents"),
        _ => None,
    };
    let harness = base_harness.map(str::to_owned).or_else(|| {
        execution_roles
            .iter()
            .find_map(|r| r.execution.as_ref().and_then(|e| e.harness.clone()))
    });
    let models = execution_roles
        .iter()
        .filter_map(|r| r.execution.as_ref())
        .find(|e| !e.models.is_empty() && (e.harness.is_none() || e.harness == harness))
        .map(|e| e.models.clone())
        .unwrap_or_default();
    let efforts = execution_roles
        .iter()
        .filter_map(|r| r.execution.as_ref())
        .find(|e| !e.efforts.is_empty())
        .map(|e| e.efforts.clone())
        .unwrap_or_else(|| vec!["low".into(), "medium".into(), "high".into()]);
    let has_execution = execution_roles.iter().any(|r| r.execution.is_some());
    if has_execution {
        snapshot.execution = Some(PolicyExecutionSettings {
            harness: harness.clone(),
            models,
            efforts,
        });
    }
    let harness_kind = match harness.as_deref() {
        None => base.harness_kind,
        Some("codex") => HarnessKind::Codex as i32,
        Some("claude-code") => HarnessKind::ClaudeCode as i32,
        Some("openai-agents") => HarnessKind::OpenaiAgents as i32,
        Some(_) => {
            return Err(StoreError::FailedPrecondition(
                "Role requires a harness this runtime does not support".into(),
            ));
        }
    };
    let mut policy = AdmissionPolicy {
        instructions,
        allowed_actions: Vec::new(),
        harness_kind,
        approval_rules: Vec::new(),
        snapshot,
        effective_digest: String::new(),
    };
    project_runtime(
        &mut policy,
        TaskRuntimeAuthority {
            actions: actions.into_iter().collect(),
            approvals: approvals.into_values().collect(),
            ..Default::default()
        },
    )?;
    Ok(policy)
}

const DELEGATE_WRITE: &str = "files:delegate-write";
const FILES_WRITE: &str = "files:write";

fn base_runtime_requirement(rule: &ApprovalRule) -> RuntimeApprovalRequirement {
    RuntimeApprovalRequirement {
        action: rule.action.clone(),
        permission_set_ids: Vec::new(),
        approvers: rule
            .operator_ids
            .iter()
            .map(|id| format!("operator:{id}"))
            .collect(),
    }
}

fn merge_runtime_requirement(
    requirements: &mut BTreeMap<String, RuntimeApprovalRequirement>,
    requirement: RuntimeApprovalRequirement,
) {
    let RuntimeApprovalRequirement {
        action,
        permission_set_ids,
        approvers,
    } = requirement;
    let current =
        requirements
            .entry(action.clone())
            .or_insert_with(|| RuntimeApprovalRequirement {
                action,
                ..Default::default()
            });
    current.permission_set_ids.extend(permission_set_ids);
    current.permission_set_ids.sort();
    current.permission_set_ids.dedup();
    current.approvers.extend(approvers);
    current.approvers.sort();
    current.approvers.dedup();
}

fn supported_runtime_gate(action: &str) -> bool {
    matches!(action, WORKSTREAM_POST_ACTION | MAILBOX_SEND_ACTION)
}

fn project_runtime(
    policy: &mut AdmissionPolicy,
    mut authority: TaskRuntimeAuthority,
) -> Result<()> {
    authority.actions.sort();
    authority.actions.dedup();
    let requirements: BTreeMap<&str, &RuntimeApprovalRequirement> = authority
        .approvals
        .iter()
        .map(|requirement| (requirement.action.as_str(), requirement))
        .collect();
    policy.allowed_actions = authority
        .actions
        .iter()
        .filter(|action| {
            action.as_str() != DELEGATE_WRITE
                && requirements.get(action.as_str()).is_none_or(|requirement| {
                    supported_runtime_gate(action)
                        && (requirement.approvers.is_empty()
                            || requirement
                                .approvers
                                .iter()
                                .any(|id| id.starts_with("operator:")))
                })
        })
        .cloned()
        .collect();
    // Keep configured effect gates even if the Objective removed their grant.
    // The effect boundary checks allowed_actions before offering approval.
    policy.approval_rules = authority
        .approvals
        .iter()
        .filter(|requirement| supported_runtime_gate(&requirement.action))
        .map(|requirement| ApprovalRule {
            action: requirement.action.clone(),
            operator_ids: requirement
                .approvers
                .iter()
                .filter_map(|id| id.strip_prefix("operator:").map(str::to_owned))
                .collect(),
        })
        .collect();
    authority
        .approvals
        .retain(|requirement| authority.actions.binary_search(&requirement.action).is_ok());
    policy.snapshot.runtime_authority = Some(authority);
    size(&policy.snapshot, SNAPSHOT_BYTES)?;
    policy.effective_digest = effective_digest(&policy.snapshot)?;
    Ok(())
}

pub(crate) fn runtime_authority(task: &Task) -> TaskRuntimeAuthority {
    if let Some(authority) = task
        .policy_snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.runtime_authority.as_ref())
    {
        return authority.clone();
    }
    let mut actions = task.allowed_actions.clone();
    actions.sort();
    actions.dedup();
    let mut approvals = BTreeMap::new();
    for rule in &task.approval_rules {
        if actions.binary_search(&rule.action).is_ok() {
            merge_runtime_requirement(&mut approvals, base_runtime_requirement(rule));
        }
    }
    TaskRuntimeAuthority {
        actions,
        approvals: approvals.into_values().collect(),
        ..Default::default()
    }
}

pub(crate) fn apply_objective_runtime(
    policy: &mut AdmissionPolicy,
    objective_id: &str,
    revision: u64,
    actions: Vec<String>,
) -> Result<()> {
    let mut authority = policy.snapshot.runtime_authority.take().unwrap_or_default();
    let mut requirements = BTreeMap::new();
    for rule in &policy.approval_rules {
        if !authority
            .approvals
            .iter()
            .any(|gate| gate.action == rule.action)
        {
            merge_runtime_requirement(&mut requirements, base_runtime_requirement(rule));
        }
    }
    for requirement in authority.approvals {
        merge_runtime_requirement(&mut requirements, requirement);
    }
    authority.actions = actions;
    authority.approvals = requirements.into_values().collect();
    authority.objective_id = Some(objective_id.to_owned());
    authority.objective_revision = Some(revision);
    project_runtime(policy, authority)
}

pub(crate) fn apply_delegated_runtime(
    policy: &mut AdmissionPolicy,
    parent: &Task,
    objective_id: &str,
    revision: u64,
    objective_actions: &[String],
) -> Result<()> {
    let target = policy.snapshot.runtime_authority.take().unwrap_or_default();
    let source = runtime_authority(parent);
    let mut actions: BTreeSet<String> = source
        .actions
        .into_iter()
        .filter(|action| objective_actions.contains(action))
        .collect();
    let delegated_write = actions.contains(DELEGATE_WRITE)
        && target.actions.iter().any(|action| action == FILES_WRITE);
    if delegated_write {
        actions.insert(FILES_WRITE.to_owned());
    }
    let mut approvals = BTreeMap::new();
    for rule in policy.approval_rules.iter().chain(&parent.approval_rules) {
        // Preserve configured effects which the semantic grant set excluded.
        if !target
            .approvals
            .iter()
            .chain(&source.approvals)
            .any(|gate| gate.action == rule.action)
        {
            merge_runtime_requirement(&mut approvals, base_runtime_requirement(rule));
        }
    }
    for requirement in target.approvals {
        merge_runtime_requirement(&mut approvals, requirement);
    }
    for requirement in source.approvals {
        if delegated_write && requirement.action == DELEGATE_WRITE {
            merge_runtime_requirement(
                &mut approvals,
                RuntimeApprovalRequirement {
                    action: FILES_WRITE.to_owned(),
                    ..requirement.clone()
                },
            );
        }
        merge_runtime_requirement(&mut approvals, requirement);
    }
    project_runtime(
        policy,
        TaskRuntimeAuthority {
            actions: actions.into_iter().collect(),
            approvals: approvals.into_values().collect(),
            objective_id: Some(objective_id.to_owned()),
            objective_revision: Some(revision),
            delegating_task_id: Some(parent.task_id.clone()),
        },
    )
}

/// Semantic policy excludes mutable catalog identity, revisions and capture time.
/// Instructions, direct actions, harness and workspace are separately fenced.
fn effective_digest(snapshot: &TaskPolicySnapshot) -> Result<String> {
    let mut permissions: BTreeMap<String, (bool, BTreeSet<String>, BTreeSet<String>)> =
        BTreeMap::new();
    for set in &snapshot.permission_sets {
        for p in &set.permissions {
            // Runtime grants are already represented by accepted allowed_actions.
            if p.target == PolicyPermissionTarget::Runtime as i32 && !p.approval_required {
                continue;
            }
            let key = serde_json::to_string(&(
                p.target,
                &p.action,
                &p.surface_account_id,
                &p.scope,
                &p.resource,
            ))?;
            let entry = permissions.entry(key).or_default();
            entry.0 |= p.approval_required;
            if p.approval_required {
                entry.1.extend(set.approvers.iter().cloned());
            }
            if !p.reference.is_empty() {
                entry.2.insert(p.reference.clone());
            }
        }
    }
    let mut contexts = BTreeSet::new();
    for set in &snapshot.context_sets {
        for i in &set.items {
            contexts.insert(serde_json::to_string(&(
                &i.item_key,
                &i.r#type,
                i.version,
                i.required,
                &i.config_json,
            ))?);
        }
    }
    // Harness is separately fenced. An explicit default effort range has the
    // same meaning as the implicit range, regardless of the Role that named it.
    let execution = snapshot.execution.as_ref().and_then(|e| {
        let efforts = if e.efforts.is_empty() || e.efforts == ["low", "medium", "high"] {
            &[][..]
        } else {
            e.efforts.as_slice()
        };
        if e.models.is_empty() && efforts.is_empty() {
            None
        } else {
            Some((&e.models, efforts))
        }
    });
    let runtime = snapshot.runtime_authority.as_ref().and_then(|authority| {
        // Executable actions are already compared on the Task. The marker and
        // typed gates are additional authority a live-input join must match.
        let delegate_write = authority
            .actions
            .iter()
            .any(|action| action == DELEGATE_WRITE);
        if !delegate_write && authority.approvals.is_empty() {
            return None;
        }
        let approvals: Vec<_> = authority
            .approvals
            .iter()
            .map(|requirement| (&requirement.action, &requirement.approvers))
            .collect();
        Some((delegate_write, approvals))
    });
    if permissions.is_empty()
        && contexts.is_empty()
        && execution.is_none()
        && snapshot.origin.is_none()
        && runtime.is_none()
    {
        return Ok(String::new());
    }
    let mut encoded = serde_json::to_vec(&(permissions, contexts, execution))?;
    if let Some(runtime) = runtime {
        encoded.extend(serde_json::to_vec(&runtime)?);
    }
    if let Some(origin) = &snapshot.origin {
        let coordinates = origin.scope.as_ref().map(Message::encode_to_vec);
        encoded.extend(serde_json::to_vec(&(
            &origin.account_id,
            &origin.connector_account_id,
            coordinates,
            &origin.origin_actions,
        ))?);
    }
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

impl ControlPlane {
    pub fn policy_service(&self) -> policy_catalog_server::PolicyCatalogServer<Self> {
        policy_catalog_server::PolicyCatalogServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl policy_catalog_server::PolicyCatalog for ControlPlane {
    async fn put_permission_set(
        &self,
        request: Request<PutPermissionSetRequest>,
    ) -> std::result::Result<Response<PermissionSet>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .put_permission_set(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn get_permission_set(
        &self,
        request: Request<GetPolicyResourceRequest>,
    ) -> std::result::Result<Response<PermissionSet>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .get_permission_set(&principal, &request.get_ref().reference)
                .await?,
        ))
    }
    async fn list_permission_sets(
        &self,
        request: Request<ListPolicyResourcesRequest>,
    ) -> std::result::Result<Response<ListPermissionSetsResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_permission_sets(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn delete_permission_set(
        &self,
        request: Request<DeletePolicyResourceRequest>,
    ) -> std::result::Result<Response<DeletePolicyResourceResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .delete_permission_set(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn put_context_set(
        &self,
        request: Request<PutContextSetRequest>,
    ) -> std::result::Result<Response<ContextSet>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .put_context_set(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn get_context_set(
        &self,
        request: Request<GetPolicyResourceRequest>,
    ) -> std::result::Result<Response<ContextSet>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .get_context_set(&principal, &request.get_ref().reference)
                .await?,
        ))
    }
    async fn list_context_sets(
        &self,
        request: Request<ListPolicyResourcesRequest>,
    ) -> std::result::Result<Response<ListContextSetsResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_context_sets(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn delete_context_set(
        &self,
        request: Request<DeletePolicyResourceRequest>,
    ) -> std::result::Result<Response<DeletePolicyResourceResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .delete_context_set(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn put_role(
        &self,
        request: Request<PutRoleRequest>,
    ) -> std::result::Result<Response<Role>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store.put_role(&principal, request.get_ref()).await?,
        ))
    }
    async fn get_role(
        &self,
        request: Request<GetPolicyResourceRequest>,
    ) -> std::result::Result<Response<Role>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .get_role(&principal, &request.get_ref().reference)
                .await?,
        ))
    }
    async fn list_roles(
        &self,
        request: Request<ListPolicyResourcesRequest>,
    ) -> std::result::Result<Response<ListRolesResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store.list_roles(&principal, request.get_ref()).await?,
        ))
    }
    async fn assign_role(
        &self,
        request: Request<AssignRoleRequest>,
    ) -> std::result::Result<Response<RoleAssignment>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .assign_role(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn list_role_assignments(
        &self,
        request: Request<ListRoleAssignmentsRequest>,
    ) -> std::result::Result<Response<ListRoleAssignmentsResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_role_assignments(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn deactivate_role_assignment(
        &self,
        request: Request<DeactivateRoleAssignmentRequest>,
    ) -> std::result::Result<Response<RoleAssignment>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .deactivate_role_assignment(&principal, request.get_ref())
                .await?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_policy_ignores_catalog_identity_and_unions_required_approvers() {
        let grant = PolicyPermission {
            target: PolicyPermissionTarget::Mcp as i32,
            action: "issues/get".into(),
            resource: "repository:acme/api".into(),
            approval_required: true,
            ..Default::default()
        };
        let mut snapshot = TaskPolicySnapshot {
            version: 1,
            permission_sets: vec![
                PermissionSet {
                    set_id: "one".into(),
                    name: "One".into(),
                    revision: 1,
                    approvers: vec!["operator:alice".into()],
                    permissions: vec![grant.clone()],
                },
                PermissionSet {
                    set_id: "two".into(),
                    name: "Two".into(),
                    revision: 2,
                    approvers: vec!["operator:bob".into()],
                    permissions: vec![grant.clone()],
                },
            ],
            ..Default::default()
        };
        let original = effective_digest(&snapshot).unwrap();
        snapshot.permission_sets = vec![PermissionSet {
            set_id: "combined".into(),
            name: "Combined".into(),
            revision: 123,
            approvers: vec!["operator:bob".into(), "operator:alice".into()],
            permissions: vec![PolicyPermission {
                permission_id: "new-identity".into(),
                ..grant
            }],
        }];
        assert_eq!(original, effective_digest(&snapshot).unwrap());
        snapshot.permission_sets[0].permissions[0].resource = "repository:acme/other".into();
        assert_ne!(original, effective_digest(&snapshot).unwrap());
    }

    #[test]
    fn direct_runtime_and_default_execution_add_no_extended_fence() {
        let snapshot = TaskPolicySnapshot {
            version: 1,
            permission_sets: vec![PermissionSet {
                permissions: vec![PolicyPermission {
                    target: PolicyPermissionTarget::Runtime as i32,
                    action: "files:read".into(),
                    ..Default::default()
                }],
                ..Default::default()
            }],
            execution: Some(PolicyExecutionSettings {
                harness: Some("codex".into()),
                models: vec![],
                efforts: vec!["low".into(), "medium".into(), "high".into()],
            }),
            ..Default::default()
        };
        assert_eq!(effective_digest(&snapshot).unwrap(), "");
    }

    #[test]
    fn context_configuration_and_execution_order_remain_semantic() {
        let mut snapshot = TaskPolicySnapshot {
            version: 1,
            context_sets: vec![ContextSet {
                set_id: "one".into(),
                name: "Knowledge".into(),
                revision: 1,
                items: vec![PolicyContextItem {
                    item_id: "old".into(),
                    item_key: "style".into(),
                    r#type: "example/style".into(),
                    version: 1,
                    required: true,
                    config_json: r#"{"content":"Original"}"#.into(),
                }],
            }],
            execution: Some(PolicyExecutionSettings {
                models: vec!["one".into(), "two".into()],
                ..Default::default()
            }),
            ..Default::default()
        };
        let original = effective_digest(&snapshot).unwrap();
        snapshot.context_sets[0].set_id = "new".into();
        snapshot.context_sets[0].revision = 99;
        snapshot.context_sets[0].items[0].item_id = "new-item".into();
        assert_eq!(original, effective_digest(&snapshot).unwrap());
        snapshot.execution.as_mut().unwrap().models.reverse();
        assert_ne!(original, effective_digest(&snapshot).unwrap());
        snapshot.execution.as_mut().unwrap().models.reverse();
        snapshot.context_sets[0].items[0].required = false;
        assert_ne!(original, effective_digest(&snapshot).unwrap());
    }
}
