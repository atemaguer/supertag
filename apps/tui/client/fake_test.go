package client

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1/operatorv1connect"
)

// fakeControlPlane serves the generated ConversationService and EventService handlers, each
// RPC answered by the test's function, and records every call's headers.
type fakeControlPlane struct {
	operatorv1connect.UnimplementedConversationServiceHandler
	operatorv1connect.UnimplementedEventServiceHandler

	send          func(*operatorv1.SendMessageRequest) (*operatorv1.Message, error)
	list          func(*operatorv1.ListMessagesRequest) (*operatorv1.ListMessagesResponse, error)
	conversations func(*operatorv1.ListConversationsRequest) (*operatorv1.ListConversationsResponse, error)
	follow        func(context.Context, *operatorv1.FollowMessageRequest, *connect.ServerStream[operatorv1.FollowEvent]) error
	watch         func(context.Context, *operatorv1.WatchRequest, *connect.ServerStream[operatorv1.WatchEvent]) error
	tags          http.HandlerFunc

	mu    sync.Mutex
	calls []call
}

type call struct {
	procedure, authorization, version, contentType string
	protoMajor                                     int
}

func (f *fakeControlPlane) callsTo(procedure string) []call {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []call
	for _, c := range f.calls {
		if c.procedure == procedure {
			out = append(out, c)
		}
	}
	return out
}

func (f *fakeControlPlane) handler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle(operatorv1connect.NewConversationServiceHandler(f))
	mux.Handle(operatorv1connect.NewEventServiceHandler(f))
	mux.HandleFunc("/api/v1/tags", func(w http.ResponseWriter, r *http.Request) {
		if f.tags == nil {
			http.NotFound(w, r)
			return
		}
		f.tags(w, r)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.calls = append(f.calls, call{
			procedure: r.URL.Path, authorization: r.Header.Get("Authorization"),
			version: r.Header.Get(clientVersionHeader), contentType: r.Header.Get("Content-Type"), protoMajor: r.ProtoMajor,
		})
		f.mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer secret" {
			http.Error(w, `{"code":"unauthenticated","message":"The operator token is not valid."}`, http.StatusUnauthorized)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (f *fakeControlPlane) SendMessage(_ context.Context, req *connect.Request[operatorv1.SendMessageRequest]) (*connect.Response[operatorv1.Message], error) {
	message, err := f.send(req.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(message), nil
}

func (f *fakeControlPlane) ListMessages(_ context.Context, req *connect.Request[operatorv1.ListMessagesRequest]) (*connect.Response[operatorv1.ListMessagesResponse], error) {
	res, err := f.list(req.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(res), nil
}

func (f *fakeControlPlane) ListConversations(_ context.Context, req *connect.Request[operatorv1.ListConversationsRequest]) (*connect.Response[operatorv1.ListConversationsResponse], error) {
	res, err := f.conversations(req.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(res), nil
}

func (f *fakeControlPlane) FollowMessage(ctx context.Context, req *connect.Request[operatorv1.FollowMessageRequest], stream *connect.ServerStream[operatorv1.FollowEvent]) error {
	return f.follow(ctx, req.Msg, stream)
}

func (f *fakeControlPlane) Watch(ctx context.Context, req *connect.Request[operatorv1.WatchRequest], stream *connect.ServerStream[operatorv1.WatchEvent]) error {
	return f.watch(ctx, req.Msg, stream)
}

func newFake(t *testing.T, f *fakeControlPlane) *Client {
	t.Helper()
	sendRetryPause = time.Millisecond
	server := httptest.NewServer(f.handler())
	t.Cleanup(server.Close)
	c, err := New(Target{URL: server.URL + "/some/path", Token: "secret", Name: "local"}, "0.0.0-test")
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// sendAll sends events in order, stopping at the first failure.
func sendAll(stream *connect.ServerStream[operatorv1.FollowEvent], events ...*operatorv1.FollowEvent) error {
	for _, event := range events {
		if err := stream.Send(event); err != nil {
			return err
		}
	}
	return nil
}

func seq(n int64, event *operatorv1.FollowEvent) *operatorv1.FollowEvent {
	event.Sequence = n
	return event
}

func waitingPart(reason string) *operatorv1.FollowEvent {
	return &operatorv1.FollowEvent{Part: &operatorv1.FollowEvent_Waiting{Waiting: &operatorv1.PlacementWait{Reason: reason}}}
}

func deltaPart(text string) *operatorv1.FollowEvent {
	return &operatorv1.FollowEvent{Part: &operatorv1.FollowEvent_TextDelta{TextDelta: &operatorv1.TextDelta{Text: text}}}
}

func commandPart(workSession, command string, status operatorv1.ActivityStatus) *operatorv1.FollowEvent {
	return &operatorv1.FollowEvent{Part: &operatorv1.FollowEvent_Activity{Activity: &operatorv1.Activity{
		WorkSessionId: workSession,
		Detail:        &operatorv1.Activity_Command{Command: &operatorv1.CommandActivity{Id: "c", Command: command, Status: status}},
	}}}
}

func finishPart(text string, sessions ...*operatorv1.WorkSession) *operatorv1.FollowEvent {
	reply := &operatorv1.Reply{Presentation: operatorv1.ReplyPresentation_REPLY_PRESENTATION_FINAL_RESULT, Text: text}
	return &operatorv1.FollowEvent{Part: &operatorv1.FollowEvent_Finish{Finish: &operatorv1.Finish{
		Reply:   reply,
		Message: &operatorv1.Message{TaskId: "t1", Status: operatorv1.ReplyStatus_REPLY_STATUS_REPLIED, Reply: reply, WorkSessions: sessions},
	}}}
}

func changedPart(session *operatorv1.WorkSession) *operatorv1.FollowEvent {
	return &operatorv1.FollowEvent{Part: &operatorv1.FollowEvent_WorkSessionChanged{WorkSessionChanged: &operatorv1.WorkSessionChanged{WorkSession: session}}}
}

func endPart(sessions ...*operatorv1.WorkSession) *operatorv1.FollowEvent {
	return &operatorv1.FollowEvent{Part: &operatorv1.FollowEvent_End{End: &operatorv1.FollowEnd{
		Message: &operatorv1.Message{TaskId: "t1", Status: operatorv1.ReplyStatus_REPLY_STATUS_REPLIED, WorkSessions: sessions},
	}}}
}

func heartbeatPart() *operatorv1.FollowEvent {
	return &operatorv1.FollowEvent{Part: &operatorv1.FollowEvent_Heartbeat{Heartbeat: &operatorv1.Heartbeat{}}}
}

func running(id, title, task string) *operatorv1.WorkSession {
	return &operatorv1.WorkSession{Id: id, Title: title, TaskId: task,
		Status: operatorv1.WorkSessionStatus_WORK_SESSION_STATUS_RUNNING, ReportStatus: operatorv1.ReplyStatus_REPLY_STATUS_WAITING}
}

func reported(id, title, task, report string) *operatorv1.WorkSession {
	return &operatorv1.WorkSession{Id: id, Title: title, TaskId: task,
		Status: operatorv1.WorkSessionStatus_WORK_SESSION_STATUS_COMPLETED, ReportStatus: operatorv1.ReplyStatus_REPLY_STATUS_REPLIED,
		ReportTaskId: "r-" + task, Report: &operatorv1.Reply{Presentation: operatorv1.ReplyPresentation_REPLY_PRESENTATION_FINAL_RESULT, Text: report}}
}
