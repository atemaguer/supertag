//! The CLI reaches two separately deployed Gateways, by URL and by saved name, and sees each
//! one's own organization; a credential for one never works on the other, and both are reached
//! again after their services restart at the same addresses.
#[path = "support/children.rs"]
mod children;
use children::reaped;
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[macro_use]
#[path = "support/database.rs"]
mod database;

use std::{
    net::SocketAddr,
    path::Path,
    process::{Output, Stdio},
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use supertag_protocol::{CREDENTIAL_SECRET_PREFIX, new_secret};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::timeout,
};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const WAIT: Duration = Duration::from_secs(30);

fn binary(home: &Path, args: &[&str]) -> Command {
    let mut command = reaped(Command::new(BINARY));
    command
        .args(args)
        .env_clear()
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
}

async fn service(mut command: Command, name: &str) -> Result<(Child, SocketAddr)> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut stdout = BufReader::new(child.stdout.take().context("service stdout missing")?);
    let mut line = String::new();
    let read = timeout(WAIT, stdout.read_line(&mut line))
        .await
        .with_context(|| format!("{name} did not start"))??;
    ensure!(read > 0, "{name} exited before it listened");
    let address: SocketAddr = line.trim().parse().context("missing service address")?;
    tokio::spawn(async move {
        let mut sink = String::new();
        while stdout.read_line(&mut sink).await.is_ok_and(|read| read > 0) {
            sink.clear();
        }
    });
    Ok((child, address))
}

/// One deployment: a Control Plane on its own database and the Gateway in front of it.
struct Stack {
    database: String,
    admin: String,
    gateway_credential: String,
    control_plane: (Child, SocketAddr),
    gateway: (Child, SocketAddr),
}

impl Stack {
    async fn start(home: &Path, database: String) -> Result<Self> {
        let admin = Uuid::new_v4().to_string();
        let gateway_credential = new_secret(CREDENTIAL_SECRET_PREFIX);
        let control_plane =
            start_control_plane(home, &database, &admin, &gateway_credential, None).await?;
        let gateway = start_gateway(home, control_plane.1, &gateway_credential, None).await?;
        Ok(Self {
            database,
            admin,
            gateway_credential,
            control_plane,
            gateway,
        })
    }

    fn url(&self) -> String {
        format!("http://{}", self.gateway.1)
    }

    /// Stops both services and starts them again on the same database and addresses.
    async fn restart(&mut self, home: &Path) -> Result<()> {
        for child in [&mut self.gateway.0, &mut self.control_plane.0] {
            child.start_kill()?;
            child.wait().await?;
        }
        self.control_plane = start_control_plane(
            home,
            &self.database,
            &self.admin,
            &self.gateway_credential,
            Some(self.control_plane.1),
        )
        .await?;
        self.gateway = start_gateway(
            home,
            self.control_plane.1,
            &self.gateway_credential,
            Some(self.gateway.1),
        )
        .await?;
        Ok(())
    }
}

/// Starts a service, retrying briefly while a just-stopped one releases its address.
async fn start_again(
    command: impl Fn() -> Command,
    name: &str,
    address: Option<SocketAddr>,
) -> Result<(Child, SocketAddr)> {
    let mut last = None;
    for _ in 0..if address.is_some() { 20 } else { 1 } {
        match service(command(), name).await {
            Ok(started) => return Ok(started),
            Err(error) => last = Some(error),
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err(last.expect("one attempt"))
}

async fn start_control_plane(
    home: &Path,
    database: &str,
    admin: &str,
    gateway_credential: &str,
    address: Option<SocketAddr>,
) -> Result<(Child, SocketAddr)> {
    let listen = address.map_or("127.0.0.1:0".to_owned(), |address| address.to_string());
    start_again(
        || {
            let mut command = binary(home, &["control-plane", "--listen", &listen]);
            command
                .env("SUPERTAG_DATABASE_URL", database)
                .env("SUPERTAG_OPERATOR_TOKEN", admin)
                .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", gateway_credential);
            command
        },
        "Control Plane",
        address,
    )
    .await
}

async fn start_gateway(
    home: &Path,
    control_plane: SocketAddr,
    credential: &str,
    address: Option<SocketAddr>,
) -> Result<(Child, SocketAddr)> {
    let listen = address.map_or("127.0.0.1:0".to_owned(), |address| address.to_string());
    let upstream = format!("http://{control_plane}");
    start_again(
        || {
            let mut command = binary(
                home,
                &["gateway", "--control-plane", &upstream, "--listen", &listen],
            );
            command.env("SUPERTAG_GATEWAY_CREDENTIAL", credential);
            command
        },
        "Gateway",
        address,
    )
    .await
}

/// Runs an operator command with `token` in the environment, when given.
async fn cli(home: &Path, args: &[&str], environment: &[(&str, &str)]) -> Result<Output> {
    let mut command = binary(home, args);
    command.envs(environment.iter().copied());
    Ok(timeout(WAIT, command.output())
        .await
        .context("SuperTag command did not exit")??)
}

async fn json(home: &Path, args: &[&str], environment: &[(&str, &str)]) -> Result<Value> {
    let output = cli(home, args, environment).await?;
    ensure!(
        output.status.success(),
        "{args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}

async fn refused(home: &Path, args: &[&str], environment: &[(&str, &str)]) -> Result<String> {
    let output = cli(home, args, environment).await?;
    ensure!(!output.status.success(), "{args:?} unexpectedly succeeded");
    Ok(String::from_utf8_lossy(&output.stderr).into_owned())
}

database_tests! {
    #[tokio::test]
    the_cli_reaches_two_gateways_by_url_and_name_without_crossing_them;
}

async fn the_cli_reaches_two_gateways_by_url_and_name_without_crossing_them(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let home = directory.path().join("home");
    std::fs::create_dir_all(&home)?;
    let mut alpha = Stack::start(&home, database).await?;
    let mut beta = Stack::start(
        &home,
        format!(
            "sqlite://{}?mode=rwc",
            directory.path().join("beta.sqlite").display()
        ),
    )
    .await?;
    let (alpha_url, beta_url) = (alpha.url(), beta.url());

    // By URL, each Gateway takes its own operator token and sets up its own Tag.
    for (url, token, tag) in [
        (&alpha_url, &alpha.admin, "alpha-tag"),
        (&beta_url, &beta.admin, "beta-tag"),
    ] {
        let put = json(
            &home,
            &[
                "tag",
                "put",
                tag,
                "--instructions",
                "Help",
                "--gateway",
                url,
            ],
            &[("SUPERTAG_OPERATOR_TOKEN", token)],
        )
        .await?;
        assert_eq!(put["tag_id"], tag);
    }
    // One Gateway's token is refused by the other.
    let stderr = refused(
        &home,
        &["get", "tag", "beta-tag", "--gateway", &beta_url],
        &[("SUPERTAG_OPERATOR_TOKEN", &alpha.admin)],
    )
    .await?;
    assert!(!stderr.contains(&alpha.admin), "{stderr}");

    // Saved under names, each is reached by name and sees only its own Tag.
    for (name, url, token) in [
        ("alpha", &alpha_url, &alpha.admin),
        ("beta", &beta_url, &beta.admin),
    ] {
        json(
            &home,
            &["connect", url, "--name", name],
            &[("SUPERTAG_OPERATOR_TOKEN", token)],
        )
        .await?;
    }
    let sees = |name: &'static str, tag: &'static str, other: &'static str| {
        let home = home.clone();
        async move {
            let found = json(&home, &["get", "tag", tag, "--gateway", name], &[]).await?;
            ensure!(found["tag_id"] == tag, "{name}: {found}");
            refused(&home, &["get", "tag", other, "--gateway", name], &[]).await?;
            // The same Gateway, chosen before the command or by environment.
            let before = json(&home, &["--gateway", name, "get", "tag", tag], &[]).await?;
            ensure!(before["tag_id"] == tag, "{name}: {before}");
            let by_environment = json(
                &home,
                &["get", "tag", tag],
                &[("SUPERTAG_GATEWAY_URL", name)],
            )
            .await?;
            ensure!(by_environment["tag_id"] == tag, "{name}: {by_environment}");
            anyhow::Ok(())
        }
    };
    sees("alpha", "alpha-tag", "beta-tag").await?;
    sees("beta", "beta-tag", "alpha-tag").await?;

    // Both deployments restart in place; the saved names reach them again.
    alpha.restart(&home).await?;
    beta.restart(&home).await?;
    assert_eq!(alpha.url(), alpha_url);
    assert_eq!(beta.url(), beta_url);
    sees("alpha", "alpha-tag", "beta-tag").await?;
    sees("beta", "beta-tag", "alpha-tag").await?;
    Ok(())
}
