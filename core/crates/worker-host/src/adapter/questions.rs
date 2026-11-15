use supertag_protocol::{
    MAX_MESSAGE_BYTES,
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
        // An exact repeat of this Attempt's question returns its durable receipt.
        let ask = AskQuestionRequest {
            attempt: Some(self.attempt()),
            operation_id: input.operation_id,
            text: self.redact(&input.text),
        };
        let question = self
            .retry(ask, |request| {
                let mut host = self.host.clone();
                async move { host.ask_question(request).await }
            })
            .await?;
        drop(state);
        Ok(question)
    }
}
