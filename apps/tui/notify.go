package main

import (
	"fmt"
	"os"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/atemaguer/supertag/apps/tui/views"
)

// notifyVariable sets what the terminal UI does when a Tag replies or asks a question in a
// conversation that is not in front: `all` (the default) sends a desktop notification through
// the terminal (OSC 9, which iTerm2, WezTerm, Ghostty, kitty, and others show), `questions` sends
// one only for questions, `bell` rings the terminal bell instead, and `off` does nothing.
const notifyVariable = "SUPERTAG_TUI_NOTIFY"

type notifyLevel int

const (
	notifyAll notifyLevel = iota
	notifyQuestions
	notifyBell
	notifyOff
)

func notifyLevelFrom(value string) notifyLevel {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "questions":
		return notifyQuestions
	case "bell":
		return notifyBell
	case "off":
		return notifyOff
	default:
		return notifyAll
	}
}

func notifyLevelFromEnv() notifyLevel { return notifyLevelFrom(os.Getenv(notifyVariable)) }

// An alert is one notification: a Tag's new reply or its new question.
type alert struct {
	tag      string
	text     string
	question bool
}

// alertsFor says what changed between two reads of the conversation list that deserves a
// notification: a Tag's new reply, or its new question, in a conversation not in front. The
// first read (prior nil) only sets what is known. Your own messages, a turn still running, and
// quiet turns never notify; the Control Plane leaves quiet turns out of the list.
func alertsFor(prior map[string]*views.Conversation, next []*views.Conversation, shown string, focused bool, level notifyLevel) []alert {
	if prior == nil || level == notifyOff {
		return nil
	}
	var alerts []alert
	for _, c := range next {
		before := prior[c.GetTag()]
		if !c.GetPreviewFromTag() || (focused && c.GetTag() == shown) {
			continue
		}
		newer := c.GetLatestOrder() > before.GetLatestOrder()
		question := c.GetAsking() && (newer || !before.GetAsking()) && c.GetUnreadCount() > 0
		reply := newer && c.GetUnreadCount() > before.GetUnreadCount()
		if !question && (!reply || level == notifyQuestions) {
			continue
		}
		text := firstLine(c.GetPreview())
		if !question && c.GetUnreadCount() > 1 {
			text = fmt.Sprintf("%d new messages", c.GetUnreadCount())
		}
		if text == "" {
			text = "New message"
		}
		alerts = append(alerts, alert{tag: c.GetTag(), text: text, question: question})
	}
	return alerts
}

// notifyCmd tells the terminal about the alerts: one OSC 9 notification each, or one bell.
func notifyCmd(alerts []alert, level notifyLevel) tea.Cmd {
	if len(alerts) == 0 {
		return nil
	}
	if level == notifyBell {
		return tea.Raw("\a")
	}
	var sequence strings.Builder
	for _, a := range alerts {
		sequence.WriteString(ansi.Notify(terminalText(a.tag + ": " + a.text)))
	}
	return tea.Raw(sequence.String())
}

// unreadTotal is the status line's count: unread replies across conversations, but the one in
// front.
func unreadTotal(summaries map[string]*views.Conversation, shown string) int {
	total := 0
	for tag, c := range summaries {
		if tag != shown {
			total += int(c.GetUnreadCount())
		}
	}
	return total
}

// notifyChanged takes a fresh conversation list: it notifies what deserves it and keeps the list
// as what is known.
func (m *model) notifyChanged(conversations []*views.Conversation) tea.Cmd {
	shown := ""
	if m.pane == paneConversation {
		shown = m.selectedTag()
	}
	alerts := alertsFor(m.notified, conversations, shown, !m.blurred, m.notify)
	m.notified = make(map[string]*views.Conversation, len(conversations))
	for _, c := range conversations {
		m.notified[c.GetTag()] = c
	}
	return notifyCmd(alerts, m.notify)
}
