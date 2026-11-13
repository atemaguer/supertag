package main

import (
	"context"
	"errors"
	"slices"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
)

// A runtime turn keeps its own output so a refresh or a second follow can add
// a message without interleaving the first turn's reply with it.
type runtimeTurn struct {
	transcript
	following   bool
	settled     bool
	joined      bool
	needsFollow bool
}

type runtimeHistory struct {
	turns    map[string]*runtimeTurn
	order    []string
	revision uint64
	sending  int
	readErr  string
	// head is the newest Task from an authoritative page, independent of
	// messages added by individual local send receipts.
	head, sessionID string
	read            bool
	workShown       map[string]bool
}

func (m model) reloadShownHistory() tea.Cmd {
	if !m.client.RuntimeV2() || m.pane != paneConversation {
		return nil
	}
	if tag := m.selectedTag(); tag != "" {
		return m.reloadHistory(tag, m.currentConversation(tag))
	}
	return nil
}

func (m model) retryRuntimeHistory() tea.Cmd {
	if m.pane == paneConversation {
		if c := m.shown(); c != nil && c.runtime.readErr != "" {
			return m.reloadShownHistory()
		}
	}
	return nil
}

func (m model) reloadHistory(tag, name string) tea.Cmd {
	if !m.conversation(tag, name).historyReload.start() {
		return nil
	}
	return m.loadHistory(tag, name)
}

func (m model) loadRuntimeHistory(tag, name string) tea.Cmd {
	h := &m.conversation(tag, name).runtime
	revision, head, session, read := h.revision, h.head, h.sessionID, h.read
	displayed := slices.Clone(h.order)
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 15*time.Second)
		defer cancel()
		msg := historyMsg{tag: tag, conversation: name, revision: revision}
		var messages []*operatorv1.Message
		cursor, pageSession := "", ""
		seen := map[string]bool{}
		for {
			page, next, err := m.client.ListMessages(ctx, tag, name, historyPage, cursor)
			if err != nil {
				msg.err = err
				return msg
			}
			if len(page) != 0 && pageSession == "" {
				pageSession = page[0].GetSessionId()
			}
			if slices.ContainsFunc(page, func(item *operatorv1.Message) bool {
				return item.GetSessionId() != pageSession
			}) {
				msg.err = errors.New("Control Plane conversation changed while loading history")
				return msg
			}
			messages = append(messages, page...)
			replaced := pageSession != "" && session != "" && pageSession != session
			if replaced {
				// A new Session at the same address starts with its own history.
				displayed = nil
			}
			if !read || next == "" || replaced || slices.ContainsFunc(page, func(item *operatorv1.Message) bool {
				return item.GetTaskId() == head
			}) {
				msg.items = client.History(tag, messages, displayed...)
				return msg
			}
			if seen[next] {
				msg.err = errors.New("Control Plane conversation cursor did not advance")
				return msg
			}
			seen[next] = true
			cursor = next
		}
	}
}

func (m *model) showRuntimeHistory(msg historyMsg) tea.Cmd {
	c := m.conversation(msg.tag, msg.conversation)
	var cmds []tea.Cmd
	again := c.historyReload.done()
	// A local send can commit after this read began. Its receipt schedules a
	// newer read so the older snapshot cannot put it in the wrong position.
	if msg.revision != c.runtime.revision {
		if again {
			return m.loadHistory(msg.tag, msg.conversation)
		}
		return nil
	}
	c.loaded = true
	if msg.err != nil {
		c.runtime.readErr = terminalText(msg.err.Error())
	} else {
		c.runtime.readErr = ""
		c.runtime.read = true
		if len(msg.items) == 0 {
			c.runtime.order, c.runtime.turns, c.runtime.head, c.runtime.sessionID = nil, nil, "", ""
			c.runtime.workShown = nil
		} else {
			task := msg.items[len(msg.items)-1].Message
			if c.runtime.sessionID != "" && c.runtime.sessionID != task.GetSessionId() {
				c.runtime.order, c.runtime.turns = nil, nil
				c.runtime.workShown = nil
			}
			c.runtime.head, c.runtime.sessionID = task.GetTaskId(), task.GetSessionId()
		}
		for _, item := range msg.items {
			cmds = append(cmds, m.runtimeItem(msg.tag, msg.conversation, item))
		}
		c.runtime.mergeOrder(msg.items)
	}
	if m.showsConversation(msg.tag, msg.conversation) {
		m.refresh()
	}
	if again {
		cmds = append(cmds, m.loadHistory(msg.tag, msg.conversation))
	}
	return tea.Batch(cmds...)
}

// mergeOrder uses the Control Plane's order within the latest page and retains
// messages already displayed after they fall off that page.
func (h *runtimeHistory) mergeOrder(items []client.HistoryItem) {
	page := make([]string, 0, len(items))
	onPage := make(map[string]bool, len(items))
	for _, item := range items {
		id := item.Message.GetTaskId()
		if id != "" && !onPage[id] {
			page = append(page, id)
			onPage[id] = true
		}
	}
	for i, id := range h.order {
		if onPage[id] {
			order := append(append(make([]string, 0, len(h.order)), h.order[:i]...), page...)
			for _, old := range h.order[i:] {
				if !onPage[old] {
					order = append(order, old)
				}
			}
			h.order = order
			return
		}
	}
}

func (m *model) runtimeSent(msg sentMsg) tea.Cmd {
	c := m.conversation(msg.tag, msg.conversation)
	c.runtime.sending = max(c.runtime.sending-1, 0)
	if msg.err != nil {
		m.fail(msg.err)
		m.addEntry(msg.tag, msg.conversation, entryError, msg.err.Error())
		return nil
	}
	m.connected, m.status = true, "connected"
	id := msg.message.GetTaskId()
	var cmds []tea.Cmd
	if c.runtime.turns[id] == nil {
		c.runtime.revision++
		var source []string
		if joined := msg.message.GetJoinedTaskId(); c.runtime.turns[joined] != nil {
			source = append(source, joined)
		}
		for _, item := range client.History(msg.tag, []*operatorv1.Message{msg.message}, source...) {
			cmds = append(cmds, m.runtimeItem(msg.tag, msg.conversation, item))
		}
		if m.showsConversation(msg.tag, msg.conversation) {
			cmds = append(cmds, m.reloadHistory(msg.tag, msg.conversation))
		}
	}
	if m.showsConversation(msg.tag, msg.conversation) {
		m.refresh()
	}
	return tea.Batch(cmds...)
}

func (m *model) runtimeItem(tag, name string, item client.HistoryItem) tea.Cmd {
	id := item.Message.GetTaskId()
	if id == "" {
		return nil
	}
	h := &m.conversation(tag, name).runtime
	if h.turns == nil {
		h.turns = make(map[string]*runtimeTurn)
	}
	turn := h.turns[id]
	joined := item.Message.GetJoinedTaskId() != ""
	var cmds []tea.Cmd
	if turn != nil && (turn.following || !turn.joined || joined) {
		turn.joined = turn.joined || joined
		turn.needsFollow = item.Follow
		// The follower already displays this turn's events. A snapshot can
		// supply a final reply after a failed follow without repeating it.
		if !turn.following {
			for _, event := range item.Events {
				if runtimeFinal(event) || client.WorkEventKey(event) != "" {
					cmds = append(cmds, m.applyRuntimeTurn(h, turn, event))
				}
			}
			if item.Follow {
				turn.following = true
				cmds = append(cmds, waitForTask(tag, name, id, m.follower.Follow(m.ctx, tag, item.Message, item.Shown)))
			}
		}
		return tea.Batch(cmds...)
	}
	if turn == nil {
		h.order = append(h.order, id)
	}
	// A joined input can be withdrawn and run as its own Task. Replace any
	// transcript attributed to the earlier source when that delivery clears.
	turn = &runtimeTurn{joined: joined, needsFollow: item.Follow}
	h.turns[id] = turn
	if item.Message.GetText() != "" {
		turn.add(entryYou, item.Message.GetText())
	}
	for _, event := range item.Events {
		cmds = append(cmds, m.applyRuntimeTurn(h, turn, event))
	}
	if item.Follow {
		turn.following = true
		cmds = append(cmds, waitForTask(tag, name, id, m.follower.Follow(m.ctx, tag, item.Message, item.Shown)))
	}
	return tea.Batch(cmds...)
}

func (m *model) runtimeFollow(msg followMsg) tea.Cmd {
	h := &m.conversation(msg.tag, msg.conversation).runtime
	turn := h.turns[msg.taskID]
	if turn == nil {
		return nil
	}
	cmd := m.applyRuntimeTurn(h, turn, msg.event)
	if m.showsConversation(msg.tag, msg.conversation) {
		m.refresh()
	}
	return cmd
}

func (m *model) runtimeFollowDone(msg followDoneMsg) tea.Cmd {
	if turn := m.conversation(msg.tag, msg.conversation).runtime.turns[msg.taskID]; turn != nil {
		turn.following = false
		if (!turn.settled || turn.joined || turn.needsFollow) && m.showsConversation(msg.tag, msg.conversation) {
			return m.reloadHistory(msg.tag, msg.conversation)
		}
	}
	return nil
}

func runtimeFinal(event client.FollowEvent) bool {
	return event.Kind == client.EventReply || event.Kind == client.EventTurnError
}

func (m *model) applyRuntimeTurn(history *runtimeHistory, turn *runtimeTurn, event client.FollowEvent) tea.Cmd {
	if key := client.WorkEventKey(event); key != "" {
		if history.workShown == nil {
			history.workShown = map[string]bool{}
		}
		if history.workShown[key] {
			return nil
		}
		history.workShown[key] = true
	}
	if event.Kind == client.EventJoined {
		turn.joined = true
	}
	if runtimeFinal(event) {
		if turn.settled {
			return nil
		}
		turn.settled = true
	}
	return m.applyTranscript(&turn.transcript, event)
}

func (m model) renderRuntimeHistory(c *conversation, name string, width int) string {
	var out strings.Builder
	wrap := lipgloss.NewStyle().Width(width)
	render := func(t *transcript) {
		if t.cacheWidth != width {
			t.cache, t.cacheWidth = nil, width
		}
		for i, entry := range t.entries {
			if i >= len(t.cache) {
				t.cache = append(t.cache, m.renderEntry(entry, name, width))
			}
			out.WriteString(t.cache[i])
		}
		if t.draft != "" {
			out.WriteString(headerStyle.Render(name) + "\n" + faint.Render(wrap.Render(t.draft)) + "\n\n")
		}
	}
	for _, id := range c.runtime.order {
		render(&c.runtime.turns[id].transcript)
	}
	render(&c.transcript)
	if c.runtime.sending > 0 {
		out.WriteString(faint.Render("Sending message…") + "\n")
	}
	if c.runtime.readErr != "" {
		out.WriteString(errorStyle.Render(wrap.Render("Could not load the conversation history: "+c.runtime.readErr)) + "\n")
	}
	return strings.TrimRight(out.String(), "\n")
}
