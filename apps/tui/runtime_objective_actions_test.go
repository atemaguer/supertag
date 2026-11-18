package main

import (
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/atemaguer/supertag/apps/tui/client"
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

// An idle Objective says since when, under its outcome; a busy one says nothing of it.
func TestRuntimeObjectiveSaysSinceWhenItIsIdle(t *testing.T) {
	view := &views.ObjectiveOverview{Objective: &views.Objective{Id: "ship", Outcome: "Ship it",
		Status: views.ObjectiveStatus_OBJECTIVE_STATUS_WORKING, IdleSince: timestamppb.New(time.Now())}, Budget: &views.ObjectiveBudgetUse{}}
	if text := describeRuntimeObjective(view, ""); !strings.Contains(text, "Idle since Today ") {
		t.Fatalf("idle Objective:\n%s", text)
	}
	view.Objective.IdleSince = nil
	if text := describeRuntimeObjective(view, ""); strings.Contains(text, "Idle since") {
		t.Fatalf("busy Objective:\n%s", text)
	}
}

// The pane the runtime Gateway shows: an Objective ready for review gives the owner's assessment
// and last reply, each Session's delivery with its branch, and how to review it; nothing says
// details are unavailable.
func TestRuntimeObjectiveReadyForReviewShowsAssessmentAndDelivery(t *testing.T) {
	view := &views.ObjectiveOverview{
		Objective: &views.Objective{Id: "ship", Outcome: "Ship it", OwnerTag: "lead",
			Status: views.ObjectiveStatus_OBJECTIVE_STATUS_READY_FOR_REVIEW, CompletionSummary: "Shipped behind a flag."},
		Budget:       &views.ObjectiveBudgetUse{},
		LatestResult: "Done: flag is off by default.",
		Sessions: []*views.ObjectiveSession{{Id: "s", TagId: "lead", Owner: true, Delivery: &views.ObjectiveSessionDelivery{
			TaskId: "t", WorkspaceId: "app", BaseCommit: "0123456789abcdef", HeadCommit: "fedcba9876543210",
			Committed: true, ChangedFiles: 1,
		}}},
	}
	text := describeRuntimeObjective(view, "")
	branch := client.SessionBranch("lead", "s")
	for _, expected := range []string{
		"Owner's assessment: Shipped behind a flag.",
		"Owner's last reply: Done: flag is off by default.",
		"Commit fedcba987654 in Workspace app, 1 changed file since 0123456789ab",
		"Branch: " + branch,
		"Merge it with: git merge " + branch,
		"press a to approve it, or c to request changes",
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("missing %q:\n%s", expected, text)
		}
	}
	if strings.Contains(text, "unavailable") {
		t.Fatalf("still says details are unavailable:\n%s", text)
	}
	view.Objective.Status = views.ObjectiveStatus_OBJECTIVE_STATUS_COMPLETED
	view.Sessions = nil
	text = describeRuntimeObjective(view, "")
	if !strings.Contains(text, "Result: Shipped behind a flag.") || strings.Contains(text, "press a to approve") ||
		!strings.Contains(text, "Nothing yet.") {
		t.Fatalf("completed Objective:\n%s", text)
	}
}
