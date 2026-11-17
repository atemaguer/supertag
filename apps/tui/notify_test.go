package main

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/atemaguer/supertag/apps/tui/views"
)

func listed(tag string, latest uint64, unread int32, preview string) *views.Conversation {
	return &views.Conversation{Tag: tag, PreviewFromTag: true, LatestOrder: latest, UnreadCount: unread, Preview: preview}
}

func known(conversations ...*views.Conversation) map[string]*views.Conversation {
	out := map[string]*views.Conversation{}
	for _, c := range conversations {
		out[c.Tag] = c
	}
	return out
}

func TestAlertsCoverRepliesAndQuestionsNotInFront(t *testing.T) {
	before := known(listed("lead", 1, 0, ""))
	reply := listed("lead", 2, 1, "The fix for #412 is ready\nDetails")
	if got := alertsFor(nil, []*views.Conversation{reply}, "", true, notifyAll); got != nil {
		t.Fatalf("the first read only sets what is known: %v", got)
	}
	got := alertsFor(before, []*views.Conversation{reply}, "moss", true, notifyAll)
	if len(got) != 1 || got[0] != (alert{tag: "lead", text: "The fix for #412 is ready"}) {
		t.Fatalf("alerts = %+v", got)
	}
	// The conversation in front of a focused terminal never notifies; in the background it does.
	if got := alertsFor(before, []*views.Conversation{reply}, "lead", true, notifyAll); got != nil {
		t.Fatalf("in front: %v", got)
	}
	if got := alertsFor(before, []*views.Conversation{reply}, "lead", false, notifyAll); len(got) != 1 {
		t.Fatalf("in the background: %v", got)
	}
	own := &views.Conversation{Tag: "lead", LatestOrder: 2, Preview: "Hi"}
	running := &views.Conversation{Tag: "lead", PreviewFromTag: true, LatestOrder: 2, Working: true}
	for _, c := range []*views.Conversation{own, running} {
		if got := alertsFor(before, []*views.Conversation{c}, "", true, notifyAll); got != nil {
			t.Fatalf("%+v notified: %v", c, got)
		}
	}
	three := listed("lead", 5, 3, "Third")
	if got := alertsFor(known(reply), []*views.Conversation{three}, "", true, notifyAll); got[0].text != "3 new messages" {
		t.Fatalf("coalesced = %+v", got)
	}
	question := listed("lead", 6, 4, "Which branch should I release?")
	question.Asking = true
	got = alertsFor(known(three), []*views.Conversation{question}, "", true, notifyQuestions)
	if len(got) != 1 || !got[0].question || got[0].text != "Which branch should I release?" {
		t.Fatalf("question = %+v", got)
	}
	if got := alertsFor(known(reply), []*views.Conversation{three}, "", true, notifyQuestions); got != nil {
		t.Fatalf("questions only: %v", got)
	}
	if got := alertsFor(known(three), []*views.Conversation{question}, "", true, notifyOff); got != nil {
		t.Fatalf("off: %v", got)
	}
}

func TestNotifyLevelsAndSequences(t *testing.T) {
	for value, want := range map[string]notifyLevel{"": notifyAll, "all": notifyAll, " Questions ": notifyQuestions, "bell": notifyBell, "off": notifyOff} {
		if got := notifyLevelFrom(value); got != want {
			t.Fatalf("%q = %v, want %v", value, got, want)
		}
	}
	if notifyCmd(nil, notifyAll) != nil {
		t.Fatal("nothing to say makes no sequence")
	}
	alerts := []alert{{tag: "lead", text: "Done\x1b]0;evil\x07"}}
	raw, ok := notifyCmd(alerts, notifyAll)().(tea.RawMsg)
	if !ok || raw.Msg != "\x1b]9;lead: Done ]0;evil \a" {
		t.Fatalf("OSC 9 = %q", raw.Msg)
	}
	if raw := notifyCmd(alerts, notifyBell)().(tea.RawMsg); raw.Msg != "\a" {
		t.Fatalf("bell = %q", raw.Msg)
	}
}

func TestTheStatusLineCountsUnreadAndQuietTurnsLeave(t *testing.T) {
	summaries := known(listed("lead", 2, 2, ""), listed("moss", 3, 1, ""), listed("finch", 1, 0, ""))
	if got := unreadTotal(summaries, ""); got != 3 {
		t.Fatalf("total = %d", got)
	}
	if got := unreadTotal(summaries, "lead"); got != 1 {
		t.Fatalf("without the one in front = %d", got)
	}
	m := testModel(t, &fakeGateway{tags: tags("lead", "moss")})
	m.summaries = summaries
	if !strings.Contains(screen(m), "3 unread") {
		t.Fatalf("status line:\n%s", screen(m))
	}
	if !m.View().ReportFocus {
		t.Fatal("the terminal reports focus")
	}
	m = update(t, m, tea.BlurMsg{})
	if !m.blurred {
		t.Fatal("blur is recorded")
	}

	h := runtimeHistory{turns: map[string]*runtimeTurn{"hello": {order: 1}, "check": {order: 2}}, order: []string{"hello", "check"}}
	h.remove("check")
	if len(h.order) != 1 || h.order[0] != "hello" || h.turns["check"] != nil {
		t.Fatalf("history = %+v", h)
	}
}
