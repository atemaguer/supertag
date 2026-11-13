use std::time::Duration;

use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request,
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
        let mut upstream = authenticated_request(
            ContinueWorkSessionRequest {
                attempt: Some(self.attempt()),
                operation_id: input.operation_id,
                work_session_id: input.work_session_id,
                message: self.redact(&input.message),
            },
            &self.host_token,
            None,
        )?;
        upstream.set_timeout(Duration::from_secs(5));
        let response = self
            .coordination
            .work_sessions
            .clone()
            .r#continue(upstream)
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
        let mut upstream = authenticated_request(
            AskWorkSessionQuestionRequest {
                attempt: Some(self.attempt()),
                operation_id: input.operation_id,
                text: self.redact(&input.text),
            },
            &self.host_token,
            None,
        )?;
        upstream.set_timeout(Duration::from_secs(5));
        let response = self.coordination.work_sessions.clone().ask(upstream).await;
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
        let mut upstream = authenticated_request(
            StartWorkSessionRequest {
                attempt: Some(self.attempt()),
                operation_id: input.operation_id,
                title: self.redact(&input.title),
                instruction: self.redact(&input.instruction),
                workspace_id: input.workspace_id,
                target_tag_id: input.target_tag_id,
            },
            &self.host_token,
            None,
        )?;
        upstream.set_timeout(Duration::from_secs(5));
        let response = self
            .coordination
            .work_sessions
            .clone()
            .start(upstream)
            .await;
        drop(state);
        response
    }
}
