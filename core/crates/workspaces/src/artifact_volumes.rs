//! A file artifact Volume: an owner-only directory holding one immutable object per
//! `attempts/{attempt}/sha256/{sha256}` key. The Control Plane's API tier and Worker Hosts that map
//! the same directory both read and write it through this module, so an object written by one is
//! exactly what the other verifies.
use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use std::{
    ffi::CString,
    fs::File,
    io::{ErrorKind, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::MetadataExt,
    },
    path::{Path, PathBuf},
    sync::Arc,
};
use supertag_protocol::{
    CHECKPOINT_CHUNK_BYTES, MAX_CHECKPOINT_BYTES, artifacts::MAX_ARTIFACT_FILE_BYTES,
    v2::BlobReference, volumes::file_volume_path,
};

/// The largest object a Volume holds: a capture file or a Session checkpoint.
pub const MAX_VOLUME_OBJECT_BYTES: u64 = if MAX_CHECKPOINT_BYTES as u64 > MAX_ARTIFACT_FILE_BYTES {
    MAX_CHECKPOINT_BYTES as u64
} else {
    MAX_ARTIFACT_FILE_BYTES
};

use crate::packages::open_directory;

/// A mapped file artifact Volume.
#[derive(Clone)]
pub struct FileVolume {
    /// The canonical `file://` source this directory serves.
    pub source: String,
    pub root: PathBuf,
    directory: Arc<File>,
}

/// The object is not on the Volume and no bytes were given to write it.
#[derive(Debug)]
pub struct MissingObject;
impl std::fmt::Display for MissingObject {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("artifact Volume object is missing")
    }
}
impl std::error::Error for MissingObject {}

impl FileVolume {
    /// Opens an owner-only, canonical directory as a file artifact Volume.
    pub fn open(path: &Path) -> Result<Self> {
        let metadata = path
            .symlink_metadata()
            .context("open artifact Volume mapping")?;
        ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "artifact Volume mapping must be a directory, not a link"
        );
        // Resolve trusted platform aliases once, before accepting traffic.
        let root = path.canonicalize()?;
        let directory = open_directory(&root)?;
        private_directory(&directory)?;
        let opened = directory.metadata()?;
        ensure!(
            metadata.dev() == opened.dev() && metadata.ino() == opened.ino(),
            "artifact Volume mapping changed during configuration"
        );
        let source = url::Url::from_file_path(&root)
            .map_err(|_| anyhow::anyhow!("invalid artifact Volume path"))?
            .to_string();
        file_volume_path(&source)?;
        Ok(Self {
            source,
            root,
            directory: Arc::new(directory),
        })
    }

    /// Whether the two Volumes' directories nest.
    pub fn overlaps(&self, other: &Self) -> bool {
        self.root.starts_with(&other.root) || other.root.starts_with(&self.root)
    }
}

fn private_directory(file: &File) -> Result<()> {
    let meta = file.metadata()?;
    ensure!(
        meta.is_dir() && meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o077 == 0,
        "artifact Volume directories must be owner-only"
    );
    Ok(())
}
fn current(mapping: &FileVolume) -> Result<()> {
    let observed = open_directory(&mapping.root)?;
    private_directory(&observed)?;
    let a = observed.metadata()?;
    let b = mapping.directory.metadata()?;
    ensure!(
        a.dev() == b.dev() && a.ino() == b.ino(),
        "artifact Volume mapping changed"
    );
    Ok(())
}
fn child_directory(parent: &File, name: &str, create: bool) -> Result<File> {
    let name = CString::new(name)?;
    if create {
        let result = unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) };
        if result < 0 && std::io::Error::last_os_error().kind() != ErrorKind::AlreadyExists {
            return Err(std::io::Error::last_os_error().into());
        }
        parent.sync_all()?;
    }
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let file = unsafe { File::from_raw_fd(fd) };
    private_directory(&file)?;
    Ok(file)
}
/// The segments of an object key the Control Plane derived: `tags/<sha256(tag)>/…/<sha256>`, at
/// most 8 segments of letters, digits, `-` and `_`, ending with the object's own SHA-256.
pub fn key_parts<'a>(key: &'a str, blob: &BlobReference) -> Result<Vec<&'a str>> {
    let parts: Vec<&str> = key.split('/').collect();
    ensure!(
        supertag_protocol::valid_sha256(&blob.sha256)
            && blob.byte_length <= MAX_VOLUME_OBJECT_BYTES
            && (3..=8).contains(&parts.len())
            && parts[0] == "tags"
            && parts.last() == Some(&blob.sha256.as_str())
            && parts.iter().all(|part| {
                !part.is_empty()
                    && part.len() <= 128
                    && part
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
            }),
        "invalid Volume object key"
    );
    Ok(parts)
}
fn parent(mapping: &FileVolume, key: &str, blob: &BlobReference, create: bool) -> Result<File> {
    let parts = key_parts(key, blob)?;
    let mut directory = mapping.directory.try_clone()?;
    for part in &parts[..parts.len() - 1] {
        directory = child_directory(&directory, part, create)?;
    }
    Ok(directory)
}
pub fn verify_bytes(bytes: &[u8], blob: &BlobReference) -> Result<()> {
    ensure!(
        bytes.len() as u64 == blob.byte_length
            && format!("{:x}", Sha256::digest(bytes)) == blob.sha256,
        "artifact Volume bytes differ from the immutable receipt"
    );
    Ok(())
}
fn verify_at(parent: &File, blob: &BlobReference, mut output: impl Write) -> Result<()> {
    let name = CString::new(blob.sha256.clone())?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let before = file.metadata()?;
    ensure!(
        before.is_file()
            && before.nlink() == 1
            && before.uid() == unsafe { libc::geteuid() }
            && before.mode() & 0o077 == 0
            && before.len() == blob.byte_length,
        "artifact Volume object is not an owned regular file"
    );
    let mut bytes = vec![0; CHECKPOINT_CHUNK_BYTES];
    let mut digest = Sha256::new();
    let mut length = 0u64;
    loop {
        let size = file.read(&mut bytes)?;
        if size == 0 {
            break;
        }
        length += size as u64;
        ensure!(
            length <= blob.byte_length,
            "artifact Volume object exceeds its receipt"
        );
        digest.update(&bytes[..size]);
        output.write_all(&bytes[..size])?;
    }
    ensure!(
        length == blob.byte_length && format!("{:x}", digest.finalize()) == blob.sha256,
        "artifact Volume bytes differ from the immutable receipt"
    );
    let after = file.metadata()?;
    ensure!(
        before.len() == after.len()
            && before.mode() == after.mode()
            && before.mtime() == after.mtime()
            && before.mtime_nsec() == after.mtime_nsec()
            && before.ctime() == after.ctime()
            && before.ctime_nsec() == after.ctime_nsec(),
        "artifact Volume object changed during verification"
    );
    file.sync_all()?;
    parent.sync_all()?;
    Ok(())
}

struct Staged {
    parent: File,
    name: CString,
}
impl Drop for Staged {
    fn drop(&mut self) {
        unsafe { libc::unlinkat(self.parent.as_raw_fd(), self.name.as_ptr(), 0) };
    }
}
/// Writes `bytes` (relayed from the holding Worker Host) to the Volume, unless the exact object is
/// already there. Without `bytes`, only an existing verified object succeeds.
impl FileVolume {
    /// Writes `bytes` to `key` unless the exact object is already there, then reopens it from the
    /// registered root and verifies it. Without `bytes`, or when `may_write` is false (a copy
    /// already recorded Verified), only an existing exact object succeeds: a missing one fails
    /// with [`MissingObject`].
    pub fn persist(
        &self,
        key: &str,
        blob: &BlobReference,
        bytes: Option<&[u8]>,
        may_write: bool,
    ) -> Result<()> {
        let mapping = self;
        current(mapping)?;
        let destination = parent(mapping, key, blob, true)?;
        let final_name = CString::new(blob.sha256.clone())?;
        let exists = unsafe {
            libc::faccessat(
                destination.as_raw_fd(),
                final_name.as_ptr(),
                libc::F_OK,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if exists == 0 {
            verify_at(&destination, blob, std::io::sink())?;
        } else {
            if std::io::Error::last_os_error().kind() != ErrorKind::NotFound {
                return Err(std::io::Error::last_os_error().into());
            }
            // A previously verified receipt never silently repairs a missing copy.
            ensure!(may_write, "verified artifact Volume copy is missing");
            let bytes = bytes.ok_or(MissingObject)?;
            verify_bytes(bytes, blob)?;
            let staged_parent = destination.try_clone()?;
            let name = CString::new(format!(".copy-{}", uuid::Uuid::new_v4().simple()))?;
            let fd = unsafe {
                libc::openat(
                    destination.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o600,
                )
            };
            if fd < 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            let staged = Staged {
                parent: staged_parent,
                name,
            };
            let mut output = unsafe { File::from_raw_fd(fd) };
            output.write_all(bytes)?;
            output.sync_all()?;
            let result = unsafe {
                libc::linkat(
                    destination.as_raw_fd(),
                    staged.name.as_ptr(),
                    destination.as_raw_fd(),
                    final_name.as_ptr(),
                    0,
                )
            };
            if result < 0 && std::io::Error::last_os_error().kind() != ErrorKind::AlreadyExists {
                return Err(std::io::Error::last_os_error().into());
            }
            drop(staged);
            destination.sync_all()?;
        }
        // Reopen from the registered root, not only the descriptor used for staging.
        current(mapping)?;
        let reopened = parent(mapping, key, blob, false)?;
        verify_at(&reopened, blob, std::io::sink())?;
        current(mapping)?;
        Ok(())
    }

    /// Copies the exact object at `key` to `output`, verifying its length and SHA-256.
    pub fn read_verified(&self, key: &str, blob: &BlobReference, output: impl Write) -> Result<()> {
        current(self)?;
        let directory = parent(self, key, blob, false)?;
        verify_at(&directory, blob, output)?;
        current(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    const BYTES: &[u8] = b"verified evidence";

    fn fixture() -> (tempfile::TempDir, FileVolume, String, BlobReference) {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().canonicalize().unwrap().join("volume");
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let blob = BlobReference {
            sha256: format!("{:x}", Sha256::digest(BYTES)),
            byte_length: BYTES.len() as u64,
        };
        let key = format!(
            "tags/{}/attempts/producer/sha256/{}",
            "a".repeat(64),
            blob.sha256
        );
        (temporary, FileVolume::open(&path).unwrap(), key, blob)
    }

    #[test]
    fn writes_once_reopens_and_never_repairs_a_verified_object() {
        let (_temporary, volume, key, blob) = fixture();
        volume.persist(&key, &blob, Some(BYTES), true).unwrap();
        let stored = volume.root.join(&key);
        assert_eq!(std::fs::read(&stored).unwrap(), BYTES);
        // The exact object already there succeeds without bytes; a read verifies it.
        volume.persist(&key, &blob, None, false).unwrap();
        let mut read = Vec::new();
        volume.read_verified(&key, &blob, &mut read).unwrap();
        assert_eq!(read, BYTES);
        // Divergent bytes are never accepted or overwritten.
        std::fs::write(&stored, b"wrong").unwrap();
        assert!(volume.persist(&key, &blob, Some(BYTES), true).is_err());
        assert_eq!(std::fs::read(&stored).unwrap(), b"wrong");
        std::fs::remove_file(&stored).unwrap();
        // A missing object without bytes, or one recorded verified, is not silently written.
        assert!(
            volume
                .persist(&key, &blob, None, true)
                .unwrap_err()
                .is::<MissingObject>()
        );
        assert!(volume.persist(&key, &blob, Some(BYTES), false).is_err());
        assert!(volume.persist(&key, &blob, Some(b"other"), true).is_err());
    }

    #[test]
    fn keys_are_derived_shapes_and_links_never_receive_bytes() {
        let (temporary, volume, key, blob) = fixture();
        for bad in [
            format!("attempts/producer/sha256/{}", blob.sha256),
            format!("tags/../{}", blob.sha256),
            format!("tags/x/{}", "b".repeat(64)),
            "tags".to_owned(),
        ] {
            assert!(key_parts(&bad, &blob).is_err(), "{bad}");
        }
        let outside = temporary.path().canonicalize().unwrap().join("outside");
        std::fs::create_dir(&outside).unwrap();
        symlink(&outside, volume.root.join("tags")).unwrap();
        assert!(volume.persist(&key, &blob, Some(BYTES), true).is_err());
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[test]
    fn a_volume_is_an_owner_only_directory_and_volumes_do_not_nest() {
        let (_temporary, volume, _, _) = fixture();
        let nested = volume.root.join("nested");
        std::fs::create_dir(&nested).unwrap();
        std::fs::set_permissions(&nested, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(FileVolume::open(&nested).unwrap().overlaps(&volume));
        std::fs::set_permissions(&volume.root, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(FileVolume::open(&volume.root).is_err());
    }
}
