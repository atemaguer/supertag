use crate::Api;
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};
impl Api {
    pub fn inbox_service(&self) -> inbox_server::InboxServer<Self> {
        inbox_server::InboxServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}
fn client(channel: ProtocolChannel) -> inbox_client::InboxClient<ProtocolChannel> {
    inbox_client::InboxClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}
#[tonic::async_trait]
impl inbox_server::Inbox for Api {
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
    async fn get_approval(
        &self,
        request: Request<GetApprovalRequest>,
    ) -> Result<Response<Approval>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).get_approval(request).await },
        )
        .await
    }
    async fn list_approvals(
        &self,
        request: Request<ListApprovalsRequest>,
    ) -> Result<Response<ListApprovalsResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).list_approvals(request).await },
        )
        .await
    }
    async fn decide_approval(
        &self,
        request: Request<DecideApprovalRequest>,
    ) -> Result<Response<Approval>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).decide_approval(request).await },
        )
        .await
    }
}
