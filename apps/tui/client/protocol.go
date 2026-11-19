package client

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"

	v2 "github.com/atemaguer/supertag/sdks/go/runtimev2"
	"github.com/atemaguer/supertag/sdks/go/runtimev2/runtimev2connect"
)

// protocolHeader names, on every call, the protocol version this client negotiated with the
// Gateway. The Gateway refuses a call without it.
const protocolHeader = "X-Supertag-Protocol"

// protocolVersions are the SuperTag protocol versions this client speaks.
var protocolVersions = []uint32{6}

// negotiationTimeout bounds one negotiation exchange.
const negotiationTimeout = 5 * time.Second

// protocolSession negotiates once with the Gateway, before the first call that needs it, and
// again after the Gateway refuses the version it holds.
type protocolSession struct {
	client runtimev2connect.ProtocolNegotiationClient
	build  string
	// endpoint names the Gateway in a version mismatch.
	endpoint string
	mu       sync.Mutex
	version  uint32
}

func (p *protocolSession) negotiated(ctx context.Context) (uint32, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.version != 0 {
		return p.version, nil
	}
	ctx, cancel := context.WithTimeout(ctx, negotiationTimeout)
	defer cancel()
	// The exchange carries no credentials.
	res, err := p.client.Negotiate(ctx, connect.NewRequest(&v2.NegotiateProtocolRequest{
		Role:             v2.ServiceRole_SERVICE_ROLE_CLIENT,
		ProtocolVersions: protocolVersions,
		BuildVersion:     p.build,
	}))
	if err != nil {
		var connectErr *connect.Error
		if !errors.As(err, &connectErr) || retryable(connectErr.Code()) {
			return 0, apiError(err)
		}
		if connectErr.Code() == connect.CodeFailedPrecondition && strings.HasPrefix(connectErr.Message(), "incompatible SuperTag protocol") {
			return 0, p.mismatch(parseRefusal(connectErr.Message()))
		}
		if connectErr.Code() == connect.CodeUnimplemented {
			return 0, &APIError{Code: connect.CodeFailedPrecondition, Message: "incompatible SuperTag protocol: the Gateway does not offer SuperTag protocol negotiation"}
		}
		return 0, &APIError{Code: connect.CodeFailedPrecondition, Message: "the SuperTag Gateway refused this operator client: " + connectErr.Message()}
	}
	selected := res.Msg.GetProtocolVersion()
	if res.Msg.GetRole() != v2.ServiceRole_SERVICE_ROLE_GATEWAY {
		return 0, &APIError{Code: connect.CodeFailedPrecondition, Message: "this operator client expected a SuperTag Gateway but reached another service"}
	}
	if !slices.Contains(protocolVersions, selected) || !slices.Contains(res.Msg.GetProtocolVersions(), selected) {
		versions := res.Msg.GetProtocolVersions()
		if len(versions) == 0 {
			versions = []uint32{selected}
		}
		return 0, p.mismatch(&peerRelease{build: printable(res.Msg.GetBuildVersion()), versions: versions}, "")
	}
	p.version = selected
	return selected, nil
}

// peerRelease is what a Gateway said of its release while negotiating.
type peerRelease struct {
	build    string
	versions []uint32
}

// parseRefusal reads the Gateway's release and versions out of its refusal. Every SuperTag
// release that negotiates refuses with "... (SuperTag BUILD) speaks protocol versions [V, ...] ...".
func parseRefusal(message string) (*peerRelease, string) {
	_, rest, ok := strings.Cut(message, "(SuperTag ")
	if !ok {
		return nil, message
	}
	build, rest, ok := strings.Cut(rest, ") speaks protocol versions [")
	if !ok {
		return nil, message
	}
	list, _, ok := strings.Cut(rest, "]")
	if !ok {
		return nil, message
	}
	var versions []uint32
	for _, item := range strings.Split(list, ",") {
		version, err := strconv.ParseUint(strings.TrimSpace(item), 10, 32)
		if err != nil {
			return nil, message
		}
		versions = append(versions, uint32(version))
	}
	return &peerRelease{build: printable(build), versions: versions}, ""
}

// printable keeps up to 64 visible ASCII characters of a peer's release.
func printable(build string) string {
	var kept strings.Builder
	for _, r := range build {
		if r > ' ' && r < 0x7f && kept.Len() < 64 {
			kept.WriteRune(r)
		}
	}
	if kept.Len() == 0 {
		return "unknown"
	}
	return kept.String()
}

// spoken is "protocol 3", or "protocols 2, 3".
func spoken(versions []uint32) string {
	items := make([]string, len(versions))
	for i, version := range versions {
		items[i] = strconv.FormatUint(uint64(version), 10)
	}
	if len(items) == 1 {
		return "protocol " + items[0]
	}
	return "protocols " + strings.Join(items, ", ")
}

// mismatch reports a Gateway that speaks no protocol version this client speaks, naming
// both releases, where the Gateway runs, and which side to upgrade.
func (p *protocolSession) mismatch(peer *peerRelease, refusal string) error {
	at := ""
	if p.endpoint != "" {
		at = " at " + p.endpoint
	}
	message := "This TUI speaks SuperTag " + spoken(protocolVersions) + ", but the Gateway" + at
	switch {
	case peer == nil:
		refusal = strings.TrimRight(strings.Map(func(r rune) rune {
			if r < ' ' || r == 0x7f {
				return -1
			}
			return r
		}, refusal), ". ")
		message += " refused it: " + refusal + ". Run the same SuperTag release on both."
	case slices.Max(peer.versions) < slices.Min(protocolVersions):
		message += " runs SuperTag " + peer.build + " (" + spoken(peer.versions) + "). Upgrade the Gateway."
	case slices.Max(protocolVersions) < slices.Min(peer.versions):
		message += " runs SuperTag " + peer.build + " (" + spoken(peer.versions) + "). Upgrade this TUI."
	default:
		message += " runs SuperTag " + peer.build + " (" + spoken(peer.versions) + "). Run the same SuperTag release on both."
	}
	return &APIError{Code: connect.CodeFailedPrecondition, Message: message, Mismatch: true}
}

// ProtocolMismatch reports whether err is a Gateway from a release that speaks other
// protocol versions. Its message names both releases and the fix.
func ProtocolMismatch(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Mismatch
}

// forget drops a version the Gateway refused, so the next call negotiates again.
func (p *protocolSession) forget(err error) {
	var connectErr *connect.Error
	if errors.As(err, &connectErr) && connectErr.Code() == connect.CodeFailedPrecondition &&
		(strings.HasPrefix(connectErr.Message(), "incompatible SuperTag protocol") ||
			strings.Contains(connectErr.Message(), "did not negotiate a protocol version")) {
		p.mu.Lock()
		p.version = 0
		p.mu.Unlock()
	}
}

// negotiatedCalls negotiates before the first call and names the selected version on each.
type negotiatedCalls struct{ session *protocolSession }

func (n negotiatedCalls) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		version, err := n.session.negotiated(ctx)
		if err != nil {
			return nil, err
		}
		req.Header().Set(protocolHeader, strconv.FormatUint(uint64(version), 10))
		res, err := next(ctx, req)
		if err != nil {
			n.session.forget(err)
		}
		return res, err
	}
}

func (n negotiatedCalls) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return func(ctx context.Context, spec connect.Spec) connect.StreamingClientConn {
		version, err := n.session.negotiated(ctx)
		if err != nil {
			return refusedStream{spec: spec, err: err}
		}
		conn := next(ctx, spec)
		conn.RequestHeader().Set(protocolHeader, strconv.FormatUint(uint64(version), 10))
		return forgettingStream{StreamingClientConn: conn, session: n.session}
	}
}

func (negotiatedCalls) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return next
}

// forgettingStream renegotiates after the Gateway refuses a stream's protocol version.
type forgettingStream struct {
	connect.StreamingClientConn
	session *protocolSession
}

func (s forgettingStream) Receive(message any) error {
	err := s.StreamingClientConn.Receive(message)
	if err != nil {
		s.session.forget(err)
	}
	return err
}

// refusedStream is a stream that never opened because negotiation failed.
type refusedStream struct {
	spec connect.Spec
	err  error
}

func (s refusedStream) Spec() connect.Spec         { return s.spec }
func (refusedStream) Peer() connect.Peer           { return connect.Peer{} }
func (s refusedStream) Send(any) error             { return s.err }
func (refusedStream) RequestHeader() http.Header   { return http.Header{} }
func (refusedStream) CloseRequest() error          { return nil }
func (s refusedStream) Receive(any) error          { return s.err }
func (refusedStream) ResponseHeader() http.Header  { return http.Header{} }
func (refusedStream) ResponseTrailer() http.Header { return http.Header{} }
func (refusedStream) CloseResponse() error         { return nil }
