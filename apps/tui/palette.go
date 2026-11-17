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

// palettePlaceholder is what the palette's filter says before anything is typed, as in the
// desktop app.
const palettePlaceholder = "Search Tags, conversations, settings…"

// commandID names a command the palette offers.
type commandID int

const (
	commandOpenTag commandID = iota
	commandNewTag
	commandKeyboardShortcuts
	commandSwitchGateway
	commandCreateObjective
	commandTaskFiles
	commandOpenInbox
	commandNotes
	commandNetwork
	commandActivity
	commandSchedules
)

// paletteCommand is one row of the palette: a Tag in the Tags section, or an action in the
// Actions section, with what it applies to and the key that does the same outside the palette.
type paletteCommand struct {
	id    commandID
	title string
	about string
	key   string
	// tag is the rail index of the Tag commandOpenTag opens.
	tag int
	// search is more text the row is found by, such as the Tag's ID.
	search string
}

// palette is the command palette: a filter, and the row under the cursor among the rows it
// matches. shortcuts shows the keyboard shortcuts in its place.
type palette struct {
	filter    textinput.Model
	cursor    int
	slash     bool
	shortcuts bool
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
	if (m.pane == paneNewObjective || m.pane == paneNewTag || m.objectiveCompose) && m.focus == focusInput {
		return false
	}
	return m.focus == focusRail || !m.inputShown() || m.input.Value() == ""
}

// paletteTags are the Tags section: each Tag in rail order with its latest message, the first
// nine with the alt+N key that opens them.
func (a *app) paletteTags() []paletteCommand {
	m := a.inner
	out := make([]paletteCommand, 0, len(m.tags))
	for i, tag := range m.tags {
		row := paletteCommand{
			id:     commandOpenTag,
			title:  terminalText(railTagName(tag)),
			about:  railPreview(m.summaries[m.tagReference(tag)]),
			tag:    i,
			search: terminalText(m.tagReference(tag)),
		}
		if i < 9 {
			row.key = fmt.Sprintf("alt+%d", i+1)
		}
		out = append(out, row)
	}
	return out
}

// commands are the Actions section: New Tag, the keyboard shortcuts, the Gateways, then
// those about a Tag only while one is selected, Task files, and the inbox.
func (a *app) commands() []paletteCommand {
	newTag := "a name, a harness and a Workspace"
	if refusal := a.inner.tagAdminRefusal(); refusal != "" {
		newTag = "operators only"
	}
	out := []paletteCommand{
		{id: commandNewTag, title: "New Tag", about: newTag, key: newTagKey},
		{id: commandKeyboardShortcuts, title: "Keyboard shortcuts", about: "every key the app answers to"},
	}
	about := "Add a Gateway"
	if a.hasTarget {
		about = contextLabel(a.contexts[a.current])
	}
	out = append(out, paletteCommand{id: commandSwitchGateway, title: "Gateways · add or switch", about: about, key: switchKey})

	if tag := terminalText(a.inner.selectedTag()); tag != "" {
		out = append(out, paletteCommand{id: commandCreateObjective, title: "/goal · Create Objective", about: "owned by " + tag})
		out = append(out, paletteCommand{id: commandActivity, title: "Activity", about: "how " + tag + "'s unprompted messages landed · start rate"})
		out = append(out, paletteCommand{id: commandNotes, title: "Notes", about: "what " + tag + " remembers · delete a note"})
		out = append(out, paletteCommand{id: commandNetwork, title: "Network", about: "web requests " + tag + "'s Tasks made, allowed or refused"})
		out = append(out, paletteCommand{id: commandSchedules, title: "Schedules", about: "when " + tag + " wakes up · pause, resume or delete"})
	}
	out = append(out, paletteCommand{id: commandTaskFiles, title: "Task files", about: "save files from a completed Task"})

	waiting := fmt.Sprintf("%d waiting", len(a.inner.inbox.Items))
	if a.inner.inbox.Truncated {
		waiting = fmt.Sprintf("%d+ waiting", len(a.inner.inbox.Items))
	}
	return append(out, paletteCommand{id: commandOpenInbox, title: "Open inbox", about: waiting})
}

// matches says whether every word appears in the text, ignoring case.
func matches(text string, words []string) bool {
	text = strings.ToLower(text)
	for _, word := range words {
		if !strings.Contains(text, word) {
			return false
		}
	}
	return true
}

// matchingTags are the Tags whose name, ID or latest message match the filter. Inline /goal text
// matches none.
func (a *app) matchingTags() []paletteCommand {
	if _, goal := a.palette.goal(); goal {
		return nil
	}
	words := strings.Fields(strings.ToLower(a.palette.filter.Value()))
	var out []paletteCommand
	for _, c := range a.paletteTags() {
		if matches(c.title+" "+c.search+" "+c.about, words) {
			out = append(out, c)
		}
	}
	return out
}

// matchingActions filters the actions by title and caption, treating inline /goal text as the
// /goal command.
func (a *app) matchingActions() []paletteCommand {
	words := strings.Fields(strings.ToLower(a.palette.filter.Value()))
	_, goal := a.palette.goal()
	var out []paletteCommand
	for _, c := range a.commands() {
		if goal && c.id == commandCreateObjective || !goal && matches(c.title+" "+c.about, words) {
			out = append(out, c)
		}
	}
	return out
}

// matching are the rows the cursor moves through: the matching Tags, then the matching actions.
func (a *app) matching() []paletteCommand {
	return append(a.matchingTags(), a.matchingActions()...)
}

// openPalette shows the palette with an empty filter.
func (a *app) openPalette(slash bool) tea.Cmd {
	filter := textinput.New()
	filter.Prompt = "> "
	if slash {
		filter.Prompt = "/"
	}
	filter.Placeholder = palettePlaceholder
	filter.SetWidth(max(a.width-6, 10))
	cmd := filter.Focus()
	a.palette = &palette{filter: filter, slash: slash}
	return cmd
}

// paletteKeyPress moves through the palette, filters it, and runs the chosen row. alt+1 to alt+9
// open a Tag at once.
func (a *app) paletteKeyPress(msg tea.KeyPressMsg) tea.Cmd {
	p := a.palette
	if p.shortcuts {
		switch msg.String() {
		case "ctrl+c":
			return tea.Quit
		case paletteKey:
			a.palette = nil
		case "esc", "enter":
			p.shortcuts = false
		}
		return nil
	}
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
		chosen := matching[p.cursor]
		if chosen.id == commandKeyboardShortcuts {
			p.shortcuts = true
			return nil
		}
		a.palette = nil
		if outcome, _ := p.goal(); outcome != "" && chosen.id == commandCreateObjective {
			return a.scope(a.inner.sendGoal(outcome))
		}
		return a.run(chosen)
	}
	if n, ok := tagKey(msg.String()); ok {
		if n >= len(a.inner.tags) {
			return nil
		}
		a.palette = nil
		return a.run(paletteCommand{id: commandOpenTag, tag: n})
	}
	var cmd tea.Cmd
	p.filter, cmd = p.filter.Update(msg)
	p.cursor = max(min(p.cursor, len(a.matching())-1), 0)
	return cmd
}

// run carries out a palette row.
func (a *app) run(c paletteCommand) tea.Cmd {
	var cmd tea.Cmd
	switch c.id {
	case commandOpenTag:
		cmd = a.inner.selectNthTag(c.tag)
	case commandSwitchGateway:
		a.choosing, a.choice, a.choiceErr = true, a.current, ""
		return nil
	case commandCreateObjective:
		cmd = a.inner.openObjectiveForm("")
	case commandTaskFiles:
		return a.openTaskFiles()
	case commandNotes:
		return a.openNotes()
	case commandNetwork:
		return a.openNetwork()
	case commandActivity:
		return a.openActivity()
	case commandSchedules:
		return a.openSchedules()
	case commandOpenInbox:
		cmd = a.inner.openInbox()
	case commandNewTag:
		cmd = a.inner.openTagForm()
	}
	return a.scope(cmd)
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

// keyboardShortcuts are every key the terminal UI answers to, as Keyboard shortcuts lists them.
var keyboardShortcuts = [][2]string{
	{paletteKey, "Search Tags, conversations, settings"},
	{switchKey, "Switch Gateways"},
	{"alt+1…alt+9", "Open the nth Tag in the rail"},
	{"alt+↑ alt+↓", "Open the previous or next Tag"},
	{"ctrl+b", "Fold the rail, or expand it"},
	{newTagKey, "New Tag"},
	{"ctrl+r ctrl+x", "Send an undelivered message again, or edit it"},
	{"end", "Jump to the latest message"},
	{"↑ on empty input", "List the conversation's work Sessions"},
	{"tab", "Move between the rail and the main pane"},
	{"esc", "Go back"},
	{"ctrl+c", "Quit"},
}

// renderPalette lists the Tags and actions that match the filter, section by section, filling
// the screen above the status line.
func (a *app) renderPalette() string {
	height := max(a.height-1, 2)
	width := max(a.width-2, 10)
	if a.palette.shortcuts {
		return a.renderShortcuts(height, width)
	}
	tags, actions := a.matchingTags(), a.matchingActions()
	titleWidth := 0
	for _, c := range append(tags, actions...) {
		titleWidth = max(titleWidth, lipgloss.Width(c.title))
	}
	titleWidth = min(titleWidth, width/2)
	var rows []string
	cursorLine, at := 0, 0
	add := func(c paletteCommand) {
		title := truncate(c.title, titleWidth)
		text := title + strings.Repeat(" ", titleWidth-lipgloss.Width(title)) + "  " + c.about
		textWidth := width
		if c.key != "" {
			textWidth -= lipgloss.Width(c.key) + 2
		}
		text = truncate(text, textWidth)
		if c.key != "" {
			text += strings.Repeat(" ", max(textWidth-lipgloss.Width(text), 0)) + "  " + c.key
		}
		style := lipgloss.NewStyle()
		if at == a.palette.cursor {
			style = focusedSel
			cursorLine = len(rows)
		}
		at++
		rows = append(rows, style.Render(text))
	}
	if len(tags) > 0 {
		rows = append(rows, headerStyle.Render("Tags"))
		for _, c := range tags {
			add(c)
		}
	}
	if len(actions) > 0 {
		if len(rows) > 0 {
			rows = append(rows, "")
		}
		rows = append(rows, headerStyle.Render("Actions"))
		for _, c := range actions {
			add(c)
		}
	}
	if len(rows) == 0 {
		rows = append(rows, faint.Render(truncate("No results", width)))
	}
	footer := faint.Render(truncate("enter opens · ↑ ↓ choose · alt+1…9 open a Tag · esc goes back", width))
	shown := max(height-4, 1)
	first := max(cursorLine-shown+1, 0)
	rows = rows[first:min(first+shown, len(rows))]
	lines := append([]string{a.palette.filter.View(), ""}, rows...)
	lines = append(lines, "", footer)
	return lipgloss.NewStyle().Padding(0, 1).Height(height).MaxHeight(height).Render(strings.Join(lines, "\n"))
}

// renderShortcuts lists the keyboard shortcuts in place of the palette.
func (a *app) renderShortcuts(height, width int) string {
	keyWidth := 0
	for _, s := range keyboardShortcuts {
		keyWidth = max(keyWidth, lipgloss.Width(s[0]))
	}
	lines := []string{headerStyle.Render(truncate("Keyboard shortcuts", width)), ""}
	for _, s := range keyboardShortcuts {
		lines = append(lines, truncate(s[0]+strings.Repeat(" ", keyWidth-lipgloss.Width(s[0]))+"  "+s[1], width))
	}
	lines = append(lines, "", faint.Render(truncate("esc goes back", width)))
	lines = lines[:min(len(lines), height)]
	return lipgloss.NewStyle().Padding(0, 1).Height(height).MaxHeight(height).Render(strings.Join(lines, "\n"))
}
