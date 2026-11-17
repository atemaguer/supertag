package main

import (
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// The conversation shows only messages, as a messaging app does. What its turns did, their work
// Sessions with their activity, reports and branches, is one key away: up on an empty input opens
// the work Sessions pane, where up and down choose a work Session, enter shows its details, d its
// diff and o its pull request, and esc goes back.

// openWorkPane shows the shown conversation's work Sessions with the latest selected; false when it
// has none.
func (m *model) openWorkPane() (tea.Cmd, bool) {
	c := m.shown()
	if c == nil {
		return nil, false
	}
	targets := m.targets(c)
	if len(targets) == 0 {
		return nil, false
	}
	m.saveDraft()
	c.selected = &targets[len(targets)-1]
	m.pane = paneWork
	m.syncInput()
	m.viewport.GotoTop()
	m.refresh()
	var cmds []tea.Cmd
	for _, t := range targets {
		if !t.branch {
			cmds = append(cmds, m.reloadWork(t.session))
		}
	}
	return tea.Batch(cmds...), true
}

// workPaneKey handles a key in the work Sessions pane; ok is false for a key it leaves to others.
func (m model) workPaneKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd, bool) {
	c := m.shown()
	if c == nil {
		return m, nil, false
	}
	targets := m.targets(c)
	if len(targets) == 0 {
		return m, nil, false
	}
	at := len(targets) - 1
	for i, t := range targets {
		if c.selected != nil && t == *c.selected {
			at = i
		}
	}
	c.selected = &targets[at]
	switch msg.String() {
	case "up", "k":
		c.selected = &targets[max(at-1, 0)]
	case "down", "j":
		c.selected = &targets[min(at+1, len(targets)-1)]
	case "enter":
		id := c.selected.session
		m.expanded[id] = !m.expanded[id]
		m.refresh()
		if m.expanded[id] {
			return m, m.reloadWork(id), true
		}
		return m, nil, true
	case "d":
		return m, m.showDiff(c.selected.session), true
	case "o":
		return m, m.openPullRequest(m.work[c.selected.session].pullRequest()), true
	default:
		return m, nil, msg.String() != "esc" && msg.String() != "tab" && msg.String() != "shift+tab"
	}
	m.refresh()
	return m, nil, true
}

// renderWorkPane lists the shown conversation's work Sessions, oldest first, each with its branch
// line once it delivered one. It records the selected line's position for refresh to keep it in
// view.
func (m model) renderWorkPane() string {
	c := m.shown()
	width := m.paneWidth()
	wrap := lipgloss.NewStyle().Width(width)
	if c == nil {
		return ""
	}
	targets := m.targets(c)
	// How much room the Tag has to start more, across all its conversations.
	count := ""
	if tag := m.shownTag(); tag != nil {
		if text := tag.GetSpec().WorkSessionCount(); text != "" {
			count = faint.Render(wrap.Render(text)) + "\n"
		}
	}
	if len(targets) == 0 {
		return count + faint.Render(wrap.Render("This conversation has started no work Sessions."))
	}
	titles := map[string]string{}
	for _, e := range shownEntries(c) {
		if e.kind == entryWork && titles[e.session] == "" {
			titles[e.session] = strings.TrimPrefix(e.text, "· working: ")
		}
	}
	var out strings.Builder
	out.WriteString(count)
	lines := strings.Count(count, "\n")
	for _, t := range targets {
		chosen := c.selected != nil && *c.selected == t
		if chosen {
			c.selectedLine = lines
		}
		var text string
		if t.branch {
			text = "  " + m.renderBranchLine(t.session, chosen, width-2) + "\n"
		} else {
			text = m.renderWorkLine(entry{kind: entryWork, text: titles[t.session], session: t.session}, chosen, width)
		}
		out.WriteString(text)
		lines += strings.Count(text, "\n")
	}
	return strings.TrimRight(out.String(), "\n")
}
