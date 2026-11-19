use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};

use crate::Api;

impl Api {
    pub fn schedules_service(&self) -> schedules_server::SchedulesServer<Self> {
        schedules_server::SchedulesServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn attempt_schedules_service(
        &self,
    ) -> attempt_schedules_server::AttemptSchedulesServer<Self> {
        attempt_schedules_server::AttemptSchedulesServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

/// Forwards an operator or client call to the state owner's Schedules service.
macro_rules! schedules {
    ($self:ident, $request:ident, $method:ident) => {
        $self
            .forward($request, |channel, request| async {
                schedules_client::SchedulesClient::new(channel)
                    .max_decoding_message_size(MAX_MESSAGE_BYTES)
                    .max_encoding_message_size(MAX_MESSAGE_BYTES)
                    .$method(request)
                    .await
            })
            .await
    };
}

#[tonic::async_trait]
impl schedules_server::Schedules for Api {
    async fn create(
        &self,
        request: Request<CreateScheduleRequest>,
    ) -> Result<Response<Schedule>, Status> {
        schedules!(self, request, create)
    }

    async fn get(
        &self,
        request: Request<GetScheduleRequest>,
    ) -> Result<Response<Schedule>, Status> {
        schedules!(self, request, get)
    }

    async fn list(
        &self,
        request: Request<ListSchedulesRequest>,
    ) -> Result<Response<ListSchedulesResponse>, Status> {
        schedules!(self, request, list)
    }

    async fn pause(
        &self,
        request: Request<GetScheduleRequest>,
    ) -> Result<Response<Schedule>, Status> {
        schedules!(self, request, pause)
    }

    async fn resume(
        &self,
        request: Request<GetScheduleRequest>,
    ) -> Result<Response<Schedule>, Status> {
        schedules!(self, request, resume)
    }

    async fn delete(
        &self,
        request: Request<GetScheduleRequest>,
    ) -> Result<Response<Schedule>, Status> {
        schedules!(self, request, delete)
    }

    async fn put(
        &self,
        request: Request<PutScheduleRequest>,
    ) -> Result<Response<Schedule>, Status> {
        schedules!(self, request, put)
    }

    async fn backfill(
        &self,
        request: Request<BackfillScheduleRequest>,
    ) -> Result<Response<BackfillScheduleResponse>, Status> {
        schedules!(self, request, backfill)
    }
}

#[tonic::async_trait]
impl attempt_schedules_server::AttemptSchedules for Api {
    async fn create(
        &self,
        request: Request<CreateAttemptScheduleRequest>,
    ) -> Result<Response<AttemptScheduleResponse>, Status> {
        self.forward_attempt(request, |channel, request| async {
            attempt_schedules_client::AttemptSchedulesClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .create(request)
                .await
        })
        .await
    }

    async fn cancel(
        &self,
        request: Request<CancelAttemptScheduleRequest>,
    ) -> Result<Response<AttemptScheduleResponse>, Status> {
        self.forward_attempt(request, |channel, request| async {
            attempt_schedules_client::AttemptSchedulesClient::new(channel)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .cancel(request)
                .await
        })
        .await
    }
}
