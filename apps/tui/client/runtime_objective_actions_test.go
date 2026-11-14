package client

import (
	"context"
	"net/http"
	"slices"
	"testing"
	"time"

	v2 "github.com/atemaguer/supertag/rust/bindings/go/runtimev2"
	rpc "github.com/atemaguer/supertag/rust/bindings/go/runtimev2/runtimev2connect"
)

func TestRuntimeObjectiveActionCeilingAppearsInOperatorProjection(t *testing.T) {
	mux := http.NewServeMux()
	objective := &v2.Objective{ObjectiveId: "release", OwnerTagId: "owner", SessionId: "objective/release", RuntimeActions: &v2.RuntimeActions{Actions: []string{"files:read", "commands:execute"}}}
	testRPC(mux, rpc.ObjectivesGetObjectiveProcedure, func(_ context.Context, request *v2.GetObjectiveRequest) (*v2.Objective, error) {
		if request.GetObjectiveId() != "release" {
			t.Errorf("Objective scope: %v", request)
		}
		return objective, nil
	})
	testRPC(mux, rpc.ObjectivesListCommitReviewsProcedure, func(_ context.Context, request *v2.ListObjectiveCommitReviewsRequest) (*v2.ListObjectiveCommitReviewsResponse, error) {
		if request.GetObjectiveId() != "release" || request.GetLimit() == 0 {
			t.Errorf("Commit review scope: %v", request)
		}
		if request.GetBeforeOrder() == 0 {
			return &v2.ListObjectiveCommitReviewsResponse{NextBeforeOrder: 10, Reviews: []*v2.CommitReview{
				{RequestId: "pending", ObjectiveId: "release", ReviewerTagId: "reviewer", Commit: "first"},
			}}, nil
		}
		if request.GetBeforeOrder() != 10 || request.GetLimit() != 49 {
			t.Errorf("Commit review page: %v", request)
		}
		return &v2.ListObjectiveCommitReviewsResponse{Reviews: []*v2.CommitReview{
			{RequestId: "done", ObjectiveId: "release", ReviewerTagId: "reviewer", Commit: "second", Verdict: &v2.CommitReviewVerdict{
				Decision: v2.CommitReviewDecision_COMMIT_REVIEW_DECISION_CHANGES_REQUESTED, Summary: "Add the regression test", RecordedAtMs: 1200,
			}},
		}}, nil
	})
	c := testRuntime(t, mux, false)
	view, err := c.DescribeObjective(t.Context(), "release")
	if err != nil || !slices.Equal(view.GetObjective().GetRuntimeActions(), []string{"files:read", "commands:execute"}) {
		t.Fatalf("Objective actions: %v, %v", view, err)
	}
	reviews := view.GetCommitReviews()
	if len(reviews) != 2 || reviews[0].GetRequestId() != "pending" || reviews[0].GetVerdict() != "" ||
		reviews[1].GetCommit() != "second" || reviews[1].GetVerdict() != "changes_requested" ||
		reviews[1].GetSummary() != "Add the regression test" || !reviews[1].GetRecordedAt().AsTime().Equal(time.UnixMilli(1200)) {
		t.Fatalf("Commit review projection: %v", reviews)
	}
	projected := runtimeObjective(objective)
	objective.RuntimeActions.Actions[0] = "files:write"
	if projected.RuntimeActions[0] != "files:read" {
		t.Fatal("projection shares the mutable wire action slice")
	}
}
