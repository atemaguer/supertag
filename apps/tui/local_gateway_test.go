package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
)

// fakeSupertag is a supertag command that prints what `supertag __local-gateway` would.
func fakeSupertag(t *testing.T, script string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "supertag")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n[ \"$1\" = __local-gateway ] || exit 64\n"+script+"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLocalDiscoveryReadsWhatTheCLIReports(t *testing.T) {
	token := strings.Repeat("a", 64)
	running := fakeSupertag(t, `printf '%s\n' '{"protocol":"local-gateway.v1","running":true,"state_directory":"/tmp/state","url":"http://127.0.0.1:7001","token":"`+token+`"}'`)
	target, problem := runLocalDiscovery(t.Context(), running)
	if problem != "" || target != (client.Target{Name: localName, URL: "http://127.0.0.1:7001", Token: token}) {
		t.Fatalf("running local Gateway: %+v %q", target, problem)
	}

	stopped := fakeSupertag(t, `printf '%s\n' '{"protocol":"local-gateway.v1","running":false,"state_directory":"/tmp/state","message":"No local Gateway is running from /tmp/state. Start it with supertag up."}'`)
	target, problem = runLocalDiscovery(t.Context(), stopped)
	if target.URL != "" || !strings.Contains(problem, "Start it with supertag up") {
		t.Fatalf("stopped local Gateway: %+v %q", target, problem)
	}

	unsafe := fakeSupertag(t, `echo 'Error: /tmp/state must be a private directory owned by this user' >&2; exit 1`)
	if _, problem = runLocalDiscovery(t.Context(), unsafe); problem != "Could not check the local Gateway: /tmp/state must be a private directory owned by this user" {
		t.Fatalf("unsafe state: %q", problem)
	}

	for _, report := range []string{
		`{"protocol":"local-gateway.v2","running":true,"url":"http://127.0.0.1:7001","token":"t"}`,
		`{"protocol":"local-gateway.v1","running":true,"url":"http://192.0.2.1:7001","token":"t"}`,
		`{"protocol":"local-gateway.v1","running":true,"url":"http://127.0.0.1:7001","token":""}`,
	} {
		if target, problem = runLocalDiscovery(t.Context(), fakeSupertag(t, `printf '%s\n' '`+report+`'`)); target.URL != "" || problem == "" {
			t.Fatalf("accepted %s", report)
		}
	}
}

func TestStartupOpensTheLastSavedGatewayElseTheLocalOne(t *testing.T) {
	saved := client.Target{Name: "remote", URL: "https://remote.example", Token: "remote-token"}
	local := client.Target{Name: localName, URL: "http://127.0.0.1:7001", Token: "local-token"}
	profiles := gatewayProfiles{Version: 1, Active: saved.Name, Gateways: []client.Target{saved}}
	h, found, err := startupTargets(nil, profiles, local)
	if err != nil || found != local || h.Contexts[0] != local || h.Contexts[h.Current] != saved {
		t.Fatal("the last saved Gateway used must win, with Local listed first")
	}
	profiles.Active = ""
	if h, _, _ = startupTargets(nil, profiles, local); h.Contexts[h.Current] != local {
		t.Fatal("with nothing last used, the local Gateway must open")
	}
	if h, _, _ = startupTargets(nil, profiles, client.Target{}); h.Contexts[h.Current] != saved {
		t.Fatal("without a local Gateway, the saved one must open")
	}

	// `supertag tui` handed over the local Gateway: it is the Local entry, in its Workspace.
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = w.WriteString(`{"protocol":"runtime.v2","current":0,"contexts":[{"url":"http://127.0.0.1:7001","token":"local-token","workspace":"repo"}]}`); err != nil {
		t.Fatal(err)
	}
	w.Close()
	h, found, err = startupTargets(r, profiles, local)
	if err != nil || len(h.Contexts) != 1 || h.Current != 0 || found.Workspace != "repo" || h.Contexts[0] != found || found.Name != localName {
		t.Fatalf("handed-over local Gateway: %+v %+v", h, found)
	}
}

func TestLocalGatewayConnectsWithItsCurrentTokenAndIsNeverSaved(t *testing.T) {
	local, bad := gatewayFixture(t, localName, "local-token")
	beta, _ := gatewayFixture(t, "beta", "beta-token")
	store := profileStore(t)
	if _, err := store.save(beta); err != nil {
		t.Fatal(err)
	}
	if err := store.clearActive(); err != nil {
		t.Fatal(err)
	}
	profiles, err := store.load()
	if err != nil || profiles.Active != "" {
		t.Fatal("clearing the active Gateway failed")
	}
	// Launched while the local token was one `supertag up` has since replaced.
	stale := local
	stale.Token = "replaced-token"
	h, found, err := startupTargets(nil, profiles, stale)
	if err != nil {
		t.Fatal(err)
	}
	connector := func(ctx context.Context, target client.Target) (model, error) {
		c, err := client.New(target, "test")
		if err != nil {
			return model{}, err
		}
		return newModel(ctx, c, client.NewFollower(c), nil), nil
	}
	a, err := newApp(t.Context(), connector, h.Contexts, h.Current)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.stop)
	a.gatewayStore, a.savedGateways = store, profiles.Gateways
	a.launchContexts, a.local = []client.Target{found}, found
	discovered, problem := local, ""
	a.discover = func() (client.Target, string) { return discovered, problem }
	a.Update(tea.WindowSizeMsg{Width: 120, Height: 26})
	if a.contexts[a.current] != stale || !strings.Contains(appScreen(a), "Local") {
		t.Fatal("the local Gateway must open first")
	}

	// Choosing Local again reads the current token and reconnects with it.
	_, look := a.Update(tea.KeyPressMsg{Code: 'p', Mod: tea.ModCtrl})
	a.Update(look())
	if !strings.Contains(appScreen(a), "[this machine]") || a.contexts[a.current] != local {
		t.Fatalf("the switcher must list the local Gateway: %s", appScreen(a))
	}
	a.choice = 0
	_, cmd := a.Update(key(tea.KeyEnter))
	if a.choosing || a.contexts[a.current] != local || cmd == nil {
		t.Fatal("choosing Local did not reconnect with its current token")
	}
	runApp(t, a, a.scope(a.inner.tagsCmd()))
	if bad.Load() != 0 {
		t.Fatal("the local Gateway received a stale token")
	}

	// It cannot be edited, saved or forgotten, and its token never reaches the store.
	a.choosing, a.choice = true, 0
	a.chooseKey(key('e'))
	a.chooseKey(key('s'))
	if a.gatewayDialog != nil || a.choiceErr != localRefusal {
		t.Fatal("the local token must not be offered for editing or saving")
	}
	a.chooseKey(key('d'))
	if !strings.Contains(a.choiceErr, "supertag down") {
		t.Fatal("forgetting Local must explain that it is not saved")
	}
	data, err := os.ReadFile(store.path)
	if err != nil || strings.Contains(string(data), local.Token) {
		t.Fatal("the local token was saved")
	}

	// Switching to a saved Gateway remembers it; switching back to Local clears that.
	for i, target := range a.contexts {
		if target == beta {
			a.choice = i
		}
	}
	a.chooseKey(key(tea.KeyEnter))
	if profiles, _ = store.load(); profiles.Active != beta.Name {
		t.Fatal("the saved Gateway was not remembered")
	}
	a.choosing, a.choice = true, 0
	a.chooseKey(key(tea.KeyEnter))
	if profiles, _ = store.load(); profiles.Active != "" || a.contexts[a.current] != local {
		t.Fatal("choosing Local must leave no saved Gateway active")
	}

	// Once the local Gateway stops, the switcher says how to start it.
	discovered, problem = client.Target{}, "No local Gateway is running from /tmp/state. Start it with supertag up."
	a.choosing, a.choice = true, 0
	a.chooseKey(key(tea.KeyEnter))
	if a.choiceErr != problem || !strings.Contains(appScreen(a), "Start it with supertag up") {
		t.Fatalf("a stopped local Gateway must say how to start it: %s", appScreen(a))
	}
}
