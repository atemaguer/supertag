//! The Worklet's Worker pool: it starts one Worker process for each assigned Attempt, serves its
//! end of the local contract, and watches, cancels, kills, and reaps it.

use std::{
    os::{
        fd::AsRawFd,
        unix::process::{CommandExt as _, ExitStatusExt as _},
    },
    process::{ExitStatus, Stdio},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result};
use tokio::{
    net::unix::{OwnedReadHalf, OwnedWriteHalf},
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;
use tonic::Status;

use crate::{
    local::{
        Assign, Bytes, CHANNEL_FD, FromWorker, HostCall, LeaseChange, Milestone, Outcome, ToWorker,
        WireStatus, WorkerState, read_frame, write_frame,
    },
    worklet::WorkerLaunch,
};

/// How long a Worker may take to stop after `Drain` or `Cancel` before the Worklet kills it.
const STOP_GRACE: Duration = Duration::from_secs(10);

/// The variable a supervisor's lifeline sets; a Worker's lifeline is its channel instead.
const SERVICE_LIFELINE: &str = "SUPERTAG_LOCAL_SERVICE_LIFELINE";

/// One running Worker: its process, in a process group of its own, and the Worklet's end of its
/// channel.
pub(crate) struct WorkerProcess {
    child: tokio::process::Child,
    reader: OwnedReadHalf,
    writer: Arc<Mutex<OwnedWriteHalf>>,
    group: i32,
}

/// The environment variables a Worker must not inherit: the host credential, by name and by
/// value, and the sources of the network credentials, which its `Assign` carries instead.
pub(crate) fn withheld_environment(host_token: &str) -> Vec<std::ffi::OsString> {
    let mut withheld = vec![
        std::ffi::OsString::from("SUPERTAG_HOST_TOKEN"),
        SERVICE_LIFELINE.into(),
    ];
    for (name, value) in std::env::vars_os() {
        let source = name
            .to_str()
            .is_some_and(|name| name.starts_with("SUPERTAG_NETWORK_CREDENTIAL_"));
        if source || (!host_token.is_empty() && value.as_encoded_bytes() == host_token.as_bytes()) {
            withheld.push(name);
        }
    }
    withheld
}

impl WorkerProcess {
    /// Starts a Worker with `launch`, its end of a new socket pair as descriptor 3, and none of
    /// the host's credential.
    pub(crate) fn spawn(launch: &WorkerLaunch, host_token: &str) -> Result<Self> {
        let (ours, theirs) =
            std::os::unix::net::UnixStream::pair().context("create the Worker's channel")?;
        let mut command = std::process::Command::new(&launch.program);
        command.args(&launch.args).stdin(Stdio::null());
        for name in withheld_environment(host_token) {
            command.env_remove(name);
        }
        // A Worker writes nothing to the Worklet's standard output, which a supervisor reads for
        // readiness; its log lines join the Worklet's on standard error.
        let stdout = std::io::stderr()
            .as_fd_owned()
            .context("share the Worklet's log with its Worker")?;
        command.stdout(Stdio::from(stdout)).stderr(Stdio::inherit());
        // Its own process group: a terminal's interrupt reaches the Worklet, which stops it.
        command.process_group(0);
        let channel = theirs.as_raw_fd();
        // SAFETY: the hook runs between fork and exec and only calls the async-signal-safe dup2
        // and fcntl on descriptors this process owns.
        unsafe {
            command.pre_exec(move || {
                if channel == CHANNEL_FD {
                    if libc::fcntl(CHANNEL_FD, libc::F_SETFD, 0) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                } else if libc::dup2(channel, CHANNEL_FD) != CHANNEL_FD {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut command = tokio::process::Command::from(command);
        command.kill_on_drop(true);
        let child = command.spawn().context("start a Worker")?;
        drop(theirs);
        ours.set_nonblocking(true)?;
        let (reader, writer) = tokio::net::UnixStream::from_std(ours)?.into_split();
        let group = child
            .id()
            .and_then(|pid| i32::try_from(pid).ok())
            .context("the Worker has no process ID")?;
        Ok(Self {
            child,
            reader,
            writer: Arc::new(Mutex::new(writer)),
            group,
        })
    }

    async fn send(writer: &Mutex<OwnedWriteHalf>, message: &ToWorker) -> Result<()> {
        write_frame(&mut *writer.lock().await, message).await
    }

    fn kill(&self) {
        // SAFETY: signalling the Worker's own process group, which only it and its children
        // belong to.
        unsafe {
            libc::kill(-self.group, libc::SIGKILL);
        }
    }
}

trait OwnedFd {
    fn as_fd_owned(&self) -> std::io::Result<std::os::fd::OwnedFd>;
}

impl OwnedFd for std::io::Stderr {
    fn as_fd_owned(&self) -> std::io::Result<std::os::fd::OwnedFd> {
        use std::os::fd::AsFd as _;
        self.as_fd().try_clone_to_owned()
    }
}

/// A host call the Worklet makes for a Worker: its answer, and how it changed the lease.
pub(crate) type HostAnswer = std::pin::Pin<
    Box<dyn std::future::Future<Output = (Result<Bytes, Status>, Option<LeaseChange>)> + Send>,
>;

/// What the Worklet does with each message of a Worker it serves.
pub(crate) trait Serve {
    /// Journals a stage the Worker reached. `group` is the Worker's process group.
    fn milestone(&self, milestone: Milestone, group: i32) -> Result<(), Status>;
    /// Journals the outcome the Worklet finishes the Attempt with.
    fn outcome(&self, outcome: &Outcome) -> Result<(), Status>;
    fn state(&self, state: WorkerState);
    /// Makes a host-signed call for the Worker's own Attempt, and reports how it changed the
    /// lease.
    fn call(&self, call: HostCall) -> HostAnswer;
}

/// How a Worker ended.
pub(crate) struct WorkerEnd {
    /// The outcome it handed over, journaled.
    pub(crate) outcome: Option<OutcomeKind>,
    pub(crate) status: Option<ExitStatus>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OutcomeKind {
    Retry,
    Finish,
    Finalizing,
}

impl WorkerEnd {
    /// Whether the Worker died rather than exiting after its outcome.
    pub(crate) fn died(&self) -> bool {
        self.outcome.is_none()
    }

    pub(crate) fn describe(&self) -> String {
        match self.status {
            Some(status) => match status.signal() {
                Some(signal) => format!("was killed by signal {signal}"),
                None => format!("exited with {status}"),
            },
            None => "could not be waited for".into(),
        }
    }
}

/// Assigns the Attempt to the Worker and serves it until it exits. `stop` asks it to drain, and
/// kills it after a grace period.
pub(crate) async fn serve(
    mut process: WorkerProcess,
    assign: Assign,
    handler: &impl Serve,
    stop: &CancellationToken,
) -> WorkerEnd {
    let mut outcome = None;
    if WorkerProcess::send(&process.writer, &ToWorker::Assign(Box::new(assign)))
        .await
        .is_err()
    {
        process.kill();
        let status = process.child.wait().await.ok();
        return WorkerEnd { outcome, status };
    }
    let mut calls = tokio::task::JoinSet::new();
    let mut kill_at: Option<tokio::time::Instant> = None;
    loop {
        let killing = async {
            match kill_at {
                Some(at) => tokio::time::sleep_until(at).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            message = read_frame::<FromWorker>(&mut process.reader) => {
                let message = match message {
                    Ok(Some(message)) => message,
                    // End of file or a malformed message: the Worker is gone or not to be
                    // trusted; reap it.
                    Ok(None) | Err(_) => break,
                };
                match message {
                    FromWorker::State(state) => handler.state(state),
                    FromWorker::Milestone { id, milestone } => {
                        let result = handler
                            .milestone(milestone, process.group)
                            .map(|()| Bytes::default());
                        if reply(&process.writer, id, result).await.is_err() {
                            break;
                        }
                    }
                    FromWorker::Outcome { id, outcome: handed } => {
                        let result = handler.outcome(&handed).map(|()| Bytes::default());
                        if result.is_ok() {
                            outcome = Some(match *handed {
                                Outcome::Retry => OutcomeKind::Retry,
                                Outcome::Finish { .. } => OutcomeKind::Finish,
                                Outcome::Finalizing { .. } => OutcomeKind::Finalizing,
                            });
                        }
                        if reply(&process.writer, id, result).await.is_err() {
                            break;
                        }
                    }
                    FromWorker::Request { id, call } => {
                        let answer = handler.call(call);
                        let writer = process.writer.clone();
                        calls.spawn(async move {
                            let (result, lease) = answer.await;
                            if let Some(change) = lease {
                                let _ = WorkerProcess::send(&writer, &ToWorker::Lease(change)).await;
                            }
                            let _ = reply(&writer, id, result).await;
                        });
                    }
                }
            }
            Some(_) = calls.join_next(), if !calls.is_empty() => {}
            () = stop.cancelled(), if kill_at.is_none() => {
                let _ = WorkerProcess::send(&process.writer, &ToWorker::Drain).await;
                kill_at = Some(tokio::time::Instant::now() + STOP_GRACE);
            }
            () = killing => {
                process.kill();
                kill_at = Some(tokio::time::Instant::now() + Duration::from_secs(3600));
            }
        }
    }
    calls.abort_all();
    // The channel is closed; a Worker that has not exited yet is stopping or stuck.
    let status = match tokio::time::timeout(STOP_GRACE, process.child.wait()).await {
        Ok(status) => status.ok(),
        Err(_) => {
            process.kill();
            process.child.wait().await.ok()
        }
    };
    WorkerEnd { outcome, status }
}

async fn reply(
    writer: &Mutex<OwnedWriteHalf>,
    id: u64,
    result: Result<Bytes, Status>,
) -> Result<()> {
    WorkerProcess::send(
        writer,
        &ToWorker::Reply {
            id,
            result: result.map_err(|status| WireStatus::from(&status)),
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_worker_inherits_no_host_credential_variable() {
        // SAFETY: this test's process sets a variable no other test reads.
        unsafe {
            std::env::set_var("SUPERTAG_POOL_TEST_COPY", "stcr_pool-test-secret");
            std::env::set_var("SUPERTAG_NETWORK_CREDENTIAL_POOL_TEST", "value");
        }
        let withheld = withheld_environment("stcr_pool-test-secret");
        for name in [
            "SUPERTAG_HOST_TOKEN",
            "SUPERTAG_POOL_TEST_COPY",
            "SUPERTAG_NETWORK_CREDENTIAL_POOL_TEST",
            SERVICE_LIFELINE,
        ] {
            assert!(withheld.iter().any(|withheld| withheld == name), "{name}");
        }
    }
}
