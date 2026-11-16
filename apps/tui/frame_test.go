package main

import (
	"fmt"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
)

// lipglossScreen is the layout composeScreen stands in for.
func lipglossScreen(rail, viewport, header, bottom, status string, bodyHeight int) string {
	pane := lipgloss.JoinVertical(lipgloss.Left, header, viewport, bottom)
	body := lipgloss.JoinHorizontal(lipgloss.Top, rail, " ", pane)
	body = lipgloss.NewStyle().Height(bodyHeight).MaxHeight(bodyHeight).Render(body)
	return lipgloss.JoinVertical(lipgloss.Left, body, status)
}

func TestComposeScreenMatchesLipgloss(t *testing.T) {
	wide := "日本語のテキスト 🚀 done"
	styled := selected.Render("tag-01") + " " + faint.Render("active")
	blocks := map[string]string{
		"empty":  "",
		"one":    "x",
		"styled": styled + "\n" + headerStyle.Render("Objectives") + "\n" + errorStyle.Render("boom"),
		"wide":   wide + "\nshort\n" + strings.Repeat("-", 40),
		"tall":   strings.Repeat("line\n", 30) + "end",
		"tabs":   "a\tb\nc\r\nd",
	}
	names := []string{"empty", "one", "styled", "wide", "tall", "tabs"}
	cases := 0
	for _, rail := range names {
		for _, viewport := range names {
			for _, status := range []string{"", statusStyle.Render(" laptop  connected "), strings.Repeat("s", 90)} {
				for _, bottom := range []string{"", "> typed", okStyle.Render(wide)} {
					for _, height := range []int{2, 5, 40} {
						r, v := measure(blocks[rail]), measure(blocks[viewport])
						got := composeScreen(&r, &v, headerStyle.Render("Title · "+rail), bottom, status, height)
						want := lipglossScreen(blocks[rail], blocks[viewport], headerStyle.Render("Title · "+rail), bottom, status, height)
						if got != want {
							t.Fatalf("rail %s, viewport %s, status %q, bottom %q, height %d:\ngot\n%q\nwant\n%q",
								rail, viewport, status, bottom, height, got, want)
						}
						cases++
					}
				}
			}
		}
	}
	t.Logf("%d layouts match", cases)
}

// TestViewMatchesLipglossLayout renders whole screens of a model, as typing, scrolling and
// resizing leave them, and checks each against the lipgloss layout of the same parts.
func TestViewMatchesLipglossLayout(t *testing.T) {
	m := typingModel(t, 40)
	check := func(label string) {
		t.Helper()
		bodyHeight := max(m.height-1, 2)
		header := headerStyle.Render(truncate(m.paneTitle(), m.paneWidth()))
		bottom := m.input.View()
		if m.notice.text != "" {
			bottom = okStyle.Render(truncate(m.notice.text, m.paneWidth()))
		} else if !m.inputShown() {
			bottom = faint.Render(truncate(m.paneHint(), m.paneWidth()))
		}
		want := lipglossScreen(m.renderRail(bodyHeight), m.viewport.View(), header, bottom, m.renderStatus(), bodyHeight)
		if got := m.View().Content; got != want {
			t.Fatalf("%s: the screen differs from the lipgloss layout:\ngot\n%s\nwant\n%s", label, got, want)
		}
	}
	check("start")
	for _, key := range "hello" {
		m = update(t, m, tea.KeyPressMsg{Code: key, Text: string(key)})
		check(fmt.Sprintf("typed %q", key))
	}
	m = update(t, m, tea.KeyPressMsg{Code: tea.KeyPgUp})
	check("page up")
	m.notice = note{text: "Opened the pull request."}
	check("notice")
	m.notice = note{}
	for _, size := range [][2]int{{80, 12}, {40, 3}, {200, 70}, {30, 1}} {
		m = update(t, m, tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		check(fmt.Sprintf("%dx%d", size[0], size[1]))
	}
	m = update(t, m, tea.KeyPressMsg{Code: tea.KeyTab})
	m = update(t, m, tea.KeyPressMsg{Code: tea.KeyDown})
	m = update(t, m, tea.KeyPressMsg{Code: tea.KeyDown})
	check("rail cursor")
}

// TestFollowDeliversWaitingEventsTogether checks the events a poll emits at once arrive as one
// message, in order, and redraw the conversation once.
func TestFollowDeliversWaitingEventsTogether(t *testing.T) {
	m := typingModel(t, 3)
	tag := m.selectedTag()
	events := make(chan client.FollowEvent, 3)
	for _, text := range []string{"one ", "two ", "three"} {
		events <- client.FollowEvent{Kind: client.EventDelta, Text: text}
	}
	close(events)
	msg, ok := waitForTask(tag, defaultConversation, "task-2", events)().(followMsg)
	if !ok || msg.event.Text != "one " || len(msg.more) != 2 || msg.more[1].Text != "three" {
		t.Fatalf("first message = %#v", msg)
	}
	contents := m.frame.contents
	m = update(t, m, msg)
	if m.frame.contents != contents+1 || !strings.Contains(screen(m), "one two three") {
		t.Fatalf("the events redrew the conversation %d times:\n%s", m.frame.contents-contents, screen(m))
	}
	if _, done := waitForTask(tag, defaultConversation, "task-2", events)().(followDoneMsg); !done {
		t.Fatal("the closed follow did not report done")
	}
}

// TestRefreshKeepsTheViewportWhenNothingChanged checks a reread that changes nothing leaves the
// viewport's content alone, and one that changes it shows the change. An earlier copy of the
// model still renders its own content from the shared caches.
func TestRefreshKeepsTheViewportWhenNothingChanged(t *testing.T) {
	m := typingModel(t, 5)
	contents := m.frame.contents
	m.refresh()
	if m.frame.contents != contents {
		t.Fatal("an unchanged conversation set the viewport's content again")
	}
	before := m
	screen(before)
	c := m.shown()
	c.add(entryDim, "· a new line")
	m.refresh()
	if m.frame.contents != contents+1 || !strings.Contains(screen(m), "a new line") {
		t.Fatalf("a changed conversation did not show:\n%s", screen(m))
	}
	if strings.Contains(screen(before), "a new line") {
		t.Fatalf("an earlier copy shows a later copy's content:\n%s", screen(before))
	}
}
