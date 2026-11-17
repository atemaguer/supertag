package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/apps/tui/views"
	v2 "github.com/atemaguer/supertag/sdks/go/runtimev2"
	rpc "github.com/atemaguer/supertag/sdks/go/runtimev2/runtimev2connect"
)

// fakeSchedules serves a Tag's Schedules, changing their state as asked.
type fakeSchedules struct {
	rpc.UnimplementedSchedulesHandler
	mu        sync.Mutex
	schedules []*v2.Schedule
	changes   []string
}

func (f *fakeSchedules) List(_ context.Context, req *connect.Request[v2.ListSchedulesRequest]) (*connect.Response[v2.ListSchedulesResponse], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*v2.Schedule
	for _, schedule := range f.schedules {
		if schedule.GetTagId() == req.Msg.GetTagId() {
			out = append(out, schedule)
		}
	}
	return connect.NewResponse(&v2.ListSchedulesResponse{Schedules: out}), nil
}

func (f *fakeSchedules) change(id, action string, state v2.ScheduleState) (*connect.Response[v2.Schedule], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.changes = append(f.changes, action+" "+id)
	for _, schedule := range f.schedules {
		if schedule.GetScheduleId() == id {
			schedule.State = state
			return connect.NewResponse(schedule), nil
		}
	}
	return nil, connect.NewError(connect.CodeNotFound, nil)
}

func (f *fakeSchedules) Pause(_ context.Context, req *connect.Request[v2.GetScheduleRequest]) (*connect.Response[v2.Schedule], error) {
	return f.change(req.Msg.GetScheduleId(), "pause", v2.ScheduleState_SCHEDULE_STATE_PAUSED)
}

func (f *fakeSchedules) Resume(_ context.Context, req *connect.Request[v2.GetScheduleRequest]) (*connect.Response[v2.Schedule], error) {
	return f.change(req.Msg.GetScheduleId(), "resume", v2.ScheduleState_SCHEDULE_STATE_ACTIVE)
}

func (f *fakeSchedules) Delete(_ context.Context, req *connect.Request[v2.GetScheduleRequest]) (*connect.Response[v2.Schedule], error) {
	return f.change(req.Msg.GetScheduleId(), "delete", v2.ScheduleState_SCHEDULE_STATE_CANCELLED)
}

func schedulesApp(t *testing.T, fake *fakeSchedules) *app {
	t.Helper()
	mux := http.NewServeMux()
	mux.Handle(rpc.NewSchedulesHandler(fake))
	handleNegotiation(mux)
	server := httptest.NewUnstartedServer(mux)
	server.Config.Protocols = new(http.Protocols)
	server.Config.Protocols.SetUnencryptedHTTP2(true)
	server.Start()
	t.Cleanup(server.Close)
	a, err := newApp(t.Context(), dial("test"), []client.Target{{URL: server.URL, Token: "fixture-token"}}, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.stop)
	a.inner.tags, a.inner.selected = runtimeTestTags(), 0
	a.Update(tea.WindowSizeMsg{Width: 140, Height: 30})
	return a
}

// deliver runs a Control Plane command the dialog started and hands its result back.
func deliver(t *testing.T, a *app, cmd tea.Cmd) {
	t.Helper()
	if cmd == nil {
		t.Fatal("no Control Plane call started")
	}
	a.Update(cmd())
}

func TestTheSchedulesDialogPausesResumesAndDeletesTheTagsSchedules(t *testing.T) {
	next := time.Date(2026, 11, 23, 9, 0, 0, 0, time.Local).UnixMilli()
	fake := &fakeSchedules{schedules: []*v2.Schedule{
		{ScheduleId: "weekly", TagId: "lead", Note: "Summarise the week", State: v2.ScheduleState_SCHEDULE_STATE_ACTIVE,
			Every: &v2.ScheduleRecurrence{Cron: "0 9 * * 1", TimeZone: "Europe/Berlin"}, NextDueAtMs: &next, CreatedBy: "operator:local"},
		{ScheduleId: "old", TagId: "lead", Note: "Done once", State: v2.ScheduleState_SCHEDULE_STATE_DONE},
		{ScheduleId: "other", TagId: "reviewer", Note: "Someone else's", State: v2.ScheduleState_SCHEDULE_STATE_ACTIVE},
	}}
	a := schedulesApp(t, fake)
	a.Update(ctrlK)
	typeApp(t, a, "Schedules")
	_, cmd := a.Update(key(tea.KeyEnter))
	deliver(t, a, cmd)
	s := appScreen(a)
	if !strings.Contains(s, "Schedules · Engineering Lead") ||
		!strings.Contains(s, "Summarise the week  ·  every 0 9 * * 1 (Europe/Berlin)  ·  next Mon Nov 23 09:00  ·  by operator:local") {
		t.Fatalf("Schedule not shown:\n%s", s)
	}
	if strings.Contains(s, "Done once") || strings.Contains(s, "Someone else's") {
		t.Fatalf("a finished or another Tag's Schedule is shown:\n%s", s)
	}

	_, cmd = a.Update(letter('p'))
	deliver(t, a, cmd)
	if s := appScreen(a); !strings.Contains(s, "Summarise the week  ·  every 0 9 * * 1 (Europe/Berlin)  ·  paused") {
		t.Fatalf("pause not shown:\n%s", s)
	}
	_, cmd = a.Update(letter('p'))
	deliver(t, a, cmd)
	_, cmd = a.Update(letter('x'))
	deliver(t, a, cmd)
	if s := appScreen(a); !strings.Contains(s, "This Tag has no Schedules that will fire.") {
		t.Fatalf("deleted Schedule still shown:\n%s", s)
	}
	if got := strings.Join(fake.changes, ", "); got != "pause weekly, resume weekly, delete weekly" {
		t.Fatalf("changes: %s", got)
	}
	a.Update(key(tea.KeyEscape))
	if a.schedules != nil {
		t.Fatal("esc left the dialog open")
	}
}

func TestTheSchedulesDialogRereadsWhenTheWatchReportsItsTagsSchedules(t *testing.T) {
	fake := &fakeSchedules{}
	a := schedulesApp(t, fake)
	deliver(t, a, a.openSchedules())
	if s := appScreen(a); !strings.Contains(s, "This Tag has no Schedules that will fire.") {
		t.Fatalf("empty list not shown:\n%s", s)
	}
	fake.mu.Lock()
	fake.schedules = append(fake.schedules, &v2.Schedule{ScheduleId: "daily", TagId: "lead", Note: "Check CI", State: v2.ScheduleState_SCHEDULE_STATE_ACTIVE})
	fake.mu.Unlock()

	other := client.WatchUpdate{Kind: client.WatchChanged, Change: &views.WatchChange{Kind: views.WatchKind_WATCH_KIND_SCHEDULE, Id: "x", Tag: "reviewer"}}
	if cmd := a.schedulesWatched(watchMsg{update: other}); cmd != nil {
		t.Fatal("another Tag's Schedule reread the list")
	}
	ours := client.WatchUpdate{Kind: client.WatchChanged, Change: &views.WatchChange{Kind: views.WatchKind_WATCH_KIND_SCHEDULE, Id: "daily", Tag: "lead"}}
	deliver(t, a, a.schedulesWatched(watchMsg{update: ours}))
	if s := appScreen(a); !strings.Contains(s, "Check CI") {
		t.Fatalf("watched change not shown:\n%s", s)
	}
}
