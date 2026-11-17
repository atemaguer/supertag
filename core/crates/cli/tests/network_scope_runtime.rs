//! Separate Control Plane and Worker Host processes run a Codex Task whose Permission Sets limit
//! web:fetch to an origin with a host credential: the Worker Host starts the Attempt's egress
//! proxy, hands Codex its URL, CA, and a placeholder but never the secret, and the proxy's log of
//! a refused connection reaches `describe task`.
#[path = "support/children.rs"]
mod children;
use children::reaped;
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[macro_use]
#[path = "support/database.rs"]
mod database;

use std::{
    net::SocketAddr, os::unix::fs::PermissionsExt, path::Path, process::Stdio, time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::timeout,
};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const WAIT: Duration = Duration::from_secs(60);

struct Credentials {
    gateway: String,
    operator: String,
    host: String,
}

impl Credentials {
    fn new() -> Self {
        Self {
            gateway: supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX),
            operator: Uuid::new_v4().to_string(),
            host: supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX),
        }
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut command = reaped(Command::new(BINARY));
        command
            .args(args)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &self.gateway)
            .env("SUPERTAG_GATEWAY_CREDENTIAL", &self.gateway)
            .env("SUPERTAG_OPERATOR_TOKEN", &self.operator)
            .env("SUPERTAG_HOST_TOKEN", &self.host)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &self.host)
            .stdin(Stdio::null())
            .kill_on_drop(true);
        command
    }
    fn operator(&self, args: &[&str], public: &str) -> Command {
        let mut command = self.command(args);
        command.args(["--gateway", public]);
        command
    }
}

async fn service(mut command: Command) -> Result<(Child, String)> {
    let mut child = command.stdout(Stdio::piped()).spawn()?;
    let mut stdout = BufReader::new(child.stdout.take().context("service stdout missing")?);
    let mut line = String::new();
    timeout(WAIT, stdout.read_line(&mut line))
        .await
        .context("service startup timed out")??;
    let address: SocketAddr = line.trim().parse().context("service endpoint missing")?;
    ensure!(address.ip().is_loopback() && address.port() != 0);
    Ok((child, format!("http://{address}")))
}

async fn output(mut command: Command) -> Result<std::process::Output> {
    Ok(timeout(WAIT, command.output())
        .await
        .context("CLI command timed out")??)
}

async fn success(command: Command) -> Result<std::process::Output> {
    let output = output(command).await?;
    ensure!(
        output.status.success(),
        "CLI failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(output)
}

async fn json_output(command: Command) -> Result<Value> {
    Ok(serde_json::from_slice(&success(command).await?.stdout)?)
}

async fn git(source: &Path, arguments: &[&str]) -> Result<String> {
    let mut command = Command::new("/usr/bin/git");
    command
        .arg("-C")
        .arg(source)
        .args(arguments)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid");
    Ok(String::from_utf8(success(command).await?.stdout)?
        .trim()
        .into())
}

fn private(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

async fn exercise(database: &str, directory: &Path) -> Result<()> {
    const SECRET: &str = "ghp_runtime_secret_value";
    let directory = directory.canonicalize()?;
    let repository = directory.join("repository");
    std::fs::create_dir(&repository)?;
    git(&repository, &["init", "--quiet"]).await?;
    std::fs::write(repository.join("README.md"), "repository\n")?;
    git(&repository, &["add", "README.md"]).await?;
    git(&repository, &["commit", "--quiet", "-m", "Initial"]).await?;
    let base = git(&repository, &["rev-parse", "HEAD"]).await?;
    let state = directory.join("host-state");
    private(&state)?;
    let home = directory.join("home");
    private(&home.join(".codex"))?;
    let auth = home.join(".codex/auth.json");
    std::fs::write(
        &auth,
        r#"{"tokens":{"access_token":"fixture-network","refresh_token":"fixture-network"}}"#,
    )?;
    std::fs::set_permissions(&auth, std::fs::Permissions::from_mode(0o600))?;
    let record = directory.join("codex-record.json");
    let fake = directory.join("codex-fixture");
    std::fs::write(
        &fake,
        include_str!("fixtures/network_scope_app_server.py")
            .replace("@RECORD@", record.to_str().context("path is not UTF-8")?),
    )?;
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700))?;
    let manifest = directory.join("fetcher.yaml");
    std::fs::write(
        &manifest,
        format!(
            r#"apiVersion: supertag/v1
kind: PermissionSet
metadata: {{ name: fetch }}
spec:
  permissions:
    - {{ target: runtime, action: files:write }}
    - {{ target: runtime, action: commands:execute }}
    - target: runtime
      action: web:fetch
      hosts: ["https://API.github.com/"]
      methods: [get]
      credential: github
---
apiVersion: supertag/v1
kind: Role
metadata: {{ name: fetcher }}
spec:
  purpose: Read the GitHub API.
  permissionSets: [fetch]
  execution: {{ harness: codex }}
---
apiVersion: supertag/v1
kind: Tag
metadata: {{ name: fetcher }}
spec:
  roles: [fetcher]
  workspace: {{ id: project, baseCommit: {base} }}
"#
        ),
    )?;

    let credentials = Credentials::new();
    let mut plane = credentials.command(&["control-plane"]);
    plane.env("SUPERTAG_DATABASE_URL", database);
    plane
        .arg("--checkpoint-directory")
        .arg(directory.join("transfers"));
    let (mut plane, public) = service(plane).await?;
    let manifest = manifest.to_str().context("path is not UTF-8")?;
    success(credentials.operator(&["apply", "-f", manifest], &public)).await?;
    let set =
        json_output(credentials.operator(&["get", "permission-set", "fetch"], &public)).await?;
    let fetch = set["permissions"]
        .as_array()
        .context("missing permissions")?
        .iter()
        .find(|permission| permission["action"] == "web:fetch")
        .context("missing web:fetch")?;
    assert_eq!(fetch["hosts"], json!(["https://api.github.com"]), "{set}");
    assert_eq!(fetch["methods"], json!(["GET"]), "{set}");

    let task = json_output(credentials.operator(
        &[
            "task",
            "submit",
            "--tag",
            "fetcher",
            "--session",
            "s",
            "Read the API",
        ],
        &public,
    ))
    .await?;
    let task_id = task["task_id"].as_str().context("missing Task ID")?;
    assert_eq!(
        task["network_scope"]["summary"], "Reaches https://api.github.com (GET; credential github)",
        "{task}"
    );

    let worker = |credential: bool| {
        let mut command = credentials.command(&[
            "worker-host",
            "--control-plane",
            &public,
            "--harness",
            "codex",
            "--codex-model",
            "fixture-model",
            "--once",
        ]);
        command
            .arg("--codex-path")
            .arg(&fake)
            .arg("--state-directory")
            .arg(&state)
            .args(["--workspace-id", "project", "--workspace-source"])
            .arg(&repository)
            .env("HOME", &home);
        if credential {
            command
                .args(["--network-credential", "github=GITHUB_TOKEN"])
                .env("SUPERTAG_NETWORK_CREDENTIAL_GITHUB", SECRET);
        }
        command
    };
    // A host without the credential reports none and does not take the Task.
    success(worker(false)).await?;
    let waiting = json_output(
        credentials.operator(&["describe", "task", task_id, "--output", "json"], &public),
    )
    .await?;
    assert_eq!(waiting["state"], "TASK_STATE_QUEUED", "{waiting}");
    assert_eq!(
        waiting["waiting_for"]["requirement"], "network-scope",
        "{waiting}"
    );

    // A host that names the credential but lacks its value refuses to start.
    let mut missing = worker(false);
    missing.args(["--network-credential", "github=GITHUB_TOKEN"]);
    let refused = output(missing).await?;
    ensure!(
        !refused.status.success(),
        "host started without the credential value"
    );
    assert!(
        String::from_utf8_lossy(&refused.stderr).contains("SUPERTAG_NETWORK_CREDENTIAL_GITHUB"),
        "{}",
        String::from_utf8_lossy(&refused.stderr)
    );

    let ran = output(worker(true)).await?;
    let stderr = String::from_utf8_lossy(&ran.stderr);
    ensure!(ran.status.success(), "Worker Host failed: {stderr}");
    let described = json_output(
        credentials.operator(&["describe", "task", task_id, "--output", "json"], &public),
    )
    .await?;
    assert_eq!(
        described["state"], "TASK_STATE_SUCCEEDED",
        "{described} {stderr}"
    );
    assert_eq!(
        described["result"], "outside=403 anonymous=407",
        "{described}"
    );
    let logs = described["network_log"]
        .as_array()
        .context("missing network log")?;
    assert_eq!(logs.len(), 1, "{described}");
    assert_eq!(logs[0]["attempt_id"], described["attempt_id"]);
    assert_eq!(
        (logs[0]["allowed"].as_u64(), logs[0]["denied"].as_u64()),
        (Some(0), Some(1))
    );
    let request = &logs[0]["requests"][0];
    assert_eq!(request["method"], "CONNECT", "{request}");
    assert_eq!(request["origin"], "https://denied.example.com", "{request}");
    assert_eq!(request["allowed"], false);
    assert_eq!(
        request["reason"],
        "origin is not in the Task's network scope"
    );

    // Codex received the proxy, the CA, and a placeholder, never the secret.
    let recorded = std::fs::read_to_string(&record)?;
    assert!(!recorded.contains(SECRET), "the secret reached Codex");
    let recorded: Value = serde_json::from_str(&recorded)?;
    let environment = &recorded["environment"];
    assert!(
        environment["HTTPS_PROXY"]
            .as_str()
            .is_some_and(|url| url.starts_with("http://supertag:"))
    );
    assert_eq!(environment["NO_PROXY"], "*");
    let commands = recorded["argv"]
        .as_array()
        .context("missing argv")?
        .iter()
        .filter_map(Value::as_str)
        .find(|arg| arg.starts_with("shell_environment_policy.set="))
        .context("missing command environment")?
        .to_owned();
    assert!(
        commands.contains("\"GITHUB_TOKEN\" = \"supertag-credential-github-"),
        "{commands}"
    );
    assert!(commands.contains("\"SSL_CERT_FILE\""), "{commands}");
    // The Attempt's CA files are gone with the proxy.
    assert!(
        !state.join("egress").exists() || std::fs::read_dir(state.join("egress"))?.count() == 0
    );

    plane.kill().await?;
    plane.wait().await?;
    Ok(())
}

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    enforces_a_network_scope_through_the_hosts_egress_proxy;
}

async fn enforces_a_network_scope_through_the_hosts_egress_proxy(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    exercise(&database, directory.path()).await
}
