use super::*;
use supertag_protocol::v2::{
    auth_keys_client::AuthKeysClient,
    auth_keys_server::{AuthKeys, AuthKeysServer},
    host_credentials_client::HostCredentialsClient,
    host_credentials_server::{HostCredentials, HostCredentialsServer},
    placement_client::PlacementClient,
    placement_server::{Placement, PlacementServer},
};

impl Api {
    pub fn placement_service(&self) -> PlacementServer<Self> {
        PlacementServer::new(self.clone()).max_decoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn auth_keys_service(&self) -> AuthKeysServer<Self> {
        AuthKeysServer::new(self.clone()).max_decoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn host_credentials_service(&self) -> HostCredentialsServer<Self> {
        HostCredentialsServer::new(self.clone()).max_decoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl HostCredentials for Api {
    async fn rotate_host_credential(
        &self,
        request: Request<RotateHostCredentialRequest>,
    ) -> Result<Response<HostCredentialRotation>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async move {
                HostCredentialsClient::new(channel)
                    .rotate_host_credential(request)
                    .await
            },
        )
        .await
    }
}

#[tonic::async_trait]
impl AuthKeys for Api {
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

    async fn list_auth_keys(
        &self,
        request: Request<ListAuthKeysRequest>,
    ) -> Result<Response<ListAuthKeysResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async move {
                AuthKeysClient::new(channel).list_auth_keys(request).await
            },
        )
        .await
    }

    async fn get_auth_key(
        &self,
        request: Request<GetAuthKeyRequest>,
    ) -> Result<Response<AuthKey>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async move { AuthKeysClient::new(channel).get_auth_key(request).await },
        )
        .await
    }
}

#[tonic::async_trait]
impl Placement for Api {
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
