use super::*;
use supertag_protocol::v2::{
    placement_client::PlacementClient,
    placement_server::{Placement, PlacementServer},
};

impl Gateway {
    pub fn placement_service(&self) -> PlacementServer<Self> {
        PlacementServer::new(self.clone()).max_decoding_message_size(MAX_MESSAGE_BYTES)
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
