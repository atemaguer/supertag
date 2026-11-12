use crate::Gateway;
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status, transport::Channel};
impl Gateway {
    pub fn artifact_publications_service(
        &self,
    ) -> artifact_publications_server::ArtifactPublicationsServer<Self> {
        artifact_publications_server::ArtifactPublicationsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}
fn client(channel: Channel) -> artifact_publications_client::ArtifactPublicationsClient<Channel> {
    artifact_publications_client::ArtifactPublicationsClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}
#[tonic::async_trait]
impl artifact_publications_server::ArtifactPublications for Gateway {
    async fn publish(
        &self,
        request: Request<PublishArtifactRequest>,
    ) -> Result<Response<ArtifactPublication>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).publish(request).await },
        )
        .await
    }
    async fn consume(
        &self,
        request: Request<ConsumeArtifactPublicationRequest>,
    ) -> Result<Response<ArtifactConsumptionApproval>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).consume(request).await },
        )
        .await
    }
    async fn withdraw_publication(
        &self,
        request: Request<WithdrawArtifactApprovalRequest>,
    ) -> Result<Response<ArtifactPublication>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).withdraw_publication(request).await },
        )
        .await
    }
    async fn withdraw_consumption(
        &self,
        request: Request<WithdrawArtifactApprovalRequest>,
    ) -> Result<Response<ArtifactConsumptionApproval>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).withdraw_consumption(request).await },
        )
        .await
    }
    async fn get_publication(
        &self,
        request: Request<GetArtifactApprovalRequest>,
    ) -> Result<Response<ArtifactPublication>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).get_publication(request).await },
        )
        .await
    }
    async fn get_consumption(
        &self,
        request: Request<GetArtifactApprovalRequest>,
    ) -> Result<Response<ArtifactConsumptionApproval>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).get_consumption(request).await },
        )
        .await
    }
    async fn list_publications(
        &self,
        request: Request<ListObjectiveArtifactApprovalsRequest>,
    ) -> Result<Response<ListArtifactPublicationsResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).list_publications(request).await },
        )
        .await
    }
    async fn list_consumptions(
        &self,
        request: Request<ListObjectiveArtifactApprovalsRequest>,
    ) -> Result<Response<ListArtifactConsumptionsResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).list_consumptions(request).await },
        )
        .await
    }
    async fn list_audit(
        &self,
        request: Request<ListArtifactApprovalAuditRequest>,
    ) -> Result<Response<ListArtifactApprovalAuditResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).list_audit(request).await },
        )
        .await
    }
}
