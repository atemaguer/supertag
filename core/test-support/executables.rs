//! Executable test fixtures that never cause `Text file busy` (ETXTBSY) on Linux.
//!
//! Linux refuses to `exec` a file while any process holds it open for writing. A test that
//! writes a fixture with `fs::write` holds a writable descriptor for a moment, and if another
//! test thread forks in that moment, the forked child inherits the descriptor and keeps it open
//! until it calls `exec` itself. `O_CLOEXEC` (which std always sets) does not close it any
//! sooner, and writing to a temporary path and renaming it into place does not help either: the
//! inherited descriptor refers to the inode, which a rename keeps. So the test process never
//! opens a fixture it will execute for writing: a short-lived `sh` or `cp` writes it, and no
//! other process can inherit that child's descriptor.
#![allow(dead_code)]

use std::{
    fs,
    io::{self, Write as _},
    os::unix::fs::PermissionsExt as _,
    path::Path,
    process::{Command, Stdio},
};

/// Write `contents` to `path` with `mode`, ready to execute.
pub fn write_executable(path: &Path, contents: impl AsRef<[u8]>, mode: u32) -> io::Result<()> {
    let mut writer = Command::new("/bin/sh")
        .args(["-c", "exec cat > \"$1\"", "sh"])
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()?;
    let written = writer
        .stdin
        .take()
        .expect("piped stdin")
        .write_all(contents.as_ref());
    let status = writer.wait()?;
    written?;
    finish(status, path, mode)
}

/// Copy the executable at `from` to `to` with `mode`.
pub fn copy_executable(from: &Path, to: &Path, mode: u32) -> io::Result<()> {
    let status = Command::new("/bin/cp")
        .arg(from)
        .arg(to)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .status()?;
    finish(status, to, mode)
}

fn finish(status: std::process::ExitStatus, path: &Path, mode: u32) -> io::Result<()> {
    if !status.success() {
        return Err(io::Error::other(format!(
            "could not write {}: {status}",
            path.display()
        )));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}
