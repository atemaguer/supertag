package main

import (
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/atemaguer/supertag/apps/tui/client"
	v2 "github.com/atemaguer/supertag/sdks/go/runtimev2"
)

const heldSlot = "Waiting: Worker Host laptop's only Claude Code slot is held by an uncertain Task Attempt that may have executed. Once you confirm its execution stopped: supertag task resolve-attempt t0 a0 --decision retry --evidence TEXT"

func TestASentMessageSaysWhyItWaitsUntilAWorkerHostTakesItUp(t *testing.T) {
	privateCache(t)
	tagRefresh = time.Hour
	fake, url := outboxPlane(t)
	queued := func(tag, task string) *v2.ConversationMessage {
		return &v2.ConversationMessage{Order: 1, Task: &v2.Task{TaskId: task, TagId: tag, Prompt: "Hi there", State: v2.TaskState_TASK_STATE_QUEUED}}
	}
	fake.mu.Lock()
	fake.send = func(req *v2.SendMessageRequest) (*v2.ConversationMessage, error) {
		return &v2.ConversationMessage{Order: 1, SentAtMs: time.Now().UnixMilli(),
			Task: &v2.Task{TaskId: "task-1", TagId: "lead", Prompt: req.GetText(), State: v2.TaskState_TASK_STATE_QUEUED}}, nil
	}
	fake.message = queued
	fake.events = func(string, uint64) []*v2.TaskEvent { return nil }
	fake.mu.Unlock()
	a, err := newApp(t.Context(), dial("test"), []client.Target{{URL: url, Token: "secret"}}, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer a.stop()
	a.Update(tea.WindowSizeMsg{Width: 120, Height: 30})
	driven(t, a, a.Init(), func() bool { return a.inner.cache.confirmed && a.inner.conversation("lead").loaded })
	fake.mu.Lock()
	page := &v2.ListMessagesResponse{ConversationId: "conversation-lead", Messages: []*v2.ConversationMessage{queued("lead", "task-1")}}
	fake.messages = func(string) *v2.ListMessagesResponse { return page }
	// The conversation's follow pushes the turn, then why it still waits.
	fake.follow = func(*v2.FollowConversationRequest) []*v2.FollowConversationResponse {
		return []*v2.FollowConversationResponse{
			{Messages: page},
			{Waits: []*v2.TurnWait{{TaskId: "task-1", Reason: heldSlot}}},
		}
	}
	fake.mu.Unlock()
	a.inner.input.SetValue("Hi there")
	driven(t, a, a.inner.submit(), func() bool {
		turn := a.inner.shown().runtime.turns["task-1"]
		return turn != nil && turn.wait != ""
	})
	got := strings.Join(strings.Fields(ansi.Strip(a.View().Content)), " ")
	if !strings.Contains(got, "Sent") || !strings.Contains(got, "only Claude Code slot is held by an uncertain Task Attempt") ||
		!strings.Contains(got, "supertag task resolve-attempt t0 a0") {
		t.Fatalf("a queued message does not say why it waits:\n%s", ansi.Strip(a.View().Content))
	}

	// Once a Worker Host takes it up, the reason goes.
	a.Update(followMsg{tag: "lead", taskID: "task-1", event: client.FollowEvent{Kind: client.EventStarted}})
	if got := ansi.Strip(a.View().Content); strings.Contains(got, "uncertain Task Attempt") || !strings.Contains(got, "Seen") {
		t.Fatalf("a started turn still says it waits:\n%s", got)
	}
}

func TestTheWaitShowsOnlyWhileTheTurnIsQueued(t *testing.T) {
	turn := &runtimeTurn{}
	if waitLine(turn, 80) != "" {
		t.Fatal("a turn without a reason shows one")
	}
	turn.wait = heldSlot
	if waitLine(turn, 80) == "" {
		t.Fatal("a queued turn hides its reason")
	}
	turn.started = true
	if waitLine(turn, 80) != "" {
		t.Fatal("a started turn still shows why it waited")
	}
}
