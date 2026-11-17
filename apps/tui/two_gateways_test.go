package main

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
	v2 "github.com/atemaguer/supertag/sdks/go/runtimev2"
)

// conversationGateway is a Gateway with one Tag whose conversation shows marker.
func conversationGateway(token, principal, tag, marker string) *fakeGateway {
	f := &fakeGateway{token: token, principal: principal, tags: tags(tag)}
	f.conversations = func() []*v2.Conversation {
		return []*v2.Conversation{{TagId: tag, ConversationId: "c-" + tag, Preview: marker, LatestOrder: 1, ReadOrder: 1}}
	}
	f.messages = func(asked string) *v2.ListMessagesResponse {
		if asked != tag {
			return nil
		}
		task := &v2.Task{TaskId: "t-" + tag, TagId: tag, SessionId: "s-" + tag, Prompt: marker,
			State: v2.TaskState_TASK_STATE_SUCCEEDED}
		return &v2.ListMessagesResponse{ConversationId: "c-" + tag,
			Messages: []*v2.ConversationMessage{{Task: task, Order: 1}}}
	}
	return f
}

// cachingConnector builds models as the binary does, with the on-disk cache, but without the
// watch stream, and records the context each model was given: switching away cancels it, which
// ends every stream and call the model started.
func cachingConnector(contexts *[]context.Context) connector {
	return func(ctx context.Context, target client.Target) (model, error) {
		c, err := client.New(target, "test")
		if err != nil {
			return model{}, err
		}
		*contexts = append(*contexts, ctx)
		f := &client.Follower{Client: c, Interval: time.Millisecond, IdleTimeout: time.Second, ReconnectTimeout: time.Second, WorkTimeout: time.Second}
		m := newModel(ctx, c, f, nil)
		m.cache = newModelCache(openCache(cacheOrigin(target)), target.Token)
		m.hydrate()
		return m, nil
	}
}

// cachedWith lists the cache files that hold marker.
func cachedWith(t *testing.T, marker string) []string {
	t.Helper()
	root, err := cacheDirectory()
	if err != nil {
		t.Fatal(err)
	}
	var found []string
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		if data, err := os.ReadFile(path); err == nil && strings.Contains(string(data), marker) {
			found = append(found, path)
		}
		return nil
	})
	return found
}

// The TUI keeps two separately deployed Gateways, switches between them and back, and shows each
// one's own Tags and conversations. No cached entry, credential, or stream crosses from one to the
// other, and after one Gateway restarts at the same address the TUI reconnects to it.
func TestTwoGatewaysKeepConversationsCachesAndStreamsApartAndReconnectAfterARestart(t *testing.T) {
	const alphaMarker, betaMarker = "Alpha secret plan", "Beta release notes"
	// Rereads end each command chain at once instead of after their default delays.
	savedTags, savedHosts := tagRefresh, hostRefresh
	tagRefresh, hostRefresh = time.Millisecond, time.Millisecond
	t.Cleanup(func() { tagRefresh, hostRefresh = savedTags, savedHosts })
	alpha := conversationGateway("alpha-token", "operator:alpha", "builder", alphaMarker)
	beta := conversationGateway("beta-token", "operator:beta", "reviewer", betaMarker)
	alphaServer, betaServer := alpha.start(t), beta.start(t)
	targets := []client.Target{
		{Name: "alpha", URL: alphaServer.URL, Token: "alpha-token"},
		{Name: "beta", URL: betaServer.URL, Token: "beta-token"},
	}
	var started []context.Context
	root, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	a, err := newApp(root, cachingConnector(&started), targets, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.stop)
	a.Update(tea.WindowSizeMsg{Width: 120, Height: 30})
	runApp(t, a, a.Init())
	shows := func(want, not string) {
		t.Helper()
		s := appScreen(a)
		if !strings.Contains(s, want) || strings.Contains(s, not) {
			t.Fatalf("want %q and not %q on screen:\n%s", want, not, s)
		}
	}
	shows(alphaMarker, betaMarker)
	shows("builder", "reviewer")

	switchTo := func(keys ...tea.KeyPressMsg) {
		t.Helper()
		a.Update(tea.KeyPressMsg{Code: 'p', Mod: tea.ModCtrl})
		var cmd tea.Cmd
		for _, k := range keys {
			_, cmd = a.Update(k)
		}
		runApp(t, a, cmd)
	}
	switchTo(key(tea.KeyDown), key(tea.KeyEnter))
	if started[0].Err() == nil {
		t.Fatal("switching to Beta must end Alpha's streams and calls")
	}
	shows(betaMarker, alphaMarker)
	shows("reviewer", "builder")

	switchTo(key(tea.KeyUp), key(tea.KeyEnter))
	if started[1].Err() == nil {
		t.Fatal("switching back must end Beta's streams and calls")
	}
	shows(alphaMarker, betaMarker)

	// Each Gateway's conversation is cached under its own directory, never beside the other's.
	alphaFiles, betaFiles := cachedWith(t, alphaMarker), cachedWith(t, betaMarker)
	if len(alphaFiles) == 0 || len(betaFiles) == 0 {
		t.Fatalf("each Gateway's conversation must be cached: alpha %v, beta %v", alphaFiles, betaFiles)
	}
	for _, af := range alphaFiles {
		for _, bf := range betaFiles {
			if filepath.Dir(af) == filepath.Dir(bf) {
				t.Fatalf("Alpha and Beta share a cache directory: %s", filepath.Dir(af))
			}
		}
	}

	// Alpha restarts at the same address; the TUI reconnects to it when it comes back to it.
	address := alphaServer.Listener.Addr().String()
	alphaServer.Close()
	alpha.startAt(t, address)
	switchTo(key(tea.KeyDown), key(tea.KeyEnter))
	shows(betaMarker, alphaMarker)
	switchTo(key(tea.KeyUp), key(tea.KeyEnter))
	shows(alphaMarker, betaMarker)

	for name, f := range map[string]*fakeGateway{"alpha": alpha, "beta": beta} {
		f.mu.Lock()
		bad := f.badAuth
		f.mu.Unlock()
		if bad != 0 {
			t.Fatalf("%d calls reached %s with another Gateway's credential", bad, name)
		}
	}
}
