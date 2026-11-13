//! Import a verified Workspace delivery into the operator's own repository as its Session branch.
//!
//! This runs on the operator's machine, never in a Worker Host. Before it touches the repository,
//! it checks the bundle's size and digest against the Control Plane's receipt, that the bundle
//! names exactly one ref, `refs/heads/supertag-deliveries/<delivery-id>`, at the delivered commit,
//! and has no prerequisites. It then unbundles only that ref's objects into a private quarantine,
//! checks them strictly, and confirms the commit descends from the Task's base and start commits.
//! Only a delivery that passes every check reaches the repository's objects, and only
//! `refs/heads/<branch>` moves. Hooks and
//! filesystem monitors are disabled and nothing is checked out, so no working tree filter runs.
//!
//! The branch moves only forward. It is created when missing, left alone when it already
//! contains the delivery, and fast-forwarded when it holds an earlier commit of the Session. A
//! branch someone moved anywhere else, or one checked out in a worktree, is refused unchanged.

use std::{
    ffi::OsStr,
    fmt,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail, ensure};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::{check_cancelled, git, sha256, verify_bundle_head};

/// The largest bundle an import reads, the same bound as every Workspace delivery blob.
pub const MAX_BUNDLE_BYTES: u64 = 268_435_456;
const MAX_GIT_OUTPUT: usize = 1_048_576;
const PREFIX: &str = "supertag/session/";

/// What the Control Plane accepted for one Task: its Session branch and delivery receipt.
#[derive(Clone, Debug)]
pub struct SessionDelivery {
    pub branch: String,
    pub delivery_id: String,
    pub base_commit: String,
    pub start_commit: String,
    pub head_commit: String,
    pub bundle_sha256: String,
    pub bundle_byte_length: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Imported {
    /// The branch did not exist; it now points at the delivered commit.
    Created,
    /// The branch held an earlier commit of the Session and now points at the delivered commit.
    Advanced,
    /// The branch already contains the delivered commit and was left as it is.
    Current,
}

impl Imported {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Advanced => "advanced",
            Self::Current => "current",
        }
    }
}

/// The branch holds commits this Session did not deliver, so a forward move would drop them.
#[derive(Debug)]
pub struct BranchMoved {
    pub branch: String,
    pub current: String,
    pub head: String,
}

impl fmt::Display for BranchMoved {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "branch {} was moved outside SuperTag: it points at {}, which the delivered commit {} does not continue. SuperTag left the branch unchanged; merge or reset it yourself, or delete it to let SuperTag recreate it",
            self.branch, self.current, self.head
        )
    }
}

impl std::error::Error for BranchMoved {}

/// The branch is checked out, so moving it would leave that working tree out of step.
#[derive(Debug)]
pub struct BranchCheckedOut {
    pub branch: String,
    pub worktree: PathBuf,
}

impl fmt::Display for BranchCheckedOut {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "branch {} is checked out in {}; SuperTag left it unchanged. Switch that worktree to another branch and try again",
            self.branch,
            self.worktree.display()
        )
    }
}

impl std::error::Error for BranchCheckedOut {}

/// Verify `bundle` against `delivery`, then add the delivered commit to `repository` and point
/// the Session branch at it, only forward.
pub async fn import(
    repository: &Path,
    delivery: &SessionDelivery,
    bundle: &Path,
    cancel: &CancellationToken,
) -> Result<Imported> {
    check_cancelled(cancel)?;
    validate(delivery)?;
    let reference = format!("refs/heads/supertag-deliveries/{}", delivery.delivery_id);
    ensure!(
        delivery.bundle_byte_length <= MAX_BUNDLE_BYTES,
        "delivery bundle exceeds its size limit"
    );
    let bytes = read_bundle(bundle)?;
    ensure!(
        bytes.len() as u64 == delivery.bundle_byte_length
            && sha256(&bytes) == delivery.bundle_sha256,
        "delivery bundle differs from its receipt"
    );
    verify_bundle_head(&bytes, &delivery.head_commit, &reference)?;

    let format = output(repository, &["rev-parse", "--show-object-format"], cancel).await?;
    let length = match format.as_str() {
        "sha1" => 40,
        "sha256" => 64,
        _ => bail!("repository uses an unsupported object format"),
    };
    ensure!(
        delivery.head_commit.len() == length,
        "delivered commit uses a different object format than the repository"
    );

    // Unbundle a private copy, so the verified bytes are the bytes Git reads.
    let staging = tempfile::tempdir()?;
    let copy = staging.path().join("delivery.bundle");
    std::fs::write(&copy, &bytes)?;
    drop(bytes);
    let copy = copy.to_str().context("bundle path is not UTF-8")?;
    check_cancelled(cancel)?;
    output(repository, &["bundle", "verify", "--quiet", copy], cancel).await?;

    // Every check runs on a quarantined copy of the delivered objects: Git writes them to a
    // private object directory and reads the repository's own objects through an alternate, so
    // a refused delivery leaves nothing behind in the repository.
    let objects = output(
        repository,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "objects",
        ],
        cancel,
    )
    .await?;
    let quarantine = staging.path().join("objects");
    std::fs::create_dir_all(quarantine.join("pack"))?;
    let isolated: &[(&str, &OsStr)] = &[
        ("GIT_OBJECT_DIRECTORY", quarantine.as_os_str()),
        ("GIT_ALTERNATE_OBJECT_DIRECTORIES", OsStr::new(&objects)),
    ];
    let unbundled = output_in(
        repository,
        isolated,
        &["bundle", "unbundle", copy, &reference],
        cancel,
    )
    .await?;
    ensure!(
        unbundled == format!("{} {reference}", delivery.head_commit),
        "bundle did not add exactly the delivered commit"
    );
    strict_check(repository, isolated, &quarantine, staging.path(), cancel).await?;
    ensure!(
        output_in(
            repository,
            isolated,
            &["cat-file", "-t", &delivery.head_commit],
            cancel
        )
        .await?
            == "commit",
        "delivered object is not a commit"
    );
    for (ancestor, what) in [
        (&delivery.base_commit, "base"),
        (&delivery.start_commit, "start"),
    ] {
        ensure!(
            is_ancestor(
                repository,
                isolated,
                ancestor,
                &delivery.head_commit,
                cancel
            )
            .await?,
            "delivered commit does not descend from the Task's {what} commit"
        );
    }

    // Verified: add the same bytes to the repository itself.
    check_cancelled(cancel)?;
    let unbundled = output(
        repository,
        &["bundle", "unbundle", copy, &reference],
        cancel,
    )
    .await?;
    ensure!(
        unbundled == format!("{} {reference}", delivery.head_commit),
        "bundle did not add exactly the delivered commit"
    );

    let full = format!("refs/heads/{}", delivery.branch);
    let current = status(repository, &["rev-parse", "-q", "--verify", &full], cancel)
        .await?
        .map(|value| value.trim().to_owned());
    let head = &delivery.head_commit;
    let (outcome, old) = match &current {
        None => (Imported::Created, "0".repeat(length)),
        Some(current) if current == head => return Ok(Imported::Current),
        Some(current) if is_ancestor(repository, &[], head, current, cancel).await? => {
            return Ok(Imported::Current);
        }
        // Only an earlier commit of this Session moves forward: one after the base that the
        // delivered commit continues. A branch reset to the base or elsewhere was moved by a
        // person, and stays where they put it.
        Some(current)
            if current != &delivery.base_commit
                && is_ancestor(repository, &[], &delivery.base_commit, current, cancel).await?
                && is_ancestor(repository, &[], current, head, cancel).await? =>
        {
            (Imported::Advanced, current.clone())
        }
        Some(current) => {
            return Err(BranchMoved {
                branch: delivery.branch.clone(),
                current: current.clone(),
                head: head.clone(),
            }
            .into());
        }
    };
    if let Some(worktree) = checked_out(repository, &full, cancel).await? {
        return Err(BranchCheckedOut {
            branch: delivery.branch.clone(),
            worktree,
        }
        .into());
    }
    check_cancelled(cancel)?;
    // The old value makes this a compare-and-swap with any concurrent move.
    let message = format!("supertag: Session delivery {}", delivery.delivery_id);
    match output(
        repository,
        &["update-ref", "-m", &message, &full, head, &old],
        cancel,
    )
    .await
    {
        Ok(_) => Ok(outcome),
        Err(error) => {
            let now = status(repository, &["rev-parse", "-q", "--verify", &full], cancel)
                .await?
                .map(|value| value.trim().to_owned());
            if now.as_deref() == Some(head.as_str()) {
                return Ok(Imported::Current);
            }
            if let Some(now) = now
                && now != old
            {
                return Err(BranchMoved {
                    branch: delivery.branch.clone(),
                    current: now,
                    head: head.clone(),
                }
                .into());
            }
            Err(error)
        }
    }
}

/// Read one regular file, not through a final symbolic link, up to the bundle limit.
fn read_bundle(path: &Path) -> Result<Vec<u8>> {
    use std::{io::Read as _, os::unix::fs::OpenOptionsExt as _};
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .context("open delivery bundle")?;
    ensure!(
        file.metadata()?.is_file(),
        "delivery bundle is not a regular file"
    );
    let mut bytes = Vec::new();
    file.take(MAX_BUNDLE_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_BUNDLE_BYTES,
        "delivery bundle exceeds its size limit"
    );
    Ok(bytes)
}

fn validate(delivery: &SessionDelivery) -> Result<()> {
    let suffix = delivery
        .branch
        .strip_prefix(PREFIX)
        .context("Session branch must start with supertag/session/")?;
    ensure!(
        !suffix.is_empty()
            && suffix.len() <= 64
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "invalid Session branch name"
    );
    ensure!(
        delivery.delivery_id.len() == 64
            && delivery
                .delivery_id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "invalid delivery ID"
    );
    ensure!(
        delivery.bundle_sha256.len() == 64
            && delivery
                .bundle_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "invalid bundle digest"
    );
    for commit in [
        &delivery.base_commit,
        &delivery.start_commit,
        &delivery.head_commit,
    ] {
        git::validate_oid(commit)?;
        ensure!(
            commit.len() == delivery.base_commit.len(),
            "delivery commits use different object formats"
        );
    }
    ensure!(
        delivery.head_commit != delivery.base_commit,
        "the delivery has no commits after its base"
    );
    Ok(())
}

/// Strictly check every object the quarantined unbundle wrote, including the links between them.
/// `git bundle unbundle` indexes the pack without checking objects, so this is the only check.
async fn strict_check(
    repository: &Path,
    isolated: &[(&str, &OsStr)],
    quarantine: &Path,
    scratch: &Path,
    cancel: &CancellationToken,
) -> Result<()> {
    // The unbundle always writes one pack; any loose object or other file is unexpected.
    for entry in std::fs::read_dir(quarantine)? {
        let entry = entry?;
        ensure!(
            entry.file_name() == "pack" || entry.file_name() == "info",
            "delivery bundle wrote unexpected objects"
        );
    }
    let mut packs = 0;
    for entry in std::fs::read_dir(quarantine.join("pack"))? {
        let path = entry?.path();
        if path.extension() != Some(OsStr::new("pack")) {
            continue;
        }
        packs += 1;
        let index = scratch.join(format!("strict-{packs}.idx"));
        let (Some(pack), Some(index)) = (path.to_str(), index.to_str()) else {
            bail!("pack path is not UTF-8");
        };
        output_in(
            repository,
            isolated,
            &["index-pack", "--strict", "-o", index, pack],
            cancel,
        )
        .await
        .context("delivery bundle contains malformed objects")?;
    }
    ensure!(packs == 1, "delivery bundle did not unbundle to one pack");
    Ok(())
}

async fn is_ancestor(
    repository: &Path,
    environment: &[(&str, &OsStr)],
    ancestor: &str,
    descendant: &str,
    cancel: &CancellationToken,
) -> Result<bool> {
    Ok(status_in(
        repository,
        environment,
        &["merge-base", "--is-ancestor", ancestor, descendant],
        cancel,
    )
    .await?
    .is_some())
}

/// The worktree that has `reference` checked out, if any.
async fn checked_out(
    repository: &Path,
    reference: &str,
    cancel: &CancellationToken,
) -> Result<Option<PathBuf>> {
    let listing = output(
        repository,
        &["worktree", "list", "--porcelain", "-z"],
        cancel,
    )
    .await?;
    let mut worktree = None;
    for field in listing.split('\0') {
        if let Some(path) = field.strip_prefix("worktree ") {
            worktree = Some(PathBuf::from(path));
        } else if field.strip_prefix("branch ") == Some(reference) {
            return Ok(Some(worktree.unwrap_or_else(|| repository.to_owned())));
        }
    }
    Ok(None)
}

/// Run Git in the operator's repository; exit status 1 is `None`.
async fn status(
    repository: &Path,
    args: &[&str],
    cancel: &CancellationToken,
) -> Result<Option<String>> {
    status_in(repository, &[], args, cancel).await
}

/// Like [`status`], with extra environment for Git.
async fn status_in(
    repository: &Path,
    environment: &[(&str, &OsStr)],
    args: &[&str],
    cancel: &CancellationToken,
) -> Result<Option<String>> {
    match git::run(
        command(repository, environment, args),
        &[],
        cancel,
        MAX_GIT_OUTPUT,
        git::COMMAND_TIMEOUT,
    )
    .await
    {
        Ok(bytes) => Ok(Some(String::from_utf8(bytes)?)),
        Err(error)
            if error
                .downcast_ref::<git::GitExit>()
                .is_some_and(|exit| exit.code == Some(1)) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

async fn output(repository: &Path, args: &[&str], cancel: &CancellationToken) -> Result<String> {
    output_in(repository, &[], args, cancel).await
}

/// Like [`output`], with extra environment for Git.
async fn output_in(
    repository: &Path,
    environment: &[(&str, &OsStr)],
    args: &[&str],
    cancel: &CancellationToken,
) -> Result<String> {
    let bytes = git::run(
        command(repository, environment, args),
        &[],
        cancel,
        MAX_GIT_OUTPUT,
        git::COMMAND_TIMEOUT,
    )
    .await?;
    Ok(String::from_utf8(bytes)?.trim_end_matches('\n').to_owned())
}

fn command(repository: &Path, environment: &[(&str, &OsStr)], args: &[&str]) -> Command {
    let mut command = Command::new("/usr/bin/git");
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("LANG", "C")
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        // Names the branch's reflog entry; no commit is made.
        .env("GIT_COMMITTER_NAME", "SuperTag")
        .env("GIT_COMMITTER_EMAIL", "supertag@localhost")
        .envs(environment.iter().copied())
        .arg("-C")
        .arg(repository);
    for value in [
        "core.hooksPath=/dev/null",
        "core.fsmonitor=false",
        "core.untrackedCache=false",
        "gc.auto=0",
        "maintenance.auto=false",
        "protocol.allow=never",
        "core.pager=cat",
    ] {
        command.arg("-c").arg(value);
    }
    command.args(args.iter().map(OsStr::new));
    command
}
