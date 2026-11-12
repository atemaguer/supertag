use super::*;
use crate::{
    delivery_journal::{Claim, Entry, Outcome},
    github::{Github, GithubConfig},
};
use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use ring::signature::{RSA_PKCS1_2048_8192_SHA256, UnparsedPublicKey};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use supertag_protocol::v2::{Reply, ReplyDestination, ReplyState};
use tokio::net::TcpListener;
use tonic::transport::Endpoint;

// Generated solely for these fixtures. This key is never used with GitHub or another provider.
const KEY: &str = include_str!("fixtures/app-test-key.pem");
const PUBLIC: &[u8] = include_bytes!("fixtures/app-test-public.der");

fn app() -> GithubAuthentication {
    GithubAuthentication::App(GithubAppConfig {
        app_id: 77,
        installation_id: 88,
        private_key_pem: KEY.into(),
    })
}

struct FakeApi {
    requests: AtomicUsize,
    source_read: AtomicBool,
    publication: AtomicBool,
    mints: AtomicUsize,
    posts: AtomicUsize,
    reject: AtomicBool,
    reject_comment: AtomicBool,
    response: Mutex<Value>,
    installation: Mutex<Value>,
    redirect: AtomicBool,
    redirected_requests: AtomicUsize,
    journal: Option<PathBuf>,
    base: Mutex<String>,
}

impl FakeApi {
    fn new(now: i64) -> Self {
        Self {
            requests: AtomicUsize::new(0),
            source_read: AtomicBool::new(false),
            publication: AtomicBool::new(false),
            mints: AtomicUsize::new(0),
            posts: AtomicUsize::new(0),
            reject: AtomicBool::new(false),
            reject_comment: AtomicBool::new(false),
            response: Mutex::new(token_response(now)),
            installation: Mutex::new(
                json!({"id":88,"app_id":77,"account":{"login":"acme"},"suspended_at":null}),
            ),
            redirect: AtomicBool::new(false),
            redirected_requests: AtomicUsize::new(0),
            journal: None,
            base: Mutex::new(String::new()),
        }
    }

    fn check_jwt(&self, headers: &HeaderMap) {
        let jwt = headers["authorization"]
            .to_str()
            .unwrap()
            .strip_prefix("Bearer ")
            .unwrap();
        let parts: Vec<_> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let header: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
        assert_eq!(header, json!({"alg":"RS256","typ":"JWT"}));
        let claims: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["iss"], "77");
        let issued = claims["iat"].as_i64().unwrap();
        let expires = claims["exp"].as_i64().unwrap();
        assert_eq!(expires - issued, 600);
        assert!(issued <= now().unwrap() + 3600);
        let signature = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, PUBLIC)
            .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
            .unwrap();
        if let Some(journal) = &self.journal {
            let value: Value = serde_json::from_slice(&std::fs::read(journal).unwrap()).unwrap();
            assert_eq!(value["entry"]["stage"], "claim");
        }
    }
}

fn token_response(now: i64) -> Value {
    json!({"token":"ghs_fixture-installation-token", "expires_at":DateTime::from_timestamp(now + 3600,0).unwrap().to_rfc3339(),
        "permissions":{"issues":"write","metadata":"read"},"repository_selection":"selected","repositories":[{"id":123,"full_name":"acme/project"}]})
}

async fn installation(State(api): State<Arc<FakeApi>>, headers: HeaderMap) -> Response {
    api.requests.fetch_add(1, Ordering::SeqCst);
    api.check_jwt(&headers);
    if api.redirect.load(Ordering::SeqCst) {
        return (
            StatusCode::FOUND,
            [(
                "location",
                format!("{}redirect-target", api.base.lock().await),
            )],
        )
            .into_response();
    }
    if api.reject.load(Ordering::SeqCst) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    axum::Json(api.installation.lock().await.clone()).into_response()
}

async fn mint(State(api): State<Arc<FakeApi>>, headers: HeaderMap, body: Bytes) -> Response {
    api.mints.fetch_add(1, Ordering::SeqCst);
    api.check_jwt(&headers);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        if api.publication.load(Ordering::SeqCst) {
            json!({"repository_ids":[123],"permissions":{"contents":"write","pull_requests":"write"}})
        } else if api.source_read.load(Ordering::SeqCst) {
            json!({"repository_ids":[123],"permissions":{"contents":"read"}})
        } else {
            json!({"repository_ids":[123],"permissions":{"issues":"write"}})
        }
    );
    (
        StatusCode::CREATED,
        axum::Json(api.response.lock().await.clone()),
    )
        .into_response()
}

async fn comment(State(api): State<Arc<FakeApi>>, headers: HeaderMap) -> Response {
    api.posts.fetch_add(1, Ordering::SeqCst);
    assert_eq!(
        headers["authorization"],
        "Bearer ghs_fixture-installation-token"
    );
    if api.reject_comment.load(Ordering::SeqCst) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if let Some(journal) = &api.journal {
        let bytes = std::fs::read(journal).unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["entry"]["stage"], "sending");
        assert!(!String::from_utf8_lossy(&bytes).contains("ghs_fixture"));
    }
    (StatusCode::CREATED, axum::Json(json!({"id":987,"issue_url":format!("{}repos/acme/project/issues/7",api.base.lock().await)}))).into_response()
}

async fn serve(api: Arc<FakeApi>) -> Result<(Url, tokio::task::JoinHandle<()>)> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}/", listener.local_addr()?);
    *api.base.lock().await = base.clone();
    let app = Router::new()
        .route("/repos/acme/project/installation", get(installation))
        .route("/app/installations/88/access_tokens", post(mint))
        .route("/repos/acme/project/issues/7/comments", post(comment))
        .route(
            "/redirect-target",
            get(|State(api): State<Arc<FakeApi>>| async move {
                api.redirected_requests.fetch_add(1, Ordering::SeqCst);
                StatusCode::OK
            }),
        )
        .with_state(api);
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Ok((base.parse()?, task))
}

fn client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(2))
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .build()
        .unwrap()
}

#[tokio::test]
async fn signs_bounded_app_jwt_and_reuses_only_scoped_unexpired_tokens() -> Result<()> {
    let now = now()?;
    let api = Arc::new(FakeApi::new(now));
    let (base, task) = serve(api.clone()).await?;
    let auth = Authentication::new(&app(), 123, "acme/project")?;
    let client = client();
    assert_eq!(
        auth.access_token_at(&client, &base, now).await?.expose(),
        "ghs_fixture-installation-token"
    );
    auth.access_token_at(&client, &base, now + 300).await?;
    assert_eq!(api.mints.load(Ordering::SeqCst), 1);
    *api.response.lock().await = token_response(now + 3550);
    auth.access_token_at(&client, &base, now + 3550).await?;
    assert_eq!(api.mints.load(Ordering::SeqCst), 2);
    auth.invalidate().await;
    auth.access_token_at(&client, &base, now + 3550).await?;
    assert_eq!(api.mints.load(Ordering::SeqCst), 3);
    // Neither another configured account nor another API origin can borrow this cache.
    let second = Authentication::new(&app(), 123, "acme/project")?;
    second.access_token_at(&client, &base, now + 3550).await?;
    assert_eq!(api.mints.load(Ordering::SeqCst), 4);
    let other = Arc::new(FakeApi::new(now + 3550));
    let (other_base, other_task) = serve(other.clone()).await?;
    auth.access_token_at(&client, &other_base, now + 3550)
        .await?;
    assert_eq!(other.mints.load(Ordering::SeqCst), 1);
    other_task.abort();
    task.abort();
    Ok(())
}

#[tokio::test]
async fn refuses_redirects_installation_rebinding_and_excess_token_scope() -> Result<()> {
    let current = now()?;
    let api = Arc::new(FakeApi::new(current));
    let (base, task) = serve(api.clone()).await?;
    let auth = Authentication::new(&app(), 123, "acme/project")?;
    let client = client();
    api.redirect.store(true, Ordering::SeqCst);
    assert!(auth.access_token(&client, &base).await.is_err());
    assert_eq!(api.mints.load(Ordering::SeqCst), 0);
    assert_eq!(api.redirected_requests.load(Ordering::SeqCst), 0);
    api.redirect.store(false, Ordering::SeqCst);
    api.installation.lock().await["id"] = json!(99);
    assert!(auth.access_token(&client, &base).await.is_err());
    assert_eq!(api.mints.load(Ordering::SeqCst), 0);
    api.installation.lock().await["id"] = json!(88);
    for replacement in [
        json!({"permissions":{"issues":"write","contents":"write"}}),
        json!({"repositories":[{"id":124,"full_name":"acme/project"}]}),
        json!({"repositories":[{"id":123,"full_name":"another/project"}]}),
        json!({"repository_selection":"all"}),
        json!({"expires_at":"2000-01-01T00:00:00Z"}),
        json!({"token":"unsafe\r\ntoken"}),
    ] {
        let mut value = token_response(current);
        for (key, val) in replacement.as_object().unwrap() {
            value[key] = val.clone();
        }
        *api.response.lock().await = value;
        assert!(auth.access_token(&client, &base).await.is_err());
    }
    let mut large = token_response(current);
    large["padding"] = json!("x".repeat(MAX_RESPONSE_BYTES));
    *api.response.lock().await = large;
    assert!(auth.access_token(&client, &base).await.is_err());
    task.abort();
    Ok(())
}

fn config(directory: &Path) -> GithubConfig {
    GithubConfig {
        account_id: "app-account".into(),
        repository_id: 123,
        repository: "acme/project".into(),
        tag_id: "builder".into(),
        allowed_users: vec![42],
        webhook_secret: "fixture-webhook-secret".into(),
        authentication: app(),
        state_directory: directory.join("github"),
    }
}

#[tokio::test]
async fn acquires_before_sending_and_never_persists_installation_credentials() -> Result<()> {
    let temporary = tempfile::tempdir()?;
    let (lease_channel, lease_server) = lease_fixture().await?;
    let configuration = config(temporary.path());
    let journal = configuration.state_directory.join("reply.json");
    let api = Arc::new(FakeApi {
        journal: Some(journal.clone()),
        ..FakeApi::new(now()?)
    });
    let (base, task) = serve(api.clone()).await?;
    let connector = Github::new(
        configuration,
        lease_channel.clone(),
        "private-gateway-token".into(),
    )?
    .with_test_api_url(base.as_str())?;
    connector.0.journal.save(&Entry::Claim {
        operation_id: "stable-claim".into(),
    })?;
    let reply = Reply {
        reply_id: "reply".into(),
        task_id: "task".into(),
        account_id: "github/app-account".into(),
        destination: Some(ReplyDestination {
            conversation_id: "acme/project".into(),
            thread_id: Some("7".into()),
        }),
        text: "Review ready".into(),
        state: ReplyState::Claimed.into(),
        provider_receipt: None,
    };
    let target = Claim {
        reply_id: "reply".into(),
        lease_token: "lease".into(),
    };
    api.reject.store(true, Ordering::SeqCst);
    assert!(
        !connector
            .0
            .send_claimed_reply(&reply, target.clone())
            .await?
    );
    assert!(
        matches!(connector.0.journal.load()?, Some(Entry::Claim { operation_id }) if operation_id == "stable-claim")
    );
    assert_eq!(api.posts.load(Ordering::SeqCst), 0);
    // A restart in Claim safely reacquires a token and sends only once.
    drop(connector);
    api.reject.store(false, Ordering::SeqCst);
    let connector = Github::new(
        config(temporary.path()),
        lease_channel.clone(),
        "private-gateway-token".into(),
    )?
    .with_test_api_url(base.as_str())?;
    assert!(
        connector
            .0
            .send_claimed_reply(&reply, target.clone())
            .await?
    );
    assert!(
        matches!(connector.0.journal.load()?, Some(Entry::Settle { outcome: Outcome::Delivered { provider_receipt }, .. }) if provider_receipt == "987")
    );
    let disk = std::fs::read_to_string(journal)?;
    assert!(
        !disk.contains("ghs_fixture") && !disk.contains("PRIVATE KEY") && !disk.contains("eyJ")
    );
    assert_eq!(api.posts.load(Ordering::SeqCst), 1);
    // A definitive 401 invalidates the cache for future replies but does not retry the write.
    api.reject_comment.store(true, Ordering::SeqCst);
    connector.0.journal.save(&Entry::Claim {
        operation_id: "next-claim".into(),
    })?;
    assert!(
        connector
            .0
            .send_claimed_reply(&reply, target.clone())
            .await?
    );
    assert!(matches!(
        connector.0.journal.load()?,
        Some(Entry::Settle {
            outcome: Outcome::Failed,
            ..
        })
    ));
    assert_eq!(api.posts.load(Ordering::SeqCst), 2);
    assert_eq!(api.mints.load(Ordering::SeqCst), 1);
    api.reject_comment.store(false, Ordering::SeqCst);
    connector.0.journal.save(&Entry::Claim {
        operation_id: "third-claim".into(),
    })?;
    assert!(connector.0.send_claimed_reply(&reply, target).await?);
    assert_eq!(api.mints.load(Ordering::SeqCst), 2);
    task.abort();
    lease_server.abort();
    Ok(())
}

#[test]
fn rejects_invalid_credentials_and_requires_matching_webhook_installation() -> Result<()> {
    for token in ["", "a b", "bad\ntoken"] {
        assert!(
            Authentication::new(
                &GithubAuthentication::Token(token.into()),
                123,
                "acme/project"
            )
            .is_err()
        );
    }
    for (app_id, installation_id) in [(0, 88), (77, 0), (u64::MAX, 88)] {
        assert!(
            Authentication::new(
                &GithubAuthentication::App(GithubAppConfig {
                    app_id,
                    installation_id,
                    private_key_pem: KEY.into()
                }),
                123,
                "acme/project"
            )
            .is_err()
        );
    }
    assert!(
        Authentication::new(
            &GithubAuthentication::App(GithubAppConfig {
                app_id: 77,
                installation_id: 88,
                private_key_pem: "not a private key".into(),
            }),
            123,
            "acme/project"
        )
        .is_err()
    );
    let configuration = config(Path::new("unused"));
    let mut value = json!({"action":"created","sender":{"id":42,"type":"User"},"repository":{"id":123,"full_name":"acme/project"},"issue":{"number":7,"pull_request":{}},"comment":{"id":456,"body":"@supertag review this"}});
    assert_eq!(
        crate::github::normalize(
            &configuration,
            "delivery",
            "issue_comment",
            &serde_json::to_vec(&value)?
        )
        .unwrap_err(),
        StatusCode::FORBIDDEN
    );
    value["installation"] = json!({"id":99});
    assert_eq!(
        crate::github::normalize(
            &configuration,
            "delivery",
            "issue_comment",
            &serde_json::to_vec(&value)?
        )
        .unwrap_err(),
        StatusCode::FORBIDDEN
    );
    value["installation"] = json!({"id":88});
    assert!(
        crate::github::normalize(
            &configuration,
            "delivery",
            "issue_comment",
            &serde_json::to_vec(&value)?
        )
        .unwrap()
        .unwrap()
        .is_pull_request
    );
    Ok(())
}

struct LeaseFixture;
#[tonic::async_trait]
impl supertag_protocol::v2::connector_server::Connector for LeaseFixture {
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
        request: tonic::Request<supertag_protocol::v2::RenewReplyRequest>,
    ) -> Result<tonic::Response<supertag_protocol::v2::ReplyLease>, tonic::Status> {
        assert_eq!(
            request.metadata().get("authorization").unwrap(),
            "Bearer private-gateway-token"
        );
        assert_eq!(request.get_ref().reply_id, "reply");
        assert_eq!(request.get_ref().lease_token, "lease");
        Ok(tonic::Response::new(supertag_protocol::v2::ReplyLease {
            valid_for_ms: 30_000,
        }))
    }
    async fn settle_reply(
        &self,
        _request: tonic::Request<supertag_protocol::v2::SettleReplyRequest>,
    ) -> Result<tonic::Response<supertag_protocol::v2::Reply>, tonic::Status> {
        Err(tonic::Status::unimplemented("lease fixture only"))
    }
}

async fn lease_fixture() -> Result<(tonic::transport::Channel, tokio::task::JoinHandle<()>)> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let server = tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(
                supertag_protocol::v2::connector_server::ConnectorServer::new(LeaseFixture),
            )
            .serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(listener))
            .await
            .unwrap();
    });
    Ok((
        Endpoint::from_shared(format!("http://{address}"))?
            .connect()
            .await?,
        server,
    ))
}

#[tokio::test]
async fn source_read_token_is_scoped_and_never_reuses_comment_authority() -> Result<()> {
    let api = Arc::new(FakeApi::new(now()?));
    api.source_read.store(true, Ordering::SeqCst);
    api.response.lock().await["permissions"] = json!({"contents":"read","metadata":"read"});
    let (url, server) = serve(api.clone()).await?;
    let auth = Authentication::source_reader(&app(), 123, "acme/project")?;
    let client = client();
    assert_eq!(
        auth.access_token(&client, &url).await?.expose(),
        "ghs_fixture-installation-token"
    );
    auth.access_token(&client, &url).await?;
    assert_eq!(api.mints.load(Ordering::SeqCst), 1);
    auth.invalidate().await;
    api.response.lock().await["permissions"] = json!({"contents":"write","metadata":"read"});
    assert!(auth.access_token(&client, &url).await.is_err());
    api.response.lock().await["permissions"] = json!({"issues":"write","metadata":"read"});
    assert!(auth.access_token(&client, &url).await.is_err());
    server.abort();
    Ok(())
}

#[tokio::test]
async fn publication_token_has_exact_repository_and_write_permissions() -> Result<()> {
    let timestamp = now()?;
    let api = Arc::new(FakeApi::new(timestamp));
    api.publication.store(true, Ordering::SeqCst);
    api.response.lock().await["permissions"] =
        json!({"contents":"write","pull_requests":"write","metadata":"read"});
    let (url, server) = serve(api.clone()).await?;
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()?;
    let auth = Authentication::publisher(&app(), 123, "acme/project")?;
    auth.access_token(&client, &url).await?;
    auth.access_token(&client, &url).await?;
    assert_eq!(api.mints.load(Ordering::SeqCst), 1);
    auth.invalidate().await;
    api.response.lock().await["permissions"]["issues"] = "write".into();
    assert!(auth.access_token(&client, &url).await.is_err());
    server.abort();
    Ok(())
}
