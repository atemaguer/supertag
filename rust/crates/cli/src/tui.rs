use std::{
    io::IsTerminal,
    os::{fd::AsRawFd, unix::net::UnixStream},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde_json::json;
use tokio::{io::AsyncWriteExt, process::Command, time::timeout};

use crate::{Connection, network, operator_target};

const VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn default_connection() -> Result<Connection> {
    ensure!(
        std::io::stdin().is_terminal() && std::io::stdout().is_terminal(),
        "run supertag in a terminal or select a command with --help"
    );
    if let Ok(gateway) = std::env::var("SUPERTAG_GATEWAY_URL") {
        return Ok(Connection {
            gateway: Some(gateway),
            state_directory: None,
        });
    }
    let directory = std::env::var_os("SUPERTAG_STATE_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".supertag")))
        .context("set SUPERTAG_STATE_DIR to the running local service directory")?;
    Ok(Connection {
        gateway: None,
        state_directory: Some(directory),
    })
}

pub async fn launch(
    connection: Connection,
    binary: Option<PathBuf>,
    workspace: Option<String>,
) -> Result<()> {
    let (url, token) = operator_target(connection)?;
    let endpoint = network::endpoint(url.clone(), false).await?;
    let tls = endpoint.uri().scheme_str() == Some("https");
    let certificate = |name| {
        if tls {
            certificate_path(name)
        } else {
            Ok(None)
        }
    };
    let binary = match binary.or_else(|| std::env::var_os("SUPERTAG_TUI_BINARY").map(PathBuf::from))
    {
        Some(binary) => binary,
        None => std::env::current_exe()?
            .canonicalize()
            .context("resolve installed SuperTag executable")?
            .with_file_name("supertag-tui"),
    };
    check_version(&binary).await?;

    let payload = serde_json::to_vec(&json!({
        "protocol": "runtime.v2",
        "current": 0,
        "contexts": [{
            "url": url, "token": token, "workspace": workspace,
            "server_ca_file": certificate("SUPERTAG_SERVER_CA_FILE")?,
            "client_cert_file": certificate("SUPERTAG_CLIENT_CERT_FILE")?,
            "client_key_file": certificate("SUPERTAG_CLIENT_KEY_FILE")?,
        }],
    }))?;
    ensure!(payload.len() < 1 << 20, "terminal UI handover is too large");

    let (parent, child) = UnixStream::pair().context("create terminal UI handover")?;
    parent.set_nonblocking(true)?;
    let mut parent = tokio::net::UnixStream::from_std(parent)?;
    let mut command = terminal_command(&binary);
    command
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    // SAFETY: the child keeps its socket until exec. The callback performs only
    // async-signal-safe descriptor operations and clears CLOEXEC when already fd 3.
    unsafe {
        command.pre_exec(move || {
            let fd = child.as_raw_fd();
            let result = if fd == 3 {
                libc::fcntl(3, libc::F_SETFD, 0)
            } else {
                libc::dup2(fd, 3)
            };
            if result < 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    let mut process = command.spawn().context("start supertag-tui")?;
    drop(command);
    timeout(Duration::from_secs(5), async {
        parent.write_all(&payload).await?;
        parent.shutdown().await
    })
    .await
    .context("terminal UI handover timed out")?
    .context("send terminal UI handover")?;
    drop(parent);
    let status = process.wait().await.context("wait for supertag-tui")?;
    ensure!(status.success(), "supertag-tui exited with {status}");
    Ok(())
}

fn certificate_path(name: &str) -> Result<Option<PathBuf>> {
    std::env::var_os(name)
        .map(|path| std::fs::canonicalize(path).with_context(|| format!("resolve {name}")))
        .transpose()
}

async fn check_version(binary: &Path) -> Result<()> {
    let output = timeout(
        Duration::from_secs(5),
        terminal_command(binary)
            .arg("--version")
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .context("terminal UI version check timed out")?
    .context("run supertag-tui --version")?;
    let version = std::str::from_utf8(&output.stdout)
        .context("invalid terminal UI version")?
        .trim();
    ensure!(
        output.status.success() && version == VERSION,
        "supertag-tui must match SuperTag {VERSION}"
    );
    Ok(())
}

fn terminal_command(binary: &Path) -> Command {
    let mut command = Command::new(binary);
    command
        .env_clear()
        .envs(
            [
                "PATH",
                "HOME",
                "USER",
                "LOGNAME",
                "SHELL",
                "TERM",
                "TERM_PROGRAM",
                "COLORTERM",
                "LANG",
                "LC_ALL",
                "LC_CTYPE",
                "NO_COLOR",
                "CLICOLOR",
                "CLICOLOR_FORCE",
                "XDG_CONFIG_HOME",
                "XDG_RUNTIME_DIR",
                "TMPDIR",
            ]
            .into_iter()
            .filter_map(|name| std::env::var_os(name).map(|value| (name, value))),
        )
        .kill_on_drop(true);
    command
}
