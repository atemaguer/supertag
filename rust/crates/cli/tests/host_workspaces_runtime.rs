//! Placement through real Control Plane, Worker Host, and CLI processes: one Worker Host
//! serving several named Workspace checkouts, operator-named Auth Keys, and Worker Host credential
//! rotation. Mirrors tests/workspace-advertisement.test.ts (repeated `--workspace NAME=PATH`),
//! tests/workspace-git-resolver.test.ts (two Workspace names on one checkout),
//! tests/auth-key-cli.test.ts, and tests/worker-host-cli.test.ts (`rotate worker-host-credential`).
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[macro_use]
#[path = "support/database.rs"]
mod database;

use std::{net::SocketAddr, path::Path, process::Stdio, time::Duration};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::timeout,
};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(30);

database_tests! {
    #[tokio::test]
    one_host_serves_several_named_workspaces;
    #[tokio::test]
    named_auth_keys_and_rotated_host_credentials;
}

struct Services {
    operator: String,
    host: String,
    public: String,
    _plane: Child,
}

impl Services {
    async fn start(database: &str, directory: &Path) -> Result<Self> {
        let gateway = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
        let operator = Uuid::new_v4().to_string();
        let host = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
        let mut plane = bare(&["control-plane"]);
        plane
            .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &gateway)
            .env("SUPERTAG_GATEWAY_CREDENTIAL", &gateway)
            .env("SUPERTAG_OPERATOR_TOKEN", &operator)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host)
            .env("SUPERTAG_DATABASE_URL", database)
            .arg("--transfer-directory")
            .arg(directory.join("transfers"));
        let (plane, public) = service(plane).await?;
        Ok(Self {
            operator,
            host,
            public,
            _plane: plane,
        })
    }

    fn cli(&self, args: &[&str]) -> Command {
        let mut command = bare(&[args[0], "--control-plane", &self.public]);
        command
            .args(&args[1..])
            .env("SUPERTAG_OPERATOR_TOKEN", &self.operator);
        command
    }

    /// A Worker Host that runs one Task, if any, and exits.
    fn worker(&self, state: &Path, token: Option<&str>, workspaces: &[(&str, &Path)]) -> Command {
        let mut command = bare(&[
            "worker-host",
            "--control-plane",
            &self.public,
            "--adapter",
            ADAPTER,
            "--adapter-arg=--workspace-fixture",
            "--once",
        ]);
        command.arg("--state-directory").arg(state);
        for (id, source) in workspaces {
            command
                .args(["--workspace-id", id, "--workspace-source"])
                .arg(source);
        }
        if let Some(token) = token {
            command.env("SUPERTAG_HOST_TOKEN", token);
        }
        command
    }
}

fn bare(args: &[&str]) -> Command {
    let mut command = Command::new(BINARY);
    command
        .args(args)
        .env_clear()
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
}

async fn repository(path: &Path, content: &str) -> Result<String> {
    std::fs::create_dir(path)?;
    git(path, &["init", "--quiet"]).await?;
    std::fs::write(path.join("workspace.txt"), content)?;
    git(path, &["add", "workspace.txt"]).await?;
    git(path, &["commit", "--quiet", "-m", "Initial source"]).await?;
    git(path, &["rev-parse", "HEAD"]).await
}

async fn one_host_serves_several_named_workspaces(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let app = root.join("app");
    let docs = root.join("docs");
    let app_base = repository(&app, "app source\n").await?;
    let docs_base = repository(&docs, "docs source\n").await?;
    let services = Services::start(&database, root).await?;
    let cli = |args: &[&str]| services.cli(args);

    // Two Workspace names map one checkout; a third maps another; a fourth names a missing path.
    let missing = root.join("missing");
    for (tag, workspace, base) in [
        ("app-builder", "app", &app_base),
        ("alias-builder", "alias", &app_base),
        ("docs-writer", "docs", &docs_base),
        ("missing-builder", "missing", &app_base),
        ("other-builder", "other", &app_base),
    ] {
        json(cli(&[
            "tag",
            "put",
            tag,
            "--instructions",
            "Edit the repository",
            "--allow",
            "files:write",
            "--workspace-id",
            workspace,
            "--workspace-base",
            base,
        ]))
        .await?;
    }
    let mut tasks = Vec::new();
    for tag in [
        "app-builder",
        "alias-builder",
        "docs-writer",
        "missing-builder",
        "other-builder",
    ] {
        let task = json(cli(&[
            "task",
            "submit",
            "--tag",
            tag,
            "--session",
            "work",
            tag,
        ]))
        .await?;
        tasks.push(field(&task, "task_id")?.to_owned());
    }

    let mappings: [(&str, &Path); 4] = [
        ("app", &app),
        ("alias", &app),
        ("docs", &docs),
        ("missing", &missing),
    ];
    let state = root.join("host-state");
    // A Workspace may be mapped once, and every ID needs its own source.
    let mut duplicate = services.worker(&state, Some(&services.host), &mappings[..1]);
    duplicate
        .args(["--workspace-id", "app", "--workspace-source"])
        .arg(&docs);
    let refused = output(duplicate).await?;
    ensure!(!refused.status.success());
    ensure!(
        String::from_utf8_lossy(&refused.stderr).contains("Workspace app is mapped more than once"),
        "{}",
        String::from_utf8_lossy(&refused.stderr)
    );
    let mut unpaired = services.worker(&state, Some(&services.host), &mappings[..1]);
    unpaired.args(["--workspace-id", "docs"]);
    let refused = output(unpaired).await?;
    ensure!(!refused.status.success());
    ensure!(
        String::from_utf8_lossy(&refused.stderr)
            .contains("give each --workspace-id its own --workspace-source"),
        "{}",
        String::from_utf8_lossy(&refused.stderr)
    );

    for _ in 0..3 {
        success(services.worker(&state, Some(&services.host), &mappings)).await?;
    }
    let get = |id: &str| cli(&["get", "task", id]);
    for (index, (workspace, before)) in [
        ("app", "app source\n"),
        ("alias", "app source\n"),
        ("docs", "docs source\n"),
    ]
    .into_iter()
    .enumerate()
    {
        let task = json(get(&tasks[index])).await?;
        assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
        // Each Task ran in a checkout of its own Workspace's source.
        assert_eq!(
            task["result"],
            format!(
                "Change: {}\nWorkspace before:\n{before}",
                ["app-builder", "alias-builder", "docs-writer"][index]
            )
        );
        assert_eq!(task["workspace_delivery"]["workspace_id"], workspace);
        assert_ne!(
            task["workspace_delivery"]["head_commit"],
            task["workspace_delivery"]["base_commit"]
        );
    }
    // Aliases deliver independently, and nothing is written into the operator's checkout.
    let app_head = json(get(&tasks[0])).await?["workspace_delivery"]["head_commit"].clone();
    let alias_head = json(get(&tasks[1])).await?["workspace_delivery"]["head_commit"].clone();
    assert_ne!(app_head, alias_head);
    assert_eq!(git(&app, &["rev-parse", "HEAD"]).await?, app_base);
    assert_eq!(
        git(&app, &["for-each-ref", "--format=%(refname)"]).await?,
        git(&app, &["symbolic-ref", "HEAD"]).await?
    );
    assert_eq!(
        std::fs::read_to_string(app.join("workspace.txt"))?,
        "app source\n"
    );

    // A mapping whose source is missing is not advertised, and an unmapped Workspace never runs.
    success(services.worker(&state, Some(&services.host), &mappings)).await?;
    for task in &tasks[3..] {
        assert_eq!(json(get(task)).await?["state"], "TASK_STATE_QUEUED");
    }
    let host = json(cli(&["get", "host", "local"])).await?;
    assert_eq!(host["workspace_ids"], json!(["alias", "app", "docs"]));
    let labels = host["labels"].as_array().context("labels")?;
    for label in ["workspace:alias", "workspace:app", "workspace:docs"] {
        ensure!(labels.contains(&json!(label)), "{host}");
    }
    ensure!(!labels.contains(&json!("workspace:missing")), "{host}");
    let diagnosis = json(cli(&["placement", "explain", &tasks[4]])).await?;
    assert_eq!(diagnosis["missing_labels"], json!(["workspace:other"]));

    // Once the missing source appears, the same configuration advertises and runs it.
    git(root, &["clone", "--quiet", "app", "missing"]).await?;
    success(services.worker(&state, Some(&services.host), &mappings)).await?;
    let ran = json(get(&tasks[3])).await?;
    assert_eq!(ran["state"], "TASK_STATE_SUCCEEDED", "{ran}");
    assert_eq!(ran["workspace_delivery"]["workspace_id"], "missing");
    assert_eq!(json(get(&tasks[4])).await?["state"], "TASK_STATE_QUEUED");
    Ok(())
}

async fn named_auth_keys_and_rotated_host_credentials(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let source = root.join("source");
    let base = repository(&source, "base\n").await?;
    let services = Services::start(&database, root).await?;
    let cli = |args: &[&str]| services.cli(args);
    json(cli(&[
        "tag",
        "put",
        "builder",
        "--instructions",
        "Edit the repository",
        "--allow",
        "files:write",
        "--workspace-id",
        "project",
        "--workspace-base",
        &base,
    ]))
    .await?;

    // Keys carry the operator's name, which is never reused.
    let issued = json(cli(&[
        "auth-key", "create", "laptop", "--role", "host", "--tag", "builder",
    ]))
    .await?;
    assert_eq!(
        (&issued["name"], &issued["role"], &issued["phase"]),
        (&json!("laptop"), &json!("host"), &json!("active"))
    );
    let key = field(&issued, "auth_key")?.to_owned();
    for (args, message) in [
        (
            [
                "auth-key",
                "create",
                "laptop",
                "--role",
                "host",
                "--reusable",
                "--all-tags",
            ],
            "never reused",
        ),
        (
            [
                "auth-key",
                "create",
                "Laptop",
                "--role",
                "host",
                "--reusable",
                "--all-tags",
            ],
            "Auth Key name must be 1-63 lowercase",
        ),
    ] {
        let refused = output(cli(&args)).await?;
        ensure!(!refused.status.success());
        ensure!(
            String::from_utf8_lossy(&refused.stderr).contains(message),
            "{}",
            String::from_utf8_lossy(&refused.stderr)
        );
    }
    json(cli(&[
        "auth-key",
        "create",
        "ci",
        "--role",
        "host",
        "--reusable",
        "--all-tags",
    ]))
    .await?;
    json(cli(&["auth-key", "revoke", "ci"])).await?;

    let state = root.join("laptop-state");
    let mut enroll = bare(&[
        "host",
        "enroll",
        "laptop-host",
        "--control-plane",
        &services.public,
        "--auth-key",
        &key,
    ]);
    enroll.arg("--state-directory").arg(&state);
    json(enroll).await?;

    let listed = json(cli(&["get", "auth-keys"])).await?;
    let keys = listed["auth_keys"].as_array().context("auth_keys")?;
    let summary: Vec<(&str, &str)> = keys
        .iter()
        .map(|key| {
            (
                key["name"].as_str().unwrap_or_default(),
                key["phase"].as_str().unwrap_or_default(),
            )
        })
        .collect();
    assert_eq!(summary, [("laptop", "used"), ("ci", "revoked")]);
    ensure!(
        !listed.to_string().contains(&key),
        "a listed Auth Key exposed its secret"
    );
    let page = json(cli(&["get", "auth-keys", "--limit", "1"])).await?;
    assert_eq!(page["next_cursor"], "laptop");
    let rest = json(cli(&[
        "get",
        "auth-keys",
        "--limit",
        "1",
        "--cursor",
        "laptop",
    ]))
    .await?;
    assert_eq!(rest["auth_keys"][0]["name"], "ci");
    assert_eq!(
        json(cli(&["get", "auth-key", "laptop"])).await?["used"],
        true
    );

    let submit = |prompt: &str| {
        let mut command = cli(&["task", "submit", "--tag", "builder", "--session", "work"]);
        command.arg(prompt);
        command
    };
    let mappings: [(&str, &Path); 1] = [("project", &source)];
    let run = |token: Option<&str>| services.worker(&state, token, &mappings);
    let first = json(submit("first")).await?;
    success(run(None)).await?;
    assert_eq!(
        json(cli(&["get", "task", field(&first, "task_id")?])).await?["state"],
        "TASK_STATE_SUCCEEDED"
    );
    let host = json(cli(&["get", "host", "laptop-host"])).await?;
    assert_eq!(host["credential_revision"], 1);

    // The host rotates its own credential in its state directory, presenting the current one.
    let rotated = json({
        let mut command = cli(&["host", "rotate-credential", "laptop-host"]);
        command.arg("--host-state-directory").arg(&state);
        command
    })
    .await?;
    assert_eq!(rotated["credential_revision"], 2);
    let second = json(submit("second")).await?;
    success(run(None)).await?;
    assert_eq!(
        json(cli(&["get", "task", field(&second, "task_id")?])).await?["state"],
        "TASK_STATE_SUCCEEDED"
    );

    // Rotating to a file stops the installed credential at once.
    let out = root.join("laptop.credential");
    let rotated = json({
        let mut command = cli(&["host", "rotate-credential", "laptop-host"]);
        command.arg("--out").arg(&out);
        command
    })
    .await?;
    assert_eq!(rotated["credential_revision"], 3);
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&out)?.permissions().mode() & 0o777, 0o600);
    }
    let token = std::fs::read_to_string(&out)?.trim().to_owned();
    let third = json(submit("third")).await?;
    let third_id = field(&third, "task_id")?.to_owned();
    let stale = output(run(None)).await?;
    ensure!(
        !stale.status.success()
            && String::from_utf8_lossy(&stale.stderr).contains("valid bearer credential required"),
        "the replaced credential still worked: {}",
        String::from_utf8_lossy(&stale.stderr)
    );
    assert_eq!(
        json(cli(&["get", "task", &third_id])).await?["state"],
        "TASK_STATE_QUEUED"
    );
    success(run(Some(&token))).await?;
    assert_eq!(
        json(cli(&["get", "task", &third_id])).await?["state"],
        "TASK_STATE_SUCCEEDED"
    );
    // An existing output file is refused before anything rotates.
    let refused = output({
        let mut command = cli(&["host", "rotate-credential", "laptop-host"]);
        command.arg("--out").arg(&out);
        command
    })
    .await?;
    ensure!(!refused.status.success());
    assert_eq!(
        json(cli(&["get", "host", "laptop-host"])).await?["credential_revision"],
        3
    );
    // The bootstrap host's credential is configured at Control Plane startup instead.
    let refused = output({
        let mut command = cli(&["host", "rotate-credential", "local"]);
        command.arg("--out").arg(root.join("local.credential"));
        command
    })
    .await?;
    ensure!(!refused.status.success());
    ensure!(!root.join("local.credential").exists());

    // The audit log names the keys and the rotated host.
    let audit = json(cli(&["audit", "--output", "json", "--limit", "100"])).await?;
    let entries: Vec<(String, String)> = audit["entries"]
        .as_array()
        .context("entries")?
        .iter()
        .filter(|entry| entry["outcome"] == "succeeded")
        .map(|entry| {
            (
                entry["action"].as_str().unwrap_or_default().to_owned(),
                entry["target"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect();
    for expected in [
        ("auth-key.create", "AuthKey/laptop"),
        ("auth-key.revoke", "AuthKey/ci"),
        ("credential.rotate", "WorkerHost/laptop-host"),
    ] {
        ensure!(
            entries.contains(&(expected.0.to_owned(), expected.1.to_owned())),
            "{expected:?} missing from {entries:?}"
        );
    }
    Ok(())
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

async fn json(command: Command) -> Result<Value> {
    Ok(serde_json::from_slice(&success(command).await?.stdout)?)
}

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value[name]
        .as_str()
        .with_context(|| format!("missing {name}: {value}"))
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
