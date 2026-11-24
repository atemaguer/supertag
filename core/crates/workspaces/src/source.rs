//! A credential-free, verified Git source boundary shared by Gateways and Hosts.
use super::*;

const MAX_SOURCE_BYTES: usize = 268_435_456;

fn root(directory: &Path) -> Result<(PathBuf, ExclusiveLock)> {
    let directory = paths::planned_path(directory)?;
    paths::create_private_root(&directory)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(directory.join("source.lock"))?;
    let lock =
        ExclusiveLock::try_acquire(lock).context("another process is preparing this source")?;
    Ok((directory, lock))
}

/// Capture only the pinned commit's reachable objects; local dirty files, refs,
/// hooks, credential helpers and unrelated source objects are never included.
pub async fn capture(
    directory: &Path,
    source: &Path,
    commit: &str,
    cancel: &CancellationToken,
) -> Result<TransferArtifact> {
    check_cancelled(cancel)?;
    git::validate_oid(commit)?;
    let (directory, _lock) = root(directory)?;
    let source = source.canonicalize()?;
    ensure!(
        !directory.starts_with(&source) && !source.starts_with(&directory),
        "source capture must use separate private state"
    );
    // The bundle goes to other hosts as the commit's whole history.
    let repository = git::Repository::open(
        &directory,
        &source,
        commit,
        git::ShallowSource::Refused,
        cancel,
    )
    .await?;
    let file = directory.join("source.bundle");
    let id = format!("source-{commit}");
    repository.bundle(commit, &id, &file, cancel).await?;
    let bytes = paths::read_regular(&file, MAX_SOURCE_BYTES)?;
    File::open(&file)?.sync_all()?;
    repository.sync()?;
    Ok(TransferArtifact {
        path: file,
        sha256: sha256(&bytes),
        byte_length: bytes.len() as u64,
    })
}

/// Materialize a received source as a private bare repository, retaining the
/// original commit ID. This never updates a Session head or changes a checkout.
pub async fn materialize(
    directory: &Path,
    artifact: &TransferArtifact,
    commit: &str,
    cancel: &CancellationToken,
) -> Result<PathBuf> {
    check_cancelled(cancel)?;
    git::validate_oid(commit)?;
    let bytes = paths::read_regular(&artifact.path, MAX_SOURCE_BYTES)?;
    ensure!(
        bytes.len() as u64 == artifact.byte_length && sha256(&bytes) == artifact.sha256,
        "source bundle differs from its transfer receipt"
    );
    let (directory, _lock) = root(directory)?;
    let identity = directory.join("source.json");
    if let Some(prior) = read_json::<String>(&identity)? {
        ensure!(
            prior == commit,
            "source state belongs to another pinned commit"
        );
    }
    let repository = git::Repository::empty(&directory, commit.len())?;
    if repository.verify_commit(commit, cancel).await.is_err() {
        check_cancelled(cancel)?;
        let mut copy = NamedTempFile::new_in(&directory)?;
        copy.write_all(&bytes)?;
        copy.flush()?;
        repository
            .import_bundle(copy.path(), commit, None, cancel)
            .await?;
        repository.sync()?;
    }
    atomic_json(&identity, &commit)?;
    Ok(repository.path().to_owned())
}

/// A delivered Session's patch, `start..head`, from a complete bundle of `head` materialized in
/// `directory`: the same `git diff` the delivering Worker Host recorded, so the caller checks it
/// against the delivery's patch receipt.
pub async fn delivery_patch(
    directory: &Path,
    artifact: &TransferArtifact,
    start: &str,
    head: &str,
    cancel: &CancellationToken,
) -> Result<Vec<u8>> {
    git::validate_oid(start)?;
    materialize(directory, artifact, head, cancel).await?;
    let (directory, _lock) = root(directory)?;
    git::Repository::empty(&directory, head.len())?
        .patch(start, head, cancel)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn released_source_lock_is_immediately_reacquirable_while_children_spawn() -> Result<()> {
        let state = tempfile::tempdir()?;
        let directory = state.path().join("source");
        crate::lock::tests::while_children_spawn(|| {
            (0..2_000).try_for_each(|_| root(&directory).map(drop))
        })
    }
}
