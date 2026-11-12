use std::{
    ffi::OsString,
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};

use anyhow::{Context, Result, ensure};

pub(crate) const MAX_BOOTSTRAP_BYTES: usize = 4096;

/// Run inside the dedicated adapter process group. The Worker Host keeps the
/// bootstrap pipe open for the lifetime of the Attempt.
pub fn guard_adapter(adapter: &Path, args: &[OsString]) -> Result<()> {
    let group = i32::try_from(std::process::id()).context("adapter guardian PID out of range")?;
    // This process can only signal its own dedicated group.
    ensure!(
        unsafe { libc::getpgrp() } == group,
        "guardian requires its own process group"
    );
    let input = std::io::stdin();
    let bootstrap = {
        let mut input = input.lock();
        let mut size = [0; 4];
        input
            .read_exact(&mut size)
            .context("read adapter bootstrap size")?;
        let size = u32::from_le_bytes(size) as usize;
        ensure!(
            (1..=MAX_BOOTSTRAP_BYTES).contains(&size),
            "invalid adapter bootstrap size"
        );
        let mut bootstrap = vec![0; size];
        input
            .read_exact(&mut bootstrap)
            .context("read adapter bootstrap")?;
        bootstrap
    };
    let (notify, disconnected) = mpsc::channel();
    std::thread::Builder::new()
        .name("worker-host-lifeline".into())
        .spawn(move || {
            // EOF means the owning host died or ended this Attempt. No more
            // messages are valid on the pipe after the bootstrap.
            let _ = input.lock().read_exact(&mut [0_u8; 1]);
            let _ = notify.send(());
        })
        .context("start Worker Host lifeline watcher")?;

    let mut child = Command::new(adapter)
        .args(args)
        .stdin(Stdio::piped())
        .spawn()
        .context("start harness adapter")?;
    let written = child
        .stdin
        .take()
        .context("adapter bootstrap pipe is missing")?
        .write_all(&bootstrap);
    if written.is_err() {
        let _ = child.kill();
    }
    let status = loop {
        if let Some(status) = child.try_wait().context("reap harness adapter")? {
            break status;
        }
        if disconnected.recv_timeout(Duration::from_millis(10))
            != Err(mpsc::RecvTimeoutError::Timeout)
        {
            let _ = child.kill();
            child
                .wait()
                .context("reap harness adapter after Host exit")?;
            // The guardian still owns the group. Terminate any native
            // descendants that outlived the adapter.
            unsafe { libc::kill(-group, libc::SIGKILL) };
            anyhow::bail!("could not stop the adapter process group");
        }
    };
    written.context("send harness adapter bootstrap")?;
    ensure!(status.success(), "harness adapter exited unsuccessfully");
    Ok(())
}
