use std::{net::IpAddr, path::PathBuf, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    negotiation::{NegotiationError, ProtocolChannel, connect},
    v2::{
        self, ServiceRole, conversations_client::ConversationsClient,
        enrollments_client::EnrollmentsClient, operator_client::OperatorClient,
    },
};
use supertag_transport::{Target, tunneled_uri};
use tokio::sync::{Mutex, RwLock};
use tonic::{
    Code, Request, Status,
    metadata::{Ascii, MetadataValue},
    transport::{ClientTlsConfig, Endpoint},
};

pub mod activity;
pub mod cache;
mod follow;
mod local;
pub mod memories;
pub mod network;
mod new_tag;
mod profiles;
pub mod schedules;
pub mod task_files;
mod watch;
pub use follow::FollowUpdate;
pub use new_tag::{NewTag, TagOptions};
pub use profiles::{GatewayActivation, GatewayList};
pub use watch::WatchUpdate;

type Result<T> = std::result::Result<T, String>;
const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_PAGES: usize = 100;
/// The most events one `ListEvents` call returns.
const EVENT_PAGE: u32 = 32;
/// The most of a Gateway's reason for refusing a request the app shows.
const MAX_REASON_CHARS: usize = 300;

/// The current connection, a lock that orders connection changes, and the local state directory
/// a local Gateway is found in, if one could be located.
#[derive(Default)]
pub struct GatewayState(RwLock<Connection>, Mutex<()>, Option<PathBuf>);

impl GatewayState {
    pub fn new(local_state: Option<PathBuf>) -> Self {
        Self(RwLock::default(), Mutex::default(), local_state)
    }
}

#[derive(Default)]
struct Connection {
    generation: u64,
    session: Option<Arc<Session>>,
    origin: Option<String>,
    watch: Option<watch::Registration>,
    watch_epoch: u64,
    follows: follow::Follows,
    cache_scope: Option<cache::CacheScope>,
}

impl Connection {
    fn replace(&mut self) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        self.session = None;
        self.origin = None;
        self.watch = None;
        self.watch_epoch = 0;
        self.follows = follow::Follows::default();
        self.cache_scope = None;
        self.generation
    }
}

// This type deliberately has no Debug/Serialize implementation. The credential
// lives only here and in sensitive request headers, never in settings or logs.
struct Session {
    channel: ProtocolChannel,
    authorization: MetadataValue<Ascii>,
}

impl Session {
    async fn connect(target: Target, token: &str) -> Result<Self> {
        let authorization = bearer(token)?;
        let channel = target.connect().await.map_err(|_| {
            "Could not connect to the Gateway. Check its address and TLS certificate.".to_owned()
        })?;
        // The Gateway refuses every call that does not name a negotiated version.
        let channel = connect(channel, ServiceRole::Client, ServiceRole::Gateway)
            .await
            .map_err(|error| match error {
                NegotiationError::Unavailable(_) => {
                    "Could not connect to the Gateway. Check its address and TLS certificate."
                        .to_owned()
                }
                NegotiationError::Incompatible(_) => {
                    "This Gateway runs an incompatible SuperTag release. Use the same release for the Gateway and this app."
                        .to_owned()
                }
                // Names both releases, where the Gateway runs, and which to upgrade.
                mismatch @ NegotiationError::Mismatch(_) => {
                    mismatch.at(target.url()).speaking_as("This app").to_string()
                }
            })?;
        Ok(Self {
            channel,
            authorization,
        })
    }

    fn authenticated<T>(&self, value: T) -> Request<T> {
        let mut request = Request::new(value);
        request
            .metadata_mut()
            .insert("authorization", self.authorization.clone());
        request
    }

    fn request<T>(&self, value: T) -> Request<T> {
        let mut request = self.authenticated(value);
        request.set_timeout(TIMEOUT);
        request
    }

    fn operator(&self) -> OperatorClient<ProtocolChannel> {
        OperatorClient::new(self.channel.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    fn enrollments(&self) -> EnrollmentsClient<ProtocolChannel> {
        EnrollmentsClient::new(self.channel.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    /// Whom the Gateway resolves this session's credential to, such as `operator:local` or
    /// `client:alice-laptop`.
    async fn principal(&self) -> Result<String> {
        Ok(self
            .enrollments()
            .who_am_i(self.request(v2::WhoAmIRequest {}))
            .await
            .map_err(rpc_error)?
            .into_inner()
            .principal)
    }

    /// Joins this device as `client:NAME` with a client Auth Key, this session's bearer, and
    /// returns its new enrolled credential. The key is presented once and never kept.
    async fn enroll(&self, name: &str) -> Result<String> {
        use sha2::Digest as _;
        let credential = supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX);
        self.enrollments()
            .enroll(self.request(v2::EnrollRequest {
                role: v2::PrincipalRole::Client.into(),
                name: name.to_owned(),
                operation_id: supertag_protocol::new_secret(""),
                token_digest: sha2::Sha256::digest(credential.as_bytes()).to_vec(),
            }))
            .await
            .map_err(|status| match status.code() {
                Code::PermissionDenied | Code::FailedPrecondition | Code::Unauthenticated => {
                    "The Gateway refused this Auth Key. Ask an operator for a new client Auth Key."
                        .to_owned()
                }
                _ => rpc_error(status),
            })?;
        Ok(credential)
    }

    fn conversations(&self) -> ConversationsClient<ProtocolChannel> {
        ConversationsClient::new(self.channel.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
    async fn tags(&self) -> Result<Vec<Tag>> {
        let mut tags = Vec::new();
        let mut cursor = String::new();
        for _ in 0..MAX_PAGES {
            let page = self
                .operator()
                .list_tags(self.request(v2::ListTagsRequest {
                    limit: 100,
                    cursor: cursor.clone(),
                    include_retired: false,
                }))
                .await
                .map_err(rpc_error)?
                .into_inner();
            tags.extend(page.tags.into_iter().map(Tag::from));
            if page.next_cursor.is_empty() {
                return Ok(tags);
            }
            if page.next_cursor == cursor {
                break;
            }
            cursor = page.next_cursor;
        }
        Err("The Tag list is too large to load. Use the CLI to narrow the view.".into())
    }
}

impl GatewayState {
    pub async fn disconnect(&self) {
        self.0.write().await.replace();
    }

    async fn session(&self, connection_id: &str) -> Result<Arc<Session>> {
        let state = self.0.read().await;
        let session = state.session.clone().ok_or("Connect to a Gateway first.")?;
        if state.generation.to_string() != connection_id {
            return Err("The connection changed. Refresh this view.".into());
        }
        Ok(session)
    }

    async fn current<T>(&self, session: &Arc<Session>, value: T) -> Result<T> {
        if self
            .0
            .read()
            .await
            .session
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, session))
        {
            Ok(value)
        } else {
            Err("The connection changed. Refresh this view.".into())
        }
    }

    pub async fn tags(&self, connection_id: &str) -> Result<Vec<Tag>> {
        let session = self.session(connection_id).await?;
        let tags = session.tags().await?;
        self.current(&session, tags).await
    }

    /// The caller's conversation with each Tag it has talked to, the latest active first.
    pub async fn conversations(&self, connection_id: &str) -> Result<Vec<Conversation>> {
        let session = self.session(connection_id).await?;
        let page = session
            .conversations()
            .list_conversations(session.request(v2::ListConversationsRequest {}))
            .await
            .map_err(rpc_error)?
            .into_inner();
        self.current(
            &session,
            page.conversations
                .into_iter()
                .map(Conversation::from)
                .collect(),
        )
        .await
    }

    /// Records that the caller read its conversation with a Tag up to a finished turn.
    pub async fn mark_read(
        &self,
        connection_id: &str,
        tag_id: String,
        order: u64,
    ) -> Result<Conversation> {
        let session = self.session(connection_id).await?;
        let value = session
            .conversations()
            .mark_conversation_read(
                session.request(v2::MarkConversationReadRequest { tag_id, order }),
            )
            .await
            .map_err(rpc_error)?
            .into_inner();
        self.current(&session, Conversation::from(value)).await
    }

    /// A page of the caller's conversation with a Tag, or, given the `after` order and the
    /// `conversation_id` of the copy the app keeps, only what changed since.
    pub async fn messages(&self, connection_id: &str, read: ReadMessages) -> Result<Messages> {
        let session = self.session(connection_id).await?;
        let page = session
            .conversations()
            .list_messages(session.request(v2::ListMessagesRequest {
                tag_id: read.tag_id,
                limit: 50,
                cursor: read.cursor.unwrap_or_default(),
                after: read.after.unwrap_or_default(),
                conversation_id: read.conversation_id.unwrap_or_default(),
                refresh_task_ids: read.refresh_task_ids,
            }))
            .await
            .map_err(rpc_error)?
            .into_inner();
        let messages = page
            .messages
            .into_iter()
            .map(Message::try_from)
            .collect::<Result<_>>()?;
        self.current(
            &session,
            Messages {
                messages,
                next_cursor: page.next_cursor,
                conversation_id: page.conversation_id,
                incremental: page.incremental,
            },
        )
        .await
    }

    pub async fn send(
        &self,
        connection_id: &str,
        tag_id: String,
        text: String,
        operation_id: String,
    ) -> Result<Message> {
        let session = self.session(connection_id).await?;
        let value = session
            .conversations()
            .send_message(session.request(v2::SendMessageRequest {
                tag_id,
                text,
                operation_id,
                execution_limits: None,
                output_policy: None,
            }))
            .await
            .map_err(rpc_error)?
            .into_inner();
        self.current(&session, Message::try_from(value)?).await
    }

    pub async fn message(
        &self,
        connection_id: &str,
        tag_id: String,
        task_id: String,
    ) -> Result<Message> {
        let session = self.session(connection_id).await?;
        let value = session
            .conversations()
            .get_message(session.request(v2::GetMessageRequest { tag_id, task_id }))
            .await
            .map_err(rpc_error)?
            .into_inner();
        self.current(&session, Message::try_from(value)?).await
    }

    /// A Task's events after `after_sequence`, oldest first, read page by page.
    pub async fn events(
        &self,
        connection_id: &str,
        task_id: String,
        after_sequence: u64,
    ) -> Result<Vec<Event>> {
        let session = self.session(connection_id).await?;
        let mut events = Vec::new();
        let mut after = after_sequence;
        for _ in 0..MAX_PAGES {
            let page = session
                .operator()
                .list_events(session.request(v2::ListEventsRequest {
                    task_id: task_id.clone(),
                    after_sequence: after,
                    limit: EVENT_PAGE,
                }))
                .await
                .map_err(rpc_error)?
                .into_inner()
                .events;
            let full = page.len() >= EVENT_PAGE as usize;
            let read = page.into_iter().filter(|event| event.sequence > after);
            let before = events.len();
            events.extend(read.map(Event::from));
            match events.last() {
                Some(last) if events.len() > before => after = last.sequence,
                _ => break,
            }
            if !full {
                break;
            }
        }
        self.current(&session, events).await
    }
}

/// `https://` and loopback `http://` URLs dial native gRPC. `wss://` and loopback `ws://` URLs
/// carry the same connection through a WebSocket tunnel, which may have a path; the Control
/// Plane's TLS still runs inside a `wss://` tunnel.
fn endpoint(gateway: &str) -> Result<Target> {
    if gateway.contains(['#', '\\']) {
        return Err("Enter a valid Gateway origin without a fragment.".into());
    }
    let gateway = gateway.trim();
    let invalid = "The Gateway URL must be an origin without credentials, path, or query, or a tunnel URL without credentials or query.";
    let tunnel = tunneled_uri(gateway).map_err(|_| invalid.to_owned())?;
    let endpoint = Endpoint::from_shared(tunnel.clone().unwrap_or_else(|| gateway.to_owned()))
        .map_err(|_| "Enter a valid Gateway URL.".to_owned())?;
    let uri = endpoint.uri();
    let authority = uri.authority().ok_or("Enter a Gateway host.")?;
    if authority.as_str().contains('@')
        || uri.path() != "/" && !uri.path().is_empty()
        || uri.query().is_some()
        || uri.port_u16() == Some(0)
    {
        return Err(invalid.into());
    }
    let tls = match uri.scheme_str() {
        Some("https") => true,
        Some("http") => {
            if !uri
                .host()
                .unwrap_or_default()
                .trim_matches(['[', ']'])
                .parse::<IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
            {
                return Err(
                    "HTTP and WS require a loopback IP address. Use HTTPS or WSS for a remote Gateway."
                        .into(),
                );
            }
            false
        }
        _ => return Err("The Gateway URL must use HTTP, HTTPS, WS, or WSS.".into()),
    };
    // A tunnel dial also covers the outer TLS and the WebSocket upgrade, and a platform proxy
    // may hold the upgrade while it starts a Gateway that scaled to zero.
    let endpoint = endpoint
        .connect_timeout(Duration::from_secs(if tunnel.is_some() { 30 } else { 5 }))
        .timeout(TIMEOUT);
    let endpoint = if tls {
        endpoint
            .tls_config(ClientTlsConfig::new().with_native_roots())
            .map_err(|_| "Could not configure Gateway TLS.".to_owned())?
    } else {
        endpoint
    };
    match tunnel {
        Some(_) => Target::tunnel(gateway, endpoint, None)
            .map_err(|_| "Could not configure the Gateway tunnel.".into()),
        None => Ok(Target::native(endpoint)),
    }
}

/// This machine's host name as a client name: letters, digits, hyphens, underscores and dots.
fn device_name() -> String {
    let name: String = host_name()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "-_.".contains(c) {
                c
            } else {
                '-'
            }
        })
        .take(250)
        .collect();
    if name.is_empty() {
        "device".into()
    } else {
        name
    }
}

fn host_name() -> String {
    #[cfg(unix)]
    {
        let mut buffer = [0_u8; 256];
        // SAFETY: the buffer is valid for its length, and gethostname terminates or truncates.
        if unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } == 0 {
            let end = buffer
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(buffer.len());
            return String::from_utf8_lossy(&buffer[..end]).into_owned();
        }
    }
    std::env::var("COMPUTERNAME").unwrap_or_default()
}

fn bearer(token: &str) -> Result<MetadataValue<Ascii>> {
    if token.is_empty() || token.len() > 8192 || !token.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return Err("Enter a valid operator token or Auth Key.".into());
    }
    let mut value: MetadataValue<Ascii> = format!("Bearer {token}")
        .parse()
        .map_err(|_| "Enter a valid operator token or Auth Key.".to_owned())?;
    value.set_sensitive(true);
    Ok(value)
}

fn rpc_error(status: Status) -> String {
    // Never surface an arbitrary upstream status message: it can contain request
    // data, backend details, or credentials echoed by an unexpected server. The
    // Gateway writes its InvalidArgument messages for the person who sent
    // the request, so that one is shown, bounded and stripped of control characters.
    if status.code() == Code::InvalidArgument {
        let reason: String = status
            .message()
            .chars()
            .filter(|c| !c.is_control())
            .take(MAX_REASON_CHARS)
            .collect();
        let reason = reason.trim().trim_end_matches('.');
        return if reason.is_empty() {
            "The Gateway rejected this request. Check its values.".into()
        } else {
            format!("The Gateway rejected this request: {reason}.")
        };
    }
    match status.code() {
        Code::Unauthenticated => "The Gateway rejected the saved credential.",
        Code::PermissionDenied => "This connection cannot access that resource.",
        Code::NotFound => "The requested resource is no longer available.",
        Code::AlreadyExists => "This operation conflicts with an earlier request.",
        Code::FailedPrecondition => "This action is not available in the current state.",
        Code::ResourceExhausted => "The Gateway limit was reached. Try a smaller request.",
        Code::DeadlineExceeded | Code::Unavailable => {
            "The Gateway is unavailable. Retry with the same message operation."
        }
        _ => "The Gateway request failed.",
    }
    .into()
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub tag_id: String,
    pub name: String,
    pub instructions: String,
    pub allowed_actions: Vec<String>,
    pub revision: u64,
    pub harness_kind: String,
    /// Whether this is the Gateway's lead Tag, which the app shows first.
    pub lead: bool,
    /// How many Work Sessions the Tag may have open at once, and has open now.
    pub max_work_sessions: u32,
    pub open_work_sessions: u32,
}

/// A harness as the app names it, such as `codex` or `claude_code`.
fn harness_name(kind: v2::HarnessKind) -> String {
    kind.as_str_name()
        .trim_start_matches("HARNESS_KIND_")
        .to_ascii_lowercase()
}

impl From<v2::Tag> for Tag {
    fn from(tag: v2::Tag) -> Self {
        let harness_kind = harness_name(tag.harness_kind());
        Self {
            name: if tag.name.is_empty() {
                tag.tag_id.clone()
            } else {
                tag.name
            },
            tag_id: tag.tag_id,
            instructions: tag.instructions,
            allowed_actions: tag.allowed_actions,
            revision: tag.revision,
            harness_kind,
            lead: tag.lead,
            max_work_sessions: tag.max_work_sessions,
            open_work_sessions: tag.open_work_sessions,
        }
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub task_id: String,
    pub tag_id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
    /// When the Gateway accepted the message, for a conversation's Task.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at_ms: Option<i64>,
    /// The turn finished quietly: its conversation does not show it.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub quiet: bool,
    /// The Worker Host holding the Session's last delivery, which the running turn waits for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waiting_for_holder: Option<String>,
}

impl From<v2::Task> for Task {
    fn from(task: v2::Task) -> Self {
        let state = task
            .state()
            .as_str_name()
            .trim_start_matches("TASK_STATE_")
            .to_ascii_lowercase();
        Self {
            task_id: task.task_id,
            tag_id: task.tag_id,
            session_id: task.session_id,
            prompt: (!task.prompt.is_empty()).then_some(task.prompt),
            state,
            result: task.result,
            attempt_id: task.attempt_id,
            created_at_ms: None,
            quiet: task.quiet,
            waiting_for_holder: task.waiting_for_holder,
        }
    }
}

/// The caller's conversation with one Tag, as a conversation list shows it.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub tag_id: String,
    pub conversation_id: String,
    pub preview: String,
    pub preview_from_tag: bool,
    pub last_activity_at_ms: i64,
    pub latest_order: u64,
    pub read_order: u64,
    pub unread_count: u32,
    pub working: bool,
    /// The latest message is the Tag's question, still unanswered.
    pub asking: bool,
}

impl From<v2::Conversation> for Conversation {
    fn from(value: v2::Conversation) -> Self {
        Self {
            tag_id: value.tag_id,
            conversation_id: value.conversation_id,
            preview: value.preview,
            preview_from_tag: value.preview_from_tag,
            last_activity_at_ms: value.last_activity_at_ms,
            latest_order: value.latest_order,
            read_order: value.read_order,
            unread_count: value.unread_count,
            working: value.working,
            asking: value.asking,
        }
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LiveInput {
    pub input_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub follower_task_id: String,
    pub text: String,
    pub state: String,
    pub order: u64,
}

impl From<v2::LiveInput> for LiveInput {
    fn from(value: v2::LiveInput) -> Self {
        let state = value
            .state()
            .as_str_name()
            .trim_start_matches("LIVE_INPUT_STATE_")
            .to_ascii_lowercase();
        Self {
            input_id: value.input_id,
            task_id: value.task_id,
            attempt_id: value.attempt_id,
            follower_task_id: value.follower_task_id,
            text: value.text,
            state,
            order: value.order,
        }
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub task: Task,
    /// The message's place in its conversation.
    pub order: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_input: Option<LiveInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_session_report_id: Option<String>,
    /// The Schedule that queued the turn, which has no message from the operator.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule_id: Option<String>,
    /// For a report turn whose work Session has since closed: why, such as `idle`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_session_closed: Option<String>,
    /// What the turn shows from its events: each message the Tag wrote and its latest activity
    /// or plan, ending at its latest event.
    pub events: Vec<Event>,
    /// Earlier messages the Tag wrote were left out; `list_task_events` reads them.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub events_truncated: bool,
}

/// Why a work Session closed, as the app shows it after "closed: ".
fn close_reason(reason: v2::WorkSessionCloseReason) -> Option<String> {
    use v2::WorkSessionCloseReason as Reason;
    Some(
        match reason {
            Reason::Unspecified => return None,
            Reason::Idle => "idle",
            Reason::Tag => "by the Tag",
            Reason::Operator => "by an operator",
            Reason::DeliveryPulled => "delivery pulled",
            Reason::ObjectiveClosed => "Objective closed",
            Reason::Upgrade => "finished before the upgrade",
            Reason::Merged => "pull request merged",
        }
        .to_owned(),
    )
}

impl TryFrom<v2::ConversationMessage> for Message {
    type Error = String;
    fn try_from(value: v2::ConversationMessage) -> Result<Self> {
        let closed = close_reason(value.work_session_close_reason());
        let mut task = Task::from(
            value
                .task
                .ok_or("The Gateway returned an incomplete message.")?,
        );
        let live_input = if value.work_session_report_id.is_some() || value.schedule_id.is_some() {
            task.prompt = None;
            None
        } else {
            value.live_input.map(LiveInput::from)
        };
        task.created_at_ms = (value.sent_at_ms > 0).then_some(value.sent_at_ms);
        Ok(Self {
            task,
            order: value.order,
            completed_at_ms: value.completed_at_ms,
            live_input,
            work_session_report_id: value.work_session_report_id,
            work_session_closed: closed,
            schedule_id: value.schedule_id,
            events: value.events.into_iter().map(Event::from).collect(),
            events_truncated: value.events_truncated,
        })
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Messages {
    pub messages: Vec<Message>,
    pub next_cursor: String,
    pub conversation_id: String,
    /// The page holds only what changed after the request's `after`.
    pub incremental: bool,
}

/// What `messages` reads: a page before `cursor`, or the changes after `after` to the copy of
/// conversation `conversation_id` the app keeps, with the current state of its unfinished turns.
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReadMessages {
    pub tag_id: String,
    pub cursor: Option<String>,
    pub after: Option<u64>,
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub refresh_task_ids: Vec<String>,
}

/// One recorded event of a Task: a message its Tag wrote (`message`), one line saying what it is
/// doing (`activity`), or its plan as `progress.updated` JSON (`progress`).
#[derive(Serialize, Debug)]
pub struct Event {
    pub sequence: u64,
    pub kind: &'static str,
    pub text: String,
}

impl From<v2::TaskEvent> for Event {
    fn from(event: v2::TaskEvent) -> Self {
        Self {
            sequence: event.sequence,
            kind: match event.kind() {
                v2::TaskEventKind::Message => "message",
                v2::TaskEventKind::Activity => "activity",
                v2::TaskEventKind::Progress => "progress",
                v2::TaskEventKind::Unspecified => "unspecified",
            },
            text: event.text,
        }
    }
}

#[cfg(test)]
mod load_bench;
#[cfg(test)]
mod tests;
