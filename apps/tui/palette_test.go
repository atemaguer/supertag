package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
)

var ctrlK = tea.KeyPressMsg{Code: 'k', Mod: tea.ModCtrl}

// testApp starts an app on one fake Control Plane, or on two when other is set, and loads what
// the first shows.
func testApp(t *testing.T, fake *fakeControlPlane, other *fakeControlPlane) *app {
	t.Helper()
	server := fake.start(t)
	contexts := []client.Target{{Name: "laptop", URL: server.URL, Token: fake.token}}
	if other != nil {
		contexts = append(contexts, client.Target{Name: "team", URL: other.start(t).URL, Token: other.token})
	}
	var started []context.Context
	a, err := newApp(context.Background(), testConnector(&started), contexts, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.stop)
	a.Update(tea.WindowSizeMsg{Width: 120, Height: 30})
	runApp(t, a, tea.Batch(a.scope(a.inner.reloadTags()), a.scope(a.inner.reloadInbox()), a.scope(a.inner.reloadTeams())))
	return a
}

// pressApp feeds keys to the app one by one and runs what each starts, as runApp does, except
// that a command still running after a moment, such as the input cursor's blink, is dropped.
func pressApp(t *testing.T, a *app, keys ...tea.KeyPressMsg) {
	t.Helper()
	for _, k := range keys {
		_, cmd := a.Update(k)
		queue := []tea.Cmd{cmd}
		for len(queue) > 0 {
			next := queue[0]
			queue = queue[1:]
			if next == nil {
				continue
			}
			done := make(chan tea.Msg, 1)
			go func() { done <- next() }()
			var msg tea.Msg
			select {
			case msg = <-done:
			case <-time.After(300 * time.Millisecond):
				continue
			}
			inner := msg
			if s, ok := msg.(scoped); ok {
				inner = s.msg
			}
			switch inner.(type) {
			case nil, pollMsg, hostTickMsg:
				continue
			case tea.BatchMsg:
				queue = append(queue, msg.(tea.BatchMsg)...)
				continue
			}
			_, cmd := a.Update(msg)
			queue = append(queue, cmd)
		}
	}
}

// typeApp types text into the app, one key per rune. Typing starts nothing but the input
// cursor's blink, which is dropped.
func typeApp(t *testing.T, a *app, text string) {
	t.Helper()
	for _, r := range text {
		a.Update(letter(r))
	}
}

func TestThePaletteOffersTheCommandsThatApply(t *testing.T) {
	a := testApp(t, &fakeControlPlane{tags: tags("lead")}, nil)
	pressApp(t, a, ctrlK)
	s := appScreen(a)
	for _, want := range []string{"Commands", "New conversation", "Switch conversation", "with lead · ctrl+o",
		"/goal · Create Objective  owned by lead", "Open inbox", "0 waiting", "enter runs"} {
		if !strings.Contains(s, want) {
			t.Errorf("the palette lacks %q:\n%s", want, s)
		}
	}
	if strings.Contains(s, "Switch Control Plane") {
		t.Errorf("one Control Plane must offer no switch:\n%s", s)
	}
	pressApp(t, a, key(tea.KeyEscape))
	if a.palette != nil || !strings.Contains(appScreen(a), "lead · default") {
		t.Fatalf("esc must close the palette:\n%s", appScreen(a))
	}

	empty := testApp(t, &fakeControlPlane{}, nil)
	pressApp(t, empty, ctrlK)
	if s := appScreen(empty); strings.Contains(s, "New conversation") || strings.Contains(s, "Create Objective") || !strings.Contains(s, "Open inbox") {
		t.Fatalf("without Tags only the inbox applies:\n%s", s)
	}
}

func TestSlashOpensThePaletteOnlyWhereItIsNotTyped(t *testing.T) {
	a := testApp(t, &fakeControlPlane{tags: tags("lead")}, nil)
	typeApp(t, a, "see /tmp")
	if a.palette != nil || a.inner.input.Value() != "see /tmp" {
		t.Fatalf("a / in a message must be typed: palette=%v input=%q", a.palette != nil, a.inner.input.Value())
	}
	a.inner.input.Reset()
	pressApp(t, a, letter('/'))
	if a.palette == nil || a.inner.input.Value() != "" {
		t.Fatalf("/ on an empty input must open the palette: input=%q", a.inner.input.Value())
	}
	a.Update(tea.PasteMsg{Content: "conv"})
	if a.inner.input.Value() != "" {
		t.Fatalf("a paste into the palette reached the input: %q", a.inner.input.Value())
	}
	s := appScreen(a)
	if !strings.Contains(s, "New conversation") || !strings.Contains(s, "Switch conversation") || strings.Contains(s, "Create Objective") {
		t.Fatalf("the filter must keep only matching commands:\n%s", s)
	}
	typeApp(t, a, "zz")
	if !strings.Contains(appScreen(a), "No command matches.") {
		t.Fatalf("screen:\n%s", appScreen(a))
	}
	pressApp(t, a, key(tea.KeyEnter), ctrlK)
	if a.palette != nil {
		t.Fatal("ctrl+k must close the palette")
	}
}

func TestThePaletteStartsAndSwitchesConversations(t *testing.T) {
	fake := &fakeControlPlane{tags: tags("lead", "builder"), open: func() []*operatorv1.Conversation {
		return []*operatorv1.Conversation{{Tag: "lead", Name: "billing"}}
	}}
	a := testApp(t, fake, nil)
	pressApp(t, a, ctrlK)
	typeApp(t, a, "new")
	pressApp(t, a, key(tea.KeyEnter))
	if a.inner.pane != paneConversations || !a.inner.picker.naming || !a.inner.input.Focused() {
		t.Fatalf("New conversation must name one: pane=%v\n%s", a.inner.pane, appScreen(a))
	}
	typeApp(t, a, "release-notes")
	pressApp(t, a, key(tea.KeyEnter))
	if s := appScreen(a); !strings.Contains(s, "lead · release-notes") || !strings.Contains(s, "to start the conversation release-notes") {
		t.Fatalf("screen:\n%s", s)
	}

	pressApp(t, a, ctrlK)
	typeApp(t, a, "switch conv")
	pressApp(t, a, key(tea.KeyEnter))
	if s := appScreen(a); a.inner.pane != paneConversations || !strings.Contains(s, "lead · conversations") || !strings.Contains(s, "billing") {
		t.Fatalf("Switch conversation must list them:\n%s", s)
	}
	pressApp(t, a, key(tea.KeyUp), key(tea.KeyUp), key(tea.KeyEnter))
	if s := appScreen(a); !strings.Contains(s, "lead · billing") {
		t.Fatalf("screen:\n%s", s)
	}
}

func TestThePaletteSwitchesControlPlanes(t *testing.T) {
	alpha := &fakeControlPlane{token: "alpha-token", tags: tags("builder")}
	beta := &fakeControlPlane{token: "beta-token", tags: tags("reviewer")}
	a := testApp(t, alpha, beta)
	pressApp(t, a, ctrlK)
	typeApp(t, a, "control")
	if s := appScreen(a); !strings.Contains(s, "Switch Control Plane  laptop · ") {
		t.Fatalf("screen:\n%s", s)
	}
	pressApp(t, a, key(tea.KeyEnter))
	if !a.choosing || a.palette != nil || !strings.Contains(appScreen(a), "Control Planes") {
		t.Fatalf("Switch Control Plane must open the list:\n%s", appScreen(a))
	}
	pressApp(t, a, key(tea.KeyDown), key(tea.KeyEnter))
	if a.current != 1 || !strings.Contains(appScreen(a), "reviewer") {
		t.Fatalf("screen:\n%s", appScreen(a))
	}
}

func TestThePaletteOpensTheInbox(t *testing.T) {
	fake := coordinationFake()
	a := testApp(t, fake, nil)
	pressApp(t, a, ctrlK)
	if s := appScreen(a); !strings.Contains(s, "Open inbox") || !strings.Contains(s, "2 waiting") {
		t.Fatalf("screen:\n%s", s)
	}
	typeApp(t, a, "inbox")
	pressApp(t, a, key(tea.KeyEnter))
	if a.inner.pane != paneInbox || a.inner.item.GetKey() != "question:task-own" || a.inner.focus != focusRail {
		t.Fatalf("Open inbox must show the first item with the rail focused: pane=%v\n%s", a.inner.pane, appScreen(a))
	}
	pressApp(t, a, key(tea.KeyDown))
	if a.inner.item.GetKey() != "approval:apr-1" {
		t.Fatalf("down must move to the next item:\n%s", appScreen(a))
	}

	quiet := testApp(t, &fakeControlPlane{tags: tags("lead")}, nil)
	pressApp(t, quiet, ctrlK)
	typeApp(t, quiet, "inbox")
	pressApp(t, quiet, key(tea.KeyEnter))
	if quiet.inner.pane != paneConversation || !strings.Contains(appScreen(quiet), "Nothing waits on you.") {
		t.Fatalf("screen:\n%s", appScreen(quiet))
	}
}

// openForm opens the new Objective form through the palette.
func openForm(t *testing.T, a *app) {
	t.Helper()
	pressApp(t, a, ctrlK)
	typeApp(t, a, "create objective")
	pressApp(t, a, key(tea.KeyEnter))
	if a.inner.pane != paneNewObjective {
		t.Fatalf("Create Objective must open the form:\n%s", appScreen(a))
	}
}

func TestThePaletteCreatesAnObjective(t *testing.T) {
	fake := coordinationFake()
	fake.teamList = func() []*operatorv1.Team { return []*operatorv1.Team{billingTeam()} }
	a := testApp(t, fake, nil)
	openForm(t, a)
	s := appScreen(a)
	for _, want := range []string{"New Objective · owned by lead", "Outcome", "Team", "Teams: billing", "Budget", "enter next, then creates"} {
		if !strings.Contains(s, want) {
			t.Errorf("the form lacks %q:\n%s", want, s)
		}
	}
	typeApp(t, a, "Ship SSO / with tests")
	pressApp(t, a, key(tea.KeyEnter))
	typeApp(t, a, "billing")
	pressApp(t, a, key(tea.KeyDown))
	typeApp(t, a, "1,250.50 usd")
	pressApp(t, a, key(tea.KeyEnter))
	fake.mu.Lock()
	created := append([]*operatorv1.CreateObjectiveRequest(nil), fake.created...)
	fake.mu.Unlock()
	if len(created) != 1 {
		t.Fatalf("%d creates, want one", len(created))
	}
	got := created[0]
	if got.GetOutcome() != "Ship SSO / with tests" || got.GetOwner() != "lead" || got.GetTeam() != "billing" || !strings.HasPrefix(got.GetId(), "ship-sso-with-") ||
		got.GetBudget().GetLimitMinor() != 125050 || got.GetBudget().GetCurrency() != "USD" {
		t.Fatalf("request = %v", got)
	}
	if s := appScreen(a); !strings.Contains(s, "Created Objective obj-new.") || !strings.Contains(s, "lead took its first turn as Task task-new.") ||
		!strings.Contains(s, "enter shows the Objective") {
		t.Fatalf("screen:\n%s", s)
	}
	pressApp(t, a, key(tea.KeyEnter))
	if a.inner.pane != paneObjective || a.inner.objectiveID != "obj-new" || a.inner.form != nil {
		t.Fatalf("enter must show the Objective: pane=%v id=%q", a.inner.pane, a.inner.objectiveID)
	}
	if fake.descriptions("obj-new") == 0 {
		t.Fatal("showing the Objective must describe it")
	}
}

func TestTheObjectiveFormChecksItsFields(t *testing.T) {
	fake := &fakeControlPlane{tags: tags("lead")}
	a := testApp(t, fake, nil)
	openForm(t, a)
	pressApp(t, a, key(tea.KeyEnter), key(tea.KeyEnter), key(tea.KeyEnter))
	if s := appScreen(a); !strings.Contains(s, "An Objective needs its outcome") || a.inner.form.field != fieldOutcome {
		t.Fatalf("an empty outcome must be refused:\n%s", s)
	}
	typeApp(t, a, "Ship SSO")
	pressApp(t, a, key(tea.KeyDown), key(tea.KeyDown))
	typeApp(t, a, "lots")
	pressApp(t, a, key(tea.KeyEnter))
	if s := appScreen(a); !strings.Contains(s, "A budget is an amount and its currency, such as 300 USD or $12.50.") || a.inner.form.field != fieldBudget {
		t.Fatalf("a malformed budget must be refused:\n%s", s)
	}
	fake.mu.Lock()
	sent := len(fake.created)
	fake.mu.Unlock()
	if sent != 0 {
		t.Fatalf("%d invalid forms were sent", sent)
	}

	fake.create = func(*operatorv1.CreateObjectiveRequest) (*operatorv1.CreateObjectiveResponse, error) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("Team ghost was not found\x1b[2J"))
	}
	for range 4 {
		pressApp(t, a, key(tea.KeyBackspace))
	}
	pressApp(t, a, key(tea.KeyEnter))
	if s := appScreen(a); !strings.Contains(s, "Team ghost was not found [2J") || a.inner.form.created != nil || a.inner.form.sending {
		t.Fatalf("a refusal must show in the form:\n%s", s)
	}
	pressApp(t, a, key(tea.KeyEscape))
	if a.inner.pane != paneConversation || a.inner.form != nil {
		t.Fatalf("esc must leave the form: pane=%v", a.inner.pane)
	}
}

func TestAnObjectiveThatDidNotStartStartsAgainByID(t *testing.T) {
	started := false
	fake := &fakeControlPlane{tags: tags("lead"), create: func(req *operatorv1.CreateObjectiveRequest) (*operatorv1.CreateObjectiveResponse, error) {
		res := &operatorv1.CreateObjectiveResponse{Objective: objective("ship-sso-7f3k", req.GetOutcome(), operatorv1.ObjectiveStatus_OBJECTIVE_STATUS_WORKING),
			Warnings: []string{"Tag lead has no connected Worker Host."}}
		if started {
			res.StartedTaskId = "task-first"
		} else {
			res.NotStarted = "Tag lead has no connected Worker Host."
		}
		return res, nil
	}}
	a := testApp(t, fake, nil)
	openForm(t, a)
	typeApp(t, a, "Ship SSO")
	pressApp(t, a, key(tea.KeyEnter), key(tea.KeyEnter), key(tea.KeyEnter))
	s := appScreen(a)
	for _, want := range []string{"Created Objective ship-sso-7f3k.", "It did not start: Tag lead has no connected Worker Host.",
		"Once that is fixed, press r to start it.", "Warnings:", "r starts it"} {
		if !strings.Contains(s, want) {
			t.Errorf("screen lacks %q:\n%s", want, s)
		}
	}
	started = true
	pressApp(t, a, letter('r'))
	fake.mu.Lock()
	created := append([]*operatorv1.CreateObjectiveRequest(nil), fake.created...)
	fake.mu.Unlock()
	if len(created) != 2 || created[1].GetId() != "ship-sso-7f3k" || created[1].GetOutcome() != "Ship SSO" || created[1].GetOwner() != "lead" {
		t.Fatalf("creates = %v, want a repeat with the Objective's ID", created)
	}
	if s := appScreen(a); !strings.Contains(s, "lead took its first turn as Task task-first.") {
		t.Fatalf("screen:\n%s", s)
	}
}

func TestParseBudget(t *testing.T) {
	for text, want := range map[string]*operatorv1.Budget{
		"":            nil,
		"300 USD":     {LimitMinor: 30000, Currency: "USD"},
		"$12.5":       {LimitMinor: 1250, Currency: "USD"},
		"1,000 eur":   {LimitMinor: 100000, Currency: "EUR"},
		"5000JPY":     {LimitMinor: 5000, Currency: "JPY"},
		"1.234 KWD":   {LimitMinor: 1234, Currency: "KWD"},
		" $ 0.01 ":    {LimitMinor: 1, Currency: "USD"},
		"12.50  gbp ": {LimitMinor: 1250, Currency: "GBP"},
	} {
		got, err := parseBudget(text)
		if err != nil || (want == nil) != (got == nil) || (want != nil && (got.GetLimitMinor() != want.GetLimitMinor() || got.GetCurrency() != want.GetCurrency())) {
			t.Errorf("parseBudget(%q) = %v, %v; want %v", text, got, err, want)
		}
	}
	for text, want := range map[string]string{
		"300":                   "A budget is an amount and its currency",
		"USD 300":               "A budget is an amount and its currency",
		"-5 USD":                "A budget is an amount and its currency",
		"1.5 JPY":               "A JPY budget has no decimal places.",
		"1.999 USD":             "A USD budget has at most 2 decimal places.",
		"0 USD":                 "A budget must be more than zero.",
		"99999999999999999 USD": "That budget is too large.",
	} {
		if _, err := parseBudget(text); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("parseBudget(%q) error = %v, want %q", text, err, want)
		}
	}
}
