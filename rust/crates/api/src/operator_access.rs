//! The public Operator Token and audit API. Callers are authenticated by [`crate::authorize`];
//! only the admin operator manages Operator Tokens.

use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{operator_access_client::OperatorAccessClient, operator_access_server, *},
};
use tonic::{Request, Response, Status};

use crate::Api;

impl Api {
    pub fn operator_access_service(&self) -> operator_access_server::OperatorAccessServer<Self> {
        operator_access_server::OperatorAccessServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

fn access(channel: ProtocolChannel) -> OperatorAccessClient<ProtocolChannel> {
    OperatorAccessClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

#[tonic::async_trait]
impl operator_access_server::OperatorAccess for Api {
    async fn create_operator_token(
        &self,
        request: Request<CreateOperatorTokenRequest>,
    ) -> Result<Response<OperatorToken>, Status> {
        self.forward(request, |channel, request| async {
            access(channel).create_operator_token(request).await
        })
        .await
    }

    async fn get_operator_token(
        &self,
        request: Request<GetOperatorTokenRequest>,
    ) -> Result<Response<OperatorToken>, Status> {
        self.forward(request, |channel, request| async {
            access(channel).get_operator_token(request).await
        })
        .await
    }

    async fn list_operator_tokens(
        &self,
        request: Request<ListOperatorTokensRequest>,
    ) -> Result<Response<ListOperatorTokensResponse>, Status> {
        self.forward(request, |channel, request| async {
            access(channel).list_operator_tokens(request).await
        })
        .await
    }

    async fn rotate_operator_token(
        &self,
        request: Request<RotateOperatorTokenRequest>,
    ) -> Result<Response<OperatorToken>, Status> {
        self.forward(request, |channel, request| async {
            access(channel).rotate_operator_token(request).await
        })
        .await
    }

    async fn revoke_operator_token(
        &self,
        request: Request<RevokeOperatorTokenRequest>,
    ) -> Result<Response<OperatorToken>, Status> {
        self.forward(request, |channel, request| async {
            access(channel).revoke_operator_token(request).await
        })
        .await
    }

    async fn list_audit_entries(
        &self,
        request: Request<ListAuditEntriesRequest>,
    ) -> Result<Response<ListAuditEntriesResponse>, Status> {
        self.forward(request, |channel, request| async {
            access(channel).list_audit_entries(request).await
        })
        .await
    }
}
