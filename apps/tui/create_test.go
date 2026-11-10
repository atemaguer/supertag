package main

import (
	"errors"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
)

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
