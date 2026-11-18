//! A response stream that always ends with its producer's error.
//!
//! A server streams bytes through a bounded channel. When its producer fails mid-stream, sending
//! the error through that channel can wait behind a slow reader, and giving up then drops the
//! sender: the reader sees the stream end cleanly but short, as if the file were complete.
//! [`ends_with_error`] instead keeps the error beside the channel, and the stream yields it after
//! the last buffered message, however slowly the reader reads.
use std::{
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
};

use tonic::{Status, codegen::tokio_stream::Stream};

/// Where the producer leaves the error its stream ends with.
#[derive(Clone, Default)]
pub struct Failure(Arc<Mutex<Option<Status>>>);

impl Failure {
    /// Records the error the stream ends with, then the producer drops its sender. The first
    /// error wins.
    pub fn fail(&self, status: Status) {
        let mut slot = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        slot.get_or_insert(status);
    }

    fn take(&self) -> Option<Status> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
    }
}

/// `inner`, followed by the recorded error when its producer failed.
pub struct EndsWithError<S> {
    inner: S,
    failure: Failure,
    done: bool,
}

/// Wraps `inner` so it ends with the error the producer records in the returned [`Failure`].
pub fn ends_with_error<S>(inner: S) -> (EndsWithError<S>, Failure) {
    let failure = Failure::default();
    (
        EndsWithError {
            inner,
            failure: failure.clone(),
            done: false,
        },
        failure,
    )
}

impl<S, T> Stream for EndsWithError<S>
where
    S: Stream<Item = Result<T, Status>> + Unpin,
{
    type Item = Result<T, Status>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.done {
            return Poll::Ready(None);
        }
        match Pin::new(&mut self.inner).poll_next(context) {
            Poll::Ready(None) => {
                self.done = true;
                Poll::Ready(self.failure.take().map(Err))
            }
            other => other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tonic::codegen::tokio_stream::{self, StreamExt};

    fn collect<S: Stream + Unpin>(mut stream: S) -> Vec<S::Item> {
        let mut items = Vec::new();
        let waker = std::task::Waker::noop();
        let mut context = Context::from_waker(waker);
        while let Poll::Ready(Some(item)) = Pin::new(&mut stream).poll_next(&mut context) {
            items.push(item);
        }
        items
    }

    #[test]
    fn a_failed_stream_ends_with_its_error_after_every_buffered_message() {
        let (stream, failure) = ends_with_error(tokio_stream::iter(vec![Ok(1), Ok(2)]));
        failure.fail(Status::data_loss("held bytes changed"));
        failure.fail(Status::internal("a later error"));
        let items = collect(stream);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].as_ref().ok(), Some(&1));
        assert_eq!(items[1].as_ref().ok(), Some(&2));
        let error = items[2].as_ref().unwrap_err();
        assert_eq!(error.code(), tonic::Code::DataLoss);
    }

    #[test]
    fn a_finished_stream_ends_cleanly() {
        let (stream, _failure) = ends_with_error(tokio_stream::iter(vec![Ok::<_, Status>(1)]));
        assert_eq!(collect(stream.map(|item| item.ok())), vec![Some(1)]);
    }
}
