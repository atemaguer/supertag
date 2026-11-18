package main

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/apps/tui/views"
)

// createdObjectivePrefix starts the reply the Gateway gives a message that created an Objective.
const createdObjectivePrefix = "Created Objective "

// createdObjectiveID is the Objective a reply says the message created, or "".
func createdObjectiveID(reply string) string {
	rest, ok := strings.CutPrefix(reply, createdObjectivePrefix)
	if !ok {
		return ""
	}
	id, _, ok := strings.Cut(rest, ":")
	if !ok || id == "" || strings.ContainsAny(id, " \n") {
		return ""
	}
	return id
}

// objectiveHomeLine says, under the reply that created an Objective, where it stands once it waits
// on the operator or has ended: from the Objective's own state, so it changes as the Objective does.
func (m model) objectiveHomeLine(id string) string {
	objective := m.openObjective(id)
	if objective == nil {
		objective = m.closedObjectives[id]
	}
	summary := terminalText(firstLine(objective.GetCompletionSummary()))
	with := func(text string) string {
		if summary == "" {
			return text
		}
		return text + ": " + summary
	}
	switch objective.GetStatus() {
	case views.ObjectiveStatus_OBJECTIVE_STATUS_READY_FOR_REVIEW:
		return "· " + with(fmt.Sprintf("Objective %s is ready for your review", id)) + " · open it under Objectives to approve or request changes"
	case views.ObjectiveStatus_OBJECTIVE_STATUS_COMPLETED:
		return "· " + with(fmt.Sprintf("Objective %s is complete", id))
	case views.ObjectiveStatus_OBJECTIVE_STATUS_CANCELLED:
		return fmt.Sprintf("· Objective %s was cancelled.", id)
	}
	return ""
}

// closedObjectiveMsg is one Objective a conversation created, read after it left the open list.
type closedObjectiveMsg struct {
	objective *views.Objective
	err       error
}

// readClosedObjectives reads, once each, the Objectives the loaded conversations created that are
// no longer open, so their home conversation says how they ended.
func (m model) readClosedObjectives() tea.Cmd {
	open := map[string]bool{}
	for _, objective := range m.objectives {
		open[objective.GetId()] = true
	}
	var cmds []tea.Cmd
	for _, c := range m.conversations {
		if c == nil {
			continue
		}
		for _, turn := range c.runtime.turns {
			for _, e := range turn.entries {
				id := ""
				if e.kind == entryReply {
					id = createdObjectiveID(e.text)
				}
				known := m.closedObjectives[id]
				if id == "" || open[id] || (known != nil && client.Closed(known.GetStatus())) || len(cmds) >= 16 {
					continue
				}
				c, ctx := m.client, m.ctx
				cmds = append(cmds, func() tea.Msg {
					objective, err := c.GetObjective(ctx, id)
					return closedObjectiveMsg{objective: objective, err: err}
				})
			}
		}
	}
	return tea.Batch(cmds...)
}
