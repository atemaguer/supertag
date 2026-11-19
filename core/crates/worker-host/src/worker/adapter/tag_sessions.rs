//! The Tag's other Sessions and its Objectives for the supervised Attempt. The Worker Host
//! names the Attempt; an adapter cannot read as another one.
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        ListTagObjectivesRequest, ListTagObjectivesResponse, ListTagSessionsRequest,
        ListTagSessionsResponse, ReadTagObjectiveRequest, ReadTagSessionRequest,
        ReadTagSessionResponse, ReadTagTurnRequest, ReadTagTurnResponse, SearchTagSessionsRequest,
        SearchTagSessionsResponse, TagObjectiveView,
        harness_tag_sessions_server::{HarnessTagSessions, HarnessTagSessionsServer},
    },
};
use tonic::{Request, Response, Status};

use super::Bridge;

impl Bridge {
    pub(super) fn tag_sessions_service(&self) -> HarnessTagSessionsServer<Self> {
        HarnessTagSessionsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    async fn readable(&self) -> Result<(), Status> {
        self.require_attached()?;
        if self.state.lock().await.outcome.is_some() {
            return Err(Status::failed_precondition("execution is complete"));
        }
        Ok(())
    }
}

// Reads are repeated freely across a Control Plane partition within authority. A creation is
// one per Task and the Control Plane replays it, so it is repeated the same way.
#[tonic::async_trait]
impl HarnessTagSessions for Bridge {
    async fn list_sessions(
        &self,
        request: Request<ListTagSessionsRequest>,
    ) -> Result<Response<ListTagSessionsResponse>, Status> {
        self.authenticate(&request)?;
        self.readable().await?;
        let input = request.into_inner();
        self.retry(input, |request| {
            let mut client = self.coordination.tag_sessions.clone();
            async move { client.list_sessions(request).await }
        })
        .await
    }

    async fn search_sessions(
        &self,
        request: Request<SearchTagSessionsRequest>,
    ) -> Result<Response<SearchTagSessionsResponse>, Status> {
        self.authenticate(&request)?;
        self.readable().await?;
        let input = request.into_inner();
        self.retry(input, |request| {
            let mut client = self.coordination.tag_sessions.clone();
            async move { client.search_sessions(request).await }
        })
        .await
    }

    async fn read_session(
        &self,
        request: Request<ReadTagSessionRequest>,
    ) -> Result<Response<ReadTagSessionResponse>, Status> {
        self.authenticate(&request)?;
        self.readable().await?;
        let input = request.into_inner();
        self.retry(input, |request| {
            let mut client = self.coordination.tag_sessions.clone();
            async move { client.read_session(request).await }
        })
        .await
    }

    async fn read_turn(
        &self,
        request: Request<ReadTagTurnRequest>,
    ) -> Result<Response<ReadTagTurnResponse>, Status> {
        self.authenticate(&request)?;
        self.readable().await?;
        let input = request.into_inner();
        self.retry(input, |request| {
            let mut client = self.coordination.tag_sessions.clone();
            async move { client.read_turn(request).await }
        })
        .await
    }

    async fn list_objectives(
        &self,
        request: Request<ListTagObjectivesRequest>,
    ) -> Result<Response<ListTagObjectivesResponse>, Status> {
        self.authenticate(&request)?;
        self.readable().await?;
        let input = request.into_inner();
        self.retry(input, |request| {
            let mut client = self.coordination.tag_sessions.clone();
            async move { client.list_objectives(request).await }
        })
        .await
    }

    async fn read_objective(
        &self,
        request: Request<ReadTagObjectiveRequest>,
    ) -> Result<Response<TagObjectiveView>, Status> {
        self.authenticate(&request)?;
        self.readable().await?;
        let input = request.into_inner();
        self.retry(input, |request| {
            let mut client = self.coordination.tag_sessions.clone();
            async move { client.read_objective(request).await }
        })
        .await
    }
}
