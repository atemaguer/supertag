//! A Tag's harness-native memory on this Worker Host: the files a harness keeps itself, such as
//! Claude Code's auto-memory. OpenCode and Cursor keep no memory of their own, so the host keeps a
//! folder in Claude Code's format for them ([`claude_format`]), which their adapters load into
//! each turn and let the harness edit with its file tools, confined to the folder.
//!
//! One store per Tag, harness, and scope (the Control Plane's grant: shared, or one person's)
//! lives in the host's artifact storage, which every lane of the host shares, at
//! `tags/<sha256(tag)>/native-memory/<harness>/<scope>/current`, beside the Tag's Session
//! checkpoints. Each Attempt gets its own copy to work in, in the lane's state directory; when its harness stops, the host merges the copy back file by file against
//! the revision it started from, so parallel Sessions of one Tag keep each other's memories.
//! The Control Plane never holds the files; the host reports only counts and a digest. Beside
//! each store the host keeps its canonical memory records, derived from the files
//! ([`crate::memory`]), which local clients read through the Worklet's memory endpoint.
//!
//! Only a turn whose changes are the Tag's own (`AttemptCapabilities.memory_trusted`: a root turn
//! or the daily review) merges back. Any other turn granted the store, such as a Work Session's
//! own turn, reads it as it was and leaves it so: what it wrote or changed is kept beside the store
//! as proposals ([`crate::memory::propose`]), which the next review lists in its request and
//! merges or drops. Before a turn starts, the host writes the grant's seeds into the store: the
//! notes the Tag kept before its harness's memory became its memory.
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::ErrorKind,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use supertag_protocol::v2::{HarnessKind, NativeMemoryGrant, NativeMemorySeed};

/// The environment variable naming the Attempt's working copy for the adapter.
pub(crate) const DIRECTORY: &str = "SUPERTAG_NATIVE_MEMORY_DIRECTORY";
pub(crate) const MAX_FILES: usize = 1_000;
pub(crate) const MAX_BYTES: u64 = 4 * 1024 * 1024;
pub(crate) const MAX_FILE_BYTES: u64 = 256 * 1024;
/// Harness bookkeeping that is not memory and never merges.
const IGNORED: &[&str] = &[".consolidate-lock"];
/// Directories a harness keeps beside its memory that never merge: Codex makes its memory folder
/// a git repository of its own.
const IGNORED_DIRECTORIES: &[&str] = &[".git"];
/// Index files list one memory per line; concurrent changes keep both sides' lines.
const INDEXES: &[&str] = &["MEMORY.md"];

/// The harnesses whose native memory a Worker Host keeps.
pub(crate) fn harness_directory(harness: HarnessKind) -> Option<&'static str> {
    match harness {
        HarnessKind::ClaudeCode => Some("claude-code"),
        HarnessKind::Codex => Some("codex"),
        HarnessKind::Opencode => Some("opencode"),
        HarnessKind::Cursor => Some("cursor"),
        _ => None,
    }
}

/// Every harness directory a store may be in.
pub(crate) const HARNESS_DIRECTORIES: &[&str] = &["claude-code", "codex", "opencode", "cursor"];

/// Whether a harness's memory folder is in Claude Code's format: a `MEMORY.md` index and one
/// Markdown file per memory. Claude Code's own, and the folder the host keeps for OpenCode and
/// Cursor, which keep no memory of their own.
pub(crate) fn claude_format(harness: &str) -> bool {
    matches!(harness, "claude-code" | "opencode" | "cursor")
}

pub(crate) fn component(kind: &str, value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.len() <= 128
            && !value.starts_with('.')
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')),
        "{kind} cannot name a native memory directory"
    );
    Ok(())
}

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct Meta {
    pub(crate) revision: u64,
    pub(crate) generation: u64,
    /// The Tag the store belongs to, which its hashed directory doesn't say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) tag: Option<String>,
    /// The seeds already written, so a seed granted again is never written twice.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub(crate) seeded: BTreeSet<String>,
}

/// What the store holds after an Attempt, for the Control Plane's record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Summary {
    pub(crate) revision: u64,
    pub(crate) files: u32,
    pub(crate) bytes: u64,
    pub(crate) digest: String,
    pub(crate) generation: u64,
}

pub(crate) type Files = BTreeMap<String, Vec<u8>>;

/// An Attempt's copy of its store.
pub(crate) struct Prepared {
    store: PathBuf,
    attempt: PathBuf,
    label: String,
    generation: u64,
    key: crate::memory::StoreKey,
    /// The grant's seeds, now in the store, for the Control Plane to drop.
    seeded: Vec<String>,
    /// What the harness loads of the index the copy started with.
    loaded: crate::memory_stats::Loaded,
    /// The proposals a review that finished was shown, which the merge-back drops.
    reviewed: std::sync::Mutex<Vec<String>>,
    /// What the turn's activity said about the memory folder.
    activity: std::sync::Mutex<crate::memory_stats::Activity>,
}

/// `YYYY-MM-DDTHH-MM-SS` in UTC, as Codex names its ad hoc notes.
fn note_timestamp(ms: i64) -> String {
    let seconds = ms.div_euclid(1000);
    let (days, rest) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}-{:02}-{:02}",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
}

/// A seed ID as part of a file name.
fn seed_name(seed: &str) -> String {
    seed.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .take(64)
        .collect()
}

fn one_line(text: &str, limit: usize) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    let line = line.replace(['[', ']'], "");
    if line.chars().count() <= limit {
        return line;
    }
    let mut short: String = line.chars().take(limit - 1).collect();
    short.push('…');
    short
}

/// `files` with `seeds` written into them as `harness`'s own memory: a memory file each, linked
/// from `MEMORY.md`, in a folder in Claude Code's format, or a Codex ad hoc note each. A seed
/// whose file is there already is left as it is.
pub(crate) fn seeded(harness: &str, files: &Files, seeds: &[NativeMemorySeed]) -> Files {
    let mut files = files.clone();
    for seed in seeds {
        let name = seed_name(&seed.seed_id);
        let text = seed.text.trim();
        if name.is_empty() || text.is_empty() {
            continue;
        }
        match harness {
            harness if claude_format(harness) => {
                let path = format!("supertag_note_{name}.md");
                if files.contains_key(&path) {
                    continue;
                }
                let title = one_line(text, 80);
                let hook = one_line(text, 150);
                files.insert(
                    path.clone(),
                    format!(
                        "---\nname: {title}\ndescription: {hook}\ntype: feedback\n---\n{text}\n\nKept as a SuperTag note on {}.\n",
                        &note_timestamp(seed.created_at_ms)[..10]
                    )
                    .into_bytes(),
                );
                let mut index = files
                    .get("MEMORY.md")
                    .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
                    .unwrap_or_default();
                if !index.is_empty() && !index.ends_with('\n') {
                    index.push('\n');
                }
                index.push_str(&format!("- [{title}]({path}) — {hook}\n"));
                files.insert("MEMORY.md".into(), index.into_bytes());
            }
            "codex" => {
                let path = format!(
                    "extensions/ad_hoc/notes/{}-supertag-note-{name}.md",
                    note_timestamp(seed.created_at_ms)
                );
                files
                    .entry(path)
                    .or_insert_with(|| format!("{text}\n").into_bytes());
            }
            _ => {}
        }
    }
    files
}

pub(crate) fn private_directory(path: &Path) -> Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .with_context(|| format!("create {}", path.display()))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

pub(crate) fn remove(path: &Path) -> Result<()> {
    match fs::remove_dir_all(path) {
        Err(error) if error.kind() != ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}

/// Holds the store's lock until dropped.
pub(crate) struct Lock(fs::File);

impl Lock {
    pub(crate) fn take(store: &Path) -> Result<Self> {
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .mode(0o600)
            .open(store.join(".lock"))?;
        use std::os::fd::AsRawFd;
        // SAFETY: flock on a descriptor this function owns.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(std::io::Error::last_os_error()).context("lock native memory");
        }
        Ok(Self(file))
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        // SAFETY: unlocks the descriptor this value owns.
        unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN) };
    }
}

pub(crate) fn read_meta(store: &Path) -> Result<Meta> {
    match fs::read(store.join("meta.json")) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_default()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(Meta::default()),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn write_meta(store: &Path, meta: &Meta) -> Result<()> {
    let temporary = store.join("meta.json.tmp");
    fs::write(&temporary, serde_json::to_vec(meta)?)?;
    fs::rename(temporary, store.join("meta.json"))?;
    Ok(())
}

/// Every memory file under `root`, by `/`-separated relative path. A link, a special file, or a
/// file over its cap refuses the whole copy: nothing outside plain memory files ever merges.
pub(crate) fn snapshot(root: &Path) -> Result<Files> {
    let mut files = Files::new();
    let mut pending = vec![PathBuf::new()];
    while let Some(relative) = pending.pop() {
        let entries = match fs::read_dir(root.join(&relative)) {
            Ok(entries) => entries,
            Err(error)
                if error.kind() == ErrorKind::NotFound && relative.as_os_str().is_empty() =>
            {
                return Ok(files);
            }
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            let entry = entry?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("native memory holds a name that is not UTF-8"))?;
            let path = relative.join(&name);
            let kind = entry.file_type()?;
            if kind.is_dir() {
                if !IGNORED_DIRECTORIES.contains(&name.as_str()) {
                    pending.push(path);
                }
            } else if kind.is_file() {
                if IGNORED.contains(&name.as_str()) {
                    continue;
                }
                let metadata = entry.metadata()?;
                ensure!(
                    metadata.len() <= MAX_FILE_BYTES,
                    "native memory file {} is over {} KiB",
                    path.display(),
                    MAX_FILE_BYTES / 1024
                );
                let key = path.to_str().context("native memory path")?.to_owned();
                files.insert(key, fs::read(entry.path())?);
                ensure!(
                    files.len() <= MAX_FILES,
                    "native memory holds over {MAX_FILES} files"
                );
            } else {
                bail!(
                    "native memory holds a link or special file: {}",
                    path.display()
                );
            }
        }
    }
    Ok(files)
}

pub(crate) fn write_tree(root: &Path, files: &Files) -> Result<()> {
    private_directory(root)?;
    for (path, contents) in files {
        let target = root.join(path);
        if let Some(parent) = target.parent() {
            private_directory(parent)?;
        }
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&target)?;
        std::io::Write::write_all(&mut file, contents)?;
    }
    Ok(())
}

fn summarize(files: &Files, meta: &Meta) -> Summary {
    let mut hasher = Sha256::new();
    for (path, contents) in files {
        hasher.update(path.as_bytes());
        hasher.update([0]);
        hasher.update((contents.len() as u64).to_le_bytes());
        hasher.update(contents);
    }
    Summary {
        revision: meta.revision,
        files: files.len() as u32,
        bytes: files.values().map(|contents| contents.len() as u64).sum(),
        digest: format!("{:x}", hasher.finalize()),
        generation: meta.generation,
    }
}

/// Both sides' lines of an index, theirs first, each line once.
fn union_lines(theirs: &[u8], ours: &[u8]) -> Vec<u8> {
    let theirs = String::from_utf8_lossy(theirs);
    let ours = String::from_utf8_lossy(ours);
    let mut seen = BTreeSet::new();
    let mut lines = vec![];
    for line in theirs.lines().chain(ours.lines()) {
        if line.trim().is_empty() || seen.insert(line.to_owned()) {
            lines.push(line);
        }
    }
    let mut merged = lines.join("\n");
    merged.push('\n');
    merged.into_bytes()
}

fn conflict_name(path: &str, label: &str) -> String {
    match path.rsplit_once('.') {
        Some((stem, extension)) if !stem.ends_with('/') && !extension.contains('/') => {
            format!("{stem}.conflict-{label}.{extension}")
        }
        _ => format!("{path}.conflict-{label}"),
    }
}

/// The three-way merge of one Attempt's copy (`ours`) into the store (`theirs`), both changed
/// from `base`. A file only one side changed takes that side; a file both changed takes ours,
/// keeping theirs beside it, except an index, which keeps both sides' lines. A deletion stands
/// only where the other side left the file alone.
pub(crate) fn merge(base: &Files, ours: &Files, theirs: &Files, label: &str) -> Files {
    let mut merged = Files::new();
    let paths: BTreeSet<&String> = base
        .keys()
        .chain(ours.keys())
        .chain(theirs.keys())
        .collect();
    for path in paths {
        let (b, o, t) = (base.get(path), ours.get(path), theirs.get(path));
        let chosen = if o == b {
            t
        } else if t == b || o == t {
            o
        } else {
            match (o, t) {
                (Some(o), Some(t)) => {
                    let name = path.rsplit('/').next().unwrap_or(path);
                    if INDEXES.contains(&name) {
                        merged.insert(path.clone(), union_lines(t, o));
                    } else {
                        merged.insert(path.clone(), o.clone());
                        merged.insert(conflict_name(path, label), t.clone());
                    }
                    continue;
                }
                // One side deleted what the other changed: the change stands.
                (Some(o), None) => Some(o),
                (None, t) => t,
            }
        };
        if let Some(contents) = chosen {
            merged.insert(path.clone(), contents.clone());
        }
    }
    merged
}

/// Makes `files` the store's current revision, the next after `meta`'s, under the store's lock,
/// which the caller holds: the old revision stays whole until the new one has replaced it.
pub(crate) fn replace_current(
    store: &Path,
    meta: &mut Meta,
    files: &Files,
    label: &str,
) -> Result<()> {
    check_caps(files)?;
    let next = store.join(format!("next-{label}"));
    remove(&next)?;
    write_tree(&next, files)?;
    let previous = store.join(format!("previous-{label}"));
    remove(&previous)?;
    match fs::rename(store.join("current"), &previous) {
        Err(error) if error.kind() != ErrorKind::NotFound => return Err(error.into()),
        _ => {}
    }
    fs::rename(&next, store.join("current"))?;
    meta.revision += 1;
    write_meta(store, meta)?;
    remove(&previous)?;
    Ok(())
}

pub(crate) fn check_caps(files: &Files) -> Result<()> {
    ensure!(
        files.len() <= MAX_FILES,
        "native memory would hold over {MAX_FILES} files"
    );
    let bytes: u64 = files.values().map(|contents| contents.len() as u64).sum();
    ensure!(
        bytes <= MAX_BYTES,
        "native memory would hold over {} MiB",
        MAX_BYTES / 1024 / 1024
    );
    ensure!(
        files
            .values()
            .all(|contents| contents.len() as u64 <= MAX_FILE_BYTES),
        "a native memory file would be over {} KiB",
        MAX_FILE_BYTES / 1024
    );
    Ok(())
}

impl Prepared {
    /// Copies the store into a fresh working copy for `attempt`. A copy made before the Tag's
    /// latest reset (`grant.reset_generation`) is dropped first.
    pub(crate) fn prepare(
        (storage, state): (&Path, &Path),
        tag: &str,
        harness: &str,
        attempt: &str,
        grant: &NativeMemoryGrant,
    ) -> Result<Self> {
        component("Tag ID", tag)?;
        component("harness", harness)?;
        component("native memory scope", &grant.scope)?;
        component("Attempt ID", attempt)?;
        let store = crate::worklet::checkpoints::tag_directory(storage, tag)
            .join("native-memory")
            .join(harness)
            .join(&grant.scope);
        private_directory(&store)?;
        let attempt_root = state.join("native-memory-attempts").join(attempt);
        remove(&attempt_root)?;
        private_directory(&attempt_root)?;
        let _lock = Lock::take(&store)?;
        let mut meta = read_meta(&store)?;
        if meta.generation != grant.reset_generation {
            remove(&store.join("current"))?;
            crate::memory::forget_records(&store)?;
            if meta.revision > 0 {
                crate::memory_stats::count(&store, |counters| counters.resets += 1);
            }
            meta = Meta {
                revision: 0,
                generation: grant.reset_generation,
                tag: None,
                ..Default::default()
            };
            write_meta(&store, &meta)?;
        }
        if meta.tag.as_deref() != Some(tag) {
            meta.tag = Some(tag.to_owned());
            write_meta(&store, &meta)?;
        }
        let key = crate::memory::StoreKey {
            tag: tag.to_owned(),
            harness: harness.to_owned(),
            scope: grant.scope.clone(),
        };
        // The notes the Tag kept before become its harness's own memory, once.
        let fresh: Vec<NativeMemorySeed> = grant
            .seeds
            .iter()
            .filter(|seed| !meta.seeded.contains(&seed.seed_id))
            .cloned()
            .collect();
        if !fresh.is_empty() {
            let files = snapshot(&store.join("current"))?;
            let with_seeds = seeded(harness, &files, &fresh);
            meta.seeded
                .extend(fresh.iter().map(|seed| seed.seed_id.clone()));
            if with_seeds == files {
                write_meta(&store, &meta)?;
            } else {
                replace_current(&store, &mut meta, &with_seeds, "seeds")?;
                if let Err(error) = crate::memory::refresh(&store, &key, (&with_seeds, &meta), None)
                {
                    crate::failures::note("Native memory records were not updated", &error);
                }
                let delivered = crate::memory::changes(harness, &files, &with_seeds).written;
                crate::memory_stats::count(&store, |counters| {
                    counters.seeds_delivered += delivered;
                });
            }
        }
        let current = snapshot(&store.join("current"))?;
        write_tree(&attempt_root.join("base"), &current)?;
        write_tree(&attempt_root.join("work"), &current)?;
        Ok(Self {
            loaded: crate::memory_stats::loaded(harness, &current),
            reviewed: std::sync::Mutex::default(),
            activity: std::sync::Mutex::default(),
            store,
            attempt: attempt_root,
            label: attempt.chars().take(8).collect(),
            generation: grant.reset_generation,
            key,
            seeded: grant
                .seeds
                .iter()
                .map(|seed| seed.seed_id.clone())
                .collect(),
        })
    }

    /// The grant's seeds, now in the store.
    pub(crate) fn seeded(&self) -> &[String] {
        &self.seeded
    }

    /// The harness directory the store is kept under.
    pub(crate) fn harness(&self) -> &str {
        &self.key.harness
    }

    /// The proposals waiting in the store, and what the request of the store's review adds for
    /// them.
    pub(crate) fn review_proposals(&self) -> Result<(String, Vec<String>)> {
        let _lock = Lock::take(&self.store)?;
        let meta = read_meta(&self.store)?;
        Ok(crate::memory::review_section(&crate::memory::proposals(
            &self.store,
            meta.generation,
        )))
    }

    /// Marks the proposals a review was shown, once it finished: the merge-back drops them,
    /// counting each the store then holds as merged and the rest as dropped.
    pub(crate) fn reviewed(&self, shown: &[String]) {
        self.reviewed
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .extend(shown.iter().cloned());
    }

    /// The memory folder's paths as the harness may name them in its activity: the working copy,
    /// and its canonical path.
    pub(crate) fn folder_names(&self) -> Vec<String> {
        let work = self.working_directory();
        let mut names = vec![work.to_string_lossy().into_owned()];
        if let Ok(canonical) = work.canonicalize() {
            names.push(canonical.to_string_lossy().into_owned());
        }
        names.dedup();
        names
    }

    /// Records what the turn's activity said about the memory folder.
    pub(crate) fn noted(&self, activity: crate::memory_stats::Activity) {
        *self
            .activity
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = activity;
    }

    /// The directory the harness reads and writes as its memory.
    pub(crate) fn working_directory(&self) -> PathBuf {
        self.attempt.join("work")
    }

    /// Merges the working copy back and removes it. On an error the store keeps its previous
    /// revision. `writer` is the turn, recorded as the source of each memory it changed; a turn
    /// that may not change the Tag's memory only proposes its changes, and the store stays as it
    /// was. Without a `writer` the copy merges with no recorded source.
    pub(crate) fn finish(self, writer: Option<crate::memory::Writer>) -> Result<Summary> {
        let result = self.merge_back(writer);
        let removed = remove(&self.attempt);
        let summary = result?;
        removed?;
        Ok(summary)
    }

    fn merge_back(&self, writer: Option<crate::memory::Writer>) -> Result<Summary> {
        let base = snapshot(&self.attempt.join("base"));
        let ours = snapshot(&self.working_directory());
        let _lock = Lock::take(&self.store)?;
        let theirs = snapshot(&self.store.join("current"))?;
        let review = writer.as_ref().is_some_and(|writer| {
            writer
                .session_id
                .starts_with(supertag_protocol::MEMORY_REVIEW_SESSION_PREFIX)
        });
        let proposing = writer
            .as_ref()
            .is_some_and(|writer| writer.trusted != Some(true));
        let result = self.merge_locked(writer.as_ref(), base, ours, &theirs);
        let meta = read_meta(&self.store)?;
        let after = match &result {
            Ok((_, Some(merged))) => merged.clone(),
            _ => theirs.clone(),
        };
        // A review that finished merged or dropped what it was shown.
        let shown = std::mem::take(
            &mut *self
                .reviewed
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        let (mut merged_proposals, mut dropped_proposals) = (0, 0);
        if !shown.is_empty() && meta.generation == self.generation {
            for proposal in crate::memory::proposals(&self.store, meta.generation)
                .iter()
                .filter(|proposal| shown.contains(&proposal.record.memory_id))
            {
                if crate::memory::holds(&self.key.harness, &after, proposal) {
                    merged_proposals += 1;
                } else {
                    dropped_proposals += 1;
                }
            }
            crate::memory::drop_proposals(&self.store, meta.generation, &shown)?;
        }
        let changes = if proposing {
            crate::memory_stats::Changes::default()
        } else {
            crate::memory::changes(&self.key.harness, &theirs, &after)
        };
        let conflicts = after
            .keys()
            .filter(|path| !theirs.contains_key(*path) && path.contains(".conflict-"))
            .count() as u64;
        let loaded = self.loaded;
        let activity = *self
            .activity
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        crate::memory_stats::count(&self.store, |counters| {
            counters.turns += 1;
            counters.review_turns += u64::from(review);
            counters.proposing_turns += u64::from(proposing);
            if loaded.lines > 0 {
                counters.turns_loaded += 1;
                counters.loaded_bytes += loaded.bytes;
                counters.loaded_lines += loaded.lines;
            }
            counters.truncated_turns += u64::from(loaded.truncated);
            counters.recalls += activity.recalls;
            counters.memory_edits += activity.edits;
            if review {
                counters.review_written += changes.written;
                counters.review_updated += changes.updated;
                counters.review_deleted += changes.deleted;
                counters.last_review_at_ms = Some(crate::memory_stats::now_ms());
            } else {
                counters.written += changes.written;
                counters.updated += changes.updated;
                counters.deleted += changes.deleted;
            }
            counters.conflicts += conflicts;
            counters.proposals_reviewed += merged_proposals + dropped_proposals;
            counters.proposals_merged += merged_proposals;
            counters.proposals_dropped += dropped_proposals;
            counters.last_turn_at_ms = Some(crate::memory_stats::now_ms());
        });
        result.map(|(summary, _)| summary)
    }

    /// The merge-back under the store's lock: the store's summary afterwards, and its files when
    /// this turn changed them.
    fn merge_locked(
        &self,
        writer: Option<&crate::memory::Writer>,
        base: Result<Files>,
        ours: Result<Files>,
        theirs: &Files,
    ) -> Result<(Summary, Option<Files>)> {
        let mut meta = read_meta(&self.store)?;
        let theirs_summary = summarize(theirs, &meta);
        // A reset since this Attempt started drops what it wrote.
        if meta.generation != self.generation {
            return Ok((theirs_summary, None));
        }
        let (base, ours) = (base?, ours?);
        if let Some(writer) = writer.filter(|writer| writer.trusted != Some(true)) {
            check_caps(&ours)?;
            crate::memory::propose(&self.store, &self.key, (&meta, writer), (&base, &ours))?;
            return Ok((theirs_summary, None));
        }
        let merged = merge(&base, &ours, theirs, &self.label);
        if &merged == theirs {
            return Ok((theirs_summary, None));
        }
        replace_current(&self.store, &mut meta, &merged, &self.label)?;
        // The files are the memory and the records are derived from them, so a failure here
        // only leaves the records to be rebuilt, without this turn as the source of its changes.
        let changed: BTreeSet<String> = ours
            .iter()
            .filter(|(path, contents)| base.get(*path) != Some(*contents))
            .map(|(path, _)| path.clone())
            .collect();
        if let Err(error) = crate::memory::refresh(
            &self.store,
            &self.key,
            (&merged, &meta),
            writer.map(|writer| (writer, &changed)),
        ) {
            crate::failures::note("Native memory records were not updated", &error);
        }
        Ok((summarize(&merged, &meta), Some(merged)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(entries: &[(&str, &str)]) -> Files {
        entries
            .iter()
            .map(|(path, contents)| ((*path).to_owned(), contents.as_bytes().to_vec()))
            .collect()
    }

    fn grant(generation: u64) -> NativeMemoryGrant {
        NativeMemoryGrant {
            scope: "shared".into(),
            reset_generation: generation,
            volume_head: None,
            seeds: vec![],
            trusted: true,
        }
    }

    #[test]
    fn a_file_one_side_changed_takes_that_side() {
        let base = files(&[("a.md", "1"), ("b.md", "1"), ("gone.md", "x")]);
        let ours = files(&[("a.md", "2"), ("b.md", "1"), ("new.md", "n")]);
        let theirs = files(&[("a.md", "1"), ("b.md", "3"), ("gone.md", "x")]);
        assert_eq!(
            merge(&base, &ours, &theirs, "att"),
            files(&[("a.md", "2"), ("b.md", "3"), ("new.md", "n")])
        );
    }

    #[test]
    fn both_changed_keeps_both_and_an_index_keeps_every_line() {
        let base = files(&[("MEMORY.md", "- a\n"), ("note.md", "old")]);
        let ours = files(&[("MEMORY.md", "- a\n- ours\n"), ("note.md", "ours")]);
        let theirs = files(&[("MEMORY.md", "- a\n- theirs\n"), ("note.md", "theirs")]);
        let merged = merge(&base, &ours, &theirs, "att12345");
        assert_eq!(merged["MEMORY.md"], b"- a\n- theirs\n- ours\n");
        assert_eq!(merged["note.md"], b"ours");
        assert_eq!(merged["note.conflict-att12345.md"], b"theirs");
    }

    #[test]
    fn a_deletion_never_drops_the_other_sides_change() {
        let base = files(&[("a.md", "1"), ("b.md", "1")]);
        let ours = files(&[("b.md", "2")]);
        let theirs = files(&[("a.md", "9")]);
        assert_eq!(
            merge(&base, &ours, &theirs, "att"),
            files(&[("a.md", "9"), ("b.md", "2")])
        );
    }

    #[test]
    fn parallel_attempts_both_land_and_a_reset_drops_older_copies() -> Result<()> {
        let state = tempfile::tempdir()?;
        let first = Prepared::prepare(
            (state.path(), state.path()),
            "tag-1",
            "claude-code",
            "attempt-1",
            &grant(0),
        )?;
        let second = Prepared::prepare(
            (state.path(), state.path()),
            "tag-1",
            "claude-code",
            "attempt-2",
            &grant(0),
        )?;
        fs::write(first.working_directory().join("one.md"), "first")?;
        fs::write(first.working_directory().join("MEMORY.md"), "- one\n")?;
        fs::write(second.working_directory().join("two.md"), "second")?;
        fs::write(second.working_directory().join("MEMORY.md"), "- two\n")?;
        assert_eq!(first.finish(None)?.revision, 1);
        let summary = second.finish(None)?;
        assert_eq!((summary.revision, summary.files), (2, 3));
        let current = crate::worklet::checkpoints::tag_directory(state.path(), "tag-1")
            .join("native-memory/claude-code/shared/current");
        assert_eq!(
            fs::read_to_string(current.join("MEMORY.md"))?,
            "- one\n- two\n"
        );
        assert!(
            !state
                .path()
                .join("native-memory-attempts/attempt-1")
                .exists()
        );

        let unchanged = Prepared::prepare(
            (state.path(), state.path()),
            "tag-1",
            "claude-code",
            "attempt-3",
            &grant(0),
        )?;
        assert_eq!(
            fs::read_to_string(unchanged.working_directory().join("one.md"))?,
            "first"
        );
        assert_eq!(unchanged.finish(None)?.revision, 2);

        let reset = Prepared::prepare(
            (state.path(), state.path()),
            "tag-1",
            "claude-code",
            "attempt-4",
            &grant(1),
        )?;
        assert!(fs::read_dir(reset.working_directory())?.next().is_none());
        let summary = reset.finish(None)?;
        assert_eq!(
            (summary.revision, summary.files, summary.generation),
            (0, 0, 1)
        );
        Ok(())
    }

    #[test]
    fn a_turn_over_the_caps_or_with_a_link_leaves_the_store_as_it_was() -> Result<()> {
        let state = tempfile::tempdir()?;
        let big = Prepared::prepare(
            (state.path(), state.path()),
            "tag",
            "claude-code",
            "attempt-a",
            &grant(0),
        )?;
        fs::write(
            big.working_directory().join("big.md"),
            vec![b'x'; MAX_FILE_BYTES as usize + 1],
        )?;
        assert!(big.finish(None).is_err());
        let linked = Prepared::prepare(
            (state.path(), state.path()),
            "tag",
            "claude-code",
            "attempt-b",
            &grant(0),
        )?;
        std::os::unix::fs::symlink("/etc/passwd", linked.working_directory().join("p.md"))?;
        assert!(linked.finish(None).is_err());
        let after = Prepared::prepare(
            (state.path(), state.path()),
            "tag",
            "claude-code",
            "attempt-c",
            &grant(0),
        )?;
        assert!(fs::read_dir(after.working_directory())?.next().is_none());
        assert_eq!(after.finish(None)?.revision, 0);
        assert!(
            !state
                .path()
                .join("native-memory-attempts/attempt-a")
                .exists()
        );
        Ok(())
    }

    #[test]
    fn a_harness_git_repository_never_merges() -> Result<()> {
        let state = tempfile::tempdir()?;
        let turn = Prepared::prepare(
            (state.path(), state.path()),
            "tag",
            "codex",
            "attempt-g",
            &grant(0),
        )?;
        let work = turn.working_directory();
        fs::create_dir_all(work.join(".git/objects"))?;
        fs::write(work.join(".git/HEAD"), "ref: refs/heads/main")?;
        fs::create_dir_all(work.join("extensions/ad_hoc/notes"))?;
        fs::write(work.join("extensions/ad_hoc/notes/region.md"), "eu-north-1")?;
        let summary = turn.finish(None)?;
        assert_eq!(summary.files, 1);
        let current = crate::worklet::checkpoints::tag_directory(state.path(), "tag")
            .join("native-memory/codex/shared/current");
        assert!(current.join("extensions/ad_hoc/notes/region.md").is_file());
        assert!(!current.join(".git").exists());
        Ok(())
    }

    #[test]
    fn names_that_could_leave_the_store_are_refused() {
        for bad in ["", "..", "../x", "a/b", ".hidden"] {
            assert!(
                Prepared::prepare(
                    (Path::new("/nonexistent"), Path::new("/nonexistent")),
                    bad,
                    "claude-code",
                    "a",
                    &grant(0)
                )
                .is_err(),
                "{bad}"
            );
        }
    }
}
