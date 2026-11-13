//! A Workspace's `setup` command: one operator-chosen shell command, such as `npm ci`, that
//! prepares each Task checkout. As in TypeScript, it runs on the Worker Host outside any harness
//! sandbox, in the Task checkout itself at the Workspace's base commit, with its own temporary
//! directory and a 10-minute limit. Its untracked outputs, such as `node_modules/`, then stay at
//! the same absolute paths while the checkout moves to the Task's start commit, so outputs that
//! embed their own path, such as a virtualenv, keep working. Any output file with another hard
//! link, such as one into a package store, first gets a private copy, so a Task never changes
//! the store. Symlinks are kept as setup made them and are never followed.
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, DirBuilder, OpenOptions},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use tokio::{io::AsyncReadExt, process::Command};
use tokio_util::sync::CancellationToken;

use crate::{check_cancelled, git, paths};

/// Setup failed before the harness could start. Its text is untrusted setup output.
#[derive(Debug)]
pub struct SetupFailed(pub String);

impl std::fmt::Display for SetupFailed {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for SetupFailed {}

/// The longest setup command accepted.
pub const MAX_SETUP_COMMAND_BYTES: usize = 4096;
/// TypeScript's default `setupTimeoutMs`.
pub const SETUP_TIMEOUT: Duration = Duration::from_secs(600);
/// Setup output kept in a failed Task's result.
const OUTPUT_TAIL_BYTES: usize = 4096;
/// Top-level setup outputs.
const MAX_OUTPUTS: usize = 10_000;
/// Host variables setup receives; everything else, including provider credentials, is withheld.
const INHERITED: [&str; 8] = [
    "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "SHELL",
];

pub fn validate_command(command: &str) -> Result<()> {
    ensure!(
        !command.trim().is_empty()
            && command.len() <= MAX_SETUP_COMMAND_BYTES
            && !command.contains('\0'),
        "a Workspace setup command must be 1 to {MAX_SETUP_COMMAND_BYTES} bytes"
    );
    Ok(())
}

/// Setup outputs moved aside while the checkout moves to the Task's start commit.
pub(crate) struct Held {
    directory: PathBuf,
    outputs: Vec<String>,
}

/// Checks out `base_commit` at `checkout`, runs `command` there, and moves its untracked outputs
/// into `scratch/held`. The checkout directory is removed; the caller checks out the Task's start
/// commit at the same path and calls [`Held::restore`].
pub(crate) async fn run(
    repository: &git::Repository,
    checkout: &Path,
    base_commit: &str,
    command: &str,
    scratch: &Path,
    cancel: &CancellationToken,
) -> Result<Held> {
    validate_command(command)?;
    // An interrupted run leaves nothing to reuse; start again from a clean base checkout.
    if fs::symlink_metadata(scratch).is_ok() {
        paths::remove_owned_directory(scratch)?;
    }
    DirBuilder::new().mode(0o700).create(scratch)?;
    let entries = repository.tree(base_commit, cancel).await?;
    repository
        .checkout(checkout, base_commit, &entries, cancel)
        .await?;
    let temporary = scratch.join("tmp");
    DirBuilder::new().mode(0o700).create(&temporary)?;
    let outcome = execute(checkout, &temporary, command, SETUP_TIMEOUT, cancel).await;
    paths::remove_owned_directory(&temporary)?;
    outcome?;
    let outputs = untracked(checkout, &entries, cancel)?;
    for output in &outputs {
        replace_hard_links(&checkout.join(output), cancel).map_err(|error| {
            SetupFailed(format!(
                "Workspace setup output {output} could not get its own copy: {error:#}"
            ))
        })?;
    }
    let directory = scratch.join("held");
    DirBuilder::new().mode(0o700).create(&directory)?;
    for (index, output) in outputs.iter().enumerate() {
        fs::rename(checkout.join(output), directory.join(index.to_string()))?;
    }
    paths::remove_owned_directory(checkout)?;
    Ok(Held { directory, outputs })
}

impl Held {
    /// Moves outputs back to their paths in the Task checkout where the parent directory exists
    /// and nothing occupies the path. Returns the outputs restored; the rest are discarded.
    pub(crate) fn restore(
        self,
        checkout: &Path,
        cancel: &CancellationToken,
    ) -> Result<Vec<String>> {
        let mut restored = Vec::new();
        for (index, output) in self.outputs.iter().enumerate() {
            check_cancelled(cancel)?;
            let destination = checkout.join(output);
            let parent_exists = destination
                .parent()
                .is_some_and(|parent| paths::verify_directory(parent).is_ok());
            if !parent_exists || fs::symlink_metadata(&destination).is_ok() {
                continue;
            }
            fs::rename(self.directory.join(index.to_string()), &destination)?;
            restored.push(output.clone());
        }
        let scratch = self
            .directory
            .parent()
            .context("held outputs have no parent")?;
        paths::remove_owned_directory(scratch)?;
        Ok(restored)
    }
}

async fn execute(
    tree: &Path,
    temporary: &Path,
    command: &str,
    limit: Duration,
    cancel: &CancellationToken,
) -> Result<()> {
    check_cancelled(cancel)?;
    let mut process = Command::new("/bin/sh");
    process
        .args(["-c", command])
        .current_dir(tree)
        .env_clear()
        .envs(INHERITED.into_iter().filter_map(|name| {
            std::env::var_os(name)
                .filter(|value| !value.as_encoded_bytes().starts_with(b"()"))
                .map(|value| (name, value))
        }))
        .env("TMPDIR", temporary)
        .env("TMP", temporary)
        .env("TEMP", temporary)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    process.process_group(0);
    let mut child = process
        .spawn()
        .map_err(|error| SetupFailed(format!("Workspace setup could not start: {error}")))?;
    let group = child.id().context("setup process has no ID")? as i32;
    let mut stdout = child.stdout.take().context("setup output unavailable")?;
    let mut stderr = child.stderr.take().context("setup output unavailable")?;
    let finished = async {
        let (out, err, status) = tokio::try_join!(tail(&mut stdout), tail(&mut stderr), async {
            Ok(child.wait().await?)
        })?;
        Ok::<_, anyhow::Error>((out, err, status))
    };
    let outcome = tokio::select! {
        biased;
        _ = cancel.cancelled() => None,
        _ = tokio::time::sleep(limit) => Some(Err(SetupFailed(format!(
            "Workspace setup failed: it did not finish within {} seconds",
            limit.as_secs()
        )).into())),
        outcome = finished => Some(outcome),
    };
    // Setup never leaves processes behind, even ones it started in the background.
    // SAFETY: the group is the setup shell's own process group.
    unsafe {
        libc::kill(-group, libc::SIGKILL);
    }
    let Some(outcome) = outcome else {
        let _ = child.wait().await;
        anyhow::bail!("workspace operation cancelled");
    };
    let (out, err, status) = outcome?;
    if status.success() {
        return Ok(());
    }
    let mut output = String::from_utf8_lossy(&out).into_owned();
    output.push_str(&String::from_utf8_lossy(&err));
    let start = output.len().saturating_sub(OUTPUT_TAIL_BYTES);
    let start = (start..=output.len())
        .find(|index| output.is_char_boundary(*index))
        .unwrap_or(output.len());
    Err(SetupFailed(format!(
        "Workspace setup failed ({status}). Untrusted setup output:\n{}",
        output[start..].trim()
    ))
    .into())
}

async fn tail(reader: &mut (impl tokio::io::AsyncRead + Unpin)) -> Result<Vec<u8>> {
    let mut kept = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            return Ok(kept);
        }
        kept.extend_from_slice(&buffer[..read]);
        if kept.len() > OUTPUT_TAIL_BYTES {
            kept.drain(..kept.len() - OUTPUT_TAIL_BYTES);
        }
    }
}

/// Untracked entries setup left in `tree`, collapsed to the highest directory that holds no
/// tracked file.
fn untracked(
    tree: &Path,
    entries: &BTreeMap<String, git::TreeEntry>,
    cancel: &CancellationToken,
) -> Result<Vec<String>> {
    let mut tracked_directories = BTreeSet::new();
    for path in entries.keys() {
        let mut parent = Path::new(path).parent();
        while let Some(directory) = parent.filter(|value| !value.as_os_str().is_empty()) {
            tracked_directories.insert(directory.to_string_lossy().into_owned());
            parent = directory.parent();
        }
    }
    let mut outputs = Vec::new();
    let mut pending = vec![String::new()];
    while let Some(prefix) = pending.pop() {
        check_cancelled(cancel)?;
        let directory = if prefix.is_empty() {
            tree.to_owned()
        } else {
            tree.join(&prefix)
        };
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let name = entry.file_name().into_string().map_err(|_| {
                SetupFailed("Workspace setup created a path that is not UTF-8".into())
            })?;
            if prefix.is_empty() && name == ".git" {
                continue;
            }
            let path = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            if entries.contains_key(&path) {
                continue;
            }
            if tracked_directories.contains(&path) && entry.file_type()?.is_dir() {
                pending.push(path);
                continue;
            }
            paths::validate_repo_path(&path)?;
            outputs.push(path);
            ensure!(
                outputs.len() <= MAX_OUTPUTS,
                "Workspace setup created more than {MAX_OUTPUTS} top-level outputs"
            );
        }
    }
    outputs.sort();
    Ok(outputs)
}

/// Gives every regular file under `path` that has another hard link its own copy, replacing the
/// name rather than writing through it. Symlinks are never followed. Sockets, pipes, and devices
/// are removed: a checkout holds none.
fn replace_hard_links(path: &Path, cancel: &CancellationToken) -> Result<()> {
    check_cancelled(cancel)?;
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() {
        for entry in fs::read_dir(path)? {
            replace_hard_links(&entry?.path(), cancel)?;
        }
    } else if metadata.is_file() && metadata.nlink() > 1 {
        let name = path.file_name().context("setup output has no name")?;
        let mut copy = name.to_owned();
        copy.push(".supertag-copy");
        let copy = path.with_file_name(copy);
        let copied = (|| {
            let mut input = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(path)?;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&copy)?;
            std::io::copy(&mut input, &mut output)?;
            output.set_permissions(fs::Permissions::from_mode(metadata.mode() & 0o7777))?;
            fs::rename(&copy, path)
        })();
        if let Err(error) = copied {
            let _ = fs::remove_file(&copy);
            return Err(error.into());
        }
    } else if !metadata.is_file() && !metadata.is_symlink() {
        fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn setup_that_overruns_its_limit_fails_and_leaves_no_process() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("survivor");
        let command = format!("(sleep 1; touch '{}') & sleep 30", marker.display());
        let started = std::time::Instant::now();
        let error = execute(
            directory.path(),
            directory.path(),
            &command,
            Duration::from_millis(200),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(10));
        let failed = error
            .downcast_ref::<SetupFailed>()
            .expect("a setup failure");
        assert!(failed.0.contains("did not finish within"), "{}", failed.0);
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert!(!marker.exists(), "a setup process outlived its limit");
    }

    #[test]
    fn commands_are_bounded() {
        assert!(validate_command("npm ci").is_ok());
        assert!(validate_command(" ").is_err());
        assert!(validate_command(&"x".repeat(MAX_SETUP_COMMAND_BYTES + 1)).is_err());
    }
}
