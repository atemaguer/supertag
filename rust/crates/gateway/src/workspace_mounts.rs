use super::*;
use supertag_protocol::v2::{
    attempt_workspace_mounts_client::AttemptWorkspaceMountsClient,
    attempt_workspace_mounts_server::{AttemptWorkspaceMounts, AttemptWorkspaceMountsServer},
    workspace_volumes_client::WorkspaceVolumesClient,
    workspace_volumes_server::{WorkspaceVolumes, WorkspaceVolumesServer},
};

impl Gateway {
    pub fn workspace_volumes_service(&self) -> WorkspaceVolumesServer<Self> {
        WorkspaceVolumesServer::new(self.clone()).max_decoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn attempt_workspace_mounts_service(&self) -> AttemptWorkspaceMountsServer<Self> {
        AttemptWorkspaceMountsServer::new(self.clone()).max_decoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl WorkspaceVolumes for Gateway {
    async fn put(
        &self,
        request: Request<PutWorkspaceVolumeRequest>,
    ) -> Result<Response<WorkspaceVolume>, Status> {
        self.forward(request, &self.credentials.operator, |channel, request| async move {
            WorkspaceVolumesClient::new(channel).put(request).await
        }).await
    }

    async fn get(
        &self,
        request: Request<GetWorkspaceVolumeRequest>,
    ) -> Result<Response<WorkspaceVolume>, Status> {
        self.forward(request, &self.credentials.operator, |channel, request| async move {
            WorkspaceVolumesClient::new(channel).get(request).await
        }).await
    }
}

#[tonic::async_trait]
impl AttemptWorkspaceMounts for Gateway {
    async fn preflight(
        &self,
        request: Request<InspectAttemptRequest>,
    ) -> Result<Response<WorkspaceMountPreflight>, Status> {
        self.forward_host(request, true, |channel, request| async move {
            AttemptWorkspaceMountsClient::new(channel)
                .preflight(request)
                .await
        })
        .await
    }

    async fn record_writes(
        &self,
        request: Request<RecordWorkspaceMountWritesRequest>,
    ) -> Result<Response<RecordWorkspaceMountWritesResponse>, Status> {
        self.forward_host(request, true, |channel, request| async move {
            AttemptWorkspaceMountsClient::new(channel)
                .record_writes(request)
                .await
        })
        .await
    }
}
