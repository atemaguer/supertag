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
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
	v2 "github.com/atemaguer/supertag/rust/bindings/go/runtimev2"
	rpc "github.com/atemaguer/supertag/rust/bindings/go/runtimev2/runtimev2connect"
)

func testRuntime(t *testing.T, handler http.Handler, secure bool) *Client {
	t.Helper()
	server, target := testGateway(t, handler, secure)
	target.URL = server.URL
	c, err := NewRuntimeV2(target, "test-version")
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
	negotiation := testNegotiation(t, []uint32{2})
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
		if r.Header.Get(protocolHeader) != "2" {
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
		if req.GetRole() != v2.ServiceRole_SERVICE_ROLE_OPERATOR || req.GetBuildVersion() != "test-version" {
			t.Errorf("negotiation request = %v", req)
		}
		for _, version := range versions {
			if slices.Contains(req.GetProtocolVersions(), version) {
				return &v2.NegotiateProtocolResponse{Role: v2.ServiceRole_SERVICE_ROLE_GATEWAY, ProtocolVersion: version, ProtocolVersions: versions, BuildVersion: "0.1.0"}, nil
			}
		}
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("incompatible SuperTag protocol: this Gateway (SuperTag 0.1.0) speaks protocol versions [1], but the connecting operator client (SuperTag test-version) offered [2]"))
	})
	return mux
}

func TestRuntimeV2RefusesAGatewayFromAnotherProtocolEpoch(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == rpc.ProtocolNegotiationNegotiateProcedure {
			testNegotiation(t, []uint32{1}).ServeHTTP(w, r)
			return
		}
		calls.Add(1)
		http.Error(w, "unexpected call", http.StatusTeapot)
	}))
	server.Config.Protocols = new(http.Protocols)
	server.Config.Protocols.SetUnencryptedHTTP2(true)
	server.Start()
	t.Cleanup(server.Close)
	c, err := NewRuntimeV2(Target{URL: server.URL, Token: "test-operator"}, "test-version")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	_, err = c.ListTags(t.Context())
	var refused *APIError
	if !errors.As(err, &refused) || refused.Code != connect.CodeFailedPrecondition ||
		refused.Message != "the SuperTag Gateway refused this operator client: incompatible SuperTag protocol: this Gateway (SuperTag 0.1.0) speaks protocol versions [1], but the connecting operator client (SuperTag test-version) offered [2]" {
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
			return &v2.ListTagsResponse{Tags: []*v2.Tag{{TagId: "lead", Name: "Engineering Lead"}}}, nil
		default:
			return nil, fmt.Errorf("unexpected Tag cursor %q", req.GetCursor())
		}
	})
	testRPC(mux, rpc.ConversationsListConversationsProcedure, func(_ context.Context, req *v2.ListConversationsRequest) (*v2.ListConversationsResponse, error) {
		if req.GetTagId() != "lead" {
			t.Errorf("conversation Tag = %q", req.GetTagId())
		}
		switch req.GetCursor() {
		case "":
			return &v2.ListConversationsResponse{Conversations: []*v2.Conversation{{
				TagId: "lead", Name: "billing", SessionId: "session-a", LatestTask: &v2.Task{
					AttemptId: proto.String("attempt"), State: v2.TaskState_TASK_STATE_SUCCEEDED, Result: proto.String("Ship it"),
				},
			}}, NextCursor: "conversations-cursor"}, nil
		case "conversations-cursor":
			return &v2.ListConversationsResponse{Conversations: []*v2.Conversation{{
				TagId: "lead", Name: "default", SessionId: "session-b", LatestTask: &v2.Task{
					Prompt: "Check it", State: v2.TaskState_TASK_STATE_SUCCEEDED, Result: proto.String("Input accepted"),
				},
			}}}, nil
		default:
			return nil, fmt.Errorf("unexpected Conversation cursor %q", req.GetCursor())
		}
	})
	var operations []string
	var mu sync.Mutex
	task := &v2.Task{TaskId: "first", TagId: "lead", SessionId: "session-a", Prompt: "Verify SSO", State: v2.TaskState_TASK_STATE_QUEUED}
	testRPC(mux, rpc.ConversationsSendMessageProcedure, func(_ context.Context, req *v2.SendMessageRequest) (*v2.ConversationMessage, error) {
		if req.GetTagId() != "lead" || req.GetConversation() != "billing" || req.GetText() != task.GetPrompt() {
			t.Errorf("SendMessage request = %v", req)
		}
		mu.Lock()
		defer mu.Unlock()
		operations = append(operations, req.GetOperationId())
		if len(operations) == 1 {
			return nil, connect.NewError(connect.CodeUnavailable, errors.New("first reply was lost"))
		}
		return &v2.ConversationMessage{Task: task, Conversation: "billing"}, nil
	})
	testRPC(mux, rpc.ConversationsListMessagesProcedure, func(_ context.Context, req *v2.ListMessagesRequest) (*v2.ListMessagesResponse, error) {
		if req.GetTagId() != "lead" || req.GetConversation() != "billing" || req.GetCursor() != "message-cursor" || req.GetLimit() != 10 {
			t.Errorf("ListMessages request = %v", req)
		}
		return &v2.ListMessagesResponse{Messages: []*v2.ConversationMessage{{
			Task: task, Conversation: "billing",
		}}, NextCursor: "more-messages"}, nil
	})
	c := testRuntime(t, mux, false)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tags, err := c.ListTags(ctx)
	if err != nil || len(tags) != 2 || tags[0].GetMetadata().GetName() != "build" ||
		tags[1].GetMetadata().GetId() != "lead" || tags[1].GetMetadata().GetName() != "Engineering Lead" {
		t.Fatalf("ListTags = %v, %v", tags, err)
	}
	conversations, err := c.ListConversations(ctx, "lead")
	if err != nil || len(conversations) != 2 || conversations[0].GetLastMessageText() != "Ship it" ||
		conversations[1].GetLastMessageText() != "Check it" ||
		conversations[1].GetLastMessageAuthor() != operatorv1.ConversationAuthor_CONVERSATION_AUTHOR_OPERATOR {
		t.Fatalf("ListConversations = %v, %v", conversations, err)
	}
	sent, err := c.SendMessage(ctx, "lead", "billing", "Verify SSO")
	if err != nil || sent.GetTaskId() != "first" || sent.GetWaitingReason() != "Task queued." {
		t.Fatalf("SendMessage = %v, %v", sent, err)
	}
	mu.Lock()
	keys := slices.Clone(operations)
	mu.Unlock()
	if len(keys) != 2 || keys[0] == "" || keys[0] != keys[1] {
		t.Fatalf("send retry operation IDs = %v", keys)
	}
	page, next, err := c.ListMessages(ctx, "lead", "billing", 10, "message-cursor")
	if err != nil || next != "more-messages" || len(page) != 1 || page[0].GetText() != "Verify SSO" {
		t.Fatalf("ListMessages = %v, %q, %v", page, next, err)
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
		return &v2.ConversationMessage{Task: task, Conversation: "default"}, nil
	})
	var cursors []uint64
	var mu sync.Mutex
	testRPC(mux, rpc.ConversationsListMessageEventsProcedure, func(_ context.Context, req *v2.ListMessageEventsRequest) (*v2.ListEventsResponse, error) {
		if req.GetTagId() != "lead" || req.GetTaskId() != "t1" || req.GetLimit() != runtimeEventPage {
			t.Errorf("ListMessageEvents request = %v", req)
		}
		mu.Lock()
		defer mu.Unlock()
		cursors = append(cursors, req.GetAfterSequence())
		switch len(cursors) {
		case 1:
			events := make([]*v2.TaskEvent, runtimeEventPage)
			for i := range events {
				events[i] = &v2.TaskEvent{Sequence: uint64(i + 1), Text: fmt.Sprintf("piece %d", i+1)}
			}
			return &v2.ListEventsResponse{Events: events}, nil
		case 2:
			settled.Store(true)
			return nil, connect.NewError(connect.CodeUnavailable, errors.New("Gateway restarted"))
		case 3:
			return &v2.ListEventsResponse{Events: []*v2.TaskEvent{{Sequence: runtimeEventPage + 1, Text: "last piece"}}}, nil
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
		want = append(want, fmt.Sprintf("delta piece %d", i))
	}
	expect(t, events, append(want, "delta last piece", "reply done")...)
	mu.Lock()
	defer mu.Unlock()
	if !slices.Equal(cursors, []uint64{0, runtimeEventPage, runtimeEventPage}) {
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
			}
			return msg, nil
		default:
			return nil, connect.NewError(connect.CodeNotFound, errors.New("unexpected Task"))
		}
	})
	testRPC(mux, rpc.ConversationsListMessageEventsProcedure, func(_ context.Context, req *v2.ListMessageEventsRequest) (*v2.ListEventsResponse, error) {
		if req.GetTaskId() != "follower" || req.GetAfterSequence() != 0 {
			t.Errorf("ListMessageEvents request = %v", req)
		}
		return &v2.ListEventsResponse{Events: []*v2.TaskEvent{{Sequence: 1, Text: "own event"}}}, nil
	})
	c := testRuntime(t, mux, false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	follower, err := c.GetMessage(ctx, "lead", "follower")
	if err != nil {
		t.Fatal(err)
	}
	history := History("lead", []*operatorv1.Message{follower, message("original")})
	if len(history) != 2 || !history[1].Follow {
		t.Fatalf("joined history = %v", history)
	}
	expect(t, history[1].Events, "joined")
	expect(t, collect(t, testFollower(c).Follow(ctx, "lead", follower, history[1].Shown)), "delta own event", "reply own reply")
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
		open[0].GetStatus() != operatorv1.ObjectiveStatus_OBJECTIVE_STATUS_READY_FOR_REVIEW {
		t.Fatalf("ListOpenObjectives = %v, %v", open, err)
	}
	created, err := c.CreateObjective(ctx, NewObjective{ID: "sso", Owner: "lead", Outcome: "Verify SSO", Team: "Release team", Budget: &operatorv1.Budget{
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
	expect(t, collect(t, testFollower(c).FollowObjective(ctx, sent.GetTag(), msg)), "reply Verified")
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
		if _, err := NewRuntimeV2(target, "test-version"); err == nil {
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
