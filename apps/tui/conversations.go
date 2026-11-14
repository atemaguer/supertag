package main

import (
	"fmt"
	"regexp"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/atemaguer/supertag/apps/tui/views"
)

// conversationNamePattern is what ConversationService accepts as a conversation's name.
var conversationNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// picker is the conversation list: the caller's conversations with one Tag, to switch to or to
// start a new one.
type picker struct {
	tag    string
	list   []*views.Conversation
	err    string
	loaded bool
	// cursor is the row under the cursor; the row after the conversations starts a new one.
	cursor int
	// naming says the input takes the new conversation's name.
	naming bool
	note   note
	reload *reload
}

type pickerMsg struct {
	tag           string
	conversations []*views.Conversation
	err           error
}

// pickRow is one conversation the list offers, with what the Control Plane said of it.
type pickRow struct {
	name string
	conv *views.Conversation
}

// openPicker lists the selected Tag's conversations in the main pane.
func (m *model) openPicker() tea.Cmd {
	tag := m.selectedTag()
	if tag == "" || m.pane == paneConversations {
		return nil
	}
	m.saveDraft()
	m.decision, m.itemNote = decisionNone, note{}
	m.viewport.SoftWrap = false
	m.picker = &picker{tag: tag, reload: &reload{}}
	m.picker.cursor = m.pickerIndex(m.currentConversation(tag))
	m.pane, m.focus = paneConversations, focusInput
	m.input.Placeholder = "Name the new conversation"
	m.placeCursor()
	m.syncInput()
	m.viewport.GotoTop()
	m.refresh()
	return m.reloadPicker()
}

// reloadPicker rereads the shown conversation list; nil when none is shown.
func (m model) reloadPicker() tea.Cmd {
	if m.pane != paneConversations || m.picker == nil || !m.picker.reload.start() {
		return nil
	}
	return m.pickerCmd()
}

func (m model) pickerCmd() tea.Cmd {
	c, ctx, tag := m.client, m.ctx, m.picker.tag
	return func() tea.Msg {
		conversations, err := c.ListConversations(ctx, tag)
		return pickerMsg{tag: tag, conversations: conversations, err: err}
	}
}

func (m *model) pickerRead(msg pickerMsg) tea.Cmd {
	p := m.picker
	if p == nil || p.tag != msg.tag {
		return nil
	}
	var again tea.Cmd
	if p.reload.done() {
		again = m.pickerCmd()
	}
	if msg.err != nil {
		p.err = terminalText(msg.err.Error())
	} else {
		name := ""
		if rows := m.pickRows(); p.cursor < len(rows) {
			name = rows[p.cursor].name
		}
		p.list, p.err, p.loaded = msg.conversations, "", true
		if name != "" {
			p.cursor = m.pickerIndex(name)
		}
	}
	if m.pane == paneConversations {
		m.refresh()
	}
	return again
}

// pickRows are the conversations the list offers: those the Control Plane lists, the most recent
// first, then the default one and those started here that it does not list yet.
func (m model) pickRows() []pickRow {
	p := m.picker
	var rows []pickRow
	listed := map[string]bool{}
	if p != nil {
		for _, conv := range p.list {
			if conv.GetTag() == p.tag && !listed[conv.GetName()] {
				listed[conv.GetName()] = true
				rows = append(rows, pickRow{name: conv.GetName(), conv: conv})
			}
		}
	}
	tag := m.selectedTag()
	if p != nil {
		tag = p.tag
	}
	for _, name := range []string{defaultConversation, m.currentConversation(tag)} {
		if !listed[name] {
			listed[name] = true
			rows = append(rows, pickRow{name: name})
		}
	}
	return rows
}

// pickerIndex is the row of the named conversation, or the first.
func (m model) pickerIndex(name string) int {
	for i, row := range m.pickRows() {
		if row.name == name {
			return i
		}
	}
	return 0
}

// pickerKey handles a key in the conversation list. ok is false for a key the input takes while
// naming a new conversation.
func (m model) pickerKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd, bool) {
	p := m.picker
	if p == nil || p.naming {
		return m, nil, false
	}
	rows := m.pickRows()
	switch msg.String() {
	case "up", "k":
		if p.cursor > 0 {
			p.cursor--
		}
	case "down", "j":
		if p.cursor < len(rows) {
			p.cursor++
		}
	case "n":
		return m, m.startNaming(), true
	case "enter":
		if p.cursor >= len(rows) {
			return m, m.startNaming(), true
		}
		return m, m.switchConversation(rows[p.cursor].name), true
	case "left":
		return m, nil, false
	default:
		return m, nil, true
	}
	m.refresh()
	return m, nil, true
}

func (m *model) startNaming() tea.Cmd {
	m.picker.naming, m.picker.note = true, note{}
	m.picker.cursor = len(m.pickRows())
	m.input.Reset()
	m.refresh()
	return m.syncInput()
}

// startConversation switches to a new conversation with the name the input holds.
func (m *model) startConversation(name string) tea.Cmd {
	if !conversationNamePattern.MatchString(name) {
		m.picker.note = note{text: "A conversation name is 1 to 64 letters, digits, ., _ or -, starting with a letter or digit.", err: true}
		m.refresh()
		return nil
	}
	return m.switchConversation(name)
}

// switchConversation shows the named conversation of the listed Tag, loading its history the
// first time.
func (m *model) switchConversation(name string) tea.Cmd {
	tag := m.picker.tag
	for i, t := range m.tags {
		if m.tagReference(t) == tag {
			m.selected = i
		}
	}
	m.picker = nil
	m.current[tag] = name
	m.input.Reset()
	m.showConversation()
	m.placeCursor()
	return tea.Batch(m.syncInput(), m.selectTag())
}

// renderPicker is the conversation list: each conversation with its open work and latest entry.
func (m model) renderPicker() string {
	p := m.picker
	width := m.paneWidth()
	wrap := lipgloss.NewStyle().Width(width)
	rows := m.pickRows()
	nameWidth := 0
	for _, row := range rows {
		nameWidth = max(nameWidth, min(lipgloss.Width(terminalText(row.name)), 24))
	}
	shown := m.currentConversation(p.tag)
	lines := []string{faint.Render(wrap.Render("Your conversations with " + terminalText(m.tagLabel(p.tag)) + ", the most recent first.")), ""}
	if p.err != "" {
		lines = append(lines, errorStyle.Render(wrap.Render("Could not list the conversations: "+p.err)), "")
	} else if !p.loaded {
		lines = append(lines, faint.Render("Reading the conversations…"), "")
	}
	line := func(i int, text string) string {
		style := lipgloss.NewStyle()
		if i == p.cursor {
			style = selected
			if m.focus == focusInput && !p.naming {
				style = focusedSel
			}
		}
		return style.Render(truncate(text, width))
	}
	for i, row := range rows {
		name := truncate(terminalText(row.name), 24)
		text := name + strings.Repeat(" ", max(nameWidth-lipgloss.Width(name), 0))
		if row.name == shown {
			text += "  (shown)"
		}
		if open := row.conv.GetOpenWorkSessionCount(); open > 0 {
			text += fmt.Sprintf("  %d open", open)
		}
		if last := firstLine(row.conv.GetLastMessageText()); last != "" {
			author := terminalText(m.tagLabel(p.tag))
			if row.conv.GetLastMessageAuthor() == views.ConversationAuthor_CONVERSATION_AUTHOR_OPERATOR {
				author = "you"
			}
			text += "  " + author + ": " + terminalText(last)
		}
		lines = append(lines, line(i, text))
	}
	lines = append(lines, line(len(rows), "+ New conversation"))
	if p.note.text != "" {
		style := faint
		if p.note.err {
			style = errorStyle
		}
		lines = append(lines, "", style.Render(wrap.Render(p.note.text)))
	}
	return strings.Join(lines, "\n")
}

// pickerHint ends the conversation list: the keys that act on it.
func (m model) pickerHint() string {
	return "enter switches · n new conversation · esc back"
}
