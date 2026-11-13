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

mod github;

const TYPE: &str = "supertag/skill";
const MAX_SKILLS: usize = 64;
const MANIFEST_BYTES: usize = 128 * 1024;

#[derive(Clone, Default)]
pub struct ContextCatalog {
    configured: bool,
    entries: BTreeMap<String, CatalogEntry>,
    /// Skills from GitHub-hosted catalogs, by reference (the Skill's directory name).
    github: BTreeMap<String, github::GithubCatalog>,
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
    #[serde(default)]
    skills: Vec<CatalogEntry>,
    /// Catalogs in GitHub repositories, fetched at an exact commit when a Task needs a Skill.
    #[serde(default)]
    github: Vec<github::GithubCatalog>,
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
            Catalog {
                version: 1,
                skills,
                github: vec![],
            }
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
        let mut github = BTreeMap::new();
        ensure!(catalog.github.len() <= 16, "too many GitHub Skill catalogs");
        for mut source in catalog.github {
            source.validate()?;
            for skill in source.skills.clone() {
                validate_reference(&skill)?;
                ensure!(
                    !entries.contains_key(&skill) && github.insert(skill, source.clone()).is_none(),
                    "duplicate Skill catalog reference"
                );
            }
        }
        Ok(Self {
            configured: true,
            entries,
            github,
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
        // The commit each GitHub catalog resolved to for this Task, by catalog.
        let mut catalog_commits: BTreeMap<String, String> = BTreeMap::new();
        if let Some(snapshot) = &task.policy_snapshot {
            for set in &snapshot.context_sets {
                for item in &set.items {
                    ensure!(!cancel.is_cancelled(), "context preparation cancelled");
                    if item.r#type == "supertag/artifacts"
                        && item.version == 1
                        && item.artifact_snapshot.is_some()
                    {
                        continue;
                    }
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
                    let (version, digest) = if let Some((version, digest)) =
                        delivered.get(&config.reference)
                    {
                        ensure!(
                            config
                                .version
                                .as_ref()
                                .is_none_or(|admitted| admitted == version),
                            "Skill reference resolved to conflicting versions"
                        );
                        (version.clone(), digest.clone())
                    } else {
                        let (path, version) = if let Some(entry) =
                            self.entries.get(&config.reference)
                        {
                            if let Some(version) = &config.version {
                                ensure!(
                                    entry.version.as_ref() == Some(version),
                                    "Skill catalog version differs from the admitted version"
                                );
                            }
                            (
                                entry.path.clone(),
                                entry.version.clone().unwrap_or_default(),
                            )
                        } else {
                            let source = self
                                .github
                                .get(&config.reference)
                                .context("Skill reference is not present in the host catalog")?;
                            // A retry keeps its Task's commit; a new Task may name one.
                            // Every Skill of one catalog takes the commit the first resolved.
                            let key = source.key();
                            let resolved = catalog_commits.get(&key);
                            let pinned = expected
                                .pins
                                .iter()
                                .find(|pin| pin.reference == config.reference)
                                .map(|pin| pin.version.as_str())
                                .or(config.version.as_deref());
                            ensure!(
                                resolved.is_none_or(
                                    |commit| pinned.is_none_or(|pinned| pinned == commit)
                                ),
                                "Skills from GitHub Skill catalog are pinned to different commits"
                            );
                            let pinned = pinned.or(resolved.map(String::as_str));
                            let (path, commit) = source.pin(
                                &config.reference,
                                pinned,
                                &prepared.state_root.join("skill-catalogs"),
                                cancel,
                            )?;
                            catalog_commits.insert(key, commit.clone());
                            (path, commit)
                        };
                        ensure!(
                            delivered.len() < MAX_SKILLS,
                            "context exceeds Skill package count limit"
                        );
                        let package = packages::capture(&path, cancel)
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
                        (version, package.digest)
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
                        artifact_snapshot: None,
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
    fn admitted_artifact_metadata_requires_no_skill_catalog() {
        let temp = tempfile::tempdir().unwrap();
        let mut task = task(true, "supertag/artifacts");
        task.policy_snapshot.as_mut().unwrap().context_sets[0].items[0].artifact_snapshot =
            Some(Default::default());
        let prepared = ContextCatalog::default()
            .prepare_blocking(
                &task,
                temp.path(),
                "artifact-metadata",
                &ContextResolutionManifest::default(),
                &CancellationToken::new(),
            )
            .unwrap();
        assert_eq!(
            prepared.manifest().unwrap(),
            ContextResolutionManifest::default()
        );
        assert!(prepared.delivery().unwrap().is_empty());
        prepared.discard().unwrap();
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
    fn git(directory: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .current_dir(directory)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .args([
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
                "-c",
                "commit.gpgSign=false",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().into()
    }
    fn github_catalog(root: &Path, url: &Path, revision: &str) -> ContextCatalog {
        let file = root.join(format!("catalog-{revision}.json"));
        fs::write(
            &file,
            serde_json::json!({"version":1,"github":[{
                "repository":"acme/skills","path":"catalog","revision":revision,"skills":["review"]
            }]})
            .to_string(),
        )
        .unwrap();
        let mut resolver = ContextCatalog::load(Some(&file)).unwrap();
        for source in resolver.github.values_mut() {
            *source = source.clone().with_url(url.to_str().unwrap());
        }
        resolver
    }
    fn prepare(
        resolver: &ContextCatalog,
        root: &Path,
        attempt: &str,
        expected: &ContextResolutionManifest,
    ) -> Result<PreparedContext> {
        fs::create_dir_all(root).unwrap();
        fs::set_permissions(root, fs::Permissions::from_mode(0o700)).unwrap();
        resolver.prepare_blocking(
            &task(true, TYPE),
            root,
            attempt,
            expected,
            &CancellationToken::new(),
        )
    }
    #[test]
    fn github_catalog_pins_commit_and_digest_across_a_moved_branch_and_new_hosts() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let repository = root.join("skills");
        let skill = repository.join("catalog/review");
        fs::create_dir_all(&skill).unwrap();
        git(&repository, &["init", "--quiet", "--initial-branch=main"]);
        fs::write(skill.join("SKILL.md"), "first").unwrap();
        fs::write(skill.join("check.sh"), "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(skill.join("check.sh"), fs::Permissions::from_mode(0o700)).unwrap();
        git(&repository, &["add", "catalog"]);
        git(&repository, &["commit", "--quiet", "-m", "Add Skill"]);
        let first_commit = git(&repository, &["rev-parse", "HEAD"]);
        let resolver = github_catalog(&root, &repository, "main");
        let host = root.join("host");
        let first = prepare(&resolver, &host, "first", &Default::default()).unwrap();
        let pinned = first.manifest().unwrap();
        assert_eq!(pinned.pins[0].reference, "review");
        assert_eq!(pinned.pins[0].version, first_commit);
        let delivered = PathBuf::from(&first.delivery().unwrap()[0].local_path);
        // Git modes, not the host umask or the author's mode bits, decide the files' modes.
        assert_eq!(
            fs::metadata(delivered.join("SKILL.md")).unwrap().mode() & 0o777,
            0o644
        );
        assert_eq!(
            fs::metadata(delivered.join("check.sh")).unwrap().mode() & 0o777,
            0o755
        );

        fs::write(skill.join("SKILL.md"), "second").unwrap();
        git(&repository, &["commit", "--quiet", "-am", "Change Skill"]);
        // A retry, here or on a host that never fetched the catalog, keeps the pinned commit.
        for host in [&host, &root.join("new-host")] {
            let retry = prepare(&resolver, host, "retry", &pinned).unwrap();
            assert_eq!(retry.manifest().unwrap(), pinned);
            let path = PathBuf::from(&retry.delivery().unwrap()[0].local_path);
            assert_eq!(fs::read_to_string(path.join("SKILL.md")).unwrap(), "first");
            retry.discard().unwrap();
        }
        // A new Task pins the branch as it is now.
        let next = prepare(&resolver, &host, "next", &Default::default()).unwrap();
        let moved = next.manifest().unwrap();
        assert_ne!(moved.pins[0].version, first_commit);
        assert_ne!(moved.pins[0].digest, pinned.pins[0].digest);

        // Removing the executable bit changes the digest.
        fs::set_permissions(skill.join("check.sh"), fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(skill.join("SKILL.md"), "first").unwrap();
        git(&repository, &["commit", "--quiet", "-am", "Not executable"]);
        let plain = prepare(&resolver, &host, "plain", &Default::default()).unwrap();
        assert_ne!(
            plain.manifest().unwrap().pins[0].digest,
            pinned.pins[0].digest
        );

        // A pinned commit the source no longer serves names its recovery options.
        let gone = github_catalog(&root, &root.join("unavailable"), "main");
        let error = prepare(&gone, &root.join("third-host"), "lost", &pinned)
            .err()
            .unwrap()
            .to_string();
        assert!(
            error.contains(&format!("acme/skills at {first_commit}"))
                && error.contains("Skill review")
                && error.contains("not available on this Worker Host")
                && error.contains("restore the commit")
                && error.contains("original host")
                && error.contains("new Task to re-pin"),
            "{error}"
        );
    }
    #[test]
    fn github_catalog_pins_every_skill_of_a_task_to_one_commit() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let repository = root.join("skills");
        for skill in ["review", "lint"] {
            fs::create_dir_all(repository.join("catalog").join(skill)).unwrap();
            fs::write(
                repository.join("catalog").join(skill).join("SKILL.md"),
                "first",
            )
            .unwrap();
        }
        git(&repository, &["init", "--quiet", "--initial-branch=main"]);
        git(&repository, &["add", "catalog"]);
        git(&repository, &["commit", "--quiet", "-m", "Add Skills"]);
        let first_commit = git(&repository, &["rev-parse", "HEAD"]);
        fs::write(repository.join("catalog/lint/SKILL.md"), "second").unwrap();
        git(&repository, &["commit", "--quiet", "-am", "Move main"]);
        let file = root.join("catalog.json");
        fs::write(
            &file,
            serde_json::json!({"version":1,"github":[{
                "repository":"acme/skills","path":"catalog","revision":"main","skills":["review","lint"]
            }]})
            .to_string(),
        )
        .unwrap();
        let mut resolver = ContextCatalog::load(Some(&file)).unwrap();
        for source in resolver.github.values_mut() {
            *source = source.clone().with_url(repository.to_str().unwrap());
        }
        // `review` names the first commit; `lint`, named without one, takes the same commit
        // rather than main as it is now.
        let mut task = task(true, TYPE);
        let items = &mut task.policy_snapshot.as_mut().unwrap().context_sets[0].items;
        items[0].config_json =
            serde_json::json!({"reference":"review","version":first_commit}).to_string();
        let mut lint = items[0].clone();
        lint.item_id = "lint-item".into();
        lint.item_key = "lint".into();
        lint.config_json = r#"{"reference":"lint"}"#.into();
        items.push(lint);
        let host = root.join("host");
        fs::create_dir_all(&host).unwrap();
        fs::set_permissions(&host, fs::Permissions::from_mode(0o700)).unwrap();
        let prepared = resolver
            .prepare_blocking(
                &task,
                &host,
                "one",
                &Default::default(),
                &CancellationToken::new(),
            )
            .unwrap();
        let manifest = prepared.manifest().unwrap();
        assert_eq!(manifest.pins.len(), 2);
        assert!(manifest.pins.iter().all(|pin| pin.version == first_commit));
        for delivered in prepared.delivery().unwrap() {
            let path = PathBuf::from(&delivered.local_path);
            assert_eq!(fs::read_to_string(path.join("SKILL.md")).unwrap(), "first");
        }
        // Two Skills of one catalog naming different commits are refused.
        let main = git(&repository, &["rev-parse", "HEAD"]);
        let items = &mut task.policy_snapshot.as_mut().unwrap().context_sets[0].items;
        items[1].config_json = serde_json::json!({"reference":"lint","version":main}).to_string();
        let error = resolver
            .prepare_blocking(
                &task,
                &host,
                "two",
                &Default::default(),
                &CancellationToken::new(),
            )
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("pinned to different commits"), "{error}");
    }
    #[test]
    fn github_catalog_reports_missing_skills_revisions_and_access() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let repository = root.join("skills");
        fs::create_dir_all(repository.join("other")).unwrap();
        git(&repository, &["init", "--quiet", "--initial-branch=main"]);
        fs::write(repository.join("other/SKILL.md"), "x").unwrap();
        git(&repository, &["add", "other"]);
        git(&repository, &["commit", "--quiet", "-m", "Other"]);
        let error = |resolver: &ContextCatalog| {
            prepare(resolver, &root.join("host"), "attempt", &Default::default())
                .err()
                .unwrap()
                .to_string()
        };
        assert!(
            error(&github_catalog(&root, &repository, "main")).contains("Skill review is missing"),
        );
        assert!(
            error(&github_catalog(&root, &repository, "absent"))
                .contains("cannot fetch revision absent")
        );
        assert!(
            error(&github_catalog(&root, &root.join("none"), "main"))
                .contains("Worker Host GitHub access")
        );
        let skill = repository.join("catalog/review");
        fs::create_dir_all(&skill).unwrap();
        fs::write(skill.join("notes.md"), "no instructions").unwrap();
        git(&repository, &["add", "catalog"]);
        git(&repository, &["commit", "--quiet", "-m", "No SKILL.md"]);
        assert!(error(&github_catalog(&root, &repository, "main")).contains("needs SKILL.md"));
        for invalid in [
            serde_json::json!({"repository":"acme","path":"catalog","revision":"main","skills":["review"]}),
            serde_json::json!({"repository":"acme/skills","path":"../catalog","revision":"main","skills":["review"]}),
            serde_json::json!({"repository":"acme/skills","path":"catalog","revision":"--upload-pack=x","skills":["review"]}),
            serde_json::json!({"repository":"acme/skills","path":"catalog","revision":"main","skills":["a/b"]}),
            serde_json::json!({"repository":"acme/skills","path":"catalog","revision":"main","skills":["review"],"url":"file:///tmp"}),
        ] {
            let file = root.join("invalid.json");
            fs::write(
                &file,
                serde_json::json!({"version":1,"github":[invalid]}).to_string(),
            )
            .unwrap();
            assert!(ContextCatalog::load(Some(&file)).is_err(), "{invalid}");
        }
    }
}
