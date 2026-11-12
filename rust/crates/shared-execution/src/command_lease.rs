use tonic::Status;
use uuid::Uuid;

use crate::{
    Provider, guardian,
    v2::{AccessCommandMode, CommandLeaseChallenge, CommandLeaseReceipt, RenewCommandLeaseRequest},
};

const NS_PER_MS: u64 = 1_000_000;
const MAX_CHALLENGE_NS: u64 = 2_000 * NS_PER_MS;
const MAX_LEASE_MS: u64 = 5_000;

#[derive(Default)]
pub(crate) struct Lease {
    deadline_ns: u64,
    challenge: Option<(String, u64)>,
}

fn now() -> Result<u64, Status> {
    guardian::monotonic_now_ns()
        .map_err(|_| Status::internal("command authority clock unavailable"))
}

impl Provider {
    async fn authorize_command_lease(&self, id: &str, token: &[u8]) -> Result<(), Status> {
        self.accepting()?;
        let access = self.auth(token, true).await?;
        if access.receipt.access_id != id
            || access.command_mode != AccessCommandMode::LeaseBound
            || self.0.process_identity.is_none()
        {
            return Err(Status::permission_denied(
                "access cannot renew command authority",
            ));
        }
        Ok(())
    }

    pub(crate) async fn prepare_command_lease_owned(
        &self,
        id: &str,
        token: &[u8],
    ) -> Result<CommandLeaseChallenge, Status> {
        let _admission = self.0.admission.lock().await;
        self.authorize_command_lease(id, token).await?;
        let issued = now()?;
        let mut leases = self.0.command_leases.lock().await;
        leases.retain(|_, lease| {
            lease.deadline_ns > issued
                || lease
                    .challenge
                    .as_ref()
                    .is_some_and(|(_, before)| issued.saturating_sub(*before) < MAX_CHALLENGE_NS)
        });
        let challenge_id = Uuid::new_v4().to_string();
        leases.entry(id.to_owned()).or_default().challenge = Some((challenge_id.clone(), issued));
        Ok(CommandLeaseChallenge {
            access_id: id.to_owned(),
            challenge_id,
        })
    }

    pub(crate) async fn renew_command_lease_owned(
        &self,
        input: RenewCommandLeaseRequest,
        token: &[u8],
    ) -> Result<CommandLeaseReceipt, Status> {
        let _admission = self.0.admission.lock().await;
        self.authorize_command_lease(&input.access_id, token)
            .await?;
        if !(1..=MAX_LEASE_MS).contains(&input.valid_for_ms) {
            return Err(Status::invalid_argument(
                "command authority duration is out of range",
            ));
        }
        let now = now()?;
        let mut leases = self.0.command_leases.lock().await;
        let lease = leases
            .get_mut(&input.access_id)
            .ok_or_else(|| Status::failed_precondition("no current command challenge"))?;
        let issued = lease
            .challenge
            .as_ref()
            .filter(|(id, _)| *id == input.challenge_id)
            .map(|(_, issued)| *issued)
            .ok_or_else(|| Status::failed_precondition("no current command challenge"))?;
        lease.challenge.take();
        // The provider issued this challenge before the Host sampled CP authority.
        // Count transport time against the lease and never move its start to receipt time.
        let deadline_ns = issued.saturating_add(input.valid_for_ms * NS_PER_MS);
        if now.saturating_sub(issued) >= MAX_CHALLENGE_NS || now >= deadline_ns {
            return Err(Status::failed_precondition(
                "command authority challenge expired",
            ));
        }
        lease.deadline_ns = deadline_ns;
        drop(leases);
        for process in self
            .0
            .processes
            .lock()
            .await
            .values()
            .filter(|process| process.access_id == input.access_id)
        {
            if let Some(lease) = &process.lease {
                lease.send_replace(deadline_ns);
            }
        }
        Ok(CommandLeaseReceipt {
            access_id: input.access_id,
            valid_for_ms: deadline_ns.saturating_sub(now) / NS_PER_MS,
        })
    }

    pub(crate) async fn process_deadline(
        &self,
        access_id: &str,
        mode: AccessCommandMode,
    ) -> Result<Option<u64>, Status> {
        match mode {
            AccessCommandMode::Unspecified => Ok(None),
            AccessCommandMode::Disabled => Err(Status::permission_denied(
                "processes are not admitted for this access",
            )),
            AccessCommandMode::LeaseBound => {
                let now = now()?;
                let deadline = self
                    .0
                    .command_leases
                    .lock()
                    .await
                    .get(access_id)
                    .map(|lease| lease.deadline_ns)
                    .filter(|deadline| *deadline > now)
                    .ok_or_else(|| Status::failed_precondition("no live command authority"))?;
                if self
                    .0
                    .processes
                    .lock()
                    .await
                    .values()
                    .any(|runtime| runtime.access_id == access_id)
                {
                    return Err(Status::failed_precondition(
                        "an earlier command is still owned",
                    ));
                }
                Ok(Some(deadline))
            }
        }
    }
}
