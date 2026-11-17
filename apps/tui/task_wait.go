package main

import (
	"charm.land/lipgloss/v2"
)

// The pushed follow of a conversation says why a sent message still waits for a Worker Host,
// once it has waited a moment (client.EventHostWait).

// waitLine says why a sent message has not started, under its delivery status; empty once a
// Worker Host took it up or when nothing is known.
func waitLine(turn *runtimeTurn, width int) string {
	if turn == nil || turn.wait == "" || turn.started || turn.settled || turn.joined {
		return ""
	}
	return faint.Render(lipgloss.NewStyle().Width(width).Render(terminalLines(turn.wait)))
}
