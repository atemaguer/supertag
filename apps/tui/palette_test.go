package main

import (
	"context"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/apps/tui/views"
	v2 "github.com/atemaguer/supertag/sdks/go/runtimev2"
)

var ctrlK = tea.KeyPressMsg{Code: 'k', Mod: tea.ModCtrl}

// testApp starts an app on one fake Gateway, or on two when other is set, and loads what
// the first shows.
func testApp(t *testing.T, fake *fakeGateway, other *fakeGateway) *app {
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
	a := testApp(t, &fakeGateway{tags: tags("lead")}, nil)
	pressApp(t, a, ctrlK)
	s := appScreen(a)
	for _, want := range []string{"Search Tags, conversations, settings…", "Tags", "lead", "alt+1", "Actions", "New Tag", "ctrl+n", "Keyboard shortcuts", "every key the app answers to", "/goal · Create Objective", "owned by lead", "Open inbox", "0 waiting", "enter opens"} {
		if !strings.Contains(s, want) {
			t.Errorf("the palette lacks %q:\n%s", want, s)
		}
	}
	if !strings.Contains(s, "Gateways · add or switch") {
		t.Errorf("one Gateway must still offer adding another:\n%s", s)
	}
	if strings.Contains(s, "New conversation") || strings.Contains(s, "Switch conversation") {
		t.Errorf("a Tag has one conversation, so the palette offers none to start or switch to:\n%s", s)
	}
	pressApp(t, a, key(tea.KeyEscape))
	if a.palette != nil || !strings.Contains(appScreen(a), "Say something to lead") {
		t.Fatalf("esc must close the palette:\n%s", appScreen(a))
	}

	empty := testApp(t, &fakeGateway{}, nil)
	pressApp(t, empty, ctrlK)
	if s := appScreen(empty); strings.Contains(s, "Create Objective") || len(empty.matchingTags()) > 0 || !strings.Contains(s, "Open inbox") {
		t.Fatalf("without Tags neither a Tag nor /goal is offered:\n%s", s)
	}
}

func TestThePaletteSearchesTagsByNameAndPreviewAndOpensThem(t *testing.T) {
	fake := &fakeGateway{tags: tags("lead", "alpha", "beta")}
	fake.conversations = func() []*v2.Conversation {
		now := time.Now().UnixMilli()
		return []*v2.Conversation{
			{TagId: "alpha", Preview: "The lockfile is current.", PreviewFromTag: true, LastActivityAtMs: now},
			{TagId: "beta", Preview: "Run the tests", LastActivityAtMs: now - 60_000},
		}
	}
	a := testApp(t, fake, nil)
	runApp(t, a, a.scope(a.inner.reloadConversations()))
	order := make([]string, 0, len(a.inner.tags))
	for _, tag := range a.inner.tags {
		order = append(order, tagName(tag))
	}
	pressApp(t, a, ctrlK)
	s := appScreen(a)
	for _, want := range []string{"The lockfile is current.", "you: Run the tests", "alt+1", "alt+3"} {
		if !strings.Contains(s, want) {
			t.Errorf("the Tags section lacks %q:\n%s", want, s)
		}
	}

	// A word of the latest message finds the Tag; the actions it does not match are gone.
	typeApp(t, a, "lockfile")
	s = appScreen(a)
	if !strings.Contains(s, "alpha") || strings.Contains(s, "beta") || strings.Contains(s, "Actions") {
		t.Fatalf("searching a preview must keep only its Tag:\n%s", s)
	}
	pressApp(t, a, key(tea.KeyEnter))
	if a.palette != nil || a.inner.selectedTag() != "alpha" {
		t.Fatalf("enter must open the Tag: palette=%v selected=%q", a.palette != nil, a.inner.selectedTag())
	}

	// Searching by name, and the arrow keys move from the Tags into the actions.
	pressApp(t, a, ctrlK)
	typeApp(t, a, "beta")
	if got := a.matching(); len(got) != 1 || got[0].title != "beta" {
		t.Fatalf("searching a name must keep only its Tag: %+v", got)
	}
	pressApp(t, a, key(tea.KeyEscape), ctrlK, key(tea.KeyDown))
	if a.palette.filter.Value() != "" || a.palette.cursor != 1 {
		t.Fatalf("the palette must open empty with the cursor moving: %q at %d", a.palette.filter.Value(), a.palette.cursor)
	}

	// alt+N opens the nth Tag from the palette, in rail order.
	pressApp(t, a, tea.KeyPressMsg{Code: '3', Mod: tea.ModAlt})
	if a.palette != nil || tagName(a.inner.tags[a.inner.selected]) != order[2] {
		t.Fatalf("alt+3 must open %q: palette=%v selected=%q", order[2], a.palette != nil, a.inner.selectedTag())
	}

	// Keyboard shortcuts shows in place of the palette; esc goes back to it.
	pressApp(t, a, ctrlK)
	typeApp(t, a, "keyboard")
	pressApp(t, a, key(tea.KeyEnter))
	if s := appScreen(a); !strings.Contains(s, "Keyboard shortcuts") || !strings.Contains(s, "Switch Gateways") {
		t.Fatalf("the keyboard shortcuts must show:\n%s", s)
	}
	pressApp(t, a, key(tea.KeyEscape))
	if a.palette == nil || a.palette.shortcuts || a.palette.filter.Value() != "keyboard" {
		t.Fatal("esc must go back to the palette")
	}
	pressApp(t, a, key(tea.KeyEscape))
	if a.palette != nil {
		t.Fatal("esc must close the palette")
	}
}

func TestSlashOpensThePaletteOnlyWhereItIsNotTyped(t *testing.T) {
	a := testApp(t, &fakeGateway{tags: tags("lead")}, nil)
	typeApp(t, a, "see /tmp")
	if a.palette != nil || a.inner.input.Value() != "see /tmp" {
		t.Fatalf("a / in a message must be typed: palette=%v input=%q", a.palette != nil, a.inner.input.Value())
	}
	a.inner.input.Reset()
	pressApp(t, a, letter('/'))
	if a.palette == nil || a.inner.input.Value() != "" {
		t.Fatalf("/ on an empty input must open the palette: input=%q", a.inner.input.Value())
	}
	a.Update(tea.PasteMsg{Content: "goal"})
	if a.inner.input.Value() != "" {
		t.Fatalf("a paste into the palette reached the input: %q", a.inner.input.Value())
	}
	s := appScreen(a)
	if !strings.Contains(s, "Create Objective") || strings.Contains(s, "Open inbox") || strings.Contains(s, "Task files") {
		t.Fatalf("the filter must keep only matching commands:\n%s", s)
	}
	typeApp(t, a, "zz")
	if !strings.Contains(appScreen(a), "No results") {
		t.Fatalf("screen:\n%s", appScreen(a))
	}
	pressApp(t, a, key(tea.KeyEnter), ctrlK)
	if a.palette != nil {
		t.Fatal("ctrl+k must close the palette")
	}
}

func TestThePaletteSwitchesGateways(t *testing.T) {
	alpha := &fakeGateway{token: "alpha-token", tags: tags("builder")}
	beta := &fakeGateway{token: "beta-token", tags: tags("reviewer")}
	a := testApp(t, alpha, beta)
	pressApp(t, a, ctrlK)
	typeApp(t, a, "gateway")
	if s := appScreen(a); !strings.Contains(s, "Gateways · add or switch  laptop · ") {
		t.Fatalf("screen:\n%s", s)
	}
	pressApp(t, a, key(tea.KeyEnter))
	if !a.choosing || a.palette != nil || !strings.Contains(appScreen(a), "Gateways") {
		t.Fatalf("Gateways must open the list:\n%s", appScreen(a))
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
