//! Counters that say whether a Tag's memory is used: kept by the Worker Host beside each store
//! (`stats.json`), as numbers only, never memory text.
//!
//! Each turn granted a store counts once when it starts: whether its harness had any memory to
//! load and how much of the index it loads ([`Loaded`]), and the seeds written for it. When it
//! stops, the host counts what its merge-back changed (memories written, updated, deleted), what
//! it proposed instead when it may not change the Tag's memory, what a review did with the
//! proposals it was shown, and how often the harness's activity named the memory folder: a read
//! of a memory file is the one recall signal every bridge reports the same way. Clients read the
//! counters through the memory endpoint (`supertag metrics`, `supertag describe tag`).
use std::{fs, path::Path};

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::worker::native_memory::Files;

/// The counters file beside each store.
const STATS: &str = "stats.json";

/// How much of its memory index a harness loads into each turn: Claude Code loads the first 200
/// lines or 25 KB of `MEMORY.md`, as the OpenCode and Cursor adapters do with the folder the host
/// keeps for them; Codex loads `memory_summary.md` cut to 2,500 tokens, about 10 KB.
pub const CLAUDE_INDEX_MAX_LINES: usize = 200;
pub const CLAUDE_INDEX_MAX_BYTES: usize = 25 * 1024;
pub const CODEX_SUMMARY_MAX_BYTES: usize = 10 * 1024;

/// A store's counters. Every field counts since the store's first turn on this host, across
/// resets.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Counters {
    /// Turns granted the store: those whose changes are the Tag's own, the reviews among them,
    /// and those that may only propose, such as a Work Session's own turns.
    pub turns: u64,
    pub review_turns: u64,
    pub proposing_turns: u64,
    /// Turns that started with memory to load, the index bytes and lines they loaded in all, and
    /// the turns whose index went past what the harness loads.
    pub turns_loaded: u64,
    pub loaded_bytes: u64,
    pub loaded_lines: u64,
    pub truncated_turns: u64,
    /// Activity lines naming the memory folder: reads (or searches) and edits of memory files.
    pub recalls: u64,
    pub memory_edits: u64,
    /// What ordinary turns' merge-backs changed, by memory.
    pub written: u64,
    pub updated: u64,
    pub deleted: u64,
    /// What reviews' merge-backs changed.
    pub review_written: u64,
    pub review_updated: u64,
    pub review_deleted: u64,
    /// Files a merge-back kept beside a memory both sides changed.
    pub conflicts: u64,
    /// Proposals kept; shown to a review that finished, and of those, the ones the store holds
    /// afterwards (same file or same text: merged) or not (dropped); expired unreviewed; deleted
    /// by a person.
    pub proposals_created: u64,
    pub proposals_reviewed: u64,
    pub proposals_merged: u64,
    pub proposals_dropped: u64,
    pub proposals_expired: u64,
    pub proposals_deleted: u64,
    /// Notes written into the store as the harness's own memory.
    pub seeds_delivered: u64,
    /// Memories a person deleted through the memory endpoint, and the store's resets.
    pub deleted_by_people: u64,
    pub resets: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_turn_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_review_at_ms: Option<i64>,
}

/// What a turn's harness loads of its memory index as it starts.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Loaded {
    /// The whole index.
    pub index_bytes: u64,
    pub index_lines: u64,
    /// What the harness loads of it.
    pub bytes: u64,
    pub lines: u64,
    pub truncated: bool,
    /// The most the harness loads.
    pub limit_bytes: u64,
}

/// What a turn's activity said about the memory folder.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Activity {
    pub(crate) recalls: u64,
    pub(crate) edits: u64,
}

/// What one merge-back changed, by memory.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Changes {
    pub(crate) written: u64,
    pub(crate) updated: u64,
    pub(crate) deleted: u64,
}

fn line_count(text: &str) -> u64 {
    text.lines().filter(|line| !line.trim().is_empty()).count() as u64
}

/// What `harness` loads of `files`' index into a turn.
pub(crate) fn loaded(harness: &str, files: &Files) -> Loaded {
    let codex = harness == "codex";
    let index = files
        .get(if codex {
            "memory_summary.md"
        } else {
            "MEMORY.md"
        })
        .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
        .unwrap_or_default();
    let limit = if codex {
        CODEX_SUMMARY_MAX_BYTES
    } else {
        CLAUDE_INDEX_MAX_BYTES
    };
    let first = if codex {
        index.clone()
    } else {
        index
            .lines()
            .take(CLAUDE_INDEX_MAX_LINES)
            .collect::<Vec<_>>()
            .join("\n")
    };
    let shown = cut(&first, limit);
    let shown = shown.trim_end();
    Loaded {
        index_bytes: index.len() as u64,
        index_lines: line_count(&index),
        bytes: shown.len() as u64,
        lines: line_count(shown),
        truncated: shown.len() < index.trim_end().len(),
        limit_bytes: limit as u64,
    }
}

/// `text` cut to `limit` bytes on a character boundary.
fn cut(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

/// Whether an activity line names the memory folder at one of `folders`, and if so whether it
/// edits it. Codex reads its memory in its own home (`…/memories/…`), which the host never names.
pub(crate) fn activity_on(line: &str, folders: &[String], codex: bool) -> Option<bool> {
    let names = folders
        .iter()
        .any(|folder| !folder.is_empty() && line.contains(folder.as_str()))
        || (codex && line.contains("/memories/"));
    if !names {
        return None;
    }
    let verb = line.split_whitespace().next().unwrap_or_default();
    Some(matches!(verb, "Editing" | "Edited" | "Writing" | "Wrote"))
}

/// Counts a running turn's activity lines that name its memory folder.
#[derive(Debug, Default)]
pub(crate) struct Watch {
    folders: Vec<String>,
    codex: bool,
    recalls: std::sync::atomic::AtomicU64,
    edits: std::sync::atomic::AtomicU64,
}

impl Watch {
    pub(crate) fn new(folders: Vec<String>, codex: bool) -> Self {
        Self {
            folders,
            codex,
            ..Default::default()
        }
    }

    pub(crate) fn saw(&self, line: &str) {
        use std::sync::atomic::Ordering::Relaxed;
        match activity_on(line, &self.folders, self.codex) {
            Some(true) => self.edits.fetch_add(1, Relaxed),
            Some(false) => self.recalls.fetch_add(1, Relaxed),
            None => 0,
        };
    }

    pub(crate) fn activity(&self) -> Activity {
        use std::sync::atomic::Ordering::Relaxed;
        Activity {
            recalls: self.recalls.load(Relaxed),
            edits: self.edits.load(Relaxed),
        }
    }
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

pub(crate) fn read(store: &Path) -> Counters {
    match fs::read(store.join(STATS)) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Counters::default(),
    }
}

/// Changes the store's counters. The caller holds the store's lock. Counters are a convenience:
/// a failure to keep them never fails the turn, and the caller only notes it.
pub(crate) fn update(store: &Path, change: impl FnOnce(&mut Counters)) -> Result<()> {
    let mut counters = read(store);
    change(&mut counters);
    let temporary = store.join(format!("{STATS}.tmp"));
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        let mut out = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)?;
        std::io::Write::write_all(&mut out, &serde_json::to_vec(&counters)?)?;
    }
    fs::rename(&temporary, store.join(STATS))?;
    Ok(())
}

/// [`update`], noting rather than returning a failure.
pub(crate) fn count(store: &Path, change: impl FnOnce(&mut Counters)) {
    if let Err(error) = update(store, change) {
        crate::failures::note("Memory counters were not updated", &error);
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

    #[test]
    fn a_turn_loads_the_first_lines_of_its_index_as_its_harness_does() {
        assert_eq!(
            loaded("claude-code", &Files::new()),
            Loaded {
                limit_bytes: CLAUDE_INDEX_MAX_BYTES as u64,
                ..Default::default()
            }
        );
        let short = loaded("cursor", &files(&[("MEMORY.md", "- one\n- two\n")]));
        assert_eq!((short.lines, short.bytes, short.truncated), (2, 11, false));
        let long: String = (0..250).map(|line| format!("- memory {line}\n")).collect();
        let cut = loaded("opencode", &files(&[("MEMORY.md", &long)]));
        assert_eq!(
            (cut.index_lines, cut.lines, cut.truncated),
            (250, 200, true)
        );
        let summary = format!("v1\n\n{}", "- a fact that matters\n".repeat(1000));
        let codex = loaded("codex", &files(&[("memory_summary.md", &summary)]));
        assert!(
            codex.truncated && codex.bytes <= CODEX_SUMMARY_MAX_BYTES as u64,
            "{codex:?}"
        );
        assert_eq!(codex.index_lines, 1001);
    }

    #[test]
    fn activity_on_the_memory_folder_is_a_recall_or_an_edit() {
        let folders = vec!["/state/native-memory-attempts/a/work".to_owned()];
        assert_eq!(
            activity_on(
                "Reading /state/native-memory-attempts/a/work/MEMORY.md",
                &folders,
                false
            ),
            Some(false)
        );
        assert_eq!(
            activity_on(
                "Editing /state/native-memory-attempts/a/work/x.md",
                &folders,
                false
            ),
            Some(true)
        );
        assert_eq!(
            activity_on("Reading /repo/README.md", &folders, false),
            None
        );
        assert_eq!(
            activity_on(
                "Running cat /tmp/codex-home/memories/memory_summary.md",
                &[],
                true
            ),
            Some(false)
        );
        assert_eq!(activity_on("Running cat /tmp/memories/x", &[], false), None);
    }

    #[test]
    fn counters_add_up_and_survive_a_missing_file() -> Result<()> {
        let dir = tempfile::tempdir()?;
        assert_eq!(read(dir.path()), Counters::default());
        update(dir.path(), |counters| counters.written += 2)?;
        update(dir.path(), |counters| counters.written += 1)?;
        assert_eq!(read(dir.path()).written, 3);
        Ok(())
    }
}
