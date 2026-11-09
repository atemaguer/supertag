// Package client talks to a SuperTag Control Plane: the operator API's ConversationService,
// ObjectiveService, InboxService and EventService through the generated Connect client, a
// follower that turns one message's FollowMessage stream into the events a terminal UI shows, and
// a watcher that keeps the UI's view of Tags, conversations, Objectives and the inbox current.
package client

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1/operatorv1connect"
)

// Target names the Control Plane to talk to and the token to talk to it with.
type Target struct {
	URL   string `json:"url"`
	Token string `json:"token"`
	Name  string `json:"name,omitempty"`
}

// Tag is the part of a Tag resource the UI shows.
type Tag struct {
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Status struct {
		Phase string `json:"phase"`
	} `json:"status"`
}

// Name is the Tag's name.
func (t Tag) Name() string { return t.Metadata.Name }

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
	target        Target
	origin        string
	version       string
	http          *http.Client
	conversations operatorv1connect.ConversationServiceClient
	objectives    operatorv1connect.ObjectiveServiceClient
	inbox         operatorv1connect.InboxServiceClient
	events        operatorv1connect.EventServiceClient
}

// New returns a client for target; version is sent as the client version. Only the URL's origin
// is used. Calls use the Connect protocol with JSON bodies over HTTP/1.1, so every call is a plain
// HTTPS request that any proxy carries.
func New(target Target, version string) (*Client, error) {
	base, err := url.Parse(strings.TrimSpace(target.URL))
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" {
		return nil, fmt.Errorf("invalid Control Plane URL %q", target.URL)
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Protocols = new(http.Protocols)
	transport.Protocols.SetHTTP1(true)
	httpClient := &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("the Control Plane redirected; requests must stay on the configured origin")
		},
	}
	c := &Client{target: target, origin: base.Scheme + "://" + base.Host, version: version, http: httpClient}
	options := []connect.ClientOption{connect.WithProtoJSON(), connect.WithInterceptors(headers{c})}
	c.conversations = operatorv1connect.NewConversationServiceClient(httpClient, c.origin, options...)
	c.objectives = operatorv1connect.NewObjectiveServiceClient(httpClient, c.origin, options...)
	c.inbox = operatorv1connect.NewInboxServiceClient(httpClient, c.origin, options...)
	c.events = operatorv1connect.NewEventServiceClient(httpClient, c.origin, options...)
	return c, nil
}

// Target is the Control Plane this client calls.
func (c *Client) Target() Target { return c.target }

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

// ListTags returns the organization's Tags, read from the resource route `GET /api/v1/tags`.
func (c *Client) ListTags(ctx context.Context) ([]Tag, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.origin+"/api/v1/tags", nil)
	if err != nil {
		return nil, err
	}
	c.setHeaders(req.Header)
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return nil, responseError(res)
	}
	var list struct {
		Items []Tag `json:"items"`
	}
	if err := json.NewDecoder(res.Body).Decode(&list); err != nil {
		return nil, fmt.Errorf("reading the Tags: %w", err)
	}
	return list.Items, nil
}

// SendMessage sends text to the Tag in the named conversation. A retry after a failure that may
// not have reached the Control Plane reuses the same idempotency key, so the Tag gets the message
// once.
func (c *Client) SendMessage(ctx context.Context, tag, conversation, text string) (*operatorv1.Message, error) {
	key, err := idempotencyKey()
	if err != nil {
		return nil, err
	}
	request := &operatorv1.SendMessageRequest{Tag: tag, Conversation: conversation, Text: text, IdempotencyKey: key}
	return retrying(ctx, func(ctx context.Context) (*operatorv1.Message, error) {
		res, err := c.conversations.SendMessage(ctx, connect.NewRequest(request))
		if err != nil {
			return nil, err
		}
		return res.Msg, nil
	})
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

// ListMessages returns one page of the messages the caller sent in the conversation, newest
// first, and the token of the next page.
func (c *Client) ListMessages(ctx context.Context, tag, conversation string, pageSize int32, pageToken string) ([]*operatorv1.Message, string, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	res, err := c.conversations.ListMessages(ctx, connect.NewRequest(&operatorv1.ListMessagesRequest{
		Tag: tag, Conversation: conversation, PageSize: pageSize, PageToken: pageToken,
	}))
	if err != nil {
		return nil, "", apiError(err)
	}
	return res.Msg.GetMessages(), res.Msg.GetNextPageToken(), nil
}

// maxConversationPages bounds ListConversations, so a caller with very many conversations still
// gets an answer.
const maxConversationPages = 10

// ListConversations returns the caller's conversations with every Tag, the most recent first.
func (c *Client) ListConversations(ctx context.Context) ([]*operatorv1.Conversation, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	var all []*operatorv1.Conversation
	token := ""
	for range maxConversationPages {
		res, err := c.conversations.ListConversations(ctx, connect.NewRequest(&operatorv1.ListConversationsRequest{
			PageSize: 100, PageToken: token,
		}))
		if err != nil {
			return nil, apiError(err)
		}
		all = append(all, res.Msg.GetConversations()...)
		token = res.Msg.GetNextPageToken()
		if token == "" {
			break
		}
	}
	return all, nil
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

// responseError reads an HTTP refusal's sentence the way the CLI does: `message`, else an `error`
// that is a sentence, else the HTTP status.
func responseError(res *http.Response) error {
	var body struct {
		Message string `json:"message"`
		Error   string `json:"error"`
	}
	_ = json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&body)
	message := body.Message
	if message == "" && strings.ContainsAny(body.Error, " \t\n") {
		message = body.Error
	}
	if message == "" {
		message = fmt.Sprintf("Control Plane returned HTTP %d", res.StatusCode)
	}
	return &APIError{Code: httpCode(res.StatusCode), Message: message}
}

func httpCode(status int) connect.Code {
	switch {
	case status == http.StatusBadRequest:
		return connect.CodeInvalidArgument
	case status == http.StatusUnauthorized:
		return connect.CodeUnauthenticated
	case status == http.StatusForbidden:
		return connect.CodePermissionDenied
	case status == http.StatusNotFound:
		return connect.CodeNotFound
	case status == http.StatusConflict:
		return connect.CodeFailedPrecondition
	case status == http.StatusTooManyRequests:
		return connect.CodeResourceExhausted
	case status == http.StatusServiceUnavailable:
		return connect.CodeUnavailable
	case status >= 500:
		return connect.CodeInternal
	}
	return connect.CodeUnknown
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
