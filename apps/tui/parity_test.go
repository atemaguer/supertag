package main

import (
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"connectrpc.com/connect"
	"github.com/charmbracelet/x/ansi"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/apps/tui/views"
	v2 "github.com/atemaguer/supertag/sdks/go/runtimev2"
)

// privateCache points the cache at a new private directory for one test.
func privateCache(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "tui")
	previous := cacheDirectory
	cacheDirectory = func() (string, error) { return root, nil }
	t.Cleanup(func() { cacheDirectory = previous })
	return root
}

// driven runs an app as the program would until done says to stop, running commands on their own
// goroutines.
func driven(t *testing.T, a *app, cmd tea.Cmd, done func() bool) {
	t.Helper()
	msgs := make(chan tea.Msg, 256)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	var run func(tea.Cmd)
	run = func(cmd tea.Cmd) {
		if cmd == nil {
			return
		}
		go func() {
			msg := cmd()
			select {
			case msgs <- msg:
			case <-ctx.Done():
			}
		}()
	}
	run(cmd)
	deadline := time.After(10 * time.Second)
	for !done() {
		select {
		case msg := <-msgs:
			switch msg := msg.(type) {
			case nil:
			case tea.BatchMsg:
				for _, cmd := range msg {
					run(cmd)
				}
			default:
				_, cmd := a.Update(msg)
				run(cmd)
			}
		case <-deadline:
			t.Fatalf("timed out; the screen shows:\n%s", ansi.Strip(a.View().Content))
		}
	}
}

func TestTheNextLaunchShowsTheLastConversationBeforeAnyCall(t *testing.T) {
	root := privateCache(t)
	fake, url := firstPaintPlane(t, 0)
	fake.token = "secret"
	launchUntil(t, url, true)

	// Every file is owner-only and none holds the credential.
	files := 0
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if info.Mode().Perm() != 0o700 {
				t.Errorf("%s is %v, want 0700", path, info.Mode().Perm())
			}
			return nil
		}
		files++
		if info.Mode().Perm() != 0o600 {
			t.Errorf("%s is %v, want 0600", path, info.Mode().Perm())
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if strings.Contains(string(data), "secret") {
			t.Errorf("%s holds the credential", path)
		}
		var entryValue stored
		if json.Unmarshal(data, &entryValue) != nil || entryValue.SchemaVersion != cacheSchema {
			t.Errorf("%s is not a versioned entry", path)
		}
		return nil
	})
	if err != nil || files < 3 {
		t.Fatalf("cache files = %d, %v", files, err)
	}

	// The next launch shows the conversation at once, with no call answered.
	a, err := newApp(t.Context(), dial("test"), []client.Target{{URL: url, Token: "secret", Name: "remote"}}, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer a.stop()
	a.Update(tea.WindowSizeMsg{Width: 160, Height: 50})
	got := ansi.Strip(a.View().Content)
	if !strings.Contains(got, "marker-49") || !strings.Contains(got, "I'll look at step 49.") {
		t.Fatalf("the cached conversation is not shown:\n%s", got)
	}
	if c := a.inner.shown(); c == nil || len(c.runtime.order) != cacheTurns {
		t.Fatalf("the cache holds %d turns, want %d", len(c.runtime.order), cacheTurns)
	}

	// Another credential to the same Control Plane shows nothing it has not been told it may see.
	other, err := newApp(t.Context(), dial("test"), []client.Target{{URL: url, Token: "another", Name: "remote"}}, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer other.stop()
	other.Update(tea.WindowSizeMsg{Width: 160, Height: 50})
	if got := ansi.Strip(other.View().Content); strings.Contains(got, "marker-49") {
		t.Fatalf("another credential saw the cached conversation:\n%s", got)
	}
}

func TestACacheEntryOfAnotherSchemaIsDiscarded(t *testing.T) {
	root := privateCache(t)
	cache := openCache("http://127.0.0.1:9")
	if err := cache.write("operator:local", rosterKey, cachedRoster{Tags: []cachedTag{{ID: "lead", Name: "lead"}}}); err != nil {
		t.Fatal(err)
	}
	var roster cachedRoster
	if !cache.read("operator:local", rosterKey, &roster) || len(roster.Tags) != 1 {
		t.Fatal("the entry was not read back")
	}
	path := cache.entry("operator:local", rosterKey)
	if err := os.WriteFile(path, []byte(`{"schemaVersion":2,"value":{"tags":[{"id":"lead"}]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if cache.read("operator:local", rosterKey, &cachedRoster{}) {
		t.Fatal("an entry of another schema was read")
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := cache.write("operator:local", rosterKey, cachedRoster{}); err != nil || !cache.read("operator:local", rosterKey, &roster) {
		t.Fatalf("a rewritten entry was not read: %v", err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if cache.read("operator:local", rosterKey, &roster) {
		t.Fatal("an entry others can read was used")
	}
	cache.forget()
	if _, err := os.Stat(filepath.Join(root, cacheDigest("http://127.0.0.1:9"))); !os.IsNotExist(err) {
		t.Fatalf("forgetting left the Control Plane's cache: %v", err)
	}
}

// outboxPlane is a Control Plane whose SendMessage refuses until accept is set.
func outboxPlane(t *testing.T) (*fakeControlPlane, string) {
	t.Helper()
	fake := &fakeControlPlane{tags: tags("lead"), principal: "operator:local"}
	fake.messages = func(string) *v2.ListMessagesResponse {
		return &v2.ListMessagesResponse{ConversationId: "conversation-lead"}
	}
	return fake, fake.start(t).URL
}

func TestAMessageShowsAtOnceAndWaitsInTheOutboxAcrossLaunches(t *testing.T) {
	privateCache(t)
	tagRefresh = time.Hour
	fake, url := outboxPlane(t)
	a, err := newApp(t.Context(), dial("test"), []client.Target{{URL: url, Token: "secret"}}, 0)
	if err != nil {
		t.Fatal(err)
	}
	a.Update(tea.WindowSizeMsg{Width: 120, Height: 30})
	driven(t, a, a.Init(), func() bool { return a.inner.cache.confirmed && a.inner.conversation("lead").loaded })

	a.inner.input.SetValue("Ship the release notes")
	cmd := a.inner.submit()
	if got := ansi.Strip(a.View().Content); !strings.Contains(got, "Ship the release notes") || !strings.Contains(got, "Sending…") {
		t.Fatalf("the message does not show at once:\n%s", got)
	}
	driven(t, a, cmd, func() bool { return a.inner.undelivered() })
	got := ansi.Strip(a.View().Content)
	if !strings.Contains(got, "! Not delivered") || !strings.Contains(got, "ctrl+r retry") {
		t.Fatalf("an undelivered message does not say so:\n%s", got)
	}
	a.stop()

	// The next launch sends it again with the same operation ID.
	first := fake.sent()
	fake.mu.Lock()
	fake.send = func(req *v2.SendMessageRequest) (*v2.ConversationMessage, error) {
		return &v2.ConversationMessage{Order: 1, SentAtMs: time.Now().UnixMilli(),
			Task: &v2.Task{TaskId: "task-1", TagId: "lead", Prompt: req.GetText(), State: v2.TaskState_TASK_STATE_QUEUED}}, nil
	}
	fake.mu.Unlock()
	b, err := newApp(t.Context(), dial("test"), []client.Target{{URL: url, Token: "secret"}}, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer b.stop()
	b.Update(tea.WindowSizeMsg{Width: 120, Height: 30})
	if got := ansi.Strip(b.View().Content); !strings.Contains(got, "Ship the release notes") {
		t.Fatalf("the outbox did not survive the restart:\n%s", got)
	}
	driven(t, b, b.Init(), func() bool { return len(b.inner.outbox.entries) == 0 && b.inner.shown().runtime.turns["task-1"] != nil })
	sends := fake.sent()
	if len(sends) <= len(first) || sends[len(sends)-1].GetOperationId() != first[0].GetOperationId() {
		t.Fatalf("the resent message has another operation ID: %v then %v", first, sends)
	}
	if got := ansi.Strip(b.View().Content); strings.Count(got, "Ship the release notes") != 1 || !strings.Contains(got, "Sent") {
		t.Fatalf("the accepted message does not show once as sent:\n%s", got)
	}
	b.Update(followMsg{tag: "lead", taskID: "task-1", event: client.FollowEvent{Kind: client.EventStarted}})
	if got := ansi.Strip(b.View().Content); !strings.Contains(got, "Seen") {
		t.Fatalf("a message whose turn started is not seen:\n%s", got)
	}
}

func TestRetryAndEditAnUndeliveredMessage(t *testing.T) {
	m := runtimeModel(t)
	m = update(t, m, runtimePage(0))
	m.input.SetValue("Hello")
	m.submit()
	entry := m.outbox.of("lead")[0]
	m = update(t, m, sentMsg{tag: "lead", operationID: entry.OperationID, err: &client.APIError{Code: connect.CodeUnavailable, Message: "down"}})
	if !m.undelivered() {
		t.Fatal("a failed send is not undelivered")
	}
	next, cmd := m.Update(tea.KeyPressMsg{Code: 'r', Mod: tea.ModCtrl})
	m = next.(model)
	if cmd == nil || !entry.sending {
		t.Fatal("ctrl+r does not send it again")
	}
	m = update(t, m, sentMsg{tag: "lead", operationID: entry.OperationID, err: &client.APIError{Code: connect.CodeUnavailable, Message: "down"}})
	m = update(t, m, tea.KeyPressMsg{Code: 'x', Mod: tea.ModCtrl})
	if m.input.Value() != "Hello" || len(m.outbox.of("lead")) != 0 {
		t.Fatalf("ctrl+x does not take the message back: %q, %d queued", m.input.Value(), len(m.outbox.of("lead")))
	}
}

// at is a time today, at hour:minute.
func at(hour, minute int) time.Time {
	now := time.Now()
	return time.Date(now.Year(), now.Month(), now.Day(), hour, minute, 0, 0, time.Local)
}

func TestTheConversationGroupsSendersAndMarksPauses(t *testing.T) {
	m := runtimeModel(t)
	m.clock = func() time.Time { return at(23, 0) }
	turn := func(id string, order uint64, sent time.Time, said ...string) *views.Message {
		message := ordered(runtimeHistoryMessage(id, "Question "+id, "Answer "+id), order)
		message.CreatedAt = timestamppb.New(sent)
		message.Started = true
		for i, text := range said {
			message.TagMessages = append(message.TagMessages, &views.TagMessage{Sequence: uint64(i + 1), Text: text})
		}
		return message
	}
	m = update(t, m, runtimePage(0,
		turn("third", 3, at(10, 50), "Checking the build."),
		turn("second", 2, at(10, 5), "Looking now.", "Found it."),
		turn("first", 1, at(10, 0))))
	got := ansi.Strip(m.renderConversation())
	if strings.Count(got, "Today 10:00 AM") != 1 || strings.Count(got, "Today 10:50 AM") != 1 || strings.Contains(got, "10:05") {
		t.Fatalf("time dividers are wrong:\n%s", got)
	}
	// The second turn's two messages and its answer form one group under one name.
	second := got[strings.Index(got, "Question second"):strings.Index(got, "Answer second")]
	if strings.Count(second, "Engineering Lead") != 1 || !strings.Contains(second, "Looking now.") || !strings.Contains(second, "Found it.") {
		t.Fatalf("the Tag's messages are not one group:\n%s", second)
	}
	if strings.Count(got, "Seen") != 1 || !strings.Contains(got[strings.Index(got, "Question third"):], "Seen") {
		t.Fatalf("only the operator's last message says it was seen:\n%s", got)
	}
}

func TestTheTypingIndicatorStaysAtTheTailUntilTheResult(t *testing.T) {
	m := runtimeModel(t)
	running := ordered(runtimeHistoryMessage("running", "Fix the build", ""), 1)
	running.Status, running.Reply, running.Started = views.ReplyStatus_REPLY_STATUS_WAITING, nil, true
	items := client.History("lead", []*views.Message{running})
	items[0].Follow = false
	m = update(t, m, historyMsg{tag: "lead", items: items, conversationID: runtimeConversationID})
	if !m.showsTyping() || !m.typing.ticking {
		t.Fatal("a started turn without a line from the Tag shows no typing indicator")
	}
	before := ansi.Strip(m.renderConversation())
	m = update(t, m, typingTickMsg{})
	if after := ansi.Strip(m.renderConversation()); after == before {
		t.Fatal("the typing indicator does not move")
	}
	tail := func() string {
		lines := strings.Split(strings.TrimRight(ansi.Strip(m.renderConversation()), "\n"), "\n")
		return lines[len(lines)-1]
	}
	// The intent and the activity leave the indicator last, with the activity as its caption and
	// no separate status line.
	m = update(t, m, followMsg{tag: "lead", taskID: "running", event: client.FollowEvent{Kind: client.EventMessage, Text: "I'll fix the build.", Sequence: 1}})
	m = update(t, m, followMsg{tag: "lead", taskID: "running", event: client.FollowEvent{Kind: client.EventStatus, Text: "running: go test ./..."}})
	got := ansi.Strip(m.renderConversation())
	if !m.showsTyping() || !strings.Contains(tail(), "running: go test ./...") || strings.Contains(got, "· running:") ||
		strings.Index(got, "I'll fix the build.") > strings.Index(got, "running: go test") {
		t.Fatalf("the indicator is not the running turn's last line with its caption:\n%s", got)
	}
	m = update(t, m, followMsg{tag: "lead", taskID: "running", event: client.FollowEvent{Kind: client.EventReply, Reply: finalReply("Fixed.")}})
	if m.showsTyping() || strings.Contains(ansi.Strip(m.renderConversation()), "go test") || !strings.Contains(tail(), "Fixed.") {
		t.Fatalf("the result does not end the turn:\n%s", ansi.Strip(m.renderConversation()))
	}
}

func TestJumpToLatestCountsWhatArrivedWhileScrolledUp(t *testing.T) {
	m := runtimeModel(t)
	var page []*views.Message
	for i := 30; i >= 1; i-- {
		page = append(page, ordered(runtimeHistoryMessage("t"+string(rune('a'+i)), strings.Repeat("A long question. ", 20), "An answer."), uint64(i)))
	}
	m = update(t, m, runtimePage(0, page...))
	m.viewport.GotoTop()
	m = followed(t, m, client.FollowEvent{Kind: client.EventMessage, Text: "One more thing.", Sequence: 9})
	if !strings.Contains(m.paneTitle(), "↓ 1 new message") {
		t.Fatalf("title = %q", m.paneTitle())
	}
	m = update(t, m, tea.KeyPressMsg{Code: tea.KeyEnd})
	if !m.viewport.AtBottom() || strings.Contains(m.paneTitle(), "new message") {
		t.Fatalf("end does not jump to the latest: %q", m.paneTitle())
	}
}

func TestDraftsAreKeptPerTagAcrossLaunches(t *testing.T) {
	privateCache(t)
	tagRefresh = time.Hour
	fake := &fakeControlPlane{tags: tags("lead", "builder"), principal: "operator:local"}
	url := fake.start(t).URL
	launch := func() *app {
		a, err := newApp(t.Context(), dial("test"), []client.Target{{URL: url, Token: "secret"}}, 0)
		if err != nil {
			t.Fatal(err)
		}
		a.Update(tea.WindowSizeMsg{Width: 120, Height: 30})
		driven(t, a, a.Init(), func() bool { return a.inner.cache.confirmed && len(a.inner.tags) == 2 })
		return a
	}
	a := launch()
	for _, r := range "half a thought" {
		a.Update(tea.KeyPressMsg{Code: r, Text: string(r)})
	}
	a.Update(tea.KeyPressMsg{Code: '2', Mod: tea.ModAlt})
	if a.inner.selectedTag() != "builder" || a.inner.input.Value() != "" {
		t.Fatalf("alt+2 shows %q with %q", a.inner.selectedTag(), a.inner.input.Value())
	}
	for _, r := range "for the builder" {
		a.Update(tea.KeyPressMsg{Code: r, Text: string(r)})
	}
	a.stop()

	b := launch()
	defer b.stop()
	if b.inner.selectedTag() != "builder" || b.inner.input.Value() != "for the builder" {
		t.Fatalf("the next launch shows %q with %q", b.inner.selectedTag(), b.inner.input.Value())
	}
	b.Update(tea.KeyPressMsg{Code: tea.KeyUp, Mod: tea.ModAlt})
	if b.inner.selectedTag() != "lead" || b.inner.input.Value() != "half a thought" {
		t.Fatalf("alt+up shows %q with %q", b.inner.selectedTag(), b.inner.input.Value())
	}
}

func TestTheRailPinsTheLeadAndSortsByActivityFoldsAndResizes(t *testing.T) {
	root := privateCache(t)
	list := tagList("alpha", "beta", "lead", "gamma")
	list[2].Spec = &views.TagSpec{Lead: true}
	fake := &fakeControlPlane{tags: func() ([]*views.Tag, error) { return list, nil }}
	fake.conversations = func() []*v2.Conversation {
		now := time.Now().UnixMilli()
		return []*v2.Conversation{{TagId: "gamma", LastActivityAtMs: now}, {TagId: "alpha", LastActivityAtMs: now - 60_000, UnreadCount: 2}}
	}
	m := start(t, testModel(t, fake))
	var order []string
	for _, tag := range m.tags {
		order = append(order, tagName(tag))
	}
	if strings.Join(order, ",") != "lead,gamma,alpha,beta" {
		t.Fatalf("rail order = %v", order)
	}
	m.rail = loadRailLayout()
	next, cmd := m.Update(tea.KeyPressMsg{Code: 'b', Mod: tea.ModCtrl})
	m = next.(model)
	if cmd != nil {
		cmd()
	}
	rail := ansi.Strip(m.renderRail(9))
	if !m.rail.Collapsed || !strings.Contains(rail, "★LE") || !strings.Contains(rail, " AL•") || m.railWidth() != narrowRailWidth {
		t.Fatalf("the folded rail:\n%s", rail)
	}
	if !loadRailLayout().Collapsed {
		t.Fatal("the folded rail is not kept")
	}
	m = update(t, m, tea.KeyPressMsg{Code: 'b', Mod: tea.ModCtrl})
	m = update(t, m, key(tea.KeyTab))
	next, cmd = m.Update(tea.KeyPressMsg{Code: ']', Text: "]"})
	m = next.(model)
	if cmd != nil {
		cmd()
	}
	if m.railWidth() != defaultRailWidth+railStep || loadRailLayout().Width != defaultRailWidth+railStep {
		t.Fatalf("the rail is %d wide, kept %d", m.railWidth(), loadRailLayout().Width)
	}
	_ = root
}

func TestNewTagCreatesATagWithTheLeadTagsDefaults(t *testing.T) {
	fake := &fakeControlPlane{tags: tags("lead"), hostStatus: []*v2.WorkerHostStatus{
		{HostId: "laptop", HarnessKind: v2.HarnessKind_HARNESS_KIND_CODEX, WorkspaceIds: []string{"supertag"},
			Harnesses: []*v2.HostHarnessCapacity{{HarnessKind: v2.HarnessKind_HARNESS_KIND_CLAUDE_CODE}}},
		{HostId: "gone", HarnessKind: v2.HarnessKind_HARNESS_KIND_CURSOR, RevokedAtMs: new(int64)},
	}}
	fake.tags = func() ([]*views.Tag, error) {
		fake.mu.Lock()
		defer fake.mu.Unlock()
		names := []string{"lead"}
		for _, put := range fake.putTags {
			names = append(names, put.GetTagId())
		}
		return tagList(names...), nil
	}
	m := start(t, testModel(t, fake))
	m = run(t, m, m.openTagForm())
	if m.pane != paneNewTag || m.tagForm.options == nil || strings.Join(m.tagForm.harnesses(), ",") != "claude_code,codex" ||
		m.tagForm.workspace != 1 {
		t.Fatalf("form = %+v", m.tagForm)
	}
	for _, r := range "Release Reviewer" {
		m = update(t, m, tea.KeyPressMsg{Code: r, Text: string(r)})
	}
	if got := screen(m); !strings.Contains(got, "ID: release-reviewer. It cannot change later.") || !strings.Contains(got, "Claude Code") {
		t.Fatalf("the form shows:\n%s", got)
	}
	m = update(t, m, key(tea.KeyEnter))
	m = update(t, m, key(tea.KeyRight))
	m = update(t, m, key(tea.KeyEnter))
	next, cmd := m.Update(key(tea.KeyEnter))
	m = run(t, next.(model), cmd)
	if len(fake.putTags) != 1 {
		t.Fatalf("PutTag calls = %d", len(fake.putTags))
	}
	req := fake.putTags[0]
	if req.GetTagId() != "release-reviewer" || req.GetName() != "Release Reviewer" || req.GetHarnessKind() != v2.HarnessKind_HARNESS_KIND_CODEX ||
		req.GetWorkspace().GetWorkspaceId() != "supertag" || req.ExpectedRevision == nil || req.GetExpectedRevision() != 0 ||
		strings.Join(req.GetAllowedActions(), ",") != "commands:execute,files:write" {
		t.Fatalf("PutTag = %v", req)
	}
	if m.pane != paneConversation || m.selectedTag() != "release-reviewer" {
		t.Fatalf("the new Tag is not selected: pane %v, %q", m.pane, m.selectedTag())
	}
}

func TestOnlyOperatorsOpenNewTag(t *testing.T) {
	m := runtimeModel(t)
	m.cache.principal = "client:alice-laptop"
	m = update(t, m, tea.KeyPressMsg{Code: 'n', Mod: tea.ModCtrl})
	if m.pane == paneNewTag || !strings.Contains(m.notice.text, "Only an operator can create Tags. This terminal is connected as client:alice-laptop.") {
		t.Fatalf("a client opened New Tag: %v %q", m.pane, m.notice.text)
	}
}

func TestACachedConversationDoesNotRepeatItsWorkSessionLines(t *testing.T) {
	privateCache(t)
	message := ordered(runtimeHistoryMessage("root", "Investigate", "Started."), 1)
	message.WorkSessions = []*views.WorkSession{workSession("work/1", "Bounded investigation", "child-1", "Region verified.")}
	page := func(m model) model {
		items := client.History("lead", []*views.Message{message})
		items[0].Follow = false
		return update(t, m, historyMsg{tag: "lead", items: items, conversationID: runtimeConversationID, incremental: true})
	}
	first := runtimeModel(t)
	first.cache = newModelCache(openCache("http://127.0.0.1:1"), "test")
	first.cache.principal, first.cache.confirmed = "operator:local", true
	first = update(t, first, historyMsg{tag: "lead", conversationID: runtimeConversationID})
	first = page(first)
	first.cacheChanged(conversationKey("lead"))
	first.flush(true)

	next := runtimeModel(t)
	next.cache = newModelCache(openCache("http://127.0.0.1:1"), "test")
	next.cache.principal = "operator:local"
	next.cachedConversation("lead")
	next = page(next)
	if got := ansi.Strip(next.renderConversation()); strings.Count(got, "working: Bounded investigation") != 1 || strings.Count(got, "Region verified.") != 1 {
		t.Fatalf("a reread of a cached turn repeated its work Session:\n%s", got)
	}
}

func TestALaunchFromTheCacheTakesKeysAtOnce(t *testing.T) {
	privateCache(t)
	fake, url := firstPaintPlane(t, 0)
	_ = fake
	launchUntil(t, url, true)
	a, err := newApp(t.Context(), dial("test"), []client.Target{{URL: url, Token: "secret"}}, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer a.stop()
	a.Update(tea.WindowSizeMsg{Width: 120, Height: 30})
	a.Update(tea.KeyPressMsg{Code: 'h', Text: "h"})
	if a.inner.input.Value() != "h" {
		t.Fatalf("the input took %q", a.inner.input.Value())
	}
}
