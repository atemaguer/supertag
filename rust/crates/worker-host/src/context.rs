//! Resolve admitted Skill references once, outside the native writable workspace.
use anyhow::{Context, Result, ensure};
use prost::Message;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};
use supertag_protocol::v2::{
    ContextContract, ContextPin, ContextResolutionManifest, OmittedContextItem, ResolvedSkill, Task,
};
use supertag_workspaces::packages;
use tokio_util::sync::CancellationToken;

const TYPE: &str = "supertag/skill";
const MAX_SKILLS: usize = 64;
const MANIFEST_BYTES: usize = 128 * 1024;

#[derive(Clone, Default)]
pub struct ContextCatalog {
    configured: bool,
    entries: BTreeMap<String, CatalogEntry>,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogEntry {
    id: String,
    path: PathBuf,
    version: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    version: u32,
    skills: Vec<CatalogEntry>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SkillConfig {
    reference: String,
    version: Option<String>,
    digest: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PreparedContext {
    state_root: PathBuf,
    task_id: String,
    attempt_id: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Owner {
    version: u32,
    task_id: String,
    attempt_id: String,
    manifest_digest: String,
}

impl ContextCatalog {
    pub fn load(path: Option<&Path>) -> Result<Self> {
        let Some(path) = path else {
            return Ok(Self::default());
        };
        let path = absolute(path)?;
        let metadata = fs::symlink_metadata(&path)?;
        ensure!(
            !metadata.file_type().is_symlink(),
            "Skill catalog must not be a symlink"
        );
        let mut entries = BTreeMap::new();
        let catalog = if metadata.is_dir() {
            let directory = packages::open_directory(&path)?;
            let mut skills = vec![];
            for name in packages::directory_names(&directory, 4096)? {
                if name.starts_with('.') {
                    continue;
                }
                let child = path.join(&name);
                let meta = fs::symlink_metadata(&child)?;
                ensure!(
                    !meta.file_type().is_symlink(),
                    "Skill catalog cannot contain symlinks"
                );
                if meta.is_dir() {
                    skills.push(CatalogEntry {
                        id: name,
                        path: child,
                        version: None,
                    });
                }
            }
            Catalog { version: 1, skills }
        } else {
            let parent = packages::open_directory(path.parent().context("catalog has no parent")?)?;
            let bytes = packages::read_regular_at(
                &parent,
                path.file_name()
                    .and_then(|n| n.to_str())
                    .context("invalid catalog filename")?,
                1024 * 1024,
            )?;
            serde_json::from_slice::<Catalog>(&bytes).context("invalid Skill catalog")?
        };
        ensure!(
            catalog.version == 1 && catalog.skills.len() <= 1024,
            "unsupported Skill catalog version or size"
        );
        for mut entry in catalog.skills {
            validate_reference(&entry.id)?;
            if let Some(version) = &entry.version {
                ensure!(
                    !version.trim().is_empty()
                        && version.len() <= 256
                        && !version.chars().any(char::is_control),
                    "invalid catalog Skill version"
                );
            }
            if !entry.path.is_absolute() {
                entry.path = path
                    .parent()
                    .context("catalog has no parent")?
                    .join(&entry.path);
            }
            entry.path = absolute(&entry.path)?;
            packages::open_directory(&entry.path)
                .context("catalog Skill directory is unavailable or unsafe")?;
            ensure!(
                entries.insert(entry.id.clone(), entry).is_none(),
                "duplicate Skill catalog reference"
            );
        }
        Ok(Self {
            configured: true,
            entries,
        })
    }
    pub fn supported_contracts(&self) -> Vec<ContextContract> {
        if self.configured {
            vec![ContextContract {
                r#type: TYPE.into(),
                version: 1,
            }]
        } else {
            vec![]
        }
    }
    pub async fn prepare(
        &self,
        task: &Task,
        state_root: &Path,
        attempt_id: &str,
        expected: &ContextResolutionManifest,
        cancel: &CancellationToken,
    ) -> Result<PreparedContext> {
        let catalog = self.clone();
        let task = task.clone();
        let state_root = state_root.to_owned();
        let attempt_id = attempt_id.to_owned();
        let expected = expected.clone();
        let cancel = cancel.clone();
        tokio::task::spawn_blocking(move || {
            catalog.prepare_blocking(&task, &state_root, &attempt_id, &expected, &cancel)
        })
        .await
        .context("context capture task stopped")?
    }
    fn prepare_blocking(
        &self,
        task: &Task,
        state_root: &Path,
        attempt_id: &str,
        expected: &ContextResolutionManifest,
        cancel: &CancellationToken,
    ) -> Result<PreparedContext> {
        validate_identity(&task.task_id)?;
        validate_identity(attempt_id)?;
        ensure!(!cancel.is_cancelled(), "context preparation cancelled");
        let state_root = absolute(state_root)?;
        private_directory(&state_root)?;
        let parent = state_root.join("context-attempts");
        create_private(&parent)?;
        let destination = attempt_path(&state_root, attempt_id);
        let prepared = PreparedContext {
            state_root,
            task_id: task.task_id.clone(),
            attempt_id: attempt_id.into(),
        };
        if destination.try_exists()? {
            let manifest = prepared.manifest()?;
            if !is_empty(expected) {
                ensure!(
                    manifest == *expected,
                    "prepared context differs from its durable resolution"
                );
            }
            prepared.delivery()?;
            return Ok(prepared);
        }
        let temporary = tempfile::Builder::new()
            .prefix("preparing-")
            .permissions(fs::Permissions::from_mode(0o700))
            .tempdir_in(&parent)?;
        let packages_root = temporary.path().join("skills");
        create_private(&packages_root)?;
        let mut manifest = ContextResolutionManifest::default();
        let mut delivered: BTreeMap<String, (String, String)> = BTreeMap::new();
        let mut total = 0usize;
        if let Some(snapshot) = &task.policy_snapshot {
            for set in &snapshot.context_sets {
                for item in &set.items {
                    ensure!(!cancel.is_cancelled(), "context preparation cancelled");
                    if !self.configured || item.r#type != TYPE || item.version != 1 {
                        ensure!(
                            !item.required,
                            "required Context Item has no supported resolver"
                        );
                        manifest.omissions.push(OmittedContextItem {
                            set_id: set.set_id.clone(),
                            item_id: item.item_id.clone(),
                            item_key: item.item_key.clone(),
                            r#type: item.r#type.clone(),
                            version: item.version,
                            reason: "No supported Context Resolver is configured".into(),
                        });
                        continue;
                    }
                    let config: SkillConfig = serde_json::from_str(&item.config_json)
                        .context("invalid admitted Skill configuration")?;
                    validate_reference(&config.reference)?;
                    let entry = self
                        .entries
                        .get(&config.reference)
                        .context("Skill reference is not present in the host catalog")?;
                    if let Some(version) = &config.version {
                        ensure!(
                            entry.version.as_ref() == Some(version),
                            "Skill catalog version differs from the admitted version"
                        );
                    }
                    let version = entry.version.clone().unwrap_or_default();
                    let digest = if let Some((previous_version, digest)) =
                        delivered.get(&config.reference)
                    {
                        ensure!(
                            previous_version == &version,
                            "Skill reference resolved to conflicting versions"
                        );
                        digest.clone()
                    } else {
                        ensure!(
                            delivered.len() < MAX_SKILLS,
                            "context exceeds Skill package count limit"
                        );
                        let package = packages::capture(&entry.path, cancel)
                            .context("Skill package capture failed")?;
                        total = total
                            .checked_add(
                                package.files.values().map(|f| f.bytes.len()).sum::<usize>(),
                            )
                            .context("context size overflow")?;
                        ensure!(
                            total <= packages::MAX_BYTES,
                            "context exceeds total package byte limit"
                        );
                        packages::materialize(
                            &package,
                            &packages_root.join(package_name(&config.reference)),
                            cancel,
                        )?;
                        delivered.insert(
                            config.reference.clone(),
                            (version.clone(), package.digest.clone()),
                        );
                        package.digest
                    };
                    if let Some(expected) = &config.digest {
                        ensure!(
                            normalize_digest(expected)? == digest,
                            "Skill package differs from the admitted digest"
                        );
                    }
                    manifest.pins.push(ContextPin {
                        set_id: set.set_id.clone(),
                        item_id: item.item_id.clone(),
                        item_key: item.item_key.clone(),
                        reference: config.reference,
                        version,
                        digest,
                    });
                }
            }
        }
        canonicalize(&mut manifest);
        if !is_empty(expected) {
            ensure!(
                manifest == *expected,
                "Skill context differs from this Task's durable resolution"
            );
        }
        let bytes = manifest.encode_to_vec();
        ensure!(
            bytes.len() <= MANIFEST_BYTES,
            "context resolution manifest exceeds limit"
        );
        write_private(&temporary.path().join("manifest.pb"), &bytes)?;
        let owner = Owner {
            version: 1,
            task_id: task.task_id.clone(),
            attempt_id: attempt_id.into(),
            manifest_digest: hex_digest(&bytes),
        };
        write_private(
            &temporary.path().join("owner.json"),
            &serde_json::to_vec(&owner)?,
        )?;
        File::open(&packages_root)?.sync_all()?;
        File::open(temporary.path())?.sync_all()?;
        ensure!(!cancel.is_cancelled(), "context preparation cancelled");
        fs::rename(temporary.path(), &destination)?;
        File::open(&parent)?.sync_all()?;
        prepared.delivery()?;
        Ok(prepared)
    }
}
impl PreparedContext {
    pub fn manifest(&self) -> Result<ContextResolutionManifest> {
        let root = attempt_path(&self.state_root, &self.attempt_id);
        let (owner, manifest) = read_owned(&root, &self.attempt_id)?;
        ensure!(
            owner.task_id == self.task_id,
            "context directory belongs to another Task"
        );
        Ok(manifest)
    }
    pub fn delivery(&self) -> Result<Vec<ResolvedSkill>> {
        let manifest = self.manifest()?;
        let root = attempt_path(&self.state_root, &self.attempt_id).join("skills");
        let mut verified = BTreeMap::new();
        let cancel = CancellationToken::new();
        manifest
            .pins
            .into_iter()
            .map(|pin| {
                let path = root.join(package_name(&pin.reference));
                let digest = if let Some(digest) = verified.get(&pin.reference) {
                    digest
                } else {
                    let package = packages::capture(&path, &cancel)?;
                    verified.insert(pin.reference.clone(), package.digest);
                    verified.get(&pin.reference).expect("inserted package")
                };
                ensure!(
                    digest == &pin.digest,
                    "private Skill package changed after preparation"
                );
                Ok(ResolvedSkill {
                    pin: Some(pin),
                    local_path: path
                        .to_str()
                        .context("private Skill path is not UTF-8")?
                        .into(),
                })
            })
            .collect()
    }
    pub fn discard(&self) -> Result<()> {
        discard_attempt(&self.state_root, &self.attempt_id)
    }
}
/// Call only after proving native execution stopped or before any native launch.
/// No source catalog or Git repository is consulted during idempotent cleanup.
pub fn discard_attempt(state_root: &Path, attempt_id: &str) -> Result<()> {
    validate_identity(attempt_id)?;
    let state_root = absolute(state_root)?;
    private_directory(&state_root)?;
    let path = attempt_path(&state_root, attempt_id);
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
        Ok(_) => {}
    }
    read_owned(&path, attempt_id)?;
    fs::remove_dir_all(&path)?;
    File::open(path.parent().expect("context parent"))?.sync_all()?;
    Ok(())
}
fn read_owned(root: &Path, attempt: &str) -> Result<(Owner, ContextResolutionManifest)> {
    private_directory(root)?;
    let directory = packages::open_directory(root)?;
    let owner: Owner =
        serde_json::from_slice(&packages::read_regular_at(&directory, "owner.json", 4096)?)?;
    ensure!(
        owner.version == 1 && owner.attempt_id == attempt,
        "context directory ownership differs from Attempt"
    );
    let bytes = packages::read_regular_at(&directory, "manifest.pb", MANIFEST_BYTES)?;
    ensure!(
        hex_digest(&bytes) == owner.manifest_digest,
        "context manifest changed after preparation"
    );
    Ok((owner, ContextResolutionManifest::decode(bytes.as_slice())?))
}
fn attempt_path(root: &Path, attempt: &str) -> PathBuf {
    root.join("context-attempts")
        .join(hex_digest(attempt.as_bytes()))
}
fn package_name(reference: &str) -> String {
    format!("skill-{}", hex_digest(reference.as_bytes()))
}
fn hex_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn absolute(path: &Path) -> Result<PathBuf> {
    let absolute: PathBuf = if path.is_absolute() {
        path.into()
    } else {
        std::env::current_dir()?.join(path)
    };
    // Resolve trusted configuration ancestors once, including macOS /var.
    // The selected final node remains un-followed; package contents are opened
    // descriptor-relatively and cannot use links to escape this boundary.
    match (absolute.parent(), absolute.file_name()) {
        (Some(parent), Some(name)) => Ok(parent.canonicalize()?.join(name)),
        _ => Ok(absolute.canonicalize()?),
    }
}
fn private_directory(path: &Path) -> Result<()> {
    let directory = packages::open_directory(path)?;
    let metadata = directory.metadata()?;
    ensure!(
        metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o022 == 0,
        "context state must be writable only by its owner"
    );
    Ok(())
}
fn create_private(path: &Path) -> Result<()> {
    match fs::create_dir(path) {
        Ok(()) => {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    };
    private_directory(path)
}
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}
fn validate_identity(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control),
        "invalid context owner identity"
    );
    Ok(())
}
fn validate_reference(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.len() <= 128
            && !value.contains("..")
            && value
                .bytes()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric())
            && value.bytes().all(|c| c.is_ascii_alphanumeric()
                || matches!(c, b'.' | b'_' | b':' | b'@' | b'/' | b'-')),
        "invalid Skill reference"
    );
    Ok(())
}
fn normalize_digest(value: &str) -> Result<String> {
    let value = value.trim().to_lowercase();
    ensure!(
        value
            .strip_prefix("sha256:")
            .is_some_and(|v| v.len() == 64 && v.bytes().all(|c| c.is_ascii_hexdigit())),
        "invalid admitted Skill digest"
    );
    Ok(value)
}
fn is_empty(manifest: &ContextResolutionManifest) -> bool {
    manifest.pins.is_empty() && manifest.omissions.is_empty()
}
fn canonicalize(manifest: &mut ContextResolutionManifest) {
    manifest
        .pins
        .sort_by(|a, b| (&a.set_id, &a.item_id).cmp(&(&b.set_id, &b.item_id)));
    manifest
        .omissions
        .sort_by(|a, b| (&a.set_id, &a.item_id).cmp(&(&b.set_id, &b.item_id)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use supertag_protocol::v2::{ContextSet, PolicyContextItem, TaskPolicySnapshot};
    fn task(required: bool, kind: &str) -> Task {
        Task {
            task_id: "task".into(),
            policy_snapshot: Some(TaskPolicySnapshot {
                version: 1,
                context_sets: vec![ContextSet {
                    set_id: "set".into(),
                    items: vec![PolicyContextItem {
                        item_id: "item".into(),
                        item_key: "review".into(),
                        r#type: kind.into(),
                        version: 1,
                        required,
                        config_json: r#"{"reference":"review"}"#.into(),
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            }),
            ..Default::default()
        }
    }
    #[test]
    fn local_catalog_pins_private_copy_and_cleanup_survives_missing_source() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let catalog = root.join("catalog");
        fs::create_dir(&catalog).unwrap();
        let skill = catalog.join("review");
        fs::create_dir(&skill).unwrap();
        fs::write(skill.join("SKILL.md"), "Review carefully.").unwrap();
        let resolver = ContextCatalog::load(Some(&catalog)).unwrap();
        let prepared = resolver
            .prepare_blocking(
                &task(true, TYPE),
                &root,
                "attempt",
                &ContextResolutionManifest::default(),
                &CancellationToken::new(),
            )
            .unwrap();
        let manifest = prepared.manifest().unwrap();
        let path = PathBuf::from(&prepared.delivery().unwrap()[0].local_path);
        assert_eq!(manifest.pins[0].reference, "review");
        fs::write(skill.join("SKILL.md"), "Changed.").unwrap();
        assert_eq!(
            fs::read_to_string(path.join("SKILL.md")).unwrap(),
            "Review carefully."
        );
        assert!(
            resolver
                .prepare_blocking(
                    &task(true, TYPE),
                    &root,
                    "other-attempt",
                    &manifest,
                    &CancellationToken::new()
                )
                .is_err()
        );
        fs::remove_dir_all(catalog).unwrap();
        assert!(
            resolver
                .prepare_blocking(
                    &task(true, TYPE),
                    &root,
                    "attempt",
                    &manifest,
                    &CancellationToken::new()
                )
                .is_ok()
        );
        prepared.discard().unwrap();
        prepared.discard().unwrap();
        assert!(!path.exists());
    }
    #[test]
    fn optional_missing_contract_is_recorded_but_broken_installed_skill_fails() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let resolver = ContextCatalog::default();
        let prepared = resolver
            .prepare_blocking(
                &task(false, "example/unknown"),
                &root,
                "optional",
                &ContextResolutionManifest::default(),
                &CancellationToken::new(),
            )
            .unwrap();
        assert_eq!(prepared.manifest().unwrap().omissions.len(), 1);
        assert!(prepared.delivery().unwrap().is_empty());
        assert!(
            resolver
                .prepare_blocking(
                    &task(true, TYPE),
                    &root,
                    "required",
                    &ContextResolutionManifest::default(),
                    &CancellationToken::new()
                )
                .is_err()
        );
        let catalog = root.join("catalog");
        fs::create_dir(&catalog).unwrap();
        let resolver = ContextCatalog::load(Some(&catalog)).unwrap();
        assert!(
            resolver
                .prepare_blocking(
                    &task(false, TYPE),
                    &root,
                    "missing",
                    &ContextResolutionManifest::default(),
                    &CancellationToken::new()
                )
                .is_err()
        );
    }
    #[test]
    fn private_copy_tampering_and_foreign_ownership_are_refused() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let catalog = root.join("catalog");
        fs::create_dir(&catalog).unwrap();
        let skill = catalog.join("review");
        fs::create_dir(&skill).unwrap();
        fs::write(skill.join("SKILL.md"), "Review.").unwrap();
        let resolver = ContextCatalog::load(Some(&catalog)).unwrap();
        let prepared = resolver
            .prepare_blocking(
                &task(true, TYPE),
                &root,
                "attempt",
                &ContextResolutionManifest::default(),
                &CancellationToken::new(),
            )
            .unwrap();
        let path = PathBuf::from(&prepared.delivery().unwrap()[0].local_path);
        fs::write(path.join("SKILL.md"), "Tampered.").unwrap();
        assert!(prepared.delivery().is_err());
        fs::write(
            attempt_path(&root, "attempt").join("owner.json"),
            r#"{"version":1,"task_id":"task","attempt_id":"other","manifest_digest":"fake"}"#,
        )
        .unwrap();
        assert!(prepared.discard().is_err());
    }
}
