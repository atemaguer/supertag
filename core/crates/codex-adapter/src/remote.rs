//! Codex on a remote Workspace: the app-server stays here with its keys, and every command and
//! file operation runs in the Attempt's sandbox through Codex's exec-server there.
//!
//! The Worker Host serves the exec-server on a private socket. Codex reaches it as its only
//! environment, through `supertag __codex-exec-bridge`, and never runs anything on this host.
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    time::{Duration, timeout},
};

/// The one environment Codex may use.
const ENVIRONMENT: &str = "sandbox";
/// A Codex exec-server's longest `initialize` answer worth reading.
const MAX_ANSWER: u64 = 64 * 1024;

/// The executor socket the Worker Host passed, if the Attempt runs on a remote Workspace.
pub(crate) fn socket(
    environment: &std::collections::BTreeMap<std::ffi::OsString, std::ffi::OsString>,
) -> Result<Option<PathBuf>> {
    let Some(path) = environment.get(std::ffi::OsStr::new(supertag_protocol::CODEX_EXEC_SOCKET))
    else {
        return Ok(None);
    };
    let path = PathBuf::from(path);
    ensure!(path.is_absolute(), "Codex executor socket must be absolute");
    Ok(Some(path))
}

/// The sandbox checkout, as the exec-server reports its working directory. Waits, within
/// `limit`, for the Worker Host to stage the sandbox.
pub(crate) async fn checkout(socket: &Path, limit: Duration) -> Result<PathBuf> {
    timeout(limit, async {
        let stream = UnixStream::connect(socket)
            .await
            .context("connect to the remote Workspace's Codex executor")?;
        let (reader, mut writer) = stream.into_split();
        let request = json!({
            "id": 1,
            "method": "initialize",
            "params": {"clientName": "supertag-checkout"},
        });
        writer.write_all(format!("{request}\n").as_bytes()).await?;
        let mut line = String::new();
        tokio::io::AsyncReadExt::take(BufReader::new(reader), MAX_ANSWER)
            .read_line(&mut line)
            .await?;
        let answer: Value = serde_json::from_str(&line)
            .context("the remote Workspace's Codex executor did not answer")?;
        let cwd = answer["result"]["environmentInfo"]["cwd"]
            .as_str()
            .and_then(|uri| uri.strip_prefix("file://"))
            .context("the remote Workspace's Codex executor reported no checkout")?;
        checkout_path(cwd)
    })
    .await
    .context("the remote Workspace was not ready in time")?
}

fn checkout_path(path: &str) -> Result<PathBuf> {
    let checkout = PathBuf::from(path);
    ensure!(
        checkout.is_absolute()
            && path.len() <= 4096
            && !path.chars().any(char::is_control)
            && !checkout
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
            && checkout.to_str().is_some(),
        "the remote Workspace's checkout path is invalid"
    );
    Ok(checkout)
}

/// `CODEX_HOME/environments.toml`: the sandbox is Codex's only environment, reached through the
/// bridge with fixed arguments, and this host is not one.
pub(crate) fn write_environments(home: &Path, bridge: &Path, socket: &Path) -> Result<()> {
    let text = |path: &Path| -> Result<String> {
        Ok(serde_json::to_string(
            path.to_str()
                .context("Codex executor paths must be UTF-8")?,
        )?)
    };
    let contents = format!(
        "default = \"{ENVIRONMENT}\"\ninclude_local = false\n\n[[environments]]\nid = \"{ENVIRONMENT}\"\nprogram = {}\nargs = [\"__codex-exec-bridge\", \"--socket\", {}]\n",
        text(bridge)?,
        text(socket)?,
    );
    std::fs::write(home.join("environments.toml"), contents)
        .context("could not configure Codex's remote environment")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sandbox_is_the_only_environment_reached_through_the_bridge() -> Result<()> {
        let home = tempfile::tempdir()?;
        write_environments(
            home.path(),
            Path::new("/opt/supertag/bin/supertag"),
            Path::new("/tmp/supertag-codex-x/exec.sock"),
        )?;
        let written = std::fs::read_to_string(home.path().join("environments.toml"))?;
        assert_eq!(
            written,
            "default = \"sandbox\"\ninclude_local = false\n\n[[environments]]\nid = \"sandbox\"\nprogram = \"/opt/supertag/bin/supertag\"\nargs = [\"__codex-exec-bridge\", \"--socket\", \"/tmp/supertag-codex-x/exec.sock\"]\n"
        );
        Ok(())
    }

    #[test]
    fn a_checkout_path_must_be_absolute_and_plain() {
        assert!(checkout_path("/tmp/supertag-workspace-1/checkout").is_ok());
        for bad in ["checkout", "/tmp/../etc", "/tmp/a\nb"] {
            assert!(checkout_path(bad).is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn reads_the_checkout_from_the_executor() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("exec.sock");
        let listener = tokio::net::UnixListener::bind(&path)?;
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (reader, mut writer) = stream.into_split();
            let mut line = String::new();
            BufReader::new(reader).read_line(&mut line).await.unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["method"], "initialize");
            writer
                .write_all(
                    b"{\"id\":1,\"result\":{\"environmentInfo\":{\"cwd\":\"file:///tmp/supertag-workspace-1/checkout\"}}}\n",
                )
                .await
                .unwrap();
        });
        assert_eq!(
            checkout(&path, Duration::from_secs(5)).await?,
            PathBuf::from("/tmp/supertag-workspace-1/checkout")
        );
        Ok(())
    }
}
