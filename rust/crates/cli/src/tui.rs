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

use crate::{Connection, ROOT_GATEWAY, resolve_target};

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn default_connection() -> Result<Connection> {
    ensure!(
        // terminal-safe: only checks whether output is a terminal.
        std::io::stdin().is_terminal() && std::io::stdout().is_terminal(),
        "run supertag in a terminal or select a command with --help"
    );
    if let Ok(gateway) = std::env::var("SUPERTAG_GATEWAY_URL") {
        return Ok(Connection {
            gateway: Some(gateway),
            state_directory: None,
        });
    }
    let state_directory = crate::local_config::state_directory(None).ok();
    Ok(Connection {
        gateway: None,
        state_directory,
    })
}

pub async fn launch(
    connection: Connection,
    binary: Option<PathBuf>,
    workspace: Option<String>,
) -> Result<()> {
    let implicit = connection.gateway.is_none()
        && ROOT_GATEWAY.get().is_none()
        && connection.state_directory.is_none();
    let connection = if implicit {
        default_connection()?
    } else {
        connection
    };
    let allow_saved_only = implicit
        && connection.gateway.is_none()
        && std::env::var_os("SUPERTAG_STATE_DIR").is_none()
        && workspace.is_none();
    let target = match resolve_target(connection) {
        Ok(target) => Some(target),
        Err(_) if allow_saved_only => None,
        Err(error) => return Err(error),
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

    let Some(target) = target else {
        let status = terminal_command(&binary)
            .status()
            .await
            .context("run supertag-tui")?;
        ensure!(status.success(), "supertag-tui exited with {status}");
        return Ok(());
    };
    let endpoint = target.endpoint(Duration::from_secs(15)).await?;
    // The terminal UI dials native gRPC itself.
    ensure!(
        !endpoint.tunnelled(),
        "the terminal UI connects only to https:// or loopback http:// Gateway URLs"
    );
    let tls = endpoint.url().starts_with("https:");
    let saved = target.tls.clone();
    let certificate = |name: &str| {
        if !tls {
            return Ok(None);
        }
        match &saved {
            Some(files) => match name {
                "SUPERTAG_SERVER_CA_FILE" => files.server_ca.as_ref(),
                "SUPERTAG_CLIENT_CERT_FILE" => files.client_cert.as_ref(),
                _ => files.client_key.as_ref(),
            }
            .map(|path| {
                std::fs::canonicalize(path).with_context(|| format!("resolve {}", path.display()))
            })
            .transpose(),
            None => certificate_path(name),
        }
    };
    let (url, token) = (target.url, target.token);
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
        .env("SUPERTAG_TUI_HANDOVER", "3")
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
