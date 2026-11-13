use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        Approval, ApprovalState, HarnessPostWorkstreamRequest, HarnessReadMailboxRequest,
        HarnessReadWorkstreamRequest, HarnessSendTagMessageRequest, ListMailboxMessagesResponse,
        PostAttemptWorkstreamRequest, PostAttemptWorkstreamResponse, ReadAttemptWorkstreamRequest,
        ReadAttemptWorkstreamResponse, ReadMailboxRequest, SendAttemptTagMessageRequest,
        SendTagMessageResponse,
        harness_mailbox_server::{HarnessMailbox, HarnessMailboxServer},
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

    pub(super) fn mailbox_service(&self) -> HarnessMailboxServer<Self> {
        HarnessMailboxServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    fn record_pending(
        &self,
        state: &mut super::RunState,
        approval: Option<&Approval>,
    ) -> Result<(), Status> {
        if let Some(approval) = approval
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
        Ok(())
    }
}

#[tonic::async_trait]
impl HarnessWorkstreams for Bridge {
    async fn read(
        &self,
        request: Request<HarnessReadWorkstreamRequest>,
    ) -> Result<Response<ReadAttemptWorkstreamResponse>, Status> {
        self.authenticate(&request)?;
        self.require_attached()?;
        let state = self.state.lock().await;
        if state.outcome.is_some() {
            return Err(Status::failed_precondition("execution is complete"));
        }
        let input = request.into_inner();
        // Reads are repeated freely; a post carries an operation ID the Control
        // Plane replays, so both ride out a Gateway partition within authority.
        let upstream = ReadAttemptWorkstreamRequest {
            attempt: Some(self.attempt()),
            after_sequence: input.after_sequence,
            limit: input.limit,
            cursor: input.cursor,
        };
        self.retry(upstream, |request| {
            let mut client = self.coordination.workstreams.clone();
            async move { client.read_attempt_workstream(request).await }
        })
        .await
    }
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
        let upstream = PostAttemptWorkstreamRequest {
            attempt: Some(self.attempt()),
            operation_id: input.operation_id,
            body: input.body,
            to_tag_ids: input.to_tag_ids,
        };
        let post = self
            .retry(upstream, |request| {
                let mut client = self.coordination.workstreams.clone();
                async move { client.post_attempt_workstream(request).await }
            })
            .await?;
        self.record_pending(&mut state, post.get_ref().approval.as_ref())?;
        Ok(post)
    }
}

#[tonic::async_trait]
impl HarnessMailbox for Bridge {
    async fn read_review_patch(
        &self,
        request: Request<supertag_protocol::v2::HarnessReadReviewPatchRequest>,
    ) -> Result<Response<supertag_protocol::v2::HarnessReviewPatch>, Status> {
        self.review_patch(request).await
    }

    async fn send_message(
        &self,
        request: Request<HarnessSendTagMessageRequest>,
    ) -> Result<Response<SendTagMessageResponse>, Status> {
        self.authenticate(&request)?;
        self.require_attached()?;
        let mut state = self.state.lock().await;
        if state.outcome.is_some() {
            return Err(Status::failed_precondition("execution is complete"));
        }
        let input = request.into_inner();
        // The Control Plane replays a send by its operation ID.
        let upstream = SendAttemptTagMessageRequest {
            attempt: Some(self.attempt()),
            operation_id: input.operation_id,
            recipient_tag_id: input.recipient_tag_id,
            text: input.text,
            review: input.review,
        };
        let sent = self
            .retry(upstream, |request| {
                let mut client = self.coordination.mailbox.clone();
                async move { client.send_message(request).await }
            })
            .await?;
        self.record_pending(&mut state, sent.get_ref().approval.as_ref())?;
        Ok(sent)
    }
    async fn read(
        &self,
        request: Request<HarnessReadMailboxRequest>,
    ) -> Result<Response<ListMailboxMessagesResponse>, Status> {
        self.authenticate(&request)?;
        self.require_attached()?;
        let state = self.state.lock().await;
        if state.outcome.is_some() {
            return Err(Status::failed_precondition("execution is complete"));
        }
        let input = request.into_inner();
        let upstream = ReadMailboxRequest {
            attempt: Some(self.attempt()),
            limit: input.limit,
            cursor: input.cursor,
        };
        self.retry(upstream, |request| {
            let mut client = self.coordination.mailbox.clone();
            async move { client.read_mailbox(request).await }
        })
        .await
    }
}
