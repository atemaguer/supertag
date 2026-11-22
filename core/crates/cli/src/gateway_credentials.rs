//! Operator access to the Gateway credential vault. Values are read from standard input and are
//! never printed, so they stay out of shell history, process listings, and logs.

use std::{io::Read as _, path::PathBuf};

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
    /// Write a deployment directory's credentials into its gateway.env and control-plane.env,
    /// for services that read credentials from their environment
    /// (SUPERTAG_CREDENTIAL_VAULT=env). Reads gateway-credentials.json in the directory, which
    /// operator commands write when SUPERTAG_CREDENTIAL_FILE names it. Each file gets only its
    /// own service's credentials. Run it after every credential change, then upload both files
    /// to the platform's secrets again and redeploy. Prints credential IDs, never values.
    Export {
        /// Directory written by `supertag setup deployment`.
        #[arg(long, default_value = "supertag-deployment")]
        directory: PathBuf,
    },
}

pub async fn run(command: GatewayCredentialCommand) -> Result<()> {
    let (action, id) = match command {
        GatewayCredentialCommand::Export { directory } => {
            let files: serde_json::Map<String, serde_json::Value> =
                crate::deployment::export_credentials(&directory)?
                    .into_iter()
                    .map(|(file, ids)| (file.to_owned(), json!(ids)))
                    .collect();
            crate::terminal::print_json(&json!({
                "directory": directory,
                "result": "exported",
                "credentials": files,
            }))?;
            return Ok(());
        }
        GatewayCredentialCommand::Store { credential_id } => {
            let vault = CredentialVault::from_process_environment()?;
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
            CredentialVault::from_process_environment()?
                .delete(&credential_id)
                .await?;
            ("deleted", credential_id)
        }
    };
    crate::terminal::print_json(&json!({ "credential_id": id, "result": action }))?;
    Ok(())
}
