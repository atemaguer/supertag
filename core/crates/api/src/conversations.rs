use std::pin::Pin;

use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tokio_stream::Stream;
use tokio_util::sync::CancellationToken;
use tonic::{Request, Response, Status};

use crate::{Api, watch::relay};

/// The Conversations service, with what ends its open follows.
pub struct ApiConversations {
    api: Api,
    shutdown: CancellationToken,
}

impl Api {
    /// `shutdown` ends open follows.
    pub fn conversations_service(
        &self,
        shutdown: CancellationToken,
    ) -> conversations_server::ConversationsServer<ApiConversations> {
        conversations_server::ConversationsServer::new(ApiConversations {
            api: self.clone(),
            shutdown,
        })
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

impl std::ops::Deref for ApiConversations {
    type Target = Api;

    fn deref(&self) -> &Api {
        &self.api
    }
}

type Follow = Pin<Box<dyn Stream<Item = Result<FollowConversationResponse, Status>> + Send>>;

#[tonic::async_trait]
impl conversations_server::Conversations for ApiConversations {
    async fn list_conversations(
        &self,
        request: Request<ListConversationsRequest>,
    ) -> Result<Response<ListConversationsResponse>, Status> {
        self.forward(request, |channel, request| async move {
            client(channel).list_conversations(request).await
        })
        .await
    }

    async fn list_messages(
        &self,
        request: Request<ListMessagesRequest>,
    ) -> Result<Response<ListMessagesResponse>, Status> {
        self.forward(request, |channel, request| async move {
            client(channel).list_messages(request).await
        })
        .await
    }

    async fn send_message(
        &self,
        request: Request<SendMessageRequest>,
    ) -> Result<Response<ConversationMessage>, Status> {
        self.forward(request, |channel, request| async move {
            client(channel).send_message(request).await
        })
        .await
    }

    async fn get_message(
        &self,
        request: Request<GetMessageRequest>,
    ) -> Result<Response<ConversationMessage>, Status> {
        self.forward(request, |channel, request| async move {
            client(channel).get_message(request).await
        })
        .await
    }

    async fn mark_conversation_read(
        &self,
        request: Request<MarkConversationReadRequest>,
    ) -> Result<Response<Conversation>, Status> {
        self.forward(request, |channel, request| async move {
            client(channel).mark_conversation_read(request).await
        })
        .await
    }

    type FollowConversationStream = Follow;

    async fn follow_conversation(
        &self,
        request: Request<FollowConversationRequest>,
    ) -> Result<Response<Follow>, Status> {
        relay(
            &self.api,
            &self.shutdown,
            request,
            |channel, request| async move { client(channel).follow_conversation(request).await },
        )
        .await
    }
}

fn client(channel: ProtocolChannel) -> conversations_client::ConversationsClient<ProtocolChannel> {
    conversations_client::ConversationsClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}
