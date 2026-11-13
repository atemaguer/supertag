//! Host machine conditions around Task Attempts: free disk space and keeping the machine awake.
//!
//! Matches TypeScript `apps/cli/src/disk-space.ts` (`lowDiskWarning`) and
//! `apps/cli/src/keep-awake.ts` (`KeepAwake`, `keepAwakeCommand`).

use std::{
    ffi::CString,
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::SystemTime,
};

use anyhow::{Context, Result};
use supertag_protocol::v2::HostDiskSpace;
use tokio::{process::Command, sync::watch, task::JoinHandle};
use tokio_util::sync::CancellationToken;

const GIB: u64 = 1024 * 1024 * 1024;

/// Free and total bytes of the filesystem holding `path`.
// statvfs field widths differ by platform.
#[allow(clippy::unnecessary_cast)]
pub fn disk_space(path: &Path) -> Result<HostDiskSpace> {
    let path = CString::new(path.as_os_str().as_bytes()).context("disk path contains NUL")?;
    // SAFETY: statvfs writes only into the zeroed struct for a NUL-terminated path.
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } != 0 {
        return Err(std::io::Error::last_os_error()).context("read host disk space");
    }
    let unit = stat.f_frsize as u64;
    Ok(HostDiskSpace {
        free_bytes: (stat.f_bavail as u64).saturating_mul(unit),
        total_bytes: (stat.f_blocks as u64).saturating_mul(unit),
    })
}

/// The warning shown when free space is below the smaller of 10 GiB and 5% of the volume.
pub fn low_disk_warning(space: Option<&HostDiskSpace>) -> Option<String> {
    let space = space?;
    if space.total_bytes == 0 {
        return None;
    }
    let threshold = (10 * GIB).min(space.total_bytes / 20);
    if space.free_bytes >= threshold {
        return None;
    }
    Some(format!(
        "Warning: Worker Host free disk {} GiB is below {} GiB (min of 10 GiB and 5% of volume)",
        space.free_bytes / GIB,
        threshold.div_ceil(GIB)
    ))
}

/// How the host measures disk space: the filesystem of a directory, or a fixed test value.
#[derive(Clone)]
pub enum DiskSpaceSource {
    Directory(PathBuf),
    Fixed(HostDiskSpace),
}

impl DiskSpaceSource {
    pub fn sample(&self) -> Option<HostDiskSpace> {
        match self {
            Self::Directory(path) => disk_space(path).ok(),
            Self::Fixed(space) => Some(*space),
        }
    }
}

/// The OS command that prevents idle sleep while it runs and ends with process `pid`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeepAwakeCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Short form shown to people, such as `caffeinate -i`.
    pub label: String,
}

impl KeepAwakeCommand {
    /// `caffeinate -i` on macOS and `systemd-inhibit` on Linux; none elsewhere.
    pub fn for_platform(os: &str, pid: u32) -> Option<Self> {
        match os {
            "macos" => Some(Self {
                program: "caffeinate".into(),
                args: vec!["-i".into(), "-w".into(), pid.to_string()],
                label: "caffeinate -i".into(),
            }),
            "linux" => Some(Self {
                program: "systemd-inhibit".into(),
                args: [
                    "--what=idle:sleep",
                    "--who=SuperTag",
                    "--why=Running Task Attempts",
                    "--mode=block",
                    "tail",
                    &format!("--pid={pid}"),
                    "-f",
                    "/dev/null",
                ]
                .map(str::to_owned)
                .to_vec(),
                label: "systemd-inhibit".into(),
            }),
            _ => None,
        }
    }
}

/// How many times one hold restarts its OS command after it exits unexpectedly.
pub const MAX_KEEP_AWAKE_RESTARTS: u32 = 3;

/// Keeps the machine awake while Task Attempts run. The first running Attempt starts the OS
/// command and the last one to finish stops it. A missing command is reported once and the
/// host keeps working.
pub(crate) struct KeepAwake {
    /// Whether Attempts run, and which running period this is, so a quick stop and start is
    /// never coalesced into one continuous hold.
    running: watch::Sender<(bool, u64)>,
    stop: CancellationToken,
    task: Option<JoinHandle<()>>,
}

impl KeepAwake {
    pub(crate) fn start(command: Option<KeepAwakeCommand>, shutdown: CancellationToken) -> Self {
        let (running, receiver) = watch::channel((false, 0));
        let stop = shutdown.child_token();
        let task = command.map(|command| tokio::spawn(hold(command, receiver, stop.clone())));
        Self {
            running,
            stop,
            task,
        }
    }

    pub(crate) fn update(&self, running: bool) {
        self.running.send_if_modified(|(current, period)| {
            if *current == running {
                return false;
            }
            *current = running;
            if running {
                *period += 1;
            }
            true
        });
    }

    pub(crate) async fn stop(mut self) {
        self.stop.cancel();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for KeepAwake {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

fn now() -> String {
    let elapsed = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}ms since the Unix epoch", elapsed.as_millis())
}

async fn hold(
    command: KeepAwakeCommand,
    mut running: watch::Receiver<(bool, u64)>,
    shutdown: CancellationToken,
) {
    let mut handled = 0;
    loop {
        // Wait for a running period this task has not held yet.
        let period = loop {
            let (active, period) = *running.borrow_and_update();
            if active || period != handled {
                break period;
            }
            tokio::select! {
                _ = shutdown.cancelled() => return,
                changed = running.changed() => if changed.is_err() { return },
            }
        };
        handled = period;
        let ended = move |(active, current): &(bool, u64)| !*active || *current != period;
        let mut restarts = 0;
        loop {
            let mut child = match Command::new(&command.program)
                .args(&command.args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
            {
                Ok(child) => child,
                Err(error) => {
                    eprintln!(
                        "Cannot keep the machine awake with {}: {error}. Task Attempts still run, but the machine may sleep during them.",
                        command.label
                    );
                    return;
                }
            };
            eprintln!(
                "Keeping the machine awake ({}) since {} while Task Attempts run.",
                command.label,
                now()
            );
            let idle = tokio::select! {
                _ = shutdown.cancelled() => None,
                _ = child.wait() => Some(false),
                changed = running.wait_for(ended) => Some(changed.is_ok()),
            };
            if let Some(pid) = child.id() {
                // SAFETY: signals only the child this task spawned and still owns.
                unsafe { libc::kill(pid as i32, libc::SIGTERM) };
            }
            let _ = child.wait().await;
            eprintln!("Stopped keeping the machine awake ({}).", command.label);
            match idle {
                None => return,
                Some(true) => break,
                // The OS command ended on its own while Task Attempts still run: start it
                // again a bounded number of times so a command that keeps exiting cannot spin.
                Some(false) if !ended(&running.borrow()) && restarts < MAX_KEEP_AWAKE_RESTARTS => {
                    restarts += 1;
                }
                Some(false) => {
                    tokio::select! {
                        _ = shutdown.cancelled() => return,
                        changed = running.wait_for(ended) => if changed.is_err() { return },
                    }
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn uses_five_percent_on_small_volumes_and_ten_gib_on_large_volumes() {
        let space = |free, total| HostDiskSpace {
            free_bytes: free * GIB,
            total_bytes: total * GIB,
        };
        assert!(
            low_disk_warning(Some(&space(4, 100)))
                .unwrap()
                .contains("below 5 GiB")
        );
        assert_eq!(low_disk_warning(Some(&space(6, 100))), None);
        assert!(
            low_disk_warning(Some(&space(9, 500)))
                .unwrap()
                .contains("below 10 GiB")
        );
        assert_eq!(low_disk_warning(Some(&space(11, 500))), None);
        assert_eq!(low_disk_warning(None), None);
        assert_eq!(low_disk_warning(Some(&space(0, 0))), None);
    }

    #[test]
    fn reads_the_real_filesystem() {
        let space = disk_space(&std::env::temp_dir()).unwrap();
        assert!(space.total_bytes > 0 && space.free_bytes <= space.total_bytes);
    }

    #[test]
    fn uses_caffeinate_on_macos_and_systemd_inhibit_on_linux_tied_to_the_host() {
        assert_eq!(
            KeepAwakeCommand::for_platform("macos", 7),
            Some(KeepAwakeCommand {
                program: "caffeinate".into(),
                args: vec!["-i".into(), "-w".into(), "7".into()],
                label: "caffeinate -i".into(),
            })
        );
        let linux = KeepAwakeCommand::for_platform("linux", 7).unwrap();
        assert_eq!(linux.program, PathBuf::from("systemd-inhibit"));
        for arg in ["--what=idle:sleep", "--mode=block", "--pid=7"] {
            assert!(linux.args.iter().any(|item| item == arg));
        }
        assert_eq!(KeepAwakeCommand::for_platform("windows", 7), None);
    }

    /// A fake OS command that records each start and termination.
    fn fake(directory: &Path, exit_after: Option<&str>) -> KeepAwakeCommand {
        let script = directory.join("hold");
        let log = directory.join("log");
        let body = match exit_after {
            Some(delay) => format!("echo start >> '{}'\nsleep {delay}\nexit 1\n", log.display()),
            None => format!(
                "echo start >> '{}'\ntrap 'echo term >> \"{}\"; exit 0' TERM\nwhile :; do sleep 0.05; done\n",
                log.display(),
                log.display()
            ),
        };
        std::fs::write(&script, format!("#!/bin/sh\n{body}")).unwrap();
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        KeepAwakeCommand {
            program: script,
            args: vec![],
            label: "fake".into(),
        }
    }

    async fn log_lines(directory: &Path, expected: &[&str]) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let log = std::fs::read_to_string(directory.join("log")).unwrap_or_default();
            if log.lines().collect::<Vec<_>>() == expected {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "log {log:?} never became {expected:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn holds_while_attempts_run_and_releases_when_idle() {
        let directory = tempfile::tempdir().unwrap();
        let shutdown = CancellationToken::new();
        let awake = KeepAwake::start(Some(fake(directory.path(), None)), shutdown.clone());
        awake.update(true);
        awake.update(true);
        log_lines(directory.path(), &["start"]).await;
        awake.update(false);
        log_lines(directory.path(), &["start", "term"]).await;
        awake.update(true);
        log_lines(directory.path(), &["start", "term", "start"]).await;
        awake.stop().await;
        log_lines(directory.path(), &["start", "term", "start", "term"]).await;
    }

    #[tokio::test]
    async fn restarts_a_bounded_number_of_times_after_unexpected_exits() {
        let directory = tempfile::tempdir().unwrap();
        let shutdown = CancellationToken::new();
        let awake = KeepAwake::start(Some(fake(directory.path(), Some("0"))), shutdown.clone());
        awake.update(true);
        let starts = vec!["start"; MAX_KEEP_AWAKE_RESTARTS as usize + 1];
        log_lines(directory.path(), &starts).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        log_lines(directory.path(), &starts).await;
        // A new running period starts a fresh hold.
        awake.update(false);
        awake.update(true);
        let more = vec!["start"; 2 * (MAX_KEEP_AWAKE_RESTARTS as usize + 1)];
        log_lines(directory.path(), &more).await;
        awake.stop().await;
    }

    #[tokio::test]
    async fn stops_trying_when_the_os_command_is_missing_and_does_nothing_without_one() {
        let shutdown = CancellationToken::new();
        let missing = KeepAwake::start(
            Some(KeepAwakeCommand {
                program: "/nonexistent/supertag-keep-awake".into(),
                args: vec![],
                label: "missing".into(),
            }),
            shutdown.clone(),
        );
        missing.update(true);
        missing.update(false);
        missing.update(true);
        missing.stop().await;
        let none = KeepAwake::start(None, shutdown.clone());
        none.update(true);
        none.stop().await;
    }
}
