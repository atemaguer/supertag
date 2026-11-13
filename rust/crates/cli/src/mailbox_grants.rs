use anyhow::Result;
use clap::Subcommand;
use serde_json::json;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{ChangeMailboxGrantRequest, ListMailboxGrantsRequest, mailbox_client::MailboxClient},
};
use uuid::Uuid;

use crate::{Connection, connect_operator, request};

#[derive(Subcommand)]
pub enum MailboxGrantCommand {
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
    /// List the incoming and outgoing direct message grants for a Tag.
    List {
        tag_id: String,
        #[arg(long, default_value_t = 32, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
        #[arg(long, default_value = "")]
        cursor: String,
    },
}

pub async fn run(connection: Connection, command: MailboxGrantCommand) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let mut client = MailboxClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES);
    let output = match command {
        MailboxGrantCommand::List {
            tag_id,
            limit,
            cursor,
        } => {
            let page = client
                .list_grants(request(
                    ListMailboxGrantsRequest {
                        tag_id,
                        limit,
                        cursor,
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
            json!({ "grants": grants, "next_cursor": page.next_cursor })
        }
        command => {
            let granted = matches!(command, MailboxGrantCommand::Allow { .. });
            let (sender_tag_id, recipient_tag_id, operation_id) = match command {
                MailboxGrantCommand::Allow {
                    sender_tag_id,
                    recipient_tag_id,
                    operation_id,
                }
                | MailboxGrantCommand::Revoke {
                    sender_tag_id,
                    recipient_tag_id,
                    operation_id,
                } => (sender_tag_id, recipient_tag_id, operation_id),
                MailboxGrantCommand::List { .. } => unreachable!("handled above"),
            };
            let operation_id = operation_id.unwrap_or_else(|| Uuid::new_v4().to_string());
            let result = client
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
            json!({
                "operation_id": operation_id,
                "sender_tag_id": sender_tag_id,
                "recipient_tag_id": recipient_tag_id,
                "action": if granted { "allow" } else { "revoke" },
                "changed": result.changed,
            })
        }
    };
    crate::terminal::print_json(&output)?;
    Ok(())
}
