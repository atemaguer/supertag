package main

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/atemaguer/supertag/apps/tui/views"
)

func TestTheOperatorApprovesOrRequestsChangesFromTheObjectivePane(t *testing.T) {
	fake := &fakeGateway{token: "test"}
	server := fake.start(t)
	ready := func() model {
		m := runtimeModelAt(t, server.URL)
		m.objectives = []*views.Objective{{Id: "o1", OwnerTagId: "lead", Outcome: "Ship it",
			Status: views.ObjectiveStatus_OBJECTIVE_STATUS_READY_FOR_REVIEW}}
		m.pane, m.objectiveID = paneObjective, "o1"
		return m
	}

	m := ready()
	// A review waits on you beside the inbox, and the pane says how to decide it.
	if got := screen(m); !strings.Contains(got, "Waiting on you (1)") || !strings.Contains(got, "a approve · c request changes") {
		t.Fatalf("the pane shows:\n%s", got)
	}
	m = update(t, m, tea.KeyPressMsg{Code: 'a', Text: "a"})
	if got := screen(m); !strings.Contains(got, "enter approves the owner's assessment") {
		t.Fatalf("approve asks for enter:\n%s", got)
	}
	next, cmd := m.Update(key(tea.KeyEnter))
	m = run(t, next.(model), cmd)
	if !strings.Contains(m.notice.text, "Approved") {
		t.Fatalf("notice = %q", m.notice.text)
	}

	m = ready()
	m = update(t, m, tea.KeyPressMsg{Code: 'c', Text: "c"})
	for _, r := range "Add the regression test" {
		m = update(t, m, tea.KeyPressMsg{Code: r, Text: string(r)})
	}
	next, cmd = m.Update(key(tea.KeyEnter))
	m = run(t, next.(model), cmd)
	if !strings.Contains(m.notice.text, "Changes requested") {
		t.Fatalf("notice = %q", m.notice.text)
	}

	fake.mu.Lock()
	defer fake.mu.Unlock()
	reviews := fake.reviews
	if len(reviews) != 2 || !reviews[0].GetApproved() || reviews[0].GetFeedback() != "" ||
		reviews[1].GetApproved() || reviews[1].GetFeedback() != "Add the regression test" ||
		reviews[0].GetObjectiveId() != "o1" || reviews[0].GetOperationId() == "" {
		t.Fatalf("reviews = %v", reviews)
	}
}
