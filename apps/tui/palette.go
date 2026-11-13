package main

import (
	"fmt"
	"strings"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// paletteKey opens the command palette anywhere; `/` opens it where it would not be typed.
const paletteKey = "ctrl+k"

// commandID names a command the palette offers.
type commandID int

const (
	commandNewConversation commandID = iota
	commandSwitchConversation
	commandCreateObjective
	commandSwitchControlPlane
	commandOpenInbox
	commandTaskFiles
)

// paletteCommand is one row of the palette: what it does, and what it applies to.
type paletteCommand struct {
	id    commandID
	title string
	about string
}

// palette is the command palette: a filter, and the row under the cursor among the commands it
// matches.
type palette struct {
	filter textinput.Model
	cursor int
	slash  bool
}

// goal reads inline /goal text. When the slash opened the palette, it isn't in the filter.
func (p palette) goal() (string, bool) {
	text := p.filter.Value()
	if p.slash && !strings.HasPrefix(text, "/") {
		text = "/" + text
	}
	return goalOutcome(text)
}

// slashOpensPalette says whether `/` opens the palette rather than being typed: on an empty input
// line, or where the pane has no input line. Objective forms and follow-ups take `/` as text.
func (m model) slashOpensPalette() bool {
	if (m.pane == paneNewObjective || m.objectiveCompose) && m.focus == focusInput {
		return false
	}
	return m.focus == focusRail || !m.inputShown() || m.input.Value() == ""
}

// commands are what the palette offers now: those about a Tag only while one is selected, and
// switching Control Planes only when there is another.
func (a *app) commands() []paletteCommand {
	tag := terminalText(a.inner.selectedTag())
	var out []paletteCommand
	if tag != "" {
		out = append(out,
			paletteCommand{commandNewConversation, "New conversation", "with " + tag},
			paletteCommand{commandSwitchConversation, "Switch conversation", "with " + tag + " · ctrl+o"},
			paletteCommand{commandCreateObjective, "/goal · Create Objective", "owned by " + tag})
	}
	if len(a.contexts) > 1 || a.manageGateways() {
		title := "Switch Control Plane"
		if a.manageGateways() {
			title = "Gateways · add or switch"
		}
		about := "Add a Gateway"
		if a.hasTarget {
			about = contextLabel(a.contexts[a.current])
		}
		out = append(out, paletteCommand{commandSwitchControlPlane, title, about + " · " + switchKey})
	}
	if a.inner.client.RuntimeV2() {
		out = append(out, paletteCommand{commandTaskFiles, "Task files", "save files from a completed Task"})
	}
	waiting := fmt.Sprintf("%d waiting", len(a.inner.inbox.Items))
	if a.inner.inbox.Truncated {
		waiting = fmt.Sprintf("%d+ waiting", len(a.inner.inbox.Items))
	}
	return append(out, paletteCommand{commandOpenInbox, "Open inbox", waiting})
}

// matching filters by title, treating inline /goal text as the /goal command.
func (a *app) matching() []paletteCommand {
	words := strings.Fields(strings.ToLower(a.palette.filter.Value()))
	if _, goal := a.palette.goal(); goal {
		words = []string{"/goal"}
	}
	var out []paletteCommand
	for _, c := range a.commands() {
		title := strings.ToLower(c.title)
		ok := true
		for _, word := range words {
			if !strings.Contains(title, word) {
				ok = false
				break
			}
		}
		if ok {
			out = append(out, c)
		}
	}
	return out
}

// openPalette shows the palette with an empty filter.
func (a *app) openPalette(slash bool) tea.Cmd {
	filter := textinput.New()
	filter.Prompt = "> "
	if slash {
		filter.Prompt = "/"
	}
	filter.Placeholder = "Type to filter"
	filter.SetWidth(max(a.width-6, 10))
	cmd := filter.Focus()
	a.palette = &palette{filter: filter, slash: slash}
	return cmd
}

// paletteKeyPress moves through the palette, filters it, and runs the chosen command.
func (a *app) paletteKeyPress(msg tea.KeyPressMsg) tea.Cmd {
	p := a.palette
	matching := a.matching()
	switch msg.String() {
	case "ctrl+c":
		return tea.Quit
	case "esc", paletteKey:
		a.palette = nil
		return nil
	case "up":
		p.cursor = max(p.cursor-1, 0)
		return nil
	case "down":
		p.cursor = max(min(p.cursor+1, len(matching)-1), 0)
		return nil
	case "enter":
		if p.cursor >= len(matching) {
			return nil
		}
		a.palette = nil
		outcome, _ := p.goal()
		return a.run(matching[p.cursor].id, outcome)
	}
	var cmd tea.Cmd
	p.filter, cmd = p.filter.Update(msg)
	p.cursor = max(min(p.cursor, len(a.matching())-1), 0)
	return cmd
}

// run carries out a palette command.
func (a *app) run(id commandID, outcome string) tea.Cmd {
	var cmd tea.Cmd
	switch id {
	case commandSwitchControlPlane:
		a.choosing, a.choice, a.choiceErr = true, a.current, ""
		return nil
	case commandNewConversation:
		cmd = a.inner.newConversation()
	case commandSwitchConversation:
		cmd = a.inner.openPicker()
	case commandCreateObjective:
		cmd = a.inner.openObjectiveForm(outcome)
	case commandTaskFiles:
		return a.openTaskFiles()
	case commandOpenInbox:
		cmd = a.inner.openInbox()
	}
	return a.scope(cmd)
}

// newConversation opens the selected Tag's conversation list, naming a new conversation.
func (m *model) newConversation() tea.Cmd {
	if m.selectedTag() == "" {
		return nil
	}
	var load tea.Cmd
	if m.pane != paneConversations {
		load = m.openPicker()
	}
	return tea.Batch(load, m.startNaming())
}

// openInbox shows the first item waiting on you, with the rail focused on it to move through the
// others, or says that nothing waits.
func (m *model) openInbox() tea.Cmd {
	for i, r := range m.rows() {
		if r.kind != rowInbox {
			continue
		}
		m.cursor = i
		cmd := m.choose()
		m.focus = focusRail
		return tea.Batch(cmd, m.syncInput())
	}
	m.notice = note{text: "Nothing waits on you."}
	return nil
}

// renderPalette lists the commands that match the filter, filling the screen above the status
// line.
func (a *app) renderPalette() string {
	height := max(a.height-1, 2)
	width := max(a.width-2, 10)
	matching := a.matching()
	titleWidth := 0
	for _, c := range matching {
		titleWidth = max(titleWidth, lipgloss.Width(c.title))
	}
	rows := make([]string, 0, len(matching))
	for i, c := range matching {
		text := c.title + strings.Repeat(" ", titleWidth-lipgloss.Width(c.title)) + "  " + c.about
		style := lipgloss.NewStyle()
		if i == a.palette.cursor {
			style = focusedSel
		}
		rows = append(rows, style.Render(truncate(text, width)))
	}
	if len(rows) == 0 {
		rows = append(rows, faint.Render(truncate("No command matches.", width)))
	}
	footer := faint.Render(truncate("enter runs · ↑ ↓ choose · esc goes back", width))
	shown := max(height-4, 1)
	first := max(a.palette.cursor-shown+1, 0)
	rows = rows[first:min(first+shown, len(rows))]
	lines := append([]string{headerStyle.Render(truncate("Commands", width)), a.palette.filter.View()}, rows...)
	lines = append(lines, "", footer)
	return lipgloss.NewStyle().Padding(0, 1).Height(height).MaxHeight(height).Render(strings.Join(lines, "\n"))
}
