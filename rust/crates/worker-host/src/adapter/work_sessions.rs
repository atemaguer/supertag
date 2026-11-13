use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        AskWorkSessionQuestionRequest, ContinueWorkSessionRequest,
        HarnessAskWorkSessionQuestionRequest, HarnessContinueWorkSessionRequest,
        HarnessStartWorkSessionRequest, StartWorkSessionRequest, WorkSession, WorkSessionQuestion,
        harness_work_sessions_server::{HarnessWorkSessions, HarnessWorkSessionsServer},
    },
};
use tonic::{Request, Response, Status};

use super::Bridge;

impl Bridge {
    pub(super) fn work_sessions_service(&self) -> HarnessWorkSessionsServer<Self> {
        HarnessWorkSessionsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
// Each Work Session call carries an operation ID that the Control Plane replays,
// so a call whose answer a Gateway partition lost is retried within authority.
impl HarnessWorkSessions for Bridge {
    async fn r#continue(
        &self,
        request: Request<HarnessContinueWorkSessionRequest>,
    ) -> Result<Response<WorkSession>, Status> {
        self.authenticate(&request)?;
        self.require_attached()?;
        let state = self.state.lock().await;
        if state.outcome.is_some() {
            return Err(Status::failed_precondition("execution is complete"));
        }
        let input = request.into_inner();
        let upstream = ContinueWorkSessionRequest {
            attempt: Some(self.attempt()),
            operation_id: input.operation_id,
            work_session_id: input.work_session_id,
            message: self.redact(&input.message),
        };
        let response = self
            .retry(upstream, |request| {
                let mut client = self.coordination.work_sessions.clone();
                async move { client.r#continue(request).await }
            })
            .await;
        drop(state);
        response
    }

    async fn ask(
        &self,
        request: Request<HarnessAskWorkSessionQuestionRequest>,
    ) -> Result<Response<WorkSessionQuestion>, Status> {
        self.authenticate(&request)?;
        self.require_attached()?;
        let state = self.state.lock().await;
        if state.outcome.is_some() {
            return Err(Status::failed_precondition("execution is complete"));
        }
        let input = request.into_inner();
        let upstream = AskWorkSessionQuestionRequest {
            attempt: Some(self.attempt()),
            operation_id: input.operation_id,
            text: self.redact(&input.text),
        };
        let response = self
            .retry(upstream, |request| {
                let mut client = self.coordination.work_sessions.clone();
                async move { client.ask(request).await }
            })
            .await;
        drop(state);
        response
    }

    async fn start(
        &self,
        request: Request<HarnessStartWorkSessionRequest>,
    ) -> Result<Response<WorkSession>, Status> {
        self.authenticate(&request)?;
        self.require_attached()?;
        // Keep completion ordered after this effect. The native adapter supplies
        // intent only; its Task and Attempt identity come from the bound bridge.
        let state = self.state.lock().await;
        if state.outcome.is_some() {
            return Err(Status::failed_precondition("execution is complete"));
        }
        let input = request.into_inner();
        let upstream = StartWorkSessionRequest {
            attempt: Some(self.attempt()),
            operation_id: input.operation_id,
            title: self.redact(&input.title),
            instruction: self.redact(&input.instruction),
            workspace_id: input.workspace_id,
            target_tag_id: input.target_tag_id,
        };
        let response = self
            .retry(upstream, |request| {
                let mut client = self.coordination.work_sessions.clone();
                async move { client.start(request).await }
            })
            .await;
        drop(state);
        response
    }
}
