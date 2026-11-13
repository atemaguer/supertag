use std::{net::IpAddr, sync::Arc, time::Duration};

use serde::Serialize;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    negotiation::{NegotiationError, ProtocolChannel, connect},
    v2::{
        self, ServiceRole, conversations_client::ConversationsClient,
        enrollments_client::EnrollmentsClient, operator_client::OperatorClient,
    },
};
use tokio::sync::{Mutex, RwLock};
use tonic::{
    Code, Request, Status,
    metadata::{Ascii, MetadataValue},
    transport::{ClientTlsConfig, Endpoint},
};

mod artifacts;
mod profiles;
mod watch;
pub use profiles::{ControlPlaneActivation, ControlPlaneList};
pub use watch::WatchUpdate;

type Result<T> = std::result::Result<T, String>;
const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_PAGES: usize = 100;

#[derive(Default)]
pub struct ControlPlaneState(RwLock<Connection>, Mutex<()>);

#[derive(Default)]
struct Connection {
    generation: u64,
    session: Option<Arc<Session>>,
    origin: Option<String>,
    watch: Option<watch::Registration>,
    watch_epoch: u64,
}

impl Connection {
    fn replace(&mut self) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        self.session = None;
        self.origin = None;
        self.watch = None;
        self.watch_epoch = 0;
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
    async fn connect(endpoint: Endpoint, token: &str) -> Result<Self> {
        let authorization = bearer(token)?;
        let channel = endpoint.connect().await.map_err(|_| {
            "Could not connect to the Control Plane. Check its address and TLS certificate."
                .to_owned()
        })?;
        // The Control Plane refuses every call that does not name a negotiated version.
        let channel = connect(channel, ServiceRole::Client, ServiceRole::ControlPlane)
            .await
            .map_err(|error| match error {
                NegotiationError::Unavailable(_) => {
                    "Could not connect to the Control Plane. Check its address and TLS certificate."
                        .to_owned()
                }
                NegotiationError::Incompatible(_) => {
                    "This Control Plane runs an incompatible SuperTag release. Use the same release for the Control Plane and this app."
                        .to_owned()
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

    /// Whom the Control Plane resolves this session's credential to, such as `operator:local` or
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
                    "The Control Plane refused this Auth Key. Ask an operator for a new client Auth Key."
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

impl ControlPlaneState {
    pub async fn disconnect(&self) {
        self.0.write().await.replace();
    }

    async fn session(&self, connection_id: &str) -> Result<Arc<Session>> {
        let state = self.0.read().await;
        let session = state
            .session
            .clone()
            .ok_or("Connect to a Control Plane first.")?;
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

    pub async fn conversations(
        &self,
        connection_id: &str,
        tag_id: String,
    ) -> Result<Vec<Conversation>> {
        let session = self.session(connection_id).await?;
        let mut conversations = Vec::new();
        let mut cursor = String::new();
        for _ in 0..MAX_PAGES {
            let page = session
                .conversations()
                .list_conversations(session.request(v2::ListConversationsRequest {
                    tag_id: tag_id.clone(),
                    limit: 100,
                    cursor: cursor.clone(),
                }))
                .await
                .map_err(rpc_error)?
                .into_inner();
            conversations.extend(page.conversations.into_iter().map(Conversation::from));
            if page.next_cursor.is_empty() {
                return self.current(&session, conversations).await;
            }
            if page.next_cursor == cursor {
                break;
            }
            cursor = page.next_cursor;
        }
        Err("The conversation list is too large to load.".into())
    }

    pub async fn messages(
        &self,
        connection_id: &str,
        tag_id: String,
        conversation: String,
        cursor: Option<String>,
    ) -> Result<Messages> {
        let session = self.session(connection_id).await?;
        let page = session
            .conversations()
            .list_messages(session.request(v2::ListMessagesRequest {
                tag_id,
                conversation,
                limit: 50,
                cursor: cursor.unwrap_or_default(),
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
            },
        )
        .await
    }

    pub async fn send(
        &self,
        connection_id: &str,
        tag_id: String,
        conversation: String,
        text: String,
        operation_id: String,
    ) -> Result<Message> {
        let session = self.session(connection_id).await?;
        let value = session
            .conversations()
            .send_message(session.request(v2::SendMessageRequest {
                tag_id,
                conversation,
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

    pub async fn events(
        &self,
        connection_id: &str,
        tag_id: String,
        task_id: String,
        after_sequence: u64,
    ) -> Result<Vec<Event>> {
        let session = self.session(connection_id).await?;
        let page = session
            .conversations()
            .list_message_events(session.request(v2::ListMessageEventsRequest {
                tag_id,
                task_id,
                after_sequence,
                limit: 100,
            }))
            .await
            .map_err(rpc_error)?
            .into_inner();
        self.current(
            &session,
            page.events
                .into_iter()
                .map(|event| Event {
                    sequence: event.sequence,
                    text: event.text,
                })
                .collect(),
        )
        .await
    }
}

fn endpoint(control_plane: &str) -> Result<Endpoint> {
    if control_plane.contains(['#', '\\']) {
        return Err("Enter a valid Control Plane origin without a fragment.".into());
    }
    let endpoint = Endpoint::from_shared(control_plane.trim().to_owned())
        .map_err(|_| "Enter a valid Control Plane URL.".to_owned())?;
    let uri = endpoint.uri();
    let authority = uri.authority().ok_or("Enter a Control Plane host.")?;
    if authority.as_str().contains('@')
        || uri.path() != "/" && !uri.path().is_empty()
        || uri.query().is_some()
        || uri.port_u16() == Some(0)
    {
        return Err(
            "The Control Plane URL must be an origin without credentials, path, or query.".into(),
        );
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
                    "HTTP requires a loopback IP address. Use HTTPS for a remote Control Plane."
                        .into(),
                );
            }
            false
        }
        _ => return Err("The Control Plane URL must use HTTP or HTTPS.".into()),
    };
    let endpoint = endpoint
        .connect_timeout(Duration::from_secs(5))
        .timeout(TIMEOUT);
    if tls {
        endpoint
            .tls_config(ClientTlsConfig::new().with_native_roots())
            .map_err(|_| "Could not configure Control Plane TLS.".into())
    } else {
        Ok(endpoint)
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
    // data, backend details, or credentials echoed by an unexpected server.
    match status.code() {
        Code::Unauthenticated => "The Control Plane rejected the saved credential.",
        Code::PermissionDenied => "This connection cannot access that resource.",
        Code::NotFound => "The requested resource is no longer available.",
        Code::AlreadyExists => "This operation conflicts with an earlier request.",
        Code::InvalidArgument => "The Control Plane rejected this request. Check its values.",
        Code::FailedPrecondition => "This action is not available in the current state.",
        Code::ResourceExhausted => "The Control Plane limit was reached. Try a smaller request.",
        Code::DeadlineExceeded | Code::Unavailable => {
            "The Control Plane is unavailable. Retry with the same message operation."
        }
        _ => "The Control Plane request failed.",
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
}

impl From<v2::Tag> for Tag {
    fn from(tag: v2::Tag) -> Self {
        let harness_kind = tag
            .harness_kind()
            .as_str_name()
            .trim_start_matches("HARNESS_KIND_")
            .to_ascii_lowercase();
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
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<ResultArtifact>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResultArtifact {
    artifact_id: String,
    paths: Vec<String>,
}

impl From<v2::ArtifactSelection> for ResultArtifact {
    fn from(selection: v2::ArtifactSelection) -> Self {
        Self {
            artifact_id: selection.artifact_id,
            paths: selection.paths,
        }
    }
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
            artifacts: task
                .artifacts
                .into_iter()
                .map(ResultArtifact::from)
                .collect(),
        }
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub tag_id: String,
    pub name: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_task: Option<Task>,
}

impl From<v2::Conversation> for Conversation {
    fn from(value: v2::Conversation) -> Self {
        Self {
            tag_id: value.tag_id,
            name: value.name,
            session_id: value.session_id,
            latest_task: value.latest_task.map(Task::from),
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
    pub conversation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_input: Option<LiveInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_session_report_id: Option<String>,
}

impl TryFrom<v2::ConversationMessage> for Message {
    type Error = String;
    fn try_from(value: v2::ConversationMessage) -> Result<Self> {
        let mut task = Task::from(
            value
                .task
                .ok_or("The Control Plane returned an incomplete message.")?,
        );
        let live_input = if value.work_session_report_id.is_some() {
            task.prompt = None;
            None
        } else {
            value.live_input.map(LiveInput::from)
        };
        Ok(Self {
            task,
            conversation: value.conversation,
            live_input,
            work_session_report_id: value.work_session_report_id,
        })
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Messages {
    pub messages: Vec<Message>,
    pub next_cursor: String,
}

#[derive(Serialize, Debug)]
pub struct Event {
    pub sequence: u64,
    pub text: String,
}

#[cfg(test)]
mod tests;
