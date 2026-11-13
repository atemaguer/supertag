#![cfg(feature = "test-fixtures")]

use std::{
    io::Write,
    os::unix::process::CommandExt,
    path::Path,
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, ensure};

struct Guardian(Child);

impl Guardian {
    fn launch(script: &str, marker: &Path) -> Result<(Self, ChildStdin)> {
        let mut guardian = Self(
            Command::new(env!("CARGO_BIN_EXE_supertag"))
                .args([
                    "__adapter-guardian",
                    "--adapter",
                    "/bin/sh",
                    "--",
                    "-c",
                    script,
                    "adapter-fixture",
                ])
                .arg(marker)
                .process_group(0)
                .stdin(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()?,
        );
        let pipe = guardian.0.stdin.take().context("guardian bootstrap pipe")?;
        Ok((guardian, pipe))
    }

    fn wait_for_exit(&mut self) -> Result<ExitStatus> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.0.try_wait()? {
                return Ok(status);
            }
            ensure!(Instant::now() < deadline, "guardian did not exit");
            thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Guardian {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none()
            && let Ok(group) = i32::try_from(self.0.id())
        {
            // The fixture created a new process group for these processes.
            unsafe { libc::kill(-group, libc::SIGKILL) };
            let _ = self.0.wait();
        }
    }
}

fn write_frame(pipe: &mut ChildStdin, launch_deadline: u64) -> Result<()> {
    pipe.write_all(&1_u32.to_le_bytes())?;
    pipe.write_all(&launch_deadline.to_le_bytes())?;
    pipe.write_all(&[42])?;
    Ok(())
}

#[test]
fn closing_the_host_pipe_stops_and_reaps_the_adapter() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let pid_file = directory.path().join("pid");
    let (mut guardian, mut pipe) = Guardian::launch(
        "test \"$(cat)\" = '*' || exit 1; printf '%s\\n' \"$$\" > \"$1\"; exec sleep 60",
        &pid_file,
    )?;
    write_frame(&mut pipe, u64::MAX)?;

    let deadline = Instant::now() + Duration::from_secs(5);
    let pid: i32 = loop {
        if let Ok(contents) = std::fs::read_to_string(&pid_file)
            && let Ok(pid) = contents.trim().parse()
        {
            break pid;
        }
        ensure!(Instant::now() < deadline, "adapter did not record its PID");
        ensure!(
            guardian.0.try_wait()?.is_none(),
            "guardian exited before adapter startup"
        );
        thread::sleep(Duration::from_millis(10));
    };
    drop(pipe);
    assert!(!guardian.wait_for_exit()?.success());
    // Signal 0 checks the fixture PID without changing process state.
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
    Ok(())
}

#[test]
fn an_expired_launch_frame_cannot_start_the_adapter() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let marker = directory.path().join("adapter-started");
    let (mut guardian, mut pipe) = Guardian::launch("touch \"$1\"", &marker)?;
    // One nanosecond after the monotonic clock's origin is already elapsed.
    write_frame(&mut pipe, 1)?;
    assert!(!guardian.wait_for_exit()?.success());
    assert!(!marker.exists());
    Ok(())
}

#[test]
fn closing_the_host_pipe_allows_the_adapter_to_reap_its_native_child() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let pid_file = directory.path().join("native-pid");
    let (mut guardian, mut pipe) = Guardian::launch(
        "cat >/dev/null; sleep 60 & native=$!; trap 'kill \"$native\"; wait \"$native\"; printf reaped > \"$1.reaped\"; exit 0' TERM; printf '%s\\n' \"$native\" > \"$1\"; wait \"$native\"",
        &pid_file,
    )?;
    write_frame(&mut pipe, u64::MAX)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let pid: i32 = loop {
        if let Ok(contents) = std::fs::read_to_string(&pid_file)
            && let Ok(pid) = contents.trim().parse()
        {
            break pid;
        }
        ensure!(Instant::now() < deadline, "native child did not start");
        thread::sleep(Duration::from_millis(10));
    };
    drop(pipe);
    assert!(!guardian.wait_for_exit()?.success());
    assert!(
        pid_file.with_extension("reaped").exists(),
        "adapter did not reap its native child before guardian exit"
    );
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
    Ok(())
}

#[test]
fn an_adapter_that_ignores_termination_is_forcibly_reaped() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let pid_file = directory.path().join("adapter-pid");
    let (mut guardian, mut pipe) = Guardian::launch(
        "cat >/dev/null; trap '' TERM; printf '%s\\n' \"$$\" > \"$1\"; exec sleep 60",
        &pid_file,
    )?;
    write_frame(&mut pipe, u64::MAX)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let pid: i32 = loop {
        if let Ok(contents) = std::fs::read_to_string(&pid_file)
            && let Ok(pid) = contents.trim().parse()
        {
            break pid;
        }
        ensure!(Instant::now() < deadline, "adapter did not start");
        thread::sleep(Duration::from_millis(10));
    };
    drop(pipe);
    assert!(!guardian.wait_for_exit()?.success());
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
    Ok(())
}

#[test]
fn a_stopped_guardian_cannot_launch_after_its_host_pipe_closes() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let marker = directory.path().join("adapter-started");
    let (mut guardian, mut pipe) = Guardian::launch("touch \"$1\"", &marker)?;
    let pid = i32::try_from(guardian.0.id())?;
    // SAFETY: pid is the positive PID of this test's guardian child.
    assert_eq!(unsafe { libc::kill(pid, libc::SIGSTOP) }, 0);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let mut status = 0;
        // SAFETY: status is a valid out pointer and pid is this test's child.
        let waited = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG | libc::WUNTRACED) };
        if waited == pid {
            assert!(libc::WIFSTOPPED(status));
            break;
        }
        assert_eq!(waited, 0);
        ensure!(Instant::now() < deadline, "guardian did not stop");
        thread::sleep(Duration::from_millis(10));
    }
    write_frame(&mut pipe, u64::MAX)?;
    drop(pipe);
    // SAFETY: the stopped child remains our own guardian.
    assert_eq!(unsafe { libc::kill(pid, libc::SIGCONT) }, 0);
    assert!(!guardian.wait_for_exit()?.success());
    assert!(!marker.exists());
    Ok(())
}

/// Starts `sleep 60` in a new session, so it is no longer in the adapter's process group, and
/// records its PID in the file `$1` only after it has left the group.
const DETACHED_SLEEP: &str = r#"perl -MPOSIX -e 'POSIX::setsid() >= 0 or die; open(my $f, ">", "$ARGV[0].tmp") or die; print $f "$$\n"; close($f); rename("$ARGV[0].tmp", $ARGV[0]) or die; exec("sleep", "60")' "$1""#;

fn read_pid(path: &Path) -> Result<i32> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(contents) = std::fs::read_to_string(path)
            && let Ok(pid) = contents.trim().parse()
        {
            return Ok(pid);
        }
        ensure!(
            Instant::now() < deadline,
            "the fixture did not record a PID"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

/// Waits until `pid` no longer exists. Its new parent may need a moment to reap it.
fn assert_gone(pid: i32) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        // Signal 0 checks the PID without changing process state.
        if unsafe { libc::kill(pid, 0) } == -1
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            // Do not leave the fixture running when the assertion fails.
            unsafe { libc::kill(pid, libc::SIGKILL) };
            anyhow::bail!("process {pid} survived the guardian");
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn a_descendant_that_left_the_group_is_stopped_after_the_adapter_succeeds() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let pid_file = directory.path().join("detached-pid");
    // The adapter outlives several scans, as a harness does that spawns a detached tool.
    let (mut guardian, mut pipe) = Guardian::launch(
        &format!("cat >/dev/null; {DETACHED_SLEEP} & sleep 1; exit 0"),
        &pid_file,
    )?;
    write_frame(&mut pipe, u64::MAX)?;
    let pid = read_pid(&pid_file)?;
    // A process outside the group is not the adapter's failure to clean up.
    assert!(guardian.wait_for_exit()?.success());
    assert_gone(pid)
}

#[test]
fn a_descendant_that_left_the_group_is_stopped_when_the_host_pipe_closes() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let pid_file = directory.path().join("detached-pid");
    let (mut guardian, mut pipe) = Guardian::launch(
        &format!("cat >/dev/null; {DETACHED_SLEEP} & exec sleep 60"),
        &pid_file,
    )?;
    write_frame(&mut pipe, u64::MAX)?;
    let pid = read_pid(&pid_file)?;
    thread::sleep(Duration::from_millis(300));
    drop(pipe);
    assert!(!guardian.wait_for_exit()?.success());
    assert_gone(pid)
}

/// A double fork orphans the detached process before any scan can see it. Only a subreaper
/// adopts it; macOS has none, so this case is Linux-only.
#[cfg(target_os = "linux")]
#[test]
fn an_orphaned_double_fork_is_stopped_after_the_adapter_exits() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let pid_file = directory.path().join("orphan-pid");
    let (mut guardian, mut pipe) = Guardian::launch(
        // The middle process waits until the detached one has left the group, then exits.
        &format!(
            "cat >/dev/null; ({DETACHED_SLEEP} & while [ ! -s \"$1\" ]; do sleep 0.01; done); exit 0"
        ),
        &pid_file,
    )?;
    write_frame(&mut pipe, u64::MAX)?;
    let pid = read_pid(&pid_file)?;
    assert!(guardian.wait_for_exit()?.success());
    assert_gone(pid)
}

#[test]
fn a_group_member_left_running_fails_the_adapter_and_is_stopped() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let pid_file = directory.path().join("member-pid");
    let (mut guardian, mut pipe) = Guardian::launch(
        "cat >/dev/null; sleep 60 & printf '%s\\n' \"$!\" > \"$1\"; exit 0",
        &pid_file,
    )?;
    write_frame(&mut pipe, u64::MAX)?;
    let pid = read_pid(&pid_file)?;
    assert!(!guardian.wait_for_exit()?.success());
    assert_gone(pid)
}
