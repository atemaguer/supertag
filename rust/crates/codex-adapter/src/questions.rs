//! One explicitly advertised Objective tool. Native input never supplies an
//! Attempt identity or an operator credential; the private bridge supplies it.
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, time::Duration};
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        AttemptCapabilities, HarnessAskQuestionRequest,
        harness_questions_client::HarnessQuestionsClient,
    },
};
use tonic::{Code, transport::Channel};

use crate::coordination::{self, Arguments, Inventory};

pub(crate) const NONE: &str = "none-v1";
pub(crate) const OBJECTIVE_ASK: &str = "objective-ask-text-v1";
pub(crate) const FULL_COORDINATION: &str = "coordination-v1";
pub(crate) const DIRECT_COORDINATION: &str = "coordination-v2";
pub(crate) const WORK_SESSIONS: &str = "coordination-v3";
pub(crate) const WORK_SESSION_LIFECYCLE: &str = "coordination-v4";
pub(crate) const CHILD_QUESTIONS: &str = "work-session-ask-v1";

pub(crate) struct Bridge {
    client: HarnessQuestionsClient<Channel>,
    token: String,
    task_id: String,
    tag_id: String,
    session_id: String,
    attempt_id: String,
    capabilities: AttemptCapabilities,
    inventory: Inventory,
    coordination: coordination::Client,
    calls: BTreeMap<String, (Arguments, Value)>,
    secrets: Vec<String>,
    asked: bool,
}
impl Bridge {
    pub(crate) fn new(
        channel: Channel,
        token: &str,
        task: &supertag_protocol::v2::Task,
        attempt_id: &str,
        capabilities: AttemptCapabilities,
        inventory: Inventory,
    ) -> Self {
        Self {
            client: HarnessQuestionsClient::new(channel.clone())
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .max_decoding_message_size(MAX_MESSAGE_BYTES),
            token: token.into(),
            task_id: task.task_id.clone(),
            tag_id: task.tag_id.clone(),
            session_id: task.session_id.clone(),
            attempt_id: attempt_id.into(),
            capabilities,
            inventory,
            coordination: coordination::Client::new(channel),
            calls: BTreeMap::new(),
            secrets: vec![],
            asked: false,
        }
    }
    pub(crate) fn enabled(&self) -> bool {
        self.inventory != Inventory::None
    }

    pub(crate) fn inventory(&self) -> Inventory {
        self.inventory
    }
    pub(crate) fn set_secrets(&mut self, secrets: &[String]) {
        self.secrets = secrets.to_vec();
    }
    pub(crate) fn waiting_approvals(&self) -> Vec<String> {
        let mut ids: Vec<_> = self.coordination.pending.values().cloned().collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    }
    pub(crate) fn manifest(&self) -> &'static str {
        match self.inventory {
            Inventory::None => NONE,
            Inventory::Ask => OBJECTIVE_ASK,
            Inventory::ChildQuestions => CHILD_QUESTIONS,
            Inventory::Workstream => FULL_COORDINATION,
            Inventory::Direct => DIRECT_COORDINATION,
            Inventory::WorkSessions => WORK_SESSIONS,
            Inventory::WorkSessionLifecycle => WORK_SESSION_LIFECYCLE,
        }
    }
    pub(crate) fn tools(&self) -> Value {
        tool_specs(self.inventory)
    }
    pub(crate) async fn call(&mut self, params: &Value) -> Result<Value> {
        ensure!(
            self.enabled(),
            "Codex coordination tools were not admitted for this Task"
        );
        let arguments = coordination::arguments(params, self.inventory)?;
        let call_id = params["callId"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control))
            .context("Codex tool call identity is invalid")?;
        if let Some((previous, result)) = self.calls.get(call_id) {
            ensure!(
                previous == &arguments,
                "Codex reused a tool call identity with different arguments"
            );
            return Ok(result.clone());
        }
        ensure!(
            self.calls.len() < 32,
            "Codex exceeded its coordination tool call limit"
        );
        let operation_id = format!(
            "codex-{:x}",
            Sha256::digest(serde_json::to_vec(&(
                params["threadId"].as_str(),
                params["turnId"].as_str(),
                params["tool"].as_str(),
                call_id
            ))?)
        );
        let result = match &arguments {
            Arguments::Ask(text)
                if self.inventory == Inventory::ChildQuestions
                    && self.capabilities.may_ask_work_session_question
                    && self.coordination.pending.is_empty() =>
            {
                let reply = self
                    .coordination
                    .ask_work_session(
                        operation_id,
                        crate::auth::redact(text.clone(), &self.secrets),
                        (&self.task_id, &self.attempt_id, &self.session_id),
                        &self.token,
                    )
                    .await?;
                self.asked |= reply["success"] == true;
                reply
            }
            Arguments::Ask(text)
                if self.capabilities.may_ask_objective_question
                    && self.coordination.pending.is_empty() =>
            {
                let reply = self
                    .ask(
                        operation_id,
                        crate::auth::redact(text.clone(), &self.secrets),
                    )
                    .await?;
                self.asked |= reply["success"] == true;
                reply
            }
            Arguments::Post(post) if self.capabilities.may_use_workstream && !self.asked => {
                self.coordination
                    .post(
                        post,
                        operation_id,
                        &self.task_id,
                        &self.attempt_id,
                        &self.token,
                        &self.secrets,
                    )
                    .await?
            }
            Arguments::ReadWorkstream(page) if self.capabilities.may_use_workstream => {
                self.coordination
                    .read_workstream(page, &self.token, &self.secrets)
                    .await?
            }
            Arguments::ReadMailbox(page) if self.capabilities.may_read_mailbox => {
                self.coordination
                    .read_mailbox(page, &self.tag_id, &self.token, &self.secrets)
                    .await?
            }
            Arguments::Send(message) if self.capabilities.may_send_tag_message && !self.asked => {
                self.coordination
                    .send(
                        message,
                        operation_id,
                        (&self.task_id, &self.attempt_id, &self.tag_id),
                        &self.token,
                        &self.secrets,
                    )
                    .await?
            }
            Arguments::Start(start)
                if self.capabilities.may_start_work_session
                    && !self.asked
                    && self.coordination.pending.is_empty() =>
            {
                self.coordination
                    .start_session(
                        start,
                        operation_id,
                        (&self.task_id, &self.tag_id, &self.session_id),
                        &self.token,
                        &self.secrets,
                    )
                    .await?
            }
            Arguments::Continue(continuation)
                if self.capabilities.may_continue_work_session
                    && !self.asked
                    && self.coordination.pending.is_empty() =>
            {
                self.coordination
                    .continue_session(
                        continuation,
                        operation_id,
                        (&self.task_id, &self.tag_id, &self.session_id),
                        &self.token,
                        &self.secrets,
                    )
                    .await?
            }
            _ => coordination::refused(),
        };
        self.calls
            .insert(call_id.into(), (arguments, result.clone()));
        Ok(result)
    }

    async fn ask(&mut self, operation_id: String, text: String) -> Result<Value> {
        let input = HarnessAskQuestionRequest {
            operation_id,
            text: text.clone(),
        };
        let mut result = None;
        for retry in 0..3 {
            match self
                .client
                .ask_question(crate::request(input.clone(), &self.token)?)
                .await
            {
                Ok(response) => {
                    let question = response.into_inner();
                    ensure!(
                        question.task_id == self.task_id
                            && question.attempt_id == self.attempt_id
                            && question.text == text
                            && !question.objective_id.is_empty(),
                        "Objective question receipt has mismatched identity"
                    );
                    result = Some(
                        json!({"success":true,"contentItems":[{"type":"inputText","text":"Your question was recorded. End this turn with a short reply and make no further tool calls. The operator's answer arrives in this Session's next Task."}]}),
                    );
                    break;
                }
                Err(status)
                    if retry < 2
                        && matches!(status.code(), Code::Unavailable | Code::DeadlineExceeded) =>
                {
                    tokio::time::sleep(Duration::from_millis(50)).await
                }
                Err(status)
                    if matches!(
                        status.code(),
                        Code::PermissionDenied
                            | Code::Unauthenticated
                            | Code::FailedPrecondition
                            | Code::AlreadyExists
                            | Code::InvalidArgument
                    ) =>
                {
                    result = Some(
                        json!({"success":false,"contentItems":[{"type":"inputText","text":"The Objective question was refused. End your turn and report that the question could not be accepted."}]}),
                    );
                    break;
                }
                Err(_) => bail!("could not confirm the Objective question receipt"),
            }
        }
        result.context("could not confirm the Objective question receipt")
    }
}

pub(crate) fn tool_specs(inventory: Inventory) -> Value {
    let (description, max) = if inventory == Inventory::ChildQuestions {
        (
            "Record one question for the parent Session. Finish this turn so the parent can receive it and relay an answer.",
            2000,
        )
    } else {
        (
            "Ask the operator one question needed to continue this Objective. After this returns, end your turn with a short reply and make no further tool calls. The answer arrives in this Session's next Task.",
            16000,
        )
    };
    let mut tools = vec![json!({
        "type":"function", "name":"ask",
        "description":description,
        "inputSchema":{
            "type":"object", "properties":{"text":{"type":"string","minLength":1,"maxLength":max}},
            "required":["text"], "additionalProperties":false
        }
    })];
    if inventory >= Inventory::Workstream {
        tools.extend(coordination::tool_specs(inventory));
    }
    json!([{
        "type":"namespace", "name":"supertag",
        "description":"Coordination through this Task's supervised execution.",
        "tools":tools
    }])
}

pub(crate) fn validate_tool(params: &Value) -> Result<String> {
    ensure!(
        params["namespace"] == "supertag" && params["tool"] == "ask",
        "Codex requested an unregistered coordination tool"
    );
    let args = params["arguments"]
        .as_object()
        .context("Codex question arguments must be an object")?;
    ensure!(
        args.len() == 1,
        "Codex question arguments do not match the admitted schema"
    );
    let text = args
        .get("text")
        .and_then(Value::as_str)
        .context("Codex question text is missing")?
        .trim();
    ensure!(
        !text.is_empty() && text.encode_utf16().count() <= 16_000 && !text.contains('\0'),
        "Codex question text is invalid"
    );
    Ok(text.into())
}
