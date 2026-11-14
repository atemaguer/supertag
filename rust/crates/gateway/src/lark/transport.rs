use super::wire::{Fragments, Frame};
use super::{Connector, bounded_json};
use anyhow::{Context, Result, ensure};
use futures_util::{SinkExt, StreamExt};
use prost::Message;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tokio::{net::TcpStream, time};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{Message as WsMessage, protocol::WebSocketConfig},
};
use tokio_util::sync::CancellationToken;
struct Configuration {
    url: reqwest::Url,
    service: i32,
    settings: Settings,
}
#[derive(Clone, Copy)]
struct Settings {
    ping: Duration,
    retry: Duration,
    nonce: Duration,
    count: i64,
}
fn seconds(value: &Value, key: &str, min: u64, max: u64) -> Result<Duration> {
    let number = value[key]
        .as_u64()
        .filter(|n| *n >= min && *n <= max)
        .context("invalid Lark connection timing")?;
    Ok(Duration::from_secs(number))
}
impl Settings {
    fn read(value: &Value) -> Result<Self> {
        Ok(Self {
            ping: seconds(value, "PingInterval", 1, 300)?,
            retry: seconds(value, "ReconnectInterval", 1, 300)?,
            nonce: seconds(value, "ReconnectNonce", 0, 60)?,
            count: value["ReconnectCount"]
                .as_i64()
                .filter(|n| (-1..=10000).contains(n))
                .context("invalid Lark retry count")?,
        })
    }
    fn first_retry_delay(self) -> Duration {
        // Match the SDK's randomized reconnect nonce without retaining any secret.
        Duration::from_millis(
            (uuid::Uuid::new_v4().as_u128() % (self.nonce.as_millis() + 1)) as u64,
        )
    }
}
impl Connector {
    pub(super) async fn transport(&self, stop: &CancellationToken) -> Result<()> {
        let mut settings = Settings {
            ping: Duration::from_secs(120),
            retry: Duration::from_secs(1),
            nonce: Duration::ZERO,
            count: -1,
        };
        let mut failures = 0_i64;
        loop {
            let discovered = tokio::select! {_ = stop.cancelled()=>return Ok(()),result=self.discover()=>result?};
            if let Some(mut config) = discovered {
                settings = config.settings;
                let mut ws_config = WebSocketConfig::default();
                ws_config.max_message_size = Some(1024 * 1024);
                ws_config.max_frame_size = Some(1024 * 1024);
                let connected = tokio::select! {_ = stop.cancelled()=>return Ok(()),result=time::timeout(Duration::from_secs(5),connect_async_with_config(config.url.as_str(),Some(ws_config),false))=>result};
                if let Ok(Ok((mut socket, _))) = connected {
                    failures = 0;
                    let result = self.session(&mut socket, &mut config, stop).await;
                    settings = config.settings;
                    let _ = time::timeout(Duration::from_millis(500), socket.close(None)).await;
                    if stop.is_cancelled() {
                        return Ok(());
                    }
                    // An interrupted stream is rediscovered; unacknowledged input is
                    // replayed by the provider and resolved by the durable receipts.
                    let _ = result;
                }
            }
            failures += 1;
            ensure!(
                settings.count < 0 || failures <= settings.count.max(1),
                "Lark reconnect attempts exhausted"
            );
            let delay = if failures == 1 {
                settings.first_retry_delay()
            } else {
                settings.retry
            };
            tokio::select! {_ = stop.cancelled()=>return Ok(()),_ = time::sleep(delay)=>{}}
        }
    }
    async fn discover(&self) -> Result<Option<Configuration>> {
        let response = self
            .http
            .post(self.origin.join("callback/ws/endpoint")?)
            .header("locale", "zh")
            .header("user-agent", "supertag-gateway")
            .json(&json!({"AppID":self.config.app_id,"AppSecret":self.config.app_secret}))
            .send()
            .await;
        let Ok(response) = response else {
            return Ok(None);
        };
        if response.status().is_server_error()
            || response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS
        {
            return Ok(None);
        }
        ensure!(
            response.status() == reqwest::StatusCode::OK,
            "Lark discovery authentication rejected"
        );
        let value = bounded_json(response).await?;
        let code = value["code"]
            .as_i64()
            .context("invalid Lark discovery response")?;
        if matches!(code, 1 | 1000040343) {
            return Ok(None);
        }
        ensure!(
            code == 0,
            "Lark discovery credentials or connection limit rejected"
        );
        let url: reqwest::Url = value
            .pointer("/data/URL")
            .and_then(Value::as_str)
            .filter(|v| v.len() <= 8192)
            .context("Lark connection URL missing")?
            .parse()
            .map_err(|_| anyhow::anyhow!("invalid Lark connection URL"))?;
        ensure!(
            url.username().is_empty() && url.password().is_none() && url.fragment().is_none(),
            "invalid Lark WebSocket destination"
        );
        if self.test_origin {
            ensure!(
                url.scheme() == "ws"
                    && url.host_str() == self.origin.host_str()
                    && url.port_or_known_default() == self.origin.port_or_known_default(),
                "test Lark WebSocket escaped loopback origin"
            );
        } else {
            ensure!(url.scheme() == "wss", "Lark WebSocket requires TLS");
        }
        let services: Vec<_> = url
            .query_pairs()
            .filter(|(key, _)| key == "service_id")
            .collect();
        ensure!(services.len() == 1, "invalid Lark service identity");
        let service: i32 = services[0]
            .1
            .parse()
            .map_err(|_| anyhow::anyhow!("invalid Lark service identity"))?;
        ensure!(service > 0, "invalid Lark service identity");
        let devices: Vec<_> = url
            .query_pairs()
            .filter(|(key, _)| key == "device_id")
            .collect();
        ensure!(
            devices.len() == 1 && !devices[0].1.is_empty() && devices[0].1.len() <= 256,
            "invalid Lark device identity"
        );
        Ok(Some(Configuration {
            url,
            service,
            settings: Settings::read(&value["data"]["ClientConfig"])?,
        }))
    }
    async fn session(
        &self,
        socket: &mut WebSocketStream<MaybeTlsStream<TcpStream>>,
        config: &mut Configuration,
        stop: &CancellationToken,
    ) -> Result<()> {
        let mut fragments = Fragments::default();
        let mut ping = config.settings.ping;
        let mut next = time::Instant::now();
        let mut last = Instant::now();
        loop {
            tokio::select! {
              _=stop.cancelled()=>return Ok(()),
              _=time::sleep_until(next)=>{
                ensure!(last.elapsed()<ping.saturating_mul(2)+Duration::from_secs(5),"Lark connection stopped responding");
                send(socket,Frame::ping(config.service)).await?;next=time::Instant::now()+ping;
              },
              incoming=socket.next()=>{
                let message=incoming.context("Lark WebSocket closed")?.map_err(|_|anyhow::anyhow!("Lark WebSocket unavailable"))?;last=Instant::now();
                match message {
                  WsMessage::Binary(bytes)=>{
                    let frame=Fragments::decode(&bytes)?;ensure!(frame.service==config.service,"Lark frame service changed");
                    if frame.method==0 {
                      if frame.header("type")?=="pong" && let Some(payload)=frame.payload.as_deref().filter(|p|!p.is_empty()){
                        let settings:Value=serde_json::from_slice(payload).map_err(|_|anyhow::anyhow!("invalid Lark pong"))?;
                        config.settings=Settings::read(&settings)?;ping=config.settings.ping;next=time::Instant::now()+ping;
                      }
                    }else if frame.header("type")?=="event" && let Some(bytes)=fragments.push(&frame,Instant::now())?{
                      let started=Instant::now();let result=tokio::select!{_ = stop.cancelled()=>return Ok(()),result=self.accept(&bytes)=>result};
                      send(socket,frame.acknowledgement(if result.is_ok(){200}else{500},started.elapsed())).await?;
                    }
                  },
                  WsMessage::Ping(bytes)=>{time::timeout(Duration::from_millis(500),socket.send(WsMessage::Pong(bytes))).await.context("Lark pong timed out")?.map_err(|_|anyhow::anyhow!("Lark pong unavailable"))?;},
                  WsMessage::Close(_)=>return Ok(()),
                  WsMessage::Pong(_)=>{},
                  _=>anyhow::bail!("unsupported Lark WebSocket message"),
                }
              }
            }
        }
    }
}
async fn send(socket: &mut WebSocketStream<MaybeTlsStream<TcpStream>>, frame: Frame) -> Result<()> {
    time::timeout(
        Duration::from_millis(500),
        socket.send(WsMessage::Binary(frame.encode_to_vec().into())),
    )
    .await
    .context("Lark acknowledgement timed out")?
    .map_err(|_| anyhow::anyhow!("Lark acknowledgement unavailable"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_settings_bound_ping_retry_nonce_and_exhaustion() {
        let value =
            json!({"PingInterval":30,"ReconnectCount":4,"ReconnectInterval":2,"ReconnectNonce":3});
        let settings = Settings::read(&value).unwrap();
        assert_eq!(settings.ping, Duration::from_secs(30));
        assert_eq!(settings.retry, Duration::from_secs(2));
        assert_eq!(settings.count, 4);
        assert!(settings.first_retry_delay() <= Duration::from_secs(3));
        for field in [
            "PingInterval",
            "ReconnectInterval",
            "ReconnectNonce",
            "ReconnectCount",
        ] {
            let mut invalid = value.clone();
            invalid[field] = json!(10000000000_u64);
            assert!(Settings::read(&invalid).is_err());
        }
    }
}
