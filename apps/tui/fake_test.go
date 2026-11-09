package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1/operatorv1connect"
)

// fakeControlPlane serves GET /api/v1/tags and the generated ConversationService,
// ObjectiveService, InboxService and EventService handlers. Unset functions answer with an empty
// history, no conversations, no Objectives, an empty inbox, and a watch stream that only stays
// open.
type fakeControlPlane struct {
	operatorv1connect.UnimplementedConversationServiceHandler
	operatorv1connect.UnimplementedObjectiveServiceHandler
	operatorv1connect.UnimplementedInboxServiceHandler
	operatorv1connect.UnimplementedEventServiceHandler

	token   string
	tags    func(http.ResponseWriter)
	history func(*operatorv1.ListMessagesRequest) []*operatorv1.Message
	open    func() []*operatorv1.Conversation
	send    func(*operatorv1.SendMessageRequest) *operatorv1.Message
	follow  func(context.Context, *operatorv1.FollowMessageRequest, *connect.ServerStream[operatorv1.FollowEvent]) error
	watch   func(context.Context, *operatorv1.WatchRequest, *connect.ServerStream[operatorv1.WatchEvent]) error
	// objectives, overview and items answer ListObjectives, DescribeObjective and ListInboxItems;
	// approve, deny and answer answer the decisions, nil meaning success.
	objectives func() []*operatorv1.Objective
	overview   func(id string) *operatorv1.ObjectiveOverview
	items      func() []*operatorv1.InboxItem
	approve    func(*operatorv1.ApproveRequest) error
	deny       func(*operatorv1.DenyRequest) error
	answer     func(*operatorv1.AnswerQuestionRequest) error

	mu        sync.Mutex
	badAuth   int
	tagReads  int
	sent      []*operatorv1.SendMessageRequest
	followed  map[string]int
	resumed   map[string][]int64
	described map[string]int
	approved  []*operatorv1.ApproveRequest
	denied    []*operatorv1.DenyRequest
	answered  []*operatorv1.AnswerQuestionRequest
}

func (f *fakeControlPlane) start(t *testing.T) *httptest.Server {
	t.Helper()
	if f.token == "" {
		f.token = "secret"
	}
	f.followed, f.resumed, f.described = map[string]int{}, map[string][]int64{}, map[string]int{}
	mux := http.NewServeMux()
	mux.Handle(operatorv1connect.NewConversationServiceHandler(f))
	mux.Handle(operatorv1connect.NewObjectiveServiceHandler(f))
	mux.Handle(operatorv1connect.NewInboxServiceHandler(f))
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

func (f *fakeControlPlane) ListObjectives(context.Context, *connect.Request[operatorv1.ListObjectivesRequest]) (*connect.Response[operatorv1.ListObjectivesResponse], error) {
	res := &operatorv1.ListObjectivesResponse{}
	if f.objectives != nil {
		res.Objectives = f.objectives()
	}
	return connect.NewResponse(res), nil
}

func (f *fakeControlPlane) DescribeObjective(_ context.Context, req *connect.Request[operatorv1.DescribeObjectiveRequest]) (*connect.Response[operatorv1.ObjectiveOverview], error) {
	f.mu.Lock()
	f.described[req.Msg.GetId()]++
	f.mu.Unlock()
	var overview *operatorv1.ObjectiveOverview
	if f.overview != nil {
		overview = f.overview(req.Msg.GetId())
	}
	if overview == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("Objective "+req.Msg.GetId()+" was not found"))
	}
	return connect.NewResponse(overview), nil
}

func (f *fakeControlPlane) descriptions(id string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.described[id]
}

func (f *fakeControlPlane) ListInboxItems(context.Context, *connect.Request[operatorv1.ListInboxItemsRequest]) (*connect.Response[operatorv1.ListInboxItemsResponse], error) {
	res := &operatorv1.ListInboxItemsResponse{TagNames: map[string]string{"tag-lead": "lead"}}
	if f.items != nil {
		res.Items = f.items()
	}
	return connect.NewResponse(res), nil
}

func (f *fakeControlPlane) Approve(_ context.Context, req *connect.Request[operatorv1.ApproveRequest]) (*connect.Response[operatorv1.Approval], error) {
	f.mu.Lock()
	f.approved = append(f.approved, req.Msg)
	f.mu.Unlock()
	if f.approve != nil {
		if err := f.approve(req.Msg); err != nil {
			return nil, err
		}
	}
	return connect.NewResponse(&operatorv1.Approval{Id: req.Msg.GetId(), Status: operatorv1.ApprovalStatus_APPROVAL_STATUS_APPROVED}), nil
}

func (f *fakeControlPlane) Deny(_ context.Context, req *connect.Request[operatorv1.DenyRequest]) (*connect.Response[operatorv1.Approval], error) {
	f.mu.Lock()
	f.denied = append(f.denied, req.Msg)
	f.mu.Unlock()
	if f.deny != nil {
		if err := f.deny(req.Msg); err != nil {
			return nil, err
		}
	}
	return connect.NewResponse(&operatorv1.Approval{Id: req.Msg.GetId(), Status: operatorv1.ApprovalStatus_APPROVAL_STATUS_DENIED}), nil
}

func (f *fakeControlPlane) AnswerQuestion(_ context.Context, req *connect.Request[operatorv1.AnswerQuestionRequest]) (*connect.Response[operatorv1.MessageObjectiveResponse], error) {
	f.mu.Lock()
	f.answered = append(f.answered, req.Msg)
	f.mu.Unlock()
	if f.answer != nil {
		if err := f.answer(req.Msg); err != nil {
			return nil, err
		}
	}
	return connect.NewResponse(&operatorv1.MessageObjectiveResponse{TaskId: "task-answer", Tag: "lead"}), nil
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

func objective(id, outcome string, status operatorv1.ObjectiveStatus) *operatorv1.Objective {
	return &operatorv1.Objective{Id: id, Outcome: outcome, OwnerTagId: "tag-lead", OwnerTag: "lead", Status: status, Revision: 3}
}

func budgeted(o *operatorv1.Objective, spent, limit int64) *operatorv1.Objective {
	o.Budget = &operatorv1.Budget{LimitMinor: limit, Currency: "USD"}
	o.Spend = &operatorv1.ObjectiveSpend{AmountMinor: spent, Currency: "USD"}
	return o
}

func questionItem(objective, task, text string) *operatorv1.InboxItem {
	return &operatorv1.InboxItem{Key: "question:" + task, Occurrence: "question:" + task + ":1", ObjectiveId: objective,
		Kind: operatorv1.InboxItemKind_INBOX_ITEM_KIND_QUESTION, OperatorEligible: true, Reason: "The owner asked a question.",
		Question: &operatorv1.InboxQuestion{Text: text}, Commands: []string{"supertag message objective " + objective + " TEXT"}}
}

func approvalItem(objective, id, summary string) *operatorv1.InboxItem {
	return &operatorv1.InboxItem{Key: "approval:" + id, Occurrence: "approval:" + id + ":1", ObjectiveId: objective,
		Kind: operatorv1.InboxItemKind_INBOX_ITEM_KIND_APPROVAL, OperatorEligible: true, Reason: "An approval request waits.",
		Approval: &operatorv1.InboxApproval{RequestId: id, Summary: summary, RequestingTag: "builder", TaskId: "task-push", Blocking: true},
		Commands: []string{"supertag approve request " + id, "supertag deny request " + id + " --reason TEXT"}}
}
