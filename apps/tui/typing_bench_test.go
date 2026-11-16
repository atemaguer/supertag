package main

import (
	"fmt"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/apps/tui/views"
)

// benchReply is a reply with the markdown a Tag writes: a heading, a list and a code block.
const benchReply = "## Plan %d\n\nI read the **failing test** and found the cause:\n\n" +
	"- the cache keys on `width` only\n- the rail rebuilds on every frame\n- a third point with a [link](https://example.com)\n\n" +
	"```go\nfunc (m model) View() tea.View {\n\treturn tea.NewView(m.render())\n}\n```\n\nThat is all for step %d."

// typingModel is a model at the size an operator who has used SuperTag for a while sees: many
// Tags, Objectives and inbox items in the rail, and a long conversation of markdown replies.
func typingModel(tb testing.TB, turns int) model {
	tb.Helper()
	m, err := dial("test")(tb.Context(), client.Target{URL: "http://127.0.0.1:1", Token: "test", Name: "laptop"})
	if err != nil {
		tb.Fatal(err)
	}
	tb.Cleanup(m.client.Close)
	names := make([]string, 30)
	for i := range names {
		names[i] = fmt.Sprintf("tag-%02d", i)
	}
	m.tags, m.selected, m.tagsChecked, m.connected, m.status = tagList(names...), 0, true, true, "connected"
	for i := range 20 {
		m.objectives = append(m.objectives, &views.Objective{Id: fmt.Sprintf("obj-%d", i),
			Outcome: fmt.Sprintf("Ship the improvement number %d to the release", i),
			Status:  views.ObjectiveStatus_OBJECTIVE_STATUS_WORKING})
	}
	for i := range 15 {
		m.inbox.Items = append(m.inbox.Items, &views.InboxItem{Occurrence: fmt.Sprintf("occ-%d", i),
			Kind: views.InboxItemKind_INBOX_ITEM_KIND_QUESTION,
			Question: &views.InboxQuestion{Text: fmt.Sprintf("Which branch should change %d land on? ", i) +
				strings.Repeat("The Tag explains what it found and what each choice would cost. ", 7)}})
	}
	m.hostsKnown = true
	m.hosts = []*views.WorkerHost{{Phase: views.WorkerHostPhase_WORKER_HOST_PHASE_READY}}
	next, _ := m.Update(tea.WindowSizeMsg{Width: 160, Height: 50})
	m = next.(model)

	tag := m.selectedTag()
	newestFirst := make([]*views.Message, 0, turns)
	for i := turns - 1; i >= 0; i-- {
		newestFirst = append(newestFirst, &views.Message{
			TaskId: fmt.Sprintf("task-%d", i), Tag: tag, SessionId: "session",
			Text:   fmt.Sprintf("Please look at step %d of the plan and tell me what breaks.", i),
			Status: views.ReplyStatus_REPLY_STATUS_REPLIED, Reply: finalReply(fmt.Sprintf(benchReply, i, i)),
		})
	}
	c := m.conversation(tag)
	c.historyReload.start()
	next, _ = m.Update(historyMsg{tag: tag,
		items: client.History(tag, newestFirst), revision: c.runtime.revision})
	m = next.(model)
	if !c.loaded || len(c.runtime.order) != turns {
		tb.Fatalf("conversation not loaded: %d turns", len(c.runtime.order))
	}
	return m
}

// streamPage is how many events the follower reads from the Control Plane per poll.
const streamPage = 32

var benchKey = tea.KeyPressMsg{Code: 'a', Text: "a"}

// BenchmarkTypingKeystroke is what one typed character costs the program: the app's Update and
// the frame View renders after it.
func BenchmarkTypingKeystroke(b *testing.B) {
	for _, turns := range []int{50, 300} {
		b.Run(fmt.Sprintf("turns=%d", turns), func(b *testing.B) {
			a := &app{inner: typingModel(b, turns), hasTarget: true, width: 160, height: 50}
			a.View()
			b.ReportAllocs()
			for b.Loop() {
				a.Update(benchKey)
				_ = a.View().Content
			}
		})
	}
	b.Run("turns=300/screen=250x70", func(b *testing.B) {
		a := &app{inner: typingModel(b, 300), hasTarget: true}
		a.Update(tea.WindowSizeMsg{Width: 250, Height: 70})
		a.View()
		b.ReportAllocs()
		for b.Loop() {
			a.Update(benchKey)
			_ = a.View().Content
		}
	})
}

// BenchmarkStreamingPage is what one page of streamed reply text costs the program: the events a
// poll of the Control Plane emits at once, delivered as the follow delivers them, each message
// with its frame. A key typed while they arrive waits behind them.
func BenchmarkStreamingPage(b *testing.B) {
	for _, turns := range []int{50, 300} {
		b.Run(fmt.Sprintf("turns=%d", turns), func(b *testing.B) {
			a := &app{inner: typingModel(b, turns), hasTarget: true, width: 160, height: 50}
			tag := a.inner.selectedTag()
			task := fmt.Sprintf("task-%d", turns-1)
			turn := a.inner.conversation(tag).runtime.turns[task]
			a.View()
			b.ReportAllocs()
			page := 0
			for b.Loop() {
				// Each page streams new text, so every page changes what the conversation shows.
				turn.draft, page = "", page+1
				events := make(chan client.FollowEvent, streamPage)
				for i := range streamPage {
					events <- client.FollowEvent{Kind: client.EventDelta, Text: fmt.Sprintf("page %d word %d ", page, i)}
				}
				close(events)
				wait := waitForTask(tag, task, events)
				for {
					msg := wait()
					if _, done := msg.(followDoneMsg); done {
						break
					}
					a.Update(msg)
					_ = a.View().Content
				}
			}
		})
	}
}

// BenchmarkTypingRefresh is what a background reread that redraws the conversation costs.
func BenchmarkTypingRefresh(b *testing.B) {
	for _, turns := range []int{50, 300} {
		b.Run(fmt.Sprintf("turns=%d", turns), func(b *testing.B) {
			m := typingModel(b, turns)
			b.ReportAllocs()
			for b.Loop() {
				m.refresh()
			}
		})
	}
}
