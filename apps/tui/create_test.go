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
