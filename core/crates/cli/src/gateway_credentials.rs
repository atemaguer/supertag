//! Operator access to the Gateway credential vault. Values are read from standard input and are
//! never printed, so they stay out of shell history, process listings, and logs.

use std::io::Read as _;

use anyhow::{Context, Result, ensure};
use clap::Subcommand;
use serde_json::json;
use supertag_credential_vault::{CredentialValue, CredentialVault};

#[derive(Subcommand)]
pub enum GatewayCredentialCommand {
    /// Store or replace a credential from a JSON object of strings on standard input,
    /// such as `{"botToken":"...","signingSecret":"..."}` for `surface/slack/<account>`.
    Store { credential_id: String },
    /// Delete a credential. Deleting a missing credential succeeds.
    Delete { credential_id: String },
}

pub async fn run(command: GatewayCredentialCommand) -> Result<()> {
    let vault = CredentialVault::from_process_environment()?;
    let (action, id) = match command {
        GatewayCredentialCommand::Store { credential_id } => {
            let mut input = String::new();
            std::io::stdin()
                .take(1024 * 1024 + 1)
                .read_to_string(&mut input)
                .context("read credential from standard input")?;
            ensure!(input.len() <= 1024 * 1024, "credential input is too large");
            // Parsing errors stay generic because the input contains credentials.
            let value: CredentialValue = serde_json::from_str(&input).map_err(|_| {
                anyhow::anyhow!("standard input must be a JSON object of string fields")
            })?;
            vault.store(&credential_id, &value).await?;
            ("stored", credential_id)
        }
        GatewayCredentialCommand::Delete { credential_id } => {
            vault.delete(&credential_id).await?;
            ("deleted", credential_id)
        }
    };
    crate::terminal::print_json(&json!({ "credential_id": id, "result": action }))?;
    Ok(())
}
