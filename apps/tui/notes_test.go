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

// The palette's Notes lists the Tag's notes with who sees each and when it was last used, deletes
// one with x, and rereads when the Watch says the Tag's notes changed.
func TestNotesListsTheTagsNotesAndDeletesOne(t *testing.T) {
	alice := "operator:alice"
	seen := time.Now().Add(-time.Hour).UnixMilli()
	fake := &fakeGateway{tags: tags("lead"), memories: []*v2.Memory{
		{MemoryId: "mem_1", TagId: "lead", Text: "Alice prefers squash merges.", Audience: &alice, CreatedAtMs: 1, UpdatedAtMs: 1, LastSeenAtMs: &seen},
		{MemoryId: "mem_2", TagId: "lead", Text: "Release checklist: docs/release.md", CreatedAtMs: 1, UpdatedAtMs: 1},
		{MemoryId: "mem_other", TagId: "other", Text: "Not this Tag's"},
	}}
	a := testApp(t, fake, nil)
	pressApp(t, a, ctrlK)
	typeApp(t, a, "Notes")
	pressApp(t, a, key(tea.KeyEnter))
	if a.notes == nil {
		t.Fatalf("Notes did not open:\n%s", appScreen(a))
	}
	s := appScreen(a)
	for _, want := range []string{"Notes · lead", "Alice prefers squash merges.", "only you · kept", "last used",
		"Release checklist", "shared · kept", "not used yet", "x deletes"} {
		if !strings.Contains(s, want) {
			t.Errorf("the notes lack %q:\n%s", want, s)
		}
	}
	if strings.Contains(s, "Not this Tag's") {
		t.Fatalf("another Tag's note showed:\n%s", s)
	}
	pressApp(t, a, letter('x'))
	if len(fake.deleted) != 1 || fake.deleted[0] != "mem_1" {
		t.Fatalf("deleted = %v", fake.deleted)
	}
	if s := appScreen(a); strings.Contains(s, "Alice prefers") || !strings.Contains(s, "Release checklist") {
		t.Fatalf("after delete:\n%s", s)
	}

	// Another client keeps a note: the Watch names the Tag and the list rereads.
	fake.mu.Lock()
	fake.memories = append([]*v2.Memory{{MemoryId: "mem_3", TagId: "lead", Text: "Deploys need a second reviewer."}}, fake.memories...)
	fake.mu.Unlock()
	cmd := a.notesWatched(watchMsg{update: client.WatchUpdate{Kind: client.WatchChanged,
		Change: &views.WatchChange{Kind: views.WatchKind_WATCH_KIND_MEMORY, Id: "mem_3", Tag: "other"}}})
	if cmd != nil {
		t.Fatal("another Tag's note change reread this list")
	}
	runApp(t, a, a.notesWatched(watchMsg{update: client.WatchUpdate{Kind: client.WatchChanged,
		Change: &views.WatchChange{Kind: views.WatchKind_WATCH_KIND_MEMORY, Id: "mem_3", Tag: "lead"}}}))
	if s := appScreen(a); !strings.Contains(s, "Deploys need a second reviewer.") {
		t.Fatalf("the watched change did not reread:\n%s", s)
	}
	pressApp(t, a, key(tea.KeyEscape))
	if a.notes != nil {
		t.Fatal("esc must close the notes")
	}
}

func TestNotesSayWhenTheTagKeepsNone(t *testing.T) {
	a := testApp(t, &fakeGateway{tags: tags("lead")}, nil)
	runApp(t, a, a.openNotes())
	if s := appScreen(a); !strings.Contains(s, "lead keeps no notes you can see yet") {
		t.Fatalf("empty notes:\n%s", s)
	}
}
