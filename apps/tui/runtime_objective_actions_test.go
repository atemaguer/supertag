package main

import (
	"strings"
	"testing"

	"github.com/atemaguer/supertag/apps/tui/views"
)

func TestRuntimeObjectiveShowsItsAllowedActionsAndExplicitEmpty(t *testing.T) {
	view := &views.ObjectiveOverview{Objective: &views.Objective{Id: "release", OwnerTag: "owner", RuntimeActions: []string{"files:read", "commands:execute"}}, Budget: &views.ObjectiveBudgetUse{}}
	if text := describeRuntimeObjective(view, ""); !strings.Contains(text, "Allowed actions: files:read, commands:execute") {
		t.Fatalf("Objective action ceiling missing:\n%s", text)
	}
	view.Objective.RuntimeActions = nil
	if text := describeRuntimeObjective(view, ""); !strings.Contains(text, "Allowed actions: none") {
		t.Fatalf("empty ceiling not visible:\n%s", text)
	}
}

func TestRuntimeObjectiveShowsPendingAndRecordedCommitReviews(t *testing.T) {
	view := &views.ObjectiveOverview{
		Objective: &views.Objective{Id: "release", OwnerTag: "owner"}, Budget: &views.ObjectiveBudgetUse{},
		CommitReviews: []*views.ObjectiveCommitReview{
			{Commit: "first", ReviewerTagId: "reviewer"},
			{Commit: "second", ReviewerTagId: "reviewer", Verdict: "changes_requested", Summary: "Add a regression test"},
		},
	}
	text := describeRuntimeObjective(view, "")
	for _, expected := range []string{"Commit reviews:", "first · reviewer · pending", "second · reviewer · changes requested · Add a regression test"} {
		if !strings.Contains(text, expected) {
			t.Fatalf("missing %q:\n%s", expected, text)
		}
	}
}
