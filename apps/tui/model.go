package main

import (
	"context"
	"strings"
	"time"

	"charm.land/bubbles/v2/textinput"
	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
)

// conversationName is the conversation the TUI shows: the same one as
// `supertag message tag NAME TEXT`.
const conversationName = "default"

// historyPage is how many past messages a conversation shows when its Tag is first selected.
const historyPage = 50

// tagRefresh is how often the rail rereads the Tags while the watch stream is down.
var tagRefresh = 5 * time.Second

// watchKinds are the changes the rail follows.
var watchKinds = []operatorv1.WatchKind{operatorv1.WatchKind_WATCH_KIND_TAG, operatorv1.WatchKind_WATCH_KIND_CONVERSATION_MESSAGE}

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

// conversation is what the TUI shows of one Tag's default conversation: its newest page of
// history, then what happened since the TUI started.
type conversation struct {
	entries []entry
	// draft is the reply text streaming in; the final reply replaces it.
	draft string
	// loading and loaded track the history, which loads when the Tag is first selected. Sending
	// waits for it, so a message is not shown both live and from history.
	loading, loaded bool
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
	conversationsMsg struct {
		conversations []*operatorv1.Conversation
		err           error
	}
	pollMsg    struct{}
	historyMsg struct {
		tag   string
		items []client.HistoryItem
		err   error
	}
	sentMsg struct {
		tag     string
		message *operatorv1.Message
		err     error
	}
	followMsg struct {
		tag    string
		event  client.FollowEvent
		events <-chan client.FollowEvent
	}
	followDoneMsg struct{ tag string }
	watchMsg      struct {
		update  client.WatchUpdate
		updates <-chan client.WatchUpdate
	}
)

// reload coalesces rereads of one list: at most one runs, and changes during it reread once more.
type reload struct{ running, again bool }

// start reports whether a reread should start now.
func (r *reload) start() bool {
	if r.running {
		r.again = true
		return false
	}
	r.running = true
	return true
}

// done reports whether another reread should start, because a change came during this one.
func (r *reload) done() bool {
	r.running = false
	if r.again {
		r.again = false
		return r.start()
	}
	return false
}

type model struct {
	ctx      context.Context
	client   *client.Client
	follower *client.Follower
	watcher  *client.Watcher

	tags          []client.Tag
	selected      int
	focus         focus
	conversations map[string]*conversation
	// open counts each Tag's work Sessions in the default conversation that have not finished.
	open map[string]int

	// live says the watch stream delivers changes; polling runs only while it does not.
	live                  bool
	polling               bool
	tagReload, convReload *reload

	input    textinput.Model
	viewport viewport.Model
	width    int
	height   int
	md       *markdown

	connected bool
	status    string
}

func newModel(ctx context.Context, c *client.Client, f *client.Follower, w *client.Watcher) model {
	input := textinput.New()
	input.Prompt = "> "
	input.Placeholder = "Message the Tag"
	input.Focus()
	return model{
		ctx:           ctx,
		client:        c,
		follower:      f,
		watcher:       w,
		conversations: map[string]*conversation{},
		open:          map[string]int{},
		tagReload:     &reload{},
		convReload:    &reload{},
		input:         input,
		viewport:      viewport.New(),
		md:            &markdown{},
		polling:       true,
		status:        "connecting",
	}
}

func (m model) Init() tea.Cmd {
	cmds := []tea.Cmd{m.reloadTags(), m.reloadConversations(), m.pollAfter(), textinput.Blink}
	if m.watcher != nil {
		cmds = append(cmds, waitForWatch(m.watcher.Run(m.ctx)))
	}
	return tea.Batch(cmds...)
}

func (m model) pollAfter() tea.Cmd {
	return tea.Tick(tagRefresh, func(time.Time) tea.Msg { return pollMsg{} })
}

func (m model) reloadTags() tea.Cmd {
	if !m.tagReload.start() {
		return nil
	}
	return m.tagsCmd()
}

func (m model) reloadConversations() tea.Cmd {
	if !m.convReload.start() {
		return nil
	}
	return m.conversationsCmd()
}

func (m model) loadHistory(tag string) tea.Cmd {
	return func() tea.Msg {
		page, _, err := m.client.ListMessages(m.ctx, tag, conversationName, historyPage, "")
		return historyMsg{tag: tag, items: client.History(tag, page), err: err}
	}
}

func (m model) send(tag, text string) tea.Cmd {
	return func() tea.Msg {
		message, err := m.client.SendMessage(m.ctx, tag, conversationName, text)
		return sentMsg{tag: tag, message: message, err: err}
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

func waitForWatch(updates <-chan client.WatchUpdate) tea.Cmd {
	return func() tea.Msg {
		update, ok := <-updates
		if !ok {
			return nil
		}
		return watchMsg{update: update, updates: updates}
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

// selectTag shows the selected Tag's conversation, loading its history the first time.
func (m *model) selectTag() tea.Cmd {
	m.refresh()
	tag := m.selectedTag()
	if tag == "" {
		return nil
	}
	c := m.conversation(tag)
	if c.loaded || c.loading {
		return nil
	}
	c.loading = true
	return m.loadHistory(tag)
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
		var again tea.Cmd
		if m.tagReload.done() {
			again = m.tagsCmd()
		}
		if msg.err != nil {
			m.fail(msg.err)
			return m, again
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
		return m, tea.Batch(again, m.selectTag())

	case conversationsMsg:
		var again tea.Cmd
		if m.convReload.done() {
			again = m.conversationsCmd()
		}
		if msg.err == nil {
			m.open = map[string]int{}
			for _, c := range msg.conversations {
				if c.GetName() == conversationName {
					m.open[c.GetTag()] = int(c.GetOpenWorkSessionCount())
				}
			}
		}
		return m, again

	case pollMsg:
		if m.live {
			m.polling = false
			return m, nil
		}
		return m, tea.Batch(m.reloadTags(), m.reloadConversations(), m.pollAfter())

	case watchMsg:
		next := waitForWatch(msg.updates)
		switch msg.update.Kind {
		case client.WatchLive, client.WatchResync:
			m.live = true
			return m, tea.Batch(next, m.reloadTags(), m.reloadConversations())
		case client.WatchChanged:
			switch msg.update.Change.GetKind() {
			case operatorv1.WatchKind_WATCH_KIND_TAG:
				return m, tea.Batch(next, m.reloadTags())
			case operatorv1.WatchKind_WATCH_KIND_CONVERSATION_MESSAGE:
				return m, tea.Batch(next, m.reloadConversations())
			}
		case client.WatchLost:
			m.live = false
			if !m.polling {
				m.polling = true
				return m, tea.Batch(next, m.reloadTags(), m.pollAfter())
			}
		}
		return m, next

	case historyMsg:
		return m, m.showHistory(msg)

	case sentMsg:
		if msg.err != nil {
			m.fail(msg.err)
			m.addEntry(msg.tag, entryError, msg.err.Error())
			return m, nil
		}
		m.connected, m.status = true, "connected"
		return m, waitFor(msg.tag, m.follower.Follow(m.ctx, msg.tag, msg.message, nil))

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

// tagsCmd and conversationsCmd reread a list whose reload is marked running.
func (m model) tagsCmd() tea.Cmd {
	return func() tea.Msg {
		tags, err := m.client.ListTags(m.ctx)
		return tagsMsg{tags: tags, err: err}
	}
}

func (m model) conversationsCmd() tea.Cmd {
	return func() tea.Msg {
		conversations, err := m.client.ListConversations(m.ctx)
		return conversationsMsg{conversations: conversations, err: err}
	}
}

// showHistory adds a conversation's past messages, oldest first, and follows those that still
// have a reply or work to show.
func (m *model) showHistory(msg historyMsg) tea.Cmd {
	c := m.conversation(msg.tag)
	c.loading, c.loaded = false, true
	if msg.err != nil {
		m.addEntry(msg.tag, entryError, "Could not load the conversation history: "+msg.err.Error())
		return nil
	}
	var cmds []tea.Cmd
	for _, item := range msg.items {
		c.add(entryYou, item.Message.GetText())
		for _, event := range item.Events {
			m.apply(msg.tag, event)
		}
		if item.Follow {
			cmds = append(cmds, waitFor(msg.tag, m.follower.Follow(m.ctx, msg.tag, item.Message, item.Shown)))
		}
	}
	if msg.tag == m.selectedTag() {
		m.refresh()
	}
	return tea.Batch(cmds...)
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
				return m, m.selectTag()
			}
		case "down", "j":
			if m.selected < len(m.tags)-1 {
				m.selected++
				return m, m.selectTag()
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
		if text == "" || tag == "" || !m.conversation(tag).loaded {
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
		c.add(entryReply, event.Reply.GetText())
	case client.EventTurnError:
		c.draft = ""
		c.add(entryError, event.Text)
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
