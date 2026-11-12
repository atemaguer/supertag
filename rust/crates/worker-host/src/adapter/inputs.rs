use std::{future::Future, time::Duration};

use supertag_protocol::{
    authenticated_request,
    v2::{
        HarnessSettleLiveInputRequest, InspectAttemptRequest, LiveInput, LiveInputState,
        SettleInputRequest, TakeInputRequest, TakeInputResponse,
    },
};
use tokio::{
    sync::watch,
    time::{self, Instant},
};
use tokio_util::sync::CancellationToken;
use tonic::{Response, Status};

use crate::RegisteredInputs;

const CALL_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub(super) struct InputLane {
    client: RegisteredInputs,
    deadline: watch::Sender<Instant>,
    closed: CancellationToken,
}

impl InputLane {
    pub(super) fn new(
        client: RegisteredInputs,
        deadline: Instant,
        shutdown: &CancellationToken,
    ) -> Self {
        Self {
            client,
            deadline: watch::Sender::new(deadline),
            closed: shutdown.child_token(),
        }
    }

    pub(super) fn close(&self) {
        self.closed.cancel();
    }

    pub(super) fn set_deadline(&self, deadline: Instant) {
        self.deadline.send_replace(deadline);
    }

    pub(super) async fn take(
        &self,
        attempt: InspectAttemptRequest,
        token: &str,
    ) -> Result<Response<TakeInputResponse>, Status> {
        let sent = Instant::now();
        let call_deadline = self.active_deadline()?.min(sent + CALL_TIMEOUT);
        let mut request = authenticated_request(
            TakeInputRequest {
                attempt: Some(attempt.clone()),
            },
            token,
            None,
        )?;
        request.set_timeout(call_deadline.saturating_duration_since(sent));
        let mut client = self.client.clone();
        // Take can commit before its response is lost. The Control Plane never
        // returns that payload a second time, and this bridge does not retry it.
        let mut response = self
            .forward(call_deadline, client.take_input(request))
            .await?
            .into_inner();
        let deadline = self.active_deadline()?;
        let Some(input) = &response.input else {
            return Ok(Response::new(TakeInputResponse::default()));
        };
        if input.task_id != attempt.task_id
            || input.attempt_id != attempt.attempt_id
            || input.state() != LiveInputState::Dispatching
        {
            return Err(Status::data_loss(
                "live input has mismatched Attempt identity or state",
            ));
        }
        let dispatch_deadline = sent
            .checked_add(Duration::from_millis(response.valid_for_ms))
            .ok_or_else(|| Status::data_loss("invalid live input authority duration"))?;
        let remaining = dispatch_deadline
            .min(deadline)
            .saturating_duration_since(Instant::now())
            .as_millis();
        if remaining == 0 {
            return Err(Status::deadline_exceeded(
                "live input dispatch authority expired",
            ));
        }
        response.valid_for_ms = u64::try_from(remaining)
            .map_err(|_| Status::data_loss("invalid live input authority duration"))?;
        Ok(Response::new(response))
    }

    pub(super) async fn settle(
        &self,
        attempt: InspectAttemptRequest,
        request: HarnessSettleLiveInputRequest,
        token: &str,
    ) -> Result<Response<LiveInput>, Status> {
        let sent = Instant::now();
        let deadline = self.active_deadline()?.min(sent + CALL_TIMEOUT);
        let mut upstream = authenticated_request(
            SettleInputRequest {
                attempt: Some(attempt.clone()),
                input_id: request.input_id.clone(),
                receipt: request.receipt,
            },
            token,
            None,
        )?;
        upstream.set_timeout(deadline.saturating_duration_since(sent));
        let mut client = self.client.clone();
        let response = self
            .forward(deadline, client.settle_input(upstream))
            .await?;
        let input = response.get_ref();
        if input.task_id != attempt.task_id
            || input.attempt_id != attempt.attempt_id
            || input.input_id != request.input_id
        {
            return Err(Status::data_loss(
                "live input receipt has mismatched identity",
            ));
        }
        Ok(response)
    }

    fn active_deadline(&self) -> Result<Instant, Status> {
        if self.closed.is_cancelled() {
            return Err(Status::failed_precondition(
                "execution is not accepting live input",
            ));
        }
        let deadline = *self.deadline.borrow();
        if deadline <= Instant::now() {
            return Err(Status::deadline_exceeded("execution authority expired"));
        }
        Ok(deadline)
    }

    async fn forward<T>(
        &self,
        deadline: Instant,
        call: impl Future<Output = Result<Response<T>, Status>> + Send,
    ) -> Result<Response<T>, Status> {
        let response = tokio::select! {
            biased;
            _ = self.closed.cancelled() => Err(Status::failed_precondition("execution is not accepting live input")),
            response = time::timeout_at(deadline, call) => response
                .map_err(|_| Status::deadline_exceeded("live input request timed out"))?,
        }?;
        if Instant::now() >= deadline {
            return Err(Status::deadline_exceeded("live input request timed out"));
        }
        Ok(response)
    }
}
