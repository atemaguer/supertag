use anyhow::{Context, Result, bail, ensure};
use serde_json::Value;
use supertag_protocol::v2::{NativeTokenUsage, TaskEventKind};

use crate::config::Policy;

/// A Task event this stream produces: its kind and text.
pub(crate) type Event = (TaskEventKind, String);

/// The most an activity line shows before it is cut short.
const MAX_ACTIVITY_CHARS: usize = 160;

fn activity(text: &str) -> Option<Event> {
    Some((TaskEventKind::Activity, text.to_owned()))
}

/// The first line of `text`, marked when more follows. It is cut to length only after it is
/// redacted ([`shorten`]), so a cut never leaves part of a secret that redaction cannot match.
fn one_line(text: &str) -> String {
    let line = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim();
    if text.trim() == line {
        line.to_owned()
    } else {
        format!("{line}…")
    }
}

/// An activity line cut to its length. Call it on redacted text.
pub(crate) fn shorten(line: String) -> String {
    if line.chars().count() <= MAX_ACTIVITY_CHARS {
        return line;
    }
    let mut short: String = line.chars().take(MAX_ACTIVITY_CHARS - 1).collect();
    short.push('…');
    short
}

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

    pub(crate) fn accept(&mut self, line: &[u8]) -> Result<Option<Event>> {
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
            return Ok(None);
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
                    total_tokens: None,
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

    fn item(&mut self, event: &Value, completed: bool) -> Result<Option<Event>> {
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
                    return Ok(Some((TaskEventKind::Message, text.into())));
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
                let command = item
                    .get("command")
                    .and_then(Value::as_str)
                    .context("Codex command item is invalid")?;
                item.get("aggregated_output")
                    .and_then(Value::as_str)
                    .context("Codex command item is invalid")?;
                let status = item.get("status").and_then(Value::as_str);
                ensure!(
                    matches!(status, Some("in_progress" | "completed" | "failed")),
                    "Codex command status is invalid"
                );
                if status == Some("in_progress") {
                    return Ok(activity(&format!("Running {}", one_line(command))));
                }
            }
            "file_change" => {
                ensure!(
                    self.policy.write,
                    "Codex attempted an unadmitted file change"
                );
                let changes = item
                    .get("changes")
                    .and_then(Value::as_array)
                    .context("Codex file change item is invalid")?;
                let status = item.get("status").and_then(Value::as_str);
                ensure!(
                    matches!(status, Some("completed" | "failed")),
                    "Codex file change status is invalid"
                );
                let paths: Vec<&str> = changes
                    .iter()
                    .filter_map(|change| change.get("path").and_then(Value::as_str))
                    .collect();
                if completed && status == Some("completed") && !paths.is_empty() {
                    return Ok(activity(&format!("Edited {}", one_line(&paths.join(", ")))));
                }
            }
            "web_search" => {
                ensure!(
                    self.policy.search,
                    "Codex attempted an unadmitted web search"
                );
                let query = item
                    .get("query")
                    .and_then(Value::as_str)
                    .context("Codex web search item is invalid")?;
                if !completed && !query.trim().is_empty() {
                    return Ok(activity(&format!(
                        "Searching the web for {}",
                        one_line(query)
                    )));
                }
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
