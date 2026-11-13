//! Location policy is evaluated only for an authenticated connector admission.
pub(crate) mod catalog;

use sqlx::{Any, Row, Transaction};
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};
use uuid::Uuid;

use crate::{
    ControlPlane, StoreError, objectives, policy,
    store::{Result, insert_task_with_surface, invalid, name},
};

use surface_account_identity::Provider as Identity;
use surface_location_scope::Provider as Location;

pub(crate) struct AdmissionSurface {
    pub origin: SurfacePolicyOrigin,
    pub permission_set_ids: Vec<String>,
    pub context_set_ids: Vec<String>,
}

#[derive(Clone, Copy)]
pub(crate) struct VerifiedConnectorOrigin<'a> {
    pub connector_account_id: &'a str,
    pub tag_id: &'a str,
    pub scope: VerifiedScope<'a>,
}

#[derive(Clone, Copy)]
pub(crate) enum VerifiedScope<'a> {
    Slack {
        team_id: &'a str,
        channel_id: &'a str,
    },
    Github {
        repository_id: u64,
    },
    Linear {
        workspace_id: &'a str,
        team_id: &'a str,
    },
    Lark {
        feishu: bool,
        app_id: &'a str,
        tenant_key: &'a str,
        chat_id: &'a str,
    },
    MicrosoftTeams {
        app_id: &'a str,
        tenant_id: &'a str,
        team_id: &'a str,
        channel_id: &'a str,
    },
}

impl VerifiedScope<'_> {
    fn matches(&self, account: &SurfaceAccount, location: &SurfaceLocation) -> bool {
        let identity = account
            .identity
            .as_ref()
            .and_then(|identity| identity.provider.as_ref());
        let location = location
            .scope
            .as_ref()
            .and_then(|scope| scope.provider.as_ref());
        match (self, identity, location) {
            (
                Self::Slack {
                    team_id,
                    channel_id,
                },
                Some(Identity::Slack(a)),
                Some(Location::Slack(l)),
            ) => *team_id == a.team_id && *channel_id == l.channel_id,
            (
                Self::Github { repository_id },
                Some(Identity::Github(_)),
                Some(Location::Github(l)),
            ) => *repository_id == l.repository_id,
            (
                Self::Linear {
                    workspace_id,
                    team_id,
                },
                Some(Identity::Linear(a)),
                Some(Location::Linear(l)),
            ) => *workspace_id == a.workspace_id && *team_id == l.team_id,
            (
                Self::Lark {
                    feishu,
                    app_id,
                    tenant_key,
                    chat_id,
                },
                Some(Identity::Lark(a)),
                Some(Location::Lark(l)),
            ) => {
                *feishu == a.feishu
                    && *app_id == a.app_id
                    && *tenant_key == a.tenant_key
                    && *chat_id == l.chat_id
            }
            (
                Self::MicrosoftTeams {
                    app_id,
                    tenant_id,
                    team_id,
                    channel_id,
                },
                Some(Identity::MicrosoftTeams(a)),
                Some(Location::MicrosoftTeams(l)),
            ) => {
                *app_id == a.app_id
                    && *tenant_id == a.tenant_id
                    && *team_id == l.team_id
                    && *channel_id == l.channel_id
            }
            _ => false,
        }
    }
}

/// Exact delivery and logical-source receipts are replayed by the caller first.
/// This only admits a fresh Task and does not modify the connector's reply route.
/// The verified origin's surface policy. `None` means the origin admits no new
/// work (a deleted or disabled location, or an inactive Tag).
pub(crate) async fn connector_surface_in(
    tx: &mut Transaction<'_, Any>,
    verified: &VerifiedConnectorOrigin<'_>,
) -> Result<Option<Option<AdmissionSurface>>> {
    let row = sqlx::query(
        "SELECT account.payload AS account, location.payload AS location
         FROM supertag_v2_managed_connector_aliases alias
         JOIN supertag_v2_surface_accounts account ON account.account_id=alias.account_id
         LEFT JOIN supertag_v2_surface_locations location
           ON location.connector_account_id=alias.connector_account_id
         WHERE alias.connector_account_id=$1",
    )
    .bind(verified.connector_account_id)
    .fetch_optional(&mut **tx)
    .await?;
    let surface = if let Some(row) = row {
        let account: SurfaceAccount = policy::decode(&row.try_get::<Vec<u8>, _>("account")?)?;
        let Some(bytes) = row.try_get::<Option<Vec<u8>>, _>("location")? else {
            // Deleted locations retain the alias reservation.
            return Ok(None);
        };
        let location: SurfaceLocation = policy::decode(&bytes)?;
        if verified.tag_id != location.tag_id || !verified.scope.matches(&account, &location) {
            return Err(StoreError::PermissionDenied);
        }
        if !account.enabled || !location.enabled {
            return Ok(None);
        }
        Some(AdmissionSurface {
            origin: SurfacePolicyOrigin {
                location_id: location.location_id,
                location_revision: location.revision,
                account_id: location.account_id,
                connector_account_id: location.connector_account_id,
                scope: location.scope,
                origin_actions: ["event:receive", "thread:read", "thread:reply"]
                    .map(str::to_owned)
                    .into(),
            },
            permission_set_ids: location.permission_set_ids,
            context_set_ids: location.context_set_ids,
        })
    } else {
        None
    };
    match crate::tags::require_active(tx, verified.tag_id).await {
        Ok(()) => {}
        Err(StoreError::FailedPrecondition(_)) => return Ok(None),
        Err(error) => return Err(error),
    }
    Ok(Some(surface))
}

pub(crate) async fn admit_connector_task_in(
    tx: &mut Transaction<'_, Any>,
    order: i64,
    verified: VerifiedConnectorOrigin<'_>,
    session_id: &str,
    prompt: &str,
    now_ms: i64,
) -> Result<Option<Task>> {
    let Some(surface) = connector_surface_in(tx, &verified).await? else {
        return Ok(None);
    };
    objectives::objective_admission_in(tx, verified.tag_id, session_id, now_ms).await?;
    let mut task = insert_task_with_surface(
        tx,
        order,
        verified.tag_id,
        session_id,
        prompt,
        surface.as_ref(),
    )
    .await?;
    crate::artifact_context::resolve_in(tx, &mut task, now_ms).await?;
    objectives::objective_link_task_in(tx, &task).await?;
    Ok(Some(task))
}

pub(crate) async fn reject_generic_in(tx: &mut Transaction<'_, Any>, account: &str) -> Result<()> {
    let managed: Option<String> = sqlx::query_scalar(
        "SELECT connector_account_id FROM supertag_v2_managed_connector_aliases WHERE connector_account_id=$1",
    )
    .bind(account)
    .fetch_optional(&mut **tx)
    .await?;
    if managed.is_some() {
        return Err(StoreError::PermissionDenied);
    }
    Ok(())
}

pub fn validate_manifest_account(account: &SurfaceAccount) -> Result<()> {
    provider_identity(account)?;
    Ok(())
}

pub fn validate_manifest_location(
    location: &SurfaceLocation,
    account: &SurfaceAccount,
) -> Result<()> {
    let (provider, _) = location_scope(location)?;
    if provider != provider_identity(account)?.0 {
        return Err(invalid(
            "Surface Account and location use different providers",
        ));
    }
    verify_alias(provider, &location.connector_account_id)
}

fn provider_identity(account: &SurfaceAccount) -> Result<(&'static str, String)> {
    let identity = account
        .identity
        .as_ref()
        .and_then(|identity| identity.provider.as_ref());
    let (provider, key) = match identity {
        Some(Identity::Slack(a)) if slack_id(&a.team_id, b"T") => {
            ("slack", serde_json::to_string(&a.team_id)?)
        }
        Some(Identity::Github(a)) => {
            name("GitHub account identity", &a.external_account_id)?;
            ("github", serde_json::to_string(&a.external_account_id)?)
        }
        Some(Identity::Linear(a)) if canonical_uuid(&a.workspace_id) => {
            ("linear", serde_json::to_string(&a.workspace_id)?)
        }
        Some(Identity::Lark(a)) if lark_app(&a.app_id) && alias_part(&a.tenant_key) => (
            "lark",
            serde_json::to_string(&(a.feishu, &a.app_id, &a.tenant_key))?,
        ),
        Some(Identity::MicrosoftTeams(a))
            if canonical_uuid(&a.app_id) && canonical_uuid(&a.tenant_id) =>
        {
            ("teams", serde_json::to_string(&(&a.app_id, &a.tenant_id))?)
        }
        _ => return Err(invalid("invalid typed Surface Account identity")),
    };
    Ok((provider, format!("{provider}:{key}")))
}

fn location_scope(location: &SurfaceLocation) -> Result<(&'static str, String)> {
    let scope = location
        .scope
        .as_ref()
        .and_then(|scope| scope.provider.as_ref());
    match scope {
        Some(Location::Slack(l)) if slack_id(&l.channel_id, b"CG") => {
            Ok(("slack", format!("channel:{}", l.channel_id)))
        }
        Some(Location::Github(l)) if (1..=i64::MAX as u64).contains(&l.repository_id) => {
            Ok(("github", format!("repository:{}", l.repository_id)))
        }
        Some(Location::Linear(l)) if canonical_uuid(&l.team_id) => {
            Ok(("linear", format!("team:{}", l.team_id)))
        }
        Some(Location::Lark(l))
            if l.chat_id.starts_with("oc_") && l.chat_id.len() > 3 && alias_part(&l.chat_id) =>
        {
            Ok(("lark", format!("chat:{}", l.chat_id)))
        }
        Some(Location::MicrosoftTeams(l)) if canonical_uuid(&l.team_id) => {
            name("Microsoft Teams channel ID", &l.channel_id)?;
            Ok((
                "teams",
                format!("team:{}/channel:{}", l.team_id, l.channel_id),
            ))
        }
        _ => Err(invalid("invalid typed Surface location")),
    }
}

fn verify_alias(provider: &str, alias: &str) -> Result<()> {
    let suffix = if provider == "slack" {
        Some(alias)
    } else {
        alias
            .split_once('/')
            .filter(|(prefix, _)| *prefix == provider)
            .map(|(_, suffix)| suffix)
    };
    if !suffix.is_some_and(alias_part) {
        return Err(invalid(
            "connector account alias does not match the Surface provider",
        ));
    }
    Ok(())
}

fn alias_part(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn slack_id(value: &str, prefixes: &[u8]) -> bool {
    (2..=64).contains(&value.len())
        && prefixes.contains(&value.as_bytes()[0])
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
}

fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| !id.is_nil() && id.hyphenated().to_string() == value)
}

fn lark_app(value: &str) -> bool {
    value.strip_prefix("cli_").is_some_and(|suffix| {
        suffix.len() == 16 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

impl ControlPlane {
    pub fn surface_policy_service(
        &self,
    ) -> surface_policy_catalog_server::SurfacePolicyCatalogServer<Self> {
        surface_policy_catalog_server::SurfacePolicyCatalogServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl surface_policy_catalog_server::SurfacePolicyCatalog for ControlPlane {
    async fn put_surface_account(
        &self,
        request: Request<PutSurfaceAccountRequest>,
    ) -> std::result::Result<Response<SurfaceAccount>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .put_surface_account(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn get_surface_account(
        &self,
        request: Request<GetSurfaceAccountRequest>,
    ) -> std::result::Result<Response<SurfaceAccount>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .get_surface_account(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn list_surface_accounts(
        &self,
        request: Request<ListSurfaceAccountsRequest>,
    ) -> std::result::Result<Response<ListSurfaceAccountsResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_surface_accounts(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn put_surface_location(
        &self,
        request: Request<PutSurfaceLocationRequest>,
    ) -> std::result::Result<Response<SurfaceLocation>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .put_surface_location(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn get_surface_location(
        &self,
        request: Request<GetSurfaceLocationRequest>,
    ) -> std::result::Result<Response<SurfaceLocation>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .get_surface_location(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn list_surface_locations(
        &self,
        request: Request<ListSurfaceLocationsRequest>,
    ) -> std::result::Result<Response<ListSurfaceLocationsResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .list_surface_locations(&principal, request.get_ref())
                .await?,
        ))
    }
    async fn delete_surface_location(
        &self,
        request: Request<DeleteSurfaceLocationRequest>,
    ) -> std::result::Result<Response<DeletePolicyResourceResponse>, Status> {
        let principal = self.principal(&request, "operator:")?;
        Ok(Response::new(
            self.store
                .delete_surface_location(&principal, request.get_ref())
                .await?,
        ))
    }
}
