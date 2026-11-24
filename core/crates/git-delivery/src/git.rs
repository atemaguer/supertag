//! A hardened git child: no user or system configuration, no hooks, no prompts, only the
//! transport the remote uses, bounded output, size, and time, and its whole process group killed
//! when it is cancelled or times out.
use std::{
    fs,
    os::unix::fs::MetadataExt as _,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use supertag_protocol::git_remote::RemoteTransport;
use tokio::{io::AsyncReadExt, process::Command, time};
use tokio_util::sync::CancellationToken;

/// The git program. A fixed path, so a changed `PATH` cannot substitute another.
pub(crate) const GIT: &str = "/usr/bin/git";
const PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

/// A git child's configuration beyond the fixed hardening: environment and `-c` settings.
#[derive(Default)]
pub(crate) struct Settings {
    pub(crate) config: Vec<(String, String)>,
    pub(crate) environment: Vec<(String, String)>,
}

/// A git command in `directory` that may reach a remote over `transport` only.
pub(crate) fn command(
    directory: &Path,
    transport: Option<RemoteTransport>,
    settings: &Settings,
) -> Command {
    let mut command = Command::new(GIT);
    command
        .current_dir(directory)
        .env_clear()
        .env("PATH", PATH)
        .env("HOME", directory)
        .env("LANG", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_LFS_SKIP_SMUDGE", "1")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "gc.auto=0",
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.ext.allow=never",
            "-c",
            "fetch.fsckObjects=true",
            "-c",
            "transfer.fsckObjects=true",
            "-c",
            "http.followRedirects=false",
        ]);
    match transport {
        Some(RemoteTransport::Http) => {
            command.args([
                "-c",
                "protocol.https.allow=always",
                "-c",
                "protocol.http.allow=always",
            ]);
        }
        Some(RemoteTransport::Ssh) => {
            command.args(["-c", "protocol.ssh.allow=always"]);
        }
        Some(RemoteTransport::File) => {
            command.args(["-c", "protocol.file.allow=always"]);
        }
        None => {}
    }
    for (key, value) in &settings.environment {
        command.env(key, value);
    }
    // Settings travel in the environment, never in argv, where process listings show them.
    command.env("GIT_CONFIG_COUNT", settings.config.len().to_string());
    for (index, (key, value)) in settings.config.iter().enumerate() {
        command
            .env(format!("GIT_CONFIG_KEY_{index}"), key)
            .env(format!("GIT_CONFIG_VALUE_{index}"), value);
    }
    command
}

/// What a git child printed and how it ended.
pub(crate) struct Output {
    pub(crate) success: bool,
    pub(crate) code: Option<i32>,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
}

impl Output {
    /// The child's own explanation, safe to show: printable, bounded, without the noise lines.
    pub(crate) fn explanation(&self) -> String {
        let text = String::from_utf8_lossy(&self.stderr);
        let lines: Vec<&str> = text
            .lines()
            .map(str::trim)
            .filter(|line| {
                !line.is_empty() && !line.starts_with("hint:") && !line.starts_with("Warning:")
            })
            .collect();
        let joined = lines.join("; ");
        let cleaned: String = joined
            .chars()
            .filter(|c| !c.is_control())
            .collect::<String>();
        let tail: String = cleaned
            .chars()
            .rev()
            .take(400)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        if tail.is_empty() {
            format!("git exited with {}", self.code.unwrap_or(-1))
        } else {
            tail
        }
    }

    pub(crate) fn require(self, what: &str) -> Result<Vec<u8>> {
        if self.success {
            Ok(self.stdout)
        } else {
            anyhow::bail!("{what} failed: {}", self.explanation())
        }
    }
}

struct ProcessGroup(u32);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}

/// The most bytes a fetch may write to its private directory.
pub(crate) const MAX_STORAGE_BYTES: u64 = 268_435_456;

/// Runs `command` to completion. `directory` is the private state whose size is bounded while it
/// runs; standard output is bounded by `limit`.
pub(crate) async fn run(
    mut command: Command,
    directory: &Path,
    cancel: &CancellationToken,
    limit: usize,
    deadline: Duration,
) -> Result<Output> {
    use std::os::unix::process::CommandExt as _;
    ensure!(!cancel.is_cancelled(), "git delivery stopped");
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);
    let name = operation(&command);
    let mut child = command.spawn().context("start git")?;
    let group = ProcessGroup(child.id().context("git has no process ID")?);
    let mut stdout = child
        .stdout
        .take()
        .context("git output unavailable")?
        .take(limit as u64 + 1);
    let mut stderr = child
        .stderr
        .take()
        .context("git error output unavailable")?;
    let result = {
        let operation = async {
            // Output past its bound fails at once, by name, instead of leaving git blocked on a
            // full pipe until the deadline. Error output is read to its end for the same reason,
            // and only its start is kept.
            let output = async {
                let mut out = Vec::new();
                stdout.read_to_end(&mut out).await?;
                ensure!(
                    out.len() <= limit,
                    "`{name}` printed more than the {limit} bytes SuperTag reads from it"
                );
                Ok(out)
            };
            let errors = async {
                let mut err = Vec::new();
                (&mut stderr).take(16_384).read_to_end(&mut err).await?;
                tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await?;
                Ok::<_, anyhow::Error>(err)
            };
            let (out, err) = tokio::try_join!(output, errors)?;
            let status = child.wait().await?;
            Ok::<_, anyhow::Error>(Output {
                success: status.success(),
                code: status.code(),
                stdout: out,
                stderr: err,
            })
        };
        tokio::pin!(operation);
        let started = time::Instant::now();
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => break Err(anyhow::anyhow!("git delivery stopped")),
                _ = time::sleep_until(started + deadline) => break Err(anyhow::anyhow!("git timed out")),
                result = &mut operation => break result,
                _ = time::sleep(Duration::from_millis(100)) => {
                    if let Err(error) = check_size(directory) { break Err(error); }
                },
            }
        }
    };
    drop(group);
    time::timeout(Duration::from_secs(5), child.wait())
        .await
        .context("git cleanup timed out")??;
    let output = result?;
    check_size(directory)?;
    Ok(output)
}

/// What a child runs, such as `git ls-remote`, skipping global options and their values.
fn operation(command: &Command) -> String {
    let mut arguments = command.as_std().get_args();
    while let Some(argument) = arguments.next() {
        match argument.to_str() {
            Some("-c" | "-C") => {
                arguments.next();
            }
            Some(option) if option.starts_with('-') => {}
            Some(subcommand) => return format!("git {subcommand}"),
            None => break,
        }
    }
    "git".into()
}

fn check_size(directory: &Path) -> Result<()> {
    let mut pending: Vec<PathBuf> = vec![directory.to_owned()];
    let mut size = 0u64;
    let mut entries = 0usize;
    while let Some(directory) = pending.pop() {
        let Ok(listing) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in listing {
            // git creates and removes temporary files while it runs.
            let Ok(entry) = entry else { continue };
            let metadata = match entry.path().symlink_metadata() {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            entries += 1;
            ensure!(
                entries <= 200_000,
                "the repository has too many files to deliver"
            );
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                size = size.saturating_add(metadata.len());
                ensure!(
                    size <= MAX_STORAGE_BYTES,
                    "the repository is larger than the 256 MiB a remote Workspace may be; map a checkout of it on the Worker Host as a local Workspace instead"
                );
            } else {
                ensure!(
                    metadata.file_type().is_symlink() || metadata.nlink() >= 1,
                    "git delivery state contains a special file"
                );
            }
        }
    }
    Ok(())
}

/// A full lowercase commit ID from one line of git output.
pub(crate) fn oid(bytes: &[u8]) -> Result<String> {
    let value = std::str::from_utf8(bytes)?.trim().to_owned();
    ensure!(
        supertag_protocol::valid_git_commit(&value),
        "git printed an invalid object ID"
    );
    Ok(value)
}

/// Creates an empty private bare repository at `path`.
pub(crate) async fn init_bare(path: &Path, cancel: &CancellationToken) -> Result<()> {
    fs::create_dir(path)?;
    let mut init = command(path, None, &Settings::default());
    init.args(["init", "--bare", "--quiet"]);
    run(init, path, cancel, 4096, Duration::from_secs(30))
        .await?
        .require("git init")?;
    Ok(())
}
