//! Write-back of read-write Workspace copies after a successful Attempt.
//!
//! The change set is every regular file whose size or SHA-256 differs from
//! what was staged, plus every new regular file. Links, deletions and other
//! entry types are not written. A name the Volume cannot hold, a directory
//! nested too deep, or a file with another hard link refuses the whole copy
//! rather than being dropped. Bounds are checked over the whole change set
//! before anything is written; writing then stops at the first failure. Each
//! copy's summary is journaled before it is reported, so a restarted Host
//! reports the same summary without writing again. A Host that stops while
//! writing rewrites the same change set, reusing the same temporary names.
use super::*;
use prost::Message;
use std::collections::HashMap;
use supertag_protocol::{
    v2::{WorkspaceMountWrite, WorkspaceMountWriteStatus, WorkspaceMountWrittenFile},
    workspace_mounts::MAX_WRITE_FILES,
};

/// The most entries a write-back walk visits in one copy.
const MAX_WALK: usize = 2 * MAX_ENTRIES;
/// The most summary bytes one copy's change set may need.
const MAX_SUMMARY_BYTES: usize = 256 * 1024;

struct Listing {
    files: Vec<Copied>,
    skipped: u64,
    visited: usize,
    device: u64,
    /// The first entry that refuses the copy: the nearest key the summary
    /// can name (empty for the copy root) and why.
    refusal: Option<(String, &'static str)>,
}

/// Why an entry name refuses a write-back.
const UNNAMEABLE: &str = "a file name cannot be written to the Volume";

/// Write each read-write copy of this Attempt back to its Volume, in mount
/// order, stopping after the first copy that is not complete.
pub(crate) fn write_back(
    mounts: &WorkspaceMounts,
    state: &Path,
    attempt: &str,
    cancel: &CancellationToken,
) -> Result<Vec<WorkspaceMountWrite>> {
    let receipts = journal_directory(state, attempt)?;
    let directory = match open_directory(&receipts) {
        Ok(directory) => directory,
        Err(_)
            if receipts
                .symlink_metadata()
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(vec![]);
        }
        Err(error) => return Err(error),
    };
    private(&directory)?;
    let mut indexes: Vec<usize> = directory_names(&directory, 64)?
        .iter()
        .filter_map(|name| name.strip_suffix(".json")?.parse().ok())
        .collect();
    indexes.sort_unstable();
    let mut writes = vec![];
    for index in indexes {
        let receipt = format!("{index}.json");
        let entry = read_receipt(&directory, &receipt)?;
        if !entry.read_write {
            continue;
        }
        let journaled = format!("{index}.written");
        let write = match read_regular_at(&directory, &journaled, 4 * 1024 * 1024) {
            Ok(bytes) => WorkspaceMountWrite::decode(bytes.as_slice())?,
            Err(_) if stat_at(&directory, &journaled)?.is_none() => {
                let write = mounts.write_one(&directory, index, &entry, cancel)?;
                let mut temp = tempfile::NamedTempFile::new_in(&receipts)?;
                temp.write_all(&write.encode_to_vec())?;
                temp.as_file().sync_all()?;
                temp.persist_noclobber(receipts.join(&journaled))?;
                directory.sync_all()?;
                write
            }
            Err(error) => return Err(error),
        };
        let complete = write.status == WorkspaceMountWriteStatus::Complete as i32;
        writes.push(write);
        if !complete {
            break;
        }
    }
    Ok(writes)
}

impl WorkspaceMounts {
    fn write_one(
        &self,
        receipts: &File,
        index: usize,
        entry: &Receipt,
        cancel: &CancellationToken,
    ) -> Result<WorkspaceMountWrite> {
        let mapping = self
            .mappings
            .get(&entry.volume_id)
            .filter(|mapping| mapping.capability.source == entry.source)
            .context("Workspace Volume mapping changed before write-back")?;
        let root = mapping.open_root()?;
        ensure!(
            identity(&root)? == (entry.root_device, entry.root_inode),
            "Workspace mount root was replaced"
        );
        let name = file_name(&entry.destination)?;
        let tree = read_tree(receipts, &format!("{index}.json"));
        ensure!(
            owned(&root, name, &entry.token, false, tree)?,
            "Workspace copy is not this Attempt's"
        );
        let copy = open_dir_at(&root, name)?;
        let copied: Vec<Copied> = serde_json::from_slice(&read_regular_at(
            receipts,
            &copied_name(index),
            32 * 1024 * 1024,
        )?)?;
        let staged: HashMap<&str, &Copied> = copied
            .iter()
            .map(|file| (file.key.as_str(), file))
            .collect();
        let mut listing = Listing {
            files: vec![],
            skipped: 0,
            visited: 0,
            device: copy.metadata()?.dev(),
            refusal: None,
        };
        listing.walk(&copy, "", 0, cancel)?;
        let mut changed = vec![];
        let mut skipped = listing.skipped;
        for file in listing.files {
            if staged.get(file.key.as_str()) == Some(&&file) {
                skipped += 1;
            } else {
                changed.push(file);
            }
        }
        // Written in full-key order, so the first failure is deterministic.
        changed.sort_unstable_by(|a, b| a.key.cmp(&b.key));
        let mut write = WorkspaceMountWrite {
            volume_id: entry.volume_id.clone(),
            destination: entry
                .destination
                .to_str()
                .context("Workspace mount destination is not UTF-8")?
                .into(),
            status: WorkspaceMountWriteStatus::Complete as i32,
            skipped,
            ..Default::default()
        };
        let total = changed.iter().map(|file| file.size).sum::<u64>();
        let summary = changed
            .iter()
            .map(|file| file.key.len() + 80)
            .sum::<usize>();
        let refusal = if let Some(refusal) = listing.refusal {
            Some(refusal)
        } else if let Some(file) = changed.iter().find(|file| file.size > entry.max_bytes) {
            Some((file.key.clone(), "file exceeds the copy byte limit"))
        } else if total > entry.max_bytes {
            Some((
                changed
                    .last()
                    .map(|file| file.key.clone())
                    .unwrap_or_default(),
                "change set exceeds the copy byte limit",
            ))
        } else if changed.len() > MAX_WRITE_FILES {
            Some((
                changed[MAX_WRITE_FILES].key.clone(),
                "change set exceeds 1000 files",
            ))
        } else if summary > MAX_SUMMARY_BYTES {
            Some((
                changed
                    .last()
                    .map(|file| file.key.clone())
                    .unwrap_or_default(),
                "change set summary exceeds its size limit",
            ))
        } else {
            None
        };
        if let Some((key, reason)) = refusal {
            write.status = WorkspaceMountWriteStatus::Refused as i32;
            write.not_attempted = changed
                .iter()
                .take(MAX_WRITE_FILES)
                .map(|file| file.key.clone())
                .collect();
            if !key.is_empty() && !write.not_attempted.contains(&key) {
                write.not_attempted.push(key.clone());
            }
            write.error_key = key;
            write.error_reason = reason.into();
            return Ok(write);
        }
        for (position, file) in changed.iter().enumerate() {
            let written = if cancel.is_cancelled() {
                Err(anyhow::anyhow!("cancelled"))
            } else {
                match &mapping.source {
                    Source::File(path) => self.write_file(path, &copy, file, &entry.token),
                    Source::S3(source) => write_object(source, &copy, file),
                }
            };
            match written {
                Ok(()) => write.files.push(WorkspaceMountWrittenFile {
                    key: file.key.clone(),
                    size: file.size,
                    sha256: file.sha256.clone(),
                }),
                Err(error) => {
                    supertag_protocol::terminal_text::warn(&format!(
                        "Workspace Volume {} write-back stopped: {error:#}",
                        entry.volume_id
                    ));
                    write.status = WorkspaceMountWriteStatus::Partial as i32;
                    write.error_key = file.key.clone();
                    write.error_reason = "write failed".into();
                    write.not_attempted = changed[position..]
                        .iter()
                        .map(|file| file.key.clone())
                        .collect();
                    break;
                }
            }
        }
        Ok(write)
    }

    /// Replace or create one file under a file Volume. Directories are
    /// opened without following links, must stay on the Volume's device and
    /// outside protected storage, and the file is renamed into place. The
    /// temporary name is fixed per copy and key, so a rewrite after a Host
    /// restart replaces any temporary file the interrupted write left.
    fn write_file(&self, source: &Path, copy: &File, file: &Copied, token: &str) -> Result<()> {
        let mut directory = open_directory(source)?;
        let device = directory.metadata()?.dev();
        let parts: Vec<&str> = file.key.split('/').collect();
        let (name, parents) = parts.split_last().context("empty key")?;
        for part in parents {
            directory = match open_dir_at(&directory, part) {
                Ok(next) => next,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    let raw = c_name(part)?;
                    if unsafe { libc::mkdirat(directory.as_raw_fd(), raw.as_ptr(), 0o755) } != 0 {
                        return Err(std::io::Error::last_os_error().into());
                    }
                    directory.sync_all()?;
                    open_dir_at(&directory, part)?
                }
                Err(error) => return Err(error.into()),
            };
            let found = directory.metadata()?;
            ensure!(
                found.dev() == device && !self.protected.contains(&(found.dev(), found.ino())),
                "Workspace Volume path reaches another filesystem or protected storage"
            );
        }
        let mode = match stat_at(&directory, name)? {
            Some(mode) => {
                ensure!(!is_directory(mode), "a directory is in the way");
                mode & 0o777
            }
            None => 0o644,
        };
        let mut input = open_copied(copy, file)?;
        let digest = Sha256::digest(format!("{token}\0{}", file.key).as_bytes());
        let temp = format!("{STAGING_PREFIX}write-{:x}", digest);
        match stat_at(&directory, &temp)? {
            Some(mode) if is_regular(mode) => unlink_at(&directory, &temp, 0)?,
            Some(_) => bail!("a temporary write-back path is in the way"),
            None => {}
        }
        let result = (|| -> Result<()> {
            let mut output = create_at(&directory, &temp, 0o600)?;
            let sha256 = stream(&mut input, &mut output, file.size)?;
            ensure!(
                sha256 == file.sha256,
                "copied file changed during write-back"
            );
            output.set_permissions(fs::Permissions::from_mode(mode))?;
            output.sync_all()?;
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

fn write_object(source: &s3::S3Source, copy: &File, file: &Copied) -> Result<()> {
    let mut input = open_copied(copy, file)?;
    let mut bytes = Vec::with_capacity(file.size as usize);
    let sha256 = stream(&mut input, &mut bytes, file.size)?;
    ensure!(
        sha256 == file.sha256,
        "copied file changed during write-back"
    );
    tokio::runtime::Handle::current().block_on(source.write(&file.key, bytes, &sha256))
}

fn open_copied(copy: &File, file: &Copied) -> Result<File> {
    let parts: Vec<&str> = file.key.split('/').collect();
    let (name, parents) = parts.split_last().context("empty key")?;
    let mut directory = copy.try_clone()?;
    for part in parents {
        directory = open_dir_at(&directory, part)?;
    }
    let raw = c_name(name)?;
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            raw.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let input = unsafe { File::from_raw_fd(fd) };
    let metadata = input.metadata()?;
    ensure!(
        metadata.is_file()
            && metadata.len() == file.size
            && metadata.nlink() == 1
            && metadata.dev() == copy.metadata()?.dev(),
        "copied file changed during write-back"
    );
    Ok(input)
}

/// Copy exactly `size` bytes and return their SHA-256.
fn stream(input: &mut File, output: &mut impl Write, size: u64) -> Result<String> {
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        ensure!(total <= size, "copied file changed during write-back");
        hash.update(&buffer[..count]);
        output.write_all(&buffer[..count])?;
    }
    ensure!(total == size, "copied file changed during write-back");
    Ok(format!("{:x}", hash.finalize()))
}

impl Listing {
    fn refuse(&mut self, key: &str, reason: &'static str) {
        if self.refusal.is_none() {
            self.refusal = Some((key.to_owned(), reason));
        }
    }

    fn walk(
        &mut self,
        directory: &File,
        prefix: &str,
        depth: usize,
        cancel: &CancellationToken,
    ) -> Result<()> {
        ensure!(!cancel.is_cancelled(), "Workspace write-back cancelled");
        let mut names = raw_names(directory, MAX_WALK + 1)?;
        names.sort();
        for raw in names {
            if self.refusal.is_some() {
                return Ok(());
            }
            let Ok(name) = raw.to_str() else {
                self.refuse(prefix, UNNAMEABLE);
                return Ok(());
            };
            if prefix.is_empty() && name == MARKER {
                continue;
            }
            let key = if prefix.is_empty() {
                name.to_owned()
            } else {
                format!("{prefix}/{name}")
            };
            if !volume_key(&key) {
                self.refuse(prefix, UNNAMEABLE);
                return Ok(());
            }
            self.visited += 1;
            if self.visited > MAX_WALK {
                self.refuse(&key, "the copy holds too many entries to write back");
                return Ok(());
            }
            match stat_at(directory, name)? {
                Some(mode) if is_directory(mode) => {
                    if depth >= MAX_DEPTH {
                        self.refuse(&key, "the copy nests directories too deeply");
                        return Ok(());
                    }
                    let child = open_dir_at(directory, name)?;
                    self.walk(&child, &key, depth + 1, cancel)?;
                }
                Some(mode) if is_regular(mode) => {
                    let raw = c_name(name)?;
                    let fd = unsafe {
                        libc::openat(
                            directory.as_raw_fd(),
                            raw.as_ptr(),
                            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
                        )
                    };
                    if fd < 0 {
                        return Err(std::io::Error::last_os_error())
                            .context("open Workspace copy file");
                    }
                    let mut file = unsafe { File::from_raw_fd(fd) };
                    let metadata = file.metadata()?;
                    if !metadata.is_file() || metadata.nlink() != 1 || metadata.dev() != self.device
                    {
                        self.refuse(&key, "a file has another link or changed");
                        return Ok(());
                    }
                    let size = metadata.len();
                    let sha256 = stream(&mut file, &mut std::io::sink(), size)?;
                    self.files.push(Copied { key, size, sha256 });
                }
                // Links, sockets and devices are never written back.
                _ => self.skipped += 1,
            }
        }
        Ok(())
    }
}
