#[path = "support/children.rs"]
mod children;
use children::reaped;
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[macro_use]
#[path = "support/database.rs"]
mod database;
#[path = "support/holding_host.rs"]
mod holding_host;

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
    let mut command = reaped(Command::new(BINARY));
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
test -z "${SUPERTAG_HOST_TOKEN:-}${SUPERTAG_BOOTSTRAP_HOST_TOKEN:-}${SUPERTAG_GATEWAY_CREDENTIAL:-}${SUPERTAG_OPERATOR_TOKEN:-}${PYTHONPATH:-}${CODEX_API_KEY:-}"
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
test "$4" = "3600"
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
    python_agents_sdk_resumes_the_session_on_its_holder;
    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_NODE and a built Claude Code language adapter"]
    claude_code_sdk_resumes_on_its_holder_and_starts_fresh_elsewhere;
    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_NODE and a built Claude Code language adapter"]
    claude_code_sdk_resumes_from_its_tags_volume_on_any_host;
    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_NODE and a built Claude Code language adapter"]
    volume_journey_continues_a_session_on_another_host_after_the_first_is_gone;
    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_NODE and a built Claude Code language adapter"]
    claude_keeps_native_memory_on_its_host_across_tasks;
    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_NODE and a built Claude Code language adapter"]
    claude_keeps_native_memory_on_its_tags_volume_across_hosts;
    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_NODE and a built Claude Code language adapter"]
    claude_runs_commands_only_with_the_hosts_unsandboxed_opt_in;
    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_NODE and a built Claude Code language adapter"]
    claude_runs_remote_workspace_commands_in_the_sandbox_without_the_opt_in;
    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_NODE, a built Claude Code language adapter and local-vm provider, and SUPERTAG_TEST_LOCAL_VM=1 with Docker"]
    claude_runs_commands_in_a_local_vm_container;
    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_NODE and a built Claude Code language adapter"]
    claude_keeps_its_remote_task_output;
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
    let gateway_token = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
    let operator_token = Uuid::new_v4().to_string();
    let host_token = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
    let mut control = command(&["control-plane"]);
    control
        .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &gateway_token)
        .env("SUPERTAG_GATEWAY_CREDENTIAL", &gateway_token)
        .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
        .env("SUPERTAG_DATABASE_URL", &database);
    control.env("SUPERTAG_OPERATOR_TOKEN", &operator_token);
    let (mut control, public) = service(control).await?;

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
            "--control-plane",
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
            .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &gateway_token)
            .env("SUPERTAG_GATEWAY_CREDENTIAL", &gateway_token)
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
    control.kill().await?;
    Ok(())
}

struct LanguageServices {
    control: Child,
    public: String,
    operator_token: String,
    host_token: String,
}

impl LanguageServices {
    async fn start(_directory: &Path, database: &str) -> Result<Self> {
        let gateway_token =
            supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
        let operator_token = Uuid::new_v4().to_string();
        let host_token = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
        let mut control = command(&["control-plane"]);
        control
            .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &gateway_token)
            .env("SUPERTAG_GATEWAY_CREDENTIAL", &gateway_token)
            .env("SUPERTAG_OPERATOR_TOKEN", &operator_token)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
            .env("SUPERTAG_DATABASE_URL", database);
        let (control, public) = service(control).await?;
        Ok(Self {
            control,
            public,
            operator_token,
            host_token,
        })
    }

    async fn operator(&self, args: &[&str]) -> Result<Value> {
        operator(args, &self.public, &self.operator_token).await
    }

    /// The bytes of `path` in `artifact`, read where the test's Worker Hosts keep them under
    /// `directory`: the Control Plane passes no files to clients.
    async fn held_file(&self, directory: &Path, artifact: &str, path: &str) -> Result<Vec<u8>> {
        let manifest = self.operator(&["get", "artifact", artifact]).await?;
        let file = manifest["files"]
            .as_array()
            .and_then(|files| files.iter().find(|file| file["path"] == path))
            .with_context(|| format!("{artifact} has no file {path}: {manifest}"))?;
        holding_host::held_bytes(
            directory,
            file["blob"]["sha256"].as_str().context("file digest")?,
        )
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
            "--control-plane",
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
        repo_path("harnesses/claude-code/fixtures/rust-native-claude.mjs")?,
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
    let entry = repo_path("harnesses/claude-code/dist/rust-adapter/entry.js")?;
    let directory = tempfile::tempdir()?;
    let native = claude_fixture(directory.path())?;
    let services = LanguageServices::start(directory.path(), &database).await?;
    let journal = directory.path().join("mcp-provider.jsonl");
    let mut provider = reaped(Command::new(&node));
    provider
        .arg(repo_path(
            "harnesses/claude-code/fixtures/rust-mcp-provider.mjs",
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
        "headerFile":{"X-Catalog-Key":directory.path().join("catalog-key")},
        "resources":{"tools":{"list_docs":mapping,"publish":mapping}}
    }]});
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    // This header lives in an owner-only file the Worker Host reads at each Attempt; the
    // provider's mirror echoes it, and the Worker Host must withhold that result.
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(directory.path().join("catalog-key"))?
        .write_all(b"synthetic-catalog-credential-from-file\n")?;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&catalog)?
        .write_all(config.to_string().as_bytes())?;
    let permissions = directory.path().join("mcp-grants.json");
    std::fs::write(&permissions, serde_json::json!({
        "setId":"mcp-grants", "name":"mcp-grants", "approvers":["operator:local"],
        "permissions":[
            {"target":"mcp","action":"catalog/list_*","resource":"repository:acme/docs"},
            {"target":"mcp","action":"catalog/publish"},
            {"target":"mcp","action":"catalog/publish","resource":"repository:acme/docs","approvalRequired":true}
        ]
    }).to_string())?;
    let role = directory.path().join("mcp-role.json");
    std::fs::write(&role, serde_json::json!({
        "roleId":"mcp-role", "name":"mcp-role", "purpose":"Read the catalog", "permissionSets":["mcp-grants"]
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
            "permission-set",
            "put",
            permissions.to_str().context("permission set path")?,
        ])
        .await?;
    services
        .operator(&["role", "put", role.to_str().context("role path")?])
        .await?;
    services
        .operator(&["role-assignment", "create", "mcp-role", "mcp-reader"])
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
        .operator(&["get", "inbox-items", "--kind", "approval"])
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
    let exact = services.operator(&["get", "approval", exact_id]).await?;
    assert_eq!(
        exact["arguments"],
        serde_json::json!({"owner":"acme","repo":"docs"})
    );
    assert_eq!(exact["action"], "mcp:catalog/publish");
    services
        .operator(&[
            "approval",
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
            "approval",
            "approve",
            exact_id,
            "--operation-id",
            "approve-exact-mcp",
        ])
        .await?;
    let resumed_id = decision["continuation_task_id"]
        .as_str()
        .context("MCP continuation Task")?;
    // The host that wrote the Session's checkpoint resumes it; another host would start fresh.
    success(catalog_worker("catalog-host")).await?;
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
    let exact = services.operator(&["get", "approval", exact_id]).await?;
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
    let entry = repo_path("harnesses/claude-code/dist/rust-adapter/entry.js")?;
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
            repo_path("harnesses/claude-code/fixtures/rust-mcp-stdio-provider.mjs")?
                .to_str()
                .context("fixture path")?,
            journal.to_str().context("journal path")?,
        ],
        "env":{
            "CATALOG_TOKEN":{"file":directory.join("catalog-token")},
            "CATALOG_ENV_TOKEN":"CATALOG_MCP_AUTH",
        },
        "resources":{"tools":{"list_docs":mapping,"publish":mapping}}
    }]});
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    // A credential file the Worker Host reads at each launch; only its path is in the catalog.
    // The server's mirror echoes it, and the Worker Host must withhold that result.
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(directory.join("catalog-token"))?
        .write_all(b"synthetic-catalog-credential\n")?;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&catalog)?
        .write_all(config.to_string().as_bytes())?;
    let permissions = directory.join("mcp-grants.json");
    std::fs::write(&permissions, serde_json::json!({
        "setId":"mcp-grants", "name":"mcp-grants", "approvers":["operator:local"],
        "permissions":[
            {"target":"mcp","action":"catalog/list_*","resource":"repository:acme/docs"},
            {"target":"mcp","action":"catalog/publish"},
            {"target":"mcp","action":"catalog/publish","resource":"repository:acme/docs","approvalRequired":true}
        ]
    }).to_string())?;
    let role = directory.join("mcp-role.json");
    std::fs::write(&role, serde_json::json!({
        "roleId":"mcp-role", "name":"mcp-role", "purpose":"Read the catalog", "permissionSets":["mcp-grants"]
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
            "permission-set",
            "put",
            permissions.to_str().context("permission set path")?,
        ])
        .await?;
    services
        .operator(&["role", "put", role.to_str().context("role path")?])
        .await?;
    services
        .operator(&["role-assignment", "create", "mcp-role", "mcp-reader"])
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
            .env("CATALOG_MCP_AUTH", "synthetic-env-credential")
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
        .operator(&["get", "inbox-items", "--kind", "approval"])
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
            "approval",
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
            "approval",
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
        // The host that wrote the Session's checkpoint, so the continuation resumes it.
        &directory.join("catalog-host"),
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
    let exact = services.operator(&["get", "approval", exact_id]).await?;
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
        assert_eq!(environment["CATALOG_ENV_TOKEN"], "synthetic-env-credential");
        for key in environment.keys() {
            assert!(
                matches!(
                    key.as_str(),
                    "CATALOG_TOKEN"
                        | "CATALOG_ENV_TOKEN"
                        | "PATH"
                        | "HOME"
                        | "__CF_USER_TEXT_ENCODING"
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

async fn python_agents_sdk_resumes_the_session_on_its_holder(database: String) -> Result<()> {
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

    for expected in [
        "SDK fixture completed first Task.",
        "SDK fixture resumed the Session.",
    ] {
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
        // The host that ran the first turn holds the Session checkpoint, so it resumes it.
        let mut host = services.worker(
            "openai-agents",
            &directory.path().join("host"),
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

/// A Tag that names a file Volume keeps its Session checkpoints on it: the first turn's host
/// writes the checkpoint there, and another host that maps the Volume, with storage of its own,
/// resumes the next turn from it. Neither host keeps a copy in its own storage.
async fn claude_code_sdk_resumes_from_its_tags_volume_on_any_host(database: String) -> Result<()> {
    let Some(interpreter) = crate::prerequisites::env("node", "SUPERTAG_RUST_TEST_NODE")? else {
        return Ok(());
    };
    let entry = repo_path("harnesses/claude-code/dist/rust-adapter/entry.js")?;
    let directory = tempfile::tempdir()?;
    let root = directory.path().canonicalize()?;
    let native = claude_fixture(&root)?;
    let vault = root.join("vault");
    std::fs::create_dir(&vault)?;
    std::fs::set_permissions(&vault, std::fs::Permissions::from_mode(0o700))?;
    let services = LanguageServices::start(&root, &database).await?;
    services
        .operator(&[
            "volume",
            "put",
            "vault",
            "--source",
            &format!("file://{}", vault.display()),
            "--operation-id",
            "register-vault",
        ])
        .await?;
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
            "--volume",
            "vault",
        ])
        .await?;
    for (state, expected) in [
        ("first-host", "fixture first turn"),
        ("second-host", "fixture resumed turn"),
    ] {
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
            &root.join(state),
            Path::new(&interpreter),
            &entry,
        );
        host.arg("--claude-path")
            .arg(&native)
            .arg("--volume")
            .arg(format!("vault={}", vault.display()))
            .env("ANTHROPIC_API_KEY", "fixture-provider-key");
        success(host).await?;
        let task = services.operator(&["get", "task", task_id]).await?;
        assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
        assert_eq!(task["result"], expected);
    }
    let tag = format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(b"claude"));
    let session = format!(
        "{:x}",
        <sha2::Sha256 as sha2::Digest>::digest(b"same-session")
    );
    let held = |base: &Path| base.join(format!("tags/{tag}/sessions/{session}/checkpoint"));
    assert!(
        std::fs::read_dir(held(&vault))?.next().is_some(),
        "the checkpoint is on the Volume"
    );
    for state in ["first-host", "second-host"] {
        assert!(
            !held(&root.join(state).join("artifacts")).exists(),
            "{state} keeps no copy of a Volume-held checkpoint"
        );
    }
    services.stop().await
}

/// The Volume-backed journey. A Tag names a file Volume. Its first turn, on host A, leaves a
/// Task output: the capture's copy and the Session checkpoint both land on the Volume, and host
/// A keeps no checkpoint of its own. Host A then goes away with all its storage. Host B, which
/// maps the same Volume, continues the Session from the checkpoint there, and once that turn
/// supersedes the first checkpoint, a host that maps the Volume deletes the old object.
async fn volume_journey_continues_a_session_on_another_host_after_the_first_is_gone(
    database: String,
) -> Result<()> {
    let Some(interpreter) = crate::prerequisites::env("node", "SUPERTAG_RUST_TEST_NODE")? else {
        return Ok(());
    };
    let entry = repo_path("harnesses/claude-code/dist/rust-adapter/entry.js")?;
    let directory = tempfile::tempdir()?;
    let root = directory.path().canonicalize()?;
    let native = claude_fixture(&root)?;
    let vault = root.join("vault");
    std::fs::create_dir(&vault)?;
    std::fs::set_permissions(&vault, std::fs::Permissions::from_mode(0o700))?;
    let source = root.join("source");
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
    std::fs::write(source.join("README.md"), b"Volume journey\n")?;
    success(git(&["add", "README.md"])).await?;
    success(git(&["commit", "--quiet", "-m", "Fixture source"])).await?;
    let base = String::from_utf8(success(git(&["rev-parse", "HEAD"])).await?)?;
    let services = LanguageServices::start(&root, &database).await?;
    services
        .operator(&[
            "volume",
            "put",
            "vault",
            "--source",
            &format!("file://{}", vault.display()),
            "--operation-id",
            "register-vault",
        ])
        .await?;
    services
        .operator(&[
            "tag",
            "put",
            "journey",
            "--instructions",
            "Keep your work on the Volume.",
            "--harness",
            "claude-code",
            "--allow",
            "files:read",
            "--allow",
            "files:write",
            "--workspace-id",
            "journey",
            "--workspace-base",
            base.trim(),
            "--volume",
            "vault",
        ])
        .await?;
    let host = |state: &str| {
        let mut host = services.worker(
            "claude-code",
            &root.join(state),
            Path::new(&interpreter),
            &entry,
        );
        host.arg("--claude-path")
            .arg(&native)
            .arg("--volume")
            .arg(format!("vault={}", vault.display()))
            .arg("--workspace-id")
            .arg("journey")
            .arg("--workspace-source")
            .arg(&source)
            .env("ANTHROPIC_API_KEY", "fixture-provider-key");
        host
    };
    let shared = &services;
    let turn = |prompt: &'static str| async move {
        shared
            .operator(&[
                "task",
                "submit",
                "--tag",
                "journey",
                "--session",
                "journey-session",
                prompt,
            ])
            .await
    };
    let tag = format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(b"journey"));
    let session = format!(
        "{:x}",
        <sha2::Sha256 as sha2::Digest>::digest(b"journey-session")
    );
    let checkpoints = |base: &Path| -> Result<Vec<String>> {
        let directory = base.join(format!("tags/{tag}/sessions/{session}/checkpoint"));
        if !directory.exists() {
            return Ok(vec![]);
        }
        let mut names = std::fs::read_dir(directory)?
            .map(|entry| Ok(entry?.file_name().to_string_lossy().into_owned()))
            .collect::<Result<Vec<_>>>()?;
        names.sort();
        Ok(names)
    };

    // Host A's turn leaves a Task output; the capture and the checkpoint land on the Volume.
    let first = turn("volume-journey-output").await?;
    let first_id = first["task_id"].as_str().context("Task ID missing")?;
    success(host("host-a")).await.context("host A turn")?;
    let first = services.operator(&["get", "task", first_id]).await?;
    assert_eq!(first["state"], "TASK_STATE_SUCCEEDED", "{first}");
    assert_eq!(first["result"], "fixture first turn");
    let copies = services
        .operator(&["get", "volume-copies", "--volume-id", "vault"])
        .await?;
    let copies = copies["copies"].as_array().context("no copies")?;
    let copy = copies
        .iter()
        .find(|copy| {
            copy["file"]["path"]
                .as_str()
                .is_some_and(|path| path.ends_with("journey.txt"))
        })
        .with_context(|| format!("the Task output has no Volume copy: {copies:?}"))?;
    assert_eq!(
        copy["state"], "ARTIFACT_VOLUME_COPY_STATE_VERIFIED",
        "{copy}"
    );
    assert_eq!(copy["host_attested"], true, "{copy}");
    let key = copy["storage_key"].as_str().context("no storage key")?;
    assert!(key.starts_with(&format!("tags/{tag}/attempts/")), "{key}");
    assert_eq!(
        std::fs::read(vault.join(key))?,
        b"kept on the Tag's Volume\n"
    );
    let kept = checkpoints(&vault)?;
    assert_eq!(
        kept.len(),
        1,
        "the first checkpoint is on the Volume: {kept:?}"
    );
    assert!(kept[0].ends_with(".bin"), "{kept:?}");
    assert!(
        checkpoints(&root.join("host-a").join("artifacts"))?.is_empty(),
        "host A keeps no copy of a Volume-held checkpoint"
    );

    // Host A goes away with everything it held.
    std::fs::remove_dir_all(root.join("host-a"))?;

    // Host B continues the Session from the Volume: the fixture checks the resumed transcript.
    let second = turn("Continue this Session").await?;
    let second_id = second["task_id"].as_str().context("Task ID missing")?;
    success(host("host-b")).await.context("host B turn")?;
    let second = services.operator(&["get", "task", second_id]).await?;
    assert_eq!(second["state"], "TASK_STATE_SUCCEEDED", "{second}");
    assert_eq!(second["result"], "fixture resumed turn");
    // The capture outlives host A on the Volume.
    assert_eq!(
        std::fs::read(vault.join(key))?,
        b"kept on the Tag's Volume\n"
    );

    // The second checkpoint superseded the first; a host that maps the Volume deletes it.
    let mut sweeper = services.serving_worker(
        "claude-code",
        &root.join("host-c"),
        Path::new(&interpreter),
        &entry,
    );
    sweeper
        .arg("--claude-path")
        .arg(&native)
        .arg("--volume")
        .arg(format!("vault={}", vault.display()))
        .env("ANTHROPIC_API_KEY", "fixture-provider-key")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut sweeper = sweeper.spawn()?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let remaining = loop {
        let remaining = checkpoints(&vault)?;
        if !remaining.contains(&kept[0]) || tokio::time::Instant::now() > deadline {
            break remaining;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    };
    sweeper.kill().await?;
    assert_eq!(
        remaining.len(),
        1,
        "only the current checkpoint stays on the Volume: {remaining:?}"
    );
    assert_ne!(
        remaining[0], kept[0],
        "the superseded checkpoint was deleted"
    );
    services.stop().await
}

/// A Tag that names a Volume keeps Claude Code's auto-memory there: one host's turn writes it,
/// another host that maps the Volume reads it in a later Session, neither keeps a copy in its own
/// storage, and an operator's reset drops it.
async fn claude_keeps_native_memory_on_its_tags_volume_across_hosts(
    database: String,
) -> Result<()> {
    let Some(interpreter) = crate::prerequisites::env("node", "SUPERTAG_RUST_TEST_NODE")? else {
        return Ok(());
    };
    let entry = repo_path("harnesses/claude-code/dist/rust-adapter/entry.js")?;
    let directory = tempfile::tempdir()?;
    let root = directory.path().canonicalize()?;
    let native = claude_fixture(&root)?;
    let vault = root.join("vault");
    std::fs::create_dir(&vault)?;
    std::fs::set_permissions(&vault, std::fs::Permissions::from_mode(0o700))?;
    let services = LanguageServices::start(&root, &database).await?;
    services
        .operator(&[
            "volume",
            "put",
            "vault",
            "--source",
            &format!("file://{}", vault.display()),
            "--operation-id",
            "register-vault",
        ])
        .await?;
    services
        .operator(&[
            "tag",
            "put",
            "keeper",
            "--instructions",
            "Keep what matters.",
            "--harness",
            "claude-code",
            "--allow",
            "files:read",
            "--volume",
            "vault",
        ])
        .await?;
    let run = |state: &'static str, prompt: &'static str| {
        let services = &services;
        let (root, vault) = (root.clone(), vault.clone());
        let (interpreter, entry, native) = (interpreter.clone(), entry.clone(), native.clone());
        async move {
            // Each turn is its own Session: native memory is the Tag's, not one Session's.
            let session = Uuid::new_v4().to_string();
            let task = services
                .operator(&[
                    "task",
                    "submit",
                    "--tag",
                    "keeper",
                    "--session",
                    &session,
                    prompt,
                ])
                .await?;
            let task_id = task["task_id"].as_str().context("Task ID")?.to_owned();
            let mut host = services.worker(
                "claude-code",
                &root.join(state),
                Path::new(&interpreter),
                &entry,
            );
            host.arg("--claude-path")
                .arg(&native)
                .arg("--volume")
                .arg(format!("vault={}", vault.display()))
                .env("ANTHROPIC_API_KEY", "fixture-provider-key");
            success(host).await?;
            let task = services.operator(&["get", "task", &task_id]).await?;
            assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
            anyhow::Ok(task["result"].as_str().unwrap_or_default().to_owned())
        }
    };
    let written: Value = serde_json::from_str(&run("first-host", "remember-native").await?)?;
    assert_eq!(written["memoryWrite"], true, "{written}");
    assert!(
        run("second-host", "recall-native")
            .await?
            .contains("- fixture memory"),
        "another host that maps the Volume reads the memory"
    );
    let stores = services
        .operator(&["describe", "tag", "keeper", "--output", "json"])
        .await?["native_memory"]
        .clone();
    let on_volume = stores
        .as_array()
        .and_then(|stores| stores.iter().find(|store| store["volume_id"] == "vault"))
        .context("the store on the Volume is listed")?;
    assert_eq!(on_volume["revision"], 1, "{stores}");
    assert_eq!(on_volume["files"], 1, "{stores}");
    let tag = format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(b"keeper"));
    let objects = std::fs::read_dir(vault.join(format!("tags/{tag}/native-memory/claude-code")))?
        .next()
        .context("a store on the Volume")??
        .path()
        .join("objects");
    // One memory file and one manifest.
    assert_eq!(std::fs::read_dir(&objects)?.count(), 2);
    for state in ["first-host", "second-host"] {
        assert!(
            !root
                .join(state)
                .join(format!("artifacts/tags/{tag}/native-memory"))
                .exists(),
            "{state} keeps no copy of the Volume's store"
        );
    }
    services
        .operator(&["delete", "memory", "--native", "keeper"])
        .await?;
    assert_eq!(run("third-host", "recall-native").await?, "no memory");
    services.stop().await
}

async fn claude_code_sdk_resumes_on_its_holder_and_starts_fresh_elsewhere(
    database: String,
) -> Result<()> {
    let Some(interpreter) = crate::prerequisites::env("node", "SUPERTAG_RUST_TEST_NODE")? else {
        return Ok(());
    };
    let entry = repo_path("harnesses/claude-code/dist/rust-adapter/entry.js")?;
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

    // The host that ran the first turn holds the Session checkpoint and resumes it. A host without
    // the checkpoint's file (here a fresh state directory) starts the next turn fresh from the
    // recap: the Control Plane never holds checkpoint bytes.
    for (state, expected) in [
        ("host", "fixture first turn"),
        ("host", "fixture resumed turn"),
        ("fresh-host", "fixture first turn"),
    ] {
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
            &directory.path().join(state),
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

/// Claude Code's auto-memory lasts across a Tag's Tasks on one Worker Host: a read-only turn
/// writes it, the Control Plane records what the host holds, a later turn reads it, and an
/// operator's reset drops it before the next turn.
async fn claude_keeps_native_memory_on_its_host_across_tasks(database: String) -> Result<()> {
    let Some(interpreter) = crate::prerequisites::env("node", "SUPERTAG_RUST_TEST_NODE")? else {
        return Ok(());
    };
    let entry = repo_path("harnesses/claude-code/dist/rust-adapter/entry.js")?;
    let directory = tempfile::tempdir()?;
    let native = claude_fixture(directory.path())?;
    let services = LanguageServices::start(directory.path(), &database).await?;
    services
        .operator(&[
            "tag",
            "put",
            "keeper",
            "--instructions",
            "Keep what matters.",
            "--harness",
            "claude-code",
            "--allow",
            "files:read",
        ])
        .await?;
    let run = |prompt: &'static str| {
        let services = &services;
        let state = directory.path().join("host");
        let storage = directory.path().join("shared-storage");
        let interpreter = interpreter.clone();
        let entry = entry.clone();
        let native = native.clone();
        async move {
            // Each turn is its own Session: native memory is the Tag's, not one Session's.
            let session = Uuid::new_v4().to_string();
            let task = services
                .operator(&[
                    "task",
                    "submit",
                    "--tag",
                    "keeper",
                    "--session",
                    &session,
                    prompt,
                ])
                .await?;
            let task_id = task["task_id"]
                .as_str()
                .context("Task ID missing")?
                .to_owned();
            let mut host = services.worker("claude-code", &state, Path::new(&interpreter), &entry);
            // A configured artifact storage outside the state directory, as lanes of one host
            // share: the store must follow it.
            host.arg("--claude-path")
                .arg(&native)
                .arg("--artifact-directory")
                .arg(&storage)
                .env("ANTHROPIC_API_KEY", "fixture-provider-key");
            success(host).await?;
            let task = services.operator(&["get", "task", &task_id]).await?;
            assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
            anyhow::Ok(task["result"].as_str().unwrap_or_default().to_owned())
        }
    };
    let written = run("remember-native").await?;
    let written: Value =
        serde_json::from_str(&written).with_context(|| format!("turn result: {written}"))?;
    assert_eq!(written["memoryWrite"], true, "{written}");
    assert_eq!(written["workspaceWrite"], false, "{written}");
    let stores = services
        .operator(&["describe", "tag", "keeper", "--output", "json"])
        .await?["native_memory"]
        .clone();
    assert_eq!(stores.as_array().map(Vec::len), Some(1), "{stores}");
    assert_eq!(stores[0]["harness"], "claude-code", "{stores}");
    assert_eq!(stores[0]["revision"], 1, "{stores}");
    assert_eq!(stores[0]["files"], 1, "{stores}");
    // The host keeps the files in its artifact storage, which its lanes share, beside the
    // Tag's Session checkpoints.
    let tag = format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(b"keeper"));
    assert!(
        directory
            .path()
            .join(format!("shared-storage/tags/{tag}/native-memory"))
            .is_dir(),
        "the host keeps the files in its configured artifact storage"
    );
    assert!(
        !directory.path().join("host/artifacts/tags").exists(),
        "nothing goes to the default storage when another is configured"
    );

    assert!(run("recall-native").await?.contains("- fixture memory"));

    let reset = services
        .operator(&["delete", "memory", "--native", "keeper"])
        .await?;
    assert_eq!(reset["reset_generation"], 1, "{reset}");
    assert_eq!(run("recall-native").await?, "no memory");
    let stores = services
        .operator(&["describe", "tag", "keeper", "--output", "json"])
        .await?["native_memory"]
        .clone();
    assert_eq!(stores[0]["files"], 0, "{stores}");
    services.stop().await
}

/// Claude Code has no command sandbox, so a Task granted `commands:execute` waits for a host
/// that opted in with `--allow-unsandboxed-commands` and then runs its command as the host user.
async fn claude_runs_commands_only_with_the_hosts_unsandboxed_opt_in(
    database: String,
) -> Result<()> {
    let Some(interpreter) = crate::prerequisites::env("node", "SUPERTAG_RUST_TEST_NODE")? else {
        return Ok(());
    };
    let entry = repo_path("harnesses/claude-code/dist/rust-adapter/entry.js")?;
    let directory = tempfile::tempdir()?;
    let native = claude_fixture(directory.path())?;
    let services = LanguageServices::start(directory.path(), &database).await?;
    services
        .operator(&[
            "tag",
            "put",
            "runner",
            "--instructions",
            "Run the requested command.",
            "--harness",
            "claude-code",
            "--allow",
            "files:read",
            "--allow",
            "commands:execute",
        ])
        .await?;
    let task = services
        .operator(&[
            "task",
            "submit",
            "--tag",
            "runner",
            "--session",
            "commands",
            "run-command",
        ])
        .await?;
    let task_id = task["task_id"].as_str().context("Task ID missing")?;
    for (index, opt_in) in [false, true].into_iter().enumerate() {
        let mut host = services.worker(
            "claude-code",
            &directory.path().join(format!("host-{index}")),
            Path::new(&interpreter),
            &entry,
        );
        host.arg("--claude-path")
            .arg(&native)
            .env("ANTHROPIC_API_KEY", "fixture-provider-key");
        if opt_in {
            host.arg("--allow-unsandboxed-commands");
        }
        success(host).await?;
        let task = services.operator(&["get", "task", task_id]).await?;
        if opt_in {
            assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
            assert_eq!(task["result"], "fixture ran an admitted command", "{task}");
        } else {
            assert_eq!(task["state"], "TASK_STATE_QUEUED", "{task}");
            assert!(task["attempt_id"].is_null(), "{task}");
        }
    }
    services.stop().await
}

/// A Claude Code Task run on an E2B host through the Cursor suite's fixture provider.
struct ClaudeRemote {
    _directory: tempfile::TempDir,
    root: std::path::PathBuf,
    source: std::path::PathBuf,
    services: LanguageServices,
    task_id: String,
}

/// Runs one Claude Code Task, with `allow`ed actions and `prompt`, on an E2B host through the
/// fixture provider, and waits for the host to finish it. `None` when no Node runtime is set.
async fn claude_remote(
    database: &str,
    allow: &[&str],
    prompt: &str,
) -> Result<Option<ClaudeRemote>> {
    let Some(interpreter) = crate::prerequisites::env("node", "SUPERTAG_RUST_TEST_NODE")? else {
        return Ok(None);
    };
    let entry = repo_path("harnesses/claude-code/dist/rust-adapter/entry.js")?;
    let transport = repo_path("harnesses/sdk/dist/rust-workspace-provider/transport.js")?;
    let directory = tempfile::tempdir()?;
    let root = directory.path().canonicalize()?;
    let native = claude_fixture(&root)?;
    // The Cursor suite's provider helper fixture: it speaks the private provider protocol and
    // runs the sandbox's operations in a private checkout.
    let provider = root.join("remote-provider.mjs");
    std::fs::write(
        &provider,
        include_str!("../fixtures/cursor/remote-provider.mjs"),
    )?;
    std::fs::write(
        root.join("modules.json"),
        serde_json::to_vec(&serde_json::json!({ "providerTransport": transport }))?,
    )?;
    std::fs::write(root.join("provider-kind"), "e2b")?;
    let source = root.join("source");
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
    std::fs::write(source.join("workspace.txt"), b"initial-content\n")?;
    success(git(&["add", "workspace.txt"])).await?;
    success(git(&["commit", "--quiet", "-m", "Fixture source"])).await?;
    let base = String::from_utf8(success(git(&["rev-parse", "HEAD"])).await?)?;
    let services = LanguageServices::start(&root, database).await?;
    let mut tag = vec![
        "tag",
        "put",
        "runner",
        "--instructions",
        "Run the requested command.",
        "--harness",
        "claude-code",
    ];
    for action in allow {
        tag.extend(["--allow", action]);
    }
    tag.extend(["--workspace-id", "remote", "--workspace-base", base.trim()]);
    services.operator(&tag).await?;
    let task = services
        .operator(&[
            "task",
            "submit",
            "--tag",
            "runner",
            "--session",
            "remote",
            prompt,
        ])
        .await?;
    let task_id = task["task_id"]
        .as_str()
        .context("Task ID missing")?
        .to_owned();
    let mut host = services.worker(
        "claude-code",
        &root.join("host"),
        Path::new(&interpreter),
        &entry,
    );
    host.arg("--claude-path")
        .arg(&native)
        .arg("--workspace-id")
        .arg("remote")
        .arg("--workspace-source")
        .arg(&source)
        .arg("--e2b-workspace-provider")
        .arg(&interpreter)
        .arg("--e2b-workspace-provider-arg")
        .arg(&provider)
        .env("ANTHROPIC_API_KEY", "fixture-provider-key")
        .env("E2B_API_KEY", "synthetic-e2b-provider-key")
        .env("E2B_DOMAIN", "fixture.e2b.invalid")
        .env("SUPERTAG_E2B_TEMPLATE", "fixture-template");
    // The remote round trip (allocate, stage, capture, stop) outlasts WAIT under load.
    let output = timeout(Duration::from_secs(120), host.output()).await??;
    if !output.status.success() {
        let task = services.operator(&["get", "task", &task_id]).await?;
        let trace = std::fs::read_to_string(root.join("provider-calls.jsonl")).unwrap_or_default();
        anyhow::bail!(
            "{}; task: {task}; provider: {trace}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(Some(ClaudeRemote {
        _directory: directory,
        root,
        source,
        services,
        task_id,
    }))
}

/// Claude Code on an E2B host: no built-in tool, and its `workspace` tools reach the sandbox
/// through the Worker Host. The host never takes `--allow-unsandboxed-commands`; the command runs
/// in the provider's checkout and its write is delivered.
async fn claude_runs_remote_workspace_commands_in_the_sandbox_without_the_opt_in(
    database: String,
) -> Result<()> {
    let Some(remote) = claude_remote(
        &database,
        &["files:read", "files:write", "commands:execute"],
        "remote-command",
    )
    .await?
    else {
        return Ok(());
    };
    let task = remote
        .services
        .operator(&["get", "task", &remote.task_id])
        .await?;
    assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
    let result: Value = serde_json::from_str(task["result"].as_str().context("result")?)?;
    assert_eq!(
        result["listed"],
        serde_json::json!(["read", "write", "edit", "glob", "grep", "ls", "command"]),
        "{task}"
    );
    assert_eq!(result["isError"], false, "{task}");
    let trace: Vec<Value> = std::fs::read_to_string(remote.root.join("provider-calls.jsonl"))?
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()?;
    assert_eq!(
        trace
            .iter()
            .filter(|value| value["type"] == "command")
            .count(),
        1,
        "{trace:?}"
    );
    let capture = trace
        .iter()
        .find(|value| value["type"] == "capture-request")
        .context("provider never captured")?;
    assert_eq!(
        capture["actions"],
        serde_json::json!(["commands:execute", "files:read", "files:write"])
    );
    // The command ran in the provider's checkout, never in the host's source.
    assert!(!remote.source.join("command-output.txt").exists());
    remote.services.stop().await
}

/// Claude Code on an E2B host writes a file to its Task output directory through the sandbox's
/// workspace tools; Capture returns it and the Worker Host commits it as the Task's output, as for
/// Cursor.
async fn claude_keeps_its_remote_task_output(database: String) -> Result<()> {
    let Some(remote) =
        claude_remote(&database, &["files:read", "files:write"], "remote-output").await?
    else {
        return Ok(());
    };
    let task = remote
        .services
        .operator(&["get", "task", &remote.task_id])
        .await?;
    assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
    let result: Value = serde_json::from_str(task["result"].as_str().context("result")?)?;
    assert_eq!(result["isError"], false, "{task}");
    let attempt = task["attempt_id"].as_str().context("Attempt ID")?;
    let directory = supertag_protocol::artifacts::managed_output_directory(attempt);
    assert_eq!(result["directory"], directory.as_str(), "{task}");
    let path = format!("{directory}/report.md");
    let selections = task["artifacts"].as_array().context("Task artifacts")?;
    assert_eq!(selections.len(), 1, "{task}");
    assert_eq!(selections[0]["paths"], serde_json::json!([path]), "{task}");
    let artifact_id = selections[0]["artifact_id"]
        .as_str()
        .context("artifact ID")?;
    let artifact = remote
        .services
        .operator(&["get", "artifact", artifact_id])
        .await?;
    assert_eq!(
        artifact["summary"]["producer"]["task_id"],
        remote.task_id.as_str(),
        "{artifact}"
    );
    assert_eq!(
        artifact["summary"]["producer"]["harness"], "HARNESS_KIND_CLAUDE_CODE",
        "{artifact}"
    );
    // The file the native manager wrote in the sandbox, byte for byte.
    assert_eq!(artifact["files"][0]["path"], path.as_str(), "{artifact}");
    assert_eq!(
        artifact["files"][0]["blob"]["sha256"],
        format!(
            "{:x}",
            <sha2::Sha256 as sha2::Digest>::digest(b"remote evidence\n")
        ),
        "{artifact}"
    );
    remote.services.stop().await
}

/// Claude Code on a local-vm host: its commands run in a container on this machine's Docker,
/// as the container's unprivileged user with no network, and the container is gone afterwards.
async fn claude_runs_commands_in_a_local_vm_container(database: String) -> Result<()> {
    let Some(interpreter) = crate::prerequisites::env("node", "SUPERTAG_RUST_TEST_NODE")? else {
        return Ok(());
    };
    if std::env::var("SUPERTAG_TEST_LOCAL_VM").as_deref() != Ok("1") {
        return Ok(());
    }
    let docker = |args: &[&str]| {
        std::process::Command::new("docker")
            .args(args)
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
    };
    anyhow::ensure!(
        docker(&["info"]).is_ok_and(|output| output.status.success()),
        "SUPERTAG_TEST_LOCAL_VM=1 needs Docker"
    );
    let entry = repo_path("harnesses/claude-code/dist/rust-adapter/entry.js")?;
    let provider = repo_path("harnesses/environments/local-vm/dist/rust-provider/main.js")?;
    let directory = tempfile::tempdir()?;
    let root = directory.path().canonicalize()?;
    let native = claude_fixture(&root)?;
    let source = root.join("source");
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
    std::fs::write(source.join("workspace.txt"), b"initial-content\n")?;
    success(git(&["add", "workspace.txt"])).await?;
    success(git(&["commit", "--quiet", "-m", "Fixture source"])).await?;
    let base = String::from_utf8(success(git(&["rev-parse", "HEAD"])).await?)?;
    let services = LanguageServices::start(&root, &database).await?;
    services
        .operator(&[
            "tag",
            "put",
            "runner",
            "--instructions",
            "Run the requested command.",
            "--harness",
            "claude-code",
            "--allow",
            "files:read",
            "--allow",
            "files:write",
            "--allow",
            "commands:execute",
            "--workspace-id",
            "local",
            "--workspace-base",
            base.trim(),
        ])
        .await?;
    let task = services
        .operator(&[
            "task",
            "submit",
            "--tag",
            "runner",
            "--session",
            "local-vm",
            "local-vm-command",
        ])
        .await?;
    let task_id = task["task_id"].as_str().context("Task ID missing")?;
    let mut host = services.worker(
        "claude-code",
        &root.join("host"),
        Path::new(&interpreter),
        &entry,
    );
    host.arg("--claude-path")
        .arg(&native)
        .arg("--workspace-id")
        .arg("local")
        .arg("--workspace-source")
        .arg(&source)
        .arg("--local-vm-workspace-provider")
        .arg(&interpreter)
        .arg("--local-vm-workspace-provider-arg")
        .arg(&provider)
        .env("ANTHROPIC_API_KEY", "fixture-provider-key");
    // The provider runs the docker CLI from the host's PATH.
    let docker_directory = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .find(|directory| directory.join("docker").is_file())
        .context("docker is not on PATH")?;
    host.env(
        "PATH",
        format!("{}:/usr/bin:/bin", docker_directory.display()),
    );
    for name in ["HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"] {
        if let Some(value) = std::env::var_os(name) {
            host.env(name, value);
        }
    }
    // The first allocation on a machine builds the base image.
    let output = timeout(Duration::from_secs(1_200), host.output()).await??;
    let task = services.operator(&["get", "task", task_id]).await?;
    anyhow::ensure!(
        output.status.success(),
        "{}; task: {task}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
    let result: Value = serde_json::from_str(task["result"].as_str().context("result")?)?;
    assert_eq!(result["isError"], false, "{task}");
    let text = result["text"].as_str().context("command output")?;
    let lines: Vec<&str> = text.lines().collect();
    assert!(
        lines.starts_with(&["1000", "Linux", "lo"]),
        "the command ran outside an unprivileged, offline container: {text}"
    );
    assert!(!source.join("command-output.txt").exists());
    let left = docker(&[
        "ps",
        "-aq",
        "--filter",
        &format!("label=supertag.taskId={task_id}"),
    ])?;
    assert!(
        left.stdout.is_empty(),
        "the Task's container was left running"
    );
    services.stop().await
}

async fn claude_captures_selected_workspace_files_for_the_operator(database: String) -> Result<()> {
    let Some(interpreter) = crate::prerequisites::env("node", "SUPERTAG_RUST_TEST_NODE")? else {
        return Ok(());
    };
    let entry = repo_path("harnesses/claude-code/dist/rust-adapter/entry.js")?;
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
    // Each run is a fresh host incarnation, and a state directory carries its incarnation.
    let runs = std::cell::Cell::new(0);
    let worker = || {
        runs.set(runs.get() + 1);
        let mut host = services.worker(
            "claude-code",
            &directory.path().join(format!("host-{}", runs.get())),
            Path::new(&interpreter),
            &entry,
        );
        host.arg("--claude-path")
            .arg(&native)
            .arg("--artifact-directory")
            .arg(holding_host::artifact_directory(directory.path()))
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
    assert_eq!(
        services
            .held_file(directory.path(), artifact_id, "report.txt")
            .await?,
        report
    );
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
    assert_eq!(
        services
            .held_file(directory.path(), managed_id, &output_path)
            .await?,
        b"managed Task output\n"
    );
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
    assert_eq!(
        services
            .held_file(directory, artifact, "report.txt")
            .await?,
        b"dirty tracked output\n"
    );
    let snapshot: Value = serde_json::from_slice(
        &services
            .held_file(directory, artifact, "supertag-git-output.json")
            .await?,
    )?;
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
            assert_eq!(
                services
                    .held_file(directory, artifact_id, "deliverables/deliverable.txt")
                    .await?,
                b"managed Task output\n"
            );
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
    let entry = repo_path("harnesses/claude-code/dist/rust-adapter/entry.js")?;
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
        .operator(&["get", "inbox-items", "--kind", "approval"])
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
        services
            .operator(&["get", "workstream-posts", "--team", "release"])
            .await?["posts"],
        serde_json::json!([])
    );
    assert_eq!(
        services
            .operator(&["get", "messages", "--mailbox", "recipient"])
            .await?["messages"],
        serde_json::json!([])
    );
    let exact = services.operator(&["get", "approval", approval_id]).await?;
    let body = "The SDK fixture verified the release.";
    assert_eq!(exact["arguments"]["body"], body);
    assert_eq!(
        exact["arguments"]["to_tag_ids"],
        serde_json::json!(["recipient"])
    );

    let approve = [
        "approval",
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
    // The host that wrote the Session's checkpoint resumes it; another host would start fresh.
    success(worker("first-host")).await?;
    let continued = services.operator(&["get", "task", continued_id]).await?;
    assert_eq!(continued["state"], "TASK_STATE_SUCCEEDED", "{continued}");
    assert_eq!(continued["session_id"], first["session_id"]);
    assert_eq!(continued["result"], "fixture resumed and posted one update");
    let workstream = services
        .operator(&["get", "workstream-posts", "--team", "release"])
        .await?;
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
    let approval = services.operator(&["get", "approval", approval_id]).await?;
    assert!(approval["consumed_at_ms"].is_i64());

    success(worker("recipient-host")).await?;
    let mailbox = services
        .operator(&["get", "messages", "--mailbox", "recipient"])
        .await?;
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
    let entry = repo_path("harnesses/claude-code/dist/rust-adapter/entry.js")?;
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
