package main

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/apps/tui/views"
)

func TestRuntimeV2ObjectiveFormKeepsTeamSelection(t *testing.T) {
	m, err := dial("test")(t.Context(), client.Target{URL: "http://127.0.0.1:1", Token: "test"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.client.Close)
	m.tags, m.teams, m.selected = runtimeTestTags(), []*views.Team{billingTeam()}, 0
	m = update(t, m, tea.WindowSizeMsg{Width: 100, Height: 30})
	m.openObjectiveForm("")
	m.form.fields[fieldOutcome].SetValue("Verify SSO")
	m.moveField(fieldTeam)
	if m.form.field != fieldTeam || !strings.Contains(m.renderObjectiveForm(), "Teams: billing") {
		t.Fatal("the runtime v2 Objective form must expose available Teams")
	}
	m.form.fields[fieldTeam].SetValue("billing")
	m.moveField(fieldBudget)
	m.createObjective()
	if m.form.request.Team != "billing" || m.form.request.Owner != "lead" {
		t.Fatalf("Objective request = %+v", m.form.request)
	}
}

// `/goal <outcome>` is a conversation message the Control Plane turns into an Objective; `/goal`
// alone opens the form, and the palette's inline /goal sends the same message.
func TestGoalIsSentToTheConversation(t *testing.T) {
	m, err := dial("test")(t.Context(), client.Target{URL: "http://127.0.0.1:1", Token: "test"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.client.Close)
	m.tags, m.selected = runtimeTestTags(), 0
	m = update(t, m, tea.WindowSizeMsg{Width: 100, Height: 30})
	m.pane = paneConversation
	conv := m.conversation("lead", m.currentConversation("lead"))
	conv.loaded = true

	m.input.SetValue("/goal Ship the release notes")
	if cmd := m.submit(); cmd == nil || m.form != nil || m.pane != paneConversation || conv.runtime.sending != 1 {
		t.Fatalf("/goal with an outcome must be sent: form=%v pane=%v sending=%d", m.form != nil, m.pane, conv.runtime.sending)
	}
	if cmd := m.sendGoal("Ship the docs"); cmd == nil || m.form != nil || conv.runtime.sending != 2 {
		t.Fatalf("the palette's /goal must be sent: form=%v sending=%d", m.form != nil, conv.runtime.sending)
	}

	m.input.SetValue("/goal")
	m.submit()
	if m.form == nil || m.pane != paneNewObjective || m.form.fields[fieldOutcome].Value() != "" || conv.runtime.sending != 2 {
		t.Fatalf("/goal alone must open the form: pane=%v sending=%d", m.pane, conv.runtime.sending)
	}

	// Away from a conversation, the palette's /goal fills in the form and sends nothing yet.
	m.form, m.pane = nil, paneInbox
	m.sendGoal("Ship the docs")
	if m.form == nil || m.form.fields[fieldOutcome].Value() != "Ship the docs" || m.form.sending || conv.runtime.sending != 2 {
		t.Fatal("the palette's /goal away from a conversation must fill in the form")
	}
}

func submitForm(t *testing.T, a *app, outcome string) {
	t.Helper()
	typeApp(t, a, outcome)
	pressApp(t, a, key(tea.KeyEnter), key(tea.KeyEnter), key(tea.KeyEnter))
}

func TestNewObjectiveID(t *testing.T) {
	for outcome, prefix := range map[string]string{"Ship SSO / with tests": "ship-sso-with-", "  !!": "objective-"} {
		id, err := newObjectiveID(outcome)
		if err != nil || !strings.HasPrefix(id, prefix) || len(id) != len(prefix)+8 {
			t.Errorf("newObjectiveID(%q) = %q, %v", outcome, id, err)
		}
	}
}
