//! Bounded harness probes. Each probe runs with an explicit environment in its own process group;
//! when its stop condition fires or it fails, the whole group is killed with SIGKILL and reaped.
//! Probe stdout is read with fixed limits, and stderr is never read: native CLIs can print
//! credentials there.
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
static INTERRUPTED: OnceLock<watch::Sender<bool>> = OnceLock::new();

/// The stop condition of a probe in an interactive command (`sign-in`, `init`): a deadline, or
/// Ctrl-C. Ctrl-C while a probe runs stops the probe so that its process group is killed and its
/// temporary directory removed, and `exit_if_interrupted` then ends the command; Ctrl-C at any
/// other time ends the command at once, as without a handler. Never used by the supervisor, which
/// handles its own interrupts.
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
            let (sender, _) = watch::channel(false);
            let watcher = sender.clone();
            tokio::spawn(async move {
                while tokio::signal::ctrl_c().await.is_ok() {
                    if ACTIVE.load(Ordering::SeqCst) == 0 {
                        std::process::exit(130);
                    }
                    watcher.send_replace(true);
                }
            });
            sender
        })
        .subscribe();
    tokio::select! {
        () = tokio::time::sleep(timeout) => {}
        _ = interrupted.wait_for(|interrupted| *interrupted) => {}
    }
}

/// End the command if Ctrl-C stopped a probe. Call once the probe's cleanup has run.
pub fn exit_if_interrupted() {
    if INTERRUPTED
        .get()
        .is_some_and(|interrupted| *interrupted.borrow())
    {
        std::process::exit(130);
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

    /// The rest of the output, at most `limit` bytes.
    pub async fn rest(&mut self, limit: usize) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        (&mut self.stdout)
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .await
            .context("could not read probe output")?;
        ensure!(bytes.len() <= limit, "probe output exceeds its limit");
        Ok(bytes)
    }

    pub async fn write(&mut self, bytes: &[u8]) -> Result<()> {
        let stdin = self.stdin.as_mut().context("probe input is closed")?;
        stdin
            .write_all(bytes)
            .await
            .context("could not write probe input")?;
        stdin.flush().await.context("could not write probe input")
    }

    pub async fn send(&mut self, value: &Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(value)?;
        bytes.push(b'\n');
        self.write(&bytes).await
    }

    pub fn close_input(&mut self) {
        self.stdin = None;
    }

    pub async fn wait(&mut self) -> Result<ExitStatus> {
        self.close_input();
        self.child
            .wait()
            .await
            .context("could not wait for the probe")
    }

    /// Kill the probe's process group unless its leader was already reaped, then reap it.
    pub async fn finish(mut self) {
        self.stdin = None;
        if matches!(self.child.try_wait(), Ok(None)) {
            // SAFETY: the group leader is our unreaped child, so its group ID still names its group.
            unsafe { libc::kill(-self.pid, libc::SIGKILL) };
            let _ = self.child.wait().await;
        }
    }
}

impl Drop for Probe {
    /// A dropped probe, such as one whose caller was cancelled, takes its process group with it.
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            // SAFETY: the group leader is our unreaped child, so its group ID still names its group.
            unsafe { libc::kill(-self.pid, libc::SIGKILL) };
        }
    }
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

/// The process variables from this process plus the named credential variables from `lookup`.
pub fn variables<'a>(
    credentials: impl IntoIterator<Item = &'a str>,
    lookup: impl Fn(&str) -> Option<OsString>,
) -> Variables {
    let mut variables = Variables::new();
    for name in PROCESS_VARIABLES {
        if let Some(value) = std::env::var_os(name) {
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
        let variables = variables(["FIXTURE_CREDENTIAL"], |name| {
            (name == "FIXTURE_CREDENTIAL").then(|| "value".into())
        });
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
