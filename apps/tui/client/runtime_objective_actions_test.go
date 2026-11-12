package client

import (
	"context"
	"net/http"
	"slices"
	"testing"

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
	c := testRuntime(t, mux, false)
	view, err := c.DescribeObjective(t.Context(), "release")
	if err != nil || !slices.Equal(view.GetObjective().GetRuntimeActions(), []string{"files:read", "commands:execute"}) {
		t.Fatalf("Objective actions: %v, %v", view, err)
	}
	projected := runtimeObjective(objective)
	objective.RuntimeActions.Actions[0] = "files:write"
	if projected.RuntimeActions[0] != "files:read" {
		t.Fatal("projection shares the mutable wire action slice")
	}
}
