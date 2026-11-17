package main

import (
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// The conversation borrows a messaging app's conventions, adapted to a terminal: consecutive
// messages from one sender form a group under one name, a time divider marks the start of the
// history and each pause of more than dividerGap, the operator's last message says whether it
// was delivered and seen, and an animated "···" stays at the tail of a running turn until its
// result arrives. It shows only messages and short notices: what the Tag does, its activity and
// its work Sessions, is in the work Sessions pane.

// dividerGap is the pause between two messages that a time divider marks.
const dividerGap = 15 * time.Minute

// typingInterval is how often the typing indicator moves.
const typingInterval = 400 * time.Millisecond

// typingFrames are the typing indicator's frames.
var typingFrames = []string{"·  ", "·· ", "···", " ··", "  ·", "   "}

// sender is who wrote an entry. An entry of neither, such as a status or error line, belongs to the
// group it is in.
type sender int

const (
	senderNone sender = iota
	senderYou
	senderTag
)

// hidden says the conversation does not show an entry of this kind: a work Session line or
// activity. Only messages, the result, and short notices such as a waiting reason show.
func hidden(kind entryKind) bool {
	return kind == entryWork || kind == entryActivity
}

func entrySender(kind entryKind) sender {
	switch kind {
	case entryYou:
		return senderYou
	case entryReply, entryMessage, entryReport:
		return senderTag
	}
	return senderNone
}

// typing animates the typing indicator. A model's copies share it.
type typing struct {
	frame   int
	ticking bool
}

type typingTickMsg struct{}

// transcriptWriter writes a conversation's lines, grouping them by sender.
type transcriptWriter struct {
	out strings.Builder
	// lines counts the lines written when count is set: only a selected line needs its position,
	// and counting scans every line of a long conversation.
	lines int
	count bool
	// sender is the sender of the group being written.
	sender sender
	// last is when the latest message written was sent or answered.
	last         time.Time
	you, tagName string
	width        int
	now          time.Time
}

func (w *transcriptWriter) write(s string) {
	w.out.WriteString(s)
	if w.count {
		w.lines += strings.Count(s, "\n")
	}
}

// from starts a group when s is not the sender of the one being written.
func (w *transcriptWriter) from(s sender) {
	if s == senderNone || s == w.sender {
		return
	}
	if w.out.Len() > 0 {
		w.write("\n")
	}
	if s == senderYou {
		w.write(w.you + "\n")
	} else {
		w.write(w.tagName + "\n")
	}
	w.sender = s
}

// at writes a time divider before a message sent at t, at the start of the history and after a
// pause of more than dividerGap.
func (w *transcriptWriter) at(t time.Time) {
	if t.IsZero() {
		return
	}
	if w.last.IsZero() || t.Sub(w.last) > dividerGap {
		if w.out.Len() > 0 {
			w.write("\n")
		}
		w.write(divider(timeLabel(t, w.now), w.width) + "\n")
		w.sender = senderNone
	}
	w.seen(t)
}

// seen records that a message was sent or answered at t.
func (w *transcriptWriter) seen(t time.Time) {
	if t.After(w.last) {
		w.last = t
	}
}

// divider centres label in a faint rule across width.
func divider(label string, width int) string {
	label = " " + label + " "
	side := max((width-lipgloss.Width(label))/2, 2)
	return faint.Render(strings.Repeat("─", side) + label + strings.Repeat("─", max(width-side-lipgloss.Width(label), 2)))
}

// timeLabel is when a message was sent, as a messaging app says it: "Today 10:16 PM",
// "Yesterday 9:02 AM", the weekday within a week, else the date.
func timeLabel(t, now time.Time) string {
	t, now = t.Local(), now.Local()
	clock := t.Format("3:04 PM")
	day := func(t time.Time) time.Time { return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location()) }
	days := int(day(now).Sub(day(t)).Round(time.Hour).Hours() / 24)
	switch {
	case days <= 0:
		return "Today " + clock
	case days == 1:
		return "Yesterday " + clock
	case days < 7:
		return t.Format("Monday") + " " + clock
	case t.Year() == now.Year():
		return t.Format("Jan 2") + " " + clock
	}
	return t.Format("Jan 2, 2006") + " " + clock
}

// renderTranscript renders the conversation with tag: each turn's messages grouped by sender with
// time dividers, short notices, the delivery status of the operator's last message, the typing
// indicator of a running turn, then the messages not yet accepted. Work Session lines and
// activity are left to the work Sessions pane. Each entry's body is rendered once per width. It
// records how many messages the Tag wrote, for the count of new ones.
func (m model) renderTranscript(c *conversation, tag, name string, width int) string {
	w := &transcriptWriter{you: bold.Render("you"), tagName: headerStyle.Render(name), width: width, now: m.now()}
	wrap := lipgloss.NewStyle().Width(width)
	queued := m.outbox.of(tag)
	lastYou := ""
	for _, id := range c.runtime.order {
		if turn := c.runtime.turns[id]; turn != nil && len(turn.entries) > 0 && turn.entries[0].kind == entryYou {
			lastYou = id
		}
	}
	written := 0
	// A turn that later messages joined shows its reply after the last of them, so the
	// conversation reads in order.
	answeredBy := map[string]string{}
	for _, id := range c.runtime.order {
		if turn := c.runtime.turns[id]; turn != nil && turn.joined && turn.source != "" && turn.source != id &&
			c.runtime.turns[turn.source] != nil {
			answeredBy[turn.source] = id
		}
	}
	answers := map[string]string{}
	for source, last := range answeredBy {
		answers[last] = source
	}
	render := func(t *transcript, turn *runtimeTurn, id string, part turnPart) {
		if t.cacheWidth != width {
			t.cache, t.cacheWidth = nil, width
		}
		for i, e := range t.entries {
			if i >= len(t.cache) {
				rendered := ""
				if !hidden(e.kind) {
					rendered = m.renderEntry(e, width)
				}
				t.cache = append(t.cache, rendered)
			}
			if hidden(e.kind) || (part == promptOnly && e.kind != entryYou) || (part == replyOnly && e.kind == entryYou) {
				continue
			}
			s := entrySender(e.kind)
			w.from(s)
			if s == senderTag {
				written++
			}
			w.write(t.cache[i])
			if i == 0 && e.kind == entryYou && id != "" && id == lastYou && len(queued) == 0 {
				w.write(m.deliveryLine(turn) + "\n")
				if line := waitLine(turn, width); line != "" {
					w.write(line + "\n")
				}
			}
		}
		if part == promptOnly {
			return
		}
		if t.draft != "" {
			w.from(senderTag)
			w.write(faint.Render(wrap.Render(t.draft)) + "\n")
		}
		if turn != nil && running(turn) {
			// The indicator alone says the Tag works; it stays the turn's last line until its
			// result arrives.
			w.from(senderTag)
			w.write(faint.Render(typingFrames[m.typing.frame%len(typingFrames)]) + "\n")
		}
	}
	for _, id := range c.runtime.order {
		turn := c.runtime.turns[id]
		if turn == nil || turn.hidden {
			continue
		}
		w.at(turn.sentAt)
		if _, later := answeredBy[id]; later {
			render(&turn.transcript, turn, id, promptOnly)
			continue
		}
		render(&turn.transcript, turn, id, wholeTurn)
		if source := answers[id]; source != "" {
			answered := c.runtime.turns[source]
			render(&answered.transcript, answered, source, replyOnly)
			w.seen(answered.completedAt)
		}
		w.seen(turn.completedAt)
	}
	render(&c.transcript, nil, "", wholeTurn)
	for _, entry := range queued {
		w.at(time.UnixMilli(entry.CreatedAtMs))
		w.from(senderYou)
		w.write(wrap.Render(terminalLines(entry.Text)) + "\n")
		w.write(m.queuedLine(entry, width) + "\n")
	}
	if c.runtime.readErr != "" {
		w.write("\n" + errorStyle.Render(wrap.Render("Could not load the conversation history: "+c.runtime.readErr)) + "\n")
	}
	c.written = written
	return strings.TrimRight(w.out.String(), "\n")
}

// turnPart is what of a turn the transcript shows where the turn stands.
type turnPart int

const (
	wholeTurn turnPart = iota
	// promptOnly is the person's message alone: its reply shows after a later message that
	// joined its turn.
	promptOnly
	// replyOnly is what the Tag wrote, shown after the last message that joined the turn.
	replyOnly
)

// running says the turn shows the typing indicator: a Worker Host took it up, and its result has
// not arrived.
func running(turn *runtimeTurn) bool {
	return turn.started && !turn.settled && !turn.joined
}

// deliveryLine says how far the operator's last message got: Sent once the Gateway
// accepted it, Seen once a Worker Host took its turn up or a running turn took it in.
func (m model) deliveryLine(turn *runtimeTurn) string {
	if turn != nil && (turn.started || turn.settled || turn.joined) {
		return faint.Render("Seen")
	}
	return faint.Render("Sent")
}

// queuedLine says what became of a message the Gateway has not accepted: it is sending,
// or it was not delivered, with the keys that send it again or take it back to edit.
func (m model) queuedLine(entry *outgoing, width int) string {
	if entry.sending || entry.Error == "" {
		return faint.Render("Sending…")
	}
	line := errorStyle.Render("! Not delivered") + faint.Render(" · ctrl+r retry · ctrl+x edit")
	return line + "\n" + faint.Render(truncate(strings.Join(strings.Fields(entry.Error), " "), width))
}

// showsTyping says the shown conversation shows the typing indicator.
func (m model) showsTyping() bool {
	if m.pane != paneConversation {
		return false
	}
	c := m.shown()
	if c == nil {
		return false
	}
	for i := len(c.runtime.order) - 1; i >= 0; i-- {
		if turn := c.runtime.turns[c.runtime.order[i]]; turn != nil && running(turn) {
			return true
		}
	}
	return false
}

// animateTyping is the command that moves the typing indicator, while it shows and is not
// already moving.
func (m *model) animateTyping() tea.Cmd {
	if m.typing.ticking || !m.showsTyping() {
		return nil
	}
	m.typing.ticking = true
	return tea.Tick(typingInterval, func(time.Time) tea.Msg { return typingTickMsg{} })
}

// typingTick moves the typing indicator one frame.
func (m *model) typingTick() {
	m.typing.ticking = false
	if m.showsTyping() {
		m.typing.frame++
		m.refresh()
	}
}

// newSince is how many messages the Tag wrote in the shown conversation since the operator last
// saw its bottom.
func (m model) newSince() int {
	if m.pane != paneConversation || m.viewport.AtBottom() {
		return 0
	}
	if c := m.shown(); c != nil {
		return max(c.written-c.seen, 0)
	}
	return 0
}

// sawBottom records that the operator sees the bottom of the shown conversation.
func (m *model) sawBottom() {
	if m.pane != paneConversation || !m.viewport.AtBottom() {
		return
	}
	if c := m.shown(); c != nil {
		c.seen = c.written
	}
}

// jumpToLatest scrolls the conversation to its latest message.
func (m *model) jumpToLatest() {
	m.viewport.GotoBottom()
	m.sawBottom()
}
