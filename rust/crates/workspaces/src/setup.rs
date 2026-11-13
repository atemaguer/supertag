//! A Workspace's `setup` command: one operator-chosen shell command, such as `npm ci`, that
//! prepares each Task checkout. As in TypeScript, it runs on the Worker Host outside any harness
//! sandbox, only on the Workspace's base commit, in its own temporary directory, and again only
//! when the base commit or the command changes. Its ignored outputs, such as `node_modules/`,
//! are copied into each Task checkout as private files, so a hard link into a package store never
//! lets a Task change the store.
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, DirBuilder, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Component, Path, PathBuf},
    process::Stdio,
};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use tokio::{io::AsyncReadExt, process::Command};
use tokio_util::sync::CancellationToken;

use crate::{atomic_json, check_cancelled, git, paths, read_json, sha256};

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
/// Setup output kept in a failed Task's result.
const OUTPUT_TAIL_BYTES: usize = 4096;
/// Top-level setup outputs, and files copied into one checkout.
const MAX_OUTPUTS: usize = 10_000;
const MAX_COPIED_ENTRIES: usize = 500_000;
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

#[derive(Deserialize, Serialize)]
struct Ready {
    command: String,
    /// Untracked top-level setup outputs, relative to the base checkout.
    outputs: Vec<String>,
}

/// The base checkout with `command`'s outputs, running it first when this base commit has not
/// run this command yet.
pub(crate) async fn prepared(
    root: &Path,
    repository: &git::Repository,
    base_commit: &str,
    command: &str,
    cancel: &CancellationToken,
) -> Result<(PathBuf, Vec<String>)> {
    validate_command(command)?;
    let parent = root.join("setup");
    paths::create_private_root(&parent)?;
    let key = sha256(command.as_bytes());
    let ready_directory = parent.join(&key);
    if let Some(ready) = read_json::<Ready>(&ready_directory.join("ready.json"))?
        && ready.command == command
    {
        return Ok((ready_directory.join("tree"), ready.outputs));
    }
    // An interrupted run never becomes ready; start again from a clean base checkout.
    for entry in fs::read_dir(&parent)? {
        let path = entry?.path();
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == key || name.starts_with(&format!("{key}.run-")))
        {
            paths::remove_owned_directory(&path)?;
        }
    }
    let run = tempfile::Builder::new()
        .prefix(&format!("{key}.run-"))
        .tempdir_in(&parent)?
        .keep();
    let tree = run.join("tree");
    let entries = repository.tree(base_commit, cancel).await?;
    repository
        .checkout(&tree, base_commit, &entries, cancel)
        .await?;
    let temporary = run.join("tmp");
    DirBuilder::new().mode(0o700).create(&temporary)?;
    let outcome = execute(&tree, &temporary, command, cancel).await;
    paths::remove_owned_directory(&temporary)?;
    outcome?;
    let outputs = untracked(&tree, &entries, cancel)?;
    atomic_json(
        &run.join("ready.json"),
        &Ready {
            command: command.into(),
            outputs: outputs.clone(),
        },
    )?;
    fs::rename(&run, &ready_directory)?;
    fs::File::open(&parent)?.sync_all()?;
    Ok((ready_directory.join("tree"), outputs))
}

async fn execute(
    tree: &Path,
    temporary: &Path,
    command: &str,
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

/// Copies setup outputs into a fresh Task checkout, where nothing yet exists at their paths.
/// Returns the outputs copied. Callers keep only those Git ignores at the Task's commit.
pub(crate) fn copy_outputs(
    tree: &Path,
    outputs: &[String],
    checkout: &Path,
    cancel: &CancellationToken,
) -> Result<Vec<String>> {
    let mut copied = Vec::new();
    let mut count = 0_usize;
    for output in outputs {
        check_cancelled(cancel)?;
        let destination = checkout.join(output);
        let parent_exists = destination
            .parent()
            .is_some_and(|parent| paths::verify_directory(parent).is_ok());
        if !parent_exists || fs::symlink_metadata(&destination).is_ok() {
            continue;
        }
        copy_entry(
            &tree.join(output),
            &destination,
            checkout,
            &mut count,
            cancel,
        )?;
        copied.push(output.clone());
    }
    Ok(copied)
}

fn copy_entry(
    source: &Path,
    destination: &Path,
    checkout: &Path,
    count: &mut usize,
    cancel: &CancellationToken,
) -> Result<()> {
    check_cancelled(cancel)?;
    *count += 1;
    ensure!(
        *count <= MAX_COPIED_ENTRIES,
        "Workspace setup outputs exceed {MAX_COPIED_ENTRIES} files"
    );
    let metadata = fs::symlink_metadata(source)?;
    let file_type = metadata.file_type();
    let mode = metadata.mode() & 0o777;
    if file_type.is_dir() {
        DirBuilder::new().mode(0o700).create(destination)?;
        for entry in fs::read_dir(source)? {
            let name = entry?.file_name();
            copy_entry(
                &source.join(&name),
                &destination.join(&name),
                checkout,
                count,
                cancel,
            )?;
        }
        fs::set_permissions(destination, fs::Permissions::from_mode(mode | 0o700))?;
    } else if file_type.is_file() {
        // A new file, never a hard link: a Task's edit cannot reach a shared package store.
        let mut input = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(source)?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(destination)?;
        let mut buffer = vec![0_u8; 65_536];
        loop {
            let read = input.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            output.write_all(&buffer[..read])?;
        }
        fs::set_permissions(destination, fs::Permissions::from_mode(mode | 0o600))?;
    } else if file_type.is_symlink() {
        let target = fs::read_link(source)?;
        let relative = destination
            .strip_prefix(checkout)
            .context("setup output outside its checkout")?;
        if !stays_inside(relative, &target) {
            return Err(SetupFailed(format!(
                "Workspace setup output {} links outside the worktree",
                relative.display()
            ))
            .into());
        }
        std::os::unix::fs::symlink(&target, destination)?;
    }
    // Sockets, pipes, and devices are never copied.
    Ok(())
}

/// Whether a relative link at `path` (relative to the checkout) resolves inside the checkout.
fn stays_inside(path: &Path, target: &Path) -> bool {
    if target.is_absolute() {
        return false;
    }
    let mut depth = path.components().count().saturating_sub(1) as isize;
    for component in target.components() {
        match component {
            Component::ParentDir => depth -= 1,
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::RootDir | Component::Prefix(_) => return false,
        }
        if depth < 0 {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_must_stay_inside_the_checkout() {
        let path = Path::new("node_modules/.bin/tool");
        assert!(stays_inside(path, Path::new("../tool/bin.js")));
        assert!(stays_inside(path, Path::new("../../package.json")));
        assert!(!stays_inside(path, Path::new("../../../outside")));
        assert!(!stays_inside(path, Path::new("/etc/passwd")));
        assert!(stays_inside(Path::new("link"), Path::new("file")));
        assert!(!stays_inside(Path::new("link"), Path::new("../file")));
    }

    #[test]
    fn commands_are_bounded() {
        assert!(validate_command("npm ci").is_ok());
        assert!(validate_command(" ").is_err());
        assert!(validate_command(&"x".repeat(MAX_SETUP_COMMAND_BYTES + 1)).is_err());
    }
}
