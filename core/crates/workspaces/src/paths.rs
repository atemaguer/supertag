//! Descriptor-relative reads prevent parent-directory symlinks from redirecting capture.

use anyhow::{Context, Result, bail, ensure};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::{CStr, CString, OsStr},
    fs::{self, DirBuilder, File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            ffi::OsStrExt,
            fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
        },
    },
    path::{Component, Path, PathBuf},
};
use tokio_util::sync::CancellationToken;

pub(crate) struct CapturedFile {
    pub mode: String,
    pub bytes: Vec<u8>,
}

pub(crate) fn planned_path(path: &Path) -> Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    ensure!(
        !absolute
            .components()
            .any(|part| matches!(part, Component::ParentDir)),
        "state path must not contain parent traversal"
    );
    let mut existing = absolute.as_path();
    let mut missing = vec![];
    while !existing.try_exists()? {
        missing.push(
            existing
                .file_name()
                .context("state root has no filename")?
                .to_owned(),
        );
        existing = existing
            .parent()
            .context("state root has no existing parent")?;
    }
    let mut result = existing.canonicalize()?;
    for part in missing.into_iter().rev() {
        result.push(part);
    }
    Ok(result)
}

pub(crate) fn create_private_root(path: &Path) -> Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        verify_directory(parent).or_else(|_| create_private_root(parent))?;
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) => ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "workspace directory is not a real directory: {}",
            path.display()
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            DirBuilder::new().mode(0o700).create(path)?
        }
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

pub(crate) fn verify_directory(path: &Path) -> Result<()> {
    let mut current = PathBuf::new();
    for part in path.components() {
        ensure!(
            !matches!(part, Component::ParentDir),
            "directory contains parent traversal"
        );
        current.push(part);
        let metadata = fs::symlink_metadata(&current)?;
        ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "workspace directory is not a real directory: {}",
            current.display()
        );
    }
    Ok(())
}

pub(crate) fn remove_owned_directory(path: &Path) -> Result<()> {
    verify_directory(path)?;
    fs::remove_dir_all(path)?;
    Ok(())
}

pub(crate) fn read_regular(path: &Path, maximum: usize) -> Result<Vec<u8>> {
    if let Some(parent) = path.parent() {
        verify_directory(parent)?;
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    read_file(file, maximum)
}

fn read_file(file: File, maximum: usize) -> Result<Vec<u8>> {
    let before = file.metadata()?;
    ensure!(
        before.is_file() && before.nlink() == 1,
        "capture requires a regular file without external hard links"
    );
    ensure!(
        before.len() <= maximum as u64,
        "file of {} bytes exceeds its {maximum}-byte size limit",
        before.len()
    );
    let mut bytes = Vec::new();
    (&file).take(maximum as u64 + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= maximum,
        "file grew beyond capture size limit"
    );
    let after = file.metadata()?;
    ensure!(
        before.len() == after.len()
            && before.mtime() == after.mtime()
            && before.mtime_nsec() == after.mtime_nsec()
            && bytes.len() as u64 == after.len(),
        "file changed during capture; stop the adapter before finalizing"
    );
    Ok(bytes)
}

pub(crate) fn validate_repo_path(path: &str) -> Result<()> {
    ensure!(
        !path.is_empty() && !path.starts_with('/') && !path.contains('\0') && !path.contains('\\'),
        "invalid repository path"
    );
    for part in path.split('/') {
        ensure!(
            !part.is_empty() && part != "." && part != ".." && !part.eq_ignore_ascii_case(".git"),
            "unsafe repository path: {path}"
        );
    }
    Ok(())
}

pub(crate) fn validate_link(path: &str, target: &[u8]) -> Result<()> {
    let target = std::str::from_utf8(target).context("symlink target is not UTF-8")?;
    ensure!(
        !target.is_empty() && !target.starts_with('/') && !target.contains('\\'),
        "symlink leaves its workspace: {path}"
    );
    let mut depth = path.split('/').count() - 1;
    for part in target.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                ensure!(depth > 0, "symlink leaves its workspace: {path}");
                depth -= 1;
            }
            _ => depth += 1,
        }
    }
    Ok(())
}

fn open_dir_at(parent: &File, name: impl AsRef<OsStr>) -> Result<File> {
    let name = CString::new(name.as_ref().as_bytes())?;
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

fn open_root(path: &Path) -> Result<File> {
    ensure!(
        !path.as_os_str().is_empty(),
        "workspace directory is required"
    );
    let start = if path.is_absolute() { "/" } else { "." };
    let mut directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(start)?;
    for part in path.components() {
        match part {
            Component::Normal(name) => directory = open_dir_at(&directory, name)?,
            Component::RootDir | Component::CurDir => {}
            _ => bail!("unsafe workspace directory"),
        }
    }
    Ok(directory)
}

fn open_file_at(parent: &File, name: &str) -> Result<File> {
    let name = CString::new(name)?;
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

fn checkout_parent(root: &Path, path: &str) -> Result<File> {
    let mut directory = open_root(root)?;
    if let Some((parents, _)) = path.rsplit_once('/') {
        for name in parents.split('/') {
            directory = open_dir_at(&directory, name)?;
        }
    }
    Ok(directory)
}

pub(crate) fn read_artifact_file(root: &Path, path: &str, maximum: usize) -> Result<Vec<u8>> {
    validate_repo_path(path)?;
    let directory = checkout_parent(root, path)?;
    let name = path.rsplit('/').next().context("missing filename")?;
    ensure!(
        metadata_at(&directory, name)?.st_mode & libc::S_IFMT == libc::S_IFREG,
        "artifact capture requires a regular file"
    );
    read_file(open_file_at(&directory, name)?, maximum)
}

pub(crate) fn create_output_directory(root: &Path, path: &str) -> Result<()> {
    validate_repo_path(path)?;
    let (parent, directory) = path.split_once('/').context("output path needs a parent")?;
    ensure!(
        !directory.contains('/'),
        "output path needs one child directory"
    );
    let root = open_root(root)?;
    if let Err(error) = mkdir_at(&root, parent)
        && error.kind() != std::io::ErrorKind::AlreadyExists
    {
        return Err(error.into());
    }
    mkdir_at(&open_dir_at(&root, parent)?, directory)?;
    Ok(())
}

/// Makes the directory `path` of the checkout at `root` and any missing directory on the way,
/// without following a link: a part that exists as anything but a directory is an error.
pub(crate) fn create_directories(root: &Path, path: &str) -> Result<()> {
    validate_repo_path(path)?;
    let mut directory = open_root(root)?;
    for part in path.split('/') {
        if let Err(error) = mkdir_at(&directory, part)
            && error.kind() != std::io::ErrorKind::AlreadyExists
        {
            return Err(error.into());
        }
        directory = open_dir_at(&directory, part)?;
    }
    Ok(())
}

/// What a checkout holds at a path where an empty directory belongs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Content {
    /// Nothing: the path, or a directory on the way to it, is gone.
    Missing,
    Empty,
    /// A directory with something in it, or anything that is not a directory.
    Other,
}

/// What the checkout at `root` holds at `path`, without following a link.
pub(crate) fn directory_content(root: &Path, path: &str) -> Result<Content> {
    validate_repo_path(path)?;
    let gone = |error: &anyhow::Error| {
        error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    };
    let mut directory = open_root(root)?;
    for part in path.split('/') {
        let metadata = match metadata_at(&directory, part) {
            Ok(metadata) => metadata,
            Err(error) if gone(&error) => return Ok(Content::Missing),
            Err(error) => return Err(error),
        };
        if metadata.st_mode & libc::S_IFMT != libc::S_IFDIR {
            return Ok(Content::Other);
        }
        directory = open_dir_at(&directory, part)?;
    }
    Ok(if names(&directory)?.is_empty() {
        Content::Empty
    } else {
        Content::Other
    })
}

fn mkdir_at(parent: &File, name: &str) -> std::io::Result<()> {
    let name = CString::new(name)?;
    let result = unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Create an exclusive subtree without following any component, then write each
/// selected regular file with exclusive creation. Partial failure is not replayable.
pub(crate) fn write_acquired_files(
    root: &Path,
    path: &str,
    files: &[(String, Vec<u8>)],
) -> Result<()> {
    validate_repo_path(path)?;
    let parent = checkout_parent(root, path)?;
    let leaf = path.rsplit('/').next().context("missing input directory")?;
    mkdir_at(&parent, leaf)?;
    let destination = open_dir_at(&parent, leaf)?;
    for (path, bytes) in files {
        validate_repo_path(path)?;
        let mut directory = destination.try_clone()?;
        let mut parts = path.split('/').peekable();
        while let Some(part) = parts.next() {
            if parts.peek().is_some() {
                if let Err(error) = mkdir_at(&directory, part)
                    && error.kind() != std::io::ErrorKind::AlreadyExists
                {
                    return Err(error.into());
                }
                directory = open_dir_at(&directory, part)?;
            } else {
                let name = CString::new(part)?;
                let descriptor = unsafe {
                    libc::openat(
                        directory.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_WRONLY
                            | libc::O_CREAT
                            | libc::O_EXCL
                            | libc::O_NOFOLLOW
                            | libc::O_CLOEXEC,
                        0o600,
                    )
                };
                if descriptor < 0 {
                    return Err(std::io::Error::last_os_error().into());
                }
                let mut file = unsafe { File::from_raw_fd(descriptor) };
                file.write_all(bytes)?;
                file.sync_all()?;
            }
            directory.sync_all()?;
        }
    }
    destination.sync_all()?;
    parent.sync_all()?;
    Ok(())
}

pub(crate) fn remove_output_directory(root: &Path, path: &str) -> Result<()> {
    validate_repo_path(path)?;
    let full = root.join(path);
    let parent = full.parent().context("output directory needs a parent")?;
    match open_root(parent) {
        Ok(_) => {}
        Err(error) if missing(&error) => return Ok(()),
        Err(error) => return Err(error),
    }
    match fs::remove_dir_all(full) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn prepare_declared_output_directory(root: &Path, path: &str) -> Result<()> {
    validate_repo_path(path)?;
    let mut directory = open_root(root)?;
    for part in path.split('/') {
        if let Err(error) = mkdir_at(&directory, part)
            && error.kind() != std::io::ErrorKind::AlreadyExists
        {
            return Err(error.into());
        }
        directory = open_dir_at(&directory, part)?;
    }
    Ok(())
}

struct OutputWalk<'a, F> {
    include: &'a F,
    remaining: usize,
    max_files: usize,
    files: BTreeSet<String>,
}

impl<F: Fn(&str) -> bool> OutputWalk<'_, F> {
    fn directory(&mut self, directory: &File, prefix: &str, depth: usize) -> Result<()> {
        ensure!(depth <= 128, "output directory nesting exceeds its limit");
        for name in bounded_names(directory, self.remaining)? {
            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            self.entry(directory, &name, path, depth)?;
        }
        Ok(())
    }

    fn entry(&mut self, directory: &File, name: &str, path: String, depth: usize) -> Result<()> {
        self.remaining = self
            .remaining
            .checked_sub(1)
            .context("output enumeration exceeds its limit")?;
        if exclude_output_name(name) {
            return Ok(());
        }
        ensure!(
            path.len() <= 1024,
            "output file path exceeds its length limit"
        );
        let mode = match metadata_at(directory, name) {
            Ok(metadata) => metadata.st_mode & libc::S_IFMT,
            Err(error) if missing(&error) => return Ok(()),
            Err(error) => return Err(error),
        };
        match mode {
            libc::S_IFDIR => self.directory(&open_dir_at(directory, name)?, &path, depth + 1)?,
            libc::S_IFREG if (self.include)(&path) => {
                self.files.insert(path);
                ensure!(
                    self.files.len() <= self.max_files,
                    "output file count exceeds its limit"
                );
            }
            libc::S_IFREG => {}
            _ => bail!("outputs must contain only directories and regular files"),
        }
        Ok(())
    }
}

pub(crate) fn list_selected_output_files(
    root: &Path,
    roots: &[String],
    max_files: usize,
    include: &impl Fn(&str) -> bool,
) -> Result<Vec<String>> {
    let mut walk = OutputWalk {
        include,
        remaining: max_files.saturating_mul(4).saturating_add(1000),
        max_files,
        files: BTreeSet::new(),
    };
    for path in roots {
        if path.is_empty() {
            walk.directory(&open_root(root)?, "", 0)?;
            continue;
        }
        validate_repo_path(path)?;
        if path.split('/').any(exclude_output_name) {
            continue;
        }
        let parent = match checkout_parent(root, path) {
            Ok(parent) => parent,
            Err(error) if missing(&error) => continue,
            Err(error) => return Err(error),
        };
        let name = path
            .rsplit('/')
            .next()
            .context("output path needs a filename")?;
        walk.entry(&parent, name, path.clone(), 0)?;
    }
    Ok(walk.files.into_iter().collect())
}

fn missing(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}

fn exclude_output_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    matches!(
        name.as_str(),
        ".git"
            | "node_modules"
            | ".venv"
            | "venv"
            | "__pycache__"
            | ".cache"
            | "inputs"
            | ".ssh"
            | ".aws"
            | ".gnupg"
            | ".supertag"
            | ".env"
    ) || name.starts_with(".env.")
        || [".pem", ".key", ".p12", ".pfx"]
            .iter()
            .any(|suffix| name.ends_with(suffix))
        || name
            .strip_prefix("artifact-")
            .is_some_and(|id| id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn metadata_at(parent: &File, name: &str) -> Result<libc::stat> {
    let name = CString::new(name)?;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    let result = unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(unsafe { stat.assume_init() })
}

fn link_at(parent: &File, name: &str) -> Result<Vec<u8>> {
    let name = CString::new(name)?;
    let mut bytes = vec![0_u8; 16_384];
    let count = unsafe {
        libc::readlinkat(
            parent.as_raw_fd(),
            name.as_ptr(),
            bytes.as_mut_ptr().cast(),
            bytes.len(),
        )
    };
    if count < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    ensure!(
        (count as usize) < bytes.len(),
        "symlink target exceeds capture limit"
    );
    bytes.truncate(count as usize);
    Ok(bytes)
}

struct DirectoryEntries(*mut libc::DIR);
impl Drop for DirectoryEntries {
    fn drop(&mut self) {
        unsafe {
            libc::closedir(self.0);
        }
    }
}

fn names(directory: &File) -> Result<Vec<String>> {
    bounded_names(directory, usize::MAX)
}

fn bounded_names(directory: &File, maximum: usize) -> Result<Vec<String>> {
    let descriptor = unsafe { libc::dup(directory.as_raw_fd()) };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let pointer = unsafe { libc::fdopendir(descriptor) };
    if pointer.is_null() {
        unsafe {
            libc::close(descriptor);
        }
        return Err(std::io::Error::last_os_error().into());
    }
    let entries = DirectoryEntries(pointer);
    let mut names = vec![];
    loop {
        unsafe {
            *errno_pointer() = 0;
        }
        let entry = unsafe { libc::readdir(entries.0) };
        if entry.is_null() {
            let error = std::io::Error::last_os_error();
            ensure!(
                error.raw_os_error() == Some(0),
                "read workspace directory: {error}"
            );
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }
            .to_str()
            .context("workspace filename is not UTF-8")?;
        if name != "." && name != ".." {
            ensure!(
                names.len() < maximum,
                "output enumeration exceeds its limit"
            );
            names.push(name.to_owned());
        }
    }
    names.sort();
    Ok(names)
}

#[cfg(target_os = "macos")]
unsafe fn errno_pointer() -> *mut libc::c_int {
    unsafe { libc::__error() }
}
#[cfg(target_os = "linux")]
unsafe fn errno_pointer() -> *mut libc::c_int {
    unsafe { libc::__errno_location() }
}

/// Sync owned regular files and directory entries without following symlinks.
///
/// Each entry gets a plain `fsync`, and the root one `sync_all` last. On macOS `sync_all` is
/// `F_FULLFSYNC`, which also flushes the drive's cache of every earlier write, so one barrier
/// covers the whole tree. A barrier per file costs about 10 ms each: tens of seconds for a
/// checkout of a few thousand files.
pub(crate) fn sync_tree(path: &Path) -> Result<()> {
    fn fsync(file: &File) -> Result<()> {
        // SAFETY: fsync reads only the descriptor, which `file` keeps open.
        if unsafe { libc::fsync(file.as_raw_fd()) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
    fn sync(directory: &File) -> Result<()> {
        for name in names(directory)? {
            let stat = metadata_at(directory, &name)?;
            match stat.st_mode & libc::S_IFMT {
                libc::S_IFDIR => sync(&open_dir_at(directory, &name)?)?,
                libc::S_IFREG => {
                    let name = CString::new(name)?;
                    let fd = unsafe {
                        libc::openat(
                            directory.as_raw_fd(),
                            name.as_ptr(),
                            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                        )
                    };
                    if fd < 0 {
                        return Err(std::io::Error::last_os_error().into());
                    }
                    fsync(&unsafe { File::from_raw_fd(fd) })?;
                }
                libc::S_IFLNK => {}
                _ => bail!("owned workspace contains a special file"),
            }
        }
        fsync(directory)
    }
    let root = open_root(path)?;
    sync(&root)?;
    root.sync_all()?;
    Ok(())
}

/// [`sync_tree`] on a blocking thread, so an async caller's other work (such as keeping its
/// execution lease) goes on while a large tree syncs.
pub(crate) async fn sync_tree_off_runtime(path: PathBuf) -> Result<()> {
    tokio::task::spawn_blocking(move || sync_tree(&path))
        .await
        .context("tree sync stopped")?
}

/// What a walk found at one path.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Found {
    /// A regular file, and whether anyone may execute it.
    File {
        executable: bool,
    },
    Link,
    /// A directory; the visitor answers whether to walk into it.
    Directory,
    /// A socket, device, or named pipe.
    Special,
}

/// One entry of a walk: its path relative to the walk's root, and its open parent directory.
pub(crate) struct Entry<'a> {
    pub path: &'a str,
    pub found: Found,
    parent: &'a File,
    name: &'a str,
}

impl Entry<'_> {
    /// The target of a symbolic link.
    pub(crate) fn link(&self) -> Result<Vec<u8>> {
        link_at(self.parent, self.name)
    }

    /// Removes the file or link, never a directory.
    pub(crate) fn remove(&self) -> Result<()> {
        let name = CString::new(self.name)?;
        if unsafe { libc::unlinkat(self.parent.as_raw_fd(), name.as_ptr(), 0) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
}

/// Walks the checkout at `root` in name order without following links, calling `visit` for
/// every entry except the root's `.git` and the paths in `skip`, and walking into a directory
/// only when `visit` answers `true` for it. Only the names of the directories on the way to the
/// current entry are held, so a checkout of any size can be walked.
pub(crate) fn walk(
    root: &Path,
    skip: &[String],
    cancel: &CancellationToken,
    visit: &mut dyn FnMut(&Entry<'_>) -> Result<bool>,
) -> Result<()> {
    fn directory(
        directory: &File,
        prefix: &str,
        depth: usize,
        skip: &[String],
        cancel: &CancellationToken,
        visit: &mut dyn FnMut(&Entry<'_>) -> Result<bool>,
    ) -> Result<()> {
        ensure!(
            depth <= 128,
            "workspace directory nesting exceeds capture limit"
        );
        for name in names(directory)? {
            super::check_cancelled(cancel)?;
            if prefix.is_empty() && name.eq_ignore_ascii_case(".git") {
                continue;
            }
            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if skip.contains(&path) {
                continue;
            }
            validate_repo_path(&path)?;
            let metadata = metadata_at(directory, &name)?;
            let found = match metadata.st_mode & libc::S_IFMT {
                libc::S_IFDIR => Found::Directory,
                libc::S_IFREG => Found::File {
                    executable: metadata.st_mode & 0o111 != 0,
                },
                libc::S_IFLNK => Found::Link,
                _ => Found::Special,
            };
            let enter = visit(&Entry {
                path: &path,
                found,
                parent: directory,
                name: &name,
            })?;
            if found == Found::Directory && enter {
                directory_at(directory, &name, &path, depth, skip, cancel, visit)?;
            }
        }
        Ok(())
    }
    fn directory_at(
        parent: &File,
        name: &str,
        path: &str,
        depth: usize,
        skip: &[String],
        cancel: &CancellationToken,
        visit: &mut dyn FnMut(&Entry<'_>) -> Result<bool>,
    ) -> Result<()> {
        directory(
            &open_dir_at(parent, name)?,
            path,
            depth + 1,
            skip,
            cancel,
            visit,
        )
    }
    directory(&open_root(root)?, "", 0, skip, cancel, visit)
}

/// A checkout holds more files than the scan's caller can account for.
#[derive(Debug)]
pub(crate) struct TooManyFiles(pub usize);

impl std::fmt::Display for TooManyFiles {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "the checkout holds more than {} files", self.0)
    }
}

impl std::error::Error for TooManyFiles {}

/// Every file and link of the checkout at `root`, with its Git mode, except what is under
/// `skip` (paths relative to `root`). The caller says how many it can account for: the files a
/// commit tracks, or those and what one delivery may add. A checkout holding more fails with
/// [`TooManyFiles`] instead of being listed whole.
pub(crate) fn scan(
    root: &Path,
    skip: &[String],
    maximum: usize,
    cancel: &CancellationToken,
) -> Result<BTreeMap<String, String>> {
    let mut files = BTreeMap::new();
    walk(root, skip, cancel, &mut |entry| {
        match entry.found {
            Found::Directory => return Ok(true),
            Found::File { executable } => {
                files.insert(
                    entry.path.to_owned(),
                    if executable { "100755" } else { "100644" }.to_owned(),
                );
            }
            Found::Link => {
                validate_link(entry.path, &entry.link()?)?;
                files.insert(entry.path.to_owned(), "120000".to_owned());
            }
            Found::Special => bail!("workspace contains a special file: {}", entry.path),
        }
        if files.len() > maximum {
            return Err(TooManyFiles(maximum).into());
        }
        Ok(false)
    })?;
    Ok(files)
}

/// Checks that `path` is a regular file with no other link, without following a link to it and
/// without reading it: a checkout's index grows with the files it tracks.
pub(crate) fn verify_private_file(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        verify_directory(parent)?;
    }
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_file() && metadata.nlink() == 1,
        "expected a regular file without external hard links"
    );
    Ok(())
}

/// The device, inode, and link count of a regular checkout file, without following links.
/// `None` for anything else.
pub(crate) fn file_identity(root: &Path, path: &str) -> Result<Option<(u64, u64, u64)>> {
    validate_repo_path(path)?;
    let directory = checkout_parent(root, path)?;
    let name = path.rsplit('/').next().context("missing filename")?;
    let metadata = metadata_at(&directory, name)?;
    Ok(
        (metadata.st_mode & libc::S_IFMT == libc::S_IFREG).then_some((
            metadata.st_dev as u64,
            metadata.st_ino as u64,
            metadata.st_nlink as u64,
        )),
    )
}

pub(crate) fn read_checkout_file(root: &Path, path: &str) -> Result<CapturedFile> {
    validate_repo_path(path)?;
    let directory = checkout_parent(root, path)?;
    let name = path.rsplit('/').next().context("missing filename")?;
    let metadata = metadata_at(&directory, name)?;
    match metadata.st_mode & libc::S_IFMT {
        libc::S_IFLNK => {
            let bytes = link_at(&directory, name)?;
            validate_link(path, &bytes)?;
            Ok(CapturedFile {
                mode: "120000".into(),
                bytes,
            })
        }
        libc::S_IFREG => {
            let file = open_file_at(&directory, name)?;
            let mode = if file.metadata()?.mode() & 0o111 != 0 {
                "100755"
            } else {
                "100644"
            };
            Ok(CapturedFile {
                mode: mode.into(),
                bytes: read_file(file, 67_108_864)?,
            })
        }
        _ => bail!("workspace file changed type during capture: {path}"),
    }
}

/// A checkout file's mode, Git blob ID, and size, read as [`read_checkout_file`] reads it but
/// hashed a block at a time, so a file of any size takes no more memory than one block. A
/// monorepo tracks files larger than any capture bound; only a changed file's bytes are kept.
pub(crate) struct HashedFile {
    pub mode: String,
    pub oid: String,
    pub size: u64,
}

pub(crate) fn hash_checkout_file(root: &Path, path: &str, oid_length: usize) -> Result<HashedFile> {
    validate_repo_path(path)?;
    let directory = checkout_parent(root, path)?;
    let name = path.rsplit('/').next().context("missing filename")?;
    let metadata = metadata_at(&directory, name)?;
    match metadata.st_mode & libc::S_IFMT {
        libc::S_IFLNK => {
            let bytes = link_at(&directory, name)?;
            validate_link(path, &bytes)?;
            Ok(HashedFile {
                mode: "120000".into(),
                oid: crate::git::blob_oid(&bytes, oid_length),
                size: bytes.len() as u64,
            })
        }
        libc::S_IFREG => {
            let file = open_file_at(&directory, name)?;
            let before = file.metadata()?;
            ensure!(
                before.is_file() && before.nlink() == 1,
                "capture requires a regular file without external hard links"
            );
            let mut hasher = crate::git::BlobHasher::new(oid_length, before.len());
            let mut block = vec![0; 1 << 20];
            let mut read = 0_u64;
            loop {
                let count = (&file).read(&mut block)?;
                if count == 0 {
                    break;
                }
                read += count as u64;
                ensure!(
                    read <= before.len(),
                    "file changed during capture; stop the adapter before finalizing"
                );
                hasher.update(&block[..count]);
            }
            let after = file.metadata()?;
            ensure!(
                before.len() == after.len()
                    && before.mtime() == after.mtime()
                    && before.mtime_nsec() == after.mtime_nsec()
                    && read == after.len(),
                "file changed during capture; stop the adapter before finalizing"
            );
            Ok(HashedFile {
                mode: if before.mode() & 0o111 != 0 {
                    "100755"
                } else {
                    "100644"
                }
                .into(),
                oid: hasher.finish(),
                size: read,
            })
        }
        _ => bail!("workspace file changed type during capture: {path}"),
    }
}

#[cfg(test)]
mod artifact_tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn a_scan_stops_at_what_its_caller_can_account_for_and_a_walk_holds_nothing() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let root = dir.path().canonicalize()?;
        fs::create_dir_all(root.join("src/deep"))?;
        fs::create_dir_all(root.join(".git"))?;
        fs::create_dir_all(root.join("node_modules/package"))?;
        for path in [
            "a",
            "src/b",
            "src/deep/c",
            ".git/HEAD",
            "node_modules/package/d",
        ] {
            fs::write(root.join(path), path)?;
        }
        symlink("a", root.join("link"))?;
        let cancel = CancellationToken::new();
        let skip = ["node_modules".to_owned()];
        let files = scan(&root, &skip, 4, &cancel)?;
        assert_eq!(
            files.keys().map(String::as_str).collect::<Vec<_>>(),
            ["a", "link", "src/b", "src/deep/c"]
        );
        let error = scan(&root, &skip, 3, &cancel).unwrap_err();
        assert_eq!(
            error.downcast_ref::<TooManyFiles>().map(|limit| limit.0),
            Some(3)
        );
        // A walk removes what its visitor chooses as it goes, and stays out of what it is told.
        let mut seen = vec![];
        walk(&root, &[], &cancel, &mut |entry| {
            seen.push(entry.path.to_owned());
            if entry.path == "src/b" || entry.path == "link" {
                entry.remove()?;
            }
            Ok(entry.path != "node_modules")
        })?;
        assert_eq!(
            seen,
            [
                "a",
                "link",
                "node_modules",
                "src",
                "src/b",
                "src/deep",
                "src/deep/c"
            ]
        );
        assert!(!root.join("src/b").exists() && fs::symlink_metadata(root.join("link")).is_err());
        assert!(root.join("node_modules/package/d").exists());
        Ok(())
    }

    #[test]
    fn captures_only_bounded_regular_files_under_the_owned_checkout() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let root = dir.path().canonicalize()?.join("checkout");
        let outside = root.with_file_name("outside");
        fs::create_dir(&root)?;
        fs::create_dir(&outside)?;
        fs::write(outside.join("secret"), b"private")?;
        fs::write(root.join("report"), b"report")?;
        symlink(&outside, root.join("link"))?;
        symlink(outside.join("secret"), root.join("file-link"))?;
        fs::hard_link(outside.join("secret"), root.join("hard-link"))?;

        assert_eq!(read_artifact_file(&root, "report", 6)?, b"report");
        assert!(read_artifact_file(&root, "report", 5).is_err());
        for path in ["link/secret", "file-link", "hard-link", "../outside/secret"] {
            assert!(read_artifact_file(&root, path, 16).is_err(), "{path}");
        }
        assert!(read_artifact_file(&root.join("link"), "secret", 16).is_err());
        Ok(())
    }
}
