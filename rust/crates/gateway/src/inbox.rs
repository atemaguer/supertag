use crate::Gateway;
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status, transport::Channel};
impl Gateway {
    pub fn inbox_service(&self) -> inbox_server::InboxServer<Self> {
        inbox_server::InboxServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}
fn client(channel: Channel) -> inbox_client::InboxClient<Channel> {
    inbox_client::InboxClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}
#[tonic::async_trait]
impl inbox_server::Inbox for Gateway {
    async fn list_items(
        &self,
        request: Request<ListInboxItemsRequest>,
    ) -> Result<Response<ListInboxItemsResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).list_items(request).await },
        )
        .await
    }
    async fn get_question(
        &self,
        request: Request<GetQuestionRequest>,
    ) -> Result<Response<ObjectiveQuestion>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).get_question(request).await },
        )
        .await
    }
    async fn answer_question(
        &self,
        request: Request<AnswerQuestionRequest>,
    ) -> Result<Response<Task>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).answer_question(request).await },
        )
        .await
    }
}
