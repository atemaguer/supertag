//! Direct messages between Tags: `supertag mailbox-grant allow|revoke`, and the
//! `get mailbox-grants --tag TAG` and `get messages --mailbox TAG` reads.

use anyhow::Result;
use clap::{Args, Subcommand};
use serde_json::{Value, json};
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    negotiation::ProtocolChannel,
    v2::{
        ChangeMailboxGrantRequest, ListMailboxGrantsRequest, ListMailboxMessagesRequest,
        mailbox_client::MailboxClient,
    },
};
use uuid::Uuid;

use crate::{Connection, connect_operator, request};

/// `supertag mailbox-grant VERB`.
#[derive(Subcommand)]
pub enum GrantCommand {
    /// Allow one Tag to send direct messages to another Tag.
    Allow {
        sender_tag_id: String,
        recipient_tag_id: String,
        /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
        #[arg(long)]
        operation_id: Option<String>,
    },
    /// Remove a directional grant; shared Team membership still permits messages.
    Revoke {
        sender_tag_id: String,
        recipient_tag_id: String,
        /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
        #[arg(long)]
        operation_id: Option<String>,
    },
}

// Options for `supertag get mailbox-grants`.
#[derive(Args)]
pub struct GrantListArgs {
    /// The Tag whose incoming and outgoing grants to list.
    #[arg(long)]
    tag: String,
    /// Most entries to return on one page.
    #[arg(long, default_value_t = 32, value_parser = clap::value_parser!(u32).range(1..=100))]
    limit: u32,
    /// Continue from the cursor the previous page returned.
    #[arg(long, default_value = "")]
    cursor: String,
}

// Options for `supertag get messages`.
#[derive(Args)]
pub struct MessageListArgs {
    /// The Tag whose sent and received messages to list.
    #[arg(long)]
    mailbox: String,
    /// Most entries to return on one page.
    #[arg(long, default_value_t = 32)]
    limit: u32,
    /// Continue from the cursor the previous page returned.
    #[arg(long, default_value = "")]
    cursor: String,
}

fn client(channel: ProtocolChannel) -> MailboxClient<ProtocolChannel> {
    MailboxClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

pub(crate) async fn list_grants(connection: Connection, args: GrantListArgs) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let page = client(channel)
        .list_grants(request(
            ListMailboxGrantsRequest {
                tag_id: args.tag,
                limit: args.limit,
                cursor: args.cursor,
            },
            &token,
        )?)
        .await?
        .into_inner();
    let grants: Vec<_> = page
        .grants
        .into_iter()
        .map(|grant| {
            json!({
                "sender_tag_id": grant.sender_tag_id,
                "recipient_tag_id": grant.recipient_tag_id,
                "granted_by": grant.granted_by,
                "granted_at_ms": grant.granted_at_ms,
            })
        })
        .collect();
    Ok(json!({ "grants": grants, "next_cursor": page.next_cursor }))
}

pub(crate) async fn list_messages(connection: Connection, args: MessageListArgs) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let page = client(channel)
        .list_messages(request(
            ListMailboxMessagesRequest {
                tag_id: args.mailbox,
                limit: args.limit,
                cursor: args.cursor,
            },
            &token,
        )?)
        .await?
        .into_inner();
    let messages = page
        .messages
        .into_iter()
        .map(|message| {
            json!({
                "message_id": message.message_id,
                "sender_tag_id": message.sender_tag_id,
                "recipient_tag_id": message.recipient_tag_id,
                "source_task_id": message.source_task_id,
                "origin": message.origin().as_str_name(),
                "workstream_post_id": message.workstream_post_id,
                "objective_id": message.objective_id,
                "text": message.text,
                "hops": message.hops,
                "task_id": message.task_id,
                "state": message.state().as_str_name(),
                "created_at_ms": message.created_at_ms,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({ "messages": messages, "next_cursor": page.next_cursor }))
}

pub async fn run(connection: Connection, command: GrantCommand) -> Result<()> {
    let granted = matches!(command, GrantCommand::Allow { .. });
    let (GrantCommand::Allow {
        sender_tag_id,
        recipient_tag_id,
        operation_id,
    }
    | GrantCommand::Revoke {
        sender_tag_id,
        recipient_tag_id,
        operation_id,
    }) = command;
    let (channel, token) = connect_operator(connection).await?;
    let operation_id = operation_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let result = client(channel)
        .change_grant(request(
            ChangeMailboxGrantRequest {
                operation_id: operation_id.clone(),
                sender_tag_id: sender_tag_id.clone(),
                recipient_tag_id: recipient_tag_id.clone(),
                granted,
            },
            &token,
        )?)
        .await?
        .into_inner();
    crate::terminal::print_json(&json!({
        "operation_id": operation_id,
        "sender_tag_id": sender_tag_id,
        "recipient_tag_id": recipient_tag_id,
        "action": if granted { "allow" } else { "revoke" },
        "changed": result.changed,
    }))?;
    Ok(())
}
