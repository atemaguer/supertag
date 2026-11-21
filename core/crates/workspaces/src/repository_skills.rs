//! A commit's repository Skills, the directories under `.claude/skills` and `.agents/skills`
//! that hold a `SKILL.md`, read as data from the private repository. Nothing is checked out and
//! no repository command, hook, or filter runs on the Worker Host.

use std::{
    collections::BTreeMap,
    fs::{self, DirBuilder, OpenOptions},
    io::Write as _,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::Path,
};

use anyhow::{Context, Result, ensure};

use crate::devcontainer::{git, tree_entry, valid_commit};

/// The repository Skill directories, in precedence order, and the subdirectory of the
/// destination each is written to.
pub const ROOTS: [(&str, &str); 2] = [(".claude/skills", "claude"), (".agents/skills", "agents")];
const MAX_SKILLS: usize = 1024;
const MAX_FILES: usize = 2048;
const MAX_BYTES: usize = 64 * 1024 * 1024;
const LISTING_LIMIT: usize = 16 * 1024 * 1024;

/// A repository Skill that was not written, and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkippedRepositorySkill {
    /// The repository directory, such as `.claude/skills`.
    pub root: &'static str,
    pub name: String,
    pub reason: String,
}

/// Writes each Skill under [`ROOTS`] at `commit` to `destination/<subdirectory>/<name>`, with
/// Git's file modes. A Skill with a symbolic link, a submodule, an unsafe name, or too many
/// files or bytes is skipped and reported instead.
pub fn materialize(
    repository: &Path,
    commit: &str,
    destination: &Path,
) -> Result<Vec<SkippedRepositorySkill>> {
    ensure!(valid_commit(commit), "invalid repository Skill commit");
    let mut skipped = vec![];
    for (root, subdirectory) in ROOTS {
        let listed = git(
            repository,
            &["ls-tree", "-r", "-z", "--full-tree", commit, "--", root],
            LISTING_LIMIT,
        )?;
        let listed = String::from_utf8(listed).context("git listed a non-UTF-8 path")?;
        // Every entry of each Skill directory, by Skill name.
        let mut skills: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for entry in listed.split('\0').filter(|entry| !entry.is_empty()) {
            let path = entry.split_once('\t').map_or("", |(_, path)| path);
            let Some(relative) = path.strip_prefix(root).and_then(|p| p.strip_prefix('/')) else {
                continue;
            };
            // A file directly under the root is not a Skill.
            let Some((name, _)) = relative.split_once('/') else {
                continue;
            };
            skills.entry(name).or_default().push(entry);
        }
        let parent = destination.join(subdirectory);
        DirBuilder::new().mode(0o700).create(&parent)?;
        for (index, (name, entries)) in skills.into_iter().enumerate() {
            if name.starts_with('.') {
                continue;
            }
            let skip = |reason: &str| SkippedRepositorySkill {
                root,
                name: name.into(),
                reason: reason.into(),
            };
            if index >= MAX_SKILLS {
                skipped.push(skip("the directory holds more than 1024 Skills"));
                continue;
            }
            match write_skill(repository, root, name, &entries, &parent) {
                Ok(true) => {}
                // A directory without SKILL.md is not a Skill.
                Ok(false) => {}
                Err(error) => {
                    skipped.push(skip(&format!("{error:#}")));
                    if let Ok(true) = fs::exists(parent.join(name)) {
                        fs::remove_dir_all(parent.join(name))?;
                    }
                }
            }
        }
    }
    Ok(skipped)
}

/// Writes one Skill, or nothing when it has no `SKILL.md`.
fn write_skill(
    repository: &Path,
    root: &str,
    name: &str,
    entries: &[&str],
    parent: &Path,
) -> Result<bool> {
    ensure!(
        name.len() <= 128
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte)),
        "the Skill directory name is not supported"
    );
    let prefix = format!("{root}/{name}/");
    let mut files = vec![];
    let mut instructions = false;
    for entry in entries {
        let (mode, oid, path) =
            tree_entry(entry).context("the Skill holds a submodule or unsupported Git entry")?;
        ensure!(mode != "120000", "the Skill holds a symbolic link");
        let mode = match mode {
            "100644" => 0o644,
            "100755" => 0o755,
            _ => anyhow::bail!("the Skill holds an unsupported file type"),
        };
        let relative = path
            .strip_prefix(&prefix)
            .filter(|relative| {
                relative
                    .split('/')
                    .all(|part| !part.is_empty() && part != "." && part != "..")
            })
            .context("the Skill holds an unsafe path")?;
        instructions |= relative == "SKILL.md";
        files.push((relative, oid, mode));
    }
    if !instructions {
        return Ok(false);
    }
    ensure!(files.len() <= MAX_FILES, "the Skill exceeds 2048 files");
    let skill = parent.join(name);
    DirBuilder::new().mode(0o700).create(&skill)?;
    let mut total = 0usize;
    for (relative, oid, mode) in files {
        let bytes = git(repository, &["cat-file", "blob", oid], MAX_BYTES)?;
        total = total.saturating_add(bytes.len());
        ensure!(total <= MAX_BYTES, "the Skill exceeds 64 MiB");
        let target = skill.join(relative);
        if let Some(directory) = target.parent() {
            DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(directory)?;
        }
        // Parent directories come only from validated components; refuse to follow a link.
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&target)
            .with_context(|| format!("write Skill file {relative}"))?;
        file.write_all(&bytes)?;
        // The package digest includes file modes. Git records only regular and executable
        // blobs; set both explicitly so the host umask cannot change a Task's pin.
        fs::set_permissions(&target, fs::Permissions::from_mode(mode))?;
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn run_git(directory: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(directory)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .args([
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
            ])
            .args(["-c", "commit.gpgSign=false"])
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

    #[test]
    fn writes_each_committed_skill_and_skips_the_unsafe_ones() {
        let temp = tempfile::tempdir().unwrap();
        let repository = temp.path().join("repository");
        let write = |path: &str, body: &str| {
            let path = repository.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, body).unwrap();
        };
        write(".claude/skills/review/SKILL.md", "Review.");
        write(".claude/skills/review/scripts/check.sh", "#!/bin/sh\n");
        fs::set_permissions(
            repository.join(".claude/skills/review/scripts/check.sh"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        write(".claude/skills/notes/README.md", "Not a Skill.");
        write(".claude/skills/linked/SKILL.md", "Linked.");
        std::os::unix::fs::symlink("/etc/hosts", repository.join(".claude/skills/linked/hosts"))
            .unwrap();
        write(".agents/skills/deploy/SKILL.md", "Deploy.");
        write("README.md", "Repository.");
        run_git(&repository, &["init", "--quiet", "--initial-branch=main"]);
        run_git(&repository, &["add", "."]);
        run_git(&repository, &["commit", "--quiet", "-m", "Skills"]);
        let commit = run_git(&repository, &["rev-parse", "HEAD"]);
        // A working-tree change after the commit is not read.
        write(".claude/skills/review/SKILL.md", "Changed.");
        let destination = temp.path().join("destination");
        fs::create_dir(&destination).unwrap();
        let skipped = materialize(&repository, &commit, &destination).unwrap();
        assert_eq!(
            fs::read_to_string(destination.join("claude/review/SKILL.md")).unwrap(),
            "Review."
        );
        let mode = |path: &str| {
            std::os::unix::fs::MetadataExt::mode(&fs::metadata(destination.join(path)).unwrap())
                & 0o777
        };
        assert_eq!(mode("claude/review/SKILL.md"), 0o644);
        assert_eq!(mode("claude/review/scripts/check.sh"), 0o755);
        assert!(destination.join("agents/deploy/SKILL.md").is_file());
        assert!(!destination.join("claude/notes").exists());
        assert!(!destination.join("claude/linked").exists());
        assert_eq!(
            skipped,
            [SkippedRepositorySkill {
                root: ".claude/skills",
                name: "linked".into(),
                reason: "the Skill holds a symbolic link".into(),
            }]
        );
    }
}
