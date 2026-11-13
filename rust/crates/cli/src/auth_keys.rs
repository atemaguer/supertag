//! `supertag auth-key create|revoke`, and the Auth Key reads behind `supertag get auth-key`.
//!
//! An Auth Key admits one role: Worker Hosts (`host enroll`), Gateways (`gateway enroll`), or
//! clients (`supertag connect`). Each enrollee chooses its own name.

use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use clap::{Args, Subcommand, ValueEnum};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    AUTH_KEY_SECRET_PREFIX, MAX_MESSAGE_BYTES, new_secret,
    v2::{auth_keys_client::AuthKeysClient, operator_client::OperatorClient, *},
};
use uuid::Uuid;

/// The one role every enrollee of an Auth Key takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum KeyRole {
    /// Worker Hosts, with `supertag host enroll`.
    Host,
    /// Gateways, with `supertag gateway enroll`.
    Gateway,
    /// Clients (a device running the CLI, terminal UI, or desktop app), with `supertag connect`.
    Client,
}

impl KeyRole {
    fn proto(self) -> PrincipalRole {
        match self {
            Self::Host => PrincipalRole::Host,
            Self::Gateway => PrincipalRole::Gateway,
            Self::Client => PrincipalRole::Client,
        }
    }
}

/// The lowercase role name of a principal role, as the CLI prints it.
pub fn role_name(role: i32) -> &'static str {
    match PrincipalRole::try_from(role) {
        Ok(PrincipalRole::Operator) => "operator",
        Ok(PrincipalRole::Host) => "host",
        Ok(PrincipalRole::Gateway) => "gateway",
        Ok(PrincipalRole::Client) => "client",
        _ => "unspecified",
    }
}

use crate::{Connection, connect_operator, request};

#[derive(Subcommand)]
pub enum AuthKeyCommand {
    /// Create a named Auth Key for one role: one-time for a single enrollee, or reusable. Every
    /// enrollee chooses its own name.
    Create {
        /// The key's name: 1-63 lowercase letters, digits, hyphens or underscores. Never reused.
        name: String,
        /// The role every enrollee takes. It never changes.
        #[arg(long, value_enum)]
        role: KeyRole,
        /// Enroll any number of principals instead of one.
        #[arg(long)]
        reusable: bool,
        /// Host keys only: remove hosts that join with this key once they go offline.
        #[arg(long)]
        ephemeral: bool,
        /// Host keys only: a label granted to every host that joins. Repeat for more labels.
        #[arg(long = "label")]
        labels: Vec<String>,
        /// Shorter lifetime. Defaults to the maximum: one hour, or 90 days with --reusable.
        #[arg(long)]
        expires_in_seconds: Option<u64>,
        /// Host and client keys: a Tag the enrollee may run (host) or talk to (client). Repeat
        /// for more Tags.
        #[arg(long, conflicts_with = "all_tags")]
        tag: Vec<String>,
        /// Host and client keys: every Tag.
        #[arg(long)]
        all_tags: bool,
    },
    /// Stop an Auth Key from enrolling anyone else. Principals that joined stay enrolled.
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
            role,
            reusable,
            ephemeral,
            labels,
            expires_in_seconds,
            tag,
            all_tags,
        } => {
            anyhow::ensure!(
                role != KeyRole::Gateway || (tag.is_empty() && !all_tags),
                "a gateway Auth Key takes no --tag or --all-tags"
            );
            anyhow::ensure!(
                role == KeyRole::Gateway || !tag.is_empty() || all_tags,
                "choose --tag TAG (repeatable) or --all-tags"
            );
            anyhow::ensure!(
                role == KeyRole::Host || (!ephemeral && labels.is_empty()),
                "only a host Auth Key takes --ephemeral or --label"
            );
            let secret = new_secret(AUTH_KEY_SECRET_PREFIX);
            let key = OperatorClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .create_auth_key(request(
                    CreateAuthKeyRequest {
                        name,
                        role: role.proto().into(),
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
        "role": role_name(key.role),
        "phase": phase,
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
