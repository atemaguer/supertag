use std::{
    ffi::OsString,
    io::{self, Read, Write},
    mem::MaybeUninit,
    os::{
        fd::{AsFd, AsRawFd, RawFd},
        unix::{
            fs::{DirBuilderExt, PermissionsExt},
            process::CommandExt,
        },
    },
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, ensure};

mod descendants;
use descendants::Descendants;

pub(crate) const MAX_BOOTSTRAP_BYTES: usize = 4096;
pub(crate) const ADAPTER_STOP_GRACE: Duration = Duration::from_secs(2);
pub(crate) const ADAPTER_SCRATCH_PARENT: &str = "SUPERTAG_ADAPTER_SCRATCH_PARENT";
pub const ADAPTER_STATE_DIRECTORY: &str = "SUPERTAG_ADAPTER_STATE_DIRECTORY";
/// How often the guardian records the adapter's processes where the OS cannot adopt orphans.
const DESCENDANT_SCAN_INTERVAL: Duration = Duration::from_millis(100);

pub(crate) fn monotonic_now_ns() -> io::Result<u64> {
    let mut time = MaybeUninit::<libc::timespec>::uninit();
    // SAFETY: clock_gettime writes a timespec to this valid out pointer on success.
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, time.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: clock_gettime succeeded and initialized time.
    let time = unsafe { time.assume_init() };
    let seconds =
        u64::try_from(time.tv_sec).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?;
    let nanos =
        u64::try_from(time.tv_nsec).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?;
    seconds
        .checked_mul(1_000_000_000)
        .and_then(|seconds| seconds.checked_add(nanos))
        .ok_or_else(|| io::Error::from_raw_os_error(libc::EOVERFLOW))
}

fn check_launch_authority(pipe: RawFd, deadline_ns: u64) -> io::Result<()> {
    // After the frame the only valid input is EOF. Treat any readiness, hangup,
    // or polling error as a closed launch window.
    let mut descriptor = libc::pollfd {
        fd: pipe,
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: descriptor points to one initialized pollfd and this poll never blocks.
    match unsafe { libc::poll(&mut descriptor, 1, 0) } {
        0 => {}
        1 => return Err(io::Error::from_raw_os_error(libc::EPIPE)),
        _ => return Err(io::Error::last_os_error()),
    }
    if monotonic_now_ns()? >= deadline_ns {
        return Err(io::Error::from_raw_os_error(libc::ETIMEDOUT));
    }
    Ok(())
}

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
    let (bootstrap, launch_deadline) = {
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
        let mut deadline = [0; 8];
        input
            .read_exact(&mut deadline)
            .context("read adapter launch deadline")?;
        let mut bootstrap = vec![0; size];
        input
            .read_exact(&mut bootstrap)
            .context("read adapter bootstrap")?;
        (bootstrap, u64::from_le_bytes(deadline))
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

    let mut scratch = std::env::var_os(ADAPTER_SCRATCH_PARENT)
        .map(|parent| {
            tempfile::Builder::new()
                .prefix("adapter-attempt-")
                .permissions(std::fs::Permissions::from_mode(0o700))
                .tempdir_in(parent)
        })
        .transpose()?;
    // Track the adapter's processes before any of them can start.
    let mut descendants = Descendants::new(group).context("track adapter descendants")?;
    let mut command = Command::new(adapter);
    command
        .args(args)
        .stdin(Stdio::piped())
        .env_remove(ADAPTER_SCRATCH_PARENT)
        .env_remove(ADAPTER_STATE_DIRECTORY);
    if let Some(directory) = &scratch {
        let temporary = directory.path().join("tmp");
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&temporary)
            .context("create adapter temporary directory")?;
        command
            .env(ADAPTER_STATE_DIRECTORY, directory.path())
            .env("TMPDIR", temporary);
        if std::env::var_os(crate::WORKSPACE_DIRECTORY).is_none() {
            let workspace = directory.path().join("workspace");
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&workspace)
                .context("create disposable adapter workspace")?;
            command
                .current_dir(&workspace)
                .env(crate::WORKSPACE_DIRECTORY, workspace);
        }
    }
    check_launch_authority(libc::STDIN_FILENO, launch_deadline)
        .context("adapter launch authority ended before spawn")?;
    // The child replaces stdin with its own bootstrap pipe. Retain a separate,
    // close-on-exec read descriptor to check Host liveness just before exec.
    let host_pipe = std::io::stdin().as_fd().try_clone_to_owned()?;
    // SAFETY: the callback uses only nonblocking poll/clock_gettime, integer
    // arithmetic, and raw OS error construction. It does not allocate or lock.
    unsafe {
        command.pre_exec(move || check_launch_authority(host_pipe.as_raw_fd(), launch_deadline));
    }
    let mut child = command.spawn().context("start harness adapter")?;
    let written = (|| -> Result<()> {
        check_launch_authority(libc::STDIN_FILENO, launch_deadline)
            .context("adapter launch authority ended before bootstrap")?;
        child
            .stdin
            .take()
            .context("adapter bootstrap pipe is missing")?
            .write_all(&bootstrap)
            .context("send harness adapter bootstrap")
    })();
    if written.is_err() {
        return stop_group(&mut child, &mut scratch, &mut descendants, group);
    }
    let mut next_scan = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().context("reap harness adapter")? {
            break status;
        }
        if disconnected.recv_timeout(Duration::from_millis(10))
            != Err(mpsc::RecvTimeoutError::Timeout)
        {
            return stop_group(&mut child, &mut scratch, &mut descendants, group);
        }
        if Instant::now() >= next_scan {
            // Best effort while running; cleanup scans again and reports a failure.
            let _ = descendants.observe();
            next_scan = Instant::now() + DESCENDANT_SCAN_INTERVAL;
        }
    };
    // Stop what the adapter left behind before removing the state it may still use. Processes
    // that left the group are stopped quietly; a survivor in the group means the adapter did
    // not clean up, which fails the Attempt as before.
    let swept = descendants.sweep();
    if let Some(directory) = scratch {
        directory
            .close()
            .context("remove disposable adapter Attempt state")?;
    }
    let swept = swept.context("stop adapter descendants")?;
    ensure!(status.success(), "harness adapter exited unsuccessfully");
    ensure!(
        !swept.group_survivors,
        "harness adapter left running descendants"
    );
    Ok(())
}

fn stop_group(
    child: &mut Child,
    scratch: &mut Option<tempfile::TempDir>,
    descendants: &mut Descendants,
    group: i32,
) -> Result<()> {
    let reaped = stop_adapter(child);
    // Stop processes that left the group too, while this guardian can still adopt them.
    let swept = if reaped.is_ok() {
        descendants.sweep().map(|_| ())
    } else {
        Ok(())
    };
    if let Some(directory) = scratch.take() {
        let _ = directory.close();
    }
    // SAFETY: the guardian is still the leader of this dedicated group. Signal
    // the group even if direct-child reaping failed.
    unsafe { libc::kill(-group, libc::SIGKILL) };
    reaped.context("reap harness adapter after Host exit")?;
    swept.context("stop adapter descendants after Host exit")?;
    anyhow::bail!("could not stop the adapter process group")
}

fn stop_adapter(child: &mut Child) -> io::Result<()> {
    // Let the adapter's cancellation handler stop and reap its native children
    // before terminating their parent. Killing the parent first can leave orphan
    // zombies that macOS refuses to signal, preventing the Host's cleanup proof.
    let pid = i32::try_from(child.id()).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?;
    // SAFETY: this is our unreaped direct child, so its PID cannot be reused.
    if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(error);
        }
    }
    let deadline = Instant::now() + ADAPTER_STOP_GRACE;
    loop {
        if child.try_wait()?.is_some() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            return child.wait().map(|_| ());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
