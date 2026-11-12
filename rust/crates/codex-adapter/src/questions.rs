//! One explicitly advertised Objective tool. Native input never supplies an
//! Attempt identity or an operator credential; the private bridge supplies it.
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, time::Duration};
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{HarnessAskQuestionRequest, harness_questions_client::HarnessQuestionsClient},
};
use tonic::{Code, transport::Channel};

pub(crate) const NONE: &str = "none-v1";
pub(crate) const OBJECTIVE_ASK: &str = "objective-ask-text-v1";

pub(crate) struct Bridge {
    client: HarnessQuestionsClient<Channel>,
    token: String,
    task_id: String,
    attempt_id: String,
    enabled: bool,
    calls: BTreeMap<String, (String, Value)>,
}
impl Bridge {
    pub(crate) fn new(
        channel: Channel,
        token: &str,
        task_id: &str,
        attempt_id: &str,
        enabled: bool,
    ) -> Self {
        Self {
            client: HarnessQuestionsClient::new(channel)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .max_decoding_message_size(MAX_MESSAGE_BYTES),
            token: token.into(),
            task_id: task_id.into(),
            attempt_id: attempt_id.into(),
            enabled,
            calls: BTreeMap::new(),
        }
    }
    pub(crate) fn enabled(&self) -> bool {
        self.enabled
    }
    pub(crate) fn manifest(&self) -> &'static str {
        if self.enabled { OBJECTIVE_ASK } else { NONE }
    }
    pub(crate) fn tools(&self) -> Value {
        tool_specs()
    }
    pub(crate) async fn call(&mut self, params: &Value) -> Result<Value> {
        ensure!(
            self.enabled,
            "Codex question tool was not admitted for this Task"
        );
        let text = validate_tool(params)?;
        let call_id = params["callId"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control))
            .context("Codex tool call identity is invalid")?;
        if let Some((previous, result)) = self.calls.get(call_id) {
            ensure!(
                previous == &text,
                "Codex reused a tool call identity with different arguments"
            );
            return Ok(result.clone());
        }
        ensure!(
            self.calls.len() < 32,
            "Codex exceeded its coordination tool call limit"
        );
        let operation_id = format!(
            "codex-ask-{:x}",
            Sha256::digest(serde_json::to_vec(&(
                params["threadId"].as_str(),
                params["turnId"].as_str(),
                call_id
            ))?)
        );
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
        let result = result.context("could not confirm the Objective question receipt")?;
        self.calls.insert(call_id.into(), (text, result.clone()));
        Ok(result)
    }
}

pub(crate) fn tool_specs() -> Value {
    json!([{"type":"namespace","name":"supertag","description":"Objective coordination through this Task's supervised execution.","tools":[{"type":"function","name":"ask","description":"Ask the operator one question needed to continue this Objective. After this returns, end your turn with a short reply and make no further tool calls. The answer arrives in this Session's next Task.","inputSchema":{"type":"object","properties":{"text":{"type":"string","minLength":1,"maxLength":16000}},"required":["text"],"additionalProperties":false}}]}])
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
