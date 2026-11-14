use std::{
    ffi::{CStr, CString},
    fs::{self, File},
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Component, Path, PathBuf},
};

use anyhow::{Context, Result, ensure};
use uuid::Uuid;

use crate::v2::{FileContent, FileWritten, ReadFile, WriteFile};

pub(crate) const MAX_FILE_BYTES: usize = 256 * 1024;

#[derive(Debug)]
pub(crate) struct PublishedWithoutSync;

impl std::fmt::Display for PublishedWithoutSync {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("shared file publication could not be synchronized")
    }
}

impl std::error::Error for PublishedWithoutSync {}

pub(crate) struct Root {
    pub(crate) path: PathBuf,
    pub(crate) identity: (u64, u64),
    directory: File,
    workload: Option<(u32, u32)>,
}

impl Root {
    pub(crate) fn open(path: &Path, workload: Option<(u32, u32)>) -> Result<Self> {
        let directory = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_DIRECTORY)
            .open(path)
            .context("open fixed execution root")?;
        let metadata = directory.metadata()?;
        let path = path.canonicalize()?;
        let current = fs::metadata(&path)?;
        ensure!(
            metadata.dev() == current.dev() && metadata.ino() == current.ino(),
            "fixed execution root changed while opening"
        );
        if let Some((uid, gid)) = workload {
            let parent = fs::metadata(path.parent().context("fixed root has no parent")?)?;
            ensure!(
                parent.uid() != uid
                    && parent.mode() & 0o002 == 0
                    && (parent.gid() != gid || parent.mode() & 0o020 == 0),
                "fixed execution root parent must be protected from the workload identity"
            );
        }
        Ok(Self {
            path,
            identity: (metadata.dev(), metadata.ino()),
            directory,
            workload,
        })
    }

    pub(crate) fn lock(&self) -> Result<()> {
        self.directory
            .try_lock()
            .context("fixed execution root already has an owner")?;
        Ok(())
    }

    pub(crate) fn read(&self, request: ReadFile) -> Result<FileContent> {
        let maximum = request.maximum_bytes as usize;
        ensure!(
            (1..=MAX_FILE_BYTES).contains(&maximum),
            "file read limit is invalid"
        );
        let (parent, name) = self.parent(&request.path, false)?;
        let file = open_at(&parent, &name, libc::O_RDONLY | libc::O_NONBLOCK, 0)?;
        let metadata = regular(&file)?;
        ensure!(metadata.len() <= maximum as u64, "file exceeds read bound");
        let mut content = Vec::new();
        file.take(maximum as u64 + 1).read_to_end(&mut content)?;
        ensure!(content.len() <= maximum, "file exceeds read bound");
        Ok(FileContent { content })
    }

    pub(crate) fn write(&self, request: WriteFile, stage: bool) -> Result<FileWritten> {
        ensure!(
            request.content.len() <= MAX_FILE_BYTES && (!stage || !request.overwrite),
            "file write exceeds accepted bounds"
        );
        let (parent, name) = self.parent(&request.path, true)?;
        let existing = match open_at(&parent, &name, libc::O_RDONLY | libc::O_NONBLOCK, 0) {
            Ok(file) => {
                regular(&file)?;
                true
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.into()),
        };
        if existing && stage {
            return Ok(FileWritten {
                bytes: 0,
                created: false,
            });
        }
        ensure!(!existing || request.overwrite, "destination file exists");
        let temporary = CString::new(format!(".supertag-write-{}", Uuid::new_v4().simple()))?;
        let mut published = false;
        let outcome = (|| -> Result<FileWritten> {
            let mut file = open_at(
                &parent,
                &temporary,
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
                0o600,
            )?;
            file.write_all(&request.content)?;
            change_owner(&file, self.workload)?;
            file.sync_all()?;
            let parent_fd = parent.as_raw_fd();
            // SAFETY: both relative names and the pinned parent directory remain live for the call.
            let moved = unsafe {
                if request.overwrite {
                    libc::renameat(parent_fd, temporary.as_ptr(), parent_fd, name.as_ptr())
                } else {
                    libc::linkat(parent_fd, temporary.as_ptr(), parent_fd, name.as_ptr(), 0)
                }
            };
            if moved != 0 {
                let error = io::Error::last_os_error();
                if stage && error.kind() == io::ErrorKind::AlreadyExists {
                    let file = open_at(&parent, &name, libc::O_RDONLY | libc::O_NONBLOCK, 0)?;
                    regular(&file)?;
                    return Ok(FileWritten {
                        bytes: 0,
                        created: false,
                    });
                }
                return Err(error.into());
            }
            published = true;
            Ok(FileWritten {
                bytes: request.content.len() as u32,
                created: !existing,
            })
        })();
        // SAFETY: removes only the private temporary name in the pinned parent directory.
        unsafe { libc::unlinkat(parent.as_raw_fd(), temporary.as_ptr(), 0) };
        if let Err(error) = parent.sync_all() {
            if published {
                return Err(PublishedWithoutSync.into());
            }
            return Err(error.into());
        }
        outcome
    }

    pub(crate) fn directory(&self, path: &str) -> Result<File> {
        if matches!(path, "" | ".") {
            return Ok(self.directory.try_clone()?);
        }
        self.walk(parts(path)?, false)
    }

    fn parent(&self, path: &str, create: bool) -> Result<(File, CString)> {
        let mut names = parts(path)?;
        let name = names.pop().context("file path required")?;
        Ok((self.walk(names, create)?, name))
    }

    fn walk(&self, names: Vec<CString>, create: bool) -> Result<File> {
        let mut directory = self.directory.try_clone()?;
        for name in names {
            directory = match open_at(&directory, &name, libc::O_RDONLY | libc::O_DIRECTORY, 0) {
                Ok(next) => next,
                Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
                    // SAFETY: pinned directory FD and validated single path component.
                    let created =
                        unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o700) } == 0;
                    if !created && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists
                    {
                        return Err(io::Error::last_os_error().into());
                    }
                    let next = open_at(&directory, &name, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
                    if created {
                        change_owner(&next, self.workload)?;
                        directory.sync_all()?;
                    }
                    next
                }
                Err(error) => return Err(error.into()),
            };
        }
        Ok(directory)
    }
}

fn parts(path: &str) -> Result<Vec<CString>> {
    ensure!(
        !path.is_empty() && path.len() <= 1024 && !path.contains('\\'),
        "invalid relative path"
    );
    let names = Path::new(path)
        .components()
        .map(|component| {
            let Component::Normal(value) = component else {
                anyhow::bail!("path must stay inside the fixed root");
            };
            Ok(CString::new(value.as_encoded_bytes())?)
        })
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        !names.is_empty() && names.len() <= 32,
        "invalid relative path depth"
    );
    Ok(names)
}

fn open_at(directory: &File, name: &CStr, flags: i32, mode: libc::c_uint) -> io::Result<File> {
    // SAFETY: `directory` is live, `name` is NUL-terminated and mode is supplied for O_CREAT.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            mode,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `openat` returned a fresh descriptor transferred to File.
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn regular(file: &File) -> Result<fs::Metadata> {
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.nlink() == 1,
        "expected a regular file without links"
    );
    Ok(metadata)
}

fn change_owner(file: &File, workload: Option<(u32, u32)>) -> io::Result<()> {
    if let Some((uid, gid)) = workload {
        // SAFETY: the descriptor remains valid and was freshly created in the root.
        if unsafe { libc::fchown(file.as_raw_fd(), uid, gid) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}
