package main

import (
	"context"
	"errors"
	"strings"

	tea "charm.land/bubbletea/v2"
	"connectrpc.com/connect"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
)

// objectiveMessage is the latest follow-up sent from each Objective's pane.
type objectiveMessage struct {
	text, status, tag, reply, waiting string
	sending                           bool
	cancel                            context.CancelFunc
}

type objectiveSentMsg struct {
	id       string
	message  *objectiveMessage
	response *operatorv1.MessageObjectiveResponse
	err      error
}

type objectiveReplyMsg struct {
	id      string
	message *objectiveMessage
	event   client.FollowEvent
	events  <-chan client.FollowEvent
	err     error
}

func (m model) canMessageObjective() bool {
	objective := m.overviews[m.objectiveID].GetObjective()
	if objective == nil {
		objective = m.openObjective(m.objectiveID)
	}
	message := m.objectiveMessages[m.objectiveID]
	return objective != nil && !client.Closed(objective.GetStatus()) && (message == nil || !message.sending)
}

func (m *model) composeObjectiveMessage() tea.Cmd {
	if !m.canMessageObjective() {
		return nil
	}
	m.objectiveCompose, m.focus = true, focusInput
	m.input.Placeholder = "Message the owner · enter sends · esc cancels"
	m.input.SetValue(m.drafts[m.draftKey()])
	return m.syncInput()
}

func (m *model) sendObjectiveMessage(text string) tea.Cmd {
	if !m.canMessageObjective() {
		return nil
	}
	id := m.objectiveID
	if previous := m.objectiveMessages[id]; previous != nil && previous.cancel != nil {
		previous.cancel()
	}
	message := &objectiveMessage{text: text, status: "Sending your follow-up…", sending: true}
	m.objectiveMessages[id] = message
	delete(m.drafts, m.draftKey())
	m.objectiveCompose = false
	m.input.Reset()
	m.syncInput()
	m.viewport.GotoTop()
	m.refresh()
	c, ctx := m.client, m.ctx
	return func() tea.Msg {
		response, err := c.MessageObjective(ctx, id, text)
		return objectiveSentMsg{id: id, message: message, response: response, err: err}
	}
}

func (m *model) objectiveMessageSent(msg objectiveSentMsg) tea.Cmd {
	message := msg.message
	message.sending = false
	if msg.err != nil {
		message.status = "Could not send your follow-up. " + terminalText(msg.err.Error())
		m.drafts[objectivePaneKey(msg.id)] = message.text
		m.refreshObjectiveMessage(msg.id)
		return nil
	}
	message.status = "Follow-up sent."
	message.tag = msg.response.GetTag()
	if previous := msg.response.GetStatusChange(); previous != operatorv1.ObjectiveStatus_OBJECTIVE_STATUS_UNSPECIFIED {
		message.status += " The Objective moved from " + statusWords(previous) + " back to working."
	}
	m.refreshObjectiveMessage(msg.id)
	var overview tea.Cmd
	if m.pane == paneObjective && m.objectiveID == msg.id {
		overview = m.reloadOverview()
	}
	var follow tea.Cmd
	if message.tag != "" && msg.response.GetTaskId() != "" {
		ctx, cancel := context.WithCancel(m.ctx)
		message.cancel = cancel
		c, follower, tag, task := m.client, m.follower, message.tag, msg.response.GetTaskId()
		follow = func() tea.Msg {
			reply, err := c.GetObjectiveMessage(ctx, tag, task)
			if err != nil {
				return objectiveReplyMsg{id: msg.id, message: message, err: err}
			}
			return waitForObjectiveReply(msg.id, message, follower.FollowObjective(ctx, tag, reply))()
		}
	}
	return tea.Batch(overview, m.reloadObjectives(), m.reloadInbox(), follow)
}

func waitForObjectiveReply(id string, message *objectiveMessage, events <-chan client.FollowEvent) tea.Cmd {
	return func() tea.Msg {
		event, ok := <-events
		if !ok {
			return objectiveReplyMsg{id: id, message: message}
		}
		return objectiveReplyMsg{id: id, message: message, event: event, events: events}
	}
}

func (m *model) objectiveReplyRead(msg objectiveReplyMsg) tea.Cmd {
	message := msg.message
	if m.objectiveMessages[msg.id] != message {
		return nil
	}
	done := msg.events == nil
	switch {
	case msg.err != nil:
		var rpcErr *client.APIError
		if !m.client.RuntimeV2() && errors.As(msg.err, &rpcErr) && (rpcErr.Code == connect.CodeNotFound || rpcErr.Code == connect.CodePermissionDenied) {
			message.status += "\nThe reply posts to the thread the Objective was created in."
		} else {
			message.status += " Could not follow the reply. " + terminalText(msg.err.Error())
		}
	case msg.events != nil:
		switch msg.event.Kind {
		case client.EventWaiting:
			message.waiting = terminalText(msg.event.Text)
		case client.EventJoined:
			message.waiting = "The message joined the owner's turn in progress."
		case client.EventDelta:
			message.waiting = ""
			message.reply += terminalLines(msg.event.Text)
		case client.EventReply:
			message.waiting = ""
			message.reply = terminalLines(msg.event.Reply.GetText())
			done = true
		case client.EventTurnError, client.EventError:
			message.waiting = ""
			message.status += " Could not show the reply. " + terminalText(msg.event.Text)
			done = true
		default:
			return waitForObjectiveReply(msg.id, message, msg.events)
		}
	}
	m.refreshObjectiveMessage(msg.id)
	if done {
		message.cancel()
		message.cancel = nil
		return nil
	}
	return waitForObjectiveReply(msg.id, message, msg.events)
}

func (m *model) refreshObjectiveMessage(id string) {
	if m.pane == paneObjective && m.objectiveID == id {
		m.refresh()
	}
}

func (m model) objectiveMessageText() string {
	message := m.objectiveMessages[m.objectiveID]
	if message == nil {
		return ""
	}
	lines := []string{"Your follow-up", terminalLines(message.text), message.status}
	if message.waiting != "" {
		lines = append(lines, "Waiting. "+message.waiting)
	}
	if message.reply != "" {
		lines = append(lines, "", terminalText(message.tag)+" replied", message.reply)
	}
	return strings.Join(lines, "\n")
}

func objectivePaneKey(id string) string { return "objective:" + id }
