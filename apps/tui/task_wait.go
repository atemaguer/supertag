package main

import (
	"charm.land/lipgloss/v2"
)

// The pushed follow of a conversation says why a sent message still waits for a Worker Host,
// once it has waited a moment (client.EventHostWait).

// waitLine says why a sent message waits, under its delivery status: for a Worker Host to take it
// up, or for the Worker Host holding its Session's last delivery; empty once the reason no longer
// holds, the turn settled, or nothing is known.
func waitLine(turn *runtimeTurn, width int) string {
	if turn == nil || turn.wait == "" || turn.settled || turn.joined {
		return ""
	}
	return faint.Render(lipgloss.NewStyle().Width(width).Render(terminalLines(turn.wait)))
}
