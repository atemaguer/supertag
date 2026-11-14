//! Find and stop every process an adapter started, including ones that left its process group.
//!
//! A tool can call `setsid` and fork again, so the process no longer shares the adapter's group
//! and its parent exits before cleanup. On Linux the guardian is a child subreaper: such
//! processes become its children, and it kills and reaps its children until none remain. A
//! child's PID cannot be reused before its parent reaps it, so these signals cannot reach an
//! unrelated process.
//!
//! macOS has no subreaper and does not show other processes' environments, so a marker cannot
//! find them either. There the guardian records, while the adapter runs and again at cleanup,
//! the members of the adapter's group and its own descendants with their start times. Cleanup
//! stops every recorded process whose start time still matches, so a process found once is
//! stopped even after it leaves the group and its parent exits. A process that leaves the group
//! and loses its parent between two scans, as a double fork does, is not found on macOS.

use std::{
    io,
    time::{Duration, Instant},
};

/// The longest cleanup may take before the guardian reports that it could not stop everything.
const SWEEP_LIMIT: Duration = Duration::from_secs(2);

/// What a sweep found besides the adapter itself.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Swept {
    /// A process in the adapter's own group was still running after the adapter ended.
    pub(crate) group_survivors: bool,
    /// A process that had left the group was stopped.
    pub(crate) detached: usize,
}

pub(crate) struct Descendants {
    group: i32,
    /// Processes seen in the group or below the guardian, by PID, with their start times.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    seen: std::collections::BTreeMap<i32, u64>,
}

impl Descendants {
    /// Prepare to track the processes this guardian starts. Call before starting the adapter.
    pub(crate) fn new(group: i32) -> io::Result<Self> {
        #[cfg(target_os = "linux")]
        // SAFETY: PR_SET_CHILD_SUBREAPER takes one integer argument and changes only this process.
        if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            group,
            seen: Default::default(),
        })
    }

    /// Record the adapter's processes while it runs. Only macOS needs this.
    pub(crate) fn observe(&mut self) -> io::Result<()> {
        if cfg!(target_os = "macos") {
            self.scan()?;
        }
        Ok(())
    }

    /// Kill every remaining process the adapter started. Call after the adapter was reaped.
    pub(crate) fn sweep(&mut self) -> io::Result<Swept> {
        let deadline = Instant::now() + SWEEP_LIMIT;
        let mut swept = Swept::default();
        loop {
            let found = self.scan()?;
            if found.is_empty() {
                return Ok(swept);
            }
            for process in &found {
                if process.group == self.group {
                    swept.group_survivors = true;
                } else {
                    swept.detached += 1;
                }
                process.kill()?;
            }
            reap_children()?;
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "adapter descendants kept running after cleanup",
                ));
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

/// Reap every exited child without waiting for the running ones.
fn reap_children() -> io::Result<()> {
    loop {
        let mut status = 0;
        // SAFETY: waitpid writes the status to a valid integer and does not block with WNOHANG.
        match unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) } {
            0 => return Ok(()),
            pid if pid > 0 => {}
            _ => {
                let error = io::Error::last_os_error();
                return match error.raw_os_error() {
                    Some(libc::ECHILD) => Ok(()),
                    Some(libc::EINTR) => continue,
                    _ => Err(error),
                };
            }
        }
    }
}

/// One live process found by a scan.
struct Process {
    pid: i32,
    group: i32,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    started: u64,
}

impl Process {
    fn kill(&self) -> io::Result<()> {
        #[cfg(target_os = "macos")]
        if macos::start_time(self.pid) != Some(self.started) {
            // Exited, possibly with its PID reused, since the scan.
            return Ok(());
        }
        // SAFETY: on Linux the PID is an unreaped child; on macOS its start time was checked.
        if unsafe { libc::kill(self.pid, libc::SIGKILL) } != 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error);
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
impl Descendants {
    /// Live children of this subreaper. Orphaned descendants become its children.
    fn scan(&mut self) -> io::Result<Vec<Process>> {
        let me = std::process::id().to_string();
        let mut found = Vec::new();
        for entry in std::fs::read_dir("/proc")? {
            let entry = entry?;
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<i32>().ok())
            else {
                continue;
            };
            // The process may exit while it is read; an unreadable entry is not our child.
            let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
                continue;
            };
            // Fields after the command name, which may itself contain spaces and parentheses.
            let Some((_, fields)) = stat.rsplit_once(')') else {
                continue;
            };
            let fields: Vec<&str> = fields.split_whitespace().collect();
            let (Some(state), Some(parent), Some(group)) =
                (fields.first(), fields.get(1), fields.get(2))
            else {
                continue;
            };
            if *parent != me || *state == "Z" {
                continue;
            }
            found.push(Process {
                pid,
                group: group.parse().unwrap_or_default(),
                started: 0,
            });
        }
        Ok(found)
    }
}

#[cfg(target_os = "macos")]
impl Descendants {
    /// Live members of the adapter's group, descendants of this guardian, and every process
    /// recorded by an earlier scan whose start time still matches.
    fn scan(&mut self) -> io::Result<Vec<Process>> {
        let me = i32::try_from(std::process::id()).unwrap_or_default();
        let processes = macos::processes()?;
        let mut members: std::collections::BTreeSet<i32> = processes
            .iter()
            .filter(|process| {
                process.group == self.group
                    || process.parent == me
                    || self.seen.get(&process.pid) == Some(&process.started)
            })
            .map(|process| process.pid)
            .collect();
        // Follow parentage until no new descendant appears.
        loop {
            let before = members.len();
            for process in &processes {
                if members.contains(&process.parent) {
                    members.insert(process.pid);
                }
            }
            if members.len() == before {
                break;
            }
        }
        members.remove(&me);
        let found: Vec<Process> = processes
            .into_iter()
            .filter(|process| members.contains(&process.pid))
            .map(|process| Process {
                pid: process.pid,
                group: process.group,
                started: process.started,
            })
            .collect();
        self.seen = found
            .iter()
            .map(|process| (process.pid, process.started))
            .collect();
        Ok(found)
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
impl Descendants {
    /// Other platforms rely on the adapter's process group alone.
    fn scan(&mut self) -> io::Result<Vec<Process>> {
        Ok(Vec::new())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::{ffi::c_void, io, mem::size_of};

    /// The kernel's state for an exited process that its parent has not reaped.
    const SZOMB: u32 = 5;

    pub(super) struct Entry {
        pub(super) pid: i32,
        pub(super) parent: i32,
        pub(super) group: i32,
        pub(super) started: u64,
    }

    fn info(pid: i32) -> Option<libc::proc_bsdinfo> {
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
        let size = i32::try_from(size_of::<libc::proc_bsdinfo>()).ok()?;
        // SAFETY: the buffer holds exactly one proc_bsdinfo, and the size says so.
        let read = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast::<c_void>(),
                size,
            )
        };
        // SAFETY: a full-size read initialized the structure.
        (read == size).then(|| unsafe { info.assume_init() })
    }

    fn started(info: &libc::proc_bsdinfo) -> u64 {
        info.pbi_start_tvsec
            .saturating_mul(1_000_000)
            .saturating_add(info.pbi_start_tvusec)
    }

    /// The start time of a live process, which identifies it across PID reuse.
    pub(super) fn start_time(pid: i32) -> Option<u64> {
        info(pid)
            .filter(|info| info.pbi_status != SZOMB)
            .map(|info| started(&info))
    }

    /// Every live process this guardian can inspect. Processes that exit during the scan are skipped.
    pub(super) fn processes() -> io::Result<Vec<Entry>> {
        // SAFETY: a null buffer asks only for the number of PIDs.
        let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        if count < 0 {
            return Err(io::Error::last_os_error());
        }
        // Leave room for processes started since the count.
        let mut pids = vec![0_i32; usize::try_from(count).unwrap_or_default() + 256];
        let bytes = i32::try_from(pids.len() * size_of::<i32>())
            .map_err(|_| io::Error::from_raw_os_error(libc::EOVERFLOW))?;
        // SAFETY: the buffer holds `bytes` bytes of PIDs.
        let listed = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast::<c_void>(), bytes) };
        if listed < 0 {
            return Err(io::Error::last_os_error());
        }
        pids.truncate(usize::try_from(listed).unwrap_or_default());
        Ok(pids
            .into_iter()
            .filter(|pid| *pid > 0)
            .filter_map(|pid| {
                let info = info(pid).filter(|info| info.pbi_status != SZOMB)?;
                Some(Entry {
                    pid,
                    parent: i32::try_from(info.pbi_ppid).ok()?,
                    group: i32::try_from(info.pbi_pgid).ok()?,
                    started: started(&info),
                })
            })
            .collect())
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn lists_live_processes_with_parent_group_and_start_time() {
            let me = i32::try_from(std::process::id()).unwrap();
            let mut child = std::process::Command::new("/bin/sleep")
                .arg("5")
                .spawn()
                .unwrap();
            let pid = i32::try_from(child.id()).unwrap();
            let processes = super::processes().unwrap();
            let entry = processes.iter().find(|entry| entry.pid == pid).unwrap();
            assert_eq!(entry.parent, me);
            // SAFETY: getpgrp has no preconditions.
            assert_eq!(entry.group, unsafe { libc::getpgrp() });
            assert_eq!(super::start_time(pid), Some(entry.started));
            child.kill().unwrap();
            child.wait().unwrap();
            assert_eq!(super::start_time(pid), None);
        }
    }
}
