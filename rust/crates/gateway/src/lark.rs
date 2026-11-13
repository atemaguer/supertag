//! Outbound Lark/Feishu connection with durable admission before acknowledgement.
mod delivery;
pub(crate) mod render;
#[cfg(test)]
mod tests;
mod transport;
// Public only to let external-process fixtures encode actual provider frames.
#[doc(hidden)]
pub mod wire;
use crate::delivery_journal::Journal;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request,
    v2::{AcceptLarkEventRequest, LarkDomain, connector_client::ConnectorClient},
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use tonic::Request;
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(2);
const DELIVERY_TIMEOUT: Duration = Duration::from_secs(5);
pub struct LarkConfig {
    pub account_id: String,
    pub domain: LarkDomain,
    pub app_id: String,
    pub app_secret: String,
    pub tenant_key: String,
    pub bot_open_id: String,
    pub chat_id: String,
    pub tag_id: String,
    pub allowed_users: Vec<String>,
    pub state_directory: PathBuf,
}
#[derive(Clone)]
pub struct Lark(Arc<Connector>);
struct Connector {
    config: LarkConfig,
    control_plane: ConnectorClient<ProtocolChannel>,
    gateway_token: String,
    principal: String,
    http: reqwest::Client,
    origin: reqwest::Url,
    test_origin: bool,
    journal: Journal,
    token: Mutex<Option<AccessToken>>,
}
struct AccessToken {
    value: String,
    expires: Instant,
}
impl Lark {
    pub fn new(
        mut config: LarkConfig,
        channel: ProtocolChannel,
        gateway_token: String,
    ) -> Result<Self> {
        ensure!(
            valid_id(&config.account_id, "")
                && valid_app(&config.app_id)
                && valid_id(&config.tenant_key, "")
                && valid_id(&config.bot_open_id, "ou_")
                && valid_id(&config.chat_id, "oc_"),
            "invalid Lark account or route identity"
        );
        ensure!(
            !config.app_secret.trim().is_empty()
                && !config.tag_id.trim().is_empty()
                && config.tag_id.len() <= 256
                && !config.allowed_users.is_empty()
                && config.allowed_users.iter().all(|id| valid_id(id, "ou_")),
            "invalid Lark credentials, Tag, or allowed users"
        );
        let origin = match config.domain {
            LarkDomain::Lark => "https://open.larksuite.com/",
            LarkDomain::Feishu => "https://open.feishu.cn/",
            _ => anyhow::bail!("Lark domain is required"),
        }
        .parse()?;
        config.account_id = format!("lark/{}", config.account_id);
        let principal = format!("connector:{}", config.account_id);
        authenticated_request((), &gateway_token, Some(&principal))?;
        let journal = Journal::open(&config.state_directory, &config.account_id, "lark")?;
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .timeout(DELIVERY_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .build()?;
        Ok(Self(Arc::new(Connector {
            config,
            control_plane: ConnectorClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
            gateway_token,
            principal,
            http,
            origin,
            test_origin: false,
            journal,
            token: Mutex::new(None),
        })))
    }
    #[cfg(feature = "test-fixtures")]
    pub fn with_test_origin(mut self, url: &str) -> Result<Self> {
        let url: reqwest::Url = url.parse()?;
        ensure!(
            url.scheme() == "http"
                && url.host_str().is_some_and(|h| h
                    .trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback()))
                && url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none(),
            "Lark fixture origin must be loopback HTTP"
        );
        let inner = Arc::get_mut(&mut self.0).context("set fixture origin before sharing Lark")?;
        inner.origin = url;
        inner.test_origin = true;
        Ok(self)
    }
    pub async fn run(self, shutdown: CancellationToken) -> Result<()> {
        let stop = shutdown.child_token();
        // Verify the App's bot identity before either accepting input or sending
        // pending replies. Provider secrets and discovery URLs stay in memory.
        tokio::select! {_ = stop.cancelled()=>return Ok(()), result=self.0.verify_bot()=>result?}
        let transport = self.0.transport(&stop);
        let delivery = self.0.deliver(&stop);
        tokio::pin!(transport, delivery);
        tokio::select! {result=&mut transport=>{stop.cancel();result.and(delivery.await)},result=&mut delivery=>{stop.cancel();result.and(transport.await)}}
    }
}
impl Connector {
    fn request<T>(&self, input: T, timeout: Duration) -> Result<Request<T>> {
        let mut request = authenticated_request(input, &self.gateway_token, Some(&self.principal))?;
        request.set_timeout(timeout);
        Ok(request)
    }
    async fn access_token(&self) -> Result<String> {
        let mut cache = self.token.lock().await;
        if let Some(token) = &*cache
            && token.expires > Instant::now()
        {
            return Ok(token.value.clone());
        }
        let response = self
            .http
            .post(
                self.origin
                    .join("open-apis/auth/v3/tenant_access_token/internal")?,
            )
            .json(&json!({"app_id":self.config.app_id,"app_secret":self.config.app_secret}))
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Lark token exchange unavailable"))?;
        ensure!(
            response.status() == reqwest::StatusCode::OK,
            "Lark token exchange rejected"
        );
        let value = bounded_json(response).await?;
        ensure!(
            value["code"].as_i64() == Some(0),
            "Lark token exchange failed"
        );
        let token = value["tenant_access_token"]
            .as_str()
            .filter(|v| !v.is_empty() && v.len() <= 8192)
            .context("Lark token missing")?;
        let seconds = value["expire"]
            .as_u64()
            .filter(|s| *s > 5 && *s <= 86400)
            .context("invalid Lark token expiry")?;
        *cache = Some(AccessToken {
            value: token.into(),
            expires: Instant::now() + Duration::from_secs(seconds - seconds.min(360) / 2),
        });
        Ok(token.into())
    }
    async fn verify_bot(&self) -> Result<()> {
        let token = self.access_token().await?;
        let response = self
            .http
            .get(self.origin.join("open-apis/bot/v3/info")?)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Lark bot verification unavailable"))?;
        ensure!(
            response.status() == reqwest::StatusCode::OK,
            "Lark bot verification rejected"
        );
        let value = bounded_json(response).await?;
        ensure!(
            value["code"].as_i64() == Some(0)
                && value.pointer("/bot/open_id").and_then(Value::as_str)
                    == Some(self.config.bot_open_id.as_str()),
            "Lark bot identity does not match configuration"
        );
        Ok(())
    }
    async fn accept(&self, bytes: &[u8]) -> Result<()> {
        if let Some(input) = normalize(&self.config, bytes)? {
            let request = self.request(input, ACCEPT_TIMEOUT)?;
            tokio::time::timeout(
                ACCEPT_TIMEOUT,
                self.control_plane.clone().accept_lark_event(request),
            )
            .await
            .context("Lark admission timed out")?
            .map_err(|_| anyhow::anyhow!("Lark admission rejected"))?;
        }
        Ok(())
    }
}
async fn bounded_json(mut response: reqwest::Response) -> Result<Value> {
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if chunk.len() <= 128 * 1024 - bytes.len() => {
                bytes.extend_from_slice(&chunk)
            }
            Ok(None) => break,
            _ => anyhow::bail!("invalid or oversized Lark response"),
        }
    }
    serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("invalid Lark response"))
}
fn valid_id(value: &str, prefix: &str) -> bool {
    value.len() > prefix.len()
        && value.len() <= 128
        && value.starts_with(prefix)
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}
fn valid_app(value: &str) -> bool {
    value
        .strip_prefix("cli_")
        .is_some_and(|id| id.len() == 16 && id.bytes().all(|b| b.is_ascii_hexdigit()))
}
fn required<'a>(value: &'a Value, pointer: &str) -> Result<&'a str> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .context("missing Lark event identity")
}
fn normalize(config: &LarkConfig, bytes: &[u8]) -> Result<Option<AcceptLarkEventRequest>> {
    ensure!(bytes.len() <= 1024 * 1024, "Lark event too large");
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| anyhow::anyhow!("invalid Lark event JSON"))?;
    ensure!(value["schema"] == "2.0", "unsupported Lark event schema");
    ensure!(
        required(&value, "/header/app_id")? == config.app_id
            && required(&value, "/header/tenant_key")? == config.tenant_key,
        "Lark event belongs to another app or tenant"
    );
    if required(&value, "/header/event_type")? != "im.message.receive_v1" {
        return Ok(None);
    }
    if value
        .pointer("/event/sender/tenant_key")
        .and_then(Value::as_str)
        .is_some_and(|tenant| tenant != config.tenant_key)
    {
        anyhow::bail!("Lark sender belongs to another tenant");
    }
    if value
        .pointer("/event/sender/sender_type")
        .and_then(Value::as_str)
        != Some("user")
        || value
            .pointer("/event/message/message_type")
            .and_then(Value::as_str)
            != Some("text")
    {
        return Ok(None);
    }
    let actor = required(&value, "/event/sender/sender_id/open_id")?;
    let chat = required(&value, "/event/message/chat_id")?;
    if !config.allowed_users.iter().any(|id| id == actor) || chat != config.chat_id {
        return Ok(None);
    }
    let message = required(&value, "/event/message/message_id")?;
    let root = value
        .pointer("/event/message/root_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            value
                .pointer("/event/message/parent_id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        })
        .unwrap_or(message);
    ensure!(
        valid_id(message, "om_") && valid_id(root, "om_"),
        "invalid Lark message identity"
    );
    let kind = required(&value, "/event/message/chat_type")?;
    ensure!(
        matches!(kind, "p2p" | "group"),
        "unsupported Lark chat type"
    );
    let direct = kind == "p2p";
    let content: Value = serde_json::from_str(required(&value, "/event/message/content")?)
        .map_err(|_| anyhow::anyhow!("invalid Lark message content"))?;
    let Some(text) = content["text"].as_str() else {
        return Ok(None);
    };
    let mut prompt = text.to_string();
    let mut mentioned = false;
    if let Some(mentions) = value
        .pointer("/event/message/mentions")
        .and_then(Value::as_array)
    {
        for mention in mentions {
            if mention.pointer("/id/open_id").and_then(Value::as_str)
                == Some(config.bot_open_id.as_str())
            {
                mentioned = true;
                if let Some(key) = mention["key"].as_str().filter(|key| !key.is_empty()) {
                    prompt = prompt.replace(key, "");
                }
            }
        }
    }
    let prompt = prompt
        .trim()
        .trim_start_matches([':', ',', ';', '-'])
        .trim();
    if prompt.is_empty() {
        return Ok(None);
    }
    ensure!(prompt.len() <= 128 * 1024, "Lark message too large");
    if !direct && !mentioned && root == message {
        return Ok(None);
    }
    Ok(Some(AcceptLarkEventRequest {
        account_id: config.account_id.clone(),
        domain: config.domain.into(),
        app_id: config.app_id.clone(),
        tenant_key: config.tenant_key.clone(),
        event_id: required(&value, "/header/event_id")?.into(),
        chat_id: chat.into(),
        message_id: message.into(),
        root_message_id: root.into(),
        actor_id: actor.into(),
        prompt: prompt.into(),
        mention_tag_id: (mentioned || (direct && root == message)).then(|| config.tag_id.clone()),
        direct,
    }))
}
