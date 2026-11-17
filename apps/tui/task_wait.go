package main

import (
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// waitRefresh is how long a sent message waits before the terminal UI reads why, and how often it
// reads again while the message stays queued.
var waitRefresh = 3 * time.Second

// waitPoll reads why the shown conversation's queued turn waits. A model's copies share it.
type waitPoll struct {
	pending bool
}

type waitTickMsg struct{}

// taskWaitMsg is why a turn waits: empty when nothing keeps it waiting.
type taskWaitMsg struct {
	tag, id, wait string
	err           error
}

// queuedTurn is the shown conversation's last turn while it waits for a Worker Host to take it up,
// with its Tag and Task ID.
func (m model) queuedTurn() (string, string, *runtimeTurn) {
	if m.pane != paneConversation || m.client == nil {
		return "", "", nil
	}
	c := m.shown()
	if c == nil || len(c.runtime.order) == 0 {
		return "", "", nil
	}
	id := c.runtime.order[len(c.runtime.order)-1]
	turn := c.runtime.turns[id]
	if turn == nil || turn.started || turn.settled || turn.joined {
		return "", "", nil
	}
	return m.selectedTag(), id, turn
}

// pollWait is the command that reads, after waitRefresh, why the shown queued turn waits, while
// one shows and no read is pending.
func (m *model) pollWait() tea.Cmd {
	if m.wait.pending {
		return nil
	}
	if _, _, turn := m.queuedTurn(); turn == nil {
		return nil
	}
	m.wait.pending = true
	return tea.Tick(waitRefresh, func(time.Time) tea.Msg { return waitTickMsg{} })
}

// readWait asks the Control Plane why the shown queued turn waits.
func (m *model) readWait() tea.Cmd {
	tag, id, turn := m.queuedTurn()
	if turn == nil {
		m.wait.pending = false
		return nil
	}
	client, ctx := m.client, m.ctx
	return func() tea.Msg {
		wait, err := client.TaskWait(ctx, id)
		return taskWaitMsg{tag: tag, id: id, wait: wait, err: err}
	}
}

// waited shows why a turn waits. A failed read keeps what was shown.
func (m *model) waited(msg taskWaitMsg) {
	m.wait.pending = false
	if msg.err != nil {
		return
	}
	if turn := m.conversation(msg.tag).runtime.turns[msg.id]; turn != nil && turn.wait != msg.wait {
		turn.wait = msg.wait
		m.refresh()
	}
}

// waitLine says why a sent message has not started, under its delivery status; empty once a
// Worker Host took it up or when nothing is known.
func waitLine(turn *runtimeTurn, width int) string {
	if turn == nil || turn.wait == "" || turn.started || turn.settled || turn.joined {
		return ""
	}
	return faint.Render(lipgloss.NewStyle().Width(width).Render(terminalLines(turn.wait)))
}
