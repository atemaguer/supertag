//! A Tag's harness-native memory on this Worker Host: the files a harness keeps itself, such as
//! Claude Code's auto-memory.
//!
//! One store per Tag, harness, and scope (the Control Plane's grant: shared, or one person's)
//! lives in the host's artifact storage, which every lane of the host shares, at
//! `tags/<sha256(tag)>/native-memory/<harness>/<scope>/current`, beside the Tag's Session
//! checkpoints. Each Attempt gets its own copy to work in, in the lane's state directory; when its harness stops, the host merges the copy back file by file against
//! the revision it started from, so parallel Sessions of one Tag keep each other's memories.
//! The Control Plane never holds the files; the host reports only counts and a digest.
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
use supertag_protocol::v2::{HarnessKind, NativeMemoryGrant};

/// The environment variable naming the Attempt's working copy for the adapter.
pub(crate) const DIRECTORY: &str = "SUPERTAG_NATIVE_MEMORY_DIRECTORY";
pub(crate) const MAX_FILES: usize = 1_000;
pub(crate) const MAX_BYTES: u64 = 4 * 1024 * 1024;
pub(crate) const MAX_FILE_BYTES: u64 = 256 * 1024;
/// Harness bookkeeping that is not memory and never merges.
const IGNORED: &[&str] = &[".consolidate-lock"];
/// Index files list one memory per line; concurrent changes keep both sides' lines.
const INDEXES: &[&str] = &["MEMORY.md"];

/// The harnesses whose native memory a Worker Host keeps.
pub(crate) fn harness_directory(harness: HarnessKind) -> Option<&'static str> {
    match harness {
        HarnessKind::ClaudeCode => Some("claude-code"),
        _ => None,
    }
}

fn component(kind: &str, value: &str) -> Result<()> {
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
struct Meta {
    revision: u64,
    generation: u64,
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

type Files = BTreeMap<String, Vec<u8>>;

/// An Attempt's copy of its store.
pub(crate) struct Prepared {
    store: PathBuf,
    attempt: PathBuf,
    label: String,
    generation: u64,
}

fn private_directory(path: &Path) -> Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .with_context(|| format!("create {}", path.display()))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn remove(path: &Path) -> Result<()> {
    match fs::remove_dir_all(path) {
        Err(error) if error.kind() != ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}

/// Holds the store's lock until dropped.
struct Lock(fs::File);

impl Lock {
    fn take(store: &Path) -> Result<Self> {
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

fn read_meta(store: &Path) -> Result<Meta> {
    match fs::read(store.join("meta.json")) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_default()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(Meta::default()),
        Err(error) => Err(error.into()),
    }
}

fn write_meta(store: &Path, meta: &Meta) -> Result<()> {
    let temporary = store.join("meta.json.tmp");
    fs::write(&temporary, serde_json::to_vec(meta)?)?;
    fs::rename(temporary, store.join("meta.json"))?;
    Ok(())
}

/// Every memory file under `root`, by `/`-separated relative path. A link, a special file, or a
/// file over its cap refuses the whole copy: nothing outside plain memory files ever merges.
fn snapshot(root: &Path) -> Result<Files> {
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
                pending.push(path);
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

fn write_tree(root: &Path, files: &Files) -> Result<()> {
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

fn check_caps(files: &Files) -> Result<()> {
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
        let store = crate::checkpoints::tag_directory(storage, tag)
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
            meta = Meta {
                revision: 0,
                generation: grant.reset_generation,
            };
            write_meta(&store, &meta)?;
        }
        let current = snapshot(&store.join("current"))?;
        write_tree(&attempt_root.join("base"), &current)?;
        write_tree(&attempt_root.join("work"), &current)?;
        Ok(Self {
            store,
            attempt: attempt_root,
            label: attempt.chars().take(8).collect(),
            generation: grant.reset_generation,
        })
    }

    /// The directory the harness reads and writes as its memory.
    pub(crate) fn working_directory(&self) -> PathBuf {
        self.attempt.join("work")
    }

    /// Merges the working copy back and removes it. On an error the store keeps its previous
    /// revision.
    pub(crate) fn finish(self) -> Result<Summary> {
        let result = self.merge_back();
        let removed = remove(&self.attempt);
        let summary = result?;
        removed?;
        Ok(summary)
    }

    fn merge_back(&self) -> Result<Summary> {
        let base = snapshot(&self.attempt.join("base"))?;
        let ours = snapshot(&self.working_directory());
        let _lock = Lock::take(&self.store)?;
        let mut meta = read_meta(&self.store)?;
        let theirs = snapshot(&self.store.join("current"))?;
        let theirs_summary = summarize(&theirs, &meta);
        // A reset since this Attempt started drops what it wrote.
        if meta.generation != self.generation {
            return Ok(theirs_summary);
        }
        let ours = ours?;
        let merged = merge(&base, &ours, &theirs, &self.label);
        if merged == theirs {
            return Ok(theirs_summary);
        }
        check_caps(&merged)?;
        let next = self.store.join(format!("next-{}", self.label));
        remove(&next)?;
        write_tree(&next, &merged)?;
        let previous = self.store.join(format!("previous-{}", self.label));
        remove(&previous)?;
        match fs::rename(self.store.join("current"), &previous) {
            Err(error) if error.kind() != ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
        fs::rename(&next, self.store.join("current"))?;
        meta.revision += 1;
        write_meta(&self.store, &meta)?;
        remove(&previous)?;
        Ok(summarize(&merged, &meta))
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
        assert_eq!(first.finish()?.revision, 1);
        let summary = second.finish()?;
        assert_eq!((summary.revision, summary.files), (2, 3));
        let current = crate::checkpoints::tag_directory(state.path(), "tag-1")
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
        assert_eq!(unchanged.finish()?.revision, 2);

        let reset = Prepared::prepare(
            (state.path(), state.path()),
            "tag-1",
            "claude-code",
            "attempt-4",
            &grant(1),
        )?;
        assert!(fs::read_dir(reset.working_directory())?.next().is_none());
        let summary = reset.finish()?;
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
        assert!(big.finish().is_err());
        let linked = Prepared::prepare(
            (state.path(), state.path()),
            "tag",
            "claude-code",
            "attempt-b",
            &grant(0),
        )?;
        std::os::unix::fs::symlink("/etc/passwd", linked.working_directory().join("p.md"))?;
        assert!(linked.finish().is_err());
        let after = Prepared::prepare(
            (state.path(), state.path()),
            "tag",
            "claude-code",
            "attempt-c",
            &grant(0),
        )?;
        assert!(fs::read_dir(after.working_directory())?.next().is_none());
        assert_eq!(after.finish()?.revision, 0);
        assert!(
            !state
                .path()
                .join("native-memory-attempts/attempt-a")
                .exists()
        );
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
