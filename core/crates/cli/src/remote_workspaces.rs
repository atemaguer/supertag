//! `supertag workspace`: remote Workspaces on any git server, the Workspace Credentials git
//! delivery uses for them, and `workspace check`; `workspace add`, for a repository on this
//! machine, is `local_workspaces`. Secrets go to this machine's credential vault,
//! never to the Control Plane database, a flag, or the terminal.
use std::{
    io::{BufRead as _, IsTerminal as _, Read as _},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail, ensure};
use clap::{Args, Subcommand, ValueEnum};
use serde_json::{Value, json};
use supertag_credential_vault::CredentialVault;
use supertag_git_delivery::Credential;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    git_remote::{credential_vault_id, remote_transport},
    negotiation::ProtocolChannel,
    v2::*,
};
use uuid::Uuid;

use crate::{Connection, connect_operator, request};

/// The environment variable an HTTPS token is read from before prompting.
pub const TOKEN_ENVIRONMENT: &str = "SUPERTAG_WORKSPACE_TOKEN";

#[derive(Clone, Copy, ValueEnum)]
pub enum Land {
    /// Finished Sessions merge into --target, which is pushed.
    Merge,
    /// Each delivered Task updates its Session's branch and a draft pull request against
    /// --base. Needs a GitHub remote.
    Review,
}

#[derive(Clone, Copy, ValueEnum)]
pub enum Forge {
    /// GitHub or GitHub Enterprise Server.
    Github,
}

#[derive(Subcommand)]
pub enum WorkspaceCommand {
    /// Add a git repository on this machine as a Workspace of its local Worker Host, in
    /// supertag.yaml, and apply it to the running services as supertag up does.
    Add(crate::local_workspaces::AddArgs),
    /// Create or replace a remote Workspace: a git remote, the branch Sessions start from, the
    /// Workspace Credentials that read and push it, and where Session changes land.
    Put {
        workspace_id: String,
        /// The git remote: https://..., ssh://..., user@host:path, or file:///path/to/bare.git.
        #[arg(long)]
        remote: String,
        /// The branch each new Session starts from. Default: the remote's default branch.
        #[arg(long = "ref")]
        reference: Option<String>,
        /// The Workspace Credential that both reads and pushes.
        #[arg(long, conflicts_with_all = ["read_credential", "push_credential"])]
        credential: Option<String>,
        /// The Workspace Credential that reads the remote.
        #[arg(long)]
        read_credential: Option<String>,
        /// The Workspace Credential that pushes to the remote.
        #[arg(long)]
        push_credential: Option<String>,
        /// Where Session changes land beyond the Session's branch supertag/session/ID, which
        /// every delivered Task updates on the remote.
        #[arg(long, value_enum)]
        land: Option<Land>,
        /// The branch finished Sessions merge into, with --land merge.
        #[arg(long, required_if_eq("land", "merge"))]
        target: Option<String>,
        /// The branch pull requests target, with --land review.
        #[arg(long, required_if_eq("land", "review"))]
        base: Option<String>,
        /// The forge that reviews changes, for a self-hosted forge. A github.com remote is GitHub.
        #[arg(long, value_enum)]
        forge: Option<Forge>,
        /// The revision you last read. If given, the change is refused when the resource has changed since.
        #[arg(long)]
        expected_revision: Option<u64>,
        /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
        #[arg(long)]
        operation_id: Option<String>,
    },
    /// Read the remote and check pushing with the Workspace's credentials, without changing it.
    Check { workspace_id: String },
    /// Store, list, and remove the Workspace Credentials git delivery uses.
    #[command(subcommand)]
    Credential(CredentialCommand),
}

#[derive(Subcommand)]
pub enum CredentialCommand {
    /// Store a Workspace Credential in this machine's credential vault and name it on the
    /// Control Plane. Run it on the machine that runs the Control Plane, or with its vault.
    Add {
        name: String,
        /// An SSH private key file, such as a deploy key without a passphrase.
        #[arg(long, value_name = "PATH", group = "kind")]
        ssh_key: Option<PathBuf>,
        /// A known_hosts file with the server's host keys. Without it, the first key seen is
        /// trusted and remembered.
        #[arg(long, value_name = "PATH", requires = "ssh_key")]
        known_hosts: Option<PathBuf>,
        /// An HTTPS token or password, read from SUPERTAG_WORKSPACE_TOKEN or a hidden prompt.
        #[arg(long, group = "kind")]
        https_token: bool,
        /// The HTTPS user name sent with the token.
        #[arg(long, default_value = "supertag", requires = "https_token")]
        username: String,
        /// A git credential helper, as git's credential.helper setting names it, such as
        /// `!/usr/local/bin/mint-token`.
        #[arg(long, value_name = "HELPER", group = "kind")]
        credential_helper: Option<String>,
        /// A GitHub App installation: git delivery mints a token for one repository, narrowed
        /// to each operation, from the App's private key.
        #[arg(long, group = "kind", requires_all = ["app_id", "installation_id", "private_key"])]
        github_app: bool,
        /// The GitHub App's ID, with --github-app.
        #[arg(long, value_name = "ID", requires = "github_app")]
        app_id: Option<u64>,
        /// The ID of the App's installation on the repositories' owner, with --github-app.
        #[arg(long, value_name = "ID", requires = "github_app")]
        installation_id: Option<u64>,
        /// The GitHub App's private key file (.pem), with --github-app. Stored in this
        /// machine's credential vault, apart from any copy the GitHub surface keeps.
        #[arg(long, value_name = "PATH", requires = "github_app")]
        private_key: Option<PathBuf>,
    },
    /// List Workspace Credentials, without their secrets.
    List,
    /// Remove a Workspace Credential no Workspace names, here and on the Control Plane.
    Remove { name: String },
}

// Options for `supertag get workspaces`.
#[derive(Args)]
pub struct ListArgs {
    /// Most entries to return on one page.
    #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=100), conflicts_with = "id")]
    limit: u32,
    /// Continue after the last ID the previous page returned.
    #[arg(long, default_value = "", conflicts_with = "id")]
    after_id: String,
}

// Options for `supertag delete workspace`, which deletes a remote Workspace at its exact revision.
#[derive(Args)]
pub struct DeleteArgs {
    /// The revision you last read. The change is refused when the resource has changed since.
    #[arg(long)]
    expected_revision: u64,
    /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
    #[arg(long)]
    operation_id: Option<String>,
    /// Check the deletion and show what it would remove, without deleting anything.
    #[arg(long)]
    pub(crate) dry_run: bool,
}

fn client(channel: ProtocolChannel) -> workspaces_client::WorkspacesClient<ProtocolChannel> {
    workspaces_client::WorkspacesClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

fn credentials_client(
    channel: ProtocolChannel,
) -> workspace_credentials_client::WorkspaceCredentialsClient<ProtocolChannel> {
    workspace_credentials_client::WorkspaceCredentialsClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

pub(crate) async fn fetch(
    channel: ProtocolChannel,
    token: &str,
    workspace_id: String,
) -> Result<Value> {
    Ok(describe(
        client(channel)
            .get(request(GetWorkspaceRequest { workspace_id }, token)?)
            .await?
            .into_inner(),
    ))
}

pub(crate) async fn list(connection: Connection, args: ListArgs) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let page = client(channel)
        .list(request(
            ListWorkspacesRequest {
                limit: args.limit,
                after_id: args.after_id,
            },
            &token,
        )?)
        .await?
        .into_inner();
    Ok(
        json!({"workspaces":page.workspaces.into_iter().map(describe).collect::<Vec<_>>(), "next_cursor":page.next_cursor}),
    )
}

pub(crate) async fn delete(
    connection: Connection,
    workspace_id: String,
    args: DeleteArgs,
) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let operation_id = args
        .operation_id
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    client(channel)
        .delete(request(
            DeleteWorkspaceRequest {
                workspace_id: workspace_id.clone(),
                expected_revision: args.expected_revision,
                operation_id: operation_id.clone(),
                dry_run: args.dry_run,
            },
            &token,
        )?)
        .await?;
    Ok(json!({"workspace_id":workspace_id,"deleted":true,"operation_id":operation_id}))
}

pub async fn run(connection: Connection, command: WorkspaceCommand) -> Result<()> {
    let output = match command {
        WorkspaceCommand::Add(args) => {
            // It changes this machine's supertag.yaml, not a Control Plane resource.
            ensure!(
                connection.gateway.is_none() && crate::ROOT_GATEWAY.get().is_none(),
                "supertag workspace add changes this machine's supertag.yaml, so it takes --state-directory, not --gateway"
            );
            return crate::local_workspaces::add(connection.state_directory, args).await;
        }
        WorkspaceCommand::Put {
            workspace_id,
            remote,
            reference,
            credential,
            read_credential,
            push_credential,
            land,
            target,
            base,
            forge,
            expected_revision,
            operation_id,
        } => {
            remote_transport(&remote).map_err(anyhow::Error::msg)?;
            ensure!(
                target.is_none() || matches!(land, Some(Land::Merge)),
                "--target names the branch of --land merge"
            );
            ensure!(
                base.is_none() || matches!(land, Some(Land::Review)),
                "--base names the pull request base of --land review"
            );
            let land = land.map(|land| WorkspaceLand {
                mode: Some(match land {
                    Land::Merge => workspace_land::Mode::Merge(WorkspaceLandMerge {
                        target: target.unwrap_or_default(),
                    }),
                    Land::Review => workspace_land::Mode::Review(WorkspaceLandReview {
                        base: base.unwrap_or_default(),
                    }),
                }),
            });
            let forge = match forge {
                Some(Forge::Github) => WorkspaceForge::Github,
                None => WorkspaceForge::Unspecified,
            };
            let credentials = WorkspaceCredentialNames {
                read: credential.clone().or(read_credential).unwrap_or_default(),
                push: credential.or(push_credential).unwrap_or_default(),
            };
            let (channel, token) = connect_operator(connection).await?;
            let operation_id = operation_id.unwrap_or_else(|| Uuid::new_v4().to_string());
            let value = client(channel)
                .put(request(
                    PutWorkspaceRequest {
                        operation_id: operation_id.clone(),
                        expected_revision,
                        workspace: Some(Workspace {
                            workspace_id,
                            remote,
                            r#ref: reference.unwrap_or_default(),
                            credentials: Some(credentials),
                            land,
                            forge: forge as i32,
                            ..Default::default()
                        }),
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            let mut output = describe(value);
            output["operation_id"] = operation_id.into();
            output
        }
        WorkspaceCommand::Check { workspace_id } => {
            let (channel, token) = connect_operator(connection).await?;
            let mut call = request(CheckWorkspaceRequest { workspace_id }, &token)?;
            call.set_timeout(std::time::Duration::from_secs(90));
            let check = client(channel).check(call).await?.into_inner();
            json!({
                "workspace_id": check.workspace_id,
                "steps": check.steps.iter().map(|step| json!({
                    "step": step.step,
                    "status": step.status().as_str_name().trim_start_matches("WORKSPACE_CHECK_STATUS_").to_ascii_lowercase(),
                    "detail": step.detail,
                })).collect::<Vec<_>>(),
            })
        }
        WorkspaceCommand::Credential(command) => credential(connection, command).await?,
    };
    crate::terminal::print_json(&output)?;
    Ok(())
}

async fn credential(connection: Connection, command: CredentialCommand) -> Result<Value> {
    match command {
        CredentialCommand::Add {
            name,
            ssh_key,
            known_hosts,
            https_token,
            username,
            credential_helper,
            github_app,
            app_id,
            installation_id,
            private_key,
        } => {
            ensure!(
                supertag_protocol::valid_resource_id(&name),
                supertag_protocol::resource_id_error("a Workspace Credential name")
            );
            let (secret, kind, identifier) = if let Some(path) = ssh_key {
                let private_key = read_secret_file(&path, "SSH key")?;
                let known_hosts = known_hosts
                    .map(|path| read_secret_file(&path, "known_hosts"))
                    .transpose()?;
                let fingerprint = ssh_fingerprint(&path)?;
                (
                    Credential::SshKey {
                        private_key,
                        known_hosts,
                    },
                    WorkspaceCredentialKind::SshKey,
                    fingerprint,
                )
            } else if https_token {
                (
                    Credential::HttpsToken {
                        username: username.clone(),
                        token: read_token()?,
                    },
                    WorkspaceCredentialKind::HttpsToken,
                    username,
                )
            } else if let Some(helper) = credential_helper {
                let command = helper
                    .trim_start_matches('!')
                    .split_whitespace()
                    .next()
                    .map(|program| {
                        Path::new(program)
                            .file_name()
                            .map_or(program.to_owned(), |name| {
                                name.to_string_lossy().into_owned()
                            })
                    })
                    .unwrap_or_default();
                (
                    Credential::Helper { helper },
                    WorkspaceCredentialKind::CredentialHelper,
                    command,
                )
            } else if github_app {
                let (Some(app_id), Some(installation_id), Some(path)) =
                    (app_id, installation_id, private_key)
                else {
                    bail!("--github-app needs --app-id, --installation-id, and --private-key");
                };
                let private_key_pem = read_secret_file(&path, "GitHub App private key")?;
                (
                    Credential::GithubApp {
                        app_id,
                        installation_id,
                        private_key_pem,
                    },
                    WorkspaceCredentialKind::GithubApp,
                    Credential::github_app_identifier(app_id, installation_id),
                )
            } else {
                bail!(
                    "choose one of --ssh-key, --https-token, --credential-helper, or --github-app"
                );
            };
            secret.validate()?;
            // The secret is stored before the Control Plane names it, so no Workspace can name a
            // credential git delivery cannot read.
            let vault = CredentialVault::from_process_environment()?;
            vault
                .store(&credential_vault_id(&name), &secret.to_vault_value())
                .await
                .context("store the Workspace Credential in this machine's credential vault")?;
            let (channel, token) = connect_operator(connection).await?;
            let value = credentials_client(channel)
                .put(request(
                    PutWorkspaceCredentialRequest {
                        operation_id: Uuid::new_v4().to_string(),
                        credential: Some(WorkspaceCredential {
                            name,
                            kind: kind as i32,
                            identifier,
                            revision: 0,
                        }),
                        expected_revision: None,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            Ok(describe_credential(value))
        }
        CredentialCommand::List => {
            let (channel, token) = connect_operator(connection).await?;
            let mut client = credentials_client(channel);
            let mut credentials = Vec::new();
            let mut after = String::new();
            loop {
                let page = client
                    .list(request(
                        ListWorkspaceCredentialsRequest {
                            after_name: after,
                            limit: 100,
                        },
                        &token,
                    )?)
                    .await?
                    .into_inner();
                credentials.extend(page.credentials.into_iter().map(describe_credential));
                if page.next_cursor.is_empty() {
                    break;
                }
                after = page.next_cursor;
            }
            Ok(json!({ "credentials": credentials }))
        }
        CredentialCommand::Remove { name } => {
            let (channel, token) = connect_operator(connection).await?;
            let mut client = credentials_client(channel);
            let current = client
                .get(request(
                    GetWorkspaceCredentialRequest { name: name.clone() },
                    &token,
                )?)
                .await?
                .into_inner();
            client
                .delete(request(
                    DeleteWorkspaceCredentialRequest {
                        operation_id: Uuid::new_v4().to_string(),
                        name: name.clone(),
                        expected_revision: current.revision,
                    },
                    &token,
                )?)
                .await?;
            CredentialVault::from_process_environment()?
                .delete(&credential_vault_id(&name))
                .await?;
            Ok(json!({ "name": name, "removed": true }))
        }
    }
}

/// An owner-only regular file of at most 64 KiB, never echoed.
fn read_secret_file(path: &Path, what: &str) -> Result<String> {
    use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _};
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
        .with_context(|| format!("open the {what} file {}", path.display()))?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.len() <= 65_536,
        "the {what} file must be a regular file of at most 64 KiB"
    );
    if what != "known_hosts" {
        ensure!(
            metadata.mode() & 0o077 == 0,
            "the {what} file must be readable only by you (chmod 600 {})",
            path.display()
        );
    }
    let mut value = String::new();
    file.take(65_537)
        .read_to_string(&mut value)
        .with_context(|| format!("read the {what} file"))?;
    Ok(value)
}

/// The key's SHA256 fingerprint, as `ssh-keygen -l` prints it: a non-secret identifier.
fn ssh_fingerprint(path: &Path) -> Result<String> {
    let output = std::process::Command::new("/usr/bin/ssh-keygen")
        .arg("-l")
        .arg("-f")
        .arg(path)
        .stdin(std::process::Stdio::null())
        .output()
        .context("run ssh-keygen to read the key's fingerprint")?;
    ensure!(
        output.status.success(),
        "ssh-keygen cannot read the SSH key; use an unencrypted private key file"
    );
    let printed = String::from_utf8_lossy(&output.stdout);
    printed
        .split_whitespace()
        .find(|field| field.starts_with("SHA256:"))
        .map(str::to_owned)
        .context("ssh-keygen printed no SHA256 fingerprint")
}

/// The HTTPS token from the environment, or a hidden prompt.
fn read_token() -> Result<String> {
    if let Ok(value) = std::env::var(TOKEN_ENVIRONMENT) {
        let value = value.trim().to_owned();
        if !value.is_empty() {
            return Ok(value);
        }
    }
    let terminal = std::io::stdin().is_terminal();
    crate::terminal::write_stderr("HTTPS token: ");
    let echo = if terminal {
        crate::surface_setup::hide_input()
    } else {
        None
    };
    let mut line = String::new();
    let read = std::io::stdin().lock().take(16 * 1024).read_line(&mut line);
    if let Some(saved) = echo {
        crate::surface_setup::restore_input(saved);
        crate::terminal::write_stderr("\n");
    }
    read.context("read the HTTPS token")?;
    let token = line.trim().to_owned();
    ensure!(
        !token.is_empty(),
        "an HTTPS token is required: set {TOKEN_ENVIRONMENT} or enter it when prompted"
    );
    Ok(token)
}

pub(crate) fn describe(value: Workspace) -> Value {
    let forge = value.forge();
    let land = match value.land.and_then(|land| land.mode) {
        Some(workspace_land::Mode::Merge(merge)) => json!({"merge": merge.target}),
        Some(workspace_land::Mode::Review(review)) => json!({"review": {"base": review.base}}),
        None => Value::Null,
    };
    let forge = match forge {
        WorkspaceForge::Github => json!("github"),
        WorkspaceForge::Unspecified => Value::Null,
    };
    let credentials = value.credentials.unwrap_or_default();
    json!({
        "forge": forge,
        "workspace_id": value.workspace_id,
        "revision": value.revision,
        "remote": value.remote,
        "ref": value.r#ref,
        "credentials": {"read": credentials.read, "push": credentials.push},
        "land": land,
    })
}

fn describe_credential(value: WorkspaceCredential) -> Value {
    json!({
        "name": value.name,
        "kind": value.kind().as_str_name().trim_start_matches("WORKSPACE_CREDENTIAL_KIND_").to_ascii_lowercase().replace('_', "-"),
        "identifier": value.identifier,
        "revision": value.revision,
    })
}
