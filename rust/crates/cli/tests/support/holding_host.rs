//! A Worker Host kept running so the Control Plane can relay the artifacts and Workspace
//! deliveries it holds. The Control Plane stores none of those bytes, so a test that reads them
//! after a `--once` Worker Host exits starts one of these on the same artifact directory.
#![allow(dead_code)]

use std::{path::Path, process::Stdio, time::Duration};

use anyhow::{Context, Result, bail};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
};

/// The artifact directory every Worker Host process of a test shares. They all present the same
/// host credential, so, like the lanes of one supervised Host, they share one storage.
pub fn artifact_directory(root: &Path) -> std::path::PathBuf {
    root.join("host-artifacts")
}

/// Starts `command`, a Worker Host without `--once`, and returns once it reports ready, by which
/// time its relay stream is open.
pub async fn serve(mut command: Command) -> Result<Child> {
    command.stdout(Stdio::piped()).kill_on_drop(true);
    let mut child = command.spawn().context("start the holding Worker Host")?;
    let mut lines = BufReader::new(child.stdout.take().context("holding host stdout")?).lines();
    let ready = tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(line) = lines.next_line().await? {
            if line.trim() == "ready" {
                return Ok::<_, anyhow::Error>(true);
            }
        }
        Ok(false)
    })
    .await
    .context("holding Worker Host did not become ready")??;
    if !ready {
        bail!("holding Worker Host exited before it was ready");
    }
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
    Ok(child)
}
