package main

import (
	"slices"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/apps/tui/views"
)

// The cache's entries for one Gateway and principal.
const (
	rosterKey   = "roster"
	selectedKey = "selected"
	outboxKey   = "outbox"
	draftsKey   = "drafts"
)

// conversationKey names the entry of the conversation with tag.
func conversationKey(tag string) string { return "tag:" + tag }

// cacheDelay is how long a change waits before it is written, so a burst of changes, such as a
// streaming reply, writes once.
const cacheDelay = 500 * time.Millisecond

// modelCache is what a model keeps on disk, for the Gateway it talks to and the principal its
// credential acts as. A model's copies share it.
type modelCache struct {
	disk  *localCache
	token string
	// principal is whom the credential acts as: remembered from an earlier launch, then confirmed
	// with the Gateway. Nothing is written until it is known.
	principal string
	// confirmed says the principal is known, from the Gateway or an earlier launch.
	confirmed bool
	// dirty are the entries changed since they were last written; flushing says a write waits.
	dirty    map[string]bool
	flushing bool
}

type (
	// cacheFlushMsg writes the changed entries.
	cacheFlushMsg struct{}
	// principalMsg is whom the Gateway resolved the credential to.
	principalMsg struct {
		principal string
		err       error
	}
)

type cachedEntry struct {
	Kind    entryKind `json:"k"`
	Text    string    `json:"t"`
	Session string    `json:"s,omitempty"`
	// Rendered is the entry as the conversation last showed it, at the conversation's width;
	// a launch at that width shows it without rendering its markdown again.
	Rendered *string `json:"r,omitempty"`
}

type cachedTurn struct {
	ID            string        `json:"id"`
	Order         uint64        `json:"order"`
	Settled       bool          `json:"settled,omitempty"`
	Joined        bool          `json:"joined,omitempty"`
	Started       bool          `json:"started,omitempty"`
	After         uint64        `json:"after,omitempty"`
	SentAtMs      int64         `json:"sentAtMs,omitempty"`
	CompletedAtMs int64         `json:"completedAtMs,omitempty"`
	Status        string        `json:"status,omitempty"`
	Hidden        bool          `json:"hidden,omitempty"`
	Entries       []cachedEntry `json:"entries"`
}

// cachedConversation is a conversation's latest turns, oldest first.
type cachedConversation struct {
	ConversationID string       `json:"conversationId"`
	Turns          []cachedTurn `json:"turns"`
	// Width is the width the entries were rendered at.
	Width int `json:"width,omitempty"`
	// WorkShown are the work Session lines the turns already show, so a later read of a turn
	// does not show them again.
	WorkShown []string `json:"workShown,omitempty"`
}

// maxWorkShown bounds the work Session lines a conversation's entry remembers.
const maxWorkShown = 2048

type cachedTag struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Lead    bool   `json:"lead,omitempty"`
	Retired bool   `json:"retired,omitempty"`
}

// cachedRoster is the Tag list with each conversation's row.
type cachedRoster struct {
	Tags          []cachedTag           `json:"tags"`
	Conversations []*views.Conversation `json:"conversations"`
}

func newModelCache(disk *localCache, token string) *modelCache {
	cache := &modelCache{disk: disk, token: token, dirty: map[string]bool{}}
	if disk != nil {
		// A principal the Gateway named for this credential before is trusted until it
		// says otherwise, so what changes while it cannot be reached, such as a message waiting
		// in the outbox, is kept.
		cache.principal = disk.principal(token)
		cache.confirmed = cache.principal != ""
	}
	return cache
}

// cacheChanged marks an entry to be written; the next update schedules the write.
func (m *model) cacheChanged(key string) {
	if m.cache != nil && m.cache.disk != nil {
		m.cache.dirty[key] = true
	}
}

// scheduleFlush is the command that writes the changed entries after cacheDelay, when one is not
// already waiting.
func (m *model) scheduleFlush() tea.Cmd {
	c := m.cache
	if c == nil || c.disk == nil || c.flushing || len(c.dirty) == 0 || !c.confirmed {
		return nil
	}
	c.flushing = true
	return tea.Tick(cacheDelay, func(time.Time) tea.Msg { return cacheFlushMsg{} })
}

// flush writes the changed entries: it takes their values now and writes them off the program's
// goroutine. wait writes them before returning, as the program ends.
func (m *model) flush(wait bool) tea.Cmd {
	c := m.cache
	if c == nil || c.disk == nil {
		return nil
	}
	c.flushing = false
	if !c.confirmed || len(c.dirty) == 0 {
		return nil
	}
	values := map[string]any{}
	for key := range c.dirty {
		values[key] = m.cacheValue(key)
	}
	c.dirty = map[string]bool{}
	disk, principal := c.disk, c.principal
	write := func() tea.Msg {
		for key, value := range values {
			_ = disk.write(principal, key, value)
		}
		return nil
	}
	if wait {
		write()
		return nil
	}
	return write
}

// cacheValue is what the entry under key holds now.
func (m *model) cacheValue(key string) any {
	switch key {
	case rosterKey:
		roster := cachedRoster{}
		for _, tag := range m.tags {
			roster.Tags = append(roster.Tags, cachedTag{ID: tag.GetMetadata().GetId(), Name: tagName(tag), Lead: tag.GetSpec().GetLead(),
				Retired: tag.GetStatus().GetPhase() == views.TagPhase_TAG_PHASE_RETIRED})
		}
		for _, summary := range m.summaries {
			roster.Conversations = append(roster.Conversations, summary)
		}
		return roster
	case selectedKey:
		return m.selectedTag()
	case outboxKey:
		// Copies: the write runs off the program's goroutine, which changes the entries.
		queued := make([]outgoing, 0, len(m.outbox.entries))
		for _, entry := range m.outbox.entries {
			queued = append(queued, *entry)
		}
		return queued
	case draftsKey:
		drafts := map[string]string{}
		for key, text := range m.drafts {
			if tag, ok := strings.CutPrefix(key, "conversation:"); ok && text != "" {
				drafts[tag] = text
			}
		}
		if m.pane == paneConversation && m.selectedTag() != "" && m.input.Value() != "" {
			drafts[m.selectedTag()] = m.input.Value()
		}
		return drafts
	}
	tag, _ := strings.CutPrefix(key, "tag:")
	return m.conversationSnapshot(tag)
}

// renderedBudget bounds the renderings a conversation's entry keeps, newest first: a rendering
// is several times its text, and a launch renders the rest again.
const renderedBudget = 1 << 20

// conversationSnapshot is the conversation's latest cacheTurns turns as they show now, with the
// renderings of the newest entries.
func (m *model) conversationSnapshot(tag string) cachedConversation {
	h := &m.conversation(tag).runtime
	snapshot := cachedConversation{ConversationID: h.conversationID, Width: m.paneWidth()}
	if !h.read {
		return snapshot
	}
	var turns []*runtimeTurn
	for _, id := range h.order[max(len(h.order)-cacheTurns, 0):] {
		turn := h.turns[id]
		if turn == nil || turn.order == 0 {
			continue
		}
		cached := cachedTurn{ID: id, Order: turn.order, Settled: turn.settled && !turn.needsFollow, Joined: turn.joined,
			Started: turn.started, After: turn.after, Status: turn.status,
			SentAtMs: unixMilli(turn.sentAt), CompletedAtMs: unixMilli(turn.completedAt), Hidden: turn.hidden}
		for _, entry := range turn.entries {
			cached.Entries = append(cached.Entries, cachedEntry{Kind: entry.kind, Text: entry.text, Session: entry.session})
		}
		snapshot.Turns = append(snapshot.Turns, cached)
		turns = append(turns, turn)
	}
	for key := range h.workShown {
		snapshot.WorkShown = append(snapshot.WorkShown, key)
	}
	slices.Sort(snapshot.WorkShown)
	snapshot.WorkShown = snapshot.WorkShown[:min(len(snapshot.WorkShown), maxWorkShown)]
	budget := renderedBudget
	for i := len(turns) - 1; i >= 0 && budget > 0; i-- {
		turn := turns[i]
		if turn.cacheWidth != snapshot.Width || len(turn.cache) < len(turn.entries) {
			break
		}
		for j := range turn.entries {
			budget -= len(turn.cache[j])
			snapshot.Turns[i].Entries[j].Rendered = &turn.cache[j]
		}
	}
	return snapshot
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func unixMilli(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

func fromMilli(ms int64) time.Time {
	if ms == 0 {
		return time.Time{}
	}
	return time.UnixMilli(ms)
}

// hydrate shows what the cache holds for the remembered principal: the Tag list and rows, the
// selected Tag and its conversation, messages not yet sent, and drafts. The Gateway's
// answers then replace it.
func (m *model) hydrate() {
	c := m.cache
	if c == nil || c.principal == "" {
		return
	}
	var roster cachedRoster
	if c.disk.read(c.principal, rosterKey, &roster) {
		for _, tag := range roster.Tags {
			if tag.ID == "" {
				continue
			}
			phase := views.TagPhase_TAG_PHASE_ACTIVE
			if tag.Retired {
				phase = views.TagPhase_TAG_PHASE_RETIRED
			}
			m.tags = append(m.tags, &views.Tag{Metadata: &views.Metadata{Id: tag.ID, Name: tag.Name},
				Spec: &views.TagSpec{Lead: tag.Lead}, Status: &views.TagStatus{Phase: phase}})
		}
		for _, summary := range roster.Conversations {
			if summary != nil && summary.GetTag() != "" {
				m.summaries[summary.GetTag()] = summary
			}
		}
		m.tagsChecked = len(m.tags) > 0
	}
	var selected string
	if c.disk.read(c.principal, selectedKey, &selected) {
		for i, tag := range m.tags {
			if m.tagReference(tag) == selected {
				m.selected = i
			}
		}
	}
	var queued []*outgoing
	if c.disk.read(c.principal, outboxKey, &queued) {
		for _, entry := range queued {
			if entry != nil && entry.Tag != "" && entry.Text != "" && entry.OperationID != "" {
				m.outbox.entries = append(m.outbox.entries, entry)
			}
		}
	}
	var drafts map[string]string
	if c.disk.read(c.principal, draftsKey, &drafts) {
		for tag, text := range drafts {
			m.drafts["conversation:"+tag] = text
		}
	}
	m.sortTags()
	if tag := m.selectedTag(); tag != "" {
		m.cachedConversation(tag)
		m.input.SetValue(m.drafts["conversation:"+tag])
	}
	m.placeCursor()
	// The conversation takes keys at once; Init starts the cursor's blink.
	m.syncInput()
}

// cachedConversation shows the cached copy of the conversation with tag when nothing of it is
// shown yet.
func (m *model) cachedConversation(tag string) {
	c := m.cache
	conv := m.conversation(tag)
	if c == nil || c.principal == "" || conv.loaded {
		return
	}
	var cached cachedConversation
	if !c.disk.read(c.principal, conversationKey(tag), &cached) || cached.ConversationID == "" {
		return
	}
	h := &conv.runtime
	h.turns = map[string]*runtimeTurn{}
	for _, turn := range cached.Turns {
		if turn.ID == "" || turn.Order == 0 || h.turns[turn.ID] != nil {
			continue
		}
		restored := &runtimeTurn{settled: turn.Settled, needsFollow: !turn.Settled, joined: turn.Joined, started: turn.Started,
			after: turn.After, order: turn.Order, sentAt: fromMilli(turn.SentAtMs), completedAt: fromMilli(turn.CompletedAtMs)}
		restored.status, restored.hidden = turn.Status, turn.Hidden
		rendered := cached.Width > 0
		for _, held := range turn.Entries {
			restored.entries = append(restored.entries, entry{kind: held.Kind, text: held.Text, session: held.Session})
			// Each entry renders once per width: keep the renderings up to the first missing one.
			if rendered = rendered && (held.Rendered != nil || held.Kind == entryWork); rendered {
				restored.cache = append(restored.cache, deref(held.Rendered))
			}
		}
		restored.cacheWidth = cached.Width
		h.turns[turn.ID] = restored
		h.order = append(h.order, turn.ID)
	}
	h.sortOrder()
	h.workShown = map[string]bool{}
	for _, key := range cached.WorkShown {
		h.workShown[key] = true
	}
	h.conversationID, h.read = cached.ConversationID, true
	conv.loaded = true
}

// whoAmI asks the Gateway whom the credential acts as, to name the cache's entries.
func (m model) whoAmI() tea.Cmd {
	if m.cache == nil || m.cache.disk == nil {
		return nil
	}
	c, ctx := m.client, m.ctx
	return func() tea.Msg {
		caller, err := c.WhoAmI(ctx)
		return principalMsg{principal: caller.Principal, err: err}
	}
}

// confirmPrincipal starts writing the cache once the Gateway says whom the credential acts
// as. When that is not whom an earlier launch remembered, what was shown from that principal's
// cache is dropped and read anew.
func (m *model) confirmPrincipal(msg principalMsg) tea.Cmd {
	c := m.cache
	if c == nil || msg.err != nil || msg.principal == "" {
		return nil
	}
	var cmd tea.Cmd
	if c.principal != "" && c.principal != msg.principal {
		for _, conv := range m.conversations {
			conv.runtime.reset()
		}
		m.conversations = map[string]*conversation{}
		m.outbox.entries, m.drafts = nil, map[string]string{}
		m.input.Reset()
		m.refresh()
		cmd = m.reloadAll()
	}
	if c.principal != msg.principal {
		c.disk.rememberPrincipal(c.token, msg.principal)
	}
	c.principal, c.confirmed = msg.principal, true
	return cmd
}

// cacheOrigin names a Gateway in the cache: its URL without a trailing slash.
func cacheOrigin(target client.Target) string {
	return strings.TrimRight(strings.TrimSpace(target.URL), "/")
}
