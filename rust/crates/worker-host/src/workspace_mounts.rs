//! Owner-fenced local Workspace copies of file and S3 Volumes.
//!
//! The Worker Host owner maps each Workspace Volume to a canonical source and a
//! private destination root. Every write is relative to a descriptor for that
//! root, whose device and inode must match the identity recorded at startup.
//! A staging name is journaled before it is created and carries a random
//! ownership marker. Publication uses an exclusive rename, so a competing
//! Attempt can never replace an existing destination. Cleanup removes only
//! trees that prove ownership through the marker.
//!
//! A read-write copy records the SHA-256 of every file it staged. After a
//! successful Attempt the Worker Host writes changed and created regular
//! files back to the Volume directly (`writes`), and the Control Plane
//! records only the summary.
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::{CStr, CString},
    fs::{self, DirBuilder, File},
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt},
    },
    path::{Path, PathBuf},
};
use supertag_protocol::{
    v2::{WorkspaceCopyMount, WorkspaceMountCapability, WorkspaceMountPreflight},
    volumes::file_volume_path,
    workspace_mounts::{
        MAX_WORKSPACE_MOUNT_BYTES, MAX_WORKSPACE_MOUNT_ENTRIES, MAX_WORKSPACE_MOUNT_FILES,
        absolute_path, normalize_capabilities, overlaps, volume_key,
    },
};
use supertag_workspaces::packages::{directory_names, open_directory, read_regular_at};
use tokio_util::sync::CancellationToken;

/// Names read from one directory at a time while removing a copy.
const REMOVE_BATCH: usize = 4096;
const MAX_DEPTH: usize = 32;
const MARKER: &str = ".supertag-workspace-mount-owner";
const STAGING_PREFIX: &str = ".supertag-stage-";
const STATE: &str = "workspace-mounts";
/// The most names one Attempt's mount journal holds.
const JOURNAL_NAMES: usize = 8 * supertag_protocol::workspace_mounts::MAX_WORKSPACE_MOUNTS;

mod remote;
mod s3;
mod writes;
pub(crate) use remote::{RemoteCopy, RemoteListing, RemoteWriter, record_remote, remote_writer};
pub(crate) use writes::write_back;

type Identity = (u64, u64);

#[derive(Clone, Default)]
pub struct WorkspaceMounts {
    mappings: BTreeMap<String, Mapping>,
    /// Device and inode of home, Host state, the repository, artifact storage
    /// and home configuration. A copy never descends into one of these.
    protected: Vec<Identity>,
}

#[derive(Clone)]
struct Mapping {
    capability: WorkspaceMountCapability,
    source: Source,
    destination_root: PathBuf,
    root: Identity,
}

#[derive(Clone)]
enum Source {
    File(PathBuf),
    S3(s3::S3Source),
}

impl Mapping {
    /// The host paths this mapping reaches: the file source, if any, and the destination root.
    fn paths(&self) -> Vec<&Path> {
        match &self.source {
            Source::File(source) => vec![source, &self.destination_root],
            Source::S3(_) => vec![&self.destination_root],
        }
    }

    fn file_source(&self) -> Option<&Path> {
        match &self.source {
            Source::File(source) => Some(source),
            Source::S3(_) => None,
        }
    }
}

impl Source {
    fn file(&self) -> Option<&Path> {
        match self {
            Self::File(path) => Some(path),
            Self::S3(_) => None,
        }
    }
}

impl WorkspaceMounts {
    pub fn load(path: &Path) -> Result<Self> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields, rename_all = "camelCase")]
        struct Raw {
            volume_id: String,
            source: String,
            destination_root: String,
            /// S3 only: the Volume's credential name, the endpoint and region
            /// it maps to, and the prefix of the environment variables that
            /// hold its keys (`PREFIX_ACCESS_KEY_ID`, `PREFIX_SECRET_ACCESS_KEY`,
            /// optional `PREFIX_SESSION_TOKEN`).
            #[serde(default)]
            credential: String,
            endpoint: Option<String>,
            region: Option<String>,
            credential_env_prefix: Option<String>,
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
        let mut connections = BTreeMap::new();
        let mut capabilities = Vec::new();
        for entry in entries {
            connections.insert(
                entry.volume_id.clone(),
                (entry.endpoint, entry.region, entry.credential_env_prefix),
            );
            capabilities.push(WorkspaceMountCapability {
                volume_id: entry.volume_id,
                source: entry.source,
                destination_root: entry.destination_root,
                credential: entry.credential,
            });
        }
        normalize_capabilities(&mut capabilities)?;
        let mut mappings: BTreeMap<String, Mapping> = BTreeMap::new();
        for capability in capabilities {
            let destination_root = PathBuf::from(&capability.destination_root);
            ensure!(
                destination_root.canonicalize()? == destination_root,
                "Workspace mount mappings require canonical local paths"
            );
            let source = match connections.remove(&capability.volume_id) {
                Some((Some(endpoint), Some(region), Some(prefix)))
                    if capability.source.starts_with("s3://") =>
                {
                    Source::S3(s3::S3Source::configure(
                        &capability.source,
                        &endpoint,
                        &region,
                        &prefix,
                        |name| std::env::var(name).ok(),
                    )?)
                }
                Some((None, None, None)) if !capability.source.starts_with("s3://") => {
                    let source = file_volume_path(&capability.source)?;
                    ensure!(
                        source.canonicalize()? == source,
                        "Workspace mount mappings require canonical local paths"
                    );
                    open_directory(&source)?;
                    Source::File(source)
                }
                _ => bail!(
                    "an S3 Workspace mount mapping needs endpoint, region, and credentialEnvPrefix; a file mapping takes none"
                ),
            };
            let root = open_directory(&destination_root)?;
            private(&root)?;
            if let Source::File(source) = &source {
                ensure!(
                    !overlaps(source, &destination_root),
                    "Workspace mount source and destination overlap"
                );
            }
            ensure!(
                mappings.values().all(|prior| {
                    source
                        .file()
                        .is_none_or(|path| !overlaps(path, &prior.destination_root))
                        && prior
                            .file_source()
                            .is_none_or(|path| !overlaps(&destination_root, path))
                }),
                "Workspace mount mappings cross a source and destination root"
            );
            mappings.insert(
                capability.volume_id.clone(),
                Mapping {
                    capability,
                    source,
                    destination_root,
                    root: identity(&root)?,
                },
            );
        }
        Ok(Self {
            mappings,
            protected: vec![],
        })
    }

    pub fn capabilities(&self) -> Vec<WorkspaceMountCapability> {
        self.mappings
            .values()
            .map(|mapping| mapping.capability.clone())
            .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.mappings.is_empty()
    }

    /// Reject mappings that reach Host state, the repository, artifact storage
    /// or home configuration by path or through a filesystem alias.
    pub fn protect(
        &mut self,
        state: &Path,
        workspaces: &[&Path],
        artifact_storage: Option<&Path>,
    ) -> Result<()> {
        let mut protected = vec![state.canonicalize()?];
        for path in workspaces.iter().copied().chain(artifact_storage) {
            protected.push(canonical_allow_missing(path)?);
        }
        // A missing home holds no configuration to protect.
        let home =
            std::env::var_os("HOME").and_then(|home| PathBuf::from(home).canonicalize().ok());
        if let Some(home) = &home {
            protected.push(home.join(".ssh"));
            protected.push(home.join(".supertag"));
            for mapping in self.mappings.values() {
                for path in mapping.paths() {
                    if let Ok(relative) = path.strip_prefix(home) {
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
        self.reject_overlaps(&protected)?;
        // A bind mount or firmlink keeps its own spelling but shares the
        // directory identity. Compare each mapping ancestor against home and
        // the protected directories by device and inode.
        let mut identities: Vec<(PathBuf, Identity)> = vec![];
        for path in home.iter().chain(&protected) {
            if let Ok(directory) = open_directory(path) {
                identities.push((path.clone(), identity(&directory)?));
            }
        }
        for mapping in self.mappings.values() {
            for path in mapping.paths() {
                for ancestor in path.ancestors() {
                    let found = identity(&open_directory(ancestor)?)?;
                    ensure!(
                        identities
                            .iter()
                            .all(|(protected, id)| *id != found || protected == ancestor),
                        "Workspace mount mapping reaches protected storage through an alias"
                    );
                }
            }
        }
        self.protected = identities.into_iter().map(|(_, id)| id).collect();
        Ok(())
    }

    fn reject_overlaps(&self, paths: &[PathBuf]) -> Result<()> {
        ensure!(
            self.mappings.values().all(|mapping| paths
                .iter()
                .all(|path| mapping.paths().iter().all(|own| !overlaps(own, path)))),
            "Workspace mount mapping overlaps Worker Host, repository, or artifact storage"
        );
        Ok(())
    }

    /// Check the exact mappings for frozen pins and return the artifact Volume
    /// paths the Control Plane disclosed for this live Attempt.
    pub(crate) fn preflight(
        &self,
        pins: &[WorkspaceCopyMount],
        response: WorkspaceMountPreflight,
    ) -> Result<Vec<PathBuf>> {
        let protected: Vec<_> = response
            .protected_file_sources
            .iter()
            .map(|source| canonical_allow_missing(&file_volume_path(source)?))
            .collect::<Result<_>>()?;
        self.reject_overlaps(&protected)?;
        for mount in pins {
            self.mapping(mount)?;
        }
        Ok(protected)
    }

    fn mapping(&self, mount: &WorkspaceCopyMount) -> Result<&Mapping> {
        let pin = mount
            .volume
            .as_ref()
            .context("Workspace Volume was not frozen")?;
        let mapping = self
            .mappings
            .get(&mount.volume_id)
            .context("Workspace Volume has no host mapping")?;
        let path = absolute_path(&mount.destination)?;
        ensure!(
            pin.volume_id == mount.volume_id
                && pin.source == mapping.capability.source
                && pin.credential == mapping.capability.credential
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
        artifact_sources: &[PathBuf],
        cancel: &CancellationToken,
    ) -> Result<Mounted> {
        let receipts = journal_directory(state, attempt)?;
        match DirBuilder::new().mode(0o700).create(&receipts) {
            Ok(()) => {
                File::open(receipts.parent().context("journal has no parent")?)?.sync_all()?
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        let receipt_directory = open_directory(&receipts)?;
        private(&receipt_directory)?;
        let mut protected = self.protected.clone();
        for path in artifact_sources
            .iter()
            .map(PathBuf::as_path)
            .chain([checkout])
        {
            if let Ok(directory) = open_directory(path) {
                protected.push(identity(&directory)?);
            }
        }
        let mut paths = vec![];
        let mut writable = vec![];
        let mut copies = vec![];
        // One Attempt copies at most 20 GiB across all of its copies, as in TypeScript.
        let mut attempt_bytes = MAX_WORKSPACE_MOUNT_BYTES;
        for (index, mount) in mounts.iter().enumerate() {
            ensure!(!cancel.is_cancelled(), "Workspace copy cancelled");
            let mapping = self.mapping(mount)?;
            let destination = PathBuf::from(&mount.destination);
            ensure!(
                !overlaps(checkout, &destination)
                    && mapping.paths().iter().all(|path| !overlaps(checkout, path)),
                "Workspace mount overlaps the Attempt checkout"
            );
            let name = file_name(&destination)?;
            let receipt = format!("{index}.json");
            // A restarted Attempt first removes what it proved it owned.
            if stat_at(&receipt_directory, &receipt)?.is_some() {
                clear_receipt(&receipt_directory, &receipt)?;
            }
            let root = mapping.open_root()?;
            ensure!(
                stat_at(&root, name)?.is_none(),
                "Workspace mount destination is occupied"
            );
            let entry = Receipt {
                destination: destination.clone(),
                staging: format!("{STAGING_PREFIX}{}", uuid::Uuid::new_v4().simple()),
                token: uuid::Uuid::new_v4().to_string(),
                root_device: mapping.root.0,
                root_inode: mapping.root.1,
                volume_id: mount.volume_id.clone(),
                source: mapping.capability.source.clone(),
                read_write: mount.read_write,
                max_bytes: mount.max_bytes,
            };
            save_receipt(&receipts.join(&receipt), &entry)?;
            mkdir_at(&root, &entry.staging)?;
            root.sync_all()?;
            let staging = open_dir_at(&root, &entry.staging)?;
            private(&staging)?;
            // A read-write copy's marker is the Task's to delete, so cleanup
            // also recognizes the tree by its directory identity.
            save_tree(&receipts, index, identity(&staging)?)?;
            let mut marker = create_at(&staging, MARKER, 0o400)?;
            marker.write_all(entry.token.as_bytes())?;
            marker.sync_all()?;
            staging.sync_all()?;
            let limit = mount.max_bytes.min(attempt_bytes);
            let mut budget = CopyBudget {
                bytes: limit,
                entries: MAX_WORKSPACE_MOUNT_ENTRIES,
                files: MAX_WORKSPACE_MOUNT_FILES,
                device: 0,
                protected: &protected,
                cancel,
                writable: mount.read_write,
                copied: Vec::new(),
            };
            match &mapping.source {
                Source::File(path) => {
                    let source = open_directory(path)?;
                    budget.device = source.metadata()?.dev();
                    budget.copy(&source, &staging, 0, "")?;
                }
                Source::S3(source) => budget.download(source, &staging)?,
            }
            attempt_bytes -= limit - budget.bytes;
            ensure!(!cancel.is_cancelled(), "Workspace copy cancelled");
            if mount.read_write {
                save_copied(&receipts, index, &budget.copied)?;
            }
            let tree = identity(&staging)?;
            rename_new(&root, &entry.staging, name)?;
            root.sync_all()?;
            // Prove the published path is the staged tree in the configured root.
            ensure!(
                identity(&open_directory(&destination)?)? == identity(&staging)?
                    && identity(&open_directory(&mapping.destination_root)?)? == mapping.root,
                "Workspace mount root changed while staging"
            );
            copies.push(RemoteCopy {
                index,
                name: name.to_owned(),
                destination: destination.clone(),
                tree,
                read_write: mount.read_write,
                max_bytes: mount.max_bytes,
                files: std::mem::take(&mut budget.copied),
            });
            if mount.read_write {
                writable.push(destination);
            } else {
                paths.push(destination);
            }
        }
        Ok(Mounted {
            paths,
            writable,
            copies,
        })
    }
}

impl Mapping {
    fn open_root(&self) -> Result<File> {
        let root = open_directory(&self.destination_root)?;
        private(&root)?;
        ensure!(
            identity(&root)? == self.root,
            "Workspace mount root was replaced"
        );
        Ok(root)
    }
}

pub(crate) struct Mounted {
    paths: Vec<PathBuf>,
    writable: Vec<PathBuf>,
    /// Every staged copy with the files it holds, for a remote Workspace's upload.
    copies: Vec<RemoteCopy>,
}

impl Mounted {
    /// Instructions naming each local copy by its absolute path.
    pub(crate) fn instructions(&self) -> Result<String> {
        copy_instructions(&self.paths, &self.writable, "")
    }

    /// The copies a remote Workspace receives, each at `volumes/<attempt digest>/<name>`.
    pub(crate) fn copies(&self) -> &[RemoteCopy] {
        &self.copies
    }

    /// Instructions naming each copy by its path in a remote Workspace.
    pub(crate) fn remote_instructions(&self, attempt: &str) -> Result<String> {
        let path = |read_write: bool| -> Vec<String> {
            self.copies
                .iter()
                .filter(|copy| copy.read_write == read_write)
                .map(|copy| copy.sandbox_path(attempt))
                .collect()
        };
        copy_instructions(
            &path(false),
            &path(true),
            ", relative to the remote Workspace",
        )
    }
}

fn copy_instructions(
    read_only: &[impl Serialize],
    writable: &[impl Serialize],
    relative: &str,
) -> Result<String> {
    let mut text = String::new();
    if !read_only.is_empty() {
        text.push_str(&format!(
            "\n\nRead-only Workspace data is available at these paths{relative}: {}.",
            serde_json::to_string(read_only)?
        ));
    }
    if !writable.is_empty() {
        text.push_str(&format!(
            "\n\nRead-write Workspace data is available at these paths{relative}: {}. Files you change or create there are written back to their Volume when the Task succeeds; deletions and links are not.",
            serde_json::to_string(writable)?
        ));
    }
    Ok(text)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    destination: PathBuf,
    staging: String,
    token: String,
    root_device: u64,
    root_inode: u64,
    volume_id: String,
    source: String,
    read_write: bool,
    max_bytes: u64,
}

/// One staged file of a read-write copy: its Volume-relative key, size and
/// lowercase hex SHA-256.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
pub(crate) struct Copied {
    pub(crate) key: String,
    pub(crate) size: u64,
    pub(crate) sha256: String,
}

fn tree_name(receipt: &str) -> Option<String> {
    receipt
        .strip_suffix(".json")
        .map(|stem| format!("{stem}.tree"))
}

fn save_tree(receipts: &Path, index: usize, tree: Identity) -> Result<()> {
    let mut temp = tempfile::NamedTempFile::new_in(receipts)?;
    serde_json::to_writer(&mut temp, &tree)?;
    temp.as_file().sync_all()?;
    temp.persist(receipts.join(format!("{index}.tree")))?;
    File::open(receipts)?.sync_all()?;
    Ok(())
}

fn read_tree(directory: &File, receipt: &str) -> Option<Identity> {
    let name = tree_name(receipt)?;
    serde_json::from_slice(&read_regular_at(directory, &name, 128).ok()?).ok()
}

fn copied_name(index: usize) -> String {
    format!("{index}.copied")
}

fn save_copied(receipts: &Path, index: usize, copied: &[Copied]) -> Result<()> {
    let mut temp = tempfile::NamedTempFile::new_in(receipts)?;
    serde_json::to_writer(&mut temp, copied)?;
    temp.as_file().sync_all()?;
    temp.persist(receipts.join(copied_name(index)))?;
    File::open(receipts)?.sync_all()?;
    Ok(())
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

fn read_receipt(directory: &File, name: &str) -> Result<Receipt> {
    let bytes = read_regular_at(directory, name, 4096)?;
    let entry: Receipt = serde_json::from_slice(&bytes)?;
    let destination = entry
        .destination
        .to_str()
        .context("invalid Workspace mount cleanup receipt")?;
    absolute_path(destination)?;
    ensure!(
        file_name(&entry.destination).is_ok()
            && entry
                .staging
                .strip_prefix(STAGING_PREFIX)
                .is_some_and(|id| uuid::Uuid::try_parse(id).is_ok())
            && uuid::Uuid::try_parse(&entry.token).is_ok(),
        "invalid Workspace mount cleanup receipt"
    );
    Ok(entry)
}

/// Remove an Attempt's published and staged copies, then its receipts.
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
    // Each copy journals at most five files; an interrupted write leaves one temporary file.
    for name in directory_names(&directory, JOURNAL_NAMES)? {
        if name.ends_with(".json") {
            clear_receipt(&directory, &name)?;
        } else {
            // An interrupted receipt write leaves only a private temporary file.
            unlink_at(&directory, &name, 0)?;
            directory.sync_all()?;
        }
    }
    fs::remove_dir(&receipts)?;
    File::open(receipts.parent().context("journal has no parent")?)?.sync_all()?;
    Ok(())
}

fn clear_receipt(directory: &File, name: &str) -> Result<()> {
    let entry = read_receipt(directory, name)?;
    let tree = read_tree(directory, name);
    let parent = entry
        .destination
        .parent()
        .context("Workspace mount destination has no parent")?;
    match open_directory(parent) {
        Ok(root)
            if private(&root).is_ok()
                && identity(&root)? == (entry.root_device, entry.root_inode) =>
        {
            for (entry_name, staging) in [
                (file_name(&entry.destination)?, false),
                (&*entry.staging, true),
            ] {
                if owned(&root, entry_name, &entry.token, staging, tree)? {
                    remove_tree_at(&root, &c_name(entry_name)?, 0)?;
                    root.sync_all()?;
                }
            }
        }
        // Never follow a moved or replaced root. Leave its contents in place.
        _ => supertag_protocol::terminal_text::warn(&format!(
            "Workspace mount root {} changed; leaving its copies in place",
            parent.display()
        )),
    }
    unlink_at(directory, name, 0)?;
    directory.sync_all()?;
    Ok(())
}

/// Whether the named entry is this receipt's tree. A staging directory may
/// lack a complete marker after a crash between creating it and syncing the
/// marker, so an otherwise empty staging directory is ours by its journaled
/// random name.
fn owned(
    root: &File,
    name: &str,
    token: &str,
    staging: bool,
    tree: Option<Identity>,
) -> Result<bool> {
    let directory = match open_dir_at(root, name) {
        Ok(directory) => directory,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) if matches!(error.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)) => {
            return Ok(false);
        }
        Err(error) => return Err(error.into()),
    };
    if tree.is_some_and(|tree| identity(&directory).is_ok_and(|found| found == tree)) {
        return Ok(true);
    }
    if private(&directory).is_err() {
        return Ok(false);
    }
    let marker = read_regular_at(&directory, MARKER, 36).ok();
    if marker.as_deref() == Some(token.as_bytes()) {
        return Ok(true);
    }
    if !staging {
        return Ok(false);
    }
    let names = directory_names(&directory, 2)?;
    Ok(match marker {
        None => names.is_empty(),
        Some(partial) => token.as_bytes().starts_with(&partial) && names == [MARKER],
    })
}

/// Remove a tree without following links. A read-write copy holds whatever
/// the Task made there, so names are raw bytes and counts are unbounded.
fn remove_tree_at(parent: &File, name: &CStr, depth: usize) -> Result<()> {
    ensure!(
        depth <= MAX_REMOVE_DEPTH,
        "Workspace mount tree is too deep"
    );
    let directory = open_dir_at_c(parent, name)?;
    directory.set_permissions(fs::Permissions::from_mode(0o700))?;
    loop {
        let children = raw_names(&directory, REMOVE_BATCH)?;
        if children.is_empty() {
            break;
        }
        for child in children {
            match stat_at_c(&directory, &child)? {
                Some(mode) if is_directory(mode) => remove_tree_at(&directory, &child, depth + 1)?,
                Some(_) => unlink_at_c(&directory, &child, 0)?,
                None => {}
            }
        }
    }
    unlink_at_c(parent, name, libc::AT_REMOVEDIR)
}

const MAX_REMOVE_DEPTH: usize = 256;

/// Up to `maximum` entry names of `directory` as raw bytes, without `.` and `..`.
fn raw_names(directory: &File, maximum: usize) -> Result<Vec<CString>> {
    let dot = c".";
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            dot.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let raw = unsafe { libc::fdopendir(fd) };
    if raw.is_null() {
        unsafe { libc::close(fd) };
        return Err(std::io::Error::last_os_error().into());
    }
    struct Closing(*mut libc::DIR);
    impl Drop for Closing {
        fn drop(&mut self) {
            unsafe { libc::closedir(self.0) };
        }
    }
    let stream = Closing(raw);
    let mut names = Vec::new();
    while names.len() < maximum {
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if !matches!(name.to_bytes(), b"." | b"..") {
            names.push(name.to_owned());
        }
    }
    Ok(names)
}

fn file_name(path: &Path) -> Result<&str> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .context("Workspace mount destination is missing")?;
    ensure!(!name.starts_with('.'), "reserved Workspace mount name");
    Ok(name)
}

fn private(file: &File) -> Result<()> {
    let meta = file.metadata()?;
    ensure!(
        meta.is_dir() && meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o077 == 0,
        "Workspace mount directory must be owner-only"
    );
    Ok(())
}

fn identity(file: &File) -> Result<Identity> {
    let meta = file.metadata()?;
    Ok((meta.dev(), meta.ino()))
}

fn c_name(name: &str) -> std::io::Result<CString> {
    if name.is_empty() || name.contains('/') || name == "." || name == ".." {
        return Err(std::io::Error::other("invalid Workspace mount entry name"));
    }
    CString::new(name).map_err(std::io::Error::other)
}

fn open_dir_at(parent: &File, name: &str) -> std::io::Result<File> {
    open_dir_at_c(parent, &c_name(name)?)
}

fn open_dir_at_c(parent: &File, name: &CStr) -> std::io::Result<File> {
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn mkdir_at(parent: &File, name: &str) -> Result<()> {
    let name = c_name(name)?;
    if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
        return Err(std::io::Error::last_os_error()).context("create Workspace mount directory");
    }
    Ok(())
}

fn create_at(parent: &File, name: &str, mode: libc::c_uint) -> Result<File> {
    let name = c_name(name)?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            mode,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error()).context("create Workspace mount file");
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

/// The entry's mode without following a final link, or `None` if absent.
// `S_IFMT` and `S_IFDIR` are `u16` on macOS and `u32` on Linux.
#[allow(clippy::unnecessary_cast)]
fn is_directory(mode: u32) -> bool {
    mode & libc::S_IFMT as u32 == libc::S_IFDIR as u32
}

#[allow(clippy::unnecessary_cast)]
fn is_regular(mode: u32) -> bool {
    mode & libc::S_IFMT as u32 == libc::S_IFREG as u32
}

fn stat_at(parent: &File, name: &str) -> Result<Option<u32>> {
    stat_at_c(parent, &c_name(name)?)
}

fn stat_at_c(parent: &File, name: &CStr) -> Result<Option<u32>> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::NotFound {
            return Ok(None);
        }
        return Err(error.into());
    }
    #[allow(clippy::unnecessary_cast)]
    Ok(Some(unsafe { stat.assume_init() }.st_mode as u32))
}

fn unlink_at(parent: &File, name: &str, flags: libc::c_int) -> Result<()> {
    unlink_at_c(parent, &c_name(name)?, flags)
}

fn unlink_at_c(parent: &File, name: &CStr, flags: libc::c_int) -> Result<()> {
    if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), flags) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(error).context("remove Workspace mount entry");
        }
    }
    Ok(())
}

fn rename_new(parent: &File, source: &str, target: &str) -> Result<()> {
    let source = c_name(source)?;
    let target = c_name(target)?;
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
    /// Bytes left under the copy's limit and the Attempt's.
    bytes: u64,
    /// Directory entries a `file://` walk may still visit.
    entries: usize,
    /// Files the copy may still hold.
    files: usize,
    device: u64,
    protected: &'a [Identity],
    cancel: &'a CancellationToken,
    /// Read-write copies stay owner-writable; their file names must be Volume keys.
    writable: bool,
    /// Every file staged, for write-back and a remote Workspace's upload.
    copied: Vec<Copied>,
}

impl CopyBudget<'_> {
    fn directory_mode(&self) -> u32 {
        if self.writable { 0o700 } else { 0o500 }
    }

    fn file_mode(&self) -> libc::c_uint {
        if self.writable { 0o600 } else { 0o400 }
    }

    /// Download every listed object under the S3 prefix into `target`.
    fn download(&mut self, source: &s3::S3Source, target: &File) -> Result<()> {
        let runtime = tokio::runtime::Handle::current();
        let listed = runtime.block_on(source.list(self.files))?;
        let total = listed.iter().map(|object| object.size).sum::<u64>();
        ensure!(
            total <= self.bytes,
            "Workspace Volume exceeds its byte limit"
        );
        self.bytes -= total;
        let mut directories: Vec<String> = Vec::new();
        for object in listed {
            ensure!(!self.cancel.is_cancelled(), "Workspace copy cancelled");
            let parts: Vec<&str> = object.key.split('/').collect();
            ensure!(
                parts.len() <= MAX_DEPTH,
                "Workspace Volume exceeds its depth limit"
            );
            let mut directory = target.try_clone()?;
            for (depth, part) in parts[..parts.len() - 1].iter().enumerate() {
                let path = parts[..=depth].join("/");
                if !directories.contains(&path) {
                    mkdir_at(&directory, part)?;
                    directories.push(path);
                }
                directory = open_dir_at(&directory, part)?;
            }
            let name = parts[parts.len() - 1];
            let mut output = create_at(&directory, name, self.file_mode())?;
            let sha256 = runtime.block_on(source.read(
                &object.key,
                object.size,
                &mut output,
                self.cancel,
            ))?;
            flush(&output)?;
            self.copied.push(Copied {
                key: object.key,
                size: object.size,
                sha256,
            });
        }
        // Seal directories deepest first, so a read-only copy cannot gain entries.
        directories.sort_by_key(|path| std::cmp::Reverse(path.matches('/').count()));
        for path in directories {
            let mut directory = target.try_clone()?;
            for part in path.split('/') {
                directory = open_dir_at(&directory, part)?;
            }
            directory.set_permissions(fs::Permissions::from_mode(self.directory_mode()))?;
            flush(&directory)?;
        }
        target.set_permissions(fs::Permissions::from_mode(self.directory_mode()))?;
        flush(target)?;
        Ok(())
    }

    fn copy(&mut self, source: &File, target: &File, depth: usize, prefix: &str) -> Result<()> {
        ensure!(
            depth <= MAX_DEPTH && !self.cancel.is_cancelled(),
            "Workspace copy exceeded depth or was cancelled"
        );
        let before = source.metadata()?;
        ensure!(
            before.dev() == self.device && !self.protected.contains(&(before.dev(), before.ino())),
            "Workspace Volume reaches another filesystem or protected storage"
        );
        let names = directory_names(source, self.entries)?;
        for name in names {
            ensure!(
                !self.cancel.is_cancelled() && !name.starts_with(".supertag-") && name != ".git",
                "Workspace copy has a reserved name or was cancelled"
            );
            self.entries = self
                .entries
                .checked_sub(1)
                .context("Workspace Volume exceeds its entry limit")?;
            let raw = c_name(&name)?;
            let fd = unsafe {
                libc::openat(
                    source.as_raw_fd(),
                    raw.as_ptr(),
                    libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(std::io::Error::last_os_error()).context("open Workspace Volume entry");
            }
            let mut file = unsafe { File::from_raw_fd(fd) };
            let metadata = file.metadata()?;
            let key = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if metadata.is_dir() {
                mkdir_at(target, &name)?;
                let output = open_dir_at(target, &name)?;
                self.copy(&file, &output, depth + 1, &key)?;
            } else {
                self.files = self
                    .files
                    .checked_sub(1)
                    .context("Workspace Volume exceeds its file limit")?;
                ensure!(
                    metadata.is_file()
                        && metadata.dev() == self.device
                        && metadata.nlink() == 1
                        && metadata.len() <= self.bytes,
                    "Workspace Volume entry is unsafe or exceeds its byte limit"
                );
                let mut output = create_at(target, &name, self.file_mode())?;
                let mut buffer = vec![0u8; 64 * 1024];
                let mut total = 0;
                let mut hash = Sha256::new();
                loop {
                    ensure!(!self.cancel.is_cancelled(), "Workspace copy cancelled");
                    let count = file.read(&mut buffer)?;
                    if count == 0 {
                        break;
                    }
                    total += count as u64;
                    ensure!(total <= metadata.len(), "Workspace Volume file changed");
                    hash.update(&buffer[..count]);
                    output.write_all(&buffer[..count])?;
                }
                let after = file.metadata()?;
                ensure!(
                    total == metadata.len() && unchanged(&metadata, &after) && after.nlink() == 1,
                    "Workspace Volume file changed"
                );
                self.bytes -= total;
                flush(&output)?;
                if self.writable {
                    ensure!(
                        volume_key(&key),
                        "Workspace Volume holds an unsupported file name"
                    );
                }
                self.copied.push(Copied {
                    key,
                    size: total,
                    sha256: format!("{:x}", hash.finalize()),
                });
            }
        }
        ensure!(
            unchanged(&before, &source.metadata()?),
            "Workspace Volume directory changed"
        );
        target.set_permissions(fs::Permissions::from_mode(self.directory_mode()))?;
        flush(target)?;
        Ok(())
    }
}

/// Write a staged entry's data to the device. On macOS this is `fsync`, not the full
/// cache flush `sync_all` issues: the caller's later `sync_all` of the published root flushes
/// every entry staged before it, so a 10,000-file copy is not 10,000 cache flushes.
fn flush(file: &File) -> Result<()> {
    #[cfg(target_os = "macos")]
    if unsafe { libc::fsync(file.as_raw_fd()) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    #[cfg(not(target_os = "macos"))]
    file.sync_all()?;
    Ok(())
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

#[cfg(test)]
mod tests;
