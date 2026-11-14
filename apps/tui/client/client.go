// Package client talks to a SuperTag Control Plane over its runtime.v2 gRPC services: a client
// whose calls project the replies into the terminal UI's presentation types, a follower that
// turns one message's Task events into the events the UI shows, and a watcher that keeps the UI's
// view of Tags, conversations, Objectives, Teams and the inbox current.
package client

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"time"

	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/apps/tui/views"
)

// Target names the Control Plane to talk to and the token to talk to it with.
type Target struct {
	URL            string `json:"url"`
	Token          string `json:"token"`
	Name           string `json:"name,omitempty"`
	Workspace      string `json:"workspace,omitempty"`
	ServerCAFile   string `json:"server_ca_file,omitempty"`
	ClientCertFile string `json:"client_cert_file,omitempty"`
	ClientKeyFile  string `json:"client_key_file,omitempty"`
}

// APIError is a request the Control Plane refused, with the sentence it gave.
type APIError struct {
	Code    connect.Code
	Message string
}

func (e *APIError) Error() string { return e.Message }

// clientVersionHeader carries the client's release, as the CLI sends it.
const clientVersionHeader = "SuperTag-Client-Version"

// unaryTimeout bounds each call that is not a stream.
const unaryTimeout = 30 * time.Second

// sendRetryPause is the pause before the first retry of SendMessage or AnswerQuestion; the
// second waits twice as long.
var sendRetryPause = time.Second

// Client calls one Control Plane.
type Client struct {
	target  Target
	origin  string
	version string
	http    *http.Client
	runtime *runtimeClient
}

// Target is the Control Plane this client calls.
func (c *Client) Target() Target { return c.target }

// Close releases idle connections when the TUI leaves this target.
func (c *Client) Close() {
	if c != nil && c.http != nil {
		c.http.CloseIdleConnections()
	}
}

func (c *Client) setHeaders(header http.Header) {
	header.Set("Authorization", "Bearer "+c.target.Token)
	if c.version != "" {
		header.Set(clientVersionHeader, c.version)
	}
}

// headers sends the bearer token and client version on every RPC.
type headers struct{ c *Client }

func (h headers) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		h.c.setHeaders(req.Header())
		return next(ctx, req)
	}
}

func (h headers) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return func(ctx context.Context, spec connect.Spec) connect.StreamingClientConn {
		conn := next(ctx, spec)
		h.c.setHeaders(conn.RequestHeader())
		return conn
	}
}

func (headers) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return next
}

// maxTagPages bounds ListTags, so an organization with very many Tags still gets an answer.
const maxTagPages = 10

// ListTags returns the organization's active Tags by name, read with ResourceService.
func (c *Client) ListTags(ctx context.Context) ([]*views.Tag, error) {
	return c.runtime.listTags(ctx)
}

// SendMessage sends text to the Tag in the named conversation. A retry after a failure that may
// not have reached the Control Plane reuses the same idempotency key, so the Tag gets the message
// once.
func (c *Client) SendMessage(ctx context.Context, tag, conversation, text string) (*views.Message, error) {
	return c.runtime.sendMessage(ctx, tag, conversation, text)
}

// retrying makes an idempotent call, retrying it twice after a failure that may not have reached
// the Control Plane, with a growing pause.
func retrying[T any](ctx context.Context, call func(context.Context) (T, error)) (T, error) {
	for attempt := 0; ; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, unaryTimeout)
		res, err := call(callCtx)
		cancel()
		if err == nil {
			return res, nil
		}
		if attempt >= 2 || ctx.Err() != nil || !transient(err) || !pause(ctx, time.Duration(attempt+1)*sendRetryPause) {
			var zero T
			return zero, apiError(err)
		}
	}
}

// GetMessage reads a single message the operator can follow.
func (c *Client) GetMessage(ctx context.Context, tag, taskID string) (*views.Message, error) {
	message, err := c.runtime.getMessage(ctx, tag, taskID)
	if err != nil {
		return nil, err
	}
	return c.runtime.projectMessage(ctx, message)
}

// ListMessages returns one page of the messages the caller sent in the conversation, newest
// first, and the token of the next page.
func (c *Client) ListMessages(ctx context.Context, tag, conversation string, pageSize int32, pageToken string) ([]*views.Message, string, error) {
	return c.runtime.listMessages(ctx, tag, conversation, pageSize, pageToken)
}

// maxConversationPages bounds ListConversations, so a caller with very many conversations still
// gets an answer.
const maxConversationPages = 10

// ListConversations returns the caller's conversations with the named Tag, or with every Tag when
// tag is empty, the most recent first.
func (c *Client) ListConversations(ctx context.Context, tag string) ([]*views.Conversation, error) {
	return c.runtime.listConversations(ctx, tag)
}

func idempotencyKey() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return "tui-" + hex.EncodeToString(b[:]), nil
}

// apiError turns a refused RPC into an APIError carrying the Control Plane's sentence. Other
// errors, such as a cancelled context, pass through.
func apiError(err error) error {
	var connectErr *connect.Error
	if !errors.As(err, &connectErr) {
		return err
	}
	message := connectErr.Message()
	if connectErr.Code() == connect.CodeUnimplemented {
		message = "Control Plane does not support this SuperTag operator API"
	}
	if message == "" {
		message = "Control Plane refused the call: " + connectErr.Code().String()
	}
	return &APIError{Code: connectErr.Code(), Message: message}
}

// transient reports whether a failed call is worth retrying: the Control Plane could not be
// reached, dropped the call, or failed rather than refused.
func transient(err error) bool {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return retryable(apiErr.Code)
	}
	var connectErr *connect.Error
	if errors.As(err, &connectErr) {
		return retryable(connectErr.Code())
	}
	return true
}

func retryable(code connect.Code) bool {
	switch code {
	case connect.CodeUnavailable, connect.CodeResourceExhausted, connect.CodeInternal, connect.CodeUnknown,
		connect.CodeDeadlineExceeded, connect.CodeAborted:
		return true
	}
	return false
}

// pause waits d; false when ctx ended first.
func pause(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}
