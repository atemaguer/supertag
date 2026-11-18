package main

import (
	"context"
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/apps/tui/views"
)

// objectiveMessage is the latest follow-up sent from each Objective's pane.
type objectiveMessage struct {
	text, status, tag, task, reply, waiting string
	sending                                 bool
	cancel                                  context.CancelFunc
	work                                    []string
	workShown                               map[string]bool
}

type objectiveSentMsg struct {
	id       string
	message  *objectiveMessage
	response *views.MessageObjectiveResponse
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
	message.task = msg.response.GetTaskId()
	if previous := msg.response.GetStatusChange(); previous != views.ObjectiveStatus_OBJECTIVE_STATUS_UNSPECIFIED {
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
		message.status += " Could not follow the reply. " + terminalText(msg.err.Error())
	case msg.events != nil:
		switch msg.event.Kind {
		case client.EventWaiting:
			message.waiting = terminalText(msg.event.Text)
		case client.EventJoined:
			message.waiting = "The message joined the owner's turn in progress."
		case client.EventDelta:
			// The text the owner is writing replaces what was shown of it; empty clears it.
			if msg.event.Text != "" {
				message.waiting = ""
				message.reply = terminalLines(msg.event.Text)
			}
		case client.EventMessage:
			// The owner's latest message shows until its final reply replaces it.
			message.waiting = ""
			message.reply = terminalLines(msg.event.Text)
		case client.EventStatus:
			message.waiting = terminalText(msg.event.Text)
		case client.EventReply:
			message.waiting = ""
			message.reply = terminalLines(msg.event.Reply.GetText())
		case client.EventTurnError:
			message.waiting = ""
			message.status += " Could not show the reply. " + terminalText(msg.event.Text)
		case client.EventError:
			message.waiting = ""
			message.status += " Could not follow the reply. " + terminalText(msg.event.Text)
			done = true
		case client.EventWorking, client.EventReport:
			if message.workShown == nil {
				message.workShown = map[string]bool{}
			}
			key := client.WorkEventKey(msg.event)
			if key == "" || !message.workShown[key] {
				message.workShown[key] = true
				if msg.event.Kind == client.EventWorking {
					message.work = append(message.work, "Working: "+terminalText(msg.event.Title))
				} else {
					message.work = append(message.work, terminalText(msg.event.Title)+" ("+terminalText(msg.event.Status)+")\n"+terminalLines(msg.event.Text))
				}
			}
		case client.EventStillWorking:
			message.waiting = terminalText(msg.event.Text)
		default:
			return waitForObjectiveReply(msg.id, message, msg.events)
		}
	}
	m.refreshObjectiveMessage(msg.id)
	if done {
		if message.cancel != nil {
			message.cancel()
		}
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
	if len(message.work) != 0 {
		lines = append(lines, "", "Work Sessions")
		lines = append(lines, message.work...)
	}
	return strings.Join(lines, "\n")
}

func objectivePaneKey(id string) string { return "objective:" + id }

// objectiveReviewable says whether the shown Objective waits for the operator's review.
func (m model) objectiveReviewable() bool {
	objective := m.overviews[m.objectiveID].GetObjective()
	if objective == nil {
		objective = m.openObjective(m.objectiveID)
	}
	return objective.GetStatus() == views.ObjectiveStatus_OBJECTIVE_STATUS_READY_FOR_REVIEW && !m.reviewing
}

// composeObjectiveChanges opens the input for the feedback a request for changes sends.
func (m *model) composeObjectiveChanges() tea.Cmd {
	m.objectiveReview = "changes"
	m.objectiveCompose, m.focus = true, focusInput
	m.input.Placeholder = "What should the owner change? · enter sends · esc cancels"
	m.input.Reset()
	m.refresh()
	return m.syncInput()
}

type objectiveReviewedMsg struct {
	id        string
	approved  bool
	objective *views.Objective
	err       error
}

// reviewObjective approves the shown Objective, or requests changes with feedback.
func (m *model) reviewObjective(approved bool, feedback string) tea.Cmd {
	id := m.objectiveID
	m.reviewing, m.objectiveReview, m.objectiveCompose = true, "", false
	m.input.Reset()
	m.notice = note{text: "Sending your review…"}
	m.refresh()
	c, ctx := m.client, m.ctx
	return tea.Batch(m.syncInput(), func() tea.Msg {
		objective, err := c.ReviewObjective(ctx, id, approved, feedback)
		return objectiveReviewedMsg{id: id, approved: approved, objective: objective, err: err}
	})
}

// objectiveReviewed says how the review went and rereads the Objective.
func (m *model) objectiveReviewed(msg objectiveReviewedMsg) tea.Cmd {
	m.reviewing = false
	if msg.err != nil {
		m.notice = note{text: "Could not send your review. " + terminalText(msg.err.Error()), err: true}
		m.refresh()
		return nil
	}
	if msg.approved {
		m.notice = note{text: "Approved. The Objective is complete."}
	} else {
		m.notice = note{text: "Changes requested. The owner works from your feedback."}
	}
	m.refresh()
	var overview tea.Cmd
	if m.pane == paneObjective && m.objectiveID == msg.id {
		overview = m.reloadOverview()
	}
	return tea.Batch(overview, m.reloadObjectives())
}

// reviewsWaiting counts the open Objectives ready for the operator's review.
func (m model) reviewsWaiting() int {
	count := 0
	for _, objective := range m.objectives {
		if objective.GetStatus() == views.ObjectiveStatus_OBJECTIVE_STATUS_READY_FOR_REVIEW {
			count++
		}
	}
	return count
}
