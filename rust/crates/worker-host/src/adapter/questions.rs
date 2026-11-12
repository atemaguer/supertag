use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request,
    v2::{
        AskQuestionRequest, HarnessAskQuestionRequest, ObjectiveQuestion,
        harness_questions_server::{HarnessQuestions, HarnessQuestionsServer},
    },
};
use tonic::{Request, Response, Status};

use super::Bridge;

impl Bridge {
    pub(super) fn questions_service(&self) -> HarnessQuestionsServer<Self> {
        HarnessQuestionsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl HarnessQuestions for Bridge {
    async fn ask_question(
        &self,
        request: Request<HarnessAskQuestionRequest>,
    ) -> Result<Response<ObjectiveQuestion>, Status> {
        self.authenticate(&request)?;
        self.require_attached()?;
        let state = self.state.lock().await;
        if state.outcome.is_some() {
            return Err(Status::failed_precondition(
                "execution is not accepting questions",
            ));
        }
        let input = request.into_inner();
        let mut upstream = authenticated_request(
            AskQuestionRequest {
                attempt: Some(self.attempt()),
                operation_id: input.operation_id,
                text: input.text,
            },
            &self.host_token,
            None,
        )?;
        upstream.set_timeout(std::time::Duration::from_secs(5));
        let question = self.host.clone().ask_question(upstream).await?;
        drop(state);
        Ok(question)
    }
}
