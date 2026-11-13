use crate::Api;
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};

impl Api {
    pub fn surface_policy_service(
        &self,
    ) -> surface_policy_catalog_server::SurfacePolicyCatalogServer<Self> {
        surface_policy_catalog_server::SurfacePolicyCatalogServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

fn client(
    channel: ProtocolChannel,
) -> surface_policy_catalog_client::SurfacePolicyCatalogClient<ProtocolChannel> {
    surface_policy_catalog_client::SurfacePolicyCatalogClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

#[tonic::async_trait]
impl surface_policy_catalog_server::SurfacePolicyCatalog for Api {
    async fn put_surface_account(
        &self,
        request: Request<PutSurfaceAccountRequest>,
    ) -> Result<Response<SurfaceAccount>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).put_surface_account(request).await },
        )
        .await
    }

    async fn get_surface_account(
        &self,
        request: Request<GetSurfaceAccountRequest>,
    ) -> Result<Response<SurfaceAccount>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).get_surface_account(request).await },
        )
        .await
    }

    async fn list_surface_accounts(
        &self,
        request: Request<ListSurfaceAccountsRequest>,
    ) -> Result<Response<ListSurfaceAccountsResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).list_surface_accounts(request).await },
        )
        .await
    }

    async fn put_surface_location(
        &self,
        request: Request<PutSurfaceLocationRequest>,
    ) -> Result<Response<SurfaceLocation>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).put_surface_location(request).await },
        )
        .await
    }

    async fn get_surface_location(
        &self,
        request: Request<GetSurfaceLocationRequest>,
    ) -> Result<Response<SurfaceLocation>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).get_surface_location(request).await },
        )
        .await
    }

    async fn list_surface_locations(
        &self,
        request: Request<ListSurfaceLocationsRequest>,
    ) -> Result<Response<ListSurfaceLocationsResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).list_surface_locations(request).await },
        )
        .await
    }

    async fn delete_surface_location(
        &self,
        request: Request<DeleteSurfaceLocationRequest>,
    ) -> Result<Response<DeletePolicyResourceResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { client(channel).delete_surface_location(request).await },
        )
        .await
    }
}
