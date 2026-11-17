package main

import (
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/glamour/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/atemaguer/supertag/apps/tui/views"

	"github.com/atemaguer/supertag/apps/tui/client"
)

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

func (m model) paneWidth() int { return max(m.width-m.railWidth()-2, 10) }

// layout sizes the viewport and input to the window: one status line, and in the pane a header,
// the conversation and the input line.
func (m *model) layout() {
	m.viewport.SetWidth(m.paneWidth())
	m.viewport.SetHeight(max(m.height-3, 1))
	m.shownContent.id = 0
	m.input.SetWidth(m.paneWidth() - 3)
	if m.form != nil {
		for i := range m.form.fields {
			m.form.fields[i].SetWidth(m.paneWidth() - 3)
		}
	}
	if m.tagForm != nil {
		m.tagForm.name.SetWidth(m.paneWidth() - 3)
	}
	m.refresh()
}

// refresh redraws the main pane. A conversation stays at the bottom when it was there; the other
// panes keep their scroll position.
func (m *model) refresh() {
	switch m.pane {
	case paneObjective:
		m.setContent(m.renderObjective())
	case paneInbox:
		m.setContent(m.renderItem())
	case paneDiff:
		m.setContent(m.renderDiffPane())
	case paneTeam:
		m.setContent(m.renderTeam())
	case paneNewObjective:
		m.setContent(m.renderObjectiveForm())
	case paneNewTag:
		m.setContent(m.renderTagForm())
	case paneWork:
		m.setContent(m.renderWorkPane())
		if c := m.shown(); c != nil && c.selected != nil {
			m.viewport.EnsureVisible(c.selectedLine, 0, 0)
		}
	default:
		atBottom := m.viewport.AtBottom()
		m.setContent(m.renderConversation())
		if atBottom {
			m.viewport.GotoBottom()
			m.sawBottom()
		}
	}
}

// renderConversation renders the shown conversation or setup guidance before a Tag is available.
// Each entry is rendered once per width, except work Session lines and branch lines, which
// change as they are selected, expanded and read. It records the selected line's position for
// refresh to keep it in view.
func (m model) renderConversation() string {
	tag := m.selectedTag()
	wrap := lipgloss.NewStyle().Width(m.paneWidth())
	if tag == "" {
		switch {
		case !m.tagsChecked:
			return faint.Render(wrap.Render("Checking for Tags on the Control Plane…"))
		case m.tagsErr != nil:
			return wrap.Render("Could not check for Tags on this Control Plane.\n\n" + terminalText(m.tagsErr.Error()))
		default:
			if m.tagAdminRefusal() == "" {
				return wrap.Render("No Tags are set up on this Control Plane.\n\n" +
					"Press ctrl+n to create one, or run supertag tag put --help for setup.")
			}
			return wrap.Render("No Tags are set up on this Control Plane.\n\n" +
				"Run supertag tag put --help for setup. For a shared Control Plane, ask its operator to set up a Tag.")
		}
	}
	name := terminalText(m.tagLabel(tag))
	c := m.conversations[tag]
	if c == nil || !c.loaded {
		return faint.Render(wrap.Render("Reading the conversation…"))
	}
	if text := m.renderTranscript(c, tag, name, m.paneWidth()); text != "" {
		return text
	}
	return faint.Render(wrap.Render("Say something to " + name + ". You have one conversation with it."))
}

// renderEntry renders the body of an entry that does not change once added, without its sender.
func (m model) renderEntry(e entry, width int) string {
	wrap := lipgloss.NewStyle().Width(width)
	switch e.kind {
	case entryYou:
		return wrap.Render(e.text) + "\n"
	case entryReply, entryReport, entryMessage:
		return m.md.render(e.text, width) + "\n"
	case entryError:
		return errorStyle.Render(wrap.Render(e.text)) + "\n"
	}
	return faint.Render(wrap.Render(e.text)) + "\n"
}

// renderRail lists the Tags, the open Objectives and what waits on you, one row each, cut to
// fit, scrolled so the row under the cursor shows.
func (m model) renderRail(height int) string { return m.railBlock(height).text }

// railLines are the rail's rows at height, before the rail's border and padding. The folded rail
// shows each Tag's initials, starred for the lead, with a dot for unread replies or "…" while it
// works.
func (m model) railLines(height int) string {
	paneKey := m.paneKey()
	railContent := m.railContent()
	narrow := m.rail != nil && m.rail.Collapsed
	now := m.now()
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
			if r.kind == rowTag {
				// A Tag's state or time sits at the rail's right edge, as in a messaging app's list.
				line += strings.Repeat(" ", max(labelWidth-lipgloss.Width(truncate(label, labelWidth)), 0))
			}
			line += " " + faint.Render(state)
		}
		lines = append(lines, line)
	}
	section := func(title, short, err string) {
		if narrow {
			title = short
		}
		lines = append(lines, headerStyle.Render(truncate(title, railContent)))
		if err != "" && !narrow {
			lines = append(lines, errorStyle.Render(truncate(strings.Join(strings.Fields(err), " "), railContent)))
		}
	}

	section("Tags", "Tags", "")
	for i, tag := range m.tags {
		summary := m.summaries[m.tagReference(tag)]
		if narrow {
			add(row{rowTag, i}, narrowTag(tag, summary), "")
			continue
		}
		add(row{rowTag, i}, terminalText(railTagName(tag)), railState(tag, summary, now))
		if preview := railPreview(summary); preview != "" {
			style := faint
			if summary.GetUnreadCount() > 0 {
				style = bold
			}
			lines = append(lines, style.Render(truncate("  "+preview, railContent)))
		}
	}
	if len(m.objectives) > 0 || m.objectivesErr != "" {
		section("Objectives", "Obj", m.objectivesErr)
		for i, objective := range m.objectives {
			state := objectiveState(objective)
			if narrow {
				state = ""
			}
			add(row{rowObjective, i}, objectiveName(objective), state)
		}
	}
	waiting := fmt.Sprintf("Waiting on you (%d)", len(m.inbox.Items))
	short := fmt.Sprintf("?%d", len(m.inbox.Items))
	if m.inbox.Truncated {
		waiting = fmt.Sprintf("Waiting on you (%d+)", len(m.inbox.Items))
		short += "+"
	}
	section(waiting, short, m.inboxErr)
	for i, item := range m.inbox.Items {
		add(row{rowInbox, i}, m.inboxRow(item), "")
	}
	if len(m.teams) > 0 || m.teamsErr != "" {
		section("Teams", "Team", m.teamsErr)
		for i, team := range m.teams {
			state := teamState(team)
			if narrow {
				state = ""
			}
			add(row{rowTeam, i}, terminalText(team.GetName()), state)
		}
	}

	first := max(cursorLine-height+1, 0)
	lines = lines[first:min(first+height, len(lines))]
	return strings.Join(lines, "\n")
}

// narrowTag is a Tag's row in the folded rail: a star for the lead, its initials, and a dot for
// unread replies or "…" while it works.
func narrowTag(tag *views.Tag, summary *views.Conversation) string {
	marker := " "
	if tag.GetSpec().GetLead() {
		marker = "★"
	}
	state := " "
	switch {
	case summary.GetWorking():
		state = "…"
	case summary.GetUnreadCount() > 0:
		state = "•"
	}
	name := initials(terminalText(tagName(tag)))
	return marker + name + strings.Repeat(" ", max(2-lipgloss.Width(name), 0)) + state
}

// tagName is a Tag's name.
func tagName(tag *views.Tag) string { return tag.GetMetadata().GetName() }

// railTagName is a Tag's name in the rail, starred for the lead Tag.
func railTagName(tag *views.Tag) string {
	if tag.GetSpec().GetLead() {
		return "★ " + tagName(tag)
	}
	return tagName(tag)
}

// tagPhases are the words the rail shows for a Tag's phase, as `supertag get tags` prints it.
var tagPhases = map[views.TagPhase]string{
	views.TagPhase_TAG_PHASE_ACTIVE:  "active",
	views.TagPhase_TAG_PHASE_RETIRED: "retired",
}

// railState is what the rail shows beside a Tag: while it is active, that it works in your
// conversation, how many of its replies there you have not read, or when the conversation was
// last active; otherwise its phase.
func railState(tag *views.Tag, summary *views.Conversation, now time.Time) string {
	phase := tag.GetStatus().GetPhase()
	if phase == views.TagPhase_TAG_PHASE_ACTIVE {
		switch {
		case summary.GetWorking():
			return "working"
		case summary.GetUnreadCount() > 0:
			return fmt.Sprintf("%d new", summary.GetUnreadCount())
		}
		return railTime(summary.GetLastActivityAtMs(), now)
	}
	return tagPhases[phase]
}

// railPreview is the line under a Tag in the rail: the latest message of your conversation with
// it, filtered for the terminal, or empty before you talk to it.
func railPreview(summary *views.Conversation) string {
	text := firstLine(summary.GetPreview())
	switch {
	case summary.GetLatestWorkSessionReportId() != "" && !summary.GetPreviewFromTag():
		// A report turn has no message from you; its reply is the report.
		text = "Work Session report pending."
	case text != "" && !summary.GetPreviewFromTag():
		text = "you: " + text
	}
	return terminalText(text)
}

// renderStatus is the status line: the Control Plane, its Worker Hosts, how to open the command
// palette and to switch to another Control Plane when there is one, and whether it is reachable.
func (m model) renderStatus() string {
	left := " " + contextLabel(m.client.Target()) + "  "
	if client.IsClientCredential(m.client.Target().Token) {
		left += "client device  "
	} else if hosts := m.hostSummary(); hosts != "" {
		left += hosts + "  "
	}
	shown := ""
	if m.pane == paneConversation {
		shown = m.selectedTag()
	}
	if unread := unreadTotal(m.summaries, shown); unread > 0 {
		left += fmt.Sprintf("%d unread  ", unread)
	}
	left += "ctrl+k search  "
	if m.switchable {
		left += "ctrl+p Control Planes  "
	}
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
	switch {
	case m.notice.text != "" && m.notice.err:
		bottom = errorStyle.Render(truncate(m.notice.text, m.paneWidth()))
	case m.notice.text != "":
		bottom = okStyle.Render(truncate(m.notice.text, m.paneWidth()))
	case !m.inputShown():
		bottom = faint.Render(truncate(m.paneHint(), m.paneWidth()))
	}
	v := tea.NewView(composeScreen(m.railBlock(bodyHeight), m.viewportBlock(), header, bottom, m.renderStatus(), bodyHeight))
	v.AltScreen = true
	// A reply in the conversation in front notifies while the terminal is in the background.
	v.ReportFocus = true
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
		title := "Waiting on you · " + itemKindName(m.item.GetKind())
		if state := inboxWaitState(m.item); state != "" &&
			(m.item.GetApproval() == nil) {
			title += " · " + state
		}
		return title
	case paneDiff:
		return "Diff · " + m.diff.title
	case paneTeam:
		name := m.teamID
		if view, ok := m.teamViews[m.teamID]; ok {
			name = view.Team.GetName()
		} else if team := m.listedTeam(m.teamID); team != nil {
			name = team.GetName()
		} else if gone := m.teamReads.gone[m.teamID]; gone != "" {
			name = gone
		}
		return "Team · " + terminalText(name)
	case paneNewObjective:
		return "New Objective · owned by " + terminalText(m.tagLabel(m.form.owner))
	case paneNewTag:
		return "New Tag"
	case paneWork:
		return "Work Sessions · " + terminalText(m.tagLabel(m.selectedTag()))
	}
	tag := m.selectedTag()
	if tag == "" {
		if m.tagsChecked && m.tagsErr == nil {
			return "Set up SuperTag"
		}
		return "SuperTag"
	}
	title := terminalText(m.tagLabel(tag))
	if n := m.newSince(); n == 1 {
		title += " · ↓ 1 new message · end jumps to it"
	} else if n > 1 {
		title += fmt.Sprintf(" · ↓ %d new messages · end jumps to them", n)
	}
	return title
}

// paneHint ends a pane that has no input line: the keys that act on it.
func (m model) paneHint() string {
	switch m.pane {
	case paneObjective:
		if m.canMessageObjective() {
			return "m message the owner · answer questions under Waiting on you"
		}
		return "Answer questions under Waiting on you"

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
		case m.item.GetApproval() != nil:
			if m.approvalDetails.err != nil {
				return "r reload approval details"
			}
			return ""
		}
		return "Run the command above to act on it."
	case paneDiff:
		return m.diffHint()
	case paneTeam:
		return "Live · its Workstream updates as members post"
	case paneNewObjective:
		return m.formHint()
	case paneNewTag:
		return m.tagFormHint()
	case paneWork:
		if c := m.shown(); c != nil && c.selected != nil {
			return m.selectionHint(*c.selected)
		}
		return "esc back to the conversation"
	case paneConversation:
		if m.shown() == nil {
			return "esc quits"
		}
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
	// One pass over s: cutting a rune at a time and measuring again is quadratic in a long label,
	// such as a 500-character question in the rail, and the rail truncates every row each frame.
	return ansi.Truncate(s, width, "…")
}
