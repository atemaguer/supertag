package client

import (
	"context"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	"github.com/atemaguer/supertag/apps/tui/views"
	v2 "github.com/atemaguer/supertag/sdks/go/runtimev2"
	rpc "github.com/atemaguer/supertag/sdks/go/runtimev2/runtimev2connect"
)

func testRuntime(t *testing.T, handler http.Handler, secure bool) *Client {
	t.Helper()
	server, target := testGateway(t, handler, secure)
	target.URL = server.URL
	c, err := New(target, "test-version")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	return c
}

// testGateway serves handler as a Gateway speaking binary gRPC over HTTP/2, with TLS when
// secure, and returns the target that trusts it, without a URL.
func testGateway(t *testing.T, handler http.Handler, secure bool) (*httptest.Server, Target) {
	t.Helper()
	negotiation := testNegotiation(t, []uint32{7})
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ProtoMajor != 2 || r.Header.Get("Content-Type") != "application/grpc" {
			t.Errorf("expected binary gRPC/HTTP2, got %s %s", r.Proto, r.Header.Get("Content-Type"))
		}
		if r.URL.Path == rpc.ProtocolNegotiationNegotiateProcedure {
			if r.Header.Get("Authorization") != "" {
				t.Error("negotiation carried a credential")
			}
			negotiation.ServeHTTP(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer test-operator" || r.Header.Get(clientVersionHeader) != "test-version" {
			t.Error("missing expected authentication or version header")
		}
		if r.Header.Get(protocolHeader) != "7" {
			t.Errorf("call %s did not name the negotiated protocol version", r.URL.Path)
		}
		handler.ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	target := Target{Token: "test-operator"}
	if secure {
		server.EnableHTTP2 = true
		server.StartTLS()
		target.ServerCAFile = filepath.Join(t.TempDir(), "ca.pem")
		cert := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw})
		if err := os.WriteFile(target.ServerCAFile, cert, 0600); err != nil {
			t.Fatal(err)
		}
	} else {
		server.Config.Protocols = new(http.Protocols)
		server.Config.Protocols.SetUnencryptedHTTP2(true)
		server.Start()
	}
	return server, target
}

// testNegotiation answers ProtocolNegotiation.Negotiate as a Gateway speaking versions.
func testNegotiation(t *testing.T, versions []uint32) http.Handler {
	mux := http.NewServeMux()
	testRPC(mux, rpc.ProtocolNegotiationNegotiateProcedure, func(_ context.Context, req *v2.NegotiateProtocolRequest) (*v2.NegotiateProtocolResponse, error) {
		if req.GetRole() != v2.ServiceRole_SERVICE_ROLE_CLIENT || req.GetBuildVersion() != "test-version" {
			t.Errorf("negotiation request = %v", req)
		}
		for _, version := range versions {
			if slices.Contains(req.GetProtocolVersions(), version) {
				return &v2.NegotiateProtocolResponse{Role: v2.ServiceRole_SERVICE_ROLE_GATEWAY, ProtocolVersion: version, ProtocolVersions: versions, BuildVersion: "0.1.0"}, nil
			}
		}
		// The refusal a SuperTag 0.3.0 Gateway sends, word for word.
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("incompatible SuperTag protocol: this Gateway (SuperTag 0.3.0) speaks protocol versions [2], but the connecting operator client (SuperTag test-version) offered [3]; run the same SuperTag release on both services"))
	})
	return mux
}

func TestRuntimeV2RefusesAGatewayFromAnotherProtocolEpoch(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == rpc.ProtocolNegotiationNegotiateProcedure {
			testNegotiation(t, []uint32{2}).ServeHTTP(w, r)
			return
		}
		calls.Add(1)
		http.Error(w, "unexpected call", http.StatusTeapot)
	}))
	server.Config.Protocols = new(http.Protocols)
	server.Config.Protocols.SetUnencryptedHTTP2(true)
	server.Start()
	t.Cleanup(server.Close)
	c, err := New(Target{URL: server.URL, Token: "test-operator"}, "test-version")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	_, err = c.ListTags(t.Context())
	var refused *APIError
	if !errors.As(err, &refused) || refused.Code != connect.CodeFailedPrecondition || !ProtocolMismatch(err) ||
		refused.Message != "This TUI speaks SuperTag protocol 7, but the Gateway at "+server.URL+" runs SuperTag 0.3.0 (protocol 2). Upgrade the Gateway." {
		t.Fatalf("ListTags against an old Gateway = %v", err)
	}
	if calls.Load() != 0 {
		t.Fatalf("an operator call reached a Gateway that refused negotiation")
	}
}

func testRPC[Req, Res any](mux *http.ServeMux, path string, call func(context.Context, *Req) (*Res, error)) {
	mux.Handle(path, connect.NewUnaryHandler(path, func(ctx context.Context, request *connect.Request[Req]) (*connect.Response[Res], error) {
		response, err := call(ctx, request.Msg)
		if err != nil {
			return nil, err
		}
		return connect.NewResponse(response), nil
	}))
}

func TestRuntimeV2TagsAndConversations(t *testing.T) {
	mux := http.NewServeMux()
	testRPC(mux, rpc.OperatorListTagsProcedure, func(_ context.Context, req *v2.ListTagsRequest) (*v2.ListTagsResponse, error) {
		switch req.GetCursor() {
		case "":
			return &v2.ListTagsResponse{Tags: []*v2.Tag{{TagId: "build"}}, NextCursor: "tags-cursor"}, nil
		case "tags-cursor":
			return &v2.ListTagsResponse{Tags: []*v2.Tag{{TagId: "lead", Name: "Engineering Lead", Lead: true}}}, nil
		default:
			return nil, fmt.Errorf("unexpected Tag cursor %q", req.GetCursor())
		}
	})
	var marked atomic.Pointer[v2.MarkConversationReadRequest]
	testRPC(mux, rpc.ConversationsListConversationsProcedure, func(_ context.Context, _ *v2.ListConversationsRequest) (*v2.ListConversationsResponse, error) {
		return &v2.ListConversationsResponse{Conversations: []*v2.Conversation{{
			TagId: "lead", ConversationId: "conversation-lead", SessionId: "session-a", Preview: "Ship it", PreviewFromTag: true,
			LatestOrder: 4, ReadOrder: 2, UnreadCount: 2, Working: true,
		}, {
			TagId: "build", ConversationId: "conversation-build", SessionId: "session-b", Preview: "Report",
			LatestWorkSessionReportId: proto.String("report-1"),
		}}}, nil
	})
	testRPC(mux, rpc.ConversationsMarkConversationReadProcedure, func(_ context.Context, req *v2.MarkConversationReadRequest) (*v2.Conversation, error) {
		marked.Store(req)
		return &v2.Conversation{TagId: req.GetTagId(), ReadOrder: req.GetOrder()}, nil
	})
	var operations []string
	var mu sync.Mutex
	task := &v2.Task{TaskId: "first", TagId: "lead", SessionId: "session-a", Prompt: "Verify SSO", State: v2.TaskState_TASK_STATE_QUEUED}
	testRPC(mux, rpc.ConversationsSendMessageProcedure, func(_ context.Context, req *v2.SendMessageRequest) (*v2.ConversationMessage, error) {
		if req.GetTagId() != "lead" || req.GetText() != task.GetPrompt() {
			t.Errorf("SendMessage request = %v", req)
		}
		mu.Lock()
		defer mu.Unlock()
		operations = append(operations, req.GetOperationId())
		if len(operations) == 1 {
			return nil, connect.NewError(connect.CodeUnavailable, errors.New("first reply was lost"))
		}
		return &v2.ConversationMessage{Task: task, Order: 5}, nil
	})
	testRPC(mux, rpc.ConversationsListMessagesProcedure, func(_ context.Context, req *v2.ListMessagesRequest) (*v2.ListMessagesResponse, error) {
		if req.GetTagId() != "lead" || req.GetCursor() != "message-cursor" || req.GetLimit() != 10 {
			t.Errorf("ListMessages request = %v", req)
		}
		// A conversation's history spans its Sessions.
		older := &v2.Task{TaskId: "older", TagId: "lead", SessionId: "session-0", Prompt: "Start", State: v2.TaskState_TASK_STATE_QUEUED}
		return &v2.ListMessagesResponse{Messages: []*v2.ConversationMessage{{Task: task, Order: 5}, {Task: older, Order: 1}},
			NextCursor: "more-messages", ConversationId: "conversation-lead"}, nil
	})
	c := testRuntime(t, mux, false)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tags, err := c.ListTags(ctx)
	// The lead Tag comes first, whatever page it arrives on.
	if err != nil || len(tags) != 2 || tags[1].GetMetadata().GetName() != "build" ||
		tags[0].GetMetadata().GetId() != "lead" || tags[0].GetMetadata().GetName() != "Engineering Lead" ||
		!tags[0].GetSpec().GetLead() || tags[1].GetSpec().GetLead() {
		t.Fatalf("ListTags = %v, %v", tags, err)
	}
	conversations, err := c.ListConversations(ctx)
	if err != nil || len(conversations) != 2 {
		t.Fatalf("ListConversations = %v, %v", conversations, err)
	}
	if lead := conversations[0]; lead.GetTag() != "lead" || lead.GetPreview() != "Ship it" || !lead.GetPreviewFromTag() ||
		lead.GetUnreadCount() != 2 || lead.GetReadOrder() != 2 || !lead.GetWorking() || lead.GetLatestWorkSessionReportId() != "" {
		t.Fatalf("lead conversation = %+v", lead)
	}
	if build := conversations[1]; build.GetTag() != "build" || build.GetPreviewFromTag() || build.GetLatestWorkSessionReportId() != "report-1" {
		t.Fatalf("build conversation = %+v", build)
	}
	if err := c.MarkConversationRead(ctx, "lead", 4); err != nil {
		t.Fatalf("MarkConversationRead = %v", err)
	}
	if req := marked.Load(); req.GetTagId() != "lead" || req.GetOrder() != 4 {
		t.Fatalf("MarkConversationRead request = %v", req)
	}
	sent, err := c.SendMessage(ctx, "lead", "Verify SSO", "operation-1")
	if err != nil || sent.GetTaskId() != "first" || sent.GetOrder() != 5 || sent.GetStarted() || sent.GetWaitingReason() != "" {
		t.Fatalf("SendMessage = %v, %v", sent, err)
	}
	mu.Lock()
	keys := slices.Clone(operations)
	mu.Unlock()
	if len(keys) != 2 || keys[0] != "operation-1" || keys[0] != keys[1] {
		t.Fatalf("send retry operation IDs = %v", keys)
	}
	page, err := c.ListMessages(ctx, "lead", MessageQuery{Limit: 10, Cursor: "message-cursor"})
	if err != nil || page.NextCursor != "more-messages" || page.ConversationID != "conversation-lead" || len(page.Messages) != 2 ||
		page.Messages[0].GetText() != "Verify SSO" || page.Messages[1].GetSessionId() != "session-0" {
		t.Fatalf("ListMessages = %+v, %v", page, err)
	}
}

func TestRuntimeV2FollowsEventPagesAfterTransientFailure(t *testing.T) {
	mux := http.NewServeMux()
	var settled atomic.Bool
	testRPC(mux, rpc.ConversationsGetMessageProcedure, func(_ context.Context, req *v2.GetMessageRequest) (*v2.ConversationMessage, error) {
		if req.GetTagId() != "lead" || req.GetTaskId() != "t1" {
			t.Errorf("GetMessage request = %v", req)
		}
		task := &v2.Task{TagId: "lead", TaskId: "t1", State: v2.TaskState_TASK_STATE_RUNNING}
		if settled.Load() {
			task.State, task.Result = v2.TaskState_TASK_STATE_SUCCEEDED, proto.String("done")
		}
		return &v2.ConversationMessage{Task: task}, nil
	})
	var cursors []uint64
	var mu sync.Mutex
	testRPC(mux, rpc.OperatorListEventsProcedure, func(_ context.Context, req *v2.ListEventsRequest) (*v2.ListEventsResponse, error) {
		if req.GetTaskId() != "t1" || req.GetLimit() != runtimeEventPage {
			t.Errorf("ListEvents request = %v", req)
		}
		mu.Lock()
		defer mu.Unlock()
		cursors = append(cursors, req.GetAfterSequence())
		switch len(cursors) {
		case 1:
			events := make([]*v2.TaskEvent, runtimeEventPage)
			for i := range events {
				events[i] = &v2.TaskEvent{Sequence: uint64(i + 1), Text: fmt.Sprintf("piece %d", i+1), Kind: v2.TaskEventKind_TASK_EVENT_KIND_MESSAGE}
			}
			return &v2.ListEventsResponse{Events: events}, nil
		case 2:
			settled.Store(true)
			return nil, connect.NewError(connect.CodeUnavailable, errors.New("Control Plane restarted"))
		case 3:
			return &v2.ListEventsResponse{Events: []*v2.TaskEvent{{Sequence: runtimeEventPage + 1, Text: "last piece", Kind: v2.TaskEventKind_TASK_EVENT_KIND_ACTIVITY}}}, nil
		case 4:
			// No new events: the follow reads the turn, which finished.
			return &v2.ListEventsResponse{}, nil
		default:
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("unexpected event request"))
		}
	})
	c := testRuntime(t, mux, false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := collect(t, testFollower(c).Follow(ctx, "lead", message("t1"), nil))
	var want []string
	for i := 1; i <= runtimeEventPage; i++ {
		want = append(want, fmt.Sprintf("message piece %d", i))
	}
	expect(t, events, append(append([]string{"started"}, want...), "status last piece", "reply done")...)
	mu.Lock()
	defer mu.Unlock()
	if !slices.Equal(cursors, []uint64{0, runtimeEventPage, runtimeEventPage, runtimeEventPage + 1}) {
		t.Fatalf("event cursors = %v", cursors)
	}
}

func TestRuntimeV2FollowsWithdrawnInputAsItsOwnTask(t *testing.T) {
	mux := http.NewServeMux()
	var withdrawn atomic.Bool
	testRPC(mux, rpc.ConversationsGetMessageProcedure, func(_ context.Context, req *v2.GetMessageRequest) (*v2.ConversationMessage, error) {
		switch req.GetTaskId() {
		case "original":
			withdrawn.Store(true)
			return &v2.ConversationMessage{
				Task: &v2.Task{TagId: "lead", TaskId: "original", State: v2.TaskState_TASK_STATE_RUNNING},
			}, nil
		case "follower":
			msg := &v2.ConversationMessage{
				Task:      &v2.Task{TagId: "lead", TaskId: "follower", State: v2.TaskState_TASK_STATE_SUCCEEDED},
				LiveInput: &v2.LiveInput{TaskId: "original", State: v2.LiveInputState_LIVE_INPUT_STATE_ACCEPTED},
			}
			if withdrawn.Load() {
				msg.LiveInput.State = v2.LiveInputState_LIVE_INPUT_STATE_WITHDRAWN
				msg.Task.Result = proto.String("own reply")
				// A finished turn carries its messages; the follow reads no events.
				msg.Events = []*v2.TaskEvent{{Sequence: 1, Text: "own event", Kind: v2.TaskEventKind_TASK_EVENT_KIND_MESSAGE}}
			}
			return msg, nil
		default:
			return nil, connect.NewError(connect.CodeNotFound, errors.New("unexpected Task"))
		}
	})
	testRPC(mux, rpc.OperatorListEventsProcedure, func(_ context.Context, req *v2.ListEventsRequest) (*v2.ListEventsResponse, error) {
		t.Errorf("a finished turn read its events: %v", req)
		return &v2.ListEventsResponse{}, nil
	})
	c := testRuntime(t, mux, false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	follower, err := c.GetMessage(ctx, "lead", "follower")
	if err != nil {
		t.Fatal(err)
	}
	history := History("lead", []*views.Message{follower, message("original")})
	if len(history) != 2 || !history[1].Follow {
		t.Fatalf("joined history = %v", history)
	}
	expect(t, history[1].Events, "joined")
	expect(t, collect(t, testFollower(c).Follow(ctx, "lead", follower, history[1].Shown)), "started", "message own event", "reply own reply")
}

func TestRuntimeV2ObjectiveOverTLS(t *testing.T) {
	mux := http.NewServeMux()
	limit, spend, currency := uint64(30000), uint64(1234), "USD"
	objective := &v2.Objective{
		ObjectiveId: "sso", OwnerTagId: "lead", SessionId: "objective-session", Outcome: "Verify SSO",
		Status: v2.ObjectiveStatus_OBJECTIVE_STATUS_READY_FOR_REVIEW, StartingTaskId: "objective-first",
		BudgetLimitMinor: &limit, BudgetCurrency: &currency, ReportedSpendMinor: &spend, Revision: 5, TeamId: proto.String("release"),
	}
	testRPC(mux, rpc.ObjectivesListObjectivesProcedure, func(_ context.Context, req *v2.ListObjectivesRequest) (*v2.ListObjectivesResponse, error) {
		if req.GetAfterId() == "sso" {
			return &v2.ListObjectivesResponse{}, nil
		}
		return &v2.ListObjectivesResponse{Objectives: []*v2.Objective{
			{ObjectiveId: "done", Status: v2.ObjectiveStatus_OBJECTIVE_STATUS_COMPLETED}, objective,
		}}, nil
	})
	testRPC(mux, rpc.ObjectivesCreateObjectiveProcedure, func(_ context.Context, req *v2.CreateObjectiveRequest) (*v2.Objective, error) {
		if req.GetOperationId() != "sso" || req.GetObjectiveId() != "sso" || req.GetOwnerTagId() != "lead" ||
			req.GetOutcome() != "Verify SSO" || req.GetBudgetLimitMinor() != limit || req.GetBudgetCurrency() != currency ||
			req.GetTeamId() != "Release team" {
			t.Errorf("CreateObjective request = %v", req)
		}
		return objective, nil
	})
	testRPC(mux, rpc.ObjectivesGetObjectiveProcedure, func(_ context.Context, req *v2.GetObjectiveRequest) (*v2.Objective, error) {
		if req.GetObjectiveId() != "sso" {
			t.Errorf("GetObjective request = %v", req)
		}
		return objective, nil
	})
	testRPC(mux, rpc.ObjectiveOverviewsGetObjectiveOverviewProcedure, func(_ context.Context, req *v2.GetObjectiveOverviewRequest) (*v2.ObjectiveOverview, error) {
		return &v2.ObjectiveOverview{Objective: objective}, nil
	})
	testRPC(mux, rpc.ObjectivesListCommitReviewsProcedure, func(_ context.Context, req *v2.ListObjectiveCommitReviewsRequest) (*v2.ListObjectiveCommitReviewsResponse, error) {
		if req.GetObjectiveId() != "sso" {
			t.Errorf("ListCommitReviews request = %v", req)
		}
		return &v2.ListObjectiveCommitReviewsResponse{}, nil
	})
	task := &v2.Task{TagId: "lead", TaskId: "follow-up", SessionId: "objective-session", State: v2.TaskState_TASK_STATE_SUCCEEDED, Result: proto.String("Verified")}
	testRPC(mux, rpc.OperatorSubmitTaskProcedure, func(_ context.Context, req *v2.SubmitTaskRequest) (*v2.Task, error) {
		if req.GetTagId() != "lead" || req.GetSessionId() != "objective-session" || req.GetOperationId() == "" || req.GetPrompt() != "Try again" {
			t.Errorf("SubmitTask request = %v", req)
		}
		return task, nil
	})
	testRPC(mux, rpc.OperatorGetTaskProcedure, func(_ context.Context, req *v2.GetTaskRequest) (*v2.Task, error) {
		if req.GetTaskId() != "follow-up" {
			t.Errorf("GetTask request = %v", req)
		}
		return task, nil
	})
	testRPC(mux, rpc.OperatorListEventsProcedure, func(_ context.Context, req *v2.ListEventsRequest) (*v2.ListEventsResponse, error) {
		if req.GetTaskId() != "follow-up" || req.GetAfterSequence() != 0 {
			t.Errorf("ListEvents request = %v", req)
		}
		return &v2.ListEventsResponse{}, nil
	})
	c := testRuntime(t, mux, true)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	open, err := c.ListOpenObjectives(ctx)
	if err != nil || len(open) != 1 || open[0].GetId() != "sso" ||
		open[0].GetStatus() != views.ObjectiveStatus_OBJECTIVE_STATUS_READY_FOR_REVIEW {
		t.Fatalf("ListOpenObjectives = %v, %v", open, err)
	}
	created, err := c.CreateObjective(ctx, NewObjective{ID: "sso", Owner: "lead", Outcome: "Verify SSO", Team: "Release team", Budget: &views.Budget{
		LimitMinor: int64(limit), Currency: currency,
	}})
	if err != nil || created.GetStartedTaskId() != "objective-first" || created.GetObjective().GetTeamId() != "release" {
		t.Fatalf("CreateObjective = %v, %v", created, err)
	}
	view, err := c.DescribeObjective(ctx, "sso")
	if err != nil || len(view.GetSessions()) != 1 || view.GetSessions()[0].GetId() != "objective-session" ||
		view.GetBudget().GetSpentMinor() != int64(spend) || view.GetBudget().GetAvailableMinor() != int64(limit-spend) {
		t.Fatalf("DescribeObjective = %v, %v", view, err)
	}
	sent, err := c.MessageObjective(ctx, "sso", "Try again")
	if err != nil || sent.GetTaskId() != "follow-up" {
		t.Fatalf("MessageObjective = %v, %v", sent, err)
	}
	msg, err := c.GetObjectiveMessage(ctx, sent.GetTag(), sent.GetTaskId())
	if err != nil {
		t.Fatal(err)
	}
	expect(t, collect(t, testFollower(c).FollowObjective(ctx, sent.GetTag(), msg)), "started", "reply Verified")
}

func TestRuntimeV2TeamsAndWorkstream(t *testing.T) {
	mux := http.NewServeMux()
	team := &v2.Team{
		TeamId: "release", Name: "Release review", MemberTagIds: []string{"lead", "reviewer"},
		MaxConcurrency: proto.Uint32(2), Revision: 4, CreatedAtMs: 1000, UpdatedAtMs: 2000,
	}
	testRPC(mux, rpc.TeamsListTeamsProcedure, func(_ context.Context, req *v2.ListTeamsRequest) (*v2.ListTeamsResponse, error) {
		switch req.GetCursor() {
		case "":
			return &v2.ListTeamsResponse{Teams: []*v2.Team{team}, NextCursor: "opaque-b"}, nil
		case "opaque-b":
			return &v2.ListTeamsResponse{Teams: []*v2.Team{{TeamId: "docs", Name: "Docs"}}, NextCursor: "opaque-a"}, nil
		case "opaque-a":
			return &v2.ListTeamsResponse{Teams: []*v2.Team{{TeamId: "ops", Name: "Ops"}}}, nil
		default:
			return nil, fmt.Errorf("unexpected Team cursor %q", req.GetCursor())
		}
	})
	testRPC(mux, rpc.TeamsGetTeamProcedure, func(_ context.Context, req *v2.GetTeamRequest) (*v2.Team, error) {
		if req.GetTeam() != team.GetName() {
			t.Errorf("GetTeam request = %v", req)
		}
		return team, nil
	})
	testRPC(mux, rpc.TeamsListWorkstreamPostsProcedure, func(_ context.Context, req *v2.ListWorkstreamPostsRequest) (*v2.ListWorkstreamPostsResponse, error) {
		if req.GetTeam() != "release" || req.GetLimit() != 10 || req.AfterSequence != nil {
			t.Errorf("ListWorkstreamPosts request = %v", req)
		}
		return &v2.ListWorkstreamPostsResponse{Posts: []*v2.WorkstreamPost{{
			PostId: "post-1", TeamId: "release", AuthorTagId: "reviewer", ToTagIds: []string{"lead"},
			Body: "Checks passed.", SourceTaskId: "task-1", Sequence: 3, CreatedAtMs: 3000,
		}}}, nil
	})
	c := testRuntime(t, mux, false)
	teams, err := c.ListTeams(t.Context())
	if err != nil || len(teams) != 3 || teams[0].GetId() != "release" || teams[2].GetId() != "ops" ||
		teams[0].GetMaxConcurrency() != 2 || teams[0].GetMembers()[1].GetTag() != "reviewer" {
		t.Fatalf("ListTeams = %v, %v", teams, err)
	}
	view, err := c.GetTeam(t.Context(), "Release review", 10)
	if err != nil || view.Team.GetRevision() != 4 || view.TagNames["lead"] != "lead" || len(view.Posts) != 1 {
		t.Fatalf("GetTeam = %+v, %v", view, err)
	}
	post := view.Posts[0]
	if post.GetBody() != "Checks passed." || post.GetSequence() != 3 || post.GetCreatedAt().AsTime().UnixMilli() != 3000 {
		t.Fatalf("Workstream post = %v", post)
	}
}

func TestRuntimeV2CancelsInFlightFollow(t *testing.T) {
	mux := http.NewServeMux()
	called, stopped := make(chan struct{}), make(chan struct{})
	testRPC(mux, rpc.ConversationsGetMessageProcedure, func(ctx context.Context, _ *v2.GetMessageRequest) (*v2.ConversationMessage, error) {
		close(called)
		<-ctx.Done()
		close(stopped)
		return nil, ctx.Err()
	})
	c := testRuntime(t, mux, false)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	follow := testFollower(c).Follow(ctx, "lead", message("t1"), nil)
	select {
	case <-called:
	case <-ctx.Done():
		t.Fatal("the Gateway never received the follow")
	}
	cancel()
	expect(t, collect(t, follow))
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("the in-flight gRPC call did not end")
	}
}

func TestRuntimeV2RejectsUnsafeTargets(t *testing.T) {
	for _, target := range []Target{
		{URL: "http://example.test", Token: "token"},
		{URL: "http://localhost", Token: "token"},
		{URL: "http://127.0.0.1", Token: "token", ServerCAFile: "ca.pem"},
		{URL: "https://example.test/path", Token: "token"},
		{URL: "https://example.test?parameter", Token: "token"},
		{URL: "https://user@example.test", Token: "token"},
		{URL: "https://example.test", Token: "token", ClientKeyFile: "key.pem"},
		{URL: "https://example.test"},
		{URL: "ws://example.test", Token: "token"},
		{URL: "ws://localhost/tunnel", Token: "token"},
		{URL: "ws://127.0.0.1", Token: "token", ClientCertFile: "cert.pem", ClientKeyFile: "key.pem"},
		{URL: "wss://user@example.test", Token: "token"},
		{URL: "wss://example.test/tunnel?parameter", Token: "token"},
		{URL: "wss://example.test/#fragment", Token: "token"},
		{URL: "wss://example.test", Token: "token", ClientCertFile: "cert.pem"},
		{URL: "ftp://example.test", Token: "token"},
	} {
		if _, err := New(target, "test-version"); err == nil {
			t.Errorf("invalid target %q was accepted", target.URL)
		}
	}
}

func TestRuntimeV2RefusesRedirect(t *testing.T) {
	var redirected atomic.Bool
	mux := http.NewServeMux()
	mux.HandleFunc(rpc.OperatorListTagsProcedure, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/different-route", http.StatusTemporaryRedirect)
	})
	mux.HandleFunc("/different-route", func(http.ResponseWriter, *http.Request) {
		redirected.Store(true)
	})
	c := testRuntime(t, mux, false)
	if _, err := c.ListTags(context.Background()); err == nil || redirected.Load() {
		t.Fatal("Gateway redirect must fail without a second request")
	}
}

func TestRuntimeEventsShowAsMessagesOrOneStatusLine(t *testing.T) {
	for _, tc := range []struct {
		event *v2.TaskEvent
		want  string
	}{
		{&v2.TaskEvent{Kind: v2.TaskEventKind_TASK_EVENT_KIND_MESSAGE, Text: " I'll look first.\n"}, "message I'll look first."},
		{&v2.TaskEvent{Kind: v2.TaskEventKind_TASK_EVENT_KIND_ACTIVITY, Text: "Running go test"}, "status Running go test"},
		{&v2.TaskEvent{Kind: v2.TaskEventKind_TASK_EVENT_KIND_PROGRESS, Text: `{"type":"progress.updated","progress":{"summary":"Fixing tests","items":[{"text":"Patch","status":"completed"},{"text":"Run CI","status":"active"}]}}`}, "status Fixing tests: Run CI"},
		{&v2.TaskEvent{Kind: v2.TaskEventKind_TASK_EVENT_KIND_PROGRESS, Text: `{"type":"progress.updated","progress":{"summary":"Waiting on CI"}}`}, "status Waiting on CI"},
		{&v2.TaskEvent{Kind: v2.TaskEventKind_TASK_EVENT_KIND_PROGRESS, Text: "not json"}, ""},
		{&v2.TaskEvent{Text: "untyped"}, ""},
	} {
		var got []FollowEvent
		if event, ok := turnEvent(tc.event); ok {
			got = append(got, event)
		}
		if describe(got) != tc.want {
			t.Errorf("turnEvent(%v) = %q, want %q", tc.event, describe(got), tc.want)
		}
	}
}

// A report turn shows its report through its Work Session; the messages of the parent's report
// turn are not messages of the conversation.
func TestAReportTurnCarriesNoMessagesOfItsOwn(t *testing.T) {
	report := "work/1"
	message := runtimeMessage(&v2.ConversationMessage{WorkSessionReportId: &report,
		Task:   &v2.Task{TaskId: "report", TagId: "lead", Prompt: "Report on work/1", State: v2.TaskState_TASK_STATE_SUCCEEDED, Result: proto.String("Done")},
		Events: []*v2.TaskEvent{{Sequence: 1, Kind: v2.TaskEventKind_TASK_EVENT_KIND_MESSAGE, Text: "Reporting."}}})
	if message.GetText() != "" || len(message.GetTagMessages()) != 0 || message.GetActivity() != "" {
		t.Fatalf("report turn = %+v", message)
	}
}

// A Schedule's turn has no message from you; it keeps the Tag's messages and names its Schedule.
func TestAScheduledTurnCarriesItsScheduleAndNoMessageFromYou(t *testing.T) {
	schedule := "sch_1"
	message := runtimeMessage(&v2.ConversationMessage{ScheduleId: &schedule,
		Task:   &v2.Task{TaskId: "woken", TagId: "lead", State: v2.TaskState_TASK_STATE_SUCCEEDED, Result: proto.String("CI is green.")},
		Events: []*v2.TaskEvent{{Sequence: 1, Kind: v2.TaskEventKind_TASK_EVENT_KIND_MESSAGE, Text: "Checking PR 412."}}})
	if message.GetText() != "" || message.GetScheduleId() != schedule || len(message.GetTagMessages()) != 1 {
		t.Fatalf("scheduled turn = %+v", message)
	}
}

// A closed work Session says why, such as `idle`; an open one says nothing.
func TestCloseReasonNamesWhyAWorkSessionClosed(t *testing.T) {
	closed := int64(1)
	if got := CloseReason(&v2.WorkSession{ClosedAtMs: &closed, CloseReason: v2.WorkSessionCloseReason_WORK_SESSION_CLOSE_REASON_IDLE}); got != "idle" {
		t.Fatalf("idle close = %q", got)
	}
	if got := CloseReason(&v2.WorkSession{CloseReason: v2.WorkSessionCloseReason_WORK_SESSION_CLOSE_REASON_IDLE}); got != "" {
		t.Fatalf("an open work Session = %q", got)
	}
}

// A reply shows as soon as the Tag's harness finishes, while the turn still delivers its
// changes; the turn stays followed, and a failure to deliver them adds the error beside the
// reply instead of replacing it.
func TestAReplyShowsAtHarnessDoneAndAFailedDeliveryAddsItsError(t *testing.T) {
	events := []*v2.TaskEvent{{Sequence: 1, Kind: v2.TaskEventKind_TASK_EVENT_KIND_MESSAGE, Text: "Fixed it."}}
	running := runtimeMessage(&v2.ConversationMessage{
		Task:   &v2.Task{TaskId: "turn", TagId: "lead", Prompt: "Fix it", State: v2.TaskState_TASK_STATE_RUNNING, Result: proto.String("Fixed it.")},
		Events: events})
	if running.GetStatus() != views.ReplyStatus_REPLY_STATUS_REPLIED || !running.GetFinalizing() ||
		running.GetReply().GetText() != "Fixed it." {
		t.Fatalf("running turn with its reply = %+v", running)
	}
	working := runtimeMessage(&v2.ConversationMessage{
		Task: &v2.Task{TaskId: "busy", TagId: "lead", Prompt: "Fix it", State: v2.TaskState_TASK_STATE_RUNNING}})
	if working.GetStatus() == views.ReplyStatus_REPLY_STATUS_REPLIED || working.GetFinalizing() {
		t.Fatalf("running turn without a reply = %+v", working)
	}

	shown := newShown("lead")
	shown.finalizing = running.GetFinalizing()
	got := shown.reply(running.GetReply())
	if len(got) != 1 || got[0].Kind != EventReply || shown.settled() {
		t.Fatalf("early reply events %v, settled %v", got, shown.settled())
	}
	failed := runtimeReply(&v2.Task{State: v2.TaskState_TASK_STATE_FAILED, Result: proto.String("Workspace delivery could not be committed")})
	shown.finalizing = false
	got = shown.reply(failed)
	if len(got) != 1 || got[0].Kind != EventTurnError || !strings.Contains(got[0].Text, "could not be committed") {
		t.Fatalf("failure after the reply = %v", got)
	}
	if again := shown.reply(failed); len(again) != 0 || !shown.settled() {
		t.Fatalf("failure shown twice: %v", again)
	}

	succeeded := newShown("lead")
	succeeded.finalizing = true
	succeeded.reply(running.GetReply())
	succeeded.finalizing = false
	if more := succeeded.reply(runtimeReply(&v2.Task{State: v2.TaskState_TASK_STATE_SUCCEEDED, Result: proto.String("Fixed it.")})); len(more) != 0 || !succeeded.settled() {
		t.Fatalf("a delivered turn repeated its reply: %v", more)
	}
}

func TestSessionBranchMatchesTheControlPlane(t *testing.T) {
	// Values from supertag_protocol::session_branch: SHA-256 of serde_json's compact pair.
	for _, c := range []struct{ tag, session, want string }{
		{"lead", "5f0c", "supertag/session/fcd1201e9154747d83e3291951dd30cbc09383d35ea12c4bbe7e1d7e7e520185"},
		{"a<b", `s&"x`, "supertag/session/81bbb4edb0deb2f4ce02a7b7a498959599918a9d3553a161fbf9b0125b56c914"},
	} {
		if got := SessionBranch(c.tag, c.session); got != c.want {
			t.Errorf("SessionBranch(%q, %q) = %q, want %q", c.tag, c.session, got, c.want)
		}
	}
}

func TestAFinishedTurnSaysOnceWhereItsChangesWent(t *testing.T) {
	task := &v2.Task{TagId: "lead", SessionId: "5f0c", State: v2.TaskState_TASK_STATE_SUCCEEDED,
		Workspace:         &v2.WorkspaceSpec{WorkspaceId: "app"},
		WorkspaceDelivery: &v2.WorkspaceDeliveryReference{BaseCommit: "a", HeadCommit: "b"}}
	got := delivery(task)
	if got == nil || got.Branch != SessionBranch("lead", "5f0c") || got.Workspace != "app" || got.Remote {
		t.Fatalf("delivery = %v", got)
	}
	shown := newShown("lead")
	events := shown.delivered(got)
	if len(events) != 1 || events[0].Kind != EventDelivered ||
		events[0].Text != "Changes are on branch "+got.Branch+" in Workspace app's repository. Merge them with: git merge "+got.Branch {
		t.Fatalf("events = %v", events)
	}
	if again := shown.delivered(got); len(again) != 0 {
		t.Fatalf("said twice: %v", again)
	}
	// Nothing changed, still running, or no delivery: nothing to say.
	for _, other := range []*v2.Task{
		{TagId: "lead", SessionId: "5f0c", State: v2.TaskState_TASK_STATE_SUCCEEDED,
			WorkspaceDelivery: &v2.WorkspaceDeliveryReference{BaseCommit: "a", HeadCommit: "a"}},
		{TagId: "lead", SessionId: "5f0c", State: v2.TaskState_TASK_STATE_RUNNING,
			WorkspaceDelivery: &v2.WorkspaceDeliveryReference{BaseCommit: "a", HeadCommit: "b"}},
		{TagId: "lead", SessionId: "5f0c", State: v2.TaskState_TASK_STATE_SUCCEEDED},
	} {
		if d := delivery(other); d != nil {
			t.Fatalf("delivery(%v) = %v", other, d)
		}
	}
	task.Workspace.Remote = &v2.Workspace{WorkspaceId: "app", Remote: "https://example.com/app.git"}
	if remote := delivery(task); remote == nil || !remote.Remote ||
		!strings.Contains(DeliveryText(remote), "git fetch origin "+remote.Branch) {
		t.Fatalf("remote delivery = %v", remote)
	}
}

func TestASessionsBranchIsSaidOnceUnderItsLatestDeliveringTurn(t *testing.T) {
	branch := SessionBranch("lead", "5f0c")
	turn := func(id, head string) *views.Message {
		return &views.Message{TaskId: id, Tag: "lead", SessionId: "5f0c", Status: views.ReplyStatus_REPLY_STATUS_REPLIED,
			Reply:    &views.Reply{Text: "Done " + id},
			Delivery: &views.Delivery{Branch: branch, Head: head, Workspace: "app"}}
	}
	// Newest first, as ListMessages returns them.
	items := History("lead", []*views.Message{turn("third", "c"), turn("second", "b"), turn("first", "a")})
	said := map[string]int{}
	for _, item := range items {
		for _, event := range item.Events {
			if event.Kind == EventDelivered {
				said[item.Message.GetTaskId()]++
			}
		}
	}
	if len(said) != 1 || said["third"] != 1 {
		t.Fatalf("delivery notes = %v", said)
	}
}
