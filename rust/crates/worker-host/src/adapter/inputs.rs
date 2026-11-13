use std::{future::Future, time::Duration};

use supertag_protocol::{
    authenticated_request,
    v2::{
        HarnessSettleLiveInputRequest, InspectAttemptRequest, LiveInput, LiveInputReceipt,
        LiveInputState, SettleInputRequest, TakeInputRequest, TakeInputResponse,
    },
};
use tokio::{
    sync::watch,
    time::{self, Instant},
};
use tokio_util::sync::CancellationToken;
use tonic::{Request, Response, Status};

use crate::RegisteredInputs;

const CALL_TIMEOUT: Duration = Duration::from_secs(5);
const RETRY_PAUSE: Duration = Duration::from_millis(250);

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

    pub(super) fn authority(&self) -> (watch::Receiver<Instant>, CancellationToken) {
        (self.deadline.subscribe(), self.closed.clone())
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
            // The Control Plane committed this take, but its dispatch authority
            // ended before the adapter could receive it. Nothing reached the
            // harness, so record it Rejected (its follower runs as ordinary
            // work) instead of letting it lapse to Unknown, and report an empty
            // take. Only when that receipt cannot be recorded does it lapse.
            let input_id = input.input_id.clone();
            return match self
                .settle_once(attempt, input_id, LiveInputReceipt::Rejected, token)
                .await
            {
                Ok(()) => Ok(Response::new(TakeInputResponse::default())),
                Err(_) => Err(Status::deadline_exceeded(
                    "live input dispatch authority expired",
                )),
            };
        }
        response.valid_for_ms = u64::try_from(remaining)
            .map_err(|_| Status::data_loss("invalid live input authority duration"))?;
        Ok(Response::new(response))
    }

    /// Records one receipt with a single bounded try, for an input the adapter
    /// never received.
    async fn settle_once(
        &self,
        attempt: InspectAttemptRequest,
        input_id: String,
        receipt: LiveInputReceipt,
        token: &str,
    ) -> Result<(), Status> {
        let mut request = authenticated_request(
            SettleInputRequest {
                attempt: Some(attempt),
                input_id,
                receipt: receipt.into(),
            },
            token,
            None,
        )?;
        request.set_timeout(CALL_TIMEOUT);
        let settled = time::timeout(CALL_TIMEOUT, self.client.clone().settle_input(request))
            .await
            .map_err(|_| Status::deadline_exceeded("live input receipt timed out"))??;
        if settled.get_ref().state() == LiveInputState::Rejected {
            Ok(())
        } else {
            Err(Status::failed_precondition("live input was not rejected"))
        }
    }

    pub(super) async fn settle(
        &self,
        attempt: InspectAttemptRequest,
        request: HarnessSettleLiveInputRequest,
        token: &str,
    ) -> Result<Response<LiveInput>, Status> {
        // A receipt is idempotent: the Control Plane accepts the same receipt
        // again, so a settlement whose answer a partition lost is repeated
        // while execution authority lasts. Take is never repeated (above).
        let settle = SettleInputRequest {
            attempt: Some(attempt.clone()),
            input_id: request.input_id.clone(),
            receipt: request.receipt,
        };
        let response = self
            .retry(settle, token, |upstream| {
                let mut client = self.client.clone();
                async move { client.settle_input(upstream).await }
            })
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

    /// Repeats one upstream call while execution authority lasts. Use it only
    /// for calls the Control Plane deduplicates (an operation ID, a usage
    /// sequence, an exact receipt) or that only read, so a call whose answer
    /// the transport lost is safely sent again. Each try is bounded to
    /// `CALL_TIMEOUT`; a refusal from the Control Plane is returned at once,
    /// and the call stops when the execution closes or its authority ends.
    pub(super) async fn retry<M, R, F, Fut>(
        &self,
        message: M,
        token: &str,
        mut call: F,
    ) -> Result<Response<R>, Status>
    where
        M: Clone,
        F: FnMut(Request<M>) -> Fut,
        Fut: Future<Output = Result<Response<R>, Status>>,
    {
        loop {
            let deadline = self.active_deadline()?;
            let sent = Instant::now();
            let attempt_deadline = deadline.min(sent + CALL_TIMEOUT);
            let mut upstream = authenticated_request(message.clone(), token, None)?;
            upstream.set_timeout(attempt_deadline.saturating_duration_since(sent));
            // The channel would otherwise hold a call across a broken connection
            // for its whole endpoint timeout; bound each try here instead.
            let outcome = tokio::select! {
                biased;
                _ = self.closed.cancelled() => Err(Status::failed_precondition("execution is complete")),
                outcome = time::timeout_at(attempt_deadline, call(upstream)) => outcome
                    .unwrap_or_else(|_| Err(Status::deadline_exceeded("upstream call timed out"))),
            };
            match outcome {
                Ok(response) => return Ok(response),
                Err(error) if crate::retryable(&error) => {
                    let authority = self.active_deadline()?;
                    time::sleep_until(authority.min(Instant::now() + RETRY_PAUSE)).await;
                }
                Err(error) => return Err(error),
            }
        }
    }

    pub(super) fn active_deadline(&self) -> Result<Instant, Status> {
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

    pub(super) async fn forward<T>(
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

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };

    use supertag_protocol::v2::{
        attempt_inputs_client::AttemptInputsClient,
        attempt_inputs_server::{AttemptInputs, AttemptInputsServer},
    };
    use tokio::net::TcpListener;
    use tokio_stream::wrappers::TcpListenerStream;
    use tonic::{Request, transport::Server};

    use super::*;

    /// A Control Plane input lane whose take returns `valid_for_ms` and whose
    /// settlement fails `unavailable` times before recording the receipt.
    #[derive(Clone)]
    struct FakeInputs {
        valid_for_ms: u64,
        unavailable: Arc<AtomicUsize>,
        settlements: Arc<Mutex<Vec<i32>>>,
    }

    fn input(state: LiveInputState) -> LiveInput {
        LiveInput {
            input_id: "input-1".into(),
            task_id: "task-1".into(),
            attempt_id: "attempt-1".into(),
            follower_task_id: "follower-1".into(),
            text: "Check the API".into(),
            state: state.into(),
            order: 1,
        }
    }

    #[tonic::async_trait]
    impl AttemptInputs for FakeInputs {
        async fn take_input(
            &self,
            _request: Request<TakeInputRequest>,
        ) -> Result<Response<TakeInputResponse>, Status> {
            Ok(Response::new(TakeInputResponse {
                input: Some(input(LiveInputState::Dispatching)),
                valid_for_ms: self.valid_for_ms,
            }))
        }

        async fn settle_input(
            &self,
            request: Request<SettleInputRequest>,
        ) -> Result<Response<LiveInput>, Status> {
            let receipt = request.into_inner().receipt;
            self.settlements.lock().unwrap().push(receipt);
            if self
                .unavailable
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                    left.checked_sub(1)
                })
                .is_ok()
            {
                return Err(Status::unavailable("Control Plane partitioned"));
            }
            let state = match LiveInputReceipt::try_from(receipt).unwrap() {
                LiveInputReceipt::Accepted => LiveInputState::Accepted,
                _ => LiveInputState::Rejected,
            };
            Ok(Response::new(input(state)))
        }
    }

    async fn lane(fake: FakeInputs) -> (InputLane, CancellationToken) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(
            Server::builder()
                .add_service(AttemptInputsServer::new(fake))
                .serve_with_incoming(TcpListenerStream::new(listener)),
        );
        let channel = tonic::transport::Endpoint::from_shared(format!("http://{address}"))
            .unwrap()
            .connect_lazy();
        let client = AttemptInputsClient::with_interceptor(channel, crate::HostHeaders::new(1, 2));
        let shutdown = CancellationToken::new();
        let lane = InputLane::new(client, Instant::now() + Duration::from_secs(30), &shutdown);
        (lane, shutdown)
    }

    fn attempt() -> InspectAttemptRequest {
        InspectAttemptRequest {
            task_id: "task-1".into(),
            attempt_id: "attempt-1".into(),
            lease_token: "lease-1".into(),
        }
    }

    #[tokio::test]
    async fn settlement_is_repeated_through_a_partition() {
        let fake = FakeInputs {
            valid_for_ms: 10_000,
            unavailable: Arc::new(AtomicUsize::new(2)),
            settlements: Arc::default(),
        };
        let (lane, _shutdown) = lane(fake.clone()).await;
        let settled = lane
            .settle(
                attempt(),
                HarnessSettleLiveInputRequest {
                    input_id: "input-1".into(),
                    receipt: LiveInputReceipt::Accepted.into(),
                },
                "host-token",
            )
            .await
            .unwrap();
        assert_eq!(settled.get_ref().state(), LiveInputState::Accepted);
        assert_eq!(
            *fake.settlements.lock().unwrap(),
            vec![LiveInputReceipt::Accepted as i32; 3]
        );
    }

    #[tokio::test]
    async fn settlement_stops_when_the_execution_closes() {
        let fake = FakeInputs {
            valid_for_ms: 10_000,
            unavailable: Arc::new(AtomicUsize::new(usize::MAX)),
            settlements: Arc::default(),
        };
        let (lane, _shutdown) = lane(fake).await;
        let closer = lane.clone();
        tokio::spawn(async move {
            time::sleep(Duration::from_millis(600)).await;
            closer.close();
        });
        let refused = lane
            .settle(
                attempt(),
                HarnessSettleLiveInputRequest {
                    input_id: "input-1".into(),
                    receipt: LiveInputReceipt::Accepted.into(),
                },
                "host-token",
            )
            .await
            .unwrap_err();
        assert_eq!(refused.code(), tonic::Code::FailedPrecondition);
    }

    #[tokio::test]
    async fn a_take_whose_dispatch_authority_expired_is_recorded_rejected() {
        let fake = FakeInputs {
            valid_for_ms: 0,
            unavailable: Arc::default(),
            settlements: Arc::default(),
        };
        let (lane, _shutdown) = lane(fake.clone()).await;
        let taken = lane.take(attempt(), "host-token").await.unwrap();
        assert!(taken.get_ref().input.is_none());
        assert_eq!(
            *fake.settlements.lock().unwrap(),
            vec![LiveInputReceipt::Rejected as i32]
        );
    }

    #[tokio::test]
    async fn an_expired_take_that_cannot_be_rejected_lapses() {
        let fake = FakeInputs {
            valid_for_ms: 0,
            unavailable: Arc::new(AtomicUsize::new(1)),
            settlements: Arc::default(),
        };
        let (lane, _shutdown) = lane(fake).await;
        let lapsed = lane.take(attempt(), "host-token").await.unwrap_err();
        assert_eq!(lapsed.code(), tonic::Code::DeadlineExceeded);
    }
}
