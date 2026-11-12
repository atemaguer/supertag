use std::time::Duration;

use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request,
    v2::{
        ApprovalState, HarnessPostWorkstreamRequest, PostAttemptWorkstreamRequest,
        PostAttemptWorkstreamResponse,
        harness_workstreams_server::{HarnessWorkstreams, HarnessWorkstreamsServer},
    },
};
use tonic::{Request, Response, Status};

use super::Bridge;

impl Bridge {
    pub(super) fn workstreams_service(&self) -> HarnessWorkstreamsServer<Self> {
        HarnessWorkstreamsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl HarnessWorkstreams for Bridge {
    async fn post(
        &self,
        request: Request<HarnessPostWorkstreamRequest>,
    ) -> Result<Response<PostAttemptWorkstreamResponse>, Status> {
        self.authenticate(&request)?;
        self.require_attached()?;
        let mut state = self.state.lock().await;
        if state.outcome.is_some() {
            return Err(Status::failed_precondition(
                "execution is not accepting posts",
            ));
        }
        let input = request.into_inner();
        let mut upstream = authenticated_request(
            PostAttemptWorkstreamRequest {
                attempt: Some(self.attempt()),
                operation_id: input.operation_id,
                body: input.body,
                to_tag_ids: input.to_tag_ids,
            },
            &self.host_token,
            None,
        )?;
        upstream.set_timeout(Duration::from_secs(5));
        let post = self
            .workstreams
            .clone()
            .post_attempt_workstream(upstream)
            .await?;
        if let Some(approval) = &post.get_ref().approval
            && approval.state() == ApprovalState::Pending
        {
            if approval.task_id != self.task_id()
                || approval.attempt_id != self.assignment.attempt_id
            {
                return Err(Status::data_loss(
                    "approval response belongs to a different Attempt",
                ));
            }
            state
                .observed_approvals
                .insert(approval.approval_id.clone());
        }
        Ok(post)
    }
}
