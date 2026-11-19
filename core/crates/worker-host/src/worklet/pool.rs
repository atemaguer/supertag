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

/// How long a Worker may take to stop after `Drain` before the Worklet sends `Cancel`, and after
/// that before it kills the Worker.
const DRAIN_GRACE: Duration = Duration::from_secs(5);
const STOP_GRACE: Duration = Duration::from_secs(10);
/// How long a Worker may run on after it handed over its outcome, stopping its harness and
/// sandbox, before the Worklet stops it.
const CLEANUP_GRACE: Duration = Duration::from_secs(300);
/// How long a Worker may run on after the Control Plane ended its lease before the Worklet stops
/// it: long enough to stop its harness and sandbox.
const LOST_LEASE_GRACE: Duration = Duration::from_secs(120);
/// How long past its harness's time limit a Worker may take to capture and hand over what the
/// turn produced before the Worklet stops it.
const CAPTURE_GRACE: Duration = Duration::from_secs(1800);

/// How long a Worker may run on at each point before the Worklet stops it.
pub(crate) struct Limits {
    /// From its harness's launch: the harness's time limit and the capture grace.
    pub(crate) executing: Duration,
    /// From its outcome.
    pub(crate) cleanup: Duration,
    /// From the end of its lease.
    pub(crate) lost_lease: Duration,
    /// From `Cancel` to the kill, and from the end of its channel to the kill.
    pub(crate) stop: Duration,
}

impl Limits {
    pub(crate) fn for_attempt(time_limit: Duration) -> Self {
        Self {
            executing: time_limit.saturating_add(CAPTURE_GRACE),
            cleanup: CLEANUP_GRACE,
            lost_lease: LOST_LEASE_GRACE,
            stop: STOP_GRACE,
        }
    }
}
/// The most descriptors a Worker's start checks for ones it must not inherit.
const MAX_CHECKED_DESCRIPTORS: libc::rlim_t = 65_536;

/// The variable a supervisor's lifeline sets; a Worker's lifeline is its channel instead.
const SERVICE_LIFELINE: &str = "SUPERTAG_LOCAL_SERVICE_LIFELINE";

/// One running Worker: its process, in a process group of its own, and the Worklet's end of its
/// channel.
pub(crate) struct WorkerProcess {
    child: tokio::process::Child,
    reader: Option<OwnedReadHalf>,
    writer: Arc<Mutex<OwnedWriteHalf>>,
    group: i32,
    /// Whether the Worker was waited for. One dropped before, as when its slot's task is
    /// aborted, has its whole process group killed.
    reaped: bool,
}

impl Drop for WorkerProcess {
    fn drop(&mut self) {
        if !self.reaped {
            self.kill();
        }
    }
}

/// The soft limit on this process's descriptors, which bounds the ones a child can inherit.
fn descriptor_limit() -> libc::c_int {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: getrlimit writes only the struct it is given.
    let soft = if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } == 0 {
        limit.rlim_cur.min(MAX_CHECKED_DESCRIPTORS)
    } else {
        MAX_CHECKED_DESCRIPTORS
    };
    libc::c_int::try_from(soft).unwrap_or(libc::c_int::MAX)
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
        // terminal-safe: the Worker's standard output is this standard error, not written here.
        let stdout = std::io::stderr()
            .as_fd_owned()
            .context("share the Worklet's log with its Worker")?;
        command.stdout(Stdio::from(stdout)).stderr(Stdio::inherit());
        // Its own process group: a terminal's interrupt reaches the Worklet, which stops it.
        command.process_group(0);
        let channel = theirs.as_raw_fd();
        let limit = descriptor_limit();
        // SAFETY: the hook runs between fork and exec and only calls the async-signal-safe dup2,
        // fcntl, and close on descriptors of the forked child.
        unsafe {
            command.pre_exec(move || {
                if channel == CHANNEL_FD {
                    if libc::fcntl(CHANNEL_FD, libc::F_SETFD, 0) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                } else if libc::dup2(channel, CHANNEL_FD) != CHANNEL_FD {
                    return Err(std::io::Error::last_os_error());
                }
                // Where descriptors are made and marked close-on-exec in two steps, as on
                // macOS, one another slot's thread just made, such as a sibling Worker's end of
                // its channel, can still lack the mark. The Worker inherits only 0 to 3.
                for descriptor in CHANNEL_FD + 1..limit {
                    let flags = libc::fcntl(descriptor, libc::F_GETFD);
                    if flags >= 0 && flags & libc::FD_CLOEXEC == 0 {
                        libc::close(descriptor);
                    }
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
            reader: Some(reader),
            writer: Arc::new(Mutex::new(writer)),
            group,
            reaped: false,
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

    async fn wait(&mut self) -> Option<ExitStatus> {
        let status = self.child.wait().await.ok();
        self.reaped = status.is_some();
        status
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

/// When the Worklet stops a Worker that does not stop by itself: `Cancel` at `cancel`, and a
/// kill of its process group at `kill`. The earliest deadline armed wins.
#[derive(Default)]
struct Deadlines {
    cancel: Option<tokio::time::Instant>,
    kill: Option<tokio::time::Instant>,
}

impl Deadlines {
    /// Sends `Cancel` `after` from now at the latest, and kills `stop` after that. A deadline
    /// too far to name is none.
    fn arm(&mut self, after: Duration, stop: Duration) {
        let Some(cancel) = tokio::time::Instant::now().checked_add(after) else {
            return;
        };
        if self.cancel.is_none_or(|armed| cancel < armed) {
            self.cancel = Some(cancel);
        }
        let Some(kill) = cancel.checked_add(stop) else {
            return;
        };
        if self.kill.is_none_or(|armed| kill < armed) {
            self.kill = Some(kill);
        }
    }
}

async fn until(at: Option<tokio::time::Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

/// Assigns the Attempt to the Worker and serves it until it exits. `stop` asks it to drain. A
/// Worker still running past its drain, or past one of its `limits`, is cancelled, and then
/// killed with its process group.
pub(crate) async fn serve(
    mut process: WorkerProcess,
    assign: Assign,
    handler: &impl Serve,
    stop: &CancellationToken,
    limits: Limits,
) -> WorkerEnd {
    // The one Attempt this Worker may ask host calls for.
    let own = assign.attempt.inspect();
    let mut outcome = None;
    if WorkerProcess::send(&process.writer, &ToWorker::Assign(Box::new(assign)))
        .await
        .is_err()
    {
        process.kill();
        let status = process.wait().await;
        return WorkerEnd { outcome, status };
    }
    // A frame is read whole in its own task: a read cut short by another event would lose the
    // bytes it consumed and put the stream out of step.
    let (frames, mut incoming) = tokio::sync::mpsc::channel(1);
    let mut reader = process
        .reader
        .take()
        .expect("a Worker's channel is read once");
    let _reading = crate::worklet::authority::AbortOnDrop(tokio::spawn(async move {
        loop {
            let frame = read_frame::<FromWorker>(&mut reader).await;
            let last = !matches!(frame, Ok(Some(_)));
            if frames.send(frame).await.is_err() || last {
                return;
            }
        }
    }));
    let mut calls = tokio::task::JoinSet::new();
    let mut deadlines = Deadlines::default();
    let mut draining = false;
    loop {
        tokio::select! {
            message = incoming.recv() => {
                let message = match message {
                    Some(Ok(Some(message))) => message,
                    // End of file or a malformed message: the Worker is gone or not to be
                    // trusted; reap it.
                    _ => break,
                };
                match message {
                    FromWorker::State(state) => handler.state(state),
                    FromWorker::Milestone { id, milestone } => {
                        let executing = matches!(milestone, Milestone::Executing);
                        let result = handler
                            .milestone(milestone, process.group)
                            .map(|()| Bytes::default());
                        if executing && result.is_ok() {
                            deadlines.arm(limits.executing, limits.stop);
                        }
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
                            // What is left is the Worker's cleanup; the Worklet acts on the
                            // outcome once it exits.
                            deadlines.arm(limits.cleanup, limits.stop);
                        }
                        if reply(&process.writer, id, result).await.is_err() {
                            break;
                        }
                    }
                    FromWorker::Request { id, call } => {
                        if let Err(refused) = call.check(&own) {
                            if reply(&process.writer, id, Err(refused)).await.is_err() {
                                break;
                            }
                            continue;
                        }
                        let answer = handler.call(call);
                        let writer = process.writer.clone();
                        calls.spawn(async move {
                            let (result, lease) = answer.await;
                            let lost = matches!(lease, Some(LeaseChange::Lost { .. }));
                            if let Some(change) = lease {
                                let _ = WorkerProcess::send(&writer, &ToWorker::Lease(change)).await;
                            }
                            let _ = reply(&writer, id, result).await;
                            lost
                        });
                    }
                }
            }
            Some(joined) = calls.join_next(), if !calls.is_empty() => {
                if matches!(joined, Ok(true)) {
                    // The Control Plane ended the lease: the Attempt is over, whatever the
                    // Worker still does.
                    deadlines.arm(limits.lost_lease, limits.stop);
                }
            }
            () = stop.cancelled(), if !draining => {
                draining = true;
                let _ = WorkerProcess::send(&process.writer, &ToWorker::Drain).await;
                deadlines.arm(DRAIN_GRACE, limits.stop);
            }
            () = until(deadlines.cancel) => {
                // Still running past its deadline: stop now.
                let _ = WorkerProcess::send(&process.writer, &ToWorker::Cancel).await;
                deadlines.cancel = None;
            }
            () = until(deadlines.kill) => {
                process.kill();
                deadlines.kill = None;
            }
        }
    }
    calls.abort_all();
    // The channel is closed; a Worker that has not exited yet is stopping or stuck.
    let status = match tokio::time::timeout(limits.stop, process.child.wait()).await {
        Ok(status) => {
            process.reaped = status.is_ok();
            status.ok()
        }
        Err(_) => {
            process.kill();
            process.wait().await
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
            // A connection the Control Plane dropped is retryable for the Worker too; its local
            // cause does not cross the channel.
            result: result
                .map_err(|status| WireStatus::from(&supertag_protocol::upstream_status(status))),
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local::Proto;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use supertag_protocol::v2::InspectAttemptRequest;

    /// Counts the host calls it is asked to make, which take `delay` and change the lease by
    /// `lease`, and the outcomes it journals.
    #[derive(Default)]
    struct Counting {
        calls: Arc<AtomicUsize>,
        outcomes: Arc<AtomicUsize>,
        delay: Duration,
        lease: Option<LeaseChange>,
    }

    impl Serve for Counting {
        fn milestone(&self, _: Milestone, _: i32) -> Result<(), Status> {
            Ok(())
        }
        fn outcome(&self, _: &Outcome) -> Result<(), Status> {
            self.outcomes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn state(&self, _: WorkerState) {}
        fn call(&self, _: HostCall) -> HostAnswer {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let (delay, lease) = (self.delay, self.lease.clone());
            Box::pin(async move {
                tokio::time::sleep(delay).await;
                (Ok(Bytes::default()), lease)
            })
        }
    }

    fn attempt() -> crate::worklet::journal::Attempt {
        crate::worklet::journal::Attempt {
            task_id: "task".into(),
            attempt_id: "attempt".into(),
            lease_token: "lease".into(),
            attempt_credential: "stat_worker".into(),
            execution_selection: None,
            requires_unsandboxed_commands: false,
            joined: vec![],
            native_memory: None,
            volume: None,
        }
    }

    fn assign() -> Assign {
        Assign {
            slot: "adapter-0".into(),
            state_directory: "/nonexistent".into(),
            attempt: attempt(),
            task: Proto(Default::default()),
            workspace: None,
            checkpoint: None,
            valid_for_ms: 1_000,
            registration: Proto(Default::default()),
            protocol: 1,
            data_endpoint: "http://127.0.0.1:1".into(),
            secrets: Default::default(),
            resume_captures: None,
        }
    }

    fn limits() -> Limits {
        Limits {
            executing: Duration::from_secs(60),
            cleanup: Duration::from_secs(60),
            lost_lease: Duration::from_secs(60),
            stop: Duration::from_millis(200),
        }
    }

    /// `message` as the bytes of a frame: its length, then its body.
    fn frame(message: &FromWorker) -> (Vec<u8>, Vec<u8>) {
        let body = serde_json::to_vec(message).unwrap();
        ((body.len() as u32).to_be_bytes().to_vec(), body)
    }

    /// A shell command that writes `bytes` to the Worker's channel.
    fn written(bytes: &[u8]) -> String {
        let escaped: String = bytes.iter().map(|byte| format!("\\{byte:03o}")).collect();
        format!("printf '{escaped}' >&3")
    }

    fn renewal(attempt_id: &str) -> FromWorker {
        FromWorker::Request {
            id: 1,
            call: HostCall::Renew(Proto(InspectAttemptRequest {
                task_id: "task".into(),
                attempt_id: attempt_id.into(),
                lease_token: "lease".into(),
            })),
        }
    }

    fn stand_in(script: String) -> WorkerProcess {
        let launch = WorkerLaunch {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
        };
        WorkerProcess::spawn(&launch, "stcr_host-credential").unwrap()
    }

    /// A stand-in Worker that sends one host call naming `attempt_id`, then reads its reply.
    async fn worker_asking_for(attempt_id: &str) -> usize {
        let (size, body) = frame(&renewal(attempt_id));
        let process = stand_in(format!("{}; {}; sleep 1", written(&size), written(&body)));
        let handler = Counting::default();
        let calls = handler.calls.clone();
        let end = serve(
            process,
            assign(),
            &handler,
            &CancellationToken::new(),
            limits(),
        )
        .await;
        assert!(end.died(), "the stand-in hands over no outcome");
        calls.load(Ordering::SeqCst)
    }

    #[tokio::test]
    async fn the_worklet_makes_host_calls_only_for_the_workers_own_attempt() {
        assert_eq!(worker_asking_for("attempt").await, 1);
        assert_eq!(
            worker_asking_for("another-attempt").await,
            0,
            "a host call naming another Attempt never reaches the host"
        );
    }

    #[tokio::test]
    async fn a_frame_a_host_call_answers_in_the_middle_of_arrives_whole() {
        // The renewal is answered while the outcome's length has arrived and its body has not.
        let (call_size, call_body) = frame(&renewal("attempt"));
        let (size, body) = frame(&FromWorker::Outcome {
            id: 2,
            outcome: Box::new(Outcome::Retry),
        });
        let mut first = call_size;
        first.extend(call_body);
        first.extend(size);
        let process = stand_in(format!(
            "{}; sleep 1; {}; sleep 1",
            written(&first),
            written(&body)
        ));
        let handler = Counting {
            delay: Duration::from_millis(100),
            ..Counting::default()
        };
        let end = serve(
            process,
            assign(),
            &handler,
            &CancellationToken::new(),
            limits(),
        )
        .await;
        assert_eq!(handler.calls.load(Ordering::SeqCst), 1);
        assert_eq!(end.outcome, Some(OutcomeKind::Retry), "{}", end.describe());
        assert_eq!(end.status.and_then(|status| status.code()), Some(0));
    }

    #[tokio::test]
    async fn a_worker_that_outlives_its_outcome_is_killed() {
        let (size, body) = frame(&FromWorker::Outcome {
            id: 1,
            outcome: Box::new(Outcome::Retry),
        });
        let mut bytes = size;
        bytes.extend(body);
        let process = stand_in(format!("{}; exec sleep 600", written(&bytes)));
        let handler = Counting::default();
        let started = std::time::Instant::now();
        let end = serve(
            process,
            assign(),
            &handler,
            &CancellationToken::new(),
            Limits {
                cleanup: Duration::from_millis(200),
                ..limits()
            },
        )
        .await;
        assert_eq!(end.outcome, Some(OutcomeKind::Retry));
        assert_eq!(
            end.status.and_then(|status| status.signal()),
            Some(libc::SIGKILL)
        );
        assert!(started.elapsed() < Duration::from_secs(30));
    }

    #[tokio::test]
    async fn a_worker_whose_lease_ended_is_killed() {
        let (size, body) = frame(&renewal("attempt"));
        let mut bytes = size;
        bytes.extend(body);
        let process = stand_in(format!("{}; exec sleep 600", written(&bytes)));
        let handler = Counting {
            lease: Some(LeaseChange::Lost {
                message: "lease expired".into(),
            }),
            ..Counting::default()
        };
        let end = serve(
            process,
            assign(),
            &handler,
            &CancellationToken::new(),
            Limits {
                lost_lease: Duration::from_millis(200),
                ..limits()
            },
        )
        .await;
        assert!(end.died());
        assert_eq!(
            end.status.and_then(|status| status.signal()),
            Some(libc::SIGKILL)
        );
    }

    #[tokio::test]
    async fn a_worker_inherits_no_descriptor_but_its_channel() {
        // One another thread made and has not marked close-on-exec yet.
        let null = std::fs::File::open("/dev/null").unwrap();
        // SAFETY: dup returns a new descriptor this test owns and closes.
        let leaked = unsafe { libc::dup(null.as_raw_fd()) };
        assert!(leaked > CHANNEL_FD);
        let (size, body) = frame(&FromWorker::Outcome {
            id: 1,
            outcome: Box::new(Outcome::Retry),
        });
        let mut bytes = size;
        bytes.extend(body);
        // The stand-in hands over an outcome only when the descriptor is not open in it.
        let process = stand_in(format!(
            "[ -e /dev/fd/{leaked} ] || {}; sleep 1",
            written(&bytes)
        ));
        let end = serve(
            process,
            assign(),
            &Counting::default(),
            &CancellationToken::new(),
            limits(),
        )
        .await;
        // SAFETY: closing the descriptor dup returned above.
        unsafe { libc::close(leaked) };
        assert_eq!(
            end.outcome,
            Some(OutcomeKind::Retry),
            "the Worker inherited descriptor {leaked}"
        );
    }

    #[test]
    fn an_assignment_carries_no_host_credential() {
        let assign = Assign {
            slot: "adapter-0".into(),
            state_directory: "/state/slots/adapter-0".into(),
            attempt: attempt(),
            task: Proto(Default::default()),
            workspace: None,
            checkpoint: None,
            valid_for_ms: 1_000,
            registration: Proto(Default::default()),
            protocol: 1,
            data_endpoint: "http://127.0.0.1:1".into(),
            secrets: crate::local::AttemptSecrets {
                provider: [("OPENAI_API_KEY".to_owned(), "sk-harness".to_owned())].into(),
                network: vec![],
            },
            resume_captures: None,
        };
        // The Assign has no field for it: what the Worker receives is its Attempt's credential
        // and its harness's own secrets.
        let text = serde_json::to_string(&ToWorker::Assign(Box::new(assign))).unwrap();
        assert!(text.contains("stat_worker") && text.contains("sk-harness"));
        assert!(!text.contains("stcr_"));
    }

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
