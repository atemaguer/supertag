//! Brokered reads from the Worker Host that holds a blob.
//!
//! The Control Plane stores no artifact or Workspace delivery bytes. Each Worker Host keeps one
//! `HostRelay.Await` stream open; to serve an authorized reader the API tier sends the holding
//! host a request for one exact blob, and the host answers with one `HostRelay.Deliver` call
//! whose chunks pass through this process in memory, bounded by a small channel. The reader's
//! stream verifies their length and digest before it ends successfully.
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

use super::*;
use tokio::sync::oneshot;

/// How long a holding host has to acknowledge a relay request. A host acknowledges at once and
/// then waits for a free read slot, so this measures whether it is reachable, not how busy it is.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(10);
/// Relayed reads of one host, waiting or under way, at once.
const MAX_RELAYS_PER_HOST: usize = 32;

#[derive(Default)]
pub(crate) struct RelayHub {
    state: Mutex<HubState>,
    /// Ends every relay stream, so a stopping Control Plane does not wait on them.
    closed: tokio_util::sync::CancellationToken,
}

#[derive(Default)]
struct HubState {
    /// Each host's open Await streams, newest last. Lanes of one Host share its artifact storage,
    /// so any of them can answer.
    links: HashMap<String, Vec<Link>>,
    pending: HashMap<String, Pending>,
    /// Each host's relayed reads, waiting or under way.
    active: HashMap<String, Arc<AtomicUsize>>,
    next_link: u64,
    /// Turns requests across a host's lanes, which each answer a few reads at once.
    next_pick: usize,
}

struct Link {
    id: u64,
    generation: u64,
    requests: mpsc::Sender<Result<RelayRequest, Status>>,
}

struct Pending {
    host_id: String,
    link: u64,
    generation: u64,
    /// The most bytes the answer may carry: the blob's receipt, or the Workspace blob limit.
    limit: u64,
    chunks: mpsc::Sender<Result<Vec<u8>, Status>>,
    attached: oneshot::Sender<()>,
}

/// Why a relay could not start.
pub(crate) enum RelayError {
    /// The holding host has no open relay stream to this Control Plane.
    Offline,
    Failed(Status),
}

/// Chunks arriving from the holding host.
pub(crate) struct Incoming {
    chunks: mpsc::Receiver<Result<Vec<u8>, Status>>,
    _active: Active,
}

/// Counts one relayed read of a host until the reader is done with it.
struct Active(Arc<AtomicUsize>);

impl Drop for Active {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Incoming {
    pub(crate) async fn next(&mut self) -> Result<Option<Vec<u8>>, Status> {
        self.chunks.recv().await.transpose()
    }
}

fn busy() -> Status {
    Status::resource_exhausted("too many relayed reads are waiting for this Worker Host")
}

/// Removes an unanswered request when the reader gives up.
struct PendingGuard<'a> {
    hub: &'a RelayHub,
    relay_id: String,
}

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        self.hub
            .state
            .lock()
            .expect("relay state")
            .pending
            .remove(&self.relay_id);
    }
}

impl RelayHub {
    /// Registers one Await stream of `host_id` and returns the requests it should answer.
    pub(crate) fn connect(
        self: &Arc<Self>,
        host_id: String,
        generation: u64,
    ) -> ReceiverStream<Result<RelayRequest, Status>> {
        let (send, receive) = mpsc::channel(MAX_RELAYS_PER_HOST);
        if self.closed.is_cancelled() {
            return ReceiverStream::new(receive);
        }
        let id = {
            let mut state = self.state.lock().expect("relay state");
            state.next_link += 1;
            let id = state.next_link;
            let links = state.links.entry(host_id.clone()).or_default();
            // A newer generation of the host replaces every older stream.
            links.retain(|link| {
                let current = link.generation >= generation && !link.requests.is_closed();
                if !current {
                    let _ = link.requests.try_send(Err(Status::failed_precondition(
                        "a newer Worker Host generation replaced this relay stream",
                    )));
                }
                current
            });
            links.push(Link {
                id,
                generation,
                requests: send.clone(),
            });
            id
        };
        let hub = Arc::downgrade(self);
        let closed = self.closed.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = send.closed() => {}
                _ = closed.cancelled() => {}
            }
            drop(send);
            if let Some(hub) = hub.upgrade() {
                let mut state = hub.state.lock().expect("relay state");
                if let Some(links) = state.links.get_mut(&host_id) {
                    links.retain(|link| link.id != id);
                    if links.is_empty() {
                        state.links.remove(&host_id);
                    }
                }
                // Requests sent on this stream will never be answered.
                state.pending.retain(|_, pending| pending.link != id);
            }
        });
        ReceiverStream::new(receive)
    }

    /// Ends every relay stream and refuses new ones.
    pub(crate) fn close(&self) {
        self.closed.cancel();
    }

    /// Whether `host_id` has an open relay stream.
    #[cfg(test)]
    pub(crate) fn connected(&self, host_id: &str) -> bool {
        self.state
            .lock()
            .expect("relay state")
            .links
            .get(host_id)
            .is_some_and(|links| links.iter().any(|link| !link.requests.is_closed()))
    }

    /// Asks the holding host for one blob and waits until it starts answering.
    pub(crate) async fn open(
        &self,
        holder: &BlobHolder,
        blob: &BlobReference,
    ) -> Result<Incoming, RelayError> {
        self.ask(
            holder,
            RelayRequest {
                blob: Some(blob.clone()),
                ..Default::default()
            },
            blob.byte_length,
        )
        .await
    }

    /// Asks the holding host to build a complete bundle of `delivery`'s head, for a reader that
    /// lacks the delivery's start commit. Its size is bounded only by the Workspace blob limit:
    /// it has no receipt, and the reader checks it with Git.
    pub(crate) async fn open_complete_bundle(
        &self,
        holder: &BlobHolder,
        delivery: &WorkspaceDeliveryReference,
    ) -> Result<Incoming, RelayError> {
        self.ask(
            holder,
            RelayRequest {
                complete_bundle: Some(delivery.clone()),
                ..Default::default()
            },
            supertag_protocol::MAX_WORKSPACE_BLOB_BYTES as u64,
        )
        .await
    }

    async fn ask(
        &self,
        holder: &BlobHolder,
        mut request: RelayRequest,
        limit: u64,
    ) -> Result<Incoming, RelayError> {
        let relay_id = uuid::Uuid::new_v4().to_string();
        let (chunks, incoming) = mpsc::channel(4);
        let (attached, answered) = oneshot::channel();
        request.relay_id = relay_id.clone();
        request.attempt_id = holder.attempt_id.clone();
        let (link, active) = {
            let mut state = self.state.lock().expect("relay state");
            let state = &mut *state;
            let open: Vec<_> = state
                .links
                .get(&holder.host_id)
                .map(|links| {
                    links
                        .iter()
                        .filter(|link| !link.requests.is_closed())
                        .collect()
                })
                .unwrap_or_default();
            if open.is_empty() {
                return Err(RelayError::Offline);
            }
            state.next_pick = state.next_pick.wrapping_add(1);
            let link = open[state.next_pick % open.len()];
            let (link, generation, requests) = (link.id, link.generation, link.requests.clone());
            let count = state.active.entry(holder.host_id.clone()).or_default();
            if count.load(Ordering::SeqCst) >= MAX_RELAYS_PER_HOST {
                return Err(RelayError::Failed(busy()));
            }
            count.fetch_add(1, Ordering::SeqCst);
            let active = Active(count.clone());
            state.pending.insert(
                relay_id.clone(),
                Pending {
                    host_id: holder.host_id.clone(),
                    link,
                    generation,
                    limit,
                    chunks,
                    attached,
                },
            );
            (requests, active)
        };
        let guard = PendingGuard {
            hub: self,
            relay_id,
        };
        match link.try_send(Ok(request)) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => return Err(RelayError::Failed(busy())),
            Err(mpsc::error::TrySendError::Closed(_)) => return Err(RelayError::Offline),
        }
        match timeout(ANSWER_TIMEOUT, answered).await {
            Ok(Ok(())) => {
                drop(guard);
                Ok(Incoming {
                    chunks: incoming,
                    _active: active,
                })
            }
            Ok(Err(_)) => Err(RelayError::Offline),
            Err(_) => Err(RelayError::Failed(Status::unavailable(format!(
                "Worker Host {} did not answer the Control Plane's relay request",
                holder.host_id
            )))),
        }
    }

    /// Carries one host's answer to the waiting reader.
    pub(crate) async fn deliver(
        &self,
        host_id: &str,
        generation: u64,
        mut frames: Streaming<RelayFrame>,
    ) -> Result<RelayDelivered, Status> {
        let relay_id = match frames.message().await?.and_then(|frame| frame.part) {
            Some(relay_frame::Part::RelayId(id)) => id,
            _ => {
                return Err(Status::invalid_argument(
                    "a relay delivery starts with its request ID",
                ));
            }
        };
        let pending = {
            let mut state = self.state.lock().expect("relay state");
            match state.pending.get(&relay_id) {
                Some(pending) if pending.host_id == host_id && pending.generation == generation => {
                    state.pending.remove(&relay_id)
                }
                _ => None,
            }
        }
        .ok_or_else(|| Status::not_found("relay request is not waiting for this Worker Host"))?;
        let _ = pending.attached.send(());
        let limit = pending.limit;
        let mut length = 0u64;
        loop {
            let frame = match frames.message().await {
                Ok(Some(frame)) => frame,
                Ok(None) => return Ok(RelayDelivered {}),
                Err(_) => {
                    let _ = pending
                        .chunks
                        .send(Err(Status::unavailable(format!(
                            "Worker Host {host_id} stopped relaying before the end of the file"
                        ))))
                        .await;
                    return Err(Status::cancelled("relay delivery ended early"));
                }
            };
            let result = match frame.part {
                Some(relay_frame::Part::Chunk(chunk))
                    if !chunk.is_empty()
                        && chunk.len() <= CHECKPOINT_CHUNK_BYTES
                        && length + chunk.len() as u64 <= limit =>
                {
                    length += chunk.len() as u64;
                    Ok(chunk)
                }
                // The host's own reason is not shown: it is not trusted text.
                Some(relay_frame::Part::Failure(_)) => Err(Status::data_loss(format!(
                    "Worker Host {host_id} no longer holds verified bytes for this file"
                ))),
                _ => Err(Status::data_loss(format!(
                    "Worker Host {host_id} relayed an invalid chunk"
                ))),
            };
            let failed = result.is_err();
            if pending.chunks.send(result).await.is_err() {
                // The reader went away.
                return Err(Status::cancelled("relay reader disconnected"));
            }
            if failed {
                return Ok(RelayDelivered {});
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_unconnected_holder_is_offline() {
        let hub = Arc::new(RelayHub::default());
        let holder = BlobHolder {
            host_id: "laptop".into(),
            attempt_id: "attempt".into(),
        };
        let blob = BlobReference {
            sha256: "0".repeat(64),
            byte_length: 1,
        };
        assert!(matches!(
            hub.open(&holder, &blob).await,
            Err(RelayError::Offline)
        ));
        let stream = hub.connect("laptop".into(), 1);
        assert!(hub.connected("laptop"));
        drop(stream);
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!hub.connected("laptop"));
        assert!(matches!(
            hub.open(&holder, &blob).await,
            Err(RelayError::Offline)
        ));
    }

    #[tokio::test]
    async fn a_newer_generation_replaces_older_streams() {
        let hub = Arc::new(RelayHub::default());
        let mut old = hub.connect("laptop".into(), 1);
        let mut new = hub.connect("laptop".into(), 2);
        let holder = BlobHolder {
            host_id: "laptop".into(),
            attempt_id: "attempt".into(),
        };
        let blob = BlobReference {
            sha256: "0".repeat(64),
            byte_length: 1,
        };
        let opened = {
            let hub = hub.clone();
            tokio::spawn(async move { hub.open(&holder, &blob).await.is_ok() })
        };
        use tokio_stream::StreamExt;
        let request = timeout(Duration::from_secs(2), new.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(request.attempt_id, "attempt");
        assert!(matches!(old.next().await, Some(Err(_))));
        // Nobody answers, so the reader gives up and the request is forgotten.
        drop(new);
        assert!(!opened.await.unwrap());
        assert!(hub.state.lock().unwrap().pending.is_empty());
    }

    #[tokio::test]
    async fn lanes_share_requests_and_a_busy_host_is_not_offline() {
        use tokio_stream::StreamExt;
        let hub = Arc::new(RelayHub::default());
        let mut lanes = [
            hub.connect("laptop".into(), 1),
            hub.connect("laptop".into(), 1),
        ];
        let blob = BlobReference {
            sha256: "0".repeat(64),
            byte_length: 1,
        };
        let mut readers = Vec::new();
        for index in 0..MAX_RELAYS_PER_HOST {
            let hub = hub.clone();
            let blob = blob.clone();
            readers.push(tokio::spawn(async move {
                let holder = BlobHolder {
                    host_id: "laptop".into(),
                    attempt_id: format!("attempt-{index}"),
                };
                hub.open(&holder, &blob).await.is_ok()
            }));
        }
        // Every lane gets a share of the requests.
        for lane in &mut lanes {
            let request = timeout(Duration::from_secs(2), lane.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert!(request.attempt_id.starts_with("attempt-"));
        }
        let holder = BlobHolder {
            host_id: "laptop".into(),
            attempt_id: "one too many".into(),
        };
        match hub.open(&holder, &blob).await {
            Err(RelayError::Failed(status)) => {
                assert_eq!(status.code(), tonic::Code::ResourceExhausted)
            }
            _ => panic!("a busy host's extra read must be refused as busy"),
        }
        drop(lanes);
        for reader in readers {
            assert!(!reader.await.unwrap());
        }
        // Finished reads free their slots.
        let lane = hub.connect("laptop".into(), 1);
        let opened = {
            let hub = hub.clone();
            let blob = blob.clone();
            tokio::spawn(async move { hub.open(&holder, &blob).await.is_ok() })
        };
        drop(lane);
        assert!(!opened.await.unwrap());
        assert_eq!(
            hub.state.lock().unwrap().active["laptop"].load(Ordering::SeqCst),
            0
        );
    }
}
