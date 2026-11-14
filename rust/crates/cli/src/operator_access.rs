//! `supertag operator-token ...` and `supertag audit`.

use anyhow::{Context, Result, bail, ensure};
use clap::{Args, Subcommand, ValueEnum};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use supertag_protocol::OPERATOR_TOKEN_SECRET_PREFIX;
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{operator_access_client::OperatorAccessClient, *},
};
use tonic::Code;
use uuid::Uuid;

use crate::{Connection, connect_operator, request};

#[derive(Subcommand)]
pub enum OperatorTokenCommand {
    /// Issue a named Operator Token and print its secret once.
    ///
    /// Calls made with it act as the operator token:NAME. It expires 90 days after it is created
    /// or rotated. Names are never reused. Only the admin operator token manages Operator Tokens.
    Create { name: String },
    /// Replace the secret, print the new one once, and refuse the old one from now on.
    Rotate { name: String },
    /// Refuse the token from now on, including in calls and streams already open.
    Revoke { name: String },
}

// Options for `supertag get operator-tokens`.
#[derive(Args)]
pub struct ListArgs {
    /// Most entries to return on one page.
    #[arg(long, default_value_t = 50, conflicts_with = "id")]
    limit: u32,
    /// Continue from the cursor the previous page returned.
    #[arg(long, default_value = "", conflicts_with = "id")]
    cursor: String,
}

#[derive(Clone, Copy, ValueEnum)]
pub enum AuditOutput {
    Text,
    Json,
}

/// Lists recorded operator changes, newest first: Operator Token and Auth Key changes, Tag and
/// policy changes, approvals, Objective actions, cancellations, and other administrative writes.
/// Each entry names the actor, action, target, time, and outcome, never a secret.
#[derive(Args)]
pub struct AuditArgs {
    #[command(flatten)]
    connection: Connection,
    /// Only changes at or after this time, such as 2026-10-01T09:00:00Z or 2026-10-01.
    #[arg(long)]
    since: Option<String>,
    /// Only changes by this operator, such as token:laptop-2.
    #[arg(long)]
    actor: Option<String>,
    /// At most N entries, 1 through 500.
    #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=500))]
    limit: u32,
    /// Continue from the cursor a previous JSON page returned.
    #[arg(long, default_value = "")]
    cursor: String,
    /// Print readable text, or JSON for scripts.
    #[arg(long, value_enum, default_value_t = AuditOutput::Text)]
    output: AuditOutput,
}

fn client(channel: ProtocolChannel) -> OperatorAccessClient<ProtocolChannel> {
    OperatorAccessClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

/// A new secret: the recognizable prefix and 64 lowercase hex characters.
fn secret() -> String {
    format!(
        "{OPERATOR_TOKEN_SECRET_PREFIX}{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

fn admin_only(error: tonic::Status) -> anyhow::Error {
    if error.code() == Code::PermissionDenied {
        anyhow::anyhow!("Only the admin operator token manages Operator Tokens")
    } else {
        error.into()
    }
}

pub async fn run_tokens(connection: Connection, command: OperatorTokenCommand) -> Result<()> {
    let (channel, token) = connect_operator(connection).await?;
    let mut access = client(channel);
    let output = match command {
        OperatorTokenCommand::Create { name } => {
            let secret = secret();
            let created = access
                .create_operator_token(request(
                    CreateOperatorTokenRequest {
                        name,
                        operation_id: Uuid::new_v4().to_string(),
                        secret_digest: Sha256::digest(secret.as_bytes()).to_vec(),
                    },
                    &token,
                )?)
                .await
                .map_err(admin_only)?
                .into_inner();
            with_secret(&created, secret)
        }
        OperatorTokenCommand::Rotate { name } => {
            let secret = secret();
            let rotated = access
                .rotate_operator_token(request(
                    RotateOperatorTokenRequest {
                        name,
                        operation_id: Uuid::new_v4().to_string(),
                        secret_digest: Sha256::digest(secret.as_bytes()).to_vec(),
                    },
                    &token,
                )?)
                .await
                .map_err(admin_only)?
                .into_inner();
            with_secret(&rotated, secret)
        }
        OperatorTokenCommand::Revoke { name } => token_json(
            &access
                .revoke_operator_token(request(RevokeOperatorTokenRequest { name }, &token)?)
                .await
                .map_err(admin_only)?
                .into_inner(),
        ),
    };
    crate::terminal::print_json(&output)?;
    Ok(())
}

pub(crate) async fn fetch(channel: ProtocolChannel, token: &str, name: String) -> Result<Value> {
    Ok(token_json(
        &client(channel)
            .get_operator_token(request(GetOperatorTokenRequest { name }, token)?)
            .await
            .map_err(admin_only)?
            .into_inner(),
    ))
}

pub(crate) async fn list(connection: Connection, args: ListArgs) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let page = client(channel)
        .list_operator_tokens(request(
            ListOperatorTokensRequest {
                limit: args.limit,
                cursor: args.cursor,
            },
            &token,
        )?)
        .await
        .map_err(admin_only)?
        .into_inner();
    Ok(json!({
        "operator_tokens": page.tokens.iter().map(token_json).collect::<Vec<_>>(),
        "next_cursor": page.next_cursor,
    }))
}

fn with_secret(token: &OperatorToken, secret: String) -> Value {
    let mut value = token_json(token);
    // Shown only now. The Control Plane stores its digest, never the secret.
    value["secret"] = Value::String(secret);
    value
}

fn token_json(token: &OperatorToken) -> Value {
    json!({
        "name": token.name,
        "operator_id": token.operator_id,
        "phase": token.phase().as_str_name().trim_start_matches("OPERATOR_TOKEN_PHASE_").to_ascii_lowercase(),
        "created_by": token.created_by,
        "created_at_ms": token.created_at_ms,
        "expires_at_ms": token.expires_at_ms,
        "last_used_at_ms": token.last_used_at_ms,
        "rotated_at_ms": token.rotated_at_ms,
        "revoked_at_ms": token.revoked_at_ms,
        "secret_revision": token.secret_revision,
    })
}

/// Parses `--since` as an RFC 3339 time or a UTC date.
fn since_ms(value: &str) -> Result<i64> {
    let value = value.trim();
    if let Ok(time) = chrono::DateTime::parse_from_rfc3339(value) {
        return Ok(time.timestamp_millis());
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return Ok(date
            .and_hms_opt(0, 0, 0)
            .context("invalid --since date")?
            .and_utc()
            .timestamp_millis());
    }
    bail!("--since must be an ISO 8601 time, such as 2026-10-01T09:00:00Z")
}

fn time(at_ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(at_ms)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| at_ms.to_string())
}

fn outcome(entry: &AuditEntry) -> String {
    match entry.outcome() {
        AuditOutcome::Succeeded => "succeeded".into(),
        _ => format!("failed ({})", entry.code),
    }
}

fn entry_json(entry: &AuditEntry) -> Value {
    json!({
        "id": entry.id,
        "at": time(entry.at_ms),
        "at_ms": entry.at_ms,
        "actor": entry.actor,
        "action": entry.action,
        "target": entry.target,
        "outcome": if entry.outcome() == AuditOutcome::Succeeded { "succeeded" } else { "failed" },
        "code": entry.code,
        "method": entry.method,
    })
}

pub async fn run_audit(args: AuditArgs) -> Result<()> {
    let since_ms = args
        .since
        .as_deref()
        .map(since_ms)
        .transpose()?
        .unwrap_or(0);
    ensure!(since_ms >= 0, "--since must not be before 1970");
    let actor = args.actor.unwrap_or_default().trim().to_owned();
    ensure!(actor.len() <= 200, "--actor must be at most 200 characters");
    let (channel, token) = connect_operator(args.connection).await?;
    let page = client(channel)
        .list_audit_entries(request(
            ListAuditEntriesRequest {
                since_ms,
                actor,
                limit: args.limit,
                cursor: args.cursor,
            },
            &token,
        )?)
        .await?
        .into_inner();
    match args.output {
        AuditOutput::Json => outln!(
            "{}",
            json!({
                "entries": page.entries.iter().map(entry_json).collect::<Vec<_>>(),
                "next_cursor": page.next_cursor,
            })
        ),
        AuditOutput::Text => out!("{}", format_entries(&page.entries)),
    }
    Ok(())
}

fn format_entries(entries: &[AuditEntry]) -> String {
    if entries.is_empty() {
        return "No audit entries match.\n".into();
    }
    let safe = |text: &str| {
        text.chars()
            .map(|character| {
                if character.is_control() {
                    ' '
                } else {
                    character
                }
            })
            .collect::<String>()
    };
    let rows: Vec<[String; 5]> =
        std::iter::once(["TIME", "ACTOR", "ACTION", "TARGET", "OUTCOME"].map(str::to_owned))
            .chain(entries.iter().map(|entry| {
                [
                    time(entry.at_ms),
                    safe(&entry.actor),
                    safe(&entry.action),
                    safe(&entry.target),
                    outcome(entry),
                ]
            }))
            .collect();
    let widths: Vec<usize> = (0..5)
        .map(|column| {
            rows.iter()
                .map(|row| row[column].chars().count())
                .max()
                .unwrap_or(0)
        })
        .collect();
    let mut output = String::new();
    for row in rows {
        let line = row
            .iter()
            .enumerate()
            .map(|(column, cell)| {
                if column == 4 {
                    cell.clone()
                } else {
                    format!("{cell:<width$}", width = widths[column])
                }
            })
            .collect::<Vec<_>>()
            .join("  ");
        output.push_str(&line);
        output.push('\n');
    }
    output
}
