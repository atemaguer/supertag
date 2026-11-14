//! Bounded, descriptor-relative Skill package capture shared by native adapters.
use anyhow::{Context, Result, bail, ensure};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::{CStr, CString},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Component, Path},
};
use tokio_util::sync::CancellationToken;

pub const MAX_FILES: usize = 2048;
pub const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 4096;

pub struct PackageFile {
    pub mode: u32,
    pub bytes: Vec<u8>,
}
pub struct Package {
    pub digest: String,
    pub files: BTreeMap<String, PackageFile>,
    pub directories: Vec<String>,
}

/// Open every path component relative to an already-open descriptor. The final
/// directory and its ancestors must not be links, even if a name changes mid-walk.
pub fn open_directory(path: &Path) -> Result<File> {
    ensure!(path.is_absolute(), "context path must be absolute");
    let mut directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open("/")?;
    for part in path.components() {
        match part {
            Component::RootDir => {}
            Component::Normal(part) => {
                directory = open_at(
                    &directory,
                    part.to_str().context("context path is not UTF-8")?,
                    true,
                )?;
            }
            _ => bail!("context path contains traversal"),
        }
    }
    Ok(directory)
}
fn open_at(parent: &File, name: &str, directory: bool) -> Result<File> {
    let name = CString::new(name)?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY
                | libc::O_NOFOLLOW
                | libc::O_NONBLOCK
                | libc::O_CLOEXEC
                | if directory { libc::O_DIRECTORY } else { 0 },
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
struct Entries(*mut libc::DIR);
impl Drop for Entries {
    fn drop(&mut self) {
        unsafe {
            libc::closedir(self.0);
        }
    }
}
#[cfg(target_os = "macos")]
unsafe fn errno() -> *mut libc::c_int {
    unsafe { libc::__error() }
}
#[cfg(target_os = "linux")]
unsafe fn errno() -> *mut libc::c_int {
    unsafe { libc::__errno_location() }
}

pub fn directory_names(directory: &File, maximum: usize) -> Result<Vec<String>> {
    // openat(".") gives an independent offset; dup would share directory position.
    let independent = open_at(directory, ".", true)?;
    let fd = unsafe { libc::dup(independent.as_raw_fd()) };
    ensure!(fd >= 0, "cannot duplicate context directory descriptor");
    let raw = unsafe { libc::fdopendir(fd) };
    if raw.is_null() {
        unsafe {
            libc::close(fd);
        }
        return Err(std::io::Error::last_os_error().into());
    }
    let entries = Entries(raw);
    let mut names = vec![];
    loop {
        unsafe {
            *errno() = 0;
        }
        let entry = unsafe { libc::readdir(entries.0) };
        if entry.is_null() {
            ensure!(
                unsafe { *errno() } == 0,
                "cannot enumerate context directory"
            );
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }
            .to_str()
            .context("context filename is not UTF-8")?;
        if matches!(name, "." | "..") {
            continue;
        }
        ensure!(
            names.len() < maximum,
            "context directory exceeds entry limit"
        );
        names.push(name.into());
    }
    // Match the legacy JavaScript code-unit order, including non-BMP names.
    names.sort_by_cached_key(|name: &String| name.encode_utf16().collect::<Vec<_>>());
    Ok(names)
}
pub fn read_regular_at(parent: &File, name: &str, maximum: usize) -> Result<Vec<u8>> {
    Ok(read_file(open_at(parent, name, false)?, maximum)?.bytes)
}
fn read_file(mut file: File, maximum: usize) -> Result<PackageFile> {
    let before = file.metadata()?;
    ensure!(
        before.is_file() && before.nlink() == 1,
        "context requires regular files without hard links"
    );
    ensure!(
        before.len() <= maximum as u64,
        "context package exceeds byte limit"
    );
    let mut bytes = Vec::new();
    (&mut file)
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    ensure!(
        bytes.len() <= maximum
            && before.len() == after.len()
            && bytes.len() as u64 == after.len()
            && before.mode() == after.mode()
            && before.mtime() == after.mtime()
            && before.mtime_nsec() == after.mtime_nsec()
            && before.ctime() == after.ctime()
            && before.ctime_nsec() == after.ctime_nsec(),
        "context file changed while being captured"
    );
    Ok(PackageFile {
        mode: before.mode() & 0o777,
        bytes,
    })
}
pub fn capture(root: &Path, cancel: &CancellationToken) -> Result<Package> {
    let root = open_directory(root)?;
    let mut capture = Capture {
        package: Package {
            digest: String::new(),
            files: BTreeMap::new(),
            directories: vec![],
        },
        hash: Sha256::new(),
        bytes: 0,
        entries: 0,
        cancel,
    };
    capture.visit(&root, "", 0)?;
    ensure!(
        capture.package.files.contains_key("SKILL.md"),
        "Skill package requires a regular SKILL.md"
    );
    capture.package.digest = format!("sha256:{:x}", capture.hash.finalize());
    Ok(capture.package)
}
struct Capture<'a> {
    package: Package,
    hash: Sha256,
    bytes: usize,
    entries: usize,
    cancel: &'a CancellationToken,
}
impl Capture<'_> {
    fn visit(&mut self, directory: &File, prefix: &str, depth: usize) -> Result<()> {
        ensure!(!self.cancel.is_cancelled(), "context capture cancelled");
        ensure!(depth <= 32, "context package nesting exceeds limit");
        let before = directory.metadata()?;
        let names = directory_names(directory, MAX_ENTRIES - self.entries)?;
        self.hash.update(format!("directory\0{prefix}\0"));
        self.package.directories.push(prefix.into());
        for name in &names {
            ensure!(!self.cancel.is_cancelled(), "context capture cancelled");
            self.entries += 1;
            ensure!(
                self.entries <= MAX_ENTRIES,
                "context package exceeds entry limit"
            );
            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            validate_path(&path)?;
            let file = open_at(directory, name, false)?;
            let metadata = file.metadata()?;
            if metadata.is_dir() {
                self.visit(&file, &path, depth + 1)?;
            } else {
                ensure!(
                    self.package.files.len() < MAX_FILES,
                    "context package exceeds file limit"
                );
                let file = read_file(file, MAX_BYTES - self.bytes)?;
                self.bytes += file.bytes.len();
                self.hash.update(format!(
                    "file\0{path}\0{}\0{}\0",
                    file.mode,
                    file.bytes.len()
                ));
                self.hash.update(&file.bytes);
                self.hash.update([0]);
                self.package.files.insert(path, file);
            }
        }
        let after = directory.metadata()?;
        ensure!(
            before.mtime() == after.mtime()
                && before.mtime_nsec() == after.mtime_nsec()
                && before.ctime() == after.ctime()
                && before.ctime_nsec() == after.ctime_nsec()
                && names == directory_names(directory, MAX_ENTRIES)?,
            "context directory changed while being captured"
        );
        Ok(())
    }
}
fn validate_path(path: &str) -> Result<()> {
    ensure!(
        path.len() <= 1024
            && !path.contains('\\')
            && !path.chars().any(char::is_control)
            && !path
                .split('/')
                .any(|s| s.is_empty() || matches!(s, "." | "..")),
        "unsafe context package path"
    );
    Ok(())
}

/// Create one new private copy. Existing destinations are never overwritten.
/// The caller owns the parent directory and must keep it outside native writes.
pub fn materialize(
    package: &Package,
    destination: &Path,
    cancel: &CancellationToken,
) -> Result<()> {
    let parent = destination
        .parent()
        .context("context destination has no parent")?;
    open_directory(parent)?;
    ensure!(!cancel.is_cancelled(), "context materialization cancelled");
    fs::create_dir(destination)?;
    fs::set_permissions(destination, fs::Permissions::from_mode(0o700))?;
    let result = (|| {
        for directory in &package.directories {
            if directory.is_empty() {
                continue;
            }
            validate_path(directory)?;
            ensure!(!cancel.is_cancelled(), "context materialization cancelled");
            fs::create_dir(destination.join(directory))?;
        }
        for (path, file) in &package.files {
            validate_path(path)?;
            ensure!(!cancel.is_cancelled(), "context materialization cancelled");
            let mut target = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(destination.join(path))?;
            target.write_all(&file.bytes)?;
            target.set_permissions(fs::Permissions::from_mode(file.mode))?;
            target.sync_all()?;
        }
        ensure!(
            capture(destination, cancel)?.digest == package.digest,
            "context copy differs from its captured package"
        );
        File::open(destination)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(destination);
    }
    result
}
