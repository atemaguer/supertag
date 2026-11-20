//! Codex's own memory, kept per Tag by the Worker Host.
//!
//! Codex keeps its memories in `CODEX_HOME/memories`, and each Attempt has a private CODEX_HOME,
//! so the adapter copies the Worker Host's working copy (`SUPERTAG_NATIVE_MEMORY_DIRECTORY`) in
//! before Codex starts and back out after it stops. The host merges the copy into the Tag's
//! store. Codex reads its memories (`use_memories`) and keeps notes with its memory tools
//! (`dedicated_tools`); outside the Tag's daily review it never runs its own extraction and
//! consolidation agents, which spend model calls Codex doesn't report (see
//! `config::NO_CONSOLIDATION_MODEL`). Codex turns the folder into a git repository and writes a
//! consolidation scratch file; neither is memory, so neither is copied.
//!
//! The review's consolidation needs that repository's baseline, though. Codex 0.163.0 consolidates
//! only when the folder differs from the baseline it committed after its last consolidation, or
//! lacks `MEMORY.md` or a valid `memory_summary.md` (`memories/write/src/phase2.rs`); a folder
//! without a usable `.git` gets a fresh baseline of what it holds now
//! (`ensure_git_baseline_repository`, `git-utils/src/baseline.rs`), so every note kept since
//! the last consolidation would look unchanged and never be folded in. So the working copy keeps
//! the folder as Codex last consolidated it in [`BASELINE`], beside the memory. Before the review
//! the adapter commits that as the memory folder's baseline, which Codex keeps; after it, the
//! baseline Codex left (its `HEAD`, which it moves only when a consolidation succeeds) becomes the
//! next one.
use std::{
    ffi::OsString,
    fs,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use anyhow::{Context, Result, bail, ensure};

/// The Worker Host's working copy of the Tag's Codex memory for this Attempt.
pub(crate) const DIRECTORY: &str = "SUPERTAG_NATIVE_MEMORY_DIRECTORY";

/// The directory of the working copy that holds the memory folder as Codex last consolidated it.
/// Never copied into `CODEX_HOME/memories`.
pub(crate) const BASELINE: &str = ".supertag-consolidated";

/// Entries of `CODEX_HOME/memories` that are not memory: Codex's own git repository and the
/// scratch file its consolidation writes.
const SKIPPED: &[&str] = &[".git", "phase2_workspace_diff.md", BASELINE];

/// Where Codex keeps ad hoc notes, which every consolidation folds into its summary.
const NOTES: &str = "extensions/ad_hoc/notes";

/// The working copy the Worker Host granted, if any: a private directory this user owns.
pub(crate) fn directory(
    environment: &std::collections::BTreeMap<OsString, OsString>,
) -> Result<Option<PathBuf>> {
    let Some(path) = environment
        .get(&OsString::from(DIRECTORY))
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let path = PathBuf::from(path);
    ensure!(
        path.is_absolute(),
        "native memory directory must be absolute"
    );
    let metadata = fs::symlink_metadata(&path).context("native memory directory is unavailable")?;
    ensure!(
        metadata.is_dir()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o077 == 0,
        "native memory directory must be a private directory owned by this user"
    );
    Ok(Some(path.canonicalize()?))
}

/// Copies the memory files under `from` into `to`, leaving out what is not memory and, at the
/// top, what `skip` names. Links and special files are never copied.
fn copy_tree_skipping(from: &Path, to: &Path, skip: &[&str]) -> Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        if SKIPPED.iter().chain(skip).any(|skipped| name == *skipped) {
            continue;
        }
        let kind = entry.file_type()?;
        let target = to.join(&name);
        if kind.is_dir() {
            copy_tree_skipping(&entry.path(), &target, &[])?;
        } else if kind.is_file() {
            let mut source = fs::File::open(entry.path())?;
            let mut destination = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&target)?;
            std::io::copy(&mut source, &mut destination)?;
        }
    }
    Ok(())
}

fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    copy_tree_skipping(from, to, &[])
}

/// Whether a memory folder holds what a finished consolidation leaves: `MEMORY.md` and a
/// `memory_summary.md` whose first line is `v1` (`validate_consolidation_artifacts`).
fn consolidated(memories: &Path) -> bool {
    memories.join("MEMORY.md").is_file()
        && fs::read_to_string(memories.join("memory_summary.md"))
            .is_ok_and(|summary| summary.lines().next() == Some("v1"))
}

/// Runs git on the memory folder's own repository, with no configuration but these settings.
fn git(memories: &Path, work_tree: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let output = Command::new("git")
        .arg("--git-dir")
        .arg(memories.join(".git"))
        .arg("--work-tree")
        .arg(work_tree)
        .args([
            "-c",
            "user.name=Codex",
            "-c",
            "user.email=noreply@openai.com",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "init.defaultBranch=main",
        ])
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .current_dir(work_tree)
        .stdin(Stdio::null())
        .output()
        .context("git is needed to keep Codex memory's baseline")?;
    if !output.status.success() {
        bail!(
            "git {} failed: {}",
            args.first().copied().unwrap_or_default(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(output.stdout)
}

/// Commits `baseline` as the memory folder's git baseline, as Codex's own would be after the
/// consolidation that left it, without touching the folder's files.
fn commit_baseline(memories: &Path, baseline: &Path) -> Result<()> {
    let _ = fs::remove_dir_all(memories.join(".git"));
    git(memories, memories, &["init", "-q"])?;
    git(memories, baseline, &["add", "-A", "."])?;
    git(
        memories,
        baseline,
        &[
            "commit",
            "-q",
            "--allow-empty",
            "--no-verify",
            "-m",
            "Initialize Codex git baseline\n\nCo-authored-by: Codex <noreply@openai.com>",
        ],
    )?;
    git(memories, memories, &["read-tree", "--reset", "HEAD"])?;
    Ok(())
}

/// The review's baseline: the folder as Codex last consolidated it, from the working copy; or,
/// for a folder consolidated before the working copy kept one, the folder without its ad hoc
/// notes, so every note is new to this review. `None` when the folder was never consolidated:
/// Codex consolidates it anyway.
fn seed_baseline(directory: &Path, home: &Path) -> Result<()> {
    let memories = home.join("memories");
    let kept = directory.join(BASELINE);
    if kept.is_dir() {
        return commit_baseline(&memories, &kept);
    }
    if !consolidated(&memories) {
        return Ok(());
    }
    let staged = home.join("supertag-memory-baseline");
    let _ = fs::remove_dir_all(&staged);
    copy_tree(&memories, &staged)?;
    let _ = fs::remove_dir_all(staged.join(NOTES));
    let committed = commit_baseline(&memories, &staged);
    let _ = fs::remove_dir_all(&staged);
    committed
}

/// Before Codex starts: the Tag's memory becomes `home/memories`. For the Tag's review
/// (`consolidate`), with the baseline Codex compares it against.
pub(crate) fn copy_in(directory: &Path, home: &Path, consolidate: bool) -> Result<()> {
    copy_tree(directory, &home.join("memories")).context("could not stage Codex memory")?;
    if consolidate && let Err(error) = seed_baseline(directory, home) {
        // Without it Codex consolidates only what it finds changed from a fresh baseline.
        // terminal-safe: standard error reaches only the Worker Host log, which redacts it.
        eprintln!("Codex memory's last consolidation could not be restored: {error:#}");
    }
    Ok(())
}

/// The memory folder's git baseline, `HEAD`, written out under `to`.
fn export_baseline(memories: &Path, to: &Path) -> Result<()> {
    let listing = git(
        memories,
        memories,
        &["ls-tree", "-r", "-z", "--full-tree", "HEAD"],
    )?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(to)?;
    for entry in listing
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        let entry = std::str::from_utf8(entry).context("a baseline path is not UTF-8")?;
        let (meta, path) = entry
            .split_once('\t')
            .context("unreadable baseline listing")?;
        let mut fields = meta.split(' ');
        let (mode, kind, object) = (fields.next(), fields.next(), fields.next());
        // Only regular files are memory; Codex's repository never holds links we copy.
        if kind != Some("blob") || !matches!(mode, Some("100644" | "100755")) {
            continue;
        }
        let relative = Path::new(path);
        ensure!(
            relative
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_))),
            "a baseline path leaves the memory folder"
        );
        let target = to.join(relative);
        if let Some(parent) = target.parent() {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent)?;
        }
        let bytes = git(
            memories,
            memories,
            &[
                "cat-file",
                "blob",
                object.context("unreadable baseline listing")?,
            ],
        )?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&target)?;
        std::io::Write::write_all(&mut file, &bytes)?;
    }
    Ok(())
}

/// After Codex stops: the working copy becomes what Codex left in `home/memories`. After the
/// review (`consolidate`), when the folder is consolidated, Codex's baseline becomes the one the
/// next review compares against; otherwise the working copy keeps the one it had.
pub(crate) fn copy_out(home: &Path, directory: &Path, consolidate: bool) -> Result<()> {
    let memories = home.join("memories");
    if !memories.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry.file_name() == BASELINE {
            continue;
        }
        let path = entry.path();
        if fs::symlink_metadata(&path)?.is_dir() {
            fs::remove_dir_all(&path)?;
        } else {
            fs::remove_file(&path)?;
        }
    }
    copy_tree(&memories, directory).context("could not keep Codex memory")?;
    if consolidate && consolidated(&memories) && memories.join(".git").is_dir() {
        let next = directory.join(format!("{BASELINE}.next"));
        let _ = fs::remove_dir_all(&next);
        match export_baseline(&memories, &next) {
            Ok(()) => {
                let _ = fs::remove_dir_all(directory.join(BASELINE));
                fs::rename(&next, directory.join(BASELINE))?;
            }
            Err(error) => {
                let _ = fs::remove_dir_all(&next);
                // terminal-safe: standard error reaches only the Worker Host log, which redacts it.
                eprintln!("Codex memory's consolidation baseline was not kept: {error:#}");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn private(path: &Path) {
        fs::DirBuilder::new().mode(0o700).create(path).unwrap();
    }

    #[test]
    fn memory_round_trips_without_codex_git_or_scratch() -> Result<()> {
        let root = tempfile::tempdir()?;
        let work = root.path().join("work");
        let home = root.path().join("home");
        private(&work);
        private(&home);
        fs::create_dir_all(work.join("extensions/ad_hoc/notes"))?;
        fs::write(work.join("extensions/ad_hoc/notes/old.md"), "old")?;
        fs::write(work.join("gone.md"), "gone")?;
        copy_in(&work, &home, false)?;
        assert_eq!(
            fs::read_to_string(home.join("memories/extensions/ad_hoc/notes/old.md"))?,
            "old"
        );
        // What Codex does during the turn: a git repository, scratch, a new note, a deletion.
        fs::create_dir_all(home.join("memories/.git/objects"))?;
        fs::write(home.join("memories/.git/HEAD"), "ref")?;
        fs::write(home.join("memories/phase2_workspace_diff.md"), "scratch")?;
        fs::write(home.join("memories/extensions/ad_hoc/notes/new.md"), "new")?;
        fs::remove_file(home.join("memories/gone.md"))?;
        std::os::unix::fs::symlink("/etc/hosts", home.join("memories/link.md"))?;
        copy_out(&home, &work, false)?;
        assert_eq!(
            fs::read_to_string(work.join("extensions/ad_hoc/notes/new.md"))?,
            "new"
        );
        assert_eq!(
            fs::read_to_string(work.join("extensions/ad_hoc/notes/old.md"))?,
            "old"
        );
        for absent in [".git", "phase2_workspace_diff.md", "gone.md", "link.md"] {
            assert!(fs::symlink_metadata(work.join(absent)).is_err(), "{absent}");
        }
        Ok(())
    }

    /// What Codex's phase 2 would find changed: the memory folder against its git baseline,
    /// as `diff_since_latest_init` compares `HEAD` with the files (`git-utils/src/baseline.rs`).
    fn changed(memories: &Path) -> Vec<String> {
        let output = Command::new("git")
            .arg("-C")
            .arg(memories)
            .args(["status", "--porcelain", "--untracked-files=all"])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        let mut lines: Vec<String> = String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::to_owned)
            .collect();
        lines.sort();
        lines
    }

    fn write(root: &Path, path: &str, text: &str) {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    const SUMMARY: &str = "v1\n## User preferences\n- Prefers squash merges. [ad-hoc note]\n";

    #[test]
    fn the_review_folds_in_what_changed_since_the_last_consolidation() -> Result<()> {
        let root = tempfile::tempdir()?;
        let (work, home) = (root.path().join("work"), root.path().join("home"));
        private(&work);
        private(&home);
        // The store as the last review left it, and a note an ordinary turn kept since.
        for folder in [work.clone(), work.join(BASELINE)] {
            write(&folder, "MEMORY.md", "# Task Group: releases\n");
            write(&folder, "memory_summary.md", SUMMARY);
            write(
                &folder,
                "extensions/ad_hoc/notes/squash.md",
                "Prefers squash merges.",
            );
        }
        write(
            &work,
            "extensions/ad_hoc/notes/region.md",
            "Staging is eu-north-1.",
        );
        // An ordinary turn gets no baseline: its consolidation never runs.
        copy_in(&work, &home, false)?;
        assert!(!home.join("memories/.git").exists());
        assert!(!home.join("memories").join(BASELINE).exists());
        copy_out(&home, &work, false)?;
        assert!(
            work.join(BASELINE).join("memory_summary.md").is_file(),
            "kept"
        );
        fs::remove_dir_all(&home)?;
        private(&home);

        // The review's Codex finds the new note changed, and only it.
        copy_in(&work, &home, true)?;
        let memories = home.join("memories");
        assert!(!memories.join(BASELINE).exists());
        assert_eq!(changed(&memories), ["?? extensions/ad_hoc/notes/region.md"]);
        // Codex consolidates it and resets its baseline (`reset_memory_workspace_baseline`);
        // the review's model keeps one more note after that.
        let consolidated = format!("{SUMMARY}- Staging is eu-north-1. [ad-hoc note]\n");
        write(&memories, "memory_summary.md", &consolidated);
        commit_baseline(&memories, &memories)?;
        write(
            &memories,
            "extensions/ad_hoc/notes/oncall.md",
            "Ask #ops first.",
        );
        copy_out(&home, &work, true)?;
        assert!(!work.join(".git").exists());
        let baseline = work.join(BASELINE);
        assert_eq!(
            fs::read_to_string(baseline.join("memory_summary.md"))?,
            consolidated
        );
        assert!(baseline.join("extensions/ad_hoc/notes/region.md").is_file());
        assert!(!baseline.join("extensions/ad_hoc/notes/oncall.md").exists());
        assert!(work.join("extensions/ad_hoc/notes/oncall.md").is_file());

        // The next review sees only what came after.
        fs::remove_dir_all(&home)?;
        private(&home);
        copy_in(&work, &home, true)?;
        assert_eq!(
            changed(&home.join("memories")),
            ["?? extensions/ad_hoc/notes/oncall.md"]
        );
        // A review whose consolidation failed leaves the baseline as it was.
        fs::remove_file(home.join("memories/MEMORY.md"))?;
        copy_out(&home, &work, true)?;
        assert_eq!(
            fs::read_to_string(work.join(BASELINE).join("memory_summary.md"))?,
            consolidated
        );
        Ok(())
    }

    #[test]
    fn a_store_consolidated_before_its_baseline_was_kept_folds_every_note() -> Result<()> {
        let root = tempfile::tempdir()?;
        let (work, home) = (root.path().join("work"), root.path().join("home"));
        private(&work);
        private(&home);
        write(&work, "MEMORY.md", "# Task Group: releases\n");
        write(&work, "memory_summary.md", SUMMARY);
        write(
            &work,
            "extensions/ad_hoc/notes/squash.md",
            "Prefers squash merges.",
        );
        write(
            &work,
            "extensions/ad_hoc/notes/region.md",
            "Staging is eu-north-1.",
        );
        copy_in(&work, &home, true)?;
        assert_eq!(
            changed(&home.join("memories")),
            [
                "?? extensions/ad_hoc/notes/region.md",
                "?? extensions/ad_hoc/notes/squash.md"
            ]
        );
        // A folder never consolidated gets no baseline from SuperTag: Codex consolidates it
        // because it lacks MEMORY.md, from a baseline of its own.
        let fresh = root.path().join("fresh");
        let fresh_home = root.path().join("fresh-home");
        private(&fresh);
        private(&fresh_home);
        write(
            &fresh,
            "extensions/ad_hoc/notes/region.md",
            "Staging is eu-north-1.",
        );
        copy_in(&fresh, &fresh_home, true)?;
        assert!(!fresh_home.join("memories/.git").exists());
        Ok(())
    }

    #[test]
    fn only_a_private_directory_is_taken_up() -> Result<()> {
        let root = tempfile::tempdir()?;
        let open = root.path().join("open");
        fs::create_dir(&open)?;
        fs::set_permissions(&open, std::os::unix::fs::PermissionsExt::from_mode(0o755))?;
        let environment = |path: &Path| {
            [(OsString::from(DIRECTORY), path.as_os_str().to_owned())]
                .into_iter()
                .collect()
        };
        assert!(directory(&environment(&open)).is_err());
        assert!(directory(&environment(Path::new("relative"))).is_err());
        assert!(directory(&Default::default())?.is_none());
        let private_dir = root.path().join("private");
        private(&private_dir);
        assert!(directory(&environment(&private_dir))?.is_some());
        Ok(())
    }

    /// One live model turn (operator-approved): a note an earlier turn kept, in the form Codex
    /// 0.156.0 writes it, reaches a later turn's private CODEX_HOME through `copy_in`, and the
    /// turn finds it by search under SuperTag's memory settings and memory context. Needs
    /// SUPERTAG_TEST_CODEX_BINARY, SUPERTAG_LIVE_CODE_MODE_HOME (a private CODEX_HOME holding a
    /// copied auth.json), and SUPERTAG_LIVE_CODE_MODE_MODEL.
    #[tokio::test]
    #[ignore = "spends one live Codex turn; run only with operator approval"]
    async fn live_a_kept_note_is_found_by_a_later_turn() -> Result<()> {
        let Some(signed_in) = std::env::var_os("SUPERTAG_LIVE_CODE_MODE_HOME") else {
            return Ok(());
        };
        let executable = std::env::var_os("SUPERTAG_TEST_CODEX_BINARY")
            .context("set SUPERTAG_TEST_CODEX_BINARY")?;
        let model = std::env::var("SUPERTAG_LIVE_CODE_MODE_MODEL")
            .context("set SUPERTAG_LIVE_CODE_MODE_MODEL")?;
        let root = tempfile::tempdir()?;
        let root = root.path().canonicalize()?;
        let (work, home, workspace) = (root.join("work"), root.join("home"), root.join("ws"));
        for directory in [&work, &home, &workspace] {
            private(directory);
        }
        let region = format!("ap-kestrel-{}", std::process::id() % 1000);
        let notes = work.join("extensions/ad_hoc/notes");
        fs::create_dir_all(&notes)?;
        fs::write(
            notes.join("2026-11-17T00-00-00-staging-region.md"),
            format!("The staging region is `{region}`.\n"),
        )?;
        let auth = fs::read(Path::new(&signed_in).join("auth.json"))?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(home.join("auth.json"))?;
        std::io::Write::write_all(&mut file, &auth)?;
        copy_in(&work, &home, false)?;
        let mut policy = crate::config::Policy::from_actions(&["files:read".into()], false)?;
        policy.memory = true;
        let args = crate::config::arguments(&workspace, Some(&model), Some("low"), &policy)?;
        let prompt = format!(
            "{}\n\nTask:\nWhich region is staging in? Reply with just the region, or UNKNOWN.",
            supertag_protocol::memory_context(false, Some(supertag_protocol::HarnessMemory::Codex))
        );
        let output = tokio::process::Command::new(&executable)
            .arg("exec")
            .args(["--skip-git-repo-check", "--json"])
            .args(&args[3..])
            .arg(prompt)
            .current_dir(&workspace)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").context("PATH")?)
            .env("HOME", &home)
            .env("CODEX_HOME", &home)
            .stdin(std::process::Stdio::null())
            .output()
            .await?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let usage = stdout.lines().rev().find(|line| line.contains("\"usage\""));
        // terminal-safe: the operator reads what the turn spent.
        println!("usage: {usage:?}");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(stdout.contains(&region), "{stdout}");
        copy_out(&home, &work, false)?;
        assert!(
            notes
                .join("2026-11-17T00-00-00-staging-region.md")
                .is_file()
        );
        assert!(!work.join(".git").exists());
        Ok(())
    }
}
