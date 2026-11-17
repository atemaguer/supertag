package main

import (
	"slices"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
)

// outgoing is a message sent here that the Gateway has not accepted yet. It shows in its
// conversation at once and stays, also on disk, until the Gateway accepts it. Every attempt,
// including one after a restart, sends it with its operation ID, so the Tag gets it at most once.
type outgoing struct {
	Tag         string `json:"tag"`
	Text        string `json:"text"`
	OperationID string `json:"operationId"`
	CreatedAtMs int64  `json:"createdAtMs"`
	// Error is why the last attempt failed.
	Error string `json:"error,omitempty"`
	// sending says an attempt is in flight.
	sending bool
}

// outbox holds the messages not yet accepted, oldest first. A model's copies share it.
type outbox struct {
	entries []*outgoing
	// resumed says the messages a previous run left were sent again.
	resumed bool
}

func (o *outbox) find(operationID string) *outgoing {
	for _, entry := range o.entries {
		if entry.OperationID == operationID {
			return entry
		}
	}
	return nil
}

func (o *outbox) remove(operationID string) {
	o.entries = slices.DeleteFunc(o.entries, func(entry *outgoing) bool { return entry.OperationID == operationID })
}

// of is the Tag's queued messages, oldest first.
func (o *outbox) of(tag string) []*outgoing {
	var queued []*outgoing
	for _, entry := range o.entries {
		if entry.Tag == tag {
			queued = append(queued, entry)
		}
	}
	return queued
}

// queue adds a message to the outbox and sends it.
func (m *model) queue(tag, text string) tea.Cmd {
	id, err := client.NewOperationID()
	if err != nil {
		m.addEntry(tag, entryError, "Could not send the message: "+err.Error())
		return nil
	}
	entry := &outgoing{Tag: tag, Text: text, OperationID: id, CreatedAtMs: m.now().UnixMilli()}
	m.outbox.entries = append(m.outbox.entries, entry)
	m.cacheChanged(outboxKey)
	return m.deliver(entry)
}

// deliver sends a queued message with its operation ID; nil while an attempt is in flight.
func (m *model) deliver(entry *outgoing) tea.Cmd {
	if entry == nil || entry.sending {
		return nil
	}
	entry.sending, entry.Error = true, ""
	if m.showsConversation(entry.Tag) {
		m.refresh()
	}
	c, ctx := m.client, m.ctx
	tag, text, id := entry.Tag, entry.Text, entry.OperationID
	return func() tea.Msg {
		message, err := c.SendMessage(ctx, tag, text, id)
		return sentMsg{tag: tag, operationID: id, message: message, err: err}
	}
}

// resumeOutbox sends again the messages a previous run left unsent, once per model.
func (m *model) resumeOutbox() tea.Cmd {
	if m.outbox.resumed {
		return nil
	}
	m.outbox.resumed = true
	var cmds []tea.Cmd
	for _, entry := range m.outbox.entries {
		cmds = append(cmds, m.deliver(entry))
	}
	return tea.Batch(cmds...)
}

// retryOutbox sends again the shown conversation's messages that were not delivered.
func (m *model) retryOutbox() tea.Cmd {
	var cmds []tea.Cmd
	for _, entry := range m.outbox.of(m.selectedTag()) {
		if entry.Error != "" {
			cmds = append(cmds, m.deliver(entry))
		}
	}
	return tea.Batch(cmds...)
}

// editUndelivered takes the shown conversation's latest message that was not delivered back into
// the input, and out of the outbox; false when there is none or the input holds text.
func (m *model) editUndelivered() bool {
	if m.input.Value() != "" {
		return false
	}
	queued := m.outbox.of(m.selectedTag())
	for i := len(queued) - 1; i >= 0; i-- {
		if entry := queued[i]; entry.Error != "" && !entry.sending {
			m.outbox.remove(entry.OperationID)
			m.cacheChanged(outboxKey)
			m.input.SetValue(entry.Text)
			m.input.CursorEnd()
			m.refresh()
			return true
		}
	}
	return false
}

// undelivered says the shown conversation has a message that was not delivered.
func (m model) undelivered() bool {
	for _, entry := range m.outbox.of(m.selectedTag()) {
		if entry.Error != "" && !entry.sending {
			return true
		}
	}
	return false
}

// now is the time the conversation shows; tests fix it.
func (m model) now() time.Time {
	if m.clock != nil {
		return m.clock()
	}
	return time.Now()
}
