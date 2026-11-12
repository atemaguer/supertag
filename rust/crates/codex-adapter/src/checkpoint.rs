//! Portable native transcripts, never a copy of CODEX_HOME or its credentials.
//!
//! Compatibility is bound to the Tag, Session, and adapter format. A Task's
//! checkout location may change; only native cwd metadata is rebased, while
//! conversation/tool text remains literal. This does not restore workspace files.
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::CString,
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        },
    },
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use supertag_protocol::{
    v2::{SessionCheckpoint, Task},
    validate_checkpoint_reference,
};

const FORMAT: &str = "codex-session-v1";
const MAX_FILES: usize = 16;
const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;
const MAX_RAW_BYTES: usize = 12 * 1024 * 1024;
const MAX_ENCODED_BYTES: usize = 15 * 1024 * 1024;

/// A resumed thread reports lifetime totals. Only subtract a persisted native
/// counter, never the first new response of the current Attempt.
pub(crate) fn usage_baseline(checkpoint: &SessionCheckpoint) -> Result<Option<[u64; 3]>> {
    let archive: Archive =
        serde_json::from_slice(&checkpoint.payload).context("invalid Codex checkpoint usage")?;
    let mut found = None;
    for transcript in archive.transcripts {
        if metadata(&transcript.text)?.0 != archive.thread_id {
            continue;
        }
        for record in records(&transcript.text)? {
            if record.get("type").and_then(Value::as_str) != Some("event_msg")
                || record.pointer("/payload/type").and_then(Value::as_str) != Some("token_count")
            {
                continue;
            }
            let Some(total) = record.pointer("/payload/info/total_token_usage") else {
                continue;
            };
            let read = |name| {
                total
                    .get(name)
                    .and_then(Value::as_u64)
                    .context("invalid Codex checkpoint usage")
            };
            let value = [
                read("input_tokens")?,
                read("cached_input_tokens")?,
                read("output_tokens")?,
            ];
            ensure!(value[1] <= value[0], "invalid Codex checkpoint usage");
            found = Some(value);
        }
    }
    Ok(found)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Archive {
    version: u32,
    tag_id: String,
    session_id: String,
    thread_id: String,
    workspace: String,
    transcripts: Vec<Transcript>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Transcript {
    path: String,
    text: String,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn identity(value: &str) -> bool {
    !value.is_empty() && value.len() <= 200 && !value.chars().any(char::is_control)
}

pub(crate) fn thread_identity(value: &str) -> bool {
    identity(value)
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn valid_path(path: &str) -> bool {
    if path.len() > 300 || !path.ends_with(".jsonl") {
        return false;
    }
    let components: Vec<_> = path.split('/').collect();
    components.len() <= 6
        && components.iter().enumerate().all(|(index, component)| {
            !component.is_empty()
                && *component != "."
                && *component != ".."
                && component.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric()
                        || matches!(byte, b'_' | b'-')
                        || (index + 1 == components.len() && byte == b'.')
                })
        })
}

fn records(text: &str) -> Result<Vec<Value>> {
    ensure!(
        !text.is_empty() && text.len() <= MAX_FILE_BYTES,
        "invalid Codex transcript size"
    );
    let mut records = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let value: Value = serde_json::from_str(line).context("invalid Codex transcript JSON")?;
        ensure!(value.is_object(), "invalid Codex transcript record");
        records.push(value);
        ensure!(
            records.len() <= 100_000,
            "too many Codex transcript records"
        );
    }
    ensure!(!records.is_empty(), "empty Codex transcript");
    Ok(records)
}

fn metadata(text: &str) -> Result<(String, Option<String>)> {
    let records = records(text)?;
    let first = &records[0];
    ensure!(
        first.get("type").and_then(Value::as_str) == Some("session_meta"),
        "Codex transcript has no Session metadata"
    );
    let id = first
        .pointer("/payload/id")
        .and_then(Value::as_str)
        .filter(|id| thread_identity(id))
        .context("invalid Codex transcript identity")?;
    let parent = first
        .pointer("/payload/source/subagent/thread_spawn/parent_thread_id")
        .map(|parent| {
            parent
                .as_str()
                .filter(|parent| thread_identity(parent))
                .context("invalid Codex transcript parent")
        })
        .transpose()?;
    Ok((id.into(), parent.map(str::to_owned)))
}

fn lineage(archive: &Archive, require_all: bool) -> Result<BTreeSet<String>> {
    ensure!(
        thread_identity(&archive.thread_id),
        "invalid Codex checkpoint thread"
    );
    ensure!(
        !archive.transcripts.is_empty() && archive.transcripts.len() <= MAX_FILES,
        "invalid Codex checkpoint file count"
    );
    let mut paths = BTreeSet::new();
    let mut parents = BTreeMap::new();
    let mut total = 0usize;
    for transcript in &archive.transcripts {
        ensure!(
            valid_path(&transcript.path) && paths.insert(&transcript.path),
            "invalid or duplicate Codex transcript path"
        );
        total += transcript.text.len();
        ensure!(
            total <= MAX_RAW_BYTES,
            "Codex checkpoint exceeds its transcript limit"
        );
        let (id, parent) = metadata(&transcript.text)?;
        ensure!(
            parents.insert(id, parent).is_none(),
            "duplicate Codex transcript identity"
        );
    }
    ensure!(
        parents.contains_key(&archive.thread_id),
        "Codex Session transcript is missing"
    );
    let mut selected = BTreeSet::from([archive.thread_id.clone()]);
    loop {
        let before = selected.len();
        for (id, parent) in &parents {
            if parent
                .as_ref()
                .is_some_and(|parent| selected.contains(parent))
            {
                selected.insert(id.clone());
            }
        }
        if selected.len() == before {
            break;
        }
    }
    ensure!(
        !require_all || selected.len() == parents.len(),
        "unrelated Codex transcript in checkpoint"
    );
    Ok(selected)
}

fn redact_value(value: &mut Value, secrets: &[String]) {
    match value {
        Value::String(text) => *text = crate::auth::redact(std::mem::take(text), secrets),
        Value::Array(values) => values
            .iter_mut()
            .for_each(|value| redact_value(value, secrets)),
        Value::Object(values) => {
            let old = std::mem::take(values);
            for (key, mut value) in old {
                redact_value(&mut value, secrets);
                values.insert(crate::auth::redact(key, secrets), value);
            }
        }
        _ => {}
    }
}

fn transform(
    text: &str,
    old_cwd: Option<&str>,
    new_cwd: &str,
    secrets: &[String],
) -> Result<String> {
    let mut output = String::new();
    for mut record in records(text)? {
        if matches!(
            record.get("type").and_then(Value::as_str),
            Some("session_meta" | "turn_context")
        ) && old_cwd.is_some()
            && record.pointer("/payload/cwd").and_then(Value::as_str) == old_cwd
        {
            record["payload"]["cwd"] = Value::String(new_cwd.into());
        }
        // Parse first, then redact string values: JSON-escaped credentials must
        // not survive an exact byte replacement in the serialized envelope.
        redact_value(&mut record, secrets);
        output.push_str(&serde_json::to_string(&record)?);
        output.push('\n');
    }
    ensure!(
        output.len() <= MAX_FILE_BYTES,
        "Codex transcript exceeds its limit"
    );
    Ok(output)
}

pub(crate) fn restore(
    checkpoint: &SessionCheckpoint,
    task: &Task,
    home: &Path,
    workspace: &Path,
    secrets: &[String],
) -> Result<String> {
    validate_checkpoint_reference(&checkpoint.reference())
        .context("invalid Codex checkpoint envelope")?;
    ensure!(
        checkpoint.harness == "codex" && checkpoint.format == FORMAT,
        "incompatible Codex Session checkpoint"
    );
    ensure!(
        checkpoint.payload.len() <= MAX_ENCODED_BYTES
            && digest(&checkpoint.payload) == checkpoint.sha256,
        "Codex checkpoint integrity check failed"
    );
    let archive: Archive =
        serde_json::from_slice(&checkpoint.payload).context("invalid Codex checkpoint archive")?;
    ensure!(
        archive.version == 1
            && archive.tag_id == task.tag_id
            && archive.session_id == task.session_id
            && identity(&archive.tag_id)
            && identity(&archive.session_id),
        "Codex checkpoint belongs to a different Tag or Session"
    );
    ensure!(
        Path::new(&archive.workspace).is_absolute() && archive.workspace.len() <= 4096,
        "invalid Codex checkpoint workspace"
    );
    lineage(&archive, true)?;
    let cwd = workspace
        .to_str()
        .context("Codex workspace must be UTF-8")?;
    let root = home.join("sessions");
    // The destination is a newly-created private Codex home, before native launch.
    std::fs::create_dir(&root).context("could not restore Codex Session directory")?;
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;
    for transcript in &archive.transcripts {
        let text = transform(&transcript.text, Some(&archive.workspace), cwd, secrets)?;
        ensure!(
            metadata(&text)? == metadata(&transcript.text)?,
            "redaction changed Codex Session identity"
        );
        let path = root.join(&transcript.path);
        std::fs::create_dir_all(path.parent().context("invalid Codex transcript path")?)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .context("could not restore Codex transcript")?;
        file.write_all(text.as_bytes())
            .context("could not restore Codex transcript")?;
    }
    Ok(archive.thread_id)
}

// Open each component relative to an already-open directory. Native tools cannot
// race a symlink replacement to make the archive read a file outside sessions.
fn open_child(directory: &File, name: &std::ffi::OsStr, is_directory: bool) -> Result<File> {
    let name = CString::new(name.as_bytes()).context("invalid Codex transcript filename")?;
    let flags = libc::O_RDONLY
        | libc::O_NOFOLLOW
        | libc::O_NONBLOCK
        | libc::O_CLOEXEC
        | if is_directory { libc::O_DIRECTORY } else { 0 };
    let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
    ensure!(fd >= 0, "could not safely open Codex transcript entry");
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn scan(
    directory: &File,
    path: &Path,
    relative: &Path,
    entries: &mut usize,
    total: &mut usize,
    transcripts: &mut Vec<Transcript>,
) -> Result<()> {
    ensure!(
        relative.components().count() <= 5,
        "Codex transcript nesting exceeds its limit"
    );
    for entry in std::fs::read_dir(path).context("could not enumerate Codex transcripts")? {
        let entry = entry.context("could not enumerate Codex transcript")?;
        *entries += 1;
        ensure!(*entries <= 1024, "too many Codex transcript entries");
        let kind = entry
            .file_type()
            .context("could not inspect Codex transcript")?;
        let name = entry.file_name();
        let child = open_child(directory, &name, kind.is_dir())?;
        let metadata = child
            .metadata()
            .context("could not inspect Codex transcript")?;
        let relative = relative.join(&name);
        if metadata.is_dir() {
            scan(
                &child,
                &path.join(name),
                &relative,
                entries,
                total,
                transcripts,
            )?;
            continue;
        }
        ensure!(
            metadata.is_file() && metadata.nlink() == 1,
            "Codex transcript must be a regular unlinked file"
        );
        let relative = relative
            .to_str()
            .context("invalid Codex transcript filename")?;
        ensure!(valid_path(relative), "invalid Codex transcript path");
        ensure!(
            metadata.len() <= MAX_FILE_BYTES as u64 && transcripts.len() < MAX_FILES,
            "Codex transcript exceeds its limit"
        );
        let mut text = String::new();
        child
            .take(MAX_FILE_BYTES as u64 + 1)
            .read_to_string(&mut text)
            .context("could not read Codex transcript")?;
        *total += text.len();
        ensure!(
            text.len() <= MAX_FILE_BYTES && *total <= MAX_RAW_BYTES,
            "Codex checkpoint exceeds its transcript limit"
        );
        transcripts.push(Transcript {
            path: relative.into(),
            text,
        });
    }
    Ok(())
}

pub(crate) fn capture(
    task: &Task,
    home: &Path,
    workspace: &Path,
    thread_id: String,
    secrets: &[String],
) -> Result<SessionCheckpoint> {
    ensure!(
        identity(&task.tag_id) && identity(&task.session_id),
        "invalid Codex Tag or Session identity"
    );
    let path = home.join("sessions");
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&path)
        .context("Codex Session transcript is missing")?;
    let workspace = workspace
        .to_str()
        .context("Codex workspace must be UTF-8")?
        .to_owned();
    let mut archive = Archive {
        version: 1,
        tag_id: task.tag_id.clone(),
        session_id: task.session_id.clone(),
        thread_id,
        workspace,
        transcripts: Vec::new(),
    };
    scan(
        &directory,
        &path,
        &PathBuf::new(),
        &mut 0,
        &mut 0,
        &mut archive.transcripts,
    )?;
    let selected = lineage(&archive, false)?;
    archive.transcripts.retain(|transcript| {
        metadata(&transcript.text).is_ok_and(|(id, _)| selected.contains(&id))
    });
    archive
        .transcripts
        .sort_by(|left, right| left.path.cmp(&right.path));
    for transcript in &mut archive.transcripts {
        let text = transform(&transcript.text, None, &archive.workspace, secrets)?;
        ensure!(
            metadata(&text)? == metadata(&transcript.text)?,
            "redaction changed Codex Session identity"
        );
        transcript.text = text;
    }
    lineage(&archive, true)?;
    let payload =
        serde_json::to_vec(&archive).context("could not encode Codex Session checkpoint")?;
    ensure!(
        payload.len() <= MAX_ENCODED_BYTES,
        "Codex checkpoint exceeds its encoded limit"
    );
    Ok(SessionCheckpoint {
        harness: "codex".into(),
        format: FORMAT.into(),
        sha256: digest(&payload),
        payload,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn task() -> Task {
        Task {
            harness_kind: 0,
            workspace: None,
            workspace_delivery: None,
            tag_id: "tag".into(),
            session_id: "session".into(),
            ..Default::default()
        }
    }

    fn transcript(id: &str, parent: Option<&str>) -> String {
        let mut meta = json!({"type":"session_meta","payload":{"id":id,"cwd":"/old/checkout"}});
        if let Some(parent) = parent {
            meta["payload"]["source"] =
                json!({"subagent":{"thread_spawn":{"parent_thread_id":parent}}});
        }
        format!(
            "{meta}\n{}\n",
            json!({"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"literal /old/checkout"}]}})
        )
    }

    #[test]
    fn captures_only_native_lineage_and_redacts_json_escaped_secrets() -> Result<()> {
        let home = tempfile::tempdir()?;
        let sessions = home.path().join("sessions/2026/11/11");
        std::fs::create_dir_all(&sessions)?;
        for (id, parent) in [
            ("root", None),
            ("child", Some("root")),
            ("grandchild", Some("child")),
            ("unrelated", None),
        ] {
            std::fs::write(sessions.join(format!("{id}.jsonl")), transcript(id, parent))?;
        }
        let secret = "credential-with-quote-\"and-slash-\\".to_string();
        let mut root = transcript("root", None);
        root.push_str(&format!(
            "{}\n",
            json!({"type":"response_item","payload":{"content":[{"text":secret}]}})
        ));
        std::fs::write(sessions.join("root.jsonl"), root)?;
        std::fs::write(home.path().join("auth.json"), "must never archive auth")?;
        std::fs::write(home.path().join("config.toml"), "must never archive config")?;
        let checkpoint = capture(
            &task(),
            home.path(),
            Path::new("/old/checkout"),
            "root".into(),
            std::slice::from_ref(&secret),
        )?;
        let archive: Archive = serde_json::from_slice(&checkpoint.payload)?;
        assert_eq!(archive.transcripts.len(), 3);
        assert!(
            !archive
                .transcripts
                .iter()
                .any(|file| file.path.contains("unrelated"))
        );
        let serialized = std::str::from_utf8(&checkpoint.payload)?;
        assert!(!serialized.contains("must never archive"));
        for file in &archive.transcripts {
            assert!(!file.text.contains(&secret));
            assert!(!file.text.contains("credential-with-quote"));
        }
        let restored_home = tempfile::tempdir()?;
        assert_eq!(
            restore(
                &checkpoint,
                &task(),
                restored_home.path(),
                Path::new("/new/checkout"),
                &[]
            )?,
            "root"
        );
        let restored =
            std::fs::read_to_string(restored_home.path().join("sessions/2026/11/11/root.jsonl"))?;
        let records = records(&restored)?;
        assert_eq!(records[0]["payload"]["cwd"], "/new/checkout");
        assert_eq!(
            records[1]["payload"]["content"][0]["text"],
            "literal /old/checkout"
        );
        assert_eq!(records[2]["payload"]["content"][0]["text"], "[REDACTED]");
        assert_eq!(
            std::fs::metadata(restored_home.path().join("sessions/2026/11/11/root.jsonl"))?.mode()
                & 0o777,
            0o600
        );
        Ok(())
    }

    #[test]
    fn refuses_native_symlinks_hardlinks_and_oversized_transcripts() -> Result<()> {
        for attack in [
            "file-symlink",
            "directory-symlink",
            "root-symlink",
            "hardlink",
            "oversized",
        ] {
            let home = tempfile::tempdir()?;
            let outside = tempfile::tempdir()?;
            let target = outside.path().join("root.jsonl");
            std::fs::write(&target, transcript("root", None))?;
            let sessions = home.path().join("sessions");
            std::fs::create_dir(&sessions)?;
            match attack {
                "file-symlink" => std::os::unix::fs::symlink(&target, sessions.join("root.jsonl"))?,
                "directory-symlink" => {
                    std::os::unix::fs::symlink(outside.path(), sessions.join("nested"))?
                }
                "root-symlink" => {
                    std::fs::remove_dir(&sessions)?;
                    std::os::unix::fs::symlink(outside.path(), &sessions)?;
                }
                "hardlink" => std::fs::hard_link(&target, sessions.join("root.jsonl"))?,
                "oversized" => {
                    File::create(sessions.join("root.jsonl"))?.set_len(MAX_FILE_BYTES as u64 + 1)?
                }
                _ => unreachable!(),
            }
            assert!(
                capture(
                    &task(),
                    home.path(),
                    Path::new("/old/checkout"),
                    "root".into(),
                    &[]
                )
                .is_err(),
                "accepted {attack}"
            );
            assert_eq!(std::fs::read_to_string(&target)?, transcript("root", None));
        }
        Ok(())
    }

    #[test]
    fn rejects_unrelated_duplicate_and_unbounded_checkpoint_archives() -> Result<()> {
        let make_archive = || Archive {
            version: 1,
            tag_id: "tag".into(),
            session_id: "session".into(),
            thread_id: "root".into(),
            workspace: "/old/checkout".into(),
            transcripts: vec![Transcript {
                path: "root.jsonl".into(),
                text: transcript("root", None),
            }],
        };
        for attack in [
            "unrelated",
            "duplicate-id",
            "duplicate-path",
            "traversal",
            "too-many",
            "bad-json",
            "option-id",
        ] {
            let mut archive = make_archive();
            match attack {
                "unrelated" => archive.transcripts.push(Transcript {
                    path: "another.jsonl".into(),
                    text: transcript("another", None),
                }),
                "duplicate-id" => archive.transcripts.push(Transcript {
                    path: "another.jsonl".into(),
                    text: transcript("root", None),
                }),
                "duplicate-path" => archive.transcripts.push(Transcript {
                    path: "root.jsonl".into(),
                    text: transcript("child", Some("root")),
                }),
                "traversal" => archive.transcripts[0].path = "../root.jsonl".into(),
                "too-many" => {
                    for index in 0..MAX_FILES {
                        archive.transcripts.push(Transcript {
                            path: format!("child{index}.jsonl"),
                            text: transcript(&format!("child{index}"), Some("root")),
                        });
                    }
                }
                "bad-json" => archive.transcripts[0].text.push_str("not-json\n"),
                "option-id" => archive.thread_id = "--last".into(),
                _ => unreachable!(),
            }
            let payload = serde_json::to_vec(&archive)?;
            let checkpoint = SessionCheckpoint {
                harness: "codex".into(),
                format: FORMAT.into(),
                sha256: digest(&payload),
                payload,
            };
            let home = tempfile::tempdir()?;
            assert!(
                restore(
                    &checkpoint,
                    &task(),
                    home.path(),
                    Path::new("/new/checkout"),
                    &[]
                )
                .is_err(),
                "accepted {attack}"
            );
            assert!(
                !home.path().join("sessions").exists(),
                "validated archive before writing files"
            );
        }
        let checkpoint = SessionCheckpoint {
            harness: "codex".into(),
            format: FORMAT.into(),
            payload: vec![b' '; MAX_ENCODED_BYTES + 1],
            sha256: "0".repeat(64),
        };
        let home = tempfile::tempdir()?;
        assert!(
            restore(
                &checkpoint,
                &task(),
                home.path(),
                Path::new("/new/checkout"),
                &[]
            )
            .is_err()
        );
        Ok(())
    }
}
