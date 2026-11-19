//! The `remember` and `forget` tools for the supervised Attempt. The Worker Host names the
//! Attempt, so an adapter cannot keep notes as another one, and redacts the note.
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        AttemptForgetRequest, AttemptMemoryResponse, AttemptRememberRequest,
        harness_memory_server::{HarnessMemory, HarnessMemoryServer},
    },
};
use tonic::{Request, Response, Status};

use super::Bridge;

impl Bridge {
    pub(super) fn memory_service(&self) -> HarnessMemoryServer<Self> {
        HarnessMemoryServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    async fn rememberable(&self) -> Result<(), Status> {
        self.require_attached()?;
        if self.state.lock().await.outcome.is_some() {
            return Err(Status::failed_precondition("execution is complete"));
        }
        Ok(())
    }
}

// The Control Plane replays both calls by their operation IDs, so they are repeated across a
// Control Plane partition within authority.
#[tonic::async_trait]
impl HarnessMemory for Bridge {
    async fn remember(
        &self,
        request: Request<AttemptRememberRequest>,
    ) -> Result<Response<AttemptMemoryResponse>, Status> {
        self.authenticate(&request)?;
        self.rememberable().await?;
        let mut input = request.into_inner();
        input.text = self.redact(&input.text);
        self.retry(input, |request| {
            let mut client = self.coordination.memory.clone();
            async move { client.remember(request).await }
        })
        .await
    }

    async fn forget(
        &self,
        request: Request<AttemptForgetRequest>,
    ) -> Result<Response<AttemptMemoryResponse>, Status> {
        self.authenticate(&request)?;
        self.rememberable().await?;
        let input = request.into_inner();
        self.retry(input, |request| {
            let mut client = self.coordination.memory.clone();
            async move { client.forget(request).await }
        })
        .await
    }
}
