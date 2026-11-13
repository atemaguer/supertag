//! Skills from a GitHub-hosted catalog: selected Skill trees fetched from an exact commit into a
//! Worker Host cache, so a retry resolves the commit and digest its Task first pinned.
use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;
use std::{
    fs::{self, DirBuilder},
    io::Read,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

const MAX_FILES: usize = 2048;
const MAX_BYTES: usize = 64 * 1024 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(120);

/// One `github` entry of a host Skill catalog.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct GithubCatalog {
    /// `OWNER/NAME` on github.com.
    repository: String,
    /// The directory that holds one directory per Skill.
    path: String,
    /// The branch, tag, or commit a new Task pins.
    revision: String,
    pub(super) skills: Vec<String>,
    #[serde(skip)]
    url: String,
}

impl GithubCatalog {
    pub(super) fn validate(&mut self) -> Result<()> {
        let segment = |value: &str| {
            !value.is_empty()
                && value.len() <= 100
                && !value.starts_with('.')
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
        };
        ensure!(
            self.repository
                .split_once('/')
                .is_some_and(|(owner, name)| segment(owner) && segment(name)),
            "GitHub Skill catalog repository must be OWNER/NAME"
        );
        ensure!(
            self.path.len() <= 1024 && self.path.split('/').all(segment),
            "GitHub Skill catalog path must be a relative directory without . or .. parts"
        );
        ensure!(
            !self.revision.is_empty()
                && self.revision.len() <= 256
                && !self.revision.starts_with('-')
                && !self
                    .revision
                    .chars()
                    .any(|c| c.is_whitespace() || c.is_control() || c == ':'),
            "GitHub Skill catalog revision is invalid"
        );
        ensure!(
            !self.skills.is_empty()
                && self.skills.len() <= super::MAX_SKILLS
                && self.skills.iter().all(|skill| segment(skill)),
            "GitHub Skill catalog skills must name 1 to 64 directories"
        );
        self.url = format!("https://github.com/{}.git", self.repository);
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn with_url(mut self, url: &str) -> Self {
        self.url = url.into();
        self
    }

    /// The Skill's cached tree and its commit: `pinned` when a Task already pinned one,
    /// otherwise the catalog revision as it is now.
    pub(super) fn pin(
        &self,
        skill: &str,
        pinned: Option<&str>,
        cache: &Path,
        cancel: &CancellationToken,
    ) -> Result<(PathBuf, String)> {
        ensure!(
            self.skills.iter().any(|name| name == skill),
            "Skill reference is not present in the host catalog"
        );
        if let Some(commit) = pinned {
            ensure!(
                valid_commit(commit),
                "GitHub Skill {skill} has an invalid pinned commit"
            );
        }
        create_private(cache)?;
        let repository = cache.join(super::hex_digest(
            format!("{}\0{}\0{}", self.url, self.repository, self.path).as_bytes(),
        ));
        create_private(&repository)?;
        if let Some(commit) = pinned {
            let target = repository.join(commit).join(skill);
            if target.is_dir() {
                return Ok((target, commit.into()));
            }
        }
        let work = tempfile::Builder::new()
            .prefix("fetch-")
            .permissions(fs::Permissions::from_mode(0o700))
            .tempdir_in(&repository)?;
        let git_dir = work.path().join("git");
        git(
            work.path(),
            &git_dir,
            &["init", "--bare", "--quiet"],
            cancel,
        )?;
        let revision = pinned.unwrap_or(&self.revision);
        let fetched = git(
            work.path(),
            &git_dir,
            &[
                "fetch",
                "--quiet",
                "--no-tags",
                "--depth=1",
                &self.url,
                revision,
            ],
            cancel,
        );
        if fetched.is_err() {
            ensure!(!cancel.is_cancelled(), "context preparation cancelled");
            if pinned.is_some() {
                bail!(
                    "GitHub Skill catalog {} at {revision}: pinned contents for Skill {skill} are not available on this Worker Host; restore the commit in the repository, re-run the Task on the original host, or start a new Task to re-pin",
                    self.repository
                );
            }
            bail!(
                "GitHub Skill catalog {}: cannot fetch revision {revision}; check the revision and Worker Host GitHub access",
                self.repository
            );
        }
        let commit = String::from_utf8(git(
            work.path(),
            &git_dir,
            &["rev-parse", "FETCH_HEAD^{commit}"],
            cancel,
        )?)?
        .trim()
        .to_owned();
        ensure!(
            valid_commit(&commit) && pinned.is_none_or(|pinned| pinned == commit),
            "GitHub Skill catalog {}: revision {revision} did not resolve to the expected commit",
            self.repository
        );
        let target = repository.join(&commit).join(skill);
        if target.is_dir() {
            return Ok((target, commit));
        }
        let prefix = format!("{}/{skill}", self.path);
        let listing = git(
            work.path(),
            &git_dir,
            &["ls-tree", "-rz", &commit, "--", &prefix],
            cancel,
        )?;
        let rows: Vec<&[u8]> = listing
            .split(|byte| *byte == 0)
            .filter(|row| !row.is_empty())
            .collect();
        ensure!(
            !rows.is_empty(),
            "GitHub Skill catalog {} at {commit}: Skill {skill} is missing under {}",
            self.repository,
            self.path
        );
        ensure!(
            rows.len() <= MAX_FILES,
            "GitHub Skill catalog Skill {skill} exceeds {MAX_FILES} files"
        );
        let staged = work.path().join("skill");
        create_private(&staged)?;
        let mut bytes = 0usize;
        let mut has_instructions = false;
        for row in rows {
            let row = std::str::from_utf8(row)?;
            let (meta, path) = row
                .split_once('\t')
                .context("unexpected Git tree listing")?;
            let mut meta = meta.split(' ');
            let (Some(mode), Some("blob"), Some(oid), None) =
                (meta.next(), meta.next(), meta.next(), meta.next())
            else {
                bail!("GitHub Skill catalog Skill {skill} contains an unsupported file type");
            };
            let mode = match mode {
                "100644" => 0o644,
                "100755" => 0o755,
                _ => bail!("GitHub Skill catalog Skill {skill} contains an unsupported file type"),
            };
            let child = path
                .strip_prefix(&prefix)
                .and_then(|child| child.strip_prefix('/'))
                .filter(|child| {
                    !child.is_empty()
                        && child
                            .split('/')
                            .all(|part| !part.is_empty() && part != "." && part != "..")
                })
                .with_context(|| {
                    format!("GitHub Skill catalog Skill {skill} has an unsafe path")
                })?;
            ensure!(
                valid_commit(oid),
                "GitHub Skill catalog Skill {skill} lists an invalid object"
            );
            let content = git(work.path(), &git_dir, &["cat-file", "blob", oid], cancel)?;
            bytes = bytes.saturating_add(content.len());
            ensure!(
                bytes <= MAX_BYTES,
                "GitHub Skill catalog Skill {skill} exceeds 64 MiB"
            );
            has_instructions |= child == "SKILL.md";
            let destination = staged.join(child);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&destination, content)?;
            // The package digest includes file modes. Git records only regular and executable
            // blobs; set both explicitly so the host umask cannot change a Task's pin.
            fs::set_permissions(&destination, fs::Permissions::from_mode(mode))?;
        }
        ensure!(
            has_instructions,
            "GitHub Skill catalog Skill {skill} needs SKILL.md"
        );
        let parent = repository.join(&commit);
        create_private(&parent)?;
        match fs::rename(&staged, &target) {
            Ok(()) => {}
            // Another Attempt cached the same commit first.
            Err(_) if target.is_dir() => {}
            Err(error) => return Err(error.into()),
        }
        Ok((target, commit))
    }
}

fn valid_commit(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn create_private(path: &Path) -> Result<()> {
    match DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = fs::symlink_metadata(path)?;
            ensure!(
                metadata.is_dir() && !metadata.file_type().is_symlink(),
                "Skill catalog cache is not a real directory"
            );
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

/// Runs Git in the fetch's private directory with hooks, prompts, and the system configuration
/// off. The operator's global configuration stays, so its GitHub credential helper applies.
fn git(
    directory: &Path,
    git_dir: &Path,
    args: &[&str],
    cancel: &CancellationToken,
) -> Result<Vec<u8>> {
    let mut child = Command::new("git")
        .current_dir(directory)
        .env("GIT_DIR", git_dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_CONFIG_PARAMETERS")
        .env_remove("GIT_CONFIG_COUNT")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
        ])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("git could not start")?;
    let mut stdout = child.stdout.take().context("git output unavailable")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        (&mut stdout)
            .take(MAX_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let deadline = Instant::now() + GIT_TIMEOUT;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if cancel.is_cancelled() || Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            bail!("git {} stopped before it finished", args[0]);
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let bytes = reader
        .join()
        .map_err(|_| anyhow::anyhow!("git output reader failed"))??;
    ensure!(status.success(), "git {} failed", args[0]);
    ensure!(
        bytes.len() <= MAX_BYTES,
        "git {} output is too large",
        args[0]
    );
    Ok(bytes)
}
