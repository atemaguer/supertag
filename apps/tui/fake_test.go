package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1/operatorv1connect"
)

// fakeControlPlane serves GET /api/v1/tags and the generated ConversationService and
// EventService handlers. Unset functions answer with an empty history, no conversations, and a
// watch stream that only stays open.
type fakeControlPlane struct {
	operatorv1connect.UnimplementedConversationServiceHandler
	operatorv1connect.UnimplementedEventServiceHandler

	token   string
	tags    func(http.ResponseWriter)
	history func(*operatorv1.ListMessagesRequest) []*operatorv1.Message
	open    func() []*operatorv1.Conversation
	send    func(*operatorv1.SendMessageRequest) *operatorv1.Message
	follow  func(context.Context, *operatorv1.FollowMessageRequest, *connect.ServerStream[operatorv1.FollowEvent]) error
	watch   func(context.Context, *operatorv1.WatchRequest, *connect.ServerStream[operatorv1.WatchEvent]) error

	mu       sync.Mutex
	badAuth  int
	tagReads int
	sent     []*operatorv1.SendMessageRequest
	followed map[string]int
	resumed  map[string][]int64
}

func (f *fakeControlPlane) start(t *testing.T) *httptest.Server {
	t.Helper()
	if f.token == "" {
		f.token = "secret"
	}
	f.followed, f.resumed = map[string]int{}, map[string][]int64{}
	mux := http.NewServeMux()
	mux.Handle(operatorv1connect.NewConversationServiceHandler(f))
	mux.Handle(operatorv1connect.NewEventServiceHandler(f))
	mux.HandleFunc("GET /api/v1/tags", func(w http.ResponseWriter, _ *http.Request) {
		f.mu.Lock()
		f.tagReads++
		f.mu.Unlock()
		f.tags(w)
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+f.token {
			f.mu.Lock()
			f.badAuth++
			f.mu.Unlock()
			writeJSON(w, http.StatusUnauthorized, map[string]string{"code": "unauthenticated", "message": "The operator token is not valid."})
			return
		}
		mux.ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	return server
}

func (f *fakeControlPlane) reads() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.tagReads
}

func (f *fakeControlPlane) SendMessage(_ context.Context, req *connect.Request[operatorv1.SendMessageRequest]) (*connect.Response[operatorv1.Message], error) {
	f.mu.Lock()
	f.sent = append(f.sent, req.Msg)
	f.mu.Unlock()
	return connect.NewResponse(f.send(req.Msg)), nil
}

func (f *fakeControlPlane) ListMessages(_ context.Context, req *connect.Request[operatorv1.ListMessagesRequest]) (*connect.Response[operatorv1.ListMessagesResponse], error) {
	res := &operatorv1.ListMessagesResponse{}
	if f.history != nil {
		res.Messages = f.history(req.Msg)
	}
	return connect.NewResponse(res), nil
}

func (f *fakeControlPlane) ListConversations(context.Context, *connect.Request[operatorv1.ListConversationsRequest]) (*connect.Response[operatorv1.ListConversationsResponse], error) {
	res := &operatorv1.ListConversationsResponse{}
	if f.open != nil {
		res.Conversations = f.open()
	}
	return connect.NewResponse(res), nil
}

func (f *fakeControlPlane) FollowMessage(ctx context.Context, req *connect.Request[operatorv1.FollowMessageRequest], stream *connect.ServerStream[operatorv1.FollowEvent]) error {
	f.mu.Lock()
	f.followed[req.Msg.GetTaskId()]++
	f.resumed[req.Msg.GetTaskId()] = append(f.resumed[req.Msg.GetTaskId()], req.Msg.GetAfterSequence())
	f.mu.Unlock()
	return f.follow(ctx, req.Msg, stream)
}

func (f *fakeControlPlane) Watch(ctx context.Context, req *connect.Request[operatorv1.WatchRequest], stream *connect.ServerStream[operatorv1.WatchEvent]) error {
	if f.watch != nil {
		return f.watch(ctx, req.Msg, stream)
	}
	<-ctx.Done()
	return ctx.Err()
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func tagList(w http.ResponseWriter, names ...string) {
	items := make([]any, 0, len(names))
	for _, name := range names {
		items = append(items, map[string]any{
			"apiVersion": "supertag.dev/v1", "kind": "Tag",
			"metadata": map[string]string{"name": name},
			"spec":     map[string]any{"roles": []string{}, "workerHosts": []string{}},
			"status":   map[string]any{"phase": "active", "locations": []any{}},
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"apiVersion": "supertag.dev/v1", "kind": "ResourceList",
		"metadata": map[string]string{"resourceVersion": "1"}, "items": items,
	})
}

func finalReply(text string) *operatorv1.Reply {
	return &operatorv1.Reply{Presentation: operatorv1.ReplyPresentation_REPLY_PRESENTATION_FINAL_RESULT, Text: text}
}

func waitingMessage(task, text string) *operatorv1.Message {
	return &operatorv1.Message{TaskId: task, Tag: "lead", Conversation: "default", SessionId: "ses-default", Text: text,
		Status: operatorv1.ReplyStatus_REPLY_STATUS_WAITING}
}

func workSession(id, title, task string, report string) *operatorv1.WorkSession {
	session := &operatorv1.WorkSession{Id: id, Title: title, TaskId: task,
		Status: operatorv1.WorkSessionStatus_WORK_SESSION_STATUS_RUNNING, ReportStatus: operatorv1.ReplyStatus_REPLY_STATUS_WAITING}
	if report != "" {
		session.Status = operatorv1.WorkSessionStatus_WORK_SESSION_STATUS_COMPLETED
		session.ReportStatus = operatorv1.ReplyStatus_REPLY_STATUS_REPLIED
		session.ReportTaskId = "report-" + task
		session.Report = finalReply(report)
	}
	return session
}

func followEvent(sequence int64, part any) *operatorv1.FollowEvent {
	event := &operatorv1.FollowEvent{Sequence: sequence}
	switch p := part.(type) {
	case *operatorv1.TextDelta:
		event.Part = &operatorv1.FollowEvent_TextDelta{TextDelta: p}
	case *operatorv1.Activity:
		event.Part = &operatorv1.FollowEvent_Activity{Activity: p}
	case *operatorv1.Finish:
		event.Part = &operatorv1.FollowEvent_Finish{Finish: p}
	case *operatorv1.WorkSessionChanged:
		event.Part = &operatorv1.FollowEvent_WorkSessionChanged{WorkSessionChanged: p}
	case *operatorv1.FollowEnd:
		event.Part = &operatorv1.FollowEvent_End{End: p}
	case *operatorv1.Heartbeat:
		event.Part = &operatorv1.FollowEvent_Heartbeat{Heartbeat: p}
	default:
		panic("unknown follow part")
	}
	return event
}

func command(workSession, line string) *operatorv1.Activity {
	return &operatorv1.Activity{WorkSessionId: workSession, Text: "running: " + line,
		Detail: &operatorv1.Activity_Command{Command: &operatorv1.CommandActivity{Id: "c1", Command: line, Status: operatorv1.ActivityStatus_ACTIVITY_STATUS_RUNNING}}}
}

func tool(workSession, name string) *operatorv1.Activity {
	return &operatorv1.Activity{WorkSessionId: workSession, Text: "using: " + name,
		Detail: &operatorv1.Activity_Tool{Tool: &operatorv1.ToolActivity{Id: "u1", Tool: name, Status: operatorv1.ActivityStatus_ACTIVITY_STATUS_RUNNING}}}
}
