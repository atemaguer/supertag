#![cfg(feature = "test-fixtures")]

use std::{
    io::Write,
    os::unix::process::CommandExt,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, ensure};

struct Guardian(Child);

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

#[test]
fn closing_the_host_pipe_stops_and_reaps_the_adapter() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let pid_file = directory.path().join("pid");
    let mut guardian = Guardian(
        Command::new(env!("CARGO_BIN_EXE_supertag"))
            .args([
                "__adapter-guardian",
                "--adapter",
                "/bin/sh",
                "--",
                "-c",
                "cat >/dev/null; printf '%s\\n' \"$$\" > \"$1\"; exec sleep 60",
                "adapter-fixture",
            ])
            .arg(&pid_file)
            .process_group(0)
            .stdin(Stdio::piped())
            .spawn()?,
    );
    let mut pipe = guardian.0.stdin.take().context("guardian bootstrap pipe")?;
    pipe.write_all(&1_u32.to_le_bytes())?;
    pipe.write_all(&[42])?;

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

    let deadline = Instant::now() + Duration::from_secs(5);
    while guardian.0.try_wait()?.is_none() {
        ensure!(
            Instant::now() < deadline,
            "guardian stayed alive after its host pipe closed"
        );
        thread::sleep(Duration::from_millis(10));
    }
    // Signal 0 checks the fixture PID without changing process state.
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
    Ok(())
}
