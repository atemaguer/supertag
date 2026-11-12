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

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
	v2 "github.com/atemaguer/supertag/rust/bindings/go/runtimev2"
	"github.com/atemaguer/supertag/rust/bindings/go/runtimev2/runtimev2connect"
)

// runtimeClient projects runtime v2 replies into the Go UI's existing presentation types.
// Every call on this client uses the Gateway's generated gRPC client.
type runtimeClient struct {
	operator      runtimev2connect.OperatorClient
	conversations runtimev2connect.ConversationsClient
	objectives    runtimev2connect.ObjectivesClient
}

// NewRuntimeV2 connects to the public Gateway over binary gRPC and HTTP/2.
func NewRuntimeV2(target Target, version string) (*Client, error) {
	base, err := url.Parse(strings.TrimSpace(target.URL))
	if err != nil || base.Hostname() == "" || base.User != nil ||
		(base.Path != "" && base.Path != "/") || base.RawQuery != "" ||
		base.ForceQuery || base.Fragment != "" {
		return nil, errors.New("invalid Gateway URL")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Protocols = new(http.Protocols)
	switch base.Scheme {
	case "http":
		ip := net.ParseIP(base.Hostname())
		if ip == nil || !ip.IsLoopback() {
			return nil, errors.New("cleartext Gateway URL must use a loopback IP address")
		}
		if target.ServerCAFile != "" || target.ClientCertFile != "" || target.ClientKeyFile != "" {
			return nil, errors.New("Gateway TLS settings require an HTTPS URL")
		}
		transport.Proxy = nil
		transport.Protocols.SetUnencryptedHTTP2(true)
	case "https":
		transport.Protocols.SetHTTP2(true)
		config, err := runtimeTLS(target)
		if err != nil {
			return nil, err
		}
		transport.TLSClientConfig = config
	default:
		return nil, errors.New("Gateway URL must use http or https")
	}
	if target.Token == "" {
		return nil, errors.New("Gateway operator credential required")
	}
	httpClient := &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("the Gateway redirected; requests must stay on the configured origin")
		},
	}
	origin := base.Scheme + "://" + base.Host
	c := &Client{target: target, origin: origin, version: version, http: httpClient}
	options := []connect.ClientOption{
		connect.WithGRPC(),
		connect.WithInterceptors(headers{c}),
		connect.WithReadMaxBytes(1024 * 1024),
		connect.WithSendMaxBytes(1024 * 1024),
	}
	c.runtime = &runtimeClient{
		operator:      runtimev2connect.NewOperatorClient(httpClient, origin, options...),
		conversations: runtimev2connect.NewConversationsClient(httpClient, origin, options...),
		objectives:    runtimev2connect.NewObjectivesClient(httpClient, origin, options...),
	}
	return c, nil
}

func runtimeTLS(target Target) (*tls.Config, error) {
	config := &tls.Config{MinVersion: tls.VersionTLS12}
	if target.ServerCAFile != "" {
		certificates, err := os.ReadFile(target.ServerCAFile)
		if err != nil {
			return nil, fmt.Errorf("read Gateway certificate authority: %w", err)
		}
		roots := x509.NewCertPool()
		if !roots.AppendCertsFromPEM(certificates) {
			return nil, errors.New("Gateway certificate authority contains no PEM certificates")
		}
		config.RootCAs = roots
	}
	if (target.ClientCertFile == "") != (target.ClientKeyFile == "") {
		return nil, errors.New("configure both the Gateway client certificate and key")
	}
	if target.ClientCertFile != "" {
		certificate, err := tls.LoadX509KeyPair(target.ClientCertFile, target.ClientKeyFile)
		if err != nil {
			return nil, fmt.Errorf("read Gateway client identity: %w", err)
		}
		config.Certificates = []tls.Certificate{certificate}
	}
	return config, nil
}

func unavailable(feature string) error {
	return &APIError{Code: connect.CodeUnimplemented, Message: feature + " is unavailable on this Gateway."}
}

func (c *runtimeClient) listTags(ctx context.Context) ([]*operatorv1.Tag, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	var tags []*operatorv1.Tag
	cursor := ""
	for range maxTagPages {
		res, err := c.operator.ListTags(ctx, connect.NewRequest(&v2.ListTagsRequest{Limit: 100, Cursor: cursor}))
		if err != nil {
			return nil, apiError(err)
		}
		for _, tag := range res.Msg.GetTags() {
			tags = append(tags, &operatorv1.Tag{
				Metadata: &operatorv1.Metadata{Id: tag.GetTagId(), Name: tag.GetTagId()},
				Status:   &operatorv1.TagStatus{Phase: operatorv1.TagPhase_TAG_PHASE_ACTIVE},
			})
		}
		cursor = res.Msg.GetNextCursor()
		if cursor == "" {
			break
		}
	}
	return tags, nil
}

func (c *runtimeClient) sendMessage(ctx context.Context, tag, conversation, text string) (*operatorv1.Message, error) {
	key, err := idempotencyKey()
	if err != nil {
		return nil, err
	}
	body := &v2.SendMessageRequest{TagId: tag, Conversation: conversation, Text: text, OperationId: key}
	return retrying(ctx, func(ctx context.Context) (*operatorv1.Message, error) {
		res, err := c.conversations.SendMessage(ctx, connect.NewRequest(body))
		if err != nil {
			return nil, err
		}
		if res.Msg.GetTask().GetTaskId() == "" || res.Msg.GetTask().GetTagId() != tag || res.Msg.GetConversation() != conversation {
			return nil, &APIError{Code: connect.CodeDataLoss, Message: "Gateway returned a different conversation message."}
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
		return nil, &APIError{Code: connect.CodeDataLoss, Message: "Gateway returned a different conversation Task."}
	}
	return res.Msg, nil
}

func (c *runtimeClient) listMessages(ctx context.Context, tag, conversation string, size int32, cursor string) ([]*operatorv1.Message, string, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	res, err := c.conversations.ListMessages(ctx, connect.NewRequest(&v2.ListMessagesRequest{
		TagId: tag, Conversation: conversation, Limit: uint32(max(size, 0)), Cursor: cursor,
	}))
	if err != nil {
		return nil, "", apiError(err)
	}
	items := make([]*operatorv1.Message, 0, len(res.Msg.GetMessages()))
	for _, message := range res.Msg.GetMessages() {
		items = append(items, runtimeMessage(message))
	}
	return items, res.Msg.GetNextCursor(), nil
}

func (c *runtimeClient) listConversations(ctx context.Context, tag string) ([]*operatorv1.Conversation, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	var conversations []*operatorv1.Conversation
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
			preview, author := task.GetPrompt(), operatorv1.ConversationAuthor_CONVERSATION_AUTHOR_OPERATOR
			if task.GetState() == v2.TaskState_TASK_STATE_SUCCEEDED && task.GetAttemptId() != "" && task.GetResult() != "" {
				preview, author = task.GetResult(), operatorv1.ConversationAuthor_CONVERSATION_AUTHOR_TAG
			}
			runes := []rune(preview)
			conversations = append(conversations, &operatorv1.Conversation{
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

func runtimeMessage(message *v2.ConversationMessage) *operatorv1.Message {
	if message == nil {
		return nil
	}
	task := message.GetTask()
	out := &operatorv1.Message{
		TaskId: task.GetTaskId(), Tag: task.GetTagId(), Conversation: message.GetConversation(),
		SessionId: task.GetSessionId(), Text: task.GetPrompt(), Status: operatorv1.ReplyStatus_REPLY_STATUS_WAITING,
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
		out.Status = operatorv1.ReplyStatus_REPLY_STATUS_REPLIED
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

func runtimeReply(task *v2.Task) *operatorv1.Reply {
	text := task.GetResult()
	switch task.GetState() {
	case v2.TaskState_TASK_STATE_SUCCEEDED:
		return &operatorv1.Reply{Presentation: operatorv1.ReplyPresentation_REPLY_PRESENTATION_FINAL_RESULT, Text: text}
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
	return &operatorv1.Reply{Presentation: operatorv1.ReplyPresentation_REPLY_PRESENTATION_ERROR, Text: text}
}
