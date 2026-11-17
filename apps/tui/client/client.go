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

// SendMessage sends text to the caller's conversation with the Tag. operationID names the
// message: every attempt with the same ID, including one after a restart, delivers it at most
// once. A failure that may not have reached the Control Plane is retried with it.
func (c *Client) SendMessage(ctx context.Context, tag, text, operationID string) (*views.Message, error) {
	return c.runtime.sendMessage(ctx, tag, text, operationID)
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

// MessagePage is one page of a conversation, newest first.
type MessagePage struct {
	Messages []*views.Message
	// NextCursor reads the page before this one; empty on the oldest page.
	NextCursor string
	// ConversationID identifies the conversation. It changes only when the conversation is
	// replaced, and is empty before the caller's first message to the Tag.
	ConversationID string
	// Incremental says the page holds only what changed since the query's After. Otherwise it is
	// the newest page, which replaces the caller's copy.
	Incremental bool
}

// MessageQuery is what ListMessages reads.
type MessageQuery struct {
	Limit int32
	// Cursor reads the page before a page's NextCursor.
	Cursor string
	// After, with ConversationID, the conversation a copy came from, reads only what changed
	// since the copy's latest order: later messages and the current state of Refresh, the turns
	// the copy holds unfinished. The latest 128 are refreshed.
	After          uint64
	ConversationID string
	Refresh        []string
}

// ListMessages returns one page of the caller's conversation with the Tag, newest first, or what
// changed since a copy of it. Its messages can belong to different Sessions of the conversation.
func (c *Client) ListMessages(ctx context.Context, tag string, query MessageQuery) (MessagePage, error) {
	return c.runtime.listMessages(ctx, tag, query)
}

// NewOperationID names a message to send, so that sending it again delivers it at most once.
func NewOperationID() (string, error) { return idempotencyKey() }

// ListConversations returns the caller's conversations, one per Tag it has talked to, the latest
// active first.
func (c *Client) ListConversations(ctx context.Context) ([]*views.Conversation, error) {
	return c.runtime.listConversations(ctx)
}

// MarkConversationRead records that the caller read its conversation with the Tag up to the
// message with this order.
func (c *Client) MarkConversationRead(ctx context.Context, tag string, order uint64) error {
	return c.runtime.markConversationRead(ctx, tag, order)
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
