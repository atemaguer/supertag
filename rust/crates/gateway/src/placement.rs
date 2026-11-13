use super::*;
use supertag_protocol::v2::{
    auth_keys_client::AuthKeysClient,
    auth_keys_server::{AuthKeys, AuthKeysServer},
    placement_client::PlacementClient,
    placement_server::{Placement, PlacementServer},
};

impl Gateway {
    pub fn placement_service(&self) -> PlacementServer<Self> {
        PlacementServer::new(self.clone()).max_decoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn auth_keys_service(&self) -> AuthKeysServer<Self> {
        AuthKeysServer::new(self.clone()).max_decoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl AuthKeys for Gateway {
    async fn revoke_auth_key(
        &self,
        request: Request<RevokeAuthKeyRequest>,
    ) -> Result<Response<AuthKey>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async move {
                AuthKeysClient::new(channel).revoke_auth_key(request).await
            },
        )
        .await
    }
}

#[tonic::async_trait]
impl Placement for Gateway {
    async fn set_tag_runs_on(
        &self,
        request: Request<SetTagRunsOnRequest>,
    ) -> Result<Response<Tag>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async move {
                PlacementClient::new(channel).set_tag_runs_on(request).await
            },
        )
        .await
    }

    async fn diagnose_task(
        &self,
        request: Request<DiagnoseTaskPlacementRequest>,
    ) -> Result<Response<TaskPlacementDiagnosis>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async move { PlacementClient::new(channel).diagnose_task(request).await },
        )
        .await
    }
}
