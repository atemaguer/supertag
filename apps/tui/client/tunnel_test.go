package client

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	v2 "github.com/atemaguer/supertag/rust/bindings/go/runtimev2"
	rpc "github.com/atemaguer/supertag/rust/bindings/go/runtimev2/runtimev2connect"
)

// The server side of the tunnel's framing, as the Rust listener speaks it: client frames
// arrive masked, and the server's do not.

type testFrame struct {
	fin     bool
	opcode  byte
	masked  bool
	payload []byte
}

func readTestFrame(r io.Reader) (testFrame, error) {
	var header [2]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return testFrame{}, err
	}
	frame := testFrame{fin: header[0]&0x80 != 0, opcode: header[0] & 0x0f, masked: header[1]&0x80 != 0}
	length := uint64(header[1] & 0x7f)
	switch length {
	case 126:
		var extended [2]byte
		if _, err := io.ReadFull(r, extended[:]); err != nil {
			return frame, err
		}
		length = uint64(binary.BigEndian.Uint16(extended[:]))
	case 127:
		var extended [8]byte
		if _, err := io.ReadFull(r, extended[:]); err != nil {
			return frame, err
		}
		length = binary.BigEndian.Uint64(extended[:])
	}
	var mask [4]byte
	if frame.masked {
		if _, err := io.ReadFull(r, mask[:]); err != nil {
			return frame, err
		}
	}
	frame.payload = make([]byte, length)
	if _, err := io.ReadFull(r, frame.payload); err != nil {
		return frame, err
	}
	for i := range frame.payload {
		frame.payload[i] ^= mask[i&3]
	}
	return frame, nil
}

func writeTestFrame(w io.Writer, fin bool, opcode byte, payload []byte) error {
	first := opcode
	if fin {
		first |= 0x80
	}
	frame := []byte{first}
	switch n := len(payload); {
	case n < 126:
		frame = append(frame, byte(n))
	case n <= 0xffff:
		frame = append(frame, 126)
		frame = binary.BigEndian.AppendUint16(frame, uint16(n))
	default:
		frame = append(frame, 127)
		frame = binary.BigEndian.AppendUint64(frame, uint64(n))
	}
	_, err := w.Write(append(frame, payload...))
	return err
}

// testEdge is a WebSocket tunnel listener in front of a native gRPC backend, like a Rust
// service's --websocket-listen behind a platform proxy that terminates the outer TLS. It
// records what the client sent.
type testEdge struct {
	listener net.Listener
	backend  string

	mu       sync.Mutex
	paths    []string
	origins  int
	opcodes  map[byte]int
	unmasked int
	largest  int
}

func startTestEdge(t *testing.T, backend string, outer *tls.Config) *testEdge {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	if outer != nil {
		listener = tls.NewListener(listener, outer)
	}
	edge := &testEdge{listener: listener, backend: backend, opcodes: map[byte]int{}}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go edge.serve(conn)
		}
	}()
	return edge
}

func (e *testEdge) serve(conn net.Conn) {
	defer conn.Close()
	reader := bufio.NewReader(conn)
	request, err := http.ReadRequest(reader)
	if err != nil {
		return
	}
	e.mu.Lock()
	e.paths = append(e.paths, request.URL.RequestURI())
	if request.Header.Get("Origin") != "" {
		e.origins++
	}
	e.mu.Unlock()
	if !strings.EqualFold(request.Header.Get("Upgrade"), "websocket") || request.Header.Get("Sec-WebSocket-Version") != "13" {
		io.WriteString(conn, "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
		return
	}
	digest := sha1.Sum([]byte(request.Header.Get("Sec-WebSocket-Key") + websocketGUID))
	io.WriteString(conn, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+
		base64.StdEncoding.EncodeToString(digest[:])+"\r\n\r\n")
	backend, err := net.Dial("tcp", e.backend)
	if err != nil {
		return
	}
	defer backend.Close()
	var writes sync.Mutex
	go func() {
		buffer := make([]byte, 64*1024)
		for {
			n, err := backend.Read(buffer)
			if n > 0 {
				writes.Lock()
				writeTestFrame(conn, true, opBinary, buffer[:n])
				writes.Unlock()
			}
			if err != nil {
				conn.Close()
				return
			}
		}
	}()
	for {
		frame, err := readTestFrame(reader)
		if err != nil {
			return
		}
		e.mu.Lock()
		e.opcodes[frame.opcode]++
		if !frame.masked {
			e.unmasked++
		}
		e.largest = max(e.largest, len(frame.payload))
		e.mu.Unlock()
		switch frame.opcode {
		case opBinary, opContinuation:
			if _, err := backend.Write(frame.payload); err != nil {
				return
			}
		case opPing:
			writes.Lock()
			writeTestFrame(conn, true, opPong, frame.payload)
			writes.Unlock()
		case opClose:
			return
		}
	}
}

func (e *testEdge) url(scheme, path string) string {
	return scheme + "://" + e.listener.Addr().String() + path
}

func largeTagsHandler(name string) http.Handler {
	mux := http.NewServeMux()
	testRPC(mux, rpc.OperatorListTagsProcedure, func(context.Context, *v2.ListTagsRequest) (*v2.ListTagsResponse, error) {
		return &v2.ListTagsResponse{Tags: []*v2.Tag{{TagId: "lead", Name: name}}}, nil
	})
	testRPC(mux, rpc.ConversationsSendMessageProcedure, func(_ context.Context, req *v2.SendMessageRequest) (*v2.ConversationMessage, error) {
		return &v2.ConversationMessage{Task: &v2.Task{TaskId: "task", TagId: req.GetTagId(), Prompt: req.GetText(), State: v2.TaskState_TASK_STATE_QUEUED}, Conversation: req.GetConversation()}, nil
	})
	return mux
}

// A wss:// Gateway URL reaches the Gateway's TLS inside a WebSocket whose outer TLS an edge
// terminates. Both directions carry more than one WebSocket message's worth of bytes.
func TestRuntimeV2CrossesAWSSTunnelWithInnerTLS(t *testing.T) {
	name := strings.Repeat("n", 300*1024)
	server, target := testGateway(t, largeTagsHandler(name), true)
	edge := startTestEdge(t, server.Listener.Addr().String(), &tls.Config{Certificates: server.TLS.Certificates})
	target.URL = edge.url("wss", "/supertag")
	c, err := NewRuntimeV2(target, "test-version")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tags, err := c.ListTags(ctx)
	if err != nil || len(tags) != 1 || tags[0].GetMetadata().GetName() != name {
		t.Fatalf("ListTags through the tunnel failed: %v", err)
	}
	text := strings.Repeat("t", 600*1024)
	sent, err := c.SendMessage(ctx, "lead", "default", text)
	if err != nil || sent.GetText() != text {
		t.Fatalf("SendMessage through the tunnel failed: %v", err)
	}
	edge.mu.Lock()
	defer edge.mu.Unlock()
	if len(edge.paths) != 1 || edge.paths[0] != "/supertag" {
		t.Errorf("tunnel upgrades = %v, want one to /supertag", edge.paths)
	}
	if edge.origins != 0 || edge.unmasked != 0 || edge.opcodes[opText] != 0 {
		t.Errorf("tunnel sent Origin %d times, %d unmasked frames, %d text frames", edge.origins, edge.unmasked, edge.opcodes[opText])
	}
	if edge.largest > tunnelMaxMessage || edge.opcodes[opBinary] < 3 {
		t.Errorf("largest message %d bytes over %d binary messages", edge.largest, edge.opcodes[opBinary])
	}
}

// A loopback ws:// URL carries cleartext HTTP/2 through the tunnel.
func TestRuntimeV2CrossesALoopbackWSTunnel(t *testing.T) {
	server, target := testGateway(t, largeTagsHandler("lead"), false)
	edge := startTestEdge(t, server.Listener.Addr().String(), nil)
	target.URL = edge.url("ws", "")
	c, err := NewRuntimeV2(target, "test-version")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	tags, err := c.ListTags(t.Context())
	if err != nil || len(tags) != 1 {
		t.Fatalf("ListTags through the tunnel = %v, %v", tags, err)
	}
	edge.mu.Lock()
	defer edge.mu.Unlock()
	if len(edge.paths) != 1 || edge.paths[0] != "/" {
		t.Errorf("tunnel upgrades = %v", edge.paths)
	}
}

// A wss:// target never falls back to cleartext: a tunnel to a Gateway without TLS fails.
func TestRuntimeV2WSSTunnelRequiresInnerTLS(t *testing.T) {
	cleartext, _ := testGateway(t, largeTagsHandler("lead"), false)
	secure, target := testGateway(t, largeTagsHandler("lead"), true)
	edge := startTestEdge(t, cleartext.Listener.Addr().String(), &tls.Config{Certificates: secure.TLS.Certificates})
	target.URL = edge.url("wss", "")
	c, err := NewRuntimeV2(target, "test-version")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := c.ListTags(ctx); err == nil {
		t.Fatal("a wss:// tunnel reached a Gateway without inner TLS")
	}
}

// The edge's certificate is checked before the upgrade: one that does not name the URL's host
// fails the dial, and no upgrade request reaches the edge.
func TestRuntimeV2WSSTunnelChecksTheEdgeCertificate(t *testing.T) {
	server, target := testGateway(t, largeTagsHandler("lead"), true)
	edge := startTestEdge(t, server.Listener.Addr().String(), &tls.Config{Certificates: server.TLS.Certificates})
	_, port, _ := net.SplitHostPort(edge.listener.Addr().String())
	// The test certificate names 127.0.0.1 and example.com, not localhost.
	target.URL = "wss://localhost:" + port
	c, err := NewRuntimeV2(target, "test-version")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := c.ListTags(ctx); err == nil {
		t.Fatal("a wss:// tunnel accepted an edge certificate for another name")
	}
	edge.mu.Lock()
	defer edge.mu.Unlock()
	if len(edge.paths) != 0 {
		t.Fatalf("an upgrade crossed an untrusted edge: %v", edge.paths)
	}
}

func tunnelPair(t *testing.T, ping time.Duration) (*tunnelConn, net.Conn) {
	t.Helper()
	client, server := net.Pipe()
	c := newTunnelConn(client, bufio.NewReader(client), ping)
	t.Cleanup(func() { c.Close(); server.Close() })
	return c, server
}

func TestTunnelSplitsLargeWritesIntoMaskedBinaryMessages(t *testing.T) {
	c, peer := tunnelPair(t, time.Minute)
	large := bytes.Repeat([]byte{7}, 2*tunnelMaxMessage+3)
	go c.Write(large)
	var received []byte
	for len(received) < len(large) {
		frame, err := readTestFrame(peer)
		if err != nil {
			t.Fatal(err)
		}
		if !frame.fin || frame.opcode != opBinary || !frame.masked || len(frame.payload) > tunnelMaxMessage {
			t.Fatalf("frame fin=%v opcode=%d masked=%v length=%d", frame.fin, frame.opcode, frame.masked, len(frame.payload))
		}
		received = append(received, frame.payload...)
	}
	if !bytes.Equal(received, large) {
		t.Fatal("the tunnel changed the bytes")
	}
	go func() {
		writeTestFrame(peer, false, opBinary, []byte("hello"))
		writeTestFrame(peer, true, opContinuation, []byte(" world"))
		writeTestFrame(peer, true, opClose, []byte{0x03, 0xe8})
		io.Copy(io.Discard, peer)
	}()
	text, err := io.ReadAll(c)
	if err != nil || string(text) != "hello world" {
		t.Fatalf("read %q, %v", text, err)
	}
}

func TestTunnelRefusesTextAndOversizedMessages(t *testing.T) {
	c, peer := tunnelPair(t, time.Minute)
	go func(peer net.Conn) {
		writeTestFrame(peer, true, opText, []byte("not gRPC"))
		io.Copy(io.Discard, peer)
	}(peer)
	if _, err := c.Read(make([]byte, 8)); err == nil || !strings.Contains(err.Error(), "only binary") {
		t.Fatalf("text message read = %v", err)
	}
	c, peer = tunnelPair(t, time.Minute)
	go func(peer net.Conn) {
		peer.Write([]byte{0x82, 127, 0, 0, 0, 0, 0, 4, 0, 1})
		io.Copy(io.Discard, peer)
	}(peer)
	if _, err := c.Read(make([]byte, 8)); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("oversized message read = %v", err)
	}
}

func TestTunnelAnswersPingsAndStaysOpenWithAnAnsweringPeer(t *testing.T) {
	ping := 20 * time.Millisecond
	c, peer := tunnelPair(t, ping)
	pings := make(chan int, 1)
	go func() {
		count := 0
		writeTestFrame(peer, true, opPing, []byte("p"))
		for {
			frame, err := readTestFrame(peer)
			if err != nil {
				pings <- count
				return
			}
			switch frame.opcode {
			case opPong:
				if string(frame.payload) != "p" {
					t.Errorf("pong payload %q", frame.payload)
				}
			case opPing:
				count++
				writeTestFrame(peer, true, opPong, nil)
				if count == 8 {
					writeTestFrame(peer, true, opBinary, []byte("!"))
				}
			}
		}
	}()
	var one [1]byte
	if _, err := io.ReadFull(c, one[:]); err != nil || one[0] != '!' {
		t.Fatalf("read after %v of pings = %q, %v", 8*ping, one, err)
	}
	c.Close()
	if count := <-pings; count < 8 {
		t.Fatalf("%d pings", count)
	}
}

func TestTunnelFailsAPeerThatStopsAnswering(t *testing.T) {
	ping := 20 * time.Millisecond
	c, peer := tunnelPair(t, ping)
	// The peer reads, so pings are delivered, but it never answers.
	go io.Copy(io.Discard, peer)
	started := time.Now()
	_, err := c.Read(make([]byte, 8))
	if !errors.Is(err, errSilentPeer) {
		t.Fatalf("read from a silent peer = %v", err)
	}
	if elapsed := time.Since(started); elapsed < 3*ping {
		t.Fatalf("a silent peer failed after %v, before three intervals", elapsed)
	}
}

func TestTunnelDialRefusesABadUpgrade(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		http.ReadRequest(bufio.NewReader(conn))
		io.WriteString(conn, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: wrong\r\n\r\n")
	}()
	u, err := url.Parse("ws://" + listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (tunnelDialer{url: u}).DialContext(t.Context(), "tcp", ""); err == nil {
		t.Fatal("an upgrade with the wrong accept key was used")
	}
}
