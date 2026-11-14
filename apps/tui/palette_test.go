package main

import (
	"context"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/apps/tui/views"
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
		"/goal · Create Objective        owned by lead", "Open inbox", "0 waiting", "enter runs"} {
		if !strings.Contains(s, want) {
			t.Errorf("the palette lacks %q:\n%s", want, s)
		}
	}
	if !strings.Contains(s, "Control Planes · add or switch") {
		t.Errorf("one Control Plane must still offer adding another:\n%s", s)
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

func TestThePaletteSwitchesControlPlanes(t *testing.T) {
	alpha := &fakeControlPlane{token: "alpha-token", tags: tags("builder")}
	beta := &fakeControlPlane{token: "beta-token", tags: tags("reviewer")}
	a := testApp(t, alpha, beta)
	pressApp(t, a, ctrlK)
	typeApp(t, a, "control")
	if s := appScreen(a); !strings.Contains(s, "Control Planes · add or switch  laptop · ") {
		t.Fatalf("screen:\n%s", s)
	}
	pressApp(t, a, key(tea.KeyEnter))
	if !a.choosing || a.palette != nil || !strings.Contains(appScreen(a), "Control Planes") {
		t.Fatalf("Control Planes must open the list:\n%s", appScreen(a))
	}
	pressApp(t, a, key(tea.KeyDown), key(tea.KeyEnter))
	if a.current != 1 || !strings.Contains(appScreen(a), "reviewer") {
		t.Fatalf("screen:\n%s", appScreen(a))
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

func TestParseBudget(t *testing.T) {
	for text, want := range map[string]*views.Budget{
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
