package main

import (
	"strings"
	"testing"

	"github.com/atemaguer/supertag/apps/tui/views"
)

func TestTheConversationThatCreatedAnObjectiveSaysHowItStands(t *testing.T) {
	reply := "Created Objective ship-it-1a2b: Ship it\nlead owns it, and its first turn has started."
	if got := createdObjectiveID(reply); got != "ship-it-1a2b" {
		t.Fatalf("createdObjectiveID = %q", got)
	}
	for _, other := range []string{"Done.", "Created Objective : x", "Created Objective two words: x"} {
		if got := createdObjectiveID(other); got != "" {
			t.Fatalf("createdObjectiveID(%q) = %q", other, got)
		}
	}
	m := runtimeModel(t)
	if line := m.objectiveHomeLine("ship-it-1a2b"); line != "" {
		t.Fatalf("an unknown Objective says %q", line)
	}
	m.objectives = []*views.Objective{{Id: "ship-it-1a2b", Status: views.ObjectiveStatus_OBJECTIVE_STATUS_WORKING}}
	if line := m.objectiveHomeLine("ship-it-1a2b"); line != "" {
		t.Fatalf("a working Objective says %q", line)
	}
	m.objectives[0].Status = views.ObjectiveStatus_OBJECTIVE_STATUS_READY_FOR_REVIEW
	m.objectives[0].CompletionSummary = "review_me.txt holds hello\nmore detail"
	if line := m.objectiveHomeLine("ship-it-1a2b"); line != "· Objective ship-it-1a2b is ready for your review: review_me.txt holds hello · open it under Objectives to approve or request changes" {
		t.Fatalf("ready line = %q", line)
	}
	// Once closed it leaves the open list; the Objective read after it says it is complete.
	m.objectives = nil
	m.closedObjectives = map[string]*views.Objective{"ship-it-1a2b": {Id: "ship-it-1a2b",
		Status: views.ObjectiveStatus_OBJECTIVE_STATUS_COMPLETED, CompletionSummary: "Done and verified"}}
	if line := m.objectiveHomeLine("ship-it-1a2b"); !strings.HasPrefix(line, "· Objective ship-it-1a2b is complete: Done and verified") {
		t.Fatalf("complete line = %q", line)
	}
}
