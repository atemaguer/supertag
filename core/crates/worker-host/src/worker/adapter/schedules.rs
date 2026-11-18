//! The `schedule` and `cancel_schedule` tools for the supervised Attempt. The Worker Host names
//! the Attempt, so an adapter cannot schedule as another one, and redacts the note.
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        AttemptScheduleResponse, CancelAttemptScheduleRequest, CreateAttemptScheduleRequest,
        harness_schedules_server::{HarnessSchedules, HarnessSchedulesServer},
    },
};
use tonic::{Request, Response, Status};

use super::Bridge;

impl Bridge {
    pub(super) fn schedules_service(&self) -> HarnessSchedulesServer<Self> {
        HarnessSchedulesServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    async fn schedulable(&self) -> Result<(), Status> {
        self.require_attached()?;
        if self.state.lock().await.outcome.is_some() {
            return Err(Status::failed_precondition("execution is complete"));
        }
        Ok(())
    }
}

// The Control Plane replays a creation by its operation ID and a cancellation is idempotent,
// so both are repeated across a Control Plane partition within authority.
#[tonic::async_trait]
impl HarnessSchedules for Bridge {
    async fn create(
        &self,
        request: Request<CreateAttemptScheduleRequest>,
    ) -> Result<Response<AttemptScheduleResponse>, Status> {
        self.authenticate(&request)?;
        self.schedulable().await?;
        let mut input = request.into_inner();
        input.attempt = Some(self.attempt());
        input.note = self.redact(&input.note);
        self.retry(input, |request| {
            let mut client = self.coordination.schedules.clone();
            async move { client.create(request).await }
        })
        .await
    }

    async fn cancel(
        &self,
        request: Request<CancelAttemptScheduleRequest>,
    ) -> Result<Response<AttemptScheduleResponse>, Status> {
        self.authenticate(&request)?;
        self.schedulable().await?;
        let mut input = request.into_inner();
        input.attempt = Some(self.attempt());
        self.retry(input, |request| {
            let mut client = self.coordination.schedules.clone();
            async move { client.cancel(request).await }
        })
        .await
    }
}
