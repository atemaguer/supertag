//! Resolve admitted Skill references once, outside the native writable workspace.
use anyhow::{Context, Result, bail, ensure};
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
    ContextContract, ContextPin, ContextResolutionManifest, HarnessKind, OmittedContextItem,
    PolicyContextItem, ResolvedSkill, SkippedSkill, Task,
};
use supertag_workspaces::{packages, repository_skills::SkippedRepositorySkill};
use tokio_util::sync::CancellationToken;

mod github;

const TYPE: &str = "supertag/skill";
/// The `reference` of a Skill Context Item that loads every Skill available to the Task.
pub const WILDCARD: &str = "*";
const MAX_SKILLS: usize = 64;
const MANIFEST_BYTES: usize = 128 * 1024;
/// The most skipped Skills one manifest records.
const MAX_SKIPPED: usize = 128;
const MAX_REASON: usize = 256;
/// The omission a `*` item records when the Task has no Skill to load.
pub const NO_SKILLS: &str = "No Skills are available to this Task";
const CATALOG_SOURCE: &str = "catalog";
const USER_SOURCES: [(&str, &str); 2] = [
    (".claude/skills", "user:~/.claude/skills"),
    (".agents/skills", "user:~/.agents/skills"),
];

/// The Skills a Worker Host can load: its configured catalog, if any, the repository Skills of
/// each Task's checkout, and its user's own Skills.
#[derive(Clone, Default)]
pub struct ContextCatalog {
    /// Whether this host's harness loads Skills; a host whose harness does not advertises no
    /// Skill contract.
    enabled: bool,
    entries: BTreeMap<String, CatalogEntry>,
    /// Skills from GitHub-hosted catalogs, by reference (the Skill's directory name).
    github: BTreeMap<String, github::GithubCatalog>,
    /// The host user's home directory, whose `.claude/skills` and `.agents/skills` hold Skills.
    home: Option<PathBuf>,
    /// Set for a host whose harness does not load Skills, so its omissions say so.
    harness_unsupported: bool,
}

/// Whether a harness loads delivered Skills. OpenAI Agents has no Skill support. Cursor finds
/// Skills by name in the workspace and its home directory and has no setting that limits it to
/// named ones, so delivered Skills could not be kept to those a Context Set admits.
pub fn harness_loads_skills(harness: HarnessKind) -> bool {
    !matches!(harness, HarnessKind::OpenaiAgents | HarnessKind::Cursor)
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

/// The repository Skills of a Task's checkout, written by its Workspace under `root` (see
/// `supertag_workspaces::repository_skills`).
pub struct RepositorySkills {
    pub root: PathBuf,
    /// The commit they were read from, recorded as their version.
    pub commit: String,
    pub skipped: Vec<SkippedRepositorySkill>,
}

/// Where one available Skill comes from.
#[derive(Clone)]
enum Origin {
    Local {
        path: PathBuf,
        version: Option<String>,
    },
    Github(github::GithubCatalog),
}
#[derive(Clone)]
struct Candidate {
    source: String,
    origin: Origin,
}
/// Every Skill available to one Task, by name; the first source's Skill takes precedence.
#[derive(Default)]
struct Available {
    skills: BTreeMap<String, Candidate>,
    /// The lower-precedence sources that also have a Skill of a name.
    shadowed: BTreeMap<String, Vec<String>>,
    /// Skills of the repository and user sources that cannot be loaded at all.
    unusable: Vec<SkippedSkill>,
}
impl Available {
    fn add(&mut self, name: String, candidate: Candidate) {
        match self.skills.entry(name) {
            std::collections::btree_map::Entry::Occupied(entry) => self
                .shadowed
                .entry(entry.key().clone())
                .or_default()
                .push(candidate.source),
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(candidate);
            }
        }
    }
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

/// One Task's resolution in progress.
struct Resolution<'a> {
    packages_root: PathBuf,
    cache: PathBuf,
    expected: &'a ContextResolutionManifest,
    cancel: &'a CancellationToken,
    /// The version, digest, and source each delivered reference resolved to.
    delivered: BTreeMap<String, (String, String, String)>,
    total: usize,
    /// The commit each GitHub catalog resolved to for this Task, by catalog.
    catalog_commits: BTreeMap<String, String>,
}
impl Resolution<'_> {
    /// Resolves, captures, and privately copies one Skill, once per Task.
    fn resolve(
        &mut self,
        reference: &str,
        admitted_version: Option<&str>,
        available: &Available,
    ) -> Result<(String, String, String)> {
        if let Some((version, digest, source)) = self.delivered.get(reference) {
            ensure!(
                admitted_version.is_none_or(|admitted| admitted == version),
                "Skill reference resolved to conflicting versions"
            );
            return Ok((version.clone(), digest.clone(), source.clone()));
        }
        let candidate = available
            .skills
            .get(reference)
            .context("Skill reference is not present on this Worker Host")?;
        let (path, version) = match &candidate.origin {
            Origin::Local { path, version } => {
                if let Some(admitted) = admitted_version {
                    ensure!(
                        version.as_deref() == Some(admitted),
                        "Skill catalog version differs from the admitted version"
                    );
                }
                (path.clone(), version.clone().unwrap_or_default())
            }
            Origin::Github(source) => {
                // A retry keeps its Task's commit; a new Task may name one.
                // Every Skill of one catalog takes the commit the first resolved.
                let key = source.key();
                let resolved = self.catalog_commits.get(&key);
                let pinned = self
                    .expected
                    .pins
                    .iter()
                    .find(|pin| pin.reference == reference)
                    .map(|pin| pin.version.as_str())
                    .or(admitted_version);
                ensure!(
                    resolved.is_none_or(|commit| pinned.is_none_or(|pinned| pinned == commit)),
                    "Skills from GitHub Skill catalog are pinned to different commits"
                );
                let pinned = pinned.or(resolved.map(String::as_str));
                let (path, commit) = source.pin(reference, pinned, &self.cache, self.cancel)?;
                self.catalog_commits.insert(key, commit.clone());
                (path, commit)
            }
        };
        ensure!(
            self.delivered.len() < MAX_SKILLS,
            "context exceeds Skill package count limit"
        );
        let package =
            packages::capture(&path, self.cancel).context("Skill package capture failed")?;
        let total = self
            .total
            .checked_add(package.files.values().map(|f| f.bytes.len()).sum::<usize>())
            .context("context size overflow")?;
        ensure!(
            total <= packages::MAX_BYTES,
            "context exceeds total package byte limit"
        );
        packages::materialize(
            &package,
            &self.packages_root.join(package_name(reference)),
            self.cancel,
        )?;
        self.total = total;
        let resolved = (version, package.digest, candidate.source.clone());
        self.delivered.insert(reference.into(), resolved.clone());
        Ok(resolved)
    }
}

impl ContextCatalog {
    /// A catalog for a host whose harness loads Skills: the configured `path`, if any, and the
    /// Skills of `home`, the host user's home directory.
    /// A catalog for a host whose harness does not load Skills: it advertises no Skill contract,
    /// and records each optional Skill item as an omission.
    pub fn without_skills() -> Self {
        Self {
            harness_unsupported: true,
            ..Self::default()
        }
    }
    pub fn load(path: Option<&Path>, home: Option<&Path>) -> Result<Self> {
        let mut catalog = match path {
            Some(path) => Self::configured(path)?,
            None => Self::default(),
        };
        catalog.enabled = true;
        catalog.home = home.map(absolute).transpose()?;
        Ok(catalog)
    }
    fn configured(path: &Path) -> Result<Self> {
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
            enabled: false,
            entries,
            github,
            home: None,
            harness_unsupported: false,
        })
    }
    pub fn supported_contracts(&self) -> Vec<ContextContract> {
        if self.enabled {
            vec![ContextContract {
                r#type: TYPE.into(),
                version: 1,
            }]
        } else {
            vec![]
        }
    }
    /// Whether the Task has a Skill Context Item this catalog resolves.
    pub fn resolves_skills(&self, task: &Task) -> bool {
        self.enabled
            && task.policy_snapshot.as_ref().is_some_and(|snapshot| {
                snapshot
                    .context_sets
                    .iter()
                    .flat_map(|set| &set.items)
                    .any(|item| item.r#type == TYPE && item.version == 1)
            })
    }
    /// The Skills available to one Task, in precedence order: the configured catalog, then the
    /// repository's `.claude/skills` and `.agents/skills`, then the user's.
    fn available(&self, repository: Option<&RepositorySkills>) -> Result<Available> {
        let mut available = Available::default();
        for (name, entry) in &self.entries {
            available.add(
                name.clone(),
                Candidate {
                    source: CATALOG_SOURCE.into(),
                    origin: Origin::Local {
                        path: entry.path.clone(),
                        version: entry.version.clone(),
                    },
                },
            );
        }
        for (name, source) in &self.github {
            available.add(
                name.clone(),
                Candidate {
                    source: CATALOG_SOURCE.into(),
                    origin: Origin::Github(source.clone()),
                },
            );
        }
        if let Some(repository) = repository {
            for (root, subdirectory) in supertag_workspaces::repository_skills::ROOTS {
                let source = format!("repository:{root}");
                for skipped in repository.skipped.iter().filter(|s| s.root == root) {
                    available
                        .unusable
                        .push(skipped_skill(&skipped.name, &source, &skipped.reason));
                }
                let (found, _) = discover(&repository.root.join(subdirectory), &source)?;
                for (name, path) in found {
                    available.add(
                        name,
                        Candidate {
                            source: source.clone(),
                            origin: Origin::Local {
                                path,
                                version: Some(repository.commit.clone()),
                            },
                        },
                    );
                }
            }
        }
        if let Some(home) = &self.home {
            for (directory, source) in USER_SOURCES {
                let (found, unusable) = discover(&home.join(directory), source)?;
                available.unusable.extend(unusable);
                for (name, path) in found {
                    available.add(
                        name,
                        Candidate {
                            source: source.into(),
                            origin: Origin::Local {
                                path,
                                version: None,
                            },
                        },
                    );
                }
            }
        }
        Ok(available)
    }
    pub async fn prepare(
        &self,
        task: &Task,
        state_root: &Path,
        attempt_id: &str,
        expected: &ContextResolutionManifest,
        repository: Option<RepositorySkills>,
        cancel: &CancellationToken,
    ) -> Result<PreparedContext> {
        let catalog = self.clone();
        let task = task.clone();
        let state_root = state_root.to_owned();
        let attempt_id = attempt_id.to_owned();
        let expected = expected.clone();
        let cancel = cancel.clone();
        tokio::task::spawn_blocking(move || {
            catalog.prepare_blocking(
                &task,
                &state_root,
                &attempt_id,
                &expected,
                repository.as_ref(),
                &cancel,
            )
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
        repository: Option<&RepositorySkills>,
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
        let available = if self.resolves_skills(task) {
            self.available(repository)?
        } else {
            Available::default()
        };
        let mut resolution = Resolution {
            packages_root: packages_root.clone(),
            cache: prepared.state_root.join("skill-catalogs"),
            expected,
            cancel,
            delivered: BTreeMap::new(),
            total: 0,
            catalog_commits: BTreeMap::new(),
        };
        let mut wildcards = vec![];
        let mut skipped = BTreeMap::new();
        // Named Skills resolve first, so their pins hold when a `*` item loads them too.
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
                    if !self.enabled || item.r#type != TYPE || item.version != 1 {
                        ensure!(
                            !item.required,
                            "required Context Item has no supported resolver"
                        );
                        let reason = if self.harness_unsupported && item.r#type == TYPE {
                            "Harness does not support Skill inputs"
                        } else {
                            "No supported Context Resolver is configured"
                        };
                        manifest.omissions.push(omission(&set.set_id, item, reason));
                        continue;
                    }
                    let config: SkillConfig = serde_json::from_str(&item.config_json)
                        .context("invalid admitted Skill configuration")?;
                    if config.reference == WILDCARD {
                        ensure!(
                            !item.required && config.version.is_none() && config.digest.is_none(),
                            "a Skill Context Item with reference \"*\" can be neither required nor pinned"
                        );
                        wildcards.push((set, item));
                        continue;
                    }
                    validate_reference(&config.reference)?;
                    let (version, digest, source) = resolution.resolve(
                        &config.reference,
                        config.version.as_deref(),
                        &available,
                    )?;
                    if let Some(expected) = &config.digest {
                        ensure!(
                            normalize_digest(expected)? == digest,
                            "Skill package differs from the admitted digest"
                        );
                    }
                    manifest.pins.push(pin(
                        &set.set_id,
                        item,
                        &config.reference,
                        (version, digest, source),
                    ));
                }
            }
        }
        for (set, item) in &wildcards {
            let mut loaded = false;
            for (name, candidate) in &available.skills {
                ensure!(!cancel.is_cancelled(), "context preparation cancelled");
                match resolution.resolve(name, None, &available) {
                    Ok(resolved) => {
                        loaded = true;
                        manifest.pins.push(pin(&set.set_id, item, name, resolved));
                    }
                    Err(_) if cancel.is_cancelled() => bail!("context preparation cancelled"),
                    Err(error) => {
                        let skip = skipped_skill(name, &candidate.source, &format!("{error:#}"));
                        skipped.insert((skip.reference.clone(), skip.source.clone()), skip);
                    }
                }
            }
            if !loaded {
                manifest
                    .omissions
                    .push(omission(&set.set_id, item, NO_SKILLS));
            }
        }
        // The Skills a delivered Skill's name shadowed, and, when a `*` item looked at every
        // Skill, the ones that cannot be loaded.
        for (reference, (_, _, source)) in &resolution.delivered {
            for shadowed in available.shadowed.get(reference).into_iter().flatten() {
                let skip = skipped_skill(
                    reference,
                    shadowed,
                    &format!("the Skill of this name from {source} takes precedence"),
                );
                skipped.insert((skip.reference.clone(), skip.source.clone()), skip);
            }
        }
        if !wildcards.is_empty() {
            for skip in &available.unusable {
                skipped
                    .entry((skip.reference.clone(), skip.source.clone()))
                    .or_insert_with(|| skip.clone());
            }
        }
        manifest.skipped = skipped.into_values().take(MAX_SKIPPED).collect();
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

/// The Skills directly under `root`: each real child directory with a `SKILL.md`. A root that
/// does not exist has none. A symbolic link to the root is followed, but not one to a Skill.
/// The Skills found in one directory, by name, and those found there that cannot be loaded.
type Discovered = (Vec<(String, PathBuf)>, Vec<SkippedSkill>);
fn discover(root: &Path, source: &str) -> Result<Discovered> {
    let root = match root.canonicalize() {
        Ok(root) => root,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Default::default());
        }
        Err(error) => {
            return Err(error).with_context(|| format!("cannot read the Skills in {source}"));
        }
    };
    if !fs::metadata(&root)?.is_dir() {
        return Ok(Default::default());
    }
    let directory = packages::open_directory(&root)
        .with_context(|| format!("cannot read the Skills in {source}"))?;
    let mut names = packages::directory_names(&directory, 4096)?;
    names.sort();
    let (mut found, mut unusable) = (vec![], vec![]);
    for name in names {
        if name.starts_with('.') {
            continue;
        }
        let child = root.join(&name);
        let metadata = fs::symlink_metadata(&child)?;
        if metadata.file_type().is_symlink() {
            if fs::metadata(&child).is_ok_and(|meta| meta.is_dir()) {
                unusable.push(skipped_skill(
                    &name,
                    source,
                    "the Skill directory is a symbolic link, which SuperTag does not follow",
                ));
            }
            continue;
        }
        let instructions =
            fs::symlink_metadata(child.join("SKILL.md")).is_ok_and(|meta| meta.is_file());
        if !metadata.is_dir() || !instructions {
            continue;
        }
        if validate_reference(&name).is_err() {
            unusable.push(skipped_skill(
                &name,
                source,
                "the Skill directory name is not supported",
            ));
            continue;
        }
        found.push((name, child));
    }
    Ok((found, unusable))
}
fn pin(
    set_id: &str,
    item: &PolicyContextItem,
    reference: &str,
    (version, digest, source): (String, String, String),
) -> ContextPin {
    ContextPin {
        set_id: set_id.into(),
        item_id: item.item_id.clone(),
        item_key: item.item_key.clone(),
        reference: reference.into(),
        version,
        digest,
        source,
    }
}
fn omission(set_id: &str, item: &PolicyContextItem, reason: &str) -> OmittedContextItem {
    OmittedContextItem {
        set_id: set_id.into(),
        item_id: item.item_id.clone(),
        item_key: item.item_key.clone(),
        r#type: item.r#type.clone(),
        version: item.version,
        reason: reason.into(),
    }
}
fn skipped_skill(reference: &str, source: &str, reason: &str) -> SkippedSkill {
    let bounded = |value: &str| {
        value
            .chars()
            .filter(|c| !c.is_control())
            .take(MAX_REASON)
            .collect::<String>()
    };
    SkippedSkill {
        reference: bounded(reference),
        source: bounded(source),
        reason: bounded(reason),
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
    manifest.pins.is_empty() && manifest.omissions.is_empty() && manifest.skipped.is_empty()
}
fn canonicalize(manifest: &mut ContextResolutionManifest) {
    manifest.pins.sort_by(|a, b| {
        (&a.set_id, &a.item_id, &a.reference).cmp(&(&b.set_id, &b.item_id, &b.reference))
    });
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
                None,
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
        let resolver = ContextCatalog::load(Some(&catalog), None).unwrap();
        let prepared = resolver
            .prepare_blocking(
                &task(true, TYPE),
                &root,
                "attempt",
                &ContextResolutionManifest::default(),
                None,
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
                    None,
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
                    None,
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
                None,
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
                    None,
                    &CancellationToken::new()
                )
                .is_err()
        );
        let catalog = root.join("catalog");
        fs::create_dir(&catalog).unwrap();
        let resolver = ContextCatalog::load(Some(&catalog), None).unwrap();
        assert!(
            resolver
                .prepare_blocking(
                    &task(false, TYPE),
                    &root,
                    "missing",
                    &ContextResolutionManifest::default(),
                    None,
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
        let resolver = ContextCatalog::load(Some(&catalog), None).unwrap();
        let prepared = resolver
            .prepare_blocking(
                &task(true, TYPE),
                &root,
                "attempt",
                &ContextResolutionManifest::default(),
                None,
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
    fn write_skill(directory: &Path, name: &str, body: &str) {
        fs::create_dir_all(directory.join(name)).unwrap();
        fs::write(directory.join(name).join("SKILL.md"), body).unwrap();
    }
    fn item(id: &str, required: bool, config: serde_json::Value) -> PolicyContextItem {
        PolicyContextItem {
            artifact_snapshot: None,
            item_id: id.into(),
            item_key: id.into(),
            r#type: TYPE.into(),
            version: 1,
            required,
            config_json: config.to_string(),
        }
    }
    fn with_items(items: Vec<PolicyContextItem>) -> Task {
        let mut task = task(false, TYPE);
        task.policy_snapshot.as_mut().unwrap().context_sets[0].items = items;
        task
    }
    fn private_root() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        (temp, root)
    }
    #[test]
    fn every_source_resolves_by_precedence_and_records_what_it_shadowed() {
        let (_temp, root) = private_root();
        let catalog = root.join("catalog");
        write_skill(&catalog, "review", "catalog review");
        let home = root.join("home");
        write_skill(&home.join(".claude/skills"), "review", "user review");
        write_skill(&home.join(".claude/skills"), "lint", "user lint");
        write_skill(&home.join(".agents/skills"), "lint", "agents lint");
        // A symbolic link to a Skill is not followed; one without SKILL.md is not a Skill.
        write_skill(&root.join("elsewhere"), "linked", "linked");
        std::os::unix::fs::symlink(
            root.join("elsewhere/linked"),
            home.join(".agents/skills/linked"),
        )
        .unwrap();
        fs::create_dir_all(home.join(".agents/skills/notes")).unwrap();
        let repository = root.join("repository");
        write_skill(&repository.join("claude"), "deploy", "repository deploy");
        write_skill(&repository.join("agents"), "lint", "repository lint");
        fs::create_dir_all(repository.join("agents")).unwrap();
        let commit = "a".repeat(40);
        let repository = RepositorySkills {
            root: repository,
            commit: commit.clone(),
            skipped: vec![SkippedRepositorySkill {
                root: ".claude/skills",
                name: "unsafe".into(),
                reason: "the Skill holds a symbolic link".into(),
            }],
        };
        let resolver = ContextCatalog::load(Some(&catalog), Some(&home)).unwrap();
        let task = with_items(vec![
            item("named", true, serde_json::json!({"reference": "review"})),
            item("all", false, serde_json::json!({"reference": "*"})),
        ]);
        let state = root.join("state");
        fs::create_dir(&state).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
        let prepared = resolver
            .prepare_blocking(
                &task,
                &state,
                "attempt",
                &Default::default(),
                Some(&repository),
                &CancellationToken::new(),
            )
            .unwrap();
        let manifest = prepared.manifest().unwrap();
        let pins: Vec<_> = manifest
            .pins
            .iter()
            .map(|pin| {
                (
                    pin.item_id.as_str(),
                    pin.reference.as_str(),
                    pin.source.as_str(),
                    pin.version.as_str(),
                )
            })
            .collect();
        assert_eq!(
            pins,
            [
                (
                    "all",
                    "deploy",
                    "repository:.claude/skills",
                    commit.as_str()
                ),
                ("all", "lint", "repository:.agents/skills", commit.as_str()),
                ("all", "review", "catalog", ""),
                ("named", "review", "catalog", ""),
            ]
        );
        assert!(manifest.omissions.is_empty());
        let skipped: Vec<_> = manifest
            .skipped
            .iter()
            .map(|skip| (skip.reference.as_str(), skip.source.as_str()))
            .collect();
        assert_eq!(
            skipped,
            [
                ("linked", "user:~/.agents/skills"),
                ("lint", "user:~/.agents/skills"),
                ("lint", "user:~/.claude/skills"),
                ("review", "user:~/.claude/skills"),
                ("unsafe", "repository:.claude/skills"),
            ]
        );
        assert!(
            manifest.skipped[1]
                .reason
                .contains("from repository:.agents/skills takes precedence")
        );
        // The higher-precedence copy is the one delivered, once per name.
        let delivered = prepared.delivery().unwrap();
        assert_eq!(delivered.len(), 4);
        let review = delivered
            .iter()
            .find(|skill| skill.pin.as_ref().unwrap().reference == "review")
            .unwrap();
        assert_eq!(
            fs::read_to_string(PathBuf::from(&review.local_path).join("SKILL.md")).unwrap(),
            "catalog review"
        );
        // A retry that finds the same Skills resolves the same way; a changed one is refused.
        let retry = resolver
            .prepare_blocking(
                &task,
                &state,
                "retry",
                &manifest,
                Some(&repository),
                &CancellationToken::new(),
            )
            .unwrap();
        assert_eq!(retry.manifest().unwrap(), manifest);
        fs::write(home.join(".claude/skills/review/SKILL.md"), "changed").unwrap();
        write_skill(&home.join(".claude/skills"), "new", "new");
        assert!(
            resolver
                .prepare_blocking(
                    &task,
                    &state,
                    "changed",
                    &manifest,
                    Some(&repository),
                    &CancellationToken::new(),
                )
                .is_err()
        );
    }
    #[test]
    fn a_wildcard_loads_nothing_without_skills_and_a_named_item_reaches_the_users() {
        let (_temp, root) = private_root();
        let home = root.join("home");
        fs::create_dir(&home).unwrap();
        let resolver = ContextCatalog::load(None, Some(&home)).unwrap();
        // A host that loads Skills advertises the contract with no catalog configured.
        assert_eq!(resolver.supported_contracts().len(), 1);
        let prepare = |task: &Task, attempt: &str| {
            resolver.prepare_blocking(
                task,
                &root,
                attempt,
                &Default::default(),
                None,
                &CancellationToken::new(),
            )
        };
        let wildcard = with_items(vec![item(
            "all",
            false,
            serde_json::json!({"reference": "*"}),
        )]);
        let manifest = prepare(&wildcard, "empty").unwrap().manifest().unwrap();
        assert!(manifest.pins.is_empty());
        assert_eq!(manifest.omissions[0].reason, NO_SKILLS);
        // `*` can be neither required nor pinned.
        let required = with_items(vec![item(
            "all",
            true,
            serde_json::json!({"reference": "*"}),
        )]);
        assert!(prepare(&required, "required").is_err());
        let pinned = with_items(vec![item(
            "all",
            false,
            serde_json::json!({"reference": "*", "version": "1"}),
        )]);
        assert!(prepare(&pinned, "pinned").is_err());
        // A named item resolves a user's Skill.
        write_skill(&home.join(".agents/skills"), "deploy", "deploy");
        let named = with_items(vec![item(
            "named",
            true,
            serde_json::json!({"reference": "deploy"}),
        )]);
        let manifest = prepare(&named, "named").unwrap().manifest().unwrap();
        assert_eq!(manifest.pins[0].source, "user:~/.agents/skills");
        // A host whose harness loads no Skills advertises none and says why it omits one.
        let none = ContextCatalog::without_skills();
        assert!(none.supported_contracts().is_empty());
        let manifest = none
            .prepare_blocking(
                &wildcard,
                &root,
                "unsupported",
                &Default::default(),
                None,
                &CancellationToken::new(),
            )
            .unwrap()
            .manifest()
            .unwrap();
        assert_eq!(
            manifest.omissions[0].reason,
            "Harness does not support Skill inputs"
        );
        assert!(!harness_loads_skills(HarnessKind::Cursor));
        assert!(harness_loads_skills(HarnessKind::Opencode));
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
        let mut resolver = ContextCatalog::load(Some(&file), None).unwrap();
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
            None,
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
        let mut resolver = ContextCatalog::load(Some(&file), None).unwrap();
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
                None,
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
                None,
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
            assert!(
                ContextCatalog::load(Some(&file), None).is_err(),
                "{invalid}"
            );
        }
    }
}
