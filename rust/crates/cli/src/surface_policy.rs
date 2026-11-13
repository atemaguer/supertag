use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use clap::{Args, Subcommand, ValueEnum};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        surface_account_identity::Provider as Identity, surface_location_scope::Provider as Scope,
        surface_policy_catalog_client::SurfacePolicyCatalogClient, *,
    },
};
use tonic::transport::Channel;
use uuid::Uuid;

use crate::request;

#[derive(Args)]
#[command(
    after_help = "A location applies to its exact configured Gateway connector account alias. Other aliases use their own policy. Configure a separate alias for each location. The Gateway owns provider credentials."
)]
pub struct SurfacePolicyArgs {
    #[command(subcommand)]
    command: SurfacePolicyCommand,
}

#[derive(Clone, Copy, ValueEnum)]
enum Resource {
    Account,
    Location,
}

#[derive(Subcommand)]
enum SurfacePolicyCommand {
    /// Create or update an account or location from a JSON specification.
    Put {
        resource: Resource,
        file: PathBuf,
        /// The revision you last read. If given, the change is refused when the resource has changed since.
        #[arg(long)]
        expected_revision: Option<u64>,
        /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
        #[arg(long)]
        operation_id: Option<String>,
    },
    /// Read an account or location by ID.
    Show { resource: Resource, id: String },
    /// List accounts or locations.
    List {
        resource: Resource,
        /// Restrict locations to one account.
        #[arg(long)]
        account: Option<String>,
        /// Most entries to return on one page.
        #[arg(long, default_value_t = 20)]
        limit: u32,
        /// Continue from the cursor the previous page returned.
        #[arg(long, default_value = "")]
        cursor: String,
    },
    /// Remove a location's policy and stop new work on its connector alias.
    DeleteLocation {
        id: String,
        /// The revision you last read. The change is refused when the resource has changed since.
        #[arg(long)]
        expected_revision: u64,
        /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
        #[arg(long)]
        operation_id: Option<String>,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AccountSpec {
    #[serde(default)]
    pub(crate) account_id: String,
    identity: IdentitySpec,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(tag = "provider", rename_all = "snake_case", deny_unknown_fields)]
enum IdentitySpec {
    Slack {
        team_id: String,
    },
    Github {
        external_account_id: String,
    },
    Linear {
        workspace_id: String,
    },
    Lark {
        #[serde(default)]
        feishu: bool,
        app_id: String,
        tenant_key: String,
    },
    MicrosoftTeams {
        app_id: String,
        tenant_id: String,
    },
}

impl From<AccountSpec> for SurfaceAccount {
    fn from(value: AccountSpec) -> Self {
        let provider = match value.identity {
            IdentitySpec::Slack { team_id } => Identity::Slack(SlackSurfaceIdentity { team_id }),
            IdentitySpec::Github {
                external_account_id,
            } => Identity::Github(GithubSurfaceIdentity {
                external_account_id,
            }),
            IdentitySpec::Linear { workspace_id } => {
                Identity::Linear(LinearSurfaceIdentity { workspace_id })
            }
            IdentitySpec::Lark {
                feishu,
                app_id,
                tenant_key,
            } => Identity::Lark(LarkSurfaceIdentity {
                feishu,
                app_id,
                tenant_key,
            }),
            IdentitySpec::MicrosoftTeams { app_id, tenant_id } => {
                Identity::MicrosoftTeams(MicrosoftTeamsSurfaceIdentity { app_id, tenant_id })
            }
        };
        Self {
            account_id: value.account_id,
            identity: Some(SurfaceAccountIdentity {
                provider: Some(provider),
            }),
            enabled: value.enabled,
            revision: 0,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LocationSpec {
    #[serde(default)]
    pub(crate) location_id: String,
    account_id: String,
    connector_account_id: String,
    tag_id: String,
    scope: ScopeSpec,
    enabled: bool,
    #[serde(default)]
    permission_set_ids: Vec<String>,
    #[serde(default)]
    context_set_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(tag = "provider", rename_all = "snake_case", deny_unknown_fields)]
enum ScopeSpec {
    Slack { channel_id: String },
    Github { repository_id: u64 },
    Linear { team_id: String },
    Lark { chat_id: String },
    MicrosoftTeams { team_id: String, channel_id: String },
}

impl From<LocationSpec> for SurfaceLocation {
    fn from(value: LocationSpec) -> Self {
        let provider = match value.scope {
            ScopeSpec::Slack { channel_id } => Scope::Slack(SlackSurfaceChannel { channel_id }),
            ScopeSpec::Github { repository_id } => {
                Scope::Github(GithubSurfaceRepository { repository_id })
            }
            ScopeSpec::Linear { team_id } => Scope::Linear(LinearSurfaceTeam { team_id }),
            ScopeSpec::Lark { chat_id } => Scope::Lark(LarkSurfaceChat { chat_id }),
            ScopeSpec::MicrosoftTeams {
                team_id,
                channel_id,
            } => Scope::MicrosoftTeams(MicrosoftTeamsSurfaceChannel {
                team_id,
                channel_id,
            }),
        };
        Self {
            location_id: value.location_id,
            account_id: value.account_id,
            connector_account_id: value.connector_account_id,
            tag_id: value.tag_id,
            scope: Some(SurfaceLocationScope {
                provider: Some(provider),
            }),
            enabled: value.enabled,
            permission_set_ids: value.permission_set_ids,
            context_set_ids: value.context_set_ids,
            revision: 0,
        }
    }
}

fn account_json(account: SurfaceAccount) -> Value {
    let identity = match account.identity.and_then(|identity| identity.provider) {
        Some(Identity::Slack(value)) => json!({ "provider": "slack", "team_id": value.team_id }),
        Some(Identity::Github(value)) => {
            json!({ "provider": "github", "external_account_id": value.external_account_id })
        }
        Some(Identity::Linear(value)) => {
            json!({ "provider": "linear", "workspace_id": value.workspace_id })
        }
        Some(Identity::Lark(value)) => json!({
            "provider": "lark", "feishu": value.feishu, "app_id": value.app_id,
            "tenant_key": value.tenant_key,
        }),
        Some(Identity::MicrosoftTeams(value)) => json!({
            "provider": "microsoft_teams", "app_id": value.app_id, "tenant_id": value.tenant_id,
        }),
        None => Value::Null,
    };
    json!({
        "account_id": account.account_id,
        "identity": identity,
        "enabled": account.enabled,
        "revision": account.revision,
    })
}

fn location_json(location: SurfaceLocation) -> Value {
    let scope = match location.scope.and_then(|scope| scope.provider) {
        Some(Scope::Slack(value)) => json!({ "provider": "slack", "channel_id": value.channel_id }),
        Some(Scope::Github(value)) => {
            json!({ "provider": "github", "repository_id": value.repository_id })
        }
        Some(Scope::Linear(value)) => json!({ "provider": "linear", "team_id": value.team_id }),
        Some(Scope::Lark(value)) => json!({ "provider": "lark", "chat_id": value.chat_id }),
        Some(Scope::MicrosoftTeams(value)) => json!({
            "provider": "microsoft_teams", "team_id": value.team_id, "channel_id": value.channel_id,
        }),
        None => Value::Null,
    };
    json!({
        "location_id": location.location_id,
        "account_id": location.account_id,
        "connector_account_id": location.connector_account_id,
        "tag_id": location.tag_id,
        "scope": scope,
        "enabled": location.enabled,
        "permission_set_ids": location.permission_set_ids,
        "context_set_ids": location.context_set_ids,
        "revision": location.revision,
    })
}

fn read_spec<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let file = File::open(path).context("open Surface policy specification")?;
    let mut bytes = Vec::new();
    file.take(MAX_MESSAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .context("read Surface policy specification")?;
    if bytes.len() > MAX_MESSAGE_BYTES {
        bail!("Surface policy specification exceeds the request limit");
    }
    serde_json::from_slice(&bytes).context("parse Surface policy specification")
}

fn operation_id(id: Option<String>) -> String {
    id.unwrap_or_else(|| Uuid::new_v4().to_string())
}

pub async fn run(
    mut client: SurfacePolicyCatalogClient<Channel>,
    token: &str,
    args: SurfacePolicyArgs,
) -> Result<()> {
    let output = match args.command {
        SurfacePolicyCommand::Put {
            resource,
            file,
            expected_revision,
            operation_id: id,
        } => match resource {
            Resource::Account => account_json(
                client
                    .put_surface_account(request(
                        PutSurfaceAccountRequest {
                            operation_id: operation_id(id),
                            expected_revision,
                            account: Some(read_spec::<AccountSpec>(&file)?.into()),
                        },
                        token,
                    )?)
                    .await?
                    .into_inner(),
            ),
            Resource::Location => location_json(
                client
                    .put_surface_location(request(
                        PutSurfaceLocationRequest {
                            operation_id: operation_id(id),
                            expected_revision,
                            location: Some(read_spec::<LocationSpec>(&file)?.into()),
                        },
                        token,
                    )?)
                    .await?
                    .into_inner(),
            ),
        },
        SurfacePolicyCommand::Show { resource, id } => match resource {
            Resource::Account => account_json(
                client
                    .get_surface_account(request(
                        GetSurfaceAccountRequest { account_id: id },
                        token,
                    )?)
                    .await?
                    .into_inner(),
            ),
            Resource::Location => location_json(
                client
                    .get_surface_location(request(
                        GetSurfaceLocationRequest { location_id: id },
                        token,
                    )?)
                    .await?
                    .into_inner(),
            ),
        },
        SurfacePolicyCommand::List {
            resource,
            account,
            limit,
            cursor,
        } => match resource {
            Resource::Account => {
                if account.is_some() {
                    bail!("--account filters locations");
                }
                let page = client
                    .list_surface_accounts(request(
                        ListSurfaceAccountsRequest { limit, cursor },
                        token,
                    )?)
                    .await?
                    .into_inner();
                json!({
                    "accounts": page.accounts.into_iter().map(account_json).collect::<Vec<_>>(),
                    "next_cursor": page.next_cursor,
                })
            }
            Resource::Location => {
                let page = client
                    .list_surface_locations(request(
                        ListSurfaceLocationsRequest {
                            account_id: account.unwrap_or_default(),
                            limit,
                            cursor,
                        },
                        token,
                    )?)
                    .await?
                    .into_inner();
                json!({
                    "locations": page.locations.into_iter().map(location_json).collect::<Vec<_>>(),
                    "next_cursor": page.next_cursor,
                })
            }
        },
        SurfacePolicyCommand::DeleteLocation {
            id,
            expected_revision,
            operation_id: operation,
        } => {
            let deleted = client
                .delete_surface_location(request(
                    DeleteSurfaceLocationRequest {
                        operation_id: operation_id(operation),
                        location_id: id,
                        expected_revision,
                    },
                    token,
                )?)
                .await?
                .into_inner()
                .deleted;
            json!({ "deleted": deleted })
        }
    };
    crate::terminal::print_json(&output)?;
    Ok(())
}
