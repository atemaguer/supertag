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

#[tokio::test]
async fn language_profiles_route_tasks_and_limit_credentials_and_scratch() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let gateway_token = Uuid::new_v4().to_string();
    let operator_token = Uuid::new_v4().to_string();
    let host_token = Uuid::new_v4().to_string();
    let mut control = command(&["control-plane"]);
    control
        .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
        .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
        .env(
            "SUPERTAG_DATABASE_URL",
            format!(
                "sqlite://{}?mode=rwc",
                directory.path().join("control.db").display()
            ),
        );
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
                "put-tag",
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
        let task = operator(&["get-task", &tasks[selected]], &public, &operator_token).await?;
        assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
        assert!(
            task["result"]
                .as_str()
                .unwrap_or_default()
                .contains("matching adapter")
        );
        if selected == 1 {
            let pending = operator(&["get-task", &tasks[0]], &public, &operator_token).await?;
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
    public: String,
    operator_token: String,
    host_token: String,
}

impl LanguageServices {
    async fn start(directory: &Path) -> Result<Self> {
        let gateway_token = Uuid::new_v4().to_string();
        let operator_token = Uuid::new_v4().to_string();
        let host_token = Uuid::new_v4().to_string();
        let mut control = command(&["control-plane"]);
        control
            .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
            .env(
                "SUPERTAG_DATABASE_URL",
                format!(
                    "sqlite://{}?mode=rwc",
                    directory.join("control.db").display()
                ),
            );
        let (control, private) = service(control).await?;
        let mut gateway = command(&["gateway", "--control-plane", &private]);
        gateway
            .arg("--checkpoint-directory")
            .arg(directory.join("blobs"))
            .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
            .env("SUPERTAG_OPERATOR_TOKEN", &operator_token);
        let (gateway, public) = service(gateway).await?;
        Ok(Self {
            control,
            gateway,
            public,
            operator_token,
            host_token,
        })
    }

    async fn operator(&self, args: &[&str]) -> Result<Value> {
        operator(args, &self.public, &self.operator_token).await
    }

    fn worker(&self, harness: &str, directory: &Path, runtime: &Path, entry: &Path) -> Command {
        let mut host = command(&[
            "worker-host",
            "--gateway",
            &self.public,
            "--once",
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
        "task-usage",
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

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_AGENTS_PYTHON with the Python SDK runtime and agents extras installed"]
async fn python_agents_sdk_restores_session_on_a_fresh_host() -> Result<()> {
    let interpreter = std::env::var_os("SUPERTAG_RUST_TEST_AGENTS_PYTHON")
        .context("installed Python Agents test interpreter required")?;
    let fixture = repo_path("sdks/python/tests/fixtures/openai_agents_runtime.py")?;
    let directory = tempfile::tempdir()?;
    let services = LanguageServices::start(directory.path()).await?;
    services
        .operator(&[
            "put-tag",
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
        let task = services.operator(&["get-task", task_id]).await?;
        assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
        assert_eq!(task["result"], expected);
        let usage = last_usage(&services, &task).await?;
        assert_eq!(usage["input_tokens"], 11);
        assert_eq!(usage["cached_input_tokens"], 2);
        assert_eq!(usage["output_tokens"], 5);
    }
    services.stop().await
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_NODE and a built Claude Code language adapter"]
async fn claude_code_sdk_restores_session_on_a_fresh_host() -> Result<()> {
    let interpreter =
        std::env::var_os("SUPERTAG_RUST_TEST_NODE").context("Node test executable required")?;
    let entry = repo_path("packages/runtime/harnesses/claude-code/dist/rust-adapter/entry.js")?;
    let directory = tempfile::tempdir()?;
    let native = claude_fixture(directory.path())?;
    let services = LanguageServices::start(directory.path()).await?;
    services
        .operator(&[
            "put-tag",
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
        let task = services.operator(&["get-task", task_id]).await?;
        assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
        assert_eq!(task["result"], expected);
        let usage = last_usage(&services, &task).await?;
        assert_eq!(usage["input_tokens"], 15);
        assert_eq!(usage["cached_input_tokens"], 3);
        assert_eq!(usage["output_tokens"], 4);
    }
    services.stop().await
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_NODE and a built Claude Code language adapter"]
async fn claude_sdk_approves_one_workstream_post_and_delivers_one_mailbox_turn() -> Result<()> {
    let interpreter =
        std::env::var_os("SUPERTAG_RUST_TEST_NODE").context("Node test executable required")?;
    let entry = repo_path("packages/runtime/harnesses/claude-code/dist/rust-adapter/entry.js")?;
    let directory = tempfile::tempdir()?;
    let native = claude_fixture(directory.path())?;
    let services = LanguageServices::start(directory.path()).await?;
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
            "put-tag",
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
            "put-tag",
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
    let first = services.operator(&["get-task", source_id]).await?;
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
    let continued = services.operator(&["get-task", continued_id]).await?;
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
    let mail = services.operator(&["get-task", mail_task]).await?;
    assert_eq!(mail["state"], "TASK_STATE_SUCCEEDED", "{mail}");
    assert_eq!(mail["session_id"], "inbox:recipient");
    assert_eq!(mail["result"], "SDK fixture handled the addressed post");
    services.stop().await
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_NODE and a built Claude Code language adapter"]
async fn claude_sdk_applies_accepted_usd_budget_and_records_the_stop_usage() -> Result<()> {
    let interpreter =
        std::env::var_os("SUPERTAG_RUST_TEST_NODE").context("Node test executable required")?;
    let entry = repo_path("packages/runtime/harnesses/claude-code/dist/rust-adapter/entry.js")?;
    let directory = tempfile::tempdir()?;
    let native = claude_fixture(directory.path())?;
    let services = LanguageServices::start(directory.path()).await?;
    services
        .operator(&[
            "put-tag",
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
    let stopped = services.operator(&["get-task", id]).await?;
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
