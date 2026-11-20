//! One owned stdio App Server, one native thread, and exactly one started turn.
//! A taken input is written once with the native expected-turn precondition.
use std::{future::Future, pin::Pin, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use supertag_protocol::v2::{
    HarnessPublishTextRequest, HarnessSettleLiveInputRequest, HarnessTakeLiveInputRequest,
    HarnessUsageRequest, LiveInput, LiveInputReceipt, LiveInputState, NativeTokenUsage,
    TakeInputResponse, Task, TaskEventKind, harness_client::HarnessClient,
};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    process::{ChildStdin, ChildStdout},
    sync::mpsc,
    task::JoinHandle,
    time::{self, Instant},
};
use tonic::{Code, transport::Channel};

use crate::{
    MAX_STREAM, RPC_TIMEOUT, STARTUP_TIMEOUT, auth, checkpoint::UsageCounters, config::Policy,
    events, publish, read_line, request, transient,
};

type Take = Pin<Box<dyn Future<Output = (Instant, Result<Option<TakeInputResponse>>)> + Send>>;

struct Transport {
    input: Option<ChildStdin>,
    output: mpsc::Receiver<Result<Value>>,
    reader: JoinHandle<()>,
    next_id: u64,
}

impl Drop for Transport {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

impl Transport {
    fn new(input: ChildStdin, output: ChildStdout) -> Self {
        let (send, receive) = mpsc::channel(16);
        let reader = tokio::spawn(async move {
            let mut reader = BufReader::new(output);
            let mut total = 0usize;
            let mut count = 0usize;
            loop {
                let next = async {
                    let Some(line) = read_line(&mut reader).await? else {
                        return Ok(None);
                    };
                    total += line.len();
                    count += 1;
                    ensure!(
                        total <= MAX_STREAM && count <= 100_000,
                        "Codex event stream exceeds its limit"
                    );
                    if line.iter().all(u8::is_ascii_whitespace) {
                        return Ok(Some(Value::Null));
                    }
                    let value: Value =
                        serde_json::from_slice(&line).context("Codex emitted malformed JSON")?;
                    ensure!(value.is_object(), "Codex emitted malformed JSON");
                    Ok::<_, anyhow::Error>(Some(value))
                }
                .await;
                match next {
                    Ok(None) => break,
                    Ok(Some(Value::Null)) => continue,
                    Ok(Some(value)) => {
                        if send.send(Ok(value)).await.is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = send.send(Err(error)).await;
                        break;
                    }
                }
            }
        });
        Self {
            input: Some(input),
            output: receive,
            reader,
            next_id: 0,
        }
    }

    async fn write(&mut self, value: Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(&value).context("could not encode Codex request")?;
        ensure!(
            bytes.len() <= crate::MAX_LINE,
            "Codex request exceeds its limit"
        );
        bytes.push(b'\n');
        time::timeout(
            RPC_TIMEOUT,
            self.input
                .as_mut()
                .context("Codex request pipe is closed")?
                .write_all(&bytes),
        )
        .await
        .context("Codex request timed out")?
        .context("could not send Codex request")
    }

    async fn send(&mut self, method: &str, params: Value) -> Result<u64> {
        self.next_id += 1;
        let id = self.next_id;
        self.write(json!({"id":id,"method":method,"params":params}))
            .await?;
        Ok(id)
    }

    async fn deny_request(&mut self, value: &Value) -> Result<bool> {
        if value.get("method").is_none() || value.get("id").is_none() {
            return Ok(false);
        }
        let id = value.get("id").cloned().context("invalid Codex request")?;
        let reply = match value["method"].as_str() {
            Some("item/commandExecution/requestApproval" | "item/fileChange/requestApproval") => {
                json!({"id":id,"result":{"decision":"decline"}})
            }
            _ => {
                json!({"id":id,"error":{"code":-32601,"message":"Native request is not admitted by this Harness"}})
            }
        };
        self.write(reply).await?;
        Ok(true)
    }

    async fn call(
        &mut self,
        method: &str,
        params: Value,
        buffered: &mut Vec<Value>,
    ) -> Result<Value> {
        let id = self.send(method, params).await?;
        // The first answer also waits for the app server process to start, which a loaded
        // machine can stretch past one exchange's bound. Starting or resuming a thread connects
        // its environment: on a remote Workspace that starts the exec-server in the sandbox and
        // reads its configuration there.
        let limit = if matches!(method, "initialize" | "thread/start" | "thread/resume") {
            STARTUP_TIMEOUT
        } else {
            RPC_TIMEOUT
        };
        time::timeout(limit, async {
            loop {
                let value = self
                    .output
                    .recv()
                    .await
                    .context("Codex process ended before acknowledging its request")??;
                if value["method"] == "item/tool/call" {
                    ensure!(
                        buffered.len() < 128,
                        "Codex emitted too many startup requests"
                    );
                    buffered.push(value);
                    continue;
                }
                if self.deny_request(&value).await? {
                    continue;
                }
                if value.get("method").is_some() {
                    ensure!(
                        buffered.len() < 128,
                        "Codex emitted too many startup notifications"
                    );
                    buffered.push(value);
                    continue;
                }
                ensure!(
                    value["id"].as_u64() == Some(id),
                    "Codex returned an unexpected response identity"
                );
                if let Some(error) = value.get("error") {
                    // terminal-safe: standard error reaches only the Worker Host log, which redacts it.
                    eprintln!("Codex rejected {method}: {error}");
                    bail!("Codex rejected an execution request");
                }
                return value
                    .get("result")
                    .filter(|result| result.is_object())
                    .cloned()
                    .context("Codex returned an invalid response");
            }
        })
        .await
        .with_context(|| format!("Codex did not answer {method} within {}s", limit.as_secs()))?
    }
}

struct Stream {
    native: events::Stream,
    thread: String,
    turn: Option<String>,
    completed: bool,
    baseline: Option<UsageCounters>,
    total: Option<UsageCounters>,
    max_reported_tokens: Option<u64>,
    budget_reached: bool,
    observed_model: Option<String>,
    configured_model: Option<String>,
    usage_sequence: u64,
    sequence: u64,
    turn_requested: bool,
    resumed: bool,
    inventory: crate::questions::Tools,
    /// Commands are admitted, but the code-mode host stays off; see `config::code_mode_host`.
    commands_without_code_mode: bool,
    /// The turn runs Codex's memory consolidation, whose spend Codex doesn't report: its usage
    /// carries no cost, so the Attempt counts as unpriced.
    unpriced: bool,
    /// Unknown progress notifications already logged, so each is logged once.
    unknown_progress: std::collections::HashSet<String>,
}

impl Stream {
    fn new(
        policy: Policy,
        thread: String,
        expected_thread: Option<String>,
        baseline: Option<UsageCounters>,
        inventory: crate::questions::Tools,
        max_reported_tokens: Option<u64>,
        configured_model: Option<String>,
    ) -> Result<Self> {
        let resumed = expected_thread.is_some();
        let commands_without_code_mode = policy.commands && !crate::config::code_mode_host(&policy);
        let unpriced = policy.consolidate.is_some();
        let mut native = events::Stream::new(policy, expected_thread);
        native.accept(&serde_json::to_vec(
            &json!({"type":"thread.started","thread_id":thread}),
        )?)?;
        Ok(Self {
            native,
            thread,
            turn: None,
            completed: false,
            baseline,
            total: None,
            max_reported_tokens,
            budget_reached: false,
            observed_model: None,
            configured_model,
            usage_sequence: 0,
            sequence: 0,
            turn_requested: false,
            resumed,
            inventory,
            commands_without_code_mode,
            unpriced,
            unknown_progress: Default::default(),
        })
    }

    fn model(&mut self, value: &Value) -> Result<()> {
        if let Some(model) = value.get("model").filter(|v| !v.is_null()) {
            let model = model
                .as_str()
                .filter(|model| {
                    !model.is_empty() && model.len() <= 256 && !model.chars().any(char::is_control)
                })
                .context("Codex reported an invalid model")?;
            self.observed_model = Some(model.into());
        }
        Ok(())
    }

    fn turn(&mut self, turn: &str) -> Result<()> {
        ensure!(
            crate::checkpoint::thread_identity(turn),
            "Codex turn identity is invalid"
        );
        ensure!(
            self.turn.as_deref().is_none_or(|expected| expected == turn),
            "Codex returned a different active turn"
        );
        self.turn = Some(turn.into());
        Ok(())
    }

    async fn notification(
        &mut self,
        value: Value,
        harness: &mut HarnessClient<Channel>,
        token: &str,
        secrets: &[String],
    ) -> Result<()> {
        let method = value["method"]
            .as_str()
            .context("Codex event is missing its type")?;
        let params = &value["params"];
        if method == "thread/started" {
            ensure!(
                params["thread"]["id"].as_str() == Some(self.thread.as_str()),
                "Codex started an unexpected thread"
            );
            self.model(&params["thread"])?;
            return Ok(());
        }
        if method.starts_with("codex/event/") {
            return Ok(());
        } // duplicate legacy notifications
        if let Some(thread) = params.get("threadId") {
            ensure!(
                thread.as_str() == Some(self.thread.as_str()),
                "Codex emitted work for an unowned thread"
            );
        } else if method.starts_with("item/") || method.starts_with("turn/") {
            bail!("Codex emitted work without its thread identity");
        }
        if self.turn_requested
            && method != "thread/tokenUsage/updated"
            && let Some(turn) = params.get("turnId").and_then(Value::as_str)
        {
            self.turn(turn)?;
        }
        match method {
            "remoteControl/status/changed" => ensure!(
                params["status"] == "disabled",
                "Codex remote control must remain disabled"
            ),
            "turn/started" => {
                ensure!(
                    !self.completed,
                    "Codex emitted events after its completed turn"
                );
                self.turn(
                    params["turn"]["id"]
                        .as_str()
                        .context("Codex turn identity is invalid")?,
                )?;
                self.model(&params["turn"])?;
            }
            "turn/completed" => {
                ensure!(
                    !self.completed,
                    "Codex emitted events after its completed turn"
                );
                ensure!(
                    params["turn"]["id"].as_str() == self.turn.as_deref(),
                    "Codex completed an unexpected turn"
                );
                ensure!(
                    params["turn"]["status"] == "completed",
                    "Codex reported a failed turn"
                );
                self.completed = true;
            }
            // The pinned server may publish this informational field before
            // any content. Its owned thread and turn were validated above.
            "turn/moderationMetadata" => {
                ensure!(
                    self.turn_requested
                        && !self.completed
                        && params["turnId"].as_str() == self.turn.as_deref(),
                    "Codex moderation metadata belongs to an inactive turn"
                );
            }
            // The model's plan, shown while the Task runs, as TypeScript shows Codex
            // `todo_list` items (`taskProgressFromCodexTodo`). Progress is cosmetic: a plan for
            // another turn or one this adapter cannot read is skipped, never fatal.
            "turn/plan/updated" => {
                let active = self.turn_requested
                    && !self.completed
                    && params["turnId"].as_str() == self.turn.as_deref();
                if let Some(progress) = active.then(|| plan_progress(params)).flatten() {
                    publish(
                        harness,
                        token,
                        &mut self.sequence,
                        TaskEventKind::Progress,
                        &auth::redact(progress, secrets),
                    )
                    .await?;
                }
            }
            "thread/tokenUsage/updated" => {
                ensure!(
                    params["threadId"].as_str() == Some(&self.thread),
                    "Codex usage has no owned thread identity"
                );
                let usage = &params["tokenUsage"]["total"];
                let read = |key| {
                    usage
                        .get(key)
                        .and_then(Value::as_u64)
                        .context("Codex completed with invalid usage")
                };
                let total = [
                    read("inputTokens")?,
                    read("cachedInputTokens")?,
                    read("outputTokens")?,
                ];
                let reported = usage
                    .get("totalTokens")
                    .map(|_| read("totalTokens"))
                    .transpose()?;
                if self.turn_requested && params["turnId"].as_str() != self.turn.as_deref() {
                    // Resume can acknowledge before publishing the old turn's
                    // final total. It is only a baseline, never current work.
                    ensure!(
                        self.resumed
                            && self
                                .baseline
                                .is_some_and(|(previous, reported_before)| previous == total
                                    && reported_before.is_none_or(|count| Some(count) == reported)),
                        "Codex usage belongs to a different active turn"
                    );
                    return Ok(());
                }
                ensure!(total[1] <= total[0], "Codex completed with invalid usage");
                if !self.turn_requested {
                    if let Some((baseline, reported_before)) = self.baseline {
                        ensure!(
                            baseline == total
                                && reported_before.is_none_or(|count| Some(count) == reported),
                            "Codex resume usage does not match its checkpoint"
                        );
                    }
                    self.baseline = Some((total, reported));
                    return Ok(());
                }
                let (baseline, reported_before) = self
                    .baseline
                    .context("Codex resume usage baseline is unavailable")?;
                ensure!(
                    total
                        .iter()
                        .zip(baseline)
                        .all(|(current, previous)| *current >= previous),
                    "Codex cumulative usage precedes its baseline"
                );
                if let Some((previous, previous_reported)) = self.total {
                    ensure!(
                        total
                            .iter()
                            .zip(previous)
                            .all(|(current, previous)| *current >= previous)
                            && previous_reported
                                .is_none_or(|count| reported.is_some_and(|next| next >= count)),
                        "Codex cumulative usage decreased"
                    );
                }
                if self.total == Some((total, reported)) {
                    return Ok(());
                }
                let total_tokens = reported
                    .zip(reported_before)
                    .map(|(total, before)| {
                        total
                            .checked_sub(before)
                            .context("Codex reported total tokens precede the baseline")
                    })
                    .transpose()?;
                self.budget_reached = self
                    .max_reported_tokens
                    .zip(total_tokens)
                    .is_some_and(|(limit, measured)| measured >= limit);
                self.total = Some((total, reported));
                self.usage_sequence += 1;
                let observed_model = self
                    .observed_model
                    .clone()
                    .filter(|model| auth::redact(model.clone(), secrets) == *model);
                let usage = NativeTokenUsage {
                    input_tokens: total[0] - baseline[0],
                    cached_input_tokens: total[1] - baseline[1],
                    output_tokens: total[2] - baseline[2],
                    observed_model,
                    total_tokens,
                };
                ensure!(
                    usage.cached_input_tokens <= usage.input_tokens
                        && usage
                            .input_tokens
                            .checked_add(usage.output_tokens)
                            .is_some_and(|count| {
                                usage.total_tokens.is_none_or(|total| total >= count)
                            }),
                    "Codex completed with invalid usage"
                );
                let amount_minor = crate::pricing::estimated_cost_minor(
                    self.observed_model
                        .as_deref()
                        .or(self.configured_model.as_deref()),
                    &usage,
                )
                .filter(|_| !self.unpriced);
                let recording = report_usage(
                    harness,
                    token,
                    HarnessUsageRequest {
                        sequence: self.usage_sequence,
                        native_usage: Some(usage),
                        amount_minor,
                        currency: amount_minor.map(|_| "USD".to_owned()),
                        estimated: amount_minor.is_some(),
                    },
                );
                if self.budget_reached {
                    // A lost usage acknowledgement cannot leave the native
                    // turn running indefinitely beyond its reported ceiling.
                    time::timeout(Duration::from_secs(1), recording)
                        .await
                        .context(
                            "Codex token ceiling reached without a confirmed usage receipt",
                        )??;
                    bail!("Codex reported token budget exceeded");
                }
                recording.await?;
                ensure!(
                    self.max_reported_tokens.is_none() || total_tokens.is_some(),
                    "Codex token budget cannot be verified without valid usage"
                );
            }
            "item/started" | "item/completed" => {
                ensure!(
                    self.turn_requested,
                    "Codex emitted work before its active turn"
                );
                ensure!(
                    !self.completed,
                    "Codex emitted events after its completed turn"
                );
                let mut item = params["item"].clone();
                match item["type"].as_str() {
                    Some(
                        "userMessage" | "reasoning" | "plan" | "contextCompaction" | "imageView"
                        | "sleep",
                    ) => return Ok(()),
                    Some("agentMessage") => item["type"] = json!("agent_message"),
                    Some("commandExecution") => {
                        item["type"] = json!("command_execution");
                        item["aggregated_output"] = item
                            .get("aggregatedOutput")
                            .filter(|v| !v.is_null())
                            .cloned()
                            .unwrap_or(json!(""));
                        if item["status"] == "inProgress" {
                            item["status"] = json!("in_progress");
                        }
                    }
                    Some("fileChange") => {
                        item["type"] = json!("file_change");
                        if method == "item/started" {
                            item["status"] = json!("completed");
                        }
                    }
                    Some("dynamicToolCall") => {
                        ensure!(
                            self.inventory.enabled(),
                            "Codex emitted an unregistered coordination tool item"
                        );
                        // A read argument the model may correct comes back to it as a tool error.
                        match self.inventory.arguments(&item) {
                            Err(error) if crate::coordination::retryable(&error).is_none() => {
                                return Err(error);
                            }
                            _ => return Ok(()),
                        }
                    }
                    Some("webSearch") => item["type"] = json!("web_search"),
                    _ => bail!("Codex emitted an unsupported tool or item"),
                }
                let normalized = json!({"type":if method=="item/completed" {"item.completed"}else{"item.started"},"item":item});
                if let Some((kind, text)) = self.native.accept(&serde_json::to_vec(&normalized)?)? {
                    let text = auth::redact(text, secrets);
                    // Activity is cut to length only once redacted, so no partial secret shows.
                    let text = if kind == TaskEventKind::Activity {
                        events::shorten(text)
                    } else {
                        text
                    };
                    publish(harness, token, &mut self.sequence, kind, &text).await?;
                }
            }
            // Codex reports a transient failure it retries itself, such as a dropped model
            // stream, with `willRetry`. Only an error it gives up on fails the turn. The message
            // goes to standard error, which only the redacting Worker Host log reads, because
            // provider errors can quote credentials.
            "error" if params["willRetry"] == true => {
                // terminal-safe: read only by the redacting Worker Host log.
                eprintln!("Codex is retrying after an error: {}", params["error"]);
            }
            "error" => {
                // terminal-safe: read only by the redacting Worker Host log.
                eprintln!("Codex reported a failed turn: {}", params["error"]);
                bail!("Codex reported a failed turn")
            }
            // A code-mode-only model has no other command tool, so it would answer that commands
            // are disabled and the Task would succeed without them. Neither the Control Plane nor
            // `model/list` exposes a model's tool mode, so the earliest sign is this warning, sent
            // when the turn starts and before the model acts.
            "warning"
                if self.commands_without_code_mode
                    && params["message"]
                        .as_str()
                        .is_some_and(|message| message.contains("code-mode host is disabled")) =>
            {
                bail!(
                    "Codex model {} needs Codex code mode to run commands, and SuperTag starts \
                     code mode only when the Task also has web:fetch, because code-mode commands \
                     can reach the network that the commands:execute sandbox otherwise blocks. \
                     Grant the Tag web:fetch, or select a Codex model that is not code-mode-only",
                    self.configured_model
                        .as_deref()
                        .or(self.observed_model.as_deref())
                        .unwrap_or("default")
                )
            }
            // The reply text as Codex writes it, shown while the turn runs. The completed
            // `agentMessage` item is the authoritative message and replaces it; text for
            // another turn is skipped.
            "item/agentMessage/delta" => {
                let active = self.turn_requested
                    && !self.completed
                    && params["turnId"].as_str() == self.turn.as_deref();
                if let Some(delta) = params["delta"]
                    .as_str()
                    .filter(|delta| active && !delta.is_empty())
                {
                    harness
                        .publish_text(request(
                            HarnessPublishTextRequest {
                                after_sequence: self.sequence,
                                text: delta.to_owned(),
                            },
                            token,
                        )?)
                        .await
                        .context("could not show Codex's reply as it is written")?;
                }
            }
            method => match crate::notifications::classify(method) {
                // A handled method whose arm above didn't apply, such as an ordinary `warning`.
                crate::notifications::Kind::Handled | crate::notifications::Kind::Ignored => {}
                // An unknown notification shaped like progress: a newer Codex's update about
                // work the completed item restates. Logged once per method, never shown.
                crate::notifications::Kind::Progress => {
                    if self.unknown_progress.insert(method.to_owned()) {
                        // terminal-safe: read only by the redacting Worker Host log.
                        eprintln!(
                            "Ignoring Codex notification {}, which this adapter doesn't know",
                            auth::redact(method.to_owned(), secrets)
                        );
                    }
                }
                _ if crate::notifications::plain(method) => bail!(
                    "Codex emitted an unsupported event type: {}",
                    auth::redact(method.to_owned(), secrets)
                ),
                _ => bail!("Codex emitted an unsupported event type"),
            },
        }
        Ok(())
    }

    fn finish(mut self, quiet: bool) -> Result<(String, String)> {
        ensure!(
            self.completed,
            "Codex process ended without a completed turn"
        );
        let (total, _) = self.total.context("Codex completed without valid usage")?;
        let (baseline, _) = self
            .baseline
            .context("Codex resume usage baseline is unavailable")?;
        self.native.accept(&serde_json::to_vec(&json!({"type":"turn.completed","usage":{"input_tokens":total[0]-baseline[0],"cached_input_tokens":total[1]-baseline[1],"output_tokens":total[2]-baseline[2]}}))?)?;
        let _ = self.native.take_usage();
        self.native.finish(quiet)
    }

    fn budget_advisory(&self) -> Option<String> {
        let ceiling = self.max_reported_tokens?;
        let (_, current) = self.total?;
        let (_, baseline) = self.baseline?;
        let measured = current?.checked_sub(baseline?)?;
        let remaining = ceiling.checked_sub(measured)?;
        (measured * 5 >= ceiling * 4 && remaining >= 4096).then(|| format!(
            "SuperTag budget: {measured} of {ceiling} reported tokens; {remaining} remain. The limit remains in effect and usage reports can arrive late."
        ))
    }
}

async fn report_usage(
    harness: &mut HarnessClient<Channel>,
    token: &str,
    usage: HarnessUsageRequest,
) -> Result<()> {
    for retry in 0..3 {
        match harness.report_usage(request(usage.clone(), token)?).await {
            Ok(_) => return Ok(()),
            Err(status)
                if retry < 2
                    && matches!(status.code(), Code::Unavailable | Code::DeadlineExceeded) =>
            {
                time::sleep(Duration::from_millis(50)).await;
            }
            Err(_) => bail!("could not record Codex token usage"),
        }
    }
    unreachable!()
}

async fn settle(
    harness: &mut HarnessClient<Channel>,
    token: &str,
    input: &LiveInput,
    receipt: LiveInputReceipt,
) -> Result<()> {
    for attempt in 0..3 {
        let response = harness
            .settle_live_input(request(
                HarnessSettleLiveInputRequest {
                    input_id: input.input_id.clone(),
                    receipt: receipt as i32,
                },
                token,
            )?)
            .await;
        match response {
            Ok(response) => {
                let returned = response.into_inner();
                ensure!(
                    returned.input_id == input.input_id
                        && returned.task_id == input.task_id
                        && returned.attempt_id == input.attempt_id,
                    "Codex input receipt has mismatched identity"
                );
                return Ok(());
            }
            Err(status)
                if attempt < 2
                    && matches!(
                        status.code(),
                        tonic::Code::Unavailable | tonic::Code::DeadlineExceeded
                    ) =>
            {
                time::sleep(Duration::from_millis(50)).await
            }
            Err(_) => bail!("could not record Codex live input receipt"),
        }
    }
    unreachable!()
}

async fn respond_tool(
    transport: &mut Transport,
    stream: &Stream,
    questions: &mut crate::questions::Bridge,
    value: &Value,
) -> Result<bool> {
    if value["method"] != "item/tool/call" {
        return Ok(false);
    }
    ensure!(
        stream.turn_requested && !stream.completed && stream.turn.is_some(),
        "Codex requested a coordination tool outside its active turn"
    );
    let params = &value["params"];
    ensure!(
        params["threadId"].as_str() == Some(stream.thread.as_str())
            && params["turnId"].as_str() == stream.turn.as_deref(),
        "Codex coordination call belongs to an unowned thread or turn"
    );
    let id = value
        .get("id")
        .filter(|id| {
            id.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 256)
                || id.as_i64().is_some()
                || id.as_u64().is_some()
        })
        .context("Codex request identity is invalid")?;
    let result = questions.call(params).await?;
    transport.write(json!({"id": id,"result":result})).await?;
    Ok(true)
}

async fn restrict_skills(
    transport: &mut Transport,
    cwd: &Value,
    admitted: &std::collections::BTreeSet<String>,
    buffered: &mut Vec<Value>,
) -> Result<()> {
    let params = json!({"cwds":[cwd], "forceReload":true});
    let response = transport
        .call("skills/list", params.clone(), buffered)
        .await?;
    let mut found = std::collections::BTreeSet::new();
    for (path, enabled) in crate::skills::inventory(&response)? {
        let selected = admitted.contains(&path);
        if selected {
            found.insert(path.clone());
        }
        if enabled != selected {
            let receipt = transport
                .call(
                    "skills/config/write",
                    json!({"path":path, "enabled":selected}),
                    buffered,
                )
                .await?;
            ensure!(
                receipt["effectiveEnabled"].as_bool() == Some(selected),
                "Codex did not apply admitted Skill configuration"
            );
        }
    }
    ensure!(
        &found == admitted,
        "Codex did not discover every admitted Skill"
    );
    let response = transport.call("skills/list", params, buffered).await?;
    let enabled: std::collections::BTreeSet<_> = crate::skills::inventory(&response)?
        .into_iter()
        .filter_map(|(path, enabled)| enabled.then_some(path))
        .collect();
    ensure!(
        &enabled == admitted,
        "Codex Skill configuration includes unadmitted packages"
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn execute(
    input: ChildStdin,
    output: ChildStdout,
    task: &Task,
    attempt_id: &str,
    params: Value,
    policy: Policy,
    admitted_skills: &std::collections::BTreeSet<String>,
    expected_thread: Option<String>,
    recap: &str,
    baseline: Option<UsageCounters>,
    max_reported_tokens: Option<u64>,
    harness: &mut HarnessClient<Channel>,
    questions: &mut crate::questions::Bridge,
    token: &str,
    secrets: &[String],
) -> Result<(String, String)> {
    let mut transport = Transport::new(input, output);
    let mut buffered = Vec::new();
    transport.call("initialize",json!({"clientInfo":{"name":"supertag","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":questions.enabled()}}),&mut buffered).await?;
    transport
        .write(json!({"method":"initialized","params":{}}))
        .await?;
    let configuration = transport
        .call(
            "config/read",
            json!({"cwd":params["cwd"],"includeLayers":true}),
            &mut buffered,
        )
        .await?;
    for layer in configuration["layers"]
        .as_array()
        .context("Codex did not report configuration provenance")?
    {
        if matches!(layer["name"]["type"].as_str(), Some("project" | "user"))
            && layer
                .get("disabledReason")
                .and_then(Value::as_str)
                .is_none_or(|reason| reason.is_empty())
        {
            ensure!(
                layer["config"]
                    .as_object()
                    .is_some_and(|config| config.is_empty()),
                "Codex refuses active project or user configuration"
            );
        }
    }
    restrict_skills(
        &mut transport,
        &params["cwd"],
        admitted_skills,
        &mut buffered,
    )
    .await?;
    let mut params = params;
    let method = if let Some(thread) = &expected_thread {
        params["threadId"] = json!(thread);
        params["excludeTurns"] = json!(true);
        "thread/resume"
    } else {
        params["ephemeral"] = json!(false);
        if questions.enabled() {
            params["dynamicTools"] = questions.tools();
        }
        "thread/start"
    };
    let configured_model = params["model"].as_str().map(str::to_owned);
    let response = transport.call(method, params, &mut buffered).await?;
    let thread = response["thread"]["id"]
        .as_str()
        .filter(|id| crate::checkpoint::thread_identity(id))
        .context("Codex thread identity is invalid")?
        .to_owned();
    let memory = policy.memory;
    let consolidation = policy.consolidate.clone();
    let mut stream = Stream::new(
        policy,
        thread,
        expected_thread,
        baseline,
        questions.inventory(),
        max_reported_tokens,
        configured_model,
    )?;
    stream.model(&response)?;
    for notification in buffered.drain(..) {
        if respond_tool(&mut transport, &stream, questions, &notification).await? {
            continue;
        }
        stream
            .notification(notification, harness, token, secrets)
            .await?;
    }
    ensure!(
        stream.baseline.is_some(),
        "Codex resume usage baseline is unavailable"
    );
    ensure!(
        stream.max_reported_tokens.is_none()
            || stream.baseline.is_some_and(|(_, total)| total.is_some()),
        "Codex token budget requires a verified reported-token baseline"
    );
    stream.turn_requested = true;
    let portfolio = questions.portfolio();
    // No turn guidance: Codex opens a longer turn with a short message on its own (measured
    // 2026-11-18: 10 of 10 turns with and without it), unlike Claude Code.
    let mut prompt = format!("Tag instructions:\n{}\n\n", task.instructions);
    let harness_memory = memory.then_some(supertag_protocol::HarnessMemory::Codex);
    prompt.push_str(&format!(
        "{}\n\n",
        supertag_protocol::memory_context(questions.may_remember(), harness_memory)
    ));
    if let Some(note) = supertag_protocol::web_access_note(&task.allowed_actions) {
        prompt.push_str(&format!("{note}\n\n"));
    }
    if !portfolio.is_empty() {
        prompt.push_str(&format!("SuperTag context:\n{portfolio}\n\n"));
    }
    if !recap.is_empty() {
        prompt.push_str(&format!("{recap}\n\n"));
    }
    prompt.push_str(&format!("Task:\n{}\n", task.prompt));
    let response = transport
        .call(
            "turn/start",
            json!({"threadId":stream.thread,"input":[{"type":"text","text":prompt}]}),
            &mut buffered,
        )
        .await?;
    stream.turn(
        response["turn"]["id"]
            .as_str()
            .context("Codex turn identity is invalid")?,
    )?;
    let mut taking: Option<Take> = None;
    let mut pending: Option<(u64, LiveInput, Instant)> = None;
    let mut poll = time::interval(Duration::from_millis(100));
    poll.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    let mut finished_at = None;
    let mut advisory_sent = false;
    let mut advisory_id = None;
    let outcome=async {
        for notification in buffered.drain(..) {
            if !respond_tool(&mut transport, &stream, questions, &notification).await? {
                stream.notification(notification, harness, token, secrets).await?;
            }
        }
        loop {
            if stream.completed && finished_at.is_none() {finished_at=Some(Instant::now()+Duration::from_millis(250));}
            if let Some((_,_,deadline))=&pending {ensure!(*deadline>Instant::now(),"Codex live input acknowledgement timed out");}
            if stream.completed && taking.is_none() && finished_at.is_some_and(|deadline|Instant::now()>=deadline) {break;}
            if !advisory_sent && !stream.completed && taking.is_none() && pending.is_none()
                && let Some(advisory) = stream.budget_advisory()
            {
                advisory_sent = true;
                advisory_id = transport.send("turn/steer", json!({
                    "threadId":stream.thread, "expectedTurnId":stream.turn,
                    "input":[{"type":"text","text":advisory}]
                })).await.ok();
            }
            tokio::select! {
                biased;
                value=transport.output.recv()=>{
                    let Some(value)=value else {ensure!(stream.completed,"Codex process ended without a completed turn");break;};
                    let value=value?;
                    if respond_tool(&mut transport, &stream, questions, &value).await? {continue;}
                    if transport.deny_request(&value).await? {continue;}
                    if value.get("method").is_some() {
                        stream.notification(value,harness,token,secrets).await?;
                        ensure!(!stream.completed || pending.is_none(),"Codex turn completed before steering was acknowledged");
                    } else {
                        if advisory_id.is_some() && value["id"].as_u64() == advisory_id {
                            advisory_id = None;
                            continue;
                        }
                        let (id,input,_)=pending.as_ref().context("Codex returned an unexpected response identity")?;
                        ensure!(value["id"].as_u64()==Some(*id),"Codex returned an unexpected response identity");
                        if value.get("error").is_some() {
                            settle(harness,token,input,LiveInputReceipt::Rejected).await?;
                            pending=None;
                            bail!("Codex rejected live input");
                        }
                        ensure!(value["result"]["turnId"].as_str()==stream.turn.as_deref(),"Codex acknowledged input for a different turn");
                        settle(harness,token,input,LiveInputReceipt::Accepted).await?;
                        pending=None;
                    }
                }
                taken=async {taking.as_mut().expect("guarded input take").await}, if taking.is_some()=>{
                    taking=None;
                    let (sent,taken)=taken;
                    // A take that a Gateway partition interrupted delivered nothing to
                    // Codex. Any input its lost answer carried lapses to unknown at the
                    // Control Plane and is never replayed, so polling simply continues.
                    // When the host did receive a committed take whose dispatch
                    // authority had already ended, it records the input Rejected
                    // itself and answers with an empty take.
                    if let Some(input)=taken?.and_then(|taken|taken.input.map(|input|(input,taken.valid_for_ms))) {
                        let (input,valid_for_ms)=input;
                        ensure!(input.task_id==task.task_id && input.attempt_id==attempt_id && input.state()==LiveInputState::Dispatching,"Codex input has mismatched Attempt identity or state");
                        let deadline=sent.checked_add(Duration::from_millis(valid_for_ms)).context("invalid Codex input authority")?;
                        if stream.completed || Instant::now()>=deadline {
                            settle(harness,token,&input,LiveInputReceipt::Rejected).await?;
                        } else {
                            // Mark ambiguity before write_all: a partial/failed write may have
                            // delivered the complete frame. Never repeat this native request.
                            let id=transport.next_id+1;
                            pending=Some((id,input.clone(),Instant::now()+RPC_TIMEOUT));
                            time::timeout_at(deadline,transport.send("turn/steer",json!({"threadId":stream.thread,"expectedTurnId":stream.turn,"input":[{"type":"text","text":input.text}]}))).await.context("Codex live input authority expired during dispatch")??;
                        }
                    }
                }
                _=poll.tick()=>{
                    if !stream.completed && taking.is_none() && pending.is_none() {
                        let mut client=harness.clone();let token=token.to_owned();
                        taking=Some(Box::pin(async move {let sent=Instant::now();let response=async {match client.take_live_input(request(HarnessTakeLiveInputRequest{},&token)?).await {Ok(response)=>Ok(Some(response.into_inner())),Err(status) if transient(&status)=>Ok(None),Err(status)=>Err(anyhow::Error::new(status).context("could not receive Codex live input"))}}.await;(sent,response)}));
                    }
                }
            }
        }
        ensure!(pending.is_none(),"Codex stopped before steering was acknowledged");
        if let Some(home) = &consolidation {
            await_consolidation(&mut transport, &mut stream, home, (harness, token, secrets), advisory_id).await?;
        }
        let mut input = transport.input.take().context("Codex request pipe is closed")?;
        input.shutdown().await.context("could not close Codex request pipe")?;
        drop(input);
        // Drain bounded final notifications, including usage sent after completion,
        // and require orderly EOF before the caller captures the native transcript.
        time::timeout(RPC_TIMEOUT,async {
            while let Some(value)=transport.output.recv().await {
                let value=value?;
                if advisory_id.is_some() && value["id"].as_u64() == advisory_id {
                    advisory_id = None;
                    continue;
                }
                ensure!(value.get("id").is_none(),"Codex returned an unexpected response identity");
                stream.notification(value,harness,token,secrets).await?;
            }
            Ok::<_,anyhow::Error>(())
        }).await.context("Codex did not stop after completing its turn")??;
        Ok::<_,anyhow::Error>(())
    }.await;
    if outcome.is_err() {
        if let Some(turn) = &stream.turn
            && let Ok(id) = transport
                .send(
                    "turn/interrupt",
                    json!({"threadId":stream.thread,"turnId":turn}),
                )
                .await
            && stream.budget_reached
        {
            // Give the owned native turn a brief opportunity to acknowledge
            // the interrupt. The caller still reaps a hung process.
            let _ = time::timeout(Duration::from_millis(500), async {
                while let Some(Ok(value)) = transport.output.recv().await {
                    if value["id"].as_u64() == Some(id) {
                        break;
                    }
                    if transport.deny_request(&value).await.is_err() {
                        break;
                    }
                }
            })
            .await;
        }
        if let Some((_, input, _)) = &pending {
            let _ = settle(harness, token, input, LiveInputReceipt::Unknown).await;
        }
    }
    outcome?;
    stream.finish(questions.quiet_note().is_some())
}

/// How long the Tag's review turn waits, after it completes, for Codex's memory consolidation.
const CONSOLIDATION_LIMIT: Duration = Duration::from_secs(180);
/// How long a review turn waits for a consolidation job to show up before deciding none runs.
const CONSOLIDATION_START: Duration = Duration::from_secs(10);

/// The status of Codex's memory consolidation job in `home`, from its own job table: `None`
/// until Codex has recorded one.
async fn consolidation_status(home: &std::path::Path) -> Option<String> {
    use sqlx::{ConnectOptions as _, Row as _};
    let mut connection = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(home.join("memories_1.sqlite"))
        .read_only(true)
        .connect()
        .await
        .ok()?;
    let status = sqlx::query("SELECT status FROM jobs WHERE kind='memory_consolidate_global'")
        .fetch_optional(&mut connection)
        .await
        .ok()
        .flatten()
        .and_then(|row| row.try_get::<String, _>("status").ok());
    let _ = sqlx::Connection::close(connection).await;
    status
}

/// Whether the review turn may stop waiting: Codex finished its consolidation job, or failed it
/// (it retries a failed one later, not in this turn), or recorded none in [`CONSOLIDATION_START`].
fn consolidation_settled(status: Option<&str>, waited: Duration) -> bool {
    match status {
        Some("running") => false,
        Some(_) => true,
        None => waited >= CONSOLIDATION_START,
    }
}

/// Keeps the app-server running after the review turn until its memory consolidation finishes,
/// for at most [`CONSOLIDATION_LIMIT`], so the consolidated notes are in CODEX_HOME before the
/// adapter copies them out. Requests are refused; the turn's own late notifications still count.
async fn await_consolidation(
    transport: &mut Transport,
    stream: &mut Stream,
    home: &std::path::Path,
    (harness, token, secrets): (&mut HarnessClient<Channel>, &str, &[String]),
    mut advisory_id: Option<u64>,
) -> Result<()> {
    let started = Instant::now();
    let mut poll = time::interval(Duration::from_secs(1));
    poll.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    while started.elapsed() < CONSOLIDATION_LIMIT {
        tokio::select! {
            value = transport.output.recv() => {
                let Some(value) = value else { return Ok(()) };
                let value = value?;
                if transport.deny_request(&value).await? {
                    continue;
                }
                if value.get("method").is_none() {
                    if advisory_id.is_some() && value["id"].as_u64() == advisory_id {
                        advisory_id = None;
                        continue;
                    }
                    bail!("Codex returned an unexpected response identity");
                }
                // The consolidation agent's own thread reports on itself; only the turn's thread
                // reaches the Task.
                if value["params"]["threadId"].as_str() == Some(stream.thread.as_str()) {
                    stream.notification(value, harness, token, secrets).await?;
                }
            }
            _ = poll.tick() => {
                if consolidation_settled(consolidation_status(home).await.as_deref(), started.elapsed()) {
                    return Ok(());
                }
            }
        }
    }
    // Past the limit the turn ends anyway: the next review consolidates what is left.
    Ok(())
}

/// A `progress.updated` Task event for a Codex plan: the first eight steps, the first
/// incomplete one active, as TypeScript `taskProgressFromCodexTodo` formats a todo list. A step
/// status other than `completed` counts as incomplete. `None` when the plan is unreadable.
fn plan_progress(params: &Value) -> Option<String> {
    let plan = params["plan"].as_array()?;
    let mut steps = Vec::with_capacity(plan.len().min(1_000));
    for step in plan.iter().take(1_000) {
        steps.push((step["step"].as_str()?, step["status"] == "completed"));
    }
    let first_incomplete = steps.iter().position(|(_, completed)| !completed);
    let turn = params["turnId"].as_str().unwrap_or("plan");
    let items: Vec<Value> = steps
        .iter()
        .take(8)
        .enumerate()
        .map(|(index, (text, completed))| {
            let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
            let text: String = text.chars().take(160).collect();
            json!({
                "id": format!("{turn}:{index}"),
                "text": if text.is_empty() { format!("Step {}", index + 1) } else { text },
                "status": if *completed {
                    "completed"
                } else if Some(index) == first_incomplete {
                    "active"
                } else {
                    "pending"
                },
            })
        })
        .collect();
    Some(json!({
        "type": "progress.updated",
        "progress": {
            "summary": if first_incomplete.is_none() { "Finishing up" } else { "Working through the plan" },
            "items": items,
        },
    })
    .to_string())
}

#[cfg(test)]
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;

#[cfg(test)]
mod tests {
    use super::*;
    use std::{os::unix::fs::PermissionsExt, process::Stdio};
    use tokio::process::Command;

    #[tokio::test]
    async fn the_review_turn_waits_only_while_codex_consolidates() -> Result<()> {
        use sqlx::ConnectOptions as _;
        let home = tempfile::tempdir()?;
        // No job table yet: Codex hasn't started one.
        assert_eq!(consolidation_status(home.path()).await, None);
        let mut connection = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(home.path().join("memories_1.sqlite"))
            .create_if_missing(true)
            .connect()
            .await?;
        sqlx::query("CREATE TABLE jobs (kind TEXT, job_key TEXT, status TEXT)")
            .execute(&mut connection)
            .await?;
        assert_eq!(consolidation_status(home.path()).await, None);
        sqlx::query("INSERT INTO jobs VALUES ('memory_consolidate_global','global','running')")
            .execute(&mut connection)
            .await?;
        let running = consolidation_status(home.path()).await;
        assert_eq!(running.as_deref(), Some("running"));
        assert!(!consolidation_settled(
            running.as_deref(),
            CONSOLIDATION_LIMIT
        ));
        sqlx::query("UPDATE jobs SET status='done'")
            .execute(&mut connection)
            .await?;
        let done = consolidation_status(home.path()).await;
        assert!(consolidation_settled(done.as_deref(), Duration::ZERO));
        // A failed job ends the wait too; without a job, only after the start grace.
        assert!(consolidation_settled(Some("error"), Duration::ZERO));
        assert!(!consolidation_settled(None, Duration::from_secs(1)));
        assert!(consolidation_settled(None, CONSOLIDATION_START));
        Ok(())
    }

    #[tokio::test]
    #[ignore = "requires SUPERTAG_TEST_CODEX_BINARY; credential-free native Skill inventory probe"]
    async fn installed_skill_inventory_excludes_repository_and_system_packages() -> Result<()> {
        let executable = std::env::var_os("SUPERTAG_TEST_CODEX_BINARY")
            .context("set SUPERTAG_TEST_CODEX_BINARY")?;
        let directory = tempfile::tempdir()?;
        let root = directory.path().canonicalize()?;
        let workspace = root.join("workspace");
        let home = root.join("native-home");
        let selected = home.join("skills/selected");
        let ambient = workspace.join(".agents/skills/unselected");
        for (path, name) in [(&selected, "selected"), (&ambient, "unselected")] {
            std::fs::create_dir_all(path)?;
            std::fs::write(
                path.join("SKILL.md"),
                format!(
                    "---\nname: {name}\ndescription: Local inventory fixture.\n---\nUse fixture data only.\n"
                ),
            )?;
        }
        let policy = Policy::from_actions(&["files:read".into()], false)?;
        let args = crate::config::arguments(&workspace, None, None, &policy)?;
        let mut child = Command::new(executable)
            .args(args)
            .current_dir(&workspace)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").context("probe PATH")?)
            .env("HOME", &home)
            .env("CODEX_HOME", &home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let result=async {
            let mut transport=Transport::new(child.stdin.take().unwrap(),child.stdout.take().unwrap());let mut buffered=vec![];
            transport.call("initialize",json!({"clientInfo":{"name":"supertag-skill-probe","version":"1"},"capabilities":{"experimentalApi":true}}),&mut buffered).await?;
            transport.write(json!({"method":"initialized","params":{}})).await?;
            let before=transport.call("skills/list",json!({"cwds":[workspace],"forceReload":true}),&mut buffered).await?;
            assert!(crate::skills::inventory(&before)?.iter().any(|(p,enabled)|*enabled&&p==ambient.join("SKILL.md").to_str().unwrap()));
            let admitted=std::collections::BTreeSet::from([selected.join("SKILL.md").to_str().unwrap().to_owned()]);
            restrict_skills(&mut transport,&json!(workspace),&admitted,&mut buffered).await?;
            // A new path is enabled on refresh: production refuses writable
            // Skill-bearing Tasks until a native scope-wide allowlist is proven.
            let late=workspace.join(".agents/skills/late");std::fs::create_dir(&late)?;
            std::fs::write(late.join("SKILL.md"),"---\nname: late\ndescription: Late fixture.\n---\nFixture only.\n")?;
            let refreshed=transport.call("skills/list",json!({"cwds":[workspace],"forceReload":true}),&mut buffered).await?;
            assert!(crate::skills::inventory(&refreshed)?.iter().any(|(path,enabled)|*enabled&&path==late.join("SKILL.md").to_str().unwrap()));
            restrict_skills(&mut transport,&json!(workspace),&std::collections::BTreeSet::new(),&mut buffered).await?;
            let config=transport.call("config/read",json!({"cwd":workspace,"includeLayers":true}),&mut buffered).await?;
            assert_eq!(config["config"]["features"]["code_mode_host"],false);
            Ok::<_,anyhow::Error>(())
        }.await;
        child.kill().await?;
        child.wait().await?;
        result
    }

    #[tokio::test]
    #[ignore = "requires SUPERTAG_TEST_CODEX_BINARY pointing at installed Codex 0.163.0 or later"]
    async fn installed_app_server_keeps_owned_policy_and_rejects_steering_an_absent_turn()
    -> Result<()> {
        let executable = std::env::var_os("SUPERTAG_TEST_CODEX_BINARY")
            .context("set SUPERTAG_TEST_CODEX_BINARY")?;
        let directory = tempfile::Builder::new()
            .permissions(std::fs::Permissions::from_mode(0o700))
            .tempdir()?;
        let workspace = directory.path().join("workspace");
        std::fs::create_dir(&workspace)?;
        let home = directory.path().join("native-home");
        std::fs::create_dir(&home)?;
        let policy = Policy::from_actions(&["files:read".into()], false)?;
        let args = crate::config::arguments(&workspace, None, Some("medium"), &policy)?;
        let mut child = Command::new(executable)
            .args(args)
            .current_dir(&workspace)
            .env_clear()
            .env(
                "PATH",
                std::env::var_os("PATH").context("native probe needs PATH")?,
            )
            .env("HOME", &home)
            .env("CODEX_HOME", &home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let mut transport =
            Transport::new(child.stdin.take().unwrap(), child.stdout.take().unwrap());
        let mut buffered = Vec::new();
        transport
            .call(
                "initialize",
                json!({"clientInfo":{"name":"supertag-protocol-test","version":"0.1.0"},"capabilities":{"experimentalApi":true}}),
                &mut buffered,
            )
            .await?;
        transport
            .write(json!({"method":"initialized","params":{}}))
            .await?;
        let response = transport
            .call(
                "config/read",
                json!({"cwd":workspace,"includeLayers":true}),
                &mut buffered,
            )
            .await?;
        let configuration = &response["config"];
        assert_eq!(configuration["features"]["code_mode_host"], false);
        assert_eq!(configuration["features"]["code_mode"]["enabled"], false);
        assert_eq!(
            configuration["features"]["code_mode"]["direct_only_tool_namespaces"],
            json!(["supertag"])
        );
        assert_eq!(configuration["features"]["shell_tool"], false);
        assert_eq!(configuration["features"]["hooks"], false);
        assert_eq!(configuration["approval_policy"], "never");
        assert_eq!(configuration["sandbox_mode"], "read-only");
        // Registration is a local App Server operation; this probe never
        // starts a turn, reads native credentials, or calls a model provider.
        let mut params = crate::config::thread_parameters(
            &workspace,
            &policy,
            &crate::config::arguments(&workspace, None, None, &policy)?,
        )?;
        params["dynamicTools"] =
            crate::questions::tool_specs(crate::coordination::Inventory::WorkSessionLifecycle);
        params["ephemeral"] = json!(false);
        let thread = transport
            .call("thread/start", params, &mut buffered)
            .await?;
        ensure!(
            thread["thread"]["id"].as_str().is_some(),
            "native dynamic tool registration failed"
        );
        let denied=transport.call("turn/steer",json!({"threadId":"00000000-0000-0000-0000-000000000000","expectedTurnId":"00000000-0000-0000-0000-000000000001","input":[{"type":"text","text":"must not start a turn"}]}),&mut buffered).await;
        assert!(denied.is_err());
        drop(transport);
        let status = time::timeout(RPC_TIMEOUT, child.wait()).await??;
        ensure!(
            status.success(),
            "native protocol probe did not shut down cleanly"
        );
        Ok(())
    }

    fn fixture_git(directory: &std::path::Path, args: &[&str]) -> Result<()> {
        let status = std::process::Command::new("git")
            .current_dir(directory)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .args([
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
            ])
            .args(args)
            .status()?;
        ensure!(status.success(), "git {args:?} failed");
        Ok(())
    }

    /// Run `script` under the sandbox Codex configures from SuperTag's arguments for `policy`,
    /// through the App Server's credential-free `command/exec`, which applies the configured
    /// permission profile. `$TMPDIR` is the fixture root, so the Workspace lies under another
    /// writable root, the case where Codex 0.163.0 drops its own `.git` protection.
    async fn sandboxed(
        executable: &std::ffi::OsStr,
        root: &std::path::Path,
        workspace: &std::path::Path,
        policy: &Policy,
        script: &str,
    ) -> Result<Value> {
        let home = root.join("native-home");
        std::fs::create_dir_all(&home)?;
        let mut child = Command::new(executable)
            .args(crate::config::arguments(workspace, None, None, policy)?)
            .current_dir(workspace)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").context("probe PATH")?)
            .env("HOME", &home)
            .env("CODEX_HOME", &home)
            .env("TMPDIR", root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let mut transport =
            Transport::new(child.stdin.take().unwrap(), child.stdout.take().unwrap());
        let mut buffered = Vec::new();
        transport
            .call(
                "initialize",
                json!({"clientInfo":{"name":"supertag-sandbox-probe","version":"1"},"capabilities":{"experimentalApi":true}}),
                &mut buffered,
            )
            .await?;
        transport
            .write(json!({"method":"initialized","params":{}}))
            .await?;
        let result = transport
            .call(
                "command/exec",
                json!({"command":["/bin/sh","-c",script],"cwd":workspace,"timeoutMs":20_000}),
                &mut buffered,
            )
            .await;
        drop(transport);
        child.kill().await?;
        child.wait().await?;
        result
    }

    /// Run `script` as [`sandboxed`] does, with `environment` added to the Codex process.
    async fn sandboxed_with(
        executable: &std::ffi::OsStr,
        root: &std::path::Path,
        workspace: &std::path::Path,
        policy: &Policy,
        environment: &[(String, String)],
        script: &str,
    ) -> Result<Value> {
        let home = root.join("native-home");
        std::fs::create_dir_all(&home)?;
        let mut child = Command::new(executable)
            .args(crate::config::arguments(workspace, None, None, policy)?)
            .current_dir(workspace)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").context("probe PATH")?)
            .env("HOME", &home)
            .env("CODEX_HOME", &home)
            .env("TMPDIR", root)
            .envs(environment.iter().map(|(name, value)| (name, value)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let mut transport =
            Transport::new(child.stdin.take().unwrap(), child.stdout.take().unwrap());
        let mut buffered = Vec::new();
        transport
            .call(
                "initialize",
                json!({"clientInfo":{"name":"supertag-sandbox-probe","version":"1"},"capabilities":{"experimentalApi":true}}),
                &mut buffered,
            )
            .await?;
        transport
            .write(json!({"method":"initialized","params":{}}))
            .await?;
        let result = transport
            .call(
                "command/exec",
                json!({"command":["/bin/sh","-c",script],"cwd":workspace,"timeoutMs":60_000}),
                &mut buffered,
            )
            .await;
        drop(transport);
        child.kill().await?;
        child.wait().await?;
        result
    }

    /// One live model turn (operator-approved): a code-mode command under a narrowed network
    /// scope's profile. On 2026-11-17 with gpt-6-sol, the allowed origin passed through the egress
    /// proxy, another got 403 from the managed proxy, a direct connection could not resolve, and
    /// code-mode JavaScript had no fetch. Prints what happened; a person judges.
    /// Needs SUPERTAG_TEST_CODEX_BINARY, SUPERTAG_LIVE_CODE_MODE_HOME (a private CODEX_HOME
    /// holding a copied auth.json), and SUPERTAG_LIVE_CODE_MODE_MODEL.
    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "spends one live Codex turn; run only with operator approval"]
    async fn live_code_mode_under_a_narrowed_network_scope() -> Result<()> {
        use supertag_protocol::v2::{NetworkRule, NetworkScope};
        use supertag_worker_host::egress;
        // Only an operator who supplies a signed-in home spends the turn; --include-ignored
        // runs elsewhere skip it.
        let Some(home) = std::env::var_os("SUPERTAG_LIVE_CODE_MODE_HOME") else {
            return Ok(());
        };
        let executable = std::env::var_os("SUPERTAG_TEST_CODEX_BINARY")
            .context("set SUPERTAG_TEST_CODEX_BINARY")?;
        let model = std::env::var("SUPERTAG_LIVE_CODE_MODE_MODEL")
            .context("set SUPERTAG_LIVE_CODE_MODE_MODEL")?;
        let directory = tempfile::tempdir()?;
        let root = directory.path().canonicalize()?;
        let workspace = root.join("workspace");
        std::fs::create_dir(&workspace)?;
        let proxy = egress::EgressProxy::start(egress::Config::new(
            NetworkScope {
                any_origin: false,
                rules: vec![NetworkRule {
                    origins: vec!["https://example.com".into()],
                    methods: vec!["GET".into()],
                    credential: String::new(),
                    paths: vec![],
                }],
            },
            vec![],
        ))
        .await?;
        let files = egress::write_sandbox_files(&proxy, &root.join("egress"))?;
        let mut policy = Policy::from_actions(
            &[
                "files:write".into(),
                "commands:execute".into(),
                "web:fetch".into(),
            ],
            true,
        )?;
        policy.egress = Some(crate::config::Egress {
            proxy: proxy.url(),
            ca_certificate: files.ca_certificate.clone(),
            ca_bundle: files.ca_bundle.clone(),
            placeholders: Default::default(),
            hosts: ["example.com".to_owned()].into(),
            narrowed: true,
        });
        let args = crate::config::arguments(&workspace, Some(&model), Some("low"), &policy)?;
        assert!(args.contains(&"features.code_mode_host=true".to_owned()));
        let configuration: Vec<String> = args[3..].to_vec();
        let prompt = "Run exactly these three shell commands, one after the other, then try one \
            JavaScript fetch, and reply with only the four results, one per line, nothing else:\n\
            curl -sS -m 15 -o /dev/null -w 'allowed=%{http_code}' https://example.com/ || echo allowed-failed=$?\n\
            curl -sS -m 15 -o /dev/null -w 'denied=%{http_code}' https://example.org/ || echo denied-failed=$?\n\
            curl -sS -m 15 --noproxy '*' -o /dev/null -w 'direct=%{http_code}' https://example.org/ || echo direct-failed=$?\n\
            In the same code-mode script, if a global fetch exists, call \
            fetch('https://example.org/') and report fetch=STATUS, or fetch-error=MESSAGE, or \
            fetch=unavailable.";
        let output = Command::new(&executable)
            .arg("exec")
            .args(["--skip-git-repo-check", "--json"])
            .args(configuration)
            .arg(prompt)
            .current_dir(&workspace)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").context("probe PATH")?)
            .env("HOME", &home)
            .env("CODEX_HOME", &home)
            .env("TMPDIR", &root)
            .envs(policy.egress.as_ref().unwrap().process_environment())
            .stdin(Stdio::null())
            .output()
            .await?;
        let log = proxy.stop().await;
        // terminal-safe: probe output for the operator.
        println!(
            "status: {}\nstdout:\n{}\nstderr:\n{}\negress log: {log:#?}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(())
    }

    /// A narrowed network scope, through the real sandbox, Codex's managed proxy, and the Worker
    /// Host's egress proxy: the allowed origin and method pass with the credential injected,
    /// everything else is refused, and the command never holds the secret.
    #[tokio::test]
    #[ignore = "requires SUPERTAG_TEST_CODEX_BINARY; credential-free native sandbox probe"]
    async fn installed_sandbox_reaches_only_the_network_scope_through_the_egress_proxy()
    -> Result<()> {
        use supertag_protocol::v2::{NetworkRule, NetworkScope};
        use supertag_worker_host::egress;
        const HOST: &str = "api.example.test";
        const SECRET: &str = "ghp_probe_secret_value";
        let executable = std::env::var_os("SUPERTAG_TEST_CODEX_BINARY")
            .context("set SUPERTAG_TEST_CODEX_BINARY")?;
        let directory = tempfile::tempdir()?;
        let root = directory.path().canonicalize()?;
        let workspace = root.join("workspace");
        std::fs::create_dir(&workspace)?;
        let (origin, certificate) = egress::fixture::origin_server(HOST).await;
        let base = format!("https://{HOST}:{}", origin.port());
        let mut config = egress::Config::new(
            NetworkScope {
                any_origin: false,
                rules: vec![NetworkRule {
                    origins: vec![base.clone()],
                    methods: vec!["GET".into()],
                    credential: "github".into(),
                    paths: vec![],
                }],
            },
            vec![egress::Credential::new(
                "github",
                "GITHUB_TOKEN",
                SECRET.into(),
            )],
        );
        // The fixture origin is on loopback; production refuses that.
        config.resolve.insert(HOST.into(), origin);
        config.allow_private = true;
        config.extra_roots.push(certificate);
        let proxy = egress::EgressProxy::start(config).await?;
        let files = egress::write_sandbox_files(&proxy, &root.join("egress"))?;
        let placeholder = proxy.credentials()[0].placeholder.clone();
        let mut policy = Policy::from_actions(
            &[
                "files:write".into(),
                "commands:execute".into(),
                "web:fetch".into(),
            ],
            true,
        )?;
        policy.egress = Some(crate::config::Egress {
            proxy: proxy.url(),
            ca_certificate: files.ca_certificate.clone(),
            ca_bundle: files.ca_bundle.clone(),
            placeholders: [("GITHUB_TOKEN".to_owned(), placeholder.clone())].into(),
            hosts: [HOST.to_owned()].into(),
            narrowed: true,
        });
        let environment = policy.egress.as_ref().unwrap().process_environment();
        // Linux needs bubblewrap and unprivileged user namespaces for Codex's sandbox; macOS
        // always permits it. The CI runtime lane requires `codex-sandbox`, so it cannot skip.
        let probe = sandboxed_with(
            &executable,
            &root,
            &workspace,
            &policy,
            &environment,
            "true",
        )
        .await;
        if cfg!(not(target_os = "macos")) && probe.as_ref().map_or(true, |r| r["exitCode"] != 0) {
            // terminal-safe: test-only skip notice on standard error.
            super::prerequisites::missing::<()>(
                "codex-sandbox",
                &format!("Codex cannot start its sandbox here: {probe:?}"),
            )?;
            return Ok(());
        }
        let script = format!(
            "echo token=$GITHUB_TOKEN; \
             echo allowed=$(curl -sS -m 20 -H \"Authorization: Bearer $GITHUB_TOKEN\" {base}/ok); \
             echo post=$(curl -sS -m 20 -o /dev/null -w '%{{http_code}}' -X POST {base}/x); \
             curl -sS -m 10 -o /dev/null https://github.com/ 2>/dev/null; echo other=$?; \
             curl -sS -m 10 -o /dev/null --noproxy '*' https://example.com/ 2>/dev/null; echo direct=$?"
        );
        let result = sandboxed_with(
            &executable,
            &root,
            &workspace,
            &policy,
            &environment,
            &script,
        )
        .await?;
        let output = result["stdout"].as_str().unwrap_or_default().to_owned();
        let line = |name: &str| {
            output
                .lines()
                .find_map(|line| line.strip_prefix(&format!("{name}=")))
                .unwrap_or_default()
                .to_owned()
        };
        assert_eq!(line("token"), placeholder, "{result}");
        assert_eq!(
            line("allowed"),
            format!("GET /ok Bearer {SECRET}"),
            "{result}"
        );
        assert_eq!(line("post"), "403", "{result}");
        assert_ne!(line("other"), "0", "{result}");
        assert_ne!(line("direct"), "0", "{result}");
        assert!(!output.contains(&format!("token={SECRET}")), "{result}");
        let log = proxy.stop().await;
        let decided: Vec<(&str, bool, &str)> = log
            .requests
            .iter()
            .map(|record| {
                (
                    record.method.as_str(),
                    record.allowed,
                    record.credential.as_str(),
                )
            })
            .collect();
        assert_eq!(
            decided,
            [("GET", true, "github"), ("POST", false, "")],
            "{log:?}"
        );
        Ok(())
    }

    #[tokio::test]
    #[ignore = "requires SUPERTAG_TEST_CODEX_BINARY; credential-free native sandbox probe"]
    async fn installed_sandbox_keeps_every_workspace_git_directory_read_only() -> Result<()> {
        let executable = std::env::var_os("SUPERTAG_TEST_CODEX_BINARY")
            .context("set SUPERTAG_TEST_CODEX_BINARY")?;
        let directory = tempfile::tempdir()?;
        let root = directory.path().canonicalize()?;
        let main = root.join("main");
        let clone = root.join("clone");
        let copy = root.join("copy");
        for repository in [&main, &clone, &copy] {
            std::fs::create_dir(repository)?;
            fixture_git(repository, &["init", "--quiet"])?;
            fixture_git(
                repository,
                &["commit", "--quiet", "--allow-empty", "-m", "initial"],
            )?;
        }
        fixture_git(&main, &["worktree", "add", "--quiet", "../linked"])?;
        let linked = root.join("linked");
        let common = main.join(".git");
        let pointer = std::fs::read_to_string(linked.join(".git"))?;
        let mut policy =
            Policy::from_actions(&["files:write".into(), "commands:execute".into()], true)?;
        // Linux needs bubblewrap and unprivileged user namespaces for Codex's sandbox; macOS
        // always permits it. The CI runtime lane requires `codex-sandbox`, so it cannot skip.
        let probe = sandboxed(&executable, &root, &clone, &policy, "true").await;
        if cfg!(not(target_os = "macos")) && probe.as_ref().map_or(true, |r| r["exitCode"] != 0) {
            // terminal-safe: test-only skip notice on standard error.
            super::prerequisites::missing::<()>(
                "codex-sandbox",
                &format!("Codex cannot start its sandbox here: {probe:?}"),
            )?;
            return Ok(());
        }
        // A linked worktree: its `gitdir:` pointer, the common Git directory, and the
        // worktree's own Git directory inside it.
        let attempts = format!(
            "echo ok > written; echo x >> .git; echo x > {common}/injected; \
             echo x > {common}/worktrees/linked/injected; mkdir -p {common}/hooks; \
             echo x > {common}/hooks/post-checkout; true",
            common = common.display()
        );
        let result = sandboxed(&executable, &root, &linked, &policy, &attempts).await?;
        assert_eq!(
            std::fs::read_to_string(linked.join("written"))?,
            "ok\n",
            "{result}"
        );
        assert_eq!(
            std::fs::read_to_string(linked.join(".git")).unwrap_or_default(),
            pointer,
            "{result}"
        );
        for path in [
            "injected",
            "worktrees/linked/injected",
            "hooks/post-checkout",
        ] {
            assert!(!common.join(path).exists(), "{path}: {result}");
        }
        // A full clone with a read-write Workspace copy, itself a Git checkout.
        policy.writable_roots = vec![copy.clone()];
        // A managed checkout has the same shape: a real `.git` directory.
        for root in [&clone, &copy] {
            for name in [".codex", ".agents", ".aws"] {
                std::fs::create_dir(root.join(name))?;
            }
        }
        let attempts = format!(
            "echo ok > written; echo ok > {copy}/written; echo x > .git/injected; \
             printf x > .git/hooks/pre-commit; echo '[core] fsmonitor = x' >> .git/config; \
             echo x > {copy}/.git/injected; for name in .codex .agents .aws; do \
             echo x > $name/injected; echo x > {copy}/$name/injected; done; mv .git moved; true",
            copy = copy.display()
        );
        let config = std::fs::read_to_string(clone.join(".git/config"))?;
        let result = sandboxed(&executable, &root, &clone, &policy, &attempts).await?;
        assert_eq!(
            std::fs::read_to_string(clone.join("written"))?,
            "ok\n",
            "{result}"
        );
        assert_eq!(
            std::fs::read_to_string(copy.join("written"))?,
            "ok\n",
            "{result}"
        );
        assert_eq!(
            std::fs::read_to_string(clone.join(".git/config")).unwrap_or_default(),
            config,
            "{result}"
        );
        for path in [
            clone.join(".git/injected"),
            clone.join(".git/hooks/pre-commit"),
            copy.join(".git/injected"),
            clone.join(".codex/injected"),
            clone.join(".agents/injected"),
            clone.join(".aws/injected"),
            copy.join(".codex/injected"),
            copy.join(".agents/injected"),
            copy.join(".aws/injected"),
            clone.join("moved"),
        ] {
            assert!(!path.exists(), "{}: {result}", path.display());
        }
        // A Workspace without Git metadata cannot create any.
        let plain = root.join("plain");
        std::fs::create_dir(&plain)?;
        policy.writable_roots.clear();
        let result = sandboxed(
            &executable,
            &root,
            &plain,
            &policy,
            "echo ok > written; mkdir .git; true",
        )
        .await?;
        assert_eq!(
            std::fs::read_to_string(plain.join("written"))?,
            "ok\n",
            "{result}"
        );
        assert!(!plain.join(".git").exists(), "{result}");
        // web:fetch keeps the same profile: protected entries stay read-only, and a read-write
        // Workspace copy is writable.
        let mut network = Policy::from_actions(
            &[
                "files:write".into(),
                "commands:execute".into(),
                "web:fetch".into(),
            ],
            true,
        )?;
        network.writable_roots = vec![copy.clone()];
        let attempts = format!(
            "echo ok > fetched; echo ok > {copy}/fetched; echo x > .git/fetch-injected; \
             echo x > {copy}/.git/fetch-injected; for name in .codex .agents .aws; do \
             echo x > $name/fetch-injected; echo x > {copy}/$name/fetch-injected; done; true",
            copy = copy.display()
        );
        let result = sandboxed(&executable, &root, &clone, &network, &attempts).await?;
        for written in [clone.join("fetched"), copy.join("fetched")] {
            assert_eq!(std::fs::read_to_string(&written)?, "ok\n", "{result}");
        }
        for root in [&clone, &copy] {
            for name in [".git", ".codex", ".agents", ".aws"] {
                let path = root.join(name).join("fetch-injected");
                assert!(!path.exists(), "{}: {result}", path.display());
            }
        }
        network.writable_roots.clear();
        let result = sandboxed(
            &executable,
            &root,
            &linked,
            &network,
            "echo ok > fetched; echo x >> .git; true",
        )
        .await?;
        assert_eq!(
            std::fs::read_to_string(linked.join("fetched"))?,
            "ok\n",
            "{result}"
        );
        assert_eq!(
            std::fs::read_to_string(linked.join(".git")).unwrap_or_default(),
            pointer,
            "{result}"
        );
        Ok(())
    }

    /// Codex's configured sandbox applies a Task's path scope to commands: writes outside the
    /// write paths or into a read-only entry fail, hidden files cannot be read by `cat`, `grep`,
    /// Python, or through a symbolic or hard link, and an outside directory is writable.
    #[tokio::test]
    #[ignore = "requires SUPERTAG_TEST_CODEX_BINARY; credential-free native sandbox probe"]
    async fn installed_sandbox_applies_the_tasks_path_scope() -> Result<()> {
        path_scope_probe(&[]).await
    }

    /// With web:fetch, the same profile keeps the whole path scope and `.git` protection, and
    /// commands reach external hosts directly.
    #[tokio::test]
    #[ignore = "requires SUPERTAG_TEST_CODEX_BINARY; credential-free native sandbox probe"]
    async fn installed_sandbox_applies_a_path_scope_with_web_fetch() -> Result<()> {
        path_scope_probe(&["web:fetch"]).await
    }

    /// Whether this machine reaches `https://example.com` outside any sandbox. A runner without
    /// egress makes the in-sandbox network check vacuous, not failing.
    fn host_has_egress() -> bool {
        std::process::Command::new("curl")
            .args([
                "-sS",
                "-o",
                "/dev/null",
                "--max-time",
                "10",
                "https://example.com",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    async fn path_scope_probe(extra: &[&str]) -> Result<()> {
        use crate::config::Scope;
        use supertag_protocol::v2::FileScope;
        let executable = std::env::var_os("SUPERTAG_TEST_CODEX_BINARY")
            .context("set SUPERTAG_TEST_CODEX_BINARY")?;
        let fetch = extra.contains(&"web:fetch");
        let directory = tempfile::tempdir()?;
        let root = directory.path().canonicalize()?;
        let workspace = root.join("workspace");
        let cache = root.join("cache");
        let data = root.join("data");
        for path in [
            workspace.join("src/generated"),
            workspace.join("apps/web"),
            workspace.join("secrets"),
            workspace.join("outputs"),
            cache.clone(),
            data.clone(),
        ] {
            std::fs::create_dir_all(path)?;
        }
        fixture_git(&workspace, &["init", "--quiet"])?;
        let secret = "SECRET_VALUE_7f3a";
        for (path, contents) in [
            (".env", format!("KEY={secret}\n")),
            ("apps/web/.env", format!("KEY={secret}\n")),
            ("secrets/key", format!("{secret}\n")),
            ("README.md", "readme\n".to_owned()),
            ("src/generated/schema.rs", "generated\n".to_owned()),
        ] {
            std::fs::write(workspace.join(path), contents)?;
        }
        std::fs::write(data.join("input"), "data\n")?;
        let actions = ["files:write", "commands:execute"]
            .iter()
            .chain(extra)
            .map(|action| (*action).to_owned())
            .collect::<Vec<_>>();
        let mut policy = Policy::from_actions(&actions, true)?;
        policy.scope = Some(Scope {
            files: FileScope {
                write: vec!["src/".into()],
                read_only: vec!["src/generated/".into()],
                hidden: vec!["**/.env".into(), "secrets/".into()],
                ..Default::default()
            },
            outside_write: vec![cache.clone()],
            outside_read: vec![data.clone()],
            output_directory: Some(workspace.join("outputs")),
        });
        let probe = sandboxed(&executable, &root, &workspace, &policy, "true").await;
        if cfg!(not(target_os = "macos")) && probe.as_ref().map_or(true, |r| r["exitCode"] != 0) {
            // terminal-safe: test-only skip notice on standard error.
            super::prerequisites::missing::<()>(
                "codex-sandbox",
                &format!("Codex cannot start its sandbox here: {probe:?}"),
            )?;
            return Ok(());
        }
        let attempts = format!(
            "echo ok > src/written.rs; echo ok > outputs/report.md; echo x > README.md; \
             echo x > src/generated/schema.rs; echo x > src/generated/new.rs; echo x > new-top; \
             cat .env; cat apps/web/.env; cat secrets/key; grep -r KEY .; \
             python3 -c 'print(open(\".env\").read())'; \
             ln -s ../.env src/link; cat src/link; ln .env src/hard; cat src/hard; \
             echo x > .env; echo x > apps/web/.env.local; mkdir -p deep/.env; \
             printf x > .git/hooks/pre-commit; echo ok > {cache}/written; cat {data}/input; \
             echo x > {data}/written; \
             curl -sS -o /dev/null --max-time 10 -w 'network=%{{http_code}}' https://example.com; \
             true",
            cache = cache.display(),
            data = data.display(),
        );
        let result = sandboxed(&executable, &root, &workspace, &policy, &attempts).await?;
        let output = result.to_string();
        assert!(!output.contains(secret), "a hidden file leaked: {result}");
        assert!(output.contains("data"), "{result}");
        // web:fetch reaches an external host; without it the sandbox blocks the connection.
        let reached = output.contains("network=200");
        if fetch {
            assert!(
                reached || !host_has_egress(),
                "no network with web:fetch: {result}"
            );
        } else {
            assert!(!reached, "network reached without web:fetch: {result}");
        }
        for (path, expected) in [
            (workspace.join("src/written.rs"), Some("ok\n")),
            (workspace.join("outputs/report.md"), Some("ok\n")),
            (cache.join("written"), Some("ok\n")),
            (workspace.join("README.md"), Some("readme\n")),
            (
                workspace.join("src/generated/schema.rs"),
                Some("generated\n"),
            ),
            (workspace.join("src/generated/new.rs"), None),
            (workspace.join("new-top"), None),
            (workspace.join("src/hard"), None),
            (workspace.join("apps/web/.env.local"), None),
            (workspace.join(".git/hooks/pre-commit"), None),
            (data.join("written"), None),
        ] {
            assert_eq!(
                std::fs::read_to_string(&path).ok().as_deref(),
                expected,
                "{}: {result}",
                path.display()
            );
        }
        assert_eq!(
            std::fs::read_to_string(workspace.join(".env"))?,
            format!("KEY={secret}\n")
        );
        assert!(!workspace.join("deep/.env").exists(), "{result}");
        Ok(())
    }
}
