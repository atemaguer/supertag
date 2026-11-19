//! The Workers a Worklet runs, kept current in a status file in the host's state directory so
//! that `supertag ps` can list them without asking the Control Plane.
//!
//! The file names the Worklet's process. A reader shows a Worker only while that process lives
//! and is the Worker's parent, so a file a dead Worklet left behind lists nothing.

use std::{
    collections::BTreeMap,
    io::Write as _,
    os::unix::fs::OpenOptionsExt as _,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use crate::local::WorkerState;

/// The status file's name in the host's state directory.
pub const WORKERS_FILE: &str = "workers.json";

/// What a Worker is doing: setting up, running its harness, or capturing and handing over what
/// the turn produced.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunningState {
    Starting,
    Executing,
    Finalizing,
}

impl RunningState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Executing => "executing",
            Self::Finalizing => "finalizing",
        }
    }
}

impl From<WorkerState> for RunningState {
    fn from(state: WorkerState) -> Self {
        match state {
            WorkerState::Starting => Self::Starting,
            WorkerState::Executing => Self::Executing,
            WorkerState::Finalizing => Self::Finalizing,
        }
    }
}

/// One Worker process and the Task Attempt it runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunningWorker {
    pub pid: u32,
    pub harness: String,
    pub slot: String,
    pub task_id: String,
    pub attempt_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tag_id: String,
    pub state: RunningState,
    /// When the Worklet started it, in milliseconds since the Unix epoch.
    pub started_at_ms: u64,
}

#[derive(Serialize, Deserialize)]
struct StatusFile {
    /// The Worklet's process ID.
    worklet: u32,
    workers: Vec<RunningWorker>,
}

/// The Worklet's record of its running Workers, by slot, written through to the status file.
pub(crate) struct Workers {
    path: PathBuf,
    running: Mutex<BTreeMap<String, RunningWorker>>,
}

impl Workers {
    /// Starts an empty record in `state_directory`, replacing what an earlier Worklet left.
    pub(crate) fn open(state_directory: &Path) -> Self {
        let workers = Self {
            path: state_directory.join(WORKERS_FILE),
            running: Mutex::default(),
        };
        workers.write(&BTreeMap::new());
        workers
    }

    pub(crate) fn started(&self, worker: RunningWorker) {
        self.change(|running| {
            running.insert(worker.slot.clone(), worker);
        });
    }

    pub(crate) fn state(&self, slot: &str, state: WorkerState) {
        self.change(|running| {
            if let Some(worker) = running.get_mut(slot) {
                worker.state = state.into();
            }
        });
    }

    pub(crate) fn ended(&self, slot: &str) {
        self.change(|running| {
            running.remove(slot);
        });
    }

    fn change(&self, change: impl FnOnce(&mut BTreeMap<String, RunningWorker>)) {
        let mut running = self
            .running
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let before = running.clone();
        change(&mut running);
        if *running != before {
            self.write(&running);
        }
    }

    /// Replaces the file whole. The status is advisory: a write that fails leaves the old one,
    /// which a reader checks against the live processes anyway.
    fn write(&self, running: &BTreeMap<String, RunningWorker>) {
        let status = StatusFile {
            worklet: std::process::id(),
            workers: running.values().cloned().collect(),
        };
        let Ok(body) = serde_json::to_vec(&status) else {
            return;
        };
        let temporary = self.path.with_extension("json.tmp");
        let written = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temporary)
            .and_then(|mut file| file.write_all(&body))
            .and_then(|()| std::fs::rename(&temporary, &self.path));
        if written.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
    }
}

impl Drop for Workers {
    fn drop(&mut self) {
        self.write(&BTreeMap::new());
    }
}

/// The Workers the Worklet `worklet` runs for the host whose state directory is
/// `state_directory`: none when its status file is missing or unreadable, names another
/// process, or that process is gone, and only those whose process lives with the Worklet as
/// its parent.
pub fn running_workers(state_directory: &Path, worklet: u32) -> Vec<RunningWorker> {
    let Ok(body) = std::fs::read(state_directory.join(WORKERS_FILE)) else {
        return Vec::new();
    };
    let Ok(status) = serde_json::from_slice::<StatusFile>(&body) else {
        return Vec::new();
    };
    if status.worklet != worklet || parent(worklet).is_none() {
        return Vec::new();
    }
    status
        .workers
        .into_iter()
        .filter(|worker| parent(worker.pid) == Some(worklet))
        .collect()
}

/// The parent of a live process, or `None` when it is gone or cannot be read.
#[cfg(target_os = "linux")]
fn parent(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // `pid (command) state ppid ...`: the command may hold spaces and parentheses.
    let (_, rest) = stat.rsplit_once(')')?;
    let mut fields = rest.split_whitespace();
    let state = fields.next()?;
    if state == "Z" || state == "X" {
        return None;
    }
    fields.next()?.parse().ok()
}

/// The parent of a live process, or `None` when it is gone or cannot be read.
#[cfg(target_os = "macos")]
fn parent(pid: u32) -> Option<u32> {
    let pid = libc::c_int::try_from(pid).ok().filter(|pid| *pid > 0)?;
    // SAFETY: a zeroed proc_bsdinfo is a valid value of this plain C struct.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = libc::c_int::try_from(std::mem::size_of::<libc::proc_bsdinfo>()).ok()?;
    // SAFETY: proc_pidinfo writes at most `size` bytes into `info`.
    let written =
        unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&raw mut info).cast(), size) };
    // A zombie has exited: it runs nothing.
    (written == size && info.pbi_status != libc::SZOMB).then_some(info.pbi_ppid)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn parent(_pid: u32) -> Option<u32> {
    None
}

/// Milliseconds since the Unix epoch.
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn worker(pid: u32, slot: &str) -> RunningWorker {
        RunningWorker {
            pid,
            harness: "codex".into(),
            slot: slot.into(),
            task_id: "task".into(),
            attempt_id: "attempt".into(),
            tag_id: "tag".into(),
            state: RunningState::Starting,
            started_at_ms: 1,
        }
    }

    #[test]
    fn the_status_lists_live_child_workers_with_their_state() {
        let directory = tempfile::tempdir().unwrap();
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let workers = Workers::open(directory.path());
        workers.started(worker(child.id(), "codex-0"));
        workers.state("codex-0", WorkerState::Executing);
        let listed = running_workers(directory.path(), std::process::id());
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].pid, child.id());
        assert_eq!(listed[0].state, RunningState::Executing);
        workers.ended("codex-0");
        assert!(running_workers(directory.path(), std::process::id()).is_empty());
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn a_worker_that_is_gone_or_not_the_worklets_child_is_not_listed() {
        let directory = tempfile::tempdir().unwrap();
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let gone = child.id();
        child.kill().unwrap();
        child.wait().unwrap();
        let workers = Workers::open(directory.path());
        workers.started(worker(gone, "codex-0"));
        // A live process the Worklet did not start: its parent is another.
        workers.started(worker(parent(std::process::id()).unwrap(), "codex-1"));
        assert!(running_workers(directory.path(), std::process::id()).is_empty());
    }

    #[test]
    fn a_file_naming_another_or_a_dead_worklet_lists_nothing() {
        let directory = tempfile::tempdir().unwrap();
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let workers = Workers::open(directory.path());
        workers.started(worker(child.id(), "codex-0"));
        // The supervisor's record names a different Worklet process.
        assert!(running_workers(directory.path(), child.id()).is_empty());
        child.kill().unwrap();
        child.wait().unwrap();
        // A Worklet that dropped its record leaves an empty file.
        drop(workers);
        assert!(running_workers(directory.path(), std::process::id()).is_empty());
        assert!(running_workers(&directory.path().join("missing"), std::process::id()).is_empty());
    }
}
