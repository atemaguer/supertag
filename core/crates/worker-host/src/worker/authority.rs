//! A Worker's lease-bound actions, which its Worklet takes for it over the local contract: keep
//! the Attempt's lease while an operation or a cleanup runs, lend the harness bridge a `Lease`,
//! report the stages it reaches, and hand over the outcome the Worklet finishes the Attempt with.
//! None of them reaches the host credential.

use std::time::Duration;

use anyhow::Result;
use supertag_protocol::v2::{AttemptAuthority, HarnessCompleteRequest, HostRecord};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tonic::Status;

use crate::{
    RegisteredHost,
    local::{Answer, Completion, HostCall, Milestone, Outcome, Proto, WorkletLink},
    worklet::{
        authority::{Lease, keep_authority, keep_for_cleanup, running_until},
        journal::{Attempt, AttemptJournal},
    },
};

/// Renews the Attempt's lease once, through the Worklet.
async fn renew(link: WorkletLink, attempt: Attempt) -> Result<Instant, Status> {
    let sent = Instant::now();
    let response: AttemptAuthority = tokio::time::timeout(
        Duration::from_secs(10),
        link.host_call(HostCall::Renew(Proto(attempt.inspect())), Answer::of()),
    )
    .await
    .map_err(|_| Status::deadline_exceeded("lease renewal timed out"))??;
    running_until(sent, &response, &attempt)
}

pub(crate) struct WorkerAuthority<'a> {
    link: WorkletLink,
    host: RegisteredHost,
    registration: &'a HostRecord,
    journal: AttemptJournal<'a>,
    shutdown: &'a CancellationToken,
    /// The Worker's own verdict, recorded where the run decides it and handed over when the run
    /// returns.
    verdict: std::sync::Mutex<Option<HarnessCompleteRequest>>,
    /// Whether the outcome was handed over already.
    handed: std::sync::atomic::AtomicBool,
}

impl<'a> WorkerAuthority<'a> {
    pub(crate) fn new(
        link: WorkletLink,
        host: RegisteredHost,
        registration: &'a HostRecord,
        journal: AttemptJournal<'a>,
        shutdown: &'a CancellationToken,
    ) -> Self {
        Self {
            link,
            host,
            registration,
            journal,
            shutdown,
            verdict: std::sync::Mutex::new(None),
            handed: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub(crate) fn link(&self) -> &WorkletLink {
        &self.link
    }

    /// This host's registration, which the Attempt's sandbox and shared-execution records name.
    pub(crate) fn registration(&self) -> &'a HostRecord {
        self.registration
    }

    /// The handle the harness bridge renews and checks the Attempt's lease through.
    pub(crate) fn lease(&self, attempt: &Attempt) -> Lease {
        Lease::through(self.host.clone(), self.link.clone(), attempt.inspect())
    }

    /// Keeps the Attempt's lease while `operation` runs, as `with_authority` does in the Worklet.
    pub(crate) async fn keep<T>(
        &mut self,
        attempt: &Attempt,
        cancel: &CancellationToken,
        operation: impl std::future::Future<Output = Result<T, Status>>,
    ) -> Result<(T, Instant), Status> {
        if let Some(crate::local::LeaseChange::Lost { message }) = self.link.lease() {
            return Err(Status::failed_precondition(message));
        }
        let valid_until = renew(self.link.clone(), attempt.clone()).await?;
        let (link, attempt) = (self.link.clone(), attempt.clone());
        keep_authority(
            valid_until,
            move || renew(link.clone(), attempt.clone()),
            Duration::from_secs(2),
            (self.shutdown, cancel),
            operation,
        )
        .await
    }

    /// Keeps the Attempt's lease while `cleanup` runs; cleanup continues after the lease ends.
    pub(crate) async fn keep_for_cleanup(
        &mut self,
        attempt: &Attempt,
        cleanup: impl std::future::Future<Output = Result<()>>,
    ) -> Result<()> {
        let (link, attempt) = (self.link.clone(), attempt.clone());
        keep_for_cleanup(
            move || renew(link.clone(), attempt.clone()),
            self.shutdown,
            cleanup,
        )
        .await
    }

    /// Records the Worker's own verdict, which the Worklet logs and reports with Finish once the
    /// run returns.
    pub(crate) fn finish(&self, _attempt: Attempt, outcome: HarnessCompleteRequest) -> Result<()> {
        *self
            .verdict
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(outcome);
        Ok(())
    }

    /// Reports a stage the Worklet journals before the run goes on.
    pub(crate) async fn milestone(&self, milestone: Milestone) -> Result<()> {
        self.link.milestone(milestone).await
    }

    /// Hands over the outcome now, before the run's cleanup: the Worklet journals it, and acts on
    /// it once this Worker exited.
    pub(crate) async fn finish_now(
        &self,
        mut outcome: HarnessCompleteRequest,
        explained: bool,
    ) -> Result<()> {
        let checkpoint = outcome
            .checkpoint
            .take()
            .map(|checkpoint| self.journal.stage_checkpoint(checkpoint))
            .transpose()?;
        let failure_detail = if outcome.succeeded {
            vec![]
        } else {
            crate::failures::take_detail()
        };
        self.outcome(Outcome::Finish {
            completion: Completion::of(&outcome),
            explained,
            checkpoint,
            failure_detail,
        })
        .await
    }

    pub(crate) async fn outcome(&self, outcome: Outcome) -> Result<()> {
        self.handed.store(true, std::sync::atomic::Ordering::SeqCst);
        self.link.outcome(outcome).await?;
        supertag_protocol::crash_point("worker.outcome", "handed");
        Ok(())
    }

    /// Hands over what the run left: its own verdict, or that it stopped before launch so the
    /// Worklet resumes the Attempt later. Nothing when the outcome was handed over already.
    pub(crate) async fn settle(&self) -> Result<()> {
        let verdict = self
            .verdict
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        match verdict {
            Some(outcome) => self.finish_now(outcome, false).await,
            None if !self.handed.load(std::sync::atomic::Ordering::SeqCst) => {
                self.outcome(Outcome::Retry).await
            }
            None => Ok(()),
        }
    }
}
