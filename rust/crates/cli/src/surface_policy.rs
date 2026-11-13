use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use clap::{Args, Subcommand};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        surface_account_identity::Provider as Identity, surface_location_scope::Provider as Scope,
        surface_policy_catalog_client::SurfacePolicyCatalogClient, *,
    },
};
use uuid::Uuid;

use crate::{Connection, connect_operator, request};

/// Explains which connector alias a location's policy covers.
pub const LOCATION_AFTER_HELP: &str = "A location applies to its exact configured Gateway connector account alias. Other aliases use their own policy. Configure a separate alias for each location. The Gateway owns provider credentials.";

/// `supertag surface-account VERB`.
#[derive(Subcommand)]
pub enum AccountCommand {
    /// Create or update a verified connector account from a JSON specification.
    Put(PutArgs),
}

/// `supertag surface-location VERB`.
#[derive(Subcommand)]
pub enum LocationCommand {
    /// Create or update a location's Tag and policy from a JSON specification.
    Put(PutArgs),
}

#[derive(Args)]
pub struct PutArgs {
    file: PathBuf,
    /// The revision you last read. If given, the change is refused when the resource has changed since.
    #[arg(long)]
    expected_revision: Option<u64>,
    /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
    #[arg(long)]
    operation_id: Option<String>,
}

// Options for `supertag get surface-accounts`.
#[derive(Args)]
pub struct AccountListArgs {
    /// Most entries to return on one page.
    #[arg(long, default_value_t = 20, conflicts_with = "id")]
    limit: u32,
    /// Continue from the cursor the previous page returned.
    #[arg(long, default_value = "", conflicts_with = "id")]
    cursor: String,
}

// Options for `supertag get surface-locations`.
#[derive(Args)]
pub struct LocationListArgs {
    /// Only locations of this account.
    #[arg(long, default_value = "", conflicts_with = "id")]
    account: String,
    /// Most entries to return on one page.
    #[arg(long, default_value_t = 20, conflicts_with = "id")]
    limit: u32,
    /// Continue from the cursor the previous page returned.
    #[arg(long, default_value = "", conflicts_with = "id")]
    cursor: String,
}

// Options for `supertag delete surface-location`.
#[derive(Args)]
pub struct DeleteArgs {
    /// The revision you last read. The change is refused when the resource has changed since.
    #[arg(long)]
    expected_revision: u64,
    /// Idempotency key: a retry with the same key returns the first result instead of acting twice. Defaults to a new key.
    #[arg(long)]
    operation_id: Option<String>,
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

fn client(channel: ProtocolChannel) -> SurfacePolicyCatalogClient<ProtocolChannel> {
    SurfacePolicyCatalogClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

pub async fn run_account(connection: Connection, command: AccountCommand) -> Result<()> {
    let AccountCommand::Put(args) = command;
    let (channel, token) = connect_operator(connection).await?;
    let account = client(channel)
        .put_surface_account(request(
            PutSurfaceAccountRequest {
                operation_id: operation_id(args.operation_id),
                expected_revision: args.expected_revision,
                account: Some(read_spec::<AccountSpec>(&args.file)?.into()),
            },
            &token,
        )?)
        .await?
        .into_inner();
    crate::terminal::print_json(&account_json(account))?;
    Ok(())
}

pub async fn run_location(connection: Connection, command: LocationCommand) -> Result<()> {
    let LocationCommand::Put(args) = command;
    let (channel, token) = connect_operator(connection).await?;
    let location = client(channel)
        .put_surface_location(request(
            PutSurfaceLocationRequest {
                operation_id: operation_id(args.operation_id),
                expected_revision: args.expected_revision,
                location: Some(read_spec::<LocationSpec>(&args.file)?.into()),
            },
            &token,
        )?)
        .await?
        .into_inner();
    crate::terminal::print_json(&location_json(location))?;
    Ok(())
}

pub(crate) async fn fetch_account(
    channel: ProtocolChannel,
    token: &str,
    id: String,
) -> Result<Value> {
    Ok(account_json(
        client(channel)
            .get_surface_account(request(GetSurfaceAccountRequest { account_id: id }, token)?)
            .await?
            .into_inner(),
    ))
}

pub(crate) async fn fetch_location(
    channel: ProtocolChannel,
    token: &str,
    id: String,
) -> Result<Value> {
    Ok(location_json(
        client(channel)
            .get_surface_location(request(
                GetSurfaceLocationRequest { location_id: id },
                token,
            )?)
            .await?
            .into_inner(),
    ))
}

pub(crate) async fn list_accounts(connection: Connection, args: AccountListArgs) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let page = client(channel)
        .list_surface_accounts(request(
            ListSurfaceAccountsRequest {
                limit: args.limit,
                cursor: args.cursor,
            },
            &token,
        )?)
        .await?
        .into_inner();
    Ok(json!({
        "accounts": page.accounts.into_iter().map(account_json).collect::<Vec<_>>(),
        "next_cursor": page.next_cursor,
    }))
}

pub(crate) async fn list_locations(
    connection: Connection,
    args: LocationListArgs,
) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let page = client(channel)
        .list_surface_locations(request(
            ListSurfaceLocationsRequest {
                account_id: args.account,
                limit: args.limit,
                cursor: args.cursor,
            },
            &token,
        )?)
        .await?
        .into_inner();
    Ok(json!({
        "locations": page.locations.into_iter().map(location_json).collect::<Vec<_>>(),
        "next_cursor": page.next_cursor,
    }))
}

/// Removes a location's policy and stops new work on its connector alias.
pub(crate) async fn delete_location(
    connection: Connection,
    id: String,
    args: DeleteArgs,
) -> Result<Value> {
    let (channel, token) = connect_operator(connection).await?;
    let deleted = client(channel)
        .delete_surface_location(request(
            DeleteSurfaceLocationRequest {
                operation_id: operation_id(args.operation_id),
                location_id: id,
                expected_revision: args.expected_revision,
            },
            &token,
        )?)
        .await?
        .into_inner()
        .deleted;
    Ok(json!({ "deleted": deleted }))
}
