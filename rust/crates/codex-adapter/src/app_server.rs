//! One owned stdio App Server, one native thread, and exactly one started turn.
//! A taken input is written once with the native expected-turn precondition.
use std::{future::Future, pin::Pin, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use supertag_protocol::v2::{
    HarnessSettleLiveInputRequest, HarnessTakeLiveInputRequest, HarnessUsageRequest, LiveInput,
    LiveInputReceipt, LiveInputState, NativeTokenUsage, TakeInputResponse, Task,
    harness_client::HarnessClient,
};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    process::{ChildStdin, ChildStdout},
    sync::mpsc,
    task::JoinHandle,
    time::{self, Instant},
};
use tonic::transport::Channel;

use crate::{MAX_STREAM, RPC_TIMEOUT, auth, config::Policy, events, publish, read_line, request};

type Take = Pin<Box<dyn Future<Output = (Instant, Result<TakeInputResponse>)> + Send>>;

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
        time::timeout(RPC_TIMEOUT, async {
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
                ensure!(
                    value.get("error").is_none(),
                    "Codex rejected an execution request"
                );
                return value
                    .get("result")
                    .filter(|result| result.is_object())
                    .cloned()
                    .context("Codex returned an invalid response");
            }
        })
        .await
        .context("Codex request timed out")?
    }
}

struct Stream {
    native: events::Stream,
    thread: String,
    turn: Option<String>,
    completed: bool,
    baseline: Option<[u64; 3]>,
    total: Option<[u64; 3]>,
    observed_model: Option<String>,
    usage_sequence: u64,
    sequence: u64,
    turn_requested: bool,
    resumed: bool,
    inventory: crate::coordination::Inventory,
}

impl Stream {
    fn new(
        policy: Policy,
        thread: String,
        expected_thread: Option<String>,
        baseline: Option<[u64; 3]>,
        inventory: crate::coordination::Inventory,
    ) -> Result<Self> {
        let resumed = expected_thread.is_some();
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
            observed_model: None,
            usage_sequence: 0,
            sequence: 0,
            turn_requested: false,
            resumed,
            inventory,
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
            "thread/tokenUsage/updated" => {
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
                if self.turn_requested && params["turnId"].as_str() != self.turn.as_deref() {
                    // Resume can acknowledge before publishing the old turn's
                    // final total. It is only a baseline, never current work.
                    ensure!(
                        self.resumed && self.baseline == Some(total),
                        "Codex usage belongs to a different active turn"
                    );
                    return Ok(());
                }
                ensure!(total[1] <= total[0], "Codex completed with invalid usage");
                if !self.turn_requested {
                    if let Some(baseline) = self.baseline {
                        ensure!(
                            baseline == total,
                            "Codex resume usage does not match its checkpoint"
                        );
                    }
                    self.baseline = Some(total);
                    return Ok(());
                }
                let baseline = self
                    .baseline
                    .context("Codex resume usage baseline is unavailable")?;
                ensure!(
                    total
                        .iter()
                        .zip(baseline)
                        .all(|(current, previous)| *current >= previous),
                    "Codex cumulative usage precedes its baseline"
                );
                if let Some(previous) = self.total {
                    ensure!(
                        total
                            .iter()
                            .zip(previous)
                            .all(|(current, previous)| *current >= previous),
                        "Codex cumulative usage decreased"
                    );
                }
                if self.total == Some(total) {
                    return Ok(());
                }
                self.total = Some(total);
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
                };
                ensure!(
                    usage.cached_input_tokens <= usage.input_tokens,
                    "Codex completed with invalid usage"
                );
                harness
                    .report_usage(request(
                        HarnessUsageRequest {
                            sequence: self.usage_sequence,
                            native_usage: Some(usage),
                        },
                        token,
                    )?)
                    .await
                    .context("could not record Codex token usage")?;
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
                            self.inventory != crate::coordination::Inventory::None,
                            "Codex emitted an unregistered coordination tool item"
                        );
                        crate::coordination::arguments(&item, self.inventory)?;
                        return Ok(());
                    }
                    Some("webSearch") => item["type"] = json!("web_search"),
                    _ => bail!("Codex emitted an unsupported tool or item"),
                }
                let normalized = json!({"type":if method=="item/completed" {"item.completed"}else{"item.started"},"item":item});
                if let Some(message) = self.native.accept(&serde_json::to_vec(&normalized)?)? {
                    publish(
                        harness,
                        token,
                        &mut self.sequence,
                        &auth::redact(message, secrets),
                    )
                    .await?;
                }
            }
            "error" => bail!("Codex reported a failed turn"),
            // Output deltas are represented by the authoritative completed item.
            method if method.starts_with("item/") && method.ends_with("/delta") => {}
            method
                if method.starts_with("codex/")
                    || method.starts_with("thread/")
                    || method.starts_with("account/")
                    || method.starts_with("model/")
                    || method.starts_with("config/")
                    || method == "sessionConfigured"
                    || method == "warning" => {}
            _ if method.len() <= 128
                && method
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'_')) =>
            {
                bail!(
                    "Codex emitted an unsupported event type: {}",
                    auth::redact(method.to_owned(), secrets)
                )
            }
            _ => bail!("Codex emitted an unsupported event type"),
        }
        Ok(())
    }

    fn finish(mut self) -> Result<(String, String)> {
        ensure!(
            self.completed,
            "Codex process ended without a completed turn"
        );
        let total = self.total.context("Codex completed without valid usage")?;
        let baseline = self
            .baseline
            .context("Codex resume usage baseline is unavailable")?;
        self.native.accept(&serde_json::to_vec(&json!({"type":"turn.completed","usage":{"input_tokens":total[0]-baseline[0],"cached_input_tokens":total[1]-baseline[1],"output_tokens":total[2]-baseline[2]}}))?)?;
        let _ = self.native.take_usage();
        self.native.finish()
    }
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
    baseline: Option<[u64; 3]>,
    harness: &mut HarnessClient<Channel>,
    questions: &mut crate::questions::Bridge,
    token: &str,
    secrets: &[String],
) -> Result<(String, String)> {
    let mut transport = Transport::new(input, output);
    let mut buffered = Vec::new();
    transport.call("initialize",json!({"clientInfo":{"name":"supertag","version":"0.1.0"},"capabilities":{"experimentalApi":questions.enabled()}}),&mut buffered).await?;
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
    let response = transport.call(method, params, &mut buffered).await?;
    let thread = response["thread"]["id"]
        .as_str()
        .filter(|id| crate::checkpoint::thread_identity(id))
        .context("Codex thread identity is invalid")?
        .to_owned();
    let mut stream = Stream::new(
        policy,
        thread,
        expected_thread,
        baseline,
        questions.inventory(),
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
    publish(harness, token, &mut stream.sequence, "Codex started").await?;
    ensure!(
        stream.baseline.is_some(),
        "Codex resume usage baseline is unavailable"
    );
    stream.turn_requested = true;
    let prompt = format!(
        "Tag instructions:\n{}\n\nTask:\n{}\n",
        task.instructions, task.prompt
    );
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
    for notification in buffered.drain(..) {
        if respond_tool(&mut transport, &stream, questions, &notification).await? {
            continue;
        }
        stream
            .notification(notification, harness, token, secrets)
            .await?;
    }

    let mut taking: Option<Take> = None;
    let mut pending: Option<(u64, LiveInput, Instant)> = None;
    let mut poll = time::interval(Duration::from_millis(100));
    poll.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    let mut finished_at = None;
    let outcome=async {
        loop {
            if stream.completed && finished_at.is_none() {finished_at=Some(Instant::now()+Duration::from_millis(250));}
            if let Some((_,_,deadline))=&pending {ensure!(*deadline>Instant::now(),"Codex live input acknowledgement timed out");}
            if stream.completed && taking.is_none() && finished_at.is_some_and(|deadline|Instant::now()>=deadline) {break;}
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
                    let taken=taken?;
                    if let Some(input)=taken.input {
                        ensure!(input.task_id==task.task_id && input.attempt_id==attempt_id && input.state()==LiveInputState::Dispatching,"Codex input has mismatched Attempt identity or state");
                        let deadline=sent.checked_add(Duration::from_millis(taken.valid_for_ms)).context("invalid Codex input authority")?;
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
                        taking=Some(Box::pin(async move {let sent=Instant::now();let response=async {Ok(client.take_live_input(request(HarnessTakeLiveInputRequest{},&token)?).await.context("could not receive Codex live input")?.into_inner())}.await;(sent,response)}));
                    }
                }
            }
        }
        ensure!(pending.is_none(),"Codex stopped before steering was acknowledged");
        let mut input = transport.input.take().context("Codex request pipe is closed")?;
        input.shutdown().await.context("could not close Codex request pipe")?;
        drop(input);
        // Drain bounded final notifications, including usage sent after completion,
        // and require orderly EOF before the caller captures the native transcript.
        time::timeout(RPC_TIMEOUT,async {
            while let Some(value)=transport.output.recv().await {
                let value=value?;
                ensure!(value.get("id").is_none(),"Codex returned an unexpected response identity");
                stream.notification(value,harness,token,secrets).await?;
            }
            Ok::<_,anyhow::Error>(())
        }).await.context("Codex did not stop after completing its turn")??;
        Ok::<_,anyhow::Error>(())
    }.await;
    if outcome.is_err() {
        if let Some((_, input, _)) = &pending {
            let _ = settle(harness, token, input, LiveInputReceipt::Unknown).await;
        }
        if let Some(turn) = &stream.turn {
            let _ = transport
                .send(
                    "turn/interrupt",
                    json!({"threadId":stream.thread,"turnId":turn}),
                )
                .await;
        }
    }
    outcome?;
    stream.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{os::unix::fs::PermissionsExt, process::Stdio};
    use tokio::process::Command;

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
        let args = crate::config::arguments(&workspace, None, &policy)?;
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
        let args = crate::config::arguments(&workspace, None, &policy)?;
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
            &crate::config::arguments(&workspace, None, &policy)?,
        )?;
        params["dynamicTools"] =
            crate::questions::tool_specs(crate::coordination::Inventory::Direct);
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
}
