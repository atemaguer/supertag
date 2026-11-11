use anyhow::{bail, ensure, Context, Result};
use std::{io::Write, path::Path, pin::Pin, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, UnixListener},
    process::Command,
    sync::{mpsc, oneshot},
};
use tokio_stream::{
    wrappers::{ReceiverStream, TcpListenerStream, UnixListenerStream},
    Stream,
};
use tonic::{transport::Server, Code, Request, Response, Status, Streaming};

mod protocol {
    tonic::include_proto!("supertag.harness.spike");
}
mod live;
use live::LiveTask;
use protocol::{
    adapter_frame,
    harness_bridge_server::{HarnessBridge, HarnessBridgeServer},
    worker_frame, *,
};

type ControlSender = mpsc::Sender<Result<WorkerFrame, Status>>;
type RpcStream<T> = Pin<Box<dyn Stream<Item = Result<T, Status>> + Send>>;

enum Incoming {
    Attached(ControlSender),
    Control(AdapterFrame),
    Event(HarnessEvent, oneshot::Sender<Result<EventAck, Status>>),
    Rejected(Code),
    Disconnected,
}

struct Bridge {
    token: String,
    identity: Identity,
    inbox: mpsc::Sender<Incoming>,
    attached: std::sync::atomic::AtomicBool,
    publishing: std::sync::atomic::AtomicBool,
}

impl Bridge {
    fn authorize<T>(&self, request: &Request<T>) -> Result<(), Status> {
        let expected = format!("Bearer {}", self.token);
        if request
            .metadata()
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            != Some(expected.as_str())
        {
            return Err(Status::unauthenticated("Execution credential required"));
        }
        Ok(())
    }

    fn check_identity(&self, identity: Option<&Identity>) -> Result<(), Status> {
        if identity != Some(&self.identity) {
            return Err(Status::failed_precondition("Stale or foreign execution"));
        }
        Ok(())
    }

    async fn rejected(&self, status: Status) -> Status {
        let _ = self.inbox.send(Incoming::Rejected(status.code())).await;
        status
    }
}

#[tonic::async_trait]
impl HarnessBridge for Arc<Bridge> {
    type AttachStream = RpcStream<WorkerFrame>;
    type PublishEventsStream = RpcStream<EventAck>;

    async fn attach(
        &self,
        request: Request<Streaming<AdapterFrame>>,
    ) -> Result<Response<Self::AttachStream>, Status> {
        if let Err(error) = self.authorize(&request) {
            return Err(self.rejected(error).await);
        }
        if self
            .attached
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            return Err(Status::already_exists("Execution already attached"));
        }
        let mut input = request.into_inner();
        let (output, receiver) = mpsc::channel(8);
        self.inbox
            .send(Incoming::Attached(output.clone()))
            .await
            .map_err(|_| Status::unavailable("Worker stopped"))?;
        let bridge = self.clone();
        tokio::spawn(async move {
            while let Ok(Some(frame)) = input.message().await {
                if let Err(error) = bridge.check_identity(frame.identity.as_ref()) {
                    let error = bridge.rejected(error).await;
                    let _ = output.send(Err(error)).await;
                    return;
                }
                // Let the adapter half-close after Closed before dropping its request
                // body; early cancellation can otherwise reset an in-flight write.
                if bridge.inbox.send(Incoming::Control(frame)).await.is_err() {
                    return;
                }
            }
            let _ = bridge.inbox.send(Incoming::Disconnected).await;
        });
        Ok(Response::new(Box::pin(ReceiverStream::new(receiver))))
    }

    async fn publish_events(
        &self,
        request: Request<Streaming<HarnessEvent>>,
    ) -> Result<Response<Self::PublishEventsStream>, Status> {
        if let Err(error) = self.authorize(&request) {
            return Err(self.rejected(error).await);
        }
        if self
            .publishing
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            return Err(Status::already_exists("Event stream already open"));
        }
        let mut input = request.into_inner();
        let (output, receiver) = mpsc::channel(8);
        let bridge = self.clone();
        tokio::spawn(async move {
            while let Ok(Some(event)) = input.message().await {
                if let Err(error) = bridge.check_identity(event.identity.as_ref()) {
                    let _ = output.send(Err(bridge.rejected(error).await)).await;
                    return;
                }
                let (reply, result) = oneshot::channel();
                if bridge
                    .inbox
                    .send(Incoming::Event(event, reply))
                    .await
                    .is_err()
                {
                    return;
                }
                let Ok(response) = result.await else {
                    return;
                };
                let failed = response.is_err();
                if output.send(response).await.is_err() || failed {
                    return;
                }
            }
        });
        Ok(Response::new(Box::pin(ReceiverStream::new(receiver))))
    }
}

#[derive(Debug, PartialEq)]
enum Phase {
    Hello,
    Ready,
    Starting,
    Running,
    Stopping,
    Closing,
    Closed,
    Rejected,
}

struct Run {
    identity: Identity,
    language: &'static str,
    scenario: &'static str,
    phase: Phase,
    control: Option<ControlSender>,
    events: Vec<HarnessEvent>,
    outcome: Option<Outcome>,
    started: bool,
    cancelled: bool,
    late_outcome_rejected: bool,
    denied: Option<Code>,
    held_ack: Option<oneshot::Sender<Result<EventAck, Status>>>,
    offer: Offer,
    transcript: Option<std::fs::File>,
}

const PROMPT: &str = "streaming, cancellation, and final results";

impl Run {
    async fn send(&self, body: worker_frame::Body) -> Result<()> {
        self.control
            .as_ref()
            .context("Attach stream missing")?
            .send(Ok(WorkerFrame {
                identity: Some(self.identity.clone()),
                body: Some(body),
            }))
            .await
            .context("Adapter disconnected")
    }

    async fn cancel(&mut self) -> Result<()> {
        self.cancelled = true;
        self.phase = Phase::Stopping;
        self.send(worker_frame::Body::Cancel(Cancel {
            reason: "operator cancellation".into(),
        }))
        .await
    }

    async fn handle(&mut self, incoming: Incoming) -> Result<()> {
        match incoming {
            Incoming::Attached(sender) => {
                ensure!(self.control.is_none(), "Duplicate attachment");
                self.control = Some(sender);
            }
            Incoming::Rejected(code) => {
                self.denied = Some(code);
                self.phase = Phase::Rejected;
            }
            Incoming::Disconnected => {
                // The process exit and observed lifecycle determine the outcome below.
            }
            Incoming::Event(event, reply) => {
                ensure!(
                    matches!(
                        self.phase,
                        Phase::Starting | Phase::Running | Phase::Stopping
                    ),
                    "Event outside execution"
                );
                if event.sequence != self.events.len() as u64 + 1 {
                    self.denied = Some(Code::InvalidArgument);
                    self.phase = Phase::Rejected;
                    let _ = reply.send(Err(Status::invalid_argument(
                        "Non-contiguous event sequence",
                    )));
                    return Ok(());
                }
                ensure!(
                    !self.cancelled,
                    "Adapter emitted activity after cancellation"
                );
                if let Some(transcript) = self.transcript.as_mut() {
                    ensure!(
                        matches!(
                            event.kind.as_str(),
                            "assistant" | "command" | "file_change" | "status"
                        ),
                        "Unsupported live event kind"
                    );
                    let payload: serde_json::Value = if event.payload_json.is_empty() {
                        serde_json::Value::Null
                    } else {
                        serde_json::from_str(&event.payload_json)?
                    };
                    writeln!(
                        transcript,
                        "{}",
                        serde_json::json!({"sequence": event.sequence, "kind": event.kind, "text": event.text, "payload": payload})
                    )?;
                    transcript.flush()?;
                    if event.kind == "command" {
                        eprintln!(
                            "{}/{}: command event {}",
                            self.language, self.offer.task_id, event.sequence
                        );
                    }
                }
                self.events.push(event);
                if matches!(self.scenario, "cancel" | "cancel-late-outcome")
                    && self.events.len() == 1
                {
                    self.held_ack = Some(reply);
                    self.cancel().await?;
                } else {
                    let _ = reply.send(Ok(EventAck {
                        through_sequence: self.events.len() as u64,
                    }));
                }
            }
            Incoming::Control(frame) => {
                self.handle_control(frame.body.context("Empty adapter frame")?)
                    .await?
            }
        }
        Ok(())
    }

    async fn handle_control(&mut self, body: adapter_frame::Body) -> Result<()> {
        match body {
            adapter_frame::Body::Hello(hello) => {
                ensure!(self.phase == Phase::Hello, "Unexpected Hello");
                ensure!(
                    hello.language == self.language,
                    "Unexpected adapter language"
                );
                if hello.protocol_version != 1 {
                    self.denied = Some(Code::FailedPrecondition);
                    self.phase = Phase::Rejected;
                    self.control
                        .take()
                        .context("Missing control stream")?
                        .send(Err(Status::failed_precondition(
                            "Harness protocol version 1 required",
                        )))
                        .await?;
                    return Ok(());
                }
                self.send(worker_frame::Body::Welcome(Welcome {
                    protocol_version: 1,
                }))
                .await?;
                self.send(worker_frame::Body::Offer(self.offer.clone()))
                    .await?;
                self.phase = Phase::Ready;
            }
            adapter_frame::Body::Ready(_) => {
                ensure!(self.phase == Phase::Ready, "Unexpected Ready");
                self.phase = Phase::Starting;
                self.send(worker_frame::Body::Begin(Begin {})).await?;
            }
            adapter_frame::Body::Started(_) => {
                // Begin authorizes execution. Events on the other RPC can arrive before
                // Started, and can already have triggered cancellation or rejection.
                ensure!(
                    !self.started
                        && (matches!(self.phase, Phase::Starting | Phase::Stopping)
                            || (self.phase == Phase::Rejected
                                && self.denied == Some(Code::InvalidArgument))),
                    "Unexpected Started"
                );
                self.started = true;
                if self.phase == Phase::Starting {
                    self.phase = Phase::Running;
                }
            }
            adapter_frame::Body::Outcome(outcome) => {
                ensure!(
                    matches!(self.phase, Phase::Running | Phase::Stopping),
                    "Outcome outside execution"
                );
                ensure!(self.outcome.is_none(), "Duplicate final result");
                ensure!(self.started, "Outcome before Started");
                if self.cancelled {
                    self.send(worker_frame::Body::Receipt(Receipt {
                        outcome_id: outcome.id,
                        accepted: false,
                    }))
                    .await?;
                    self.late_outcome_rejected = true;
                    return Ok(());
                }
                ensure!(outcome.id == "final", "Wrong outcome ID");
                ensure!(
                    outcome.through_sequence == self.events.len() as u64 && !self.events.is_empty(),
                    "Incomplete event barrier"
                );
                if self.scenario == "live" {
                    ensure!(
                        !outcome.text.trim().is_empty(),
                        "Empty native final response"
                    );
                    ensure!(
                        outcome.commit.len() == 40
                            && outcome.commit.bytes().all(|b| b.is_ascii_hexdigit()),
                        "Missing Git commit"
                    );
                    uuid::Uuid::parse_str(&outcome.native_session_id)
                        .context("Missing native session ID")?;
                } else {
                    ensure!(
                        self.events.len() == 3,
                        "Wrong number of deterministic events"
                    );
                    let streamed = self
                        .events
                        .iter()
                        .map(|event| event.text.as_str())
                        .collect::<String>();
                    ensure!(
                        outcome.text == streamed,
                        "Final response differs from streamed text"
                    );
                    ensure!(
                        streamed == format!("[{}] {} complete.", self.language, PROMPT),
                        "Wrong result"
                    );
                }
                let outcome_id = outcome.id.clone();
                self.outcome = Some(outcome);
                self.send(worker_frame::Body::Receipt(Receipt {
                    outcome_id,
                    accepted: true,
                }))
                .await?;
                self.phase = Phase::Stopping;
                if self.scenario == "outcome-then-cancel" {
                    self.cancel().await?;
                } else {
                    self.send(worker_frame::Body::Quiesce(Quiesce {})).await?;
                }
            }
            adapter_frame::Body::Quiesced(quiesced) => {
                ensure!(self.phase == Phase::Stopping, "Unexpected Quiesced");
                ensure!(
                    quiesced.last_sequence == self.events.len() as u64,
                    "Unreceived event tail"
                );
                if let Some(reply) = self.held_ack.take() {
                    let _ = reply.send(Ok(EventAck {
                        through_sequence: quiesced.last_sequence,
                    }));
                }
                self.phase = Phase::Closing;
                self.send(worker_frame::Body::Close(Close {})).await?;
            }
            adapter_frame::Body::Closed(_) => {
                ensure!(self.phase == Phase::Closing, "Unexpected Closed");
                self.phase = Phase::Closed;
                self.control.take();
            }
        }
        Ok(())
    }

    fn verify(&self, exit: std::process::ExitStatus) -> Result<&'static str> {
        if self.scenario == "crash" {
            ensure!(exit.code() == Some(17), "Wrong crash exit status: {exit}");
            ensure!(
                self.started && self.events.len() == 1 && self.outcome.is_none(),
                "Crash produced unexpected result"
            );
            return Ok("uncertain");
        }
        ensure!(exit.success(), "Adapter failed: {exit}");
        let expected_denial = match self.scenario {
            "bad-auth" => Some(Code::Unauthenticated),
            "bad-version" | "stale-generation" => Some(Code::FailedPrecondition),
            "bad-sequence" => Some(Code::InvalidArgument),
            _ => None,
        };
        ensure!(
            self.denied == expected_denial,
            "Unexpected rejection: {:?}",
            self.denied
        );
        if expected_denial.is_some() {
            ensure!(
                self.events.is_empty() && self.outcome.is_none(),
                "Rejected adapter performed work"
            );
            return Ok("rejected");
        }
        ensure!(
            self.phase == Phase::Closed,
            "Adapter exited before clean shutdown: {:?}",
            self.phase
        );
        ensure!(self.started, "Execution was never started");
        if self.scenario == "live" {
            ensure!(
                !self.cancelled && self.outcome.is_some() && self.events.len() > 1,
                "Incomplete live execution"
            );
            for command in ["npm test", "npm run check"] {
                ensure!(
                    self.events.iter().any(|event| {
                        if event.kind != "command" {
                            return false;
                        }
                        let Ok(payload) =
                            serde_json::from_str::<serde_json::Value>(&event.payload_json)
                        else {
                            return false;
                        };
                        successful_check_event(&payload, command)
                    }),
                    "Native Task did not report a successful {command}"
                );
            }
            return Ok("completed");
        }
        ensure!(
            self.cancelled
                == matches!(
                    self.scenario,
                    "cancel" | "cancel-late-outcome" | "outcome-then-cancel"
                ),
            "Cancellation scenario was not exercised correctly"
        );
        if matches!(self.scenario, "cancel" | "cancel-late-outcome") {
            ensure!(
                self.events.len() == 1 && self.outcome.is_none(),
                "Cancelled run produced a final result"
            );
            ensure!(
                self.late_outcome_rejected == (self.scenario == "cancel-late-outcome"),
                "Late outcome test incomplete"
            );
            return Ok("cancelled");
        }
        ensure!(
            self.events.len() == 3 && self.outcome.is_some(),
            "Completed run missing final result"
        );
        Ok("completed")
    }
}

fn successful_check_event(payload: &serde_json::Value, command: &str) -> bool {
    if payload["exitCode"].as_i64() != Some(0)
        || payload["status"] != "completed"
        || !payload["command"]
            .as_str()
            .is_some_and(|value| value.contains(command))
    {
        return false;
    }
    let Some(output) = payload["output"].as_str() else {
        return false;
    };
    match command {
        "npm test" => {
            output.contains("\n> node --test\n") && output.lines().any(|line| line == "# fail 0")
        }
        "npm run check" => output
            .contains("\n> node --check src/duration.js && node --check test/duration.test.js\n"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::successful_check_event;
    use serde_json::json;

    #[test]
    fn command_names_alone_do_not_prove_checks_ran() {
        let mut event = json!({"command": "echo 'npm test'", "exitCode": 0, "status": "completed", "output": "npm test\n"});
        assert!(!successful_check_event(&event, "npm test"));
        event["command"] = json!("/bin/zsh -lc 'npm test && npm run check'");
        event["output"] = json!("\n> test\n> node --test\n\n# tests 6\n# pass 6\n# fail 0\n\n> check\n> node --check src/duration.js && node --check test/duration.test.js\n");
        assert!(successful_check_event(&event, "npm test"));
        assert!(successful_check_event(&event, "npm run check"));
        event["status"] = json!("in_progress");
        assert!(!successful_check_event(&event, "npm test"));
        event["status"] = json!("completed");
        event["exitCode"] = json!(1);
        assert!(!successful_check_event(&event, "npm run check"));
    }
}

async fn run_case(
    root: &Path,
    transport: &'static str,
    language: &'static str,
    scenario: &'static str,
    live: Option<&LiveTask>,
) -> Result<()> {
    let transcript = live
        .map(|task| std::fs::File::create(task.directory.join("events.jsonl")))
        .transpose()?;
    // Keep Unix socket paths below macOS's sockaddr_un limit, independently of checkout length.
    let temporary = tempfile::Builder::new()
        .prefix("st-harness-")
        .tempdir_in("/tmp")?;
    let identity = Identity {
        execution_id: uuid::Uuid::new_v4().to_string(),
        generation: 1,
    };
    let token = uuid::Uuid::new_v4().to_string();
    let (inbox, mut incoming) = mpsc::channel(32);
    let bridge = Arc::new(Bridge {
        token: token.clone(),
        identity: identity.clone(),
        inbox,
        attached: false.into(),
        publishing: false.into(),
    });
    let service = HarnessBridgeServer::new(bridge).max_decoding_message_size(256 * 1024);
    let (stop, stopped) = oneshot::channel();
    let (target, server) = match transport {
        "unix" => {
            let socket = temporary.path().join("worker.sock");
            let listener = UnixListener::bind(&socket)?;
            let target = format!("unix:{}", socket.display());
            let server = tokio::spawn(
                Server::builder()
                    .add_service(service)
                    .serve_with_incoming_shutdown(UnixListenerStream::new(listener), async {
                        let _ = stopped.await;
                    }),
            );
            (target, server)
        }
        "tcp" => {
            let listener = TcpListener::bind("127.0.0.1:0").await?;
            let target = listener.local_addr()?.to_string();
            let server = tokio::spawn(
                Server::builder()
                    .add_service(service)
                    .serve_with_incoming_shutdown(TcpListenerStream::new(listener), async {
                        let _ = stopped.await;
                    }),
            );
            (target, server)
        }
        _ => bail!("Unsupported transport"),
    };
    let mut command = match language {
        "typescript" => {
            let mut command = Command::new("node");
            command.args([
                "--import",
                "tsx",
                if live.is_some() {
                    "codex-adapter.ts"
                } else {
                    "adapter.ts"
                },
            ]);
            command
        }
        "python" => {
            let mut command = Command::new(root.join(".venv/bin/python"));
            command.arg(if live.is_some() {
                "codex_adapter.py"
            } else {
                "adapter.py"
            });
            command
        }
        _ => bail!("Unsupported adapter"),
    };
    command
        .current_dir(root)
        // The fixture needs no credentials inherited from the operator's shell.
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default());
    if let Some(live) = live {
        command
            .env("HOME", live.home.path())
            .env("CODEX_HOME", live.home.path().join(".codex"));
    }
    let child = command
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(error) => {
            let _ = stop.send(());
            server.abort();
            let _ = server.await;
            return Err(error).context("Start harness adapter");
        }
    };
    let child_pid = child.id().context("Adapter PID missing")?;
    let mut group = live::ProcessGroup(child_pid);
    let bootstrap = serde_json::json!({
        "target": target, "token": token, "executionId": identity.execution_id,
        "generation": identity.generation, "scenario": scenario,
        "codexPath": live.map(|task| &task.codex_path),
        "timeoutSeconds": if live.is_some() { 600 } else { 10 }
    });
    let mut run = Run {
        identity,
        language,
        scenario,
        phase: Phase::Hello,
        control: None,
        events: Vec::new(),
        outcome: None,
        started: false,
        cancelled: false,
        late_outcome_rejected: false,
        denied: None,
        held_ack: None,
        offer: live
            .map(|task| task.offer.clone())
            .unwrap_or_else(|| Offer {
                prompt: PROMPT.into(),
                scenario: scenario.into(),
                ..Default::default()
            }),
        transcript,
    };
    let result = tokio::time::timeout(Duration::from_secs(if live.is_some() { 620 } else { 15 }), async {
        let mut input = child.stdin.take().context("Missing bootstrap pipe")?;
        input.write_all(format!("{bootstrap}\n").as_bytes()).await?;
        input.shutdown().await?;
        drop(input);
        loop {
            tokio::select! {
                event = incoming.recv() => run.handle(event.context("Worker inbox closed")?).await?,
                status = child.wait() => {
                    // Drain frames that arrived just before process exit.
                    while let Ok(event) = incoming.try_recv() { run.handle(event).await?; }
                    break run.verify(status?);
                }
            }
        }
    })
    .await;
    // Terminate any native harness descendants even when the adapter crashed or hung.
    let had_survivors = group.terminate();
    let child_cleanup: Result<()> = async {
        if child.try_wait()?.is_none() {
            child.kill().await?;
        }
        child.wait().await?;
        Ok(())
    }
    .await;
    // Always join the server, even after an assertion or an adapter timeout.
    drop(run.control.take());
    drop(run.held_ack.take());
    let _ = stop.send(());
    let mut server = server;
    match tokio::time::timeout(Duration::from_secs(2), &mut server).await {
        Ok(result) => result??,
        Err(_) => {
            server.abort();
            let _ = server.await;
        }
    }
    child_cleanup?;
    let status = result.context("Adapter case timed out")??;
    ensure!(
        !had_survivors,
        "Adapter exited with native child processes still running"
    );
    if let Some(live) = live {
        let outcome = run.outcome.as_ref().context("Missing live outcome")?;
        let report = live.verify(root, outcome).await?;
        std::fs::write(
            live.directory.join("result.json"),
            serde_json::to_vec_pretty(&report)?,
        )?;
        std::fs::write(live.directory.join("result.md"), &outcome.text)?;
        println!("{report}");
        return Ok(());
    }
    println!(
        "{}",
        serde_json::json!({
            "transport": transport, "language": language, "scenario": scenario, "status": status,
            "events": run.events.len(), "result": run.outcome.as_ref().map(|outcome| &outcome.text),
            "adapterPid": child_pid, "adapterReaped": true
        })
    );
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let root = args.next().context("Pass the fixture directory")?;
    let root = Path::new(&root).canonicalize()?;
    if let Some(mode) = args.next() {
        ensure!(
            mode == "--live",
            "Expected --live OUTPUT_DIRECTORY [typescript|python]"
        );
        let output = args.next().context("Pass a live output directory")?;
        let output = std::path::absolute(output)?;
        std::fs::create_dir_all(&output)?;
        let selected = args.next();
        ensure!(
            selected
                .as_deref()
                .is_none_or(|value| matches!(value, "typescript" | "python")),
            "Unknown language"
        );
        for language in ["typescript", "python"] {
            if selected.as_deref().is_some_and(|value| value != language) {
                continue;
            }
            let live = LiveTask::prepare(&root, &output, language).await?;
            eprintln!(
                "Starting {language} Task {} with gpt-6.1-sol medium in {}",
                live.offer.task_id, live.offer.workspace
            );
            run_case(&root, "unix", language, "live", Some(&live))
                .await
                .with_context(|| {
                    format!(
                        "Live {language} Task; evidence: {}",
                        live.directory.display()
                    )
                })?;
        }
        println!("PASS real Codex Task checks and reviewable commits");
        return Ok(());
    }
    let mut passed = 0;
    for transport in ["unix", "tcp"] {
        for language in ["typescript", "python"] {
            for scenario in [
                "normal",
                "cancel",
                "cancel-late-outcome",
                "outcome-then-cancel",
                "bad-auth",
                "bad-version",
                "stale-generation",
                "bad-sequence",
                "crash",
            ] {
                run_case(&root, transport, language, scenario, None)
                    .await
                    .with_context(|| format!("{transport}/{language}/{scenario}"))?;
                passed += 1;
            }
        }
    }
    println!("PASS {passed} Rust Worker / harness adapter interoperability cases");
    Ok(())
}
