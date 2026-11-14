package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/structpb"

	"github.com/atemaguer/supertag/apps/tui/views"
	v2 "github.com/atemaguer/supertag/rust/bindings/go/runtimev2"
	rpc "github.com/atemaguer/supertag/rust/bindings/go/runtimev2/runtimev2connect"
)

// fakeControlPlane serves the Control Plane's runtime.v2 operator services from the presentation
// types a test declares: Tags, Worker Hosts, Teams and Workstream posts. Every other list it
// answers empty, and its event stream only stays open.
type fakeControlPlane struct {
	rpc.UnimplementedOperatorHandler
	rpc.UnimplementedConversationsHandler
	rpc.UnimplementedObjectivesHandler
	rpc.UnimplementedInboxHandler
	rpc.UnimplementedOperatorEventsHandler
	rpc.UnimplementedTeamsHandler
	rpc.UnimplementedWorkSessionsHandler

	token string
	// tags answers ListTags; an error refuses it.
	tags func() ([]*views.Tag, error)
	// teamList answers ListTeams and GetTeam; posts answers ListWorkstreamPosts.
	teamList func() []*views.Team
	posts    func(team string) []*views.WorkstreamPost
	// hostList answers ListHosts; hostErr, when set, refuses it.
	hostList func() []*views.WorkerHost
	hostErr  error

	mu            sync.Mutex
	postReads     map[string]int
	teamGets      map[string]int
	teamListReads int
	badAuth       int
	tagReads      int
	hostReads     int
}

func (f *fakeControlPlane) start(t *testing.T) *httptest.Server {
	t.Helper()
	if f.token == "" {
		f.token = "secret"
	}
	f.postReads, f.teamGets = map[string]int{}, map[string]int{}
	mux := http.NewServeMux()
	handleNegotiation(mux)
	mux.Handle(rpc.NewOperatorHandler(f))
	mux.Handle(rpc.NewConversationsHandler(f))
	mux.Handle(rpc.NewObjectivesHandler(f))
	mux.Handle(rpc.NewInboxHandler(f))
	mux.Handle(rpc.NewOperatorEventsHandler(f))
	mux.Handle(rpc.NewTeamsHandler(f))
	mux.Handle(rpc.NewWorkSessionsHandler(f))
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != rpc.ProtocolNegotiationNegotiateProcedure && r.Header.Get("Authorization") != "Bearer "+f.token {
			f.mu.Lock()
			f.badAuth++
			f.mu.Unlock()
			w.Header().Set("Content-Type", "application/grpc")
			w.Header().Set("Grpc-Status", fmt.Sprint(int(connect.CodeUnauthenticated)))
			w.Header().Set("Grpc-Message", "The operator token is not valid.")
			w.WriteHeader(http.StatusOK)
			return
		}
		mux.ServeHTTP(w, r)
	}))
	server.EnableHTTP2 = true
	server.Config.Protocols = new(http.Protocols)
	server.Config.Protocols.SetUnencryptedHTTP2(true)
	server.Start()
	t.Cleanup(server.Close)
	return server
}

func (f *fakeControlPlane) reads() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.tagReads
}

func (f *fakeControlPlane) ListTags(context.Context, *connect.Request[v2.ListTagsRequest]) (*connect.Response[v2.ListTagsResponse], error) {
	f.mu.Lock()
	f.tagReads++
	f.mu.Unlock()
	res := &v2.ListTagsResponse{}
	if f.tags != nil {
		tags, err := f.tags()
		if err != nil {
			return nil, err
		}
		for _, tag := range tags {
			res.Tags = append(res.Tags, &v2.Tag{TagId: tag.GetMetadata().GetName(), Name: tag.GetMetadata().GetName()})
		}
	}
	return connect.NewResponse(res), nil
}

func (f *fakeControlPlane) ListHosts(context.Context, *connect.Request[v2.ListHostsRequest]) (*connect.Response[v2.ListHostsResponse], error) {
	f.mu.Lock()
	f.hostReads++
	f.mu.Unlock()
	if f.hostErr != nil {
		return nil, f.hostErr
	}
	res := &v2.ListHostsResponse{}
	if f.hostList != nil {
		for _, host := range f.hostList() {
			phase := map[views.WorkerHostPhase]v2.HostPhase{
				views.WorkerHostPhase_WORKER_HOST_PHASE_READY:       v2.HostPhase_HOST_PHASE_READY,
				views.WorkerHostPhase_WORKER_HOST_PHASE_CONNECTED:   v2.HostPhase_HOST_PHASE_BUSY,
				views.WorkerHostPhase_WORKER_HOST_PHASE_UNREACHABLE: v2.HostPhase_HOST_PHASE_OFFLINE,
				views.WorkerHostPhase_WORKER_HOST_PHASE_DRAINING:    v2.HostPhase_HOST_PHASE_DRAINING,
				views.WorkerHostPhase_WORKER_HOST_PHASE_REVOKED:     v2.HostPhase_HOST_PHASE_REVOKED,
			}[host.GetPhase()]
			if phase == v2.HostPhase_HOST_PHASE_UNSPECIFIED {
				phase = v2.HostPhase_HOST_PHASE_PENDING
			}
			res.Hosts = append(res.Hosts, &v2.WorkerHostStatus{
				HostId: host.GetMetadata().GetId(), Phase: phase, Draining: host.GetDraining(),
				Capacity: uint32(host.GetCapacity()), AvailableSlots: uint32(host.GetAvailableSlots()),
			})
		}
	}
	return connect.NewResponse(res), nil
}

func (f *fakeControlPlane) ListConversations(context.Context, *connect.Request[v2.ListConversationsRequest]) (*connect.Response[v2.ListConversationsResponse], error) {
	return connect.NewResponse(&v2.ListConversationsResponse{}), nil
}

func (f *fakeControlPlane) ListMessages(context.Context, *connect.Request[v2.ListMessagesRequest]) (*connect.Response[v2.ListMessagesResponse], error) {
	return connect.NewResponse(&v2.ListMessagesResponse{}), nil
}

func (f *fakeControlPlane) ListObjectives(context.Context, *connect.Request[v2.ListObjectivesRequest]) (*connect.Response[v2.ListObjectivesResponse], error) {
	return connect.NewResponse(&v2.ListObjectivesResponse{}), nil
}

func (f *fakeControlPlane) ListItems(context.Context, *connect.Request[v2.ListInboxItemsRequest]) (*connect.Response[v2.ListInboxItemsResponse], error) {
	return connect.NewResponse(&v2.ListInboxItemsResponse{}), nil
}

func (f *fakeControlPlane) List(context.Context, *connect.Request[v2.ListWorkSessionsRequest]) (*connect.Response[v2.ListWorkSessionsResponse], error) {
	return connect.NewResponse(&v2.ListWorkSessionsResponse{}), nil
}

func (f *fakeControlPlane) Watch(ctx context.Context, _ *connect.Request[v2.WatchRequest], _ *connect.ServerStream[v2.WatchEvent]) error {
	<-ctx.Done()
	return nil
}

func (f *fakeControlPlane) team(name string) *views.Team {
	if f.teamList == nil {
		return nil
	}
	for _, team := range f.teamList() {
		if team.GetName() == name || team.GetId() == name {
			return team
		}
	}
	return nil
}

func runtimeTeamOf(team *views.Team) *v2.Team {
	out := &v2.Team{TeamId: team.GetId(), Name: team.GetName(), Revision: uint64(team.GetRevision())}
	if team.MaxConcurrency != nil {
		limit := uint32(team.GetMaxConcurrency())
		out.MaxConcurrency = &limit
	}
	// Rust Tag IDs are the names the operator chose.
	for _, member := range team.GetMembers() {
		out.MemberTagIds = append(out.MemberTagIds, member.GetTag())
	}
	return out
}

func (f *fakeControlPlane) ListTeams(context.Context, *connect.Request[v2.ListTeamsRequest]) (*connect.Response[v2.ListTeamsResponse], error) {
	f.mu.Lock()
	f.teamListReads++
	f.mu.Unlock()
	res := &v2.ListTeamsResponse{}
	if f.teamList != nil {
		for _, team := range f.teamList() {
			res.Teams = append(res.Teams, runtimeTeamOf(team))
		}
	}
	return connect.NewResponse(res), nil
}

func (f *fakeControlPlane) GetTeam(_ context.Context, req *connect.Request[v2.GetTeamRequest]) (*connect.Response[v2.Team], error) {
	f.mu.Lock()
	f.teamGets[req.Msg.GetTeam()]++
	f.mu.Unlock()
	team := f.team(req.Msg.GetTeam())
	if team == nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no Team %s", req.Msg.GetTeam()))
	}
	return connect.NewResponse(runtimeTeamOf(team)), nil
}

func (f *fakeControlPlane) ListWorkstreamPosts(_ context.Context, req *connect.Request[v2.ListWorkstreamPostsRequest]) (*connect.Response[v2.ListWorkstreamPostsResponse], error) {
	f.mu.Lock()
	f.postReads[req.Msg.GetTeam()]++
	f.mu.Unlock()
	res := &v2.ListWorkstreamPostsResponse{}
	if f.posts != nil {
		for _, post := range f.posts(req.Msg.GetTeam()) {
			res.Posts = append(res.Posts, &v2.WorkstreamPost{
				PostId: post.GetId(), TeamId: req.Msg.GetTeam(), AuthorTagId: post.GetAuthorTagId(),
				ToTagIds: post.GetToTagIds(), Body: post.GetBody(), Sequence: uint64(post.GetSequence()),
				CreatedAtMs: post.GetCreatedAt().AsTime().UnixMilli(),
			})
		}
	}
	return connect.NewResponse(res), nil
}

func (f *fakeControlPlane) count(counts map[string]int, key string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return counts[key]
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// tagList is the active Tags with these names.
func tagList(names ...string) []*views.Tag {
	tags := make([]*views.Tag, 0, len(names))
	for _, name := range names {
		tags = append(tags, &views.Tag{
			Metadata: &views.Metadata{Id: "tag-" + name, Name: name},
			Spec:     &views.TagSpec{},
			Status:   &views.TagStatus{Phase: views.TagPhase_TAG_PHASE_ACTIVE},
		})
	}
	return tags
}

func finalReply(text string) *views.Reply {
	return &views.Reply{Presentation: views.ReplyPresentation_REPLY_PRESENTATION_FINAL_RESULT, Text: text}
}

func waitingMessage(task, text string) *views.Message {
	return &views.Message{TaskId: task, Tag: "lead", Conversation: "default", SessionId: "ses-default", Text: text,
		Status: views.ReplyStatus_REPLY_STATUS_WAITING}
}

func workSession(id, title, task string, report string) *views.WorkSession {
	session := &views.WorkSession{Id: id, Title: title, TaskId: task,
		Status: views.WorkSessionStatus_WORK_SESSION_STATUS_RUNNING, ReportStatus: views.ReplyStatus_REPLY_STATUS_WAITING}
	if report != "" {
		session.Status = views.WorkSessionStatus_WORK_SESSION_STATUS_COMPLETED
		session.ReportStatus = views.ReplyStatus_REPLY_STATUS_REPLIED
		session.ReportTaskId = "report-" + task
		session.Report = finalReply(report)
	}
	return session
}

func followEvent(sequence int64, part any) *views.FollowEvent {
	event := &views.FollowEvent{Sequence: sequence}
	switch p := part.(type) {
	case *views.TextDelta:
		event.Part = &views.FollowEvent_TextDelta{TextDelta: p}
	case *views.Activity:
		event.Part = &views.FollowEvent_Activity{Activity: p}
	case *views.Finish:
		event.Part = &views.FollowEvent_Finish{Finish: p}
	case *views.WorkSessionChanged:
		event.Part = &views.FollowEvent_WorkSessionChanged{WorkSessionChanged: p}
	case *views.FollowEnd:
		event.Part = &views.FollowEvent_End{End: p}
	case *views.Heartbeat:
		event.Part = &views.FollowEvent_Heartbeat{Heartbeat: p}
	default:
		panic("unknown follow part")
	}
	return event
}

func command(workSession, line string) *views.Activity {
	return &views.Activity{WorkSessionId: workSession, Text: "running: " + line,
		Detail: &views.Activity_Command{Command: &views.CommandActivity{Id: "c1", Command: line, Status: views.ActivityStatus_ACTIVITY_STATUS_RUNNING}}}
}

func tool(workSession, name string) *views.Activity {
	return &views.Activity{WorkSessionId: workSession, Text: "using: " + name,
		Detail: &views.Activity_Tool{Tool: &views.ToolActivity{Id: "u1", Tool: name, Status: views.ActivityStatus_ACTIVITY_STATUS_RUNNING}}}
}

func objective(id, outcome string, status views.ObjectiveStatus) *views.Objective {
	return &views.Objective{Id: id, Outcome: outcome, OwnerTagId: "tag-lead", OwnerTag: "lead", Status: status, Revision: 3}
}

func budgeted(o *views.Objective, spent, limit int64) *views.Objective {
	o.Budget = &views.Budget{LimitMinor: limit, Currency: "USD"}
	o.Spend = &views.ObjectiveSpend{AmountMinor: spent, Currency: "USD"}
	return o
}

func questionItem(objective, task, text string) *views.InboxItem {
	return &views.InboxItem{Key: "question:" + task, Occurrence: "question:" + task + ":1", ObjectiveId: objective,
		Kind: views.InboxItemKind_INBOX_ITEM_KIND_QUESTION, OperatorEligible: true, Reason: "The owner asked a question.",
		Question: &views.InboxQuestion{Text: text}}
}

func approvalItem(objective, id, summary string) *views.InboxItem {
	return &views.InboxItem{Key: "approval:" + id, Occurrence: "approval:" + id + ":1", ObjectiveId: objective,
		Kind: views.InboxItemKind_INBOX_ITEM_KIND_APPROVAL, OperatorEligible: true, Reason: "An approval request waits.",
		Approval: &views.InboxApproval{RequestId: id, Summary: summary, RequestingTag: "builder", TaskId: "task-push", Blocking: true},
		Commands: []string{"supertag approve request " + id, "supertag deny request " + id + " --reason TEXT"}}
}

// commandEvent is a recorded Worker event of a command that starts or ends.
func commandEvent(task string, sequence int64, id, line, status string) *views.TaskEvent {
	payload, err := structpb.NewStruct(map[string]any{"command": map[string]any{"id": id, "command": line, "status": status}})
	if err != nil {
		panic(err)
	}
	return &views.TaskEvent{Id: fmt.Sprintf("e%d", sequence), TaskId: task, Sequence: sequence, Type: "execution.command.updated", Payload: payload}
}

// toolEvent is a recorded Worker event of a tool call that starts.
func toolEvent(task string, sequence int64, id, provider, operation string) *views.TaskEvent {
	payload, err := structpb.NewStruct(map[string]any{"call": map[string]any{"id": id, "provider": provider, "operation": operation}})
	if err != nil {
		panic(err)
	}
	return &views.TaskEvent{Id: fmt.Sprintf("e%d", sequence), TaskId: task, Sequence: sequence, Type: "execution.tool.call.started", Payload: payload}
}

// delivered is a work Session whose latest Task delivered branch at head from base on ref, with
// a pull request when pr is set.
func delivered(id, task, branch, base, head, ref, pr string) *views.Session {
	delivery := &views.TaskDelivery{Workspace: &views.WorkspaceDelivery{Name: "app", Mode: views.WorkspaceDeliveryMode_WORKSPACE_DELIVERY_MODE_BRANCH,
		Branch: branch, Base: base, Head: head, Ref: ref}}
	if pr != "" {
		delivery.Workspace.Mode = views.WorkspaceDeliveryMode_WORKSPACE_DELIVERY_MODE_PULL_REQUEST
		delivery.PullRequest = &views.PullRequestDelivery{Repository: "acme/app", Number: 7, Url: pr, State: views.PullRequestState_PULL_REQUEST_STATE_READY}
	}
	return &views.Session{Id: id, Tag: "lead", Title: "Fix", LatestTaskId: task, LatestTaskStatus: views.TaskStatus_TASK_STATUS_COMPLETED,
		Delivery: &views.SessionDelivery{TaskId: task, Delivery: delivery, Checkout: &views.TaskFiles{WorkerHostId: "laptop"}}}
}
