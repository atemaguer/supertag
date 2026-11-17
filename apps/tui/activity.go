package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/apps/tui/views"
)

// activityDialog shows how the selected Tag's unprompted messages landed lately, and its start
// rate, as the desktop app's Tag details do under Activity. It is read-only.
type activityDialog struct {
	tag, label string
	activity   client.TagActivity
	read       bool
	note       string
	cancel     context.CancelFunc
}

type activityMsg struct {
	dialog   *activityDialog
	activity client.TagActivity
	err      error
}

func (a *app) closeActivity() {
	if a.activity != nil && a.activity.cancel != nil {
		a.activity.cancel()
	}
	a.activity = nil
}

// openActivity shows the selected Tag's activity.
func (a *app) openActivity() tea.Cmd {
	a.closeActivity()
	tag := a.inner.selectedTag()
	if tag == "" {
		return nil
	}
	a.activity = &activityDialog{tag: tag, label: a.inner.tagLabel(tag)}
	return a.loadActivity()
}

func (a *app) loadActivity() tea.Cmd {
	d := a.activity
	if d.cancel != nil {
		d.cancel()
	}
	ctx, cancel := context.WithCancel(a.inner.ctx)
	d.cancel = cancel
	c := a.inner.client
	return a.scope(func() tea.Msg {
		defer cancel()
		activity, err := c.TagActivity(ctx, d.tag)
		return activityMsg{dialog: d, activity: activity, err: err}
	})
}

// activityWatched rereads the activity when one of the Tag's Tasks changes, such as a turn ending,
// or the Watch may have missed one.
func (a *app) activityWatched(msg tea.Msg) tea.Cmd {
	watched, ok := msg.(watchMsg)
	if !ok || a.activity == nil {
		return nil
	}
	switch watched.update.Kind {
	case client.WatchLive, client.WatchResync:
		return a.loadActivity()
	case client.WatchChanged:
		change := watched.update.Change
		if change.GetKind() == views.WatchKind_WATCH_KIND_TASK && change.GetTag() == a.activity.tag {
			return a.loadActivity()
		}
	}
	return nil
}

func (a *app) activityMessage(msg tea.Msg) bool {
	loaded, ok := msg.(activityMsg)
	if !ok {
		return false
	}
	if d := a.activity; d == loaded.dialog {
		d.read = true
		if loaded.err != nil {
			d.note = terminalText(loaded.err.Error())
		} else {
			d.activity, d.note = loaded.activity, ""
		}
	}
	return true
}

func (a *app) activityKey(msg tea.KeyPressMsg) tea.Cmd {
	switch msg.String() {
	case "ctrl+c":
		a.closeActivity()
		return tea.Quit
	case "esc":
		a.closeActivity()
	}
	return nil
}

// periodWords is a period in words, as the desktop app says it: `hour`, `2 hours`, `day`.
func periodWords(period time.Duration) string {
	for _, unit := range []struct {
		size time.Duration
		name string
	}{{24 * time.Hour, "day"}, {time.Hour, "hour"}, {time.Minute, "minute"}} {
		if period >= unit.size && period%unit.size == 0 {
			if count := period / unit.size; count != 1 {
				return fmt.Sprintf("%d %ss", count, unit.name)
			}
			return unit.name
		}
	}
	return fmt.Sprintf("%d seconds", int(period.Seconds()))
}

// attentionLine is the unprompted messages in one line: `6 posted · 4 read · 2 answered · 19
// stayed quiet`.
func attentionLine(activity client.TagActivity) string {
	return fmt.Sprintf("%d posted · %d read · %d answered · %d stayed quiet",
		activity.Posted, activity.Read, activity.Answered, activity.Quiet)
}

// startRateLine is the start rate in one line: `At most 10 per hour · 3 started in the last hour`.
func startRateLine(rate client.StartRate) string {
	period := periodWords(rate.Per)
	return fmt.Sprintf("At most %d per %s · %d started in the last %s", rate.Starts, period, rate.InWindow, period)
}

func (a *app) renderActivity() string {
	d := a.activity
	height, width := max(a.height-1, 2), max(a.width-2, 10)
	label := terminalText(d.label)
	lines := []string{headerStyle.Render(truncate("Activity · "+label, width))}
	switch {
	case d.note != "":
		lines = append(lines, errorStyle.Render(truncate(d.note, width)))
	case !d.read:
		lines = append(lines, "Reading from the Gateway…")
	default:
		days := d.activity.WindowDays
		if days == 0 {
			days = 30
		}
		unprompted := label + " sent nothing unprompted."
		if d.activity.Posted > 0 || d.activity.Quiet > 0 {
			unprompted = attentionLine(d.activity)
		}
		rate := "None"
		if d.activity.StartRate != nil {
			rate = startRateLine(*d.activity.StartRate)
		}
		lines = append(lines, "",
			faint.Render(truncate(fmt.Sprintf("Unprompted, last %d days", days), width)),
			truncate(unprompted, width),
			faint.Render(truncate("Start rate", width)),
			truncate(rate, width))
	}
	lines = append(lines, "", faint.Render(truncate("esc back", width)))
	return lipgloss.NewStyle().Padding(0, 1).Height(height).MaxHeight(height).Render(strings.Join(lines, "\n"))
}
