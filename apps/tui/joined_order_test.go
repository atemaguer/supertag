package main

import (
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"google.golang.org/protobuf/proto"

	"github.com/atemaguer/supertag/apps/tui/client"
	v2 "github.com/atemaguer/supertag/sdks/go/runtimev2"
)

func TestAReplyShowsAfterTheMessagesThatJoinedItsTurn(t *testing.T) {
	privateCache(t)
	tagRefresh = time.Hour
	fake, url := outboxPlane(t)
	turn := func(task string, order uint64, prompt string) *v2.ConversationMessage {
		return &v2.ConversationMessage{Order: order, SentAtMs: time.Now().UnixMilli(),
			Task: &v2.Task{TaskId: task, TagId: "lead", Prompt: prompt, State: v2.TaskState_TASK_STATE_SUCCEEDED}}
	}
	first := turn("t1", 1, "Fix the build")
	first.Task.Result = proto.String("Fixed the build and the tests.")
	joined := func(task string, order uint64, prompt string) *v2.ConversationMessage {
		message := turn(task, order, prompt)
		message.LiveInput = &v2.LiveInput{TaskId: "t1", FollowerTaskId: task, State: v2.LiveInputState_LIVE_INPUT_STATE_ACCEPTED}
		return message
	}
	fake.mu.Lock()
	fake.messages = func(string) *v2.ListMessagesResponse {
		return &v2.ListMessagesResponse{ConversationId: "conversation-lead", Messages: []*v2.ConversationMessage{
			joined("t3", 3, "Thanks"), joined("t2", 2, "Also the tests"), first,
		}}
	}
	fake.mu.Unlock()
	a, err := newApp(t.Context(), dial("test"), []client.Target{{URL: url, Token: "secret"}}, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer a.stop()
	a.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	driven(t, a, a.Init(), func() bool { return a.inner.cache.confirmed && a.inner.conversation("lead").loaded })
	got := ansi.Strip(a.View().Content)
	positions := []int{}
	for _, text := range []string{"Fix the build", "Also the tests", "Thanks", "Fixed the build and the tests."} {
		at := strings.Index(got, text)
		if at < 0 {
			t.Fatalf("%q is missing:\n%s", text, got)
		}
		positions = append(positions, at)
	}
	for i := 1; i < len(positions); i++ {
		if positions[i] < positions[i-1] {
			t.Fatalf("the conversation does not read in order:\n%s", got)
		}
	}
	if strings.Count(got, "Fixed the build and the tests.") != 1 {
		t.Fatalf("the reply shows more than once:\n%s", got)
	}
}
