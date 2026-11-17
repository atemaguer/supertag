//! Ends every service a test spawns when the test process ends, however it ends.
//!
//! `Drop` guards stop services when a test returns or panics, but not when the test process is
//! killed (a runner timeout, Ctrl-C, `SIGKILL`) or exits without unwinding. Those services were
//! reparented to init and kept running for days.
//!
//! [`reaped`] puts a command in a process group led by a per-test-process watchdog. The
//! watchdog holds the read end of a pipe whose write end only this process holds, and polls
//! this process's PID as a fallback. When this process is gone it kills its whole group: every
//! reaped service and any descendant that stayed in the group. Services that start their own
//! process group (for example `supertag up`'s background supervisor) leave it.
//!
//! The watchdog is a separate process rather than `PR_SET_PDEATHSIG` because Linux sends that
//! signal when the spawning *thread* exits, and test threads and Tokio's blocking pool exit while
//! the test process and its services live on. It also works on macOS, which has no equivalent.
#![allow(dead_code)]

use std::{
    io::Write as _,
    os::unix::process::CommandExt as _,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Mutex, OnceLock},
};

/// Kills its own process group at end of input (a background reader) or once the test process
/// is gone (polled each second).
/// Signals a terminal or runner sends the test's process group never reach this group, and the
/// watchdog ignores the rest so that only the test process's death ends it.
const WATCHDOG: &str = r#"
trap '' INT TERM HUP QUIT PIPE
parent=$1
exec 3<&0
(read -r _ <&3; kill -KILL 0) &
echo ready
while kill -0 "$parent" 2>/dev/null; do
    sleep 1
done
kill -KILL 0
"#;

struct Watchdog {
    child: Child,
    /// Never written after startup; dropping it (only at process exit) is the death signal.
    _lifeline: ChildStdin,
}

fn watchdog() -> &'static Mutex<Watchdog> {
    static WATCHDOG_PROCESS: OnceLock<Mutex<Watchdog>> = OnceLock::new();
    WATCHDOG_PROCESS.get_or_init(|| {
        let mut child = Command::new("/bin/sh")
            .args(["-c", WATCHDOG, "supertag-test-watchdog"])
            .arg(std::process::id().to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .expect("start the test child watchdog");
        // Wait until the traps are installed, so an early death still kills the group.
        let mut ready = [0; 6];
        std::io::Read::read_exact(child.stdout.as_mut().expect("watchdog stdout"), &mut ready)
            .expect("test child watchdog did not start");
        let mut lifeline = child.stdin.take().expect("watchdog stdin");
        lifeline.flush().expect("flush watchdog lifeline");
        Mutex::new(Watchdog {
            child,
            _lifeline: lifeline,
        })
    })
}

/// The watchdog's process group, which reaped commands join.
pub fn group() -> i32 {
    let mut watchdog = watchdog().lock().unwrap_or_else(|error| error.into_inner());
    assert!(
        matches!(watchdog.child.try_wait(), Ok(None)),
        "the test child watchdog exited; reaped children would outlive this test"
    );
    i32::try_from(watchdog.child.id()).expect("watchdog PID out of range")
}

/// A command that can join the watchdog's process group.
pub trait Reap {
    fn join_watchdog_group(&mut self);
}

impl Reap for Command {
    fn join_watchdog_group(&mut self) {
        self.process_group(group());
    }
}

impl Reap for tokio::process::Command {
    fn join_watchdog_group(&mut self) {
        self.process_group(group());
    }
}

/// Returns `command` set to die with this test process. Wrap every service a test spawns.
pub fn reaped<C: Reap>(mut command: C) -> C {
    command.join_watchdog_group();
    command
}
