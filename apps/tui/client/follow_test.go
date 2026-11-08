package client

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeControlPlane serves one message's reply stream and then, on each reread after the reply,
// the next of its records (staying at the last).
type fakeControlPlane struct {
	mu       sync.Mutex
	replied  bool
	records  []MessageRecord
	streams  map[string]string
	waiting  MessageRecord
	rereadAt int
}

func (f *fakeControlPlane) handle(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		requireAuth(t, r)
		path := strings.TrimPrefix(r.URL.Path, "/api/v1/tags/lead/messages/")
		f.mu.Lock()
		defer f.mu.Unlock()
		if task, ok := strings.CutSuffix(path, "/stream"); ok {
			if task == "t1" {
				f.replied = true
			}
			_, _ = fmt.Fprint(w, f.streams[task])
			return
		}
		record := f.waiting
		if f.replied {
			record = f.records[min(f.rereadAt, len(f.records)-1)]
			f.rereadAt++
		}
		_ = json.NewEncoder(w).Encode(record)
	}
}

func sse(parts ...string) string {
	var b strings.Builder
	b.WriteString(": keepalive\n\n")
	for i, part := range parts {
		fmt.Fprintf(&b, "id: %d\ndata: %s\n\n", i+1, part)
	}
	b.WriteString("data: [DONE]\n\n")
	return b.String()
}

func collect(t *testing.T, f *Follower, record MessageRecord) []FollowEvent {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var events []FollowEvent
	for event := range f.Follow(ctx, "lead", record) {
		events = append(events, event)
	}
	if ctx.Err() != nil {
		t.Fatal("follow did not finish")
	}
	return events
}

// lines renders events the way the UI's conversation shows them, leaving out activity, whose
// order against records is not fixed.
func lines(events []FollowEvent) []string {
	var out []string
	for _, e := range events {
		switch e.Kind {
		case EventWaiting:
			out = append(out, "waiting: "+e.Text)
		case EventDelta:
			out = append(out, "delta: "+e.Text)
		case EventReply:
			out = append(out, "reply: "+e.Reply.Text)
		case EventWorking:
			out = append(out, "working: "+e.Title)
		case EventReport:
			out = append(out, e.Status+": "+e.Title+": "+e.Text)
		case EventApproval:
			out = append(out, "approval needed: "+e.Title+": "+e.Text)
		case EventNotContinued:
			out = append(out, "not continued: "+e.Title)
		case EventError:
			out = append(out, "error: "+e.Text)
		}
	}
	return out
}

func activities(events []FollowEvent) []string {
	var out []string
	for _, e := range events {
		if e.Kind == EventActivity {
			out = append(out, fmt.Sprintf("%v %s", e.Indent, e.Text))
		}
	}
	return out
}

func testFollower(c *Client) *Follower {
	return &Follower{Client: c, Interval: 5 * time.Millisecond, ReplyTimeout: 2 * time.Second, WorkTimeout: 2 * time.Second}
}

func equal(t *testing.T, got, want []string) {
	t.Helper()
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("got\n  %s\nwant\n  %s", strings.Join(got, "\n  "), strings.Join(want, "\n  "))
	}
}

func TestFollowReplyThenWorkSession(t *testing.T) {
	reply := &Reply{Presentation: "markdown", Text: "I started a work Session."}
	running := StartedSession{ID: "s1", Title: "Fix discount", TaskID: "w1", Status: "running", ReportStatus: "waiting"}
	done := running
	done.Status, done.ReportStatus, done.Report = "completed", "replied", &Reply{Presentation: "markdown", Text: "Fixed."}
	fake := &fakeControlPlane{
		waiting: MessageRecord{TaskID: "t1", Session: "default", Status: "waiting", Waiting: "no bound Worker Host"},
		records: []MessageRecord{
			{TaskID: "t1", Status: "replied", Reply: reply, StartedSessions: []StartedSession{running}},
			{TaskID: "t1", Status: "replied", Reply: reply, StartedSessions: []StartedSession{running}},
			{TaskID: "t1", Status: "replied", Reply: reply, StartedSessions: []StartedSession{done}},
		},
		streams: map[string]string{
			"t1": sse(`{"type":"start"}`,
				`{"type":"data-activity","data":{"kind":"command","status":"running","command":"rg discount"}}`,
				`{"type":"text-start","id":"a"}`, `{"type":"text-delta","id":"a","delta":"I started"}`,
				`{"type":"text-end","id":"a"}`,
				`{"type":"finish","messageMetadata":{"reply":{"presentation":"markdown","text":"I started a work Session."}}}`),
			"w1": sse(`{"type":"data-activity","data":{"kind":"tool","status":"running","tool":"edit"}}`,
				`{"type":"text-delta","id":"b","delta":"hidden"}`, `{"type":"finish"}`),
		},
	}
	c := newTestClient(t, fake.handle(t))
	events := collect(t, testFollower(c), fake.waiting)
	equal(t, lines(events), []string{
		"waiting: no bound Worker Host",
		"delta: I started",
		"reply: I started a work Session.",
		"working: Fix discount",
		"done: Fix discount: Fixed.",
	})
	equal(t, activities(events), []string{"false · running: rg discount", "true · using: edit"})
}

func TestFollowApprovalContinuesTheSession(t *testing.T) {
	reply := &Reply{Presentation: "markdown", Text: "On it."}
	waiting := StartedSession{ID: "s1", Title: "Push", TaskID: "w1", Status: "waiting", ReportStatus: "replied",
		Approvals: []Approval{{RequestID: "r1", Text: "Push to main?"}}, Report: &Reply{Text: "Needs approval."}}
	continued := StartedSession{ID: "s1", Title: "Push", TaskID: "w2", Status: "running", ReportStatus: "waiting"}
	done := continued
	done.Status, done.ReportStatus, done.Report = "completed", "replied", &Reply{Text: "Pushed."}
	fake := &fakeControlPlane{
		records: []MessageRecord{
			{TaskID: "t1", Status: "replied", Reply: reply, StartedSessions: []StartedSession{waiting}},
			{TaskID: "t1", Status: "replied", Reply: reply, StartedSessions: []StartedSession{waiting}},
			{TaskID: "t1", Status: "replied", Reply: reply, StartedSessions: []StartedSession{continued}},
			{TaskID: "t1", Status: "replied", Reply: reply, StartedSessions: []StartedSession{done}},
		},
		streams: map[string]string{"w2": sse(`{"type":"finish"}`)},
	}
	fake.replied = true
	c := newTestClient(t, fake.handle(t))
	events := collect(t, testFollower(c), MessageRecord{TaskID: "t1", Status: "replied", Reply: reply})
	equal(t, lines(events), []string{
		"reply: On it.",
		"working: Push",
		"approval needed: Push: Push to main?",
		"waiting for approval: Push: Needs approval.",
		"working: Push",
		"done: Push: Pushed.",
	})
}

func TestFollowErrorPart(t *testing.T) {
	fake := &fakeControlPlane{
		waiting: MessageRecord{TaskID: "t1", Status: "waiting"},
		records: []MessageRecord{{TaskID: "t1", Status: "replied"}},
		streams: map[string]string{"t1": sse(`{"type":"error","errorText":"model unavailable"}`)},
	}
	c := newTestClient(t, fake.handle(t))
	equal(t, lines(collect(t, testFollower(c), fake.waiting)), []string{"error: Tag lead could not answer: model unavailable"})
}

func TestFollowPollsWhenTheStreamCloses(t *testing.T) {
	fake := &fakeControlPlane{
		waiting: MessageRecord{TaskID: "t1", Status: "waiting"},
		records: []MessageRecord{{TaskID: "t1", Status: "replied", Reply: &Reply{Text: "late"}}},
		streams: map[string]string{"t1": "data: [DONE]\n\n"},
	}
	c := newTestClient(t, fake.handle(t))
	equal(t, lines(collect(t, testFollower(c), fake.waiting)), []string{"reply: late"})
}

func TestFollowWorkSurvivesAControlPlaneRestart(t *testing.T) {
	reply := &Reply{Presentation: "markdown", Text: "On it."}
	running := StartedSession{ID: "s1", Title: "Validate percent", TaskID: "w1", Status: "running", ReportStatus: "waiting"}
	done := running
	done.Status, done.ReportStatus, done.Report = "completed", "replied", &Reply{Text: "Fixed."}
	var mu sync.Mutex
	rereads := 0
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/stream") {
			_, _ = fmt.Fprint(w, sse(`{"type":"finish"}`))
			return
		}
		mu.Lock()
		rereads++
		n := rereads
		mu.Unlock()
		switch {
		case n == 2:
			// The Control Plane drops the connection while it restarts.
			conn, _, _ := w.(http.Hijacker).Hijack()
			_ = conn.Close()
		case n == 3:
			w.WriteHeader(http.StatusBadGateway)
		case n < 5:
			_ = json.NewEncoder(w).Encode(MessageRecord{TaskID: "t1", Status: "replied", Reply: reply, StartedSessions: []StartedSession{running}})
		default:
			_ = json.NewEncoder(w).Encode(MessageRecord{TaskID: "t1", Status: "replied", Reply: reply, StartedSessions: []StartedSession{done}})
		}
	})
	events := collect(t, testFollower(c), MessageRecord{TaskID: "t1", Status: "replied", Reply: reply})
	equal(t, lines(events), []string{"reply: On it.", "working: Validate percent", "done: Validate percent: Fixed."})
}

func TestFollowSkipsAMessageJoinedIntoTheRunningTurn(t *testing.T) {
	streaming, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/v1/tags/lead/messages/")
		switch path {
		case "t1/stream":
			_, _ = fmt.Fprint(w, "id: 1\ndata: {\"type\":\"text-delta\",\"delta\":\"I will\"}\n\n")
			w.(http.Flusher).Flush()
			once.Do(func() { close(streaming) })
			<-release
			_, _ = fmt.Fprint(w, "id: 2\ndata: {\"type\":\"finish\",\"messageMetadata\":{\"reply\":{\"presentation\":\"markdown\",\"text\":\"Done both.\"}}}\n\ndata: [DONE]\n\n")
		case "t2/stream":
			t.Error("the joined message's stream repeats the running turn's and must not be followed")
		case "t1":
			_ = json.NewEncoder(w).Encode(MessageRecord{TaskID: "t1", Status: "replied", Reply: &Reply{Text: "Done both."}})
		case "t2":
			_ = json.NewEncoder(w).Encode(MessageRecord{TaskID: "t2", JoinedTaskID: "t1", Status: "waiting"})
		}
	})
	f := testFollower(c)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	first := f.Follow(ctx, "lead", MessageRecord{TaskID: "t1", Status: "waiting"})
	<-streaming
	var second []FollowEvent
	for event := range f.Follow(ctx, "lead", MessageRecord{TaskID: "t2", Status: "waiting"}) {
		second = append(second, event)
	}
	close(release)
	var firstEvents []FollowEvent
	for event := range first {
		firstEvents = append(firstEvents, event)
	}
	equal(t, lines(firstEvents), []string{"delta: I will", "reply: Done both."})
	if len(second) != 1 || second[0].Kind != EventJoined {
		t.Fatalf("second follow = %+v, want only EventJoined", second)
	}
}
