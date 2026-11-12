use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};

use crate::Gateway;

impl Gateway {
    pub fn mailbox_service(&self) -> mailbox_server::MailboxServer<Self> {
        mailbox_server::MailboxServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn attempt_mailbox_service(&self) -> attempt_mailbox_server::AttemptMailboxServer<Self> {
        attempt_mailbox_server::AttemptMailboxServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl mailbox_server::Mailbox for Gateway {
    async fn list_messages(
        &self,
        request: Request<ListMailboxMessagesRequest>,
    ) -> Result<Response<ListMailboxMessagesResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async {
                mailbox_client::MailboxClient::new(channel)
                    .max_decoding_message_size(MAX_MESSAGE_BYTES)
                    .max_encoding_message_size(MAX_MESSAGE_BYTES)
                    .list_messages(request)
                    .await
            },
        )
        .await
    }

    async fn change_grant(
        &self,
        request: Request<ChangeMailboxGrantRequest>,
    ) -> Result<Response<ChangeMailboxGrantResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async {
                mailbox_client::MailboxClient::new(channel)
                    .change_grant(request)
                    .await
            },
        )
        .await
    }

    async fn list_grants(
        &self,
        request: Request<ListMailboxGrantsRequest>,
    ) -> Result<Response<ListMailboxGrantsResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async {
                mailbox_client::MailboxClient::new(channel)
                    .list_grants(request)
                    .await
            },
        )
        .await
    }
}

#[tonic::async_trait]
impl attempt_mailbox_server::AttemptMailbox for Gateway {
    async fn send_message(
        &self,
        request: Request<SendAttemptTagMessageRequest>,
    ) -> Result<Response<SendTagMessageResponse>, Status> {
        self.forward_host(request, true, |channel, request| async {
            attempt_mailbox_client::AttemptMailboxClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .send_message(request)
                .await
        })
        .await
    }
    async fn read_mailbox(
        &self,
        request: Request<ReadMailboxRequest>,
    ) -> Result<Response<ListMailboxMessagesResponse>, Status> {
        self.forward_host(request, true, |channel, request| async {
            attempt_mailbox_client::AttemptMailboxClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .read_mailbox(request)
                .await
        })
        .await
    }
}
