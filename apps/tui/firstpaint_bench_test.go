package main

import (
	"context"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
	v2 "github.com/atemaguer/supertag/sdks/go/runtimev2"
)

// firstPaintLatency is each call's round trip to the benchmark's Gateway: a Gateway on
// another machine, not this one.
const firstPaintLatency = 30 * time.Millisecond

// firstPaintPlane is a Gateway with 12 Tags whose lead has 50 finished turns, each answered
// in markdown, and the given round trip for every call.
func firstPaintPlane(tb testing.TB, latency time.Duration) (*fakeGateway, string) {
	tb.Helper()
	names := []string{"lead"}
	for i := range 11 {
		names = append(names, fmt.Sprintf("tag-%02d", i))
	}
	fake := &fakeGateway{tags: tags(names...), principal: "operator:bench"}
	fake.messages = func(tag string) *v2.ListMessagesResponse {
		if tag != "lead" {
			return &v2.ListMessagesResponse{}
		}
		res := &v2.ListMessagesResponse{ConversationId: "conversation-lead"}
		for i := 49; i >= 0; i-- {
			result := fmt.Sprintf(benchReply, i, i) + fmt.Sprintf("\n\nmarker-%d", i)
			res.Messages = append(res.Messages, &v2.ConversationMessage{
				Task: &v2.Task{TaskId: fmt.Sprintf("task-%d", i), TagId: "lead", SessionId: "session",
					Prompt: fmt.Sprintf("Please look at step %d.", i), State: v2.TaskState_TASK_STATE_SUCCEEDED, Result: &result},
				Order: uint64(i + 1), SentAtMs: time.Now().Add(-time.Duration(50-i) * time.Minute).UnixMilli(),
				Events: []*v2.TaskEvent{{Sequence: 1, Kind: v2.TaskEventKind_TASK_EVENT_KIND_MESSAGE, Text: fmt.Sprintf("I'll look at step %d.", i)}},
			})
		}
		return res
	}
	fake.conversations = func() []*v2.Conversation {
		return []*v2.Conversation{{TagId: "lead", ConversationId: "conversation-lead", Preview: "That is all.", PreviewFromTag: true, LatestOrder: 50, ReadOrder: 50}}
	}
	server := fake.startWith(tb, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			time.Sleep(latency)
			next.ServeHTTP(w, r)
		})
	})
	return fake, server.URL
}

// launch starts the program's model as main does and drives it, running each command on its own
// goroutine as Bubble Tea does, until the frame shows the lead's latest reply. It returns how
// long that took.
func launch(tb testing.TB, url string) time.Duration {
	return launchUntil(tb, url, false)
}

// launchUntil is launch that, when confirmed, goes on until the cache knows whom it acts as, so
// the launch leaves a cache for the next.
func launchUntil(tb testing.TB, url string, confirmed bool) time.Duration {
	tb.Helper()
	ctx, cancel := context.WithCancel(tb.Context())
	defer cancel()
	began := time.Now()
	a, err := newApp(ctx, dial("test"), []client.Target{{URL: url, Token: "secret", Name: "remote"}}, 0)
	if err != nil {
		tb.Fatal(err)
	}
	defer a.stop()
	msgs := make(chan tea.Msg, 256)
	var runCmd func(tea.Cmd)
	runCmd = func(cmd tea.Cmd) {
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
	runCmd(a.Init())
	a.Update(tea.WindowSizeMsg{Width: 160, Height: 50})
	deadline := time.After(10 * time.Second)
	var shown time.Duration
	for {
		if shown == 0 && strings.Contains(a.View().Content, "marker-49") {
			shown = time.Since(began)
		}
		if shown != 0 && (!confirmed || a.inner.cache.confirmed) {
			return shown
		}
		select {
		case msg := <-msgs:
			switch msg := msg.(type) {
			case nil:
			case tea.BatchMsg:
				for _, cmd := range msg {
					runCmd(cmd)
				}
			default:
				_, cmd := a.Update(msg)
				runCmd(cmd)
			}
		case <-deadline:
			tb.Fatal("the conversation never showed")
		}
	}
}

// BenchmarkFirstConversation is how long `supertag` takes from starting the terminal UI to showing
// the last Tag's conversation, with a 30 ms round trip to the Gateway: on a first launch,
// and on a launch after one that showed it.
func BenchmarkFirstConversation(b *testing.B) {
	_, url := firstPaintPlane(b, firstPaintLatency)
	freshCache := func(b *testing.B) {
		root := filepath.Join(b.TempDir(), "tui")
		previous := cacheDirectory
		cacheDirectory = func() (string, error) { return root, nil }
		b.Cleanup(func() { cacheDirectory = previous })
	}
	b.Run("first-launch", func(b *testing.B) {
		var total time.Duration
		for b.Loop() {
			// Each launch starts with no cache.
			freshCache(b)
			total += launch(b, url)
		}
		b.ReportMetric(float64(total)/1e6/float64(b.N), "ms/first-frame")
	})
	b.Run("next-launch", func(b *testing.B) {
		freshCache(b)
		launchUntil(b, url, true)
		var total time.Duration
		for b.Loop() {
			total += launch(b, url)
		}
		b.ReportMetric(float64(total)/1e6/float64(b.N), "ms/first-frame")
	})
}
