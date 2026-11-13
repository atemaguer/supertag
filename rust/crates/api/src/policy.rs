use crate::Api;
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};

impl Api {
    pub fn policy_service(&self) -> policy_catalog_server::PolicyCatalogServer<Self> {
        policy_catalog_server::PolicyCatalogServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

fn client(channel: ProtocolChannel) -> policy_catalog_client::PolicyCatalogClient<ProtocolChannel> {
    policy_catalog_client::PolicyCatalogClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

#[tonic::async_trait]
impl policy_catalog_server::PolicyCatalog for Api {
    async fn put_permission_set(
        &self,
        request: Request<PutPermissionSetRequest>,
    ) -> Result<Response<PermissionSet>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).put_permission_set(request).await },
        )
        .await
    }

    async fn get_permission_set(
        &self,
        request: Request<GetPolicyResourceRequest>,
    ) -> Result<Response<PermissionSet>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).get_permission_set(request).await },
        )
        .await
    }

    async fn list_permission_sets(
        &self,
        request: Request<ListPolicyResourcesRequest>,
    ) -> Result<Response<ListPermissionSetsResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).list_permission_sets(request).await },
        )
        .await
    }

    async fn delete_permission_set(
        &self,
        request: Request<DeletePolicyResourceRequest>,
    ) -> Result<Response<DeletePolicyResourceResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).delete_permission_set(request).await },
        )
        .await
    }

    async fn put_context_set(
        &self,
        request: Request<PutContextSetRequest>,
    ) -> Result<Response<ContextSet>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).put_context_set(request).await },
        )
        .await
    }

    async fn get_context_set(
        &self,
        request: Request<GetPolicyResourceRequest>,
    ) -> Result<Response<ContextSet>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).get_context_set(request).await },
        )
        .await
    }

    async fn list_context_sets(
        &self,
        request: Request<ListPolicyResourcesRequest>,
    ) -> Result<Response<ListContextSetsResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).list_context_sets(request).await },
        )
        .await
    }

    async fn delete_context_set(
        &self,
        request: Request<DeletePolicyResourceRequest>,
    ) -> Result<Response<DeletePolicyResourceResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).delete_context_set(request).await },
        )
        .await
    }

    async fn put_role(&self, request: Request<PutRoleRequest>) -> Result<Response<Role>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).put_role(request).await },
        )
        .await
    }

    async fn get_role(
        &self,
        request: Request<GetPolicyResourceRequest>,
    ) -> Result<Response<Role>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).get_role(request).await },
        )
        .await
    }

    async fn list_roles(
        &self,
        request: Request<ListPolicyResourcesRequest>,
    ) -> Result<Response<ListRolesResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).list_roles(request).await },
        )
        .await
    }

    async fn assign_role(
        &self,
        request: Request<AssignRoleRequest>,
    ) -> Result<Response<RoleAssignment>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).assign_role(request).await },
        )
        .await
    }

    async fn list_role_assignments(
        &self,
        request: Request<ListRoleAssignmentsRequest>,
    ) -> Result<Response<ListRoleAssignmentsResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).list_role_assignments(request).await },
        )
        .await
    }

    async fn deactivate_role_assignment(
        &self,
        request: Request<DeactivateRoleAssignmentRequest>,
    ) -> Result<Response<RoleAssignment>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).deactivate_role_assignment(request).await },
        )
        .await
    }
}
