//! Declarative organization configuration over the authenticated Control Plane API.
use std::{
    collections::BTreeSet,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail, ensure};
use clap::Args;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::Value;
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::v2::*;

use crate::{
    Connection,
    policy::{ContextSpec, ExecutionSpec, PermissionSpec, RoleSpec},
    surface_policy::{AccountSpec, LocationSpec},
};

mod plan;

const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_MANIFESTS: usize = 256;
const MAX_REFERENCES: usize = 256;

#[derive(Args)]
pub struct ManifestArgs {
    #[command(flatten)]
    connection: Connection,
    /// YAML documents, a JSON array, a directory of manifests, or - for stdin.
    #[arg(short = 'f', long = "file", required = true)]
    files: Vec<PathBuf>,
    /// Apply as this apply set: it owns the Tag relationships it declares and
    /// the resources it creates.
    #[arg(long = "set")]
    manager: Option<String>,
    /// Remove the apply set's resources that the input no longer declares.
    #[arg(long, requires = "manager")]
    prune: bool,
    /// Take ownership of fields another apply set, or a change outside apply,
    /// set to a different value.
    #[arg(long)]
    force_conflicts: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
enum Kind {
    SurfaceAccount,
    Volume,
    Workspace,
    ContextSet,
    PermissionSet,
    Role,
    Tag,
    Team,
    SurfaceLocation,
    Objective,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    api_version: String,
    kind: Kind,
    metadata: Metadata,
    spec: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct VolumeSpec {
    source: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WorkspaceSourceSpec {
    account_id: String,
    repository_id: u64,
    repository: String,
    commit_sha: Option<String>,
    revision: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WorkspaceSpecInput {
    github: WorkspaceSourceSpec,
    pull_request_base: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WorkspaceBinding {
    id: String,
    /// A full commit every Session starts from.
    base_commit: Option<String>,
    /// A local Workspace branch whose current commit each new Session starts from.
    #[serde(rename = "ref")]
    base_ref: Option<String>,
    /// Servers the Workspace's `.mcp.json` declares that the Tag's Tasks may use.
    #[serde(default)]
    mcp: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TagSpec {
    instructions: Option<String>,
    allowed_actions: Option<Vec<String>>,
    workspace: Option<WorkspaceBinding>,
    execution: Option<ExecutionSpec>,
    #[serde(default)]
    roles: Vec<String>,
    #[serde(default)]
    accepts_messages_from: Vec<String>,
    /// Labels a bound Worker Host must carry. Omitted keeps the current labels.
    runs_on: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TeamSpec {
    name: Option<String>,
    members: Option<Vec<String>>,
    max_concurrency: Option<u32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ObjectiveSpec {
    #[serde(alias = "ownerTag")]
    owner_tag_id: String,
    outcome: String,
    #[serde(default)]
    ongoing: bool,
    deadline_ms: Option<i64>,
    deadline: Option<String>,
    budget_limit_minor: Option<u64>,
    budget_currency: Option<String>,
    team: Option<String>,
    runtime_actions: Option<Vec<String>>,
}

enum Resource {
    SurfaceAccount(SurfaceAccount),
    Volume(String),
    Workspace(GithubWorkspace),
    ContextSet(ContextSet),
    PermissionSet(PermissionSet),
    Role(Role),
    Tag(TagSpec),
    Team(TeamSpec),
    SurfaceLocation(SurfaceLocation),
    Objective(ObjectiveSpec),
}

struct Manifest {
    kind: Kind,
    name: String,
    source: String,
    resource: Resource,
}

fn typed<T: DeserializeOwned>(value: Value, kind: Kind) -> Result<T> {
    // Serde's error for an unknown value can contain text from the manifest.
    serde_json::from_value(value).map_err(|error| {
        // Missing field names come from our schema. Never echo supplied values or field names.
        let message = error.to_string();
        if message.starts_with("missing field `") {
            anyhow::anyhow!("invalid {kind:?} spec: {message}")
        } else {
            anyhow::anyhow!("invalid {kind:?} spec")
        }
    })
}

fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn same_identity(identity: &str, name: &str) -> Result<()> {
    ensure!(
        identity.is_empty() || identity == name,
        "spec identity must match metadata.name"
    );
    Ok(())
}

fn manifest(value: Value, source: &str) -> Result<Manifest> {
    let Envelope {
        api_version,
        kind,
        metadata: Metadata { name },
        spec,
    } = serde_json::from_value(value).map_err(|_| anyhow::anyhow!("invalid manifest envelope"))?;
    ensure!(
        api_version == "supertag/v1",
        "unsupported manifest apiVersion"
    );
    ensure!(valid_name(&name), "invalid metadata.name");
    let resource = match kind {
        Kind::SurfaceAccount => {
            let mut value: AccountSpec = typed(spec, kind)?;
            same_identity(&value.account_id, &name)?;
            value.account_id.clone_from(&name);
            Resource::SurfaceAccount(value.into())
        }
        Kind::Volume => Resource::Volume(typed::<VolumeSpec>(spec, kind)?.source),
        Kind::Workspace => {
            let value: WorkspaceSpecInput = typed(spec, kind)?;
            let commit_sha = value.github.commit_sha.unwrap_or_default();
            ensure!(
                supertag_protocol::valid_workspace_id(&name)
                    && value.github.repository_id != 0
                    && valid_name(&value.github.account_id)
                    && (commit_sha.is_empty()
                        || (supertag_protocol::valid_git_commit(&commit_sha)
                            && value.github.revision.is_none())),
                "invalid GitHub Workspace selector"
            );
            Resource::Workspace(GithubWorkspace {
                workspace_id: name.clone(),
                source: Some(GithubWorkspaceSource {
                    account_id: value.github.account_id,
                    repository_id: value.github.repository_id,
                    repository: value.github.repository.to_ascii_lowercase(),
                    commit_sha,
                    revision: value.github.revision,
                    resolved_revision: None,
                }),
                pull_request: value
                    .pull_request_base
                    .map(|base_branch| GithubPullRequestDelivery { base_branch }),
                revision: 0,
            })
        }
        Kind::ContextSet => {
            let mut value: ContextSpec = typed(spec, kind)?;
            same_identity(&value.name, &name)?;
            value.name.clone_from(&name);
            Resource::ContextSet(value.into())
        }
        Kind::PermissionSet => {
            let mut value: PermissionSpec = typed(spec, kind)?;
            same_identity(&value.name, &name)?;
            value.name.clone_from(&name);
            Resource::PermissionSet(value.into())
        }
        Kind::Role => {
            let mut value: RoleSpec = typed(spec, kind)?;
            same_identity(&value.name, &name)?;
            value.name.clone_from(&name);
            Resource::Role(value.into())
        }
        Kind::Tag => Resource::Tag(typed(spec, kind)?),
        Kind::Team => Resource::Team(typed(spec, kind)?),
        Kind::SurfaceLocation => {
            let mut value: LocationSpec = typed(spec, kind)?;
            same_identity(&value.location_id, &name)?;
            value.location_id.clone_from(&name);
            Resource::SurfaceLocation(value.into())
        }
        Kind::Objective => Resource::Objective(typed(spec, kind)?),
    };
    Ok(Manifest {
        kind,
        name,
        source: source.into(),
        resource,
    })
}

fn read_file(path: &Path, limit: usize, provision: bool) -> Result<Vec<u8>> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | if provision { libc::O_NOFOLLOW } else { 0 })
        .open(path)?;
    let metadata = file.metadata()?;
    ensure!(metadata.is_file(), "manifest input must be a regular file");
    if provision {
        // SAFETY: geteuid takes no arguments and has no memory preconditions.
        let owner = unsafe { libc::geteuid() };
        ensure!(
            metadata.uid() == owner && metadata.mode() & 0o022 == 0,
            "provision file must be owned by the current user and writable only by its owner"
        );
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn files(paths: Vec<PathBuf>) -> Result<Vec<PathBuf>> {
    let mut result = Vec::new();
    for path in paths {
        if path == Path::new("-") || !path.is_dir() {
            result.push(path);
        } else {
            let mut entries = Vec::new();
            for entry in fs::read_dir(&path).with_context(|| format!("read {}", path.display()))? {
                let entry = entry?;
                if entry.file_type()?.is_file()
                    && matches!(
                        entry.path().extension().and_then(|value| value.to_str()),
                        Some("yaml" | "yml" | "json")
                    )
                {
                    entries.push(entry.path());
                }
                ensure!(entries.len() <= MAX_MANIFESTS, "too many manifest files");
            }
            entries.sort();
            result.extend(entries);
        }
        ensure!(result.len() <= MAX_MANIFESTS, "too many manifest files");
    }
    ensure!(
        result.iter().filter(|path| *path == Path::new("-")).count() <= 1,
        "stdin may be read only once"
    );
    Ok(result)
}

fn read(path: &Path, remaining: usize, provision: bool) -> Result<Vec<u8>> {
    let bytes = if path == Path::new("-") {
        ensure!(!provision, "provision cannot read from stdin");
        let mut bytes = Vec::new();
        io::stdin()
            .lock()
            .take(remaining as u64 + 1)
            .read_to_end(&mut bytes)?;
        bytes
    } else {
        read_file(path, remaining, provision)?
    };
    ensure!(
        bytes.len() <= remaining,
        "manifest input exceeds the total size limit"
    );
    Ok(bytes)
}

pub(crate) enum ProvisionSource {
    File(PathBuf),
    Inline(Value),
}

fn load(sources: Vec<ProvisionSource>, provision: bool) -> Result<Vec<Manifest>> {
    let mut manifests = Vec::new();
    let mut seen = BTreeSet::new();
    let mut remaining = MAX_INPUT_BYTES;
    let options = serde_saphyr::options! {
        budget: serde_saphyr::budget! {
            max_documents: MAX_MANIFESTS,
            max_depth: 40,
            max_nodes: 150_000,
            max_total_scalar_bytes: MAX_INPUT_BYTES,
        },
    };
    ensure!(sources.len() <= MAX_MANIFESTS, "too many manifest inputs");
    let mut add = |value, source: String| -> Result<()> {
        let item = manifest(value, &source).with_context(|| source)?;
        ensure!(
            seen.insert((item.kind, item.name.clone())),
            "duplicate {:?}/{} in {}",
            item.kind,
            item.name,
            item.source
        );
        manifests.push(item);
        ensure!(manifests.len() <= MAX_MANIFESTS, "too many manifests");
        Ok(())
    };
    for (index, source) in sources.into_iter().enumerate() {
        let path = match source {
            ProvisionSource::File(path) => path,
            ProvisionSource::Inline(value) => {
                let len = serde_json::to_vec(&value)?.len();
                ensure!(
                    len <= remaining,
                    "manifest input exceeds the total size limit"
                );
                remaining -= len;
                add(value, format!("provision entry {}", index + 1))?;
                continue;
            }
        };
        let bytes = read(&path, remaining, provision)
            .with_context(|| format!("read {}", path.display()))?;
        remaining -= bytes.len();
        let documents: Vec<Value> =
            serde_saphyr::from_bytes_multiple_with_options(&bytes, options.clone())
                .map_err(|_| anyhow::anyhow!("invalid YAML or JSON in {}", path.display()))?;
        for (index, document) in documents.into_iter().enumerate() {
            let values = match document {
                Value::Array(values) => values,
                value => vec![value],
            };
            for (entry, value) in values.into_iter().enumerate() {
                add(
                    value,
                    format!(
                        "{} document {} entry {}",
                        path.display(),
                        index + 1,
                        entry + 1
                    ),
                )?;
            }
        }
    }
    if manifests.is_empty() {
        bail!("no resource manifests found");
    }
    manifests.sort_by(|a, b| (a.kind, &a.name).cmp(&(b.kind, &b.name)));
    Ok(manifests)
}

pub(crate) async fn provision(
    channel: ProtocolChannel,
    token: &str,
    sources: Vec<ProvisionSource>,
) -> Result<()> {
    if sources.is_empty() {
        return Ok(());
    }
    let manifests = load(sources, true)?;
    let mut catalog = plan::Catalog::new(channel, token, "provision", true)?;
    let changes = catalog.plan(manifests).await?;
    for change in changes {
        catalog.apply(change, false).await?;
    }
    Ok(())
}

pub async fn run(args: ManifestArgs, apply: bool) -> Result<()> {
    let sources = files(args.files)?
        .into_iter()
        .map(ProvisionSource::File)
        .collect();
    let manifests = load(sources, false)?;
    let (channel, token) = crate::connect_operator(args.connection).await?;
    let mut catalog = plan::Catalog::new(
        channel,
        &token,
        args.manager.as_deref().unwrap_or_default(),
        false,
    )?;
    let changes = catalog.plan(manifests).await?;
    let conflicts = catalog.field_conflicts(args.force_conflicts).await?;
    if !apply {
        let mut lines = changes
            .iter()
            .map(plan::Change::preview)
            .collect::<Vec<_>>();
        lines.extend(conflicts.iter().map(|conflict| {
            format!(
                "conflict {}  (use --force-conflicts)",
                crate::terminal::text(conflict)
            )
        }));
        if args.prune {
            lines.extend(
                catalog
                    .reconcile_apply_set(true, true)
                    .await?
                    .iter()
                    .map(|line| crate::terminal::text(line)),
            );
        }
        if lines.is_empty() {
            outln!("No changes.");
        }
        for line in lines {
            outln!("{line}");
        }
        return Ok(());
    }
    if !conflicts.is_empty() {
        bail!(
            "Nothing was applied. {}. Use --force-conflicts to take ownership",
            crate::terminal::text(&conflicts.join("; "))
        );
    }
    let unchanged = changes.is_empty();
    catalog.claim_apply_set().await?;
    for change in changes {
        if let Err(error) = catalog.apply(change, true).await {
            // Record what this apply created so a rerun still owns it; never prune here.
            if let Err(record) = catalog.reconcile_apply_set(false, false).await {
                return Err(error.context(format!("{record:#}")));
            }
            return Err(error);
        }
    }
    catalog.record_fields().await?;
    let pruned = catalog.reconcile_apply_set(args.prune, false).await?;
    if unchanged && pruned.is_empty() {
        outln!("No changes.");
    }
    for line in pruned {
        outln!("{}", crate::terminal::text(&line));
    }
    Ok(())
}
