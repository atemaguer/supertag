use anyhow::{Context, Result, bail, ensure};
use serde_json::Value;
use supertag_protocol::v2::NativeTokenUsage;

use crate::config::Policy;

pub(crate) struct Stream {
    policy: Policy,
    thread: Option<String>,
    completed: bool,
    final_response: Option<String>,
    count: usize,
    expected_thread: Option<String>,
    observed_model: Option<String>,
    usage: Option<NativeTokenUsage>,
}

impl Stream {
    pub(crate) fn new(policy: Policy, expected_thread: Option<String>) -> Self {
        Self {
            policy,
            thread: None,
            completed: false,
            final_response: None,
            count: 0,
            expected_thread,
            observed_model: None,
            usage: None,
        }
    }

    pub(crate) fn accept(&mut self, line: &[u8]) -> Result<Option<String>> {
        self.count += 1;
        ensure!(self.count <= 100_000, "Codex emitted too many events");
        ensure!(
            !self.completed,
            "Codex emitted events after its completed turn"
        );
        let event: Value = serde_json::from_slice(line).context("Codex emitted malformed JSON")?;
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .context("Codex event is missing its type")?;
        if let Some(model) = event.get("model") {
            self.observed_model = Some(
                model
                    .as_str()
                    .filter(|model| {
                        !model.is_empty()
                            && model.len() <= 256
                            && !model.chars().any(char::is_control)
                    })
                    .context("Codex reported an invalid model")?
                    .into(),
            );
        }
        if kind == "thread.started" {
            ensure!(self.thread.is_none(), "Codex started more than one thread");
            let id = event
                .get("thread_id")
                .and_then(Value::as_str)
                .filter(|id| crate::checkpoint::thread_identity(id))
                .context("Codex thread identity is invalid")?;
            ensure!(
                self.expected_thread
                    .as_deref()
                    .is_none_or(|expected| expected == id),
                "Codex did not resume the requested Session"
            );
            self.thread = Some(id.into());
            return Ok(Some("Codex started".into()));
        }
        if matches!(kind, "error" | "turn.failed") {
            bail!("Codex reported a failed turn");
        }
        ensure!(
            self.thread.is_some(),
            "Codex emitted work before its thread identity"
        );
        match kind {
            "turn.started" => Ok(None),
            "turn.completed" => {
                let usage = event
                    .get("usage")
                    .context("Codex completed without valid usage")?;
                let input = usage
                    .get("input_tokens")
                    .and_then(Value::as_u64)
                    .context("Codex completed with invalid usage")?;
                let cached = usage
                    .get("cached_input_tokens")
                    .and_then(Value::as_u64)
                    .context("Codex completed with invalid usage")?;
                let output = usage
                    .get("output_tokens")
                    .and_then(Value::as_u64)
                    .context("Codex completed with invalid usage")?;
                ensure!(cached <= input, "Codex completed with invalid usage");
                self.usage = Some(NativeTokenUsage {
                    input_tokens: input,
                    cached_input_tokens: cached,
                    output_tokens: output,
                    observed_model: self.observed_model.clone(),
                });
                self.completed = true;
                Ok(None)
            }
            "item.started" | "item.updated" | "item.completed" => {
                self.item(&event, kind == "item.completed")
            }
            _ => bail!("Codex emitted an unsupported event type"),
        }
    }

    fn item(&mut self, event: &Value, completed: bool) -> Result<Option<String>> {
        let item = event
            .get("item")
            .context("Codex event is missing its item")?;
        item.get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .context("Codex item identity is invalid")?;
        match item
            .get("type")
            .and_then(Value::as_str)
            .context("Codex item type is invalid")?
        {
            "agent_message" => {
                let text = item
                    .get("text")
                    .and_then(Value::as_str)
                    .context("Codex message is invalid")?;
                if completed && !text.trim().is_empty() {
                    ensure!(
                        text.len() <= crate::MAX_RESULT,
                        "Codex final response exceeds its limit"
                    );
                    self.final_response = Some(text.into());
                    return Ok(Some(text.into()));
                }
            }
            "reasoning" => {
                item.get("text")
                    .and_then(Value::as_str)
                    .context("Codex reasoning item is invalid")?;
            }
            "command_execution" => {
                ensure!(
                    self.policy.commands,
                    "Codex attempted an unadmitted command"
                );
                item.get("command")
                    .and_then(Value::as_str)
                    .context("Codex command item is invalid")?;
                item.get("aggregated_output")
                    .and_then(Value::as_str)
                    .context("Codex command item is invalid")?;
                ensure!(
                    matches!(
                        item.get("status").and_then(Value::as_str),
                        Some("in_progress" | "completed" | "failed")
                    ),
                    "Codex command status is invalid"
                );
            }
            "file_change" => {
                ensure!(
                    self.policy.write,
                    "Codex attempted an unadmitted file change"
                );
                item.get("changes")
                    .and_then(Value::as_array)
                    .context("Codex file change item is invalid")?;
                ensure!(
                    matches!(
                        item.get("status").and_then(Value::as_str),
                        Some("completed" | "failed")
                    ),
                    "Codex file change status is invalid"
                );
            }
            "web_search" => {
                ensure!(
                    self.policy.search,
                    "Codex attempted an unadmitted web search"
                );
                item.get("query")
                    .and_then(Value::as_str)
                    .context("Codex web search item is invalid")?;
            }
            "todo_list" => {
                for todo in item
                    .get("items")
                    .and_then(Value::as_array)
                    .context("Codex todo list is invalid")?
                {
                    todo.get("text")
                        .and_then(Value::as_str)
                        .context("Codex todo list is invalid")?;
                    todo.get("completed")
                        .and_then(Value::as_bool)
                        .context("Codex todo list is invalid")?;
                }
            }
            // SDK error items are nonfatal diagnostics; their raw messages can
            // contain provider credentials, and are not forwarded as Task events.
            "error" => {
                item.get("message")
                    .and_then(Value::as_str)
                    .context("Codex error item is invalid")?;
            }
            _ => bail!("Codex emitted an unsupported tool or item"),
        }
        Ok(None)
    }

    pub(crate) fn take_usage(&mut self) -> Option<NativeTokenUsage> {
        self.usage.take()
    }

    pub(crate) fn finish(self) -> Result<(String, String)> {
        ensure!(
            self.thread.is_some(),
            "Codex completed without a thread identity"
        );
        ensure!(
            self.completed,
            "Codex process ended without a completed turn"
        );
        Ok((
            self.final_response
                .context("Codex completed without a final response")?,
            self.thread
                .context("Codex completed without a thread identity")?,
        ))
    }
}
