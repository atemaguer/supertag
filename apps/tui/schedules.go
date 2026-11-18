package main

import (
	"context"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/apps/tui/views"
)

// schedulesDialog lists the selected Tag's Schedules that can still fire. Each can be paused,
// resumed, or deleted; the Watch keeps the list current.
type schedulesDialog struct {
	tag, label string
	schedules  []client.Schedule
	cursor     int
	busy       bool
	read       bool
	note       string
	cancel     context.CancelFunc
}

type schedulesMsg struct {
	dialog    *schedulesDialog
	schedules []client.Schedule
	err       error
}

type scheduleChangedMsg struct {
	dialog   *schedulesDialog
	schedule client.Schedule
	err      error
}

func (a *app) closeSchedules() {
	if a.schedules != nil && a.schedules.cancel != nil {
		a.schedules.cancel()
	}
	a.schedules = nil
}

// openSchedules shows the selected Tag's Schedules.
func (a *app) openSchedules() tea.Cmd {
	a.closeSchedules()
	tag := a.inner.selectedTag()
	if tag == "" {
		return nil
	}
	a.schedules = &schedulesDialog{tag: tag, label: a.inner.tagLabel(tag)}
	return a.loadSchedules()
}

func (a *app) loadSchedules() tea.Cmd {
	d := a.schedules
	if d.cancel != nil {
		d.cancel()
	}
	ctx, cancel := context.WithCancel(a.inner.ctx)
	d.cancel = cancel
	c := a.inner.client
	return a.scope(func() tea.Msg {
		defer cancel()
		schedules, err := c.Schedules(ctx, d.tag)
		return schedulesMsg{dialog: d, schedules: schedules, err: err}
	})
}

// schedulesWatched rereads the list when the Watch reports a change to the Tag's Schedules, or
// may have missed one.
func (a *app) schedulesWatched(msg tea.Msg) tea.Cmd {
	watched, ok := msg.(watchMsg)
	if !ok || a.schedules == nil || a.schedules.busy {
		return nil
	}
	switch watched.update.Kind {
	case client.WatchLive, client.WatchResync:
		return a.loadSchedules()
	case client.WatchChanged:
		change := watched.update.Change
		if change.GetKind() == views.WatchKind_WATCH_KIND_SCHEDULE && change.GetTag() == a.schedules.tag {
			return a.loadSchedules()
		}
	}
	return nil
}

func (a *app) schedulesMessage(msg tea.Msg) bool {
	switch msg := msg.(type) {
	case schedulesMsg:
		if d := a.schedules; d == msg.dialog {
			d.read = true
			if msg.err != nil {
				d.note = terminalText(msg.err.Error())
			} else {
				d.schedules = msg.schedules
				d.cursor = max(min(d.cursor, len(d.schedules)-1), 0)
			}
		}
		return true
	case scheduleChangedMsg:
		if d := a.schedules; d == msg.dialog {
			d.busy = false
			if msg.err != nil {
				d.note = terminalText(msg.err.Error())
				return true
			}
			d.note = ""
			kept := d.schedules[:0]
			for _, schedule := range d.schedules {
				if schedule.ID == msg.schedule.ID {
					schedule = msg.schedule
				}
				if schedule.Pending() {
					kept = append(kept, schedule)
				}
			}
			d.schedules = kept
			d.cursor = max(min(d.cursor, len(d.schedules)-1), 0)
		}
		return true
	}
	return false
}

func (a *app) schedulesKey(msg tea.KeyPressMsg) tea.Cmd {
	d := a.schedules
	switch msg.String() {
	case "ctrl+c":
		a.closeSchedules()
		return tea.Quit
	case "esc":
		a.closeSchedules()
		return nil
	case "up", "k":
		d.cursor = max(d.cursor-1, 0)
		return nil
	case "down", "j":
		d.cursor = max(min(d.cursor+1, len(d.schedules)-1), 0)
		return nil
	}
	if d.busy || len(d.schedules) == 0 {
		return nil
	}
	selected := d.schedules[d.cursor]
	var action client.ScheduleAction
	switch msg.String() {
	case "p":
		action = client.PauseSchedule
		if selected.State == "paused" {
			action = client.ResumeSchedule
		}
	case "x", "delete", "backspace":
		action = client.DeleteSchedule
	default:
		return nil
	}
	if d.cancel != nil {
		d.cancel()
	}
	ctx, cancel := context.WithCancel(a.inner.ctx)
	d.cancel, d.busy, d.note = cancel, true, ""
	c := a.inner.client
	return a.scope(func() tea.Msg {
		defer cancel()
		schedule, err := c.ChangeSchedule(ctx, selected.ID, action)
		return scheduleChangedMsg{dialog: d, schedule: schedule, err: err}
	})
}

// scheduleLine is one Schedule's row: its note, recurrence, next time, and creator.
func scheduleLine(schedule client.Schedule) string {
	note := schedule.Note
	if note == "" {
		note = schedule.ID
	}
	parts := []string{terminalText(note)}
	switch {
	case schedule.Cron != "":
		parts = append(parts, terminalText("every "+schedule.Cron+" ("+schedule.TimeZone+")"))
	case !schedule.At.IsZero():
		parts = append(parts, "once")
	}
	if schedule.State == "paused" {
		parts = append(parts, "paused")
	} else if !schedule.NextDue.IsZero() {
		next := schedule.NextDue.Local()
		parts = append(parts, "next "+next.Format("Mon Jan 2")+" "+clockTime(next))
	}
	return strings.Join(append(parts, "by "+terminalText(schedule.CreatedBy)), "  ·  ")
}

func (a *app) renderSchedules() string {
	d := a.schedules
	height, width := max(a.height-1, 2), max(a.width-2, 10)
	lines := []string{headerStyle.Render(truncate("Schedules · "+terminalText(d.label), width))}
	shown := max(height-5, 1)
	first := max(d.cursor-shown+1, 0)
	for i := first; i < min(first+shown, len(d.schedules)); i++ {
		style := lipgloss.NewStyle()
		if i == d.cursor {
			style = focusedSel
		}
		lines = append(lines, style.Render(truncate(scheduleLine(d.schedules[i]), width)))
	}
	switch {
	case !d.read:
		lines = append(lines, "Reading from the Control Plane…")
	case len(d.schedules) == 0:
		lines = append(lines, "This Tag has no Schedules that will fire.")
	}
	if d.note != "" {
		lines = append(lines, truncate(d.note, width))
	}
	footer := "p pauses or resumes · x deletes · ↑ ↓ Schedules · esc back"
	lines = append(lines, "", faint.Render(truncate(footer, width)))
	return lipgloss.NewStyle().Padding(0, 1).Height(height).MaxHeight(height).Render(strings.Join(lines, "\n"))
}
