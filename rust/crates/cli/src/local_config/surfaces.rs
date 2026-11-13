//! The `surfaces` section of `supertag.yaml`: the collaboration accounts the local Gateway
//! connects, and the one location each serves. It never holds a secret: credentials live in the
//! credential vault at `surface/<provider>/<name>`, written by `supertag setup surface`.

use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    net::SocketAddr,
    path::Path,
};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

#[derive(
    Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord, clap::ValueEnum,
)]
#[serde(rename_all = "kebab-case")]
pub enum Provider {
    Slack,
    Github,
    Linear,
    Lark,
    Teams,
}

impl Provider {
    pub fn name(self) -> &'static str {
        match self {
            Self::Slack => "slack",
            Self::Github => "github",
            Self::Linear => "linear",
            Self::Lark => "lark",
            Self::Teams => "teams",
        }
    }
    /// Lark keeps a long connection; the others receive webhooks on a loopback listener.
    fn webhook(self) -> bool {
        self != Self::Lark
    }
}

/// Gateway flags and environment variables for one connector.
pub type GatewayLaunch = (Vec<OsString>, Vec<(String, String)>);

/// One Surface Account entry. `account` is the provider account that setup verified.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct Surface {
    pub provider: Provider,
    pub account: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Loopback webhook listener of a Slack, GitHub, Linear, or Teams connector.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listen: Option<String>,
    /// GitHub: `token` (default) or `app`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<String>,
    /// GitHub App ID, or the Microsoft application (client) ID of a Teams bot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installation_id: Option<String>,
    /// Lark: `lark` or `feishu`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_open_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<Location>,
}

/// Where the account's connector admits work for one Tag, and who may ask.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct Location {
    pub tag: String,
    pub allowed_users: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository_id: Option<u64>,
}

impl Location {
    /// The provider scope as the Control Plane keys it, such as `channel:C123`.
    pub fn scope_key(&self, provider: Provider) -> Result<String> {
        let field = |value: &Option<String>, flag: &str| {
            value
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .with_context(|| format!("a {} location requires {flag}", provider.name()))
        };
        Ok(match provider {
            Provider::Slack => format!("channel:{}", field(&self.channel_id, "channel-id")?),
            Provider::Github => {
                field(&self.repository, "repository")?;
                format!(
                    "repository:{}",
                    self.repository_id
                        .context("a github location requires repository-id")?
                )
            }
            Provider::Linear => format!("team:{}", field(&self.team_id, "team-id")?),
            Provider::Lark => format!("chat:{}", field(&self.chat_id, "chat-id")?),
            Provider::Teams => format!(
                "team:{}/channel:{}",
                field(&self.team_id, "team-id")?,
                field(&self.channel_id, "channel-id")?
            ),
        })
    }

    /// The human form of the scope used in command output.
    pub fn describe(&self, provider: Provider) -> String {
        match provider {
            Provider::Slack => self.channel_id.clone().unwrap_or_default(),
            Provider::Github => self.repository.clone().unwrap_or_default(),
            Provider::Linear => self.team_id.clone().unwrap_or_default(),
            Provider::Lark => self.chat_id.clone().unwrap_or_default(),
            Provider::Teams => format!(
                "{}/{}",
                self.team_id.as_deref().unwrap_or_default(),
                self.channel_id.as_deref().unwrap_or_default()
            ),
        }
    }
}

impl Surface {
    /// The credential vault ID that holds this account's secrets.
    pub fn credential_id(&self, name: &str) -> String {
        format!("surface/{}/{name}", self.provider.name())
    }

    fn unused(&self) -> Vec<&'static str> {
        let present = [
            ("auth", self.auth.is_some()),
            ("app-id", self.app_id.is_some()),
            ("installation-id", self.installation_id.is_some()),
            ("domain", self.domain.is_some()),
            ("tenant-key", self.tenant_key.is_some()),
            ("bot-open-id", self.bot_open_id.is_some()),
            ("bot-id", self.bot_id.is_some()),
            ("bot-user-id", self.bot_user_id.is_some()),
            ("listen", self.listen.is_some()),
        ];
        let allowed: &[&str] = match self.provider {
            Provider::Slack => &["bot-id", "bot-user-id", "listen"],
            Provider::Github => &["auth", "app-id", "installation-id", "listen"],
            Provider::Linear => &["listen"],
            Provider::Lark => &["domain", "tenant-key", "bot-open-id"],
            Provider::Teams => &["app-id", "listen"],
        };
        present
            .into_iter()
            .filter(|(key, set)| *set && !allowed.contains(key))
            .map(|(key, _)| key)
            .collect()
    }

    fn validate(&self, name: &str) -> Result<()> {
        let provider = self.provider.name();
        ensure!(
            !self.account.trim().is_empty() && self.account.len() <= 256,
            "surface {name} requires its verified account"
        );
        if let Some(key) = self.unused().first() {
            bail!("surface {name}: {provider} does not use {key}");
        }
        match self.provider {
            Provider::Github => match (self.auth.as_deref().unwrap_or("token"), &self.app_id) {
                ("token", None) if self.installation_id.is_none() => {}
                ("app", Some(app))
                    if numeric(app) && self.installation_id.as_deref().is_some_and(numeric) => {}
                ("token" | "app", _) => bail!(
                    "surface {name}: GitHub App authentication requires numeric app-id and installation-id, and token authentication uses neither"
                ),
                _ => bail!("surface {name}: auth must be token or app"),
            },
            Provider::Lark => {
                ensure!(
                    matches!(self.domain.as_deref(), Some("lark" | "feishu")),
                    "surface {name}: domain must be lark or feishu"
                );
                ensure!(
                    self.tenant_key.is_some() && self.bot_open_id.is_some(),
                    "surface {name}: lark requires tenant-key and bot-open-id"
                );
            }
            Provider::Teams => ensure!(
                self.app_id.is_some(),
                "surface {name}: teams requires app-id"
            ),
            Provider::Slack | Provider::Linear => {}
        }
        if let Some(listen) = &self.listen {
            let address: SocketAddr = listen
                .parse()
                .with_context(|| format!("surface {name}: listen must be ADDRESS:PORT"))?;
            ensure!(
                address.ip().is_loopback() && address.port() != 0,
                "surface {name}: listen must be a loopback address with a fixed port"
            );
        }
        if let Some(location) = &self.location {
            ensure!(
                !location.tag.trim().is_empty() && location.tag.len() <= 256,
                "surface {name}: location requires a tag"
            );
            ensure!(
                !location.allowed_users.is_empty()
                    && location
                        .allowed_users
                        .iter()
                        .all(|user| !user.trim().is_empty() && !user.contains(',')),
                "surface {name}: location requires allowed-users"
            );
            let used: &[&str] = match self.provider {
                Provider::Slack => &["channel-id"],
                Provider::Github => &["repository", "repository-id"],
                Provider::Linear => &["team-id"],
                Provider::Lark => &["chat-id"],
                Provider::Teams => &["team-id", "channel-id"],
            };
            for (key, set) in [
                ("channel-id", location.channel_id.is_some()),
                ("team-id", location.team_id.is_some()),
                ("chat-id", location.chat_id.is_some()),
                ("repository", location.repository.is_some()),
                ("repository-id", location.repository_id.is_some()),
            ] {
                ensure!(
                    !set || used.contains(&key),
                    "surface {name}: a {provider} location does not use {key}"
                );
            }
            location.scope_key(self.provider)?;
            ensure!(
                !self.provider.webhook() || self.listen.is_some(),
                "surface {name}: a {provider} location requires listen"
            );
        }
        Ok(())
    }

    /// The Control Plane location ID, which is also the connector account alias the Gateway
    /// serves it under. It is derived from the Tag and scope because the Control Plane binds
    /// an alias to one location for good.
    pub fn location_id(&self, name: &str, location: &Location) -> Result<String> {
        let digest = Sha256::digest(format!(
            "{}\n{}",
            location.tag,
            location.scope_key(self.provider)?
        ));
        Ok(format!("{name}-{}", crate::lifecycle::hex(&digest[..6])))
    }

    /// The connector account alias in Control Plane policy: bare for Slack, and qualified with
    /// the provider elsewhere, as each Gateway connector qualifies its configured account.
    pub fn connector_alias(&self, name: &str, location: &Location) -> Result<String> {
        let id = self.location_id(name, location)?;
        Ok(match self.provider {
            Provider::Slack => id,
            provider => format!("{}/{id}", provider.name()),
        })
    }

    /// Gateway flags and environment for this entry's connector, or `None` without a location.
    pub fn gateway(&self, name: &str, state: &Path) -> Result<Option<GatewayLaunch>> {
        let Some(location) = &self.location else {
            return Ok(None);
        };
        let directory = state.join("surfaces").join(name);
        let account = self.location_id(name, location)?;
        let listen = self.listen.clone().unwrap_or_default();
        let (flag, prefix) = match self.provider {
            Provider::Slack => ("slack", "SUPERTAG_SLACK"),
            Provider::Github => ("github", "SUPERTAG_GITHUB"),
            Provider::Linear => ("linear", "SUPERTAG_LINEAR"),
            Provider::Lark => ("lark", "SUPERTAG_LARK"),
            Provider::Teams => ("microsoft-teams", "SUPERTAG_MICROSOFT_TEAMS"),
        };
        let mut args = Vec::new();
        if self.provider.webhook() {
            args.extend([format!("--{flag}-listen").into(), listen.into()]);
        }
        args.extend([
            format!("--{flag}-state-directory").into(),
            directory.into_os_string(),
        ]);
        let text = |value: &Option<String>| value.clone().unwrap_or_default();
        let mut environment = vec![
            ("ACCOUNT_ID", account),
            ("TAG_ID", location.tag.clone()),
            ("ALLOWED_USERS", location.allowed_users.join(",")),
            ("CREDENTIAL_ID", self.credential_id(name)),
        ];
        match self.provider {
            Provider::Slack => environment.extend([
                ("TEAM_ID", self.account.clone()),
                ("CHANNEL_ID", text(&location.channel_id)),
            ]),
            Provider::Github => {
                environment.extend([
                    ("REPOSITORY", text(&location.repository)),
                    (
                        "REPOSITORY_ID",
                        location.repository_id.unwrap_or_default().to_string(),
                    ),
                ]);
                if self.auth.as_deref() == Some("app") {
                    environment.extend([
                        ("APP_ID", text(&self.app_id)),
                        ("INSTALLATION_ID", text(&self.installation_id)),
                    ]);
                }
            }
            Provider::Linear => environment.extend([
                ("WORKSPACE_ID", self.account.clone()),
                ("TEAM_ID", text(&location.team_id)),
            ]),
            Provider::Lark => environment.extend([
                ("DOMAIN", text(&self.domain)),
                ("APP_ID", self.account.clone()),
                ("TENANT_KEY", text(&self.tenant_key)),
                ("BOT_OPEN_ID", text(&self.bot_open_id)),
                ("CHAT_ID", text(&location.chat_id)),
            ]),
            Provider::Teams => environment.extend([
                ("APP_ID", text(&self.app_id)),
                ("TENANT_ID", self.account.clone()),
                ("TEAM_ID", text(&location.team_id)),
                ("CHANNEL_ID", text(&location.channel_id)),
            ]),
        }
        Ok(Some((
            args,
            environment
                .into_iter()
                .map(|(key, value)| (format!("{prefix}_{key}"), value))
                .collect(),
        )))
    }
}

fn numeric(value: &str) -> bool {
    !value.is_empty() && value.len() <= 19 && value.bytes().all(|b| b.is_ascii_digit())
}

/// Validates every entry, and that the one local Gateway can run all configured locations: it
/// runs one connector per provider, each on its own listener.
pub fn validate(surfaces: &BTreeMap<String, Surface>) -> Result<()> {
    ensure!(surfaces.len() <= 64, "configure at most 64 surfaces");
    let mut serving = BTreeMap::new();
    let mut listeners = BTreeSet::new();
    for (name, surface) in surfaces {
        super::identifier(name)?;
        surface.validate(name)?;
        if let (Some(listen), Some(_)) = (&surface.listen, &surface.location) {
            ensure!(
                listeners.insert(listen.parse::<SocketAddr>()?),
                "surfaces with locations must use different listen addresses"
            );
        }
        if surface.location.is_some()
            && let Some(other) = serving.insert(surface.provider, name)
        {
            bail!(
                "surfaces {other} and {name} both have a {} location; the local Gateway serves one location per provider",
                surface.provider.name()
            );
        }
    }
    Ok(())
}
