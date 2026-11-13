//! `supertag mcp`: the MCP servers this host's Worker Host catalog declares, and their logins.

use std::{path::PathBuf, time::Duration};

use anyhow::{Result, bail};
use clap::Subcommand;
use supertag_worker_host::{
    McpCatalog, McpLoginOptions, McpLoginState, McpLoginStore, mcp_login_command, run_mcp_login,
};

#[derive(Subcommand)]
pub enum McpCommand {
    /// Show each catalog server, its auth form, and whether its credentials are ready. Never
    /// prints a credential.
    List {
        /// The Worker Host's owner-only MCP catalog.
        #[arg(long)]
        mcp_catalog: PathBuf,
    },
    /// Log in to an "oauth": true server in the browser (OAuth with PKCE). SuperTag stores the
    /// tokens in this host's MCP login store and the Worker Host refreshes them.
    Login {
        /// Run the same browser login, store nothing, and print the refresh token once, for
        /// "oauth": {"refreshTokenEnv": VAR} on a remote Worker Host.
        #[arg(long)]
        export: bool,
        name: String,
        /// The Worker Host's owner-only MCP catalog.
        #[arg(long)]
        mcp_catalog: PathBuf,
        /// Print the authorization URL without opening the system browser.
        #[arg(long)]
        no_browser: bool,
        /// Seconds to wait for the browser to come back.
        #[arg(long, default_value_t = 300, value_parser = clap::value_parser!(u64).range(1..=3600))]
        timeout_seconds: u64,
    },
}

pub async fn run(command: McpCommand) -> Result<()> {
    let logins = McpLoginStore::default_location()?;
    match command {
        McpCommand::List { mcp_catalog } => {
            out!("{}", list(&mcp_catalog, &logins)?);
            Ok(())
        }
        McpCommand::Login {
            export,
            name,
            mcp_catalog,
            no_browser,
            timeout_seconds,
        } => {
            let entries = McpCatalog::entries(&mcp_catalog)?;
            let Some(entry) = entries.iter().find(|entry| entry.name == name) else {
                bail!(
                    "The MCP catalog declares no server {name}; add {{\"name\":\"{name}\",\"url\":\"https://...\",\"oauth\":true}}"
                );
            };
            if entry.target.starts_with("stdio: ") {
                bail!(
                    "MCP server {name} is a stdio server, so it has no login; the Worker Host starts it with its env"
                );
            }
            let url = match (&entry.login_url, export) {
                (Some(url), _) => url,
                (None, true) if entry.auth == "oauth refresh token" => &entry.target,
                (None, true) => bail!(
                    "MCP server {name} does not use OAuth; --export needs \"oauth\": true or \"oauth\": {{\"refreshTokenEnv\": VAR}}"
                ),
                (None, false) => bail!(
                    "MCP server {name} does not use \"oauth\": true, so it has no login to store; declare it with \"oauth\": true to log in"
                ),
            };
            let mut write = |text: &str| crate::terminal::write_stderr(text);
            let login = run_mcp_login(
                &name,
                url,
                McpLoginOptions {
                    open_browser: !no_browser,
                    write: &mut write,
                    timeout: Duration::from_secs(timeout_seconds),
                },
            )
            .await?;
            if export {
                let variable = format!(
                    "{}_MCP_REFRESH_TOKEN",
                    name.to_ascii_uppercase()
                        .replace(|c: char| !c.is_ascii_alphanumeric(), "_")
                );
                let mut exported = serde_json::json!({
                    "refresh_token": login.refresh_token,
                    "client_id": login.client_id,
                });
                if let Some(secret) = &login.client_secret {
                    exported["client_secret"] = secret.clone().into();
                }
                outln!("{exported}");
                outln!(
                    "Store this value as a secret on the remote Worker Host, such as {variable}, and give the server \"oauth\": {{\"refreshTokenEnv\": \"{variable}\"}} in its MCP catalog. It is not stored here and is not shown again."
                );
                return Ok(());
            }
            logins.store(&name, &login)?;
            outln!(
                "Logged in to MCP server {name}. The Worker Host refreshes the login on this host."
            );
            Ok(())
        }
    }
}

fn list(catalog: &std::path::Path, logins: &McpLoginStore) -> Result<String> {
    let entries = McpCatalog::entries(catalog)?;
    if entries.is_empty() {
        return Ok("The MCP catalog declares no servers.\n".into());
    }
    let now = supertag_worker_host_now();
    let mut rows = vec![[
        "SERVER".to_owned(),
        "TARGET".to_owned(),
        "AUTH".to_owned(),
        "STATE".to_owned(),
    ]];
    for entry in entries {
        let state = if let Some(url) = &entry.login_url {
            match logins.state(&entry.name, url, now) {
                McpLoginState::LoggedIn { .. } => "logged in".to_owned(),
                McpLoginState::Lapsed => {
                    format!("login lapsed; run {}", mcp_login_command(&entry.name))
                }
                McpLoginState::Missing => {
                    format!("not logged in; run {}", mcp_login_command(&entry.name))
                }
            }
        } else if entry.missing.is_empty() {
            "ready".to_owned()
        } else {
            format!("missing: {}", entry.missing.join(", "))
        };
        rows.push([entry.name, entry.target, entry.auth.to_owned(), state]);
    }
    let widths: Vec<usize> = (0..3)
        .map(|column| rows.iter().map(|row| row[column].len()).max().unwrap_or(0))
        .collect();
    let mut output = String::new();
    for row in rows {
        for (column, width) in widths.iter().enumerate() {
            output.push_str(&format!("{:width$}  ", row[column]));
        }
        output.push_str(&row[3]);
        output.push('\n');
    }
    Ok(output)
}

fn supertag_worker_host_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}
