use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status, transport::Channel};

use crate::Gateway;

impl Gateway {
    pub fn conversations_service(&self) -> conversations_server::ConversationsServer<Self> {
        conversations_server::ConversationsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl conversations_server::Conversations for Gateway {
    async fn list_conversations(
        &self,
        request: Request<ListConversationsRequest>,
    ) -> Result<Response<ListConversationsResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async move { client(channel).list_conversations(request).await },
        )
        .await
    }

    async fn list_messages(
        &self,
        request: Request<ListMessagesRequest>,
    ) -> Result<Response<ListMessagesResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async move { client(channel).list_messages(request).await },
        )
        .await
    }

    async fn send_message(
        &self,
        request: Request<SendMessageRequest>,
    ) -> Result<Response<ConversationMessage>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async move { client(channel).send_message(request).await },
        )
        .await
    }

    async fn get_message(
        &self,
        request: Request<GetMessageRequest>,
    ) -> Result<Response<ConversationMessage>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async move { client(channel).get_message(request).await },
        )
        .await
    }

    async fn list_message_events(
        &self,
        request: Request<ListMessageEventsRequest>,
    ) -> Result<Response<ListEventsResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async move { client(channel).list_message_events(request).await },
        )
        .await
    }
}

fn client(channel: Channel) -> conversations_client::ConversationsClient<Channel> {
    conversations_client::ConversationsClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}
