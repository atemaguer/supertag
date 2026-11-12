package client

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
	v2 "github.com/atemaguer/supertag/rust/bindings/go/runtimev2"
	rpc "github.com/atemaguer/supertag/rust/bindings/go/runtimev2/runtimev2connect"
)

func TestRuntimeV2ApprovalInboxAndDecisions(t *testing.T) {
	mux := http.NewServeMux()
	testRPC(mux, rpc.InboxListItemsProcedure, func(_ context.Context, _ *v2.ListInboxItemsRequest) (*v2.ListInboxItemsResponse, error) {
		return &v2.ListInboxItemsResponse{Items: []*v2.InboxItem{
			{Key: "approval:allowed", Occurrence: "approval:allowed:1", TaskId: "task", ObjectiveId: "release",
				Kind: v2.InboxItemKind_INBOX_ITEM_KIND_APPROVAL, OperatorEligible: true,
				Approval: &v2.InboxApproval{ApprovalId: "allowed", TagId: "lead", Action: "git:push", Resource: "refs/heads/main", Summary: "Publish changes"}},
			{Key: "approval:ineligible", Kind: v2.InboxItemKind_INBOX_ITEM_KIND_APPROVAL,
				Approval: &v2.InboxApproval{ApprovalId: "ineligible"}},
		}}, nil
	})
	testRPC(mux, rpc.InboxGetApprovalProcedure, func(_ context.Context, req *v2.GetApprovalRequest) (*v2.Approval, error) {
		if req.GetApprovalId() != "allowed" {
			t.Errorf("detail request = %v", req)
		}
		return &v2.Approval{
			ApprovalId: "allowed", State: v2.ApprovalState_APPROVAL_STATE_PENDING,
			Action: "git:push", Resource: "refs/heads/main", CanonicalArgumentsJson: `{"branch":"main","force":false}`,
		}, nil
	})
	var operation string
	var calls int
	testRPC(mux, rpc.InboxDecideApprovalProcedure, func(_ context.Context, req *v2.DecideApprovalRequest) (*v2.Approval, error) {
		if req.GetOperationId() == "" || req.ValidUntilMs != nil {
			t.Errorf("decision = %v", req)
		}
		switch req.GetApprovalId() {
		case "allowed":
			if !req.GetApprove() || req.GetScope() != v2.ApprovalScope_APPROVAL_SCOPE_ONCE || req.GetReason() != "" {
				t.Errorf("approve = %v", req)
			}
			calls++
			if calls == 1 {
				operation = req.GetOperationId()
				return nil, connect.NewError(connect.CodeUnavailable, fmt.Errorf("lost first receipt"))
			}
			if req.GetOperationId() != operation {
				t.Errorf("approve retry changed operation ID")
			}
			return &v2.Approval{ApprovalId: "allowed", State: v2.ApprovalState_APPROVAL_STATE_APPROVED,
				Scope: v2.ApprovalScope_APPROVAL_SCOPE_ONCE}, nil
		case "decline":
			if req.GetApprove() || req.GetScope() != v2.ApprovalScope_APPROVAL_SCOPE_UNSPECIFIED ||
				req.GetReason() != "Use a release branch" || req.GetOperationId() == operation {
				t.Errorf("deny = %v", req)
			}
			return &v2.Approval{ApprovalId: "decline", State: v2.ApprovalState_APPROVAL_STATE_DENIED,
				Reason: proto.String(req.GetReason())}, nil
		default:
			return nil, fmt.Errorf("unexpected approval ID %q", req.GetApprovalId())
		}
	})
	c := testRuntime(t, mux, false)
	ctx := t.Context()
	inbox, err := c.ListInbox(ctx)
	if err != nil || len(inbox.Items) != 1 {
		t.Fatalf("ListInbox() = %+v, %v", inbox, err)
	}
	item := inbox.Items[0]
	approval := item.GetApproval()
	if item.GetKind() != operatorv1.InboxItemKind_INBOX_ITEM_KIND_APPROVAL ||
		!item.GetOperatorEligible() || approval.GetRequestId() != "allowed" ||
		approval.GetRequestingTag() != "lead" || approval.GetTaskId() != "task" ||
		!strings.Contains(approval.GetSummary(), "git:push") ||
		!strings.Contains(approval.GetSummary(), "refs/heads/main") {
		t.Fatalf("approval projection = %v", item)
	}
	details, err := c.ReadApproval(ctx, approval.GetRequestId())
	if err != nil || !details.Pending || details.Action != "git:push" ||
		details.Resource != "refs/heads/main" || !strings.Contains(details.Arguments, `"force": false`) {
		t.Fatalf("ReadApproval() = %+v, %v", details, err)
	}
	approved, err := c.Approve(ctx, approval.GetRequestId())
	if err != nil || approved.GetStatus() != operatorv1.ApprovalStatus_APPROVAL_STATUS_APPROVED ||
		approved.GetScope() != operatorv1.ApprovalScope_APPROVAL_SCOPE_ONCE || calls != 2 {
		t.Fatalf("Approve() = %v, %v in %d calls", approved, err, calls)
	}
	denied, err := c.Deny(ctx, "decline", "Use a release branch")
	if err != nil || denied.GetStatus() != operatorv1.ApprovalStatus_APPROVAL_STATUS_DENIED ||
		denied.GetReason() != "Use a release branch" {
		t.Fatalf("Deny() = %v, %v", denied, err)
	}
}

func TestRuntimeV2InboxPagingAndAnswerRetry(t *testing.T) {
	mux := http.NewServeMux()
	testRPC(mux, rpc.InboxListItemsProcedure, func(_ context.Context, req *v2.ListInboxItemsRequest) (*v2.ListInboxItemsResponse, error) {
		switch req.GetCursor() {
		case "":
			return &v2.ListInboxItemsResponse{
				Items: []*v2.InboxItem{{
					Key: "question:task", Occurrence: "question:task:attempt", TaskId: "task",
					Kind: v2.InboxItemKind_INBOX_ITEM_KIND_QUESTION, ObjectiveId: "release",
					OperatorEligible: true, ActionableSinceMs: 1700000000000,
					Question: &v2.InboxQuestion{Text: "Which branch?", AskedAtMs: 1700000000000, Truncated: true},
				}, {Key: "private", OperatorEligible: false}},
				NextCursor: "after-question",
			}, nil
		case "after-question":
			return &v2.ListInboxItemsResponse{
				Items: []*v2.InboxItem{{
					Key: "limit:release", Kind: v2.InboxItemKind_INBOX_ITEM_KIND_OBJECTIVE_LIMIT,
					ObjectiveId: "release", OperatorEligible: true, Reason: "Deadline reached",
				}},
				TruncatedKinds: []v2.InboxItemKind{v2.InboxItemKind_INBOX_ITEM_KIND_TASK_ATTENTION},
			}, nil
		default:
			return nil, fmt.Errorf("unexpected Inbox cursor %q", req.GetCursor())
		}
	})
	testRPC(mux, rpc.InboxGetQuestionProcedure, func(_ context.Context, req *v2.GetQuestionRequest) (*v2.ObjectiveQuestion, error) {
		if req.GetTaskId() != "task" {
			t.Errorf("full question request = %v", req)
		}
		return &v2.ObjectiveQuestion{TaskId: "task", Text: "Which branch? Include the release tag."}, nil
	})
	var operation string
	var calls int
	testRPC(mux, rpc.InboxAnswerQuestionProcedure, func(_ context.Context, req *v2.AnswerQuestionRequest) (*v2.Task, error) {
		if req.GetTaskId() != "task" || req.GetText() != "main" || req.GetOperationId() == "" {
			t.Errorf("answer = %v", req)
		}
		calls++
		if calls == 1 {
			operation = req.GetOperationId()
			return nil, connect.NewError(connect.CodeUnavailable, fmt.Errorf("lost first receipt"))
		}
		if req.GetOperationId() != operation {
			t.Errorf("retry changed operation from %q to %q", operation, req.GetOperationId())
		}
		return &v2.Task{TaskId: "answer", TagId: "engineer"}, nil
	})

	c := testRuntime(t, mux, false)
	inbox, err := c.ListInbox(context.Background())
	if err != nil || len(inbox.Items) != 2 || !inbox.Truncated {
		t.Fatalf("ListInbox() = %+v, %v", inbox, err)
	}
	item := inbox.Items[0]
	if item.GetKind() != operatorv1.InboxItemKind_INBOX_ITEM_KIND_QUESTION ||
		item.GetQuestion().GetText() != "Which branch?" || !item.GetQuestion().GetTruncated() ||
		item.GetEvidence()[0].GetTask().GetId() != "task" ||
		item.GetActionableSince().GetSeconds() != 1700000000 {
		t.Errorf("mapped question = %v", item)
	}
	full, err := c.ReadObjectiveQuestion(context.Background(), item.GetKey())
	if err != nil || full != "Which branch? Include the release tag." {
		t.Fatalf("ReadObjectiveQuestion() = %q, %v", full, err)
	}
	answer, err := c.AnswerQuestion(context.Background(), item.GetKey(), "main")
	if err != nil || answer.GetTaskId() != "answer" || answer.GetTag() != "engineer" || calls != 2 {
		t.Fatalf("AnswerQuestion() = %v, %v in %d calls", answer, err, calls)
	}
}
