//! The Attempt's execution lease, which the Worklet holds and renews while a Worker or its own
//! finalization works under it; the `Authority` handle through which a Worker takes every
//! lease-bound action, and the `Lease` it lends the harness bridge; and the `AttemptClient` a
//! Worker's Attempt-scoped data calls go through, each with the Attempt credential.

use std::{path::Path, time::Duration};

use anyhow::{Context, Result};
use supertag_protocol::redaction::SensitiveValue;
use supertag_protocol::v2::{
    AppendEventRequest, AskQuestionRequest, AttemptAuthority, AttemptCapabilities, AttemptHistory,
    CommitContextResolutionRequest, ContextResolutionManifest, GetAttemptCapabilitiesRequest,
    GetAttemptHistoryRequest, GetContextPinsRequest, HarnessCompleteRequest, InspectAttemptRequest,
    ObjectiveQuestion, PublishTaskTextRequest, PublishTaskTextResponse, ReportAppliedLimitsRequest,
    ReportAppliedLimitsResponse, ReportAttemptMilestoneRequest, ReportAttemptMilestoneResponse,
    ReportAttemptUsageRequest, ReportAttemptUsageResponse, ReportNetworkLogRequest,
    ReportNetworkLogResponse, ResolveWorkspaceRefRequest, StartTaskRequest, StartTaskResponse,
    Task, TaskEvent, TaskState,
};
use tokio::time::{self, Instant};
use tokio_util::sync::CancellationToken;
use tonic::{Request, Response, Status};

use crate::{
    RegisteredHost, ensure_attempt, request, retryable,
    worklet::{
        HostToken, cleanup_failure,
        finish::save_finish,
        journal::{Attempt, Journal},
        recovery::{cleanup_terminal, purge_discarded},
        workspaces::Workspaces,
    },
};

/// The lease-bound actions the Worklet takes for a claimed Attempt before it assigns it to a
/// Worker: start it, renew its lease, keep the lease while its checkout is prepared, report what
/// it waits for, finish it with the Worklet's own verdict, and give it back before launch.
pub(crate) struct Authority<'a> {
    host: &'a mut RegisteredHost,
    token: &'a HostToken,
    shutdown: &'a CancellationToken,
    journal: &'a Journal,
    workspaces: &'a Workspaces,
    state_directory: &'a Path,
    once: bool,
}

impl<'a> Authority<'a> {
    pub(crate) fn new(
        (host, token): (&'a mut RegisteredHost, &'a HostToken),
        shutdown: &'a CancellationToken,
        (journal, workspaces): (&'a Journal, &'a Workspaces),
        (state_directory, once): (&'a Path, bool),
    ) -> Self {
        Self {
            host,
            token,
            shutdown,
            journal,
            workspaces,
            state_directory,
            once,
        }
    }

    /// Asks the Control Plane to start the claimed Attempt. The response carries the Attempt
    /// credential the Worker's data calls use.
    pub(crate) async fn start(
        &mut self,
        attempt: &Attempt,
    ) -> Result<Result<StartTaskResponse, Status>> {
        let start = request(
            StartTaskRequest {
                task_id: attempt.task_id.clone(),
                attempt_id: attempt.attempt_id.clone(),
                lease_token: attempt.lease_token.clone(),
            },
            self.token.secret(),
        )?;
        Ok(self
            .host
            .start_task(start)
            .await
            .map(tonic::Response::into_inner))
    }

    /// Reads the claimed Attempt's Task without starting it.
    pub(crate) async fn inspect(&mut self, attempt: &Attempt) -> Result<Result<Task, Status>> {
        let inspect = request(attempt.inspect(), self.token.secret())?;
        Ok(self
            .host
            .inspect_attempt(inspect)
            .await
            .map(tonic::Response::into_inner))
    }

    /// Renews the Attempt's lease once.
    pub(crate) async fn renew(
        &mut self,
        attempt: &Attempt,
    ) -> Result<Result<AttemptAuthority, Status>> {
        let renew = request(attempt.inspect(), self.token.secret())?;
        Ok(self
            .host
            .renew_attempt(renew)
            .await
            .map(tonic::Response::into_inner))
    }

    /// Records the commit a followed branch resolved to for this Attempt's Session.
    pub(crate) async fn resolve_workspace_ref(
        &mut self,
        attempt: &Attempt,
        base_commit: String,
    ) -> Result<Result<Task, Status>> {
        let resolve = request(
            ResolveWorkspaceRefRequest {
                attempt: Some(attempt.inspect()),
                base_commit,
            },
            self.token.secret(),
        )?;
        Ok(self
            .host
            .resolve_workspace_ref(resolve)
            .await
            .map(tonic::Response::into_inner))
    }

    /// Keeps the Attempt's lease while `operation` runs; see `with_authority`.
    pub(crate) async fn keep<T>(
        &mut self,
        attempt: &Attempt,
        cancel: &CancellationToken,
        operation: impl std::future::Future<Output = Result<T, Status>>,
    ) -> Result<(T, Instant), Status> {
        with_authority(
            self.host,
            attempt,
            self.token.secret(),
            self.shutdown,
            cancel,
            operation,
        )
        .await
    }

    /// Records whether the Attempt waits for the Worker Host holding its Session's last delivery.
    pub(crate) async fn report_waiting_for_holder(&mut self, attempt: &Attempt, waiting: bool) {
        report_waiting_for_holder(self.host, attempt, self.token.secret(), waiting).await;
    }

    /// Records the Worklet's own verdict, which it reports with Finish.
    pub(crate) fn finish(&self, attempt: Attempt, outcome: HarnessCompleteRequest) -> Result<()> {
        save_finish(self.journal, attempt, outcome)
    }

    /// Leaves an unstarted reservation, which never launched anything, for the Control Plane's
    /// lease expiry to put back in the queue, and ends its local state.
    pub(crate) fn release_unstarted(&self) -> Result<()> {
        self.journal.clear()
    }

    /// Gives back an Attempt whose lease ended before anything launched, and ends its local
    /// state.
    pub(crate) fn discard_prelaunch(&self, attempt: &Attempt) -> Result<()> {
        let prepared = self
            .journal
            .load()?
            .map(|entry| entry.prepared(attempt))
            .transpose()?
            .flatten();
        let discarded = cleanup_terminal(
            self.journal,
            self.workspaces,
            self.state_directory,
            attempt,
            prepared.as_deref(),
        )?;
        purge_discarded(discarded, self.once);
        Ok(())
    }
}

/// The Attempt-scoped data calls a Worker makes to the Control Plane: events, text, questions,
/// usage, milestones, its network log, its history and capabilities, and its Context Item pins.
/// It holds no credential: each call carries the Attempt credential, which the Control Plane
/// admits for these calls only. It exposes none of the Worklet's calls (register, claim, start,
/// finish, reclaim, checkpoints) and none of the lease's.
#[derive(Clone)]
pub(crate) struct AttemptClient(RegisteredHost);

impl AttemptClient {
    pub(crate) fn new(client: RegisteredHost) -> Self {
        Self(client)
    }
}

macro_rules! relay {
    ($($(#[$doc:meta])* $name:ident($input:ty) -> $output:ty;)*) => {
        impl AttemptClient {
            $(
                $(#[$doc])*
                pub(crate) async fn $name(
                    &mut self,
                    request: Request<$input>,
                ) -> Result<Response<$output>, Status> {
                    self.0.$name(request).await
                }
            )*
        }
    };
}

relay! {
    get_attempt_capabilities(GetAttemptCapabilitiesRequest) -> AttemptCapabilities;
    get_attempt_history(GetAttemptHistoryRequest) -> AttemptHistory;
    get_context_pins(GetContextPinsRequest) -> ContextResolutionManifest;
    commit_context_resolution(CommitContextResolutionRequest) -> ContextResolutionManifest;
    append_event(AppendEventRequest) -> TaskEvent;
    publish_text(PublishTaskTextRequest) -> PublishTaskTextResponse;
    ask_question(AskQuestionRequest) -> ObjectiveQuestion;
    report_attempt_usage(ReportAttemptUsageRequest) -> ReportAttemptUsageResponse;
    report_attempt_milestone(ReportAttemptMilestoneRequest) -> ReportAttemptMilestoneResponse;
    report_network_log(ReportNetworkLogRequest) -> ReportNetworkLogResponse;
}

/// The lease-bound calls a Worker's harness bridge makes while the harness runs: renew the
/// Attempt's lease, check it is still held, and report the execution limits the adapter
/// applied. In a Worker its Worklet makes them, for the Worker's own Attempt only. Cloneable and
/// `Send`, so the bridge's services each hold one.
#[derive(Clone)]
pub(crate) struct Lease {
    host: RegisteredHost,
    token: crate::worklet::HostSigner,
    attempt: InspectAttemptRequest,
}

impl Lease {
    /// The lease a Worker holds through its Worklet.
    pub(crate) fn through(
        host: RegisteredHost,
        link: crate::local::WorkletLink,
        attempt: InspectAttemptRequest,
    ) -> Self {
        Self {
            host,
            token: crate::worklet::HostSigner::Worklet(link),
            attempt,
        }
    }

    #[cfg(test)]
    pub(crate) fn unconnected(host: RegisteredHost, attempt: InspectAttemptRequest) -> Self {
        Self {
            host,
            token: crate::worklet::HostSigner::Host(HostToken::new("host-token".into())),
            attempt,
        }
    }

    fn request(&self, timeout: Duration) -> Result<Request<InspectAttemptRequest>, Status> {
        let mut request = supertag_protocol::authenticated_request(
            self.attempt.clone(),
            self.token.host()?.secret(),
            None,
        )?;
        request.set_timeout(timeout);
        Ok(request)
    }

    /// The host credential, as a value the harness bridge redacts from what the harness says,
    /// when this process holds it. A Worker does not: its bridge redacts every value shaped like
    /// an enrolled credential instead.
    pub(crate) fn redaction(&self) -> Option<SensitiveValue> {
        match &self.token {
            crate::worklet::HostSigner::Host(token) => {
                Some(SensitiveValue::High(token.secret().to_owned()))
            }
            crate::worklet::HostSigner::Worklet(_) => None,
        }
    }

    /// Renews the Attempt's lease once; the call carries `timeout`.
    pub(crate) async fn renew(&self, timeout: Duration) -> Result<AttemptAuthority, Status> {
        if let crate::worklet::HostSigner::Worklet(link) = &self.token {
            return time::timeout(
                timeout,
                link.host_call(
                    crate::local::HostCall::Renew(crate::local::Proto(self.attempt.clone())),
                    crate::local::Answer::of(),
                ),
            )
            .await
            .map_err(|_| Status::deadline_exceeded("lease renewal timed out"))?;
        }
        let request = self.request(timeout)?;
        Ok(self.host.clone().renew_attempt(request).await?.into_inner())
    }

    /// Reads the Attempt's Task to check the lease is still held; the call carries `timeout`.
    pub(crate) async fn inspect(&self, timeout: Duration) -> Result<Task, Status> {
        if let crate::worklet::HostSigner::Worklet(link) = &self.token {
            return time::timeout(
                timeout,
                link.host_call(
                    crate::local::HostCall::Inspect(crate::local::Proto(self.attempt.clone())),
                    crate::local::Answer::of(),
                ),
            )
            .await
            .map_err(|_| Status::deadline_exceeded("lease inspection timed out"))?;
        }
        let request = self.request(timeout)?;
        Ok(self
            .host
            .clone()
            .inspect_attempt(request)
            .await?
            .into_inner())
    }

    /// Reports the execution limits the adapter applied, as the host, for this lease's Attempt:
    /// whatever credential and Attempt `request` carries are replaced with the host's and the
    /// lease's.
    pub(crate) async fn report_applied_limits(
        &self,
        mut request: Request<ReportAppliedLimitsRequest>,
    ) -> Result<Response<ReportAppliedLimitsResponse>, Status> {
        request.get_mut().attempt = Some(self.attempt.clone());
        if let crate::worklet::HostSigner::Worklet(link) = &self.token {
            return link
                .host_call(
                    crate::local::HostCall::ReportAppliedLimits(crate::local::Proto(
                        request.into_inner(),
                    )),
                    crate::local::Answer::of(),
                )
                .await
                .map(Response::new);
        }
        let bearer = format!("Bearer {}", self.token.host()?.secret())
            .parse::<tonic::metadata::MetadataValue<_>>()
            .map_err(|_| Status::internal("invalid host credential"))?;
        request.metadata_mut().insert("authorization", bearer);
        self.host.clone().report_applied_limits(request).await
    }
}

pub(crate) async fn renew_running_attempt(
    host: &mut RegisteredHost,
    attempt: &Attempt,
    token: &str,
) -> Result<Instant, Status> {
    let sent = Instant::now();
    let response = host
        .renew_attempt(request(attempt.inspect(), token).map_err(|error| {
            crate::failures::noted(Status::internal("invalid authority request"), &error)
        })?)
        .await?
        .into_inner();
    running_until(sent, &response, attempt)
}

/// How long the Attempt's lease lasts, from a renewal sent at `sent`, while its Task runs.
pub(crate) fn running_until(
    sent: Instant,
    response: &AttemptAuthority,
    attempt: &Attempt,
) -> Result<Instant, Status> {
    let task = response
        .task
        .as_ref()
        .ok_or_else(|| Status::data_loss("execution authority has no Task"))?;
    ensure_attempt(task, attempt).map_err(|error| {
        crate::failures::noted(
            Status::data_loss("execution authority has mismatched identity"),
            &error,
        )
    })?;
    if task.state() != TaskState::Running {
        return Err(Status::failed_precondition("execution authority ended"));
    }
    let until = sent
        .checked_add(Duration::from_millis(response.valid_for_ms))
        .ok_or_else(|| Status::data_loss("invalid authority duration"))?;
    if until <= Instant::now() {
        return Err(Status::failed_precondition(AUTHORITY_EXPIRED));
    }
    Ok(until)
}

/// Cleanup continues after authority ends. Only renewal stops on cancellation.
pub(crate) async fn with_cleanup_authority(
    host: &mut RegisteredHost,
    attempt: &Attempt,
    token: &str,
    shutdown: &CancellationToken,
    cleanup: impl std::future::Future<Output = Result<()>>,
) -> Result<()> {
    let (host, attempt, token) = (host.clone(), attempt.clone(), token.to_owned());
    keep_for_cleanup(
        move || {
            let (mut host, attempt, token) = (host.clone(), attempt.clone(), token.clone());
            async move { renew_running_attempt(&mut host, &attempt, &token).await }
        },
        shutdown,
        cleanup,
    )
    .await
}

/// Runs `cleanup` while `renew` keeps the lease, every two seconds, until the lease ends or
/// `shutdown`; cleanup continues after either.
pub(crate) async fn keep_for_cleanup<F>(
    mut renew: impl FnMut() -> F,
    shutdown: &CancellationToken,
    cleanup: impl std::future::Future<Output = Result<()>>,
) -> Result<()>
where
    F: std::future::Future<Output = Result<Instant, Status>>,
{
    let keep_lease = async {
        let mut pulse = time::interval(Duration::from_secs(2));
        pulse.set_missed_tick_behavior(time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => break,
                _ = pulse.tick() => {},
            }
            match renew().await {
                Ok(_) => {}
                Err(error) if retryable(&error) => {}
                Err(_) => break,
            }
        }
    };
    tokio::pin!(cleanup);
    let result = tokio::select! {
        biased;
        result = &mut cleanup => result,
        () = keep_lease => cleanup.await,
    };
    result.context(cleanup_failure::CleanupUnconfirmed::default())
}

/// Keep the execution lease alive during repository preparation and transfer.
/// The operation must observe `cancel` so native Git is reaped before returning.
pub(crate) async fn with_authority<T>(
    host: &mut RegisteredHost,
    attempt: &Attempt,
    token: &str,
    shutdown: &CancellationToken,
    cancel: &CancellationToken,
    operation: impl std::future::Future<Output = Result<T, Status>>,
) -> Result<(T, Instant), Status> {
    let valid_until = renew_running_attempt(host, attempt, token).await?;
    let (host, attempt, token) = (host.clone(), attempt.clone(), token.to_owned());
    keep_authority(
        valid_until,
        move || {
            let (mut host, attempt, token) = (host.clone(), attempt.clone(), token.clone());
            async move { renew_running_attempt(&mut host, &attempt, &token).await }
        },
        Duration::from_secs(2),
        (shutdown, cancel),
        operation,
    )
    .await
}

/// Runs `operation` while `renew` extends authority that lasts until `valid_until`, every
/// `every`. Renewal runs as its own task, so an operation that blocks its thread, such as a
/// large checkout's file I/O, cannot starve the lease it runs under.
pub(crate) async fn keep_authority<T, F>(
    mut valid_until: Instant,
    mut renew: impl FnMut() -> F + Send + 'static,
    every: Duration,
    (shutdown, cancel): (&CancellationToken, &CancellationToken),
    operation: impl std::future::Future<Output = Result<T, Status>>,
) -> Result<(T, Instant), Status>
where
    F: std::future::Future<Output = Result<Instant, Status>> + Send + 'static,
{
    let (renewed, mut renewals) = tokio::sync::watch::channel(Ok(valid_until));
    let stop = shutdown.child_token();
    let renewal = AbortOnDrop(tokio::spawn(async move {
        let mut until = valid_until;
        let mut interval = time::interval(every);
        interval.tick().await;
        loop {
            tokio::select! {
                _ = stop.cancelled() => return,
                _ = interval.tick() => {}
            }
            let outcome = match time::timeout_at(until, renew()).await {
                Ok(Ok(next)) => Ok(next),
                Ok(Err(error)) if retryable(&error) => continue,
                Ok(Err(error)) => Err(error),
                Err(_) => Err(Status::failed_precondition(AUTHORITY_EXPIRED)),
            };
            let ended = outcome.is_err();
            if let Ok(next) = outcome {
                until = next;
            }
            if renewed.send(outcome).is_err() || ended {
                return;
            }
        }
    }));
    tokio::pin!(operation);
    let error = loop {
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => break Status::cancelled("the Worklet is shutting down"),
            _ = time::sleep_until(valid_until) => break Status::failed_precondition(AUTHORITY_EXPIRED),
            result = &mut operation => {
                if let Ok(until) = &*renewals.borrow() {
                    valid_until = valid_until.max(*until);
                }
                // An operation that held its thread past the lease must not report success:
                // the Control Plane already took the Attempt's authority back.
                if Instant::now() >= valid_until {
                    cancel.cancel();
                    return Err(Status::failed_precondition(AUTHORITY_EXPIRED));
                }
                return result.map(|result| (result, valid_until));
            }
            changed = renewals.changed() => {
                if changed.is_err() {
                    break Status::failed_precondition(AUTHORITY_EXPIRED);
                }
                match &*renewals.borrow_and_update() {
                    Ok(until) => valid_until = *until,
                    Err(error) => break error.clone(),
                }
            }
        }
    };
    drop(renewal);
    cancel.cancel();
    let _ = operation.await;
    Err(error)
}

/// What a lapsed execution lease reports.
pub(crate) const AUTHORITY_EXPIRED: &str = "execution authority expired";

/// Aborts a background task when its owner returns early.
pub(crate) struct AbortOnDrop(pub(crate) tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Records on the Task whether its Attempt waits for the Worker Host holding its Session's last
/// delivery. Best effort: a lost report only leaves the reason unshown until the next try.
async fn report_waiting_for_holder(
    host: &mut RegisteredHost,
    attempt: &Attempt,
    token: &str,
    waiting: bool,
) {
    let Ok(report) = request(
        supertag_protocol::v2::ReportWaitingForHolderRequest {
            attempt: Some(attempt.inspect()),
            waiting,
        },
        token,
    ) else {
        return;
    };
    if let Err(error) = host.report_waiting_for_holder(report).await {
        tracing::debug!("could not report waiting for the delivery holder: {error}");
    }
}

#[cfg(test)]
mod authority_tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use tonic::Code;

    use super::*;

    const VALID: Duration = Duration::from_millis(300);

    fn renewing(
        count: Arc<AtomicUsize>,
    ) -> impl FnMut() -> std::future::Ready<Result<Instant, Status>> {
        move || {
            count.fetch_add(1, Ordering::SeqCst);
            std::future::ready(Ok(Instant::now() + VALID))
        }
    }

    // A checkout's file I/O blocked the thread polling the operation for longer than the lease,
    // and the lease lapsed: renewal must not depend on that thread.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn renewal_continues_while_the_operation_blocks_its_thread() {
        let renewals = Arc::new(AtomicUsize::new(0));
        let (shutdown, cancel) = (CancellationToken::new(), CancellationToken::new());
        let result = keep_authority(
            Instant::now() + VALID,
            renewing(renewals.clone()),
            Duration::from_millis(50),
            (&shutdown, &cancel),
            async {
                std::thread::sleep(VALID * 3);
                Ok::<_, Status>("prepared")
            },
        )
        .await;
        let (value, valid_until) = result.expect("authority kept");
        assert_eq!(value, "prepared");
        assert!(valid_until > Instant::now());
        assert!(renewals.load(Ordering::SeqCst) >= 3);
        assert!(!cancel.is_cancelled());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_operation_that_outlives_its_lease_reports_the_lapse() {
        let (shutdown, cancel) = (CancellationToken::new(), CancellationToken::new());
        let result = keep_authority(
            Instant::now() + VALID,
            || std::future::ready(Err::<Instant, _>(Status::unavailable("Control Plane down"))),
            Duration::from_millis(50),
            (&shutdown, &cancel),
            async {
                std::thread::sleep(VALID * 2);
                Ok::<_, Status>(())
            },
        )
        .await;
        let error = result.expect_err("the lease lapsed");
        assert_eq!(error.code(), Code::FailedPrecondition);
        assert_eq!(error.message(), AUTHORITY_EXPIRED);
    }

    #[tokio::test]
    async fn a_refused_renewal_cancels_the_operation() {
        let (shutdown, cancel) = (CancellationToken::new(), CancellationToken::new());
        let stopped = cancel.clone();
        let result = keep_authority(
            Instant::now() + Duration::from_secs(30),
            || {
                std::future::ready(Err::<Instant, _>(Status::failed_precondition(
                    "execution authority ended",
                )))
            },
            Duration::from_millis(20),
            (&shutdown, &cancel),
            async move {
                stopped.cancelled().await;
                Err::<(), _>(Status::cancelled("stopped"))
            },
        )
        .await;
        let error = result.expect_err("authority ended");
        assert_eq!(error.message(), "execution authority ended");
        assert!(cancel.is_cancelled());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_lease_lends_the_host_credential_only_for_redaction() {
        let channel = tonic::transport::Endpoint::from_static("http://127.0.0.1:1").connect_lazy();
        let lease = Lease::unconnected(
            supertag_protocol::v2::worker_host_client::WorkerHostClient::with_interceptor(
                channel,
                crate::HostHeaders::new(1, 2),
            ),
            InspectAttemptRequest::default(),
        );
        assert_eq!(
            supertag_protocol::redaction::redact_text(
                "read host-token from the state directory",
                &[lease
                    .redaction()
                    .expect("the Worklet's lease holds the credential")],
                false
            ),
            "read [REDACTED] from the state directory"
        );
    }
}
