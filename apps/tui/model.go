package main

import (
	"context"
	"strings"
	"time"

	"charm.land/bubbles/v2/textinput"
	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
)

// conversationSession is the conversation the TUI shows: the same one as
// `supertag message tag NAME TEXT`.
const conversationSession = "default"

// tagRefresh is how often the rail rereads the Tags and their state.
var tagRefresh = 5 * time.Second

type focus int

const (
	focusInput focus = iota
	focusRail
)

type entryKind int

const (
	entryYou entryKind = iota
	entryReply
	entryDim
	entryError
)

// entry is one shown item; its text is already filtered for the terminal.
type entry struct {
	kind entryKind
	text string
}

// conversation is what the TUI has shown of one Tag's default conversation since it started.
type conversation struct {
	entries []entry
	// draft is the reply text streaming in; the final reply replaces it.
	draft string
	// rendered is the first renderedCount entries rendered at renderedWidth. Entries never
	// change once added, so each is rendered once per width, not on every streamed token.
	rendered      strings.Builder
	renderedCount int
	renderedWidth int
}

// add appends an entry, filtering its text for the terminal.
func (c *conversation) add(kind entryKind, text string) {
	c.entries = append(c.entries, entry{kind, terminalLines(text)})
}

type (
	tagsMsg struct {
		tags []client.Tag
		err  error
	}
	refreshMsg struct{}
	sentMsg    struct {
		tag    string
		record client.MessageRecord
		err    error
	}
	followMsg struct {
		tag    string
		event  client.FollowEvent
		events <-chan client.FollowEvent
	}
	followDoneMsg struct{ tag string }
)

type model struct {
	ctx      context.Context
	client   *client.Client
	follower *client.Follower

	tags          []client.Tag
	selected      int
	focus         focus
	conversations map[string]*conversation

	input    textinput.Model
	viewport viewport.Model
	width    int
	height   int
	md       *markdown

	connected bool
	status    string
}

func newModel(ctx context.Context, c *client.Client, f *client.Follower) model {
	input := textinput.New()
	input.Prompt = "> "
	input.Placeholder = "Message the Tag"
	input.Focus()
	return model{
		ctx:           ctx,
		client:        c,
		follower:      f,
		conversations: map[string]*conversation{},
		input:         input,
		viewport:      viewport.New(),
		md:            &markdown{},
		status:        "connecting",
	}
}

func (m model) Init() tea.Cmd {
	return tea.Batch(m.loadTags(), textinput.Blink)
}

func (m model) loadTags() tea.Cmd {
	return func() tea.Msg {
		tags, err := m.client.ListTags(m.ctx)
		return tagsMsg{tags: tags, err: err}
	}
}

func (m model) send(tag, text string) tea.Cmd {
	return func() tea.Msg {
		record, err := m.client.SendMessage(m.ctx, tag, text, conversationSession)
		return sentMsg{tag: tag, record: record, err: err}
	}
}

func waitFor(tag string, events <-chan client.FollowEvent) tea.Cmd {
	return func() tea.Msg {
		event, ok := <-events
		if !ok {
			return followDoneMsg{tag: tag}
		}
		return followMsg{tag: tag, event: event, events: events}
	}
}

func (m model) selectedTag() string {
	if m.selected < 0 || m.selected >= len(m.tags) {
		return ""
	}
	return m.tags[m.selected].Name()
}

func (m model) conversation(tag string) *conversation {
	c, ok := m.conversations[tag]
	if !ok {
		c = &conversation{}
		m.conversations[tag] = c
	}
	return c
}

func (m *model) fail(err error) {
	m.connected = false
	m.status = err.Error()
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.layout()
		return m, nil

	case tagsMsg:
		next := tea.Tick(tagRefresh, func(time.Time) tea.Msg { return refreshMsg{} })
		if msg.err != nil {
			m.fail(msg.err)
			return m, next
		}
		current := m.selectedTag()
		m.tags = msg.tags
		m.selected = 0
		for i, tag := range m.tags {
			if tag.Name() == current {
				m.selected = i
			}
		}
		m.connected, m.status = true, "connected"
		m.refresh()
		return m, next

	case refreshMsg:
		return m, m.loadTags()

	case sentMsg:
		if msg.err != nil {
			m.fail(msg.err)
			m.addEntry(msg.tag, entryError, msg.err.Error())
			return m, nil
		}
		m.connected, m.status = true, "connected"
		return m, waitFor(msg.tag, m.follower.Follow(m.ctx, msg.tag, msg.record))

	case followMsg:
		m.apply(msg.tag, msg.event)
		return m, waitFor(msg.tag, msg.events)

	case followDoneMsg:
		return m, nil

	case tea.KeyPressMsg:
		return m.key(msg)
	}

	var cmd tea.Cmd
	if m.focus == focusInput {
		m.input, cmd = m.input.Update(msg)
	}
	return m, cmd
}

func (m model) key(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "ctrl+c", "esc":
		return m, tea.Quit
	case "tab", "shift+tab":
		return m.toggleFocus()
	case "pgup":
		m.viewport.PageUp()
		return m, nil
	case "pgdown":
		m.viewport.PageDown()
		return m, nil
	}
	if m.focus == focusRail {
		switch msg.String() {
		case "up", "k":
			if m.selected > 0 {
				m.selected--
				m.refresh()
			}
		case "down", "j":
			if m.selected < len(m.tags)-1 {
				m.selected++
				m.refresh()
			}
		case "right", "enter":
			return m.toggleFocus()
		}
		return m, nil
	}
	switch msg.String() {
	case "enter":
		text := strings.TrimSpace(m.input.Value())
		tag := m.selectedTag()
		if text == "" || tag == "" {
			return m, nil
		}
		m.input.Reset()
		m.addEntry(tag, entryYou, text)
		return m, m.send(tag, text)
	case "left":
		if m.input.Value() == "" {
			return m.toggleFocus()
		}
	case "up":
		m.viewport.ScrollUp(1)
		return m, nil
	case "down":
		m.viewport.ScrollDown(1)
		return m, nil
	}
	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	return m, cmd
}

func (m model) toggleFocus() (tea.Model, tea.Cmd) {
	if m.focus == focusInput {
		m.focus = focusRail
		m.input.Blur()
		return m, nil
	}
	m.focus = focusInput
	return m, m.input.Focus()
}

// apply adds one follow event to its Tag's conversation, as `supertag message tag` prints it.
// Every field from the server or an agent is filtered for the terminal, as the CLI does.
func (m *model) apply(tag string, event client.FollowEvent) {
	c := m.conversation(tag)
	dim := func(text string) { c.add(entryDim, text) }
	title := terminalText(event.Title)
	switch event.Kind {
	case client.EventWaiting:
		dim("· waiting: " + terminalText(event.Text))
	case client.EventDelta:
		c.draft += terminalLines(event.Text)
	case client.EventActivity:
		line := terminalText(event.Text)
		if title != "" {
			line = title + " " + line
		}
		if event.Indent {
			line = "  " + line
		}
		dim(line)
	case client.EventReply:
		c.draft = ""
		c.add(entryReply, event.Reply.Text)
	case client.EventWorking:
		dim("· working: " + title)
	case client.EventReport:
		dim("· " + event.Status + ": " + title)
		c.add(entryReply, event.Text)
	case client.EventApproval:
		dim("· approval needed: " + title)
		c.add(entryReply, event.Text)
	case client.EventNotContinued:
		dim("· not continued: " + title)
		dim(event.Text)
	case client.EventStillWorking:
		dim(event.Text)
	case client.EventJoined:
		if event.Discard {
			c.draft = ""
		}
		dim("· added to the turn in progress")
	case client.EventError:
		c.draft = ""
		c.add(entryError, event.Text)
		m.connected, m.status = false, event.Text
	}
	if tag == m.selectedTag() {
		m.refresh()
	}
}

func (m *model) addEntry(tag string, kind entryKind, text string) {
	m.conversation(tag).add(kind, text)
	if tag == m.selectedTag() {
		m.refresh()
	}
}
