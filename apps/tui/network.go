package main

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/apps/tui/views"
)

// networkDialog shows the selected Tag's network log: the web requests its Task Attempts made
// through their Worker Host's egress proxy, allowed or refused, newest Task Attempt first. It is
// read-only, and only operators may read it. The conversation itself stays messages only.
type networkDialog struct {
	tag, label string
	logs       []client.NetworkLog
	offset     int
	read       bool
	note       string
	cancel     context.CancelFunc
}

type networkMsg struct {
	dialog *networkDialog
	logs   []client.NetworkLog
	err    error
}

func (a *app) closeNetwork() {
	if a.network != nil && a.network.cancel != nil {
		a.network.cancel()
	}
	a.network = nil
}

// openNetwork shows the selected Tag's network log.
func (a *app) openNetwork() tea.Cmd {
	a.closeNetwork()
	tag := a.inner.selectedTag()
	if tag == "" {
		return nil
	}
	a.network = &networkDialog{tag: tag, label: a.inner.tagLabel(tag)}
	return a.loadNetwork()
}

func (a *app) loadNetwork() tea.Cmd {
	d := a.network
	if d.cancel != nil {
		d.cancel()
	}
	ctx, cancel := context.WithCancel(a.inner.ctx)
	d.cancel = cancel
	c := a.inner.client
	return a.scope(func() tea.Msg {
		defer cancel()
		logs, err := c.NetworkLogs(ctx, d.tag)
		return networkMsg{dialog: d, logs: logs, err: err}
	})
}

// networkWatched rereads the log when the Watch reports a change to one of the Tag's Tasks, such
// as a Task Attempt ending, or may have missed one.
func (a *app) networkWatched(msg tea.Msg) tea.Cmd {
	watched, ok := msg.(watchMsg)
	if !ok || a.network == nil {
		return nil
	}
	switch watched.update.Kind {
	case client.WatchLive, client.WatchResync:
		return a.loadNetwork()
	case client.WatchChanged:
		change := watched.update.Change
		if change.GetKind() == views.WatchKind_WATCH_KIND_TASK && change.GetTag() == a.network.tag {
			return a.loadNetwork()
		}
	}
	return nil
}

func (a *app) networkMessage(msg tea.Msg) bool {
	loaded, ok := msg.(networkMsg)
	if !ok {
		return false
	}
	if d := a.network; d == loaded.dialog {
		d.read = true
		if loaded.err != nil {
			d.note = terminalText(loaded.err.Error())
			// The Gateway refuses a client the log as permission denied, in its own words.
			var refused *client.APIError
			if errors.As(loaded.err, &refused) && refused.Code == connect.CodePermissionDenied {
				d.note = "Only operators can see the network log."
			}
		} else {
			d.logs, d.note = loaded.logs, ""
		}
	}
	return true
}

func (a *app) networkKey(msg tea.KeyPressMsg) tea.Cmd {
	d := a.network
	switch msg.String() {
	case "ctrl+c":
		a.closeNetwork()
		return tea.Quit
	case "esc":
		a.closeNetwork()
	case "up", "k":
		d.offset = max(d.offset-1, 0)
	case "down", "j":
		d.offset++
	}
	return nil
}

// networkRequestLine is one request, as the desktop app's Tag details word it:
// `GET https://api.github.com/repos/acme → 200 · with github`.
func networkRequestLine(request client.NetworkRequest) string {
	target := request.Method + " " + request.Origin + request.Path
	if !request.Allowed {
		reason := request.Reason
		if reason == "" {
			reason = "outside the scope"
		}
		return target + " refused: " + reason
	}
	status := "no answer"
	if request.Status != 0 {
		status = fmt.Sprint(request.Status)
	}
	line := target + " → " + status
	if request.Credential != "" {
		line += " · with " + request.Credential
	}
	return line
}

// networkTotals is a Task Attempt's totals: `3 allowed · 1 refused`.
func networkTotals(log client.NetworkLog) string {
	totals := fmt.Sprintf("%d allowed · %d refused", log.Allowed, log.Denied)
	if log.Unrecorded > 0 {
		totals += fmt.Sprintf(" · %d more not listed", log.Unrecorded)
	}
	return totals
}

func (a *app) renderNetwork() string {
	d := a.network
	height, width := max(a.height-1, 2), max(a.width-2, 10)
	lines := []string{headerStyle.Render(truncate("Network · "+terminalText(d.label), width)),
		faint.Render(truncate("Web requests "+terminalText(d.label)+"'s Tasks made through the Worker Host, allowed or refused.", width))}
	var body []string
	for _, log := range d.logs {
		short := log.Task
		if len(short) > 8 {
			short = short[:8]
		}
		body = append(body, focusedSel.Render(truncate("Task "+terminalText(short)+" · "+networkTotals(log), width)))
		for _, request := range log.Requests {
			line := truncate("  "+terminalText(networkRequestLine(request)), width)
			if !request.Allowed {
				line = faint.Render(line)
			}
			body = append(body, line)
		}
	}
	shown := max(height-6, 1)
	d.offset = max(min(d.offset, len(body)-shown), 0)
	lines = append(lines, body[d.offset:min(d.offset+shown, len(body))]...)
	switch {
	case !d.read:
		lines = append(lines, "Reading from the Gateway…")
	case len(d.logs) == 0 && d.note == "":
		lines = append(lines, "No network log yet. "+terminalText(d.label)+"'s Tasks get one when its Permission Sets limit web:fetch to hosts.")
	}
	if d.note != "" {
		lines = append(lines, errorStyle.Render(truncate(d.note, width)))
	}
	lines = append(lines, "", faint.Render(truncate("↑ ↓ scroll · esc back", width)))
	return lipgloss.NewStyle().Padding(0, 1).Height(height).MaxHeight(height).Render(strings.Join(lines, "\n"))
}
