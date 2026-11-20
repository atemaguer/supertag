//! Codex's own memory, kept per Tag by the Worker Host.
//!
//! Codex keeps its memories in `CODEX_HOME/memories`, and each Attempt has a private CODEX_HOME,
//! so the adapter copies the Worker Host's working copy (`SUPERTAG_NATIVE_MEMORY_DIRECTORY`) in
//! before Codex starts and back out after it stops. The host merges the copy into the Tag's
//! store. Codex reads its memories (`use_memories`) and keeps notes with its memory tools
//! (`dedicated_tools`); outside the Tag's daily review it never runs its own extraction and
//! consolidation agents, which spend model calls Codex doesn't report (see
//! `config::NO_CONSOLIDATION_MODEL`). Codex turns the folder into a git repository and writes a consolidation scratch file;
//! neither is memory, so neither is copied.
use std::{
    ffi::OsString,
    fs,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, ensure};

/// The Worker Host's working copy of the Tag's Codex memory for this Attempt.
pub(crate) const DIRECTORY: &str = "SUPERTAG_NATIVE_MEMORY_DIRECTORY";

/// Entries of `CODEX_HOME/memories` that are not memory: Codex's own git repository and the
/// scratch file its consolidation writes.
const SKIPPED: &[&str] = &[".git", "phase2_workspace_diff.md"];

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

/// Copies the memory files under `from` into `to`, leaving out what is not memory. Links and
/// special files are never copied.
fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        if SKIPPED.iter().any(|skipped| name == *skipped) {
            continue;
        }
        let kind = entry.file_type()?;
        let target = to.join(&name);
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
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

/// Before Codex starts: the Tag's memory becomes `home/memories`.
pub(crate) fn copy_in(directory: &Path, home: &Path) -> Result<()> {
    copy_tree(directory, &home.join("memories")).context("could not stage Codex memory")
}

/// After Codex stops: the working copy becomes what Codex left in `home/memories`.
pub(crate) fn copy_out(home: &Path, directory: &Path) -> Result<()> {
    let memories = home.join("memories");
    if !memories.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        if fs::symlink_metadata(&path)?.is_dir() {
            fs::remove_dir_all(&path)?;
        } else {
            fs::remove_file(&path)?;
        }
    }
    copy_tree(&memories, directory).context("could not keep Codex memory")
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
        copy_in(&work, &home)?;
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
        copy_out(&home, &work)?;
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
        copy_in(&work, &home)?;
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
        copy_out(&home, &work)?;
        assert!(
            notes
                .join("2026-11-17T00-00-00-staging-region.md")
                .is_file()
        );
        assert!(!work.join(".git").exists());
        Ok(())
    }
}
