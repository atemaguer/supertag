//! `supertag user invite`, and the reads behind `supertag get user` and `describe user`.
//!
//! A User is a person, never a machine. One invite key joins all of a User's devices with
//! `supertag connect`, and, with `supertag host enroll`, Worker Hosts that belong to them.

use anyhow::{Context, Result};
use clap::{Args, Subcommand};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    AUTH_KEY_SECRET_PREFIX, MAX_MESSAGE_BYTES, new_secret,
    v2::{users_client::UsersClient, *},
};
use uuid::Uuid;

use crate::{Connection, connect_operator, request};

#[derive(Subcommand)]
pub enum UserCommand {
    /// Admit a person as a User and print an invite key that joins all their devices and Worker
    /// Hosts. Invite an existing User again, with only their name, for another key.
    Invite {
        /// The User's name, such as alice: 1-50 lowercase letters, digits, and hyphens.
        name: String,
        /// The person's name as people read it, such as "Alice Ng". Required for a new User.
        #[arg(long)]
        display_name: Option<String>,
        /// The Role the User's personal Tag takes. Default: the Control Plane's `personal` Role.
        #[arg(long)]
        role: Option<String>,
        /// A shared Tag the User's devices may talk to. Repeat for more Tags.
        #[arg(long)]
        tag: Vec<String>,
        /// Shorter or longer key lifetime. Default: 7 days; at most 90 days.
        #[arg(long)]
        expires_in_seconds: Option<u64>,
    },
}

// Options for `supertag get users`.
#[derive(Args)]
pub struct ListArgs {
    /// Most entries to return on one page.
    #[arg(long, default_value_t = 100, conflicts_with = "id")]
    limit: u32,
    /// The next_cursor of the previous page.
    #[arg(long, default_value = "", conflicts_with = "id")]
    cursor: String,
}

fn client(channel: ProtocolChannel) -> UsersClient<ProtocolChannel> {
    UsersClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

pub async fn run(connection: Connection, command: UserCommand) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let output = match command {
        UserCommand::Invite {
            name,
            display_name,
            role,
            tag,
            expires_in_seconds,
        } => {
            let secret = new_secret(AUTH_KEY_SECRET_PREFIX);
            let invited = client(channel)
                .invite_user(request(
                    InviteUserRequest {
                        operation_id: Uuid::new_v4().to_string(),
                        name,
                        display_name: display_name.unwrap_or_default(),
                        key_digest: Sha256::digest(secret.as_bytes()).to_vec(),
                        expires_in_ms: expires_in_seconds
                            .map_or(Some(0), |seconds| {
                                seconds.checked_mul(1000).filter(|ms| *ms > 0)
                            })
                            .context("invalid invite key lifetime")?,
                        role: role.unwrap_or_default(),
                        allowed_tag_ids: tag,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            let user = invited
                .user
                .as_ref()
                .context("the invitation named no User")?;
            let key = invited
                .auth_key
                .as_ref()
                .context("the invitation issued no key")?;
            json!({
                "user": view(user),
                "invite_key": secret,
                "invite_key_name": key.name,
                "expires_at_ms": key.expires_at_ms,
                "personal_tag": user.name,
                "next": [
                    "On each of the User's devices: supertag connect --name NAME GATEWAY_URL, then paste the invite key",
                    format!("Then choose the personal Tag's harness and Workspace: supertag tag put {} --harness HARNESS --workspace-id WORKSPACE --gateway NAME", user.name),
                    "On a machine that runs the User's Tag: supertag host enroll with the same key",
                ],
            })
        }
    };
    crate::terminal::print_json(&output)?;
    Ok(())
}

pub fn view(user: &User) -> Value {
    json!({
        "name": user.name,
        "display_name": user.display_name,
        "role": user.role,
        "allowed_tag_ids": user.allowed_tag_ids,
        "created_at_ms": user.created_at_ms,
    })
}

pub(crate) async fn fetch(channel: ProtocolChannel, token: &str, name: String) -> Result<Value> {
    Ok(view(
        &client(channel)
            .get_user(request(GetUserRequest { name }, token)?)
            .await?
            .into_inner(),
    ))
}

pub(crate) async fn list(connection: Connection, args: ListArgs) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let page = client(channel)
        .list_users(request(
            ListUsersRequest {
                limit: args.limit,
                cursor: args.cursor,
            },
            &token,
        )?)
        .await?
        .into_inner();
    Ok(json!({
        "users": page.users.iter().map(view).collect::<Vec<_>>(),
        "next_cursor": page.next_cursor,
    }))
}
