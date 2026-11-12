//! Portable, bounded transfer of an accepted checkout. This is a data format,
//! not an instruction to extract an arbitrary archive or adopt remote Git state.
//!
//! Return format: `STWTREE1\n`, a four-byte big-endian manifest length, a UTF-8
//! JSON object `{ "entries": [{ "path", "mode", "size" }] }`, then concatenated
//! entry bodies. Entries are strictly sorted by UTF-8 path bytes. Modes are
//! `100644`, `100755`, or `120000` (a UTF-8 relative link target as its body).
//! Directories are implicit; `.git` is forbidden in every path component.
//! The whole file is at most 256 MiB, manifest 16 MiB, regular file 64 MiB,
//! 100,000 entries, and 128 directory components. No compression is accepted.

use super::*;
use std::os::unix::fs::{PermissionsExt, symlink};

const MAGIC: &[u8] = b"STWTREE1\n";
const MAX_ARCHIVE: usize = 268_435_456;
const MAX_MANIFEST: usize = 16_777_216;
const MAX_FILE: u64 = 67_108_864;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct TransferArtifact {
    pub path: PathBuf,
    pub sha256: String,
    pub byte_length: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PreparedExport {
    pub checkout: Checkout,
    pub bundle: TransferArtifact,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    entries: Vec<Entry>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    path: String,
    mode: String,
    size: u64,
}
struct ParsedTree<'a> {
    entries: Vec<(Entry, &'a [u8])>,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
struct RestoreRecord {
    checkout: Checkout,
    sha256: String,
    byte_length: u64,
}

impl Workspace {
    /// Export exactly the prepared starting commit, including runtime-only parent
    /// history. Never consult the writable checkout's Git metadata or source HEAD.
    pub async fn export_prepared(
        &self,
        checkout: &Checkout,
        cancel: &CancellationToken,
    ) -> Result<PreparedExport> {
        check_cancelled(cancel)?;
        let _guard = self.inner.gate.lock().await;
        check_cancelled(cancel)?;
        let record = self.transfer_record(checkout)?;
        let path = record.join("export.bundle");
        if let Some(prior) = read_json::<PreparedExport>(&record.join("export.json"))? {
            ensure!(
                prior.checkout == *checkout && prior.bundle.path == path,
                "export differs from preparation"
            );
            verify_export(&prior)?;
            return Ok(prior);
        }
        let staging = tempfile::tempdir_in(self.inner.root.join("temporary"))?;
        let bundle = staging.path().join("prepared.bundle");
        let repository = self.repository(cancel).await?;
        repository
            .bundle(
                &checkout.start_commit,
                &identity(&checkout.task_id, &checkout.attempt_id),
                &bundle,
                cancel,
            )
            .await?;
        let bytes = paths::read_regular(&bundle, MAX_ARCHIVE)?;
        File::open(&bundle)?.sync_all()?;
        check_cancelled(cancel)?;
        fs::rename(&bundle, &path)?;
        File::open(&record)?.sync_all()?;
        let exported = PreparedExport {
            checkout: checkout.clone(),
            bundle: TransferArtifact {
                path,
                sha256: sha256(&bytes),
                byte_length: bytes.len() as u64,
            },
        };
        verify_export(&exported)?;
        atomic_json(&record.join("export.json"), &exported)?;
        Ok(exported)
    }

    /// Restore one immutable returned tree after the caller confirms remote
    /// execution stopped. Authority and provider cleanup are the Host's job.
    /// Validation and private staging precede replacement. A durable intent makes
    /// either interrupted rename safely resumable without the original input file.
    pub async fn restore_tree(
        &self,
        checkout: &Checkout,
        archive: &TransferArtifact,
        cancel: &CancellationToken,
    ) -> Result<()> {
        check_cancelled(cancel)?;
        let _guard = self.inner.gate.lock().await;
        check_cancelled(cancel)?;
        let directory = self.transfer_record(checkout)?;
        let record = RestoreRecord {
            checkout: checkout.clone(),
            sha256: archive.sha256.clone(),
            byte_length: archive.byte_length,
        };
        let intent = directory.join("restore.json");
        let stored_archive = directory.join("return.tree");
        if let Some(prior) = read_json::<RestoreRecord>(&intent)? {
            ensure!(
                prior == record,
                "Attempt already accepted a different returned tree"
            );
            if let Some(done) = read_json::<RestoreRecord>(&directory.join("restored.json"))? {
                ensure!(
                    done == record,
                    "restored receipt differs from accepted tree"
                );
                // Exact replay is metadata-only after completion; never overwrite
                // later local work or require a now-removed source transfer file.
                remove_backup(&directory)?;
                return Ok(());
            }
        } else {
            ensure!(
                read_json::<Finalization>(&directory.join("finalize.json"))?.is_none(),
                "cannot restore a finalized checkout"
            );
            let bytes = read_artifact(archive)?;
            let tree = parse_tree(&bytes)?;
            let staging = tempfile::tempdir_in(self.inner.root.join("temporary"))?;
            materialize(staging.path(), &tree, cancel)?;
            self.repository(cancel)
                .await?
                .checkout_metadata(staging.path(), &checkout.start_commit, cancel)
                .await?;
            paths::sync_tree(staging.path())?;
            verify_tree(staging.path(), &tree, cancel)?;
            let stage = directory.join("return-checkout");
            if fs::symlink_metadata(&stage).is_ok() {
                paths::remove_owned_directory(&stage)?;
            }
            fs::rename(staging.path(), &stage)?;
            let mut file = NamedTempFile::new_in(&directory)?;
            file.write_all(&bytes)?;
            file.as_file().sync_all()?;
            file.persist(&stored_archive)?;
            File::open(&directory)?.sync_all()?;
            check_cancelled(cancel)?;
            atomic_json(&intent, &record)?;
        }
        let bytes = read_artifact(&TransferArtifact {
            path: stored_archive,
            sha256: record.sha256.clone(),
            byte_length: record.byte_length,
        })?;
        let tree = parse_tree(&bytes)?;
        resume_replace(&directory, checkout, &tree, cancel)?;
        atomic_json(&directory.join("restored.json"), &record)?;
        remove_backup(&directory)?;
        Ok(())
    }

    fn transfer_record(&self, checkout: &Checkout) -> Result<PathBuf> {
        let id = identity(&checkout.task_id, &checkout.attempt_id);
        ensure!(
            checkout.path == self.inner.root.join("checkouts").join(&id)
                && checkout.base_commit == self.inner.config.base_commit,
            "checkout does not belong to this workspace state"
        );
        let directory = self.inner.root.join("records").join(id);
        let preparation: Preparation =
            read_json(&directory.join("prepare.json"))?.context("checkout has no preparation")?;
        ensure!(
            preparation.ready && preparation.checkout == *checkout,
            "checkout differs from accepted preparation"
        );
        Ok(directory)
    }
}

fn read_artifact(artifact: &TransferArtifact) -> Result<Vec<u8>> {
    ensure!(
        artifact.byte_length <= MAX_ARCHIVE as u64,
        "transfer exceeds 256 MiB"
    );
    ensure!(
        artifact.sha256.len() == 64
            && artifact
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "invalid transfer digest"
    );
    let bytes = paths::read_regular(&artifact.path, MAX_ARCHIVE)?;
    ensure!(
        bytes.len() as u64 == artifact.byte_length && sha256(&bytes) == artifact.sha256,
        "transfer differs from its receipt"
    );
    Ok(bytes)
}

fn verify_export(exported: &PreparedExport) -> Result<()> {
    let bytes = read_artifact(&exported.bundle)?;
    verify_bundle_head(
        &bytes,
        &exported.checkout.start_commit,
        &format!(
            "refs/heads/supertag-deliveries/{}",
            identity(&exported.checkout.task_id, &exported.checkout.attempt_id)
        ),
    )
}

fn parse_tree(bytes: &[u8]) -> Result<ParsedTree<'_>> {
    ensure!(
        bytes.len() <= MAX_ARCHIVE && bytes.starts_with(MAGIC),
        "unsupported tree transfer"
    );
    let length = bytes
        .get(MAGIC.len()..MAGIC.len() + 4)
        .context("truncated tree header")?;
    let length = u32::from_be_bytes(length.try_into()?) as usize;
    ensure!(length <= MAX_MANIFEST, "tree manifest exceeds 16 MiB");
    let mut offset = MAGIC.len() + 4 + length;
    let manifest: Manifest = serde_json::from_slice(
        bytes
            .get(MAGIC.len() + 4..offset)
            .context("truncated tree manifest")?,
    )?;
    ensure!(
        manifest.entries.len() <= 100_000,
        "tree entry limit exceeded"
    );
    let mut prior: Option<String> = None;
    let mut paths_seen = BTreeSet::new();
    let mut entries = Vec::with_capacity(manifest.entries.len());
    for entry in manifest.entries {
        paths::validate_repo_path(&entry.path)?;
        ensure!(
            entry.path.split('/').count() <= 129,
            "tree nesting limit exceeded"
        );
        ensure!(
            prior.as_ref().is_none_or(|p| p < &entry.path),
            "tree entries are not strictly ordered"
        );
        let mut prefix = entry.path.as_str();
        while let Some((parent, _)) = prefix.rsplit_once('/') {
            ensure!(!paths_seen.contains(parent), "tree paths overlap");
            prefix = parent;
        }
        ensure!(
            matches!(entry.mode.as_str(), "100644" | "100755" | "120000"),
            "unsupported tree entry mode"
        );
        ensure!(entry.size <= MAX_FILE, "tree file exceeds 64 MiB");
        let size = usize::try_from(entry.size)?;
        let end = offset.checked_add(size).context("tree size overflow")?;
        let body = bytes.get(offset..end).context("truncated tree payload")?;
        if entry.mode == "120000" {
            paths::validate_link(&entry.path, body)?;
        }
        prior = Some(entry.path.clone());
        paths_seen.insert(entry.path.clone());
        entries.push((entry, body));
        offset = end;
    }
    ensure!(offset == bytes.len(), "tree has trailing payload");
    Ok(ParsedTree { entries })
}

fn materialize(root: &Path, tree: &ParsedTree<'_>, cancel: &CancellationToken) -> Result<()> {
    for (entry, body) in &tree.entries {
        check_cancelled(cancel)?;
        let path = root.join(&entry.path);
        paths::create_private_root(path.parent().context("tree file has no parent")?)?;
        if entry.mode == "120000" {
            symlink(std::str::from_utf8(body)?, path)?;
        } else {
            write_synced(&path, body)?;
            fs::set_permissions(
                path,
                fs::Permissions::from_mode(if entry.mode == "100755" { 0o755 } else { 0o644 }),
            )?;
        }
    }
    Ok(())
}

fn verify_tree(root: &Path, tree: &ParsedTree<'_>, cancel: &CancellationToken) -> Result<()> {
    ensure!(
        paths::scan(root, cancel)?.len() == tree.entries.len(),
        "restored tree differs from manifest"
    );
    for (entry, body) in &tree.entries {
        check_cancelled(cancel)?;
        let captured = paths::read_checkout_file(root, &entry.path)?;
        ensure!(
            captured.mode == entry.mode && captured.bytes == *body,
            "restored entry differs from manifest"
        );
    }
    Ok(())
}

fn resume_replace(
    directory: &Path,
    checkout: &Checkout,
    tree: &ParsedTree<'_>,
    cancel: &CancellationToken,
) -> Result<()> {
    check_cancelled(cancel)?;
    let stage = directory.join("return-checkout");
    let backup = directory.join("replaced-checkout");
    if fs::symlink_metadata(&stage).is_ok() {
        paths::verify_directory(&stage)?;
        verify_tree(&stage, tree, cancel)?;
        if fs::symlink_metadata(&checkout.path).is_ok() {
            ensure!(
                fs::symlink_metadata(&backup).is_err(),
                "replacement backup already exists"
            );
            paths::verify_directory(&checkout.path)?;
            fs::rename(&checkout.path, &backup)?;
            File::open(checkout.path.parent().context("checkout parent missing")?)?.sync_all()?;
            File::open(directory)?.sync_all()?;
        } else {
            paths::verify_directory(&backup)?;
        }
        // Once the old checkout moves, complete the bounded rename sequence even
        // if cancellation arrives. The durable intent permits crash recovery.
        fs::rename(stage, &checkout.path)?;
        File::open(checkout.path.parent().context("checkout parent missing")?)?.sync_all()?;
        File::open(directory)?.sync_all()?;
    }
    paths::verify_directory(&checkout.path)?;
    verify_tree(&checkout.path, tree, cancel)
}

fn remove_backup(directory: &Path) -> Result<()> {
    let backup = directory.join("replaced-checkout");
    if fs::symlink_metadata(&backup).is_ok() {
        paths::remove_owned_directory(&backup)?;
        File::open(directory)?.sync_all()?;
    }
    Ok(())
}

pub(super) fn require_restored(directory: &Path) -> Result<()> {
    if let Some(intent) = read_json::<RestoreRecord>(&directory.join("restore.json"))? {
        ensure!(
            read_json::<RestoreRecord>(&directory.join("restored.json"))?.as_ref() == Some(&intent),
            "workspace tree replacement needs recovery"
        );
    }
    Ok(())
}

pub(super) fn discard_staging(directory: &Path) -> Result<()> {
    // The caller already matched the exact preparation to the owned checkout.
    // Only these fixed private transfer paths are disposable; published delivery
    // artifacts and JSON receipts retain their independent lifetime.
    paths::verify_directory(directory)?;
    for name in ["return-checkout", "replaced-checkout"] {
        let path = directory.join(name);
        if fs::symlink_metadata(&path).is_ok() {
            paths::remove_owned_directory(&path)?;
        }
    }
    for name in ["return.tree", "export.bundle"] {
        // unlink never follows a substituted leaf symlink. Missing files are
        // normal after interrupted preparation or a prior terminal cleanup.
        match fs::remove_file(directory.join(name)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    File::open(directory)?.sync_all()?;
    Ok(())
}
