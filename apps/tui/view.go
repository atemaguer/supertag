package main

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/glamour/v2"
	"charm.land/lipgloss/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
)

const railWidth = 24

var (
	accent      = lipgloss.Color("12")
	faint       = lipgloss.NewStyle().Faint(true)
	bold        = lipgloss.NewStyle().Bold(true)
	errorStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("9"))
	okStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("10"))
	selected    = lipgloss.NewStyle().Bold(true).Foreground(accent)
	focusedSel  = lipgloss.NewStyle().Bold(true).Reverse(true).Foreground(accent)
	railStyle   = lipgloss.NewStyle().Border(lipgloss.NormalBorder(), false, true, false, false).PaddingRight(1)
	headerStyle = lipgloss.NewStyle().Bold(true).Foreground(accent)
	statusStyle = lipgloss.NewStyle().Reverse(true)
)

// markdown renders replies with Glamour, rebuilding its renderer when the width changes.
type markdown struct {
	width    int
	renderer *glamour.TermRenderer
	// renders counts replies rendered, for tests.
	renders int
}

func (md *markdown) render(text string, width int) string {
	md.renders++
	if md.renderer == nil || md.width != width {
		renderer, err := glamour.NewTermRenderer(glamour.WithStandardStyle("dark"), glamour.WithWordWrap(width))
		if err != nil {
			return lipgloss.NewStyle().Width(width).Render(text)
		}
		md.renderer, md.width = renderer, width
	}
	out, err := md.renderer.Render(text)
	if err != nil {
		return lipgloss.NewStyle().Width(width).Render(text)
	}
	return strings.Trim(out, "\n")
}

func (m model) paneWidth() int { return max(m.width-railWidth-2, 10) }

// layout sizes the viewport and input to the window: one status line, and in the pane a header,
// the conversation and the input line.
func (m *model) layout() {
	m.viewport.SetWidth(m.paneWidth())
	m.viewport.SetHeight(max(m.height-3, 1))
	m.input.SetWidth(m.paneWidth() - 3)
	m.refresh()
}

// refresh redraws the main pane. A conversation stays at the bottom when it was there; the other
// panes keep their scroll position.
func (m *model) refresh() {
	switch m.pane {
	case paneObjective:
		m.viewport.SetContent(m.renderObjective())
	case paneInbox:
		m.viewport.SetContent(m.renderItem())
	default:
		atBottom := m.viewport.AtBottom()
		m.viewport.SetContent(m.renderConversation())
		if atBottom {
			m.viewport.GotoBottom()
		}
	}
}

func (m model) renderConversation() string {
	tag := m.selectedTag()
	if tag == "" {
		return faint.Render("No Tags yet. Create one with supertag apply or supertag create tag.")
	}
	name := terminalText(tag)
	width := m.paneWidth()
	wrap := lipgloss.NewStyle().Width(width)
	c := m.conversations[tag]
	if c == nil || (len(c.entries) == 0 && c.draft == "") {
		return faint.Render(wrap.Render("Say something to " + name + ". This is your default conversation with it."))
	}
	if c.renderedWidth != width {
		c.rendered.Reset()
		c.renderedCount, c.renderedWidth = 0, width
	}
	for _, e := range c.entries[c.renderedCount:] {
		switch e.kind {
		case entryYou:
			c.rendered.WriteString(bold.Render("you") + "\n" + wrap.Render(e.text) + "\n\n")
		case entryReply:
			c.rendered.WriteString(headerStyle.Render(name) + "\n" + m.md.render(e.text, width) + "\n\n")
		case entryDim:
			c.rendered.WriteString(faint.Render(wrap.Render(e.text)) + "\n")
		case entryError:
			c.rendered.WriteString(errorStyle.Render(wrap.Render(e.text)) + "\n\n")
		}
	}
	c.renderedCount = len(c.entries)
	out := c.rendered.String()
	if c.draft != "" {
		out += headerStyle.Render(name) + "\n" + faint.Render(wrap.Render(c.draft))
	}
	return strings.TrimRight(out, "\n")
}

// railContent is the rail's text width: railWidth less its right border and padding.
const railContent = railWidth - 2

// renderRail lists the Tags, the open Objectives and what waits on you, one row each, cut to
// fit, scrolled so the row under the cursor shows.
func (m model) renderRail(height int) string {
	paneKey := m.paneKey()
	var lines []string
	cursorLine := 0
	at := 0
	add := func(r row, label, state string) {
		if at == m.cursor {
			cursorLine = len(lines)
		}
		at++
		state = truncate(state, railContent/2)
		labelWidth := railContent
		if state != "" {
			labelWidth -= lipgloss.Width(state) + 1
		}
		style := lipgloss.NewStyle()
		switch {
		case m.focus == focusRail && at-1 == m.cursor:
			style = focusedSel
		case m.rowKey(r) == paneKey:
			style = selected
		}
		line := style.Render(truncate(label, labelWidth))
		if state != "" {
			line += " " + faint.Render(state)
		}
		lines = append(lines, line)
	}
	section := func(title, err string) {
		lines = append(lines, headerStyle.Render(truncate(title, railContent)))
		if err != "" {
			lines = append(lines, errorStyle.Render(truncate(strings.Join(strings.Fields(err), " "), railContent)))
		}
	}

	section("Tags", "")
	for i, tag := range m.tags {
		add(row{rowTag, i}, terminalText(tag.Name()), terminalText(railState(tag, m.open[tag.Name()])))
	}
	if len(m.objectives) > 0 || m.objectivesErr != "" {
		section("Objectives", m.objectivesErr)
		for i, objective := range m.objectives {
			add(row{rowObjective, i}, objectiveName(objective), objectiveState(objective))
		}
	}
	waiting := fmt.Sprintf("Waiting on you (%d)", len(m.inbox.Items))
	if m.inbox.Truncated {
		waiting = fmt.Sprintf("Waiting on you (%d+)", len(m.inbox.Items))
	}
	section(waiting, m.inboxErr)
	for i, item := range m.inbox.Items {
		add(row{rowInbox, i}, m.inboxRow(item), "")
	}

	first := max(cursorLine-height+1, 0)
	lines = lines[first:min(first+height, len(lines))]
	return railStyle.Width(railWidth).Height(height).MaxHeight(height).Render(strings.Join(lines, "\n"))
}

// railState is what the rail shows beside a Tag: its phase, or how many work Sessions of the
// default conversation are still open while the Tag is active.
func railState(tag client.Tag, open int) string {
	if open > 0 && tag.Status.Phase == "active" {
		return fmt.Sprintf("%d open", open)
	}
	return tag.Status.Phase
}

func (m model) renderStatus() string {
	target := m.client.Target()
	where := terminalText(target.URL)
	if target.Name != "" && target.Name != target.URL {
		where = terminalText(target.Name) + " · " + where
	}
	left := " " + where + "  "
	state := okStyle.Render("connected")
	if !m.connected {
		status := strings.Join(strings.Fields(terminalText(m.status)), " ")
		state = errorStyle.Render(truncate(status, max(m.width-lipgloss.Width(left)-1, 1)))
	}
	gap := max(m.width-lipgloss.Width(left)-lipgloss.Width(state)-1, 0)
	return statusStyle.MaxWidth(m.width).Render(left + strings.Repeat(" ", gap) + state + " ")
}

func (m model) View() tea.View {
	if m.width == 0 {
		v := tea.NewView("")
		v.AltScreen = true
		return v
	}
	bodyHeight := max(m.height-1, 2)
	header := headerStyle.Render(truncate(m.paneTitle(), m.paneWidth()))
	bottom := m.input.View()
	if !m.inputShown() {
		bottom = faint.Render(truncate(m.paneHint(), m.paneWidth()))
	}
	pane := lipgloss.JoinVertical(lipgloss.Left, header, m.viewport.View(), bottom)
	body := lipgloss.JoinHorizontal(lipgloss.Top, m.renderRail(bodyHeight), " ", pane)
	body = lipgloss.NewStyle().Height(bodyHeight).MaxHeight(bodyHeight).Render(body)
	v := tea.NewView(lipgloss.JoinVertical(lipgloss.Left, body, m.renderStatus()))
	v.AltScreen = true
	return v
}

// paneTitle heads the main pane: the conversation, the Objective, or the kind of inbox item.
func (m model) paneTitle() string {
	switch m.pane {
	case paneObjective:
		name := m.objectiveID
		if overview := m.overviews[m.objectiveID]; overview != nil {
			name = firstLine(overview.GetObjective().GetOutcome())
		} else if objective := m.openObjective(m.objectiveID); objective != nil {
			name = firstLine(objective.GetOutcome())
		}
		return "Objective · " + terminalText(name)
	case paneInbox:
		return "Waiting on you · " + itemKindName(m.item.GetKind())
	}
	return fmt.Sprintf("%s · %s", terminalText(m.selectedTag()), conversationName)
}

// paneHint ends a pane that has no input line: the keys that act on it.
func (m model) paneHint() string {
	switch m.pane {
	case paneObjective:
		return "Live · answer its questions under Waiting on you"
	case paneInbox:
		switch {
		case m.decision == decisionConfirm:
			return "enter approves this request once · esc cancels"
		case m.decision == decisionSending:
			return "Waiting for the Control Plane…"
		case m.inboxItem(m.item.GetOccurrence()) == nil:
			return "This item is settled."
		case m.approvalShown():
			return "a approve · d deny"
		}
		return "Run the command above to act on it."
	}
	return ""
}

// truncate cuts s to width columns, ending it with "…" when cut.
func truncate(s string, width int) string {
	if lipgloss.Width(s) <= width {
		return s
	}
	if width < 1 {
		return ""
	}
	runes := []rune(s)
	for len(runes) > 0 && lipgloss.Width(string(runes))+1 > width {
		runes = runes[:len(runes)-1]
	}
	return string(runes) + "…"
}
