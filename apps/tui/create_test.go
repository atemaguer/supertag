package main

import (
	"errors"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
)

func TestRuntimeV2ObjectiveFormKeepsTeamSelection(t *testing.T) {
	m, err := dialRuntimeV2("test")(t.Context(), client.Target{URL: "http://127.0.0.1:1", Token: "test"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.client.Close)
	m.tags, m.teams, m.selected = tagList("lead"), []*operatorv1.Team{billingTeam()}, 0
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

// dedupingFake commits each create by ID, as the Control Plane does, and loses the first n
// answers after committing.
func dedupingFake(lose int) (*fakeControlPlane, map[string]int) {
	stored := map[string]int{}
	fake := &fakeControlPlane{tags: tags("lead")}
	fake.create = func(req *operatorv1.CreateObjectiveRequest) (*operatorv1.CreateObjectiveResponse, error) {
		stored[req.GetId()]++
		if lose > 0 {
			lose--
			return nil, connect.NewError(connect.CodeUnavailable, errors.New("the answer was lost"))
		}
		return &operatorv1.CreateObjectiveResponse{Objective: objective(req.GetId(), req.GetOutcome(), operatorv1.ObjectiveStatus_OBJECTIVE_STATUS_WORKING), StartedTaskId: "task-1"}, nil
	}
	return fake, stored
}

func createIDs(fake *fakeControlPlane) []string {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	ids := make([]string, len(fake.created))
	for i, req := range fake.created {
		ids[i] = req.GetId()
	}
	return ids
}

func submitForm(t *testing.T, a *app, outcome string) {
	t.Helper()
	typeApp(t, a, outcome)
	pressApp(t, a, key(tea.KeyEnter), key(tea.KeyEnter), key(tea.KeyEnter))
}

func TestInlineGoalCreatesAnObjectiveForTheSelectedTag(t *testing.T) {
	const outcome = "Ship SSO once the integration tests pass."
	for _, entry := range []string{"type", "paste"} {
		t.Run(entry, func(t *testing.T) {
			fake := &fakeControlPlane{tags: tags("lead", "builder")}
			a := testApp(t, fake, nil)
			pressApp(t, a, key(tea.KeyTab), key(tea.KeyDown), key(tea.KeyEnter))
			if entry == "type" {
				a.inner.defaultWorkspace = "billing-checkout"
				typeApp(t, a, "/goal "+outcome)
			} else {
				a.Update(tea.PasteMsg{Content: "/goal " + outcome})
			}
			pressApp(t, a, key(tea.KeyEnter))
			fake.mu.Lock()
			defer fake.mu.Unlock()
			if len(fake.created) != 1 || len(fake.sent) != 0 {
				t.Fatalf("creates = %v, messages = %v", fake.created, fake.sent)
			}
			got := fake.created[0]
			if got.GetOwner() != "builder" || got.GetOutcome() != outcome || got.GetTeam() != "" || got.GetBudget() != nil {
				t.Fatalf("request = %v", got)
			}
			if strings.Join(got.GetWorkspaces(), " ") != a.inner.defaultWorkspace {
				t.Fatalf("Workspaces = %v, want %q", got.GetWorkspaces(), a.inner.defaultWorkspace)
			}
			if s := appScreen(a); !strings.Contains(s, "Created Objective obj-new.") {
				t.Fatalf("screen:\n%s", s)
			}
		})
	}
}

func TestALostCreateAnswerIsRetriedWithTheSameID(t *testing.T) {
	fake, stored := dedupingFake(1)
	a := testApp(t, fake, nil)
	openForm(t, a)
	typeApp(t, a, "Ship SSO")
	pressApp(t, a, key(tea.KeyEnter), key(tea.KeyEnter))
	typeApp(t, a, "$12.50")
	pressApp(t, a, key(tea.KeyEnter))
	if s := appScreen(a); !strings.Contains(s, "the answer was lost") || a.inner.form.created != nil {
		t.Fatalf("the lost answer must show as an error:\n%s", s)
	}
	pressApp(t, a, key(tea.KeyEnter))
	ids := createIDs(fake)
	if len(ids) != 2 || ids[0] == "" || ids[0] != ids[1] || len(stored) != 1 {
		t.Fatalf("ids = %v, want one ID sent twice", ids)
	}
	if s := appScreen(a); !strings.Contains(s, "Created Objective "+ids[0]+".") {
		t.Fatalf("screen:\n%s", s)
	}
}

func TestEnterWhileCreatingSendsNothingNew(t *testing.T) {
	fake, stored := dedupingFake(0)
	a := testApp(t, fake, nil)
	openForm(t, a)
	typeApp(t, a, "Ship SSO")
	pressApp(t, a, key(tea.KeyEnter), key(tea.KeyEnter))
	_, inFlight := a.Update(key(tea.KeyEnter))
	if !a.inner.form.sending {
		t.Fatal("the form must be sending")
	}
	if _, cmd := a.Update(key(tea.KeyEnter)); cmd != nil {
		t.Fatal("enter while sending must send nothing")
	}
	runApp(t, a, inFlight)
	if ids := createIDs(fake); len(ids) != 1 || len(stored) != 1 {
		t.Fatalf("ids = %v, want one create", ids)
	}
}

func TestAChangedSubmissionGetsAFreshID(t *testing.T) {
	fake, _ := dedupingFake(1)
	a := testApp(t, fake, nil)
	openForm(t, a)
	submitForm(t, a, "Ship SSO")
	pressApp(t, a, key(tea.KeyUp), key(tea.KeyUp))
	typeApp(t, a, " now")
	pressApp(t, a, key(tea.KeyEnter), key(tea.KeyEnter), key(tea.KeyEnter))
	ids := createIDs(fake)
	if len(ids) != 2 || ids[0] == ids[1] || ids[1] == "" {
		t.Fatalf("ids = %v, want a fresh ID for the changed outcome", ids)
	}
	fake.mu.Lock()
	outcome := fake.created[1].GetOutcome()
	fake.mu.Unlock()
	if outcome != "Ship SSO now" {
		t.Fatalf("outcome = %q", outcome)
	}
}

func TestANewFormGetsAFreshID(t *testing.T) {
	fake, _ := dedupingFake(1)
	a := testApp(t, fake, nil)
	openForm(t, a)
	submitForm(t, a, "Ship SSO")
	pressApp(t, a, key(tea.KeyEscape))
	openForm(t, a)
	submitForm(t, a, "Ship SSO")
	ids := createIDs(fake)
	if len(ids) != 2 || ids[0] == ids[1] {
		t.Fatalf("ids = %v, want a fresh ID in the new form", ids)
	}
}

func TestNewObjectiveID(t *testing.T) {
	for outcome, prefix := range map[string]string{"Ship SSO / with tests": "ship-sso-with-", "  !!": "objective-"} {
		id, err := newObjectiveID(outcome)
		if err != nil || !strings.HasPrefix(id, prefix) || len(id) != len(prefix)+8 {
			t.Errorf("newObjectiveID(%q) = %q, %v", outcome, id, err)
		}
	}
}
