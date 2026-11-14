package main

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"connectrpc.com/connect"
	"github.com/charmbracelet/x/ansi"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/apps/tui/views"
)

// testConnector builds models as testModel does, without the watch stream, and records the
// context each was given.
func testConnector(contexts *[]context.Context) connector {
	return func(ctx context.Context, target client.Target) (model, error) {
		c, err := client.New(target, "test")
		if err != nil {
			return model{}, err
		}
		*contexts = append(*contexts, ctx)
		f := &client.Follower{Client: c, Interval: time.Millisecond, IdleTimeout: time.Second, ReconnectTimeout: time.Second, WorkTimeout: time.Second}
		return newModel(ctx, c, f, nil), nil
	}
}

// runApp feeds cmd's messages back into the app until no command is left, as run does for a
// model. A poll tick, a Worker Host tick or the input cursor's blink ends its chain.
func runApp(t *testing.T, a *app, cmd tea.Cmd) {
	t.Helper()
	queue := []tea.Cmd{cmd}
	for len(queue) > 0 {
		next := queue[0]
		queue = queue[1:]
		if next == nil {
			continue
		}
		msg := next()
		inner := msg
		if s, ok := msg.(scoped); ok {
			inner = s.msg
		}
		if strings.HasPrefix(fmt.Sprintf("%T", inner), "cursor.") {
			continue
		}
		switch msg := msg.(type) {
		case nil:
		case tea.BatchMsg:
			queue = append(queue, msg...)
		default:
			switch inner.(type) {
			case pollMsg, hostTickMsg:
				continue
			}
			_, cmd := a.Update(msg)
			queue = append(queue, cmd)
		}
	}
}

func appScreen(a *app) string { return ansi.Strip(a.View().Content) }

func host(id string, phase views.WorkerHostPhase) *views.WorkerHost {
	return &views.WorkerHost{Metadata: &views.Metadata{Id: id, Name: id}, Phase: phase}
}

func TestTheStatusBarSummarizesTheWorkerHosts(t *testing.T) {
	fake := &fakeControlPlane{tags: tags("alpha"), hostList: func() []*views.WorkerHost {
		return []*views.WorkerHost{
			host("laptop", views.WorkerHostPhase_WORKER_HOST_PHASE_READY),
			host("ci", views.WorkerHostPhase_WORKER_HOST_PHASE_READY),
			host("old", views.WorkerHostPhase_WORKER_HOST_PHASE_REVOKED),
			host("modal", views.WorkerHostPhase_WORKER_HOST_PHASE_UNREACHABLE),
			host("box", views.WorkerHostPhase_WORKER_HOST_PHASE_DRAINING),
		}
	}}
	m := start(t, testModel(t, fake))
	if strings.Contains(screen(m), "Worker Hosts") {
		t.Fatalf("the summary shows before the hosts are read:\n%s", screen(m))
	}
	m = run(t, m, m.reloadHosts())
	if !strings.Contains(screen(m), "Worker Hosts: 2 ready, 1 draining, 1 offline") {
		t.Fatalf("screen:\n%s", screen(m))
	}

	fake.hostList = func() []*views.WorkerHost { return nil }
	m = run(t, m, m.reloadHosts())
	if !strings.Contains(screen(m), "no Worker Hosts") {
		t.Fatalf("screen:\n%s", screen(m))
	}

	fake.hostErr = connect.NewError(connect.CodeUnimplemented, nil)
	m = run(t, m, m.reloadHosts())
	if strings.Contains(screen(m), "Worker Host") {
		t.Fatalf("a refused read must hide the summary:\n%s", screen(m))
	}
	if !m.connected {
		t.Fatalf("a refused Worker Host read must not mark the Control Plane unreachable: %q", m.status)
	}
}

func TestTheHostTickRereadsTheWorkerHosts(t *testing.T) {
	fake := &fakeControlPlane{tags: tags("alpha")}
	m := testModel(t, fake)
	next, cmd := m.Update(hostTickMsg{})
	m = next.(model)
	if cmd == nil {
		t.Fatal("a host tick must reread the Worker Hosts and schedule the next tick")
	}
	m = run(t, m, m.hostsCmd())
	fake.mu.Lock()
	reads := fake.hostReads
	fake.mu.Unlock()
	if reads == 0 || !m.hostsKnown {
		t.Fatalf("hosts were not read: reads=%d known=%v", reads, m.hostsKnown)
	}
}

func TestSwitchingControlPlanesStartsAFreshModel(t *testing.T) {
	tagRefresh, hostRefresh = time.Millisecond, time.Millisecond
	alpha := &fakeControlPlane{token: "alpha-token", tags: tags("builder"), hostList: func() []*views.WorkerHost {
		return []*views.WorkerHost{host("laptop", views.WorkerHostPhase_WORKER_HOST_PHASE_READY)}
	}}
	beta := &fakeControlPlane{token: "beta-token", tags: tags("reviewer", "planner")}
	alphaServer, betaServer := alpha.start(t), beta.start(t)
	contexts := []client.Target{
		{Name: "laptop", URL: alphaServer.URL, Token: "alpha-token"},
		{Name: "team", URL: betaServer.URL, Token: "beta-token"},
	}
	var started []context.Context
	root, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	a, err := newApp(root, testConnector(&started), contexts, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.stop)
	a.Update(tea.WindowSizeMsg{Width: 120, Height: 20})
	runApp(t, a, a.Init())
	if s := appScreen(a); !strings.Contains(s, "laptop · "+alphaServer.URL) || !strings.Contains(s, "builder") ||
		!strings.Contains(s, "Worker Hosts: 1 ready") || !strings.Contains(s, "ctrl+p Control Planes") {
		t.Fatalf("screen:\n%s", s)
	}
	stale := a.scope(a.inner.tagsCmd())

	a.Update(tea.KeyPressMsg{Code: 'p', Mod: tea.ModCtrl})
	if s := appScreen(a); !a.choosing || !strings.Contains(s, "Control Planes") || !strings.Contains(s, "laptop · "+alphaServer.URL+"  (current)") ||
		!strings.Contains(s, "team · "+betaServer.URL) {
		t.Fatalf("the Control Plane list must show both, the current one marked:\n%s", s)
	}
	a.Update(key(tea.KeyDown))
	_, cmd := a.Update(key(tea.KeyEnter))
	if a.choosing || a.current != 1 {
		t.Fatalf("enter must switch: choosing=%v current=%d", a.choosing, a.current)
	}
	if started[0].Err() == nil {
		t.Fatal("switching must end the streams and calls of the Control Plane left")
	}
	runApp(t, a, cmd)
	s := appScreen(a)
	if !strings.Contains(s, "team · "+betaServer.URL) || !strings.Contains(s, "reviewer") || strings.Contains(s, "builder") ||
		!strings.Contains(s, "no Worker Hosts") {
		t.Fatalf("screen after switching:\n%s", s)
	}
	if a.inner.width != 120 {
		t.Fatalf("the new model must get the window size, got width %d", a.inner.width)
	}

	runApp(t, a, stale)
	if s := appScreen(a); strings.Contains(s, "builder") {
		t.Fatalf("a reply to the Control Plane left must be dropped:\n%s", s)
	}
	alpha.mu.Lock()
	beta.mu.Lock()
	badAuth := alpha.badAuth + beta.badAuth
	beta.mu.Unlock()
	alpha.mu.Unlock()
	if badAuth != 0 {
		t.Fatalf("%d requests reached a Control Plane with another's token", badAuth)
	}

	a.Update(tea.KeyPressMsg{Code: 'p', Mod: tea.ModCtrl})
	a.Update(key(tea.KeyEscape))
	if a.choosing || a.current != 1 {
		t.Fatalf("esc must leave the list without switching: choosing=%v current=%d", a.choosing, a.current)
	}
}

func TestOneControlPlaneStillOpensTheListToAddAnother(t *testing.T) {
	fake := &fakeControlPlane{tags: tags("builder")}
	server := fake.start(t)
	var started []context.Context
	a, err := newApp(context.Background(), testConnector(&started), []client.Target{{URL: server.URL, Token: "secret"}}, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.stop)
	a.Update(tea.WindowSizeMsg{Width: 100, Height: 20})
	a.Update(tea.KeyPressMsg{Code: 'p', Mod: tea.ModCtrl})
	if !a.choosing || !strings.Contains(appScreen(a), "a add") {
		t.Fatalf("one Control Plane must still offer adding another:\n%s", appScreen(a))
	}
}

func TestAFailedSwitchKeepsTheCurrentControlPlane(t *testing.T) {
	fake := &fakeControlPlane{tags: tags("builder")}
	server := fake.start(t)
	var started []context.Context
	contexts := []client.Target{{Name: "laptop", URL: server.URL, Token: "secret"}, {Name: "broken", URL: "ftp://nowhere", Token: "t"}}
	a, err := newApp(context.Background(), testConnector(&started), contexts, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.stop)
	a.Update(tea.WindowSizeMsg{Width: 100, Height: 20})
	a.Update(tea.KeyPressMsg{Code: 'p', Mod: tea.ModCtrl})
	a.Update(key(tea.KeyDown))
	a.Update(key(tea.KeyEnter))
	if !a.choosing || a.current != 0 || started[0].Err() != nil || !strings.Contains(appScreen(a), "Control Plane URL must use http, https, ws or wss") {
		t.Fatalf("choosing=%v current=%d screen:\n%s", a.choosing, a.current, appScreen(a))
	}
}

func TestScopingPassesRuntimeMessages(t *testing.T) {
	if msg := scopeTo(1, tea.Quit)(); msg != (tea.QuitMsg{}) {
		t.Fatalf("quit must pass unscoped, got %T", msg)
	}
	if msg := scopeTo(2, func() tea.Msg { return pollMsg{} })(); msg != (scoped{generation: 2, msg: pollMsg{}}) {
		t.Fatalf("got %#v", msg)
	}
	batch, ok := scopeTo(3, tea.Batch(tea.Quit, func() tea.Msg { return hostTickMsg{} }))().(tea.BatchMsg)
	if !ok || len(batch) != 2 || batch[0]() != (tea.QuitMsg{}) || batch[1]() != (scoped{generation: 3, msg: hostTickMsg{}}) {
		t.Fatalf("a batch must scope each of its commands: %#v", batch)
	}
}
