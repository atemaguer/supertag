//! `supertag tui` and plain `supertag`: start the terminal UI, `supertag-tui`, installed beside
//! this executable.
//!
//! The terminal UI resolves its own connection, so nothing secret passes from the CLI to it: it
//! reads the same sources the CLI does (`--gateway URL|NAME`, the saved Gateways in
//! `<config>/supertag/gateways.json` and the desktop app's store, `SUPERTAG_GATEWAY_URL` and
//! `SUPERTAG_OPERATOR_TOKEN`, the TLS file variables), and finds the local Gateway by running
//! `$SUPERTAG_CLI __local-gateway`. The CLI checks that the terminal UI is from the same release,
//! then replaces itself with it, so the terminal, signals and exit status are the UI's own.
//!
//! The contract `supertag-tui` keeps (the release smoke, `scripts/smoke_native_archive.py`,
//! checks it on every platform):
//!
//! - `supertag-tui --version` prints exactly this CLI's version, such as `0.3.2`, without
//!   loading its UI libraries. The launcher waits up to 60 seconds, because macOS scans a newly
//!   installed binary on its first run.
//! - `supertag-tui --headless-check` loads its embedded native UI library (OpenTUI), prints `ok`
//!   and exits 0, without a terminal.
//! - `supertag-tui [--gateway URL|NAME] [--state-directory ABSOLUTE_DIR]` is the interactive UI.
//!   These two options are the only arguments the launcher passes. Without either it opens the
//!   Gateway it used last, else the local Gateway, else the saved ones. Outside a terminal it
//!   exits 2 with a message on standard error. In a terminal it draws on the alternate screen
//!   and, on Ctrl-C, restores the terminal and exits 0.
//! - Environment: everything the launcher inherited, unchanged (TERM, TMUX, XDG directories,
//!   SUPERTAG_STATE_DIR, SUPERTAG_TUI_NOTIFY, ...), plus `SUPERTAG_CLI`, the canonical path of
//!   the launching `supertag`. Nothing is passed on another descriptor.
use std::{
    io::{IsTerminal, Read},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail, ensure};

const VERSION: &str = env!("CARGO_PKG_VERSION");
/// macOS scans a newly installed binary on its first run, which can take many seconds.
const VERSION_TIMEOUT: Duration = Duration::from_secs(60);

/// What `supertag tui` and plain `supertag` pass to the terminal UI.
pub struct Launch {
    pub gateway: Option<String>,
    pub state_directory: Option<PathBuf>,
    pub binary: Option<PathBuf>,
}

/// The terminal UI to run: `--binary`, else SUPERTAG_TUI_BINARY, else `supertag-tui` in the
/// directory of this executable after resolving links, so an installed command link finds the
/// release it belongs to.
fn binary(explicit: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(binary) =
        explicit.or_else(|| std::env::var_os("SUPERTAG_TUI_BINARY").map(PathBuf::from))
    {
        return Ok(binary);
    }
    Ok(this_executable()?.with_file_name("supertag-tui"))
}

fn this_executable() -> Result<PathBuf> {
    std::env::current_exe()?
        .canonicalize()
        .context("resolve installed SuperTag executable")
}

/// Plain `supertag`, or `supertag --gateway G` with no command: the terminal UI in a terminal,
/// otherwise the help. Returns the help's exit status when it printed the help.
pub fn bare(gateway: Option<String>, help: impl FnOnce()) -> Result<std::process::ExitCode> {
    let binary = binary(None)?;
    if !binary.is_file() {
        ensure!(
            gateway.is_none(),
            "the terminal UI is not installed: {} is missing. Reinstall SuperTag, or run supertag --help for the commands",
            binary.display()
        );
        help();
        outln!(
            "\nThe terminal UI isn't installed ({} is missing); reinstall SuperTag to get it.",
            binary.display()
        );
        return Ok(std::process::ExitCode::from(2));
    }
    // terminal-safe: only checks whether input and output are terminals.
    if gateway.is_none() && !(std::io::stdin().is_terminal() && std::io::stdout().is_terminal()) {
        help();
        return Ok(std::process::ExitCode::from(2));
    }
    launch(Launch {
        gateway,
        state_directory: None,
        binary: Some(binary),
    })
}

/// Checks the terminal UI's version and replaces this process with it. Returns only on failure.
pub fn launch(launch: Launch) -> Result<std::process::ExitCode> {
    let binary = binary(launch.binary)?;
    check_version(&binary)?;
    let mut command = Command::new(&binary);
    if let Some(gateway) = launch.gateway {
        command.arg("--gateway").arg(gateway);
    }
    if let Some(directory) = launch.state_directory {
        let directory = std::path::absolute(&directory)
            .with_context(|| format!("resolve {}", directory.display()))?;
        command.arg("--state-directory").arg(directory);
    }
    // The terminal UI runs `$SUPERTAG_CLI __local-gateway` to find the local Gateway, so it asks
    // this exact build, not whichever supertag is first on PATH.
    command.env("SUPERTAG_CLI", this_executable()?);
    let error = command.exec();
    bail!("start {}: {error}", binary.display())
}

fn check_version(binary: &Path) -> Result<()> {
    ensure!(
        binary.is_file(),
        "the terminal UI is not installed: {} is missing. Reinstall SuperTag, or run supertag --help for the commands",
        binary.display()
    );
    let mut child = Command::new(binary)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("run {} --version", binary.display()))?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() > VERSION_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            bail!(
                "{} --version did not answer within {} seconds",
                binary.display(),
                VERSION_TIMEOUT.as_secs()
            );
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let mut output = String::new();
    child
        .stdout
        .take()
        .context("read the terminal UI version")?
        .take(4096)
        .read_to_string(&mut output)
        .context("invalid terminal UI version")?;
    ensure!(
        status.success() && output.trim() == VERSION,
        "{} must be the terminal UI from SuperTag {VERSION}; reinstall SuperTag",
        binary.display()
    );
    Ok(())
}
