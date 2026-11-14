package client

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"

	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/apps/tui/views"
	v2 "github.com/atemaguer/supertag/rust/bindings/go/runtimev2"
	"github.com/atemaguer/supertag/rust/bindings/go/runtimev2/runtimev2connect"
)

// runtimeClient projects runtime v2 replies into the Go UI's existing presentation types.
// Every call on this client uses the Control Plane's generated gRPC client.
type runtimeClient struct {
	operator      runtimev2connect.OperatorClient
	conversations runtimev2connect.ConversationsClient
	objectives    runtimev2connect.ObjectivesClient
	teams         runtimev2connect.TeamsClient
	events        runtimev2connect.OperatorEventsClient
	inbox         runtimev2connect.InboxClient
	workSessions  runtimev2connect.WorkSessionsClient
	artifacts     runtimev2connect.ArtifactCatalogClient
	artifactFiles runtimev2connect.ArtifactTransfersClient
	enrollments   runtimev2connect.EnrollmentsClient
}

// New connects to the public Control Plane over binary gRPC and HTTP/2, natively for an
// `https://` or loopback `http://` URL, or through a WebSocket tunnel for a `wss://` or loopback
// `ws://` URL. The first call negotiates the SuperTag protocol version, which every call then
// names.
func New(target Target, version string) (*Client, error) {
	base, err := url.Parse(strings.TrimSpace(target.URL))
	tunnel := err == nil && (base.Scheme == "ws" || base.Scheme == "wss")
	if err != nil || base.Hostname() == "" || base.User != nil ||
		(!tunnel && base.Path != "" && base.Path != "/") || base.RawQuery != "" ||
		base.ForceQuery || base.Fragment != "" {
		return nil, errors.New("invalid Control Plane URL")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Protocols = new(http.Protocols)
	origin := base.Scheme + "://" + base.Host
	switch base.Scheme {
	case "http", "ws":
		ip := net.ParseIP(base.Hostname())
		if ip == nil || !ip.IsLoopback() {
			return nil, errors.New("cleartext Control Plane URL must use a loopback IP address")
		}
		if target.ServerCAFile != "" || target.ClientCertFile != "" || target.ClientKeyFile != "" {
			return nil, errors.New("Control Plane TLS settings require an HTTPS or WSS URL")
		}
		transport.Proxy = nil
		transport.Protocols.SetUnencryptedHTTP2(true)
	case "https", "wss":
		transport.Protocols.SetHTTP2(true)
		config, err := runtimeTLS(target)
		if err != nil {
			return nil, err
		}
		transport.TLSClientConfig = config
	default:
		return nil, errors.New("Control Plane URL must use http, https, ws or wss")
	}
	if tunnel {
		// The tunnel runs the same TLS, from runtimeTLS, inside the WebSocket. A `wss://` URL
		// never falls back to cleartext.
		dialer := tunnelDialer{url: base}
		if base.Scheme == "wss" {
			var serverCA []byte
			if target.ServerCAFile != "" {
				if serverCA, err = os.ReadFile(target.ServerCAFile); err != nil {
					return nil, fmt.Errorf("read Control Plane certificate authority: %w", err)
				}
			}
			if dialer.outer, err = outerTLS(serverCA); err != nil {
				return nil, err
			}
			dialer.inner = transport.TLSClientConfig.Clone()
			dialer.inner.ServerName = base.Hostname()
			dialer.inner.NextProtos = []string{"h2"}
			transport.DialTLSContext = dialer.DialTLSContext
		} else {
			transport.DialContext = dialer.DialContext
		}
		transport.Proxy = nil
		origin = tunnelURI(base)
	}
	if target.Token == "" {
		return nil, errors.New("Control Plane credential required")
	}
	httpClient := &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("the Control Plane redirected; requests must stay on the configured origin")
		},
	}
	c := &Client{target: target, origin: origin, version: version, http: httpClient}
	session := &protocolSession{
		client: runtimev2connect.NewProtocolNegotiationClient(httpClient, origin,
			connect.WithGRPC(), connect.WithReadMaxBytes(4096), connect.WithSendMaxBytes(4096)),
		build: version,
	}
	options := []connect.ClientOption{
		connect.WithGRPC(),
		connect.WithInterceptors(headers{c}, negotiatedCalls{session}),
		connect.WithReadMaxBytes(1024 * 1024),
		connect.WithSendMaxBytes(1024 * 1024),
	}
	c.runtime = &runtimeClient{
		operator:      runtimev2connect.NewOperatorClient(httpClient, origin, options...),
		conversations: runtimev2connect.NewConversationsClient(httpClient, origin, options...),
		objectives:    runtimev2connect.NewObjectivesClient(httpClient, origin, options...),
		teams:         runtimev2connect.NewTeamsClient(httpClient, origin, options...),
		events:        runtimev2connect.NewOperatorEventsClient(httpClient, origin, options...),
		inbox:         runtimev2connect.NewInboxClient(httpClient, origin, options...),
		workSessions:  runtimev2connect.NewWorkSessionsClient(httpClient, origin, options...),
		artifacts:     runtimev2connect.NewArtifactCatalogClient(httpClient, origin, options...),
		artifactFiles: runtimev2connect.NewArtifactTransfersClient(httpClient, origin, options...),
		enrollments:   runtimev2connect.NewEnrollmentsClient(httpClient, origin, options...),
	}
	return c, nil
}

func runtimeTLS(target Target) (*tls.Config, error) {
	config := &tls.Config{MinVersion: tls.VersionTLS12}
	if target.ServerCAFile != "" {
		certificates, err := os.ReadFile(target.ServerCAFile)
		if err != nil {
			return nil, fmt.Errorf("read Control Plane certificate authority: %w", err)
		}
		roots := x509.NewCertPool()
		if !roots.AppendCertsFromPEM(certificates) {
			return nil, errors.New("Control Plane certificate authority contains no PEM certificates")
		}
		config.RootCAs = roots
	}
	if (target.ClientCertFile == "") != (target.ClientKeyFile == "") {
		return nil, errors.New("configure both the Control Plane client certificate and key")
	}
	if target.ClientCertFile != "" {
		certificate, err := tls.LoadX509KeyPair(target.ClientCertFile, target.ClientKeyFile)
		if err != nil {
			return nil, fmt.Errorf("read Control Plane client identity: %w", err)
		}
		config.Certificates = []tls.Certificate{certificate}
	}
	return config, nil
}

func unavailable(feature string) error {
	return &APIError{Code: connect.CodeUnimplemented, Message: feature + " is unavailable on this Control Plane."}
}

func (c *runtimeClient) listTags(ctx context.Context) ([]*views.Tag, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	var tags []*views.Tag
	cursor := ""
	for range maxTagPages {
		res, err := c.operator.ListTags(ctx, connect.NewRequest(&v2.ListTagsRequest{Limit: 100, Cursor: cursor}))
		if err != nil {
			return nil, apiError(err)
		}
		for _, tag := range res.Msg.GetTags() {
			name := tag.GetName()
			if name == "" {
				name = tag.GetTagId()
			}
			tags = append(tags, &views.Tag{
				Metadata: &views.Metadata{Id: tag.GetTagId(), Name: name},
				Status:   &views.TagStatus{Phase: views.TagPhase_TAG_PHASE_ACTIVE},
			})
		}
		cursor = res.Msg.GetNextCursor()
		if cursor == "" {
			break
		}
	}
	return tags, nil
}

func (c *runtimeClient) sendMessage(ctx context.Context, tag, conversation, text string) (*views.Message, error) {
	key, err := idempotencyKey()
	if err != nil {
		return nil, err
	}
	body := &v2.SendMessageRequest{TagId: tag, Conversation: conversation, Text: text, OperationId: key}
	return retrying(ctx, func(ctx context.Context) (*views.Message, error) {
		res, err := c.conversations.SendMessage(ctx, connect.NewRequest(body))
		if err != nil {
			return nil, err
		}
		if res.Msg.GetTask().GetTaskId() == "" || res.Msg.GetTask().GetTagId() != tag || res.Msg.GetConversation() != conversation {
			return nil, &APIError{Code: connect.CodeDataLoss, Message: "Control Plane returned a different conversation message."}
		}
		return runtimeMessage(res.Msg), nil
	})
}

func (c *runtimeClient) getMessage(ctx context.Context, tag, id string) (*v2.ConversationMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	res, err := c.conversations.GetMessage(ctx, connect.NewRequest(&v2.GetMessageRequest{TagId: tag, TaskId: id}))
	if err != nil {
		return nil, apiError(err)
	}
	if res.Msg.GetTask().GetTaskId() != id || res.Msg.GetTask().GetTagId() != tag {
		return nil, &APIError{Code: connect.CodeDataLoss, Message: "Control Plane returned a different conversation Task."}
	}
	return res.Msg, nil
}

func (c *runtimeClient) listMessages(ctx context.Context, tag, conversation string, size int32, cursor string) ([]*views.Message, string, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	res, err := c.conversations.ListMessages(ctx, connect.NewRequest(&v2.ListMessagesRequest{
		TagId: tag, Conversation: conversation, Limit: uint32(max(size, 0)), Cursor: cursor,
	}))
	if err != nil {
		return nil, "", apiError(err)
	}
	items := make([]*views.Message, 0, len(res.Msg.GetMessages()))
	for _, message := range res.Msg.GetMessages() {
		if message.GetTask().GetTagId() != tag || message.GetTask().GetTaskId() == "" || message.GetConversation() != conversation {
			return nil, "", &APIError{Code: connect.CodeDataLoss, Message: "Control Plane returned a different conversation message."}
		}
		item, err := c.projectMessage(ctx, message)
		if err != nil {
			return nil, "", err
		}
		items = append(items, item)
	}
	return items, res.Msg.GetNextCursor(), nil
}

func (c *runtimeClient) listConversations(ctx context.Context, tag string) ([]*views.Conversation, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	var conversations []*views.Conversation
	cursor := ""
	for range maxConversationPages {
		res, err := c.conversations.ListConversations(ctx, connect.NewRequest(&v2.ListConversationsRequest{
			TagId: tag, Limit: 100, Cursor: cursor,
		}))
		if err != nil {
			return nil, apiError(err)
		}
		for _, conv := range res.Msg.GetConversations() {
			task := conv.GetLatestTask()
			preview, author := task.GetPrompt(), views.ConversationAuthor_CONVERSATION_AUTHOR_OPERATOR
			if task.GetTaskId() != "" {
				message, err := c.getMessage(ctx, tag, task.GetTaskId())
				if err != nil {
					return nil, err
				}
				if message.GetConversation() != conv.GetName() || message.GetTask().GetSessionId() != conv.GetSessionId() {
					return nil, workSessionDataLoss("Control Plane returned a different conversation preview.")
				}
				if message.GetWorkSessionReportId() != "" {
					preview, author = "Work Session report pending.", views.ConversationAuthor_CONVERSATION_AUTHOR_TAG
					if reply := runtimeReply(message.GetTask()); reply != nil {
						preview = reply.GetText()
					}
				}
			}
			if task.GetState() == v2.TaskState_TASK_STATE_SUCCEEDED && task.GetAttemptId() != "" && task.GetResult() != "" {
				preview, author = task.GetResult(), views.ConversationAuthor_CONVERSATION_AUTHOR_TAG
			}
			runes := []rune(preview)
			conversations = append(conversations, &views.Conversation{
				Tag: conv.GetTagId(), Name: conv.GetName(), SessionId: conv.GetSessionId(),
				LastMessageText: string(runes[:min(len(runes), 200)]), LastMessageAuthor: author,
			})
		}
		cursor = res.Msg.GetNextCursor()
		if cursor == "" {
			break
		}
	}
	return conversations, nil
}

func runtimeMessage(message *v2.ConversationMessage) *views.Message {
	if message == nil {
		return nil
	}
	task := message.GetTask()
	out := &views.Message{
		TaskId: task.GetTaskId(), Tag: task.GetTagId(), Conversation: message.GetConversation(),
		SessionId: task.GetSessionId(), Text: task.GetPrompt(), Status: views.ReplyStatus_REPLY_STATUS_WAITING,
	}
	if message.GetWorkSessionReportId() != "" {
		// The prompt instructs the parent to report on child work. It was not
		// written by the operator and must never appear as their message.
		out.Text = ""
	}
	if input := message.GetLiveInput(); input != nil {
		switch input.GetState() {
		case v2.LiveInputState_LIVE_INPUT_STATE_PENDING:
			out.WaitingReason = "Waiting to deliver your message to the running Task."
			return out
		case v2.LiveInputState_LIVE_INPUT_STATE_ACCEPTED:
			out.JoinedTaskId = input.GetTaskId()
			return out
		case v2.LiveInputState_LIVE_INPUT_STATE_DISPATCHING:
			out.WaitingReason = "Waiting for the running Task to acknowledge your message."
			return out
		case v2.LiveInputState_LIVE_INPUT_STATE_UNKNOWN:
			out.WaitingReason = "Message delivery is uncertain and needs operator recovery."
			return out
		}
	}
	out.Reply = runtimeReply(task)
	if out.Reply != nil {
		out.Status = views.ReplyStatus_REPLY_STATUS_REPLIED
	} else {
		switch task.GetState() {
		case v2.TaskState_TASK_STATE_QUEUED:
			out.WaitingReason = "Task queued."
		case v2.TaskState_TASK_STATE_UNCERTAIN:
			out.WaitingReason = "Execution is uncertain and needs operator recovery."
		}
	}
	return out
}

func runtimeReply(task *v2.Task) *views.Reply {
	text := task.GetResult()
	switch task.GetState() {
	case v2.TaskState_TASK_STATE_SUCCEEDED:
		return &views.Reply{Presentation: views.ReplyPresentation_REPLY_PRESENTATION_FINAL_RESULT, Text: text + taskFilesNotice(task)}
	case v2.TaskState_TASK_STATE_FAILED:
		if text == "" {
			text = "Task failed."
		}
	case v2.TaskState_TASK_STATE_CANCELLED:
		if text == "" {
			text = "Task cancelled."
		}
	default:
		return nil
	}
	return &views.Reply{Presentation: views.ReplyPresentation_REPLY_PRESENTATION_ERROR, Text: text}
}
