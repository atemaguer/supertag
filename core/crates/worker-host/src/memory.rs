//! A Tag's harness memory as canonical records, and the local memory endpoint that serves them.
//!
//! The memory is the harness's own files, which this Worker Host keeps in one store per Tag,
//! harness, and audience ([`crate::worker::native_memory`]). Beside each store the host keeps
//! `records.json`: one record per memory, read from the files by the harness's reader with no
//! model call, and rebuilt from them whenever it is missing or older than the files. Only what
//! the files can't say is lost with it: which turn last changed each memory, and when.
//!
//! - Claude Code: each Markdown file but `MEMORY.md` is a memory; its frontmatter gives its
//!   title, description, and type. A line of `MEMORY.md` that links no file is a memory too.
//! - Codex: each ad hoc note (`extensions/ad_hoc/notes/`) is a memory, and each bullet or
//!   paragraph of `memory_summary.md`, typed by its heading. Task groups (`MEMORY.md`), rollout
//!   summaries, and skills are Codex's own working files and are not listed.
//!
//! The Worklet serves the records to clients on this machine over a Unix socket in its state
//! directory ([`SOCKET`]), private to its user, which also checks each peer's user. No network
//! listener serves it and the Control Plane never sees memory text: `supertag get memories` and
//! the desktop and terminal apps call it here. Deleting a memory removes it from the files as a
//! new revision of the store, so a turn that started before keeps it only if it changed it.
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::ErrorKind,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
};
use tokio_util::sync::CancellationToken;

use crate::worker::native_memory::{self, Files, Lock, Meta};

/// The memory endpoint's socket in a Worklet's state directory.
pub const SOCKET: &str = "memory.sock";
/// The records file beside each store.
const RECORDS: &str = "records.json";
/// The most of a memory's text a record carries; the rest stays in its file.
pub const MAX_TEXT_BYTES: usize = 2 * 1024;
/// The largest request or reply on the socket.
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const CALL_TIMEOUT: Duration = Duration::from_secs(20);
/// What starts a harness memory's ID; a note's starts `mem_`.
pub const ID_PREFIX: &str = "hmem_";

/// One store: its Tag, harness directory (`claude-code`, `codex`), and scope (`shared`, or
/// `person-` and a digest of the person's principal).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StoreKey {
    pub(crate) tag: String,
    pub(crate) harness: String,
    pub(crate) scope: String,
}

/// The turn whose changes a merge-back keeps.
#[derive(Clone, Debug)]
pub(crate) struct Writer {
    pub(crate) task_id: String,
    pub(crate) session_id: String,
    pub(crate) attempt_id: String,
    /// Whether the turn may write the Tag's trusted memory; unknown when its harness never
    /// attached.
    pub(crate) trusted: Option<bool>,
}

/// What a memory is about, from the harness's own type or heading.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// About a person: who they are, what they prefer.
    Preference,
    /// A correction or confirmation of how to work.
    Feedback,
    /// About the work, its projects and environments.
    Fact,
    /// Where something lives.
    Reference,
    /// How to do something.
    Procedure,
}

/// Whether the turn that last changed a memory may write the Tag's memory. A turn an outside
/// event started gets no store at all; a Work Session's own turn may change it today, which only
/// a proposal for the Tag to merge should.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Trust {
    Trusted,
    ProposedOnly,
}

/// Where a record comes from. Every memory listed is the Tag's own, kept by its harness.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Owned,
}

/// The turn that last changed a memory.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Provenance {
    pub task_id: String,
    pub session_id: String,
    pub attempt_id: String,
}

/// One memory, as every harness's reader gives it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    /// `hmem_` and 24 hex digits, from its Tag, harness, scope, and native ID.
    pub memory_id: String,
    pub tag_id: String,
    /// `claude-code` or `codex`.
    pub harness: String,
    /// `shared`, or `person-` and a digest of the person's principal.
    pub scope: String,
    /// Its place in the harness's files: `HARNESS:PATH`, and `#` and a digest of its text for a
    /// bullet or paragraph of a larger file.
    pub native_id: String,
    /// Its file, relative to the memory folder.
    pub path: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hook: Option<String>,
    pub kind: Kind,
    /// The memory's text, up to [`MAX_TEXT_BYTES`].
    pub text: String,
    #[serde(default)]
    pub truncated: bool,
    /// Unknown when no recorded turn changed it last.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust: Option<Trust>,
    pub status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<Provenance>,
    /// SHA-256 of its whole text.
    pub content_hash: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    /// The store's revision when this host last read it.
    pub revision: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct RecordsFile {
    revision: u64,
    generation: u64,
    records: Vec<Record>,
}

/// One memory as a reader finds it in the files.
#[derive(Debug, PartialEq, Eq)]
struct Found {
    native_id: String,
    path: String,
    title: String,
    hook: Option<String>,
    kind: Kind,
    text: String,
}

/// A bullet or paragraph of a Markdown file: its lines, `start..end`.
struct Block {
    start: usize,
    end: usize,
    heading: Option<String>,
    text: String,
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn memory_id(key: &StoreKey, native_id: &str) -> String {
    let digest = sha256(
        [
            key.tag.as_str(),
            key.harness.as_str(),
            key.scope.as_str(),
            native_id,
        ]
        .join("\0")
        .as_bytes(),
    );
    format!("{ID_PREFIX}{}", &digest[..24])
}

fn first_line(text: &str) -> String {
    let line = text
        .lines()
        .map(|line| line.trim().trim_start_matches('#').trim())
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    shorten(line.trim_start_matches(['-', '*']).trim(), 100)
}

fn shorten(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let mut short: String = text.chars().take(limit - 1).collect();
    short.push('…');
    short
}

fn stem(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.strip_suffix(".md").unwrap_or(name).to_owned()
}

/// The bullets and paragraphs of `text` with their headings. Lines `skip` accepts belong to
/// none: they end the block before them.
fn blocks(text: &str, skip: impl Fn(&str) -> bool) -> Vec<Block> {
    let lines: Vec<&str> = text.lines().collect();
    let mut found: Vec<Block> = vec![];
    let mut heading = None;
    let mut open: Option<Block> = None;
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        let bullet = !line.starts_with([' ', '\t'])
            && (trimmed.starts_with("- ") || trimmed.starts_with("* "));
        let ends = trimmed.is_empty() || trimmed.starts_with('#') || bullet || skip(line);
        if ends && let Some(block) = open.take() {
            found.push(block);
        }
        if trimmed.starts_with('#') {
            heading = Some(trimmed.trim_start_matches('#').trim().to_owned());
            continue;
        }
        if trimmed.is_empty() || skip(line) {
            continue;
        }
        match &mut open {
            Some(block) => {
                block.end = index + 1;
                block.text.push('\n');
                block.text.push_str(line);
            }
            None => {
                open = Some(Block {
                    start: index,
                    end: index + 1,
                    heading: heading.clone(),
                    text: (*line).to_owned(),
                })
            }
        }
    }
    found.extend(open);
    found
}

/// Native IDs of a file's blocks: its path and a digest of the text, numbered when one file
/// repeats a block.
fn block_ids(harness: &str, path: &str, blocks: &[Block]) -> Vec<String> {
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    blocks
        .iter()
        .map(|block| {
            let digest = sha256(block.text.trim().as_bytes())[..12].to_owned();
            let count = seen.entry(digest.clone()).or_default();
            *count += 1;
            if *count == 1 {
                format!("{harness}:{path}#{digest}")
            } else {
                format!("{harness}:{path}#{digest}-{count}")
            }
        })
        .collect()
}

/// A Markdown file's YAML frontmatter as flat `key: value` pairs, nested keys under their
/// parent's name (`metadata.type`), and the body after it.
fn frontmatter(text: &str) -> (BTreeMap<String, String>, &str) {
    let mut fields = BTreeMap::new();
    let Some(rest) = text.strip_prefix("---\n").or(text.strip_prefix("---\r\n")) else {
        return (fields, text);
    };
    let Some(end) = rest
        .match_indices("\n---")
        .map(|(index, _)| index)
        .find(|index| {
            rest[index + 4..].starts_with('\n')
                || rest[index + 4..].starts_with("\r\n")
                || rest[index + 4..].is_empty()
        })
    else {
        return (fields, text);
    };
    let mut parent: Option<String> = None;
    for line in rest[..end].lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let nested = line.starts_with([' ', '\t']);
        let key = key.trim().to_owned();
        let value = value.trim().trim_matches(['"', '\'']).to_owned();
        if !nested {
            parent = value.is_empty().then(|| key.clone());
            if !value.is_empty() {
                fields.insert(key, value);
            }
        } else if let Some(parent) = &parent
            && !value.is_empty()
        {
            fields.insert(format!("{parent}.{key}"), value);
        }
    }
    let body = rest[end + 4..].trim_start_matches(['\r', '\n']);
    (fields, body)
}

/// `MEMORY.md`'s link lines, `- [Title](file.md) — hook`: each linked path with its title and
/// hook.
fn index_links(index: &str) -> BTreeMap<String, (String, Option<String>)> {
    let mut links = BTreeMap::new();
    for line in index.lines() {
        if let Some((target, title, hook)) = index_link(line) {
            links.insert(target, (title, hook));
        }
    }
    links
}

fn index_link(line: &str) -> Option<(String, String, Option<String>)> {
    let open = line.find('[')?;
    let close = open + line[open..].find("](")?;
    let end = close + 2 + line[close + 2..].find(')')?;
    let title = line[open + 1..close].trim().to_owned();
    let target = line[close + 2..end]
        .trim()
        .trim_start_matches("./")
        .to_owned();
    if !target.ends_with(".md") {
        return None;
    }
    let hook = line[end + 1..]
        .trim()
        .trim_start_matches(['—', '–', '-', ':'])
        .trim();
    Some((target, title, (!hook.is_empty()).then(|| hook.to_owned())))
}

fn claude_kind(kind: Option<&String>) -> Kind {
    match kind.map(|kind| kind.to_ascii_lowercase()).as_deref() {
        Some("user") => Kind::Preference,
        Some("feedback") => Kind::Feedback,
        Some("reference") => Kind::Reference,
        _ => Kind::Fact,
    }
}

fn claude_code(files: &Files) -> Vec<Found> {
    let index = files
        .get("MEMORY.md")
        .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
        .unwrap_or_default();
    let links = index_links(&index);
    let mut found = vec![];
    for (path, bytes) in files {
        if path == "MEMORY.md" || !path.ends_with(".md") {
            continue;
        }
        let text = String::from_utf8_lossy(bytes);
        let (fields, body) = frontmatter(&text);
        let link = links.get(path);
        found.push(Found {
            native_id: format!("claude-code:{path}"),
            path: path.clone(),
            title: fields
                .get("name")
                .cloned()
                .or_else(|| link.map(|(title, _)| title.clone()))
                .filter(|title| !title.is_empty())
                .unwrap_or_else(|| stem(path)),
            hook: fields
                .get("description")
                .cloned()
                .or_else(|| link.and_then(|(_, hook)| hook.clone())),
            kind: claude_kind(fields.get("type").or(fields.get("metadata.type"))),
            text: body.trim().to_owned(),
        });
    }
    // A memory written straight into the index, linking no file.
    let lines = blocks(&index, |line| index_link(line).is_some());
    for (block, native_id) in lines
        .iter()
        .zip(block_ids("claude-code", "MEMORY.md", &lines))
    {
        found.push(Found {
            native_id,
            path: "MEMORY.md".into(),
            title: first_line(&block.text),
            hook: block.heading.clone(),
            kind: Kind::Fact,
            text: block.text.trim().to_owned(),
        });
    }
    found
}

const CODEX_NOTES: &str = "extensions/ad_hoc/notes/";
const CODEX_SUMMARY: &str = "memory_summary.md";

/// A summary heading's kind, or `None` for Codex's table of contents of its own folder.
fn codex_kind(heading: Option<&str>) -> Option<Kind> {
    let heading = heading.unwrap_or_default().to_ascii_lowercase();
    if heading.contains("in memory") {
        None
    } else if heading.contains("profile") || heading.contains("preference") {
        Some(Kind::Preference)
    } else if heading.contains("tip") {
        Some(Kind::Procedure)
    } else {
        Some(Kind::Fact)
    }
}

/// The summary's blocks that are memories: not its version line or table of contents.
fn summary_blocks(summary: &str) -> Vec<Block> {
    blocks(summary, |line| line.trim() == "v1")
        .into_iter()
        .filter(|block| codex_kind(block.heading.as_deref()).is_some())
        .collect()
}

fn codex(files: &Files) -> Vec<Found> {
    let mut found = vec![];
    for (path, bytes) in files {
        if !path.starts_with(CODEX_NOTES) {
            continue;
        }
        let text = String::from_utf8_lossy(bytes).trim().to_owned();
        found.push(Found {
            native_id: format!("codex:{path}"),
            path: path.clone(),
            title: Some(first_line(&text))
                .filter(|title| !title.is_empty())
                .unwrap_or_else(|| stem(path)),
            hook: None,
            kind: Kind::Fact,
            text,
        });
    }
    if let Some(summary) = files.get(CODEX_SUMMARY) {
        let summary = String::from_utf8_lossy(summary);
        let blocks = summary_blocks(&summary);
        for (block, native_id) in blocks
            .iter()
            .zip(block_ids("codex", CODEX_SUMMARY, &blocks))
        {
            found.push(Found {
                native_id,
                path: CODEX_SUMMARY.into(),
                title: first_line(&block.text),
                hook: block.heading.clone(),
                kind: codex_kind(block.heading.as_deref()).unwrap_or(Kind::Fact),
                text: block.text.trim().to_owned(),
            });
        }
    }
    found
}

/// The memories in a harness's files. Never a model call.
fn read(harness: &str, files: &Files) -> Vec<Found> {
    match harness {
        "claude-code" => claude_code(files),
        "codex" => codex(files),
        _ => vec![],
    }
}

/// `text` cut to [`MAX_TEXT_BYTES`] on a character boundary, and whether it was cut.
fn capped(text: &str) -> (String, bool) {
    if text.len() <= MAX_TEXT_BYTES {
        return (text.to_owned(), false);
    }
    let mut end = MAX_TEXT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_owned(), true)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

fn read_records(store: &Path) -> Option<RecordsFile> {
    serde_json::from_slice(&fs::read(store.join(RECORDS)).ok()?).ok()
}

/// Drops a store's records, as a reset drops its files.
pub(crate) fn forget_records(store: &Path) -> Result<()> {
    match fs::remove_file(store.join(RECORDS)) {
        Err(error) if error.kind() != ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}

/// Derives the store's records from `files`, its revision in `meta`, and writes them. A memory
/// whose text is unchanged keeps its record; one that changed takes `changed`'s writer as its
/// source when that writer changed its file, and has no known source otherwise. The caller
/// holds the store's lock.
pub(crate) fn refresh(
    store: &Path,
    key: &StoreKey,
    (files, meta): (&Files, &Meta),
    changed: Option<(&Writer, &BTreeSet<String>)>,
) -> Result<Vec<Record>> {
    let previous: BTreeMap<String, Record> = read_records(store)
        .filter(|records| records.generation == meta.generation)
        .map(|records| records.records)
        .unwrap_or_default()
        .into_iter()
        .map(|record| (record.native_id.clone(), record))
        .collect();
    let now = now_ms();
    let mut records: Vec<Record> = read(&key.harness, files)
        .into_iter()
        .map(|found| {
            let content_hash = sha256(found.text.as_bytes());
            let (text, truncated) = capped(&found.text);
            let prior = previous.get(&found.native_id);
            let (trust, provenance, created_at_ms, updated_at_ms) = match prior {
                Some(prior) if prior.content_hash == content_hash => (
                    prior.trust,
                    prior.provenance.clone(),
                    prior.created_at_ms,
                    prior.updated_at_ms,
                ),
                _ => {
                    let writer = changed
                        .filter(|(_, paths)| paths.contains(&found.path))
                        .map(|(writer, _)| writer);
                    (
                        writer.and_then(|writer| writer.trusted).map(|trusted| {
                            if trusted {
                                Trust::Trusted
                            } else {
                                Trust::ProposedOnly
                            }
                        }),
                        writer.map(|writer| Provenance {
                            task_id: writer.task_id.clone(),
                            session_id: writer.session_id.clone(),
                            attempt_id: writer.attempt_id.clone(),
                        }),
                        prior.map_or(now, |prior| prior.created_at_ms),
                        now,
                    )
                }
            };
            Record {
                memory_id: memory_id(key, &found.native_id),
                tag_id: key.tag.clone(),
                harness: key.harness.clone(),
                scope: key.scope.clone(),
                native_id: found.native_id,
                path: found.path,
                title: found.title,
                hook: found.hook,
                kind: found.kind,
                text,
                truncated,
                trust,
                status: Status::Owned,
                provenance,
                content_hash,
                created_at_ms,
                updated_at_ms,
                revision: meta.revision,
            }
        })
        .collect();
    records.sort_by(|a, b| {
        b.updated_at_ms
            .cmp(&a.updated_at_ms)
            .then_with(|| a.native_id.cmp(&b.native_id))
    });
    let file = RecordsFile {
        revision: meta.revision,
        generation: meta.generation,
        records,
    };
    let temporary = store.join(format!("{RECORDS}.tmp"));
    {
        let mut out = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)?;
        std::io::Write::write_all(&mut out, &serde_json::to_vec(&file)?)?;
    }
    fs::rename(temporary, store.join(RECORDS))?;
    Ok(file.records)
}

/// The store's records, rebuilt from its files when they are missing or older. The caller holds
/// the store's lock.
fn load(store: &Path, key: &StoreKey) -> Result<Vec<Record>> {
    let meta = native_memory::read_meta(store)?;
    if let Some(records) = read_records(store)
        && records.revision == meta.revision
        && records.generation == meta.generation
    {
        return Ok(records.records);
    }
    let files = native_memory::snapshot(&store.join("current"))?;
    refresh(store, key, (&files, &meta), None)
}

fn stores_of(storage: &Path, tag: &str) -> Result<Vec<(PathBuf, StoreKey)>> {
    let root = crate::worklet::checkpoints::tag_directory(storage, tag).join("native-memory");
    let mut stores = vec![];
    for harness in ["claude-code", "codex"] {
        let entries = match fs::read_dir(root.join(harness)) {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            let entry = entry?;
            let Ok(scope) = entry.file_name().into_string() else {
                continue;
            };
            if !entry.file_type()?.is_dir() || native_memory::component("scope", &scope).is_err() {
                continue;
            }
            stores.push((
                entry.path(),
                StoreKey {
                    tag: tag.to_owned(),
                    harness: harness.to_owned(),
                    scope,
                },
            ));
        }
    }
    Ok(stores)
}

/// Every store on this host, or `tag`'s. A store is found without its Tag only once a turn of
/// this release has recorded the Tag in it.
fn stores(storage: &Path, tag: Option<&str>) -> Result<Vec<(PathBuf, StoreKey)>> {
    if let Some(tag) = tag {
        native_memory::component("Tag ID", tag)?;
        return stores_of(storage, tag);
    }
    let entries = match fs::read_dir(storage.join("tags")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(error.into()),
    };
    let mut tags = BTreeSet::new();
    for entry in entries {
        let root = entry?.path().join("native-memory");
        for harness in ["claude-code", "codex"] {
            let Ok(scopes) = fs::read_dir(root.join(harness)) else {
                continue;
            };
            for scope in scopes.flatten() {
                if let Some(tag) = native_memory::read_meta(&scope.path())
                    .ok()
                    .and_then(|meta| meta.tag)
                {
                    tags.insert(tag);
                }
            }
        }
    }
    let mut found = vec![];
    for tag in tags {
        if native_memory::component("Tag ID", &tag).is_ok() {
            found.extend(stores_of(storage, &tag)?);
        }
    }
    Ok(found)
}

/// Whether `viewer` sees a store: an operator (no viewer) sees every store; a person, the
/// shared one and their own.
fn visible(scope: &str, viewer: Option<&str>) -> bool {
    viewer.is_none_or(|viewer| {
        scope == "shared" || scope == supertag_protocol::native_memory_scope(Some(viewer))
    })
}

/// The memories `viewer` sees, of `tag` or every Tag on this host, newest first.
pub(crate) fn list(storage: &Path, tag: Option<&str>, viewer: Option<&str>) -> Result<Vec<Record>> {
    let mut records = vec![];
    for (store, key) in stores(storage, tag)? {
        if !visible(&key.scope, viewer) {
            continue;
        }
        let _lock = Lock::take(&store)?;
        records.extend(load(&store, &key)?);
    }
    records.sort_by(|a, b| {
        b.updated_at_ms
            .cmp(&a.updated_at_ms)
            .then_with(|| a.memory_id.cmp(&b.memory_id))
    });
    Ok(records)
}

fn not_found(memory_id: &str) -> anyhow::Error {
    anyhow::anyhow!("harness memory {memory_id} was not found on this Worker Host")
}

/// Finds a memory by ID, and the store it is in.
fn find(
    storage: &Path,
    memory_id: &str,
    tag: Option<&str>,
    viewer: Option<&str>,
) -> Result<(PathBuf, StoreKey)> {
    ensure!(
        memory_id.starts_with(ID_PREFIX),
        "{memory_id} names no harness memory"
    );
    for (store, key) in stores(storage, tag)? {
        if !visible(&key.scope, viewer) {
            continue;
        }
        let _lock = Lock::take(&store)?;
        if load(&store, &key)?
            .iter()
            .any(|record| record.memory_id == memory_id)
        {
            return Ok((store, key));
        }
    }
    Err(not_found(memory_id))
}

pub(crate) fn get(
    storage: &Path,
    memory_id: &str,
    tag: Option<&str>,
    viewer: Option<&str>,
) -> Result<Record> {
    let (store, key) = find(storage, memory_id, tag, viewer)?;
    let _lock = Lock::take(&store)?;
    load(&store, &key)?
        .into_iter()
        .find(|record| record.memory_id == memory_id)
        .ok_or_else(|| not_found(memory_id))
}

/// `files` without the memory `record`: its file, and the index lines that link it, or its
/// lines of a larger file.
fn without(files: &Files, record: &Record) -> Result<Files> {
    let mut files = files.clone();
    let whole_file = !record.native_id.contains('#');
    if whole_file {
        ensure!(
            files.remove(&record.path).is_some(),
            "{} is no longer in the memory folder",
            record.path
        );
        if record.harness == "claude-code"
            && let Some(index) = files.get("MEMORY.md")
        {
            let index = String::from_utf8_lossy(index).into_owned();
            let kept: Vec<&str> = index
                .lines()
                .filter(|line| index_link(line).is_none_or(|(target, _, _)| target != record.path))
                .collect();
            let mut rewritten = kept.join("\n");
            rewritten.push('\n');
            files.insert("MEMORY.md".into(), rewritten.into_bytes());
        }
        return Ok(files);
    }
    let text = String::from_utf8_lossy(
        files
            .get(&record.path)
            .with_context(|| format!("{} is no longer in the memory folder", record.path))?,
    )
    .into_owned();
    let found = match record.harness.as_str() {
        "codex" => summary_blocks(&text),
        _ => blocks(&text, |line| index_link(line).is_some()),
    };
    let ids = block_ids(&record.harness, &record.path, &found);
    let Some(block) = found
        .iter()
        .zip(ids)
        .find_map(|(block, id)| (id == record.native_id).then_some(block))
    else {
        bail!("that memory is no longer in {}", record.path);
    };
    let lines: Vec<&str> = text.lines().collect();
    let mut kept: Vec<&str> = lines[..block.start].to_vec();
    kept.extend(&lines[block.end..]);
    let mut rewritten = kept.join("\n");
    rewritten.push('\n');
    files.insert(record.path.clone(), rewritten.into_bytes());
    Ok(files)
}

/// Removes a memory from its harness's files as the store's next revision. With `dry_run`, only
/// finds it.
pub(crate) fn delete(
    storage: &Path,
    memory_id: &str,
    (tag, viewer): (Option<&str>, Option<&str>),
    dry_run: bool,
) -> Result<Record> {
    let (store, key) = find(storage, memory_id, tag, viewer)?;
    let _lock = Lock::take(&store)?;
    let record = load(&store, &key)?
        .into_iter()
        .find(|record| record.memory_id == memory_id)
        .ok_or_else(|| not_found(memory_id))?;
    if dry_run {
        return Ok(record);
    }
    let mut meta = native_memory::read_meta(&store)?;
    let files = native_memory::snapshot(&store.join("current"))?;
    let kept = without(&files, &record)?;
    native_memory::replace_current(&store, &mut meta, &kept, "delete")?;
    refresh(&store, &key, (&kept, &meta), None)?;
    Ok(record)
}

/// Drops `tag`'s stores on this host now, as each would before its next turn after the Control
/// Plane's reset to `generation`. Returns how many it dropped.
pub(crate) fn reset(storage: &Path, tag: &str, generation: u64) -> Result<u32> {
    let mut dropped = 0;
    for (store, _) in stores(storage, Some(tag))? {
        let _lock = Lock::take(&store)?;
        let meta = native_memory::read_meta(&store)?;
        if meta.generation >= generation {
            continue;
        }
        native_memory::remove(&store.join("current"))?;
        forget_records(&store)?;
        native_memory::write_meta(
            &store,
            &Meta {
                revision: 0,
                generation,
                tag: Some(tag.to_owned()),
            },
        )?;
        dropped += 1;
    }
    Ok(dropped)
}

/// A call to the memory endpoint. `viewer` is a person's principal: they see the shared store
/// and their own. Without one, as for the operator, every store.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    List {
        #[serde(default)]
        tag_id: Option<String>,
        #[serde(default)]
        viewer: Option<String>,
    },
    Get {
        memory_id: String,
        #[serde(default)]
        tag_id: Option<String>,
        #[serde(default)]
        viewer: Option<String>,
    },
    Delete {
        memory_id: String,
        #[serde(default)]
        tag_id: Option<String>,
        #[serde(default)]
        viewer: Option<String>,
        #[serde(default)]
        dry_run: bool,
    },
    /// Drops a Tag's stores after the Control Plane reset its native memory to `generation`.
    Reset { tag_id: String, generation: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "reply", rename_all = "snake_case")]
pub enum Reply {
    Memories { memories: Vec<Record> },
    Memory { memory: Box<Record> },
    Reset { stores: u32 },
    Error { message: String },
}

fn answer(storage: &Path, request: Request) -> Reply {
    let result = match request {
        Request::List { tag_id, viewer } => list(storage, tag_id.as_deref(), viewer.as_deref())
            .map(|memories| Reply::Memories { memories }),
        Request::Get {
            memory_id,
            tag_id,
            viewer,
        } => get(storage, &memory_id, tag_id.as_deref(), viewer.as_deref()).map(|memory| {
            Reply::Memory {
                memory: Box::new(memory),
            }
        }),
        Request::Delete {
            memory_id,
            tag_id,
            viewer,
            dry_run,
        } => delete(
            storage,
            &memory_id,
            (tag_id.as_deref(), viewer.as_deref()),
            dry_run,
        )
        .map(|memory| Reply::Memory {
            memory: Box::new(memory),
        }),
        Request::Reset { tag_id, generation } => {
            reset(storage, &tag_id, generation).map(|stores| Reply::Reset { stores })
        }
    };
    result.unwrap_or_else(|error| Reply::Error {
        message: format!("{error:#}"),
    })
}

async fn read_frame(stream: &mut UnixStream) -> Result<Vec<u8>> {
    let length = stream.read_u32().await? as usize;
    ensure!(
        length <= MAX_FRAME_BYTES,
        "memory endpoint message too large"
    );
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes).await?;
    Ok(bytes)
}

async fn write_frame(stream: &mut UnixStream, bytes: &[u8]) -> Result<()> {
    ensure!(
        bytes.len() <= MAX_FRAME_BYTES,
        "memory endpoint message too large"
    );
    stream.write_u32(bytes.len() as u32).await?;
    stream.write_all(bytes).await?;
    stream.flush().await?;
    Ok(())
}

async fn serve_one(mut stream: UnixStream, storage: PathBuf) -> Result<()> {
    // The socket is private to this user already; a peer of another user is refused anyway.
    let peer = stream.peer_cred()?;
    // SAFETY: geteuid has no preconditions.
    ensure!(
        peer.uid() == unsafe { libc::geteuid() },
        "memory endpoint peer is another user"
    );
    let request: Request = serde_json::from_slice(&read_frame(&mut stream).await?)?;
    let reply = tokio::task::spawn_blocking(move || answer(&storage, request)).await?;
    write_frame(&mut stream, &serde_json::to_vec(&reply)?).await
}

/// Serves the memory endpoint at `state/SOCKET` over the stores in `storage` until `shutdown`,
/// then removes the socket.
pub(crate) fn spawn(
    state: &Path,
    storage: PathBuf,
    shutdown: CancellationToken,
) -> Result<tokio::task::JoinHandle<()>> {
    let socket = state.join(SOCKET);
    match fs::symlink_metadata(&socket) {
        Ok(metadata) => {
            use std::os::unix::fs::FileTypeExt as _;
            ensure!(
                metadata.file_type().is_socket(),
                "{} is not a socket",
                socket.display()
            );
            fs::remove_file(&socket)?;
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let listener = UnixListener::bind(&socket)
        .with_context(|| format!("listen for memory clients at {}", socket.display()))?;
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
    Ok(tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => break,
                accepted = listener.accept() => match accepted {
                    Ok((stream, _)) => {
                        let storage = storage.clone();
                        tokio::spawn(async move {
                            if let Err(error) = serve_one(stream, storage).await {
                                crate::failures::note_unrecorded("A memory endpoint call failed", &error);
                            }
                        });
                    }
                    Err(error) => {
                        crate::failures::note_unrecorded("The memory endpoint stopped accepting", &error);
                        break;
                    }
                },
            }
        }
        let _ = fs::remove_file(&socket);
    }))
}

/// Calls the memory endpoint at `socket`. An error reply is an error.
pub async fn call(socket: &Path, request: &Request) -> Result<Reply> {
    let exchange = async {
        let mut stream = UnixStream::connect(socket)
            .await
            .with_context(|| format!("connect to {}", socket.display()))?;
        write_frame(&mut stream, &serde_json::to_vec(request)?).await?;
        let reply: Reply = serde_json::from_slice(&read_frame(&mut stream).await?)?;
        Ok::<_, anyhow::Error>(reply)
    };
    match tokio::time::timeout(CALL_TIMEOUT, exchange).await {
        Err(_) => bail!("the memory endpoint at {} did not answer", socket.display()),
        Ok(Err(error)) => Err(error),
        Ok(Ok(Reply::Error { message })) => bail!("{message}"),
        Ok(Ok(reply)) => Ok(reply),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use supertag_protocol::v2::NativeMemoryGrant;

    fn files(entries: &[(&str, &str)]) -> Files {
        entries
            .iter()
            .map(|(path, contents)| ((*path).to_owned(), contents.as_bytes().to_vec()))
            .collect()
    }

    const CLAUDE_INDEX: &str = "- [Squash merges](feedback_squash.md) — how to merge\n- [Deploys](reference_deploys.md) — where deploys run\n- The staging database is read-only on Fridays.\n";
    const SQUASH: &str = "---\nname: Prefer squash merges\ndescription: merge pull requests by squashing\nmetadata:\n  type: feedback\n---\n\nPrefer squash merges.\n**Why:** linear history for bisect.\n";
    const DEPLOYS: &str =
        "---\nname: Deploys\ntype: reference\n---\nDeploys run from the ops repository.\n";
    const SUMMARY: &str = "v1\n\n## User Profile\n\n- Ada leads the payments team.\n\n## User preferences\n\n- Prefers small pull requests.\n- Runs pnpm check before handover,\n  every time.\n\n## General Tips\n\nUse eu-north-1 for staging.\n\n## What's in Memory\n\n- rollout summaries for payments\n";

    fn grant() -> NativeMemoryGrant {
        NativeMemoryGrant {
            scope: "shared".into(),
            reset_generation: 0,
            volume_head: None,
        }
    }

    #[test]
    fn claude_code_files_and_index_lines_are_records() {
        let found = claude_code(&files(&[
            ("MEMORY.md", CLAUDE_INDEX),
            ("feedback_squash.md", SQUASH),
            ("reference_deploys.md", DEPLOYS),
        ]));
        assert_eq!(found.len(), 3, "{found:#?}");
        let squash = found
            .iter()
            .find(|found| found.path == "feedback_squash.md")
            .unwrap();
        assert_eq!(squash.native_id, "claude-code:feedback_squash.md");
        assert_eq!(squash.title, "Prefer squash merges");
        assert_eq!(
            squash.hook.as_deref(),
            Some("merge pull requests by squashing")
        );
        assert_eq!(squash.kind, Kind::Feedback);
        assert_eq!(
            squash.text,
            "Prefer squash merges.\n**Why:** linear history for bisect."
        );
        let deploys = found
            .iter()
            .find(|found| found.path == "reference_deploys.md")
            .unwrap();
        assert_eq!(
            (deploys.kind, deploys.hook.as_deref()),
            (Kind::Reference, Some("where deploys run"))
        );
        let inline = found
            .iter()
            .find(|found| found.path == "MEMORY.md")
            .unwrap();
        assert!(inline.native_id.starts_with("claude-code:MEMORY.md#"));
        assert_eq!(
            inline.text,
            "- The staging database is read-only on Fridays."
        );
        assert_eq!(
            inline.title,
            "The staging database is read-only on Fridays."
        );
    }

    #[test]
    fn codex_notes_and_summary_bullets_are_records_but_not_its_own_working_files() {
        let found = codex(&files(&[
            ("memory_summary.md", SUMMARY),
            (
                "MEMORY.md",
                "# Task Group: payments\n## Task 1\nkeywords: x\n",
            ),
            ("rollout_summaries/a.md", "a rollout"),
            ("skills/deploy/SKILL.md", "a skill"),
            (
                "extensions/ad_hoc/notes/2026-11-19-region.md",
                "# Staging region\n\nStaging runs in eu-north-1.",
            ),
        ]));
        let summary: Vec<_> = found
            .iter()
            .filter(|found| found.path == CODEX_SUMMARY)
            .map(|found| (found.kind, found.text.as_str()))
            .collect();
        assert_eq!(
            summary,
            [
                (Kind::Preference, "- Ada leads the payments team."),
                (Kind::Preference, "- Prefers small pull requests."),
                (
                    Kind::Preference,
                    "- Runs pnpm check before handover,\n  every time."
                ),
                (Kind::Procedure, "Use eu-north-1 for staging."),
            ]
        );
        let note = found
            .iter()
            .find(|found| found.path.starts_with(CODEX_NOTES))
            .unwrap();
        assert_eq!(
            (note.title.as_str(), note.kind),
            ("Staging region", Kind::Fact)
        );
        assert_eq!(found.len(), 5, "{found:#?}");
    }

    #[test]
    fn long_text_is_capped_on_a_character_boundary() {
        let (text, truncated) = capped(&"é".repeat(MAX_TEXT_BYTES));
        assert!(truncated && text.len() <= MAX_TEXT_BYTES && text.len() > MAX_TEXT_BYTES - 2);
        assert_eq!(capped("short"), ("short".into(), false));
    }

    fn store(storage: &Path, harness: &str, scope: &str, tag: &str, contents: &Files) -> PathBuf {
        let store = crate::worklet::checkpoints::tag_directory(storage, tag)
            .join("native-memory")
            .join(harness)
            .join(scope);
        native_memory::private_directory(&store).unwrap();
        native_memory::write_tree(&store.join("current"), contents).unwrap();
        native_memory::write_meta(
            &store,
            &Meta {
                revision: 1,
                generation: 0,
                tag: Some(tag.into()),
            },
        )
        .unwrap();
        store
    }

    #[test]
    fn a_merge_back_records_its_turn_and_a_rebuild_keeps_what_the_files_say() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let turn = native_memory::Prepared::prepare(
            (dir.path(), dir.path()),
            "tag-1",
            "claude-code",
            "attempt-1",
            &grant(),
        )?;
        fs::write(turn.working_directory().join("MEMORY.md"), CLAUDE_INDEX)?;
        fs::write(turn.working_directory().join("feedback_squash.md"), SQUASH)?;
        turn.finish(Some(Writer {
            task_id: "task-1".into(),
            session_id: "work/abc".into(),
            attempt_id: "attempt-1".into(),
            trusted: Some(false),
        }))?;
        let records = list(dir.path(), Some("tag-1"), None)?;
        assert_eq!(records.len(), 2);
        let squash = records
            .iter()
            .find(|record| record.path == "feedback_squash.md")
            .unwrap();
        assert_eq!(squash.trust, Some(Trust::ProposedOnly));
        assert_eq!(squash.provenance.as_ref().unwrap().task_id, "task-1");
        assert_eq!(squash.status, Status::Owned);
        assert_eq!(squash.scope, "shared");
        assert_eq!(squash.revision, 1);
        assert_eq!(
            squash.memory_id,
            memory_id(
                &StoreKey {
                    tag: "tag-1".into(),
                    harness: "claude-code".into(),
                    scope: "shared".into()
                },
                "claude-code:feedback_squash.md"
            )
        );
        // Without the records file the same records come back from the files, without the
        // turn that is their source.
        let store = crate::worklet::checkpoints::tag_directory(dir.path(), "tag-1")
            .join("native-memory/claude-code/shared");
        fs::remove_file(store.join(RECORDS))?;
        let rebuilt = list(dir.path(), None, None)?;
        assert_eq!(rebuilt.len(), 2);
        assert!(
            rebuilt
                .iter()
                .all(|record| record.provenance.is_none() && record.trust.is_none())
        );
        assert_eq!(
            rebuilt
                .iter()
                .map(|record| &record.memory_id)
                .collect::<BTreeSet<_>>(),
            records
                .iter()
                .map(|record| &record.memory_id)
                .collect::<BTreeSet<_>>()
        );
        Ok(())
    }

    #[test]
    fn a_person_sees_the_shared_store_and_their_own_only() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let alice = supertag_protocol::native_memory_scope(Some("client:alice"));
        let bob = supertag_protocol::native_memory_scope(Some("client:bob"));
        let note = |text: &str| files(&[("extensions/ad_hoc/notes/n.md", text)]);
        store(dir.path(), "codex", "shared", "tag", &note("shared"));
        store(dir.path(), "codex", &alice, "tag", &note("alice"));
        store(dir.path(), "codex", &bob, "tag", &note("bob"));
        let texts = |viewer| -> Result<BTreeSet<String>> {
            Ok(list(dir.path(), Some("tag"), viewer)?
                .into_iter()
                .map(|record| record.text)
                .collect())
        };
        assert_eq!(texts(None)?.len(), 3);
        assert_eq!(
            texts(Some("client:alice"))?,
            ["alice".to_owned(), "shared".to_owned()].into()
        );
        let bobs = list(dir.path(), Some("tag"), None)?
            .into_iter()
            .find(|record| record.text == "bob")
            .unwrap();
        assert!(get(dir.path(), &bobs.memory_id, None, Some("client:alice")).is_err());
        assert!(
            delete(
                dir.path(),
                &bobs.memory_id,
                (None, Some("client:alice")),
                false
            )
            .is_err()
        );
        assert_eq!(get(dir.path(), &bobs.memory_id, None, None)?.text, "bob");
        Ok(())
    }

    #[test]
    fn deleting_removes_a_file_and_its_index_line_or_one_bullet() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let claude = store(
            dir.path(),
            "claude-code",
            "shared",
            "tag",
            &files(&[
                ("MEMORY.md", CLAUDE_INDEX),
                ("feedback_squash.md", SQUASH),
                ("reference_deploys.md", DEPLOYS),
            ]),
        );
        let codex = store(
            dir.path(),
            "codex",
            "shared",
            "tag",
            &files(&[("memory_summary.md", SUMMARY)]),
        );
        let records = list(dir.path(), Some("tag"), None)?;
        let squash = records
            .iter()
            .find(|record| record.path == "feedback_squash.md")
            .unwrap();
        assert_eq!(
            delete(dir.path(), &squash.memory_id, (None, None), true)?.memory_id,
            squash.memory_id
        );
        assert!(claude.join("current/feedback_squash.md").exists());
        delete(dir.path(), &squash.memory_id, (Some("tag"), None), false)?;
        assert!(!claude.join("current/feedback_squash.md").exists());
        let index = fs::read_to_string(claude.join("current/MEMORY.md"))?;
        assert!(!index.contains("feedback_squash.md") && index.contains("reference_deploys.md"));
        assert_eq!(native_memory::read_meta(&claude)?.revision, 2);

        let small = records
            .iter()
            .find(|record| record.text == "- Prefers small pull requests.")
            .unwrap();
        delete(dir.path(), &small.memory_id, (None, None), false)?;
        let summary = fs::read_to_string(codex.join("current/memory_summary.md"))?;
        assert!(!summary.contains("small pull requests"));
        assert!(summary.contains("every time.") && summary.contains("Ada leads"));
        let after = list(dir.path(), Some("tag"), None)?;
        assert_eq!(after.len(), records.len() - 2);
        assert!(get(dir.path(), &small.memory_id, None, None).is_err());
        // The other memories keep their IDs.
        assert!(
            after
                .iter()
                .all(|record| records.iter().any(|r| r.memory_id == record.memory_id))
        );
        Ok(())
    }

    #[test]
    fn a_deleted_memory_stays_deleted_after_an_older_turn_merges_back() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let first = native_memory::Prepared::prepare(
            (dir.path(), dir.path()),
            "tag",
            "claude-code",
            "attempt-1",
            &grant(),
        )?;
        fs::write(first.working_directory().join("MEMORY.md"), CLAUDE_INDEX)?;
        fs::write(first.working_directory().join("feedback_squash.md"), SQUASH)?;
        first.finish(None)?;
        let running = native_memory::Prepared::prepare(
            (dir.path(), dir.path()),
            "tag",
            "claude-code",
            "attempt-2",
            &grant(),
        )?;
        let squash = list(dir.path(), Some("tag"), None)?
            .into_iter()
            .find(|record| record.path == "feedback_squash.md")
            .unwrap();
        delete(dir.path(), &squash.memory_id, (None, None), false)?;
        fs::write(running.working_directory().join("new.md"), "A new memory.")?;
        running.finish(None)?;
        let paths: BTreeSet<String> = list(dir.path(), Some("tag"), None)?
            .into_iter()
            .map(|record| record.path)
            .collect();
        assert!(paths.contains("new.md") && !paths.contains("feedback_squash.md"));
        Ok(())
    }

    #[test]
    fn a_reset_drops_the_tags_stores_at_once() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let store = store(
            dir.path(),
            "codex",
            "shared",
            "tag",
            &files(&[("extensions/ad_hoc/notes/n.md", "x")]),
        );
        assert_eq!(list(dir.path(), Some("tag"), None)?.len(), 1);
        assert_eq!(reset(dir.path(), "tag", 1)?, 1);
        assert!(list(dir.path(), Some("tag"), None)?.is_empty());
        assert!(!store.join("current").exists());
        // Already at that generation: nothing more to drop.
        assert_eq!(reset(dir.path(), "tag", 1)?, 0);
        Ok(())
    }

    #[tokio::test]
    async fn the_endpoint_serves_this_users_clients_over_its_socket() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let storage = dir.path().join("artifacts");
        store(
            &storage,
            "codex",
            "shared",
            "tag",
            &files(&[("extensions/ad_hoc/notes/n.md", "Staging is eu-north-1.")]),
        );
        let shutdown = CancellationToken::new();
        let served = spawn(dir.path(), storage, shutdown.clone())?;
        let socket = dir.path().join(SOCKET);
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(fs::metadata(&socket)?.permissions().mode() & 0o777, 0o600);
        let Reply::Memories { memories } = call(
            &socket,
            &Request::List {
                tag_id: Some("tag".into()),
                viewer: None,
            },
        )
        .await?
        else {
            panic!("not a list");
        };
        assert_eq!(memories.len(), 1);
        let id = memories[0].memory_id.clone();
        let error = call(
            &socket,
            &Request::Get {
                memory_id: "hmem_000000000000000000000000".into(),
                tag_id: None,
                viewer: None,
            },
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("was not found"), "{error}");
        let Reply::Memory { memory } = call(
            &socket,
            &Request::Delete {
                memory_id: id.clone(),
                tag_id: None,
                viewer: None,
                dry_run: false,
            },
        )
        .await?
        else {
            panic!("not a memory");
        };
        assert_eq!(memory.memory_id, id);
        shutdown.cancel();
        served.await?;
        assert!(!socket.exists());
        Ok(())
    }
}
