package main

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/apps/tui/views"
)

// activityShown is how many of a work Session's newest activity lines its expanded line shows.
const activityShown = 30

// workDetail is what was read of one work Session: the Session with its delivery, and the
// activity its latest Task recorded.
type workDetail struct {
	session *views.Session
	// err is why the last read failed, filtered for the terminal.
	err string
	// task is the Task activity was read for, and after its last event read.
	task     string
	after    int64
	activity []client.Activity
	seen     map[string]bool
	reload   *reload
}

type workMsg struct {
	id       string
	session  *views.Session
	task     string
	from     int64
	after    int64
	activity []client.Activity
	err      error
}

// target is one line of a conversation chosen with up and down: a work Session's "working" line,
// or the branch line after its latest report.
type target struct {
	session string
	branch  bool
}

func (m model) workDetail(id string) *workDetail {
	d, ok := m.work[id]
	if !ok {
		d = &workDetail{reload: &reload{}, seen: map[string]bool{}}
		m.work[id] = d
	}
	return d
}

// reloadWork rereads a work Session and its latest Task's new activity.
func (m model) reloadWork(id string) tea.Cmd {
	if !m.workDetail(id).reload.start() {
		return nil
	}
	return m.workCmd(id)
}

func (m model) workCmd(id string) tea.Cmd {
	d := m.work[id]
	task, after := d.task, d.after
	c, ctx := m.client, m.ctx
	return func() tea.Msg {
		session, err := c.GetSession(ctx, id)
		if err != nil {
			return workMsg{id: id, err: err}
		}
		msg := workMsg{id: id, session: session, task: session.GetLatestTaskId()}
		if msg.task == "" {
			return msg
		}
		if msg.task != task {
			after = 0
		}
		msg.from = after
		msg.activity, msg.after, msg.err = c.TaskActivity(ctx, msg.task, after)
		return msg
	}
}

// workRead takes what was read of a work Session.
func (m *model) workRead(msg workMsg) tea.Cmd {
	d := m.workDetail(msg.id)
	var again tea.Cmd
	if d.reload.done() {
		again = m.workCmd(msg.id)
	}
	d.err = ""
	if msg.err != nil {
		d.err = terminalText(msg.err.Error())
	}
	if msg.session != nil {
		d.session = msg.session
		if msg.task != d.task {
			d.task, d.after, d.activity, d.seen = msg.task, 0, nil, map[string]bool{}
		}
		if msg.err == nil && msg.from == d.after {
			for _, a := range msg.activity {
				if !d.seen[a.Key] {
					d.seen[a.Key] = true
					d.activity = append(d.activity, a)
				}
			}
			d.after = msg.after
		}
	}
	if m.pane == paneConversation {
		m.refresh()
	}
	return again
}

// branch is what a work Session delivered on a branch, or nil before it did.
func (d *workDetail) branch() *views.WorkspaceDelivery {
	if d == nil {
		return nil
	}
	delivery := d.session.GetDelivery().GetDelivery()
	workspace := delivery.GetWorkspace()
	if workspace.GetBranch() == "" || (workspace.GetHead() == "" && delivery.GetPullRequest() == nil) {
		return nil
	}
	return workspace
}

// pullRequest is the web address of the pull request a work Session opened, or "".
func (d *workDetail) pullRequest() string {
	if d == nil {
		return ""
	}
	return d.session.GetDelivery().GetDelivery().GetPullRequest().GetUrl()
}

// shownEntries are the conversation's entries in the order it shows them: each turn's, oldest
// first, then those of the conversation itself.
func shownEntries(c *conversation) []entry {
	var entries []entry
	for _, id := range c.runtime.order {
		if turn := c.runtime.turns[id]; turn != nil {
			entries = append(entries, turn.entries...)
		}
	}
	return append(entries, c.entries...)
}

// anchors are the index of each work Session's first "working" line, and of its latest report.
func anchors(entries []entry) (working, reports map[string]int) {
	working, reports = map[string]int{}, map[string]int{}
	for i, e := range entries {
		if e.session == "" {
			continue
		}
		switch e.kind {
		case entryWork:
			if _, ok := working[e.session]; !ok {
				working[e.session] = i
			}
		case entryReport:
			reports[e.session] = i
		}
	}
	return working, reports
}

// targets are the lines of a conversation up and down choose between, top to bottom.
func (m model) targets(c *conversation) []target {
	entries := shownEntries(c)
	working, reports := anchors(entries)
	var out []target
	for i, e := range entries {
		if e.session == "" {
			continue
		}
		if e.kind == entryWork && working[e.session] == i {
			out = append(out, target{session: e.session})
		}
		if e.kind == entryReport && reports[e.session] == i && m.work[e.session].branch() != nil {
			out = append(out, target{session: e.session, branch: true})
		}
	}
	return out
}

// selectionHint ends the conversation pane while a line is selected: the keys that act on it.
func (m model) selectionHint(t target) string {
	d := m.work[t.session]
	parts := []string{"enter shows details"}
	if m.expanded[t.session] {
		parts[0] = "enter hides details"
	}
	if d.branch() != nil {
		parts = append(parts, "d diff")
	}
	if d.pullRequest() != "" {
		parts = append(parts, "o open the pull request")
	}
	return strings.Join(append(parts, "esc back"), " · ")
}

// renderWorkLine renders a work Session's line in the work Sessions pane, its title and latest
// state, and under it, when expanded, its Session, activity, report and delivery.
func (m model) renderWorkLine(e entry, selected bool, width int) string {
	marker := "·"
	if m.expanded[e.session] {
		marker = "▾"
	}
	line := marker + " " + e.text
	if state := m.workState(e.session); state != "" {
		line += " · " + state
	}
	style := faint
	if selected {
		style = focusedSel
	}
	out := style.Render(truncate(line, width)) + "\n"
	if !m.expanded[e.session] {
		return out
	}
	return out + m.renderWorkDetail(e.session, width) + "\n"
}

// workState is a work Session's latest state: what it last reported, else its latest Task's
// status once read.
func (m model) workState(id string) string {
	if d := m.work[id]; d != nil {
		if closed := d.session.GetClosed(); closed != "" {
			return "closed: " + closed
		}
	}
	if state := m.workStates[id]; state != "" {
		return state
	}
	if d := m.work[id]; d != nil && d.session.GetLatestTaskStatus() != views.TaskStatus_TASK_STATUS_UNSPECIFIED {
		status := d.session.GetLatestTaskStatus()
		return enumWords(status.String(), "TASK_STATUS_")
	}
	return ""
}

// renderWorkDetail is an expanded work Session: its Session and latest Task, the activity that
// Task recorded, its report, and what it delivered. Every line is filtered for the terminal.
func (m model) renderWorkDetail(id string, width int) string {
	const indent = "    "
	wrap := lipgloss.NewStyle().Width(max(width-len(indent), 10))
	d := m.work[id]
	var lines []string
	add := func(line ...string) { lines = append(lines, line...) }
	if d == nil || (d.session == nil && d.err == "") {
		add("Reading the work Session…")
	} else {
		if d.err != "" {
			add(errorStyle.Render("Could not read the work Session: " + d.err))
		}
		if session := d.session; session != nil {
			line := "Session " + session.GetId()
			if task := session.GetLatestTaskId(); task != "" {
				line += fmt.Sprintf(" · Task %s %s", task, enumWords(session.GetLatestTaskStatus().String(), "TASK_STATUS_"))
			}
			add(terminalText(line))
			add("Activity:")
			activity := d.activity
			if len(activity) == 0 {
				add("  None recorded yet.")
			}
			if hidden := len(activity) - activityShown; hidden > 0 {
				add(fmt.Sprintf("  (%d earlier not shown)", hidden))
				activity = activity[hidden:]
			}
			for _, a := range activity {
				add("  " + terminalText(a.Line))
			}
		}
	}
	if report := m.latestReport(id); report != "" {
		add("Report:")
		for _, line := range strings.Split(report, "\n") {
			add("  " + line)
		}
	}
	if d != nil {
		for _, line := range deliveryLines(d.session.GetDelivery().GetDelivery(), "") {
			add(terminalText(line))
		}
	}
	for i, line := range lines {
		lines[i] = indent + strings.ReplaceAll(wrap.Render(line), "\n", "\n"+indent)
	}
	return faint.Render(strings.Join(lines, "\n"))
}

// latestReport is the text of the shown conversation's latest report from a work Session.
func (m model) latestReport(id string) string {
	c := m.shown()
	if c == nil {
		return ""
	}
	entries := shownEntries(c)
	_, reports := anchors(entries)
	if i, ok := reports[id]; ok {
		return entries[i].text
	}
	return ""
}

// renderBranchLine is the line after a work Session's latest report that names its branch and
// the keys that review it.
func (m model) renderBranchLine(id string, selected bool, width int) string {
	d := m.work[id]
	workspace := d.branch()
	line := "Branch " + terminalText(workspace.GetBranch())
	keys := "   [d] diff"
	if d.pullRequest() != "" {
		keys += "  [o] open"
	}
	line = truncate(line, max(width-lipgloss.Width(keys), 1)) + keys
	if selected {
		return focusedSel.Render(line)
	}
	return bold.Render(line)
}
