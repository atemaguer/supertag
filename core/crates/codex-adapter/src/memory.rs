//! `remember` and `forget` as Codex tools: a root turn keeps the Tag's short notes. A change
//! takes effect only when the turn succeeds.
use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        AttemptForgetRequest, AttemptMemoryResponse, AttemptRememberRequest,
        harness_memory_client::HarnessMemoryClient,
    },
};
use tonic::{Code, Response, Status, transport::Channel};

use crate::coordination::response;

const TEXT_MAX: usize = 500;

/// What the `remember` tool says a note is for. Shared with the TypeScript harnesses.
pub(crate) const REMEMBER_DESCRIPTION: &str = "Keep a short note for later turns of this Tag. Only what you can't look up again: preferences, corrections, decisions and their reasons, and pointers (URL, path, Objective ID) to anything kept elsewhere. Never paste content that lives in a repository, issue or PR. Pass replaces with a note's ID to rewrite or merge it. A note written in a person's conversation stays private to that person. It takes effect when this turn succeeds.";

#[derive(Debug, PartialEq)]
pub(crate) enum Call {
    Remember(Remember),
    Forget(Forget),
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Remember {
    text: String,
    #[serde(default)]
    replaces: Option<String>,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Forget {
    memory_id: String,
}

fn bounded(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty() && value.chars().count() <= maximum && !value.contains('\0')
}

/// The tool a Codex call names, when it is one of these.
pub(crate) fn arguments(params: &Value) -> Result<Option<Call>> {
    let tool = params["tool"].as_str();
    if !matches!(tool, Some("remember" | "forget")) {
        return Ok(None);
    }
    let input = params
        .get("arguments")
        .filter(|input| input.is_object())
        .with_context(|| format!("invalid Codex {} arguments", tool.unwrap_or_default()))?
        .clone();
    if tool == Some("remember") {
        let remember: Remember =
            serde_json::from_value(input).context("invalid Codex remember arguments")?;
        ensure!(
            bounded(&remember.text, TEXT_MAX),
            "a note is text of 1 to {TEXT_MAX} characters"
        );
        ensure!(
            remember
                .replaces
                .as_deref()
                .is_none_or(|id| bounded(id, 256)),
            "invalid note ID"
        );
        return Ok(Some(Call::Remember(remember)));
    }
    let forget: Forget = serde_json::from_value(input).context("invalid Codex forget arguments")?;
    ensure!(bounded(&forget.memory_id, 256), "invalid note ID");
    Ok(Some(Call::Forget(forget)))
}

pub(crate) fn tool_specs() -> Vec<Value> {
    vec![
        json!({
            "type":"function","name":"remember",
            "description":REMEMBER_DESCRIPTION,
            "inputSchema":{"type":"object","properties":{
                "text":{"type":"string","minLength":1,"maxLength":TEXT_MAX},
                "replaces":{"type":"string","minLength":1,"maxLength":256,"description":"The ID of a note this one replaces."}
            },"required":["text"],"additionalProperties":false}
        }),
        json!({
            "type":"function","name":"forget",
            "description":"Forget one of this Tag's notes by its ID, when it is wrong or no longer matters. It takes effect when this turn succeeds.",
            "inputSchema":{"type":"object","properties":{
                "memoryId":{"type":"string","minLength":1,"maxLength":256}
            },"required":["memoryId"],"additionalProperties":false}
        }),
    ]
}

/// The tool result: what changed, then the notes this turn now sees.
pub(crate) fn summary(result: &AttemptMemoryResponse, forgot: Option<&str>) -> String {
    let mut text = match (&result.memory, forgot) {
        (_, Some(id)) => format!("Forgot {id}. It takes effect when this turn succeeds."),
        (Some(memory), None) => format!(
            "Saved {}. It takes effect when this turn succeeds.",
            memory.memory_id
        ),
        (None, None) => "Saved.".to_owned(),
    };
    if result.notes.is_empty() {
        text.push_str("\nYou keep no notes.");
    } else {
        text.push_str("\nYour notes now:");
        for note in &result.notes {
            text.push_str(&format!("\n- {}: {}", note.memory_id, note.text));
        }
    }
    text
}

pub(crate) struct Client {
    client: HarnessMemoryClient<Channel>,
}

/// A refusal carries the Control Plane's reason; other failures fail the call.
async fn confirm<T>(
    mut call: impl AsyncFnMut() -> Result<Response<T>, Status>,
) -> Result<std::result::Result<T, String>> {
    for retry in 0..3 {
        match call().await {
            Ok(response) => return Ok(Ok(response.into_inner())),
            Err(status)
                if retry < 2
                    && matches!(status.code(), Code::Unavailable | Code::DeadlineExceeded) =>
            {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(status)
                if matches!(
                    status.code(),
                    Code::PermissionDenied
                        | Code::Unauthenticated
                        | Code::FailedPrecondition
                        | Code::AlreadyExists
                        | Code::InvalidArgument
                        | Code::NotFound
                ) =>
            {
                return Ok(Err(status.message().to_owned()));
            }
            Err(_) => break,
        }
    }
    bail!("could not confirm the note")
}

impl Client {
    pub(crate) fn new(channel: Channel) -> Self {
        Self {
            client: HarnessMemoryClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
        }
    }

    pub(crate) async fn call(
        &mut self,
        call: &Call,
        operation_id: String,
        token: &str,
        secrets: &[String],
    ) -> Result<Value> {
        fn request<T>(message: T, token: &str) -> Result<tonic::Request<T>, Status> {
            crate::request(message, token)
                .map_err(|_| Status::unauthenticated("invalid execution credential"))
        }
        let result = match call {
            Call::Remember(remember) => {
                let input = AttemptRememberRequest {
                    attempt: None,
                    operation_id,
                    text: crate::auth::redact(remember.text.trim().to_owned(), secrets),
                    replaces: remember.replaces.clone(),
                };
                confirm(async || self.client.remember(request(input.clone(), token)?).await)
                    .await?
                    .map(|result| summary(&result, None))
            }
            Call::Forget(forget) => {
                let input = AttemptForgetRequest {
                    attempt: None,
                    operation_id,
                    memory_id: forget.memory_id.clone(),
                };
                confirm(async || self.client.forget(request(input.clone(), token)?).await)
                    .await?
                    .map(|result| summary(&result, Some(&forget.memory_id)))
            }
        };
        Ok(match result {
            Ok(text) => response(crate::auth::redact(text, secrets), true),
            Err(reason) => response(
                crate::auth::redact(format!("Refused: {reason}"), secrets),
                false,
            ),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use supertag_protocol::v2::Memory;

    fn call(tool: &str, arguments: Value) -> Result<Option<Call>> {
        super::arguments(&json!({"namespace":"supertag","tool":tool,"arguments":arguments}))
    }

    #[test]
    fn arguments_are_bounded_and_closed() {
        assert!(matches!(
            call("remember", json!({"text":"Atem prefers squash merges"})).unwrap(),
            Some(Call::Remember(_))
        ));
        assert!(matches!(
            call("remember", json!({"text":"x","replaces":"mem_1"})).unwrap(),
            Some(Call::Remember(_))
        ));
        assert!(call("remember", json!({"text":" "})).is_err());
        assert!(call("remember", json!({"text":"x".repeat(501)})).is_err());
        assert!(call("remember", json!({"text":"x","tag":"other"})).is_err());
        assert!(matches!(
            call("forget", json!({"memoryId":"mem_1"})).unwrap(),
            Some(Call::Forget(_))
        ));
        assert!(call("forget", json!({})).is_err());
        assert!(call("ask", json!({"text":"x"})).unwrap().is_none());
        assert!(
            tool_specs()
                .iter()
                .all(|spec| spec["inputSchema"]["additionalProperties"] == false)
        );
    }

    #[test]
    fn the_result_lists_the_notes() {
        let note = |id: &str| Memory {
            memory_id: id.into(),
            text: format!("note {id}"),
            ..Default::default()
        };
        let text = summary(
            &AttemptMemoryResponse {
                memory: Some(note("mem_new")),
                notes: vec![note("mem_new"), note("mem_old")],
            },
            None,
        );
        assert!(text.starts_with("Saved mem_new."), "{text}");
        assert!(text.contains("- mem_old: note mem_old"), "{text}");
        assert!(summary(&AttemptMemoryResponse::default(), Some("mem_x")).contains("no notes"));
    }
}
