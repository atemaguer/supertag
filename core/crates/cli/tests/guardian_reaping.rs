//! The adapter guardian reaps every descendant it adopted, including ones that already exited.
//!
//! On Linux the guardian is a child subreaper: an adapter's orphaned descendants become its
//! children, and cleanup kills them. One that died between cleanup's kill and its next scan was a
//! zombie child of the guardian, which the scan skips, so cleanup ended without reaping it and it
//! passed to PID 1 when the guardian exited. A host init reaps it, but a container whose PID 1 is
//! `sleep infinity` never does, so it stayed a zombie and Cursor's cancellation test saw the
//! native process "survive settlement".
//!
//! This test process makes itself a subreaper, as a non-reaping PID 1 stands in for, so whatever
//! the guardian leaves behind becomes its child. It is its own test binary because a subreaper
//! adopts the orphans of every other test in the process.
#![cfg(all(feature = "test-fixtures", target_os = "linux"))]

use std::{
    io::Write,
    os::unix::process::CommandExt,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, ensure};

const WAIT: Duration = Duration::from_secs(30);

/// Starts `sleep 60` in a new session and records its PID once it has left the adapter's group.
/// The middle process exits, so the sleep is orphaned and adopted by the guardian, and the adapter
/// succeeds while it runs. The guardian's cleanup must kill it and reap it.
const ADAPTER: &str = r#"cat >/dev/null
(perl -MPOSIX -e 'POSIX::setsid() >= 0 or die; open(my $f, ">", "$ARGV[0].tmp") or die; print $f "$$\n"; close($f); rename("$ARGV[0].tmp", $ARGV[0]) or die; exec("sleep", "60")' "$1" &
 while [ ! -s "$1" ]; do sleep 0.01; done)
exit 0"#;

#[test]
fn a_killed_detached_descendant_is_reaped_before_the_guardian_exits() -> Result<()> {
    // SAFETY: PR_SET_CHILD_SUBREAPER takes one integer argument and changes only this process.
    ensure!(unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } == 0);
    let directory = tempfile::tempdir()?;
    let pid_file = directory.path().join("detached-pid");
    let mut guardian = Command::new(env!("CARGO_BIN_EXE_supertag"))
        .args([
            "__adapter-guardian",
            "--adapter",
            "/bin/sh",
            "--",
            "-c",
            ADAPTER,
            "adapter-fixture",
        ])
        .arg(&pid_file)
        .process_group(0)
        .stdin(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut pipe = guardian.stdin.take().context("guardian bootstrap pipe")?;
    pipe.write_all(&1_u32.to_le_bytes())?;
    pipe.write_all(&u64::MAX.to_le_bytes())?;
    pipe.write_all(&[42])?;
    let deadline = Instant::now() + WAIT;
    let status = loop {
        if let Some(status) = guardian.try_wait()? {
            break status;
        }
        ensure!(Instant::now() < deadline, "guardian did not exit");
        thread::sleep(Duration::from_millis(10));
    };
    drop(pipe);
    ensure!(status.success(), "guardian failed: {status}");
    let pid: i32 = std::fs::read_to_string(&pid_file)?.trim().parse()?;
    let left = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok();
    if left.is_some() {
        // Reap what the guardian left, so the failure leaves nothing behind.
        // SAFETY: the PID is this subreaper's child; waitpid writes to a valid integer.
        unsafe { libc::waitpid(pid, &mut 0, libc::WNOHANG) };
    }
    ensure!(
        left.is_none(),
        "the guardian left its killed descendant {pid} unreaped: {left:?}"
    );
    Ok(())
}
