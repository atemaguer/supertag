use super::*;

impl Gateway {
    pub fn manifest_relationships_service(
        &self,
    ) -> manifest_relationships_server::ManifestRelationshipsServer<Self> {
        manifest_relationships_server::ManifestRelationshipsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl manifest_relationships_server::ManifestRelationships for Gateway {
    async fn reconcile_tag(
        &self,
        request: Request<ReconcileTagRelationshipsRequest>,
    ) -> Result<Response<ReconcileTagRelationshipsResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async {
                manifest_relationships_client::ManifestRelationshipsClient::new(channel)
                    .max_decoding_message_size(MAX_MESSAGE_BYTES)
                    .max_encoding_message_size(MAX_MESSAGE_BYTES)
                    .reconcile_tag(request)
                    .await
            },
        )
        .await
    }
}
