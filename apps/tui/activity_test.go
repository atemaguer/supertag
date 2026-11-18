package main

import (
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/apps/tui/views"
	v2 "github.com/atemaguer/supertag/sdks/go/runtimev2"
)

// The palette's Activity shows how the Tag's unprompted messages landed and its start rate, and
// rereads when one of the Tag's Tasks changes.
func TestActivityShowsAttentionAndStartRate(t *testing.T) {
	fake := &fakeGateway{tags: tags("lead")}
	a := testApp(t, fake, nil)
	pressApp(t, a, ctrlK)
	typeApp(t, a, "Activity")
	pressApp(t, a, key(tea.KeyEnter))
	if a.activity == nil {
		t.Fatalf("Activity did not open:\n%s", appScreen(a))
	}
	s := appScreen(a)
	for _, want := range []string{"Activity · lead", "Unprompted, last 30 days", "lead sent nothing unprompted.", "Start rate", "None"} {
		if !strings.Contains(s, want) {
			t.Errorf("the empty activity lacks %q:\n%s", want, s)
		}
	}
	fake.mu.Lock()
	fake.tagActivity = &v2.Tag{
		Attention:      &v2.AttentionSummary{WindowDays: 30, Posted: 6, Read: 4, Answered: 2, Quiet: 19},
		StartRate:      &v2.StartRate{Starts: 10, PerMs: 3_600_000},
		StartsInWindow: 3,
		IdleObjectives: []*v2.IdleObjective{{ObjectiveId: "ship", Outcome: "Ship SSO\nwith tests",
			IdleSinceMs: time.Now().UnixMilli()}},
	}
	fake.mu.Unlock()
	if cmd := a.activityWatched(watchMsg{update: client.WatchUpdate{Kind: client.WatchChanged,
		Change: &views.WatchChange{Kind: views.WatchKind_WATCH_KIND_TASK, Id: "t", Tag: "other"}}}); cmd != nil {
		t.Fatal("another Tag's Task reread this activity")
	}
	runApp(t, a, a.activityWatched(watchMsg{update: client.WatchUpdate{Kind: client.WatchChanged,
		Change: &views.WatchChange{Kind: views.WatchKind_WATCH_KIND_TASK, Id: "t", Tag: "lead"}}}))
	s = appScreen(a)
	for _, want := range []string{"6 posted · 4 read · 2 answered · 19 stayed quiet",
		"At most 10 per hour · 3 started in the last hour", "Idle Objectives", "Ship SSO · idle since Today ", "esc back"} {
		if !strings.Contains(s, want) {
			t.Errorf("the activity lacks %q:\n%s", want, s)
		}
	}
	pressApp(t, a, key(tea.KeyEscape))
	if a.activity != nil {
		t.Fatal("esc must close the activity")
	}
}

func TestPeriodWordsMatchTheDesktop(t *testing.T) {
	for period, want := range map[time.Duration]string{
		time.Hour: "hour", 2 * time.Hour: "2 hours", 24 * time.Hour: "day", 30 * time.Minute: "30 minutes",
	} {
		if got := periodWords(period); got != want {
			t.Errorf("periodWords(%v) = %q, want %q", period, got, want)
		}
	}
}
