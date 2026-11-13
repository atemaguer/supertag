//! Owner-fenced local read-only Workspace copies.
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::CString,
    fs::{self, DirBuilder, File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
};
use supertag_protocol::{
    v2::{WorkspaceCopyMount, WorkspaceMountCapability, WorkspaceMountPreflight},
    volumes::file_volume_path,
    workspace_mounts::{absolute_path, normalize_capabilities, overlaps},
};
use supertag_workspaces::packages::{directory_names, open_directory};
use tokio_util::sync::CancellationToken;

const MAX_ENTRIES: usize = 4096;
const MARKER: &str = ".supertag-workspace-mount-owner";
const STATE: &str = "workspace-mounts";

#[derive(Clone, Default)]
pub struct WorkspaceMounts(BTreeMap<String, Mapping>);

#[derive(Clone)]
struct Mapping {
    capability: WorkspaceMountCapability,
    source: PathBuf,
    destination_root: PathBuf,
}

impl WorkspaceMounts {
    pub fn load(path: &Path) -> Result<Self> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields, rename_all = "camelCase")]
        struct Raw {
            volume_id: String,
            source: String,
            destination_root: String,
        }
        let mut bytes = Vec::new();
        File::open(path)?
            .take(64 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= 64 * 1024,
            "Workspace mount mappings exceed their size limit"
        );
        let entries: Vec<Raw> =
            serde_json::from_slice(&bytes).context("invalid Workspace mount mappings")?;
        let mut capabilities: Vec<_> = entries
            .into_iter()
            .map(|entry| WorkspaceMountCapability {
                volume_id: entry.volume_id,
                source: entry.source,
                destination_root: entry.destination_root,
            })
            .collect();
        normalize_capabilities(&mut capabilities)?;
        let mut mappings: BTreeMap<String, Mapping> = BTreeMap::new();
        for capability in capabilities {
            let source = file_volume_path(&capability.source)?;
            let destination_root = PathBuf::from(&capability.destination_root);
            ensure!(
                source.canonicalize()? == source
                    && destination_root.canonicalize()? == destination_root,
                "Workspace mount mappings require canonical local paths"
            );
            open_directory(&source)?;
            private(&open_directory(&destination_root)?)?;
            ensure!(
                !overlaps(&source, &destination_root),
                "Workspace mount source and destination overlap"
            );
            ensure!(
                mappings.values().all(|prior| {
                    !overlaps(&source, &prior.destination_root)
                        && !overlaps(&destination_root, &prior.source)
                }),
                "Workspace mount mappings cross a source and destination root"
            );
            mappings.insert(
                capability.volume_id.clone(),
                Mapping {
                    capability,
                    source,
                    destination_root,
                },
            );
        }
        Ok(Self(mappings))
    }

    pub fn capabilities(&self) -> Vec<WorkspaceMountCapability> {
        self.0
            .values()
            .map(|mapping| mapping.capability.clone())
            .collect()
    }

    pub(crate) fn validate_protected(
        &self,
        state: &Path,
        workspace: Option<&Path>,
        artifact_storage: Option<&Path>,
    ) -> Result<()> {
        let mut protected = vec![state.canonicalize()?];
        for path in workspace.into_iter().chain(artifact_storage) {
            protected.push(canonical_allow_missing(path)?);
        }
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home).canonicalize()?;
            protected.push(home.join(".ssh"));
            protected.push(home.join(".supertag"));
            for mapping in self.0.values() {
                for path in [&mapping.source, &mapping.destination_root] {
                    if let Ok(relative) = path.strip_prefix(&home) {
                        ensure!(
                            relative.components().next().is_some_and(|part| {
                                let name = part.as_os_str().to_string_lossy();
                                !name.starts_with('.') && !name.eq_ignore_ascii_case("Library")
                            }),
                            "Workspace mount mapping overlaps a home configuration path"
                        );
                    } else {
                        ensure!(
                            !home.starts_with(path),
                            "Workspace mount mapping contains the user home"
                        );
                    }
                }
            }
        }
        self.reject_overlaps(&protected)
    }

    fn reject_overlaps(&self, paths: &[PathBuf]) -> Result<()> {
        ensure!(
            self.0.values().all(|mapping| paths.iter().all(|path| {
                !overlaps(&mapping.source, path) && !overlaps(&mapping.destination_root, path)
            })),
            "Workspace mount mapping overlaps Worker Host, repository, or artifact storage"
        );
        Ok(())
    }

    pub(crate) fn preflight(
        &self,
        pins: &[WorkspaceCopyMount],
        response: WorkspaceMountPreflight,
    ) -> Result<()> {
        let protected: Vec<_> = response
            .protected_file_sources
            .iter()
            .map(|source| canonical_allow_missing(&file_volume_path(source)?))
            .collect::<Result<_>>()?;
        self.reject_overlaps(&protected)?;
        for mount in pins {
            self.mapping(mount)?;
        }
        Ok(())
    }

    fn mapping(&self, mount: &WorkspaceCopyMount) -> Result<&Mapping> {
        let pin = mount
            .volume
            .as_ref()
            .context("Workspace Volume was not frozen")?;
        let mapping = self
            .0
            .get(&mount.volume_id)
            .context("Workspace Volume has no host mapping")?;
        let path = absolute_path(&mount.destination)?;
        ensure!(
            pin.volume_id == mount.volume_id
                && pin.source == mapping.capability.source
                && path.parent() == Some(&mapping.destination_root),
            "Workspace Volume does not match the exact host mapping"
        );
        Ok(mapping)
    }

    pub(crate) fn stage(
        &self,
        state: &Path,
        attempt: &str,
        checkout: &Path,
        mounts: &[WorkspaceCopyMount],
        cancel: &CancellationToken,
    ) -> Result<Mounted> {
        let receipts = journal_directory(state, attempt)?;
        fs::create_dir_all(&receipts)?;
        fs::set_permissions(&receipts, fs::Permissions::from_mode(0o700))?;
        let receipts = receipts.canonicalize()?;
        private(&open_directory(&receipts)?)?;
        let mut mounted = Mounted {
            _locks: vec![],
            paths: vec![],
        };
        for (index, mount) in mounts.iter().enumerate() {
            ensure!(!cancel.is_cancelled(), "Workspace copy cancelled");
            let mapping = self.mapping(mount)?;
            let destination = PathBuf::from(&mount.destination);
            ensure!(
                !overlaps(checkout, &destination) && !overlaps(checkout, &mapping.source),
                "Workspace mount overlaps the Attempt checkout"
            );
            let target_root = open_directory(&mapping.destination_root)?;
            private(&target_root)?;
            let name = destination
                .file_name()
                .context("Workspace mount destination is missing")?;
            ensure!(
                !name.to_string_lossy().starts_with(".supertag-"),
                "reserved Workspace mount name"
            );
            let lock = lock_destination(&mapping.destination_root, &destination)?;
            let receipt_file = receipts.join(format!("{index}.json"));
            if receipt_file.exists() {
                clear_entry(&read_receipt(&receipt_file)?, &target_root)?;
                fs::remove_file(&receipt_file)?;
                File::open(&receipts)?.sync_all()?;
            }
            ensure!(
                destination
                    .symlink_metadata()
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound),
                "Workspace mount destination is occupied"
            );
            let entry = Receipt {
                destination: destination.clone(),
                staging: mapping
                    .destination_root
                    .join(format!(".supertag-stage-{}", uuid::Uuid::new_v4().simple())),
                token: uuid::Uuid::new_v4().to_string(),
            };
            save_receipt(&receipt_file, &entry)?;
            DirBuilder::new().mode(0o700).create(&entry.staging)?;
            let marker = entry.staging.join(MARKER);
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o400)
                .open(&marker)?;
            file.write_all(entry.token.as_bytes())?;
            file.sync_all()?;
            let staging_root = open_directory(&entry.staging)?;
            staging_root.sync_all()?;
            let source = open_directory(&mapping.source)?;
            CopyBudget {
                bytes: mount.max_bytes,
                entries: MAX_ENTRIES,
                cancel,
            }
            .copy(&source, &entry.staging, 0)?;
            ensure!(!cancel.is_cancelled(), "Workspace copy cancelled");
            rename_new(&target_root, &entry.staging, &entry.destination)?;
            target_root.sync_all()?;
            mounted._locks.push(lock);
            mounted.paths.push(destination);
        }
        Ok(mounted)
    }
}

pub(crate) struct Mounted {
    _locks: Vec<File>,
    paths: Vec<PathBuf>,
}

impl Mounted {
    pub(crate) fn instructions(&self) -> Result<String> {
        Ok(format!(
            "\n\nRead-only Workspace data is available at these paths: {}.",
            serde_json::to_string(&self.paths)?
        ))
    }
}

#[derive(Serialize, Deserialize)]
struct Receipt {
    destination: PathBuf,
    staging: PathBuf,
    token: String,
}

fn journal_directory(state: &Path, attempt: &str) -> Result<PathBuf> {
    let state = state.canonicalize()?;
    let root = state.join(STATE);
    match DirBuilder::new().mode(0o700).create(&root) {
        Ok(()) => File::open(&state)?.sync_all()?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    private(&open_directory(&root)?)?;
    Ok(root.join(format!("{:x}", Sha256::digest(attempt.as_bytes()))))
}

fn save_receipt(path: &Path, entry: &Receipt) -> Result<()> {
    let parent = path
        .parent()
        .context("Workspace mount journal is missing")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(&mut temp, entry)?;
    temp.as_file().sync_all()?;
    temp.persist_noclobber(path)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn read_receipt(path: &Path) -> Result<Receipt> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o077 == 0
            && metadata.nlink() == 1
            && metadata.len() <= 4096,
        "invalid Workspace mount journal"
    );
    let entry: Receipt = serde_json::from_reader(file.take(4097))?;
    ensure!(
        entry.destination.parent() == entry.staging.parent()
            && entry
                .staging
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with(".supertag-stage-"))
            && uuid::Uuid::parse_str(&entry.token).is_ok(),
        "invalid Workspace mount cleanup receipt"
    );
    Ok(entry)
}

pub(crate) fn cleanup(state: &Path, attempt: &str) -> Result<()> {
    let receipts = journal_directory(state, attempt)?;
    let directory = match open_directory(&receipts) {
        Ok(directory) => directory,
        Err(_)
            if receipts
                .symlink_metadata()
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    private(&directory)?;
    for name in directory_names(&directory, 8)? {
        let file = receipts.join(name);
        let entry = read_receipt(&file)?;
        let root = entry
            .destination
            .parent()
            .context("Workspace mount destination has no parent")?;
        let _lock = lock_destination(root, &entry.destination)?;
        let root = open_directory(root)?;
        private(&root)?;
        clear_entry(&entry, &root)?;
        fs::remove_file(&file)?;
        directory.sync_all()?;
    }
    fs::remove_dir(&receipts)?;
    File::open(receipts.parent().unwrap())?.sync_all()?;
    Ok(())
}

fn clear_entry(entry: &Receipt, root: &File) -> Result<()> {
    for path in [&entry.destination, &entry.staging] {
        let meta = match path.symlink_metadata() {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        ensure!(
            meta.is_dir(),
            "Workspace mount cleanup ownership is uncertain"
        );
        let directory = open_directory(path)?;
        private(&directory)?;
        let marker = supertag_workspaces::packages::read_regular_at(&directory, MARKER, 36)?;
        ensure!(
            marker == entry.token.as_bytes(),
            "Workspace mount cleanup ownership changed"
        );
        // This private, marked tree is ours. chmod only directories opened
        // without links; remove_dir_all does not follow child symbolic links.
        writable_tree(path, &directory)?;
        fs::remove_dir_all(path)?;
        root.sync_all()?;
    }
    Ok(())
}

fn writable_tree(path: &Path, dir: &File) -> Result<()> {
    dir.set_permissions(fs::Permissions::from_mode(0o700))?;
    for name in directory_names(dir, MAX_ENTRIES)? {
        let child = path.join(name);
        if child.symlink_metadata()?.is_dir() {
            let opened = open_directory(&child)?;
            private(&opened)?;
            writable_tree(&child, &opened)?;
        }
    }
    Ok(())
}

fn private(file: &File) -> Result<()> {
    let meta = file.metadata()?;
    ensure!(
        meta.is_dir() && meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o077 == 0,
        "Workspace mount directory must be owner-only"
    );
    Ok(())
}

fn lock_destination(root: &Path, destination: &Path) -> Result<File> {
    let key = format!(
        "{:x}",
        Sha256::digest(destination.as_os_str().as_encoded_bytes())
    );
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(root.join(format!(".supertag-lock-{key}")))?;
    let meta = file.metadata()?;
    ensure!(
        meta.is_file()
            && meta.uid() == unsafe { libc::geteuid() }
            && meta.mode() & 0o077 == 0
            && meta.nlink() == 1,
        "Workspace mount lock is not private"
    );
    file.try_lock()
        .context("Workspace mount destination is in use")?;
    Ok(file)
}

fn rename_new(parent: &File, source: &Path, target: &Path) -> Result<()> {
    let name = |path: &Path| -> Result<CString> {
        Ok(CString::new(
            path.file_name()
                .context("mount path has no final component")?
                .as_encoded_bytes(),
        )?)
    };
    let source = name(source)?;
    let target = name(target)?;
    let fd = parent.as_raw_fd();
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            fd,
            source.as_ptr(),
            fd,
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(target_os = "macos")]
    let result =
        unsafe { libc::renameatx_np(fd, source.as_ptr(), fd, target.as_ptr(), libc::RENAME_EXCL) };
    if result != 0 {
        return Err(std::io::Error::last_os_error())
            .context("Workspace mount destination cannot be published");
    }
    Ok(())
}

struct CopyBudget<'a> {
    bytes: u64,
    entries: usize,
    cancel: &'a CancellationToken,
}
impl CopyBudget<'_> {
    fn copy(&mut self, source: &File, target: &Path, depth: usize) -> Result<()> {
        ensure!(
            depth <= 32 && !self.cancel.is_cancelled(),
            "Workspace copy exceeded depth or was cancelled"
        );
        let before = source.metadata()?;
        let names = directory_names(source, self.entries)?;
        for name in names {
            ensure!(
                !self.cancel.is_cancelled() && !name.starts_with(".supertag-") && name != ".git",
                "Workspace copy has a reserved name or was cancelled"
            );
            self.entries -= 1;
            let output = target.join(&name);
            let name = CString::new(name)?;
            let fd = unsafe {
                libc::openat(
                    source.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(std::io::Error::last_os_error()).context("open Workspace Volume entry");
            }
            let mut file = unsafe { File::from_raw_fd(fd) };
            let metadata = file.metadata()?;
            if metadata.is_dir() {
                DirBuilder::new().mode(0o700).create(&output)?;
                self.copy(&file, &output, depth + 1)?;
            } else {
                ensure!(
                    metadata.is_file() && metadata.nlink() == 1 && metadata.len() <= self.bytes,
                    "Workspace Volume entry is unsafe or exceeds its byte limit"
                );
                let mut output = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .mode(0o400)
                    .open(&output)?;
                let mut buffer = [0u8; 64 * 1024];
                let mut total = 0;
                loop {
                    ensure!(!self.cancel.is_cancelled(), "Workspace copy cancelled");
                    let count = file.read(&mut buffer)?;
                    if count == 0 {
                        break;
                    }
                    total += count as u64;
                    ensure!(total <= metadata.len(), "Workspace Volume file changed");
                    output.write_all(&buffer[..count])?;
                }
                ensure!(
                    total == metadata.len() && unchanged(&metadata, &file.metadata()?),
                    "Workspace Volume file changed"
                );
                self.bytes -= total;
                output.sync_all()?;
            }
        }
        ensure!(
            unchanged(&before, &source.metadata()?),
            "Workspace Volume directory changed"
        );
        let output = open_directory(target)?;
        output.set_permissions(fs::Permissions::from_mode(0o500))?;
        output.sync_all()?;
        Ok(())
    }
}

fn unchanged(before: &fs::Metadata, after: &fs::Metadata) -> bool {
    before.len() == after.len()
        && before.mode() == after.mode()
        && before.mtime() == after.mtime()
        && before.mtime_nsec() == after.mtime_nsec()
        && before.ctime() == after.ctime()
        && before.ctime_nsec() == after.ctime_nsec()
}

fn canonical_allow_missing(path: &Path) -> Result<PathBuf> {
    let mut parent = path;
    let mut missing = Vec::new();
    loop {
        match parent.symlink_metadata() {
            Ok(_) => {
                let mut result = parent.canonicalize()?;
                for name in missing.iter().rev() {
                    result.push(name);
                }
                return Ok(result);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(
                    parent
                        .file_name()
                        .context("path has no existing ancestor")?,
                );
                parent = parent.parent().context("path has no existing ancestor")?;
            }
            Err(error) => bail!("cannot resolve protected storage path: {}", error.kind()),
        }
    }
}
