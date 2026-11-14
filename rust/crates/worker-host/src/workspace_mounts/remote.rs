//! Copies for a remote Workspace. The Worker Host stages each copy on the host
//! exactly as for a local Task, with its Volume credential, then uploads the
//! staged files into the sandbox beside the checkout; no key enters the
//! sandbox. After a successful Attempt, a read-write copy's changed and created
//! files come back into the host copy, and the provider's listing is journaled,
//! so the usual bounded, journaled write-back runs on the host.
use super::*;
use tokio::sync::mpsc::Receiver;

/// One staged copy and every file it holds.
pub(crate) struct RemoteCopy {
    pub(crate) index: usize,
    pub(super) name: String,
    pub(super) destination: PathBuf,
    pub(super) tree: Identity,
    pub(crate) read_write: bool,
    pub(crate) max_bytes: u64,
    pub(crate) files: Vec<Copied>,
}

impl RemoteCopy {
    /// The copy's path relative to the remote checkout.
    pub(crate) fn sandbox_path(&self, attempt: &str) -> String {
        format!(
            "{}/{}",
            supertag_protocol::workspace_mounts::remote_copy_root(attempt),
            self.name
        )
    }

    /// The published copy, only while it is still the tree this Attempt staged.
    pub(crate) fn reader(&self) -> Result<CopyReader> {
        let directory = open_directory(&self.destination)?;
        ensure!(
            identity(&directory)? == self.tree,
            "Workspace copy changed before its upload"
        );
        Ok(CopyReader { directory })
    }
}

pub(crate) struct CopyReader {
    directory: File,
}

impl CopyReader {
    /// One staged file, opened without following links and checked against its record.
    pub(crate) fn open(&self, file: &Copied) -> Result<File> {
        writes::open_copied(&self.directory, file)
    }
}

/// What the provider listed in a read-write copy: its changed and created
/// files, the entries it skipped, and the first entry that refuses the copy.
#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(deny_unknown_fields)]
pub(crate) struct RemoteListing {
    pub(crate) files: Vec<Copied>,
    pub(crate) skipped: u64,
    pub(crate) refusal: Option<(String, String)>,
}

impl RemoteListing {
    /// Whether write-back needs the changed files' bytes: nothing refuses the copy.
    pub(crate) fn writable(&self, max_bytes: u64) -> bool {
        let mut changed = self.files.clone();
        changed.sort_unstable_by(|a, b| a.key.cmp(&b.key));
        self.refusal.is_none() && writes::bounds(&changed, max_bytes).is_none()
    }
}

fn remote_name(index: usize) -> String {
    format!("{index}.remote")
}

/// Journal the provider's listing of copy `index`. Write-back uses it in place
/// of walking the host copy.
pub(crate) fn record_remote(
    state: &Path,
    attempt: &str,
    index: usize,
    listing: &RemoteListing,
) -> Result<()> {
    let receipts = journal_directory(state, attempt)?;
    private(&open_directory(&receipts)?)?;
    let mut temp = tempfile::NamedTempFile::new_in(&receipts)?;
    serde_json::to_writer(&mut temp, listing)?;
    temp.as_file().sync_all()?;
    temp.persist(receipts.join(remote_name(index)))?;
    File::open(&receipts)?.sync_all()?;
    Ok(())
}

pub(super) fn read_remote(receipts: &File, index: usize) -> Result<Option<RemoteListing>> {
    let name = remote_name(index);
    if stat_at(receipts, &name)?.is_none() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_slice(&read_regular_at(
        receipts,
        &name,
        32 * 1024 * 1024,
    )?)?))
}

/// The host copy a read-write remote copy's captured files replace files in.
pub(crate) struct RemoteWriter {
    copy: File,
}

/// Open this Attempt's host copy `index`, proving it is still the copy it staged.
pub(crate) fn remote_writer(
    mounts: &WorkspaceMounts,
    state: &Path,
    attempt: &str,
    index: usize,
) -> Result<RemoteWriter> {
    let receipts = journal_directory(state, attempt)?;
    let directory = open_directory(&receipts)?;
    private(&directory)?;
    let receipt = format!("{index}.json");
    let entry = read_receipt(&directory, &receipt)?;
    ensure!(entry.read_write, "Workspace copy is read-only");
    let mapping = mounts
        .mappings
        .get(&entry.volume_id)
        .filter(|mapping| mapping.capability.source == entry.source)
        .context("Workspace Volume mapping changed before capture")?;
    let root = mapping.open_root()?;
    ensure!(
        identity(&root)? == (entry.root_device, entry.root_inode),
        "Workspace mount root was replaced"
    );
    let name = file_name(&entry.destination)?;
    ensure!(
        owned(
            &root,
            name,
            &entry.token,
            false,
            read_tree(&directory, &receipt)
        )?,
        "Workspace copy is not this Attempt's"
    );
    Ok(RemoteWriter {
        copy: open_dir_at(&root, name)?,
    })
}

impl RemoteWriter {
    /// Replace or create `file` with exactly its bytes from `chunks`, checked
    /// against its SHA-256 before it is renamed into place.
    pub(crate) fn write(&self, file: &Copied, chunks: &mut Receiver<Vec<u8>>) -> Result<()> {
        ensure!(
            volume_key(&file.key),
            "remote Workspace copy returned an unsupported file name"
        );
        let parts: Vec<&str> = file.key.split('/').collect();
        let (name, parents) = parts.split_last().context("empty key")?;
        ensure!(
            parents.len() <= MAX_DEPTH,
            "remote Workspace copy nests directories too deeply"
        );
        let mut directory = self.copy.try_clone()?;
        for part in parents {
            directory = match open_dir_at(&directory, part) {
                Ok(next) => next,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    mkdir_at(&directory, part)?;
                    open_dir_at(&directory, part)?
                }
                Err(error) => return Err(error.into()),
            };
        }
        let temp = format!("{STAGING_PREFIX}capture");
        unlink_at(&directory, &temp, 0)?;
        let result = (|| -> Result<()> {
            let mut output = create_at(&directory, &temp, 0o600)?;
            let mut hash = Sha256::new();
            let mut total = 0u64;
            while total < file.size {
                let bytes = chunks
                    .blocking_recv()
                    .context("remote Workspace copy ended early")?;
                total += bytes.len() as u64;
                ensure!(
                    !bytes.is_empty() && total <= file.size,
                    "remote Workspace copy differs from its listing"
                );
                hash.update(&bytes);
                output.write_all(&bytes)?;
            }
            ensure!(
                format!("{:x}", hash.finalize()) == file.sha256,
                "remote Workspace copy differs from its listing"
            );
            flush(&output)?;
            match stat_at(&directory, name)? {
                Some(mode) if is_directory(mode) => bail!("a directory is in the way"),
                Some(_) => unlink_at(&directory, name, 0)?,
                None => {}
            }
            let from = c_name(&temp)?;
            let to = c_name(name)?;
            let fd = directory.as_raw_fd();
            if unsafe { libc::renameat(fd, from.as_ptr(), fd, to.as_ptr()) } != 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            directory.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = unlink_at(&directory, &temp, 0);
        }
        result
    }
}
