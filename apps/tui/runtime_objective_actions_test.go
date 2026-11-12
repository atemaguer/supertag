package main

import (
	"strings"
	"testing"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
)

func TestRuntimeObjectiveShowsItsAllowedActionsAndExplicitEmpty(t *testing.T) {
	view := &operatorv1.ObjectiveOverview{Objective: &operatorv1.Objective{Id: "release", OwnerTag: "owner", RuntimeActions: []string{"files:read", "commands:execute"}}, Budget: &operatorv1.ObjectiveBudgetUse{}}
	if text := describeRuntimeObjective(view, ""); !strings.Contains(text, "Allowed actions: files:read, commands:execute") {
		t.Fatalf("Objective action ceiling missing:\n%s", text)
	}
	view.Objective.RuntimeActions = nil
	if text := describeRuntimeObjective(view, ""); !strings.Contains(text, "Allowed actions: none") {
		t.Fatalf("empty ceiling not visible:\n%s", text)
	}
}
