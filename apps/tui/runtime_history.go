package main

import (
	"cmp"
	"context"
	"math"
	"slices"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/apps/tui/views"
)

// A runtime turn keeps its own output so a refresh or a second follow can add
// a message without interleaving the first turn's reply with it.
type runtimeTurn struct {
	transcript
	following   bool
	settled     bool
	joined      bool
	needsFollow bool
	// started says a Worker Host took the turn up.
	started bool
	// wait is why the turn has not started, such as an uncertain Task Attempt that keeps a
	// Worker Host's only slot; empty when not known.
	wait string
	// after is the sequence of the latest message the Tag wrote that the turn shows.
	after uint64
	// order is the message's place in the conversation; zero when not yet known.
	order uint64
	// sentAt and completedAt are when the message was sent and its turn finished; zero when not
	// known.
	sentAt, completedAt time.Time
	// stop ends the turn's follow.
	stop context.CancelFunc
}

type runtimeHistory struct {
	turns    map[string]*runtimeTurn
	order    []string
	revision uint64
	readErr  string
	// conversationID is the conversation the turns came from.
	conversationID string
	read           bool
	workShown      map[string]bool
	// markedRead is the order up to which the conversation was last marked read.
	markedRead uint64
}

// latestOrder is the order of the latest message held, zero when none is known.
func (h *runtimeHistory) latestOrder() uint64 {
	var latest uint64
	for _, turn := range h.turns {
		latest = max(latest, turn.order)
	}
	return latest
}

// unsettled are the turns held that the Control Plane may still change, oldest first.
func (h *runtimeHistory) unsettled() []string {
	var ids []string
	for _, id := range h.order {
		if turn := h.turns[id]; turn != nil && turn.order > 0 && (!turn.settled || turn.needsFollow) {
			ids = append(ids, id)
		}
	}
	return ids
}

// reset forgets every turn held, and ends their follows.
func (h *runtimeHistory) reset() {
	for _, turn := range h.turns {
		if turn.stop != nil {
			turn.stop()
		}
	}
	h.order, h.turns, h.workShown, h.markedRead = nil, nil, nil, 0
}

// sortOrder puts the turns in the conversation's order; one whose order is not known yet stays
// after them, in the order it was added.
func (h *runtimeHistory) sortOrder() {
	key := func(id string) uint64 {
		if turn := h.turns[id]; turn != nil && turn.order > 0 {
			return turn.order
		}
		return math.MaxUint64
	}
	slices.SortStableFunc(h.order, func(a, b string) int { return cmp.Compare(key(a), key(b)) })
}

func (m model) reloadShownHistory() tea.Cmd {
	if m.pane != paneConversation {
		return nil
	}
	if tag := m.selectedTag(); tag != "" {
		return m.reloadHistory(tag)
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

func (m model) reloadHistory(tag string) tea.Cmd {
	if !m.conversation(tag).historyReload.start() {
		return nil
	}
	return m.loadHistory(tag)
}

// loadHistory reads what changed in the conversation with tag since the copy held: the messages
// after its latest, and the turns it holds unfinished. Without a copy, it reads the newest page.
func (m model) loadHistory(tag string) tea.Cmd {
	h := &m.conversation(tag).runtime
	query := client.MessageQuery{Limit: historyPage}
	if latest := h.latestOrder(); h.read && h.conversationID != "" && latest > 0 {
		query.After, query.ConversationID, query.Refresh = latest, h.conversationID, h.unsettled()
	}
	revision := h.revision
	displayed := slices.Clone(h.order)
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 15*time.Second)
		defer cancel()
		page, err := m.client.ListMessages(ctx, tag, query)
		if err != nil {
			return historyMsg{tag: tag, revision: revision, err: err}
		}
		if !page.Incremental {
			displayed = nil
		}
		return historyMsg{tag: tag, revision: revision, conversationID: page.ConversationID, incremental: page.Incremental,
			items: client.History(tag, page.Messages, displayed...)}
	}
}

func (m *model) showRuntimeHistory(msg historyMsg) tea.Cmd {
	c := m.conversation(msg.tag)
	var cmds []tea.Cmd
	again := c.historyReload.done()
	// A local send can commit after this read began. Its receipt schedules a
	// newer read so the older snapshot cannot put it in the wrong position.
	if msg.revision != c.runtime.revision {
		if again {
			return m.loadHistory(msg.tag)
		}
		return nil
	}
	c.loaded = true
	if msg.err != nil {
		c.runtime.readErr = terminalText(msg.err.Error())
	} else {
		h := &c.runtime
		h.readErr = ""
		if !msg.incremental && !h.continues(msg) {
			// The conversation was replaced or is empty, or more arrived than one page holds: the
			// page is the conversation's newest, and replaces what was held.
			h.reset()
		}
		h.read = true
		h.conversationID = msg.conversationID
		for _, item := range msg.items {
			cmds = append(cmds, m.runtimeItem(msg.tag, item))
		}
		h.sortOrder()
		cmds = append(cmds, m.markRead(msg.tag))
		m.cacheChanged(conversationKey(msg.tag))
	}
	if m.showsConversation(msg.tag) {
		m.refresh()
	}
	if again {
		cmds = append(cmds, m.loadHistory(msg.tag))
	}
	return tea.Batch(cmds...)
}

// continues says a newest page reaches back to what the history holds, so it adds to it rather
// than replacing it.
func (h *runtimeHistory) continues(msg historyMsg) bool {
	if len(msg.items) == 0 || len(h.turns) == 0 || h.conversationID != msg.conversationID {
		return false
	}
	oldest := uint64(math.MaxUint64)
	for _, item := range msg.items {
		if h.turns[item.Message.GetTaskId()] != nil {
			return true
		}
		if order := item.Message.GetOrder(); order > 0 {
			oldest = min(oldest, order)
		}
	}
	return oldest <= h.latestOrder()+1
}

// runtimeSent takes the Control Plane's receipt for a queued message: the message leaves the
// outbox and shows as its turn. A failed attempt stays in the outbox as not delivered.
func (m *model) runtimeSent(msg sentMsg) tea.Cmd {
	c := m.conversation(msg.tag)
	if entry := m.outbox.find(msg.operationID); entry != nil {
		entry.sending = false
		if msg.err != nil {
			entry.Error = terminalText(msg.err.Error())
		} else {
			m.outbox.remove(msg.operationID)
		}
		m.cacheChanged(outboxKey)
	}
	if msg.err != nil {
		if m.showsConversation(msg.tag) {
			m.refresh()
		}
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
		for _, item := range client.History(msg.tag, []*views.Message{msg.message}, source...) {
			cmds = append(cmds, m.runtimeItem(msg.tag, item))
		}
		c.runtime.sortOrder()
		m.cacheChanged(conversationKey(msg.tag))
		if m.showsConversation(msg.tag) {
			cmds = append(cmds, m.reloadHistory(msg.tag))
		}
	}
	if m.showsConversation(msg.tag) {
		m.viewport.GotoBottom()
		m.refresh()
	}
	return tea.Batch(cmds...)
}

func (m *model) runtimeItem(tag string, item client.HistoryItem) tea.Cmd {
	id := item.Message.GetTaskId()
	if id == "" {
		return nil
	}
	h := &m.conversation(tag).runtime
	if h.turns == nil {
		h.turns = make(map[string]*runtimeTurn)
	}
	turn := h.turns[id]
	joined := item.Message.GetJoinedTaskId() != ""
	var cmds []tea.Cmd
	if turn != nil && (turn.following || !turn.joined || joined) {
		turn.joined = turn.joined || joined
		turn.times(item.Message)
		turn.needsFollow = item.Follow
		// A snapshot adds what the turn showed since it was last read: its start, the messages
		// the Tag wrote, what it does now and its final reply, without repeating any that its
		// follow already showed. A turn's follow alone shows its work Sessions while it runs.
		for _, event := range item.Events {
			switch {
			case runtimeFinal(event), event.Kind == client.EventStarted, event.Kind == client.EventMessage,
				event.Kind == client.EventStatus, client.WorkEventKey(event) != "" && !turn.following:
				cmds = append(cmds, m.applyRuntimeTurn(h, turn, event))
			}
		}
		if item.Follow && !turn.following {
			cmds = append(cmds, m.followTurn(tag, id, turn, item))
		}
		return tea.Batch(cmds...)
	}
	if turn == nil {
		h.order = append(h.order, id)
	} else if turn.stop != nil {
		turn.stop()
	}
	// A joined input can be withdrawn and run as its own Task. Replace any
	// transcript attributed to the earlier source when that delivery clears.
	turn = &runtimeTurn{joined: joined, needsFollow: item.Follow}
	turn.times(item.Message)
	h.turns[id] = turn
	if item.Message.GetText() != "" {
		turn.add(entryYou, item.Message.GetText())
	}
	if item.Message.GetScheduleId() != "" {
		// The Tag speaks because it asked to be woken, not because you wrote.
		turn.add(entryDim, "Scheduled")
	}
	for _, event := range item.Events {
		cmds = append(cmds, m.applyRuntimeTurn(h, turn, event))
	}
	if item.Follow {
		cmds = append(cmds, m.followTurn(tag, id, turn, item))
	}
	return tea.Batch(cmds...)
}

// times records the message's order and when it was sent and finished.
func (t *runtimeTurn) times(message *views.Message) {
	t.order = max(t.order, message.GetOrder())
	if at := message.GetCreatedAt(); at != nil {
		t.sentAt = at.AsTime()
	}
	if at := message.GetCompletedAt(); at != nil {
		t.completedAt = at.AsTime()
	}
}

// followTurn follows a turn that still has a reply or work to show, until it settles or the turn
// is replaced.
func (m *model) followTurn(tag, id string, turn *runtimeTurn, item client.HistoryItem) tea.Cmd {
	ctx, stop := context.WithCancel(m.ctx)
	turn.following, turn.stop = true, stop
	follow := waitForTask(tag, id, m.follower.Follow(ctx, tag, item.Message, item.Shown))
	return func() tea.Msg {
		msg := follow()
		switch msg := msg.(type) {
		case followMsg:
			msg.turn = turn
			return msg
		case followDoneMsg:
			msg.turn = turn
			return msg
		}
		return msg
	}
}

func (m *model) runtimeFollow(msg followMsg) tea.Cmd {
	h := &m.conversation(msg.tag).runtime
	turn := h.turns[msg.taskID]
	if turn == nil || (msg.turn != nil && msg.turn != turn) {
		return nil
	}
	cmds := []tea.Cmd{m.applyRuntimeTurn(h, turn, msg.event)}
	for _, event := range msg.more {
		cmds = append(cmds, m.applyRuntimeTurn(h, turn, event))
	}
	m.cacheChanged(conversationKey(msg.tag))
	if m.showsConversation(msg.tag) {
		m.refresh()
	}
	return tea.Batch(cmds...)
}

func (m *model) runtimeFollowDone(msg followDoneMsg) tea.Cmd {
	if turn := m.conversation(msg.tag).runtime.turns[msg.taskID]; turn != nil && (msg.turn == nil || msg.turn == turn) {
		turn.following = false
		if (!turn.settled || turn.joined || turn.needsFollow) && m.showsConversation(msg.tag) {
			return m.reloadHistory(msg.tag)
		}
	}
	return nil
}

// markRead records that the operator read the shown conversation with tag up to its latest
// finished turn, when the Control Plane counts a reply after what was read before.
func (m *model) markRead(tag string) tea.Cmd {
	summary := m.summaries[tag]
	if !m.showsConversation(tag) || summary.GetUnreadCount() == 0 {
		return nil
	}
	h := &m.conversation(tag).runtime
	var order uint64
	for _, turn := range h.turns {
		if turn.settled {
			order = max(order, turn.order)
		}
	}
	if order <= summary.GetReadOrder() || order <= h.markedRead {
		return nil
	}
	h.markedRead = order
	c, ctx := m.client, m.ctx
	return func() tea.Msg {
		return markedMsg{tag: tag, order: order, err: c.MarkConversationRead(ctx, tag, order)}
	}
}

// marked lets a failed mark be tried again; the next listing of the conversations says whether
// one that succeeded cleared the unread replies.
func (m *model) marked(msg markedMsg) {
	if h := &m.conversation(msg.tag).runtime; msg.err != nil && h.markedRead == msg.order {
		h.markedRead = 0
	}
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
	switch event.Kind {
	case client.EventJoined:
		turn.joined = true
	case client.EventHostWait:
		turn.wait = event.Text
		return nil
	case client.EventStarted:
		turn.started = true
		return nil
	case client.EventStatus:
		if turn.settled {
			return nil
		}
	case client.EventMessage:
		if event.Sequence != 0 {
			if event.Sequence <= turn.after {
				return nil
			}
			turn.after = event.Sequence
		}
	case client.EventReply, client.EventTurnError:
		turn.started = true
	}
	if runtimeFinal(event) {
		if turn.settled {
			return nil
		}
		turn.settled = true
	}
	return m.applyTranscript(&turn.transcript, event)
}
