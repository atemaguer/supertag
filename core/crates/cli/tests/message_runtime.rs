//! `supertag message` through the local services `supertag up` runs, with the fixture adapter as
//! the Tag's harness: the reply prints, and the message and reply land in the conversation the
//! terminal UI and the desktop app read.
#[path = "support/children.rs"]
mod children;
use children::reaped;
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[path = "support/protocol.rs"]
mod protocol;
#[macro_use]
#[path = "support/database.rs"]
mod database;

use std::{net::SocketAddr, path::Path, process::Stdio, time::Duration};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use supertag_protocol::{
    authenticated_request,
    negotiation::ProtocolChannel,
    v2::{
        ConversationMessage, ListConversationsRequest, ListMessagesRequest, SendMessageRequest,
        TaskState, conversations_client::ConversationsClient,
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    time::timeout,
};
use tonic::transport::Channel;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(30);

fn command(args: &[&str]) -> Command {
    let mut command = reaped(Command::new(BINARY));
    command
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
}

/// `supertag up` with its local Control Plane on `database`: the state directory's SQLite file
/// for a SQLite URL, else the PostgreSQL database.
fn up_command(database: &str, state: &Path, args: &[&str]) -> Command {
    let mut up = command(&["up", "--foreground", "--adapter", ADAPTER]);
    up.args(args).arg("--state-directory").arg(state);
    if database.starts_with("postgres") {
        up.env("SUPERTAG_DATABASE_URL", database);
    }
    up
}

async fn service(mut command: Command) -> Result<(Child, String)> {
    let mut child = command.stdout(Stdio::piped()).spawn()?;
    let mut stdout = BufReader::new(child.stdout.take().context("service stdout missing")?);
    let mut line = String::new();
    timeout(WAIT, stdout.read_line(&mut line)).await??;
    let ready = line.trim();
    let address: SocketAddr = ready
        .strip_prefix("http://")
        .unwrap_or(ready)
        .parse()
        .context("service did not report a loopback endpoint")?;
    ensure!(address.ip().is_loopback() && address.port() != 0);
    Ok((child, format!("http://{address}")))
}

async fn channel(address: &str) -> Result<ProtocolChannel> {
    protocol::negotiated(
        Channel::from_shared(address.to_owned())?
            .timeout(WAIT)
            .connect()
            .await?,
    )
    .await
}

/// Runs `supertag ARGS --state-directory STATE`, with `stdin` written to its standard input.
async fn supertag(
    state: &Path,
    args: &[&str],
    stdin: Option<&str>,
) -> Result<std::process::Output> {
    let mut run = command(args);
    run.arg("--state-directory")
        .arg(state)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if stdin.is_some() {
        run.stdin(Stdio::piped());
    }
    let mut child = run.spawn()?;
    if let Some(text) = stdin {
        let mut input = child.stdin.take().context("stdin missing")?;
        input.write_all(text.as_bytes()).await?;
        drop(input);
    }
    Ok(timeout(WAIT, child.wait_with_output())
        .await
        .with_context(|| format!("supertag {} did not finish", args.join(" ")))??)
}

fn stdout(output: &std::process::Output) -> Result<String> {
    ensure!(
        output.status.success(),
        "supertag failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(String::from_utf8(output.stdout.clone())?)
}

/// The caller's conversation with `tag`, oldest first, as the terminal UI reads it.
async fn conversation(
    client: &mut ConversationsClient<ProtocolChannel>,
    token: &str,
    tag: &str,
) -> Result<(String, Vec<ConversationMessage>)> {
    let page = client
        .list_messages(authenticated_request(
            ListMessagesRequest {
                tag_id: tag.into(),
                limit: 50,
                ..Default::default()
            },
            token,
            None,
        )?)
        .await?
        .into_inner();
    let mut messages = page.messages;
    messages.reverse();
    Ok((page.conversation_id, messages))
}

fn prompt(message: &ConversationMessage) -> &str {
    message
        .task
        .as_ref()
        .map_or("", |task| task.prompt.as_str())
}

fn result(message: &ConversationMessage) -> &str {
    message
        .task
        .as_ref()
        .and_then(|task| task.result.as_deref())
        .unwrap_or("")
}

database_tests! {
    #[tokio::test]
    message_prints_the_reply_in_the_conversation_other_clients_show;
}

async fn message_prints_the_reply_in_the_conversation_other_clients_show(
    database: String,
) -> Result<()> {
    let directory = tempfile::Builder::new()
        .prefix("message-")
        .tempdir_in("/tmp")?;
    let state = directory.path().join("state");

    // Before supertag init, the command says how to set up, as other commands do.
    let output = supertag(&state, &["message", "engineer", "Hello"], None).await?;
    ensure!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    ensure!(
        error.contains("isn't set up on this machine yet"),
        "{error}"
    );

    let (mut runtime, endpoint) = service(up_command(
        &database,
        &state,
        &["--adapter-arg=--conversation-fixture=200"],
    ))
    .await?;
    let put = supertag(
        &state,
        &["tag", "put", "engineer", "--instructions", "Answer"],
        None,
    )
    .await?;
    stdout(&put)?;
    let credentials: Value =
        serde_json::from_slice(&std::fs::read(state.join("credentials.json"))?)?;
    let token = credentials["operator_token"]
        .as_str()
        .context("test operator credential missing")?
        .to_owned();
    let mut client = ConversationsClient::new(channel(&endpoint).await?);

    // The reply prints after the Tag's message, both as the conversation records them.
    let printed = stdout(&supertag(&state, &["message", "engineer", "Hello there"], None).await?)?;
    let (conversation_id, messages) = conversation(&mut client, &token, "engineer").await?;
    ensure!(!conversation_id.is_empty());
    let [first] = messages.as_slice() else {
        anyhow::bail!("one message expected: {messages:?}");
    };
    ensure!(prompt(first) == "Hello there");
    ensure!(first.task.as_ref().unwrap().state() == TaskState::Succeeded);
    ensure!(result(first).contains("Hello there"), "{}", result(first));
    ensure!(
        printed
            == format!(
                "I'll check the fixture, then answer: Hello there\n{}\n",
                result(first).trim()
            ),
        "{printed:?}"
    );
    let listed = client
        .list_conversations(authenticated_request(
            ListConversationsRequest {},
            &token,
            None,
        )?)
        .await?
        .into_inner();
    let thread = listed
        .conversations
        .iter()
        .find(|conversation| conversation.tag_id == "engineer")
        .context("the conversation is not listed")?;
    ensure!(thread.conversation_id == conversation_id);
    // The reply printed here counts as read in the other clients.
    ensure!(thread.unread_count == 0, "{thread:?}");

    // A message from another client, as the terminal UI sends it, continues the same
    // conversation; standard input carries the next one.
    client
        .send_message(authenticated_request(
            SendMessageRequest {
                tag_id: "engineer".into(),
                operation_id: "from-the-terminal-ui".into(),
                text: "From the terminal UI".into(),
                ..Default::default()
            },
            &token,
            None,
        )?)
        .await?;
    // Its turn finishes first, so the next message starts a turn rather than joining it.
    timeout(WAIT, async {
        loop {
            let (_, messages) = conversation(&mut client, &token, "engineer").await?;
            if messages.last().is_some_and(|message| {
                prompt(message) == "From the terminal UI"
                    && message.task.as_ref().unwrap().state() == TaskState::Succeeded
            }) {
                return Ok::<_, anyhow::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .context("the terminal UI's message was not answered")??;
    let printed =
        stdout(&supertag(&state, &["message", "engineer"], Some("Read from stdin\n")).await?)?;
    ensure!(
        printed.starts_with("I'll check the fixture, then answer: Read from stdin"),
        "{printed:?}"
    );

    // --no-wait returns once the message is accepted; its reply lands in the conversation.
    let printed = stdout(
        &supertag(
            &state,
            &["message", "engineer", "No wait", "--no-wait"],
            None,
        )
        .await?,
    )?;
    ensure!(printed.is_empty(), "{printed:?}");
    let messages = timeout(WAIT, async {
        loop {
            let (id, messages) = conversation(&mut client, &token, "engineer").await?;
            ensure!(id == conversation_id, "the conversation was replaced");
            if messages.last().is_some_and(|message| {
                prompt(message) == "No wait"
                    && message.task.as_ref().unwrap().state() == TaskState::Succeeded
            }) {
                return Ok::<_, anyhow::Error>(messages);
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .context("the message sent with --no-wait was not answered")??;
    let prompts: Vec<&str> = messages.iter().map(prompt).collect();
    ensure!(
        prompts
            == [
                "Hello there",
                "From the terminal UI",
                "Read from stdin",
                "No wait"
            ],
        "{prompts:?}"
    );

    // An unknown Tag is refused as `task submit` refuses it; an empty message is refused too.
    let output = supertag(&state, &["message", "nobody", "Hello"], None).await?;
    ensure!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    ensure!(error.trim() == "Error: Tag was not found", "{error}");
    let output = supertag(&state, &["message", "engineer"], Some("  \n")).await?;
    ensure!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    ensure!(error.contains("the message is empty"), "{error}");

    // task submit refuses the conversation's own Session and names this command.
    let session = messages[0]
        .task
        .as_ref()
        .map(|task| task.session_id.clone())
        .unwrap_or_default();
    ensure!(session.starts_with("conversation/"), "{session}");
    let output = supertag(
        &state,
        &[
            "task",
            "submit",
            "--tag",
            "engineer",
            "--session",
            &session,
            "Hi",
        ],
        None,
    )
    .await?;
    ensure!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    ensure!(
        error.contains("send to it with supertag message engineer TEXT"),
        "{error}"
    );

    // Two messages queued while no Worker Host claims: the first turn's claim joins the second,
    // so the command prints the first turn's answer to both, not its own "Input accepted".
    let hosts: Value =
        serde_json::from_str(&stdout(&supertag(&state, &["get", "hosts"], None).await?)?)?;
    let host = hosts["hosts"][0]["host_id"]
        .as_str()
        .context("no Worker Host is listed")?
        .to_owned();
    stdout(&supertag(&state, &["host", "drain", &host], None).await?)?;
    client
        .send_message(authenticated_request(
            SendMessageRequest {
                tag_id: "engineer".into(),
                operation_id: "first".into(),
                text: "First".into(),
                ..Default::default()
            },
            &token,
            None,
        )?)
        .await?;
    let joining = {
        let state = state.clone();
        tokio::spawn(
            async move { supertag(&state, &["message", "engineer", "Join it"], None).await },
        )
    };
    timeout(WAIT, async {
        loop {
            let (_, messages) = conversation(&mut client, &token, "engineer").await?;
            if messages
                .last()
                .is_some_and(|message| prompt(message) == "Join it")
            {
                return Ok::<_, anyhow::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .context("the joining message was not sent")??;
    stdout(&supertag(&state, &["host", "resume", &host], None).await?)?;
    let printed = stdout(&joining.await??)?;
    let (_, messages) = conversation(&mut client, &token, "engineer").await?;
    let [.., first, joined] = messages.as_slice() else {
        anyhow::bail!("two messages expected: {messages:?}");
    };
    ensure!(prompt(first) == "First" && prompt(joined) == "Join it");
    ensure!(
        joined
            .live_input
            .as_ref()
            .is_some_and(|input| input.task_id == first.task.as_ref().unwrap().task_id),
        "{joined:?}"
    );
    ensure!(
        printed.ends_with(&format!("{}\n", result(first).trim()))
            && result(first).contains("Join it"),
        "{printed:?} {:?}",
        result(first)
    );

    if let Some(pid) = runtime.id() {
        // SAFETY: this PID belongs to the supervised disposable runtime.
        unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    }
    ensure!(timeout(WAIT, runtime.wait()).await??.success());
    Ok(())
}
