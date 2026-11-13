//! Hard-crash cases for GitHub, Linear, Lark, and Microsoft Teams reply delivery.
//!
//! Each case admits one provider event through the Control Plane's connector API,
//! lets a Worker Host finish the Task, and kills the Gateway with `SIGKILL` at one
//! durable boundary of the provider's reply delivery: after the reply claim, after
//! journaling the send intent, after the provider answered, after journaling the
//! outcome, and after the Control Plane settled it. The Gateway restarts on the
//! same delivery journal. The provider receives the reply at most once, and the
//! reply ends delivered with the provider's receipt, or visibly uncertain when the
//! restarted Gateway cannot prove what the provider received.
use futures_util::{SinkExt, StreamExt};
use prost::Message as _;
use serde_json::json;
use supertag_gateway::lark::wire::{Frame, Header};
use supertag_protocol::v2::{
    AcceptGithubEventRequest, AcceptLarkEventRequest, AcceptLinearEventRequest,
    AcceptMicrosoftTeamsActivityRequest, GithubEventAction, GithubEventKind, LarkDomain,
    LinearEventAction, LinearEventKind, connector_client::ConnectorClient,
};
use tokio_tungstenite::{accept_async, tungstenite::Message as WsMessage};

use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Provider {
    Github,
    Linear,
    Lark,
    MicrosoftTeams,
}

/// How a crashed delivery must settle after the Gateway restarts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Settles {
    /// Delivered with the provider's receipt after exactly one provider post.
    Delivered,
    /// Uncertain after this many provider posts; never resent.
    Uncertain { posts: usize },
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct DeliveryCase {
    pub(crate) provider: Provider,
    pub(crate) boundary: &'static str,
    pub(crate) settles: Settles,
}

pub(crate) const fn delivery(
    provider: Provider,
    boundary: &'static str,
    settles: Settles,
) -> DeliveryCase {
    DeliveryCase {
        provider,
        boundary,
        settles,
    }
}

const TAG_ID: &str = "builder";
const GITHUB_ACCOUNT: &str = "github-crash-test";
const GITHUB_REPOSITORY: &str = "acme/project";
const GITHUB_TOKEN: &str = "synthetic-github-api-token";
const GITHUB_RECEIPT: &str = "12345";
const LINEAR_ACCOUNT: &str = "linear-crash-test";
const LINEAR_WORKSPACE: &str = "11111111-1111-4111-8111-111111111111";
const LINEAR_TEAM: &str = "22222222-2222-4222-8222-222222222222";
const LINEAR_ISSUE: &str = "33333333-3333-4333-8333-333333333333";
const LINEAR_COMMENT: &str = "44444444-4444-4444-8444-444444444444";
const LINEAR_USER: &str = "55555555-5555-4555-8555-555555555555";
const LINEAR_RECEIPT: &str = "66666666-6666-4666-8666-666666666666";
const LINEAR_TOKEN: &str = "synthetic-linear-api-token";
const LARK_ACCOUNT: &str = "lark-crash-test";
const LARK_APP: &str = "cli_0123456789abcdef";
const LARK_SECRET: &str = "synthetic-app-secret";
const LARK_CHAT: &str = "oc_engineering";
const LARK_ROOT: &str = "om_root";
const LARK_TOKEN: &str = "synthetic-lark-tenant-token";
const LARK_RECEIPT: &str = "om_receipt";
const TEAMS_ACCOUNT: &str = "microsoft-teams-crash-test";
const TEAMS_APP: &str = "11111111-1111-4111-8111-111111111111";
const TEAMS_TENANT: &str = "22222222-2222-4222-8222-222222222222";
const TEAMS_TEAM: &str = "33333333-3333-4333-8333-333333333333";
const TEAMS_USER: &str = "44444444-4444-4444-8444-444444444444";
const TEAMS_CHANNEL: &str = "19:channel@thread.tacv2";
const TEAMS_CONVERSATION: &str = "19:conversation@thread.tacv2";
const TEAMS_ROOT: &str = "1741000000000";
const TEAMS_SECRET: &str = "synthetic-microsoft-client-secret";
const TEAMS_TOKEN: &str = "synthetic-microsoft-bot-token";
const TEAMS_RECEIPT: &str = "1741000000099";

impl Provider {
    fn scope(self) -> &'static str {
        match self {
            Self::Github => "gateway.github-reply",
            Self::Linear => "gateway.linear-reply",
            Self::Lark => "gateway.lark-reply",
            Self::MicrosoftTeams => "gateway.microsoft-teams-reply",
        }
    }

    fn principal(self) -> String {
        match self {
            Self::Github => format!("connector:github/{GITHUB_ACCOUNT}"),
            Self::Linear => format!("connector:linear/{LINEAR_ACCOUNT}"),
            Self::Lark => format!("connector:lark/{LARK_ACCOUNT}"),
            Self::MicrosoftTeams => format!("connector:teams/{TEAMS_ACCOUNT}"),
        }
    }

    fn receipt(self) -> &'static str {
        match self {
            Self::Github => GITHUB_RECEIPT,
            Self::Linear => LINEAR_RECEIPT,
            Self::Lark => LARK_RECEIPT,
            Self::MicrosoftTeams => TEAMS_RECEIPT,
        }
    }

    /// Lark ingress is an outbound WebSocket, so its Gateway reports no webhook listener.
    fn endpoints(self) -> usize {
        if self == Self::Lark { 1 } else { 2 }
    }

    fn gateway(
        self,
        credentials: &Credentials,
        directory: &Path,
        private: SocketAddr,
        mock: &ProviderMock,
        crash: Option<(&str, &Path)>,
    ) -> Result<Process> {
        let mut command = credentials.command();
        command
            .args(["gateway", "--listen", "127.0.0.1:0", "--control-plane"])
            .arg(format!("http://{private}"));
        let state = directory.join("provider-state");
        let origin = &mock.origin;
        match self {
            Self::Github => {
                command
                    .args(["--github-listen", "127.0.0.1:0", "--github-state-directory"])
                    .arg(&state)
                    .env("SUPERTAG_GITHUB_ACCOUNT_ID", GITHUB_ACCOUNT)
                    .env("SUPERTAG_GITHUB_REPOSITORY_ID", "123")
                    .env("SUPERTAG_GITHUB_REPOSITORY", GITHUB_REPOSITORY)
                    .env("SUPERTAG_GITHUB_TAG_ID", TAG_ID)
                    .env("SUPERTAG_GITHUB_ALLOWED_USERS", "42")
                    .env("SUPERTAG_GITHUB_WEBHOOK_SECRET", "synthetic-github-secret")
                    .env("SUPERTAG_GITHUB_TOKEN", GITHUB_TOKEN)
                    .env("SUPERTAG_TEST_GITHUB_API_URL", origin);
            }
            Self::Linear => {
                command
                    .args(["--linear-listen", "127.0.0.1:0", "--linear-state-directory"])
                    .arg(&state)
                    .env("SUPERTAG_LINEAR_ACCOUNT_ID", LINEAR_ACCOUNT)
                    .env("SUPERTAG_LINEAR_WORKSPACE_ID", LINEAR_WORKSPACE)
                    .env("SUPERTAG_LINEAR_TEAM_ID", LINEAR_TEAM)
                    .env("SUPERTAG_LINEAR_TAG_ID", TAG_ID)
                    .env("SUPERTAG_LINEAR_ALLOWED_USERS", LINEAR_USER)
                    .env("SUPERTAG_LINEAR_WEBHOOK_SECRET", "synthetic-linear-secret")
                    .env("SUPERTAG_LINEAR_API_KEY", LINEAR_TOKEN)
                    .env("SUPERTAG_TEST_LINEAR_API_URL", format!("{origin}graphql"));
            }
            Self::Lark => {
                command
                    .arg("--lark-state-directory")
                    .arg(&state)
                    .env("SUPERTAG_LARK_ACCOUNT_ID", LARK_ACCOUNT)
                    .env("SUPERTAG_LARK_DOMAIN", "lark")
                    .env("SUPERTAG_LARK_APP_ID", LARK_APP)
                    .env("SUPERTAG_LARK_APP_SECRET", LARK_SECRET)
                    .env("SUPERTAG_LARK_TENANT_KEY", "tenant-one")
                    .env("SUPERTAG_LARK_BOT_OPEN_ID", "ou_bot")
                    .env("SUPERTAG_LARK_CHAT_ID", LARK_CHAT)
                    .env("SUPERTAG_LARK_TAG_ID", TAG_ID)
                    .env("SUPERTAG_LARK_ALLOWED_USERS", "ou_alice")
                    .env("SUPERTAG_TEST_LARK_ORIGIN", origin);
            }
            Self::MicrosoftTeams => {
                command
                    .args([
                        "--microsoft-teams-listen",
                        "127.0.0.1:0",
                        "--microsoft-teams-state-directory",
                    ])
                    .arg(&state)
                    .env("SUPERTAG_MICROSOFT_TEAMS_ACCOUNT_ID", TEAMS_ACCOUNT)
                    .env("SUPERTAG_MICROSOFT_TEAMS_APP_ID", TEAMS_APP)
                    .env("SUPERTAG_MICROSOFT_TEAMS_APP_SECRET", TEAMS_SECRET)
                    .env("SUPERTAG_MICROSOFT_TEAMS_TENANT_ID", TEAMS_TENANT)
                    .env("SUPERTAG_MICROSOFT_TEAMS_TEAM_ID", TEAMS_TEAM)
                    .env("SUPERTAG_MICROSOFT_TEAMS_CHANNEL_ID", TEAMS_CHANNEL)
                    .env("SUPERTAG_MICROSOFT_TEAMS_TAG_ID", TAG_ID)
                    .env("SUPERTAG_MICROSOFT_TEAMS_ALLOWED_USERS", TEAMS_USER)
                    .env("SUPERTAG_TEST_MICROSOFT_TEAMS_ORIGIN", origin);
            }
        }
        if let Some((point, marker)) = crash {
            command
                .env(CRASH_POINT_ENV, point)
                .env(CRASH_MARKER_ENV, marker);
        }
        Process::spawn(command, directory, "provider-gateway", true)
    }

    /// Admits one provider event exactly as the Gateway's ingress would.
    async fn admit(self, private: SocketAddr, credentials: &Credentials) -> Result<Task> {
        let mut client = ConnectorClient::new(protocol::dial(format!("http://{private}")).await?);
        let (token, principal) = (credentials.gateway.as_str(), self.principal());
        let task = match self {
            Self::Github => {
                client
                    .accept_github_event(connector_request(
                        AcceptGithubEventRequest {
                            account_id: format!("github/{GITHUB_ACCOUNT}"),
                            delivery_id: "github-crash-delivery".into(),
                            repository_id: 123,
                            repository: GITHUB_REPOSITORY.into(),
                            number: 7,
                            source_id: 9001,
                            kind: GithubEventKind::IssueComment.into(),
                            action: GithubEventAction::Created.into(),
                            prompt: "inspect the crash fixture".into(),
                            tag_id: TAG_ID.into(),
                            is_pull_request: false,
                        },
                        token,
                        &principal,
                    )?)
                    .await?
                    .into_inner()
                    .task
            }
            Self::Linear => {
                client
                    .accept_linear_event(connector_request(
                        AcceptLinearEventRequest {
                            account_id: format!("linear/{LINEAR_ACCOUNT}"),
                            delivery_id: "linear-crash-delivery".into(),
                            workspace_id: LINEAR_WORKSPACE.into(),
                            team_id: LINEAR_TEAM.into(),
                            issue_id: LINEAR_ISSUE.into(),
                            source_id: LINEAR_COMMENT.into(),
                            kind: LinearEventKind::IssueComment.into(),
                            action: LinearEventAction::Create.into(),
                            prompt: "inspect the crash fixture".into(),
                            tag_id: TAG_ID.into(),
                        },
                        token,
                        &principal,
                    )?)
                    .await?
                    .into_inner()
                    .task
            }
            Self::Lark => {
                client
                    .accept_lark_event(connector_request(
                        AcceptLarkEventRequest {
                            account_id: format!("lark/{LARK_ACCOUNT}"),
                            domain: LarkDomain::Lark.into(),
                            app_id: LARK_APP.into(),
                            tenant_key: "tenant-one".into(),
                            event_id: "lark-crash-event".into(),
                            chat_id: LARK_CHAT.into(),
                            message_id: "om_message".into(),
                            root_message_id: LARK_ROOT.into(),
                            actor_id: "ou_alice".into(),
                            prompt: "inspect the crash fixture".into(),
                            mention_tag_id: Some(TAG_ID.into()),
                            direct: false,
                        },
                        token,
                        &principal,
                    )?)
                    .await?
                    .into_inner()
                    .task
            }
            Self::MicrosoftTeams => {
                client
                    .accept_microsoft_teams_activity(connector_request(
                        AcceptMicrosoftTeamsActivityRequest {
                            account_id: format!("teams/{TEAMS_ACCOUNT}"),
                            app_id: TEAMS_APP.into(),
                            tenant_id: TEAMS_TENANT.into(),
                            team_id: TEAMS_TEAM.into(),
                            channel_id: TEAMS_CHANNEL.into(),
                            conversation_id: TEAMS_CONVERSATION.into(),
                            activity_id: "1741000000001".into(),
                            root_activity_id: TEAMS_ROOT.into(),
                            actor_id: TEAMS_USER.into(),
                            service_url: "https://smba.trafficmanager.net/amer/".into(),
                            prompt: "inspect the crash fixture".into(),
                            tag_id: TAG_ID.into(),
                        },
                        token,
                        &principal,
                    )?)
                    .await?
                    .into_inner()
                    .task
            }
        };
        task.context("provider event was not accepted")
    }
}

fn connector_request<T>(message: T, token: &str, principal: &str) -> Result<Request<T>> {
    let mut request = authenticated_request(message, token, Some(principal))?;
    request.set_timeout(Duration::from_secs(3));
    Ok(request)
}

/// One loopback HTTP server standing in for a provider API. It answers the
/// credential and lookup calls each connector makes and counts reply posts.
pub(crate) struct ProviderMock {
    origin: String,
    posts: Arc<Mutex<usize>>,
    server: tokio::task::JoinHandle<Result<()>>,
}

impl ProviderMock {
    async fn start(provider: Provider) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let origin = format!("http://{address}/");
        let posts = Arc::new(Mutex::new(0));
        let counted = posts.clone();
        let base = origin.clone();
        let server = tokio::spawn(async move {
            let mut children = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let (stream, _) = accepted?;
                        let (counted, base) = (counted.clone(), base.clone());
                        children.spawn(async move {
                            serve_provider(provider, stream, address, &base, &counted).await
                        });
                    }
                    joined = children.join_next(), if !children.is_empty() => {
                        joined.context("provider fixture task missing")???;
                    }
                }
            }
        });
        Ok(Self {
            origin,
            posts,
            server,
        })
    }

    async fn posts(&self) -> Result<usize> {
        ensure!(
            !self.server.is_finished(),
            "provider fixture refused a request"
        );
        Ok(*self.posts.lock().await)
    }
}

impl Drop for ProviderMock {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn serve_provider(
    provider: Provider,
    mut stream: TcpStream,
    address: SocketAddr,
    base: &str,
    posts: &Mutex<usize>,
) -> Result<()> {
    // A Gateway killed mid-request leaves a partial request behind; only an
    // unexpected request fails the fixture.
    let mut peek = [0; 16];
    let Ok(Ok(count)) = tokio::time::timeout(Duration::from_secs(5), stream.peek(&mut peek)).await
    else {
        return Ok(());
    };
    if provider == Provider::Lark && peek[..count].starts_with(b"GET /ws?") {
        // Lark ingress: keep the WebSocket open and answer its pings.
        let mut socket = accept_async(stream).await?;
        while let Some(Ok(message)) = socket.next().await {
            let WsMessage::Binary(bytes) = message else {
                continue;
            };
            let frame = Frame::decode(bytes)?;
            if frame.header("type")? == "ping" {
                let pong = Frame {
                    service: 17,
                    headers: vec![Header {
                        key: "type".into(),
                        value: "pong".into(),
                    }],
                    payload: Some(
                        json!({"PingInterval":1,"ReconnectCount":-1,"ReconnectInterval":1,"ReconnectNonce":0})
                            .to_string()
                            .into_bytes(),
                    ),
                    ..Default::default()
                };
                socket
                    .send(WsMessage::Binary(pong.encode_to_vec().into()))
                    .await?;
            }
        }
        return Ok(());
    }
    let Ok((start, body)) = read_provider_request(&mut stream).await else {
        return Ok(());
    };
    let (status, reply) = match (provider, start.as_str()) {
        (Provider::Github, "POST /repos/acme/project/issues/7/comments") => (
            "201 Created",
            Some(
                json!({"id":12345,"issue_url":format!("{base}repos/{GITHUB_REPOSITORY}/issues/7")}),
            ),
        ),
        (Provider::Linear, "POST /graphql") => {
            let query = body["query"].as_str().unwrap_or_default();
            if query.starts_with("mutation SuperTagLinearReply") {
                ensure!(body["variables"]["input"]["issueId"] == LINEAR_ISSUE);
                (
                    "200 OK",
                    Some(
                        json!({"data":{"commentCreate":{"success":true,"comment":{"id":LINEAR_RECEIPT,"issue":{"id":LINEAR_ISSUE}}}}}),
                    ),
                )
            } else {
                ensure!(query.starts_with("query SuperTagLinearIssue"));
                return respond(
                    &mut stream,
                    "200 OK",
                    &json!({"data":{"issue":{"id":LINEAR_ISSUE,"team":{"id":LINEAR_TEAM}}}}),
                )
                .await;
            }
        }
        (Provider::Lark, "POST /callback/ws/endpoint") => {
            return respond(
                &mut stream,
                "200 OK",
                &json!({"code":0,"data":{"URL":format!("ws://{address}/ws?service_id=17&device_id=fixture"),"ClientConfig":{"PingInterval":1,"ReconnectCount":-1,"ReconnectInterval":1,"ReconnectNonce":0}}}),
            )
            .await;
        }
        (Provider::Lark, "POST /open-apis/auth/v3/tenant_access_token/internal") => {
            return respond(
                &mut stream,
                "200 OK",
                &json!({"code":0,"tenant_access_token":LARK_TOKEN,"expire":7200}),
            )
            .await;
        }
        (Provider::Lark, "GET /open-apis/bot/v3/info") => {
            return respond(
                &mut stream,
                "200 OK",
                &json!({"code":0,"bot":{"open_id":"ou_bot","app_name":"Fixture"}}),
            )
            .await;
        }
        (Provider::Lark, "POST /open-apis/im/v1/messages/om_root/reply") => (
            "200 OK",
            Some(
                json!({"code":0,"data":{"message_id":LARK_RECEIPT,"chat_id":LARK_CHAT,"root_id":LARK_ROOT}}),
            ),
        ),
        (Provider::MicrosoftTeams, start)
            if start == format!("POST /{TEAMS_TENANT}/oauth2/v2.0/token") =>
        {
            return respond(
                &mut stream,
                "200 OK",
                &json!({"access_token":TEAMS_TOKEN,"token_type":"Bearer","expires_in":3600}),
            )
            .await;
        }
        (Provider::MicrosoftTeams, start)
            if start.starts_with("POST /amer/v3/conversations/")
                && start.ends_with("/activities") =>
        {
            ("200 OK", Some(json!({"id":TEAMS_RECEIPT})))
        }
        (Provider::MicrosoftTeams, "GET /v1/.well-known/openidconfiguration") => {
            return respond(
                &mut stream,
                "200 OK",
                &json!({"issuer":"https://api.botframework.com","id_token_signing_alg_values_supported":["RS256"],"jwks_uri":format!("{base}v1/.well-known/keys")}),
            )
            .await;
        }
        (Provider::MicrosoftTeams, "GET /v1/.well-known/keys") => {
            return respond(&mut stream, "200 OK", &json!({"keys":[]})).await;
        }
        _ => anyhow::bail!("unexpected {provider:?} request {start}"),
    };
    // Count the post when it is received: a Gateway killed after the provider accepted
    // it may never read this answer, and that does not undo the provider write.
    *posts.lock().await += 1;
    let reply = reply.expect("reply posts answer");
    let _ = respond(&mut stream, status, &reply).await;
    Ok(())
}

async fn respond(stream: &mut TcpStream, status: &str, body: &Value) -> Result<()> {
    let body = body.to_string();
    stream
        .write_all(
            format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await?;
    let _ = stream.shutdown().await;
    Ok(())
}

/// Reads one request; returns "METHOD /path" and the JSON body, if any.
async fn read_provider_request(stream: &mut TcpStream) -> Result<(String, Value)> {
    let mut bytes = Vec::new();
    let mut buffer = [0; 4096];
    let end = loop {
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
        ensure!(bytes.len() < 16_384, "fixture HTTP headers too large");
        let count = stream.read(&mut buffer).await?;
        ensure!(count > 0, "fixture HTTP headers ended early");
        bytes.extend_from_slice(&buffer[..count]);
    };
    let headers = std::str::from_utf8(&bytes[..end])?.to_owned();
    let mut start = headers
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace();
    let method = start.next().unwrap_or_default().to_owned();
    let path = start.next().unwrap_or_default();
    let path = path.split('?').next().unwrap_or_default().to_owned();
    let length: usize = headers
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
        .map(|(_, value)| value.trim().parse())
        .transpose()?
        .unwrap_or(0);
    ensure!(length <= 262_144, "fixture HTTP body too large");
    while bytes.len() < end + length {
        let count = stream.read(&mut buffer).await?;
        ensure!(count > 0, "fixture HTTP body ended early");
        bytes.extend_from_slice(&buffer[..count]);
    }
    let body = serde_json::from_slice(&bytes[end..end + length]).unwrap_or(Value::Null);
    Ok((format!("{method} {path}"), body))
}

pub(crate) async fn exercise_delivery(
    case: DeliveryCase,
    database: &str,
    directory: &Path,
) -> Result<()> {
    let credentials = Credentials::new();
    let mock = ProviderMock::start(case.provider).await?;
    let marker = directory.join("crash-marker");
    let point = format!("{}.{}", case.provider.scope(), case.boundary);
    let unbound: SocketAddr = "127.0.0.1:0".parse()?;
    let mut control_plane = spawn_control_plane(&credentials, database, directory, unbound, None)?;
    let private = control_plane.endpoints(1).await?[0];
    let mut gateway = case.provider.gateway(
        &credentials,
        directory,
        private,
        &mock,
        Some((&point, &marker)),
    )?;
    let public = gateway.endpoints(case.provider.endpoints()).await?[0];

    let mut operator = OperatorClient::new(protocol::dial(format!("http://{public}")).await?);
    operator
        .put_tag(credentials.request(PutTagRequest {
            tag_id: TAG_ID.into(),
            instructions: INSTRUCTIONS.into(),
            allowed_actions: vec!["files:read".into()],
            ..Default::default()
        })?)
        .await?;
    let task = case.provider.admit(private, &credentials).await?;

    // The Task finishes on a host that the crash never touches.
    let mut host = credentials.command();
    host.args(["worker-host", "--gateway", &format!("http://{public}")])
        .args(["--adapter", ADAPTER, "--once", "--state-directory"])
        .arg(directory.join("host"));
    let status = Process::spawn(host, directory, "provider-host", false)?
        .exited()
        .await?;
    ensure!(status.success(), "Worker Host failed with {status}");

    // The Gateway kills itself at the selected delivery boundary.
    let status = gateway.exited().await?;
    ensure!(
        status.signal() == Some(libc::SIGKILL),
        "Gateway exited with {status} instead of crashing at {point}: {}",
        gateway.logs()
    );
    ensure!(
        std::fs::read_to_string(&marker)? == point,
        "Gateway crashed somewhere other than {point}"
    );
    let posted_before_restart = mock.posts().await?;
    drop(gateway);

    // Restart only the Gateway, on the same delivery journal.
    let mut gateway = case
        .provider
        .gateway(&credentials, directory, private, &mock, None)?;
    let public = gateway.endpoints(case.provider.endpoints()).await?[0];
    let mut operator = OperatorClient::new(protocol::dial(format!("http://{public}")).await?);
    let deadline = Instant::now() + WAIT;
    let reply = loop {
        let reply = operator
            .list_reply_deliveries(credentials.request(ListReplyDeliveriesRequest {
                account_id: case.provider.principal().replacen("connector:", "", 1),
                state: 0,
                limit: 10,
                before_order: 0,
            })?)
            .await?
            .into_inner()
            .deliveries
            .into_iter()
            .filter_map(|delivery| delivery.reply)
            .find(|reply| reply.task_id == task.task_id);
        if let Some(reply) = reply
            && matches!(
                reply.state(),
                ReplyState::Delivered | ReplyState::Uncertain | ReplyState::Failed
            )
        {
            break reply;
        }
        ensure!(
            Instant::now() < deadline,
            "{point}: reply never settled: {}",
            gateway.logs()
        );
        sleep(POLL).await;
    };
    // Give a restarted Gateway time to repeat a post it must not repeat.
    sleep(Duration::from_millis(500)).await;
    let posts = mock.posts().await?;
    match case.settles {
        Settles::Delivered => {
            ensure!(
                reply.state() == ReplyState::Delivered
                    && reply.provider_receipt.as_deref() == Some(case.provider.receipt()),
                "{point}: expected a delivered reply with its receipt, got {reply:?}"
            );
            ensure!(posts == 1, "{point}: provider received {posts} posts");
        }
        Settles::Uncertain { posts: expected } => {
            ensure!(
                reply.state() == ReplyState::Uncertain && reply.provider_receipt.is_none(),
                "{point}: expected an uncertain reply, got {reply:?}"
            );
            ensure!(
                posts == expected && posted_before_restart == expected,
                "{point}: provider received {posts} posts, {posted_before_restart} before restart"
            );
        }
    }
    let task = operator
        .get_task(credentials.request(GetTaskRequest {
            task_id: task.task_id.clone(),
        })?)
        .await?
        .into_inner();
    ensure!(task.state() == TaskState::Succeeded, "{task:?}");
    ensure!(control_plane.child.try_wait()?.is_none());
    Ok(())
}
