package client

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"connectrpc.com/connect"
	"golang.org/x/sync/errgroup"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/atemaguer/supertag/apps/tui/views"
	v2 "github.com/atemaguer/supertag/sdks/go/runtimev2"
	"github.com/atemaguer/supertag/sdks/go/runtimev2/runtimev2connect"
)

// runtimeClient projects runtime v2 replies into the Go UI's existing presentation types.
// Every call on this client uses the Gateway's generated gRPC client.
type runtimeClient struct {
	operator      runtimev2connect.OperatorClient
	conversations runtimev2connect.ConversationsClient
	objectives    runtimev2connect.ObjectivesClient
	overviews     runtimev2connect.ObjectiveOverviewsClient
	teams         runtimev2connect.TeamsClient
	events        runtimev2connect.OperatorEventsClient
	inbox         runtimev2connect.InboxClient
	workSessions  runtimev2connect.WorkSessionsClient
	artifacts     runtimev2connect.ArtifactCatalogClient
	enrollments   runtimev2connect.EnrollmentsClient
	memories      runtimev2connect.MemoriesClient
	networkLogs   runtimev2connect.NetworkLogsClient
	schedules     runtimev2connect.SchedulesClient
	streams       conversationStreams
}

// New connects to the public Gateway over binary gRPC and HTTP/2, natively for an
// `https://` or loopback `http://` URL, or through a WebSocket tunnel for a `wss://` or loopback
// `ws://` URL. The first call negotiates the SuperTag protocol version, which every call then
// names.
func New(target Target, version string) (*Client, error) {
	base, err := url.Parse(strings.TrimSpace(target.URL))
	tunnel := err == nil && (base.Scheme == "ws" || base.Scheme == "wss")
	if err != nil || base.Hostname() == "" || base.User != nil ||
		(!tunnel && base.Path != "" && base.Path != "/") || base.RawQuery != "" ||
		base.ForceQuery || base.Fragment != "" {
		return nil, errors.New("invalid Gateway URL")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Protocols = new(http.Protocols)
	origin := base.Scheme + "://" + base.Host
	switch base.Scheme {
	case "http", "ws":
		ip := net.ParseIP(base.Hostname())
		if ip == nil || !ip.IsLoopback() {
			return nil, errors.New("cleartext Gateway URL must use a loopback IP address")
		}
		if target.ServerCAFile != "" || target.ClientCertFile != "" || target.ClientKeyFile != "" {
			return nil, errors.New("Gateway TLS settings require an HTTPS or WSS URL")
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
		return nil, errors.New("Gateway URL must use http, https, ws or wss")
	}
	if tunnel {
		// The tunnel runs the same TLS, from runtimeTLS, inside the WebSocket. A `wss://` URL
		// never falls back to cleartext.
		dialer := tunnelDialer{url: base}
		if base.Scheme == "wss" {
			var serverCA []byte
			if target.ServerCAFile != "" {
				if serverCA, err = os.ReadFile(target.ServerCAFile); err != nil {
					return nil, fmt.Errorf("read Gateway certificate authority: %w", err)
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
		return nil, errors.New("Gateway credential required")
	}
	httpClient := &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("the Gateway redirected; requests must stay on the configured origin")
		},
	}
	c := &Client{target: target, origin: origin, version: version, http: httpClient}
	session := &protocolSession{
		client: runtimev2connect.NewProtocolNegotiationClient(httpClient, origin,
			connect.WithGRPC(), connect.WithReadMaxBytes(4096), connect.WithSendMaxBytes(4096)),
		build:    version,
		endpoint: target.URL,
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
		overviews:     runtimev2connect.NewObjectiveOverviewsClient(httpClient, origin, options...),
		teams:         runtimev2connect.NewTeamsClient(httpClient, origin, options...),
		events:        runtimev2connect.NewOperatorEventsClient(httpClient, origin, options...),
		inbox:         runtimev2connect.NewInboxClient(httpClient, origin, options...),
		workSessions:  runtimev2connect.NewWorkSessionsClient(httpClient, origin, options...),
		artifacts:     runtimev2connect.NewArtifactCatalogClient(httpClient, origin, options...),
		enrollments:   runtimev2connect.NewEnrollmentsClient(httpClient, origin, options...),
		memories:      runtimev2connect.NewMemoriesClient(httpClient, origin, options...),
		networkLogs:   runtimev2connect.NewNetworkLogsClient(httpClient, origin, options...),
		schedules:     runtimev2connect.NewSchedulesClient(httpClient, origin, options...),
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
				Spec: &views.TagSpec{Lead: tag.GetLead(), MaxWorkSessions: tag.GetMaxWorkSessions(),
					OpenWorkSessions: tag.GetOpenWorkSessions()},
				Status: &views.TagStatus{Phase: views.TagPhase_TAG_PHASE_ACTIVE},
			})
		}
		cursor = res.Msg.GetNextCursor()
		if cursor == "" {
			break
		}
	}
	// The lead Tag, the one `supertag init` creates, comes first.
	sort.SliceStable(tags, func(i, j int) bool {
		return tags[i].GetSpec().GetLead() && !tags[j].GetSpec().GetLead()
	})
	return tags, nil
}

func (c *runtimeClient) sendMessage(ctx context.Context, tag, text, operationID string) (*views.Message, error) {
	body := &v2.SendMessageRequest{TagId: tag, Text: text, OperationId: operationID}
	return retrying(ctx, func(ctx context.Context) (*views.Message, error) {
		res, err := c.conversations.SendMessage(ctx, connect.NewRequest(body))
		if err != nil {
			return nil, err
		}
		if res.Msg.GetTask().GetTaskId() == "" || res.Msg.GetTask().GetTagId() != tag {
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

// How many messages of a history page read their Work Sessions at once: a whole page, so a page
// takes one round trip for them.
const projectConcurrency = 50

func (c *runtimeClient) listMessages(ctx context.Context, tag string, query MessageQuery) (MessagePage, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	request := &v2.ListMessagesRequest{TagId: tag, Limit: uint32(max(query.Limit, 0)), Cursor: query.Cursor}
	if query.After > 0 && query.ConversationID != "" {
		request.After, request.ConversationId = query.After, query.ConversationID
		request.RefreshTaskIds = query.Refresh[max(len(query.Refresh)-maxRefresh, 0):]
	}
	res, err := c.conversations.ListMessages(ctx, connect.NewRequest(request))
	if err != nil {
		return MessagePage{}, apiError(err)
	}
	messages := res.Msg.GetMessages()
	for _, message := range messages {
		if message.GetTask().GetTagId() != tag || message.GetTask().GetTaskId() == "" {
			return MessagePage{}, &APIError{Code: connect.CodeDataLoss, Message: "Gateway returned a different conversation message."}
		}
	}
	// Each message reads its own Work Sessions. Read them together, so a page takes about one
	// round trip to the Gateway rather than one per message.
	items := make([]*views.Message, len(messages))
	group, groupCtx := errgroup.WithContext(ctx)
	group.SetLimit(projectConcurrency)
	for i, message := range messages {
		group.Go(func() error {
			item, err := c.projectMessage(groupCtx, message)
			items[i] = item
			return err
		})
	}
	if err := group.Wait(); err != nil {
		return MessagePage{}, err
	}
	return MessagePage{Messages: items, NextCursor: res.Msg.GetNextCursor(), ConversationID: res.Msg.GetConversationId(),
		Incremental: res.Msg.GetIncremental()}, nil
}

// maxRefresh is the most unfinished turns one ListMessages call refreshes.
const maxRefresh = 128

func (c *runtimeClient) listConversations(ctx context.Context) ([]*views.Conversation, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	res, err := c.conversations.ListConversations(ctx, connect.NewRequest(&v2.ListConversationsRequest{}))
	if err != nil {
		return nil, apiError(err)
	}
	listed := res.Msg.GetConversations()
	conversations := make([]*views.Conversation, 0, len(listed))
	for _, conv := range listed {
		if conv.GetTagId() == "" {
			return nil, &APIError{Code: connect.CodeDataLoss, Message: "Gateway returned a conversation without its Tag."}
		}
		conversations = append(conversations, &views.Conversation{
			Tag: conv.GetTagId(), Preview: conv.GetPreview(), PreviewFromTag: conv.GetPreviewFromTag(),
			UnreadCount: int32(min(conv.GetUnreadCount(), math.MaxInt32)), ReadOrder: conv.GetReadOrder(),
			Working: conv.GetWorking(), LatestWorkSessionReportId: conv.GetLatestWorkSessionReportId(),
			LastActivityAtMs: conv.GetLastActivityAtMs(), LatestOrder: conv.GetLatestOrder(),
			Asking: conv.GetAsking(),
		})
	}
	return conversations, nil
}

// markConversationRead records that the caller read its conversation with tag up to order.
func (c *runtimeClient) markConversationRead(ctx context.Context, tag string, order uint64) error {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	_, err := c.conversations.MarkConversationRead(ctx, connect.NewRequest(&v2.MarkConversationReadRequest{TagId: tag, Order: order}))
	return apiError(err)
}

func runtimeMessage(message *v2.ConversationMessage) *views.Message {
	if message == nil {
		return nil
	}
	task := message.GetTask()
	out := &views.Message{
		TaskId: task.GetTaskId(), Tag: task.GetTagId(), SessionId: task.GetSessionId(), Order: message.GetOrder(), Text: task.GetPrompt(), Status: views.ReplyStatus_REPLY_STATUS_WAITING,
		Started: task.GetState() != v2.TaskState_TASK_STATE_QUEUED && task.GetState() != v2.TaskState_TASK_STATE_UNSPECIFIED,
	}
	if at := message.GetSentAtMs(); at > 0 {
		out.CreatedAt = timestamppb.New(time.UnixMilli(at))
	}
	if message.CompletedAtMs != nil {
		out.CompletedAt = timestamppb.New(time.UnixMilli(message.GetCompletedAtMs()))
	}
	// A Schedule's turn has no message from you either; the Gateway leaves out its prompt.
	out.ScheduleId = message.GetScheduleId()
	out.Quiet = task.GetQuiet()
	if message.GetWorkSessionReportId() != "" {
		// The prompt instructs the parent to report on child work. It was not
		// written by the operator and must never appear as their message. The report shows
		// through its Work Session, not as messages of this turn.
		out.Text = ""
	} else {
		turnEvents(out, message.GetEvents())
	}
	if input := message.GetLiveInput(); input != nil {
		switch input.GetState() {
		case v2.LiveInputState_LIVE_INPUT_STATE_PENDING, v2.LiveInputState_LIVE_INPUT_STATE_DISPATCHING,
			v2.LiveInputState_LIVE_INPUT_STATE_ACCEPTED, v2.LiveInputState_LIVE_INPUT_STATE_UNKNOWN:
			out.Answering = input.GetTaskId()
		}
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
	out.Delivery = delivery(task)
	if out.Reply != nil {
		out.Status = views.ReplyStatus_REPLY_STATUS_REPLIED
		out.Activity = ""
		out.Finalizing = task.GetState() == v2.TaskState_TASK_STATE_RUNNING
	} else if task.GetState() == v2.TaskState_TASK_STATE_UNCERTAIN {
		out.WaitingReason = "Execution is uncertain and needs operator recovery."
	}
	return out
}

// turnEvents adds what a turn's carried events show to its message: each message the Tag wrote,
// and what it is doing now from the latest activity or plan event after its last message.
func turnEvents(out *views.Message, events []*v2.TaskEvent) {
	for _, event := range events {
		out.LastSequence = max(out.LastSequence, event.GetSequence())
		switch event.GetKind() {
		case v2.TaskEventKind_TASK_EVENT_KIND_MESSAGE:
			if text := strings.TrimSpace(event.GetText()); text != "" {
				out.TagMessages = append(out.TagMessages, &views.TagMessage{Sequence: event.GetSequence(), Text: text})
				out.Activity = ""
			}
		case v2.TaskEventKind_TASK_EVENT_KIND_ACTIVITY, v2.TaskEventKind_TASK_EVENT_KIND_PROGRESS:
			if line := eventLine(event); line != "" {
				out.Activity = line
			}
		}
	}
}

func runtimeReply(task *v2.Task) *views.Reply {
	text := task.GetResult()
	switch task.GetState() {
	case v2.TaskState_TASK_STATE_SUCCEEDED:
		return &views.Reply{Presentation: views.ReplyPresentation_REPLY_PRESENTATION_FINAL_RESULT, Text: text}
	case v2.TaskState_TASK_STATE_RUNNING:
		// The reply shows as soon as the harness finishes, while the Worker Host still delivers
		// the turn's changes.
		if text == "" {
			return nil
		}
		return &views.Reply{Presentation: views.ReplyPresentation_REPLY_PRESENTATION_FINAL_RESULT, Text: text}
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

// SessionBranch is the branch a Session's changes land on, as the Control Plane and Worker Host
// name it: `supertag/session/` and the SHA-256 of the JSON pair [tag, session].
func SessionBranch(tag, session string) string {
	var pair bytes.Buffer
	encoder := json.NewEncoder(&pair)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode([]string{tag, session}); err != nil {
		return ""
	}
	sum := sha256.Sum256(bytes.TrimSuffix(pair.Bytes(), []byte("\n")))
	return "supertag/session/" + hex.EncodeToString(sum[:])
}

// delivery is where a finished turn's changes went, when it changed anything.
func delivery(task *v2.Task) *views.Delivery {
	delivered := task.GetWorkspaceDelivery()
	if task.GetState() != v2.TaskState_TASK_STATE_SUCCEEDED || delivered == nil ||
		delivered.GetHeadCommit() == "" || delivered.GetHeadCommit() == delivered.GetBaseCommit() {
		return nil
	}
	branch := SessionBranch(task.GetTagId(), task.GetSessionId())
	if branch == "" {
		return nil
	}
	return &views.Delivery{Branch: branch, Head: delivered.GetHeadCommit(), Workspace: task.GetWorkspace().GetWorkspaceId(),
		Remote: task.GetWorkspace().GetRemote() != nil}
}
