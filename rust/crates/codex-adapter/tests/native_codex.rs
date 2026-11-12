//! Real native subprocesses connected to a real authenticated Harness gRPC server.
//! Every executable, workspace, credential, and provider response is a disposable fixture.
use std::{
    collections::BTreeMap,
    ffi::OsString,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use supertag_codex_adapter::{CodexOptions, run};
use supertag_protocol::{
    MAX_CHECKPOINT_BYTES, MAX_MESSAGE_BYTES, matches_bearer,
    v2::{
        AdapterBootstrap, HarnessAttachRequest, HarnessCompleteRequest, HarnessCompleteResponse,
        HarnessPublishRequest, HarnessRun, HarnessSettleLiveInputRequest,
        HarnessTakeLiveInputRequest, HarnessUsageRequest, LiveInput, LiveInputReceipt,
        LiveInputState, ReportAttemptUsageResponse, SessionCheckpoint, TakeInputResponse, Task,
        TaskEvent,
        harness_server::{Harness, HarnessServer},
    },
};
use tempfile::TempDir;
use tokio::{net::TcpListener, sync::Mutex};
use tokio_stream::wrappers::TcpListenerStream;
use tonic::{Request, Response, Status, transport::Server};

const KEY: &str = "synthetic-codex-provider-secret";
const TOKEN: &str = "synthetic-harness-transport-secret";

#[derive(Default)]
struct Observed {
    events: Vec<HarnessPublishRequest>,
    outcome: Option<HarnessCompleteRequest>,
    usage: Vec<HarnessUsageRequest>,
    input: Option<LiveInput>,
    dispatched: Option<LiveInput>,
    receipts: Vec<HarnessSettleLiveInputRequest>,
    valid_for_ms: u64,
    lose_settlement_response: bool,
    lose_take_response: bool,
}

#[derive(Clone)]
struct HarnessFixture {
    task: Task,
    observed: Arc<Mutex<Observed>>,
    checkpoint: Option<SessionCheckpoint>,
}

impl HarnessFixture {
    fn authenticate<T>(&self, request: &Request<T>) -> Result<(), Status> {
        if !matches_bearer(request, TOKEN) {
            return Err(Status::unauthenticated("test credential required"));
        }
        Ok(())
    }
}

#[tonic::async_trait]
impl Harness for HarnessFixture {
    async fn attach(
        &self,
        request: Request<HarnessAttachRequest>,
    ) -> Result<Response<HarnessRun>, Status> {
        self.authenticate(&request)?;
        Ok(Response::new(HarnessRun {
            task: Some(self.task.clone()),
            attempt_id: "native-attempt".into(),
            checkpoint: self.checkpoint.clone(),
        }))
    }
    async fn take_live_input(
        &self,
        request: Request<HarnessTakeLiveInputRequest>,
    ) -> Result<Response<TakeInputResponse>, Status> {
        self.authenticate(&request)?;
        let mut observed = self.observed.lock().await;
        let input = observed.input.take();
        if let Some(input) = &input {
            observed.dispatched = Some(input.clone());
        }
        if observed.lose_take_response {
            return Err(Status::unavailable("synthetic take response loss"));
        }
        Ok(Response::new(TakeInputResponse {
            input,
            valid_for_ms: observed.valid_for_ms,
        }))
    }

    async fn settle_live_input(
        &self,
        request: Request<HarnessSettleLiveInputRequest>,
    ) -> Result<Response<LiveInput>, Status> {
        self.authenticate(&request)?;
        let mut observed = self.observed.lock().await;
        let request = request.into_inner();
        if let Some(previous) = observed.receipts.first() {
            assert_eq!(*previous, request);
        }
        let mut input = observed
            .dispatched
            .clone()
            .expect("input was taken before settlement");
        assert_eq!(input.input_id, request.input_id);
        input.state = match request.receipt() {
            LiveInputReceipt::Accepted => LiveInputState::Accepted,
            LiveInputReceipt::Rejected => LiveInputState::Rejected,
            LiveInputReceipt::Unknown => LiveInputState::Unknown,
            LiveInputReceipt::Withdrawn => LiveInputState::Withdrawn,
            _ => panic!("invalid receipt"),
        } as i32;
        observed.receipts.push(request);
        if observed.lose_settlement_response {
            observed.lose_settlement_response = false;
            return Err(Status::unavailable("synthetic receipt response loss"));
        }
        Ok(Response::new(input))
    }

    async fn publish(
        &self,
        request: Request<HarnessPublishRequest>,
    ) -> Result<Response<TaskEvent>, Status> {
        self.authenticate(&request)?;
        let event = request.into_inner();
        let mut observed = self.observed.lock().await;
        assert_eq!(event.sequence, observed.events.len() as u64 + 1);
        assert!(event.text.len() <= 16_384);
        let result = TaskEvent {
            sequence: event.sequence,
            text: event.text.clone(),
        };
        observed.events.push(event);
        Ok(Response::new(result))
    }
    async fn complete(
        &self,
        request: Request<HarnessCompleteRequest>,
    ) -> Result<Response<HarnessCompleteResponse>, Status> {
        self.authenticate(&request)?;
        let mut observed = self.observed.lock().await;
        assert!(observed.outcome.is_none());
        observed.outcome = Some(request.into_inner());
        Ok(Response::new(HarnessCompleteResponse {}))
    }

    async fn report_usage(
        &self,
        request: Request<HarnessUsageRequest>,
    ) -> Result<Response<ReportAttemptUsageResponse>, Status> {
        self.authenticate(&request)?;
        let mut observed = self.observed.lock().await;
        assert!(
            observed.outcome.is_none(),
            "usage is recorded before terminal outcome"
        );
        assert_eq!(request.get_ref().sequence, observed.usage.len() as u64 + 1);
        observed.usage.push(request.into_inner());
        Ok(Response::new(ReportAttemptUsageResponse {}))
    }
}

struct HarnessProcess {
    bootstrap: AdapterBootstrap,
    observed: Arc<Mutex<Observed>>,
    server: tokio::task::JoinHandle<Result<(), tonic::transport::Error>>,
}

impl HarnessProcess {
    async fn start(actions: &[&str]) -> Result<Self> {
        Self::with_checkpoint(actions, None).await
    }

    async fn with_checkpoint(
        actions: &[&str],
        checkpoint: Option<SessionCheckpoint>,
    ) -> Result<Self> {
        Self::with_prompt(actions, checkpoint, "Inspect this fixture").await
    }

    async fn with_prompt(
        actions: &[&str],
        checkpoint: Option<SessionCheckpoint>,
        prompt: &str,
    ) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let bootstrap = AdapterBootstrap {
            endpoint: format!("http://{}", listener.local_addr()?),
            token: TOKEN.into(),
        };
        let observed = Arc::new(Mutex::new(Observed::default()));
        let fixture = HarnessFixture {
            task: Task {
                harness_kind: 0,
                workspace: None,
                workspace_delivery: None,
                task_id: "native-task".into(),
                tag_id: "native-tag".into(),
                session_id: "native-session".into(),
                instructions: "Review carefully".into(),
                prompt: prompt.into(),
                allowed_actions: actions.iter().map(|value| (*value).into()).collect(),
                ..Default::default()
            },
            observed: observed.clone(),
            checkpoint,
        };
        let server = tokio::spawn(
            Server::builder()
                .add_service(
                    HarnessServer::new(fixture)
                        .max_decoding_message_size(MAX_CHECKPOINT_BYTES + MAX_MESSAGE_BYTES)
                        .max_encoding_message_size(MAX_CHECKPOINT_BYTES + MAX_MESSAGE_BYTES),
                )
                .serve_with_incoming(TcpListenerStream::new(listener)),
        );
        Ok(Self {
            bootstrap,
            observed,
            server,
        })
    }
}

impl Drop for HarnessProcess {
    fn drop(&mut self) {
        self.server.abort();
    }
}

struct NativeFixture {
    directory: TempDir,
    workspace: PathBuf,
    command: PathBuf,
    source_home: PathBuf,
}

impl NativeFixture {
    fn new(output: &str, tail: &str) -> Result<Self> {
        let directory = tempfile::Builder::new()
            .permissions(std::fs::Permissions::from_mode(0o700))
            .tempdir()?;
        let workspace = directory.path().join("workspace with spaces");
        let source_home = directory.path().join("operator-codex");
        std::fs::create_dir(&workspace)?;
        std::fs::create_dir(&source_home)?;
        let command = directory.path().join("fake-codex");
        let output_file = directory.path().join("output.jsonl");
        std::fs::write(&output_file, output)?;
        std::fs::write(
            directory.path().join("seed.jsonl"),
            event_lines(&[
                json!({"type":"session_meta","payload":{"id":"native-thread","cwd":workspace.canonicalize()?}}),
                json!({"type":"turn_context","payload":{"cwd":workspace.canonicalize()?}}),
                json!({"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"remember this fixture"}]}}),
            ]),
        )?;
        std::fs::write(directory.path().join("tail"), tail)?;
        std::fs::write(&command, include_str!("fixtures/app_server.py"))?;
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o700))?;
        Ok(Self {
            directory,
            workspace,
            command,
            source_home,
        })
    }

    fn options(&self) -> CodexOptions {
        CodexOptions {
            executable: self.command.clone(),
            workspace: self.workspace.clone(),
            state_directory: self.directory.path().to_owned(),
            model: Some("gpt-fixture-exact".into()),
            timeout: Duration::from_secs(5),
            allow_workspace_write: false,
            environment: BTreeMap::from([
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("HOME".into(), self.directory.path().as_os_str().to_owned()),
                ("CODEX_HOME".into(), self.source_home.as_os_str().to_owned()),
                ("CODEX_API_KEY".into(), KEY.into()),
                ("OPENAI_API_KEY".into(), "unselected-openai-secret".into()),
                (
                    "SUPERTAG_HOST_TOKEN".into(),
                    "must-not-reach-native-host-secret".into(),
                ),
                (
                    "SUPERTAG_GATEWAY_TOKEN".into(),
                    "must-not-reach-native-gateway-secret".into(),
                ),
                (
                    "GITHUB_TOKEN".into(),
                    "must-not-reach-native-github-secret".into(),
                ),
                (
                    "HTTP_PROXY".into(),
                    "http://unselected-proxy.invalid".into(),
                ),
            ]),
        }
    }

    fn read(&self, name: &str) -> Result<String> {
        Ok(std::fs::read_to_string(self.directory.path().join(name))?)
    }

    fn args(&self) -> Result<Vec<String>> {
        Ok(std::fs::read(self.directory.path().join("args"))?
            .split(|byte| *byte == 0)
            .filter(|bytes| !bytes.is_empty())
            .map(|bytes| String::from_utf8(bytes.into()))
            .collect::<std::result::Result<_, _>>()?)
    }
}

fn event_lines(values: &[Value]) -> String {
    values
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

fn successful(text: &str) -> String {
    event_lines(&[
        json!({"type":"thread.started","thread_id":"native-thread"}),
        json!({"type":"turn.started"}),
        json!({"type":"item.completed","item":{"id":"answer","type":"agent_message","text":text}}),
        json!({"type":"turn.completed","usage":{"input_tokens":4,"cached_input_tokens":1,"output_tokens":3}}),
    ])
}

async fn steering_fixture(
    mode: &str,
    valid_for_ms: u64,
    lose_receipt: bool,
) -> Result<(NativeFixture, HarnessProcess)> {
    let fixture = NativeFixture::new(
        &successful("response includes the live instruction"),
        "exit 0",
    )?;
    std::fs::write(fixture.directory.path().join("steering-mode"), mode)?;
    let server = HarnessProcess::start(&["files:read"]).await?;
    {
        let mut observed = server.observed.lock().await;
        observed.input = Some(LiveInput {
            input_id: "live-input".into(),
            task_id: "native-task".into(),
            attempt_id: "native-attempt".into(),
            follower_task_id: "follower-task".into(),
            text: "Use the revised requirement".into(),
            state: LiveInputState::Dispatching as i32,
            order: 1,
        });
        observed.valid_for_ms = valid_for_ms;
        observed.lose_settlement_response = lose_receipt;
    }
    Ok((fixture, server))
}

#[tokio::test]
async fn live_input_targets_exact_active_turn_once_and_retries_only_the_receipt() -> Result<()> {
    let (fixture, server) = steering_fixture("accept", 10_000, true).await?;
    run(fixture.options(), server.bootstrap.clone()).await?;
    let observed = server.observed.lock().await;
    let outcome = observed.outcome.as_ref().unwrap();
    assert!(outcome.succeeded, "{}", outcome.result);
    assert!(outcome.checkpoint.is_some());
    assert_eq!(observed.receipts.len(), 2);
    assert!(
        observed
            .receipts
            .iter()
            .all(|value| value.receipt() == LiveInputReceipt::Accepted)
    );
    let requests: Vec<Value> = fixture
        .read("requests.jsonl")?
        .lines()
        .map(serde_json::from_str)
        .collect::<std::result::Result<_, _>>()?;
    assert_eq!(
        requests
            .iter()
            .filter(|value| value["method"] == "turn/start")
            .count(),
        1
    );
    let steering: Vec<_> = requests
        .iter()
        .filter(|value| value["method"] == "turn/steer")
        .collect();
    assert_eq!(steering.len(), 1);
    assert_eq!(steering[0]["params"]["threadId"], "native-thread");
    assert_eq!(steering[0]["params"]["expectedTurnId"], "native-turn");
    assert_eq!(
        steering[0]["params"]["input"][0]["text"],
        "Use the revised requirement"
    );
    Ok(())
}

#[tokio::test]
async fn steering_rejection_and_ambiguous_native_delivery_never_replay_or_checkpoint() -> Result<()>
{
    for (mode, expected) in [
        ("reject", LiveInputReceipt::Rejected),
        ("lost", LiveInputReceipt::Unknown),
        ("wrong-turn", LiveInputReceipt::Unknown),
        ("late", LiveInputReceipt::Unknown),
    ] {
        let (fixture, server) = steering_fixture(mode, 10_000, false).await?;
        run(fixture.options(), server.bootstrap.clone()).await?;
        let observed = server.observed.lock().await;
        let outcome = observed.outcome.as_ref().unwrap();
        assert!(!outcome.succeeded, "{mode}");
        assert!(outcome.checkpoint.is_none(), "{mode}");
        assert_eq!(observed.receipts.len(), 1, "{mode}: {}", outcome.result);
        assert_eq!(observed.receipts[0].receipt(), expected, "{mode}");
        let requests = fixture.read("requests.jsonl")?;
        assert_eq!(
            requests.matches("\"method\": \"turn/steer\"").count(),
            1,
            "{mode}"
        );
        assert_eq!(
            requests.matches("\"method\": \"turn/start\"").count(),
            1,
            "{mode}"
        );
        let pid: i32 = fixture.read("pid")?.parse()?;
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            -1,
            "native process must be stopped before completing {mode}"
        );
    }
    Ok(())
}

#[tokio::test]
async fn expired_dispatch_authority_does_not_write_to_native_stdin() -> Result<()> {
    let (fixture, server) = steering_fixture("accept", 0, false).await?;
    let mut options = fixture.options();
    options.timeout = Duration::from_millis(700);
    run(options, server.bootstrap.clone()).await?;
    let observed = server.observed.lock().await;
    assert_eq!(observed.receipts.len(), 1);
    assert_eq!(observed.receipts[0].receipt(), LiveInputReceipt::Rejected);
    assert!(!fixture.read("requests.jsonl")?.contains("turn/steer"));
    Ok(())
}

#[tokio::test]
async fn lost_take_response_or_wrong_attempt_never_reaches_native_input() -> Result<()> {
    for lost in [true, false] {
        let (fixture, server) = steering_fixture("accept", 10_000, false).await?;
        {
            let mut observed = server.observed.lock().await;
            if lost {
                observed.lose_take_response = true;
            } else {
                observed.input.as_mut().unwrap().attempt_id = "other-attempt".into();
            }
        }
        run(fixture.options(), server.bootstrap.clone()).await?;
        let observed = server.observed.lock().await;
        assert!(!observed.outcome.as_ref().unwrap().succeeded);
        assert!(observed.dispatched.is_some());
        assert!(observed.input.is_none());
        assert!(observed.receipts.is_empty());
        assert!(!fixture.read("requests.jsonl")?.contains("turn/steer"));
    }
    Ok(())
}

#[tokio::test]
async fn active_repository_configuration_is_rejected_before_starting_native_work() -> Result<()> {
    let (fixture, server) = steering_fixture("project-config", 10_000, false).await?;
    run(fixture.options(), server.bootstrap.clone()).await?;
    let observed = server.observed.lock().await;
    assert!(!observed.outcome.as_ref().unwrap().succeeded);
    assert!(observed.receipts.is_empty());
    assert!(!fixture.read("requests.jsonl")?.contains("thread/start"));
    assert!(!fixture.read("requests.jsonl")?.contains("turn/start"));
    Ok(())
}

#[tokio::test]
#[ignore = "uses approved native Codex sign-in and model calls; set SUPERTAG_TEST_CODEX_BINARY"]
async fn installed_native_sign_in_steers_one_turn_and_resumes_its_checkpoint() -> Result<()> {
    let binary =
        std::env::var_os("SUPERTAG_TEST_CODEX_BINARY").context("set SUPERTAG_TEST_CODEX_BINARY")?;
    let fixture = NativeFixture::new(&successful("unused"), "exit 0")?;
    let mut options = fixture.options();
    options.executable = binary.into();
    options.model = Some("gpt-6.1-sol".into());
    options.timeout = Duration::from_secs(90);
    options.environment = ["PATH", "HOME", "CODEX_HOME", "LANG", "TMPDIR"]
        .into_iter()
        .filter_map(|name| std::env::var_os(name).map(|value| (OsString::from(name), value)))
        .collect();
    let server = HarnessProcess::with_prompt(&["files:read"],None,"Write a detailed 350-word explanation of how checking an exact turn identity makes live steering reliable. Do not run any tools or read any files.").await?;
    {
        let mut observed = server.observed.lock().await;
        observed.input=Some(LiveInput { input_id:"live-native-input".into(),task_id:"native-task".into(),attempt_id:"native-attempt".into(),follower_task_id:"native-follower".into(),text:"Replace the previous request. Reply with exactly NATIVE_STEER_OK. Do not use tools.".into(),state:LiveInputState::Dispatching as i32,order:1 });
        observed.valid_for_ms = 30_000;
    }
    run(options, server.bootstrap.clone()).await?;
    let checkpoint = {
        let observed = server.observed.lock().await;
        let outcome = observed
            .outcome
            .as_ref()
            .context("native outcome missing")?;
        ensure!(
            outcome.succeeded,
            "native live steering failed: {}",
            outcome.result
        );
        ensure!(
            outcome.result.contains("NATIVE_STEER_OK"),
            "native result did not incorporate the steered instruction"
        );
        assert_eq!(observed.receipts.len(), 1);
        assert_eq!(observed.receipts[0].receipt(), LiveInputReceipt::Accepted);
        ensure!(!observed.usage.is_empty(), "native usage missing");
        outcome
            .checkpoint
            .clone()
            .context("native checkpoint missing")?
    };
    let second = NativeFixture::new(&successful("unused"), "exit 0")?;
    let mut options = second.options();
    options.executable = std::env::var_os("SUPERTAG_TEST_CODEX_BINARY")
        .unwrap()
        .into();
    options.model = Some("gpt-6.1-sol".into());
    options.timeout = Duration::from_secs(90);
    options.environment = ["PATH", "HOME", "CODEX_HOME", "LANG", "TMPDIR"]
        .into_iter()
        .filter_map(|name| std::env::var_os(name).map(|value| (OsString::from(name), value)))
        .collect();
    let server = HarnessProcess::with_prompt(
        &["files:read"],
        Some(checkpoint),
        "Reply with exactly NATIVE_RESUME_OK. Do not use tools.",
    )
    .await?;
    run(options, server.bootstrap.clone()).await?;
    let observed = server.observed.lock().await;
    let outcome = observed
        .outcome
        .as_ref()
        .context("native resume outcome missing")?;
    ensure!(
        outcome.succeeded,
        "native resume failed: {}",
        outcome.result
    );
    ensure!(
        outcome.result.contains("NATIVE_RESUME_OK"),
        "native resume result missing"
    );
    ensure!(
        outcome.checkpoint.is_some(),
        "resumed native checkpoint missing"
    );
    ensure!(!observed.usage.is_empty(), "resumed native usage missing");
    Ok(())
}

#[tokio::test]
async fn native_app_server_uses_exact_model_read_only_sandbox_scoped_env_and_redacted_events()
-> Result<()> {
    let fixture = NativeFixture::new(
        &successful(&format!("Reviewed {KEY}; no changes.")),
        "exit 0",
    )?;
    let server = HarnessProcess::start(&["files:read"]).await?;
    run(fixture.options(), server.bootstrap.clone()).await?;
    let observed = server.observed.lock().await;
    let outcome = observed.outcome.as_ref().context("no native outcome")?;
    assert!(outcome.succeeded, "{}", outcome.result);
    assert_eq!(outcome.result, "Reviewed [REDACTED]; no changes.");
    assert_eq!(outcome.objective_signal, 0);
    assert_eq!(observed.events.len(), 2);
    assert_eq!(observed.events[1].text, outcome.result);
    let args = fixture.args()?;
    assert_eq!(&args[..3], ["app-server", "--listen", "stdio://"]);
    assert!(!args.iter().any(|value| value == "--ephemeral"));
    for setting in [
        "model=\"gpt-fixture-exact\"",
        "sandbox_mode=\"read-only\"",
        "approval_policy=\"never\"",
        "features.shell_tool=false",
        "features.unified_exec=false",
        "features.hooks=false",
        "features.code_mode_host=false",
        "mcp_servers={}",
        "web_search=\"disabled\"",
        "project_doc_max_bytes=0",
    ] {
        assert!(
            args.windows(2)
                .any(|values| values == ["--config", setting]),
            "missing {setting}"
        );
    }
    assert!(
        !args
            .iter()
            .any(|value| value.contains(KEY) || value.contains(TOKEN))
    );
    assert_eq!(
        fixture.read("prompt")?,
        "Tag instructions:\nReview carefully\n\nTask:\nInspect this fixture\n"
    );
    let environment = fixture.read("env")?;
    assert!(
        environment
            .lines()
            .any(|line| line == format!("CODEX_API_KEY={KEY}"))
    );
    assert!(!environment.contains("OPENAI_API_KEY="));
    assert!(!environment.contains("must-not-reach") && !environment.contains(TOKEN));
    assert!(!environment.contains("HTTP_PROXY="));
    let private_home = environment
        .lines()
        .find_map(|line| line.strip_prefix("CODEX_HOME="))
        .context("no isolated home")?;
    assert_ne!(Path::new(private_home), fixture.source_home);
    assert!(
        !Path::new(private_home).exists(),
        "normal completion must remove staged credentials"
    );
    Ok(())
}

#[tokio::test]
async fn selected_native_sign_in_precedes_openai_key_and_copies_only_auth_json() -> Result<()> {
    let auth = json!({"auth_mode":"chatgpt","tokens":{"access_token":"selected-access-secret","refresh_token":"selected-refresh-secret","id_token":"selected-id-secret"}}).to_string();
    let fixture = NativeFixture::new(
        &successful("selected-access-secret selected-refresh-secret selected-id-secret"),
        "exit 0",
    )?;
    std::fs::write(fixture.source_home.join("auth.json"), &auth)?;
    std::fs::write(
        fixture.source_home.join("config.toml"),
        "never transfer user config",
    )?;
    let mut options = fixture.options();
    options.environment.remove(&OsString::from("CODEX_API_KEY"));
    let server = HarnessProcess::start(&["files:read"]).await?;
    run(options, server.bootstrap.clone()).await?;
    assert_eq!(fixture.read("auth")?, auth);
    assert!(fixture.read("auth-mode")?.starts_with("-rw-------"));
    assert!(!fixture.directory.path().join("config-copied").exists());
    assert!(!fixture.read("env")?.contains("API_KEY="));
    assert_eq!(
        std::fs::read_to_string(fixture.source_home.join("auth.json"))?,
        auth
    );
    let observed = server.observed.lock().await;
    let outcome = observed.outcome.as_ref().unwrap();
    assert!(outcome.succeeded);
    assert_eq!(outcome.result, "[REDACTED] [REDACTED] [REDACTED]");
    Ok(())
}

#[tokio::test]
async fn openai_key_is_used_only_when_no_selected_sign_in_exists() -> Result<()> {
    let fixture = NativeFixture::new(&successful("done"), "exit 0")?;
    let mut options = fixture.options();
    options.environment.remove(&OsString::from("CODEX_API_KEY"));
    let server = HarnessProcess::start(&["files:read"]).await?;
    run(options, server.bootstrap.clone()).await?;
    assert!(
        fixture
            .read("env")?
            .contains("CODEX_API_KEY=unselected-openai-secret\n")
    );
    assert!(
        server
            .observed
            .lock()
            .await
            .outcome
            .as_ref()
            .unwrap()
            .succeeded
    );
    Ok(())
}

#[tokio::test]
async fn unsupported_authorities_are_rejected_before_any_native_process_runs() -> Result<()> {
    for actions in [
        vec!["files:read", "browser:use"],
        vec!["files:read", "files:write"],
        vec!["files:read", "web:fetch"],
        vec!["commands:execute"],
        vec!["files:read", "mcp:anything"],
    ] {
        let fixture = NativeFixture::new(&successful("should never run"), "exit 0")?;
        let server = HarnessProcess::start(&actions).await?;
        run(fixture.options(), server.bootstrap.clone()).await?;
        assert!(
            !fixture.directory.path().join("args").exists(),
            "native process ran with unsupported authorities"
        );
        let observed = server.observed.lock().await;
        assert!(!observed.outcome.as_ref().unwrap().succeeded);
        assert!(observed.events.is_empty());
    }
    Ok(())
}

#[tokio::test]
async fn disposable_write_and_commands_select_legacy_loopback_profile_and_protect_common_git()
-> Result<()> {
    let fixture = NativeFixture::new(&successful("updated fixture"), "exit 0")?;
    let common = fixture.directory.path().join("common.git");
    let worktree = common.join("worktrees/task");
    std::fs::create_dir_all(&worktree)?;
    std::fs::write(
        fixture.workspace.join(".git"),
        format!("gitdir: {}\n", worktree.display()),
    )?;
    std::fs::write(worktree.join("commondir"), "../..\n")?;
    let mut options = fixture.options();
    options.allow_workspace_write = true;
    let server = HarnessProcess::start(&["files:read", "files:write", "commands:execute"]).await?;
    run(options, server.bootstrap.clone()).await?;
    let args = fixture.args()?;
    assert!(!args.iter().any(|value| value == "--sandbox"));
    for setting in [
        "default_permissions=\"supertag\"",
        "permissions.supertag.extends=\":workspace\"",
        "permissions.supertag.network.mode=\"limited\"",
        "permissions.supertag.network.allow_local_binding=true",
        "features.network_proxy.enabled=true",
        "features.shell_tool=true",
    ] {
        assert!(args.iter().any(|value| value == setting));
    }
    let protected = format!(
        "permissions.supertag.filesystem={{ {} = \"read\" }}",
        serde_json::to_string(common.canonicalize()?.to_str().unwrap())?
    );
    assert!(args.iter().any(|value| value == &protected));
    assert!(
        !args
            .iter()
            .any(|value| value == "sandbox_workspace_write.network_access=true")
    );
    assert!(
        server
            .observed
            .lock()
            .await
            .outcome
            .as_ref()
            .unwrap()
            .succeeded
    );
    Ok(())
}

#[tokio::test]
async fn native_failed_malformed_and_incomplete_streams_never_complete_successfully() -> Result<()>
{
    let started = json!({"type":"thread.started","thread_id":"thread"});
    let answer = json!({"type":"item.completed","item":{"id":"answer","type":"agent_message","text":"done"}});
    let complete = json!({"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}});
    let cases = [
        ("not json\n".into(), "exit 0"),
        (event_lines(&[answer.clone(), complete.clone()]), "exit 0"),
        (event_lines(&[started.clone(), answer.clone()]), "exit 0"),
        (event_lines(&[started.clone(), complete.clone()]), "exit 0"),
        (
            event_lines(&[
                started.clone(),
                json!({"type":"turn.failed","error":{"message":KEY}}),
            ]),
            "exit 0",
        ),
        (
            event_lines(&[started.clone(), json!({"type":"error","message":KEY})]),
            "exit 0",
        ),
        (
            event_lines(&[
                started.clone(),
                json!({"type":"item.completed","item":{"id":"unadmitted","type":"mcp_tool_call","server":"secret","tool":"write"}}),
            ]),
            "exit 0",
        ),
        (
            event_lines(&[
                started.clone(),
                json!({"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":2,"output_tokens":0}}),
            ]),
            "exit 0",
        ),
        (successful("done") + &complete.to_string(), "exit 0"),
        (successful("done"), "exit 7"),
        ("x".repeat(4 * 1024 * 1024 + 1), "exit 0"),
    ];
    let failures = [
        "Codex emitted malformed JSON",
        "Codex emitted work for an unowned thread",
        "Codex process ended without a completed turn",
        "Codex completed without a final response",
        "Codex reported a failed turn",
        "Codex reported a failed turn",
        "Codex emitted an unsupported tool or item",
        "Codex completed with invalid usage",
        "Codex emitted events after its completed turn",
        "Codex process exited unsuccessfully",
        "Codex JSON event exceeds its limit",
    ];
    for ((output, tail), expected) in cases.into_iter().zip(failures) {
        let fixture = NativeFixture::new(&output, tail)?;
        let server = HarnessProcess::start(&["files:read"]).await?;
        run(fixture.options(), server.bootstrap.clone()).await?;
        let observed = server.observed.lock().await;
        let outcome = observed.outcome.as_ref().unwrap();
        assert!(!outcome.succeeded);
        assert_eq!(outcome.result, expected);
        assert!(fixture.directory.path().join("args").exists());
        assert!(!outcome.result.contains(KEY));
        assert!(!outcome.result.contains("private stderr"));
    }
    Ok(())
}

#[tokio::test]
async fn invalid_or_symlinked_sign_in_is_rejected_without_falling_back_to_another_key() -> Result<()>
{
    for content in [
        "not json".to_owned(),
        "[]".to_owned(),
        "{}".to_owned(),
        "x".repeat(65_537),
    ] {
        let fixture = NativeFixture::new(&successful("must not run"), "exit 0")?;
        std::fs::write(fixture.source_home.join("auth.json"), content)?;
        let mut options = fixture.options();
        options.environment.remove(&OsString::from("CODEX_API_KEY"));
        let server = HarnessProcess::start(&["files:read"]).await?;
        run(options, server.bootstrap.clone()).await?;
        assert!(
            !server
                .observed
                .lock()
                .await
                .outcome
                .as_ref()
                .unwrap()
                .succeeded
        );
        assert!(!fixture.directory.path().join("args").exists());
    }
    let fixture = NativeFixture::new(&successful("must not run"), "exit 0")?;
    let secret = fixture.directory.path().join("separate-auth.json");
    std::fs::write(&secret, json!({"OPENAI_API_KEY":KEY}).to_string())?;
    std::os::unix::fs::symlink(secret, fixture.source_home.join("auth.json"))?;
    let mut options = fixture.options();
    options.environment.remove(&OsString::from("CODEX_API_KEY"));
    let server = HarnessProcess::start(&["files:read"]).await?;
    run(options, server.bootstrap.clone()).await?;
    assert_eq!(
        server
            .observed
            .lock()
            .await
            .outcome
            .as_ref()
            .unwrap()
            .result,
        "could not safely read selected Codex sign-in"
    );
    assert!(!fixture.directory.path().join("args").exists());
    Ok(())
}

#[tokio::test]
async fn incompatible_native_version_is_rejected_before_execution() -> Result<()> {
    let fixture = NativeFixture::new(&successful("must not run"), "exit 0")?;
    let script = std::fs::read_to_string(&fixture.command)?
        .replace("codex-cli 0.163.0", "codex-cli 0.162.0");
    std::fs::write(&fixture.command, script)?;
    let server = HarnessProcess::start(&["files:read"]).await?;
    run(fixture.options(), server.bootstrap.clone()).await?;
    let observed = server.observed.lock().await;
    assert!(!observed.outcome.as_ref().unwrap().succeeded);
    assert_eq!(
        observed.outcome.as_ref().unwrap().result,
        "Codex CLI 0.163.0 or later is required"
    );
    assert!(!fixture.directory.path().join("args").exists());
    Ok(())
}

#[tokio::test]
async fn timeout_reaps_the_native_process_and_reports_failure() -> Result<()> {
    let fixture = NativeFixture::new("", "exec /bin/sleep 60")?;
    let mut options = fixture.options();
    options.timeout = Duration::from_millis(150);
    let server = HarnessProcess::start(&["files:read"]).await?;
    run(options, server.bootstrap.clone()).await?;
    let pid: i32 = fixture.read("pid")?.parse()?;
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    let observed = server.observed.lock().await;
    let outcome = observed.outcome.as_ref().unwrap();
    assert!(!outcome.succeeded);
    assert_eq!(outcome.result, "Codex execution timed out");
    Ok(())
}

#[tokio::test]
async fn long_unicode_messages_are_bounded_and_redacted_before_publish_chunking() -> Result<()> {
    let text = format!("{}{}{}", "é".repeat(8191), KEY, "終".repeat(8192));
    let fixture = NativeFixture::new(&successful(&text), "exit 0")?;
    let server = HarnessProcess::start(&["files:read"]).await?;
    run(fixture.options(), server.bootstrap.clone()).await?;
    let observed = server.observed.lock().await;
    let outcome = observed.outcome.as_ref().unwrap();
    assert!(outcome.succeeded);
    assert!(!outcome.result.contains(KEY));
    assert_eq!(
        observed
            .events
            .iter()
            .skip(1)
            .map(|event| event.text.as_str())
            .collect::<String>(),
        outcome.result
    );
    Ok(())
}

#[tokio::test]
async fn measured_usage_is_independent_of_model_selection_exit_and_checkpoint_success() -> Result<()>
{
    for (model, tail, success) in [
        (None, "exit 0", true),
        (Some("gpt-observed-actual"), "exit 0", true),
        (Some(KEY), "exit 0", true),
        (Some("gpt-observed-actual"), "exit 7", false),
        (
            Some("gpt-observed-actual"),
            "/bin/rm -rf \"$CODEX_HOME/sessions\"; exit 0",
            false,
        ),
    ] {
        let mut output = successful("completed provider turn");
        if let Some(model) = model {
            output = output.replace(
                "\"type\":\"turn.started\"",
                &format!(
                    "\"type\":\"turn.started\",\"model\":{}",
                    serde_json::to_string(model)?
                ),
            );
        }
        let fixture = NativeFixture::new(&output, tail)?;
        let server = HarnessProcess::start(&["files:read"]).await?;
        run(fixture.options(), server.bootstrap.clone()).await?;
        let observed = server.observed.lock().await;
        let outcome = observed.outcome.as_ref().unwrap();
        assert_eq!(outcome.succeeded, success, "{}", outcome.result);
        assert_eq!(outcome.checkpoint.is_some(), success);
        assert_eq!(observed.usage.len(), 1);
        let usage = observed.usage[0].native_usage.as_ref().unwrap();
        assert_eq!(
            (
                usage.input_tokens,
                usage.cached_input_tokens,
                usage.output_tokens
            ),
            (4, 1, 3)
        );
        assert_eq!(
            usage.observed_model.as_deref(),
            model.filter(|model| *model != KEY)
        );
    }
    Ok(())
}

#[tokio::test]
async fn continuation_restores_native_history_in_a_new_home_and_reapplies_current_permissions()
-> Result<()> {
    let first = NativeFixture::new(&successful("first turn"), "exit 0")?;
    let old_cwd = first
        .workspace
        .canonicalize()?
        .to_string_lossy()
        .into_owned();
    let history = format!("literal original checkout {old_cwd}; secret {KEY}; transport {TOKEN}");
    let mut seed = first.read("seed.jsonl")?;
    seed.push_str(&format!("{}\n", json!({"type":"response_item","payload":{"role":"assistant","content":[{"type":"output_text","text":history}]}})));
    std::fs::write(first.directory.path().join("seed.jsonl"), seed)?;
    let first_server = HarnessProcess::start(&["files:read", "commands:execute"]).await?;
    run(first.options(), first_server.bootstrap.clone()).await?;
    let checkpoint = first_server
        .observed
        .lock()
        .await
        .outcome
        .as_ref()
        .unwrap()
        .checkpoint
        .clone()
        .context("missing first checkpoint")?;
    assert_eq!(checkpoint.harness, "codex");
    assert_eq!(checkpoint.format, "codex-session-v1");
    assert_eq!(
        checkpoint.sha256,
        format!("{:x}", Sha256::digest(&checkpoint.payload))
    );
    let serialized = std::str::from_utf8(&checkpoint.payload)?;
    assert!(!serialized.contains(KEY) && !serialized.contains(TOKEN));
    drop(first);

    let second = NativeFixture::new(
        &successful("second turn"),
        "printf '%s\\n' '{\"type\":\"response_item\",\"payload\":{\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"second native turn\"}]}}' >> \"$CODEX_HOME/sessions/thread.jsonl\"; exit 0",
    )?;
    let server = HarnessProcess::with_checkpoint(&["files:read"], Some(checkpoint.clone())).await?;
    std::fs::write(second.directory.path().join("late-baseline"), "")?;
    run(second.options(), server.bootstrap.clone()).await?;
    let observed = server.observed.lock().await;
    let outcome = observed.outcome.as_ref().unwrap();
    assert!(outcome.succeeded, "{}", outcome.result);
    let args = second.args()?;
    let requests: Vec<Value> = second
        .read("requests.jsonl")?
        .lines()
        .map(serde_json::from_str)
        .collect::<std::result::Result<_, _>>()?;
    let resumed = requests
        .iter()
        .find(|value| value["method"] == "thread/resume")
        .unwrap();
    assert_eq!(resumed["params"]["threadId"], "native-thread");
    assert_eq!(resumed["params"]["sandbox"], "read-only");
    assert_eq!(
        resumed["params"]["config"]["features.code_mode_host"],
        false
    );
    assert!(args.iter().any(|arg| arg == "sandbox_mode=\"read-only\""));
    assert!(args.iter().any(|arg| arg == "features.shell_tool=false"));
    assert!(!args.iter().any(|arg| arg == "features.shell_tool=true"));
    let restored = second.read("restored.jsonl")?;
    let records: Vec<Value> = restored
        .lines()
        .map(serde_json::from_str)
        .collect::<std::result::Result<_, _>>()?;
    let new_cwd = second.workspace.canonicalize()?;
    assert_eq!(records[0]["payload"]["cwd"], new_cwd.to_str().unwrap());
    assert_eq!(records[1]["payload"]["cwd"], new_cwd.to_str().unwrap());
    assert_eq!(
        records[3]["payload"]["content"][0]["text"],
        format!("literal original checkout {old_cwd}; secret [REDACTED]; transport [REDACTED]")
    );
    let next = outcome.checkpoint.as_ref().unwrap();
    assert_ne!(next.sha256, checkpoint.sha256);
    assert!(std::str::from_utf8(&next.payload)?.contains("second native turn"));
    // A new Attempt has its own cumulative usage sequence and counters.
    assert_eq!(observed.usage[0].sequence, 1);
    assert_eq!(
        observed.usage[0]
            .native_usage
            .as_ref()
            .unwrap()
            .input_tokens,
        4
    );
    Ok(())
}

fn modify_checkpoint(
    checkpoint: &SessionCheckpoint,
    change: impl FnOnce(&mut Value),
) -> Result<SessionCheckpoint> {
    let mut modified = checkpoint.clone();
    let mut archive: Value = serde_json::from_slice(&modified.payload)?;
    change(&mut archive);
    modified.payload = serde_json::to_vec(&archive)?;
    modified.sha256 = format!("{:x}", Sha256::digest(&modified.payload));
    Ok(modified)
}

#[tokio::test]
async fn checkpoint_corruption_wrong_scope_and_native_thread_mismatch_fail_closed() -> Result<()> {
    let first = NativeFixture::new(&successful("first"), "exit 0")?;
    let server = HarnessProcess::start(&["files:read"]).await?;
    run(first.options(), server.bootstrap.clone()).await?;
    let checkpoint = server
        .observed
        .lock()
        .await
        .outcome
        .as_ref()
        .unwrap()
        .checkpoint
        .clone()
        .unwrap();
    let mut corrupt = checkpoint.clone();
    corrupt.payload.push(b' ');
    let mut wrong_harness = checkpoint.clone();
    wrong_harness.harness = "another-harness".into();
    for invalid in [
        corrupt,
        wrong_harness,
        modify_checkpoint(&checkpoint, |value| value["tag_id"] = "another-tag".into())?,
        modify_checkpoint(&checkpoint, |value| {
            value["session_id"] = "another-session".into()
        })?,
        modify_checkpoint(&checkpoint, |value| {
            value["transcripts"][0]["path"] = "../../auth.jsonl".into()
        })?,
        modify_checkpoint(&checkpoint, |value| {
            value["transcripts"][0]["text"] = "{}\n".into()
        })?,
    ] {
        let fixture = NativeFixture::new(&successful("must not run"), "exit 0")?;
        let server = HarnessProcess::with_checkpoint(&["files:read"], Some(invalid)).await?;
        run(fixture.options(), server.bootstrap.clone()).await?;
        assert!(!fixture.directory.path().join("args").exists());
        let observed = server.observed.lock().await;
        assert!(!observed.outcome.as_ref().unwrap().succeeded);
        assert!(observed.outcome.as_ref().unwrap().checkpoint.is_none());
        assert!(observed.usage.is_empty());
    }
    let mismatch = NativeFixture::new(
        &successful("wrong thread").replace("native-thread", "unrelated-thread"),
        "exit 0",
    )?;
    let server = HarnessProcess::with_checkpoint(&["files:read"], Some(checkpoint)).await?;
    run(mismatch.options(), server.bootstrap.clone()).await?;
    let observed = server.observed.lock().await;
    assert_eq!(
        observed.outcome.as_ref().unwrap().result,
        "Codex did not resume the requested Session"
    );
    assert!(!observed.outcome.as_ref().unwrap().succeeded);
    assert!(observed.usage.is_empty());
    Ok(())
}

#[tokio::test]
async fn checkpoint_larger_than_ordinary_message_limit_crosses_attach_and_complete() -> Result<()> {
    let first = NativeFixture::new(&successful("large history"), "exit 0")?;
    let mut seed = first.read("seed.jsonl")?;
    seed.push_str(&format!("{}\n", json!({"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"x".repeat(MAX_MESSAGE_BYTES + 2048)}]}})));
    std::fs::write(first.directory.path().join("seed.jsonl"), seed)?;
    let first_server = HarnessProcess::start(&["files:read"]).await?;
    run(first.options(), first_server.bootstrap.clone()).await?;
    let checkpoint = first_server
        .observed
        .lock()
        .await
        .outcome
        .as_ref()
        .unwrap()
        .checkpoint
        .clone()
        .context("large checkpoint missing")?;
    assert!(checkpoint.payload.len() > MAX_MESSAGE_BYTES);
    let second = NativeFixture::new(&successful("resumed large history"), "exit 0")?;
    let server = HarnessProcess::with_checkpoint(&["files:read"], Some(checkpoint)).await?;
    run(second.options(), server.bootstrap.clone()).await?;
    let observed = server.observed.lock().await;
    let outcome = observed.outcome.as_ref().unwrap();
    assert!(outcome.succeeded, "{}", outcome.result);
    assert!(outcome.checkpoint.as_ref().unwrap().payload.len() > MAX_MESSAGE_BYTES);
    assert!(second.read("restored.jsonl")?.len() > MAX_MESSAGE_BYTES);
    Ok(())
}
