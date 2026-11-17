package main

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/apps/tui/views"
	v2 "github.com/atemaguer/supertag/sdks/go/runtimev2"
)

// The palette's Network shows each Task Attempt's requests, allowed or refused, and rereads when
// one of the Tag's Tasks changes.
func TestNetworkShowsTheTagsNetworkLog(t *testing.T) {
	fake := &fakeControlPlane{tags: tags("lead")}
	a := testApp(t, fake, nil)
	pressApp(t, a, ctrlK)
	typeApp(t, a, "Network")
	pressApp(t, a, key(tea.KeyEnter))
	if a.network == nil {
		t.Fatalf("Network did not open:\n%s", appScreen(a))
	}
	if s := appScreen(a); !strings.Contains(s, "No network log yet.") {
		t.Fatalf("empty log:\n%s", s)
	}
	fake.mu.Lock()
	fake.networkLogs = []*v2.TaskNetworkLog{{TaskId: "9f1c2d3e4b5a", AttemptId: "attempt", Log: &v2.NetworkLog{
		Allowed: 1, Denied: 1, Requests: []*v2.NetworkRequestRecord{
			{Method: "GET", Origin: "https://api.github.com", Path: "/repos/acme", Allowed: true, Status: 200, Credential: "github"},
			{Method: "CONNECT", Origin: "https://example.org", Reason: "origin is not in the Task's network scope"},
		}}}}
	fake.mu.Unlock()
	if cmd := a.networkWatched(watchMsg{update: client.WatchUpdate{Kind: client.WatchChanged,
		Change: &views.WatchChange{Kind: views.WatchKind_WATCH_KIND_TASK, Id: "t", Tag: "other"}}}); cmd != nil {
		t.Fatal("another Tag's Task reread this log")
	}
	runApp(t, a, a.networkWatched(watchMsg{update: client.WatchUpdate{Kind: client.WatchChanged,
		Change: &views.WatchChange{Kind: views.WatchKind_WATCH_KIND_TASK, Id: "t", Tag: "lead"}}}))
	s := appScreen(a)
	for _, want := range []string{"Network · lead", "Task 9f1c2d3e · 1 allowed · 1 refused",
		"GET https://api.github.com/repos/acme → 200 · with github",
		"CONNECT https://example.org refused: origin is not in the Task's network scope", "esc back"} {
		if !strings.Contains(s, want) {
			t.Errorf("the log lacks %q:\n%s", want, s)
		}
	}
	pressApp(t, a, key(tea.KeyEscape))
	if a.network != nil {
		t.Fatal("esc must close the network log")
	}
}

func TestNetworkTellsAClientOnlyOperatorsSeeIt(t *testing.T) {
	a := testApp(t, &fakeControlPlane{tags: tags("lead"), networkRefusal: true}, nil)
	runApp(t, a, a.openNetwork())
	if s := appScreen(a); !strings.Contains(s, "Only operators can see the network log.") {
		t.Fatalf("refused log:\n%s", s)
	}
}
