use std::{net::IpAddr, sync::Arc, time::Duration};

use serde::Serialize;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{self, conversations_client::ConversationsClient, operator_client::OperatorClient},
};
use tokio::sync::RwLock;
use tonic::{
    Code, Request, Status,
    metadata::{Ascii, MetadataValue},
    transport::{Channel, ClientTlsConfig, Endpoint},
};

mod watch;
pub use watch::WatchUpdate;

type Result<T> = std::result::Result<T, String>;
const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_PAGES: usize = 100;

#[derive(Default)]
pub struct GatewayState(RwLock<Connection>);

#[derive(Default)]
struct Connection {
    generation: u64,
    session: Option<Arc<Session>>,
    watch: Option<watch::Registration>,
    watch_epoch: u64,
}

impl Connection {
    fn replace(&mut self) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        self.session = None;
        self.watch = None;
        self.watch_epoch = 0;
        self.generation
    }
}

// This type deliberately has no Debug/Serialize implementation. The credential
// lives only here and in sensitive request headers, never in settings or logs.
struct Session {
    channel: Channel,
    authorization: MetadataValue<Ascii>,
}

impl Session {
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

    fn operator(&self) -> OperatorClient<Channel> {
        OperatorClient::new(self.channel.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    fn conversations(&self) -> ConversationsClient<Channel> {
        ConversationsClient::new(self.channel.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

impl GatewayState {
    pub async fn connect(&self, gateway: String, token: String) -> Result<String> {
        // Replacing or disconnecting a connection invalidates pending connects.
        let generation = self.0.write().await.replace();
        let endpoint = endpoint(&gateway)?;
        let authorization = bearer(&token)?;
        let channel = endpoint.connect().await.map_err(|_| {
            "Could not connect to the Gateway. Check its address and TLS certificate.".to_owned()
        })?;
        let session = Arc::new(Session {
            channel,
            authorization,
        });
        session
            .operator()
            .list_tags(session.request(v2::ListTagsRequest {
                limit: 1,
                cursor: String::new(),
            }))
            .await
            .map_err(rpc_error)?;
        let mut state = self.0.write().await;
        if state.generation != generation {
            return Err("The connection changed. Connect again.".into());
        }
        state.session = Some(session);
        Ok(generation.to_string())
    }

    pub async fn disconnect(&self) {
        self.0.write().await.replace();
    }

    async fn session(&self) -> Result<Arc<Session>> {
        self.0
            .read()
            .await
            .session
            .clone()
            .ok_or_else(|| "Connect to a Gateway first.".into())
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

    pub async fn tags(&self) -> Result<Vec<Tag>> {
        let session = self.session().await?;
        let mut tags = Vec::new();
        let mut cursor = String::new();
        for _ in 0..MAX_PAGES {
            let page = session
                .operator()
                .list_tags(session.request(v2::ListTagsRequest {
                    limit: 100,
                    cursor: cursor.clone(),
                }))
                .await
                .map_err(rpc_error)?
                .into_inner();
            tags.extend(page.tags.into_iter().map(Tag::from));
            if page.next_cursor.is_empty() {
                return self.current(&session, tags).await;
            }
            if page.next_cursor == cursor {
                break;
            }
            cursor = page.next_cursor;
        }
        Err("The Tag list is too large to load. Use the CLI to narrow the view.".into())
    }

    pub async fn conversations(&self, tag_id: String) -> Result<Vec<Conversation>> {
        let session = self.session().await?;
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
        tag_id: String,
        conversation: String,
        cursor: Option<String>,
    ) -> Result<Messages> {
        let session = self.session().await?;
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
        tag_id: String,
        conversation: String,
        text: String,
        operation_id: String,
    ) -> Result<Message> {
        let session = self.session().await?;
        let value = session
            .conversations()
            .send_message(session.request(v2::SendMessageRequest {
                tag_id,
                conversation,
                text,
                operation_id,
            }))
            .await
            .map_err(rpc_error)?
            .into_inner();
        self.current(&session, Message::try_from(value)?).await
    }

    pub async fn message(&self, tag_id: String, task_id: String) -> Result<Message> {
        let session = self.session().await?;
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
        tag_id: String,
        task_id: String,
        after_sequence: u64,
    ) -> Result<Vec<Event>> {
        let session = self.session().await?;
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

fn endpoint(gateway: &str) -> Result<Endpoint> {
    if gateway.contains(['#', '\\']) {
        return Err("Enter a valid Gateway origin without a fragment.".into());
    }
    let endpoint = Endpoint::from_shared(gateway.trim().to_owned())
        .map_err(|_| "Enter a valid Gateway URL.".to_owned())?;
    let uri = endpoint.uri();
    let authority = uri.authority().ok_or("Enter a Gateway host.")?;
    if authority.as_str().contains('@')
        || uri.path() != "/" && !uri.path().is_empty()
        || uri.query().is_some()
        || uri.port_u16() == Some(0)
    {
        return Err(
            "The Gateway URL must be an origin without credentials, path, or query.".into(),
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
                    "HTTP requires a loopback IP address. Use HTTPS for a remote Gateway.".into(),
                );
            }
            false
        }
        _ => return Err("The Gateway URL must use HTTP or HTTPS.".into()),
    };
    let endpoint = endpoint
        .connect_timeout(Duration::from_secs(5))
        .timeout(TIMEOUT);
    if tls {
        endpoint
            .tls_config(ClientTlsConfig::new().with_native_roots())
            .map_err(|_| "Could not configure Gateway TLS.".into())
    } else {
        Ok(endpoint)
    }
}

fn bearer(token: &str) -> Result<MetadataValue<Ascii>> {
    if token.is_empty() || token.len() > 8192 || !token.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return Err("Enter a valid operator token.".into());
    }
    let mut value: MetadataValue<Ascii> = format!("Bearer {token}")
        .parse()
        .map_err(|_| "Enter a valid operator token.".to_owned())?;
    value.set_sensitive(true);
    Ok(value)
}

fn rpc_error(status: Status) -> String {
    // Never surface an arbitrary upstream status message: it can contain request
    // data, backend details, or credentials echoed by an unexpected server.
    match status.code() {
        Code::Unauthenticated => "The Gateway rejected the operator token.",
        Code::PermissionDenied => "This operator cannot access that resource.",
        Code::NotFound => "The requested resource is no longer available.",
        Code::AlreadyExists => "This operation conflicts with an earlier request.",
        Code::InvalidArgument => "The Gateway rejected this request. Check its values.",
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
                .ok_or("The Gateway returned an incomplete message.")?,
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
