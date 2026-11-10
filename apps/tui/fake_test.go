package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/structpb"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1/operatorv1connect"
)

// fakeControlPlane serves the generated ResourceService, ConversationService, ObjectiveService,
// InboxService, WorkService, TeamService, MailboxService, HostService and EventService handlers.
// Unset functions answer with no Tags, an empty history, no conversations, no Objectives, an empty inbox, no Sessions, no Task events, no Teams, no Worker Hosts, and a watch
// stream that only stays open.
type fakeControlPlane struct {
	operatorv1connect.UnimplementedConversationServiceHandler
	operatorv1connect.UnimplementedObjectiveServiceHandler
	operatorv1connect.UnimplementedInboxServiceHandler
	operatorv1connect.UnimplementedEventServiceHandler
	operatorv1connect.UnimplementedWorkServiceHandler
	operatorv1connect.UnimplementedTeamServiceHandler
	operatorv1connect.UnimplementedMailboxServiceHandler
	operatorv1connect.UnimplementedHostServiceHandler
	operatorv1connect.UnimplementedResourceServiceHandler

	token string
	// tags answers ListResources for Tags; an error refuses it.
	tags       func() ([]*operatorv1.Tag, error)
	history    func(*operatorv1.ListMessagesRequest) []*operatorv1.Message
	open       func() []*operatorv1.Conversation
	send       func(*operatorv1.SendMessageRequest) *operatorv1.Message
	getMessage func(*operatorv1.GetMessageRequest) (*operatorv1.Message, error)
	follow     func(context.Context, *operatorv1.FollowMessageRequest, *connect.ServerStream[operatorv1.FollowEvent]) error
	watch      func(context.Context, *operatorv1.WatchRequest, *connect.ServerStream[operatorv1.WatchEvent]) error
	// objectives, overview and items answer ListObjectives, DescribeObjective and ListInboxItems;
	// approve, deny and answer answer the decisions, nil meaning success.
	objectives func() []*operatorv1.Objective
	overview   func(id string) *operatorv1.ObjectiveOverview
	items      func() []*operatorv1.InboxItem
	approve    func(*operatorv1.ApproveRequest) error
	deny       func(*operatorv1.DenyRequest) error
	answer     func(*operatorv1.AnswerQuestionRequest) error
	// create answers CreateObjective, nil meaning it creates the Objective `obj-new`.
	create           func(*operatorv1.CreateObjectiveRequest) (*operatorv1.CreateObjectiveResponse, error)
	messageObjective func(*operatorv1.MessageObjectiveRequest) (*operatorv1.MessageObjectiveResponse, error)
	// sessions answers GetSession, nil meaning NotFound; taskEvents answers ListTaskEvents;
	// teamList answers ListTeams and GetTeam; posts answers ListWorkstreamPosts.
	sessions   func(id string) *operatorv1.Session
	taskEvents func(*operatorv1.ListTaskEventsRequest) []*operatorv1.TaskEvent
	teamList   func() []*operatorv1.Team
	posts      func(*operatorv1.ListWorkstreamPostsRequest) *operatorv1.ListWorkstreamPostsResponse
	// hostList answers ListWorkerHosts; hostErr, when set, refuses it.
	hostList func() []*operatorv1.WorkerHost
	hostErr  error

	mu                sync.Mutex
	conversationLists []string
	sessionReads      map[string]int
	postReads         map[string]int
	badAuth           int
	tagReads          int
	hostReads         int
	sent              []*operatorv1.SendMessageRequest
	followed          map[string]int
	resumed           map[string][]int64
	described         map[string]int
	approved          []*operatorv1.ApproveRequest
	denied            []*operatorv1.DenyRequest
	answered          []*operatorv1.AnswerQuestionRequest
	created           []*operatorv1.CreateObjectiveRequest
}

func (f *fakeControlPlane) start(t *testing.T) *httptest.Server {
	t.Helper()
	if f.token == "" {
		f.token = "secret"
	}
	f.followed, f.resumed, f.described = map[string]int{}, map[string][]int64{}, map[string]int{}
	f.sessionReads, f.postReads = map[string]int{}, map[string]int{}
	mux := http.NewServeMux()
	mux.Handle(operatorv1connect.NewConversationServiceHandler(f))
	mux.Handle(operatorv1connect.NewObjectiveServiceHandler(f))
	mux.Handle(operatorv1connect.NewInboxServiceHandler(f))
	mux.Handle(operatorv1connect.NewEventServiceHandler(f))
	mux.Handle(operatorv1connect.NewWorkServiceHandler(f))
	mux.Handle(operatorv1connect.NewTeamServiceHandler(f))
	mux.Handle(operatorv1connect.NewMailboxServiceHandler(f))
	mux.Handle(operatorv1connect.NewHostServiceHandler(f))
	mux.Handle(operatorv1connect.NewResourceServiceHandler(f))
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

func (f *fakeControlPlane) ListResources(_ context.Context, req *connect.Request[operatorv1.ListResourcesRequest]) (*connect.Response[operatorv1.ListResourcesResponse], error) {
	if req.Msg.GetKind() != operatorv1.ResourceKind_RESOURCE_KIND_TAG {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("only Tags are listed here"))
	}
	f.mu.Lock()
	f.tagReads++
	f.mu.Unlock()
	res := &operatorv1.ListResourcesResponse{}
	if f.tags != nil {
		tags, err := f.tags()
		if err != nil {
			return nil, err
		}
		for _, tag := range tags {
			res.Resources = append(res.Resources, &operatorv1.Resource{Resource: &operatorv1.Resource_Tag{Tag: tag}})
		}
	}
	return connect.NewResponse(res), nil
}

func (f *fakeControlPlane) CreateObjective(_ context.Context, req *connect.Request[operatorv1.CreateObjectiveRequest]) (*connect.Response[operatorv1.CreateObjectiveResponse], error) {
	f.mu.Lock()
	f.created = append(f.created, req.Msg)
	f.mu.Unlock()
	if f.create != nil {
		res, err := f.create(req.Msg)
		if err != nil {
			return nil, err
		}
		return connect.NewResponse(res), nil
	}
	o := objective("obj-new", req.Msg.GetOutcome(), operatorv1.ObjectiveStatus_OBJECTIVE_STATUS_WORKING)
	return connect.NewResponse(&operatorv1.CreateObjectiveResponse{Objective: o, StartedTaskId: "task-new"}), nil
}

func (f *fakeControlPlane) SendMessage(_ context.Context, req *connect.Request[operatorv1.SendMessageRequest]) (*connect.Response[operatorv1.Message], error) {
	f.mu.Lock()
	f.sent = append(f.sent, req.Msg)
	f.mu.Unlock()
	return connect.NewResponse(f.send(req.Msg)), nil
}

func (f *fakeControlPlane) MessageObjective(_ context.Context, req *connect.Request[operatorv1.MessageObjectiveRequest]) (*connect.Response[operatorv1.MessageObjectiveResponse], error) {
	if f.messageObjective == nil {
		return nil, connect.NewError(connect.CodeUnimplemented, nil)
	}
	res, err := f.messageObjective(req.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(res), nil
}

func (f *fakeControlPlane) GetMessage(_ context.Context, req *connect.Request[operatorv1.GetMessageRequest]) (*connect.Response[operatorv1.Message], error) {
	if f.getMessage == nil {
		return nil, connect.NewError(connect.CodeUnimplemented, nil)
	}
	res, err := f.getMessage(req.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(res), nil
}

func (f *fakeControlPlane) ListMessages(_ context.Context, req *connect.Request[operatorv1.ListMessagesRequest]) (*connect.Response[operatorv1.ListMessagesResponse], error) {
	res := &operatorv1.ListMessagesResponse{}
	if f.history != nil {
		res.Messages = f.history(req.Msg)
	}
	return connect.NewResponse(res), nil
}

func (f *fakeControlPlane) ListConversations(_ context.Context, req *connect.Request[operatorv1.ListConversationsRequest]) (*connect.Response[operatorv1.ListConversationsResponse], error) {
	f.mu.Lock()
	f.conversationLists = append(f.conversationLists, req.Msg.GetTag())
	f.mu.Unlock()
	res := &operatorv1.ListConversationsResponse{}
	if f.open != nil {
		for _, c := range f.open() {
			if req.Msg.GetTag() == "" || c.GetTag() == req.Msg.GetTag() {
				res.Conversations = append(res.Conversations, c)
			}
		}
	}
	return connect.NewResponse(res), nil
}

func (f *fakeControlPlane) GetSession(_ context.Context, req *connect.Request[operatorv1.GetSessionRequest]) (*connect.Response[operatorv1.Session], error) {
	f.mu.Lock()
	f.sessionReads[req.Msg.GetId()]++
	f.mu.Unlock()
	var session *operatorv1.Session
	if f.sessions != nil {
		session = f.sessions(req.Msg.GetId())
	}
	if session == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("Session "+req.Msg.GetId()+" was not found"))
	}
	return connect.NewResponse(session), nil
}

func (f *fakeControlPlane) ListTaskEvents(_ context.Context, req *connect.Request[operatorv1.ListTaskEventsRequest]) (*connect.Response[operatorv1.ListTaskEventsResponse], error) {
	res := &operatorv1.ListTaskEventsResponse{}
	if f.taskEvents != nil {
		for _, event := range f.taskEvents(req.Msg) {
			if event.GetSequence() > req.Msg.GetAfterSequence() {
				res.Events = append(res.Events, event)
			}
		}
	}
	return connect.NewResponse(res), nil
}

func (f *fakeControlPlane) team(name string) *operatorv1.Team {
	if f.teamList == nil {
		return nil
	}
	for _, team := range f.teamList() {
		if team.GetId() == name || team.GetName() == name {
			return team
		}
	}
	return nil
}

func (f *fakeControlPlane) ListTeams(context.Context, *connect.Request[operatorv1.ListTeamsRequest]) (*connect.Response[operatorv1.ListTeamsResponse], error) {
	res := &operatorv1.ListTeamsResponse{}
	if f.teamList != nil {
		res.Teams = f.teamList()
	}
	return connect.NewResponse(res), nil
}

func (f *fakeControlPlane) GetTeam(_ context.Context, req *connect.Request[operatorv1.GetTeamRequest]) (*connect.Response[operatorv1.Team], error) {
	team := f.team(req.Msg.GetTeam())
	if team == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("Team "+req.Msg.GetTeam()+" was not found"))
	}
	return connect.NewResponse(team), nil
}

func (f *fakeControlPlane) ListWorkstreamPosts(_ context.Context, req *connect.Request[operatorv1.ListWorkstreamPostsRequest]) (*connect.Response[operatorv1.ListWorkstreamPostsResponse], error) {
	f.mu.Lock()
	f.postReads[req.Msg.GetTeam()]++
	f.mu.Unlock()
	if f.team(req.Msg.GetTeam()) == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("Team "+req.Msg.GetTeam()+" was not found"))
	}
	res := &operatorv1.ListWorkstreamPostsResponse{}
	if f.posts != nil {
		res = f.posts(req.Msg)
	}
	return connect.NewResponse(res), nil
}

func (f *fakeControlPlane) ListWorkerHosts(context.Context, *connect.Request[operatorv1.ListWorkerHostsRequest]) (*connect.Response[operatorv1.ListWorkerHostsResponse], error) {
	f.mu.Lock()
	f.hostReads++
	f.mu.Unlock()
	if f.hostErr != nil {
		return nil, f.hostErr
	}
	res := &operatorv1.ListWorkerHostsResponse{}
	if f.hostList != nil {
		res.WorkerHosts = f.hostList()
	}
	return connect.NewResponse(res), nil
}

func (f *fakeControlPlane) count(counts map[string]int, key string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return counts[key]
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

// tagList is the active Tags with these names.
func tagList(names ...string) []*operatorv1.Tag {
	tags := make([]*operatorv1.Tag, 0, len(names))
	for _, name := range names {
		tags = append(tags, &operatorv1.Tag{
			Metadata: &operatorv1.Metadata{Id: "tag-" + name, Name: name},
			Spec:     &operatorv1.TagSpec{},
			Status:   &operatorv1.TagStatus{Phase: operatorv1.TagPhase_TAG_PHASE_ACTIVE},
		})
	}
	return tags
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
		Question: &operatorv1.InboxQuestion{Text: text}}
}

func approvalItem(objective, id, summary string) *operatorv1.InboxItem {
	return &operatorv1.InboxItem{Key: "approval:" + id, Occurrence: "approval:" + id + ":1", ObjectiveId: objective,
		Kind: operatorv1.InboxItemKind_INBOX_ITEM_KIND_APPROVAL, OperatorEligible: true, Reason: "An approval request waits.",
		Approval: &operatorv1.InboxApproval{RequestId: id, Summary: summary, RequestingTag: "builder", TaskId: "task-push", Blocking: true},
		Commands: []string{"supertag approve request " + id, "supertag deny request " + id + " --reason TEXT"}}
}

// commandEvent is a recorded Worker event of a command that starts or ends.
func commandEvent(task string, sequence int64, id, line, status string) *operatorv1.TaskEvent {
	payload, err := structpb.NewStruct(map[string]any{"command": map[string]any{"id": id, "command": line, "status": status}})
	if err != nil {
		panic(err)
	}
	return &operatorv1.TaskEvent{Id: fmt.Sprintf("e%d", sequence), TaskId: task, Sequence: sequence, Type: "execution.command.updated", Payload: payload}
}

// toolEvent is a recorded Worker event of a tool call that starts.
func toolEvent(task string, sequence int64, id, provider, operation string) *operatorv1.TaskEvent {
	payload, err := structpb.NewStruct(map[string]any{"call": map[string]any{"id": id, "provider": provider, "operation": operation}})
	if err != nil {
		panic(err)
	}
	return &operatorv1.TaskEvent{Id: fmt.Sprintf("e%d", sequence), TaskId: task, Sequence: sequence, Type: "execution.tool.call.started", Payload: payload}
}

// delivered is a work Session whose latest Task delivered branch at head from base on ref, with
// a pull request when pr is set.
func delivered(id, task, branch, base, head, ref, pr string) *operatorv1.Session {
	delivery := &operatorv1.TaskDelivery{Workspace: &operatorv1.WorkspaceDelivery{Name: "app", Mode: operatorv1.WorkspaceDeliveryMode_WORKSPACE_DELIVERY_MODE_BRANCH,
		Branch: branch, Base: base, Head: head, Ref: ref}}
	if pr != "" {
		delivery.Workspace.Mode = operatorv1.WorkspaceDeliveryMode_WORKSPACE_DELIVERY_MODE_PULL_REQUEST
		delivery.PullRequest = &operatorv1.PullRequestDelivery{Repository: "acme/app", Number: 7, Url: pr, State: operatorv1.PullRequestState_PULL_REQUEST_STATE_READY}
	}
	return &operatorv1.Session{Id: id, Tag: "lead", Title: "Fix", LatestTaskId: task, LatestTaskStatus: operatorv1.TaskStatus_TASK_STATUS_COMPLETED,
		Delivery: &operatorv1.SessionDelivery{TaskId: task, Delivery: delivery, Checkout: &operatorv1.TaskFiles{WorkerHostId: "laptop"}}}
}
