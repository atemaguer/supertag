//! Bounded harness probes. Each probe runs with an explicit environment in its own process group.
//! The group is killed with SIGKILL before its leader is reaped, whether the leader exited,
//! its stop condition fired, or it failed, so no descendant outlives the probe: while the leader
//! is unreaped, its process ID names its group and cannot be reused. Probe stdout is read with
//! fixed limits, and stderr is never read: native CLIs can print credentials there.
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    future::Future,
    os::unix::fs::PermissionsExt as _,
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    sync::{
        OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, anyhow, ensure};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::watch,
};

/// Variables a probe passes to its child. Nothing else from this process reaches it.
pub type Variables = BTreeMap<OsString, OsString>;

/// Process identity and locale shared by every probe, as TypeScript's `minimalProcessEnvironment`.
pub const PROCESS_VARIABLES: [&str; 11] = [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM",
];

static ACTIVE: AtomicUsize = AtomicUsize::new(0);
/// The signal that stopped an interactive probe, once one has.
static INTERRUPTED: OnceLock<watch::Sender<Option<i32>>> = OnceLock::new();
/// Signals that end an interactive command. A probe runs in its own process group, so a signal
/// sent to the terminal's group, or to this process, never reaches it; each is handled here.
const ENDING_SIGNALS: [i32; 3] = [libc::SIGINT, libc::SIGTERM, libc::SIGHUP];

/// The stop condition of a probe in an interactive command (`sign-in`, `init`): a deadline, or
/// SIGINT (Ctrl-C), SIGTERM or SIGHUP (a closed terminal). Such a signal while a probe runs stops
/// the probe so that its process group is killed and its temporary directory removed, and
/// `exit_if_interrupted` then ends the command; the signal at any other time ends the command at
/// once, with the status the signal's default action would report to a shell. Never used by the
/// supervisor, which handles its own signals.
pub async fn interactive_deadline(timeout: Duration) {
    struct Active;
    impl Drop for Active {
        fn drop(&mut self) {
            ACTIVE.fetch_sub(1, Ordering::SeqCst);
        }
    }
    ACTIVE.fetch_add(1, Ordering::SeqCst);
    let _active = Active;
    let mut interrupted = INTERRUPTED
        .get_or_init(|| {
            let (sender, _) = watch::channel(None);
            for number in ENDING_SIGNALS {
                let Ok(mut signals) =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::from_raw(number))
                else {
                    continue;
                };
                let watcher = sender.clone();
                tokio::spawn(async move {
                    while signals.recv().await.is_some() {
                        if ACTIVE.load(Ordering::SeqCst) == 0 {
                            std::process::exit(128 + number);
                        }
                        watcher.send_replace(Some(number));
                    }
                });
            }
            sender
        })
        .subscribe();
    tokio::select! {
        () = tokio::time::sleep(timeout) => {}
        _ = interrupted.wait_for(Option::is_some) => {}
    }
}

/// End the command if a signal stopped a probe. Call once the probe's cleanup has run.
pub fn exit_if_interrupted() {
    if let Some(number) = INTERRUPTED
        .get()
        .and_then(|interrupted| *interrupted.borrow())
    {
        std::process::exit(128 + number);
    }
}

/// An executable regular file named `command` in a directory of `path`. An absolute command is
/// checked as is.
pub fn find_on_path(command: &str, path: Option<&OsStr>) -> Option<PathBuf> {
    let executable = |candidate: &Path| {
        std::fs::metadata(candidate)
            .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
    };
    let command = Path::new(command);
    if command.is_absolute() {
        return executable(command).then(|| command.to_owned());
    }
    std::env::split_paths(path?)
        .filter(|directory| !directory.as_os_str().is_empty())
        .map(|directory| directory.join(command))
        .find(|candidate| executable(candidate))
}

pub struct Probe {
    child: Child,
    pid: libc::pid_t,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    /// The leader was reaped, after its group was killed; its process ID may name another
    /// process now.
    reaped: bool,
}

impl Probe {
    /// Start `program` with exactly `variables`, in `directory` or `/`, with stderr discarded.
    pub fn start(
        program: &Path,
        args: &[OsString],
        variables: &Variables,
        directory: Option<&Path>,
    ) -> Result<Self> {
        let mut command = Command::new(program);
        command
            .args(args)
            .env_clear()
            .envs(variables)
            .current_dir(directory.unwrap_or(Path::new("/")))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .with_context(|| format!("could not start {}", program.display()))?;
        let pid = libc::pid_t::try_from(child.id().context("probe process ID is unavailable")?)?;
        let stdin = child.stdin.take();
        let stdout = BufReader::new(child.stdout.take().context("probe output is unavailable")?);
        Ok(Self {
            child,
            pid,
            stdin,
            stdout,
            reaped: false,
        })
    }

    /// One line of output without its newline, or None at end of output.
    pub async fn line(&mut self, limit: usize) -> Result<Option<Vec<u8>>> {
        let mut line = Vec::new();
        let read = (&mut self.stdout)
            .take(limit as u64 + 1)
            .read_until(b'\n', &mut line)
            .await
            .context("could not read probe output")?;
        if read == 0 {
            return Ok(None);
        }
        ensure!(
            line.len() <= limit || line.ends_with(b"\n"),
            "probe output line exceeds its limit"
        );
        while line
            .last()
            .is_some_and(|byte| matches!(byte, b'\n' | b'\r'))
        {
            line.pop();
        }
        Ok(Some(line))
    }

    /// The JSON object on the next non-blank line that parses as one; other lines are skipped.
    pub async fn object(&mut self, limit: usize) -> Result<Option<Value>> {
        while let Some(line) = self.line(limit).await? {
            if let Ok(value @ Value::Object(_)) = serde_json::from_slice::<Value>(&line) {
                return Ok(Some(value));
            }
        }
        Ok(None)
    }

    /// The rest of the output, at most `limit` bytes. Once the leader exits, its group is killed,
    /// so a descendant that still holds the output cannot keep the probe running.
    pub async fn rest(&mut self, limit: usize) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        {
            let mut limited = (&mut self.stdout).take(limit as u64 + 1);
            let read = limited.read_to_end(&mut bytes);
            tokio::pin!(read);
            tokio::select! {
                result = &mut read => { result.context("could not read probe output")?; }
                result = exited(self.pid) => {
                    result?;
                    kill_group(self.pid);
                    read.await.context("could not read probe output")?;
                }
            }
        }
        ensure!(bytes.len() <= limit, "probe output exceeds its limit");
        Ok(bytes)
    }

    /// A probe that stops reading (it answered and exited, or closed its input) is not an
    /// error here: its output and exit status decide the result, so a broken pipe closes the
    /// input instead of failing the check.
    pub async fn write(&mut self, bytes: &[u8]) -> Result<()> {
        let stdin = self.stdin.as_mut().context("probe input is closed")?;
        let written = match stdin.write_all(bytes).await {
            Ok(()) => stdin.flush().await,
            Err(error) => Err(error),
        };
        match written {
            Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => {
                self.close_input();
                Ok(())
            }
            result => result.context("could not write probe input"),
        }
    }

    pub async fn send(&mut self, value: &Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(value)?;
        bytes.push(b'\n');
        self.write(&bytes).await
    }

    pub fn close_input(&mut self) {
        self.stdin = None;
    }

    /// Wait for the leader to exit, kill what is left of its group, then reap the leader.
    pub async fn wait(&mut self) -> Result<ExitStatus> {
        self.close_input();
        ensure!(!self.reaped, "the probe was already reaped");
        exited(self.pid).await?;
        kill_group(self.pid);
        let status = self
            .child
            .wait()
            .await
            .context("could not wait for the probe")?;
        self.reaped = true;
        Ok(status)
    }

    /// Kill the probe's process group, whether or not its leader has exited, then reap the leader.
    pub async fn finish(mut self) {
        self.stdin = None;
        if !self.reaped {
            kill_group(self.pid);
            let _ = self.child.wait().await;
            self.reaped = true;
        }
    }
}

impl Drop for Probe {
    /// A dropped probe, such as one whose caller was cancelled, takes its process group with it.
    /// The leader is reaped by Tokio afterwards.
    fn drop(&mut self) {
        if !self.reaped {
            kill_group(self.pid);
        }
    }
}

/// SIGKILL a probe's process group. Only called while its leader is unreaped, so the group ID
/// cannot name another group.
fn kill_group(pid: libc::pid_t) {
    // SAFETY: sending a signal has no memory effects; see the caller's invariant above.
    unsafe { libc::kill(-pid, libc::SIGKILL) };
}

/// Whether the child `pid` has exited, without reaping it.
fn has_exited(pid: libc::pid_t) -> Result<bool> {
    let id = libc::id_t::try_from(pid)?;
    loop {
        // SAFETY: zero is a valid siginfo_t, which waitid fills in.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        // SAFETY: `info` is a valid, writable siginfo_t; WNOWAIT leaves the child unreaped.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                id,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result == 0 {
            // SAFETY: waitid succeeded, so the child fields are initialised (zero when no child
            // has exited).
            return Ok(unsafe { info.si_pid() } != 0);
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error).context("could not check the probe");
        }
    }
}

/// Resolves once the child `pid` has exited, leaving it unreaped.
async fn exited(pid: libc::pid_t) -> Result<()> {
    // Listening before the first check means no exit after it is missed; the poll is only a
    // fallback.
    let mut children = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::child()).ok();
    while !has_exited(pid)? {
        match &mut children {
            Some(children) => {
                tokio::select! {
                    _ = children.recv() => {}
                    () = tokio::time::sleep(Duration::from_millis(100)) => {}
                }
            }
            None => tokio::time::sleep(Duration::from_millis(20)).await,
        }
    }
    Ok(())
}

/// Run `work` against a started probe until it finishes or `stop` fires, then kill and reap the
/// probe. A stop is reported as a timeout.
pub async fn bounded<T>(
    mut probe: Probe,
    stop: impl Future<Output = ()>,
    work: impl AsyncFnOnce(&mut Probe) -> Result<T>,
) -> Result<T> {
    let outcome = tokio::select! {
        result = work(&mut probe) => result,
        () = stop => Err(anyhow!("the check timed out")),
    };
    probe.finish().await;
    outcome
}

/// Run a command to completion with no input and return its exit status and stdout.
pub async fn output(
    program: &Path,
    args: &[OsString],
    variables: &Variables,
    directory: Option<&Path>,
    input: Option<&[u8]>,
    limit: usize,
    stop: impl Future<Output = ()>,
) -> Result<(ExitStatus, Vec<u8>)> {
    let probe = Probe::start(program, args, variables, directory)?;
    bounded(probe, stop, async move |probe| {
        if let Some(input) = input {
            probe.write(input).await?;
        }
        probe.close_input();
        let stdout = probe.rest(limit).await?;
        let status = probe.wait().await?;
        Ok((status, stdout))
    })
    .await
}

/// The process variables from `process` plus the named credential variables from `lookup`.
pub fn variables<'a>(
    process: impl Fn(&str) -> Option<OsString>,
    credentials: impl IntoIterator<Item = &'a str>,
    lookup: impl Fn(&str) -> Option<OsString>,
) -> Variables {
    let mut variables = Variables::new();
    for name in PROCESS_VARIABLES {
        if let Some(value) = process(name) {
            variables.insert(name.into(), value);
        }
    }
    for name in credentials {
        if let Some(value) = lookup(name) {
            variables.insert(name.into(), value);
        }
    }
    variables
}

/// A trimmed, non-blank UTF-8 variable.
pub fn text(variables: &Variables, name: &str) -> Option<String> {
    variables
        .get(OsStr::new(name))
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    /// An executable shell script in `directory`.
    pub fn script(directory: &Path, name: &str, body: &str) -> PathBuf {
        let path = directory.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    /// Resolves once `path` exists: the probe reached the point a test waits for.
    pub async fn exists(path: PathBuf) {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// Whether a reaped child's process ID no longer names a process.
    pub fn gone(pid_file: &Path) -> bool {
        let pid: libc::pid_t = std::fs::read_to_string(pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // SAFETY: signal 0 only checks that the process exists.
        let result = unsafe { libc::kill(pid, 0) };
        result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }

    #[tokio::test]
    async fn a_probe_that_answers_without_reading_its_input_still_answers() {
        let temporary = tempfile::tempdir().unwrap();
        let program = script(temporary.path(), "answer", "exec printf ok");
        let mut probe = Probe::start(
            &program,
            &[],
            &Variables::from([("PATH".into(), "/usr/bin:/bin".into())]),
            None,
        )
        .unwrap();
        // Wait until the probe has exited, so its input pipe has no reader. Larger than a pipe
        // buffer, so the write cannot complete without one.
        let input = probe.stdin.take();
        assert!(probe.wait().await.unwrap().success());
        probe.stdin = input;
        probe.write(&vec![b'x'; 1 << 20]).await.unwrap();
        assert!(probe.stdin.is_none());
    }

    #[tokio::test]
    async fn a_stopped_probe_is_killed_with_its_process_group_and_reaped() {
        let temporary = tempfile::tempdir().unwrap();
        let started = temporary.path().join("pid");
        let helper = temporary.path().join("helper");
        // The barrier is the probe writing its own process ID; no wall-clock budget decides.
        let program = script(
            temporary.path(),
            "hang",
            &format!(
                "sleep 1000 &\necho $! > '{helper}'\necho $$ > '{started}.tmp'\nmv '{started}.tmp' '{started}'\nwait",
                helper = helper.display(),
                started = started.display()
            ),
        );
        let error = output(
            &program,
            &[],
            &Variables::from([("PATH".into(), "/usr/bin:/bin".into())]),
            None,
            None,
            1024,
            exists(started.clone()),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("timed out"), "{error:#}");
        assert!(gone(&started));
        // The background helper was in the probe's group and was killed with it. Once its
        // orphaned zombie is reaped by init, its ID no longer names a process.
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while !gone(&helper) {
            assert!(std::time::Instant::now() < deadline, "helper survived");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Waits until the process recorded in `pid_file` is gone, for at most 30 seconds.
    async fn until_gone(pid_file: &Path, what: &str) {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while !gone(pid_file) {
            assert!(std::time::Instant::now() < deadline, "{what} survived");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// A leader that starts a background helper, records both process IDs, and exits at once.
    fn exits_leaving_a_helper(
        directory: &Path,
        helper_output: &str,
    ) -> (PathBuf, PathBuf, PathBuf) {
        let started = directory.join("leader");
        let helper = directory.join("helper");
        let program = script(
            directory,
            "leave",
            &format!(
                "/bin/sleep 1000 {helper_output} &\necho $! > '{helper}'\necho $$ > '{started}.tmp'\nmv '{started}.tmp' '{started}'\necho done\nexit 0",
                helper = helper.display(),
                started = started.display()
            ),
        );
        (program, started, helper)
    }

    #[tokio::test]
    async fn an_exited_leader_takes_its_background_children_with_it() {
        let path = Variables::from([("PATH".into(), "/usr/bin:/bin".into())]);
        // A helper that keeps the output open would otherwise hold the probe to its deadline;
        // one that let the output go would otherwise outlive the probe.
        for helper_output in ["", ">/dev/null"] {
            let temporary = tempfile::tempdir().unwrap();
            let (program, _, helper) = exits_leaving_a_helper(temporary.path(), helper_output);
            let (status, stdout) = output(
                &program,
                &[],
                &path,
                None,
                None,
                1024,
                // Only a regression waits this long; it then fails rather than hangs.
                tokio::time::sleep(Duration::from_secs(60)),
            )
            .await
            .unwrap();
            assert!(status.success());
            assert_eq!(stdout, b"done\n");
            until_gone(&helper, "helper").await;
        }
    }

    #[tokio::test]
    async fn a_stopped_or_dropped_probe_whose_leader_exited_still_kills_its_group() {
        let path = Variables::from([("PATH".into(), "/usr/bin:/bin".into())]);
        for drop_it in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let (program, started, helper) = exits_leaving_a_helper(temporary.path(), "");
            let probe = Probe::start(&program, &[], &path, None).unwrap();
            let pid = probe.pid;
            // The barrier: the leader has exited and is still unreaped.
            let leader_exited = async {
                exists(started.clone()).await;
                exited(pid).await.unwrap();
            };
            if drop_it {
                leader_exited.await;
                drop(probe);
            } else {
                // The work never finishes on its own: the helper holds the output open.
                let error = bounded(probe, leader_exited, async |probe| {
                    std::future::pending::<()>().await;
                    probe.rest(1024).await
                })
                .await
                .unwrap_err();
                assert!(error.to_string().contains("timed out"), "{error:#}");
            }
            until_gone(&helper, "helper").await;
        }
    }

    #[tokio::test]
    async fn a_dropped_probe_takes_its_process_group_with_it() {
        let temporary = tempfile::tempdir().unwrap();
        let started = temporary.path().join("pid");
        let program = script(
            temporary.path(),
            "hang",
            &format!(
                "echo $$ > '{0}.tmp'\nmv '{0}.tmp' '{0}'\nexec sleep 1000",
                started.display()
            ),
        );
        let variables = Variables::from([("PATH".into(), "/usr/bin:/bin".into())]);
        let probe = Probe::start(&program, &[], &variables, None).unwrap();
        exists(started.clone()).await;
        // A cancelled caller drops its probe without awaiting `finish`.
        drop(probe);
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while !gone(&started) {
            assert!(std::time::Instant::now() < deadline, "probe survived");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn output_is_bounded_and_only_named_variables_pass() {
        let temporary = tempfile::tempdir().unwrap();
        let program = script(temporary.path(), "env", "/usr/bin/env");
        let variables = variables(
            |name| std::env::var_os(name),
            ["FIXTURE_CREDENTIAL"],
            |name| (name == "FIXTURE_CREDENTIAL").then(|| "value".into()),
        );
        let (status, stdout) = output(
            &program,
            &[],
            &variables,
            None,
            None,
            64 * 1024,
            std::future::pending(),
        )
        .await
        .unwrap();
        assert!(status.success());
        let text = String::from_utf8(stdout).unwrap();
        assert!(text.contains("FIXTURE_CREDENTIAL=value"), "{text}");
        for line in text.lines() {
            let name = line.split('=').next().unwrap();
            assert!(
                name == "FIXTURE_CREDENTIAL"
                    || PROCESS_VARIABLES.contains(&name)
                    || name == "PWD"
                    || name == "SHLVL"
                    || name == "_"
                    || name == "OLDPWD",
                "unexpected variable {name}"
            );
        }
        let flood = script(temporary.path(), "flood", "exec /usr/bin/yes");
        let error = output(
            &flood,
            &[],
            &Variables::new(),
            None,
            None,
            1024,
            std::future::pending(),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("limit"), "{error:#}");
    }
}
