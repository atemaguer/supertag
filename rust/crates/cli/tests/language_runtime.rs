#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[macro_use]
#[path = "support/database.rs"]
mod database;

#[path = "support/mcp_runtime.rs"]
mod mcp_runtime;
#[path = "support/python_artifacts_runtime.rs"]
mod python_artifacts_runtime;
#[path = "support/task_artifact_inputs_runtime.rs"]
mod task_artifact_inputs_runtime;

use std::{
    net::SocketAddr, os::unix::fs::PermissionsExt, path::Path, process::Stdio, time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::timeout,
};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(20);

fn command(args: &[&str]) -> Command {
    let mut command = Command::new(BINARY);
    command
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
}

async fn service(mut command: Command) -> Result<(Child, String)> {
    let mut child = command.stdout(Stdio::piped()).spawn()?;
    let mut stdout = BufReader::new(child.stdout.take().context("service stdout missing")?);
    let mut line = String::new();
    timeout(WAIT, stdout.read_line(&mut line)).await??;
    let address: SocketAddr = line.trim().parse().context("service did not bind")?;
    ensure!(address.ip().is_loopback() && address.port() != 0);
    Ok((child, format!("http://{address}")))
}

async fn success(mut command: Command) -> Result<Vec<u8>> {
    let output = timeout(WAIT, command.output()).await??;
    ensure!(
        output.status.success(),
        "SuperTag process failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(output.stdout)
}

async fn operator(args: &[&str], gateway: &str, token: &str) -> Result<Value> {
    let (subcommand, args) = args.split_first().context("operator subcommand required")?;
    let mut command = command(&[subcommand, "--gateway", gateway]);
    command.args(args).env("SUPERTAG_OPERATOR_TOKEN", token);
    Ok(serde_json::from_slice(&success(command).await?)?)
}

fn fixture_launcher(path: &Path) -> Result<()> {
    std::fs::write(
        path,
        r#"#!/bin/sh
set -eu
if [ "$1" = "-I" ]; then
  shift
  test "${OPENAI_API_KEY:-}" = python-fixture-key
  test -z "${ANTHROPIC_API_KEY:-}${CLAUDE_CODE_OAUTH_TOKEN:-}${HOME:-}"
else
  test "${ANTHROPIC_API_KEY:-}" = claude-fixture-key
  test -z "${OPENAI_API_KEY:-}"
  test -n "${HOME:-}"
fi
test -z "${SUPERTAG_HOST_TOKEN:-}${SUPERTAG_BOOTSTRAP_HOST_TOKEN:-}${SUPERTAG_GATEWAY_TOKEN:-}${SUPERTAG_OPERATOR_TOKEN:-}${PYTHONPATH:-}${CODEX_API_KEY:-}"
test -n "$SUPERTAG_ADAPTER_STATE_DIRECTORY"
test "$SUPERTAG_WORKSPACE_DIRECTORY" = "$SUPERTAG_ADAPTER_STATE_DIRECTORY/workspace"
test "$TMPDIR" = "$SUPERTAG_ADAPTER_STATE_DIRECTORY/tmp"
test "$PWD" = "$SUPERTAG_WORKSPACE_DIRECTORY"
test -d "$TMPDIR"
program=$1
shift
test "$1" = "--model"
test "$2" = "fixture-model"
test "$3" = "--timeout-seconds"
test "$4" = "120"
exec "$program"
"#,
    )?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

database_tests! {
    #[tokio::test]
    language_profiles_route_tasks_and_limit_credentials_and_scratch;
    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_NODE and a built Claude Code language adapter"]
    claude_sdk_calls_only_the_frozen_scoped_http_mcp_tool;
    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_NODE and a built Claude Code language adapter"]
    claude_sdk_calls_only_the_frozen_scoped_stdio_mcp_tool;
    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_AGENTS_PYTHON with the Python SDK runtime and agents extras installed"]
    python_agents_sdk_restores_session_on_a_fresh_host;
    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_NODE and a built Claude Code language adapter"]
    claude_code_sdk_restores_session_on_a_fresh_host;
    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_NODE and a built Claude Code language adapter"]
    claude_captures_selected_workspace_files_for_the_operator;
    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_NODE and a built Claude Code language adapter"]
    claude_sdk_approves_one_workstream_post_and_delivers_one_mailbox_turn;
    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_NODE and a built Claude Code language adapter"]
    claude_sdk_applies_accepted_usd_budget_and_records_the_stop_usage;
}

async fn language_profiles_route_tasks_and_limit_credentials_and_scratch(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let gateway_token = Uuid::new_v4().to_string();
    let operator_token = Uuid::new_v4().to_string();
    let host_token = Uuid::new_v4().to_string();
    let mut control = command(&["control-plane"]);
    control
        .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
        .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
        .env("SUPERTAG_DATABASE_URL", &database);
    let (mut control, private) = service(control).await?;
    let mut gateway = command(&["gateway", "--control-plane", &private]);
    gateway
        .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
        .env("SUPERTAG_OPERATOR_TOKEN", &operator_token);
    let (mut gateway, public) = service(gateway).await?;

    let mut tasks = Vec::new();
    for (tag, harness) in [("python", "openai-agents"), ("node", "claude-code")] {
        operator(
            &[
                "tag",
                "put",
                tag,
                "--instructions",
                "Fixture adapter",
                "--harness",
                harness,
            ],
            &public,
            &operator_token,
        )
        .await?;
        let task = operator(
            &[
                "task",
                "submit",
                "--tag",
                tag,
                "--session",
                "test",
                "Run through the matching adapter",
            ],
            &public,
            &operator_token,
        )
        .await?;
        tasks.push(
            task["task_id"]
                .as_str()
                .context("Task ID missing")?
                .to_owned(),
        );
    }

    let launcher = directory.path().join("runtime-fixture.sh");
    fixture_launcher(&launcher)?;
    for (selected, harness) in [(1, "claude-code"), (0, "openai-agents")] {
        let host_state = directory.path().join(harness);
        let mut host = command(&[
            "worker-host",
            "--gateway",
            &public,
            "--once",
            "--harness",
            harness,
            "--harness-entrypoint",
            ADAPTER,
            "--harness-model",
            "fixture-model",
        ]);
        host.arg("--harness-runtime")
            .arg(&launcher)
            .arg("--state-directory")
            .arg(&host_state)
            .env("HOME", directory.path())
            .env("SUPERTAG_HOST_TOKEN", &host_token)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
            .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
            .env("SUPERTAG_OPERATOR_TOKEN", &operator_token)
            .env("OPENAI_API_KEY", "python-fixture-key")
            .env("ANTHROPIC_API_KEY", "claude-fixture-key")
            .env("CODEX_API_KEY", "unused-codex-key")
            .env("PYTHONPATH", directory.path());
        success(host).await?;
        let task = operator(&["get", "task", &tasks[selected]], &public, &operator_token).await?;
        assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
        assert!(
            task["result"]
                .as_str()
                .unwrap_or_default()
                .contains("matching adapter")
        );
        if selected == 1 {
            let pending = operator(&["get", "task", &tasks[0]], &public, &operator_token).await?;
            assert_eq!(pending["state"], "TASK_STATE_QUEUED");
        }
        assert!(std::fs::read_dir(host_state)?.all(|entry| {
            !entry
                .expect("host state entry")
                .file_name()
                .to_string_lossy()
                .starts_with("adapter-attempt-")
        }));
    }
    gateway.kill().await?;
    control.kill().await?;
    Ok(())
}

struct LanguageServices {
    control: Child,
    gateway: Child,
    private: String,
    gateway_token: String,
    public: String,
    operator_token: String,
    host_token: String,
}

impl LanguageServices {
    async fn start(directory: &Path, database: &str) -> Result<Self> {
        Self::start_with_volume(directory, database, None).await
    }

    async fn start_with_volume(
        directory: &Path,
        database: &str,
        volume: Option<&Path>,
    ) -> Result<Self> {
        let gateway_token = Uuid::new_v4().to_string();
        let operator_token = Uuid::new_v4().to_string();
        let host_token = Uuid::new_v4().to_string();
        let mut control = command(&["control-plane"]);
        control
            .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
            .env("SUPERTAG_DATABASE_URL", database);
        let (control, private) = service(control).await?;
        let mut gateway = command(&["gateway", "--control-plane", &private]);
        gateway
            .arg("--checkpoint-directory")
            .arg(directory.join("blobs"))
            .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
            .env("SUPERTAG_OPERATOR_TOKEN", &operator_token);
        if let Some(volume) = volume {
            gateway
                .arg("--artifact-volume")
                .arg(format!("inputs={}", volume.display()));
        }
        let (gateway, public) = service(gateway).await?;
        Ok(Self {
            control,
            gateway,
            private,
            gateway_token,
            public,
            operator_token,
            host_token,
        })
    }

    async fn operator(&self, args: &[&str]) -> Result<Value> {
        operator(args, &self.public, &self.operator_token).await
    }

    fn worker(&self, harness: &str, directory: &Path, runtime: &Path, entry: &Path) -> Command {
        let mut host = self.serving_worker(harness, directory, runtime, entry);
        host.arg("--once");
        host
    }

    /// A Worker Host that keeps serving until it is stopped.
    fn serving_worker(
        &self,
        harness: &str,
        directory: &Path,
        runtime: &Path,
        entry: &Path,
    ) -> Command {
        let mut host = command(&[
            "worker-host",
            "--gateway",
            &self.public,
            "--harness",
            harness,
            "--harness-model",
            "fixture-model",
        ]);
        host.arg("--harness-entrypoint")
            .arg(entry)
            .arg("--harness-runtime")
            .arg(runtime)
            .arg("--state-directory")
            .arg(directory)
            .env("SUPERTAG_HOST_TOKEN", &self.host_token);
        host
    }

    async fn stop(mut self) -> Result<()> {
        self.gateway.kill().await?;
        self.control.kill().await?;
        Ok(())
    }
}

fn repo_path(relative: &str) -> Result<std::path::PathBuf> {
    Ok(Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(relative)
        .canonicalize()?)
}

fn claude_fixture(directory: &Path) -> Result<std::path::PathBuf> {
    let native = directory.join("claude-fixture.mjs");
    std::fs::copy(
        repo_path("packages/runtime/harnesses/claude-code/fixtures/rust-native-claude.mjs")?,
        &native,
    )?;
    std::fs::set_permissions(&native, std::fs::Permissions::from_mode(0o700))?;
    Ok(native)
}

async fn last_usage(services: &LanguageServices, task: &Value) -> Result<Value> {
    let mut command = command(&[
        "task",
        "usage",
        task["task_id"].as_str().context("Task ID missing")?,
        task["attempt_id"].as_str().context("Attempt ID missing")?,
        "--gateway",
        &services.public,
    ]);
    command.env("SUPERTAG_OPERATOR_TOKEN", &services.operator_token);
    let output = String::from_utf8(success(command).await?)?;
    let latest = output
        .lines()
        .last()
        .context("no native usage was recorded")?;
    Ok(serde_json::from_str(latest)?)
}

async fn claude_sdk_calls_only_the_frozen_scoped_http_mcp_tool(database: String) -> Result<()> {
    let Some(node) = crate::prerequisites::env("node", "SUPERTAG_RUST_TEST_NODE")? else {
        return Ok(());
    };
    let entry = repo_path("packages/runtime/harnesses/claude-code/dist/rust-adapter/entry.js")?;
    let directory = tempfile::tempdir()?;
    let native = claude_fixture(directory.path())?;
    let services = LanguageServices::start(directory.path(), &database).await?;
    let journal = directory.path().join("mcp-provider.jsonl");
    let mut provider = Command::new(&node);
    provider
        .arg(repo_path(
            "packages/runtime/harnesses/claude-code/fixtures/rust-mcp-provider.mjs",
        )?)
        .arg(&journal)
        .env_clear()
        .stdin(Stdio::null())
        .kill_on_drop(true);
    let (mut provider, endpoint) = service(provider).await?;
    let catalog = directory.path().join("mcp-catalog.json");
    let mapping = serde_json::json!([{
        "prefix":"repository:", "separator":"/",
        "components":[{"arguments":["owner","org"]},{"arguments":["repo"]}]
    }]);
    let config = serde_json::json!({"version":1,"servers":[{
        "name":"catalog","url":format!("{endpoint}/mcp"),
        "headerEnv":{"Authorization":"CATALOG_MCP_AUTH"},
        "resources":{"tools":{"list_docs":mapping,"publish":mapping}}
    }]});
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&catalog)?
        .write_all(config.to_string().as_bytes())?;
    let permissions = directory.path().join("mcp-grants.json");
    std::fs::write(&permissions, serde_json::json!({
        "set_id":"mcp-grants", "name":"mcp-grants", "approvers":["operator:local"],
        "permissions":[
            {"target":"mcp","action":"catalog/list_*","resource":"repository:acme/docs"},
            {"target":"mcp","action":"catalog/publish"},
            {"target":"mcp","action":"catalog/publish","resource":"repository:acme/docs","approval_required":true}
        ]
    }).to_string())?;
    let role = directory.path().join("mcp-role.json");
    std::fs::write(&role, serde_json::json!({
        "role_id":"mcp-role", "name":"mcp-role", "purpose":"Read the catalog", "permission_set_ids":["mcp-grants"]
    }).to_string())?;
    services
        .operator(&[
            "tag",
            "put",
            "mcp-reader",
            "--harness",
            "claude-code",
            "--instructions",
            "Read the scoped catalog.",
        ])
        .await?;
    services
        .operator(&[
            "policy",
            "put",
            "permission-set",
            permissions.to_str().context("permission set path")?,
        ])
        .await?;
    services
        .operator(&["policy", "put", "role", role.to_str().context("role path")?])
        .await?;
    services
        .operator(&["policy", "assign", "mcp-role", "mcp-reader"])
        .await?;
    let task = services
        .operator(&[
            "task",
            "submit",
            "--tag",
            "mcp-reader",
            "--session",
            "mcp",
            "scoped-http-mcp",
        ])
        .await?;
    let task_id = task["task_id"].as_str().context("Task ID")?;
    let worker = |state: &str| {
        let mut host = services.worker(
            "claude-code",
            &directory.path().join(state),
            Path::new(&node),
            &entry,
        );
        host.arg("--claude-path")
            .arg(&native)
            .env("ANTHROPIC_API_KEY", "fixture-provider-key");
        host
    };
    success(worker("no-catalog")).await?;
    let pending = services.operator(&["get", "task", task_id]).await?;
    assert_eq!(pending["state"], "TASK_STATE_QUEUED");
    assert!(pending["attempt_id"].is_null());
    assert!(!journal.exists());
    let catalog_worker = |state: &str| {
        let mut host = worker(state);
        host.arg("--mcp-catalog")
            .arg(&catalog)
            .env("CATALOG_MCP_AUTH", "Bearer synthetic-catalog-credential")
            .env("CATALOG_MCP_URL", &endpoint);
        host
    };
    success(catalog_worker("catalog-host")).await?;
    let completed = services.operator(&["get", "task", task_id]).await?;
    assert_eq!(completed["state"], "TASK_STATE_SUCCEEDED", "{completed}");
    assert_eq!(completed["result"], "fixture used one scoped MCP tool");
    let provider_receipts = std::fs::read_to_string(&journal)?;
    let receipts = provider_receipts
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<Vec<Value>, _>>()?;
    assert_eq!(
        receipts,
        [
            serde_json::json!({"tool":"list_docs","arguments":{"owner":"acme","repo":"docs"}}),
            serde_json::json!({"tool":"list_docs","arguments":{"owner":"acme","repo":"docs","mirror":true}}),
            serde_json::json!({"closed":true}),
        ]
    );
    let waiting = services
        .operator(&["inbox", "list", "--kind", "approval"])
        .await?;
    let approvals = waiting["items"].as_array().context("MCP approvals")?;
    assert_eq!(approvals.len(), 2);
    let id_for = |resource| -> Result<&str> {
        approvals
            .iter()
            .find(|item| item["approval"]["resource"] == resource)
            .and_then(|item| item["approval"]["approval_id"].as_str())
            .context("MCP approval for the expected resource")
    };
    let missing_id = id_for("")?;
    let exact_id = id_for("repository:acme/docs")?;
    let exact = services.operator(&["inbox", "approval", exact_id]).await?;
    assert_eq!(
        exact["arguments"],
        serde_json::json!({"owner":"acme","repo":"docs"})
    );
    assert_eq!(exact["action"], "mcp:catalog/publish");
    services
        .operator(&[
            "inbox",
            "deny",
            missing_id,
            "--operation-id",
            "reject-missing-mcp",
            "--reason",
            "The repository was not specified.",
        ])
        .await?;
    let decision = services
        .operator(&[
            "inbox",
            "approve",
            exact_id,
            "--operation-id",
            "approve-exact-mcp",
        ])
        .await?;
    let resumed_id = decision["continuation_task_id"]
        .as_str()
        .context("MCP continuation Task")?;
    success(catalog_worker("catalog-resume")).await?;
    let resumed = services.operator(&["get", "task", resumed_id]).await?;
    assert_eq!(resumed["state"], "TASK_STATE_SUCCEEDED", "{resumed}");
    assert_eq!(resumed["session_id"], completed["session_id"]);
    assert_eq!(
        resumed["result"],
        "fixture resumed and dispatched one approved MCP effect",
        "provider journal: {}",
        std::fs::read_to_string(&journal)?
    );
    let receipts = std::fs::read_to_string(journal)?;
    let effects = receipts
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<Vec<Value>, _>>()?;
    assert_eq!(effects.len(), 5);
    assert_eq!(
        effects[3],
        serde_json::json!({"tool":"publish","arguments":{"owner":"acme","repo":"docs"}})
    );
    assert_eq!(effects[4], serde_json::json!({"closed":true}));
    let exact = services.operator(&["inbox", "approval", exact_id]).await?;
    assert!(exact["consumed_at_ms"].is_i64());
    provider.kill().await?;
    services.stop().await
}

async fn claude_sdk_calls_only_the_frozen_scoped_stdio_mcp_tool(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    exercise_stdio_mcp(directory.path(), &database).await
}

/// The Worker Host launches a stdio MCP server for each Attempt with only its catalog `env`,
/// exposes only granted tools, holds the gated call for exact approval, withholds a result that
/// reflects the server's credential, and stops the server when the Attempt ends.
async fn exercise_stdio_mcp(directory: &Path, database: &str) -> Result<()> {
    let node =
        std::env::var_os("SUPERTAG_RUST_TEST_NODE").context("Node test executable required")?;
    let entry = repo_path("packages/runtime/harnesses/claude-code/dist/rust-adapter/entry.js")?;
    let native = claude_fixture(directory)?;
    let services = LanguageServices::start(directory, database).await?;
    let journal = directory.join("mcp-stdio.jsonl");
    let catalog = directory.join("mcp-catalog.json");
    let mapping = serde_json::json!([{
        "prefix":"repository:", "separator":"/",
        "components":[{"arguments":["owner","org"]},{"arguments":["repo"]}]
    }]);
    let config = serde_json::json!({"version":1,"servers":[{
        "name":"catalog",
        "command":[
            Path::new(&node).to_str().context("Node path")?,
            repo_path("packages/runtime/harnesses/claude-code/fixtures/rust-mcp-stdio-provider.mjs")?
                .to_str()
                .context("fixture path")?,
            journal.to_str().context("journal path")?,
        ],
        "env":{"CATALOG_TOKEN":"CATALOG_MCP_AUTH"},
        "resources":{"tools":{"list_docs":mapping,"publish":mapping}}
    }]});
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&catalog)?
        .write_all(config.to_string().as_bytes())?;
    let permissions = directory.join("mcp-grants.json");
    std::fs::write(&permissions, serde_json::json!({
        "set_id":"mcp-grants", "name":"mcp-grants", "approvers":["operator:local"],
        "permissions":[
            {"target":"mcp","action":"catalog/list_*","resource":"repository:acme/docs"},
            {"target":"mcp","action":"catalog/publish"},
            {"target":"mcp","action":"catalog/publish","resource":"repository:acme/docs","approval_required":true}
        ]
    }).to_string())?;
    let role = directory.join("mcp-role.json");
    std::fs::write(&role, serde_json::json!({
        "role_id":"mcp-role", "name":"mcp-role", "purpose":"Read the catalog", "permission_set_ids":["mcp-grants"]
    }).to_string())?;
    services
        .operator(&[
            "tag",
            "put",
            "mcp-reader",
            "--harness",
            "claude-code",
            "--instructions",
            "Read the scoped catalog.",
        ])
        .await?;
    services
        .operator(&[
            "policy",
            "put",
            "permission-set",
            permissions.to_str().context("permission set path")?,
        ])
        .await?;
    services
        .operator(&["policy", "put", "role", role.to_str().context("role path")?])
        .await?;
    services
        .operator(&["policy", "assign", "mcp-role", "mcp-reader"])
        .await?;
    let task = services
        .operator(&[
            "task",
            "submit",
            "--tag",
            "mcp-reader",
            "--session",
            "mcp",
            "scoped-http-mcp",
        ])
        .await?;
    let task_id = task["task_id"].as_str().context("Task ID")?;
    let configure = |host: &mut Command| {
        host.arg("--claude-path")
            .arg(&native)
            .arg("--mcp-catalog")
            .arg(&catalog)
            .env("ANTHROPIC_API_KEY", "fixture-provider-key")
            .env("CATALOG_MCP_AUTH", "synthetic-catalog-credential")
            .env("WORKER_ONLY_VARIABLE", "worker-only-value");
    };
    let catalog_worker = |state: &str| {
        let mut host = services.worker(
            "claude-code",
            &directory.join(state),
            Path::new(&node),
            &entry,
        );
        configure(&mut host);
        host
    };
    success(catalog_worker("catalog-host")).await?;
    let completed = services.operator(&["get", "task", task_id]).await?;
    assert_eq!(completed["state"], "TASK_STATE_SUCCEEDED", "{completed}");
    assert_eq!(completed["result"], "fixture used one scoped MCP tool");
    let receipts = std::fs::read_to_string(&journal)?
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<Vec<Value>, _>>()?;
    assert_eq!(
        receipts,
        [
            serde_json::json!({"tool":"list_docs","arguments":{"owner":"acme","repo":"docs"}}),
            serde_json::json!({"tool":"list_docs","arguments":{"owner":"acme","repo":"docs","mirror":true}}),
            serde_json::json!({"closed":true}),
        ]
    );
    let waiting = services
        .operator(&["inbox", "list", "--kind", "approval"])
        .await?;
    let approvals = waiting["items"].as_array().context("MCP approvals")?;
    assert_eq!(approvals.len(), 2);
    let id_for = |resource| -> Result<&str> {
        approvals
            .iter()
            .find(|item| item["approval"]["resource"] == resource)
            .and_then(|item| item["approval"]["approval_id"].as_str())
            .context("MCP approval for the expected resource")
    };
    let missing_id = id_for("")?;
    let exact_id = id_for("repository:acme/docs")?;
    services
        .operator(&[
            "inbox",
            "deny",
            missing_id,
            "--operation-id",
            "reject-missing-stdio-mcp",
            "--reason",
            "The repository was not specified.",
        ])
        .await?;
    let decision = services
        .operator(&[
            "inbox",
            "approve",
            exact_id,
            "--operation-id",
            "approve-exact-stdio-mcp",
        ])
        .await?;
    let resumed_id = decision["continuation_task_id"]
        .as_str()
        .context("MCP continuation Task")?;
    // This Worker Host keeps running after the Attempt, so a stopped server proves the Attempt
    // closed it, not that the host exited.
    let mut serving = services.serving_worker(
        "claude-code",
        &directory.join("catalog-resume"),
        Path::new(&node),
        &entry,
    );
    configure(&mut serving);
    let mut serving = serving.stderr(Stdio::null()).spawn()?;
    let resumed = wait_for_state(&services, resumed_id, "TASK_STATE_SUCCEEDED").await?;
    assert_eq!(
        resumed["result"],
        "fixture resumed and dispatched one approved MCP effect"
    );
    let effects = std::fs::read_to_string(&journal)?
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<Vec<Value>, _>>()?;
    assert_eq!(effects.len(), 5);
    assert_eq!(
        effects[3],
        serde_json::json!({"tool":"publish","arguments":{"owner":"acme","repo":"docs"}})
    );
    assert_eq!(effects[4], serde_json::json!({"closed":true}));
    let exact = services.operator(&["inbox", "approval", exact_id]).await?;
    assert!(exact["consumed_at_ms"].is_i64());
    // One launch per Attempt, each with only the catalog env and the minimal default, and each
    // stopped when its Attempt ended.
    let prefix = "mcp-stdio.jsonl.";
    let mut launches = 0;
    for entry in std::fs::read_dir(directory)? {
        let name = entry?.file_name().to_string_lossy().into_owned();
        if !(name.starts_with(prefix) && name.ends_with(".launch")) {
            continue;
        }
        launches += 1;
        let launch: Value = serde_json::from_slice(&std::fs::read(directory.join(&name))?)?;
        let environment = launch["env"].as_object().context("launch environment")?;
        assert_eq!(environment["CATALOG_TOKEN"], "synthetic-catalog-credential");
        for key in environment.keys() {
            assert!(
                matches!(
                    key.as_str(),
                    "CATALOG_TOKEN" | "PATH" | "HOME" | "__CF_USER_TEXT_ENCODING"
                ),
                "unexpected stdio MCP variable {key}"
            );
        }
        let pid = launch["pid"].as_i64().context("launch pid")?;
        // SAFETY: signal 0 only checks for the process.
        assert!(
            unsafe { libc::kill(pid as libc::pid_t, 0) } != 0,
            "stdio MCP server outlived its Attempt"
        );
    }
    assert_eq!(launches, 2);
    assert!(
        serving.try_wait()?.is_none(),
        "the Worker Host must still be running"
    );
    serving.kill().await?;
    services.stop().await
}

/// Polls a Task until it reaches `state`.
async fn wait_for_state(services: &LanguageServices, task_id: &str, state: &str) -> Result<Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let task = services.operator(&["get", "task", task_id]).await?;
        if task["state"] == state {
            return Ok(task);
        }
        ensure!(
            tokio::time::Instant::now() < deadline,
            "Task {task_id} did not reach {state}: {task}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn python_agents_sdk_restores_session_on_a_fresh_host(database: String) -> Result<()> {
    let Some(interpreter) =
        crate::prerequisites::env("agents-python", "SUPERTAG_RUST_TEST_AGENTS_PYTHON")?
    else {
        return Ok(());
    };
    let fixture = repo_path("sdks/python/tests/fixtures/openai_agents_runtime.py")?;
    let directory = tempfile::tempdir()?;
    let services = LanguageServices::start(directory.path(), &database).await?;
    services
        .operator(&[
            "tag",
            "put",
            "python",
            "--instructions",
            "Use the admitted tool surface.",
            "--harness",
            "openai-agents",
            "--allow",
            "files:read",
        ])
        .await?;

    for (index, expected) in [
        "SDK fixture completed first Task.",
        "SDK fixture resumed the Session.",
    ]
    .into_iter()
    .enumerate()
    {
        let task = services
            .operator(&[
                "task",
                "submit",
                "--tag",
                "python",
                "--session",
                "same-session",
                "Continue this Session",
            ])
            .await?;
        let task_id = task["task_id"].as_str().context("Task ID missing")?;
        let mut host = services.worker(
            "openai-agents",
            &directory.path().join(format!("host-{index}")),
            Path::new(&interpreter),
            &fixture,
        );
        host.env("OPENAI_API_KEY", "fixture-provider-key");
        success(host).await?;
        let task = services.operator(&["get", "task", task_id]).await?;
        assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
        assert_eq!(task["result"], expected);
        let usage = last_usage(&services, &task).await?;
        assert_eq!(usage["input_tokens"], 11);
        assert_eq!(usage["cached_input_tokens"], 2);
        assert_eq!(usage["output_tokens"], 5);
    }
    services.stop().await
}

async fn claude_code_sdk_restores_session_on_a_fresh_host(database: String) -> Result<()> {
    let Some(interpreter) = crate::prerequisites::env("node", "SUPERTAG_RUST_TEST_NODE")? else {
        return Ok(());
    };
    let entry = repo_path("packages/runtime/harnesses/claude-code/dist/rust-adapter/entry.js")?;
    let directory = tempfile::tempdir()?;
    let native = claude_fixture(directory.path())?;
    let services = LanguageServices::start(directory.path(), &database).await?;
    services
        .operator(&[
            "tag",
            "put",
            "claude",
            "--instructions",
            "Use the admitted tools.",
            "--harness",
            "claude-code",
            "--allow",
            "files:read",
        ])
        .await?;

    for (index, expected) in ["fixture first turn", "fixture resumed turn"]
        .into_iter()
        .enumerate()
    {
        let task = services
            .operator(&[
                "task",
                "submit",
                "--tag",
                "claude",
                "--session",
                "same-session",
                "Continue this Session",
            ])
            .await?;
        let task_id = task["task_id"].as_str().context("Task ID missing")?;
        let mut host = services.worker(
            "claude-code",
            &directory.path().join(format!("host-{index}")),
            Path::new(&interpreter),
            &entry,
        );
        host.arg("--claude-path")
            .arg(&native)
            .env("ANTHROPIC_API_KEY", "fixture-provider-key");
        success(host).await?;
        let task = services.operator(&["get", "task", task_id]).await?;
        assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
        assert_eq!(task["result"], expected);
        let usage = last_usage(&services, &task).await?;
        assert_eq!(usage["input_tokens"], 15);
        assert_eq!(usage["cached_input_tokens"], 3);
        assert_eq!(usage["output_tokens"], 4);
    }
    services.stop().await
}

async fn claude_captures_selected_workspace_files_for_the_operator(database: String) -> Result<()> {
    let Some(interpreter) = crate::prerequisites::env("node", "SUPERTAG_RUST_TEST_NODE")? else {
        return Ok(());
    };
    let entry = repo_path("packages/runtime/harnesses/claude-code/dist/rust-adapter/entry.js")?;
    let directory = tempfile::tempdir()?;
    let native = claude_fixture(directory.path())?;
    let source = directory.path().join("source");
    std::fs::create_dir(&source)?;
    let git = |args: &[&str]| {
        let mut command = Command::new("git");
        command
            .current_dir(&source)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .arg("-c")
            .arg("user.name=SuperTag Fixture")
            .arg("-c")
            .arg("user.email=fixture@example.invalid")
            .args(args);
        command
    };
    success(git(&["init", "--quiet"])).await?;
    let report = b"durable engineering evidence from the source checkout\n";
    std::fs::write(source.join("report.txt"), report)?;
    std::fs::write(source.join("empty.txt"), [])?;
    std::fs::write(
        source.join("removed.txt"),
        b"will be removed by the harness",
    )?;
    success(git(&["add", "report.txt", "empty.txt", "removed.txt"])).await?;
    success(git(&["commit", "--quiet", "-m", "Fixture source"])).await?;
    let base = String::from_utf8(success(git(&["rev-parse", "HEAD"])).await?)?;
    let services = LanguageServices::start(directory.path(), &database).await?;
    services
        .operator(&[
            "tag",
            "put",
            "producer",
            "--instructions",
            "Save evidence.",
            "--harness",
            "claude-code",
            "--allow",
            "files:read",
            "--allow",
            "files:write",
            "--workspace-id",
            "evidence",
            "--workspace-base",
            base.trim(),
        ])
        .await?;
    let task = services
        .operator(&[
            "task",
            "submit",
            "--tag",
            "producer",
            "--session",
            "evidence",
            "capture-evidence",
        ])
        .await?;
    let task_id = task["task_id"].as_str().context("Task ID missing")?;
    let worker = || {
        let mut host = services.worker(
            "claude-code",
            &directory.path().join("host"),
            Path::new(&interpreter),
            &entry,
        );
        host.arg("--claude-path")
            .arg(&native)
            .arg("--workspace-id")
            .arg("evidence")
            .arg("--workspace-source")
            .arg(&source)
            .env("ANTHROPIC_API_KEY", "fixture-artifact-provider-key");
        host
    };
    success(worker()).await?;
    let task = services.operator(&["get", "task", task_id]).await?;
    assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
    let page = services
        .operator(&["get", "artifacts", "--task", task_id])
        .await?;
    assert!(
        task["result"]
            .as_str()
            .is_some_and(|result| result.starts_with("Captured artifact ")),
        "{task}"
    );
    let records = page["artifacts"]
        .as_array()
        .context("artifact list missing")?;
    assert_eq!(records.len(), 2);
    let explicit = records
        .iter()
        .find(|record| record["description"]["kind"] == "report")
        .context("explicit artifact missing")?;
    let managed = records
        .iter()
        .find(|record| record["description"]["kind"] == "task-output")
        .context("managed Task output missing")?;
    let artifact_id = explicit["artifact_id"]
        .as_str()
        .context("artifact ID missing")?;
    assert_eq!(task["result"], format!("Captured artifact {artifact_id}"));
    assert_eq!(explicit["producer"]["tag_id"], "producer");
    assert_eq!(explicit["producer"]["harness"], "HARNESS_KIND_CLAUDE_CODE");
    assert_eq!(
        explicit["description"]["title"],
        "Release evidence [REDACTED]"
    );
    Uuid::parse_str(
        explicit["producer"]["native_session_id"]
            .as_str()
            .context("native Session ID missing")?,
    )?;
    let artifact = services.operator(&["get", "artifact", artifact_id]).await?;
    assert_eq!(artifact["files"][0]["path"], "empty.txt");
    assert_eq!(artifact["files"][1]["path"], "report.txt");
    let destination = directory.path().join("download.txt");
    let output = destination.to_str().context("fixture path is not UTF-8")?;
    let download = [
        "artifact",
        "download",
        artifact_id,
        "--path",
        "report.txt",
        "--output",
        output,
    ];
    services.operator(&download).await?;
    assert_eq!(std::fs::read(&destination)?, report);
    assert!(services.operator(&download).await.is_err());
    assert_eq!(std::fs::read(&destination)?, report);
    let managed_id = managed["artifact_id"]
        .as_str()
        .context("managed artifact ID missing")?;
    let output_path = format!(
        "{}/deliverable.txt",
        supertag_protocol::artifacts::managed_output_directory(
            task["attempt_id"]
                .as_str()
                .context("producing Attempt missing")?
        )
    );
    assert_eq!(
        task["artifacts"],
        serde_json::json!([{"artifact_id": managed_id, "paths": [&output_path]}])
    );
    let managed_artifact = services.operator(&["get", "artifact", managed_id]).await?;
    assert_eq!(
        managed_artifact["files"]
            .as_array()
            .context("managed artifact files missing")?
            .len(),
        1
    );
    assert_eq!(managed_artifact["files"][0]["path"], output_path);
    let managed_download = directory.path().join("deliverable.txt");
    services
        .operator(&[
            "artifact",
            "download",
            managed_id,
            "--path",
            &output_path,
            "--output",
            managed_download
                .to_str()
                .context("fixture path is not UTF-8")?,
        ])
        .await?;
    assert_eq!(std::fs::read(&managed_download)?, b"managed Task output\n");
    assert_eq!(task["workspace_delivery"]["changed_files"], 0);
    assert!(success(git(&["status", "--porcelain"])).await?.is_empty());
    declared_output_cases(&services, directory.path(), &worker).await?;
    let remote = directory.path().join("verified-remote.git");
    let remote_path = remote.to_str().context("Git fixture path is not UTF-8")?;
    success(git(&["init", "--bare", "--quiet", remote_path])).await?;
    success(git(&["remote", "add", "origin", remote_path])).await?;
    success(git(&[
        "push",
        "--quiet",
        "origin",
        "HEAD:refs/heads/advertised",
    ]))
    .await?;
    verify_git_output_case(&services, directory.path(), &worker, "reference", true).await?;
    verify_git_output_case(&services, directory.path(), &worker, "capture", false).await?;
    success(git(&["remote", "remove", "origin"])).await?;
    verify_git_output_case(&services, directory.path(), &worker, "reference", false).await?;
    services.stop().await
}

async fn verify_git_output_case(
    services: &LanguageServices,
    directory: &Path,
    worker: &impl Fn() -> Command,
    mode: &str,
    advertised: bool,
) -> Result<()> {
    let policy = directory.join("git-output-policy.json");
    std::fs::write(
        &policy,
        serde_json::to_vec(&serde_json::json!({
            "include": ["*.txt"],
            "required": ["empty.txt", "report.txt"],
            "git": mode,
        }))?,
    )?;
    let session = format!("git-output-{mode}-{advertised}");
    let submitted = services
        .operator(&[
            "task",
            "submit",
            "--tag",
            "producer",
            "--session",
            &session,
            "--outputs",
            policy.to_str().context("policy path is not UTF-8")?,
            "git-output-fixture",
        ])
        .await?;
    let task_id = submitted["task_id"].as_str().context("Task ID missing")?;
    success(worker()).await?;
    let task = services.operator(&["get", "task", task_id]).await?;
    assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
    let selection = &task["artifacts"][0];
    let expected = if advertised {
        serde_json::json!(["report.txt", "supertag-git-output.json"])
    } else {
        serde_json::json!(["empty.txt", "report.txt", "supertag-git-output.json"])
    };
    assert_eq!(selection["paths"], expected);
    let artifact = selection["artifact_id"]
        .as_str()
        .context("artifact ID missing")?;
    let download = |path: &str| directory.join(format!("{session}-{path}"));
    for path in ["report.txt", "supertag-git-output.json"] {
        services
            .operator(&[
                "artifact",
                "download",
                artifact,
                "--path",
                path,
                "--output",
                download(path)
                    .to_str()
                    .context("download path is not UTF-8")?,
            ])
            .await?;
    }
    assert_eq!(
        std::fs::read(download("report.txt"))?,
        b"dirty tracked output\n"
    );
    let snapshot: Value =
        serde_json::from_slice(&std::fs::read(download("supertag-git-output.json"))?)?;
    assert_eq!(snapshot["kind"], "selected-git-snapshot");
    assert_eq!(snapshot["deleted"], serde_json::json!(["removed.txt"]));
    assert_eq!(
        snapshot["paths"],
        serde_json::json!(["empty.txt", "report.txt"])
    );
    assert_eq!(snapshot["head"], task["workspace_delivery"]["start_commit"]);
    assert_eq!(snapshot["head"], snapshot["baseCommit"]);
    assert_eq!(snapshot["partial"], true);
    assert_eq!(snapshot["remoteDurable"], advertised);
    if advertised {
        assert_eq!(
            snapshot["referencedPaths"],
            serde_json::json!(["empty.txt"])
        );
        assert!(
            snapshot["remote"]
                .as_str()
                .is_some_and(|remote| remote.starts_with("file://"))
        );
    } else {
        assert_eq!(snapshot["referencedPaths"], serde_json::json!([]));
        assert!(snapshot["remote"].is_null());
    }
    Ok(())
}

async fn declared_output_cases(
    services: &LanguageServices,
    directory: &Path,
    worker: impl Fn() -> Command,
) -> Result<()> {
    let policy_file = directory.join("output-policy.json");
    let file = policy_file
        .to_str()
        .context("policy fixture path is not UTF-8")?;
    for (session, required, git, expected) in [
        (
            "declared",
            "deliverables/**/deliverable.txt",
            "capture",
            "TASK_STATE_SUCCEEDED",
        ),
        (
            "missing",
            "deliverables/never-created.txt",
            "capture",
            "TASK_STATE_FAILED",
        ),
        ("tracked", "report.txt", "ignore", "TASK_STATE_FAILED"),
        ("mixed-tracked", "**/*.txt", "ignore", "TASK_STATE_FAILED"),
    ] {
        std::fs::write(
            &policy_file,
            serde_json::to_vec(&serde_json::json!({
                "directory": "deliverables",
                "required": [required],
                "include": [],
                "git": git,
                "maxBytes": 64,
            }))?,
        )?;
        let accepted = services
            .operator(&[
                "task",
                "submit",
                "--tag",
                "producer",
                "--session",
                session,
                "--outputs",
                file,
                "capture-evidence",
            ])
            .await?;
        let task_id = accepted["task_id"].as_str().context("Task ID missing")?;
        success(worker()).await?;
        let result = services.operator(&["get", "task", task_id]).await?;
        assert_eq!(result["state"], expected, "{result}");
        if expected == "TASK_STATE_FAILED" {
            assert_eq!(result["result"], "Required Task output is missing");
            assert_eq!(result["artifacts"], serde_json::json!([]));
        } else {
            let selection = &result["artifacts"][0];
            assert_eq!(result["workspace_delivery"]["changed_files"], 0);
            assert_eq!(
                selection["paths"],
                serde_json::json!(["deliverables/deliverable.txt"])
            );
            let artifact_id = selection["artifact_id"]
                .as_str()
                .context("artifact ID missing")?;
            let destination = directory.join("declared.txt");
            services
                .operator(&[
                    "artifact",
                    "download",
                    artifact_id,
                    "--path",
                    "deliverables/deliverable.txt",
                    "--output",
                    destination.to_str().context("fixture path is not UTF-8")?,
                ])
                .await?;
            assert_eq!(std::fs::read(destination)?, b"managed Task output\n");
        }
    }
    Ok(())
}

async fn claude_sdk_approves_one_workstream_post_and_delivers_one_mailbox_turn(
    database: String,
) -> Result<()> {
    let Some(interpreter) = crate::prerequisites::env("node", "SUPERTAG_RUST_TEST_NODE")? else {
        return Ok(());
    };
    let entry = repo_path("packages/runtime/harnesses/claude-code/dist/rust-adapter/entry.js")?;
    let directory = tempfile::tempdir()?;
    let native = claude_fixture(directory.path())?;
    let services = LanguageServices::start(directory.path(), &database).await?;
    let worker = |state: &str| {
        let mut host = services.worker(
            "claude-code",
            &directory.path().join(state),
            Path::new(&interpreter),
            &entry,
        );
        host.arg("--claude-path")
            .arg(&native)
            .env("ANTHROPIC_API_KEY", "fixture-provider-key");
        host
    };
    services
        .operator(&[
            "tag",
            "put",
            "claude",
            "--harness",
            "claude-code",
            "--instructions",
            "Coordinate the release.",
            "--require-workstream-approval",
        ])
        .await?;
    services
        .operator(&[
            "tag",
            "put",
            "recipient",
            "--harness",
            "claude-code",
            "--instructions",
            "Read the addressed update.",
        ])
        .await?;
    services
        .operator(&[
            "team",
            "create",
            "release",
            "--member",
            "claude",
            "--member",
            "recipient",
        ])
        .await?;
    let source = services
        .operator(&[
            "task",
            "submit",
            "--tag",
            "claude",
            "--session",
            "release-session",
            "Process fixture Workstream approval",
        ])
        .await?;
    let source_id = source["task_id"].as_str().context("source Task ID")?;
    success(worker("first-host")).await?;
    let first = services.operator(&["get", "task", source_id]).await?;
    assert_eq!(first["state"], "TASK_STATE_SUCCEEDED", "{first}");
    assert_eq!(
        first["result"],
        "fixture first turn awaiting Workstream approval"
    );
    let waiting = services
        .operator(&["inbox", "list", "--kind", "approval"])
        .await?;
    assert_eq!(
        waiting["items"].as_array().context("approval items")?.len(),
        1
    );
    let item = &waiting["items"][0];
    assert_eq!(item["task_id"], source_id);
    assert_eq!(item["approval"]["action"], "workstream:post");
    assert_eq!(item["approval"]["resource"], "release");
    let approval_id = item["approval"]["approval_id"]
        .as_str()
        .context("approval ID")?;
    assert_eq!(
        services.operator(&["team", "posts", "release"]).await?["posts"],
        serde_json::json!([])
    );
    assert_eq!(
        services.operator(&["mailbox", "recipient"]).await?["messages"],
        serde_json::json!([])
    );
    let exact = services
        .operator(&["inbox", "approval", approval_id])
        .await?;
    let body = "The SDK fixture verified the release.";
    assert_eq!(exact["arguments"]["body"], body);
    assert_eq!(
        exact["arguments"]["to_tag_ids"],
        serde_json::json!(["recipient"])
    );

    let approve = [
        "inbox",
        "approve",
        approval_id,
        "--operation-id",
        "operator-once",
    ];
    let decision = services.operator(&approve).await?;
    assert_eq!(decision["scope"], "once");
    assert_eq!(services.operator(&approve).await?, decision);
    let continued_id = decision["continuation_task_id"]
        .as_str()
        .context("continuation Task ID")?;
    assert_ne!(source_id, continued_id);
    success(worker("second-host")).await?;
    let continued = services.operator(&["get", "task", continued_id]).await?;
    assert_eq!(continued["state"], "TASK_STATE_SUCCEEDED", "{continued}");
    assert_eq!(continued["session_id"], first["session_id"]);
    assert_eq!(continued["result"], "fixture resumed and posted one update");
    let workstream = services.operator(&["team", "posts", "release"]).await?;
    assert_eq!(
        workstream["posts"]
            .as_array()
            .context("Workstream posts")?
            .len(),
        1
    );
    let post = &workstream["posts"][0];
    assert_eq!(post["source_task_id"], continued_id);
    assert_eq!(post["body"], body);
    let approval = services
        .operator(&["inbox", "approval", approval_id])
        .await?;
    assert!(approval["consumed_at_ms"].is_i64());

    success(worker("recipient-host")).await?;
    let mailbox = services.operator(&["mailbox", "recipient"]).await?;
    assert_eq!(
        mailbox["messages"]
            .as_array()
            .context("Mailbox messages")?
            .len(),
        1
    );
    let message = &mailbox["messages"][0];
    assert_eq!(message["workstream_post_id"], post["post_id"]);
    assert_eq!(message["sender_tag_id"], "claude");
    assert_eq!(message["recipient_tag_id"], "recipient");
    assert_eq!(message["state"], "TAG_MESSAGE_STATE_HANDLED");
    let mail_task = message["task_id"].as_str().context("Mailbox Task ID")?;
    let mail = services.operator(&["get", "task", mail_task]).await?;
    assert_eq!(mail["state"], "TASK_STATE_SUCCEEDED", "{mail}");
    assert_eq!(mail["session_id"], "inbox:recipient");
    assert_eq!(mail["result"], "SDK fixture handled the addressed post");
    services.stop().await
}

async fn claude_sdk_applies_accepted_usd_budget_and_records_the_stop_usage(
    database: String,
) -> Result<()> {
    let Some(interpreter) = crate::prerequisites::env("node", "SUPERTAG_RUST_TEST_NODE")? else {
        return Ok(());
    };
    let entry = repo_path("packages/runtime/harnesses/claude-code/dist/rust-adapter/entry.js")?;
    let directory = tempfile::tempdir()?;
    let native = claude_fixture(directory.path())?;
    let services = LanguageServices::start(directory.path(), &database).await?;
    services
        .operator(&[
            "tag",
            "put",
            "claude",
            "--instructions",
            "Budgeted native work",
            "--harness",
            "claude-code",
            "--allow",
            "files:read",
        ])
        .await?;
    let accepted = services
        .operator(&[
            "task",
            "submit",
            "--tag",
            "claude",
            "--session",
            "budgeted-turn",
            "--max-reported-cost-minor",
            "50",
            "--reported-cost-currency",
            "USD",
            "budget-overrun",
        ])
        .await?;
    let id = accepted["task_id"].as_str().context("accepted Task ID")?;
    assert_eq!(
        accepted["execution_limits"]["max_reported_cost"],
        serde_json::json!({"currency":"USD","amount_minor":50})
    );
    let mut host = services.worker(
        "claude-code",
        &directory.path().join("budget-host"),
        Path::new(&interpreter),
        &entry,
    );
    host.arg("--claude-path")
        .arg(&native)
        .env("ANTHROPIC_API_KEY", "fixture-provider-key");
    success(host).await?;
    let stopped = services.operator(&["get", "task", id]).await?;
    assert_eq!(stopped["state"], "TASK_STATE_FAILED", "{stopped}");
    assert!(
        stopped["result"]
            .as_str()
            .is_some_and(|reason| reason.to_lowercase().contains("budget")),
        "{stopped}"
    );
    let usage = last_usage(&services, &stopped).await?;
    assert_eq!(
        usage["reported_cost"],
        serde_json::json!({"currency":"USD","amount_minor":51,"estimated":false})
    );
    assert!(
        usage["total_tokens"]
            .as_u64()
            .is_some_and(|total| total > 0)
    );
    services.stop().await
}
