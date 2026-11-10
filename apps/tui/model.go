package main

import (
	"context"
	"os"
	"strings"
	"time"

	"charm.land/bubbles/v2/textinput"
	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
)

// defaultConversation is the conversation a Tag opens before an operator chooses one.
const defaultConversation = "default"

// conversationPlaceholder is the input's placeholder in a conversation.
const conversationPlaceholder = "Message the Tag · /goal · ↑ work Sessions · ctrl+o conversations"

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
	operatorv1.WatchKind_WATCH_KIND_SESSION,
	operatorv1.WatchKind_WATCH_KIND_INBOX_ITEM,
	operatorv1.WatchKind_WATCH_KIND_APPROVAL,
	operatorv1.WatchKind_WATCH_KIND_WORKSTREAM_POST,
	operatorv1.WatchKind_WATCH_KIND_TEAM,
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
	// paneDiff shows a work Session branch's diff, or why it cannot.
	paneDiff
	// paneConversations lists the selected Tag's conversations to switch to or start.
	paneConversations
	paneTeam
	// paneNewObjective declares a new Objective owned by the selected Tag.
	paneNewObjective
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
	// entryWork is a work Session's "working" line, which expands to show its activity and
	// report.
	entryWork
	// entryReport is a work Session's report; its branch line follows the latest one.
	entryReport
)

// entry is one shown item; its text is already filtered for the terminal.
type entry struct {
	kind entryKind
	text string
	// session is the work Session an entryWork or entryReport belongs to.
	session string
}

// conversation is what the TUI shows of one of the caller's conversations with a Tag: its newest
// page of history, then what happened since the TUI started.
type conversation struct {
	entries []entry
	// draft is the reply text streaming in; the final reply replaces it.
	draft string
	// loading and loaded track the history, which loads when the conversation is first shown.
	// Sending waits for it, so a message is not shown both live and from history.
	loading, loaded bool
	// cache holds each entry rendered at cacheWidth, "" for an entry that renders anew each time.
	// Other entries never change once added, so each is rendered once per width, not on every
	// streamed token.
	cache      []string
	cacheWidth int
	// selected is the work Session or branch line chosen with up and down; nil while the input
	// has the keys.
	selected *target
	// selectedLine is the line of the selected target in the last rendering.
	selectedLine int
}

// add appends an entry, filtering its text for the terminal.
func (c *conversation) add(kind entryKind, text string) {
	c.entries = append(c.entries, entry{kind: kind, text: terminalLines(text)})
}

// addFor appends an entry of a work Session.
func (c *conversation) addFor(kind entryKind, session, text string) {
	c.entries = append(c.entries, entry{kind: kind, text: terminalLines(text), session: session})
}

// convKey names a conversation in the model's maps.
func convKey(tag, name string) string { return tag + "\x00" + name }

type (
	tagsMsg struct {
		tags []*operatorv1.Tag
		err  error
	}
	conversationsMsg struct {
		conversations []*operatorv1.Conversation
		err           error
	}
	pollMsg    struct{}
	historyMsg struct {
		tag, conversation string
		items             []client.HistoryItem
		err               error
	}
	sentMsg struct {
		tag, conversation string
		message           *operatorv1.Message
		err               error
	}
	followMsg struct {
		tag, conversation string
		event             client.FollowEvent
		events            <-chan client.FollowEvent
	}
	followDoneMsg struct{}
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
	defaultWorkspace string
	ctx              context.Context
	client           *client.Client
	follower         *client.Follower
	watcher          *client.Watcher

	tags        []*operatorv1.Tag
	tagsChecked bool
	tagsErr     error
	// selected is the Tag whose conversation the conversation pane shows.
	selected int
	focus    focus
	// conversations are what is shown of each conversation, by convKey; current names the
	// conversation each Tag shows, the default one when unset.
	conversations map[string]*conversation
	current       map[string]string
	// open counts the work Sessions of each conversation, by convKey, that have not finished.
	open map[string]int
	// work is what was read of each work Session shown, by ID; expanded holds those whose lines
	// show their activity and report.
	work     map[string]*workDetail
	expanded map[string]bool
	// diff is the diff pane's content; picker the conversation list's.
	diff   *diffView
	picker *picker
	// form is the new Objective form while it shows.
	form *objectiveForm
	// notice is what came of the last action on a conversation's selection, such as opening a
	// pull request; the next key clears it.
	notice note

	// teams are the organization's Teams; teamID the one the Team pane shows, and teamViews what
	// was last read of each Team shown.
	teams      []*operatorv1.Team
	teamsErr   string
	teamID     string
	teamViews  map[string]client.TeamView
	teamErrs   map[string]string
	teamReload *reload
	teamView   *reload
	// teamReads numbers Team reads, so a reply older than one already shown is dropped.
	teamReads *teamReads

	// git runs git for diffs in cwd, the directory the TUI started in; openURL opens a web
	// address with the platform's opener.
	git     gitRunner
	cwd     string
	openURL func(string) error

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
	objectiveID       string
	overviews         map[string]*operatorv1.ObjectiveOverview
	overviewErrs      map[string]string
	objectiveCompose  bool
	objectiveMessages map[string]*objectiveMessage
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

	// hosts are the Worker Hosts as last read; hostsKnown is false until a read succeeds and
	// after one fails.
	hosts      []*operatorv1.WorkerHost
	hostsKnown bool
	hostReload *reload

	// switchable says the status bar offers switching to another Control Plane.
	switchable bool

	connected bool
	status    string
}

func newModel(ctx context.Context, c *client.Client, f *client.Follower, w *client.Watcher) model {
	input := textinput.New()
	input.Prompt = "> "
	input.Placeholder = conversationPlaceholder
	cwd, _ := os.Getwd()
	return model{
		ctx:               ctx,
		client:            c,
		follower:          f,
		watcher:           w,
		conversations:     map[string]*conversation{},
		current:           map[string]string{},
		open:              map[string]int{},
		work:              map[string]*workDetail{},
		expanded:          map[string]bool{},
		teamViews:         map[string]client.TeamView{},
		teamErrs:          map[string]string{},
		teamReload:        &reload{},
		teamView:          &reload{},
		teamReads:         newTeamReads(),
		git:               runGit,
		cwd:               cwd,
		openURL:           openURL,
		overviews:         map[string]*operatorv1.ObjectiveOverview{},
		overviewErrs:      map[string]string{},
		objectiveMessages: map[string]*objectiveMessage{},
		drafts:            map[string]string{},
		inbox:             client.Inbox{TagNames: map[string]string{}},
		tagReload:         &reload{},
		convReload:        &reload{},
		objReload:         &reload{},
		inboxReload:       &reload{},
		overviewReload:    &reload{},
		hostReload:        &reload{},
		input:             input,
		viewport:          viewport.New(),
		md:                &markdown{},
		polling:           true,
		status:            "connecting",
	}
}

func (m model) Init() tea.Cmd {
	cmds := []tea.Cmd{m.reloadTags(), m.reloadConversations(), m.reloadObjectives(), m.reloadInbox(), m.reloadTeams(),
		m.reloadHosts(), m.pollAfter(), m.hostsAfter()}
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
	return tea.Batch(m.reloadTags(), m.reloadConversations(), m.reloadObjectives(), m.reloadInbox(), m.reloadOverview(),
		m.reloadTeams(), m.reloadTeam(), m.reloadPicker(), m.reloadHosts())
}

func (m model) loadHistory(tag, name string) tea.Cmd {
	return func() tea.Msg {
		page, _, err := m.client.ListMessages(m.ctx, tag, name, historyPage, "")
		return historyMsg{tag: tag, conversation: name, items: client.History(tag, page), err: err}
	}
}

func (m model) send(tag, name, text string) tea.Cmd {
	return func() tea.Msg {
		message, err := m.client.SendMessage(m.ctx, tag, name, text)
		return sentMsg{tag: tag, conversation: name, message: message, err: err}
	}
}

func waitFor(tag, name string, events <-chan client.FollowEvent) tea.Cmd {
	return func() tea.Msg {
		event, ok := <-events
		if !ok {
			return followDoneMsg{}
		}
		return followMsg{tag: tag, conversation: name, event: event, events: events}
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
	return tagName(m.tags[m.selected])
}

// currentConversation names the conversation tag shows.
func (m model) currentConversation(tag string) string {
	if name := m.current[tag]; name != "" {
		return name
	}
	return defaultConversation
}

func (m model) conversation(tag, name string) *conversation {
	c, ok := m.conversations[convKey(tag, name)]
	if !ok {
		c = &conversation{}
		m.conversations[convKey(tag, name)] = c
	}
	return c
}

// shown is the conversation the selected Tag shows, or nil without Tags.
func (m model) shown() *conversation {
	tag := m.selectedTag()
	if tag == "" {
		return nil
	}
	return m.conversation(tag, m.currentConversation(tag))
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
	name := m.currentConversation(tag)
	c := m.conversation(tag, name)
	if c.loaded || c.loading {
		return nil
	}
	c.loading = true
	return m.loadHistory(tag, name)
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
		m.tagsChecked, m.tagsErr = true, msg.err
		if msg.err != nil {
			m.fail(msg.err)
			m.refresh()
			return m, again
		}
		current := m.selectedTag()
		m.tags = msg.tags
		m.selected = 0
		for i, tag := range m.tags {
			if tagName(tag) == current {
				m.selected = i
			}
		}
		m.connected, m.status = true, "connected"
		m.placeCursor()
		var focusCmd tea.Cmd
		if current != m.selectedTag() {
			focusCmd = m.syncInput()
		}
		return m, tea.Batch(again, m.selectTag(), focusCmd)

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

	case objectiveSentMsg:
		return m, m.objectiveMessageSent(msg)

	case objectiveReplyMsg:
		return m, m.objectiveReplyRead(msg)

	case inboxMsg:
		var again tea.Cmd
		if m.inboxReload.done() {
			again = m.inboxCmd()
		}
		if msg.err != nil {
			m.inboxErr = terminalText(msg.err.Error())
			return m, again
		}
		left := -1
		if m.pane == paneInbox && m.item != nil {
			for i, item := range m.inbox.Items {
				if item.GetOccurrence() == m.item.GetOccurrence() {
					left = i
				}
			}
		}
		m.inbox, m.inboxErr = msg.inbox, ""
		follow := false
		if m.pane == paneInbox && m.item != nil {
			if current := m.inboxItem(m.item.GetOccurrence()); current != nil {
				m.item = current
			} else if m.decision != decisionSending {
				m.decision = decisionNone
				// Settled elsewhere: show the item now selected in its place rather than a stale
				// one. After the operator's own successful decision or answer, its outcome note stays
				// shown; a failed one's error note does not hold the pane.
				follow = m.itemNote.text == "" || m.itemNote.err
			}
		}
		m.placeCursor()
		if follow {
			again = tea.Batch(again, m.followSettled(left))
		}
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
			if m.objectiveCompose && !m.canMessageObjective() {
				m.saveDraft()
				again = tea.Batch(again, m.syncInput())
			}
			m.refresh()
		}
		return m, again

	case decidedMsg:
		return m, m.decided(msg)

	case answeredMsg:
		return m, m.answered(msg)

	case createdMsg:
		return m, m.objectiveCreated(msg)

	case conversationsMsg:
		var again tea.Cmd
		if m.convReload.done() {
			again = m.conversationsCmd()
		}
		if msg.err == nil {
			m.open = map[string]int{}
			for _, c := range msg.conversations {
				m.open[convKey(c.GetTag(), c.GetName())] = int(c.GetOpenWorkSessionCount())
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
			m.addEntry(msg.tag, msg.conversation, entryError, msg.err.Error())
			return m, nil
		}
		m.connected, m.status = true, "connected"
		return m, waitFor(msg.tag, msg.conversation, m.follower.Follow(m.ctx, msg.tag, msg.message, nil))

	case followMsg:
		cmd := m.apply(msg.tag, msg.conversation, msg.event)
		return m, tea.Batch(cmd, waitFor(msg.tag, msg.conversation, msg.events))

	case followDoneMsg:
		return m, nil

	case workMsg:
		return m, m.workRead(msg)

	case diffMsg:
		m.diffRead(msg)
		return m, nil

	case openedMsg:
		m.opened(msg)
		return m, nil

	case pickerMsg:
		return m, m.pickerRead(msg)

	case teamsMsg:
		return m, m.teamsRead(msg)

	case teamMsg:
		return m, m.teamRead(msg)

	case hostsMsg:
		return m, m.hostsRead(msg)

	case hostTickMsg:
		return m, tea.Batch(m.reloadHosts(), m.hostsAfter())

	case tea.KeyPressMsg:
		return m.key(msg)
	}

	var cmd tea.Cmd
	if m.focus == focusInput {
		m.input, cmd = m.input.Update(msg)
		if m.pane == paneNewObjective && m.form != nil {
			var field tea.Cmd
			m.form.fields[m.form.field], field = m.form.fields[m.form.field].Update(msg)
			cmd = tea.Batch(cmd, field)
		}
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
		// A Tag's name or deletion shows in the member list of the shown Team.
		var team tea.Cmd
		if m.pane == paneTeam && m.shownTeamHasMember(change.GetId()) {
			team = m.reloadTeam()
		}
		return tea.Batch(m.reloadTags(), team)
	case operatorv1.WatchKind_WATCH_KIND_TEAM:
		return m.teamChanged(change)
	case operatorv1.WatchKind_WATCH_KIND_CONVERSATION_MESSAGE:
		var picker tea.Cmd
		if m.pane == paneConversations && m.picker != nil && m.picker.tag == change.GetTag() {
			picker = m.reloadPicker()
		}
		return tea.Batch(m.reloadConversations(), picker)
	case operatorv1.WatchKind_WATCH_KIND_OBJECTIVE:
		return tea.Batch(m.reloadObjectives(), shown(change.GetId()))
	case operatorv1.WatchKind_WATCH_KIND_SESSION:
		if _, known := m.work[change.GetId()]; known {
			return m.reloadWork(change.GetId())
		}
		return nil
	case operatorv1.WatchKind_WATCH_KIND_TASK:
		var work tea.Cmd
		if id := change.GetSessionId(); m.expanded[id] {
			work = m.reloadWork(id)
		}
		// A Task's end changes its Objective's spend and Sessions; other Tasks change neither.
		if change.GetObjectiveId() == "" {
			return work
		}
		return tea.Batch(work, m.reloadObjectives(), shown(change.GetObjectiveId()))
	case operatorv1.WatchKind_WATCH_KIND_INBOX_ITEM, operatorv1.WatchKind_WATCH_KIND_APPROVAL:
		return tea.Batch(m.reloadInbox(), shown(change.GetObjectiveId()))
	case operatorv1.WatchKind_WATCH_KIND_WORKSTREAM_POST:
		team := change.GetTeamId()
		if team == "" {
			return nil
		}
		if m.pane == paneObjective && team == m.shownTeam() {
			return m.reloadOverview()
		}
		if m.pane == paneTeam && team == m.teamID {
			return m.reloadTeam()
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
		conversations, err := m.client.ListConversations(m.ctx, "")
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
	c := m.conversation(msg.tag, msg.conversation)
	c.loading, c.loaded = false, true
	if msg.err != nil {
		m.addEntry(msg.tag, msg.conversation, entryError, "Could not load the conversation history: "+msg.err.Error())
		return nil
	}
	var cmds []tea.Cmd
	for _, item := range msg.items {
		c.add(entryYou, item.Message.GetText())
		for _, event := range item.Events {
			cmds = append(cmds, m.apply(msg.tag, msg.conversation, event))
		}
		if item.Follow {
			cmds = append(cmds, waitFor(msg.tag, msg.conversation, m.follower.Follow(m.ctx, msg.tag, item.Message, item.Shown)))
		}
	}
	if m.showsConversation(msg.tag, msg.conversation) {
		m.refresh()
	}
	return tea.Batch(cmds...)
}

func (m model) key(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	m.notice = note{}
	switch msg.String() {
	case "ctrl+c":
		return m, tea.Quit
	case "esc":
		if m.pane == paneObjective && m.objectiveCompose {
			m.saveDraft()
			m.refresh()
			return m, m.syncInput()
		}
		if m.decision == decisionConfirm || m.decision == decisionReason {
			m.decision = decisionNone
			m.input.Reset()
			m.syncInput()
			m.refresh()
			return m, nil
		}
		if m.back() {
			return m, m.syncInput()
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
	case "ctrl+o":
		return m, m.openPicker()
	}
	if msg.String() == "m" && m.pane == paneObjective && !m.objectiveCompose {
		return m, m.composeObjectiveMessage()
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
	switch m.pane {
	case paneConversation:
		if next, cmd, ok := m.selectionKey(msg); ok {
			return next, cmd
		}
	case paneConversations:
		if next, cmd, ok := m.pickerKey(msg); ok {
			return next, cmd
		}
	case paneNewObjective:
		if next, cmd, ok := m.formKey(msg); ok {
			return next, cmd
		}
	case paneDiff:
		if msg.String() == "o" {
			return m, m.openPullRequest(m.diff.pr)
		}
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
		if outcome, goal := goalOutcome(text); goal && tag != "" {
			m.input.Reset()
			return m.openObjectiveForm(outcome)
		}
		name := m.currentConversation(tag)
		if tag == "" || !m.conversation(tag, name).loaded {
			return nil
		}
		m.input.Reset()
		m.addEntry(tag, name, entryYou, text)
		return m.send(tag, name, text)
	case paneObjective:
		return m.sendObjectiveMessage(text)
	case paneConversations:
		return m.startConversation(text)
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

// syncInput focuses the input when the pane is focused and has an input line, or the new
// Objective form's field that takes the keys, and blurs the others.
func (m *model) syncInput() tea.Cmd {
	var cmd tea.Cmd
	if f := m.form; f != nil {
		for i := range f.fields {
			if m.pane == paneNewObjective && m.focus == focusInput && i == f.field && !f.sending && f.created == nil {
				cmd = f.fields[i].Focus()
			} else {
				f.fields[i].Blur()
			}
		}
	}
	if m.focus == focusInput && m.inputShown() {
		return m.input.Focus()
	}
	m.input.Blur()
	return cmd
}

// inputShown says whether the pane ends with the input line, rather than a hint.
func (m model) inputShown() bool {
	switch m.pane {
	case paneConversation:
		c := m.shown()
		return c != nil && c.selected == nil
	case paneObjective:
		return m.objectiveCompose
	case paneConversations:
		return m.picker != nil && m.picker.naming
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
	rowTeam
)

// row is one selectable rail row: index is into tags, objectives or inbox items.
type row struct {
	kind  rowKind
	index int
}

// rows are the rail's selectable rows, section by section.
func (m model) rows() []row {
	rows := make([]row, 0, len(m.tags)+len(m.objectives)+len(m.inbox.Items)+len(m.teams))
	for i := range m.tags {
		rows = append(rows, row{rowTag, i})
	}
	for i := range m.objectives {
		rows = append(rows, row{rowObjective, i})
	}
	for i := range m.inbox.Items {
		rows = append(rows, row{rowInbox, i})
	}
	for i := range m.teams {
		rows = append(rows, row{rowTeam, i})
	}
	return rows
}

func (m model) rowKey(r row) string {
	switch r.kind {
	case rowObjective:
		return objectivePaneKey(m.objectives[r.index].GetId())
	case rowInbox:
		return "inbox:" + m.inbox.Items[r.index].GetOccurrence()
	case rowTeam:
		return "team:" + m.teams[r.index].GetId()
	}
	return "tag:" + tagName(m.tags[r.index])
}

// paneKey names what the main pane shows, as rowKey names a row.
func (m model) paneKey() string {
	switch m.pane {
	case paneObjective:
		return objectivePaneKey(m.objectiveID)
	case paneInbox:
		return "inbox:" + m.item.GetOccurrence()
	case paneTeam:
		return "team:" + m.teamID
	}
	return "tag:" + m.selectedTag()
}

// draftKey names the unsent input of what the pane shows: each conversation keeps its own. The
// diff pane and the conversation list keep none.
func (m model) draftKey() string {
	switch m.pane {
	case paneConversation:
		tag := m.selectedTag()
		return "conversation:" + convKey(tag, m.currentConversation(tag))
	case paneDiff, paneConversations, paneNewObjective:
		return ""
	}
	return m.paneKey()
}

// saveDraft keeps the input for the pane's return, and empties it.
func (m *model) saveDraft() {
	if key := m.draftKey(); key != "" && (m.pane != paneObjective || m.objectiveCompose) {
		m.drafts[key] = m.input.Value()
	}
	m.objectiveCompose = false
	m.input.Reset()
}

// back leaves the diff pane, the conversation list or the new Objective form for the
// conversation, or clears the conversation's selection; false when there is nothing to go back from.
func (m *model) back() bool {
	switch m.pane {
	case paneConversation:
		if c := m.shown(); c != nil && c.selected != nil {
			c.selected = nil
			m.refresh()
			return true
		}
	case paneConversations:
		if m.picker != nil && m.picker.naming {
			m.picker.naming, m.picker.note = false, note{}
			m.input.Reset()
			m.refresh()
			return true
		}
		m.showConversation()
		return true
	case paneDiff:
		m.viewport.SoftWrap = false
		m.showConversation()
		return true
	case paneNewObjective:
		m.form = nil
		m.showConversation()
		return true
	}
	return false
}

// showConversation shows the selected Tag's current conversation in the main pane.
func (m *model) showConversation() {
	m.pane = paneConversation
	m.input.Placeholder = conversationPlaceholder
	m.input.SetValue(m.drafts[m.draftKey()])
	m.viewport.GotoBottom()
	m.refresh()
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

// followSettled moves the cursor and the inbox pane off an item that left the inbox: to the item
// that took its place, the one before it when it was last, or the row the cursor clamped to when
// the inbox is empty.
func (m *model) followSettled(index int) tea.Cmd {
	if n := len(m.inbox.Items); n > 0 {
		index = max(min(index, n-1), 0)
		for i, r := range m.rows() {
			if r.kind == rowInbox && r.index == index {
				m.cursor = i
				break
			}
		}
	}
	return m.choose()
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
	m.saveDraft()
	m.decision, m.itemNote, m.form = decisionNone, note{}, nil
	m.viewport.SoftWrap = false
	var cmd tea.Cmd
	switch r.kind {
	case rowTag:
		m.pane, m.selected = paneConversation, r.index
		m.input.Placeholder = conversationPlaceholder
	case rowObjective:
		m.pane, m.objectiveID = paneObjective, m.objectives[r.index].GetId()
		cmd = m.reloadOverview()
	case rowInbox:
		m.pane, m.item = paneInbox, m.inbox.Items[r.index]
		m.input.Placeholder = "Type your answer"
	case rowTeam:
		m.pane, m.teamID = paneTeam, m.teams[r.index].GetId()
		cmd = m.reloadTeam()
	}
	m.input.SetValue(m.drafts[m.draftKey()])
	focusCmd := m.syncInput()
	m.refresh()
	if m.pane == paneConversation {
		m.viewport.GotoBottom()
		return tea.Batch(focusCmd, m.selectTag())
	}
	m.viewport.GotoTop()
	return tea.Batch(focusCmd, cmd)
}

// apply adds one follow event to its conversation and
// rereads a work Session that reported or whose shown activity grew. Every field from the server
// or an agent is filtered for the terminal, as the CLI does.
func (m *model) apply(tag, name string, event client.FollowEvent) tea.Cmd {
	c := m.conversation(tag, name)
	dim := func(text string) { c.add(entryDim, text) }
	var cmd tea.Cmd
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
		if event.WorkSession != "" && m.expanded[event.WorkSession] {
			cmd = m.reloadWork(event.WorkSession)
		}
	case client.EventReply:
		c.draft = ""
		c.add(entryReply, event.Reply.GetText())
	case client.EventTurnError:
		c.draft = ""
		c.add(entryError, event.Text)
	case client.EventWorking:
		if event.WorkSession == "" {
			dim("· working: " + title)
		} else {
			c.addFor(entryWork, event.WorkSession, "· working: "+title)
		}
	case client.EventReport:
		dim("· " + event.Status + ": " + title)
		c.addFor(entryReport, event.WorkSession, event.Text)
		if event.WorkSession != "" {
			cmd = m.reloadWork(event.WorkSession)
		}
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
	if m.showsConversation(tag, name) {
		m.refresh()
	}
	return cmd
}

func (m *model) addEntry(tag, name string, kind entryKind, text string) {
	m.conversation(tag, name).add(kind, text)
	if m.showsConversation(tag, name) {
		m.refresh()
	}
}

// showsConversation says whether the main pane shows tag's conversation name.
func (m model) showsConversation(tag, name string) bool {
	return m.pane == paneConversation && tag == m.selectedTag() && name == m.currentConversation(tag)
}
