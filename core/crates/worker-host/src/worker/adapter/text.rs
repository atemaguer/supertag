//! The text of the message the harness is writing, batched and redacted on its way to the
//! Control Plane, which only shows it while the turn runs.
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use supertag_protocol::{
    authenticated_request,
    redaction::{redact_text, streamable_prefix},
    v2::{HarnessPublishTextRequest, HarnessPublishTextResponse, PublishTaskTextRequest},
};
use tokio::time::Instant;
use tonic::{Request, Response, Status};

use super::Bridge;

/// The least time between two sends of a message's text.
const EVERY: Duration = Duration::from_millis(75);
/// Text this much longer than what was sent goes at once.
const BATCH_BYTES: usize = 400;
/// The most text kept for one message; the recorded message has all of it.
const MAX_TEXT_BYTES: usize = 64 * 1024;
/// How long one send to the Control Plane may take. Text is shown only, so a lost send is
/// replaced by the next one or by the recorded message.
const SEND_TIMEOUT: Duration = Duration::from_secs(5);

/// The message being written: its text as the harness sent it, and what was last sent on.
#[derive(Default)]
pub(super) struct TextStream {
    after_sequence: u64,
    raw: String,
    shown: String,
    revision: u64,
    sent_at: Option<Instant>,
    sent_bytes: usize,
    scheduled: bool,
}

impl Bridge {
    pub(super) async fn publish_text(
        &self,
        request: Request<HarnessPublishTextRequest>,
    ) -> Result<Response<HarnessPublishTextResponse>, Status> {
        self.authenticate(&request)?;
        if !self.attached.load(std::sync::atomic::Ordering::Acquire) {
            return Err(Status::failed_precondition(
                "execution is not accepting text",
            ));
        }
        let input = request.into_inner();
        let send_now = {
            let mut stream = self.text.lock().unwrap();
            if stream.after_sequence != input.after_sequence || stream.raw.is_empty() {
                stream.after_sequence = input.after_sequence;
                stream.raw.clear();
                stream.shown.clear();
                stream.sent_bytes = 0;
            }
            if stream.raw.len() + input.text.len() <= MAX_TEXT_BYTES {
                stream.raw.push_str(&input.text);
            }
            let due = stream.sent_at.is_none_or(|at| at.elapsed() >= EVERY)
                || stream.raw.len() >= stream.sent_bytes + BATCH_BYTES;
            if !due && !stream.scheduled {
                stream.scheduled = true;
                let bridge = self.clone();
                let at = stream.sent_at.map_or_else(Instant::now, |at| at + EVERY);
                tokio::spawn(async move {
                    tokio::time::sleep_until(at).await;
                    bridge.text.lock().unwrap().scheduled = false;
                    bridge.send_text();
                });
            }
            due
        };
        if send_now {
            self.send_text();
        }
        Ok(Response::new(HarnessPublishTextResponse {}))
    }

    /// Sends the redacted text written so far, up to where nothing more can change it, when it
    /// differs from what was sent.
    fn send_text(&self) {
        let upstream = {
            let mut stream = self.text.lock().unwrap();
            let cut = streamable_prefix(&stream.raw, &self.secrets);
            let text = redact_text(&stream.raw[..cut], &self.secrets, false);
            if text.is_empty() || text == stream.shown {
                return;
            }
            stream.revision += 1;
            stream.sent_at = Some(Instant::now());
            stream.sent_bytes = stream.raw.len();
            stream.shown.clone_from(&text);
            PublishTaskTextRequest {
                after_sequence: stream.after_sequence,
                revision: stream.revision,
                text,
            }
        };
        let mut host = self.host.clone();
        let token = self.attempt_token.clone();
        tokio::spawn(async move {
            let Ok(mut request) = authenticated_request(upstream, &token, None) else {
                return;
            };
            request.set_timeout(SEND_TIMEOUT);
            // Shown only: the next send or the recorded message replaces a lost one.
            let _ = tokio::time::timeout(SEND_TIMEOUT, host.publish_text(request)).await;
        });
    }
}

pub(super) type SharedTextStream = Arc<Mutex<TextStream>>;
