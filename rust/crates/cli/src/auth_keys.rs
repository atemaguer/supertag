//! `supertag auth-key create|revoke`, and the Auth Key reads behind `supertag get auth-key`.

use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use clap::{Args, Subcommand};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{auth_keys_client::AuthKeysClient, operator_client::OperatorClient, *},
};
use uuid::Uuid;

use crate::{Connection, connect_operator, request};

#[derive(Subcommand)]
pub enum AuthKeyCommand {
    /// Create a named, scoped Auth Key: one-time for a named Worker Host, or reusable.
    Create {
        /// The key's name: 1-63 lowercase letters, digits, hyphens or underscores. Never reused.
        name: String,
        /// Worker Host ID a one-time key enrolls. Omit with --reusable.
        #[arg(
            long = "host",
            required_unless_present = "reusable",
            conflicts_with = "reusable"
        )]
        host_id: Option<String>,
        /// Enroll any number of Worker Hosts, each choosing its own ID.
        #[arg(long)]
        reusable: bool,
        /// Remove hosts that join with this key once they go offline.
        #[arg(long)]
        ephemeral: bool,
        /// Label granted to every host that joins. Repeat for more labels.
        #[arg(long = "label")]
        labels: Vec<String>,
        /// Shorter lifetime. Defaults to the maximum: one hour, or 90 days with --reusable.
        #[arg(long)]
        expires_in_seconds: Option<u64>,
        /// Tag whose Tasks hosts enrolled with this key may run. Repeat for more Tags.
        #[arg(
            long,
            conflicts_with = "all_tags",
            required_unless_present = "all_tags"
        )]
        tag: Vec<String>,
        /// Let hosts enrolled with this key run Tasks for every Tag.
        #[arg(long)]
        all_tags: bool,
    },
    /// Stop an Auth Key from enrolling more Worker Hosts. Hosts that joined stay enrolled.
    Revoke { name: String },
}

// Options for `supertag get auth-keys`.
#[derive(Args)]
pub struct ListArgs {
    /// Most entries to return on one page.
    #[arg(long, default_value_t = 100, conflicts_with = "id")]
    limit: u32,
    /// The next_cursor of the previous page.
    #[arg(long, default_value = "", conflicts_with = "id")]
    cursor: String,
}

fn client(channel: ProtocolChannel) -> AuthKeysClient<ProtocolChannel> {
    AuthKeysClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

pub async fn run(connection: Connection, command: AuthKeyCommand) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let output = match command {
        AuthKeyCommand::Create {
            name,
            host_id,
            reusable,
            ephemeral,
            labels,
            expires_in_seconds,
            tag,
            all_tags,
        } => {
            let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
            let key = OperatorClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .create_auth_key(request(
                    CreateAuthKeyRequest {
                        name,
                        host_id: host_id.unwrap_or_default(),
                        reusable,
                        ephemeral,
                        labels,
                        operation_id: Uuid::new_v4().to_string(),
                        key_digest: Sha256::digest(secret.as_bytes()).to_vec(),
                        expires_in_ms: expires_in_seconds
                            .map_or(Some(0), |seconds| {
                                seconds.checked_mul(1000).filter(|ms| *ms > 0)
                            })
                            .context("invalid Auth Key lifetime")?,
                        allowed_tag_ids: tag,
                        all_tags,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            let mut created = view(&key);
            created["auth_key"] = secret.into();
            created
        }
        AuthKeyCommand::Revoke { name } => view(
            &client(channel)
                .revoke_auth_key(request(RevokeAuthKeyRequest { name }, &token)?)
                .await?
                .into_inner(),
        ),
    };
    crate::terminal::print_json(&output)?;
    Ok(())
}

/// An Auth Key without its secret. Its phase follows packages/core/src/auth-key.ts:
/// revocation wins over expiry, and expiry over a one-time key's use.
pub fn view(key: &AuthKey) -> Value {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64);
    let phase = if key.revoked {
        "revoked"
    } else if key.expires_at_ms <= now {
        "expired"
    } else if key.used && !key.reusable {
        "used"
    } else {
        "active"
    };
    json!({
        "name": key.name,
        "phase": phase,
        "host_id": key.host_id,
        "reusable": key.reusable,
        "ephemeral": key.ephemeral,
        "labels": key.labels,
        "allowed_tag_ids": key.allowed_tag_ids,
        "all_tags": key.all_tags,
        "used": key.used,
        "revoked": key.revoked,
        "created_at_ms": key.created_at_ms,
        "expires_at_ms": key.expires_at_ms,
    })
}

pub(crate) async fn fetch(channel: ProtocolChannel, token: &str, name: String) -> Result<Value> {
    Ok(view(
        &client(channel)
            .get_auth_key(request(GetAuthKeyRequest { name }, token)?)
            .await?
            .into_inner(),
    ))
}

pub(crate) async fn list(connection: Connection, args: ListArgs) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let page = client(channel)
        .list_auth_keys(request(
            ListAuthKeysRequest {
                limit: args.limit,
                cursor: args.cursor,
            },
            &token,
        )?)
        .await?
        .into_inner();
    Ok(json!({
        "auth_keys": page.auth_keys.iter().map(view).collect::<Vec<_>>(),
        "next_cursor": page.next_cursor,
    }))
}
