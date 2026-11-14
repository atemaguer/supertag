use super::*;
use axum::{Router, body::Body, routing::post};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use supertag_protocol::v2::ReplyLease;
use tokio::{net::TcpListener, sync::Notify};
use tonic::transport::{Endpoint, Server};

#[derive(Clone, Copy)]
enum Mode {
    Transient,
    Revoke,
    Hold,
}
#[derive(Clone)]
struct Fixture {
    calls: Arc<AtomicUsize>,
    renewal_started: Arc<Notify>,
    provider_progress: Arc<Notify>,
    renewed: Arc<Notify>,
    mode: Mode,
    initial_error: Option<tonic::Code>,
}
impl Fixture {
    fn new(mode: Mode) -> Self {
        Self {
            calls: Arc::new(AtomicUsize::new(0)),
            renewal_started: Arc::new(Notify::new()),
            provider_progress: Arc::new(Notify::new()),
            renewed: Arc::new(Notify::new()),
            mode,
            initial_error: None,
        }
    }
    async fn client(&self) -> Result<(ConnectorClient<ProtocolChannel>, AbortOnDrop)> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let fixture = self.clone();
        let server = tokio::spawn(async move {
            Server::builder()
                .add_service(supertag_protocol::v2::connector_server::ConnectorServer::new(fixture))
                .serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(listener))
                .await
                .unwrap();
        });
        let channel = Endpoint::from_shared(format!("http://{address}"))?
            .connect()
            .await?;
        Ok((
            ConnectorClient::new(supertag_protocol::negotiation::bind_current(channel)),
            AbortOnDrop(server),
        ))
    }
}
struct AbortOnDrop(tokio::task::JoinHandle<()>);
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}
fn target() -> Claim {
    Claim {
        reply_id: "reply".into(),
        lease_token: "lease".into(),
    }
}

#[tokio::test]
async fn a_connection_lost_mid_response_is_retried_not_rejected() -> Result<()> {
    // How tonic reports a connection that broke while a response body was being read,
    // for example a dropped WebSocket tunnel: `Unknown` with only the local I/O cause.
    let broken = || {
        tonic::Status::from_error(Box::new(std::io::Error::new(
            std::io::ErrorKind::ConnectionReset,
            "connection reset",
        )))
    };
    assert_eq!(broken().code(), tonic::Code::Unknown);
    assert!(
        private_call(async { Err::<(), _>(broken()) }, "accept event")
            .await?
            .is_none()
    );
    assert!(!settle_call(async { Err(broken()) }, "settle reply").await?);
    // A status the Control Plane itself sent is still definitive.
    assert!(
        private_call(
            async { Err::<(), _>(tonic::Status::unknown("rejected")) },
            "accept event"
        )
        .await
        .is_err()
    );
    Ok(())
}

#[tokio::test]
async fn transient_renewals_do_not_pause_or_abandon_held_provider_io() -> Result<()> {
    let fixture = Fixture::new(Mode::Transient);
    let (client, _lease_server) = fixture.client().await?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let http_fixture = fixture.clone();
    let router = Router::new().route(
        "/reply",
        post(move || {
            let fixture = http_fixture.clone();
            async move {
                fixture.renewal_started.notified().await;
                Body::from_stream(async_stream::stream! {
                    yield Ok::<_, std::io::Error>("partial-");
                    fixture.renewed.notified().await;
                    yield Ok::<_, std::io::Error>("receipt");
                })
            }
        }),
    );
    let _provider = AbortOnDrop(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));
    let work = async {
        let mut response = reqwest::Client::new()
            .post(format!("http://{address}/reply"))
            .send()
            .await?;
        let first = response.chunk().await?.context("first provider chunk")?;
        assert_eq!(first.as_ref(), b"partial-");
        // Renewal cannot return until the provider future has made progress.
        fixture.provider_progress.notify_one();
        let rest = response.bytes().await?;
        assert_eq!(rest.as_ref(), b"receipt");
        Ok("receipt")
    };
    let result = time::timeout(
        Duration::from_secs(13),
        with_claim_lease(client, "private-gateway-token", "account", &target(), work),
    )
    .await??;
    assert_eq!(result, Some("receipt"));
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 5);
    Ok(())
}

#[tokio::test]
async fn initial_renewal_must_prove_authority_before_provider_poll() -> Result<()> {
    for code in [
        tonic::Code::Unavailable,
        tonic::Code::Cancelled,
        tonic::Code::DeadlineExceeded,
        tonic::Code::FailedPrecondition,
        tonic::Code::PermissionDenied,
    ] {
        let mut fixture = Fixture::new(Mode::Revoke);
        fixture.initial_error = Some(code);
        let (client, _server) = fixture.client().await?;
        let polled = AtomicBool::new(false);
        let result = with_claim_lease(
            client,
            "private-gateway-token",
            "account",
            &target(),
            async {
                polled.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;
        assert!(!polled.load(Ordering::SeqCst));
        if code == tonic::Code::PermissionDenied {
            assert!(result.is_err());
        } else {
            assert!(result?.is_none());
        }
    }
    Ok(())
}

#[tokio::test]
async fn explicit_revocation_drops_pending_provider_without_waiting_for_expiry() -> Result<()> {
    let fixture = Fixture::new(Mode::Revoke);
    let (client, _server) = fixture.client().await?;
    let result = time::timeout(
        Duration::from_secs(5),
        with_claim_lease(
            client,
            "private-gateway-token",
            "account",
            &target(),
            std::future::pending::<Result<()>>(),
        ),
    )
    .await??;
    assert!(result.is_none());
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 2);
    Ok(())
}

#[tokio::test]
async fn renewal_timeouts_retry_without_extending_last_proven_deadline() -> Result<()> {
    let fixture = Fixture::new(Mode::Hold);
    let (client, _server) = fixture.client().await?;
    let started = time::Instant::now();
    let result = time::timeout(
        Duration::from_secs(12),
        with_claim_lease(
            client,
            "private-gateway-token",
            "account",
            &target(),
            std::future::pending::<Result<()>>(),
        ),
    )
    .await??;
    assert!(result.is_none());
    assert!(started.elapsed() >= Duration::from_secs(10));
    assert!(
        fixture.calls.load(Ordering::SeqCst) >= 3,
        "timed-out renewal must retry before authority expires"
    );
    Ok(())
}

#[tonic::async_trait]
impl supertag_protocol::v2::connector_server::Connector for Fixture {
    async fn accept_event(
        &self,
        _request: tonic::Request<supertag_protocol::v2::AcceptEventRequest>,
    ) -> Result<tonic::Response<supertag_protocol::v2::Task>, tonic::Status> {
        Err(tonic::Status::unimplemented("lease fixture only"))
    }
    async fn accept_slack_event(
        &self,
        _request: tonic::Request<supertag_protocol::v2::AcceptSlackEventRequest>,
    ) -> Result<tonic::Response<supertag_protocol::v2::AcceptSlackEventResponse>, tonic::Status>
    {
        Err(tonic::Status::unimplemented("lease fixture only"))
    }
    async fn accept_github_event(
        &self,
        _request: tonic::Request<supertag_protocol::v2::AcceptGithubEventRequest>,
    ) -> Result<tonic::Response<supertag_protocol::v2::AcceptGithubEventResponse>, tonic::Status>
    {
        Err(tonic::Status::unimplemented("lease fixture only"))
    }
    async fn accept_linear_event(
        &self,
        _request: tonic::Request<supertag_protocol::v2::AcceptLinearEventRequest>,
    ) -> Result<tonic::Response<supertag_protocol::v2::AcceptLinearEventResponse>, tonic::Status>
    {
        Err(tonic::Status::unimplemented("lease fixture only"))
    }
    async fn accept_lark_event(
        &self,
        _request: tonic::Request<supertag_protocol::v2::AcceptLarkEventRequest>,
    ) -> Result<tonic::Response<supertag_protocol::v2::AcceptLarkEventResponse>, tonic::Status>
    {
        Err(tonic::Status::unimplemented("lease fixture only"))
    }
    async fn accept_microsoft_teams_activity(
        &self,
        _request: tonic::Request<supertag_protocol::v2::AcceptMicrosoftTeamsActivityRequest>,
    ) -> Result<
        tonic::Response<supertag_protocol::v2::AcceptMicrosoftTeamsActivityResponse>,
        tonic::Status,
    > {
        Err(tonic::Status::unimplemented("lease fixture only"))
    }
    async fn get_microsoft_teams_reply_route(
        &self,
        _request: tonic::Request<supertag_protocol::v2::GetMicrosoftTeamsReplyRouteRequest>,
    ) -> Result<tonic::Response<supertag_protocol::v2::MicrosoftTeamsReplyRoute>, tonic::Status>
    {
        Err(tonic::Status::unimplemented("lease fixture only"))
    }
    async fn claim_reply(
        &self,
        _request: tonic::Request<supertag_protocol::v2::ClaimReplyRequest>,
    ) -> Result<tonic::Response<supertag_protocol::v2::ClaimReplyResponse>, tonic::Status> {
        Err(tonic::Status::unimplemented("lease fixture only"))
    }
    async fn renew_reply(
        &self,
        request: tonic::Request<RenewReplyRequest>,
    ) -> Result<tonic::Response<ReplyLease>, tonic::Status> {
        assert_eq!(
            request.metadata().get("authorization").unwrap(),
            "Bearer private-gateway-token"
        );
        assert_eq!(
            request
                .metadata()
                .get(supertag_protocol::CONNECTOR_ACCOUNT_HEADER)
                .unwrap(),
            "account"
        );
        assert_eq!(request.get_ref().reply_id, "reply");
        assert_eq!(request.get_ref().lease_token, "lease");
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(code) = self.initial_error {
            return Err(tonic::Status::new(code, "fixture"));
        }
        if call == 0 {
            return Ok(tonic::Response::new(ReplyLease {
                valid_for_ms: 10_000,
            }));
        }
        self.renewal_started.notify_one();
        match self.mode {
            Mode::Transient => {
                if call == 1 {
                    self.provider_progress.notified().await;
                }
                let code = match call {
                    1 => Some(tonic::Code::Unavailable),
                    2 => Some(tonic::Code::Cancelled),
                    3 => Some(tonic::Code::DeadlineExceeded),
                    _ => None,
                };
                if let Some(code) = code {
                    return Err(tonic::Status::new(code, "fixture"));
                }
                self.renewed.notify_one();
                Ok(tonic::Response::new(ReplyLease {
                    valid_for_ms: 10_000,
                }))
            }
            Mode::Revoke => Err(tonic::Status::failed_precondition("expired")),
            Mode::Hold => std::future::pending().await,
        }
    }
    async fn settle_reply(
        &self,
        _request: tonic::Request<supertag_protocol::v2::SettleReplyRequest>,
    ) -> Result<tonic::Response<supertag_protocol::v2::Reply>, tonic::Status> {
        Err(tonic::Status::unimplemented("lease fixture only"))
    }
    async fn claim_connector(
        &self,
        _request: tonic::Request<supertag_protocol::v2::ClaimConnectorRequest>,
    ) -> Result<tonic::Response<supertag_protocol::v2::ConnectorLease>, tonic::Status> {
        Err(tonic::Status::unimplemented("lease fixture only"))
    }
    async fn renew_connector(
        &self,
        _request: tonic::Request<supertag_protocol::v2::RenewConnectorRequest>,
    ) -> Result<tonic::Response<supertag_protocol::v2::ConnectorLease>, tonic::Status> {
        Err(tonic::Status::unimplemented("lease fixture only"))
    }
    async fn release_connector(
        &self,
        _request: tonic::Request<supertag_protocol::v2::ReleaseConnectorRequest>,
    ) -> Result<tonic::Response<supertag_protocol::v2::ReleaseConnectorResponse>, tonic::Status>
    {
        Err(tonic::Status::unimplemented("lease fixture only"))
    }
}
