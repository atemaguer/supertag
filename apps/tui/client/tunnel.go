package client

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// A `wss://` or `ws://` Control Plane URL carries the same gRPC connection inside a WebSocket, for
// platforms whose proxy forwards only HTTP/1.1. The tunnel is a byte pipe: SuperTag's own TLS,
// with any client certificate, runs end to end inside it, so a proxy that terminates the outer
// `wss://` TLS sees only ciphertext. This matches the Rust transport (rust/crates/transport).

// tunnelMaxMessage is the largest WebSocket message either side sends or accepts.
const tunnelMaxMessage = 256 * 1024

// tunnelDialTimeout bounds opening a tunnel: the TCP connection, the outer TLS, the upgrade and,
// for `wss://`, the Control Plane's TLS inside it. A platform proxy may hold the upgrade while it
// starts a service that scaled to zero.
var tunnelDialTimeout = 30 * time.Second

// tunnelPing is how often the client pings the Control Plane. A peer that sends nothing, not even a
// pong, for three intervals is gone.
var tunnelPing = 20 * time.Second

const websocketGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

const (
	opContinuation = 0x0
	opText         = 0x1
	opBinary       = 0x2
	opClose        = 0x8
	opPing         = 0x9
	opPong         = 0xA
)

// tunnelURI is the native gRPC origin a tunnel URL carries: `wss://` becomes `https://` and
// `ws://` becomes `http://` on the same host and port, without the WebSocket path.
func tunnelURI(u *url.URL) string {
	scheme, port := "https", "443"
	if u.Scheme == "ws" {
		scheme, port = "http", "80"
	}
	if u.Port() != "" {
		port = u.Port()
	}
	return scheme + "://" + net.JoinHostPort(u.Hostname(), port)
}

// outerTLS trusts the platform's edge certificate through the system roots and, for a private
// platform, the same server certificate authority the inner TLS trusts.
func outerTLS(serverCA []byte) (*tls.Config, error) {
	roots, err := x509.SystemCertPool()
	if err != nil {
		roots = x509.NewCertPool()
	}
	if len(serverCA) > 0 && !roots.AppendCertsFromPEM(serverCA) {
		return nil, errors.New("Control Plane certificate authority contains no PEM certificates")
	}
	return &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots, NextProtos: []string{"http/1.1"}}, nil
}

// tunnelDialer opens one tunnel for every HTTP/2 connection the transport asks for, whatever
// address it names.
type tunnelDialer struct {
	url   *url.URL
	outer *tls.Config // nil for ws://
	inner *tls.Config // the Control Plane's TLS inside a wss:// tunnel
}

// DialContext opens a ws:// tunnel for cleartext HTTP/2.
func (d tunnelDialer) DialContext(ctx context.Context, _, _ string) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, tunnelDialTimeout)
	defer cancel()
	return d.dial(ctx)
}

// DialTLSContext opens a wss:// tunnel and completes the Control Plane's TLS inside it, both within
// tunnelDialTimeout.
func (d tunnelDialer) DialTLSContext(ctx context.Context, _, _ string) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, tunnelDialTimeout)
	defer cancel()
	conn, err := d.dial(ctx)
	if err != nil {
		return nil, err
	}
	secure := tls.Client(conn, d.inner.Clone())
	if err := secure.HandshakeContext(ctx); err != nil {
		conn.Close()
		return nil, err
	}
	return secure, nil
}

func (d tunnelDialer) dial(ctx context.Context) (net.Conn, error) {
	port := d.url.Port()
	if port == "" {
		port = "80"
		if d.url.Scheme == "wss" {
			port = "443"
		}
	}
	var dialer net.Dialer
	raw, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(d.url.Hostname(), port))
	if err != nil {
		return nil, err
	}
	conn := raw
	if d.outer != nil {
		config := d.outer.Clone()
		config.ServerName = d.url.Hostname()
		secure := tls.Client(raw, config)
		if err := secure.HandshakeContext(ctx); err != nil {
			raw.Close()
			return nil, err
		}
		conn = secure
	}
	reader, err := upgrade(ctx, conn, d.url)
	if err != nil {
		conn.Close()
		return nil, err
	}
	return newTunnelConn(conn, reader, tunnelPing), nil
}

// upgrade performs the client's WebSocket opening handshake. It never sends an Origin header:
// SuperTag listeners refuse upgrades that carry one, so a web page cannot open a tunnel.
func upgrade(ctx context.Context, conn net.Conn, u *url.URL) (*bufio.Reader, error) {
	if deadline, ok := ctx.Deadline(); ok {
		conn.SetDeadline(deadline)
	}
	stop := context.AfterFunc(ctx, func() { conn.SetDeadline(time.Now()) })
	defer stop()
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, err
	}
	key := base64.StdEncoding.EncodeToString(nonce[:])
	request := "GET " + u.RequestURI() + " HTTP/1.1\r\nHost: " + u.Host +
		"\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key +
		"\r\nSec-WebSocket-Version: 13\r\n\r\n"
	if _, err := io.WriteString(conn, request); err != nil {
		return nil, err
	}
	reader := bufio.NewReaderSize(conn, 4096)
	response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodGet})
	if err != nil {
		return nil, fmt.Errorf("WebSocket tunnel upgrade failed: %w", err)
	}
	response.Body.Close()
	digest := sha1.Sum([]byte(key + websocketGUID))
	if response.StatusCode != http.StatusSwitchingProtocols ||
		!strings.EqualFold(response.Header.Get("Upgrade"), "websocket") ||
		!headerHasToken(response.Header, "Connection", "upgrade") ||
		response.Header.Get("Sec-WebSocket-Accept") != base64.StdEncoding.EncodeToString(digest[:]) {
		return nil, fmt.Errorf("the WebSocket tunnel upgrade was refused: %s", response.Status)
	}
	if !stop() {
		return nil, ctx.Err()
	}
	conn.SetDeadline(time.Time{})
	return reader, nil
}

func headerHasToken(header http.Header, name, token string) bool {
	for _, value := range header.Values(name) {
		for part := range strings.SplitSeq(value, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}

var errSilentPeer = errors.New("the WebSocket tunnel peer stopped answering")

// tunnelConn reads and writes binary WebSocket messages as one continuous byte stream. It pings
// on an interval, which keeps proxies from closing an idle tunnel, and fails when the peer has
// sent nothing, not even a pong, for three intervals.
type tunnelConn struct {
	conn   net.Conn
	reader *bufio.Reader

	// Read side, used only by the one reader HTTP/2 runs.
	pending    []byte
	fragmented bool
	message    int

	writes   sync.Mutex
	frame    []byte
	last     atomic.Int64
	failure  atomic.Pointer[error]
	closed   chan struct{}
	shutdown sync.Once
}

func newTunnelConn(conn net.Conn, reader *bufio.Reader, ping time.Duration) *tunnelConn {
	c := &tunnelConn{conn: conn, reader: reader, closed: make(chan struct{})}
	c.last.Store(time.Now().UnixNano())
	go c.keepalive(ping)
	return c
}

func (c *tunnelConn) keepalive(ping time.Duration) {
	ticker := time.NewTicker(ping)
	defer ticker.Stop()
	for {
		select {
		case <-c.closed:
			return
		case <-ticker.C:
		}
		if time.Since(time.Unix(0, c.last.Load())) >= 3*ping {
			c.fail(errSilentPeer)
			return
		}
		// A write already in progress keeps the connection busy; the next tick pings.
		if !c.writes.TryLock() {
			continue
		}
		c.conn.SetWriteDeadline(time.Now().Add(ping))
		err := c.writeFrame(opPing, nil)
		c.conn.SetWriteDeadline(time.Time{})
		c.writes.Unlock()
		if err != nil {
			c.fail(err)
			return
		}
	}
}

// fail ends the tunnel with err, which every later read and write reports.
func (c *tunnelConn) fail(err error) {
	c.failure.CompareAndSwap(nil, &err)
	c.shutdown.Do(func() {
		close(c.closed)
		c.conn.Close()
	})
}

func (c *tunnelConn) err(err error) error {
	if failure := c.failure.Load(); failure != nil {
		return *failure
	}
	return err
}

func (c *tunnelConn) Read(p []byte) (int, error) {
	for len(c.pending) == 0 {
		if err := c.readFrame(); err != nil {
			return 0, c.err(err)
		}
	}
	n := copy(p, c.pending)
	c.pending = c.pending[n:]
	return n, nil
}

// readFrame reads one frame and handles it: a data frame's payload becomes pending bytes, a ping
// is answered unless a write is in progress, and a close ends the stream.
func (c *tunnelConn) readFrame() error {
	var header [2]byte
	if _, err := io.ReadFull(c.reader, header[:]); err != nil {
		return err
	}
	fin, opcode := header[0]&0x80 != 0, header[0]&0x0f
	if header[0]&0x70 != 0 || header[1]&0x80 != 0 {
		return errors.New("the WebSocket tunnel peer sent an invalid frame")
	}
	length := uint64(header[1] & 0x7f)
	switch length {
	case 126:
		var extended [2]byte
		if _, err := io.ReadFull(c.reader, extended[:]); err != nil {
			return err
		}
		length = uint64(binary.BigEndian.Uint16(extended[:]))
	case 127:
		var extended [8]byte
		if _, err := io.ReadFull(c.reader, extended[:]); err != nil {
			return err
		}
		length = binary.BigEndian.Uint64(extended[:])
	}
	if length > tunnelMaxMessage {
		return errors.New("the WebSocket tunnel message is too large")
	}
	control := opcode >= opClose
	if control && (!fin || length > 125) {
		return errors.New("the WebSocket tunnel peer sent an invalid control frame")
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(c.reader, payload); err != nil {
		return err
	}
	c.last.Store(time.Now().UnixNano())
	switch opcode {
	case opBinary, opContinuation:
		if (opcode == opBinary) == c.fragmented {
			return errors.New("the WebSocket tunnel peer sent an invalid fragment")
		}
		if opcode == opBinary {
			c.message = 0
		}
		c.message += len(payload)
		if c.message > tunnelMaxMessage {
			return errors.New("the WebSocket tunnel message is too large")
		}
		c.fragmented = !fin
		c.pending = payload
	case opPing:
		// The reader never waits for a blocked writer: a peer that stops reading while its own
		// writes cannot flush would otherwise stall both directions. A write in progress already
		// proves to the peer that this side is alive, so the pong is skipped then.
		if c.writes.TryLock() {
			err := c.writeFrame(opPong, payload)
			c.writes.Unlock()
			return err
		}
	case opPong:
	case opClose:
		// The close reply is likewise skipped while a write is in progress.
		if c.writes.TryLock() {
			c.writeFrame(opClose, payload[:min(len(payload), 2)])
			c.writes.Unlock()
		}
		return io.EOF
	case opText:
		return errors.New("the WebSocket tunnel carries only binary messages")
	default:
		return errors.New("the WebSocket tunnel peer sent an unknown frame")
	}
	return nil
}

// Write sends p as binary messages of at most tunnelMaxMessage bytes.
func (c *tunnelConn) Write(p []byte) (int, error) {
	c.writes.Lock()
	defer c.writes.Unlock()
	written := 0
	for written < len(p) {
		chunk := p[written:min(len(p), written+tunnelMaxMessage)]
		if err := c.writeFrame(opBinary, chunk); err != nil {
			return written, c.err(err)
		}
		written += len(chunk)
	}
	return written, nil
}

// writeFrame writes one final, masked frame. The caller holds c.writes.
func (c *tunnelConn) writeFrame(opcode byte, payload []byte) error {
	frame := c.frame[:0]
	frame = append(frame, 0x80|opcode)
	switch n := len(payload); {
	case n < 126:
		frame = append(frame, 0x80|byte(n))
	case n <= 0xffff:
		frame = append(frame, 0x80|126)
		frame = binary.BigEndian.AppendUint16(frame, uint16(n))
	default:
		frame = append(frame, 0x80|127)
		frame = binary.BigEndian.AppendUint64(frame, uint64(n))
	}
	var mask [4]byte
	if _, err := rand.Read(mask[:]); err != nil {
		return err
	}
	frame = append(frame, mask[:]...)
	start := len(frame)
	frame = append(frame, payload...)
	for i := range payload {
		frame[start+i] ^= mask[i&3]
	}
	c.frame = frame
	_, err := c.conn.Write(frame)
	return err
}

func (c *tunnelConn) Close() error {
	if c.writes.TryLock() {
		c.conn.SetWriteDeadline(time.Now().Add(time.Second))
		c.writeFrame(opClose, []byte{0x03, 0xe8})
		c.writes.Unlock()
	}
	c.fail(net.ErrClosed)
	return nil
}

func (c *tunnelConn) LocalAddr() net.Addr                { return c.conn.LocalAddr() }
func (c *tunnelConn) RemoteAddr() net.Addr               { return c.conn.RemoteAddr() }
func (c *tunnelConn) SetDeadline(t time.Time) error      { return c.conn.SetDeadline(t) }
func (c *tunnelConn) SetReadDeadline(t time.Time) error  { return c.conn.SetReadDeadline(t) }
func (c *tunnelConn) SetWriteDeadline(t time.Time) error { return c.conn.SetWriteDeadline(t) }
