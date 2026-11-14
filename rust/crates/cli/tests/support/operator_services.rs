//! A Control Plane as a separate process, and the operator CLI run against it.
#![allow(dead_code)]

use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::timeout,
};
use uuid::Uuid;

pub const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
pub const WAIT: Duration = Duration::from_secs(30);

/// What one CLI run printed.
pub struct Output {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

pub struct OperatorServices {
    pub home: tempfile::TempDir,
    pub gateway_url: String,
    operator_token: String,
    plane: Child,
}

fn command(home: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(BINARY);
    command
        .args(args)
        .env_clear()
        .env("HOME", home)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
}

async fn service(mut command: Command) -> Result<(Child, String)> {
    let mut child = command.stdout(Stdio::piped()).spawn()?;
    let mut output = BufReader::new(child.stdout.take().context("missing service stdout")?);
    let mut ready = String::new();
    timeout(WAIT, output.read_line(&mut ready)).await??;
    let address: SocketAddr = ready
        .trim()
        .parse()
        .context("service did not report its bind address")?;
    ensure!(address.ip().is_loopback() && address.port() != 0);
    Ok((child, format!("http://{address}")))
}

impl OperatorServices {
    pub async fn start(database_url: &str) -> Result<Self> {
        let home = tempfile::tempdir()?;
        let gateway_token =
            supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
        let operator_token = Uuid::new_v4().to_string();
        let mut plane = command(home.path(), &["control-plane"]);
        plane
            .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &gateway_token)
            .env("SUPERTAG_GATEWAY_CREDENTIAL", &gateway_token)
            .env(
                "SUPERTAG_BOOTSTRAP_HOST_TOKEN",
                supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX),
            )
            .env("SUPERTAG_DATABASE_URL", database_url);
        plane.env("SUPERTAG_OPERATOR_TOKEN", &operator_token);
        let (plane, gateway_url) = service(plane).await?;
        Ok(Self {
            home,
            gateway_url,
            operator_token,
            plane,
        })
    }

    pub fn home(&self) -> PathBuf {
        self.home.path().to_owned()
    }

    /// Runs `supertag --control-plane URL ARGS` with the operator token.
    pub async fn run(&self, args: &[&str]) -> Result<Output> {
        let args = [&["--control-plane", self.gateway_url.as_str()][..], args].concat();
        let mut command = command(self.home.path(), &args);
        command.env("SUPERTAG_OPERATOR_TOKEN", &self.operator_token);
        let output = timeout(WAIT, command.output()).await??;
        Ok(Output {
            success: output.status.success(),
            stdout: String::from_utf8(output.stdout)?,
            stderr: String::from_utf8(output.stderr)?,
        })
    }

    /// Runs a command that must succeed and returns its standard output.
    pub async fn ok(&self, args: &[&str]) -> Result<String> {
        let output = self.run(args).await?;
        ensure!(
            output.success,
            "supertag {args:?} failed: {}",
            output.stderr
        );
        Ok(output.stdout)
    }

    /// Runs a command that must fail and returns its standard error.
    pub async fn fails(&self, args: &[&str]) -> Result<String> {
        let output = self.run(args).await?;
        ensure!(
            !output.success,
            "supertag {args:?} unexpectedly succeeded: {}",
            output.stdout
        );
        Ok(output.stderr)
    }

    pub async fn stop(mut self) -> Result<()> {
        self.plane.kill().await?;
        Ok(())
    }
}
