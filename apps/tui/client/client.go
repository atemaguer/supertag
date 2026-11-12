// Package client talks to a SuperTag Control Plane: the operator API's ConversationService,
// ObjectiveService, InboxService, WorkService, TeamService, MailboxService, HostService,
// ResourceService and EventService through the generated Connect client, a follower that turns one message's
// FollowMessage stream into the events a terminal UI shows, and a watcher that keeps the UI's view
// of Tags, conversations, Objectives, Teams and the inbox current.
package client

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
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
	target        Target
	origin        string
	version       string
	http          *http.Client
	conversations operatorv1connect.ConversationServiceClient
	objectives    operatorv1connect.ObjectiveServiceClient
	inbox         operatorv1connect.InboxServiceClient
	events        operatorv1connect.EventServiceClient
	work          operatorv1connect.WorkServiceClient
	teams         operatorv1connect.TeamServiceClient
	mailbox       operatorv1connect.MailboxServiceClient
	hosts         operatorv1connect.HostServiceClient
	resources     operatorv1connect.ResourceServiceClient
	runtime       *runtimeClient
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
	c.work = operatorv1connect.NewWorkServiceClient(httpClient, c.origin, options...)
	c.teams = operatorv1connect.NewTeamServiceClient(httpClient, c.origin, options...)
	c.mailbox = operatorv1connect.NewMailboxServiceClient(httpClient, c.origin, options...)
	c.hosts = operatorv1connect.NewHostServiceClient(httpClient, c.origin, options...)
	c.resources = operatorv1connect.NewResourceServiceClient(httpClient, c.origin, options...)
	return c, nil
}

// Target is the Control Plane this client calls.
func (c *Client) Target() Target { return c.target }

// RuntimeV2 reports whether the target uses the Gateway's Rust runtime API.
func (c *Client) RuntimeV2() bool { return c != nil && c.runtime != nil }

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
func (c *Client) ListTags(ctx context.Context) ([]*operatorv1.Tag, error) {
	if c.RuntimeV2() {
		return c.runtime.listTags(ctx)
	}
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	var tags []*operatorv1.Tag
	token := ""
	for range maxTagPages {
		res, err := c.resources.ListResources(ctx, connect.NewRequest(&operatorv1.ListResourcesRequest{
			Kind: operatorv1.ResourceKind_RESOURCE_KIND_TAG, PageSize: 500, PageToken: token,
		}))
		if err != nil {
			return nil, apiError(err)
		}
		for _, resource := range res.Msg.GetResources() {
			if tag := resource.GetTag(); tag != nil {
				tags = append(tags, tag)
			}
		}
		token = res.Msg.GetNextPageToken()
		if token == "" {
			break
		}
	}
	return tags, nil
}

// SendMessage sends text to the Tag in the named conversation. A retry after a failure that may
// not have reached the Control Plane reuses the same idempotency key, so the Tag gets the message
// once.
func (c *Client) SendMessage(ctx context.Context, tag, conversation, text string) (*operatorv1.Message, error) {
	if c.RuntimeV2() {
		return c.runtime.sendMessage(ctx, tag, conversation, text)
	}
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

// GetMessage reads a single message the operator can follow.
func (c *Client) GetMessage(ctx context.Context, tag, taskID string) (*operatorv1.Message, error) {
	if c.RuntimeV2() {
		message, err := c.runtime.getMessage(ctx, tag, taskID)
		if err != nil {
			return nil, err
		}
		return c.runtime.projectMessage(ctx, message)
	}
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	res, err := c.conversations.GetMessage(ctx, connect.NewRequest(&operatorv1.GetMessageRequest{Tag: tag, TaskId: taskID}))
	if err != nil {
		return nil, apiError(err)
	}
	return res.Msg, nil
}

// ListMessages returns one page of the messages the caller sent in the conversation, newest
// first, and the token of the next page.
func (c *Client) ListMessages(ctx context.Context, tag, conversation string, pageSize int32, pageToken string) ([]*operatorv1.Message, string, error) {
	if c.RuntimeV2() {
		return c.runtime.listMessages(ctx, tag, conversation, pageSize, pageToken)
	}
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

// ListConversations returns the caller's conversations with the named Tag, or with every Tag when
// tag is empty, the most recent first.
func (c *Client) ListConversations(ctx context.Context, tag string) ([]*operatorv1.Conversation, error) {
	if c.RuntimeV2() {
		return c.runtime.listConversations(ctx, tag)
	}
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	var all []*operatorv1.Conversation
	token := ""
	for range maxConversationPages {
		res, err := c.conversations.ListConversations(ctx, connect.NewRequest(&operatorv1.ListConversationsRequest{
			Tag: tag, PageSize: 100, PageToken: token,
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
