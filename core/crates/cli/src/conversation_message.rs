//! `supertag message TAG [TEXT]`: sends a message into the caller's conversation with a Tag, the
//! one the terminal UI and the desktop app show, and prints the Tag's reply.
//!
//! It calls the Conversations service as those clients do: `SendMessage` sends, then
//! `FollowConversation` follows the turn until it finishes. When the stream drops, `GetMessage`
//! reads the turn until it opens again. A Gateway that cannot push the conversation is read with
//! `GetMessage` alone. Once the reply is printed, `MarkConversationRead` records that the caller
//! read it, so the other clients do not count it as unread.

use std::{
    collections::HashMap,
    io::{IsTerminal as _, Read as _},
    time::Duration,
};

use anyhow::{Result, bail, ensure};
use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request,
    negotiation::ProtocolChannel,
    v2::{
        ConversationMessage, FollowConversationRequest, GetMessageRequest, LiveInputState,
        MarkConversationReadRequest, SendMessageRequest, TaskEventKind, TaskState, TurnText,
        conversations_client::ConversationsClient,
    },
};
use tonic::Code;
use uuid::Uuid;

use crate::{Connection, request};

#[derive(clap::Args)]
pub struct MessageArgs {
    /// Tag to message, by ID.
    tag: String,
    /// What to say. Without it, the message is read from standard input.
    text: Option<String>,
    /// Return once the message is accepted, without waiting for the reply.
    #[arg(long)]
    no_wait: bool,
    #[command(flatten)]
    connection: Connection,
}

/// How long the follow stream may go without a response, heartbeats included, before it counts
/// as dropped. The Gateway sends a heartbeat at least every 15 seconds.
const STREAM_IDLE: Duration = Duration::from_secs(45);
/// How often the turn is read while the stream is down or the Gateway cannot push it.
const POLL: Duration = Duration::from_secs(2);
/// How often the turn is read while the stream is open.
const READ_EVERY: Duration = Duration::from_secs(5);
/// Attempts at sending while the Gateway is unavailable. Each retry carries the same operation
/// ID, so the message is sent once.
const SEND_ATTEMPTS: usize = 3;

type Client = ConversationsClient<ProtocolChannel>;

pub async fn run(args: MessageArgs) -> Result<()> {
    let target = crate::resolve_target(args.connection)?;
    let text = match args.text {
        Some(text) => text,
        None => read_stdin()?,
    };
    ensure!(
        !text.trim().is_empty(),
        "the message is empty; pass TEXT or write it to standard input"
    );
    // The follow stream stays open for as long as the turn runs; each unary call sets its own
    // timeout.
    let endpoint = target
        .endpoint(Duration::from_secs(u32::MAX as u64))
        .await?;
    let mut client = ConversationsClient::new(crate::network::operator_channel(&endpoint).await?)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let sent = send(&mut client, &target.token, &args.tag, text).await?;
    if args.no_wait {
        return Ok(());
    }
    // Text the Tag is still writing streams only to a terminal, which shows it as it grows.
    // terminal-safe: asks whether standard output is a terminal; it writes nothing.
    let streams = std::io::stdout().is_terminal();
    let mut reply = Reply::new(args.tag, sent, streams);
    follow(&mut client, &target.token, &mut reply).await?;
    // Best effort: the reply was printed whether or not the read mark is recorded.
    let _ = client
        .mark_conversation_read(request(
            MarkConversationReadRequest {
                tag_id: reply.tag.clone(),
                order: reply.read_order(),
            },
            &target.token,
        )?)
        .await;
    Ok(())
}

fn read_stdin() -> Result<String> {
    let stdin = std::io::stdin();
    if stdin.is_terminal() {
        errln!("Type the message, then press Ctrl-D.");
    }
    let mut text = String::new();
    stdin.lock().read_to_string(&mut text)?;
    // The line break that ends piped text is not part of the message.
    Ok(text.trim_end().to_owned())
}

async fn send(
    client: &mut Client,
    token: &str,
    tag: &str,
    text: String,
) -> Result<ConversationMessage> {
    let body = SendMessageRequest {
        tag_id: tag.to_owned(),
        text,
        operation_id: Uuid::new_v4().to_string(),
        ..Default::default()
    };
    let mut attempt = 1;
    loop {
        match client.send_message(request(body.clone(), token)?).await {
            Ok(response) => {
                let message = response.into_inner();
                ensure!(
                    message
                        .task
                        .as_ref()
                        .is_some_and(|task| !task.task_id.is_empty() && task.tag_id == tag),
                    "the Gateway returned a message of another conversation"
                );
                return Ok(message);
            }
            Err(status) if status.code() == Code::Unavailable && attempt < SEND_ATTEMPTS => {
                attempt += 1;
                tokio::time::sleep(POLL).await;
            }
            Err(status) => return Err(status.into()),
        }
    }
}

/// Follows the turn until it finishes, printing what it shows as it arrives.
async fn follow(client: &mut Client, token: &str, reply: &mut Reply) -> Result<()> {
    if reply.step()? {
        return Ok(());
    }
    let mut push = true;
    loop {
        if push {
            match stream(client, token, reply).await {
                Ok(true) => return Ok(()),
                Ok(false) => {}
                // A Gateway that does not push conversations to this caller is read instead.
                Err(error)
                    if error.downcast_ref::<tonic::Status>().is_some_and(|status| {
                        matches!(status.code(), Code::Unimplemented | Code::PermissionDenied)
                    }) =>
                {
                    push = false;
                }
                // The turn failed, rather than the connection.
                Err(error) if reply.failure.is_some() => return Err(error),
                Err(_) => {}
            }
        }
        tokio::time::sleep(POLL).await;
        read(client, token, reply).await?;
        if reply.step()? {
            return Ok(());
        }
    }
}

/// Reads the followed turns once.
async fn read(client: &mut Client, token: &str, reply: &mut Reply) -> Result<()> {
    for task_id in reply.followed() {
        match client
            .get_message(request(
                GetMessageRequest {
                    tag_id: reply.tag.clone(),
                    task_id,
                },
                token,
            )?)
            .await
        {
            Ok(message) => reply.take(message.into_inner()),
            Err(status) if transient(&status) => {}
            Err(status) => return Err(status.into()),
        }
    }
    Ok(())
}

/// Reads one follow stream until the turn finishes (true) or the stream ends or goes idle
/// (false). The turns are also read every [`READ_EVERY`]: the stream pushes changes to turns, and
/// a message delivered into a running turn changes only its own delivery.
async fn stream(client: &mut Client, token: &str, reply: &mut Reply) -> Result<bool> {
    let mut stream = client
        .follow_conversation(authenticated_request(
            FollowConversationRequest {
                tag_id: reply.tag.clone(),
                ..Default::default()
            },
            token,
            None,
        )?)
        .await?
        .into_inner();
    let mut reads = tokio::time::interval(READ_EVERY);
    reads.reset();
    let mut idle = tokio::time::Instant::now() + STREAM_IDLE;
    loop {
        tokio::select! {
            response = stream.message() => {
                let Some(response) = response? else {
                    return Ok(false);
                };
                idle = tokio::time::Instant::now() + STREAM_IDLE;
                for message in response.messages.into_iter().flat_map(|page| page.messages) {
                    reply.take(message);
                }
                if reply.step()? {
                    return Ok(true);
                }
                for text in response.texts {
                    out!("{}", reply.text(&text));
                }
            }
            _ = reads.tick() => {
                read(client, token, reply).await?;
                if reply.step()? {
                    return Ok(true);
                }
            }
            () = tokio::time::sleep_until(idle) => return Ok(false),
        }
    }
}

fn transient(status: &tonic::Status) -> bool {
    matches!(
        status.code(),
        Code::Unavailable | Code::DeadlineExceeded | Code::Cancelled | Code::Unknown
    )
}

/// The turn that answers one sent message, and what of it has been printed.
///
/// As in the terminal UI, the Tag's last message before its reply is left out when the reply
/// contains it: a harness records its final answer both as a message and as the turn's result.
/// So the latest recorded message is held until something follows it.
struct Reply {
    tag: String,
    /// The sent message's Task.
    own: String,
    /// The Task whose reply answers the message: its own, or the running turn it joined.
    answering: Option<String>,
    /// The latest copy of each message read.
    messages: HashMap<String, ConversationMessage>,
    /// The sequence of the latest event of the answering turn taken in.
    seen: u64,
    /// The sequence of the latest message event taken in.
    said: u64,
    /// The latest recorded message, not printed yet.
    held: Option<String>,
    /// The last text printed in full, trimmed.
    printed: Option<String>,
    /// Text the Tag is still writing, printed as it streams: the event it follows, and what of
    /// it was printed. Only on a terminal; a script reads only recorded messages.
    partial: Option<(u64, String)>,
    replied: bool,
    stream_text: bool,
    /// A failure that ended the follow: the turn's own, not the connection's.
    failure: Option<String>,
}

impl Reply {
    fn new(tag: String, sent: ConversationMessage, stream_text: bool) -> Self {
        let own = sent
            .task
            .as_ref()
            .map(|task| task.task_id.clone())
            .unwrap_or_default();
        let mut reply = Self {
            tag,
            own,
            answering: None,
            messages: HashMap::new(),
            seen: 0,
            said: 0,
            held: None,
            printed: None,
            partial: None,
            replied: false,
            stream_text,
            failure: None,
        };
        reply.take(sent);
        reply
    }

    fn take(&mut self, message: ConversationMessage) {
        if let Some(task) = &message.task
            && task.tag_id == self.tag
            && !task.task_id.is_empty()
        {
            self.messages.insert(task.task_id.clone(), message);
        }
    }

    /// The Tasks a poll reads.
    fn followed(&self) -> Vec<String> {
        let mut ids = vec![self.own.clone()];
        ids.extend(self.answering.iter().filter(|id| **id != self.own).cloned());
        ids
    }

    /// The order the caller has now read up to.
    fn read_order(&self) -> u64 {
        self.followed()
            .iter()
            .filter_map(|id| self.messages.get(id))
            .map(|message| message.order)
            .max()
            .unwrap_or_default()
    }

    /// Prints what changed and says whether the turn finished; a turn that failed is an error.
    fn step(&mut self) -> Result<bool> {
        let (output, done) = self.advance();
        out!("{output}");
        if let Some(failure) = &self.failure {
            bail!("{failure}");
        }
        Ok(done)
    }

    /// What to print now, and whether the turn finished. Sets `failure` when it failed.
    fn advance(&mut self) -> (String, bool) {
        let mut output = String::new();
        let Some(own) = self.messages.get(&self.own) else {
            return (output, false);
        };
        // A message joined to another turn, when that turn claimed it or took it while running,
        // is answered by that turn's reply, which a client follows from its start.
        let answering = match own.live_input.as_ref() {
            Some(input)
                if input.state() == LiveInputState::Accepted && !input.task_id.is_empty() =>
            {
                input.task_id.clone()
            }
            Some(input)
                if matches!(
                    input.state(),
                    LiveInputState::Pending | LiveInputState::Dispatching
                ) =>
            {
                return (output, false);
            }
            Some(input) if input.state() == LiveInputState::Unknown => {
                self.failure = Some(format!(
                    "delivery of your message to {}'s running turn is uncertain and needs operator recovery",
                    self.tag
                ));
                return (output, true);
            }
            _ => self.own.clone(),
        };
        if self.answering.as_deref() != Some(answering.as_str()) {
            self.answering = Some(answering.clone());
            self.seen = 0;
            self.said = 0;
        }
        let Some(message) = self.messages.get(&answering) else {
            return (output, false);
        };
        let Some(task) = message.task.clone() else {
            return (output, false);
        };
        let mut events: Vec<(u64, TaskEventKind, String)> = message
            .events
            .iter()
            .map(|event| (event.sequence, event.kind(), event.text.clone()))
            .collect();
        events.sort_by_key(|(sequence, ..)| *sequence);
        for (sequence, kind, text) in events {
            if sequence <= self.seen {
                continue;
            }
            self.seen = sequence;
            match kind {
                TaskEventKind::Message if !text.trim().is_empty() => {
                    self.said = sequence;
                    output.push_str(&self.flush());
                    if self
                        .partial
                        .as_ref()
                        .is_some_and(|(_, shown)| !shown.is_empty())
                    {
                        // On the screen already: finish it.
                        output.push_str(&self.finish(&text));
                    } else {
                        self.held = Some(text);
                    }
                }
                // The Tag kept working after its message, so the message is not its answer.
                TaskEventKind::Activity | TaskEventKind::Progress => {
                    output.push_str(&self.flush());
                }
                _ => {}
            }
        }
        let result = task.result.clone().unwrap_or_default();
        match task.state() {
            TaskState::Succeeded => {
                if !self.replied {
                    output.push_str(&self.reply(&result));
                }
                (output, true)
            }
            TaskState::Running if !result.is_empty() && !self.replied => {
                // The reply shows once the harness finishes, while the Worker Host still
                // delivers the turn's changes.
                output.push_str(&self.reply(&result));
                self.replied = true;
                (output, false)
            }
            state @ (TaskState::Failed | TaskState::Cancelled | TaskState::Uncertain) => {
                output.push_str(&self.flush());
                output.push_str(&self.finish(""));
                let reason = match state {
                    TaskState::Uncertain => {
                        "execution is uncertain and needs operator recovery".to_owned()
                    }
                    _ if !result.trim().is_empty() => result.trim().to_owned(),
                    TaskState::Failed => "the turn failed".to_owned(),
                    _ => "the turn was cancelled".to_owned(),
                };
                self.failure = Some(format!("{} could not answer: {reason}", self.tag));
                (output, true)
            }
            _ => (output, false),
        }
    }

    /// Prints the held message.
    fn flush(&mut self) -> String {
        match self.held.take() {
            Some(text) => self.finish(&text),
            None => String::new(),
        }
    }

    /// Prints the reply, leaving out a held message it contains and a message equal to it.
    fn reply(&mut self, result: &str) -> String {
        let mut output = String::new();
        if let Some(held) = self.held.take()
            && !result.contains(held.trim())
        {
            output.push_str(&self.finish(&held));
        }
        let streaming = self
            .partial
            .as_ref()
            .is_some_and(|(_, shown)| !shown.is_empty());
        if streaming || self.printed.as_deref() != Some(result.trim()) {
            output.push_str(&self.finish(result));
        }
        output
    }

    /// Prints a recorded text: what the stream did not already show of it.
    fn finish(&mut self, full: &str) -> String {
        let trimmed = full.trim();
        let output = match self.partial.take() {
            Some((_, shown)) if !shown.is_empty() => match full.strip_prefix(&shown) {
                Some(rest) => format!("{}\n", rest.trim_end()),
                None if trimmed.is_empty() => "\n".to_owned(),
                None => format!("\n{trimmed}\n"),
            },
            _ if trimmed.is_empty() => String::new(),
            _ => format!("{trimmed}\n"),
        };
        if !trimmed.is_empty() {
            self.printed = Some(trimmed.to_owned());
        }
        output
    }

    /// What to print of the text the Tag is writing now.
    fn text(&mut self, text: &TurnText) -> String {
        if !self.stream_text
            || self.replied
            || self.answering.as_deref() != Some(text.task_id.as_str())
            || text.after_sequence < self.said
            || text.text.is_empty()
        {
            return String::new();
        }
        match &mut self.partial {
            Some((after, shown)) if *after == text.after_sequence => {
                match text.text.strip_prefix(shown.as_str()) {
                    Some(rest) => {
                        let rest = rest.to_owned();
                        shown.push_str(&rest);
                        rest
                    }
                    // Rewritten text waits for the recorded message.
                    None => String::new(),
                }
            }
            Some(_) => {
                // A new message began before the last one was recorded.
                self.partial = Some((text.after_sequence, text.text.clone()));
                format!("\n{}", text.text)
            }
            None => {
                // The Tag writes on, so the message before is not its answer.
                let held = self.flush();
                self.partial = Some((text.after_sequence, text.text.clone()));
                format!("{held}{}", text.text)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use supertag_protocol::v2::{LiveInput, Task, TaskEvent};

    fn message(task_id: &str, state: TaskState, result: Option<&str>) -> ConversationMessage {
        ConversationMessage {
            task: Some(Task {
                task_id: task_id.into(),
                tag_id: "lead".into(),
                state: state as i32,
                result: result.map(str::to_owned),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn said(sequence: u64, text: &str) -> TaskEvent {
        TaskEvent {
            sequence,
            text: text.into(),
            kind: TaskEventKind::Message as i32,
        }
    }

    fn streamed(task_id: &str, after_sequence: u64, text: &str) -> TurnText {
        TurnText {
            task_id: task_id.into(),
            after_sequence,
            text: text.into(),
        }
    }

    #[test]
    fn a_script_reads_the_recorded_messages_and_the_reply_once() {
        let mut reply = Reply::new("lead".into(), message("t1", TaskState::Queued, None), false);
        assert_eq!(reply.advance(), (String::new(), false));
        assert_eq!(reply.text(&streamed("t1", 0, "Look")), "");
        let mut running = message("t1", TaskState::Running, None);
        running.events = vec![
            said(1, "  I'll look.  "),
            TaskEvent {
                sequence: 2,
                text: "Reading".into(),
                kind: TaskEventKind::Activity as i32,
            },
        ];
        reply.take(running.clone());
        assert_eq!(reply.advance(), ("I'll look.\n".into(), false));
        reply.take(running.clone());
        assert_eq!(reply.advance(), (String::new(), false));
        // The final answer, recorded as a message and as the result, prints once.
        let mut done = message("t1", TaskState::Succeeded, Some("Done."));
        done.events = running.events;
        done.events.push(said(3, "Done."));
        reply.take(done);
        assert_eq!(reply.advance(), ("Done.\n".into(), true));
        assert!(reply.failure.is_none());
    }

    #[test]
    fn a_terminal_sees_the_text_as_it_is_written() {
        let mut reply = Reply::new("lead".into(), message("t1", TaskState::Running, None), true);
        reply.advance();
        assert_eq!(reply.text(&streamed("t1", 0, "Hel")), "Hel");
        assert_eq!(reply.text(&streamed("t1", 0, "Hello wor")), "lo wor");
        // A rewrite waits for the recorded message.
        assert_eq!(reply.text(&streamed("t1", 0, "Hi")), "");
        let mut running = message("t1", TaskState::Running, None);
        running.events = vec![said(1, "Hello world.")];
        reply.take(running.clone());
        assert_eq!(reply.advance(), ("ld.\n".into(), false));
        // Stale text of the recorded message prints nothing.
        assert_eq!(reply.text(&streamed("t1", 0, "Hello world.")), "");
        // The answer streams, then its recorded copy replaces it.
        assert_eq!(reply.text(&streamed("t1", 1, "Draft")), "Draft");
        let mut done = message("t1", TaskState::Succeeded, Some("The answer."));
        done.events = running.events;
        reply.take(done);
        assert_eq!(reply.advance(), ("\nThe answer.\n".into(), true));
    }

    #[test]
    fn a_message_joined_to_another_turn_prints_that_turns_reply() {
        // Queued with no delivery yet, then joined when another turn claimed it.
        let mut reply = Reply::new("lead".into(), message("t2", TaskState::Queued, None), false);
        assert_eq!(reply.advance(), (String::new(), false));
        let mut joined = message(
            "t2",
            TaskState::Succeeded,
            Some("Input accepted by Task t1."),
        );
        joined.live_input = Some(LiveInput {
            task_id: "t1".into(),
            state: LiveInputState::Accepted as i32,
            ..Default::default()
        });
        reply.take(joined);
        assert_eq!(reply.advance(), (String::new(), false));
        assert_eq!(reply.followed(), ["t2", "t1"]);
        let mut source = message("t1", TaskState::Running, None);
        source.events = vec![said(4, "Reading both messages.")];
        reply.take(source.clone());
        // Held until something follows it: it may be the answer.
        assert_eq!(reply.advance(), (String::new(), false));
        let mut done = message("t1", TaskState::Succeeded, Some("Both done."));
        done.events = source.events;
        reply.take(done);
        assert_eq!(
            reply.advance(),
            ("Reading both messages.\nBoth done.\n".into(), true)
        );

        // A delivery into a running turn waits until the harness takes it.
        let mut sent = message("t3", TaskState::Queued, None);
        sent.live_input = Some(LiveInput {
            task_id: "t1".into(),
            state: LiveInputState::Pending as i32,
            ..Default::default()
        });
        let mut reply = Reply::new("lead".into(), sent, false);
        reply.take(message("t1", TaskState::Succeeded, Some("Earlier answer.")));
        assert_eq!(reply.advance(), (String::new(), false));
    }

    #[test]
    fn a_failed_turn_or_uncertain_delivery_is_an_error() {
        let mut reply = Reply::new(
            "lead".into(),
            message(
                "t1",
                TaskState::Failed,
                Some("No Worker Host may run lead."),
            ),
            false,
        );
        assert_eq!(reply.advance(), (String::new(), true));
        assert_eq!(
            reply.failure.as_deref(),
            Some("lead could not answer: No Worker Host may run lead.")
        );
        let mut reply = Reply::new(
            "lead".into(),
            message("t1", TaskState::Cancelled, None),
            false,
        );
        reply.advance();
        assert_eq!(
            reply.failure.as_deref(),
            Some("lead could not answer: the turn was cancelled")
        );
        let mut sent = message("t2", TaskState::Queued, None);
        sent.live_input = Some(LiveInput {
            task_id: "t1".into(),
            state: LiveInputState::Unknown as i32,
            ..Default::default()
        });
        let mut reply = Reply::new("lead".into(), sent, false);
        assert_eq!(reply.advance(), (String::new(), true));
        assert!(reply.failure.as_deref().unwrap().contains("uncertain"));
    }

    #[test]
    fn a_reply_shown_while_changes_deliver_is_not_printed_twice() {
        let mut reply = Reply::new(
            "lead".into(),
            message("t1", TaskState::Running, Some("Here.")),
            false,
        );
        assert_eq!(reply.advance(), ("Here.\n".into(), false));
        reply.take(message("t1", TaskState::Succeeded, Some("Here.")));
        assert_eq!(reply.advance(), (String::new(), true));

        // A streamed message equal to the reply prints once too.
        let mut reply = Reply::new("lead".into(), message("t1", TaskState::Running, None), true);
        reply.advance();
        assert_eq!(reply.text(&streamed("t1", 0, "All")), "All");
        let mut done = message("t1", TaskState::Succeeded, Some("All set."));
        done.events = vec![said(1, "All set.")];
        reply.take(done);
        assert_eq!(reply.advance(), (" set.\n".into(), true));
    }
}
