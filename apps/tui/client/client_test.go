package client

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1/operatorv1connect"
)

func tagResource(name string) *operatorv1.Resource {
	return &operatorv1.Resource{Resource: &operatorv1.Resource_Tag{Tag: &operatorv1.Tag{
		Metadata: &operatorv1.Metadata{Name: name}, Status: &operatorv1.TagStatus{Phase: operatorv1.TagPhase_TAG_PHASE_ACTIVE},
	}}}
}

func TestListTagsReadsEveryPageOfTagResources(t *testing.T) {
	var requests []*operatorv1.ListResourcesRequest
	f := &fakeControlPlane{resources: func(req *operatorv1.ListResourcesRequest) (*operatorv1.ListResourcesResponse, error) {
		requests = append(requests, req)
		if req.GetPageToken() == "" {
			return &operatorv1.ListResourcesResponse{Resources: []*operatorv1.Resource{tagResource("builder")}, NextPageToken: "p2"}, nil
		}
		return &operatorv1.ListResourcesResponse{Resources: []*operatorv1.Resource{tagResource("lead"), {}}}, nil
	}}
	c := newFake(t, f)
	tags, err := c.ListTags(context.Background())
	if err != nil || len(tags) != 2 || tags[0].GetMetadata().GetName() != "builder" || tags[1].GetMetadata().GetName() != "lead" ||
		tags[1].GetStatus().GetPhase() != operatorv1.TagPhase_TAG_PHASE_ACTIVE {
		t.Fatalf("ListTags() = %v, %v", tags, err)
	}
	if len(requests) != 2 || requests[0].GetKind() != operatorv1.ResourceKind_RESOURCE_KIND_TAG || requests[0].GetManifest() || requests[1].GetPageToken() != "p2" {
		t.Fatalf("requests = %v", requests)
	}
	calls := f.callsTo(operatorv1connect.ResourceServiceListResourcesProcedure)
	if len(calls) != 2 || calls[0].authorization != "Bearer secret" || calls[0].version != "0.0.0-test" || calls[0].contentType != "application/json" {
		t.Fatalf("calls = %+v", calls)
	}
}

func TestCreateObjectiveIsSentOnce(t *testing.T) {
	var requests []*operatorv1.CreateObjectiveRequest
	f := &fakeControlPlane{create: func(req *operatorv1.CreateObjectiveRequest) (*operatorv1.CreateObjectiveResponse, error) {
		requests = append(requests, req)
		if len(requests) == 1 {
			return &operatorv1.CreateObjectiveResponse{Objective: &operatorv1.Objective{Id: "ship-sso-7f3k"}, Warnings: []string{"No Worker Host is connected."}}, nil
		}
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("restarting"))
	}}
	c := newFake(t, f)
	res, err := c.CreateObjective(context.Background(), NewObjective{Outcome: "Ship SSO", Owner: "lead", Team: "billing",
		Budget: &operatorv1.Budget{LimitMinor: 30000, Currency: "USD"}})
	if err != nil || res.GetObjective().GetId() != "ship-sso-7f3k" || len(res.GetWarnings()) != 1 {
		t.Fatalf("CreateObjective() = %v, %v", res, err)
	}
	got := requests[0]
	if got.GetOutcome() != "Ship SSO" || got.GetOwner() != "lead" || got.GetTeam() != "billing" || got.GetId() != "" ||
		got.GetBudget().GetLimitMinor() != 30000 || got.GetBudget().GetCurrency() != "USD" || got.GetDryRun() {
		t.Fatalf("request = %v", got)
	}
	var apiErr *APIError
	if _, err := c.CreateObjective(context.Background(), NewObjective{Outcome: "x", Owner: "lead"}); !errors.As(err, &apiErr) || apiErr.Code != connect.CodeUnavailable {
		t.Fatalf("CreateObjective() error = %v", err)
	}
	if len(requests) != 2 {
		t.Fatalf("%d requests, want no retry", len(requests))
	}
}

func TestSendMessageRetriesWithTheSameIdempotencyKey(t *testing.T) {
	var requests []*operatorv1.SendMessageRequest
	f := &fakeControlPlane{send: func(req *operatorv1.SendMessageRequest) (*operatorv1.Message, error) {
		requests = append(requests, req)
		if len(requests) == 1 {
			return nil, connect.NewError(connect.CodeUnavailable, errors.New("restarting"))
		}
		return &operatorv1.Message{TaskId: "t1", Tag: req.GetTag(), Conversation: "default",
			Status: operatorv1.ReplyStatus_REPLY_STATUS_WAITING, WaitingReason: "no bound Worker Host"}, nil
	}}
	c := newFake(t, f)
	message, err := c.SendMessage(context.Background(), "a/b", "default", "hello")
	if err != nil || message.GetTaskId() != "t1" || message.GetWaitingReason() != "no bound Worker Host" {
		t.Fatalf("SendMessage() = %v, %v", message, err)
	}
	if len(requests) != 2 {
		t.Fatalf("%d requests, want a retry", len(requests))
	}
	first := requests[0]
	if first.GetTag() != "a/b" || first.GetConversation() != "default" || first.GetText() != "hello" || first.GetIdempotencyKey() == "" {
		t.Fatalf("request = %v", first)
	}
	if requests[1].GetIdempotencyKey() != first.GetIdempotencyKey() {
		t.Fatal("the retry must reuse the idempotency key")
	}
	for _, call := range f.callsTo(operatorv1connect.ConversationServiceSendMessageProcedure) {
		if call.authorization != "Bearer secret" || call.version != "0.0.0-test" || call.contentType != "application/json" || call.protoMajor != 1 {
			t.Errorf("call = %+v, want the token, version and Connect JSON over HTTP/1.1", call)
		}
	}
}

func TestRefusalsCarryTheControlPlaneSentence(t *testing.T) {
	sends := 0
	f := &fakeControlPlane{
		send: func(*operatorv1.SendMessageRequest) (*operatorv1.Message, error) {
			sends++
			return nil, connect.NewError(connect.CodeNotFound, errors.New("Tag ghost was not found"))
		},
		resources: func(*operatorv1.ListResourcesRequest) (*operatorv1.ListResourcesResponse, error) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("This credential cannot read resources."))
		},
	}
	c := newFake(t, f)
	var apiErr *APIError
	if _, err := c.SendMessage(context.Background(), "ghost", "", "hi"); !errors.As(err, &apiErr) ||
		apiErr.Code != connect.CodeNotFound || err.Error() != "Tag ghost was not found" {
		t.Fatalf("SendMessage() error = %v", err)
	}
	if sends != 1 {
		t.Fatalf("a refusal was sent %d times", sends)
	}
	if _, err := c.ListTags(context.Background()); !errors.As(err, &apiErr) || apiErr.Code != connect.CodePermissionDenied ||
		err.Error() != "This credential cannot read resources." {
		t.Fatalf("ListTags() error = %v", err)
	}

	bad, err := New(Target{URL: c.Target().URL, Token: "wrong"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := bad.ListMessages(context.Background(), "lead", "default", 0, ""); !errors.As(err, &apiErr) || apiErr.Code != connect.CodeUnauthenticated {
		t.Fatalf("ListMessages() with a bad token = %v", err)
	}
}

func TestListMessagesAndConversations(t *testing.T) {
	f := &fakeControlPlane{
		list: func(req *operatorv1.ListMessagesRequest) (*operatorv1.ListMessagesResponse, error) {
			if req.GetTag() != "lead" || req.GetConversation() != "default" || req.GetPageSize() != 20 || req.GetPageToken() != "p1" {
				t.Errorf("request = %v", req)
			}
			return &operatorv1.ListMessagesResponse{Messages: []*operatorv1.Message{{TaskId: "t2"}, {TaskId: "t1"}}, NextPageToken: "p2"}, nil
		},
		conversations: func(req *operatorv1.ListConversationsRequest) (*operatorv1.ListConversationsResponse, error) {
			if req.GetTag() == "lead" {
				return &operatorv1.ListConversationsResponse{Conversations: []*operatorv1.Conversation{{Tag: "lead", Name: "billing"}}}, nil
			}
			if req.GetPageToken() == "" {
				return &operatorv1.ListConversationsResponse{Conversations: []*operatorv1.Conversation{{Tag: "lead", Name: "default"}}, NextPageToken: "next"}, nil
			}
			return &operatorv1.ListConversationsResponse{Conversations: []*operatorv1.Conversation{{Tag: "builder", Name: "default", OpenWorkSessionCount: 2}}}, nil
		},
	}
	c := newFake(t, f)
	messages, next, err := c.ListMessages(context.Background(), "lead", "default", 20, "p1")
	if err != nil || len(messages) != 2 || messages[0].GetTaskId() != "t2" || next != "p2" {
		t.Fatalf("ListMessages() = %v, %q, %v", messages, next, err)
	}
	conversations, err := c.ListConversations(context.Background(), "")
	if err != nil || len(conversations) != 2 || conversations[1].GetOpenWorkSessionCount() != 2 {
		t.Fatalf("ListConversations() = %v, %v", conversations, err)
	}
	conversations, err = c.ListConversations(context.Background(), "lead")
	if err != nil || len(conversations) != 1 || conversations[0].GetName() != "billing" {
		t.Fatalf("ListConversations(lead) = %v, %v", conversations, err)
	}
}

func TestCallsStayOnHTTP1WhenTheServerOffersHTTP2(t *testing.T) {
	f := &fakeControlPlane{list: func(*operatorv1.ListMessagesRequest) (*operatorv1.ListMessagesResponse, error) {
		return &operatorv1.ListMessagesResponse{}, nil
	}}
	server := httptest.NewUnstartedServer(f.handler())
	server.EnableHTTP2 = true
	server.StartTLS()
	t.Cleanup(server.Close)
	c, err := New(Target{URL: server.URL, Token: "secret"}, "")
	if err != nil {
		t.Fatal(err)
	}
	c.http.Transport.(*http.Transport).TLSClientConfig = server.Client().Transport.(*http.Transport).TLSClientConfig
	if _, _, err := c.ListMessages(context.Background(), "lead", "", 0, ""); err != nil {
		t.Fatal(err)
	}
	if calls := f.callsTo(operatorv1connect.ConversationServiceListMessagesProcedure); len(calls) != 1 || calls[0].protoMajor != 1 {
		t.Fatalf("calls = %+v, want one over HTTP/1.1", calls)
	}
}

func TestNewRejectsBadURL(t *testing.T) {
	if _, err := New(Target{URL: "ftp://x", Token: "t"}, ""); err == nil {
		t.Fatal("want an error")
	}
}
