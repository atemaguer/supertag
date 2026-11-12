//! Descriptor-relative reads prevent parent-directory symlinks from redirecting capture.

use anyhow::{Context, Result, bail, ensure};
use std::{
    collections::BTreeMap,
    ffi::{CStr, CString},
    fs::{self, DirBuilder, File, OpenOptions},
    io::Read,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
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
        "file exceeds capture size limit"
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

fn open_dir_at(parent: &File, name: &str) -> Result<File> {
    let name = CString::new(name)?;
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
    verify_directory(path)?;
    Ok(OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?)
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
pub(crate) fn sync_tree(path: &Path) -> Result<()> {
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
                    unsafe { File::from_raw_fd(fd) }.sync_all()?;
                }
                libc::S_IFLNK => {}
                _ => bail!("owned workspace contains a special file"),
            }
        }
        directory.sync_all()?;
        Ok(())
    }
    sync(&open_root(path)?)
}

pub(crate) fn scan(root: &Path, cancel: &CancellationToken) -> Result<BTreeMap<String, String>> {
    fn visit(
        directory: &File,
        prefix: &str,
        depth: usize,
        output: &mut BTreeMap<String, String>,
        cancel: &CancellationToken,
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
            validate_repo_path(&path)?;
            let metadata = metadata_at(directory, &name)?;
            match metadata.st_mode & libc::S_IFMT {
                libc::S_IFDIR => visit(
                    &open_dir_at(directory, &name)?,
                    &path,
                    depth + 1,
                    output,
                    cancel,
                )?,
                libc::S_IFREG => {
                    output.insert(
                        path,
                        if metadata.st_mode & 0o111 != 0 {
                            "100755"
                        } else {
                            "100644"
                        }
                        .into(),
                    );
                }
                libc::S_IFLNK => {
                    validate_link(&path, &link_at(directory, &name)?)?;
                    output.insert(path, "120000".into());
                }
                _ => bail!("workspace contains a special file: {path}"),
            }
            ensure!(
                output.len() <= 100_000,
                "workspace file count exceeds capture limit"
            );
        }
        Ok(())
    }
    let mut files = BTreeMap::new();
    visit(&open_root(root)?, "", 0, &mut files, cancel)?;
    Ok(files)
}

pub(crate) fn read_checkout_file(root: &Path, path: &str) -> Result<CapturedFile> {
    validate_repo_path(path)?;
    let mut directory = open_root(root)?;
    let parts: Vec<_> = path.split('/').collect();
    for name in &parts[..parts.len() - 1] {
        directory = open_dir_at(&directory, name)?;
    }
    let name = parts.last().context("missing filename")?;
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
            let name = CString::new(*name)?;
            let descriptor = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
                )
            };
            if descriptor < 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            let file = unsafe { File::from_raw_fd(descriptor) };
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
