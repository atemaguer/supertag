package client

import (
	"strings"
	"testing"
	"time"

	"github.com/atemaguer/supertag/apps/tui/views"
)

func testFollower(c *Client) *Follower {
	return &Follower{Client: c, Interval: time.Millisecond, IdleTimeout: time.Second, ReconnectTimeout: 5 * time.Second, WorkTimeout: 5 * time.Second}
}

func collect(t *testing.T, events <-chan FollowEvent) []FollowEvent {
	t.Helper()
	var out []FollowEvent
	timeout := time.After(10 * time.Second)
	for {
		select {
		case event, ok := <-events:
			if !ok {
				return out
			}
			out = append(out, event)
		case <-timeout:
			t.Fatalf("the follow did not end; events so far: %s", describe(out))
		}
	}
}

// describe writes events as one line each: kind, then the fields that are set.
func describe(events []FollowEvent) string {
	names := []string{"waiting", "delta", "activity", "reply", "turn-error", "working", "report", "approval", "not-continued", "still-working", "joined", "error"}
	var lines []string
	for _, e := range events {
		line := names[e.Kind]
		if e.Title != "" {
			line += " [" + e.Title + "]"
		}
		if e.Status != "" {
			line += " (" + e.Status + ")"
		}
		if e.Indent {
			line += " indent"
		}
		if e.Text != "" {
			line += " " + e.Text
		}
		if e.Reply != nil {
			line += " " + e.Reply.GetText()
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

func expect(t *testing.T, got []FollowEvent, want ...string) {
	t.Helper()
	if g, w := describe(got), strings.Join(want, "\n"); g != w {
		t.Fatalf("events:\n%s\nwant:\n%s", g, w)
	}
}

func message(task string) *views.Message {
	return &views.Message{TaskId: task, Tag: "lead", Conversation: "default", Status: views.ReplyStatus_REPLY_STATUS_WAITING}
}

func TestActivityLine(t *testing.T) {
	tool := &views.Activity{Detail: &views.Activity_Tool{Tool: &views.ToolActivity{Tool: "github.create_pull_request", Status: views.ActivityStatus_ACTIVITY_STATUS_RUNNING}}}
	retry := &views.Activity{Detail: &views.Activity_Retry{Retry: &views.RetryActivity{Attempt: 2}}}
	unknown := &views.Activity{Text: "thinking hard"}
	for activity, want := range map[*views.Activity]string{
		tool:    "· using: github.create_pull_request",
		retry:   "· retrying (Task Attempt 2)",
		unknown: "· thinking hard",
		{}:      "",
	} {
		if got := ActivityLine(activity); got != want {
			t.Errorf("ActivityLine(%v) = %q, want %q", activity, got, want)
		}
	}
}
