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

// tagRefresh is how often the rail and the shown Objective are reread while the watch stream is
// down.
var tagRefresh = 5 * time.Second

// watchKinds are the changes the rail and the Objective view follow.
var watchKinds = []operatorv1.WatchKind{
	operatorv1.WatchKind_WATCH_KIND_TAG,
	operatorv1.WatchKind_WATCH_KIND_CONVERSATION_MESSAGE,
	operatorv1.WatchKind_WATCH_KIND_OBJECTIVE,
	operatorv1.WatchKind_WATCH_KIND_TASK,
	operatorv1.WatchKind_WATCH_KIND_INBOX_ITEM,
	operatorv1.WatchKind_WATCH_KIND_APPROVAL,
	operatorv1.WatchKind_WATCH_KIND_WORKSTREAM_POST,
}

type focus int

const (
	// focusInput focuses the main pane, and its input line when the pane has one.
	focusInput focus = iota
	focusRail
)

// pane is what the main pane shows.
type pane int

const (
	paneConversation pane = iota
	paneObjective
	paneInbox
)

// decision is where deciding the shown approval request stands.
type decision int

const (
	decisionNone decision = iota
	// decisionConfirm waits for enter to approve.
	decisionConfirm
	// decisionReason takes the reason for denying in the input.
	decisionReason
	// decisionSending waits for the Control Plane's answer.
	decisionSending
)

// note is the outcome of acting on the shown inbox item; its text is filtered for the terminal.
type note struct {
	text string
	err  bool
}

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
	objectivesMsg struct {
		objectives []*operatorv1.Objective
		err        error
	}
	inboxMsg struct {
		inbox client.Inbox
		err   error
	}
	overviewMsg struct {
		id       string
		overview *operatorv1.ObjectiveOverview
		err      error
	}
	decidedMsg struct {
		occurrence string
		approved   bool
		reason     string
		err        error
	}
	answeredMsg struct {
		occurrence string
		text       string
		response   *operatorv1.MessageObjectiveResponse
		err        error
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

	tags []client.Tag
	// selected is the Tag whose conversation the conversation pane shows.
	selected      int
	focus         focus
	conversations map[string]*conversation
	// open counts each Tag's work Sessions in the default conversation that have not finished.
	open map[string]int

	// objectives are the open Objectives; inbox is what waits on the operator. Each error is why
	// its section could not be read, filtered for the terminal.
	objectives    []*operatorv1.Objective
	objectivesErr string
	inbox         client.Inbox
	inboxErr      string

	// cursor is the rail row under the cursor; it picks what the main pane shows.
	cursor int
	pane   pane
	// objectiveID is the Objective the Objective pane shows, and overviews what was last read of
	// each Objective shown.
	objectiveID  string
	overviews    map[string]*operatorv1.ObjectiveOverview
	overviewErrs map[string]string
	// item is the inbox item the inbox pane shows, kept after it leaves the inbox; itemNote is
	// what came of acting on it.
	item     *operatorv1.InboxItem
	itemNote note
	decision decision
	// drafts keeps unsent input per pane.
	drafts map[string]string

	// live says the watch stream delivers changes; polling runs only while it does not.
	live                                                          bool
	polling                                                       bool
	tagReload, convReload, objReload, inboxReload, overviewReload *reload

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
		ctx:            ctx,
		client:         c,
		follower:       f,
		watcher:        w,
		conversations:  map[string]*conversation{},
		open:           map[string]int{},
		overviews:      map[string]*operatorv1.ObjectiveOverview{},
		overviewErrs:   map[string]string{},
		drafts:         map[string]string{},
		inbox:          client.Inbox{TagNames: map[string]string{}},
		tagReload:      &reload{},
		convReload:     &reload{},
		objReload:      &reload{},
		inboxReload:    &reload{},
		overviewReload: &reload{},
		input:          input,
		viewport:       viewport.New(),
		md:             &markdown{},
		polling:        true,
		status:         "connecting",
	}
}

func (m model) Init() tea.Cmd {
	cmds := []tea.Cmd{m.reloadTags(), m.reloadConversations(), m.reloadObjectives(), m.reloadInbox(), m.pollAfter(), textinput.Blink}
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

func (m model) reloadObjectives() tea.Cmd {
	if !m.objReload.start() {
		return nil
	}
	return m.objectivesCmd()
}

func (m model) reloadInbox() tea.Cmd {
	if !m.inboxReload.start() {
		return nil
	}
	return m.inboxCmd()
}

// reloadOverview rereads the shown Objective; nil when no Objective is shown.
func (m model) reloadOverview() tea.Cmd {
	if m.pane != paneObjective || !m.overviewReload.start() {
		return nil
	}
	return m.overviewCmd(m.objectiveID)
}

// reloadAll rereads everything the TUI shows.
func (m model) reloadAll() tea.Cmd {
	return tea.Batch(m.reloadTags(), m.reloadConversations(), m.reloadObjectives(), m.reloadInbox(), m.reloadOverview())
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
	if m.pane != paneConversation {
		return nil
	}
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
		m.placeCursor()
		return m, tea.Batch(again, m.selectTag())

	case objectivesMsg:
		var again tea.Cmd
		if m.objReload.done() {
			again = m.objectivesCmd()
		}
		if msg.err != nil {
			m.objectivesErr = terminalText(msg.err.Error())
			return m, again
		}
		m.objectives, m.objectivesErr = msg.objectives, ""
		m.placeCursor()
		m.refresh()
		return m, again

	case inboxMsg:
		var again tea.Cmd
		if m.inboxReload.done() {
			again = m.inboxCmd()
		}
		if msg.err != nil {
			m.inboxErr = terminalText(msg.err.Error())
			return m, again
		}
		m.inbox, m.inboxErr = msg.inbox, ""
		if m.pane == paneInbox && m.item != nil {
			if current := m.inboxItem(m.item.GetOccurrence()); current != nil {
				m.item = current
			} else if m.decision != decisionSending {
				m.decision = decisionNone
			}
		}
		m.placeCursor()
		m.syncInput()
		m.refresh()
		return m, again

	case overviewMsg:
		var again tea.Cmd
		if m.overviewReload.done() && m.pane == paneObjective {
			again = m.overviewCmd(m.objectiveID)
		}
		if msg.err != nil {
			m.overviewErrs[msg.id] = terminalText(msg.err.Error())
		} else {
			m.overviews[msg.id] = msg.overview
			delete(m.overviewErrs, msg.id)
		}
		if m.pane == paneObjective && m.objectiveID == msg.id {
			m.refresh()
		}
		return m, again

	case decidedMsg:
		return m, m.decided(msg)

	case answeredMsg:
		return m, m.answered(msg)

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
		return m, tea.Batch(m.reloadAll(), m.pollAfter())

	case watchMsg:
		next := waitForWatch(msg.updates)
		switch msg.update.Kind {
		case client.WatchLive, client.WatchResync:
			m.live = true
			return m, tea.Batch(next, m.reloadAll())
		case client.WatchChanged:
			return m, tea.Batch(next, m.changed(msg.update.Change))
		case client.WatchLost:
			m.live = false
			if !m.polling {
				m.polling = true
				return m, tea.Batch(next, m.reloadAll(), m.pollAfter())
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

// changed rereads what one change touches.
func (m model) changed(change *operatorv1.WatchChange) tea.Cmd {
	shown := func(objective string) tea.Cmd {
		if objective != "" && objective == m.objectiveID {
			return m.reloadOverview()
		}
		return nil
	}
	switch change.GetKind() {
	case operatorv1.WatchKind_WATCH_KIND_TAG:
		return m.reloadTags()
	case operatorv1.WatchKind_WATCH_KIND_CONVERSATION_MESSAGE:
		return m.reloadConversations()
	case operatorv1.WatchKind_WATCH_KIND_OBJECTIVE:
		return tea.Batch(m.reloadObjectives(), shown(change.GetId()))
	case operatorv1.WatchKind_WATCH_KIND_TASK:
		// A Task's end changes its Objective's spend and Sessions; other Tasks change neither.
		if change.GetObjectiveId() == "" {
			return nil
		}
		return tea.Batch(m.reloadObjectives(), shown(change.GetObjectiveId()))
	case operatorv1.WatchKind_WATCH_KIND_INBOX_ITEM, operatorv1.WatchKind_WATCH_KIND_APPROVAL:
		return tea.Batch(m.reloadInbox(), shown(change.GetObjectiveId()))
	case operatorv1.WatchKind_WATCH_KIND_WORKSTREAM_POST:
		if m.pane == paneObjective && change.GetTeamId() != "" && change.GetTeamId() == m.shownTeam() {
			return m.reloadOverview()
		}
	}
	return nil
}

// shownTeam is the ID of the shown Objective's Team, or empty.
func (m model) shownTeam() string {
	if overview := m.overviews[m.objectiveID]; overview != nil {
		return overview.GetObjective().GetTeamId()
	}
	return ""
}

// tagsCmd, conversationsCmd, objectivesCmd, inboxCmd and overviewCmd reread what a reload marked
// running.
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

func (m model) objectivesCmd() tea.Cmd {
	return func() tea.Msg {
		objectives, err := m.client.ListOpenObjectives(m.ctx)
		return objectivesMsg{objectives: objectives, err: err}
	}
}

func (m model) inboxCmd() tea.Cmd {
	return func() tea.Msg {
		inbox, err := m.client.ListInbox(m.ctx)
		return inboxMsg{inbox: inbox, err: err}
	}
}

func (m model) overviewCmd(id string) tea.Cmd {
	return func() tea.Msg {
		overview, err := m.client.DescribeObjective(m.ctx, id)
		return overviewMsg{id: id, overview: overview, err: err}
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
	if m.showsConversation(msg.tag) {
		m.refresh()
	}
	return tea.Batch(cmds...)
}

func (m model) key(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "ctrl+c":
		return m, tea.Quit
	case "esc":
		if m.decision == decisionConfirm || m.decision == decisionReason {
			m.decision = decisionNone
			m.input.Reset()
			m.syncInput()
			m.refresh()
			return m, nil
		}
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
	if m.decision == decisionConfirm {
		if msg.String() == "enter" {
			return m, m.approve()
		}
		return m, nil
	}
	if m.focus == focusRail {
		switch msg.String() {
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
				return m, m.choose()
			}
		case "down", "j":
			if m.cursor < len(m.rows())-1 {
				m.cursor++
				return m, m.choose()
			}
		case "right", "enter":
			cmd := m.choose()
			next, focusCmd := m.toggleFocus()
			return next, tea.Batch(cmd, focusCmd)
		case "a", "d":
			return m.decide(msg.String())
		}
		return m, nil
	}
	if m.decision == decisionNone && (msg.String() == "a" || msg.String() == "d") && m.approvalShown() {
		return m.decide(msg.String())
	}
	switch msg.String() {
	case "enter":
		if m.inputShown() {
			return m, m.submit()
		}
		return m, nil
	case "left":
		if m.input.Value() == "" || !m.inputShown() {
			return m.toggleFocus()
		}
	case "up":
		m.viewport.ScrollUp(1)
		return m, nil
	case "down":
		m.viewport.ScrollDown(1)
		return m, nil
	}
	if !m.inputShown() {
		return m, nil
	}
	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	return m, cmd
}

// submit sends what the input holds: a message to the Tag, the answer to a question, or the
// reason for denying an approval request.
func (m *model) submit() tea.Cmd {
	text := strings.TrimSpace(m.input.Value())
	if text == "" {
		return nil
	}
	switch m.pane {
	case paneConversation:
		tag := m.selectedTag()
		if tag == "" || !m.conversation(tag).loaded {
			return nil
		}
		m.input.Reset()
		m.addEntry(tag, entryYou, text)
		return m.send(tag, text)
	case paneInbox:
		item := m.item
		if m.decision == decisionReason {
			m.input.Reset()
			m.decision = decisionSending
			m.itemNote = note{text: "Denying…"}
			m.syncInput()
			m.refresh()
			c, ctx, id := m.client, m.ctx, item.GetApproval().GetRequestId()
			return func() tea.Msg {
				_, err := c.Deny(ctx, id, text)
				return decidedMsg{occurrence: item.GetOccurrence(), reason: text, err: err}
			}
		}
		m.input.Reset()
		m.decision = decisionSending
		m.itemNote = note{text: "Sending your answer…"}
		m.syncInput()
		m.refresh()
		c, ctx := m.client, m.ctx
		return func() tea.Msg {
			response, err := c.AnswerQuestion(ctx, item.GetKey(), text)
			return answeredMsg{occurrence: item.GetOccurrence(), text: text, response: response, err: err}
		}
	}
	return nil
}

// decide starts approving ("a") or denying ("d") the shown approval request.
func (m model) decide(key string) (tea.Model, tea.Cmd) {
	if !m.approvalShown() || m.decision != decisionNone {
		return m, nil
	}
	m.itemNote = note{}
	if key == "a" {
		m.decision = decisionConfirm
		m.refresh()
		return m, nil
	}
	m.decision = decisionReason
	m.focus = focusInput
	m.input.Reset()
	m.input.Placeholder = "Why deny it?"
	cmd := m.syncInput()
	m.refresh()
	return m, cmd
}

// approve approves the shown approval request once.
func (m *model) approve() tea.Cmd {
	item := m.item
	m.decision = decisionSending
	m.itemNote = note{text: "Approving…"}
	m.refresh()
	c, ctx, id := m.client, m.ctx, item.GetApproval().GetRequestId()
	return func() tea.Msg {
		_, err := c.Approve(ctx, id)
		return decidedMsg{occurrence: item.GetOccurrence(), approved: true, err: err}
	}
}

// decided shows how deciding an approval request went, and rereads the inbox it leaves.
func (m *model) decided(msg decidedMsg) tea.Cmd {
	if m.item == nil || m.item.GetOccurrence() != msg.occurrence {
		return m.reloadInbox()
	}
	m.decision = decisionNone
	switch {
	case msg.err != nil:
		m.itemNote = note{text: terminalText(msg.err.Error()), err: true}
		if !msg.approved && m.inboxItem(msg.occurrence) != nil {
			m.decision = decisionReason
			m.input.SetValue(msg.reason)
		}
	case msg.approved:
		m.itemNote = note{text: "Approved once. The waiting Session continues."}
	default:
		m.itemNote = note{text: "Denied. The Session that asked continues with your reason."}
	}
	cmd := m.syncInput()
	m.refresh()
	return tea.Batch(cmd, m.reloadInbox())
}

// answered shows how answering a question went, and rereads the inbox it leaves.
func (m *model) answered(msg answeredMsg) tea.Cmd {
	if m.item == nil || m.item.GetOccurrence() != msg.occurrence {
		return m.reloadInbox()
	}
	m.decision = decisionNone
	if msg.err != nil {
		m.itemNote = note{text: terminalText(msg.err.Error()), err: true}
		if m.inboxItem(msg.occurrence) != nil {
			m.input.SetValue(msg.text)
		}
	} else {
		owner := terminalText(msg.response.GetTag())
		if owner == "" {
			owner = "The owner"
		}
		m.itemNote = note{text: "Sent. " + owner + " takes your answer as its next turn."}
	}
	cmd := m.syncInput()
	m.refresh()
	return tea.Batch(cmd, m.reloadInbox())
}

func (m model) toggleFocus() (tea.Model, tea.Cmd) {
	if m.focus == focusInput {
		m.focus = focusRail
	} else {
		m.focus = focusInput
	}
	return m, m.syncInput()
}

// syncInput focuses the input when the pane is focused and has an input line, and blurs it
// otherwise.
func (m *model) syncInput() tea.Cmd {
	if m.focus == focusInput && m.inputShown() {
		return m.input.Focus()
	}
	m.input.Blur()
	return nil
}

// inputShown says whether the pane ends with the input line, rather than a hint.
func (m model) inputShown() bool {
	switch m.pane {
	case paneConversation:
		return true
	case paneInbox:
		if m.decision == decisionReason {
			return true
		}
		return m.decision == decisionNone && m.item.GetKind() == operatorv1.InboxItemKind_INBOX_ITEM_KIND_QUESTION &&
			m.inboxItem(m.item.GetOccurrence()) != nil
	}
	return false
}

// approvalShown says whether the pane shows an approval request that still waits.
func (m model) approvalShown() bool {
	return m.pane == paneInbox && m.item.GetKind() == operatorv1.InboxItemKind_INBOX_ITEM_KIND_APPROVAL &&
		m.item.GetApproval().GetRequestId() != "" && m.inboxItem(m.item.GetOccurrence()) != nil
}

// inboxItem is the waiting item with this occurrence, or nil once it left the inbox.
func (m model) inboxItem(occurrence string) *operatorv1.InboxItem {
	for _, item := range m.inbox.Items {
		if item.GetOccurrence() == occurrence {
			return item
		}
	}
	return nil
}

// rowKind says which rail section a row is in.
type rowKind int

const (
	rowTag rowKind = iota
	rowObjective
	rowInbox
)

// row is one selectable rail row: index is into tags, objectives or inbox items.
type row struct {
	kind  rowKind
	index int
}

// rows are the rail's selectable rows, section by section.
func (m model) rows() []row {
	rows := make([]row, 0, len(m.tags)+len(m.objectives)+len(m.inbox.Items))
	for i := range m.tags {
		rows = append(rows, row{rowTag, i})
	}
	for i := range m.objectives {
		rows = append(rows, row{rowObjective, i})
	}
	for i := range m.inbox.Items {
		rows = append(rows, row{rowInbox, i})
	}
	return rows
}

func (m model) rowKey(r row) string {
	switch r.kind {
	case rowObjective:
		return "objective:" + m.objectives[r.index].GetId()
	case rowInbox:
		return "inbox:" + m.inbox.Items[r.index].GetOccurrence()
	}
	return "tag:" + m.tags[r.index].Name()
}

// paneKey names what the main pane shows, as rowKey names a row.
func (m model) paneKey() string {
	switch m.pane {
	case paneObjective:
		return "objective:" + m.objectiveID
	case paneInbox:
		return "inbox:" + m.item.GetOccurrence()
	}
	return "tag:" + m.selectedTag()
}

// placeCursor keeps the cursor on the row the pane shows after the rail's lists change, or
// within the rail when that row left it.
func (m *model) placeCursor() {
	rows := m.rows()
	key := m.paneKey()
	for i, r := range rows {
		if m.rowKey(r) == key {
			m.cursor = i
			return
		}
	}
	m.cursor = max(min(m.cursor, len(rows)-1), 0)
}

// choose shows the row under the cursor in the main pane.
func (m *model) choose() tea.Cmd {
	rows := m.rows()
	if m.cursor < 0 || m.cursor >= len(rows) {
		return nil
	}
	r := rows[m.cursor]
	if m.rowKey(r) == m.paneKey() {
		return nil
	}
	m.drafts[m.paneKey()] = m.input.Value()
	m.decision, m.itemNote = decisionNone, note{}
	var cmd tea.Cmd
	switch r.kind {
	case rowTag:
		m.pane, m.selected = paneConversation, r.index
		m.input.Placeholder = "Message the Tag"
	case rowObjective:
		m.pane, m.objectiveID = paneObjective, m.objectives[r.index].GetId()
		cmd = m.reloadOverview()
	case rowInbox:
		m.pane, m.item = paneInbox, m.inbox.Items[r.index]
		m.input.Placeholder = "Type your answer"
	}
	m.input.SetValue(m.drafts[m.paneKey()])
	focusCmd := m.syncInput()
	m.refresh()
	if m.pane == paneConversation {
		m.viewport.GotoBottom()
		return tea.Batch(focusCmd, m.selectTag())
	}
	m.viewport.GotoTop()
	return tea.Batch(focusCmd, cmd)
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
	if m.showsConversation(tag) {
		m.refresh()
	}
}

func (m *model) addEntry(tag string, kind entryKind, text string) {
	m.conversation(tag).add(kind, text)
	if m.showsConversation(tag) {
		m.refresh()
	}
}

// showsConversation says whether the main pane shows tag's conversation.
func (m model) showsConversation(tag string) bool {
	return m.pane == paneConversation && tag == m.selectedTag()
}
