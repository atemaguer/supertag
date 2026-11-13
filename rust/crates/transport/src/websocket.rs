//! A WebSocket as an ordinary byte stream, and the listener that accepts upgrades.

use std::{
    collections::VecDeque,
    io,
    pin::Pin,
    task::{Context, Poll, ready},
    time::Duration,
};

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    task::{AbortHandle, JoinSet},
    time::{Instant, Interval, MissedTickBehavior, interval_at},
};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{
        self, Message,
        error::ProtocolError,
        handshake::server::{Callback, ErrorResponse, Request, Response},
        protocol::WebSocketConfig,
    },
};
use tonic::transport::server::TcpConnectInfo;

use crate::Connection;

/// Largest WebSocket message either side sends or accepts. Writes are split to fit,
/// and an unauthenticated peer cannot make the server buffer more than this.
const MAX_MESSAGE: usize = 256 * 1024;
/// How long a client has to finish the WebSocket upgrade after connecting.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Upgrades in progress at once. A new connection beyond this evicts the oldest
/// unfinished upgrade rather than being refused, so clients that stall the upgrade
/// cannot lock out a client that completes it promptly.
const MAX_HANDSHAKES: usize = 256;
/// Largest HTTP request head the listener reads before deciding between the health
/// route and a WebSocket upgrade.
const MAX_REQUEST_HEAD: usize = 16 * 1024;
/// The plain HTTP path a platform health check may probe on a tunnel listener. A `GET`
/// for exactly this path without an `Upgrade` or `Origin` header is answered `200 OK`
/// with no detail; every other request must be a WebSocket upgrade.
pub const HEALTH_PATH: &str = "/healthz";
const HEALTHY: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 3\r\nCache-Control: no-store\r\nConnection: close\r\n\r\nok\n";

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
            task: tokio::spawn(accept(listener, sender, ping, MAX_HANDSHAKES)),
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

async fn accept(
    listener: TcpListener,
    sender: mpsc::Sender<Connection>,
    ping: Duration,
    limit: usize,
) {
    let mut upgrades = JoinSet::new();
    // Upgrades in progress, oldest first.
    let mut in_progress: VecDeque<AbortHandle> = VecDeque::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    in_progress.retain(|upgrade| !upgrade.is_finished());
                    if in_progress.len() >= limit
                        && let Some(oldest) = in_progress.pop_front()
                    {
                        oldest.abort();
                    }
                    in_progress.push_back(upgrades.spawn(upgrade(stream, ping)));
                }
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

/// Refuses an upgrade that carries an `Origin` header. Browsers always send one and
/// SuperTag's clients never do, so this keeps any web page the operator has open from
/// speaking gRPC to a listener through the tunnel.
struct RefuseBrowsers;

impl Callback for RefuseBrowsers {
    fn on_request(self, request: &Request, response: Response) -> Result<Response, ErrorResponse> {
        if request.headers().contains_key(http::header::ORIGIN) {
            let mut refusal =
                ErrorResponse::new(Some("browsers may not open a SuperTag tunnel".to_owned()));
            *refusal.status_mut() = http::StatusCode::FORBIDDEN;
            return Err(refusal);
        }
        Ok(response)
    }
}

async fn upgrade(stream: TcpStream, ping: Duration) -> Option<Connection> {
    let info = TcpConnectInfo {
        local_addr: stream.local_addr().ok(),
        remote_addr: stream.peer_addr().ok(),
    };
    stream.set_nodelay(true).ok()?;
    let socket = tokio::time::timeout(HANDSHAKE_TIMEOUT, async move {
        let mut stream = stream;
        let head = read_head(&mut stream).await?;
        if health_check(&head) {
            // Answered and closed; never a tunnel.
            let _ = stream.write_all(HEALTHY).await;
            let _ = stream.shutdown().await;
            return None;
        }
        tokio_tungstenite::accept_hdr_async_with_config(
            Replayed {
                head: Bytes::from(head),
                inner: stream,
            },
            RefuseBrowsers,
            Some(config()),
        )
        .await
        .ok()
    })
    .await
    .ok()??;
    Some(Connection::Tunnel(
        Box::new(WebSocketIo::new(socket, ping)),
        info,
    ))
}

/// Reads up to the end of the HTTP request head, or gives up on a head larger than
/// [`MAX_REQUEST_HEAD`]. Anything read past the head is kept for the upgrade.
async fn read_head(stream: &mut TcpStream) -> Option<Vec<u8>> {
    let mut head = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 2048];
    loop {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        let searched_from = head.len().saturating_sub(3);
        head.extend_from_slice(&chunk[..read]);
        if head.len() > MAX_REQUEST_HEAD {
            return None;
        }
        if head[searched_from..]
            .windows(4)
            .any(|window| window == b"\r\n\r\n")
        {
            return Some(head);
        }
    }
}

/// Whether `head` is the plain health check: `GET /healthz` with no `Upgrade` header
/// (an upgrade on that path is an ordinary tunnel) and no `Origin` header (a browser).
fn health_check(head: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(head) else {
        return false;
    };
    let mut lines = text.split("\r\n");
    let Some(request_line) = lines.next() else {
        return false;
    };
    let mut parts = request_line.split(' ');
    if parts.next() != Some("GET")
        || parts.next() != Some(HEALTH_PATH)
        || !parts
            .next()
            .is_some_and(|version| version.starts_with("HTTP/1."))
        || parts.next().is_some()
    {
        return false;
    }
    lines.take_while(|line| !line.is_empty()).all(|line| {
        let name = line.split(':').next().unwrap_or_default().trim();
        !name.eq_ignore_ascii_case("upgrade") && !name.eq_ignore_ascii_case("origin")
    })
}

/// A stream whose first bytes, already read to choose between the health route and an
/// upgrade, are read again before the rest of the connection.
pub struct Replayed<S> {
    head: Bytes,
    inner: S,
}

impl<S: AsyncRead + Unpin> AsyncRead for Replayed<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if !this.head.is_empty() {
            let length = buf.remaining().min(this.head.len());
            buf.put_slice(&this.head.split_to(length));
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut this.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Replayed<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, duplex};
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, protocol::Role};

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

    fn listen(limit: usize) -> (std::net::SocketAddr, Upgrades) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let listener = TcpListener::from_std(listener).unwrap();
        let (sender, receiver) = mpsc::channel(16);
        let task = tokio::spawn(accept(listener, sender, Duration::from_secs(60), limit));
        (address, Upgrades { receiver, task })
    }

    async fn next_upgrade(upgrades: &mut Upgrades) -> Connection {
        tokio::time::timeout(
            Duration::from_secs(5),
            std::future::poll_fn(|cx| upgrades.poll_next(cx)),
        )
        .await
        .expect("the upgrade completes")
        .expect("the listener is running")
    }

    #[tokio::test]
    async fn stalled_upgrades_cannot_lock_out_a_prompt_client() {
        let limit = 4;
        let (address, mut upgrades) = listen(limit);
        let mut stalled = Vec::new();
        for _ in 0..limit * 3 {
            let mut stream = TcpStream::connect(address).await.unwrap();
            stream.write_all(b"GET / HTTP/1.1\r\n").await.unwrap();
            stalled.push(stream);
        }
        let stream = TcpStream::connect(address).await.unwrap();
        let client = tokio::spawn(tokio_tungstenite::client_async_with_config(
            format!("ws://{address}/tunnel"),
            stream,
            Some(config()),
        ));
        next_upgrade(&mut upgrades).await;
        client.await.unwrap().unwrap();
        drop(stalled);
    }

    async fn plain_request(address: std::net::SocketAddr, request: &str) -> String {
        let mut stream = TcpStream::connect(address).await.unwrap();
        // A refused request may be reset before it is fully written or read; what arrived
        // before the reset is the answer.
        let _ = stream.write_all(request.as_bytes()).await;
        let mut response = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(15), stream.read_to_end(&mut response))
            .await
            .expect("the listener answers or closes");
        String::from_utf8_lossy(&response).into_owned()
    }

    #[tokio::test]
    async fn answers_the_health_route_without_weakening_the_upgrade_rules() {
        let (address, mut upgrades) = listen(MAX_HANDSHAKES);
        // A platform health check: plain HTTP, no Origin, no Upgrade.
        let healthy = plain_request(
            address,
            "GET /healthz HTTP/1.1\r\nHost: supertag.example.com\r\nUser-Agent: probe\r\n\r\n",
        )
        .await;
        assert!(healthy.starts_with("HTTP/1.1 200 OK\r\n"), "{healthy}");
        assert!(healthy.ends_with("\r\n\r\nok\n"), "{healthy}");
        // Neither a browser, nor another path, nor another method gets an answer.
        for request in [
            "GET /healthz HTTP/1.1\r\nHost: x\r\nOrigin: https://evil.example\r\n\r\n",
            "GET /healthz/ HTTP/1.1\r\nHost: x\r\n\r\n",
            "GET /healthz?verbose HTTP/1.1\r\nHost: x\r\n\r\n",
            "POST /healthz HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: x\r\n\r\n",
        ] {
            let response = plain_request(address, request).await;
            assert!(
                !response.contains(" 200 "),
                "{request:?} was answered: {response}"
            );
        }
        // An oversized head is dropped without an answer.
        let huge = format!(
            "GET /healthz HTTP/1.1\r\nX-Padding: {}\r\n\r\n",
            "a".repeat(MAX_REQUEST_HEAD)
        );
        assert!(plain_request(address, &huge).await.is_empty());
        // A browser's upgrade on the health path is still refused, and a client's upgrade
        // on it is an ordinary tunnel.
        let mut request = format!("ws://{address}/healthz")
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            http::header::ORIGIN,
            http::HeaderValue::from_static("https://evil.example"),
        );
        let stream = TcpStream::connect(address).await.unwrap();
        match tokio_tungstenite::client_async_with_config(request, stream, Some(config())).await {
            Err(tungstenite::Error::Http(response)) => {
                assert_eq!(response.status(), http::StatusCode::FORBIDDEN);
            }
            other => panic!("unexpected {:?}", other.map(|_| ())),
        }
        let stream = TcpStream::connect(address).await.unwrap();
        let (mut client, _) = tokio_tungstenite::client_async_with_config(
            format!("ws://{address}/healthz"),
            stream,
            Some(config()),
        )
        .await
        .unwrap();
        let Connection::Tunnel(mut tunnel, _) = next_upgrade(&mut upgrades).await else {
            panic!("expected a tunnel");
        };
        client
            .send(Message::Binary(Bytes::from_static(b"through")))
            .await
            .unwrap();
        let mut received = [0_u8; 7];
        tunnel.read_exact(&mut received).await.unwrap();
        assert_eq!(&received, b"through");
    }

    #[tokio::test]
    async fn refuses_an_upgrade_from_a_browser() {
        let (address, mut upgrades) = listen(MAX_HANDSHAKES);
        let mut request = format!("ws://{address}/tunnel")
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            http::header::ORIGIN,
            http::HeaderValue::from_static("https://evil.example"),
        );
        let stream = TcpStream::connect(address).await.unwrap();
        let error = tokio_tungstenite::client_async_with_config(request, stream, Some(config()))
            .await
            .unwrap_err();
        match error {
            tungstenite::Error::Http(response) => {
                assert_eq!(response.status(), http::StatusCode::FORBIDDEN);
            }
            other => panic!("unexpected {other:?}"),
        }
        // The same client without an Origin header is accepted.
        let stream = TcpStream::connect(address).await.unwrap();
        tokio_tungstenite::client_async_with_config(
            format!("ws://{address}/tunnel"),
            stream,
            Some(config()),
        )
        .await
        .unwrap();
        next_upgrade(&mut upgrades).await;
    }
}
