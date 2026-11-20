//! `--memory-eval=DIRECTORY`: a scripted stand-in for each built-in harness's memory, for the
//! memory eval (`tests/evals/memory/run.mjs`). A Tag named `memeval-HARNESS` runs here as that
//! harness (a test build keeps its memory in that harness's store): the fixture reads and writes
//! the memory folder the Worker Host grants in that harness's own format, as the harness would
//! with its file or memory tools, and writes what each turn saw to `DIRECTORY/LABEL.json` for the
//! eval to score.
//!
//! A turn's prompt carries its script, one directive a line:
//!
//! - `memory-eval LABEL` names the turn; a label already reported is never run twice.
//! - `remember SLUG | TYPE | TEXT` keeps a memory (TYPE is Claude Code's: user, feedback,
//!   project, reference), replacing one of the same slug.
//! - `forget SLUG` deletes one.
//! - `recall` reads the memory folder, as an activity line the Worker Host counts.
//! - `work LABEL :: DIRECTIVE ;; DIRECTIVE` starts a Work Session on the same Tag that runs those
//!   directives under LABEL.
//!
//! A turn whose request lists proposals (the Tag's daily review, in its `memory:` Session, or a
//! person's next turn after a Work Session, reported as `HARNESS-merge-N`) merges each one unless
//! its text says `(unverified)`. The review also folds Codex's ad hoc notes into
//! `memory_summary.md`, as Codex's consolidation does.
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use serde_json::{Value, json};
use supertag_protocol::{
    authenticated_request,
    v2::{
        AdapterBootstrap, HarnessPublishRequest, HarnessRun, HarnessStartWorkSessionRequest, Task,
        TaskEventKind, harness_client::HarnessClient,
        harness_work_sessions_client::HarnessWorkSessionsClient,
    },
};
use tonic::transport::Channel;

const HARNESSES: &[&str] = &["claude-code", "codex", "opencode", "cursor"];
const NOTES: &str = "extensions/ad_hoc/notes";
/// Claude Code loads the first 200 lines or 25 KB of `MEMORY.md`, and the OpenCode and Cursor
/// adapters load the folder kept for them the same way; Codex loads `memory_summary.md`, cut
/// to 2,500 tokens (about 10 KB).
const CLAUDE_LINES: usize = 200;
const CLAUDE_BYTES: usize = 25 * 1024;
const CODEX_BYTES: usize = 10 * 1024;

fn report_directory() -> Option<PathBuf> {
    std::env::args().find_map(|arg| arg.strip_prefix("--memory-eval=").map(PathBuf::from))
}

fn cut(text: &str, limit: usize) -> &str {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// What the harness loads of its memory index into this turn.
fn loaded(harness: &str, folder: &Path) -> String {
    if harness == "codex" {
        let summary = fs::read_to_string(folder.join("memory_summary.md")).unwrap_or_default();
        return cut(&summary, CODEX_BYTES).trim_end().to_owned();
    }
    let index = fs::read_to_string(folder.join("MEMORY.md")).unwrap_or_default();
    let first: Vec<&str> = index.lines().take(CLAUDE_LINES).collect();
    cut(&first.join("\n"), CLAUDE_BYTES).trim_end().to_owned()
}

/// Every memory file in the folder, by path: what the harness could read with its tools.
fn memories(harness: &str, folder: &Path) -> BTreeMap<String, String> {
    let mut found = BTreeMap::new();
    let root = if harness == "codex" {
        folder.join(NOTES)
    } else {
        folder.to_owned()
    };
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".md") && name != "MEMORY.md" {
                let path = if harness == "codex" {
                    format!("{NOTES}/{name}")
                } else {
                    name
                };
                found.insert(path, fs::read_to_string(entry.path()).unwrap_or_default());
            }
        }
    }
    found
}

fn slug(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(48)
        .collect()
}

/// Keeps a memory in the harness's own format: a file with Claude Code's frontmatter linked
/// from `MEMORY.md`, or a Codex ad hoc note whose first line names it.
fn remember(harness: &str, folder: &Path, name: &str, kind: &str, text: &str) -> Result<()> {
    let name = slug(name);
    if harness == "codex" {
        fs::create_dir_all(folder.join(NOTES))?;
        fs::write(
            folder.join(NOTES).join(format!("{name}.md")),
            format!("{name}: {text}\n"),
        )?;
        return Ok(());
    }
    fs::write(
        folder.join(format!("{name}.md")),
        format!("---\nname: {name}\ndescription: {text}\ntype: {kind}\n---\n{text}\n"),
    )?;
    let index_path = folder.join("MEMORY.md");
    let index = fs::read_to_string(&index_path).unwrap_or_default();
    let link = format!("({name}.md)");
    let mut lines: Vec<String> = index
        .lines()
        .filter(|line| !line.contains(&link))
        .map(str::to_owned)
        .collect();
    lines.push(format!("- [{name}]({name}.md) — {text}"));
    fs::write(index_path, format!("{}\n", lines.join("\n")))?;
    Ok(())
}

fn forget(harness: &str, folder: &Path, name: &str) -> Result<()> {
    let name = slug(name);
    if harness == "codex" {
        let _ = fs::remove_file(folder.join(NOTES).join(format!("{name}.md")));
        return Ok(());
    }
    let _ = fs::remove_file(folder.join(format!("{name}.md")));
    let index_path = folder.join("MEMORY.md");
    if let Ok(index) = fs::read_to_string(&index_path) {
        let link = format!("({name}.md)");
        let kept: Vec<&str> = index.lines().filter(|line| !line.contains(&link)).collect();
        fs::write(index_path, format!("{}\n", kept.join("\n")))?;
    }
    Ok(())
}

/// Codex's consolidation: its summary lists every ad hoc note.
fn consolidate(folder: &Path) -> Result<()> {
    let notes = memories("codex", folder);
    let mut summary = String::from("v1\n\n## General Tips\n\n");
    for text in notes.values() {
        summary.push_str(&format!("- {}\n", text.trim()));
    }
    fs::write(folder.join("memory_summary.md"), summary)?;
    if !folder.join("MEMORY.md").exists() {
        fs::write(folder.join("MEMORY.md"), "# Task Group: memory eval\n")?;
    }
    Ok(())
}

/// The proposals a turn's request lists for it to merge, as the review's or a person's next turn
/// after a Work Session: each one's title and text.
fn proposals(prompt: &str) -> Vec<(String, String)> {
    let Some((_, section)) = prompt.split_once("\n\nProposals ") else {
        return vec![];
    };
    let mut found: Vec<(String, String)> = vec![];
    for line in section.lines() {
        if let Some(entry) = line.strip_prefix("- hmem_") {
            // `- ID from Session S (Task T), KIND: TITLE`
            let title = entry
                .split_once(": ")
                .map(|(_, title)| title.trim().to_owned())
                .unwrap_or_default();
            found.push((title, String::new()));
        } else if let (Some(text), Some(last)) = (line.strip_prefix("  "), found.last_mut()) {
            if !last.1.is_empty() {
                last.1.push('\n');
            }
            last.1.push_str(text);
        }
    }
    found
}

async fn activity(
    harness: &mut HarnessClient<Channel>,
    token: &str,
    sequence: &mut u64,
    text: String,
) -> Result<()> {
    harness
        .publish(authenticated_request(
            HarnessPublishRequest {
                sequence: *sequence,
                text,
                kind: TaskEventKind::Activity as i32,
            },
            token,
            None,
        )?)
        .await?;
    *sequence += 1;
    Ok(())
}

/// Runs the turn's script; `None` when this fixture is off or the Tag is not an eval Tag.
pub async fn exercise(
    bootstrap: &AdapterBootstrap,
    run: &HarnessRun,
    task: &Task,
    (client, sequence): (&mut HarnessClient<Channel>, &mut u64),
) -> Result<Option<String>> {
    let Some(reports) = report_directory() else {
        return Ok(None);
    };
    let Some(harness) = task
        .tag_id
        .strip_prefix("memeval-")
        .and_then(|name| HARNESSES.iter().copied().find(|known| *known == name))
    else {
        return Ok(None);
    };
    let review = task
        .session_id
        .starts_with(supertag_protocol::MEMORY_REVIEW_SESSION_PREFIX);
    let next = |kind: &str| {
        let mut index = 1;
        while reports
            .join(format!("{harness}-{kind}-{index}.json"))
            .exists()
        {
            index += 1;
        }
        format!("{harness}-{kind}-{index}")
    };
    let scripted = task
        .prompt
        .lines()
        .find_map(|line| line.trim().strip_prefix("memory-eval "))
        .map(slug)
        .filter(|label| !reports.join(format!("{label}.json")).exists());
    // A turn with no script of its own, such as a Work Session's report turn quoting its
    // parent's, or a retry, runs none; it still merges the proposals its request lists.
    let (label, lines): (String, Vec<&str>) = if review {
        (next("review"), vec![])
    } else if let Some(label) = scripted {
        (label, task.prompt.lines().map(str::trim).collect())
    } else if !proposals(&task.prompt).is_empty() {
        (next("merge"), vec![])
    } else {
        return Ok(Some(format!(
            "memory eval: nothing to do in {}",
            task.session_id
        )));
    };
    let report = reports.join(format!("{label}.json"));
    let folder = std::env::var_os("SUPERTAG_NATIVE_MEMORY_DIRECTORY").map(PathBuf::from);
    let token = bootstrap.token.as_str();
    let mut seen = json!({
        "label": label,
        "tag_id": task.tag_id,
        "session_id": task.session_id,
        "harness": harness,
        "granted": folder.is_some(),
        "loaded": folder.as_deref().map(|folder| loaded(harness, folder)),
        "memories": folder.as_deref().map(|folder| memories(harness, folder)),
        "proposals": proposals(&task.prompt)
            .iter()
            .map(|(title, text)| json!({"title": title, "text": text}))
            .collect::<Vec<_>>(),
    });
    let mut did: Vec<Value> = vec![];
    if let Some(folder) = &folder {
        let index = if harness == "codex" {
            folder.join(NOTES)
        } else {
            folder.join("MEMORY.md")
        };
        for line in &lines {
            if let Some(rest) = line.strip_prefix("remember ") {
                let mut parts = rest.splitn(3, '|').map(str::trim);
                let (name, kind, text) = (
                    parts.next().unwrap_or_default(),
                    parts.next().unwrap_or("project"),
                    parts.next().unwrap_or_default(),
                );
                remember(harness, folder, name, kind, text)?;
                activity(
                    client,
                    token,
                    sequence,
                    format!(
                        "Editing {}",
                        folder.join(format!("{}.md", slug(name))).display()
                    ),
                )
                .await?;
                did.push(json!({"remember": slug(name)}));
            } else if let Some(name) = line.strip_prefix("forget ") {
                forget(harness, folder, name)?;
                did.push(json!({"forget": slug(name)}));
            } else if *line == "recall" {
                activity(
                    client,
                    token,
                    sequence,
                    format!("Reading {}", index.display()),
                )
                .await?;
                did.push(json!("recall"));
            }
        }
        // Merge what the request proposes, unless unverified, in the harness's own words.
        for (title, text) in proposals(&task.prompt) {
            let name = title
                .split(':')
                .next()
                .unwrap_or_default()
                .trim()
                .to_owned();
            if text.contains("(unverified)") {
                did.push(json!({"drop": slug(&name)}));
                continue;
            }
            // A Codex note's text starts with its name, as `remember` writes it.
            let body = text
                .trim()
                .strip_prefix(&format!("{name}: "))
                .unwrap_or(text.trim());
            remember(harness, folder, &name, "project", body)?;
            did.push(json!({"merge": slug(&name)}));
        }
        if review && harness == "codex" {
            consolidate(folder)?;
            did.push(json!("consolidate"));
        }
    }
    for line in &lines {
        let Some(rest) = line.strip_prefix("work ") else {
            continue;
        };
        let (child, script) = rest.split_once("::").context("work LABEL :: DIRECTIVES")?;
        let may_start = run
            .coordination
            .as_ref()
            .is_some_and(|scope| scope.may_start_work_session);
        if !may_start {
            did.push(json!({"work": "not allowed"}));
            continue;
        }
        let instruction = std::iter::once(format!("memory-eval {}", child.trim()))
            .chain(script.split(";;").map(|part| part.trim().to_owned()))
            .collect::<Vec<_>>()
            .join("\n");
        let mut work = HarnessWorkSessionsClient::connect(bootstrap.endpoint.clone()).await?;
        let started = work
            .start(authenticated_request(
                HarnessStartWorkSessionRequest {
                    operation_id: format!("memory-eval-{}", slug(child)),
                    title: format!("Memory eval {}", child.trim()),
                    instruction,
                    harness: None,
                },
                token,
                None,
            )?)
            .await?
            .into_inner();
        did.push(json!({"work": started.work_session_id}));
    }
    seen["did"] = json!(did);
    fs::write(&report, serde_json::to_vec_pretty(&seen)?)?;
    Ok(Some(format!("memory eval: {label} done")))
}
