package client

import (
	"context"
	"errors"
	"testing"

	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1/operatorv1connect"
)

func TestListOpenObjectivesPagesAndLeavesOutClosedOnes(t *testing.T) {
	var tokens []string
	f := &fakeControlPlane{objectives: func(req *operatorv1.ListObjectivesRequest) (*operatorv1.ListObjectivesResponse, error) {
		tokens = append(tokens, req.GetPageToken())
		if req.GetPageToken() == "" {
			return &operatorv1.ListObjectivesResponse{NextPageToken: "p2", Objectives: []*operatorv1.Objective{
				{Id: "a", Status: operatorv1.ObjectiveStatus_OBJECTIVE_STATUS_WORKING},
				{Id: "b", Status: operatorv1.ObjectiveStatus_OBJECTIVE_STATUS_COMPLETED},
			}}, nil
		}
		return &operatorv1.ListObjectivesResponse{Objectives: []*operatorv1.Objective{
			{Id: "c", Status: operatorv1.ObjectiveStatus_OBJECTIVE_STATUS_BLOCKED},
			{Id: "d", Status: operatorv1.ObjectiveStatus_OBJECTIVE_STATUS_CANCELLED},
		}}, nil
	}}
	c := newFake(t, f)
	open, err := c.ListOpenObjectives(context.Background())
	if err != nil || len(open) != 2 || open[0].GetId() != "a" || open[1].GetId() != "c" {
		t.Fatalf("ListOpenObjectives() = %v, %v", open, err)
	}
	if len(tokens) != 2 || tokens[1] != "p2" {
		t.Fatalf("page tokens = %v", tokens)
	}
	for _, call := range f.callsTo(operatorv1connect.ObjectiveServiceListObjectivesProcedure) {
		if call.authorization != "Bearer secret" || call.contentType != "application/json" {
			t.Errorf("call = %+v", call)
		}
	}
}

func TestDescribeObjectiveAsksForTheSmallestTaskPage(t *testing.T) {
	f := &fakeControlPlane{describe: func(req *operatorv1.DescribeObjectiveRequest) (*operatorv1.ObjectiveOverview, error) {
		if req.GetId() != "obj-1" || req.GetPageSize() != 1 {
			t.Errorf("request = %v", req)
		}
		return &operatorv1.ObjectiveOverview{Objective: &operatorv1.Objective{Id: "obj-1"}}, nil
	}}
	view, err := newFake(t, f).DescribeObjective(context.Background(), "obj-1")
	if err != nil || view.GetObjective().GetId() != "obj-1" {
		t.Fatalf("DescribeObjective() = %v, %v", view, err)
	}
	f.describe = func(*operatorv1.DescribeObjectiveRequest) (*operatorv1.ObjectiveOverview, error) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("Objective obj-2 was not found"))
	}
	var apiErr *APIError
	if _, err := newFake(t, f).DescribeObjective(context.Background(), "obj-2"); !errors.As(err, &apiErr) || apiErr.Code != connect.CodeNotFound ||
		apiErr.Message != "Objective obj-2 was not found" {
		t.Fatalf("err = %v", err)
	}
}

func TestListInboxKeepsWhatAnOperatorDecides(t *testing.T) {
	f := &fakeControlPlane{inbox: func(req *operatorv1.ListInboxItemsRequest) (*operatorv1.ListInboxItemsResponse, error) {
		if req.GetPageToken() == "" {
			return &operatorv1.ListInboxItemsResponse{NextPageToken: "n", TagNames: map[string]string{"t1": "lead"}, Items: []*operatorv1.InboxItem{
				{Key: "approval:a", OperatorEligible: true},
				{Key: "question:x", OperatorEligible: false},
			}}, nil
		}
		return &operatorv1.ListInboxItemsResponse{TagNames: map[string]string{"t2": "builder"},
			TruncatedKinds: []operatorv1.InboxItemKind{operatorv1.InboxItemKind_INBOX_ITEM_KIND_TASK_ATTENTION},
			Items:          []*operatorv1.InboxItem{{Key: "question:y", OperatorEligible: true}}}, nil
	}}
	inbox, err := newFake(t, f).ListInbox(context.Background())
	if err != nil || len(inbox.Items) != 2 || inbox.Items[0].GetKey() != "approval:a" || inbox.Items[1].GetKey() != "question:y" {
		t.Fatalf("ListInbox() = %+v, %v", inbox, err)
	}
	if inbox.TagNames["t1"] != "lead" || inbox.TagNames["t2"] != "builder" || !inbox.Truncated {
		t.Fatalf("inbox = %+v", inbox)
	}
}

func TestDecisionsAreNotRetried(t *testing.T) {
	approves, denies := 0, 0
	f := &fakeControlPlane{
		approve: func(req *operatorv1.ApproveRequest) (*operatorv1.Approval, error) {
			approves++
			if req.GetId() != "apr-1" || req.GetScope() != operatorv1.ApprovalScope_APPROVAL_SCOPE_ONCE {
				t.Errorf("approve = %v", req)
			}
			return nil, connect.NewError(connect.CodeUnavailable, errors.New("restarting"))
		},
		deny: func(req *operatorv1.DenyRequest) (*operatorv1.Approval, error) {
			denies++
			if req.GetId() != "apr-1" || req.GetReason() != "no" {
				t.Errorf("deny = %v", req)
			}
			return &operatorv1.Approval{Id: "apr-1", Status: operatorv1.ApprovalStatus_APPROVAL_STATUS_DENIED}, nil
		},
	}
	c := newFake(t, f)
	if _, err := c.Approve(context.Background(), "apr-1"); err == nil || err.Error() != "restarting" || approves != 1 {
		t.Fatalf("Approve() err = %v after %d calls", err, approves)
	}
	if approval, err := c.Deny(context.Background(), "apr-1", "no"); err != nil || approval.GetStatus() != operatorv1.ApprovalStatus_APPROVAL_STATUS_DENIED || denies != 1 {
		t.Fatalf("Deny() = %v, %v", approval, err)
	}
}

func TestAnswerQuestionRetriesWithTheSameIdempotencyKey(t *testing.T) {
	var requests []*operatorv1.AnswerQuestionRequest
	f := &fakeControlPlane{answer: func(req *operatorv1.AnswerQuestionRequest) (*operatorv1.MessageObjectiveResponse, error) {
		requests = append(requests, req)
		if len(requests) == 1 {
			return nil, connect.NewError(connect.CodeUnavailable, errors.New("restarting"))
		}
		return &operatorv1.MessageObjectiveResponse{TaskId: "t9", Tag: "lead"}, nil
	}}
	res, err := newFake(t, f).AnswerQuestion(context.Background(), "question:t1", "Cap it.")
	if err != nil || res.GetTaskId() != "t9" {
		t.Fatalf("AnswerQuestion() = %v, %v", res, err)
	}
	if len(requests) != 2 || requests[0].GetKey() != "question:t1" || requests[0].GetText() != "Cap it." || requests[0].GetIdempotencyKey() == "" ||
		requests[1].GetIdempotencyKey() != requests[0].GetIdempotencyKey() {
		t.Fatalf("requests = %v", requests)
	}

	f.answer = func(*operatorv1.AnswerQuestionRequest) (*operatorv1.MessageObjectiveResponse, error) {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("The question no longer waits on an answer."))
	}
	if _, err := newFake(t, f).AnswerQuestion(context.Background(), "question:t1", "Cap it."); err == nil || err.Error() != "The question no longer waits on an answer." {
		t.Fatalf("err = %v", err)
	}
}
