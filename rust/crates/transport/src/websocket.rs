//! A WebSocket as an ordinary byte stream, and the listener that accepts upgrades.

use std::{
    io,
    pin::Pin,
    task::{Context, Poll, ready},
    time::Duration,
};

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    task::JoinSet,
    time::{Instant, Interval, MissedTickBehavior, interval_at},
};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{self, Message, error::ProtocolError, protocol::WebSocketConfig},
};
use tonic::transport::server::TcpConnectInfo;

use crate::Connection;

/// Largest WebSocket message either side sends or accepts. Writes are split to fit,
/// and an unauthenticated peer cannot make the server buffer more than this.
const MAX_MESSAGE: usize = 256 * 1024;
/// How long a client has to finish the WebSocket upgrade after connecting.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Upgrades in progress at once; further connections are closed until one finishes.
const MAX_HANDSHAKES: usize = 256;

pub(crate) fn config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE))
        .max_frame_size(Some(MAX_MESSAGE))
}

/// Maps a WebSocket failure onto the I/O error a broken socket would report, so
/// HTTP/2 and gRPC classify a dropped tunnel exactly like a dropped TCP connection.
pub(crate) fn io_error(error: tungstenite::Error) -> io::Error {
    match error {
        tungstenite::Error::Io(error) => error,
        tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed => {
            io::Error::new(io::ErrorKind::BrokenPipe, error)
        }
        tungstenite::Error::Protocol(ProtocolError::ResetWithoutClosingHandshake) => {
            io::Error::new(io::ErrorKind::ConnectionReset, error)
        }
        error => io::Error::other(error),
    }
}

/// Binary WebSocket messages read and written as one continuous byte stream. Each end
/// pings on an interval, which keeps proxies from closing an idle tunnel, and fails
/// the stream when the peer has sent nothing, not even a pong, for three intervals.
pub struct WebSocketIo<S> {
    socket: WebSocketStream<S>,
    pending: Bytes,
    keepalive: Interval,
    last_frame: Instant,
    idle_limit: Duration,
    ping_due: bool,
    flush_due: bool,
}

impl<S> WebSocketIo<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    pub fn new(socket: WebSocketStream<S>, ping: Duration) -> Self {
        let mut keepalive = interval_at(Instant::now() + ping, ping);
        keepalive.set_missed_tick_behavior(MissedTickBehavior::Delay);
        Self {
            socket,
            pending: Bytes::new(),
            keepalive,
            last_frame: Instant::now(),
            idle_limit: ping * 3,
            ping_due: false,
            flush_due: false,
        }
    }

    /// Sends a due ping and fails a silent peer. HTTP/2 always has a read pending, so
    /// polling from the read side runs the keepalive on an idle connection too.
    fn poll_keepalive(&mut self, cx: &mut Context<'_>) -> io::Result<()> {
        while self.keepalive.poll_tick(cx).is_ready() {
            if self.last_frame.elapsed() >= self.idle_limit {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "the WebSocket tunnel peer stopped answering",
                ));
            }
            self.ping_due = true;
        }
        if self.ping_due {
            match self.socket.poll_ready_unpin(cx) {
                Poll::Ready(Ok(())) => {
                    self.socket
                        .start_send_unpin(Message::Ping(Bytes::new()))
                        .map_err(io_error)?;
                    self.ping_due = false;
                    self.flush_due = true;
                }
                Poll::Ready(Err(error)) => return Err(io_error(error)),
                Poll::Pending => {}
            }
        }
        if self.flush_due {
            match self.socket.poll_flush_unpin(cx) {
                Poll::Ready(Ok(())) => self.flush_due = false,
                Poll::Ready(Err(error)) => return Err(io_error(error)),
                Poll::Pending => {}
            }
        }
        Ok(())
    }
}

impl<S> AsyncRead for WebSocketIo<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        this.poll_keepalive(cx)?;
        loop {
            if !this.pending.is_empty() {
                let length = buf.remaining().min(this.pending.len());
                buf.put_slice(&this.pending.split_to(length));
                return Poll::Ready(Ok(()));
            }
            let Some(message) = ready!(this.socket.poll_next_unpin(cx)) else {
                return Poll::Ready(Ok(()));
            };
            this.last_frame = Instant::now();
            match message.map_err(io_error)? {
                Message::Binary(data) => this.pending = data,
                Message::Ping(_) | Message::Pong(_) => {}
                Message::Close(_) => return Poll::Ready(Ok(())),
                Message::Text(_) | Message::Frame(_) => {
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "the WebSocket tunnel carries only binary messages",
                    )));
                }
            }
        }
    }
}

impl<S> AsyncWrite for WebSocketIo<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        if buf.is_empty() {
            return Poll::Ready(Ok(0));
        }
        ready!(this.socket.poll_ready_unpin(cx)).map_err(io_error)?;
        let length = buf.len().min(MAX_MESSAGE);
        this.socket
            .start_send_unpin(Message::Binary(Bytes::copy_from_slice(&buf[..length])))
            .map_err(io_error)?;
        Poll::Ready(Ok(length))
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.get_mut().socket.poll_flush_unpin(cx).map_err(io_error)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.get_mut().socket.poll_close_unpin(cx).map_err(io_error)
    }
}

/// Completed WebSocket upgrades from one listener. Each upgrade runs in its own task
/// with a deadline, so a slow or hostile client never delays another connection.
/// Dropping this stops the listener and every upgrade in progress.
pub(crate) struct Upgrades {
    receiver: mpsc::Receiver<Connection>,
    task: tokio::task::JoinHandle<()>,
}

impl Upgrades {
    pub(crate) fn spawn(listener: TcpListener, ping: Duration) -> Self {
        let (sender, receiver) = mpsc::channel(16);
        Self {
            receiver,
            task: tokio::spawn(accept(listener, sender, ping)),
        }
    }

    pub(crate) fn poll_next(&mut self, cx: &mut Context<'_>) -> Poll<Option<Connection>> {
        self.receiver.poll_recv(cx)
    }
}

impl Drop for Upgrades {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn accept(listener: TcpListener, sender: mpsc::Sender<Connection>, ping: Duration) {
    let mut upgrades = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) if upgrades.len() < MAX_HANDSHAKES => {
                    upgrades.spawn(upgrade(stream, ping));
                }
                Ok(_) => {}
                // Accept failures such as running out of file descriptors are transient.
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            },
            Some(finished) = upgrades.join_next() => {
                if let Ok(Some(connection)) = finished
                    && sender.send(connection).await.is_err()
                {
                    return;
                }
            }
        }
    }
}

async fn upgrade(stream: TcpStream, ping: Duration) -> Option<Connection> {
    let info = TcpConnectInfo {
        local_addr: stream.local_addr().ok(),
        remote_addr: stream.peer_addr().ok(),
    };
    stream.set_nodelay(true).ok()?;
    let socket = tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        tokio_tungstenite::accept_async_with_config(stream, Some(config())),
    )
    .await
    .ok()?
    .ok()?;
    Some(Connection::Tunnel(
        Box::new(WebSocketIo::new(socket, ping)),
        info,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, duplex};
    use tokio_tungstenite::tungstenite::protocol::Role;

    async fn pair(
        ping: Duration,
    ) -> (
        WebSocketIo<tokio::io::DuplexStream>,
        WebSocketStream<tokio::io::DuplexStream>,
    ) {
        let (left, right) = duplex(1 << 20);
        let left = WebSocketStream::from_raw_socket(left, Role::Client, Some(config())).await;
        let right = WebSocketStream::from_raw_socket(right, Role::Server, Some(config())).await;
        (WebSocketIo::new(left, ping), right)
    }

    #[tokio::test]
    async fn carries_bytes_in_both_directions_and_splits_large_writes() {
        let (mut io, mut peer) = pair(Duration::from_secs(60)).await;
        let large = vec![7_u8; MAX_MESSAGE * 2 + 3];
        io.write_all(&large).await.unwrap();
        io.flush().await.unwrap();
        let mut received = Vec::new();
        while received.len() < large.len() {
            match peer.next().await.unwrap().unwrap() {
                Message::Binary(data) => {
                    assert!(data.len() <= MAX_MESSAGE);
                    received.extend_from_slice(&data);
                }
                other => panic!("unexpected {other:?}"),
            }
        }
        assert_eq!(received, large);
        peer.send(Message::Binary(Bytes::from_static(b"hello")))
            .await
            .unwrap();
        peer.send(Message::Binary(Bytes::from_static(b" world")))
            .await
            .unwrap();
        let mut text = [0_u8; 11];
        io.read_exact(&mut text).await.unwrap();
        assert_eq!(&text, b"hello world");
        peer.close(None).await.unwrap();
        let mut rest = Vec::new();
        assert_eq!(io.read_to_end(&mut rest).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn refuses_text_messages() {
        let (mut io, mut peer) = pair(Duration::from_secs(60)).await;
        peer.send(Message::Text("not gRPC".into())).await.unwrap();
        let error = io.read(&mut [0_u8; 8]).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[tokio::test(start_paused = true)]
    async fn pings_an_idle_peer_that_answers_and_stays_open() {
        let (mut io, mut peer) = pair(Duration::from_millis(100)).await;
        // The peer reads, so tungstenite answers each ping with a pong.
        let answering = tokio::spawn(async move {
            let mut pings = 0;
            while let Some(Ok(message)) = peer.next().await {
                if matches!(message, Message::Ping(_)) {
                    pings += 1;
                    if pings == 5 {
                        peer.send(Message::Binary(Bytes::from_static(b"!")))
                            .await
                            .unwrap();
                    }
                }
            }
            pings
        });
        let mut byte = [0_u8; 1];
        io.read_exact(&mut byte).await.unwrap();
        assert_eq!(&byte, b"!");
        drop(io);
        assert!(answering.await.unwrap() >= 5);
    }

    #[tokio::test(start_paused = true)]
    async fn fails_a_peer_that_stops_answering() {
        // The peer never reads, so it never answers a ping.
        let (mut io, _peer) = pair(Duration::from_millis(100)).await;
        let error = io.read(&mut [0_u8; 8]).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    }

    #[tokio::test]
    async fn reports_an_abrupt_drop_as_a_reset() {
        let (mut io, peer) = pair(Duration::from_secs(60)).await;
        drop(peer);
        let error = io.read(&mut [0_u8; 8]).await.unwrap_err();
        assert!(
            matches!(
                error.kind(),
                io::ErrorKind::ConnectionReset
                    | io::ErrorKind::BrokenPipe
                    | io::ErrorKind::UnexpectedEof
            ),
            "{error:?}"
        );
    }
}
